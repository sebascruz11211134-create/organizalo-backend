/**
 * dbManager.js — Gestión de bases de datos SQLite
 *
 * Arquitectura multi-tenant con aislamiento total por empresa:
 *   data/organizalo.db          ← DB compartida (users, access_codes, invites, admin)
 *   data/empresa_{id}.sqlite    ← DB privada por empresa (todos sus datos de negocio)
 *
 * Ventajas:
 *   - Imposible mezclar datos entre empresas aunque haya un bug
 *   - Backup, eliminación y restauración por empresa
 *   - El campo empresa_id en queries es redundante (pero se mantiene por compatibilidad)
 */

const path = require("path");
const fs   = require("fs");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");

// ── DB compartida ─────────────────────────────────────────────────────────────
const sharedPath = config.dbPath;
fs.mkdirSync(path.dirname(sharedPath), { recursive: true });

const sharedDb = new DatabaseSync(sharedPath);
sharedDb.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000;");

sharedDb.exec(`
  CREATE TABLE IF NOT EXISTS charla_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    fecha TEXT, tema TEXT, especialista TEXT,
    especialista_bio TEXT, link_reunion TEXT, actualizado_en TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    telefono TEXT,
    empresa_id TEXT,
    empresa_nombre TEXT,
    rol TEXT NOT NULL DEFAULT 'admin',
    plan TEXT NOT NULL DEFAULT 'trial',
    trial_ends TEXT,
    activo INTEGER NOT NULL DEFAULT 1,
    username TEXT,
    ntfy_token TEXT,
    creado_en TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invites (
    id TEXT PRIMARY KEY,
    empresa_id TEXT NOT NULL,
    empresa_nombre TEXT NOT NULL,
    invitado_por TEXT NOT NULL,
    email TEXT NOT NULL,
    rol TEXT NOT NULL DEFAULT 'colaborador',
    token TEXT UNIQUE NOT NULL,
    usado INTEGER NOT NULL DEFAULT 0,
    expira_en TEXT NOT NULL,
    creado_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS access_codes (
    id TEXT PRIMARY KEY,
    codigo TEXT UNIQUE NOT NULL,
    nombre_cliente TEXT,
    email_esperado TEXT,
    max_usos INTEGER NOT NULL DEFAULT 1,
    usos_actuales INTEGER NOT NULL DEFAULT 0,
    empresa_id TEXT,
    empresa_nombre TEXT,
    creado_en TEXT NOT NULL,
    expira_en TEXT
  );

  CREATE TABLE IF NOT EXISTS empresa_config (
    empresa_id TEXT PRIMARY KEY,
    modulos_json TEXT,
    ntfy_token TEXT,
    actualizado_en TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_notas (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    nota TEXT NOT NULL,
    creado_en TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
  );
`);

// Migraciones de schema compartido (idempotentes)
const sharedMigrations = [
  "ALTER TABLE users ADD COLUMN empresa_nombre TEXT",
  "ALTER TABLE users ADD COLUMN empresa_id TEXT",
  "ALTER TABLE users ADD COLUMN trial_ends TEXT",
  "ALTER TABLE users ADD COLUMN activo INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE users ADD COLUMN rol TEXT NOT NULL DEFAULT 'admin'",
  "ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'trial'",
  "ALTER TABLE users ADD COLUMN username TEXT",
  "ALTER TABLE users ADD COLUMN ntfy_token TEXT",
  "ALTER TABLE access_codes ADD COLUMN max_usos INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE access_codes ADD COLUMN usos_actuales INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE access_codes ADD COLUMN empresa_id TEXT",
  "ALTER TABLE access_codes ADD COLUMN empresa_nombre TEXT",
  "ALTER TABLE empresa_config ADD COLUMN ntfy_token TEXT",
];
for (const sql of sharedMigrations) {
  try { sharedDb.exec(sql); } catch (_) {}
}

// ── DB por empresa — cache en memoria ─────────────────────────────────────────
const empresaDbCache = new Map();
const dataDir = path.dirname(sharedPath);

function initEmpresaSchema(edb) {
  edb.exec(`
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      empresa_id TEXT,
      clave TEXT UNIQUE NOT NULL,
      numero_consecutivo TEXT NOT NULL,
      numero_documento INTEGER NOT NULL,
      cliente_nombre TEXT NOT NULL,
      cliente_cedula TEXT,
      cliente_correo TEXT,
      moneda TEXT NOT NULL DEFAULT 'CRC',
      total REAL NOT NULL,
      estado TEXT NOT NULL DEFAULT 'creado',
      modo_simulacion INTEGER NOT NULL DEFAULT 1,
      xml_firmado_base64 TEXT,
      respuesta_hacienda TEXT,
      items_json TEXT NOT NULL,
      creado_en TEXT NOT NULL,
      actualizado_en TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contador (
      clave TEXT PRIMARY KEY,
      valor INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cloud_data (
      empresa_id TEXT,
      clave TEXT NOT NULL,
      valor TEXT NOT NULL,
      actualizado_en TEXT NOT NULL,
      PRIMARY KEY (clave)
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      empresa_id TEXT,
      canal TEXT NOT NULL DEFAULT 'general',
      user_id TEXT NOT NULL,
      user_nombre TEXT NOT NULL,
      texto TEXT NOT NULL,
      creado_en TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_canal ON chat_messages(canal, creado_en);

    CREATE TABLE IF NOT EXISTS eventos (
      id TEXT PRIMARY KEY,
      empresa_id TEXT,
      titulo TEXT NOT NULL,
      descripcion TEXT,
      tipo TEXT NOT NULL DEFAULT 'evento',
      fecha TEXT NOT NULL,
      hora TEXT,
      todo_el_dia INTEGER NOT NULL DEFAULT 0,
      cliente_id TEXT,
      cliente_nombre TEXT,
      completado INTEGER NOT NULL DEFAULT 0,
      color TEXT DEFAULT '#10b981',
      creado_en TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eventos_fecha ON eventos(fecha);

    CREATE TABLE IF NOT EXISTS crm_interacciones (
      id TEXT PRIMARY KEY,
      empresa_id TEXT,
      cliente_id TEXT NOT NULL,
      cliente_nombre TEXT,
      tipo TEXT NOT NULL DEFAULT 'nota',
      titulo TEXT,
      descripcion TEXT NOT NULL,
      fecha TEXT NOT NULL,
      creado_en TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_crm_cliente ON crm_interacciones(cliente_id);
  `);

  // Migraciones de schema empresa (idempotentes)
  const migrations = [
    "ALTER TABLE cloud_data ADD COLUMN empresa_id TEXT",
    "ALTER TABLE chat_messages ADD COLUMN empresa_id TEXT",
    "ALTER TABLE invoices ADD COLUMN empresa_id TEXT",
  ];
  for (const sql of migrations) {
    try { edb.exec(sql); } catch (_) {}
  }
}

function getEmpresaDb(empresaId) {
  if (!empresaId) throw new Error("empresaId requerido para getEmpresaDb");
  if (empresaDbCache.has(empresaId)) return empresaDbCache.get(empresaId);

  const dbPath = path.join(dataDir, `empresa_${empresaId}.sqlite`);
  const edb = new DatabaseSync(dbPath);
  edb.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000;");
  initEmpresaSchema(edb);
  empresaDbCache.set(empresaId, edb);
  return edb;
}

function nextNumeroDocumento(empresaId) {
  const edb = getEmpresaDb(empresaId);
  const row = edb.prepare("SELECT valor FROM contador WHERE clave = 'numero_documento'").get();
  const siguiente = (row?.valor || 0) + 1;
  edb.prepare(
    "INSERT INTO contador (clave, valor) VALUES ('numero_documento', ?) ON CONFLICT(clave) DO UPDATE SET valor = ?"
  ).run(siguiente, siguiente);
  return siguiente;
}

module.exports = { sharedDb, getEmpresaDb, nextNumeroDocumento };
