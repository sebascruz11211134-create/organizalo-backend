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

// ── Fetch centralizado (BCCR si hay credenciales, sino open.er-api.com) ───────
async function fetchTipoCambio() {
  const hoy = new Date().toISOString().split("T")[0];
  if (cache.fecha === hoy && cache.compra && cache.venta) return cache;

  let compra = null, venta = null, fuente = "open.er-api";

  // Intentar BCCR primero si hay credenciales
  if (config.bccrToken && config.bccrEmail) {
    try {
      const ahora = new Date();
      [compra, venta] = await Promise.all([
        consultarBCCR(318, ahora),
        consultarBCCR(317, ahora),
      ]);
      if (compra && venta) fuente = "bccr";
    } catch (e) {
      console.warn("[TipoCambio] BCCR falló:", e.message);
    }
  }

  // Fallback a open.er-api.com (sin credenciales, gratis)
  if (!compra || !venta) {
    try {
      const r = await fetch("https://open.er-api.com/v6/latest/USD", {
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      const crcRate = json?.rates?.CRC;
      if (!crcRate) throw new Error("CRC ausente en respuesta");
      compra = Math.round(crcRate * 100) / 100;
      venta  = Math.round(crcRate * 1.013 * 100) / 100;
    } catch (e) {
      console.warn("[TipoCambio] open.er-api falló:", e.message);
    }
  }

  if (compra && venta) {
    cache = { fecha: hoy, compra, venta };
    console.log(`[TipoCambio] ${hoy} → compra ₡${compra} | venta ₡${venta} (${fuente})`);
  }

  return cache;
}

// Cargar tipo de cambio al arrancar el proceso (evita que el primer request tenga fallback)
fetchTipoCambio().catch(() => {});

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
  try {
    const tc = await fetchTipoCambio();
    if (tc.compra && tc.venta) {
      return res.json({ ok: true, fecha: tc.fecha || hoy, compra: tc.compra, venta: tc.venta });
    }
    res.json({ ok: false, fecha: hoy, compra: 510, venta: 520, fuente: "fallback" });
  } catch (err) {
    res.json({ ok: false, fecha: hoy, compra: 510, venta: 520, fuente: "fallback", error: err.message });
  }
});

// ── GET /api/tipocambio/publico — sin JWT ────────────────────────────────────
router.get("/publico", async (req, res) => {
  const hoy = new Date().toISOString().split("T")[0];
  try {
    const tc = await fetchTipoCambio();
    res.json({ ok: true, fecha: tc.fecha || hoy, compra: tc.compra || 510, venta: tc.venta || 520 });
  } catch {
    res.json({ ok: true, fecha: hoy, compra: cache.compra || 510, venta: cache.venta || 520 });
  }
});

module.exports = router;
