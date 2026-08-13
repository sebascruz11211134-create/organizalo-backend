// Prueba local rápida: levanta el server, crea una factura en modo
// simulación, la lista y consulta su estado. No requiere llave real ni
// credenciales de Hacienda porque fuerza MODO_SIMULACION=true.
//
// Uso: npm run smoke-test

process.env.MODO_SIMULACION = "true";
process.env.API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || "smoke-test-token";
process.env.EMISOR_CEDULA_NUMERO = process.env.EMISOR_CEDULA_NUMERO || "310123456789";
process.env.EMISOR_NOMBRE = process.env.EMISOR_NOMBRE || "Negocio de Prueba SA";
process.env.EMISOR_CODIGO_ACTIVIDAD = process.env.EMISOR_CODIGO_ACTIVIDAD || "620100";
process.env.EMISOR_TELEFONO = process.env.EMISOR_TELEFONO || "88888888";
process.env.EMISOR_CORREO = process.env.EMISOR_CORREO || "prueba@example.com";
process.env.PORT = process.env.PORT || "3999";

const fs = require("fs");
const path = require("path");

// Usa una base de datos temporal para no ensuciar data/organizalo.db.
const tmpDbDir = path.resolve(__dirname, "..", "data-smoke-test");
fs.rmSync(tmpDbDir, { recursive: true, force: true });

// db.js resuelve la ruta relativa a src/, así que sobreescribimos require
// del módulo db temporalmente cambiando el cwd no es viable; en vez de eso
// dejamos que use data/ normal pero limpiamos el archivo antes y después.
const realDbPath = path.resolve(__dirname, "..", "data", "organizalo.db");
const backupPath = `${realDbPath}.smoke-backup`;
if (fs.existsSync(realDbPath)) fs.renameSync(realDbPath, backupPath);

async function main() {
  const PORT = process.env.PORT;
  const BASE = `http://localhost:${PORT}`;
  const TOKEN = process.env.API_AUTH_TOKEN;

  require("../src/index.js");
  await new Promise((r) => setTimeout(r, 500));

  const fetch = require("node-fetch");

  console.log("\n1) GET /health");
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  console.log(health);
  if (!health.ok) throw new Error("Health check falló.");

  console.log("\n2) POST /api/invoices (sin token, debe fallar con 401)");
  const noAuth = await fetch(`${BASE}/api/invoices`, { method: "POST" });
  console.log("Status:", noAuth.status);
  if (noAuth.status !== 401) throw new Error("Se esperaba 401 sin token.");

  console.log("\n3) POST /api/invoices (con token, factura de prueba)");
  const createRes = await fetch(`${BASE}/api/invoices`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      cliente: { nombre: "Confecciones del Valle SA", cedula: "3101987654", correo: "compras@confvalle.cr" },
      items: [
        { descripcion: "Tela algodón - rollo 50m", cantidad: 2, precioUnitario: 45000, tarifaIva: 13 },
        { descripcion: "Servicio de corte", cantidad: 1, precioUnitario: 15000, tarifaIva: 13 },
      ],
      moneda: "CRC",
    }),
  });
  const factura = await createRes.json();
  console.log("Status:", createRes.status);
  console.log(factura);
  if (createRes.status !== 201) throw new Error("No se pudo crear la factura de prueba.");
  if (factura.clave.length !== 50) throw new Error(`Clave debería tener 50 dígitos, tiene ${factura.clave.length}.`);
  if (factura.estado !== "simulado") throw new Error(`Estado esperado "simulado", llegó "${factura.estado}".`);

  console.log("\n4) GET /api/invoices (listar)");
  const listRes = await fetch(`${BASE}/api/invoices`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const lista = await listRes.json();
  console.log(`Facturas encontradas: ${lista.length}`);
  if (lista.length < 1) throw new Error("La lista de facturas está vacía.");

  console.log("\n5) GET /api/invoices/:id/status");
  const statusRes = await fetch(`${BASE}/api/invoices/${factura.id}/status`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const statusData = await statusRes.json();
  console.log(statusData);

  console.log("\n6) PUT /api/charla (actualizar sesión del mes)");
  const putCharla = await fetch(`${BASE}/api/charla`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      fecha: "2026-09-15T18:00:00",
      tema: "Cómo cerrar bien el año fiscal",
      especialista: "Lic. Prueba Contador",
      especialistaBio: "Contador público autorizado, 10 años de experiencia con PYMEs.",
      linkReunion: "https://meet.google.com/abc-defg-hij",
    }),
  });
  const charlaActualizada = await putCharla.json();
  console.log(charlaActualizada);
  if (putCharla.status !== 200) throw new Error("No se pudo actualizar la charla mensual.");
  if (charlaActualizada.tema !== "Cómo cerrar bien el año fiscal") throw new Error("El tema no se guardó bien.");

  console.log("\n7) GET /api/charla (leer sesión del mes)");
  const getCharla = await fetch(`${BASE}/api/charla`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const charlaLeida = await getCharla.json();
  console.log(charlaLeida);
  if (charlaLeida.especialista !== "Lic. Prueba Contador") throw new Error("La charla leída no coincide con la guardada.");

  console.log("\n✅ Smoke test completo: todo funcionó en modo simulación.");
  process.exit(0);
}

main()
  .catch((err) => {
    console.error("\n❌ Smoke test falló:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Restaura la base de datos real y limpia la de prueba.
    const realDb = path.resolve(__dirname, "..", "data", "organizalo.db");
    fs.rmSync(realDb, { force: true });
    if (fs.existsSync(backupPath)) fs.renameSync(backupPath, realDb);
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  });
