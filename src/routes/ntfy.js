/**
 * /api/ntfy — Notificaciones push por empresa y por usuario
 *
 * GET  /api/ntfy/config       → topic empresa (broadcast) + URL
 * GET  /api/ntfy/user-config  → topic personal del usuario + URL
 * GET  /api/ntfy/prefs        → preferencias del usuario actual
 * PUT  /api/ntfy/prefs        → actualizar preferencias { tipo: boolean }
 * POST /api/ntfy/test         → notificación de prueba al topic empresa
 * POST /api/ntfy/test-user    → notificación de prueba al topic personal
 */

const express = require("express");
const jwt     = require("jsonwebtoken");
const config  = require("../config");
const { db }  = require("../db");
const {
  getOrCreateNtfyToken,
  getOrCreateUserNtfyToken,
  getTopicForEmpresa,
  getTopicForUser,
  getUserPrefs,
  saveUserPrefs,
  TIPOS_NOTIF,
  ntfy,
  NTFY_BASE_URL,
} = require("../services/ntfy");

const router = express.Router();

// ── Migraciones DB ────────────────────────────────────────────────────────────
try { db.exec("ALTER TABLE users ADD COLUMN ntfy_token TEXT;"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS user_ntfy_prefs (
    user_id        TEXT NOT NULL,
    tipo           TEXT NOT NULL,
    activo         INTEGER NOT NULL DEFAULT 1,
    actualizado_en TEXT NOT NULL,
    PRIMARY KEY (user_id, tipo)
  );
`);

// ── Auth middleware ───────────────────────────────────────────────────────────
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

// ── GET /api/ntfy/config — topic de empresa (broadcast) ──────────────────────
router.get("/config", requireJWT, (req, res) => {
  const { empresaId } = req.jwtPayload;
  const ntfyToken = getOrCreateNtfyToken(empresaId, db);
  const topic     = getTopicForEmpresa(ntfyToken);
  const url       = `${NTFY_BASE_URL}/${topic}`;

  res.json({
    ok: true,
    tipo: "empresa",
    topic,
    url,
    instrucciones: [
      "1. Instalá la app ntfy en tu teléfono (iOS o Android)",
      `2. Agregá este topic: ${topic}`,
      "3. Recibís notificaciones de todos en tu empresa",
    ],
  });
});

// ── GET /api/ntfy/user-config — topic personal del usuario ───────────────────
router.get("/user-config", requireJWT, (req, res) => {
  const userId    = req.jwtPayload.sub;
  const userToken = getOrCreateUserNtfyToken(userId, db);
  const topic     = getTopicForUser(userToken);
  const url       = `${NTFY_BASE_URL}/${topic}`;

  res.json({
    ok: true,
    tipo: "personal",
    topic,
    url,
    instrucciones: [
      "1. Instalá la app ntfy en tu teléfono",
      `2. Agregá este topic: ${topic}`,
      "3. Solo vos recibís tus notificaciones personales",
    ],
  });
});

// ── GET /api/ntfy/prefs — preferencias del usuario actual ────────────────────
router.get("/prefs", requireJWT, (req, res) => {
  const userId = req.jwtPayload.sub;
  const rol    = req.jwtPayload.rol || "colaborador";
  const prefs  = getUserPrefs(userId, rol, db);

  res.json({
    ok: true,
    prefs,
    tipos: TIPOS_NOTIF.map(t => ({ id: t.id, label: t.label, icon: t.icon })),
  });
});

// ── PUT /api/ntfy/prefs — actualizar preferencias ─────────────────────────────
router.put("/prefs", requireJWT, (req, res) => {
  const userId = req.jwtPayload.sub;
  const { prefs } = req.body || {};

  if (!prefs || typeof prefs !== "object")
    return res.status(400).json({ error: "Se requiere objeto prefs { tipo: boolean }" });

  // Solo permitir tipos válidos
  const validIds = new Set(TIPOS_NOTIF.map(t => t.id));
  const filtered = {};
  Object.entries(prefs).forEach(([k, v]) => {
    if (validIds.has(k)) filtered[k] = !!v;
  });

  saveUserPrefs(userId, filtered, db);
  res.json({ ok: true, prefs: filtered });
});

// ── POST /api/ntfy/test — prueba broadcast a empresa ─────────────────────────
router.post("/test", requireJWT, async (req, res) => {
  const { empresaId } = req.jwtPayload;
  await ntfy.test(empresaId, db);
  res.json({ ok: true, mensaje: "Notificación de prueba enviada a toda la empresa" });
});

// ── POST /api/ntfy/test-user — prueba al topic personal ──────────────────────
router.post("/test-user", requireJWT, async (req, res) => {
  const userId = req.jwtPayload.sub;
  await ntfy.testUsuario(userId, db);
  res.json({ ok: true, mensaje: "Notificación de prueba enviada a tu topic personal" });
});

module.exports = router;
