/**
 * Service de recherche géographique
 * Utilise l'API externe BAN (api-adresse.data.gouv.fr)
 * pour trouver les propriétaires dans un polygone
 * 
 * IMPORTANT: Le réseau a un timeout de ~50s, donc on doit
 * terminer le traitement en moins de 30s pour être sûr.
 */

import { pool } from './database.js';
import { resolveTablesForDepartment } from '../utils/table-resolver.js';
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

// Interface pour les réponses de l'API BAN
interface BanReverseResponse {
  type: string;
  version: string;
  features: Array<{
    type: string;
    geometry: {
      type: string;
      coordinates: [number, number];
    };
    properties: {
      label: string;
      score: number;
      housenumber?: string;
      id: string;
      name: string;
      postcode: string;
      citycode: string;
      x: number;
      y: number;
      city: string;
      context: string;
      type: string;
      importance: number;
      street?: string;
    };
  }>;
}

// Interface pour les adresses normalisées
interface NormalizedAddress {
  id: string;
  numero: string;
  nom_voie: string;
  nom_voie_normalized: string;
  code_postal: string;
  code_commune: string;
  nom_commune: string;
  departement: string;
  lon: number;
  lat: number;
}

// Délai entre les appels API (en ms) pour respecter les limites (50 req/sec max)
const API_RATE_LIMIT_DELAY = 20;

// Limites TRES strictes pour garantir une réponse en <30s
// Le réseau a un timeout de ~50s qu'on ne peut pas changer
const MAX_GRID_SIZE = 6; // 6x6 = 36 points max
const MAX_SAMPLED_POINTS = 10; // Max 10 appels BAN par requête (~200ms)
const MAX_MAJIC_RESULTS = 200; // Max 200 propriétés MAJIC
const MAX_COMMUNES = 3; // Max 3 départements traités

// Fonction pour attendre
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Vérifie si un point est dans un polygone (ray casting algorithm)
function pointInPolygon(point: [number, number], polygon: number[][]): boolean {
  try {
    const [x, y] = point;
    let inside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];

      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }

    return inside;
  } catch (error) {
    console.warn('[geo-search] Erreur pointInPolygon:', error);
    return false;
  }
}

// Calcule le bounding box d'un polygone
function getBoundingBox(polygon: number[][]): { minLon: number; maxLon: number; minLat: number; maxLat: number } {
  let minLon = Infinity, maxLon = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;

  for (const [lon, lat] of polygon) {
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }

  return { minLon, maxLon, minLat, maxLat };
}

// Génère une grille de points à l'intérieur du polygone
function generateGridPoints(polygon: number[][], gridSize: number = 10): Array<[number, number]> {
  try {
    const { minLon, maxLon, minLat, maxLat } = getBoundingBox(polygon);
    const points: Array<[number, number]> = [];

    const lonStep = (maxLon - minLon) / gridSize;
    const latStep = (maxLat - minLat) / gridSize;

    for (let i = 0; i <= gridSize; i++) {
      for (let j = 0; j <= gridSize; j++) {
        const lon = minLon + (lonStep * i);
        const lat = minLat + (latStep * j);
        const point: [number, number] = [lon, lat];

        if (pointInPolygon(point, polygon)) {
          points.push(point);
        }
      }
    }

    // Ajouter le centroïde
    const centroidLon = (minLon + maxLon) / 2;
    const centroidLat = (minLat + maxLat) / 2;
    if (pointInPolygon([centroidLon, centroidLat], polygon)) {
      points.push([centroidLon, centroidLat]);
    }

    return points;
  } catch (error) {
    console.warn('[geo-search] Erreur generateGridPoints:', error);
    return [];
  }
}

// Appelle l'API BAN reverse pour un point (timeout court)
async function reverseGeocode(lon: number, lat: number): Promise<NormalizedAddress[]> {
  try {
    const url = `https://api-adresse.data.gouv.fr/reverse/?lon=${lon}&lat=${lat}&limit=3`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout
    
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return [];
    }

    const text = await response.text();
    if (!text || text.trim() === '') {
      return [];
    }

    let data: BanReverseResponse;
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      return [];
    }

    if (!data.features || !Array.isArray(data.features)) {
      return [];
    }

    return data.features.map(feature => {
      const props = feature.properties || {};
      const coords = feature.geometry?.coordinates || [lon, lat];
      const dept = props.postcode?.substring(0, 2) || '';

      return {
        id: props.id || `${lon}-${lat}`,
        numero: props.housenumber || '',
        nom_voie: props.street || props.name || '',
        nom_voie_normalized: normalizeVoieForMatching(props.street || props.name || ''),
        code_postal: props.postcode || '',
        code_commune: props.citycode || '',
        nom_commune: props.city || '',
        departement: dept,
        lon: coords[0],
        lat: coords[1],
      };
    });
  } catch (error: any) {
    return [];
  }
}

// Normalise un nom de voie pour le matching
function normalizeVoieForMatching(voie: string): string {
  if (!voie) return '';
  try {
    return voie
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/^(RUE|AVENUE|BOULEVARD|IMPASSE|PLACE|ALLEE|CHEMIN|ROUTE|PASSAGE|SQUARE|COURS|QUAI|VOIE|CITE|RESIDENCE|LOTISSEMENT)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return voie;
  }
}

// Normalise un nom de commune pour le matching
function normalizeCommuneForMatching(commune: string): string {
  if (!commune) return '';
  try {
    return commune
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return commune;
  }
}

// Récupère les adresses BAN dans un polygone via l'API externe
async function getBanAddressesInPolygon(
  polygon: number[][]
): Promise<NormalizedAddress[]> {
  try {
    const { minLon, maxLon, minLat, maxLat } = getBoundingBox(polygon);
    const width = maxLon - minLon;
    const height = maxLat - minLat;

    // Grille très limitée (max 6x6)
    const gridSize = Math.min(MAX_GRID_SIZE, Math.max(3, Math.ceil(Math.sqrt(width * height) * 30)));

    const gridPoints = generateGridPoints(polygon, gridSize);

    if (gridPoints.length === 0) {
      return [];
    }

    // Limiter strictement le nombre de points
    const maxPoints = Math.min(MAX_SAMPLED_POINTS, gridPoints.length);
    const selectedPoints = gridPoints.slice(0, maxPoints);

    const allAddresses: NormalizedAddress[] = [];
    const seenIds = new Set<string>();

    for (const [lon, lat] of selectedPoints) {
      try {
        const addresses = await reverseGeocode(lon, lat);

        for (const addr of addresses) {
          if (addr.id && !seenIds.has(addr.id)) {
            seenIds.add(addr.id);
            allAddresses.push(addr);
          }
        }
      } catch (error) {
        // Ignorer les erreurs
      }

      // Rate limiting
      await sleep(API_RATE_LIMIT_DELAY);
    }

    return allAddresses;
  } catch (error) {
    console.error('[geo-search] Erreur getBanAddressesInPolygon:', error);
    return [];
  }
}

// Trouve les propriétaires MAJIC correspondant aux adresses BAN
async function findMajicProprietaires(
  banAddresses: NormalizedAddress[]
): Promise<Array<LocalRaw & { ban_lon: number; ban_lat: number }>> {
  if (banAddresses.length === 0) return [];

  try {
    // Grouper par département
    const byDepartement = new Map<string, NormalizedAddress[]>();
    for (const addr of banAddresses) {
      const dept = addr.departement;
      if (dept && dept.length >= 2) {
        if (!byDepartement.has(dept)) {
          byDepartement.set(dept, []);
        }
        byDepartement.get(dept)!.push(addr);
      }
    }

    const results: Array<LocalRaw & { ban_lon: number; ban_lat: number }> = [];

    let deptCount = 0;
    for (const [dept, addresses] of byDepartement) {
      if (results.length >= MAX_MAJIC_RESULTS || deptCount >= MAX_COMMUNES) break;
      deptCount++;

      let tables: string[] = [];
      try {
        tables = await resolveTablesForDepartment(dept);
      } catch (error) {
        continue;
      }
      
      if (tables.length === 0) continue;

      const table = tables[0];
      
      for (const addr of addresses) {
        if (results.length >= MAX_MAJIC_RESULTS) break;

        try {
          const numeroFormatted = addr.numero ? addr.numero.padStart(4, '0') : null;
          const voieNormalized = normalizeVoieForMatching(addr.nom_voie);
          const communeNormalized = normalizeCommuneForMatching(addr.nom_commune);

          let query = `
            SELECT *, $1::float as ban_lon, $2::float as ban_lat
            FROM "${table}"
            WHERE 1=1
          `;
          const params: any[] = [addr.lon, addr.lat];
          let paramIndex = 3;

          if (numeroFormatted) {
            query += ` AND "n°_voirie" = $${paramIndex}`;
            params.push(numeroFormatted);
            paramIndex++;
          }

          if (voieNormalized.length >= 3) {
            query += ` AND UPPER(TRANSLATE(nom_voie, 'àâäéèêëïîôùûüç', 'aaaeeeeiioouuc')) ILIKE $${paramIndex}`;
            params.push(`%${voieNormalized}%`);
            paramIndex++;
          }

          if (communeNormalized.length >= 2) {
            query += ` AND UPPER(TRANSLATE(nom_de_la_commune, 'àâäéèêëïîôùûüç-', 'aaaeeeeiioouuc ')) ILIKE $${paramIndex}`;
            params.push(`%${communeNormalized.substring(0, 20)}%`);
            paramIndex++;
          }

          query += ` LIMIT $${paramIndex}`;
          params.push(Math.min(10, MAX_MAJIC_RESULTS - results.length));

          const result = await pool.query(query, params);
          if (result.rows && result.rows.length > 0) {
            results.push(...result.rows);
          }
        } catch (error) {
          // Ignorer les erreurs
        }
      }
    }

    return results;
  } catch (error) {
    console.error('[geo-search] Erreur findMajicProprietaires:', error);
    return [];
  }
}

// Transforme un enregistrement brut en propriété formatée
function transformToPropiete(
  raw: LocalRaw & { ban_lon?: number; ban_lat?: number }
): {
  adresse: Adresse & { latitude?: number; longitude?: number };
  reference_cadastrale: ReferenceCadastrale;
  localisation: LocalisationLocal;
  proprietaire: Proprietaire;
} | null {
  try {
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
  } catch (error) {
    return null;
  }
}

// Groupe les propriétés par adresse
function groupProprietesParAdresse(proprietes: any[]): ProprieteGroupee[] {
  try {
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
  } catch (error) {
    return [];
  }
}

/**
 * Recherche les propriétaires dans un polygone géographique
 * Utilise l'API externe BAN (api-adresse.data.gouv.fr)
 * 
 * LIMITES STRICTES pour garantir une réponse en <30s:
 * - Max 10 points BAN interrogés
 * - Max 200 propriétés MAJIC retournées
 * - Max 3 départements traités
 * - Pas d'enrichissement SIREN (trop lent)
 * 
 * Pour les grandes zones, divisez en plusieurs petits polygones
 */
export async function searchByPolygon(
  polygon: number[][],
  limit: number = 10000
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
  limites_appliquees: {
    max_points_ban: number;
    max_resultats_majic: number;
    max_departements: number;
  };
}> {
  const emptyResult = {
    resultats: [],
    total_proprietaires: 0,
    total_lots: 0,
    adresses_ban_trouvees: 0,
    adresses_matchees: 0,
    limites_appliquees: {
      max_points_ban: MAX_SAMPLED_POINTS,
      max_resultats_majic: MAX_MAJIC_RESULTS,
      max_departements: MAX_COMMUNES,
    },
  };

  try {
    // Validation du polygone
    if (!polygon || !Array.isArray(polygon) || polygon.length < 3) {
      return emptyResult;
    }

    // 1. Récupérer les adresses via API BAN externe
    const banAddresses = await getBanAddressesInPolygon(polygon);

    if (banAddresses.length === 0) {
      return emptyResult;
    }

    // 2. Matcher avec les propriétaires MAJIC
    const majicResults = await findMajicProprietaires(banAddresses);

    // 3. Grouper par propriétaire
    const proprietairesMap = new Map<string, {
      proprietaire: Proprietaire;
      proprietes: any[];
      coords: { lat: number; lon: number } | null;
    }>();

    for (const raw of majicResults) {
      try {
        const propriete = transformToPropiete(raw);
        if (!propriete) continue;

        const key = raw['n°_siren'] || raw.dénomination || 'inconnu';

        if (!proprietairesMap.has(key)) {
          proprietairesMap.set(key, {
            proprietaire: propriete.proprietaire,
            proprietes: [],
            coords: raw.ban_lat && raw.ban_lon ? { lat: raw.ban_lat, lon: raw.ban_lon } : null,
          });
        }

        const entry = proprietairesMap.get(key)!;
        entry.proprietes.push(propriete);
      } catch (error) {
        // Ignorer
      }
    }

    // 4. Construire les résultats (SANS enrichissement SIREN - trop lent)
    const resultats: Array<{
      proprietaire: Proprietaire;
      proprietes: ProprieteGroupee[];
      entreprise?: EntrepriseEnrichie;
      nombre_adresses: number;
      nombre_lots: number;
      coordonnees?: { lat: number; lon: number };
    }> = [];

    let count = 0;
    const maxResultats = Math.min(limit, 50);
    
    for (const [_, value] of proprietairesMap) {
      if (count >= maxResultats) break;

      try {
        const proprietesGroupees = groupProprietesParAdresse(value.proprietes);

        resultats.push({
          proprietaire: value.proprietaire,
          proprietes: proprietesGroupees,
          nombre_adresses: proprietesGroupees.length,
          nombre_lots: value.proprietes.length,
          coordonnees: value.coords || undefined,
        });

        count++;
      } catch (error) {
        // Ignorer
      }
    }

    return {
      resultats,
      total_proprietaires: resultats.length,
      total_lots: majicResults.length,
      adresses_ban_trouvees: banAddresses.length,
      adresses_matchees: majicResults.length,
      limites_appliquees: {
        max_points_ban: MAX_SAMPLED_POINTS,
        max_resultats_majic: MAX_MAJIC_RESULTS,
        max_departements: MAX_COMMUNES,
      },
    };
  } catch (error) {
    console.error('[geo-search] Erreur critique searchByPolygon:', error);
    return emptyResult;
  }
}

/**
 * Retourne les statistiques de la recherche géo
 */
export async function getBanStats(): Promise<{
  total_adresses: number;
  adresses_geolocalisees: number;
  derniere_maj: string | null;
  postgis_installed: boolean;
  mode: string;
}> {
  return {
    total_adresses: 0,
    adresses_geolocalisees: 0,
    derniere_maj: null,
    postgis_installed: false,
    mode: 'api_externe',
  };
}
