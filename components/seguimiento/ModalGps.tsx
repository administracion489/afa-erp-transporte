"use client";

// ModalGps.tsx — Mapbox base + Google Directions ruta real + tráfico
// Protegido contra: coordenadas string, respuestas vacías, campos undefined

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  calcBearing, limpiarHuella, colorearMatched,
  crearAjustadorHuella, filasAPuntos, huellaCrudaFeatures,
} from "@/lib/huella";

declare global { interface Window { mapboxgl: any; } }

type UbicGps = {
  lat: number; lng: number; velocidad: number; rumbo: number;
  precision_m: number; estado: string;
  created_at: string | null; timestamp: string | null;
};

type Parada = {
  id: number; nombre: string; lat: number | null; lng: number | null;
  hora_estimada: string | null; estado: string; orden: number;
};

type Tramo = {
  desde: string; hasta: string; distancia_km: number;
  duracion_min: number; duracion_trafico_min: number; duracion_texto: string;
};

type RutaData = {
  coordenadas: [number, number][];
  tramos: Tramo[];
  total_km: number; total_min: number; advertencia: string | null;
};

type Props = {
  reservaId: number; vehiculoId: number | null;
  vehiculoTerceroId?: number | null;
  vehiculoPlaca: string; conductorNombre: string;
  conductorTel: string; clienteNombre: string;
  paradas: Parada[];
  paradasJson?: any[] | null;
  origen?: string | null;
  destino?: string | null;
  onClose: () => void;
};

// ── Helpers de formato (mismos que la página de seguimiento) ─────────────────
const fmtHoraLlegada = (min: number) => {
  const d = new Date(Date.now() + min * 60000);
  return d.toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Lima" });
};
const fmtTiempo = (min: number) => {
  if (min < 1) return "menos de 1 min";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60); const m = Math.round(min % 60);
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
};
const fmtDistancia = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

// Helpers de huella (distancia, rumbo, suavizado, limpieza de jitter, Map Matching por
// ventanas) viven en lib/huella.ts — fuente ÚNICA compartida con el mapa "En vivo" del
// portal cliente (app/cliente/page.tsx). NO duplicar aquí.

export default function ModalGps({
  reservaId, vehiculoId, vehiculoTerceroId = null, vehiculoPlaca, conductorNombre,
  conductorTel, clienteNombre, paradas, paradasJson, origen, destino, onClose,
}: Props) {
  const mapRef    = useRef<HTMLDivElement>(null);
  const mapInst   = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const ubicRef    = useRef<UbicGps | null>(null);
  const prevUbicRef = useRef<{ lat: number; lng: number } | null>(null);

  const [ubic,           setUbic]           = useState<UbicGps | null>(null);
  const [errorMapa,      setErrorMapa]      = useState(false);
  const [ultimaActualiz, setUltimaActualiz] = useState<Date | null>(null);
  const [sinSenal,       setSinSenal]       = useState(false);
  const [mapListo,       setMapListo]       = useState(false);
  const [ruta,              setRuta]              = useState<RutaData | null>(null);
  const [cargandoRuta,      setCargandoRuta]      = useState(false);
  const [errorRuta,         setErrorRuta]         = useState<string | null>(null);
  const [paradasResueltas,  setParadasResueltas]  = useState<Parada[]>([]);
  const [huella,            setHuella]            = useState<{lat:number;lng:number;velocidad:number}[]>([]);
  const [matchedCoords,     setMatchedCoords]     = useState<[number, number][] | null>(null);
  const stopMarkersRef = useRef<any[]>([]);
  // ETA dinámica: posición actual del vehículo → próxima parada (Google Directions)
  const [etaMin, setEtaMin] = useState<number | null>(null);
  const [etaKm,  setEtaKm]  = useState<number | null>(null);
  // Control de cámara: si el usuario arrastra el mapa, dejamos de recentrar al vehículo
  const [mapDescentrado, setMapDescentrado] = useState(false);
  const mapDescentradoRef = useRef(false);

  // ── Geocodificación auxiliar (server-side vía /api/geocodificar) ─────────

  const geocodificarParadas = useCallback(async (lista: Parada[]): Promise<Parada[]> => {
    const sinCoords = lista.filter(p => !p.lat || !p.lng);
    if (sinCoords.length === 0) return lista;

    try {
      const res = await fetch("/api/geocodificar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paradas: sinCoords.map(p => ({ id: p.id, nombre: p.nombre })) }),
      });

      const data = await res.json();
      console.log("[ModalGps] geocodificar result:", data);

      if (!res.ok || !data.paradas) {
        console.error("[ModalGps] geocodificar error:", data.error);
        return lista;
      }

      // Mezclar coordenadas obtenidas en la lista original
      const coordsMap = new Map<number, { lat: number | null; lng: number | null }>(
        data.paradas.map((p: any) => [p.id, { lat: p.lat, lng: p.lng }])
      );
      return lista.map(p => {
        const coords = coordsMap.get(p.id);
        return coords ? { ...p, lat: coords.lat, lng: coords.lng } : p;
      });
    } catch (e: any) {
      console.error("[ModalGps] geocodificar fetch error:", e.message);
      return lista;
    }
  }, []); // eslint-disable-line

  // ── Ruta real de Google via /api/ruta ──────────────────────────────────────

  const cargarRuta = useCallback(async () => {
    let listaParadas = [...paradas].sort((a, b) => a.orden - b.orden);

    // Rellenar coords faltantes (o construir lista) desde paradas_json de la cotización
    if (paradasJson && paradasJson.length > 0) {
      const byNombre = new Map<string, { lat: number; lng: number }>();
      paradasJson.forEach((p: any) => {
        if (p.lat && p.lng) byNombre.set(String(p.nombre || "").trim().toLowerCase(), { lat: Number(p.lat), lng: Number(p.lng) });
      });
      if (listaParadas.length > 0) {
        listaParadas = listaParadas.map(p => {
          if (!p.lat || !p.lng) {
            const coords = byNombre.get(String(p.nombre || "").trim().toLowerCase());
            if (coords) return { ...p, lat: coords.lat, lng: coords.lng };
          }
          return p;
        });
      } else {
        listaParadas = (paradasJson as any[])
          .filter((p: any) => p.nombre)
          .map((p: any, i: number) => ({
            id: -(i + 1), nombre: p.nombre,
            lat: p.lat ? Number(p.lat) : null, lng: p.lng ? Number(p.lng) : null,
            hora_estimada: p.hora || null, estado: "pendiente", orden: i + 1,
          }));
      }
    }

    // Sin paradas: intentar con origen/destino de la reserva como fallback
    if (listaParadas.length === 0) {
      if (origen && destino) {
        listaParadas = [
          { id: -1, nombre: origen,  lat: null, lng: null, hora_estimada: null, estado: "pendiente", orden: 1 },
          { id: -2, nombre: destino, lat: null, lng: null, hora_estimada: null, estado: "pendiente", orden: 2 },
        ];
      } else {
        setErrorRuta("Esta reserva no tiene paradas configuradas — agrégalas en Programación");
        return;
      }
    }

    // Si alguna parada no tiene coordenadas, geocodificar antes de calcular ruta
    const sinCoords = listaParadas.filter(p => !p.lat || !p.lng);
    if (sinCoords.length > 0) {
      setCargandoRuta(true);
      listaParadas = await geocodificarParadas(listaParadas);
    }

    const paradasConCoords = listaParadas.filter(p => p.lat !== null && p.lng !== null);

    if (paradasConCoords.length < 2) {
      setErrorRuta(
        sinCoords.length > 0
          ? `No se pudo geocodificar ${sinCoords.length} parada(s) — verifica los nombres o agrégalas manualmente en Programación`
          : "Las paradas no tienen coordenadas — agrégalas en Programación"
      );
      return;
    }

    // Verificar que origen y destino no sean el mismo punto
    const orig = paradasConCoords[0];
    const dest = paradasConCoords[paradasConCoords.length - 1];
    if (orig.lat === dest.lat && orig.lng === dest.lng) {
      setErrorRuta("Origen y destino tienen las mismas coordenadas — verifica las paradas en Programación");
      return;
    }

    setCargandoRuta(true);
    setErrorRuta(null);

    try {
      const res = await fetch("/api/ruta", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paradas: paradasConCoords.map(p => ({
            lat:    typeof p.lat === "string" ? parseFloat(p.lat as any) : p.lat,
            lng:    typeof p.lng === "string" ? parseFloat(p.lng as any) : p.lng,
            nombre: p.nombre,
          })),
        }),
      });

      const text = await res.text();
      if (!text || text.trim() === "") {
        setErrorRuta("API /api/ruta no encontrada — verificar app/api/ruta/route.ts");
        return;
      }

      let data: any;
      try { data = JSON.parse(text); }
      catch { setErrorRuta("Respuesta inválida de /api/ruta"); return; }

      console.log("[ModalGps] Respuesta /api/ruta:", data);

      if (!res.ok) {
        setErrorRuta(data.error || `Error ${res.status}`);
        return;
      }

      if (!data.coordenadas || !Array.isArray(data.coordenadas) || data.coordenadas.length === 0) {
        setErrorRuta("Google no devolvió coordenadas de ruta");
        return;
      }

      if (!data.tramos || !Array.isArray(data.tramos)) {
        data.tramos = [];
      }

      setRuta(data as RutaData);
      setParadasResueltas(paradasConCoords);
    } catch (e: any) {
      console.error("[ModalGps] Error fetch:", e);
      setErrorRuta("No se pudo conectar con /api/ruta: " + e.message);
    } finally {
      setCargandoRuta(false);
    }
  }, [paradas, paradasJson, origen, destino, geocodificarParadas]); // eslint-disable-line

  useEffect(() => { cargarRuta(); }, [cargarRuta]);

  // ── Dibujar ruta en Mapbox ────────────────────────────────────────────────

  useEffect(() => {
    if (!ruta || !mapListo || !mapInst.current) return;
    if (!ruta.coordenadas || ruta.coordenadas.length === 0) return;
    const map = mapInst.current;

    try {
      ["ruta-sombra", "ruta-line"].forEach(id => { if (map.getLayer(id)) map.removeLayer(id); });
      if (map.getSource("ruta-google")) map.removeSource("ruta-google");

      map.addSource("ruta-google", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: ruta.coordenadas } },
      });
      map.addLayer({
        id: "ruta-sombra", type: "line", source: "ruta-google",
        paint: { "line-color": "#0b315f", "line-width": 10, "line-opacity": 0.1, "line-blur": 5 },
      });
      map.addLayer({
        id: "ruta-line", type: "line", source: "ruta-google",
        paint: { "line-color": "#1d4ed8", "line-width": 4, "line-opacity": 0.85, "line-dasharray": [2, 1.6] },
      });

      const bounds = ruta.coordenadas.reduce(
        (b, c) => b.extend(c as [number, number]),
        new window.mapboxgl.LngLatBounds(ruta.coordenadas[0], ruta.coordenadas[0])
      );
      map.fitBounds(bounds, { padding: { top: 60, bottom: 60, left: 60, right: 280 }, maxZoom: 15 });
    } catch (e) {
      console.error("[ModalGps] Error dibujando ruta:", e);
    }
  }, [ruta, mapListo]);

  // ── CAPA 2: Cargar historial GPS (huella) ─────────────────────────────────

  useEffect(() => {
    let cancel = false;
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";
    const ajustador = crearAjustadorHuella(); // estado de ventanas/congelado por apertura del modal
    const cargar = async () => {
      try {
        const res = await fetch("/api/cliente/gps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ huella: true, reservaId, vehiculoId, vehiculoTerceroId }),
        });
        const json = await res.json();
        const arr = Array.isArray(json?.huella) ? json.huella : [];
        if (cancel || arr.length === 0) return;

        // Limpiar UNA sola vez (colapsa rachas detenidas + dedup en marcha). El mismo set
        // limpio alimenta el dibujo (setHuella) y el ajuste por ventanas → coherentes.
        const limpio = limpiarHuella(filasAPuntos(arr));
        setHuella(limpio.map(p => ({ lat: p.lat, lng: p.lng, velocidad: p.velocidad })));

        // Map Matching por ventanas (lib/huella.ts): throttle 60 s + congelado interno.
        const matched = await ajustador.ajustar(limpio, token, () => cancel);
        if (matched && !cancel) setMatchedCoords(matched);
      } catch { /* conservar estela previa */ }
    };
    cargar();
    const iv = setInterval(cargar, 15000);
    return () => { cancel = true; clearInterval(iv); };
  }, [reservaId, vehiculoId, vehiculoTerceroId]); // eslint-disable-line

  // ── CAPA 2: Dibujar huella GPS (ajustada a carretera si hay Map Matching) ───

  useEffect(() => {
    if (!mapListo || !mapInst.current) return;
    if (!matchedCoords && huella.length < 2) return;
    const map = mapInst.current;
    try {
      if (map.getLayer("huella-gps-line")) map.removeLayer("huella-gps-line");
      if (map.getSource("huella-gps"))    map.removeSource("huella-gps");

      // Con Map Matching: geometría pegada a la vía, coloreada por velocidad (leyenda).
      // Sin él (aún cargando o rechazado por baja confianza, p. ej. GPS de torre): huella cruda
      // suavizada por tramos (corta teleports/huecos, no recta cruzando el mapa). lib/huella.ts.
      const features = (matchedCoords && matchedCoords.length >= 2)
        ? colorearMatched(matchedCoords, huella)
        : huellaCrudaFeatures(huella);

      map.addSource("huella-gps", { type: "geojson", data: { type: "FeatureCollection", features } });
      map.addLayer({
        id: "huella-gps-line", type: "line", source: "huella-gps",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-width": 5, "line-opacity": 0.9,
          "line-color": ["interpolate", ["linear"], ["get", "velocidad"], 0, "#dc2626", 15, "#f59e0b", 35, "#eab308", 55, "#16a34a"],
        },
      });
    } catch (e) { console.error("[ModalGps] Error dibujando huella GPS:", e); }
  }, [huella, matchedCoords, mapListo]);

  // ── Marcadores numerados con etiqueta de texto ────────────────────────────

  useEffect(() => {
    if (!mapListo || !mapInst.current || paradasResueltas.length === 0) return;
    if (!window.mapboxgl) return;

    // Limpiar marcadores anteriores
    stopMarkersRef.current.forEach(m => m.remove());
    stopMarkersRef.current = [];

    const total = paradasResueltas.length;

    paradasResueltas.forEach((p, i) => {
      const lat = typeof p.lat === "string" ? parseFloat(p.lat as any) : p.lat!;
      const lng = typeof p.lng === "string" ? parseFloat(p.lng as any) : p.lng!;

      const isFirst    = i === 0;
      const isLast     = i === total - 1;
      const completada = p.estado === "completada";

      const bg  = completada ? "#16a34a" : isFirst ? "#16a34a" : isLast ? "#dc2626" : "#0b315f";
      const tag = isFirst ? "ORIGEN" : isLast ? "DESTINO" : `PARADA ${i + 1}`;
      const num = completada ? "✓" : String(i + 1);

      // wrapper: ancla de Mapbox — NO aplicar transform aquí (conflicto con translate de Mapbox)
      const wrapper = document.createElement("div");
      wrapper.style.cssText = "width:34px;height:34px;cursor:pointer";

      // circle: elemento visual hijo — el hover scale va aquí, no en wrapper
      const circle = document.createElement("div");
      circle.style.cssText = `width:34px;height:34px;border-radius:50%;background:${bg};border:3px solid white;box-shadow:0 3px 12px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;color:white;font-size:13px;font-weight:900;transition:transform 0.15s`;
      circle.textContent = num;
      circle.onmouseenter = () => { circle.style.transform = "scale(1.15)"; };
      circle.onmouseleave = () => { circle.style.transform = ""; };
      wrapper.appendChild(circle);

      const popup = new window.mapboxgl.Popup({ offset: [0, -20], closeButton: false })
        .setHTML(`
          <div style="font-family:system-ui;padding:6px 2px;min-width:160px">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
              <div style="width:22px;height:22px;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;color:white;font-size:10px;font-weight:900;flex-shrink:0">${num}</div>
              <p style="font-weight:900;margin:0;color:#0b315f;font-size:13px;line-height:1.2">${p.nombre}</p>
            </div>
            <p style="margin:2px 0 0;color:${bg};font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">${tag}</p>
            ${p.hora_estimada ? `<p style="margin:4px 0 0;color:#64748b;font-size:11px">⏰ ${p.hora_estimada.slice(0, 5)}</p>` : ""}
            ${completada ? `<p style="margin:4px 0 0;color:#16a34a;font-weight:700;font-size:11px">✓ Completada</p>` : ""}
          </div>`);

      const marker = new window.mapboxgl.Marker({ element: wrapper, anchor: "center" })
        .setLngLat([lng, lat])
        .setPopup(popup)
        .addTo(mapInst.current);

      stopMarkersRef.current.push(marker);
    });
  }, [paradasResueltas, mapListo]);

  // ── GPS: última posición ──────────────────────────────────────────────────

  // Lee la última posición vía endpoint service_role (sin RLS) — igual que /seguimiento.
  // Así el GPS aparece al instante al abrir el modal, sin esperar el primer realtime.
  const cargarUbicacion = useCallback(async () => {
    try {
      const res = await fetch("/api/cliente/gps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservaId, vehiculoId, vehiculoTerceroId }),
      });
      const json = await res.json();
      const d = (json?.ubicacion ?? null) as UbicGps | null;
      if (d) {
        ubicRef.current = d;
        setUbic(d); setUltimaActualiz(new Date());
        const fechaRef = d.created_at || d.timestamp;
        setSinSenal(!fechaRef || (Date.now() - new Date(fechaRef).getTime()) / 1000 > 60);
      } else if (!ubicRef.current) {
        // Sin datos y sin nada previo (ni realtime): recién ahí marcamos sin señal.
        setSinSenal(true);
      }
    } catch {
      // Error de red: conservar lo que ya se mostraba, no marcar sin señal.
    }
  }, [reservaId, vehiculoId, vehiculoTerceroId]);

  // Carga inicial inmediata + reintento corto cada 10s como red de seguridad
  // (por si se pierde un evento realtime o el conductor reconecta).
  useEffect(() => {
    cargarUbicacion();
    const iv = setInterval(cargarUbicacion, 10000);
    return () => clearInterval(iv);
  }, [cargarUbicacion]);

  // Realtime
  useEffect(() => {
    const ch = supabase.channel("modal-gps-" + reservaId)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_gps" }, (payload: any) => {
        const d = payload.new as any;
        // Solo aceptar puntos del vehículo correcto. Cada condición exige id NO nulo:
        // así un servicio tercerizado (vehiculoId null) ya no engancha la señal de OTRO
        // bus que también tenga vehiculo_id null.
        const match =
          (vehiculoTerceroId != null && d.vehiculo_tercero_id === vehiculoTerceroId) ||
          (vehiculoId != null && d.vehiculo_id === vehiculoId) ||
          (vehiculoTerceroId == null && vehiculoId == null && reservaId != null && d.reserva_id === reservaId);
        if (!match) return;
        const nueva: UbicGps = {
          lat: d.lat, lng: d.lng, velocidad: d.velocidad, rumbo: d.rumbo,
          precision_m: d.precision_m, estado: d.estado,
          created_at: d.created_at ?? null, timestamp: d.timestamp ?? null,
        };
        ubicRef.current = nueva;
        setUbic(nueva);
        setUltimaActualiz(new Date()); setSinSenal(false);
      }).subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [reservaId, vehiculoId, vehiculoTerceroId]);

  // ── Marcador del bus ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!ubic || !mapListo || !mapInst.current) return;
    const lngLat: [number, number] = [ubic.lng, ubic.lat];
    // Heading: usar rumbo del GPS si es válido (>0). Si no (detenido o sensor sin dato),
    // calcular desde el desplazamiento respecto al punto anterior.
    const rawRumbo = Number(ubic.rumbo);
    const rot = rawRumbo > 0
      ? rawRumbo
      : (prevUbicRef.current && (ubic.lat !== prevUbicRef.current.lat || ubic.lng !== prevUbicRef.current.lng))
          ? calcBearing(prevUbicRef.current.lat, prevUbicRef.current.lng, ubic.lat, ubic.lng)
          : rawRumbo;
    prevUbicRef.current = { lat: ubic.lat, lng: ubic.lng };
    // Color del pulso según antigüedad de la señal (igual que el mapa "En vivo").
    const fechaRef = ubic.created_at || ubic.timestamp;
    const edadS = fechaRef ? (Date.now() - new Date(fechaRef).getTime()) / 1000 : 9999;
    const color = edadS <= 60 ? "#16a34a" : edadS <= 600 ? "#d97706" : "#dc2626";

    if (markerRef.current) {
      markerRef.current.setLngLat(lngLat);
      markerRef.current.setRotation(rot);
      // Mantener el color del pulso en sync con el estado de señal.
      const elc = markerRef.current.getElement();
      const p1 = elc?.querySelector(".afa-pulse1") as HTMLElement | null;
      const p2 = elc?.querySelector(".afa-pulse2") as HTMLElement | null;
      if (p1) p1.style.background = color;
      if (p2) p2.style.background = color;
      // Recentrar suave SOLO si el usuario no arrastró el mapa manualmente.
      if (!mapDescentradoRef.current) mapInst.current.easeTo({ center: lngLat, duration: 1500 });
    } else if (window.mapboxgl) {
      // CSS de los anillos de pulso (igual que /seguimiento y "En vivo"), una sola vez.
      if (!document.getElementById("afa-bus-css")) {
        const s = document.createElement("style");
        s.id = "afa-bus-css";
        s.textContent = `
          @keyframes afaBusPulse  { 0%{transform:scale(1);opacity:.5} 65%{transform:scale(2.6);opacity:0} 100%{transform:scale(2.6);opacity:0} }
          @keyframes afaBusPulse2 { 0%{transform:scale(1);opacity:.3} 65%{transform:scale(2.6);opacity:0} 100%{transform:scale(2.6);opacity:0} }
          .afa-pulse1 { position:absolute; border-radius:50%; animation:afaBusPulse  2s ease-out infinite; pointer-events:none; }
          .afa-pulse2 { position:absolute; border-radius:50%; animation:afaBusPulse2 2s ease-out .7s infinite; pointer-events:none; }
        `;
        document.head.appendChild(s);
      }
      // Contenedor CUADRADO (80x80) con la imagen centrada: la rotación por rumbo
      // pivota en el centro exacto y el ícono no se desplaza al hacer zoom.
      const el = document.createElement("div");
      el.style.cssText = "position:relative;width:80px;height:80px;cursor:pointer;";
      el.innerHTML = `
        <div style="position:absolute;top:50%;left:50%;width:46px;height:46px;margin:-23px 0 0 -23px;">
          <div class="afa-pulse1" style="inset:0;background:${color};"></div>
          <div class="afa-pulse2" style="inset:0;background:${color};"></div>
        </div>
        <img src="/bussinfondo3.png"
          style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2;width:48px;height:80px;object-fit:contain;filter:drop-shadow(0 5px 14px rgba(6,14,40,.85));"
          alt="bus"/>
      `;
      markerRef.current = new window.mapboxgl.Marker({
        element: el, rotation: rot, rotationAlignment: "map", anchor: "center",
      })
        .setLngLat(lngLat)
        .setPopup(new window.mapboxgl.Popup({ offset: 28, closeButton: false }).setHTML(
          `<div style="font-family:system-ui;padding:4px">
            <p style="font-weight:900;margin:0;color:#0b315f;font-size:15px">${vehiculoPlaca}</p>
            <p style="margin:4px 0 0;color:#475569;font-size:12px">${conductorNombre}</p>
            <p style="margin:6px 0 0;color:#16a34a;font-weight:700;font-size:16px">${ubic.velocidad} km/h</p>
          </div>`
        )).addTo(mapInst.current);
      // Primera vez: salto directo al vehículo (como /seguimiento), no animación lenta desde Lima.
      mapInst.current.flyTo({ center: lngLat, zoom: 15, duration: 900 });
    }
  }, [ubic, mapListo, vehiculoPlaca, conductorNombre]);

  // ── Init Mapbox ───────────────────────────────────────────────────────────

  useEffect(() => {
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) { setErrorMapa(true); return; }
    if (!mapRef.current) return;

    const initMap = () => {
      if (mapInst.current || !mapRef.current) return;
      try {
        window.mapboxgl.accessToken = token;
        const map = new window.mapboxgl.Map({
          container: mapRef.current, style: "mapbox://styles/mapbox/streets-v12",
          center: [-77.0428, -12.0464], zoom: 12,
        });
        map.addControl(new window.mapboxgl.NavigationControl(), "top-right");
        mapInst.current = map;

        // Si el usuario arrastra el mapa, dejamos de seguir al vehículo y mostramos
        // el botón "Centrar vehículo". e.originalEvent distingue el arrastre humano
        // del easeTo/flyTo programático.
        map.on("dragstart", (e: any) => { if (e.originalEvent) { mapDescentradoRef.current = true; setMapDescentrado(true); } });

        // El contenedor del modal puede seguir dimensionándose al abrir: forzar resize
        // evita que el mapa salga gris o cortado.
        setTimeout(() => { try { map.resize(); } catch {} }, 150);
        setTimeout(() => { try { map.resize(); } catch {} }, 450);

        // Sin capa de tráfico: tapaba demasiado el mapa.
        map.on("load", () => {
          setMapListo(true);
        });
      } catch (e) { console.error("[ModalGps]", e); setErrorMapa(true); }
    };

    if (window.mapboxgl) { initMap(); return; }
    if (!document.getElementById("mapboxgl-css")) {
      const link = document.createElement("link"); link.id = "mapboxgl-css"; link.rel = "stylesheet";
      link.href = "https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css"; document.head.appendChild(link);
    }
    if (!document.getElementById("mapboxgl-js")) {
      const s = document.createElement("script"); s.id = "mapboxgl-js";
      s.src = "https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js";
      s.onload = initMap; s.onerror = () => setErrorMapa(true); document.head.appendChild(s);
    } else {
      const t = setInterval(() => { if (window.mapboxgl) { clearInterval(t); initMap(); } }, 100);
      setTimeout(() => clearInterval(t), 10000);
    }
    return () => { if (mapInst.current) { mapInst.current.remove(); mapInst.current = null; } markerRef.current = null; };
  }, []); // eslint-disable-line

  // ── Derivados ─────────────────────────────────────────────────────────────

  const paradasDisplay = paradas.length > 0 ? paradas : paradasResueltas;
  const proximaParada  = paradasDisplay.find(p => p.estado !== "completada");
  const paradasComp    = paradas.filter(p => p.estado === "completada").length;
  const pct            = paradas.length > 0 ? Math.round((paradasComp / paradas.length) * 100) : 0;
  // "hace Ns" = antigüedad del FIX GPS real (created_at del punto), NO del último fetch.
  // Antes usaba ultimaActualiz (momento del poll), que se reinicia a 0 cada 10 s aunque el
  // punto esté congelado → mostraba "hace 3s" con el bus parado hace 1 min. Ahora coincide
  // con sinSenal (>60s) y con el color del pulso (edad del punto).
  const fechaPunto    = ubic ? (ubic.created_at || ubic.timestamp) : null;
  const segsDesdeUlt  = fechaPunto ? Math.floor((Date.now() - new Date(fechaPunto).getTime()) / 1000) : null;
  const hayTrafico    = ruta?.tramos?.some(t => t.duracion_trafico_min > t.duracion_min + 2) ?? false;

  // ── ETA dinámica: posición actual del vehículo → próxima parada ────────────
  // Igual que /seguimiento: Google Directions vía /api/ruta. Recalcula cada 60s
  // (y al cambiar de parada o al llegar la primera señal), no en cada poll GPS.
  useEffect(() => {
    let cancel = false;
    const calcular = async () => {
      const lista = paradas.length > 0 ? paradas : paradasResueltas;
      const prox = lista.find(p => p.estado !== "completada");
      const u = ubicRef.current;
      if (!prox || !u) { if (!cancel) { setEtaMin(null); setEtaKm(null); } return; }
      // La próxima parada puede venir sin coords en `paradas`: resolverlas desde paradasResueltas.
      let plat = prox.lat, plng = prox.lng;
      if (plat == null || plng == null) {
        const r = paradasResueltas.find(x => x.id === prox.id || x.nombre === prox.nombre);
        if (r) { plat = r.lat; plng = r.lng; }
      }
      if (plat == null || plng == null) { if (!cancel) { setEtaMin(null); setEtaKm(null); } return; }
      try {
        const res = await fetch("/api/ruta", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paradas: [
            { lat: u.lat, lng: u.lng, nombre: "Vehículo" },
            { lat: Number(plat), lng: Number(plng), nombre: prox.nombre },
          ] }),
        });
        const data = await res.json();
        if (!cancel && res.ok && data) {
          setEtaMin(typeof data.total_min === "number" ? data.total_min : null);
          setEtaKm(typeof data.total_km === "number" ? data.total_km : null);
        }
      } catch { /* conservar ETA previa */ }
    };
    calcular();
    const iv = setInterval(calcular, 60000);
    return () => { cancel = true; clearInterval(iv); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proximaParada?.id, proximaParada?.nombre, !!ubic, paradasResueltas]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 md:p-4" style={{ background: "rgba(15,23,42,0.65)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl flex flex-col overflow-hidden" style={{ height: "90vh" }}>

        {/* HEADER */}
        <div className="flex-shrink-0 px-5 py-3 flex items-center justify-between gap-3 flex-wrap" style={{ background: "#0b315f" }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center text-lg">🗺️</div>
            <div>
              <p className="text-white font-black text-sm">{clienteNombre} · Reserva #{reservaId}</p>
              <div className="flex items-center gap-2 flex-wrap">
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${sinSenal ? "bg-red-400" : "bg-green-400 animate-pulse"}`} />
                <p className="text-blue-200 text-[11px]">
                  {sinSenal ? "Sin señal GPS" : ultimaActualiz ? `GPS en vivo · hace ${segsDesdeUlt}s` : "Conectando..."}
                </p>
                {ruta && (
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${hayTrafico ? "bg-orange-500 text-white" : "bg-green-600 text-white"}`}>
                    {hayTrafico ? `⚠ Tráfico · ${ruta.total_min} min` : `✓ Ruta libre · ${ruta.total_min} min`}
                  </span>
                )}
                {cargandoRuta && <span className="text-[10px] text-blue-300">Calculando ruta...</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className={`px-4 py-1.5 rounded-xl text-center min-w-[56px] ${!ubic || ubic.velocidad === 0 ? "bg-white/10" : ubic.velocidad > 80 ? "bg-red-500" : "bg-green-600"}`}>
              <p className="text-white font-black text-xl leading-none">{ubic?.velocidad ?? "—"}</p>
              <p className="text-white/60 text-[9px] font-bold">km/h</p>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center text-white text-xl transition-colors">✕</button>
          </div>
        </div>

        {/* CONTENIDO */}
        <div className="flex-1 flex overflow-hidden">

          {/* MAPA */}
          <div className="flex-1 relative min-h-0">
            {errorMapa ? (
              <div className="w-full h-full flex items-center justify-center bg-gray-100">
                <div className="text-center px-6">
                  <p className="text-5xl mb-3">🗺️</p>
                  <p className="font-bold text-gray-700 mb-2">Mapa no disponible</p>
                  <p className="text-sm text-gray-500">Verificar NEXT_PUBLIC_MAPBOX_TOKEN</p>
                </div>
              </div>
            ) : (
              <div ref={mapRef} className="w-full h-full" />
            )}

            {ubic && !errorMapa && (
              <div className="absolute top-3 left-3 bg-[#0b315f]/90 backdrop-blur-sm rounded-2xl px-4 py-3 shadow-xl text-center pointer-events-none">
                <p className="text-white font-black text-4xl leading-none">{ubic.velocidad}</p>
                <p className="text-blue-200 text-[10px] font-bold mt-0.5">km/h</p>
                {ubic.precision_m && <p className="text-blue-300 text-[9px] mt-1">±{Math.round(ubic.precision_m)}m</p>}
              </div>
            )}

            {errorRuta && !errorMapa && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-amber-500/90 backdrop-blur-sm rounded-xl px-4 py-2 shadow-lg max-w-md text-center">
                <p className="text-white text-xs font-bold">⚠ {errorRuta}</p>
              </div>
            )}

            {sinSenal && !errorMapa && !errorRuta && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-red-600/90 backdrop-blur-sm rounded-xl px-3 py-2 shadow-lg pointer-events-none">
                <p className="text-white text-xs font-bold">📡 Sin señal GPS del conductor</p>
              </div>
            )}

            {!errorMapa && huella.length > 1 && (
              <div className="absolute bottom-3 left-3 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg px-3 py-2">
                <p className="text-[8px] font-bold text-gray-400 uppercase mb-1">Huella GPS · Velocidad</p>
                <div className="flex items-center gap-2 text-[9px] font-bold text-gray-600">
                  <span className="flex items-center gap-1"><span className="w-5 h-1.5 rounded bg-red-500 inline-block"/>Parado</span>
                  <span className="flex items-center gap-1"><span className="w-5 h-1.5 rounded bg-amber-400 inline-block"/>Lento</span>
                  <span className="flex items-center gap-1"><span className="w-5 h-1.5 rounded bg-yellow-300 inline-block"/>Moderado</span>
                  <span className="flex items-center gap-1"><span className="w-5 h-1.5 rounded bg-green-500 inline-block"/>Rápido</span>
                </div>
              </div>
            )}

            {mapDescentrado && ubic && !errorMapa && (
              <button
                onClick={() => {
                  if (mapInst.current && ubic) {
                    mapDescentradoRef.current = false;
                    setMapDescentrado(false);
                    mapInst.current.easeTo({ center: [ubic.lng, ubic.lat], zoom: 15, duration: 800 });
                  }
                }}
                className="absolute bottom-5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 px-4 py-2 rounded-full text-white text-sm font-semibold shadow-lg"
                style={{ background: "#0b315f" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3"/>
                  <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/>
                  <line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
                </svg>
                Centrar vehículo
              </button>
            )}
          </div>

          {/* PANEL DERECHO */}
          <div className="w-64 flex-shrink-0 overflow-y-auto p-3 space-y-3" style={{ background: "#f8fafc", borderLeft: "1px solid #e2e8f0" }}>

            {proximaParada && (
              <div className="rounded-xl p-4 text-white" style={{ background: "linear-gradient(135deg, #0b315f 0%, #1d4ed8 100%)" }}>
                <p className="text-[10px] font-bold uppercase tracking-wider opacity-80 mb-1">
                  {proximaParada.id === paradasDisplay[0]?.id ? "Vehículo en camino a"
                    : proximaParada.id === paradasDisplay[paradasDisplay.length - 1]?.id ? "Destino final"
                    : "Próxima parada"}
                </p>
                <p className="text-lg font-bold leading-tight mb-2">{proximaParada.nombre}</p>
                <div className="flex items-center gap-3 pt-2 border-t border-white/20">
                  {etaMin != null ? (
                    <>
                      <div className="flex-1">
                        <p className="text-[10px] uppercase opacity-70">Llega a las</p>
                        <p className="text-xl font-bold leading-tight">{fmtHoraLlegada(etaMin)}</p>
                        <p className="text-[11px] opacity-60 mt-0.5">en {fmtTiempo(etaMin)}</p>
                      </div>
                      {etaKm != null && (
                        <div className="text-right">
                          <p className="text-[10px] uppercase opacity-70">Distancia</p>
                          <p className="text-base font-bold">{etaKm < 1 ? fmtDistancia(etaKm * 1000) : `${etaKm.toFixed(1)} km`}</p>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="text-sm opacity-80">Calculando tiempo estimado…</p>
                  )}
                </div>
              </div>
            )}

            <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-2">Conductor</p>
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl bg-[#0b315f] flex items-center justify-center text-white font-black text-lg flex-shrink-0">
                  {conductorNombre.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-gray-900 font-bold text-sm truncate">{conductorNombre}</p>
                  {conductorTel
                    ? <a href={`tel:${conductorTel}`} className="text-green-600 text-[11px] font-bold">{conductorTel}</a>
                    : <p className="text-gray-400 text-[10px]">Sin teléfono</p>}
                </div>
              </div>
            </div>

            <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">Vehículo</p>
              <p className="text-[#0b315f] font-black text-2xl font-mono tracking-widest">{vehiculoPlaca}</p>
            </div>

            <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">Velocidad real</p>
              <div className="flex items-end gap-1">
                <p className="font-black text-3xl leading-none" style={{ color: !ubic ? "#94a3b8" : ubic.velocidad > 80 ? "#dc2626" : ubic.velocidad > 0 ? "#16a34a" : "#0b315f" }}>
                  {ubic?.velocidad ?? "—"}
                </p>
                <p className="text-gray-400 text-sm mb-0.5">km/h</p>
              </div>
              <p className="text-[9px] text-gray-400 mt-1">GPS real del conductor</p>
            </div>

            {ruta && (
              <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
                <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-2">Ruta · Google Maps</p>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <div className="bg-gray-50 rounded-lg px-2 py-1.5 text-center">
                    <p className="text-[#0b315f] font-black text-lg leading-none">{ruta.total_km}</p>
                    <p className="text-gray-400 text-[9px] font-bold">km totales</p>
                  </div>
                  <div className={`rounded-lg px-2 py-1.5 text-center ${hayTrafico ? "bg-orange-50" : "bg-green-50"}`}>
                    <p className={`font-black text-lg leading-none ${hayTrafico ? "text-orange-600" : "text-green-600"}`}>{ruta.total_min}</p>
                    <p className={`text-[9px] font-bold ${hayTrafico ? "text-orange-400" : "text-green-400"}`}>min c/tráfico</p>
                  </div>
                </div>
                {ruta.advertencia && (
                  <div className="bg-orange-50 border border-orange-200 rounded-lg px-2 py-1.5 mb-2">
                    <p className="text-orange-600 text-[10px] font-bold">{ruta.advertencia}</p>
                  </div>
                )}
                {ruta.tramos && ruta.tramos.length > 0 && (
                  <div className="space-y-2">
                    {ruta.tramos.map((t, i) => {
                      const conTrafico = t.duracion_trafico_min > t.duracion_min + 2;
                      return (
                        <div key={i} className="border-t pt-2 first:border-t-0 first:pt-0">
                          <div className="flex justify-between items-start gap-1 mb-0.5">
                            <p className="text-[10px] text-gray-600 font-medium leading-tight flex-1 truncate">{t.desde} → {t.hasta}</p>
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ml-1 ${conTrafico ? "bg-orange-100 text-orange-600" : "bg-green-100 text-green-600"}`}>
                              {t.duracion_texto}
                            </span>
                          </div>
                          <p className="text-[9px] text-gray-400">{t.distancia_km} km</p>
                        </div>
                      );
                    })}
                  </div>
                )}
                <button onClick={cargarRuta} disabled={cargandoRuta}
                  className="w-full mt-3 py-1.5 rounded-lg text-[10px] font-bold text-[#0b315f] bg-blue-50 hover:bg-blue-100 transition-colors disabled:opacity-50">
                  {cargandoRuta ? "Actualizando..." : "🔄 Recalcular con tráfico actual"}
                </button>
              </div>
            )}

            <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
              <div className="flex justify-between mb-2">
                <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400">Itinerario</p>
                <p className="text-[9px] font-bold text-[#0b315f]">{paradasComp}/{paradasDisplay.length} · {pct}%</p>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden mb-3">
                <div className="h-full rounded-full bg-[#0b315f] transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="space-y-1.5">
                {paradasDisplay.map((p, i) => (
                  <div key={p.id} className="flex items-center gap-1.5">
                    <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black flex-shrink-0 text-white ${p.estado === "completada" ? "bg-green-500" : i === 0 ? "bg-green-600" : i === paradasDisplay.length - 1 ? "bg-red-500" : "bg-[#0b315f]"}`}>
                      {p.estado === "completada" ? "✓" : i + 1}
                    </div>
                    <span className={`flex-1 truncate text-xs ${p.estado === "completada" ? "text-green-600 line-through" : "text-gray-700 font-medium"}`}>{p.nombre}</span>
                    {p.hora_estimada && <span className="text-gray-400 font-mono text-[9px] flex-shrink-0">{p.hora_estimada.slice(0,5)}</span>}
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-2">Señal GPS</p>
              <div className={`flex items-center gap-2 px-3 py-2 rounded-lg mb-2 ${sinSenal ? "bg-red-50" : "bg-green-50"}`}>
                <div className={`w-2 h-2 rounded-full flex-shrink-0 ${sinSenal ? "bg-red-500" : "bg-green-500 animate-pulse"}`} />
                <p className={`text-xs font-bold ${sinSenal ? "text-red-600" : "text-green-700"}`}>{sinSenal ? "Sin señal" : "En vivo"}</p>
              </div>
              {ultimaActualiz && <p className="text-[9px] text-gray-400">Última señal: {ultimaActualiz.toLocaleTimeString("es-PE")}</p>}
              <p className="text-[9px] text-gray-400 mt-1">Actualiza cada 10 segundos</p>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}