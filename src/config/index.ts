import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Serveur
  port: parseInt(process.env.PORT || '3001'),
  host: process.env.HOST || '0.0.0.0',

  // Base de données PostgreSQL
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'cadastre',
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
  auth: {
    masterApiKey: process.env.MASTER_API_KEY || 'your_api_key',
  },

  // Recherche
  search: {
    defaultLimit: 100,
    maxLimit: 1000,
    fuzzyThreshold: 0.3, // Seuil de similarité pour la recherche fuzzy
  }
};
