require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const path = require("path");

function required(name, fallback = "") {
  return process.env[name] ?? fallback;
}

// Orígenes permitidos para CORS.
// Acepta: lista de ALLOWED_ORIGINS + cualquier *.vercel.app + localhost.
const ALLOWED_ORIGINS_RAW = process.env.ALLOWED_ORIGINS || "";
const _explicitOrigins = ALLOWED_ORIGINS_RAW
  ? ALLOWED_ORIGINS_RAW.split(",").map(s => s.trim())
  : [
      "http://localhost:5173",
      "http://localhost:3000",
      "https://app.organizalo.ai",
      "https://organizalo.ai",
      "https://app.monki.ai",
      "https://monki.ai",
    ];

// Función CORS dinámica: acepta orígenes explícitos + cualquier Vercel preview + localhost
function allowedOrigins(origin, callback) {
  // Sin origin (curl, mobile nativo, Postman) → permitir
  if (!origin) return callback(null, true);
  // Orígenes explícitos
  if (_explicitOrigins.includes(origin)) return callback(null, true);
  // Cualquier *.vercel.app (previews y producción)
  if (/^https:\/\/[a-zA-Z0-9-]+(\.vercel\.app)$/.test(origin)) return callback(null, true);
  // localhost en cualquier puerto
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return callback(null, true);
  // 127.0.0.1
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return callback(null, true);
  callback(new Error(`Origen no permitido por CORS: ${origin}`));
}

module.exports = {
  port: Number(process.env.PORT || 3001),
  allowedOrigins,
  // Ruta del archivo SQLite. En un hosting real (Railway, etc.) esto debe
  // apuntar a un disco/volumen persistente (ej. "/data/organizalo.db") —
  // si no, el contenedor se reinicia con un filesystem limpio y se pierden
  // las facturas y la config de la charla guardadas. En local, por defecto
  // usa ./data/organizalo.db dentro del propio proyecto.
  dbPath: required("DB_PATH") || path.resolve(__dirname, "..", "data", "organizalo.db"),
  apiAuthToken: required("API_AUTH_TOKEN"),
  jwtSecret: required("JWT_SECRET"),
  haciendaEnv: required("HACIENDA_ENV", "sandbox"),
  haciendaUsername: required("HACIENDA_USERNAME"),
  haciendaPassword: required("HACIENDA_PASSWORD"),
  cryptoKeyPath: required("CRYPTO_KEY_PATH", "./keys/llave.p12"),
  cryptoKeyPassword: required("CRYPTO_KEY_PASSWORD"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  resendApiKey:    required("RESEND_API_KEY"),
  publicUrl:       required("PUBLIC_URL", "https://api.organizalo.ai"),
  bccrToken:       required("BCCR_TOKEN"),
  bccrEmail:       required("BCCR_EMAIL", "sebascruz11211134@gmail.com"),
  modoSimulacion: String(process.env.MODO_SIMULACION || "true").toLowerCase() === "true",
  emisor: {
    cedulaTipo: required("EMISOR_CEDULA_TIPO", "02"),
    cedulaNumero: required("EMISOR_CEDULA_NUMERO"),
    nombre: required("EMISOR_NOMBRE"),
    nombreComercial: required("EMISOR_NOMBRE_COMERCIAL"),
    codigoActividad: required("EMISOR_CODIGO_ACTIVIDAD"),
    ubicacion: {
      provincia: required("EMISOR_PROVINCIA", "1"),
      canton: required("EMISOR_CANTON", "01"),
      distrito: required("EMISOR_DISTRITO", "01"),
      otrasSenas: required("EMISOR_OTRAS_SENAS", "N/A"),
    },
    telefono: required("EMISOR_TELEFONO"),
    correo: required("EMISOR_CORREO"),
  },
};
