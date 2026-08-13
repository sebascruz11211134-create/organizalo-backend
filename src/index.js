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
}));

app.use(express.json({ limit: "10mb" }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Auth endpoints — límite estricto para prevenir brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20,                   // 20 intentos por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos. Esperá 15 minutos e intentá de nuevo." },
});

// API general — límite moderado
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 300,                  // 300 requests/min por IP
  standardHeaders: true,
  legacyHeaders: false,
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

// ── Cron: recordatorios WhatsApp a las 8am ────────────────────────────────────
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 8 && now.getMinutes() < 5) {
    enviarRecordatoriosHoy().catch(console.error);
  }
}, 5 * 60 * 1000);

// ── Servidor ──────────────────────────────────────────────────────────────────
server.listen(config.port, () => {
  console.log(`Organízalo.AI backend escuchando en puerto ${config.port}`);
  console.log(`Modo simulación: ${config.modoSimulacion ? "ACTIVADO" : "DESACTIVADO"}`);
  console.log(`Entorno Hacienda: ${config.haciendaEnv}`);
  console.log(`Orígenes permitidos: ${config.allowedOrigins}`);
});
