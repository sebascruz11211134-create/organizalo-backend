const express=require('express');
const crypto=require('node:crypto');
const {db}=require('../db');
const admin=require('../middleware/rockyAdmin');
const runtime=require('../services/rockyRuntime');
const reply=require('../services/rockyReply');
const router=express.Router();
function cloudConfigured() {return ['WA_CLOUD_TOKEN','WA_PHONE_NUMBER_ID','WA_EMPRESA_ID','META_APP_SECRET','META_VERIFY_TOKEN','META_GRAPH_VERSION'].every(k=>process.env[k]);}
function verifyMeta(raw,signature,secret) {
  if(!secret || !Buffer.isBuffer(raw) || !/^sha256=[a-f0-9]{64}$/.test(signature||'')) return false;
  const expected=crypto.createHmac('sha256',secret).update(raw).digest();
  return crypto.timingSafeEqual(expected,Buffer.from(signature.slice(7),'hex'));
}
router.get('/whatsapp/webhook',(req,res)=>{
  if(!cloudConfigured()) return res.sendStatus(503);
  if(req.query['hub.mode']==='subscribe' && req.query['hub.verify_token']===process.env.META_VERIFY_TOKEN) return res.status(200).send(String(req.query['hub.challenge']||''));
  res.sendStatus(403);
});
router.post('/whatsapp/webhook',(req,res)=>{
  if(!cloudConfigured()) return res.sendStatus(503);
  if(!verifyMeta(req.rawBody,req.headers['x-hub-signature-256'],process.env.META_APP_SECRET)) return res.sendStatus(401);
  try {
    for(const entry of req.body.entry||[]) for(const change of entry.changes||[]) {
      const value=change.value;
      if(value?.metadata?.phone_number_id!==process.env.WA_PHONE_NUMBER_ID) continue;
      for(const m of value.messages||[]) {
        runtime.inbox.enqueue({empresaId:process.env.WA_EMPRESA_ID,channel:'whatsapp-cloud',externalId:m.id,sender:m.from,
          payload:{text:m.text?.body||'',unsupported:m.type!=='text',timestamp:m.timestamp}});
      }
      for(const st of value.statuses||[]) {
        if(st.status==='failed') db.prepare("UPDATE rocky_inbox SET status='review',error='Meta informó fallo de entrega',updated_at=? WHERE empresa_id=? AND provider_id=?").run(Date.now(),process.env.WA_EMPRESA_ID,st.id);
      }
    }
    res.sendStatus(200); // only acknowledge after durable writes
  } catch { res.sendStatus(500); }
});
runtime.register('whatsapp-cloud',{
  available:r=>cloudConfigured() && r.empresa_id===process.env.WA_EMPRESA_ID && reply.active(r),
  canSend:r=>reply.settings(r.empresa_id).modoRespuestas==='automatico',
  prepare:async r=>{
    if(Date.now()-Number(r.payload.timestamp)*1000>23*3600000) return {reason:'Mensaje fuera de la ventana de respuesta; revisar manualmente'};
    return reply.prepare(r);
  },
  send:async(r,text)=>{
    if(!/^v\d+\.\d+$/.test(process.env.META_GRAPH_VERSION||'')) throw new Error('Versión de Meta inválida');
    if(Date.now()-Number(r.payload.timestamp)*1000>23*3600000) throw new Error('Ventana vencida');
    const response=await fetch(`https://graph.facebook.com/${process.env.META_GRAPH_VERSION}/${process.env.WA_PHONE_NUMBER_ID}/messages`,{
      method:'POST',signal:AbortSignal.timeout(20000),headers:{Authorization:`Bearer ${process.env.WA_CLOUD_TOKEN}`,'Content-Type':'application/json'},
      body:JSON.stringify({messaging_product:'whatsapp',to:r.sender,type:'text',text:{body:text}})});
    const data=await response.json();if(!response.ok || !data.messages?.[0]?.id) throw new Error('Envío no confirmado');
    return data.messages[0].id;
  }
});
router.get('/inbox',admin,(req,res)=>{
  const rows=db.prepare('SELECT id,channel,sender,status,reply,error,created_at,updated_at FROM rocky_inbox WHERE empresa_id=? ORDER BY id DESC LIMIT 100').all(req.jwtPayload.empresaId);
  res.json({messages:rows,cloudConfigured:cloudConfigured() && process.env.WA_EMPRESA_ID===req.jwtPayload.empresaId});
});
router.post('/pause',admin,(req,res)=>{
  const {channel,sender,minutes=60}=req.body||{};
  if(!['gmail','whatsapp-cloud','whatsapp-web'].includes(channel)||typeof sender!=='string'||!sender||!Number.isFinite(minutes)||minutes<0||minutes>10080) return res.status(400).json({error:'Pausa inválida'});
  runtime.inbox.pause(req.jwtPayload.empresaId,channel,sender,Date.now()+minutes*60000);res.json({ok:true});
});
router.post('/inbox/:id/resolve',admin,(req,res)=>{
  // Resolve after a human has dealt with the message; no blind resend endpoint.
  const result=db.prepare("UPDATE rocky_inbox SET status='resolved',updated_at=? WHERE id=? AND empresa_id=? AND status IN ('draft','review')").run(Date.now(),req.params.id,req.jwtPayload.empresaId);
  res.status(result.changes?200:409).json({ok:!!result.changes});
});
module.exports={router,verifyMeta};
