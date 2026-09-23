// Persistent inbox. One worker per process, atomic claims across processes.
// An ambiguous send is NEVER retried automatically: a person must reconcile it.
function createInbox(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS rocky_inbox (
    id INTEGER PRIMARY KEY, empresa_id TEXT NOT NULL, channel TEXT NOT NULL,
    external_id TEXT NOT NULL, sender TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
    reply TEXT, provider_id TEXT, error TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, UNIQUE(empresa_id,channel,external_id));
    CREATE INDEX IF NOT EXISTS rocky_inbox_work ON rocky_inbox(status,next_at);
    CREATE TABLE IF NOT EXISTS rocky_pauses (
      empresa_id TEXT NOT NULL, channel TEXT NOT NULL, sender TEXT NOT NULL,
      until_at INTEGER NOT NULL, PRIMARY KEY(empresa_id,channel,sender));`);
  let busy = false;
  function enqueue({empresaId, channel, externalId, sender, payload}, now = Date.now()) {
    if (![empresaId,channel,externalId,sender].every(v => typeof v === 'string' && v.length > 0)) throw new Error('Mensaje sin identidad');
    return db.prepare(`INSERT OR IGNORE INTO rocky_inbox
      (empresa_id,channel,external_id,sender,payload,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run(empresaId,channel,externalId,sender,JSON.stringify(payload),now,now).changes;
  }
  function pause(empresaId,channel,sender,until) {
    db.prepare(`INSERT INTO rocky_pauses VALUES(?,?,?,?) ON CONFLICT(empresa_id,channel,sender) DO UPDATE SET until_at=excluded.until_at`).run(empresaId,channel,sender,until);
  }
  function paused(row,now) {
    return (db.prepare('SELECT until_at FROM rocky_pauses WHERE empresa_id=? AND channel=? AND sender=?').get(row.empresa_id,row.channel,row.sender)?.until_at || 0) > now;
  }
  async function tick(handlers, now = Date.now()) {
    if (busy) return;
    busy = true;
    try {
      db.prepare("UPDATE rocky_inbox SET status='review',error='Envío interrumpido: comprobar entrega antes de reenviar',updated_at=? WHERE status='sending' AND lease_until<?").run(now,now);
      db.prepare("UPDATE rocky_inbox SET status='pending',updated_at=? WHERE status='processing' AND lease_until<?").run(now,now);
      const candidates = db.prepare(`SELECT * FROM rocky_inbox WHERE status IN ('pending','ready') AND next_at<=? ORDER BY id LIMIT 100`).all(now);
      const eligible = candidates.filter(r => handlers[r.channel] && !paused(r,now) && !db.prepare("SELECT 1 FROM rocky_inbox WHERE empresa_id=? AND channel=? AND sender=? AND id<? AND status IN ('pending','ready','processing','sending','review','draft')").get(r.empresa_id,r.channel,r.sender,r.id));
      let row;
      for (const candidate of eligible) { if (await handlers[candidate.channel].available(candidate)) { row=candidate; break; } else {db.prepare('UPDATE rocky_inbox SET next_at=? WHERE id=? AND status IN (\'pending\',\'ready\')').run(now+30000,candidate.id);} }
      if (!row) return;
      const handler = handlers[row.channel];
      const claimed = db.prepare("UPDATE rocky_inbox SET status='processing',lease_until=?,updated_at=? WHERE id=? AND status=?").run(now+600000,now,row.id,row.status);
      if (!claimed.changes) return;
      let reply = row.reply;
      try {
        if (!reply) {
          const result = await handler.prepare({...row,payload:JSON.parse(row.payload)});
          if (!result?.text) {
            db.prepare("UPDATE rocky_inbox SET status='review',error=?,updated_at=? WHERE id=?").run(result?.reason || 'Requiere atención',Date.now(),row.id); return;
          }
          reply = result.text;
          db.prepare('UPDATE rocky_inbox SET reply=?,status=?,updated_at=? WHERE id=?').run(reply,result.draft?'draft':'processing',Date.now(),row.id);
          if (result.draft) return;
        }
      } catch {
        const attempts = row.attempts+1;
        db.prepare('UPDATE rocky_inbox SET status=?,attempts=?,next_at=?,error=?,updated_at=? WHERE id=?').run(attempts>=5?'review':'pending',attempts,now+Math.min(300000,2000*2**attempts),'No se pudo preparar respuesta',Date.now(),row.id); return;
      }
      if(handler.canSend && !await handler.canSend(row)) {db.prepare("UPDATE rocky_inbox SET status='draft',updated_at=? WHERE id=?").run(Date.now(),row.id);return;}
      // Re-check pause/config immediately before the irreversible send.
      if (paused(row,Date.now()) || !await handler.available(row)) {
        db.prepare("UPDATE rocky_inbox SET status='ready' WHERE id=?").run(row.id); return;
      }
      db.prepare("UPDATE rocky_inbox SET status='sending',lease_until=?,updated_at=? WHERE id=?").run(Date.now()+600000,Date.now(),row.id);
      try {
        const providerId = await handler.send({...row,payload:JSON.parse(row.payload)},reply);
        db.prepare("UPDATE rocky_inbox SET status='sent',provider_id=?,error=NULL,updated_at=? WHERE id=?").run(providerId || null,Date.now(),row.id);
      } catch {
        db.prepare("UPDATE rocky_inbox SET status='review',error='Entrega no confirmada: revisar el canal antes de reenviar',updated_at=? WHERE id=?").run(Date.now(),row.id);
      }
    } finally { busy=false; }
  }
  return { enqueue, pause, tick };
}
module.exports = { createInbox };
