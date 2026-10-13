"use client";
// components/seguimiento/MapaRecorrido.tsx
// El mapa de «Ver recorrido» (/seguimiento/gps/[id]): EL MODAL GPS SIN LLAMADAS PAGADAS. Mapbox,
// como el resto de la operación; no consulta nada a Google ni a ningún tercero.
//
// Capas, de abajo arriba (lo mismo que dibuja ModalGps, con sus mismas piezas de lib/huella.ts):
//   1. tramos ESTIMADOS sobre la ruta prevista ya guardada (verde petróleo, COLOR_TRAMO_ESTIMADO);
//   2. la huella MEDIDA, un segmento por par de posiciones, coloreado por velocidad con la rampa del
//      modal (`expresionColorVelocidad`; el color del segmento es el promedio de sus dos vértices,
//      la regla de `huellaCrudaFeatures`);
//   3. los puntitos de telemetría (hora, velocidad, rumbo y precisión; SIN dirección escrita: sería
//      una geocodificación pagada);
//   4. los tramos «sin señal» de la celda RASTREO, marcados SOLO en sus dos extremos con un punto
//      gris. Un hueco NUNCA se dibuja como línea: una recta entre sus bordes es un recorrido que el
//      bus no hizo (el defecto que reportó el dueño);
//   5. los excesos, ENCIMA de todo y sin cambios (rojo con borde blanco y la pastilla con la
//      velocidad sostenida).
//
// El mapa NO decide nada: dibuja lo que trae `RecorridoServicio` (lib/flota/recorrido.ts). Los
// popups se arman con nodos y textContent, nunca con HTML concatenado. Coordenadas [lng, lat].

import { useEffect, useRef, useState } from "react";
import type { Map as MapboxMap, Marker as MapboxMarker, Popup as MapboxPopup, GeoJSONSource, LngLatBounds, MapMouseEvent } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { cargarMapbox, tokenMapbox } from "@/lib/mapbox-carga";
import { RAMPA_VELOCIDAD, COLOR_TRAMO_ESTIMADO, expresionColorVelocidad, rumboCardinal } from "@/lib/huella";
import { AVANCE_CAIDO_M } from "@/lib/gps-cobertura";
import { formatoDuracion } from "@/lib/servicio-tiempos";
import { TIPO_TRAMO } from "@/components/seguimiento/ModalDiagnosticoRastreo";
import type { RecorridoServicio, EpisodioMapa, Coord, TramoSinSenal } from "@/lib/flota/recorrido";

export type ParadaMapa = { id: number; nombre: string; lat: number | null; lng: number | null; estado: string };

export const COLOR_EXCESO = "#dc2626";
export const COLOR_DESCARTADO = "#f59e0b";
export const COLOR_SIN_SENAL = "#94a3b8";

/** Pedido de enfocar un tramo «sin señal»: su índice en `recorrido.sinSenal` y un contador para
 *  que pulsar dos veces el mismo vuelva a centrar. */
export type FocoSinSenal = { i: number; n: number };

const fc = (features: unknown[]) => ({ type: "FeatureCollection" as const, features: features as never[] });
const linea = (coords: Coord[], props: Record<string, unknown> = {}) =>
  ({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
const punto = (c: Coord, props: Record<string, unknown> = {}) =>
  ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: c } });
const coordOk = (c: unknown): c is Coord =>
  Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]);

export function horaLima(ts: number): string {
  return new Date(ts).toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hour12: false });
}
/** Con segundos, como el popup de los puntitos del modal GPS. */
const horaPunto = (ts: number) =>
  new Date(ts).toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "America/Lima" });
const metros = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

// ── Un tramo «sin señal» en palabras (popup del mapa y lista de la página: dicen lo mismo) ──────

/** Duración de un tramo: nunca «0 min» para un tramo que existe (misma regla que el diagnóstico). */
export function duracionTramo(durS: number): string {
  return Number.isFinite(durS) ? formatoDuracion(Math.max(1, Math.round(durS / 60))) : "—";
}

/** Si el bus se movía durante el tramo. Solo un hueco entre dos posiciones lo sabe: la cabeza y la
 *  cola no tienen posición a uno de sus lados, y ahí no se afirma nada. */
export function movimientoTramo(t: TramoSinSenal): string {
  if (t.tipo === "cabeza") return "No hay posición antes: no se sabe si se movía";
  if (t.tipo === "cola") return "No hay posición después: no se sabe si se movía";
  if (t.enMovimiento) return "En movimiento (cuenta como corte)";
  if (t.avanceM != null && t.avanceM < AVANCE_CAIDO_M) return "Con el bus detenido o casi";
  return "No cuenta como corte en movimiento";
}

/** Las líneas de un tramo «sin señal», en el orden en que se leen. */
export function lineasSinSenal(t: TramoSinSenal): { titulo: string; lineas: string[] } {
  const lineas = [
    `${horaLima(t.desdeTs)}–${horaLima(t.hastaTs)} · ${duracionTramo(t.durS)}`,
    ...(t.avanceM != null ? [`Avance entre las dos posiciones: ${metros(t.avanceM)}`] : []),
    movimientoTramo(t),
    t.estimado ? "Cubierto por un tramo estimado sobre la ruta prevista" : "Sin tramo estimado: solo se marcan sus extremos",
  ];
  return { titulo: `Sin señal · ${TIPO_TRAMO[t.tipo] ?? t.tipo}`, lineas };
}

// ── Popups (nodos, nunca HTML con datos) ─────────────────────────────────────────────────────

function caja(minW = 170): HTMLDivElement {
  const c = document.createElement("div");
  c.style.cssText = `font-family:inherit;font-size:12px;line-height:1.45;max-width:250px;min-width:${minW}px`;
  return c;
}
function parrafo(texto: string, css: string, title?: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.style.cssText = `margin:0;${css}`;
  p.textContent = texto;
  if (title) p.title = title;
  return p;
}

/** El contenido del popup de un episodio. */
function popupEpisodio(ep: EpisodioMapa, umbral: number): HTMLElement {
  const c = caja(0);
  c.append(parrafo(
    ep.cuenta ? `Exceso · ${Math.round(ep.velMediaSensor)} km/h sostenidos (umbral ${umbral})` : "Episodio descartado (no cuenta como exceso)",
    `margin-bottom:4px;font-weight:800;color:${ep.cuenta ? COLOR_EXCESO : "#b45309"}`,
  ));
  c.append(parrafo(`${horaLima(ep.inicioTs)}–${horaLima(ep.finTs)} · ${Math.round(ep.durS)} s · pico ${Math.round(ep.velMaxSensor)} km/h`, "color:#334155"));
  const ctx = ep.contexto;
  if (ctx && ctx.texto) c.append(parrafo(ctx.texto, "margin-top:4px;color:#1e40af;font-weight:700;font-size:11px", ctx.motivo));
  c.append(parrafo(ep.detalle, "margin-top:4px;color:#64748b;font-size:11px"));
  return c;
}

function popupPunto(pr: Record<string, unknown>): HTMLElement {
  const vel = Number(pr.velocidad) || 0;
  const velReal = Number(pr.velReal) === 1;
  const rumbo = Number(pr.rumbo) || 0;
  const rumboReal = Number(pr.rumboReal) === 1;
  const acc = Number(pr.acc) || 0;
  const ts = Number(pr.ts) || 0;
  const c = caja();
  if (ts > 0) c.append(parrafo(horaPunto(ts), "color:#64748b;font-size:11px"));
  const pv = parrafo(vel <= 0 ? "Detenido" : `${vel} km/h`, "font-size:14px;font-weight:700;margin:2px 0");
  if (vel > 0 && !velReal) {
    const aprox = document.createElement("span");
    aprox.style.cssText = "color:#94a3b8;font-weight:400;font-size:12px";
    aprox.textContent = " aprox.";
    pv.append(aprox);
  }
  c.append(pv);
  c.append(parrafo(vel <= 0 ? "Dirección: —" : `Dirección: ${rumboCardinal(rumbo)} (${rumbo}°)${rumboReal ? "" : " aprox."}`, ""));
  c.append(parrafo(`Precisión: ±${acc} m`, "color:#64748b"));
  return c;
}

function popupEstimado(pr: Record<string, unknown>): HTMLElement {
  const km = Number(pr.km) || 0, min = Number(pr.min) || 0;
  const c = caja(160);
  c.append(parrafo("Tramo estimado (ruta prevista)", `font-weight:700;color:${COLOR_TRAMO_ESTIMADO}`));
  c.append(parrafo(`${km} km sobre la ruta${min > 0 ? ` · ~${min} min` : ""}`, "color:#334155"));
  c.append(parrafo("Sobre la ruta prevista · no medido por GPS", "color:#94a3b8;font-size:11px;margin-top:2px"));
  return c;
}

function popupSinSenal(t: TramoSinSenal, borde: string): HTMLElement {
  const { titulo, lineas } = lineasSinSenal(t);
  const c = caja();
  c.append(parrafo(titulo, "font-weight:800;color:#475569"));
  c.append(parrafo(borde === "desde" ? "Última posición antes del corte" : "Primera posición después del corte", "color:#94a3b8;font-size:11px;margin-bottom:2px"));
  for (const l of lineas) c.append(parrafo(l, "color:#334155"));
  return c;
}

function extender(b: LngLatBounds, coords: readonly Coord[]) {
  for (const c of coords) if (coordOk(c)) b.extend(c);
}

/** Los segmentos de la huella medida: uno por par de vértices, con la velocidad promedio. */
function segmentosMedidos(r: RecorridoServicio | null): unknown[] {
  const out: unknown[] = [];
  for (const t of r?.medido ?? []) {
    const cs = Array.isArray(t?.coords) ? t.coords : [];
    const vs = Array.isArray(t?.vel) ? t.vel : [];
    for (let i = 1; i < cs.length; i++) {
      if (!coordOk(cs[i - 1]) || !coordOk(cs[i])) continue;
      const a = Number(vs[i - 1]) || 0, b = Number(vs[i]) || 0;
      out.push(linea([cs[i - 1], cs[i]], { velocidad: (a + b) / 2 }));
    }
  }
  return out;
}

const CAPAS_CLIC = ["sinsenal", "puntos", "estimados"] as const;

export default function MapaRecorrido({ recorrido, paradas, enfocado, focoSinSenal, mostrarDescartados, onElegir }: {
  recorrido: RecorridoServicio | null;
  paradas: ParadaMapa[];
  /** inicioTs del episodio a enfocar, o null */
  enfocado: number | null;
  /** tramo «sin señal» a enfocar, o null */
  focoSinSenal: FocoSinSenal | null;
  mostrarDescartados: boolean;
  onElegir: (inicioTs: number) => void;
}) {
  const contRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const marcadores = useRef<MapboxMarker[]>([]);
  const popups = useRef<Map<number, MapboxPopup>>(new Map());
  const popupCapa = useRef<MapboxPopup | null>(null);
  const observador = useRef<ResizeObserver | null>(null);
  const encuadrado = useRef<string>("");
  const focoHecho = useRef<string>("");
  const recRef = useRef<RecorridoServicio | null>(recorrido);
  const [listo, setListo] = useState(false);
  const [error, setError] = useState("");
  const [verPuntos, setVerPuntos] = useState(true);
  const [verEstimados, setVerEstimados] = useState(true);
  const token = tokenMapbox();
  const cb = useRef(onElegir);
  useEffect(() => { cb.current = onElegir; }, [onElegir]);
  // Solo decide si el encuadre inicial abarca todo (sin foco) o lo hace el efecto del foco: se lee de
  // un ref para que cambiar de episodio no rehaga todas las capas y marcadores.
  const enfocadoRef = useRef(enfocado);
  useEffect(() => { enfocadoRef.current = enfocado; }, [enfocado]);

  // ── Crear el mapa (una vez) y destruirlo al desmontar ──────────────────────
  useEffect(() => {
    if (!token) return;
    let cancelado = false;
    cargarMapbox().then((gl) => {
      if (cancelado || !contRef.current || mapRef.current) return;
      const m = new gl.Map({ container: contRef.current, style: "mapbox://styles/mapbox/streets-v12", center: [-77.0428, -12.0464], zoom: 11 });
      m.addControl(new gl.NavigationControl({ showCompass: false }), "top-right");
      m.on("load", () => {
        const vacia = fc([]);
        for (const id of ["estimados", "medido", "puntos", "sinsenal", "descartados", "excesos"]) m.addSource(id, { type: "geojson", data: vacia });
        // 1 · estimados (debajo de la huella medida: esa manda visualmente)
        m.addLayer({ id: "estimados", type: "line", source: "estimados", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": COLOR_TRAMO_ESTIMADO, "line-width": 5, "line-opacity": 0.9 } });
        // 2 · medido, por velocidad (la misma expresión del modal)
        m.addLayer({ id: "medido", type: "line", source: "medido", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": expresionColorVelocidad() as never, "line-width": 5, "line-opacity": 0.9 } });
        // 3 · puntitos de telemetría
        m.addLayer({
          id: "puntos", type: "circle", source: "puntos",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 14, 4, 17, 6],
            "circle-color": expresionColorVelocidad() as never,
            "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5,
            "circle-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.55, 14, 0.9],
          },
        });
        // 4 · extremos de los tramos «sin señal» (solo puntos: NUNCA una línea en un hueco)
        m.addLayer({ id: "sinsenal", type: "circle", source: "sinsenal", paint: { "circle-color": COLOR_SIN_SENAL, "circle-radius": 5, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
        // 5 · excesos, sin cambios y encima de todo
        m.addLayer({ id: "descartados", type: "line", source: "descartados", filter: ["==", "$type", "LineString"], layout: { "line-cap": "round", visibility: "none" }, paint: { "line-color": COLOR_DESCARTADO, "line-width": 5, "line-dasharray": [1.5, 1] } });
        m.addLayer({ id: "descartados-pt", type: "circle", source: "descartados", filter: ["==", "$type", "Point"], layout: { visibility: "none" }, paint: { "circle-color": COLOR_DESCARTADO, "circle-radius": 5, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
        m.addLayer({ id: "excesos-borde", type: "line", source: "excesos", filter: ["==", "$type", "LineString"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 11 } });
        m.addLayer({ id: "excesos", type: "line", source: "excesos", filter: ["==", "$type", "LineString"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": COLOR_EXCESO, "line-width": 7 } });
        m.addLayer({ id: "excesos-pt", type: "circle", source: "excesos", filter: ["==", "$type", "Point"], paint: { "circle-color": COLOR_EXCESO, "circle-radius": 6, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });

        // Un solo manejador de clic, por prioridad (un punto encima de una línea no abre dos popups).
        const capasVisibles = () => CAPAS_CLIC.filter((id) => m.getLayer(id) && m.getLayoutProperty(id, "visibility") !== "none");
        m.on("mousemove", (e: MapMouseEvent) => {
          const hay = m.queryRenderedFeatures(e.point, { layers: capasVisibles() }).length > 0;
          m.getCanvas().style.cursor = hay ? "pointer" : "";
        });
        m.on("click", (e: MapMouseEvent) => {
          const fs = m.queryRenderedFeatures(e.point, { layers: capasVisibles() });
          let contenido: HTMLElement | null = null, donde: [number, number] = [e.lngLat.lng, e.lngLat.lat];
          for (const capa of CAPAS_CLIC) {
            const f = fs.find((x) => x.layer?.id === capa);
            if (!f) continue;
            const pr = (f.properties ?? {}) as Record<string, unknown>;
            const geom = f.geometry as { type: string; coordinates: unknown };
            if (geom.type === "Point" && coordOk(geom.coordinates)) donde = [geom.coordinates[0], geom.coordinates[1]];
            if (capa === "sinsenal") {
              const t = recRef.current?.sinSenal?.[Number(pr.i)];
              if (t) contenido = popupSinSenal(t, String(pr.borde));
            } else if (capa === "puntos") contenido = popupPunto(pr);
            else contenido = popupEstimado(pr);
            if (contenido) break;
          }
          if (!contenido) return;
          popupCapa.current?.remove();
          popupCapa.current = new gl.Popup({ closeButton: true, offset: 10, maxWidth: "260px" }).setLngLat(donde).setDOMContent(contenido).addTo(m);
        });
        setListo(true);
      });
      m.on("error", (e) => {
        const st = (e?.error as { status?: number } | undefined)?.status;
        if (st === 401 || st === 403) setError("Mapbox rechazó el token (NEXT_PUBLIC_MAPBOX_TOKEN). Revisa la variable en Vercel.");
      });
      mapRef.current = m;
      if (typeof ResizeObserver !== "undefined" && contRef.current) {
        const ro = new ResizeObserver(() => { mapRef.current?.resize(); });
        ro.observe(contRef.current);
        observador.current = ro;
      }
    }).catch(() => { if (!cancelado) setError("No se pudo cargar el motor del mapa (revisa la conexión y vuelve a abrirlo)."); });
    return () => {
      cancelado = true;
      observador.current?.disconnect();
      observador.current = null;
      marcadores.current.forEach((mk) => mk.remove());
      marcadores.current = [];
      popups.current.forEach((p) => p.remove());
      popups.current.clear();
      popupCapa.current?.remove();
      popupCapa.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [token]);

  // ── Capas, paraderos y picos ───────────────────────────────────────────────
  useEffect(() => {
    const m = mapRef.current;
    if (!listo || !m) return;
    let vivo = true;
    cargarMapbox().then((gl) => {
      if (!vivo || mapRef.current !== m) return;
      const r = recorrido;
      recRef.current = r;
      const src = (id: string) => m.getSource(id) as GeoJSONSource | undefined;
      src("estimados")?.setData(fc((r?.estimados ?? [])
        .filter((t) => Array.isArray(t?.coords) && t.coords.filter(coordOk).length >= 2)
        .map((t) => linea(t.coords.filter(coordOk), { km: t.km, min: t.min }))));
      src("medido")?.setData(fc(segmentosMedidos(r)));
      src("puntos")?.setData(fc((r?.puntos ?? []).filter((p) => coordOk(p?.c)).map((p) => punto(p.c, {
        // 1/0 en vez de booleanos: las properties de un evento Mapbox pueden llegar como string.
        velocidad: p.vel, velReal: p.velReal ? 1 : 0, rumbo: p.rumbo, rumboReal: p.rumboReal ? 1 : 0, acc: p.acc, ts: p.ts,
      }))));
      const extremos: unknown[] = [];
      (r?.sinSenal ?? []).forEach((t, i) => {
        if (coordOk(t?.desde)) extremos.push(punto(t.desde, { i, borde: "desde" }));
        if (coordOk(t?.hasta)) extremos.push(punto(t.hasta, { i, borde: "hasta" }));
      });
      src("sinsenal")?.setData(fc(extremos));
      const deEp = (cuenta: boolean) => (r?.episodios ?? []).filter((ep) => ep.cuenta === cuenta && ep.coords.length > 0)
        .map((ep) => ep.coords.length >= 2 ? linea(ep.coords, { inicio: ep.inicioTs }) : punto(ep.coords[0], { inicio: ep.inicioTs }));
      src("excesos")?.setData(fc(deEp(true)));
      src("descartados")?.setData(fc(deEp(false)));

      marcadores.current.forEach((mk) => mk.remove());
      marcadores.current = [];
      popups.current.forEach((p) => p.remove());
      popups.current.clear();

      // Paraderos: el primero verde, el último oscuro, los demás azules. Solo los que tienen coordenadas.
      const conCoord = paradas.filter((p) => p.lat != null && p.lng != null && Number.isFinite(p.lat) && Number.isFinite(p.lng));
      conCoord.forEach((p, i) => {
        const el = document.createElement("div");
        el.textContent = String(i + 1);
        el.title = `${i + 1}. ${p.nombre || "(sin nombre)"}`;
        const color = i === 0 ? "#16a34a" : i === conCoord.length - 1 ? "#0f172a" : "#0b315f";
        el.style.cssText = `width:22px;height:22px;border-radius:9999px;background:${color};color:white;font-weight:900;font-size:11px;display:flex;align-items:center;justify-content:center;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.4)`;
        marcadores.current.push(new gl.Marker({ element: el }).setLngLat([p.lng as number, p.lat as number]).addTo(m));
      });

      // El pico de cada exceso que cuenta: una pastilla roja con la velocidad sostenida.
      for (const ep of r?.episodios ?? []) {
        if (!ep.cuenta || !Number.isFinite(ep.latPico) || !Number.isFinite(ep.lngPico)) continue;
        const el = document.createElement("button");
        el.type = "button";
        el.textContent = `${Math.round(ep.velMediaSensor)} km/h`;
        el.title = ep.contexto?.texto ? `Exceso de las ${horaLima(ep.inicioTs)} · ${ep.contexto.texto}` : `Exceso de las ${horaLima(ep.inicioTs)}`;
        el.style.cssText = `background:${COLOR_EXCESO};color:white;font-weight:900;font-size:11px;border:2px solid white;border-radius:9999px;padding:2px 7px;box-shadow:0 1px 4px rgba(0,0,0,.45);cursor:pointer;white-space:nowrap`;
        const pop = new gl.Popup({ offset: 14, closeButton: true, maxWidth: "260px" }).setDOMContent(popupEpisodio(ep, r!.umbral));
        el.addEventListener("click", (ev) => { ev.stopPropagation(); cb.current(ep.inicioTs); });
        const mk = new gl.Marker({ element: el }).setLngLat([ep.lngPico, ep.latPico]).setPopup(pop).addTo(m);
        marcadores.current.push(mk);
        popups.current.set(ep.inicioTs, pop);
      }

      // Encuadre inicial: una vez por recorrido (no en cada refresco de un servicio en curso).
      const clave = r ? `${r.reservaId}|${r.umbral}` : "";
      if (r && encuadrado.current !== clave && enfocadoRef.current == null) {
        const b = new gl.LngLatBounds();
        for (const t of r.medido ?? []) extender(b, t.coords ?? []);
        for (const t of r.estimados ?? []) extender(b, t.coords ?? []);
        for (const t of r.sinSenal ?? []) extender(b, [t.desde, t.hasta].filter(coordOk));
        for (const ep of r.episodios ?? []) extender(b, ep.coords);
        for (const p of conCoord) b.extend([p.lng as number, p.lat as number]);
        if (!b.isEmpty()) { m.fitBounds(b, { padding: 50, maxZoom: 15, duration: 0 }); encuadrado.current = clave; }
      }
    });
    return () => { vivo = false; };
  }, [listo, recorrido, paradas]);

  // ── Mostrar / ocultar capas ────────────────────────────────────────────────
  useEffect(() => {
    const m = mapRef.current;
    if (!listo || !m) return;
    const vis = (id: string, v: boolean) => { if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", v ? "visible" : "none"); };
    vis("descartados", mostrarDescartados);
    vis("descartados-pt", mostrarDescartados);
    vis("puntos", verPuntos);
    vis("estimados", verEstimados);
  }, [listo, mostrarDescartados, verPuntos, verEstimados]);

  // ── Enfocar un episodio ────────────────────────────────────────────────────
  useEffect(() => {
    const m = mapRef.current;
    if (!listo || !m || enfocado == null || !recorrido) return;
    const ep = recorrido.episodios.find((x) => x.inicioTs === enfocado);
    if (!ep) return;
    // Un refresco del mismo servicio (en curso, cada 60 s) no vuelve a mover el mapa.
    const claveFoco = `${recorrido.reservaId}|${recorrido.umbral}|${enfocado}`;
    if (focoHecho.current === claveFoco) return;
    focoHecho.current = claveFoco;
    cargarMapbox().then((gl) => {
      if (mapRef.current !== m) return;
      const b = new gl.LngLatBounds();
      extender(b, ep.coords);
      if (Number.isFinite(ep.lngPico) && Number.isFinite(ep.latPico)) b.extend([ep.lngPico, ep.latPico]);
      if (!b.isEmpty()) m.fitBounds(b, { padding: 120, maxZoom: 16, duration: 600 });
      encuadrado.current = `${recorrido.reservaId}|${recorrido.umbral}`;
      popups.current.forEach((p) => p.remove());
      popupCapa.current?.remove();
      const pop = popups.current.get(ep.inicioTs);
      if (pop && Number.isFinite(ep.lngPico) && Number.isFinite(ep.latPico)) pop.setLngLat([ep.lngPico, ep.latPico]).addTo(m);
    });
  }, [listo, enfocado, recorrido]);

  // ── Enfocar un tramo «sin señal» (desde la lista de la página) ─────────────
  const focoSinSenalHecho = useRef(0);
  useEffect(() => {
    const m = mapRef.current;
    if (!listo || !m || !focoSinSenal || !recorrido) return;
    if (focoSinSenalHecho.current === focoSinSenal.n) return;
    const t = recorrido.sinSenal?.[focoSinSenal.i];
    if (!t) return;
    const bordes = ([["desde", t.desde], ["hasta", t.hasta]] as const).filter((x): x is readonly [typeof x[0], Coord] => coordOk(x[1]));
    if (!bordes.length) return;
    focoSinSenalHecho.current = focoSinSenal.n;
    cargarMapbox().then((gl) => {
      if (mapRef.current !== m) return;
      const b = new gl.LngLatBounds();
      extender(b, bordes.map((x) => x[1]));
      if (bordes.length === 1) m.flyTo({ center: bordes[0][1], zoom: Math.max(m.getZoom(), 15), duration: 600 });
      else m.fitBounds(b, { padding: 120, maxZoom: 16, duration: 600 });
      encuadrado.current = `${recorrido.reservaId}|${recorrido.umbral}`;
      popups.current.forEach((p) => p.remove());
      popupCapa.current?.remove();
      popupCapa.current = new gl.Popup({ closeButton: true, offset: 10, maxWidth: "260px" })
        .setLngLat(bordes[0][1]).setDOMContent(popupSinSenal(t, bordes[0][0])).addTo(m);
    });
  }, [listo, focoSinSenal, recorrido]);

  if (!token) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-900 text-white text-sm px-6 text-center">
        El mapa no se muestra: falta configurar NEXT_PUBLIC_MAPBOX_TOKEN (Vercel → Settings → Environment Variables).
      </div>
    );
  }
  const hayPuntos = (recorrido?.puntos?.length ?? 0) > 0;
  const hayEstimados = (recorrido?.estimados?.length ?? 0) > 0;
  return (
    <div className="relative w-full h-full">
      {/* Ancho y alto EXPLÍCITOS: Mapbox pone `position: relative` al contenedor y pisaría un `absolute inset-0`. */}
      <div ref={contRef} style={{ width: "100%", height: "100%" }} />
      {!listo && !error && <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400 bg-gray-50">Cargando mapa…</div>}
      {error && <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-600 bg-gray-50 px-6 text-center">{error}</div>}

      {/* Leyenda: la rampa de velocidad del modal GPS (lib/huella.ts), los estimados, «sin señal» y el exceso. */}
      {listo && !error && (
        <div className="absolute top-3 left-3 max-w-[calc(100%-4.5rem)] bg-white/95 rounded-xl shadow px-3 py-2 text-[11px] text-gray-700 space-y-1">
          <p className="text-[9px] font-bold uppercase text-gray-400">Huella GPS · velocidad</p>
          <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-[10px] font-bold text-gray-600">
            {RAMPA_VELOCIDAD.map((v) => (
              <span key={v.etiqueta} className="flex items-center gap-1"><span className={`w-5 h-1.5 rounded ${v.claseLeyenda} inline-block`} />{v.etiqueta}</span>
            ))}
          </div>
          <p className="flex items-center gap-2"><span className="inline-block w-5 h-1 rounded" style={{ background: COLOR_TRAMO_ESTIMADO }} /> Tramo estimado</p>
          <p className="flex items-center gap-2">
            <span className="inline-block w-5 text-center"><span className="inline-block w-2.5 h-2.5 rounded-full align-middle" style={{ background: COLOR_SIN_SENAL, boxShadow: "0 0 0 2px #fff, 0 0 0 3px #cbd5e1" }} /></span>
            Sin señal (extremos)
          </p>
          <p className="flex items-center gap-2">
            <span className="inline-block w-5 h-2 rounded" style={{ background: COLOR_EXCESO, boxShadow: "0 0 0 2px #fff, 0 0 0 3px #cbd5e1" }} /> Exceso de velocidad
          </p>
          {mostrarDescartados && <p className="flex items-center gap-2"><span className="inline-block w-5 border-t-2 border-dashed" style={{ borderColor: COLOR_DESCARTADO }} /> Descartado</p>}
          {(hayPuntos || hayEstimados) && (
            <div className="pt-1 space-y-1">
              {hayPuntos && (
                <button type="button" onClick={() => setVerPuntos((v) => !v)}
                  className="flex items-center gap-1.5 py-0.5 text-[10px] font-bold text-gray-500 hover:text-gray-800">
                  <span className={`w-2.5 h-2.5 rounded-full inline-block border-2 border-white ${verPuntos ? "bg-green-500 shadow" : "bg-gray-300"}`} />
                  {verPuntos ? "Ocultar" : "Mostrar"} datos por punto
                </button>
              )}
              {hayEstimados && (
                <button type="button" onClick={() => setVerEstimados((v) => !v)}
                  className="flex items-center gap-1.5 py-0.5 text-[10px] font-bold text-gray-500 hover:text-gray-800">
                  <span className="w-5 h-1 rounded inline-block" style={{ background: COLOR_TRAMO_ESTIMADO, opacity: verEstimados ? 1 : 0.3 }} />
                  {verEstimados ? "Ocultar" : "Mostrar"} tramo estimado
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
