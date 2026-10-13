"use client";
// components/cotizaciones/MapaParaderos.tsx
// El mapa de los paraderos de una cotización (ida o retorno, cada uno el suyo): la ruta que
// devolvió /api/ruta y un marcador numerado por paradero, ARRASTRABLE.
//
// El mapa NO decide nada: arrastrar un marcador le avisa a la lista (`onMover`) con las
// coordenadas nuevas, y un clic sobre la línea le propone dónde insertar (`onInsertar`). Qué
// índice le toca al paradero nuevo lo decide `indiceDeInsercion` (lib/paradas-horario.ts) en
// quien lo monta, y la dirección NO se re-geocodifica al soltar: el nombre que escribió una
// persona no se reemplaza solo (el botón «↻ Actualizar dirección» lo hace a pedido).
//
// Coordenadas [lng, lat] de punta a punta, como todo el ERP tras /api/ruta.

import { useEffect, useRef, useState } from "react";
import type { Map as MapboxMap, Marker as MapboxMarker, Popup as MapboxPopup, GeoJSONSource } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { cargarMapbox, tokenMapbox } from "@/lib/mapbox-carga";

export type PuntoMapa = { id: string; nombre: string; lat: number; lng: number; numero: number; tipo: "inicio" | "intermedia" | "destino" };

const COLOR: Record<PuntoMapa["tipo"], string> = { inicio: "#16a34a", intermedia: "#1d4ed8", destino: "#dc2626" };
const ALTO_PX = 320;

export default function MapaParaderos({ puntos, poli, onMover, onInsertar, colorRuta = "#0b315f" }: {
  puntos: PuntoMapa[];
  poli: [number, number][] | null;
  onMover: (id: string, lat: number, lng: number) => void;
  /** Clic en «＋ Paradero aquí»: el punto, en [lng, lat]. */
  onInsertar: (punto: [number, number]) => void;
  colorRuta?: string;
}) {
  const contRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const marcadores = useRef<MapboxMarker[]>([]);
  const popupRef = useRef<MapboxPopup | null>(null);
  const [listo, setListo] = useState(false);
  const [error, setError] = useState("");
  const token = tokenMapbox();

  // Los callbacks cambian en cada render del padre: se leen de un ref para que los
  // listeners del mapa (creados una vez) nunca llamen a una versión vieja.
  const cb = useRef({ onMover, onInsertar });
  useEffect(() => { cb.current = { onMover, onInsertar }; }, [onMover, onInsertar]);

  // ── Crear el mapa (una vez) y destruirlo al desmontar ──────────────────────
  useEffect(() => {
    if (!token) return;
    let cancelado = false;
    cargarMapbox().then(gl => {
      if (cancelado || !contRef.current || mapRef.current) return;
      const m = new gl.Map({
        container: contRef.current,
        style: "mapbox://styles/mapbox/streets-v12",
        center: [-77.0428, -12.0464],
        zoom: 11,
      });
      m.addControl(new gl.NavigationControl({ showCompass: false }), "top-right");
      m.on("load", () => {
        m.addSource("ruta", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } } });
        m.addLayer({ id: "ruta-borde", type: "line", source: "ruta", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 7 } });
        m.addLayer({ id: "ruta", type: "line", source: "ruta", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": colorRuta, "line-width": 4 } });
        // Capa invisible y ancha: un clic sobre una línea de 4 px es difícil con el dedo.
        m.addLayer({ id: "ruta-clic", type: "line", source: "ruta", paint: { "line-color": "#000000", "line-width": 18, "line-opacity": 0 } });
        m.on("mouseenter", "ruta-clic", () => { m.getCanvas().style.cursor = "copy"; });
        m.on("mouseleave", "ruta-clic", () => { m.getCanvas().style.cursor = ""; });
        m.on("click", "ruta-clic", (e) => {
          const punto: [number, number] = [e.lngLat.lng, e.lngLat.lat];
          popupRef.current?.remove();
          const caja = document.createElement("div");
          caja.style.cssText = "font-family:inherit;font-size:12px;padding:2px";
          const btn = document.createElement("button");
          btn.type = "button";
          btn.textContent = "＋ Paradero aquí";
          btn.style.cssText = "background:#0b315f;color:white;font-weight:700;border:none;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px";
          const nota = document.createElement("p");
          nota.textContent = "Se inserta entre los dos paraderos que lo rodean en el recorrido.";
          nota.style.cssText = "margin:6px 0 0;color:#64748b;font-size:10px;max-width:170px";
          caja.append(btn, nota);
          const pop = new gl.Popup({ closeButton: true, offset: 8, maxWidth: "220px" }).setLngLat(punto).setDOMContent(caja).addTo(m);
          btn.onclick = () => { pop.remove(); cb.current.onInsertar(punto); };
          popupRef.current = pop;
        });
        setListo(true);
      });
      m.on("error", (e: any) => {
        // Un 401 del estilo es el token inválido: dicho, no un recuadro en blanco.
        const st = e?.error?.status;
        if (st === 401 || st === 403) setError("Mapbox rechazó el token (NEXT_PUBLIC_MAPBOX_TOKEN). Revisa la variable en Vercel.");
      });
      mapRef.current = m;
    }).catch(() => { if (!cancelado) setError("No se pudo cargar el motor del mapa (revisa la conexión y vuelve a abrirlo)."); });
    return () => {
      cancelado = true;
      marcadores.current.forEach(mk => mk.remove());
      marcadores.current = [];
      popupRef.current?.remove();
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // colorRuta solo se lee al crear la capa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // ── La línea de la ruta ────────────────────────────────────────────────────
  useEffect(() => {
    const m = mapRef.current;
    if (!listo || !m) return;
    const src = m.getSource("ruta") as GeoJSONSource | undefined;
    src?.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: poli && poli.length >= 2 ? poli : [] } });
  }, [listo, poli]);

  // ── Marcadores ─────────────────────────────────────────────────────────────
  const clavePuntos = puntos.map(p => `${p.id}:${p.lat.toFixed(6)},${p.lng.toFixed(6)}:${p.numero}:${p.tipo}:${p.nombre}`).join("|");
  useEffect(() => {
    const m = mapRef.current;
    if (!listo || !m) return;
    let vivo = true;
    cargarMapbox().then(gl => {
      if (!vivo || mapRef.current !== m) return;
      marcadores.current.forEach(mk => mk.remove());
      marcadores.current = puntos.map(p => {
        const el = document.createElement("div");
        el.textContent = String(p.numero);
        el.title = `${p.numero}. ${p.nombre || "(sin nombre)"} — arrastra para moverlo`;
        el.style.cssText = `width:28px;height:28px;border-radius:9999px;background:${COLOR[p.tipo]};color:white;font-weight:900;font-size:13px;display:flex;align-items:center;justify-content:center;border:3px solid white;box-shadow:0 1px 4px rgba(0,0,0,.4);cursor:grab`;
        const mk = new gl.Marker({ element: el, draggable: true }).setLngLat([p.lng, p.lat]).addTo(m);
        mk.on("dragend", () => {
          const ll = mk.getLngLat();
          cb.current.onMover(p.id, ll.lat, ll.lng);
        });
        return mk;
      });
    });
    return () => { vivo = false; };
    // `clavePuntos` resume `puntos`: solo se rehacen cuando cambia algo que se ve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listo, clavePuntos]);

  // ── Encuadre: al cargar y cuando cambia cuántos paraderos hay ──────────────
  const encuadrar = () => {
    const m = mapRef.current;
    if (!m || puntos.length === 0) return;
    cargarMapbox().then(gl => {
      const b = new gl.LngLatBounds();
      puntos.forEach(p => b.extend([p.lng, p.lat]));
      (poli || []).forEach(c => b.extend(c));
      m.fitBounds(b, { padding: 40, maxZoom: 15, duration: 0 });
    });
  };
  const nPuntos = puntos.length;
  const conRuta = !!poli && poli.length >= 2;
  useEffect(() => {
    if (listo) encuadrar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listo, nPuntos, conRuta]);

  if (!token) {
    return <p className="text-[11px] text-gray-400 italic">El mapa no se muestra: falta configurar NEXT_PUBLIC_MAPBOX_TOKEN (Vercel → Settings → Environment Variables).</p>;
  }
  return (
    <div className="relative w-full rounded-xl overflow-hidden border border-gray-200" style={{ height: ALTO_PX }}>
      <div ref={contRef} className="absolute inset-0" />
      {!listo && !error && <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 bg-gray-50">Cargando mapa…</div>}
      {error && <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 bg-gray-50 px-4 text-center">{error}</div>}
      {listo && (
        <button type="button" onClick={encuadrar} className="absolute left-2 top-2 bg-white/95 border border-gray-200 rounded-lg px-2 py-1 text-[10px] font-bold text-gray-600 hover:bg-white shadow-sm">⤢ Encuadrar</button>
      )}
    </div>
  );
}
