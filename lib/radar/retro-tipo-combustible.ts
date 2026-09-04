// lib/radar/retro-tipo-combustible.ts — Qué hacer con una carga de `combustible` YA
// registrada cuyo tipo pudo haberse escrito con el default de diésel.
//
// POR QUÉ EXISTE
//
// Hasta la corrección del tipo de combustible, los DOS escritores del Radar hacían
// `d.tipo_combustible ?? "diesel"`: el auto-registro (lib/radar/acciones.ts) y el botón
// manual de /radar-ia. Un voucher que no dijera el tipo entraba a `combustible` como
// diésel, y como la pantalla tampoco mostraba la columna, nadie lo desmentía. Esas filas
// siguen ahí y siguen ensuciando el km/gal de la unidad, el control de precio y el costo
// por km del Cotizador.
//
// LA HUELLA QUE PERMITE DECIDIR SIN ADIVINAR
//
// El código viejo guardaba en `radar_combustible.tipo_combustible` el texto CRUDO que leyó
// la IA (o null), y en `combustible.tipo_combustible` ese mismo texto **o "diesel"**. Así
// que la combinación
//
//     radar_combustible.tipo_combustible IS NULL  +  combustible.tipo_combustible = 'diesel'
//
// es exactamente "el default se aplicó y nadie leyó el tipo" — no una carga de diésel que
// la IA sí reconoció. Es un hecho registrado, no una inferencia, y es lo que permite
// separar la población que hay que mirar de la que está bien.
//
// LO QUE ESTE MÓDULO NO HACE
//
// No decide por el operador cuando no hay evidencia. La flota de AFA es mayoritariamente
// de diésel: cambiar en bloque todo lo que se registró como diésel sería cambiar de
// combustible cientos de cargas correctas. Solo propone `corregir` cuando el precio pagado
// aterriza sobre la referencia de OTRO combustible y ninguna banda incluye al diésel —
// que es justo el caso del GLP (S/ 7.55) y del GNV (S/ 1.78), los dos que el default se
// tragaba. Todo lo demás sale como `revisar` (con su motivo) o `dejar`.
//
// Las bandas de precio y el normalizador son los MISMOS de lib/combustibles.ts que usa el
// pipeline en vivo: si mañana cambian ahí, esto cambia con ellas. Reimplementarlas aquí
// habría creado dos verdades sobre qué precio es de qué combustible.

import {
  COMBUSTIBLES,
  candidatosPorPrecio,
  desvioDePrecio,
  etiquetaCombustible,
  normalizarTipoCombustible,
} from "@/lib/combustibles";

/** Una carga de `combustible` con lo que se sabe de su origen, ya cruzada por el script. */
export type CargaRetro = {
  id: number;
  /** Lo que hay HOY en `combustible.tipo_combustible`. */
  tipo_combustible: string | null;
  /** Precio por unidad registrado (`precio_galon`). */
  precio_galon: number | null;
  galones: number | null;
  /** `combustible.unidad` — galones | litros | m3. Solo se compara, nunca se reescribe. */
  unidad: string | null;
  fecha: string | null;
  placa: string | null;
  /** true si existe una fila de `radar_combustible` que apunta a esta carga. */
  ligada_al_radar: boolean;
  /** `radar_combustible.tipo_combustible` de esa fila: el texto CRUDO que leyó la IA. */
  radar_tipo_leido: string | null;
  /** Combustible que declara la ficha de costeo de la unidad, si la tiene. */
  ficha_tipo: string | null;
};

export type VeredictoRetro = {
  /**
   * `normalizar` — el mismo combustible, escrito de otra forma ("PETROLEO D2" → diesel).
   * `corregir`   — es OTRO combustible, y el precio lo demuestra.
   * `revisar`    — hay que mirarla, pero el sistema no puede decidir.
   * `dejar`      — está bien, o no es asunto de esta corrección.
   */
  accion: "normalizar" | "corregir" | "revisar" | "dejar";
  /** Tipo canónico a escribir. Solo en `normalizar` y `corregir`. */
  tipo?: string;
  motivo: string;
  /** Aviso adicional que no cambia el veredicto (p. ej. la unidad ya no calza). */
  nota?: string;
};

/** Precio por unidad de una carga: el registrado o, si no hay, el que sale del importe. */
export function precioDeCarga(c: CargaRetro): number | null {
  const p = Number(c.precio_galon);
  if (Number.isFinite(p) && p > 0) return p;
  return null;
}

/**
 * Qué hacer con una carga. `refs` son las referencias de precio por tipo
 * (`referenciasDePrecio` sobre `precios_combustible`).
 *
 * El orden de las reglas importa y es de más cierto a menos: primero lo que se resuelve
 * con lo que está escrito, y solo al final lo que necesita evidencia de precio.
 */
export function clasificarCarga(c: CargaRetro, refs: Record<string, number>): VeredictoRetro {
  const guardado = (c.tipo_combustible ?? "").trim();
  const canon = normalizarTipoCombustible(guardado);

  // 1) Hay un texto que se entiende pero no está en forma canónica ("PETROLEO D2",
  //    "Diesel", "GLP-G"). Es el MISMO combustible: normalizarlo no cambia ningún número,
  //    y sin normalizar /combustible lo agrupa en un cubo aparte y su km/gal no suma con
  //    el resto de las cargas de esa unidad.
  if (guardado && canon && canon !== guardado) {
    return { accion: "normalizar", tipo: canon, motivo: `"${guardado}" es ${etiquetaCombustible(canon)} escrito de otra forma` };
  }

  // 2) Hay un texto que NO se entiende. Nadie puede decidir por el operador qué compró.
  if (guardado && !canon) {
    return { accion: "revisar", motivo: `"${guardado}" no corresponde a ningún combustible del catálogo` };
  }

  // 3) Sin tipo en absoluto (fila anterior a que la columna se llenara siempre).
  if (!guardado) {
    const cands = candidatosPorPrecio(precioDeCarga(c), refs);
    if (cands.length === 1) {
      return { accion: "corregir", tipo: cands[0].tipo, motivo: `sin tipo; el precio ${soles(precioDeCarga(c))} solo calza con ${etiquetaCombustible(cands[0].tipo)} (ref. ${soles(cands[0].referencia)})` };
    }
    return { accion: "revisar", motivo: "la carga no tiene tipo de combustible y el precio no alcanza para deducirlo" };
  }

  // A partir de aquí el tipo guardado es canónico. Solo se cuestiona el DEFAULT de diésel:
  // cualquier otro valor lo puso alguien (la IA lo leyó, o un humano lo eligió).
  if (canon !== "diesel") return { accion: "dejar", motivo: `registrada como ${etiquetaCombustible(canon)}, no es el default` };

  // 4) Un diésel que NO escribió el Radar es una carga que alguien tecleó en /combustible
  //    eligiendo el tipo en pantalla. No es asunto de esta corrección.
  if (!c.ligada_al_radar) return { accion: "dejar", motivo: "no la registró el Radar IA (se eligió el tipo a mano en /combustible)" };

  // 5) El Radar la escribió, pero el voucher SÍ decía el tipo y decía diésel.
  if (normalizarTipoCombustible(c.radar_tipo_leido) === "diesel") {
    return { accion: "dejar", motivo: `el voucher decía "${c.radar_tipo_leido}" — el diésel está leído, no asumido` };
  }

  // 6) Aquí está la población del problema: la escribió el Radar, quedó en diésel, y la
  //    fila del Radar no tiene tipo leído. El default se aplicó. ¿Lo desmiente el precio?
  const precio = precioDeCarga(c);
  if (precio == null) {
    return { accion: "revisar", motivo: "diésel por defecto y sin precio unitario con el que contrastarlo" };
  }
  const cands = candidatosPorPrecio(precio, refs);
  if (cands.some((x) => x.tipo === "diesel")) {
    return { accion: "dejar", motivo: `diésel por defecto, pero el precio ${soles(precio)} es coherente con diésel (ref. ${soles(refs.diesel)})` };
  }
  const desvio = desvioDePrecio(precio, "diesel", refs);
  if (cands.length === 1 && (desvio ?? 0) > 0.25) {
    const hallado = cands[0];
    const cfg = COMBUSTIBLES[hallado.tipo];
    const unidadGuardada = (c.unidad ?? "").trim().toLowerCase();
    // La cantidad se midió en la unidad que dijera el voucher; cambiar el tipo no la
    // reinterpreta. Si el nuevo tipo se despacha en otra unidad, se AVISA y no se toca.
    const nota =
      cfg && unidadGuardada && cfg.unidad !== unidadGuardada
        ? `la cantidad quedó en "${unidadGuardada}" y el ${cfg.label} se despacha en "${cfg.unidad}" — revisa la cantidad, no se reescribe`
        : undefined;
    return {
      accion: "corregir",
      tipo: hallado.tipo,
      motivo: `diésel por defecto, pero el precio ${soles(precio)} está ${Math.round((desvio ?? 0) * 100)}% fuera del diésel y calza con ${etiquetaCombustible(hallado.tipo)} (ref. ${soles(hallado.referencia)})`,
      nota,
    };
  }
  if (cands.length > 1) {
    return { accion: "revisar", motivo: `diésel por defecto y el precio ${soles(precio)} calza con varios (${cands.map((x) => etiquetaCombustible(x.tipo)).join(", ")})` };
  }
  // Ningún candidato: el precio no es de ningún combustible conocido. Eso ya es un
  // problema por sí mismo, y cambiarle el tipo no lo arregla.
  if (c.ficha_tipo && c.ficha_tipo !== "diesel") {
    return { accion: "revisar", motivo: `diésel por defecto, precio ${soles(precio)} fuera de toda referencia, y la ficha de la unidad dice ${etiquetaCombustible(c.ficha_tipo)}` };
  }
  return { accion: "revisar", motivo: `diésel por defecto y el precio ${soles(precio)} no calza con ninguna referencia` };
}

/** Nota de auditoría que se anexa a `observaciones` de la carga corregida. */
export function notaDeCorreccion(v: VeredictoRetro, tipoAnterior: string | null, hoy: string): string {
  const antes = (tipoAnterior ?? "").trim() || "sin tipo";
  return ` · Tipo corregido ${antes} → ${v.tipo} (${v.motivo}) [retro-tipo ${hoy}]`;
}

function soles(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `S/ ${Number(n).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
