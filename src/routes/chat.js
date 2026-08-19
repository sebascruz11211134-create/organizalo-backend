/**
 * /api/chat — Chat interno por empresa.
 * Cada empresa tiene su propio SQLite — datos completamente aislados.
 */

const express   = require("express");
const { v4: uuidv4 } = require("uuid");
const jwt       = require("jsonwebtoken");
const Anthropic  = require("@anthropic-ai/sdk");
const { db, getEmpresaDb } = require("../db");
const config    = require("../config");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SOPORTE_SYSTEM = `Sos el asistente de soporte técnico de Organízalo.AI, un sistema de gestión empresarial para pymes costarricenses.

Tu trabajo es resolver dudas y problemas de los usuarios de forma clara y directa. Respondés en español de Costa Rica (tuteo, sin "vosotros").

Lo que puede hacer Organízalo.AI:
- Facturación electrónica v4.4 compatible con Hacienda CR
- Punto de venta (POS) con escáner de código de barras
- Cotizaciones y pedidos
- Compras y facturas de proveedor / recepción masiva de XMLs
- CXC (cuentas por cobrar) y CXP (cuentas por pagar)
- Inventario con bodegas
- Contactos con código CLI-XXXX
- Recibos de caja y conciliación bancaria
- Planillas, D104, activos fijos, presupuesto, proyectos
- Chat interno por canales

Errores comunes y soluciones:
- "No aparece en el dropdown de cliente": el contacto debe estar registrado primero en Maestros → Contactos
- "No reduce inventario": el producto debe tener stock mayor a 0 en Inventario
- "Error al emitir factura": verificar que la cédula del receptor sea correcta y que el ambiente Hacienda esté configurado
- "No puedo iniciar sesión": verificar email y contraseña, o usar "olvidé contraseña"
- "No se sincroniza": verificar conexión a internet y que el backend esté activo

Si no podés resolver el problema — porque es un bug real, un error técnico que requiere cambios en el código, o algo que está claramente roto — respondés exactamente así:
"Entiendo el problema. Ya lo reporté al equipo de desarrollo, te contactamos pronto para resolverlo."
No intentés inventar una solución si no la sabés. Es mejor escalar honestamente que confundir al usuario.

Respondés de forma concisa, máximo 3-4 párrafos. No inventés funcionalidades que no existen.`;

const router = express.Router();
const CANALES_DEFAULT = ["general", "facturación", "contabilidad", "inventario", "soporte"];

// ── Typing indicator — en memoria, sin DB (ephemeral) ─────────────────────────
// typingStore[empresaId][canal][userId] = { nombre, expires }
const typingStore = {};
const TYPING_TTL  = 4000; // ms

function setTyping(empresaId, canal, userId, nombre) {
  if (!typingStore[empresaId]) typingStore[empresaId] = {};
  if (!typingStore[empresaId][canal]) typingStore[empresaId][canal] = {};
  typingStore[empresaId][canal][userId] = { nombre, expires: Date.now() + TYPING_TTL };
}

function getTyping(empresaId, canal, excludeUserId) {
  const now = Date.now();
  const bucket = typingStore[empresaId]?.[canal] || {};
  return Object.entries(bucket)
    .filter(([uid, v]) => uid !== excludeUserId && v.expires > now)
    .map(([, v]) => v.nombre);
}

function requireJWT(req, res, next) {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token requerido." });
  try {
    req.jwtPayload = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido." });
  }
}

// ── GET /api/chat/canales ─────────────────────────────────────────────────────
router.get("/canales", requireJWT, (req, res) => {
  const { empresaId } = req.jwtPayload;
  const edb = getEmpresaDb(empresaId);
  const canales = CANALES_DEFAULT.map(canal => {
    const ultimo = edb.prepare(
      "SELECT texto, user_nombre, creado_en FROM chat_messages WHERE canal = ? ORDER BY creado_en DESC LIMIT 1"
    ).get(canal);
    const total = edb.prepare("SELECT COUNT(*) as n FROM chat_messages WHERE canal = ?").get(canal);
    return { id: canal, nombre: canal.charAt(0).toUpperCase() + canal.slice(1), ultimo, totalMensajes: total.n };
  });
  res.json({ canales });
});

// ── GET /api/chat/mensajes/:canal ─────────────────────────────────────────────
router.get("/mensajes/:canal", requireJWT, (req, res) => {
  const { empresaId } = req.jwtPayload;
  const edb = getEmpresaDb(empresaId);
  const { canal } = req.params;
  const { desde } = req.query;

  const mensajes = desde
    ? edb.prepare(
        "SELECT * FROM chat_messages WHERE canal = ? AND creado_en > ? ORDER BY creado_en ASC LIMIT 100"
      ).all(canal, desde)
    : edb.prepare(
        "SELECT * FROM chat_messages WHERE canal = ? ORDER BY creado_en DESC LIMIT 50"
      ).all(canal).reverse();

  res.json({ mensajes });
});

// ── POST /api/chat/mensajes/:canal ────────────────────────────────────────────
router.post("/mensajes/:canal", requireJWT, (req, res) => {
  const { empresaId, sub: userId } = req.jwtPayload;
  const edb = getEmpresaDb(empresaId);
  const { canal } = req.params;
  const { texto } = req.body || {};

  if (!texto || typeof texto !== "string" || texto.trim().length === 0)
    return res.status(400).json({ error: "Mensaje vacío." });
  if (texto.length > 2000)
    return res.status(400).json({ error: "Mensaje demasiado largo (máx 2000 chars)." });

  const user   = db.prepare("SELECT nombre FROM users WHERE id = ?").get(userId);
  const nombre = user?.nombre || "Usuario";
  const id     = uuidv4();
  const now    = new Date().toISOString();

  edb.prepare(
    "INSERT INTO chat_messages (id, empresa_id, canal, user_id, user_nombre, texto, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, empresaId, canal, userId, nombre, texto.trim(), now);

  const mensaje = { id, empresaId, canal, userId, userNombre: nombre, texto: texto.trim(), creadoEn: now };
  const io = req.app.get("io");
  if (io) io.to(`empresa:${empresaId}:${canal}`).emit("mensaje", mensaje);

  res.status(201).json({ mensaje });

  if (canal === "soporte" && process.env.ANTHROPIC_API_KEY) {
    responderConIA({ empresaId, canal, texto: texto.trim(), io, edb }).catch(err => {
      console.error("[soporte-ia]", err.message);
    });
  }
});

// ── POST /api/chat/typing/:canal — "estoy escribiendo" ────────────────────────
router.post("/typing/:canal", requireJWT, (req, res) => {
  const { empresaId, sub: userId } = req.jwtPayload;
  const { canal } = req.params;
  const user   = db.prepare("SELECT nombre FROM users WHERE id = ?").get(userId);
  const nombre = user?.nombre || "Usuario";
  setTyping(empresaId, canal, userId, nombre);
  const io = req.app.get("io");
  if (io) {
    const writers = getTyping(empresaId, canal, null); // broadcast incluye a todos
    io.to(`empresa:${empresaId}:${canal}`).emit("typing", { writers, canal });
  }
  res.json({ ok: true });
});

// ── GET /api/chat/typing/:canal — quién está escribiendo ─────────────────────
router.get("/typing/:canal", requireJWT, (req, res) => {
  const { empresaId, sub: userId } = req.jwtPayload;
  const { canal } = req.params;
  const writers = getTyping(empresaId, canal, userId);
  res.json({ writers });
});

// ── POST /api/chat/mensajes/:canal/leer — marcar como leídos ─────────────────
router.post("/mensajes/:canal/leer", requireJWT, (req, res) => {
  const { empresaId, sub: userId } = req.jwtPayload;
  const edb = getEmpresaDb(empresaId);
  const { canal } = req.params;

  // Crear tabla si no existe
  edb.prepare(`
    CREATE TABLE IF NOT EXISTS chat_leidos (
      id         TEXT PRIMARY KEY,
      canal      TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      leido_en   TEXT NOT NULL,
      UNIQUE(canal, user_id)
    )
  `).run();

  const now = new Date().toISOString();
  edb.prepare(
    "INSERT OR REPLACE INTO chat_leidos (id, canal, user_id, leido_en) VALUES (?, ?, ?, ?)"
  ).run(uuidv4(), canal, userId, now);

  // Emitir visto a todos en la sala
  const io = req.app.get("io");
  if (io) io.to(`empresa:${empresaId}:${canal}`).emit("leido", { canal, userId, leido_en: now });

  res.json({ ok: true });
});

// ── GET /api/chat/mensajes/:canal/lecturas — quiénes leyeron ─────────────────
router.get("/mensajes/:canal/lecturas", requireJWT, (req, res) => {
  const { empresaId } = req.jwtPayload;
  const edb = getEmpresaDb(empresaId);
  const { canal } = req.params;
  try {
    edb.prepare(`CREATE TABLE IF NOT EXISTS chat_leidos (
      id TEXT PRIMARY KEY, canal TEXT NOT NULL, user_id TEXT NOT NULL,
      leido_en TEXT NOT NULL, UNIQUE(canal, user_id)
    )`).run();
    const lecturas = edb.prepare(
      "SELECT user_id, leido_en FROM chat_leidos WHERE canal = ?"
    ).all(canal);
    res.json({ lecturas });
  } catch {
    res.json({ lecturas: [] });
  }
});

// ── Respuesta IA automática en canal soporte ──────────────────────────────────
async function responderConIA({ empresaId, canal, texto, io, edb }) {
  const historial = edb.prepare(
    "SELECT user_nombre, texto FROM chat_messages WHERE canal = ? ORDER BY creado_en DESC LIMIT 10"
  ).all(canal).reverse();

  const messages = historial.map(m => ({
    role: m.user_nombre === "Asistente Organízalo" ? "assistant" : "user",
    content: m.user_nombre === "Asistente Organízalo" ? m.texto : `${m.user_nombre}: ${m.texto}`,
  }));

  if (messages.length === 0 || messages[messages.length - 1].role === "assistant")
    messages.push({ role: "user", content: texto });

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 600,
    system: SOPORTE_SYSTEM,
    messages,
  });

  const respuesta = response.content[0]?.text?.trim();
  if (!respuesta) return;

  const botId  = uuidv4();
  const botNow = new Date().toISOString();

  edb.prepare(
    "INSERT INTO chat_messages (id, empresa_id, canal, user_id, user_nombre, texto, creado_en) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(botId, empresaId, canal, "bot-soporte", "Asistente Organízalo", respuesta, botNow);

  const botMsg = { id: botId, empresaId, canal, userId: "bot-soporte", userNombre: "Asistente Organízalo", texto: respuesta, creadoEn: botNow, esBot: true };
  if (io) io.to(`empresa:${empresaId}:${canal}`).emit("mensaje", botMsg);
}

module.exports = router;
