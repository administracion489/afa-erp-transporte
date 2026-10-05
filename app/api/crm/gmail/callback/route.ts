import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { exchangeCode, leerStateGmail } from "@/lib/crm-gmail";
import { guardarConexionFacturas } from "@/lib/combustible/gmail-facturas";

// GET /api/crm/gmail/callback — Google redirige aquí con el code.
//
// Es el ÚNICO redirect registrado en Google Cloud, así que sirve a los DOS buzones que conecta el
// ERP: el del CRM (lee y envía) y el correo de FACTURAS de /combustible (solo lee). A cuál va lo
// dice el `state` firmado, nunca un parámetro suelto. Por eso el `state` se lee PRIMERO: incluso
// cuando la persona cancela en Google, tiene que volver a la pantalla desde la que salió.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  const st = leerStateGmail(req.nextUrl.searchParams.get("state"));

  // Sin un `state` firmado por el ERP (y vigente) NO se canjea el code: si no, un enlace
  // preparado conectaría la bandeja de otra persona.
  if (!st) {
    return NextResponse.redirect(new URL("/crm?gmail_error=state_invalido", req.url));
  }

  if (st.destino === "facturas") {
    const volver = (q: string) => NextResponse.redirect(new URL(`/combustible?vista=facturas&${q}`, req.url));
    if (error || !code) return volver(`correo_error=${encodeURIComponent(error ?? "sin_code")}`);
    try {
      const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { email } = await guardarConexionFacturas(sb, code);
      return volver(`correo=ok${email ? `&correo_email=${encodeURIComponent(email)}` : ""}`);
    } catch (e: any) {
      return volver(`correo_error=${encodeURIComponent(e.message)}`);
    }
  }

  if (error || !code) {
    return NextResponse.redirect(
      new URL(`/crm?gmail_error=${error ?? "sin_code"}`, req.url)
    );
  }

  try {
    await exchangeCode(code);
    return NextResponse.redirect(new URL("/crm?gmail_ok=1", req.url));
  } catch (e: any) {
    return NextResponse.redirect(
      new URL(`/crm?gmail_error=${encodeURIComponent(e.message)}`, req.url)
    );
  }
}
