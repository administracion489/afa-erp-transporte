// app/api/cliente/asignacion/route.ts
// Conductor y placa asignados a UNA reserva, para el portal del cliente.
//
// Antes el portal los leía con el cliente ANÓNIMO directo de `conductores`,
// `conductores_tercero` y `vehiculos_tercero` (nombre, licencia, teléfono, placa), así que
// esas tablas tenían que quedar abiertas al rol anon — o sea, a cualquiera con la URL del
// proyecto: la anon key viaja en el JavaScript público. Ahora pasa por aquí: el cliente sale
// del TOKEN del portal y la reserva tiene que ser suya, así que solo se ve el conductor de un
// servicio propio. Con eso esas tablas pueden cerrarse a `authenticated`
// (supabase/seguridad-01-rls.sql).
//
// Mismo reparto que tenía la pantalla: el tercerizado NO revela la empresa al cliente, y sin
// conductor nombrado se contesta "Conductor asignado".

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarTokenPortal, reservaEsDelCliente } from "@/lib/portal-auth";

const adminClient = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const sesion = verificarTokenPortal(body?.token);
    if (!sesion) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

    const reservaId = Number(body?.reservaId ?? 0);
    const admin = adminClient();
    if (!(await reservaEsDelCliente(admin, reservaId, sesion.cid))) {
      return NextResponse.json({ error: "No autorizado" }, { status: 403 });
    }

    const { data: r } = await admin.from("reservas")
      .select("conductor_id, conductor_tercero_id, empresa_tercerizada_id, vehiculo_id, vehiculo_tercero_id")
      .eq("id", reservaId).maybeSingle();
    if (!r) return NextResponse.json({ conductor: null, placa: null });

    let conductor: { nombre: string; numero_licencia: string | null; telefono: string } | null = null;
    if (r.conductor_id) {
      const { data } = await admin.from("conductores")
        .select("nombre, licencia, telefono").eq("id", r.conductor_id).maybeSingle();
      if (data) conductor = { nombre: data.nombre, numero_licencia: data.licencia ?? null, telefono: data.telefono || "" };
    } else if (r.conductor_tercero_id) {
      const { data } = await admin.from("conductores_tercero")
        .select("nombre, licencia, telefono").eq("id", r.conductor_tercero_id).maybeSingle();
      if (data) conductor = { nombre: data.nombre, numero_licencia: data.licencia ?? null, telefono: data.telefono || "" };
    } else if (r.empresa_tercerizada_id) {
      conductor = { nombre: "Conductor asignado", numero_licencia: null, telefono: "" };
    }

    let placa: string | null = null;
    if (r.vehiculo_id) {
      const { data } = await admin.from("vehiculos").select("placa").eq("id", r.vehiculo_id).maybeSingle();
      placa = data?.placa ?? null;
    } else if (r.vehiculo_tercero_id) {
      const { data } = await admin.from("vehiculos_tercero").select("placa").eq("id", r.vehiculo_tercero_id).maybeSingle();
      placa = data?.placa ?? null;
    }

    return NextResponse.json({ conductor, placa });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Error" }, { status: 500 });
  }
}
