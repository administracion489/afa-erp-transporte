// proxy.ts
// En Next 16 esta convención se llama `proxy` (antes `middleware`) y el archivo DEBE vivir en
// la raíz del proyecto, al mismo nivel que `app/`. Estuvo en app/middleware.ts, ruta que Next
// no lee, así que ese gate nunca se ejecutó.
//
// Hoy este proxy NO bloquea nada, a propósito. El gate por cookie `sb-` que vivía aquí es
// incompatible con cómo se guarda la sesión: lib/supabase.ts usa `createClient` de
// @supabase/supabase-js con su storage por defecto, que persiste en localStorage y nunca
// escribe una cookie. El resultado era que un login correcto rebotaba a /login sin mensaje
// de error: signInWithPassword() tenía éxito, router.replace("/dashboard") disparaba este
// proxy, no había cookie `sb-` y redirigía de vuelta.
//
// Para que un gate de red vuelva a tener sentido hay que migrar el cliente a @supabase/ssr
// (createBrowserClient, que sí sincroniza la sesión en cookies). Mientras tanto la
// autorización real vive donde siempre: app/layout.tsx valida sesión, `activo`, rol y
// permisos_usuario por módulo, y cada route handler de /api se autoriza por su cuenta
// (x-afa-key, token de portal, CRON_SECRET, lib/api-guard.ts).

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(_request: NextRequest) {
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
