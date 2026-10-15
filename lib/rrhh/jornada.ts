// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/jornada.ts — MOTOR PURO: de las marcas del día a horas, tardanza y estado.
//
// EL CRUCE DE MEDIANOCHE SE RESUELVE SOLO, y por eso no hay caso especial. Las marcas
// llevan un INSTANTE completo (ISO con fecha), así que un turno 22:00 → 06:00 tiene
// `salida_ms > entrada_ms` por los propios timestamps. Medir con "HH:MM" sueltos sería
// el bug. Lo que SÍ es una pregunta de reloj-de-día —tardanza y salida temprana contra
// una hora de referencia— se mide con el minuto del día Lima, y ahí hay un LÍMITE
// DECLARADO: para un turno nocturno cuya hora de referencia está antes de medianoche,
// esas dos cifras no son fiables (la Fase 1 es personal de oficina, turno de día).
//
// LAS FUNCIONES DE HORA NO SE REESCRIBEN. `minutoDelDiaLima`/`hhmmAMinutos` ya son el
// desplazamiento único a UTC-5 (lib/alertas-horario.ts, PURO). No se importan de
// lib/alertas.ts porque ese módulo crea un cliente Supabase al cargar (rompería la
// pureza y la matriz); lib/alertas.ts mismo delega en lib/alertas-horario.ts.
// ──────────────────────────────────────────────────────────────────────────────

import { minutoDelDiaLima, hhmmAMinutos } from "@/lib/alertas-horario";
import type {
  CodigoJornada,
  ConfigRrhh,
  EstadoJornada,
  Marca,
  ResultadoJornada,
  TipoMarca,
} from "./tipos";
import { esTipoMarca } from "./marcacion";

/**
 * Biyección DECLARADA estado ↔ código. Cada código nombra el porqué, no se olfatea
 * del nombre del estado. La matriz fija que es una biyección (inyectiva y sobre).
 */
export const CODIGO_JORNADA: Record<EstadoJornada, CodigoJornada> = {
  completa: "ok",
  en_curso: "en_curso",
  incompleta: "falta_entrada",
  sin_marcas: "sin_marcas",
};

const MS_HORA = 3_600_000;

function msDe(iso?: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Redondeo a centésimas (de hora o de hora de almuerzo). */
function cent(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Horas, almuerzo, tardanza, salida temprana y estado de una jornada a partir de sus
 * marcas y la config. Puro: sin base, sin "ahora". Para un día sin cerrar (sin salida)
 * NO se fabrica una hora de salida — `horas_trabajadas = 0` y estado `en_curso`.
 *
 * Representante de cada hito cuando hay duplicados (no debería haberlos): entrada y
 * salida de almuerzo = la MÁS TEMPRANA; salida y regreso de almuerzo = la MÁS TARDÍA.
 * Es la lectura más ancha (día más largo, almuerzo más largo), que nunca sobre-paga.
 */
export function calcularJornada(
  marcas: ReadonlyArray<Marca> | null | undefined,
  cfg: ConfigRrhh,
): ResultadoJornada {
  const base = (estado: EstadoJornada, patch: Partial<ResultadoJornada> = {}): ResultadoJornada => ({
    horas_trabajadas: 0,
    horas_almuerzo: 0,
    tardanza_min: 0,
    salida_temprana_min: 0,
    estado,
    codigo: CODIGO_JORNADA[estado],
    almuerzo_estimado: false,
    ...patch,
  });

  const utiles = (marcas ?? []).filter((m) => esTipoMarca(m?.tipo) && msDe(m?.marcado_en) != null);
  if (utiles.length === 0) return base("sin_marcas");

  const msDeTipo = (tipo: TipoMarca, pick: "min" | "max"): number | null => {
    const ts = utiles
      .filter((m) => m.tipo === tipo)
      .map((m) => msDe(m.marcado_en) as number)
      .sort((a, b) => a - b);
    if (ts.length === 0) return null;
    return pick === "min" ? ts[0] : ts[ts.length - 1];
  };

  const entrada = msDeTipo("entrada", "min");
  const salida = msDeTipo("salida", "max");
  const salAlm = msDeTipo("salida_almuerzo", "min");
  const regAlm = msDeTipo("regreso_almuerzo", "max");

  // Sin entrada no hay con qué medir la jornada: día roto, no se juzga parcialmente.
  if (entrada == null) return base("incompleta");

  // Tardanza: computable con solo la entrada (se puede saber antes de que se vaya).
  const horaEntradaMin = hhmmAMinutos(cfg?.hora_entrada);
  const tol = Number.isFinite(cfg?.tolerancia_min) ? Math.max(0, Number(cfg.tolerancia_min)) : 0;
  let tardanza = 0;
  if (horaEntradaMin != null) {
    tardanza = Math.max(0, minutoDelDiaLima(entrada) - horaEntradaMin - tol);
  }

  // Día sin cerrar: no se fabrica una salida. Se reporta la tardanza ya conocida.
  if (salida == null) return base("en_curso", { tardanza_min: tardanza });

  // Jornada completa.
  const horaSalidaMin = hhmmAMinutos(cfg?.hora_salida);
  const salidaTemprana = horaSalidaMin != null
    ? Math.max(0, horaSalidaMin - minutoDelDiaLima(salida))
    : 0;

  const brutoMs = Math.max(0, salida - entrada); // salida < entrada = corrupto → 0

  // Almuerzo: real solo si vino el PAR completo; si falta uno o los dos, descuento default.
  const parCompleto = salAlm != null && regAlm != null;
  const almMs = parCompleto
    ? Math.max(0, regAlm - salAlm)
    : Math.max(0, (Number.isFinite(cfg?.almuerzo_min) ? Number(cfg.almuerzo_min) : 0)) * 60_000;

  const horasTrabajadas = Math.max(0, (brutoMs - almMs) / MS_HORA);

  return base("completa", {
    horas_trabajadas: cent(horasTrabajadas),
    horas_almuerzo: cent(almMs / MS_HORA),
    tardanza_min: tardanza,
    salida_temprana_min: salidaTemprana,
    almuerzo_estimado: !parCompleto,
  });
}
