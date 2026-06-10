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
    masterApiKey: process.env.MASTER_API_KEY || '',
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

  if (errors.length > 0) {
    throw new Error(
      'Configuration invalide, demarrage refuse:\n  - ' + errors.join('\n  - ')
    );
  }
}
