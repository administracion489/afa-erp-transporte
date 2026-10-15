// app/api/campo/estado/route.ts — ¿Tengo AHORA una autorización de campo vigente?
//
//   GET (módulo `campo`): → { ok, vigente, motivo, autorizacion, sin_migracion? }
//
// La app de campo lo consulta antes de empezar a enviar GPS (y la pantalla lo muestra). El
// usuario es SIEMPRE el del token. El veredicto lo da el motor puro lib/rrhh/campo.ts. Sin la
// migración no hay autorizaciones → no vigente, y se DICE con `sin_migracion` para que la
// pantalla explique qué falta en vez de un 500.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { adminRrhh } from "@/lib/rrhh/server";
import { ventanaCampoVigente } from "@/lib/rrhh/campo";
import { autorizacionesDeUsuario, SQL_CAMPO } from "@/lib/rrhh/campo-datos";

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "campo");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  try {
    const sb = adminRrhh();
    const { autorizaciones, sinMigracion } = await autorizacionesDeUsuario(sb, auth.userId);
    if (sinMigracion) {
      return NextResponse.json({ ok: true, vigente: false, motivo: "sin_autorizacion", autorizacion: null, sin_migracion: SQL_CAMPO });
    }
    const v = ventanaCampoVigente(autorizaciones, Date.now());
    return NextResponse.json({ ok: true, vigente: v.vigente, motivo: v.motivo, autorizacion: v.autorizacion });
  } catch (e: unknown) {
    console.error("[campo/estado]", e);
    return NextResponse.json({ ok: false, error: (e as { message?: string })?.message ?? "Error" }, { status: 500 });
  }
}
