/**
 * Service de recherche par SIREN et par dénomination
 * v2.5.0 - Réécrit pour utiliser proprietaires_geo (22M+ lignes géocodées)
 * Les anciennes tables pm_25_b et pb_25_b n'existent plus
 */

import { pool } from './database.js';
import {
  decodeNatureVoie,
  decodeFormeJuridique,
  formatAdresseComplete,
  normalizeNomVoie,
} from '../utils/abbreviations.js';
import { enrichSiren } from './entreprises-api.js';
import {
  Proprietaire,
  ProprieteGroupee,
  Adresse,
  ReferenceCadastrale,
  LocalisationLocal,
  EntrepriseEnrichie,
} from '../types/index.js';
import { config } from '../config/index.js';

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
 * Transforme un enregistrement brut de proprietaires_geo en propriété formatée
 */
function transformGeoToPropiete(raw: ProprietaireGeoRaw): {
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
 * Groupe les propriétés par adresse (déduplique)
 */
function groupProprietesParAdresse(proprietes: ReturnType<typeof transformGeoToPropiete>[]): ProprieteGroupee[] {
  const grouped = new Map<string, ProprieteGroupee>();

  for (const prop of proprietes) {
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

    // Vérifier si cette référence cadastrale est déjà présente
    const refComplete = prop.reference_cadastrale.reference_complete;
    const refExists = entry.references_cadastrales.some(
      r => r.reference_complete === refComplete
    );

    if (!refExists) {
      entry.references_cadastrales.push(prop.reference_cadastrale);
      entry.localisations.push(prop.localisation);
    }

    entry.nombre_lots++;
  }

  return Array.from(grouped.values());
}

/**
 * Recherche par SIREN dans proprietaires_geo
 * Requête directe sur la table géocodée (22M+ lignes, index sur siren)
 */
export async function searchBySiren(
  siren: string,
  departement?: string
): Promise<{
  proprietaire?: Proprietaire;
  entreprise?: EntrepriseEnrichie;
  proprietes: ProprieteGroupee[];
  nombre_adresses: number;
  nombre_lots: number;
  departements_concernes: string[];
}> {
  const emptyResult = { proprietes: [], nombre_adresses: 0, nombre_lots: 0, departements_concernes: [] };

  if (!siren || siren.length !== 9) {
    return emptyResult;
  }

  try {
    const conditions: string[] = ['siren = $1'];
    const params: (string | number)[] = [siren];
    let paramIndex = 2;

    if (departement) {
      conditions.push(`departement = $${paramIndex}`);
      params.push(departement);
      paramIndex++;
    }

    // Limiter à 10000 résultats max
    params.push(10000);

    const query = `
      SELECT 
        id, departement, code_commune, nom_commune,
        prefixe_section, section, numero_plan,
        numero_voirie, nature_voie, nom_voie, adresse_complete,
        siren, denomination, forme_juridique, ban_type,
        ST_X(geom) as lon, ST_Y(geom) as lat
      FROM proprietaires_geo
      WHERE ${conditions.join(' AND ')}
      LIMIT $${paramIndex}
    `;

    console.log(`[searchBySiren] Recherche SIREN ${siren}${departement ? ` dept=${departement}` : ''}`);
    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      console.log(`[searchBySiren] Aucun résultat pour SIREN ${siren}`);
      return emptyResult;
    }

    console.log(`[searchBySiren] ${result.rows.length} résultats trouvés`);

    // Transformer les résultats
    const proprietes = result.rows.map((row: ProprietaireGeoRaw) => transformGeoToPropiete(row));
    const proprietaire = proprietes[0].proprietaire;

    // Départements concernés
    const departementsSet = new Set<string>();
    for (const row of result.rows) {
      if (row.departement) departementsSet.add(row.departement);
    }

    // Enrichir avec API Entreprises
    const entreprise = await enrichSiren(siren) || undefined;

    // Grouper les propriétés par adresse
    const proprietesGroupees = groupProprietesParAdresse(proprietes);

    return {
      proprietaire,
      entreprise,
      proprietes: proprietesGroupees,
      nombre_adresses: proprietesGroupees.length,
      nombre_lots: result.rows.length,
      departements_concernes: Array.from(departementsSet).sort(),
    };
  } catch (error) {
    console.error('[searchBySiren] Erreur:', error);
    return emptyResult;
  }
}

/**
 * Recherche par dénomination (nom du propriétaire) dans proprietaires_geo
 * Insensible à la casse, aux accents et aux espaces
 */
export async function searchByDenomination(
  denomination: string,
  departement?: string,
  limit?: number
): Promise<{
  resultats: Array<{
    proprietaire: Proprietaire;
    entreprise?: EntrepriseEnrichie;
    proprietes: ProprieteGroupee[];
    nombre_adresses: number;
    nombre_lots: number;
    departements_concernes: string[];
  }>;
  total_proprietaires: number;
  total_lots: number;
}> {
  const emptyResult = { resultats: [], total_proprietaires: 0, total_lots: 0 };
  const maxResults = limit || config.search.maxLimit;

  if (!denomination || denomination.trim().length < 2) {
    return emptyResult;
  }

  try {
    // Normaliser la recherche : supprimer accents, espaces multiples, insensible casse
    const normalized = denomination.trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Supprime accents
      .replace(/[^a-zA-Z0-9\s]/g, ' ') // Garde alphanumérique + espaces
      .replace(/\s+/g, ' ')            // Normalise espaces
      .trim();

    const searchTerms = normalized.split(' ').filter(t => t.length >= 2);

    if (searchTerms.length === 0) {
      return emptyResult;
    }

    // Construire le pattern de recherche : chaque terme séparé par %
    // Cela permet de trouver "SCI TRINITY" même si on cherche "TRINITY" ou "SCI TRINITY"
    const searchPattern = `%${searchTerms.join('%')}%`;

    const conditions: string[] = [
      `LOWER(TRANSLATE(denomination, 'àâäéèêëïîôùûüçÀÂÄÉÈÊËÏÎÔÙÛÜÇ', 'aaaeeeeiioouucaaaeeeeiioouuc')) ILIKE $1`
    ];
    const params: (string | number)[] = [searchPattern.toLowerCase()];
    let paramIndex = 2;

    if (departement) {
      conditions.push(`departement = $${paramIndex}`);
      params.push(departement);
      paramIndex++;
    }

    // On récupère plus de résultats pour pouvoir grouper ensuite
    params.push(maxResults * 10);

    const query = `
      SELECT 
        id, departement, code_commune, nom_commune,
        prefixe_section, section, numero_plan,
        numero_voirie, nature_voie, nom_voie, adresse_complete,
        siren, denomination, forme_juridique, ban_type,
        ST_X(geom) as lon, ST_Y(geom) as lat
      FROM proprietaires_geo
      WHERE ${conditions.join(' AND ')}
      LIMIT $${paramIndex}
    `;

    console.log(`[searchByDenomination] Recherche "${denomination}"${departement ? ` dept=${departement}` : ''}`);
    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      console.log(`[searchByDenomination] Aucun résultat pour "${denomination}"`);
      return emptyResult;
    }

    console.log(`[searchByDenomination] ${result.rows.length} lignes trouvées`);

    // Grouper par propriétaire (SIREN ou dénomination)
    // FIX: Utiliser l'id de la ligne comme clé fallback au lieu de 'inconnu'
    // pour éviter de grouper des propriétés sans SIREN sous une même clé
    const groupedMap = new Map<string, {
      rows: ProprietaireGeoRaw[];
      sirens: Set<string>;
      departements: Set<string>;
    }>();

    for (const raw of result.rows) {
      const key = raw.siren || raw.denomination || `no-siren-${raw.id}`;

      if (!groupedMap.has(key)) {
        groupedMap.set(key, { rows: [], sirens: new Set(), departements: new Set() });
      }

      const entry = groupedMap.get(key)!;
      entry.rows.push(raw);
      if (raw.siren) entry.sirens.add(raw.siren);
      if (raw.departement) entry.departements.add(raw.departement);
    }

    // Transformer et enrichir
    const resultats: Array<{
      proprietaire: Proprietaire;
      entreprise?: EntrepriseEnrichie;
      proprietes: ProprieteGroupee[];
      nombre_adresses: number;
      nombre_lots: number;
      departements_concernes: string[];
    }> = [];

    for (const [_, value] of groupedMap) {
      if (resultats.length >= maxResults) break;

      const proprietes = value.rows.map((row: ProprietaireGeoRaw) => transformGeoToPropiete(row));
      const proprietaire = proprietes[0].proprietaire;

      // Enrichir si SIREN disponible
      let entreprise: EntrepriseEnrichie | undefined;
      const sirens = Array.from(value.sirens);
      if (sirens.length > 0 && sirens[0].length === 9) {
        const enriched = await enrichSiren(sirens[0]);
        if (enriched) entreprise = enriched;
      }

      // Grouper les propriétés par adresse
      const proprietesGroupees = groupProprietesParAdresse(proprietes);

      resultats.push({
        proprietaire,
        entreprise,
        proprietes: proprietesGroupees,
        nombre_adresses: proprietesGroupees.length,
        nombre_lots: value.rows.length,
        departements_concernes: Array.from(value.departements).sort(),
      });
    }

    return {
      resultats,
      total_proprietaires: resultats.length,
      total_lots: result.rows.length,
    };
  } catch (error) {
    console.error('[searchByDenomination] Erreur:', error);
    return emptyResult;
  }
}
