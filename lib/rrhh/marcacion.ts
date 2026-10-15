// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/marcacion.ts — MOTOR PURO de la marcación: ¿está dentro de la geocerca?
// y ¿cuál es el siguiente hito válido del día? Sin base, sin fetch, sin "ahora".
//
// EL HAVERSINE NO SE REESCRIBE. `distM` ya es la fórmula única del ERP (lib/huella.ts);
// una segunda copia sería el bug del semáforo —dos módulos que contestan la misma
// pregunta terminan contestando distinto—. Lo mismo con "coordenada utilizable":
// `coordValida` es la definición única (null, vacía, no numérica, fuera de rango o
// (0,0) = sin dato), y se reúsa aquí.
// ──────────────────────────────────────────────────────────────────────────────

import { distM } from "@/lib/huella";
import { coordValida } from "@/lib/cotizacion-ruta-coords";
import type { ConfigRrhh, PuntoMarca, ResultadoGeocerca, TipoMarca } from "./tipos";

/**
 * El ORDEN del día laboral, declarado una sola vez. Quien necesite saber "qué va
 * después de qué" lo lee de aquí; nadie reconstruye el orden a mano.
 */
export const ORDEN_MARCAS: readonly TipoMarca[] = [
  "entrada",
  "salida_almuerzo",
  "regreso_almuerzo",
  "salida",
] as const;

/** Índice de un tipo en el orden (−1 si no es un tipo válido). */
export function ordenDe(tipo: TipoMarca | string): number {
  return ORDEN_MARCAS.indexOf(tipo as TipoMarca);
}

export function esTipoMarca(t: unknown): t is TipoMarca {
  return (
    t === "entrada" ||
    t === "salida_almuerzo" ||
    t === "regreso_almuerzo" ||
    t === "salida"
  );
}

/**
 * ¿La marca cae dentro de la geocerca de la sede? Devuelve el HECHO geométrico; el
 * juicio (bloquear o no) lo aplica el llamador con `cfg.geocerca_bloquea`.
 *
 * - Distancia por `distM` (haversine único del ERP).
 * - Si el punto O la sede no tienen coordenada utilizable (`coordValida`), no se
 *   puede confirmar que esté dentro: `distancia_m = Infinity`, `dentro = false`.
 *   "No sé dónde estás" no es "estás lejos" — y el lado seguro depende del modo de
 *   la geocerca, que decide el llamador.
 * - El borde es INCLUSIVO: exactamente en el radio cuenta como dentro.
 */
export function validarMarca(punto: PuntoMarca, cfg: ConfigRrhh): ResultadoGeocerca {
  if (!coordValida(punto?.lat, punto?.lng) || !coordValida(cfg?.sede_lat, cfg?.sede_lng)) {
    return { dentro_geocerca: false, distancia_m: Infinity };
  }
  const d = distM(Number(cfg.sede_lat), Number(cfg.sede_lng), Number(punto.lat), Number(punto.lng));
  // Un radio no finito o negativo no puede confirmar "dentro": se trata como 0 (nada
  // dentro salvo la distancia 0). No se inventa un radio por defecto.
  const radio = Number.isFinite(cfg?.sede_radio_m) && Number(cfg.sede_radio_m) > 0 ? Number(cfg.sede_radio_m) : 0;
  return {
    dentro_geocerca: Number.isFinite(d) && d <= radio,
    distancia_m: Math.round(d * 10) / 10,
  };
}

/**
 * El siguiente hito VÁLIDO del día, o `null` si el día ya está cerrado.
 *
 * REGLA: nunca propone un tipo cuyo predecesor en el orden falte (jamás "salida"
 * antes de "entrada"). Se deriva del CONJUNTO de marcas ya hechas, no de su orden de
 * llegada: se devuelve el PRIMER tipo del orden que todavía no está presente, así
 * que todos sus predecesores ya lo están.
 *
 * `salida` es TERMINAL: en cuanto está marcada, el día está cerrado y se devuelve
 * `null` aunque falte el par de almuerzo (eso lo absorbe `calcularJornada` con el
 * descuento default). Que falte el almuerzo es una decisión del día, no un hito
 * pendiente que ofrecer después de haber salido.
 *
 * Datos corruptos (p. ej. solo `salida`, imposible si el gate siempre usa esta
 * función) devuelven `null`: no se ofrece nada, lo resuelve RRHH. El invariante —no
 * proponer un tipo que viole el orden— se mantiene en todos los casos.
 */
export function tipoSiguiente(
  marcasDeHoy: ReadonlyArray<{ tipo: TipoMarca | string }> | null | undefined,
): TipoMarca | null {
  const presentes = new Set<TipoMarca>();
  for (const m of marcasDeHoy ?? []) {
    if (esTipoMarca(m?.tipo)) presentes.add(m.tipo as TipoMarca);
  }
  if (presentes.has("salida")) return null; // terminal: nada se marca después de salir
  for (const t of ORDEN_MARCAS) {
    if (!presentes.has(t)) return t; // el primero que falta: todos sus predecesores están
  }
  return null; // todos presentes (inalcanzable: "salida" presente ya devolvió null)
}
