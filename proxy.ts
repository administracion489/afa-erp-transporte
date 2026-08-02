// proxy.ts
// Gate de sesión a nivel de red. En Next 16 esta convención se llama `proxy` (antes
// `middleware`) y el archivo DEBE vivir en la raíz del proyecto, al mismo nivel que `app/`.
// Estuvo en app/middleware.ts, ruta que Next no lee, así que nunca se ejecutó.
//
// Igual que antes, es un gate GRUESO: solo mira si existe alguna cookie `sb-`, no valida la
// sesión. La autorización real (rol, activo, permisos_usuario por módulo) sigue estando en
// app/layout.tsx.
//
// `/api/*` queda FUERA del matcher a propósito. Nada en /api ha estado nunca detrás de este
// gate, y meterlo ahora rompería a todos los llamadores que no mandan cookies de navegador:
//   - los 7 crons de vercel.json (recordatorio, gmail/sync, alertas, campanas, comunicados,
//     radar/procesar, alertas-flota/tick)
//   - el webhook de Meta/WhatsApp (/api/crm/webhook/meta), que llama Meta desde fuera
//   - radar-worker/, que es un proceso Node aparte
//   - la app Android del conductor (Capacitor usa CapacitorHttp nativo, sin las cookies del
//     WebView), y las páginas públicas /pasajero, /cliente, /seguimiento/[token] y
//     /conductor-tercero/[token]
// Además, un gate por cookie sobre /api devolvería un 307 con HTML a POSTs que esperan JSON,
// que falla de forma mucho más confusa que un 401.
// Cada route handler se autoriza a sí mismo: `x-afa-key` en /api/conductor-paradas, token de
// portal en /api/cliente, CRON_SECRET en los crons, y lib/api-guard.ts en los que gastan
// cuota de Google. Es la recomendación explícita del doc de Next 16 (proxy.md, "Execution
// order"): verificar autenticación dentro de cada handler y no depender solo del proxy.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isLogin = pathname === "/login";

  // Debe reflejar la lista `esPublica` de app/layout.tsx. Si se agrega una página pública
  // nueva, va en los dos sitios o queda inalcanzable sin sesión.
  const isPublica =
    pathname === "/conductor"         || pathname.startsWith("/conductor/") ||
    pathname === "/lector"            || pathname.startsWith("/lector/") ||
    pathname === "/pasajero"          || pathname.startsWith("/pasajero/") ||
    pathname === "/cliente"           || pathname.startsWith("/cliente/") ||
    pathname === "/registro"          || pathname.startsWith("/registro/") ||
    pathname === "/manuales"          || pathname.startsWith("/manuales/") ||
    pathname === "/privacidad"        || pathname.startsWith("/privacidad/") ||
    // Página estática para conectar el número de WhatsApp vía Embedded Signup de Meta
    pathname.startsWith("/conectar-whatsapp") ||
    // /seguimiento/[token] es público — /seguimiento (ERP) queda protegido
    pathname.startsWith("/seguimiento/") ||
    // /conductor-tercero/[token] es público — no hay ruta ERP en la raíz
    pathname === "/conductor-tercero" || pathname.startsWith("/conductor-tercero/") ||
    // Mismo trato que en app/layout.tsx: las pantallas de /dev solo son públicas fuera de prod
    (process.env.NODE_ENV !== "production" && pathname.startsWith("/dev"));

  const hasSession = request.cookies
    .getAll()
    .some((cookie) => cookie.name.includes("sb-"));

  if (!hasSession && !isLogin && !isPublica) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (hasSession && isLogin) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Excluidos: /api (se autoriza cada handler), estáticos de Next, y los assets que
    // registran las PWA de conductor y pasajero — sw.js y manifest.webmanifest se piden sin
    // cookies y un redirect a /login rompe serviceWorker.register() y la instalación.
    "/((?!api|_next/static|_next/image|favicon.ico|logoafa.png|sw\\.js|manifest\\.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
