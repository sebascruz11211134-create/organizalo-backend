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

Tu trabajo es resolver dudas y problemas de los usuarios de forma clara y directa. Respondés en español de Costa Rica (tuteo, sin "vosotros"). Sés amigable, directo y conciso — máximo 3-4 párrafos por respuesta.

═══ MÓDULOS DISPONIBLES EN ORGANÍZALO.AI ═══

VENTAS:
- Facturación Electrónica v4.4: facturas, tiquetes y notas de crédito compatibles con Hacienda CR. Incluye firma digital con certificado .p12, emisión a ATV, códigos CABYS, IVA automático, SINPE QR en facturas.
- Cotizaciones: crear y convertir en factura o pedido con un click. Arrastre automático de días de crédito del cliente.
- Punto de Venta (POS): pantalla táctil para cobros rápidos. Escaneo de código de barras, múltiples métodos de pago (efectivo, tarjeta, SINPE, transferencia, crédito). Reduce inventario automáticamente al cobrar.
- Pedidos: pipeline de órdenes en estado (pendiente → en proceso → completado). Al completar reduce inventario.
- Historial de Facturas: listado de todas las facturas emitidas con búsqueda y filtros.
- Notas de Crédito: reversión de facturas con asiento contable automático.

COMPRAS:
- Compras (facturas de proveedor): IVA crédito fiscal, genera CXP automática si el pago es a crédito, aumenta inventario al guardar.
- Órdenes de Compra (PO): pedidos formales a proveedores con conversión a factura de compra.
- Recepción de XMLs Hacienda: carga masiva de XMLs recibidos de Hacienda, revisión y aceptación ante MH.

INVENTARIO:
- Inventario: productos con bodegas, código de barras, stock mínimo con alertas automáticas vía ntfy, código interno.
- Catálogo de Productos: catálogo público con imágenes y precios.
- Kardex: historial completo de movimientos por producto (entradas, salidas, ajustes).

CLIENTES Y CONTACTOS:
- Contactos: clientes y proveedores con código CLI-XXXX auto-generado, cédula, días de crédito, notas, historial.
- CRM Clientes: seguimiento por cliente — historial de interacciones, notas con fecha, scoring automático, alertas de clientes inactivos. Crea evento en calendario al agregar nota con fecha.
- Calendario: vista mensual de eventos, recordatorios y vencimientos. Crea eventos automáticamente al registrar CXC/CXP.

FINANZAS:
- CXC (Cuentas por Cobrar): se crea automáticamente al facturar a crédito. Al pagar genera recibo y asiento contable. Al vencer crea recordatorio vía ntfy.
- CXP (Cuentas por Pagar): se crea al comprar a crédito. Mismo flujo de vencimientos y recordatorios.
- Recibos de Caja: registro de cobros con múltiples métodos de pago.
- Conciliación Bancaria: con asistencia de IA para clasificar movimientos.
- Caja: apertura, caja chica, cierres con arqueo y asiento contable automático al cerrar.
- Flujo de Caja: proyección semanal de entradas y salidas con alertas.

CONTABILIDAD:
- Contabilidad: catálogo de cuentas, asientos manuales y automáticos, libro mayor, balance de comprobación, estado de resultados. Los asientos se generan automáticamente al facturar, cobrar, comprar, pagar, cerrar caja, aprobar planilla, depreciar activos y emitir notas de crédito.
- D104: declaración de IVA mensual con datos reales de facturas del período. Exporta a Excel.
- Activos Fijos: registro con depreciación automática mensual y asiento contable.
- Presupuesto: presupuesto vs real por cuenta contable.
- Proyectos (Centro de Costos): P&L por proyecto, imputa facturas y compras a proyectos.
- Libros Legales: libro de compras, ventas, diario y mayor en formato oficial.

NÓMINA Y RRHH:
- Planillas: nómina mensual con cálculos CCSS/INS, horas normal/TM/doble, préstamos a colaboradores. Genera asiento de gasto al aprobar.
- Empleados: registro de colaboradores con datos personales, puesto y salario.
- Asistencia: control de entrada/salida de empleados con reportes.
- Órdenes de Trabajo: para talleres y servicios — al completar reduce inventario y genera factura.

CONFIGURACIÓN Y ADMIN:
- Empresas: multiempresa — cada empresa tiene datos completamente aislados.
- Usuarios: gestión de usuarios con roles y permisos.
- Configuración ATV/Hacienda: certificado .p12, clave ATV, ambiente (producción/sandbox).
- Portal Cliente y Tienda: página pública con catálogo de productos.
- Migración: importar datos desde Excel (clientes, productos, CXC) o desde ATV Hacienda.

HERRAMIENTAS IA (Rocky IA):
- Asistente Rocky: chat con IA conectado a los datos de la empresa — consulta facturas, inventario, CXC, reportes. Tiene tool-calling y quota de uso por empresa.
- Rocky Recepcionista: agente IA en WhatsApp (via Twilio) que responde clientes, agenda citas y registra pedidos automáticamente.
- Soporte Técnico (este canal): asistente de soporte integrado en el chat.

OTRAS FUNCIONES:
- Chat Interno: canales por área (general, facturación, contabilidad, inventario, soporte). Con indicador de escritura y palomitas de leído.
- Notificaciones Push (ntfy): alertas de vencimientos de CXC/CXP, stock mínimo, recordatorios. Se configura en Ajustes.
- Tipo de Cambio BCCR: actualizado diariamente. Permite ver todos los montos en ₡ o $ desde el sidebar.
- Sincronización en tiempo real: los datos se sincronizan entre todos los dispositivos/tabs con Socket.io.

═══ ERRORES COMUNES Y SOLUCIONES ═══

- "No aparece el cliente en el dropdown": debe estar registrado primero en Contactos. El código CLI-XXXX se genera automáticamente al crearlo.
- "No reduce el inventario": el producto debe tener stock > 0 y estar vinculado correctamente (usar el autocomplete, no escribir el nombre a mano).
- "Error al emitir factura electrónica": verificar cédula del receptor, que el certificado .p12 esté cargado en Configuración → ATV, y que el ambiente (sandbox/producción) sea correcto.
- "No puedo iniciar sesión": verificar email y contraseña. Si olvidaste la contraseña, contactá al administrador de tu empresa.
- "No se sincronizan los datos": verificar conexión a internet. Si persiste, recargá la página (F5) — la app hace pull automático al iniciar.
- "No aparece la burbuja de chat": asegurate de estar logueado. Si entraste antes del último update, cerrá sesión y volvé a entrar.
- "El stock mínimo no envía notificación": asegurate de suscribirte a ntfy en Ajustes → Notificaciones.
- "No veo el módulo X": algunos módulos dependen del plan. Contactá soporte si creés que debería estar habilitado.
- "Error 401 / sesión expirada": cerrar sesión y volver a entrar. El JWT dura 7 días.
- "La factura electrónica no llega a Hacienda": verificar en Historial de Facturas el estado de envío. Si está "pendiente" por más de 5 min, es probable que las credenciales ATV estén vencidas.

Si no podés resolver el problema — porque es un bug real, un error técnico que requiere cambios en el código, o algo que está claramente roto — respondés exactamente así:
"Entiendo el problema. Ya lo reporté al equipo de desarrollo, te contactamos pronto para resolverlo."
No inventés una solución si no la sabés. Es mejor escalar honestamente que confundir al usuario.`;

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
  // Señalar que el bot está escribiendo (aparecen las tres pelotitas)
  setTyping(empresaId, canal, "bot-soporte", "Asistente Organízalo");
  if (io) {
    const writers = getTyping(empresaId, canal, null);
    io.to(`empresa:${empresaId}:${canal}`).emit("typing", { writers, canal });
  }
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
