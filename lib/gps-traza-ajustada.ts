// lib/gps-traza-ajustada.ts — LA TRAZA AJUSTADA A LA VÍA QUE SE GUARDA PARA SIEMPRE (motor PURO).
//
// Puro e isomórfico (lo importa el navegador): no lee la base y NO HACE NINGUNA LLAMADA DE RED —
// la matriz (scripts/prueba-traza-ajustada.mts §7) lo comprueba sobre el código. El único módulo de
// servidor que ajusta es lib/gps-traza-ajustada-calculo.ts; el que lee y escribe la fila es
// lib/gps-traza-ajustada-datos.ts.
//
// QUÉ SE GUARDA: SOLO la salida del ajustador de Map Matching (lib/huella.ts → crearAjustadorHuella):
// los vértices, `esCrudo` por vértice y `colaSnapped`. Todo lo demás —huella limpia, velocidad,
// puentes, `suprimir`, `colaViva`, telemetría— se DERIVA al abrir, igual que hoy. Los puentes NO se
// guardan: son geometría de Google Directions, que sus términos limitan a 30 días (lib/rutas-cache.ts).
// `crudoRanges` y `colaClean` tampoco: se derivan con `rangosDeCrudo`, la MISMA función del ajustador.
//
// FORMATO (jsonb `{ v, p, c, s, n }`):
//   v · VERSION_AJUSTE (cambia si cambia el ajuste o el formato: una traza de otra versión no se lee)
//   p · los vértices en polyline de precisión 6 (orden lat,lng, el estándar). Es la precisión de
//       Mapbox: la geometría de vía no pierde nada; un fix crudo pierde ≤ 0,11 m.
//   c · `esCrudo` en RLE: longitudes de corridas alternadas, EMPEZANDO POR `false` (si el primer
//       vértice es crudo, c[0] = 0). Suman n.
//   s · colaSnapped.
//   n · número de vértices.
//
// IDENTIDAD: lo guardado lleva la FIRMA de su entrada (sha256 de VERSION_AJUSTE + `canonEntradaAjuste`
// de las filas que el modal recibe, calculada en el lector). Se escribe con la firma de `filasOk` y se
// lee comparando con la firma de `filasOk`, armadas por la MISMA función (lib/gps-huella-servicio-datos).

import { rangosDeCrudo } from "./huella";

/* eslint-disable @typescript-eslint/no-explicit-any -- filas crudas de PostgREST */

// ── Versión y topes (declarados, NO medidos) ──────────────────────────────────────────────
// 2 (14-10-2026): las trazas de la versión 1 se calcularon sin mirar si Mapbox rechazaba el token del
// servidor, y con el token rechazado quedaron guardadas en crudo (caso #1608). Subir la versión las
// invalida todas (`decodificarTraza` rechaza otra versión): se vuelven a calcular al abrirlas.
// 3 (14-10-2026): una recta larga EN MARCHA entre fixes de chip que Map Matching no pegó pasa a ser
// `esCrudo` (fixEnRectaEnMarcha, lib/huella.ts): la salida del ajustador cambió y las guardadas antes
// se recalculan.
// 4 (14-10-2026, #1609): radio de búsqueda con piso de 15 m, los fixes sin pareja de la frontera entre
// fragmentos se emiten (antes se perdían), las juntas rectas entre fragmentos/ventanas pasan a crudo y
// un fix preciso en marcha no se suaviza fuera de su error. Otra salida → se recalculan.
// 5 (14-10-2026, #1459): un fix impreciso de la cola (sin confiable después) dentro de su error y a
// ≤ 15 s del último confiable se ancla a él (anclarImprecisos): cambia la entrada del ajustador en las
// trazas que terminan en un fix de red → se recalculan.
// 6 (14-10-2026, #17498): un fragmento confiable cuya vía no pasa por los fixes precisos sin pareja del
// tramo, o que entre dos puntos pegados mete un recorrido imposible para un bus, se parte y ese tramo
// lleva los fixes reales (piezasDeFragmento, lib/huella.ts). Otra salida → se recalculan.
export const VERSION_AJUSTE = 6;
/** Días hacia atrás en que el servidor CALCULA (= DIAS_RASTREO de lib/gps-cobertura-datos.ts, que la
 *  matriz coteja; aquí como literal porque este módulo no puede importar un lector de servidor). */
export const DIAS_CALCULO = 90;

/** ¿La fecha del servicio (YYYY-MM-DD, Lima) está dentro de los últimos `dias` días? Aritmética sobre la
 *  cadena ISO, con «hoy» en Lima (UTC-5). Sin fecha válida: no. */
export function fechaDentroDeVentana(fecha: string | null | undefined, ahoraMs: number, dias: number = DIAS_CALCULO): boolean {
  if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
  const hoy = new Date(ahoraMs - 5 * 3600 * 1000).toISOString().slice(0, 10);
  const limite = new Date(Date.parse(`${hoy}T12:00:00Z`) - dias * 86_400_000).toISOString().slice(0, 10);
  return fecha >= limite && fecha <= hoy;
}

/** Peso máximo del jsonb guardado (la migración lo vuelve a exigir con un CHECK). */
export const MAX_BYTES_TRAZA = 900_000;
/** Vértices máximos de una traza guardada. */
export const MAX_VERTICES_TRAZA = 80_000;
/** Puntos limpios máximos que el servidor acepta ajustar en un servicio. */
export const MAX_FILAS_AJUSTE = 30_000;
/** Llamadas máximas a Map Matching por servicio; al pasarlo se aborta y NO se guarda. */
export const MAX_LLAMADAS_SERVICIO = 600;
/** Recálculos máximos de una traza que quedó desactualizada (llegaron posiciones tardías). */
export const MAX_RECALCULOS = 2;
/** Espera mínima entre dos cálculos del mismo servicio. */
export const ESPERA_RECALCULO_MS = 30 * 60 * 1000;
/** Puntos por ventana nueva del ajustador (MAX 100 − SOLAPE 1): `ceil(n/99)+1` es el piso de llamadas. */
export const PUNTOS_POR_VENTANA = 99;

/** Llamadas estimadas (piso) para ajustar `n` puntos limpios: las ventanas + la cola. */
export function llamadasEstimadas(n: number): number {
  return n < 2 ? 0 : Math.ceil(n / PUNTOS_POR_VENTANA) + 1;
}

export type TrazaGuardada = { v: number; p: string; c: number[]; s: boolean; n: number };

export type TrazaDecodificada = {
  coords: [number, number][];
  esCrudo: boolean[];
  colaSnapped: boolean;
  crudoRanges: Array<[number, number]>;
  colaClean: number;
};

// ── Polyline de precisión 6 ───────────────────────────────────────────────────────────────
const F6 = 1e6;
function codificarValor(v: number, out: string[]) {
  let x = v < 0 ? ~(v << 1) : v << 1;
  while (x >= 0x20) { out.push(String.fromCharCode((0x20 | (x & 0x1f)) + 63)); x >>= 5; }
  out.push(String.fromCharCode(x + 63));
}
/** Coords `[lng, lat]` → polyline6 (orden lat,lng). */
export function codificarPolyline6(coords: [number, number][]): string {
  const out: string[] = [];
  let pLat = 0, pLng = 0;
  for (const [lng, lat] of coords) {
    const iLat = Math.round(lat * F6), iLng = Math.round(lng * F6);
    codificarValor(iLat - pLat, out);
    codificarValor(iLng - pLng, out);
    pLat = iLat; pLng = iLng;
  }
  return out.join("");
}
/** polyline6 → coords `[lng, lat]`; null si la cadena no es una polyline válida. */
export function decodificarPolyline6(p: string): [number, number][] | null {
  const out: [number, number][] = [];
  let i = 0, lat = 0, lng = 0;
  const leer = (): number | null => {
    let res = 0, shift = 0, b: number;
    do {
      if (i >= p.length) return null;
      b = p.charCodeAt(i++) - 63;
      if (b < 0 || b > 63 || shift > 30) return null;
      res |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return res & 1 ? ~(res >> 1) : res >> 1;
  };
  while (i < p.length) {
    const dLat = leer(); if (dLat == null) return null;
    const dLng = leer(); if (dLng == null) return null;
    lat += dLat; lng += dLng;
    out.push([lng / F6, lat / F6]);
  }
  return out;
}

// ── RLE de esCrudo ────────────────────────────────────────────────────────────────────────
function rle(esCrudo: boolean[]): number[] {
  const c: number[] = [];
  let actual = false, cuenta = 0;
  for (const e of esCrudo) {
    if (e === actual) cuenta++;
    else { c.push(cuenta); actual = e; cuenta = 1; }
  }
  c.push(cuenta);
  return c;
}
function desRle(c: unknown, n: number): boolean[] | null {
  if (!Array.isArray(c)) return null;
  const out: boolean[] = [];
  let actual = false;
  for (const x of c) {
    if (!Number.isInteger(x) || (x as number) < 0) return null;
    if (out.length + (x as number) > n) return null;
    for (let k = 0; k < (x as number); k++) out.push(actual);
    actual = !actual;
  }
  return out.length === n ? out : null;
}

const coordOk = (c: unknown): c is [number, number] =>
  Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])
  && Math.abs(c[0] as number) <= 180 && Math.abs(c[1] as number) <= 90;

/**
 * La salida del ajustador → lo que se guarda. Exige `esCrudo` alineado 1:1 con `coords`, al menos 2
 * vértices y coordenadas válidas (`incoherente`); y respeta los topes de vértices y de bytes
 * (`demasiado_grande`). `bytes` = largo del JSON (todo ASCII: polyline y números).
 */
export function codificarTraza(e: { coords: [number, number][]; esCrudo: boolean[]; colaSnapped: boolean }):
  { ok: true; traza: TrazaGuardada; bytes: number } | { ok: false; motivo: "incoherente" | "demasiado_grande" } {
  const { coords, esCrudo } = e;
  if (!Array.isArray(coords) || !Array.isArray(esCrudo) || coords.length < 2 || esCrudo.length !== coords.length
    || !coords.every(coordOk) || !esCrudo.every((x) => typeof x === "boolean") || typeof e.colaSnapped !== "boolean") {
    return { ok: false, motivo: "incoherente" };
  }
  if (coords.length > MAX_VERTICES_TRAZA) return { ok: false, motivo: "demasiado_grande" };
  const traza: TrazaGuardada = { v: VERSION_AJUSTE, p: codificarPolyline6(coords), c: rle(esCrudo), s: e.colaSnapped, n: coords.length };
  const bytes = JSON.stringify(traza).length;
  if (bytes > MAX_BYTES_TRAZA) return { ok: false, motivo: "demasiado_grande" };
  return { ok: true, traza, bytes };
}

/**
 * Lo guardado → lo que el modal usa en lugar de `ajustador.leer*()`. null si no es una traza de esta
 * versión o no es coherente (polyline rota, RLE que no suma n, menos de 2 vértices): una traza que no
 * se puede leer no se dibuja a medias.
 */
export function decodificarTraza(t: unknown): TrazaDecodificada | null {
  if (!t || typeof t !== "object") return null;
  const x = t as Partial<TrazaGuardada>;
  if (x.v !== VERSION_AJUSTE || typeof x.p !== "string" || typeof x.s !== "boolean"
    || !Number.isInteger(x.n) || (x.n as number) < 2 || (x.n as number) > MAX_VERTICES_TRAZA) return null;
  const coords = decodificarPolyline6(x.p);
  if (!coords || coords.length !== x.n || !coords.every(coordOk)) return null;
  const esCrudo = desRle(x.c, x.n as number);
  if (!esCrudo) return null;
  const { crudoRanges, colaClean } = rangosDeCrudo(esCrudo, coords.length);
  return { coords, esCrudo, colaSnapped: x.s, crudoRanges, colaClean };
}

// ── La entrada que se firma ───────────────────────────────────────────────────────────────
/** Los campos de una fila que lee `huellaDeFilas` (lib/huella.ts), en este orden. */
export const CAMPOS_FIRMA = ["created_at", "timestamp", "lat", "lng", "precision_m", "velocidad", "rumbo"] as const;
const canonCampo = (v: unknown) => (v === undefined ? "" : JSON.stringify(v));
/**
 * La forma CANÓNICA de las filas que entran al ajuste: por fila, los campos de `CAMPOS_FIRMA`
 * (JSON de cada valor —así null, "" y 0 no se confunden, y un `|` dentro de un texto no corre los
 * campos—; vacío si falta), unidos por `|`; filas en el orden recibido, unidas por salto de línea.
 * Un campo que `huellaDeFilas` no lee (fix_ts, reserva_id…) NO entra: cambiarlo no cambia la traza.
 * La firma (sha256 de VERSION_AJUSTE + esto) la calcula el lector, con la librería del servidor.
 */
export function canonEntradaAjuste(filas: any[]): string {
  return (filas || []).map((f) => CAMPOS_FIRMA.map((k) => canonCampo(f == null ? undefined : f[k])).join("|")).join("\n");
}

// ── La lectura (qué hace el modal) ────────────────────────────────────────────────────────
export type EstadoAjustada =
  | "guardada" | "desactualizada" | "falta" | "no_aplica" | "apagada" | "sin_migracion"
  | "sin_token" | "fuera_de_ventana" | "no_se_pudo_leer";

export type RespuestaAjustada = {
  estado: EstadoAjustada;
  traza?: TrazaGuardada;
  /** ¿Puede el modal pedir el cálculo al servidor? Solo en `falta` y en `desactualizada` con recálculo. */
  puedeCalcular: boolean;
  calculadoEn?: string;
  nFilasGuardadas?: number;
  nFilasAhora?: number;
  /**
   * true: el cliente ya tiene ESTA traza (mandó su `calculadoEn` y coincide con la fila), así que no
   * se reenvía (`traza` ausente aunque el estado sea guardada/desactualizada). El modal conserva la
   * que ya dibujó. Ahorra reenviar hasta 900 KB en cada sondeo de 15 s.
   */
  sinCambios?: boolean;
  detalle: string;
};

/**
 * Qué DIBUJA el modal en cada caso (la pantalla enruta por esto, no por el texto).
 *   guardada            → la traza del servidor, sin llamar a Map Matching.
 *   sin_ajuste          → no hay traza guardada utilizable (falta, se está calculando, presupuesto,
 *                         error…): el modal ajusta EN EL NAVEGADOR como siempre y ofrece «Reintentar».
 *                         Antes dibujaba la huella CRUDA, que cruza manzanas (#1608): nunca más.
 *   en_vivo_como_antes  → el guardado no aplica; el modal ajusta en el navegador.
 */
export type CaeTraza = "guardada" | "sin_ajuste" | "en_vivo_como_antes";
export type TonoTraza = "gris" | "ambar";

export type ConfigTraza =
  | { estado: "ok"; guardar: boolean }
  | { estado: "sin_migracion" }
  | { estado: "no_se_pudo_leer" };

/** Lo que se sabe ANTES de leer la traza guardada. */
export type CtxPrevio = {
  /** ¿La reserva está `finalizada`? (solo esos se guardan) */
  finalizada: boolean;
  config: ConfigTraza;
  /** ¿La huella de AHORA se leyó entera? (`completa` del lector). Sin eso, la firma no dice nada. */
  lecturaCompleta: boolean;
};

export type GuardadaLeida = {
  version: number;
  firma: string;
  nFilas: number;
  recalculos: number;
  calculadoEn: string;
  /** La traza guardada; puede omitirse cuando `clienteLaTiene` (no hace falta leerla). */
  traza?: unknown;
};

export type CtxLectura = CtxPrevio & {
  /** La fila guardada: null si no hay; "error" si la lectura falló (nunca es «no hay»). */
  guardada: GuardadaLeida | null | "error";
  firmaAhora: string;
  nFilasAhora: number;
  /** ¿La fecha del servicio está dentro de la ventana en la que el servidor calcula (DIAS_RASTREO)? */
  dentroDeVentana: boolean;
  /** ¿Hay token de Mapbox de servidor? */
  tokenServidor: boolean;
  ahoraMs: number;
  /**
   * El cliente ya tiene la traza de esta misma fila (su `calculadoEn` coincide y la versión es la de
   * hoy): ya la decodificó una vez, así que no se vuelve a leer ni a reenviar. Lo decide el lector.
   */
  clienteLaTiene?: boolean;
};

/** Texto, qué dibuja y tono, declarado pegado a cada estado de la lectura. */
export const MOTIVO_LECTURA: Record<EstadoAjustada, { texto: string; cae: CaeTraza; tono: TonoTraza }> = {
  guardada:         { texto: "ajuste a la vía guardado", cae: "guardada", tono: "gris" },
  desactualizada:   { texto: "llegaron posiciones después de calcular el ajuste", cae: "guardada", tono: "ambar" },
  falta:            { texto: "todavía no se ha ajustado este servicio", cae: "sin_ajuste", tono: "gris" },
  no_aplica:        { texto: "el ajuste solo se guarda en servicios finalizados con posiciones", cae: "en_vivo_como_antes", tono: "gris" },
  apagada:          { texto: "el guardado del ajuste está apagado (gps_traza_config.guardar)", cae: "en_vivo_como_antes", tono: "gris" },
  sin_migracion:    { texto: "falta correr supabase/gps-traza-ajustada-01.sql", cae: "en_vivo_como_antes", tono: "ambar" },
  sin_token:        { texto: "falta MAPBOX_TOKEN_SERVIDOR en el servidor", cae: "en_vivo_como_antes", tono: "ambar" },
  fuera_de_ventana: { texto: "el servicio es más antiguo que la ventana en que se calcula", cae: "en_vivo_como_antes", tono: "gris" },
  no_se_pudo_leer:  { texto: "no se pudo leer el ajuste guardado o las posiciones; vuelve a intentarlo", cae: "sin_ajuste", tono: "ambar" },
};

const respuesta = (estado: EstadoAjustada, extra: Partial<RespuestaAjustada> = {}): RespuestaAjustada =>
  ({ estado, puedeCalcular: false, detalle: MOTIVO_LECTURA[estado].texto, ...extra });

/**
 * Lo que se decide SIN leer la fila guardada. `null` = hay que leerla. Con `apagada` (o sin la
 * migración, o sin poder leer la configuración o la huella) la fila NO se lee ni se escribe.
 * Orden, de la evidencia al juicio: el servicio → la configuración → la huella de ahora.
 */
export function previoALectura(ctx: CtxPrevio): RespuestaAjustada | null {
  if (!ctx.finalizada) return respuesta("no_aplica");
  if (ctx.config.estado === "sin_migracion") return respuesta("sin_migracion");
  if (ctx.config.estado === "no_se_pudo_leer") return respuesta("no_se_pudo_leer");
  if (!ctx.config.guardar) return respuesta("apagada");
  if (!ctx.lecturaCompleta) return respuesta("no_se_pudo_leer", { detalle: "no se pudieron leer todas las posiciones del servicio; vuelve a intentarlo" });
  return null;
}

/**
 * Qué estado tiene la traza ajustada de un servicio y si el modal puede pedir el cálculo.
 * Invariantes (matriz §5): nunca `guardada` con firma distinta; `no_se_pudo_leer` nunca puede
 * calcular; `apagada` nunca trae traza. La ventana y el token SOLO deciden si se puede CALCULAR: una
 * traza guardada se sirve aunque el servicio ya sea más antiguo que la ventana (es «para siempre»).
 */
export function decidirLectura(ctx: CtxLectura): RespuestaAjustada {
  const previo = previoALectura(ctx);
  if (previo) return previo;
  const g = ctx.guardada;
  if (g === "error") return respuesta("no_se_pudo_leer");

  const dec = g ? (ctx.clienteLaTiene && g.version === VERSION_AJUSTE ? true : decodificarTraza(g.traza)) : null;
  if (!g || !dec) {
    // No hay traza (o la guardada no se puede leer: otra versión, o corrupta → se recalcula).
    const corrupta = !!g && !dec;
    if (ctx.nFilasAhora < 2) return respuesta("no_aplica", { nFilasAhora: ctx.nFilasAhora, detalle: "el servicio no tiene posiciones suficientes para ajustar" });
    if (!ctx.dentroDeVentana) return respuesta("fuera_de_ventana", { nFilasAhora: ctx.nFilasAhora });
    if (!ctx.tokenServidor) return respuesta("sin_token", { nFilasAhora: ctx.nFilasAhora });
    return respuesta("falta", {
      puedeCalcular: true, nFilasAhora: ctx.nFilasAhora,
      ...(corrupta ? { detalle: "el ajuste guardado no se pudo leer (otra versión o dañado); se recalcula" } : {}),
    });
  }

  const yaLaTiene = !!ctx.clienteLaTiene && g.version === VERSION_AJUSTE;
  const base = {
    ...(yaLaTiene ? { sinCambios: true } : { traza: g.traza as TrazaGuardada }),
    calculadoEn: g.calculadoEn, nFilasGuardadas: g.nFilas, nFilasAhora: ctx.nFilasAhora,
  };
  if (g.version === VERSION_AJUSTE && g.firma === ctx.firmaAhora) return respuesta("guardada", base);

  const calc = Date.parse(g.calculadoEn);
  const espero = Number.isFinite(calc) && ctx.ahoraMs - calc >= ESPERA_RECALCULO_MS;
  const puedeCalcular = ctx.dentroDeVentana && ctx.tokenServidor && ctx.nFilasAhora >= 2
    && g.recalculos < MAX_RECALCULOS && espero;
  let detalle: string;
  if (puedeCalcular) detalle = "llegaron posiciones después de calcular el ajuste; se recalcula";
  else if (ctx.nFilasAhora < 2) detalle = "las posiciones del servicio ya no están; se muestra el ajuste guardado";
  else if (g.recalculos >= MAX_RECALCULOS) detalle = `llegaron posiciones después de calcular el ajuste y ya se recalculó ${MAX_RECALCULOS} veces; se muestra el guardado`;
  else if (!espero) detalle = "llegaron posiciones después de calcular el ajuste; se recalcula como mucho cada 30 min";
  else if (!ctx.dentroDeVentana) detalle = "llegaron posiciones después de calcular el ajuste, pero el servicio ya es más antiguo que la ventana en que se calcula";
  else detalle = "llegaron posiciones después de calcular el ajuste, pero falta MAPBOX_TOKEN_SERVIDOR para recalcularlo";
  return respuesta("desactualizada", { ...base, puedeCalcular, detalle });
}

// ── El cálculo (lo que contesta la ruta que ajusta) ───────────────────────────────────────
export type CodigoCalculo =
  | "calculada" | "calculada_sin_guardar" | "ya_guardada" | "en_curso" | "presupuesto_agotado"
  | "limite_usuario" | "excede_servicio" | "no_finalizada" | "sin_filas" | "apagada"
  | "sin_migracion" | "sin_token" | "token_rechazado" | "fuera_de_ventana" | "error";

/**
 * Texto, qué dibuja el modal (`cae`) y tono, declarados PEGADOS a cada código. `cae: "guardada"`
 * significa «dibuja la traza que devolvió el servidor» (aunque no se haya podido guardar).
 */
export const MOTIVO_CALCULO: Record<CodigoCalculo, { texto: string; cae: CaeTraza; tono: TonoTraza }> = {
  calculada:             { texto: "ajustado ahora y guardado", cae: "guardada", tono: "gris" },
  // Con consultas sin contestar, la traza del servidor tiene ventanas en crudo: no se dibuja esa, se
  // ajusta en el navegador (que reintenta) y se vuelve a pedir al servidor en la próxima apertura.
  calculada_sin_guardar: { texto: "Mapbox no contestó a todas las consultas (o la traza no se pudo guardar); se vuelve a intentar al abrirlo otra vez", cae: "sin_ajuste", tono: "ambar" },
  ya_guardada:           { texto: "otra apertura ya lo había ajustado y guardado", cae: "guardada", tono: "gris" },
  en_curso:              { texto: "otra apertura lo está ajustando en este momento", cae: "sin_ajuste", tono: "gris" },
  presupuesto_agotado:   { texto: "se agotó el presupuesto de consultas a Mapbox de esta hora o de este mes (gps_traza_config)", cae: "sin_ajuste", tono: "ambar" },
  limite_usuario:        { texto: "pediste demasiados ajustes en la última hora; vuelve a intentarlo más tarde", cae: "sin_ajuste", tono: "ambar" },
  excede_servicio:       { texto: "el servicio tiene demasiadas posiciones para ajustarlo dentro del tope de consultas", cae: "sin_ajuste", tono: "ambar" },
  no_finalizada:         { texto: "el servicio no está finalizado", cae: "en_vivo_como_antes", tono: "gris" },
  sin_filas:             { texto: "el servicio no tiene posiciones suficientes para ajustar", cae: "sin_ajuste", tono: "gris" },
  apagada:               { texto: "el guardado del ajuste está apagado (gps_traza_config.guardar)", cae: "en_vivo_como_antes", tono: "gris" },
  sin_migracion:         { texto: "falta correr supabase/gps-traza-ajustada-01.sql", cae: "en_vivo_como_antes", tono: "ambar" },
  sin_token:             { texto: "falta MAPBOX_TOKEN_SERVIDOR en el servidor", cae: "en_vivo_como_antes", tono: "ambar" },
  token_rechazado:       { texto: "Mapbox rechazó MAPBOX_TOKEN_SERVIDOR (token inválido o con restricción por URL: el del servidor no puede tenerla); se ajusta en el navegador y no se guarda", cae: "en_vivo_como_antes", tono: "ambar" },
  fuera_de_ventana:      { texto: "el servicio es más antiguo que la ventana en que se calcula", cae: "en_vivo_como_antes", tono: "gris" },
  error:                 { texto: "no se pudo ajustar este servicio; vuelve a intentarlo", cae: "sin_ajuste", tono: "ambar" },
};

/**
 * De la salida del ajuste (lib/gps-traza-ajustada-calculo.ts) a la decisión de GUARDAR, en orden:
 *   Mapbox rechazó el token (401/403) → `token_rechazado`, sin traza (caso #1608: guardaba el crudo
 *     para siempre y el modal dibujaba líneas sobre casas con «tramos estimados» y el GPS al 100 %);
 *   abortado (pasó el tope de consultas) → `excede_servicio`, sin traza: una traza a medias es peor
 *     que ninguna;
 *   menos de 2 vértices → `sin_filas`;
 *   el códec la rechaza → `excede_servicio` si es demasiado grande, `error` si es incoherente;
 *   hubo fallos pasajeros (429/5xx/red) → `calculada_sin_guardar`: se DEVUELVE para dibujarla, pero
 *     no se guarda — una ventana que quedó en crudo porque Mapbox no contestó no puede quedar así
 *     para siempre;
 *   si no → `calculada`, se guarda.
 * Invariante (matriz §5): con transitorios o abortado, `guardar` es siempre false.
 * `ya_guardada`, `en_curso`, los presupuestos y los prerrequisitos los decide el lector.
 */
export function resultadoDelCalculo(a: {
  coords: [number, number][]; esCrudo: boolean[]; colaSnapped: boolean; transitorios: number; abortado: boolean;
  /** Consultas que Mapbox rechazó por la credencial (401/403). Ausente = 0 (llamadores viejos). */
  rechazos?: number;
}): { codigo: CodigoCalculo; guardar: boolean; traza?: TrazaGuardada; bytes?: number } {
  // PRIMERO: con el token rechazado ninguna ventana pegó y la «traza» es el crudo suavizado. No se
  // guarda NI se devuelve para dibujar (cruzaría manzanas): el modal ajusta en el navegador.
  if ((a.rechazos ?? 0) > 0) return { codigo: "token_rechazado", guardar: false };
  if (a.abortado) return { codigo: "excede_servicio", guardar: false };
  if (!Array.isArray(a.coords) || a.coords.length < 2) return { codigo: "sin_filas", guardar: false };
  const c = codificarTraza({ coords: a.coords, esCrudo: a.esCrudo, colaSnapped: a.colaSnapped });
  if (!c.ok) return { codigo: c.motivo === "demasiado_grande" ? "excede_servicio" : "error", guardar: false };
  if (a.transitorios > 0) return { codigo: "calculada_sin_guardar", guardar: false, traza: c.traza, bytes: c.bytes };
  return { codigo: "calculada", guardar: true, traza: c.traza, bytes: c.bytes };
}

/** "DD/MM/AAAA HH:MM" en hora de Lima (UTC-5, sin horario de verano). null si no es una fecha. */
export function fechaHoraLima(iso: string | null | undefined): string | null {
  const ms = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms - 5 * 3600 * 1000);
  const dd = (x: number) => String(x).padStart(2, "0");
  return `${dd(d.getUTCDate())}/${dd(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${dd(d.getUTCHours())}:${dd(d.getUTCMinutes())}`;
}

/**
 * La frase del chip del modal, compuesta aquí y no en el TSX. Recibe la lectura (`/api/cliente/gps`)
 * o el resultado del cálculo (la ruta que ajusta); si vienen los dos, manda el cálculo (es lo más
 * reciente). Formas: «Ajuste guardado · calculado el …», «Ajustado ahora y guardado»,
 * «Sin ajuste: …», «Ajustando en vivo (no se guarda): …».
 */
export function textoEstadoTraza(x: {
  lectura?: RespuestaAjustada | null;
  calculo?: { codigo: CodigoCalculo; detalle?: string | null; calculadoEn?: string | null } | null;
}): { texto: string; tono: TonoTraza; cae: CaeTraza } {
  if (x.calculo) {
    const m = MOTIVO_CALCULO[x.calculo.codigo] ?? MOTIVO_CALCULO.error;
    const det = x.calculo.detalle || m.texto;
    if (x.calculo.codigo === "calculada") return { texto: "Ajustado ahora y guardado", tono: m.tono, cae: m.cae };
    if (x.calculo.codigo === "ya_guardada") {
      const f = fechaHoraLima(x.calculo.calculadoEn);
      return { texto: f ? `Ajuste guardado · calculado el ${f}` : "Ajuste guardado", tono: m.tono, cae: m.cae };
    }
    if (x.calculo.codigo === "calculada_sin_guardar") return { texto: `Ajustando en el navegador (sin guardar): ${det}`, tono: m.tono, cae: m.cae };
    return { texto: m.cae === "sin_ajuste" ? `Ajustando en el navegador (sin guardar): ${det}` : `Ajustando en vivo (no se guarda): ${det}`, tono: m.tono, cae: m.cae };
  }
  const l = x.lectura;
  if (!l) return { texto: "Ajustando en vivo (no se guarda)", tono: "gris", cae: "en_vivo_como_antes" };
  const m = MOTIVO_LECTURA[l.estado] ?? MOTIVO_LECTURA.no_se_pudo_leer;
  const f = fechaHoraLima(l.calculadoEn);
  if (l.estado === "guardada") return { texto: f ? `Ajuste guardado · calculado el ${f}` : "Ajuste guardado", tono: m.tono, cae: m.cae };
  if (l.estado === "desactualizada") {
    const nuevas = (l.nFilasAhora ?? 0) - (l.nFilasGuardadas ?? 0);
    const que = nuevas > 0 ? `llegaron ${nuevas} posición(es) después` : "las posiciones cambiaron después";
    const cola = l.puedeCalcular ? " · recalculando" : "";
    return { texto: `Ajuste guardado${f ? ` del ${f}` : ""} · ${que}${cola}`, tono: m.tono, cae: m.cae };
  }
  if (l.estado === "falta") return { texto: l.puedeCalcular ? "Ajustando a la vía (se guarda)…" : `Ajustando en el navegador (sin guardar): ${l.detalle}`, tono: m.tono, cae: m.cae };
  return { texto: m.cae === "sin_ajuste" ? `Ajustando en el navegador (sin guardar): ${l.detalle}` : `Ajustando en vivo (no se guarda): ${l.detalle}`, tono: m.tono, cae: m.cae };
}
