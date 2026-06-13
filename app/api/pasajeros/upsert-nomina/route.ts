import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supaAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/** POST /api/pasajeros/upsert-nomina
 *  body: { clienteId, pasajeros: [{nombre,dni,telefono,empresa,email}] }
 *  Upsert bulk — service role bypasses RLS
 */
export async function POST(req: NextRequest) {
  const { clienteId, pasajeros } = await req.json();
  if (!clienteId || !Array.isArray(pasajeros) || pasajeros.length === 0)
    return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });

  const { data: existing, error: selErr } = await supaAdmin
    .from("pasajeros")
    .select("id, dni")
    .eq("cliente_id", clienteId)
    .is("reserva_id", null);

  if (selErr)
    return NextResponse.json({ error: selErr.message }, { status: 500 });

  const existingMap = new Map<string, number>(
    (existing || []).map((p: any) => [String(p.dni), p.id]),
  );

  let insertados = 0, actualizados = 0, errores = 0;
  const mensajesError: string[] = [];

  for (const p of pasajeros) {
    const id = existingMap.get(String(p.dni));
    if (id) {
      const campos: Record<string, any> = { nombre: p.nombre };
      if (p.email)    campos.email    = p.email;
      if (p.telefono) campos.telefono = p.telefono;
      if (p.empresa)  campos.empresa  = p.empresa;
      const { error } = await supaAdmin.from("pasajeros").update(campos).eq("id", id);
      if (error) { errores++; mensajesError.push(error.message); } else actualizados++;
    } else {
      const { error } = await supaAdmin.from("pasajeros").insert({
        nombre: p.nombre, dni: p.dni, telefono: p.telefono,
        empresa: p.empresa, email: p.email,
        cliente_id: clienteId, reserva_id: null,
      });
      if (error) { errores++; mensajesError.push(error.message); } else insertados++;
    }
  }

  return NextResponse.json({ insertados, actualizados, errores, mensajesError });
}

/** PATCH /api/pasajeros/upsert-nomina
 *  body: { id, campos: {nombre,dni,telefono,empresa,email,pin_acceso} }
 *  Update individual — service role bypasses RLS
 */
export async function PATCH(req: NextRequest) {
  const { id, campos } = await req.json();
  if (!id || !campos)
    return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });

  const { error } = await supaAdmin.from("pasajeros").update(campos).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
