import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Serveur
  port: parseInt(process.env.PORT || '3001'),
  host: process.env.HOST || '0.0.0.0',

  // Base de données PostgreSQL/PostGIS (cadastre_geo)
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5436'),
    database: process.env.DB_NAME || 'cadastre_geo',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  },

  // API Recherche Entreprises
  entreprisesApi: {
    baseUrl: 'https://recherche-entreprises.api.gouv.fr',
    maxRequestsPerSecond: 7,
    timeout: 10000,
  },

  // Authentification
  // Aucune valeur par defaut: une cle absente doit faire echouer le demarrage (fail-closed),
  // jamais autoriser un acces avec une cle devinable.
  auth: {
    /**
     * Cle de RECHERCHE. Distribuee au frontend sous le nom CADASTRE_API_KEY.
     * Elle ne doit ouvrir que la lecture.
     */
    masterApiKey: process.env.MASTER_API_KEY || '',
    /**
     * Cle d'ADMINISTRATION, distincte de la precedente.
     *
     * Les routes d'administration executent du DDL (CREATE EXTENSION, CREATE
     * TABLE, DROP TRIGGER) et declenchent un telechargement de 1,5 Go. Elles
     * etaient protegees par la MEME cle que la recherche, cle par ailleurs
     * distribuee au frontend et publiee dans un README : quiconque pouvait
     * chercher pouvait modifier le schema de la base cadastrale.
     *
     * Sans ADMIN_API_KEY definie, les routes d'administration ne sont tout
     * simplement pas enregistrees.
     */
    adminApiKey: process.env.ADMIN_API_KEY || '',
  },

  features: {
    /**
     * Pipeline d'import BAN. Desactive par defaut : il alimente une table
     * qu'aucune route de recherche n'interroge, tout en exposant du DDL et un
     * telechargement massif. Le code est conserve, seule son exposition HTTP
     * est debranchee.
     */
    banPipelineEnabled: process.env.BAN_PIPELINE_ENABLED === 'true',
  },

  // Recherche
  search: {
    defaultLimit: 100,
    maxLimit: 10000,
    fuzzyThreshold: 0.3, // Seuil de similarité pour la recherche fuzzy
  },

  // PostGIS geocoding
  postgis: {
    srid: 4326, // WGS84
    geocodingCoverage: 0.9799, // 97.99% coverage
  }
};

/**
 * Valide la presence des variables d'environnement critiques au demarrage.
 * Fait echouer explicitement le boot si un secret obligatoire manque (fail-closed),
 * plutot que de demarrer avec une configuration non securisee.
 */
export function validateConfig(): void {
  const errors: string[] = [];

  if (!config.auth.masterApiKey || config.auth.masterApiKey.length < 16) {
    errors.push('MASTER_API_KEY manquante ou trop courte (>= 16 caracteres requis)');
  }
  if (!config.database.password) {
    errors.push('DB_PASSWORD manquante');
  }

  // Les pools d'enrichissement retombaient sur un mot de passe vide, et l'echec
  // de connexion qui en resultait etait avale : l'enrichissement renvoyait donc
  // toujours des donnees vides, sans que rien ne le signale. On refuse de
  // demarrer plutot que de servir un produit muet.
  if (!process.env.ENRICH_DB_PASSWORD) {
    errors.push('ENRICH_DB_PASSWORD manquante (base immo_data, enrichissement DVF/BDNB)');
  }
  if (!process.env.CADASTRE_DB_PASSWORD) {
    errors.push('CADASTRE_DB_PASSWORD manquante (base cadastre_geo, contenance parcelle)');
  }

  // La cle d'administration doit differer de la cle de recherche : c'est tout
  // l'interet de la separation.
  if (config.auth.adminApiKey) {
    if (config.auth.adminApiKey.length < 32) {
      errors.push('ADMIN_API_KEY trop courte (>= 32 caracteres requis)');
    }
    if (config.auth.adminApiKey === config.auth.masterApiKey) {
      errors.push('ADMIN_API_KEY doit etre differente de MASTER_API_KEY');
    }
  } else if (config.features.banPipelineEnabled) {
    errors.push('BAN_PIPELINE_ENABLED=true exige ADMIN_API_KEY');
  }

  if (errors.length > 0) {
    throw new Error(
      'Configuration invalide, demarrage refuse:\n  - ' + errors.join('\n  - ')
    );
  }
}
