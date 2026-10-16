// app/api/rrhh/configurar-empleado/route.ts — RRHH configura la ficha de OTRO empleado.
//
//   POST { usuario_id, marca_asistencia? }  (módulo `rrhh`)
//     → marca qué empleados "fichan" (encienden/apagan `marca_asistencia` en su perfil).
//
// Quien configura es RRHH/admin (token con permiso `rrhh`): el `usuario_id` del body es el
// EMPLEADO destino, nunca el llamante. `marca_asistencia` es una columna SOLO-BACKEND de
// empleado_perfil (rrhh-01), así que su único camino de escritura es un endpoint service-role
// como este — el cliente no la toca (su política RLS no tiene UPDATE de esa columna).
//
// FÁCIL DE EXTENDER: la fase de horario añadirá hora_entrada / hora_salida / tolerancia_min /
// almuerzo_min a empleado_perfil y a la tabla CAMPOS de abajo; el bucle los recogerá SOLO cuando
// vengan en el body (un campo ausente no se toca) y `escribirDegradando` soltará el que falte
// mientras esa migración posterior no esté corrida. AHORA solo se implementa `marca_asistencia`.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { escribirDegradando } from "@/lib/rrhh/db";
import { adminRrhh } from "@/lib/rrhh/server";

const SQL = "supabase/rrhh-01-perfil-asistencia.sql";

/** Toggle de asistencia: anything que no sea explícitamente verdadero cae a `false` — el lado
 *  seguro para un interruptor (ante un valor raro no se enciende el fichaje sin querer). Un
 *  `false` explícito del body SÍ se escribe (lo que apaga el fichaje): el gate es `campo in body`,
 *  no la verdad del valor. */
function aBooleano(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

// Columnas de configuración que ESTE endpoint sabe escribir en empleado_perfil, cada una con su
// normalizador. Hoy solo `marca_asistencia`; la fase de horario añade aquí las cuatro columnas
// nuevas con su normalizador (int para tolerancia_min/almuerzo_min, "HH:MM" para las horas).
const CAMPOS: Record<string, (v: unknown) => unknown> = {
  marca_asistencia: aBooleano,
};

export async function POST(req: NextRequest) {
  // Autoriza al LLAMANTE (RRHH), no al usuario_id del body: el llamante configura a otros.
  const auth = await verificarUsuarioApi(req, "rrhh");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const sb = adminRrhh();

    const destino = String(body.usuario_id ?? "").trim();
    if (!destino) return NextResponse.json({ ok: false, error: "usuario_id (empleado) requerido." }, { status: 400 });

    // El empleado destino tiene que existir. Una lectura que FALLA no es "no existe": se aborta
    // (la lanza el catch → 500) en vez de escribir un perfil huérfano de un usuario que no está.
    const { data: usu, error: usuErr } = await sb
      .from("usuarios").select("id").eq("id", destino).maybeSingle();
    if (usuErr) throw usuErr;
    if (!usu) return NextResponse.json({ ok: false, error: "El empleado indicado no existe." }, { status: 404 });

    // Solo las columnas de configuración presentes en el body; una ausente no se toca.
    const fila: Record<string, unknown> = { usuario_id: destino, updated_at: new Date().toISOString() };
    const pedidos: string[] = [];
    for (const [campo, normalizar] of Object.entries(CAMPOS)) {
      if (campo in body) { fila[campo] = normalizar(body[campo]); pedidos.push(campo); }
    }
    if (pedidos.length === 0) {
      return NextResponse.json({ ok: false, error: "No se indicó ningún campo de configuración (marca_asistencia)." }, { status: 400 });
    }

    // UPSERT por usuario_id (PK): una ficha por empleado. `escribirDegradando` suelta SOLO la
    // columna accesoria que el error NOMBRA (p. ej. las de horario antes de su migración) y
    // reintenta; si falta la tabla entera, `sinMigracion` → 422.
    const up = await escribirDegradando("empleado_perfil", fila, (f) =>
      sb.from("empleado_perfil").upsert(f, { onConflict: "usuario_id" }));
    if (up.sinMigracion) return NextResponse.json({ ok: false, sin_migracion: SQL }, { status: 422 });
    if (!up.ok) return NextResponse.json({ ok: false, error: up.error?.message ?? "No se pudo guardar la configuración." }, { status: 500 });

    // La respuesta solo publica lo que de verdad se guardó (sin las columnas soltadas) y nunca
    // datos sensibles: no se devuelve la fila del perfil (sueldo/PIN no viven aquí, pero tampoco
    // se filtran los demás datos de contacto). `columnas_omitidas` avisa si algo no se persistió.
    const omitidas = new Set(up.columnasOmitidas);
    const aplicado: Record<string, unknown> = {};
    for (const campo of pedidos) if (!omitidas.has(campo)) aplicado[campo] = fila[campo];

    return NextResponse.json({ ok: true, usuario_id: destino, aplicado, columnas_omitidas: up.columnasOmitidas });
  } catch (e: any) {
    console.error("[rrhh/configurar-empleado]", e);
    return NextResponse.json({ ok: false, error: e?.message ?? "Error" }, { status: 500 });
  }
}
