"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { Calendar, FileText, Pencil, Sparkles, Trash2, X } from "lucide-react";
import {
  ESTADOS_RESERVA, ESTADOS_RESERVA_LISTA, ORDEN_ESTADO,
  ESTADOS_ADMIN, ESTADOS_ADMIN_LISTA, aplicaAdmin, ESTADO_ADMIN_INICIAL, etiquetaAdmin, siguienteAdmin,
} from "@/lib/estados";
import type { EstadoReserva, EstadoAdmin } from "@/lib/estados";
import { idAfa } from "@/lib/folio";
import {
  guardarReservas, normalizarAsignacion, avisosDe, margenEnVivo, sugerirCosto, type TramoHermano,
  describirResultado,
} from "@/lib/reservas-pacto";
import { AFECTACIONES, afectacionDe, type CodigoAfectacion } from "@/lib/finanzas/afectacion";
import ModalManifiesto from "@/components/programacion/ModalManifiesto";
import ModalGenerarPrograma, { type ModoPrograma } from "@/components/programacion/ModalGenerarPrograma";
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
    const gmaps = (window as any).google.maps;
    acRef.current = new gmaps.places.Autocomplete(inputRef.current, {
      componentRestrictions: { country: "pe" },
      // Solo los campos que se leen abajo. OJO: name/formatted_address/geometry (y place_id)
      // son todos Basic Data, así que acotarlos NO cambia el SKU que factura Google; es solo
      // higiene, para no arrastrar datos que nadie usa.
      fields: ["formatted_address", "geometry", "name"],
      types: ["geocode", "establishment"],
    });
    // NO se le pasa sessionToken: este widget legacy (google.maps.places.Autocomplete) no
    // acepta esa opción — abre y cierra su propia sesión internamente en cada selección.
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

// Editor inline de hora "solo este servicio": muestra la hora como botón y, al pulsarlo,
// abre un <input type="time"> con confirmar/cancelar. Gestiona su propio estado local para
// no re-renderizar toda la tabla en cada tecla; solo avisa al padre en el submit. Se usa en
// las tres vistas (lista principal, contratos fijos, agenda). `editable=false` la deja como
// texto (servicios finalizados / en curso / pasados, que no se deben re-horar).
function HoraEditable({ hora, editable, onSubmit, textClass }: {
  hora: string | null;
  editable: boolean;
  onSubmit: (nueva: string) => void;
  textClass?: string;
}) {
  const [editando, setEditando] = useState(false);
  const [val, setVal] = useState("");
  const display = hora?.slice(0, 5) || "-";

  if (!editable) return <span className={textClass}>{display}</span>;

  if (editando) {
    const confirmar = () => {
      const v = val.trim();
      setEditando(false);
      if (v && v !== display) onSubmit(v);
    };
    return (
      <span className="inline-flex items-center gap-1" onClick={e => e.stopPropagation()}>
        <input
          type="time"
          value={val}
          autoFocus
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") confirmar(); if (e.key === "Escape") setEditando(false); }}
          onClick={e => e.stopPropagation()}
          className="text-xs border rounded px-1 py-0.5 outline-none w-[76px]"
          style={{ borderColor: "#0b315f" }}
        />
        <button onClick={e => { e.stopPropagation(); confirmar(); }} title="Aplicar" className="text-green-600 hover:text-green-700">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
        <button onClick={e => { e.stopPropagation(); setEditando(false); }} title="Cancelar" className="text-gray-400 hover:text-gray-600">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </span>
    );
  }

  return (
    <button
      onClick={e => { e.stopPropagation(); setVal(display === "-" ? "" : display); setEditando(true); }}
      title="Editar hora (solo este servicio)"
      className={"inline-flex items-center gap-1 group hover:text-[#0b315f] hover:underline decoration-dotted underline-offset-2 " + (textClass || "")}
    >
      {display}
      <Pencil size={10} className="opacity-0 group-hover:opacity-50" />
    </button>
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
  id: number; codigo?: string | null; cliente_id: number | null; cotizacion_id: number | null;
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
  lote_generacion?: string | null;
  ruta_nombre?: string | null;
  /**
   * contrato | adicional | contingencia. Sin esta marca, la salida extra que el
   * cliente pidió a S/ 480 se fundía con las líneas del contrato en la liquidación y
   * dejaba de existir como concepto (supabase/reservas-04-servicios-adicionales.sql).
   * Opcional: si esa migración no se corrió, la columna no llega y se lee como
   * 'contrato', que es el default de la base.
   */
  origen_contractual?: string | null;
  /** De cuánto se partió al generarlo. Solo para poder mostrar la diferencia. */
  precio_cotizado?: number | null;
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
  // El PRECIO DE VENTA no existía en ninguna pantalla del ERP: una vez creado el
  // servicio, su precio era inmodificable. Por eso "el cliente pidió una unidad mayor"
  // era literalmente irrepresentable y el operador solo podía cambiar el bus y callarse.
  precio_cliente: "",
  cambio_motivo: "", cambio_nota: "",
};

/** Motivos de un clic. Si declarar el porqué cuesta un párrafo, nadie lo declara. */
const MOTIVOS_CAMBIO = [
  { clave: "cliente_unidad_mayor",   nombre: "Cliente pidió unidad mayor",  lado: "ambos"  },
  { clave: "cliente_unidad_menor",   nombre: "Cliente pidió unidad menor",  lado: "ambos"  },
  { clave: "cliente_cambio_ruta",    nombre: "Cliente cambió ruta u hora",  lado: "ambos"  },
  { clave: "proveedor_sin_unidad",   nombre: "Proveedor sin unidad",        lado: "compra" },
  { clave: "proveedor_mejor_precio", nombre: "Proveedor más barato",        lado: "compra" },
  { clave: "proveedor_incumplio",    nombre: "Proveedor incumplió",         lado: "compra" },
  { clave: "precio_renegociado",     nombre: "Importe renegociado",         lado: "compra" },
  { clave: "averia_unidad",          nombre: "Avería de la unidad",         lado: "compra" },
  { clave: "correccion_carga",       nombre: "Corrección de un dato",       lado: "ambos"  },
];

// ─── CARGA ACOTADA (rendimiento) ────────────────────────────────────────────
// La tabla `reservas` crece sin tope (los "Programa fijo" generan meses adelante).
// Traer TODO con select("*") en cada carga descargaba megabytes y trababa la página.
// Ahora la LISTA trae solo una ventana de fechas y solo las columnas que se pintan
// (sin `paradas_json`, la columna más pesada — se hidrata bajo demanda al expandir/abrir
// el manifiesto). Los TOTALES del tablero salen de un resumen aparte para seguir exactos.
//
// COLS_LISTA se validó contra el esquema real de la tabla: `punto_retorno` NO existe
// como columna en `reservas` (enumerarla rompería el query entero) — el modal siempre
// recibía null en ese prop. Si agregas una columna nueva que la lista deba mostrar,
// añádela aquí o no llegará al cliente.
const COLS_LISTA =
  "id,codigo,cliente_id,cotizacion_id,vehiculo_id,conductor_id,tipo,estado,estado_admin," +
  "fecha_servicio,hora_servicio,precio_cliente,costo_proveedor,margen,observaciones,created_at," +
  "tipo_asignacion,empresa_tercerizada_id,vehiculo_tercero_id,conductor_tercero_id," +
  "tipo_servicio_detalle,sincronizado_app,fecha_sincronizacion,token_seguimiento," +
  "token_conductor_tercero,token_expira_at,reserva_vinculada_id,direccion_servicio," +
  "lote_generacion,origen,destino,ruta_nombre,origen_contractual,precio_cotizado";

// Columnas de `reservas` cuya migración es OPCIONAL. PostgREST rechaza el select
// entero por una columna desconocida, así que pedirlas sin red dejaría la pantalla
// de Reservas en blanco en cualquier entorno donde el SQL todavía no se corrió.
// Se reintenta sin ellas: la lista se pinta igual, solo sin el chip de origen.
const COLS_OPCIONALES = ["origen_contractual", "precio_cotizado"];

const quitarColumna = (cols: string, col: string) =>
  cols.split(",").map(c => c.trim()).filter(c => c !== col).join(",");

const columnaFaltante = (msg: string) =>
  COLS_OPCIONALES.find(c => new RegExp(`\\b${c}\\b`, "i").test(msg)) ?? null;

/** 'contrato' cuando la columna no existe o viene vacía: es el default de la base. */
const origenDe = (r: { origen_contractual?: string | null }) =>
  String(r.origen_contractual || "contrato");
const esAdicional = (r: { origen_contractual?: string | null }) => origenDe(r) !== "contrato";

// Proyección ultraligera para los agregados globales (KPIs, flujo de estados, sumas).
const COLS_RESUMEN = "id,estado,estado_admin,fecha_servicio,precio_cliente,costo_proveedor,margen,sincronizado_app";

// Ventana por defecto al abrir (días relativos a hoy Lima). Cubre la operación diaria;
// para ver fuera de ella el usuario usa los filtros de fecha o el botón "Ver todo".
const VENTANA_DIAS_ATRAS    = 30;
const VENTANA_DIAS_ADELANTE = 90;
const PAGE_SUPABASE = 1000; // tope de filas por respuesta de PostgREST

// Agregados globales del tablero (independientes de la ventana visible).
type Resumen = {
  total: number;
  porEstado: Record<string, number>;
  porAdmin: Record<string, number>;
  hoy: number;
  prox7d: number;
  sincronizadas: number;
  ventas: number;
  costos: number;
  margen: number;
  sobrecupo: number;
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

// Sentido del servicio (IDA / RETORNO). Aplica sobre todo a transporte de personal (fijos).
// Prioriza el campo canónico `direccion_servicio` (lo escribe ModalGenerarPrograma al crear
// el par ida+retorno); si falta, cae a una heurística CONSERVADORA solo para fijos:
//   · fijo_solo_ida            → IDA (por definición es un tramo único de ida)
//   · reserva_vinculada_id set → RETORNO (el retorno se genera vinculado a su ida)
// Devuelve null cuando no se puede afirmar con confianza (no se pinta chip).
function sentidoServicio(r: Reserva): "ida" | "retorno" | null {
  if (r.direccion_servicio === "ida") return "ida";
  if (r.direccion_servicio === "retorno") return "retorno";
  if (esEventual(r)) return null;
  if (r.tipo_servicio_detalle === "fijo_solo_ida") return "ida";
  if (r.reserva_vinculada_id != null) return "retorno";
  return null;
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

// ── Helpers de hora (edición inline "solo este servicio") ──────────────────
// Trabajan siempre sobre "HH:MM" (la BD guarda `time`, que llega como "HH:MM:SS").
function minutosHHMM(s: string): number {
  const [h, m] = s.slice(0, 5).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function fmtHHMM(min: number): string {
  let t = min % 1440; if (t < 0) t += 1440; // envolver dentro del día (una parada podría cruzar medianoche)
  return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
}
// Corre una hora "HH:MM(:SS)" por un delta en minutos, devolviendo "HH:MM".
function correrHora(hhmm: string, deltaMin: number): string {
  return fmtHHMM(minutosHHMM(hhmm) + deltaMin);
}
// Delta con signo legible: "+30 min · sale después" / "−15 min · sale antes".
function etiquetaDelta(deltaMin: number): string {
  if (deltaMin === 0) return "sin cambio";
  const signo = deltaMin > 0 ? "+" : "−";
  const abs = Math.abs(deltaMin);
  const txt = abs >= 60
    ? `${Math.floor(abs / 60)}h${abs % 60 ? " " + (abs % 60) + "min" : ""}`
    : `${abs} min`;
  return `${signo}${txt} · sale ${deltaMin > 0 ? "después" : "antes"}`;
}

// Un servicio se puede re-horar salvo que ya se esté operando o ya haya pasado: no le
// cambiamos el bus al conductor a media ruta ni reescribimos historial.
function horaEditable(r: Reserva): boolean {
  if (r.estado === "finalizada" || r.estado === "cancelada" || r.estado === "en_curso") return false;
  if (r.fecha_servicio && r.fecha_servicio < fechaLima()) return false;
  return true;
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

// `paradaId` = id REAL de la fila en `paradas`. Con id > 0 el proxy persiste lat/lng con la
// service-role key; con id 0 (parada que todavía no existe como fila) la persistencia la cubre
// la caché por texto del servidor, que igual evita repetir la llamada facturable a Google.
async function geocodificar(direccion: string, paradaId = 0): Promise<{ lat: number; lng: number } | null> {
  if (!direccion.trim()) return null;
  try {
    const res = await fetch("/api/geocodificar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paradas: [{ id: paradaId, nombre: direccion }] }),
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
  const router = useRouter();
  const [clientes,     setClientes]     = useState<Cliente[]>([]);
  const [vehiculos,    setVehiculos]    = useState<Vehiculo[]>([]);
  const [conductores,  setConductores]  = useState<Conductor[]>([]);
  const [empresasTer,  setEmpresasTer]  = useState<EmpresaTercerizada[]>([]);
  const [vehTercero,   setVehTercero]   = useState<VehiculoTercero[]>([]);
  /** Aviso de las migraciones del Pacto pendientes. No bloquea: informa. */
  const [msgPacto, setMsgPacto] = useState("");
  /** Último costo pactado con el proveedor elegido — el tarifario de compra ya existe. */
  const [costoSug, setCostoSug] = useState<{ costo: number; base: string; dias: number } | null>(null);
  const [condTercero,  setCondTercero]  = useState<ConductorTercero[]>([]);
  const [docsTercero,  setDocsTercero]  = useState<DocumentoTercero[]>([]);
  const [otPendientePorVeh, setOtPendientePorVeh] = useState<Set<number>>(new Set()); // vehiculo_id (flota propia) con OT abierta
  const [reservas,     setReservas]     = useState<Reserva[]>([]);
  const [resumen,      setResumen]      = useState<Resumen | null>(null); // agregados globales del tablero
  // KPIs financieros (Ventas/Costos/Margen): a diferencia de `resumen`, SÍ dependen de la
  // ventana de fechas visible (filtroDesde/filtroHasta, o mes en curso si no hay filtro) y
  // excluyen canceladas — ver `rangoFinanciero()`.
  const [resumenFin,   setResumenFin]   = useState<{ ventas: number; costos: number; margen: number; desde: string | null; hasta: string | null } | null>(null);
  const [verTodo,      setVerTodo]      = useState(false);                // true = histórico completo (fuera de la ventana)
  const [limiteVista,  setLimiteVista]  = useState(100);                  // filas renderizadas ("Cargar más")
  const [cotMapNum,    setCotMapNum]    = useState<Record<number, string>>({}); // cotizacion_id → numero_cotizacion
  const [cotMapAsunto, setCotMapAsunto] = useState<Record<number, string>>({}); // cotizacion_id → asunto
  const [ocupacionMap, setOcupacionMap] = useState<Record<number, Ocupacion>>({});
  const [loading,      setLoading]      = useState(true); // arranca cargando (evita parpadeo "No hay reservas")
  const [guardando,    setGuardando]    = useState(false);
  const [paradasMap,   setParadasMap]   = useState<Record<number, any[]>>({});
  // Solo para la columna Ruta: primera/última parada real por reserva. `reservas.origen/destino`
  // es una copia denormalizada que se desfasa si se reeditan las paradas desde la cotización.
  const [rutaMap,      setRutaMap]      = useState<Record<number, { o: string; d: string }>>({});
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
  const [filtroSentido, setFiltroSentido] = useState<"todos" | "ida" | "retorno">("todos");
  const [filtroOrigen,  setFiltroOrigen]  = useState<"todos" | "contrato" | "adicional">("todos");
  const [form, setForm] = useState(FORM_VACIO);
  const [modalReservaId,       setModalReservaId]       = useState<number | null>(null);
  // El mismo modal en dos modos. null = cerrado. Ver ModalGenerarPrograma.Props.modo.
  const [modoPrograma, setModoPrograma] = useState<ModoPrograma | null>(null);
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
  // ── Selección múltiple + borrado en grupo ────────────────────────────────
  const [seleccionados,   setSeleccionados]   = useState<Set<number>>(new Set());
  const [confirmLote,     setConfirmLote]     = useState<{ aEliminar: Reserva[]; bloqueados: Reserva[]; incluidosVinculados: number } | null>(null);
  const [textoConfirmLote, setTextoConfirmLote] = useState("");
  const [eliminandoLote,  setEliminandoLote]  = useState(false);
  const [ultimoLote,      setUltimoLote]      = useState<{ lote: string; cantidad: number } | null>(null);
  // ── Reclasificar el origen de servicios ya creados ───────────────────────
  // Los adicionales de meses pasados nacieron como 'contrato' porque la opción no
  // existía. Quien sabe cuáles son es el operador, no el sistema: esto es la forma
  // de que lo declare sin tocar la base a mano.
  const [modalOrigen, setModalOrigen] = useState<{
    destino: "adicional" | "contrato";
    ids: number[];      // lo que el operador marcó
    todos: number[];    // …más los tramos hermanos: el día entero, no medio día
    liquidadas: { id: number; codigo: string | null; estado: string; cuantas: number }[];
    cargando: boolean;
  } | null>(null);
  const [origenMotivo,    setOrigenMotivo]    = useState("");
  const [origenNota,      setOrigenNota]      = useState("");
  const [aplicandoOrigen, setAplicandoOrigen] = useState(false);
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
    otrasReservas: Reserva[];   // todos los servicios activos del contrato (sin filtrar)
    horaOriginal: string;       // hora del servicio editado, antes de guardar
    resumen: string;            // "Vehículo · Conductor" para mostrar en el modal
  } | null>(null);
  const [aplicarScope,         setAplicarScope]         = useState<"todos" | "rango">("todos");
  const [aplicarDesde,         setAplicarDesde]         = useState("");
  const [aplicarHasta,         setAplicarHasta]         = useState("");
  const [aplicarCampos,        setAplicarCampos]        = useState<"todo" | "conductor">("todo");
  const [aplicarOtraHora,      setAplicarOtraHora]      = useState(false);
  const [aplicarOtraUnidad,    setAplicarOtraUnidad]    = useState(false);
  const [aplicando,            setAplicando]            = useState(false);
  const [sincCoords,           setSincCoords]           = useState<{ activo: boolean; msg: string }>({ activo: false, msg: "" });
  // ── Edición de hora "solo este servicio" (MVP) ────────────────────────────
  const [modalHora,            setModalHora]            = useState<{
    reserva: Reserva;
    horaOriginal: string;      // "HH:MM"
    horaNueva: string;         // "HH:MM"
    deltaMin: number;          // horaNueva − horaOriginal, en minutos
    paradas: { id: number; nombre: string; de: string; a: string }[]; // preview (solo con hora)
  } | null>(null);
  const [guardandoHora,        setGuardandoHora]        = useState(false);
  // Tras cambiar la hora de un servicio ya avisado/sincronizado: preguntar si re-notificar.
  const [modalRenotificar,     setModalRenotificar]     = useState<{ reservaId: number; label: string } | null>(null);
  const [renotificando,        setRenotificando]        = useState(false);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  // Ocupaciones solo de las reservas indicadas (o de las que hay en memoria). Antes traía
  // TODA la vista con select("*"), que además se truncaba en silencio a 1000 filas. Se
  // trocea el .in() para no reventar el largo de la URL. El KPI global de sobrecupo NO sale
  // de aquí (sería parcial) sino de resumen.sobrecupo (count server-side).
  const cargarOcupaciones = async (ids?: number[]) => {
    const objetivo = ids ?? reservas.map(r => r.id);
    const map: Record<number, Ocupacion> = {};
    for (let i = 0; i < objetivo.length; i += 300) {
      const chunk = objetivo.slice(i, i + 300);
      if (chunk.length === 0) continue;
      const { data } = await supabase.from("reservas_ocupacion").select("*").in("reserva_id", chunk);
      (data || []).forEach((o: any) => { map[o.reserva_id] = o; });
    }
    setOcupacionMap(map);
  };

  // Carga el numero_cotizacion (texto) de las cotizaciones referenciadas por las reservas.
  // Se acota a los cotizacion_id presentes (evita el cap de 1000 filas de la tabla completa)
  // y se trocea la consulta `.in()` para no reventar el largo de la URL.
  const cargarNumerosCotizacion = async (rows: Reserva[]) => {
    const cotIds = [...new Set(rows.map(r => r.cotizacion_id).filter((v): v is number => v != null))];
    if (cotIds.length === 0) { setCotMapNum({}); setCotMapAsunto({}); return; }
    const m: Record<number, string> = {};
    const ma: Record<number, string> = {};
    for (let i = 0; i < cotIds.length; i += 300) {
      const chunk = cotIds.slice(i, i + 300);
      const { data } = await supabase.from("cotizaciones").select("id,numero_cotizacion,asunto").in("id", chunk);
      (data || []).forEach((c: any) => {
        if (c.numero_cotizacion != null) m[c.id] = String(c.numero_cotizacion);
        if (c.asunto) ma[c.id] = String(c.asunto);
      });
    }
    setCotMapNum(m);
    setCotMapAsunto(ma);
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
          const gc = await geocodificar(par.nombre, par.id);
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
          const coords = await geocodificar(parada.nombre, parada.id);
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
              const coords = await geocodificar(parada.nombre, parada.id);
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
              const coords = await geocodificar(parada.nombre, parada.id);
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

    // Geocodificar en background paradas existentes sin coordenadas.
    // COSTO: el UPDATE iba SIN await, así que la coordenada no se guardaba nunca y las mismas
    // paradas se re-geocodificaban en cada expansión de fila, para siempre. Ahora va con await
    // (y el id real viaja al proxy, que además persiste del lado servidor).
    const sinCoords = paradasCargadas.filter((p: any) => !p.lat || !p.lng);
    if (sinCoords.length > 0) {
      for (const parada of sinCoords) {
        geocodificar(parada.nombre, parada.id).then(async coords => {
          if (!coords) return;
          const { error } = await supabase.from("paradas").update({ lat: coords.lat, lng: coords.lng }).eq("id", parada.id);
          if (error) console.error("[programacion] No se pudo guardar la coordenada de la parada " + parada.id + ":", error.message);
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

  // ── Edición de hora "solo este servicio" ──────────────────────────────────
  // Paso 1: al confirmar la hora inline, calcula el delta, carga las paradas para el
  // preview y abre el modal de advertencia. NO escribe nada todavía.
  const pedirCambioHora = async (r: Reserva, nuevaHHMM: string) => {
    const horaOriginal = r.hora_servicio?.slice(0, 5) || "";
    if (!nuevaHHMM || nuevaHHMM === horaOriginal) return;
    const deltaMin = horaOriginal ? minutosHHMM(nuevaHHMM) - minutosHHMM(horaOriginal) : 0;
    // Sin delta (p. ej. el servicio no tenía hora previa) no hay nada que correr en las paradas.
    const { data } = deltaMin === 0
      ? { data: [] as any[] }
      : await supabase.from("paradas").select("id,orden,nombre,hora_estimada").eq("reserva_id", r.id).order("orden");
    const paradas = (data || [])
      .filter((p: any) => p.hora_estimada)
      .map((p: any) => ({ id: p.id as number, nombre: p.nombre as string, de: (p.hora_estimada as string).slice(0, 5), a: correrHora(p.hora_estimada, deltaMin) }));
    setModalHora({ reserva: r, horaOriginal, horaNueva: nuevaHHMM, deltaMin, paradas });
  };

  // Paso 2: confirmar en el modal. Escribe SOLO esta reserva: su hora + corre las paradas.
  // Nunca toca los hermanos del contrato ni el retorno vinculado. Sin propagación masiva.
  const guardarHoraServicio = async () => {
    if (!modalHora) return;
    const { reserva, horaNueva, deltaMin, paradas } = modalHora;
    setGuardandoHora(true);
    const { error } = await supabase.from("reservas").update({ hora_servicio: horaNueva }).eq("id", reserva.id);
    if (error) { alert(error.message); setGuardandoHora(false); return; }
    if (deltaMin !== 0 && paradas.length > 0) {
      await Promise.all(paradas.map(p => supabase.from("paradas").update({ hora_estimada: p.a }).eq("id", p.id)));
      await recargarParadas(reserva.id);
    }
    setReservas(prev => prev.map(x => x.id === reserva.id ? { ...x, hora_servicio: horaNueva } : x));
    setGuardandoHora(false);
    setModalHora(null);
    // Si el servicio ya estaba sincronizado con la app del pasajero, el aviso quedó con la
    // hora vieja (el hash de sync no incluye la hora, así que nada lo detectaría solo).
    if (reserva.sincronizado_app) {
      setModalRenotificar({ reservaId: reserva.id, label: `${idAfa(reserva)} · ${nombreCliente(reserva.cliente_id)}` });
    }
  };

  // Re-enviar el aviso a los pasajeros con la nueva hora (reusa el endpoint de sincronizar,
  // que notifica y vuelve a marcar sincronizado_app = true).
  const renotificarPasajeros = async () => {
    if (!modalRenotificar) return;
    const { reservaId } = modalRenotificar;
    setRenotificando(true);
    try {
      const res = await fetch("/api/notificaciones/sincronizar", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reserva_id: reservaId }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "No se pudo re-notificar");
      setReservas(prev => prev.map(x => x.id === reservaId ? { ...x, sincronizado_app: true, fecha_sincronizacion: new Date().toISOString() } : x));
      alert(j.mensaje || "Pasajeros re-notificados con la nueva hora.");
    } catch (e: any) {
      alert(e.message);
    } finally {
      setRenotificando(false);
      setModalRenotificar(null);
    }
  };

  // "Ahora no": deja el badge honesto (sin sincronizar) para que no muestre la hora vieja
  // como buena. El usuario re-sincroniza cuando quiera desde el manifiesto.
  const descartarRenotificar = async () => {
    if (!modalRenotificar) return;
    const { reservaId } = modalRenotificar;
    await supabase.from("reservas").update({ sincronizado_app: false }).eq("id", reservaId);
    setReservas(prev => prev.map(x => x.id === reservaId ? { ...x, sincronizado_app: false } : x));
    setModalRenotificar(null);
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
          const coords = await geocodificar(parada.nombre, parada.id);
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

    // Asignar flota propia en bloque: normalizarAsignacion pone tipo='propia' y limpia
    // el lado tercerizado. Sin eso, un servicio que venía de un proveedor se quedaba con
    // su empresa y su costo pegados mientras lo operaba un bus de AFA — y la liquidación
    // al proveedor cobraba un servicio que nunca prestó.
    const asignBase = normalizarAsignacion({
      vehiculo_id: Number(asignarVehId),
      conductor_id: asignarCondId ? Number(asignarCondId) : null,
      tipo_asignacion: "propio",
      empresa_tercerizada_id: null, vehiculo_tercero_id: null, conductor_tercero_id: null,
    }, vehTercero);

    const cambio = { motivo: "correccion_carga", nota: "Asignación de flota propia en bloque" };
    const resP = await guardarReservas(supabase, pendienteIds, { ...asignBase, estado: "programada" }, cambio);
    const resO = await guardarReservas(supabase, otrosIds, asignBase, cambio);
    const rechazos = [...resP.rechazos, ...resO.rechazos];
    if (resP.aviso || resO.aviso) setMsgPacto(resP.aviso || resO.aviso || "");
    if (rechazos.length > 0) {
      alert(`${rechazos.length} servicio(s) no se pudieron asignar:\n` +
            rechazos.slice(0, 5).map(x => `#${x.id}: ${x.motivo}`).join("\n"));
      setAsignando(false); return;
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

  // Trae reservas paginando en PARALELO: la 1ª página pide el count exacto y con él se
  // lanzan el resto de páginas a la vez (antes eran 6 viajes en serie). `aplica` añade los
  // filtros (rango de fechas, cotización…). El orden fecha desc + id desc es determinista,
  // así el paginado no repite ni se salta filas.
  const fetchReservasCols = async (cols: string, aplica: (q: any) => any): Promise<any[]> => {
    // `colsUso` puede encogerse: ver COLS_OPCIONALES. Se reintenta la PRIMERA página
    // hasta que el select sea aceptable, y el resto ya se pide con esas columnas.
    let colsUso = cols;
    const base = (withCount: boolean) => aplica(
      supabase.from("reservas")
        .select(colsUso, withCount ? { count: "exact" } : undefined)
        .order("fecha_servicio", { ascending: false })
        .order("id", { ascending: false })
    );
    let first = await base(true).range(0, PAGE_SUPABASE - 1);
    for (let i = 0; first.error && i < COLS_OPCIONALES.length; i++) {
      const falta = columnaFaltante(String(first.error.message));
      if (!falta || !colsUso.split(",").some(c => c.trim() === falta)) break;
      colsUso = quitarColumna(colsUso, falta);
      first = await base(true).range(0, PAGE_SUPABASE - 1);
    }
    if (first.error || !first.data) return [];
    const all: any[] = [...first.data];
    if (first.count != null) {
      // Con el total conocido, el resto de páginas se piden A LA VEZ.
      const promesas: Promise<any>[] = [];
      for (let from = PAGE_SUPABASE; from < first.count; from += PAGE_SUPABASE) {
        promesas.push(base(false).range(from, from + PAGE_SUPABASE - 1));
      }
      if (promesas.length) {
        const res = await Promise.all(promesas);
        for (const r of res) if (r.data) all.push(...r.data);
      }
    } else {
      // Sin count (RLS raro): paginar en serie hasta una página corta. NUNCA quedarse en 1000
      // silenciosamente (ese fue un bug real de esta tabla).
      let from = PAGE_SUPABASE;
      while (all.length % PAGE_SUPABASE === 0) {
        const { data } = await base(false).range(from, from + PAGE_SUPABASE - 1);
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < PAGE_SUPABASE) break;
        from += PAGE_SUPABASE;
      }
    }
    return all;
  };

  // Ruta a mostrar: paradas cargadas al expandir > paradas de la lista > origen/destino guardados.
  const rutaDe = (r: any): { o: string; d: string } => {
    const ps = paradasMap[r.id];
    if (ps && ps.length > 0) return { o: ps[0].nombre, d: ps.length > 1 ? ps[ps.length - 1].nombre : (r.destino || "-") };
    const rm = rutaMap[r.id];
    if (rm) return { o: rm.o, d: rm.o !== rm.d ? rm.d : (r.destino || "-") };
    return { o: r.origen || "-", d: r.destino || "-" };
  };

  // Primera y última parada de cada reserva listada (columna Ruta). Solo nombre + orden:
  // es la fuente de verdad frente a reservas.origen/destino, que puede estar desfasado.
  const cargarRutas = async (ids: number[]) => {
    if (ids.length === 0) { setRutaMap({}); return; }
    const acc: Record<number, { o: string; d: string }> = {};
    for (let i = 0; i < ids.length; i += 300) {
      const { data } = await supabase.from("paradas")
        .select("reserva_id,orden,nombre").in("reserva_id", ids.slice(i, i + 300)).order("orden");
      for (const p of (data || []) as any[]) {
        const cur = acc[p.reserva_id];
        if (!cur) acc[p.reserva_id] = { o: p.nombre, d: p.nombre };
        else cur.d = p.nombre; // llegan ordenadas por `orden`: la última pisa el destino
      }
    }
    setRutaMap(acc);
  };

  // Trae reservas puntuales por id (para acciones sobre servicios que pueden estar fuera de
  // la ventana visible). Trocea el .in() por longitud de URL.
  const fetchReservasPorIds = async (ids: number[]): Promise<Reserva[]> => {
    if (ids.length === 0) return [];
    const out: any[] = [];
    for (let i = 0; i < ids.length; i += 300) {
      const trozo = ids.slice(i, i + 300);
      let colsUso = COLS_LISTA;
      let r = await supabase.from("reservas").select(colsUso).in("id", trozo);
      for (let j = 0; r.error && j < COLS_OPCIONALES.length; j++) {
        const falta = columnaFaltante(String(r.error.message));
        if (!falta) break;
        colsUso = quitarColumna(colsUso, falta);
        r = await supabase.from("reservas").select(colsUso).in("id", trozo);
      }
      if (r.data) out.push(...r.data);
    }
    return out as Reserva[];
  };

  // Rango de fechas que pide la LISTA al servidor. verTodo → sin límite (histórico completo).
  const rangoVentana = (): { desde: string | null; hasta: string | null } => {
    if (verTodo) return { desde: null, hasta: null };
    return {
      desde: filtroDesde || fechaLima(-VENTANA_DIAS_ATRAS),
      hasta: filtroHasta || fechaLima(VENTANA_DIAS_ADELANTE),
    };
  };

  // Rango para los KPIs financieros (Ventas/Costos/Margen): usa el mismo filtro Desde/Hasta
  // de la tabla; si no hay filtro activo, cae al mes en curso (no al histórico completo).
  const rangoFinanciero = (): { desde: string | null; hasta: string | null } => {
    if (verTodo) return { desde: null, hasta: null };
    if (filtroDesde || filtroHasta) return { desde: filtroDesde || null, hasta: filtroHasta || null };
    const hoyP = fechaLima();
    return { desde: hoyP.slice(0, 8) + "01", hasta: hoyP };
  };

  // Ventas/costos/margen del rango de `rangoFinanciero()`, excluyendo canceladas.
  const cargarResumenFinanciero = async () => {
    const { desde, hasta } = rangoFinanciero();
    const filas = await fetchReservasCols("precio_cliente,costo_proveedor,margen", (q: any) => {
      let qq = q.neq("estado", "cancelada");
      if (desde) qq = qq.gte("fecha_servicio", desde);
      if (hasta) qq = qq.lte("fecha_servicio", hasta);
      return qq;
    });
    let ventas = 0, costos = 0, margen = 0;
    for (const r of filas) {
      ventas += Number(r.precio_cliente || 0);
      costos += Number(r.costo_proveedor || 0);
      margen += Number(r.margen || 0);
    }
    setResumenFin({ ventas, costos, margen, desde, hasta });
  };

  // Catálogos (clientes, vehículos, conductores, terceros): no cambian al operar reservas,
  // se cargan una sola vez al montar.
  const cargarCatalogos = async () => {
    const [clRes, vRes, cRes, etRes, vtRes, ctRes, dtRes, otRes] = await Promise.all([
      supabase.from("clientes").select("id,nombre,empresa,tipo").order("nombre"),
      supabase.from("vehiculos").select("id,placa,categoria,estado,estado_operativo,capacidad_pasajeros").order("placa"),
      supabase.from("conductores").select("id,nombre,licencia,vencimiento_licencia,estado,telefono").order("nombre"),
      supabase.from("empresas_tercerizadas").select("id,razon_social,ruc,telefono,estado").order("razon_social"),
      supabase.from("vehiculos_tercero").select("id,empresa_id,placa,categoria,capacidad,estado,marca").order("placa"),
      supabase.from("conductores_tercero").select("id,empresa_id,nombre,licencia,vencimiento_licencia,telefono,estado").order("nombre"),
      supabase.from("documentos_tercero").select("id,empresa_id,tipo,fecha_vencimiento"),
      // Solo informativo (ver badge "🔧 OT pendiente" en los selects de vehículo):
      // NO se usa para filtrar ni bloquear ninguna asignación.
      supabase.from("ordenes_trabajo").select("vehiculo_id").in("estado", ["abierta", "en_proceso"]),
    ]);
    setClientes(clRes.data     || []);
    setVehiculos(vRes.data     || []);
    setConductores(cRes.data   || []);
    setEmpresasTer(etRes.data  || []);
    setVehTercero(vtRes.data   || []);
    setCondTercero(ctRes.data  || []);
    setDocsTercero(dtRes.data  || []);
    setOtPendientePorVeh(new Set((otRes.data || []).map((o: any) => o.vehiculo_id).filter((id: any) => id != null)));
  };

  // Totales del tablero (KPIs, flujo de estados, sumas): SIEMPRE globales, no dependen de la
  // ventana visible. Proyección ultraligera (sin paradas_json) sobre toda la tabla + el
  // conteo de sobrecupo por count server-side.
  const cargarResumen = async () => {
    const filas = await fetchReservasCols(COLS_RESUMEN, (q: any) => q);
    const hoyP = fechaLima();
    const e7   = fechaLima(7);
    const porEstado: Record<string, number> = {};
    const porAdmin:  Record<string, number> = {};
    let ventas = 0, costos = 0, margen = 0, hoy = 0, prox7d = 0, sincronizadas = 0;
    for (const r of filas) {
      porEstado[r.estado] = (porEstado[r.estado] || 0) + 1;
      if (r.estado_admin) porAdmin[r.estado_admin] = (porAdmin[r.estado_admin] || 0) + 1;
      ventas += Number(r.precio_cliente || 0);
      costos += Number(r.costo_proveedor || 0);
      margen += Number(r.margen || 0);
      if (r.fecha_servicio === hoyP) hoy++;
      if (r.fecha_servicio && r.fecha_servicio >= hoyP && r.fecha_servicio <= e7 && r.estado !== "cancelada" && r.estado !== "finalizada") prox7d++;
      if (r.sincronizado_app) sincronizadas++;
    }
    const { count } = await supabase.from("reservas_ocupacion")
      .select("reserva_id", { count: "exact", head: true }).eq("sobrecupo", true);
    setResumen({ total: filas.length, porEstado, porAdmin, hoy, prox7d, sincronizadas, ventas, costos, margen, sobrecupo: count || 0 });
  };

  // La lista visible: solo la ventana de fechas y solo columnas de lista (sin paradas_json).
  const cargarLista = async () => {
    setLoading(true);
    const { desde, hasta } = rangoVentana();
    const filas = await fetchReservasCols(COLS_LISTA, (q: any) => {
      let qq = q;
      if (desde) qq = qq.gte("fecha_servicio", desde);
      if (hasta) qq = qq.lte("fecha_servicio", hasta);
      return qq;
    });
    setReservas(filas);
    setLimiteVista(100);
    await cargarNumerosCotizacion(filas);
    await cargarOcupaciones(filas.map((r: any) => r.id));
    setLoading(false);
    cargarRutas(filas.map((r: any) => r.id));
  };

  // Refresco tras una mutación (guardar, eliminar, aplicar masivo…): lista + totales.
  const cargarDatos = async () => {
    await Promise.all([cargarLista(), cargarResumen(), cargarResumenFinanciero()]);
  };

  useEffect(() => { cargarCatalogos(); cargarResumen(); cargarResumenFinanciero(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Recarga la lista y los KPIs financieros cuando cambia la ventana (rango de fechas o "Ver
  // todo"). Debounce corto para no disparar dos veces al elegir Desde y Hasta seguidos.
  useEffect(() => {
    const t = setTimeout(() => { cargarLista(); cargarResumenFinanciero(); }, 300);
    return () => clearTimeout(t);
  }, [filtroDesde, filtroHasta, verTodo]); // eslint-disable-line react-hooks/exhaustive-deps

  // paradas_json NO viaja en la lista (es la columna más pesada). Se trae puntualmente al
  // abrir el manifiesto o expandir la fila y se fusiona en memoria. El check evita recargas:
  // una fila de la ventana llega sin la propiedad (undefined); tras hidratar queda array/null.
  const hidratarParadasJson = async (id: number) => {
    const actual = reservas.find(r => r.id === id);
    if (actual && (actual as any).paradas_json !== undefined) return;
    const { data } = await supabase.from("reservas").select("paradas_json").eq("id", id).maybeSingle();
    const pj = ((data as any)?.paradas_json ?? null) as any[] | null;
    setReservas(prev => prev.map(r => r.id === id ? { ...r, paradas_json: pj } : r));
  };

  // Abre el modal de manifiesto asegurando que paradas_json esté hidratado primero.
  const abrirManifiesto = async (id: number) => {
    await hidratarParadasJson(id);
    setModalReservaId(id);
  };

  // Al expandir una fila, hidrata su paradas_json para que el aviso "tiene N paradas en la
  // cotización" y el botón "Desde cotización" reaccionen igual que antes.
  useEffect(() => { if (expandidoId != null) hidratarParadasJson(expandidoId); }, [expandidoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Al cambiar cualquier filtro de cliente (búsqueda, estado, tipo…) se vuelve a mostrar
  // desde las primeras 100 filas, para que "Cargar más" no arrastre el conteo anterior.
  useEffect(() => { setLimiteVista(100); }, [busqueda, filtroEstado, filtroTipo, filtroServicio, filtroSentido, filtroOrigen, filtroPorAsignar]);

  const nombreCliente    = (id: number | null) => { const c = clientes.find(c => c.id === id); return c ? (c.empresa || c.nombre) : "Sin cliente"; };
  const nombreVehiculo   = (id: number | null) => vehiculos.find(v => v.id === id)?.placa || "-";
  const nombreConductor  = (id: number | null) => conductores.find(c => c.id === id)?.nombre || "-";
  const nombreEmpTer     = (id: number | null) => empresasTer.find(e => e.id === id)?.razon_social || "-";
  const nombreVehTercero = (id: number | null) => vehTercero.find(v => v.id === id)?.placa || "-";

  const vehiculosAptos         = vehiculos.filter(v => v.estado === "disponible" && (v.estado_operativo === "apto" || !v.estado_operativo));
  const conductoresDisponibles = conductores.filter(c => c.estado !== "no_disponible" && (!c.vencimiento_licencia || new Date(c.vencimiento_licencia) >= new Date()));
  // Solo alerta visual — NO saca al vehículo de `vehiculosAptos` ni impide asignarlo:
  // el mantenimiento se puede coordinar en un horario fuera del servicio.
  const tieneOtPendiente = (id: number | string | null) => id != null && otPendientePorVeh.has(Number(id));

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
      precio_cliente:         r.precio_cliente            ? String(r.precio_cliente)            : "",
      // El motivo es de CADA cambio: se arranca en blanco para que no quede pegado el
      // de la edición anterior y termine sustentando algo que no ocurrió.
      cambio_motivo: "", cambio_nota: "",
    });
    setCostoSug(null);
    setEditandoId(r.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  // ── Autocompletado del costo ──────────────────────────────────────────────
  // Es lo ÚNICO del Pacto que le AHORRA trabajo al operador, y por eso es lo que hace
  // que la regla se cumpla: hoy ese número vive en la cabeza de una persona y se teclea
  // de memoria (o no se teclea). Al elegir empresa, se propone lo último realmente
  // pactado con ella en esa ruta. No pisa un importe ya escrito.
  useEffect(() => {
    const emp = Number(form.empresa_tercerizada_id) || null;
    if (form.tipo_asignacion !== "tercerizado" || !emp) { setCostoSug(null); return; }
    let vivo = true;
    (async () => {
      const r = reservas.find(x => x.id === editandoId);
      const s = await sugerirCosto(supabase, emp, r?.ruta_nombre ?? null,
        form.vehiculo_tercero_id ? Number(form.vehiculo_tercero_id) : null);
      if (!vivo) return;
      setCostoSug(s);
      // Se rellena solo si el campo está vacío: nunca se pisa lo que el operador escribió.
      if (s && !form.costo_proveedor) setForm(p => ({ ...p, costo_proveedor: String(s.costo) }));
    })();
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.empresa_tercerizada_id, form.vehiculo_tercero_id, form.tipo_asignacion, editandoId]);

  /** Sugerencia de motivo según lo que se está moviendo. Un clic, no un párrafo. */
  const motivoSugerido = useMemo(() => {
    const r = reservas.find(x => x.id === editandoId);
    if (!r) return null;
    const empCambio = String(r.empresa_tercerizada_id ?? "") !== String(form.empresa_tercerizada_id ?? "");
    if (empCambio && r.empresa_tercerizada_id) return "proveedor_sin_unidad";
    const capAntes = vehTercero.find(v => v.id === r.vehiculo_tercero_id)?.capacidad ?? null;
    const capAhora = vehTercero.find(v => v.id === Number(form.vehiculo_tercero_id))?.capacidad ?? null;
    if (capAntes != null && capAhora != null && capAhora > capAntes) return "cliente_unidad_mayor";
    if (capAntes != null && capAhora != null && capAhora < capAntes) return "cliente_unidad_menor";
    return null;
  }, [form.empresa_tercerizada_id, form.vehiculo_tercero_id, editandoId, reservas, vehTercero]);

  /** Margen en vivo, normalizado por afectación: sin eso se equivoca hasta en 30 %. */
  const margenVivo = useMemo(() => {
    const r = reservas.find(x => x.id === editandoId);
    const emp: any = empresasTer.find(e => e.id === Number(form.empresa_tercerizada_id));
    const precio = form.precio_cliente !== "" ? form.precio_cliente : (r?.precio_cliente ?? 0);
    const antes = margenEnVivo(r?.precio_cliente ?? 0, r?.costo_proveedor ?? 0, {
      compraAfectacion: (r as any)?.compra_afectacion, emiteFactura: emp?.emite_factura !== false,
    });
    const ahora = margenEnVivo(precio, form.costo_proveedor, {
      compraAfectacion: emp?.afectacion_defecto, emiteFactura: emp?.emite_factura !== false,
    });
    return { antes, ahora, afectacion: (emp?.afectacion_defecto ?? "10") as CodigoAfectacion };
  }, [form.precio_cliente, form.costo_proveedor, form.empresa_tercerizada_id, editandoId, reservas, empresasTer]);

  /**
   * El OTRO tramo del día del servicio que se está editando.
   *
   * Sin él, los avisos mienten: AFA cobra UNA tarifa por la ida y el retorno, así que el
   * tramo que no la lleva va en S/ 0.00 a propósito. Juzgando la reserva aislada, todo
   * retorno disparaba "sin costo pactado" — un rojo permanente y falso que invitaba a
   * "arreglarlo" cargando el importe dos veces, que es cobrar el día dos veces.
   *
   * Se busca primero en lo ya cargado; si el filtro de la pantalla lo dejó fuera, se
   * pide esa sola fila.
   */
  /** El id del otro tramo del servicio en edición. */
  const hermanoId = useMemo(() => {
    const r = reservas.find((x) => x.id === editandoId);
    return (r as any)?.reserva_vinculada_id ?? null;
  }, [editandoId, reservas]);

  /** Si ya está en la tabla cargada, se DERIVA: no hace falta estado ni una consulta. */
  const hermanoLocal = useMemo<TramoHermano>(() => {
    if (!hermanoId) return null;
    const l = reservas.find((x) => x.id === Number(hermanoId));
    return l
      ? {
          id: l.id, codigo: idAfa(l), direccion_servicio: (l as any).direccion_servicio,
          estado: l.estado, precio_cliente: l.precio_cliente, costo_proveedor: l.costo_proveedor,
        }
      : null;
  }, [hermanoId, reservas]);

  /** Solo cuando el filtro de la pantalla lo dejó fuera se pide esa única fila. */
  const [hermanoRemoto, setHermanoRemoto] = useState<TramoHermano>(null);
  useEffect(() => {
    if (!hermanoId || hermanoLocal) return;
    let vivo = true;
    supabase.from("reservas")
      .select("id,codigo,direccion_servicio,estado,precio_cliente,costo_proveedor,fecha_servicio")
      .eq("id", hermanoId).maybeSingle()
      .then(({ data }: any) => { if (vivo) setHermanoRemoto(data ?? null); });
    return () => { vivo = false; };
  }, [hermanoId, hermanoLocal]);

  // El id se compara al derivar: así, al saltar de un servicio a otro, nunca se muestra
  // por un instante el hermano del anterior.
  const hermano: TramoHermano =
    hermanoLocal ?? (hermanoRemoto && Number(hermanoRemoto.id) === Number(hermanoId) ? hermanoRemoto : null);

  const porIdReserva = useMemo(() => new Map(reservas.map((r) => [r.id, r])), [reservas]);

  /**
   * El estado ECONÓMICO del día, no del tramo. Devuelve null cuando está todo bien: un
   * chip en cada fila sería el mismo ruido permanente que este cambio viene a quitar, y
   * un aviso que sale siempre se aprende a no leer.
   */
  function problemaDelDia(r: Reserva): { texto: string; tono: string } | null {
    const parId = (r as any).reserva_vinculada_id;
    const par = parId ? porIdReserva.get(Number(parId)) : null;
    if (!par) return null;
    const cMio = Number(r.costo_proveedor || 0), cPar = Number(par.costo_proveedor || 0);
    const pMio = Number(r.precio_cliente || 0), pPar = Number(par.precio_cliente || 0);
    const esTer = r.tipo === "tercerizada";
    if ((esTer && cMio > 0 && cPar > 0) || (pMio > 0 && pPar > 0))
      return { texto: "DÍA 2×", tono: "background:#fee2e2;color:#b91c1c" };
    if (pMio <= 0 && pPar <= 0)
      return { texto: "DÍA SIN PRECIO", tono: "background:#fef3c7;color:#92400e" };
    if (esTer && cMio <= 0 && cPar <= 0)
      return { texto: "DÍA SIN COSTO", tono: "background:#fef3c7;color:#92400e" };
    return null;
  }

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

    // CANDADO DEL DOBLE COBRO. La tarifa del día cubre la ida y el retorno, así que el
    // importe va en UN solo tramo. Si se pone en los dos, la liquidación los lee como dos
    // servicios independientes y el día se cobra —o se paga al proveedor— dos veces. Eso
    // es plata real, así que aquí sí se pregunta en lugar de dejarlo pasar.
    const costoHermano = Number(hermano?.costo_proveedor ?? 0);
    const precioHermano = Number(hermano?.precio_cliente ?? 0);
    const dobles: string[] = [];
    if (form.tipo_asignacion === "tercerizado" && Number(form.costo_proveedor) > 0 && costoHermano > 0)
      dobles.push(`costo: ${fmtSoles(Number(form.costo_proveedor))} aquí + ${fmtSoles(costoHermano)} en ${hermano?.codigo ?? "el otro tramo"}`);
    if (Number(form.precio_cliente) > 0 && precioHermano > 0)
      dobles.push(`precio: ${fmtSoles(Number(form.precio_cliente))} aquí + ${fmtSoles(precioHermano)} en ${hermano?.codigo ?? "el otro tramo"}`);
    if (dobles.length) {
      const ok = confirm(
        "OJO: los DOS tramos del día van a quedar con importe.\n\n" +
        dobles.map((d) => "  · " + d).join("\n") +
        "\n\nLa tarifa cubre ida y retorno, así que el cierre lo va a liquidar como DOS " +
        "servicios y el día se cobrará dos veces.\n\n" +
        "Solo continúa si de verdad son dos cobros distintos.\n\n¿Guardar así?"
      );
      if (!ok) return;
    }

    // El campo dice "Costo S/ *" con asterisco desde siempre, pero nada lo exigía:
    // guardar con el campo vacío escribía 0 en silencio y el problema aparecía 30 días
    // después, en el bloque rojo de /liquidaciones. Ahora se avisa aquí. NO se bloquea:
    // a las 5 a.m. el bus tiene que salir igual, y una regla que impide despachar se
    // esquiva el primer día. Lo que se gobierna es la plata, no la operación.
    //
    // Y NO se pregunta cuando el otro tramo ya lleva el costo del día: ese 0 es correcto.
    // Preguntarlo en cada retorno era un rojo permanente y falso, del que se aprende a
    // hacer clic sin leer — y así el aviso deja de servir cuando el problema es real.
    if (form.tipo_asignacion === "tercerizado" && !(Number(form.costo_proveedor) > 0) && costoHermano <= 0) {
      const ok = confirm(
        (hermano
          ? "Ni este tramo ni el otro del mismo día tienen COSTO PACTADO.\n\n"
          : "Este servicio tercerizado se va a guardar SIN COSTO PACTADO.\n\n") +
        "Finanzas no podrá liquidarlo al cierre del mes y va a quedar en la bandeja de " +
        "pendientes hasta que alguien lo cargue.\n\n¿Guardar así de todos modos?"
      );
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

    // normalizarAsignacion aplica las mismas reglas de coherencia que el trigger de
    // nacimiento (derivar la empresa del vehículo de tercero, limpiar el lado que no
    // corresponde), para que el operador vea el resultado antes de guardar.
    const asignPayload = normalizarAsignacion({
      hora_servicio:          form.hora_servicio,
      tipo_asignacion:        form.tipo_asignacion,
      vehiculo_id:            form.tipo_asignacion === "propio" ? Number(form.vehiculo_id) : null,
      conductor_id:           form.tipo_asignacion === "propio" ? Number(form.conductor_id) : null,
      empresa_tercerizada_id: form.tipo_asignacion === "tercerizado" ? Number(form.empresa_tercerizada_id) : null,
      vehiculo_tercero_id:    form.tipo_asignacion === "tercerizado" && form.vehiculo_tercero_id ? Number(form.vehiculo_tercero_id) : null,
      conductor_tercero_id:   form.tipo_asignacion === "tercerizado" && form.conductor_tercero_id ? Number(form.conductor_tercero_id) : null,
      costo_proveedor:        costo,
    }, vehTercero);

    // Puente A→B: si el servicio pasa a "finalizada" y aún no tiene estado administrativo,
    // arranca en "por_liquidar".
    const adminPayload = (nuevoEstado === "finalizada" && !reservaActual?.estado_admin)
      ? { estado_admin: ESTADO_ADMIN_INICIAL }
      : {};
    // El precio de venta solo se manda si el operador lo tocó: mandarlo siempre haría
    // que cada guardado escribiera un acta de venta idéntica y llenaría la línea de
    // tiempo del servicio de ruido.
    const precioTocado = form.precio_cliente !== ""
      && Number(form.precio_cliente) !== Number(reservaActual?.precio_cliente ?? 0);

    const res = await guardarReservas(supabase, [editandoId], {
      ...asignPayload,
      ...adminPayload,
      ...(precioTocado ? { precio_cliente: Number(form.precio_cliente) } : {}),
      fecha_servicio:  form.fecha_servicio,
      hora_servicio:   form.hora_servicio,
      estado:          nuevoEstado,
      observaciones:   form.observaciones.trim() || null,
    }, { motivo: form.cambio_motivo || null, nota: form.cambio_nota.trim() || null });

    if (!res.ok) { alert(describirResultado(res)); setGuardando(false); return; }
    if (res.aviso) setMsgPacto(res.aviso);

    // ── Si es servicio FIJO con contrato, ofrecer aplicar a otros días ──
    if (reservaActual && !esEventual(reservaActual) && reservaActual.cotizacion_id) {
      const horaOriginal = reservaActual.hora_servicio?.slice(0, 5) || "";
      // Candidatos = lo que queda por operar del contrato. El recorte fino (misma hora,
      // misma unidad) lo decide el usuario en el modal: antes se filtraba aquí y los
      // servicios ya asignados a OTRA unidad quedaban fuera para siempre, así que era
      // imposible reasignar el conductor en bloque sin reasignar también la unidad.
      // Nunca entran los servicios ya operados (fecha pasada, aunque nadie los haya
      // marcado "finalizada") ni el que está en ruta ahora mismo: cambiarles la unidad
      // reescribiría el historial o le cambiaría el bus al conductor a media carretera.
      const hoyPeru = fechaLima();
      // Todos los servicios del contrato desde el servidor: los "Programa fijo" se extienden
      // meses adelante, fuera de la ventana visible. Sin esto, "aplicar a rango" solo
      // alcanzaría lo que estuviera cargado en pantalla.
      const delContrato = await fetchReservasCols(COLS_LISTA, (q: any) => q.eq("cotizacion_id", reservaActual.cotizacion_id!));
      const otrasReservas = (delContrato as Reserva[]).filter(r =>
        r.id !== editandoId &&
        r.estado !== "cancelada" && r.estado !== "finalizada" && r.estado !== "en_curso" &&
        (r.fecha_servicio || "") >= hoyPeru
      );
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
        setAplicarCampos("todo");
        setAplicarOtraHora(false);
        setAplicarOtraUnidad(false);
        setModalAplicarMasivo({ cotizacion_id: reservaActual.cotizacion_id, payload: asignPayload, otrasReservas, horaOriginal, resumen });
        cargarDatos();
        return;
      }
    }

    limpiar(); cargarDatos(); setGuardando(false);
  };

  // Un servicio "conserva su unidad" si aplicarle la asignación completa no le cambia
  // ninguna unidad que YA tenía: los campos vacíos se completan, pero los que tienen valor
  // no se pisan. Se comparan los tres campos de unidad a la vez, no solo el del tipo del
  // payload: un servicio tercerizado tiene vehiculo_id = null (miraríamos el campo
  // equivocado y lo daríamos por "libre") pero su empresa_tercerizada_id sí está puesta, y
  // una asignación propia se la borraría junto con su unidad, su conductor y su costo.
  const conservaUnidad = (r: Reserva, payload: Record<string, any>) => {
    const pisa = (actual: number | null, nuevo: any) =>
      actual !== null && actual !== undefined && actual !== (nuevo ?? null);
    return !pisa(r.vehiculo_id,            payload.vehiculo_id)
        && !pisa(r.empresa_tercerizada_id, payload.empresa_tercerizada_id)
        && !pisa(r.vehiculo_tercero_id,    payload.vehiculo_tercero_id);
  };

  // Los servicios que recibirán la asignación, según los filtros elegidos en el modal.
  // Misma lógica en el render (contador) y en el update, para que el número que se ve
  // sea exactamente el que se escribe.
  const targetsAplicar = (m: NonNullable<typeof modalAplicarMasivo>) => {
    const soloConductor = aplicarCampos === "conductor";
    return m.otrasReservas.filter(r => {
      if (!aplicarOtraHora && (r.hora_servicio?.slice(0, 5) || "") !== m.horaOriginal) return false;
      if (soloConductor) {
        // No se toca la unidad, así que da igual qué placa tenga; pero no mezclamos
        // conductor propio con servicios tercerizados (y viceversa)...
        if (r.tipo_asignacion && r.tipo_asignacion !== m.payload.tipo_asignacion) return false;
        // ...ni mandamos el conductor de una empresa proveedora a cubrir los servicios
        // de otra empresa.
        if (m.payload.tipo_asignacion === "tercerizado" &&
            r.empresa_tercerizada_id !== m.payload.empresa_tercerizada_id) return false;
      } else if (!aplicarOtraUnidad && !conservaUnidad(r, m.payload)) return false;
      if (aplicarScope === "rango") {
        if (!r.fecha_servicio) return false;
        if (aplicarDesde && r.fecha_servicio < aplicarDesde) return false;
        if (aplicarHasta && r.fecha_servicio > aplicarHasta) return false;
      }
      return true;
    });
  };

  const aplicarMasivo = async () => {
    if (!modalAplicarMasivo) return;
    const { payload, horaOriginal } = modalAplicarMasivo;
    const targets = targetsAplicar(modalAplicarMasivo);
    if (targets.length === 0) { alert("No hay servicios que cumplan esos filtros"); return; }

    setAplicando(true);
    const soloConductor = aplicarCampos === "conductor";

    // "Solo el conductor": no se escribe vehículo, empresa, tipo ni hora — cada servicio
    // conserva su unidad y su horario.
    const base: Record<string, any> = soloConductor
      ? (payload.tipo_asignacion === "propio"
          ? { conductor_id: payload.conductor_id }
          : { conductor_tercero_id: payload.conductor_tercero_id })
      : payload;

    const propioCompleto      = payload.tipo_asignacion === "propio" && !!payload.vehiculo_id && !!payload.conductor_id;
    const tercerizadoCompleto = payload.tipo_asignacion === "tercerizado" && !!payload.empresa_tercerizada_id && !!payload.vehiculo_tercero_id && !!payload.conductor_tercero_id;
    const estadoPendientes: EstadoReserva = (propioCompleto || tercerizadoCompleto) ? "confirmada" : "programada";

    // Se agrupan los targets por el patch exacto que reciben y se manda un update por lote.
    const lotes = new Map<string, { patch: Record<string, any>; ids: number[] }>();
    for (const r of targets) {
      const patch: Record<string, any> = { ...base };
      // A los servicios de OTRA hora (el retorno) no se les toca ni el horario ni el costo:
      // la hora los reescribiría con la de la ida, y la ida y el retorno se le pagan distinto
      // al proveedor. La hora sí se propaga entre los de la misma hora, que es como se cambia
      // el horario de todo el contrato.
      if (!soloConductor && (r.hora_servicio?.slice(0, 5) || "") !== horaOriginal) {
        delete patch.hora_servicio;
        delete patch.costo_proveedor;
      }
      // Un pendiente que queda completamente asignado se confirma. En "solo conductor" no:
      // el servicio puede seguir sin unidad.
      if (!soloConductor && r.estado === "pendiente") patch.estado = estadoPendientes;
      const key = JSON.stringify(patch);
      const lote = lotes.get(key) || { patch, ids: [] };
      lote.ids.push(r.id);
      lotes.set(key, lote);
    }

    // Por el helper, igual que el guardado individual: si un lote falla, se reintenta
    // fila por fila y se dice CUÁL falló. Antes, un `.in("id", [50 ids])` que reventaba
    // solo decía "error al actualizar 1 lote" y el operador tenía que adivinar entre 50.
    const results = await Promise.all(
      [...lotes.values()].map(l =>
        guardarReservas(supabase, l.ids, l.patch,
          { motivo: form.cambio_motivo || null, nota: form.cambio_nota.trim() || null }))
    );
    const rechazos = results.flatMap(r => r.rechazos);
    const aviso = results.find(r => r.aviso)?.aviso;
    if (aviso) setMsgPacto(aviso);
    if (rechazos.length > 0)
      alert(`${rechazos.length} servicio(s) no se pudieron actualizar:\n` +
            rechazos.slice(0, 5).map(x => `#${x.id}: ${x.motivo}`).join("\n"));

    setModalAplicarMasivo(null);
    setAplicando(false);
    cargarDatos();
  };

  // ── Selección múltiple ───────────────────────────────────────────────────
  const toggleSel = (id: number) => {
    setSeleccionados(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const seleccionarTodosFiltrados = () => setSeleccionados(new Set(filtradas.map(r => r.id)));
  const limpiarSeleccion = () => setSeleccionados(new Set());

  // ── Borrado (individual y en grupo) ──────────────────────────────────────
  // Limpia las tablas dependientes antes de borrar la(s) reserva(s), en vez de
  // dejarlas huérfanas (comportamiento anterior). Sin RPC transaccional (no hay
  // ninguna en este repo hoy): best-effort secuencial, se acumulan errores y se
  // avisan en vez de fallar en silencio.
  const eliminarReservasEnLote = async (ids: number[]) => {
    if (ids.length === 0) return;
    setEliminandoLote(true);
    const CHUNK = 100;
    const errores: string[] = [];

    const borrarPor = async (tabla: string, columna: string, valores: any[]) => {
      for (let i = 0; i < valores.length; i += CHUNK) {
        const { error } = await supabase.from(tabla).delete().in(columna, valores.slice(i, i + CHUNK));
        if (error) errores.push(`${tabla}: ${error.message}`);
      }
    };

    // 1. paradas (necesitamos sus ids primero para limpiar pasajeros_parada, que cuelga de parada_id)
    const paradaIds: number[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await supabase.from("paradas").select("id").in("reserva_id", ids.slice(i, i + CHUNK));
      if (error) errores.push(`paradas (lectura): ${error.message}`);
      paradaIds.push(...(data || []).map((p: any) => p.id));
    }
    if (paradaIds.length > 0) await borrarPor("pasajeros_parada", "parada_id", paradaIds);
    await borrarPor("paradas", "reserva_id", ids);

    // 2. resto de tablas dependientes
    await borrarPor("pasajeros", "reserva_id", ids);
    await borrarPor("gastos", "reserva_id", ids);
    await borrarPor("notificaciones_enviadas", "reserva_id", ids);
    await borrarPor("boarding_log", "reserva_id", ids);
    await borrarPor("ubicaciones_gps", "reserva_id", ids);
    await borrarPor("mensajes_pasajero", "reserva_id", ids);
    await borrarPor("grupo_aplicado_reserva", "reserva_id", ids);
    await borrarPor("push_eventos_viaje", "reserva_id", ids);
    await borrarPor("push_eval_estado", "reserva_id", ids);

    // 3. no dejar reserva_vinculada_id colgante en la pareja IDA/RETORNO que no se borró
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { error } = await supabase.from("reservas").update({ reserva_vinculada_id: null }).in("reserva_vinculada_id", ids.slice(i, i + CHUNK));
      if (error) errores.push(`reserva_vinculada_id: ${error.message}`);
    }

    // 4. las reservas mismas
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { error } = await supabase.from("reservas").delete().in("id", ids.slice(i, i + CHUNK));
      if (error) errores.push(`reservas: ${error.message}`);
    }

    setEliminandoLote(false);
    if (errores.length > 0) alert(`Hubo errores al eliminar:\n${errores.join("\n")}`);

    setConfirmEliminarId(null);
    setConfirmLote(null);
    setTextoConfirmLote("");
    setSeleccionados(new Set());
    cargarDatos();
  };

  // ── Reclasificar el ORIGEN de servicios ya creados ───────────────────────
  //
  // Antes de que existiera el botón "Adicional", TODO nacía como contrato, incluidos
  // los servicios que el cliente pidió por encima de lo pactado. Quién sabe cuáles son
  // es el operador; el sistema no puede adivinarlo y no lo intenta.
  //
  // Dos reglas que hacen esto seguro:
  //
  //   1. ARRASTRA AL HERMANO. La unidad que se cobra es el DÍA (ida + retorno = una
  //      tarifa). Marcar un solo tramo dejaría medio servicio en cada categoría, y
  //      v_adicionales mostraría un retorno suelto sin su ida.
  //   2. NO INVENTA `precio_cotizado`. De un servicio de agosto no se sabe cuál era la
  //      tarifa de referencia ENTONCES; leerla hoy de la cotización daría una
  //      comparación falsa si el contrato se renegoció. Se queda en null, que dice la
  //      verdad: "se marcó después, sin referencia registrada".
  //
  // Y no dispara nada: el WHEN de trg_reservas_pacto_acta solo cubre costo, precio,
  // proveedor y vehículo, así que reclasificar no levanta actas ni enlaces de
  // conformidad. Por eso el motivo vive en `adicional_motivo` y no en `cambio_motivo`.
  const prepararCambioOrigen = async (destino: "adicional" | "contrato", idsBase?: number[]) => {
    // Los ids se pasan EXPLÍCITOS desde el botón de una fila. Apoyarse en
    // `seleccionados` ahí no funciona: setSeleccionados no ha llegado todavía cuando
    // esta función corre, y el modal se abriría con la selección anterior.
    const base = idsBase ?? Array.from(seleccionados);
    if (base.length === 0) return;
    setOrigenMotivo(""); setOrigenNota("");
    setModalOrigen({ destino, ids: base, todos: base, liquidadas: [], cargando: true });

    // Hermanos por las DOS direcciones del vínculo: si solo se marcó el retorno y su
    // ida no lo referencia de vuelta, mirar un solo lado se dejaría la mitad.
    const ids = new Set(base);
    const CHUNK = 200;
    for (let i = 0; i < base.length; i += CHUNK) {
      const trozo = base.slice(i, i + CHUNK);
      const [ida, vuelta] = await Promise.all([
        supabase.from("reservas").select("reserva_vinculada_id").in("id", trozo),
        supabase.from("reservas").select("id").in("reserva_vinculada_id", trozo),
      ]);
      for (const r of (ida.data ?? [])) if (r.reserva_vinculada_id) ids.add(Number(r.reserva_vinculada_id));
      for (const r of (vuelta.data ?? [])) ids.add(Number(r.id));
    }
    const todos = Array.from(ids);

    // Qué documentos ya emitidos contienen alguno de estos servicios. No bloquea: el
    // papel que el cliente firmó no cambia, y hay que decirlo antes, no después.
    const conteo = new Map<number, number>();
    for (let i = 0; i < todos.length; i += CHUNK) {
      const { data } = await supabase.from("reservas")
        .select("liquidacion_cliente_id").in("id", todos.slice(i, i + CHUNK))
        .not("liquidacion_cliente_id", "is", null);
      for (const r of (data ?? [])) {
        const k = Number(r.liquidacion_cliente_id);
        conteo.set(k, (conteo.get(k) ?? 0) + 1);
      }
    }
    let liquidadas: { id: number; codigo: string | null; estado: string; cuantas: number }[] = [];
    if (conteo.size) {
      const { data } = await supabase.from("liquidacion_cliente")
        .select("id,codigo,estado").in("id", [...conteo.keys()]);
      liquidadas = (data ?? []).map((l: { id: number; codigo: string | null; estado: string }) => ({
        id: Number(l.id), codigo: l.codigo ?? null, estado: String(l.estado),
        cuantas: conteo.get(Number(l.id)) ?? 0,
      }));
    }
    setModalOrigen(prev => prev ? { ...prev, todos, liquidadas, cargando: false } : prev);
  };

  const aplicarCambioOrigen = async () => {
    if (!modalOrigen || modalOrigen.cargando) return;
    const esAdic = modalOrigen.destino === "adicional";
    setAplicandoOrigen(true);

    // Volver a 'contrato' limpia el motivo y la nota: describían un adicional que ya
    // no existe, y dejarlos pegados haría que el próximo reporte contara una historia
    // que la fila ya no sostiene.
    const campos = {
      origen_contractual: modalOrigen.destino,
      adicional_motivo: esAdic ? (origenMotivo || null) : null,
      adicional_nota:   esAdic ? (origenNota.trim() || null) : null,
    };

    let hechos = 0;
    let error = "";
    for (let i = 0; i < modalOrigen.todos.length; i += 200) {
      const trozo = modalOrigen.todos.slice(i, i + 200);
      const r = await supabase.from("reservas").update(campos).in("id", trozo).select("id");
      if (r.error) { error = r.error.message; break; }
      hechos += (r.data ?? []).length;
    }

    setAplicandoOrigen(false);
    if (error) {
      alert(
        /origen_contractual|adicional_motivo|adicional_nota/i.test(error)
          ? "Falta correr supabase/reservas-04-servicios-adicionales.sql en Supabase: la base todavía no tiene la columna de origen."
          : "No se pudo cambiar el origen: " + error
      );
      return;
    }
    setModalOrigen(null);
    limpiarSeleccion();
    setFiltroOrigen(esAdic ? "adicional" : "todos");
    await cargarDatos();
    alert(`${hechos} servicio(s) quedaron como ${esAdic ? "ADICIONAL" : "CONTRATO"}.`);
  };

  // Prepara el modal de borrado en grupo: expande la pareja IDA/RETORNO vinculada
  // no seleccionada, y separa las reservas facturadas/cobradas (no se eliminan solas).
  const prepararEliminacionLote = async (idsBase: number[]) => {
    if (idsBase.length === 0) return;

    // Las reservas involucradas pueden estar FUERA de la ventana visible (p. ej. "Deshacer"
    // un Programa fijo generado a futuro). Se traen del servidor para no saltarlas.
    const filasBase = await fetchReservasPorIds(idsBase);
    const baseSet = new Set(idsBase);
    const idsSet  = new Set(idsBase);
    let incluidosVinculados = 0;
    filasBase.forEach(r => {
      if (r.reserva_vinculada_id && !idsSet.has(r.reserva_vinculada_id)) {
        idsSet.add(r.reserva_vinculada_id);
        incluidosVinculados++;
      }
    });
    const idsFinal = Array.from(idsSet);
    // Trae las vinculadas nuevas (las de idsBase ya están en filasBase) y arma el índice.
    const filasVinc = await fetchReservasPorIds(idsFinal.filter(id => !baseSet.has(id)));
    const mapFinal  = new Map<number, Reserva>([...filasBase, ...filasVinc].map(r => [r.id, r]));

    const idsConFactura = new Set<number>();
    const CHUNK = 150;
    for (let i = 0; i < idsFinal.length; i += CHUNK) {
      const { data } = await supabase.from("facturas").select("reserva_id").in("reserva_id", idsFinal.slice(i, i + CHUNK));
      (data || []).forEach((f: any) => { if (f.reserva_id) idsConFactura.add(f.reserva_id); });
    }

    const bloqueados: Reserva[] = [];
    const aEliminar: Reserva[] = [];
    idsFinal.forEach(id => {
      const r = mapFinal.get(id);
      if (!r) return;
      const bloqueado = r.estado_admin === "facturada" || r.estado_admin === "cobrada" || idsConFactura.has(id);
      (bloqueado ? bloqueados : aEliminar).push(r);
    });

    if (aEliminar.length === 0) {
      alert("Todas las reservas seleccionadas están facturadas/cobradas — ábrelas individualmente si de verdad quieres eliminarlas.");
      return;
    }

    setTextoConfirmLote("");
    setConfirmLote({ aEliminar, bloqueados, incluidosVinculados });
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
    cargarResumen(); // los KPIs/flujo de estados salen del resumen global: refrescarlo
    cargarResumenFinanciero(); // el cambio de estado (p.ej. a cancelada) puede afectar Ventas/Costos/Margen
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
    cargarResumen();
  };

  // Avanza el estado administrativo (dimensión B): por_liquidar → liquidada → facturada → cobrada
  const avanzarAdmin = async (r: Reserva) => {
    const actual = (r.estado_admin || ESTADO_ADMIN_INICIAL) as EstadoAdmin;
    const sig = siguienteAdmin(actual);
    if (!sig) return;
    if (!confirm(`Avanzar estado administrativo de "${ESTADOS_ADMIN[actual].label}" a "${ESTADOS_ADMIN[sig].label}"?`)) return;
    await supabase.from("reservas").update({ estado_admin: sig }).eq("id", r.id);
    setReservas(prev => prev.map(x => x.id === r.id ? { ...x, estado_admin: sig } : x));
    cargarResumen();
  };

  const capacidadDe = (r: Reserva): number | null => {
    if (r.tipo === "tercerizada") return vehTercero.find(v => v.id === r.vehiculo_tercero_id)?.capacidad ?? null;
    return vehiculos.find(v => v.id === r.vehiculo_id)?.capacidad_pasajeros ?? null;
  };

  const hoy          = fechaLima();
  const en7d         = fechaLima(7);
  // KPIs y flujo de estados: SIEMPRE globales (del resumen server-side), no de la ventana
  // visible. Si `resumen` existe se usa su valor (0 cuando el estado no aparece, NO el
  // fallback); mientras carga se cae a lo que haya en memoria para no mostrar vacíos.
  const gEstado = (e: EstadoReserva) => resumen ? (resumen.porEstado[e] || 0) : reservas.filter(r => r.estado === e).length;
  const gAdmin  = (e: EstadoAdmin)   => resumen ? (resumen.porAdmin[e]  || 0) : reservas.filter(r => r.estado_admin === e).length;
  const totalRes     = resumen ? resumen.total : reservas.length;
  const pendientes   = gEstado("pendiente");
  const programadas  = gEstado("programada");
  const confirmadas  = gEstado("confirmada");
  const enCurso      = gEstado("en_curso");
  // Dimensión B · cierre administrativo (solo servicios finalizados tienen estado_admin)
  const porLiquidar  = gAdmin("por_liquidar");
  const liquidadas   = gAdmin("liquidada");
  const facturadas   = gAdmin("facturada");
  const cobradas     = gAdmin("cobrada");
  const hoyCount     = resumen ? resumen.hoy    : reservas.filter(r => r.fecha_servicio === hoy).length;
  const ventas       = resumenFin ? resumenFin.ventas : 0;
  const costos       = resumenFin ? resumenFin.costos : 0;
  const margenTotal  = resumenFin ? resumenFin.margen : 0;
  const conSobrecupo = resumen ? resumen.sobrecupo : Object.values(ocupacionMap).filter(o => o.sobrecupo).length;
  const sincronizadas = resumen ? resumen.sincronizadas : reservas.filter(r => r.sincronizado_app).length;
  const proximos7d    = resumen ? resumen.prox7d : reservas.filter(r => r.fecha_servicio && r.fecha_servicio >= hoy && r.fecha_servicio <= en7d && r.estado !== "cancelada" && r.estado !== "finalizada").length;

  const filtradas = useMemo(() => {
    const base = reservas.filter(r => {
      const q     = busqueda.toLowerCase();
      const numCot = r.cotizacion_id != null ? (cotMapNum[r.cotizacion_id] || String(r.cotizacion_id).padStart(5, "0")) : "";
      // El CÓDIGO va primero y es el que faltaba: la columna ID muestra "OS-2026-006532"
      // y el operador nombra los servicios así, pero la búsqueda solo miraba `r.id`
      // (la llave interna, que no se enseña en ninguna parte). Buscar el folio que
      // acabas de leer en pantalla no devolvía nada. Igual con `ruta_nombre`: el
      // recuadro dice "cliente, ruta o ID" y la ruta que se pinta es esa, no
      // origen/destino.
      const txt = (
        (r.codigo || "") + " " + r.id + " " + numCot + " " + nombreCliente(r.cliente_id) + " " +
        (r.ruta_nombre || "") + " " + ((r as any).origen || "") + " " + ((r as any).destino || "")
      ).toLowerCase();
      const passServicio    = filtroServicio === "todos" || (filtroServicio === "fijo" ? !esEventual(r) : esEventual(r));
      const passSentido     = filtroSentido === "todos" || sentidoServicio(r) === filtroSentido;
      const passOrigen      = filtroOrigen === "todos"
        || (filtroOrigen === "adicional" ? esAdicional(r) : !esAdicional(r));
      const passPorAsignar  = !filtroPorAsignar || (r.estado === "pendiente" && !r.vehiculo_id && !r.empresa_tercerizada_id);
      return txt.includes(q) &&
        passOrigen &&
        (filtroEstado === "todos" || r.estado === filtroEstado) &&
        (filtroTipo === "todos" || r.tipo === filtroTipo) &&
        passServicio &&
        passSentido &&
        (!filtroDesde || (r.fecha_servicio && r.fecha_servicio >= filtroDesde)) &&
        (!filtroHasta || (r.fecha_servicio && r.fecha_servicio <= filtroHasta)) &&
        passPorAsignar;
    });
    // Próximos primero: futuros ascendentes, luego pasados descendentes (más reciente primero)
    // Desempate por hora_servicio: mismo día → la hora más próxima arriba
    return [...base].sort((a, b) => {
      const fa = a.fecha_servicio;
      const fb = b.fecha_servicio;
      if (!fa && !fb) return 0;
      if (!fa) return 1;
      if (!fb) return -1;
      const aFut = fa >= hoy;
      const bFut = fb >= hoy;
      if (aFut && bFut) {
        const d = fa.localeCompare(fb);
        if (d !== 0) return d;
        return (a.hora_servicio || "").localeCompare(b.hora_servicio || "");
      }
      if (!aFut && !bFut) {
        const d = fb.localeCompare(fa);
        if (d !== 0) return d;
        return (b.hora_servicio || "").localeCompare(a.hora_servicio || "");
      }
      return aFut ? -1 : 1;
    });
  }, [reservas, busqueda, filtroEstado, filtroTipo, filtroServicio, filtroSentido, filtroOrigen, cotMapNum, filtroDesde, filtroHasta, filtroPorAsignar, clientes, hoy]);

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
      const sorted = [...filas].sort((a, b) => {
        const d = (a.fecha_servicio || "").localeCompare(b.fecha_servicio || "");
        if (d !== 0) return d;
        return (a.hora_servicio || "").localeCompare(b.hora_servicio || "");
      });
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

      {modoPrograma && (
        <ModalGenerarPrograma
          clientes={clientes}
          modo={modoPrograma}
          onClose={() => setModoPrograma(null)}
          onGenerado={({ lote, cantidad }) => {
            const adicional = modoPrograma === "adicional";
            cargarDatos();
            setFiltroServicio("fijo");
            // Un adicional nace entre cientos de servicios de contrato del mismo
            // cliente y la misma ruta: sin este filtro habría que ir a buscarlo.
            if (adicional) setFiltroOrigen("adicional");
            setUltimoLote({ lote, cantidad });
          }}
        />
      )}

      {/* MODAL · reclasificar el origen de servicios ya creados */}
      {modalOrigen && (() => {
        const esAdic = modalOrigen.destino === "adicional";
        const arrastrados = modalOrigen.todos.length - modalOrigen.ids.length;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg flex flex-col" style={{ maxHeight: "calc(100vh - 32px)" }}>
              <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: "#e2e8f0" }}>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white shrink-0"
                       style={{ background: esAdic ? "#b45309" : "#0b315f" }}>
                    <Sparkles size={18} />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-gray-900">
                      {esAdic ? "Marcar como ADICIONAL" : "Devolver a CONTRATO"}
                    </h2>
                    <p className="text-xs text-gray-400">Corrige el origen de servicios ya creados</p>
                  </div>
                </div>
                <button onClick={() => setModalOrigen(null)} className="p-2 rounded-xl hover:bg-gray-100">
                  <X size={18} className="text-gray-500" />
                </button>
              </div>

              <div className="p-6 space-y-4 overflow-y-auto flex-1">
                {modalOrigen.cargando ? (
                  <p className="text-sm text-gray-400">Revisando los servicios…</p>
                ) : (
                  <>
                    <div className="rounded-xl px-4 py-3 text-sm" style={{ background: esAdic ? "#fffbeb" : "#eef3f8", color: esAdic ? "#854d0e" : "#0b315f" }}>
                      <b>{modalOrigen.todos.length} servicio(s)</b> pasarán a{" "}
                      <b>{esAdic ? "ADICIONAL" : "CONTRATO"}</b>.
                      {arrastrados > 0 && (
                        <p className="mt-1.5 text-[12px] leading-snug">
                          Marcaste {modalOrigen.ids.length} y se suman {arrastrados} por el tramo
                          hermano: <b>lo que se cobra es el día completo</b> (ida + retorno = una
                          tarifa), así que los dos tramos tienen que quedar del mismo lado.
                        </p>
                      )}
                    </div>

                    {modalOrigen.liquidadas.length > 0 && (
                      <div className="rounded-xl px-4 py-3 text-[12px] leading-snug" style={{ background: "#fef9c3", color: "#854d0e" }}>
                        <p className="font-bold mb-1">Ojo: hay servicios que ya están liquidados</p>
                        {modalOrigen.liquidadas.map(l => (
                          <p key={l.id}>· {l.codigo ?? "#" + l.id} ({l.estado}) — {l.cuantas} servicio(s)</p>
                        ))}
                        <p className="mt-1.5">
                          El documento ya emitido <b>no cambia</b>: es una foto de lo que el cliente
                          recibió. Esto corrige el registro operativo, para que los reportes y los
                          próximos cierres digan la verdad. Si alguna está en <b>borrador</b>, ábrela
                          y usa <b>↻ Recalcular descripciones</b> para que la línea se rearme.
                        </p>
                      </div>
                    )}

                    {esAdic && (
                      <>
                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                            Motivo (opcional)
                          </label>
                          <select className="w-full border rounded-xl px-3 py-2.5 text-sm" value={origenMotivo} onChange={e => setOrigenMotivo(e.target.value)}>
                            <option value="">Sin motivo declarado</option>
                            {MOTIVOS_CAMBIO.filter(m => m.lado !== "compra").map(m => (
                              <option key={m.clave} value={m.clave}>{m.nombre}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                            Nota (opcional)
                          </label>
                          <input className="w-full border rounded-xl px-3 py-2.5 text-sm" value={origenNota}
                                 onChange={e => setOrigenNota(e.target.value)}
                                 placeholder="Ej. Salidas extra pedidas por correo en agosto" />
                          <p className="text-[10px] text-gray-400 mt-1 leading-snug">
                            Se escribe en los {modalOrigen.todos.length} servicios. El
                            <b> precio de referencia se deja vacío</b> a propósito: de un servicio
                            pasado no se sabe cuál era la tarifa de entonces, y leerla hoy de la
                            cotización daría una comparación falsa si el contrato se renegoció.
                          </p>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>

              <div className="flex gap-3 px-6 py-4 border-t shrink-0" style={{ borderColor: "#e2e8f0" }}>
                <button onClick={aplicarCambioOrigen} disabled={modalOrigen.cargando || aplicandoOrigen}
                        className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-40"
                        style={{ background: esAdic ? "#b45309" : "#0b315f" }}>
                  {aplicandoOrigen ? "Aplicando…" : `Cambiar ${modalOrigen.todos.length} servicio(s)`}
                </button>
                <button onClick={() => setModalOrigen(null)} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Banner "Deshacer generación" tras usar Programa fijo */}
      {ultimoLote && (
        <div className="flex items-center gap-3 px-5 py-3 rounded-2xl border" style={{ background: "#f0fdf4", borderColor: "#bbf7d0" }}>
          <span className="text-sm" style={{ color: "#166534" }}>
            Se crearon <b>{ultimoLote.cantidad}</b> servicio{ultimoLote.cantidad !== 1 ? "s" : ""}.
          </span>
          <button
            onClick={async () => {
              const lote = ultimoLote.lote;
              const { data } = await supabase.from("reservas").select("id").eq("lote_generacion", lote);
              const ids = (data || []).map((r: any) => r.id);
              setUltimoLote(null);
              await prepararEliminacionLote(ids);
            }}
            className="text-xs font-bold px-3 py-1.5 rounded-lg border bg-white hover:bg-gray-50 transition-colors"
            style={{ borderColor: "#bbf7d0", color: "#166534" }}
          >
            Deshacer
          </button>
          <button onClick={() => setUltimoLote(null)} className="ml-auto text-gray-400 hover:text-gray-600 transition-colors">
            <X size={16} />
          </button>
        </div>
      )}

      {/* MODAL APLICAR ASIGNACIÓN MASIVA A SERVICIOS FIJOS */}
      {modalAplicarMasivo && (() => {
        const { otrasReservas, resumen, cotizacion_id, payload, horaOriginal } = modalAplicarMasivo;
        const targets = targetsAplicar(modalAplicarMasivo);
        const soloConductor = aplicarCampos === "conductor";

        // El calendario se abre a TODO el contrato: limitarlo a las fechas de los
        // candidatos ya filtrados hacía que se vieran casi todos los días bloqueados.
        const fechas = otrasReservas.map(r => r.fecha_servicio).filter(Boolean).sort() as string[];
        const minF = fechas[0] || "";
        const maxF = fechas[fechas.length - 1] || "";

        // Los conteos de los avisos se calculan sobre el rango de fechas ya elegido: si no,
        // el modal ofrecería incluir servicios que el rango deja fuera de todos modos.
        const enRango = (r: Reserva) => aplicarScope !== "rango" || (
          !!r.fecha_servicio &&
          (!aplicarDesde || r.fecha_servicio >= aplicarDesde) &&
          (!aplicarHasta || r.fecha_servicio <= aplicarHasta)
        );
        const candidatos = otrasReservas.filter(enRango);
        const otraHora   = candidatos.filter(r => (r.hora_servicio?.slice(0, 5) || "") !== horaOriginal);
        const enHora     = aplicarOtraHora ? candidatos : candidatos.filter(r => (r.hora_servicio?.slice(0, 5) || "") === horaOriginal);
        const otraUnidad = enHora.filter(r => !conservaUnidad(r, payload));
        const hayConductor = payload.tipo_asignacion === "propio" ? !!payload.conductor_id : !!payload.conductor_tercero_id;
        // Si se cambió la hora del servicio editado, el masivo la propaga a los de su mismo
        // horario original: hay que decirlo, no es lo que el operador cree estar aplicando.
        const horaNueva  = payload.hora_servicio?.slice(0, 5) || "";
        const cambiaHora = !soloConductor && !!horaNueva && horaNueva !== horaOriginal;

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div className="px-6 py-4 flex items-center gap-3 rounded-t-2xl" style={{ background: "#0b315f" }}>
                <div className="w-9 h-9 rounded-xl bg-white/20 flex items-center justify-center text-lg">📋</div>
                <div>
                  <p className="font-black text-white text-base">¿Aplicar a más servicios del contrato?</p>
                  <p className="text-white/60 text-xs">Contrato #{cotizacion_id} · {otrasReservas.length} servicio(s) activo(s)</p>
                </div>
              </div>

              <div className="px-6 py-5 space-y-4">
                {/* Resumen asignación */}
                <div className="rounded-xl px-4 py-3 text-sm" style={{ background: "#f0fdf4", border: "1px solid #86efac" }}>
                  <p className="text-[10px] font-black uppercase tracking-wide text-green-600 mb-0.5">Asignación guardada</p>
                  <p className="font-bold text-green-800">{resumen || "—"}</p>
                </div>

                {/* Qué campos aplicar */}
                {hayConductor && (
                  <div className="space-y-2">
                    <p className="text-[11px] font-black uppercase tracking-widest text-gray-400">¿Qué aplicar?</p>
                    <div className="grid grid-cols-2 gap-2">
                      <label className={`p-3 rounded-xl cursor-pointer border-2 transition-all ${!soloConductor ? "border-[#0b315f] bg-blue-50" : "border-gray-200"}`}>
                        <div className="flex items-center gap-2">
                          <input type="radio" name="campos" checked={!soloConductor} onChange={() => setAplicarCampos("todo")} className="accent-[#0b315f]" />
                          <p className="font-bold text-sm text-gray-800">{payload.tipo_asignacion === "propio" ? "Vehículo y conductor" : "Empresa y unidad"}</p>
                        </div>
                        <p className="text-[11px] text-gray-500 mt-1 ml-6">Reemplaza la asignación completa.</p>
                      </label>
                      <label className={`p-3 rounded-xl cursor-pointer border-2 transition-all ${soloConductor ? "border-[#0b315f] bg-blue-50" : "border-gray-200"}`}>
                        <div className="flex items-center gap-2">
                          <input type="radio" name="campos" checked={soloConductor} onChange={() => setAplicarCampos("conductor")} className="accent-[#0b315f]" />
                          <p className="font-bold text-sm text-gray-800">Solo el conductor</p>
                        </div>
                        <p className="text-[11px] text-gray-500 mt-1 ml-6">Cada servicio conserva su unidad.</p>
                      </label>
                    </div>
                  </div>
                )}

                {/* Opciones */}
                <div className="space-y-2">
                  <p className="text-[11px] font-black uppercase tracking-widest text-gray-400">¿A cuántos servicios aplicar?</p>

                  <label className={`flex items-start gap-3 p-3 rounded-xl cursor-pointer border-2 transition-all ${aplicarScope === "todos" ? "border-[#0b315f] bg-blue-50" : "border-gray-200"}`}>
                    <input type="radio" name="scope" checked={aplicarScope === "todos"} onChange={() => setAplicarScope("todos")} className="mt-0.5 accent-[#0b315f]" />
                    <div>
                      <p className="font-bold text-sm text-gray-800">Todo el contrato</p>
                      <p className="text-xs text-gray-500">{minF ? fmtFecha(minF) : "—"} al {maxF ? fmtFecha(maxF) : "—"}</p>
                    </div>
                  </label>

                  <label className={`flex items-start gap-3 p-3 rounded-xl cursor-pointer border-2 transition-all ${aplicarScope === "rango" ? "border-[#0b315f] bg-blue-50" : "border-gray-200"}`}>
                    <input type="radio" name="scope" checked={aplicarScope === "rango"} onChange={() => { setAplicarScope("rango"); setAplicarDesde(minF); setAplicarHasta(maxF); }} className="mt-0.5 accent-[#0b315f]" />
                    <div className="flex-1">
                      <p className="font-bold text-sm text-gray-800">Rango de fechas</p>
                      <p className="text-xs text-gray-500 mb-2">Del {minF ? fmtFecha(minF) : "—"} al {maxF ? fmtFecha(maxF) : "—"} (todo el contrato)</p>
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

                {/* Qué se incluye / qué se está dejando fuera */}
                {(otraHora.length > 0 || otraUnidad.length > 0 || soloConductor) && (
                  <div className="space-y-1.5 rounded-xl border border-gray-200 px-4 py-3">
                    <p className="text-[11px] font-black uppercase tracking-widest text-gray-400">Incluir también</p>

                    {otraHora.length > 0 && (
                      <label className="flex items-start gap-2.5 cursor-pointer">
                        <input type="checkbox" checked={aplicarOtraHora} onChange={e => setAplicarOtraHora(e.target.checked)} className="mt-0.5 accent-[#0b315f]" />
                        <span className="text-xs text-gray-700">
                          Los servicios de <b>otro horario</b> (ida y retorno) — {otraHora.length} servicio(s).
                          <span className="text-gray-400"> Por defecto solo se aplica a los de las {horaOriginal || "—"}.</span>
                        </span>
                      </label>
                    )}

                    {!soloConductor && otraUnidad.length > 0 && (
                      <label className="flex items-start gap-2.5 cursor-pointer">
                        <input type="checkbox" checked={aplicarOtraUnidad} onChange={e => setAplicarOtraUnidad(e.target.checked)} className="mt-0.5 accent-[#0b315f]" />
                        <span className="text-xs text-gray-700">
                          Los servicios que ya tienen <b>otra unidad</b> asignada — {otraUnidad.length} servicio(s).
                          <span className="font-bold" style={{ color: "#b45309" }}> Se les sobrescribirá la unidad.</span>
                        </span>
                      </label>
                    )}

                    {soloConductor && (
                      <p className="text-xs text-gray-500">
                        Se cambia solo el conductor: la <b>unidad y el horario</b> de cada servicio quedan intactos.
                      </p>
                    )}
                  </div>
                )}

                {/* Aviso: la hora también se propaga */}
                {cambiaHora && (
                  <div className="rounded-xl px-4 py-2.5 text-xs flex items-start gap-2" style={{ background: "#fffbeb", border: "1px solid #fcd34d", color: "#92400e" }}>
                    <span>⏰</span>
                    <span>
                      Cambiaste la hora de <b>{horaOriginal}</b> a <b>{horaNueva}</b>: también se aplicará
                      a los servicios que salían a las {horaOriginal}.
                    </span>
                  </div>
                )}

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
                  <h3 className="text-lg font-bold text-gray-800">Links de servicio {idAfa(r)}</h3>
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
                            {tieneOtPendiente(v.id) ? "🔧 " : ""}{v.placa} — {v.categoria || "Sin categoría"}{v.capacidad_pasajeros ? ` · ${v.capacidad_pasajeros} pax` : ""}
                          </option>
                        ))}
                      </select>
                      {asignarVehId && tieneOtPendiente(asignarVehId) && (
                        <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                          🔧 Esta unidad tiene una orden de trabajo de mantenimiento pendiente. Puedes asignarla igual;
                          revisa Mantenimiento → Órdenes de Trabajo.
                        </div>
                      )}
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
                  <b className="text-gray-800">{idAfa(r)} · {nombreCliente(r.cliente_id)}</b><br />
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
                  onClick={() => eliminarReservasEnLote([confirmEliminarId])}
                  disabled={eliminandoLote}
                  className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white bg-red-600 hover:bg-red-700 transition-colors disabled:opacity-50"
                >
                  {eliminandoLote ? "Eliminando..." : "Sí, eliminar"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmLote && (() => {
        const { aEliminar, bloqueados, incluidosVinculados } = confirmLote;
        const cierraSiNoActivo = () => { if (!eliminandoLote) setConfirmLote(null); };
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={cierraSiNoActivo}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
              <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
                <Trash2 size={22} className="text-red-600" />
              </div>
              <h3 className="text-lg font-bold text-gray-900 text-center mb-1">
                ¿Eliminar {aEliminar.length} servicio{aEliminar.length !== 1 ? "s" : ""}?
              </h3>

              <div className="max-h-32 overflow-y-auto mt-2 mb-3 text-xs text-gray-500 text-center">
                {aEliminar.slice(0, 8).map(r => (
                  <div key={r.id}>{idAfa(r)} · {nombreCliente(r.cliente_id)} · {fmtFecha(r.fecha_servicio)}</div>
                ))}
                {aEliminar.length > 8 && <div className="font-bold mt-1">y {aEliminar.length - 8} más…</div>}
              </div>

              {incluidosVinculados > 0 && (
                <p className="text-xs text-center mb-2 px-3 py-2 rounded-lg" style={{ background: "#eef3f8", color: "#0b315f" }}>
                  Se incluyeron {incluidosVinculados} viaje{incluidosVinculados !== 1 ? "s" : ""} de ida/retorno vinculado{incluidosVinculados !== 1 ? "s" : ""} automáticamente.
                </p>
              )}

              {bloqueados.length > 0 && (
                <div className="text-xs text-center mb-2 px-3 py-2 rounded-lg" style={{ background: "#fef9c3", color: "#854d0e" }}>
                  <p className="font-bold">{bloqueados.length} quedaron fuera por estar facturados/cobrados:</p>
                  <p className="mt-1">Ábrelos individualmente si de verdad quieres eliminarlos.</p>
                  <p className="mt-1 opacity-80">{bloqueados.slice(0, 5).map(r => idAfa(r)).join(", ")}{bloqueados.length > 5 ? "…" : ""}</p>
                </div>
              )}

              <p className="text-xs text-red-600 text-center mb-3 font-medium">Esta acción no se puede deshacer.</p>

              <label className="block text-xs text-gray-500 text-center mb-2">
                Escribe <b>{aEliminar.length}</b> para confirmar
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={textoConfirmLote}
                onChange={e => setTextoConfirmLote(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-center mb-4 focus:outline-none focus:ring-2 focus:ring-red-200 focus:border-red-400"
                placeholder={String(aEliminar.length)}
              />

              <div className="flex gap-3">
                <button
                  onClick={cierraSiNoActivo}
                  className="flex-1 py-2.5 rounded-xl font-bold text-sm border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={() => eliminarReservasEnLote(aEliminar.map(r => r.id))}
                  disabled={eliminandoLote || textoConfirmLote !== String(aEliminar.length)}
                  className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white bg-red-600 hover:bg-red-700 transition-colors disabled:opacity-40"
                >
                  {eliminandoLote ? "Eliminando..." : `Eliminar ${aEliminar.length}`}
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

      {/* Advertencia al cambiar la hora de UN servicio (corre también sus paradas) */}
      {modalHora && (() => {
        const m = modalHora;
        const sube = m.deltaMin > 0;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !guardandoHora && setModalHora(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="px-6 py-4 text-white" style={{ background: "#0b315f" }}>
                <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-widest opacity-80">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
                  Cambiar hora · solo este servicio
                </div>
                <p className="mt-1 text-sm font-bold">{idAfa(m.reserva)} · {nombreCliente(m.reserva.cliente_id)}</p>
                <p className="text-xs opacity-80">{fmtFecha(m.reserva.fecha_servicio)}</p>
              </div>
              <div className="px-6 py-5">
                <div className="flex items-center justify-center gap-3 mb-1">
                  <span className="text-2xl font-black text-gray-300 line-through">{m.horaOriginal || "--:--"}</span>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0b315f" strokeWidth="2.5"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                  <span className="text-2xl font-black" style={{ color: "#0b315f" }}>{m.horaNueva}</span>
                </div>
                {m.deltaMin !== 0 && (
                  <p className="text-center text-xs font-bold mb-4" style={{ color: sube ? "#b45309" : "#0369a1" }}>
                    {etiquetaDelta(m.deltaMin)}
                  </p>
                )}
                {m.paradas.length > 0 ? (
                  <>
                    <p className="text-[11px] font-bold text-gray-500 mb-2">
                      Se recalcularán las {m.paradas.length} parada{m.paradas.length !== 1 ? "s" : ""} del recorrido ({etiquetaDelta(m.deltaMin)}):
                    </p>
                    <div className="rounded-xl border max-h-44 overflow-y-auto divide-y" style={{ borderColor: "#e2e8f0" }}>
                      {m.paradas.map((p, i) => (
                        <div key={p.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                          <span className="w-5 h-5 rounded-full bg-gray-100 text-gray-500 flex items-center justify-center text-[10px] font-black flex-shrink-0">{i + 1}</span>
                          <span className="flex-1 min-w-0 truncate text-gray-700">{p.nombre}</span>
                          <span className="text-gray-300 line-through font-mono">{p.de}</span>
                          <span className="text-gray-300">→</span>
                          <span className="font-mono font-bold" style={{ color: "#0b315f" }}>{p.a}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-[11px] text-gray-400 mb-1">Este servicio no tiene paradas con hora que recalcular.</p>
                )}
                <div className="mt-4 text-[11px] px-3 py-2 rounded-lg flex items-start gap-2" style={{ background: "#eef3f8", color: "#0b315f" }}>
                  <span>⚠</span>
                  <span>Solo cambia <b>este</b> servicio. No se tocan los demás servicios del contrato ni el viaje de retorno.</span>
                </div>
              </div>
              <div className="px-6 pb-6 flex gap-3">
                <button onClick={() => setModalHora(null)} disabled={guardandoHora}
                  className="flex-1 py-2.5 rounded-xl font-bold text-sm border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                  Cancelar
                </button>
                <button onClick={guardarHoraServicio} disabled={guardandoHora}
                  className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50" style={{ background: "#0b315f" }}>
                  {guardandoHora ? "Guardando..." : "Confirmar cambio"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Tras cambiar la hora de un servicio ya sincronizado: ofrecer re-notificar */}
      {modalRenotificar && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !renotificando && setModalRenotificar(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
            <div className="w-12 h-12 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-4">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#b45309" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            </div>
            <h3 className="text-lg font-bold text-gray-900 text-center mb-1">¿Re-notificar a los pasajeros?</h3>
            <p className="text-sm text-gray-500 text-center mb-1"><b className="text-gray-800">{modalRenotificar.label}</b></p>
            <p className="text-xs text-gray-500 text-center mb-5">Este servicio ya estaba sincronizado: los pasajeros fueron avisados con la hora anterior. ¿Enviar el aviso otra vez con la nueva hora?</p>
            <div className="flex gap-3">
              <button onClick={descartarRenotificar} disabled={renotificando}
                className="flex-1 py-2.5 rounded-xl font-bold text-sm border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                Ahora no
              </button>
              <button onClick={renotificarPasajeros} disabled={renotificando}
                className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50" style={{ background: "#b45309" }}>
                {renotificando ? "Enviando..." : "Sí, re-notificar"}
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
          vehiculoTerceroId={(reservaModal as any).vehiculo_tercero_id ?? null}
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
            onClick={() => setModoPrograma("fijo")}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm text-white transition-colors hover:opacity-90"
            style={{ background: "#0b315f" }}
          >
            <Calendar size={15} /> Programa fijo
          </button>
          {/* El adicional se registra desde el MISMO sitio y con el mismo modal: se
              elige la cotización que ya tiene los paraderos, y lo único que cambia es
              que las fechas son sueltas, el sentido se elige y el precio se puede
              escribir. Antes había que generarlo como programa fijo y corregir el
              precio servicio por servicio. */}
          <button
            onClick={() => setModoPrograma("adicional")}
            title="Servicio que el cliente pide por encima de lo contratado, con su propio precio"
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl font-bold text-sm text-white transition-colors hover:opacity-90"
            style={{ background: "#b45309" }}
          >
            <Sparkles size={15} /> Adicional
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
            const count = gEstado(est);
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
        <div className="md:col-span-3 -mb-1 text-[11px] font-bold text-gray-400">
          Periodo: {resumenFin?.desde ? fmtFecha(resumenFin.desde) : "inicio"} – {resumenFin?.hasta ? fmtFecha(resumenFin.hasta) : "hoy"}
          {!(filtroDesde || filtroHasta || verTodo) && " (mes en curso)"}
          {verTodo && " (todo el histórico)"}
          {" · excluye canceladas"}
        </div>
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
              <h2 className="text-lg font-bold text-gray-900">Programar reserva {(() => { const re = reservas.find(rr => rr.id === editandoId); return re ? idAfa(re) : (editandoId ? `#${editandoId}` : ""); })()}</h2>
              <p className="text-xs text-gray-400">
                {(() => { const r = reservas.find(r => r.id === editandoId); return r ? ((r as any).origen || "") + " -> " + ((r as any).destino || "") + " · " + fmtSoles(Number(r.precio_cliente || 0)) : ""; })()}
              </p>
            </div>
          </div>

          {msgPacto && (
            <div className="rounded-xl px-4 py-3 text-xs bg-amber-50 border border-amber-200 text-amber-800 flex items-start gap-3">
              <span className="flex-1">{msgPacto}</span>
              <button onClick={() => setMsgPacto("")} className="text-amber-500 hover:text-amber-700">×</button>
            </div>
          )}

          {/* Lo que ya está pactado, leído del propio servicio: el operador ve con quién
              y en cuánto se quedó antes de tocar nada. */}
          {(() => {
            const r = reservas.find(x => x.id === editandoId);
            if (!r || !(Number(r.costo_proveedor) > 0)) return null;
            return (
              <p className="text-[11px] text-gray-500">
                Pactado hoy: <b className="text-gray-700">{nombreEmpTer(r.empresa_tercerizada_id)}</b>
                {" · "}<b className="text-gray-700">{fmtSoles(Number(r.costo_proveedor))}</b>
              </p>
            );
          })()}

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
                      <option key={v.id} value={v.id}>
                        {tieneOtPendiente(v.id) ? "🔧 " : ""}{v.placa} · {v.categoria}{v.capacidad_pasajeros ? " · " + v.capacidad_pasajeros + " pax" : ""}
                      </option>
                    ))}
                  </select>
                  {form.vehiculo_id && tieneOtPendiente(form.vehiculo_id) && (
                    <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                      🔧 Esta unidad tiene una orden de trabajo de mantenimiento pendiente. Puedes asignarla igual
                      (coordínalo en un horario fuera del servicio) — revisa <b>Mantenimiento → Órdenes de Trabajo</b>.
                    </div>
                  )}
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
                  <Campo label="Costo del proveedor S/ *">
                    <input type="number" min="0" className={inputCls()} placeholder="0.00" value={form.costo_proveedor} onChange={f("costo_proveedor")} />
                    {costoSug && (
                      <button type="button"
                        onClick={() => setForm(p => ({ ...p, costo_proveedor: String(costoSug.costo) }))}
                        className="text-[10px] mt-1 text-violet-700 hover:underline text-left">
                        Último con este proveedor en {costoSug.base}: {fmtSoles(costoSug.costo)} · hace {costoSug.dias} día(s)
                      </button>
                    )}
                    {!afectacionDe(margenVivo.afectacion).grava && Number(form.costo_proveedor) > 0 && (
                      <p className="text-[10px] mt-1 text-amber-700">
                        {afectacionDe(margenVivo.afectacion).etiqueta}: sin IGV que recuperar, cuesta los {fmtSoles(Number(form.costo_proveedor))} completos.
                      </p>
                    )}
                  </Campo>
                </div>

                {/* ── Precio de venta ─────────────────────────────────────────
                    Este campo NO existía en ninguna pantalla del ERP: una vez creado
                    el servicio, su precio era inmodificable (los únicos updates de
                    precio_cliente del repo son sobre la tabla `cotizaciones`). Por eso
                    "el cliente pidió una unidad mayor" era irrepresentable: se cambiaba
                    el bus y el servicio se seguía vendiendo al precio del bus anterior. */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Campo label="Precio al cliente S/">
                    <input type="number" min="0" className={inputCls()} placeholder="0.00"
                      value={form.precio_cliente} onChange={f("precio_cliente")} />
                    <p className="text-[10px] mt-1 text-gray-400">
                      Súbelo cuando el cliente pida una unidad mayor. Se le pedirá conformidad.
                    </p>
                  </Campo>

                  {/* Panel de margen en vivo: es lo que le ENSEÑA al operador por qué le
                      conviene cobrar el diferencial. Es la primera vez que el ERP se lo
                      muestra en el momento de decidir. */}
                  <div className="md:col-span-2">
                    <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wide mb-1">Margen</p>
                    <div className="rounded-xl border bg-gray-50 px-4 py-3 flex flex-wrap items-center gap-4">
                      <div>
                        <span className="block text-[10px] uppercase text-gray-400">Antes</span>
                        <span className="font-black text-gray-600 tabular-nums">
                          {margenVivo.antes.pct != null ? `${margenVivo.antes.pct.toFixed(1)}%` : "—"}
                        </span>
                        <span className="block text-[10px] text-gray-400 tabular-nums">
                          {fmtSoles(margenVivo.antes.ingreso)} / {fmtSoles(margenVivo.antes.costo)}
                        </span>
                      </div>
                      <span className="text-gray-300 text-lg">→</span>
                      <div>
                        <span className="block text-[10px] uppercase text-gray-400">Después</span>
                        <span className="font-black tabular-nums" style={{
                          color: margenVivo.ahora.pct == null ? "#6b7280"
                               : margenVivo.ahora.pct < 0 ? "#dc2626"
                               : margenVivo.ahora.pct < (margenVivo.antes.pct ?? 0) ? "#b45309" : "#166534",
                        }}>
                          {margenVivo.ahora.pct != null ? `${margenVivo.ahora.pct.toFixed(1)}%` : "—"}
                        </span>
                        <span className="block text-[10px] text-gray-400 tabular-nums">
                          {fmtSoles(margenVivo.ahora.ingreso)} / {fmtSoles(margenVivo.ahora.costo)}
                        </span>
                      </div>
                      <p className="text-[10px] text-gray-400 flex-1 min-w-[180px]">
                        Importes netos, normalizados por IGV: así un proveedor gravado y uno
                        exonerado se comparan de verdad.
                      </p>
                    </div>
                  </div>
                </div>

                {/* ── Motivo del cambio: un clic, no un párrafo ───────────────── */}
                <div>
                  <p className="text-[11px] font-bold text-gray-500 uppercase tracking-wide mb-1">
                    ¿Por qué cambia? {motivoSugerido && <span className="text-violet-600 normal-case font-normal">· sugerido</span>}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {MOTIVOS_CAMBIO.filter(m => m.lado !== "venta").map(m => {
                      const sel = form.cambio_motivo === m.clave;
                      const sug = motivoSugerido === m.clave && !form.cambio_motivo;
                      return (
                        <button key={m.clave} type="button"
                          onClick={() => setForm(p => ({ ...p, cambio_motivo: sel ? "" : m.clave }))}
                          className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-colors ${
                            sel ? "bg-violet-600 text-white border-violet-600"
                                : sug ? "bg-violet-50 text-violet-700 border-violet-300"
                                      : "bg-white text-gray-600 border-gray-200 hover:bg-gray-50"}`}>
                          {m.nombre}
                        </button>
                      );
                    })}
                  </div>
                  {form.cambio_motivo && (
                    <input className={inputCls() + " mt-2"} placeholder="Detalle (opcional)"
                      value={form.cambio_nota} onChange={f("cambio_nota")} />
                  )}
                </div>

                {/* El otro tramo del día, a la vista. Sin esto no hay forma de saber, desde
                    esta pantalla, que el 0.00 de un retorno es correcto porque su ida ya
                    lleva la tarifa — y ese desconocimiento es lo que lleva a cargarla dos
                    veces. */}
                {hermano && (
                  <div className="rounded-xl border bg-gray-50 px-3 py-2 text-[11px] text-gray-600 flex flex-wrap gap-x-3 gap-y-1 items-center">
                    <span className="font-bold text-gray-700">
                      {String((hermano as any).direccion_servicio).toLowerCase() === "retorno" ? "↩ Su retorno" : "↪ Su ida"}
                    </span>
                    <span className="font-mono">{hermano.codigo ?? `#${hermano.id}`}</span>
                    <span className={["cancelada", "anulada"].includes(String(hermano.estado ?? "").toLowerCase()) ? "text-red-600 font-bold" : ""}>
                      {hermano.estado}
                    </span>
                    <span>costo {fmtSoles(Number(hermano.costo_proveedor ?? 0))}</span>
                    <span>precio {fmtSoles(Number(hermano.precio_cliente ?? 0))}</span>
                    <span className="text-gray-400">· la tarifa del día cubre los dos tramos</span>
                  </div>
                )}

                {/* Lo que va a pasar al guardar, dicho antes de guardar. No bloquea nada:
                    en esta fase la política está en modo observa y el bus sale igual. */}
                {(() => {
                  const r = reservas.find(x => x.id === editandoId);
                  const avisos = avisosDe({
                    tipo_asignacion: form.tipo_asignacion,
                    costo_proveedor: Number(form.costo_proveedor || 0),
                    precio_cliente: form.precio_cliente !== "" ? Number(form.precio_cliente) : Number(r?.precio_cliente ?? 0),
                    cambio_motivo: form.cambio_motivo || null,
                    direccion_servicio: (r as any)?.direccion_servicio ?? null,
                    estado: form.estado ?? r?.estado ?? null,
                  }, r ? { precio_cliente: r.precio_cliente, costo_proveedor: r.costo_proveedor } : null, hermano);
                  if (!avisos.length) return null;
                  return (
                    <div className="space-y-1.5">
                      {avisos.map((a, i) => (
                        <p key={i} className={`text-[11px] rounded-lg px-3 py-2 border ${
                          a.nivel === "alerta"
                            ? "bg-red-50 border-red-200 text-red-700"
                            : "bg-sky-50 border-sky-200 text-sky-800"}`}>
                          {a.texto}
                        </p>
                      ))}
                    </div>
                  );
                })()}

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
          {/* Sentido IDA / RETORNO (útil sobre todo en transporte de personal / fijos) */}
          <div className="flex gap-1 rounded-xl p-1" style={{ background: "#f1f5f9" }} title="Filtrar por sentido del servicio (ida o retorno)">
            {(["todos", "ida", "retorno"] as const).map(t => (
              <button
                key={t}
                onClick={() => setFiltroSentido(t)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
                style={{
                  background: filtroSentido === t ? "white" : "transparent",
                  color: filtroSentido === t ? "#0b315f" : "#9ca3af",
                  boxShadow: filtroSentido === t ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                }}
              >
                {t === "todos" ? "Ida y retorno" : t === "ida" ? "Ida" : "Retorno"}
              </button>
            ))}
          </div>
          {/* Origen contractual. "¿Cuántos adicionales le hicimos a este cliente en
              agosto?" no se podía responder desde el ERP: había que abrir la
              liquidación y leer renglón por renglón. */}
          <div className="flex gap-1 rounded-xl p-1" style={{ background: "#f1f5f9" }} title="Filtrar entre lo contratado y lo que el cliente pidió por encima del contrato">
            {(["todos", "contrato", "adicional"] as const).map(t => (
              <button
                key={t}
                onClick={() => setFiltroOrigen(t)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold transition-all"
                style={{
                  background: filtroOrigen === t ? "white" : "transparent",
                  color: filtroOrigen === t ? (t === "adicional" ? "#b45309" : "#0b315f") : "#9ca3af",
                  boxShadow: filtroOrigen === t ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                }}
              >
                {t === "todos" ? "Todo origen" : t === "contrato" ? "Contrato" : "Adicionales"}
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
            <button
              onClick={() => setVerTodo(v => !v)}
              title={verTodo ? "Volver a la vista rápida (ventana de fechas por defecto)" : "Cargar TODO el historial de servicios — más lento, úsalo para buscar servicios de otras fechas"}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-all"
              style={{
                background: verTodo ? "#fef3c7" : "white",
                borderColor: verTodo ? "#f59e0b" : "#e2e8f0",
                color:       verTodo ? "#92400e" : "#6b7280",
              }}
            >
              🕘 {verTodo ? "Viendo todo el historial" : "Ver todo"}
            </button>
            <div className="flex items-center px-4 py-1.5 bg-gray-50 border rounded-xl text-sm text-gray-400">
              {loading ? "Cargando…" : <>{filtradas.length} resultado{filtradas.length !== 1 ? "s" : ""}{verTodo ? "" : " · ventana"}</>}
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
                            {rutaDe(r0).o} → {rutaDe(r0).d}
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
                                      {esAdicional(r) && (
                                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full uppercase"
                                              title={r.precio_cotizado != null
                                                ? `Fuera del contrato. Cotizado S/ ${Number(r.precio_cotizado).toFixed(2)} · cobrado S/ ${Number(r.precio_cliente ?? 0).toFixed(2)}`
                                                : "Servicio fuera de lo contratado"}
                                              style={{ background: "#fef3c7", color: "#b45309" }}>
                                          {origenDe(r)}
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-4 py-2.5 capitalize text-gray-500">{diaSem}</td>
                                  <td className="px-4 py-2.5 text-gray-500">
                                    <HoraEditable hora={r.hora_servicio} editable={horaEditable(r)} onSubmit={nueva => pedirCambioHora(r, nueva)} textClass="text-gray-500" />
                                  </td>
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
                                        onClick={() => abrirManifiesto(r.id)}
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
                        <div className="text-sm font-bold text-gray-600">
                          <HoraEditable hora={r.hora_servicio} editable={horaEditable(r)} onSubmit={nueva => pedirCambioHora(r, nueva)} textClass="text-gray-600" />
                        </div>
                        <div className="font-mono text-[10px] text-gray-300">{idAfa(r)}</div>
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
                        <div className="text-xs text-gray-400 mt-0.5 truncate">{rutaDe(r).o} → {rutaDe(r).d}</div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          {esTer ? nombreEmpTer(r.empresa_tercerizada_id) : (nombreVehiculo(r.vehiculo_id) !== "-" ? nombreVehiculo(r.vehiculo_id) + " · " + nombreConductor(r.conductor_id) : "Sin asignar")}
                          {cap !== null && <span className="ml-2 text-[10px] font-bold">{totalPax}/{cap} pax</span>}
                        </div>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <button onClick={() => abrirManifiesto(r.id)} className="flex items-center gap-1 bg-purple-50 hover:bg-purple-100 text-purple-700 text-[10px] font-bold px-2 py-1.5 rounded-lg transition-colors"><FileText size={11} /></button>
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
      {filtroServicio !== "fijo" && !vistaAgenda && seleccionados.size > 0 && (
        <div className="flex items-center gap-3 px-5 py-3 rounded-2xl border" style={{ background: "#eef3f8", borderColor: "#c7d7ea" }}>
          <span className="text-sm font-bold" style={{ color: "#0b315f" }}>{seleccionados.size} seleccionado{seleccionados.size !== 1 ? "s" : ""}</span>
          <button onClick={seleccionarTodosFiltrados} className="text-xs font-bold px-3 py-1.5 rounded-lg border bg-white hover:bg-gray-50 transition-colors" style={{ borderColor: "#c7d7ea", color: "#0b315f" }}>
            Seleccionar todos ({filtradas.length})
          </button>
          <button onClick={limpiarSeleccion} className="text-xs font-bold px-3 py-1.5 rounded-lg border bg-white hover:bg-gray-50 transition-colors" style={{ borderColor: "#c7d7ea", color: "#0b315f" }}>
            Ninguno
          </button>
          {/* Reclasificar el origen. Va aquí y no en cada fila porque lo normal es
              corregir un mes entero de una ruta: fila por fila son sesenta clics y
              sesenta oportunidades de saltarse uno. */}
          <button
            onClick={() => prepararCambioOrigen("adicional")}
            title="Marcar lo seleccionado como servicio pedido por encima del contrato"
            className="ml-auto flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg text-white transition-colors hover:opacity-90"
            style={{ background: "#b45309" }}
          >
            <Sparkles size={13} /> Marcar como Adicional
          </button>
          {Array.from(seleccionados).some(id => {
            const r = reservas.find(x => x.id === id);
            return r ? esAdicional(r) : false;
          }) && (
            <button
              onClick={() => prepararCambioOrigen("contrato")}
              title="Devolver lo seleccionado a servicios del contrato"
              className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg border bg-white hover:bg-gray-50 transition-colors"
              style={{ borderColor: "#c7d7ea", color: "#0b315f" }}
            >
              Devolver a Contrato
            </button>
          )}
          <button
            onClick={() => prepararEliminacionLote(Array.from(seleccionados))}
            className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors"
          >
            <Trash2 size={13} /> Eliminar seleccionados
          </button>
        </div>
      )}

      {filtroServicio !== "fijo" && !vistaAgenda && (
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <th className="p-3 w-8" onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={filtradas.length > 0 && filtradas.every(r => seleccionados.has(r.id))}
                    onChange={() => {
                      if (filtradas.every(r => seleccionados.has(r.id))) limpiarSeleccion();
                      else seleccionarTodosFiltrados();
                    }}
                    className="cursor-pointer"
                  />
                </th>
                <th className="p-3 w-8"></th>
                {["ID", "Cotización", "Cliente", "Ruta", "Fecha", "Recurso", "Ocupacion", "Estado", "Administrativo", "Acciones"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={12} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                    Cargando...
                  </div>
                </td></tr>
              ) : filtradas.length === 0 ? (
                <tr><td colSpan={12} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">🎫</p>
                  <p className="font-medium">No hay reservas</p>
                </td></tr>
              ) : filtradas.slice(0, limiteVista).map((r, idx) => {
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
                const sentido   = sentidoServicio(r);
                // Muestra el numero_cotizacion real; si está vacío, cae al correlativo
                // #NNNNN derivado del id (mismo fallback que usa toda la app).
                const numCot    = r.cotizacion_id != null ? (cotMapNum[r.cotizacion_id] || String(r.cotizacion_id).padStart(5, "0")) : null;
                const asuntoCot = r.cotizacion_id != null ? cotMapAsunto[r.cotizacion_id] : null;

                let ocupBg = "#f8fafc", ocupColor = "#475569";
                if (sobrecupo) { ocupBg = "#fee2e2"; ocupColor = "#991b1b"; }
                else if (cap !== null && totalPax > 0 && totalPax >= cap * 0.9) { ocupBg = "#fef3c7"; ocupColor = "#92400e"; }
                else if (cap !== null && totalPax > 0) { ocupBg = "#dcfce7"; ocupColor = "#166534"; }

                return (
                  <React.Fragment key={r.id}>
                    {idx === sepIdx && (
                      <tr>
                        <td colSpan={12} className="px-4 py-2">
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
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <input type="checkbox" checked={seleccionados.has(r.id)} onChange={() => toggleSel(r.id)} className="cursor-pointer" />
                      </td>
                      <td className="p-3 text-gray-300 text-xs">{expandido ? "v" : ">"}</td>

                      <td className="p-3">
                        <span className="font-black font-mono text-[#0b315f]">{idAfa(r)}</span>
                        {badge && <div className="text-[9px] font-bold" style={{ color: badge.color }}>{badge.label}</div>}
                        {riesgo === "alto" && <div className="text-[9px] font-bold text-red-600">DOC VENC.</div>}
                        {sobrecupo && <div className="text-[9px] font-bold text-red-600">SOBRECUPO</div>}
                        <div className="mt-0.5 flex items-center gap-1 flex-wrap">
                          <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full" style={{ background: esFijo ? "#eef3f8" : "#ede9fe", color: esFijo ? "#0b315f" : "#6d28d9" }}>
                            {esFijo ? "Fijo" : "Eventual"}
                          </span>
                          {/* Fuera del contrato. Con la diferencia contra lo cotizado en el
                              tooltip: es la respuesta a "¿por qué esta salida costó S/ 480?". */}
                          {esAdicional(r) && (
                            <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full uppercase"
                                  title={r.precio_cotizado != null
                                    ? `Fuera del contrato. Cotizado S/ ${Number(r.precio_cotizado).toFixed(2)} · cobrado S/ ${Number(r.precio_cliente ?? 0).toFixed(2)}`
                                    : "Servicio fuera de lo contratado"}
                                  style={{ background: "#fef3c7", color: "#b45309" }}>
                              {origenDe(r)}
                            </span>
                          )}
                          {sentido === "ida" && (
                            <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full" style={{ background: "#dbeafe", color: "#1d4ed8" }}>IDA</span>
                          )}
                          {sentido === "retorno" && (
                            <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full" style={{ background: "#ede9fe", color: "#6d28d9" }}>RETORNO</span>
                          )}
                          {/* El dinero se pacta por DÍA (ida + retorno = una tarifa), así que
                              el aviso mira el par, no el tramo. Solo aparece cuando hay algo
                              que corregir: falta el importe en los dos, o está en los dos. */}
                          {(() => {
                            const p = problemaDelDia(r);
                            if (!p) return null;
                            return (
                              <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full"
                                title={p.texto === "DÍA 2×"
                                  ? "Los dos tramos del día llevan importe: el cierre lo liquidará dos veces."
                                  : "Ni la ida ni el retorno de este día tienen importe: no se podrá liquidar."}
                                style={Object.fromEntries(p.tono.split(";").map((x) => x.split(":"))) as any}>
                                {p.texto}
                              </span>
                            );
                          })()}
                        </div>
                      </td>

                      {/* N° de cotización que originó el servicio (clic → abre la cotización) */}
                      <td className="p-3 max-w-[120px]" onClick={e => e.stopPropagation()}>
                        {numCot ? (
                          <button
                            onClick={() => router.push(`/cotizaciones?buscar=${encodeURIComponent(numCot)}`)}
                            title="Abrir cotización"
                            className="font-mono font-bold text-xs text-[#0b315f] underline decoration-dotted underline-offset-2 hover:text-blue-600 transition-colors"
                          >
                            #{numCot}
                          </button>
                        ) : (
                          <span className="text-gray-300 text-xs">—</span>
                        )}
                        {asuntoCot && (
                          <div
                            title={asuntoCot}
                            className="mt-0.5 truncate text-[9px] font-black px-1.5 py-0.5 rounded-full"
                            style={{ background: "#f1f5f9", color: "#475569" }}
                          >
                            {asuntoCot}
                          </div>
                        )}
                      </td>

                      <td className="p-3 font-bold text-gray-800 max-w-[120px]">
                        <div className="truncate">{nombreCliente(r.cliente_id)}</div>
                      </td>

                      <td className="p-3 text-gray-600 max-w-[160px]">
                        {(() => {
                          const { o, d } = rutaDe(r);
                          return <div className="truncate text-xs" title={`${o} - ${d}`}>{o} - {d}</div>;
                        })()}
                      </td>

                      <td className="p-3 text-xs">
                        <div className="text-gray-700 font-medium">{fmtFecha(r.fecha_servicio)}</div>
                        <div className="text-gray-400">
                          <HoraEditable hora={r.hora_servicio} editable={horaEditable(r)} onSubmit={nueva => pedirCambioHora(r, nueva)} textClass="text-gray-400" />
                        </div>
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
                        {/* Un tercerizado sin costo pactado se ve AQUÍ, el día que se
                            programa, y no 30 días después en el bloque rojo del cierre. */}
                        {esTer && !(Number(r.costo_proveedor) > 0) && (
                          <span className="mt-1 ml-1 inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-md"
                            style={{ background: "#fee2e2", color: "#b91c1c" }}
                            title="Finanzas no podrá liquidar este servicio al cierre hasta que se cargue el costo.">
                            Sin costo
                          </span>
                        )}
                      </td>

                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => abrirManifiesto(r.id)}
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
                          <button onClick={() => abrirManifiesto(r.id)} className="flex items-center gap-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
                            <FileText size={13} /> Manifiesto
                          </button>
                          <button onClick={() => setModalLinksId(r.id)} className="flex items-center gap-1.5 bg-amber-50 hover:bg-amber-100 text-amber-700 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                            Links
                          </button>
                          {/* Cambiar el origen de ESTE servicio. La acción en lote solo
                              aparece al seleccionar filas, y eso no se adivina: quien mira
                              una fila y quiere marcarla la busca aquí. Abre el mismo modal
                              —con el arrastre del hermano y el aviso de lo ya liquidado—,
                              no una segunda regla que diga otra cosa. */}
                          <button
                            onClick={() => prepararCambioOrigen(esAdicional(r) ? "contrato" : "adicional", [r.id])}
                            title={esAdicional(r) ? "Devolver este servicio al contrato" : "Marcar este servicio como adicional"}
                            className="flex items-center justify-center p-2 rounded-xl transition-colors border"
                            style={esAdicional(r)
                              ? { background: "#fef3c7", color: "#b45309", borderColor: "#fde68a" }
                              : { background: "#f8fafc", color: "#94a3b8", borderColor: "#e2e8f0" }}
                          >
                            <Sparkles size={14} />
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
                        <td colSpan={12} className="px-6 py-5">
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
                                    <button onClick={() => abrirManifiesto(r.id)} className="text-xs font-bold px-3 py-1.5 rounded-lg border hover:bg-blue-50" style={{ borderColor: "#0b315f", color: "#0b315f" }}>
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
                              <button onClick={() => abrirManifiesto(r.id)} className="mt-1 text-[10px] font-bold px-2 py-1 rounded-lg text-white" style={{ background: "#0b315f" }}>
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
        {filtradas.length > limiteVista && (
          <div className="px-4 py-3 flex justify-center border-t" style={{ borderColor: "#f1f5f9" }}>
            <button
              onClick={() => setLimiteVista(v => v + 100)}
              className="px-4 py-2 rounded-xl text-xs font-bold border transition-colors hover:bg-gray-50"
              style={{ borderColor: "#0b315f", color: "#0b315f" }}
            >
              Cargar más ({filtradas.length - limiteVista} restantes)
            </button>
          </div>
        )}
        {filtradas.length > 0 && (
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>Mostrando {Math.min(limiteVista, filtradas.length)} de {filtradas.length}{verTodo ? "" : " · ventana actual"} · {totalRes} en total</span>
            <span>AFA ERP · Operaciones</span>
          </div>
        )}
      </section>
      )}
    </main>
  );
}