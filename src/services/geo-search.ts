/**
 * Service de recherche géographique
 * Utilise la BAN (Base Adresse Nationale) avec PostGIS
 * pour trouver les propriétaires dans un polygone
 */

import { pool } from './database.js';
import { resolveAllTables, resolveTablesForDepartment } from '../utils/table-resolver.js';
import { enrichSiren } from './entreprises-api.js';
import {
  LocalRaw,
  Proprietaire,
  ProprieteGroupee,
  EntrepriseEnrichie,
  Adresse,
  ReferenceCadastrale,
  LocalisationLocal,
} from '../types/index.js';
import {
  decodeNatureVoie,
  decodeCodeDroit,
  decodeGroupePersonne,
  decodeFormeJuridique,
  formatAdresseComplete,
  normalizeNomVoie,
} from '../utils/abbreviations.js';

// Convertit un polygone [[lng, lat], ...] en WKT
function polygonToWKT(polygon: number[][]): string {
  const coords = [...polygon];
  // Fermer le polygone si nécessaire
  if (coords[0][0] !== coords[coords.length - 1][0] || 
      coords[0][1] !== coords[coords.length - 1][1]) {
    coords.push(coords[0]);
  }
  const coordsStr = coords.map(p => `${p[0]} ${p[1]}`).join(', ');
  return `POLYGON((${coordsStr}))`;
}

// Normalise un nom de voie pour le matching
function normalizeVoieForMatching(voie: string): string {
  if (!voie) return '';
  return voie
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^(RUE|AVENUE|BOULEVARD|IMPASSE|PLACE|ALLEE|CHEMIN|ROUTE|PASSAGE|SQUARE|COURS|QUAI|VOIE|CITE|RESIDENCE|LOTISSEMENT)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalise un nom de commune pour le matching
function normalizeCommuneForMatching(commune: string): string {
  if (!commune) return '';
  return commune
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Récupère les adresses BAN dans un polygone
async function getBanAddressesInPolygon(
  polygonWKT: string,
  limit: number = 500
): Promise<Array<{
  id: string;
  numero: string;
  rep: string;
  nom_voie: string;
  nom_voie_normalized: string;
  code_postal: string;
  code_commune: string;
  nom_commune: string;
  departement: string;
  lon: number;
  lat: number;
}>> {
  const query = `
    SELECT 
      id,
      numero,
      rep,
      nom_voie,
      nom_voie_normalized,
      code_postal,
      code_commune,
      nom_commune,
      SUBSTRING(code_postal FROM 1 FOR 2) as departement,
      lon,
      lat
    FROM ban_adresses
    WHERE geom IS NOT NULL
      AND ST_Contains(
        ST_GeomFromText($1, 4326),
        geom
      )
    LIMIT $2
  `;

  try {
    const result = await pool.query(query, [polygonWKT, limit]);
    return result.rows;
  } catch (error: any) {
    // Si PostGIS n'est pas disponible, retourner une erreur claire
    if (error.code === '42883' || error.message?.includes('st_contains')) {
      throw new Error('PostGIS non installé. Exécutez scripts/setup-ban.sql');
    }
    throw error;
  }
}

// Trouve les propriétaires MAJIC correspondant aux adresses BAN
async function findMajicProprietaires(
  banAddresses: Array<{
    numero: string;
    nom_voie: string;
    nom_voie_normalized: string;
    nom_commune: string;
    departement: string;
    lon: number;
    lat: number;
  }>,
  limit: number = 200
): Promise<Array<LocalRaw & { ban_lon: number; ban_lat: number }>> {
  if (banAddresses.length === 0) return [];

  // Grouper par département pour optimiser les requêtes
  const byDepartement = new Map<string, typeof banAddresses>();
  for (const addr of banAddresses) {
    const dept = addr.departement;
    if (!byDepartement.has(dept)) {
      byDepartement.set(dept, []);
    }
    byDepartement.get(dept)!.push(addr);
  }

  const results: Array<LocalRaw & { ban_lon: number; ban_lat: number }> = [];

  for (const [dept, addresses] of byDepartement) {
    if (results.length >= limit) break;

    const tables = await resolveTablesForDepartment(dept);
    if (tables.length === 0) continue;

    for (const table of tables) {
      if (results.length >= limit) break;

      // Construire une requête avec matching fuzzy
      for (const addr of addresses.slice(0, 50)) { // Limiter par adresse pour éviter les requêtes trop longues
        if (results.length >= limit) break;

        const numeroFormatted = addr.numero ? addr.numero.padStart(4, '0') : null;
        const voieNormalized = normalizeVoieForMatching(addr.nom_voie);
        const communeNormalized = normalizeCommuneForMatching(addr.nom_commune);

        // Requête de matching
        let query = `
          SELECT *, $1::float as ban_lon, $2::float as ban_lat
          FROM "${table}"
          WHERE 1=1
        `;
        const params: any[] = [addr.lon, addr.lat];
        let paramIndex = 3;

        // Matching par numéro de voirie (si disponible)
        if (numeroFormatted) {
          query += ` AND "n°_voirie" = $${paramIndex}`;
          params.push(numeroFormatted);
          paramIndex++;
        }

        // Matching par nom de voie (fuzzy avec similarité)
        if (voieNormalized.length >= 3) {
          query += ` AND (
            UPPER(TRANSLATE(nom_voie, 'àâäéèêëïîôùûüç', 'aaaeeeeiioouuc')) ILIKE $${paramIndex}
            OR SIMILARITY(UPPER(TRANSLATE(nom_voie, 'àâäéèêëïîôùûüç', 'aaaeeeeiioouuc')), $${paramIndex + 1}) > 0.3
          )`;
          params.push(`%${voieNormalized}%`, voieNormalized);
          paramIndex += 2;
        }

        // Matching par commune
        if (communeNormalized.length >= 2) {
          query += ` AND UPPER(TRANSLATE(nom_de_la_commune, 'àâäéèêëïîôùûüç-', 'aaaeeeeiioouuc ')) ILIKE $${paramIndex}`;
          params.push(`%${communeNormalized.substring(0, 20)}%`);
          paramIndex++;
        }

        query += ` LIMIT $${paramIndex}`;
        params.push(Math.min(10, limit - results.length));

        try {
          const result = await pool.query(query, params);
          results.push(...result.rows);
        } catch (error) {
          // Ignorer les erreurs de similarité si pg_trgm n'est pas installé
          // et réessayer sans similarité
          try {
            const simpleQuery = `
              SELECT *, $1::float as ban_lon, $2::float as ban_lat
              FROM "${table}"
              WHERE "n°_voirie" = $3
                AND UPPER(TRANSLATE(nom_voie, 'àâäéèêëïîôùûüç', 'aaaeeeeiioouuc')) ILIKE $4
              LIMIT 5
            `;
            const simpleResult = await pool.query(simpleQuery, [
              addr.lon,
              addr.lat,
              numeroFormatted || '',
              `%${voieNormalized}%`
            ]);
            results.push(...simpleResult.rows);
          } catch {
            // Ignorer silencieusement
          }
        }
      }
    }
  }

  return results;
}

// Transforme un enregistrement brut en propriété formatée
function transformToPropiete(
  raw: LocalRaw & { ban_lon?: number; ban_lat?: number }
): {
  adresse: Adresse & { latitude?: number; longitude?: number };
  reference_cadastrale: ReferenceCadastrale;
  localisation: LocalisationLocal;
  proprietaire: Proprietaire;
} {
  const adresse: Adresse & { latitude?: number; longitude?: number } = {
    numero: raw['n°_voirie'] || '',
    indice_repetition: raw.indice_de_répétition || '',
    type_voie: decodeNatureVoie(raw.nature_voie),
    nom_voie: normalizeNomVoie(raw.nom_voie),
    code_postal: '',
    commune: raw.nom_de_la_commune || '',
    departement: raw.département || '',
    adresse_complete: formatAdresseComplete(
      raw['n°_voirie'],
      raw.indice_de_répétition,
      raw.nature_voie,
      raw.nom_voie,
      raw.nom_de_la_commune,
      raw.département
    ),
    latitude: raw.ban_lat,
    longitude: raw.ban_lon,
  };

  const reference_cadastrale: ReferenceCadastrale = {
    departement: raw.département || '',
    code_commune: raw.code_commune || '',
    prefixe: raw.préfixe || null,
    section: raw.section || '',
    numero_plan: raw['n°_plan'] || '',
    reference_complete: [
      raw.département,
      raw.code_commune,
      raw.préfixe,
      raw.section,
      raw['n°_plan'],
    ].filter(Boolean).join('-'),
  };

  const localisation: LocalisationLocal = {
    batiment: raw.bâtiment || '',
    entree: raw.entrée || '',
    niveau: raw.niveau || '',
    porte: raw.porte || '',
  };

  const proprietaire: Proprietaire = {
    siren: raw['n°_siren'] || '',
    denomination: raw.dénomination || '',
    forme_juridique: decodeFormeJuridique(raw.forme_juridique_abrégée),
    forme_juridique_code: raw.forme_juridique_abrégée || '',
    groupe: decodeGroupePersonne(raw.groupe_personne),
    groupe_code: raw.groupe_personne || '',
    type_droit: decodeCodeDroit(raw.code_droit),
    type_droit_code: raw.code_droit || '',
  };

  return { adresse, reference_cadastrale, localisation, proprietaire };
}

// Groupe les propriétés par adresse
function groupProprietesParAdresse(proprietes: any[]): ProprieteGroupee[] {
  const grouped = new Map<string, ProprieteGroupee & { latitude?: number; longitude?: number }>();

  for (const prop of proprietes) {
    const key = prop.adresse.adresse_complete;

    if (!grouped.has(key)) {
      grouped.set(key, {
        adresse: prop.adresse,
        references_cadastrales: [],
        localisations: [],
        nombre_lots: 0,
      });
    }

    const entry = grouped.get(key)!;
    const refComplete = prop.reference_cadastrale.reference_complete;

    if (!entry.references_cadastrales.some(r => r.reference_complete === refComplete)) {
      entry.references_cadastrales.push(prop.reference_cadastrale);
      entry.localisations.push(prop.localisation);
    }

    entry.nombre_lots++;
  }

  return Array.from(grouped.values());
}

/**
 * Recherche les propriétaires dans un polygone géographique
 */
export async function searchByPolygon(
  polygon: number[][],
  limit: number = 100
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
  total_lots: number;
  adresses_ban_trouvees: number;
  adresses_matchees: number;
}> {
  console.log(`[geo-search] Recherche dans polygone (${polygon.length} points), limit=${limit}`);

  // 1. Convertir le polygone en WKT
  const polygonWKT = polygonToWKT(polygon);

  // 2. Récupérer les adresses BAN dans le polygone
  const banAddresses = await getBanAddressesInPolygon(polygonWKT, limit * 5);
  console.log(`[geo-search] ${banAddresses.length} adresses BAN trouvées`);

  if (banAddresses.length === 0) {
    return {
      resultats: [],
      total_proprietaires: 0,
      total_lots: 0,
      adresses_ban_trouvees: 0,
      adresses_matchees: 0,
    };
  }

  // 3. Matcher avec les propriétaires MAJIC
  const majicResults = await findMajicProprietaires(banAddresses, limit * 3);
  console.log(`[geo-search] ${majicResults.length} propriétés MAJIC matchées`);

  // 4. Grouper par propriétaire
  const proprietairesMap = new Map<string, {
    proprietaire: Proprietaire;
    proprietes: any[];
    sirens: Set<string>;
    coords: { lat: number; lon: number } | null;
  }>();

  for (const raw of majicResults) {
    const propriete = transformToPropiete(raw);
    const key = raw['n°_siren'] || raw.dénomination || 'inconnu';

    if (!proprietairesMap.has(key)) {
      proprietairesMap.set(key, {
        proprietaire: propriete.proprietaire,
        proprietes: [],
        sirens: new Set(),
        coords: raw.ban_lat && raw.ban_lon ? { lat: raw.ban_lat, lon: raw.ban_lon } : null,
      });
    }

    const entry = proprietairesMap.get(key)!;
    entry.proprietes.push(propriete);
    if (raw['n°_siren']) entry.sirens.add(raw['n°_siren']);
  }

  // 5. Enrichir avec API Entreprises et construire les résultats
  const resultats: Array<{
    proprietaire: Proprietaire;
    proprietes: ProprieteGroupee[];
    entreprise?: EntrepriseEnrichie;
    nombre_adresses: number;
    nombre_lots: number;
    coordonnees?: { lat: number; lon: number };
  }> = [];

  let count = 0;
  for (const [_, value] of proprietairesMap) {
    if (count >= limit) break;

    let entreprise: EntrepriseEnrichie | undefined;
    const sirens = Array.from(value.sirens);

    if (sirens.length > 0 && sirens[0].length === 9) {
      try {
        const enriched = await enrichSiren(sirens[0]);
        if (enriched) entreprise = enriched;
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

    count++;
  }

  return {
    resultats,
    total_proprietaires: resultats.length,
    total_lots: majicResults.length,
    adresses_ban_trouvees: banAddresses.length,
    adresses_matchees: majicResults.length,
  };
}

/**
 * Retourne les statistiques de la table BAN
 */
export async function getBanStats(): Promise<{
  total_adresses: number;
  adresses_geolocalisees: number;
  derniere_maj: string | null;
  postgis_installed: boolean;
}> {
  try {
    // Vérifier PostGIS
    let postgisInstalled = false;
    try {
      await pool.query('SELECT PostGIS_Version()');
      postgisInstalled = true;
    } catch {
      postgisInstalled = false;
    }

    // Compter les adresses
    let totalAdresses = 0;
    let adressesGeo = 0;
    let derniereMaj: string | null = null;

    try {
      const countResult = await pool.query('SELECT COUNT(*) FROM ban_adresses');
      totalAdresses = parseInt(countResult.rows[0].count) || 0;

      const geoResult = await pool.query('SELECT COUNT(*) FROM ban_adresses WHERE geom IS NOT NULL');
      adressesGeo = parseInt(geoResult.rows[0].count) || 0;

      const majResult = await pool.query('SELECT MAX(updated_at) as last_update FROM ban_adresses');
      derniereMaj = majResult.rows[0]?.last_update || null;
    } catch {
      // Table n'existe pas encore
    }

    return {
      total_adresses: totalAdresses,
      adresses_geolocalisees: adressesGeo,
      derniere_maj: derniereMaj,
      postgis_installed: postgisInstalled,
    };
  } catch (error) {
    return {
      total_adresses: 0,
      adresses_geolocalisees: 0,
      derniere_maj: null,
      postgis_installed: false,
    };
  }
}
