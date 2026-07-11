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

### Radar IA (`/radar-ia`, `lib/radar/*`, `radar-worker/`)

Módulo independiente que monitorea grupos de WhatsApp con un worker externo (`radar-worker/`, Baileys — cliente **no oficial**; usa un número dedicado, jamás los números de la integración Meta oficial). El worker mantiene la sesión (QR una sola vez, credenciales en `radar-worker/auth/`), escribe crudo en tablas `radar_*` (`supabase/radar-ia.sql`) + bucket `radar-media`, y dispara `POST /api/radar/procesar` (Bearer `RADAR_WORKER_SECRET`; el `GET` es cron cada 15 min con `CRON_SECRET`). El pipeline (`lib/radar/motor.ts`) hace triage con Haiku, extrae con el modelo configurado (visión para fotos/PDFs de vouchers) y ejecuta acciones por categoría (`lib/radar/acciones.ts`): oportunidades → `radar_oportunidades` (+disponibilidad/tarifario), combustible sin anomalías → inserta en `combustible` + odómetro, resto → `radar_alertas`. Config en `radar_config` (fila única). El dashboard `app/radar-ia/page.tsx` (módulo `radar-ia`) lee las tablas directo con RLS. `radar-worker/` es un proyecto Node aparte, excluido del tsconfig raíz — no lo importa nada del ERP.

### Conventions

- `@/*` in `tsconfig.json` resolves to the repo root, so `@/lib/supabase` ≡ `lib/supabase.ts`.
- Almost every page is a Client Component (`"use client"`) that fetches Supabase directly. Server Components are rare; don't refactor a page to a Server Component without rechecking the auth/permission flow above.
- Date handling assumes Peru (UTC-5). Don't rely on `new Date().toISOString()` for "today" — see `getFechaLocal()` in `app/conductor/page.tsx` and the Lima offset math in `app/api/notificaciones/recordatorio/route.ts`.
- CSV/Excel parsing for paradas/manifiesto goes through `lib/paradas-csv.ts`, `lib/manifiesto-csv.ts`, and `lib/manifiesto-unificado-csv.ts` (uses `xlsx`).
- Maps: Mapbox GL for in-app rendering, Google Directions for routing — coordinate order is `[lng, lat]` end-to-end (Mapbox convention) once it leaves `/api/ruta`.
