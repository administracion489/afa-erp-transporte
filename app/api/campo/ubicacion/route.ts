// app/api/campo/ubicacion/route.ts — Ingesta de posición GPS del trabajo en CAMPO (Fase 2).
//
//   POST (módulo `campo`): { lat, lng, velocidad?, rumbo?, precision_m?, fix_ts?, created_at? }
//     o un LOTE [{...}] para drenar la cola offline del teléfono.
//
// LA IDENTIDAD ES LA DEL TOKEN. La fila se fuerza con `empleado_usuario_id = token uid` y los
// 4 FK de flota (conductor_id/vehiculo_id/conductor_tercero_id/vehiculo_tercero_id) en NULL —
// un `empleado_usuario_id` en el cuerpo se ignora—, así monitoreo/huella/analítica (que filtran
// por conductor o vehículo) nunca la ven.
//
// EXIGE AUTORIZACIÓN DE CAMPO VIGENTE: rastrear a una persona es dato sensible, así que una marca
// de campo solo se guarda si una autorización 'aprobada' cubre ESTE instante (lib/rrhh/campo.ts).
// Sin ella → 403 con el motivo; no se escribe nada. Sin la migración → 422.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { adminRrhh } from "@/lib/rrhh/server";
import { ventanaCampoVigente } from "@/lib/rrhh/campo";
import { autorizacionesDeUsuario, insertarPosicionesCampo, SQL_CAMPO, COL_DISCRIMINADOR } from "@/lib/rrhh/campo-datos";

export const maxDuration = 30;

/** Una posición válida del cuerpo → fila lista (sin la identidad, que la pone el servidor), o null. */
function sanearPunto(p: unknown): Record<string, unknown> | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const lat = Number(o.lat), lng = Number(o.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null; // coordenada basura
  const num = (v: unknown) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const fila: Record<string, unknown> = {
    lat, lng,
    velocidad: num(o.velocidad),
    rumbo: num(o.rumbo),
    precision_m: num(o.precision_m),
  };
  // La cola offline manda el instante de captura; se conserva tal cual (como /api/conductor).
  if (typeof o.fix_ts === "string" && o.fix_ts) fila.fix_ts = o.fix_ts;
  if (typeof o.created_at === "string" && o.created_at) fila.created_at = o.created_at;
  return fila;
}

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "campo");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const usuarioId = auth.userId; // IDENTIDAD = token, jamás el body

  try {
    const sb = adminRrhh();

    // 1) Exige autorización de campo vigente AHORA. Sin migración → 422; no vigente → 403.
    const { autorizaciones, sinMigracion } = await autorizacionesDeUsuario(sb, usuarioId);
    if (sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL_CAMPO }, { status: 422 });
    const v = ventanaCampoVigente(autorizaciones, Date.now());
    if (!v.vigente) {
      return NextResponse.json({
        ok: false,
        vigente: false,
        motivo: v.motivo,
        autorizacion: v.autorizacion,
        error: "No tienes una autorización de campo vigente. Solicítala o pide a Recursos Humanos que la apruebe.",
      }, { status: 403 });
    }

    // 2) Puntos: 1 o lote. Se descartan coordenadas inválidas / (0,0).
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const crudos = Array.isArray(body.payload) ? body.payload
      : Array.isArray(body) ? (body as unknown[])
      : [body];
    const saneados = crudos.map(sanearPunto).filter((f): f is Record<string, unknown> => f != null);
    const descartados = crudos.length - saneados.length;
    if (saneados.length === 0) {
      return NextResponse.json({ ok: false, error: "No llegó ninguna coordenada válida.", descartados }, { status: 400 });
    }

    // 3) Fuerza la identidad de campo: discriminador = token, los 4 FK de flota en NULL.
    const filas = saneados.map((f) => ({
      ...f,
      [COL_DISCRIMINADOR]: usuarioId,
      conductor_id: null,
      vehiculo_id: null,
      conductor_tercero_id: null,
      vehiculo_tercero_id: null,
    }));

    // 4) Inserta (degradando columnas accesorias; sin el discriminador → 422).
    const ins = await insertarPosicionesCampo(sb, filas);
    if (ins.sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL_CAMPO }, { status: 422 });
    if (!ins.ok) return NextResponse.json({ ok: false, error: ins.error ?? "No se pudo guardar la posición." }, { status: 500 });

    return NextResponse.json({
      ok: true,
      insertados: ins.insertados,
      descartados,
      columnas_omitidas: ins.columnasOmitidas,
    });
  } catch (e: unknown) {
    console.error("[campo/ubicacion]", e);
    return NextResponse.json({ ok: false, error: (e as { message?: string })?.message ?? "Error" }, { status: 500 });
  }
}
