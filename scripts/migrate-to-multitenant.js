#!/usr/bin/env node
/**
 * migrate-to-multitenant.js
 *
 * Script one-time para migrar el SQLite compartido al esquema multi-tenant.
 * Lee el DB viejo (organizalo.db) y distribuye los datos en archivos por empresa.
 *
 * Uso:
 *   node scripts/migrate-to-multitenant.js
 *   node scripts/migrate-to-multitenant.js --dry-run   (solo muestra qué haría)
 */

const path = require("path");
const fs   = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DRY_RUN = process.argv.includes("--dry-run");

const DATA_DIR  = path.resolve(__dirname, "../data");
const OLD_DB    = path.join(DATA_DIR, "organizalo.db");
const BACKUP_DB = path.join(DATA_DIR, `organizalo.backup.${Date.now()}.db`);

if (!fs.existsSync(OLD_DB)) {
  console.log("✓ No hay DB legada que migrar. Sistema ya en modo multi-tenant.");
  process.exit(0);
}

console.log("═══════════════════════════════════════════════════");
console.log("  Organízalo.AI — Migración a Multi-Tenant SQLite  ");
console.log("═══════════════════════════════════════════════════");
if (DRY_RUN) console.log("  MODO DRY-RUN: no se escriben archivos\n");

// ── Abrir DB legada ────────────────────────────────────────────────────────────
const oldDb = new DatabaseSync(OLD_DB);

// ── Leer todas las empresas ────────────────────────────────────────────────────
const users = oldDb.prepare("SELECT DISTINCT empresa_id FROM users WHERE empresa_id IS NOT NULL").all();
const empresaIds = users.map(r => r.empresa_id).filter(Boolean);
console.log(`\n  Empresas encontradas: ${empresaIds.length}\n`);

// ── Función para abrir/crear DB de empresa ─────────────────────────────────────
function openEmpresaDb(empresaId) {
  const dbPath = path.join(DATA_DIR, `empresa_${empresaId}.sqlite`);
  const edb = new DatabaseSync(dbPath);
  edb.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000;");
  edb.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY, empresa_id TEXT, clave TEXT UNIQUE NOT NULL,
      numero_consecutivo TEXT NOT NULL, numero_documento INTEGER NOT NULL,
      cliente_nombre TEXT NOT NULL, cliente_cedula TEXT, cliente_correo TEXT,
      moneda TEXT NOT NULL DEFAULT 'CRC', total REAL NOT NULL,
      estado TEXT NOT NULL DEFAULT 'creado', modo_simulacion INTEGER NOT NULL DEFAULT 1,
      xml_firmado_base64 TEXT, respuesta_hacienda TEXT, items_json TEXT NOT NULL,
      creado_en TEXT NOT NULL, actualizado_en TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contador (
      clave TEXT PRIMARY KEY, valor INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cloud_data (
      empresa_id TEXT, clave TEXT NOT NULL, valor TEXT NOT NULL,
      actualizado_en TEXT NOT NULL, PRIMARY KEY (clave)
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY, empresa_id TEXT, canal TEXT NOT NULL DEFAULT 'general',
      user_id TEXT NOT NULL, user_nombre TEXT NOT NULL, texto TEXT NOT NULL, creado_en TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS eventos (
      id TEXT PRIMARY KEY, empresa_id TEXT, titulo TEXT NOT NULL, descripcion TEXT,
      tipo TEXT NOT NULL DEFAULT 'evento', fecha TEXT NOT NULL, hora TEXT,
      todo_el_dia INTEGER NOT NULL DEFAULT 0, cliente_id TEXT, cliente_nombre TEXT,
      completado INTEGER NOT NULL DEFAULT 0, color TEXT DEFAULT '#10b981', creado_en TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS crm_interacciones (
      id TEXT PRIMARY KEY, empresa_id TEXT, cliente_id TEXT NOT NULL, cliente_nombre TEXT,
      tipo TEXT NOT NULL DEFAULT 'nota', titulo TEXT, descripcion TEXT NOT NULL,
      fecha TEXT NOT NULL, creado_en TEXT NOT NULL
    );
  `);
  return edb;
}

// ── Migrar tabla por empresa ──────────────────────────────────────────────────
function migrarTabla(tabla, empresaId, edb, sinFiltro = false) {
  let rows;
  try {
    rows = sinFiltro
      ? oldDb.prepare(`SELECT * FROM ${tabla}`).all()
      : oldDb.prepare(`SELECT * FROM ${tabla} WHERE empresa_id = ?`).all(empresaId);
  } catch (e) {
    console.log(`    ⚠ tabla ${tabla} no encontrada en DB legada, saltando.`);
    return 0;
  }

  if (rows.length === 0) return 0;

  if (DRY_RUN) {
    console.log(`    → ${tabla}: ${rows.length} filas (dry-run, no escrito)`);
    return rows.length;
  }

  const cols = Object.keys(rows[0]);
  const placeholders = cols.map(() => "?").join(", ");
  const stmt = edb.prepare(
    `INSERT OR IGNORE INTO ${tabla} (${cols.join(", ")}) VALUES (${placeholders})`
  );

  let migradas = 0;
  for (const row of rows) {
    try {
      stmt.run(...cols.map(c => row[c]));
      migradas++;
    } catch (e) {
      // Conflicto de UNIQUE — ya migrado antes, ok
    }
  }

  return migradas;
}

// ── Migrar datos de contador por empresa ───────────────────────────────────────
function migrarContador(empresaId, edb) {
  let rows;
  try {
    rows = oldDb.prepare("SELECT * FROM contador").all();
  } catch {
    return;
  }
  if (DRY_RUN) { console.log(`    → contador: ${rows.length} filas`); return; }
  for (const row of rows) {
    try {
      edb.prepare("INSERT OR IGNORE INTO contador (clave, valor) VALUES (?, ?)").run(row.clave, row.valor);
    } catch {}
  }
}

// ── Ejecutar migración ────────────────────────────────────────────────────────
let totalMigrado = 0;

for (const empresaId of empresaIds) {
  console.log(`  📁 Empresa: ${empresaId}`);
  const edb = openEmpresaDb(empresaId);

  const tablas = ["invoices", "cloud_data", "chat_messages", "eventos", "crm_interacciones"];
  for (const tabla of tablas) {
    const n = migrarTabla(tabla, empresaId, edb);
    if (n > 0) console.log(`    ✓ ${tabla}: ${n} filas`);
    totalMigrado += n;
  }

  migrarContador(empresaId, edb);
  console.log();
}

// ── Backup del DB viejo ────────────────────────────────────────────────────────
if (!DRY_RUN) {
  fs.copyFileSync(OLD_DB, BACKUP_DB);
  console.log(`  💾 Backup guardado en: ${path.basename(BACKUP_DB)}`);
  console.log(`  ✓ Total migrado: ${totalMigrado} filas`);
  console.log(`\n  ✅ Migración completa. El sistema ahora usa DBs por empresa.\n`);
  console.log(`  Nota: organizalo.db se mantiene para users, access_codes, etc.`);
  console.log(`  Podés eliminar el backup cuando hayas verificado todo.\n`);
} else {
  console.log(`\n  [DRY-RUN] Se habrían migrado ${totalMigrado} filas.\n`);
}
