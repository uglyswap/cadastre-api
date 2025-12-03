-- ============================================
-- Script d'initialisation PostGIS + Table BAN
-- Pour la recherche géographique cadastrale
-- ============================================

-- 1. Activer l'extension PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm; -- Pour la recherche fuzzy

-- 2. Créer la table BAN (Base Adresse Nationale)
CREATE TABLE IF NOT EXISTS ban_adresses (
  id TEXT PRIMARY KEY,
  numero TEXT,
  rep TEXT,  -- Indice de répétition (bis, ter...)
  nom_voie TEXT,
  code_postal TEXT,
  code_commune TEXT,
  nom_commune TEXT,
  lon DOUBLE PRECISION,
  lat DOUBLE PRECISION,
  geom GEOMETRY(Point, 4326),
  -- Colonnes pour le matching optimisé
  nom_voie_normalized TEXT,
  numero_formatted TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- 3. Créer les index pour la performance
-- Index spatial (le plus important)
CREATE INDEX IF NOT EXISTS idx_ban_geom ON ban_adresses USING GIST(geom);

-- Index pour le matching d'adresses
CREATE INDEX IF NOT EXISTS idx_ban_code_postal ON ban_adresses(code_postal);
CREATE INDEX IF NOT EXISTS idx_ban_code_commune ON ban_adresses(code_commune);
CREATE INDEX IF NOT EXISTS idx_ban_nom_voie_trgm ON ban_adresses USING GIN(nom_voie_normalized gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_ban_numero ON ban_adresses(numero_formatted);

-- 4. Fonction de normalisation des noms de voie
CREATE OR REPLACE FUNCTION normalize_voie(voie TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN UPPER(
    TRANSLATE(
      REGEXP_REPLACE(
        REGEXP_REPLACE(voie, '^(RUE|AVENUE|BOULEVARD|IMPASSE|PLACE|ALLEE|CHEMIN|ROUTE|PASSAGE|SQUARE|COURS|QUAI|VOIE|CITE|RESIDENCE|LOTISSEMENT)\s+', '', 'i'),
        '\s+', ' ', 'g'
      ),
      'àâäéèêëïîôùûüçÀÂÄÉÈÊËÏÎÔÙÛÜÇ',
      'aaaeeeeiioouucAAAEEEEIIOOUUC'
    )
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 5. Fonction pour formater le numéro de voirie (padding à 4 chiffres)
CREATE OR REPLACE FUNCTION format_numero(num TEXT)
RETURNS TEXT AS $$
BEGIN
  IF num IS NULL OR num = '' THEN
    RETURN NULL;
  END IF;
  RETURN LPAD(REGEXP_REPLACE(num, '[^0-9]', '', 'g'), 4, '0');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 6. Trigger pour mettre à jour les colonnes normalisées
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

-- 7. Vue pour faciliter le matching BAN <-> MAJIC
CREATE OR REPLACE VIEW v_ban_matching AS
SELECT 
  id,
  numero,
  rep,
  nom_voie,
  nom_voie_normalized,
  numero_formatted,
  code_postal,
  SUBSTRING(code_postal FROM 1 FOR 2) as departement,
  code_commune,
  nom_commune,
  UPPER(TRANSLATE(nom_commune, 'àâäéèêëïîôùûüçÀÂÄÉÈÊËÏÎÔÙÛÜÇ-', 'aaaeeeeiioouucAAAEEEEIIOOUUC ')) as nom_commune_normalized,
  lon,
  lat,
  geom
FROM ban_adresses
WHERE geom IS NOT NULL;

-- 8. Fonction de recherche dans un polygone
CREATE OR REPLACE FUNCTION search_ban_in_polygon(
  polygon_wkt TEXT,
  max_results INTEGER DEFAULT 1000
)
RETURNS TABLE (
  id TEXT,
  numero TEXT,
  rep TEXT,
  nom_voie TEXT,
  code_postal TEXT,
  code_commune TEXT,
  nom_commune TEXT,
  lon DOUBLE PRECISION,
  lat DOUBLE PRECISION
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    b.id,
    b.numero,
    b.rep,
    b.nom_voie,
    b.code_postal,
    b.code_commune,
    b.nom_commune,
    b.lon,
    b.lat
  FROM ban_adresses b
  WHERE ST_Contains(
    ST_GeomFromText(polygon_wkt, 4326),
    b.geom
  )
  LIMIT max_results;
END;
$$ LANGUAGE plpgsql;

-- 9. Table pour stocker les statistiques d'import
CREATE TABLE IF NOT EXISTS ban_import_stats (
  id SERIAL PRIMARY KEY,
  import_date TIMESTAMP DEFAULT NOW(),
  total_records BIGINT,
  success_count BIGINT,
  error_count BIGINT,
  duration_seconds INTEGER,
  file_date TEXT,
  status TEXT DEFAULT 'completed'
);

-- 10. Afficher les statistiques
DO $$
DECLARE
  ban_count BIGINT;
  postgis_version TEXT;
BEGIN
  SELECT COUNT(*) INTO ban_count FROM ban_adresses;
  SELECT PostGIS_Version() INTO postgis_version;
  
  RAISE NOTICE '============================================';
  RAISE NOTICE 'Setup BAN terminé avec succès!';
  RAISE NOTICE 'PostGIS version: %', postgis_version;
  RAISE NOTICE 'Adresses BAN en base: %', ban_count;
  RAISE NOTICE '============================================';
END $$;
