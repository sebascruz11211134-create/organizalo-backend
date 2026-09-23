/**
 * /api/whatsapp — WhatsApp Web directo con whatsapp-web.js
 * No requiere Evolution API ni Docker. Corre 100% en Node.js.
 *
 * Instalación requerida: npm install whatsapp-web.js qrcode
 */

const express   = require("express");
const jwt       = require("jsonwebtoken");
const Anthropic = require("@anthropic-ai/sdk");
const config    = require("../config");
const { db: sharedDb, getEmpresaDb } = require("../db");

const router = express.Router();
const runtime = require('../services/rockyRuntime');
const publicReply = require('../services/rockyReply');
const { dentroDelHorario } = require('../services/rockySchedule');
const { read: readERP } = require('../services/erpData');
const { createHash } = require('node:crypto');
const admin = require('../middleware/rockyAdmin');
const ownSends = new Set();
const pendingSends = new Set();
let backupTimer;


// ── JWT middleware ────────────────────────────────────────────────────────────
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

// ── Estado global del cliente WhatsApp ───────────────────────────────────────
let waClient     = null;
let waQRRaw      = null;   // string QR raw de WhatsApp
let waStatus     = "disconnected";
let waReady      = false;
let waInitializing = false;
let waEmpresaId  = null;   // empresa que inició la conexión

function getWWebJS() {
  try { return require("whatsapp-web.js"); }
  catch { return null; }
}

function getQRCode() {
  try { return require("qrcode"); }
  catch { return null; }
}

// ── Persistencia de sesión via tar + SQLite ───────────────────────────────────
// Guarda .wwebjs_auth como tar.gz en base64 dentro del SQLite de la empresa.
// Así la sesión sobrevive reinicios/deploys de Railway sin re-escanear QR.

// Persiste el empresaId activo en sharedDb para que sobreviva reinicios
function guardarWAEmpresaId(empresaId) {
  try {
    sharedDb.prepare(
      "INSERT INTO empresa_config (empresa_id, modulos_json, actualizado_en) VALUES ('__wa_active__', ?, ?) ON CONFLICT(empresa_id) DO UPDATE SET modulos_json=excluded.modulos_json, actualizado_en=excluded.actualizado_en"
    ).run(empresaId, new Date().toISOString());
  } catch (e) { console.error("[WA] Error guardando wa_empresa_id:", e.message); }
}

function leerWAEmpresaId() {
  try {
    const row = sharedDb.prepare("SELECT modulos_json FROM empresa_config WHERE empresa_id='__wa_active__'").get();
    return row?.modulos_json || null;
  } catch { return null; }
}

function backupSesionWA(empresaId) {
  if (!empresaId) return;
  const { execSync } = require("child_process");
  const fs = require("fs");
  const tmp = `/tmp/wa_bk_${empresaId}.tar.gz`;
  try {
    execSync(`tar czf ${tmp} -C /tmp .wwebjs_auth 2>/dev/null || true`);
    if (!fs.existsSync(tmp)) return;
    const data = fs.readFileSync(tmp).toString("base64");
    fs.unlinkSync(tmp);
    getEmpresaDb(empresaId).prepare(
      "INSERT INTO cloud_data (empresa_id,clave,valor,actualizado_en) VALUES(?,?,?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor,actualizado_en=excluded.actualizado_en"
    ).run(empresaId, "wa_session_backup", data, new Date().toISOString());
    // Guardar también qué empresa tiene WA activo para restaurar al reiniciar
    guardarWAEmpresaId(empresaId);
    console.log("[WA] ✓ Sesión guardada en SQLite");
  } catch (e) { console.error("[WA] Error guardando sesión:", e.message); }
}

function restaurarSesionWA(empresaId) {
  if (!empresaId) return false;
  const { execSync } = require("child_process");
  const fs = require("fs");
  const tmp = `/tmp/wa_bk_${empresaId}.tar.gz`;
  try {
    const row = getEmpresaDb(empresaId).prepare(
      "SELECT valor FROM cloud_data WHERE empresa_id=? AND clave='wa_session_backup'"
    ).get(empresaId);
    if (!row?.valor) return false;
    fs.writeFileSync(tmp, Buffer.from(row.valor, "base64"));
    execSync(`tar xzf ${tmp} -C /tmp 2>/dev/null || true`);
    fs.unlinkSync(tmp);
    console.log("[WA] ✓ Sesión restaurada desde SQLite");
    return true;
  } catch (e) {
    console.error("[WA] Error restaurando sesión:", e.message);
    return false;
  }
}

function initWAClient(empresaId) {
  const mod = getWWebJS();
  if (!mod) {
    console.log("[WhatsApp] whatsapp-web.js no instalado. Corré: npm install whatsapp-web.js qrcode");
    return;
  }
  if (waInitializing) return;

  if (empresaId) waEmpresaId = empresaId;

  // Intentar restaurar sesión desde SQLite antes de iniciar
  if (waEmpresaId) restaurarSesionWA(waEmpresaId);

  const { Client, LocalAuth } = mod;

  if (waClient) {
    waClient.destroy().catch(() => {});
    waClient = null;
  }

  waInitializing = true;
  waStatus  = "connecting";
  waQRRaw   = null;
  waReady   = false;

  const execPath = process.env.CHROME_PATH
    || (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : (() => {
            const { execSync } = require("child_process");
            try { return execSync("which chromium 2>/dev/null || which chromium-browser 2>/dev/null || which google-chrome-stable 2>/dev/null").toString().trim(); }
            catch { return "/usr/bin/chromium"; }
          })());

  // Limpiar singleton locks de Chrome
  const fs   = require("fs");
  const path = require("path");
  const sessionDir = "/tmp/.wwebjs_auth/session";
  ["SingletonLock", "SingletonCookie", "SingletonSocket"].forEach(f => {
    try { fs.unlinkSync(path.join(sessionDir, f)); } catch {}
  });

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: "/tmp/.wwebjs_auth" }),
    puppeteer: {
      executablePath: execPath,
      headless: true,
      protocolTimeout: 120000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-translate",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        "--js-flags=--max-old-space-size=192",
      ],
    },
  });

  waClient.on("qr", (qr) => {
    waQRRaw = qr;
    waStatus = "qr";
    waInitializing = false;
    console.log("[WhatsApp] QR listo para escanear");
  });

  waClient.on("ready", () => {
    waStatus = "open";
    waReady  = true;
    waQRRaw  = null;
    waInitializing = false;
    console.log("[WhatsApp] ¡Conectado!");
    // Guardar sesión en SQLite inmediatamente y luego cada 5 minutos
    if (waEmpresaId) {
      backupSesionWA(waEmpresaId);
      clearInterval(backupTimer);
      backupTimer = setInterval(() => backupSesionWA(waEmpresaId), 5 * 60 * 1000);
      backupTimer.unref();
    }
  });

  // ── Auto-respuesta con Rocky IA ──────────────────────────────────────────
  waClient.on("message", async (msg) => {
    if (msg.isGroupMsg || msg.fromMe || !/@c\.us$/.test(msg.from) || !waEmpresaId || process.env.WA_EMPRESA_ID===waEmpresaId && process.env.WA_CLOUD_TOKEN) return;
    try {
      runtime.inbox.enqueue({empresaId:waEmpresaId,channel:'whatsapp-web',externalId:msg.id._serialized,sender:msg.from,
        payload:{text:msg.body||'',unsupported:msg.hasMedia||msg.type!=='chat'}});
    } catch(e) { console.error('[WhatsApp inbox]',e.message); }
  });
  waClient.on('message_create', msg => {
    if (!msg.fromMe || !waEmpresaId || ownSends.has(msg.id?._serialized) || pendingSends.has(`${msg.to}:${msg.body}`)) return;
    // API-generated sends are also seen here: a short pause is conservative.
    runtime.inbox.pause(waEmpresaId,'whatsapp-web',msg.to,Date.now()+15*60000);
  });

  waClient.on("auth_failure", () => {
    waStatus = "disconnected";
    waReady  = false;
    waInitializing = false;
    console.log("[WhatsApp] Auth fallida — limpiando sesión");
    // Borrar sesión corrupta del SQLite y del disco
    if (waEmpresaId) {
      try { getEmpresaDb(waEmpresaId).prepare("DELETE FROM cloud_data WHERE empresa_id=? AND clave='wa_session_backup'").run(waEmpresaId); } catch {}
    }
    try { require("fs").rmSync(path.resolve(__dirname, "../../.wwebjs_auth"), { recursive: true, force: true }); } catch {}
  });

  waClient.on("disconnected", () => {
    waStatus = "disconnected";
    waReady  = false;
    waQRRaw  = null;
    waInitializing = false;
    console.log("[WhatsApp] Desconectado");
  });

  waClient.initialize().catch((err) => {
    console.error("[WhatsApp] Error inicializando:", err.message);
    waStatus = "disconnected";
    waInitializing = false;
  });
}

// Auto-inicializar si el paquete está instalado.
// Intenta restaurar la empresa que tenía WA activo antes del reinicio.
if (process.env.WA_WEB_ENABLED === "true" && getWWebJS()) {
  const empresaGuardada = leerWAEmpresaId();
  if (empresaGuardada) {
    console.log(`[WA] Auto-restaurando sesión para empresa: ${empresaGuardada}`);
    initWAClient(empresaGuardada);
  } else {
    initWAClient();
  }
}

// ── Onboarding: auto-crear contacto cuando escribe por primera vez ────────────

const CLAVE_CONTACTOS = "@finanzia/contactos";

function generarCodigoCli(lista) {
  const nums = lista
    .map(c => parseInt((c.codigoCliente || "").replace("CLI-", ""), 10))
    .filter(n => !isNaN(n));
  const siguiente = nums.length ? Math.max(...nums) + 1 : 1;
  return `CLI-${String(siguiente).padStart(4, "0")}`;
}

function onboardearContacto(empresaId, phone) {
  try {
    const edb  = getEmpresaDb(empresaId);
    const row  = edb.prepare("SELECT valor FROM cloud_data WHERE clave = ?").get(CLAVE_CONTACTOS);
    const lista = row?.valor ? JSON.parse(row.valor) : [];

    // Normalizar: quitar @c.us y no-dígitos para comparar
    const telLimpio = String(phone).replace(/[^0-9]/g, "").slice(-8);
    const yaExiste  = lista.some(c => String(c.tel || "").replace(/[^0-9]/g, "").endsWith(telLimpio));
    if (yaExiste) return { esNuevo: false };

    const id      = `wa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const codigo  = generarCodigoCli(lista);
    const tel     = phone.replace(/@c\.us$/i, "").replace(/[^0-9+]/g, "");
    const nuevo   = {
      id,
      nombre:       tel,          // nombre provisional = número
      tipo:         "cliente",
      tel,
      email:        "",
      cedula:       "",
      tipoCedula:   "fisico",
      notas:        "Contacto creado automáticamente desde WhatsApp",
      codigoCliente: codigo,
      dias_credito: 0,
      creadoEn:     new Date().toISOString(),
    };

    const listaActualizada = [nuevo, ...lista];
    edb.prepare(
      "INSERT INTO cloud_data (empresa_id,clave,valor,actualizado_en) VALUES(?,?,?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor,actualizado_en=excluded.actualizado_en"
    ).run(empresaId, CLAVE_CONTACTOS, JSON.stringify(listaActualizada), new Date().toISOString());

    console.log(`[WA Onboarding] Nuevo contacto creado: ${tel} (${codigo})`);
    return { esNuevo: true, contacto: nuevo };
  } catch (e) {
    console.error("[WA Onboarding] Error:", e.message);
    return { esNuevo: false };
  }
}

// ── Memoria de conversación por número ───────────────────────────────────────

function claveConv(phone) {
  // Clave SQLite segura: wa_conv_ + últimos 12 dígitos del número
  return `wa_conv_${String(phone).replace(/[^0-9]/g, "").slice(-12)}`;
}

function obtenerHistorial(empresaId, phone) {
  try {
    const row = getEmpresaDb(empresaId).prepare(
      "SELECT valor FROM cloud_data WHERE clave = ?"
    ).get(claveConv(phone));
    return row?.valor ? JSON.parse(row.valor) : [];
  } catch { return []; }
}

function guardarHistorial(empresaId, phone, mensajes) {
  try {
    const recorte = mensajes.slice(-20); // guardar últimos 20, pasar 10 a Claude
    getEmpresaDb(empresaId).prepare(
      "INSERT INTO cloud_data (empresa_id,clave,valor,actualizado_en) VALUES(?,?,?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor,actualizado_en=excluded.actualizado_en"
    ).run(empresaId, claveConv(phone), JSON.stringify(recorte), new Date().toISOString());
  } catch (e) { console.error("[WA] Error guardando historial:", e.message); }
}

// ── Horario de atención ───────────────────────────────────────────────────────

// ── Herramientas de Rocky ─────────────────────────────────────────────────────

function ejecutarConsultarInventario(empresaId, nombre) {
  try {
    const row = getEmpresaDb(empresaId).prepare(
      "SELECT valor FROM cloud_data WHERE clave = ?"
    ).get("@finanzia/productos");
    const lista = row?.valor ? JSON.parse(row.valor) : [];
    const q = (nombre || "").toLowerCase();
    const resultados = lista
      .filter(p => p.nombre?.toLowerCase().includes(q))
      .slice(0, 5)
      .map(p => ({ nombre: p.nombre, stock: p.stock ?? "N/D", precio: p.precio ?? "N/D", unidad: p.unidad || "" }));
    return resultados.length
      ? { encontrados: resultados }
      : { mensaje: "No se encontró ese producto en el inventario." };
  } catch (e) {
    return { error: e.message };
  }
}

function ejecutarCrearPedido(empresaId, from, clienteNombre, items, notas) {
  try {
    const edb = getEmpresaDb(empresaId);
    const row = edb.prepare("SELECT valor FROM cloud_data WHERE clave = ?").get("@finanzia/pedidos");
    const lista = row?.valor ? JSON.parse(row.valor) : [];
    const telLimpio = String(from).replace(/[^0-9]/g, "").slice(-8);
    const contacto  = (() => {
      const cr = edb.prepare("SELECT valor FROM cloud_data WHERE clave = ?").get("@finanzia/contactos");
      const cs = cr?.valor ? JSON.parse(cr.valor) : [];
      return cs.find(c => String(c.tel || "").replace(/[^0-9]/g, "").endsWith(telLimpio));
    })();
    const nuevo = {
      id:            `wa-${Date.now()}`,
      clienteNombre: clienteNombre || contacto?.nombre || "Cliente WhatsApp",
      clienteId:     contacto?.id || null,
      estado:        "pendiente",
      items:         Array.isArray(items) ? items : [{ nombre: String(items), cantidad: 1 }],
      notas:         notas || "Pedido realizado por WhatsApp",
      creadoEn:      new Date().toISOString(),
      canalOrigen:   "whatsapp",
    };
    edb.prepare(
      "INSERT INTO cloud_data (empresa_id,clave,valor,actualizado_en) VALUES(?,?,?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor,actualizado_en=excluded.actualizado_en"
    ).run(empresaId, "@finanzia/pedidos", JSON.stringify([nuevo, ...lista]), new Date().toISOString());
    console.log(`[WA Tools] Pedido creado: ${nuevo.id} para ${nuevo.clienteNombre}`);
    return { ok: true, pedidoId: nuevo.id, estado: "pendiente", mensaje: "Pedido registrado exitosamente." };
  } catch (e) {
    return { error: e.message };
  }
}

function ejecutarAgendarCita(empresaId, from, titulo, fecha, hora, clienteNombre, notas) {
  try {
    const edb = getEmpresaDb(empresaId);
    const telLimpio = String(from).replace(/[^0-9]/g, "").slice(-8);
    const contacto  = (() => {
      const cr = edb.prepare("SELECT valor FROM cloud_data WHERE clave = ?").get("@finanzia/contactos");
      const cs = cr?.valor ? JSON.parse(cr.valor) : [];
      return cs.find(c => String(c.tel || "").replace(/[^0-9]/g, "").endsWith(telLimpio));
    })();
    const id = `wa-ev-${Date.now()}`;
    edb.prepare(`
      INSERT INTO eventos (id,empresa_id,titulo,descripcion,tipo,fecha,hora,todo_el_dia,cliente_id,cliente_nombre,completado,color,creado_en)
      VALUES (?,?,?,?,?,?,?,0,?,?,0,'#10b981',?)
    `).run(
      id, empresaId, titulo || "Cita WhatsApp",
      notas || "Cita agendada por WhatsApp", "cita",
      fecha, hora || "09:00",
      contacto?.id || null,
      clienteNombre || contacto?.nombre || "Cliente WhatsApp",
      new Date().toISOString()
    );
    console.log(`[WA Tools] Cita agendada: ${titulo} el ${fecha}`);
    return { ok: true, eventoId: id, fecha, hora: hora || "09:00", mensaje: "Cita agendada correctamente." };
  } catch (e) {
    return { error: e.message };
  }
}

// Definición de tools para Claude
const ROCKY_TOOLS = [
  {
    name: "consultar_inventario",
    description: "Busca un producto en el inventario del negocio para informar disponibilidad y precio al cliente.",
    input_schema: {
      type: "object",
      properties: {
        nombre: { type: "string", description: "Nombre o parte del nombre del producto a buscar." }
      },
      required: ["nombre"]
    }
  },
  {
    name: "crear_pedido",
    description: "Registra un pedido del cliente en el sistema. Usá cuando el cliente confirme que quiere pedir algo.",
    input_schema: {
      type: "object",
      properties: {
        cliente_nombre: { type: "string", description: "Nombre del cliente." },
        items: {
          type: "array",
          description: "Lista de productos pedidos.",
          items: {
            type: "object",
            properties: {
              nombre:   { type: "string" },
              cantidad: { type: "number" }
            },
            required: ["nombre", "cantidad"]
          }
        },
        notas: { type: "string", description: "Notas adicionales del pedido." }
      },
      required: ["items"]
    }
  },
  {
    name: "agendar_cita",
    description: "Agenda una cita o turno para el cliente en el calendario del negocio.",
    input_schema: {
      type: "object",
      properties: {
        titulo:         { type: "string", description: "Descripción de la cita." },
        fecha:          { type: "string", description: "Fecha en formato YYYY-MM-DD." },
        hora:           { type: "string", description: "Hora en formato HH:MM." },
        cliente_nombre: { type: "string", description: "Nombre del cliente." },
        notas:          { type: "string", description: "Notas adicionales." }
      },
      required: ["titulo", "fecha"]
    }
  }
];

// ── Rocky IA para WhatsApp ────────────────────────────────────────────────────
async function consultarRockyWA(mensajeCliente, from, empresaId, eventId) {
  if (!config.anthropicApiKey) return null;

  // Cargar config de Rocky y datos de la empresa
  let rockyConfig = {};
  let settingsEmpresa = {};
  try {
    const edb = getEmpresaDb(empresaId);
    const rcRow = edb.prepare("SELECT valor FROM cloud_data WHERE clave = 'rocky_config'").get();
    rockyConfig = rcRow ? JSON.parse(rcRow.valor) : {};
    settingsEmpresa = readERP(empresaId, "settings", {});
  } catch (_) {}

  if (rockyConfig.activo !== true) return null;

  // Verificar horario de atención
  if (!dentroDelHorario(rockyConfig)) {
    return rockyConfig?.mensajeFueraHorario ||
      `Gracias por escribirnos. Nuestro horario de atención es de ${rockyConfig.horarioInicio || "08:00"} a ${rockyConfig.horarioFin || "20:00"}. Te responderemos a la brevedad. 🙏`;
  }

  const nombreEmpresa = settingsEmpresa?.nombreNegocio || settingsEmpresa?.empresa || rockyConfig?.nombreEmpresa || "la empresa";
  const tipoNegocio   = rockyConfig?.tipoNegocio || "general";
  const instrucciones = rockyConfig?.instrucciones || "";

  const systemPrompt = [
    `Sos Rocky, el asistente de WhatsApp de ${nombreEmpresa}. Tipo de negocio: ${tipoNegocio}.`,
    instrucciones ? `Instrucciones especiales: ${instrucciones}` : "",
    `Respondé en español, amable y conciso. Tenés memoria de la conversación.`,
    `Podés consultar el inventario, registrar pedidos y agendar citas usando las herramientas disponibles.`,
    `Siempre confirmá con el cliente antes de crear un pedido o cita. Máximo 3 oraciones por respuesta.`,
    `No inventes precios ni stock — consultá el inventario primero.`,
  ].filter(Boolean).join(" ");

  const historial = obtenerHistorial(empresaId, from);
  const mensajes  = [
    ...historial.slice(-10),
    { role: "user", content: mensajeCliente },
  ];

  try {
    const anthropic  = new Anthropic({ apiKey: config.anthropicApiKey, timeout:60000, maxRetries:1 });
    let respuestaFinal = null;

    // Agentic loop: hasta 4 rondas de tool use
    for (let ronda = 0; ronda < 4; ronda++) {
      const res = await anthropic.messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 600,
        system:     systemPrompt,
        tools:      ROCKY_TOOLS,
        messages:   mensajes,
      });

      // Agregar respuesta del asistente al hilo
      mensajes.push({ role: "assistant", content: res.content });

      if (res.stop_reason === "end_turn") {
        // Extraer texto final
        const bloque = res.content.find(b => b.type === "text");
        respuestaFinal = bloque?.text || null;
        break;
      }

      if (res.stop_reason === "tool_use") {
        // Ejecutar cada tool call y agregar resultados
        const toolResults = [];
        for (const bloque of res.content) {
          if (bloque.type !== "tool_use") continue;
          let resultado;
          const inp = bloque.input || {};
          const perform = () => {
            if (bloque.name === 'consultar_inventario') return ejecutarConsultarInventario(empresaId,inp.nombre);
            if (bloque.name === 'crear_pedido') return ejecutarCrearPedido(empresaId,from,inp.cliente_nombre,inp.items,inp.notas);
            if (bloque.name === 'agendar_cita') return ejecutarAgendarCita(empresaId,from,inp.titulo,inp.fecha,inp.hora,inp.cliente_nombre,inp.notas);
            return {error:'Herramienta desconocida'};
          };
          if (bloque.name === 'consultar_inventario') resultado=perform();
          else {
            const edb=getEmpresaDb(empresaId);
            edb.exec('CREATE TABLE IF NOT EXISTS rocky_actions (id TEXT PRIMARY KEY, result TEXT NOT NULL)');
            // One action of each type per received message. Changed AI arguments still cannot duplicate it.
            const actionId=createHash('sha256').update(`${eventId}:${bloque.name}`).digest('hex');
            edb.exec('BEGIN IMMEDIATE');
            try {
              const cached=edb.prepare('SELECT result FROM rocky_actions WHERE id=?').get(actionId);
              resultado=cached?JSON.parse(cached.result):perform();
              if(!cached) edb.prepare('INSERT INTO rocky_actions VALUES(?,?)').run(actionId,JSON.stringify(resultado));
              edb.exec('COMMIT');
            } catch(e) { edb.exec('ROLLBACK'); throw e; }
          }
          toolResults.push({ type: "tool_result", tool_use_id: bloque.id, content: JSON.stringify(resultado) });
        }
        mensajes.push({ role: "user", content: toolResults });
        continue;
      }

      // Cualquier otro stop_reason — salir
      break;
    }

    // Guardar historial (solo user + última respuesta de texto)
    if (respuestaFinal) {
      guardarHistorial(empresaId, from, [
        ...historial,
        { role: "user",      content: mensajeCliente },
        { role: "assistant", content: respuestaFinal },
      ]);
    }

    return respuestaFinal;
  } catch (e) {
    console.error("[WhatsApp Rocky] Error Claude:", e.message);
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatPhone(tel) {
  if (!tel) return null;
  const clean = String(tel).replace(/[^\d]/g, "");
  if (clean.startsWith("506") && clean.length >= 11) return clean + "@c.us";
  if (clean.length === 8)  return "506" + clean + "@c.us";
  if (clean.length > 8)    return clean + "@c.us";
  return null;
}

async function qrToBase64(raw) {
  const QRCode = getQRCode();
  if (QRCode) {
    const dataUrl = await QRCode.toDataURL(raw, { width: 300, margin: 2 });
    return dataUrl.replace("data:image/png;base64,", "");
  }
  return null;
}

router.use((req,res,next) => {
  if (process.env.WA_WEB_ENABLED !== 'true') return res.status(503).json({error:'Conector QR desactivado. Usá Cloud API o habilitalo en el servidor.'});
  admin(req,res,()=> {
    if(waEmpresaId && waEmpresaId!==req.jwtPayload.empresaId) return res.status(403).json({error:'Este conector pertenece a otra empresa.'});
    next();
  });
});

// ── GET /api/whatsapp/status ──────────────────────────────────────────────────
router.get("/status", admin, (req, res) => {
  if (!getWWebJS()) {
    return res.json({ ok: false, estado: "no_instalado",
      error: "Ejecutá: npm install whatsapp-web.js qrcode en la carpeta del backend" });
  }
  res.json({ ok: true, estado: waStatus });
});

// ── GET /api/whatsapp/qr ──────────────────────────────────────────────────────
// Responde inmediatamente con el estado actual. El frontend hace polling cada 3s.
router.get("/qr", admin, async (req, res) => {
  if (!getWWebJS()) {
    return res.status(500).json({ ok: false,
      error: "whatsapp-web.js no instalado. Ejecutá INSTALL-WHATSAPP.command en el Desktop." });
  }

  // Si ya está conectado, avisamos
  if (waStatus === "open") return res.json({ ok: true, yaConectado: true });

  // Guardar empresa que inició la sesión
  const eid = req.jwtPayload?.empresaId;
  if (eid) waEmpresaId = eid;

  // Si está desconectado y sin cliente, iniciar (restaura sesión desde SQLite si existe)
  if (!waClient || waStatus === "disconnected") initWAClient(eid);

  // Si el QR ya está listo, devolverlo inmediatamente
  if (waQRRaw) {
    const base64 = await qrToBase64(waQRRaw);
    if (base64) return res.json({ ok: true, qr: { base64 } });
    return res.status(503).json({ok:false,error:"No se pudo generar el QR localmente."});
  }

  // Aún inicializando — el frontend debe reintentar en 3s
  res.json({ ok: true, conectando: true, estado: waStatus });
});

// ── POST /api/whatsapp/send ───────────────────────────────────────────────────
router.post("/send", admin, async (req, res) => {
  const { numero, mensaje } = req.body;
  if (!numero || !mensaje) return res.status(400).json({ error: "numero y mensaje son requeridos" });
  if (!waReady || !waClient) return res.status(503).json({ ok: false, error: "WhatsApp no conectado. Escaneá el QR primero." });
  const phone = formatPhone(numero);
  if (!phone) return res.status(400).json({ error: "Número inválido (usá 8 dígitos de Costa Rica)" });
  try {
    await waClient.sendMessage(phone, mensaje);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/whatsapp/send-reminder ─────────────────────────────────────────
router.post("/send-reminder", admin, async (req, res) => {
  const { numero, clienteNombre, empresaNombre, mensaje } = req.body;
  if (!numero) return res.status(400).json({ error: "numero requerido" });
  if (!waReady || !waClient) return res.status(503).json({ ok: false, error: "WhatsApp no conectado" });
  const phone = formatPhone(numero);
  if (!phone) return res.status(400).json({ error: "Número inválido" });
  const texto = mensaje || [
    `¡Hola${clienteNombre ? " " + clienteNombre : ""}! 👋`,
    `Te escribimos de ${empresaNombre || "Organízalo"}.`,
    `Queríamos consultarte si necesitás algo o tenés alguna consulta.`,
    `Estamos a tu disposición. 😊`,
  ].join("\n");
  try {
    await waClient.sendMessage(phone, texto);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/whatsapp/reconectar ─────────────────────────────────────────────
router.post("/reconectar", admin, (req, res) => {
  if (!getWWebJS()) return res.status(500).json({ ok: false, error: "whatsapp-web.js no instalado" });
  initWAClient(req.jwtPayload.empresaId);
  res.json({ ok: true, mensaje: "Reconectando..." });
});

module.exports = router;

// ── Cron: recordatorios diarios a las 8am ────────────────────────────────────
async function enviarRecordatoriosHoy() {
  if(!waEmpresaId || process.env.WA_WEB_ENABLED!=='true' || process.env.WA_EMPRESA_ID===waEmpresaId && process.env.WA_CLOUD_TOKEN) return;
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Costa_Rica'}).format(new Date());
  const edb=getEmpresaDb(waEmpresaId);
  const eventos=edb.prepare("SELECT * FROM eventos WHERE fecha=? AND tipo='seguimiento' AND completado=0").all(date);
  const contactos=readERP(waEmpresaId,'contactos',[]);
  for(const ev of eventos) {
    const c=contactos.find(c=>c.id===ev.cliente_id || c.codigoCliente===ev.cliente_id);
    const sender=formatPhone(c?.tel||c?.telefono);if(!sender)continue;
    runtime.inbox.enqueue({empresaId:waEmpresaId,channel:'whatsapp-web',externalId:`recordatorio:${ev.id}:${date}`,sender,
      payload:{reminder:ev.id,text:ev.descripcion||`Hola ${ev.cliente_nombre||''}, tenés un seguimiento programado con nosotros.`}});
  }
}

module.exports.enviarRecordatoriosHoy = enviarRecordatoriosHoy;

runtime.register('whatsapp-web', {
  available:r => process.env.WA_WEB_ENABLED==='true' && waReady && waEmpresaId===r.empresa_id && publicReply.active(r),
  canSend:r=>publicReply.settings(r.empresa_id).modoRespuestas==='automatico',
  prepare:async r => {
    const c=publicReply.settings(r.empresa_id);
    if(r.payload.reminder)return {text:r.payload.text,draft:c.modoRespuestas!=='automatico'};
    if(r.payload.unsupported || c.modoRespuestas!=='automatico') return publicReply.prepare(r);
    onboardearContacto(r.empresa_id,r.sender);
    const text=await consultarRockyWA(r.payload.text,r.sender,r.empresa_id,`inbox:${r.id}`);
    if(!text) throw new Error('Rocky no generó respuesta');
    return {text};
  },
  send:async(r,text) => {
    const key=`${r.sender}:${text}`;pendingSends.add(key);
    try {
      const sent=await waClient.sendMessage(r.sender,text);
      if(!sent?.id?._serialized)throw new Error('Entrega no confirmada');
      ownSends.add(sent.id._serialized);
      if(ownSends.size>1000) ownSends.delete(ownSends.values().next().value);
      if(r.payload.reminder)getEmpresaDb(r.empresa_id).prepare('UPDATE eventos SET completado=1 WHERE id=?').run(r.payload.reminder);
      return sent.id._serialized;
    } finally {pendingSends.delete(key);}
  }
});
