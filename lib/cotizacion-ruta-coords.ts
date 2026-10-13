// ──────────────────────────────────────────────────────────────────────────────
// lib/cotizacion-ruta-coords.ts — Motor PURO: las coordenadas del ORIGEN, DESTINO y RETORNO de una
// cotización, de dónde salen al reabrirla y cuándo se puede volver a medir el km.
//
// EL CASO: «Ruta del servicio no está jalando las coordenadas». Los tres puntos de la ruta se
// elegían en Google Maps, el km se calculaba con sus coordenadas… y la cotización guardaba SOLO el
// TEXTO. Al reabrirla los tres puntos volvían sin coordenadas: ni el km se podía volver a medir, ni
// los paraderos 1 y último recibían las suyas, ni había nada que dibujar en un mapa. La pantalla
// tampoco las enseñaba nunca, así que no había forma de saber si un punto tenía coordenadas o no.
//
// LA CASCADA AL REABRIR, de lo exacto a lo aproximado (cada punto la suya):
//   1 · `ruta_coords_json` — lo que se guardó con la cotización (supabase/cotizaciones-02-ruta-coords.sql).
//       Solo si se guardó para ESE texto: si alguien cambió el texto por otra pantalla, las
//       coordenadas viejas describirían otro lugar.
//   2 · el paradero 1 (origen) o el último (destino) de `paradas_json`: el formulario les copia las
//       coordenadas del origen/destino, así que son las mismas.
//   3 · geocodificar el TEXTO (Google): APROXIMADO, y la pantalla lo dice. Lo hace quien tiene
//       Google cargado; este módulo solo dice qué puntos lo necesitan.
//
// EL KM GUARDADO NO SE PISA AL REABRIR. El km se recalcula cada vez que cambian los puntos, y
// restaurarlos es cambiarlos: sin freno, abrir una cotización reescribiría su km (que pudo
// corregirse a mano) con el de unas coordenadas que, en el escalón 3, ni siquiera son exactas.
// Por eso /cotizaciones CONGELA el km al restaurar y solo lo vuelve a medir cuando el operador toca
// un punto de la ruta o el tipo de servicio (que decide si se suma el retorno).
// ──────────────────────────────────────────────────────────────────────────────

export type FuenteCoord = "lista" | "coordenadas" | "mapa" | "guardada" | "paradero" | "texto";

export type PuntoRuta = { placeId: string; lat: number; lng: number; fuente?: FuenteCoord };

/** Lo que se guarda en `cotizaciones.ruta_coords_json`. El texto va dentro para saber si sigue valiendo. */
export type PuntoGuardado = { texto: string; lat: number; lng: number; placeId: string | null };
export type RutaCoordsJson = { v: 1; origen: PuntoGuardado | null; destino: PuntoGuardado | null; retorno: PuntoGuardado | null };

export type Extremo = "origen" | "destino" | "retorno";

/** Coordenadas utilizables: finitas, en rango y no (0,0) — el «sin dato» de varias pantallas. */
export function coordValida(lat: unknown, lng: unknown): boolean {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return false;
  if (typeof lat === "string" && lat.trim() === "") return false;
  if (typeof lng === "string" && lng.trim() === "") return false;
  const a = Number(lat), o = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(o)) return false;
  if (Math.abs(a) > 90 || Math.abs(o) > 180) return false;
  return !(a === 0 && o === 0);
}

/** Mismo lugar escrito igual: sin mayúsculas, tildes ni espacios de más. */
export function mismoTexto(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (s: string | null | undefined) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  return n(a) !== "" && n(a) === n(b);
}

function punto(p: PuntoRuta | null, texto: string): PuntoGuardado | null {
  if (!p || !coordValida(p.lat, p.lng) || !texto.trim()) return null;
  return { texto: texto.trim(), lat: Number(p.lat), lng: Number(p.lng), placeId: p.placeId || null };
}

/**
 * Lo que se guarda con la cotización. Una coordenada APROXIMADA (geocodificada desde el texto) se
 * guarda igual: es la que se ve en el mapa y la que mide el km; la próxima vez vuelve como
 * «guardada», no se vuelve a pagar la geocodificación. El retorno solo si el servicio vuelve.
 */
export function rutaCoordsParaGuardar(
  o: PuntoRuta | null, d: PuntoRuta | null, r: PuntoRuta | null,
  textos: { origen: string; destino: string; retorno: string }, vuelve: boolean,
): RutaCoordsJson | null {
  const out: RutaCoordsJson = { v: 1, origen: punto(o, textos.origen), destino: punto(d, textos.destino), retorno: vuelve ? punto(r, textos.retorno) : null };
  return out.origen || out.destino || out.retorno ? out : null;
}

/** Lee el jsonb guardado sin confiar en su forma: lo que no se entiende, no existe. */
export function leerRutaCoords(raw: unknown): RutaCoordsJson | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const uno = (x: unknown): PuntoGuardado | null => {
    if (!x || typeof x !== "object") return null;
    const p = x as Record<string, unknown>;
    if (!coordValida(p.lat, p.lng) || typeof p.texto !== "string") return null;
    return { texto: p.texto, lat: Number(p.lat), lng: Number(p.lng), placeId: typeof p.placeId === "string" && p.placeId ? p.placeId : null };
  };
  const out: RutaCoordsJson = { v: 1, origen: uno(r.origen), destino: uno(r.destino), retorno: uno(r.retorno) };
  return out.origen || out.destino || out.retorno ? out : null;
}

type ParadaMin = { tipo: string; lat?: string | number | null; lng?: string | number | null };

export type Restauracion = {
  origen: PuntoRuta | null;
  destino: PuntoRuta | null;
  retorno: PuntoRuta | null;
  /** Puntos con texto y sin coordenadas: quien tiene Google los geocodifica (aproximados). */
  porGeocodificar: Extremo[];
};

/**
 * De dónde salen las coordenadas de cada punto al reabrir la cotización (la cascada de arriba).
 * El retorno NO se deduce del origen ni de un paradero: vacío significa «vuelve al origen», y eso
 * lo resuelve el cálculo del km, no este módulo.
 */
export function resolverRestauracion(c: {
  origen: string | null; destino: string | null; punto_retorno: string | null;
  ruta_coords_json?: unknown; paradas_json?: ParadaMin[] | null;
}, vuelve: boolean): Restauracion {
  const g = leerRutaCoords(c.ruta_coords_json);
  const paradas = c.paradas_json ?? [];
  const deGuardado = (p: PuntoGuardado | null, texto: string | null): PuntoRuta | null =>
    p && mismoTexto(p.texto, texto) ? { placeId: p.placeId ?? "", lat: p.lat, lng: p.lng, fuente: "guardada" } : null;
  const deParadero = (tipo: "inicio" | "destino"): PuntoRuta | null => {
    const p = paradas.find(x => x.tipo === tipo);
    return p && coordValida(p.lat, p.lng) ? { placeId: "", lat: Number(p.lat), lng: Number(p.lng), fuente: "paradero" } : null;
  };
  const origen = deGuardado(g?.origen ?? null, c.origen) ?? (String(c.origen ?? "").trim() ? deParadero("inicio") : null);
  const destino = deGuardado(g?.destino ?? null, c.destino) ?? (String(c.destino ?? "").trim() ? deParadero("destino") : null);
  const retorno = vuelve ? deGuardado(g?.retorno ?? null, c.punto_retorno) : null;
  const porGeocodificar: Extremo[] = [];
  if (!origen && String(c.origen ?? "").trim()) porGeocodificar.push("origen");
  if (!destino && String(c.destino ?? "").trim()) porGeocodificar.push("destino");
  if (vuelve && !retorno && String(c.punto_retorno ?? "").trim()) porGeocodificar.push("retorno");
  return { origen, destino, retorno, porGeocodificar };
}

/** Cómo se rotula de dónde salió una coordenada (la pantalla no compone su propia frase). */
export function rotuloFuente(f: FuenteCoord | undefined): { texto: string; aproximada: boolean } {
  switch (f) {
    case "lista": return { texto: "de Google Maps", aproximada: false };
    case "coordenadas": return { texto: "ingresadas a mano", aproximada: false };
    case "mapa": return { texto: "movida en el mapa", aproximada: false };
    case "guardada": return { texto: "guardada con la cotización", aproximada: false };
    case "paradero": return { texto: "del paradero", aproximada: false };
    case "texto": return { texto: "aproximada, buscada por el texto — elígela de la lista o muévela en el mapa si no es el punto exacto", aproximada: true };
    default: return { texto: "", aproximada: false };
  }
}
