/**
 * /api/admin — Panel de administración exclusivo del superadmin.
 *
 * Todas las rutas requieren:
 *   1. JWT válido (requireJWT)
 *   2. Que el email del token sea el SUPERADMIN_EMAIL (requireAdmin)
 *
 * Datos expuestos: solo info de contacto + estado de cuenta.
 * Nunca se exponen datos de negocio (facturas, inventario, etc.).
 */

const express = require("express");
const { v4: uuidv4 } = require("uuid");
const jwt = require("jsonwebtoken");
const { db } = require("../db");
const config = require("../config");

const router = express.Router();

const SUPERADMIN_EMAIL = "sebascruz11211134@gmail.com";

// ── Middlewares ───────────────────────────────────────────────────────────────

function requireJWT(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token requerido." });
  try {
    req.jwtPayload = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido." });
  }
}

function requireAdmin(req, res, next) {
  if (req.jwtPayload?.email !== SUPERADMIN_EMAIL) {
    return res.status(403).json({ error: "Acceso denegado." });
  }
  next();
}

const auth = [requireJWT, requireAdmin];

// ── GET /api/admin/usuarios ───────────────────────────────────────────────────
// Lista todos los usuarios registrados con info de contacto + estado de plan.

router.get("/usuarios", ...auth, (req, res) => {
  try {
    const usuarios = db.prepare(`
      SELECT
        u.id, u.nombre, u.email, u.telefono,
        u.empresa_nombre, u.empresa_id,
        u.plan, u.trial_ends, u.activo,
        u.creado_en, u.actualizado_en,
        n.nota AS nota_soporte
      FROM users u
      LEFT JOIN admin_notas n ON n.user_id = u.id
      ORDER BY u.creado_en DESC
    `).all();

    // Calcular días restantes de trial
    const ahora = new Date();
    const resultado = usuarios.map(u => {
      const trialEnd = u.trial_ends ? new Date(u.trial_ends) : null;
      const diasRestantes = trialEnd
        ? Math.max(0, Math.ceil((trialEnd - ahora) / (1000 * 60 * 60 * 24)))
        : 0;
      const estado = !u.activo
        ? "suspendido"
        : u.plan === "activo"
          ? "activo"
          : diasRestantes > 0
            ? "trial"
            : "vencido";

      return { ...u, diasRestantes, estado };
    });

    res.json({ usuarios: resultado, total: resultado.length });
  } catch (err) {
    console.error("[admin/usuarios]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── POST /api/admin/usuarios/:id/activar ─────────────────────────────────────
// Activa el plan de un usuario (plan = 'activo', sin vencimiento).

router.post("/usuarios/:id/activar", ...auth, (req, res) => {
  try {
    const ahora = new Date().toISOString();
    const changes = db.prepare(`
      UPDATE users SET plan = 'activo', activo = 1, actualizado_en = ?
      WHERE id = ?
    `).run(ahora, req.params.id);

    if (changes.changes === 0) return res.status(404).json({ error: "Usuario no encontrado." });
    res.json({ ok: true, mensaje: "Plan activado." });
  } catch (err) {
    console.error("[admin/activar]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── POST /api/admin/usuarios/:id/extender-trial ───────────────────────────────
// Extiende el trial N días (default 7, máximo 90).

router.post("/usuarios/:id/extender-trial", ...auth, (req, res) => {
  try {
    const dias = Math.min(parseInt(req.body.dias) || 7, 90);
    const usuario = db.prepare("SELECT trial_ends FROM users WHERE id = ?").get(req.params.id);
    if (!usuario) return res.status(404).json({ error: "Usuario no encontrado." });

    const base = usuario.trial_ends && new Date(usuario.trial_ends) > new Date()
      ? new Date(usuario.trial_ends)
      : new Date();
    base.setDate(base.getDate() + dias);

    const ahora = new Date().toISOString();
    db.prepare(`
      UPDATE users SET trial_ends = ?, plan = 'trial', activo = 1, actualizado_en = ?
      WHERE id = ?
    `).run(base.toISOString(), ahora, req.params.id);

    res.json({ ok: true, mensaje: `Trial extendido ${dias} días.`, nuevaFecha: base.toISOString() });
  } catch (err) {
    console.error("[admin/extender-trial]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── POST /api/admin/usuarios/:id/suspender ────────────────────────────────────
// Suspende el acceso de un usuario (activo = 0).

router.post("/usuarios/:id/suspender", ...auth, (req, res) => {
  try {
    const ahora = new Date().toISOString();
    const changes = db.prepare("UPDATE users SET activo = 0, actualizado_en = ? WHERE id = ?")
      .run(ahora, req.params.id);

    if (changes.changes === 0) return res.status(404).json({ error: "Usuario no encontrado." });
    res.json({ ok: true, mensaje: "Usuario suspendido." });
  } catch (err) {
    console.error("[admin/suspender]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── POST /api/admin/usuarios/:id/reactivar ────────────────────────────────────
// Reactiva un usuario suspendido.

router.post("/usuarios/:id/reactivar", ...auth, (req, res) => {
  try {
    const ahora = new Date().toISOString();
    const changes = db.prepare("UPDATE users SET activo = 1, actualizado_en = ? WHERE id = ?")
      .run(ahora, req.params.id);

    if (changes.changes === 0) return res.status(404).json({ error: "Usuario no encontrado." });
    res.json({ ok: true, mensaje: "Usuario reactivado." });
  } catch (err) {
    console.error("[admin/reactivar]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── GET /api/admin/usuarios/:id/nota ─────────────────────────────────────────
// Lee la nota de soporte de un usuario.

router.get("/usuarios/:id/nota", ...auth, (req, res) => {
  try {
    const nota = db.prepare("SELECT nota FROM admin_notas WHERE user_id = ?").get(req.params.id);
    res.json({ nota: nota?.nota || "" });
  } catch (err) {
    res.status(500).json({ error: "Error interno." });
  }
});

// ── POST /api/admin/usuarios/:id/nota ────────────────────────────────────────
// Guarda o actualiza la nota de soporte de un usuario.

router.post("/usuarios/:id/nota", ...auth, (req, res) => {
  try {
    const { nota } = req.body;
    if (typeof nota !== "string") return res.status(400).json({ error: "nota requerida." });

    const ahora = new Date().toISOString();
    const existe = db.prepare("SELECT id FROM admin_notas WHERE user_id = ?").get(req.params.id);

    if (existe) {
      db.prepare("UPDATE admin_notas SET nota = ?, actualizado_en = ? WHERE user_id = ?")
        .run(nota, ahora, req.params.id);
    } else {
      db.prepare("INSERT INTO admin_notas (id, user_id, nota, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?)")
        .run(uuidv4(), req.params.id, nota, ahora, ahora);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[admin/nota]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
// Resumen rápido: total usuarios, activos, en trial, vencidos, suspendidos.

router.get("/stats", ...auth, (req, res) => {
  try {
    const ahora = new Date().toISOString();
    const total      = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
    const activos    = db.prepare("SELECT COUNT(*) AS n FROM users WHERE plan = 'activo' AND activo = 1").get().n;
    const enTrial    = db.prepare("SELECT COUNT(*) AS n FROM users WHERE plan = 'trial' AND trial_ends > ? AND activo = 1").get(ahora).n;
    const vencidos   = db.prepare("SELECT COUNT(*) AS n FROM users WHERE plan = 'trial' AND (trial_ends IS NULL OR trial_ends <= ?) AND activo = 1").get(ahora).n;
    const suspendidos = db.prepare("SELECT COUNT(*) AS n FROM users WHERE activo = 0").get().n;

    res.json({ total, activos, enTrial, vencidos, suspendidos });
  } catch (err) {
    res.status(500).json({ error: "Error interno." });
  }
});

// ── GET /api/admin/usuarios/:id/datos ────────────────────────────────────────
// Lista todas las claves de cloud_data de la empresa del usuario,
// con metadatos (cantidad de registros, tamaño, última actualización).

router.get("/usuarios/:id/datos", ...auth, (req, res) => {
  try {
    const usuario = db.prepare("SELECT empresa_id, nombre, email FROM users WHERE id = ?").get(req.params.id);
    if (!usuario) return res.status(404).json({ error: "Usuario no encontrado." });
    if (!usuario.empresa_id) return res.json({ claves: [], empresaId: null });

    const filas = db.prepare(
      "SELECT clave, valor, actualizado_en FROM cloud_data WHERE empresa_id = ? ORDER BY actualizado_en DESC"
    ).all(usuario.empresa_id);

    const claves = filas.map(f => {
      let conteo = null;
      let tamano = f.valor?.length || 0;
      try {
        const parsed = JSON.parse(f.valor);
        if (Array.isArray(parsed)) conteo = parsed.length;
        else if (parsed && typeof parsed === "object") conteo = Object.keys(parsed).length;
      } catch (_) {}
      return {
        clave: f.clave,
        conteo,
        tamanoBytes: tamano,
        actualizadoEn: f.actualizado_en,
      };
    });

    res.json({ empresaId: usuario.empresa_id, usuario: { nombre: usuario.nombre, email: usuario.email }, claves });
  } catch (err) {
    console.error("[admin/datos]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── GET /api/admin/usuarios/:id/datos/:clave ──────────────────────────────────
// Devuelve el valor completo (JSON) de una clave específica.

router.get("/usuarios/:id/datos/:clave", ...auth, (req, res) => {
  try {
    const usuario = db.prepare("SELECT empresa_id FROM users WHERE id = ?").get(req.params.id);
    if (!usuario?.empresa_id) return res.status(404).json({ error: "Usuario sin empresa." });

    const fila = db.prepare(
      "SELECT valor, actualizado_en FROM cloud_data WHERE empresa_id = ? AND clave = ?"
    ).get(usuario.empresa_id, req.params.clave);

    if (!fila) return res.status(404).json({ error: "Clave no encontrada." });

    let parsed = null;
    try { parsed = JSON.parse(fila.valor); } catch (_) { parsed = fila.valor; }

    res.json({ clave: req.params.clave, valor: parsed, actualizadoEn: fila.actualizado_en });
  } catch (err) {
    console.error("[admin/datos/get]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── PUT /api/admin/usuarios/:id/datos/:clave ──────────────────────────────────
// Reemplaza el valor de una clave (para corregir data de un cliente).

router.put("/usuarios/:id/datos/:clave", ...auth, (req, res) => {
  try {
    const usuario = db.prepare("SELECT empresa_id FROM users WHERE id = ?").get(req.params.id);
    if (!usuario?.empresa_id) return res.status(404).json({ error: "Usuario sin empresa." });

    const { valor } = req.body;
    if (valor === undefined) return res.status(400).json({ error: "valor requerido." });

    const valorStr = typeof valor === "string" ? valor : JSON.stringify(valor);
    const ahora = new Date().toISOString();

    db.prepare(`
      INSERT INTO cloud_data (empresa_id, clave, valor, actualizado_en)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(empresa_id, clave) DO UPDATE SET valor = ?, actualizado_en = ?
    `).run(usuario.empresa_id, req.params.clave, valorStr, ahora, valorStr, ahora);

    res.json({ ok: true, mensaje: "Datos actualizados." });
  } catch (err) {
    console.error("[admin/datos/put]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── DELETE /api/admin/usuarios/:id/datos/:clave ───────────────────────────────
// Elimina una clave de cloud_data (reset de un módulo específico).

router.delete("/usuarios/:id/datos/:clave", ...auth, (req, res) => {
  try {
    const usuario = db.prepare("SELECT empresa_id FROM users WHERE id = ?").get(req.params.id);
    if (!usuario?.empresa_id) return res.status(404).json({ error: "Usuario sin empresa." });

    const changes = db.prepare(
      "DELETE FROM cloud_data WHERE empresa_id = ? AND clave = ?"
    ).run(usuario.empresa_id, req.params.clave);

    if (changes.changes === 0) return res.status(404).json({ error: "Clave no encontrada." });
    res.json({ ok: true, mensaje: `Clave '${req.params.clave}' eliminada.` });
  } catch (err) {
    console.error("[admin/datos/delete]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── GET /api/admin/usuarios/:id/modulos ──────────────────────────────────────
// Devuelve los módulos habilitados para la empresa del usuario.

router.get("/usuarios/:id/modulos", ...auth, (req, res) => {
  try {
    const usuario = db.prepare("SELECT empresa_id FROM users WHERE id = ?").get(req.params.id);
    if (!usuario?.empresa_id) return res.json({ modulosHabilitados: null });

    const cfg = db.prepare("SELECT modulos_json FROM empresa_config WHERE empresa_id = ?").get(usuario.empresa_id);
    const modulos = cfg?.modulos_json ? JSON.parse(cfg.modulos_json) : null;
    res.json({ modulosHabilitados: modulos });
  } catch (err) {
    console.error("[admin/modulos/get]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── PUT /api/admin/usuarios/:id/modulos ───────────────────────────────────────
// Actualiza los módulos habilitados para la empresa del usuario.
// Body: { modulos: ["facturacion","inventario",...] } — null = todos habilitados

router.put("/usuarios/:id/modulos", ...auth, (req, res) => {
  try {
    const usuario = db.prepare("SELECT empresa_id FROM users WHERE id = ?").get(req.params.id);
    if (!usuario?.empresa_id) return res.status(400).json({ error: "Usuario sin empresa." });

    const { modulos } = req.body;
    const modulosJson = modulos === null ? null : JSON.stringify(modulos);
    const ahora = new Date().toISOString();

    db.prepare(`
      INSERT INTO empresa_config (empresa_id, modulos_json, actualizado_en)
      VALUES (?, ?, ?)
      ON CONFLICT(empresa_id) DO UPDATE SET modulos_json = ?, actualizado_en = ?
    `).run(usuario.empresa_id, modulosJson, ahora, modulosJson, ahora);

    res.json({ ok: true, modulosHabilitados: modulos });
  } catch (err) {
    console.error("[admin/modulos/put]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── POST /api/admin/codigos ───────────────────────────────────────────────────
// Genera un nuevo código de acceso para un cliente.
// Body: { nombreCliente?, emailEsperado?, expiraDias? }

router.post("/codigos", ...auth, (req, res) => {
  try {
    const { nombreCliente, emailEsperado, expiraDias, maxUsos = 1 } = req.body || {};

    // Generar código legible: 8 caracteres alfanuméricos en grupos de 4
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0,O,I,1 para evitar confusión
    let codigo = "";
    for (let i = 0; i < 8; i++) {
      if (i === 4) codigo += "-";
      codigo += chars[Math.floor(Math.random() * chars.length)];
    }

    const limiteUsos = Math.max(1, Math.min(parseInt(maxUsos) || 1, 100));
    const ahora = new Date().toISOString();
    const id = uuidv4();
    const expiraEn = expiraDias
      ? new Date(Date.now() + parseInt(expiraDias) * 86400_000).toISOString()
      : null;

    db.prepare(`
      INSERT INTO access_codes (id, codigo, nombre_cliente, email_esperado, max_usos, usos_actuales, creado_en, expira_en)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, codigo, nombreCliente || null, emailEsperado ? emailEsperado.trim().toLowerCase() : null, limiteUsos, ahora, expiraEn);

    res.status(201).json({ ok: true, codigo, id, nombreCliente, emailEsperado, maxUsos: limiteUsos, expiraEn });
  } catch (err) {
    console.error("[admin/codigos/post]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── GET /api/admin/codigos ────────────────────────────────────────────────────
// Lista todos los códigos de acceso generados.

router.get("/codigos", ...auth, (req, res) => {
  try {
    const codigos = db.prepare(
      "SELECT * FROM access_codes ORDER BY creado_en DESC"
    ).all();
    res.json({ codigos, total: codigos.length });
  } catch (err) {
    console.error("[admin/codigos/get]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── DELETE /api/admin/codigos/:id ─────────────────────────────────────────────
// Revoca (elimina) un código de acceso no usado.

router.delete("/codigos/:id", ...auth, (req, res) => {
  try {
    const codigo = db.prepare("SELECT * FROM access_codes WHERE id = ?").get(req.params.id);
    if (!codigo) return res.status(404).json({ error: "Código no encontrado." });
    if (codigo.usado) return res.status(400).json({ error: "No se puede revocar un código ya utilizado." });

    db.prepare("DELETE FROM access_codes WHERE id = ?").run(req.params.id);
    res.json({ ok: true, mensaje: "Código revocado." });
  } catch (err) {
    console.error("[admin/codigos/delete]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// ── API Usage — consumo de IA por empresa ─────────────────────────────────────
const { getUsageStats, setLimiteEmpresa, QUOTA_DEFAULT_DIARIA } = require("../middleware/apiQuota");

// GET /api/admin/api-usage?dias=30 — consumo de todas las empresas
router.get("/api-usage", ...auth, (req, res) => {
  try {
    const dias = parseInt(req.query.dias) || 30;
    const stats = getUsageStats({ dias });

    // Agrupar por empresa para el resumen
    const porEmpresa = {};
    stats.forEach(row => {
      if (!porEmpresa[row.empresa_id]) {
        porEmpresa[row.empresa_id] = {
          empresaId:    row.empresa_id,
          empresaNombre: row.empresa_nombre || row.empresa_id,
          totalMensajes: 0,
          totalTokensIn: 0,
          totalTokensOut: 0,
          limiteDiario: row.limite_mensajes,
          dias: [],
        };
      }
      const e = porEmpresa[row.empresa_id];
      e.totalMensajes  += row.mensajes_usados;
      e.totalTokensIn  += row.tokens_entrada;
      e.totalTokensOut += row.tokens_salida;
      e.limiteDiario    = row.limite_mensajes; // tomar el más reciente
      e.dias.push({ fecha: row.fecha, mensajes: row.mensajes_usados, tokensIn: row.tokens_entrada, tokensOut: row.tokens_salida });
    });

    res.json({
      ok: true,
      dias,
      quotaDefault: QUOTA_DEFAULT_DIARIA,
      empresas: Object.values(porEmpresa).sort((a, b) => b.totalMensajes - a.totalMensajes),
    });
  } catch (err) {
    console.error("[admin/api-usage]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

// PUT /api/admin/api-quota/:empresaId — cambiar límite diario de una empresa
router.put("/api-quota/:empresaId", ...auth, (req, res) => {
  try {
    const { empresaId } = req.params;
    const { limite } = req.body;

    if (!limite || typeof limite !== "number" || limite < 1 || limite > 10000)
      return res.status(400).json({ error: "limite debe ser un número entre 1 y 10000" });

    setLimiteEmpresa(empresaId, limite);
    res.json({ ok: true, empresaId, limite, mensaje: `Límite actualizado a ${limite} mensajes/día` });
  } catch (err) {
    console.error("[admin/api-quota]", err);
    res.status(500).json({ error: "Error interno." });
  }
});

module.exports = router;
