/**
 * /api/recepcion — Recepción masiva de facturas XML
 *
 * POST   /api/recepcion/procesar   — Subir N XMLs, parsearlos y guardar como pendientes
 * GET    /api/recepcion/lista      — Listar facturas recibidas
 * POST   /api/recepcion/aceptar/:id — Aceptar/rechazar ante Hacienda
 * POST   /api/recepcion/aceptar-todos — Aceptar en masa todas las pendientes
 */

const express   = require("express");
const multer    = require("multer");
const jwt       = require("jsonwebtoken");
const config    = require("../config");
const recepcion = require("../recepcionService");

const router = express.Router();

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

// multer para XMLs en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 500 },
  fileFilter(req, file, cb) {
    if (file.originalname.endsWith(".xml") || file.mimetype.includes("xml")) {
      cb(null, true);
    } else {
      cb(new Error("Solo archivos .xml"));
    }
  },
});

// ── POST /api/recepcion/procesar ──────────────────────────────────────────────
router.post("/procesar", requireJWT, upload.array("xmls", 500), async (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    if (!req.files?.length) return res.status(400).json({ error: "No se recibieron XMLs" });

    const xmlStrings = req.files.map((f) => f.buffer.toString("utf8"));
    const resultados = recepcion.procesarXMLs(xmlStrings, empresaId);

    const ok    = resultados.filter((r) => r.ok).length;
    const error = resultados.filter((r) => !r.ok).length;
    res.json({ ok: true, procesadas: ok, errores: error, resultados });
  } catch (err) {
    console.error("[recepcion/procesar]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/recepcion/lista ──────────────────────────────────────────────────
router.get("/lista", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const { estado } = req.query;
    const lista = recepcion.listarFacturas(empresaId, { estado });
    res.json(lista);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/recepcion/aceptar/:id ──────────────────────────────────────────
router.post("/aceptar/:id", requireJWT, async (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const { mensaje = 1, detalleMensaje, haciendaToken } = req.body;
    const resultado = await recepcion.aceptarFactura(req.params.id, empresaId, {
      mensaje: parseInt(mensaje),
      detalleMensaje,
      haciendaToken: haciendaToken || process.env.HACIENDA_TOKEN,
    });
    res.json(resultado);
  } catch (err) {
    console.error("[recepcion/aceptar]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/recepcion/aceptar-todos ────────────────────────────────────────
router.post("/aceptar-todos", requireJWT, async (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const { haciendaToken } = req.body;
    const pendientes = recepcion.listarFacturas(empresaId, { estado: "pendiente" });

    const resultados = [];
    for (const f of pendientes) {
      try {
        const r = await recepcion.aceptarFactura(f.id, empresaId, {
          mensaje: 1,
          haciendaToken: haciendaToken || process.env.HACIENDA_TOKEN,
        });
        resultados.push({ id: f.id, clave: f.clave, ...r });
      } catch (err) {
        resultados.push({ id: f.id, clave: f.clave, ok: false, error: err.message });
      }
    }
    res.json({ total: pendientes.length, resultados });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
