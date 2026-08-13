// Cliente HTTP para el API de Hacienda: pide el token OAuth y envía/consulta
// comprobantes. URLs confirmadas por investigación (agosto 2026) — Hacienda
// puede cambiarlas; si algo deja de funcionar, lo primero es revisar avisos
// en https://www.hacienda.go.cr/AvisosTRIBU-CR.html.

const fetch = require("node-fetch");

const URLS = {
  sandbox: {
    idp: "https://idp.comprobanteselectronicos.go.cr/auth/realms/rut-stag/protocol/openid-connect/token",
    clientId: "api-stag",
    api: "https://api.comprobanteselectronicos.go.cr/recepcion-sandbox/v1",
  },
  production: {
    idp: "https://idp.comprobanteselectronicos.go.cr/auth/realms/rut/protocol/openid-connect/token",
    clientId: "api-prod",
    api: "https://api.comprobanteselectronicos.go.cr/recepcion/v1",
  },
};

async function getAccessToken({ env, username, password }) {
  const cfg = URLS[env];
  if (!cfg) throw new Error(`HACIENDA_ENV inválido: "${env}". Usa "sandbox" o "production".`);

  const body = new URLSearchParams({
    grant_type: "password",
    client_id: cfg.clientId,
    username,
    password,
  });

  const res = await fetch(cfg.idp, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`No se pudo obtener el token de Hacienda (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function enviarComprobante({ env, token, clave, xmlFirmadoBase64, emisorCedula, receptorCedula, fecha }) {
  const cfg = URLS[env];
  const body = {
    clave,
    fecha,
    emisor: { tipoIdentificacion: "02", numeroIdentificacion: emisorCedula },
    ...(receptorCedula ? { receptor: { tipoIdentificacion: "01", numeroIdentificacion: receptorCedula } } : {}),
    comprobanteXml: xmlFirmadoBase64,
  };

  const res = await fetch(`${cfg.api}/recepcion`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  // Hacienda responde 202 (aceptado para procesar) sin cuerpo si todo salió
  // bien a nivel de transporte — el resultado real (aceptado/rechazado) se
  // consulta aparte con consultarEstado().
  if (res.status !== 202 && !res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Hacienda rechazó el envío (${res.status}): ${text.slice(0, 500)}`);
  }

  return { status: res.status, location: res.headers.get("location") };
}

async function consultarEstado({ env, token, clave }) {
  const cfg = URLS[env];
  const res = await fetch(`${cfg.api}/recepcion/${clave}`, {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`No se pudo consultar el estado (${res.status}): ${text.slice(0, 300)}`);
  }

  return res.json();
}

module.exports = { getAccessToken, enviarComprobante, consultarEstado, URLS };
