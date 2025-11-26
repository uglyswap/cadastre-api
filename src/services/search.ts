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
  ProprieteGroupee,
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

// Types de voie à filtrer (codes CNAVOI officiels + versions textuelles)
const TYPES_VOIE = [
  // Codes CNAVOI et leurs versions textuelles
  'rue', 'rle', 'ruelle', 'ruet', 'ruellette', 'rult',
  'avenue', 'av', 'pae', 'petite avenue',
  'boulevard', 'bd', 'gbd', 'grand boulevard',
  'impasse', 'imp',
  'passage', 'pas', 'pass', 'passe',
  'allee', 'all', 'pla', 'petite allee',
  'place', 'pl', 'ptte', 'placette', 'plci', 'placis', 'gpl', 'grande place',
  'square', 'sq',
  'chemin', 'che', 'chem', 'cheminement', 'pch', 'petit chemin', 'vche', 'vieux chemin',
  'cc', 'chemin communal', 'cd', 'chemin departemental', 'cr', 'chemin rural', 'cf', 'chemin forestier', 'chv', 'chemin vicinal',
  'route', 'rte', 'prt', 'petite route', 'art', 'ancienne route', 'nte', 'nouvelle route', 'vte', 'vieille route',
  'cours', 'crs',
  'quai',
  'voie', 'vc', 'voie communale', 'voir', 'voirie',
  'villa', 'vla',
  'cite',
  'residence', 'res',
  'sentier', 'sen', 'sente',
  'traverse', 'tra',
  'hameau', 'ham',
  'lotissement', 'lot',
  'zone', 'za', 'zac', 'zad', 'zi', 'zup',
  'parc', 'pkg', 'parking',
  'esplanade', 'esp',
  'promenade', 'prom',
  // Autres types courants
  'gr', 'grande rue', 'ptr', 'petite rue',
  'cour', 'galerie', 'gal', 'mail', 'terre', 'ter', 'tpl', 'terre plein',
  'port', 'porte', 'pte', 'pont', 'quai', 'rampe', 'rpe',
  'rond point', 'rpt', 'carrefour', 'car',
  'montee', 'mte', 'descente', 'dsc',
  'domaine', 'dom', 'ferme', 'frm', 'mas',
  'jardin', 'jard', 'clos', 'enclos', 'enc',
  'berge', 'ber', 'rive', 'bord',
  'village', 'vge', 'quartier', 'qua', 'faubourg', 'fg', 'bourg', 'brg'
];

// Extrait le numéro de voirie et le reste de l'adresse (sans type de voie)
function extractNumeroVoirie(adresse: string): { numero: string | null; reste: string } {
  let normalized = adresse.trim();

  // Extraire le numéro au début
  let numero: string | null = null;
  const matchNumero = normalized.match(/^(\d{1,4})\s*(bis|ter|b|t)?\s+(.+)$/i);
  if (matchNumero) {
    numero = matchNumero[1].padStart(4, '0'); // Format: 0005
    normalized = matchNumero[3];
  }

  // Supprimer le type de voie s'il est au début
  const words = normalized.toLowerCase().split(/\s+/);
  if (words.length > 0 && TYPES_VOIE.includes(words[0])) {
    words.shift(); // Enlever le premier mot (type de voie)
  }

  return { numero, reste: words.join(' ') };
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

// Déduplique les propriétés en les groupant par adresse
function groupProprietesParAdresse(proprietes: Propriete[]): ProprieteGroupee[] {
  const grouped = new Map<string, ProprieteGroupee>();

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

// Convertit un code postal en filtre commune
// Pour Paris: 75009 -> "09" ou "9" pour matcher "PARIS 09"
// Pour Lyon: 69001 -> "01" pour matcher "LYON 01"
// Pour Marseille: 13001 -> "01" pour matcher "MARSEILLE 01"
// Pour autres villes: utilise le nom de commune directement si fourni
function codePostalToFilter(codePostal: string): { departement: string; communePattern?: string } {
  const cp = codePostal.trim();
  if (cp.length !== 5) {
    return { departement: cp.substring(0, 2) };
  }

  const dept = cp.substring(0, 2);
  const suffix = cp.substring(2);

  // Paris (75), Lyon (69), Marseille (13) ont des arrondissements
  if (dept === '75' || dept === '69' || dept === '13') {
    // Enlever les zéros de tête pour le pattern (75009 -> 9 ou 09)
    const arrond = parseInt(suffix, 10).toString().padStart(2, '0');
    return { departement: dept, communePattern: arrond };
  }

  return { departement: dept };
}

// Recherche par adresse
export async function searchByAddress(
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
}> {
  const maxResults = limit || config.search.maxLimit;

  // Extraire le numéro de voirie si présent
  const { numero, reste } = extractNumeroVoirie(adresse);

  const normalizedSearch = normalizeForSearch(reste);
  const searchTerms = normalizedSearch.split(' ').filter(t => t.length >= 2);

  if (searchTerms.length === 0) {
    return { resultats: [], total_proprietaires: 0, total_lots: 0 };
  }

  // Traitement du code postal
  let effectiveDepartement = departement;
  let communePattern: string | undefined;

  if (codePostal) {
    const cpFilter = codePostalToFilter(codePostal);
    effectiveDepartement = cpFilter.departement;
    communePattern = cpFilter.communePattern;
  }

  // Déterminer les tables à interroger
  let tables: string[];
  if (effectiveDepartement) {
    tables = await resolveTablesForDepartment(effectiveDepartement);
  } else {
    tables = await resolveAllTables();
  }

  if (tables.length === 0) {
    return { resultats: [], total_proprietaires: 0, total_lots: 0 };
  }

  // Construire la requête avec recherche fuzzy sur le nom de voie
  const results: LocalRaw[] = [];
  const searchPattern = `%${searchTerms.join('%')}%`;

  for (const table of tables) {
    if (results.length >= maxResults) break;

    const remainingLimit = maxResults - results.length;

    // Construire la requête dynamiquement selon les filtres
    const conditions: string[] = [
      `LOWER(TRANSLATE(nom_voie, 'àâäéèêëïîôùûüç', 'aaaeeeeiioouuc')) ILIKE $1`
    ];
    const params: (string | number)[] = [searchPattern];
    let paramIndex = 2;

    if (numero) {
      conditions.push(`"n°_voirie" = $${paramIndex}`);
      params.push(numero);
      paramIndex++;
    }

    if (communePattern) {
      // Filtre sur nom_de_la_commune qui contient l'arrondissement (ex: "PARIS 09")
      conditions.push(`nom_de_la_commune LIKE $${paramIndex}`);
      params.push(`%${communePattern}%`);
      paramIndex++;
    }

    params.push(remainingLimit);
    const query = `
      SELECT *
      FROM "${table}"
      WHERE ${conditions.join(' AND ')}
      LIMIT $${paramIndex}
    `;

    try {
      const result = await pool.query(query, params);
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

  // Enrichir avec API Entreprises et dédupliquer par adresse
  const resultats: Array<{
    proprietaire: Proprietaire;
    proprietes: ProprieteGroupee[];
    entreprise?: EntrepriseEnrichie;
    nombre_adresses: number;
    nombre_lots: number;
  }> = [];

  for (const [_, value] of proprietairesMap) {
    let entreprise: EntrepriseEnrichie | undefined;

    // Enrichir si on a un SIREN valide
    const sirens = Array.from(value.sirens);
    if (sirens.length > 0 && sirens[0].length === 9) {
      const enriched = await enrichSiren(sirens[0]);
      if (enriched) entreprise = enriched;
    }

    // Grouper les propriétés par adresse
    const proprietesGroupees = groupProprietesParAdresse(value.proprietes);
    const nombreLots = value.proprietes.length;

    resultats.push({
      proprietaire: value.proprietaire,
      proprietes: proprietesGroupees,
      entreprise,
      nombre_adresses: proprietesGroupees.length,
      nombre_lots: nombreLots,
    });
  }

  return {
    resultats,
    total_proprietaires: resultats.length,
    total_lots: results.length,
  };
}

// Recherche par propriétaire (SIREN)
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
  if (!siren || siren.length !== 9) {
    return { proprietes: [], nombre_adresses: 0, nombre_lots: 0, departements_concernes: [] };
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
    return { proprietes: [], nombre_adresses: 0, nombre_lots: 0, departements_concernes: [] };
  }

  const proprietes = results.map(transformToPropiete);
  const proprietaire = proprietes[0].proprietaire;

  // Enrichir avec API Entreprises
  const entreprise = await enrichSiren(siren) || undefined;

  // Grouper les propriétés par adresse
  const proprietesGroupees = groupProprietesParAdresse(proprietes);

  return {
    proprietaire,
    entreprise,
    proprietes: proprietesGroupees,
    nombre_adresses: proprietesGroupees.length,
    nombre_lots: results.length,
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
    proprietes: ProprieteGroupee[];
    nombre_adresses: number;
    nombre_lots: number;
    departements_concernes: string[];
  }>;
  total_proprietaires: number;
  total_lots: number;
}> {
  const maxResults = limit || config.search.maxLimit;
  const normalizedSearch = normalizeForSearch(denomination);
  const searchTerms = normalizedSearch.split(' ').filter(t => t.length >= 2);

  if (searchTerms.length === 0) {
    return { resultats: [], total_proprietaires: 0, total_lots: 0 };
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

  // Transformer et enrichir avec déduplication par adresse
  const resultats: Array<{
    proprietaire: Proprietaire;
    entreprise?: EntrepriseEnrichie;
    proprietes: ProprieteGroupee[];
    nombre_adresses: number;
    nombre_lots: number;
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
    total_lots: results.length,
  };
}
