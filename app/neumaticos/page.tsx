"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type EstadoNeu = "activo" | "desgastado" | "retirado" | "stock";

type Vehiculo = {
  id: number; placa: string; categoria: string | null;
  kilometraje_actual: number | null;
};

type Neumatico = {
  id: number; vehiculo_id: number | null;
  codigo: string | null; marca: string | null; medida: string | null;
  posicion: string | null; fecha_instalacion: string | null;
  km_instalacion: number | null; km_actual: number | null;
  vida_util_km: number | null; estado: EstadoNeu;
  observaciones: string | null; created_at: string;
  cocada_actual: number | null; cocada_nueva: number | null;
  presion_psi: number | null; costo_compra: number | null;
};

// ─── POSICIONES POR TIPO DE VEHÍCULO ─────────────────────────────────────────

type PosConfig = { id: string; label: string; codigo: string };

const POSICIONES_AUTO: PosConfig[] = [
  { id: "DEL-IZQ",  label: "Delantera Izq.", codigo: "P1" },
  { id: "DEL-DER",  label: "Delantera Der.", codigo: "P2" },
  { id: "TRA-IZQ1", label: "Trasera Izq.",   codigo: "P3" },
  { id: "TRA-DER1", label: "Trasera Der.",   codigo: "P4" },
  { id: "REPUESTO", label: "Repuesto",       codigo: "R1" },
];

const POSICIONES_BUS: PosConfig[] = [
  { id: "DEL-IZQ",  label: "Delantera Izq.",    codigo: "P1" },
  { id: "DEL-DER",  label: "Delantera Der.",    codigo: "P2" },
  { id: "TRA-IZQ1", label: "Trasera Izq. Ext.", codigo: "P3" },
  { id: "TRA-IZQ2", label: "Trasera Izq. Int.", codigo: "P4" },
  { id: "TRA-DER1", label: "Trasera Der. Ext.", codigo: "P5" },
  { id: "TRA-DER2", label: "Trasera Der. Int.", codigo: "P6" },
  { id: "REPUESTO", label: "Repuesto",          codigo: "R1" },
];

function getPosiciones(categoria: string | null): PosConfig[] {
  const cat = (categoria || "").toUpperCase();
  if (cat.includes("BUS") || cat.includes("MINIBUS") || cat.includes("CUSTER") || cat.includes("COASTER")) {
    return POSICIONES_BUS;
  }
  return POSICIONES_AUTO;
}

// ─── COLORES ──────────────────────────────────────────────────────────────────

const ESTADO_CFG: Record<EstadoNeu, { label: string; bg: string; color: string }> = {
  activo:    { label: "Activo",    bg: "#dcfce7", color: "#166534" },
  desgastado:{ label: "Desgastado",bg: "#fef9c3", color: "#854d0e" },
  retirado:  { label: "Retirado",  bg: "#fee2e2", color: "#991b1b" },
  stock:     { label: "En stock",  bg: "#f3f4f6", color: "#4b5563" },
};

function colorPorDesgaste(pct: number): string {
  if (pct >= 90) return "#dc2626";
  if (pct >= 70) return "#eab308";
  return "#16a34a";
}

function colorPorCocada(actual: number | null, nueva: number | null): string {
  if (!actual || !nueva) return "#94a3b8";
  const pct = ((nueva - actual) / nueva) * 100;
  if (pct >= 70) return "#dc2626";
  if (pct >= 40) return "#eab308";
  return "#16a34a";
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtNum(n: number, dec = 0) {
  return n.toLocaleString("es-PE", { maximumFractionDigits: dec });
}
function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function calcVidaUtil(n: Neumatico) {
  const kmRec  = Number(n.km_actual || 0) - Number(n.km_instalacion || 0);
  const vidaKm = Number(n.vida_util_km || 80000);
  const pct    = Math.min(100, Math.round((Math.max(0, kmRec) / vidaKm) * 100));
  return { pct, kmRecorridos: Math.max(0, kmRec), kmRestantes: vidaKm - kmRec, color: colorPorDesgaste(pct) };
}
function calcCPK(n: Neumatico): number | null {
  const km  = Number(n.km_actual || 0) - Number(n.km_instalacion || 0);
  const cost = Number(n.costo_compra || 0);
  if (km <= 0 || cost <= 0) return null;
  return cost / km;
}
function calcDesgasteMM(n: Neumatico): number | null {
  if (!n.cocada_nueva || !n.cocada_actual) return null;
  return Number(n.cocada_nueva) - Number(n.cocada_actual);
}
function calcRendimiento(n: Neumatico): number | null {
  const kmRec = Number(n.km_actual || 0) - Number(n.km_instalacion || 0);
  const desg  = calcDesgasteMM(n);
  if (!desg || desg <= 0 || kmRec <= 0) return null;
  return kmRec / desg;
}

function inputCls(extra = "") {
  return `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${extra}`;
}
function Campo({ label, span, children }: { label: string; span?: number; children: React.ReactNode }) {
  return (
    <div className={span === 2 ? "md:col-span-2" : span === 3 ? "md:col-span-3" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

// ─── SVG VEHÍCULOS (estilo blueprint técnico) ─────────────────────────────────

function SVGAuto({ posiciones, getColor }: { posiciones: PosConfig[]; getColor: (id: string) => string }) {
  const get = (id: string) => getColor(id);
  return (
    <svg viewBox="0 0 120 200" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
      {/* Sombra */}
      <ellipse cx="60" cy="195" rx="35" ry="4" fill="#cbd5e1" opacity="0.4"/>
      {/* Carrocería principal */}
      <rect x="20" y="40" width="80" height="120" rx="12" fill="#f1f5f9" stroke="#94a3b8" strokeWidth="1.5"/>
      {/* Techo / cabina */}
      <rect x="30" y="55" width="60" height="55" rx="8" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="1"/>
      {/* Parabrisas delantero */}
      <rect x="33" y="57" width="54" height="22" rx="4" fill="#bfdbfe" stroke="#93c5fd" strokeWidth="0.8" opacity="0.8"/>
      {/* Luneta trasera */}
      <rect x="33" y="82" width="54" height="22" rx="4" fill="#bfdbfe" stroke="#93c5fd" strokeWidth="0.8" opacity="0.6"/>
      {/* Hood delantero */}
      <rect x="25" y="25" width="70" height="18" rx="6" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="1.2"/>
      {/* Maletero trasero */}
      <rect x="25" y="158" width="70" height="18" rx="6" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="1.2"/>
      {/* Rejilla */}
      <line x1="35" y1="30" x2="85" y2="30" stroke="#94a3b8" strokeWidth="0.6"/>
      <line x1="35" y1="35" x2="85" y2="35" stroke="#94a3b8" strokeWidth="0.6"/>
      {/* Faros */}
      <rect x="26" y="27" width="14" height="6" rx="2" fill="#fde68a" stroke="#f59e0b" strokeWidth="0.8"/>
      <rect x="80" y="27" width="14" height="6" rx="2" fill="#fde68a" stroke="#f59e0b" strokeWidth="0.8"/>
      {/* Luces traseras */}
      <rect x="26" y="168" width="14" height="6" rx="2" fill="#fca5a5" stroke="#ef4444" strokeWidth="0.8"/>
      <rect x="80" y="168" width="14" height="6" rx="2" fill="#fca5a5" stroke="#ef4444" strokeWidth="0.8"/>
      {/* Puerta líneas */}
      <line x1="60" y1="115" x2="60" y2="155" stroke="#94a3b8" strokeWidth="0.8" strokeDasharray="2,2"/>
      <circle cx="55" cy="135" r="1.5" fill="#94a3b8"/>
      <circle cx="65" cy="135" r="1.5" fill="#94a3b8"/>
      {/* Espejo */}
      <rect x="12" y="68" width="8" height="5" rx="2" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="0.8"/>
      <rect x="100" y="68" width="8" height="5" rx="2" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="0.8"/>

      {/* ── NEUMÁTICOS ── */}
      {/* P1 DEL-IZQ */}
      <rect x="3" y="45" width="16" height="28" rx="4" fill={get("DEL-IZQ")} stroke="white" strokeWidth="1"/>
      <text x="11" y="60" textAnchor="middle" fontSize="6" fontWeight="800" fill="white">P1</text>
      {/* P2 DEL-DER */}
      <rect x="101" y="45" width="16" height="28" rx="4" fill={get("DEL-DER")} stroke="white" strokeWidth="1"/>
      <text x="109" y="60" textAnchor="middle" fontSize="6" fontWeight="800" fill="white">P2</text>
      {/* P3 TRA-IZQ1 */}
      <rect x="3" y="130" width="16" height="28" rx="4" fill={get("TRA-IZQ1")} stroke="white" strokeWidth="1"/>
      <text x="11" y="145" textAnchor="middle" fontSize="6" fontWeight="800" fill="white">P3</text>
      {/* P4 TRA-DER1 */}
      <rect x="101" y="130" width="16" height="28" rx="4" fill={get("TRA-DER1")} stroke="white" strokeWidth="1"/>
      <text x="109" y="145" textAnchor="middle" fontSize="6" fontWeight="800" fill="white">P4</text>
      {/* R1 REPUESTO */}
      <circle cx="60" cy="193" r="6" fill={get("REPUESTO")} stroke="white" strokeWidth="1"/>
      <text x="60" y="196" textAnchor="middle" fontSize="4" fontWeight="800" fill="white">R1</text>
    </svg>
  );
}

function SVGBus({ posiciones, getColor, tipo }: { posiciones: PosConfig[]; getColor: (id: string) => string; tipo: string }) {
  const get = (id: string) => getColor(id);
  const esMinibus = tipo.toUpperCase().includes("MINI") || tipo.toUpperCase().includes("CUSTER") || tipo.toUpperCase().includes("COASTER");
  const altoCuerpo = esMinibus ? 170 : 210;
  const yTra = esMinibus ? 135 : 165;

  return (
    <svg viewBox="0 0 130 240" className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
      {/* Sombra */}
      <ellipse cx="65" cy="237" rx="42" ry="4" fill="#cbd5e1" opacity="0.4"/>
      {/* Carrocería */}
      <rect x="15" y="20" width="100" height={altoCuerpo} rx="8" fill="#f1f5f9" stroke="#94a3b8" strokeWidth="1.5"/>
      {/* Frente */}
      <rect x="15" y="20" width="100" height="30" rx="8" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="1.2"/>
      {/* Parabrisas */}
      <rect x="22" y="24" width="86" height="18" rx="4" fill="#bfdbfe" stroke="#93c5fd" strokeWidth="0.8" opacity="0.85"/>
      {/* Faros delanteros */}
      <rect x="18" y="26" width="10" height="8" rx="2" fill="#fde68a" stroke="#f59e0b" strokeWidth="0.8"/>
      <rect x="102" y="26" width="10" height="8" rx="2" fill="#fde68a" stroke="#f59e0b" strokeWidth="0.8"/>
      {/* Ventanas laterales */}
      {[55, 75, 95, 115, 135, 155].slice(0, esMinibus ? 4 : 6).map((y, i) => (
        <rect key={i} x="18" y={y} width="94" height="14" rx="3" fill="#bfdbfe" stroke="#93c5fd" strokeWidth="0.6" opacity="0.65"/>
      ))}
      {/* Puerta */}
      <rect x="18" y={esMinibus ? 85 : 95} width="20" height="30" rx="2" fill="#cbd5e1" stroke="#94a3b8" strokeWidth="0.8"/>
      <line x1="28" y1={esMinibus ? 85 : 95} x2="28" y2={esMinibus ? 115 : 125} stroke="#94a3b8" strokeWidth="0.6"/>
      {/* Parte trasera */}
      <rect x="15" y={altoCuerpo + 8} width="100" height="16" rx="6" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="1.2"/>
      {/* Luces traseras */}
      <rect x="18" y={altoCuerpo + 10} width="14" height="8" rx="2" fill="#fca5a5" stroke="#ef4444" strokeWidth="0.8"/>
      <rect x="98" y={altoCuerpo + 10} width="14" height="8" rx="2" fill="#fca5a5" stroke="#ef4444" strokeWidth="0.8"/>
      {/* Matrícula */}
      <rect x="45" y={altoCuerpo + 11} width="40" height="7" rx="1" fill="#f8fafc" stroke="#94a3b8" strokeWidth="0.6"/>
      {/* Línea separadora piso/techo */}
      <line x1="15" y1="70" x2="115" y2="70" stroke="#94a3b8" strokeWidth="0.5" strokeDasharray="3,3"/>

      {/* ── NEUMÁTICOS DELANTEROS (simples) ── */}
      {/* P1 DEL-IZQ */}
      <rect x="0" y="28" width="14" height="30" rx="3" fill={get("DEL-IZQ")} stroke="white" strokeWidth="1"/>
      <text x="7" y="45" textAnchor="middle" fontSize="5.5" fontWeight="800" fill="white">P1</text>
      {/* P2 DEL-DER */}
      <rect x="116" y="28" width="14" height="30" rx="3" fill={get("DEL-DER")} stroke="white" strokeWidth="1"/>
      <text x="123" y="45" textAnchor="middle" fontSize="5.5" fontWeight="800" fill="white">P2</text>

      {/* ── NEUMÁTICOS TRASEROS (dobles) ── */}
      {/* P3 TRA-IZQ-EXT */}
      <rect x="0" y={yTra} width="13" height="28" rx="3" fill={get("TRA-IZQ1")} stroke="white" strokeWidth="1"/>
      <text x="6.5" y={yTra + 15} textAnchor="middle" fontSize="5" fontWeight="800" fill="white">P3</text>
      {/* P4 TRA-IZQ-INT */}
      <rect x="14" y={yTra} width="10" height="28" rx="2" fill={get("TRA-IZQ2")} stroke="white" strokeWidth="0.8"/>
      <text x="19" y={yTra + 15} textAnchor="middle" fontSize="4.5" fontWeight="800" fill="white">P4</text>
      {/* P5 TRA-DER-EXT */}
      <rect x="117" y={yTra} width="13" height="28" rx="3" fill={get("TRA-DER1")} stroke="white" strokeWidth="1"/>
      <text x="123" y={yTra + 15} textAnchor="middle" fontSize="5" fontWeight="800" fill="white">P5</text>
      {/* P6 TRA-DER-INT */}
      <rect x="106" y={yTra} width="10" height="28" rx="2" fill={get("TRA-DER2")} stroke="white" strokeWidth="0.8"/>
      <text x="111" y={yTra + 15} textAnchor="middle" fontSize="4.5" fontWeight="800" fill="white">P6</text>

      {/* R1 REPUESTO */}
      <circle cx="65" cy="232" r="7" fill={get("REPUESTO")} stroke="white" strokeWidth="1"/>
      <text x="65" y="235" textAnchor="middle" fontSize="4.5" fontWeight="800" fill="white">R1</text>
    </svg>
  );
}

function DiagramaVehiculo({
  vehiculo, neumaticos, posicionSel, onSeleccionar,
}: {
  vehiculo: Vehiculo; neumaticos: Neumatico[];
  posicionSel: string; onSeleccionar: (pos: string) => void;
}) {
  const cat  = vehiculo.categoria || "";
  const esBus = cat.toUpperCase().includes("BUS") || cat.toUpperCase().includes("MINI") || cat.toUpperCase().includes("CUSTER") || cat.toUpperCase().includes("COASTER");
  const posiciones = getPosiciones(cat);

  const getColor = (posId: string): string => {
    const neu = neumaticos.find(n => n.vehiculo_id === vehiculo.id && n.posicion === posId && n.estado === "activo");
    if (!neu) return "#cbd5e1";
    if (neu.cocada_actual && neu.cocada_nueva) return colorPorCocada(neu.cocada_actual, neu.cocada_nueva);
    const { pct } = calcVidaUtil(neu);
    return colorPorDesgaste(pct);
  };

  return (
    <div className="bg-gradient-to-b from-slate-50 to-gray-100 rounded-2xl border border-gray-200 p-4">
      {/* Header vehículo */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="font-black text-gray-800 font-mono">{vehiculo.placa}</p>
          <p className="text-[11px] text-gray-400 uppercase tracking-wide">{cat}</p>
        </div>
        <div className="text-right text-xs">
          <p className="text-gray-400">KM actual</p>
          <p className="font-mono font-bold text-gray-700">{vehiculo.kilometraje_actual ? fmtNum(Number(vehiculo.kilometraje_actual)) : "—"}</p>
        </div>
      </div>

      {/* Diagrama */}
      <div className="flex justify-center" style={{ height: esBus ? "240px" : "200px" }}>
        {esBus
          ? <SVGBus posiciones={posiciones} getColor={getColor} tipo={cat} />
          : <SVGAuto posiciones={posiciones} getColor={getColor} />
        }
      </div>

      {/* Leyenda de posiciones */}
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        {posiciones.map(pos => {
          const neu = neumaticos.find(n => n.vehiculo_id === vehiculo.id && n.posicion === pos.id && n.estado === "activo");
          const color = getColor(pos.id);
          const activo = posicionSel === pos.id;
          return (
            <button key={pos.id} onClick={() => onSeleccionar(pos.id)}
              className="flex items-center gap-2 px-2 py-1.5 rounded-xl text-left transition-all"
              style={{ background: activo ? "#eef3f8" : "white", border: activo ? "1.5px solid #0b315f" : "1.5px solid #f1f5f9" }}>
              <div className="w-7 h-5 rounded-md flex items-center justify-center flex-shrink-0 text-[9px] font-black text-white" style={{ background: color }}>
                {pos.codigo}
              </div>
              <div className="min-w-0">
                <div className="text-[10px] font-bold text-gray-600 truncate">{pos.label}</div>
                <div className="text-[9px] truncate" style={{ color: neu ? color : "#94a3b8" }}>
                  {neu ? `${neu.marca} ${neu.medida || ""}` : "Sin neumático"}
                </div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Leyenda colores */}
      <div className="mt-3 pt-3 border-t border-gray-200 flex gap-3 justify-center flex-wrap">
        {[{ color: "#16a34a", label: "Ok" }, { color: "#eab308", label: "Rotación" }, { color: "#dc2626", label: "Cambio" }, { color: "#cbd5e1", label: "Vacío" }].map(l => (
          <div key={l.label} className="flex items-center gap-1">
            <div className="w-3 h-2 rounded" style={{ background: l.color }} />
            <span className="text-[9px] text-gray-500 font-medium">{l.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── FORM VACIO ───────────────────────────────────────────────────────────────

const FORM_VACIO = {
  vehiculo_id: "", codigo: "", marca: "", medida: "",
  posicion: "", fecha_instalacion: "", km_instalacion: "",
  km_actual: "", vida_util_km: "80000", estado: "activo" as EstadoNeu,
  observaciones: "", cocada_actual: "", cocada_nueva: "20",
  presion_psi: "", costo_compra: "",
};

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function NeumaticosPage() {
  const [vehiculos,   setVehiculos]   = useState<Vehiculo[]>([]);
  const [neumaticos,  setNeumaticos]  = useState<Neumatico[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [guardando,   setGuardando]   = useState(false);
  const [editandoId,  setEditandoId]  = useState<number | null>(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [vehiculoSel, setVehiculoSel] = useState<number | null>(null);
  const [posicionSel, setPosicionSel] = useState("");
  const [busqueda,    setBusqueda]    = useState("");
  const [filtroEst,   setFiltroEst]   = useState("todos");
  const [form, setForm] = useState(FORM_VACIO);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  const cargarDatos = async () => {
    setLoading(true);
    const [vRes, nRes] = await Promise.all([
      supabase.from("vehiculos").select("id,placa,categoria,kilometraje_actual").order("placa"),
      supabase.from("neumaticos").select("*").order("created_at", { ascending: false }),
    ]);
    setVehiculos(vRes.data || []);
    setNeumaticos(nRes.data || []);
    if (vRes.data && vRes.data.length > 0 && !vehiculoSel) setVehiculoSel(vRes.data[0].id);
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  const nombreVehiculo = (id: number | null) => {
    const v = vehiculos.find(v => v.id === id);
    return v ? `${v.placa}${v.categoria ? ` · ${v.categoria}` : ""}` : "—";
  };

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const abrirNuevo = (posicion = "") => {
    setForm({ ...FORM_VACIO, vehiculo_id: vehiculoSel ? String(vehiculoSel) : "", posicion });
    setEditandoId(null); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const editar = (n: Neumatico) => {
    setForm({
      vehiculo_id: n.vehiculo_id ? String(n.vehiculo_id) : "",
      codigo: n.codigo || "", marca: n.marca || "", medida: n.medida || "",
      posicion: n.posicion || "", fecha_instalacion: n.fecha_instalacion || "",
      km_instalacion: n.km_instalacion ? String(n.km_instalacion) : "",
      km_actual: n.km_actual ? String(n.km_actual) : "",
      vida_util_km: n.vida_util_km ? String(n.vida_util_km) : "80000",
      estado: n.estado || "activo", observaciones: n.observaciones || "",
      cocada_actual: n.cocada_actual ? String(n.cocada_actual) : "",
      cocada_nueva: n.cocada_nueva ? String(n.cocada_nueva) : "20",
      presion_psi: n.presion_psi ? String(n.presion_psi) : "",
      costo_compra: n.costo_compra ? String(n.costo_compra) : "",
    });
    setEditandoId(n.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const guardar = async () => {
    if (!form.vehiculo_id || !form.marca) { alert("Vehículo y marca son obligatorios"); return; }
    setGuardando(true);
    const payload = {
      vehiculo_id: Number(form.vehiculo_id),
      codigo: form.codigo.trim() || null, marca: form.marca.trim(),
      medida: form.medida.trim() || null, posicion: form.posicion.trim() || null,
      fecha_instalacion: form.fecha_instalacion || null,
      km_instalacion: form.km_instalacion ? Number(form.km_instalacion) : null,
      km_actual: form.km_actual ? Number(form.km_actual) : null,
      vida_util_km: form.vida_util_km ? Number(form.vida_util_km) : 80000,
      estado: form.estado, observaciones: form.observaciones.trim() || null,
      cocada_actual: form.cocada_actual ? Number(form.cocada_actual) : null,
      cocada_nueva: form.cocada_nueva ? Number(form.cocada_nueva) : 20,
      presion_psi: form.presion_psi ? Number(form.presion_psi) : null,
      costo_compra: form.costo_compra ? Number(form.costo_compra) : null,
    };
    const { error } = editandoId
      ? await supabase.from("neumaticos").update(payload).eq("id", editandoId)
      : await supabase.from("neumaticos").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar este neumático?")) return;
    await supabase.from("neumaticos").delete().eq("id", id);
    cargarDatos();
  };

  const cambiarEstado = async (id: number, estado: EstadoNeu) => {
    await supabase.from("neumaticos").update({ estado }).eq("id", id);
    setNeumaticos(prev => prev.map(n => n.id === id ? { ...n, estado } : n));
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const activos     = neumaticos.filter(n => n.estado === "activo");
  const criticos    = activos.filter(n => { const { pct } = calcVidaUtil(n); return pct >= 90; });
  const rotacion    = activos.filter(n => { const { pct } = calcVidaUtil(n); return pct >= 70 && pct < 90; });

  // CPK promedio
  const cpks   = activos.map(n => calcCPK(n)).filter(Boolean) as number[];
  const cpkProm = cpks.length > 0 ? cpks.reduce((a, b) => a + b, 0) / cpks.length : null;

  // Desgaste promedio mm
  const desgastes = activos.map(n => calcDesgasteMM(n)).filter(Boolean) as number[];
  const desgProm  = desgastes.length > 0 ? desgastes.reduce((a, b) => a + b, 0) / desgastes.length : null;

  const vehiculoActual = vehiculos.find(v => v.id === vehiculoSel);
  const neuVehiculo    = neumaticos.filter(n => n.vehiculo_id === vehiculoSel);
  const posicionesVeh  = getPosiciones(vehiculoActual?.categoria || "");

  const filtrados = neumaticos.filter(n => {
    const v = vehiculos.find(v => v.id === n.vehiculo_id);
    const q = busqueda.toLowerCase();
    const txt = `${v?.placa || ""} ${n.marca || ""} ${n.codigo || ""} ${n.posicion || ""}`.toLowerCase();
    return txt.includes(q) && (filtroEst === "todos" || n.estado === filtroEst);
  });

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Neumáticos</h1>
          <p className="text-gray-400 text-sm mt-1">Control por posición · vida útil · CPK · cocada · trazabilidad</p>
        </div>
        <button onClick={() => { limpiar(); setMostrarForm(v => !v); }}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
          style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
          {mostrarForm ? "✕ Cancelar" : "+ Nuevo neumático"}
        </button>
      </div>

      {/* ALERTAS */}
      {criticos.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-center gap-3 text-sm text-red-800">
          🔴 <b>{criticos.length} neumático{criticos.length > 1 ? "s" : ""}</b> con vida útil al 90%+ — requieren reemplazo inmediato
        </div>
      )}
      {rotacion.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
          🟡 <b>{rotacion.length} neumático{rotacion.length > 1 ? "s" : ""}</b> entre 70–90% — programar rotación o inspección
        </div>
      )}

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {[
          { label: "Total",        valor: String(neumaticos.length), color: "#0b315f", bg: "#eef3f8" },
          { label: "Activos",      valor: String(activos.length),    color: "#166534", bg: "#dcfce7" },
          { label: "Críticos",     valor: String(criticos.length),   color: "#991b1b", bg: "#fee2e2" },
          { label: "Rotación",     valor: String(rotacion.length),   color: "#854d0e", bg: "#fef9c3" },
          { label: "En stock",     valor: String(neumaticos.filter(n => n.estado === "stock").length), color: "#4b5563", bg: "#f3f4f6" },
          { label: "CPK promedio", valor: cpkProm ? `S/ ${fmtNum(cpkProm, 3)}` : "—", color: "#1d4ed8", bg: "#dbeafe" },
          { label: "Desgaste prom",valor: desgProm ? `${fmtNum(desgProm, 1)} mm` : "—", color: "#6d28d9", bg: "#ede9fe" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-lg font-black mt-0.5 leading-tight" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* FORMULARIO */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>🛞</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar neumático" : "Registrar neumático"}</h2>
              <p className="text-xs text-gray-400">Vehículo y marca son obligatorios</p>
            </div>
          </div>

          {/* Identificación */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Identificación</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Vehículo *">
                <select className={inputCls()} value={form.vehiculo_id} onChange={f("vehiculo_id")}>
                  <option value="">Seleccionar vehículo</option>
                  {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa}{v.categoria ? ` · ${v.categoria}` : ""}</option>)}
                </select>
              </Campo>
              <Campo label="Marca *">
                <input className={inputCls()} placeholder="Ej: Michelin, Bridgestone, Goodyear" value={form.marca} onChange={f("marca")} />
              </Campo>
              <Campo label="Medida">
                <input className={inputCls("font-mono")} placeholder="Ej: 295/80R22.5" value={form.medida} onChange={f("medida")} />
              </Campo>
              <Campo label="Código / Serie">
                <input className={inputCls("font-mono")} placeholder="Ej: NEU-2024-001" value={form.codigo} onChange={f("codigo")} />
              </Campo>
              <Campo label="Posición">
                <select className={inputCls()} value={form.posicion} onChange={f("posicion")}>
                  <option value="">Sin posición</option>
                  {getPosiciones(vehiculos.find(v => v.id === Number(form.vehiculo_id))?.categoria || "").map(p => (
                    <option key={p.id} value={p.id}>{p.codigo} — {p.label}</option>
                  ))}
                </select>
              </Campo>
              <Campo label="Estado">
                <select className={inputCls()} value={form.estado} onChange={f("estado")}>
                  <option value="activo">Activo</option>
                  <option value="desgastado">Desgastado</option>
                  <option value="retirado">Retirado</option>
                  <option value="stock">En stock</option>
                </select>
              </Campo>
            </div>
          </div>

          {/* Cocada y presión */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Cocada y presión</p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Campo label="Cocada nueva (mm)">
                <input type="number" className={inputCls()} placeholder="20" value={form.cocada_nueva} onChange={f("cocada_nueva")} />
              </Campo>
              <Campo label="Cocada actual (mm)">
                <input type="number" className={inputCls()} placeholder="Ej: 15" value={form.cocada_actual} onChange={f("cocada_actual")} />
              </Campo>
              <Campo label="Presión PSI">
                <input type="number" className={inputCls()} placeholder="Ej: 100" value={form.presion_psi} onChange={f("presion_psi")} />
              </Campo>
              <Campo label="Costo de compra S/">
                <input type="number" className={inputCls()} placeholder="0.00" value={form.costo_compra} onChange={f("costo_compra")} />
              </Campo>
            </div>
            {/* Preview desgaste */}
            {form.cocada_actual && form.cocada_nueva && (
              <div className="mt-3 rounded-xl p-3 bg-gray-50 flex gap-6 items-center">
                {(() => {
                  const actual = Number(form.cocada_actual);
                  const nueva  = Number(form.cocada_nueva);
                  const pct    = Math.round(((nueva - actual) / nueva) * 100);
                  const color  = colorPorCocada(actual, nueva);
                  return (
                    <>
                      <div className="flex-1 space-y-1">
                        <div className="flex justify-between text-xs">
                          <span className="text-gray-500">Desgaste de cocada</span>
                          <span className="font-bold" style={{ color }}>{pct}% usado · {fmtNum(nueva - actual, 1)} mm restantes</span>
                        </div>
                        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                        </div>
                      </div>
                      <div className="text-center text-xs">
                        <p className="text-gray-400">Cocada</p>
                        <p className="font-black text-lg" style={{ color }}>{fmtNum(actual, 1)} mm</p>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Kilometraje */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Kilometraje</p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Campo label="Fecha de instalación">
                <input type="date" className={inputCls()} value={form.fecha_instalacion} onChange={f("fecha_instalacion")} />
              </Campo>
              <Campo label="KM al instalar">
                <input type="number" className={inputCls("font-mono")} placeholder="Ej: 150000" value={form.km_instalacion} onChange={f("km_instalacion")} />
              </Campo>
              <Campo label="KM actual">
                <input type="number" className={inputCls("font-mono")} placeholder="Ej: 165000" value={form.km_actual} onChange={f("km_actual")} />
              </Campo>
              <Campo label="Vida útil estimada (km)">
                <input type="number" className={inputCls("font-mono")} placeholder="80000" value={form.vida_util_km} onChange={f("vida_util_km")} />
              </Campo>
            </div>
          </div>

          <Campo label="Observaciones" span={3}>
            <input className={inputCls()} placeholder="Notas adicionales..." value={form.observaciones} onChange={f("observaciones")} />
          </Campo>

          <div className="flex gap-3">
            <button onClick={guardar} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar" : "Guardar neumático"}
            </button>
            <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* DIAGRAMA + DETALLE */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">

        {/* Selector + Diagrama */}
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Seleccionar vehículo</label>
            <select className={inputCls()} value={vehiculoSel || ""}
              onChange={e => { setVehiculoSel(Number(e.target.value)); setPosicionSel(""); }}>
              {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa} · {v.categoria}</option>)}
            </select>
          </div>
          {vehiculoActual && (
            <DiagramaVehiculo
              vehiculo={vehiculoActual}
              neumaticos={neumaticos}
              posicionSel={posicionSel}
              onSeleccionar={pos => setPosicionSel(prev => prev === pos ? "" : pos)}
            />
          )}
        </div>

        {/* Detalle neumáticos del vehículo */}
        <div className="xl:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-gray-700">
              {vehiculoActual?.placa} — {neuVehiculo.length} neumático{neuVehiculo.length !== 1 ? "s" : ""}
            </h2>
            <button onClick={() => abrirNuevo(posicionSel)}
              className="px-4 py-2 rounded-xl text-xs font-bold text-white"
              style={{ background: "#0b315f" }}>+ Agregar</button>
          </div>

          {neuVehiculo.length === 0 ? (
            <div className="bg-white rounded-2xl border p-10 text-center text-gray-400">
              <p className="text-3xl mb-2">🛞</p>
              <p className="font-medium">Sin neumáticos para este vehículo</p>
              <button onClick={() => abrirNuevo()} className="mt-3 px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#0b315f" }}>Registrar primero</button>
            </div>
          ) : neuVehiculo.map(n => {
            const { pct, kmRecorridos, kmRestantes, color } = calcVidaUtil(n);
            const cpk   = calcCPK(n);
            const desg  = calcDesgasteMM(n);
            const rend  = calcRendimiento(n);
            const estCfg= ESTADO_CFG[n.estado];
            const pos   = posicionesVeh.find(p => p.id === n.posicion);
            const esPos = posicionSel && n.posicion === posicionSel;
            const colorCoc = colorPorCocada(n.cocada_actual, n.cocada_nueva);

            return (
              <div key={n.id} className="bg-white rounded-2xl border shadow-sm overflow-hidden transition-all"
                style={{ borderColor: esPos ? "#0b315f" : "#e5e7eb", borderWidth: esPos ? "2px" : "1px" }}>

                {/* Header */}
                <div className="px-4 py-3 flex items-center justify-between" style={{ background: "#f8fafc" }}>
                  <div className="flex items-center gap-3">
                    {pos && (
                      <div className="w-9 h-7 rounded-lg flex items-center justify-center text-xs font-black text-white" style={{ background: n.estado === "activo" ? color : "#94a3b8" }}>
                        {pos.codigo}
                      </div>
                    )}
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-black text-gray-900">{n.marca}</span>
                        {n.medida && <span className="font-mono text-xs bg-gray-100 px-2 py-0.5 rounded text-gray-600">{n.medida}</span>}
                      </div>
                      <div className="text-[11px] text-gray-400">
                        {pos ? pos.label : n.posicion || "Sin posición"}
                        {n.codigo && <span className="ml-2 font-mono">· {n.codigo}</span>}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <select value={n.estado} onChange={e => cambiarEstado(n.id, e.target.value as EstadoNeu)}
                      className="text-xs font-bold px-2 py-1 rounded-lg border-0 cursor-pointer"
                      style={{ background: estCfg.bg, color: estCfg.color }}>
                      <option value="activo">Activo</option>
                      <option value="desgastado">Desgastado</option>
                      <option value="retirado">Retirado</option>
                      <option value="stock">En stock</option>
                    </select>
                  </div>
                </div>

                <div className="px-4 py-3 space-y-3">
                  {/* Indicadores VecFleet style */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    {[
                      { label: "CPK", valor: cpk ? `S/ ${fmtNum(cpk, 3)}` : "—", sub: "Costo/km", color: cpk && cpk > 3 ? "#dc2626" : "#166534" },
                      { label: "Desgaste", valor: desg ? `${fmtNum(desg, 1)} mm` : "—", sub: "Cocada perdida", color: colorCoc },
                      { label: "Rendimiento", valor: rend ? `${fmtNum(rend, 0)} km/mm` : "—", sub: "km por mm", color: "#1d4ed8" },
                      { label: "PSI", valor: n.presion_psi ? `${n.presion_psi} PSI` : "—", sub: "Presión", color: "#6d28d9" },
                    ].map(k => (
                      <div key={k.label} className="rounded-xl p-2 text-center border" style={{ background: "#f8fafc" }}>
                        <p className="text-[9px] font-bold uppercase text-gray-400">{k.label}</p>
                        <p className="text-sm font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
                        <p className="text-[9px] text-gray-400">{k.sub}</p>
                      </div>
                    ))}
                  </div>

                  {/* Cocada visual */}
                  {n.cocada_actual && n.cocada_nueva && (
                    <div>
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="text-gray-500">Cocada restante</span>
                        <span className="font-bold" style={{ color: colorCoc }}>
                          {fmtNum(Number(n.cocada_actual), 1)} mm / {fmtNum(Number(n.cocada_nueva), 0)} mm
                        </span>
                      </div>
                      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${(Number(n.cocada_actual) / Number(n.cocada_nueva)) * 100}%`, background: colorCoc }} />
                      </div>
                    </div>
                  )}

                  {/* Vida útil KM */}
                  {n.estado === "activo" && (
                    <div>
                      <div className="flex justify-between text-[11px] mb-1">
                        <span className="text-gray-500">Vida útil por KM</span>
                        <span className="font-bold" style={{ color }}>{pct}% · {fmtNum(kmRecorridos)} km recorridos</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                      </div>
                      <p className="text-[10px] text-gray-400 mt-0.5">Restan: <b style={{ color }}>{fmtNum(kmRestantes)} km</b> · Total: {fmtNum(Number(n.vida_util_km || 80000))} km</p>
                    </div>
                  )}

                  {/* Info instalación */}
                  <div className="grid grid-cols-3 gap-2 text-xs text-gray-500 pt-1 border-t" style={{ borderColor: "#f1f5f9" }}>
                    <div><span className="text-gray-400">Instalado</span><br/><b>{fmtFecha(n.fecha_instalacion)}</b></div>
                    <div><span className="text-gray-400">KM instalación</span><br/><b className="font-mono">{n.km_instalacion ? fmtNum(Number(n.km_instalacion)) : "—"}</b></div>
                    <div><span className="text-gray-400">KM actual</span><br/><b className="font-mono">{n.km_actual ? fmtNum(Number(n.km_actual)) : "—"}</b></div>
                  </div>

                  {n.observaciones && <p className="text-xs text-gray-400 italic">"{n.observaciones}"</p>}

                  <div className="flex gap-2 pt-1">
                    <button onClick={() => editar(n)} className="px-3 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️ Editar</button>
                    <button onClick={() => eliminar(n.id)} className="px-3 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕ Eliminar</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* TABLA GLOBAL */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b flex items-center justify-between flex-wrap gap-3" style={{ borderColor: "#f1f5f9" }}>
          <h2 className="text-sm font-bold text-gray-700">Todos los neumáticos ({filtrados.length})</h2>
          <div className="flex gap-2">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs">🔍</span>
              <input className="border rounded-xl pl-8 pr-3 py-2 text-xs focus:outline-none w-52"
                placeholder="Buscar por placa, marca, código..."
                value={busqueda} onChange={e => setBusqueda(e.target.value)} />
            </div>
            <select className="border rounded-xl px-3 py-2 text-xs focus:outline-none"
              value={filtroEst} onChange={e => setFiltroEst(e.target.value)}>
              <option value="todos">Todos</option>
              <option value="activo">Activos</option>
              <option value="desgastado">Desgastados</option>
              <option value="retirado">Retirados</option>
              <option value="stock">En stock</option>
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {["Vehículo", "Marca / Medida", "Pos.", "KM Rec.", "Cocada", "CPK", "Rend.", "PSI", "Vida útil", "Estado", "Acciones"].map(h => (
                  <th key={h} className="p-3 text-left font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...
                  </div>
                </td></tr>
              ) : filtrados.length === 0 ? (
                <tr><td colSpan={11} className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">🛞</p><p>No hay neumáticos</p></td></tr>
              ) : filtrados.map(n => {
                const { pct, kmRecorridos, color } = calcVidaUtil(n);
                const cpk  = calcCPK(n);
                const desg = calcDesgasteMM(n);
                const rend = calcRendimiento(n);
                const pos  = getPosiciones(vehiculos.find(v => v.id === n.vehiculo_id)?.categoria || "").find(p => p.id === n.posicion);
                const estCfg = ESTADO_CFG[n.estado] || ESTADO_CFG.activo;
                return (
                  <tr key={n.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                    <td className="p-3 font-mono font-black text-[#0b315f]">{nombreVehiculo(n.vehiculo_id)}</td>
                    <td className="p-3">
                      <div className="font-bold text-gray-800">{n.marca}</div>
                      {n.medida && <div className="font-mono text-gray-400">{n.medida}</div>}
                    </td>
                    <td className="p-3">
                      {pos ? (
                        <span className="px-1.5 py-0.5 rounded font-black text-white text-[10px]" style={{ background: color }}>{pos.codigo}</span>
                      ) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="p-3 font-mono font-bold">{fmtNum(kmRecorridos)}</td>
                    <td className="p-3">
                      {n.cocada_actual
                        ? <span className="font-bold" style={{ color: colorPorCocada(n.cocada_actual, n.cocada_nueva) }}>{fmtNum(Number(n.cocada_actual), 1)} mm</span>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="p-3 font-bold" style={{ color: cpk && cpk > 3 ? "#dc2626" : "#166534" }}>
                      {cpk ? `S/ ${fmtNum(cpk, 3)}` : "—"}
                    </td>
                    <td className="p-3 text-blue-700 font-bold">{rend ? `${fmtNum(rend, 0)} km/mm` : "—"}</td>
                    <td className="p-3 text-purple-700 font-bold">{n.presion_psi ? `${n.presion_psi} PSI` : "—"}</td>
                    <td className="p-3 min-w-[100px]">
                      {n.estado === "activo" ? (
                        <div>
                          <div className="flex justify-between mb-0.5">
                            <span style={{ color }} className="font-bold">{pct}%</span>
                          </div>
                          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                          </div>
                        </div>
                      ) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="p-3">
                      <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: estCfg.bg, color: estCfg.color }}>{estCfg.label}</span>
                    </td>
                    <td className="p-3">
                      <div className="flex gap-1">
                        <button onClick={() => editar(n)} className="px-2 py-1 rounded-lg border hover:bg-gray-50 text-gray-700">✏️</button>
                        <button onClick={() => eliminar(n.id)} className="px-2 py-1 rounded-lg text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtrados.length > 0 && (
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>{filtrados.length} de {neumaticos.length} neumáticos</span>
            <span>AFA ERP · Flota</span>
          </div>
        )}
      </section>
    </main>
  );
}