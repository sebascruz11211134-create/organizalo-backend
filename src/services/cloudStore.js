const { createHash } = require('node:crypto');
const forbidden = new Set(['authToken','refreshToken','authUser','empresaId','lastSync','usuarioActivo','modulosHabilitados']);
function syncable(key) { return key.startsWith('@finanzia/') && !key.startsWith('@finanzia/syncBaseline:') && !forbidden.has(key.slice(10)); }
function version(value) { return value == null ? null : createHash('sha256').update(value).digest('hex'); }
function snapshot(db) {
  const data={}, versions={};
  for (const row of db.prepare('SELECT clave,valor FROM cloud_data').all()) {
    if (!syncable(row.clave)) continue;
    data[row.clave]=JSON.parse(row.valor); versions[row.clave]=version(row.valor);
  }
  return {data,versions};
}
function push(db,data,baseVersions,autor) {
  const keys=Object.keys(data);
  if (keys.some(k=>!syncable(k))) throw Object.assign(new Error('Solo se sincronizan datos del negocio, no credenciales ni configuración interna.'),{status:400});
  db.exec('BEGIN IMMEDIATE');
  try {
    const conflicts=[];
    for (const key of keys) {
      const row=db.prepare('SELECT valor FROM cloud_data WHERE clave=?').get(key);
      if (version(row?.valor)!==(baseVersions?.[key] ?? null) && row?.valor!==JSON.stringify(data[key])) conflicts.push(key);
    }
    if (conflicts.length) throw Object.assign(new Error('Los datos cambiaron en el servidor. Conservamos tu copia local para resolver el conflicto.'),{status:409,conflicts});
    for (const key of keys) {
      const value=data[key];
      db.prepare(`INSERT INTO cloud_data(clave,valor,actualizado_en) VALUES(?,?,?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor,actualizado_en=excluded.actualizado_en`).run(key,JSON.stringify(value),new Date().toISOString());
    }
    db.exec(`CREATE TABLE IF NOT EXISTS sync_audit (id INTEGER PRIMARY KEY, actor TEXT, keys_json TEXT, created_at TEXT)`);
    db.prepare('INSERT INTO sync_audit(actor,keys_json,created_at) VALUES(?,?,?)').run(autor,JSON.stringify(keys),new Date().toISOString());
    const result=snapshot(db); db.exec('COMMIT'); return result;
  } catch(e) { db.exec('ROLLBACK'); throw e; }
}
module.exports={syncable,version,snapshot,push};
