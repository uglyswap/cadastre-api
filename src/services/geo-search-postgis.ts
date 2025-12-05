/**
 * Service de recherche géographique avec PostGIS
 * Utilise directement la table proprietaires_geo géocodée (97.99% de couverture)
 * 
 * FIX v2.4.0 - Streaming enrichit TOUS les propriétaires avec SIREN valide (plus de limite)
 */

import { pool } from './database.js';
import { enrichSiren } from './entreprises-api.js';
import {
  Proprietaire,
  ProprieteGroupee,
  EntrepriseEnrichie,
  Adresse,
  ReferenceCadastrale,
  LocalisationLocal,
} from '../types/index.js';
import {
  decodeNatureVoie,
  decodeFormeJuridique,
  formatAdresseComplete,
  normalizeNomVoie,
} from '../utils/abbreviations.js';

// Limites pour la recherche géographique
const MAX_RESULTS = 10000;
const MAX_ENRICHMENT_BATCH = 100; // Limite pour le mode NON-streaming (batch)
// Note: Le mode STREAMING n'a PAS de limite d'enrichissement

// Interface pour les résultats bruts de proprietaires_geo
interface ProprietaireGeoRaw {
  id: number;
  departement: string;
  code_commune: string;
  nom_commune: string;
  prefixe_section: string;
  section: string;
  numero_plan: string;
  numero_voirie: string;
  nature_voie: string;
  nom_voie: string;
  adresse_complete: string;
  siren: string;
  denomination: string;
  forme_juridique: string;
  ban_type: string;
  lon?: number;
  lat?: number;
}

/**
 * Convertit un polygone GeoJSON en WKT pour PostGIS
 */
function polygonToWKT(polygon: number[][]): string {
  const coords = [...polygon];
  if (coords[0][0] !== coords[coords.length - 1][0] || 
      coords[0][1] !== coords[coords.length - 1][1]) {
    coords.push(coords[0]);
  }
  
  const wktCoords = coords.map(([lon, lat]) => `${lon} ${lat}`).join(', ');
  return `POLYGON((${wktCoords}))`;
}

/**
 * Transforme un enregistrement brut en propriété formatée
 */
function transformToPropiete(raw: ProprietaireGeoRaw): {
  adresse: Adresse & { latitude?: number; longitude?: number };
  reference_cadastrale: ReferenceCadastrale;
  localisation: LocalisationLocal;
  proprietaire: Proprietaire;
} {
  const adresse: Adresse & { latitude?: number; longitude?: number } = {
    numero: raw.numero_voirie || '',
    indice_repetition: '',
    type_voie: decodeNatureVoie(raw.nature_voie),
    nom_voie: normalizeNomVoie(raw.nom_voie),
    code_postal: '',
    commune: raw.nom_commune || '',
    departement: raw.departement || '',
    adresse_complete: raw.adresse_complete || formatAdresseComplete(
      raw.numero_voirie,
      '',
      raw.nature_voie,
      raw.nom_voie,
      raw.nom_commune,
      raw.departement
    ),
    latitude: raw.lat,
    longitude: raw.lon,
  };

  const reference_cadastrale: ReferenceCadastrale = {
    departement: raw.departement || '',
    code_commune: raw.code_commune || '',
    prefixe: raw.prefixe_section || null,
    section: raw.section || '',
    numero_plan: raw.numero_plan || '',
    reference_complete: [
      raw.departement,
      raw.code_commune,
      raw.prefixe_section,
      raw.section,
      raw.numero_plan,
    ].filter(Boolean).join('-'),
  };

  const localisation: LocalisationLocal = {
    batiment: '',
    entree: '',
    niveau: '',
    porte: '',
  };

  const proprietaire: Proprietaire = {
    siren: raw.siren || '',
    denomination: raw.denomination || '',
    forme_juridique: decodeFormeJuridique(raw.forme_juridique),
    forme_juridique_code: raw.forme_juridique || '',
    groupe: '',
    groupe_code: '',
    type_droit: '',
    type_droit_code: '',
  };

  return { adresse, reference_cadastrale, localisation, proprietaire };
}

/**
 * Groupe les propriétés par adresse
 */
function groupProprietesParAdresse(proprietes: any[]): ProprieteGroupee[] {
  const grouped = new Map<string, ProprieteGroupee & { latitude?: number; longitude?: number }>();

  for (const prop of proprietes) {
    if (!prop || !prop.adresse) continue;
    
    const key = prop.adresse.adresse_complete || 'unknown';

    if (!grouped.has(key)) {
      grouped.set(key, {
        adresse: prop.adresse,
        references_cadastrales: [],
        localisations: [],
        nombre_lots: 0,
      });
    }

    const entry = grouped.get(key)!;
    const refComplete = prop.reference_cadastrale?.reference_complete;

    if (refComplete && !entry.references_cadastrales.some(r => r.reference_complete === refComplete)) {
      entry.references_cadastrales.push(prop.reference_cadastrale);
      entry.localisations.push(prop.localisation);
    }

    entry.nombre_lots++;
  }

  return Array.from(grouped.values());
}

// Types de voie à filtrer
const TYPES_VOIE = [
  'rue', 'avenue', 'av', 'boulevard', 'bd', 'impasse', 'imp', 'passage', 'pas',
  'allee', 'all', 'place', 'pl', 'square', 'sq', 'chemin', 'che', 'route', 'rte',
  'cours', 'crs', 'quai', 'voie', 'villa', 'vla', 'cite', 'residence', 'res',
  'sentier', 'sen', 'traverse', 'tra', 'hameau', 'ham', 'lotissement', 'lot'
];

/**
 * Extrait le numéro de voirie et le nom de voie depuis une adresse
 */
function extractAddressParts(adresse: string): { numero: string | null; nomVoie: string } {
  let normalized = adresse.trim();

  // Extraire le numéro au début (1-4 chiffres optionnellement suivi de bis/ter)
  let numero: string | null = null;
  const matchNumero = normalized.match(/^(\d{1,4})\s*(bis|ter|b|t)?\s+(.+)$/i);
  if (matchNumero) {
    numero = matchNumero[1].padStart(4, '0'); // Format: 0005
    normalized = matchNumero[3];
  }

  // Supprimer le type de voie s'il est au début
  const words = normalized.toLowerCase().split(/\s+/);
  if (words.length > 0 && TYPES_VOIE.includes(words[0])) {
    words.shift();
  }

  return { numero, nomVoie: words.join(' ') };
}

/**
 * Convertit un code postal en nom de commune pour Paris/Lyon/Marseille
 */
function getArrondissementName(ville: 'PARIS' | 'LYON' | 'MARSEILLE', numero: number): string {
  if (ville === 'PARIS') {
    return `PARIS ${numero.toString().padStart(2, '0')}`;
  }
  const suffix = numero === 1 ? '1ER' : `${numero}EME`;
  return `${ville} ${suffix}`;
}

/**
 * Convertit un code postal en filtre département/commune
 */
function codePostalToFilter(codePostal: string): { departement: string; communeName?: string } {
  const cp = codePostal.trim();
  if (cp.length !== 5) {
    return { departement: cp.substring(0, 2) };
  }

  const dept = cp.substring(0, 2);
  const suffix = cp.substring(2);
  const arrondNum = parseInt(suffix, 10);

  // Paris, Lyon, Marseille ont des arrondissements
  if (dept === '75' && arrondNum >= 1 && arrondNum <= 20) {
    return { departement: dept, communeName: getArrondissementName('PARIS', arrondNum) };
  }
  if (dept === '69' && arrondNum >= 1 && arrondNum <= 9) {
    return { departement: dept, communeName: getArrondissementName('LYON', arrondNum) };
  }
  if (dept === '13' && arrondNum >= 1 && arrondNum <= 16) {
    return { departement: dept, communeName: getArrondissementName('MARSEILLE', arrondNum) };
  }

  return { departement: dept };
}

/**
 * Recherche par adresse dans la table proprietaires_geo (PostGIS)
 * Cette fonction remplace searchByAddress de search.ts pour utiliser la table géocodée.
 * 
 * @param adresse - L'adresse à rechercher (ex: "5 rue de bruxelles")
 * @param departement - Code département optionnel (ex: "75")
 * @param limit - Nombre max de résultats
 * @param codePostal - Code postal optionnel (ex: "75009")
 */
export async function searchByAddressPostgis(
  adresse: string,
  departement?: string,
  limit?: number,
  codePostal?: string
): Promise<{
  resultats: Array<{
    proprietaire: Proprietaire;
    proprietes: ProprieteGroupee[];
    entreprise?: EntrepriseEnrichie;
    nombre_adresses: number;
    nombre_lots: number;
  }>;
  total_proprietaires: number;
  total_lots: number;
  debug?: {
    numero_recherche: string | null;
    nom_voie_recherche: string;
    departement: string | null;
    commune: string | null;
  };
}> {
  const maxResults = limit || 100;
  const emptyResult = { resultats: [], total_proprietaires: 0, total_lots: 0 };

  try {
    // Extraire le numéro et le nom de voie
    const { numero, nomVoie } = extractAddressParts(adresse);
    
    if (!nomVoie || nomVoie.length < 2) {
      console.log('[searchByAddressPostgis] Nom de voie trop court');
      return emptyResult;
    }

    // Traitement du code postal
    let effectiveDepartement = departement;
    let communeName: string | undefined;

    if (codePostal) {
      const cpFilter = codePostalToFilter(codePostal);
      effectiveDepartement = cpFilter.departement;
      communeName = cpFilter.communeName;
    }

    console.log(`[searchByAddressPostgis] Recherche: numero=${numero}, voie="${nomVoie}", dept=${effectiveDepartement}, commune=${communeName}`);

    // Construire la requête SQL
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let paramIndex = 1;

    // Recherche fuzzy sur le nom de voie
    const searchPattern = `%${nomVoie.split(' ').join('%')}%`;
    conditions.push(`LOWER(TRANSLATE(nom_voie, 'àâäéèêëïîôùûüç', 'aaaeeeeiioouuc')) ILIKE $${paramIndex}`);
    params.push(searchPattern);
    paramIndex++;

    // Filtre par numéro de voirie (avec variantes de padding)
    if (numero) {
      // Recherche le numéro avec différents formats possibles
      conditions.push(`(numero_voirie = $${paramIndex} OR numero_voirie = $${paramIndex + 1} OR LTRIM(numero_voirie, '0') = $${paramIndex + 2})`);
      params.push(numero); // Format paddé: 0005
      params.push(numero.replace(/^0+/, '')); // Format sans padding: 5
      params.push(numero.replace(/^0+/, '')); // Pour LTRIM: 5
      paramIndex += 3;
    }

    // Filtre par département
    if (effectiveDepartement) {
      conditions.push(`departement = $${paramIndex}`);
      params.push(effectiveDepartement);
      paramIndex++;
    }

    // Filtre par nom de commune (pour les arrondissements)
    if (communeName) {
      conditions.push(`UPPER(nom_commune) = $${paramIndex}`);
      params.push(communeName);
      paramIndex++;
    }

    // Ajouter le LIMIT
    params.push(maxResults * 10); // On récupère plus pour grouper ensuite

    const query = `
      SELECT 
        id,
        departement,
        code_commune,
        nom_commune,
        prefixe_section,
        section,
        numero_plan,
        numero_voirie,
        nature_voie,
        nom_voie,
        adresse_complete,
        siren,
        denomination,
        forme_juridique,
        ban_type,
        ST_X(geom) as lon,
        ST_Y(geom) as lat
      FROM proprietaires_geo
      WHERE ${conditions.join(' AND ')}
      LIMIT $${paramIndex}
    `;

    console.log(`[searchByAddressPostgis] Query avec ${conditions.length} conditions`);

    const result = await pool.query(query, params);
    console.log(`[searchByAddressPostgis] ${result.rows.length} lignes trouvées`);

    if (result.rows.length === 0) {
      return {
        ...emptyResult,
        debug: {
          numero_recherche: numero,
          nom_voie_recherche: nomVoie,
          departement: effectiveDepartement || null,
          commune: communeName || null,
        },
      };
    }

    // Grouper par propriétaire (SIREN ou dénomination)
    const proprietairesMap = new Map<string, {
      proprietaire: Proprietaire;
      proprietes: any[];
      sirens: Set<string>;
    }>();

    for (const raw of result.rows) {
      const propriete = transformToPropiete(raw);
      const key = raw.siren || raw.denomination || 'inconnu';

      if (!proprietairesMap.has(key)) {
        proprietairesMap.set(key, {
          proprietaire: propriete.proprietaire,
          proprietes: [],
          sirens: new Set(),
        });
      }

      const entry = proprietairesMap.get(key)!;
      entry.proprietes.push(propriete);
      if (raw.siren) entry.sirens.add(raw.siren);
    }

    // Limiter au nombre de propriétaires demandé
    const proprietairesLimites = Array.from(proprietairesMap.entries()).slice(0, maxResults);

    // Enrichir avec API Entreprises et construire les résultats
    const resultats: Array<{
      proprietaire: Proprietaire;
      proprietes: ProprieteGroupee[];
      entreprise?: EntrepriseEnrichie;
      nombre_adresses: number;
      nombre_lots: number;
    }> = [];

    let enrichmentCount = 0;

    for (const [_, value] of proprietairesLimites) {
      let entreprise: EntrepriseEnrichie | undefined;
      const sirens = Array.from(value.sirens);

      // Mode batch: limite à MAX_ENRICHMENT_BATCH
      if (sirens.length > 0 && sirens[0].length === 9 && enrichmentCount < MAX_ENRICHMENT_BATCH) {
        try {
          const enriched = await enrichSiren(sirens[0]);
          if (enriched) {
            entreprise = enriched;
            enrichmentCount++;
          }
        } catch (e) {
          // Ignorer les erreurs d'enrichissement
        }
      }

      const proprietesGroupees = groupProprietesParAdresse(value.proprietes);

      resultats.push({
        proprietaire: value.proprietaire,
        proprietes: proprietesGroupees,
        entreprise,
        nombre_adresses: proprietesGroupees.length,
        nombre_lots: value.proprietes.length,
      });
    }

    console.log(`[searchByAddressPostgis] ${resultats.length} propriétaires retournés`);

    return {
      resultats,
      total_proprietaires: resultats.length,
      total_lots: result.rows.length,
      debug: {
        numero_recherche: numero,
        nom_voie_recherche: nomVoie,
        departement: effectiveDepartement || null,
        commune: communeName || null,
      },
    };
  } catch (error) {
    console.error('[searchByAddressPostgis] Erreur:', error);
    return emptyResult;
  }
}

/**
 * Type pour le résultat d'un propriétaire individuel (streaming)
 */
export interface ProprietaireResult {
  proprietaire: Proprietaire;
  proprietes: ProprieteGroupee[];
  entreprise?: EntrepriseEnrichie;
  nombre_adresses: number;
  nombre_lots: number;
  coordonnees?: { lat: number; lon: number };
}

/**
 * Type pour le callback de streaming
 */
export type StreamCallback = (result: ProprietaireResult, index: number, total: number) => void;

/**
 * Recherche par polygone avec STREAMING PROGRESSIF
 * Envoie chaque propriétaire dès qu'il est enrichi via le callback
 * 
 * v2.4.0: PLUS DE LIMITE D'ENRICHISSEMENT - tous les propriétaires avec SIREN valide sont enrichis
 * 
 * @param polygon - Array de coordonnées [[lon, lat], ...] format GeoJSON
 * @param limit - Nombre max de PROPRIETAIRES uniques (défaut: 5000)
 * @param onResult - Callback appelé pour chaque propriétaire enrichi
 */
export async function searchByPolygonStreaming(
  polygon: number[][],
  limit: number = 5000,
  onResult: StreamCallback
): Promise<{
  total_proprietaires: number;
  total_dans_polygone: number;
  total_lots: number;
  enriched_count: number;
  wkt: string;
  query_time_ms: number;
}> {
  const emptyResult = {
    total_proprietaires: 0,
    total_dans_polygone: 0,
    total_lots: 0,
    enriched_count: 0,
    wkt: '',
    query_time_ms: 0,
  };

  let wkt = '';
  
  try {
    console.log(`[geo-search-postgis] STREAMING v2.4.0 - Recherche dans polygone (${polygon.length} points), limit=${limit}, enrichissement=ILLIMITE`);

    // Validation du polygone
    if (!polygon || !Array.isArray(polygon) || polygon.length < 3) {
      console.warn('[geo-search-postgis] Polygone invalide');
      return emptyResult;
    }

    const effectiveLimit = Math.min(limit, MAX_RESULTS);
    wkt = polygonToWKT(polygon);
    
    console.log(`[geo-search-postgis] WKT généré: ${wkt.substring(0, 100)}...`);

    // ETAPE 1: Compter le VRAI nombre de propriétaires uniques dans le polygone
    const countQuery = `
      SELECT 
        COUNT(DISTINCT COALESCE(NULLIF(siren, ''), denomination)) as unique_proprietaires,
        COUNT(*) as total_lignes
      FROM proprietaires_geo
      WHERE geom IS NOT NULL
        AND ST_Within(geom, ST_GeomFromText($1, 4326))
    `;
    
    const countResult = await pool.query(countQuery, [wkt]);
    const totalDansPolygone = parseInt(countResult.rows[0].unique_proprietaires) || 0;
    const totalLignes = parseInt(countResult.rows[0].total_lignes) || 0;
    
    console.log(`[geo-search-postgis] COUNT: ${totalDansPolygone} propriétaires uniques, ${totalLignes} lignes`);

    if (totalDansPolygone === 0) {
      console.log('[geo-search-postgis] Aucun résultat');
      return emptyResult;
    }

    // ETAPE 2: Récupérer les données en limitant par PROPRIETAIRE UNIQUE
    const queryStart = Date.now();
    
    const query = `
      WITH proprietaires_uniques AS (
        SELECT DISTINCT COALESCE(NULLIF(siren, ''), denomination) as proprio_key
        FROM proprietaires_geo
        WHERE geom IS NOT NULL
          AND ST_Within(geom, ST_GeomFromText($1, 4326))
        LIMIT $2
      )
      SELECT 
        p.id,
        p.departement,
        p.code_commune,
        p.nom_commune,
        p.prefixe_section,
        p.section,
        p.numero_plan,
        p.numero_voirie,
        p.nature_voie,
        p.nom_voie,
        p.adresse_complete,
        p.siren,
        p.denomination,
        p.forme_juridique,
        p.ban_type,
        ST_X(p.geom) as lon,
        ST_Y(p.geom) as lat
      FROM proprietaires_geo p
      WHERE p.geom IS NOT NULL
        AND ST_Within(p.geom, ST_GeomFromText($1, 4326))
        AND COALESCE(NULLIF(p.siren, ''), p.denomination) IN (SELECT proprio_key FROM proprietaires_uniques)
    `;

    const result = await pool.query(query, [wkt, effectiveLimit]);
    const queryTime = Date.now() - queryStart;
    
    console.log(`[geo-search-postgis] ${result.rows.length} lignes pour ${effectiveLimit} propriétaires max en ${queryTime}ms`);

    // Grouper par propriétaire
    const proprietairesMap = new Map<string, {
      proprietaire: Proprietaire;
      proprietes: any[];
      sirens: Set<string>;
      coords: { lat: number; lon: number } | null;
    }>();

    for (const raw of result.rows) {
      const propriete = transformToPropiete(raw);
      const key = raw.siren || raw.denomination || 'inconnu';

      if (!proprietairesMap.has(key)) {
        proprietairesMap.set(key, {
          proprietaire: propriete.proprietaire,
          proprietes: [],
          sirens: new Set(),
          coords: raw.lat && raw.lon ? { lat: raw.lat, lon: raw.lon } : null,
        });
      }

      const entry = proprietairesMap.get(key)!;
      entry.proprietes.push(propriete);
      if (raw.siren) entry.sirens.add(raw.siren);
    }

    const totalProprietaires = proprietairesMap.size;
    let enrichmentCount = 0;
    let index = 0;

    // ETAPE 3: Enrichir et envoyer chaque propriétaire via le callback
    // v2.4.0: PLUS DE LIMITE - on enrichit TOUS les propriétaires avec SIREN valide
    for (const [_, value] of proprietairesMap) {
      let entreprise: EntrepriseEnrichie | undefined;
      const sirens = Array.from(value.sirens);

      // Enrichissement SIREN pour TOUS les propriétaires avec SIREN valide (9 chiffres)
      if (sirens.length > 0 && sirens[0].length === 9) {
        try {
          const enriched = await enrichSiren(sirens[0]);
          if (enriched) {
            entreprise = enriched;
            enrichmentCount++;
          }
        } catch (e) {
          // Ignorer les erreurs d'enrichissement
          console.log(`[geo-search-postgis] Erreur enrichissement SIREN ${sirens[0]}: ${e}`);
        }
      }

      const proprietesGroupees = groupProprietesParAdresse(value.proprietes);

      // Envoyer le résultat via callback IMMEDIATEMENT après enrichissement
      const proprietaireResult: ProprietaireResult = {
        proprietaire: value.proprietaire,
        proprietes: proprietesGroupees,
        entreprise,
        nombre_adresses: proprietesGroupees.length,
        nombre_lots: value.proprietes.length,
        coordonnees: value.coords || undefined,
      };

      onResult(proprietaireResult, index, totalProprietaires);
      index++;
    }

    console.log(`[geo-search-postgis] Streaming terminé: ${totalProprietaires} propriétaires, ${enrichmentCount} enrichis sur ${totalProprietaires}`);

    return {
      total_proprietaires: totalProprietaires,
      total_dans_polygone: totalDansPolygone,
      total_lots: result.rows.length,
      enriched_count: enrichmentCount,
      wkt,
      query_time_ms: queryTime,
    };
  } catch (error) {
    console.error('[geo-search-postgis] Erreur streaming:', error);
    throw error;
  }
}

/**
 * Recherche les propriétaires dans un polygone géographique
 * Utilise PostGIS ST_Within pour une recherche directe et performante
 * 
 * FIX v5: Le limit s'applique maintenant aux PROPRIETAIRES UNIQUES, pas aux lignes SQL
 * Note: Ce mode BATCH garde une limite d'enrichissement pour éviter les timeouts
 * 
 * @param polygon - Array de coordonnées [[lon, lat], ...] format GeoJSON
 * @param limit - Nombre max de PROPRIETAIRES uniques (défaut: 5000)
 */
export async function searchByPolygon(
  polygon: number[][],
  limit: number = 5000
): Promise<{
  resultats: Array<{
    proprietaire: Proprietaire;
    proprietes: ProprieteGroupee[];
    entreprise?: EntrepriseEnrichie;
    nombre_adresses: number;
    nombre_lots: number;
    coordonnees?: { lat: number; lon: number };
  }>;
  total_proprietaires: number;
  total_dans_polygone: number; // NOUVEAU: nombre réel de propriétaires dans le polygone
  total_lots: number;
  adresses_ban_trouvees: number;
  adresses_matchees: number;
  limites_appliquees: {
    max_resultats: number;
    max_enrichissement: number;
  };
  mode: string;
  debug?: {
    wkt: string;
    error?: string;
    query_time_ms?: number;
    count_time_ms?: number;
  };
}> {
  const emptyResult = {
    resultats: [],
    total_proprietaires: 0,
    total_dans_polygone: 0,
    total_lots: 0,
    adresses_ban_trouvees: 0,
    adresses_matchees: 0,
    limites_appliquees: {
      max_resultats: Math.min(limit, MAX_RESULTS),
      max_enrichissement: MAX_ENRICHMENT_BATCH,
    },
    mode: 'postgis_direct_v2.4.0',
  };

  let wkt = '';
  
  try {
    console.log(`[geo-search-postgis] BATCH v2.4.0 - Recherche dans polygone (${polygon.length} points), limit=${limit} propriétaires`);

    // Validation du polygone
    if (!polygon || !Array.isArray(polygon) || polygon.length < 3) {
      console.warn('[geo-search-postgis] Polygone invalide');
      return { ...emptyResult, debug: { wkt: '', error: 'Polygone invalide (moins de 3 points)' } };
    }

    const effectiveLimit = Math.min(limit, MAX_RESULTS);
    wkt = polygonToWKT(polygon);
    
    console.log(`[geo-search-postgis] WKT généré: ${wkt}`);

    // ETAPE 1: Compter le VRAI nombre de propriétaires uniques dans le polygone
    const countStart = Date.now();
    const countQuery = `
      SELECT 
        COUNT(DISTINCT COALESCE(NULLIF(siren, ''), denomination)) as unique_proprietaires,
        COUNT(*) as total_lignes
      FROM proprietaires_geo
      WHERE geom IS NOT NULL
        AND ST_Within(geom, ST_GeomFromText($1, 4326))
    `;
    
    const countResult = await pool.query(countQuery, [wkt]);
    const countTime = Date.now() - countStart;
    
    const totalDansPolygone = parseInt(countResult.rows[0].unique_proprietaires) || 0;
    const totalLignes = parseInt(countResult.rows[0].total_lignes) || 0;
    
    console.log(`[geo-search-postgis] COUNT: ${totalDansPolygone} propriétaires uniques, ${totalLignes} lignes en ${countTime}ms`);

    if (totalDansPolygone === 0) {
      console.log('[geo-search-postgis] Aucun résultat');
      return { 
        ...emptyResult, 
        debug: { 
          wkt, 
          error: 'Aucun propriétaire trouvé dans le polygone',
          count_time_ms: countTime 
        } 
      };
    }

    // ETAPE 2: Récupérer les données en limitant par PROPRIETAIRE UNIQUE
    const queryStart = Date.now();
    
    const query = `
      WITH proprietaires_uniques AS (
        SELECT DISTINCT COALESCE(NULLIF(siren, ''), denomination) as proprio_key
        FROM proprietaires_geo
        WHERE geom IS NOT NULL
          AND ST_Within(geom, ST_GeomFromText($1, 4326))
        LIMIT $2
      )
      SELECT 
        p.id,
        p.departement,
        p.code_commune,
        p.nom_commune,
        p.prefixe_section,
        p.section,
        p.numero_plan,
        p.numero_voirie,
        p.nature_voie,
        p.nom_voie,
        p.adresse_complete,
        p.siren,
        p.denomination,
        p.forme_juridique,
        p.ban_type,
        ST_X(p.geom) as lon,
        ST_Y(p.geom) as lat
      FROM proprietaires_geo p
      WHERE p.geom IS NOT NULL
        AND ST_Within(p.geom, ST_GeomFromText($1, 4326))
        AND COALESCE(NULLIF(p.siren, ''), p.denomination) IN (SELECT proprio_key FROM proprietaires_uniques)
    `;

    const result = await pool.query(query, [wkt, effectiveLimit]);
    const queryTime = Date.now() - queryStart;
    
    console.log(`[geo-search-postgis] ${result.rows.length} lignes pour ${effectiveLimit} propriétaires max en ${queryTime}ms`);

    // Grouper par propriétaire
    const proprietairesMap = new Map<string, {
      proprietaire: Proprietaire;
      proprietes: any[];
      sirens: Set<string>;
      coords: { lat: number; lon: number } | null;
    }>();

    for (const raw of result.rows) {
      const propriete = transformToPropiete(raw);
      const key = raw.siren || raw.denomination || 'inconnu';

      if (!proprietairesMap.has(key)) {
        proprietairesMap.set(key, {
          proprietaire: propriete.proprietaire,
          proprietes: [],
          sirens: new Set(),
          coords: raw.lat && raw.lon ? { lat: raw.lat, lon: raw.lon } : null,
        });
      }

      const entry = proprietairesMap.get(key)!;
      entry.proprietes.push(propriete);
      if (raw.siren) entry.sirens.add(raw.siren);
    }

    // Enrichir avec API Entreprises (limité pour le mode BATCH pour éviter timeout)
    const resultats: Array<{
      proprietaire: Proprietaire;
      proprietes: ProprieteGroupee[];
      entreprise?: EntrepriseEnrichie;
      nombre_adresses: number;
      nombre_lots: number;
      coordonnees?: { lat: number; lon: number };
    }> = [];

    let enrichmentCount = 0;
    
    for (const [_, value] of proprietairesMap) {
      let entreprise: EntrepriseEnrichie | undefined;
      const sirens = Array.from(value.sirens);

      // Mode BATCH: limite à MAX_ENRICHMENT_BATCH pour éviter timeout
      if (sirens.length > 0 && sirens[0].length === 9 && enrichmentCount < MAX_ENRICHMENT_BATCH) {
        try {
          const enriched = await enrichSiren(sirens[0]);
          if (enriched) {
            entreprise = enriched;
            enrichmentCount++;
          }
        } catch (e) {
          // Ignorer les erreurs d'enrichissement
        }
      }

      const proprietesGroupees = groupProprietesParAdresse(value.proprietes);

      resultats.push({
        proprietaire: value.proprietaire,
        proprietes: proprietesGroupees,
        entreprise,
        nombre_adresses: proprietesGroupees.length,
        nombre_lots: value.proprietes.length,
        coordonnees: value.coords || undefined,
      });
    }

    console.log(`[geo-search-postgis] ${resultats.length} propriétaires retournés sur ${totalDansPolygone} dans le polygone`);

    return {
      resultats,
      total_proprietaires: resultats.length,
      total_dans_polygone: totalDansPolygone, // Le VRAI total dans le polygone
      total_lots: result.rows.length,
      adresses_ban_trouvees: result.rows.length,
      adresses_matchees: result.rows.length,
      limites_appliquees: {
        max_resultats: effectiveLimit,
        max_enrichissement: MAX_ENRICHMENT_BATCH,
      },
      mode: 'postgis_direct_v2.4.0',
      debug: {
        wkt,
        query_time_ms: queryTime,
        count_time_ms: countTime,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Erreur inconnue';
    console.error('[geo-search-postgis] Erreur critique:', error);
    return { 
      ...emptyResult, 
      debug: { 
        wkt, 
        error: errorMessage 
      } 
    };
  }
}

/**
 * Retourne les statistiques de géocodage
 */
export async function getGeoStats(): Promise<{
  total_proprietaires: number;
  proprietaires_geocodes: number;
  pourcentage_geocode: number;
  par_type: Record<string, number>;
  postgis_installed: boolean;
  mode: string;
}> {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total,
        COUNT(geom) as geocoded,
        ROUND(100.0 * COUNT(geom) / COUNT(*), 2) as pct
      FROM proprietaires_geo
    `);

    const byType = await pool.query(`
      SELECT ban_type, COUNT(*) as cnt
      FROM proprietaires_geo
      WHERE geom IS NOT NULL
      GROUP BY ban_type
      ORDER BY cnt DESC
    `);

    const parType: Record<string, number> = {};
    for (const row of byType.rows) {
      parType[row.ban_type || 'unknown'] = parseInt(row.cnt);
    }

    return {
      total_proprietaires: parseInt(stats.rows[0].total),
      proprietaires_geocodes: parseInt(stats.rows[0].geocoded),
      pourcentage_geocode: parseFloat(stats.rows[0].pct),
      par_type: parType,
      postgis_installed: true,
      mode: 'postgis_direct_v2.4.0',
    };
  } catch (error) {
    console.error('[geo-search-postgis] Erreur getGeoStats:', error);
    return {
      total_proprietaires: 0,
      proprietaires_geocodes: 0,
      pourcentage_geocode: 0,
      par_type: {},
      postgis_installed: false,
      mode: 'error',
    };
  }
}

/**
 * Recherche par rayon autour d'un point
 */
export async function searchByRadius(
  lon: number,
  lat: number,
  radiusMeters: number = 500,
  limit: number = 1000
): Promise<{
  resultats: Array<{
    proprietaire: Proprietaire;
    proprietes: ProprieteGroupee[];
    entreprise?: EntrepriseEnrichie;
    distance_metres: number;
  }>;
  total_proprietaires: number;
  total_lots: number;
  limites_appliquees: {
    max_resultats: number;
    max_enrichissement: number;
  };
}> {
  const emptyResult = {
    resultats: [],
    total_proprietaires: 0,
    total_lots: 0,
    limites_appliquees: {
      max_resultats: Math.min(limit, MAX_RESULTS),
      max_enrichissement: MAX_ENRICHMENT_BATCH,
    },
  };

  try {
    const effectiveLimit = Math.min(limit, MAX_RESULTS);
    
    // Requête avec limite par propriétaire unique
    const query = `
      WITH proprietaires_uniques AS (
        SELECT DISTINCT COALESCE(NULLIF(siren, ''), denomination) as proprio_key
        FROM proprietaires_geo
        WHERE geom IS NOT NULL
          AND ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
        LIMIT $4
      )
      SELECT 
        p.id,
        p.departement,
        p.code_commune,
        p.nom_commune,
        p.prefixe_section,
        p.section,
        p.numero_plan,
        p.numero_voirie,
        p.nature_voie,
        p.nom_voie,
        p.adresse_complete,
        p.siren,
        p.denomination,
        p.forme_juridique,
        p.ban_type,
        ST_X(p.geom) as lon,
        ST_Y(p.geom) as lat,
        ST_Distance(p.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) as distance
      FROM proprietaires_geo p
      WHERE p.geom IS NOT NULL
        AND ST_DWithin(p.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
        AND COALESCE(NULLIF(p.siren, ''), p.denomination) IN (SELECT proprio_key FROM proprietaires_uniques)
      ORDER BY distance
    `;

    const result = await pool.query(query, [lon, lat, radiusMeters, effectiveLimit]);

    if (result.rows.length === 0) {
      return emptyResult;
    }

    // Grouper par propriétaire
    const proprietairesMap = new Map<string, {
      proprietaire: Proprietaire;
      proprietes: any[];
      distance: number;
      sirens: Set<string>;
    }>();

    for (const raw of result.rows) {
      const propriete = transformToPropiete(raw);
      const key = raw.siren || raw.denomination || 'inconnu';

      if (!proprietairesMap.has(key)) {
        proprietairesMap.set(key, {
          proprietaire: propriete.proprietaire,
          proprietes: [],
          distance: raw.distance,
          sirens: new Set(),
        });
      }

      const entry = proprietairesMap.get(key)!;
      entry.proprietes.push(propriete);
      if (raw.siren) entry.sirens.add(raw.siren);
    }

    const resultats = [];
    let enrichCount = 0;
    let totalLots = 0;

    for (const [_, value] of proprietairesMap) {
      let entreprise: EntrepriseEnrichie | undefined;
      const sirens = Array.from(value.sirens);

      if (sirens.length > 0 && sirens[0].length === 9 && enrichCount < MAX_ENRICHMENT_BATCH) {
        try {
          const enriched = await enrichSiren(sirens[0]);
          if (enriched) {
            entreprise = enriched;
            enrichCount++;
          }
        } catch (e) {}
      }

      totalLots += value.proprietes.length;

      resultats.push({
        proprietaire: value.proprietaire,
        proprietes: groupProprietesParAdresse(value.proprietes),
        entreprise,
        distance_metres: Math.round(value.distance),
      });
    }

    return {
      resultats,
      total_proprietaires: resultats.length,
      total_lots: totalLots,
      limites_appliquees: {
        max_resultats: effectiveLimit,
        max_enrichissement: MAX_ENRICHMENT_BATCH,
      },
    };
  } catch (error) {
    console.error('[geo-search-postgis] Erreur searchByRadius:', error);
    return emptyResult;
  }
}
