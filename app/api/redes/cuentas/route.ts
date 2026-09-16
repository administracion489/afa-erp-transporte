// app/api/redes/cuentas/route.ts
// Conectar y consultar las cuentas de publicación.
//
// TODO PASA POR AQUÍ Y NUNCA POR EL NAVEGADOR. `redes_cuentas` guarda tokens con los
// que se puede escribir en la cara pública de la empresa, y la tabla está con RLS
// activo y SIN política permisiva: la clave anónima no lee ni una fila. El GET devuelve
// nombre y estado, jamás el token — la pantalla necesita saber qué hay conectado, no
// con qué credencial.
//
// EL FLUJO DE CONEXIÓN NO ES EL MISMO EN LAS CUATRO PLATAFORMAS, y el ERP no lo esconde:
//   • Facebook / Instagram → un TOKEN DE PÁGINA de larga duración, que se saca del
//     Explorador de la API de Meta y se pega aquí. Es lo mismo que ya se hace para el
//     CRM, así que no se monta un OAuth nuevo para dos cuentas propias.
//   • YouTube / TikTok     → un REFRESH TOKEN, que sale de su OAuth. Se pega igual.
// Montar el OAuth completo de las cuatro es trabajo de portal (dominios verificados,
// pantallas de consentimiento, auditorías) que NO depende de este código y que además
// hay que hacer una sola vez por empresa. Pegar el token es honesto: dice exactamente
// lo que hace falta y no finge un botón que hoy no puede funcionar.

import { NextRequest, NextResponse } from "next/server";
import { cuentasParaPantalla, guardarCuenta } from "@/lib/redes/cuentas";
import { REDES, type Red } from "@/lib/redes/tipos";
import { verificarUsuarioApi } from "@/lib/api-auth";

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "redes");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    return NextResponse.json({ cuentas: await cuentasParaPantalla() });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "redes");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const body = await req.json();
    const red = body?.red as Red;
    if (!REDES.includes(red)) {
      return NextResponse.json({ error: `Red desconocida: ${red}` }, { status: 400 });
    }

    // El estado de WhatsApp no lleva token: su «credencial» es a quién se le manda la
    // pieza. Pedirle un token sería pedir algo que no existe.
    if (red === "whatsapp_estado") {
      const tel = String(body?.destino_telefono ?? "").replace(/[^\d+]/g, "");
      if (!tel) {
        return NextResponse.json(
          { error: "Indica el número (con código de país) al que se le manda la pieza del estado." },
          { status: 400 },
        );
      }
      const r = await guardarCuenta({
        red,
        nombre_cuenta: body?.nombre_cuenta ?? null,
        destino_telefono: tel,
      });
      return NextResponse.json(r, { status: r.ok ? 200 : 400 });
    }

    const r = await guardarCuenta({
      red,
      nombre_cuenta: body?.nombre_cuenta ?? null,
      cuenta_externa_id: String(body?.cuenta_externa_id ?? "").trim() || null,
      token: body?.token ? String(body.token).trim() : null,
      refresh: body?.refresh ? String(body.refresh).trim() : null,
      token_expira_en: body?.token_expira_en ?? null,
    });
    return NextResponse.json(r, { status: r.ok ? 200 : 400 });
  } catch (e: any) {
    console.error("[redes/cuentas]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
