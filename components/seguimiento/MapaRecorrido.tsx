"use client";
// components/seguimiento/MapaRecorrido.tsx
// El mapa de «Ver recorrido» (/seguimiento/gps/[id]): la traza GPS REAL del servicio en azul, los
// huecos de señal punteados en gris y, encima, en ROJO, los tramos donde hubo exceso de velocidad,
// con una marca en el punto del pico. Mapbox, como el resto de la operación: no consulta ninguna
// ruta a Google (la vista anterior cargaba Google Maps y le pedía la ruta PLANEADA con tráfico).
//
// El mapa NO decide nada: dibuja lo que trae `RecorridoServicio` (lib/flota/recorrido.ts), cuyos
// episodios son los de la columna «Excesos» de /uso-flota. Coordenadas [lng, lat] de punta a punta.

import { useEffect, useRef, useState } from "react";
import type { Map as MapboxMap, Marker as MapboxMarker, Popup as MapboxPopup, GeoJSONSource, LngLatBounds } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { cargarMapbox, tokenMapbox } from "@/lib/mapbox-carga";
import type { RecorridoServicio, EpisodioMapa, Coord } from "@/lib/flota/recorrido";

export type ParadaMapa = { id: number; nombre: string; lat: number | null; lng: number | null; estado: string };

export const COLOR_TRAZA = "#2563eb";
export const COLOR_EXCESO = "#dc2626";
export const COLOR_DESCARTADO = "#f59e0b";
export const COLOR_HUECO = "#94a3b8";

const fc = (features: unknown[]) => ({ type: "FeatureCollection" as const, features: features as never[] });
const linea = (coords: Coord[], props: Record<string, unknown> = {}) =>
  ({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
const punto = (c: Coord, props: Record<string, unknown> = {}) =>
  ({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: c } });

export function horaLima(ts: number): string {
  return new Date(ts).toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** El contenido del popup de un episodio, armado con nodos (nunca HTML concatenado). */
function popupEpisodio(ep: EpisodioMapa, umbral: number): HTMLElement {
  const caja = document.createElement("div");
  caja.style.cssText = "font-family:inherit;font-size:12px;line-height:1.35;max-width:240px";
  const t = document.createElement("p");
  t.style.cssText = `margin:0 0 4px;font-weight:800;color:${ep.cuenta ? COLOR_EXCESO : "#b45309"}`;
  t.textContent = ep.cuenta
    ? `Exceso · ${Math.round(ep.velMediaSensor)} km/h sostenidos (umbral ${umbral})`
    : "Episodio descartado (no cuenta como exceso)";
  const l1 = document.createElement("p");
  l1.style.cssText = "margin:0;color:#334155";
  l1.textContent = `${horaLima(ep.inicioTs)}–${horaLima(ep.finTs)} · ${Math.round(ep.durS)} s · pico ${Math.round(ep.velMaxSensor)} km/h`;
  const l2 = document.createElement("p");
  l2.style.cssText = "margin:4px 0 0;color:#64748b;font-size:11px";
  l2.textContent = ep.detalle;
  caja.append(t, l1, l2);
  return caja;
}

function extender(b: LngLatBounds, coords: readonly Coord[]) {
  for (const c of coords) b.extend(c);
}

export default function MapaRecorrido({ recorrido, paradas, enfocado, mostrarDescartados, onElegir }: {
  recorrido: RecorridoServicio | null;
  paradas: ParadaMapa[];
  /** inicioTs del episodio a enfocar, o null */
  enfocado: number | null;
  mostrarDescartados: boolean;
  onElegir: (inicioTs: number) => void;
}) {
  const contRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const marcadores = useRef<MapboxMarker[]>([]);
  const popups = useRef<Map<number, MapboxPopup>>(new Map());
  const observador = useRef<ResizeObserver | null>(null);
  const encuadrado = useRef<string>("");
  const focoHecho = useRef<string>("");
  const [listo, setListo] = useState(false);
  const [error, setError] = useState("");
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
        m.addSource("traza", { type: "geojson", data: vacia });
        m.addSource("huecos", { type: "geojson", data: vacia });
        m.addSource("descartados", { type: "geojson", data: vacia });
        m.addSource("excesos", { type: "geojson", data: vacia });
        m.addLayer({ id: "traza-borde", type: "line", source: "traza", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 7 } });
        m.addLayer({ id: "traza", type: "line", source: "traza", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": COLOR_TRAZA, "line-width": 4, "line-opacity": 0.85 } });
        m.addLayer({ id: "huecos", type: "line", source: "huecos", paint: { "line-color": COLOR_HUECO, "line-width": 2, "line-dasharray": [2, 2] } });
        m.addLayer({ id: "descartados", type: "line", source: "descartados", filter: ["==", "$type", "LineString"], layout: { "line-cap": "round", visibility: "none" }, paint: { "line-color": COLOR_DESCARTADO, "line-width": 5, "line-dasharray": [1.5, 1] } });
        m.addLayer({ id: "descartados-pt", type: "circle", source: "descartados", filter: ["==", "$type", "Point"], layout: { visibility: "none" }, paint: { "circle-color": COLOR_DESCARTADO, "circle-radius": 5, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
        m.addLayer({ id: "excesos-borde", type: "line", source: "excesos", filter: ["==", "$type", "LineString"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 11 } });
        m.addLayer({ id: "excesos", type: "line", source: "excesos", filter: ["==", "$type", "LineString"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": COLOR_EXCESO, "line-width": 7 } });
        m.addLayer({ id: "excesos-pt", type: "circle", source: "excesos", filter: ["==", "$type", "Point"], paint: { "circle-color": COLOR_EXCESO, "circle-radius": 6, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
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
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [token]);

  // ── Líneas, paraderos y picos ──────────────────────────────────────────────
  useEffect(() => {
    const m = mapRef.current;
    if (!listo || !m) return;
    let vivo = true;
    cargarMapbox().then((gl) => {
      if (!vivo || mapRef.current !== m) return;
      const r = recorrido;
      const src = (id: string) => m.getSource(id) as GeoJSONSource | undefined;
      src("traza")?.setData(fc((r?.tramos ?? []).map((t) => linea(t))));
      src("huecos")?.setData(fc((r?.huecos ?? []).map((h) => linea([h.desde, h.hasta]))));
      const deEp = (cuenta: boolean) => (r?.episodios ?? []).filter((ep) => ep.cuenta === cuenta && ep.coords.length > 0)
        .map((ep) => ep.coords.length >= 2 ? linea(ep.coords, { inicio: ep.inicioTs }) : punto(ep.coords[0], { inicio: ep.inicioTs }));
      src("excesos")?.setData(fc(deEp(true)));
      src("descartados")?.setData(fc(deEp(false)));

      marcadores.current.forEach((mk) => mk.remove());
      marcadores.current = [];
      popups.current.forEach((p) => p.remove());
      popups.current.clear();

      // Paraderos: el primero verde, el último rojo, los demás azules. Solo los que tienen coordenadas.
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
        el.title = `Exceso de las ${horaLima(ep.inicioTs)}`;
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
        let hay = false;
        for (const t of r.tramos) { extender(b, t); hay = hay || t.length > 0; }
        for (const ep of r.episodios) { extender(b, ep.coords); hay = hay || ep.coords.length > 0; }
        for (const p of conCoord) { b.extend([p.lng as number, p.lat as number]); hay = true; }
        if (hay) { m.fitBounds(b, { padding: 50, maxZoom: 15, duration: 0 }); encuadrado.current = clave; }
      }
    });
    return () => { vivo = false; };
  }, [listo, recorrido, paradas]);

  // ── Mostrar / ocultar los descartados ──────────────────────────────────────
  useEffect(() => {
    const m = mapRef.current;
    if (!listo || !m) return;
    const v = mostrarDescartados ? "visible" : "none";
    if (m.getLayer("descartados")) m.setLayoutProperty("descartados", "visibility", v);
    if (m.getLayer("descartados-pt")) m.setLayoutProperty("descartados-pt", "visibility", v);
  }, [listo, mostrarDescartados]);

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
      const pop = popups.current.get(ep.inicioTs);
      if (pop && Number.isFinite(ep.lngPico) && Number.isFinite(ep.latPico)) pop.setLngLat([ep.lngPico, ep.latPico]).addTo(m);
    });
  }, [listo, enfocado, recorrido]);

  if (!token) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-gray-900 text-white text-sm px-6 text-center">
        El mapa no se muestra: falta configurar NEXT_PUBLIC_MAPBOX_TOKEN (Vercel → Settings → Environment Variables).
      </div>
    );
  }
  return (
    <div className="relative w-full h-full">
      {/* Ancho y alto EXPLÍCITOS: Mapbox pone `position: relative` al contenedor y pisaría un `absolute inset-0`. */}
      <div ref={contRef} style={{ width: "100%", height: "100%" }} />
      {!listo && !error && <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400 bg-gray-50">Cargando mapa…</div>}
      {error && <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-600 bg-gray-50 px-6 text-center">{error}</div>}
    </div>
  );
}
