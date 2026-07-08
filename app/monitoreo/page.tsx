"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { animarMarcador } from "@/lib/anim-marker";
import { IconRefresh, IconBus, IconBuilding, IconCrosshair } from "@/app/_components/icons";

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || '';

type UbicacionGPS = {
  id: number; vehiculo_id: number | null; conductor_id: number | null;
  conductor_tercero_id: number | null; vehiculo_tercero_id: number | null;
  reserva_id: number | null;
  lat: number; lng: number; velocidad: number; rumbo: number;
  estado: string; timestamp: string;
};
type AlertaSOS = {
  id: number; conductor_id: number | null; vehiculo_id: number | null;
  lat: number; lng: number; mensaje: string; atendido: boolean; created_at: string;
};
type Vehiculo  = { id: number; placa: string; categoria: string | null; marca: string | null; modelo: string | null; };
type Conductor = { id: number; nombre: string; telefono: string | null; };
type VehiculoTercero  = { id: number; placa: string | null; categoria: string | null; marca: string | null; modelo: string | null; empresa_id: number | null; };
type ConductorTercero = { id: number; nombre: string | null; telefono: string | null; };
type EmpresaTercero   = { id: number; razon_social: string | null; };
type ReservaHoy = {
  id: number; vehiculo_id: number | null; vehiculo_tercero_id: number | null;
  tipo_servicio_detalle: string | null;
};

// Móvil unificado: flota propia AFA + flota tercerizada, con la MISMA forma para la
// torre de control. `esTercero` distingue el origen porque los IDs se solapan entre tablas.
type Movil = { key: string; id: number; placa: string; categoria: string | null; marca: string | null; modelo: string | null; esTercero: boolean; empresaId: number | null; };

function minutosDesde(ts: string): number {
  return Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
}
function estadoColor(min: number): string {
  if (min <= 2)  return "#16a34a";
  if (min <= 10) return "#d97706";
  return "#dc2626";
}
function estadoLabel(min: number): string {
  if (min <= 2)  return "En línea";
  if (min <= 10) return "Hace " + min + "m";
  return "Sin señal";
}

// Escape HTML mínimo para datos que se inyectan vía innerHTML en marcadores/popups.
function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// ─── ICONOS DE VEHÍCULO (siluetas laterales, viewBox 44×28) ──────────────────
// Cuerpo blanco, ventanas/ruedas #12213a. La forma diferencia el tipo de un vistazo:
// AUTO bajo, SUV alto, VAN/Sprinter caja alta, MINIBÚS/CÚSTER bus corto, BUS largo.
const VEH_SVG: Record<string, string> = {
  AUTO: `<path d="M3.5 20.5 L3.5 17.8 C3.5 17 4.1 16.4 4.9 16.4 L7.5 16.4 L11.5 10.8 C12 10 12.9 9.6 13.8 9.6 L25 9.6 C26 9.6 26.9 10 27.5 10.8 L31 15.3 L38 16.3 C39.7 16.6 41 18 41 19.7 C41 20.1 40.7 20.5 40.2 20.5 Z"/><path d="M13.8 11.5 L23.6 11.5 C24.2 11.5 24.8 11.8 25.2 12.3 L27.4 15 L13.8 15 Z" fill="#12213a"/><circle cx="13.5" cy="21.2" r="3.5" fill="#12213a"/><circle cx="13.5" cy="21.2" r="1.3" fill="#fff"/><circle cx="31" cy="21.2" r="3.5" fill="#12213a"/><circle cx="31" cy="21.2" r="1.3" fill="#fff"/>`,
  SUV: `<path d="M3.5 20.5 L3.5 16.4 C3.5 15.6 4.1 15 4.9 15 L8.6 15 L11.4 9.4 C11.9 8.6 12.8 8.2 13.7 8.2 L27.6 8.2 C28.5 8.2 29.3 8.6 29.8 9.4 L32.6 15 L38.2 15.8 C39.8 16 41 17.4 41 19 L41 19.8 C41 20.2 40.7 20.5 40.2 20.5 Z"/><path d="M13.7 9.9 L20 9.9 L20 14.5 L13.7 14.5 Z" fill="#12213a"/><path d="M21.5 9.9 L27 9.9 C27.6 9.9 28.1 10.2 28.4 10.7 L30.4 14.5 L21.5 14.5 Z" fill="#12213a"/><circle cx="13.5" cy="21.2" r="3.5" fill="#12213a"/><circle cx="13.5" cy="21.2" r="1.3" fill="#fff"/><circle cx="31.5" cy="21.2" r="3.5" fill="#12213a"/><circle cx="31.5" cy="21.2" r="1.3" fill="#fff"/>`,
  VAN: `<path d="M3.5 20.5 L3.5 10 C3.5 8.9 4.4 8 5.5 8 L28.5 8 C29.5 8 30.4 8.4 31 9.2 L36.4 15.6 C37.4 16.2 38 17.2 38 18.4 L38 19.7 C38 20.1 37.7 20.5 37.2 20.5 Z"/><rect x="6" y="10.3" width="9" height="4.6" rx="1" fill="#12213a"/><rect x="16.8" y="10.3" width="9" height="4.6" rx="1" fill="#12213a"/><path d="M29.4 10.6 L33.2 15 L29.4 15 Z" fill="#12213a"/><circle cx="11" cy="21.2" r="3.5" fill="#12213a"/><circle cx="11" cy="21.2" r="1.3" fill="#fff"/><circle cx="32" cy="21.2" r="3.5" fill="#12213a"/><circle cx="32" cy="21.2" r="1.3" fill="#fff"/>`,
  MINIBUS: `<path d="M4 20.5 L4 9.5 C4 8.4 4.9 7.5 6 7.5 L34 7.5 C35.1 7.5 36 8.4 36 9.5 L36 19.5 C36 20.1 35.6 20.5 35 20.5 Z"/><rect x="6.4" y="9.7" width="6" height="4.4" rx="1" fill="#12213a"/><rect x="13.4" y="9.7" width="6" height="4.4" rx="1" fill="#12213a"/><rect x="20.4" y="9.7" width="6" height="4.4" rx="1" fill="#12213a"/><rect x="27.4" y="9.7" width="6.2" height="4.4" rx="1" fill="#12213a"/><circle cx="11" cy="21.2" r="3.5" fill="#12213a"/><circle cx="11" cy="21.2" r="1.3" fill="#fff"/><circle cx="29" cy="21.2" r="3.5" fill="#12213a"/><circle cx="29" cy="21.2" r="1.3" fill="#fff"/>`,
  BUS: `<path d="M2 20.5 L2 9 C2 7.9 2.9 7 4 7 L38 7 C39.1 7 40 7.9 40 9 L40 19.5 C40 20.1 39.6 20.5 39 20.5 Z"/><rect x="4.4" y="9.2" width="6" height="4.7" rx="1" fill="#12213a"/><rect x="11.4" y="9.2" width="6" height="4.7" rx="1" fill="#12213a"/><rect x="18.4" y="9.2" width="6" height="4.7" rx="1" fill="#12213a"/><rect x="25.4" y="9.2" width="6" height="4.7" rx="1" fill="#12213a"/><rect x="32.4" y="9.2" width="5.2" height="4.7" rx="1" fill="#12213a"/><circle cx="9" cy="21.2" r="3.5" fill="#12213a"/><circle cx="9" cy="21.2" r="1.3" fill="#fff"/><circle cx="33" cy="21.2" r="3.5" fill="#12213a"/><circle cx="33" cy="21.2" r="1.3" fill="#fff"/>`,
  CUSTER: `<path d="M6 20.5 L6 10 C6 8.9 6.9 8 8 8 L31 8 C32.1 8 33 8.9 33 10 L33 19.5 C33 20.1 32.6 20.5 32 20.5 Z"/><rect x="8.4" y="10.2" width="5.4" height="4.1" rx="1" fill="#12213a"/><rect x="14.8" y="10.2" width="5.4" height="4.1" rx="1" fill="#12213a"/><rect x="21.2" y="10.2" width="5.4" height="4.1" rx="1" fill="#12213a"/><rect x="27.6" y="10.2" width="3.6" height="4.1" rx="1" fill="#12213a"/><circle cx="12" cy="21.2" r="3.5" fill="#12213a"/><circle cx="12" cy="21.2" r="1.3" fill="#fff"/><circle cx="27" cy="21.2" r="3.5" fill="#12213a"/><circle cx="27" cy="21.2" r="1.3" fill="#fff"/>`,
};
// Persona (conductor sin vehículo asignado).
const PERSONA_SVG = `<circle cx="12" cy="8" r="4" fill="#fff"/><path d="M4 21 C4 15.5 7.6 13 12 13 C16.4 13 20 15.5 20 21 Z" fill="#fff"/>`;

function catKey(cat: string | null): keyof typeof VEH_SVG {
  const c = (cat || "").toUpperCase().trim();
  if (c in VEH_SVG) return c as keyof typeof VEH_SVG;
  if (c.includes("SPRINTER")) return "VAN";
  if (c.includes("COASTER") || c.includes("COSTER") || c.includes("CUSTER") || c.includes("CÚSTER")) return "CUSTER";
  if (c.includes("MINI")) return "MINIBUS";
  if (c.includes("VAN")) return "VAN";
  if (c.includes("SUV") || c.includes("CAMIONETA") || c.includes("PICKUP")) return "SUV";
  if (c.includes("AUTO") || c.includes("SEDAN") || c.includes("SEDÁN") || c.includes("TAXI") || c.includes("CAR")) return "AUTO";
  return "BUS";
}
const CAT_LABEL: Record<keyof typeof VEH_SVG, string> = {
  AUTO: "Auto", SUV: "Camioneta", VAN: "Van / Sprinter", MINIBUS: "Minibús", BUS: "Bus", CUSTER: "Cúster",
};
function svgVehiculo(cat: string | null, size = 30, fill = "#fff"): string {
  return `<svg viewBox="0 0 44 28" width="${size}" height="${Math.round((size * 28) / 44)}" fill="${fill}" style="display:block">${VEH_SVG[catKey(cat)]}</svg>`;
}

// Componente React del mismo icono (para la lista lateral).
function IconVeh({ cat, size = 22, color = "#fff" }: { cat: string | null; size?: number; color?: string }) {
  return <span style={{ display: "inline-flex" }} dangerouslySetInnerHTML={{ __html: svgVehiculo(cat, size, color) }} />;
}

// Inyecta una sola vez el CSS de los marcadores (badge + placa + pulso SOS).
function inyectarEstilosMarcador() {
  if (document.getElementById("afa-marker-css")) return;
  const st = document.createElement("style");
  st.id = "afa-marker-css";
  st.textContent = `
    .afa-mk{display:flex;flex-direction:column;align-items:center;will-change:transform}
    .afa-badge{width:40px;height:40px;border-radius:12px;border:2.5px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;cursor:pointer}
    .afa-badge.sos{width:48px;height:48px;border-color:#fecaca;position:relative}
    .afa-badge.sos::after{content:"";position:absolute;inset:-6px;border-radius:16px;border:3px solid #dc2626;animation:afa-pulse 1.4s ease-out infinite;pointer-events:none}
    @keyframes afa-pulse{0%{transform:scale(.85);opacity:.9}100%{transform:scale(1.4);opacity:0}}
    .afa-plate{margin-top:3px;background:rgba(255,255,255,.98);color:#0b315f;font:800 10px/1.2 ui-monospace,SFMono-Regular,monospace;padding:1.5px 6px;border-radius:6px;box-shadow:0 1px 5px rgba(0,0,0,.35);white-space:nowrap;letter-spacing:.3px;border:1px solid rgba(0,0,0,.08);cursor:pointer}
    .afa-terc{margin-left:4px;background:#f59e0b;color:#3a2606;border-radius:4px;padding:0 3px;font-size:8px;font-weight:900;letter-spacing:0}
  `;
  document.head.appendChild(st);
}

// Llave compuesta NO ambigua para asociar puntos GPS a un movil/conductor en vivo.
// Prioriza la IDENTIDAD ESTABLE del móvil (conductor -> vehículo); reserva_id va al FINAL.
// Por qué NO reserva_id primero: con "Conectarse" (estilo Uber) un mismo conductor alterna
// reserva_id=null (conectado-libre, "disponible") y reserva_id=X (en servicio, "en_ruta") en
// una sola sesión. Si la clave fuera reserva_id, el MISMO móvil se partía en 2 marcadores
// (uno "en línea" y otro "rancio") y descuadraba los contadores. Por conductor/vehículo, colapsa
// a UN solo marcador aunque su reserva cambie.
// Importante: los IDs se solapan entre tablas AFA y _tercero, por eso el prefijo distingue el origen.
function keyGps(u: { reserva_id?: number | null; conductor_tercero_id?: number | null; conductor_id?: number | null; vehiculo_tercero_id?: number | null; vehiculo_id?: number | null; id?: number }): string {
  if (u.conductor_tercero_id != null) return `ct${u.conductor_tercero_id}`;
  if (u.conductor_id != null) return `c${u.conductor_id}`;
  if (u.vehiculo_tercero_id != null) return `vt${u.vehiculo_tercero_id}`;
  if (u.vehiculo_id != null) return `v${u.vehiculo_id}`;
  if (u.reserva_id != null) return `r${u.reserva_id}`;
  return `id${u.id}`;
}

function esVehiculoEventual(id: number, esTercero: boolean, reservasHoy: ReservaHoy[]): boolean | null {
  const res = reservasHoy.find(r => (esTercero ? r.vehiculo_tercero_id === id : r.vehiculo_id === id));
  if (!res) return null;
  return res.tipo_servicio_detalle !== "transporte_personal";
}

export default function MonitoreoPage() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map          = useRef<mapboxgl.Map | null>(null);
  const markers      = useRef<Record<string, mapboxgl.Marker>>({});

  const [ubicaciones,  setUbicaciones]  = useState<UbicacionGPS[]>([]);
  const [vehiculos,    setVehiculos]    = useState<Vehiculo[]>([]);
  const [conductores,  setConductores]  = useState<Conductor[]>([]);
  const [vehiculosTercero,  setVehiculosTercero]  = useState<VehiculoTercero[]>([]);
  const [conductoresTercero, setConductoresTercero] = useState<ConductorTercero[]>([]);
  const [empresasTercero, setEmpresasTercero] = useState<EmpresaTercero[]>([]);
  const [alertasSOS,   setAlertasSOS]   = useState<AlertaSOS[]>([]);
  const [reservasHoy,  setReservasHoy]  = useState<ReservaHoy[]>([]);
  const [mapListo,     setMapListo]     = useState(false);
  const [selKey,       setSelKey]       = useState<string | null>(null);
  const [ultimaAct,    setUltimaAct]    = useState<Date>(new Date());
  const [panelSOS,     setPanelSOS]     = useState(false);
  const [filtroServicio, setFiltroServicio] = useState<"todos" | "fijo" | "eventual">("todos");
  const [filtroFlota, setFiltroFlota] = useState<"todos" | "propia" | "tercero">("todos");
  const [busqueda, setBusqueda] = useState("");
  const [cargando, setCargando] = useState(false);
  const sosMarkers = useRef<mapboxgl.Marker[]>([]);

  useEffect(() => {
    if (!mapContainer.current || map.current) return;
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/streets-v12",
      center: [-77.0428, -12.0464],
      zoom: 11,
    });
    map.current.addControl(new mapboxgl.NavigationControl(), "top-right");
    map.current.addControl(new mapboxgl.FullscreenControl(), "top-right");
    map.current.on("load", () => { inyectarEstilosMarcador(); setMapListo(true); });
    return () => { map.current?.remove(); map.current = null; };
  }, []);

  const actualizarUbicaciones = async () => {
    const hace30min = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from("ubicaciones_gps")
      .select("*")
      .gte("created_at", hace30min)
      .order("timestamp", { ascending: false })
      .limit(500);
    if (!data) return;
    // Clave compuesta NO ambigua por móvil (ct/c/vt/v -> reserva_id). Ver keyGps().
    const latest: Record<string, UbicacionGPS> = {};
    data.forEach((u: UbicacionGPS) => {
      const key = keyGps(u);
      if (!latest[key] || new Date(u.timestamp) > new Date(latest[key].timestamp)) {
        latest[key] = u;
      }
    });
    setUbicaciones(Object.values(latest));
    setUltimaAct(new Date());
  };

  const cargarDatos = async () => {
    setCargando(true);
    const hoy = new Date().toISOString().split("T")[0];
    const [vRes, cRes, rRes, vtRes, ctRes, eRes] = await Promise.all([
      supabase.from("vehiculos").select("id,placa,categoria,marca,modelo"),
      supabase.from("conductores").select("id,nombre,telefono"),
      supabase.from("reservas").select("id,vehiculo_id,vehiculo_tercero_id,tipo_servicio_detalle").eq("fecha_servicio", hoy).in("estado", ["programada", "confirmada", "en_curso"]),
      supabase.from("vehiculos_tercero").select("id,placa,categoria,marca,modelo,empresa_id"),
      supabase.from("conductores_tercero").select("id,nombre,telefono"),
      supabase.from("empresas_tercerizadas").select("id,razon_social"),
    ]);
    setVehiculos(vRes.data || []);
    setConductores(cRes.data || []);
    setReservasHoy(rRes.data || []);
    setVehiculosTercero(vtRes.data || []);
    setConductoresTercero(ctRes.data || []);
    setEmpresasTercero(eRes.data || []);
    await actualizarUbicaciones();
    setCargando(false);
  };

  const cargarSOS = async () => {
    const { data } = await supabase
      .from("alertas_sos")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20);
    setAlertasSOS(data || []);
  };

  useEffect(() => {
    cargarDatos();
    cargarSOS();
    const timer = setInterval(actualizarUbicaciones, 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const ch = supabase.channel("monitoreo-gps")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_gps" },
        (payload: { new: UbicacionGPS }) => {
          const nueva = payload.new as UbicacionGPS;
          // Dedup por llave compuesta (NO por vehiculo_id: con null colisiona todo).
          const keyNueva = keyGps(nueva);
          setUbicaciones(prev => {
            const sin = prev.filter(u => keyGps(u) !== keyNueva);
            return [...sin, nueva];
          });
          setUltimaAct(new Date());
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  useEffect(() => {
    const ch = supabase.channel("monitoreo-sos")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "alertas_sos" },
        (payload: { new: AlertaSOS }) => {
          const nueva = payload.new as AlertaSOS;
          setAlertasSOS(prev => [nueva, ...prev]);
          setPanelSOS(true);
          try {
            const ctx = new AudioContext();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.frequency.value = 880; osc.type = "square"; gain.gain.value = 0.3;
            osc.start(); osc.stop(ctx.currentTime + 0.5);
            setTimeout(() => { osc.frequency.value = 660; osc.start(); osc.stop(ctx.currentTime + 0.5); }, 600);
          } catch {}
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  // Resuelve placa/nombre/categoría/proveedor de un punto GPS, priorizando tablas _tercero.
  const resolver = (u: UbicacionGPS) => {
    const vehT     = u.vehiculo_tercero_id != null ? vehiculosTercero.find(v => v.id === u.vehiculo_tercero_id) : null;
    const condT    = u.conductor_tercero_id != null ? conductoresTercero.find(c => c.id === u.conductor_tercero_id) : null;
    const vehAfa   = u.vehiculo_id != null ? vehiculos.find(v => v.id === u.vehiculo_id) : null;
    const condAfa  = u.conductor_id != null ? conductores.find(c => c.id === u.conductor_id) : null;
    const esTercero = u.vehiculo_tercero_id != null || u.conductor_tercero_id != null;
    const empresa  = vehT?.empresa_id != null ? empresasTercero.find(e => e.id === vehT.empresa_id) : null;
    return {
      placa: vehT?.placa || vehAfa?.placa || null,
      nombre: condT?.nombre || condAfa?.nombre || null,
      telefono: condT?.telefono || condAfa?.telefono || null,
      categoria: vehT?.categoria || vehAfa?.categoria || null,
      marca: vehT?.marca || vehAfa?.marca || null,
      modelo: vehT?.modelo || vehAfa?.modelo || null,
      esTercero,
      proveedor: empresa?.razon_social || null,
      sinVeh: u.vehiculo_id == null && u.vehiculo_tercero_id == null,
    };
  };

  useEffect(() => {
    if (!mapListo || !map.current) return;
    inyectarEstilosMarcador();
    // Quitar marcadores de entidades que ya no aparecen en el resultado (desconectadas)
    const keysActuales = new Set(ubicaciones.map(u => keyGps(u)));
    Object.keys(markers.current).forEach(key => {
      if (!keysActuales.has(key)) {
        markers.current[key].remove();
        delete markers.current[key];
      }
    });
    ubicaciones.forEach(u => {
      const info    = resolver(u);
      const min     = minutosDesde(u.timestamp);
      const color   = estadoColor(min);
      const esSOS   = u.estado === "sos";
      const key     = keyGps(u);

      // Crear elemento del marcador
      const el = document.createElement("div");
      el.className = "afa-mk";
      if (info.sinVeh) {
        // Conductor sin vehículo → badge con silueta de persona
        el.innerHTML =
          `<div class="afa-badge" style="background:${color}"><svg viewBox="0 0 24 24" width="22" height="22" style="display:block">${PERSONA_SVG}</svg></div>` +
          `<div class="afa-plate">${esc((info.nombre || "Conductor").split(" ")[0])}</div>`;
      } else {
        el.innerHTML =
          `<div class="afa-badge${esSOS ? " sos" : ""}" style="background:${esSOS ? "#dc2626" : color}">${svgVehiculo(info.categoria, 30)}</div>` +
          `<div class="afa-plate">${esc(info.placa || "#" + (u.vehiculo_tercero_id ?? u.vehiculo_id ?? ""))}${info.esTercero ? '<span class="afa-terc">3P</span>' : ""}</div>`;
      }

      const filaTel = info.telefono
        ? `<a href='tel:${esc(info.telefono)}' style='display:block;margin-top:8px;background:#0b315f;color:white;text-align:center;padding:6px;border-radius:8px;font-size:11px;text-decoration:none;'>${esc(info.telefono)}</a>`
        : "";
      const popupHtml = info.sinVeh
        ? `<div style='font-family:sans-serif;min-width:160px;padding:4px'><div style='font-weight:900;font-size:14px;color:#0b315f;margin-bottom:4px'>${esc(info.nombre || "Conductor")}</div><div style='font-size:11px;color:#9ca3af;margin-bottom:4px'>Sin vehículo asignado</div><div style='font-size:11px;font-weight:700;color:${color};'>${estadoLabel(min)}</div>${filaTel}</div>`
        : `<div style='font-family:sans-serif;min-width:190px;padding:4px'>` +
            `<div style='font-weight:900;font-size:14px;color:#0b315f;margin-bottom:2px'>${esc(info.placa || "#" + (u.vehiculo_tercero_id ?? u.vehiculo_id ?? ""))}${esSOS ? " ⚠ SOS" : ""}</div>` +
            `<div style='font-size:11px;color:#64748b;margin-bottom:4px'>${esc(CAT_LABEL[catKey(info.categoria)])}${info.marca ? " · " + esc([info.marca, info.modelo].filter(Boolean).join(" ")) : ""}</div>` +
            (info.esTercero ? `<div style='display:inline-block;font-size:10px;font-weight:800;color:#92400e;background:#fef3c7;border-radius:6px;padding:1px 6px;margin-bottom:4px'>Proveedor: ${esc(info.proveedor || "Tercerizado")}</div>` : "") +
            `<div style='font-size:12px;color:#374151;margin-bottom:2px'>${esc(info.nombre || "-")}</div>` +
            `<div style='font-size:12px;color:#374151;margin-bottom:4px'>${Math.round(u.velocidad || 0)} km/h</div>` +
            `<div style='font-size:11px;font-weight:700;color:${color};'>${estadoLabel(min)}</div>${filaTel}</div>`;

      if (markers.current[key]) {
        animarMarcador(markers.current[key], [Number(u.lng), Number(u.lat)]);
        markers.current[key].getElement().innerHTML = el.innerHTML;
        markers.current[key].getPopup()?.setHTML(popupHtml);
      } else {
        const popup = new mapboxgl.Popup({ offset: 25, closeButton: true }).setHTML(popupHtml);
        const marker = new mapboxgl.Marker({ element: el, anchor: "bottom" })
          .setLngLat([Number(u.lng), Number(u.lat)])
          .setPopup(popup)
          .addTo(map.current!);
        markers.current[key] = marker;
      }
    });
  }, [ubicaciones, vehiculos, conductores, vehiculosTercero, conductoresTercero, empresasTercero, mapListo]);

  useEffect(() => {
    if (!mapListo || !map.current) return;
    sosMarkers.current.forEach(m => m.remove());
    sosMarkers.current = [];
    alertasSOS.filter(a => !a.atendido).forEach(a => {
      const el = document.createElement("div");
      el.style.cssText = "width:38px;height:38px;border-radius:12px;background:#dc2626;border:3px solid #fca5a5;display:flex;align-items:center;justify-content:center;font-size:20px;box-shadow:0 0 22px rgba(220,38,38,0.85);cursor:pointer;color:white;font-weight:900;";
      el.innerHTML = "⚠";
      const m = new mapboxgl.Marker({ element: el }).setLngLat([Number(a.lng), Number(a.lat)]).addTo(map.current!);
      sosMarkers.current.push(m);
    });
  }, [alertasSOS, mapListo]);

  const centrar = (m: Movil) => {
    const u = ubicaciones.find(x => (m.esTercero ? x.vehiculo_tercero_id === m.id : x.vehiculo_id === m.id));
    if (!u || !map.current) return;
    setSelKey(m.key);
    map.current.flyTo({ center: [Number(u.lng), Number(u.lat)], zoom: 15, duration: 1200 });
    markers.current[keyGps(u)]?.togglePopup();
  };

  const atenderSOS = async (id: number) => {
    await supabase.from("alertas_sos").update({ atendido: true }).eq("id", id);
    setAlertasSOS(prev => prev.map(a => a.id === id ? { ...a, atendido: true } : a));
  };

  // ─── FLOTA UNIFICADA (propia + tercero) ───────────────────────────────────
  const moviles: Movil[] = useMemo(() => [
    ...vehiculos.map(v => ({ key: `v${v.id}`, id: v.id, placa: v.placa, categoria: v.categoria, marca: v.marca, modelo: v.modelo, esTercero: false, empresaId: null })),
    ...vehiculosTercero.map(v => ({ key: `vt${v.id}`, id: v.id, placa: v.placa || "—", categoria: v.categoria, marca: v.marca, modelo: v.modelo, esTercero: true, empresaId: v.empresa_id })),
  ], [vehiculos, vehiculosTercero]);

  const ubicDeMovil = (m: Movil): UbicacionGPS | undefined =>
    ubicaciones.find(u => (m.esTercero ? u.vehiculo_tercero_id === m.id : u.vehiculo_id === m.id));

  const sosPendientes = alertasSOS.filter(a => !a.atendido).length;

  const nombreEmpresa = (id: number | null) => (id != null ? empresasTercero.find(e => e.id === id)?.razon_social : null) || null;

  // Filtro + búsqueda + orden (con señal primero, por recencia)
  const movilesFiltrados = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return moviles
      .filter(m => {
        if (filtroFlota === "propia" && m.esTercero) return false;
        if (filtroFlota === "tercero" && !m.esTercero) return false;
        if (filtroServicio !== "todos") {
          const ev = esVehiculoEventual(m.id, m.esTercero, reservasHoy);
          if (ev === null) return false;
          if (filtroServicio === "fijo" && ev) return false;
          if (filtroServicio === "eventual" && !ev) return false;
        }
        if (q && !m.placa.toLowerCase().includes(q) && !(m.marca || "").toLowerCase().includes(q) && !(nombreEmpresa(m.empresaId) || "").toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => {
        const ua = ubicDeMovil(a), ub = ubicDeMovil(b);
        const ma = ua ? minutosDesde(ua.timestamp) : Infinity;
        const mb = ub ? minutosDesde(ub.timestamp) : Infinity;
        if (ma !== mb) return ma - mb;
        return a.placa.localeCompare(b.placa);
      });
  }, [moviles, filtroFlota, filtroServicio, busqueda, reservasHoy, ubicaciones, empresasTercero]);

  // KPIs coherentes con la lista: cuentan el estado de señal de los móviles que pasan los filtros
  // activos (flota / servicio / búsqueda), para que el panel y la lista lateral SIEMPRE concuerden.
  const kpi = useMemo(() => {
    const k = { enLinea: 0, inactivo: 0, desconectado: 0, sinGPS: 0 };
    for (const m of movilesFiltrados) {
      const u = ubicDeMovil(m);
      if (!u) { k.sinGPS++; continue; }
      const min = minutosDesde(u.timestamp);
      if (min <= 2) k.enLinea++;
      else if (min <= 10) k.inactivo++;
      else k.desconectado++;
    }
    return k;
  }, [movilesFiltrados, ubicaciones]);
  const conSenal = kpi.enLinea + kpi.inactivo + kpi.desconectado;

  const KpiFlota = ({ label, valor, color, bg }: { label: string; valor: number; color: string; bg: string }) => (
    <div className="rounded-xl p-2.5 text-center" style={{ background: bg }}>
      <p className="text-2xl font-black" style={{ color }}>{valor}</p>
      <p className="text-[10px] font-bold uppercase" style={{ color: color + "99" }}>{label}</p>
    </div>
  );

  return (
    <main className="h-screen flex flex-col" style={{ background: "#0f172a" }}>

      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0" style={{ background: "#0b315f", borderColor: "#1e3a5f" }}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "#0c2647" }}>
            <IconCrosshair size={20} color="#7dd3fc" />
          </div>
          <div>
            <h1 className="text-white font-black leading-tight">Monitoreo GPS</h1>
            <p className="text-blue-200 text-xs">Última actualización: {ultimaAct.toLocaleTimeString("es-PE")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {sosPendientes > 0 && (
            <button onClick={() => setPanelSOS(v => !v)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-black text-xs" style={{ background: "#dc2626", color: "white" }}>
              ⚠ SOS {sosPendientes}
            </button>
          )}
          <button onClick={cargarDatos} title="Actualizar" className="w-9 h-9 flex items-center justify-center rounded-lg text-white border border-blue-400/60 hover:bg-blue-500/20 transition-colors">
            <span className={cargando ? "animate-spin" : ""} style={{ display: "inline-flex" }}><IconRefresh size={16} color="#dbeafe" /></span>
          </button>
          <a href="/conductor" target="_blank" className="px-3 py-1.5 rounded-lg text-xs font-bold bg-green-600 text-white">App</a>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">

        <div className="w-72 flex flex-col border-r flex-shrink-0" style={{ background: "#0f172a", borderColor: "#1e293b" }}>

          <div className="grid grid-cols-2 gap-2 p-3 border-b flex-shrink-0" style={{ borderColor: "#1e293b" }}>
            <KpiFlota label="En línea"  valor={kpi.enLinea}      color="#16a34a" bg="#052e16" />
            <KpiFlota label="Inactivo"  valor={kpi.inactivo}     color="#d97706" bg="#1c1002" />
            <KpiFlota label="Sin señal" valor={kpi.desconectado} color="#dc2626" bg="#1c0202" />
            <KpiFlota label="Sin GPS"   valor={kpi.sinGPS}       color="#6b7280" bg="#111827" />
          </div>

          {/* BÚSQUEDA */}
          <div className="px-3 pt-3 flex-shrink-0">
            <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: "#1e293b" }}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#64748b" strokeWidth="2.2" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
              <input
                value={busqueda}
                onChange={e => setBusqueda(e.target.value)}
                placeholder="Buscar placa o proveedor…"
                className="bg-transparent outline-none text-xs text-white placeholder-gray-500 flex-1 min-w-0"
              />
              {busqueda && <button onClick={() => setBusqueda("")} className="text-gray-500 text-xs">✕</button>}
            </div>
          </div>

          {/* FILTRO FLOTA PROPIA / TERCERO */}
          <div className="px-3 pt-2 flex-shrink-0">
            <div className="flex gap-1 rounded-xl p-1" style={{ background: "#1e293b" }}>
              {(["todos", "propia", "tercero"] as const).map(t => (
                <button key={t} onClick={() => setFiltroFlota(t)}
                  className="flex-1 px-2 py-1.5 rounded-lg text-[10px] font-bold transition-all"
                  style={{ background: filtroFlota === t ? "#0b315f" : "transparent", color: filtroFlota === t ? "white" : "#6b7280" }}>
                  {t === "todos" ? "Toda la flota" : t === "propia" ? "Propia" : "Tercerizada"}
                </button>
              ))}
            </div>
          </div>

          {/* FILTRO FIJOS / EVENTUALES */}
          <div className="px-3 py-2 border-b flex-shrink-0" style={{ borderColor: "#1e293b" }}>
            <div className="flex gap-1 rounded-xl p-1" style={{ background: "#1e293b" }}>
              {(["todos", "fijo", "eventual"] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setFiltroServicio(t)}
                  className="flex-1 px-2 py-1.5 rounded-lg text-[10px] font-bold transition-all"
                  style={{
                    background: filtroServicio === t ? "#0b315f" : "transparent",
                    color: filtroServicio === t ? "white" : "#6b7280",
                  }}
                >
                  {t === "todos" ? "Todos" : t === "fijo" ? "Fijos" : "Eventuales"}
                </button>
              ))}
            </div>
          </div>

          {panelSOS && alertasSOS.length > 0 && (
            <div className="border-b flex-shrink-0" style={{ borderColor: "#1e293b" }}>
              <div className="px-3 py-2 flex items-center justify-between" style={{ background: "#1c0202" }}>
                <p className="text-red-400 font-black text-xs uppercase tracking-widest">Alertas SOS</p>
                <button onClick={() => setPanelSOS(false)} className="text-gray-500 text-xs">✕</button>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {alertasSOS.map(a => {
                  const cond = conductores.find(c => c.id === a.conductor_id);
                  const veh  = vehiculos.find(v => v.id === a.vehiculo_id);
                  return (
                    <div key={a.id} className="px-3 py-2.5 border-b" style={{ background: a.atendido ? "#111827" : "#1c0202", borderColor: "#1e293b" }}>
                      <div className="flex justify-between items-start gap-2">
                        <div>
                          <p className="text-xs font-black" style={{ color: a.atendido ? "#6b7280" : "#f87171" }}>
                            {a.atendido ? "Atendido" : "PENDIENTE"}
                          </p>
                          <p className="text-[11px] text-gray-300 mt-0.5">{cond?.nombre || "-"}</p>
                          <p className="text-[10px] text-gray-500">{veh?.placa} · {new Date(a.created_at).toLocaleTimeString("es-PE")}</p>
                        </div>
                        {!a.atendido && (
                          <button onClick={() => atenderSOS(a.id)} className="px-2 py-1 rounded-lg text-[10px] font-bold text-white flex-shrink-0" style={{ background: "#166534" }}>
                            Atendido
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-600 px-2 py-1">
              {movilesFiltrados.length} unidades · {conSenal} con señal
            </p>

            {movilesFiltrados.map(m => {
              const u    = ubicDeMovil(m);
              const info = u ? resolver(u) : null;
              const min  = u ? minutosDesde(u.timestamp) : null;
              const color = min !== null ? estadoColor(min) : "#6b7280";
              const activo = selKey === m.key;
              const esSOS = u?.estado === "sos";
              const tipoServicio = esVehiculoEventual(m.id, m.esTercero, reservasHoy);
              const proveedor = m.esTercero ? nombreEmpresa(m.empresaId) : null;

              return (
                <div
                  key={m.key}
                  onClick={() => u && centrar(m)}
                  className="rounded-xl p-3 border transition-all"
                  style={{
                    background: esSOS ? "#1c0202" : activo ? "#1e3a5f" : "#1e293b",
                    borderColor: esSOS ? "#dc2626" : activo ? "#3b82f6" : "#334155",
                    cursor: u ? "pointer" : "default",
                    opacity: u ? 1 : 0.65,
                  }}
                >
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: color + "22" }}>
                      <IconVeh cat={m.categoria} size={24} color={color} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-black text-white font-mono text-sm truncate">{m.placa}</span>
                        <span className="text-[10px] font-bold flex-shrink-0" style={{ color: esSOS ? "#f87171" : color }}>
                          {esSOS ? "SOS" : min !== null ? estadoLabel(min) : "Sin GPS"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <p className="text-[11px] text-gray-400 truncate">{CAT_LABEL[catKey(m.categoria)]}{info?.nombre ? " · " + info.nombre.split(" ")[0] : ""}</p>
                        {m.esTercero && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-black px-1.5 py-0.5 rounded-full flex-shrink-0" style={{ background: "#3a2606", color: "#fbbf24" }}>
                            <IconBuilding size={9} color="#fbbf24" /> 3P
                          </span>
                        )}
                        {tipoServicio !== null && (
                          <span
                            className="text-[9px] font-black px-1.5 py-0.5 rounded-full flex-shrink-0"
                            style={{
                              background: tipoServicio ? "#1e1b4b" : "#0c1a2e",
                              color: tipoServicio ? "#818cf8" : "#60a5fa",
                            }}
                          >
                            {tipoServicio ? "Eventual" : "Fijo"}
                          </span>
                        )}
                      </div>
                      {proveedor && <p className="text-[10px] text-amber-500/80 truncate mt-0.5">{proveedor}</p>}
                      {u && <p className="text-[10px] text-gray-600 mt-0.5">{Math.round(u.velocidad || 0)} km/h</p>}
                    </div>
                  </div>
                </div>
              );
            })}

            {movilesFiltrados.length === 0 && (
              <div className="text-center py-10 text-gray-600">
                <div className="flex justify-center mb-2"><IconBus size={34} color="#475569" /></div>
                <p className="text-xs">
                  {busqueda ? "Sin coincidencias para «" + busqueda + "»" : "Sin unidades para este filtro"}
                </p>
              </div>
            )}
          </div>

          <div className="p-3 border-t flex-shrink-0 text-xs text-gray-600 text-center" style={{ borderColor: "#1e293b" }}>
            <div className="flex items-center justify-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              Actualización en tiempo real
            </div>
          </div>
        </div>

        <div className="flex-1 relative">
          <div ref={mapContainer} className="w-full h-full" />

          <div className="absolute bottom-6 left-4 rounded-xl px-3 py-2.5 text-xs space-y-1.5" style={{ background: "rgba(15,23,42,0.95)" }}>
            <p className="text-gray-400 font-bold uppercase tracking-wide text-[10px]">Estado de señal</p>
            {[
              { color: "#16a34a", label: "En línea (menos 2 min)" },
              { color: "#d97706", label: "Inactivo (2-10 min)" },
              { color: "#dc2626", label: "Sin señal (más 10 min)" },
            ].map(s => (
              <div key={s.label} className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
                <span className="text-gray-400">{s.label}</span>
              </div>
            ))}
            <div className="pt-1 mt-1 border-t" style={{ borderColor: "#334155" }}>
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded flex items-center justify-center" style={{ background: "#16a34a" }}><IconVeh cat="BUS" size={16} /></div>
                <span className="text-gray-400">Ícono = tipo de unidad</span>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[8px] font-black px-1 rounded" style={{ background: "#f59e0b", color: "#3a2606" }}>3P</span>
                <span className="text-gray-400">Proveedor tercerizado</span>
              </div>
            </div>
          </div>

          {ubicaciones.length === 0 && mapListo && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="rounded-2xl px-6 py-5 text-center" style={{ background: "rgba(15,23,42,0.92)" }}>
                <p className="text-white font-bold">Sin ubicaciones GPS activas</p>
                <p className="text-gray-400 text-sm mt-1">Los conductores deben iniciar servicio en la app</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
