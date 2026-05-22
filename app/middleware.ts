import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isLogin = pathname === "/login";

  const isPublica =
    pathname === "/conductor" || pathname.startsWith("/conductor/") ||
    pathname === "/lector"    || pathname.startsWith("/lector/") ||
    pathname === "/pasajero"  || pathname.startsWith("/pasajero/");

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