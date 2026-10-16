// app/api/rrhh/rostro-ref/route.ts — RRHH ve y resetea la plantilla facial de un empleado.
//
//   GET    ?usuario_id=<uuid> → { ok, enrolado, enrolado_en, foto_url_firmada }. Dice SOLO si
//          hay plantilla, cuándo se enroló y la foto FIRMADA (bucket privado). NUNCA el
//          descriptor: la plantilla biométrica no sale del servidor ni aun cifrada.
//   DELETE ?usuario_id=<uuid> → borra la fila de rrhh_rostro_ref (resetea; la próxima marca
//          re-enrola). { ok, borrado }.
//
// Ver/resetear a OTROS es función de RRHH, así que el llamante se autoriza SIEMPRE con el módulo
// `rrhh` (el gate de UI es evadible; el permiso se re-verifica aquí). rrhh_rostro_ref va con RLS
// deny-all (0 políticas): SOLO la toca la service-role (adminRrhh).

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { adminRrhh, firmarRutaRrhh } from "@/lib/rrhh/server";
import { tablaFaltante } from "@/lib/columna-faltante";

const SQL = "supabase/rrhh-03-rostro-verificacion.sql";

// usuario_id tiene que ser un uuid: un valor cualquiera haría fallar el filtro con un error de
// cast que se leería como 500. Permisivo de versión (acepta el v4 de gen_random_uuid()).
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function usuarioIdValido(req: NextRequest): string | null {
  const v = (req.nextUrl.searchParams.get("usuario_id") ?? "").trim();
  return RE_UUID.test(v) ? v : null;
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "rrhh");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const usuarioId = usuarioIdValido(req);
  if (!usuarioId) return NextResponse.json({ ok: false, error: "usuario_id (uuid) requerido." }, { status: 400 });

  try {
    const sb = adminRrhh();

    // Nunca `descriptor_cifrado`: solo si existe la fila, cuándo se enroló y la ruta de la foto.
    const { data, error } = await sb
      .from("rrhh_rostro_ref")
      .select("foto_url, enrolado_en")
      .eq("usuario_id", usuarioId)
      .maybeSingle();

    if (error) {
      // Sin la migración rrhh-03 no hay enrolamiento facial: se dice, no es un 500.
      if (tablaFaltante(error, "rrhh_rostro_ref")) {
        return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
      }
      throw error; // una lectura que falla por OTRA causa no es «no existe».
    }

    if (!data) {
      return NextResponse.json({ ok: true, enrolado: false, enrolado_en: null, foto_url_firmada: null });
    }

    const fotoFirmada = await firmarRutaRrhh(sb, (data as any).foto_url);
    return NextResponse.json({
      ok: true,
      enrolado: true,
      enrolado_en: (data as any).enrolado_en ?? null,
      foto_url_firmada: fotoFirmada,
    });
  } catch (e: any) {
    console.error("[rrhh/rostro-ref GET]", e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "rrhh");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const usuarioId = usuarioIdValido(req);
  if (!usuarioId) return NextResponse.json({ ok: false, error: "usuario_id (uuid) requerido." }, { status: 400 });

  try {
    const sb = adminRrhh();

    // `.select()` tras el delete devuelve las filas borradas (la service-role salta el RLS):
    // así `borrado` es un hecho, no una suposición. Borrar una fila inexistente no es error.
    const { data, error } = await sb
      .from("rrhh_rostro_ref")
      .delete()
      .eq("usuario_id", usuarioId)
      .select("usuario_id");

    if (error) {
      if (tablaFaltante(error, "rrhh_rostro_ref")) {
        return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
      }
      throw error; // un borrado que falla por OTRA causa no es «no existe».
    }

    return NextResponse.json({ ok: true, borrado: (data?.length ?? 0) > 0 });
  } catch (e: any) {
    console.error("[rrhh/rostro-ref DELETE]", e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
