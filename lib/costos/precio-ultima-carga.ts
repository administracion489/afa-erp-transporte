// lib/costos/precio-ultima-carga.ts — MOTOR PURO. Qué carga de la placa puede poner el precio con que
// se costea su combustible principal, en lugar del precio de referencia (`precios_combustible`).
//
// EL DEFECTO QUE CIERRA (heredado del presupuesto, y por herencia del costo estimado por servicio de
// /uso-flota): `precioUltimaCarga` tomaba la última carga con precio de la placa SIN MIRAR QUÉ ERA.
// Dos formas de equivocarse, las dos normales en esta flota:
//   · OTRO PRODUCTO. Un bus diésel carga urea (AdBlue) a S/ 5.50 el LITRO; si esa era la última carga,
//     el presupuesto costeaba el diésel a S/ 5.50 el galón — un tercio de lo real. Lo mismo en una van
//     a GLP + gasolina (la CWQ400): la gasolina del aire acondicionado ponía el precio del GLP.
//   · OTRA UNIDAD. `combustible.precio_galon` es el precio por la unidad DE LA FILA, y un diésel o un
//     GLP despachado en litros trae S/ por litro: ×3.785 más barato que el galón con que se costea.
// Los dos errores van hacia ABAJO, que es el lado caro de un presupuesto: un costo corto no se discute
// antes de vender, se descubre cuando el servicio ya se prestó.
//
// LA REGLA, de la evidencia al juicio, sobre las cargas de la placa de la más nueva a la más vieja:
//   1. sin precio > 0 → no cuenta (`sin_precio`);
//   2. sin tipo reconocible → no cuenta (`sin_tipo`). NUNCA se supone diésel: es la convención de
//      PANTALLA para las cargas viejas sin tipo, y aquí el tipo decide plata (`tipoEstrictoDeCarga`);
//   3. de otra familia que la del PARÁMETRO → no cuenta (`otra_familia`). La urea es su propia
//      familia, así que nunca pone el precio de un combustible que mueve el bus;
//   4. en una unidad que no se convierte a la canónica de su familia → no cuenta
//      (`unidad_no_convertible`); los litros SÍ se convierten a galones (×3.785) — es el mismo
//      `factorAUnidadCanonica` con que el Radar y /combustible juzgan un precio;
//   5. ya convertido, fuera de la banda FÍSICA de su tipo → no cuenta (`fuera_de_banda`): un 250 por
//      galón es un importe tecleado en el campo del precio, no un precio. La banda es la del catálogo
//      (`rangoPrecio`), no un umbral nuevo;
//   6. la primera que pasa todo, MANDA.
// Una carga descartada no apaga la regla: se sigue buscando la anterior. «Última carga» pasa a
// significar «la última carga de ESTE combustible con un precio que pueda ser de él», y el texto del
// renglón lleva su fecha, así que nunca se presenta como más reciente de lo que es.
//
// LA FAMILIA DEL PARÁMETRO SALE DE `familiaDeParametro` (lib/costos/rendimiento-tipo.ts), NUNCA de
// `familiaCombustible`, que cae al diésel ante un valor desconocido. Sin familia reconocida no se mira
// ninguna carga (`familia_desconocida`): el precio de referencia, que es lo que una persona tecleó.
//
// LO QUE NO CAMBIA: un presupuesto ya guardado lleva su precio congelado en `parametros_json`. Solo un
// presupuesto nuevo —o uno recalculado— costea con la regla nueva. Y cuando la última carga ya era del
// combustible del parámetro, en su unidad y con un precio posible, el resultado es byte a byte el de
// antes (scripts/prueba-precio-ultima-carga.mts lo barre contra el algoritmo viejo copiado literal).

import {
  COMBUSTIBLES, configCombustible, factorAUnidadCanonica, tipoEstrictoDeCarga, unidadDeCarga,
} from "@/lib/combustible-tipos";

/** Cuántas cargas recientes de la placa se le pasan al selector. Operativo, no medido: una unidad
 *  que carga urea cada tanto y su combustible a diario tiene de sobra; si en 30 cargas no hay
 *  ninguna válida de su familia, el precio de referencia es más actual que lo que hubiera detrás. */
export const CARGAS_LEIDAS_ULTIMA = 30;

/** Una fila de `combustible`, tal como la devuelve PostgREST. */
export type CargaConPrecio = {
  id?: number | string | null;
  fecha: string | null;
  tipo_combustible: string | null;
  /** `combustible.unidad`. Vacío = la canónica de la familia, como en todo el ERP. */
  unidad?: string | null;
  precio_galon: number | string | null;
};

/** La carga que manda, con el precio YA en la unidad canónica de su familia. */
export type UltimaCarga = {
  /** S/ por la unidad canónica (galón o m³): lo que se compara con `precios_combustible`. */
  precio: number;
  fecha: string;
  /** Código del catálogo de la carga (`diesel`, `gasolina_premium`…). Opcional solo para que los
   *  contextos armados a mano (las matrices) sigan valiendo; el selector siempre lo llena. */
  tipo?: string;
  /** Lo que dice la fila, antes de convertir. */
  precioFila?: number;
  unidadFila?: "galones" | "litros" | "m3";
  /** true si el precio se pasó de litros a galones. */
  convertida?: boolean;
};

export type CodigoDescarte = "sin_precio" | "sin_tipo" | "otra_familia" | "unidad_no_convertible" | "fuera_de_banda";

export type CodigoUltimaCarga =
  /** Hay una carga válida y manda. */
  | "ultima_carga"
  /** El combustible del parámetro no se reconoce: no se compara contra ninguna carga. */
  | "familia_desconocida"
  /** La placa no tiene cargas. */
  | "sin_cargas"
  /** Tiene cargas, pero ninguna sirve (todas cuentan en `descartadas`). */
  | "ninguna_valida";

export type ResultadoUltimaCarga = {
  codigo: CodigoUltimaCarga;
  /** != null ⟺ codigo === "ultima_carga". */
  carga: UltimaCarga | null;
  /** Las cargas MÁS NUEVAS que la elegida que no sirvieron, por motivo. Con `ninguna_valida`, todas. */
  descartadas: Record<CodigoDescarte, number>;
};

const DESCARTES_VACIOS = (): Record<CodigoDescarte, number> => ({
  sin_precio: 0, sin_tipo: 0, otra_familia: 0, unidad_no_convertible: 0, fuera_de_banda: 0,
});

/** El juicio de UNA carga: el precio canónico si sirve, o el motivo si no. */
export function juzgarCarga(
  c: CargaConPrecio,
  familia: string,
): { ok: true; carga: UltimaCarga } | { ok: false; codigo: CodigoDescarte } {
  const precioFila = Number(c.precio_galon);
  if (!Number.isFinite(precioFila) || precioFila <= 0) return { ok: false, codigo: "sin_precio" };
  const tipo = tipoEstrictoDeCarga(c.tipo_combustible);
  if (!tipo) return { ok: false, codigo: "sin_tipo" };
  if (COMBUSTIBLES[tipo].familia !== familia) return { ok: false, codigo: "otra_familia" };
  const unidadFila = unidadDeCarga(tipo, c.unidad);
  const factor = factorAUnidadCanonica(unidadFila, tipo);
  if (factor === null || !(factor > 0)) return { ok: false, codigo: "unidad_no_convertible" };
  const precio = precioFila * factor;
  const { min, max } = configCombustible(tipo).rangoPrecio;
  if (!(precio >= min && precio <= max)) return { ok: false, codigo: "fuera_de_banda" };
  return {
    ok: true,
    carga: {
      precio, fecha: String(c.fecha ?? "").slice(0, 10), tipo, precioFila, unidadFila,
      convertida: factor !== 1,
    },
  };
}

/** Orden total: fecha descendente y, en el mismo día, id descendente. No se confía en el orden de entrada. */
function compararMasNueva(a: CargaConPrecio, b: CargaConPrecio): number {
  const fa = String(a.fecha ?? "").slice(0, 10), fb = String(b.fecha ?? "").slice(0, 10);
  if (fa !== fb) return fa < fb ? 1 : -1;
  const ia = Number(a.id), ib = Number(b.id);
  if (Number.isFinite(ia) && Number.isFinite(ib) && ia !== ib) return ib - ia;
  const sa = String(a.id ?? ""), sb = String(b.id ?? "");
  return sa === sb ? 0 : sa < sb ? 1 : -1;
}

/**
 * La carga cuyo precio sustituye al de referencia del combustible del parámetro, o el motivo de que
 * ninguna lo haga. `familia` es la de `familiaDeParametro(parametros.tipo_combustible_1)`; null = no se
 * reconoce, y entonces no se mira ninguna carga.
 */
export function ultimaCargaDeFamilia(
  cargas: readonly CargaConPrecio[] | null | undefined,
  familia: string | null,
): ResultadoUltimaCarga {
  const descartadas = DESCARTES_VACIOS();
  if (!familia) return { codigo: "familia_desconocida", carga: null, descartadas };
  const filas = [...(cargas ?? [])].filter(Boolean).sort(compararMasNueva);
  if (!filas.length) return { codigo: "sin_cargas", carga: null, descartadas };
  for (const c of filas) {
    const j = juzgarCarga(c, familia);
    if (j.ok) return { codigo: "ultima_carga", carga: j.carga, descartadas };
    descartadas[j.codigo]++;
  }
  return { codigo: "ninguna_valida", carga: null, descartadas };
}

/** «gal» o «m³»: la unidad en que va el precio ya convertido (la canónica de su tipo). */
function etiquetaCanonica(tipo?: string): string {
  return configCombustible(tipo).unidadLabel;
}

/** El nombre de un tipo dentro de una frase: en minúscula, salvo las siglas (GLP, GNV). */
function nombreEnFrase(label: string): string {
  return /^[A-ZÁÉÍÓÚÑ]{2,}$/.test(label) ? label : label.toLowerCase();
}

/** El nombre de una FAMILIA (no de un tipo: «gasolina», no «gasolina regular»). */
const NOMBRE_FAMILIA: Record<string, string> = {
  diesel: "diésel", gasolina: "gasolina", glp: "GLP", gnv: "GNV", biodiesel: "biodiésel", urea: "urea",
};

/** El texto de la fuente del precio, para el renglón del presupuesto y la estadística por servicio. */
export function textoPrecioUltimaCarga(c: UltimaCarga, opts: { conFecha?: boolean } = {}): string {
  const u = c.tipo ? `/${etiquetaCanonica(c.tipo)}` : "";
  const prod = c.tipo ? ` de ${COMBUSTIBLES[c.tipo] ? nombreEnFrase(COMBUSTIBLES[c.tipo].label) : c.tipo}` : "";
  const notas: string[] = [];
  if (opts.conFecha && c.fecha) notas.push(c.fecha);
  if (c.convertida && c.precioFila != null && c.unidadFila) {
    const uf = c.unidadFila === "litros" ? "lt" : c.unidadFila === "m3" ? "m³" : "gal";
    notas.push(`se pagó S/ ${c.precioFila.toFixed(2)}/${uf}`);
  }
  return `S/ ${c.precio.toFixed(2)}${u} de la última carga${prod}${notas.length ? ` (${notas.join(" · ")})` : ""}`;
}

/** Por qué se costea con el precio de referencia. null cuando sí hubo última carga. */
export function motivoSinUltimaCarga(codigo: CodigoUltimaCarga | null | undefined, familia: string | null): string | null {
  const nombre = familia ? NOMBRE_FAMILIA[familia] ?? familia : null;
  switch (codigo) {
    case "familia_desconocida":
      return "el combustible del parámetro no se reconoce, así que no se compara contra las cargas";
    case "sin_cargas":
      return "la placa no tiene cargas con precio";
    case "ninguna_valida":
      return `ninguna carga reciente${nombre ? ` de ${nombre}` : ""} tiene un precio que pueda ser suyo`;
    default:
      return null;
  }
}
