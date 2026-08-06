// Ficha Técnica de Ruta — lógica pura (sin React, sin Supabase) para el documento
// operativo que se emite desde /cotizaciones: puntos de entrada (ida) y de retorno,
// métricas por tramo, mapa estático y enlace de Google Maps.
//
// Vive aparte de la página porque es lo único de la ficha que se puede razonar y
// probar sin abrir el navegador: el armado de puntos, los acumulados y las URLs.

export type ParadaFicha = { tipo?: string; nombre?: string; direccion?: string; lat?: string | number | null; lng?: string | number | null; hora?: string | null };

export type PuntoFicha = {
  codigo: string;                                   // I-01, R-03 — así el cliente puede referenciarlos
  rol: "embarque" | "intermedio" | "llegada";
  nombre: string;
  direccion: string;
  lat: number | null;
  lng: number | null;
  hora: string;                                     // hora programada tal como se cargó ("" si no hay)
};

export type TramoMetrica = { distancia_km: number; duracion_min: number };
export type MetricaSentido = { poly: string; tramos: TramoMetrica[]; total_km: number; total_min: number };
export type FichaRutaCache = { firma: string; calculado_at: string; ida: MetricaSentido | null; retorno: MetricaSentido | null };

export type FilaFicha = PuntoFicha & {
  km_tramo: number | null;                          // distancia desde el punto anterior
  km_acum: number | null;
  min_acum: number | null;
  hora_mostrada: string;                            // programada, o estimada a partir de la primera hora
  hora_estimada: boolean;                           // true → se pinta en gris cursiva, no es un compromiso
};

const ROL_LABEL: Record<PuntoFicha["rol"], string> = { embarque: "Embarque", intermedio: "Intermedio", llegada: "Llegada" };
export const rolLabel = (r: PuntoFicha["rol"]) => ROL_LABEL[r];

const num = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Escapa texto que entra al HTML del documento (nombres y direcciones son datos de usuario). */
export const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Convierte las paradas guardadas en la cotización a puntos numerados.
 * El primero siempre es embarque y el último llegada, sin importar cómo venga `tipo`:
 * en las cotizaciones viejas ese campo quedó a veces en "intermedia" para todos.
 */
export function construirPuntos(paradas: ParadaFicha[] | null | undefined, prefijo: "I" | "R"): PuntoFicha[] {
  const ps = (paradas || []).filter(p => (p?.nombre || p?.direccion || "").trim() !== "" || num(p?.lat) !== null);
  return ps.map((p, i) => ({
    codigo: `${prefijo}-${String(i + 1).padStart(2, "0")}`,
    rol: i === 0 ? "embarque" : i === ps.length - 1 ? "llegada" : "intermedio",
    nombre: (p.nombre || p.direccion || `Punto ${i + 1}`).trim(),
    direccion: (p.direccion || "").trim(),
    lat: num(p.lat),
    lng: num(p.lng),
    hora: (p.hora || "").trim(),
  }));
}

/** Puntos mínimos cuando la cotización no tiene paraderos cargados: nunca emitir una ficha vacía. */
export function puntosDesdeTexto(desde: string, hasta: string, prefijo: "I" | "R", horaIni = "", horaFin = ""): PuntoFicha[] {
  const pares = [{ n: desde, h: horaIni }, { n: hasta, h: horaFin }].filter(x => (x.n || "").trim() !== "");
  return pares.map((x, i) => ({
    codigo: `${prefijo}-${String(i + 1).padStart(2, "0")}`,
    rol: i === 0 ? "embarque" : "llegada",
    nombre: x.n.trim(),
    direccion: "",
    lat: null,
    lng: null,
    hora: (x.h || "").trim(),
  })) as PuntoFicha[];
}

export const puntosConCoords = (ps: PuntoFicha[]) => ps.filter(p => p.lat !== null && p.lng !== null);

/**
 * Firma de la geometría: si cambia, las métricas guardadas dejan de ser válidas y hay
 * que volver a consultar. Solo entran coordenadas — mover un nombre no reabre la ruta.
 */
export function firmaRutaFicha(ida: PuntoFicha[], retorno: PuntoFicha[]): string {
  const f = (ps: PuntoFicha[]) => puntosConCoords(ps).map(p => `${p.lat!.toFixed(5)},${p.lng!.toFixed(5)}`).join(";");
  return `${f(ida)}|${f(retorno)}`;
}

// ── Polilínea (formato Google, precisión 5) ─────────────────────────────────
// /api/ruta devuelve la geometría como [lng,lat][]; Mapbox Static la quiere codificada.

function encNum(v: number): string {
  let sgn = v < 0 ? ~(v << 1) : v << 1;
  let out = "";
  while (sgn >= 0x20) { out += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63); sgn >>= 5; }
  return out + String.fromCharCode(sgn + 63);
}

export function encodePolyline(coords: [number, number][]): string {
  let lastLat = 0, lastLng = 0, out = "";
  for (const [lng, lat] of coords) {
    const la = Math.round(lat * 1e5), ln = Math.round(lng * 1e5);
    out += encNum(la - lastLat) + encNum(ln - lastLng);
    lastLat = la; lastLng = ln;
  }
  return out;
}

/** Reduce la geometría conservando extremos: la URL del mapa tiene tope de largo. */
export function diezmar<T>(arr: T[], max: number): T[] {
  if (arr.length <= max || max < 2) return arr;
  const paso = (arr.length - 1) / (max - 1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * paso)]);
  return out;
}

// ── Mapa estático (Mapbox) ──────────────────────────────────────────────────

/**
 * Imagen del recorrido: trazo por carretera + pines numerados. Devuelve "" si falta el
 * token o si no hay nada que dibujar, y el documento simplemente omite el bloque.
 * Con más de MAX_PINES puntos solo se marcan los extremos, si no el mapa se vuelve ilegible.
 */
export function urlMapaEstatico(puntos: PuntoFicha[], poly: string, colorHex: string, token: string, ancho = 880, alto = 360): string {
  if (!token) return "";
  const con = puntosConCoords(puntos);
  if (!con.length && !poly) return "";
  const color = colorHex.replace("#", "");
  const MAX_PINES = 20;
  const marcar = con.length <= MAX_PINES ? con : [con[0], con[con.length - 1]];
  const overlays: string[] = [];
  if (poly) overlays.push(`path-4+${color}-0.85(${encodeURIComponent(poly)})`);
  marcar.forEach((p, i) => {
    const etiqueta = con.length <= MAX_PINES ? String(i + 1) : i === 0 ? "a" : "b";
    overlays.push(`pin-s-${etiqueta}+${color}(${p.lng!.toFixed(5)},${p.lat!.toFixed(5)})`);
  });
  if (!overlays.length) return "";
  return `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${overlays.join(",")}/auto/${ancho}x${alto}?padding=48&logo=false&attribution=false&access_token=${token}`;
}

/** Enlace de Google Maps con el recorrido completo — es lo que codifica el QR de la ficha. */
export function urlGoogleMapsRuta(puntos: PuntoFicha[]): string {
  const con = diezmar(puntosConCoords(puntos), 10);
  if (con.length < 2) return "";
  const coords = con.map(p => `${p.lat!.toFixed(6)},${p.lng!.toFixed(6)}`);
  return `https://www.google.com/maps/dir/${coords.join("/")}`;
}

// ── Acumulados por tramo ────────────────────────────────────────────────────

const aMin = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm || "");
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h >= 0 && h < 24 && mi >= 0 && mi < 60 ? h * 60 + mi : null;
};
const aHora = (min: number): string => {
  const t = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/**
 * Arma las filas de la tabla: distancia por tramo, acumulados y hora.
 * La hora programada manda; donde no la haya se estima sumando los minutos del
 * recorrido a la primera hora conocida, y se marca como estimada para no prometerla.
 */
export function filasConAcumulados(puntos: PuntoFicha[], metrica: MetricaSentido | null): FilaFicha[] {
  const tramos = metrica?.tramos || [];
  // Los tramos vienen de los puntos CON coordenadas; los que no tienen no cortan la ruta.
  const idxCon = puntos.map((p, i) => (p.lat !== null && p.lng !== null ? i : -1)).filter(i => i >= 0);
  const kmPorPunto = new Map<number, number>(), minPorPunto = new Map<number, number>();
  idxCon.forEach((idx, k) => { if (k > 0 && tramos[k - 1]) { kmPorPunto.set(idx, tramos[k - 1].distancia_km); minPorPunto.set(idx, tramos[k - 1].duracion_min); } });

  let km = 0, min = 0;
  const acumHasta: number[] = [];
  puntos.forEach((_, i) => { min += minPorPunto.get(i) || 0; acumHasta[i] = min; });
  min = 0;

  // Cada hora estimada se ancla al punto CON hora programada más cercano hacia atrás (y si
  // no hay ninguno, al primero hacia adelante). Anclar siempre a la primera hora del tramo
  // hacía que un retraso cargado a mitad de ruta dejara estimaciones ya desfasadas.
  const idxConHora = puntos.map((p, i) => (aMin(p.hora) !== null ? i : -1)).filter(i => i >= 0);
  const anclaDe = (i: number): number | null => {
    if (!idxConHora.length) return null;
    const previos = idxConHora.filter(k => k < i);
    return previos.length ? previos[previos.length - 1] : idxConHora[0];
  };

  return puntos.map((p, i) => {
    const kmT = kmPorPunto.get(i) ?? null;
    km += kmT || 0;
    min += minPorPunto.get(i) || 0;
    const hayMetrica = tramos.length > 0;
    const propia = aMin(p.hora);
    let horaMostrada = p.hora, estimada = false;
    if (propia === null && hayMetrica) {
      const ancla = anclaDe(i);
      const baseMin = ancla === null ? null : aMin(puntos[ancla].hora);
      if (ancla !== null && baseMin !== null) {
        horaMostrada = aHora(baseMin + (acumHasta[i] - acumHasta[ancla]));
        estimada = true;
      }
    }
    return {
      ...p,
      km_tramo: kmT,
      km_acum: hayMetrica ? Math.round(km * 10) / 10 : null,
      min_acum: hayMetrica ? min : null,
      hora_mostrada: horaMostrada || "",
      hora_estimada: estimada,
    };
  });
}

export const fmtDuracion = (min: number | null | undefined): string => {
  if (min === null || min === undefined || !Number.isFinite(min)) return "—";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} min` : `${m} min`;
};
export const fmtKm = (km: number | null | undefined): string =>
  km === null || km === undefined || !Number.isFinite(km) ? "—" : `${km.toLocaleString("es-PE", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
export const fmtCoord = (p: { lat: number | null; lng: number | null }): string =>
  p.lat === null || p.lng === null ? "—" : `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
