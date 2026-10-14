// ──────────────────────────────────────────────────────────────────────────────
// lib/comisiones/tipos.ts — El vocabulario del motor de comisiones.
//
// QUÉ ES ESTE MÓDULO Y QUÉ NO HACE, A PROPÓSITO (igual que lib/costeo-propio.ts):
//
//   · No lee la base. Los motores de comisiones reciben datos ya resueltos y devuelven
//     líneas con su traza; de dónde salen esos datos lo decide quien tiene acceso a la
//     base, y así todo esto se prueba sin Supabase (ver scripts/prueba-comisiones.mts).
//   · No deriva la utilidad. El dueño lo pidió explícito: «la comisión es sobre la
//     UTILIDAD y el motor la RECIBE ya calculada». Derivarla aquí sería un segundo motor
//     de costeo discrepando con `lib/costeo-servicio.ts`.
//   · NADA de porcentajes, tramos ni montos escritos en el código. Todos llegan como
//     `ParametroComision`, con vigencia por fecha. El día que el dueño cambia el 20 % a
//     18 %, se agrega una fila con `vigente_desde` y los cálculos viejos no se mueven.
//
// EL MOTIVO SE DECLARA, NO SE OLFATEA (misma regla que `montoDe`, `evaluarLectura` y los
// bloqueos de /liquidaciones): cada línea lleva un `codigo` de un conjunto cerrado, y la
// pantalla enruta por código en vez de adivinar leyendo el texto. Una línea con monto
// `null` NO es un cero —es «no se puede calcular todavía»— y esa diferencia es la que
// separa «no te toca» de «te toca pero falta un dato».
// ──────────────────────────────────────────────────────────────────────────────

/** Soles a centavos. Cada LÍNEA de comisión es un importe pagable (aparece en un
 *  detalle de pago), así que se redondea por línea, no al final: es la diferencia con
 *  `costeo-propio`, donde `baseCosto` es intermedio y se redondea al presentar. */
export function redondearCentavos(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Un tramo de comisión. `hasta` es la posición máxima (inclusiva) a la que aplica la
 *  `tasa`; `null` = «de ahí en adelante». Los tramos se dan en orden ascendente de
 *  `hasta`, con exactamente un `hasta: null` al final. */
export type Tramo = { hasta: number | null; tasa: number };

/** El juego de parámetros de la política de comisiones, con la fecha desde la que rige.
 *  `parametrosVigentes(lista, fecha)` elige el de mayor `vigente_desde <= fecha`, y cada
 *  cálculo usa el vigente en SU fecha de cobro. */
export type ParametroComision = {
  /** "YYYY-MM-DD". Desde cuándo rige este juego. */
  vigente_desde: string;

  // ── Eventual ──
  /** Tramos por posición dentro del mes. Ej: [{hasta:30,tasa:0.20},{hasta:null,tasa:0.12}]. */
  tramosEventual: Tramo[];

  // ── Fijo ──
  /** 10 % de la utilidad mensual. */
  tasaFijo: number;

  // ── Bono de arranque (fijos nuevos) ──
  /** 30 % de la utilidad del mes 1. */
  tasaBonoArranque: number;
  /** Cómo se parte el bono por mes de cobro. Ej: [{mes:1,fraccion:0.5},{mes:3,fraccion:0.5}]. */
  mitadesBonoArranque: { mes: number; fraccion: number }[];

  // ── Ventana de comisión del cliente nuevo ──
  /** Meses desde el primer servicio cobrado (por fecha de servicio) hasta que deja de comisionar. */
  ventanaMeses: number;

  // ── Fondo administrativo ──
  /** Soles por cada eventual nuevo cobrado del mes, repartidos entre operadores corroborados. */
  montoFondoPorEventual: number;

  // ── Bono de atención ──
  /** Tope del bono de atención (≤ S/150). */
  topeBonoAtencion: number;
  /** Fracción mínima de respuestas en plazo para cumplir «rapidez» (0.90). */
  toleranciaRapidez: number;
};

/** Un servicio eventual cobrado al 100 %, listo para comisionar. El motor recibe SOLO los
 *  elegibles (la frontera de datos filtra lo no cobrado), pero `cobrado` viaja igual como
 *  última línea de defensa: un servicio no cobrado que se cuele NO se paga ni cuenta. */
export type ServicioEventual = {
  id: string | number;
  clienteId: string;
  /** "YYYY-MM-DD". Ordena el tramo, elige el parámetro vigente y agrupa el mes del fondo. */
  fechaCobro: string;
  /** "YYYY-MM-DD". Es la que mide la ventana de 12 meses del cliente nuevo. */
  fechaServicio: string;
  /** La utilidad del servicio, YA calculada por quien costeó. */
  utilidad: number;
  /** Si el servicio tiene presupuesto. Sin él la utilidad puede estar inflada → se retiene. */
  tienePresupuesto: boolean;
  /** Defensivo. La frontera ya filtró lo no cobrado; si se cuela, no se paga. */
  cobrado?: boolean;
};

/** Un mes facturado de un contrato fijo. */
export type MesFijo = {
  mes: number; // 1-based dentro del contrato
  fechaCobro: string;
  fechaServicio: string;
  utilidad: number;
  cobrado: boolean;
  tienePresupuesto: boolean;
};

/** Un contrato fijo (tercerizado o propio). El 10 % mensual vive aquí; el bono de
 *  arranque lo deriva `bono-arranque.ts` de `meses[0]`. */
export type ContratoFijo = {
  id: string | number;
  clienteId: string;
  meses: MesFijo[];
  /** Mes (1-based) en que se canceló el contrato. `null` = vigente. */
  canceladoEnMes?: number | null;
};

/** Qué regla de negocio originó una línea. */
export type Regla =
  | "eventual"
  | "fijo_mensual"
  | "bono_arranque"
  | "bono_atencion"
  | "fondo_admin";

/** Por qué la línea dice lo que dice. Conjunto CERRADO: la pantalla enruta por esto. */
export type CodigoLinea =
  | "pagar" // hay monto a pagar
  | "retenido_falta_costear" // sin presupuesto: utilidad no confiable, monto = null
  | "no_cobrado" // defensivo: llegó algo no cobrado, no se paga ni cuenta
  | "cliente_existente" // en lista firmada → no es cliente nuevo
  | "cliente_sin_ventana" // tuvo servicio en los 12 meses previos → no es cliente nuevo
  | "fuera_de_ventana" // pasó la ventana de 12 meses desde el primer servicio cobrado
  | "bono_arranque_cancelado" // 2ª mitad: cancelado antes del mes 3, no se paga
  | "pendiente_cobro" // 2ª mitad: el mes aún no se cobró, todavía no se paga
  | "fondo_pendiente_corroboracion" // fondo calculado pero sin operadores corroborados
  | "sin_parametros"; // no había parámetro vigente en esa fecha

/** La unidad de salida del motor. Todo lo que paga comisión es una de estas, y TODA lleva
 *  su traza: qué servicio/contrato, qué regla, qué parámetro (por su `vigente_desde`) y
 *  qué base × tasa la originó. `monto: null` ≠ `monto: 0`. */
export type LineaComision = {
  regla: Regla;
  codigo: CodigoLinea;
  /** Soles a pagar (redondeado a centavos). `null` cuando se retiene por falta de dato. */
  monto: number | null;
  /** La utilidad base (o, en el fondo, la cantidad de eventuales). */
  base: number;
  /** La tasa aplicada (0.20, 0.10…). `null` cuando no aplica tasa (p.ej. fondo plano). */
  tasa: number | null;
  servicioId?: string | number;
  contratoId?: string | number;
  clienteId?: string;
  vendedorId?: string;
  operadorId?: string; // fondo: a quién le toca esta parte
  fechaCobro?: string;
  /** Posición dentro del mes para el tramo del eventual (1-based). */
  posicion?: number;
  /** `vigente_desde` del parámetro usado. */
  parametroDesde?: string;
  /** Traza legible para la pantalla y el detalle de pago. */
  detalle: string;
};

/** Lo que devuelve el motor completo. */
export type ResultadoComisiones = {
  lineas: LineaComision[];
  totales: {
    /** Suma de los `monto` pagables (no nulos) de las reglas de comisión, SIN el fondo. */
    comisiones: number;
    /** Cuánto queda retenido (contando solo lo que se habría pagado si no faltara costear). */
    retenidas: number;
    /** Suma del fondo administrativo (lo paga la empresa, no sale de la comisión). */
    fondo: number;
  };
};
