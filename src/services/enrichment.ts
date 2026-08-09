/**
 * Service d'enrichissement immobilier.
 *
 * Croise, pour un lot de parcelles identifiees par leur IDU :
 *   - dvf.mutations                    -> historique des ventes et dernier prix
 *   - bdnb_<millesime>.*               -> caracteristiques du bati, surface geometrique
 *   - copro.coproprietes               -> statut de copropriete
 *   - cadastre_geo.parcelles_cadastre  -> contenance cadastrale de reference
 *
 * DEUX POINTS DE CORRECTION STRUCTURANTS PAR RAPPORT A LA VERSION PRECEDENTE
 *
 * 1. Agregation au niveau MUTATION.
 *    Dans DVF, `valeur_fonciere` est le prix de la mutation entiere et il est
 *    REPETE sur chacune de ses lignes (une ligne par local, par lot et par
 *    parcelle). Diviser `valeur_fonciere / surface_reelle_bati` ligne a ligne,
 *    comme le faisait la version precedente, produit un prix au m2 faux des
 *    qu'une vente porte sur plus d'un local, et sommer les valeurs foncieres
 *    compte le meme prix plusieurs fois. On agrege donc par (id_parcelle,
 *    id_mutation) AVANT tout calcul.
 *
 * 2. Le foncier nu n'est plus invisible.
 *    Les filtres `surface_reelle_bati > 0 AND code_type_local != 3` excluaient
 *    toutes les ventes de terrain nu, c'est-a-dire precisement la cible d'un
 *    promoteur. On conserve desormais toutes les mutations valorisees et on
 *    calcule un prix au m2 de terrain quand il n'y a pas de bati.
 *
 * Le prix retourne est une donnee publique horodatee, pas une estimation :
 * `valeur_fonciere` est le montant reellement enregistre par l'administration
 * fiscale pour la mutation.
 */

import { Pool } from 'pg';
import { ParcelleEnrichment, VenteDVF } from '../types/index.js';

// Les types de donnees sont definis dans types/index.ts (contrat d'API) et
// re-exportes ici pour les appelants historiques.
export type { ParcelleEnrichment, VenteDVF };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnrichmentOutcome {
  results: Map<string, ParcelleEnrichment>;
  /**
   * Sources en echec technique. Une source en echec n'est PAS une absence de
   * donnee : l'appelant doit pouvoir le signaler plutot que d'afficher un
   * resultat vide qui ressemble a une reponse valide.
   */
  failures: string[];
}

// ---------------------------------------------------------------------------
// Configuration et pools
// ---------------------------------------------------------------------------

/** Nombre de ventes conservees dans l'historique par parcelle. */
const MAX_VENTES_HISTORIQUE = 10;

/** Plafond de parcelles par appel, aligne sur la route /search/enrich. */
export const MAX_PARCELLES_PAR_APPEL = 200;

/**
 * Le millesime BDNB change a chaque edition et le nom de schema etait code en
 * dur : a la prochaine edition toutes les requetes d'enrichissement auraient
 * echoue, silencieusement puisque les erreurs etaient avalees. On resout donc
 * le schema une fois au demarrage, avec l'environnement comme valeur preferee
 * et une detection automatique en repli.
 */
const BDNB_SCHEMA_ENV = process.env.BDNB_SCHEMA || '';
const BDNB_SCHEMA_FALLBACK = 'bdnb_2025_07_a_open_data';
let bdnbSchemaCache: string | null = null;

function requireDbPassword(varName: string): string {
  const value = process.env[varName];
  if (!value) {
    // Fail-closed : un mot de passe vide produisait une connexion refusee dont
    // l'erreur etait avalee plus bas, donc un enrichissement toujours vide et
    // jamais diagnostique.
    throw new Error(
      `[ENRICH] Variable d'environnement ${varName} manquante : enrichissement desactive`
    );
  }
  return value;
}

let enrichPoolInstance: Pool | null = null;
let cadastrePoolInstance: Pool | null = null;

function getEnrichPool(): Pool {
  if (!enrichPoolInstance) {
    enrichPoolInstance = new Pool({
      host: process.env.ENRICH_DB_HOST || '172.17.0.1',
      port: parseInt(process.env.ENRICH_DB_PORT || '5434'),
      database: process.env.ENRICH_DB_NAME || 'immo_data',
      user: process.env.ENRICH_DB_USER || 'immo',
      password: requireDbPassword('ENRICH_DB_PASSWORD'),
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: parseInt(process.env.ENRICH_STATEMENT_TIMEOUT_MS || '25000'),
    });
    enrichPoolInstance.on('error', (err) => {
      console.error('[ENRICH] Erreur pool immo_data (client idle):', err.message);
    });
  }
  return enrichPoolInstance;
}

function getCadastrePool(): Pool {
  if (!cadastrePoolInstance) {
    cadastrePoolInstance = new Pool({
      host: process.env.CADASTRE_DB_HOST || '172.17.0.1',
      port: parseInt(process.env.CADASTRE_DB_PORT || '5434'),
      database: process.env.CADASTRE_DB_NAME || 'cadastre_geo',
      user: process.env.CADASTRE_DB_USER || 'immo',
      password: requireDbPassword('CADASTRE_DB_PASSWORD'),
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      statement_timeout: parseInt(process.env.ENRICH_STATEMENT_TIMEOUT_MS || '25000'),
    });
    cadastrePoolInstance.on('error', (err) => {
      console.error('[ENRICH] Erreur pool cadastre_geo (client idle):', err.message);
    });
  }
  return cadastrePoolInstance;
}

/**
 * Determine le schema BDNB reellement present. Les noms sont millesimes
 * (`bdnb_2025_07_a_open_data`) : on prend le plus recent par ordre alphabetique,
 * qui est aussi le plus recent chronologiquement vu le format de nommage.
 */
async function resolveBdnbSchema(): Promise<string> {
  if (bdnbSchemaCache) return bdnbSchemaCache;

  if (BDNB_SCHEMA_ENV) {
    bdnbSchemaCache = BDNB_SCHEMA_ENV;
    return bdnbSchemaCache;
  }

  try {
    const res = await getEnrichPool().query<{ schema_name: string }>(
      `SELECT schema_name
         FROM information_schema.schemata
        WHERE schema_name LIKE 'bdnb%'
        ORDER BY schema_name DESC
        LIMIT 1`
    );
    if (res.rows.length > 0) {
      bdnbSchemaCache = res.rows[0].schema_name;
      if (bdnbSchemaCache !== BDNB_SCHEMA_FALLBACK) {
        console.warn(
          `[ENRICH] Millesime BDNB detecte: ${bdnbSchemaCache} (attendu ${BDNB_SCHEMA_FALLBACK})`
        );
      }
      return bdnbSchemaCache;
    }
  } catch (err) {
    console.error('[ENRICH] Detection du schema BDNB impossible:', (err as Error).message);
  }

  bdnbSchemaCache = BDNB_SCHEMA_FALLBACK;
  return bdnbSchemaCache;
}

/**
 * Un identifiant de schema ne peut pas etre passe en parametre lie : on le
 * valide strictement avant interpolation pour eliminer tout risque d'injection.
 */
function assertSafeIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`[ENRICH] Nom de schema invalide: ${identifier}`);
  }
  return identifier;
}

// ---------------------------------------------------------------------------
// Helpers de conversion
// ---------------------------------------------------------------------------

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function toInt(value: unknown): number | null {
  const n = toNumber(value);
  return n === null ? null : Math.round(n);
}

function emptyEnrichment(idu: string): ParcelleEnrichment {
  return {
    idu,
    surface_parcelle_m2: null,
    surface_geometrique_m2: null,
    derniere_vente: null,
    ventes: [],
    nb_transactions: 0,
    premiere_transaction: null,
    surface_lots_carrez: null,
    type_bien: null,
    annee_construction: null,
    nb_niveaux: null,
    nb_logements: null,
    materiau_mur: null,
    materiau_toit: null,
    est_copropriete: false,
    nom_copropriete: null,
    nb_lots_total: null,
    nb_lots_habitation: null,
    nb_lots_tertiaire: null,
    nb_lots_stationnement: null,
    periode_construction: null,
    foncier_nu: false,
    sources: { dvf: false, bdnb: false, copro: false, cadastre: false },
  };
}

// ---------------------------------------------------------------------------
// Requetes
// ---------------------------------------------------------------------------

/**
 * Historique des mutations par parcelle, agrege au niveau mutation.
 *
 * La fenetre `ROW_NUMBER` classe les mutations de chaque parcelle par date
 * decroissante : la ligne rn = 1 est la derniere vente enregistree.
 */
interface TotauxDvf {
  nbTransactions: number;
  premiereTransaction: string | null;
}

async function queryDvf(
  idus: string[]
): Promise<{ ventes: Map<string, VenteDVF[]>; totaux: Map<string, TotauxDvf> }> {
  const sql = `
    WITH
    -- Les lignes DVF d'une meme (mutation, parcelle) decrivent chacune un local
    -- ou une subdivision de culture, et repetent la valeur fonciere de la
    -- mutation entiere. On ne peut donc ni sommer valeur_fonciere, ni sommer
    -- naivement surface_terrain qui est elle aussi repetee.
    --
    -- surface_terrain est deduplique sur (nature de culture, surface) avant
    -- sommation : sommer les lignes brutes gonflerait la surface autant de fois
    -- qu'il y a de locaux, et en prendre le seul maximum perdrait les parcelles
    -- reellement subdivisees en plusieurs natures de culture.
    terrain_dedup AS (
      SELECT DISTINCT
        m.id_parcelle,
        m.id_mutation,
        COALESCE(m.code_nature_culture, '')       AS code_nature_culture,
        COALESCE(m.surface_terrain, 0)            AS surface_terrain
      FROM dvf.mutations m
      WHERE m.id_parcelle = ANY($1::text[])
        AND m.valeur_fonciere > 0
    ),
    terrain_par_mutation AS (
      SELECT id_parcelle, id_mutation, SUM(surface_terrain) AS surface_terrain
        FROM terrain_dedup
       GROUP BY id_parcelle, id_mutation
    ),
    mut_parcelle AS (
      SELECT
        m.id_parcelle,
        m.id_mutation,
        MAX(m.date_mutation)                            AS date_mutation,
        MAX(m.nature_mutation)                          AS nature_mutation,
        -- Valeur de la mutation : identique sur toutes ses lignes, MAX la releve
        -- sans jamais la cumuler.
        MAX(m.valeur_fonciere)                          AS valeur_fonciere,
        -- Le bati, lui, est bien propre a chaque local : il se somme.
        SUM(COALESCE(m.surface_reelle_bati, 0))         AS surface_bati,
        MAX(m.type_local)                               AS type_local,
        MAX(m.nombre_lots)                              AS nombre_lots,
        SUM(COALESCE(m.nombre_pieces_principales, 0))   AS nombre_pieces,
        MAX(m.nature_culture)                           AS nature_culture,
        -- Surface Carrez : chaque ligne porte jusqu'a 5 lots, propres au local.
        SUM(
          COALESCE(m.lot1_surface_carrez, 0) + COALESCE(m.lot2_surface_carrez, 0) +
          COALESCE(m.lot3_surface_carrez, 0) + COALESCE(m.lot4_surface_carrez, 0) +
          COALESCE(m.lot5_surface_carrez, 0)
        )                                               AS surface_lots_carrez
      FROM dvf.mutations m
      WHERE m.id_parcelle = ANY($1::text[])
        AND m.valeur_fonciere > 0
      GROUP BY m.id_parcelle, m.id_mutation
    ),
    -- Nombre REEL de parcelles couvertes par chaque mutation, calcule sur la
    -- table entiere et non sur le seul lot interroge.
    --
    -- Le compter dans le lot rendait le resultat dependant de la requete : la
    -- meme parcelle affichait un prix au m2 tantot present, tantot absent, selon
    -- que la parcelle voisine figurait ou non dans la recherche. S'appuie sur
    -- idx_dvf_mutations_id_mutation (migrations/001).
    portee_reelle AS (
      SELECT m.id_mutation, COUNT(DISTINCT m.id_parcelle) AS parcelles_totales
        FROM dvf.mutations m
       WHERE m.id_mutation IN (SELECT DISTINCT id_mutation FROM mut_parcelle)
         AND m.valeur_fonciere > 0
       GROUP BY m.id_mutation
    ),
    complet AS (
      SELECT
        mp.*,
        COALESCE(t.surface_terrain, 0)          AS surface_terrain,
        COALESCE(p.parcelles_totales, 1)        AS parcelles_totales,
        -- Comptages calcules sur l'historique COMPLET, avant toute troncature :
        -- les deduire des seules lignes retournees sous-estimait le nombre de
        -- transactions et faussait la date de premiere transaction.
        COUNT(*)          OVER (PARTITION BY mp.id_parcelle) AS nb_transactions_total,
        MIN(mp.date_mutation) OVER (PARTITION BY mp.id_parcelle) AS premiere_transaction,
        ROW_NUMBER() OVER (
          PARTITION BY mp.id_parcelle
          -- id_mutation en dernier critere : sans lui, deux mutations de meme
          -- date et de meme valeur s'ordonnaient de facon non deterministe et
          -- la "derniere vente" pouvait changer d'un appel a l'autre.
          ORDER BY mp.date_mutation DESC, mp.valeur_fonciere DESC, mp.id_mutation DESC
        ) AS rn
      FROM mut_parcelle mp
      LEFT JOIN terrain_par_mutation t
        ON t.id_parcelle = mp.id_parcelle AND t.id_mutation = mp.id_mutation
      LEFT JOIN portee_reelle p
        ON p.id_mutation = mp.id_mutation
    )
    SELECT *
      FROM complet
     WHERE rn <= $2
     ORDER BY id_parcelle, rn
  `;

  const res = await getEnrichPool().query(sql, [idus, MAX_VENTES_HISTORIQUE]);
  const byParcelle = new Map<string, VenteDVF[]>();
  const totauxParParcelle = new Map<string, TotauxDvf>();

  for (const row of res.rows) {
    const surfaceBati = toNumber(row.surface_bati) || 0;
    const surfaceTerrain = toNumber(row.surface_terrain) || 0;
    const valeur = toNumber(row.valeur_fonciere) || 0;
    const parcellesTotales = toInt(row.parcelles_totales) || 1;
    const fonciernu = surfaceBati <= 0 && surfaceTerrain > 0;

    // Le prix au m2 n'a de sens que rapporte a une surface, et seulement si la
    // mutation ne couvre qu'une parcelle : sinon on imputerait a celle-ci le
    // prix de plusieurs. Le comptage est desormais calcule sur la table entiere,
    // il ne depend plus de la composition du lot interroge.
    const imputable = parcellesTotales <= 1;

    const vente: VenteDVF = {
      id_mutation: String(row.id_mutation),
      date_mutation: row.date_mutation instanceof Date
        ? row.date_mutation.toISOString().slice(0, 10)
        : String(row.date_mutation).slice(0, 10),
      nature_mutation: row.nature_mutation || null,
      valeur_fonciere: valeur,
      surface_bati_m2: surfaceBati > 0 ? surfaceBati : null,
      surface_terrain_m2: surfaceTerrain > 0 ? surfaceTerrain : null,
      prix_m2_bati:
        imputable && surfaceBati > 0 ? Math.round(valeur / surfaceBati) : null,
      prix_m2_terrain:
        imputable && fonciernu && surfaceTerrain > 0
          ? Math.round(valeur / surfaceTerrain)
          : null,
      type_local: row.type_local || null,
      nombre_lots: toInt(row.nombre_lots),
      nombre_pieces: toInt(row.nombre_pieces) || null,
      nature_culture: row.nature_culture || null,
      surface_lots_carrez_m2: (toNumber(row.surface_lots_carrez) || 0) > 0
        ? Math.round(toNumber(row.surface_lots_carrez) as number)
        : null,
      foncier_nu: fonciernu,
      parcelles_connues_dans_mutation: parcellesTotales,
      prix_couvre_plusieurs_parcelles: parcellesTotales > 1,
    };

    const list = byParcelle.get(row.id_parcelle) || [];
    list.push(vente);
    byParcelle.set(row.id_parcelle, list);

    // Totaux calcules sur l'historique complet, avant troncature.
    totauxParParcelle.set(row.id_parcelle, {
      nbTransactions: toInt(row.nb_transactions_total) || list.length,
      premiereTransaction: row.premiere_transaction instanceof Date
        ? row.premiere_transaction.toISOString().slice(0, 10)
        : row.premiere_transaction
          ? String(row.premiere_transaction).slice(0, 10)
          : null,
    });
  }

  return { ventes: byParcelle, totaux: totauxParParcelle };
}

/** Caracteristiques du bati et surface geometrique (BDNB). */
async function queryBdnb(idus: string[]): Promise<Map<string, Record<string, unknown>>> {
  const schema = assertSafeIdentifier(await resolveBdnbSchema());

  const sql = `
    WITH bati AS (
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
        rnc.l_nom_copro
      FROM ${schema}.rel_batiment_groupe_parcelle rbgp
      LEFT JOIN ${schema}.batiment_groupe_ffo_bat ffo
        ON ffo.batiment_groupe_id = rbgp.batiment_groupe_id
      LEFT JOIN ${schema}.batiment_groupe_rnc rnc
        ON rnc.batiment_groupe_id = rbgp.batiment_groupe_id
      WHERE rbgp.parcelle_id = ANY($1::text[])
      ORDER BY rbgp.parcelle_id, ffo.nb_log DESC NULLS LAST
    ),
    geom AS (
      SELECT parcelle_id, s_geom_parcelle
        FROM ${schema}.parcelle
       WHERE parcelle_id = ANY($1::text[])
    )
    SELECT
      COALESCE(b.parcelle_id, g.parcelle_id) AS parcelle_id,
      b.usage_niveau_1_txt,
      b.nb_log,
      b.nb_niveau,
      b.annee_construction,
      b.mat_mur_txt,
      b.mat_toit_txt,
      b.nb_lot_tot,
      b.nb_lot_tertiaire,
      b.l_nom_copro,
      g.s_geom_parcelle
    FROM bati b
    FULL OUTER JOIN geom g ON g.parcelle_id = b.parcelle_id
  `;

  const res = await getEnrichPool().query(sql, [idus]);
  const map = new Map<string, Record<string, unknown>>();
  for (const row of res.rows) {
    if (row.parcelle_id) map.set(row.parcelle_id, row);
  }
  return map;
}

/**
 * Statut de copropriete.
 * La version precedente n'interrogeait que `reference_cadastrale_1`, ce qui
 * ratait toute copropriete dont la parcelle est en 2e ou 3e reference : un faux
 * negatif silencieux. On interroge les trois.
 */
async function queryCopro(idus: string[]): Promise<Map<string, Record<string, unknown>>> {
  const sql = `
    -- DISTINCT ON exige un ORDER BY pour etre deterministe : sans lui, la
    -- copropriete retenue pour une parcelle changeait d'un appel a l'autre.
    -- On privilegie la fiche la plus renseignee, puis le nom, comme cle stable.
    SELECT DISTINCT ON (parcelle_id) *
    FROM (
      SELECT reference_cadastrale_1 AS parcelle_id, nom_d_usage_de_la_copropriete,
             nombre_total_de_lots, nombre_de_lots_a_usage_d_habitation,
             nombre_de_lots_de_stationnement, periode_de_construction
        FROM copro.coproprietes WHERE reference_cadastrale_1 = ANY($1::text[])
      UNION ALL
      SELECT reference_cadastrale_2, nom_d_usage_de_la_copropriete,
             nombre_total_de_lots, nombre_de_lots_a_usage_d_habitation,
             nombre_de_lots_de_stationnement, periode_de_construction
        FROM copro.coproprietes WHERE reference_cadastrale_2 = ANY($1::text[])
      UNION ALL
      SELECT reference_cadastrale_3, nom_d_usage_de_la_copropriete,
             nombre_total_de_lots, nombre_de_lots_a_usage_d_habitation,
             nombre_de_lots_de_stationnement, periode_de_construction
        FROM copro.coproprietes WHERE reference_cadastrale_3 = ANY($1::text[])
    ) t
    WHERE parcelle_id IS NOT NULL
    ORDER BY parcelle_id,
             (nombre_total_de_lots IS NOT NULL) DESC,
             nom_d_usage_de_la_copropriete NULLS LAST
  `;

  const res = await getEnrichPool().query(sql, [idus]);
  const map = new Map<string, Record<string, unknown>>();
  for (const row of res.rows) {
    if (row.parcelle_id) map.set(row.parcelle_id, row);
  }
  return map;
}

/** Contenance cadastrale officielle. */
async function queryContenance(idus: string[]): Promise<Map<string, number>> {
  const res = await getCadastrePool().query(
    `SELECT idu, contenance FROM parcelles_cadastre WHERE idu = ANY($1::text[])`,
    [idus]
  );
  const map = new Map<string, number>();
  for (const row of res.rows) {
    const c = toInt(row.contenance);
    if (row.idu && c !== null) map.set(row.idu, c);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Point d'entree
// ---------------------------------------------------------------------------

/**
 * Enrichit un lot de parcelles.
 *
 * Les quatre sources sont interrogees en parallele et independamment : une
 * source indisponible n'annule pas les autres, mais elle est signalee dans
 * `failures` pour que l'appelant distingue une absence de donnee d'une panne.
 */
export async function enrichParcellesDetailed(
  parcelleIds: string[]
): Promise<EnrichmentOutcome> {
  const unique = [...new Set(parcelleIds.filter(Boolean))];
  const results = new Map<string, ParcelleEnrichment>();
  const failures: string[] = [];

  for (const idu of unique) {
    results.set(idu, emptyEnrichment(idu));
  }

  if (unique.length === 0) {
    return { results, failures };
  }

  const [dvfRes, bdnbRes, coproRes, contenanceRes] = await Promise.allSettled([
    queryDvf(unique),
    queryBdnb(unique),
    queryCopro(unique),
    queryContenance(unique),
  ]);

  // --- DVF : ventes et dernier prix -----------------------------------------
  if (dvfRes.status === 'fulfilled') {
    for (const [idu, ventes] of dvfRes.value.ventes) {
      const entry = results.get(idu);
      if (!entry) continue;
      const totaux = dvfRes.value.totaux.get(idu);
      entry.ventes = ventes;
      entry.derniere_vente = ventes[0] || null;
      // Comptages issus de l'historique complet, et non des seules ventes
      // retournees : l'historique est tronque a MAX_VENTES_HISTORIQUE.
      entry.nb_transactions = totaux?.nbTransactions ?? ventes.length;
      entry.premiere_transaction =
        totaux?.premiereTransaction ??
        (ventes.length ? ventes[ventes.length - 1].date_mutation : null);
      entry.surface_lots_carrez = ventes[0]?.surface_lots_carrez_m2 ?? null;
      entry.foncier_nu = ventes.length > 0 && ventes.every((v) => v.foncier_nu);
      entry.sources.dvf = true;
    }
    // Une parcelle sans vente a bien ete interrogee : la source a repondu.
    for (const idu of unique) {
      const entry = results.get(idu);
      if (entry) entry.sources.dvf = true;
    }
  } else {
    failures.push('dvf');
    console.error('[ENRICH] Requete DVF en echec:', dvfRes.reason?.message || dvfRes.reason);
  }

  // --- BDNB : bati et surface geometrique -----------------------------------
  if (bdnbRes.status === 'fulfilled') {
    for (const idu of unique) {
      const entry = results.get(idu);
      if (entry) entry.sources.bdnb = true;
    }
    for (const [idu, row] of bdnbRes.value) {
      const entry = results.get(idu);
      if (!entry) continue;
      entry.type_bien = (row.usage_niveau_1_txt as string) || null;
      entry.nb_logements = toInt(row.nb_log);
      entry.nb_niveaux = toInt(row.nb_niveau);
      entry.annee_construction = toInt(row.annee_construction);
      entry.materiau_mur = (row.mat_mur_txt as string) || null;
      entry.materiau_toit = (row.mat_toit_txt as string) || null;
      entry.nb_lots_total = toInt(row.nb_lot_tot);
      entry.nb_lots_tertiaire = toInt(row.nb_lot_tertiaire);
      entry.surface_geometrique_m2 = toInt(row.s_geom_parcelle);
      if (row.l_nom_copro) {
        entry.nom_copropriete = row.l_nom_copro as string;
        entry.est_copropriete = true;
      }
    }
  } else {
    failures.push('bdnb');
    console.error('[ENRICH] Requete BDNB en echec:', bdnbRes.reason?.message || bdnbRes.reason);
  }

  // --- Copropriete -----------------------------------------------------------
  if (coproRes.status === 'fulfilled') {
    for (const idu of unique) {
      const entry = results.get(idu);
      if (entry) entry.sources.copro = true;
    }
    for (const [idu, row] of coproRes.value) {
      const entry = results.get(idu);
      if (!entry) continue;
      entry.est_copropriete = true;
      entry.nom_copropriete =
        (row.nom_d_usage_de_la_copropriete as string) || entry.nom_copropriete;
      entry.nb_lots_total = toInt(row.nombre_total_de_lots) ?? entry.nb_lots_total;
      entry.nb_lots_habitation = toInt(row.nombre_de_lots_a_usage_d_habitation);
      entry.nb_lots_stationnement = toInt(row.nombre_de_lots_de_stationnement);
      entry.periode_construction = (row.periode_de_construction as string) || null;
    }
  } else {
    failures.push('copro');
    console.error('[ENRICH] Requete copro en echec:', coproRes.reason?.message || coproRes.reason);
  }

  // --- Contenance cadastrale -------------------------------------------------
  if (contenanceRes.status === 'fulfilled') {
    for (const idu of unique) {
      const entry = results.get(idu);
      if (entry) entry.sources.cadastre = true;
    }
    for (const [idu, contenance] of contenanceRes.value) {
      const entry = results.get(idu);
      if (entry) entry.surface_parcelle_m2 = contenance;
    }
  } else {
    failures.push('cadastre');
    console.error(
      '[ENRICH] Requete contenance en echec:',
      contenanceRes.reason?.message || contenanceRes.reason
    );
  }

  return { results, failures };
}

/**
 * Variante compatible avec l'appelant historique : renvoie directement la Map.
 * Conservee pour ne casser aucun appel existant.
 */
export async function enrichParcelles(
  parcelleIds: string[]
): Promise<Map<string, ParcelleEnrichment>> {
  const { results } = await enrichParcellesDetailed(parcelleIds);
  return results;
}

/** Enrichit une seule parcelle. */
export async function enrichParcelle(
  parcelleId: string
): Promise<ParcelleEnrichment | null> {
  const { results } = await enrichParcellesDetailed([parcelleId]);
  return results.get(parcelleId) || null;
}
