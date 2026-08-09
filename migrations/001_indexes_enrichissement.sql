-- =============================================================================
-- Index d'enrichissement : dvf.mutations, copro.coproprietes, proprietaires_geo
-- =============================================================================
--
-- Base immo_data (dvf, copro) et cadastre_geo (proprietaires_geo), instance
-- PostgreSQL/PostGIS du port 5434.
--
-- CONSTAT
-- Aucun index n'existe aujourd'hui sur dvf.mutations (20,1 M lignes, 3,7 Go)
-- ni sur copro.coproprietes (619 301 lignes, 402 Mo). Chaque enrichissement,
-- donc chaque recherche de proprietaire, declenche un balayage sequentiel
-- complet de ces deux tables. C'est le premier facteur de latence du produit.
--
-- CES MIGRATIONS SONT PUREMENT ADDITIVES
-- Aucun DROP, aucun TRUNCATE, aucune modification de donnee. Elles ne creent
-- que des index. Le rollback est fourni en fin de fichier, en commentaire.
--
-- CREATE INDEX CONCURRENTLY
-- Chaque index est cree en mode CONCURRENTLY : la table reste lisible et
-- inscriptible pendant la construction. En contrepartie, CONCURRENTLY ne peut
-- PAS s'executer dans une transaction : ce fichier ne doit donc PAS etre
-- encadre de BEGIN/COMMIT, et doit etre joue avec psql --single-transaction
-- DESACTIVE. En cas d'interruption, l'index reste en etat "invalid" et doit
-- etre supprime puis recree (voir la requete de controle en fin de fichier).
--
-- DUREES ET TAILLES : estimations a valider sur la machine cible.
--   idx_dvf_mutations_id_parcelle   ~600-900 Mo   ~8-15 min
--   idx_dvf_mutations_id_mutation   ~500-800 Mo   ~8-15 min
--   idx_copro_ref_1/2/3             ~15 Mo chacun ~10-30 s chacun
--   idx_prop_geo_idu_parts          ~1,2-1,6 Go   ~15-30 min
--
-- Prevoir 1,5 fois la taille de l'index en espace disque transitoire.
-- Verifier l'espace libre AVANT de lancer :
--   SELECT pg_size_pretty(pg_database_size(current_database()));
--   df -h  (cote hote)
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. dvf.mutations  (base immo_data)
-- -----------------------------------------------------------------------------
-- Acces principal : WHERE id_parcelle = ANY($1). Sans index, 20,1 M lignes
-- balayees par recherche.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dvf_mutations_id_parcelle
  ON dvf.mutations (id_parcelle)
  WHERE valeur_fonciere > 0;
-- L'index partiel exclut les mutations sans valeur (echanges, successions a
-- valeur nulle), que l'enrichissement ecarte de toute facon. Il est donc plus
-- petit et plus dense que l'index complet.

COMMENT ON INDEX dvf.idx_dvf_mutations_id_parcelle IS
  'Enrichissement: recherche des ventes par parcelle. Partiel sur valeur_fonciere > 0.';

-- Utilise par l'agregation au niveau mutation (CTE spread) : une mutation peut
-- couvrir plusieurs parcelles, il faut pouvoir les regrouper.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dvf_mutations_id_mutation
  ON dvf.mutations (id_mutation)
  WHERE valeur_fonciere > 0;

COMMENT ON INDEX dvf.idx_dvf_mutations_id_mutation IS
  'Enrichissement: regroupement des lignes d''une meme mutation.';


-- -----------------------------------------------------------------------------
-- 2. copro.coproprietes  (base immo_data)
-- -----------------------------------------------------------------------------
-- Le registre national des coproprietes porte jusqu'a trois references
-- cadastrales par copropriete. Le code n'interrogeait que la premiere, ce qui
-- produisait un faux negatif silencieux ("pas une copropriete") pour toute
-- copropriete dont la parcelle figure en 2e ou 3e position.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_copro_ref_cadastrale_1
  ON copro.coproprietes (reference_cadastrale_1)
  WHERE reference_cadastrale_1 IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_copro_ref_cadastrale_2
  ON copro.coproprietes (reference_cadastrale_2)
  WHERE reference_cadastrale_2 IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_copro_ref_cadastrale_3
  ON copro.coproprietes (reference_cadastrale_3)
  WHERE reference_cadastrale_3 IS NOT NULL;


-- -----------------------------------------------------------------------------
-- 3. bdnb : relation batiment <-> parcelle  (base immo_data)
-- -----------------------------------------------------------------------------
-- ATTENTION : adapter le nom du schema au millesime reellement present.
--   SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'bdnb%';
-- Le code resout ce nom dynamiquement, mais un index doit nommer son schema.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bdnb_rel_bat_parcelle_parcelle_id
  ON bdnb_2025_07_a_open_data.rel_batiment_groupe_parcelle (parcelle_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bdnb_parcelle_parcelle_id
  ON bdnb_2025_07_a_open_data.parcelle (parcelle_id);


-- -----------------------------------------------------------------------------
-- 4. proprietaires_geo  (base cadastre_geo, connexion SEPAREE)
-- -----------------------------------------------------------------------------
-- A jouer sur la base cadastre_geo, pas sur immo_data.
--
-- L'unique index composite existant, idx_prop_join_key, est PARTIEL sur
-- WHERE geom IS NULL : il ne couvre donc que les 2 % de lignes NON geocodees et
-- reste inutilisable pour les 98 % de lignes qui portent une geometrie. C'est
-- exactement l'inverse du besoin.
--
-- On ajoute l'index symetrique, sur les lignes geocodees, en incluant
-- prefixe_section : l'identifiant cadastral inclut le prefixe en positions 5-8,
-- et l'omettre apparie a tort des parcelles de communes fusionnees.
--
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prop_geo_join_key_geocoded
--   ON public.proprietaires_geo (departement, code_commune, prefixe_section, section, numero_plan)
--   WHERE geom IS NOT NULL;


-- =============================================================================
-- CONTROLE POST-EXECUTION
-- =============================================================================
-- Aucun index ne doit rester en etat invalide :
--
--   SELECT c.relname, i.indisvalid
--     FROM pg_index i
--     JOIN pg_class c ON c.oid = i.indexrelid
--    WHERE NOT i.indisvalid;
--
-- Un index invalide se supprime puis se recree :
--   DROP INDEX CONCURRENTLY <nom>;
--
-- Verifier que le planificateur les utilise reellement :
--   EXPLAIN (ANALYZE, BUFFERS)
--   SELECT id_parcelle, MAX(valeur_fonciere)
--     FROM dvf.mutations
--    WHERE id_parcelle = ANY(ARRAY['75056000AB0001'])
--      AND valeur_fonciere > 0
--    GROUP BY id_parcelle;
--
-- Rafraichir les statistiques apres creation :
--   ANALYZE dvf.mutations;
--   ANALYZE copro.coproprietes;


-- =============================================================================
-- ROLLBACK  (a n'executer que pour revenir en arriere)
-- =============================================================================
-- DROP INDEX CONCURRENTLY IF EXISTS dvf.idx_dvf_mutations_id_parcelle;
-- DROP INDEX CONCURRENTLY IF EXISTS dvf.idx_dvf_mutations_id_mutation;
-- DROP INDEX CONCURRENTLY IF EXISTS copro.idx_copro_ref_cadastrale_1;
-- DROP INDEX CONCURRENTLY IF EXISTS copro.idx_copro_ref_cadastrale_2;
-- DROP INDEX CONCURRENTLY IF EXISTS copro.idx_copro_ref_cadastrale_3;
-- DROP INDEX CONCURRENTLY IF EXISTS bdnb_2025_07_a_open_data.idx_bdnb_rel_bat_parcelle_parcelle_id;
-- DROP INDEX CONCURRENTLY IF EXISTS bdnb_2025_07_a_open_data.idx_bdnb_parcelle_parcelle_id;
