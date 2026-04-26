/**
 * Service d'enrichissement immobilier
 * Croise les données DVF, BDNB et Copro pour enrichir les résultats de recherche
 */

import { Pool } from 'pg';

// Pool dédié vers la base immo_data (enrichissement)
const enrichPool = new Pool({
  host: process.env.ENRICH_DB_HOST || '172.17.0.1',
  port: parseInt(process.env.ENRICH_DB_PORT || '5434'),
  database: 'immo_data',
  user: process.env.ENRICH_DB_USER || 'immo',
  password: process.env.ENRICH_DB_PASSWORD || 'imm0_pr0d_2026_s3cure',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Pool dédié vers la base cadastre_geo (surface parcelle)
const cadastrePool = new Pool({
  host: process.env.CADASTRE_DB_HOST || '172.17.0.1',
  port: parseInt(process.env.CADASTRE_DB_PORT || '5434'),
  database: 'cadastre_geo',
  user: process.env.CADASTRE_DB_USER || 'immo',
  password: process.env.CADASTRE_DB_PASSWORD || 'imm0_pr0d_2026_s3cure',
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

/**
 * Enrichit un batch de parcelles avec les données DVF, BDNB et Copro
 */
export async function enrichParcelles(parcelleIds: string[]): Promise<Map<string, any>> {
  if (parcelleIds.length === 0) return new Map();

  const unique = [...new Set(parcelleIds)];
  const results = new Map<string, any>();

  // Initialize results for all parcelles
  for (const pid of unique) {
    results.set(pid, {
      type_bien: null,
      surface_parcelle: null,
      surface_batie: null,
      prix_m2: null,
      date_derniere_transaction: null,
      nb_transactions: 0,
      est_copropriete: false,
      nb_lots_total: null,
      nb_lots_habitation: null,
      nb_lots_tertiaire: null,
      nom_copropriete: null,
      annee_construction: null,
      nb_niveaux: null,
      nb_logements: null,
      surface_lots_carrez: null,
      type_transaction: null,
      valeur_fonciere: null,
      premiere_transaction: null,
    });
  }

  try {
    // 1. Query DVF + BDNB + Copro from immo_data
    const enrichQuery = `
      WITH input_parcelles AS (
        SELECT unnest($1::text[]) as parcelle_id
      ),
      dvf_last AS (
        SELECT DISTINCT ON (id_parcelle)
          id_parcelle,
          (valeur_fonciere / NULLIF(surface_reelle_bati, 0))::int as prix_m2,
          surface_reelle_bati::int as surface_batie,
          date_mutation::text as derniere_transaction,
          type_local,
          valeur_fonciere,
          lot1_surface_carrez, lot2_surface_carrez, lot3_surface_carrez,
          lot4_surface_carrez, lot5_surface_carrez
        FROM dvf.mutations 
        WHERE id_parcelle = ANY($1)
          AND valeur_fonciere > 0
          AND surface_reelle_bati > 0
          AND code_type_local != 3
        ORDER BY id_parcelle, date_mutation DESC, valeur_fonciere DESC
      ),
      dvf_count AS (
        SELECT id_parcelle, COUNT(*) as nb_transactions, MIN(date_mutation)::text as premiere_transaction
        FROM dvf.mutations 
        WHERE id_parcelle = ANY($1) AND valeur_fonciere > 0
        GROUP BY id_parcelle
      ),
      dvf_agg AS (
        SELECT 
          dl.id_parcelle,
          dl.prix_m2,
          dl.surface_batie,
          dl.derniere_transaction,
          dc.nb_transactions,
          dc.premiere_transaction,
          dl.type_local,
          COALESCE(dl.lot1_surface_carrez, 0) + COALESCE(dl.lot2_surface_carrez, 0) + 
          COALESCE(dl.lot3_surface_carrez, 0) + COALESCE(dl.lot4_surface_carrez, 0) + 
          COALESCE(dl.lot5_surface_carrez, 0) as surface_lots_carrez
        FROM dvf_last dl
        LEFT JOIN dvf_count dc ON dc.id_parcelle = dl.id_parcelle
      ),
      bdnb_data AS (
        SELECT DISTINCT ON (rbgp.parcelle_id)
          rbgp.parcelle_id,
          ffo.usage_niveau_1_txt,
          ffo.nb_log,
          ffo.nb_niveau,
          ffo.annee_construction,
          ffo.mat_mur_txt,
          ffo.mat_toit_txt,
          rnc.nb_lot_tot,
          rnc.nb_lot_tertiaire,
          rnc.l_nom_copro,
          rnc.numero_immat_principal
        FROM bdnb_2025_07_a_open_data.rel_batiment_groupe_parcelle rbgp
        LEFT JOIN bdnb_2025_07_a_open_data.batiment_groupe_ffo_bat ffo 
          ON ffo.batiment_groupe_id = rbgp.batiment_groupe_id
        LEFT JOIN bdnb_2025_07_a_open_data.batiment_groupe_rnc rnc 
          ON rnc.batiment_groupe_id = rbgp.batiment_groupe_id
        WHERE rbgp.parcelle_id = ANY($1)
        ORDER BY rbgp.parcelle_id, ffo.nb_log DESC NULLS LAST
      ),
      copro_data AS (
        SELECT DISTINCT ON (reference_cadastrale_1)
          reference_cadastrale_1 as parcelle_id,
          nom_d_usage_de_la_copropriete as nom_copro,
          nombre_total_de_lots,
          nombre_de_lots_a_usage_d_habitation,
          periode_de_construction
        FROM copro.coproprietes
        WHERE reference_cadastrale_1 = ANY($1)
      )
      SELECT 
        ip.parcelle_id,
        d.prix_m2,
        d.surface_batie,
        d.derniere_transaction,
        d.nb_transactions,
        d.premiere_transaction,
        d.type_local,
        d.surface_lots_carrez,
        b.usage_niveau_1_txt as type_bien,
        b.nb_log,
        b.nb_niveau as nb_niveaux_bdnb,
        b.annee_construction as annee_construction_bdnb,
        b.mat_mur_txt,
        b.mat_toit_txt,
        b.nb_lot_tot,
        b.nb_lot_tertiaire,
        b.l_nom_copro,
        b.numero_immat_principal,
        c.nom_copro,
        c.nombre_total_de_lots,
        c.nombre_de_lots_a_usage_d_habitation,
        c.periode_de_construction
      FROM input_parcelles ip
      LEFT JOIN dvf_agg d ON d.id_parcelle = ip.parcelle_id
      LEFT JOIN bdnb_data b ON b.parcelle_id = ip.parcelle_id
      LEFT JOIN copro_data c ON c.parcelle_id = ip.parcelle_id
    `;

    const enrichResult = await enrichPool.query(enrichQuery, [unique]);

    // Populate from DVF/BDNB/Copro
    for (const row of enrichResult.rows) {
      const pid = row.parcelle_id;
      if (!pid) continue;

      const existing = results.get(pid) || {};
      const estCopro = !!(row.nb_lot_tot || row.nombre_total_de_lots || row.l_nom_copro || row.nom_copro);

      results.set(pid, {
        ...existing,
        type_bien: row.type_bien || existing.type_bien,
        surface_batie: row.surface_batie || existing.surface_batie,
        prix_m2: row.prix_m2 || existing.prix_m2,
        date_derniere_transaction: row.derniere_transaction || existing.date_derniere_transaction,
        nb_transactions: row.nb_transactions ? parseInt(row.nb_transactions) : existing.nb_transactions,
        est_copropriete: estCopro || existing.est_copropriete,
        nb_lots_total: row.nombre_total_de_lots || row.nb_lot_tot || existing.nb_lots_total,
        nb_lots_habitation: row.nombre_de_lots_a_usage_d_habitation || existing.nb_lots_habitation,
        nb_lots_tertiaire: row.nb_lot_tertiaire || existing.nb_lots_tertiaire,
        nom_copropriete: row.nom_copro || row.l_nom_copro || existing.nom_copropriete,
        annee_construction: row.periode_de_construction || row.annee_construction_bdnb || existing.annee_construction,
        nb_niveaux: row.nb_niveaux_bdnb || existing.nb_niveaux,
        nb_logements: row.nb_log || existing.nb_logements,
        surface_lots_carrez: row.surface_lots_carrez || existing.surface_lots_carrez,
        type_transaction: row.type_local || existing.type_transaction,
        premiere_transaction: row.premiere_transaction || existing.premiere_transaction,
      });
    }

    // 2. Query surface parcelle from cadastre_geo
    try {
      const surfaceQuery = `
        SELECT idu as parcelle_id, contenance as surface_parcelle_m2
        FROM parcelles_cadastre
        WHERE idu = ANY($1)
      `;
      const surfaceResult = await cadastrePool.query(surfaceQuery, [unique]);

      for (const row of surfaceResult.rows) {
        const pid = row.parcelle_id;
        if (!pid) continue;
        const existing = results.get(pid);
        if (existing) {
          existing.surface_parcelle = row.surface_parcelle_m2 || existing.surface_parcelle;
        }
      }
    } catch (err) {
      console.error('[ENRICH] Erreur requete surface parcelle:', err);
    }

  } catch (error) {
    console.error('[ENRICH] Erreur enrichissement:', error);
  }

  return results;
}

/**
 * Enrichit une seule parcelle
 */
export async function enrichParcelle(parcelleId: string): Promise<any | null> {
  const results = await enrichParcelles([parcelleId]);
  return results.get(parcelleId) || null;
}
