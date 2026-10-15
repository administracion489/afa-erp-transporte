// app/api/rrhh/campo-posiciones/route.ts — Panel de MONITOREO de campo (solo RRHH).
//
//   GET (módulo `rrhh`): → { ok, empleados, ventana, columnas_faltantes, sin_migracion? }
//     Última posición de cada empleado en campo + su rastro reciente, en una ventana de tiempo.
//     ?desde / ?hasta: instantes (ISO-8601 o epoch-ms). Por defecto: últimas VENTANA_DEFECTO_H
//     horas. La ventana se topa a VENTANA_MAX_DIAS días (acota el barrido de la tabla núcleo).
//
// Lee con service-role (la lectura de campo NO se abre por RLS: ubicaciones_gps es compartida
// con la flota). El discriminador `empleado_usuario_id` ausente = falta la migración → se DICE.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { adminRrhh } from "@/lib/rrhh/server";
import { posicionesCampo, SQL_CAMPO } from "@/lib/rrhh/campo-datos";

export const maxDuration = 30;

const VENTANA_DEFECTO_H = 12;
const VENTANA_MAX_DIAS = 7;
const HORA_MS = 3_600_000;
const DIA_MS = 86_400_000;

/** Un parámetro de instante del query → epoch-ms, o null si no se entiende. Acepta ISO o ms. */
function instanteDe(v: string | null): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v)) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "rrhh");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const sp = req.nextUrl.searchParams;
  const ahora = Date.now();
  const hastaMs = instanteDe(sp.get("hasta")) ?? ahora;
  let desdeMs = instanteDe(sp.get("desde")) ?? hastaMs - VENTANA_DEFECTO_H * HORA_MS;
  if (desdeMs >= hastaMs) desdeMs = hastaMs - VENTANA_DEFECTO_H * HORA_MS; // rango inválido → defecto
  // Topa la ventana para no barrer la tabla más escrita del ERP sin límite.
  if (hastaMs - desdeMs > VENTANA_MAX_DIAS * DIA_MS) desdeMs = hastaMs - VENTANA_MAX_DIAS * DIA_MS;

  const desde = new Date(desdeMs).toISOString();
  const hasta = new Date(hastaMs).toISOString();

  try {
    const sb = adminRrhh();
    const { empleados, sinMigracion, columnasFaltantes } = await posicionesCampo(sb, { desde, hasta });
    if (sinMigracion) {
      return NextResponse.json({ ok: true, empleados: [], ventana: { desde, hasta }, columnas_faltantes: [], sin_migracion: SQL_CAMPO });
    }
    return NextResponse.json({ ok: true, empleados, ventana: { desde, hasta }, columnas_faltantes: columnasFaltantes });
  } catch (e: unknown) {
    console.error("[rrhh/campo-posiciones]", e);
    return NextResponse.json({ ok: false, error: (e as { message?: string })?.message ?? "Error" }, { status: 500 });
  }
}
