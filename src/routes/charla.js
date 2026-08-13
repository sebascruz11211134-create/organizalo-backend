const express = require("express");
const { db } = require("../db");

const router = express.Router();

function rowToCharla(row) {
  if (!row) return null;
  return {
    fecha: row.fecha,
    tema: row.tema,
    especialista: row.especialista,
    especialistaBio: row.especialista_bio,
    linkReunion: row.link_reunion,
    actualizadoEn: row.actualizado_en,
  };
}

// GET /api/charla — la app la consulta para mostrar la sesión del mes.
router.get("/", (req, res) => {
  const row = db.prepare("SELECT * FROM charla_config WHERE id = 1").get();
  res.json(rowToCharla(row));
});

// PUT /api/charla — la usa quien organiza la charla (el mismo token de
// API_AUTH_TOKEN que usa la app; no hay un rol de "administrador" aparte
// todavía) para actualizar la sesión del mes.
// Body: { fecha, tema, especialista, especialistaBio, linkReunion }
router.put("/", (req, res) => {
  const { fecha, tema, especialista, especialistaBio, linkReunion } = req.body || {};

  if (!fecha || !tema || !especialista || !linkReunion) {
    return res.status(400).json({
      error: "Faltan campos: fecha, tema, especialista y linkReunion son obligatorios.",
    });
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO charla_config (id, fecha, tema, especialista, especialista_bio, link_reunion, actualizado_en)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       fecha = excluded.fecha,
       tema = excluded.tema,
       especialista = excluded.especialista,
       especialista_bio = excluded.especialista_bio,
       link_reunion = excluded.link_reunion,
       actualizado_en = excluded.actualizado_en`
  ).run(fecha, tema, especialista, especialistaBio || "", linkReunion, now);

  const row = db.prepare("SELECT * FROM charla_config WHERE id = 1").get();
  res.json(rowToCharla(row));
});

module.exports = router;
