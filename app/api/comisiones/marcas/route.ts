// ══════════════════════════════════════════════════════════════════════════════
// app/api/comisiones/marcas/route.ts
// Listar las marcas del FONDO (`comisiones_operacion_admin`) de un mes, con su estado de
// corroboración, para que el admin corrobore/retire por id con /api/comisiones/corroborar.
//
// QUÉ MES: una marca pertenece al mes si ya está atada a su periodo (`periodo_id`) o si su
// reserva se COBRÓ en el mes (que es cuando su eventual cuenta para el fondo). Así el admin
// ve las candidatas ANTES de corroborar (cuando aún tienen periodo_id null).
//
// FILTRADO POR FILA: admin/gerente ven todas; el vendedor ve las que marcó o las de su
// ficha de personal administrativo. Resolver nombres es barato y se incluye.
// ══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { limitesMes } from "@/lib/comisiones/datos";
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
    const { inicio, finExcl } = limitesMes(anioMes);

    // El periodo del mes (si ya existe) ata las marcas corroboradas.
    const { data: periodo } = await admin.from("comisiones_periodo").select("id").eq("anio_mes", anioMes).maybeSingle();
    const periodoId = periodo?.id != null ? Number(periodo.id) : null;

    // Todas las marcas (tabla chica, manual). Paginado por si crece.
    const marcas: any[] = [];
    for (let desde = 0; ; desde += 1000) {
      const { data, error } = await admin
        .from("comisiones_operacion_admin")
        .select("id,reserva_id,personal_administrativo_id,marcado_por,marcado_en,corroborado_por,corroborado_en,nota,periodo_id")
        .order("marcado_en", { ascending: false })
        .order("id", { ascending: false })
        .range(desde, desde + 999);
      if (error) throw error;
      const lote = (data as any[]) ?? [];
      marcas.push(...lote);
      if (lote.length < 1000) break;
    }

    // Qué reservas (de las marcas) se cobraron en el mes → acota sin leer toda la flota.
    const reservaIds = [...new Set(marcas.map((m) => Number(m.reserva_id ?? 0)).filter(Boolean))];
    const enMes = new Set<number>();
    for (let i = 0; i < reservaIds.length; i += 500) {
      const bloque = reservaIds.slice(i, i + 500);
      const { data, error } = await admin
        .from("reservas")
        .select("id")
        .in("id", bloque)
        .eq("estado_admin", "cobrada")
        .gte("fecha_cobro", inicio)
        .lt("fecha_cobro", finExcl);
      if (error) throw error;
      for (const r of (data as any[]) ?? []) enMes.add(Number(r.id));
    }

    const delMes = marcas.filter(
      (m) => (periodoId != null && Number(m.periodo_id) === periodoId) || enMes.has(Number(m.reserva_id ?? 0)),
    );

    // Filtrado por fila.
    const esAprobador = ["admin", "gerente"].includes(auth.rol);
    let paId: number | null = null;
    if (!esAprobador) {
      try {
        const { data: pa } = await admin.from("personal_administrativo").select("id").eq("usuario_id", auth.userId).maybeSingle();
        paId = pa?.id != null ? Number(pa.id) : null;
      } catch { paId = null; }
    }
    const visibles = esAprobador
      ? delMes
      : delMes.filter((m) => String(m.marcado_por) === auth.userId || (paId != null && Number(m.personal_administrativo_id) === paId));

    // Nombres (barato): usuarios de marcado_por/corroborado_por + ficha del administrativo.
    const uuids = [...new Set(visibles.flatMap((m) => [m.marcado_por, m.corroborado_por]).filter(Boolean).map(String))];
    const paIds = [...new Set(visibles.map((m) => Number(m.personal_administrativo_id ?? 0)).filter(Boolean))];
    const nombreUsuario = new Map<string, string>();
    const nombrePa = new Map<number, string>();
    try {
      if (uuids.length) {
        const { data } = await admin.from("usuarios").select("id,nombre").in("id", uuids);
        for (const u of (data as any[]) ?? []) nombreUsuario.set(String(u.id), String(u.nombre ?? ""));
      }
      if (paIds.length) {
        const { data } = await admin.from("personal_administrativo").select("id,nombre").in("id", paIds);
        for (const p of (data as any[]) ?? []) nombrePa.set(Number(p.id), String(p.nombre ?? ""));
      }
    } catch {
      // Sin nombres el front los resuelve; no se cae por eso.
    }

    const salida = visibles.map((m) => ({
      id: m.id,
      reserva_id: m.reserva_id,
      personal_administrativo_id: m.personal_administrativo_id,
      personal_administrativo_nombre: nombrePa.get(Number(m.personal_administrativo_id ?? 0)) ?? null,
      marcado_por: m.marcado_por,
      marcado_por_nombre: m.marcado_por ? nombreUsuario.get(String(m.marcado_por)) ?? null : null,
      marcado_en: m.marcado_en,
      corroborado_por: m.corroborado_por,
      corroborado_por_nombre: m.corroborado_por ? nombreUsuario.get(String(m.corroborado_por)) ?? null : null,
      corroborado_en: m.corroborado_en,
      periodo_id: m.periodo_id,
      nota: m.nota,
    }));

    return NextResponse.json({ marcas: salida });
  } catch (e: any) {
    if (tablaFaltante(e, "comisiones_operacion_admin")) {
      return NextResponse.json({ error: "sin_migracion: falta correr supabase/comisiones-03-clasificaciones-y-pruebas.sql" }, { status: 422 });
    }
    console.error("[comisiones/marcas]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
