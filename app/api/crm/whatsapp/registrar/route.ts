// Registro de un número de WhatsApp recién conectado.
// Lo llama el modal "Conectar WhatsApp" del CRM cuando el Embedded Signup de Meta
// termina: ese evento trae phone_number_id y waba_id, que es justo lo que hace falta
// para poder ENVIAR por ese número. Sin este paso el número recibiría mensajes (el
// webhook es a nivel de WABA) pero no se podría contestar desde él.
//
// El alias y el display_phone_number se piden a Meta, porque el evento no siempre los
// incluye. Si esa consulta falla igual se guarda la fila: el id es lo imprescindible.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { invalidarCacheNumeros } from "@/lib/whatsapp-numeros";

const GRAPH = "https://graph.facebook.com/v25.0";

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "crm");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { phone_number_id, waba_id, alias } = await req.json().catch(() => ({}) as any);
  if (!phone_number_id) {
    return NextResponse.json({ error: "phone_number_id requerido" }, { status: 400 });
  }

  // Datos del número en Meta: display_phone_number y verified_name (el nombre que ve
  // el cliente). Best-effort — un token sin permiso sobre ese número no debe impedir
  // el registro, sólo deja las columnas en null para completarlas después.
  let display: string | null = null;
  let nombreMeta: string | null = null;
  const token = process.env.META_WA_TOKEN;
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

  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  // display_phone_number también es UNIQUE, así que un upsert por phone_number_id no
  // basta: si el mismo número físico se reconecta y Meta le da otro phone_number_id,
  // el upsert intenta INSERTAR y choca contra ese otro índice con un error críptico.
  // Por eso se busca antes por cualquiera de las dos claves.
  const { data: existente } = await db
    .from("whatsapp_numeros")
    .select("*")
    .or(
      display
        ? `phone_number_id.eq.${phone_number_id},display_phone_number.eq.${display}`
        : `phone_number_id.eq.${phone_number_id}`,
    )
    .maybeSingle();

  // Sin usos a propósito: activarlos aquí desplazaría al número que hoy cumple ese
  // papel y cambiaría en silencio por dónde salen los mensajes. Se asignan a mano.
  // `activo` NO se fuerza al actualizar: si alguien dio de baja un número, reconectarlo
  // no debe revivirlo con sus usos intactos (y el índice único parcial daría un 500).
  const fila = {
    phone_number_id: String(phone_number_id),
    display_phone_number: display,
    waba_id: waba_id ? String(waba_id) : existente?.waba_id ?? null,
    alias: (alias || nombreMeta || existente?.alias || display || "Número nuevo").toString().slice(0, 60),
    updated_at: new Date().toISOString(),
  };

  const q = existente
    ? db.from("whatsapp_numeros").update(fila).eq("id", existente.id)
    : db.from("whatsapp_numeros").insert({ ...fila, activo: true });

  const { data, error } = await q.select().single();

  if (error) {
    return NextResponse.json(
      { error: `No se pudo registrar: ${error.message}. ¿Corriste supabase/whatsapp-numeros.sql?` },
      { status: 500 },
    );
  }

  invalidarCacheNumeros();
  return NextResponse.json({ ok: true, numero: data });
}
