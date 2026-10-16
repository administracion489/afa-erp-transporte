// lib/radar/tanque-lleno.ts — ¿quedó lleno el tanque? Módulo PURO: no lee la base.
//
// EL PROBLEMA QUE RESUELVE, Y POR QUÉ EL RADAR NO PUEDE DECIDIRLO SOLO.
//
// El rendimiento se mide de tanque lleno a tanque lleno: con el tanque a tope en los DOS
// extremos, lo despachado al cerrar es exactamente lo consumido, porque el nivel restante —que
// nadie mide— se cancela solo. Con una carga parcial el denominador es menor que lo consumido y
// el rendimiento sale INFLADO… **y eso es indistinguible de una carga comprada y no registrada**
// (`rendimiento_alto`), que este ERP lee, con razón, como plata que falta en los libros. O sea:
// dos causas muy distintas, un mismo rojo, y solo una es un problema de dinero.
//
// `combustible.tanque_lleno` existe para separarlas (`supabase/combustible-01-tanque-lleno.sql`)
// y el formulario de /combustible ya la escribe. El Radar no: sus cargas entran en `null`, que
// ANCLA por la política de la empresa —cargar siempre a tope— y mide exactamente como siempre.
// Eso es correcto por defecto, pero deja fuera justo los casos excepcionales que el dueño
// nombró: que no hubiera saldo de crédito, o que el grifo no tuviera stock.
//
// ── LO QUE ESTE MÓDULO HACE Y LO QUE NO ─────────────────────────────────────
//
// **PROPONE. No escribe nada.** La regla que gobierna todo el módulo del tanque es que un `true`
// observado por una persona y uno heredado de la política no valen lo mismo (por eso existe
// `tanque_lleno_fuente`), y de ahí sale la jerarquía:
//
//   · la AGUJA leída en la foto del tablero es una OBSERVACIÓN del tanque → puede fijar el
//     valor por defecto de la casilla, declarándose como `ia_aguja`;
//   · el importe redondo y la cantidad ≈ capacidad son INDICIOS: se enseñan como texto al lado
//     de la casilla y **nunca la mueven**. Un `false` puesto por una heurística deja de anclar
//     ese tramo en silencio, y un tramo que deja de medirse no se nota en ninguna pantalla.
//   · la persona que revisa decide, y entonces la fuente es `operador`.
//
// EL INDICIO DEL IMPORTE REDONDO ES EL ÚTIL, y es gratis: ya está en los datos. Un voucher de
// grifo imprime `cantidad × precio`, y ese producto casi nunca cae en un número redondo por
// azar — 8.799 gal × 24.640 = S/ 216.81. Un S/ 100.00 o S/ 150.00 exacto significa que el
// grifero despachó HASTA UN MONTO, que es literalmente el caso «no había saldo de crédito».
//
// EL PAGO ES MEDIBLE: si esto funciona, el hallazgo `rendimiento_alto` de la flota tiene que
// BAJAR, porque hoy se está comiendo las parciales no declaradas.

import { capacidadTanqueDe, familiaCombustible } from "@/lib/combustible-tipos";
import { normalizarCantidad } from "@/lib/rendimiento";

/** Lo que la IA dice haber visto en la aguja del tablero, DESPUÉS de cargar. */
export type NivelAguja = "lleno" | "parcial" | "no_visible" | null | undefined;

export type IndicioTanque = {
  codigo: "importe_redondo" | "cantidad_llena_el_tanque" | "aguja";
  /** Hacia dónde apunta. `null` = no dice nada por sí solo. */
  apunta: boolean | null;
  detalle: string;
};

export type PropuestaTanque = {
  /**
   * El valor con el que debe NACER la casilla en el panel de revisión.
   * `null` significa «la política» (marcada), que es el comportamiento de siempre.
   */
  porDefecto: boolean | null;
  /** Quién lo afirma si el revisor no toca nada. `null` → la política. */
  fuente: "ia_aguja" | null;
  /** Todo lo que el ERP puede decir del tanque en esta carga, para enseñarlo junto a la casilla. */
  indicios: IndicioTanque[];
};

/**
 * Un importe es «redondo» si termina en 00 céntimos y es múltiplo de 10 soles.
 *
 * Los dos requisitos juntos, no uno: `S/ 240.00` clava los dos y es la firma de una carga por
 * monto; `S/ 216.81` no clava ninguno. El múltiplo de 10 es lo que evita el falso positivo de
 * un producto que por casualidad cae en céntimos exactos (`8.00 × 25.00 = 200.00` sí es carga
 * por monto; `7.00 × 24.64 = 172.48` no llega ni al primer filtro).
 *
 * NO se exige que sea múltiplo de 50: en Perú se carga «cien soles» y también «treinta».
 */
export function importeEsRedondo(monto: number | null | undefined): boolean {
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) return false;
  const centimos = Math.round(m * 100);
  return centimos % 1000 === 0; // 1000 céntimos = S/ 10
}

/**
 * ¿La cantidad despachada llena el tanque de esa unidad?
 *
 * Solo cuenta como indicio POSITIVO, y con holgura: un tanque nunca se vacía del todo, así que
 * se pide ≥ 85 % de la capacidad. Por debajo NO se afirma nada — un depósito a medio gastar
 * admite media carga y quedar lleno igual, que es el caso normal de una flota que reposta a
 * diario. Convertirlo en indicio de «parcial» sería exactamente el falso positivo masivo.
 */
export const FRACCION_TANQUE_LLENO = 0.85;

// ── ¿LE CREEMOS AL «PARCIAL» DE LA IA? ──────────────────────────────────────
//
// EL CASO (CNQ-396, 14/10/2026): tablero DIGITAL de una van, con el tanque lleno, y la IA devolvió
// `nivel_tanque: "parcial"`. La carga quedó «Carga parcial (aguja)» y bloqueada. El prompt hablaba
// de «la aguja» y cada modelo pinta el nivel distinto —aguja con E/F, barras, una franja, un
// porcentaje, o solo la autonomía en km—, y en un tablero digital hay otros relojes con la misma
// forma: el tacómetro (0-1-2… ×1000 rpm), la temperatura (C/H), la barra ECO, el consumo L/100km.
// La IA leyó uno de ésos como si fuera el tanque.
//
// Un «parcial» es la única lectura del tanque que CAMBIA algo (manda la carga a revisión y propone
// desmarcar la casilla), así que se le exige evidencia; un «lleno» o un «no_visible» se dejan como
// están porque los dos anclan igual que la política.

/** Cómo muestra el tablero el nivel de combustible. Lo declara la IA junto a la lectura. */
export type IndicadorNivel = "aguja" | "barras" | "porcentaje" | "autonomia" | "otro";

const INDICADORES: readonly IndicadorNivel[] = ["aguja", "barras", "porcentaje", "autonomia", "otro"];

export function normalizarIndicador(v: unknown): IndicadorNivel | null {
  const s = String(v ?? "").trim().toLowerCase();
  return (INDICADORES as readonly string[]).includes(s) ? (s as IndicadorNivel) : null;
}

export type JuicioNivel = {
  /** El nivel con el que sigue el ERP. Un «parcial» descartado pasa a "no_visible". */
  nivel: "lleno" | "parcial" | "no_visible" | null;
  /** Por qué se descartó un «parcial». `null` si no se descartó nada. */
  descartado: "sin_indicador" | "sin_evidencia" | "solo_autonomia" | "cantidad_llena" | null;
  indicador: IndicadorNivel | null;
  evidencia: string | null;
};

/**
 * Decide si el «parcial» de la IA vale. Cuatro descartes, de la evidencia al juicio:
 *   · sin_indicador: no dijo QUÉ indicador del tablero leyó (o dijo «otro»): no se sabe si era el
 *     del combustible.
 *   · sin_evidencia: no describió lo que vio (ícono del surtidor, E/F, cuántas barras).
 *   · solo_autonomia: la autonomía en km depende del consumo reciente, no del tanque: no prueba
 *     que el tanque no se llenó.
 *   · cantidad_llena: se despachó ≥ 85 % del tanque de la unidad, o sea se llenó casi entero.
 */
export function juzgarNivelTanque(args: {
  nivel?: unknown;
  indicador?: unknown;
  evidencia?: unknown;
  /** Cantidad despachada y capacidad del tanque, en la MISMA unidad. 0/null = no se sabe. */
  cantidad?: number | null;
  capacidad?: number | null;
}): JuicioNivel {
  const crudo = String(args.nivel ?? "").trim().toLowerCase();
  const nivel = crudo === "lleno" || crudo === "parcial" || crudo === "no_visible" ? crudo : null;
  const indicador = normalizarIndicador(args.indicador);
  const ev = String(args.evidencia ?? "").trim();
  const evidencia = ev.length >= 8 ? ev.slice(0, 240) : null;
  const base = { indicador, evidencia };
  if (nivel !== "parcial") return { nivel, descartado: null, ...base };
  const descartar = (d: NonNullable<JuicioNivel["descartado"]>): JuicioNivel => ({ nivel: "no_visible", descartado: d, ...base });
  if (!indicador || indicador === "otro") return descartar("sin_indicador");
  if (indicador === "autonomia") return descartar("solo_autonomia");
  if (!evidencia) return descartar("sin_evidencia");
  const q = Number(args.cantidad);
  const cap = Number(args.capacidad);
  if (Number.isFinite(q) && Number.isFinite(cap) && cap > 0 && q >= cap * FRACCION_TANQUE_LLENO) {
    return descartar("cantidad_llena");
  }
  return { nivel: "parcial", descartado: null, ...base };
}

export function proponerTanqueLleno(args: {
  /** Fila de `vehiculos`/`vehiculos_tercero` para resolver la capacidad. Puede faltar. */
  vehiculo?: { categoria?: string | null; capacidad_tanque?: Record<string, number> | null } | string | null;
  tipo?: string | null;
  /** Cantidad despachada, tal como se va a guardar (con su unidad). */
  cantidad?: number | null;
  unidad?: string | null;
  monto?: number | null;
  /** Lo que la IA leyó en la aguja del tablero DESPUÉS de cargar. */
  nivelAguja?: NivelAguja;
}): PropuestaTanque {
  const indicios: IndicioTanque[] = [];

  // 1) LA AGUJA. Es la única observación directa del tanque, y la única que mueve el default.
  let porDefecto: boolean | null = null;
  let fuente: "ia_aguja" | null = null;
  if (args.nivelAguja === "lleno" || args.nivelAguja === "parcial") {
    porDefecto = args.nivelAguja === "lleno";
    fuente = "ia_aguja";
    indicios.push({
      codigo: "aguja",
      apunta: porDefecto,
      detalle: porDefecto
        ? "En la foto del tablero el indicador de combustible marca el tanque LLENO."
        : "En la foto del tablero el indicador de combustible NO marca lleno: la carga habría sido parcial. " +
          "Compruébalo en la foto: cada modelo lo muestra distinto (aguja, barras, porcentaje) y no hay que confundirlo con el tacómetro, la temperatura o la barra ECO.",
    });
  }

  // 2) EL IMPORTE REDONDO. Indicio, nunca decisión: mueve el texto, no la casilla.
  if (importeEsRedondo(args.monto)) {
    indicios.push({
      codigo: "importe_redondo",
      apunta: false,
      detalle:
        `El importe es exactamente S/ ${Number(args.monto).toFixed(2)}: un voucher normal cae en ` +
        `céntimos sueltos (cantidad × precio), así que un monto redondo suele significar que se ` +
        `despachó HASTA UN MONTO — el caso de «no había saldo de crédito». Compruébalo.`,
    });
  }

  // 3) LA CANTIDAD CONTRA EL TANQUE. Solo confirma; nunca niega.
  const familia = familiaCombustible(args.tipo);
  const q = normalizarCantidad(args.cantidad, args.unidad, familia);
  const cap = args.vehiculo != null ? capacidadTanqueDe(args.vehiculo as any, args.tipo) : 0;
  if (q != null && cap > 0 && q >= cap * FRACCION_TANQUE_LLENO) {
    indicios.push({
      codigo: "cantidad_llena_el_tanque",
      apunta: true,
      detalle:
        `Se despacharon ${q.toFixed(1)} de un tanque de ~${cap}: es prácticamente el tanque ` +
        `entero, así que lo más probable es que quedara lleno.`,
    });
  }

  return { porDefecto, fuente, indicios };
}
