/**
 * ntfy.js — Notificaciones push por empresa via ntfy.sh o servidor propio.
 *
 * Cada empresa tiene un topic privado: {NTFY_BASE_URL}/{empresaId}-{ntfyToken}
 * El token se genera al registrar la empresa y se guarda en empresa_config.
 *
 * Documentación: https://docs.ntfy.sh/publish/
 */

const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");

const NTFY_BASE_URL = process.env.NTFY_URL || "https://ntfy.sh";
const NTFY_AUTH_TOKEN = process.env.NTFY_AUTH_TOKEN || ""; // token de admin del servidor propio

/**
 * Genera un token único para el topic de una empresa.
 * Llamar al registrar una empresa nueva.
 */
function generateNtfyToken() {
  return uuidv4().replace(/-/g, "").substring(0, 20);
}

/**
 * Construye el nombre del topic para una empresa.
 * Formato: organizalo-{token} (imposible de adivinar por terceros)
 */
function getTopicForEmpresa(ntfyToken) {
  return `organizalo-${ntfyToken}`;
}

/**
 * Obtiene el ntfy_token de una empresa desde empresa_config.
 * Si no existe, lo crea y lo guarda.
 */
function getOrCreateNtfyToken(empresaId, sharedDb) {
  let cfg = sharedDb.prepare("SELECT ntfy_token FROM empresa_config WHERE empresa_id = ?").get(empresaId);

  if (!cfg?.ntfy_token) {
    const token = generateNtfyToken();
    const now   = new Date().toISOString();
    sharedDb.prepare(`
      INSERT INTO empresa_config (empresa_id, ntfy_token, actualizado_en)
      VALUES (?, ?, ?)
      ON CONFLICT(empresa_id) DO UPDATE SET ntfy_token = ?, actualizado_en = ?
    `).run(empresaId, token, now, token, now);
    return token;
  }

  return cfg.ntfy_token;
}

/**
 * Envía una notificación push a la empresa.
 *
 * @param {object} opts
 * @param {string} opts.empresaId
 * @param {string} opts.title     — Título de la notificación
 * @param {string} opts.message   — Cuerpo del mensaje
 * @param {string} [opts.priority] — "low" | "default" | "high" | "urgent" (default: "default")
 * @param {string[]} [opts.tags]  — Emojis/tags de ntfy, ej: ["moneybag", "warning"]
 * @param {object} sharedDb       — Instancia de la DB compartida (para leer el token)
 */
async function notify({ empresaId, title, message, priority = "default", tags = [] }, sharedDb) {
  if (!empresaId) return;

  try {
    const ntfyToken = getOrCreateNtfyToken(empresaId, sharedDb);
    const topic     = getTopicForEmpresa(ntfyToken);
    const url       = `${NTFY_BASE_URL}/${topic}`;

    const headers = {
      "Title":    title,
      "Priority": priority,
      "Content-Type": "text/plain",
    };

    if (tags.length > 0) headers["Tags"] = tags.join(",");
    if (NTFY_AUTH_TOKEN) headers["Authorization"] = `Bearer ${NTFY_AUTH_TOKEN}`;

    await fetch(url, {
      method: "POST",
      headers,
      body: message,
    });

    console.log(`[ntfy] ✓ Notificación enviada a empresa ${empresaId}: ${title}`);
  } catch (err) {
    console.error(`[ntfy] ✗ Error enviando notificación:`, err.message);
    // No relanzar — las notificaciones no deben bloquear el flujo principal
  }
}

/**
 * Shortcuts para casos de uso comunes
 */
const ntfy = {
  // Recordatorio de cobro vencido
  cobro: (empresaId, clienteNombre, monto, moneda, sharedDb) =>
    notify({
      empresaId,
      title: "💰 Recordatorio de cobro",
      message: `${clienteNombre} tiene un saldo pendiente de ${moneda === "USD" ? "$" : "₡"}${Number(monto).toLocaleString("es-CR")}`,
      priority: "high",
      tags: ["moneybag"],
    }, sharedDb),

  // WhatsApp desconectado
  whatsappDesconectado: (empresaId, sharedDb) =>
    notify({
      empresaId,
      title: "⚠️ WhatsApp desconectado",
      message: "Tu WhatsApp de Organízalo se desconectó. Entrá a Configuración → WhatsApp para reconectar.",
      priority: "high",
      tags: ["warning", "phone"],
    }, sharedDb),

  // Factura emitida
  facturaEmitida: (empresaId, clienteNombre, total, moneda, sharedDb) =>
    notify({
      empresaId,
      title: "✅ Factura emitida",
      message: `Factura para ${clienteNombre} por ${moneda === "USD" ? "$" : "₡"}${Number(total).toLocaleString("es-CR")} enviada a Hacienda.`,
      priority: "default",
      tags: ["white_check_mark"],
    }, sharedDb),

  // Inventario bajo
  inventarioBajo: (empresaId, producto, stock, sharedDb) =>
    notify({
      empresaId,
      title: "📦 Stock bajo",
      message: `${producto} tiene solo ${stock} unidades en inventario.`,
      priority: "default",
      tags: ["package", "warning"],
    }, sharedDb),

  // Test / prueba de conexión
  test: (empresaId, sharedDb) =>
    notify({
      empresaId,
      title: "🎉 Organízalo.AI",
      message: "¡Las notificaciones están funcionando correctamente!",
      priority: "default",
      tags: ["tada"],
    }, sharedDb),
};

module.exports = { notify, ntfy, generateNtfyToken, getOrCreateNtfyToken, getTopicForEmpresa, NTFY_BASE_URL };
