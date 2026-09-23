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

// Claves de arrays que requieren sello de auditoría por usuario
const CLAVES_AUDITABLES = new Set([
  "@finanzia/facturas",
  "@finanzia/pedidos",
  "@finanzia/cotizaciones",
  "@finanzia/contactos",
  "@finanzia/ordenesTrabajo",
  "@finanzia/recibos",
]);

function sellarCreadoPor(claveExistente, nuevoArray, autor) {
  if (!Array.isArray(nuevoArray)) return nuevoArray;
  const idsExistentes = new Set((claveExistente || []).map(i => i?.id).filter(Boolean));
  return nuevoArray.map(item => {
    if (!item?.id || idsExistentes.has(item.id)) return item; // ítem existente — no tocar
    return { ...item, creadoPor: autor };                      // ítem nuevo — sellar
  });
}

// ── GET /api/clouddata/ping — diagnóstico ─────────────────────────────────────
router.get("/ping", requireJWT, (req, res) => {
  const { empresaId: rawEmpresaId, sub, email } = req.jwtPayload;
  const empresaId = rawEmpresaId || sub;
  try {
    const edb = getEmpresaDb(empresaId);
    const count = edb.prepare("SELECT COUNT(*) as n FROM cloud_data").get();
    res.json({ ok: true, empresaId, sub, email, rows: count.n });
  } catch (err) {
    res.status(500).json({ ok: false, empresaId, sub, email, error: err.message });
  }
});

const store = require('../services/cloudStore');
router.post('/push', requireJWT, (req,res) => {
  try {
    const { data, baseVersions } = req.body || {};
    if (!data || Array.isArray(data) || typeof data !== 'object') return res.status(400).json({error:'data requerido'});
    const empresaId=req.jwtPayload.empresaId || req.jwtPayload.sub;
    const result=store.push(getEmpresaDb(empresaId),data,baseVersions,req.jwtPayload.sub);
    req.app.get('io')?.to(`empresa:${empresaId}:general`).emit('data:changed',{updatedAt:new Date().toISOString()});
    res.json({ok:true,...result});
  } catch(e) { res.status(e.status || 500).json({error:e.message,conflicts:e.conflicts}); }
});
router.get('/pull', requireJWT, (req,res) => {
  try { res.json(store.snapshot(getEmpresaDb(req.jwtPayload.empresaId || req.jwtPayload.sub))); }
  catch(e) { res.status(500).json({error:e.message}); }
});
module.exports=router;
