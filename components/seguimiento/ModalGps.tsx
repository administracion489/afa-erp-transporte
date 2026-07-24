"use client";

// ModalGps.tsx — Mapbox base + Google Directions ruta real + tráfico
// Protegido contra: coordenadas string, respuestas vacías, campos undefined

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  calcBearing, distM, limpiarHuella, colorearMatched, colaViva,
  crearAjustadorHuella, filasAPuntos, huellaCrudaFeatures, velocidadPorVentana, conVelocidadColor,
  puntosTelemetria, type PuntoTelemetria, resumenViaje, type ResumenViaje,
  calcularPuentes, decidirPuente, validarPuente, anclarImprecisos, puentePorRuta, puentesCrudos,
  pegarIconoAVia, viasCercanasTilequery, esAccCruda, MAX_SEG_M,
} from "@/lib/huella";
import { animarMarcador } from "@/lib/anim-marker";

declare global { interface Window { mapboxgl: any; } }

type UbicGps = {
  lat: number; lng: number; velocidad: number; rumbo: number;
  precision_m: number; estado: string;
  created_at: string | null; timestamp: string | null;
  fix_ts?: string | null; // hora del último fix real (detección robusta de "congelado")
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
// Rumbo en grados → punto cardinal (para el popup de los puntitos de telemetría).
const rumboCardinal = (deg: number) => {
  const dirs = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
};
const fmtHoraPunto = (ts: number) =>
  new Date(ts).toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "America/Lima" });
const fmtHoraTs = (ts: number) => // sin segundos, para el resumen del viaje
  new Date(ts).toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Lima" });

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
  const prevUbicRef = useRef<{ lat: number; lng: number; ts: number } | null>(null);
  // Historial corto de fixes (lat/lng/ts/acc) para estimar velocidad por DESPLAZAMIENTO
  // sobre una ventana de tiempo (suprime el jitter del GPS de red, que de punto-a-punto
  // produce velocidades absurdas: un salto de ±80 m en 1 s = 288 km/h falsos).
  const velHistRef = useRef<{ lat: number; lng: number; ts: number; acc: number }[]>([]);

  const [ubic,           setUbic]           = useState<UbicGps | null>(null);
  const [errorMapa,      setErrorMapa]      = useState(false);
  const [ultimaActualiz, setUltimaActualiz] = useState<Date | null>(null);
  const [sinSenal,       setSinSenal]       = useState(false);
  const [congeladoMin,   setCongeladoMin]   = useState(0); // min con la MISMA coord Y buena precisión = fix viejo reenviado (GPS congelado real)
  const [precBajaM,      setPrecBajaM]      = useState(0); // ±m cuando la coord está fija por baja precisión (red/FUSED, bus quieto) — NO es congelado
  const [precDebilM,     setPrecDebilM]     = useState(0); // ±m: precisión mediana reciente de RED (≥60m) — cubre el bus EN MOVIMIENTO con GPS débil (equipo del conductor)
  const [sinMovMin,      setSinMovMin]      = useState(0); // min que la unidad lleva SIN DESPLAZARSE (>150 m) con servicio en curso — caso "teléfono quedó en la cochera" (#951: 75 min clavado en el origen con las paradas completándose)
  const [mapListo,       setMapListo]       = useState(false);
  const [ruta,              setRuta]              = useState<RutaData | null>(null);
  const rutaRef = useRef<RutaData | null>(null);   // espejo de `ruta` para leerla en el loop del puente
  const [cargandoRuta,      setCargandoRuta]      = useState(false);
  const [errorRuta,         setErrorRuta]         = useState<string | null>(null);
  const [paradasResueltas,  setParadasResueltas]  = useState<Parada[]>([]);
  const [huella,            setHuella]            = useState<{lat:number;lng:number;velocidad:number;acc?:number}[]>([]);
  const [matchedCoords,     setMatchedCoords]     = useState<[number, number][] | null>(null);
  const [esCrudoArr,        setEsCrudoArr]        = useState<boolean[]>([]);              // esCrudo por vértice de matchedCoords (cuerdas crudas largas → aprox, no "medido")
  const [velCalc,           setVelCalc]           = useState<number>(0);
  const [telemetria,        setTelemetria]        = useState<PuntoTelemetria[]>([]); // puntitos de telemetría real
  const [resumen,           setResumen]           = useState<ResumenViaje | null>(null); // resumen del viaje (datos reales)
  const [puentes,           setPuentes]           = useState<any[]>([]);              // features GeoJSON de tramos estimados (ruta prevista, verde petróleo)
  const [suprimirCrudo,     setSuprimirCrudo]     = useState<Array<[number, number]>>([]); // rangos de coords crudas que SÍ se rutearon → no dibujar como medido
  const [colaSnapped,       setColaSnapped]       = useState(true);                     // ¿la punta viva pegó a la vía? (false → colaViva sigue la ruta prevista, no el zigzag)
  const [colaClean,         setColaClean]         = useState(-1);                        // último índice de VÍA limpia en matched (frontera de colaViva; corta el crudo de la punta)
  const matchedRef                                = useRef<[number, number][] | null>(null); // última geometría ajustada (para puentesCrudos aunque el ciclo devuelva null por throttle)
  const esCrudoRef = useRef<boolean[]>([]);       // espejo de esCrudoArr para leerlo en efectos SIN re-dispararlos
  // Snap del ícono a la vía: continuidad + caché de vías cercanas (Tilequery, fallback del GPS crudo).
  const snapIconoRef = useRef<{ lat: number; lng: number; s: number | null } | null>(null);
  const viasCercaRef = useRef<{ lat: number; lng: number; puntos: { lat: number; lng: number }[] } | null>(null);
  const tilequeryPendRef = useRef(false);
  const tilequeryLastMsRef = useRef(0);           // throttle TEMPORAL (≥15 s): el jitter de red >80 m de un bus quieto no debe re-consultar en cada fix
  const [snapTick, setSnapTick] = useState(0);    // bump al llegar vías de Tilequery → re-snap del ícono/cola
  // Posición del ícono PEGADA a la vía — FUENTE ÚNICA para el marcador y la punta de la cola
  // (calculada en un solo efecto; si cada consumidor la recalculara, la continuidad avanzaría en
  // cadena y cola e ícono podían elegir vías distintas en el mismo frame).
  const [snapPos, setSnapPos] = useState<{ lat: number; lng: number; snapped: boolean } | null>(null);
  const prevSnapPosRef = useRef<{ lat: number; lng: number } | null>(null);   // para derivar el rumbo del movimiento PEGADO (no del jitter crudo)
  // Caché por hueco. `expira`: los fallos TRANSITORIOS (red caída, HTTP 429/5xx, OVER_QUERY_LIMIT)
  // se cachean con vencimiento — sin esto, o se reintentaban hasta 30 fetch cada 15 s (tormenta
  // contra Google) o quedaban "ocultar" para siempre (rango sin puente de por vida del modal).
  // Los "ocultar" GEOMÉTRICOS (ZERO_RESULTS / rodeo absurdo) sí son permanentes: el mapa no cambia.
  const puentesCacheRef = useRef<Map<string, { nivel: string; coords: [number, number][]; km: number; dt: number; expira?: number }>>(new Map());
  const cargandoHuellaRef = useRef(false); // evita ciclos solapados de cargar() (30 fetch lentos > intervalo de 15 s)
  const [mostrarPuntos,     setMostrarPuntos]     = useState(true);                  // toggle de la leyenda
  const [mostrarEstimados,  setMostrarEstimados]  = useState(true);                  // toggle: ocultar/mostrar los tramos estimados (verde petróleo)
  const geocacheRef = useRef<Map<string, string>>(new Map());                        // caché reverse-geocode por coord redondeada
  const popupTelemRef = useRef<any>(null);                                           // popup activo de un puntito
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

  // Velocidad mostrada (km/h). `velCalc` es la ÚNICA fuente del número en pantalla:
  //  1) si el equipo entrega una velocidad PLAUSIBLE (chip GPS real: 0 < v ≤ 130) se usa tal cual;
  //  2) si no (FUSED/red devuelve 0 ó valores fantasma), se ESTIMA por desplazamiento sobre una
  //     ventana de tiempo. Punto-a-punto NO sirve: con ±37 m de precisión, dos fixes a 1 s de
  //     distancia "saltan" 80 m → 288 km/h. Sobre una ventana ≥10 s el jitter se promedia y,
  //     restando el piso de ruido (la incertidumbre combinada), un bus quieto da 0 y uno en
  //     marcha da su velocidad real. Cualquier resultado > 130 km/h es jitter residual → se
  //     descarta (se conserva el último valor bueno, nunca se pinta una cifra absurda).
  const VEL_HIST_MS = 45_000;        // memoria de fixes para la ventana (cap del retardo)
  useEffect(() => {
    if (!ubic) return;
    const ts = ubic.created_at ? new Date(ubic.created_at).getTime()
             : ubic.timestamp  ? new Date(ubic.timestamp).getTime()
             : Date.now();
    if (!Number.isFinite(ts) || !Number.isFinite(ubic.lat) || !Number.isFinite(ubic.lng)) return;
    const acc = Number(ubic.precision_m) || 30;
    const hist = velHistRef.current;
    const last = hist[hist.length - 1];
    if (!last || ts > last.ts + 500) {                 // evita duplicados realtime+poll del mismo fix
      hist.push({ lat: ubic.lat, lng: ubic.lng, ts, acc });
      const corte = ts - VEL_HIST_MS;
      while (hist.length > 2 && hist[0].ts < corte) hist.shift();
    }
    // Lógica pura compartida con el reproductor offline (lib/huella.ts). null = conservar previo.
    const v = velocidadPorVentana(hist, Number(ubic.velocidad) || 0);
    if (v != null) setVelCalc(v);
  }, [ubic]); // eslint-disable-line

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
  useEffect(() => { rutaRef.current = ruta; }, [ruta]);   // el loop del puente lee rutaRef.current

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
      if (cargandoHuellaRef.current) return;   // ciclo anterior aún en vuelo (p. ej. 30 puentes lentos) → saltar este tick
      cargandoHuellaRef.current = true;
      try {
        const res = await fetch("/api/cliente/gps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ huella: true, reservaId, vehiculoId, vehiculoTerceroId }),
        });
        const json = await res.json();
        const arr = Array.isArray(json?.huella) ? json.huella : [];
        if (cancel || arr.length === 0) return;

        // GPS CONGELADO vs. BUS PARADO — dos métodos, el ROBUSTO primero.
        //
        // ROBUSTO (app actualizada): cada fila trae `fix_ts` = hora del ÚLTIMO fix REAL del
        // equipo. El backstop (web) re-envía el MISMO punto con el MISMO fix_ts; un equipo vivo
        // —aunque esté parado en GPS de red— produce fixes FRESCOS cuyo fix_ts AVANZA. Entonces
        // fix_ts que NO avanza por >3 min = congelado de verdad, sin importar la precisión. Esto
        // elimina el falso positivo del bus parado con GPS coarse.
        //
        // FALLBACK (filas/APK viejos, fix_ts = null): heurística por precisión — coords idénticas
        // >3 min CON buena precisión (≤40 m, que siempre jitterea) = fix viejo reenviado; con baja
        // precisión = solo "baja precisión" (la red coarse repite el mismo centroide estando quieto).
        const cong = (() => {
          const ts = (arr as any[])
            .map(r => ({
              t:   new Date(r.created_at || r.timestamp || 0).getTime(),
              lat: Number(r.lat), lng: Number(r.lng),
              acc: Number(r.precision_m),
              fix: r.fix_ts ? new Date(r.fix_ts).getTime() : null,
            }))
            .filter(r => Number.isFinite(r.t) && Number.isFinite(r.lat) && Number.isFinite(r.lng))
            .sort((a, b) => a.t - b.t);
          if (ts.length < 4) return { ms: 0, acc: null as number | null, robusto: false };
          const ult = ts[ts.length - 1];
          // Método robusto: ¿hace cuánto que fix_ts no avanza? (el último fix lleva fix_ts)
          if (ult.fix != null && Number.isFinite(ult.fix)) {
            let tIni = ult.t;
            for (let i = ts.length - 1; i >= 0; i--) {
              if (ts[i].fix === ult.fix) tIni = ts[i].t; else break;
            }
            return { ms: ult.t - tIni, acc: null as number | null, robusto: true };
          }
          // Fallback: ¿hace cuánto que la coord es byte-idéntica?
          let tIni = ult.t;
          for (let i = ts.length - 1; i >= 0; i--) {
            if (ts[i].lat === ult.lat && ts[i].lng === ult.lng) tIni = ts[i].t; else break;
          }
          return { ms: ult.t - tIni, acc: Number.isFinite(ult.acc) ? ult.acc : null, robusto: false };
        })();
        const PRECISION_BUENA_M = 40; // fallback: ≤ esto = satélite (siempre jitterea) → idéntico = re-envío
        const estancado = cong.ms > 180000;
        if (!cancel) {
          if (cong.robusto) {
            // fix_ts no avanza = congelado real (precisión irrelevante).
            setCongeladoMin(estancado ? Math.floor(cong.ms / 60000) : 0);
            setPrecBajaM(0);
          } else {
            const accBuena = cong.acc != null && cong.acc <= PRECISION_BUENA_M;
            setCongeladoMin(estancado && accBuena ? Math.floor(cong.ms / 60000) : 0);
            setPrecBajaM(estancado && !accBuena && cong.acc != null ? Math.round(cong.acc) : 0);
          }
        }

        // GPS DÉBIL del conductor (cubre el bus EN MOVIMIENTO con baja precisión, que NO dispara
        // congelado/precBajaM porque la coord sí cambia): si la precisión MEDIANA reciente es de
        // red (≥60 m), avisar al operador → es el EQUIPO del conductor (debe activar Alta precisión
        // / usar la app nativa), no un fallo del sistema. Un GPS satelital sano da ≤15 m.
        const accsRec = (arr as any[]).slice(-25).map(r => Number(r.precision_m)).filter(a => Number.isFinite(a)).sort((a, b) => a - b);
        const medAccRec = accsRec.length ? accsRec[Math.floor(accsRec.length / 2)] : 0;
        if (!cancel) setPrecDebilM(medAccRec >= 60 ? Math.round(medAccRec) : 0);

        // UNIDAD SIN MOVIMIENTO (caso #951: el teléfono quedó en la cochera y el bus hizo la ruta
        // sin rastreo — 75 min clavado en el origen con fix_ts avanzando, así que NI congelado NI
        // sin-señal disparan). Mide hace cuántos minutos la posición NO se aleja >150 m de la
        // actual. El header lo muestra solo con servicio EN CURSO (ubic.estado === "en_ruta"):
        // parado en carga/embarque es normal unos minutos; >10 min merece la atención del operador.
        const sinMov = (() => {
          const pts = (arr as any[])
            .map(r => ({ t: new Date(r.created_at || r.timestamp || 0).getTime(), lat: Number(r.lat), lng: Number(r.lng) }))
            .filter(p => p.t > 0 && Number.isFinite(p.lat) && Number.isFinite(p.lng))
            .sort((a, b) => a.t - b.t);
          if (pts.length < 3) return 0;
          const cur = pts[pts.length - 1];
          for (let i = pts.length - 1; i >= 0; i--) {
            if (distM(pts[i].lat, pts[i].lng, cur.lat, cur.lng) > 150) return cur.t - pts[i].t; // último movimiento real
          }
          return cur.t - pts[0].t; // nunca se movió en toda la ventana
        })();
        if (!cancel) setSinMovMin(sinMov > 10 * 60000 ? Math.floor(sinMov / 60000) : 0);

        // Anclar los fixes IMPRECISOS al corredor de los confiables ANTES de todo (mata el zigzag
        // off-road de un fix de red de ±100 m). Luego limpiar UNA sola vez (colapsa rachas detenidas
        // + dedup en marcha). El mismo set limpio alimenta el dibujo (setHuella) y el ajuste por
        // ventanas → coherentes. crudos (ya anclado) alimenta telemetría/resumen/puentes.
        const crudos = anclarImprecisos(filasAPuntos(arr));
        const limpio = conVelocidadColor(limpiarHuella(crudos));
        // `acc` viaja con cada punto: el dibujo marca `aprox` (gris punteado, no "medido") las
        // cuerdas >60 m con extremo crudo de red — el primer render ya no pinta el zigzag sólido.
        if (!cancel) setHuella(limpio.map(p => ({ lat: p.lat, lng: p.lng, velocidad: p.velocidad, acc: p.acc })));
        // Puntitos de telemetría real (~cada 100 m de recorrido, anclados a muestra real).
        if (!cancel) setTelemetria(puntosTelemetria(limpio, crudos));
        // Resumen del viaje: se calcula MÁS ABAJO (tras el loop de puentes) para que el badge de
        // "Rastreo % medido" cuente los tramos ruteados como ESTIMADO, no como medido.

        // Map Matching por ventanas (lib/huella.ts): throttle 60 s + congelado interno.
        const matched = await ajustador.ajustar(limpio, token, () => cancel);
        if (matched && !cancel) { setMatchedCoords(matched); matchedRef.current = matched; const ec = ajustador.leerEsCrudo(); esCrudoRef.current = ec; setEsCrudoArr(ec); }
        if (!cancel) setColaSnapped(ajustador.leerColaSnapped());   // ¿pegó la punta viva? (si no, colaViva sigue la ruta)
        const colaClean = ajustador.leerColaClean();                // último vértice de VÍA limpia (frontera de colaViva)

        // TRAMO ESTIMADO por RUTA. Dos fuentes: (1) HUECOS de señal (calcularPuentes) y (2) CORRIDAS
        // CRUDAS CONGELADAS (ventanas que Map Matching no pudo pegar = el zigzag/"rectas que cruzan
        // techos" del GPS de red). Ambas se rellenan igual: primero se SIGUE la RUTA PLANIFICADA (sobre
        // la vía prevista, sin cruzar el río, sin llamar a Google); si el bus se desvió (o no hay ruta),
        // FALLBACK al camino fresco de Directions. Overlay: no toca la huella medida. Las corridas crudas
        // que SÍ se rutean se añaden a `suprimir` para que colorearMatched no las dibuje también (crudas).
        const crudoRanges = ajustador.leerCrudoRanges();
        const cruditos = puentesCrudos(matchedRef.current || [], crudoRanges);
        // Corridas crudas PRIMERO: si los candidatos superan MAX_PUENTES, que lo que quede sin
        // rutear sean huecos de señal (quedan como hueco honesto), no rangos crudos (que sin
        // puente dependen del corte/aprox para no dibujarse como zigzag medido).
        const candidatos = [...cruditos, ...calcularPuentes(limpio)];
        const suprimir: Array<[number, number]> = [];
        const MAX_PUENTES = 30;
        if (candidatos.length > MAX_PUENTES) console.warn(`[ModalGps] ${candidatos.length} huecos, puenteando los primeros ${MAX_PUENTES}`);
        const cache = puentesCacheRef.current;
        const feats: any[] = [];
        // Fixes GPS REALES que caen en el intervalo de un candidato (la evidencia para validarPuente):
        //  • corrida cruda → los vértices crudos SON las posiciones GPS reales (matched[iA+1..iB-1]).
        //  • hueco de señal → los fixes crudos con ts entre las anclas (vacío = túnel real → validarPuente acepta).
        const fixesDelTramo = (c: any): { lat: number; lng: number }[] => {
          if (c.origen === "crudo") {
            const m = matchedRef.current || [];
            return m.slice(c.iA + 1, c.iB).map(([lng, lat]: [number, number]) => ({ lat, lng }));
          }
          const tA = limpio[c.iA]?.ts ?? 0, tB = limpio[c.iB]?.ts ?? 0;
          if (!(tB > tA)) return [];
          return crudos.filter((x) => x.ts > tA && x.ts < tB).map((x) => ({ lat: x.lat, lng: x.lng }));
        };
        for (const c of candidatos.slice(0, MAX_PUENTES)) {
          if (cancel) return;
          const A = { lat: c.aLat, lng: c.aLng }, B = { lat: c.bLat, lng: c.bLng };
          const fixes = fixesDelTramo(c);   // evidencia de por dónde fue REALMENTE el bus en este tramo
          // 1) Seguir la ruta planificada — SOLO si es coherente con la evidencia GPS (no un lazo del itinerario
          //    por donde el bus no pasó). Si falla la validación NO se hace `continue` → cae al fallback de Google.
          const porRuta = puentePorRuta(A, B, rutaRef.current?.coordenadas || []);
          if (porRuta && porRuta.length >= 2 && validarPuente(porRuta, A, B, fixes, c.dt, c.dRecta)) {
            let mts = 0;
            for (let k = 1; k < porRuta.length; k++) mts += distM(porRuta[k - 1][1], porRuta[k - 1][0], porRuta[k][1], porRuta[k][0]);
            feats.push({ type: "Feature", geometry: { type: "LineString", coordinates: porRuta }, properties: { nivel: "puente", km: Math.round(mts / 100) / 10, min: Math.round(c.dt / 60) } });
            if (c.origen === "crudo") suprimir.push([c.iA + 1, c.iB - 1]);
            continue;
          }
          // 2) FALLBACK: camino fresco de Directions (cacheado por coords del hueco).
          const key = `${c.aLat.toFixed(5)},${c.aLng.toFixed(5)}->${c.bLat.toFixed(5)},${c.bLng.toFixed(5)}`;
          let r = cache.get(key);
          if (r?.expira && Date.now() > r.expira) r = undefined;   // fallo transitorio vencido → reintentar
          if (!r) {
            try {
              const resp = await fetch("/api/ruta-puente", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ aLat: c.aLat, aLng: c.aLng, bLat: c.bLat, bLng: c.bLng }),
              });
              const j = await resp.json();
              if (j?.ocultar || j?.status !== "OK") {
                r = { nivel: "ocultar", coords: [], km: 0, dt: c.dt };
                // "Sin camino" GEOMÉTRICO (ZERO_RESULTS/NOT_FOUND/SIN_GEOMETRIA) es permanente: se
                // cachea sin vencimiento. Cualquier otro status (HTTP 429/5xx, OVER_QUERY_LIMIT,
                // cuota) es transitorio → vence en 60 s para no envenenar el rango de por vida.
                if (!["ZERO_RESULTS", "NOT_FOUND", "SIN_GEOMETRIA"].includes(j?.status)) r.expira = Date.now() + 60000;
              } else {
                const nivel = decidirPuente(j.roadM, c.dRecta);   // unir todo por carretera (corte solo si sin ruta o rodeo absurdo >8×)
                // El estimado usa la geometría de VÍA de Google TAL CUAL (nunca cruza casas). Los extremos
                // crudos A/B se añaden solo si están pegados a la vía (≤25 m) para cerrar la costura; si el
                // fix está más lejos, se OMITE la recta (antes esa recta A→vía de hasta 190 m cruzaba
                // manzanas/ríos = el reclamo del usuario, jul-2026). El estimado arranca sobre la calzada.
                const gc: [number, number][] = (j.coords || []) as [number, number][];
                const headOk = gc.length > 0 && distM(c.aLat, c.aLng, gc[0][1], gc[0][0]) <= 25;
                const tailOk = gc.length > 0 && distM(c.bLat, c.bLng, gc[gc.length - 1][1], gc[gc.length - 1][0]) <= 25;
                const coords: [number, number][] = nivel === "puente"
                  ? [...(headOk ? [[c.aLng, c.aLat] as [number, number]] : []), ...gc, ...(tailOk ? [[c.bLng, c.bLat] as [number, number]] : [])]
                  : [];
                r = { nivel, coords, km: (j.roadM || c.dRecta) / 1000, dt: c.dt };
              }
              cache.set(key, r);
            // Fallo de RED (fetch lanzó): cachear "ocultar" CON vencimiento de 60 s — reintenta al
            // vencer (no queda sin puente para siempre) pero sin tormenta de 30 fetch cada 15 s.
            } catch { r = { nivel: "ocultar", coords: [], km: 0, dt: c.dt, expira: Date.now() + 60000 }; cache.set(key, r); }
          }
          // Dibujar el estimado de Google SOLO si su geometría A→B directa es coherente con la evidencia GPS.
          // (Si es incoherente, no se dibuja; validarPuente es barata y determinista → se re-evalúa sin re-fetch.)
          if (r.nivel !== "ocultar" && r.coords.length >= 2 && validarPuente(r.coords, A, B, fixes, c.dt, c.dRecta)) {
            feats.push({
              type: "Feature",
              geometry: { type: "LineString", coordinates: r.coords },
              properties: { nivel: r.nivel, km: Math.round(r.km * 10) / 10, min: Math.round(c.dt / 60) },
            });
            if (c.origen === "crudo") suprimir.push([c.iA + 1, c.iB - 1]);
          }
        }
        // La punta viva CRUDA (después del último vértice limpio) la cubre colaViva por la ruta → NO se
        // dibuja como medido (evita la recta cruda de la punta). El medido termina en colaClean; colaViva sigue.
        const mLen = matchedRef.current?.length || 0;
        if (colaClean >= 0 && colaClean < mLen - 1) suprimir.push([colaClean + 1, mLen - 1]);
        if (!cancel) { setPuentes(feats); setSuprimirCrudo(suprimir); setColaClean(colaClean); }
        // Badge HONESTO desde la geometría realmente dibujada: medido = línea medida (sin los tramos
        // crudos que se rutearon); estimado = todos los tramos petróleo (huecos + crudo ruteado). Así el
        // "Rastreo %" NO infla lo medido con la ruta asumida (baja en servicios degradados = correcto).
        const largoCoords = (cs: any[]) => { let m = 0; for (let k = 1; k < (cs?.length || 0); k++) m += distM(cs[k - 1][1], cs[k - 1][0], cs[k][1], cs[k][0]); return m; };
        const largoFeats = (fs: any[]) => fs.reduce((a, f) => a + largoCoords(f.geometry?.coordinates || []), 0);
        const huellaColor = limpio.map((p) => ({ lat: p.lat, lng: p.lng, velocidad: p.velocidad }));
        // Badge HONESTO desde la geometría dibujada: medido = línea de velocidad; estimado = tramos
        // petróleo por ruta. El crudo largo ya no se dibuja (ni gris ni medido) — lo cubre el estimado.
        const featsColoreados = colorearMatched(matchedRef.current || [], huellaColor, suprimir, ajustador.leerEsCrudo());
        const medidoM = largoFeats(featsColoreados);
        const estimadoM = largoFeats(feats);
        const rv = resumenViaje(limpio, crudos);
        if (rv && medidoM + estimadoM > 0) rv.medidoPct = Math.round((medidoM / (medidoM + estimadoM)) * 100);
        if (!cancel) setResumen(rv);
      } catch { /* conservar estela previa */ }
      finally { cargandoHuellaRef.current = false; }
    };
    cargar();
    const iv = setInterval(cargar, 15000);
    return () => { cancel = true; clearInterval(iv); };
  }, [reservaId, vehiculoId, vehiculoTerceroId]); // eslint-disable-line

  // Snap del ÍCONO del bus a la vía (regla: el bus SIEMPRE sobre una pista, jamás sobre techos).
  // UN SOLO efecto calcula la posición pegada por fix y la publica en snapPos; el marcador y la
  // punta de la cola la CONSUMEN — así jamás divergen ni la continuidad avanza en cadena. La
  // corrección está acotada por la imprecisión del fix (ver pegarIconoAVia) → no fabrica posición.
  useEffect(() => {
    if (!ubic) { setSnapPos(null); snapIconoRef.current = null; return; }
    const accFix = Number(ubic.precision_m) || 25;
    const cerca = viasCercaRef.current;
    const r = pegarIconoAVia(ubic.lat, ubic.lng, accFix, {
      ruta: rutaRef.current?.coordenadas,
      trail: matchedRef.current || undefined,
      trailEsCrudo: esCrudoRef.current,
      puntosVia: cerca && distM(cerca.lat, cerca.lng, ubic.lat, ubic.lng) <= 250 ? cerca.puntos : undefined,
      prev: snapIconoRef.current,
      prevS: snapIconoRef.current?.s ?? null,
    });
    snapIconoRef.current = { lat: r.lat, lng: r.lng, s: r.s };
    // Publicar solo si cambió de verdad (>0.5 m) — evita re-renders/redraws idénticos.
    setSnapPos((prev) => (prev && distM(prev.lat, prev.lng, r.lat, r.lng) < 0.5 && prev.snapped === r.snapped) ? prev : { lat: r.lat, lng: r.lng, snapped: r.snapped });
    // Fix CRUDO sin vía conocida cerca → pedir a Tilequery los puntos de calle del entorno.
    // Throttle DOBLE: espacial (>80 m del centro de la caché) y temporal (≥15 s) — el jitter de
    // red de un bus quieto no re-consulta en cada fix. Error (null) → NO se cachea (se reintenta
    // al vencer el throttle); [] genuino → SÍ se cachea (ahí no hay vía vehicular, es la verdad).
    // Con chip preciso jamás se llama: el fix ya está sobre la vía.
    if (!r.snapped && esAccCruda(accFix) && !tilequeryPendRef.current && Date.now() - tilequeryLastMsRef.current >= 15000) {
      if (!cerca || distM(cerca.lat, cerca.lng, ubic.lat, ubic.lng) > 80) {
        tilequeryPendRef.current = true;
        tilequeryLastMsRef.current = Date.now();
        const la = ubic.lat, ln = ubic.lng;
        viasCercanasTilequery(la, ln, 200, process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "")
          .then((puntos) => {
            if (puntos == null) return;   // error de red/HTTP → conservar caché previa, reintentar al vencer el throttle
            viasCercaRef.current = { lat: la, lng: ln, puntos };
            if (puntos.length) setSnapTick((t) => t + 1);
          })
          .finally(() => { tilequeryPendRef.current = false; });
      }
    }
  }, [ubic, snapTick, matchedCoords, ruta]); // eslint-disable-line

  // ── CAPA 2: Dibujar huella GPS (ajustada a carretera si hay Map Matching) ───

  useEffect(() => {
    if (!mapListo || !mapInst.current) return;
    if (!matchedCoords && huella.length < 2) return;
    const map = mapInst.current;
    try {
      // Con Map Matching: geometría pegada a la vía + COLA VIVA (puntos crudos posteriores y
      // posición en vivo) para que el trazo alcance al bus pese al throttle de 60 s del matching.
      // Sin matching aún (GPS de torre / cargando): huella cruda suavizada por tramos.
      // El punto vivo de la cola usa la posición PEGADA a la vía (snapPos — la MISMA del ícono,
      // calculada una sola vez) → el trazo termina exactamente donde está el marcador, sin colita
      // cruda hacia un techo. El `acc` se conserva CRUDO: si la cuerda hasta el bus es larga e
      // imprecisa, sigue saliendo `aprox` (el camino intermedio sigue sin medirse).
      const accLive = ubic ? (Number(ubic.precision_m) || 25) : 25;
      const live = ubic ? { lat: snapPos?.lat ?? ubic.lat, lng: snapPos?.lng ?? ubic.lng, velocidad: velCalc, acc: accLive } : null;
      const cut = matchedCoords ? ((colaClean >= 1 && colaClean < matchedCoords.length - 1) ? colaClean : matchedCoords.length - 1) : 0;
      const features = (matchedCoords && matchedCoords.length >= 2)
        ? [...colorearMatched(matchedCoords, huella, suprimirCrudo, esCrudoArr), ...colaViva(matchedCoords.slice(0, cut + 1), huella, live, rutaRef.current?.coordenadas, !colaSnapped || cut < matchedCoords.length - 1)]
        : huellaCrudaFeatures(huella);
      const data: any = { type: "FeatureCollection", features };

      // ESTELA PROVISIONAL (fix jul-2026 "la huella tarda 1-2 min en aparecer"): en un tercero con GPS
      // de red, TODAS las cuerdas crudas superan 60 m → colorearMatched/huellaCrudaFeatures las OMITEN y
      // el trazo queda EN BLANCO hasta que el Map Matching logra pegar a la vía (throttle 12 s + llamadas
      // secuenciales a Mapbox/Google, agravado por cold starts de Vercel). Mientras no haya NINGUNA
      // geometría medida (features vacío), se dibuja al instante la huella cruda suavizada (cortada en
      // saltos >300 m; omitirCrudoLargo=false para no dejarla vacía), en gris punteado fino → se lee
      // "provisional". Apenas aparece geometría real, provFeatures se vacía y la reemplaza la línea pegada.
      const provFeatures = (features.length === 0 && huella.length >= 2)
        ? huellaCrudaFeatures(huella, MAX_SEG_M, false)
        : [];
      const provData: any = { type: "FeatureCollection", features: provFeatures };

      // setData en vivo (sin remove/add) para que la cola siga al bus sin parpadeo.
      const src = map.getSource("huella-gps");
      if (src && typeof src.setData === "function") {
        src.setData(data);
      } else {
        map.addSource("huella-gps", { type: "geojson", data });
        map.addLayer({
          id: "huella-gps-line", type: "line", source: "huella-gps",
          // Una sola capa: velocidad + punta viva estimada. La cuerda cruda larga ya no se dibuja
          // (se eliminó la capa gris punteada "aprox", jul-2026); la vía de esos tramos la da el
          // estimado por ruta (verde petróleo), que SIEMPRE va sobre la calzada.
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-width": 5, "line-opacity": 0.9,
            // Punta viva estimada (sigue la ruta) en verde petróleo; el resto por velocidad.
            "line-color": ["case", ["==", ["get", "estimado"], 1], "#0f766e", ["interpolate", ["linear"], ["get", "velocidad"], 0, "#dc2626", 15, "#f59e0b", 35, "#eab308", 55, "#16a34a"]],
          },
        });
      }

      // Capa PROVISIONAL: por DEBAJO de la medida, gris punteada fina y semitransparente para que no se
      // confunda con la huella real pegada a la vía. Se vacía sola cuando ya hay geometría medida.
      const srcP = map.getSource("huella-provisional");
      if (srcP && typeof srcP.setData === "function") {
        srcP.setData(provData);
      } else {
        map.addSource("huella-provisional", { type: "geojson", data: provData });
        const layerP: any = {
          id: "huella-provisional-line", type: "line", source: "huella-provisional",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#64748b", "line-width": 3, "line-opacity": 0.55, "line-dasharray": [1.5, 1.5] },
        };
        if (map.getLayer("huella-gps-line")) map.addLayer(layerP, "huella-gps-line");
        else map.addLayer(layerP);
      }
    } catch (e) { console.error("[ModalGps] Error dibujando huella GPS:", e); }
  }, [huella, matchedCoords, mapListo, ubic, velCalc, suprimirCrudo, colaSnapped, colaClean, esCrudoArr, snapPos]); // eslint-disable-line

  // ── CAPA 3: Puntitos de telemetría real (velocidad/rumbo/dirección al clic) ──
  useEffect(() => {
    if (!mapListo || !mapInst.current) return;
    const map = mapInst.current;
    const gl = window.mapboxgl;
    try {
      const features = telemetria.map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lng, p.lat] as [number, number] },
        // 1/0 en vez de booleanos: las properties de un evento Mapbox pueden llegar como string.
        properties: {
          velocidad: p.velocidad, velReal: p.velReal ? 1 : 0,
          rumbo: p.rumbo, rumboReal: p.rumboReal ? 1 : 0,
          acc: Math.round(p.acc), ts: p.ts, lat: p.lat, lng: p.lng,
        },
      }));
      const data: any = { type: "FeatureCollection", features };
      const src = map.getSource("telemetria-puntos");
      if (src && typeof src.setData === "function") {
        src.setData(data);
      } else {
        map.addSource("telemetria-puntos", { type: "geojson", data });
        map.addLayer({
          id: "telemetria-puntos-c", type: "circle", source: "telemetria-puntos",
          paint: {
            // Radio y opacidad crecen con el zoom para no saturar en vista lejana.
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 14, 4, 17, 6],
            "circle-color": ["interpolate", ["linear"], ["get", "velocidad"], 0, "#dc2626", 15, "#f59e0b", 35, "#eab308", 55, "#16a34a"],
            "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5,
            "circle-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.55, 14, 0.9],
          },
        });

        // Handlers registrados UNA sola vez (la rama else corre solo al crear la capa).
        map.on("mouseenter", "telemetria-puntos-c", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "telemetria-puntos-c", () => { map.getCanvas().style.cursor = ""; });
        map.on("click", "telemetria-puntos-c", async (e: any) => {
          const f = e.features?.[0]; if (!f) return;
          const pr = f.properties || {};
          const vel = Number(pr.velocidad) || 0;
          const velReal = Number(pr.velReal) === 1;
          const rumbo = Number(pr.rumbo) || 0;
          const rumboReal = Number(pr.rumboReal) === 1;
          const acc = Number(pr.acc) || 0;
          const ts = Number(pr.ts) || 0;
          const lat = Number(pr.lat), lng = Number(pr.lng);

          const velTxt = vel <= 0
            ? `<b>Detenido</b>`
            : `<b>${vel} km/h</b>${velReal ? "" : ' <span style="color:#94a3b8">aprox.</span>'}`;
          const rumboTxt = vel <= 0
            ? "—"
            : `${rumboCardinal(rumbo)} (${rumbo}°)${rumboReal ? "" : ' <span style="color:#94a3b8">aprox.</span>'}`;
          const html = (dir: string) => `
            <div style="font-family:system-ui,sans-serif;font-size:12px;line-height:1.5;min-width:170px">
              <div style="color:#64748b;font-size:11px">${fmtHoraPunto(ts)}</div>
              <div style="font-size:14px;margin:2px 0">${velTxt}</div>
              <div>Dirección: ${rumboTxt}</div>
              <div style="color:#64748b">Precisión: ±${acc} m</div>
              <div style="color:#334155;margin-top:3px">${dir}</div>
            </div>`;

          if (popupTelemRef.current) popupTelemRef.current.remove();
          const popup = new gl.Popup({ closeButton: true, offset: 10, maxWidth: "240px" })
            .setLngLat([lng, lat]).setHTML(html('<span style="color:#94a3b8">Ubicando dirección…</span>')).addTo(map);
          popupTelemRef.current = popup;

          // Reverse-geocode diferido y con caché por coord redondeada (~11 m). Solo al hacer clic.
          const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
          const pintar = (dir: string) => { if (popupTelemRef.current === popup && popup.isOpen()) popup.setHTML(html(dir)); };
          if (geocacheRef.current.has(key)) { pintar(geocacheRef.current.get(key)!); return; }
          try {
            const res = await fetch("/api/geocodificar-inverso", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ lat, lng }),
            });
            const j = await res.json();
            const dir = j?.direccion || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
            // Cachear solo con dirección o status terminal (ZERO_RESULTS). Un null por cuota
            // transitoria (OVER_QUERY_LIMIT/REQUEST_DENIED) NO se cachea → reintenta al reabrir.
            if (j?.direccion || j?.status === "ZERO_RESULTS") geocacheRef.current.set(key, dir);
            pintar(dir);
          } catch {
            pintar(`${lat.toFixed(5)}, ${lng.toFixed(5)}`);
          }
        });
      }

      // Toggle de visibilidad desde la leyenda.
      if (map.getLayer("telemetria-puntos-c")) {
        map.setLayoutProperty("telemetria-puntos-c", "visibility", mostrarPuntos ? "visible" : "none");
      }
    } catch (e) { console.error("[ModalGps] Error dibujando puntitos de telemetría:", e); }
  }, [telemetria, mostrarPuntos, mapListo]);

  // ── CAPA 4: Puente azul de tramos sin señal (estimado por carretera) ────────
  useEffect(() => {
    if (!mapListo || !mapInst.current) return;
    const map = mapInst.current;
    const gl = window.mapboxgl;
    try {
      const data: any = { type: "FeatureCollection", features: puentes };
      const src = map.getSource("huella-puente");
      if (src && typeof src.setData === "function") {
        src.setData(data);
      } else {
        map.addSource("huella-puente", { type: "geojson", data });
        const layer: any = {
          id: "huella-puente-l", type: "line", source: "huella-puente",
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            // Verde petróleo SÓLIDO y continuo (decisión del usuario): el tramo estimado se integra como
            // parte de la huella, distinguible del verde 'rápido' de velocidad. Siempre por carretera → nunca cruza el río.
            "line-color": "#0f766e", "line-width": 5, "line-opacity": 0.9,
          },
        };
        // Debajo de la huella medida (esa manda visualmente); el puente solo rellena los huecos.
        if (map.getLayer("huella-gps-line")) map.addLayer(layer, "huella-gps-line");
        else map.addLayer(layer);
        map.on("mouseenter", "huella-puente-l", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "huella-puente-l", () => { map.getCanvas().style.cursor = ""; });
        map.on("click", "huella-puente-l", (e: any) => {
          const f = e.features?.[0]; if (!f) return;
          const pr = f.properties || {};
          const km = Number(pr.km) || 0, min = Number(pr.min) || 0;
          const html = `<div style="font-family:system-ui,sans-serif;font-size:12px;line-height:1.5;min-width:160px">
            <div style="font-weight:700;color:#0f766e">Tramo estimado (ruta prevista)</div>
            <div style="color:#334155">${km} km sobre la ruta${min > 0 ? ` · ~${min} min` : ""}</div>
            <div style="color:#94a3b8;font-size:11px;margin-top:2px">Sobre la ruta prevista · no medido por GPS</div></div>`;
          if (popupTelemRef.current) popupTelemRef.current.remove();
          popupTelemRef.current = new gl.Popup({ closeButton: true, offset: 8, maxWidth: "240px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);
        });
      }
      // Toggle de la leyenda: ocultar/mostrar TODOS los tramos estimados (verde petróleo) a pedido del operador.
      if (map.getLayer("huella-puente-l")) map.setLayoutProperty("huella-puente-l", "visibility", mostrarEstimados ? "visible" : "none");
    } catch (e) { console.error("[ModalGps] Error dibujando puentes:", e); }
  }, [puentes, mapListo, mostrarEstimados]);

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
        // Solo re-emitir si el FIX cambió: el poll de 10 s con un objeto nuevo pero el mismo
        // fix re-disparaba el efecto del marcador y cortaba en seco el tween en vuelo
        // (animarMarcador con destino idéntico hace setLngLat directo) — el "salto seco" que
        // el tween vino a eliminar. sinSenal sí se recalcula siempre (la edad avanza).
        const prev = ubicRef.current;
        const mismoFix = prev && prev.lat === d.lat && prev.lng === d.lng
          && (prev.created_at || prev.timestamp) === (d.created_at || d.timestamp);
        if (!mismoFix) {
          ubicRef.current = d;
          setUbic(d); setUltimaActualiz(new Date());
        }
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

  // HTML del popup del bus. Se usa al CREAR el marcador y al RE-sincronizar la velocidad
  // (el popup se arma una vez; sin re-sync se quedaba con la velocidad inicial = 0).
  const popupHTML = (vel: number) =>
    `<div style="font-family:system-ui;padding:4px">
      <p style="font-weight:900;margin:0;color:#0b315f;font-size:15px">${vehiculoPlaca}</p>
      <p style="margin:4px 0 0;color:#475569;font-size:12px">${conductorNombre}</p>
      <p style="margin:6px 0 0;color:#16a34a;font-weight:700;font-size:16px">${vel} km/h</p>
    </div>`;

  useEffect(() => {
    if (!ubic || !mapListo || !mapInst.current) return;
    // Posición PEGADA a la vía (snapPos, calculada en el efecto de snap — misma que la cola).
    // Fallback al fix crudo solo mientras snapPos aún no se publica en este ciclo.
    const pos = snapPos ?? { lat: ubic.lat, lng: ubic.lng };
    const lngLat: [number, number] = [pos.lng, pos.lat];
    // Heading: usar rumbo del GPS si es válido (>0). Si no (detenido o sensor sin dato), derivarlo
    // del desplazamiento PEGADO (snap previo → snap actual): con posición snapeada, el bearing del
    // jitter crudo apuntaba de costado respecto de la pista. Con <5 m de avance se conserva el
    // rumbo previo del marcador (no girar por ruido).
    const rawRumbo = Number(ubic.rumbo);
    const prevSnap = prevSnapPosRef.current;
    const rot = rawRumbo > 0
      ? rawRumbo
      : (prevSnap && distM(prevSnap.lat, prevSnap.lng, pos.lat, pos.lng) > 5)
          ? calcBearing(prevSnap.lat, prevSnap.lng, pos.lat, pos.lng)
          : (markerRef.current?.getRotation?.() ?? rawRumbo);
    prevSnapPosRef.current = { lat: pos.lat, lng: pos.lng };
    const ts = ubic.created_at ? new Date(ubic.created_at).getTime()
             : ubic.timestamp  ? new Date(ubic.timestamp).getTime()
             : Date.now();
    prevUbicRef.current = { lat: ubic.lat, lng: ubic.lng, ts };
    // Color del pulso según antigüedad de la señal (igual que el mapa "En vivo").
    const fechaRef = ubic.created_at || ubic.timestamp;
    const edadS = fechaRef ? (Date.now() - new Date(fechaRef).getTime()) / 1000 : 9999;
    const color = edadS <= 60 ? "#16a34a" : edadS <= 600 ? "#d97706" : "#dc2626";

    if (markerRef.current) {
      // Deslizar el marcador entre puntos (tween estilo Uber) en vez de saltar seco: paridad
      // con /monitoreo (animarMarcador) — el salto seco se percibía como "desfase" del modal.
      animarMarcador(markerRef.current, lngLat);
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
        .setPopup(new window.mapboxgl.Popup({ offset: 28, closeButton: false }).setHTML(popupHTML(velCalc)))
        .addTo(mapInst.current);
      // Primera vez: salto directo al vehículo (como /seguimiento), no animación lenta desde Lima.
      mapInst.current.flyTo({ center: lngLat, zoom: 15, duration: 900 });
    }
  }, [ubic, mapListo, vehiculoPlaca, conductorNombre, snapPos]); // eslint-disable-line

  // Mantener la velocidad del popup del bus en sync (se arma una vez; sin esto se quedaba en 0).
  useEffect(() => {
    const pop = markerRef.current?.getPopup?.();
    if (pop?.setHTML) pop.setHTML(popupHTML(velCalc));
  }, [velCalc, vehiculoPlaca, conductorNombre]); // eslint-disable-line

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
                {(() => {
                  const debilM = Math.max(precBajaM, precDebilM);
                  // "Sin movimiento" solo con servicio EN CURSO: quieto en carga/embarque unos min
                  // es normal; >10 min en_ruta = teléfono fuera del bus (#951) o unidad varada.
                  const quieto = sinMovMin > 0 && ubic?.estado === "en_ruta";
                  const alerta = (congeladoMin > 0 || debilM > 0 || quieto) && !sinSenal;
                  return (
                <p
                  className={`text-[11px] flex items-center gap-2 ${alerta ? "text-amber-300 font-bold" : "text-blue-200"}`}
                  title={quieto ? "La unidad no se desplaza con el servicio en curso. Causas: GPS del teléfono PEGADO (pídele apagar/encender la Ubicación; si sigue, reiniciar el celular — caso #951), teléfono fuera del vehículo, o unidad varada. El conductor ya ve esta alerta en su pantalla." : debilM > 0 ? "GPS de baja precisión del equipo del conductor: pídele activar Alta precisión (GPS satelital) o usar la app nativa." : undefined}
                >
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${sinSenal ? "bg-red-400" : alerta ? "bg-amber-400 animate-pulse" : "bg-green-400 animate-pulse"}`} />
                  {sinSenal
                    ? "Sin señal GPS"
                    : congeladoMin > 0
                      ? `⚠ GPS del conductor congelado · hace ${congeladoMin} min`
                      : quieto
                        ? `⚠ Unidad sin movimiento · hace ${sinMovMin} min${debilM > 0 ? ` · ±${debilM}m` : ""} — GPS pegado o teléfono fuera del bus`
                        : ultimaActualiz
                          ? `GPS en vivo · hace ${segsDesdeUlt}s${debilM > 0 ? ` · ⚠ GPS débil ±${debilM}m (activar Alta precisión)` : ""}`
                          : "Conectando..."}
                </p> ); })()}
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
            <div className={`px-4 py-1.5 rounded-xl text-center min-w-[56px] ${!ubic || velCalc === 0 ? "bg-white/10" : velCalc > 80 ? "bg-red-500" : "bg-green-600"}`}>
              <p className="text-white font-black text-xl leading-none">{ubic ? velCalc : "—"}</p>
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
                <p className="text-white font-black text-4xl leading-none">{velCalc}</p>
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
                {telemetria.length > 0 && (
                  <button
                    onClick={() => setMostrarPuntos(v => !v)}
                    className="mt-1.5 flex items-center gap-1 text-[9px] font-bold text-gray-500 hover:text-gray-800">
                    <span className={`w-2.5 h-2.5 rounded-full inline-block border-2 border-white ${mostrarPuntos ? "bg-green-500 shadow" : "bg-gray-300"}`}/>
                    {mostrarPuntos ? "Ocultar" : "Mostrar"} datos por punto
                  </button>
                )}
                {puentes.length > 0 && (
                  <button
                    onClick={() => setMostrarEstimados(v => !v)}
                    className="mt-1.5 flex items-center gap-1 text-[9px] font-bold text-gray-500 hover:text-gray-800">
                    <span className="w-5 h-1 rounded inline-block" style={{ background: "#0f766e", opacity: mostrarEstimados ? 1 : 0.3 }}/>
                    {mostrarEstimados ? "Ocultar" : "Mostrar"} tramo estimado
                  </button>
                )}
              </div>
            )}

            {mapDescentrado && ubic && !errorMapa && (
              <button
                onClick={() => {
                  if (mapInst.current && ubic) {
                    mapDescentradoRef.current = false;
                    setMapDescentrado(false);
                    // Centrar en la posición PEGADA a la vía (donde se dibuja el ícono), no el fix crudo.
                    const c = snapIconoRef.current ?? { lat: ubic.lat, lng: ubic.lng };
                    mapInst.current.easeTo({ center: [c.lng, c.lat], zoom: 15, duration: 800 });
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

            {resumen && resumen.kmRecorridos > 0 && (
              <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400">Resumen del viaje</p>
                  {/* Badge de calidad de rastreo: % del recorrido efectivamente medido (vs huecos). */}
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                    style={{
                      background: resumen.medidoPct >= 90 ? "#dcfce7" : resumen.medidoPct >= 70 ? "#fef9c3" : "#fee2e2",
                      color: resumen.medidoPct >= 90 ? "#15803d" : resumen.medidoPct >= 70 ? "#a16207" : "#b91c1c",
                    }}>
                    Rastreo {resumen.medidoPct}%
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-2">
                  <div><p className="text-[9px] text-gray-400 uppercase font-bold">Recorrido</p><p className="text-sm font-black text-gray-800">{resumen.kmRecorridos} km</p></div>
                  <div><p className="text-[9px] text-gray-400 uppercase font-bold">Duración</p><p className="text-sm font-black text-gray-800">{fmtTiempo(resumen.tiempoTotalMin)}</p></div>
                  <div><p className="text-[9px] text-gray-400 uppercase font-bold">En marcha</p><p className="text-sm font-bold text-gray-700">{fmtTiempo(resumen.tiempoMovimientoMin)}</p></div>
                  <div><p className="text-[9px] text-gray-400 uppercase font-bold">Detenido</p><p className="text-sm font-bold text-gray-700">{fmtTiempo(resumen.tiempoDetenidoMin)}</p></div>
                  <div><p className="text-[9px] text-gray-400 uppercase font-bold">Vel. máx</p><p className="text-sm font-bold text-gray-700">{resumen.velMaxKmh} km/h</p></div>
                  <div><p className="text-[9px] text-gray-400 uppercase font-bold">Detenciones</p><p className="text-sm font-bold text-gray-700">{resumen.paradas}</p></div>
                </div>
                <div className="flex items-center justify-between mt-2 pt-2 border-t text-[10px] text-gray-500" style={{ borderColor: "#f1f5f9" }}>
                  <span>Salida <b className="text-gray-700">{fmtHoraTs(resumen.horaSalida)}</b></span>
                  <span>Última señal <b className="text-gray-700">{fmtHoraTs(resumen.horaLlegada)}</b></span>
                </div>
                {resumen.medidoPct < 90 && (
                  <p className="text-[9px] text-gray-400 mt-1.5 leading-snug">
                    {100 - resumen.medidoPct}% estimado (sin señal o GPS débil, dibujado sobre la ruta prevista). Precisión mediana ±{resumen.precisionMedianaM} m.
                  </p>
                )}
              </div>
            )}

            <div className="bg-white rounded-xl border p-3" style={{ borderColor: "#e2e8f0" }}>
              <p className="text-[9px] font-bold uppercase tracking-widest text-gray-400 mb-1">Velocidad real</p>
              <div className="flex items-end gap-1">
                <p className="font-black text-3xl leading-none" style={{ color: !ubic ? "#94a3b8" : velCalc > 80 ? "#dc2626" : velCalc > 0 ? "#16a34a" : "#0b315f" }}>
                  {ubic ? velCalc : "—"}
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