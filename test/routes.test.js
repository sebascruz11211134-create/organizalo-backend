const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'monki-test-'));
process.env.DB_PATH=path.join(dir,'test.sqlite');process.env.JWT_SECRET='local-test-only-secret';process.env.WA_WEB_ENABLED='false';
process.env.WA_CLOUD_TOKEN='test';process.env.WA_PHONE_NUMBER_ID='123';process.env.WA_EMPRESA_ID='tenant-a';process.env.META_APP_SECRET='test-secret';process.env.META_VERIFY_TOKEN='verify';process.env.META_GRAPH_VERSION='v23.0';
const express=require('express'),jwt=require('jsonwebtoken');
const {db,getEmpresaDb}=require('../src/db');
const {router:channels,verifyMeta}=require('../src/routes/rockyChannels');
const gmail=require('../src/routes/rockyGmail');
const {read}=require('../src/services/erpData');
let server,base;
const token=(role='admin')=>jwt.sign({sub:role,empresaId:'tenant-a',rol:role},process.env.JWT_SECRET);
const request=(url,body,role='admin')=>fetch(base+url,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token(role)}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
before(async()=>{
 for(const role of ['admin','ventas'])db.prepare('INSERT INTO users(id,nombre,email,password_hash,empresa_id,rol,creado_en,actualizado_en) VALUES(?,?,?,?,?,?,?,?)').run(role,role,role+'@example.test','none','tenant-a',role,'now','now');
 const app=express();app.use(express.json({verify:(req,res,b)=>req.rawBody=b}));
 app.use('/channels',channels);app.use('/gmail',gmail.router);app.use('/sync',require('../src/routes/clouddata'));app.use('/rocky',require('../src/routes/rocky'));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
test('webhook authenticates raw body, persists and deduplicates message',async()=>{
 const body=JSON.stringify({entry:[{changes:[{value:{metadata:{phone_number_id:'123'},messages:[{id:'wamid.1',from:'50688888888',type:'text',text:{body:'Hola'},timestamp:String(Date.now()/1000)}]}}]}]});
 const sig='sha256='+crypto.createHmac('sha256','test-secret').update(body).digest('hex');
 const send=signature=>fetch(base+'/channels/whatsapp/webhook',{method:'POST',headers:{'Content-Type':'application/json','x-hub-signature-256':signature},body});
 assert.equal((await send('sha256='+'0'.repeat(64))).status,401);
 assert.equal((await send(sig)).status,200);assert.equal((await send(sig)).status,200);
 assert.equal(db.prepare('SELECT count(*) n FROM rocky_inbox').get().n,1);
 assert.equal(verifyMeta(Buffer.from(body+' '),sig,'test-secret'),false);
});
test('inbox and settings require active administrator',async()=>{
 assert.equal((await request('/channels/inbox',null,'ventas')).status,403);
 assert.equal((await request('/channels/inbox')).status,200);
 assert.equal((await request('/rocky/config',{activo:true,horarioInicio:'18:00',horarioFin:'08:00',modoRespuestas:'automatico'})).status,200);
 assert.equal((await request('/rocky/config')).status,200);
 assert.equal((await request('/rocky/config',{horarioInicio:'oops'})).status,400);
});
test('assistant reads canonical data only from the correct tenant',()=>{
 for(const [tenant,name] of [['tenant-a','A'],['tenant-b','B']])getEmpresaDb(tenant).prepare('INSERT OR REPLACE INTO cloud_data(clave,valor,actualizado_en) VALUES(?,?,?)').run('@finanzia/contactos',JSON.stringify([{nombre:name}]),'now');
 assert.equal(read('tenant-a','contactos')[0].nombre,'A');assert.equal(read('tenant-b','contactos')[0].nombre,'B');
});
test('sync route protects Rocky additions and does not return secrets',async()=>{
 let r=await request('/sync/push',{data:{'@finanzia/pedidos':[{id:'one'}]},baseVersions:{}});assert.equal(r.status,200);const data=await r.json();
 getEmpresaDb('tenant-a').prepare('INSERT OR REPLACE INTO cloud_data(clave,valor,actualizado_en) VALUES(?,?,?)').run('@finanzia/pedidos',JSON.stringify([{id:'one'},{id:'rocky'}]),'now');
 r=await request('/sync/push',{data:{'@finanzia/pedidos':[]},baseVersions:data.versions});assert.equal(r.status,409);
 r=await request('/sync/push',{data:{'@finanzia/refreshToken':'secret'}});assert.equal(r.status,400);
 assert.equal((await (await request('/sync/pull')).json()).data.rocky_config,undefined);
});
test('Gmail connection fails clearly without configuration and validates addresses',async()=>{
 assert.equal((await request('/gmail/connect',{})).status,503);
 assert.equal(gmail.emailAddress('Name <hello@example.com>'),'hello@example.com');assert.equal(gmail.emailAddress('bad\r\nBcc: x@y.com'),null);
});
test('unsigned phone requests are not processed',async()=>{
 assert.equal((await request('/rocky/llamada',{CallSid:'fake',From:'fake',To:'fake'})).status,503);
});

test('Gmail OAuth stores encrypted token, consumes state once and replays history safely',async()=>{
 process.env.GOOGLE_CLIENT_ID='local-client';process.env.GOOGLE_CLIENT_SECRET='local-secret';process.env.ROCKY_ENCRYPTION_KEY='a'.repeat(64);process.env.ROCKY_GMAIL_ADDRESS='monki@example.com';
 const connect=await (await request('/gmail/connect',{})).json();const state=new URL(connect.url).searchParams.get('state');
 const originalFetch=global.fetch;
 global.fetch=async(url,options)=>{
   const u=String(url);
   if(u==='https://oauth2.googleapis.com/token')return Response.json({access_token:'access',refresh_token:'refresh-secret-test',scope:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'});
   if(u.endsWith('/profile'))return Response.json({emailAddress:'monki@example.com',historyId:'100'});
   if(u.includes('/history?'))return Response.json({historyId:'101',history:[{messagesAdded:[{message:{id:'mail1'}}]}]});
   if(u.includes('/messages/mail1'))return Response.json({id:'mail1',threadId:'thread1',labelIds:['INBOX'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'customer@example.com'},{name:'Subject',value:'Consulta'}],body:{data:Buffer.from('Hola').toString('base64url')}}});
   return originalFetch(url,options);
 };
 try {
   assert.equal((await fetch(base+'/gmail/callback?state='+state+'&code=code')).status,200);
   const account=db.prepare('SELECT * FROM rocky_gmail').get();assert.ok(!account.secret.includes('refresh-secret-test'));
   assert.equal((await fetch(base+'/gmail/callback?state='+state+'&code=code')).status,400);
   await gmail.poll();await gmail.poll();
   assert.equal(db.prepare("SELECT count(*) n FROM rocky_inbox WHERE channel='gmail'").get().n,1);
   assert.equal(db.prepare('SELECT history_id FROM rocky_gmail').get().history_id,'101');
   const status=await (await request('/gmail/status')).json();assert.equal(status.account.secret,undefined);
 } finally {global.fetch=originalFetch;}
});
