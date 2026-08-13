// Middleware simple: el app móvil debe mandar el mismo token que está en
// API_AUTH_TOKEN (.env) en el header Authorization: Bearer <token>.
// No es OAuth ni nada sofisticado — es suficiente para que un solo negocio
// use su propio backend sin que cualquiera en internet pueda llamarlo.

const config = require("./config");

function requireAuth(req, res, next) {
  if (!config.apiAuthToken) {
    return res.status(500).json({
      error: "El backend no tiene API_AUTH_TOKEN configurado en .env. Define uno antes de usarlo.",
    });
  }

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token || token !== config.apiAuthToken) {
    return res.status(401).json({ error: "Token inválido o ausente." });
  }

  next();
}

module.exports = { requireAuth };
