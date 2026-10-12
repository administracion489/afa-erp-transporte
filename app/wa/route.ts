// app/wa/route.ts
// Puente a un chat de WhatsApp para los botones de las plantillas de Meta.
//
// Meta RECHAZA en los botones de plantilla los enlaces directos a WhatsApp (wa.me,
// api.whatsapp.com): «No se permiten los enlaces directos a WhatsApp para los botones».
// El botón apunta entonces a esta ruta del dominio propio, que redirige al chat.
//
// El número viaja en la URL (`/wa?n=51922775131&t=Hola`) y no en el código ni en una
// variable de entorno: este ERP se vende, y cada plantilla elige a qué número manda.
// Solo redirige a wa.me —el destino es fijo—, así que no es un redirect abierto: lo único
// que controla quien arma el enlace son los dígitos del número y el texto prellenado.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function GET(req: NextRequest) {
  const n = (req.nextUrl.searchParams.get("n") ?? "").replace(/\D/g, "");
  if (n.length < 8 || n.length > 15) {
    return new NextResponse("Número de WhatsApp no válido.", { status: 400 });
  }
  const t = (req.nextUrl.searchParams.get("t") ?? "").slice(0, 500);
  const destino = `https://wa.me/${n}${t ? `?text=${encodeURIComponent(t)}` : ""}`;
  return NextResponse.redirect(destino, 302);
}
