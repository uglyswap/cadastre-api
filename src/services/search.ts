import { pool } from './database.js';
import { resolveTablesForDepartment, resolveAllTables } from '../utils/table-resolver.js';
import {
  decodeNatureVoie,
  decodeCodeDroit,
  decodeGroupePersonne,
  decodeFormeJuridique,
  formatAdresseComplete,
  normalizeNomVoie,
} from '../utils/abbreviations.js';
import { enrichSiren } from './entreprises-api.js';
import {
  LocalRaw,
  Propriete,
  Adresse,
  ReferenceCadastrale,
  LocalisationLocal,
  Proprietaire,
  EntrepriseEnrichie,
} from '../types/index.js';
import { config } from '../config/index.js';

// Normalise une chaîne pour la recherche fuzzy
function normalizeForSearch(str: string): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Supprime les accents
    .replace(/[^a-z0-9\s]/g, ' ')    // Garde uniquement alphanumérique
    .replace(/\s+/g, ' ')            // Normalise les espaces
    .trim();
}

// Transforme un enregistrement brut en Propriete formatée
function transformToPropiete(raw: LocalRaw): Propriete {
  const adresse: Adresse = {
    numero: raw['n°_voirie'] || '',
    indice_repetition: raw.indice_de_répétition || '',
    type_voie: decodeNatureVoie(raw.nature_voie),
    nom_voie: normalizeNomVoie(raw.nom_voie),
    code_postal: '', // Non disponible dans les données
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

// Recherche par adresse
export async function searchByAddress(
  adresse: string,
  departement?: string,
  limit?: number
): Promise<{
  proprietaires: Map<string, { proprietaire: Proprietaire; proprietes: Propriete[]; entreprise?: EntrepriseEnrichie }>;
  total: number;
}> {
  const maxResults = limit || config.search.maxLimit;
  const normalizedSearch = normalizeForSearch(adresse);
  const searchTerms = normalizedSearch.split(' ').filter(t => t.length >= 2);

  if (searchTerms.length === 0) {
    return { proprietaires: new Map(), total: 0 };
  }

  // Déterminer les tables à interroger
  let tables: string[];
  if (departement) {
    tables = await resolveTablesForDepartment(departement);
  } else {
    tables = await resolveAllTables();
  }

  if (tables.length === 0) {
    return { proprietaires: new Map(), total: 0 };
  }

  // Construire la requête avec recherche fuzzy sur le nom de voie
  const results: LocalRaw[] = [];
  const searchPattern = `%${searchTerms.join('%')}%`;

  for (const table of tables) {
    if (results.length >= maxResults) break;

    const remainingLimit = maxResults - results.length;

    // Recherche fuzzy: ILIKE sur nom_voie normalisé
    const query = `
      SELECT *
      FROM "${table}"
      WHERE LOWER(TRANSLATE(nom_voie, 'àâäéèêëïîôùûüç', 'aaaeeeeiioouuc')) ILIKE $1
      LIMIT $2
    `;

    try {
      const result = await pool.query(query, [searchPattern, remainingLimit]);
      results.push(...result.rows);
    } catch (error) {
      console.error(`Erreur lors de la recherche dans ${table}:`, error);
    }
  }

  // Grouper par propriétaire (SIREN ou dénomination)
  const proprietairesMap = new Map<string, { proprietaire: Proprietaire; proprietes: Propriete[]; sirens: Set<string> }>();

  for (const raw of results) {
    const propriete = transformToPropiete(raw);
    const key = raw['n°_siren'] || raw.dénomination || 'inconnu';

    if (!proprietairesMap.has(key)) {
      proprietairesMap.set(key, {
        proprietaire: propriete.proprietaire,
        proprietes: [],
        sirens: new Set(),
      });
    }

    const entry = proprietairesMap.get(key)!;
    entry.proprietes.push(propriete);
    if (raw['n°_siren']) {
      entry.sirens.add(raw['n°_siren']);
    }
  }

  // Enrichir avec API Entreprises
  const enrichedMap = new Map<string, { proprietaire: Proprietaire; proprietes: Propriete[]; entreprise?: EntrepriseEnrichie }>();

  for (const [key, value] of proprietairesMap) {
    let entreprise: EntrepriseEnrichie | undefined;

    // Enrichir si on a un SIREN valide
    const sirens = Array.from(value.sirens);
    if (sirens.length > 0 && sirens[0].length === 9) {
      const enriched = await enrichSiren(sirens[0]);
      if (enriched) entreprise = enriched;
    }

    enrichedMap.set(key, {
      proprietaire: value.proprietaire,
      proprietes: value.proprietes,
      entreprise,
    });
  }

  return { proprietaires: enrichedMap, total: results.length };
}

// Recherche par propriétaire (SIREN)
export async function searchBySiren(
  siren: string,
  departement?: string
): Promise<{
  proprietaire?: Proprietaire;
  entreprise?: EntrepriseEnrichie;
  proprietes: Propriete[];
  departements_concernes: string[];
}> {
  if (!siren || siren.length !== 9) {
    return { proprietes: [], departements_concernes: [] };
  }

  // Déterminer les tables à interroger
  let tables: string[];
  if (departement) {
    tables = await resolveTablesForDepartment(departement);
  } else {
    tables = await resolveAllTables();
  }

  const results: LocalRaw[] = [];
  const departementsSet = new Set<string>();

  for (const table of tables) {
    const query = `SELECT * FROM "${table}" WHERE "n°_siren" = $1`;

    try {
      const result = await pool.query(query, [siren]);
      for (const row of result.rows) {
        results.push(row);
        if (row.département) departementsSet.add(row.département);
      }
    } catch (error) {
      console.error(`Erreur lors de la recherche dans ${table}:`, error);
    }
  }

  if (results.length === 0) {
    return { proprietes: [], departements_concernes: [] };
  }

  const proprietes = results.map(transformToPropiete);
  const proprietaire = proprietes[0].proprietaire;

  // Enrichir avec API Entreprises
  const entreprise = await enrichSiren(siren) || undefined;

  return {
    proprietaire,
    entreprise,
    proprietes,
    departements_concernes: Array.from(departementsSet).sort(),
  };
}

// Recherche par dénomination (nom du propriétaire)
export async function searchByDenomination(
  denomination: string,
  departement?: string,
  limit?: number
): Promise<{
  resultats: Array<{
    proprietaire: Proprietaire;
    entreprise?: EntrepriseEnrichie;
    proprietes: Propriete[];
    departements_concernes: string[];
  }>;
  total: number;
}> {
  const maxResults = limit || config.search.maxLimit;
  const normalizedSearch = normalizeForSearch(denomination);
  const searchTerms = normalizedSearch.split(' ').filter(t => t.length >= 2);

  if (searchTerms.length === 0) {
    return { resultats: [], total: 0 };
  }

  // Déterminer les tables à interroger
  let tables: string[];
  if (departement) {
    tables = await resolveTablesForDepartment(departement);
  } else {
    tables = await resolveAllTables();
  }

  const results: LocalRaw[] = [];
  const searchPattern = `%${searchTerms.join('%')}%`;

  for (const table of tables) {
    if (results.length >= maxResults) break;

    const remainingLimit = maxResults - results.length;

    const query = `
      SELECT *
      FROM "${table}"
      WHERE LOWER(TRANSLATE(dénomination, 'àâäéèêëïîôùûüç', 'aaaeeeeiioouuc')) ILIKE $1
      LIMIT $2
    `;

    try {
      const result = await pool.query(query, [searchPattern, remainingLimit]);
      results.push(...result.rows);
    } catch (error) {
      console.error(`Erreur lors de la recherche dans ${table}:`, error);
    }
  }

  // Grouper par SIREN ou dénomination
  const groupedMap = new Map<string, { rows: LocalRaw[]; sirens: Set<string>; departements: Set<string> }>();

  for (const raw of results) {
    const key = raw['n°_siren'] || raw.dénomination || 'inconnu';

    if (!groupedMap.has(key)) {
      groupedMap.set(key, { rows: [], sirens: new Set(), departements: new Set() });
    }

    const entry = groupedMap.get(key)!;
    entry.rows.push(raw);
    if (raw['n°_siren']) entry.sirens.add(raw['n°_siren']);
    if (raw.département) entry.departements.add(raw.département);
  }

  // Transformer et enrichir
  const resultats: Array<{
    proprietaire: Proprietaire;
    entreprise?: EntrepriseEnrichie;
    proprietes: Propriete[];
    departements_concernes: string[];
  }> = [];

  for (const [_, value] of groupedMap) {
    const proprietes = value.rows.map(transformToPropiete);
    const proprietaire = proprietes[0].proprietaire;

    // Enrichir si SIREN disponible
    let entreprise: EntrepriseEnrichie | undefined;
    const sirens = Array.from(value.sirens);
    if (sirens.length > 0 && sirens[0].length === 9) {
      const enriched = await enrichSiren(sirens[0]);
      if (enriched) entreprise = enriched;
    }

    resultats.push({
      proprietaire,
      entreprise,
      proprietes,
      departements_concernes: Array.from(value.departements).sort(),
    });
  }

  return { resultats, total: results.length };
}
