const {test}=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {createInbox}=require('../src/services/rockyInbox');
const {dentroDelHorario,validateSchedule}=require('../src/services/rockySchedule');
const store=require('../src/services/cloudStore');
const {valid,xml}=require('../src/services/twilioSignature');
const crypto=require('node:crypto');
function database(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE cloud_data(clave TEXT PRIMARY KEY,valor TEXT,actualizado_en TEXT)');return db;}
const message=(externalId='m1',empresaId='tenant-a')=>({empresaId,channel:'test',externalId,sender:'customer',payload:{text:'Hola'}});
test('Costa Rica overnight schedule, boundaries and invalid values',()=>{
 const c={horarioInicio:'18:00',horarioFin:'08:00'};
 assert.equal(dentroDelHorario(c,new Date('2026-09-23T00:00:00Z')),true);
 assert.equal(dentroDelHorario(c,new Date('2026-09-23T13:59:00Z')),true);
 assert.equal(dentroDelHorario(c,new Date('2026-09-23T14:00:00Z')),false);
 assert.equal(dentroDelHorario({},new Date()),true);
 assert.throws(()=>validateSchedule({horarioInicio:'24:00',horarioFin:'08:00'}));
 assert.equal(dentroDelHorario({zonaHoraria:'Mars'}),false);
});
test('inbox deduplicates, persists and keeps tenants separate',async()=>{
 const db=database();let inbox=createInbox(db);assert.equal(inbox.enqueue(message()),1);assert.equal(inbox.enqueue(message()),0);assert.equal(inbox.enqueue(message('m1','tenant-b')),1);
 inbox=createInbox(db);let sends=0;const handlers={test:{available:()=>true,prepare:async()=>({text:'hola'}),send:async()=>{sends++;return 'sent';}}};
 await inbox.tick(handlers);await inbox.tick(handlers);assert.equal(sends,2);db.close();
});
test('uncertain delivery is never automatically sent again',async()=>{
 const db=database(),inbox=createInbox(db);inbox.enqueue(message());let sends=0;
 const h={test:{available:()=>true,prepare:async()=>({text:'hola'}),send:async()=>{sends++;throw new Error('timeout');}}};
 await inbox.tick(h);await inbox.tick(h,Date.now()+3600000);assert.equal(sends,1);assert.equal(db.prepare('SELECT status FROM rocky_inbox').get().status,'review');db.close();
});
test('pause, draft and per-conversation order block sends',async()=>{
 const db=database(),inbox=createInbox(db);inbox.enqueue(message());inbox.enqueue(message('m2'));let prepared=0;
 const h={test:{available:()=>true,prepare:async()=>{prepared++;return {text:'draft',draft:true}},send:async()=>assert.fail('must not send')}};
 inbox.pause('tenant-a','test','customer',Date.now()+60000);await inbox.tick(h);assert.equal(prepared,0);
 inbox.pause('tenant-a','test','customer',0);await inbox.tick(h);await inbox.tick(h);assert.equal(prepared,1);db.close();
});
test('worker survives generation failures and does not block another tenant',async()=>{
 const db=database(),inbox=createInbox(db);inbox.enqueue(message());inbox.enqueue(message('m2','tenant-b'));let sent=0;
 const h={test:{available:r=>r.empresa_id==='tenant-b',prepare:async()=>({text:'ok'}),send:async()=>{sent++;}}};await inbox.tick(h);assert.equal(sent,1);
 h.test.available=()=>true;h.test.prepare=async()=>{throw new Error('AI down')};await inbox.tick(h,Date.now()+31000);assert.equal(db.prepare('SELECT attempts FROM rocky_inbox WHERE id=1').get().attempts,1);db.close();
});
test('restart recovers preparation but flags interrupted send',async()=>{
 const db=database(),inbox=createInbox(db);inbox.enqueue(message());inbox.enqueue(message('m2','tenant-b'));
 db.prepare("UPDATE rocky_inbox SET status='processing',lease_until=1 WHERE id=1").run();db.prepare("UPDATE rocky_inbox SET status='sending',lease_until=1 WHERE id=2").run();
 await inbox.tick({test:{available:()=>true,prepare:async()=>({text:'ok'}),send:async()=> 'sent'}});
 assert.deepEqual(db.prepare('SELECT status FROM rocky_inbox ORDER BY id').all().map(x=>x.status),['sent','review']);db.close();
});
test('concurrent workers do not claim the same message',async()=>{
 const db=database(),a=createInbox(db),b=createInbox(db);a.enqueue(message());let sends=0;
 const h={test:{available:async()=>true,prepare:async()=>({text:'ok'}),send:async()=>{sends++;}}};await Promise.all([a.tick(h),b.tick(h)]);assert.equal(sends,1);db.close();
});
test('sync blocks stale overwrite and excludes credentials',()=>{
 const db=database();const k='@finanzia/pedidos';store.push(db,{[k]:[{id:'one'}]}, {},'user');const before=store.snapshot(db);
 store.push(db,{[k]:[{id:'one'},{id:'rocky'}]},before.versions,'rocky');
 assert.throws(()=>store.push(db,{[k]:[{id:'one',name:'edit'}]},before.versions,'user'),e=>e.status===409);
 assert.equal(store.snapshot(db).data[k].length,2);
 assert.throws(()=>store.push(db,{'@finanzia/authToken':'secret'}, {},'user'));
 db.prepare('INSERT INTO cloud_data VALUES(?,?,?)').run('wa_session_backup','secret','now');assert.equal(store.snapshot(db).data.wa_session_backup,undefined);db.close();
});
test('TwiML escapes input and signatures authenticate exact URL and form',()=>{
 assert.equal(xml('A&B <x>'),'A&amp;B &lt;x&gt;');const u='https://example.test/call',p={From:'+50612345678'};
 const sig=crypto.createHmac('sha1','secret').update(u+'From'+p.From).digest('base64');
 assert.equal(valid(u,p,sig,'secret'),true);assert.equal(valid(u,{From:'other'},sig,'secret'),false);
});

test('switching to draft during preparation prevents delivery',async()=>{
 const db=database(),inbox=createInbox(db);inbox.enqueue(message());
 await inbox.tick({test:{available:()=>true,canSend:()=>false,prepare:async()=>({text:'response'}),send:async()=>assert.fail('must not send')}});
 assert.equal(db.prepare('SELECT status FROM rocky_inbox').get().status,'draft');db.close();
});
