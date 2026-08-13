/**
 * apiQuota.js — Control de cuota diaria de llamadas a Claude por empresa.
 *
 * Uso:
 *   const { checkQuota, registerUsage } = require("../middleware/apiQuota");
 *
 *   router.post("/chat", requireJWT, checkQuota, async (req, res) => {
 *     const response = await anthropic.messages.create(...);
 *     await registerUsage(req.jwtPayload.empresaId, response.usage);
 *     res.json({ reply: response.content[0].text });
 *   });
 *
 * Tabla api_usage:
 *   empresa_id | fecha | mensajes_usados | tokens_entrada | tokens_salida | limite_mensajes
 *
 * El límite por defecto es QUOTA_DEFAULT_DIARIA (50 mensajes/día).
 * El superadmin puede cambiarlo por empresa desde /api/admin/api-quota/:empresaId.
 */

const { db } = require("../db");

const QUOTA_DEFAULT_DIARIA = 50; // mensajes por día por empresa

// ── Asegurar tabla ────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS api_usage (
    empresa_id       TEXT    NOT NULL,
    fecha            TEXT    NOT NULL,          -- YYYY-MM-DD
    mensajes_usados  INTEGER NOT NULL DEFAULT 0,
    tokens_entrada   INTEGER NOT NULL DEFAULT 0,
    tokens_salida    INTEGER NOT NULL DEFAULT 0,
    limite_mensajes  INTEGER NOT NULL DEFAULT ${QUOTA_DEFAULT_DIARIA},
    PRIMARY KEY (empresa_id, fecha)
  );
`);

// ── Helpers internos ──────────────────────────────────────────────────────────
function hoy() {
  return new Date().toISOString().slice(0, 10); // "2026-08-13"
}

/**
 * Obtiene (o crea) la fila de uso de hoy para una empresa.
 * Si ya tiene un límite personalizado guardado, lo respeta.
 */
function getOrCreateUsage(empresaId) {
  const fecha = hoy();

  // Buscar límite personalizado previo para esta empresa (de cualquier día)
  const limitePersonalizado = db.prepare(`
    SELECT limite_mensajes FROM api_usage
    WHERE empresa_id = ?
    ORDER BY fecha DESC LIMIT 1
  `).get(empresaId)?.limite_mensajes ?? QUOTA_DEFAULT_DIARIA;

  db.prepare(`
    INSERT OR IGNORE INTO api_usage (empresa_id, fecha, mensajes_usados, tokens_entrada, tokens_salida, limite_mensajes)
    VALUES (?, ?, 0, 0, 0, ?)
  `).run(empresaId, fecha, limitePersonalizado);

  return db.prepare(
    "SELECT * FROM api_usage WHERE empresa_id = ? AND fecha = ?"
  ).get(empresaId, fecha);
}

// ── Middleware: checkQuota ─────────────────────────────────────────────────────
/**
 * Middleware Express. Bloquea la petición si la empresa superó su cuota diaria.
 * Adjunta req.apiUsage con los datos actuales.
 */
function checkQuota(req, res, next) {
  const empresaId = req.jwtPayload?.empresaId;
  if (!empresaId) return res.status(401).json({ error: "Sin empresa en el token." });

  // Superadmin nunca se bloquea
  if (req.jwtPayload?.rol === "superadmin") return next();

  const uso = getOrCreateUsage(empresaId);
  req.apiUsage = uso;

  if (uso.mensajes_usados >= uso.limite_mensajes) {
    return res.status(429).json({
      error: `Límite diario de ${uso.limite_mensajes} consultas de IA alcanzado. Se renueva mañana.`,
      mensajesUsados: uso.mensajes_usados,
      limite: uso.limite_mensajes,
      renovaEn: "mañana a las 00:00",
    });
  }

  next();
}

// ── Función: registerUsage ────────────────────────────────────────────────────
/**
 * Llama esto DESPUÉS de recibir la respuesta de Claude para registrar el uso.
 *
 * @param {string} empresaId
 * @param {{ input_tokens: number, output_tokens: number }} usage — objeto usage de la API de Anthropic
 */
function registerUsage(empresaId, usage = {}) {
  if (!empresaId) return;
  const fecha        = hoy();
  const tokensIn     = usage.input_tokens  || 0;
  const tokensOut    = usage.output_tokens || 0;

  db.prepare(`
    INSERT INTO api_usage (empresa_id, fecha, mensajes_usados, tokens_entrada, tokens_salida, limite_mensajes)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(empresa_id, fecha) DO UPDATE SET
      mensajes_usados = mensajes_usados + 1,
      tokens_entrada  = tokens_entrada  + ?,
      tokens_salida   = tokens_salida   + ?
  `).run(empresaId, fecha, tokensIn, tokensOut, QUOTA_DEFAULT_DIARIA, tokensIn, tokensOut);
}

// ── Función: getUsageStats ────────────────────────────────────────────────────
/**
 * Devuelve estadísticas de uso de los últimos N días para una o todas las empresas.
 * Usado por el admin panel.
 */
function getUsageStats({ empresaId = null, dias = 30 } = {}) {
  const desde = new Date(Date.now() - dias * 86400_000).toISOString().slice(0, 10);

  if (empresaId) {
    return db.prepare(`
      SELECT * FROM api_usage
      WHERE empresa_id = ? AND fecha >= ?
      ORDER BY fecha DESC
    `).all(empresaId, desde);
  }

  return db.prepare(`
    SELECT
      u.empresa_id,
      e.empresa_nombre,
      u.fecha,
      u.mensajes_usados,
      u.tokens_entrada,
      u.tokens_salida,
      u.limite_mensajes
    FROM api_usage u
    LEFT JOIN (
      SELECT DISTINCT empresa_id, empresa_nombre FROM users
    ) e ON e.empresa_id = u.empresa_id
    WHERE u.fecha >= ?
    ORDER BY u.fecha DESC, u.mensajes_usados DESC
  `).all(desde);
}

/**
 * Cambia el límite diario de una empresa (para todos los días futuros).
 */
function setLimiteEmpresa(empresaId, nuevoLimite) {
  const fecha = hoy();
  // Actualizar el día de hoy si existe
  db.prepare(`
    INSERT INTO api_usage (empresa_id, fecha, mensajes_usados, tokens_entrada, tokens_salida, limite_mensajes)
    VALUES (?, ?, 0, 0, 0, ?)
    ON CONFLICT(empresa_id, fecha) DO UPDATE SET limite_mensajes = ?
  `).run(empresaId, fecha, nuevoLimite, nuevoLimite);
}

module.exports = {
  checkQuota,
  registerUsage,
  getUsageStats,
  setLimiteEmpresa,
  QUOTA_DEFAULT_DIARIA,
};
