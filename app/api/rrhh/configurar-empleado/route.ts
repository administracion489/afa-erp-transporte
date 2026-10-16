// app/api/rrhh/configurar-empleado/route.ts — RRHH configura la ficha de OTRO empleado.
//
//   POST { usuario_id, marca_asistencia?, hora_entrada?, hora_salida?, tolerancia_min?, almuerzo_min? }
//     (módulo `rrhh`)
//     → marca qué empleados "fichan" (`marca_asistencia`) y les fija un HORARIO propio que
//       sobre-escribe el global de rrhh_config. Un override VACÍO/null borra la columna y el
//       empleado vuelve a HEREDAR el horario global (esa es la semántica de null por-empleado).
//
// Quien configura es RRHH/admin (token con permiso `rrhh`): el `usuario_id` del body es el
// EMPLEADO destino, nunca el llamante. Todas estas son columnas SOLO-BACKEND de empleado_perfil
// (`marca_asistencia` en rrhh-01; las cuatro de horario en rrhh-04), así que su único camino de
// escritura es un endpoint service-role como este — el cliente no las toca (su política RLS no
// tiene UPDATE de esas columnas).
//
// SOLO SE ESCRIBE LO QUE VIENE EN EL BODY: un campo AUSENTE no se toca (el gate es `campo in
// body`, no la verdad del valor); un campo PRESENTE con valor vacío/null SÍ se escribe null (lo
// que apaga el fichaje, o borra el override de horario para heredar el global). Las horas y los
// minutos se VALIDAN antes de escribir (formato/rango): un valor inválido → 400, nunca se guarda
// basura en la base. `escribirDegradando` suelta la columna que la migración aún no creó (p. ej.
// las de rrhh-04 antes de correrlo) y la reporta en `columnas_omitidas`; el resto se guarda.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { escribirDegradando } from "@/lib/rrhh/db";
import { adminRrhh } from "@/lib/rrhh/server";

const SQL = "supabase/rrhh-01-perfil-asistencia.sql";

// Resultado de validar/normalizar un campo del body: o un valor listo para escribir (incluido
// `null`, que BORRA la columna → hereda el global), o un rechazo con su motivo en español (→ 400).
// Nunca se escribe «basura»: un formato de hora o un entero inválido se rechaza, no se guarda.
type Validado = { ok: true; valor: unknown } | { ok: false; error: string };

/** Toggle de asistencia: anything que no sea explícitamente verdadero cae a `false` — el lado
 *  seguro para un interruptor (ante un valor raro no se enciende el fichaje sin querer). Un
 *  `false` explícito del body SÍ se escribe (lo que apaga el fichaje): el gate es `campo in body`,
 *  no la verdad del valor. Nunca rechaza (comportamiento idéntico al de siempre). */
function aBooleano(v: unknown): Validado {
  return { ok: true, valor: v === true || v === "true" || v === 1 || v === "1" };
}

/** Override de una hora del horario (`time` en la base). Acepta "HH:MM" y "HH:MM:SS"; se escribe
 *  normalizada a "HH:MM:SS". Vacío/null → escribe `null` (borra el override → hereda el global),
 *  que se distingue de «campo ausente» (ese ni llega aquí). Un formato u hora fuera de rango se
 *  RECHAZA: mejor un 400 claro que una hora basura en una columna `time`. */
function aHora(v: unknown): Validado {
  if (v === null || v === undefined) return { ok: true, valor: null };
  if (typeof v !== "string") return { ok: false, error: "debe ser una hora 'HH:MM' o 'HH:MM:SS'." };
  const s = v.trim();
  if (s === "") return { ok: true, valor: null }; // vacío = volver a heredar el horario global
  const m = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/.exec(s);
  if (!m) return { ok: false, error: "formato de hora inválido; usa 'HH:MM' o 'HH:MM:SS'." };
  const h = Number(m[1]), min = Number(m[2]), seg = m[3] ? Number(m[3]) : 0;
  if (h > 23) return { ok: false, error: "hora fuera de rango (00:00:00–23:59:59)." };
  const p2 = (n: number) => String(n).padStart(2, "0");
  return { ok: true, valor: `${p2(h)}:${p2(min)}:${p2(seg)}` };
}

/** Override de minutos (tolerancia/almuerzo): entero ≥ 0. Vacío/null → escribe `null` (hereda el
 *  global). Un valor no entero o negativo se RECHAZA. */
function aMinutos(v: unknown): Validado {
  if (v === null || v === undefined) return { ok: true, valor: null };
  const s = typeof v === "string" ? v.trim() : v;
  if (s === "") return { ok: true, valor: null }; // vacío = heredar el global
  const n = typeof s === "number" ? s : Number(s);
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, error: "debe ser un entero de minutos ≥ 0 (o vacío para heredar el global)." };
  }
  return { ok: true, valor: n };
}

// Columnas de configuración que ESTE endpoint sabe escribir en empleado_perfil, cada una con su
// validador/normalizador. `marca_asistencia` (rrhh-01) + el horario por empleado (rrhh-04):
// hora_entrada / hora_salida como "HH:MM(:SS)", tolerancia_min / almuerzo_min como enteros ≥ 0.
// El bucle de abajo recoge SOLO las que vengan en el body; una ausente no se toca.
const CAMPOS: Record<string, (v: unknown) => Validado> = {
  marca_asistencia: aBooleano,
  hora_entrada: aHora,
  hora_salida: aHora,
  tolerancia_min: aMinutos,
  almuerzo_min: aMinutos,
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

    // Solo las columnas de configuración presentes en el body; una ausente no se toca. Un valor
    // presente se VALIDA antes de entrar a la fila: si es inválido se aborta con 400 (no se guarda
    // basura), nombrando el campo. Un vacío/null válido escribe null (borra el override → hereda).
    const fila: Record<string, unknown> = { usuario_id: destino, updated_at: new Date().toISOString() };
    const pedidos: string[] = [];
    for (const [campo, validar] of Object.entries(CAMPOS)) {
      if (!(campo in body)) continue;
      const r = validar(body[campo]);
      if (!r.ok) return NextResponse.json({ ok: false, error: `${campo}: ${r.error}` }, { status: 400 });
      fila[campo] = r.valor;
      pedidos.push(campo);
    }
    if (pedidos.length === 0) {
      return NextResponse.json({ ok: false, error: "No se indicó ningún campo de configuración (marca_asistencia, hora_entrada, hora_salida, tolerancia_min, almuerzo_min)." }, { status: 400 });
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
