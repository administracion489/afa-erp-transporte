// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/horario.ts — MOTOR PURO: el horario EFECTIVO de un empleado.
//
// Un empleado puede tener su propio horario (entra más temprano, almuerza menos) y el
// resto de la empresa el global. Este motor COMBINA los dos CAMPO A CAMPO: el override del
// empleado gana en el campo que trae un valor; donde no dice nada (NULL), ese campo hereda
// el global. No es "o uno o el otro": alguien puede fijar solo su hora de entrada y heredar
// la tolerancia, la salida y el almuerzo de la sede.
//
// PURO: recibe el override (lo que vive en `empleado_perfil`, las 4 columnas nullable que
// agrega rrhh-04) y el `ConfigRrhh` global (fila única de `rrhh_config`, ya resuelto por
// `cargarConfigRrhh`), y devuelve el `ConfigRrhh` efectivo. No lee la base: el lector arma
// el cfg por usuario y se lo pasa a `calcularJornada`, que NO cambia. Ver CLAUDE.md →
// "Motor PURO + lector + matriz".
//
// LA GARANTÍA DURA, y la razón de que exista el motor: un override con los 4 campos en NULL
// ⇒ el efectivo es IDÉNTICO al global, campo a campo. Sin la migración rrhh-04 corrida
// —ninguna fila trae override— todo empleado hereda el global EXACTAMENTE como hoy
// (degradación byte a byte). Por eso un campo NULL pasa el valor del global VERBATIM, sin
// re-normalizarlo: así el efectivo no puede diferir del global ni en un carácter, aunque el
// global se guarde con una forma distinta a la que normalizaríamos.
//
// SOLO LOS 4 CAMPOS DE HORARIO son por-empleado. `sede_lat`/`sede_lng`/`sede_radio_m` y
// `geocerca_bloquea` son de la SEDE, no de la persona, y vienen SIEMPRE del global: un
// empleado no mueve la geocerca de la empresa.
//
// Cada campo DECLARA su FUENTE ("empleado" | "global"), como `lib/costos/rendimiento-tipo.ts`
// declara de dónde salió cada parámetro: así el reporte de jornada puede decir "entra 07:00
// (su horario)" sin que la pantalla lo deduzca comparando contra el global. La fuente es
// "empleado" cuando el override trajo el valor, AUNQUE coincida con el del global: que el
// perfil de la persona lo declare es un hecho distinto de heredarlo.
// ──────────────────────────────────────────────────────────────────────────────

import type { ConfigRrhh } from "./tipos";

/**
 * Lo que vive en `empleado_perfil` (rrhh-04): los 4 campos de horario por empleado, cada uno
 * nullable. NULL/ausente = heredar el global. `hora_*` llega como el `time` de Postgres
 * ("HH:MM:SS", a veces con microsegundos); los `*_min` como enteros. El objeto entero puede
 * ser `null`/`undefined`: un empleado SIN fila de perfil hereda todo el global.
 */
export type OverrideHorario = {
  hora_entrada?: string | null;
  hora_salida?: string | null;
  tolerancia_min?: number | null;
  almuerzo_min?: number | null;
};

/**
 * Los 4 campos que un empleado puede sobreescribir. Declarado UNA sola vez: el combinado, la
 * fuente y la matriz recorren esta misma lista, así no hay una quinta definición escondida.
 */
export const CAMPOS_HORARIO = [
  "hora_entrada",
  "hora_salida",
  "tolerancia_min",
  "almuerzo_min",
] as const;
export type CampoHorario = (typeof CAMPOS_HORARIO)[number];

export type FuenteCampo = "empleado" | "global";
/** De dónde salió cada uno de los 4 campos de horario del efectivo. */
export type FuenteHorario = Record<CampoHorario, FuenteCampo>;

/** El efectivo y la fuente de cada campo, juntos: la fuente no sirve de nada sin el valor. */
export type HorarioEfectivo = { cfg: ConfigRrhh; fuente: FuenteHorario };

/**
 * Normaliza una hora al "HH:MM" que declara `ConfigRrhh`. El `time` de Postgres llega como
 * "HH:MM:SS" (o con microsegundos); aquí se recorta a hora y minuto.
 *
 * SOLO se aplica al valor del OVERRIDE. El del global se pasa VERBATIM (ver la cabecera): así
 * la igualdad byte a byte del caso todo-NULL no depende de que el global ya esté en "HH:MM".
 * No valida ni rellena ceros — una cadena sin forma de hora pasa tal cual y `hhmmAMinutos`
 * (lib/alertas-horario.ts, lo usa `calcularJornada`) la lee como null, el mismo modo en que el
 * resto del ERP degrada una hora ilegible, en vez de inventar una.
 */
function normalizarHora(v: string): string {
  const partes = v.split(":");
  return partes.length <= 2 ? v : `${partes[0]}:${partes[1]}`;
}

/**
 * El horario efectivo de un empleado y la FUENTE de cada campo. Combina campo a campo: el
 * override gana en el campo que trae un valor NO-null; donde es null/undefined, ese campo
 * hereda el global VERBATIM. Los campos de SEDE (geocerca, coordenadas, radio) vienen siempre
 * del global.
 *
 * El test de "trae valor" es `!= null`, no la veracidad: una `tolerancia_min` de 0 (sin gracia)
 * es una config real y GANA sobre el global; tratar el 0 como ausente heredaría la gracia de
 * la sede sin que nadie lo pidiera.
 */
export function horarioEfectivoConFuente(
  override: OverrideHorario | null | undefined,
  cfgGlobal: ConfigRrhh,
): HorarioEfectivo {
  const ov = override ?? {};

  const entrada = ov.hora_entrada;
  const salida = ov.hora_salida;
  const tolerancia = ov.tolerancia_min;
  const almuerzo = ov.almuerzo_min;

  const cfg: ConfigRrhh = {
    ...cfgGlobal,
    hora_entrada: entrada != null ? normalizarHora(String(entrada)) : cfgGlobal.hora_entrada,
    hora_salida: salida != null ? normalizarHora(String(salida)) : cfgGlobal.hora_salida,
    tolerancia_min: tolerancia != null ? tolerancia : cfgGlobal.tolerancia_min,
    almuerzo_min: almuerzo != null ? almuerzo : cfgGlobal.almuerzo_min,
  };

  const fuente: FuenteHorario = {
    hora_entrada: entrada != null ? "empleado" : "global",
    hora_salida: salida != null ? "empleado" : "global",
    tolerancia_min: tolerancia != null ? "empleado" : "global",
    almuerzo_min: almuerzo != null ? "empleado" : "global",
  };

  return { cfg, fuente };
}

/**
 * El `ConfigRrhh` efectivo listo para `calcularJornada` (sin la fuente). Es `…ConFuente(...).cfg`:
 * UNA sola definición del combinado, para que el cfg y su fuente nunca puedan discrepar.
 */
export function horarioEfectivo(
  override: OverrideHorario | null | undefined,
  cfgGlobal: ConfigRrhh,
): ConfigRrhh {
  return horarioEfectivoConFuente(override, cfgGlobal).cfg;
}
