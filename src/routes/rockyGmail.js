const express=require('express');
const crypto=require('node:crypto');
const {db}=require('../db');
const config=require('../config');
const admin=require('../middleware/rockyAdmin');
const runtime=require('../services/rockyRuntime');
const reply=require('../services/rockyReply');
const router=express.Router();
db.exec(`CREATE TABLE IF NOT EXISTS rocky_gmail (empresa_id TEXT PRIMARY KEY,email TEXT NOT NULL,secret TEXT NOT NULL,history_id TEXT,connected_at INTEGER,last_poll INTEGER,error TEXT);
CREATE TABLE IF NOT EXISTS rocky_oauth_states (state TEXT PRIMARY KEY,empresa_id TEXT NOT NULL,user_id TEXT NOT NULL,expires INTEGER NOT NULL);`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS rocky_gmail_account ON rocky_gmail(email)');
const callback=()=>`${config.publicUrl}/api/rocky/channels/gmail/callback`;
function configured() {return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && /^[a-f0-9]{64}$/i.test(process.env.ROCKY_ENCRYPTION_KEY||'') && process.env.ROCKY_GMAIL_ADDRESS);}
function encrypt(value) {
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',Buffer.from(process.env.ROCKY_ENCRYPTION_KEY,'hex'),iv);
  const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
}
function decrypt(value) {
  const data=Buffer.from(value,'base64'),c=crypto.createDecipheriv('aes-256-gcm',Buffer.from(process.env.ROCKY_ENCRYPTION_KEY,'hex'),data.subarray(0,12));
  c.setAuthTag(data.subarray(12,28));return Buffer.concat([c.update(data.subarray(28)),c.final()]).toString('utf8');
}
async function tokenRequest(params) {
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',signal:AbortSignal.timeout(15000),body:new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,...params})});
  const data=await r.json();if(!r.ok||!data.access_token) throw new Error('Reconectá Gmail: Google no autorizó el acceso');return data;
}
async function access(row) {return (await tokenRequest({grant_type:'refresh_token',refresh_token:decrypt(row.secret)})).access_token;}
async function gmail(token,path,options={}) {
  const r=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`,{...options,signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}});
  const data=await r.json();if(!r.ok) throw Object.assign(new Error('Gmail no respondió correctamente'),{status:r.status});return data;
}
router.get('/status',admin,(req,res)=>{
  const row=db.prepare('SELECT email,connected_at,last_poll,error FROM rocky_gmail WHERE empresa_id=?').get(req.jwtPayload.empresaId);
  res.json({configured:configured(),account:row||null});
});
router.post('/connect',admin,(req,res)=>{
  if(!configured()) return res.status(503).json({error:'Falta configurar Google OAuth, dirección de Gmail y clave de cifrado en el servidor.'});
  db.prepare('DELETE FROM rocky_oauth_states WHERE expires<?').run(Date.now());
  const state=crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO rocky_oauth_states VALUES(?,?,?,?)').run(state,req.jwtPayload.empresaId,req.jwtPayload.sub,Date.now()+600000);
  const query=new URLSearchParams({client_id:process.env.GOOGLE_CLIENT_ID,redirect_uri:callback(),response_type:'code',access_type:'offline',prompt:'consent',state,login_hint:process.env.ROCKY_GMAIL_ADDRESS,scope:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'});
  res.json({url:`https://accounts.google.com/o/oauth2/v2/auth?${query}`});
});
router.get('/callback',async(req,res)=>{
  const state=db.prepare('DELETE FROM rocky_oauth_states WHERE state=? AND expires>? RETURNING *').get(String(req.query.state||''),Date.now());
  if(!state || !req.query.code) return res.status(400).send('Conexión cancelada o vencida. Volvé a conectar desde el ERP.');
  const user=db.prepare('SELECT * FROM users WHERE id=? AND activo=1').get(state.user_id);
  if(!user||user.empresa_id!==state.empresa_id||!['admin','superadmin','gerencia'].includes(user.rol)) return res.sendStatus(403);
  try {
    const tokens=await tokenRequest({code:String(req.query.code),redirect_uri:callback(),grant_type:'authorization_code'});
    const profile=await gmail(tokens.access_token,'profile');
    const granted=new Set((tokens.scope||'').split(' '));
    if(!granted.has('https://www.googleapis.com/auth/gmail.readonly')||!granted.has('https://www.googleapis.com/auth/gmail.send')) throw new Error('Faltan permisos de lectura o envío.');
    if(profile.emailAddress.toLowerCase()!==process.env.ROCKY_GMAIL_ADDRESS.toLowerCase()) throw new Error('Seleccioná la cuenta de correo de MONKI configurada.');
    if(!tokens.refresh_token) throw new Error('Google no entregó acceso persistente. Volvé a autorizar la conexión.');
    db.prepare(`INSERT INTO rocky_gmail VALUES(?,?,?,?,?,NULL,NULL) ON CONFLICT(empresa_id) DO UPDATE SET email=excluded.email,secret=excluded.secret,history_id=excluded.history_id,connected_at=excluded.connected_at,error=NULL`).run(state.empresa_id,profile.emailAddress,encrypt(tokens.refresh_token),profile.historyId,Date.now());
    res.type('text').send('Gmail conectado. Rocky revisará los mensajes nuevos de la bandeja de entrada. Volvé al ERP para configurar la atención automática.');
  } catch(e) {res.status(400).type('text').send(e.message);}
});
router.post('/disconnect',admin,(req,res)=>{
  db.prepare('DELETE FROM rocky_gmail WHERE empresa_id=?').run(req.jwtPayload.empresaId);
  db.prepare("UPDATE rocky_inbox SET status='review',error='Cuenta desconectada: revisar antes de responder' WHERE empresa_id=? AND channel='gmail' AND status IN ('pending','ready','draft')").run(req.jwtPayload.empresaId);
  res.json({ok:true});
});
const safeHeader=s=>String(s||'').replace(/[\r\n]/g,' ').slice(0,900);
function emailAddress(from) {
  if(/[\r\n]/.test(String(from||"")))return null;
  const match=String(from||'').match(/(?:<|^)([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})(?:>|$)/i);
  return match?.[1] || null;
}
function plain(part) {
  if(part.mimeType==='text/plain' && part.body?.data) return Buffer.from(part.body.data,'base64url').toString('utf8');
  return (part.parts||[]).map(plain).filter(Boolean).join('\n');
}
function attachment(part) {return !!part.filename || (part.parts||[]).some(attachment);}
let polling=false;
async function poll() {
  if(polling||!configured())return; polling=true;
  try {
    for(const account of db.prepare('SELECT * FROM rocky_gmail WHERE error IS NULL').all()) {
      try {
        const token=await access(account);let pageToken,latest=account.history_id;
        do {
          const params=new URLSearchParams({startHistoryId:account.history_id,historyTypes:'messageAdded',maxResults:'100'});if(pageToken)params.set('pageToken',pageToken);
          const history=await gmail(token,`history?${params}`);
          for(const h of history.history||[]) for(const added of h.messagesAdded||[]) {
            const m=await gmail(token,`messages/${encodeURIComponent(added.message.id)}?format=full`);
            if(!m.labelIds?.includes('INBOX')||m.labelIds.includes('SENT'))continue;
            const headers=Object.fromEntries((m.payload.headers||[]).map(h=>[h.name.toLowerCase(),h.value]));
            const sender=emailAddress(headers['reply-to']||headers.from);
            if(!sender||sender.toLowerCase()===account.email.toLowerCase())continue;
            // Never auto-reply to robots, lists, bounces, or failed authentication.
            const automated=(headers['auto-submitted'] && headers['auto-submitted']!=='no') || headers['list-id'] || /bulk|list|junk/i.test(headers.precedence||'') || /mailer-daemon|no-?reply/i.test(sender);
            const text=plain(m.payload);
            runtime.inbox.enqueue({empresaId:account.empresa_id,channel:'gmail',externalId:m.id,sender,payload:{text,unsupported:!!automated||attachment(m.payload)||!text,subject:headers.subject,threadId:m.threadId,messageId:headers['message-id']}});
          }
          latest=history.historyId||latest;pageToken=history.nextPageToken;
        } while(pageToken);
        db.prepare('UPDATE rocky_gmail SET history_id=?,last_poll=?,error=NULL WHERE empresa_id=?').run(latest,Date.now(),account.empresa_id);
      } catch(e) {
        // Keep cursor on transient failure, replay is deduplicated in inbox.
        if(e.status===404 || e.message.startsWith('Reconectá')) db.prepare('UPDATE rocky_gmail SET error=? WHERE empresa_id=?').run(e.status===404?'Historial vencido: reconectar y revisar manualmente el período sin cobertura.':e.message,account.empresa_id);
        else db.prepare('UPDATE rocky_gmail SET last_poll=COALESCE(last_poll,0) WHERE empresa_id=?').run(account.empresa_id);
      }
    }
  } finally {polling=false;}
}
runtime.register('gmail',{
  available:r=>configured() && !!db.prepare('SELECT 1 FROM rocky_gmail WHERE empresa_id=? AND error IS NULL').get(r.empresa_id) && reply.active(r),
  canSend:r=>reply.settings(r.empresa_id).modoRespuestas==='automatico',
  prepare:reply.prepare,
  send:async(r,text)=>{
    const account=db.prepare('SELECT * FROM rocky_gmail WHERE empresa_id=?').get(r.empresa_id);const token=await access(account);
    // If a person already replied in this thread, do not compete with them.
    const thread=await gmail(token,`threads/${encodeURIComponent(r.payload.threadId)}?format=metadata`);
    const incoming=thread.messages?.find(m=>m.id===r.external_id);
    if(!incoming || thread.messages.some(m=>m.labelIds?.includes('SENT') && Number(m.internalDate)>=Number(incoming.internalDate))) throw new Error('Una persona ya respondió este hilo');
    const raw=[`From: ${safeHeader(account.email)}`,`To: ${safeHeader(r.sender)}`,
      `Subject: =?UTF-8?B?${Buffer.from('Re: '+safeHeader(r.payload.subject||'Consulta')).toString('base64')}?=`,
      `In-Reply-To: ${safeHeader(r.payload.messageId)}`,`References: ${safeHeader(r.payload.messageId)}`,
      'Auto-Submitted: auto-replied','MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',Buffer.from(text).toString('base64')].join('\r\n');
    const result=await gmail(token,'messages/send',{method:'POST',body:JSON.stringify({raw:Buffer.from(raw).toString('base64url'),threadId:r.payload.threadId})});
    if(!result.id)throw new Error('Entrega no confirmada');return result.id;
  }
});
function start() { const t=setInterval(()=>poll().catch(()=>{}),60000);t.unref();poll().catch(()=>{}); }
module.exports={router,start,emailAddress,poll};
