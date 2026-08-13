/**
 * /api/asistente — Agente IA con tool-calling por empresa.
 *
 * El agente puede consultar los datos reales de la empresa en tiempo real
 * usando "tools" (herramientas). Cada tool filtra por empresaId del JWT,
 * garantizando aislamiento total entre clientes.
 *
 * Flujo:
 *  1. Usuario hace pregunta
 *  2. Claude decide qué tools necesita y las llama
 *  3. Backend ejecuta las queries y devuelve resultados reales
 *  4. Claude analiza y responde con datos exactos
 *  (repite hasta máx MAX_ITERACIONES)
 */

const express   = require("express");
const jwt       = require("jsonwebtoken");
const Anthropic = require("@anthropic-ai/sdk");
const { db }    = require("../db");
const config    = require("../config");
const { checkQuota, registerUsage } = require("../middleware/apiQuota");

const router = express.Router();
const MAX_ITERACIONES = 6; // máximo de rondas de tool-calling

// ── Auth ──────────────────────────────────────────────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function parse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function hoy() {
  return new Date().toISOString().slice(0, 10);
}

function mesActual() {
  return new Date().toISOString().slice(0, 7);
}

function fmtCRC(n) {
  return `₡${Number(n || 0).toLocaleString("es-CR", { minimumFractionDigits: 0 })}`;
}

/** Carga un array de cloud_data para una empresa */
function cargarDato(empresaId, clave) {
  const row = db.prepare(
    "SELECT valor FROM cloud_data WHERE empresa_id = ? AND clave = ?"
  ).get(empresaId, clave);
  if (!row) return [];
  const data = parse(row.valor);
  return Array.isArray(data) ? data : (data ? [data] : []);
}

function cargarObjeto(empresaId, clave) {
  const row = db.prepare(
    "SELECT valor FROM cloud_data WHERE empresa_id = ? AND clave = ?"
  ).get(empresaId, clave);
  return row ? (parse(row.valor) || {}) : {};
}

// ── Definición de herramientas ─────────────────────────────────────────────────
const TOOLS = [
  {
    name: "buscar_facturas",
    description: "Busca facturas emitidas de la empresa. Úsala para preguntas sobre ventas, ingresos, clientes que compraron, totales de facturación o facturas específicas.",
    input_schema: {
      type: "object",
      properties: {
        cliente:    { type: "string",  description: "Filtrar por nombre o parte del nombre del cliente" },
        fechaDesde: { type: "string",  description: "Fecha inicio YYYY-MM-DD" },
        fechaHasta: { type: "string",  description: "Fecha fin YYYY-MM-DD" },
        estado:     { type: "string",  description: "Estado: pagada | pendiente | anulada" },
        limite:     { type: "integer", description: "Máximo de resultados (default 30)" },
      },
      required: [],
    },
  },
  {
    name: "buscar_cxc",
    description: "Consulta cuentas por cobrar (deudas de clientes). Úsala para preguntas sobre quién debe dinero, cobros pendientes, deudas vencidas o saldo de un cliente específico.",
    input_schema: {
      type: "object",
      properties: {
        cliente:      { type: "string",  description: "Filtrar por nombre del cliente" },
        soloVencidas: { type: "boolean", description: "true para traer solo las vencidas" },
        limite:       { type: "integer", description: "Máximo de resultados (default 30)" },
      },
      required: [],
    },
  },
  {
    name: "buscar_cxp",
    description: "Consulta cuentas por pagar (deudas con proveedores). Úsala para preguntas sobre lo que se le debe a proveedores o pagos pendientes.",
    input_schema: {
      type: "object",
      properties: {
        proveedor:    { type: "string",  description: "Filtrar por nombre del proveedor" },
        soloVencidas: { type: "boolean", description: "true para traer solo las vencidas" },
        limite:       { type: "integer", description: "Máximo de resultados (default 30)" },
      },
      required: [],
    },
  },
  {
    name: "buscar_inventario",
    description: "Consulta el inventario de productos. Úsala para preguntas sobre stock, precios, productos bajo mínimo o existencias de un producto específico.",
    input_schema: {
      type: "object",
      properties: {
        producto:     { type: "string",  description: "Filtrar por nombre o parte del nombre del producto" },
        soloStockBajo: { type: "boolean", description: "true para traer solo productos bajo el mínimo" },
        sinStock:     { type: "boolean", description: "true para traer solo productos sin stock" },
        limite:       { type: "integer", description: "Máximo de resultados (default 30)" },
      },
      required: [],
    },
  },
  {
    name: "buscar_contactos",
    description: "Busca clientes o proveedores registrados en el sistema. Úsala para encontrar datos de contacto, cédula, teléfono o información de clientes/proveedores.",
    input_schema: {
      type: "object",
      properties: {
        nombre: { type: "string", description: "Nombre o parte del nombre a buscar" },
        tipo:   { type: "string", description: "cliente | proveedor | ambos (default: ambos)" },
        limite: { type: "integer", description: "Máximo de resultados (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "buscar_pedidos",
    description: "Consulta pedidos u órdenes de venta. Úsala para preguntas sobre el pipeline de ventas, pedidos en proceso o entregados.",
    input_schema: {
      type: "object",
      properties: {
        cliente: { type: "string", description: "Filtrar por nombre del cliente" },
        estado:  { type: "string", description: "pendiente | en_proceso | entregado | cancelado" },
        limite:  { type: "integer", description: "Máximo de resultados (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "buscar_cotizaciones",
    description: "Busca cotizaciones o presupuestos enviados a clientes. Úsala para preguntas sobre propuestas enviadas, tasa de conversión o cotizaciones abiertas.",
    input_schema: {
      type: "object",
      properties: {
        cliente: { type: "string", description: "Filtrar por nombre del cliente" },
        estado:  { type: "string", description: "borrador | enviada | aprobada | rechazada" },
        limite:  { type: "integer", description: "Máximo de resultados (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "buscar_compras",
    description: "Busca facturas de proveedores o compras realizadas. Úsala para preguntas sobre gastos, compras a proveedores o historial de adquisiciones.",
    input_schema: {
      type: "object",
      properties: {
        proveedor:  { type: "string", description: "Filtrar por nombre del proveedor" },
        fechaDesde: { type: "string", description: "Fecha inicio YYYY-MM-DD" },
        fechaHasta: { type: "string", description: "Fecha fin YYYY-MM-DD" },
        limite:     { type: "integer", description: "Máximo de resultados (default 20)" },
      },
      required: [],
    },
  },
  {
    name: "resumen_financiero",
    description: "Genera un resumen financiero del período solicitado: facturación, cobros pendientes, gastos, top clientes. Úsala cuando el usuario pide un resumen general, indicadores del negocio o comparativas.",
    input_schema: {
      type: "object",
      properties: {
        periodo: {
          type: "string",
          description: "Período a analizar: hoy | semana | mes | trimestre | año (default: mes)",
        },
      },
      required: [],
    },
  },
];

// ── Implementación de herramientas ─────────────────────────────────────────────
function ejecutarTool(nombre, input, empresaId) {
  try {
    switch (nombre) {

      case "buscar_facturas": {
        let items = cargarDato(empresaId, "facturas");
        const lim = input.limite || 30;
        if (input.cliente)
          items = items.filter(f => (f.clienteNombre || f.cliente || "").toLowerCase().includes(input.cliente.toLowerCase()));
        if (input.fechaDesde)
          items = items.filter(f => (f.fecha || "") >= input.fechaDesde);
        if (input.fechaHasta)
          items = items.filter(f => (f.fecha || "") <= input.fechaHasta);
        if (input.estado)
          items = items.filter(f => (f.estado || "").toLowerCase() === input.estado.toLowerCase());
        items = items.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")).slice(0, lim);
        const total = items.reduce((s, f) => s + (f.total || 0), 0);
        return {
          total_resultados: items.length,
          total_monto: fmtCRC(total),
          facturas: items.map(f => ({
            numero:   f.numero || f.id || "—",
            fecha:    f.fecha || "—",
            cliente:  f.clienteNombre || f.cliente || "—",
            total:    fmtCRC(f.total),
            estado:   f.estado || "—",
            metodo:   f.metodoPago || "—",
          })),
        };
      }

      case "buscar_cxc": {
        let items = cargarDato(empresaId, "cxc");
        const lim = input.limite || 30;
        // Solo pendientes (con saldo)
        items = items.filter(d => Math.max(0, (d.total || 0) - (d.pagado || 0)) > 0);
        if (input.cliente)
          items = items.filter(d => (d.clienteNombre || d.cliente || "").toLowerCase().includes(input.cliente.toLowerCase()));
        if (input.soloVencidas)
          items = items.filter(d => d.fechaVencimiento && d.fechaVencimiento < hoy());
        items = items.slice(0, lim);
        const totalPendiente = items.reduce((s, d) => s + Math.max(0, (d.total || 0) - (d.pagado || 0)), 0);
        return {
          total_cuentas: items.length,
          total_pendiente: fmtCRC(totalPendiente),
          cuentas: items.map(d => ({
            cliente:    d.clienteNombre || d.cliente || "—",
            total:      fmtCRC(d.total),
            pagado:     fmtCRC(d.pagado || 0),
            pendiente:  fmtCRC(Math.max(0, (d.total || 0) - (d.pagado || 0))),
            vencimiento: d.fechaVencimiento || "—",
            vencida:    d.fechaVencimiento ? d.fechaVencimiento < hoy() : false,
          })),
        };
      }

      case "buscar_cxp": {
        let items = cargarDato(empresaId, "cxp");
        const lim = input.limite || 30;
        items = items.filter(d => Math.max(0, (d.total || 0) - (d.pagado || 0)) > 0);
        if (input.proveedor)
          items = items.filter(d => (d.proveedorNombre || d.proveedor || "").toLowerCase().includes(input.proveedor.toLowerCase()));
        if (input.soloVencidas)
          items = items.filter(d => d.fechaVencimiento && d.fechaVencimiento < hoy());
        items = items.slice(0, lim);
        const totalPendiente = items.reduce((s, d) => s + Math.max(0, (d.total || 0) - (d.pagado || 0)), 0);
        return {
          total_cuentas: items.length,
          total_pendiente: fmtCRC(totalPendiente),
          cuentas: items.map(d => ({
            proveedor:  d.proveedorNombre || d.proveedor || "—",
            pendiente:  fmtCRC(Math.max(0, (d.total || 0) - (d.pagado || 0))),
            vencimiento: d.fechaVencimiento || "—",
            vencida:    d.fechaVencimiento ? d.fechaVencimiento < hoy() : false,
          })),
        };
      }

      case "buscar_inventario": {
        let items = cargarDato(empresaId, "inventario");
        const lim = input.limite || 30;
        items = items.filter(p => p.activo !== false);
        if (input.producto)
          items = items.filter(p => (p.nombre || "").toLowerCase().includes(input.producto.toLowerCase()));
        if (input.soloStockBajo)
          items = items.filter(p => (p.stock || 0) <= (p.stockMin || 0) && (p.stock || 0) > 0);
        if (input.sinStock)
          items = items.filter(p => (p.stock || 0) === 0);
        items = items.slice(0, lim);
        return {
          total_resultados: items.length,
          productos: items.map(p => ({
            nombre:    p.nombre || "—",
            codigo:    p.codigo || p.codigoBarras || "—",
            stock:     p.stock ?? 0,
            stockMin:  p.stockMin ?? 0,
            precio:    fmtCRC(p.precioVenta || p.precio || 0),
            bodega:    p.bodega || "—",
            bajo_minimo: (p.stock || 0) <= (p.stockMin || 0),
          })),
        };
      }

      case "buscar_contactos": {
        let items = cargarDato(empresaId, "contactos");
        const lim = input.limite || 20;
        if (input.nombre)
          items = items.filter(c => (c.nombre || "").toLowerCase().includes(input.nombre.toLowerCase()));
        if (input.tipo && input.tipo !== "ambos")
          items = items.filter(c => (c.tipo || "cliente") === input.tipo);
        items = items.slice(0, lim);
        return {
          total_resultados: items.length,
          contactos: items.map(c => ({
            nombre:   c.nombre || "—",
            tipo:     c.tipo || "cliente",
            cedula:   c.cedula || "—",
            telefono: c.telefono || "—",
            email:    c.email || "—",
            codigo:   c.codigoCliente || "—",
          })),
        };
      }

      case "buscar_pedidos": {
        let items = cargarDato(empresaId, "pedidos");
        const lim = input.limite || 20;
        if (input.cliente)
          items = items.filter(p => (p.clienteNombre || p.cliente || "").toLowerCase().includes(input.cliente.toLowerCase()));
        if (input.estado)
          items = items.filter(p => (p.estado || "").toLowerCase() === input.estado.toLowerCase());
        items = items.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")).slice(0, lim);
        return {
          total_resultados: items.length,
          pedidos: items.map(p => ({
            numero:  p.numero || p.id || "—",
            cliente: p.clienteNombre || p.cliente || "—",
            fecha:   p.fecha || "—",
            estado:  p.estado || "—",
            total:   fmtCRC(p.total || 0),
          })),
        };
      }

      case "buscar_cotizaciones": {
        let items = cargarDato(empresaId, "cotizaciones");
        const lim = input.limite || 20;
        if (input.cliente)
          items = items.filter(c => (c.clienteNombre || c.cliente || "").toLowerCase().includes(input.cliente.toLowerCase()));
        if (input.estado)
          items = items.filter(c => (c.estado || "").toLowerCase() === input.estado.toLowerCase());
        items = items.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")).slice(0, lim);
        return {
          total_resultados: items.length,
          cotizaciones: items.map(c => ({
            numero:  c.numero || c.id || "—",
            cliente: c.clienteNombre || c.cliente || "—",
            fecha:   c.fecha || "—",
            estado:  c.estado || "borrador",
            total:   fmtCRC(c.total || 0),
          })),
        };
      }

      case "buscar_compras": {
        let items = cargarDato(empresaId, "compras");
        const lim = input.limite || 20;
        if (input.proveedor)
          items = items.filter(c => (c.proveedorNombre || c.proveedor || "").toLowerCase().includes(input.proveedor.toLowerCase()));
        if (input.fechaDesde)
          items = items.filter(c => (c.fecha || "") >= input.fechaDesde);
        if (input.fechaHasta)
          items = items.filter(c => (c.fecha || "") <= input.fechaHasta);
        items = items.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || "")).slice(0, lim);
        const total = items.reduce((s, c) => s + (c.total || 0), 0);
        return {
          total_resultados: items.length,
          total_monto: fmtCRC(total),
          compras: items.map(c => ({
            proveedor: c.proveedorNombre || c.proveedor || "—",
            fecha:     c.fecha || "—",
            total:     fmtCRC(c.total || 0),
            estado:    c.estado || "—",
          })),
        };
      }

      case "resumen_financiero": {
        const periodo = input.periodo || "mes";
        const ahora = new Date();
        let fechaDesde;
        if (periodo === "hoy")      fechaDesde = hoy();
        else if (periodo === "semana") {
          const d = new Date(ahora); d.setDate(d.getDate() - 7);
          fechaDesde = d.toISOString().slice(0, 10);
        } else if (periodo === "mes") {
          fechaDesde = mesActual() + "-01";
        } else if (periodo === "trimestre") {
          const d = new Date(ahora); d.setMonth(d.getMonth() - 3);
          fechaDesde = d.toISOString().slice(0, 10);
        } else { // año
          fechaDesde = ahora.getFullYear() + "-01-01";
        }

        const facturas  = cargarDato(empresaId, "facturas").filter(f => (f.fecha || "") >= fechaDesde);
        const compras   = cargarDato(empresaId, "compras").filter(c => (c.fecha || "") >= fechaDesde);
        const cxc       = cargarDato(empresaId, "cxc").filter(d => Math.max(0, (d.total || 0) - (d.pagado || 0)) > 0);
        const cxp       = cargarDato(empresaId, "cxp").filter(d => Math.max(0, (d.total || 0) - (d.pagado || 0)) > 0);
        const inventario = cargarDato(empresaId, "inventario").filter(p => p.activo !== false);

        const totalVentas  = facturas.reduce((s, f) => s + (f.total || 0), 0);
        const totalGastos  = compras.reduce((s, c) => s + (c.total || 0), 0);
        const totalCxC     = cxc.reduce((s, d) => s + Math.max(0, (d.total || 0) - (d.pagado || 0)), 0);
        const totalCxP     = cxp.reduce((s, d) => s + Math.max(0, (d.total || 0) - (d.pagado || 0)), 0);
        const cxcVencidas  = cxc.filter(d => d.fechaVencimiento && d.fechaVencimiento < hoy());
        const stockBajo    = inventario.filter(p => (p.stock || 0) <= (p.stockMin || 0));

        // Top 5 clientes por ventas
        const porCliente = {};
        facturas.forEach(f => {
          const k = f.clienteNombre || f.cliente || "Sin nombre";
          porCliente[k] = (porCliente[k] || 0) + (f.total || 0);
        });
        const topClientes = Object.entries(porCliente)
          .sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([n, t]) => ({ cliente: n, total: fmtCRC(t) }));

        const settings = cargarObjeto(empresaId, "settings");

        return {
          empresa:      settings.nombreNegocio || "—",
          periodo,
          fecha_desde:  fechaDesde,
          fecha_hasta:  hoy(),
          ventas: {
            total:     fmtCRC(totalVentas),
            facturas:  facturas.length,
            top_clientes: topClientes,
          },
          gastos: {
            total:   fmtCRC(totalGastos),
            compras: compras.length,
          },
          utilidad_bruta: fmtCRC(totalVentas - totalGastos),
          cxc: {
            total_pendiente: fmtCRC(totalCxC),
            cuentas: cxc.length,
            vencidas: cxcVencidas.length,
          },
          cxp: {
            total_pendiente: fmtCRC(totalCxP),
            cuentas: cxp.length,
          },
          inventario: {
            total_productos: inventario.length,
            bajo_minimo:     stockBajo.length,
          },
        };
      }

      default:
        return { error: `Herramienta "${nombre}" no reconocida.` };
    }
  } catch (err) {
    console.error(`[asistente/tool:${nombre}]`, err.message);
    return { error: `Error ejecutando ${nombre}: ${err.message}` };
  }
}

// ── POST /api/asistente/chat ──────────────────────────────────────────────────
router.post("/chat", requireJWT, checkQuota, async (req, res) => {
  try {
    const { sub: userId, empresaId, rol = "admin" } = req.jwtPayload;

    if (!empresaId)
      return res.status(400).json({ error: "Usuario no tiene empresa asignada." });
    if (!config.anthropicApiKey)
      return res.status(500).json({ error: "ANTHROPIC_API_KEY no configurada en el servidor." });

    const { messages = [] } = req.body;
    if (!messages.length)
      return res.status(400).json({ error: "messages requerido." });

    // Obtener nombre de empresa
    const userRow = db.prepare("SELECT empresa_nombre FROM users WHERE id = ?").get(userId);
    const settings = cargarObjeto(empresaId, "settings");
    const empresaNombre = settings.nombreNegocio || userRow?.empresa_nombre || "la empresa";

    // Limpiar mensajes entrantes
    const msgLimpios = messages
      .filter(m => (m.role === "user" || m.role === "assistant") && m.content)
      .slice(-10); // últimos 10 de historia

    if (!msgLimpios.length || msgLimpios[msgLimpios.length - 1].role !== "user")
      return res.status(400).json({ error: "El último mensaje debe ser del usuario." });

    const rolesNombres = {
      admin: "Administrador", gerencia: "Gerencia", ventas: "Ventas",
      contabilidad: "Contabilidad", bodega: "Bodega", rrhh: "RRHH",
      colaborador: "Colaborador", superadmin: "SuperAdmin",
    };

    const systemPrompt = `Eres el asistente IA de Organízalo.AI para la empresa "${empresaNombre}".
El usuario tiene rol: ${rolesNombres[rol] || rol}. Fecha de hoy: ${hoy()}.

Tenés acceso a herramientas para consultar los datos reales de la empresa en tiempo real.
Usá las herramientas que necesites para responder con datos exactos.

REGLAS:
- Siempre usá las herramientas para obtener datos antes de responder. No inventes cifras.
- Si la herramienta devuelve datos vacíos, decilo claramente.
- Respondé siempre en español, de forma clara y concisa.
- Usá ₡ para colones y $ para dólares.
- Si el usuario pide un análisis, usá resumen_financiero primero y complementá con otras tools.
- Podés llamar varias herramientas en una misma respuesta si la pregunta lo requiere.`;

    const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

    // ── Loop agentico ─────────────────────────────────────────────────────────
    let mensajes = [...msgLimpios];
    let totalTokensIn  = 0;
    let totalTokensOut = 0;
    let toolsUsados    = [];
    let respuestaFinal = null;

    for (let i = 0; i < MAX_ITERACIONES; i++) {
      const response = await anthropic.messages.create({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        system:     systemPrompt,
        tools:      TOOLS,
        messages:   mensajes,
      });

      totalTokensIn  += response.usage?.input_tokens  || 0;
      totalTokensOut += response.usage?.output_tokens || 0;

      // ¿Terminó con texto?
      if (response.stop_reason === "end_turn") {
        const textBlock = response.content.find(b => b.type === "text");
        respuestaFinal = textBlock?.text || "No pude generar una respuesta.";
        break;
      }

      // ¿Quiere usar tools?
      if (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(b => b.type === "tool_use");

        // Agregar respuesta del asistente al historial
        mensajes.push({ role: "assistant", content: response.content });

        // Ejecutar cada tool y armar resultados
        const toolResults = toolUseBlocks.map(tb => {
          toolsUsados.push(tb.name);
          const resultado = ejecutarTool(tb.name, tb.input || {}, empresaId);
          return {
            type:        "tool_result",
            tool_use_id: tb.id,
            content:     JSON.stringify(resultado),
          };
        });

        // Agregar resultados al historial para el próximo turno
        mensajes.push({ role: "user", content: toolResults });
        continue;
      }

      // stop_reason inesperado — terminar con lo que haya
      const textBlock = response.content.find(b => b.type === "text");
      respuestaFinal = textBlock?.text || "No pude generar una respuesta.";
      break;
    }

    if (!respuestaFinal) {
      respuestaFinal = "Alcancé el límite de operaciones internas. Por favor reformulá la pregunta.";
    }

    // Registrar uso total de tokens
    registerUsage(empresaId, { input_tokens: totalTokensIn, output_tokens: totalTokensOut });

    const uso = req.apiUsage;
    res.json({
      reply: respuestaFinal,
      toolsUsados: [...new Set(toolsUsados)],
      cuota: uso ? {
        usados:    uso.mensajes_usados + 1,
        limite:    uso.limite_mensajes,
        restantes: Math.max(0, uso.limite_mensajes - uso.mensajes_usados - 1),
      } : null,
    });

  } catch (err) {
    console.error("[asistente/chat]", err);
    res.status(500).json({ error: "Error interno del asistente IA." });
  }
});

module.exports = router;
