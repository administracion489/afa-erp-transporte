// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/motor.ts — ¿Este pedido es un TRASLADO SIMPLE, con qué vehículo y a qué precio?
// Motor PURO: no lee la base ni llama a Google. Recibe las zonas, categorías, tarifas y el tipo
// de cambio ya cargados (lib/traslados/datos.ts) y la ubicación ya geocodificada
// (lib/traslados/ubicar.ts), y devuelve una decisión DECLARADA con su motivo.
//
// LA IA NO PONE EL PRECIO. El agente del CRM solo recoge los datos del cliente y marca las
// señales de complejidad que lee en la conversación; el vehículo, el precio, el IGV y la
// validez salen de aquí y de la tabla de tarifas que edita una persona. Así el número que la IA
// escribe en el chat y el del PDF son siempre el mismo, y nadie puede rebajarlo conversando.
//
// LAS REGLAS QUE NO SE AFLOJAN:
//  1. Una ZONA se decide por evidencia, nunca por «contiene»: «San Juan de Miraflores» contiene
//     «Miraflores» (está en el tarifario real) y es otro distrito, a 15 km. Se compara el nombre
//     COMPLETO normalizado (sin tildes ni mayúsculas) contra el nombre y los alias de cada zona.
//  2. «Lima» a secas no es ningún distrito: Google lo usa también para direcciones de San Isidro
//     o Lince («C. 3 Sur 260, Lima 15036» es San Isidro). Leerlo como Cercado cotizaría el
//     distrito equivocado; se declara `distrito_ambiguo` y el pedido va a un ejecutivo.
//  3. Ante la duda se DERIVA, no se adivina: un pedido derivado le cuesta al ejecutivo un minuto;
//     una cotización con el precio de otra zona se descubre cuando el cliente ya la aceptó.
//  4. El vehículo es el MÁS CHICO donde caben pasajeros y maletas. Sin bodega, cada maleta de
//     23 kg ocupa un asiento (la regla «con maletas, el doble de capacidad», escrita por maleta);
//     con bodega, las maletas van primero ahí y solo lo que sobra ocupa asientos.
//  5. Si el vehículo que cabe no tiene precio en ese par de zonas, NO se ofrece uno más grande
//     en silencio: sería cobrarle al cliente una unidad que no necesita. Se deriva.
// ──────────────────────────────────────────────────────────────────────────────

import { aPENdesdeCot, revisarTipoCambio, type Moneda } from "../cotizacion-moneda";

export type { Moneda };

// ── Tipos de la base ─────────────────────────────────────────────────────────

export type TipoZona = "distrito" | "subzona" | "punto";

export type Zona = {
  id: number;
  nombre: string;
  tipo: TipoZona;
  padre_id: number | null;
  sector?: string | null;
  alias?: string[] | null;
  lat?: number | null;
  lng?: number | null;
  radio_m?: number | null;
  activo?: boolean | null;
  orden?: number | null;
};

export type CategoriaTraslado = {
  clave: string;
  nombre: string;
  capacidad: number;
  maletas_bodega: number;
  tipo_vehiculo?: string | null;
  orden?: number | null;
  activo?: boolean | null;
};

export type TarifaTraslado = {
  id?: number;
  zona_a_id: number;
  zona_b_id: number;
  categoria: string;
  moneda: Moneda;
  precio_tramo: number;
  activo?: boolean | null;
};

/** Lo que el geocodificador dijo de una dirección. Los nombres van del más específico al más general. */
export type PuntoUbicado = {
  texto?: string | null;
  lat: number | null;
  lng: number | null;
  /** locality → administrative_area_level_3 → administrative_area_level_2 (Google). */
  localidades: string[];
  /** sublocality / neighborhood: sirven para elegir SUBZONA; para el distrito, solo de respaldo. */
  barrios: string[];
};

// ── Normalización ────────────────────────────────────────────────────────────

/** Nombre comparable: sin tildes, minúsculas, guiones y puntos como espacio. NO se persiste. */
export function claveNombre(s: unknown): string {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[-_.,/()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Nombres que Google pone en la dirección y que NO identifican un distrito: la ciudad, la
 * provincia, la región, el país. «Callao» no está: es también el nombre de un distrito, y Google
 * lo da como provincia solo DESPUÉS de la localidad, que es lo que se mira primero.
 */
export const NOMBRES_GENERICOS: ReadonlySet<string> = new Set([
  "lima", "provincia de lima", "lima metropolitana", "region lima", "departamento de lima",
  "lima province", "lima region", "municipalidad metropolitana de lima", "metropolitan municipality of lima",
  "provincia constitucional del callao", "region callao", "callao region", "peru",
]);

export const esGenerico = (s: string): boolean => NOMBRES_GENERICOS.has(claveNombre(s));

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Distancia en metros entre dos puntos (haversine). */
export function distanciaM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

const tieneCoords = (x: { lat?: number | null; lng?: number | null }): x is { lat: number; lng: number } =>
  Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lng)) && x.lat != null && x.lng != null;

const activa = (z: { activo?: boolean | null }) => z.activo !== false;

/** Los nombres por los que se reconoce una zona: el suyo y sus alias, normalizados. */
export function nombresDeZona(z: Zona): string[] {
  return [z.nombre, ...(z.alias ?? [])].map(claveNombre).filter(Boolean);
}

// ── 1. La zona de un punto ───────────────────────────────────────────────────

export type CodigoZona =
  | "punto"                // dentro de una geocerca (el aeropuerto): manda sobre el distrito
  | "subzona_alias"        // el barrio que dio Google es el nombre o alias de una subzona
  | "subzona_cercana"      // la subzona cuyo centro está más cerca, dentro de su distrito
  | "distrito"             // el distrito (sin subzonas, o sin coordenadas para elegir una)
  | "distrito_por_barrio"  // Google no dio el distrito como localidad; salió de un barrio
  | "distrito_ambiguo"     // Google solo dijo «Lima»
  | "distrito_desconocido" // dio nombres, pero ninguno está en el catálogo de zonas
  | "sin_ubicacion";       // ni coordenadas ni nombres

export const ZONA_CON_RESULTADO: ReadonlySet<CodigoZona> = new Set(
  ["punto", "subzona_alias", "subzona_cercana", "distrito", "distrito_por_barrio"] as CodigoZona[],
);

export type UbicacionZona = {
  codigo: CodigoZona;
  /** La zona que se usa para el precio (subzona, distrito o punto). null ⟺ el código no tiene resultado. */
  zona: Zona | null;
  /** El distrito al que pertenece (para un punto, null). */
  distrito: Zona | null;
  distancia_m: number | null;
  detalle: string;
};

function primerDistrito(nombres: string[], distritos: Zona[]): Zona | null {
  for (const n of nombres) {
    const k = claveNombre(n);
    if (!k || NOMBRES_GENERICOS.has(k)) continue;
    const z = distritos.find((d) => nombresDeZona(d).includes(k));
    if (z) return z;
  }
  return null;
}

export function zonaDePunto(p: PuntoUbicado | null | undefined, zonas: readonly Zona[]): UbicacionZona {
  const vivas = zonas.filter(activa);
  const conCoords = !!p && tieneCoords(p);
  const localidades = p?.localidades ?? [];
  const barrios = p?.barrios ?? [];
  if (!p || (!conCoords && localidades.length === 0 && barrios.length === 0)) {
    return { codigo: "sin_ubicacion", zona: null, distrito: null, distancia_m: null, detalle: "No se pudo ubicar la dirección en el mapa." };
  }

  // 1) Geocercas: el punto dentro de su radio manda sobre el distrito.
  if (conCoords) {
    let mejor: { z: Zona; d: number } | null = null;
    for (const z of vivas) {
      if (z.tipo !== "punto" || !tieneCoords(z) || !(Number(z.radio_m) > 0)) continue;
      const d = distanciaM(p.lat as number, p.lng as number, Number(z.lat), Number(z.lng));
      if (d <= Number(z.radio_m) && (!mejor || d < mejor.d)) mejor = { z, d };
    }
    if (mejor) {
      return {
        codigo: "punto", zona: mejor.z, distrito: null, distancia_m: Math.round(mejor.d),
        detalle: `${mejor.z.nombre}: a ${Math.round(mejor.d)} m de su centro (radio ${mejor.z.radio_m} m).`,
      };
    }
  }

  // 2) El distrito, por la localidad que dio Google (y solo de respaldo, por un barrio).
  const distritos = vivas.filter((z) => z.tipo === "distrito");
  let distrito = primerDistrito(localidades, distritos);
  let porBarrio = false;
  if (!distrito) {
    distrito = primerDistrito(barrios, distritos);
    porBarrio = !!distrito;
  }
  if (!distrito) {
    const utiles = [...localidades, ...barrios].filter((n) => claveNombre(n) && !esGenerico(n));
    if (utiles.length === 0) {
      return {
        codigo: "distrito_ambiguo", zona: null, distrito: null, distancia_m: null,
        detalle: "Google solo indicó «Lima», que no identifica el distrito.",
      };
    }
    return {
      codigo: "distrito_desconocido", zona: null, distrito: null, distancia_m: null,
      detalle: `Ningún distrito del catálogo se llama ${utiles.map((n) => `«${n}»`).join(", ")}. Si es un nombre válido, agrégalo como alias.`,
    };
  }

  // 3) Subzona: por nombre de barrio; si no, la de centro más cercano dentro del distrito.
  const subzonas = vivas.filter((z) => z.tipo === "subzona" && z.padre_id === distrito!.id && tieneCoords(z));
  const codigoDistrito: CodigoZona = porBarrio ? "distrito_por_barrio" : "distrito";
  const sufijo = porBarrio ? " (deducido de un barrio: Google no dio el distrito)" : "";
  if (subzonas.length === 0) {
    return { codigo: codigoDistrito, zona: distrito, distrito, distancia_m: null, detalle: `${distrito.nombre}${sufijo}.` };
  }
  const claves = [...barrios, ...localidades].map(claveNombre);
  const porAlias = subzonas.find((s) => nombresDeZona(s).some((n) => claves.includes(n)));
  if (porAlias) {
    return { codigo: "subzona_alias", zona: porAlias, distrito, distancia_m: null, detalle: `${porAlias.nombre} (por el nombre del barrio).` };
  }
  if (!conCoords) {
    return {
      codigo: codigoDistrito, zona: distrito, distrito, distancia_m: null,
      detalle: `${distrito.nombre}: tiene subzonas, pero sin coordenadas no se puede elegir una.`,
    };
  }
  let cerca = subzonas[0];
  let dMin = Infinity;
  for (const s of subzonas) {
    const d = distanciaM(p.lat as number, p.lng as number, Number(s.lat), Number(s.lng));
    if (d < dMin || (d === dMin && s.id < cerca.id)) { dMin = d; cerca = s; }
  }
  return {
    codigo: "subzona_cercana", zona: cerca, distrito, distancia_m: Math.round(dMin),
    detalle: `${cerca.nombre}: el centro de subzona más cercano, a ${(dMin / 1000).toFixed(1)} km${sufijo}.`,
  };
}

// ── 2. La tarifa de un par de zonas ──────────────────────────────────────────

/** El par sin sentido: A↔B = B↔A. Es la misma regla con que se GUARDA (zona_a_id <= zona_b_id). */
export function parOrdenado(a: number, b: number): [number, number] {
  return a <= b ? [a, b] : [b, a];
}

export type NivelTarifa = "exacta" | "por_distrito";

export type TarifaEncontrada = { tarifa: TarifaTraslado; nivel: NivelTarifa; zona_a: Zona; zona_b: Zona };

/**
 * Busca el precio de un par: primero las dos zonas tal cual; si alguna es SUBZONA y no tiene precio
 * propio, el de su distrito. Así una subzona solo hace falta preciarla cuando cuesta distinto.
 */
export function tarifaDelPar(
  a: Zona, b: Zona, categoria: string, moneda: Moneda,
  tarifas: readonly TarifaTraslado[], zonas: readonly Zona[],
): TarifaEncontrada | null {
  const porId = new Map(zonas.map((z) => [z.id, z]));
  const escalera = (z: Zona): Zona[] => {
    const padre = z.tipo === "subzona" && z.padre_id != null ? porId.get(z.padre_id) : undefined;
    return padre && activa(padre) && padre.tipo === "distrito" ? [z, padre] : [z];
  };
  const vivas = tarifas.filter((t) => activa(t) && t.categoria === categoria && t.moneda === moneda && Number(t.precio_tramo) > 0);
  for (const za of escalera(a)) {
    for (const zb of escalera(b)) {
      const [x, y] = parOrdenado(za.id, zb.id);
      const t = vivas.find((v) => v.zona_a_id === x && v.zona_b_id === y);
      if (t) return { tarifa: t, nivel: za === a && zb === b ? "exacta" : "por_distrito", zona_a: za, zona_b: zb };
    }
  }
  return null;
}

// ── 3. El vehículo ───────────────────────────────────────────────────────────

/** Asientos que hacen falta: los pasajeros + las maletas de 23 kg que NO caben en la bodega. */
export function asientosNecesarios(pax: number, maletas: number, c: CategoriaTraslado): number {
  return pax + Math.max(0, maletas - Math.max(0, Number(c.maletas_bodega) || 0));
}

export function cabeEn(pax: number, maletas: number, c: CategoriaTraslado): boolean {
  return pax <= c.capacidad && asientosNecesarios(pax, maletas, c) <= c.capacidad;
}

export type CodigoVehiculo = "ok" | "sin_precio" | "excede_capacidad" | "sin_categorias";

export type EleccionVehiculo = {
  codigo: CodigoVehiculo;
  /** La categoría elegida (con "sin_precio", la que cabría y no tiene precio). */
  categoria: CategoriaTraslado | null;
  /** Otras de la MISMA capacidad y con precio (la SUV al lado del auto): se mencionan, no se eligen. */
  alternativas: CategoriaTraslado[];
  asientos: number;
  detalle: string;
};

export function ordenarCategorias(cs: readonly CategoriaTraslado[]): CategoriaTraslado[] {
  return cs.filter(activa).slice().sort((a, b) =>
    a.capacidad - b.capacidad || (Number(a.orden) || 0) - (Number(b.orden) || 0) || a.clave.localeCompare(b.clave));
}

function textoCarga(pax: number, maletas: number, c: CategoriaTraslado): string {
  const p = `${pax} pasajero${pax === 1 ? "" : "s"}`;
  if (maletas <= 0) return `${p} → ${c.nombre}`;
  const m = `${maletas} maleta${maletas === 1 ? "" : "s"} de 23 kg`;
  const bodega = Math.max(0, Number(c.maletas_bodega) || 0);
  if (bodega === 0) return `${p} + ${m} sin bodega = ${asientosNecesarios(pax, maletas, c)} asientos → ${c.nombre}`;
  const enBodega = Math.min(maletas, bodega);
  const sobra = maletas - enBodega;
  return sobra > 0
    ? `${p}; ${enBodega} maletas en bodega y ${sobra} en asientos = ${pax + sobra} asientos → ${c.nombre}`
    : `${p}; las ${m} van en bodega (caben ${bodega}) → ${c.nombre}`;
}

export function elegirVehiculo(
  pax: number, maletas: number, categorias: readonly CategoriaTraslado[],
  conPrecio?: (c: CategoriaTraslado) => boolean,
): EleccionVehiculo {
  const orden = ordenarCategorias(categorias);
  if (orden.length === 0) {
    return { codigo: "sin_categorias", categoria: null, alternativas: [], asientos: pax + maletas, detalle: "No hay categorías de vehículo activas." };
  }
  const caben = orden.filter((c) => cabeEn(pax, maletas, c));
  if (caben.length === 0) {
    const mayor = orden[orden.length - 1];
    return {
      codigo: "excede_capacidad", categoria: null, alternativas: [], asientos: asientosNecesarios(pax, maletas, mayor),
      detalle: `${pax} pasajeros con ${maletas} maletas no caben en un solo vehículo: el más grande es ${mayor.nombre} (${mayor.capacidad} asientos, bodega para ${mayor.maletas_bodega}).`,
    };
  }
  const delNivel = caben.filter((c) => c.capacidad === caben[0].capacidad);
  const conP = conPrecio ? delNivel.filter(conPrecio) : delNivel;
  if (conP.length === 0) {
    return {
      codigo: "sin_precio", categoria: delNivel[0], alternativas: [], asientos: asientosNecesarios(pax, maletas, delNivel[0]),
      detalle: `Corresponde ${delNivel.map((c) => c.nombre).join(" o ")}, pero no tiene precio en este recorrido.`,
    };
  }
  const elegida = conP[0];
  return {
    codigo: "ok", categoria: elegida, alternativas: conP.slice(1),
    asientos: asientosNecesarios(pax, maletas, elegida), detalle: textoCarga(pax, maletas, elegida),
  };
}

// ── 4. La moneda: la decide el número de WhatsApp, salvo que el cliente pida dólares ──

export type CodigoMoneda = "peru" | "extranjero" | "sin_telefono" | "pide_dolares" | "ingles" | "pide_soles";

/**
 * Número peruano (+51, o un celular de 9 dígitos sin prefijo) → soles; cualquier otro país →
 * dólares (la lista de precio turista). Un BSUID de WhatsApp («PE.…») lleva el país delante.
 * Las dos listas NO son una conversión entre sí. Las únicas excepciones las decide
 * `monedaDelPedido`: el cliente que pide dólares, y el que escribe en inglés u otro idioma.
 */
export function monedaPorTelefono(tel: string | null | undefined): { moneda: Moneda | null; codigo: CodigoMoneda; detalle: string } {
  const s = String(tel ?? "").trim();
  const bsuid = s.match(/^([A-Za-z]{2})\./);
  if (bsuid) {
    const pais = bsuid[1].toUpperCase();
    return pais === "PE"
      ? { moneda: "PEN", codigo: "peru", detalle: "Usuario de WhatsApp de Perú: precios en soles." }
      : { moneda: "USD", codigo: "extranjero", detalle: `Usuario de WhatsApp de ${pais}: precios en dólares.` };
  }
  const d = s.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("51")) return { moneda: "PEN", codigo: "peru", detalle: "Número peruano (+51): precios en soles." };
  if (d.length === 9 && d.startsWith("9")) return { moneda: "PEN", codigo: "peru", detalle: "Celular peruano: precios en soles." };
  if (d.length >= 8 && !d.startsWith("51")) return { moneda: "USD", codigo: "extranjero", detalle: `Número extranjero (+${d.slice(0, 3)}…): precios en dólares.` };
  return { moneda: null, codigo: "sin_telefono", detalle: "Sin un número de WhatsApp válido no se sabe en qué moneda cotizar." };
}

/** El idioma del cliente cuando NO es castellano (lib/idioma-cliente.ts); null = castellano o sin evidencia. */
export type IdiomaClienteMoneda = "en" | "otro";

/**
 * La moneda de la cotización. Manda el número (`monedaPorTelefono`), con estas excepciones:
 *
 * 1. EL CLIENTE QUE PIDE DÓLARES (pedido por el dueño, 19-10-2026) recibe la lista en dólares aunque
 *    escriba desde un número peruano (o sin número). Es la lista que alguien tecleó, no una
 *    conversión de la de soles: este módulo no inventa precios.
 *
 * 2. EL IDIOMA (`extra.idiomaCliente`, que lo pone el CÓDIGO y solo con el inglés encendido;
 *    lib/traslados/envio-ia.ts → `entradaDelAgente`). Decisiones del dueño (22-10-2026):
 *    · en INGLÉS la moneda por defecto es el DÓLAR aunque el número sea +51 (`ingles`);
 *    · en OTRO idioma, la de hoy por número;
 *    · en inglés u otro idioma, el cliente que PIDE SOLES recibe la lista en soles (`pide_soles`),
 *      aunque escriba desde un número extranjero. ES UN CAMBIO DE CONFIANZA declarado: la lista en
 *      soles suele quedar por debajo de la de dólares al tipo de cambio del día. Lo mitigan la doble
 *      confirmación (el modelo lo marca Y los mensajes del cliente nombran los soles) y que en
 *      CASTELLANO no aplica: pedir soles desde un número extranjero en castellano sigue yendo a un
 *      ejecutivo (señal `otra_moneda`) — es el turista hispanohablante típico.
 *    · con soles Y dólares pedidos a la vez, ninguno de los dos: manda el defecto del idioma.
 *
 * `pideDolares` y `extra.pideSoles` no son lo que dijo el modelo: los pone `entradaDelAgente`
 * solo con las dos confirmaciones. Sin `extra` (o con `idiomaCliente` null), el resultado es byte a
 * byte el de siempre, y `pideSoles` no se mira.
 */
export function monedaDelPedido(
  tel: string | null | undefined,
  pideDolares: boolean | null | undefined,
  extra?: { idiomaCliente?: IdiomaClienteMoneda | null; pideSoles?: boolean | null },
): { moneda: Moneda | null; codigo: CodigoMoneda; detalle: string } {
  const porNumero = monedaPorTelefono(tel);
  const idioma = extra?.idiomaCliente === "en" || extra?.idiomaCliente === "otro" ? extra.idiomaCliente : null;
  const enDolares = (): { moneda: Moneda | null; codigo: CodigoMoneda; detalle: string } => {
    if (porNumero.moneda === "USD") return porNumero;
    return {
      moneda: "USD", codigo: "pide_dolares",
      detalle: porNumero.moneda === "PEN"
        ? "El cliente pidió la cotización en dólares: se cotiza con la lista en dólares aunque escribe desde un número peruano."
        : "El cliente pidió la cotización en dólares: se cotiza con la lista en dólares.",
    };
  };
  if (!idioma) return pideDolares !== true ? porNumero : enDolares();

  const dolares = pideDolares === true;
  const soles = extra?.pideSoles === true;
  const quien = idioma === "en" ? "escribe en inglés" : "escribe en otro idioma";
  if (soles && !dolares) {
    return {
      moneda: "PEN", codigo: "pide_soles",
      detalle: porNumero.moneda === "USD"
        ? `El cliente ${quien} y pidió la cotización en soles: se cotiza con la lista en soles aunque escribe desde un número extranjero.`
        : `El cliente ${quien} y pidió la cotización en soles: se cotiza con la lista en soles.`,
    };
  }
  if (dolares && !soles) return enDolares();
  // Sin pedido (o con los dos a la vez): el defecto del idioma.
  if (idioma === "otro" || porNumero.moneda === "USD") return porNumero;
  return {
    moneda: "USD", codigo: "ingles",
    detalle: porNumero.moneda === "PEN"
      ? "El cliente escribe en inglés: se cotiza con la lista en dólares aunque escribe desde un número peruano."
      : "El cliente escribe en inglés: se cotiza con la lista en dólares.",
  };
}

// ── 5. Tipo de cambio, fechas e importes ─────────────────────────────────────

/** Un tipo de cambio de más de una semana no se usa (no medido: SUNAT publica cada día). */
export const TC_MAX_DIAS = 7;

export function sumarDias(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const diasEntre = (desde: string, hasta: string) =>
  Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86400000);

/** Una fecha que EXISTE (el ida y vuelta descarta «2026-02-30», que V8 acepta como 2 de marzo). */
const esFecha = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export type CodigoTcTraslado = "ok" | "sin_tc" | "tc_viejo" | "tc_invalido";

export function tcParaCotizar(
  fila: { fecha?: string | null; venta?: unknown } | null | undefined, hoy: string,
): { tc: number | null; fecha: string | null; codigo: CodigoTcTraslado; detalle: string } {
  if (!fila || fila.venta == null) return { tc: null, fecha: null, codigo: "sin_tc", detalle: "No hay tipo de cambio de SUNAT cargado." };
  const rev = revisarTipoCambio(fila.venta);
  if (rev.tc == null) return { tc: null, fecha: fila.fecha ?? null, codigo: "tc_invalido", detalle: rev.detalle };
  if (esFecha(fila.fecha) && diasEntre(fila.fecha, hoy) > TC_MAX_DIAS) {
    return { tc: null, fecha: fila.fecha, codigo: "tc_viejo", detalle: `El último tipo de cambio es del ${fila.fecha}: tiene más de ${TC_MAX_DIAS} días.` };
  }
  return { tc: rev.tc, fecha: fila.fecha ?? null, codigo: "ok", detalle: `Tipo de cambio SUNAT venta ${rev.tc} (${fila.fecha ?? "sin fecha"}).` };
}

/** La cotización vale `dias` días o hasta la fecha del servicio, lo que llegue primero. */
export function validezHasta(hoy: string, fechaServicio: string | null | undefined, dias: number): string {
  const tope = sumarDias(hoy, Math.max(1, Math.round(dias) || 30));
  return esFecha(fechaServicio) && fechaServicio < tope ? fechaServicio : tope;
}

export function importesTraslado(precioTramo: number, tramos: number, igvPct: number): { subtotal: number; igv: number; total: number } {
  const subtotal = r2(Number(precioTramo) * tramos);
  const igv = r2(subtotal * (Number(igvPct) || 0) / 100);
  return { subtotal, igv, total: r2(subtotal + igv) };
}

// ── 6. La decisión ───────────────────────────────────────────────────────────

export type Sentido = "ida" | "ida_retorno";

/** Lo que la IA lee en la conversación y que hace que el pedido lo vea un ejecutivo. */
export type SenalComplejidad =
  | "tdr" | "licitacion" | "evento" | "varios_servicios" | "disposicion"
  | "guia_o_tour" | "descuento" | "contrato" | "otra_moneda" | "otro";

export const SENALES: Record<SenalComplejidad, string> = {
  tdr: "Trae TDR o términos de referencia",
  licitacion: "Es una licitación o concurso",
  evento: "Es un evento con varios servicios",
  varios_servicios: "Pide varios servicios distintos",
  disposicion: "Pide que el vehículo espere o quede a disposición",
  guia_o_tour: "Pide guía, city tour o full day",
  descuento: "Pide descuento o negocia el precio",
  contrato: "Es un contrato o un servicio recurrente",
  otra_moneda: "Pide una moneda que no se ofrece (euros, o soles desde un número extranjero)",
  otro: "Tiene condiciones que debe analizar un ejecutivo",
};

export type PedidoTraslado = {
  origen: PuntoUbicado | null;
  destino: PuntoUbicado | null;
  fecha_servicio: string | null;
  hora_servicio?: string | null;
  sentido: Sentido | null;
  fecha_retorno?: string | null;
  hora_retorno?: string | null;
  pax: number | null;
  /** Maletas de 23 kg. null = el cliente no lo dijo (hay que preguntar); 0 = no llevan. */
  maletas: number | null;
  telefono: string | null;
  /** El cliente pidió la cotización en dólares (verificado en sus mensajes): ver `monedaDelPedido`. */
  pide_dolares?: boolean | null;
  /** El cliente escribe en inglés u otro idioma (lo deriva el código, con el inglés encendido). Ausente = castellano. */
  idioma_cliente?: IdiomaClienteMoneda | null;
  /** El cliente que escribe en inglés u otro idioma pidió soles (verificado). Sin `idioma_cliente` no se mira. */
  pide_soles?: boolean | null;
  paradas_intermedias?: number | null;
  fechas_adicionales?: number | null;
  vehiculos_pedidos?: number | null;
  senales?: SenalComplejidad[] | null;
};

export type ContextoTraslado = {
  zonas: readonly Zona[];
  categorias: readonly CategoriaTraslado[];
  tarifas: readonly TarifaTraslado[];
  /** La fila más reciente de `tipo_cambio` (USD) con fecha <= hoy. */
  tipoCambio: { fecha?: string | null; venta?: unknown } | null;
  hoy: string;
  igvPct: number;
  validezDias: number;
};

export type CodigoTraslado =
  | "cotizable"
  | "falta_dato"
  | "complejo"
  | "fecha_pasada"
  | "sin_moneda"
  | "sin_zona_origen"
  | "sin_zona_destino"
  | "excede_capacidad"
  | "sin_tarifa"
  | "sin_tipo_cambio";

export type AccionTraslado = "cotizar" | "preguntar" | "derivar";

export const ACCION_DE: Record<CodigoTraslado, AccionTraslado> = {
  cotizable: "cotizar",
  falta_dato: "preguntar",
  fecha_pasada: "preguntar",
  complejo: "derivar",
  sin_moneda: "derivar",
  sin_zona_origen: "derivar",
  sin_zona_destino: "derivar",
  excede_capacidad: "derivar",
  sin_tarifa: "derivar",
  sin_tipo_cambio: "derivar",
};

export type PrecioTraslado = {
  moneda: Moneda;
  precio_tramo: number;
  tramos: number;
  subtotal: number;
  igv_pct: number;
  igv: number;
  total: number;
  /** El subtotal en soles: lo que se GUARDA (los importes del ERP son siempre soles). */
  subtotal_pen: number;
  total_pen: number;
  tipo_cambio: number | null;
  tipo_cambio_fecha: string | null;
  nivel: NivelTarifa;
};

export type ResultadoTraslado = {
  codigo: CodigoTraslado;
  accion: AccionTraslado;
  motivo: string;
  faltan: string[];
  /** Una línea por decisión tomada: la lee el ejecutivo y la enseña el simulador. */
  explicacion: string[];
  origen: UbicacionZona | null;
  destino: UbicacionZona | null;
  vehiculo: EleccionVehiculo | null;
  moneda: Moneda | null;
  precio: PrecioTraslado | null;
  validez_hasta: string | null;
};

/**
 * Lo que el motor le pide al cliente, con los MISMOS literales de siempre: una sola definición, para
 * que la traducción al inglés (lib/traslados/envio-ia.ts → `faltaEnIdioma`) reconozca cada uno por
 * igualdad exacta y no por parecido. Las dos direcciones que Google no encontró llevan una cita
 * del cliente y se arman aparte (`faltaDireccion`).
 */
export const FALTA = {
  recojo: "el punto de recojo",
  destino: "el destino",
  fecha: "la fecha del servicio",
  sentido: "si es solo ida o ida y retorno",
  fecha_retorno: "la fecha del retorno",
  pax: "el número de pasajeros",
  maletas: "cuántas maletas grandes (23 kg) llevan y cuántas son de mano (10 kg) o artículos personales",
  fecha_futura: "una fecha futura",
} as const;

/** «la dirección exacta del recojo (no se encontró «X»)»: el texto de siempre, armado en un solo sitio. */
export const faltaDireccion = (punto: "recojo" | "destino", texto: string | null | undefined): string =>
  `la dirección exacta del ${punto} (no se encontró «${texto ?? ""}»)`;

const entero = (n: unknown): number | null => {
  const v = Number(n);
  return n == null || n === "" || !Number.isFinite(v) ? null : Math.round(v);
};

export function evaluarTraslado(pedido: PedidoTraslado, ctx: ContextoTraslado): ResultadoTraslado {
  const exp: string[] = [];
  const base = (codigo: CodigoTraslado, motivo: string, extra: Partial<ResultadoTraslado> = {}): ResultadoTraslado => ({
    codigo, accion: ACCION_DE[codigo], motivo, faltan: [], explicacion: exp,
    origen: null, destino: null, vehiculo: null, moneda: null, precio: null, validez_hasta: null, ...extra,
  });

  // 1) Complejidad: lo primero, para no seguir pidiendo datos de un pedido que no es simple.
  const complejas: string[] = [];
  const paradas = entero(pedido.paradas_intermedias) ?? 0;
  const fechasExtra = entero(pedido.fechas_adicionales) ?? 0;
  const vehiculos = entero(pedido.vehiculos_pedidos) ?? 1;
  if (paradas > 0) complejas.push(`Tiene ${paradas} parada${paradas === 1 ? "" : "s"} intermedia${paradas === 1 ? "" : "s"}`);
  if (fechasExtra > 0) complejas.push("Pide el servicio en varias fechas");
  if (vehiculos > 1) complejas.push(`Pide ${vehiculos} vehículos`);
  for (const s of new Set(pedido.senales ?? [])) if (Object.prototype.hasOwnProperty.call(SENALES, s)) complejas.push(SENALES[s]);
  if (complejas.length) {
    exp.push(...complejas.map((c) => `No es un traslado simple: ${c.toLowerCase()}.`));
    return base("complejo", complejas.join(" · "));
  }

  // 2) Datos que faltan: se le preguntan al cliente.
  const pax = entero(pedido.pax);
  const maletas = entero(pedido.maletas);
  const faltan: string[] = [];
  if (!pedido.origen) faltan.push(FALTA.recojo);
  if (!pedido.destino) faltan.push(FALTA.destino);
  if (!esFecha(pedido.fecha_servicio)) faltan.push(FALTA.fecha);
  if (pedido.sentido !== "ida" && pedido.sentido !== "ida_retorno") faltan.push(FALTA.sentido);
  if (pedido.sentido === "ida_retorno" && !esFecha(pedido.fecha_retorno)) faltan.push(FALTA.fecha_retorno);
  if (pax == null || pax <= 0) faltan.push(FALTA.pax);
  if (maletas == null || maletas < 0) faltan.push(FALTA.maletas);
  if (faltan.length) return base("falta_dato", `Falta ${faltan.join(", ")}.`, { faltan });

  // 3) Fechas.
  if ((pedido.fecha_servicio as string) < ctx.hoy) {
    return base("fecha_pasada", `La fecha del servicio (${pedido.fecha_servicio}) ya pasó.`, { faltan: [FALTA.fecha_futura] });
  }
  if (pedido.sentido === "ida_retorno" && (pedido.fecha_retorno as string) < (pedido.fecha_servicio as string)) {
    return base("fecha_pasada", "La fecha del retorno es anterior a la de la ida.", { faltan: [FALTA.fecha_retorno] });
  }

  // 4) Moneda: por el número, salvo que el cliente haya pedido dólares (o escriba en inglés u otro idioma).
  const mon = monedaDelPedido(pedido.telefono, pedido.pide_dolares, {
    idiomaCliente: pedido.idioma_cliente ?? null, pideSoles: pedido.pide_soles === true,
  });
  exp.push(mon.detalle);
  if (!mon.moneda) return base("sin_moneda", mon.detalle);
  const moneda = mon.moneda;

  // 5) Zonas.
  const origen = zonaDePunto(pedido.origen, ctx.zonas);
  const destino = zonaDePunto(pedido.destino, ctx.zonas);
  exp.push(`Recojo: ${origen.detalle}`, `Destino: ${destino.detalle}`);
  // Una dirección que Google no encontró se le vuelve a pedir al cliente, más exacta.
  const noUbicadas = [
    origen.codigo === "sin_ubicacion" ? faltaDireccion("recojo", pedido.origen?.texto) : null,
    destino.codigo === "sin_ubicacion" ? faltaDireccion("destino", pedido.destino?.texto) : null,
  ].filter((x): x is string => !!x);
  if (noUbicadas.length) return base("falta_dato", `Falta ${noUbicadas.join(" y ")}.`, { faltan: noUbicadas, origen, destino, moneda });
  if (!origen.zona) return base("sin_zona_origen", `No se pudo asignar zona al recojo: ${origen.detalle}`, { origen, destino, moneda });
  if (!destino.zona) return base("sin_zona_destino", `No se pudo asignar zona al destino: ${destino.detalle}`, { origen, destino, moneda });
  const za = origen.zona;
  const zb = destino.zona;

  // 6) Vehículo con precio en este par y esta moneda.
  const precioDe = (c: CategoriaTraslado) => tarifaDelPar(za, zb, c.clave, moneda, ctx.tarifas, ctx.zonas);
  const vehiculo = elegirVehiculo(pax as number, maletas as number, ctx.categorias, (c) => precioDe(c) != null);
  exp.push(`Vehículo: ${vehiculo.detalle}`);
  if (vehiculo.codigo === "excede_capacidad" || vehiculo.codigo === "sin_categorias") {
    return base("excede_capacidad", vehiculo.detalle, { origen, destino, moneda, vehiculo });
  }
  if (vehiculo.codigo === "sin_precio" || !vehiculo.categoria) {
    return base("sin_tarifa", `${za.nombre} ↔ ${zb.nombre}: ${vehiculo.detalle} (${moneda})`, { origen, destino, moneda, vehiculo });
  }
  const encontrada = precioDe(vehiculo.categoria) as TarifaEncontrada;

  // 7) Tipo de cambio (solo dólares: el ERP guarda soles).
  let tc: number | null = null;
  let tcFecha: string | null = null;
  if (moneda === "USD") {
    const r = tcParaCotizar(ctx.tipoCambio, ctx.hoy);
    exp.push(r.detalle);
    if (r.tc == null) return base("sin_tipo_cambio", r.detalle, { origen, destino, moneda, vehiculo });
    tc = r.tc;
    tcFecha = r.fecha;
  }

  // 8) Precio.
  const tramos = pedido.sentido === "ida_retorno" ? 2 : 1;
  const precioTramo = Number(encontrada.tarifa.precio_tramo);
  const imp = importesTraslado(precioTramo, tramos, ctx.igvPct);
  const subtotalPen = aPENdesdeCot(imp.subtotal, moneda, tc) as number;
  const totalPen = aPENdesdeCot(imp.total, moneda, tc) as number;
  const tarifaTxt = encontrada.nivel === "exacta"
    ? `${encontrada.zona_a.nombre} ↔ ${encontrada.zona_b.nombre}`
    : `${encontrada.zona_a.nombre} ↔ ${encontrada.zona_b.nombre} (precio del distrito: la subzona no tiene uno propio)`;
  exp.push(`Tarifa ${tarifaTxt}: ${moneda} ${precioTramo.toFixed(2)} por tramo × ${tramos}.`);
  const validez = validezHasta(ctx.hoy, pedido.fecha_servicio, ctx.validezDias);
  return base("cotizable", `${vehiculo.categoria.nombre} · ${tramos === 2 ? "ida y retorno" : "solo ida"} · ${moneda} ${imp.subtotal.toFixed(2)} + IGV`, {
    origen, destino, moneda, vehiculo, validez_hasta: validez,
    precio: {
      moneda, precio_tramo: precioTramo, tramos, subtotal: imp.subtotal, igv_pct: ctx.igvPct, igv: imp.igv, total: imp.total,
      subtotal_pen: subtotalPen, total_pen: totalPen, tipo_cambio: tc, tipo_cambio_fecha: tcFecha, nivel: encontrada.nivel,
    },
  });
}
