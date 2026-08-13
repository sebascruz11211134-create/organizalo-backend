/**
 * ntfy.js — Notificaciones push por empresa Y por usuario.
 *
 * Arquitectura:
 *  - Cada empresa tiene un topic compartido (para todos sus usuarios).
 *  - Cada usuario tiene su propio topic personal.
 *  - notifyByPrefs() enruta a cada usuario individual según sus preferencias.
 *
 * Tipos de notificación disponibles (TIPOS_NOTIF):
 *   cobro_vencido, factura_emitida, inventario_bajo,
 *   whatsapp_desconectado, nuevo_cliente, recordatorio_evento
 *
 * Documentación: https://docs.ntfy.sh/publish/
 */

const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");

const NTFY_BASE_URL   = process.env.NTFY_URL        || "https://ntfy.sh";
const NTFY_AUTH_TOKEN = process.env.NTFY_AUTH_TOKEN || "";

// ── Tipos de notificación ─────────────────────────────────────────────────────
const TIPOS_NOTIF = [
  { id: "cobro_vencido",         label: "Cobros vencidos",          icon: "💰", defaultAdmin: true,  defaultColab: true  },
  { id: "factura_emitida",       label: "Facturas emitidas",        icon: "✅", defaultAdmin: true,  defaultColab: true  },
  { id: "inventario_bajo",       label: "Inventario bajo",          icon: "📦", defaultAdmin: true,  defaultColab: false },
  { id: "whatsapp_desconectado", label: "WhatsApp desconectado",    icon: "⚠️", defaultAdmin: true,  defaultColab: false },
  { id: "nuevo_cliente",         label: "Nuevos clientes (CRM)",    icon: "👤", defaultAdmin: true,  defaultColab: false },
  { id: "recordatorio_evento",   label: "Recordatorios de eventos", icon: "📅", defaultAdmin: true,  defaultColab: true  },
];

// ── Helpers de token ──────────────────────────────────────────────────────────
function generateNtfyToken() {
  return uuidv4().replace(/-/g, "").substring(0, 20);
}

function getTopicForEmpresa(ntfyToken) {
  return `organizalo-${ntfyToken}`;
}

function getTopicForUser(ntfyToken) {
  return `organizalo-u-${ntfyToken}`;
}

// ── Token de empresa ──────────────────────────────────────────────────────────
function getOrCreateNtfyToken(empresaId, sharedDb) {
  const cfg = sharedDb.prepare("SELECT ntfy_token FROM empresa_config WHERE empresa_id = ?").get(empresaId);
  if (cfg?.ntfy_token) return cfg.ntfy_token;

  const token = generateNtfyToken();
  const now   = new Date().toISOString();
  sharedDb.prepare(`
    INSERT INTO empresa_config (empresa_id, ntfy_token, actualizado_en)
    VALUES (?, ?, ?)
    ON CONFLICT(empresa_id) DO UPDATE SET ntfy_token = ?, actualizado_en = ?
  `).run(empresaId, token, now, token, now);
  return token;
}

// ── Token personal por usuario ────────────────────────────────────────────────
// Requiere columna ntfy_token en users (se crea via ALTER TABLE en el router)
function getOrCreateUserNtfyToken(userId, sharedDb) {
  const row = sharedDb.prepare("SELECT ntfy_token FROM users WHERE id = ?").get(userId);
  if (row?.ntfy_token) return row.ntfy_token;

  const token = generateNtfyToken();
  sharedDb.prepare("UPDATE users SET ntfy_token = ? WHERE id = ?").run(token, userId);
  return token;
}

// ── Preferencias de usuario ───────────────────────────────────────────────────
/**
 * Devuelve las preferencias del usuario como objeto { tipo: boolean }.
 * Si no tiene fila guardada, usa el default según su rol.
 */
function getUserPrefs(userId, rol, sharedDb) {
  const rows = sharedDb.prepare(
    "SELECT tipo, activo FROM user_ntfy_prefs WHERE user_id = ?"
  ).all(userId);

  const saved = {};
  rows.forEach(r => { saved[r.tipo] = r.activo === 1; });

  const prefs = {};
  TIPOS_NOTIF.forEach(t => {
    if (t.id in saved) {
      prefs[t.id] = saved[t.id];
    } else {
      // Sin configuración explícita: default según rol
      prefs[t.id] = rol === "admin" || rol === "superadmin"
        ? t.defaultAdmin
        : t.defaultColab;
    }
  });
  return prefs;
}

/**
 * Guarda las preferencias de un usuario (objeto { tipo: boolean }).
 */
function saveUserPrefs(userId, prefs, sharedDb) {
  const now = new Date().toISOString();
  const upsert = sharedDb.prepare(`
    INSERT INTO user_ntfy_prefs (user_id, tipo, activo, actualizado_en)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, tipo) DO UPDATE SET activo = ?, actualizado_en = ?
  `);
  const transaction = sharedDb.transaction((entries) => {
    entries.forEach(([tipo, activo]) => {
      upsert.run(userId, tipo, activo ? 1 : 0, now, activo ? 1 : 0, now);
    });
  });
  transaction(Object.entries(prefs));
}

// ── Enviar notificación a un topic ────────────────────────────────────────────
async function sendToTopic(topic, { title, message, priority = "default", tags = [] }) {
  const url = `${NTFY_BASE_URL}/${topic}`;
  const headers = {
    "Title":        title,
    "Priority":     priority,
    "Content-Type": "text/plain",
  };
  if (tags.length > 0) headers["Tags"] = tags.join(",");
  if (NTFY_AUTH_TOKEN)  headers["Authorization"] = `Bearer ${NTFY_AUTH_TOKEN}`;

  await fetch(url, { method: "POST", headers, body: message });
}

// ── notify() — envía al topic de empresa (broadcast) ─────────────────────────
async function notify({ empresaId, title, message, priority = "default", tags = [] }, sharedDb) {
  if (!empresaId) return;
  try {
    const ntfyToken = getOrCreateNtfyToken(empresaId, sharedDb);
    const topic     = getTopicForEmpresa(ntfyToken);
    await sendToTopic(topic, { title, message, priority, tags });
    console.log(`[ntfy] ✓ broadcast empresa ${empresaId}: ${title}`);
  } catch (err) {
    console.error("[ntfy] ✗ Error broadcast:", err.message);
  }
}

// ── notifyByPrefs() — enruta a cada usuario según sus preferencias ────────────
/**
 * Envía a cada usuario activo de la empresa que tiene ese tipo habilitado.
 * Si nadie tiene preferencias guardadas, cae a notify() (broadcast).
 */
async function notifyByPrefs({ tipo, empresaId, title, message, priority = "default", tags = [] }, sharedDb) {
  if (!empresaId) return;
  try {
    // Obtener todos los usuarios activos de la empresa
    const usuarios = sharedDb.prepare(
      "SELECT id, rol, ntfy_token FROM users WHERE empresa_id = ? AND activo = 1"
    ).all(empresaId);

    if (!usuarios.length) return;

    let enviados = 0;
    for (const u of usuarios) {
      const prefs = getUserPrefs(u.id, u.rol, sharedDb);
      if (!prefs[tipo]) continue; // este usuario no quiere este tipo

      // Asegurar que tiene topic propio
      const userToken = u.ntfy_token || getOrCreateUserNtfyToken(u.id, sharedDb);
      const topic     = getTopicForUser(userToken);
      await sendToTopic(topic, { title, message, priority, tags });
      enviados++;
    }

    console.log(`[ntfy] ✓ "${tipo}" enviado a ${enviados}/${usuarios.length} usuarios de empresa ${empresaId}`);
  } catch (err) {
    console.error("[ntfy] ✗ Error notifyByPrefs:", err.message);
  }
}

// ── Shortcuts ─────────────────────────────────────────────────────────────────
const ntfy = {
  cobro: (empresaId, clienteNombre, monto, moneda, sharedDb) =>
    notifyByPrefs({
      tipo: "cobro_vencido",
      empresaId,
      title: "💰 Recordatorio de cobro",
      message: `${clienteNombre} tiene un saldo pendiente de ${moneda === "USD" ? "$" : "₡"}${Number(monto).toLocaleString("es-CR")}`,
      priority: "high",
      tags: ["moneybag"],
    }, sharedDb),

  whatsappDesconectado: (empresaId, sharedDb) =>
    notifyByPrefs({
      tipo: "whatsapp_desconectado",
      empresaId,
      title: "⚠️ WhatsApp desconectado",
      message: "Tu WhatsApp de Organízalo se desconectó. Entrá a Configuración → WhatsApp para reconectar.",
      priority: "high",
      tags: ["warning", "phone"],
    }, sharedDb),

  facturaEmitida: (empresaId, clienteNombre, total, moneda, sharedDb) =>
    notifyByPrefs({
      tipo: "factura_emitida",
      empresaId,
      title: "✅ Factura emitida",
      message: `Factura para ${clienteNombre} por ${moneda === "USD" ? "$" : "₡"}${Number(total).toLocaleString("es-CR")} enviada a Hacienda.`,
      priority: "default",
      tags: ["white_check_mark"],
    }, sharedDb),

  inventarioBajo: (empresaId, producto, stock, sharedDb) =>
    notifyByPrefs({
      tipo: "inventario_bajo",
      empresaId,
      title: "📦 Stock bajo",
      message: `${producto} tiene solo ${stock} unidades en inventario.`,
      priority: "default",
      tags: ["package", "warning"],
    }, sharedDb),

  nuevoCliente: (empresaId, nombre, sharedDb) =>
    notifyByPrefs({
      tipo: "nuevo_cliente",
      empresaId,
      title: "👤 Nuevo cliente",
      message: `${nombre} fue agregado al CRM.`,
      priority: "default",
      tags: ["bust_in_silhouette"],
    }, sharedDb),

  recordatorioEvento: (empresaId, titulo, fecha, sharedDb) =>
    notifyByPrefs({
      tipo: "recordatorio_evento",
      empresaId,
      title: "📅 Recordatorio",
      message: `${titulo} — ${fecha}`,
      priority: "default",
      tags: ["calendar"],
    }, sharedDb),

  // Test: va al topic personal del usuario que lo solicita (no broadcast)
  testUsuario: async (userId, sharedDb) => {
    try {
      const userToken = getOrCreateUserNtfyToken(userId, sharedDb);
      const topic     = getTopicForUser(userToken);
      await sendToTopic(topic, {
        title:   "🎉 Organízalo.AI",
        message: "¡Tus notificaciones personales están funcionando!",
        tags:    ["tada"],
      });
    } catch (err) {
      console.error("[ntfy] ✗ Error test usuario:", err.message);
    }
  },

  // Test empresa (broadcast a todos) — se mantiene para compatibilidad
  test: (empresaId, sharedDb) =>
    notify({
      empresaId,
      title:   "🎉 Organízalo.AI",
      message: "¡Las notificaciones están funcionando correctamente!",
      tags:    ["tada"],
    }, sharedDb),
};

module.exports = {
  notify,
  notifyByPrefs,
  ntfy,
  generateNtfyToken,
  getOrCreateNtfyToken,
  getOrCreateUserNtfyToken,
  getTopicForEmpresa,
  getTopicForUser,
  getUserPrefs,
  saveUserPrefs,
  TIPOS_NOTIF,
  NTFY_BASE_URL,
};
