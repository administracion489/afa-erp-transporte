// ──────────────────────────────────────────────────────────────────────────────
// lib/flota/servicio-estadistica.ts — Motor PURO: la estadística de UN servicio (km por GPS, marcha,
// excesos, combustible, costo y CO₂ ESTIMADOS) y su corte por cliente.
//
// No lee la base. Recibe el servicio YA MEDIDO por la torre (`ServicioMedido` de
// lib/gps-cobertura-datos.ts, con las filas crudas de `conHuella`), el contexto de combustible de su
// unidad ya resuelto y los nombres, y devuelve números con su motivo. Quien lee es
// lib/flota/servicio-estadistica-datos.ts; la matriz es scripts/prueba-servicio-estadistica.mts.
//
// LO QUE NO SE INVENTA AQUÍ, Y DE DÓNDE SALE CADA COSA:
//   · el conjunto de servicios, el techo y el veredicto RASTREO son los de la torre (`medirServicio`);
//   · el km es el de la Auditoría de km (`resumenDeFilas`) y se publica SOLO según el veredicto
//     (`kmPublicable`, lib/flota/km-gps.ts): ningún umbral nuevo;
//   · el volumen por km es `consumoPorKm` y el costo es `calcularCostoUnidad(...).costoCombustible`
//     (lib/costeo-propio.ts), con el rendimiento de `decidirRendimiento` y los precios de
//     `preciosParaCosteo`: el MISMO número que el renglón «Combustible» del presupuesto del servicio
//     (lib/costeo-servicio.ts), pero con el km recorrido. La matriz cierra ese ciclo al céntimo;
//   · la familia del parámetro sale de `familiaDeParametro` (mapa EXPLÍCITO): un combustible que no
//     se reconoce es `familia_desconocida`, NUNCA diésel (`familiaCombustible` cae al diésel);
//   · el CO₂ es `co2DeCantidad` (lib/combustible-tipos.ts, dueño del factor): cantidad × factor;
//   · las horas son `derivarTiempos` SIN GPS, como `contextoServicio` (el fin de un servicio no puede
//     salir de la traza que se juzga); la franja del GPS va aparte (`gpsDesdeTs`/`gpsHastaTs`, «~GPS»);
//   · el conductor del teléfono es `conductorDeLaTraza` (lib/gps-diagnostico-api.ts);
//   · la ruta son DOS datos (`identidadRuta`): RUTA y ORIGEN → DESTINO, nunca uno en lugar del otro.
//
// LAS REGLAS QUE NO SE AFLOJAN:
//   · NADA ESTIMADO SE PRESENTA COMO MEDIDO: combustible, costo y CO₂ llevan `codigo` y `base`
//     (cómo se llegó al número, o por qué no hay número). Invariante: valor ≠ null ⟺ código `estimado`.
//   · SI EL KM ES UN PISO, TODO LO QUE SALE DE ÉL TAMBIÉN: un GPS con cortes solo puede quedarse
//     corto, así que combustible, costo y CO₂ heredan `piso: true` («≥»).
//   · NUNCA SE SUMAN GALONES CON m³: el combustible va POR FAMILIA (`porFamilia`), también en el
//     corte por cliente. Los soles y los kg sí se suman.
//   · UN TERCERO NO TIENE COSTO DE COMBUSTIBLE (se le paga la factura del proveedor: código
//     `tercero`), pero SÍ tiene CO₂ si su tipo de costeo tiene parámetro: las emisiones del recorrido
//     existen las pague quien las pague.
//   · UN FALLO DE LECTURA NUNCA ES UN CERO NI UN «SIN TIPO»: `sin_lectura` lo dice.
//   · Todo es URBANO, como el presupuesto (`calcularCostoUnidad` sin `recorrido`).
//
// LOS EXCESOS DEL SERVICIO salen del MISMO motor que /seguridad-vial (`detectarExcesos`,
// lib/flota/excesos.ts) sobre la MISMA traza, aislados en `excesosDelServicio`.
// ──────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- las filas de reservas/paradas/ubicaciones_gps llegan sin tipos generados */
import type { ServicioMedido } from "../gps-cobertura-datos";
import { PRECISION_MAX_M, type VeredictoRastreo, type FilaGpsDiag } from "../gps-cobertura";
import { derivarTiempos, type Instante } from "../servicio-tiempos";
import { resumenDeFilas, type ResumenViaje } from "../huella";
import { kmPublicable, textoKmGps, type KmGps, type CodigoKmGps } from "./km-gps";
import { consumoPorKm, calcularCostoUnidad, type ParametrosUnidad, type PreciosCombustible } from "../costeo-propio";
import { preciosParaCosteo } from "../costeo-servicio";
import { decidirRendimiento, type DecisionRendimiento, type MedicionPlaca } from "../costos/rendimiento-aplica";
import { familiaDeParametro } from "../costos/rendimiento-tipo";
import { textoPrecioUltimaCarga, type UltimaCarga } from "../costos/precio-ultima-carga";
import { COMBUSTIBLES, co2DeCantidad, FACTOR_CO2, FUENTE_FACTOR_CO2, type CodigoCo2 } from "../combustible-tipos";
import { identidadRuta, type IdentidadRuta } from "../ruta-identidad";
import { conductorDeLaTraza } from "../gps-diagnostico-api";
import {
  detectarExcesos, leerUmbral, puntosDeCrudas, velocimetroDe,
  PASO_UMBRAL_KMH, UMBRAL_DEFECTO_KMH, UMBRAL_MIN_KMH, UMBRAL_MAX_KMH,
  type CodigoDescarte,
} from "./excesos";

// ══ Umbral de excesos ════════════════════════════════════════════════════════════════════

/** El umbral de velocidad de los excesos del servicio: los MISMOS límites y el MISMO paso que
 *  /seguridad-vial (lib/flota/excesos.ts), para que un exceso cuente igual en las dos pantallas. */
export const UMBRAL_SERVICIO = { defecto: UMBRAL_DEFECTO_KMH, min: UMBRAL_MIN_KMH, max: UMBRAL_MAX_KMH, paso: PASO_UMBRAL_KMH } as const;

/** El umbral de la petición con su motivo: es `leerUmbral` de lib/flota/excesos.ts (la regla de
 *  /api/flota/excesos), con los espacios del borde recortados. Vacío → el defecto; un entero dentro de
 *  [min, max] múltiplo de `paso` → ese; cualquier otra cosa → el motivo, para el 400. */
export function validarUmbral(texto: string | null | undefined): { ok: true; umbral: number } | { ok: false; error: string } {
  return leerUmbral(String(texto ?? "").trim());
}

/** El umbral de la petición: el de `validarUmbral`, o null si no vale (la ruta responde 400: no se
 *  «corrige» un umbral que alguien escribió mal). */
export function normalizarUmbral(texto: string | null | undefined): number | null {
  const v = validarUmbral(texto);
  return v.ok ? v.umbral : null;
}

// ══ Contexto de combustible de la UNIDAD ═════════════════════════════════════════════════

export type Flota = "propia" | "tercero";

/**
 * Todo lo que hace falta para estimar el combustible de una unidad, ya resuelto contra la base.
 * Se arma con `contextoCombustible` (abajo), que es la MISMA cascada de `calcularPresupuesto`.
 */
export type ContextoCombustibleUnidad = {
  flota: Flota;
  /** `vehiculos(_tercero).tipo_vehiculo_costeo`, crudo. null = la unidad no tiene categoría. */
  tipoCosteo: string | null;
  /** La fila de `parametros_costos` de ese tipo. null = el tipo no existe (o no hay tipo). */
  parametros: ParametrosUnidad | null;
  /** Qué rendimiento se usa y por qué (`decidirRendimiento`). null sin parámetros. */
  decision: DecisionRendimiento | null;
  /** Ya pasados por `preciosParaCosteo`: la última carga de la placa manda sobre el de referencia. */
  precios: PreciosCombustible;
  /** La última carga cuyo precio mandó (solo para el texto de la base). Ya es del combustible del
   *  parámetro y en su unidad canónica: lo decide lib/costos/precio-ultima-carga.ts. */
  precioUltimaCarga?: UltimaCarga | null;
  /** Falló la lectura de la unidad o de su parámetro: no se afirma nada (nunca «sin tipo»). */
  fallo?: string | null;
  /** Falló la lectura de los precios: el volumen y el CO₂ se estiman; el costo no. */
  falloPrecios?: string | null;
};

/**
 * Arma el contexto de una unidad con la MISMA cascada que `calcularPresupuesto`
 * (lib/costeo-servicio.ts): el rendimiento lo decide `decidirRendimiento` con la medición de la
 * placa, y el precio del combustible principal es el de la última carga cuando se conoce
 * (`preciosParaCosteo`). Así el costo estimado de un servicio es el renglón «Combustible» de su
 * presupuesto con el km recorrido (la matriz cierra el ciclo al céntimo).
 *
 * A un TERCERO no se le usa ni la medición ni la última carga: su rendimiento no se mide aquí
 * (`rendimientoMedido` lee `vehiculo_id`) y su combustible no es un costo de AFA; con su parámetro
 * se estima solo el volumen, que es de donde sale su CO₂.
 */
export function contextoCombustible(e: {
  flota: Flota;
  tipoCosteo: string | null;
  parametros: ParametrosUnidad | null;
  medicion: MedicionPlaca | null;
  precioUltimaCarga: UltimaCarga | null;
  preciosReferencia: PreciosCombustible;
  fallo?: string | null;
  falloPrecios?: string | null;
}): ContextoCombustibleUnidad {
  const propia = e.flota === "propia";
  const medicion = propia ? e.medicion : null;
  const ultima = propia ? e.precioUltimaCarga : null;
  const decision = e.parametros ? decidirRendimiento(e.parametros, medicion) : null;
  const params = e.parametros && decision ? { ...e.parametros, rendimiento_1: decision.valor } : null;
  return {
    flota: e.flota,
    tipoCosteo: e.tipoCosteo,
    parametros: e.parametros,
    decision,
    precios: preciosParaCosteo(e.preciosReferencia, params, ultima),
    precioUltimaCarga: ultima,
    fallo: e.fallo ?? null,
    falloPrecios: e.falloPrecios ?? null,
  };
}

// ══ Combustible, costo y CO₂ ESTIMADOS ═══════════════════════════════════════════════════

export type CodigoCombustible =
  | "estimado"
  | "sin_km"               // el km del GPS no se puede publicar (su motivo está en `km`)
  | "sin_unidad"           // el servicio no tiene unidad asignada
  | "sin_lectura"          // no se pudo leer la unidad, su parámetro (o, en el costo, los precios)
  | "sin_tipo_costeo"      // la unidad no tiene «Categoría de costeo»
  | "sin_parametro"        // el tipo no existe en Configuración → Costos, o no tiene rendimiento
  | "familia_desconocida"; // el combustible del parámetro no se reconoce (nunca se cuenta como diésel)

export const CODIGOS_COMBUSTIBLE: readonly CodigoCombustible[] = [
  "estimado", "sin_km", "sin_unidad", "sin_lectura", "sin_tipo_costeo", "sin_parametro", "familia_desconocida",
];

export type UnidadCanonica = "galones" | "m3";

/** Cantidad de UNA familia de combustible, en su unidad canónica. Nunca se suma con otra familia. */
export type CantidadFamilia = { familia: string; unidad: UnidadCanonica; cantidad: number };

export type CombustibleEstimado = {
  codigo: CodigoCombustible;
  /** Vacío salvo `estimado`. Una entrada por familia (un bimodal GLP/gasolina da DOS). */
  porFamilia: CantidadFamilia[];
  /** El km es un mínimo (GPS con cortes): la cantidad también. Solo con `estimado`. */
  piso: boolean;
  /** Cómo se llegó al número, o por qué no hay número. Siempre presente. */
  base: string;
};

export type CodigoCosto = "estimado" | "tercero" | "sin_precio" | Exclude<CodigoCombustible, "estimado">;

export type CostoEstimado = {
  codigo: CodigoCosto;
  /** Soles, redondeados al céntimo como el renglón del presupuesto. null salvo `estimado`. */
  soles: number | null;
  piso: boolean;
  base: string;
};

export type CodigoCo2Servicio = CodigoCo2 | Exclude<CodigoCombustible, "estimado">;

export type Co2Estimado = {
  codigo: CodigoCo2Servicio;
  /** kg de CO₂ (solo CO₂, no CO₂e). null salvo `estimado`. */
  kg: number | null;
  piso: boolean;
  /** kg por familia (los kg sí se suman; la suma es `kg`). Vacío salvo `estimado`. */
  porFamilia: { familia: string; kg: number }[];
  base: string;
};

/** La unidad canónica de una familia, del catálogo (lib/combustible-tipos.ts). null si no la tiene. */
export function unidadDeFamilia(familia: string): UnidadCanonica | null {
  for (const c of Object.values(COMBUSTIBLES)) {
    if (c.familia !== familia || c.esAditivo) continue;
    if (c.unidad === "m3") return "m3";
    if (c.unidad === "galones") return "galones";
    return null;
  }
  return null;
}

const ETIQUETA_UNIDAD: Record<UnidadCanonica, string> = { galones: "gal", m3: "m³" };
const ETIQUETA_FAMILIA: Record<string, string> = { diesel: "diésel", gasolina: "gasolina", glp: "GLP", gnv: "GNV" };
const etFamilia = (f: string) => ETIQUETA_FAMILIA[f] ?? f;
const num = (n: number, d = 2) => n.toLocaleString("es-PE", { minimumFractionDigits: d, maximumFractionDigits: d });
const redondear2 = (n: number) => Math.round(n * 100) / 100;
/** Cuántos decimales de rendimiento se escriben: los que tenga, hasta 2. */
const rend = (n: number) => String(Math.round(n * 100) / 100);

type PlanConsumo =
  | { ok: false; codigo: Exclude<CodigoCombustible, "estimado">; base: string }
  | {
    ok: true;
    km: number;
    piso: boolean;
    params: ParametrosUnidad;
    ctx: ContextoCombustibleUnidad;
    partes: { tipo: string; familia: string; unidad: UnidadCanonica; cantidadPorKm: number }[];
  };

/** Dónde se arregla la categoría de costeo de una unidad, según su flota. */
const dondeCategoria = (f: Flota) => (f === "tercero" ? "Tercerizadas → editar la unidad" : "Vehículos → editar la unidad");

/**
 * El juicio COMPARTIDO de combustible y costo: ¿hay km publicable y un parámetro con que convertirlo?
 * El orden va de la evidencia al juicio y gana el primero que aplique: sin km no hay nada que
 * estimar; sin unidad, nada con que estimarlo; después lo que falta en la ficha.
 */
function planDeConsumo(km: KmGps, ctx: ContextoCombustibleUnidad | null): PlanConsumo {
  if (km.km == null) {
    return { ok: false, codigo: "sin_km", base: `Sin km medible del GPS (${textoKmGps(km.codigo)}): no se estima. ${km.detalle}` };
  }
  if (!ctx) return { ok: false, codigo: "sin_unidad", base: "El servicio no tiene unidad asignada: no hay con qué estimar el consumo." };
  if (ctx.fallo) return { ok: false, codigo: "sin_lectura", base: `No se pudo leer la unidad o su parámetro de costos (${ctx.fallo}): no se afirma nada; se reintenta solo.` };
  if (!ctx.tipoCosteo) {
    return { ok: false, codigo: "sin_tipo_costeo", base: `La unidad no tiene «Categoría de costeo»: se asigna en ${dondeCategoria(ctx.flota)}.` };
  }
  if (!ctx.parametros || !ctx.decision) {
    return { ok: false, codigo: "sin_parametro", base: `El tipo «${ctx.tipoCosteo}» no existe en Configuración → Costos (Flota / Vehículos).` };
  }
  const p: ParametrosUnidad = { ...ctx.parametros, rendimiento_1: ctx.decision.valor };
  const tipos = [p.tipo_combustible_1, ...(p.tipo_combustible_2 && Number(p.pct_uso_2) > 0 ? [p.tipo_combustible_2] : [])];
  for (const t of tipos) {
    const f = familiaDeParametro(t);
    if (!f || !unidadDeFamilia(f)) {
      return {
        ok: false, codigo: "familia_desconocida",
        base: `El combustible «${t ?? "—"}» del tipo «${ctx.tipoCosteo}» no se reconoce: no se adivina (nunca se cuenta como diésel). Se corrige en Configuración → Costos.`,
      };
    }
  }
  // Lo que `consumoPorKm` ignora EN SILENCIO (un rendimiento en cero «no consume») aquí se dice:
  // publicar 0 galones sería afirmar que el bus no gastó.
  if (Number(p.pct_uso_1) > 0 && !(Number(p.rendimiento_1) > 0)) {
    return { ok: false, codigo: "sin_parametro", base: `El tipo «${ctx.tipoCosteo}» no tiene rendimiento de ${p.tipo_combustible_1}: se completa en Configuración → Costos.` };
  }
  if (p.tipo_combustible_2 && Number(p.pct_uso_2) > 0 && !(Number(p.rendimiento_2) > 0)) {
    return { ok: false, codigo: "sin_parametro", base: `El tipo «${ctx.tipoCosteo}» declara ${p.tipo_combustible_2} sin rendimiento: se completa en Configuración → Costos.` };
  }
  const partes: { tipo: string; familia: string; unidad: UnidadCanonica; cantidadPorKm: number }[] = [];
  for (const c of consumoPorKm(p)) {
    if (!Number.isFinite(c.cantidadPorKm) || c.cantidadPorKm < 0) {
      return { ok: false, codigo: "sin_parametro", base: `El parámetro del tipo «${ctx.tipoCosteo}» no da un consumo válido para ${c.tipo}.` };
    }
    if (c.cantidadPorKm === 0) continue;   // un % de uso en cero: ese combustible no se usa
    const familia = familiaDeParametro(c.tipo) as string;
    partes.push({ tipo: c.tipo, familia, unidad: unidadDeFamilia(familia) as UnidadCanonica, cantidadPorKm: c.cantidadPorKm });
  }
  if (!partes.length) {
    return { ok: false, codigo: "sin_parametro", base: `El tipo «${ctx.tipoCosteo}» no declara ningún combustible en uso (% de uso en cero).` };
  }
  return { ok: true, km: km.km, piso: km.piso, params: p, ctx, partes };
}

/** «42.0 km» o «≥ 42.0 km». */
const kmTexto = (km: number, piso: boolean) => `${piso ? "≥ " : ""}${num(km, 1)} km`;

/** El rendimiento de cada parte, en palabras: el principal con la base de `decidirRendimiento`. */
function textoRendimientos(plan: Extract<PlanConsumo, { ok: true }>): string {
  const { params: p, ctx } = plan;
  const partes = [ctx.decision!.base];
  if (plan.partes.length > 1 || (p.tipo_combustible_2 && Number(p.pct_uso_2) > 0)) {
    partes[0] = `${Math.round(Number(p.pct_uso_1) * 100)} % con ${p.tipo_combustible_1} a ${ctx.decision!.base}`;
    if (p.tipo_combustible_2 && Number(p.pct_uso_2) > 0) {
      partes.push(`${Math.round(Number(p.pct_uso_2) * 100)} % con ${p.tipo_combustible_2} a ${rend(Number(p.rendimiento_2))} del parámetro del tipo`);
    }
  }
  return partes.join("; ");
}

/**
 * El combustible que gastó el recorrido, ESTIMADO: km × `consumoPorKm`, por familia (galones o m³,
 * nunca sumados). Dos combustibles de la MISMA familia sí se suman: son la misma unidad.
 */
export function combustibleEstimado(km: KmGps, ctx: ContextoCombustibleUnidad | null): CombustibleEstimado {
  const plan = planDeConsumo(km, ctx);
  if (!plan.ok) return { codigo: plan.codigo, porFamilia: [], piso: false, base: plan.base };
  const acc = new Map<string, CantidadFamilia>();
  for (const parte of plan.partes) {
    const ya = acc.get(parte.familia) ?? { familia: parte.familia, unidad: parte.unidad, cantidad: 0 };
    ya.cantidad += plan.km * parte.cantidadPorKm;
    acc.set(parte.familia, ya);
  }
  const porFamilia = [...acc.values()];
  const cuanto = porFamilia.map((f) => `${num(f.cantidad, 2)} ${ETIQUETA_UNIDAD[f.unidad]} de ${etFamilia(f.familia)}`).join(" + ");
  return {
    codigo: "estimado",
    porFamilia,
    piso: plan.piso,
    base: `Estimado${plan.piso ? " (mínimo)" : ""}: ${kmTexto(plan.km, plan.piso)} del GPS · ${textoRendimientos(plan)} → ${plan.piso ? "≥ " : ""}${cuanto}. Recorrido urbano, como el presupuesto del servicio.`,
  };
}

/**
 * Lo que costó ese combustible, ESTIMADO (solo unidades propias): `calcularCostoUnidad(...)
 * .costoCombustible` con el km recorrido — el MISMO número que el renglón «Combustible» del
 * presupuesto del servicio (urea incluida), redondeado igual. Un tercero sale `tercero`: se le paga
 * la factura del proveedor y su combustible no es un costo de AFA.
 */
export function costoCombustibleEstimado(km: KmGps, ctx: ContextoCombustibleUnidad | null): CostoEstimado {
  if (ctx?.flota === "tercero") {
    return { codigo: "tercero", soles: null, piso: false, base: "Unidad tercerizada: se le paga la factura del proveedor; su combustible no es un costo de AFA." };
  }
  const plan = planDeConsumo(km, ctx);
  if (!plan.ok) return { codigo: plan.codigo, soles: null, piso: false, base: plan.base };
  const c = plan.ctx;
  if (c.falloPrecios) {
    return { codigo: "sin_lectura", soles: null, piso: false, base: `No se pudieron leer los precios de combustible (${c.falloPrecios}): el volumen se estima, el costo no.` };
  }
  const p = plan.params;
  // `calcularCostoUnidad` toma un precio ausente como 0 («gratis»): aquí se nombra lo que falta.
  const faltan = plan.partes.filter((x) => !(Number(c.precios[x.tipo]) > 0)).map((x) => x.tipo);
  const usaUrea = !!(p.usa_urea && p.tipo_combustible_1 === "Diésel" && p.rendimiento_1 > 0);
  if (usaUrea && !(Number(c.precios["UREA"]) > 0)) faltan.push("UREA");
  if (faltan.length) {
    return {
      codigo: "sin_precio", soles: null, piso: false,
      base: `Sin precio de ${faltan.join(" y ")} en Configuración → Costos (precios de combustible): un precio ausente no se toma como cero.`,
    };
  }
  const costo = calcularCostoUnidad(p, c.precios, { km: plan.km, dias: 1, peajes: 0, otros: 0, pernocte: 0, viaticos: 0 });
  if (!costo || !Number.isFinite(costo.costoCombustible)) {
    return { codigo: "sin_parametro", soles: null, piso: false, base: `El parámetro del tipo «${c.tipoCosteo}» no da un costo válido.` };
  }
  const principal = p.tipo_combustible_1;
  const fuentePrecio = c.precioUltimaCarga
    ? textoPrecioUltimaCarga(c.precioUltimaCarga, { conFecha: true })
    : `S/ ${(Number(c.precios[principal]) || 0).toFixed(2)} de referencia`;
  return {
    codigo: "estimado",
    soles: redondear2(costo.costoCombustible),
    piso: plan.piso,
    base: `Estimado${plan.piso ? " (mínimo)" : ""}: ${kmTexto(plan.km, plan.piso)} · ${textoRendimientos(plan)} · ${fuentePrecio}${usaUrea ? " · incluye la urea" : ""}. Es el renglón «Combustible» del presupuesto con el km recorrido.`,
  };
}

/** Kilos de CO₂ del combustible estimado: cantidad × factor de su familia (lib/combustible-tipos.ts). */
export function co2Estimado(c: CombustibleEstimado): Co2Estimado {
  if (c.codigo !== "estimado") return { codigo: c.codigo, kg: null, piso: false, porFamilia: [], base: c.base };
  const porFamilia: { familia: string; kg: number }[] = [];
  const pasos: string[] = [];
  for (const f of c.porFamilia) {
    const r = co2DeCantidad(f.familia, f.cantidad);
    if (r.codigo !== "estimado" || r.kg == null) {
      return {
        codigo: r.codigo, kg: null, piso: false, porFamilia: [],
        base: r.codigo === "sin_factor"
          ? `${etFamilia(f.familia)} no tiene factor de emisión declarado: no se estima su CO₂.`
          : `La cantidad de ${etFamilia(f.familia)} no es válida: no se estima su CO₂.`,
      };
    }
    porFamilia.push({ familia: f.familia, kg: r.kg });
    const fac = FACTOR_CO2[f.familia];
    pasos.push(`${num(f.cantidad, 2)} ${ETIQUETA_UNIDAD[f.unidad]} de ${etFamilia(f.familia)} × ${fac ? num(fac.kgPorUnidad, fac.kgPorUnidad < 5 ? 4 : 2) : "?"} kg/${ETIQUETA_UNIDAD[f.unidad]}`);
  }
  const kg = porFamilia.reduce((s, x) => s + x.kg, 0);
  return {
    codigo: "estimado",
    kg,
    piso: c.piso,
    porFamilia,
    base: `Estimado${c.piso ? " (mínimo)" : ""}: ${pasos.join(" + ")} = ${c.piso ? "≥ " : ""}${num(kg, 1)} kg de CO₂ (solo CO₂, no CO₂e; EPA).`,
  };
}

// ══ Excesos del servicio ═════════════════════════════════════════════════════════════════

export type CodigoExcesosServicio =
  | "medido"          // la huella trae velocímetro y se juzgó con el motor de /seguridad-vial
  | "sin_velocimetro" // llegaron posiciones, pero el teléfono no reporta velocidad: no se puede juzgar
  | "sin_posiciones"  // el servicio corrió y no llegó ninguna posición
  | "sin_medir"       // no se pudo leer el GPS (o se leyó sin sus filas): no se afirma nada
  | "no_aplica";      // el servicio no salió

export type ExcesosServicio = {
  codigo: CodigoExcesosServicio;
  /** episodios que cuentan (`exceso`). null salvo `medido`: «sin velocímetro» NO es «0 excesos». */
  n: number | null;
  /** segundos en exceso (suma de sus duraciones). null salvo `medido`. */
  segundos: number | null;
  /** velocidad máxima del sensor en esos episodios. null sin episodios o sin medir. */
  velMax: number | null;
  /** episodios descartados por motivo (breve, impreciso, sin corroborar…). Vacío salvo `medido`. */
  descartados: Partial<Record<CodigoDescarte, number>>;
  umbral: number;
  /** El rastreo no cubrió todo el servicio (o sigue en curso): `n` es un mínimo. */
  piso: boolean;
  base: string;
};

/**
 * Los excesos de UN servicio: los episodios de `detectarExcesos` (lib/flota/excesos.ts, el motor de
 * /seguridad-vial) sobre SU traza, restringidos a su reserva. Las filas de `conHuella` no traen
 * `reserva_id` (se leyeron POR reserva), así que a cada punto se le pone el de este servicio: sin
 * eso el motor los leería como «fuera de servicio».
 *
 * Tri-estado: un teléfono sin velocímetro sale `sin_velocimetro` con `n` null, NUNCA «0 excesos».
 */
export function excesosDelServicio(e: {
  reservaId: number;
  /** filas crudas de la traza (`traza.crudas`); null si no se leyó la traza */
  crudas: any[] | null;
  aplica: boolean;
  /** ¿se leyó la traza? (una traza leída sin sus filas no se puede juzgar) */
  trazaLeida: boolean;
  rastreo: VeredictoRastreo;
  umbral: number;
  /** clave de la unidad del servicio ("p:ID" | "t:ID"), para que los episodios la lleven */
  vehiculo?: string | null;
}): ExcesosServicio {
  const piso = e.rastreo.enCurso || !(e.rastreo.codigo === "completo" || e.rastreo.codigo === "aceptable");
  const vacio = (codigo: CodigoExcesosServicio, base: string): ExcesosServicio =>
    ({ codigo, n: null, segundos: null, velMax: null, descartados: {}, umbral: e.umbral, piso: false, base });
  if (!e.aplica) return vacio("no_aplica", "El servicio no salió: no hay velocidad que juzgar.");
  if (!e.trazaLeida || !e.crudas) return vacio("sin_medir", "No se pudo leer el GPS de este servicio: no se afirma ningún exceso.");
  // A cada punto se le pone la reserva (y la unidad) de ESTE servicio: la traza se leyó por reserva y
  // sus filas no traen esas columnas. Sin la reserva, el motor los leería como «fuera de servicio».
  const puntos = puntosDeCrudas(e.crudas, { reservaId: e.reservaId, vehiculo: e.vehiculo ?? null });
  // Tri-estado, con la MISMA regla que /seguridad-vial (`velocimetroDe`): hay posiciones si llegó
  // alguna con coordenadas y hora; hay velocímetro si alguna trae la velocidad del sensor (> 0).
  const hayPuntos = filasDeConductor(e.crudas).length > 0;
  const hayVelocidad = puntos.some((p) => p.velocidad > 0);
  const vel = velocimetroDe(hayPuntos, hayPuntos ? hayVelocidad : null);
  if (vel === "sin_gps") return vacio("sin_posiciones", "El servicio corrió y no llegó ninguna posición GPS: no hay velocidad que juzgar.");
  if (vel === "sin_velocimetro") {
    return vacio("sin_velocimetro", "El teléfono no reporta la velocidad del sensor (siempre 0): este servicio no se puede juzgar, y no es «0 excesos».");
  }
  if (vel !== "con_velocimetro") return vacio("sin_medir", "No se pudo saber si el teléfono reporta velocidad: no se afirma ningún exceso.");
  const eps = detectarExcesos(puntos, e.umbral).filter((x) => x.reservaId === e.reservaId);
  const cuentan = eps.filter((x) => x.codigo === "exceso");
  const descartados: Partial<Record<CodigoDescarte, number>> = {};
  for (const x of eps) if (x.codigo !== "exceso") descartados[x.codigo] = (descartados[x.codigo] ?? 0) + 1;
  const segundos = cuentan.reduce((acc, x) => acc + x.durS, 0);
  const velMax = cuentan.length ? Math.max(...cuentan.map((x) => x.velMaxSensor)) : null;
  const nDesc = eps.length - cuentan.length;
  return {
    codigo: "medido",
    n: cuentan.length,
    segundos,
    velMax,
    descartados,
    umbral: e.umbral,
    piso,
    base: `${cuentan.length} exceso(s) sostenido(s) y corroborado(s) sobre ${e.umbral} km/h`
      + `${cuentan.length ? ` (${Math.round(segundos)} s en total, máx. ${Math.round(velMax ?? 0)} km/h)` : ""}`
      + `${nDesc ? `; ${nDesc} episodio(s) descartado(s) (breves, imprecisos o sin corroborar)` : ""}`
      + `${piso ? ". El rastreo no cubrió todo el servicio: es un mínimo" : ""}.`,
  };
}

// ══ La estadística de UN servicio ════════════════════════════════════════════════════════

export type ClaveConductor = string;   // "p:ID" (conductores) · "t:ID" (conductores_tercero)

export type EstadisticaServicio = {
  reservaId: number;
  /** `reservas.fecha_servicio` */
  fecha: string;
  /** `reservas.codigo` (la OS) */
  codigo: string | null;
  estado: string | null;
  /** hora planificada `reservas.hora_servicio` ("HH:MM") */
  hora: string | null;
  cliente: { id: number | null; nombre: string | null };
  /** RUTA (nombre) y ORIGEN → DESTINO, por separado: nunca uno en lugar del otro. */
  ruta: IdentidadRuta;
  placa: string | null;
  flota: Flota | null;
  /** clave de la unidad: "p:ID" (vehiculos) · "t:ID" (vehiculos_tercero) */
  vehiculo: string | null;
  /** el conductor ASIGNADO en la reserva */
  conductor: { clave: ClaveConductor | null; nombre: string | null };
  /** el conductor que generó la traza (mayoría de las filas), SOLO si difiere del asignado */
  conductorGps: { clave: ClaveConductor; nombre: string | null } | null;
  /** inicio y fin con la evidencia del conductor (`derivarTiempos` SIN GPS) */
  inicio: Instante | null;
  fin: Instante | null;
  duracionMin: number | null;
  /** franja del GPS («~GPS hh:mm–hh:mm»), aparte de la evidencia del conductor. epoch ms. */
  gpsDesdeTs: number | null;
  gpsHastaTs: number | null;
  /** el MISMO veredicto que la celda RASTREO de /seguimiento */
  rastreo: VeredictoRastreo;
  /** el km del GPS, publicado según el veredicto (`kmPublicable`) */
  km: KmGps;
  /** De la huella, con la MISMA puerta que el km (más «sin desplazamiento», que es medido). Con
   *  `km.piso` los tiempos también son mínimos. null cuando no se publican. */
  marchaMin: number | null;
  detenidoMin: number | null;
  paradas: number | null;
  /** «Vel. máx (p95)»: el número del modal GPS */
  velMaxP95: number | null;
  excesos: ExcesosServicio;
  combustible: CombustibleEstimado;
  costo: CostoEstimado;
  co2: Co2Estimado;
};

/** Cómo se llaman las cosas: el lector los resuelve contra la base (sin teléfonos). */
export type NombresServicio = {
  conductor?: (clave: ClaveConductor) => string | null | undefined;
  cliente?: (id: number) => string | null | undefined;
  placa?: (claveVehiculo: string) => string | null | undefined;
};

/** Lo que sale de la HUELLA de un servicio (las filas crudas), calculado una sola vez: el lector lo
 *  saca en cuanto el servicio se mide y suelta las filas, para que no se acumulen en memoria. */
export type HuellaServicio = {
  resumen: ResumenViaje | null;
  km: KmGps;
  excesos: ExcesosServicio;
  conductorGps: ClaveConductor | null;
};

/** Lo mínimo de un `ServicioMedido` que usa este módulo. */
export type ServicioParaEstadistica = Pick<ServicioMedido, "reserva" | "paradas" | "ctx" | "traza" | "veredicto">;

/** Qué códigos del km dejan publicar lo demás que sale de la huella (marcha, detenido, paradas,
 *  velocidad). `sin_desplazamiento` sí: el rastreo es bueno y el bus no se movió, eso es un dato. */
export const HUELLA_PUBLICA: Record<CodigoKmGps, boolean> = {
  medido: true, piso: true, sin_desplazamiento: true,
  insuficiente: false, sin_gps: false, simulado: false, en_curso: false, sin_medir: false, no_aplica: false,
};

const idPositivo = (x: unknown): number | null => {
  if (x == null || x === "") return null;
  const n = Number(x);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** La clave de la unidad de la reserva: tercero primero (como `claveVehiculo`), sin inventar «p:null». */
export function vehiculoDeReserva(r: any): { clave: string; flota: Flota; id: number } | null {
  const t = idPositivo(r?.vehiculo_tercero_id);
  if (t != null) return { clave: `t:${t}`, flota: "tercero", id: t };
  const p = idPositivo(r?.vehiculo_id);
  if (p != null) return { clave: `p:${p}`, flota: "propia", id: p };
  return null;
}

/** La clave del conductor asignado: propio primero, como el resto del ERP. */
export function conductorDeReservaClave(r: any): ClaveConductor | null {
  const p = idPositivo(r?.conductor_id);
  if (p != null) return `p:${p}`;
  const t = idPositivo(r?.conductor_tercero_id);
  if (t != null) return `t:${t}`;
  return null;
}

/** Las filas crudas con lo que mira `conductorDeLaTraza` (la misma clasificación útil/antena y el
 *  mismo descarte de filas sin hora o sin coordenadas que `acumularFilasGps`). */
function filasDeConductor(crudas: any[]): FilaGpsDiag[] {
  const out: FilaGpsDiag[] = [];
  for (const f of crudas || []) {
    const ts = Date.parse(f?.created_at as any);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (f.lat == null || f.lng == null) continue;
    const lat = Number(f.lat), lng = Number(f.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const prec = f.precision_m == null ? null : Number(f.precision_m);
    const antena = prec !== null && Number.isFinite(prec) && prec > PRECISION_MAX_M;
    out.push({
      ts, lat, lng, util: !antena, antena, precisionM: prec, recibidoTs: null, fixTs: null,
      conductorId: idPositivo(f.conductor_id), conductorTerceroId: idPositivo(f.conductor_tercero_id),
    });
  }
  return out;
}

/**
 * Todo lo que sale de las filas crudas de un servicio: el resumen del viaje, el km publicable, los
 * excesos y el conductor del teléfono. Si la traza se leyó SIN sus filas (sin `conHuella`), el km no
 * se puede juzgar y sale `sin_medir`: jamás «sin desplazamiento» por no haber mirado.
 */
export function huellaDeServicio(s: ServicioParaEstadistica, umbral: number): HuellaServicio {
  try {
    return huellaSinProteger(s, umbral);
  } catch {
    // Una traza que rompe el cálculo no tumba el día entero ni se lee como «0 km»: ese servicio
    // sale `sin_medir` en todo lo que sale de la huella.
    const aplica = s.ctx.aplica;
    const noSe = "No se pudo calcular la huella de esta traza: no se afirma nada.";
    return {
      resumen: null,
      km: { codigo: aplica ? "sin_medir" : "no_aplica", km: null, piso: false, coberturaPct: s.veredicto.pct ?? null, detalle: noSe },
      excesos: { codigo: aplica ? "sin_medir" : "no_aplica", n: null, segundos: null, velMax: null, descartados: {}, umbral, piso: false, base: noSe },
      conductorGps: null,
    };
  }
}

function huellaSinProteger(s: ServicioParaEstadistica, umbral: number): HuellaServicio {
  const crudas = s.traza && Array.isArray(s.traza.crudas) ? s.traza.crudas : null;
  const resumen = crudas ? resumenDeFilas(crudas) : null;
  const km: KmGps = s.traza && !crudas && s.veredicto.codigo !== "no_aplica"
    ? { codigo: "sin_medir", km: null, piso: false, coberturaPct: s.veredicto.pct ?? null, detalle: "La traza se leyó sin sus filas: no se afirma ningún km." }
    : kmPublicable(s.veredicto, resumen, s.traza?.simulados ?? 0);
  const excesos = excesosDelServicio({
    reservaId: Number(s.reserva?.id), crudas, aplica: s.ctx.aplica, trazaLeida: !!s.traza, rastreo: s.veredicto, umbral,
    vehiculo: vehiculoDeReserva(s.reserva)?.clave ?? null,
  });
  const quien = crudas ? conductorDeLaTraza(filasDeConductor(crudas)) : null;
  const conductorGps = quien ? `${quien.tabla === "conductores" ? "p" : "t"}:${quien.id}` : null;
  return { resumen, km, excesos, conductorGps };
}

/**
 * La estadística de un servicio a partir de su huella YA calculada (`huellaDeServicio`). Es la mitad
 * que no necesita las filas crudas: el lector la llama cuando ya resolvió unidades y nombres.
 */
export function componerEstadistica(e: {
  s: ServicioParaEstadistica;
  huella: HuellaServicio;
  ctxComb: ContextoCombustibleUnidad | null;
  ahoraMs: number;
  hoy: string;
  nombres?: NombresServicio;
}): EstadisticaServicio {
  const r = e.s.reserva ?? {};
  const nombres = e.nombres ?? {};
  const { resumen, km } = e.huella;
  const t = derivarTiempos({ reserva: r, paradas: e.s.paradas ?? [], ahoraMs: e.ahoraMs, hoy: e.hoy });
  const veh = vehiculoDeReserva(r);
  const clienteId = idPositivo(r.cliente_id);
  const asignado = conductorDeReservaClave(r);
  const nombreDe = (c: ClaveConductor | null) => (c ? nombres.conductor?.(c) ?? null : null);
  const gps = e.huella.conductorGps;
  const publica = !!resumen && HUELLA_PUBLICA[km.codigo];
  const franja = !!resumen && km.codigo !== "simulado";
  const combustible = combustibleEstimado(km, e.ctxComb);
  return {
    reservaId: Number(r.id),
    fecha: String(r.fecha_servicio ?? ""),
    codigo: r.codigo != null && String(r.codigo).trim() ? String(r.codigo) : null,
    estado: r.estado ?? null,
    hora: r.hora_servicio ? String(r.hora_servicio).slice(0, 5) : null,
    cliente: { id: clienteId, nombre: clienteId != null ? nombres.cliente?.(clienteId) ?? null : null },
    ruta: identidadRuta(r),
    placa: veh ? nombres.placa?.(veh.clave) ?? null : null,
    flota: veh?.flota ?? null,
    vehiculo: veh?.clave ?? null,
    conductor: { clave: asignado, nombre: nombreDe(asignado) },
    conductorGps: gps && gps !== asignado ? { clave: gps, nombre: nombreDe(gps) } : null,
    inicio: t.inicio,
    fin: t.fin,
    duracionMin: t.duracionMin,
    gpsDesdeTs: franja ? resumen!.horaSalida : null,
    gpsHastaTs: franja ? resumen!.horaLlegada : null,
    rastreo: e.s.veredicto,
    km,
    marchaMin: publica ? resumen!.tiempoMovimientoMin : null,
    detenidoMin: publica ? resumen!.tiempoDetenidoMin : null,
    paradas: publica ? resumen!.paradas : null,
    velMaxP95: publica ? resumen!.velMaxKmh : null,
    excesos: e.huella.excesos,
    combustible,
    costo: costoCombustibleEstimado(km, e.ctxComb),
    co2: co2Estimado(combustible),
  };
}

/** La estadística de un servicio de punta a punta (huella + composición). El lector usa las dos
 *  mitades por separado para no retener las filas crudas; la matriz fija que dan lo mismo. */
export function estadisticaDeServicio(e: {
  s: ServicioParaEstadistica;
  ctxComb: ContextoCombustibleUnidad | null;
  umbral: number;
  ahoraMs: number;
  hoy: string;
  nombres?: NombresServicio;
}): EstadisticaServicio {
  return componerEstadistica({ ...e, huella: huellaDeServicio(e.s, e.umbral) });
}

// ══ Corte por cliente ════════════════════════════════════════════════════════════════════

export type FilaCliente = {
  /** null = servicios sin cliente (o el total) */
  clienteId: number | null;
  nombre: string;
  servicios: number;
  propios: number;
  terceros: number;
  sinUnidad: number;
  /** servicios con km publicable, y la suma de ese km (con `kmPiso` si alguno es un mínimo) */
  kmServicios: number;
  km: number;
  kmPiso: boolean;
  /** por familia, cada una en su unidad: NUNCA galones con m³ */
  combustible: CantidadFamilia[];
  combustibleServicios: number;
  combustiblePiso: boolean;
  /** soles estimados (solo propias), redondeado al céntimo */
  costoSoles: number;
  costoServicios: number;
  costoPiso: boolean;
  /** kg de CO₂ estimados (propias y terceros con parámetro) */
  co2Kg: number;
  co2Servicios: number;
  co2Piso: boolean;
  /** servicios cuyo CO₂ NO está en el total, por motivo */
  sinCo2: Partial<Record<CodigoCo2Servicio, number>>;
  /** servicios cuyo costo NO está en el total, por motivo (`tercero` incluido: se les paga factura) */
  sinCosto: Partial<Record<CodigoCosto, number>>;
};

function filaVacia(clienteId: number | null, nombre: string): FilaCliente {
  return {
    clienteId, nombre, servicios: 0, propios: 0, terceros: 0, sinUnidad: 0,
    kmServicios: 0, km: 0, kmPiso: false,
    combustible: [], combustibleServicios: 0, combustiblePiso: false,
    costoSoles: 0, costoServicios: 0, costoPiso: false,
    co2Kg: 0, co2Servicios: 0, co2Piso: false,
    sinCo2: {}, sinCosto: {},
  };
}

function acumular(f: FilaCliente, x: EstadisticaServicio): void {
  f.servicios++;
  if (x.flota === "propia") f.propios++;
  else if (x.flota === "tercero") f.terceros++;
  else f.sinUnidad++;
  if (x.km.km != null) {
    f.kmServicios++;
    f.km += x.km.km;
    if (x.km.piso) f.kmPiso = true;
  }
  if (x.combustible.codigo === "estimado") {
    f.combustibleServicios++;
    if (x.combustible.piso) f.combustiblePiso = true;
    for (const c of x.combustible.porFamilia) {
      // Se suma SOLO dentro de la misma familia (y por tanto de la misma unidad).
      const ya = f.combustible.find((y) => y.familia === c.familia && y.unidad === c.unidad);
      if (ya) ya.cantidad += c.cantidad;
      else f.combustible.push({ ...c });
    }
  }
  if (x.costo.codigo === "estimado" && x.costo.soles != null) {
    f.costoServicios++;
    f.costoSoles += x.costo.soles;
    if (x.costo.piso) f.costoPiso = true;
  } else f.sinCosto[x.costo.codigo] = (f.sinCosto[x.costo.codigo] ?? 0) + 1;
  if (x.co2.codigo === "estimado" && x.co2.kg != null) {
    f.co2Servicios++;
    f.co2Kg += x.co2.kg;
    if (x.co2.piso) f.co2Piso = true;
  } else f.sinCo2[x.co2.codigo] = (f.sinCo2[x.co2.codigo] ?? 0) + 1;
}

function cerrar(f: FilaCliente): FilaCliente {
  f.costoSoles = redondear2(f.costoSoles);
  f.combustible.sort((a, b) => a.familia.localeCompare(b.familia));
  return f;
}

/** El nombre con que se agrupa un servicio sin cliente. */
export const SIN_CLIENTE = "Sin cliente";

/**
 * El corte por cliente: km, combustible POR FAMILIA (nunca galones con m³), soles y kg sumados,
 * y cuántos servicios NO entran a cada total, con su motivo («N servicios sin km medible: su CO₂ no
 * está en el total»). Ordenado por CO₂ (desc) y nombre. Los soles y los kg cuadran con la suma de
 * las filas de servicio (la matriz lo fija).
 */
export function resumirPorCliente(xs: EstadisticaServicio[]): FilaCliente[] {
  const filas = new Map<string, FilaCliente>();
  for (const x of xs) {
    const k = x.cliente.id != null ? String(x.cliente.id) : "sin";
    let f = filas.get(k);
    if (!f) {
      f = filaVacia(x.cliente.id, x.cliente.id != null ? x.cliente.nombre ?? `Cliente #${x.cliente.id}` : SIN_CLIENTE);
      filas.set(k, f);
    }
    acumular(f, x);
  }
  return [...filas.values()].map(cerrar)
    .sort((a, b) => b.co2Kg - a.co2Kg || a.nombre.localeCompare(b.nombre));
}

/** La fila TOTAL del día, con el MISMO acumulador que las filas por cliente. */
export function totalDelDia(xs: EstadisticaServicio[]): FilaCliente {
  const f = filaVacia(null, "Total");
  for (const x of xs) acumular(f, x);
  return cerrar(f);
}

// ══ Respuesta de GET /api/flota/servicios ════════════════════════════════════════════════

export type RespuestaServicios = {
  /** "AAAA-MM-DD" */
  fecha: string;
  /** km/h con que se juzgaron los excesos */
  umbral: number;
  /** ISO del cálculo; null en una respuesta de error */
  medidoEn: string | null;
  servicios: EstadisticaServicio[];
  porCliente: FilaCliente[];
  total: FilaCliente;
  /** ids de reservas del día que NO se midieron por pasar del techo: sin km, sin CO₂ (nunca un 0) */
  fueraDelTecho: number[];
  /** el techo de servicios medidos por día (el de la torre) */
  tope: number;
  metodo: {
    fuenteCo2: string;
    factoresCo2: { familia: string; kgPorUnidad: number; unidad: UnidadCanonica }[];
    umbral: { min: number; max: number; defecto: number };
    /** combustible, costo y CO₂ por servicio son ESTIMADOS sobre el parámetro o la mediana medida, urbanos */
    recorrido: "urbano";
  };
  /** lo que no se pudo leer y degradó la respuesta (nombres, unidades, precios), dicho */
  avisos: string[];
  error?: string;
};

/** El bloque `metodo` de la respuesta (lo que la pantalla enseña en «Cómo se mide»). */
export function metodoServicios(): RespuestaServicios["metodo"] {
  const factoresCo2: RespuestaServicios["metodo"]["factoresCo2"] = [];
  for (const [familia, f] of Object.entries(FACTOR_CO2)) if (f) factoresCo2.push({ familia, kgPorUnidad: f.kgPorUnidad, unidad: f.unidad });
  return {
    fuenteCo2: FUENTE_FACTOR_CO2,
    factoresCo2,
    umbral: { min: UMBRAL_SERVICIO.min, max: UMBRAL_SERVICIO.max, defecto: UMBRAL_SERVICIO.defecto },
    recorrido: "urbano",
  };
}

/** Una respuesta vacía con su error (la ruta nunca contesta un 500 ni un «0 servicios» falso). */
export function respuestaConError(fecha: string, umbral: number, error: string, tope: number): RespuestaServicios {
  return {
    fecha, umbral, medidoEn: null, servicios: [], porCliente: [], total: totalDelDia([]),
    fueraDelTecho: [], tope, metodo: metodoServicios(), avisos: [], error,
  };
}

// ══ Rótulos cortos (las celdas enrutan por código; el `base` va en el title) ═════════════

export function textoCombustible(codigo: CodigoCombustible | CodigoCosto | CodigoCo2Servicio): string {
  switch (codigo) {
    case "estimado": return "Estimado";
    case "sin_km": return "Sin km medible";
    case "sin_unidad": return "Sin unidad asignada";
    case "sin_lectura": return "No se pudo leer";
    case "sin_tipo_costeo": return "Unidad sin categoría de costeo";
    case "sin_parametro": return "Sin parámetro de costos";
    case "familia_desconocida": return "Combustible no reconocido";
    case "tercero": return "Factura del proveedor";
    case "sin_precio": return "Sin precio de combustible";
    case "sin_factor": return "Sin factor de emisión";
    case "sin_cantidad": return "Sin cantidad";
  }
}

export function textoExcesos(codigo: CodigoExcesosServicio): string {
  switch (codigo) {
    case "medido": return "Medido";
    case "sin_velocimetro": return "Sin velocímetro";
    case "sin_posiciones": return "Sin posiciones";
    case "sin_medir": return "No se pudo medir";
    case "no_aplica": return "No salió";
  }
}

/** «12.34 gal de diésel + 3.10 m³ de GNV»; «—» sin estimación. Con «≥» si es un mínimo. */
export function textoCantidades(c: { porFamilia: CantidadFamilia[]; piso?: boolean } | CantidadFamilia[], piso = false): string {
  const lista = Array.isArray(c) ? c : c.porFamilia;
  const esPiso = Array.isArray(c) ? piso : !!c.piso;
  if (!lista.length) return "—";
  return `${esPiso ? "≥ " : ""}${lista.map((f) => `${num(f.cantidad, 2)} ${ETIQUETA_UNIDAD[f.unidad]} ${etFamilia(f.familia)}`).join(" + ")}`;
}

