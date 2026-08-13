# organizalo-backend

Backend mínimo para conectar **Organízalo.AI** con la Facturación Electrónica
del Ministerio de Hacienda de Costa Rica (esquema v4.4, firma XAdES-EPES).

La app móvil **nunca** maneja tu llave criptográfica ni tus credenciales de
Hacienda — todo eso vive aquí, en un servidor que tú controlas. La app solo
le manda al backend los datos de la factura (cliente, ítems) por HTTPS con
un token compartido, y el backend arma el XML, lo firma y lo envía.

## ⚠️ Antes de leer más: qué tan "real" es esto

Esto es un **punto de partida funcional**, no un integrador certificado por
Hacienda. Concretamente:

- El XML que arma `src/hacienda/xmlBuilder.js` sigue la estructura general
  de la v4.4 según documentación pública, pero **no ha sido validado contra
  el XSD oficial** (`FacturaElectronica_V4.4.xsd.xml`). Antes de emitir una
  sola factura real, valídalo:
  ```
  xmllint --noout --schema FacturaElectronica_V4.4.xsd.xml archivo.xml
  ```
  El XSD oficial está en https://www.hacienda.go.cr/docs/FacturaElectronica_V4.4.xsd.xml
- La firma XAdES-EPES usa la librería de comunidad `haciendacostarica-signer`
  (MIT). Funciona, pero no es un producto de Hacienda ni tiene soporte oficial.
- Las URLs del API de producción (`HACIENDA_ENV=production`) están inferidas
  por patrón a partir de las de sandbox (confirmadas por investigación en
  agosto 2026) — no fueron probadas contra el ambiente real de producción.
  Verifica avisos vigentes en https://www.hacienda.go.cr/AvisosTRIBU-CR.html
  antes de usarlas.
- Idealmente, que un contador o un integrador certificado revise el
  resultado antes de facturar de verdad. Una factura electrónica mal
  formada puede generar problemas con Hacienda.

Por eso el backend arranca en **`MODO_SIMULACION=true`** por defecto: arma
y (si hay llave) firma el XML, pero nunca lo manda a Hacienda. Así puedes
probar todo el flujo app → backend → XML antes de arriesgar nada real.

## Cómo conseguir tu llave criptográfica (paso a paso)

1. Entra a **TRIBU-CR** (`https://ovitribucr.hacienda.go.cr`), la plataforma
   unificada de Hacienda desde octubre 2025.
2. Si tu negocio ya está inscrito para facturación electrónica, busca la
   opción para descargar/generar tu **llave criptográfica** (archivo `.p12`).
   Si no está inscrito, primero tenés que inscribirte como emisor electrónico.
3. Te van a pedir un PIN/contraseña para el archivo `.p12`. Desde el
   1 de agosto de 2026, las llaves nuevas requieren un PIN de al menos 14
   caracteres con mayúscula, minúscula, número y carácter especial.
4. Guarda el archivo `.p12` en un lugar seguro de tu servidor (nunca en el
   repositorio de código, nunca en el teléfono). Por defecto este proyecto
   lo espera en `./keys/llave.p12`.
5. También necesitas un usuario/contraseña de API para el OAuth de Hacienda
   (distinto de tu usuario normal de ATV) — se solicita también en TRIBU-CR.

## Instalación

Requiere **Node.js 22.5 o superior** (usa el módulo `node:sqlite` integrado,
así evitamos depender de compilación nativa como con `better-sqlite3`, que
suele dar problemas al desplegar en algunos hosts).

```bash
npm install
cp .env.example .env
# Edita .env con tus datos (ver abajo)
npm start
```

Con `MODO_SIMULACION=true` (el valor por defecto) puedes arrancarlo y
probarlo sin llave real ni credenciales de Hacienda — ver la sección de
verificación.

## Variables de entorno (`.env`)

Copia `.env.example` a `.env` y llena:

| Variable | Qué es |
|---|---|
| `PORT` | Puerto donde escucha el backend (por defecto 3001; en Railway lo inyecta el propio hosting) |
| `DB_PATH` | Ruta del archivo SQLite. Vacío en local (usa `./data/organizalo.db`). En un hosting con volumen persistente, apunta ahí, ej. `/data/organizalo.db` |
| `API_AUTH_TOKEN` | Token que la app móvil debe mandar. Invéntate uno largo (`openssl rand -hex 32`) |
| `HACIENDA_ENV` | `sandbox` o `production`. **Empieza siempre en sandbox** |
| `HACIENDA_USERNAME` / `HACIENDA_PASSWORD` | Credenciales de API que Hacienda te dio en TRIBU-CR |
| `CRYPTO_KEY_PATH` | Ruta al archivo `.p12` (por defecto `./keys/llave.p12`) |
| `CRYPTO_KEY_PASSWORD` | El PIN de esa llave |
| `EMISOR_*` | Los datos de tu negocio tal como están inscritos en Hacienda (cédula, nombre, código de actividad económica, ubicación, teléfono, correo) |
| `MODO_SIMULACION` | `true` (recomendado hasta que hayas probado todo) o `false` (envíos reales) |

**Nunca subas `.env` ni el archivo `.p12` a git ni a ningún repositorio.**
El `.gitignore` incluido ya los excluye.

## Verificación local (sin llave real)

```bash
npm run smoke-test
```

Esto levanta el servidor en un puerto de prueba, fuerza `MODO_SIMULACION=true`,
crea una factura de ejemplo, la lista y consulta su estado — todo contra una
base de datos temporal que no toca tus datos reales. Si todo sale bien,
termina con `✅ Smoke test completo`.

## Endpoints

Todos (salvo `/health`) requieren el header:
```
Authorization: Bearer <API_AUTH_TOKEN>
```

### `GET /health`
Estado del backend, sin autenticación. Útil para que la app verifique la
conexión.

### `POST /api/invoices`
Crea una factura electrónica.

```json
{
  "cliente": { "nombre": "Confecciones del Valle SA", "cedula": "3101987654", "correo": "compras@confvalle.cr" },
  "items": [
    { "descripcion": "Tela algodón - rollo 50m", "cantidad": 2, "precioUnitario": 45000, "tarifaIva": 13 }
  ],
  "moneda": "CRC"
}
```

Responde con la factura creada, incluyendo su `clave` (50 dígitos) y
`estado` (`simulado`, `enviado`, etc.).

### `GET /api/invoices`
Lista todas las facturas creadas en este backend.

### `GET /api/invoices/:id/status`
Consulta (y actualiza) el estado de una factura contra Hacienda. En modo
simulación simplemente devuelve el registro tal cual está guardado.

### `GET /api/charla`
Devuelve la información de la próxima charla mensual Premium (fecha, tema,
especialista, bio, link de la reunión). La app la consulta para mostrarla
en `Más → Charla mensual`. Si nunca se ha configurado, devuelve `null`.

### `PUT /api/charla`
Actualiza la sesión del mes — la usas tú (quien organiza la charla) para
subir la fecha, tema, especialista y link de la reunión sin tener que
republicar la app cada vez. Usa el mismo `API_AUTH_TOKEN`; no hay todavía
un rol de administrador separado, así que cualquiera con el token puede
actualizarla — razón de más para no compartir ese token con tus clientes.

```json
{
  "fecha": "2026-09-15T18:00:00",
  "tema": "Cómo cerrar bien el año fiscal",
  "especialista": "Lic. Ana Pérez, CPA",
  "especialistaBio": "Contadora pública, 12 años asesorando PYMEs en Costa Rica.",
  "linkReunion": "https://meet.google.com/abc-defg-hij"
}
```

## Desplegar para que esté siempre disponible (no dependa de tu compu)

Mientras corras esto con `npm start` en tu computadora, la Facturación
electrónica y la Charla mensual solo funcionan mientras esa terminal esté
abierta y tu compu encendida. Para que estén disponibles 24/7, hay que
desplegarlo a un hosting real. Estos pasos son con **Railway**, pero el
mismo proyecto funciona igual en Render, Fly.io o un VPS propio, porque
lee todo de variables de entorno y no tiene nada específico de Railway.

**Punto importante antes de elegir hosting:** este backend guarda las
facturas y la config de la charla en un archivo SQLite (`data/organizalo.db`).
Si el hosting que elijas usa un **disco efímero** (se borra en cada reinicio
o al dormirse por inactividad — es el caso del plan gratis de Render), vas
a perder ese archivo tarde o temprano. Necesitas un hosting con **disco/volumen
persistente**. Railway lo ofrece incluso en su plan más barato.

1. Sube este proyecto a un repositorio propio en GitHub (asegúrate de que
   `.env` y `keys/` estén en `.gitignore` — ya vienen excluidos).
2. En [railway.app](https://railway.app), crea un proyecto nuevo → "Deploy
   from GitHub repo" → selecciona este repositorio. Railway detecta que es
   Node.js automáticamente y usa `npm start` (definido en `package.json`)
   como comando de arranque; también respeta `"engines": {"node": ">=22.5.0"}`
   para instalar la versión correcta de Node.
3. **Agrega un volumen** (Railway → tu servicio → pestaña "Volumes" → "New
   Volume"). Móntalo en, por ejemplo, `/data`. Esto crea un disco que
   sobrevive a reinicios y redeploys.
4. En "Variables", configura las mismas del `.env`, y agrega:
   - `DB_PATH=/data/organizalo.db` (para que la base viva en el volumen que
     acabas de crear, no en el filesystem temporal del contenedor)
   - `PORT` no hace falta ponerlo — Railway lo inyecta solo.
5. La llave `.p12` **no la subas al repo**. Puedes montarla también en el
   volumen (subiéndola una vez por la terminal de Railway o su CLI) y
   apuntar `CRYPTO_KEY_PATH` a esa ruta dentro del volumen.
6. Prueba primero con `HACIENDA_ENV=sandbox` y `MODO_SIMULACION=true`. Pega
   la URL pública que te da Railway (algo como
   `https://tu-backend.up.railway.app`) en un navegador + `/health` para
   confirmar que responde.
7. Cuando estés seguro (XML validado contra el XSD, credenciales de sandbox
   probadas), cambia a `HACIENDA_ENV=production` y `MODO_SIMULACION=false`.
8. En la app móvil, ve a Configuración → "Tu backend" y pon esa URL pública
   junto con el mismo `API_AUTH_TOKEN`. Desde ese momento, Facturación
   electrónica y Charla mensual funcionan sin importar si tu compu está
   prendida o no.

Railway ya no tiene un plan gratis indefinido (cambió en 2023): hoy da un
saldo de prueba de $5 y luego cobra por uso, con un mínimo de referencia de
$5/mes en su plan Hobby — para un backend tan liviano como este, normalmente
se queda muy por debajo de eso.

## Checklist antes de facturar de verdad

- [ ] XML validado con `xmllint` contra el XSD oficial v4.4
- [ ] Un contador o integrador certificado revisó al menos una factura de prueba
- [ ] Probaste el flujo completo en `HACIENDA_ENV=sandbox` primero
- [ ] La llave `.p12` y su PIN están fuera del repositorio de código
- [ ] `API_AUTH_TOKEN` es largo y aleatorio, no un valor de ejemplo
- [ ] Tienes forma de respaldar la base SQLite (contiene tu historial de facturas y el consecutivo — **nunca debe reiniciarse ni repetir un número ya usado**), y si desplegaste en un hosting, `DB_PATH` apunta a un volumen persistente y no al filesystem temporal del contenedor
- [ ] Revisaste avisos vigentes de Hacienda en https://www.hacienda.go.cr/AvisosTRIBU-CR.html

## Licencia y dependencias de terceros

- [`haciendacostarica-signer`](https://github.com/aazcast/haciendacostarica-signer) — MIT, comunidad CR. Hace la firma XAdES-EPES.
- El resto de dependencias (`express`, `cors`, `dotenv`, `uuid`, `node-fetch`) son estándar de Node.js.
