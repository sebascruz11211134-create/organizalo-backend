/**
 * /api/cert — Gestión del certificado .p12 por empresa
 *
 * POST   /api/cert/upload   — Subir/reemplazar el .p12 (multipart/form-data)
 * GET    /api/cert/status   — Ver si hay cert configurado (sin revelar el cert)
 * DELETE /api/cert          — Eliminar el cert de esta empresa
 */

const express    = require("express");
const multer     = require("multer");
const jwt        = require("jsonwebtoken");
const config     = require("../config");
const certService = require("../certService");

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

// multer en memoria — el .p12 nunca toca el disco
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // max 2 MB
  fileFilter(req, file, cb) {
    if (file.originalname.endsWith(".p12") || file.mimetype === "application/x-pkcs12") {
      cb(null, true);
    } else {
      cb(new Error("Solo se aceptan archivos .p12"));
    }
  },
});

// ── POST /api/cert/upload ─────────────────────────────────────────────────────
router.post("/upload", requireJWT, upload.single("cert"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió ningún archivo .p12" });
    const { password, cedula, nombre } = req.body;
    if (!password) return res.status(400).json({ error: "La contraseña del .p12 es requerida" });

    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;

    // Verificar que el .p12 sea válido (intentar leerlo)
    try {
      const forge = require("node-forge");
      forge.pkcs12.pkcs12FromAsn1(
        forge.asn1.fromDer(req.file.buffer.toString("binary")),
        password
      );
    } catch {
      return res.status(400).json({ error: "Contraseña incorrecta o archivo .p12 inválido" });
    }

    certService.saveCert(empresaId, req.file.buffer, password, { cedula, nombre });
    res.json({ ok: true, message: "Certificado guardado correctamente" });
  } catch (err) {
    console.error("[cert/upload]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/cert/status ──────────────────────────────────────────────────────
router.get("/status", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const status = certService.getCertStatus(empresaId);
    res.json(status || { configured: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/cert ──────────────────────────────────────────────────────────
router.delete("/", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    certService.deleteCert(empresaId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/cert/atv — Guardar credenciales ATV de Hacienda ─────────────────
router.post("/atv", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const { usuario, password } = req.body;
    if (!usuario || !password) {
      return res.status(400).json({ error: "Usuario y contraseña ATV son requeridos" });
    }
    certService.saveATV(empresaId, usuario, password);
    res.json({ ok: true, message: "Credenciales ATV guardadas correctamente" });
  } catch (err) {
    console.error("[cert/atv]", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
