const crypto=require('node:crypto');
function valid(url,params,signature,token) {
  if(!token || typeof signature!=='string')return false;
  const value=url+Object.keys(params).sort().map(k=>k+params[k]).join('');
  const expected=crypto.createHmac('sha1',token).update(value).digest('base64');
  const a=Buffer.from(expected),b=Buffer.from(signature);return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
const xml=value=>String(value??'').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
module.exports={valid,xml};
