// lib/costos/equilibrio-usado.ts — La categoría USADA contra su gemela PREMIUM: en qué renglón
// gana cada una, y cuál es el mantenimiento al que las dos cuestan exactamente lo mismo por
// kilómetro. Módulo PURO: recibe las dos fichas y los precios, y devuelve números.
//
// ─────────────────────────────────────────────────────────────────────────────
// EL PROBLEMA QUE RESUELVE, Y ES DE LECTURA ANTES QUE DE CÁLCULO
//
// `costos-02` creó una gemela usada por cada categoría con un mantenimiento de ×1.60, un factor
// SIN respaldo. Con él, las trece usadas salían MÁS CARAS que sus premium —el Bus 50 a S/ 1 537
// contra S/ 1 390— y la pantalla quedó afirmando algo que nadie midió. Medido sobre la
// Sprinter 17 (106 km): de los S/ 75 de diferencia, **S/ 54 eran ese factor inventado** y la
// depreciación solo devolvía S/ 12.
//
// Y la afirmación contraria tampoco se puede hacer: poner el mantenimiento de la usada igual al
// de la nueva diría que un bus de doce años mantiene como uno de fábrica, que subestima el
// costo — el error que este ERP declara caro en todas partes, porque se descubre cuando el
// servicio ya se prestó.
//
// LA SALIDA NO ES ELEGIR UN FACTOR, ES DEJAR DE AFIRMAR. El punto de equilibrio es el
// mantenimiento al que las dos fichas cuestan lo MISMO por km: por encima, la usada cuesta más;
// por debajo, menos. No es una medición y no pretende serlo — es el número que no inclina la
// balanza en ninguna dirección mientras la columna «Medido» de 🔧 Mantenimiento trae el real.
//
// Su consecuencia hay que decirla en pantalla: con el equilibrio puesto, premium y usado
// cuestan igual, y el premium se vende más caro **por el margen**, no por el costo.
// ─────────────────────────────────────────────────────────────────────────────
//
// SE CALCULA CON LA ÚNICA FÓRMULA (`componentesCostoKm`, lib/costos/costo-km-parametro.ts). Un
// despeje escrito aquí sería la cuarta copia de la misma cuenta —la que ese módulo vino a
// matar— y además tendría que vivir también en SQL para que una migración lo escribiera. Por
// eso el valor se calcula en TS y se APLICA con un UPDATE de literales que una persona revisa:
// `npx tsx scripts/equilibrio-usado.mts` lo imprime, no lo escribe.
import {
  componentesCostoKm, costoKmDeParametro,
  type ParametrosCostoKm, type PreciosCombustible,
} from "./costo-km-parametro";

/**
 * El sufijo que ata una ficha usada a su gemela. Es la CLAVE que escribió
 * `supabase/costos-02-categorias-estandar-usado.sql`, y no se renombra jamás: `tipo_vehiculo` es
 * el puente sin FK con `vehiculos.tipo_vehiculo_costeo`, `historial_costos.tipo_vehiculo` y
 * `cotizaciones.tipo_vehiculo`. El NOMBRE visible sí cambió dos veces —`· Estándar (usado)` y
 * después `· Estándar (>10 años)`, ver `costos-03`— y por eso nada empareja por el nombre.
 */
export const SUFIJO_USADO = "_ESTANDAR";

export function esUsado(tipoVehiculo: string | null | undefined): boolean {
  return String(tipoVehiculo ?? "").endsWith(SUFIJO_USADO);
}

/** La clave de la gemela premium de una usada. null si no es una usada. */
export function clavePremiumDe(tipoVehiculo: string | null | undefined): string | null {
  const t = String(tipoVehiculo ?? "");
  return esUsado(t) ? t.slice(0, -SUFIJO_USADO.length) : null;
}

/** La clave de la gemela usada de una premium. */
export function claveUsadaDe(tipoVehiculo: string): string {
  return `${tipoVehiculo}${SUFIJO_USADO}`;
}

/** Un par de fichas. `usada` puede faltar: no todas las categorías tienen versión usada. */
export type ParFlota<T> = { clave: string; premium: T; usada: T | null };

/**
 * Empareja una flota de tipos: cada premium con su usada.
 *
 * Conserva el ORDEN de entrada de las premium —la pantalla ya viene ordenada por grupo y
 * capacidad— y una usada HUÉRFANA (sin su premium, porque alguien la desactivó) sale como par
 * propio en vez de desaparecer: una ficha activa que la pantalla no lista es una ficha que se
 * sigue cotizando y nadie ve.
 */
export function emparejarFlota<T extends { tipo_vehiculo: string }>(tipos: T[]): ParFlota<T>[] {
  const porClave = new Map(tipos.map((t) => [t.tipo_vehiculo, t]));
  const usadas = new Set<string>();
  const out: ParFlota<T>[] = [];

  for (const t of tipos) {
    if (esUsado(t.tipo_vehiculo)) continue;                    // se engancha a su premium
    const usada = porClave.get(claveUsadaDe(t.tipo_vehiculo)) ?? null;
    if (usada) usadas.add(usada.tipo_vehiculo);
    out.push({ clave: t.tipo_vehiculo, premium: t, usada });
  }
  for (const t of tipos) {
    if (!esUsado(t.tipo_vehiculo) || usadas.has(t.tipo_vehiculo)) continue;
    out.push({ clave: t.tipo_vehiculo, premium: t, usada: null });   // huérfana: se ve igual
  }
  return out;
}

// ─── LA COMPARACIÓN RENGLÓN A RENGLÓN ─────────────────────────────────────────

/** Los seis renglones del S/km, con el nombre que ya usa la pantalla de costos. */
export const RENGLONES = [
  { clave: "combustible", label: "Combustible" },
  { clave: "urea", label: "UREA" },
  { clave: "neumaticos", label: "Neumáticos" },
  { clave: "mantenimiento", label: "Mantenimiento" },
  { clave: "depreciacion", label: "Depreciación" },
  { clave: "fijos", label: "Seguros y fijos" },
] as const;

export type ClaveRenglon = typeof RENGLONES[number]["clave"];

export type FilaComparacion = {
  clave: ClaveRenglon;
  label: string;
  premium: number;
  usada: number;
  /** `usada − premium`. Positivo = la usada gasta más en ese renglón. */
  delta: number;
};

export type ComparacionPar = {
  filas: FilaComparacion[];
  totalPremium: number;
  totalUsada: number;
  /** `totalUsada − totalPremium`, en S/km. */
  delta: number;
  /** El mismo delta como fracción del total premium. null si el premium no tiene costo. */
  deltaPct: number | null;
};

/**
 * Qué cuesta cada renglón en las dos fichas y cuánto se mueve.
 *
 * Es la evidencia sin la cual el resultado parece un error: la usada ahorra en depreciación y en
 * seguros, y paga más en mantenimiento y combustible. Ver los seis renglones a la vez es lo que
 * convierte «el usado sale más caro» en una frase verificable.
 */
export function compararPar(
  premium: ParametrosCostoKm,
  usada: ParametrosCostoKm,
  precios: PreciosCombustible
): ComparacionPar {
  const p = componentesCostoKm(premium, precios);
  const u = componentesCostoKm(usada, precios);
  const filas: FilaComparacion[] = RENGLONES.map(({ clave, label }) => ({
    clave, label,
    premium: p[clave],
    usada: u[clave],
    delta: u[clave] - p[clave],
  }));
  const totalPremium = costoKmDeParametro(premium, precios);
  const totalUsada = costoKmDeParametro(usada, precios);
  return {
    filas,
    totalPremium,
    totalUsada,
    delta: totalUsada - totalPremium,
    deltaPct: totalPremium > 0 ? (totalUsada - totalPremium) / totalPremium : null,
  };
}

// ─── EL PUNTO DE EQUILIBRIO ───────────────────────────────────────────────────

export type CodigoEquilibrio =
  /** Hay número: el mantenimiento al que las dos fichas cuestan lo mismo por km. */
  | "equilibrio"
  /** Esta ficha no es una usada, o su gemela no existe / no está activa. */
  | "sin_gemela"
  /** Algún parámetro deja la cuenta en infinito (un divisor en cero sin llenar). */
  | "parametro_incompleto"
  /** Ni con el taller GRATIS la usada empata: el resto de sus renglones ya la pasa. */
  | "imposible";

export type Equilibrio = {
  codigo: CodigoEquilibrio;
  /** El mantenimiento de equilibrio, en S/km. Solo con `codigo === "equilibrio"`. */
  mantenimiento: number | null;
  /** Lo que la ficha usada tiene tecleado hoy. */
  actual: number;
  /** `actual − equilibrio`: positivo = hoy la usada cuesta MÁS por km que su gemela. */
  brecha: number | null;
  detalle: string;
};

/**
 * El mantenimiento al que la ficha usada cuesta exactamente lo mismo por km que su gemela.
 *
 * Es un DESPEJE de la fórmula única, no una fórmula nueva: se le pide a `componentesCostoKm`
 * todo lo que la usada gasta SIN el taller y se resta del costo total de la premium.
 *
 * SE REDONDEA HACIA ARRIBA AL CÉNTIMO, y no es un detalle de presentación: por debajo del
 * equilibrio el ERP estaría afirmando que la unidad usada es más barata, que es exactamente lo
 * que no se puede afirmar sin haberlo medido. Medio céntimo del lado caro no le mueve el precio
 * a nadie; del lado barato sí cambia lo que la pantalla dice.
 */
export function mantenimientoDeEquilibrio(
  premium: ParametrosCostoKm | null | undefined,
  usada: ParametrosCostoKm | null | undefined,
  precios: PreciosCombustible
): Equilibrio {
  const actual = Number(usada?.mantenimiento_km ?? 0);
  const base = { mantenimiento: null as number | null, actual, brecha: null as number | null };

  if (!premium || !usada) {
    return {
      ...base, codigo: "sin_gemela",
      detalle:
        "Esta ficha no tiene una gemela premium activa con la que compararse, así que no hay " +
        "punto de equilibrio. La gemela es la categoría con la misma clave sin el sufijo " +
        `${SUFIJO_USADO}.`,
    };
  }

  const totalPremium = costoKmDeParametro(premium, precios);
  const u = componentesCostoKm(usada, precios);
  const sinTaller = u.combustible + u.urea + u.neumaticos + u.depreciacion + u.fijos;

  if (!Number.isFinite(totalPremium) || !Number.isFinite(sinTaller)) {
    return {
      ...base, codigo: "parametro_incompleto",
      detalle:
        "Alguna de las dos fichas tiene un parámetro sin llenar que deja la cuenta en infinito " +
        "(rendimiento, vida útil del neumático o km anuales en cero). Se corrige en la celda " +
        "correspondiente antes de comparar nada.",
    };
  }

  const crudo = totalPremium - sinTaller;
  if (crudo <= 0) {
    return {
      ...base, codigo: "imposible",
      detalle:
        `Ni con el taller en S/ 0.00 esta ficha empata: sin mantenimiento ya cuesta ` +
        `S/ ${sinTaller.toFixed(4)}/km contra los S/ ${totalPremium.toFixed(4)}/km de su gemela. ` +
        "Eso no lo arregla el mantenimiento — revisa su valor de compra, su vida útil o su " +
        "rendimiento, que son los renglones que la están encareciendo.",
    };
  }

  const mantenimiento = Math.ceil(crudo * 100) / 100;
  return {
    codigo: "equilibrio",
    mantenimiento,
    actual,
    brecha: Math.round((actual - mantenimiento) * 10000) / 10000,
    detalle:
      `Con ${mantenimiento.toFixed(2)} S/km de mantenimiento, esta ficha cuesta lo mismo por ` +
      "kilómetro que su gemela premium: lo que ahorra en depreciación y seguros se lo gasta en " +
      "taller y combustible. Por encima cuesta más; por debajo, menos. NO es una medición — es " +
      "el número que no afirma ninguna de las dos cosas mientras la columna «Medido» trae la real.",
  };
}

/**
 * El motivo que va a `historial_costos` al adoptar el equilibrio.
 *
 * Sin el prefijo `"Auto:"` a propósito: ese prefijo es el sello de una medición adoptada
 * (`motivoHistorialMant`), y esto no mide nada. Llamarlo igual haría que
 * `procedenciaMantDeHistorial` marcara la ficha como «medida» y el chip dejara de proponer el
 * número real cuando por fin exista — escribir con una identidad y leer con otra, otra vez.
 */
export function motivoEquilibrio(e: Equilibrio, nombrePremium: string): string {
  return (
    `Equilibrio con ${nombrePremium}: ${e.mantenimiento?.toFixed(2)} S/km es el mantenimiento al ` +
    "que las dos fichas cuestan lo mismo por km. Valor de arranque, no medido — lo reemplaza la " +
    "columna Medido de Mantenimiento."
  ).replace(/\s+/g, " ").trim();
}
