/**
 * Service de recherche géographique
 * Utilise l'API externe BAN (api-adresse.data.gouv.fr)
 * pour trouver les propriétaires dans un polygone
 */

import { pool } from './database.js';
import { resolveTablesForDepartment } from '../utils/table-resolver.js';
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

// Appelle l'API BAN reverse pour un point
async function reverseGeocode(lon: number, lat: number): Promise<NormalizedAddress[]> {
  try {
    const url = `https://api-adresse.data.gouv.fr/reverse/?lon=${lon}&lat=${lat}&limit=10`;
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
    
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[geo-search] API BAN erreur ${response.status} pour ${lon},${lat}`);
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
      console.warn(`[geo-search] Erreur parsing JSON BAN pour ${lon},${lat}`);
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
    if (error.name === 'AbortError') {
      console.warn(`[geo-search] Timeout API BAN pour ${lon},${lat}`);
    } else {
      console.warn(`[geo-search] Erreur API BAN pour ${lon},${lat}:`, error.message || error);
    }
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
  polygon: number[][],
  limit: number = 10000
): Promise<NormalizedAddress[]> {
  try {
    console.log(`[geo-search] Génération de la grille de points...`);

    // Calculer la taille de grille en fonction de la surface du polygone
    const { minLon, maxLon, minLat, maxLat } = getBoundingBox(polygon);
    const width = maxLon - minLon;
    const height = maxLat - minLat;

    // Plus le polygone est grand, plus la grille est dense (jusqu'à 25x25 = 625 points)
    const gridSize = Math.min(25, Math.max(5, Math.ceil(Math.sqrt(width * height) * 150)));

    const gridPoints = generateGridPoints(polygon, gridSize);
    console.log(`[geo-search] ${gridPoints.length} points de grille générés`);

    if (gridPoints.length === 0) {
      console.warn('[geo-search] Aucun point de grille généré');
      return [];
    }

    // Plus de limite stricte sur les points - on prend tout
    const maxPoints = Math.min(200, gridPoints.length);
    const selectedPoints = gridPoints.slice(0, maxPoints);

    const allAddresses: NormalizedAddress[] = [];
    const seenIds = new Set<string>();

    console.log(`[geo-search] Interrogation de l'API BAN pour ${selectedPoints.length} points...`);

    let successCount = 0;
    let errorCount = 0;

    for (const [lon, lat] of selectedPoints) {
      try {
        const addresses = await reverseGeocode(lon, lat);

        for (const addr of addresses) {
          if (addr.id && !seenIds.has(addr.id)) {
            seenIds.add(addr.id);
            allAddresses.push(addr);
          }
        }
        successCount++;
      } catch (error) {
        errorCount++;
        console.warn(`[geo-search] Erreur point ${lon},${lat}:`, error);
      }

      // Rate limiting (50 req/sec)
      await sleep(API_RATE_LIMIT_DELAY);
    }

    console.log(`[geo-search] ${allAddresses.length} adresses uniques trouvées via API BAN (${successCount} succès, ${errorCount} erreurs)`);
    return allAddresses;
  } catch (error) {
    console.error('[geo-search] Erreur getBanAddressesInPolygon:', error);
    return [];
  }
}

// Trouve les propriétaires MAJIC correspondant aux adresses BAN
async function findMajicProprietaires(
  banAddresses: NormalizedAddress[],
  limit: number = 10000
): Promise<Array<LocalRaw & { ban_lon: number; ban_lat: number }>> {
  if (banAddresses.length === 0) return [];

  try {
    // Grouper par département pour optimiser les requêtes
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

    for (const [dept, addresses] of byDepartement) {
      if (results.length >= limit) break;

      let tables: string[] = [];
      try {
        tables = await resolveTablesForDepartment(dept);
      } catch (error) {
        console.warn(`[geo-search] Erreur résolution tables pour ${dept}:`, error);
        continue;
      }
      
      if (tables.length === 0) continue;

      for (const table of tables) {
        if (results.length >= limit) break;

        // Traiter toutes les adresses du département
        for (const addr of addresses) {
          if (results.length >= limit) break;

          try {
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

            // Matching par nom de voie (fuzzy)
            if (voieNormalized.length >= 3) {
              query += ` AND UPPER(TRANSLATE(nom_voie, 'àâäéèêëïîôùûüç', 'aaaeeeeiioouuc')) ILIKE $${paramIndex}`;
              params.push(`%${voieNormalized}%`);
              paramIndex++;
            }

            // Matching par commune
            if (communeNormalized.length >= 2) {
              query += ` AND UPPER(TRANSLATE(nom_de_la_commune, 'àâäéèêëïîôùûüç-', 'aaaeeeeiioouuc ')) ILIKE $${paramIndex}`;
              params.push(`%${communeNormalized.substring(0, 20)}%`);
              paramIndex++;
            }

            query += ` LIMIT $${paramIndex}`;
            params.push(Math.min(50, limit - results.length));

            const result = await pool.query(query, params);
            if (result.rows && result.rows.length > 0) {
              results.push(...result.rows);
            }
          } catch (error) {
            // Ignorer les erreurs et continuer
            console.warn(`[geo-search] Erreur requête MAJIC:`, error);
          }
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
    console.warn('[geo-search] Erreur transformToPropiete:', error);
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
    console.warn('[geo-search] Erreur groupProprietesParAdresse:', error);
    return [];
  }
}

/**
 * Recherche les propriétaires dans un polygone géographique
 * Utilise l'API externe BAN (api-adresse.data.gouv.fr)
 * Pas de limite par défaut - prend tout ce qui est trouvé
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
}> {
  // Résultat vide par défaut en cas d'erreur
  const emptyResult = {
    resultats: [],
    total_proprietaires: 0,
    total_lots: 0,
    adresses_ban_trouvees: 0,
    adresses_matchees: 0,
  };

  try {
    console.log(`[geo-search] Recherche dans polygone (${polygon.length} points), limit=${limit}`);

    // Validation du polygone
    if (!polygon || !Array.isArray(polygon) || polygon.length < 3) {
      console.warn('[geo-search] Polygone invalide');
      return emptyResult;
    }

    // 1. Récupérer les adresses via API BAN externe
    const banAddresses = await getBanAddressesInPolygon(polygon, limit * 5);
    console.log(`[geo-search] ${banAddresses.length} adresses BAN trouvées`);

    if (banAddresses.length === 0) {
      return emptyResult;
    }

    // 2. Matcher avec les propriétaires MAJIC
    const majicResults = await findMajicProprietaires(banAddresses, limit * 3);
    console.log(`[geo-search] ${majicResults.length} propriétés MAJIC matchées`);

    // 3. Grouper par propriétaire
    const proprietairesMap = new Map<string, {
      proprietaire: Proprietaire;
      proprietes: any[];
      sirens: Set<string>;
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
            sirens: new Set(),
            coords: raw.ban_lat && raw.ban_lon ? { lat: raw.ban_lat, lon: raw.ban_lon } : null,
          });
        }

        const entry = proprietairesMap.get(key)!;
        entry.proprietes.push(propriete);
        if (raw['n°_siren']) entry.sirens.add(raw['n°_siren']);
      } catch (error) {
        console.warn('[geo-search] Erreur traitement propriété:', error);
      }
    }

    // 4. Enrichir avec API Entreprises et construire les résultats
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

      try {
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
      } catch (error) {
        console.warn('[geo-search] Erreur construction résultat:', error);
      }
    }

    return {
      resultats,
      total_proprietaires: resultats.length,
      total_lots: majicResults.length,
      adresses_ban_trouvees: banAddresses.length,
      adresses_matchees: majicResults.length,
    };
  } catch (error) {
    console.error('[geo-search] Erreur critique searchByPolygon:', error);
    return emptyResult;
  }
}

/**
 * Retourne les statistiques de la recherche géo
 * Plus besoin de table BAN locale
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
