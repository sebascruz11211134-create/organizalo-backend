const { getEmpresaDb } = require('../db');
const aliases = {
  settings: ['@finanzia/settings', 'settings'],
  inventario: ['@finanzia/productos', 'inventario'],
  contactos: ['@finanzia/contactos', 'contactos'],
  facturas: ['@finanzia/facturas', 'facturas'],
  pedidos: ['@finanzia/pedidos', 'pedidos'],
  cotizaciones: ['@finanzia/cotizaciones', 'cotizaciones'],
  compras: ['@finanzia/compras', 'compras'],
  empleados: ['@finanzia/empleados', 'empleados'],
  cxc: ['@finanzia/debts', 'cxc'], cxp: ['@finanzia/debts', 'cxp'],
};
function read(empresaId, key, fallback = []) {
  const db = getEmpresaDb(empresaId);
  for (const name of aliases[key] || [key]) {
    const row = db.prepare('SELECT valor FROM cloud_data WHERE clave=?').get(name);
    if (!row) continue;
    const value = JSON.parse(row.valor);
    if ((key === 'cxc' || key === 'cxp') && name === '@finanzia/debts') {
      return value.filter(d => d.tipo === (key === 'cxc' ? 'cobrar' : 'pagar')).map(d => ({ ...d, clienteNombre:d.nombre, proveedorNombre:d.nombre }));
    }
    return value;
  }
  return fallback;
}
module.exports = { read, aliases };
