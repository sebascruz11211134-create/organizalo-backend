/**
 * /api/clouddata — Sincronización de datos del desktop/web a la nube.
 * Cada empresa tiene su propio SQLite — no hay mezcla posible.
 *
 * POST /api/clouddata/push   { data: { clave: valor, ... } }
 * GET  /api/clouddata/pull   → { data: { clave: valor, ... } }
 */

const express = require("express");
const jwt     = require("jsonwebtoken");
const { getEmpresaDb } = require("../db");
const config  = require("../config");

const router  = express.Router();

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

// ── POST /api/clouddata/push ──────────────────────────────────────────────────
router.post("/push", requireJWT, (req, res) => {
  try {
    const { empresaId } = req.jwtPayload;
    const { data } = req.body || {};
    if (!data || typeof data !== "object") return res.status(400).json({ error: "data requerido." });

    const edb = getEmpresaDb(empresaId);
    const now = new Date().toISOString();
    const insert = edb.prepare(`
      INSERT INTO cloud_data (clave, valor, actualizado_en)
      VALUES (?, ?, ?)
      ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado_en = excluded.actualizado_en
    `);

    for (const [clave, valor] of Object.entries(data)) {
      insert.run(clave, JSON.stringify(valor), now);
    }

    // ── Notificar a todos los demás clientes de la misma empresa en tiempo real ──
    const io = req.app.get("io");
    if (io) {
      io.to(`empresa:${empresaId}:general`).emit("data:changed", {
        updatedAt: now,
        origen:    req.jwtPayload.userId || "unknown",
      });
    }

    res.json({ ok: true, claves: Object.keys(data).length });
  } catch (err) {
    console.error("[clouddata/push]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── GET /api/clouddata/pull ───────────────────────────────────────────────────
router.get("/pull", requireJWT, (req, res) => {
  try {
    const { empresaId } = req.jwtPayload;
    const edb = getEmpresaDb(empresaId);
    const rows = edb.prepare("SELECT clave, valor, actualizado_en FROM cloud_data").all();
    const data = {};
    for (const row of rows) {
      try { data[row.clave] = JSON.parse(row.valor); } catch { data[row.clave] = row.valor; }
    }
    res.json({ data, total: rows.length });
  } catch (err) {
    console.error("[clouddata/pull]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

module.exports = router;
