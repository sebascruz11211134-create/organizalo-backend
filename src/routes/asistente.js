/**
 * /api/asistente — Asistente IA por empresa con filtrado de datos por rol.
 *
 * POST /api/asistente/chat
 *   Authorization: Bearer <jwt>
 *   Body: { messages: [{role, content}], pregunta?: string }
 *
 * El endpoint:
 *   1. Verifica el JWT y extrae empresaId + rol
 *   2. Carga de cloud_data solo las claves permitidas para ese rol
 *   3. Construye un system prompt con los datos resumidos de la empresa
 *   4. Llama a Anthropic y devuelve la respuesta
 */

const express   = require("express");
const jwt       = require("jsonwebtoken");
const Anthropic = require("@anthropic-ai/sdk");
const { db }    = require("../db");
const config    = require("../config");

const router = express.Router();

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireJWT(req, res, next) {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token requerido." });
  try {
    req.jwtPayload = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado." });
  }
}

// ── Permisos por rol → claves de cloud_data que puede ver ────────────────────
//
// null  = sin restricción (ve todo)
// Array = solo esas claves

const ROLE_CLAVES = {
  admin:        null,
  gerencia:     [
    "facturas", "cotizaciones", "cxc", "cxp", "recibos",
    "inventario", "productos_catalogo", "contactos", "pedidos",
    "analytics", "flujo_caja",
  ],
  ventas:       [
    "facturas", "cotizaciones", "contactos", "pedidos",
    "cxc", "recibos", "pos_ventas", "productos_catalogo",
  ],
  contabilidad: [
    "facturas", "compras", "cxc", "cxp", "recibos",
    "asientos", "balances", "catalogo_cuentas", "d104",
    "presupuesto", "conciliacion_bancaria", "notas_credito",
  ],
  bodega:       [
    "inventario", "productos_catalogo", "compras",
    "pedidos", "ordenes_trabajo",
  ],
  rrhh:         [
    "empleados", "planillas", "flujo_caja",
  ],
  colaborador:  [
    "facturas", "cotizaciones", "contactos", "pedidos",
  ],
};

// ── Helpers de resumen — evitan mandar arrays enormes a Claude ───────────────

function hace90dias() {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d.toISOString().slice(0, 10);
}

function hace30dias() {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().slice(0, 10);
}

function hoy() {
  return new Date().toISOString().slice(0, 10);
}

function mesActual() {
  return new Date().toISOString().slice(0, 7); // "2026-08"
}

function fmtCRC(n) {
  return `₡${Number(n || 0).toLocaleString("es-CR", { minimumFractionDigits: 0 })}`;
}

/** Parsea JSON sin explotar */
function parse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/**
 * Dado el objeto completo de cloud_data de la empresa,
 * genera un string de contexto compacto según el rol.
 */
function buildContexto(datos, rol, empresaNombre) {
  const secciones = [];
  const hd = hace30dias();
  const h90 = hace90dias();

  // ── Empresa / settings ────────────────────────────────────────────────────
  const settings = datos["settings"] || {};
  secciones.push(
    `EMPRESA: ${settings.nombreNegocio || empresaNombre || "Sin nombre"} | ` +
    `Moneda: ${settings.moneda || "CRC"} | Fecha hoy: ${hoy()}`
  );

  // ── Facturas ──────────────────────────────────────────────────────────────
  if (datos["facturas"]) {
    const todas = datos["facturas"] || [];
    const recientes = todas.filter(f => (f.fecha || "") >= h90);
    const estesMes  = todas.filter(f => (f.fecha || "").startsWith(mesActual()));
    const totalMes  = estesMes.reduce((s, f) => s + (f.total || 0), 0);
    const totalQ    = recientes.reduce((s, f) => s + (f.total || 0), 0);

    // Top 5 clientes por monto últimos 90 días
    const porCliente = {};
    recientes.forEach(f => {
      const k = f.clienteNombre || f.cliente || "Sin nombre";
      porCliente[k] = (porCliente[k] || 0) + (f.total || 0);
    });
    const topClientes = Object.entries(porCliente)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([n, t]) => `${n}: ${fmtCRC(t)}`).join(", ");

    secciones.push(
      `FACTURACIÓN:\n` +
      `  Este mes (${mesActual()}): ${estesMes.length} facturas | Total: ${fmtCRC(totalMes)}\n` +
      `  Últimos 90 días: ${recientes.length} facturas | Total: ${fmtCRC(totalQ)}\n` +
      `  Top clientes (90d): ${topClientes || "N/D"}`
    );
  }

  // ── CXC ───────────────────────────────────────────────────────────────────
  if (datos["cxc"]) {
    const cxc = datos["cxc"] || [];
    const pendientes = cxc.filter(d => Math.max(0, (d.total || 0) - (d.pagado || 0)) > 0);
    const totalPend  = pendientes.reduce((s, d) => s + Math.max(0, (d.total || 0) - (d.pagado || 0)), 0);
    const vencidas   = pendientes.filter(d => d.fechaVencimiento && d.fechaVencimiento < hoy());
    const totalVenc  = vencidas.reduce((s, d) => s + Math.max(0, (d.total || 0) - (d.pagado || 0)), 0);
    const listaVenc  = vencidas.slice(0, 5).map(d =>
      `${d.clienteNombre || d.cliente || "?"}: ${fmtCRC(Math.max(0, (d.total || 0) - (d.pagado || 0)))} (vence ${d.fechaVencimiento})`
    ).join("\n    ");

    secciones.push(
      `CXC (CUENTAS POR COBRAR):\n` +
      `  Total pendiente: ${fmtCRC(totalPend)} en ${pendientes.length} cuentas\n` +
      `  Vencidas: ${fmtCRC(totalVenc)} en ${vencidas.length} cuentas\n` +
      (listaVenc ? `  Detalle vencidas:\n    ${listaVenc}` : "")
    );
  }

  // ── CXP ───────────────────────────────────────────────────────────────────
  if (datos["cxp"]) {
    const cxp = datos["cxp"] || [];
    const pend    = cxp.filter(d => Math.max(0, (d.total || 0) - (d.pagado || 0)) > 0);
    const totalP  = pend.reduce((s, d) => s + Math.max(0, (d.total || 0) - (d.pagado || 0)), 0);
    secciones.push(
      `CXP (CUENTAS POR PAGAR):\n` +
      `  Total pendiente con proveedores: ${fmtCRC(totalP)} en ${pend.length} cuentas`
    );
  }

  // ── Inventario ────────────────────────────────────────────────────────────
  if (datos["inventario"]) {
    const inv     = datos["inventario"] || [];
    const activos = inv.filter(p => p.activo !== false);
    const bajoMin = activos.filter(p => (p.stock || 0) <= (p.stockMin || 0));
    const sinStock = activos.filter(p => (p.stock || 0) === 0);
    const bajoList = bajoMin.slice(0, 8).map(p =>
      `${p.nombre} (stock: ${p.stock || 0}, mín: ${p.stockMin || 0})`
    ).join(", ");

    secciones.push(
      `INVENTARIO:\n` +
      `  Total productos activos: ${activos.length}\n` +
      `  Bajo mínimo (${bajoMin.length}): ${bajoList || "ninguno"}\n` +
      `  Sin stock: ${sinStock.length}`
    );
  }

  // ── Compras ───────────────────────────────────────────────────────────────
  if (datos["compras"]) {
    const compras  = datos["compras"] || [];
    const recientes = compras.filter(c => (c.fecha || "") >= hd);
    const total    = recientes.reduce((s, c) => s + (c.total || 0), 0);
    secciones.push(
      `COMPRAS (últimos 30d):\n` +
      `  ${recientes.length} facturas proveedor | Total: ${fmtCRC(total)}`
    );
  }

  // ── Empleados / Planillas ─────────────────────────────────────────────────
  if (datos["empleados"]) {
    const emp = datos["empleados"] || [];
    secciones.push(`EMPLEADOS: ${emp.filter(e => e.activo !== false).length} activos`);
  }
  if (datos["planillas"]) {
    const pl   = datos["planillas"] || [];
    const ult  = pl.filter(p => (p.mes || "") >= mesActual().slice(0, 7));
    const tot  = ult.reduce((s, p) => s + (p.totalNeto || 0), 0);
    secciones.push(`PLANILLAS: Nómina reciente: ${fmtCRC(tot)}`);
  }

  // ── Asientos / Balances ───────────────────────────────────────────────────
  if (datos["asientos"]) {
    const asientos = datos["asientos"] || [];
    const recientes = asientos.filter(a => (a.fecha || "") >= hd);
    secciones.push(`ASIENTOS CONTABLES: ${recientes.length} en últimos 30d (${asientos.length} total)`);
  }
  if (datos["balances"]) {
    const bal = datos["balances"];
    if (bal) secciones.push(`BALANCES: Datos disponibles para consulta`);
  }

  // ── Pedidos ───────────────────────────────────────────────────────────────
  if (datos["pedidos"]) {
    const ped     = datos["pedidos"] || [];
    const abiertos = ped.filter(p => p.estado !== "entregado" && p.estado !== "cancelado");
    secciones.push(`PEDIDOS: ${abiertos.length} abiertos de ${ped.length} total`);
  }

  // ── Cotizaciones ──────────────────────────────────────────────────────────
  if (datos["cotizaciones"]) {
    const cot     = datos["cotizaciones"] || [];
    const abiertas = cot.filter(c => c.estado === "borrador" || c.estado === "enviada");
    secciones.push(`COTIZACIONES: ${abiertas.length} abiertas de ${cot.length} total`);
  }

  // ── Contactos ─────────────────────────────────────────────────────────────
  if (datos["contactos"]) {
    const con = datos["contactos"] || [];
    const clientes   = con.filter(c => c.tipo === "cliente"   || !c.tipo);
    const proveedores = con.filter(c => c.tipo === "proveedor");
    secciones.push(`CONTACTOS: ${clientes.length} clientes, ${proveedores.length} proveedores`);
  }

  // ── Flujo de caja ─────────────────────────────────────────────────────────
  if (datos["flujo_caja"]) {
    const fc = datos["flujo_caja"] || [];
    secciones.push(`FLUJO DE CAJA: ${fc.length} movimientos registrados`);
  }

  return secciones.join("\n\n");
}

// ── POST /api/asistente/chat ──────────────────────────────────────────────────

router.post("/chat", requireJWT, async (req, res) => {
  try {
    const { sub: userId, empresaId, rol = "admin", email } = req.jwtPayload;

    if (!empresaId) {
      return res.status(400).json({ error: "Usuario no tiene empresa asignada." });
    }

    if (!config.anthropicApiKey) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY no configurada en el servidor." });
    }

    const { messages = [] } = req.body;
    if (!messages.length) {
      return res.status(400).json({ error: "messages requerido." });
    }

    // ── 1. Cargar datos de la empresa según rol ─────────────────────────────
    const clavesPermitidas = ROLE_CLAVES[rol] ?? ROLE_CLAVES["colaborador"];

    let rows;
    if (clavesPermitidas === null) {
      // admin / sin restricción: todo
      rows = db.prepare(
        "SELECT clave, valor FROM cloud_data WHERE empresa_id = ?"
      ).all(empresaId);
    } else {
      const placeholders = clavesPermitidas.map(() => "?").join(", ");
      rows = db.prepare(
        `SELECT clave, valor FROM cloud_data WHERE empresa_id = ? AND clave IN (${placeholders})`
      ).all(empresaId, ...clavesPermitidas);
    }

    // Parsear y construir mapa { clave: datos }
    const datosEmpresa = {};
    // Siempre incluir settings (nombre de empresa, moneda)
    const settingsRow = db.prepare(
      "SELECT valor FROM cloud_data WHERE empresa_id = ? AND clave = 'settings'"
    ).get(empresaId);
    if (settingsRow) {
      datosEmpresa["settings"] = parse(settingsRow.valor) || {};
    }
    for (const row of rows) {
      datosEmpresa[row.clave] = parse(row.valor) ?? row.valor;
    }

    // Obtener nombre de empresa del usuario si no hay settings
    const userRow = db.prepare("SELECT empresa_nombre FROM users WHERE id = ?").get(userId);
    const empresaNombre = datosEmpresa["settings"]?.nombreNegocio
      || userRow?.empresa_nombre
      || "la empresa";

    // ── 2. Construir contexto ───────────────────────────────────────────────
    const contexto = buildContexto(datosEmpresa, rol, empresaNombre);

    // ── 3. System prompt ────────────────────────────────────────────────────
    const rolesNombres = {
      admin: "Administrador", gerencia: "Gerencia", ventas: "Ventas",
      contabilidad: "Contabilidad", bodega: "Bodega", rrhh: "RRHH", colaborador: "Colaborador",
    };
    const rolNombre = rolesNombres[rol] || rol;

    const systemPrompt = `Eres el asistente IA de Organízalo.AI para la empresa "${empresaNombre}".
El usuario que te consulta tiene rol: ${rolNombre}.

REGLAS IMPORTANTES:
- Solo responde con base en los datos del sistema que se te proporcionan abajo.
- No inventes cifras, nombres de clientes, ni información que no esté en los datos.
- Si la información no está disponible en los datos, dilo claramente: "No tengo esa información disponible."
- Responde SIEMPRE en español, de forma clara, concisa y profesional.
- Usa ₡ para colones costarricenses y $ para dólares.
- No menciones restricciones de rol al usuario — simplemente responde solo lo que corresponde.
- Si el usuario pide un análisis, ofrece observaciones útiles y accionables basadas en los datos.
- Puedes hacer cálculos, comparaciones y proyecciones basadas en los datos proporcionados.

DATOS DEL SISTEMA (actualizados a ${hoy()}):
${contexto || "No hay datos sincronizados aún para esta empresa."}`;

    // ── 4. Llamar a Anthropic ───────────────────────────────────────────────
    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

    // Validar y limpiar mensajes (solo user/assistant, contenido string)
    const msgLimpios = messages
      .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
      .slice(-20); // máximo 20 mensajes de historia

    if (!msgLimpios.length) {
      return res.status(400).json({ error: "No hay mensajes válidos." });
    }

    // El último mensaje debe ser del usuario
    const ultimo = msgLimpios[msgLimpios.length - 1];
    if (ultimo.role !== "user") {
      return res.status(400).json({ error: "El último mensaje debe ser del usuario." });
    }

    const response = await anthropic.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   msgLimpios,
    });

    const reply = response.content?.[0]?.text || "No pude generar una respuesta.";

    res.json({ reply, rol, empresaId });

  } catch (err) {
    console.error("[asistente/chat]", err);
    res.status(500).json({ error: "Error interno del asistente IA." });
  }
});

module.exports = router;
