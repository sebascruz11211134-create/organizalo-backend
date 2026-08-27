/**
 * /api/emision — Emisión de comprobantes electrónicos a Hacienda
 *
 * POST  /api/emision/nota-credito    — NC-01 Nota de Crédito
 * POST  /api/emision/nota-debito     — ND-01 Nota de Débito Comercial
 * GET   /api/emision/:tipo/:id/status — Consultar estado en Hacienda
 */

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const jwt     = require("jsonwebtoken");

const config  = require("../config");
const { getEmpresaDb, nextNumeroDocumento } = require("../db");
const { buildClave, buildNumeroConsecutivo } = require("../hacienda/claveGenerator");
const { buildNotaCreditoXML, buildNotaDebitoXML } = require("../hacienda/xmlBuilder");
const { signXml } = require("../hacienda/signer");
const { getAccessToken, enviarComprobante, consultarEstado } = require("../hacienda/client");

const router = express.Router();

// ── Auth ──────────────────────────────────────────────────────────────────────
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

// ── Tabla de notas emitidas (NC + ND) ────────────────────────────────────────
function ensureNotasTable(edb) {
  edb.exec(`
    CREATE TABLE IF NOT EXISTS notas_emitidas (
      id                 TEXT PRIMARY KEY,
      empresa_id         TEXT,
      tipo               TEXT NOT NULL,
      clave              TEXT UNIQUE,
      numero_consecutivo TEXT,
      numero_documento   INTEGER,
      cliente_nombre     TEXT,
      cliente_cedula     TEXT,
      cliente_correo     TEXT,
      moneda             TEXT DEFAULT 'CRC',
      total              REAL DEFAULT 0,
      referencia_numero  TEXT,
      estado             TEXT DEFAULT 'creado',
      modo_simulacion    INTEGER DEFAULT 0,
      xml_firmado_base64 TEXT,
      respuesta_hacienda TEXT,
      items_json         TEXT,
      creado_en          TEXT,
      actualizado_en     TEXT
    );
  `);
}

function rowToNota(row) {
  return {
    id:               row.id,
    tipo:             row.tipo,
    clave:            row.clave,
    numeroConsecutivo: row.numero_consecutivo,
    cliente: {
      nombre: row.cliente_nombre,
      cedula: row.cliente_cedula || null,
      correo: row.cliente_correo || null,
    },
    moneda:            row.moneda,
    total:             row.total,
    referenciaNumero:  row.referencia_numero,
    estado:            row.estado,
    modoSimulacion:    !!row.modo_simulacion,
    items:             JSON.parse(row.items_json || "[]"),
    respuestaHacienda: row.respuesta_hacienda ? JSON.parse(row.respuesta_hacienda) : null,
    creadoEn:          row.creado_en,
    actualizadoEn:     row.actualizado_en,
  };
}

// ── POST /api/emision/nota-credito ────────────────────────────────────────────
// Body: { cliente, items, moneda?, tipoCambio?, referenciaNumero?, referenciaFecha?, referenciaRazon? }
router.post("/nota-credito", requireJWT, async (req, res) => {
  try {
    const {
      cliente, items,
      moneda = "CRC", tipoCambio = 1,
      referenciaNumero, referenciaFecha, referenciaRazon = "Anulación de comprobante",
    } = req.body || {};

    if (!cliente?.nombre) return res.status(400).json({ error: "Falta cliente.nombre." });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Falta al menos un item." });
    if (!config.emisor.cedulaNumero) return res.status(500).json({ error: "EMISOR_* no configurado en .env" });

    const empresaId = req.jwtPayload?.empresaId;
    const edb = getEmpresaDb(empresaId);
    ensureNotasTable(edb);

    const numeroDocumento   = nextNumeroDocumento(empresaId);
    const numeroConsecutivo = buildNumeroConsecutivo(numeroDocumento, { tipoDocumento: "03" });
    const clave             = buildClave({ cedulaEmisor: config.emisor.cedulaNumero, numeroConsecutivo });

    const xml = buildNotaCreditoXML({
      clave, numeroConsecutivo,
      emisor: config.emisor,
      receptor: {
        nombre:       cliente.nombre,
        cedulaNumero: cliente.cedula,
        correo:       cliente.correo,
      },
      items, moneda, tipoCambio,
      referenciaNumero, referenciaFecha, referenciaRazon,
    });

    const total = items.reduce((s, it) => {
      const m = Number(it.cantidad) * Number(it.precioUnitario);
      return s + m + m * ((it.tarifaIva ?? 13) / 100);
    }, 0);

    const now = new Date().toISOString();
    const id  = uuidv4();
    let estado = "creado";
    let xmlFirmadoBase64  = null;
    let respuestaHacienda = null;

    if (config.modoSimulacion) {
      estado = "simulado";
      respuestaHacienda = { nota: "MODO_SIMULACION activo — NC no enviada a Hacienda." };
      try {
        xmlFirmadoBase64 = await signXml(xml, { keyPath: config.cryptoKeyPath, keyPassword: config.cryptoKeyPassword });
      } catch {
        xmlFirmadoBase64 = Buffer.from(xml, "utf8").toString("base64");
      }
    } else {
      xmlFirmadoBase64 = await signXml(xml, { keyPath: config.cryptoKeyPath, keyPassword: config.cryptoKeyPassword });
      const token = await getAccessToken({ env: config.haciendaEnv, username: config.haciendaUsername, password: config.haciendaPassword });
      const envioResult = await enviarComprobante({
        env: config.haciendaEnv, token, clave, xmlFirmadoBase64,
        emisorCedula:   config.emisor.cedulaNumero,
        receptorCedula: cliente.cedula,
        fecha:          now,
      });
      estado = "enviado";
      respuestaHacienda = envioResult;
    }

    edb.prepare(`
      INSERT INTO notas_emitidas
      (id, empresa_id, tipo, clave, numero_consecutivo, numero_documento,
       cliente_nombre, cliente_cedula, cliente_correo, moneda, total, referencia_numero,
       estado, modo_simulacion, xml_firmado_base64, respuesta_hacienda, items_json, creado_en, actualizado_en)
      VALUES (?, ?, 'NC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, empresaId || null, clave, numeroConsecutivo, numeroDocumento,
      cliente.nombre, cliente.cedula || null, cliente.correo || null,
      moneda, total, referenciaNumero || null, estado, config.modoSimulacion ? 1 : 0,
      xmlFirmadoBase64, JSON.stringify(respuestaHacienda), JSON.stringify(items), now, now);

    const row = edb.prepare("SELECT * FROM notas_emitidas WHERE id = ?").get(id);
    res.status(201).json(rowToNota(row));
  } catch (err) {
    console.error("[emision/nota-credito]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/emision/nota-debito ─────────────────────────────────────────────
router.post("/nota-debito", requireJWT, async (req, res) => {
  try {
    const {
      cliente, items,
      moneda = "CRC", tipoCambio = 1,
      referenciaNumero, referenciaFecha, referenciaRazon = "Cargo adicional",
    } = req.body || {};

    if (!cliente?.nombre) return res.status(400).json({ error: "Falta cliente.nombre." });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Falta al menos un item." });
    if (!config.emisor.cedulaNumero) return res.status(500).json({ error: "EMISOR_* no configurado en .env" });

    const empresaId = req.jwtPayload?.empresaId;
    const edb = getEmpresaDb(empresaId);
    ensureNotasTable(edb);

    const numeroDocumento   = nextNumeroDocumento(empresaId);
    const numeroConsecutivo = buildNumeroConsecutivo(numeroDocumento, { tipoDocumento: "02" });
    const clave             = buildClave({ cedulaEmisor: config.emisor.cedulaNumero, numeroConsecutivo });

    const xml = buildNotaDebitoXML({
      clave, numeroConsecutivo,
      emisor: config.emisor,
      receptor: {
        nombre:       cliente.nombre,
        cedulaNumero: cliente.cedula,
        correo:       cliente.correo,
      },
      items, moneda, tipoCambio,
      referenciaNumero, referenciaFecha, referenciaRazon,
    });

    const total = items.reduce((s, it) => {
      const m = Number(it.cantidad) * Number(it.precioUnitario);
      return s + m + m * ((it.tarifaIva ?? 13) / 100);
    }, 0);

    const now = new Date().toISOString();
    const id  = uuidv4();
    let estado = "creado";
    let xmlFirmadoBase64  = null;
    let respuestaHacienda = null;

    if (config.modoSimulacion) {
      estado = "simulado";
      respuestaHacienda = { nota: "MODO_SIMULACION activo — ND no enviada a Hacienda." };
      try {
        xmlFirmadoBase64 = await signXml(xml, { keyPath: config.cryptoKeyPath, keyPassword: config.cryptoKeyPassword });
      } catch {
        xmlFirmadoBase64 = Buffer.from(xml, "utf8").toString("base64");
      }
    } else {
      xmlFirmadoBase64 = await signXml(xml, { keyPath: config.cryptoKeyPath, keyPassword: config.cryptoKeyPassword });
      const token = await getAccessToken({ env: config.haciendaEnv, username: config.haciendaUsername, password: config.haciendaPassword });
      const envioResult = await enviarComprobante({
        env: config.haciendaEnv, token, clave, xmlFirmadoBase64,
        emisorCedula:   config.emisor.cedulaNumero,
        receptorCedula: cliente.cedula,
        fecha:          now,
      });
      estado = "enviado";
      respuestaHacienda = envioResult;
    }

    edb.prepare(`
      INSERT INTO notas_emitidas
      (id, empresa_id, tipo, clave, numero_consecutivo, numero_documento,
       cliente_nombre, cliente_cedula, cliente_correo, moneda, total, referencia_numero,
       estado, modo_simulacion, xml_firmado_base64, respuesta_hacienda, items_json, creado_en, actualizado_en)
      VALUES (?, ?, 'ND', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, empresaId || null, clave, numeroConsecutivo, numeroDocumento,
      cliente.nombre, cliente.cedula || null, cliente.correo || null,
      moneda, total, referenciaNumero || null, estado, config.modoSimulacion ? 1 : 0,
      xmlFirmadoBase64, JSON.stringify(respuestaHacienda), JSON.stringify(items), now, now);

    const row = edb.prepare("SELECT * FROM notas_emitidas WHERE id = ?").get(id);
    res.status(201).json(rowToNota(row));
  } catch (err) {
    console.error("[emision/nota-debito]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/emision/notas — Listar NC y ND emitidas ─────────────────────────
router.get("/notas", requireJWT, (req, res) => {
  try {
    const empresaId = req.jwtPayload?.empresaId;
    const edb = getEmpresaDb(empresaId);
    ensureNotasTable(edb);
    const rows = edb.prepare("SELECT * FROM notas_emitidas WHERE empresa_id = ? ORDER BY creado_en DESC").all(empresaId || null);
    res.json(rows.map(rowToNota));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/emision/notas/:id/status — Consultar estado Hacienda ─────────────
router.get("/notas/:id/status", requireJWT, async (req, res) => {
  try {
    const empresaId = req.jwtPayload?.empresaId;
    const edb = getEmpresaDb(empresaId);
    ensureNotasTable(edb);
    const row = edb.prepare("SELECT * FROM notas_emitidas WHERE id = ? AND empresa_id = ?").get(req.params.id, empresaId || null);
    if (!row) return res.status(404).json({ error: "Nota no encontrada." });

    if (row.modo_simulacion) return res.json(rowToNota(row));

    const token = await getAccessToken({ env: config.haciendaEnv, username: config.haciendaUsername, password: config.haciendaPassword });
    const estadoHacienda = await consultarEstado({ env: config.haciendaEnv, token, clave: row.clave });
    const nuevoEstado = estadoHacienda?.["ind-estado"] || estadoHacienda?.estado || row.estado;
    const now = new Date().toISOString();
    edb.prepare("UPDATE notas_emitidas SET estado = ?, respuesta_hacienda = ?, actualizado_en = ? WHERE id = ?")
      .run(nuevoEstado, JSON.stringify(estadoHacienda), now, row.id);
    res.json(rowToNota(edb.prepare("SELECT * FROM notas_emitidas WHERE id = ?").get(row.id)));
  } catch (err) {
    console.error("[emision/notas/status]", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
