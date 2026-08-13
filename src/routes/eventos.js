/**
 * /api/eventos — Calendario de eventos y recordatorios por empresa
 * Cada empresa tiene su propio SQLite — datos completamente aislados.
 */

const express = require("express");
const jwt     = require("jsonwebtoken");
const config  = require("../config");
const { getEmpresaDb } = require("../db");
const { randomUUID } = require("crypto");

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

// ── GET eventos ───────────────────────────────────────────────────────────────
router.get("/", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const edb = getEmpresaDb(empresaId);
    let { mes, desde, hasta } = req.query;

    let rows;
    if (mes) { desde = `${mes}-01`; hasta = `${mes}-31`; }

    if (desde && hasta) {
      rows = edb.prepare(
        "SELECT * FROM eventos WHERE fecha >= ? AND fecha <= ? ORDER BY fecha, hora"
      ).all(desde, hasta);
    } else {
      const hace90 = new Date(Date.now() - 90*24*60*60*1000).toISOString().split("T")[0];
      const en90   = new Date(Date.now() + 90*24*60*60*1000).toISOString().split("T")[0];
      rows = edb.prepare(
        "SELECT * FROM eventos WHERE fecha >= ? AND fecha <= ? ORDER BY fecha, hora"
      ).all(hace90, en90);
    }

    res.json(rows);
  } catch (err) {
    console.error("[eventos/GET]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST crear evento ─────────────────────────────────────────────────────────
router.post("/", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const edb = getEmpresaDb(empresaId);
    const {
      titulo, descripcion, tipo = "evento",
      fecha, hora, todo_el_dia = 0,
      cliente_id, cliente_nombre, color = "#10b981"
    } = req.body;

    if (!titulo || !fecha) return res.status(400).json({ error: "titulo y fecha son requeridos" });

    const id = randomUUID();
    const ahora = new Date().toISOString();

    edb.prepare(`
      INSERT INTO eventos (id, empresa_id, titulo, descripcion, tipo, fecha, hora,
        todo_el_dia, cliente_id, cliente_nombre, completado, color, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, empresaId, titulo, descripcion || null, tipo, fecha,
           hora || null, todo_el_dia ? 1 : 0,
           cliente_id || null, cliente_nombre || null, color, ahora);

    const evento = edb.prepare("SELECT * FROM eventos WHERE id = ?").get(id);
    res.status(201).json(evento);
  } catch (err) {
    console.error("[eventos/POST]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT actualizar evento ─────────────────────────────────────────────────────
router.put("/:id", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const edb = getEmpresaDb(empresaId);
    const { id } = req.params;
    const {
      titulo, descripcion, tipo, fecha, hora,
      todo_el_dia, cliente_id, cliente_nombre, color, completado
    } = req.body;

    const existing = edb.prepare("SELECT id FROM eventos WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ error: "Evento no encontrado" });

    edb.prepare(`
      UPDATE eventos SET
        titulo = COALESCE(?, titulo),
        descripcion = COALESCE(?, descripcion),
        tipo = COALESCE(?, tipo),
        fecha = COALESCE(?, fecha),
        hora = COALESCE(?, hora),
        todo_el_dia = COALESCE(?, todo_el_dia),
        cliente_id = COALESCE(?, cliente_id),
        cliente_nombre = COALESCE(?, cliente_nombre),
        color = COALESCE(?, color),
        completado = COALESCE(?, completado)
      WHERE id = ?
    `).run(titulo, descripcion, tipo, fecha, hora,
           todo_el_dia !== undefined ? (todo_el_dia ? 1 : 0) : null,
           cliente_id, cliente_nombre, color,
           completado !== undefined ? (completado ? 1 : 0) : null,
           id);

    const updated = edb.prepare("SELECT * FROM eventos WHERE id = ?").get(id);
    res.json(updated);
  } catch (err) {
    console.error("[eventos/PUT]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH completar ───────────────────────────────────────────────────────────
router.patch("/:id/completar", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const edb = getEmpresaDb(empresaId);
    edb.prepare("UPDATE eventos SET completado = 1 WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE por título (usado al saldar CXC/CXP) ──────────────────────────────
// Body: { tituloMatch, fecha }  — elimina el primer evento cuyo título contiene tituloMatch y tiene esa fecha
router.delete("/por-titulo", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const edb = getEmpresaDb(empresaId);
    const { tituloMatch, fecha } = req.body;
    if (!tituloMatch) return res.status(400).json({ error: "tituloMatch requerido" });

    let rows;
    if (fecha) {
      rows = edb.prepare(
        "SELECT id FROM eventos WHERE titulo LIKE ? AND fecha = ? LIMIT 5"
      ).all(`%${tituloMatch}%`, fecha);
    } else {
      rows = edb.prepare(
        "SELECT id FROM eventos WHERE titulo LIKE ? LIMIT 5"
      ).all(`%${tituloMatch}%`);
    }

    let deleted = 0;
    for (const row of rows) {
      edb.prepare("DELETE FROM eventos WHERE id = ?").run(row.id);
      deleted++;
    }
    res.json({ ok: true, deleted });
  } catch (err) {
    console.error("[eventos/por-titulo DELETE]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE evento ─────────────────────────────────────────────────────────────
router.delete("/:id", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const edb = getEmpresaDb(empresaId);
    const r = edb.prepare("DELETE FROM eventos WHERE id = ?").run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: "Evento no encontrado" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
