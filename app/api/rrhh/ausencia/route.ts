// app/api/rrhh/ausencia/route.ts — Ausencias (vacaciones, permisos, descansos médicos…).
//
//   POST { accion: "solicitar", tipo, desde, hasta, goce?, motivo?, documento? }  (self, módulo
//         `mi-perfil`)  → crea en estado 'solicitada' a nombre del TOKEN. Documento opcional al
//         bucket privado `rrhh`.
//   POST { accion: "aprobar" | "rechazar", id }  (módulo `rrhh`)  → cambia estado y sella
//         aprobado_por (del token) / aprobado_en.
//
// La identidad del solicitante es la del token (no el body). La aprobación la firma RRHH.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { escribirDegradando } from "@/lib/rrhh/db";
import { adminRrhh, subirArrhh, AdjuntoInvalido } from "@/lib/rrhh/server";
import { tablaFaltante } from "@/lib/columna-faltante";

export const maxDuration = 60;

const SQL = "supabase/rrhh-01-perfil-asistencia.sql";
const TIPOS = ["vacaciones", "permiso", "descanso_medico", "licencia", "falta", "suspension"] as const;
const ES_FECHA = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown> ?? {};
  const accion = body?.accion;

  if (accion === "solicitar") return solicitar(req, body);
  if (accion === "aprobar" || accion === "rechazar") return resolver(req, body, accion);
  return NextResponse.json({ ok: false, error: 'accion debe ser "solicitar", "aprobar" o "rechazar".' }, { status: 400 });
}

async function solicitar(req: NextRequest, body: Record<string, unknown>) {
  const auth = await verificarUsuarioApi(req, "mi-perfil");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const usuarioId = auth.userId;

  const tipo = body.tipo;
  if (!TIPOS.includes(tipo as any)) {
    return NextResponse.json({ ok: false, error: `tipo inválido (${TIPOS.join(", ")}).` }, { status: 400 });
  }
  if (!ES_FECHA(body.desde) || !ES_FECHA(body.hasta)) {
    return NextResponse.json({ ok: false, error: "desde y hasta deben ser fechas (YYYY-MM-DD)." }, { status: 400 });
  }
  if (String(body.hasta).slice(0, 10) < String(body.desde).slice(0, 10)) {
    return NextResponse.json({ ok: false, error: "hasta no puede ser anterior a desde." }, { status: 400 });
  }

  try {
    const sb = adminRrhh();

    // Documento de respaldo opcional (descanso médico, licencia) → bucket privado, guarda ruta.
    // Solo PDF o imagen (re-encodeada sin EXIF/GPS); un tipo/tamaño inválido → 400; un fallo de
    // Storage → la solicitud se registra sin el documento.
    let documentoPath: string | null = null;
    let documentoOmitido = false;
    if (body.documento) {
      try {
        documentoPath = await subirArrhh(sb, `ausencias/${usuarioId}/${crypto.randomUUID()}`, body.documento, "documento");
      } catch (e) {
        if (e instanceof AdjuntoInvalido) return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
        documentoOmitido = true;
      }
    }

    const fila: Record<string, unknown> = {
      usuario_id: usuarioId,
      tipo,
      desde: String(body.desde).slice(0, 10),
      hasta: String(body.hasta).slice(0, 10),
      goce: body.goce === true ? true : body.goce === false ? false : null,
      motivo: typeof body.motivo === "string" ? body.motivo : null,
      documento_url: documentoPath,
      estado: "solicitada",
    };
    const ins = await escribirDegradando("rrhh_ausencia", fila, (f) =>
      sb.from("rrhh_ausencia").insert(f).select("*"));
    if (ins.sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
    if (!ins.ok) return NextResponse.json({ ok: false, error: ins.error?.message ?? "No se pudo registrar." }, { status: 500 });

    return NextResponse.json({ ok: true, ausencia: ins.data, documento_omitido: documentoOmitido });
  } catch (e: any) {
    console.error("[rrhh/ausencia solicitar]", e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}

async function resolver(req: NextRequest, body: Record<string, unknown>, accion: "aprobar" | "rechazar") {
  const auth = await verificarUsuarioApi(req, "rrhh");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "id de ausencia requerido." }, { status: 400 });
  }

  try {
    const sb = adminRrhh();

    // La ausencia tiene que existir (y así distinguimos "no está" de "falta la migración").
    const { data: existe, error: eLeer } = await sb.from("rrhh_ausencia").select("id,estado").eq("id", id).maybeSingle();
    if (eLeer) {
      if (tablaFaltante(eLeer, "rrhh_ausencia")) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
      throw eLeer;
    }
    if (!existe) return NextResponse.json({ ok: false, error: "Ausencia no encontrada." }, { status: 404 });

    // Una ausencia solo se resuelve UNA vez: ya aprobada/rechazada no se vuelve a tocar. Se avisa
    // antes (mensaje claro) y el UPDATE filtra por estado='solicitada' para cerrar la carrera
    // entre dos aprobadores que la leyeron a la vez.
    if (existe.estado !== "solicitada") {
      return NextResponse.json(
        { ok: false, estado: existe.estado, error: `Esta ausencia ya está ${existe.estado}; no se puede volver a resolver.` },
        { status: 409 },
      );
    }

    const patch: Record<string, unknown> = {
      estado: accion === "aprobar" ? "aprobada" : "rechazada",
      aprobado_por: auth.userId, // la firma RRHH es la del token
      aprobado_en: new Date().toISOString(),
    };
    const upd = await escribirDegradando("rrhh_ausencia", patch, (f) =>
      sb.from("rrhh_ausencia").update(f).eq("id", id).eq("estado", "solicitada").select("*"));
    if (upd.sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
    if (!upd.ok) return NextResponse.json({ ok: false, error: upd.error?.message ?? "No se pudo actualizar." }, { status: 500 });
    // El filtro de estado no casó ninguna fila: otra persona la resolvió entre la lectura y el UPDATE.
    if (!upd.data) {
      return NextResponse.json({ ok: false, error: "Esta ausencia acaba de ser resuelta por otra persona." }, { status: 409 });
    }

    return NextResponse.json({ ok: true, ausencia: upd.data });
  } catch (e: any) {
    console.error("[rrhh/ausencia resolver]", e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
