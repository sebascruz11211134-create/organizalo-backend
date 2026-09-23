/**
 * /api/rocky — Agente IA que atiende llamadas telefónicas por empresa.
 *
 * POST /api/rocky/llamada      — Webhook de Twilio al recibir llamada (TwiML)
 * POST /api/rocky/transcripcion — Twilio envía el texto de lo que dijo el cliente
 * POST /api/rocky/config        — Guardar/leer configuración del agente por empresa
 * GET  /api/rocky/historial     — Historial de llamadas de la empresa
 *
 * Flujo completo:
 *  1. Cliente llama al número Twilio
 *  2. Twilio llama a /api/rocky/llamada → respondemos con TwiML (Gather speech)
 *  3. Cliente habla → Twilio transcribe y llama a /api/rocky/transcripcion
 *  4. Claude analiza intención (pedido / cita / pregunta)
 *  5. Respondemos con TwiML (voz sintetizada con la respuesta)
 *  6. Si se completó un pedido o cita: creamos el registro en cloud_data
 *  7. Enviamos email de confirmación al cliente (si dejó correo)
 */

const express   = require("express");
const jwt       = require("jsonwebtoken");
const Anthropic = require("@anthropic-ai/sdk");
const { v4: uuidv4 } = require("uuid");
const { db, getEmpresaDb } = require("../db");
const { read: readERP } = require("../services/erpData");
const admin = require("../middleware/rockyAdmin");
const { validateSchedule } = require("../services/rockySchedule");
const config    = require("../config");
const { registerUsage } = require("../middleware/apiQuota");

const router = express.Router();
const {valid:validTwilio,xml}=require('../services/twilioSignature');
function twilioAuth(req,res,next) {
  if(!process.env.TWILIO_AUTH_TOKEN) return res.sendStatus(503);
  if(!validTwilio(config.publicUrl+req.originalUrl,req.body||{},req.headers['x-twilio-signature'],process.env.TWILIO_AUTH_TOKEN)) return res.sendStatus(403);
  next();
}
db.exec('CREATE TABLE IF NOT EXISTS rocky_call_sessions (sid TEXT PRIMARY KEY, empresa_id TEXT NOT NULL, caller TEXT, created_at INTEGER NOT NULL)');

// ── Auth middleware (para rutas protegidas) ───────────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function hoy() { return new Date().toISOString().slice(0, 10); }
function ahora() { return new Date().toISOString(); }

function parse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/** Genera TwiML para recoger voz */
function twimlGather(mensaje, accionUrl, timeout = 5) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="speech" action="${xml(accionUrl)}" method="POST" timeout="${timeout}" language="es-MX" speechTimeout="auto">
    <Say voice="Polly.Lupe" language="es-MX">${xml(mensaje)}</Say>
  </Gather>
  <Say voice="Polly.Lupe" language="es-MX">No escuché nada. Por favor llame de nuevo. ¡Hasta pronto!</Say>
  <Hangup/>
</Response>`;
}

/** Genera TwiML para decir algo y colgar */
function twimlSay(mensaje) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Lupe" language="es-MX">${xml(mensaje)}</Say>
  <Hangup/>
</Response>`;
}

/** Carga configuración del agente por empresa */
function cargarConfigRocky(empresaId) {
  return readERP(empresaId,'rocky_config',{activo:false,horarioInicio:'',horarioFin:'',zonaHoraria:'America/Costa_Rica',modoRespuestas:'borrador'});
}

/** Carga datos del menú o servicios de la empresa */
function cargarContextoEmpresa(empresaId, tipoNegocio) {
  const edb = getEmpresaDb(empresaId);
  const datosClaves = tipoNegocio === "restaurante"
    ? ["productos_catalogo", "inventario", "settings"]
    : tipoNegocio === "servicios"
      ? ["settings", "empleados"]
      : ["settings"];

  const datos={};
  for(const key of datosClaves) datos[key]=readERP(empresaId,key,key==='settings'?{}:[]);
  return datos;
}

/** Guarda llamada en el historial */
function guardarLlamada(empresaId, llamada) {
  const edb = getEmpresaDb(empresaId);
  const histRow = edb.prepare(
    "SELECT valor FROM cloud_data WHERE clave = 'rocky_historial'"
  ).get();
  const historial = parse(histRow?.valor) || [];
  historial.unshift({ ...llamada, id: uuidv4(), fecha: ahora() });
  // Mantener máximo 200 llamadas
  const recorte = historial.slice(0, 200);
  edb.prepare(
    "INSERT INTO cloud_data (empresa_id, clave, valor, actualizado_en) VALUES (?,?,?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor, actualizado_en=excluded.actualizado_en"
  ).run(empresaId, "rocky_historial", JSON.stringify(recorte), ahora());
}

/** Envía email de confirmación via fetch a Resend */
async function enviarEmailConfirmacion({ to, subject, html }) {
  if (!config.resendApiKey) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Rocky IA <rocky@organizalo.ai>",
        to: [to],
        subject,
        html,
      }),
    });
  } catch (err) {
    console.error("[rocky] Error enviando email:", err.message);
  }
}

// ── POST /api/rocky/llamada ───────────────────────────────────────────────────
// Twilio llama aquí cuando alguien llama al número.
// Respondemos con TwiML para recoger la voz del cliente.

router.post("/llamada", twilioAuth, async (req, res) => {
  res.set("Content-Type", "text/xml");
  try {
    const { To: numeroDestino, From: numeroCaller, CallSid } = req.body || {};

    // Buscar empresa por número Twilio
    const candidates=db.prepare('SELECT DISTINCT empresa_id FROM users WHERE activo=1 AND empresa_id IS NOT NULL').all();
    const matches=candidates.map(e=>({empresa_id:e.empresa_id,config:cargarConfigRocky(e.empresa_id)})).filter(e=>e.config.numeroTwilio===numeroDestino);
    const configRow=matches.length===1?{empresa_id:matches[0].empresa_id,valor:JSON.stringify(matches[0].config)}:null;

    if (!configRow) {
      return res.send(twimlSay("Lo sentimos, este número no está configurado. Adiós."));
    }

    const empresaId = configRow.empresa_id;
    db.prepare('INSERT OR REPLACE INTO rocky_call_sessions VALUES(?,?,?,?)').run(CallSid,empresaId,numeroCaller,Date.now());
    const rockyConfig = parse(configRow.valor) || {};

    if (!rockyConfig.activo) {
      return res.send(twimlSay("En este momento no podemos atender su llamada. Por favor intente más tarde."));
    }

    // Obtener nombre de empresa
    const settings = readERP(empresaId,'settings',{});
    const nombreEmpresa = settings.nombreNegocio || "nuestra empresa";

    const bienvenida = rockyConfig.bienvenida ||
      `Gracias por llamar a ${nombreEmpresa}. Soy Rocky, su asistente virtual. ¿En qué le puedo ayudar hoy?`;

    const accionUrl = `${config.publicUrl || "https://api.organizalo.ai"}/api/rocky/transcripcion?empresaId=${empresaId}&callSid=${CallSid}`;

    res.send(twimlGather(bienvenida, accionUrl));
  } catch (err) {
    console.error("[rocky/llamada]", err);
    res.send(twimlSay("Ocurrió un error. Por favor intente más tarde."));
  }
});

// ── POST /api/rocky/transcripcion ─────────────────────────────────────────────
// Twilio envía la transcripción de lo que dijo el cliente.
// Claude analiza la intención y respondemos con voz.

router.post("/transcripcion", twilioAuth, async (req, res) => {
  res.set("Content-Type", "text/xml");
  try {
    const { empresaId, callSid } = req.query;
    const { SpeechResult: texto, From: telefono } = req.body || {};
    const call=db.prepare('SELECT * FROM rocky_call_sessions WHERE sid=? AND empresa_id=? AND caller=? AND created_at>?').get(callSid,empresaId,telefono,Date.now()-3600000);
    if(!call || req.body.CallSid!==callSid) return res.sendStatus(403);

    if (!texto || !empresaId) {
      return res.send(twimlSay("No pude escuchar bien. Por favor intente de nuevo."));
    }

    if (!config.anthropicApiKey) {
      return res.send(twimlSay("El asistente no está disponible en este momento."));
    }

    // Cargar config y datos de la empresa
    const rockyConfig = cargarConfigRocky(empresaId);
    const datosEmpresa = cargarContextoEmpresa(empresaId, rockyConfig.tipoNegocio);
    const settings = datosEmpresa["settings"] || {};
    const nombreEmpresa = settings.nombreNegocio || "la empresa";

    // Construir contexto según tipo de negocio
    let contextoExtra = "";
    if (rockyConfig.tipoNegocio === "restaurante") {
      const productos = datosEmpresa["productos_catalogo"] || datosEmpresa["inventario"] || [];
      const menu = productos
        .filter(p => p.activo !== false)
        .slice(0, 30)
        .map(p => `- ${p.nombre}: ₡${p.precio || p.precioVenta || "N/D"}`)
        .join("\n");
      contextoExtra = menu ? `\nMENÚ DISPONIBLE:\n${menu}` : "\n(No hay menú configurado aún)";
    } else if (rockyConfig.tipoNegocio === "servicios") {
      contextoExtra = "\nEsta empresa ofrece servicios con citas. Puedes agendar una cita.";
    }

    const systemPrompt = `Eres Rocky, el recepcionista virtual de "${nombreEmpresa}".
Tipo de negocio: ${rockyConfig.tipoNegocio}.
${contextoExtra}

INSTRUCCIONES:
- Responde de forma natural y breve (máximo 2-3 oraciones) como si hablaras por teléfono.
- Si el cliente pide un pedido o cita, explicá que registrarás la solicitud para revisión; no afirmes haberlo creado.
- No inventes fechas, precios ni disponibilidad.
- Si no tienes info suficiente, pregunta solo lo más importante.
- Al final de la respuesta, incluye en una línea nueva: ACCION: [PEDIDO|CITA|PREGUNTA|NINGUNA]
- Si es PEDIDO o CITA, incluye también: RESUMEN: [resumen breve del pedido o cita]
- Habla siempre en español, tono amigable y profesional.`;

    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: systemPrompt,
      messages: [{ role: "user", content: texto }],
    });

    // Registrar uso de tokens
    registerUsage(empresaId, response.usage);

    const respuestaCompleta = response.content?.[0]?.text || "No pude procesar su solicitud.";

    // Extraer acción y resumen
    const lineas = respuestaCompleta.split("\n");
    const accionLinea = lineas.find(l => l.startsWith("ACCION:"));
    const resumenLinea = lineas.find(l => l.startsWith("RESUMEN:"));
    const accion = accionLinea?.replace("ACCION:", "").trim() || "NINGUNA";
    const resumen = resumenLinea?.replace("RESUMEN:", "").trim() || texto;

    // Texto limpio para la voz (sin las líneas ACCION/RESUMEN)
    const textoVoz = lineas
      .filter(l => !l.startsWith("ACCION:") && !l.startsWith("RESUMEN:"))
      .join(" ")
      .trim();

    // Guardar en historial
    guardarLlamada(empresaId, {
      telefono,
      callSid,
      pregunta: texto,
      respuesta: textoVoz,
      accion,
      resumen,
      resultado: accion === "PEDIDO" || accion === "CITA" ? "requiere_revision" : "respondido",
      duracion: "N/D",
    });

    // Actions extracted from speech remain in the call history for review.
    // A structured, confirmed action is required before mutating orders or appointments.

    // Email de confirmación
    if (rockyConfig.emailConfirmacion && settings.correo) {
      await enviarEmailConfirmacion({
        to: settings.correo,
        subject: `Rocky: ${accion === "PEDIDO" ? "Nuevo pedido" : accion === "CITA" ? "Nueva cita" : "Llamada recibida"} de ${telefono}`,
        html: `
          <h2>Rocky recibió una llamada</h2>
          <p><strong>Teléfono:</strong> ${telefono}</p>
          <p><strong>Tipo:</strong> ${accion}</p>
          <p><strong>Resumen:</strong> ${resumen}</p>
          <p><strong>Fecha:</strong> ${new Date().toLocaleString("es-CR")}</p>
          <hr>
          <p style="color:#666;font-size:12px">Generado automáticamente por Rocky IA · Organízalo.AI</p>
        `,
      });
    }

    res.send(twimlSay(textoVoz));
  } catch (err) {
    console.error("[rocky/transcripcion]", err);
    res.send(twimlSay("Ocurrió un error procesando su solicitud. Por favor intente más tarde."));
  }
});

// ── POST /api/rocky/config ────────────────────────────────────────────────────
// Guardar configuración del agente

router.post("/config", admin, (req, res) => {
  try {
    const { empresaId } = req.jwtPayload;
    const configData = {...cargarConfigRocky(empresaId), ...req.body};
    try { validateSchedule(configData); } catch(e) {return res.status(400).json({error:e.message});}
    if(!['automatico','borrador'].includes(configData.modoRespuestas || 'borrador')) return res.status(400).json({error:'Modo inválido'});
    const edb = getEmpresaDb(empresaId);
    edb.prepare(
      "INSERT INTO cloud_data (empresa_id, clave, valor, actualizado_en) VALUES (?,?,?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor, actualizado_en=excluded.actualizado_en"
    ).run(empresaId, "rocky_config", JSON.stringify(configData), ahora());
    res.json({ ok: true });
  } catch (err) {
    console.error("[rocky/config]", err);
    res.status(500).json({ error: "Error guardando config." });
  }
});

// ── GET /api/rocky/config ─────────────────────────────────────────────────────
router.get("/config", admin, (req, res) => {
  try {
    const { empresaId } = req.jwtPayload;
    const rockyConfig = cargarConfigRocky(empresaId);
    res.json({ config: rockyConfig });
  } catch (err) {
    res.status(500).json({ error: "Error." });
  }
});

// ── GET /api/rocky/historial ──────────────────────────────────────────────────
router.get("/historial", admin, (req, res) => {
  try {
    const { empresaId } = req.jwtPayload;
    const edb = getEmpresaDb(empresaId);
    const row = edb.prepare(
      "SELECT valor FROM cloud_data WHERE clave = 'rocky_historial'"
    ).get();
    const historial = parse(row?.valor) || [];
    res.json({ historial, total: historial.length });
  } catch (err) {
    res.status(500).json({ error: "Error." });
  }
});

module.exports = router;
