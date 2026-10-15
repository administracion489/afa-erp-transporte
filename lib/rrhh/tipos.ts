// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/tipos.ts — tipos compartidos de RRHH (Fase 1): marcación con geocerca,
// cálculo de jornada, saldo de vacaciones y presencia del conductor.
//
// Estos tipos son el CONTRATO entre los motores puros de `lib/rrhh/*` y quien los
// consume (el gate de la cámara del frontend, las rutas API, los reportes). Ningún
// motor de RRHH lee la base: reciben datos y devuelven decisiones con un `codigo`
// declarado. Ver CLAUDE.md → "Motor PURO + lector + matriz".
// ──────────────────────────────────────────────────────────────────────────────

import type { RegimenLaboral } from "@/lib/costeo-conductor";

// ── Marcación ───────────────────────────────────────────────────────────────────

/**
 * Los cuatro hitos del día laboral, EN ORDEN. El orden es un hecho del negocio y
 * vive declarado en `ORDEN_MARCAS` (lib/rrhh/marcacion.ts), no repartido por el código.
 */
export type TipoMarca = "entrada" | "salida_almuerzo" | "regreso_almuerzo" | "salida";

/** El punto GPS que acompaña a una marca, antes de validarlo contra la geocerca. */
export type PuntoMarca = {
  lat: number | null | undefined;
  lng: number | null | undefined;
  /** Precisión declarada por el equipo (m). Informativa aquí; el motor mide distancia. */
  precision_m?: number | null;
};

/** Una marca ya registrada. `marcado_en` es un INSTANTE completo (ISO-8601 con fecha),
 *  nunca un "HH:MM": así el cruce de medianoche se resuelve con los propios timestamps
 *  y no hace falta un caso especial (que sería el bug). `tipo` se deja tolerante a
 *  datos legados — los motores filtran con `esTipoMarca`. */
export type Marca = {
  tipo: TipoMarca | string;
  marcado_en: string;
  lat?: number | null;
  lng?: number | null;
  precision_m?: number | null;
};

/** Configuración de RRHH de la empresa/sede. Toda la recibe el motor como parámetro;
 *  nunca la lee de la base. `geocerca_bloquea` NO lo aplica `validarMarca` (que solo
 *  MIDE): la DECISIÓN de rechazar una marca fuera del radio vive en el llamador, que
 *  es quien sabe si hoy la geocerca está en modo estricto. */
export type ConfigRrhh = {
  sede_lat: number;
  sede_lng: number;
  /** Radio (m) dentro del cual una marca cuenta como "en la sede". */
  sede_radio_m: number;
  hora_entrada: string; // "HH:MM" Lima
  hora_salida: string;  // "HH:MM" Lima
  /** Minutos de gracia antes de que una entrada tardía cuente como tardanza. */
  tolerancia_min: number;
  /** Descuento por defecto cuando el día no trae el PAR de almuerzo completo. */
  almuerzo_min: number;
  geocerca_bloquea: boolean;
};

/** Resultado geométrico de `validarMarca`: el HECHO (dentro/fuera + distancia), sin juicio. */
export type ResultadoGeocerca = {
  dentro_geocerca: boolean;
  /** Distancia a la sede en metros. `Infinity` cuando el punto o la sede no tienen
   *  coordenada utilizable: "no sé dónde estás" no es "estás lejos". */
  distancia_m: number;
};

// ── Jornada ─────────────────────────────────────────────────────────────────────

export type EstadoJornada = "completa" | "incompleta" | "sin_marcas" | "en_curso";

/** Código declarado, en biyección con el estado (ver `CODIGO_JORNADA` en jornada.ts).
 *  Se DECLARA, no se olfatea del nombre del estado: cada código nombra el porqué. */
export type CodigoJornada = "ok" | "falta_entrada" | "sin_marcas" | "en_curso";

export type ResultadoJornada = {
  /** Horas efectivas = (salida − entrada) − almuerzo. Nunca negativo. 0 si el día no cerró. */
  horas_trabajadas: number;
  /** Almuerzo descontado (horas): el real si vino el par, si no el `almuerzo_min` default. */
  horas_almuerzo: number;
  /** max(0, entrada − hora_entrada − tolerancia), en minutos. */
  tardanza_min: number;
  /** max(0, hora_salida − salida), en minutos. */
  salida_temprana_min: number;
  estado: EstadoJornada;
  codigo: CodigoJornada;
  /** true cuando faltó el par de almuerzo y se descontó el default declarado. */
  almuerzo_estimado: boolean;
};

// ── Vacaciones ──────────────────────────────────────────────────────────────────

/** El motor de vacaciones solo necesita los días por año del régimen; acepta el
 *  `RegimenLaboral` completo (espejo de `config_laboral_regimen`) sin duplicar su forma.
 *  El régimen se RECIBE como parámetro — nunca se lee de la base aquí. */
export type RegimenVacaciones = Pick<RegimenLaboral, "vacaciones_dias">;

export type TipoAusencia =
  | "vacaciones" | "permiso" | "falta" | "descanso_medico" | "licencia" | (string & {});
export type EstadoAusencia = "aprobada" | "pendiente" | "rechazada" | (string & {});

/** Una ausencia ya registrada. `dias` es la cuenta autoritativa de días gozados
 *  (la deriva quien la crea, con el calendario laboral que corresponda); el motor de
 *  vacaciones no re-cuenta días de fechas. `id` permite deduplicar: pasar la MISMA
 *  ausencia dos veces no puede descontar dos veces. */
export type Ausencia = {
  id?: number | string | null;
  tipo: TipoAusencia;
  estado: EstadoAusencia;
  dias: number;
};

export type SaldoVacaciones = {
  /** Años de servicio COMPLETOS (antigüedad trunca). */
  anios_completos: number;
  /** anios_completos × vacaciones_dias del régimen. */
  dias_ganados: number;
  /** Días de ausencias tipo 'vacaciones' APROBADAS (deduplicadas por id). */
  dias_gozados: number;
  /** ganados − gozados. Puede ser negativo si se adelantaron vacaciones: eso es una
   *  deuda real y se MUESTRA, no se oculta. Lo único que nunca lo baja es un doble
   *  descuento (dedup por id). */
  saldo: number;
};

// ── Presencia del conductor ──────────────────────────────────────────────────────

/** El conductor no ficha en la sede: su presencia se DERIVA de tener servicios no
 *  cancelados ese día. Es asistencia-por-asignación, distinta de "condujo de verdad"
 *  (que confirmarían el GPS / el check-out en otro módulo). */
export type PresenciaConductor = {
  presente: boolean;
  no_cancelados: number;
  cancelados: number;
  total: number;
};
