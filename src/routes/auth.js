/**
 * /api/auth — Registro, login, perfil y logout con JWT.
 *
 * POST /api/auth/register  { nombre, email, password, telefono? }
 * POST /api/auth/login     { email, password }
 * GET  /api/auth/me        Authorization: Bearer <token>
 * POST /api/auth/logout    (solo limpia el token en el cliente; el server no guarda sesiones)
 */

const express  = require("express");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { db }   = require("../db");
const config   = require("../config");

const router = express.Router();

// El superadmin puede registrarse sin código de acceso
const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL;

// ── Validación de contraseña fuerte ──────────────────────────────────────────
function validatePasswordStrength(password) {
  const fails = [];
  if (!password || password.length < 8)    fails.push("Mínimo 8 caracteres");
  if (!/[A-Z]/.test(password))             fails.push("Al menos una mayúscula (A-Z)");
  if (!/[a-z]/.test(password))             fails.push("Al menos una minúscula (a-z)");
  if (!/[0-9]/.test(password))             fails.push("Al menos un número (0-9)");
  if (!/[^A-Za-z0-9]/.test(password))      fails.push("Al menos un carácter especial (!@#$%...)");
  return fails; // array vacío = contraseña válida
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jwtSecret() {
  if (!config.jwtSecret) throw new Error("JWT_SECRET no configurado en .env");
  return config.jwtSecret;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, empresaId: user.empresa_id, rol: user.rol, plan: user.plan },
    jwtSecret(),
    { expiresIn: "7d" }
  );
}

function issueRefreshToken(userId) {
  const token     = uuidv4();
  const now       = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 30 * 86400_000).toISOString(); // 30 días
  db.prepare(
    "INSERT INTO refresh_tokens (id, user_id, token, expires_at, revoked, created_at) VALUES (?, ?, ?, ?, 0, ?)"
  ).run(uuidv4(), userId, token, expiresAt, now);
  return token;
}

function userPublic(row) {
  return {
    id:            row.id,
    nombre:        row.nombre,
    email:         row.email,
    username:      row.username || "",
    telefono:      row.telefono || "",
    empresaId:     row.empresa_id || null,
    empresaNombre: row.empresa_nombre || "",
    rol:           row.rol || "admin",
    plan:          row.plan,
    trialEnds:     row.trial_ends || null,
    activo:        row.activo === 1,
    creadoEn:      row.creado_en,
  };
}

// Genera username único a partir del nombre del usuario
function generateUsername(nombre, email, id) {
  const base = nombre.trim().split(/\s+/)[0].toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "") || email.split("@")[0].replace(/[^a-z0-9]/g, "");
  // Verificar si ya existe
  const exists = db.prepare("SELECT id FROM users WHERE username = ? AND id != ?").get(base, id || "");
  if (!exists) return base;
  // Agregar sufijo numérico
  for (let i = 2; i <= 999; i++) {
    const candidate = `${base}${i}`;
    const e2 = db.prepare("SELECT id FROM users WHERE username = ? AND id != ?").get(candidate, id || "");
    if (!e2) return candidate;
  }
  return `${base}${Date.now()}`;
}

function requireJWT(req, res, next) {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token requerido." });
  try {
    req.jwtPayload = jwt.verify(token, jwtSecret());
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado." });
  }
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
// Requiere un código de acceso válido generado por el superadmin.

router.post("/register", async (req, res) => {
  try {
    const { nombre, email, password, telefono, codigoAcceso } = req.body || {};

    if (!nombre || typeof nombre !== "string" || nombre.trim().length < 2)
      return res.status(400).json({ error: "Nombre requerido (mínimo 2 caracteres)." });
    if (!email || !email.includes("@"))
      return res.status(400).json({ error: "Correo electrónico inválido." });

    const pwdErrors = validatePasswordStrength(password);
    if (pwdErrors.length > 0)
      return res.status(400).json({ error: `Contraseña insegura: ${pwdErrors.join(", ")}.` });

    const emailNorm   = email.trim().toLowerCase();
    const esSuperAdmin = emailNorm === SUPERADMIN_EMAIL;

    let empresaId, empresaNom, rol, planUser, trialEndsUser;

    if (esSuperAdmin) {
      // Superadmin: no necesita código de acceso, plan activo permanente
      empresaId     = "superadmin";
      empresaNom    = "Organízalo.AI — Admin";
      rol           = "superadmin";
      planUser      = "activo";
      trialEndsUser = null;
    } else {
      // Usuario normal: requiere código de acceso válido
      if (!codigoAcceso || typeof codigoAcceso !== "string")
        return res.status(400).json({ error: "Se requiere un código de acceso. Contactá a Organízalo.AI para obtener el tuyo." });

      const codigo = db.prepare(
        "SELECT * FROM access_codes WHERE codigo = ? COLLATE NOCASE"
      ).get(codigoAcceso.trim().toUpperCase());

      if (!codigo)
        return res.status(403).json({ error: "Código de acceso inválido. Verificá que esté bien escrito." });
      if (codigo.usos_actuales >= codigo.max_usos)
        return res.status(403).json({ error: `Este código ya alcanzó el límite de ${codigo.max_usos} usuario${codigo.max_usos !== 1 ? "s" : ""}. Solicitá un nuevo código.` });
      if (codigo.expira_en && new Date(codigo.expira_en) < new Date())
        return res.status(403).json({ error: "Este código de acceso venció. Solicitá uno nuevo." });
      if (codigo.email_esperado && codigo.email_esperado.toLowerCase() !== emailNorm)
        return res.status(403).json({ error: "Este código fue generado para otro correo electrónico." });

      const esPrimero = codigo.usos_actuales === 0;
      empresaId  = esPrimero ? uuidv4() : codigo.empresa_id;
      empresaNom = esPrimero ? nombre.trim() : (codigo.empresa_nombre || nombre.trim());
      rol        = esPrimero ? "admin" : "colaborador";
      planUser      = "trial";
      trialEndsUser = new Date(Date.now() + 7 * 86400_000).toISOString();

      // Actualizar contador del código
      if (esPrimero) {
        db.prepare(
          "UPDATE access_codes SET usos_actuales = usos_actuales + 1, empresa_id = ?, empresa_nombre = ? WHERE id = ?"
        ).run(empresaId, nombre.trim(), codigo.id);
      } else {
        db.prepare(
          "UPDATE access_codes SET usos_actuales = usos_actuales + 1 WHERE id = ?"
        ).run(codigo.id);
      }
    }

    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(emailNorm);
    if (existing) return res.status(409).json({ error: "Ya existe una cuenta con ese correo." });

    const passwordHash = await bcrypt.hash(password, 12);
    const now          = new Date().toISOString();
    const id           = uuidv4();

    // Auto-generar username único a partir del nombre
    const username = generateUsername(nombre.trim(), email.trim(), id);

    db.prepare(`
      INSERT INTO users (id, nombre, email, password_hash, telefono, empresa_id, empresa_nombre, rol, plan, trial_ends, activo, username, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(id, nombre.trim(), emailNorm, passwordHash, telefono || null, empresaId, empresaNom, rol, planUser, trialEndsUser, username, now, now);

    const user         = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    const token        = signToken(user);
    const refreshToken = issueRefreshToken(id);

    res.status(201).json({ token, refreshToken, user: userPublic(user) });
  } catch (err) {
    console.error("[auth/register]", err);
    res.status(500).json({ error: "Error interno. Intente de nuevo." });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
// Acepta { email, password } donde "email" puede ser el correo O el username.

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password)
      return res.status(400).json({ error: "Usuario/correo y contraseña requeridos." });

    const id = email.trim().toLowerCase();
    const user = db.prepare(
      "SELECT * FROM users WHERE LOWER(email) = ? OR (username IS NOT NULL AND LOWER(username) = ?)"
    ).get(id, id);

    if (!user) return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    if (!user.activo) return res.status(403).json({ error: "Cuenta desactivada. Contacte al administrador." });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Usuario o contraseña incorrectos." });

    const token        = signToken(user);
    const refreshToken = issueRefreshToken(user.id);
    res.json({ token, refreshToken, user: userPublic(user) });
  } catch (err) {
    console.error("[auth/login]", err);
    res.status(500).json({ error: "Error interno. Intente de nuevo." });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

router.get("/me", requireJWT, (req, res) => {
  try {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.jwtPayload.sub);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    // Incluir módulos habilitados de la empresa
    let modulosHabilitados = null;
    if (user.empresa_id) {
      const cfg = db.prepare("SELECT modulos_json FROM empresa_config WHERE empresa_id = ?").get(user.empresa_id);
      if (cfg?.modulos_json) {
        try { modulosHabilitados = JSON.parse(cfg.modulos_json); } catch (_) {}
      }
    }

    res.json({ user: userPublic(user), modulosHabilitados });
  } catch (err) {
    console.error("[auth/me]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────

router.post("/refresh", (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: "Refresh token requerido." });

  const row = db.prepare(
    "SELECT * FROM refresh_tokens WHERE token = ? AND revoked = 0"
  ).get(refreshToken);

  if (!row) return res.status(401).json({ error: "Refresh token inválido o revocado." });
  if (new Date(row.expires_at) < new Date())
    return res.status(401).json({ error: "Refresh token vencido. Iniciá sesión nuevamente." });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(row.user_id);
  if (!user || !user.activo) return res.status(401).json({ error: "Usuario no encontrado o inactivo." });

  // Rotar refresh token (invalidar el viejo, emitir uno nuevo)
  db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE id = ?").run(row.id);
  const newRefreshToken = issueRefreshToken(user.id);
  const newToken        = signToken(user);

  res.json({ token: newToken, refreshToken: newRefreshToken });
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

router.post("/logout", (req, res) => {
  const { refreshToken } = req.body || {};
  if (refreshToken) {
    try { db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE token = ?").run(refreshToken); }
    catch (_) {}
  }
  res.json({ ok: true });
});

// ── POST /api/auth/invite ─────────────────────────────────────────────────────
// El admin invita a un colaborador por email.

router.post("/invite", requireJWT, (req, res) => {
  try {
    const inviter = db.prepare("SELECT * FROM users WHERE id = ?").get(req.jwtPayload.sub);
    if (!inviter) return res.status(404).json({ error: "Usuario no encontrado." });
    if (inviter.rol !== "admin") return res.status(403).json({ error: "Solo el administrador puede invitar colaboradores." });

    const { email, rol = "colaborador" } = req.body || {};
    if (!email || !email.includes("@")) return res.status(400).json({ error: "Correo inválido." });

    const token     = uuidv4();
    const now       = new Date().toISOString();
    const expiraEn  = new Date(Date.now() + 7 * 86400_000).toISOString();
    const id        = uuidv4();

    db.prepare(`
      INSERT INTO invites (id, empresa_id, empresa_nombre, invitado_por, email, rol, token, usado, expira_en, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, inviter.empresa_id, inviter.empresa_nombre, inviter.nombre, email.toLowerCase(), rol, token, expiraEn, now);

    // En producción aquí iría nodemailer. Por ahora devolvemos el link.
    const inviteLink = `http://31.97.141.124:3001/api/auth/accept-invite/${token}`;
    res.json({ ok: true, inviteLink, mensaje: `Invitación creada para ${email}. Comparte este link.` });
  } catch (err) {
    console.error("[auth/invite]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── GET /api/auth/invite/:token — info de la invitación ──────────────────────

router.get("/invite/:token", (req, res) => {
  try {
    const invite = db.prepare("SELECT * FROM invites WHERE token = ? AND usado = 0").get(req.params.token);
    if (!invite) return res.status(404).json({ error: "Invitación no válida o ya usada." });
    if (new Date(invite.expira_en) < new Date()) return res.status(410).json({ error: "La invitación expiró." });
    res.json({ empresaNombre: invite.empresa_nombre, email: invite.email, rol: invite.rol, invitadoPor: invite.invitado_por });
  } catch (err) {
    res.status(500).json({ error: "Error interno." });
  }
});

// ── POST /api/auth/accept-invite/:token — aceptar invitación ─────────────────

router.post("/accept-invite/:token", async (req, res) => {
  try {
    const invite = db.prepare("SELECT * FROM invites WHERE token = ? AND usado = 0").get(req.params.token);
    if (!invite) return res.status(404).json({ error: "Invitación no válida o ya usada." });
    if (new Date(invite.expira_en) < new Date()) return res.status(410).json({ error: "La invitación expiró." });

    const { nombre, password } = req.body || {};
    if (!nombre || !password)
      return res.status(400).json({ error: "Nombre y contraseña requeridos." });
    const pwdErrors2 = validatePasswordStrength(password);
    if (pwdErrors2.length > 0)
      return res.status(400).json({ error: `Contraseña insegura: ${pwdErrors2.join(", ")}.` });

    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(invite.email);
    if (existing) return res.status(409).json({ error: "Ya existe una cuenta con ese correo." });

    const passwordHash = await bcrypt.hash(password, 12);
    const now = new Date().toISOString();
    const id  = uuidv4();

    const username = generateUsername(nombre.trim(), invite.email, id);

    db.prepare(`
      INSERT INTO users (id, nombre, email, password_hash, empresa_id, empresa_nombre, rol, plan, trial_ends, activo, username, creado_en, actualizado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'activo', NULL, 1, ?, ?, ?)
    `).run(id, nombre.trim(), invite.email, passwordHash, invite.empresa_id, invite.empresa_nombre, invite.rol, username, now, now);

    db.prepare("UPDATE invites SET usado = 1 WHERE id = ?").run(invite.id);

    const user  = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    const token = signToken(user);
    res.status(201).json({ token, user: userPublic(user) });
  } catch (err) {
    console.error("[auth/accept-invite]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── GET /api/auth/team — colaboradores de la empresa ─────────────────────────

router.get("/team", requireJWT, (req, res) => {
  try {
    const members = db.prepare(
      "SELECT id, nombre, email, username, rol, activo, creado_en FROM users WHERE empresa_id = ? ORDER BY creado_en ASC"
    ).all(req.jwtPayload.empresaId);
    res.json({ members });
  } catch (err) {
    res.status(500).json({ error: "Error interno." });
  }
});

// ── POST /api/auth/create-user — admin crea un usuario bajo su empresa ────────
// Solo admins y superadmins pueden crear usuarios dentro de su empresa.

router.post("/create-user", requireJWT, async (req, res) => {
  try {
    const { rol: rolAdmin, empresaId, email: adminEmail } = req.jwtPayload;
    if (!["admin", "superadmin"].includes(rolAdmin)) {
      return res.status(403).json({ error: "Solo administradores pueden crear usuarios." });
    }

    const { nombre, username, password, rol = "colaborador" } = req.body || {};
    if (!nombre?.trim()) return res.status(400).json({ error: "El nombre es requerido." });
    if (!username?.trim()) return res.status(400).json({ error: "El usuario es requerido." });
    if (!password || password.length < 6)
      return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres." });

    const usernameLow = username.trim().toLowerCase().replace(/\s+/g, "_");

    // Verificar que el username no exista en toda la plataforma
    const existing = db.prepare("SELECT id FROM users WHERE username = ?").get(usernameLow);
    if (existing) return res.status(409).json({ error: `El usuario "${usernameLow}" ya existe. Elige otro.` });

    const hash = await bcrypt.hash(password, 10);
    const id   = uuidv4();

    // Obtener empresa_nombre del admin
    const adminUser = db.prepare("SELECT empresa_nombre FROM users WHERE id = ?").get(req.jwtPayload.sub);
    const empresa_nombre = adminUser?.empresa_nombre || "";

    db.prepare(`
      INSERT INTO users (id, nombre, email, username, password_hash, empresa_id, empresa_nombre, rol, plan, activo, creado_en)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'activo', 1, datetime('now'))
    `).run(id, nombre.trim(), `${usernameLow}@interno.${empresaId}`, usernameLow, hash, empresaId, empresa_nombre, rol);

    res.json({
      ok: true,
      user: { id, nombre: nombre.trim(), username: usernameLow, rol, activo: true }
    });
  } catch (err) {
    console.error("[auth/create-user]", err);
    res.status(500).json({ error: "Error interno al crear el usuario." });
  }
});

// ── PUT /api/auth/update-user/:id — admin actualiza usuario de su empresa ─────

router.put("/update-user/:id", requireJWT, async (req, res) => {
  try {
    const { rol: rolAdmin, empresaId } = req.jwtPayload;
    if (!["admin", "superadmin"].includes(rolAdmin)) {
      return res.status(403).json({ error: "Sin permiso." });
    }

    const target = db.prepare("SELECT * FROM users WHERE id = ? AND empresa_id = ?").get(req.params.id, empresaId);
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    const { nombre, password, rol, activo } = req.body || {};
    const updates = [];
    const values  = [];

    if (nombre?.trim())          { updates.push("nombre = ?");        values.push(nombre.trim()); }
    if (rol)                     { updates.push("rol = ?");           values.push(rol); }
    if (typeof activo === "boolean") { updates.push("activo = ?");   values.push(activo ? 1 : 0); }
    if (password && password.length >= 6) {
      updates.push("password_hash = ?");
      values.push(await bcrypt.hash(password, 10));
    }

    if (updates.length === 0) return res.json({ ok: true, message: "Sin cambios." });
    values.push(req.params.id);
    db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error interno." });
  }
});

// ── DELETE /api/auth/delete-user/:id — admin elimina usuario de su empresa ────

router.delete("/delete-user/:id", requireJWT, (req, res) => {
  try {
    const { rol: rolAdmin, empresaId, sub } = req.jwtPayload;
    if (!["admin", "superadmin"].includes(rolAdmin)) {
      return res.status(403).json({ error: "Sin permiso." });
    }
    if (req.params.id === sub) return res.status(400).json({ error: "No puedes eliminarte a ti mismo." });

    const target = db.prepare("SELECT id FROM users WHERE id = ? AND empresa_id = ?").get(req.params.id, empresaId);
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error interno." });
  }
});

// ── PUT /api/auth/perfil — actualizar nombre propio ──────────────────────────
router.put("/perfil", requireJWT, (req, res) => {
  try {
    const { sub } = req.jwtPayload;
    const { nombre } = req.body || {};
    if (!nombre || typeof nombre !== "string" || nombre.trim().length < 2)
      return res.status(400).json({ error: "Nombre inválido." });
    db.prepare("UPDATE users SET nombre = ?, actualizado_en = ? WHERE id = ?")
      .run(nombre.trim(), new Date().toISOString(), sub);
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(sub);
    res.json(buildUser(row));
  } catch (err) {
    console.error("[auth/perfil]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

module.exports = router;
