/**
 * /api/ntfy — Gestión de notificaciones push por empresa
 *
 * GET  /api/ntfy/config    → devuelve topic + URL para suscribirse
 * POST /api/ntfy/test      → envía notificación de prueba
 */

const express = require("express");
const jwt     = require("jsonwebtoken");
const config  = require("../config");
const { db }  = require("../db");
const { getOrCreateNtfyToken, getTopicForEmpresa, ntfy, NTFY_BASE_URL } = require("../services/ntfy");

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

// GET /api/ntfy/config — devuelve el topic de la empresa para suscripción
router.get("/config", requireJWT, (req, res) => {
  const { empresaId } = req.jwtPayload;
  const ntfyToken = getOrCreateNtfyToken(empresaId, db);
  const topic     = getTopicForEmpresa(ntfyToken);
  const url       = `${NTFY_BASE_URL}/${topic}`;

  res.json({
    ok: true,
    topic,
    url,
    ntfyAppUrl: `ntfy://${NTFY_BASE_URL.replace(/https?:\/\//, "")}/${topic}`,
    instrucciones: [
      "1. Instalá la app ntfy en tu teléfono (iOS o Android)",
      `2. Agregá este topic: ${topic}`,
      "3. Listo — vas a recibir notificaciones de Organízalo.AI",
    ],
  });
});

// POST /api/ntfy/test — envía notificación de prueba
router.post("/test", requireJWT, async (req, res) => {
  const { empresaId } = req.jwtPayload;
  await ntfy.test(empresaId, db);
  res.json({ ok: true, mensaje: "Notificación de prueba enviada" });
});

module.exports = router;
