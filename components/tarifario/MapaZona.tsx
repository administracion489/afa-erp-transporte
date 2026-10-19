"use client";
// components/tarifario/MapaZona.tsx — El mapa donde se fija el CENTRO de una subzona o de un punto
// (geocerca): clic en el mapa o arrastrar el marcador. Las otras subzonas del distrito (o los otros
// puntos) se ven como marcadores grises, para ver el reparto; con `radio`, el círculo de la
// geocerca se dibuja alrededor del centro.
//
// El mapa NO decide nada: avisa las coordenadas (`onCentro`) y quien lo monta las guarda. Mismo
// patrón de carga que components/cotizaciones/MapaParaderos.tsx (motor perezoso, ResizeObserver,
// el token dicho si falta). Coordenadas [lng, lat] para Mapbox.

import { useEffect, useRef, useState } from "react";
import type { Map as MapboxMap, Marker as MapboxMarker, GeoJSONSource } from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { cargarMapbox, tokenMapbox } from "@/lib/mapbox-carga";

export type ZonaEnMapa = { id: number; nombre: string; lat: number; lng: number; radio_m?: number | null };
export type Vuelo = { lat: number; lng: number; zoom: number; n: number };

const ALTO_PX = 300;
const LIMA: [number, number] = [-77.0428, -12.0464];

/** Un círculo de `radio` metros como polígono (64 lados), en [lng, lat]. */
function circulo(lat: number, lng: number, radio: number): [number, number][] {
  const out: [number, number][] = [];
  const dLat = radio / 110540;
  const dLng = radio / (111320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    out.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return out;
}

const coleccion = (polis: [number, number][][]) => ({
  type: "FeatureCollection" as const,
  features: polis.map((p) => ({ type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [p] } })),
});

export default function MapaZona({ centro, onCentro, otras, radio, volarA }: {
  centro: { lat: number; lng: number } | null;
  onCentro: (lat: number, lng: number) => void;
  otras: ZonaEnMapa[];
  radio?: number | null;
  volarA?: Vuelo | null;
}) {
  const contRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapboxMap | null>(null);
  const marcaCentro = useRef<MapboxMarker | null>(null);
  const marcasOtras = useRef<MapboxMarker[]>([]);
  const observador = useRef<ResizeObserver | null>(null);
  const [listo, setListo] = useState(false);
  const [error, setError] = useState("");
  const token = tokenMapbox();
  const cb = useRef({ onCentro });
  useEffect(() => { cb.current = { onCentro }; });

  // ── Crear el mapa una vez ─────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    let cancelado = false;
    cargarMapbox().then((gl) => {
      if (cancelado || !contRef.current || mapRef.current) return;
      const m = new gl.Map({ container: contRef.current, style: "mapbox://styles/mapbox/streets-v12", center: LIMA, zoom: 10.5 });
      m.addControl(new gl.NavigationControl({ showCompass: false }), "top-right");
      m.on("load", () => {
        m.addSource("otras", { type: "geojson", data: coleccion([]) });
        m.addLayer({ id: "otras-fill", type: "fill", source: "otras", paint: { "fill-color": "#64748b", "fill-opacity": 0.08 } });
        m.addLayer({ id: "otras-line", type: "line", source: "otras", paint: { "line-color": "#64748b", "line-width": 1, "line-dasharray": [2, 2] } });
        m.addSource("circulo", { type: "geojson", data: coleccion([]) });
        m.addLayer({ id: "circulo-fill", type: "fill", source: "circulo", paint: { "fill-color": "#dc2626", "fill-opacity": 0.12 } });
        m.addLayer({ id: "circulo-line", type: "line", source: "circulo", paint: { "line-color": "#dc2626", "line-width": 2 } });
        setListo(true);
      });
      m.on("click", (e) => cb.current.onCentro(e.lngLat.lat, e.lngLat.lng));
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
      marcaCentro.current?.remove();
      marcaCentro.current = null;
      marcasOtras.current.forEach((mk) => mk.remove());
      marcasOtras.current = [];
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [token]);

  // ── El marcador del centro (arrastrable) ──────────────────────────────────
  const latC = centro?.lat ?? null;
  const lngC = centro?.lng ?? null;
  useEffect(() => {
    const m = mapRef.current;
    if (!listo || !m) return;
    if (latC == null || lngC == null) {
      marcaCentro.current?.remove();
      marcaCentro.current = null;
      return;
    }
    if (marcaCentro.current) { marcaCentro.current.setLngLat([lngC, latC]); return; }
    let vivo = true;
    cargarMapbox().then((gl) => {
      if (!vivo || mapRef.current !== m || marcaCentro.current) return;
      const mk = new gl.Marker({ color: "#dc2626", draggable: true }).setLngLat([lngC, latC]).addTo(m);
      mk.on("dragend", () => { const ll = mk.getLngLat(); cb.current.onCentro(ll.lat, ll.lng); });
      marcaCentro.current = mk;
    });
    return () => { vivo = false; };
  }, [listo, latC, lngC]);

  // ── El círculo de la geocerca ─────────────────────────────────────────────
  const r = Number(radio) > 0 ? Number(radio) : null;
  useEffect(() => {
    const m = mapRef.current;
    if (!listo || !m) return;
    const src = m.getSource("circulo") as GeoJSONSource | undefined;
    src?.setData(coleccion(latC != null && lngC != null && r ? [circulo(latC, lngC, r)] : []));
  }, [listo, latC, lngC, r]);

  // ── Las otras zonas ───────────────────────────────────────────────────────
  const claveOtras = otras.map((o) => `${o.id}:${o.lat.toFixed(6)},${o.lng.toFixed(6)}:${o.radio_m ?? ""}:${o.nombre}`).join("|");
  useEffect(() => {
    const m = mapRef.current;
    if (!listo || !m) return;
    let vivo = true;
    const src = m.getSource("otras") as GeoJSONSource | undefined;
    src?.setData(coleccion(otras.filter((o) => Number(o.radio_m) > 0).map((o) => circulo(o.lat, o.lng, Number(o.radio_m)))));
    cargarMapbox().then((gl) => {
      if (!vivo || mapRef.current !== m) return;
      marcasOtras.current.forEach((mk) => mk.remove());
      marcasOtras.current = otras.map((o) => {
        const el = document.createElement("div");
        el.style.cssText = "display:flex;flex-direction:column;align-items:center;pointer-events:none";
        const punto = document.createElement("div");
        punto.style.cssText = "width:14px;height:14px;border-radius:9999px;background:#475569;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.4)";
        const rot = document.createElement("div");
        rot.textContent = o.nombre;
        rot.style.cssText = "margin-top:2px;font-size:10px;font-weight:700;color:#334155;background:rgba(255,255,255,.9);padding:0 4px;border-radius:4px;white-space:nowrap";
        el.append(punto, rot);
        return new gl.Marker({ element: el, anchor: "top" }).setLngLat([o.lng, o.lat]).addTo(m);
      });
    });
    return () => { vivo = false; };
    // `claveOtras` resume `otras`: solo se rehacen cuando cambia algo que se ve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listo, claveOtras]);

  // ── Encuadre inicial: el centro, o las otras zonas ────────────────────────
  const encuadrar = () => {
    const m = mapRef.current;
    if (!m) return;
    if (latC != null && lngC != null) { m.jumpTo({ center: [lngC, latC], zoom: Math.max(m.getZoom(), 14) }); return; }
    if (otras.length === 0) return;
    cargarMapbox().then((gl) => {
      const b = new gl.LngLatBounds();
      otras.forEach((o) => b.extend([o.lng, o.lat]));
      m.fitBounds(b, { padding: 50, maxZoom: 14, duration: 0 });
    });
  };
  useEffect(() => {
    if (listo) encuadrar();
    // Solo al quedar listo: después, quien mueve el mapa es la persona.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listo]);

  // ── «Ir a un lugar» ───────────────────────────────────────────────────────
  const nVuelo = volarA?.n ?? 0;
  useEffect(() => {
    const m = mapRef.current;
    if (!listo || !m || !volarA) return;
    m.flyTo({ center: [volarA.lng, volarA.lat], zoom: volarA.zoom, duration: 600 });
    // `n` cambia en cada pedido de vuelo, aunque sea al mismo sitio.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listo, nVuelo]);

  if (!token) {
    return <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">El mapa no se muestra: falta configurar NEXT_PUBLIC_MAPBOX_TOKEN (Vercel → Settings → Environment Variables). Sin mapa no se puede marcar el centro.</p>;
  }
  return (
    <div className="relative w-full rounded-xl overflow-hidden border border-gray-200" style={{ height: ALTO_PX }}>
      {/* Ancho y alto explícitos: con `absolute inset-0` Mapbox deja el contenedor en 0 px (ver MapaParaderos). */}
      <div ref={contRef} style={{ width: "100%", height: "100%", cursor: "crosshair" }} />
      {!listo && !error && <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 bg-gray-50">Cargando mapa…</div>}
      {error && <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-500 bg-gray-50 px-4 text-center">{error}</div>}
      {listo && (
        <button type="button" onClick={encuadrar}
          className="absolute left-2 top-2 bg-white/95 border border-gray-200 rounded-lg px-2 py-1 text-[10px] font-bold text-gray-600 hover:bg-white shadow-sm">⤢ Encuadrar</button>
      )}
    </div>
  );
}
