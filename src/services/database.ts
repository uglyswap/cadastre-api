import pg from 'pg';
import { config } from '../config/index.js';

const { Pool } = pg;

// Pool de connexion PostgreSQL
export const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.database,
  user: config.database.user,
  password: config.database.password,
  max: 20, // Maximum de connexions dans le pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  // Empeche les requetes orphelines de continuer cote PostgreSQL apres un timeout
  // HTTP cote client (qui peut atteindre 5-10 min sur les grandes recherches geo).
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || '300000'),
  query_timeout: parseInt(process.env.DB_QUERY_TIMEOUT_MS || '300000'),
});

// Un client idle qui rencontre une erreur (ex: coupure reseau) emet 'error' sur le
// pool: sans handler, l'erreur remonte en exception non capturee et crash le process.
pool.on('error', (err) => {
  console.error('Erreur inattendue sur un client PostgreSQL idle:', err.message);
});

// Vérifier la connexion au démarrage
export async function testConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (error) {
    console.error('Erreur de connexion à la base de données:', error);
    return false;
  }
}

// Fermer le pool proprement
export async function closePool(): Promise<void> {
  await pool.end();
}
