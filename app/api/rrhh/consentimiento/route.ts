// app/api/rrhh/consentimiento/route.ts — Consentimiento biométrico y/o de monitoreo (propio).
//
//   POST { biometrico?: boolean, monitoreo?: boolean }
//     true  = otorgar  → consentimiento_<tipo>_en = now(), _version = versión vigente.
//     false = revocar  → consentimiento_<tipo>_en = null, _version = null.
//
// La identidad es la del TOKEN (se fuerza usuario_id). Es REVOCABLE (poner a null), y la
// respuesta lo dice. Solo el service-role escribe estas columnas: la RLS del perfil no las
// deja tocar desde el cliente.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { escribirDegradando } from "@/lib/rrhh/db";
import { adminRrhh } from "@/lib/rrhh/server";
import {
  TIPOS_CONSENTIMIENTO, columnasConsentimiento, VERSION_CONSENTIMIENTO,
  estadoConsentimientos,
} from "@/lib/rrhh/consentimiento";

const SQL = "supabase/rrhh-01-perfil-asistencia.sql";

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "mi-perfil");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const usuarioId = auth.userId;

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const sb = adminRrhh();

    const fila: Record<string, unknown> = { usuario_id: usuarioId, updated_at: new Date().toISOString() };
    const cambios: string[] = [];
    for (const tipo of TIPOS_CONSENTIMIENTO) {
      if (!(tipo in body)) continue;
      const otorgar = body[tipo] === true;
      const { en, version } = columnasConsentimiento(tipo);
      fila[en] = otorgar ? new Date().toISOString() : null;
      fila[version] = otorgar ? VERSION_CONSENTIMIENTO[tipo] : null;
      cambios.push(tipo);
    }

    if (cambios.length === 0) {
      return NextResponse.json({
        ok: false,
        error: "Indica qué consentimiento otorgar o revocar (biometrico / monitoreo: true para otorgar, false para revocar).",
      }, { status: 400 });
    }

    const up = await escribirDegradando("empleado_perfil", fila, (f) =>
      sb.from("empleado_perfil").upsert(f, { onConflict: "usuario_id" }).select("*"));
    if (up.sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
    if (!up.ok) return NextResponse.json({ ok: false, error: up.error?.message ?? "No se pudo guardar." }, { status: 500 });

    return NextResponse.json({
      ok: true,
      revocable: true, // poner a null revoca; así se registró si se pidió false
      cambiados: cambios,
      consentimientos: estadoConsentimientos(up.data as Record<string, unknown>),
    });
  } catch (e: any) {
    console.error("[rrhh/consentimiento]", e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
