// app/api/campo/autorizaciones/route.ts — Listado de autorizaciones de campo.
//
//   GET (módulo `mi-perfil`): las PROPIAS (las del token), con su estado efectivo derivado.
//   GET ?todas=1            : TODAS (panel de RRHH) — exige ADEMÁS el módulo `rrhh`.
//   GET ?usuario_id=<uuid>  : las de ESE usuario — exige ADEMÁS el módulo `rrhh`.
//
// Sin `todas`/`usuario_id` el objetivo es SIEMPRE el token (un empleado ve si lo rastrean y
// hasta cuándo). El estado 'vigente'/'vencida' lo DERIVA el motor puro con la hora del servidor.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { adminRrhh } from "@/lib/rrhh/server";
import { estadoAutorizacion } from "@/lib/rrhh/campo";
import { listarAutorizaciones, autorizacionesDeUsuario, SQL_CAMPO } from "@/lib/rrhh/campo-datos";

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "mi-perfil");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const sp = req.nextUrl.searchParams;
  const pideOtras = sp.get("todas") === "1" || sp.has("usuario_id");

  // Ver las de OTROS (o de todos) exige el módulo RRHH, aparte del de self.
  let todas = false;
  let objetivo = auth.userId;
  if (pideOtras) {
    const authR = await verificarUsuarioApi(req, "rrhh");
    if (!authR.ok) return NextResponse.json({ ok: false, error: authR.error }, { status: authR.status });
    const u = sp.get("usuario_id");
    if (u) objetivo = u;
    else todas = true;
  }

  try {
    const sb = adminRrhh();
    const { autorizaciones, sinMigracion } = todas
      ? await listarAutorizaciones(sb, {})
      : await autorizacionesDeUsuario(sb, objetivo);
    if (sinMigracion) return NextResponse.json({ ok: true, autorizaciones: [], sin_migracion: SQL_CAMPO });

    const ahora = Date.now();
    const out = autorizaciones.map((a) => ({ ...a, estado_efectivo: estadoAutorizacion(a, ahora) }));
    return NextResponse.json({ ok: true, autorizaciones: out });
  } catch (e: unknown) {
    console.error("[campo/autorizaciones]", e);
    return NextResponse.json({ ok: false, error: (e as { message?: string })?.message ?? "Error" }, { status: 500 });
  }
}
