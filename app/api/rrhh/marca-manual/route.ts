// app/api/rrhh/marca-manual/route.ts — RRHH registra una marca POR un empleado.
//
//   POST { usuario_id, tipo?, metodo?, lat?, lng?, precision_m?, rostro_detectado?, marcado_en? }
//     (módulo `rrhh`)  → fichaje de respaldo cuando la cámara no está disponible (metodo
//     'manual_rrhh' o 'pin'). NO es facial, así que no exige consentimiento biométrico.
//
// Quien marca es RRHH (token con permiso `rrhh`); el fichaje queda a nombre del `usuario_id`
// destino, que tiene que existir. Si no se da `tipo`, se deriva con `tipoSiguiente` del día.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { validarMarca, tipoSiguiente, esTipoMarca } from "@/lib/rrhh/marcacion";
import { calcularJornada } from "@/lib/rrhh/jornada";
import { cargarConfigRrhh, marcasDeHoy, hoyLimaFecha } from "@/lib/rrhh/marcacion-datos";
import { escribirDegradando } from "@/lib/rrhh/db";
import { adminRrhh } from "@/lib/rrhh/server";
import { fechaLima } from "@/lib/alertas-horario";

const SQL = "supabase/rrhh-01-perfil-asistencia.sql";

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "rrhh");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const sb = adminRrhh();

    const destino = String(body.usuario_id ?? "").trim();
    if (!destino) return NextResponse.json({ ok: false, error: "usuario_id (empleado) requerido." }, { status: 400 });

    // El empleado destino tiene que existir.
    const { data: usu } = await sb.from("usuarios").select("id").eq("id", destino).maybeSingle();
    if (!usu) return NextResponse.json({ ok: false, error: "El empleado indicado no existe." }, { status: 404 });

    const metodo = body.metodo === "pin" ? "pin" : "manual_rrhh";

    const { cfg, sinMigracion } = await cargarConfigRrhh(sb);
    if (sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });

    // El día (Lima) del fichaje: si viene marcado_en, se usa su día; si no, hoy.
    const marcadoEn = typeof body.marcado_en === "string" && !Number.isNaN(Date.parse(body.marcado_en))
      ? new Date(body.marcado_en).toISOString() : null;
    const dia = marcadoEn ? fechaLima(Date.parse(marcadoEn)) : hoyLimaFecha();

    const previa = await marcasDeHoy(sb, destino, dia);
    if (previa.sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });

    // RRHH puede FORZAR un tipo (corrige un olvido); si no lo da, se deriva el siguiente.
    let tipo = tipoSiguiente(previa.marcas);
    if (body.tipo != null) {
      if (!esTipoMarca(body.tipo)) return NextResponse.json({ ok: false, error: "Tipo de marca inválido." }, { status: 400 });
      tipo = body.tipo;
    }
    if (!tipo) return NextResponse.json({ ok: false, error: "La jornada de ese día ya está cerrada; indica el tipo si quieres corregir." }, { status: 409 });

    // Geocerca solo si hay coordenadas (RRHH suele marcar sin GPS): tri-estado, no se inventa.
    const lat = body.lat != null ? Number(body.lat) : null;
    const lng = body.lng != null ? Number(body.lng) : null;
    const precision_m = body.precision_m != null && Number.isFinite(Number(body.precision_m)) ? Number(body.precision_m) : null;
    const hayGeo = lat != null && lng != null && cfg != null;
    const geo = hayGeo ? validarMarca({ lat, lng, precision_m }, cfg!) : null;

    const fila: Record<string, unknown> = {
      usuario_id: destino,
      tipo,
      lat, lng, precision_m,
      dentro_geocerca: geo ? geo.dentro_geocerca : null,
      distancia_m: geo && Number.isFinite(geo.distancia_m) ? geo.distancia_m : null,
      foto_url: null,
      rostro_detectado: null,
      metodo,
      origen: "rrhh",
      ...(marcadoEn ? { marcado_en: marcadoEn } : {}),
    };
    const ins = await escribirDegradando("rrhh_marca", fila, (f) =>
      sb.from("rrhh_marca").insert(f).select("*"));
    if (ins.sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
    if (!ins.ok) return NextResponse.json({ ok: false, error: ins.error?.message ?? "No se pudo registrar." }, { status: 500 });

    const ahora = await marcasDeHoy(sb, destino, dia);
    const jornada = cfg ? calcularJornada(ahora.marcas, cfg) : null;

    return NextResponse.json({ ok: true, tipo, metodo, jornada });
  } catch (e: any) {
    console.error("[rrhh/marca-manual]", e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
