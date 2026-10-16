// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/estado-presencia.ts — MOTOR PURO: el ESTADO de presencia de un empleado HOY,
// para el panel "¿Quién está?". Sin base, sin fetch, sin reloj: `ahoraMin` lo pasa el
// llamador (minutos desde medianoche en hora Lima; para "ahora" en Perú, con la hora Lima
// pura de lib/alertas-horario.ts — la misma que usa calcularJornada).
//
// SE DERIVA DEL CONJUNTO DE MARCAS, NO DEL ORDEN DE LLEGADA. Igual que `tipoSiguiente`
// (lib/rrhh/marcacion.ts), el veredicto mira QUÉ marcas existen, no en qué orden llegaron:
// barajar el array no puede cambiar el estado. `salida` es TERMINAL y gana sobre todo.
//
// LAS MARCAS SON HECHOS Y MANDAN. Por eso "con `salida` presente → `salio` SIEMPRE" y
// "sin `cfg`/clase → `sin_dato`" NO se contradicen: `sin_dato` solo vive en la rama SIN
// marca determinante. Una marca de salida dice que la persona se fue — eso no es una duda,
// pase lo que pase con la config o con la clase.
//
// LA cfg SE CONSULTA SOLO DONDE EL VEREDICTO DEPENDE DE ELLA:
//   · la tardanza del `presente` (hora de la entrada contra `hora_entrada + tolerancia`), y
//   · el corte del administrativo sin marca (¿aún es temprano o ya debió marcar?).
// El conductor (presencia por servicios) y el campo (ventana vigente) NO necesitan cfg, así
// que su veredicto sale sin ella. "No afirmes lo que no sabes" aplicado con precisión: solo
// hay `sin_dato` donde de verdad falta el dato para decidir.
//
// LA PRECEDENCIA DE LA RAMA SIN MARCA ES LA DE `debeFichar` (conductor > campo > administrativo).
// Quién resuelve su presencia de qué forma es UNA sola regla; escribirla aquí distinta de
// fichador.ts sería el bug del semáforo —dos módulos contestando distinto de la misma persona—.
//
// LAS FUNCIONES DE HORA NO SE REESCRIBEN. `minutoDelDiaLima`/`hhmmAMinutos` ya son el
// desplazamiento único a UTC-5 (lib/alertas-horario.ts, PURO), los mismos que mide
// calcularJornada para la tardanza. `esTipoMarca` es la definición única de "tipo válido".
// ──────────────────────────────────────────────────────────────────────────────

import { minutoDelDiaLima, hhmmAMinutos } from "@/lib/alertas-horario";
import { esTipoMarca } from "./marcacion";
import type { ConfigRrhh, TipoMarca } from "./tipos";
import type { ClaseFicha } from "./perfil-datos";

/** Una marca del día, tal como la mira este motor: su `tipo` y el INSTANTE en que se marcó.
 *  `marcado_en` es ISO-8601 con fecha (como `Marca`); tolerante a ausencia/basura, porque sin
 *  una hora usable la tardanza no se puede afirmar. El motor nunca lee `lat`/`lng`. */
export type MarcaPresencia = { tipo: TipoMarca | string; marcado_en?: string | null };

/** El estado de presencia que ve el panel "¿Quién está?". */
export type EstadoPresencia =
  | "ausente"
  | "presente"
  | "en_almuerzo"
  | "salio"
  | "en_campo"
  | "en_servicio"
  | "sin_marca_aun"
  | "sin_dato";

/**
 * El porqué DECLARADO del veredicto (string corto y estable). Cada código nombra la razón:
 *  `salio` — hay marca de salida (terminal);
 *  `en_almuerzo` — salió a almorzar y no ha regresado;
 *  `tarde` / `a_tiempo` — marcó entrada; la hora de esa entrada pasa / no pasa el corte;
 *  `sin_hora_entrada` — marcó entrada pero no se pudo juzgar la tardanza (la entrada no trae
 *     hora usable, o la cfg no trae `hora_entrada`): LÍMITE declarado, no se afirma tardanza;
 *  `en_servicio` — conductor con un servicio en curso ahora;
 *  `conductor_sin_servicio` — conductor sin servicio en curso → ausente;
 *  `en_campo` — hay una ventana de campo vigente: trabaja lejos de la sede;
 *  `sin_marca_aun` — administrativo que ficha, aún dentro de la gracia de entrada;
 *  `ausente_sin_marca` — administrativo que ficha, ya pasó la gracia y no marcó → ausente;
 *  `sin_cfg` — administrativo sin marca pero no hay `hora_entrada` para medir el corte → sin_dato;
 *  `sin_hora_actual` — administrativo sin marca y `ahoraMin` no es un número usable → sin_dato;
 *  `sin_clase` — no se pudo derivar la clase (ni conductor, ni campo, ni administrativo) → sin_dato.
 */
export type CodigoPresencia =
  | "salio"
  | "en_almuerzo"
  | "tarde"
  | "a_tiempo"
  | "sin_hora_entrada"
  | "en_servicio"
  | "conductor_sin_servicio"
  | "en_campo"
  | "sin_marca_aun"
  | "ausente_sin_marca"
  | "sin_cfg"
  | "sin_hora_actual"
  | "sin_clase";

export type ResultadoPresencia = {
  estado: EstadoPresencia;
  /** Llegó tarde. Se juzga SOLO en el veredicto `presente` (es el estado de AHORA; la tardanza
   *  histórica —también de quien fue a almorzar o ya salió— la da `calcularJornada`). En
   *  cualquier otro estado es `false`. */
  llego_tarde: boolean;
  codigo: CodigoPresencia;
};

/**
 * El estado SE DERIVA del código, una sola fuente. El motor elige un código; el estado sale
 * de este mapa. Así no se pueden desincronizar (la matriz fija que todo resultado cumple
 * `ESTADO_DE_CODIGO[codigo] === estado`). Mismo patrón que `CODIGO_JORNADA` en jornada.ts.
 */
export const ESTADO_DE_CODIGO: Record<CodigoPresencia, EstadoPresencia> = {
  salio: "salio",
  en_almuerzo: "en_almuerzo",
  tarde: "presente",
  a_tiempo: "presente",
  sin_hora_entrada: "presente",
  en_servicio: "en_servicio",
  conductor_sin_servicio: "ausente",
  en_campo: "en_campo",
  sin_marca_aun: "sin_marca_aun",
  ausente_sin_marca: "ausente",
  sin_cfg: "sin_dato",
  sin_hora_actual: "sin_dato",
  sin_clase: "sin_dato",
};

/** Lo que recibe el motor. Todo ya resuelto por el llamador; el motor no lee la base ni el reloj.
 *  `campo_vigente` lo decide `ventanaCampoVigente` (lib/rrhh/campo.ts); `presenciaConductor`,
 *  `presenciaDeServicios` (lib/rrhh/asistencia-conductor.ts); `clase`, la ficha (perfil-datos.ts). */
export type EntradaPresencia = {
  marcasHoy: ReadonlyArray<MarcaPresencia> | null | undefined;
  cfg: ConfigRrhh | null | undefined;
  /** Minutos desde medianoche en hora Lima (lo pasa el llamador; el motor no mira el reloj). */
  ahoraMin: number;
  clase: ClaseFicha;
  campo_vigente: boolean;
  /** ¿El conductor está en un servicio AHORA? Opcional; `undefined`/`false` = no en servicio. */
  presenciaConductor?: boolean;
};

/** Parse tolerante de un instante ISO (o nada) a epoch-ms. `null` = sin hora usable. */
function msDe(iso?: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Minutos de tolerancia de la cfg, nunca negativos; 0 si falta (mismo criterio que jornada.ts). */
function tolDe(cfg: ConfigRrhh | null | undefined): number {
  return Number.isFinite(cfg?.tolerancia_min) ? Math.max(0, Number(cfg!.tolerancia_min)) : 0;
}

/** El ms de la entrada MÁS TEMPRANA (si hay duplicados), o null si ninguna trae hora usable.
 *  La "más temprana" se elige por timestamp, NO por posición en el array: así el orden de
 *  llegada no cambia la tardanza. Misma elección que `calcularJornada` (entrada = la mínima). */
function msEntradaMasTemprana(marcas: ReadonlyArray<MarcaPresencia> | null | undefined): number | null {
  let min: number | null = null;
  for (const m of marcas ?? []) {
    if (m?.tipo !== "entrada") continue;
    const ms = msDe(m?.marcado_en);
    if (ms == null) continue;
    if (min == null || ms < min) min = ms;
  }
  return min;
}

/**
 * Estado de presencia de un empleado HOY. En ESTE orden (gana el primero que aplica):
 *
 *   1. hay `salida`                         → `salio`           (terminal: las marcas mandan).
 *   2. hay `salida_almuerzo` sin `regreso`  → `en_almuerzo`.
 *   3. hay `entrada`                        → `presente` (+ tardanza si se puede juzgar).
 *   4. sin marca determinante, la CLASE decide (orden de `debeFichar`):
 *        a. conductor      → `en_servicio` (presenciaConductor) / `ausente`  [no mira cfg].
 *        b. campo_vigente  → `en_campo`                                       [no mira cfg].
 *        c. administrativo → `sin_marca_aun` (ahora ≤ hora_entrada+tol) / `ausente`.
 *        d. clase no derivable → `sin_dato`.
 *   · sin la cfg/el dato que la rama 4c necesita → `sin_dato`, no un estado inventado.
 *
 * Las ramas 1–3 derivan del CONJUNTO de marcas (el orden del array no importa). Una marca con
 * `tipo` corrupto se ignora (`esTipoMarca`): no existe para el conjunto.
 */
export function estadoPresencia(e: EntradaPresencia): ResultadoPresencia {
  const res = (codigo: CodigoPresencia, llego_tarde = false): ResultadoPresencia => ({
    estado: ESTADO_DE_CODIGO[codigo],
    llego_tarde,
    codigo,
  });

  // El CONJUNTO de marcas válidas (ignora tipos corruptos; el orden de llegada no se mira).
  const presentes = new Set<TipoMarca>();
  for (const m of e?.marcasHoy ?? []) {
    if (esTipoMarca(m?.tipo)) presentes.add(m.tipo as TipoMarca);
  }

  // 1 · La salida es TERMINAL y gana sobre todo (incluso sin cfg ni clase).
  if (presentes.has("salida")) return res("salio");

  // 2 · Salió a almorzar y no ha regresado.
  if (presentes.has("salida_almuerzo") && !presentes.has("regreso_almuerzo")) {
    return res("en_almuerzo");
  }

  // 3 · Marcó entrada → presente. La tardanza se juzga con la hora REAL de la entrada; si no
  //     se puede (sin hora usable o sin `hora_entrada`), se declara el límite y no se afirma.
  if (presentes.has("entrada")) {
    const horaEntradaMin = hhmmAMinutos(e?.cfg?.hora_entrada);
    const msEntrada = msEntradaMasTemprana(e?.marcasHoy);
    if (horaEntradaMin == null || msEntrada == null) return res("sin_hora_entrada");
    const tarde = minutoDelDiaLima(msEntrada) > horaEntradaMin + tolDe(e?.cfg);
    return res(tarde ? "tarde" : "a_tiempo", tarde);
  }

  // 4 · Sin marca determinante: la clase decide (mismo orden que `debeFichar`).
  // 4a · El conductor no ficha: su presencia sale de los servicios (no mira cfg).
  if (e.clase === "conductor") {
    return res(e.presenciaConductor === true ? "en_servicio" : "conductor_sin_servicio");
  }
  // 4b · Ventana de campo vigente: trabaja lejos de la sede (no mira cfg; gana sobre 4c).
  if (e.campo_vigente === true) {
    return res("en_campo");
  }
  // 4c · Administrativo que ficha: ¿aún dentro de la gracia de entrada, o ya debió marcar?
  if (e.clase === "administrativo") {
    const horaEntradaMin = hhmmAMinutos(e?.cfg?.hora_entrada);
    if (horaEntradaMin == null) return res("sin_cfg");
    if (!Number.isFinite(e?.ahoraMin)) return res("sin_hora_actual");
    const corte = horaEntradaMin + tolDe(e?.cfg);
    return res(Number(e.ahoraMin) <= corte ? "sin_marca_aun" : "ausente_sin_marca");
  }
  // 4d · No se pudo derivar la clase (ni conductor, ni campo, ni administrativo).
  return res("sin_clase");
}
