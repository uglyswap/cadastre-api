/**
 * Service de configuration automatique de la BAN
 * Gère l'installation de PostGIS, la création des tables et l'import des données
 */

import { pool } from './database.js';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { EventEmitter } from 'events';

// Configuration
const BAN_URL = 'https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-france.csv.gz';
const BATCH_SIZE = 5000;
const DATA_DIR = '/tmp/ban-data';
const CSV_FILE = path.join(DATA_DIR, 'adresses-france.csv');
const GZ_FILE = path.join(DATA_DIR, 'adresses-france.csv.gz');

// État global de l'import
export interface ImportState {
  status: 'idle' | 'downloading' | 'decompressing' | 'importing' | 'completed' | 'error';
  progress: number;
  totalLines: number;
  importedLines: number;
  errorCount: number;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  downloadProgress: number;
}

let importState: ImportState = {
  status: 'idle',
  progress: 0,
  totalLines: 0,
  importedLines: 0,
  errorCount: 0,
  startedAt: null,
  completedAt: null,
  error: null,
  downloadProgress: 0,
};

export const importEmitter = new EventEmitter();

/**
 * Vérifie si PostGIS est installé
 */
export async function checkPostGIS(): Promise<{ installed: boolean; version?: string }> {
  try {
    const result = await pool.query('SELECT PostGIS_Version() as version');
    return { installed: true, version: result.rows[0].version };
  } catch {
    return { installed: false };
  }
}

/**
 * Vérifie si pg_trgm est installé
 */
export async function checkPgTrgm(): Promise<boolean> {
  try {
    await pool.query("SELECT 'test' % 'test'");
    return true;
  } catch {
    return false;
  }
}

/**
 * Vérifie si la table BAN existe
 */
export async function checkBanTable(): Promise<{ exists: boolean; count: number }> {
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM ban_adresses');
    return { exists: true, count: parseInt(result.rows[0].count) };
  } catch {
    return { exists: false, count: 0 };
  }
}

/**
 * Installe PostGIS et pg_trgm
 */
export async function installExtensions(): Promise<{ success: boolean; message: string }> {
  const results: string[] = [];
  
  try {
    // PostGIS
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS postgis');
      results.push('PostGIS installé');
    } catch (e: any) {
      if (e.message.includes('permission denied')) {
        return { success: false, message: 'Permission refusée pour installer PostGIS. Contactez l\'admin DB.' };
      }
      throw e;
    }

    // pg_trgm pour la recherche fuzzy
    try {
      await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      results.push('pg_trgm installé');
    } catch {
      results.push('pg_trgm non disponible (optionnel)');
    }

    return { success: true, message: results.join(', ') };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

/**
 * Crée la table BAN et les index
 */
export async function createBanTable(): Promise<{ success: boolean; message: string }> {
  try {
    // Créer la table
    await pool.query(`
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
      )
    `);

    // Fonction de normalisation
    await pool.query(`
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
      $$ LANGUAGE plpgsql IMMUTABLE
    `);

    // Fonction de formatage numéro
    await pool.query(`
      CREATE OR REPLACE FUNCTION format_numero(num TEXT)
      RETURNS TEXT AS $$
      BEGIN
        IF num IS NULL OR num = '' THEN RETURN NULL; END IF;
        RETURN LPAD(REGEXP_REPLACE(num, '[^0-9]', '', 'g'), 4, '0');
      END;
      $$ LANGUAGE plpgsql IMMUTABLE
    `);

    // Trigger
    await pool.query(`
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
      $$ LANGUAGE plpgsql
    `);

    await pool.query('DROP TRIGGER IF EXISTS trg_ban_normalize ON ban_adresses');
    await pool.query(`
      CREATE TRIGGER trg_ban_normalize
        BEFORE INSERT OR UPDATE ON ban_adresses
        FOR EACH ROW
        EXECUTE FUNCTION update_ban_normalized()
    `);

    // Table de stats
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ban_import_stats (
        id SERIAL PRIMARY KEY,
        import_date TIMESTAMP DEFAULT NOW(),
        total_records BIGINT,
        success_count BIGINT,
        error_count BIGINT,
        duration_seconds INTEGER,
        status TEXT DEFAULT 'completed'
      )
    `);

    return { success: true, message: 'Table BAN créée avec succès' };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

/**
 * Crée les index spatiaux (après import)
 */
export async function createIndexes(): Promise<{ success: boolean; message: string }> {
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ban_geom ON ban_adresses USING GIST(geom)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ban_code_postal ON ban_adresses(code_postal)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ban_code_commune ON ban_adresses(code_commune)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_ban_numero ON ban_adresses(numero_formatted)');
    
    // Index trigram si disponible
    try {
      await pool.query('CREATE INDEX IF NOT EXISTS idx_ban_nom_voie_trgm ON ban_adresses USING GIN(nom_voie_normalized gin_trgm_ops)');
    } catch {
      // pg_trgm non disponible
    }

    return { success: true, message: 'Index créés avec succès' };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

/**
 * Retourne l'état actuel de l'import
 */
export function getImportState(): ImportState {
  return { ...importState };
}

/**
 * Télécharge le fichier BAN
 */
async function downloadBAN(): Promise<void> {
  importState.status = 'downloading';
  importState.downloadProgress = 0;
  importEmitter.emit('progress', importState);

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Vérifier si déjà téléchargé
  if (fs.existsSync(CSV_FILE)) {
    const stats = fs.statSync(CSV_FILE);
    if (stats.size > 1000000000) { // > 1 Go
      console.log('[BAN] Fichier déjà téléchargé, skip...');
      return;
    }
  }

  console.log('[BAN] Téléchargement depuis', BAN_URL);
  
  const response = await fetch(BAN_URL);
  if (!response.ok) {
    throw new Error(`Erreur téléchargement: ${response.status}`);
  }

  const totalSize = parseInt(response.headers.get('content-length') || '0');
  const fileStream = fs.createWriteStream(GZ_FILE);
  const reader = response.body?.getReader();

  if (!reader) throw new Error('Impossible de lire le stream');

  let downloaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(value);
    downloaded += value.length;
    importState.downloadProgress = Math.round((downloaded / totalSize) * 100);
    
    if (downloaded % 10000000 < value.length) { // Log tous les 10 Mo
      console.log(`[BAN] Téléchargement: ${importState.downloadProgress}%`);
      importEmitter.emit('progress', importState);
    }
  }

  fileStream.close();
  console.log('[BAN] Téléchargement terminé');
}

/**
 * Décompresse le fichier BAN
 */
async function decompressBAN(): Promise<void> {
  importState.status = 'decompressing';
  importEmitter.emit('progress', importState);

  if (fs.existsSync(CSV_FILE)) {
    const stats = fs.statSync(CSV_FILE);
    if (stats.size > 1000000000) {
      console.log('[BAN] Fichier déjà décompressé, skip...');
      return;
    }
  }

  console.log('[BAN] Décompression...');
  
  const gzStream = fs.createReadStream(GZ_FILE);
  const gunzip = createGunzip();
  const outStream = fs.createWriteStream(CSV_FILE);

  await pipeline(gzStream, gunzip, outStream);
  
  console.log('[BAN] Décompression terminée');
}

interface BanRecord {
  id: string;
  numero: string;
  rep: string;
  nom_voie: string;
  code_postal: string;
  code_commune: string;
  nom_commune: string;
  lon: number | null;
  lat: number | null;
}

function parseCSVLine(line: string, headers: string[]): BanRecord | null {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ';' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());

  if (values.length < headers.length) return null;

  const record: any = {};
  headers.forEach((h, i) => {
    record[h] = values[i] || '';
  });

  const lon = parseFloat(record.lon || record.longitude || record.x);
  const lat = parseFloat(record.lat || record.latitude || record.y);

  return {
    id: (record.id || `${record.code_commune}-${record.numero}-${record.nom_voie}`).substring(0, 100),
    numero: record.numero || '',
    rep: record.rep || record.repetition || '',
    nom_voie: record.nom_voie || '',
    code_postal: record.code_postal || '',
    code_commune: record.code_commune || record.commune_insee || '',
    nom_commune: record.nom_commune || record.commune_nom || '',
    lon: isNaN(lon) ? null : lon,
    lat: isNaN(lat) ? null : lat,
  };
}

async function insertBatch(records: BanRecord[]): Promise<number> {
  if (records.length === 0) return 0;

  const values: any[] = [];
  const placeholders: string[] = [];
  let paramIndex = 1;

  for (const r of records) {
    if (!r.lon || !r.lat) continue;

    placeholders.push(
      `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8})`
    );
    values.push(
      r.id,
      r.numero,
      r.rep,
      r.nom_voie,
      r.code_postal,
      r.code_commune,
      r.nom_commune,
      r.lon,
      r.lat
    );
    paramIndex += 9;
  }

  if (placeholders.length === 0) return 0;

  const query = `
    INSERT INTO ban_adresses (id, numero, rep, nom_voie, code_postal, code_commune, nom_commune, lon, lat)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (id) DO UPDATE SET
      numero = EXCLUDED.numero,
      rep = EXCLUDED.rep,
      nom_voie = EXCLUDED.nom_voie,
      code_postal = EXCLUDED.code_postal,
      code_commune = EXCLUDED.code_commune,
      nom_commune = EXCLUDED.nom_commune,
      lon = EXCLUDED.lon,
      lat = EXCLUDED.lat,
      updated_at = NOW()
  `;

  try {
    await pool.query(query, values);
    return placeholders.length;
  } catch (error) {
    console.error('[BAN] Erreur batch:', error);
    return 0;
  }
}

/**
 * Importe le fichier CSV dans la base
 */
async function importCSV(): Promise<void> {
  importState.status = 'importing';
  importState.totalLines = 0;
  importState.importedLines = 0;
  importState.errorCount = 0;
  importEmitter.emit('progress', importState);

  console.log('[BAN] Début import CSV...');

  let headers: string[] = [];
  let batch: BanRecord[] = [];
  let lineCount = 0;

  const fileStream = fs.createReadStream(CSV_FILE, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineCount++;

    if (lineCount === 1) {
      headers = line.split(';').map(h => h.replace(/"/g, '').trim().toLowerCase());
      console.log('[BAN] Headers:', headers.join(', '));
      continue;
    }

    const record = parseCSVLine(line, headers);
    if (record) {
      batch.push(record);
    } else {
      importState.errorCount++;
    }

    if (batch.length >= BATCH_SIZE) {
      const inserted = await insertBatch(batch);
      importState.importedLines += inserted;
      importState.totalLines = lineCount - 1;
      importState.progress = Math.min(99, Math.round((lineCount / 26000000) * 100));
      batch = [];

      if (lineCount % 100000 < BATCH_SIZE) {
        console.log(`[BAN] Progression: ${lineCount.toLocaleString()} lignes, ${importState.importedLines.toLocaleString()} importées`);
        importEmitter.emit('progress', importState);
      }
    }
  }

  // Dernier batch
  if (batch.length > 0) {
    const inserted = await insertBatch(batch);
    importState.importedLines += inserted;
  }

  importState.totalLines = lineCount - 1;
  console.log(`[BAN] Import terminé: ${importState.importedLines.toLocaleString()} adresses`);
}

/**
 * Lance le processus complet d'import en arrière-plan
 */
export async function startBanImport(): Promise<{ success: boolean; message: string }> {
  if (importState.status !== 'idle' && importState.status !== 'completed' && importState.status !== 'error') {
    return { success: false, message: `Import déjà en cours (${importState.status})` };
  }

  // Vérifier les prérequis
  const postgis = await checkPostGIS();
  if (!postgis.installed) {
    return { success: false, message: 'PostGIS non installé. Appelez /admin/ban/setup d\'abord.' };
  }

  const banTable = await checkBanTable();
  if (!banTable.exists) {
    return { success: false, message: 'Table BAN non créée. Appelez /admin/ban/setup d\'abord.' };
  }

  // Reset state
  importState = {
    status: 'idle',
    progress: 0,
    totalLines: 0,
    importedLines: 0,
    errorCount: 0,
    startedAt: new Date(),
    completedAt: null,
    error: null,
    downloadProgress: 0,
  };

  // Lancer en arrière-plan
  (async () => {
    try {
      await downloadBAN();
      await decompressBAN();
      await importCSV();
      await createIndexes();

      importState.status = 'completed';
      importState.progress = 100;
      importState.completedAt = new Date();

      // Sauvegarder les stats
      const duration = Math.round((Date.now() - importState.startedAt!.getTime()) / 1000);
      await pool.query(
        `INSERT INTO ban_import_stats (total_records, success_count, error_count, duration_seconds, status)
         VALUES ($1, $2, $3, $4, 'completed')`,
        [importState.totalLines, importState.importedLines, importState.errorCount, duration]
      );

      console.log('[BAN] ✅ Import complet!');
      importEmitter.emit('complete', importState);
    } catch (error: any) {
      importState.status = 'error';
      importState.error = error.message;
      console.error('[BAN] ❌ Erreur:', error);
      importEmitter.emit('error', error);
    }
  })();

  return { success: true, message: 'Import démarré en arrière-plan. Suivez la progression via /admin/ban/status' };
}

/**
 * Setup complet: extensions + table
 */
export async function fullSetup(): Promise<{ success: boolean; steps: string[]; error?: string }> {
  const steps: string[] = [];

  try {
    // 1. Extensions
    const extResult = await installExtensions();
    steps.push(`Extensions: ${extResult.message}`);
    if (!extResult.success) {
      return { success: false, steps, error: extResult.message };
    }

    // 2. Table BAN
    const tableResult = await createBanTable();
    steps.push(`Table: ${tableResult.message}`);
    if (!tableResult.success) {
      return { success: false, steps, error: tableResult.message };
    }

    // Vérifier
    const postgis = await checkPostGIS();
    const banTable = await checkBanTable();
    
    steps.push(`PostGIS: ${postgis.version || 'non installé'}`);
    steps.push(`Table BAN: ${banTable.count} adresses`);

    return { success: true, steps };
  } catch (error: any) {
    return { success: false, steps, error: error.message };
  }
}
