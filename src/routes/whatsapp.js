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
const { getEmpresaDb } = require("../db");

const router = express.Router();

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

function backupSesionWA(empresaId) {
  if (!empresaId) return;
  const { execSync } = require("child_process");
  const fs = require("fs");
  const tmp = `/tmp/wa_bk_${empresaId}.tar.gz`;
  try {
    execSync(`tar czf ${tmp} .wwebjs_auth 2>/dev/null || true`);
    if (!fs.existsSync(tmp)) return;
    const data = fs.readFileSync(tmp).toString("base64");
    fs.unlinkSync(tmp);
    getEmpresaDb(empresaId).prepare(
      "INSERT INTO cloud_data (empresa_id,clave,valor,actualizado_en) VALUES(?,?,?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor,actualizado_en=excluded.actualizado_en"
    ).run(empresaId, "wa_session_backup", data, new Date().toISOString());
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
    execSync(`tar xzf ${tmp} 2>/dev/null || true`);
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
  const sessionDir = path.resolve(__dirname, "../../.wwebjs_auth/session");
  ["SingletonLock", "SingletonCookie", "SingletonSocket"].forEach(f => {
    try { fs.unlinkSync(path.join(sessionDir, f)); } catch {}
  });

  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: "./.wwebjs_auth" }),
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
      setInterval(() => backupSesionWA(waEmpresaId), 5 * 60 * 1000);
    }
  });

  // ── Auto-respuesta con Rocky IA ──────────────────────────────────────────
  waClient.on("message", async (msg) => {
    if (msg.isGroupMsg || msg.fromMe || msg.from === "status@broadcast") return;
    if (!waEmpresaId) return;
    try {
      const respuesta = await consultarRockyWA(msg.body, msg.from, waEmpresaId);
      if (respuesta) await msg.reply(respuesta);
    } catch (e) {
      console.error("[WhatsApp] Error en auto-reply:", e.message);
    }
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

// Auto-inicializar si el paquete está instalado
if (getWWebJS()) initWAClient();

// ── Rocky IA para WhatsApp ────────────────────────────────────────────────────
async function consultarRockyWA(mensajeCliente, from, empresaId) {
  if (!config.anthropicApiKey) return null;

  // Cargar config de Rocky y datos de la empresa
  let rockyConfig = {};
  let settingsEmpresa = {};
  try {
    const edb = getEmpresaDb(empresaId);
    const rcRow = edb.prepare(
      "SELECT valor FROM cloud_data WHERE empresa_id = ? AND clave = 'rocky_config'"
    ).get(empresaId);
    rockyConfig = rcRow ? JSON.parse(rcRow.valor) : {};

    const stRow = edb.prepare(
      "SELECT valor FROM cloud_data WHERE empresa_id = ? AND clave = 'settings'"
    ).get(empresaId);
    settingsEmpresa = stRow ? JSON.parse(stRow.valor) : {};
  } catch (_) {}

  // Si Rocky no está activo, no responder
  if (rockyConfig.activo === false) return null;

  const nombreEmpresa = settingsEmpresa?.empresa || rockyConfig?.nombreEmpresa || "la empresa";
  const tipoNegocio   = rockyConfig?.tipoNegocio || "general";
  const instrucciones = rockyConfig?.instrucciones || "";

  const systemPrompt = [
    `Sos Rocky, el asistente de WhatsApp de ${nombreEmpresa}.`,
    `Tipo de negocio: ${tipoNegocio}.`,
    instrucciones ? `Instrucciones especiales: ${instrucciones}` : "",
    `Respondé en español, de forma amable, concisa y profesional.`,
    `Si el cliente quiere hacer un pedido, cita o consulta específica, indicale que un asesor lo contactará pronto.`,
    `No inventes precios ni disponibilidad. Máximo 3 oraciones por respuesta.`,
  ].filter(Boolean).join(" ");

  try {
    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const res = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: mensajeCliente }],
    });
    return res.content?.[0]?.text || null;
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

// ── GET /api/whatsapp/status ──────────────────────────────────────────────────
router.get("/status", requireJWT, (req, res) => {
  if (!getWWebJS()) {
    return res.json({ ok: false, estado: "no_instalado",
      error: "Ejecutá: npm install whatsapp-web.js qrcode en la carpeta del backend" });
  }
  res.json({ ok: true, estado: waStatus });
});

// ── GET /api/whatsapp/qr ──────────────────────────────────────────────────────
// Responde inmediatamente con el estado actual. El frontend hace polling cada 3s.
router.get("/qr", requireJWT, async (req, res) => {
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
    const externalUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(waQRRaw)}`;
    return res.json({ ok: true, qr: { base64url: externalUrl } });
  }

  // Aún inicializando — el frontend debe reintentar en 3s
  res.json({ ok: true, conectando: true, estado: waStatus });
});

// ── POST /api/whatsapp/send ───────────────────────────────────────────────────
router.post("/send", requireJWT, async (req, res) => {
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
router.post("/send-reminder", requireJWT, async (req, res) => {
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
router.post("/reconectar", requireJWT, (req, res) => {
  if (!getWWebJS()) return res.status(500).json({ ok: false, error: "whatsapp-web.js no instalado" });
  initWAClient();
  res.json({ ok: true, mensaje: "Reconectando..." });
});

module.exports = router;

// ── Cron: recordatorios diarios a las 8am ────────────────────────────────────
async function enviarRecordatoriosHoy() {
  if (!waReady || !waClient) {
    console.log("[WhatsApp cron] No conectado, saltando recordatorios");
    return;
  }
  const hoy = new Date().toISOString().split("T")[0];
  console.log(`[WhatsApp cron] Buscando recordatorios para ${hoy}`);
  try {
    const eventos = db.prepare(`
      SELECT e.*, u.empresa_nombre
      FROM eventos e
      LEFT JOIN users u ON u.empresa_id = e.empresa_id
      WHERE e.fecha = ? AND e.tipo = 'seguimiento' AND e.completado = 0 AND e.cliente_id IS NOT NULL
      GROUP BY e.id
    `).all(hoy);
    console.log(`[WhatsApp cron] ${eventos.length} recordatorios encontrados`);
    for (const ev of eventos) {
      let telefono = null;
      try {
        const cloudRow = db.prepare("SELECT valor FROM cloud_data WHERE empresa_id = ? AND clave = 'contactos'")
          .get(ev.empresa_id);
        if (cloudRow?.valor) {
          const contactos = JSON.parse(cloudRow.valor);
          const cliente = contactos.find(c =>
            c.codigoCliente === ev.cliente_id || c.id === ev.cliente_id || c.nombre === ev.cliente_nombre
          );
          telefono = cliente?.tel || cliente?.telefono || null;
        }
      } catch (_) {}
      if (!telefono) continue;
      const phone = formatPhone(telefono);
      if (!phone) continue;
      const texto = [
        `¡Hola${ev.cliente_nombre ? " " + ev.cliente_nombre : ""}! 👋`,
        ev.empresa_nombre ? `Te escribimos de *${ev.empresa_nombre}*.` : "",
        ev.descripcion || "Queríamos consultarte si necesitás algo o tenés alguna consulta.",
        `Estamos a tu disposición. 😊`,
      ].filter(Boolean).join("\n");
      try {
        await waClient.sendMessage(phone, texto);
        db.prepare("UPDATE eventos SET completado = 1 WHERE id = ?").run(ev.id);
        console.log(`[WhatsApp cron] ✓ Enviado a ${ev.cliente_nombre}`);
      } catch (e) {
        console.error(`[WhatsApp cron] ✗ Error:`, e.message);
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  } catch (e) {
    console.error("[WhatsApp cron] Error general:", e.message);
  }
}

module.exports.enviarRecordatoriosHoy = enviarRecordatoriosHoy;
