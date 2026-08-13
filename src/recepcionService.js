/**
 * recepcionService.js — Recepción masiva de facturas electrónicas XML
 *
 * Flujo por factura:
 * 1. parsearXML(xmlString)         → extrae datos del comprobante recibido
 * 2. buildMensajeReceptor(datos)   → construye el XML del Mensaje Receptor v4.3
 * 3. firmarMensaje(xmlStr, cert)   → firma con el .p12 de la empresa receptora
 * 4. enviarHacienda(signedB64)     → POST a la API de Hacienda
 */

const { XMLParser } = require("fast-xml-parser");
const Signer = require("haciendacostarica-signer");
const certService = require("./certService");
const { db } = require("./db");

// ── Tabla de facturas recibidas ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS facturas_recibidas (
    id            TEXT PRIMARY KEY,
    empresa_id    TEXT NOT NULL,
    clave         TEXT NOT NULL,
    consecutivo_receptor TEXT,
    emisor_nombre TEXT,
    emisor_cedula TEXT,
    fecha_emision TEXT,
    moneda        TEXT,
    total_factura REAL,
    total_iva     REAL,
    lineas_json   TEXT,
    xml_original  TEXT,
    estado        TEXT NOT NULL DEFAULT 'pendiente',
    mensaje_tipo  INTEGER DEFAULT 1,
    respuesta_hacienda TEXT,
    creado_en     TEXT NOT NULL,
    actualizado_en TEXT NOT NULL,
    UNIQUE(empresa_id, clave)
  );
`);

// ── Hacienda API endpoints ────────────────────────────────────────────────────
const HACIENDA_API = {
  prod:    "https://api.comprobanteselectronicos.go.cr/recepcion/v1/recepcion",
  sandbox: "https://api-sandbox.comprobanteselectronicos.go.cr/recepcion/v1/recepcion",
};

function getApiUrl() {
  return process.env.HACIENDA_ENV === "prod" ? HACIENDA_API.prod : HACIENDA_API.sandbox;
}

// ── 1. Parsear XML de factura recibida ────────────────────────────────────────
function parsearXML(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
  });
  const doc = parser.parse(xmlString);

  // El documento puede venir como FacturaElectronica, TiqueteElectronico, etc.
  const root =
    doc.FacturaElectronica ||
    doc.TiqueteElectronico ||
    doc.FacturaElectronicaExportacion ||
    doc.NotaCreditoElectronica ||
    doc.NotaDebitoElectronica ||
    Object.values(doc).find((v) => v && typeof v === "object" && v.Clave);

  if (!root) throw new Error("No se pudo identificar el comprobante en el XML");

  const resumen = root.ResumenFactura || {};
  const emisor  = root.Emisor || {};
  const detalle = root.DetalleServicio?.LineaDetalle;
  const lineas  = detalle
    ? (Array.isArray(detalle) ? detalle : [detalle]).map((l) => ({
        numero:      l.NumeroLinea,
        descripcion: l.Detalle,
        cantidad:    parseFloat(l.Cantidad) || 0,
        precioUnit:  parseFloat(l.PrecioUnitario) || 0,
        descuento:   parseFloat(l.MontoDescuento) || 0,
        montoIva:    parseFloat(l.Impuesto?.Monto) || 0,
        total:       parseFloat(l.MontoTotalLinea) || 0,
      }))
    : [];

  return {
    clave:           root.Clave || "",
    tipoDoc:         root.Clave ? root.Clave.substring(29, 31) : "01",
    numeroConsecutivo: root.NumeroConsecutivo || "",
    fechaEmision:    root.FechaEmision || "",
    emisorNombre:    emisor.Nombre || "",
    emisorCedula:    emisor.Identificacion?.Numero || "",
    emisorEmail:     emisor.CorreoElectronico || "",
    moneda:          resumen.CodigoTipoMoneda?.CodigoMoneda || "CRC",
    tipoCambio:      parseFloat(resumen.CodigoTipoMoneda?.TipoCambio) || 1,
    subtotal:        parseFloat(resumen.TotalVentasNetas) || 0,
    totalIVA:        parseFloat(resumen.TotalImpuesto) || 0,
    totalFactura:    parseFloat(resumen.TotalComprobante) || 0,
    condicionVenta:  root.CondicionVenta || "01",
    medioPago:       root.MedioPago || "01",
    lineas,
    xmlOriginal:     xmlString,
  };
}

// ── 2. Construir Mensaje Receptor v4.3 ────────────────────────────────────────
function buildMensajeReceptor({ datos, receptorCedula, consecutivoReceptor, mensaje = 1, detalleMensaje = "Comprobante recibido correctamente" }) {
  const ns = "https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.3/mensajeReceptor";
  return `<?xml version="1.0" encoding="UTF-8"?>
<MensajeReceptor xmlns="${ns}"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Clave>${datos.clave}</Clave>
  <NumeroCedulaEmisor>${datos.emisorCedula}</NumeroCedulaEmisor>
  <FechaEmisionDoc>${datos.fechaEmision}</FechaEmisionDoc>
  <Mensaje>${mensaje}</Mensaje>
  <DetalleMensaje>${detalleMensaje}</DetalleMensaje>
  <MontoTotalImpuesto>${datos.totalIVA.toFixed(2)}</MontoTotalImpuesto>
  <TotalFactura>${datos.totalFactura.toFixed(2)}</TotalFactura>
  <NumeroCedulaReceptor>${receptorCedula}</NumeroCedulaReceptor>
  <NumeroConsecutivoReceptor>${consecutivoReceptor}</NumeroConsecutivoReceptor>
</MensajeReceptor>`;
}

// ── 3. Firmar con el .p12 de la empresa ───────────────────────────────────────
async function firmarMensaje(xmlString, { p12Buffer, password }) {
  const p12Base64 = p12Buffer.toString("base64");
  const signedB64 = await Signer.sign(xmlString, p12Base64, password);
  return signedB64;
}

// ── 4. Enviar a Hacienda ──────────────────────────────────────────────────────
async function enviarHacienda(signedXmlB64, { clave, fechaEmision, emisorCedula, receptorCedula, token }) {
  const fetch = (await import("node-fetch")).default;
  const url = getApiUrl();

  const body = JSON.stringify({
    clave,
    fecha:    fechaEmision,
    emisor: { tipoIdentificacion: "01", numeroIdentificacion: emisorCedula },
    receptor: { tipoIdentificacion: "01", numeroIdentificacion: receptorCedula },
    comprobanteXml: signedXmlB64,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
  });

  const text = await res.text();
  return { status: res.status, body: text };
}

// ── Consecutivo receptor ──────────────────────────────────────────────────────
function getNextConsecutivoReceptor(empresaId, cedula) {
  // Formato: 00100001010000000001 (posición receptor)
  // Simplificado: usamos la tabla para llevar conteo
  const key = `consecutivo_receptor_${empresaId}`;
  const row = db.prepare("SELECT valor FROM contador WHERE clave = ?").get(key);
  const next = (row?.valor || 0) + 1;
  db.prepare("INSERT OR REPLACE INTO contador (clave, valor) VALUES (?, ?)").run(key, next);
  // Consecutivo CR: 20 dígitos — sucursal(3) + terminal(5) + tipo(2) + número(10)
  const num = String(next).padStart(10, "0");
  return `00100001010${num}`;
}

// ── API pública ───────────────────────────────────────────────────────────────

/**
 * Procesar un array de XMLs para una empresa.
 * Retorna array con datos parseados (sin enviar a Hacienda aún).
 */
function procesarXMLs(xmlArray, empresaId) {
  const resultados = [];
  for (const xml of xmlArray) {
    try {
      const datos = parsearXML(xml);
      // Guardar en DB como pendiente
      const id = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const now = new Date().toISOString();
      try {
        db.prepare(`
          INSERT OR IGNORE INTO facturas_recibidas
          (id, empresa_id, clave, emisor_nombre, emisor_cedula, fecha_emision,
           moneda, total_factura, total_iva, lineas_json, xml_original, estado, creado_en, actualizado_en)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?)
        `).run(
          id, empresaId, datos.clave, datos.emisorNombre, datos.emisorCedula,
          datos.fechaEmision, datos.moneda, datos.totalFactura, datos.totalIVA,
          JSON.stringify(datos.lineas), datos.xmlOriginal, now, now
        );
      } catch {}
      // Leer el id real (por si ya existía)
      const existing = db.prepare("SELECT id, estado FROM facturas_recibidas WHERE empresa_id=? AND clave=?").get(empresaId, datos.clave);
      resultados.push({ ...datos, id: existing?.id || id, estado: existing?.estado || "pendiente", ok: true });
    } catch (err) {
      resultados.push({ ok: false, error: err.message });
    }
  }
  return resultados;
}

/**
 * Aceptar/rechazar una factura recibida ante Hacienda.
 * mensaje: 1=Aceptado, 2=Aceptado parcial, 3=Rechazado
 */
async function aceptarFactura(facturaId, empresaId, { mensaje = 1, detalleMensaje, haciendaToken }) {
  const factura = db.prepare("SELECT * FROM facturas_recibidas WHERE id=? AND empresa_id=?").get(facturaId, empresaId);
  if (!factura) throw new Error("Factura no encontrada");

  const cert = certService.getCert(empresaId);
  if (!cert) throw new Error("No hay certificado .p12 configurado para esta empresa");

  const datos = {
    clave:        factura.clave,
    emisorCedula: factura.emisor_cedula,
    fechaEmision: factura.fecha_emision,
    totalIVA:     factura.total_iva,
    totalFactura: factura.total_factura,
  };

  const consecutivo = getNextConsecutivoReceptor(empresaId, cert.cedula);
  const mensajeXml  = buildMensajeReceptor({ datos, receptorCedula: cert.cedula, consecutivoReceptor: consecutivo, mensaje, detalleMensaje });
  const signedB64   = await firmarMensaje(mensajeXml, cert);

  const respuesta = await enviarHacienda(signedB64, {
    clave:          factura.clave,
    fechaEmision:   factura.fecha_emision,
    emisorCedula:   factura.emisor_cedula,
    receptorCedula: cert.cedula,
    token:          haciendaToken,
  });

  const nuevoEstado = respuesta.status === 202
    ? (mensaje === 1 ? "aceptada" : mensaje === 3 ? "rechazada" : "aceptada_parcial")
    : "error_hacienda";

  db.prepare(`
    UPDATE facturas_recibidas
    SET estado=?, consecutivo_receptor=?, respuesta_hacienda=?, actualizado_en=?
    WHERE id=?
  `).run(nuevoEstado, consecutivo, JSON.stringify(respuesta), new Date().toISOString(), facturaId);

  return { ok: respuesta.status === 202, estado: nuevoEstado, respuesta };
}

/**
 * Listar facturas recibidas de una empresa.
 */
function listarFacturas(empresaId, { estado, limit = 100 } = {}) {
  let query = "SELECT * FROM facturas_recibidas WHERE empresa_id=?";
  const params = [empresaId];
  if (estado) { query += " AND estado=?"; params.push(estado); }
  query += " ORDER BY fecha_emision DESC LIMIT ?";
  params.push(limit);
  return db.prepare(query).all(...params);
}

module.exports = { parsearXML, procesarXMLs, aceptarFactura, listarFacturas };
