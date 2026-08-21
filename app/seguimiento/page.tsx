"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import ModalGps from "@/components/seguimiento/ModalGps";
import PanelMensajesPasajeros from "@/components/seguimiento/PanelMensajesPasajeros";
import DescargaMasivaModal from "@/components/seguimiento/DescargaMasivaModal";
import FichaServicioNueva from "@/components/seguimiento/FichaServicio";
import { supabase } from "@/lib/supabase";
import { ESTADOS_RESERVA, ESTADO_ADMIN_INICIAL } from "@/lib/estados";
import { idAfa } from "@/lib/folio";
import { manifiestoMtcHTML, reporteServicioHTML, abrirImprimible, esAbordado, type DocPasajero } from "@/lib/documentos-servicio";

// ══════════════════════════════════════════════════════════════════════════════
// TIPOS
// ══════════════════════════════════════════════════════════════════════════════

type EstadoReserva = "pendiente"|"programada"|"confirmada"|"en_curso"|"finalizada"|"cancelada";
type EstadoVisual  = "programado"|"en_ruta"|"finalizado"|"alerta"|"cancelado";

type Reserva = {
  id: number; codigo?: string|null; cliente_id: number|null; vehiculo_id: number|null; conductor_id: number|null;
  empresa_tercerizada_id: number|null; vehiculo_tercero_id: number|null;
  tipo: string; tipo_asignacion: string|null; tipo_servicio_detalle: string|null;
  estado: EstadoReserva; fecha_servicio: string|null; hora_servicio: string|null;
  hora_real_inicio?: string|null; hora_real_fin?: string|null;
  checkin_realizado?: boolean|null; viaticos_entregados?: boolean|null;
  documentos_ok?: boolean|null; conformidad_firmada?: boolean|null;
  conformidad_url?: string|null; unidad_reemplazo_placa?: string|null;
  reemplazo_motivo?: string|null; pasajeros_abordados?: number|null;
  precio_cliente: number; costo_proveedor: number; margen: number;
  observaciones: string|null; origen?: string|null; destino?: string|null;
};

type Cliente   = { id: number; nombre: string; empresa?: string|null };
type Vehiculo  = { id: number; placa: string; capacidad_pasajeros?: number|null };
type Conductor = { id: number; nombre: string; telefono?: string|null };
type EmpTer    = { id: number; razon_social: string; telefono?: string|null };
type VehTer    = { id: number; placa: string };
type Parada    = { id: number; reserva_id: number; orden: number; nombre: string; estado: string; hora_estimada?: string|null; lat?: number|null; lng?: number|null };
type DocTer    = { id: number; empresa_id: number; tipo: string; fecha_vencimiento?: string|null };
type DocVeh    = { id: number; vehiculo_id: number; tipo: string; fecha_vencimiento?: string|null };
type ChecklistRow = { id: number; reserva_id: number; item_id: string; completado: boolean };

type ServicioView = {
  reserva: Reserva; cliente_nombre: string; vehiculo_placa: string;
  conductor_nombre: string; conductor_tel: string; es_eventual: boolean;
  estado_visual: EstadoVisual; paradas: Parada[]; paradas_total: number;
  paradas_completadas: number; pasajeros_total: number; pasajeros_abordados: number;
  pasajeros_total_real: number; seguro_vence_hoy: boolean;
  gastos_total: number; docs_vencidos: string[];
  // Alertas de flota cruzadas (se rellenan en un segundo memo sobre todos los servicios):
  conflicto_vehiculo?: boolean; conflicto_conductor?: boolean; jornada_extensa?: boolean;
};

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ══════════════════════════════════════════════════════════════════════════════

// Etiquetas alineadas con la fuente única (lib/estados). "programado" y "alerta"
// son agrupaciones visuales propias del tablero de seguimiento, no estados de BD.
const ESTADO_VIS = {
  programado: { label: "Programado",                     color: "#6366f1", bg: "#eef2ff", dot: "#6366f1" },
  en_ruta:    { label: ESTADOS_RESERVA.en_curso.label,   color: "#16a34a", bg: "#dcfce7", dot: "#16a34a" },
  finalizado: { label: ESTADOS_RESERVA.finalizada.label, color: "#64748b", bg: "#f1f5f9", dot: "#94a3b8" },
  alerta:     { label: "⚠ Alerta",                       color: "#dc2626", bg: "#fef2f2", dot: "#dc2626" },
  cancelado:  { label: ESTADOS_RESERVA.cancelada.label,  color: "#991b1b", bg: "#fee2e2", dot: "#991b1b" },
} as const;

const CHECKLIST_ITEMS = [
  { id: "lavado",      label: "Bus lavado y presentable" },
  { id: "combustible", label: "Combustible completo (tanque lleno)" },
  { id: "viaticos",    label: "Conductor recibió viáticos en efectivo" },
  { id: "documentos",  label: "Contrato, Permiso Turismo y Guía de Remisión a bordo" },
  { id: "botiquin",    label: "Botiquín de emergencias verificado" },
  { id: "conductor",   label: "Conductor con brevete vigente y descanso suficiente" },
  { id: "pasajeros",   label: "Lista de pasajeros confirmada con el responsable" },
  { id: "ruta",        label: "Itinerario impreso entregado al conductor" },
];

const CATS_GASTO = [
  { valor: "peajes",              label: "🛣️ Peaje"       },
  { valor: "viaticos",            label: "🍽️ Viático"     },
  { valor: "estacionamiento",     label: "🅿️ Estac."      },
  { valor: "multa",               label: "🚨 Multa"       },
  { valor: "conductor_servicio",  label: "🧑‍✈️ Conductor"  },
  { valor: "otro",                label: "💸 Otro"        },
];

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function hoyISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function diasPara(fecha: string|null|undefined): number|null {
  if (!fecha) return null;
  return Math.ceil((new Date(fecha+"T00:00:00").getTime() - Date.now()) / 86400000);
}
function calcularEstadoVisual(r: Reserva): EstadoVisual {
  if (r.estado === "cancelada")  return "cancelado";
  if (r.estado === "finalizada") return "finalizado";
  if (r.estado === "en_curso")   return "en_ruta";
  if (r.fecha_servicio === hoyISO() && r.hora_servicio) {
    const [hh, mm] = r.hora_servicio.split(":").map(Number);
    const horaPlan = new Date(); horaPlan.setHours(hh, mm, 0, 0);
    if ((new Date().getTime() - horaPlan.getTime()) / 60000 > 15 && !r.checkin_realizado) return "alerta";
  }
  return "programado";
}
const TIPOS_SERVICIO_FIJO_SEG = new Set([
  "transporte_personal",
  "fijo_solo_ida",
  "fijo_multiparada",
  "fijo_reten",
]);
function esEventual(r: Reserva): boolean { return !TIPOS_SERVICIO_FIJO_SEG.has(r.tipo_servicio_detalle || ""); }
function riesgoEmpresaDocs(docs: DocTer[], empresaId: number|null): boolean {
  if (!empresaId) return false;
  const OBL = ["SOAT","Revisión Técnica (CITV)","Habilitación SUTRAN","Permiso Operación MTC"];
  return docs.some(d => d.empresa_id === empresaId && OBL.includes(d.tipo) && (diasPara(d.fecha_vencimiento) ?? 1) < 0);
}
function seguroVehiculoVenceHoy(docs: DocVeh[], vehiculoId: number|null): boolean {
  if (!vehiculoId) return false;
  return docs.some(d => d.vehiculo_id === vehiculoId && d.tipo.toLowerCase().includes("soat") && d.fecha_vencimiento === hoyISO());
}

// Hora local de Perú (UTC-5, sin DST). No usar new Date().toTimeString() para registrar
// horas operativas: depende del reloj del dispositivo, no de la hora de Lima.
function horaPeru(): string {
  const utc  = Date.now() + new Date().getTimezoneOffset() * 60000;
  const lima = new Date(utc - 5 * 3600000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(lima.getHours())}:${p(lima.getMinutes())}:${p(lima.getSeconds())}`;
}

// Fuente de verdad del abordaje (pasajeros_parada, estado + estado_abordaje) → esAbordado()
// vive en lib/documentos-servicio.ts (compartido con el portal cliente y los documentos).

// Documentos vencidos (fecha de vencimiento ya pasada): bloquean la salida.
function docsVencidosVehiculo(docs: DocVeh[], vehiculoId: number|null): string[] {
  if (!vehiculoId) return [];
  return docs.filter(d => d.vehiculo_id === vehiculoId && (diasPara(d.fecha_vencimiento) ?? 1) < 0).map(d => d.tipo);
}
function docsVencidosEmpresa(docs: DocTer[], empresaId: number|null): string[] {
  if (!empresaId) return [];
  const OBL = ["SOAT","Revisión Técnica (CITV)","Habilitación SUTRAN","Permiso Operación MTC"];
  return docs.filter(d => d.empresa_id === empresaId && OBL.includes(d.tipo) && (diasPara(d.fecha_vencimiento) ?? 1) < 0).map(d => d.tipo);
}

// ── Alertas de flota cruzadas entre servicios (solape de recurso + jornada del conductor) ──
// No hay campo de duración en reservas, así que el fin se estima con un bloque por defecto
// cuando aún no hay hora_real_fin. Son alertas ADVERTENCIA (heurística), no certezas.
const DUR_ESTIMADA_MIN        = 240; // 4 h: bloque por defecto para estimar el fin de un servicio
const JORNADA_MAX_H           = 13;  // jornada (1ª salida → último fin) que dispara alerta de fatiga
const MAX_SERVICIOS_CONDUCTOR = 4;   // nº de servicios/día que dispara alerta de fatiga

function aMin(hhmm?: string|null): number|null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isNaN(h) ? null : h * 60 + (m || 0);
}

function detectarAlertasFlota(base: ServicioView[]): { vehiculo: Set<number>; conductor: Set<number>; fatiga: Set<number> } {
  const vehiculo = new Set<number>(), conductor = new Set<number>(), fatiga = new Set<number>();
  const intervalo = (s: ServicioView): [number, number] | null => {
    const ini = aMin(s.reserva.hora_servicio);
    if (ini == null) return null;
    const fin = aMin(s.reserva.hora_real_fin) ?? ini + DUR_ESTIMADA_MIN;
    return [ini, Math.max(fin, ini + 1)];
  };
  const agrupar = (key: (s: ServicioView) => string | null, marca: Set<number>) => {
    const grupos: Record<string, ServicioView[]> = {};
    base.forEach(s => {
      if (s.reserva.estado === "cancelada") return;
      const k = key(s); if (!k) return;
      (grupos[k] ||= []).push(s);
    });
    Object.values(grupos).forEach(g => {
      for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
        const a = intervalo(g[i]), b = intervalo(g[j]);
        if (a && b && a[0] < b[1] && b[0] < a[1]) { marca.add(g[i].reserva.id); marca.add(g[j].reserva.id); }
      }
    });
    return grupos;
  };
  agrupar(s => s.reserva.vehiculo_id ? `v${s.reserva.vehiculo_id}` : s.reserva.vehiculo_tercero_id ? `vt${s.reserva.vehiculo_tercero_id}` : null, vehiculo);
  const gruposCond = agrupar(s => s.reserva.conductor_id ? `c${s.reserva.conductor_id}` : null, conductor);
  Object.values(gruposCond).forEach(g => {
    const inicios = g.map(s => aMin(s.reserva.hora_servicio)).filter((x): x is number => x != null);
    const fines   = g.map(s => intervalo(s)?.[1]).filter((x): x is number => x != null);
    if (!inicios.length || !fines.length) return;
    const spanH = (Math.max(...fines) - Math.min(...inicios)) / 60;
    if (spanH > JORNADA_MAX_H || g.length >= MAX_SERVICIOS_CONDUCTOR) g.forEach(s => fatiga.add(s.reserva.id));
  });
  return { vehiculo, conductor, fatiga };
}

// ══════════════════════════════════════════════════════════════════════════════
// ICONOS
// ══════════════════════════════════════════════════════════════════════════════

type IP = { size?: number; strokeWidth?: number; className?: string; color?: string };
const Ic = {
  Map:        (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>,
  Bus:        (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M8 6v6"/><path d="M16 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><circle cx="15" cy="18" r="2"/></svg>,
  Users:      (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  Check:      (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="20 6 9 17 4 12"/></svg>,
  Clock:      (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Alert:      (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  X:          (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Plus:       (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Phone:      (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.41 2 2 0 0 1 3.6 1.21h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 5.95 5.95l.96-.96a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21.72 16.92z"/></svg>,
  DollarSign: (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  Swap:       (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>,
  Shield:     (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Search:     (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  ChevronDown:(p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="6 9 12 15 18 9"/></svg>,
  ChevronUp:  (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="18 15 12 9 6 15"/></svg>,
  Camera:     (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>,
  ExternalLink:(p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
  List:       (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
  Refresh:    (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
  FileText:   (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
  Calendar:   (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
};

// ══════════════════════════════════════════════════════════════════════════════
// MODAL GASTOS
// ══════════════════════════════════════════════════════════════════════════════

function ModalGastos({ reservaId, vehiculoId, cliente, onClose, onSaved }: {
  reservaId: number; vehiculoId: number|null; cliente: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [gastos,        setGastos]        = useState<{id:number;descripcion:string;monto:number;categoria:string}[]>([]);
  const [nuevoConcepto, setNuevoConcepto] = useState("");
  const [nuevoMonto,    setNuevoMonto]    = useState("");
  const [nuevoCategoria,setNuevoCategoria]= useState("peajes");
  const [cargando,      setCargando]      = useState(true);
  const [guardando,     setGuardando]     = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    const { data } = await supabase.from("gastos").select("id,descripcion,monto,categoria").eq("reserva_id", reservaId).order("created_at");
    setGastos(data || []);
    setCargando(false);
  }, [reservaId]);

  useEffect(() => { cargar(); }, [cargar]);

  const total = gastos.reduce((s, g) => s + Number(g.monto), 0);

  const agregar = async () => {
    if (!nuevoConcepto || !nuevoMonto) return;
    setGuardando(true);
    const { error } = await supabase.from("gastos").insert({
      reserva_id: reservaId, vehiculo_id: vehiculoId,
      fecha: new Date().toISOString().split("T")[0], categoria: nuevoCategoria,
      tipo_gasto: "operativo", descripcion: nuevoConcepto.trim(),
      monto: parseFloat(nuevoMonto), metodo_pago: "efectivo", estado: "pagado",
    });
    if (error) { alert("Error: " + error.message); setGuardando(false); return; }
    setNuevoConcepto(""); setNuevoMonto("");
    await cargar(); setGuardando(false);
  };

  const eliminar = async (id: number) => {
    await supabase.from("gastos").delete().eq("id", id); await cargar();
  };

  const cerrar = () => { onSaved(); onClose(); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h3 className="font-black text-[#0b315f] text-base">Control de Gastos</h3>
            <p className="text-xs text-gray-400 mt-0.5">Reserva #{reservaId} · {cliente}</p>
          </div>
          <button onClick={cerrar} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 flex items-center justify-center transition-colors"><Ic.X size={14} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {cargando ? <p className="text-center text-gray-400 text-sm py-4">Cargando...</p>
              : gastos.length === 0 ? <p className="text-center text-gray-400 text-sm py-4">Sin gastos registrados</p>
              : gastos.map(g => (
                <div key={g.id} className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-2.5 group">
                  <div className="flex items-center gap-2.5 flex-1 min-w-0">
                    <span className="text-sm">{CATS_GASTO.find(c => c.valor === g.categoria)?.label.split(" ")[0] || "💸"}</span>
                    <span className="text-[13px] font-semibold text-gray-700 truncate">{g.descripcion}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-black text-[#0b315f] text-[13px]">S/ {Number(g.monto).toFixed(2)}</span>
                    <button onClick={() => eliminar(g.id)} className="opacity-0 group-hover:opacity-100 text-red-500 transition-opacity"><Ic.X size={12} /></button>
                  </div>
                </div>
              ))}
          </div>
          <div className="flex items-center justify-between bg-[#0b315f] rounded-xl px-4 py-3">
            <span className="text-white/70 text-sm font-semibold">Total gastado</span>
            <span className="text-white font-black text-lg">S/ {total.toFixed(2)}</span>
          </div>
          <div className="border border-gray-100 rounded-xl p-3 space-y-2">
            <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Agregar gasto</p>
            <div className="grid grid-cols-3 gap-1">
              {CATS_GASTO.map(c => (
                <button key={c.valor} onClick={() => setNuevoCategoria(c.valor)}
                  className={`text-[10px] font-bold px-2 py-1.5 rounded-lg transition-colors text-left ${nuevoCategoria === c.valor ? "bg-[#0b315f] text-white" : "bg-gray-50 text-gray-600 hover:bg-gray-100"}`}>
                  {c.label}
                </button>
              ))}
            </div>
            <input className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0b315f] transition-colors"
              placeholder="Descripción (ej: Peaje Canta, Viático conductor)" value={nuevoConcepto} onChange={e => setNuevoConcepto(e.target.value)} />
            <div className="flex gap-2">
              <input type="number" step="0.01" className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0b315f] transition-colors"
                placeholder="Monto S/" value={nuevoMonto} onChange={e => setNuevoMonto(e.target.value)} />
              <button onClick={agregar} disabled={guardando || !nuevoConcepto || !nuevoMonto}
                className="bg-[#0b315f] text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-[#1262bd] transition-colors flex items-center gap-1.5 disabled:opacity-50">
                <Ic.Plus size={14} color="white" />{guardando ? "..." : "Agregar"}
              </button>
            </div>
          </div>
        </div>
        <div className="px-5 pb-5">
          <button onClick={cerrar} className="w-full bg-[#0b315f] text-white py-3 rounded-xl font-bold text-sm hover:bg-[#1262bd] transition-colors">Listo</button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MODAL REEMPLAZO
// ══════════════════════════════════════════════════════════════════════════════

function ModalReemplazo({ reservaId, placaOriginal, onClose, onSaved }: { reservaId: number; placaOriginal: string; onClose: () => void; onSaved: () => void }) {
  const [placaNueva, setPlacaNueva] = useState("");
  const [motivo,     setMotivo]     = useState("");
  const [guardando,  setGuardando]  = useState(false);

  const confirmar = async () => {
    if (!placaNueva || !motivo) { alert("Completa placa y motivo"); return; }
    setGuardando(true);
    const { error } = await supabase.from("reservas").update({ unidad_reemplazo_placa: placaNueva.toUpperCase(), reemplazo_motivo: motivo }).eq("id", reservaId);
    setGuardando(false);
    if (error) { alert("Error: " + error.message); return; }
    onSaved(); onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h3 className="font-black text-[#0b315f] text-base">Gestión de Reemplazo</h3>
            <p className="text-xs text-gray-400 mt-0.5">Reserva #{reservaId} · Original: {placaOriginal}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 flex items-center justify-center"><Ic.X size={14} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2.5">
            <Ic.Alert size={15} color="#d97706" />
            <p className="text-amber-700 text-xs font-semibold leading-relaxed">Registrar el reemplazo garantiza que la facturación mensual al cliente sea correcta y quede trazado en el historial.</p>
          </div>
          <div>
            <label className="block text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">Placa unidad de reemplazo</label>
            <input className="w-full border border-gray-200 rounded-xl px-4 py-3 font-black text-[#0b315f] text-lg tracking-widest text-center uppercase outline-none focus:border-[#0b315f] transition-colors"
              placeholder="EJM-000" value={placaNueva} onChange={e => setPlacaNueva(e.target.value.toUpperCase())} />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">Motivo del reemplazo</label>
            <select className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-700 outline-none focus:border-[#0b315f] transition-colors" value={motivo} onChange={e => setMotivo(e.target.value)}>
              <option value="">Seleccionar motivo...</option>
              <option>Falla mecánica</option><option>Accidente</option>
              <option>Mantenimiento programado</option><option>Unidad en CITV</option><option>Otro</option>
            </select>
          </div>
          <button onClick={confirmar} disabled={guardando} className="w-full bg-[#0b315f] text-white py-3 rounded-xl font-bold text-sm hover:bg-[#1262bd] transition-colors disabled:opacity-60">
            {guardando ? "Guardando..." : "Confirmar reemplazo"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MODAL CHECKLIST
// ══════════════════════════════════════════════════════════════════════════════

function ModalChecklist({ reservaId, cliente, onClose, onSaved }: { reservaId: number; cliente: string; onClose: () => void; onSaved: () => void }) {
  const [checked,   setChecked]  = useState<Record<string, boolean>>({});
  const [cargando,  setCargando] = useState(true);
  const [guardando, setGuardando]= useState(false);

  useEffect(() => {
    (async () => {
      setCargando(true);
      const { data } = await supabase.from("checklist_salida").select("*").eq("reserva_id", reservaId);
      const map: Record<string, boolean> = {};
      ((data as ChecklistRow[]) || []).forEach(row => { map[row.item_id] = row.completado; });
      setChecked(map); setCargando(false);
    })();
  }, [reservaId]);

  const toggle = (item: string) => setChecked(prev => ({ ...prev, [item]: !prev[item] }));
  const completados = Object.values(checked).filter(Boolean).length;
  const todoListo   = completados === CHECKLIST_ITEMS.length;

  const guardar = async () => {
    setGuardando(true);
    const rows = CHECKLIST_ITEMS.map(it => ({ reserva_id: reservaId, item_id: it.id, completado: !!checked[it.id], fecha_check: checked[it.id] ? new Date().toISOString() : null }));
    const { error } = await supabase.from("checklist_salida").upsert(rows, { onConflict: "reserva_id,item_id" });
    setGuardando(false);
    if (error) { alert("Error: " + error.message); return; }
    onSaved(); onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 flex-shrink-0">
          <div>
            <h3 className="font-black text-[#0b315f] text-base">Checklist de Salida</h3>
            <p className="text-xs text-gray-400 mt-0.5">Reserva #{reservaId} · {cliente}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 flex items-center justify-center"><Ic.X size={14} /></button>
        </div>
        <div className="px-5 py-3 border-b border-gray-50 flex-shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-gray-500">{completados}/{CHECKLIST_ITEMS.length} verificados</span>
            <span className={`text-xs font-black ${todoListo ? "text-green-600" : "text-gray-400"}`}>{todoListo ? "✓ Listo para salir" : "Pendiente"}</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${(completados/CHECKLIST_ITEMS.length)*100}%`, background: todoListo ? "#16a34a" : "#0b315f" }} />
          </div>
        </div>
        <div className="p-5 overflow-y-auto flex-1 space-y-2">
          {cargando ? <p className="text-center text-gray-400 text-sm">Cargando...</p> : CHECKLIST_ITEMS.map(item => (
            <label key={item.id} className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-colors ${checked[item.id] ? "bg-green-50 border border-green-100" : "bg-gray-50 border border-transparent hover:bg-gray-100"}`}>
              <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-all ${checked[item.id] ? "bg-green-600 border-green-600" : "border-gray-300"}`}>
                {checked[item.id] && <Ic.Check size={11} color="white" strokeWidth={3} />}
              </div>
              <input type="checkbox" className="hidden" checked={!!checked[item.id]} onChange={() => toggle(item.id)} />
              <span className={`text-sm font-semibold ${checked[item.id] ? "text-green-700" : "text-gray-600"}`}>{item.label}</span>
            </label>
          ))}
        </div>
        <div className="p-5 border-t border-gray-100 flex-shrink-0">
          <button onClick={guardar} disabled={guardando}
            className={`w-full py-3 rounded-xl font-bold text-sm transition-all ${todoListo ? "bg-green-600 text-white hover:bg-green-700" : "bg-[#0b315f] text-white hover:bg-[#1262bd]"} disabled:opacity-60`}>
            {guardando ? "Guardando..." : todoListo ? "✓ Autorizar salida" : `Guardar avance (${completados}/${CHECKLIST_ITEMS.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TARJETA FIJA
// ══════════════════════════════════════════════════════════════════════════════

function TarjetaFija({ s, onRefresh, onGps, enFicha = false }: { s: ServicioView; onRefresh: () => void; onGps: (s: ServicioView) => void; enFicha?: boolean }) {
  const [expandida,        setExpandida]        = useState(enFicha);
  const [modalReemplazo,   setModalReemplazo]   = useState(false);
  const [modalGastos,      setModalGastos]      = useState(false);
  const [modalChecklist,   setModalChecklist]   = useState(false);
  const [guardandoCheckin, setGuardandoCheckin] = useState(false);
  const [horaInicio,       setHoraInicio]       = useState(s.reserva.hora_real_inicio || "");
  const [horaFin,          setHoraFin]          = useState(s.reserva.hora_real_fin || "");
  const r           = s.reserva;
  const estado      = ESTADO_VIS[s.estado_visual];
  const totalGastos = s.gastos_total;
  const bloqueado   = s.docs_vencidos.length > 0;
  const progreso    = s.paradas_total > 0 ? Math.round((s.paradas_completadas/s.paradas_total)*100) : 0;
  const asistencia  = s.pasajeros_total_real > 0 ? Math.round((s.pasajeros_abordados/s.pasajeros_total_real)*100) : 0;
  const cap         = s.pasajeros_total_real || (r as any).pasajeros_total || 0;

  const hacerCheckin = async () => {
    setGuardandoCheckin(true);
    const ahora = horaPeru();
    const { error } = await supabase.from("reservas").update({ checkin_realizado: true, hora_real_inicio: ahora, estado: "en_curso" as EstadoReserva }).eq("id", r.id);
    setGuardandoCheckin(false);
    if (error) { alert("Error: " + error.message); return; }
    onRefresh();
  };

  const guardarHoras = async () => {
    const { error } = await supabase.from("reservas").update({
      hora_real_inicio: horaInicio || null, hora_real_fin: horaFin || null,
      estado: (horaFin ? "finalizada" : r.estado) as EstadoReserva,
      // Puente A→B: al finalizar por primera vez, arranca el cierre administrativo.
      ...(horaFin && r.estado !== "finalizada" ? { estado_admin: ESTADO_ADMIN_INICIAL } : {}),
    }).eq("id", r.id);
    if (error) { alert("Error: " + error.message); return; }
    onRefresh();
  };

  return (
    <>
      {modalReemplazo && <ModalReemplazo reservaId={r.id} placaOriginal={s.vehiculo_placa} onClose={() => setModalReemplazo(false)} onSaved={onRefresh} />}
      {modalGastos    && <ModalGastos reservaId={r.id} vehiculoId={r.vehiculo_id} cliente={s.cliente_nombre} onClose={() => setModalGastos(false)} onSaved={onRefresh} />}
      {modalChecklist && <ModalChecklist reservaId={r.id} cliente={s.cliente_nombre} onClose={() => setModalChecklist(false)} onSaved={onRefresh} />}

      <div className={enFicha ? "" : `bg-white rounded-2xl shadow-sm border transition-all duration-200 ${s.estado_visual === "alerta" ? "border-red-200 shadow-red-50" : "border-gray-100 hover:border-gray-200"}`}>
        {bloqueado && (
          <div className={`flex items-center gap-2 bg-red-100 border-b border-red-200 px-4 py-2 ${enFicha ? "" : "rounded-t-2xl"}`}>
            <Ic.Shield size={13} color="#b91c1c" />
            <span className="text-red-700 text-xs font-black">⛔ DOCUMENTOS VENCIDOS: {s.docs_vencidos.join(", ")} — No despachar la unidad</span>
          </div>
        )}
        {s.seguro_vence_hoy && (
          <div className={`flex items-center gap-2 bg-red-50 border-b border-red-100 px-4 py-2 ${enFicha || bloqueado ? "" : "rounded-t-2xl"}`}>
            <Ic.Shield size={13} color="#dc2626" />
            <span className="text-red-600 text-xs font-bold">SEGURO DE LA UNIDAD VENCE HOY — Verificar antes de salir</span>
          </div>
        )}
        <div className="p-4">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-start gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${s.estado_visual === "alerta" ? "bg-red-50" : "bg-[#EFF6FF]"}`}>
                <Ic.Bus size={18} color={s.estado_visual === "alerta" ? "#dc2626" : "#0b315f"} strokeWidth={1.8} />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-black text-[#0b315f] text-sm">{s.cliente_nombre}</span>
                  <span className="text-[10px] font-bold bg-[#EFF6FF] text-[#1d4ed8] px-2 py-0.5 rounded-full">{idAfa(r)}</span>
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-xs text-gray-400 font-mono font-bold">{s.vehiculo_placa}</span>
                  <span className="text-gray-200">·</span>
                  <span className="text-xs text-gray-500">{s.conductor_nombre}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-[11px] font-black px-2.5 py-1 rounded-full" style={{ color: estado.color, background: estado.bg }}>{estado.label}</span>
              {!enFicha && (
                <button onClick={() => setExpandida(v => !v)} className="w-7 h-7 rounded-lg bg-gray-50 hover:bg-gray-100 flex items-center justify-center transition-colors">
                  {expandida ? <Ic.ChevronUp size={13} /> : <Ic.ChevronDown size={13} />}
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 mb-3">
            <div className={`rounded-xl p-2.5 text-center ${r.checkin_realizado ? "bg-green-50" : s.estado_visual === "alerta" ? "bg-red-50" : "bg-gray-50"}`}>
              <div className={`text-[10px] font-bold uppercase tracking-wide mb-1 ${r.checkin_realizado ? "text-green-600" : "text-red-500"}`}>CHECK-IN</div>
              <div className={`font-black text-sm ${r.checkin_realizado ? "text-green-700" : "text-red-600"}`}>{r.checkin_realizado ? (r.hora_real_inicio?.slice(0,5) || "✓") : "No iniciado"}</div>
            </div>
            <div className="bg-gray-50 rounded-xl p-2.5 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Pasajeros</div>
              <div className="font-black text-sm text-[#0b315f]">{s.pasajeros_abordados}<span className="text-gray-300 font-normal">/{cap || "?"}</span></div>
            </div>
            <div className="bg-gray-50 rounded-xl p-2.5 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Paradas</div>
              <div className="font-black text-sm text-[#0b315f]">{s.paradas_completadas}<span className="text-gray-300 font-normal">/{s.paradas_total}</span></div>
            </div>
          </div>

          {s.paradas_total > 0 && (
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-400 font-semibold">Progreso de ruta</span>
                <span className="text-[10px] font-bold text-[#0b315f]">{progreso}%</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-700" style={{ width: `${progreso}%`, background: progreso === 100 ? "#16a34a" : "#0b315f" }} />
              </div>
            </div>
          )}

          {cap > 0 && (
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-400 font-semibold">Asistencia</span>
                <span className="text-[10px] font-bold text-[#0b315f]">{asistencia}%</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-700 bg-indigo-500" style={{ width: `${asistencia}%` }} />
              </div>
            </div>
          )}

          <div className="flex items-center gap-1.5 mb-3 flex-wrap">
            <button onClick={() => supabase.from("reservas").update({ viaticos_entregados: !r.viaticos_entregados }).eq("id", r.id).then(onRefresh)}
              className={`text-[10px] font-bold px-2 py-1 rounded-lg transition-colors ${r.viaticos_entregados ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
              {r.viaticos_entregados ? "✓" : "✗"} Viáticos
            </button>
            <button onClick={() => supabase.from("reservas").update({ documentos_ok: !r.documentos_ok }).eq("id", r.id).then(onRefresh)}
              className={`text-[10px] font-bold px-2 py-1 rounded-lg transition-colors ${r.documentos_ok ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
              {r.documentos_ok ? "✓" : "!"} Documentos
            </button>
            {totalGastos > 0 && (
              <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-blue-50 text-blue-700">S/ {totalGastos.toFixed(2)} gastos</span>
            )}
          </div>

          <div className="flex gap-2 flex-wrap">
            {!r.checkin_realizado && r.estado !== "finalizada" && r.estado !== "cancelada" && (
              <button onClick={hacerCheckin} disabled={guardandoCheckin || bloqueado}
                title={bloqueado ? "No se puede despachar: documentos vencidos" : undefined}
                className="flex-1 flex items-center justify-center gap-1.5 bg-green-600 hover:bg-green-700 text-white text-xs font-bold py-2 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                <Ic.Check size={13} color="white" />{guardandoCheckin ? "..." : bloqueado ? "Salida bloqueada" : "Hacer Check-in"}
              </button>
            )}
            {/* GPS */}
            <button onClick={() => onGps(s)}
              className="flex items-center gap-1.5 bg-[#EFF6FF] hover:bg-[#DBEAFE] text-[#1d4ed8] text-xs font-bold px-3 py-2 rounded-xl transition-colors">
              <Ic.Map size={13} color="#1d4ed8" /> GPS en vivo
            </button>
            {/* Manifiesto de pasajeros */}
            <Link href={`/programacion?reserva=${r.id}`}
              className="flex items-center gap-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
              <Ic.FileText size={13} /> Manifiesto
            </Link>
            {/* Gastos */}
            <button onClick={() => setModalGastos(true)}
              className="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 text-gray-600 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
              <Ic.DollarSign size={13} /> Gastos{totalGastos > 0 ? ` · S/${totalGastos.toFixed(0)}` : ""}
            </button>
            {/* Checklist */}
            <button onClick={() => setModalChecklist(true)}
              className="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 text-gray-600 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
              <Ic.Check size={13} /> Checklist salida
            </button>
            {/* Reemplazo */}
            <button onClick={() => setModalReemplazo(true)}
              className="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 text-gray-500 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
              <Ic.Swap size={13} /> Reemplazo
            </button>
            {s.conductor_tel && (
              <a href={`tel:${s.conductor_tel}`} className="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 text-gray-500 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
                <Ic.Phone size={13} />
              </a>
            )}
          </div>
        </div>

        {expandida && (
          <div className="border-t border-gray-50 p-4 space-y-4">
            <div>
              <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2.5">Registro horario real</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] text-gray-400 font-semibold mb-1">Inicio</label>
                  <input type="time" value={horaInicio?.slice(0,5)||""} onChange={e => setHoraInicio(e.target.value)} className="w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f] transition-colors" />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-400 font-semibold mb-1">Fin</label>
                  <input type="time" value={horaFin?.slice(0,5)||""} onChange={e => setHoraFin(e.target.value)} className="w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f] transition-colors" />
                </div>
              </div>
            </div>
            <div>
              <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2.5">Paradas del recorrido</p>
              {s.paradas.length === 0 ? (
                <p className="text-xs text-gray-400 italic">Sin paradas registradas</p>
              ) : (
                <div className="space-y-1.5">
                  {s.paradas.map((p, i) => (
                    <div key={p.id} className="flex items-center gap-2 text-xs">
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black flex-shrink-0 ${p.estado === "completada" ? "bg-green-500 text-white" : "bg-gray-100 text-gray-500"}`}>
                        {p.estado === "completada" ? "✓" : i+1}
                      </div>
                      <span className={`flex-1 truncate ${p.estado === "completada" ? "text-green-700 font-semibold" : "text-gray-600"}`}>{p.nombre}</span>
                      {p.hora_estimada && <span className="text-gray-400 font-mono text-[10px]">{p.hora_estimada.slice(0,5)}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {r.unidad_reemplazo_placa && (
              <div className="bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 flex items-center gap-2">
                <Ic.Swap size={14} color="#d97706" />
                <span className="text-amber-700 text-xs font-semibold">Unidad {s.vehiculo_placa} → reemplazada por {r.unidad_reemplazo_placa}{r.reemplazo_motivo ? ` (${r.reemplazo_motivo})` : ""}</span>
              </div>
            )}
            <button onClick={guardarHoras} className="w-full bg-[#0b315f] hover:bg-[#1262bd] text-white text-xs font-bold py-2.5 rounded-xl transition-colors">
              Guardar registro horario
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TARJETA EVENTUAL
// ══════════════════════════════════════════════════════════════════════════════

function TarjetaEventual({ s, onRefresh, onGps, enFicha = false }: { s: ServicioView; onRefresh: () => void; onGps: (s: ServicioView) => void; enFicha?: boolean }) {
  const [expandida,     setExpandida]     = useState(enFicha);
  const [modalGastos,   setModalGastos]   = useState(false);
  const [modalChecklist,setModalChecklist]= useState(false);
  const r           = s.reserva;
  const estado      = ESTADO_VIS[s.estado_visual];
  const totalGastos = s.gastos_total;
  const bloqueado   = s.docs_vencidos.length > 0;

  const toggleFlag = async (campo: keyof Reserva, valor: boolean) => {
    const { error } = await supabase.from("reservas").update({ [campo]: valor }).eq("id", r.id);
    if (error) { alert("Error: "+error.message); return; }
    onRefresh();
  };

  return (
    <>
      {modalGastos    && <ModalGastos reservaId={r.id} vehiculoId={r.vehiculo_id} cliente={s.cliente_nombre} onClose={()=>setModalGastos(false)} onSaved={onRefresh} />}
      {modalChecklist && <ModalChecklist reservaId={r.id} cliente={s.cliente_nombre} onClose={()=>setModalChecklist(false)} onSaved={onRefresh} />}

      <div className={enFicha ? "" : `bg-white rounded-2xl shadow-sm border transition-all duration-200 ${s.estado_visual==="alerta"?"border-red-200":s.seguro_vence_hoy?"border-amber-200":"border-gray-100 hover:border-gray-200"}`}>
        {bloqueado && (
          <div className={`flex items-center gap-2 bg-red-100 border-b border-red-200 px-4 py-2 ${enFicha ? "" : "rounded-t-2xl"}`}>
            <Ic.Shield size={13} color="#b91c1c" />
            <span className="text-red-700 text-xs font-black">⛔ DOCUMENTOS VENCIDOS: {s.docs_vencidos.join(", ")} — No despachar la unidad</span>
          </div>
        )}
        {s.seguro_vence_hoy && (
          <div className={`flex items-center gap-2 bg-amber-50 border-b border-amber-100 px-4 py-2 ${enFicha || bloqueado ? "" : "rounded-t-2xl"}`}>
            <Ic.Shield size={13} color="#d97706" />
            <span className="text-amber-700 text-xs font-bold">⚠ SEGURO DE LA UNIDAD VENCE HOY — No despachar sin renovación</span>
          </div>
        )}
        <div className="p-4">
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center flex-shrink-0">
                <Ic.List size={18} color="#6366f1" strokeWidth={1.8} />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-black text-[#0b315f] text-sm">{s.cliente_nombre}</span>
                  <span className="text-[10px] font-bold bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full">Eventual {idAfa(r)}</span>
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-xs text-gray-400 font-mono font-bold">{s.vehiculo_placa}</span>
                  <span className="text-gray-200">·</span>
                  <span className="text-xs text-gray-500">{s.conductor_nombre}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-[11px] font-black px-2.5 py-1 rounded-full" style={{ color: estado.color, background: estado.bg }}>{estado.label}</span>
              {!enFicha && (
                <button onClick={()=>setExpandida(v=>!v)} className="w-7 h-7 rounded-lg bg-gray-50 hover:bg-gray-100 flex items-center justify-center transition-colors">
                  {expandida ? <Ic.ChevronUp size={13}/> : <Ic.ChevronDown size={13}/>}
                </button>
              )}
            </div>
          </div>

          {s.paradas.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Itinerario</span>
                <span className="text-[10px] font-bold text-[#0b315f]">{s.paradas_completadas}/{s.paradas_total} hitos</span>
              </div>
              <div className="flex items-center gap-1">
                {s.paradas.map((p) => (
                  <div key={p.id} className="flex items-center flex-1">
                    <div className={`flex-1 h-1 rounded-full ${p.estado==="completada"?"bg-green-500":"bg-gray-100"}`}/>
                    <div className={`w-3 h-3 rounded-full flex-shrink-0 border-2 transition-all ${p.estado==="completada"?"bg-green-500 border-green-500":"bg-white border-gray-300"}`}/>
                  </div>
                ))}
              </div>
              {s.paradas.find(p=>p.estado!=="completada") && (
                <p className="text-[11px] text-gray-500 mt-1.5">
                  <span className="font-bold">Próximo: </span>
                  {s.paradas.find(p=>p.estado!=="completada")?.nombre}
                  {s.paradas.find(p=>p.estado!=="completada")?.hora_estimada && ` · ${s.paradas.find(p=>p.estado!=="completada")?.hora_estimada?.slice(0,5)}`}
                </p>
              )}
            </div>
          )}

          <div className="flex items-center gap-1.5 mb-3 flex-wrap">
            <button onClick={()=>toggleFlag("viaticos_entregados",!r.viaticos_entregados)} className={`text-[10px] font-bold px-2 py-1 rounded-lg transition-colors ${r.viaticos_entregados?"bg-green-50 text-green-700 hover:bg-green-100":"bg-red-50 text-red-600 hover:bg-red-100"}`}>
              {r.viaticos_entregados?"✓":"✗"} Viáticos
            </button>
            <button onClick={()=>toggleFlag("documentos_ok",!r.documentos_ok)} className={`text-[10px] font-bold px-2 py-1 rounded-lg transition-colors ${r.documentos_ok?"bg-green-50 text-green-700 hover:bg-green-100":"bg-amber-50 text-amber-700 hover:bg-amber-100"}`}>
              {r.documentos_ok?"✓":"!"} Documentos
            </button>
            <button onClick={()=>toggleFlag("conformidad_firmada",!r.conformidad_firmada)} className={`text-[10px] font-bold px-2 py-1 rounded-lg transition-colors ${r.conformidad_firmada?"bg-green-50 text-green-700 hover:bg-green-100":"bg-gray-50 text-gray-500 hover:bg-gray-100"}`}>
              {r.conformidad_firmada?"✓":"○"} Conformidad
            </button>
            {totalGastos>0 && <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-blue-50 text-blue-700">S/ {totalGastos.toFixed(2)} gastos</span>}
          </div>

          <div className="flex gap-2 flex-wrap">
            {/* GPS */}
            <button onClick={() => onGps(s)}
              className="flex items-center gap-1.5 bg-[#EFF6FF] hover:bg-[#DBEAFE] text-[#1d4ed8] text-xs font-bold px-3 py-2 rounded-xl transition-colors">
              <Ic.Map size={13} color="#1d4ed8"/> GPS en vivo
            </button>
            {/* Manifiesto de pasajeros */}
            <Link href={`/programacion?reserva=${r.id}`}
              className="flex items-center gap-1.5 bg-purple-50 hover:bg-purple-100 text-purple-700 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
              <Ic.FileText size={13} /> Manifiesto
            </Link>
            {/* Gastos */}
            <button onClick={()=>setModalGastos(true)} className="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 text-gray-600 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
              <Ic.DollarSign size={13}/> Gastos{totalGastos>0?` · S/${totalGastos.toFixed(0)}`:""}
            </button>
            {/* Checklist */}
            <button onClick={()=>setModalChecklist(true)} className="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 text-gray-600 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
              <Ic.Check size={13}/> Checklist salida
            </button>
            {s.conductor_tel && (
              <a href={`tel:${s.conductor_tel}`} className="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 text-gray-500 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
                <Ic.Phone size={13}/>
              </a>
            )}
          </div>
        </div>

        {expandida && (
          <div className="border-t border-gray-50 p-4 space-y-4">
            {s.paradas.length>0 && (
              <div>
                <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-3">Timeline completo</p>
                <div className="space-y-2">
                  {s.paradas.map((p,i)=>(
                    <div key={p.id} className="flex items-center gap-3">
                      <div className="flex flex-col items-center">
                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${p.estado==="completada"?"bg-green-500 border-green-500":"bg-white border-gray-200"}`}>
                          {p.estado==="completada"&&<Ic.Check size={10} color="white" strokeWidth={3}/>}
                        </div>
                        {i<s.paradas.length-1&&<div className={`w-0.5 h-5 mt-1 ${p.estado==="completada"?"bg-green-200":"bg-gray-100"}`}/>}
                      </div>
                      <div className="flex-1 flex items-center justify-between">
                        <span className={`text-[13px] font-semibold ${p.estado==="completada"?"text-green-700":"text-gray-500"}`}>{p.nombre}</span>
                        <span className="text-[11px] text-gray-400 font-mono">{p.hora_estimada?.slice(0,5)||"—"}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2">Conformidad del servicio</p>
              <button className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-gray-200 rounded-xl py-3 text-gray-400 text-xs hover:border-[#0b315f] hover:text-[#0b315f] transition-colors">
                <Ic.Camera size={15}/>
                {r.conformidad_firmada?"✓ Conformidad registrada":"Adjuntar foto de conformidad firmada"}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// LISTA (TORRE DE CONTROL) + FICHA EN DRAWER
// ══════════════════════════════════════════════════════════════════════════════

// Chips de alerta para la fila de la lista (resumen de un vistazo; el detalle va en la ficha).
function chipsAlerta(s: ServicioView): { label: string; color: string; bg: string; title: string }[] {
  const out: { label: string; color: string; bg: string; title: string }[] = [];
  if (s.docs_vencidos.length)     out.push({ label: "DOC",      color: "#b91c1c", bg: "#fee2e2", title: `Documentos vencidos: ${s.docs_vencidos.join(", ")}` });
  if (s.estado_visual === "alerta") out.push({ label: "RETRASO",  color: "#dc2626", bg: "#fef2f2", title: "No inició a la hora pactada" });
  if (s.conflicto_vehiculo)       out.push({ label: "UNIDAD×2", color: "#b45309", bg: "#fef3c7", title: "Posible solape: el vehículo está en otro servicio a la misma hora" });
  if (s.conflicto_conductor)      out.push({ label: "CHOFER×2", color: "#b45309", bg: "#fef3c7", title: "Posible solape: el conductor está en otro servicio a la misma hora" });
  if (s.jornada_extensa)          out.push({ label: "JORNADA",  color: "#9a3412", bg: "#ffedd5", title: "Jornada del conductor extensa o demasiados servicios — riesgo de fatiga" });
  if (s.seguro_vence_hoy)         out.push({ label: "SOAT HOY", color: "#dc2626", bg: "#fef2f2", title: "El seguro de la unidad vence hoy" });
  return out;
}

function FilaServicio({ s, onOpen, onGps }: { s: ServicioView; onOpen: () => void; onGps: () => void }) {
  const est      = ESTADO_VIS[s.estado_visual];
  const progreso = s.paradas_total > 0 ? Math.round((s.paradas_completadas / s.paradas_total) * 100) : 0;
  const alertas  = chipsAlerta(s);
  return (
    <div onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="group flex items-center gap-3 px-4 py-3 hover:bg-[#f6f9fd] cursor-pointer transition-colors outline-none focus-visible:bg-[#eef4fb]">
      <div className="w-1.5 h-10 rounded-full flex-shrink-0" style={{ background: est.dot }} />
      <div className="w-12 flex-shrink-0 text-center">
        <div className="font-black text-[#0b315f] text-sm font-mono leading-none">{s.reserva.hora_servicio?.slice(0, 5) || "—"}</div>
        <div className="text-[9px] font-bold uppercase mt-1 leading-none" style={{ color: est.color }}>{est.label.replace("⚠ ", "")}</div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-[#0b315f] text-sm truncate">{s.cliente_nombre}</span>
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${!s.es_eventual ? "bg-[#EFF6FF] text-[#0b315f]" : "bg-indigo-50 text-indigo-600"}`}>{!s.es_eventual ? "Fijo" : "Eventual"}</span>
          <span className="text-[10px] font-black text-gray-400">{idAfa(s.reserva)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
          <span className="font-mono font-bold text-gray-400">{s.vehiculo_placa}</span>
          <span className="text-gray-200">·</span>
          <span className="truncate">{s.conductor_nombre}</span>
        </div>
      </div>
      <div className="hidden sm:flex items-center gap-4 flex-shrink-0">
        <div className="text-center w-14">
          <div className="text-[9px] font-bold uppercase text-gray-400">Check-in</div>
          <div className={`text-xs font-black ${s.reserva.checkin_realizado ? "text-green-600" : "text-gray-300"}`}>{s.reserva.checkin_realizado ? (s.reserva.hora_real_inicio?.slice(0, 5) || "✓") : "—"}</div>
        </div>
        <div className="text-center w-14">
          <div className="text-[9px] font-bold uppercase text-gray-400">Pasaj.</div>
          <div className="text-xs font-black text-[#0b315f]">{s.pasajeros_abordados}<span className="text-gray-300 font-normal">/{s.pasajeros_total_real || "?"}</span></div>
        </div>
        <div className="w-16">
          <div className="text-[9px] font-bold uppercase text-gray-400 text-center mb-1 leading-none">{progreso}%</div>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${progreso}%`, background: progreso === 100 ? "#16a34a" : "#0b315f" }} /></div>
        </div>
      </div>
      {alertas.length > 0 && (
        <div className="hidden md:flex items-center gap-1 flex-shrink-0 max-w-[180px] flex-wrap justify-end">
          {alertas.map((a, i) => (<span key={i} title={a.title} className="text-[9px] font-black px-1.5 py-1 rounded-md whitespace-nowrap" style={{ color: a.color, background: a.bg }}>{a.label}</span>))}
        </div>
      )}
      <div className="flex items-center gap-1.5 flex-shrink-0" onClick={e => e.stopPropagation()}>
        <button onClick={onGps} title="GPS en vivo" className="flex items-center gap-1 bg-[#EFF6FF] hover:bg-[#DBEAFE] text-[#1d4ed8] text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition-colors">
          <Ic.Map size={11} color="#1d4ed8" /><span className="hidden lg:inline">GPS</span>
        </button>
        <Ic.ChevronDown size={15} className="-rotate-90 text-gray-300 group-hover:text-[#0b315f] transition-colors" />
      </div>
    </div>
  );
}

// ── Documentos del servicio (Manifiesto MTC / Reporte) ────────────────────────
// Carga LAZY por reserva del roster nominal + licencia + RUC. NO va en el batch diario
// cargar(): esos datos (nombre/DNI/edad + PII) solo se traen al abrir un servicio y se
// cachean. Réplica del patrón cargarDetalle del portal cliente, con edad resiliente.
type EmpresaPerfil = { nombre: string|null; logo_url: string|null; telefono: string|null; email: string|null };
type DocDatos = {
  roster: DocPasajero[];
  conductor: { nombre: string|null; licencia: string|null } | null;
  clienteRuc: string|null;
  esTer: boolean;
};

async function cargarDocDatos(s: ServicioView): Promise<DocDatos> {
  const r = s.reserva;
  const esTer = r.tipo === "tercerizada";
  const paradaIds = s.paradas.map(p => p.id);

  // NO pedir "edad" en el join: si la columna faltara, PostgREST devuelve error y el
  // roster queda vacío (bug "Esperados 0"). La edad se lee aparte, tolerante a fallo.
  const [ppRes, paxRes] = await Promise.all([
    paradaIds.length
      // select("*, …") como en el portal cliente: no nombrar las columnas del abordaje evita
      // que una columna ausente en algún entorno tumbe TODO el select y vacíe el roster.
      ? supabase.from("pasajeros_parada").select("*, pasajero:pasajeros(nombre,dni)").in("parada_id", paradaIds)
      : Promise.resolve({ data: [] as any[] }),
    supabase.from("pasajeros").select("id,nombre,dni").eq("reserva_id", r.id),
  ]);
  const ppRaw = ((ppRes as any).data as any[]) || [];
  // Deduplicar por pasajero_id: un pasajero puede tener fila en 2+ paradas de la misma
  // reserva; el manifiesto legal (N° Asiento) no debe listarlo dos veces. Se conserva
  // preferentemente la fila ABORDADA si la hay.
  const porPax = new Map<number, any>();
  for (const x of ppRaw) {
    const prev = porPax.get(x.pasajero_id);
    if (!prev || (!esAbordado(prev) && esAbordado(x))) porPax.set(x.pasajero_id, x);
  }
  const pp = [...porPax.values()];
  // Pasajeros sin paradero (existen en pasajeros.reserva_id pero sin fila en pasajeros_parada):
  // entradas sintéticas (parada_id null) para que cuenten y salgan en el documento.
  const asignados = new Set(pp.map(x => x.pasajero_id));
  const sinParada = (((paxRes as any).data as any[]) || [])
    .filter(p => !asignados.has(p.id))
    .map(p => ({ parada_id: null, pasajero_id: p.id, estado: "Pendiente", estado_abordaje: null, hora_abordaje: null, pasajero: { nombre: p.nombre, dni: p.dni } }));
  const roster: DocPasajero[] = [...pp, ...sinParada];

  // Edad para el Manifiesto MTC — consulta AISLADA: si la columna no existe, falla sola
  // y el manifiesto muestra "–" sin vaciar el roster.
  const idsPax = [...new Set(roster.map(x => x.pasajero_id).filter(Boolean))];
  if (idsPax.length > 0) {
    const { data: edades } = await supabase.from("pasajeros").select("id,edad").in("id", idsPax);
    if (edades) {
      const em = new Map((edades as any[]).map(e => [e.id, e.edad]));
      roster.forEach(x => { if (x.pasajero) (x.pasajero as any).edad = em.get(x.pasajero_id) ?? null; });
    }
  }

  // Conductor + licencia: propio (conductores.numero_licencia) o tercerizado
  // (conductores_tercero.licencia — columna distinta, mismo dato).
  let conductor: { nombre: string|null; licencia: string|null } | null = null;
  if (!esTer && r.conductor_id) {
    const { data } = await supabase.from("conductores").select("nombre,numero_licencia").eq("id", r.conductor_id).maybeSingle();
    if (data) conductor = { nombre: (data as any).nombre ?? null, licencia: (data as any).numero_licencia ?? null };
  } else if (esTer && (r as any).conductor_tercero_id) {
    const { data } = await supabase.from("conductores_tercero").select("nombre,licencia").eq("id", (r as any).conductor_tercero_id).maybeSingle();
    if (data) conductor = { nombre: (data as any).nombre ?? null, licencia: (data as any).licencia ?? null };
  }

  // RUC del cliente para la cabecera fiscal del reporte.
  let clienteRuc: string|null = null;
  if (r.cliente_id) {
    const { data } = await supabase.from("clientes").select("ruc").eq("id", r.cliente_id).maybeSingle();
    if (data) clienteRuc = (data as any).ruc ?? null;
  }

  return { roster, conductor, clienteRuc, esTer };
}

function DocBar({ s, empresaPerfil, onGps }: { s: ServicioView; empresaPerfil: EmpresaPerfil|null; onGps: (s: ServicioView) => void }) {
  const [datos,  setDatos]  = useState<DocDatos | null>(null);
  const [estado, setEstado] = useState<"cargando"|"listo"|"error">("cargando");
  const [verRoster, setVerRoster] = useState(false);

  const rid = s.reserva.id;
  useEffect(() => {
    let vivo = true;
    setEstado("cargando"); setDatos(null); setVerRoster(false);
    cargarDocDatos(s)
      .then(d => { if (vivo) { setDatos(d); setEstado("listo"); } })
      .catch(() => { if (vivo) setEstado("error"); });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rid, s.pasajeros_total_real]);

  const r = s.reserva;
  const cargando = estado === "cargando";
  const placaOk = s.vehiculo_placa && s.vehiculo_placa !== "—" ? s.vehiculo_placa : null;
  const rosterVacio = !datos || datos.roster.length === 0;
  const cancelado = r.estado === "cancelada";
  // El Manifiesto MTC es un documento legal del viaje: NO emitirlo para un servicio anulado.
  const puedeManifiesto = !cargando && !rosterVacio && !cancelado;
  const puedeReporte = r.estado === "en_curso" || r.estado === "finalizada";

  const servicioBase = {
    // Las paradas mandan sobre r.origen/r.destino (copia denormalizada que puede quedar desfasada).
    fecha: r.fecha_servicio, hora: r.hora_servicio,
    origen:  s.paradas[0]?.nombre ?? r.origen ?? "",
    destino: (s.paradas.length > 1 ? s.paradas[s.paradas.length - 1].nombre : null) ?? r.destino ?? "",
  };

  function imprimirManifiesto() {
    if (!datos) return;
    abrirImprimible(manifiestoMtcHTML({
      empresa: { logoUrl: empresaPerfil?.logo_url ?? null },
      cliente: { nombre: s.cliente_nombre },
      servicio: servicioBase,
      conductor: datos.conductor,
      vehiculo: { placa: placaOk },
      pasajeros: datos.roster,
      boarding: [],
    }));
  }

  function imprimirReporte() {
    if (!datos) return;
    // hora_real_inicio/fin son horas del día ("HH:MM:SS"/"HH:MM"), NO timestamps: se parsean
    // como minutos del día para la duración y se imprimen recortadas tal cual (no con fmtTs).
    const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
    const ini = r.hora_real_inicio || null;
    const fin = r.hora_real_fin || null;
    const hayOp = !!(ini || fin || (s.gastos_total || 0) > 0);
    const duracionMin = (ini && fin) ? Math.max(0, toMin(fin) - toMin(ini)) : null;
    abrirImprimible(reporteServicioHTML({
      empresa: {
        nombre: empresaPerfil?.nombre ?? null,
        telefono: empresaPerfil?.telefono ?? null,
        email: empresaPerfil?.email ?? null,
        logoReporteUrl: window.location.origin + "/logoafacotizacion-removebg-preview.png",
        firmaUrl: window.location.origin + "/firmaJLCA.png",
      },
      cliente: { nombre: s.cliente_nombre, ruc: datos.clienteRuc },
      servicio: servicioBase,
      paradas: s.paradas.map(p => ({ id: p.id, orden: p.orden, nombre: p.nombre, hora_estimada: p.hora_estimada })),
      pasajeros: datos.roster,
      boarding: [],
      operativo: hayOp ? {
        horaRealInicio: ini ? ini.slice(0, 5) : null,
        horaRealFin: fin ? fin.slice(0, 5) : null,
        duracionMin,
        gastosTotal: s.gastos_total ?? null,
        gpsUrl: null,
      } : null,
    }));
  }

  const btnBase = "flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-black text-[#0b315f] uppercase tracking-wide">Documentos del servicio</span>
        {cargando && <span className="text-[10px] text-gray-400 font-semibold">Cargando datos…</span>}
        {estado === "listo" && !rosterVacio && <span className="text-[10px] text-gray-400 font-mono">{datos!.roster.length} pasajero{datos!.roster.length !== 1 ? "s" : ""}</span>}
        {estado === "error" && <span className="text-[10px] text-red-500 font-semibold">Error al cargar</span>}
      </div>
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setVerRoster(v => !v)} disabled={cargando || rosterVacio}
          title={rosterVacio ? "Sin pasajeros registrados" : "Ver la lista de pasajeros"}
          className={`${btnBase} bg-gray-50 hover:bg-gray-100 text-gray-700`}>
          <Ic.FileText size={13} /> {verRoster ? "Ocultar" : "Ver manifiesto"}
        </button>
        <button onClick={imprimirManifiesto} disabled={!puedeManifiesto}
          title={cancelado ? "Servicio cancelado: no se emite Manifiesto MTC" : rosterVacio ? "Sin pasajeros registrados" : "Imprimir Manifiesto MTC (R.D. 1946-2009-MTC-15)"}
          className={`${btnBase} bg-[#E3F1E6] hover:bg-[#cfe8d4] text-[#15803d]`}>
          <Ic.FileText size={13} color="#15803d" /> Manifiesto MTC
        </button>
        <button onClick={imprimirReporte} disabled={cargando || !puedeReporte}
          title={!puedeReporte ? "Disponible cuando el servicio está en curso o finalizado" : "Imprimir Reporte de Servicio"}
          className={`${btnBase} bg-[#EAEFF6] hover:bg-[#dbe4f0] text-[#0b315f]`}>
          <Ic.FileText size={13} color="#0b315f" /> Reporte de Servicio{r.estado === "en_curso" ? " · preliminar" : ""}
        </button>
        <button onClick={() => onGps(s)}
          className={`${btnBase} bg-[#EFF6FF] hover:bg-[#DBEAFE] text-[#1d4ed8]`}>
          <Ic.Map size={13} color="#1d4ed8" /> Recorrido GPS
        </button>
      </div>

      {datos?.esTer && (
        <p className="text-[10.5px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-2 leading-snug">
          <b>Servicio tercerizado:</b> el Manifiesto MTC no incluye conductor ni licencia (no hay ese dato del operador tercero). Se imprime con “–” para completar a mano si SUTRAN lo requiere.
        </p>
      )}

      {verRoster && datos && (
        <div className="mt-2 border-t border-gray-100 pt-2 max-h-64 overflow-y-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-gray-400 text-[9px] uppercase tracking-wide">
                <th className="text-left font-bold py-1 w-6">#</th>
                <th className="text-left font-bold py-1">Pasajero</th>
                <th className="text-left font-bold py-1">DNI</th>
                <th className="text-center font-bold py-1 w-10">Edad</th>
                <th className="text-center font-bold py-1 w-14">Abordó</th>
              </tr>
            </thead>
            <tbody>
              {datos.roster.map((x, i) => (
                <tr key={`${x.pasajero_id}-${i}`} className="border-t border-gray-50">
                  <td className="py-1 text-gray-400 font-mono">{i + 1}</td>
                  <td className="py-1 text-gray-800 font-semibold">{x.pasajero?.nombre || `#${x.pasajero_id}`}</td>
                  <td className="py-1 text-gray-500 font-mono text-[10px]">{x.pasajero?.dni || "–"}</td>
                  <td className="py-1 text-center text-gray-500">{(x.pasajero as any)?.edad ?? "–"}</td>
                  <td className="py-1 text-center">
                    {esAbordado(x)
                      ? <span className="text-[9px] font-bold text-green-700">✓</span>
                      : <span className="text-[9px] text-gray-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FichaServicio({ s, onClose, onRefresh, onGps, empresaPerfil }: { s: ServicioView; onClose: () => void; onRefresh: () => void; onGps: (s: ServicioView) => void; empresaPerfil: EmpresaPerfil|null }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const est = ESTADO_VIS[s.estado_visual];
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative h-full w-full max-w-lg bg-[#eef3f8] shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-100 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[11px] font-black px-2 py-0.5 rounded-full flex-shrink-0" style={{ color: est.color, background: est.bg }}>{est.label}</span>
            <span className="font-black text-[#0b315f] text-sm flex-shrink-0">{idAfa(s.reserva)}</span>
            <span className="text-xs text-gray-400 font-mono flex-shrink-0">{s.reserva.hora_servicio?.slice(0, 5) || "—"}</span>
            <span className="text-xs text-gray-500 truncate">· {s.cliente_nombre}</span>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 flex items-center justify-center flex-shrink-0"><Ic.X size={15} /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <DocBar s={s} empresaPerfil={empresaPerfil} onGps={onGps} />
          {s.es_eventual
            ? <TarjetaEventual s={s} onRefresh={onRefresh} onGps={onGps} enFicha />
            : <TarjetaFija     s={s} onRefresh={onRefresh} onGps={onGps} enFicha />}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PÁGINA PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════

export default function SeguimientoPage() {
  const [reservas,    setReservas]    = useState<Reserva[]>([]);
  const [clientes,    setClientes]    = useState<Cliente[]>([]);
  const [vehiculos,   setVehiculos]   = useState<Vehiculo[]>([]);
  const [conductores, setConductores] = useState<Conductor[]>([]);
  const [empresas,    setEmpresas]    = useState<EmpTer[]>([]);
  const [vehsTer,     setVehsTer]     = useState<VehTer[]>([]);
  const [paradas,     setParadas]     = useState<Parada[]>([]);
  const [pasajPar,    setPasajPar]    = useState<{parada_id:number; pasajero_id:number; estado?:string|null; estado_abordaje?:string|null}[]>([]);
  const [paxAdhoc,    setPaxAdhoc]    = useState<{id:number; reserva_id:number}[]>([]);
  const [gastosRows,  setGastosRows]  = useState<{reserva_id:number; monto:number}[]>([]);
  const [docsTer,     setDocsTer]     = useState<DocTer[]>([]);
  const [docsVeh,     setDocsVeh]     = useState<DocVeh[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [fechaFiltro, setFechaFiltro] = useState(hoyISO());
  const [filtroTipo,  setFiltroTipo]  = useState<"todos"|"fijo"|"eventual">("todos");
  const [filtroEstado,setFiltroEstado]= useState<"todos"|EstadoVisual>("todos");
  const [busqueda,    setBusqueda]    = useState("");
  const [gpsModal,    setGpsModal]    = useState<ServicioView | null>(null);
  const [drawer,      setDrawer]      = useState<ServicioView | null>(null);
  const [descargaMasiva, setDescargaMasiva] = useState(false);
  const [empresaPerfil, setEmpresaPerfil] = useState<EmpresaPerfil | null>(null);

  // Cabecera de los documentos (logo/nombre/contacto AFA). Una sola vez por página.
  useEffect(() => {
    supabase.from("empresa_perfil").select("nombre,logo_url,telefono,email").eq("id", 1).maybeSingle()
      .then(({ data }) => { if (data) setEmpresaPerfil(data as EmpresaPerfil); });
  }, []);

  const cargar = useCallback(async () => {
    setLoading(true);
    const [rRes,clRes,vRes,cRes,etRes,vtRes,dtRes] = await Promise.all([
      supabase.from("reservas").select("*").eq("fecha_servicio",fechaFiltro).in("estado",["programada","confirmada","en_curso","finalizada","cancelada"]).order("hora_servicio",{ascending:true}),
      supabase.from("clientes").select("id,nombre,empresa"),
      supabase.from("vehiculos").select("id,placa,capacidad_pasajeros"),
      supabase.from("conductores").select("id,nombre,telefono"),
      supabase.from("empresas_tercerizadas").select("id,razon_social,telefono"),
      supabase.from("vehiculos_tercero").select("id,placa"),
      supabase.from("documentos_tercero").select("id,empresa_id,tipo,fecha_vencimiento"),
    ]);
    const reservasData = (rRes.data as Reserva[])||[];
    setReservas(reservasData); setClientes((clRes.data as Cliente[])||[]);
    setVehiculos((vRes.data as Vehiculo[])||[]); setConductores((cRes.data as Conductor[])||[]);
    setEmpresas((etRes.data as EmpTer[])||[]); setVehsTer((vtRes.data as VehTer[])||[]);
    setDocsTer((dtRes.data as DocTer[])||[]);

    const reservaIds = reservasData.map(r => r.id);
    if (reservaIds.length > 0) {
      const { data: parData } = await supabase.from("paradas").select("*").in("reserva_id",reservaIds).order("orden");
      setParadas((parData as Parada[])||[]);
      const paradaIds = (parData||[]).map((p:any)=>p.id);
      // Abordaje real (estado + estado_abordaje), roster ad-hoc y gastos: todo en lote (sin N+1 por tarjeta).
      const [ppRes, paxRes, gastosRes] = await Promise.all([
        paradaIds.length
          ? supabase.from("pasajeros_parada").select("parada_id,pasajero_id,estado,estado_abordaje").in("parada_id",paradaIds)
          : Promise.resolve({ data: [] as any[] }),
        supabase.from("pasajeros").select("id,reserva_id").in("reserva_id",reservaIds),
        supabase.from("gastos").select("reserva_id,monto").in("reserva_id",reservaIds),
      ]);
      setPasajPar(ppRes.data||[]); setPaxAdhoc(paxRes.data||[]); setGastosRows(gastosRes.data||[]);
    } else { setParadas([]); setPasajPar([]); setPaxAdhoc([]); setGastosRows([]); }

    try {
      const { data: docVehData } = await supabase.from("documentos_vehiculo").select("id,vehiculo_id,tipo,fecha_vencimiento");
      setDocsVeh((docVehData as DocVeh[])||[]);
    } catch { setDocsVeh([]); }

    setLoading(false);
  }, [fechaFiltro]);

  useEffect(()=>{ cargar(); },[cargar]);

  useEffect(()=>{
    const ch = supabase.channel("seguimiento-reservas")
      .on("postgres_changes",{event:"*",schema:"public",table:"reservas"},()=>cargar())
      .on("postgres_changes",{event:"*",schema:"public",table:"paradas"},()=>cargar())
      .subscribe();
    return ()=>{ supabase.removeChannel(ch); };
  },[cargar]);

  const serviciosBase: ServicioView[] = useMemo(()=>{
    // Roster y abordaje (unión A∪B, deduped por pasajero_id) calculado una vez para todos los servicios.
    const paradaToReserva = new Map<number, number>();
    paradas.forEach(p => paradaToReserva.set(p.id, p.reserva_id));
    const esperados: Record<number, Set<number>> = {};
    const abordados: Record<number, Set<number>> = {};
    const ensure = (rid:number) => { (esperados[rid] ||= new Set()); (abordados[rid] ||= new Set()); };
    paxAdhoc.forEach(p => { ensure(p.reserva_id); esperados[p.reserva_id].add(p.id); });
    pasajPar.forEach(pp => {
      const rid = paradaToReserva.get(pp.parada_id); if (rid == null) return;
      ensure(rid); esperados[rid].add(pp.pasajero_id);
      if (esAbordado(pp)) abordados[rid].add(pp.pasajero_id);
    });
    const gastosPorReserva: Record<number, number> = {};
    gastosRows.forEach(g => { gastosPorReserva[g.reserva_id] = (gastosPorReserva[g.reserva_id]||0) + Number(g.monto||0); });

    return reservas.map(r=>{
      const cliente        = clientes.find(c=>c.id===r.cliente_id);
      const cliente_nombre = cliente?.empresa||cliente?.nombre||"Sin cliente";
      const esTer          = r.tipo==="tercerizada";
      const vehiculo_placa = esTer?(vehsTer.find(v=>v.id===r.vehiculo_tercero_id)?.placa||"—"):(vehiculos.find(v=>v.id===r.vehiculo_id)?.placa||"—");
      const empresa        = esTer ? empresas.find(e=>e.id===r.empresa_tercerizada_id) : null;
      const conductor      = !esTer ? conductores.find(c=>c.id===r.conductor_id) : null;
      const conductor_nombre = esTer?(empresa?.razon_social||"Tercero"):(conductor?.nombre||"—");
      const conductor_tel    = esTer?(empresa?.telefono||""):(conductor?.telefono||"");
      const paradasR         = paradas.filter(p=>p.reserva_id===r.id);
      const esperadosN       = esperados[r.id]?.size || 0;
      const seguro_vence_hoy = esTer ? riesgoEmpresaDocs(docsTer,r.empresa_tercerizada_id) : seguroVehiculoVenceHoy(docsVeh,r.vehiculo_id);
      const docs_vencidos    = esTer ? docsVencidosEmpresa(docsTer,r.empresa_tercerizada_id) : docsVencidosVehiculo(docsVeh,r.vehiculo_id);
      return {
        reserva: r, cliente_nombre, vehiculo_placa, conductor_nombre, conductor_tel,
        es_eventual: esEventual(r), estado_visual: calcularEstadoVisual(r),
        paradas: paradasR, paradas_total: paradasR.length,
        paradas_completadas: paradasR.filter(p=>p.estado==="completada").length,
        pasajeros_total: esperadosN||(vehiculos.find(v=>v.id===r.vehiculo_id)?.capacidad_pasajeros||0),
        pasajeros_abordados: abordados[r.id]?.size || 0,
        pasajeros_total_real: esperadosN, seguro_vence_hoy,
        gastos_total: gastosPorReserva[r.id]||0, docs_vencidos,
      };
    });
  },[reservas,clientes,vehiculos,conductores,empresas,vehsTer,paradas,pasajPar,paxAdhoc,gastosRows,docsTer,docsVeh]);

  // Segundo paso: alertas que dependen de TODOS los servicios del día (solape de recurso, jornada).
  const servicios: ServicioView[] = useMemo(()=>{
    const { vehiculo, conductor, fatiga } = detectarAlertasFlota(serviciosBase);
    return serviciosBase.map(s => ({
      ...s,
      conflicto_vehiculo:  vehiculo.has(s.reserva.id),
      conflicto_conductor: conductor.has(s.reserva.id),
      jornada_extensa:     fatiga.has(s.reserva.id),
    }));
  },[serviciosBase]);

  // El drawer guarda una instantánea; al recargar datos, refrescarla con la versión vigente.
  useEffect(() => {
    setDrawer(prev => prev ? (servicios.find(s => s.reserva.id === prev.reserva.id) ?? prev) : prev);
  }, [servicios]);

  // Ir al detalle de un servicio desde el panel de mensajes de pasajeros.
  const [pendienteReserva, setPendienteReserva] = useState<number | null>(null);
  const irAServicio = useCallback((reservaId: number, fechaServicio?: string | null) => {
    const encontrado = servicios.find(s => s.reserva.id === reservaId);
    if (encontrado) { setDrawer(encontrado); return; }
    // El servicio es de otra fecha: cambia el filtro y lo abre cuando termine de cargar.
    if (fechaServicio) setFechaFiltro(fechaServicio);
    setPendienteReserva(reservaId);
  }, [servicios]);

  // Cuando cargan los servicios de la fecha destino, abre el pendiente.
  useEffect(() => {
    if (pendienteReserva == null) return;
    const encontrado = servicios.find(s => s.reserva.id === pendienteReserva);
    if (encontrado) { setDrawer(encontrado); setPendienteReserva(null); }
  }, [servicios, pendienteReserva]);

  const totalFijos      = servicios.filter(s=>!s.es_eventual).length;
  const totalEventuales = servicios.filter(s=>s.es_eventual).length;
  const enRuta          = servicios.filter(s=>s.estado_visual==="en_ruta").length;
  const alertas         = servicios.filter(s=>s.estado_visual==="alerta").length;
  const sinCheckin      = servicios.filter(s=>!s.reserva.checkin_realizado&&s.estado_visual!=="finalizado"&&s.estado_visual!=="cancelado").length;
  const seguroHoy       = servicios.filter(s=>s.seguro_vence_hoy).length;
  const docsVenc        = servicios.filter(s=>s.docs_vencidos.length>0).length;
  const conflictos      = servicios.filter(s=>s.conflicto_vehiculo||s.conflicto_conductor).length;
  const fatigaCount     = servicios.filter(s=>s.jornada_extensa).length;

  // ModalGps redibuja la ruta con Google Directions cada vez que cambia la IDENTIDAD del array
  // `paradas`. Como esta página se re-renderiza en cada evento realtime de reservas/paradas,
  // un .map() inline facturaba una llamada por render. Firma primitiva + useMemo: la identidad
  // solo cambia si cambian de verdad las paradas del servicio abierto.
  const firmaParadasGps = (gpsModal?.paradas ?? [])
    .map(p=>`${p.id}:${p.orden}:${p.lat ?? ""}:${p.lng ?? ""}:${p.estado}:${p.hora_estimada ?? ""}:${p.nombre}`)
    .join("|");
  const paradasGps = useMemo(()=>(gpsModal?.paradas ?? []).map(p=>({
    id: p.id, nombre: p.nombre,
    lat: p.lat ?? null, lng: p.lng ?? null,
    hora_estimada: p.hora_estimada ?? null,
    estado: p.estado, orden: p.orden,
  })),[firmaParadasGps]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtrados = servicios.filter(s=>{
    if (filtroTipo==="fijo"&&s.es_eventual) return false;
    if (filtroTipo==="eventual"&&!s.es_eventual) return false;
    if (filtroEstado!=="todos"&&s.estado_visual!==filtroEstado) return false;
    if (busqueda) {
      const q=busqueda.toLowerCase();
      return s.vehiculo_placa.toLowerCase().includes(q)||s.conductor_nombre.toLowerCase().includes(q)||s.cliente_nombre.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-[#eef3f8]">
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* ── ENCABEZADO ── */}
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-black text-[#0b315f] leading-none">Seguimiento Operativo</h1>
            <p className="text-sm text-gray-400 mt-1 font-medium">
              {new Date(fechaFiltro+"T00:00:00").toLocaleDateString("es-PE",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input type="date" value={fechaFiltro} onChange={e=>setFechaFiltro(e.target.value)}
              className="border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f]" />
            <button onClick={cargar} className="w-10 h-10 rounded-xl bg-white border border-gray-200 hover:border-[#0b315f] flex items-center justify-center transition-colors" title="Refrescar">
              <Ic.Refresh size={15} color="#0b315f"/>
            </button>
            {/* ── MENSAJES PASAJEROS ── */}
            <PanelMensajesPasajeros onIrAServicio={irAServicio} />
            {/* ── DESCARGA MASIVA DE DOCUMENTOS ── */}
            <button onClick={()=>setDescargaMasiva(true)}
              className="flex items-center gap-2 bg-white border border-gray-200 hover:border-[#0b315f] text-[#0b315f] px-4 py-2.5 rounded-xl text-sm font-bold transition-colors shadow-sm"
              title="Descargar Manifiestos MTC y Reportes en bloque, agrupados por ruta">
              <Ic.FileText size={15} color="#0b315f"/> Descarga masiva
            </button>
            {/* ── MAPA GLOBAL ── */}
            <Link href="/monitoreo" className="flex items-center gap-2 bg-[#0b315f] text-white px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-[#1262bd] transition-colors shadow-sm">
              <Ic.Map size={15} color="white"/> Ver Mapa Global <Ic.ExternalLink size={13} color="white"/>
            </Link>
          </div>
        </div>

        {/* ── KPIs ── */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label:"Fijos del día",      value:totalFijos,      color:"#0b315f",bg:"#EFF6FF",icon:<Ic.Bus size={16} color="#0b315f"/>    },
            { label:"Eventuales",         value:totalEventuales, color:"#6366f1",bg:"#EEF2FF",icon:<Ic.List size={16} color="#6366f1"/>   },
            { label:"En ruta ahora",      value:enRuta,          color:"#16a34a",bg:"#DCFCE7",icon:<Ic.Check size={16} color="#16a34a"/>  },
            { label:"Alertas retraso",    value:alertas,         color:"#dc2626",bg:"#FEF2F2",icon:<Ic.Alert size={16} color="#dc2626"/>  },
            { label:"Sin check-in",       value:sinCheckin,      color:"#d97706",bg:"#FEF3C7",icon:<Ic.Clock size={16} color="#d97706"/>  },
            { label:"Seguros vencen hoy", value:seguroHoy,       color:"#dc2626",bg:"#FEF2F2",icon:<Ic.Shield size={16} color="#dc2626"/>},
          ].map(kpi=>(
            <div key={kpi.label} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{background:kpi.bg}}>{kpi.icon}</div>
              </div>
              <div className="font-black text-2xl leading-none" style={{color:kpi.color}}>{kpi.value}</div>
              <div className="text-[11px] text-gray-400 font-semibold mt-1 leading-tight">{kpi.label}</div>
            </div>
          ))}
        </div>

        {alertas > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-3.5 flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-red-100 flex items-center justify-center flex-shrink-0"><Ic.Alert size={16} color="#dc2626"/></div>
            <div>
              <p className="font-black text-red-700 text-sm">{alertas} servicio(s) en alerta — no iniciaron a la hora pactada</p>
              <p className="text-red-500 text-xs mt-0.5">Contactar al conductor o despachar unidad de reemplazo inmediatamente</p>
            </div>
          </div>
        )}

        {(conflictos > 0 || fatigaCount > 0 || docsVenc > 0) && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3.5 flex items-start gap-3">
            <div className="w-8 h-8 rounded-xl bg-amber-100 flex items-center justify-center flex-shrink-0"><Ic.Shield size={16} color="#b45309"/></div>
            <div className="text-sm">
              <p className="font-black text-amber-800">Riesgos de flota detectados</p>
              <p className="text-amber-700 text-xs mt-0.5">
                {[
                  docsVenc>0    ? `${docsVenc} con documentos vencidos`            : null,
                  conflictos>0  ? `${conflictos} con posible solape de unidad/conductor` : null,
                  fatigaCount>0 ? `${fatigaCount} con jornada extensa del conductor`     : null,
                ].filter(Boolean).join("  ·  ")}
              </p>
              <p className="text-amber-600/80 text-[11px] mt-1">Documentos vencidos bloquean la salida. El solape y la jornada son estimaciones (no hay duración registrada en la reserva): verifícalos en cada servicio marcado.</p>
            </div>
          </div>
        )}

        {/* ── FILTROS ── */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1">
              <Ic.Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none"/>
              <input className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:border-[#0b315f] transition-colors"
                placeholder="Buscar por placa, conductor o cliente..." value={busqueda} onChange={e=>setBusqueda(e.target.value)}/>
            </div>
            <div className="flex gap-1 bg-gray-50 rounded-xl p-1">
              {(["todos","fijo","eventual"] as const).map(t=>(
                <button key={t} onClick={()=>setFiltroTipo(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${filtroTipo===t?"bg-white shadow-sm text-[#0b315f]":"text-gray-400 hover:text-gray-600"}`}>
                  {t==="todos"?"Todos":t==="fijo"?"Fijos":"Eventuales"}
                </button>
              ))}
            </div>
            <div className="flex gap-1 bg-gray-50 rounded-xl p-1">
              {(["todos","programado","en_ruta","alerta","finalizado"] as const).map(e=>(
                <button key={e} onClick={()=>setFiltroEstado(e)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${filtroEstado===e?"bg-white shadow-sm text-[#0b315f]":"text-gray-400 hover:text-gray-600"}`}>
                  {e==="todos"?"Todos":ESTADO_VIS[e as EstadoVisual]?.label??e}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── CONTENIDO ── */}
        {loading ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-12 text-center">
            <div className="w-8 h-8 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin mx-auto mb-3"/>
            <p className="font-bold text-gray-500 text-sm">Cargando servicios...</p>
          </div>
        ) : filtrados.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-12 text-center">
            <p className="text-4xl mb-3">🔍</p>
            <p className="font-bold text-gray-600">Sin servicios para los filtros seleccionados</p>
            <p className="text-sm text-gray-400 mt-1">
              {reservas.length===0
                ? <>No hay reservas para el {new Date(fechaFiltro+"T00:00:00").toLocaleDateString("es-PE")}. Programa servicios desde <Link href="/programacion" className="text-[#0b315f] font-bold underline">Programación</Link>.</>
                : "Intenta cambiar el tipo, estado o búsqueda."}
            </p>
          </div>
        ) : (
          <section>
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-[#EFF6FF] flex items-center justify-center"><Ic.List size={16} color="#0b315f"/></div>
                  <div>
                    <h2 className="font-black text-[#0b315f] text-sm leading-none">Servicios del día</h2>
                    <p className="text-[11px] text-gray-400 mt-1">Toca un servicio para ver el detalle: GPS, manifiesto, gastos, checklist y reemplazo</p>
                  </div>
                </div>
                <span className="text-xs text-gray-400 font-semibold">{filtrados.length} de {servicios.length}</span>
              </div>
              <div className="divide-y divide-gray-50">
                {[...filtrados].sort((a,b)=>(a.reserva.hora_servicio||"").localeCompare(b.reserva.hora_servicio||"")).map(s=>(
                  <FilaServicio key={s.reserva.id} s={s} onOpen={()=>setDrawer(s)} onGps={()=>setGpsModal(s)} />
                ))}
              </div>
            </div>
          </section>
        )}
      </div>

      {/* ── MODAL GPS ── */}
      {gpsModal && (
        <ModalGps
          reservaId={gpsModal.reserva.id}
          vehiculoId={gpsModal.reserva.vehiculo_id ?? null}
          vehiculoTerceroId={gpsModal.reserva.vehiculo_tercero_id ?? null}
          vehiculoPlaca={gpsModal.vehiculo_placa}
          conductorNombre={gpsModal.conductor_nombre}
          conductorTel={gpsModal.conductor_tel}
          clienteNombre={gpsModal.cliente_nombre}
          origen={gpsModal.paradas[0]?.nombre ?? gpsModal.reserva.origen ?? null}
          destino={(gpsModal.paradas.length > 1 ? gpsModal.paradas[gpsModal.paradas.length - 1].nombre : null) ?? gpsModal.reserva.destino ?? null}
          paradas={paradasGps}
          onClose={() => setGpsModal(null)}
        />
      )}

      {/* ── DRAWER: FICHA DEL SERVICIO ── */}
      {drawer && (
        // La ficha nueva deriva el horario real y el estado documental (lib/servicio-tiempos.ts,
        // lib/documentos-estado.ts) en vez de pedirlos tecleados. La tarjeta clasica viaja como
        // `children`: vive dentro de un acordeon cerrado y conserva gastos, checklist, reemplazo y
        // telefono, que siguen definidos en este archivo. Deuda consciente: cuando esos modales se
        // muevan a su propio componente, el acordeon desaparece y con el los ultimos duplicados.
        <FichaServicioNueva s={drawer} onClose={() => setDrawer(null)} onRefresh={cargar} onGps={setGpsModal} empresaPerfil={empresaPerfil}>
          {drawer.es_eventual
            ? <TarjetaEventual s={drawer} onRefresh={cargar} onGps={setGpsModal} enFicha />
            : <TarjetaFija     s={drawer} onRefresh={cargar} onGps={setGpsModal} enFicha />}
        </FichaServicioNueva>
      )}

      {/* ── MODAL: DESCARGA MASIVA POR RUTA ── */}
      {descargaMasiva && (
        <DescargaMasivaModal fechaInicial={fechaFiltro} onClose={() => setDescargaMasiva(false)} />
      )}
    </div>
  );
}