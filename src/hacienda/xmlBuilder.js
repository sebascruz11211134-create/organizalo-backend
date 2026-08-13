// Arma el XML del comprobante "Factura Electrónica" (tipo 01) siguiendo la
// estructura general de la versión 4.4 del Ministerio de Hacienda.
//
// ⚠️ ESTO ES UNA IMPLEMENTACIÓN DE REFERENCIA, NO UNA VALIDADA CONTRA EL XSD
// OFICIAL. Antes de mandar un solo comprobante real a producción:
//   1. Descarga el XSD oficial: https://www.hacienda.go.cr/docs/FacturaElectronica_V4.4.xsd.xml
//   2. Valida el XML que genera esta función contra ese XSD (ej. con
//      `xmllint --noout --schema FacturaElectronica_V4.4.xsd.xml archivo.xml`).
//   3. Ajusta los campos que falten o sobren — Hacienda cambia catálogos
//      (actividades económicas, CABYS, unidades de medida) con cierta
//      frecuencia y este archivo no se actualiza solo.
//   4. Idealmente, que un contador o un integrador certificado revise el
//      resultado antes de ir a producción.

function escapeXml(str) {
  return String(str ?? "").replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  }[c]));
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function buildLineaDetalle(item, index) {
  const cantidad = Number(item.cantidad) || 0;
  const precioUnitario = round2(item.precioUnitario);
  const montoTotal = round2(cantidad * precioUnitario);
  const tarifaIva = item.tarifaIva ?? 13;
  const montoImpuesto = round2(montoTotal * (tarifaIva / 100));
  const montoTotalLinea = round2(montoTotal + montoImpuesto);

  return `
    <LineaDetalle>
      <NumeroLinea>${index + 1}</NumeroLinea>
      <CodigoCABYS>${escapeXml(item.codigoCabys || "8399000000000")}</CodigoCABYS>
      <Cantidad>${cantidad}</Cantidad>
      <UnidadMedida>${escapeXml(item.unidadMedida || "Unid")}</UnidadMedida>
      <Detalle>${escapeXml(item.descripcion)}</Detalle>
      <PrecioUnitario>${precioUnitario.toFixed(2)}</PrecioUnitario>
      <MontoTotal>${montoTotal.toFixed(2)}</MontoTotal>
      <SubTotal>${montoTotal.toFixed(2)}</SubTotal>
      <BaseImponible>${montoTotal.toFixed(2)}</BaseImponible>
      <Impuesto>
        <Codigo>01</Codigo>
        <CodigoTarifaIVA>${tarifaIva === 13 ? "08" : "10"}</CodigoTarifaIVA>
        <Tarifa>${tarifaIva.toFixed(2)}</Tarifa>
        <Monto>${montoImpuesto.toFixed(2)}</Monto>
      </Impuesto>
      <ImpuestoNeto>${montoImpuesto.toFixed(2)}</ImpuestoNeto>
      <MontoTotalLinea>${montoTotalLinea.toFixed(2)}</MontoTotalLinea>
    </LineaDetalle>`;
}

function buildUbicacion(u = {}) {
  return `
      <Ubicacion>
        <Provincia>${escapeXml(u.provincia || "1")}</Provincia>
        <Canton>${escapeXml(u.canton || "01")}</Canton>
        <Distrito>${escapeXml(u.distrito || "01")}</Distrito>
        <OtrasSenas>${escapeXml(u.otrasSenas || "N/A")}</OtrasSenas>
      </Ubicacion>`;
}

/**
 * @param {object} p
 * @param {string} p.clave
 * @param {string} p.numeroConsecutivo
 * @param {object} p.emisor - { cedulaTipo, cedulaNumero, nombre, nombreComercial, codigoActividad, ubicacion, telefono, correo }
 * @param {object} p.receptor - { cedulaTipo, cedulaNumero, nombre, ubicacion, telefono, correo }
 * @param {Array} p.items - [{ descripcion, cantidad, precioUnitario, tarifaIva, codigoCabys, unidadMedida }]
 * @param {"CRC"|"USD"} [p.moneda]
 * @param {number} [p.tipoCambio] - requerido si moneda es USD (colones por dólar)
 * @param {"01"|"02"} [p.condicionVenta] - 01 contado, 02 crédito
 */
function buildFacturaElectronicaXML({
  clave,
  numeroConsecutivo,
  emisor,
  receptor,
  items,
  moneda = "CRC",
  tipoCambio = 1,
  condicionVenta = "01",
}) {
  const fechaEmision = new Date().toISOString().slice(0, 19) + "-06:00";
  const lineas = items.map(buildLineaDetalle).join("");

  let totalGravado = 0;
  let totalImpuesto = 0;
  let totalVenta = 0;
  for (const item of items) {
    const cantidad = Number(item.cantidad) || 0;
    const precioUnitario = round2(item.precioUnitario);
    const montoTotal = round2(cantidad * precioUnitario);
    const tarifaIva = item.tarifaIva ?? 13;
    const montoImpuesto = round2(montoTotal * (tarifaIva / 100));
    totalGravado += montoTotal;
    totalImpuesto += montoImpuesto;
    totalVenta += montoTotal;
  }
  const totalComprobante = round2(totalVenta + totalImpuesto);

  return `<?xml version="1.0" encoding="UTF-8"?>
<FacturaElectronica xmlns="https://cdn.comprobanteselectronicos.go.cr/xml-schemas/v4.4/facturaElectronica">
  <Clave>${clave}</Clave>
  <CodigoActividadEmisor>${escapeXml(emisor.codigoActividad)}</CodigoActividadEmisor>
  <NumeroConsecutivo>${numeroConsecutivo}</NumeroConsecutivo>
  <FechaEmision>${fechaEmision}</FechaEmision>
  <Emisor>
    <Nombre>${escapeXml(emisor.nombre)}</Nombre>
    <Identificacion>
      <Tipo>${escapeXml(emisor.cedulaTipo || "02")}</Tipo>
      <Numero>${escapeXml((emisor.cedulaNumero || "").replace(/\D/g, ""))}</Numero>
    </Identificacion>
    <NombreComercial>${escapeXml(emisor.nombreComercial || emisor.nombre)}</NombreComercial>${buildUbicacion(emisor.ubicacion)}
    <Telefono>
      <CodigoPais>506</CodigoPais>
      <NumTelefono>${escapeXml((emisor.telefono || "").replace(/\D/g, ""))}</NumTelefono>
    </Telefono>
    <CorreoElectronico>${escapeXml(emisor.correo)}</CorreoElectronico>
  </Emisor>
  <Receptor>
    <Nombre>${escapeXml(receptor.nombre)}</Nombre>
    ${receptor.cedulaNumero ? `<Identificacion>
      <Tipo>${escapeXml(receptor.cedulaTipo || "01")}</Tipo>
      <Numero>${escapeXml(receptor.cedulaNumero.replace(/\D/g, ""))}</Numero>
    </Identificacion>` : ""}
    <CorreoElectronico>${escapeXml(receptor.correo || "")}</CorreoElectronico>
  </Receptor>
  <CondicionVenta>${condicionVenta}</CondicionVenta>
  <MedioPago>
    <TipoMedioPago>01</TipoMedioPago>
  </MedioPago>
  <DetalleServicio>${lineas}
  </DetalleServicio>
  <ResumenFactura>
    <CodigoTipoMoneda>
      <CodigoMoneda>${moneda}</CodigoMoneda>
      <TipoCambio>${moneda === "USD" ? tipoCambio.toFixed(5) : "1.00000"}</TipoCambio>
    </CodigoTipoMoneda>
    <TotalServGravados>0.00</TotalServGravados>
    <TotalServExentos>0.00</TotalServExentos>
    <TotalMercanciasGravadas>${totalGravado.toFixed(2)}</TotalMercanciasGravadas>
    <TotalMercanciasExentas>0.00</TotalMercanciasExentas>
    <TotalGravado>${totalGravado.toFixed(2)}</TotalGravado>
    <TotalExento>0.00</TotalExento>
    <TotalVenta>${totalVenta.toFixed(2)}</TotalVenta>
    <TotalDescuentos>0.00</TotalDescuentos>
    <TotalVentaNeta>${totalVenta.toFixed(2)}</TotalVentaNeta>
    <TotalImpuesto>${totalImpuesto.toFixed(2)}</TotalImpuesto>
    <TotalComprobante>${totalComprobante.toFixed(2)}</TotalComprobante>
  </ResumenFactura>
</FacturaElectronica>`;
}

module.exports = { buildFacturaElectronicaXML };
