"use client";
import { useState, useEffect } from "react";
import Link from "next/link";

// ─── TIPOS ─────────────────────────────────────────────────────────────────

type TipoServicio = "fijo" | "eventual";
type EstadoServicio = "programado" | "en_ruta" | "finalizado" | "alerta";

type Hito = { id: number; label: string; hora?: string; completado: boolean };

type GastoViaje = { concepto: string; monto: number };

type Servicio = {
  id: string;
  tipo: TipoServicio;
  estado: EstadoServicio;
  cliente: string;
  ruta_codigo?: string;
  vehiculo: string;
  vehiculo_id: number;
  conductor: string;
  conductor_tel: string;
  hora_estimada: string;
  hora_real_inicio?: string;
  hora_real_fin?: string;
  pasajeros_total?: number;
  pasajeros_abordados?: number;
  paradas_completadas?: number;
  paradas_total?: number;
  unidad_reemplazo?: string;
  checkin_realizado: boolean;
  // Eventual
  hitos?: Hito[];
  gastos?: GastoViaje[];
  viaticos_entregados?: boolean;
  contacto_responsable?: string;
  contacto_tel?: string;
  documentos_ok?: boolean;
  conformidad_firmada?: boolean;
  seguro_vence_hoy?: boolean;
};

// ─── DATA MOCK ─────────────────────────────────────────────────────────────

const SERVICIOS_MOCK: Servicio[] = [
  {
    id: "F-101", tipo: "fijo", estado: "en_ruta",
    cliente: "Minera Volcán", ruta_codigo: "Ruta A1",
    vehiculo: "ABC-123", vehiculo_id: 1,
    conductor: "Juan Pérez", conductor_tel: "987654321",
    hora_estimada: "18:00", hora_real_inicio: "07:02",
    pasajeros_total: 45, pasajeros_abordados: 38,
    paradas_completadas: 6, paradas_total: 10,
    checkin_realizado: true,
  },
  {
    id: "F-102", tipo: "fijo", estado: "alerta",
    cliente: "Banco Continental", ruta_codigo: "Ruta B3",
    vehiculo: "DEF-456", vehiculo_id: 2,
    conductor: "Carlos Ríos", conductor_tel: "976543210",
    hora_estimada: "07:30", hora_real_inicio: undefined,
    pasajeros_total: 32, pasajeros_abordados: 0,
    paradas_completadas: 0, paradas_total: 8,
    checkin_realizado: false,
  },
  {
    id: "F-103", tipo: "fijo", estado: "finalizado",
    cliente: "Claro Perú", ruta_codigo: "Ruta C2",
    vehiculo: "GHI-789", vehiculo_id: 3,
    conductor: "Miguel Torres", conductor_tel: "965432109",
    hora_estimada: "13:00", hora_real_inicio: "06:58", hora_real_fin: "13:05",
    pasajeros_total: 28, pasajeros_abordados: 28,
    paradas_completadas: 8, paradas_total: 8,
    checkin_realizado: true, unidad_reemplazo: "GHI-789",
  },
  {
    id: "E-501", tipo: "eventual", estado: "en_ruta",
    cliente: "Colegio San José",
    vehiculo: "XYZ-789", vehiculo_id: 4,
    conductor: "Luis Sosa", conductor_tel: "954321098",
    hora_estimada: "09:00",
    contacto_responsable: "Prof. María Castro", contacto_tel: "943210987",
    checkin_realizado: true,
    viaticos_entregados: true,
    documentos_ok: true,
    conformidad_firmada: false,
    gastos: [
      { concepto: "Peaje Canta", monto: 50 },
      { concepto: "Almuerzo conductor", monto: 35 },
    ],
    hitos: [
      { id: 1, label: "Salida de cochera", hora: "07:45", completado: true },
      { id: 2, label: "Recojo del grupo - Colegio", hora: "09:00", completado: true },
      { id: 3, label: "Llegada a destino - Parque Huascarán", hora: "11:30", completado: true },
      { id: 4, label: "Retorno", hora: "15:00", completado: false },
      { id: 5, label: "Llegada final - Colegio", hora: "17:30", completado: false },
    ],
  },
  {
    id: "E-502", tipo: "eventual", estado: "programado",
    cliente: "BBVA - RRHH",
    vehiculo: "LMN-321", vehiculo_id: 5,
    conductor: "Roberto Silva", conductor_tel: "932109876",
    hora_estimada: "14:00",
    contacto_responsable: "Ana Gutiérrez (RRHH)", contacto_tel: "921098765",
    checkin_realizado: false,
    viaticos_entregados: false,
    documentos_ok: false,
    conformidad_firmada: false,
    seguro_vence_hoy: true,
    gastos: [],
    hitos: [
      { id: 1, label: "Salida de cochera", completado: false },
      { id: 2, label: "Recojo del grupo - Sede BBVA Miraflores", completado: false },
      { id: 3, label: "Traslado a aeropuerto", completado: false },
      { id: 4, label: "Retorno", completado: false },
    ],
  },
  {
    id: "F-104", tipo: "fijo", estado: "programado",
    cliente: "Telefónica del Perú", ruta_codigo: "Ruta D1",
    vehiculo: "OPQ-654", vehiculo_id: 6,
    conductor: "Fernando Chávez", conductor_tel: "910987654",
    hora_estimada: "17:30",
    pasajeros_total: 40, pasajeros_abordados: 0,
    paradas_completadas: 0, paradas_total: 9,
    checkin_realizado: false,
  },
];

// ─── COLORES Y ESTADO ──────────────────────────────────────────────────────

const ESTADO = {
  programado: { label: "Programado", color: "#6366f1", bg: "#eef2ff", dot: "#6366f1" },
  en_ruta:    { label: "En Ruta",    color: "#16a34a", bg: "#dcfce7", dot: "#16a34a" },
  finalizado: { label: "Finalizado", color: "#64748b", bg: "#f1f5f9", dot: "#94a3b8" },
  alerta:     { label: "⚠ Alerta",  color: "#dc2626", bg: "#fef2f2", dot: "#dc2626" },
} as const;

// ─── ICONOS SVG ────────────────────────────────────────────────────────────

type IP = { size?: number; strokeWidth?: number; className?: string; color?: string };
const Ic = {
  Map:       (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>,
  Bus:       (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M8 6v6"/><path d="M16 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><circle cx="15" cy="18" r="2"/></svg>,
  Users:     (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  Check:     (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="20 6 9 17 4 12"/></svg>,
  Clock:     (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Alert:     (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  X:         (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Plus:      (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Phone:     (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.41 2 2 0 0 1 3.6 1.21h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.91a16 16 0 0 0 5.95 5.95l.96-.96a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21.72 16.92z"/></svg>,
  File:      (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>,
  DollarSign:(p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  Swap:      (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>,
  Shield:    (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Search:    (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  ChevronDown:(p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="6 9 12 15 18 9"/></svg>,
  ChevronUp: (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="18 15 12 9 6 15"/></svg>,
  Camera:    (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>,
  ExternalLink:(p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
  List:      (p:IP) => <svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
};

// ══════════════════════════════════════════════════════════════════════════════
// MODAL GASTOS
// ══════════════════════════════════════════════════════════════════════════════

function ModalGastos({ servicio, onClose }: { servicio: Servicio; onClose: () => void }) {
  const [gastos, setGastos] = useState<GastoViaje[]>(servicio.gastos || []);
  const [nuevoConcepto, setNuevoConcepto] = useState("");
  const [nuevoMonto, setNuevoMonto] = useState("");

  const total = gastos.reduce((s, g) => s + g.monto, 0);

  const agregar = () => {
    if (!nuevoConcepto || !nuevoMonto) return;
    setGastos([...gastos, { concepto: nuevoConcepto, monto: parseFloat(nuevoMonto) }]);
    setNuevoConcepto(""); setNuevoMonto("");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h3 className="font-black text-[#0b315f] text-base">Control de Gastos</h3>
            <p className="text-xs text-gray-400 mt-0.5">{servicio.id} · {servicio.cliente}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 flex items-center justify-center transition-colors">
            <Ic.X size={14} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Lista gastos */}
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {gastos.length === 0 && (
              <p className="text-center text-gray-400 text-sm py-4">Sin gastos registrados</p>
            )}
            {gastos.map((g, i) => (
              <div key={i} className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-2.5">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg bg-[#EFF6FF] flex items-center justify-center">
                    <Ic.DollarSign size={13} color="#1d4ed8" />
                  </div>
                  <span className="text-[13px] font-semibold text-gray-700">{g.concepto}</span>
                </div>
                <span className="font-black text-[#0b315f] text-[13px]">S/ {g.monto.toFixed(2)}</span>
              </div>
            ))}
          </div>

          {/* Total */}
          <div className="flex items-center justify-between bg-[#0b315f] rounded-xl px-4 py-3">
            <span className="text-white/70 text-sm font-semibold">Total gastado</span>
            <span className="text-white font-black text-lg">S/ {total.toFixed(2)}</span>
          </div>

          {/* Agregar */}
          <div className="border border-gray-100 rounded-xl p-3 space-y-2">
            <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Agregar gasto</p>
            <input
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0b315f] transition-colors"
              placeholder="Concepto (ej: Peaje Canta)"
              value={nuevoConcepto}
              onChange={e => setNuevoConcepto(e.target.value)}
            />
            <div className="flex gap-2">
              <input
                type="number"
                className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#0b315f] transition-colors"
                placeholder="Monto S/"
                value={nuevoMonto}
                onChange={e => setNuevoMonto(e.target.value)}
              />
              <button
                onClick={agregar}
                className="bg-[#0b315f] text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-[#1262bd] transition-colors flex items-center gap-1.5"
              >
                <Ic.Plus size={14} color="white" />
                Agregar
              </button>
            </div>
          </div>

          {/* Upload foto */}
          <button className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-gray-200 rounded-xl py-3 text-gray-400 text-sm hover:border-[#0b315f] hover:text-[#0b315f] transition-colors">
            <Ic.Camera size={16} />
            Adjuntar foto de comprobante
          </button>
        </div>

        <div className="px-5 pb-5">
          <button onClick={onClose} className="w-full bg-[#0b315f] text-white py-3 rounded-xl font-bold text-sm hover:bg-[#1262bd] transition-colors">
            Guardar gastos
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MODAL REEMPLAZO DE UNIDAD
// ══════════════════════════════════════════════════════════════════════════════

function ModalReemplazo({ servicio, onClose }: { servicio: Servicio; onClose: () => void }) {
  const [placaNueva, setPlacaNueva] = useState(servicio.unidad_reemplazo || "");
  const [motivo, setMotivo] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h3 className="font-black text-[#0b315f] text-base">Gestión de Reemplazo</h3>
            <p className="text-xs text-gray-400 mt-0.5">{servicio.id} · Unidad original: {servicio.vehiculo}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 flex items-center justify-center transition-colors">
            <Ic.X size={14} />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2.5">
            <Ic.Alert size={15} color="#d97706" />
            <p className="text-amber-700 text-xs font-semibold leading-relaxed">
              Registrar el reemplazo garantiza que la facturación mensual al cliente sea correcta y quede trazado en el historial.
            </p>
          </div>
          <div>
            <label className="block text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">Placa unidad de reemplazo</label>
            <input
              className="w-full border border-gray-200 rounded-xl px-4 py-3 font-black text-[#0b315f] text-lg tracking-widest text-center uppercase outline-none focus:border-[#0b315f] transition-colors"
              placeholder="EJM-000"
              value={placaNueva}
              onChange={e => setPlacaNueva(e.target.value.toUpperCase())}
            />
          </div>
          <div>
            <label className="block text-[11px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">Motivo del reemplazo</label>
            <select
              className="w-full border border-gray-200 rounded-xl px-4 py-3 text-sm text-gray-700 outline-none focus:border-[#0b315f] transition-colors"
              value={motivo}
              onChange={e => setMotivo(e.target.value)}
            >
              <option value="">Seleccionar motivo...</option>
              <option>Falla mecánica</option>
              <option>Accidente</option>
              <option>Mantenimiento programado</option>
              <option>Unidad en CITV</option>
              <option>Otro</option>
            </select>
          </div>
          <button onClick={onClose} className="w-full bg-[#0b315f] text-white py-3 rounded-xl font-bold text-sm hover:bg-[#1262bd] transition-colors">
            Confirmar reemplazo
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MODAL CHECKLIST SALIDA (Eventual)
// ══════════════════════════════════════════════════════════════════════════════

function ModalChecklist({ servicio, onClose }: { servicio: Servicio; onClose: () => void }) {
  const items = [
    { id: "lavado", label: "Bus lavado y presentable" },
    { id: "combustible", label: "Combustible completo (tanque lleno)" },
    { id: "viaticos", label: "Conductor recibió viáticos en efectivo" },
    { id: "documentos", label: "Contrato, Permiso Turismo y Guía de Remisión a bordo" },
    { id: "botiquin", label: "Botiquín de emergencias verificado" },
    { id: "conductor", label: "Conductor con brevete vigente y descanso suficiente" },
    { id: "pasajeros", label: "Lista de pasajeros confirmada con el responsable" },
    { id: "ruta", label: "Itinerario impreso entregado al conductor" },
  ];
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const completados = Object.values(checked).filter(Boolean).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-100 flex-shrink-0">
          <div>
            <h3 className="font-black text-[#0b315f] text-base">Checklist de Salida</h3>
            <p className="text-xs text-gray-400 mt-0.5">{servicio.id} · {servicio.cliente}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 flex items-center justify-center transition-colors">
            <Ic.X size={14} />
          </button>
        </div>

        {/* Progreso */}
        <div className="px-5 py-3 border-b border-gray-50 flex-shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-gray-500">{completados}/{items.length} verificados</span>
            <span className={`text-xs font-black ${completados === items.length ? "text-green-600" : "text-gray-400"}`}>
              {completados === items.length ? "✓ Listo para salir" : "Pendiente"}
            </span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${(completados / items.length) * 100}%`, background: completados === items.length ? "#16a34a" : "#0b315f" }}
            />
          </div>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-2">
          {items.map(item => (
            <label key={item.id} className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-colors ${checked[item.id] ? "bg-green-50 border border-green-100" : "bg-gray-50 border border-transparent hover:bg-gray-100"}`}>
              <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-all ${checked[item.id] ? "bg-green-600 border-green-600" : "border-gray-300"}`}>
                {checked[item.id] && <Ic.Check size={11} color="white" strokeWidth={3} />}
              </div>
              <input type="checkbox" className="hidden" checked={!!checked[item.id]} onChange={e => setChecked({ ...checked, [item.id]: e.target.checked })} />
              <span className={`text-sm font-semibold ${checked[item.id] ? "text-green-700" : "text-gray-600"}`}>{item.label}</span>
            </label>
          ))}
        </div>

        <div className="p-5 border-t border-gray-100 flex-shrink-0">
          <button
            onClick={onClose}
            disabled={completados < items.length}
            className={`w-full py-3 rounded-xl font-bold text-sm transition-all ${completados === items.length ? "bg-green-600 text-white hover:bg-green-700" : "bg-gray-100 text-gray-400 cursor-not-allowed"}`}
          >
            {completados === items.length ? "✓ Autorizar salida" : `Faltan ${items.length - completados} ítems`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TARJETA SERVICIO FIJO
// ══════════════════════════════════════════════════════════════════════════════

function TarjetaFija({ s }: { s: Servicio }) {
  const [expandida, setExpandida] = useState(false);
  const [modalReemplazo, setModalReemplazo] = useState(false);
  const [horaInicio, setHoraInicio] = useState(s.hora_real_inicio || "");
  const [horaFin, setHoraFin] = useState(s.hora_real_fin || "");
  const estado = ESTADO[s.estado];
  const progreso = s.paradas_total ? Math.round((s.paradas_completadas! / s.paradas_total) * 100) : 0;
  const asistencia = s.pasajeros_total ? Math.round((s.pasajeros_abordados! / s.pasajeros_total) * 100) : 0;

  return (
    <>
      {modalReemplazo && <ModalReemplazo servicio={s} onClose={() => setModalReemplazo(false)} />}
      <div className={`bg-white rounded-2xl shadow-sm border transition-all duration-200 ${s.estado === "alerta" ? "border-red-200 shadow-red-50" : "border-gray-100 hover:border-gray-200"}`}>
        {/* Alerta seguro */}
        {s.seguro_vence_hoy && (
          <div className="flex items-center gap-2 bg-red-50 border-b border-red-100 px-4 py-2 rounded-t-2xl">
            <Ic.Shield size={13} color="#dc2626" />
            <span className="text-red-600 text-xs font-bold">SEGURO DE LA UNIDAD VENCE HOY — Verificar antes de salir</span>
          </div>
        )}

        <div className="p-4">
          {/* Top row */}
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-start gap-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${s.estado === "alerta" ? "bg-red-50" : "bg-[#EFF6FF]"}`}>
                <Ic.Bus size={18} color={s.estado === "alerta" ? "#dc2626" : "#0b315f"} strokeWidth={1.8} />
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-black text-[#0b315f] text-sm">{s.cliente}</span>
                  {s.ruta_codigo && <span className="text-[10px] font-bold bg-[#EFF6FF] text-[#1d4ed8] px-2 py-0.5 rounded-full">{s.ruta_codigo}</span>}
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-xs text-gray-400 font-mono font-bold">{s.vehiculo}</span>
                  <span className="text-gray-200">·</span>
                  <span className="text-xs text-gray-500">{s.conductor}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-[11px] font-black px-2.5 py-1 rounded-full" style={{ color: estado.color, background: estado.bg }}>
                {estado.label}
              </span>
              <button onClick={() => setExpandida(v => !v)} className="w-7 h-7 rounded-lg bg-gray-50 hover:bg-gray-100 flex items-center justify-center transition-colors">
                {expandida ? <Ic.ChevronUp size={13} /> : <Ic.ChevronDown size={13} />}
              </button>
            </div>
          </div>

          {/* KPIs fila */}
          <div className="grid grid-cols-3 gap-2 mb-3">
            {/* Check-in */}
            <div className={`rounded-xl p-2.5 text-center ${s.checkin_realizado ? "bg-green-50" : s.estado === "alerta" ? "bg-red-50" : "bg-gray-50"}`}>
              <div className={`text-[10px] font-bold uppercase tracking-wide mb-1 ${s.checkin_realizado ? "text-green-600" : "text-red-500"}`}>Check-in</div>
              <div className={`font-black text-sm ${s.checkin_realizado ? "text-green-700" : "text-red-600"}`}>
                {s.checkin_realizado ? (s.hora_real_inicio || "—") : "No iniciado"}
              </div>
            </div>
            {/* Pasajeros */}
            <div className="bg-gray-50 rounded-xl p-2.5 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Pasajeros</div>
              <div className="font-black text-sm text-[#0b315f]">{s.pasajeros_abordados}<span className="text-gray-300 font-normal">/{s.pasajeros_total}</span></div>
            </div>
            {/* Paradas */}
            <div className="bg-gray-50 rounded-xl p-2.5 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Paradas</div>
              <div className="font-black text-sm text-[#0b315f]">{s.paradas_completadas}<span className="text-gray-300 font-normal">/{s.paradas_total}</span></div>
            </div>
          </div>

          {/* Barra de progreso paradas */}
          {s.paradas_total! > 0 && (
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

          {/* Barra asistencia */}
          {s.pasajeros_total! > 0 && (
            <div className="mb-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-gray-400 font-semibold">Asistencia (QR escaneados)</span>
                <span className="text-[10px] font-bold text-[#0b315f]">{asistencia}%</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-700 bg-indigo-500" style={{ width: `${asistencia}%` }} />
              </div>
            </div>
          )}

          {/* Acciones rápidas */}
          <div className="flex gap-2">
            <Link href={`/monitoreo?placa=${s.vehiculo}`} className="flex-1 flex items-center justify-center gap-1.5 bg-[#EFF6FF] hover:bg-[#DBEAFE] text-[#1d4ed8] text-xs font-bold py-2 rounded-xl transition-colors">
              <Ic.Map size={13} color="#1d4ed8" />
              Ver GPS
            </Link>
            <button
              onClick={() => setModalReemplazo(true)}
              className="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 text-gray-500 text-xs font-bold px-3 py-2 rounded-xl transition-colors"
            >
              <Ic.Swap size={13} />
              Reemplazo
            </button>
            <a href={`tel:${s.conductor_tel}`} className="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 text-gray-500 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
              <Ic.Phone size={13} />
            </a>
          </div>
        </div>

        {/* Panel expandido */}
        {expandida && (
          <div className="border-t border-gray-50 p-4 space-y-4">
            {/* Registro horario */}
            <div>
              <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2.5">Registro horario real</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] text-gray-400 font-semibold mb-1">Hora inicio real</label>
                  <input
                    type="time"
                    value={horaInicio}
                    onChange={e => setHoraInicio(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f] transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-gray-400 font-semibold mb-1">Hora fin real</label>
                  <input
                    type="time"
                    value={horaFin}
                    onChange={e => setHoraFin(e.target.value)}
                    className="w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f] transition-colors"
                  />
                </div>
              </div>
            </div>

            {/* Control asistencia */}
            <div>
              <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2.5">Control de pasajeros</p>
              <div className="flex items-center gap-2 bg-gray-50 rounded-xl px-3 py-2.5">
                <Ic.Users size={15} color="#0b315f" />
                <span className="text-sm text-gray-600">Pasajeros escaneados QR:</span>
                <span className="ml-auto font-black text-[#0b315f]">{s.pasajeros_abordados} / {s.pasajeros_total}</span>
              </div>
            </div>

            {/* Unidad asignada */}
            {s.unidad_reemplazo && s.unidad_reemplazo !== s.vehiculo && (
              <div className="bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 flex items-center gap-2">
                <Ic.Swap size={14} color="#d97706" />
                <span className="text-amber-700 text-xs font-semibold">Unidad {s.vehiculo} → reemplazada por {s.unidad_reemplazo}</span>
              </div>
            )}

            <button className="w-full bg-gray-50 hover:bg-gray-100 text-gray-500 text-xs font-bold py-2.5 rounded-xl transition-colors">
              Guardar cambios
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// TARJETA SERVICIO EVENTUAL
// ══════════════════════════════════════════════════════════════════════════════

function TarjetaEventual({ s }: { s: Servicio }) {
  const [expandida, setExpandida] = useState(false);
  const [modalGastos, setModalGastos] = useState(false);
  const [modalChecklist, setModalChecklist] = useState(false);
  const estado = ESTADO[s.estado];
  const hitosCompletados = s.hitos?.filter(h => h.completado).length || 0;
  const hitosTotal = s.hitos?.length || 0;
  const totalGastos = s.gastos?.reduce((sum, g) => sum + g.monto, 0) || 0;

  return (
    <>
      {modalGastos && <ModalGastos servicio={s} onClose={() => setModalGastos(false)} />}
      {modalChecklist && <ModalChecklist servicio={s} onClose={() => setModalChecklist(false)} />}

      <div className={`bg-white rounded-2xl shadow-sm border transition-all duration-200 ${s.estado === "alerta" ? "border-red-200" : s.seguro_vence_hoy ? "border-amber-200" : "border-gray-100 hover:border-gray-200"}`}>

        {/* Alerta seguro vence */}
        {s.seguro_vence_hoy && (
          <div className="flex items-center gap-2 bg-amber-50 border-b border-amber-100 px-4 py-2 rounded-t-2xl">
            <Ic.Shield size={13} color="#d97706" />
            <span className="text-amber-700 text-xs font-bold">⚠ SEGURO DE LA UNIDAD VENCE HOY — No despachar sin renovación</span>
          </div>
        )}

        <div className="p-4">
          {/* Header */}
          <div className="flex items-start justify-between mb-3">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center flex-shrink-0">
                <Ic.List size={18} color="#6366f1" strokeWidth={1.8} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-black text-[#0b315f] text-sm">{s.cliente}</span>
                  <span className="text-[10px] font-bold bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full">Eventual</span>
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-xs text-gray-400 font-mono font-bold">{s.vehiculo}</span>
                  <span className="text-gray-200">·</span>
                  <span className="text-xs text-gray-500">{s.conductor}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-[11px] font-black px-2.5 py-1 rounded-full" style={{ color: estado.color, background: estado.bg }}>
                {estado.label}
              </span>
              <button onClick={() => setExpandida(v => !v)} className="w-7 h-7 rounded-lg bg-gray-50 hover:bg-gray-100 flex items-center justify-center transition-colors">
                {expandida ? <Ic.ChevronUp size={13} /> : <Ic.ChevronDown size={13} />}
              </button>
            </div>
          </div>

          {/* Timeline de hitos (compacto) */}
          <div className="mb-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Itinerario</span>
              <span className="text-[10px] font-bold text-[#0b315f]">{hitosCompletados}/{hitosTotal} hitos</span>
            </div>
            <div className="flex items-center gap-1">
              {s.hitos?.map((h, i) => (
                <div key={h.id} className="flex items-center flex-1">
                  <div className={`flex-1 h-1 rounded-full ${h.completado ? "bg-green-500" : "bg-gray-100"}`} />
                  <div className={`w-3 h-3 rounded-full flex-shrink-0 border-2 transition-all ${h.completado ? "bg-green-500 border-green-500" : "bg-white border-gray-300"}`} />
                  {i === s.hitos!.length - 1 && null}
                </div>
              ))}
            </div>
            <div className="mt-1.5">
              {s.hitos?.find(h => !h.completado) && (
                <p className="text-[11px] text-gray-500">
                  <span className="font-bold">Próximo: </span>
                  {s.hitos.find(h => !h.completado)?.label}
                  {s.hitos.find(h => !h.completado)?.hora && ` · ${s.hitos.find(h => !h.completado)?.hora}`}
                </p>
              )}
            </div>
          </div>

          {/* Badges de estado */}
          <div className="flex items-center gap-1.5 mb-3 flex-wrap">
            <span className={`text-[10px] font-bold px-2 py-1 rounded-lg ${s.viaticos_entregados ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
              {s.viaticos_entregados ? "✓" : "✗"} Viáticos
            </span>
            <span className={`text-[10px] font-bold px-2 py-1 rounded-lg ${s.documentos_ok ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
              {s.documentos_ok ? "✓" : "!"} Documentos
            </span>
            <span className={`text-[10px] font-bold px-2 py-1 rounded-lg ${s.conformidad_firmada ? "bg-green-50 text-green-700" : "bg-gray-50 text-gray-500"}`}>
              {s.conformidad_firmada ? "✓" : "○"} Conformidad
            </span>
            {totalGastos > 0 && (
              <span className="text-[10px] font-bold px-2 py-1 rounded-lg bg-blue-50 text-blue-700">
                S/ {totalGastos} gastos
              </span>
            )}
          </div>

          {/* Contacto responsable */}
          {s.contacto_responsable && (
            <div className="flex items-center gap-2 bg-gray-50 rounded-xl px-3 py-2 mb-3">
              <Ic.Phone size={13} color="#64748b" />
              <span className="text-xs text-gray-600 font-semibold">{s.contacto_responsable}</span>
              <a href={`tel:${s.contacto_tel}`} className="ml-auto text-[11px] text-[#1d4ed8] font-bold hover:underline">{s.contacto_tel}</a>
            </div>
          )}

          {/* Acciones */}
          <div className="flex gap-2 flex-wrap">
            <Link href={`/monitoreo?placa=${s.vehiculo}`} className="flex items-center gap-1.5 bg-[#EFF6FF] hover:bg-[#DBEAFE] text-[#1d4ed8] text-xs font-bold px-3 py-2 rounded-xl transition-colors">
              <Ic.Map size={13} color="#1d4ed8" />
              GPS
            </Link>
            <button
              onClick={() => setModalGastos(true)}
              className="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 text-gray-600 text-xs font-bold px-3 py-2 rounded-xl transition-colors"
            >
              <Ic.DollarSign size={13} />
              Gastos {totalGastos > 0 && `(S/${totalGastos})`}
            </button>
            <button
              onClick={() => setModalChecklist(true)}
              className="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 text-gray-600 text-xs font-bold px-3 py-2 rounded-xl transition-colors"
            >
              <Ic.Check size={13} />
              Checklist
            </button>
            <a href={`tel:${s.conductor_tel}`} className="flex items-center gap-1.5 bg-gray-50 hover:bg-gray-100 text-gray-500 text-xs font-bold px-3 py-2 rounded-xl transition-colors">
              <Ic.Phone size={13} />
            </a>
          </div>
        </div>

        {/* Panel expandido */}
        {expandida && (
          <div className="border-t border-gray-50 p-4 space-y-4">
            {/* Timeline completo */}
            <div>
              <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-3">Timeline del itinerario</p>
              <div className="space-y-2">
                {s.hitos?.map((h, i) => (
                  <div key={h.id} className="flex items-center gap-3">
                    <div className="flex flex-col items-center">
                      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${h.completado ? "bg-green-500 border-green-500" : "bg-white border-gray-200"}`}>
                        {h.completado && <Ic.Check size={10} color="white" strokeWidth={3} />}
                      </div>
                      {i < s.hitos!.length - 1 && <div className={`w-0.5 h-5 mt-1 ${h.completado ? "bg-green-200" : "bg-gray-100"}`} />}
                    </div>
                    <div className="flex-1 flex items-center justify-between">
                      <span className={`text-[13px] font-semibold ${h.completado ? "text-green-700" : "text-gray-500"}`}>{h.label}</span>
                      <span className="text-[11px] text-gray-400 font-mono">{h.hora || "—"}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Conformidad firmada */}
            <div>
              <p className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-2">Hoja de servicio</p>
              <button className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-gray-200 rounded-xl py-3 text-gray-400 text-xs hover:border-[#0b315f] hover:text-[#0b315f] transition-colors">
                <Ic.Camera size={15} />
                {s.conformidad_firmada ? "✓ Conformidad adjunta — ver foto" : "Adjuntar foto de conformidad firmada"}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PÁGINA PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════

export default function SeguimientoPage() {
  const [filtroTipo, setFiltroTipo] = useState<"todos" | "fijo" | "eventual">("todos");
  const [filtroEstado, setFiltroEstado] = useState<"todos" | EstadoServicio>("todos");
  const [busqueda, setBusqueda] = useState("");

  // KPIs
  const totalFijos    = SERVICIOS_MOCK.filter(s => s.tipo === "fijo").length;
  const totalEventuales = SERVICIOS_MOCK.filter(s => s.tipo === "eventual").length;
  const enRuta        = SERVICIOS_MOCK.filter(s => s.estado === "en_ruta").length;
  const alertas       = SERVICIOS_MOCK.filter(s => s.estado === "alerta").length;
  const sinCheckin    = SERVICIOS_MOCK.filter(s => !s.checkin_realizado && s.estado !== "finalizado").length;
  const seguroHoy     = SERVICIOS_MOCK.filter(s => s.seguro_vence_hoy).length;

  // Filtrado
  const filtrados = SERVICIOS_MOCK.filter(s => {
    if (filtroTipo !== "todos" && s.tipo !== filtroTipo) return false;
    if (filtroEstado !== "todos" && s.estado !== filtroEstado) return false;
    if (busqueda) {
      const q = busqueda.toLowerCase();
      return s.vehiculo.toLowerCase().includes(q) || s.conductor.toLowerCase().includes(q) || s.cliente.toLowerCase().includes(q);
    }
    return true;
  });

  const fijos     = filtrados.filter(s => s.tipo === "fijo");
  const eventuales = filtrados.filter(s => s.tipo === "eventual");

  return (
    <div className="min-h-screen bg-[#eef3f8]">
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* ── ENCABEZADO ────────────────────────────────────────────── */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-black text-[#0b315f] leading-none">Seguimiento Operativo</h1>
            <p className="text-sm text-gray-400 mt-1 font-medium">
              {new Date().toLocaleDateString("es-PE", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
            </p>
          </div>
          <Link
            href="/monitoreo"
            className="flex items-center gap-2 bg-[#0b315f] text-white px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-[#1262bd] transition-colors shadow-sm"
          >
            <Ic.Map size={15} color="white" />
            Ver Mapa Global
            <Ic.ExternalLink size={13} color="white" />
          </Link>
        </div>

        {/* ── KPIs ──────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: "Fijos activos",     value: totalFijos,      color: "#0b315f", bg: "#EFF6FF",  icon: <Ic.Bus size={16} color="#0b315f" /> },
            { label: "Eventuales",        value: totalEventuales, color: "#6366f1", bg: "#EEF2FF",  icon: <Ic.List size={16} color="#6366f1" /> },
            { label: "En ruta ahora",     value: enRuta,          color: "#16a34a", bg: "#DCFCE7",  icon: <Ic.Check size={16} color="#16a34a" /> },
            { label: "Alertas retraso",   value: alertas,         color: "#dc2626", bg: "#FEF2F2",  icon: <Ic.Alert size={16} color="#dc2626" /> },
            { label: "Sin check-in",      value: sinCheckin,      color: "#d97706", bg: "#FEF3C7",  icon: <Ic.Clock size={16} color="#d97706" /> },
            { label: "Seguros vencen hoy",value: seguroHoy,       color: "#dc2626", bg: "#FEF2F2",  icon: <Ic.Shield size={16} color="#dc2626" /> },
          ].map(kpi => (
            <div key={kpi.label} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: kpi.bg }}>{kpi.icon}</div>
              </div>
              <div className="font-black text-2xl leading-none" style={{ color: kpi.color }}>{kpi.value}</div>
              <div className="text-[11px] text-gray-400 font-semibold mt-1 leading-tight">{kpi.label}</div>
            </div>
          ))}
        </div>

        {/* Alerta global si hay sin check-in */}
        {alertas > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-2xl px-5 py-3.5 flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-red-100 flex items-center justify-center flex-shrink-0">
              <Ic.Alert size={16} color="#dc2626" />
            </div>
            <div>
              <p className="font-black text-red-700 text-sm">{alertas} servicio(s) en alerta — no iniciaron a la hora pactada</p>
              <p className="text-red-500 text-xs mt-0.5">Contactar al conductor o despachar unidad de reemplazo inmediatamente</p>
            </div>
          </div>
        )}

        {/* ── FILTROS ───────────────────────────────────────────────── */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <div className="flex flex-col md:flex-row gap-3">
            {/* Buscador */}
            <div className="relative flex-1">
              <Ic.Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none" />
              <input
                className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:border-[#0b315f] transition-colors"
                placeholder="Buscar por placa, conductor o cliente..."
                value={busqueda}
                onChange={e => setBusqueda(e.target.value)}
              />
            </div>

            {/* Filtro tipo */}
            <div className="flex gap-1 bg-gray-50 rounded-xl p-1">
              {(["todos", "fijo", "eventual"] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setFiltroTipo(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${filtroTipo === t ? "bg-white shadow-sm text-[#0b315f]" : "text-gray-400 hover:text-gray-600"}`}
                >
                  {t === "todos" ? "Todos" : t === "fijo" ? "Regulares" : "Eventuales"}
                </button>
              ))}
            </div>

            {/* Filtro estado */}
            <div className="flex gap-1 bg-gray-50 rounded-xl p-1">
              {(["todos", "programado", "en_ruta", "alerta", "finalizado"] as const).map(e => (
                <button
                  key={e}
                  onClick={() => setFiltroEstado(e)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${filtroEstado === e ? "bg-white shadow-sm text-[#0b315f]" : "text-gray-400 hover:text-gray-600"}`}
                >
                  {e === "todos" ? "Todos" : ESTADO[e as EstadoServicio]?.label ?? e}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── SERVICIOS REGULARES ───────────────────────────────────── */}
        {(filtroTipo === "todos" || filtroTipo === "fijo") && fijos.length > 0 && (
          <section>
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-8 h-8 rounded-xl bg-[#EFF6FF] flex items-center justify-center">
                <Ic.Bus size={16} color="#0b315f" />
              </div>
              <div>
                <h2 className="font-black text-[#0b315f] text-base leading-none">Servicios Regulares (Fijos)</h2>
                <p className="text-[11px] text-gray-400 mt-0.5">Control de rutina y puntualidad · Contratos Marco</p>
              </div>
              <span className="ml-auto text-[11px] font-black bg-[#EFF6FF] text-[#0b315f] px-2.5 py-1 rounded-full">{fijos.length}</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {fijos.map(s => <TarjetaFija key={s.id} s={s} />)}
            </div>
          </section>
        )}

        {/* ── SERVICIOS EVENTUALES ──────────────────────────────────── */}
        {(filtroTipo === "todos" || filtroTipo === "eventual") && eventuales.length > 0 && (
          <section>
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-8 h-8 rounded-xl bg-indigo-50 flex items-center justify-center">
                <Ic.List size={16} color="#6366f1" />
              </div>
              <div>
                <h2 className="font-black text-[#0b315f] text-base leading-none">Servicios Discrecionales (Eventuales)</h2>
                <p className="text-[11px] text-gray-400 mt-0.5">Logística, gastos e hitos de agenda · Liquidación por evento</p>
              </div>
              <span className="ml-auto text-[11px] font-black bg-indigo-50 text-indigo-600 px-2.5 py-1 rounded-full">{eventuales.length}</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {eventuales.map(s => <TarjetaEventual key={s.id} s={s} />)}
            </div>
          </section>
        )}

        {/* Sin resultados */}
        {filtrados.length === 0 && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-12 text-center">
            <p className="text-4xl mb-3">🔍</p>
            <p className="font-bold text-gray-600">Sin servicios para los filtros seleccionados</p>
            <p className="text-sm text-gray-400 mt-1">Intenta cambiar el tipo, estado o búsqueda</p>
          </div>
        )}

        {/* ── TABLA RESUMEN ─────────────────────────────────────────── */}
        <section>
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
              <h2 className="font-black text-[#0b315f] text-sm">Resumen general del día</h2>
              <span className="text-xs text-gray-400">{SERVICIOS_MOCK.length} servicios total</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="text-left px-4 py-3 text-[10px] font-black text-gray-400 uppercase tracking-wider">ID</th>
                    <th className="text-left px-4 py-3 text-[10px] font-black text-gray-400 uppercase tracking-wider">Tipo</th>
                    <th className="text-left px-4 py-3 text-[10px] font-black text-gray-400 uppercase tracking-wider">Vehículo</th>
                    <th className="text-left px-4 py-3 text-[10px] font-black text-gray-400 uppercase tracking-wider">Conductor</th>
                    <th className="text-left px-4 py-3 text-[10px] font-black text-gray-400 uppercase tracking-wider">Cliente</th>
                    <th className="text-left px-4 py-3 text-[10px] font-black text-gray-400 uppercase tracking-wider">Estado</th>
                    <th className="text-left px-4 py-3 text-[10px] font-black text-gray-400 uppercase tracking-wider">Hora</th>
                    <th className="text-left px-4 py-3 text-[10px] font-black text-gray-400 uppercase tracking-wider">Acción</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {SERVICIOS_MOCK.map(s => {
                    const est = ESTADO[s.estado];
                    return (
                      <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 font-black text-[#0b315f] text-xs">{s.id}</td>
                        <td className="px-4 py-3">
                          <span className={`text-[10px] font-bold px-2 py-1 rounded-lg ${s.tipo === "fijo" ? "bg-[#EFF6FF] text-[#0b315f]" : "bg-indigo-50 text-indigo-600"}`}>
                            {s.tipo === "fijo" ? "Fijo" : "Eventual"}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono font-bold text-[#0b315f] text-xs">{s.vehiculo}</td>
                        <td className="px-4 py-3 text-xs text-gray-600 font-medium">{s.conductor}</td>
                        <td className="px-4 py-3 text-xs text-gray-700 font-semibold">{s.cliente}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <div className="w-1.5 h-1.5 rounded-full" style={{ background: est.dot }} />
                            <span className="text-xs font-semibold" style={{ color: est.color }}>{est.label}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 font-mono">{s.hora_estimada}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <Link href={`/monitoreo?placa=${s.vehiculo}`} className="flex items-center gap-1 bg-[#EFF6FF] hover:bg-[#DBEAFE] text-[#1d4ed8] text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition-colors">
                              <Ic.Map size={11} color="#1d4ed8" />
                              GPS
                            </Link>
                            {s.tipo === "eventual" && (
                              <button className="flex items-center gap-1 bg-gray-50 hover:bg-gray-100 text-gray-500 text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition-colors">
                                <Ic.List size={11} />
                                Itinerario
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}