/**
 * db.js — Re-exporta desde dbManager para compatibilidad con rutas existentes.
 *
 * db      = base compartida (users, access_codes, invites, admin)
 * getEmpresaDb(empresaId) = DB privada por empresa (facturas, clouddata, chat, etc.)
 */

const { sharedDb, getEmpresaDb, nextNumeroDocumento } = require("./dbManager");

module.exports = { db: sharedDb, getEmpresaDb, nextNumeroDocumento };
