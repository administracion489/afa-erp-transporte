// app/api/rrhh/vincular-conductor/route.ts — Puente conductor ↔ usuario (login).
//
//   POST { conductor_id, usuario_id }  (módulo `rrhh`)  → puebla conductores.usuario_id, para
//   que un conductor que además es usuario del ERP vea su perfil (la RLS de RRHH lo reconoce
//   por ese puente). Idempotente: correrlo dos veces con los mismos datos no cambia nada.
//
// Solo la flota PROPIA (`conductores`): el puente lo agrega rrhh-01 a esa tabla, no a
// conductores_tercero. Si falta la columna → falta la migración.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { adminRrhh } from "@/lib/rrhh/server";
import { faltaColumna, tablaFaltante } from "@/lib/columna-faltante";

const SQL = "supabase/rrhh-01-perfil-asistencia.sql";

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "rrhh");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const sb = adminRrhh();

    const conductorId = Number(body.conductor_id);
    const usuarioId = String(body.usuario_id ?? "").trim();
    if (!Number.isFinite(conductorId) || conductorId <= 0 || !usuarioId) {
      return NextResponse.json({ ok: false, error: "conductor_id y usuario_id requeridos." }, { status: 400 });
    }

    // Las dos partes tienen que existir.
    const [{ data: usu }, condRes] = await Promise.all([
      sb.from("usuarios").select("id").eq("id", usuarioId).maybeSingle(),
      sb.from("conductores").select("id,usuario_id").eq("id", conductorId).maybeSingle(),
    ]);
    if (!usu) return NextResponse.json({ ok: false, error: "El usuario indicado no existe." }, { status: 404 });
    if (condRes.error) {
      if (faltaColumna(condRes.error, "usuario_id") || tablaFaltante(condRes.error, "conductores")) {
        return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
      }
      throw condRes.error;
    }
    if (!condRes.data) return NextResponse.json({ ok: false, error: "El conductor indicado no existe." }, { status: 404 });

    const previo = (condRes.data as any).usuario_id ?? null;

    // Idempotente: si ya apunta a ese usuario, no se reescribe (y se dice).
    if (previo === usuarioId) {
      return NextResponse.json({ ok: true, conductor_id: conductorId, usuario_id: usuarioId, previo, sin_cambio: true });
    }

    const { error } = await sb.from("conductores").update({ usuario_id: usuarioId }).eq("id", conductorId);
    if (error) {
      if (faltaColumna(error, "usuario_id")) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, conductor_id: conductorId, usuario_id: usuarioId, previo });
  } catch (e: any) {
    console.error("[rrhh/vincular-conductor]", e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
