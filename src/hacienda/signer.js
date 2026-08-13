// Envuelve la librería haciendacostarica-signer (MIT, comunidad CR) que
// implementa la firma XAdES-EPES que Hacienda exige para cada comprobante.
// https://github.com/aazcast/haciendacostarica-signer
//
// La llave criptográfica (.p12) y su contraseña son datos sensibles del
// contribuyente — nunca deben salir de este backend ni guardarse en la app
// móvil. Por eso todo el firmado pasa por aquí y no por el teléfono.

const fs = require("fs");
const path = require("path");
const Signer = require("haciendacostarica-signer");

function loadKeyBase64(keyPath) {
  const resolved = path.resolve(keyPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `No se encontró la llave criptográfica en "${resolved}". Descárgala desde TRIBU-CR y configura CRYPTO_KEY_PATH en .env.`
    );
  }
  return fs.readFileSync(resolved).toString("base64");
}

async function signXml(xmlString, { keyPath, keyPassword }) {
  const keyBase64 = loadKeyBase64(keyPath);
  // Devuelve el XML ya firmado, en base64.
  const signedXmlBase64 = await Signer.sign(xmlString, keyBase64, keyPassword);
  return signedXmlBase64;
}

async function verifyKey({ keyPath, keyPassword }) {
  const keyBase64 = loadKeyBase64(keyPath);
  return Signer.verifySignature(keyBase64, keyPassword);
}

module.exports = { signXml, verifyKey };
