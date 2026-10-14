// ══════════════════════════════════════════════════════════════════════════════
// app/api/comisiones/exportar/route.ts
// Exportar la PLANILLA del periodo: una fila por línea de comisión, con la marca de
// REMUNERATIVO (para que contabilidad la cargue a la planilla). CSV (lo abre Excel sin
// depender de ninguna librería). Solo un rol aprobador.
//
// REMUNERATIVO: las comisiones y bonos del vendedor (eventual, fijo, bono_arranque,
// bono_atencion) son remuneración del vendedor → SÍ. El `fondo_admin` es un pago de la
// EMPRESA a los operadores, aparte de la comisión → se marca NO y su tratamiento lo
// confirma contabilidad. SUPUESTO declarado: ajustable sin tocar el cálculo.
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

/** ¿La línea es remuneración del vendedor? El fondo no (es un pago aparte de la empresa). */
export function esRemunerativo(tipo: string): boolean {
  return tipo !== "fondo_admin";
}

/** Un campo CSV, entrecomillado y escapado (coma, comillas, saltos). */
function csv(v: unknown): string {
  const s = v == null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "comisiones");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!["admin", "gerente"].includes(auth.rol)) {
    return NextResponse.json({ error: "Solo un administrador o gerente puede exportar la planilla." }, { status: 403 });
  }

  try {
    const url = new URL(req.url);
    const anioMes = String(url.searchParams.get("anioMes") ?? "").trim();
    if (!/^\d{4}-\d{2}$/.test(anioMes)) {
      return NextResponse.json({ error: "Falta el mes en formato AAAA-MM." }, { status: 400 });
    }

    const { data: periodo, error: ePer } = await admin
      .from("comisiones_periodo")
      .select("id,estado")
      .eq("anio_mes", anioMes)
      .maybeSingle();
    if (ePer) throw ePer;
    if (!periodo) return NextResponse.json({ error: "El periodo no está calculado." }, { status: 404 });

    const { data, error } = await admin
      .from("comisiones_linea")
      .select(
        "id,vendedor_id,tipo,reserva_id,cliente_id,cotizacion_id,personal_administrativo_id," +
          "base_utilidad,pct_aplicado,monto,fecha_cobro_origen,orden_eventual,traza_json",
      )
      .eq("periodo_id", periodo.id)
      .order("tipo", { ascending: true })
      .order("vendedor_id", { ascending: true })
      .order("id", { ascending: true });
    if (error) throw error;
    const lineas = (data as any[]) ?? [];

    const cabecera = [
      "periodo", "estado_periodo", "tipo", "codigo", "remunerativo",
      "vendedor_id", "personal_administrativo_id", "reserva_id", "cliente_id", "cotizacion_id",
      "base_utilidad", "pct_aplicado", "monto", "orden_eventual", "fecha_cobro_origen", "detalle",
    ];
    const filas = lineas.map((l) => {
      const traza = (l.traza_json as any) ?? {};
      return [
        anioMes, periodo.estado, l.tipo, traza.codigo ?? "", esRemunerativo(String(l.tipo)) ? "SI" : "NO",
        l.vendedor_id ?? "", l.personal_administrativo_id ?? "", l.reserva_id ?? "", l.cliente_id ?? "", l.cotizacion_id ?? "",
        l.base_utilidad ?? "", l.pct_aplicado ?? "", l.monto ?? 0, l.orden_eventual ?? "", l.fecha_cobro_origen ?? "", traza.detalle ?? "",
      ].map(csv).join(",");
    });
    // BOM para que Excel lea los acentos en UTF-8.
    const cuerpo = "﻿" + [cabecera.map(csv).join(","), ...filas].join("\r\n");

    return new NextResponse(cuerpo, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="comisiones-${anioMes}.csv"`,
      },
    });
  } catch (e: any) {
    if (tablaFaltante(e, "comisiones_periodo") || tablaFaltante(e, "comisiones_linea")) {
      return NextResponse.json({ error: "sin_migracion: falta correr supabase/comisiones-04-lineas-y-periodos.sql" }, { status: 422 });
    }
    console.error("[comisiones/exportar]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
