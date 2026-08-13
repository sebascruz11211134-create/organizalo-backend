const express = require("express");
const { v4: uuidv4 } = require("uuid");
const jwt    = require("jsonwebtoken");

const config = require("../config");
const { getEmpresaDb, nextNumeroDocumento } = require("../db");
const { buildClave, buildNumeroConsecutivo } = require("../hacienda/claveGenerator");
const { buildFacturaElectronicaXML } = require("../hacienda/xmlBuilder");
const { signXml } = require("../hacienda/signer");
const { getAccessToken, enviarComprobante, consultarEstado } = require("../hacienda/client");

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

function rowToInvoice(row) {
  return {
    id: row.id,
    clave: row.clave,
    numeroConsecutivo: row.numero_consecutivo,
    numeroDocumento: row.numero_documento,
    cliente: {
      nombre: row.cliente_nombre,
      cedula: row.cliente_cedula || null,
      correo: row.cliente_correo || null,
    },
    moneda: row.moneda,
    total: row.total,
    estado: row.estado,
    modoSimulacion: !!row.modo_simulacion,
    items: JSON.parse(row.items_json),
    respuestaHacienda: row.respuesta_hacienda ? JSON.parse(row.respuesta_hacienda) : null,
    creadoEn: row.creado_en,
    actualizadoEn: row.actualizado_en,
  };
}

// POST /api/invoices
// Body: { cliente: { nombre, cedula?, correo? }, items: [{ descripcion, cantidad, precioUnitario, tarifaIva? }], moneda?, tipoCambio? }
router.post("/", requireJWT, async (req, res) => {
  try {
    const { cliente, items, moneda = "CRC", tipoCambio = 1 } = req.body || {};

    if (!cliente?.nombre) {
      return res.status(400).json({ error: "Falta cliente.nombre." });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Falta al menos un item en items[]." });
    }
    for (const item of items) {
      if (!item.descripcion || !item.cantidad || item.precioUnitario == null) {
        return res.status(400).json({
          error: "Cada item necesita descripcion, cantidad y precioUnitario.",
        });
      }
    }
    if (!config.emisor.cedulaNumero) {
      return res.status(500).json({
        error: "El backend no tiene datos del emisor configurados (EMISOR_* en .env).",
      });
    }

    const empresaId = req.jwtPayload?.empresaId;
    const edb = getEmpresaDb(empresaId);
    const numeroDocumento = nextNumeroDocumento(empresaId);
    const numeroConsecutivo = buildNumeroConsecutivo(numeroDocumento, { tipoDocumento: "01" });
    const clave = buildClave({ cedulaEmisor: config.emisor.cedulaNumero, numeroConsecutivo });

    const xml = buildFacturaElectronicaXML({
      clave,
      numeroConsecutivo,
      emisor: config.emisor,
      receptor: {
        nombre: cliente.nombre,
        cedulaNumero: cliente.cedula,
        correo: cliente.correo,
      },
      items,
      moneda,
      tipoCambio,
    });

    const total = items.reduce((sum, it) => {
      const monto = Number(it.cantidad) * Number(it.precioUnitario);
      const tarifaIva = it.tarifaIva ?? 13;
      return sum + monto + monto * (tarifaIva / 100);
    }, 0);

    const now = new Date().toISOString();
    const id = uuidv4();
    let estado = "creado";
    let xmlFirmadoBase64 = null;
    let respuestaHacienda = null;

    if (config.modoSimulacion) {
      // No llamamos a Hacienda de verdad: firmamos si hay llave configurada,
      // si no, guardamos el XML sin firmar y lo marcamos como "simulado".
      estado = "simulado";
      respuestaHacienda = {
        nota: "MODO_SIMULACION activo — no se envió nada a Hacienda. Esto es solo para probar el flujo app → backend → XML.",
      };
      try {
        xmlFirmadoBase64 = await signXml(xml, {
          keyPath: config.cryptoKeyPath,
          keyPassword: config.cryptoKeyPassword,
        });
      } catch (err) {
        // Sin llave real todavía es esperado en simulación — seguimos sin firmar.
        xmlFirmadoBase64 = Buffer.from(xml, "utf8").toString("base64");
        respuestaHacienda.avisoFirma = `No se firmó (esperado sin llave real en simulación): ${err.message}`;
      }
    } else {
      // Camino real: firmar y enviar a Hacienda.
      xmlFirmadoBase64 = await signXml(xml, {
        keyPath: config.cryptoKeyPath,
        keyPassword: config.cryptoKeyPassword,
      });

      const token = await getAccessToken({
        env: config.haciendaEnv,
        username: config.haciendaUsername,
        password: config.haciendaPassword,
      });

      const envioResult = await enviarComprobante({
        env: config.haciendaEnv,
        token,
        clave,
        xmlFirmadoBase64,
        emisorCedula: config.emisor.cedulaNumero,
        receptorCedula: cliente.cedula,
        fecha: now,
      });

      estado = "enviado";
      respuestaHacienda = envioResult;
    }

    edb.prepare(
      `INSERT INTO invoices
        (id, empresa_id, clave, numero_consecutivo, numero_documento, cliente_nombre, cliente_cedula, cliente_correo,
         moneda, total, estado, modo_simulacion, xml_firmado_base64, respuesta_hacienda, items_json,
         creado_en, actualizado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      empresaId || null,
      clave,
      numeroConsecutivo,
      numeroDocumento,
      cliente.nombre,
      cliente.cedula || null,
      cliente.correo || null,
      moneda,
      total,
      estado,
      config.modoSimulacion ? 1 : 0,
      xmlFirmadoBase64,
      JSON.stringify(respuestaHacienda),
      JSON.stringify(items),
      now,
      now
    );

    const row = edb.prepare("SELECT * FROM invoices WHERE id = ?").get(id);
    res.status(201).json(rowToInvoice(row));
  } catch (err) {
    console.error("Error creando factura:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/invoices
router.get("/", requireJWT, (req, res) => {
  const empresaId = req.jwtPayload?.empresaId;
  const edb = getEmpresaDb(empresaId);
  const rows = edb.prepare("SELECT * FROM invoices ORDER BY creado_en DESC").all();
  res.json(rows.map(rowToInvoice));
});

// GET /api/invoices/:id/status  -> consulta y actualiza el estado en Hacienda
router.get("/:id/status", requireJWT, async (req, res) => {
  try {
    const empresaId = req.jwtPayload?.empresaId;
    const edb = getEmpresaDb(empresaId);
    const row = edb.prepare("SELECT * FROM invoices WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Factura no encontrada." });

    if (row.modo_simulacion) {
      return res.json(rowToInvoice(row));
    }

    const token = await getAccessToken({
      env: config.haciendaEnv,
      username: config.haciendaUsername,
      password: config.haciendaPassword,
    });
    const estadoHacienda = await consultarEstado({ env: config.haciendaEnv, token, clave: row.clave });

    const nuevoEstado = estadoHacienda?.["ind-estado"] || estadoHacienda?.estado || row.estado;
    const now = new Date().toISOString();

    edb.prepare("UPDATE invoices SET estado = ?, respuesta_hacienda = ?, actualizado_en = ? WHERE id = ?").run(
      nuevoEstado, JSON.stringify(estadoHacienda), now, row.id
    );

    res.json(rowToInvoice(edb.prepare("SELECT * FROM invoices WHERE id = ?").get(row.id)));
  } catch (err) {
    console.error("Error consultando estado:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
