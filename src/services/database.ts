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
