/**
 * Service de recherche d'entreprises
 * 
 * v2.7.0 - 2026-04-23
 * - DB locale SIRENE (29M+ entreprises) pour infos de base
 * - API externe pour les dirigeants (avec cache 3 jours)
 * - Fallback vers infos basiques si API externe indisponible
 */

import { Pool } from 'pg';
import { config } from '../config/index.js';
import axios from 'axios';
import { EntrepriseEnrichie, Dirigeant, SiegeEntreprise, BeneficiaireEffectif } from '../types/index.js';

// Pool de connexion à la DB SIRENE locale
let sirenePool: Pool | null = null;

function getSirenePool(): Pool {
  if (!sirenePool) {
    sirenePool = new Pool({
      host: process.env.SIRENE_DB_HOST || '172.17.0.1',
      port: parseInt(process.env.SIRENE_DB_PORT || '5434'),
      database: 'sirene',
      user: process.env.SIRENE_DB_USER || 'immo',
      password: process.env.SIRENE_DB_PASSWORD || 'imm0_pr0d_2026_s3cure',
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }
  return sirenePool;
}

// ============================================================================
// Cache en mémoire pour les dirigeants (TTL 3 jours)
// ============================================================================
interface DirigeantCacheEntry {
  dirigeants: Dirigeant[];
  expiresAt: number;
}

const DIRIGEANT_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 jours
const dirigeantCache = new Map<string, DirigeantCacheEntry>();

// Track API availability
let apiAvailable = true;
let lastApiCheck = 0;
const API_RETRY_INTERVAL = 5 * 60 * 1000; // Vérifier toutes les 5 min après une erreur
const externalClient = axios.create({
  baseURL: config.entreprisesApi.baseUrl,
  timeout: config.entreprisesApi.timeout,
  headers: { 'Accept': 'application/json' },
});

// Rate limiter pour l'API externe (max 7 req/sec)
class RateLimiter {
  private timestamps: number[] = [];
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number, windowMs: number = 1000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  async waitForSlot(): Promise<void> {
    while (true) {
      const now = Date.now();
      this.timestamps = this.timestamps.filter(ts => now - ts < this.windowMs);
      if (this.timestamps.length < this.maxRequests) {
        break;
      }
      const oldestTs = this.timestamps[0];
      const waitTime = this.windowMs - (now - oldestTs) + 10;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    this.timestamps.push(now);
  }
}

const rateLimiter = new RateLimiter(config.entreprisesApi.maxRequestsPerSecond);

// ============================================================================
// Recherche des dirigeants via API externe (avec cache)
// ============================================================================
async function fetchDirigeantsFromAPI(siren: string): Promise<Dirigeant[] | null> {
  // Vérifier le cache
  const cached = dirigeantCache.get(siren);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.dirigeants;
  }

  // Vérifier si l'API est disponible
  if (!apiAvailable && Date.now() - lastApiCheck < API_RETRY_INTERVAL) {
    return null; // API indisponible, ne pas réessayer avant le prochain check
  }

  // Vérifier si le SIREN est valide (9 chiffres)
  if (!siren || siren.length !== 9 || !/^\d+$/.test(siren)) {
    return [];
  }

  await rateLimiter.waitForSlot();

  try {
    const response = await externalClient.get('/search', {
      params: { q: siren, per_page: 1 },
    });

    apiAvailable = true;
    const results = response.data?.results;
    if (!results || results.length === 0) {
      // Mettre en cache le résultat vide
      dirigeantCache.set(siren, { dirigeants: [], expiresAt: Date.now() + DIRIGEANT_CACHE_TTL_MS });
      return [];
    }

    const dirigeants = extractDirigeants(results[0]);
    
    // Mettre en cache
    dirigeantCache.set(siren, {
      dirigeants,
      expiresAt: Date.now() + DIRIGEANT_CACHE_TTL_MS,
    });

    return dirigeants;
  } catch (error: any) {
    if (error?.response?.status === 429) {
      apiAvailable = false;
      lastApiCheck = Date.now();
      console.warn(`[ENTREPRISES-API] Rate limit (429) pour SIREN ${siren} - fallback vers infos basiques`);
      return null; // Retourner null pour indiquer que l'API est indisponible
    }
    console.error(`[ENTREPRISES-API] Erreur pour SIREN ${siren}:`, error.message);
    return null;
  }
}

function extractDirigeants(data: any): Dirigeant[] {
  const dirigeants: Dirigeant[] = [];
  if (data.dirigeants) {
    for (const d of data.dirigeants) {
      if (d.type_dirigeant === 'personne physique') {
        dirigeants.push({
          nom: d.nom || '',
          prenoms: d.prenoms || '',
          qualite: d.qualite || '',
          type: 'personne_physique',
          annee_naissance: d.annee_de_naissance?.toString() || undefined,
        });
      } else if (d.type_dirigeant === 'personne morale') {
        dirigeants.push({
          nom: d.denomination || '',
          prenoms: '',
          qualite: d.qualite || '',
          type: 'personne_morale',
          siren: d.siren || undefined,
          denomination: d.denomination || undefined,
        });
      }
    }
  }
  return dirigeants;
}

// ============================================================================
// Recherche dans la DB locale SIRENE
// ============================================================================
interface BasicEntrepriseInfo {
  siren: string;
  denomination: string;
  formeJuridique: string;
  formeJuridiqueCode: string;
  categorieEntreprise: string;
  trancheEffectif: string;
  dateCreation: string;
  etatAdministratif: string;
}

async function searchBasicInfoLocal(siren: string): Promise<BasicEntrepriseInfo | null> {
  if (!siren || siren.length !== 9) return null;

  const pool = getSirenePool();
  
  try {
    const result = await pool.query(
      `SELECT 
        siren, denomination, forme_juridique_code,
        categorie_entreprise, tranche_effectif,
        date_creation, etat_administratif
       FROM unite_legale 
       WHERE siren = $1 
       LIMIT 1`,
      [siren]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      siren: row.siren,
      denomination: row.denomination || '',
      formeJuridique: decodeFormeJuridique(row.forme_juridique_code),
      formeJuridiqueCode: row.forme_juridique_code || '',
      categorieEntreprise: row.categorie_entreprise || '',
      trancheEffectif: decodeTrancheEffectif(row.tranche_effectif),
      dateCreation: row.date_creation || '',
      etatAdministratif: row.etat_administratif || '',
    };
  } catch (error) {
    console.error(`[ENTREPRISES-API] Erreur recherche SIREN ${siren}:`, error);
    return null;
  }
}

function decodeFormeJuridique(code: string): string {
  if (!code) return '';
  const formes: Record<string, string> = {
    '1000': 'Entrepreneur individuel',
    '5498': 'SARL',
    '5499': 'Autre SARL',
    '5505': 'SA à participation ouvrière à directoire',
    '5510': 'SA à participation ouvrière à conseil d\'administration',
    '5605': 'SAS',
    '5700': 'SAS non cotée',
    '5710': 'SAS cotée',
    '6540': 'Société civile immobilière (SCI)',
    '6536': 'Société civile immobilière',
    '6539': 'Autre société civile immobilière',
    '7220': 'Syndicat de copropriété',
    '9150': 'Syndicat de copropriété',
    '9210': 'Association loi 1901',
    '9220': 'Association déclarée',
  };
  return formes[code] || `Forme juridique: ${code}`;
}

function decodeTrancheEffectif(code: string): string {
  const tranches: Record<string, string> = {
    '00': '0 salarié', '01': '1 ou 2 salariés', '02': '3 à 5 salariés',
    '03': '6 à 9 salariés', '11': '10 à 19 salariés', '12': '20 à 49 salariés',
    '21': '50 à 99 salariés', '22': '100 à 199 salariés', '31': '200 à 249 salariés',
    '32': '250 à 499 salariés', '41': '500 à 999 salariés', '42': '1000 à 1999 salariés',
    '51': '2000 à 4999 salariés', '52': '5000 à 9999 salariés', '53': '10000 salariés et plus',
  };
  return tranches[code] || 'Non renseigné';
}

// ============================================================================
// API Publique - Utilisée par le reste de l'application
// ============================================================================

/**
 * Recherche une entreprise par SIREN
 * - DB locale pour infos de base (toujours dispo)
 * - API externe pour dirigeants (avec cache 3 jours)
 */
export async function enrichSiren(siren: string): Promise<EntrepriseEnrichie | null> {
  if (!siren || siren.length !== 9) return null;

  // 1. Récupérer les infos de base depuis la DB locale
  const basicInfo = await searchBasicInfoLocal(siren);
  if (!basicInfo) return null;

  // 2. Récupérer les dirigeants depuis l'API externe (ou fallback)
  const dirigeants = await fetchDirigeantsFromAPI(siren);

  // 3. Construire le résultat complet
  return {
    siren: basicInfo.siren,
    nom_complet: basicInfo.denomination || `Entreprise ${basicInfo.siren}`,
    nom_raison_sociale: basicInfo.denomination,
    sigle: null,
    nature_juridique: basicInfo.formeJuridique,
    date_creation: basicInfo.dateCreation,
    etat_administratif: basicInfo.etatAdministratif,
    categorie_entreprise: basicInfo.categorieEntreprise,
    tranche_effectif: basicInfo.trancheEffectif,
    siege: { adresse: '', code_postal: '', commune: '' },
    dirigeants: dirigeants || [], // Vide si API indisponible
    beneficiaires_effectifs: [],
    nombre_etablissements: 0,
  };
}

/**
 * Recherche une entreprise par dénomination
 * Priorité: 1. DB locale → 2. API externe (fallback)
 */
export async function searchEntreprises(denomination: string, limit?: number): Promise<EntrepriseEnrichie[]> {
  if (!denomination || denomination.trim().length < 2) return [];

  const pool = getSirenePool();
  const effectiveLimit = limit || 5;
  
  try {
    // Recherche full-text sur la dénomination
    const searchTerms = denomination.trim().split(/\s+/).filter(t => t.length > 2);
    
    let rows: any[] = [];

    if (searchTerms.length > 0) {
      // Recherche full-text
      const query = searchTerms.join(' & ');
      const result = await pool.query(
        `SELECT siren, denomination, forme_juridique_code,
                categorie_entreprise, tranche_effectif, date_creation, etat_administratif,
                ts_rank(to_tsvector('simple', COALESCE(denomination, '')), plainto_tsquery('simple', $1)) as score
         FROM unite_legale
         WHERE etat_administratif = 'A'
           AND denomination IS NOT NULL
           AND denomination != ''
           AND to_tsvector('simple', COALESCE(denomination, '')) @@ plainto_tsquery('simple', $1)
         ORDER BY score DESC
         LIMIT $2`,
        [query, effectiveLimit]
      );
      rows = result.rows;
    }

    // Fallback: recherche LIKE
    if (rows.length === 0) {
      const result = await pool.query(
        `SELECT siren, denomination, forme_juridique_code,
                categorie_entreprise, tranche_effectif, date_creation, etat_administratif
         FROM unite_legale
         WHERE etat_administratif = 'A'
           AND denomination IS NOT NULL
           AND denomination != ''
           AND LOWER(denomination) LIKE LOWER($1)
         LIMIT $2`,
        [`%${denomination.trim()}%`, effectiveLimit]
      );
      rows = result.rows;
    }

    // Construire les résultats avec dirigeants si dispo
    const results: EntrepriseEnrichie[] = [];
    for (const row of rows) {
      const dirigeants = await fetchDirigeantsFromAPI(row.siren);
      results.push({
        siren: row.siren,
        nom_complet: row.denomination || `Entreprise ${row.siren}`,
        nom_raison_sociale: row.denomination,
        sigle: null,
        nature_juridique: decodeFormeJuridique(row.forme_juridique_code),
        date_creation: row.date_creation || '',
        etat_administratif: row.etat_administratif || '',
        categorie_entreprise: row.categorie_entreprise || '',
        tranche_effectif: decodeTrancheEffectif(row.tranche_effectif),
        siege: { adresse: '', code_postal: '', commune: '' },
        dirigeants: dirigeants || [],
        beneficiaires_effectifs: [],
        nombre_etablissements: 0,
      });
    }

    return results;
  } catch (error) {
    console.error(`[ENTREPRISES-API] Erreur recherche dénomination "${denomination}":`, error);
    return [];
  }
}

/**
 * Stats du cache (pour monitoring)
 */
export function getCacheStats(): { 
  dirigeantCacheSize: number; 
  apiAvailable: boolean; 
  lastApiCheck: Date | null;
} {
  return {
    dirigeantCacheSize: dirigeantCache.size,
    apiAvailable,
    lastApiCheck: lastApiCheck > 0 ? new Date(lastApiCheck) : null,
  };
}
