// Genera la "Clave" (50 dígitos) y el "NumeroConsecutivo" (20 dígitos) que
// exige Hacienda para cada comprobante electrónico.
//
// Estructura de la Clave (50 dígitos, sin separadores):
//   3   código de país (506)
//   2   día (01-31)
//   2   mes (01-12)
//   2   año (2 dígitos)
//   12  cédula del emisor (rellenada con ceros a la izquierda)
//   20  número consecutivo (ver abajo)
//   1   situación del comprobante (1 = normal, 2 = contingencia, 3 = sin internet)
//   8   código de seguridad (aleatorio)
//
// Estructura del NumeroConsecutivo (20 dígitos):
//   3   sucursal (000 = casa matriz si no manejas varias)
//   5   terminal (00001 por defecto)
//   2   tipo de documento (01 = Factura Electrónica, 02 = Nota de Débito,
//       03 = Nota de Crédito, 04 = Tiquete Electrónico, 09 = Factura de
//       Exportación, 10 = Recibo Electrónico de Pago...)
//   10  número consecutivo del documento (secuencial, sin saltarse ni
//       repetir — Hacienda lo audita)
//
// IMPORTANTE: esto es una implementación de referencia. Antes de usarla en
// producción, verifica cada campo contra el Anexo 4.4 oficial de Hacienda
// (ver README) y sobre todo verifica cómo llevas el consecutivo — nunca debe
// reiniciarse ni repetirse un número ya usado.

function pad(value, length) {
  return String(value).padStart(length, "0");
}

function codigoSeguridadAleatorio() {
  return pad(Math.floor(Math.random() * 1e8), 8);
}

/**
 * @param {number} numeroDocumento - contador secuencial que tú llevas (1, 2, 3...)
 * @param {object} opciones
 */
function buildNumeroConsecutivo(numeroDocumento, { sucursal = "001", terminal = "00001", tipoDocumento = "01" } = {}) {
  return `${pad(sucursal, 3)}${pad(terminal, 5)}${tipoDocumento}${pad(numeroDocumento, 10)}`;
}

/**
 * @param {object} opciones
 * @param {string} opciones.cedulaEmisor - cédula jurídica/física sin guiones
 * @param {string} opciones.numeroConsecutivo - los 20 dígitos ya armados
 * @param {Date} [opciones.fecha]
 * @param {"1"|"2"|"3"} [opciones.situacion]
 */
function buildClave({ cedulaEmisor, numeroConsecutivo, fecha = new Date(), situacion = "1" }) {
  const pais = "506";
  const dia = pad(fecha.getDate(), 2);
  const mes = pad(fecha.getMonth() + 1, 2);
  const anio = pad(fecha.getFullYear() % 100, 2);
  const cedula = pad(cedulaEmisor.replace(/\D/g, ""), 12);
  const codigoSeguridad = codigoSeguridadAleatorio();

  const clave = `${pais}${dia}${mes}${anio}${cedula}${numeroConsecutivo}${situacion}${codigoSeguridad}`;

  if (clave.length !== 50) {
    throw new Error(`La clave generada tiene ${clave.length} dígitos, debería tener 50. Revisa los campos de entrada.`);
  }
  return clave;
}

module.exports = { buildClave, buildNumeroConsecutivo };
