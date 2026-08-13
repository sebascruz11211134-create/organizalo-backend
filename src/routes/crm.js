/**
 * /api/crm — Interacciones CRM por cliente
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

// ── GET interacciones de un cliente ──────────────────────────────────────────
router.get("/interacciones", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const edb = getEmpresaDb(empresaId);
    const { clienteId } = req.query;

    let rows;
    if (clienteId) {
      rows = edb.prepare(
        "SELECT * FROM crm_interacciones WHERE cliente_id = ? ORDER BY fecha DESC, creado_en DESC"
      ).all(clienteId);
    } else {
      rows = edb.prepare(
        "SELECT * FROM crm_interacciones ORDER BY fecha DESC, creado_en DESC LIMIT 200"
      ).all();
    }

    res.json(rows);
  } catch (err) {
    console.error("[crm/interacciones/GET]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET analytics de un cliente ───────────────────────────────────────────────
router.get("/analytics/:clienteId", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const edb = getEmpresaDb(empresaId);
    const { clienteId } = req.params;

    let facturas = [];
    try {
      const row = edb.prepare("SELECT valor FROM cloud_data WHERE clave = 'facturas'").get();
      if (row?.valor) {
        const todas = JSON.parse(row.valor);
        facturas = todas.filter(f =>
          f.cliente?.codigo === clienteId ||
          f.cliente?.id    === clienteId ||
          f.clienteId      === clienteId
        );
      }
    } catch (_) {}

    const interacciones = edb.prepare(
      "SELECT * FROM crm_interacciones WHERE cliente_id = ? ORDER BY fecha DESC"
    ).all(clienteId);

    let frecuenciaDias = null, diasDesdeUltimaCompra = null, proximaCompraEstimada = null;

    if (facturas.length >= 2) {
      const fechas = facturas
        .map(f => new Date(f.creadoEn || f.creado_en || f.fecha).getTime())
        .filter(t => !isNaN(t)).sort((a, b) => b - a);
      if (fechas.length >= 2) {
        const difs = [];
        for (let i = 0; i < fechas.length - 1; i++) difs.push((fechas[i] - fechas[i+1]) / 86400000);
        frecuenciaDias = Math.round(difs.reduce((s, d) => s + d, 0) / difs.length);
      }
    }

    if (facturas.length >= 1) {
      const fechaUltima = facturas
        .map(f => new Date(f.creadoEn || f.creado_en || f.fecha).getTime())
        .filter(t => !isNaN(t)).sort((a, b) => b - a)[0];
      if (fechaUltima) {
        diasDesdeUltimaCompra = Math.round((Date.now() - fechaUltima) / 86400000);
        if (frecuenciaDias) {
          proximaCompraEstimada = new Date(fechaUltima + frecuenciaDias * 86400000)
            .toISOString().split("T")[0];
        }
      }
    }

    res.json({
      clienteId,
      totalFacturas: facturas.length,
      totalCompras: facturas.reduce((s, f) => s + (f.total || 0), 0),
      frecuenciaDias,
      diasDesdeUltimaCompra,
      proximaCompraEstimada,
      ultimaCompra: facturas.length ? (facturas[0].creadoEn || facturas[0].fecha || null) : null,
      ultimaInteraccion: interacciones[0]?.fecha || null,
      facturas,
      interacciones,
    });
  } catch (err) {
    console.error("[crm/analytics]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST registrar interacción ────────────────────────────────────────────────
router.post("/interacciones", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const edb = getEmpresaDb(empresaId);
    const { cliente_id, cliente_nombre, tipo = "nota", titulo, descripcion, fecha } = req.body;

    if (!cliente_id || !descripcion)
      return res.status(400).json({ error: "cliente_id y descripcion son requeridos" });

    const id    = randomUUID();
    const ahora = new Date().toISOString();

    edb.prepare(`
      INSERT INTO crm_interacciones (id, empresa_id, cliente_id, cliente_nombre, tipo, titulo, descripcion, fecha, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, empresaId, cliente_id, cliente_nombre || null, tipo, titulo || null, descripcion, fecha || ahora.split("T")[0], ahora);

    res.status(201).json(edb.prepare("SELECT * FROM crm_interacciones WHERE id = ?").get(id));
  } catch (err) {
    console.error("[crm/interacciones/POST]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE interacción ────────────────────────────────────────────────────────
router.delete("/interacciones/:id", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload.empresaId || req.jwtPayload.id;
    const edb = getEmpresaDb(empresaId);
    const r = edb.prepare("DELETE FROM crm_interacciones WHERE id = ?").run(req.params.id);
    if (r.changes === 0) return res.status(404).json({ error: "Interacción no encontrada" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
