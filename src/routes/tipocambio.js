/**
 * /api/tipocambio — Tipo de cambio diario del BCCR
 *
 * Consulta indicadores 317 (venta) y 318 (compra) del Banco Central de Costa Rica.
 * Cachea en memoria por 24h para no sobrecargar el API del BCCR.
 *
 * Requiere BCCR_TOKEN y BCCR_EMAIL en .env
 */

const express = require("express");
const jwt     = require("jsonwebtoken");
const config  = require("../config");

const router = express.Router();

// ── JWT middleware ────────────────────────────────────────────────────────────
function requireJWT(req, res, next) {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token requerido." });
  try {
    req.jwtPayload = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido." });
  }
}

// ── Caché en memoria (persiste mientras el proceso esté vivo) ─────────────────
let cache = {
  fecha:  null,   // "YYYY-MM-DD" del día de la última consulta
  compra: null,   // indicador 318
  venta:  null,   // indicador 317
};

// ── Helper: parsear el XML del BCCR ──────────────────────────────────────────
function parsearValorBCCR(xmlText) {
  // La respuesta es XML como: <NUM_VALOR>543.21</NUM_VALOR>
  const match = xmlText.match(/<NUM_VALOR>([\d.]+)<\/NUM_VALOR>/);
  if (match) return parseFloat(match[1]);
  // Alternativa para el JSON-like que devuelve en algunos casos
  const matchAlt = xmlText.match(/"NUM_VALOR"\s*:\s*"?([\d.]+)"?/);
  if (matchAlt) return parseFloat(matchAlt[1]);
  return null;
}

// ── Consultar un indicador al BCCR ────────────────────────────────────────────
async function consultarBCCR(indicador, fecha) {
  const dia  = fecha.getDate().toString().padStart(2, "0");
  const mes  = (fecha.getMonth() + 1).toString().padStart(2, "0");
  const anio = fecha.getFullYear();
  const fechaStr = `${dia}/${mes}/${anio}`;

  const url = new URL(
    "https://gee.bccr.fi.cr/Indicadores/Suscripciones/WS/wsindicadoreseconomicos.asmx/ObtenerIndicadoresEconomicos"
  );
  url.searchParams.set("Indicador",         String(indicador));
  url.searchParams.set("FechaInicio",       fechaStr);
  url.searchParams.set("FechaFinal",        fechaStr);
  url.searchParams.set("Nombre",            "OrganizaloAI");
  url.searchParams.set("SubNiveles",        "N");
  url.searchParams.set("CorreoElectronico", config.bccrEmail);
  url.searchParams.set("Token",             config.bccrToken);

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`BCCR respondió ${res.status}`);
  const text = await res.text();
  return parsearValorBCCR(text);
}

// ── GET /api/tipocambio ───────────────────────────────────────────────────────
router.get("/", requireJWT, async (req, res) => {
  const hoy = new Date().toISOString().split("T")[0];

  // Servir desde caché si es del mismo día
  if (cache.fecha === hoy && cache.compra && cache.venta) {
    return res.json({
      ok:     true,
      fecha:  hoy,
      compra: cache.compra,
      venta:  cache.venta,
      fuente: "cache",
    });
  }

  // Sin credenciales configuradas → fallback
  if (!config.bccrToken || !config.bccrEmail) {
    return res.json({
      ok:     false,
      fecha:  hoy,
      compra: 530,
      venta:  540,
      fuente: "fallback",
      error:  "BCCR_TOKEN o BCCR_EMAIL no configurados en .env",
    });
  }

  try {
    const ahora = new Date();
    const [compra, venta] = await Promise.all([
      consultarBCCR(318, ahora),  // 318 = compra (banco compra USD)
      consultarBCCR(317, ahora),  // 317 = venta  (banco vende USD)
    ]);

    if (!compra || !venta) throw new Error("No se pudo parsear la respuesta del BCCR");

    cache = { fecha: hoy, compra, venta };
    console.log(`[TipoCambio] ${hoy} → compra ₡${compra} | venta ₡${venta}`);

    res.json({ ok: true, fecha: hoy, compra, venta, fuente: "bccr" });
  } catch (err) {
    console.error("[TipoCambio] Error al consultar BCCR:", err.message);

    // Si el caché del día anterior está disponible, usarlo
    if (cache.compra && cache.venta) {
      return res.json({
        ok:     true,
        fecha:  cache.fecha,
        compra: cache.compra,
        venta:  cache.venta,
        fuente: "cache_anterior",
      });
    }

    // Fallback razonable
    res.json({
      ok:     false,
      fecha:  hoy,
      compra: 530,
      venta:  540,
      fuente: "fallback",
      error:  err.message,
    });
  }
});

// ── GET /api/tipocambio/publico — sin JWT (para landing page, etc.) ───────────
router.get("/publico", async (req, res) => {
  const hoy = new Date().toISOString().split("T")[0];
  if (cache.fecha === hoy && cache.compra) {
    return res.json({ ok: true, fecha: hoy, compra: cache.compra, venta: cache.venta });
  }
  // No disparar llamada desde endpoint público — devolver último caché o fallback
  res.json({ ok: true, fecha: cache.fecha || hoy, compra: cache.compra || 530, venta: cache.venta || 540 });
});

module.exports = router;
