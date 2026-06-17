"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { Calendar, FileText, Pencil, Trash2, X } from "lucide-react";
import {
  ESTADOS_RESERVA, ESTADOS_RESERVA_LISTA, ORDEN_ESTADO,
  ESTADOS_ADMIN, ESTADOS_ADMIN_LISTA, aplicaAdmin, ESTADO_ADMIN_INICIAL, etiquetaAdmin, siguienteAdmin,
} from "@/lib/estados";
import type { EstadoReserva, EstadoAdmin } from "@/lib/estados";
import ModalManifiesto from "@/components/programacion/ModalManifiesto";
import ModalGenerarPrograma from "@/components/programacion/ModalGenerarPrograma";
import TimelineParadasEditable from "@/components/programacion/TimelineParadasEditable";

// ── Google Maps Places para el formulario inline de paradas ──────────────
function useGoogleMapsLoaded() {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if ((window as any).google?.maps?.places) { setLoaded(true); return; }
    const ex = document.getElementById("gmaps-script");
    if (ex) {
      const h = () => setLoaded(true);
      ex.addEventListener("load", h);
      return () => ex.removeEventListener("load", h);
    }
    const s = document.createElement("script");
    s.id = "gmaps-script";
    s.src = `https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}&libraries=places&language=es&region=PE`;
    s.async = true; s.defer = true; s.onload = () => setLoaded(true);
    document.head.appendChild(s);
  }, []);
  return loaded;
}

type PlaceParada = { nombre: string; direccion: string; lat: number; lng: number };

function ParadaPlacesInput({ value, onChange, onSelect, onEnter, mapsLoaded }: {
  value: string;
  onChange: (v: string) => void;
  onSelect: (r: PlaceParada) => void;
  onEnter?: () => void;
  mapsLoaded: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const acRef = useRef<any>(null);

  useEffect(() => {
    if (!mapsLoaded || !inputRef.current || acRef.current) return;
    acRef.current = new (window as any).google.maps.places.Autocomplete(inputRef.current, {
      componentRestrictions: { country: "pe" },
      fields: ["formatted_address", "geometry", "name"],
      types: ["geocode", "establishment"],
    });
    acRef.current.addListener("place_changed", () => {
      const p = acRef.current.getPlace();
      if (!p.geometry?.location) return;
      const pName = p.name || "";
      const pAddr = p.formatted_address || "";
      // Igual que cotizaciones: si el nombre no está en la dirección, lo prepone
      const nombre = pName && pAddr && !pAddr.toLowerCase().includes(pName.toLowerCase())
        ? `${pName}, ${pAddr}` : pAddr || pName;
      onChange(nombre);
      onSelect({ nombre, direccion: pAddr, lat: p.geometry.location.lat(), lng: p.geometry.location.lng() });
    });
  }, [mapsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      onKeyDown={e => e.key === "Enter" && onEnter?.()}
      placeholder="Nombre / dirección de la parada"
      className="flex-1 text-xs bg-transparent outline-none text-gray-700 placeholder-gray-300 min-w-0"
    />
  );
}

type ParadaTP = {
  id: string; tipo: "inicio" | "intermedia" | "destino";
  nombre: string; direccion: string; lat: string; lng: string; hora: string;
};

// EstadoReserva, ESTADOS_RESERVA, ORDEN_ESTADO, dimensión administrativa, etc. → @/lib/estados (fuente única)

type Cliente            = { id: number; nombre: string; empresa?: string; tipo?: string; };
type Vehiculo           = { id: number; placa: string; categoria?: string; estado?: string; estado_operativo?: string; capacidad_pasajeros?: number; };
type Conductor          = { id: number; nombre: string; licencia?: string; vencimiento_licencia?: string; estado?: string; telefono?: string; };
type EmpresaTercerizada = { id: number; razon_social: string; ruc?: string | null; telefono?: string | null; estado: string; };
type VehiculoTercero    = { id: number; empresa_id: number; placa: string; categoria?: string | null; capacidad?: number | null; estado: string; marca?: string | null; };
type ConductorTercero   = { id: number; empresa_id: number; nombre: string; licencia?: string | null; vencimiento_licencia?: string | null; telefono?: string | null; estado: string; };
type DocumentoTercero   = { id: number; empresa_id: number; tipo: string; fecha_vencimiento?: string | null; };

type Reserva = {
  id: number; cliente_id: number | null; cotizacion_id: number | null;
  vehiculo_id: number | null; conductor_id: number | null;
  tipo: string; estado: EstadoReserva; estado_admin: EstadoAdmin | null;
  fecha_servicio: string | null; hora_servicio: string | null;
  precio_cliente: number; costo_proveedor: number; margen: number;
  observaciones: string | null; created_at: string;
  tipo_asignacion: string | null;
  empresa_tercerizada_id: number | null;
  vehiculo_tercero_id: number | null;
  conductor_tercero_id: number | null;
  paradas_json: any[] | null;
  tipo_servicio_detalle: string | null;
  sincronizado_app?: boolean;
  fecha_sincronizacion?: string | null;
  token_seguimiento?: string | null;
  token_conductor_tercero?: string | null;
  token_expira_at?: string | null;
  reserva_vinculada_id?: number | null;
  direccion_servicio?: string | null;
};

type Ocupacion = {
  reserva_id: number;
  capacidad: number | null;
  total_pasajeros: number;
  abordados: number;
  pendientes: number;
  sobrecupo: boolean;
  ocupacion_pct: number | null;
};

// Alias local a la fuente única (lib/estados.ts). NO redefinir colores/etiquetas aquí.
const ESTADO_CFG = ESTADOS_RESERVA;

const FORM_VACIO = {
  fecha_servicio: "", hora_servicio: "", tipo_asignacion: "propio",
  estado: "pendiente" as EstadoReserva,
  vehiculo_id: "", conductor_id: "",
  empresa_tercerizada_id: "", vehiculo_tercero_id: "", conductor_tercero_id: "",
  costo_proveedor: "", observaciones: "",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

const TIPOS_SERVICIO_FIJO = new Set([
  "transporte_personal",
  "fijo_solo_ida",
  "fijo_multiparada",
  "fijo_reten",
]);

function esEventual(r: Reserva): boolean {
  return !TIPOS_SERVICIO_FIJO.has(r.tipo_servicio_detalle || "");
}

function fmtSoles(n: number) {
  return "S/ " + n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Fecha en zona horaria Lima (UTC-5 fijo — Perú no usa horario de verano).
// NO usar Intl.DateTimeFormat("en-CA") sin opciones explícitas: el formato varía por versión
// de Node/browser y puede devolver la fecha incorrecta.
function fechaLima(offsetDias = 0): string {
  const ms = Date.now() - 5 * 3600 * 1000 + offsetDias * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtFecha(f: string | null) {
  if (!f) return "-";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function diasPara(f: string | null): number | null {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
}

function urgenciaBadge(fecha: string | null, estado: EstadoReserva): { label: string; color: string } | null {
  if (!fecha || estado === "finalizada" || estado === "cancelada") return null;
  const hS = fechaLima();
  const mS = fechaLima(1);
  const e7 = fechaLima(7);
  if (fecha < hS)  return { label: "ATRASADO",  color: "#6b7280" };
  if (fecha === hS) return { label: "HOY",       color: "#ef4444" };
  if (fecha === mS) return { label: "MAÑANA",    color: "#f97316" };
  if (fecha <= e7)  return { label: "ESTA SEM.", color: "#eab308" };
  return null;
}

function urgenciaFila(fecha: string | null, estado: EstadoReserva): string | undefined {
  if (!fecha || estado === "finalizada" || estado === "cancelada") return undefined;
  const hS = fechaLima();
  const mS = fechaLima(1);
  const e7 = fechaLima(7);
  if (fecha < hS)   return "inset 3px 0 0 #9ca3af";
  if (fecha === hS) return "inset 3px 0 0 #ef4444";
  if (fecha === mS) return "inset 3px 0 0 #f97316";
  if (fecha <= e7)  return "inset 3px 0 0 #eab308";
  return undefined;
}

function inputCls(extra = "") {
  return "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all " + extra;
}

function Campo({ label, span, children }: { label: string; span?: number; children: React.ReactNode }) {
  return (
    <div className={span === 2 ? "md:col-span-2" : span === 3 ? "md:col-span-3" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

function riesgoEmpresa(docs: DocumentoTercero[], empresaId: number): "alto" | "ok" {
  const OBLIGATORIOS = ["SOAT", "Revision Tecnica (CITV)", "Habilitacion SUTRAN", "Permiso Operacion MTC"];
  const docsEmp = docs.filter(d => d.empresa_id === empresaId);
  const vencidos = docsEmp.filter(d => OBLIGATORIOS.includes(d.tipo) && diasPara(d.fecha_vencimiento || null) !== null && diasPara(d.fecha_vencimiento || null)! < 0);
  return vencidos.length > 0 ? "alto" : "ok";
}

// ─── Geocodificación via Google Maps Geocoding API ───────────────────────────

async function geocodificar(direccion: string): Promise<{ lat: number; lng: number } | null> {
  if (!direccion.trim()) return null;
  try {
    const res = await fetch("/api/geocodificar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paradas: [{ id: 0, nombre: direccion }] }),
    });
    const data = await res.json();
    if (res.ok && data.paradas?.[0]?.lat != null) {
      return { lat: data.paradas[0].lat, lng: data.paradas[0].lng };
    }
  } catch {}
  return null;
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function ReservasPage() {
  const [clientes,     setClientes]     = useState<Cliente[]>([]);
  const [vehiculos,    setVehiculos]    = useState<Vehiculo[]>([]);
  const [conductores,  setConductores]  = useState<Conductor[]>([]);
  const [empresasTer,  setEmpresasTer]  = useState<EmpresaTercerizada[]>([]);
  const [vehTercero,   setVehTercero]   = useState<VehiculoTercero[]>([]);
  const [condTercero,  setCondTercero]  = useState<ConductorTercero[]>([]);
  const [docsTercero,  setDocsTercero]  = useState<DocumentoTercero[]>([]);
  const [reservas,     setReservas]     = useState<Reserva[]>([]);
  const [ocupacionMap, setOcupacionMap] = useState<Record<number, Ocupacion>>({});
  const [loading,      setLoading]      = useState(false);
  const [guardando,    setGuardando]    = useState(false);
  const [paradasMap,   setParadasMap]   = useState<Record<number, any[]>>({});
  const [cargandoPar,  setCargandoPar]  = useState<Record<number, boolean>>({});
  const [pasajerosCliente, setPasajerosCliente] = useState<Record<number, any[]>>({});
  const [pasajerosAsig,    setPasajerosAsig]    = useState<Record<number, number[]>>({});
  const [cargandoPas,      setCargandoPas]      = useState<Record<number, boolean>>({});
  const [paradaSelPas,     setParadaSelPas]     = useState<Record<number, number | null>>({});
  const [guardandoPas,     setGuardandoPas]     = useState<Record<number, boolean>>({});
  const [editandoId,   setEditandoId]   = useState<number | null>(null);
  const [expandidoId,  setExpandidoId]  = useState<number | null>(null);
  const [mostrarForm,  setMostrarForm]  = useState(false);
  const [busqueda,     setBusqueda]     = useState("");
  const [filtroEstado, setFiltroEstado] = useState("todos");
  const [filtroTipo,   setFiltroTipo]   = useState("todos");
  const [filtroServicio, setFiltroServicio] = useState<"todos" | "fijo" | "eventual">("todos");
  const [form, setForm] = useState(FORM_VACIO);
  const [modalReservaId,       setModalReservaId]       = useState<number | null>(null);
  const [mostrarModalPrograma, setMostrarModalPrograma] = useState(false);
  const [expandidoContrato,    setExpandidoContrato]    = useState<string | null>(null);
  const [modalLinksId,         setModalLinksId]         = useState<number | null>(null);
  const [confirmEliminarId,    setConfirmEliminarId]    = useState<number | null>(null);
  const [modalFinalizar,       setModalFinalizar]       = useState<{ id: number; motivo: string } | null>(null);
  const [modalAsignarBloque,   setModalAsignarBloque]   = useState<{ cotizacionId: number | null; sinAsignar: Reserva[]; todasLasFilas: Reserva[] } | null>(null);
  const [asignarVehId,         setAsignarVehId]         = useState<string>("");
  const [asignarCondId,        setAsignarCondId]        = useState<string>("");
  const [asignando,            setAsignando]            = useState(false);
  const [bloqueScope,          setBloqueScope]          = useState<"pendientes" | "rango">("pendientes");
  const [bloqueFechaDesde,     setBloqueFechaDesde]     = useState("");
  const [bloqueFechaHasta,     setBloqueFechaHasta]     = useState("");
  const [generandoToken,       setGenerandoToken]       = useState<string | null>(null);
  const [copiadoKey,           setCopiadoKey]           = useState<string | null>(null);
  const [filtroDesde,          setFiltroDesde]          = useState("");
  const [filtroHasta,          setFiltroHasta]          = useState("");
  const [filtroPorAsignar,     setFiltroPorAsignar]     = useState(false);
  const [vistaAgenda,          setVistaAgenda]          = useState(false);
  // ── Paradas inline ──────────────────────────────────────────────────────
  const mapsLoaded = useGoogleMapsLoaded();
  const [nuevoParNombre,       setNuevoParNombre]       = useState<Record<number, string>>({});
  const [nuevoParHora,         setNuevoParHora]         = useState<Record<number, string>>({});
  const [nuevoParDir,          setNuevoParDir]          = useState<Record<number, string>>({});
  const [nuevoParLat,          setNuevoParLat]          = useState<Record<number, number>>({});
  const [nuevoParLng,          setNuevoParLng]          = useState<Record<number, number>>({});
  const [agregandoPar2,        setAgregandoPar2]        = useState<Record<number, boolean>>({});
  const [modalAplicarMasivo,   setModalAplicarMasivo]   = useState<{
    cotizacion_id: number;
    payload: Record<string, any>;
    otrasReservas: Reserva[];
    resumen: string; // "Vehículo · Conductor" para mostrar en el modal
  } | null>(null);
  const [aplicarScope,         setAplicarScope]         = useState<"todos" | "rango">("todos");
  const [aplicarDesde,         setAplicarDesde]         = useState("");
  const [aplicarHasta,         setAplicarHasta]         = useState("");
  const [aplicando,            setAplicando]            = useState(false);
  const [sincCoords,           setSincCoords]           = useState<{ activo: boolean; msg: string }>({ activo: false, msg: "" });

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  const cargarOcupaciones = async () => {
    const { data } = await supabase.from("reservas_ocupacion").select("*");
    const map: Record<number, Ocupacion> = {};
    (data || []).forEach((o: any) => { map[o.reserva_id] = o; });
    setOcupacionMap(map);
  };

  const cargarPasajerosAsignados = async (reservaId: number, paradaId?: number) => {
    const paradas = paradasMap[reservaId] || [];
    if (paradaId) {
      const { data } = await supabase.from("pasajeros_parada").select("pasajero_id").eq("parada_id", paradaId);
      setPasajerosAsig(prev => ({ ...prev, [reservaId]: (data || []).map((p: any) => p.pasajero_id) }));
    } else if (paradas.length > 0) {
      const { data } = await supabase.from("pasajeros_parada").select("pasajero_id").in("parada_id", paradas.map((p: any) => p.id));
      const unique = [...new Set((data || []).map((p: any) => p.pasajero_id))];
      setPasajerosAsig(prev => ({ ...prev, [reservaId]: unique as number[] }));
    }
  };

  const guardarPasajerosEnParada = async (reservaId: number, paradaId: number, seleccionados: number[]) => {
    setGuardandoPas(prev => ({ ...prev, [reservaId]: true }));
    await supabase.from("pasajeros_parada").delete().eq("parada_id", paradaId);
    if (seleccionados.length > 0) {
      await supabase.from("pasajeros_parada").insert(
        seleccionados.map(pid => ({ parada_id: paradaId, pasajero_id: pid, estado_abordaje: "Pendiente" }))
      );
    }
    setGuardandoPas(prev => ({ ...prev, [reservaId]: false }));
    await cargarPasajerosAsignados(reservaId, paradaId);
    await cargarOcupaciones();
    alert(seleccionados.length + " pasajeros asignados");
  };

  // ── Sincronización masiva de coordenadas (cotización → tabla paradas) ──────
  // Rellena o actualiza lat/lng usando las coords EXACTAS de la cotización vinculada.
  // Match 1°: por nombre exacto. Match 2°: por orden (posición) cuando el nombre cambió.
  // Geocodifica solo cuando no hay fuente exacta ni coincidencia por orden.
  const sincronizarCoordenadas = async () => {
    if (sincCoords.activo) return;
    if (!confirm("Sincronizar coordenadas de todas las paradas desde la cotización vinculada.\n\nActualiza también paradas cuyos coords cambiaron en la cotización. ¿Continuar?")) return;
    setSincCoords({ activo: true, msg: "Buscando paradas…" });

    // 1. TODAS las paradas (no solo las sin coords, para detectar cambios en la cotización)
    const { data: todasParadas, error: e1 } = await supabase
      .from("paradas").select("id,reserva_id,nombre,orden,lat,lng");
    if (e1) { alert("Error: " + e1.message); setSincCoords({ activo: false, msg: "" }); return; }
    if (!todasParadas || todasParadas.length === 0) { alert("No hay paradas."); setSincCoords({ activo: false, msg: "" }); return; }

    // 2. Agrupar por reserva
    const porReserva = new Map<number, any[]>();
    todasParadas.forEach((p: any) => { if (!porReserva.has(p.reserva_id)) porReserva.set(p.reserva_id, []); porReserva.get(p.reserva_id)!.push(p); });
    const reservaIds = [...porReserva.keys()];

    // 3. Cargar reservas (cotizacion_id + paradas_json propio + dirección para elegir tramo)
    const { data: resData } = await supabase
      .from("reservas").select("id,cotizacion_id,paradas_json,direccion_servicio").in("id", reservaIds);
    const resMap = new Map<number, any>((resData || []).map((r: any) => [r.id, r]));

    // 4. Cargar cotizaciones vinculadas
    const cotIds = [...new Set((resData || []).map((r: any) => r.cotizacion_id).filter(Boolean))];
    const cotMap = new Map<number, any>();
    if (cotIds.length > 0) {
      const { data: cots } = await supabase.from("cotizaciones").select("id,paradas_json,paradas_retorno_json").in("id", cotIds);
      (cots || []).forEach((c: any) => cotMap.set(c.id, c));
    }

    // Helper: ordena paradas_json igual que resolverParadasJSON
    const sortLeg = (arr: any[]) => [
      ...arr.filter((p: any) => p.tipo === "inicio"),
      ...arr.filter((p: any) => p.tipo === "intermedia"),
      ...arr.filter((p: any) => p.tipo === "destino"),
      ...arr.filter((p: any) => !["inicio", "intermedia", "destino"].includes(p.tipo)),
    ];

    // 5. Procesar reserva por reserva
    let exactas = 0, actualizadas = 0, geocod = 0, fallidas = 0, procesadas = 0;
    for (const rid of reservaIds) {
      procesadas++;
      setSincCoords({ activo: true, msg: `Procesando ${procesadas}/${reservaIds.length} reservas…` });
      const r = resMap.get(rid);
      const cot = r?.cotizacion_id ? cotMap.get(r.cotizacion_id) : null;

      // Mapa nombre → coords (todas las fuentes, para match 1°)
      const fuentes: any[] = [];
      if (cot?.paradas_json) fuentes.push(...cot.paradas_json);
      if (cot?.paradas_retorno_json) fuentes.push(...cot.paradas_retorno_json);
      if (r?.paradas_json) fuentes.push(...r.paradas_json);
      const byNombre = new Map<string, { lat: number; lng: number }>();
      fuentes.forEach((p: any) => { if (p.lat && p.lng) byNombre.set(String(p.nombre || "").trim().toLowerCase(), { lat: Number(p.lat), lng: Number(p.lng) }); });

      // Lista ordenada del tramo correcto (para match 2° por posición/orden)
      let fuenteOrdenada: any[] = [];
      if (Array.isArray(r?.paradas_json) && r.paradas_json.length > 0) {
        fuenteOrdenada = sortLeg(r.paradas_json);
      } else if (cot) {
        if (r?.direccion_servicio === "retorno") {
          const ret = Array.isArray(cot.paradas_retorno_json) && cot.paradas_retorno_json.length > 0
            ? cot.paradas_retorno_json : cot.paradas_json;
          if (Array.isArray(ret)) fuenteOrdenada = sortLeg(ret);
        } else if (Array.isArray(cot.paradas_json)) {
          fuenteOrdenada = sortLeg(cot.paradas_json);
        }
      }

      for (const par of (porReserva.get(rid) || [])) {
        // Match 1°: por nombre exacto
        let srcCoords = byNombre.get(String(par.nombre || "").trim().toLowerCase());
        let srcNombre: string | null = null;

        // Match 2°: por orden (posición en la lista ordenada del tramo)
        if (!srcCoords && fuenteOrdenada.length > 0) {
          const cotPar = fuenteOrdenada[par.orden - 1]; // orden es 1-based
          if (cotPar?.lat && cotPar?.lng) {
            srcCoords = { lat: Number(cotPar.lat), lng: Number(cotPar.lng) };
            srcNombre = cotPar.nombre || null; // también actualizar nombre si cambió
          }
        }

        if (srcCoords) {
          const tieneCoords = par.lat != null && par.lng != null;
          const dLat = tieneCoords ? Math.abs(Number(par.lat) - srcCoords.lat) : Infinity;
          const dLng = tieneCoords ? Math.abs(Number(par.lng) - srcCoords.lng) : Infinity;
          const coordsCambiaron = dLat > 0.0001 || dLng > 0.0001;

          if (!tieneCoords) {
            // Sin coords: rellenar
            const upd: any = { lat: srcCoords.lat, lng: srcCoords.lng };
            if (srcNombre) upd.nombre = srcNombre;
            await supabase.from("paradas").update(upd).eq("id", par.id);
            exactas++;
          } else if (coordsCambiaron) {
            // Coords desactualizadas respecto a la cotización: actualizar
            const upd: any = { lat: srcCoords.lat, lng: srcCoords.lng };
            if (srcNombre) upd.nombre = srcNombre;
            await supabase.from("paradas").update(upd).eq("id", par.id);
            actualizadas++;
          }
          // else: coords coinciden → sin cambio
        } else if (!par.lat || !par.lng) {
          // Sin fuente exacta y sin coords: geocodificar por nombre
          const gc = await geocodificar(par.nombre);
          if (gc) { await supabase.from("paradas").update({ lat: gc.lat, lng: gc.lng }).eq("id", par.id); geocod++; }
          else fallidas++;
        }
        // Con coords pero sin fuente: se respeta (edición manual)
      }
    }

    setSincCoords({ activo: false, msg: "" });
    const partes = [
      "✅ Sincronización completa",
      "",
      exactas > 0    ? `• ${exactas} paradas rellenadas desde cotización` : null,
      actualizadas > 0 ? `• ${actualizadas} coordenadas actualizadas (habían cambiado en la cotización)` : null,
      geocod > 0     ? `• ${geocod} geocodificadas` : null,
      fallidas > 0   ? `• ${fallidas} sin resolver (revisar nombre)` : null,
      (exactas === 0 && actualizadas === 0 && geocod === 0 && fallidas === 0)
        ? "• Todas las paradas ya están al día" : null,
    ].filter(Boolean).join("\n");
    alert(partes);
    cargarDatos();
  };

  // Resuelve los paraderos de una reserva PARA SU TRAMO (ida o retorno).
  // La programación masiva crea 2 reservas (ida y retorno), cada una con su propio
  // paradas_json por tramo → se usa ese primero. Si falta, se reconstruye desde la
  // cotización según direccion_servicio. NUNCA se combinan ambos tramos.
  // Ordenada inicio → intermedia → destino.
  const resolverParadasJSON = async (reservaId: number): Promise<any[]> => {
    const sortLeg = (arr: any[]) => [
      ...arr.filter((p: any) => p.tipo === "inicio"),
      ...arr.filter((p: any) => p.tipo === "intermedia"),
      ...arr.filter((p: any) => p.tipo === "destino"),
      ...arr.filter((p: any) => !["inicio", "intermedia", "destino"].includes(p.tipo)),
    ];
    const { data: rRow } = await supabase.from("reservas")
      .select("paradas_json, cotizacion_id, direccion_servicio").eq("id", reservaId).maybeSingle();

    // 1) El paradas_json propio de la reserva ya viene por tramo (ida o retorno).
    if (Array.isArray(rRow?.paradas_json) && rRow.paradas_json.length > 0)
      return sortLeg(rRow.paradas_json);

    // 2) Fallback: reconstruir desde la cotización según el tramo de la reserva.
    if (rRow?.cotizacion_id) {
      const { data: cot } = await supabase.from("cotizaciones")
        .select("paradas_json, paradas_retorno_json").eq("id", rRow.cotizacion_id).maybeSingle();
      if (rRow.direccion_servicio === "retorno") {
        const ret = Array.isArray(cot?.paradas_retorno_json) && cot.paradas_retorno_json.length > 0
          ? cot.paradas_retorno_json : cot?.paradas_json;
        if (Array.isArray(ret)) return sortLeg(ret);
      } else if (Array.isArray(cot?.paradas_json)) {
        return sortLeg(cot.paradas_json);
      }
    }
    return [];
  };

  // Crea/rehace las paradas de la reserva desde los paraderos de la cotización.
  const crearParadasDesdeJSON = async (reservaId: number) => {
    const todas = await resolverParadasJSON(reservaId);
    if (todas.length === 0) { alert("Esta reserva no tiene paraderos en su cotización."); return; }
    const { data: ex } = await supabase.from("paradas").select("id").eq("reserva_id", reservaId);
    if (ex && ex.length > 0) {
      if (!confirm(`Esta reserva ya tiene ${ex.length} parada(s). ¿Reemplazarlas por los ${todas.length} paraderos de la cotización?`)) return;
      await supabase.from("paradas").delete().eq("reserva_id", reservaId);
    }
    await supabase.from("paradas").insert(todas.map((p: any, i: number) => ({
      reserva_id: reservaId, orden: i + 1, nombre: p.nombre, direccion: p.direccion || null,
      lat: p.lat ? Number(p.lat) : null, lng: p.lng ? Number(p.lng) : null,
      hora_estimada: p.hora || null, estado: "pendiente",
    })));
    const { data: nuevas } = await supabase.from("paradas").select("*").eq("reserva_id", reservaId).order("orden");
    // Geocodificar las que falten
    if (nuevas && nuevas.length > 0) {
      for (const parada of nuevas) {
        if (!parada.lat || !parada.lng) {
          const coords = await geocodificar(parada.nombre);
          if (coords) {
            await supabase.from("paradas").update({ lat: coords.lat, lng: coords.lng }).eq("id", parada.id);
            parada.lat = coords.lat; parada.lng = coords.lng;
          }
        }
      }
    }
    setParadasMap(prev => ({ ...prev, [reservaId]: nuevas || [] }));
    if (nuevas && nuevas.length > 0) {
      const o = nuevas[0].nombre, d = nuevas[nuevas.length - 1].nombre;
      await supabase.from("reservas").update({ origen: o, destino: d }).eq("id", reservaId);
      setReservas(prev => prev.map(r => r.id === reservaId ? { ...r, origen: o, destino: d } as any : r));
    }
    alert(todas.length + " paradas creadas correctamente");
  };

  const cargarParadasReserva = async (reservaId: number) => {
    setCargandoPar(prev => ({ ...prev, [reservaId]: true }));
    const { data } = await supabase.from("paradas").select("*").eq("reserva_id", reservaId).order("orden");

    if (!data || data.length === 0) {
      // ── 1) PREFERIR los paraderos completos del JSON (cotización / reserva) ──
      // Antes se auto-creaban solo origen+destino, perdiendo los paraderos
      // intermedios configurados en la cotización.
      const jsonParadas = await resolverParadasJSON(reservaId);

      if (jsonParadas.length > 0) {
        await supabase.from("paradas").insert(jsonParadas.map((p: any, i: number) => ({
          reserva_id: reservaId, orden: i + 1, nombre: p.nombre, direccion: p.direccion || null,
          lat: p.lat ? Number(p.lat) : null, lng: p.lng ? Number(p.lng) : null,
          hora_estimada: p.hora || null, estado: "pendiente",
        })));
        const { data: creadas } = await supabase.from("paradas").select("*").eq("reserva_id", reservaId).order("orden");
        // Geocodificar las que vengan sin coordenadas
        if (creadas && creadas.length > 0) {
          for (const parada of creadas) {
            if (!parada.lat || !parada.lng) {
              const coords = await geocodificar(parada.nombre);
              if (coords) {
                await supabase.from("paradas").update({ lat: coords.lat, lng: coords.lng }).eq("id", parada.id);
                parada.lat = coords.lat; parada.lng = coords.lng;
              }
            }
          }
        }
        setParadasMap(prev => ({ ...prev, [reservaId]: creadas || [] }));
        if (creadas && creadas.length > 0) {
          const o = creadas[0].nombre, d = creadas[creadas.length - 1].nombre;
          await supabase.from("reservas").update({ origen: o, destino: d }).eq("id", reservaId);
          setReservas(prev => prev.map(r => r.id === reservaId ? { ...r, origen: o, destino: d } as any : r));
        }
        setCargandoPar(prev => ({ ...prev, [reservaId]: false }));
        return;
      }

      // ── 2) Fallback: auto-crear desde origen / destino / punto_retorno ───────
      const reserva = reservas.find(r => r.id === reservaId);
      const origen       = (reserva as any)?.origen?.trim();
      const destino      = (reserva as any)?.destino?.trim();
      const puntoRetorno = (reserva as any)?.punto_retorno?.trim();

      // Solo auto-crear si el valor es una dirección real (no un placeholder genérico)
      const esValido = (v: string | undefined | null) =>
        v && v.trim() && v.trim().toLowerCase() !== "sin especificar" && v.trim() !== "-";

      if (esValido(origen) || esValido(destino) || esValido(puntoRetorno)) {
        const filas: any[] = [];
        if (esValido(origen))       filas.push({ reserva_id: reservaId, orden: filas.length + 1, nombre: origen,       estado: "pendiente" });
        if (esValido(destino))      filas.push({ reserva_id: reservaId, orden: filas.length + 1, nombre: destino,      estado: "pendiente" });
        if (esValido(puntoRetorno)) filas.push({ reserva_id: reservaId, orden: filas.length + 1, nombre: puntoRetorno, estado: "pendiente" });

        await supabase.from("paradas").insert(filas);
        const { data: creadas } = await supabase.from("paradas").select("*").eq("reserva_id", reservaId).order("orden");

        // Geocodificar cada parada para obtener lat/lng desde Google Maps
        if (creadas && creadas.length > 0) {
          for (const parada of creadas) {
            if (!parada.lat || !parada.lng) {
              const coords = await geocodificar(parada.nombre);
              if (coords) {
                await supabase.from("paradas").update({ lat: coords.lat, lng: coords.lng }).eq("id", parada.id);
                parada.lat = coords.lat;
                parada.lng = coords.lng;
              }
            }
          }
        }

        setParadasMap(prev => ({ ...prev, [reservaId]: creadas || [] }));
        // Sync origen/destino para que la columna Ruta quede actualizada
        if (creadas && creadas.length > 0) {
          const o = creadas[0].nombre;
          const d = creadas[creadas.length - 1].nombre;
          await supabase.from("reservas").update({ origen: o, destino: d }).eq("id", reservaId);
          setReservas(prev => prev.map(r => r.id === reservaId ? { ...r, origen: o, destino: d } as any : r));
        }
        setCargandoPar(prev => ({ ...prev, [reservaId]: false }));
        return;
      }
    }

    const paradasCargadas = data || [];
    setParadasMap(prev => ({ ...prev, [reservaId]: paradasCargadas }));
    setCargandoPar(prev => ({ ...prev, [reservaId]: false }));

    // Geocodificar en background paradas existentes sin coordenadas
    const sinCoords = paradasCargadas.filter((p: any) => !p.lat || !p.lng);
    if (sinCoords.length > 0) {
      for (const parada of sinCoords) {
        geocodificar(parada.nombre).then(coords => {
          if (!coords) return;
          supabase.from("paradas").update({ lat: coords.lat, lng: coords.lng }).eq("id", parada.id);
          setParadasMap(prev => ({
            ...prev,
            [reservaId]: (prev[reservaId] || []).map((p: any) =>
              p.id === parada.id ? { ...p, lat: coords.lat, lng: coords.lng } : p
            ),
          }));
        });
      }
    }
  };

  const cargarPasajerosCliente = async (reservaId: number, clienteId: number | null) => {
    if (!clienteId) { setPasajerosCliente(prev => ({ ...prev, [reservaId]: [] })); return; }
    setCargandoPas(prev => ({ ...prev, [reservaId]: true }));
    const { data } = await supabase.from("pasajeros").select("*").eq("cliente_id", clienteId).order("nombre");
    setPasajerosCliente(prev => ({ ...prev, [reservaId]: data || [] }));
    setCargandoPas(prev => ({ ...prev, [reservaId]: false }));
    await cargarPasajerosAsignados(reservaId);
  };

  // ── Helpers de paradas inline ─────────────────────────────────────────
  const syncOrigenDestino = async (reservaId: number, nuevasParadas: any[]) => {
    if (nuevasParadas.length === 0) return;
    const origen  = nuevasParadas[0].nombre;
    const destino = nuevasParadas[nuevasParadas.length - 1].nombre;
    await supabase.from("reservas").update({ origen, destino }).eq("id", reservaId);
    setReservas(prev => prev.map(r => r.id === reservaId ? { ...r, origen, destino } as any : r));
  };

  const recargarParadas = async (reservaId: number) => {
    const { data } = await supabase.from("paradas").select("*").eq("reserva_id", reservaId).order("orden");
    setParadasMap(prev => ({ ...prev, [reservaId]: data || [] }));
    return data || [];
  };

  const agregarParadaInline = async (reservaId: number) => {
    const nombre = (nuevoParNombre[reservaId] || "").trim();
    if (!nombre) return;
    setAgregandoPar2(prev => ({ ...prev, [reservaId]: true }));
    const actuales = paradasMap[reservaId] || [];
    const nextOrden = actuales.length > 0 ? Math.max(...actuales.map((p: any) => p.orden)) + 1 : 1;
    await supabase.from("paradas").insert({
      reserva_id: reservaId, orden: nextOrden, nombre,
      direccion: nuevoParDir[reservaId]?.trim() || null,
      lat:       nuevoParLat[reservaId] || null,
      lng:       nuevoParLng[reservaId] || null,
      hora_estimada: nuevoParHora[reservaId]?.trim() || null,
      estado: "pendiente",
    });
    const nuevas = await recargarParadas(reservaId);
    await syncOrigenDestino(reservaId, nuevas);
    setNuevoParNombre(prev => ({ ...prev, [reservaId]: "" }));
    setNuevoParHora(prev => ({ ...prev, [reservaId]: "" }));
    setNuevoParDir(prev => ({ ...prev, [reservaId]: "" }));
    setNuevoParLat(prev => ({ ...prev, [reservaId]: 0 }));
    setNuevoParLng(prev => ({ ...prev, [reservaId]: 0 }));
    setAgregandoPar2(prev => ({ ...prev, [reservaId]: false }));
  };

  const eliminarParadaInline = async (reservaId: number, paradaId: number) => {
    if (!confirm("¿Eliminar esta parada?")) return;
    await supabase.from("paradas").delete().eq("id", paradaId);
    const nuevas = await recargarParadas(reservaId);
    if (nuevas.length > 0) await syncOrigenDestino(reservaId, nuevas);
  };

  const crearParadasDesdeOrigenDestino = async (reservaId: number) => {
    const reserva = reservas.find(r => r.id === reservaId);
    const origen  = (reserva as any)?.origen?.trim();
    const destino = (reserva as any)?.destino?.trim();
    if (!origen && !destino) return;
    const filas: any[] = [];
    if (origen)  filas.push({ reserva_id: reservaId, orden: 1, nombre: origen,  estado: "pendiente" });
    if (destino) filas.push({ reserva_id: reservaId, orden: filas.length + 1, nombre: destino, estado: "pendiente" });
    await supabase.from("paradas").insert(filas);
    const { data: creadas } = await supabase.from("paradas").select("*").eq("reserva_id", reservaId).order("orden");
    if (creadas && creadas.length > 0) {
      for (const parada of creadas) {
        if (!parada.lat || !parada.lng) {
          const coords = await geocodificar(parada.nombre);
          if (coords) {
            await supabase.from("paradas").update({ lat: coords.lat, lng: coords.lng }).eq("id", parada.id);
            parada.lat = coords.lat;
            parada.lng = coords.lng;
          }
        }
      }
      setParadasMap(prev => ({ ...prev, [reservaId]: creadas }));
    }
  };

  const generarTokenReserva = async (reservaId: number, tipo: "seguimiento" | "conductor_tercero" | "ambos") => {
    setGenerandoToken(tipo);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/tokens/generar", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ reservaId, tipo }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error ?? "Error al generar token"); return; }
      setReservas(prev => prev.map(r => r.id === reservaId ? { ...r, ...data } : r));
    } catch { alert("Error de red"); }
    finally { setGenerandoToken(null); }
  };

  const copiarLink = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiadoKey(key);
      setTimeout(() => setCopiadoKey(null), 2000);
    });
  };

  const ejecutarAsignacionBloque = async () => {
    if (!modalAsignarBloque || !asignarVehId) return;
    setAsignando(true);

    const todasAptas = modalAsignarBloque.todasLasFilas;
    const targets: Reserva[] = bloqueScope === "pendientes"
      ? modalAsignarBloque.sinAsignar
      : todasAptas.filter(r =>
          r.fecha_servicio &&
          (!bloqueFechaDesde || r.fecha_servicio >= bloqueFechaDesde) &&
          (!bloqueFechaHasta  || r.fecha_servicio <= bloqueFechaHasta)
        );

    if (targets.length === 0) { alert("No hay servicios en el rango seleccionado."); setAsignando(false); return; }

    const pendienteIds = targets.filter(r => r.estado === "pendiente").map(r => r.id);
    const otrosIds     = targets.filter(r => r.estado !== "pendiente").map(r => r.id);
    const BATCH = 50;

    const asignBase = { vehiculo_id: Number(asignarVehId), conductor_id: asignarCondId ? Number(asignarCondId) : null, tipo_asignacion: "propio" };

    for (let i = 0; i < pendienteIds.length; i += BATCH) {
      const { error } = await supabase.from("reservas").update({ ...asignBase, estado: "programada" }).in("id", pendienteIds.slice(i, i + BATCH));
      if (error) { alert("Error: " + error.message); setAsignando(false); return; }
    }
    for (let i = 0; i < otrosIds.length; i += BATCH) {
      const { error } = await supabase.from("reservas").update(asignBase).in("id", otrosIds.slice(i, i + BATCH));
      if (error) { alert("Error: " + error.message); setAsignando(false); return; }
    }

    const allIds = targets.map(r => r.id);
    setReservas(prev => prev.map(r =>
      allIds.includes(r.id)
        ? { ...r, ...asignBase, estado: r.estado === "pendiente" ? "programada" as EstadoReserva : r.estado }
        : r
    ));
    setModalAsignarBloque(null);
    setAsignarVehId("");
    setAsignarCondId("");
    setAsignando(false);
  };

  const cargarDatos = async () => {
    setLoading(true);
    const [clRes, vRes, cRes, etRes, vtRes, ctRes, dtRes, rRes] = await Promise.all([
      supabase.from("clientes").select("id,nombre,empresa,tipo").order("nombre"),
      supabase.from("vehiculos").select("id,placa,categoria,estado,estado_operativo,capacidad_pasajeros").order("placa"),
      supabase.from("conductores").select("id,nombre,licencia,vencimiento_licencia,estado,telefono").order("nombre"),
      supabase.from("empresas_tercerizadas").select("id,razon_social,ruc,telefono,estado").order("razon_social"),
      supabase.from("vehiculos_tercero").select("id,empresa_id,placa,categoria,capacidad,estado,marca").order("placa"),
      supabase.from("conductores_tercero").select("id,empresa_id,nombre,licencia,vencimiento_licencia,telefono,estado").order("nombre"),
      supabase.from("documentos_tercero").select("id,empresa_id,tipo,fecha_vencimiento"),
      supabase.from("reservas").select("*").order("fecha_servicio", { ascending: false }).order("id", { ascending: false }),
    ]);
    setClientes(clRes.data     || []);
    setVehiculos(vRes.data     || []);
    setConductores(cRes.data   || []);
    setEmpresasTer(etRes.data  || []);
    setVehTercero(vtRes.data   || []);
    setCondTercero(ctRes.data  || []);
    setDocsTercero(dtRes.data  || []);
    setReservas(rRes.data      || []);
    await cargarOcupaciones();
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  const nombreCliente    = (id: number | null) => { const c = clientes.find(c => c.id === id); return c ? (c.empresa || c.nombre) : "Sin cliente"; };
  const nombreVehiculo   = (id: number | null) => vehiculos.find(v => v.id === id)?.placa || "-";
  const nombreConductor  = (id: number | null) => conductores.find(c => c.id === id)?.nombre || "-";
  const nombreEmpTer     = (id: number | null) => empresasTer.find(e => e.id === id)?.razon_social || "-";
  const nombreVehTercero = (id: number | null) => vehTercero.find(v => v.id === id)?.placa || "-";

  const vehiculosAptos         = vehiculos.filter(v => v.estado === "disponible" && (v.estado_operativo === "apto" || !v.estado_operativo));
  const conductoresDisponibles = conductores.filter(c => c.estado !== "no_disponible" && (!c.vencimiento_licencia || new Date(c.vencimiento_licencia) >= new Date()));

  const empSelId     = form.empresa_tercerizada_id ? Number(form.empresa_tercerizada_id) : null;
  const vehEmpSel    = empSelId ? vehTercero.filter(v => v.empresa_id === empSelId && v.estado === "disponible") : [];
  const condEmpSel   = empSelId ? condTercero.filter(c => c.empresa_id === empSelId) : [];
  const riesgoEmpSel = empSelId ? riesgoEmpresa(docsTercero, empSelId) : "ok";

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const setRangoRapido = (tipo: "hoy" | "semana" | "7dias" | "mes" | "limpiar") => {
    if (tipo === "limpiar") { setFiltroDesde(""); setFiltroHasta(""); return; }
    const h = fechaLima();
    if (tipo === "hoy")   { setFiltroDesde(h); setFiltroHasta(h); return; }
    if (tipo === "7dias") { setFiltroDesde(h); setFiltroHasta(fechaLima(7)); return; }
    if (tipo === "semana") {
      const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" }));
      const dow = d.getDay() || 7;
      const lun = new Date(d); lun.setDate(d.getDate() - dow + 1);
      const dom = new Date(lun); dom.setDate(lun.getDate() + 6);
      const fmt = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
      setFiltroDesde(fmt(lun));
      setFiltroHasta(fmt(dom));
      return;
    }
    if (tipo === "mes") {
      const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" }));
      const fmt = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
      setFiltroDesde(fmt(new Date(d.getFullYear(), d.getMonth(), 1)));
      setFiltroHasta(fmt(new Date(d.getFullYear(), d.getMonth() + 1, 0)));
    }
  };

  const editarReserva = (r: Reserva) => {
    setForm({
      fecha_servicio:         r.fecha_servicio            || "",
      hora_servicio:          r.hora_servicio?.slice(0,5) || "",
      // Normalizar: "tercero"/"tercerizada" → "tercerizado" (valor que usa el select)
      tipo_asignacion:        (r.tipo_asignacion === "tercero" || r.tipo === "tercerizada") ? "tercerizado" : (r.tipo_asignacion || "propio"),
      estado:                 r.estado                    || "pendiente",
      vehiculo_id:            r.vehiculo_id               ? String(r.vehiculo_id)               : "",
      conductor_id:           r.conductor_id              ? String(r.conductor_id)              : "",
      empresa_tercerizada_id: r.empresa_tercerizada_id    ? String(r.empresa_tercerizada_id)    : "",
      vehiculo_tercero_id:    r.vehiculo_tercero_id       ? String(r.vehiculo_tercero_id)       : "",
      conductor_tercero_id:   r.conductor_tercero_id      ? String(r.conductor_tercero_id)      : "",
      costo_proveedor:        r.costo_proveedor           ? String(r.costo_proveedor)           : "",
      observaciones:          r.observaciones             || "",
    });
    setEditandoId(r.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const guardarReserva = async () => {
    if (!editandoId) return;
    if (!form.fecha_servicio || !form.hora_servicio) { alert("Ingresa fecha y hora"); return; }
    if (form.tipo_asignacion === "propio" && (!form.vehiculo_id || !form.conductor_id)) {
      alert("Selecciona vehiculo y conductor propios"); return;
    }
    if (form.tipo_asignacion === "tercerizado" && !form.empresa_tercerizada_id) {
      alert("Selecciona la empresa tercerizada"); return;
    }
    if (form.tipo_asignacion === "tercerizado" && riesgoEmpSel === "alto") {
      const ok = confirm("ALERTA: Esta empresa tiene documentos OBLIGATORIOS vencidos. Continuar de todas formas?");
      if (!ok) return;
    }

    setGuardando(true);
    const costo = form.tipo_asignacion === "tercerizado" ? Number(form.costo_proveedor || 0) : 0;

    let nuevoEstado = form.estado;
    const reservaActual = reservas.find(r => r.id === editandoId);
    if (reservaActual?.estado === "pendiente") {
      const esFijo = !esEventual(reservaActual);
      // Fijo: auto-confirmado al asignar (el contrato es la confirmación)
      // Eventual: queda en programada hasta que el cliente confirme manualmente
      if (form.tipo_asignacion === "propio" && form.vehiculo_id && form.conductor_id)
        nuevoEstado = esFijo ? "confirmada" : "programada";
      if (form.tipo_asignacion === "tercerizado" && form.empresa_tercerizada_id) {
        const tercerizadoCompleto = !!(form.vehiculo_tercero_id && form.conductor_tercero_id);
        nuevoEstado = (esFijo && tercerizadoCompleto) ? "confirmada" : "programada";
      }
    }
    if (form.estado !== "pendiente") nuevoEstado = form.estado;

    // Evitar degradar accidentalmente a "pendiente" desde un estado superior (ORDEN_ESTADO viene de lib/estados)
    const estadoActualOrd  = ORDEN_ESTADO[reservaActual?.estado || "pendiente"] ?? 0;
    const nuevoEstadoOrd   = ORDEN_ESTADO[nuevoEstado] ?? 0;
    if (estadoActualOrd > 0 && nuevoEstadoOrd === 0) {
      const lblActual = ESTADO_CFG[reservaActual!.estado]?.label ?? reservaActual!.estado;
      const ok = confirm(`La reserva está en estado "${lblActual}". ¿Deseas cambiarla a Pendiente?`);
      if (!ok) { setGuardando(false); return; }
    }

    const asignPayload = {
      hora_servicio:          form.hora_servicio,
      tipo:                   form.tipo_asignacion === "propio" ? "propia" : "tercerizada",
      tipo_asignacion:        form.tipo_asignacion,
      vehiculo_id:            form.tipo_asignacion === "propio" ? Number(form.vehiculo_id) : null,
      conductor_id:           form.tipo_asignacion === "propio" ? Number(form.conductor_id) : null,
      empresa_tercerizada_id: form.tipo_asignacion === "tercerizado" ? Number(form.empresa_tercerizada_id) : null,
      vehiculo_tercero_id:    form.tipo_asignacion === "tercerizado" && form.vehiculo_tercero_id ? Number(form.vehiculo_tercero_id) : null,
      conductor_tercero_id:   form.tipo_asignacion === "tercerizado" && form.conductor_tercero_id ? Number(form.conductor_tercero_id) : null,
      costo_proveedor:        costo,
    };

    // Puente A→B: si el servicio pasa a "finalizada" y aún no tiene estado administrativo,
    // arranca en "por_liquidar".
    const adminPayload = (nuevoEstado === "finalizada" && !reservaActual?.estado_admin)
      ? { estado_admin: ESTADO_ADMIN_INICIAL }
      : {};
    const { error } = await supabase.from("reservas").update({
      ...asignPayload,
      ...adminPayload,
      fecha_servicio:  form.fecha_servicio,
      hora_servicio:   form.hora_servicio,
      estado:          nuevoEstado,
      observaciones:   form.observaciones.trim() || null,
    }).eq("id", editandoId);

    if (error) { alert(error.message); setGuardando(false); return; }

    // ── Si es servicio FIJO con contrato, ofrecer aplicar a otros días ──
    if (reservaActual && !esEventual(reservaActual) && reservaActual.cotizacion_id) {
      const horaOriginal = reservaActual.hora_servicio?.slice(0, 5) || "";
      const otrasReservas = reservas.filter(r => {
        if (r.cotizacion_id !== reservaActual.cotizacion_id) return false;
        if (r.id === editandoId) return false;
        if (r.estado === "cancelada" || r.estado === "finalizada") return false;
        // Solo misma hora: evita contaminar rutas paralelas del mismo contrato
        if (r.hora_servicio?.slice(0, 5) !== horaOriginal) return false;
        if (form.tipo_asignacion === "propio")
          // Incluir sin asignar (pendiente) + misma placa ya asignada
          return r.vehiculo_id === null || r.vehiculo_id === Number(form.vehiculo_id);
        // Tercerizado: incluir sin empresa, o misma empresa (+ vehículo si se especificó)
        if (r.empresa_tercerizada_id === null) return true;
        if (r.empresa_tercerizada_id !== Number(form.empresa_tercerizada_id)) return false;
        if (form.vehiculo_tercero_id && r.vehiculo_tercero_id !== Number(form.vehiculo_tercero_id)) return false;
        return true;
      });
      if (otrasReservas.length > 0) {
        // Construir resumen legible de lo asignado
        let resumen = "";
        if (form.tipo_asignacion === "propio") {
          const vNombre = vehiculos.find(v => v.id === Number(form.vehiculo_id))?.placa || "";
          const cNombre = conductores.find(c => c.id === Number(form.conductor_id))?.nombre || "";
          resumen = [vNombre, cNombre].filter(Boolean).join(" · ");
        } else {
          const eNombre = empresasTer.find(e => e.id === Number(form.empresa_tercerizada_id))?.razon_social || "";
          resumen = eNombre;
        }
        limpiar();
        setGuardando(false);
        setAplicarScope("todos");
        setAplicarDesde("");
        setAplicarHasta("");
        setModalAplicarMasivo({ cotizacion_id: reservaActual.cotizacion_id, payload: asignPayload, otrasReservas, resumen });
        cargarDatos();
        return;
      }
    }

    limpiar(); cargarDatos(); setGuardando(false);
  };

  const aplicarMasivo = async () => {
    if (!modalAplicarMasivo) return;
    const { payload, otrasReservas } = modalAplicarMasivo;

    let targets = otrasReservas;
    if (aplicarScope === "rango") {
      targets = otrasReservas.filter(r =>
        r.fecha_servicio &&
        (!aplicarDesde || r.fecha_servicio >= aplicarDesde) &&
        (!aplicarHasta  || r.fecha_servicio <= aplicarHasta)
      );
      if (targets.length === 0) { alert("No hay servicios en ese rango de fechas"); return; }
    }

    setAplicando(true);
    const pendienteIds = targets.filter(r => r.estado === "pendiente").map(r => r.id);
    const otrosIds     = targets.filter(r => r.estado !== "pendiente").map(r => r.id);

    const ops: Promise<any>[] = [];
    if (pendienteIds.length > 0) {
      const propioCompleto = payload.tipo_asignacion === "propio" && !!payload.vehiculo_id && !!payload.conductor_id;
      const tercerizadoCompleto = payload.tipo_asignacion === "tercerizado" && !!payload.empresa_tercerizada_id && !!payload.vehiculo_tercero_id && !!payload.conductor_tercero_id;
      const estadoPendientes: EstadoReserva = (propioCompleto || tercerizadoCompleto) ? "confirmada" : "programada";
      ops.push(supabase.from("reservas").update({ ...payload, estado: estadoPendientes }).in("id", pendienteIds));
    }
    if (otrosIds.length > 0)
      ops.push(supabase.from("reservas").update(payload).in("id", otrosIds));

    const results = await Promise.all(ops);
    const errores = results.filter(r => r.error);
    if (errores.length > 0) alert(`Error al actualizar ${errores.length} lote(s). Revisa la consola.`);

    setModalAplicarMasivo(null);
    setAplicando(false);
    cargarDatos();
  };

  const eliminarReserva = async (id: number) => {
    await supabase.from("reservas").delete().eq("id", id);
    setConfirmEliminarId(null);
    cargarDatos();
  };

  const cambiarEstadoRapido = async (id: number, estado: EstadoReserva) => {
    if (estado === "en_curso") {
      alert("El estado 'En curso' solo lo puede activar el conductor desde la app conductor.");
      return;
    }
    if (estado === "finalizada") {
      setModalFinalizar({ id, motivo: "" });
      return;
    }
    await supabase.from("reservas").update({ estado }).eq("id", id);
    setReservas(prev => prev.map(r => r.id === id ? { ...r, estado } : r));
  };

  const confirmarFinalizar = async () => {
    if (!modalFinalizar) return;
    if (!modalFinalizar.motivo.trim()) {
      alert("Debes ingresar el motivo de cierre manual.");
      return;
    }
    const reserva = reservas.find(r => r.id === modalFinalizar.id);
    const obsActual = reserva?.observaciones ? reserva.observaciones + " | " : "";
    // Puente A→B: al finalizar, el estado administrativo arranca en "por_liquidar".
    const adminCierre: EstadoAdmin = reserva?.estado_admin || ESTADO_ADMIN_INICIAL;
    await supabase.from("reservas").update({
      estado: "finalizada",
      estado_admin: adminCierre,
      observaciones: `${obsActual}[Cierre manual] ${modalFinalizar.motivo.trim()}`,
    }).eq("id", modalFinalizar.id);
    setReservas(prev => prev.map(r => r.id === modalFinalizar.id ? { ...r, estado: "finalizada", estado_admin: adminCierre } : r));
    setModalFinalizar(null);
  };

  // Avanza el estado administrativo (dimensión B): por_liquidar → liquidada → facturada → cobrada
  const avanzarAdmin = async (r: Reserva) => {
    const actual = (r.estado_admin || ESTADO_ADMIN_INICIAL) as EstadoAdmin;
    const sig = siguienteAdmin(actual);
    if (!sig) return;
    if (!confirm(`Avanzar estado administrativo de "${ESTADOS_ADMIN[actual].label}" a "${ESTADOS_ADMIN[sig].label}"?`)) return;
    await supabase.from("reservas").update({ estado_admin: sig }).eq("id", r.id);
    setReservas(prev => prev.map(x => x.id === r.id ? { ...x, estado_admin: sig } : x));
  };

  const capacidadDe = (r: Reserva): number | null => {
    if (r.tipo === "tercerizada") return vehTercero.find(v => v.id === r.vehiculo_tercero_id)?.capacidad ?? null;
    return vehiculos.find(v => v.id === r.vehiculo_id)?.capacidad_pasajeros ?? null;
  };

  const hoy          = fechaLima();
  const totalRes     = reservas.length;
  const pendientes   = reservas.filter(r => r.estado === "pendiente").length;
  const programadas  = reservas.filter(r => r.estado === "programada").length;
  const confirmadas  = reservas.filter(r => r.estado === "confirmada").length;
  const enCurso      = reservas.filter(r => r.estado === "en_curso").length;
  // Dimensión B · cierre administrativo (solo servicios finalizados tienen estado_admin)
  const porLiquidar  = reservas.filter(r => r.estado_admin === "por_liquidar").length;
  const liquidadas   = reservas.filter(r => r.estado_admin === "liquidada").length;
  const facturadas   = reservas.filter(r => r.estado_admin === "facturada").length;
  const cobradas     = reservas.filter(r => r.estado_admin === "cobrada").length;
  const hoyCount     = reservas.filter(r => r.fecha_servicio === hoy).length;
  const ventas       = reservas.reduce((s, r) => s + Number(r.precio_cliente || 0), 0);
  const costos       = reservas.reduce((s, r) => s + Number(r.costo_proveedor || 0), 0);
  const margenTotal  = reservas.reduce((s, r) => s + Number(r.margen || 0), 0);
  const conSobrecupo = Object.values(ocupacionMap).filter(o => o.sobrecupo).length;
  const sincronizadas = reservas.filter(r => r.sincronizado_app).length;
  const en7d          = fechaLima(7);
  const proximos7d    = reservas.filter(r => r.fecha_servicio && r.fecha_servicio >= hoy && r.fecha_servicio <= en7d && r.estado !== "cancelada" && r.estado !== "finalizada").length;

  const filtradas = useMemo(() => {
    const base = reservas.filter(r => {
      const q   = busqueda.toLowerCase();
      const txt = (r.id + " " + nombreCliente(r.cliente_id) + " " + ((r as any).origen || "") + " " + ((r as any).destino || "")).toLowerCase();
      const passServicio    = filtroServicio === "todos" || (filtroServicio === "fijo" ? !esEventual(r) : esEventual(r));
      const passPorAsignar  = !filtroPorAsignar || (r.estado === "pendiente" && !r.vehiculo_id && !r.empresa_tercerizada_id);
      return txt.includes(q) &&
        (filtroEstado === "todos" || r.estado === filtroEstado) &&
        (filtroTipo === "todos" || r.tipo === filtroTipo) &&
        passServicio &&
        (!filtroDesde || (r.fecha_servicio && r.fecha_servicio >= filtroDesde)) &&
        (!filtroHasta || (r.fecha_servicio && r.fecha_servicio <= filtroHasta)) &&
        passPorAsignar;
    });
    // Próximos primero: futuros ascendentes, luego pasados descendentes (más reciente primero)
    return [...base].sort((a, b) => {
      const fa = a.fecha_servicio;
      const fb = b.fecha_servicio;
      if (!fa && !fb) return 0;
      if (!fa) return 1;
      if (!fb) return -1;
      const aFut = fa >= hoy;
      const bFut = fb >= hoy;
      if (aFut && bFut)   return fa.localeCompare(fb);
      if (!aFut && !bFut) return fb.localeCompare(fa);
      return aFut ? -1 : 1;
    });
  }, [reservas, busqueda, filtroEstado, filtroTipo, filtroServicio, filtroDesde, filtroHasta, filtroPorAsignar, clientes, hoy]);

  // Agrupación de servicios fijos por contrato (cotizacion_id)
  const gruposContratos = useMemo(() => {
    if (filtroServicio !== "fijo") return null;
    const grupos = new Map<string, Reserva[]>();
    filtradas.forEach(r => {
      const key = r.cotizacion_id != null ? String(r.cotizacion_id) : "sin_cotizacion";
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key)!.push(r);
    });
    return Array.from(grupos.entries()).map(([clave, filas]) => {
      const sorted = [...filas].sort((a, b) => (a.fecha_servicio || "").localeCompare(b.fecha_servicio || ""));
      const proxima = sorted.find(r => r.fecha_servicio && r.fecha_servicio >= hoy) || sorted[0];
      return { clave, cotId: filas[0].cotizacion_id, filas: sorted, proxima };
    });
  }, [filtradas, filtroServicio, hoy]);

  // Índice donde se inserta el separador "Pasados ↑ · Próximos ↓"
  const sepIdx = filtradas.findIndex((r, i) =>
    i > 0 &&
    filtradas[i - 1].fecha_servicio != null && filtradas[i - 1].fecha_servicio! < hoy &&
    r.fecha_servicio != null && r.fecha_servicio >= hoy
  );

  const agendaGrupos = useMemo(() => {
    const grupos = new Map<string, Reserva[]>();
    filtradas.forEach(r => {
      const key = r.fecha_servicio || "sin_fecha";
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key)!.push(r);
    });
    return Array.from(grupos.entries()).map(([fecha, filas]) => ({
      fecha,
      filas: [...filas].sort((a, b) => {
        const ha = a.hora_servicio || "";
        const hb = b.hora_servicio || "";
        return ha !== hb ? ha.localeCompare(hb) : a.id - b.id;
      }),
      label: fecha === "sin_fecha" ? "Sin fecha" :
        new Date(fecha + "T12:00:00").toLocaleDateString("es-PE", { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
      esHoyGrupo: fecha === hoy,
      esPasado: fecha !== "sin_fecha" && fecha < hoy,
    }));
  }, [filtradas, hoy]);

  const reservaModal = modalReservaId ? reservas.find(r => r.id === modalReservaId) : null;

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {mostrarModalPrograma && (
        <ModalGenerarPrograma
          clientes={clientes}
          onClose={() => setMostrarModalPrograma(false)}
          onGenerado={() => { cargarDatos(); setFiltroServicio("fijo"); }}
        />
      )}

      {/* MODAL APLICAR ASIGNACIÓN MASIVA A SERVICIOS FIJOS */}
      {modalAplicarMasivo && (() => {
        const { otrasReservas, resumen, cotizacion_id } = modalAplicarMasivo;
        const targets = aplicarScope === "rango"
          ? otrasReservas.filter(r =>
              r.fecha_servicio &&
              (!aplicarDesde || r.fecha_servicio >= aplicarDesde) &&
              (!aplicarHasta  || r.fecha_servicio <= aplicarHasta))
          : otrasReservas;
        const fechas = otrasReservas.map(r => r.fecha_servicio).filter(Boolean).sort() as string[];
        const minF = fechas[0] || "";
        const maxF = fechas[fechas.length - 1] || "";

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div className="px-6 py-4 flex items-center gap-3 rounded-t-2xl" style={{ background: "#0b315f" }}>
                <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center text-lg">📋</div>
                <div>
                  <p className="font-black text-white text-base">¿Aplicar a más servicios del contrato?</p>
                  <p className="text-white/60 text-xs">Contrato #{cotizacion_id} · {otrasReservas.length} servicio(s) adicional(es)</p>
                </div>
              </div>

              <div className="px-6 py-5 space-y-4">
                {/* Resumen asignación */}
                <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "#f0fdf4", border: "1px solid #86efac" }}>
                  <p className="text-[10px] font-black uppercase tracking-wide text-green-600 mb-0.5">Asignación guardada</p>
                  <p className="font-bold text-green-800">{resumen || "—"}</p>
                </div>

                {/* Opciones */}
                <div className="space-y-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-gray-400">¿A cuántos servicios aplicar?</p>

                  <label className={`flex items-start gap-3 p-3 rounded-xl cursor-pointer border-2 transition-all ${aplicarScope === "todos" ? "border-[#0b315f] bg-blue-50" : "border-gray-200"}`}>
                    <input type="radio" name="scope" checked={aplicarScope === "todos"} onChange={() => setAplicarScope("todos")} className="mt-0.5 accent-[#0b315f]" />
                    <div>
                      <p className="font-bold text-sm text-gray-800">Todos los servicios del contrato</p>
                      <p className="text-xs text-gray-500">{otrasReservas.length} servicio(s) · {minF ? fmtFecha(minF) : "—"} al {maxF ? fmtFecha(maxF) : "—"}</p>
                    </div>
                  </label>

                  <label className={`flex items-start gap-3 p-3 rounded-xl cursor-pointer border-2 transition-all ${aplicarScope === "rango" ? "border-[#0b315f] bg-blue-50" : "border-gray-200"}`}>
                    <input type="radio" name="scope" checked={aplicarScope === "rango"} onChange={() => { setAplicarScope("rango"); setAplicarDesde(minF); setAplicarHasta(maxF); }} className="mt-0.5 accent-[#0b315f]" />
                    <div className="flex-1">
                      <p className="font-bold text-sm text-gray-800">Rango de fechas</p>
                      <p className="text-xs text-gray-500 mb-2">Elige desde qué fecha hasta cuál</p>
                      {aplicarScope === "rango" && (
                        <div className="flex gap-2 flex-wrap">
                          <div>
                            <p className="text-[9px] font-black text-gray-400 uppercase mb-1">Desde</p>
                            <input type="date" value={aplicarDesde} onChange={e => setAplicarDesde(e.target.value)} min={minF} max={maxF} className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-[#0b315f]" />
                          </div>
                          <div>
                            <p className="text-[9px] font-black text-gray-400 uppercase mb-1">Hasta</p>
                            <input type="date" value={aplicarHasta} onChange={e => setAplicarHasta(e.target.value)} min={minF} max={maxF} className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-[#0b315f]" />
                          </div>
                        </div>
                      )}
                    </div>
                  </label>
                </div>

                {/* Preview conteo */}
                <div className="rounded-xl px-4 py-2.5 text-xs font-bold flex items-center gap-2" style={{ background: "#e0f2fe", color: "#0369a1" }}>
                  <span>📊</span>
                  <span>Se actualizarán <b>{targets.length}</b> servicio(s) adicional(es)</span>
                </div>
              </div>

              {/* Footer */}
              <div className="px-6 pb-5 flex gap-3">
                <button
                  onClick={aplicarMasivo}
                  disabled={aplicando || targets.length === 0}
                  className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
                  style={{ background: "#0b315f" }}
                >
                  {aplicando ? "Aplicando..." : `Aplicar a ${targets.length} servicio(s)`}
                </button>
                <button
                  onClick={() => setModalAplicarMasivo(null)}
                  disabled={aplicando}
                  className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50 disabled:opacity-60"
                >
                  Solo este
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* MODAL LINKS DE COMPARTIR */}
      {modalLinksId !== null && (() => {
        const r = reservas.find(x => x.id === modalLinksId);
        if (!r) return null;
        const base = typeof window !== "undefined" ? window.location.origin : "";
        const urlSeg  = r.token_seguimiento      ? `${base}/seguimiento/${r.token_seguimiento}` : null;
        const urlCond = r.token_conductor_tercero ? `${base}/conductor-tercero/${r.token_conductor_tercero}` : null;
        const expira  = r.token_expira_at ? new Date(r.token_expira_at).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" }) : null;
        const tieneTercero = !!(r.vehiculo_tercero_id || r.conductor_tercero_id);

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setModalLinksId(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h3 className="text-lg font-bold text-gray-800">Links de servicio #{r.id}</h3>
                  {expira && <p className="text-xs text-gray-400 mt-0.5">Vencen: {expira}</p>}
                </div>
                <button onClick={() => setModalLinksId(null)} className="text-gray-400 hover:text-gray-600 text-xl font-bold leading-none">×</button>
              </div>

              {/* Link pasajero */}
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-7 h-7 bg-blue-100 rounded-lg flex items-center justify-center flex-shrink-0">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
                  </div>
                  <div>
                    <p className="text-sm font-bold text-gray-700">Seguimiento para pasajero</p>
                    <p className="text-xs text-gray-400">Mapa en vivo, solo lectura</p>
                  </div>
                </div>
                {urlSeg ? (
                  <div className="flex gap-2">
                    <input readOnly value={urlSeg} className="flex-1 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 font-mono text-gray-600 truncate" />
                    <button
                      onClick={() => copiarLink(urlSeg, "seg")}
                      className="px-3 py-2 rounded-lg text-xs font-bold transition-colors flex-shrink-0"
                      style={{ background: copiadoKey === "seg" ? "#10b981" : "#3b82f6", color: "white" }}
                    >
                      {copiadoKey === "seg" ? "✓" : "Copiar"}
                    </button>
                  </div>
                ) : (
                  <button
                    disabled={generandoToken === "seguimiento"}
                    onClick={() => generarTokenReserva(r.id, "seguimiento")}
                    className="w-full py-2 rounded-lg text-xs font-bold text-white transition-colors disabled:opacity-60"
                    style={{ background: "#3b82f6" }}
                  >
                    {generandoToken === "seguimiento" ? "Generando..." : "Generar link de seguimiento"}
                  </button>
                )}
              </div>

              {/* Link conductor tercero */}
              {tieneTercero && (
                <div className="mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-7 h-7 bg-amber-100 rounded-lg flex items-center justify-center flex-shrink-0">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.5"><path d="M8 6v6M16 6v6M2 12h19.6M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><circle cx="15" cy="18" r="2"/></svg>
                    </div>
                    <div>
                      <p className="text-sm font-bold text-gray-700">Link para conductor tercero</p>
                      <p className="text-xs text-gray-400">Solo toca "Iniciar" — GPS automático</p>
                    </div>
                  </div>
                  {urlCond ? (
                    <div className="flex gap-2">
                      <input readOnly value={urlCond} className="flex-1 text-xs bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 font-mono text-gray-600 truncate" />
                      <button
                        onClick={() => copiarLink(urlCond, "cond")}
                        className="px-3 py-2 rounded-lg text-xs font-bold transition-colors flex-shrink-0"
                        style={{ background: copiadoKey === "cond" ? "#10b981" : "#f59e0b", color: "white" }}
                      >
                        {copiadoKey === "cond" ? "✓" : "Copiar"}
                      </button>
                    </div>
                  ) : (
                    <button
                      disabled={generandoToken === "conductor_tercero"}
                      onClick={() => generarTokenReserva(r.id, "conductor_tercero")}
                      className="w-full py-2 rounded-lg text-xs font-bold text-white transition-colors disabled:opacity-60"
                      style={{ background: "#f59e0b" }}
                    >
                      {generandoToken === "conductor_tercero" ? "Generando..." : "Generar link de conductor"}
                    </button>
                  )}
                </div>
              )}

              {/* Regenerar ambos */}
              <div className="border-t pt-4 mt-2 flex gap-2">
                <button
                  disabled={!!generandoToken}
                  onClick={() => generarTokenReserva(r.id, tieneTercero ? "ambos" : "seguimiento")}
                  className="flex-1 py-2 rounded-lg text-xs font-bold border border-gray-200 text-gray-500 hover:bg-gray-50 transition-colors disabled:opacity-40"
                >
                  {generandoToken ? "Generando..." : "Regenerar links (invalida los anteriores)"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Modal: Asignar recurso en bloque ─────────────────────────────── */}
      {modalAsignarBloque && (() => {
        const { sinAsignar, todasLasFilas, cotizacionId } = modalAsignarBloque;
        const targetsPreview: Reserva[] = bloqueScope === "pendientes"
          ? sinAsignar
          : todasLasFilas.filter(r =>
              r.fecha_servicio &&
              (!bloqueFechaDesde || r.fecha_servicio >= bloqueFechaDesde) &&
              (!bloqueFechaHasta  || r.fecha_servicio <= bloqueFechaHasta)
            );
        const allDates = todasLasFilas.map(r => r.fecha_servicio).filter(Boolean).sort() as string[];
        const minFB = allDates[0] || "";
        const maxFB = allDates[allDates.length - 1] || "";

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4" style={{ background: "rgba(0,0,0,0.55)" }} onClick={() => setModalAsignarBloque(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col" style={{ maxHeight: "calc(100vh - 16px)" }} onClick={e => e.stopPropagation()}>

              {/* Header */}
              <div className="px-6 py-4 rounded-t-2xl shrink-0" style={{ background: "#0b315f" }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center text-lg">🚌</div>
                    <div>
                      <h2 className="text-base font-black text-white">Programar en masa</h2>
                      <p className="text-white/60 text-xs">
                        {cotizacionId ? `Cot.#${cotizacionId} · ` : ""}{todasLasFilas.length} servicio(s) en el contrato
                      </p>
                    </div>
                  </div>
                  <button onClick={() => setModalAsignarBloque(null)} className="p-2 rounded-xl hover:bg-white/10 transition-colors shrink-0">
                    <X size={18} className="text-white/70" />
                  </button>
                </div>
              </div>

              <div className="p-6 space-y-5 overflow-y-auto flex-1">

                {/* Selector de alcance */}
                <div>
                  <p className="text-[11px] font-black uppercase tracking-widest text-gray-400 mb-2">¿A qué servicios aplicar?</p>
                  <div className="grid grid-cols-2 gap-2">
                    <label className={`flex items-start gap-2.5 p-3 rounded-xl cursor-pointer border-2 transition-all ${bloqueScope === "pendientes" ? "border-[#0b315f] bg-blue-50" : "border-gray-200"}`}>
                      <input type="radio" name="bloqueScope" checked={bloqueScope === "pendientes"} onChange={() => setBloqueScope("pendientes")} className="mt-0.5 accent-[#0b315f]" />
                      <div>
                        <p className="font-bold text-sm text-gray-800">Sin asignar</p>
                        <p className="text-[11px] text-gray-500">{sinAsignar.length} servicio(s) sin vehículo</p>
                      </div>
                    </label>
                    <label className={`flex items-start gap-2.5 p-3 rounded-xl cursor-pointer border-2 transition-all ${bloqueScope === "rango" ? "border-[#0b315f] bg-blue-50" : "border-gray-200"}`}>
                      <input type="radio" name="bloqueScope" checked={bloqueScope === "rango"} onChange={() => setBloqueScope("rango")} className="mt-0.5 accent-[#0b315f]" />
                      <div>
                        <p className="font-bold text-sm text-gray-800">Rango de fechas</p>
                        <p className="text-[11px] text-gray-500">Elige período específico</p>
                      </div>
                    </label>
                  </div>

                  {/* Pickers de fecha (solo en modo rango) */}
                  {bloqueScope === "rango" && (
                    <div className="mt-3 flex gap-3 flex-wrap">
                      <div className="flex-1 min-w-[130px]">
                        <p className="text-[9px] font-black uppercase text-gray-400 mb-1">Desde</p>
                        <input
                          type="date"
                          value={bloqueFechaDesde}
                          onChange={e => setBloqueFechaDesde(e.target.value)}
                          min={minFB} max={maxFB}
                          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#0b315f]"
                        />
                      </div>
                      <div className="flex-1 min-w-[130px]">
                        <p className="text-[9px] font-black uppercase text-gray-400 mb-1">Hasta</p>
                        <input
                          type="date"
                          value={bloqueFechaHasta}
                          onChange={e => setBloqueFechaHasta(e.target.value)}
                          min={minFB} max={maxFB}
                          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-[#0b315f]"
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Asignación */}
                <div>
                  <p className="text-[11px] font-black uppercase tracking-widest text-gray-400 mb-2">Asignación</p>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Vehículo *</label>
                      <select
                        value={asignarVehId}
                        onChange={e => setAsignarVehId(e.target.value)}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]"
                      >
                        <option value="">Seleccionar vehículo...</option>
                        {vehiculos.filter(v => v.estado !== "inactivo").map(v => (
                          <option key={v.id} value={v.id}>
                            {v.placa} — {v.categoria || "Sin categoría"}{v.capacidad_pasajeros ? ` · ${v.capacidad_pasajeros} pax` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Conductor <span className="text-gray-300 font-normal normal-case">(opcional)</span></label>
                      <select
                        value={asignarCondId}
                        onChange={e => setAsignarCondId(e.target.value)}
                        className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]"
                      >
                        <option value="">Sin conductor por ahora</option>
                        {conductores.filter(c => c.estado !== "inactivo").map(c => (
                          <option key={c.id} value={c.id}>{c.nombre}{c.licencia ? ` · ${c.licencia}` : ""}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {/* Preview */}
                <div className="rounded-xl px-4 py-3 flex items-center gap-3" style={{ background: targetsPreview.length > 0 ? "#e0f2fe" : "#f3f4f6" }}>
                  <span className="text-xl">📊</span>
                  <div className="text-xs" style={{ color: targetsPreview.length > 0 ? "#0369a1" : "#9ca3af" }}>
                    {targetsPreview.length > 0 ? (
                      <>
                        <b>{targetsPreview.length} servicio(s)</b> pasarán a <b>Programada</b> automáticamente.
                        {targetsPreview.filter(r => r.estado !== "pendiente").length > 0 && (
                          <span className="block mt-0.5 text-[10px] opacity-70">
                            ({targetsPreview.filter(r => r.estado !== "pendiente").length} ya programados solo actualizan su recurso)
                          </span>
                        )}
                      </>
                    ) : (
                      "No hay servicios en el rango seleccionado."
                    )}
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="flex gap-3 px-6 py-4 border-t shrink-0" style={{ borderColor: "#e2e8f0" }}>
                <button
                  onClick={ejecutarAsignacionBloque}
                  disabled={!asignarVehId || asignando || targetsPreview.length === 0}
                  className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-40 transition-all"
                  style={{ background: "#0b315f" }}
                >
                  {asignando ? "Programando..." : `Programar ${targetsPreview.length} servicio(s)`}
                </button>
                <button onClick={() => setModalAsignarBloque(null)} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmEliminarId !== null && (() => {
        const r = reservas.find(x => x.id === confirmEliminarId);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setConfirmEliminarId(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
              <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
                <Trash2 size={22} className="text-red-600" />
              </div>
              <h3 className="text-lg font-bold text-gray-900 text-center mb-1">¿Eliminar reserva?</h3>
              {r && (
                <p className="text-sm text-gray-500 text-center mb-5">
                  <b className="text-gray-800">#{r.id} · {nombreCliente(r.cliente_id)}</b><br />
                  {fmtFecha(r.fecha_servicio)} {r.hora_servicio?.slice(0, 5) || ""}
                </p>
              )}
              <p className="text-xs text-red-600 text-center mb-5 font-medium">Esta acción no se puede deshacer.</p>
              <div className="flex gap-3">
                <button
                  onClick={() => setConfirmEliminarId(null)}
                  className="flex-1 py-2.5 rounded-xl font-bold text-sm border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => eliminarReserva(confirmEliminarId)}
                  className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white bg-red-600 hover:bg-red-700 transition-colors"
                >
                  Sí, eliminar
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {modalFinalizar && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setModalFinalizar(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center mx-auto mb-4">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            </div>
            <h3 className="text-lg font-bold text-gray-900 text-center mb-1">Finalizar servicio manualmente</h3>
            <p className="text-xs text-gray-500 text-center mb-4">Este estado normalmente lo cierra el conductor desde la app. Indica el motivo de cierre manual.</p>
            <textarea
              value={modalFinalizar.motivo}
              onChange={e => setModalFinalizar(m => m ? { ...m, motivo: e.target.value } : m)}
              placeholder="Ej: Conductor olvidó finalizar en app, servicio verificado por coordinador..."
              className="w-full border rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:border-purple-400 mb-4"
              rows={3}
              autoFocus
            />
            <div className="flex gap-3">
              <button onClick={() => setModalFinalizar(null)} className="flex-1 py-2.5 rounded-xl font-bold text-sm border border-gray-200 text-gray-600 hover:bg-gray-50">
                Cancelar
              </button>
              <button onClick={confirmarFinalizar} className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white" style={{ background: "#7c3aed" }}>
                Confirmar cierre
              </button>
            </div>
          </div>
        </div>
      )}

      {reservaModal && (
        <ModalManifiesto
          reservaId={reservaModal.id}
          clienteId={reservaModal.cliente_id}
          capacidad={capacidadDe(reservaModal)}
          sincronizadoApp={!!reservaModal.sincronizado_app}
          fechaSincronizacion={reservaModal.fecha_sincronizacion || null}
          origen={(reservaModal as any).origen || null}
          destino={(reservaModal as any).destino || null}
          puntoRetorno={(reservaModal as any).punto_retorno || null}
          paradasJson={reservaModal.paradas_json || null}
          cotizacionId={reservaModal.cotizacion_id}
          vehiculoId={reservaModal.vehiculo_id}
          onClose={() => setModalReservaId(null)}
          onChange={async () => {
            await cargarOcupaciones();
            const { data } = await supabase.from("reservas").select("sincronizado_app, fecha_sincronizacion").eq("id", reservaModal.id).single();
            if (data) setReservas(prev => prev.map(r => r.id === reservaModal.id ? { ...r, ...data } : r));
          }}
        />
      )}

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Reservas</h1>
          <p className="text-gray-400 text-sm mt-1">
            Programacion de servicios · flota propia o empresa tercerizada
            {hoyCount > 0 && <span className="ml-2 font-bold text-[#0b315f]">· {hoyCount} servicio(s) hoy</span>}
            {conSobrecupo > 0 && <span className="ml-2 font-bold text-red-600">· {conSobrecupo} con sobrecupo</span>}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => setMostrarModalPrograma(true)}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm text-white transition-colors hover:opacity-90"
            style={{ background: "#0b315f" }}
          >
            <Calendar size={15} /> Programa fijo
          </button>
          {editandoId && (
            <button onClick={limpiar} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
              Cancelar edicion
            </button>
          )}
        </div>
      </div>

      {/* FLUJO DE ESTADOS */}
      <div className="bg-white rounded-2xl border shadow-sm px-5 py-4">
        <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">Flujo de estados</p>
        <div className="flex items-center gap-1 flex-wrap">
          {ESTADOS_RESERVA_LISTA.map((est, i, arr) => {
            const cfg   = ESTADO_CFG[est];
            const desc  = cfg.descripcion;
            const count = reservas.filter(r => r.estado === est).length;
            return (
              <React.Fragment key={est}>
                <div className="flex flex-col items-center">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold" style={{ background: cfg.bg, color: cfg.color }}>
                    <div className="w-2 h-2 rounded-full" style={{ background: cfg.dot }} />
                    {cfg.label}
                    {count > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-black text-white" style={{ background: cfg.dot }}>{count}</span>}
                  </div>
                  <p className="text-[9px] text-gray-400 mt-1 text-center max-w-[80px]">{desc}</p>
                </div>
                {i < arr.length - 1 && <span className="text-gray-300 text-lg mb-4">-</span>}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {[
          { label: "Total",         valor: totalRes,     color: "#0b315f", bg: "#eef3f8" },
          { label: "Pendientes",    valor: pendientes,   color: "#854d0e", bg: "#fef9c3" },
          { label: "Programadas",   valor: programadas,  color: "#0369a1", bg: "#e0f2fe" },
          { label: "Confirmadas",   valor: confirmadas,  color: "#166534", bg: "#dcfce7" },
          { label: "En curso",      valor: enCurso,      color: "#1d4ed8", bg: "#dbeafe" },
          { label: "Próx. 7 días",  valor: proximos7d,   color: "#0f766e", bg: "#f0fdfa" },
          { label: "Sobrecupo",     valor: conSobrecupo, color: "#991b1b", bg: "#fee2e2" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* KPIs financieros */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {[
          { label: "Ventas reservas",  valor: fmtSoles(ventas),      color: "#166534", bg: "#dcfce7" },
          { label: "Costos proveedor", valor: fmtSoles(costos),      color: "#991b1b", bg: "#fee2e2" },
          { label: "Margen total",     valor: fmtSoles(margenTotal), color: "#1d4ed8", bg: "#dbeafe" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-4 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-xs font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* CIERRE ADMINISTRATIVO (Dimensión B) — familia violeta + contorno, distinto a propósito del ciclo operativo */}
      <section className="rounded-2xl border px-5 py-4" style={{ borderColor: "#ddd6fe", background: "#faf5ff" }}>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[10px] font-black uppercase tracking-widest" style={{ color: "#6d28d9" }}>🧾 Cierre administrativo</span>
          <span className="text-[10px] text-purple-400">· solo servicios finalizados</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {([
            { est: "por_liquidar" as EstadoAdmin, valor: porLiquidar },
            { est: "liquidada"    as EstadoAdmin, valor: liquidadas },
            { est: "facturada"    as EstadoAdmin, valor: facturadas },
            { est: "cobrada"      as EstadoAdmin, valor: cobradas },
          ]).map(k => {
            const cfg = ESTADOS_ADMIN[k.est];
            return (
              <div key={k.est} className="rounded-xl px-3 py-2.5 bg-white border" style={{ borderColor: cfg.color + "55" }}>
                <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: cfg.color }}>{cfg.label}</p>
                <p className="text-2xl font-black mt-0.5" style={{ color: cfg.color }}>{k.valor}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* FORMULARIO PROGRAMACION */}
      {mostrarForm && editandoId && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>P</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Programar reserva #{editandoId}</h2>
              <p className="text-xs text-gray-400">
                {(() => { const r = reservas.find(r => r.id === editandoId); return r ? ((r as any).origen || "") + " -> " + ((r as any).destino || "") + " · " + fmtSoles(Number(r.precio_cliente || 0)) : ""; })()}
              </p>
            </div>
          </div>

          <div className="rounded-xl px-4 py-3 text-xs" style={{ background: "#e0f2fe", color: "#0369a1" }}>
            Al asignar recursos el estado pasara automaticamente a Programada. Para tercerizado el sistema verificara que la empresa no tenga documentos vencidos.
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos del servicio</p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Campo label="Fecha *">
                <input type="date" className={inputCls()} value={form.fecha_servicio} onChange={f("fecha_servicio")} />
              </Campo>
              <Campo label="Hora *">
                <input type="time" className={inputCls()} value={form.hora_servicio} onChange={f("hora_servicio")} />
              </Campo>
              <Campo label="Tipo de asignacion">
                <select className={inputCls()} value={form.tipo_asignacion} onChange={e => setForm(p => ({ ...p, tipo_asignacion: e.target.value, vehiculo_id: "", conductor_id: "", empresa_tercerizada_id: "", vehiculo_tercero_id: "", conductor_tercero_id: "", costo_proveedor: "" }))}>
                  <option value="propio">Flota propia</option>
                  <option value="tercerizado">Empresa tercerizada</option>
                </select>
              </Campo>
              <Campo label="Estado">
                <select className={inputCls()} value={form.estado} onChange={f("estado")}>
                  <option value="pendiente">Pendiente</option>
                  <option value="programada">Programada</option>
                  <option value="confirmada">Confirmada</option>
                  <option value="finalizada">Finalizada</option>
                  <option value="cancelada">Cancelada</option>
                </select>
              </Campo>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
              {form.tipo_asignacion === "propio" ? "Asignacion de flota propia" : "Empresa tercerizada"}
            </p>

            {form.tipo_asignacion === "propio" ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label={"Vehiculo (" + vehiculosAptos.length + " aptos) *"}>
                  <select className={inputCls()} value={form.vehiculo_id} onChange={f("vehiculo_id")}>
                    <option value="">Seleccionar vehiculo</option>
                    {vehiculosAptos.map(v => (
                      <option key={v.id} value={v.id}>{v.placa} · {v.categoria}{v.capacidad_pasajeros ? " · " + v.capacidad_pasajeros + " pax" : ""}</option>
                    ))}
                  </select>
                </Campo>
                <Campo label={"Conductor (" + conductoresDisponibles.length + " disponibles) *"}>
                  <select className={inputCls()} value={form.conductor_id} onChange={f("conductor_id")}>
                    <option value="">Seleccionar conductor</option>
                    {conductoresDisponibles.map(c => (
                      <option key={c.id} value={c.id}>{c.nombre}{c.licencia ? " · " + c.licencia : ""}</option>
                    ))}
                  </select>
                </Campo>
                <Campo label="Observaciones">
                  <input className={inputCls()} placeholder="Notas del servicio..." value={form.observaciones} onChange={f("observaciones")} />
                </Campo>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Campo label="Empresa tercerizada *" span={2}>
                    <select className={inputCls()} value={form.empresa_tercerizada_id} onChange={f("empresa_tercerizada_id")}>
                      <option value="">Seleccionar empresa</option>
                      {empresasTer.filter(e => e.estado === "activo").map(e => (
                        <option key={e.id} value={e.id}>
                          {riesgoEmpresa(docsTercero, e.id) === "alto" ? "ALERTA " : ""}
                          {e.razon_social}{e.ruc ? " · RUC " + e.ruc : ""}
                        </option>
                      ))}
                    </select>
                  </Campo>
                  <Campo label="Costo S/ *">
                    <input type="number" min="0" className={inputCls()} placeholder="0.00" value={form.costo_proveedor} onChange={f("costo_proveedor")} />
                    {form.costo_proveedor && (() => {
                      const r = reservas.find(r => r.id === editandoId);
                      const margen = Number(r?.precio_cliente || 0) - Number(form.costo_proveedor);
                      return <p className="text-[10px] mt-1 font-bold" style={{ color: margen >= 0 ? "#166534" : "#dc2626" }}>Margen: {fmtSoles(margen)}</p>;
                    })()}
                  </Campo>
                </div>

                {empSelId && riesgoEmpSel === "alto" && (
                  <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-800">
                    ATENCION: Esta empresa tiene documentos obligatorios vencidos. Revisar modulo de Tercerizadas antes de confirmar.
                  </div>
                )}

                {empSelId && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Campo label={"Vehiculo del tercero (" + vehEmpSel.length + " disponibles)"}>
                      <select className={inputCls()} value={form.vehiculo_tercero_id} onChange={f("vehiculo_tercero_id")}>
                        <option value="">Sin especificar</option>
                        {vehEmpSel.map(v => (
                          <option key={v.id} value={v.id}>{v.placa} · {v.categoria}{v.capacidad ? " · " + v.capacidad + " pax" : ""}</option>
                        ))}
                      </select>
                    </Campo>
                    <Campo label={"Conductor del tercero (" + condEmpSel.length + ")"}>
                      <select className={inputCls()} value={form.conductor_tercero_id} onChange={f("conductor_tercero_id")}>
                        <option value="">Sin especificar</option>
                        {condEmpSel.map(c => {
                          const licOk = !c.vencimiento_licencia || diasPara(c.vencimiento_licencia)! >= 0;
                          return <option key={c.id} value={c.id}>{!licOk ? "VENC. " : ""}{c.nombre}{c.licencia ? " · " + c.licencia : ""}</option>;
                        })}
                      </select>
                    </Campo>
                    <Campo label="Observaciones">
                      <input className={inputCls()} placeholder="Notas del servicio..." value={form.observaciones} onChange={f("observaciones")} />
                    </Campo>
                  </div>
                )}

                {empSelId && (() => {
                  const emp = empresasTer.find(e => e.id === empSelId);
                  if (!emp) return null;
                  return (
                    <div className="rounded-xl px-4 py-3 text-xs bg-gray-50 flex gap-6 flex-wrap">
                      <div><span className="text-gray-400">Empresa:</span> <b>{emp.razon_social}</b></div>
                      {emp.telefono && <div><span className="text-gray-400">Tel:</span> {emp.telefono}</div>}
                      <div><span className="text-gray-400">Flota disponible:</span> <b>{vehEmpSel.length} vehiculos</b></div>
                      <div><span className="text-gray-400">Conductores:</span> <b>{condEmpSel.length}</b></div>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button onClick={guardarReserva} disabled={guardando} className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60" style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : "Guardar programacion"}
            </button>
            <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* FILTROS */}
      <section className="space-y-3">
        {/* Fila 1: búsqueda, estado, tipo, servicio */}
        <div className="flex flex-col md:flex-row gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[180px]">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
            <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none" placeholder="Buscar por cliente, ruta o ID..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
          </div>
          <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}>
            <option value="todos">Todos los estados</option>
            {Object.entries(ESTADO_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
            <option value="todos">Todos los tipos</option>
            <option value="propia">Propia</option>
            <option value="tercerizada">Tercerizada</option>
          </select>
          <div className="flex gap-1 rounded-xl p-1" style={{ background: "#f1f5f9" }}>
            {(["todos", "fijo", "eventual"] as const).map(t => (
              <button
                key={t}
                onClick={() => setFiltroServicio(t)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
                style={{
                  background: filtroServicio === t ? "white" : "transparent",
                  color: filtroServicio === t ? "#0b315f" : "#9ca3af",
                  boxShadow: filtroServicio === t ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                }}
              >
                {t === "todos" ? "Todos" : t === "fijo" ? "Fijos" : "Eventuales"}
              </button>
            ))}
          </div>
        </div>

        {/* Fila 2: rango de fechas + atajos + toggles */}
        <div className="flex flex-col md:flex-row gap-3 flex-wrap items-center">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-400 font-bold whitespace-nowrap">📅 Desde</span>
            <input
              type="date"
              className="border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
              value={filtroDesde}
              onChange={e => setFiltroDesde(e.target.value)}
            />
            <span className="text-xs text-gray-400 font-bold">Hasta</span>
            <input
              type="date"
              className="border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
              value={filtroHasta}
              onChange={e => setFiltroHasta(e.target.value)}
            />
          </div>

          <div className="flex gap-1.5 flex-wrap">
            {([ { key: "hoy", label: "Hoy" }, { key: "7dias", label: "Próx. 7d" }, { key: "semana", label: "Esta semana" }, { key: "mes", label: "Este mes" } ] as const).map(a => (
              <button
                key={a.key}
                onClick={() => setRangoRapido(a.key)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors hover:bg-[#0b315f] hover:text-white hover:border-[#0b315f]"
                style={{ borderColor: "#e2e8f0", color: "#475569" }}
              >
                {a.label}
              </button>
            ))}
            {(filtroDesde || filtroHasta) && (
              <button
                onClick={() => setRangoRapido("limpiar")}
                className="px-3 py-1.5 rounded-lg text-xs font-bold border border-red-200 text-red-500 hover:bg-red-50 transition-colors"
              >
                × Limpiar fechas
              </button>
            )}
          </div>

          <div className="flex gap-2 md:ml-auto flex-wrap items-center">
            <button
              onClick={() => setFiltroPorAsignar(v => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-all"
              style={{
                background: filtroPorAsignar ? "#fef9c3" : "white",
                borderColor: filtroPorAsignar ? "#eab308" : "#e2e8f0",
                color: filtroPorAsignar ? "#854d0e" : "#6b7280",
              }}
            >
              ⚡ Por asignar
            </button>
            {filtroServicio !== "fijo" && (
              <button
                onClick={() => setVistaAgenda(v => !v)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-all"
                style={{
                  background: vistaAgenda ? "#eef3f8" : "white",
                  borderColor: vistaAgenda ? "#0b315f" : "#e2e8f0",
                  color: vistaAgenda ? "#0b315f" : "#6b7280",
                }}
              >
                📅 Vista agenda
              </button>
            )}
            <button
              onClick={sincronizarCoordenadas}
              disabled={sincCoords.activo}
              title="Rellena lat/lng de las paradas desde la cotización vinculada, sin abrir cada servicio"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-all disabled:opacity-60"
              style={{ background: sincCoords.activo ? "#f0f9ff" : "white", borderColor: "#0ea5e9", color: "#0369a1" }}
            >
              📍 {sincCoords.activo ? "Sincronizando…" : "Sincronizar coordenadas"}
            </button>
            <div className="flex items-center px-4 py-1.5 bg-gray-50 border rounded-xl text-sm text-gray-400">
              {filtradas.length} resultado{filtradas.length !== 1 ? "s" : ""}
            </div>
          </div>
        </div>
      </section>

      {/* Toast de progreso de sincronización de coordenadas */}
      {sincCoords.activo && sincCoords.msg && (
        <div className="fixed bottom-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg text-white text-sm font-semibold" style={{ background: "#0369a1" }}>
          <span className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          {sincCoords.msg}
        </div>
      )}

      {/* VISTA AGRUPADA POR CONTRATO (solo cuando filtro = Fijos) */}
      {filtroServicio === "fijo" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          {/* Sub-encabezado */}
          <div className="px-5 py-3 border-b flex items-center justify-between" style={{ background: "#f8fafc", borderColor: "#e2e8f0" }}>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
              Contratos activos · {gruposContratos?.length ?? 0} contrato(s) · {filtradas.length} servicio(s)
            </p>
            <p className="text-[10px] text-gray-400">Haz clic en un contrato para ver sus fechas</p>
          </div>

          {loading ? (
            <div className="p-10 text-center text-gray-400 flex items-center justify-center gap-2">
              <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
              Cargando...
            </div>
          ) : !gruposContratos || gruposContratos.length === 0 ? (
            <div className="p-10 text-center text-gray-400">
              <p className="text-3xl mb-2">📋</p>
              <p className="font-medium">No hay servicios fijos</p>
              <p className="text-sm mt-1">Usa el botón <b>Programa fijo</b> para generar servicios desde una cotización.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {gruposContratos.map(({ clave, cotId, filas, proxima }) => {
                const r0           = filas[0];
                const expandido    = expandidoContrato === clave;
                const pendientesG  = filas.filter(r => r.estado === "pendiente").length;
                const programadasG = filas.filter(r => r.estado === "programada").length;
                const finalizadasG = filas.filter(r => r.estado === "finalizada").length;
                const totalIngreso  = filas.reduce((s, r) => s + Number(r.precio_cliente || 0), 0);
                // Precio/día = ingreso total ÷ fechas únicas (correcto para multi-vehículo e IDA+RETORNO)
                const fechasUnicas  = new Set(filas.map(r => r.fecha_servicio)).size;
                const precioPorDia  = fechasUnicas > 0 ? totalIngreso / fechasUnicas : 0;
                // Contar vehículos únicos: servicios IDA de un solo día
                const primerDia     = filas.find(r => r.fecha_servicio)?.fecha_servicio;
                const vehs          = primerDia ? filas.filter(r => r.fecha_servicio === primerDia && (r as any).direccion_servicio !== "retorno").length : 1;

                return (
                  <div key={clave} className="border-t" style={{ borderColor: "#f1f5f9" }}>
                    {/* Fila resumen del contrato */}
                    <div
                      className="flex items-center gap-4 px-5 py-4 cursor-pointer hover:bg-gray-50 transition-colors"
                      onClick={() => setExpandidoContrato(expandido ? null : clave)}
                    >
                      <span className="text-gray-300 text-xs w-3 shrink-0">{expandido ? "▼" : "▶"}</span>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {cotId && (
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md" style={{ background: "#eef3f8", color: "#0b315f" }}>
                              Cot.#{cotId}
                            </span>
                          )}
                          <span className="font-bold text-gray-800">{nombreCliente(r0.cliente_id)}</span>
                          <span className="text-xs text-gray-400 truncate max-w-[200px]">
                            {(r0 as any).origen || "-"} → {(r0 as any).destino || "-"}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                          <span className="text-[11px] text-gray-500">{fechasUnicas} día{fechasUnicas !== 1 ? "s" : ""}</span>
                          {vehs > 1 && <span className="text-[11px] text-gray-500">· {vehs} vehículos/día</span>}
                          <span className="text-[11px] text-gray-500">· {filas.length} servicios en total</span>
                          {proxima && (
                            <span className="text-[11px] text-gray-500">
                              Próximo: <b>{fmtFecha(proxima.fecha_servicio)}</b>
                            </span>
                          )}
                          {pendientesG > 0  && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md" style={{ background: "#fef9c3", color: "#854d0e" }}>{pendientesG} pendientes</span>}
                          {programadasG > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md" style={{ background: "#e0f2fe", color: "#0369a1" }}>{programadasG} programadas</span>}
                          {finalizadasG > 0 && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md" style={{ background: "#ede9fe", color: "#6d28d9" }}>{finalizadasG} finalizadas</span>}
                        </div>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        {/* Botón programar en masa (visible siempre que haya servicios activos) */}
                        {filas.some(r => r.estado !== "cancelada" && r.estado !== "finalizada") && (
                          <button
                            onClick={e => {
                              e.stopPropagation();
                              const activas = filas.filter(r => r.estado !== "cancelada" && r.estado !== "finalizada");
                              const sinAsig = filas.filter(r => !r.vehiculo_id && !r.empresa_tercerizada_id);
                              const dates = activas.map(r => r.fecha_servicio).filter(Boolean).sort() as string[];
                              setModalAsignarBloque({ cotizacionId: cotId, sinAsignar: sinAsig, todasLasFilas: activas });
                              setBloqueScope("pendientes");
                              setBloqueFechaDesde(dates[0] || "");
                              setBloqueFechaHasta(dates[dates.length - 1] || "");
                              setAsignarVehId("");
                              setAsignarCondId("");
                            }}
                            className="flex items-center gap-1.5 text-[11px] font-bold px-3 py-1.5 rounded-xl transition-all border"
                            style={{ background: "#fff7ed", color: "#c2410c", borderColor: "#fed7aa" }}
                            title="Programar en masa: asignar vehículo y conductor a varios servicios"
                          >
                            🚌 Programar en masa
                          </button>
                        )}
                        <div className="text-right">
                          <div className="font-bold text-gray-800 text-sm">{fmtSoles(precioPorDia)}/día</div>
                          <div className="text-[10px] text-gray-400 mt-0.5">
                            {fmtSoles(totalIngreso)} ingreso total
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Sub-tabla de fechas */}
                    {expandido && (
                      <div style={{ background: "#f8fafc", borderTop: "1px solid #e2e8f0" }}>
                        <table className="w-full text-xs">
                          <thead>
                            <tr style={{ borderBottom: "1px solid #e2e8f0" }}>
                              {["Fecha", "Día", "Hora", "Estado", "Admin", "Recurso", "Ingreso", "Acciones"].map(h => (
                                <th key={h} className="px-4 py-2 text-left text-[10px] font-bold text-gray-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {filas.map(r => {
                              const estCfg   = ESTADO_CFG[r.estado] || ESTADO_CFG.pendiente;
                              const esTer    = r.tipo === "tercerizada";
                              const esHoyR   = r.fecha_servicio === hoy;
                              const diaSem   = r.fecha_servicio
                                ? new Date(r.fecha_servicio + "T12:00:00").toLocaleDateString("es-PE", { weekday: "short" })
                                : "-";
                              return (
                                <tr key={r.id} className="border-t hover:bg-white transition-colors" style={{ borderColor: "#e2e8f0" }}>
                                  <td className="px-4 py-2.5">
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <span className="font-medium text-gray-700">{fmtFecha(r.fecha_servicio)}</span>
                                      {esHoyR && <span className="text-[9px] font-bold text-orange-500">HOY</span>}
                                      {r.direccion_servicio === "ida" && (
                                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full" style={{ background: "#dbeafe", color: "#1d4ed8" }}>IDA</span>
                                      )}
                                      {r.direccion_servicio === "retorno" && (
                                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full" style={{ background: "#ede9fe", color: "#6d28d9" }}>RETORNO</span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-4 py-2.5 capitalize text-gray-500">{diaSem}</td>
                                  <td className="px-4 py-2.5 text-gray-500">{r.hora_servicio?.slice(0,5) || "-"}</td>
                                  <td className="px-4 py-2.5">
                                    <select
                                      value={r.estado}
                                      onChange={e => cambiarEstadoRapido(r.id, e.target.value as EstadoReserva)}
                                      className="text-[11px] font-bold px-2 py-1 rounded-lg border-0 cursor-pointer"
                                      style={{ background: estCfg.bg, color: estCfg.color }}
                                    >
                                                      {Object.entries(ESTADO_CFG).filter(([k]) => k !== "en_curso").map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                                    </select>
                                  </td>
                                  <td className="px-4 py-2.5">
                                    {aplicaAdmin(r.estado) ? (() => {
                                      const ad  = (r.estado_admin || ESTADO_ADMIN_INICIAL) as EstadoAdmin;
                                      const cfg = ESTADOS_ADMIN[ad];
                                      const sig = siguienteAdmin(ad);
                                      return (
                                        <button onClick={() => avanzarAdmin(r)} disabled={!sig}
                                          title={sig ? `Avanzar a "${ESTADOS_ADMIN[sig].label}"` : "Cobrada · estado final"}
                                          className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-white disabled:cursor-default"
                                          style={{ border: `1.5px solid ${cfg.color}`, color: cfg.color }}>
                                          🧾 {cfg.label}{sig ? " ›" : ""}
                                        </button>
                                      );
                                    })() : <span className="text-gray-300">—</span>}
                                  </td>
                                  <td className="px-4 py-2.5 text-gray-600 max-w-[160px]">
                                    <div className="truncate">
                                      {esTer
                                        ? nombreEmpTer(r.empresa_tercerizada_id) + (r.vehiculo_tercero_id && nombreVehTercero(r.vehiculo_tercero_id) !== "-" ? " · " + nombreVehTercero(r.vehiculo_tercero_id) : "")
                                        : (nombreVehiculo(r.vehiculo_id) !== "-" ? nombreVehiculo(r.vehiculo_id) + " · " + nombreConductor(r.conductor_id) : "Sin asignar")}
                                    </div>
                                  </td>
                                  <td className="px-4 py-2.5 font-bold text-gray-700">{fmtSoles(Number(r.precio_cliente || 0))}</td>
                                  <td className="px-4 py-2.5">
                                    <div className="flex gap-1.5">
                                      <button
                                        onClick={() => setModalReservaId(r.id)}
                                        className="flex items-center gap-1 bg-purple-50 hover:bg-purple-100 text-purple-700 text-[10px] font-bold px-2 py-1 rounded-lg transition-colors"
                                      >
                                        <FileText size={11} /> Pax
                                      </button>
                                      <button
                                        onClick={() => setModalLinksId(r.id)}
                                        className="flex items-center gap-1 bg-amber-50 hover:bg-amber-100 text-amber-700 text-[10px] font-bold px-2 py-1 rounded-lg transition-colors"
                                      >
                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                                      </button>
                                      <button
                                        onClick={() => editarReserva(r)}
                                        className="flex items-center gap-1 bg-gray-50 hover:bg-gray-100 text-gray-600 text-[10px] font-bold px-2 py-1 rounded-lg transition-colors border border-gray-200"
                                      >
                                        <Pencil size={11} />
                                      </button>
                                      <button
                                        onClick={() => setConfirmEliminarId(r.id)}
                                        className="flex items-center gap-1 bg-red-50 hover:bg-red-100 text-red-600 text-[10px] font-bold px-2 py-1 rounded-lg transition-colors"
                                      >
                                        <Trash2 size={11} />
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {filtradas.length > 0 && (
            <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
              <span>{filtradas.length} servicios en {gruposContratos?.length ?? 0} contrato(s)</span>
              <span>AFA ERP · Operaciones</span>
            </div>
          )}
        </section>
      )}

      {/* VISTA AGENDA */}
      {filtroServicio !== "fijo" && vistaAgenda && (
        <section className="space-y-4">
          {loading ? (
            <div className="p-10 text-center text-gray-400 flex items-center justify-center gap-2">
              <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...
            </div>
          ) : agendaGrupos.length === 0 ? (
            <div className="bg-white rounded-2xl border shadow-sm p-10 text-center text-gray-400">
              <p className="text-3xl mb-2">📅</p>
              <p className="font-medium">No hay servicios en el período seleccionado</p>
            </div>
          ) : agendaGrupos.map(({ fecha, filas, label, esHoyGrupo, esPasado }) => (
            <div key={fecha} className="bg-white rounded-2xl shadow-sm overflow-hidden" style={{ border: esHoyGrupo ? "2px solid #3b82f6" : "1px solid #e2e8f0" }}>
              <div className="px-5 py-3 flex items-center justify-between" style={{ background: esHoyGrupo ? "#dbeafe" : esPasado ? "#f9fafb" : "#f8fafc" }}>
                <div className="flex items-center gap-3">
                  {esHoyGrupo && <span className="text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full text-white" style={{ background: "#2563eb" }}>HOY</span>}
                  {esPasado && <span className="text-[10px] font-bold uppercase tracking-widest text-gray-400">pasado</span>}
                  <span className="font-bold capitalize" style={{ color: esHoyGrupo ? "#1d4ed8" : esPasado ? "#9ca3af" : "#374151" }}>{label}</span>
                </div>
                <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: esHoyGrupo ? "#bfdbfe" : "#f1f5f9", color: esHoyGrupo ? "#1d4ed8" : "#475569" }}>
                  {filas.length} servicio{filas.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="divide-y divide-gray-50">
                {filas.map(r => {
                  const estCfg  = ESTADO_CFG[r.estado] || ESTADO_CFG.pendiente;
                  const esTer   = r.tipo === "tercerizada";
                  const badge   = urgenciaBadge(r.fecha_servicio, r.estado);
                  const ocup    = ocupacionMap[r.id];
                  const totalPax = ocup?.total_pasajeros || 0;
                  const cap     = capacidadDe(r);
                  const sob     = ocup?.sobrecupo || false;
                  return (
                    <div key={r.id} className="flex items-center gap-4 px-5 py-3 hover:bg-gray-50 transition-colors" style={{ boxShadow: sob ? "inset 3px 0 0 #dc2626" : urgenciaFila(r.fecha_servicio, r.estado) }}>
                      <div className="shrink-0 text-right min-w-[44px]">
                        <div className="text-sm font-bold text-gray-600">{r.hora_servicio?.slice(0,5) || "--:--"}</div>
                        <div className="font-mono text-[10px] text-gray-300">#{r.id}</div>
                      </div>
                      <div className="w-px h-8 rounded-full shrink-0" style={{ background: estCfg.dot }} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-gray-800 truncate">{nombreCliente(r.cliente_id)}</span>
                          {badge && <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full" style={{ background: badge.color + "20", color: badge.color }}>{badge.label}</span>}
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: estCfg.bg, color: estCfg.color }}>{estCfg.label}</span>
                          {aplicaAdmin(r.estado) && (() => {
                            const ad  = (r.estado_admin || ESTADO_ADMIN_INICIAL) as EstadoAdmin;
                            const cfg = ESTADOS_ADMIN[ad];
                            return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-white" style={{ border: `1.5px solid ${cfg.color}`, color: cfg.color }}>🧾 {cfg.label}</span>;
                          })()}
                          {sob && <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">SOBRECUPO</span>}
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5 truncate">{(r as any).origen || "-"} → {(r as any).destino || "-"}</div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {esTer ? nombreEmpTer(r.empresa_tercerizada_id) : (nombreVehiculo(r.vehiculo_id) !== "-" ? nombreVehiculo(r.vehiculo_id) + " · " + nombreConductor(r.conductor_id) : "Sin asignar")}
                          {cap !== null && <span className="ml-2 text-[10px] font-bold">{totalPax}/{cap} pax</span>}
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <button onClick={() => setModalReservaId(r.id)} className="flex items-center gap-1 bg-purple-50 hover:bg-purple-100 text-purple-700 text-[10px] font-bold px-2 py-1.5 rounded-lg transition-colors"><FileText size={11} /></button>
                        <button onClick={() => setModalLinksId(r.id)} className="flex items-center gap-1 bg-amber-50 hover:bg-amber-100 text-amber-700 text-[10px] font-bold px-2 py-1.5 rounded-lg transition-colors">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        </button>
                        <button onClick={() => editarReserva(r)} className="flex items-center justify-center bg-gray-50 hover:bg-gray-100 text-gray-600 p-1.5 rounded-lg border border-gray-200 transition-colors"><Pencil size={11} /></button>
                        <button onClick={() => setConfirmEliminarId(r.id)} className="flex items-center justify-center bg-red-50 hover:bg-red-100 text-red-600 p-1.5 rounded-lg transition-colors"><Trash2 size={11} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* TABLA PLANA (Todos / Eventuales) */}
      {filtroServicio !== "fijo" && !vistaAgenda && (
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <th className="p-3 w-8"></th>
                {["ID", "Cliente", "Ruta", "Fecha", "Recurso", "Ocupacion", "Estado", "Administrativo", "Acciones"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={10} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                    Cargando...
                  </div>
                </td></tr>
              ) : filtradas.length === 0 ? (
                <tr><td colSpan={10} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">🎫</p>
                  <p className="font-medium">No hay reservas</p>
                </td></tr>
              ) : filtradas.map((r, idx) => {
                const estCfg    = ESTADO_CFG[r.estado] || ESTADO_CFG.pendiente;
                const expandido = expandidoId === r.id;
                const margen    = Number(r.margen || 0);
                const dias      = diasPara(r.fecha_servicio);
                const esTer     = r.tipo === "tercerizada";
                const badge     = urgenciaBadge(r.fecha_servicio, r.estado);
                const urgShadow = urgenciaFila(r.fecha_servicio, r.estado);
                const riesgo    = esTer && r.empresa_tercerizada_id ? riesgoEmpresa(docsTercero, r.empresa_tercerizada_id) : "ok";
                const ocup      = ocupacionMap[r.id];
                const cap       = capacidadDe(r);
                const totalPax  = ocup?.total_pasajeros || 0;
                const sobrecupo = ocup?.sobrecupo || false;
                const pctOcup   = ocup?.ocupacion_pct;
                const esFijo    = !esEventual(r);

                let ocupBg = "#f8fafc", ocupColor = "#475569";
                if (sobrecupo) { ocupBg = "#fee2e2"; ocupColor = "#991b1b"; }
                else if (cap !== null && totalPax > 0 && totalPax >= cap * 0.9) { ocupBg = "#fef3c7"; ocupColor = "#92400e"; }
                else if (cap !== null && totalPax > 0) { ocupBg = "#dcfce7"; ocupColor = "#166534"; }

                return (
                  <React.Fragment key={r.id}>
                    {idx === sepIdx && (
                      <tr>
                        <td colSpan={10} className="px-4 py-2">
                          <div className="flex items-center gap-3">
                            <div className="flex-1 h-px" style={{ background: "#bbf7d0" }} />
                            <span className="text-[10px] font-black uppercase tracking-widest px-3 py-1 rounded-full border" style={{ color: "#166534", background: "#f0fdf4", borderColor: "#bbf7d0" }}>
                              ↑ Pasados · Próximos ↓
                            </span>
                            <div className="flex-1 h-px" style={{ background: "#bbf7d0" }} />
                          </div>
                        </td>
                      </tr>
                    )}
                    <tr
                      className={"border-t transition-colors cursor-pointer " + (editandoId === r.id ? "bg-blue-50" : sobrecupo ? "bg-red-50/40" : "hover:bg-gray-50")}
                      style={{ borderColor: "#f1f5f9", boxShadow: sobrecupo ? "inset 3px 0 0 #dc2626" : urgShadow }}
                      onClick={() => {
                        const nId = expandido ? null : r.id;
                        setExpandidoId(nId);
                        if (nId) { cargarParadasReserva(nId); cargarPasajerosCliente(nId, r.cliente_id); }
                      }}
                    >
                      <td className="p-3 text-gray-300 text-xs">{expandido ? "v" : ">"}</td>

                      <td className="p-3">
                        <span className="font-black font-mono text-[#0b315f]">#{r.id}</span>
                        {badge && <div className="text-[9px] font-bold" style={{ color: badge.color }}>{badge.label}</div>}
                        {riesgo === "alto" && <div className="text-[9px] font-bold text-red-600">DOC VENC.</div>}
                        {sobrecupo && <div className="text-[9px] font-bold text-red-600">SOBRECUPO</div>}
                        <div className="mt-0.5">
                          <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full" style={{ background: esFijo ? "#eef3f8" : "#ede9fe", color: esFijo ? "#0b315f" : "#6d28d9" }}>
                            {esFijo ? "Fijo" : "Eventual"}
                          </span>
                        </div>
                      </td>

                      <td className="p-3 font-bold text-gray-800 max-w-[120px]">
                        <div className="truncate">{nombreCliente(r.cliente_id)}</div>
                      </td>

                      <td className="p-3 text-gray-600 max-w-[160px]">
                        <div className="truncate text-xs">{(r as any).origen || "-"} - {(r as any).destino || "-"}</div>
                      </td>

                      <td className="p-3 text-xs">
                        <div className="text-gray-700 font-medium">{fmtFecha(r.fecha_servicio)}</div>
                        <div className="text-gray-400">{r.hora_servicio?.slice(0,5) || "-"}</div>
                        {dias !== null && dias > 0 && <div className="text-[9px] font-bold text-gray-400">+{dias}d</div>}
                        {dias !== null && dias < 0 && <div className="text-[9px] font-bold text-gray-400">{dias}d</div>}
                      </td>

                      <td className="p-3 text-xs">
                        {esTer ? (
                          <div>
                            <div className="font-bold text-gray-800 truncate max-w-[120px]">{nombreEmpTer(r.empresa_tercerizada_id)}</div>
                            {r.vehiculo_tercero_id && <div className="text-gray-400 font-mono">{nombreVehTercero(r.vehiculo_tercero_id)}</div>}
                          </div>
                        ) : (
                          <div>
                            <div className="font-bold text-gray-800">{nombreVehiculo(r.vehiculo_id)}</div>
                            <div className="text-gray-400">{nombreConductor(r.conductor_id)}</div>
                          </div>
                        )}
                        <span className="mt-1 inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-md" style={esTer ? { background: "#ede9fe", color: "#6d28d9" } : { background: "#dbeafe", color: "#1d4ed8" }}>
                          {esTer ? "Tercerizado" : "Propio"}
                        </span>
                      </td>

                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => setModalReservaId(r.id)}
                          className="group flex flex-col items-start gap-0.5 px-2.5 py-1.5 rounded-lg cursor-pointer transition-transform hover:scale-105"
                          style={{ background: ocupBg }}
                        >
                          <span className="font-black text-xs leading-tight" style={{ color: ocupColor }}>
                            {totalPax}{cap !== null ? "/" + cap : ""}
                            {sobrecupo ? " (!)" : ""}
                          </span>
                          <span className="text-[9px] font-bold uppercase tracking-wide opacity-70" style={{ color: ocupColor }}>
                            {pctOcup !== null && pctOcup !== undefined ? pctOcup + "%" : "Ver pax"}
                          </span>
                        </button>
                      </td>

                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <select
                          value={r.estado}
                          onChange={e => cambiarEstadoRapido(r.id, e.target.value as EstadoReserva)}
                          className="text-xs font-bold px-2 py-1 rounded-lg border-0 cursor-pointer"
                          style={{ background: estCfg.bg, color: estCfg.color }}
                        >
                          {Object.entries(ESTADO_CFG).filter(([k]) => k !== "en_curso").map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                        </select>
                      </td>

                      {/* Dimensión B · estado administrativo (contorno + violeta + 🧾, distinto del operativo) */}
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        {aplicaAdmin(r.estado) ? (() => {
                          const ad  = (r.estado_admin || ESTADO_ADMIN_INICIAL) as EstadoAdmin;
                          const cfg = ESTADOS_ADMIN[ad];
                          const sig = siguienteAdmin(ad);
                          return (
                            <button
                              onClick={() => avanzarAdmin(r)}
                              disabled={!sig}
                              title={sig ? `Avanzar a "${ESTADOS_ADMIN[sig].label}"` : "Cobrada · estado final"}
                              className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-full bg-white transition-colors disabled:cursor-default"
                              style={{ border: `1.5px solid ${cfg.color}`, color: cfg.color }}
                            >
                              🧾 {cfg.label}{sig ? " ›" : ""}
                            </button>
                          );
                        })() : <span className="text-gray-300 text-xs">—</span>}
                      </td>

                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <div className="flex gap-1.5 flex-wrap">
                          <button onClick={() => setModalReservaId(r.id)} className="flex items-center gap-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
                            <FileText size={13} /> Manifiesto
                          </button>
                          <button onClick={() => setModalLinksId(r.id)} className="flex items-center gap-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                            Links
                          </button>
                          <button onClick={() => editarReserva(r)} title="Editar" className="flex items-center justify-center bg-gray-50 hover:bg-gray-100 text-gray-600 p-2 rounded-xl transition-colors border border-gray-200">
                            <Pencil size={14} />
                          </button>
                          <button onClick={() => setConfirmEliminarId(r.id)} title="Eliminar" className="flex items-center justify-center bg-red-50 hover:bg-red-100 text-red-600 p-2 rounded-xl transition-colors">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>

                    {expandido && (
                      <tr style={{ background: "#f8fafc" }} className="border-t">
                        <td colSpan={10} className="px-6 py-5">
                          {(() => {
                            const paradasR = paradasMap[r.id] || [];
                            const tieneJSON = r.paradas_json && r.paradas_json.length > 0;
                            return (
                              <div className="mb-5">
                                {/* Cabecera */}
                                <div className="flex items-center justify-between mb-3">
                                  <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">
                                    Paradas del recorrido ({cargandoPar[r.id] ? "..." : paradasR.length})
                                    {paradasR.length > 0 && (
                                      <span className="ml-2 font-normal normal-case text-gray-300">
                                        · Inicio: <b className="text-green-600">{paradasR[0].nombre}</b>
                                        {paradasR.length > 1 && <> · Destino: <b className="text-red-500">{paradasR[paradasR.length - 1].nombre}</b></>}
                                      </span>
                                    )}
                                  </p>
                                  <div className="flex gap-2">
                                    {(tieneJSON || r.cotizacion_id) && (
                                      <button onClick={() => crearParadasDesdeJSON(r.id)} className="text-xs font-bold px-3 py-1.5 rounded-lg text-white" style={{ background: "#be185d" }}>
                                        {paradasR.length === 0 ? "Desde cotización" : "Rehacer desde cotización"}
                                      </button>
                                    )}
                                    <button onClick={() => setModalReservaId(r.id)} className="text-xs font-bold px-3 py-1.5 rounded-lg border hover:bg-blue-50" style={{ borderColor: "#0b315f", color: "#0b315f" }}>
                                      Manifiesto
                                    </button>
                                  </div>
                                </div>

                                {/* Lista de paradas */}
                                {paradasR.length === 0 ? (
                                  <div className="rounded-xl border-2 border-dashed p-4 text-center text-xs text-gray-400 mb-3">
                                    {tieneJSON
                                      ? <span>Tiene {r.paradas_json!.length} paradas en la cotización. Haz clic en "Desde cotización".</span>
                                      : "Sin paradas aún. Agrégalas con el formulario de abajo."}
                                  </div>
                                ) : (
                                  <div className="mb-3">
                                    <TimelineParadasEditable
                                      reservaId={r.id}
                                      paradas={paradasMap[r.id] || []}
                                      onChange={async () => {
                                        const p = await recargarParadas(r.id);
                                        await syncOrigenDestino(r.id, p);
                                      }}
                                      compacto={true}
                                      onEliminar={(pId) => eliminarParadaInline(r.id, pId)}
                                    />
                                  </div>
                                )}

                                {/* Formulario agregar parada */}
                                <div className="flex gap-2 items-center bg-white border border-dashed rounded-xl px-3 py-2" style={{ borderColor: "#cbd5e1" }}>
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2.5" className="flex-shrink-0">
                                    <circle cx="12" cy="12" r="2"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                                  </svg>
                                  <ParadaPlacesInput
                                    value={nuevoParNombre[r.id] || ""}
                                    onChange={v => setNuevoParNombre(prev => ({ ...prev, [r.id]: v }))}
                                    onSelect={pl => {
                                      setNuevoParNombre(prev => ({ ...prev, [r.id]: pl.nombre }));
                                      setNuevoParDir(prev => ({ ...prev, [r.id]: pl.direccion }));
                                      setNuevoParLat(prev => ({ ...prev, [r.id]: pl.lat }));
                                      setNuevoParLng(prev => ({ ...prev, [r.id]: pl.lng }));
                                    }}
                                    onEnter={() => agregarParadaInline(r.id)}
                                    mapsLoaded={mapsLoaded}
                                  />
                                  <input
                                    type="time"
                                    value={nuevoParHora[r.id] || ""}
                                    onChange={e => setNuevoParHora(prev => ({ ...prev, [r.id]: e.target.value }))}
                                    className="text-xs bg-transparent outline-none text-gray-500 w-20"
                                    title="Hora estimada (opcional)"
                                  />
                                  <button
                                    onClick={() => agregarParadaInline(r.id)}
                                    disabled={!nuevoParNombre[r.id]?.trim() || agregandoPar2[r.id]}
                                    className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-white transition-colors disabled:opacity-30"
                                    style={{ background: "#0b315f" }}
                                    title="Agregar parada"
                                  >
                                    {agregandoPar2[r.id]
                                      ? <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                      : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                    }
                                  </button>
                                </div>
                              </div>
                            );
                          })()}

                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs border-t pt-4" style={{ borderColor: "#e2e8f0" }}>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Servicio</p>
                              <p>
                                <span className="text-gray-400">Origen:</span>{" "}
                                <span className="font-medium text-green-700">
                                  {paradasMap[r.id]?.length > 0 ? paradasMap[r.id][0].nombre : ((r as any).origen || "-")}
                                </span>
                              </p>
                              <p>
                                <span className="text-gray-400">Destino:</span>{" "}
                                <span className="font-medium text-red-600">
                                  {paradasMap[r.id]?.length > 0 ? paradasMap[r.id][paradasMap[r.id].length - 1].nombre : ((r as any).destino || "-")}
                                </span>
                              </p>
                              <p><span className="text-gray-400">Fecha:</span> {fmtFecha(r.fecha_servicio)}</p>
                              <p><span className="text-gray-400">Hora:</span> {r.hora_servicio?.slice(0,5) || "-"}</p>
                              <p>
                                <span className="text-gray-400">Tipo servicio: </span>
                                <span className="font-bold" style={{ color: !esEventual(r) ? "#0b315f" : "#6d28d9" }}>
                                  {!esEventual(r) ? "Fijo" : "Eventual"}
                                </span>
                              </p>
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">
                                {esTer ? "Empresa tercerizada" : "Flota propia"}
                              </p>
                              {esTer ? (
                                <>
                                  <p>{nombreEmpTer(r.empresa_tercerizada_id)}</p>
                                  {r.vehiculo_tercero_id && <p>{nombreVehTercero(r.vehiculo_tercero_id)}</p>}
                                  {riesgo === "alto" && <p className="text-red-600 font-bold">Documentos vencidos</p>}
                                </>
                              ) : (
                                <>
                                  <p>{nombreVehiculo(r.vehiculo_id)}</p>
                                  <p>{nombreConductor(r.conductor_id)}</p>
                                </>
                              )}
                              {cap !== null && <p><span className="text-gray-400">Capacidad:</span> <b>{cap} pax</b></p>}
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Manifiesto</p>
                              <p><span className="text-gray-400">Total:</span> <b>{totalPax}</b> pasajero(s)</p>
                              <p><span className="text-gray-400">Abordados:</span> <b className="text-green-700">{ocup?.abordados || 0}</b></p>
                              <p><span className="text-gray-400">Pendientes:</span> <b className="text-yellow-700">{ocup?.pendientes || 0}</b></p>
                              {sobrecupo && <p className="text-red-600 font-bold">Excede capacidad</p>}
                              <button onClick={() => setModalReservaId(r.id)} className="mt-1 text-[10px] font-bold px-2 py-1 rounded-lg text-white" style={{ background: "#0b315f" }}>
                                Abrir manifiesto
                              </button>
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Financiero / Sync</p>
                              <div className="flex justify-between"><span className="text-gray-400">Precio</span><b>{fmtSoles(Number(r.precio_cliente || 0))}</b></div>
                              <div className="flex justify-between"><span className="text-gray-400">Margen</span>
                                <span className="font-black" style={{ color: margen >= 0 ? "#166534" : "#991b1b" }}>{fmtSoles(margen)}</span>
                              </div>
                              <div className="flex justify-between border-t pt-1" style={{ borderColor: "#e5e7eb" }}>
                                <span className="text-gray-400">App Pasajero</span>
                                <b className={r.sincronizado_app ? "text-green-700" : "text-gray-400"}>
                                  {r.sincronizado_app ? "Sincronizado" : "Sin enviar"}
                                </b>
                              </div>
                              {r.fecha_sincronizacion && (
                                <p className="text-[10px] text-gray-400">
                                  {new Date(r.fecha_sincronizacion).toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtradas.length > 0 && (
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>{filtradas.length} de {totalRes} reservas</span>
            <span>AFA ERP · Operaciones</span>
          </div>
        )}
      </section>
      )}
    </main>
  );
}