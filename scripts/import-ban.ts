/**
 * Script d'import de la Base Adresse Nationale (BAN)
 * Télécharge et importe les adresses françaises avec coordonnées GPS
 * 
 * Usage: npx ts-node scripts/import-ban.ts
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

// Configuration
const BAN_URL = 'https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-france.csv.gz';
const BATCH_SIZE = 10000;
const DATA_DIR = './data';
const CSV_FILE = path.join(DATA_DIR, 'adresses-france.csv');
const GZ_FILE = path.join(DATA_DIR, 'adresses-france.csv.gz');

// Connexion DB depuis les variables d'environnement
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'locaux_2025',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

interface BanRecord {
  id: string;
  numero: string;
  rep: string;
  nom_voie: string;
  code_postal: string;
  code_commune: string;
  nom_commune: string;
  lon: number | null;
  lat: number | null;
}

// Télécharger le fichier BAN
async function downloadBAN(): Promise<void> {
  console.log('📥 Téléchargement de la BAN...');
  console.log(`   URL: ${BAN_URL}`);
  
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const response = await fetch(BAN_URL);
  if (!response.ok) {
    throw new Error(`Erreur téléchargement: ${response.status}`);
  }

  const totalSize = parseInt(response.headers.get('content-length') || '0');
  console.log(`   Taille: ${(totalSize / 1024 / 1024).toFixed(2)} Mo`);

  const fileStream = fs.createWriteStream(GZ_FILE);
  const reader = response.body?.getReader();
  
  if (!reader) throw new Error('Impossible de lire le stream');

  let downloaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(value);
    downloaded += value.length;
    process.stdout.write(`\r   Progression: ${((downloaded / totalSize) * 100).toFixed(1)}%`);
  }
  
  fileStream.close();
  console.log('\n   ✅ Téléchargement terminé');
}

// Décompresser le fichier
async function decompressBAN(): Promise<void> {
  console.log('📦 Décompression...');
  
  const gzStream = fs.createReadStream(GZ_FILE);
  const gunzip = createGunzip();
  const outStream = fs.createWriteStream(CSV_FILE);
  
  await pipeline(gzStream, gunzip, outStream);
  
  const stats = fs.statSync(CSV_FILE);
  console.log(`   ✅ Fichier décompressé: ${(stats.size / 1024 / 1024 / 1024).toFixed(2)} Go`);
}

// Parser une ligne CSV
function parseCSVLine(line: string, headers: string[]): BanRecord | null {
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

  return {
    id: record.id || `${record.code_commune}-${record.numero}-${record.nom_voie}`.substring(0, 50),
    numero: record.numero || '',
    rep: record.rep || record.repetition || '',
    nom_voie: record.nom_voie || '',
    code_postal: record.code_postal || '',
    code_commune: record.code_commune || record.commune_insee || '',
    nom_commune: record.nom_commune || record.commune_nom || '',
    lon: isNaN(lon) ? null : lon,
    lat: isNaN(lat) ? null : lat,
  };
}

// Insérer un batch dans la base
async function insertBatch(records: BanRecord[]): Promise<number> {
  if (records.length === 0) return 0;

  const values: any[] = [];
  const placeholders: string[] = [];
  let paramIndex = 1;

  for (const r of records) {
    if (!r.lon || !r.lat) continue; // Skip les adresses sans coordonnées
    
    placeholders.push(
      `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8})`
    );
    values.push(
      r.id.substring(0, 100),
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

  if (placeholders.length === 0) return 0;

  const query = `
    INSERT INTO ban_adresses (id, numero, rep, nom_voie, code_postal, code_commune, nom_commune, lon, lat)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (id) DO UPDATE SET
      numero = EXCLUDED.numero,
      rep = EXCLUDED.rep,
      nom_voie = EXCLUDED.nom_voie,
      code_postal = EXCLUDED.code_postal,
      code_commune = EXCLUDED.code_commune,
      nom_commune = EXCLUDED.nom_commune,
      lon = EXCLUDED.lon,
      lat = EXCLUDED.lat,
      updated_at = NOW()
  `;

  try {
    await pool.query(query, values);
    return placeholders.length;
  } catch (error) {
    console.error('Erreur insertion batch:', error);
    return 0;
  }
}

// Importer le CSV dans la base
async function importCSV(): Promise<void> {
  console.log('📊 Import dans PostgreSQL...');
  
  const startTime = Date.now();
  let totalLines = 0;
  let insertedCount = 0;
  let errorCount = 0;
  let headers: string[] = [];
  let batch: BanRecord[] = [];

  const fileStream = fs.createReadStream(CSV_FILE, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    totalLines++;

    // Première ligne = headers
    if (totalLines === 1) {
      headers = line.split(';').map(h => h.replace(/"/g, '').trim().toLowerCase());
      console.log(`   Colonnes: ${headers.join(', ')}`);
      continue;
    }

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
      
      process.stdout.write(
        `\r   Lignes: ${totalLines.toLocaleString()} | Insérées: ${insertedCount.toLocaleString()} | Erreurs: ${errorCount}`
      );
    }
  }

  // Dernier batch
  if (batch.length > 0) {
    const inserted = await insertBatch(batch);
    insertedCount += inserted;
  }

  const duration = Math.round((Date.now() - startTime) / 1000);

  // Sauvegarder les stats
  await pool.query(
    `INSERT INTO ban_import_stats (total_records, success_count, error_count, duration_seconds, status)
     VALUES ($1, $2, $3, $4, 'completed')`,
    [totalLines - 1, insertedCount, errorCount, duration]
  );

  console.log(`\n\n   ✅ Import terminé!`);
  console.log(`   📈 Statistiques:`);
  console.log(`      - Lignes traitées: ${(totalLines - 1).toLocaleString()}`);
  console.log(`      - Adresses insérées: ${insertedCount.toLocaleString()}`);
  console.log(`      - Erreurs: ${errorCount.toLocaleString()}`);
  console.log(`      - Durée: ${Math.floor(duration / 60)}min ${duration % 60}s`);
}

// Fonction principale
async function main() {
  console.log('\n🗺️  Import de la Base Adresse Nationale (BAN)');
  console.log('================================================\n');

  try {
    // Vérifier la connexion DB
    console.log('🔌 Connexion à la base de données...');
    await pool.query('SELECT 1');
    console.log('   ✅ Connecté\n');

    // Vérifier si PostGIS est installé
    try {
      const pgVersion = await pool.query('SELECT PostGIS_Version()');
      console.log(`   PostGIS: ${pgVersion.rows[0].postgis_version}\n`);
    } catch {
      console.log('   ⚠️  PostGIS non installé. Exécutez d\'abord scripts/setup-ban.sql\n');
      process.exit(1);
    }

    // Télécharger si nécessaire
    if (!fs.existsSync(GZ_FILE)) {
      await downloadBAN();
    } else {
      console.log('📥 Fichier BAN déjà téléchargé, skip...');
    }

    // Décompresser si nécessaire
    if (!fs.existsSync(CSV_FILE)) {
      await decompressBAN();
    } else {
      console.log('📦 Fichier déjà décompressé, skip...');
    }

    // Importer
    await importCSV();

    // Afficher le nombre d'adresses
    const countResult = await pool.query('SELECT COUNT(*) FROM ban_adresses WHERE geom IS NOT NULL');
    console.log(`\n🎉 Total adresses géolocalisées: ${parseInt(countResult.rows[0].count).toLocaleString()}`);

  } catch (error) {
    console.error('\n❌ Erreur:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
