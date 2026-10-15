// app/api/rrhh/marcar/route.ts — Marcación de asistencia (facial).
//
//   POST (pantalla /mi-perfil, módulo `mi-perfil`):
//     { tipo?, lat, lng, precision_m?, rostro_detectado?, foto }  → registra el fichaje.
//
// LA IDENTIDAD ES LA DEL TOKEN, jamás la del body: un `usuario_id` en el cuerpo se ignora. El
// SERVIDOR recomputa la geocerca (no confía en el `dentro_geocerca` del cliente), DERIVA el
// tipo con `tipoSiguiente` (nadie marca "salida" antes de "entrada"), exige consentimiento
// biométrico vigente (sin él, 403 y método alterno), y sube la foto al bucket PRIVADO `rrhh`.
// Si falta la migración → 422. Si la foto falla → la marca se registra SIN foto (no se pierde).

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { validarMarca, tipoSiguiente, esTipoMarca } from "@/lib/rrhh/marcacion";
import { calcularJornada } from "@/lib/rrhh/jornada";
import { cargarConfigRrhh, marcasDeHoy, hoyLimaFecha } from "@/lib/rrhh/marcacion-datos";
import { consentimientoVigente } from "@/lib/rrhh/consentimiento";
import { escribirDegradando } from "@/lib/rrhh/db";
import { adminRrhh, subirArrhh, AdjuntoInvalido } from "@/lib/rrhh/server";
import { tablaFaltante } from "@/lib/columna-faltante";

export const maxDuration = 60;

const SQL = "supabase/rrhh-01-perfil-asistencia.sql";

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "mi-perfil");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const usuarioId = auth.userId; // IDENTIDAD = token, nunca el body

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const sb = adminRrhh();

    // 1) Config de sede/horario. Sin migración → 422.
    const { cfg, sinMigracion } = await cargarConfigRrhh(sb);
    if (sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
    if (!cfg) return NextResponse.json({ ok: false, error: "RRHH aún no configuró la sede. Avisa a Recursos Humanos." }, { status: 409 });

    // 2) Consentimiento biométrico vigente (la marcación es facial = dato biométrico).
    const { data: perfil, error: ePerfil } = await sb
      .from("empleado_perfil").select("*").eq("usuario_id", usuarioId).maybeSingle();
    if (ePerfil && tablaFaltante(ePerfil, "empleado_perfil")) {
      return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
    }
    if (!consentimientoVigente(perfil, "biometrico")) {
      return NextResponse.json({
        ok: false,
        requiere_consentimiento: "biometrico",
        metodo_alterno: "pin",
        error: "Para marcar con la cámara (se guarda tu foto como evidencia) primero debes dar tu consentimiento biométrico en tu perfil. Mientras tanto, puedes marcar con PIN pidiéndoselo a Recursos Humanos.",
      }, { status: 403 });
    }

    // 3) Tipo del día: lo deriva el servidor. El cliente solo puede forzar el SIGUIENTE hito.
    const hoy = hoyLimaFecha();
    const previa = await marcasDeHoy(sb, usuarioId, hoy);
    if (previa.sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
    const sugerido = tipoSiguiente(previa.marcas);
    if (!sugerido) {
      return NextResponse.json({ ok: false, error: "Ya cerraste tu jornada de hoy." }, { status: 409 });
    }
    let tipo = sugerido;
    if (body.tipo != null) {
      if (!esTipoMarca(body.tipo)) {
        return NextResponse.json({ ok: false, error: "Tipo de marca inválido." }, { status: 400 });
      }
      if (body.tipo !== sugerido) {
        return NextResponse.json({
          ok: false, error: `Ahora te toca marcar "${sugerido}", no "${body.tipo}".`, siguiente: sugerido,
        }, { status: 409 });
      }
      tipo = body.tipo;
    }

    // 4) Geocerca: la MIDE el servidor con la config real, no el cliente.
    const lat = body.lat != null ? Number(body.lat) : null;
    const lng = body.lng != null ? Number(body.lng) : null;
    const precision_m = body.precision_m != null && Number.isFinite(Number(body.precision_m)) ? Number(body.precision_m) : null;
    const geo = validarMarca({ lat, lng, precision_m }, cfg);
    if (cfg.geocerca_bloquea && !geo.dentro_geocerca) {
      return NextResponse.json({
        ok: false, error: "Estás fuera del área de la sede. Acércate para marcar.",
        dentro_geocerca: false, distancia_m: Number.isFinite(geo.distancia_m) ? geo.distancia_m : null,
      }, { status: 403 });
    }

    // 5) Foto al bucket privado (re-encodeada sin EXIF/GPS). Un archivo inválido → 400; un fallo
    //    de Storage → se registra SIN foto (nunca se pierde la marca).
    let fotoPath: string | null = null;
    let fotoOmitida = false;
    if (body.foto) {
      try {
        fotoPath = await subirArrhh(sb, `marcas/${usuarioId}/${hoy}/${tipo}-${crypto.randomUUID()}`, body.foto, "foto");
      } catch (e) {
        if (e instanceof AdjuntoInvalido) return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
        fotoOmitida = true;
      }
    } else {
      fotoOmitida = true;
    }

    // 6) Inserta la marca (degradando columnas accesorias; tabla ausente → 422).
    const fila: Record<string, unknown> = {
      usuario_id: usuarioId,
      tipo,
      lat, lng, precision_m,
      dentro_geocerca: geo.dentro_geocerca,
      distancia_m: Number.isFinite(geo.distancia_m) ? geo.distancia_m : null,
      foto_url: fotoPath,
      rostro_detectado: body.rostro_detectado === true ? true : body.rostro_detectado === false ? false : null,
      metodo: "facial",
      origen: "web",
    };
    const ins = await escribirDegradando("rrhh_marca", fila, (f) =>
      sb.from("rrhh_marca").insert(f).select("*"));
    if (ins.sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
    if (!ins.ok) return NextResponse.json({ ok: false, error: ins.error?.message ?? "No se pudo registrar la marca." }, { status: 500 });

    // 7) Jornada del día recalculada con la marca nueva incluida.
    const ahora = await marcasDeHoy(sb, usuarioId, hoy);
    const jornada = calcularJornada(ahora.marcas, cfg);

    return NextResponse.json({
      ok: true,
      tipo,
      dentro_geocerca: geo.dentro_geocerca,
      distancia_m: Number.isFinite(geo.distancia_m) ? geo.distancia_m : null,
      foto_omitida: fotoOmitida,
      jornada,
    });
  } catch (e: any) {
    console.error("[rrhh/marcar]", e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
