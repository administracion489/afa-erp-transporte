// ══════════════════════════════════════════════════════════════════════════════
// app/api/comisiones/lista-existentes/route.ts
// La LISTA FIRMADA de clientes que ya existían al arrancar el módulo. Define qué es
// cliente NUEVO (y por tanto da bono de arranque): quien NO está en esta lista.
//
//   · POST (solo aprobador) → cargar filas. Cada una identifica a alguien con al menos
//     uno de `cliente_id | ruc | nombre` (respeta el CHECK y los únicos parciales de
//     cliente_id/ruc). Idempotente: una fila ya listada cuenta como `duplicadas`, no falla.
//   · GET  (módulo comisiones) → listar lo ya cargado, paginado.
// ══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { faltaColumna, tablaFaltante } from "@/lib/columna-faltante";

export const maxDuration = 60;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const esDuplicado = (e: any) => /duplicate key|23505/i.test(String(e?.message ?? "")) || e?.code === "23505";
const sinMigracion = () =>
  NextResponse.json(
    { error: "sin_migracion: falta correr supabase/comisiones-02-captador-y-vendedor.sql" },
    { status: 422 },
  );

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "comisiones");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!["admin", "gerente"].includes(auth.rol)) {
    return NextResponse.json({ error: "Solo un administrador o gerente puede cargar la lista de clientes existentes." }, { status: 403 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const entradas = Array.isArray(body?.clientes) ? body.clientes : [];
    if (!entradas.length) {
      return NextResponse.json({ error: "Envía { clientes: [{ cliente_id?, ruc?, nombre? }] }." }, { status: 400 });
    }

    const cuando = new Date().toISOString();
    let insertadas = 0;
    let duplicadas = 0;
    let invalidas = 0;

    // Inserción fila por fila para clasificar el resultado (la lista se carga una vez y es
    // chica). `cliente_id` es una FK de migración accesoria: si falta, se suelta y se usa
    // ruc/nombre; una fila que SOLO traía cliente_id queda inválida en ese caso.
    for (const e of entradas) {
      const clienteId = e?.cliente_id != null && Number.isFinite(Number(e.cliente_id)) ? Number(e.cliente_id) : null;
      const ruc = typeof e?.ruc === "string" && e.ruc.trim() ? e.ruc.trim() : null;
      const nombre = typeof e?.nombre === "string" && e.nombre.trim() ? e.nombre.trim() : null;
      if (clienteId == null && ruc == null && nombre == null) {
        invalidas += 1;
        continue;
      }

      const fila: Record<string, unknown> = { cargada_por: auth.userId, cargada_en: cuando };
      if (ruc != null) fila.ruc = ruc;
      if (nombre != null) fila.nombre = nombre;
      if (clienteId != null) fila.cliente_id = clienteId;

      let { error } = await admin.from("comisiones_lista_clientes_existentes").insert(fila);
      if (error && faltaColumna(error, "cliente_id")) {
        if (ruc == null && nombre == null) { invalidas += 1; continue; }
        const { cliente_id: _omit, ...resto } = fila;
        ({ error } = await admin.from("comisiones_lista_clientes_existentes").insert(resto));
      }
      if (error) {
        if (esDuplicado(error)) { duplicadas += 1; continue; }
        if (tablaFaltante(error, "comisiones_lista_clientes_existentes")) return sinMigracion();
        throw error;
      }
      insertadas += 1;
    }

    return NextResponse.json({ ok: true, insertadas, duplicadas, invalidas });
  } catch (e: any) {
    if (tablaFaltante(e, "comisiones_lista_clientes_existentes")) return sinMigracion();
    console.error("[comisiones/lista-existentes POST]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "comisiones");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const url = new URL(req.url);
    const limitCrudo = Number(url.searchParams.get("limit") ?? 100);
    const limit = Number.isFinite(limitCrudo) ? Math.min(Math.max(1, Math.round(limitCrudo)), 500) : 100;
    const offsetCrudo = Number(url.searchParams.get("offset") ?? 0);
    const offset = Number.isFinite(offsetCrudo) && offsetCrudo > 0 ? Math.round(offsetCrudo) : 0;

    const pedir = async (cols: string) => {
      const { data, error } = await admin
        .from("comisiones_lista_clientes_existentes")
        .select(cols, { count: "exact" })
        .order("cargada_en", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      return data as any;
    };

    let data: any;
    let count: number | null = null;
    try {
      const r = await admin
        .from("comisiones_lista_clientes_existentes")
        .select("id,cliente_id,ruc,nombre,cargada_por,cargada_en", { count: "exact" })
        .order("cargada_en", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + limit - 1);
      if (r.error) throw r.error;
      data = r.data;
      count = r.count ?? null;
    } catch (e: any) {
      if (!faltaColumna(e, "cliente_id")) throw e;
      data = await pedir("id,ruc,nombre,cargada_por,cargada_en");
    }

    return NextResponse.json({ clientes: (data as any[]) ?? [], total: count, limit, offset });
  } catch (e: any) {
    if (tablaFaltante(e, "comisiones_lista_clientes_existentes")) return sinMigracion();
    console.error("[comisiones/lista-existentes GET]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
