// ══════════════════════════════════════════════════════════════════════════════
// app/api/comisiones/lineas/route.ts
// Listar las líneas de comisión de un periodo, FILTRADAS POR FILA según el rol:
//   · admin / gerente → todas las líneas del periodo.
//   · vendedor        → solo sus líneas (vendedor_id = su uid) + las del fondo cuya
//                       beneficiaria sea su ficha de personal administrativo.
//
// Se lee con service-role y se filtra en el servidor (no se confía en que la pantalla
// mande el filtro). Es el mismo criterio que la RLS por fila de la fase 04, aplicado acá
// porque el cálculo usa service-role.
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

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "comisiones");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const url = new URL(req.url);
    const anioMes = String(url.searchParams.get("anioMes") ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(anioMes)) {
      return NextResponse.json({ error: "Falta el mes en formato AAAA-MM." }, { status: 400 });
    }

    const { data: periodo, error: ePer } = await admin
      .from("comisiones_periodo")
      .select("id,anio_mes,estado,calculado_en,cerrado_en")
      .eq("anio_mes", anioMes)
      .maybeSingle();
    if (ePer) throw ePer;
    if (!periodo) {
      return NextResponse.json({ periodo: null, lineas: [], motivo: "periodo_no_calculado" });
    }

    const esAprobador = ["admin", "gerente"].includes(auth.rol);

    // Si no es aprobador, averigua su ficha de personal administrativo (para el fondo).
    let paId: number | null = null;
    if (!esAprobador) {
      try {
        const { data: pa } = await admin
          .from("personal_administrativo")
          .select("id")
          .eq("usuario_id", auth.userId)
          .maybeSingle();
        paId = pa?.id != null ? Number(pa.id) : null;
      } catch {
        paId = null; // sin puente, solo ve sus líneas de vendedor
      }
    }

    let q = admin
      .from("comisiones_linea")
      .select(
        "id,periodo_id,vendedor_id,tipo,reserva_id,cliente_id,cotizacion_id," +
          "personal_administrativo_id,base_utilidad,pct_aplicado,monto,fecha_cobro_origen," +
          "orden_eventual,parametros_id,traza_json,estado",
      )
      .eq("periodo_id", periodo.id)
      .order("tipo", { ascending: true })
      .order("fecha_cobro_origen", { ascending: true })
      .order("id", { ascending: true });

    if (!esAprobador) {
      // Sus líneas de vendedor O las del fondo de su ficha administrativa.
      const condiciones = [`vendedor_id.eq.${auth.userId}`];
      if (paId != null) condiciones.push(`personal_administrativo_id.eq.${paId}`);
      q = q.or(condiciones.join(","));
    }

    const { data, error } = await q;
    if (error) throw error;
    const lineas = (data as any[]) ?? [];

    // Totales de lo que ve este rol (los retenidos no suman: su monto es 0 y su traza lo dice).
    let comisiones = 0;
    let fondo = 0;
    for (const l of lineas) {
      const monto = Number(l.monto ?? 0);
      if (l.tipo === "fondo_admin") fondo += monto;
      else comisiones += monto;
    }

    return NextResponse.json({
      periodo: {
        id: periodo.id,
        anio_mes: periodo.anio_mes,
        estado: periodo.estado,
        calculado_en: periodo.calculado_en,
        cerrado_en: periodo.cerrado_en,
      },
      lineas,
      totales: {
        comisiones: Math.round(comisiones * 100) / 100,
        fondo: Math.round(fondo * 100) / 100,
      },
    });
  } catch (e: any) {
    if (tablaFaltante(e, "comisiones_periodo") || tablaFaltante(e, "comisiones_linea")) {
      return NextResponse.json({ error: "sin_migracion: falta correr supabase/comisiones-04-lineas-y-periodos.sql" }, { status: 422 });
    }
    console.error("[comisiones/lineas]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
