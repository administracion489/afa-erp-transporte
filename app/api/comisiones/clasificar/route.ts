// ══════════════════════════════════════════════════════════════════════════════
// app/api/comisiones/clasificar/route.ts
// Clasificar un RECLAMO o una CANCELACIÓN. La gravedad de un reclamo o si una cancelación
// era evitable es un JUICIO, no algo que el motor pueda deducir: lo escribe una persona y
// queda trazado (clasificado_por / clasificado_en).
//
// QUIÉN: SOLO un rol aprobador (admin/gerente). Un vendedor NO puede clasificar —decidiría
// sobre su propio bono— y ni siquiera un aprobador puede clasificar un reclamo/cancelación
// de un servicio que ÉL vendió (conflicto de interés). El motor «paga ante la duda», así
// que un reclamo sin clasificar NO rompe el bono; clasificar es lo que lo puede romper.
// ══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { tablaFaltante } from "@/lib/columna-faltante";

export const maxDuration = 60;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/** El vendedor de una reserva (vía su cotización), o null si no se puede resolver. */
async function vendedorDeReserva(reservaId: number): Promise<string | null> {
  const { data: r } = await admin.from("reservas").select("cotizacion_id").eq("id", reservaId).maybeSingle();
  const cotId = r?.cotizacion_id != null ? Number(r.cotizacion_id) : null;
  if (!cotId) return null;
  try {
    const { data: c } = await admin.from("cotizaciones").select("vendedor_id").eq("id", cotId).maybeSingle();
    return c?.vendedor_id != null ? String(c.vendedor_id) : null;
  } catch {
    return null; // sin columna vendedor_id no se puede comprobar el conflicto; se permite
  }
}

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "comisiones");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!["admin", "gerente"].includes(auth.rol)) {
    return NextResponse.json({ error: "Solo un administrador o gerente puede clasificar reclamos y cancelaciones." }, { status: 403 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const tipo = String(body?.tipo ?? "");
    const reservaId = body?.reservaId != null ? Number(body.reservaId) : null;
    const clienteId = body?.clienteId != null ? Number(body.clienteId) : null;

    if (tipo !== "reclamo" && tipo !== "cancelacion") {
      return NextResponse.json({ error: "El tipo debe ser 'reclamo' o 'cancelacion'." }, { status: 400 });
    }
    if (!reservaId && !clienteId) {
      return NextResponse.json({ error: "Indica a qué reserva (o cliente) corresponde." }, { status: 400 });
    }

    // No clasificar sobre un servicio PROPIO.
    if (reservaId) {
      const vend = await vendedorDeReserva(reservaId);
      if (vend && vend === auth.userId) {
        return NextResponse.json(
          { error: "No puedes clasificar un reclamo o cancelación de un servicio que tú vendiste." },
          { status: 403 },
        );
      }
    }

    if (tipo === "reclamo") {
      const gravedad = String(body?.gravedad ?? "leve");
      if (!["leve", "moderada", "grave"].includes(gravedad)) {
        return NextResponse.json({ error: "Gravedad inválida (leve|moderada|grave)." }, { status: 400 });
      }
      const fila: Record<string, unknown> = {
        gravedad,
        fundado: body?.fundado === true,
        atribuible_vendedor: body?.atribuible_vendedor === true,
        nota: (body?.nota ?? "").toString().trim().slice(0, 1000) || null,
        clasificado_por: auth.userId,
        clasificado_en: new Date().toISOString(),
      };
      if (reservaId) fila.reserva_id = reservaId;
      if (clienteId) fila.cliente_id = clienteId;
      const { data, error } = await admin.from("comisiones_reclamos").insert(fila).select("id").single();
      if (error) throw error;
      return NextResponse.json({ ok: true, id: Number(data.id) });
    }

    // cancelacion
    const fila: Record<string, unknown> = {
      evitable: body?.evitable === true,
      constancia_escrita: body?.constancia_escrita === true,
      nota: (body?.nota ?? "").toString().trim().slice(0, 1000) || null,
      clasificado_por: auth.userId,
      clasificado_en: new Date().toISOString(),
    };
    if (reservaId) fila.reserva_id = reservaId;
    const { data, error } = await admin.from("comisiones_cancelaciones").insert(fila).select("id").single();
    if (error) throw error;
    return NextResponse.json({ ok: true, id: Number(data.id) });
  } catch (e: any) {
    if (tablaFaltante(e, "comisiones_reclamos") || tablaFaltante(e, "comisiones_cancelaciones")) {
      return NextResponse.json({ error: "sin_migracion: falta correr supabase/comisiones-03-clasificaciones-y-pruebas.sql" }, { status: 422 });
    }
    console.error("[comisiones/clasificar]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
