const jwt=require('jsonwebtoken');
const config=require('../config');
const {db}=require('../db');
module.exports=function(req,res,next) {
  try {
    const token=(req.headers.authorization||'').replace(/^Bearer /,'');
    const claim=jwt.verify(token,config.jwtSecret);
    const user=db.prepare('SELECT * FROM users WHERE id=? AND activo=1').get(claim.sub);
    if(!user || user.empresa_id!==claim.empresaId || !['admin','superadmin','gerencia'].includes(user.rol)) return res.status(403).json({error:'Se requiere administración de la empresa.'});
    req.jwtPayload=claim; next();
  } catch { res.status(401).json({error:'Sesión inválida o vencida.'}); }
};
