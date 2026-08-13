/**
 * certService.js — Gestión segura de certificados .p12 por empresa
 *
 * Encriptación: AES-256-GCM (authenticated encryption)
 * - La MASTER KEY vive solo en CERT_ENCRYPTION_KEY del .env del VPS (64 hex chars = 32 bytes)
 * - Nunca se guarda en la DB ni en logs
 * - Cada certificado tiene su propio IV aleatorio (12 bytes) y auth tag (16 bytes)
 * - Formato almacenado: iv_hex:authTag_hex:ciphertext_hex
 *
 * Si CERT_ENCRYPTION_KEY no está en el .env, se genera una de runtime (solo para dev).
 */

const crypto = require("crypto");
const { db } = require("./db");

// ── Clave maestra ─────────────────────────────────────────────────────────────
function getMasterKey() {
  const hex = process.env.CERT_ENCRYPTION_KEY;
  if (hex && hex.length === 64) {
    return Buffer.from(hex, "hex");
  }
  // Fallback dev: clave fija derivada del nombre de la app (NO usar en producción)
  console.warn(
    "[certService] ⚠️  CERT_ENCRYPTION_KEY no configurada en .env. Usando clave de desarrollo — INSEGURO para producción."
  );
  return crypto.scryptSync("organizalo-dev-key-2025", "organizalo-salt", 32);
}

// ── Primitivas AES-256-GCM ────────────────────────────────────────────────────
function encrypt(buffer) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12); // 96 bits recomendado para GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(stored) {
  const key = getMasterKey();
  const [ivHex, tagHex, ctHex] = stored.split(":");
  if (!ivHex || !tagHex || !ctHex) throw new Error("Formato de certificado inválido");
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(tagHex, "hex");
  const ct = Buffer.from(ctHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ── Asegurar tabla en DB ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS empresa_certs (
    empresa_id   TEXT PRIMARY KEY,
    cert_enc     TEXT NOT NULL,
    pass_enc     TEXT NOT NULL,
    cedula       TEXT,
    nombre       TEXT,
    subido_en    TEXT NOT NULL,
    actualizado_en TEXT NOT NULL
  );
`);

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Guarda (o reemplaza) el certificado .p12 de una empresa.
 * @param {string} empresaId
 * @param {Buffer} p12Buffer  — contenido binario del .p12
 * @param {string} password   — contraseña del .p12
 * @param {object} meta       — { cedula, nombre } del contribuyente
 */
function saveCert(empresaId, p12Buffer, password, meta = {}) {
  const certEnc = encrypt(p12Buffer);
  const passEnc = encrypt(Buffer.from(password, "utf8"));
  const now = new Date().toISOString();

  const exists = db
    .prepare("SELECT empresa_id FROM empresa_certs WHERE empresa_id = ?")
    .get(empresaId);

  if (exists) {
    db.prepare(`
      UPDATE empresa_certs
      SET cert_enc=?, pass_enc=?, cedula=?, nombre=?, actualizado_en=?
      WHERE empresa_id=?
    `).run(certEnc, passEnc, meta.cedula || null, meta.nombre || null, now, empresaId);
  } else {
    db.prepare(`
      INSERT INTO empresa_certs (empresa_id, cert_enc, pass_enc, cedula, nombre, subido_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(empresaId, certEnc, passEnc, meta.cedula || null, meta.nombre || null, now, now);
  }
}

/**
 * Obtiene el certificado descifrado de una empresa.
 * @returns {{ p12Buffer: Buffer, password: string, cedula: string, nombre: string } | null}
 */
function getCert(empresaId) {
  const row = db
    .prepare("SELECT * FROM empresa_certs WHERE empresa_id = ?")
    .get(empresaId);
  if (!row) return null;
  return {
    p12Buffer: decrypt(row.cert_enc),
    password: decrypt(row.pass_enc).toString("utf8"),
    cedula: row.cedula,
    nombre: row.nombre,
    subidoEn: row.subido_en,
  };
}

/**
 * Retorna solo el estado (sin desencriptar el cert) — para mostrar en UI.
 */
function getCertStatus(empresaId) {
  const row = db
    .prepare("SELECT empresa_id, cedula, nombre, subido_en FROM empresa_certs WHERE empresa_id = ?")
    .get(empresaId);
  if (!row) return null;
  return { configured: true, cedula: row.cedula, nombre: row.nombre, subidoEn: row.subido_en };
}

/**
 * Elimina el certificado de una empresa.
 */
function deleteCert(empresaId) {
  db.prepare("DELETE FROM empresa_certs WHERE empresa_id = ?").run(empresaId);
}

module.exports = { saveCert, getCert, getCertStatus, deleteCert };
