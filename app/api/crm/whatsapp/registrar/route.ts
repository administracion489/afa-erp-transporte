// Registro de un número de WhatsApp recién conectado.
//
// Alta MÍNIMA: guarda phone_number_id y waba_id para poder ENVIAR por ese número.
// Es la red de seguridad de /api/crm/whatsapp/activar — si el canje del código
// falla (típicamente porque venció: dura 30 s), al menos el número queda anotado
// y se le puede completar la activación después.
//
// El alias y el display_phone_number se piden a Meta, porque el evento del
// Embedded Signup no siempre los incluye. Si esa consulta falla igual se guarda la
// fila: el id es lo imprescindible.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { registrarNumero } from "@/lib/whatsapp-registro";
import { tokenParaNumero } from "@/lib/meta-tokens";

const GRAPH = "https://graph.facebook.com/v25.0";

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "crm");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { phone_number_id, waba_id, alias } = await req.json().catch(() => ({}) as any);
  if (!phone_number_id) {
    return NextResponse.json({ error: "phone_number_id requerido" }, { status: 400 });
  }

  // Datos del número en Meta: display_phone_number y verified_name (el nombre que
  // ve el cliente). Best-effort — un token sin permiso sobre ese número no debe
  // impedir el registro, solo deja las columnas en null para completarlas después.
  let display: string | null = null;
  let nombreMeta: string | null = null;
  const token = await tokenParaNumero(String(phone_number_id));
  if (token) {
    try {
      const r = await fetch(
        `${GRAPH}/${phone_number_id}?fields=display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
      );
      const d = await r.json();
      if (r.ok) {
        // Meta lo devuelve como "+51 966 707 225"; el webhook lo manda como
        // "51966707225". Se normaliza a la forma del webhook para poder cruzarlos.
        display = d.display_phone_number ? String(d.display_phone_number).replace(/\D/g, "") : null;
        nombreMeta = d.verified_name ?? null;
      }
    } catch {
      /* se registra igual */
    }
  }

  const resultado = await registrarNumero({
    phone_number_id: String(phone_number_id),
    waba_id: waba_id ?? null,
    alias: alias || nombreMeta || null,
    display_phone_number: display,
  });

  if (!resultado.ok) {
    return NextResponse.json({ error: resultado.error }, { status: 500 });
  }

  return NextResponse.json({ ok: true, numero: resultado.numero });
}
