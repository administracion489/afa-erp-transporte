"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ── TIPOS ─────────────────────────────────────────────────────────────────────

type EstadoMulta = "Pendiente" | "Pagada" | "Impugnada" | "Vencida" | "En proceso";
type Severidad   = "Leve" | "Grave" | "Muy grave";
type Entidad     = "SAT Lima" | "SUTRAN" | "MTC / PNP" | "Municipalidad Distrital" | "Municipalidad Provincial" | "Otro";

type Multa = {
  id: number;
  vehiculo_id: number | null;
  conductor_id: number | null;
  placa: string;
  conductor_nombre: string | null;
  entidad: Entidad;
  codigo_infraccion: string | null;
  infraccion: string;
  severidad: Severidad;
  puntos: number;
  monto_original: number;
  tiene_pronto_pago: boolean;
  monto_pronto_pago: number | null;
  fecha_limite_pronto_pago: string | null;
  fecha_infraccion: string;
  fecha_vencimiento: string | null;
  numero_papeleta: string | null;
  ubicacion: string | null;
  estado: EstadoMulta;
  fecha_pago: string | null;
  monto_pagado: number | null;
  observaciones: string | null;
};

type Vehiculo  = { id: number; placa: string };
type Conductor = { id: number; nombre: string };

// ── CONSTANTES PERU ───────────────────────────────────────────────────────────

const ENTIDADES: Entidad[] = [
  "SAT Lima", "SUTRAN", "MTC / PNP",
  "Municipalidad Distrital", "Municipalidad Provincial", "Otro",
];

// Días para pronto pago por entidad (Peru)
const DIAS_PP: Record<string, number> = {
  "SAT Lima": 7, "SUTRAN": 15, "MTC / PNP": 10,
  "Municipalidad Distrital": 15, "Municipalidad Provincial": 15, "Otro": 10,
};

// % de descuento pronto pago por entidad
const PCT_PP: Record<string, number> = {
  "SAT Lima": 50, "SUTRAN": 20, "MTC / PNP": 25,
  "Municipalidad Distrital": 30, "Municipalidad Provincial": 30, "Otro": 20,
};

// Montos de referencia (UIT 2026 ~S/5,350 → multas sobre % UIT)
const MONTO_REF: Record<Severidad, number> = { Leve: 206, Grave: 412, "Muy grave": 1030 };
const PUNTOS_REF: Record<Severidad, number> = { Leve: 5, Grave: 20, "Muy grave": 50 };

// Límite puntos conductor antes de suspensión (SUTRAN)
const PUNTOS_SUSPENSION = 100;
const PUNTOS_RIESGO     = 40;

const ESTADO_CFG: Record<EstadoMulta, { bg: string; color: string }> = {
  Pendiente:    { bg: "#fef9c3", color: "#854d0e" },
  Pagada:       { bg: "#dcfce7", color: "#166534" },
  Impugnada:    { bg: "#dbeafe", color: "#1d4ed8" },
  Vencida:      { bg: "#fee2e2", color: "#991b1b" },
  "En proceso": { bg: "#ede9fe", color: "#6d28d9" },
};

const SEV_CFG: Record<Severidad, { bg: string; color: string }> = {
  Leve:        { bg: "#f1f5f9", color: "#475569" },
  Grave:       { bg: "#fed7aa", color: "#9a3412" },
  "Muy grave": { bg: "#fee2e2", color: "#991b1b" },
};

// ── HELPERS ───────────────────────────────────────────────────────────────────

function fmtSoles(n: number) {
  return "S/ " + n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtFecha(f: string | null) {
  if (!f) return "-";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

function diasPara(f: string | null): number | null {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
}

function calcProntoP(entidad: string, fechaInfraccion: string, monto: number) {
  const dias = DIAS_PP[entidad] || 10;
  const pct  = PCT_PP[entidad] || 20;
  const lim  = new Date(fechaInfraccion + "T00:00:00");
  lim.setDate(lim.getDate() + dias);
  return {
    fechaLimite:  lim.toISOString().split("T")[0],
    montoDesc:    Math.round(monto * (1 - pct / 100) * 100) / 100,
    pct,
    dias,
  };
}

function inputCls() {
  return "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f]";
}

function Campo({ label, children, span }: { label: string; children: React.ReactNode; span?: number }) {
  return (
    <div className={span === 2 ? "col-span-2" : span === 3 ? "col-span-3" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

// ── FORM VACÍO ────────────────────────────────────────────────────────────────

function formVacio() {
  const hoy = new Date().toISOString().split("T")[0];
  const pp  = calcProntoP("SAT Lima", hoy, 412);
  return {
    vehiculo_id: "", placa: "", conductor_id: "", conductor_nombre: "",
    entidad: "SAT Lima" as Entidad,
    codigo_infraccion: "", infraccion: "",
    severidad: "Grave" as Severidad,
    puntos: 20, monto_original: 412,
    tiene_pronto_pago: true,
    monto_pronto_pago: pp.montoDesc,
    fecha_limite_pronto_pago: pp.fechaLimite,
    fecha_infraccion: hoy, fecha_vencimiento: "",
    numero_papeleta: "", ubicacion: "", observaciones: "",
  };
}

// ── PÁGINA PRINCIPAL ──────────────────────────────────────────────────────────

export default function MultasPage() {
  const [multas,      setMultas]      = useState<Multa[]>([]);
  const [vehiculos,   setVehiculos]   = useState<Vehiculo[]>([]);
  const [conductores, setConductores] = useState<Conductor[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [guardando,   setGuardando]   = useState(false);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [form,        setForm]        = useState(formVacio());
  const [busqueda,    setBusqueda]    = useState("");
  const [filtroEst,   setFiltroEst]   = useState("Todos");
  const [filtroEnt,   setFiltroEnt]   = useState("Todas");
  const [filtroSev,   setFiltroSev]   = useState("Todas");
  const [mensaje,     setMensaje]     = useState<{ tipo: "ok" | "err"; texto: string } | null>(null);

  // ── CARGA ──────────────────────────────────────────────────────────────────
  const cargarDatos = async () => {
    setLoading(true);

    // Vehiculos y conductores se cargan primero e independientemente
    // para garantizar que los selects del form funcionen aunque multas falle
    const [vR, cR] = await Promise.all([
      supabase.from("vehiculos").select("id,placa").order("placa"),
      supabase.from("conductores").select("id,nombre").order("nombre"),
    ]);
    if (vR.error) console.error("Error cargando vehiculos:", vR.error.message);
    if (cR.error) console.error("Error cargando conductores:", cR.error.message);
    setVehiculos(vR.data || []);
    setConductores(cR.data || []);

    // Multas se carga por separado con su propio try/catch
    try {
      const mR = await supabase
        .from("multas")
        .select("*")
        .order("fecha_infraccion", { ascending: false });
      if (mR.error) {
        console.error("Error cargando multas:", mR.error.message);
        setMensaje({ tipo: "err", texto: "Error al cargar multas: " + mR.error.message });
      }
      setMultas(mR.data || []);
    } catch (e: any) {
      console.error("Excepción cargando multas:", e);
    }

    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  // ── KPIs ───────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const activas    = multas.filter(m => m.estado === "Pendiente" || m.estado === "En proceso");
    const vencidas   = multas.filter(m => m.estado === "Vencida");
    const pagadas    = multas.filter(m => m.estado === "Pagada");
    const enPP       = multas.filter(m =>
      m.estado === "Pendiente" && m.tiene_pronto_pago &&
      m.fecha_limite_pronto_pago && (diasPara(m.fecha_limite_pronto_pago) ?? -1) >= 0
    );
    const montoPend  = activas.reduce((s, m) => s + Number(m.monto_original), 0);
    const montoPag   = pagadas.reduce((s, m) => s + Number(m.monto_pagado || m.monto_original), 0);
    const ahorroPP   = enPP.reduce((s, m) => s + Number(m.monto_original) - Number(m.monto_pronto_pago || 0), 0);
    const ptosFlota  = multas.filter(m => m.estado !== "Pagada").reduce((s, m) => s + m.puntos, 0);

    // Ranking de conductores por puntos acumulados
    const ptosCondutor: Record<string, number> = {};
    multas.filter(m => m.conductor_nombre && m.estado !== "Pagada").forEach(m => {
      ptosCondutor[m.conductor_nombre!] = (ptosCondutor[m.conductor_nombre!] || 0) + m.puntos;
    });
    const ranking = Object.entries(ptosCondutor).sort((a, b) => b[1] - a[1]);
    const condRiesgo = ranking.filter(([, p]) => p >= PUNTOS_RIESGO).length;

    return { total: multas.length, activas: activas.length, vencidas: vencidas.length, enPP: enPP.length, montoPend, montoPag, ahorroPP, ptosFlota, condRiesgo, ranking, enPPList: enPP };
  }, [multas]);

  // ── FILTRO ─────────────────────────────────────────────────────────────────
  const filtradas = useMemo(() => multas.filter(m => {
    const q   = busqueda.toLowerCase();
    const txt = `${m.placa} ${m.conductor_nombre || ""} ${m.entidad} ${m.infraccion} ${m.ubicacion || ""} ${m.numero_papeleta || ""}`.toLowerCase();
    return txt.includes(q) &&
      (filtroEst === "Todos" || m.estado    === filtroEst) &&
      (filtroEnt === "Todas" || m.entidad   === filtroEnt) &&
      (filtroSev === "Todas" || m.severidad === filtroSev);
  }), [multas, busqueda, filtroEst, filtroEnt, filtroSev]);

  // ── FORM HELPERS ───────────────────────────────────────────────────────────
  const sf = (k: keyof ReturnType<typeof formVacio>) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  const onPlaca = (vid: string) => {
    const v = vehiculos.find(v => v.id === Number(vid));
    if (!v) { setForm(p => ({ ...p, vehiculo_id: vid, placa: "" })); return; }
    setForm(p => ({ ...p, vehiculo_id: vid, placa: v.placa }));
  };

  const onSeveridad = (sev: Severidad) => {
    const pp = calcProntoP(form.entidad, form.fecha_infraccion, MONTO_REF[sev]);
    setForm(p => ({ ...p, severidad: sev, puntos: PUNTOS_REF[sev], monto_original: MONTO_REF[sev], monto_pronto_pago: pp.montoDesc, fecha_limite_pronto_pago: pp.fechaLimite }));
  };

  const onEntidad = (ent: Entidad) => {
    const pp = calcProntoP(ent, form.fecha_infraccion, form.monto_original);
    setForm(p => ({ ...p, entidad: ent, monto_pronto_pago: pp.montoDesc, fecha_limite_pronto_pago: pp.fechaLimite }));
  };

  const onFechaInf = (fecha: string) => {
    const pp = calcProntoP(form.entidad, fecha, form.monto_original);
    setForm(p => ({ ...p, fecha_infraccion: fecha, monto_pronto_pago: pp.montoDesc, fecha_limite_pronto_pago: pp.fechaLimite }));
  };

  // ── GUARDAR ────────────────────────────────────────────────────────────────
  const guardar = async () => {
    if (!form.placa || !form.infraccion || !form.fecha_infraccion) {
      setMensaje({ tipo: "err", texto: "Placa, infracción y fecha son obligatorios" }); return;
    }
    setGuardando(true);
    const { error } = await supabase.from("multas").insert({
      vehiculo_id:              form.vehiculo_id ? Number(form.vehiculo_id) : null,
      conductor_id:             form.conductor_id ? Number(form.conductor_id) : null,
      placa:                    form.placa.toUpperCase(),
      conductor_nombre:         form.conductor_nombre || null,
      entidad:                  form.entidad,
      codigo_infraccion:        form.codigo_infraccion || null,
      infraccion:               form.infraccion,
      severidad:                form.severidad,
      puntos:                   Number(form.puntos),
      monto_original:           Number(form.monto_original),
      tiene_pronto_pago:        form.tiene_pronto_pago,
      monto_pronto_pago:        form.tiene_pronto_pago ? Number(form.monto_pronto_pago) : null,
      fecha_limite_pronto_pago: form.tiene_pronto_pago ? form.fecha_limite_pronto_pago : null,
      fecha_infraccion:         form.fecha_infraccion,
      fecha_vencimiento:        form.fecha_vencimiento || null,
      numero_papeleta:          form.numero_papeleta || null,
      ubicacion:                form.ubicacion || null,
      estado:                   "Pendiente",
      observaciones:            form.observaciones || null,
    });
    setGuardando(false);
    if (error) { setMensaje({ tipo: "err", texto: error.message }); return; }
    setMensaje({ tipo: "ok", texto: "Multa registrada. Recordar verificar pronto pago para aprovechar el descuento." });
    setMostrarForm(false);
    setForm(formVacio());
    cargarDatos();
  };

  const cambiarEstado = async (id: number, estado: EstadoMulta) => {
    const extra: any = {};
    if (estado === "Pagada") {
      extra.fecha_pago    = new Date().toISOString().split("T")[0];
      extra.monto_pagado  = multas.find(m => m.id === id)?.monto_original;
    }
    await supabase.from("multas").update({ estado, ...extra }).eq("id", id);
    setMultas(prev => prev.map(m => m.id === id ? { ...m, estado, ...extra } : m));
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar esta multa?")) return;
    await supabase.from("multas").delete().eq("id", id);
    setMultas(prev => prev.filter(m => m.id !== id));
  };

  // ── RENDER ─────────────────────────────────────────────────────────────────
  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* HEADER */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Multas e Infracciones</h1>
          <p className="text-gray-400 text-sm mt-1">
            SAT Lima · SUTRAN · MTC/PNP · Municipalidades · Pronto pago · Riesgo de conductor
          </p>
        </div>
        <button
          onClick={() => { setMostrarForm(true); setMensaje(null); }}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white"
          style={{ background: "#0b315f" }}
        >
          + Registrar multa
        </button>
      </div>

      {/* MENSAJE */}
      {mensaje && (
        <div className="rounded-xl px-4 py-3 text-sm font-medium flex justify-between"
          style={{ background: mensaje.tipo === "ok" ? "#dcfce7" : "#fee2e2", color: mensaje.tipo === "ok" ? "#166534" : "#991b1b" }}>
          <span>{mensaje.texto}</span>
          <button onClick={() => setMensaje(null)} className="opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3">
        {[
          { label: "Total registradas", valor: String(kpis.total),                  color: "#0b315f", bg: "#eef3f8" },
          { label: "Activas",           valor: String(kpis.activas),                color: "#854d0e", bg: "#fef9c3" },
          { label: "Vencidas",          valor: String(kpis.vencidas),               color: "#991b1b", bg: "#fee2e2" },
          { label: "Pronto pago",       valor: String(kpis.enPP),                   color: "#0f766e", bg: "#f0fdfa" },
          { label: "Monto pendiente",   valor: fmtSoles(kpis.montoPend),            color: "#854d0e", bg: "#fef9c3", sm: true },
          { label: "Ahorro disponible", valor: fmtSoles(kpis.ahorroPP),             color: "#0f766e", bg: "#f0fdfa", sm: true },
          { label: "Puntos flota",      valor: `${kpis.ptosFlota}/${PUNTOS_SUSPENSION * (conductores.length || 1)}`, color: "#6d28d9", bg: "#ede9fe" },
          { label: "Cond. en riesgo",   valor: String(kpis.condRiesgo),             color: "#991b1b", bg: "#fee2e2" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className={`font-black mt-0.5 ${k.sm ? "text-sm" : "text-2xl"}`} style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* ALERTA PRONTO PAGO */}
      {kpis.enPPList.length > 0 && (
        <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 px-5 py-4">
          <p className="text-sm font-black text-amber-800 mb-3">
            ⚡ {kpis.enPPList.length} multa(s) con pronto pago activo — pagá antes del vencimiento y ahorrá {fmtSoles(kpis.ahorroPP)}
          </p>
          <div className="flex gap-3 flex-wrap">
            {kpis.enPPList.slice(0, 6).map(m => {
              const dias   = diasPara(m.fecha_limite_pronto_pago);
              const ahorro = Number(m.monto_original) - Number(m.monto_pronto_pago || 0);
              const critico = dias !== null && dias <= 2;
              return (
                <div key={m.id} className="bg-white rounded-xl border px-3 py-2.5 text-xs space-y-0.5"
                  style={{ borderColor: critico ? "#fca5a5" : "#fde68a" }}>
                  <p className="font-black text-gray-900">{m.placa}</p>
                  <p className="text-gray-500 truncate max-w-[150px]">{m.infraccion}</p>
                  <p className="font-bold text-green-700">
                    {fmtSoles(m.monto_pronto_pago || 0)}
                    <span className="ml-1 text-gray-400 line-through font-normal">{fmtSoles(Number(m.monto_original))}</span>
                  </p>
                  <p className="text-[10px] font-bold" style={{ color: critico ? "#991b1b" : "#92400e" }}>
                    Ahorro: {fmtSoles(ahorro)} · {dias === 0 ? "¡Vence HOY!" : dias !== null && dias > 0 ? `${dias}d restantes` : "Vencido"}
                  </p>
                  <p className="text-[9px] text-gray-400">{m.entidad} · {PCT_PP[m.entidad]}% dscto.</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* PANEL RIESGO CONDUCTORES */}
      {kpis.ranking.length > 0 && (
        <div className="bg-white rounded-2xl border shadow-sm px-5 py-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">
            Riesgo por conductor — Suspensión a los {PUNTOS_SUSPENSION} puntos (SUTRAN)
          </p>
          <div className="flex gap-3 flex-wrap">
            {kpis.ranking.slice(0, 6).map(([nombre, puntos]) => {
              const pct     = Math.min((puntos / PUNTOS_SUSPENSION) * 100, 100);
              const riesgo  = puntos >= PUNTOS_RIESGO;
              const critico = puntos >= PUNTOS_SUSPENSION * 0.7;
              return (
                <div key={nombre} className="flex-1 min-w-[160px] rounded-xl border p-3"
                  style={{ borderColor: critico ? "#fca5a5" : riesgo ? "#fed7aa" : "#e2e8f0", background: critico ? "#fff5f5" : riesgo ? "#fffbeb" : "#f8fafc" }}>
                  <p className="text-xs font-bold text-gray-800 truncate">{nombre}</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: critico ? "#dc2626" : riesgo ? "#d97706" : "#0b315f" }} />
                    </div>
                    <span className="text-[11px] font-black" style={{ color: critico ? "#991b1b" : riesgo ? "#92400e" : "#0b315f" }}>
                      {puntos} pts
                    </span>
                  </div>
                  {riesgo && <p className="text-[9px] font-bold mt-1" style={{ color: critico ? "#991b1b" : "#92400e" }}>
                    {critico ? "RIESGO ALTO — evitar asignar" : "En observación"}
                  </p>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* FILTROS */}
      <section className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input
            className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Buscar por placa, conductor, infracción..."
            value={busqueda}
            onChange={e => setBusqueda(e.target.value)}
          />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEst} onChange={e => setFiltroEst(e.target.value)}>
          <option value="Todos">Todos los estados</option>
          {(["Pendiente","Pagada","Impugnada","Vencida","En proceso"] as EstadoMulta[]).map(e => <option key={e}>{e}</option>)}
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEnt} onChange={e => setFiltroEnt(e.target.value)}>
          <option value="Todas">Todas las entidades</option>
          {ENTIDADES.map(e => <option key={e}>{e}</option>)}
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroSev} onChange={e => setFiltroSev(e.target.value)}>
          <option value="Todas">Toda severidad</option>
          <option>Leve</option><option>Grave</option><option>Muy grave</option>
        </select>
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">
          {filtradas.length} resultado{filtradas.length !== 1 ? "s" : ""}
        </div>
      </section>

      {/* TABLA */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {["Placa / Fecha", "Conductor", "Entidad", "Infracción", "Monto original", "Pronto pago", "Vencimiento", "Estado", "Riesgo", ""].map(h => (
                  <th key={h} className="p-3 text-left text-[10px] font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
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
                  <p className="text-3xl mb-2">🚫</p>
                  <p className="font-medium">{multas.length === 0 ? "Sin multas registradas" : "Sin resultados para los filtros aplicados"}</p>
                </td></tr>
              ) : filtradas.map(m => {
                const estCfg  = ESTADO_CFG[m.estado];
                const sevCfg  = SEV_CFG[m.severidad];
                const diasVenc = diasPara(m.fecha_vencimiento);
                const diasPP   = m.fecha_limite_pronto_pago ? diasPara(m.fecha_limite_pronto_pago) : null;
                const ppActivo = m.tiene_pronto_pago && diasPP !== null && diasPP >= 0 && m.estado === "Pendiente";
                const ahorroPP = Number(m.monto_original) - Number(m.monto_pronto_pago || 0);
                const venceHoy = diasVenc !== null && diasVenc === 0;
                const urgente  = diasVenc !== null && diasVenc >= 0 && diasVenc <= 5 && m.estado === "Pendiente";

                return (
                  <tr key={m.id}
                    className="border-t transition-colors hover:bg-gray-50"
                    style={{ borderColor: "#f1f5f9", boxShadow: m.estado === "Vencida" ? "inset 3px 0 0 #dc2626" : ppActivo && diasPP !== null && diasPP <= 2 ? "inset 3px 0 0 #f59e0b" : undefined }}
                  >
                    <td className="p-3">
                      <p className="font-black font-mono text-[#0b315f]">{m.placa}</p>
                      <p className="text-[10px] text-gray-400">{fmtFecha(m.fecha_infraccion)}</p>
                      {m.numero_papeleta && <p className="text-[9px] text-gray-400">N° {m.numero_papeleta}</p>}
                    </td>
                    <td className="p-3">
                      <p className="text-xs font-medium text-gray-800">{m.conductor_nombre || "-"}</p>
                      {m.puntos > 0 && (
                        <p className="text-[10px] font-bold" style={{ color: m.puntos >= 50 ? "#991b1b" : m.puntos >= 20 ? "#92400e" : "#475569" }}>
                          {m.puntos} pts
                        </p>
                      )}
                    </td>
                    <td className="p-3">
                      <p className="text-xs font-bold text-gray-700">{m.entidad}</p>
                      {m.codigo_infraccion && <p className="text-[10px] text-gray-400">{m.codigo_infraccion}</p>}
                    </td>
                    <td className="p-3 max-w-[180px]">
                      <p className="text-xs font-medium text-gray-800 truncate">{m.infraccion}</p>
                      {m.ubicacion && <p className="text-[10px] text-gray-400 truncate">{m.ubicacion}</p>}
                    </td>
                    <td className="p-3">
                      <p className="font-bold text-gray-900 text-xs">{fmtSoles(Number(m.monto_original))}</p>
                    </td>
                    <td className="p-3">
                      {ppActivo ? (
                        <div>
                          <p className="font-bold text-xs text-green-700">{fmtSoles(m.monto_pronto_pago || 0)}</p>
                          <p className="text-[9px] text-gray-400">Ahorro: {fmtSoles(ahorroPP)}</p>
                          <p className={`text-[10px] font-bold ${diasPP !== null && diasPP <= 2 ? "text-red-600" : "text-amber-600"}`}>
                            {diasPP === 0 ? "¡Vence HOY!" : `${diasPP}d restantes`}
                          </p>
                        </div>
                      ) : (
                        <span className="text-[10px] text-gray-300">
                          {m.estado === "Pagada" ? "Pagada" : "No aplica"}
                        </span>
                      )}
                    </td>
                    <td className="p-3">
                      {m.fecha_vencimiento ? (
                        <div>
                          <p className="text-xs text-gray-600">{fmtFecha(m.fecha_vencimiento)}</p>
                          {urgente && (
                            <p className="text-[10px] font-bold text-red-600">
                              {venceHoy ? "¡Vence HOY!" : `${diasVenc}d`}
                            </p>
                          )}
                        </div>
                      ) : <span className="text-[10px] text-gray-300">-</span>}
                    </td>
                    <td className="p-3">
                      <select
                        value={m.estado}
                        onChange={e => cambiarEstado(m.id, e.target.value as EstadoMulta)}
                        className="text-xs font-bold px-2 py-1 rounded-lg border-0 cursor-pointer"
                        style={{ background: estCfg.bg, color: estCfg.color }}
                      >
                        {(["Pendiente","Pagada","Impugnada","Vencida","En proceso"] as EstadoMulta[]).map(e => (
                          <option key={e} value={e}>{e}</option>
                        ))}
                      </select>
                    </td>
                    <td className="p-3">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: sevCfg.bg, color: sevCfg.color }}>
                        {m.severidad}
                      </span>
                      <p className="text-[10px] text-gray-400 mt-0.5">{m.puntos} pts</p>
                    </td>
                    <td className="p-3">
                      <button onClick={() => eliminar(m.id)} className="text-red-400 hover:bg-red-50 px-2 py-1 rounded-lg text-xs font-bold">X</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtradas.length > 0 && (
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between flex-wrap gap-2" style={{ borderColor: "#f1f5f9" }}>
            <span>{filtradas.length} de {multas.length} multas · AFA ERP Operaciones</span>
            <span>Monto pendiente: <b className="text-gray-700">{fmtSoles(kpis.montoPend)}</b> · Pagado total: <b className="text-green-700">{fmtSoles(kpis.montoPag)}</b></span>
          </div>
        )}
      </section>

      {/* MODAL NUEVA MULTA */}
      {mostrarForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(15,23,42,0.6)" }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto">

            <div className="px-6 py-4 border-b flex items-center justify-between sticky top-0 bg-white z-10" style={{ borderColor: "#e2e8f0" }}>
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white" style={{ background: "#0b315f" }}>M</div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">Registrar multa / infracción</h2>
                  <p className="text-[11px] text-gray-400">SAT Lima · SUTRAN · MTC · Municipalidad</p>
                </div>
              </div>
              <button onClick={() => setMostrarForm(false)} className="text-gray-300 hover:text-gray-600 text-2xl leading-none">✕</button>
            </div>

            <div className="px-6 py-5 space-y-5">

              {/* Vehículo y conductor */}
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Vehículo y conductor</p>
                <div className="grid grid-cols-2 gap-4">
                  <Campo label="Vehículo (placa) *">
                    <select className={inputCls()} value={form.vehiculo_id} onChange={e => onPlaca(e.target.value)}>
                      <option value="">Seleccionar vehículo</option>
                      {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa}</option>)}
                    </select>
                    {!form.vehiculo_id && (
                      <input className={`${inputCls()} mt-1`} placeholder="O escribir placa"
                        value={form.placa} onChange={e => setForm(p => ({ ...p, placa: e.target.value.toUpperCase() }))} />
                    )}
                  </Campo>
                  <Campo label="Conductor">
                    <select className={inputCls()} value={form.conductor_id}
                      onChange={e => {
                        const c = conductores.find(c => c.id === Number(e.target.value));
                        setForm(p => ({ ...p, conductor_id: e.target.value, conductor_nombre: c?.nombre || "" }));
                      }}>
                      <option value="">Sin conductor asignado</option>
                      {conductores.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
                    </select>
                  </Campo>
                </div>
              </div>

              {/* Entidad y fecha */}
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Entidad e infracción</p>
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <Campo label="Entidad fiscalizadora *">
                    <select className={inputCls()} value={form.entidad} onChange={e => onEntidad(e.target.value as Entidad)}>
                      {ENTIDADES.map(e => <option key={e}>{e}</option>)}
                    </select>
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      Pronto pago: {PCT_PP[form.entidad]}% dscto. en {DIAS_PP[form.entidad]} días
                    </p>
                  </Campo>
                  <Campo label="Fecha infracción *">
                    <input type="date" className={inputCls()} value={form.fecha_infraccion} onChange={e => onFechaInf(e.target.value)} />
                  </Campo>
                </div>
                <div className="grid grid-cols-4 gap-4">
                  <Campo label="Código">
                    <input className={inputCls()} placeholder="Ej: E.1" value={form.codigo_infraccion} onChange={sf("codigo_infraccion")} />
                  </Campo>
                  <Campo label="Descripción infracción *" span={3}>
                    <input className={inputCls()} placeholder="Ej: Exceso de velocidad en zona urbana"
                      value={form.infraccion} onChange={sf("infraccion")} />
                  </Campo>
                </div>
              </div>

              {/* Severidad y monto */}
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Severidad y monto</p>
                <div className="grid grid-cols-3 gap-4">
                  <Campo label="Severidad *">
                    <select className={inputCls()} value={form.severidad} onChange={e => onSeveridad(e.target.value as Severidad)}>
                      <option>Leve</option><option>Grave</option><option>Muy grave</option>
                    </select>
                  </Campo>
                  <Campo label="Puntos licencia">
                    <input type="number" className={inputCls()} value={form.puntos}
                      onChange={e => setForm(p => ({ ...p, puntos: Number(e.target.value) }))} />
                  </Campo>
                  <Campo label="Monto original S/ *">
                    <input type="number" className={inputCls()} value={form.monto_original}
                      onChange={e => {
                        const monto = Number(e.target.value);
                        const pp = calcProntoP(form.entidad, form.fecha_infraccion, monto);
                        setForm(p => ({ ...p, monto_original: monto, monto_pronto_pago: pp.montoDesc }));
                      }} />
                  </Campo>
                </div>
              </div>

              {/* Pronto pago */}
              <div className="rounded-xl border-2 p-4 space-y-3"
                style={{ borderColor: form.tiene_pronto_pago ? "#6ee7b7" : "#e2e8f0", background: form.tiene_pronto_pago ? "#f0fdf4" : "#f8fafc" }}>
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <input type="checkbox" className="w-4 h-4" checked={form.tiene_pronto_pago}
                    onChange={e => setForm(p => ({ ...p, tiene_pronto_pago: e.target.checked }))} />
                  <div>
                    <p className="text-sm font-bold text-gray-800">Pronto pago disponible</p>
                    <p className="text-[11px] text-gray-500">
                      {form.entidad}: {PCT_PP[form.entidad]}% de descuento si se paga en {DIAS_PP[form.entidad]} días desde la infracción
                    </p>
                  </div>
                </label>
                {form.tiene_pronto_pago && (
                  <div className="grid grid-cols-2 gap-3 pt-1">
                    <Campo label={`Monto con descuento (${PCT_PP[form.entidad]}% off)`}>
                      <input type="number" className={inputCls()} value={form.monto_pronto_pago}
                        onChange={e => setForm(p => ({ ...p, monto_pronto_pago: Number(e.target.value) }))} />
                    </Campo>
                    <Campo label="Fecha límite pronto pago">
                      <input type="date" className={inputCls()} value={form.fecha_limite_pronto_pago}
                        onChange={e => setForm(p => ({ ...p, fecha_limite_pronto_pago: e.target.value }))} />
                    </Campo>
                  </div>
                )}
              </div>

              {/* Datos adicionales */}
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos adicionales</p>
                <div className="grid grid-cols-3 gap-4">
                  <Campo label="N° Papeleta">
                    <input className={inputCls()} value={form.numero_papeleta} onChange={sf("numero_papeleta")} />
                  </Campo>
                  <Campo label="Vencimiento final">
                    <input type="date" className={inputCls()} value={form.fecha_vencimiento} onChange={sf("fecha_vencimiento")} />
                  </Campo>
                  <Campo label="Ubicación">
                    <input className={inputCls()} placeholder="Av. Javier Prado, Lima" value={form.ubicacion} onChange={sf("ubicacion")} />
                  </Campo>
                </div>
                <div className="mt-4">
                  <Campo label="Observaciones">
                    <textarea className={inputCls()} rows={2} value={form.observaciones} onChange={sf("observaciones")}
                      placeholder="Contexto, si fue impugnada, acuerdos, etc." />
                  </Campo>
                </div>
              </div>

              <div className="flex gap-3 pt-1 border-t" style={{ borderColor: "#f1f5f9" }}>
                <button onClick={guardar} disabled={guardando}
                  className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
                  style={{ background: "#0b315f" }}>
                  {guardando ? "Guardando..." : "Registrar multa"}
                </button>
                <button onClick={() => setMostrarForm(false)}
                  className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}