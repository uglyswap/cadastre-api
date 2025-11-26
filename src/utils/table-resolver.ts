import { pool } from '../services/database.js';

// Cache des tables disponibles
let tableCache: string[] | null = null;

// Récupère la liste des tables depuis la base de données
async function fetchAvailableTables(): Promise<string[]> {
  if (tableCache) return tableCache;

  const result = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
    AND (table_name LIKE 'pm_25_b_%' OR table_name LIKE 'pb_25_b_%')
    ORDER BY table_name
  `);

  tableCache = result.rows.map(row => row.table_name);
  return tableCache;
}

// Normalise un code département (ex: "1" -> "01", "2A" -> "2A")
export function normalizeDepartmentCode(code: string): string {
  const cleaned = code.trim().toUpperCase();

  // Cas spéciaux: Corse
  if (cleaned === '2A' || cleaned === '2B') return cleaned;

  // Départements numériques
  const num = parseInt(cleaned);
  if (!isNaN(num) && num >= 1 && num <= 976) {
    // DOM-TOM ont des codes à 3 chiffres
    if (num >= 971) return num.toString();
    // Métropole: padding à 2 chiffres
    return num.toString().padStart(2, '0');
  }

  return cleaned;
}

// Résout le(s) nom(s) de table(s) pour un département donné
export async function resolveTablesForDepartment(departement: string): Promise<string[]> {
  const tables = await fetchAvailableTables();
  const normalizedDept = normalizeDepartmentCode(departement);

  // Cas spécial Paris (75): tables pb_25_b_750_*
  if (normalizedDept === '75') {
    return tables.filter(t => t.startsWith('pb_25_b_750'));
  }

  // Départements standards: pm_25_b_XXX
  const pattern = `pm_25_b_${normalizedDept}`;
  const matching = tables.filter(t => t === pattern);

  return matching;
}

// Résout toutes les tables pour une recherche nationale
export async function resolveAllTables(): Promise<string[]> {
  return await fetchAvailableTables();
}

// Extrait le code département depuis un nom de table
export function extractDepartmentFromTable(tableName: string): string {
  // pb_25_b_750_1 -> 75
  if (tableName.startsWith('pb_25_b_750')) return '75';

  // pm_25_b_XX -> XX
  const match = tableName.match(/pm_25_b_(\d+|2[AB])/i);
  if (match) return match[1];

  return '';
}

// Liste tous les départements disponibles
export async function listAvailableDepartments(): Promise<string[]> {
  const tables = await fetchAvailableTables();
  const departments = new Set<string>();

  for (const table of tables) {
    const dept = extractDepartmentFromTable(table);
    if (dept) departments.add(dept);
  }

  return Array.from(departments).sort((a, b) => {
    // Tri numérique avec gestion de la Corse
    const aNum = parseInt(a);
    const bNum = parseInt(b);
    if (isNaN(aNum) && isNaN(bNum)) return a.localeCompare(b);
    if (isNaN(aNum)) return 1;
    if (isNaN(bNum)) return -1;
    return aNum - bNum;
  });
}

// Réinitialise le cache (utile pour les tests)
export function clearTableCache(): void {
  tableCache = null;
}
