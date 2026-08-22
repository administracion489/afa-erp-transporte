# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

- `npm run dev` — start Next.js dev server (the script uses Windows `set NODE_OPTIONS=…` syntax; on POSIX shells run `NODE_OPTIONS=--max-old-space-size=8192 next dev` instead).
- `npm run build` / `npm start` — production build / serve.
- `npm run lint` — ESLint via `eslint-config-next` (core-web-vitals + typescript). No test runner is configured.
- `next.config.ts` sets `typescript.ignoreBuildErrors: true`, so `next build` will not catch type errors — run `npx tsc --noEmit` if you need a real type check.

## High-level architecture

ERP interno (Spanish-language UI) para AFA Transportes (operador de transporte en Perú). Next.js App Router + Supabase Auth/Postgres + Tailwind v4. UI strings, DB columns, and route segments are in Spanish — keep that convention.

### Auth & authorization (two layers, both required)

1. **Edge middleware** (`app/middleware.ts`) — only checks whether *any* cookie name contains `sb-`. If absent → redirect to `/login`. If present on `/login` → redirect to `/dashboard`. This is a coarse gate; it does not validate the session.
2. **Root layout** (`app/layout.tsx`, `"use client"`) — the real gate. On every navigation it:
   - calls `supabase.auth.getSession()`,
   - reads `usuarios` row (`nombre`, `rol`, `activo`) — inactive users are signed out,
   - reads `permisos_usuario` rows for that user (`modulo`, `permitido`); `rol === "admin"` gets every `modulo` in the menu,
   - if the current route's `modulo` is not in the user's permission list → redirect to `/dashboard`.

The sidebar/menu is defined in `app/layout.tsx` as `menuGrupos`. **Each route must be registered there with a `modulo` key** or it will be invisible to non-admin users. The `modulo` string is what gets checked against the `permisos_usuario` table.

**Public routes that bypass the layout chrome:** `/login` and anything under `/conductor` (the driver-facing app, which uses its own `localStorage` PIN session — see `app/conductor/page.tsx` `SK = "afa_cond_v2"`). Add new public paths to the `esLogin`/`esPublica` checks in `RootLayout` if needed.

For client pages that need a finer-grained guard, use `lib/usePermiso.ts` (`usePermiso("modulo")` → `{ validando, permitido }`).

### Supabase clients

- `lib/supabase.ts` — browser client using `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Typed as `any`. Use this from `"use client"` components.
- Server-side / privileged work must create its own admin client inline with `SUPABASE_SERVICE_ROLE_KEY` (see `app/api/crear-usuario/route.ts`, `app/api/notificaciones/recordatorio/route.ts`, `lib/notificaciones.ts`). The service-role key must never reach the client bundle.

The actual data model lives in Supabase (Postgres). Tables referenced across the app include: `usuarios`, `permisos_usuario`, `reservas`, `paradas`, `pasajeros`, `pasajeros_parada`, `conductores`, `vehiculos`, `vehiculos_tercero`, `empresas_tercerizadas`, `notificaciones_enviadas`. Prisma is installed but `prisma/schema.prisma` only declares a stale `Cliente` model — **don't treat Prisma as the source of truth**; query Supabase directly.

### API routes (`app/api/*`)

- `POST /api/crear-usuario` — admin-only user provisioning. Verifies the caller's bearer token, confirms `rol === "admin"`, then uses the service-role client to create the auth user, upsert `usuarios`, and seed `permisos_usuario`. The `MODULOS` constant here is independent of `menuGrupos` in the layout — if you add a new module, update both.
- `POST /api/ruta` — Google Directions proxy. Reads `GOOGLE_MAPS_API_KEY` (or `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` as fallback). Returns Mapbox-style `[lng, lat]` coordinates from a decoded polyline plus per-leg distance/duration with traffic.
- `GET /api/notificaciones/recordatorio` — Vercel cron target (`vercel.json` → `0 13 * * *` UTC = 08:00 Lima). Protected by `CRON_SECRET` bearer if set. Finds reservas for "tomorrow Peru-time", dedupes against `notificaciones_enviadas` rows already logged today with `trigger_origen = "cron_recordatorio"`, and calls `notificarReserva()` per reserva.
- `POST /api/notificaciones/sincronizar` — manual trigger for the same notification flow.

### Notification pipeline (`lib/notificaciones.ts`)

`notificarReserva(reservaId, trigger)` is the single entry point. Per pasajero it tries channels in order: **Email (Resend) → WhatsApp (Twilio) → SMS (Twilio fallback, only when no email and WhatsApp failed)**. Every attempt — including `sin_canal` — is logged to `notificaciones_enviadas`; the cron uses that table to dedupe. Phone numbers are normalized to E.164 assuming Peru (`+51`). Env vars: `RESEND_API_KEY`, `RESEND_FROM`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `TWILIO_SMS_FROM`, `EMPRESA_NOMBRE`.

### Finanzas · control de gastos, caja chica y CxP (fase 06)

`supabase/finanzas-06-gastos-caja-chica.sql` implementa el "Plan Maestro de Arquitectura Financiera". **Antes de tocar nada de dinero, lee la regla de oro declarada en `finanzas-00-fundacion.sql` (líneas 22-24): cada monto tiene UNA fila autoritativa; el resto la referencia por FK y la DERIVA.** Casi todas las decisiones raras de este módulo salen de ahí:

- **No existe la tabla `cuentas_por_pagar`.** La CxP es `documentos_compra` (el comprobante es la fuente única del monto y su saldo se deriva de `pagos_aplicacion`). La fase 06 le agregó el eje **operativo** que le faltaba —`vehiculo_placa`, `codigo_servicio` (formato OSLO), `detalle_servicio`, `turno`, `fecha_servicio`, `adelanto_1/2`, `nro_operacion_bancaria`, `voucher_url`— y un eje de **aprobación** (`estado_aprobacion`: pendiente → aprobado_gerencia → incluido_lote / rechazado) **ortogonal** a `estado_pago` (impaga|parcial|pagada) y a `estado_conciliacion` (fiscal). No los mezcles. La vista `v_cuentas_por_pagar` publica todo eso con la forma que pide el plan.
- **Caja chica son TRES tablas**, no un `comprobantes_json`: `caja_chica_fondos` (la bolsa por persona) → `caja_chica_rendiciones` (el ciclo entrega→gastos→devolución) → `caja_chica_gastos` (un comprobante por fila). Así se filtra por categoría, se suma por vehículo, se ata a una reserva y entra a `v_egresos`.
- **`monto_rendido` y `saldo_pendiente` NO se guardan**: se derivan en `v_caja_chica_rendiciones`. Lista siempre desde la vista, nunca desde la tabla.
- **La regla "no se entrega dinero a quien no ha rendido" vive en Postgres**: `fn_caja_chica_puede_asignar(fondo_id)` devuelve `(puede, motivo, …)`. `lib/finanzas/caja-chica.ts` la envuelve en `puedeAsignar()`. El índice único parcial `uq_cc_rend_abierta` es la última línea de defensa. No repliques la regla en el cliente.
- **Promoción a `gastos`**: un comprobante aprobado puede promoverse al libro `gastos` (`promoverGastos`). En cuanto tiene `gasto_id`, `v_egresos` deja de contarlo por el lado de caja chica (filtra `gasto_id is null`). Nunca se cuenta dos veces.

**Enganche gasto → servicio ejecutado y liquidado** (lo que antes no existía): `combustible` y `mantenimiento` recibieron `reserva_id` — antes `v_egresos` los inyectaba con `null::int` hardcodeado, así que un servicio propio no tenía costo real. `neumaticos` **a propósito** no lo tiene (es costo de vehículo, se amortiza por km). `v_costo_servicio` cruza ingreso vs. costo real directo por reserva con su estado de las tres dimensiones de `lib/estados.ts`. `v_egresos` ahora incluye además neumáticos, caja chica y gastos generales: era la razón por la que `/gastos` y `/finanzas` daban totales distintos.

**Conciliación bancaria · "Regla Cero Fugas"** (`lib/finanzas/conciliacion.ts`): `extractos_bancarios` + `extractos_bancarios_movimientos` con `hash_fila` único, para que re-subir un rango solapado no duplique. El casado por **nº de operación** se auto-concilia (confianza 1.00); el casado por **importe+fecha** solo se PROPONE y lo confirma un humano — dos servicios del mismo precio el mismo día son la norma en transporte, no la excepción. `v_fugas_bancarias` lista los cargos que el ERP no sabe justificar.

**Lotes de pago** (`lib/finanzas/lotes.ts`): agrupan obligaciones aprobadas en un archivo de abono. Al confirmar el pago se emite **un `pago` por línea** con su aplicación, para que el saldo se siga derivando de `pagos_aplicacion` y no de un flag puesto a mano. El formato del archivo Telecrédito es un CSV genérico: **AFA debe cotejarlo una vez contra su convenio con el BCP** antes de usarlo en producción.

**Importar y exportar ("subir y bajar" los Google Sheets)**:
- `lib/importador/tabular.ts` es el núcleo compartido que reemplaza los **cuatro** normalizadores de cabecera incompatibles que había (`paradas-csv`, `manifiesto-csv`, `manifiesto-unificado-csv`, `portal-usuarios-csv`). Trae lo que faltaba por completo: `parsearFecha` entiende el **serial de Excel** (45000 → fecha) y `parsearMonto` entiende `"S/ 1,234.56"`, `"1.234,56"` y `"(500.00)"`. Nunca devuelven 0 en silencio.
- Los formatos se declaran como **perfiles** (`lib/importador/perfiles-finanzas.ts`: CxP OSLO, CxP tradicional, planilla, caja chica, extracto BCP). `detectarPerfil` puntúa las cabeceras y elige; si ninguna calza, la UI ofrece **mapeo manual** columna→campo en vez de abortar el archivo.
- Se puede importar desde un archivo o pegando el **enlace de un Google Sheet público** (`descargarGoogleSheet`, sin credenciales: la hoja debe estar compartida como "cualquiera con el enlace · lector"). No hay integración con la API de Sheets y `google-auth-library` solo firma el JWT de FCM.
- `lib/finanzas/exportar.ts` es el lado espejo: `exportarXlsx` genera con **las mismas cabeceras que reconoce el importador**, para que el ciclo cierre. También `descargarPlantilla` y `descargarRechazos` (las filas rechazadas con su motivo, para corregir en Sheets y re-subir).
- `POST /api/finanzas/importar` — el navegador parsea y manda las filas ya validadas; el servidor resuelve referencias (proveedor por RUC, vehículo por placa), deduplica y escribe con service-role. Solo `admin`/`gerente`. Cada corrida queda en `importaciones_finanzas` con los ids creados, y `DELETE ?id=N` la deshace.

**Rol `gerente`**: aprueba gasto (CxP, planilla, lotes, rendiciones) sin ser administrador del sistema. Sigue sujeto a `permisos_usuario` por módulo como cualquier operador — solo `admin` recibe todos los módulos en memoria. En SQL, `fn_es_aprobador(uid)`.

Módulos nuevos del menú: **`tesoreria`** (`/tesoreria` — CxP · Planilla · Detracciones · Lotes · Conciliación) y **`caja-chica`** (`/caja-chica` — Rendiciones · Por revisar · Fondos). Recuerda que hay **TRES** listas de módulos que sincronizar, no dos: `menuGrupos` en `app/layout.tsx`, `MODULOS` en `app/api/crear-usuario/route.ts` y `GRUPOS_MODULOS` + `nombresModulo` en `app/usuarios/page.tsx`.

El bucket de Storage **`comprobantes` es PRIVADO** (un ticket de peaje trae placa y ubicación). `caja_chica_gastos.foto_url` guarda la **ruta dentro del bucket**, no una URL pública: se lee con `createSignedUrl`, nunca con `getPublicUrl`.

### Radar IA (`/radar-ia`, `lib/radar/*`, `radar-worker/`)

Módulo independiente que monitorea grupos de WhatsApp con un worker externo (`radar-worker/`, Baileys — cliente **no oficial**; usa un número dedicado, jamás los números de la integración Meta oficial). El worker mantiene la sesión (QR una sola vez, credenciales en `radar-worker/auth/`), escribe crudo en tablas `radar_*` (`supabase/radar-ia.sql`) + bucket `radar-media`, y dispara `POST /api/radar/procesar` (Bearer `RADAR_WORKER_SECRET`; el `GET` es cron cada 15 min con `CRON_SECRET`). El pipeline (`lib/radar/motor.ts`) hace triage con Haiku, extrae con el modelo configurado (visión para fotos/PDFs de vouchers) y ejecuta acciones por categoría (`lib/radar/acciones.ts`): oportunidades → `radar_oportunidades` (+disponibilidad/tarifario), combustible sin anomalías → inserta en `combustible` + odómetro, resto → `radar_alertas`. Config en `radar_config` (fila única). El dashboard `app/radar-ia/page.tsx` (módulo `radar-ia`) lee las tablas directo con RLS. `radar-worker/` es un proyecto Node aparte, excluido del tsconfig raíz — no lo importa nada del ERP.

**El "servidor que mantiene WhatsApp abierto" es `radar-worker` corriendo 24/7 bajo `pm2`** (no es un servicio de terceros). Es lo único que sostiene la sesión de WhatsApp del Radar IA: si se cae, dejan de entrar mensajes. Arranque y detalles en `radar-worker/README.md` → sección "Correr 24/7":

```bash
npm install -g pm2
cd radar-worker && npm install
pm2 start node_modules/tsx/dist/cli.mjs --name radar-worker -- src/index.ts
pm2 save
```

**Dónde corre hoy:** droplet de DigitalOcean `ubuntu-s-1vcpu-512mb-10gb-tor1` (proyecto "first-project", IP `167.99.182.128`), en `/root/radar-worker`. Acceso sin SSH desde el panel: DigitalOcean → Droplets → el droplet → **Web Console**.

`pm2 list` / `pm2 logs radar-worker` / `pm2 restart radar-worker` para operarlo. Arranque automático: Windows → `npm i -g pm2-windows-startup && pm2-startup install`; Linux/VPS → `pm2 startup`. La sesión vive en `radar-worker/auth/` (respaldarla permite mover el worker de máquina sin re-escanear el QR). Para saber si está vivo sin acceso a la máquina: revisar `ultimo_latido` en la fila única de `radar_estado` en Supabase, o el chip de conexión en `/radar-ia`. **Ese chip es un botón**: abre `ModalServidor` (en `app/radar-ia/page.tsx`), la referencia de fácil acceso con el estado actual, los comandos pm2 copiables y qué hacer si se cae — mantenerlo sincronizado con esta sección y con `radar-worker/README.md`.

### Conventions

- `@/*` in `tsconfig.json` resolves to the repo root, so `@/lib/supabase` ≡ `lib/supabase.ts`.
- Almost every page is a Client Component (`"use client"`) that fetches Supabase directly. Server Components are rare; don't refactor a page to a Server Component without rechecking the auth/permission flow above.
- Date handling assumes Peru (UTC-5). Don't rely on `new Date().toISOString()` for "today" — see `getFechaLocal()` in `app/conductor/page.tsx` and the Lima offset math in `app/api/notificaciones/recordatorio/route.ts`.
- CSV/Excel parsing for paradas/manifiesto goes through `lib/paradas-csv.ts`, `lib/manifiesto-csv.ts`, and `lib/manifiesto-unificado-csv.ts` (uses `xlsx`).
- Maps: Mapbox GL for in-app rendering, Google Directions for routing — coordinate order is `[lng, lat]` end-to-end (Mapbox convention) once it leaves `/api/ruta`.
