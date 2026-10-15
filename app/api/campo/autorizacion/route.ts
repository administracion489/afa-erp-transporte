// app/api/campo/autorizacion/route.ts — Flujo de autorización de rastreo en CAMPO (Fase 2).
//
//   POST { accion: "solicitar", motivo, vigente_desde?, vigente_hasta? }  (self, módulo `mi-perfil`)
//       → crea en estado 'solicitada' a nombre del TOKEN. El motivo es obligatorio: rastrear a
//         una persona exige una razón registrada.
//   POST { accion: "aprobar" | "rechazar", id, vigente_desde?, vigente_hasta?, nota? }  (módulo `rrhh`)
//       → sella estado, aprobado_por (del TOKEN) y aprobado_en; al APROBAR fija la ventana de
//         vigencia (vigente_desde/vigente_hasta). Guard: solo resuelve si estaba 'solicitada'
//         (si no, 409), y el UPDATE filtra por estado='solicitada' para cerrar la carrera.
//
// La identidad del solicitante y la del aprobador salen del token, nunca del cuerpo.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { escribirDegradando } from "@/lib/rrhh/db";
import { adminRrhh } from "@/lib/rrhh/server";
import { autorizacionPorId, SQL_CAMPO } from "@/lib/rrhh/campo-datos";

export const maxDuration = 30;

const TABLA = "rrhh_autorizacion_campo";

/** ¿Es un instante parseable? (ISO-8601 con o sin hora, o lo que acepte Date). */
const esInstante = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && Number.isFinite(Date.parse(v));

export async function POST(req: NextRequest) {
  const body = ((await req.json().catch(() => ({}))) as Record<string, unknown>) ?? {};
  const accion = body?.accion;
  if (accion === "solicitar") return solicitar(req, body);
  if (accion === "aprobar" || accion === "rechazar") return resolver(req, body, accion);
  return NextResponse.json({ ok: false, error: 'accion debe ser "solicitar", "aprobar" o "rechazar".' }, { status: 400 });
}

async function solicitar(req: NextRequest, body: Record<string, unknown>) {
  const auth = await verificarUsuarioApi(req, "mi-perfil");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const motivo = typeof body.motivo === "string" ? body.motivo.trim() : "";
  if (!motivo) {
    return NextResponse.json({ ok: false, error: "Indica el motivo del trabajo en campo (por qué te van a rastrear)." }, { status: 400 });
  }
  if (body.vigente_desde != null && !esInstante(body.vigente_desde)) {
    return NextResponse.json({ ok: false, error: "vigente_desde debe ser una fecha/hora válida." }, { status: 400 });
  }
  if (body.vigente_hasta != null && !esInstante(body.vigente_hasta)) {
    return NextResponse.json({ ok: false, error: "vigente_hasta debe ser una fecha/hora válida." }, { status: 400 });
  }
  if (esInstante(body.vigente_desde) && esInstante(body.vigente_hasta) && Date.parse(body.vigente_hasta) < Date.parse(body.vigente_desde)) {
    return NextResponse.json({ ok: false, error: "vigente_hasta no puede ser anterior a vigente_desde." }, { status: 400 });
  }

  try {
    const sb = adminRrhh();
    const fila: Record<string, unknown> = {
      usuario_id: auth.userId, // IDENTIDAD = token
      motivo,
      vigente_desde: esInstante(body.vigente_desde) ? body.vigente_desde : null,
      vigente_hasta: esInstante(body.vigente_hasta) ? body.vigente_hasta : null,
      estado: "solicitada",
    };
    const ins = await escribirDegradando(TABLA, fila, (f) => sb.from(TABLA).insert(f).select("*"));
    if (ins.sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL_CAMPO }, { status: 422 });
    if (!ins.ok) return NextResponse.json({ ok: false, error: ins.error?.message ?? "No se pudo registrar la solicitud." }, { status: 500 });
    return NextResponse.json({ ok: true, autorizacion: ins.data });
  } catch (e: unknown) {
    console.error("[campo/autorizacion solicitar]", e);
    return NextResponse.json({ ok: false, error: (e as { message?: string })?.message ?? "Error" }, { status: 500 });
  }
}

async function resolver(req: NextRequest, body: Record<string, unknown>, accion: "aprobar" | "rechazar") {
  const auth = await verificarUsuarioApi(req, "rrhh");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "id de autorización requerido." }, { status: 400 });
  }
  // La ventana (al aprobar) tiene que ser válida si se manda.
  if (body.vigente_desde != null && !esInstante(body.vigente_desde)) {
    return NextResponse.json({ ok: false, error: "vigente_desde debe ser una fecha/hora válida." }, { status: 400 });
  }
  if (body.vigente_hasta != null && !esInstante(body.vigente_hasta)) {
    return NextResponse.json({ ok: false, error: "vigente_hasta debe ser una fecha/hora válida." }, { status: 400 });
  }
  if (esInstante(body.vigente_desde) && esInstante(body.vigente_hasta) && Date.parse(body.vigente_hasta) < Date.parse(body.vigente_desde)) {
    return NextResponse.json({ ok: false, error: "vigente_hasta no puede ser anterior a vigente_desde." }, { status: 400 });
  }

  try {
    const sb = adminRrhh();

    // Tiene que existir (y así «no está» se distingue de «falta la migración»).
    const { fila, sinMigracion } = await autorizacionPorId(sb, id);
    if (sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL_CAMPO }, { status: 422 });
    if (!fila) return NextResponse.json({ ok: false, error: "Autorización no encontrada." }, { status: 404 });

    // Solo se resuelve una vez. Se avisa antes y el UPDATE filtra por 'solicitada' (carrera).
    if (fila.estado !== "solicitada") {
      return NextResponse.json(
        { ok: false, estado: fila.estado, error: `Esta autorización ya está ${fila.estado}; no se puede volver a resolver.` },
        { status: 409 },
      );
    }

    const patch: Record<string, unknown> = {
      estado: accion === "aprobar" ? "aprobada" : "rechazada",
      aprobado_por: auth.userId, // la firma = token
      aprobado_en: new Date().toISOString(),
      nota: typeof body.nota === "string" ? body.nota : null,
    };
    // Al APROBAR se fija la ventana (si no se manda, queda null y no estará vigente hasta fijarla).
    if (accion === "aprobar") {
      if (esInstante(body.vigente_desde)) patch.vigente_desde = body.vigente_desde;
      if (esInstante(body.vigente_hasta)) patch.vigente_hasta = body.vigente_hasta;
    }

    const upd = await escribirDegradando(TABLA, patch, (f) =>
      sb.from(TABLA).update(f).eq("id", id).eq("estado", "solicitada").select("*"));
    if (upd.sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL_CAMPO }, { status: 422 });
    if (!upd.ok) return NextResponse.json({ ok: false, error: upd.error?.message ?? "No se pudo actualizar." }, { status: 500 });
    if (!upd.data) {
      return NextResponse.json({ ok: false, error: "Esta autorización acaba de ser resuelta por otra persona." }, { status: 409 });
    }

    return NextResponse.json({ ok: true, autorizacion: upd.data });
  } catch (e: unknown) {
    console.error("[campo/autorizacion resolver]", e);
    return NextResponse.json({ ok: false, error: (e as { message?: string })?.message ?? "Error" }, { status: 500 });
  }
}
