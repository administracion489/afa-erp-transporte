import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isLogin = pathname === "/login";

  const isPublica =
    pathname === "/conductor"         || pathname.startsWith("/conductor/") ||
    pathname === "/lector"            || pathname.startsWith("/lector/") ||
    pathname === "/pasajero"          || pathname.startsWith("/pasajero/") ||
    pathname === "/privacidad"        || pathname.startsWith("/privacidad/") ||
    // /seguimiento/[token] es público — /seguimiento (ERP) queda protegido
    pathname.startsWith("/seguimiento/") ||
    // API pública para el link de seguimiento del pasajero
    pathname.startsWith("/api/seguimiento") ||
    // /conductor-tercero/[token] es público — no hay ruta ERP en la raíz
    pathname === "/conductor-tercero" || pathname.startsWith("/conductor-tercero/") ||
    // APIs que llama la app del conductor tercero (sin sesión ERP)
    pathname.startsWith("/api/conductor-tercero/");

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
    "/((?!_next/static|_next/image|favicon.ico|logoafa.png|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};