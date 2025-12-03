/**
 * Service d'import de la Base Adresse Nationale (BAN)
 * Télécharge et importe les adresses en streaming
 */

import { pool } from './database.js';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

const BAN_URL = 'https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-france.csv.gz';
const DATA_DIR = '/tmp/ban-data';
const GZ_FILE = path.join(DATA_DIR, 'adresses-france.csv.gz');
const CSV_FILE = path.join(DATA_DIR, 'adresses-france.csv');
const BATCH_SIZE = 5000;

let importRunning = false;

export function isImportRunning(): boolean {
  return importRunning;
}

// Mettre à jour la progression en base
async function updateProgress(data: {
  status?: string;
  current_step?: string;
  total_lines?: number;
  processed_lines?: number;
  inserted_count?: number;
  error_count?: number;
  completed_at?: Date | null;
}): Promise<void> {
  const sets: string[] = ['updated_at = NOW()'];
  const values: any[] = [];
  let idx = 1;

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      sets.push(`${key} = $${idx}`);
      values.push(value);
      idx++;
    }
  }

  if (sets.length > 1) {
    await pool.query(
      `UPDATE ban_import_progress SET ${sets.join(', ')} WHERE id = 1`,
      values
    );
  }
}

// Récupérer la progression
export async function getImportProgress(): Promise<{
  status: string;
  current_step: string;
  total_lines: number;
  processed_lines: number;
  inserted_count: number;
  error_count: number;
  percentage: number;
  started_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
}> {
  try {
    const result = await pool.query('SELECT * FROM ban_import_progress WHERE id = 1');
    const row = result.rows[0];

    if (!row) {
      return {
        status: 'not_initialized',
        current_step: 'Exécutez POST /admin/setup d\'abord',
        total_lines: 0,
        processed_lines: 0,
        inserted_count: 0,
        error_count: 0,
        percentage: 0,
        started_at: null,
        updated_at: null,
        completed_at: null,
      };
    }

    const percentage = row.total_lines > 0
      ? Math.round((row.processed_lines / row.total_lines) * 100)
      : 0;

    return {
      status: row.status,
      current_step: row.current_step || '',
      total_lines: parseInt(row.total_lines) || 0,
      processed_lines: parseInt(row.processed_lines) || 0,
      inserted_count: parseInt(row.inserted_count) || 0,
      error_count: parseInt(row.error_count) || 0,
      percentage,
      started_at: row.started_at?.toISOString() || null,
      updated_at: row.updated_at?.toISOString() || null,
      completed_at: row.completed_at?.toISOString() || null,
    };
  } catch {
    return {
      status: 'error',
      current_step: 'Table de progression non trouvée',
      total_lines: 0,
      processed_lines: 0,
      inserted_count: 0,
      error_count: 0,
      percentage: 0,
      started_at: null,
      updated_at: null,
      completed_at: null,
    };
  }
}

// Télécharger le fichier BAN
async function downloadBAN(): Promise<void> {
  console.log('[ban-import] Téléchargement de la BAN...');
  await updateProgress({ current_step: 'Téléchargement du fichier BAN (~1.5 Go)' });

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const response = await fetch(BAN_URL);
  if (!response.ok) {
    throw new Error(`Erreur téléchargement: ${response.status}`);
  }

  const totalSize = parseInt(response.headers.get('content-length') || '0');
  console.log(`[ban-import] Taille: ${(totalSize / 1024 / 1024).toFixed(2)} Mo`);

  const fileStream = fs.createWriteStream(GZ_FILE);
  const reader = response.body?.getReader();

  if (!reader) throw new Error('Impossible de lire le stream');

  let downloaded = 0;
  let lastLog = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(value);
    downloaded += value.length;

    // Log tous les 10%
    const percent = Math.floor((downloaded / totalSize) * 100);
    if (percent >= lastLog + 10) {
      lastLog = percent;
      console.log(`[ban-import] Téléchargement: ${percent}%`);
      await updateProgress({ current_step: `Téléchargement: ${percent}%` });
    }
  }

  fileStream.close();
  console.log('[ban-import] Téléchargement terminé');
}

// Décompresser le fichier
async function decompressBAN(): Promise<void> {
  console.log('[ban-import] Décompression...');
  await updateProgress({ current_step: 'Décompression du fichier' });

  const gzStream = fs.createReadStream(GZ_FILE);
  const gunzip = createGunzip();
  const outStream = fs.createWriteStream(CSV_FILE);

  await pipeline(gzStream, gunzip, outStream);

  const stats = fs.statSync(CSV_FILE);
  console.log(`[ban-import] Fichier décompressé: ${(stats.size / 1024 / 1024 / 1024).toFixed(2)} Go`);
}

// Compter les lignes du fichier
async function countLines(): Promise<number> {
  console.log('[ban-import] Comptage des lignes...');
  await updateProgress({ current_step: 'Comptage des lignes' });

  let count = 0;
  const fileStream = fs.createReadStream(CSV_FILE);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const _ of rl) {
    count++;
  }

  return count - 1; // Moins le header
}

// Parser une ligne CSV
function parseCSVLine(line: string, headers: string[]): any | null {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ';' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());

  if (values.length < headers.length) return null;

  const record: any = {};
  headers.forEach((h, i) => {
    record[h] = values[i] || '';
  });

  const lon = parseFloat(record.lon || record.longitude);
  const lat = parseFloat(record.lat || record.latitude);

  if (isNaN(lon) || isNaN(lat)) return null;

  return {
    id: (record.id || `${record.code_commune}-${record.numero}-${record.nom_voie}`).substring(0, 100),
    numero: record.numero || '',
    rep: record.rep || record.repetition || '',
    nom_voie: record.nom_voie || '',
    code_postal: record.code_postal || '',
    code_commune: record.code_commune || record.commune_insee || '',
    nom_commune: record.nom_commune || record.commune_nom || '',
    lon,
    lat,
  };
}

// Insérer un batch
async function insertBatch(records: any[]): Promise<number> {
  if (records.length === 0) return 0;

  const values: any[] = [];
  const placeholders: string[] = [];
  let paramIndex = 1;

  for (const r of records) {
    placeholders.push(
      `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8})`
    );
    values.push(
      r.id,
      r.numero,
      r.rep,
      r.nom_voie,
      r.code_postal,
      r.code_commune,
      r.nom_commune,
      r.lon,
      r.lat
    );
    paramIndex += 9;
  }

  const query = `
    INSERT INTO ban_adresses (id, numero, rep, nom_voie, code_postal, code_commune, nom_commune, lon, lat)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (id) DO UPDATE SET
      numero = EXCLUDED.numero,
      rep = EXCLUDED.rep,
      nom_voie = EXCLUDED.nom_voie,
      lon = EXCLUDED.lon,
      lat = EXCLUDED.lat,
      updated_at = NOW()
  `;

  try {
    await pool.query(query, values);
    return records.length;
  } catch (error) {
    console.error('[ban-import] Erreur batch:', error);
    return 0;
  }
}

// Fonction principale d'import
export async function importBanData(): Promise<void> {
  if (importRunning) {
    throw new Error('Import déjà en cours');
  }

  importRunning = true;
  const startTime = Date.now();

  try {
    // Initialiser la progression
    await pool.query(`
      UPDATE ban_import_progress SET
        status = 'running',
        current_step = 'Initialisation',
        total_lines = 0,
        processed_lines = 0,
        inserted_count = 0,
        error_count = 0,
        started_at = NOW(),
        completed_at = NULL
      WHERE id = 1
    `);

    // Télécharger si nécessaire
    if (!fs.existsSync(GZ_FILE)) {
      await downloadBAN();
    } else {
      console.log('[ban-import] Fichier déjà téléchargé');
      await updateProgress({ current_step: 'Fichier déjà téléchargé' });
    }

    // Décompresser si nécessaire
    if (!fs.existsSync(CSV_FILE)) {
      await decompressBAN();
    } else {
      console.log('[ban-import] Fichier déjà décompressé');
    }

    // Compter les lignes
    const totalLines = await countLines();
    console.log(`[ban-import] Total lignes: ${totalLines.toLocaleString()}`);
    await updateProgress({ total_lines: totalLines, current_step: 'Import en cours' });

    // Importer le CSV
    let processedLines = 0;
    let insertedCount = 0;
    let errorCount = 0;
    let headers: string[] = [];
    let batch: any[] = [];
    let lastUpdate = Date.now();

    const fileStream = fs.createReadStream(CSV_FILE, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      // Header
      if (processedLines === 0) {
        headers = line.split(';').map(h => h.replace(/"/g, '').trim().toLowerCase());
        processedLines++;
        continue;
      }

      processedLines++;
      const record = parseCSVLine(line, headers);

      if (record) {
        batch.push(record);
      } else {
        errorCount++;
      }

      // Insérer par batch
      if (batch.length >= BATCH_SIZE) {
        const inserted = await insertBatch(batch);
        insertedCount += inserted;
        batch = [];

        // Mettre à jour la progression toutes les 5 secondes
        if (Date.now() - lastUpdate > 5000) {
          const percent = Math.round((processedLines / totalLines) * 100);
          console.log(`[ban-import] Progression: ${percent}% (${insertedCount.toLocaleString()} insérées)`);
          await updateProgress({
            processed_lines: processedLines,
            inserted_count: insertedCount,
            error_count: errorCount,
            current_step: `Import: ${percent}% (${insertedCount.toLocaleString()} adresses)`,
          });
          lastUpdate = Date.now();
        }
      }
    }

    // Dernier batch
    if (batch.length > 0) {
      const inserted = await insertBatch(batch);
      insertedCount += inserted;
    }

    const duration = Math.round((Date.now() - startTime) / 1000);

    // Finaliser
    await updateProgress({
      status: 'completed',
      current_step: 'Import terminé',
      processed_lines: processedLines - 1,
      inserted_count: insertedCount,
      error_count: errorCount,
      completed_at: new Date(),
    });

    // Sauvegarder les stats
    await pool.query(
      `INSERT INTO ban_import_stats (total_records, success_count, error_count, duration_seconds, status)
       VALUES ($1, $2, $3, $4, 'completed')`,
      [processedLines - 1, insertedCount, errorCount, duration]
    );

    console.log(`[ban-import] ✅ Import terminé!`);
    console.log(`[ban-import]    - Lignes traitées: ${(processedLines - 1).toLocaleString()}`);
    console.log(`[ban-import]    - Adresses insérées: ${insertedCount.toLocaleString()}`);
    console.log(`[ban-import]    - Erreurs: ${errorCount.toLocaleString()}`);
    console.log(`[ban-import]    - Durée: ${Math.floor(duration / 60)}min ${duration % 60}s`);

  } catch (error) {
    console.error('[ban-import] Erreur:', error);
    await updateProgress({
      status: 'error',
      current_step: `Erreur: ${error instanceof Error ? error.message : 'Inconnue'}`,
    });
    throw error;
  } finally {
    importRunning = false;
  }
}
