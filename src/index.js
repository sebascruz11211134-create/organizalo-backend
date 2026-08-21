const express    = require("express");
const http       = require("http");
const cors       = require("cors");
const helmet     = require("helmet");
const rateLimit  = require("express-rate-limit");
const { Server } = require("socket.io");
const jwt        = require("jsonwebtoken");

const config        = require("./config");
const { requireAuth } = require("./auth");
const authRouter    = require("./routes/auth");
const invoicesRouter = require("./routes/invoices");
const charlaRouter  = require("./routes/charla");
const chatRouter    = require("./routes/chat");
const clouddataRouter = require("./routes/clouddata");
const adminRouter     = require("./routes/admin");
const certRouter      = require("./routes/cert");
const recepcionRouter = require("./routes/recepcion");
const eventosRouter   = require("./routes/eventos");
const crmRouter       = require("./routes/crm");
const whatsappRouter  = require("./routes/whatsapp");
const { enviarRecordatoriosHoy } = require("./routes/whatsapp");
const ntfy = require("./services/ntfy");
const asistenteRouter   = require("./routes/asistente");
const rockyRouter       = require("./routes/rocky");
const ntfyRouter        = require("./routes/ntfy");
const tipocambioRouter  = require("./routes/tipocambio");

const app    = express();
const server = http.createServer(app);

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: config.allowedOrigins,
    methods: ["GET", "POST"],
  },
});

app.set("io", io);

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Token requerido"));
  try {
    socket.jwtPayload = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    next(new Error("Token inválido"));
  }
});

io.on("connection", (socket) => {
  const { empresaId } = socket.jwtPayload;
  const CANALES = ["general", "facturación", "contabilidad", "inventario", "soporte"];
  CANALES.forEach(canal => socket.join(`empresa:${empresaId}:${canal}`));
  socket.on("join_canal", (canal) => socket.join(`empresa:${empresaId}:${canal}`));
  socket.on("disconnect", () => {});
});

// ── Seguridad HTTP ────────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false, // permite iframes de Hacienda
  contentSecurityPolicy: false,     // el frontend lo maneja
}));

app.use(cors({
  origin: config.allowedOrigins,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "10mb" }));

app.set("trust proxy", 1);

// Railway / proxies — necesario para que express-rate-limit funcione correctamente
app.set("trust proxy", 1);

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Auth endpoints — límite estricto para prevenir brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20,                   // 20 intentos por IP — brute force protection
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false }, // desactivar validación de proxy en Railway
  message: { error: "Demasiados intentos fallidos. Esperá 15 minutos e intentá de nuevo." },
});

// API general — límite moderado
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 300,                  // 300 requests/min por IP
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false }, // desactivar validación de proxy en Railway
  message: { error: "Demasiadas solicitudes. Intentá en un momento." },
});

app.use("/api/auth/login",    authLimiter);
app.use("/api/auth/register", authLimiter);
app.use("/api/",              apiLimiter);

// ── Rutas ─────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    servicio: "organizalo-backend",
    modoSimulacion: config.modoSimulacion,
    haciendaEnv: config.haciendaEnv,
  });
});

app.use("/api/auth",      authRouter);
app.use("/api/chat",      chatRouter);
app.use("/api/clouddata", clouddataRouter);
app.use("/api/admin",     adminRouter);
app.use("/api/invoices",   invoicesRouter);
app.use("/api/charla",     charlaRouter);
app.use("/api/cert",       certRouter);
app.use("/api/recepcion",  recepcionRouter);
app.use("/api/eventos",    eventosRouter);
app.use("/api/crm",        crmRouter);
app.use("/api/whatsapp",   whatsappRouter);
app.use("/api/asistente",   asistenteRouter);
app.use("/api/rocky",       rockyRouter);
app.use("/api/ntfy",        ntfyRouter);
app.use("/api/tipocambio",  tipocambioRouter);

app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada." });
});

// ── Cron: recordatorios diarios a las 8am ────────────────────────────────────
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 8 && now.getMinutes() < 5) {
    enviarRecordatoriosHoy().catch(console.error);
    verificarVencimientos().catch(console.error);
    // Depreciación mensual: solo el día 1 de cada mes
    if (now.getDate() === 1) {
      generarAsientosDepreciacion().catch(console.error);
    }
  }
}, 5 * 60 * 1000);

/**
 * Revisa cloud_data de todas las empresas y envía ntfy para:
 *  - CxC que vence hoy o en 3 días → notificación de cobro
 *  - CxP que vence hoy o en 3 días → notificación de pago
 *  - Eventos del calendario del día siguiente → recordatorio
 */
async function verificarVencimientos() {
  const hoy    = new Date().toISOString().slice(0, 10);
  const en3    = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);

  try {
    // Obtener todas las empresas activas
    const empresas = db.prepare(
      "SELECT DISTINCT empresa_id, empresa_nombre FROM users WHERE empresa_id IS NOT NULL AND activo = 1"
    ).all();

    for (const emp of empresas) {
      const { empresa_id: empresaId, empresa_nombre: empresaNombre } = emp;

      // ── CxC venciendo ──────────────────────────────────────────────────────
      const cxcRow = db.prepare(
        "SELECT valor FROM cloud_data WHERE empresa_id = ? AND clave = 'deudas'"
      ).get(empresaId);
      if (cxcRow?.valor) {
        let deudas = [];
        try { deudas = JSON.parse(cxcRow.valor); } catch {}

        const cxcVenciendo = deudas.filter(d =>
          d.tipo === "cobrar" &&
          d.fechaVencimiento &&
          d.fechaVencimiento >= hoy && d.fechaVencimiento <= en3 &&
          Math.max(0, (d.total || 0) - (d.pagado || 0)) > 1
        );

        for (const d of cxcVenciendo) {
          const saldo = d.total - (d.pagado || 0);
          const esHoy = d.fechaVencimiento === hoy;
          await ntfy.notifyByPrefs({
            tipo:      "cobro_vencido",
            empresaId,
            title:     esHoy ? `💰 Cobro VENCE HOY: ${d.nombre}` : `⏰ Cobro próximo: ${d.nombre}`,
            message:   `₡${saldo.toLocaleString("es-CR", {minimumFractionDigits:0})} — vence el ${d.fechaVencimiento}${d.facturaRef ? ` (${d.facturaRef})` : ""}`,
            priority:  esHoy ? 5 : 3,
          }, db);
        }
      }

      // ── CxP venciendo ──────────────────────────────────────────────────────
      const cxpVenciendo = cxcRow?.valor ? [] : [];
      // Las CxP también están en cloud_data['deudas'] con tipo='pagar'
      if (cxcRow?.valor) {
        let deudas = [];
        try { deudas = JSON.parse(cxcRow.valor); } catch {}
        const venciendo = deudas.filter(d =>
          d.tipo === "pagar" &&
          d.fechaVencimiento &&
          d.fechaVencimiento >= hoy && d.fechaVencimiento <= en3 &&
          Math.max(0, (d.total || 0) - (d.pagado || 0)) > 1
        );
        for (const d of venciendo) {
          const saldo = d.total - (d.pagado || 0);
          const esHoy = d.fechaVencimiento === hoy;
          await ntfy.notifyByPrefs({
            tipo:      "cobro_vencido",
            empresaId,
            title:     esHoy ? `🏦 Pago VENCE HOY: ${d.nombre}` : `⏰ Pago próximo: ${d.nombre}`,
            message:   `₡${saldo.toLocaleString("es-CR", {minimumFractionDigits:0})} — vence el ${d.fechaVencimiento}${d.facturaRef ? ` (${d.facturaRef})` : ""}`,
            priority:  esHoy ? 5 : 3,
          }, db);
        }
      }

      // ── Eventos del calendario mañana ──────────────────────────────────────
      try {
        const { getEmpresaDb } = require("./db");
        const edb = getEmpresaDb(empresaId);
        const manana = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
        const eventos = edb.prepare(
          "SELECT * FROM eventos WHERE fecha = ? ORDER BY hora"
        ).all(manana);

        for (const ev of eventos) {
          await ntfy.notifyByPrefs({
            tipo:      "recordatorio_evento",
            empresaId,
            title:     `📅 Mañana: ${ev.titulo}`,
            message:   `${ev.hora ? ev.hora.slice(0,5) + " — " : ""}${ev.descripcion || ""}`,
            priority:  3,
          }, db);
        }
      } catch {}

      // ── Stock mínimo ────────────────────────────────────────────────────────
      try {
        const prodRow = db.prepare(
          "SELECT valor FROM cloud_data WHERE empresa_id = ? AND clave = 'productos'"
        ).get(empresaId);
        if (prodRow?.valor) {
          let productos = [];
          try { productos = JSON.parse(prodRow.valor); } catch {}
          const bajos = productos.filter(p =>
            p.stock != null &&
            p.stock_minimo != null &&
            p.stock_minimo > 0 &&
            parseFloat(p.stock) <= parseFloat(p.stock_minimo)
          );
          for (const p of bajos) {
            await ntfy.notifyByPrefs({
              tipo:      "stock_bajo",
              empresaId,
              title:     `📦 Stock bajo: ${p.nombre}`,
              message:   `Stock actual: ${p.stock} — mínimo: ${p.stock_minimo}`,
              priority:  4,
            }, db);
          }
        }
      } catch {}

      // ── Clientes inactivos → actualizar etapaCRM ────────────────────────────
      try {
        const factRow = db.prepare(
          "SELECT valor FROM cloud_data WHERE empresa_id = ? AND clave = 'facturas'"
        ).get(empresaId);
        const contRow = db.prepare(
          "SELECT valor FROM cloud_data WHERE empresa_id = ? AND clave = 'contactos'"
        ).get(empresaId);

        if (contRow?.valor) {
          let contactos = [];
          let facturas  = [];
          try { contactos = JSON.parse(contRow.valor); } catch {}
          try { facturas  = JSON.parse(factRow?.valor || "[]"); } catch {}

          const hace90 = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
          let changed  = false;

          contactos = contactos.map(c => {
            if (c.tipo !== "cliente" && c.tipo !== "ambos") return c;
            if (c.etapaCRM === "inactivo") return c; // ya marcado

            const nombre = (c.nombre || "").toLowerCase();
            const ultimaFact = facturas
              .filter(f => (f.cliente?.nombre || f.clienteNombre || "").toLowerCase().includes(nombre))
              .map(f => f.fecha || f.creadoEn?.slice(0,10) || "")
              .sort()
              .reverse()[0];

            if (!ultimaFact || ultimaFact < hace90) {
              changed = true;
              // Notificar una vez por cliente
              ntfy.notifyByPrefs({
                tipo:      "cliente_inactivo",
                empresaId,
                title:     `😴 Cliente inactivo: ${c.nombre}`,
                message:   ultimaFact
                  ? `Última compra: ${ultimaFact} (hace más de 90 días)`
                  : "Sin facturas registradas",
                priority:  2,
              }, db).catch(() => {});
              return { ...c, etapaCRM: "inactivo" };
            }
            return c;
          });

          if (changed) {
            db.prepare(
              "INSERT OR REPLACE INTO cloud_data (empresa_id, clave, valor, updated_at) VALUES (?, ?, ?, ?)"
            ).run(empresaId, "contactos", JSON.stringify(contactos), new Date().toISOString());
          }
        }
      } catch {}
    }

    console.log(`[cron] Vencimientos verificados para ${empresas.length} empresas`);
  } catch (err) {
    console.error("[cron/vencimientos]", err.message);
  }
}

/**
 * Genera asientos contables de depreciación mensual para todos los activos fijos
 * activos de todas las empresas. Se ejecuta el día 1 de cada mes.
 */
async function generarAsientosDepreciacion() {
  const { v4: uuidv4 } = require("uuid");
  const hoy = new Date().toISOString().slice(0, 10);
  const mes  = hoy.slice(0, 7); // YYYY-MM — para evitar duplicados del mismo mes

  try {
    const empresas = db.prepare(
      "SELECT DISTINCT empresa_id FROM users WHERE empresa_id IS NOT NULL AND activo = 1"
    ).all();

    for (const { empresa_id: empresaId } of empresas) {
      // Leer activos fijos del cloud_data
      const row = db.prepare(
        "SELECT valor FROM cloud_data WHERE empresa_id = ? AND clave = 'activosFijos'"
      ).get(empresaId);
      if (!row?.valor) continue;

      let activos = [];
      try { activos = JSON.parse(row.valor); } catch { continue; }

      // Leer asientos existentes para no duplicar este mes
      const asRow = db.prepare(
        "SELECT valor FROM cloud_data WHERE empresa_id = ? AND clave = 'asientosContables'"
      ).get(empresaId);
      let asientos = [];
      try { asientos = JSON.parse(asRow?.valor || "[]"); } catch {}

      const yaDepreciado = asientos.some(a =>
        a.autoGenerado && a.descripcion?.includes("Depreciación") && a.fecha?.startsWith(mes)
      );
      if (yaDepreciado) continue;

      // Calcular depreciación mensual por activo
      const nuevos = [];
      for (const activo of activos) {
        if (!activo.nombre || !activo.costo || !activo.fechaCompra) continue;
        const costo        = parseFloat(activo.costo) || 0;
        const residual     = parseFloat(activo.valorResidual) || 0;
        const vidaMeses    = (parseInt(activo.vidaUtil) || 5) * 12;
        const depMensual   = Math.max(0, (costo - residual) / vidaMeses);
        if (depMensual <= 0) continue;

        nuevos.push({
          id: uuidv4(), numero: `DEP-${String(asientos.length + nuevos.length + 1).padStart(5,"0")}`,
          estado: "confirmado", autoGenerado: true,
          descripcion: `Depreciación mensual — ${activo.nombre}`,
          fecha: hoy, totalDebe: depMensual, totalHaber: depMensual,
          lineas: [
            { cuentaCodigo: "6201", cuentaNombre: "Gasto depreciación", debe: depMensual, haber: 0 },
            { cuentaCodigo: "1502", cuentaNombre: "Depreciación acumulada", debe: 0, haber: depMensual },
          ],
          creadoEn: new Date().toISOString(),
        });
      }

      if (nuevos.length === 0) continue;

      const actualizados = [...asientos, ...nuevos];
      db.prepare(
        "INSERT OR REPLACE INTO cloud_data (empresa_id, clave, valor, actualizado_en) VALUES (?, ?, ?, ?)"
      ).run(empresaId, "asientosContables", JSON.stringify(actualizados), new Date().toISOString());

      console.log(`[cron/dep] ${nuevos.length} asientos de depreciación para empresa ${empresaId}`);
    }
  } catch (err) {
    console.error("[cron/depreciacion]", err.message);
  }
}

// ── Servidor ──────────────────────────────────────────────────────────────────
server.listen(config.port, () => {
  console.log(`Organízalo.AI backend escuchando en puerto ${config.port}`);
  console.log(`Modo simulación: ${config.modoSimulacion ? "ACTIVADO" : "DESACTIVADO"}`);
  console.log(`Entorno Hacienda: ${config.haciendaEnv}`);
  console.log(`Orígenes permitidos: ${config.allowedOrigins}`);
});
