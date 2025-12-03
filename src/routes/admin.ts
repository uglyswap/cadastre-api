/**
 * Routes d'administration pour la configuration PostGIS et l'import BAN
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../services/database.js';
import { authHook } from '../middleware/auth.js';
import { importBanData, getImportProgress, isImportRunning } from '../services/ban-import.js';

// Script SQL de setup PostGIS
const SETUP_SQL = `
-- Activer les extensions
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Créer la table BAN
CREATE TABLE IF NOT EXISTS ban_adresses (
  id TEXT PRIMARY KEY,
  numero TEXT,
  rep TEXT,
  nom_voie TEXT,
  code_postal TEXT,
  code_commune TEXT,
  nom_commune TEXT,
  lon DOUBLE PRECISION,
  lat DOUBLE PRECISION,
  geom GEOMETRY(Point, 4326),
  nom_voie_normalized TEXT,
  numero_formatted TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Index spatial
CREATE INDEX IF NOT EXISTS idx_ban_geom ON ban_adresses USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_ban_code_postal ON ban_adresses(code_postal);
CREATE INDEX IF NOT EXISTS idx_ban_code_commune ON ban_adresses(code_commune);
CREATE INDEX IF NOT EXISTS idx_ban_numero ON ban_adresses(numero_formatted);

-- Fonction de normalisation
CREATE OR REPLACE FUNCTION normalize_voie(voie TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN UPPER(
    TRANSLATE(
      REGEXP_REPLACE(
        REGEXP_REPLACE(voie, '^(RUE|AVENUE|BOULEVARD|IMPASSE|PLACE|ALLEE|CHEMIN|ROUTE|PASSAGE|SQUARE|COURS|QUAI|VOIE|CITE|RESIDENCE|LOTISSEMENT)\\s+', '', 'i'),
        '\\s+', ' ', 'g'
      ),
      'àâäéèêëïîôùûüçÀÂÄÉÈÊËÏÎÔÙÛÜÇ',
      'aaaeeeeiioouucAAAEEEEIIOOUUC'
    )
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Fonction de formatage numéro
CREATE OR REPLACE FUNCTION format_numero(num TEXT)
RETURNS TEXT AS $$
BEGIN
  IF num IS NULL OR num = '' THEN
    RETURN NULL;
  END IF;
  RETURN LPAD(REGEXP_REPLACE(num, '[^0-9]', '', 'g'), 4, '0');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Trigger de normalisation
CREATE OR REPLACE FUNCTION update_ban_normalized()
RETURNS TRIGGER AS $$
BEGIN
  NEW.nom_voie_normalized := normalize_voie(NEW.nom_voie);
  NEW.numero_formatted := format_numero(NEW.numero);
  NEW.updated_at := NOW();
  IF NEW.lon IS NOT NULL AND NEW.lat IS NOT NULL THEN
    NEW.geom := ST_SetSRID(ST_MakePoint(NEW.lon, NEW.lat), 4326);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ban_normalize ON ban_adresses;
CREATE TRIGGER trg_ban_normalize
  BEFORE INSERT OR UPDATE ON ban_adresses
  FOR EACH ROW
  EXECUTE FUNCTION update_ban_normalized();

-- Table de stats d'import
CREATE TABLE IF NOT EXISTS ban_import_stats (
  id SERIAL PRIMARY KEY,
  import_date TIMESTAMP DEFAULT NOW(),
  total_records BIGINT,
  success_count BIGINT,
  error_count BIGINT,
  duration_seconds INTEGER,
  status TEXT DEFAULT 'running'
);

-- Table de progression
CREATE TABLE IF NOT EXISTS ban_import_progress (
  id INTEGER PRIMARY KEY DEFAULT 1,
  status TEXT DEFAULT 'idle',
  current_step TEXT,
  total_lines BIGINT DEFAULT 0,
  processed_lines BIGINT DEFAULT 0,
  inserted_count BIGINT DEFAULT 0,
  error_count BIGINT DEFAULT 0,
  started_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

INSERT INTO ban_import_progress (id, status) VALUES (1, 'idle')
ON CONFLICT (id) DO NOTHING;
`;

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {
  
  // POST /admin/setup - Installer PostGIS et créer les tables
  fastify.post(
    '/admin/setup',
    { ...authHook },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      console.log('[admin] Exécution du setup PostGIS...');
      
      try {
        // Exécuter le script SQL
        await pool.query(SETUP_SQL);
        
        // Vérifier que PostGIS est bien installé
        const pgVersion = await pool.query('SELECT PostGIS_Version() as version');
        const banCount = await pool.query('SELECT COUNT(*) as count FROM ban_adresses');
        
        console.log('[admin] Setup terminé avec succès');
        
        return reply.send({
          success: true,
          message: 'PostGIS installé et tables créées avec succès',
          details: {
            postgis_version: pgVersion.rows[0]?.version,
            ban_table_created: true,
            ban_records: parseInt(banCount.rows[0]?.count) || 0,
          },
        });
      } catch (error: any) {
        console.error('[admin] Erreur setup:', error);
        return reply.code(500).send({
          success: false,
          error: 'Erreur lors du setup',
          details: error.message,
        });
      }
    }
  );

  // POST /admin/ban/import - Lancer l'import de la BAN
  fastify.post(
    '/admin/ban/import',
    { ...authHook },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      console.log('[admin] Démarrage import BAN...');
      
      // Vérifier si un import est déjà en cours
      if (isImportRunning()) {
        return reply.code(409).send({
          success: false,
          error: 'Un import est déjà en cours',
          code: 'IMPORT_ALREADY_RUNNING',
        });
      }
      
      // Vérifier que PostGIS est installé
      try {
        await pool.query('SELECT PostGIS_Version()');
      } catch {
        return reply.code(400).send({
          success: false,
          error: 'PostGIS non installé. Exécutez POST /admin/setup d\'abord',
          code: 'POSTGIS_NOT_INSTALLED',
        });
      }
      
      // Lancer l'import en arrière-plan
      importBanData().catch(err => {
        console.error('[admin] Erreur import BAN:', err);
      });
      
      return reply.send({
        success: true,
        message: 'Import BAN démarré en arrière-plan',
        details: {
          check_progress: 'GET /admin/ban/progress',
          estimated_duration: '30-60 minutes',
        },
      });
    }
  );

  // GET /admin/ban/progress - Progression de l'import
  fastify.get(
    '/admin/ban/progress',
    { ...authHook },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const progress = await getImportProgress();
        
        return reply.send({
          success: true,
          progress,
        });
      } catch (error: any) {
        return reply.code(500).send({
          success: false,
          error: 'Erreur lors de la récupération de la progression',
          details: error.message,
        });
      }
    }
  );

  // DELETE /admin/ban/reset - Réinitialiser la table BAN (vider)
  fastify.delete(
    '/admin/ban/reset',
    { ...authHook },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      if (isImportRunning()) {
        return reply.code(409).send({
          success: false,
          error: 'Impossible de reset pendant un import',
        });
      }
      
      try {
        await pool.query('TRUNCATE TABLE ban_adresses');
        await pool.query('UPDATE ban_import_progress SET status = $1, processed_lines = 0, inserted_count = 0', ['idle']);
        
        return reply.send({
          success: true,
          message: 'Table BAN vidée avec succès',
        });
      } catch (error: any) {
        return reply.code(500).send({
          success: false,
          error: 'Erreur lors du reset',
          details: error.message,
        });
      }
    }
  );
}
