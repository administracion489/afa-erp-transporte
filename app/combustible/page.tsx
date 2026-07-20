"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { registrarLectura } from "@/lib/odometro";
import { sincronizarPrecioDesdeCarga } from "@/lib/precios-combustible";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Vehiculo  = { id: number; placa: string; categoria?: string; kilometraje_actual?: number; };
type Conductor = { id: number; nombre: string; };

type Combustible = {
  id: number; vehiculo_id: number | null;
  fecha: string; kilometraje: number;
  galones: number; precio_galon: number; total: number;
  grifo: string | null; conductor: string | null;
  observaciones: string | null; created_at: string;
  tipo_combustible: string | null;
  unidad: string | null;
};

type VistaActiva = "historial" | "analisis" | "por_vehiculo" | "por_conductor" | "por_grifo" | "por_tipo";
type GranPeriodo = "dia" | "semana" | "mes";

// ─── CONFIGURACIÓN DE COMBUSTIBLES ───────────────────────────────────────────

type FuelConfig = {
  label: string; unidad: string; unidadLabel: string;
  icon: string; color: string; bg: string;
  precioRef: number; // precio referencial Perú S/
  esAditivo: boolean; // UREA es aditivo, no combustible principal
  rendimientoLabel: string; // km/gal, km/m³, etc.
};

const COMBUSTIBLES: Record<string, FuelConfig> = {
  diesel:   { label: "Diésel",        unidad: "galones", unidadLabel: "gal", icon: "🛢️",  color: "#1d4ed8", bg: "#dbeafe", precioRef: 16.5, esAditivo: false, rendimientoLabel: "km/gal" },
  gasolina: { label: "Gasolina",      unidad: "galones", unidadLabel: "gal", icon: "⛽",  color: "#dc2626", bg: "#fee2e2", precioRef: 18.0, esAditivo: false, rendimientoLabel: "km/gal" },
  glp:      { label: "GLP",           unidad: "galones", unidadLabel: "gal", icon: "🔵",  color: "#7c3aed", bg: "#ede9fe", precioRef: 7.65, esAditivo: false, rendimientoLabel: "km/gal" },
  gnv:      { label: "GNV",           unidad: "m3",      unidadLabel: "m³",  icon: "💨",  color: "#0f766e", bg: "#f0fdfa", precioRef: 1.78, esAditivo: false, rendimientoLabel: "km/m³"  },
  urea:     { label: "Urea (AdBlue)", unidad: "litros",  unidadLabel: "lt",  icon: "🧪",  color: "#854d0e", bg: "#fef9c3", precioRef: 5.50, esAditivo: true,  rendimientoLabel: "lt/100km"},
  biodiesel:{ label: "Biodiésel",     unidad: "galones", unidadLabel: "gal", icon: "🌿",  color: "#166534", bg: "#dcfce7", precioRef: 15.0, esAditivo: false, rendimientoLabel: "km/gal" },
};

const CAPACIDAD_TANQUE: Record<string, Record<string, number>> = {
  BUS:     { diesel: 100, gnv: 150, glp: 80,  gasolina: 80,  urea: 30 },
  MINIBUS: { diesel: 60,  gnv: 80,  glp: 50,  gasolina: 50,  urea: 15 },
  VAN:     { diesel: 20,  gnv: 40,  glp: 25,  gasolina: 20,  urea: 10 },
  AUTO:    { diesel: 12,  gnv: 30,  glp: 15,  gasolina: 12,  urea: 5  },
  DEFAULT: { diesel: 80,  gnv: 100, glp: 60,  gasolina: 60,  urea: 20 },
};

function getCapacidad(
  vehOCat: string | { categoria?: string | null; capacidad_tanque?: Record<string, number> | null } | null | undefined,
  tipo: string
): number {
  // La capacidad EDITABLE por vehículo (vehiculos.capacidad_tanque) tiene prioridad sobre la heurística.
  if (vehOCat && typeof vehOCat === "object") {
    const edit = vehOCat.capacidad_tanque?.[tipo];
    if (edit != null && Number(edit) > 0) return Number(edit);
  }
  const categoria = typeof vehOCat === "string" ? vehOCat : vehOCat?.categoria ?? undefined;
  if (!categoria) return CAPACIDAD_TANQUE.DEFAULT[tipo] || 80;
  const cat = categoria.toUpperCase();
  for (const [k, v] of Object.entries(CAPACIDAD_TANQUE)) {
    if (cat.includes(k)) return v[tipo] || v.diesel || 80;
  }
  return CAPACIDAD_TANQUE.DEFAULT[tipo] || 80;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtSoles(n: number) {
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtNum(n: number, dec = 2) {
  return n.toLocaleString("es-PE", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
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

function calcRendimiento(curr: Combustible, prev: Combustible | null): number | null {
  if (!prev || !curr.kilometraje || !prev.kilometraje || !curr.galones) return null;
  const km = Number(curr.kilometraje) - Number(prev.kilometraje);
  if (km <= 0) return null;
  return km / Number(curr.galones);
}

// Clave + etiqueta del período (día/semana/mes) para el análisis de gasto y rendimiento.
function clavePeriodo(fecha: string, gran: GranPeriodo): { key: string; label: string } {
  const d = new Date(fecha + "T00:00:00");
  if (gran === "mes") {
    return { key: fecha.slice(0, 7), label: d.toLocaleDateString("es-PE", { month: "long", year: "numeric" }) };
  }
  if (gran === "semana") {
    const diaLun = (d.getDay() + 6) % 7;            // 0 = lunes
    const lunes = new Date(d);
    lunes.setDate(d.getDate() - diaLun);
    const key = lunes.toISOString().slice(0, 10);
    return { key, label: `Semana del ${lunes.toLocaleDateString("es-PE", { day: "2-digit", month: "short" })}` };
  }
  return { key: fecha, label: d.toLocaleDateString("es-PE", { weekday: "short", day: "2-digit", month: "short" }) };
}

const FORM_VACIO = {
  vehiculo_id: "", fecha: new Date().toISOString().split("T")[0],
  kilometraje: "", galones: "", precio_galon: "",
  tipo_combustible: "diesel", unidad: "galones",
  grifo: "", conductor: "", observaciones: "",
};

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function CombustiblePage() {
  const [vehiculos,   setVehiculos]   = useState<Vehiculo[]>([]);
  const [conductores, setConductores] = useState<Conductor[]>([]);
  const [registros,   setRegistros]   = useState<Combustible[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [guardando,   setGuardando]   = useState(false);
  const [editandoId,  setEditandoId]  = useState<number | null>(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [expandidoId, setExpandidoId] = useState<number | null>(null);
  const [vista,       setVista]       = useState<VistaActiva>("historial");
  const [granularidad,setGranularidad]= useState<GranPeriodo>("mes");
  const [busqueda,    setBusqueda]    = useState("");
  const [filtroVeh,   setFiltroVeh]   = useState("todos");
  const [filtroTipo,  setFiltroTipo]  = useState("todos");
  const [filtroMes,   setFiltroMes]   = useState("todos");
  const [form, setForm] = useState(FORM_VACIO);

  const fuelCfg = COMBUSTIBLES[form.tipo_combustible] || COMBUSTIBLES.diesel;
  const totalPreview = Number(form.galones || 0) * Number(form.precio_galon || 0);

  // Al cambiar tipo de combustible, actualizar unidad automáticamente
  const cambiarTipo = (tipo: string) => {
    const cfg = COMBUSTIBLES[tipo] || COMBUSTIBLES.diesel;
    setForm(p => ({ ...p, tipo_combustible: tipo, unidad: cfg.unidad, precio_galon: String(cfg.precioRef) }));
  };

  const cargarDatos = async () => {
    setLoading(true);
    const [vRes, cRes, condRes] = await Promise.all([
      supabase.from("vehiculos").select("*").order("placa"),
      supabase.from("combustible").select("*").order("fecha", { ascending: false }).order("id", { ascending: false }),
      supabase.from("conductores").select("id,nombre").order("nombre"),
    ]);
    setVehiculos(vRes.data || []);
    setRegistros(cRes.data || []);
    setConductores(condRes.data || []);
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  const nombreVehiculo = (id: number | null) => vehiculos.find(v => v.id === id)?.placa || "—";

  // ── Rendimiento promedio por vehículo+tipo ─────────────────────────────────

  const rendimientoPromedio = useMemo(() => {
    const mapa: Record<string, number | null> = {};
    vehiculos.forEach(v => {
      Object.keys(COMBUSTIBLES).forEach(tipo => {
        const regs = registros
          .filter(r => r.vehiculo_id === v.id && (r.tipo_combustible || "diesel") === tipo && r.kilometraje > 0)
          .sort((a, b) => Number(a.kilometraje) - Number(b.kilometraje));
        if (regs.length < 2) { mapa[`${v.id}-${tipo}`] = null; return; }
        const rends: number[] = [];
        for (let i = 1; i < regs.length; i++) {
          const km  = Number(regs[i].kilometraje) - Number(regs[i - 1].kilometraje);
          const qty = Number(regs[i].galones);
          if (km > 0 && qty > 0) rends.push(km / qty);
        }
        mapa[`${v.id}-${tipo}`] = rends.length > 0 ? rends.reduce((a, b) => a + b) / rends.length : null;
      });
    });
    return mapa;
  }, [vehiculos, registros]);

  // Mapa prev registro
  const prevRegistro = useMemo(() => {
    const mapa: Record<number, Combustible | null> = {};
    const ord = [...registros].sort((a, b) => Number(a.kilometraje) - Number(b.kilometraje));
    ord.forEach((r, i) => {
      const tipo = r.tipo_combustible || "diesel";
      const prev = ord.slice(0, i).reverse().find(x =>
        x.vehiculo_id === r.vehiculo_id &&
        (x.tipo_combustible || "diesel") === tipo &&
        x.kilometraje < r.kilometraje
      );
      mapa[r.id] = prev || null;
    });
    return mapa;
  }, [registros]);

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const guardar = async () => {
    if (!form.vehiculo_id || !form.fecha) { alert("Selecciona vehículo y fecha"); return; }
    if (!form.galones || !form.precio_galon) { alert("Ingresa cantidad y precio"); return; }

    // Alerta capacidad
    const veh = vehiculos.find(v => v.id === Number(form.vehiculo_id));
    const cap = getCapacidad(veh,form.tipo_combustible);
    if (Number(form.galones) > cap * 1.1) {
      const ok = confirm(`⚠️ ALERTA: La cantidad (${form.galones} ${fuelCfg.unidadLabel}) supera la capacidad estimada del tanque de ${form.tipo_combustible} (${cap} ${fuelCfg.unidadLabel}).\n¿Continuar?`);
      if (!ok) return;
    }

    setGuardando(true);
    const payload = {
      vehiculo_id:      Number(form.vehiculo_id),
      fecha:            form.fecha,
      kilometraje:      Number(form.kilometraje || 0),
      galones:          Number(form.galones),
      precio_galon:     Number(form.precio_galon),
      grifo:            form.grifo.trim()         || null,
      conductor:        form.conductor.trim()     || null,
      observaciones:    form.observaciones.trim() || null,
      tipo_combustible: form.tipo_combustible,
      unidad:           form.unidad,
    };

    const { error } = editandoId
      ? await supabase.from("combustible").update(payload).eq("id", editandoId)
      : await supabase.from("combustible").insert(payload);

    if (error) { alert(error.message); setGuardando(false); return; }

    // La carga real es la fuente de precio más actual → actualiza el precio vigente
    // que usa /configuracion/costos (Cotizador). No bloquea el guardado si falla.
    const { data: authData } = await supabase.auth.getUser();
    await sincronizarPrecioDesdeCarga(supabase, {
      tipoCombustible: form.tipo_combustible,
      precio:          Number(form.precio_galon),
      fecha:           form.fecha,
      actualizadoPor:  authData?.user?.email || undefined,
    });

    if (form.kilometraje) {
      if (editandoId) {
        // Edición: ajustar el vigente sin duplicar lectura en el historial
        const v = vehiculos.find(v => v.id === Number(form.vehiculo_id));
        if (v && Number(form.kilometraje) > Number(v.kilometraje_actual || 0)) {
          await supabase.from("vehiculos").update({ kilometraje_actual: Number(form.kilometraje) }).eq("id", Number(form.vehiculo_id));
        }
      } else {
        // Registro nuevo: pasa por la consolidación de odómetro (anti-retroceso)
        await registrarLectura(supabase, {
          vehiculo_id: Number(form.vehiculo_id),
          km: Number(form.kilometraje),
          fuente: "combustible",
          fecha: form.fecha,
          ref_origen: "combustible",
        });
      }
    }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const editar = (r: Combustible) => {
    setForm({
      vehiculo_id:      r.vehiculo_id ? String(r.vehiculo_id) : "",
      fecha:            r.fecha        || "",
      kilometraje:      r.kilometraje  ? String(r.kilometraje)  : "",
      galones:          r.galones      ? String(r.galones)      : "",
      precio_galon:     r.precio_galon ? String(r.precio_galon) : "",
      tipo_combustible: r.tipo_combustible || "diesel",
      unidad:           r.unidad           || "galones",
      grifo:            r.grifo        || "",
      conductor:        r.conductor    || "",
      observaciones:    r.observaciones|| "",
    });
    setEditandoId(r.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar este registro?")) return;
    await supabase.from("combustible").delete().eq("id", id);
    cargarDatos();
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const totalGastado = registros.reduce((s, r) => s + Number(r.total || 0), 0);
  const hoyMes  = new Date().getMonth();
  const hoyAnio = new Date().getFullYear();
  const resMes  = registros.filter(r => { const d = new Date(r.fecha + "T00:00:00"); return d.getMonth() === hoyMes && d.getFullYear() === hoyAnio; });
  const gastoMes= resMes.reduce((s, r) => s + Number(r.total || 0), 0);

  // KPIs por tipo de combustible
  const kpisPorTipo = Object.entries(COMBUSTIBLES).map(([tipo, cfg]) => {
    const regs = registros.filter(r => (r.tipo_combustible || "diesel") === tipo);
    return { tipo, cfg, cantidad: regs.reduce((s, r) => s + Number(r.galones || 0), 0), costo: regs.reduce((s, r) => s + Number(r.total || 0), 0), cargas: regs.length };
  }).filter(d => d.cargas > 0);

  // Anomalías
  const totalAnomalias = registros.filter(r => {
    const tipo = r.tipo_combustible || "diesel";
    if (COMBUSTIBLES[tipo]?.esAditivo) return false;
    const prev = prevRegistro[r.id];
    const rend = calcRendimiento(r, prev);
    const key  = `${r.vehiculo_id}-${tipo}`;
    const promedio = rendimientoPromedio[key];
    const veh  = vehiculos.find(v => v.id === r.vehiculo_id);
    const cap  = getCapacidad(veh,tipo);
    if (Number(r.galones) > cap * 1.1) return true;
    if (rend !== null && promedio && promedio > 0 && ((promedio - rend) / promedio) > 0.3) return true;
    return false;
  }).length;

  // Meses únicos
  const mesesUnicos = [...new Set(registros.map(r => r.fecha?.slice(0, 7)).filter(Boolean))].sort().reverse();

  // ── Filtrado ──────────────────────────────────────────────────────────────

  const filtrados = useMemo(() => registros.filter(r => {
    const v  = vehiculos.find(v => v.id === r.vehiculo_id);
    const q  = busqueda.toLowerCase();
    const txt= `${v?.placa || ""} ${r.grifo || ""} ${r.conductor || ""} ${r.tipo_combustible || ""}`.toLowerCase();
    return txt.includes(q) &&
      (filtroVeh  === "todos" || String(r.vehiculo_id) === filtroVeh) &&
      (filtroTipo === "todos" || (r.tipo_combustible || "diesel") === filtroTipo) &&
      (filtroMes  === "todos" || r.fecha?.slice(0, 7) === filtroMes);
  }), [registros, busqueda, filtroVeh, filtroTipo, filtroMes, vehiculos]);

  // Datos por vehículo
  const datosVehiculo = vehiculos.map(v => {
    const regs = registros.filter(r => r.vehiculo_id === v.id);
    const costo = regs.reduce((s, r) => s + Number(r.total || 0), 0);
    const km    = Number(v.kilometraje_actual || 0);
    const tipos = [...new Set(regs.map(r => r.tipo_combustible || "diesel"))];
    return { vehiculo: v, regs: regs.length, costo, cpk: km > 0 && costo > 0 ? costo / km : null, tipos };
  }).filter(d => d.regs > 0).sort((a, b) => b.costo - a.costo);

  // Datos por conductor
  const conductoresUsados = [...new Set(registros.map(r => r.conductor).filter(Boolean))] as string[];
  const datosConductor = conductoresUsados.map(cond => {
    const regs = registros.filter(r => r.conductor === cond);
    return { conductor: cond, cargas: regs.length, costo: regs.reduce((s, r) => s + Number(r.total || 0), 0) };
  }).sort((a, b) => b.costo - a.costo);

  // Datos por grifo
  const grifosUsados = [...new Set(registros.map(r => r.grifo).filter(Boolean))] as string[];
  const datosGrifo = grifosUsados.map(g => {
    const regs = registros.filter(r => r.grifo === g);
    const precProm = regs.reduce((s, r) => s + Number(r.precio_galon || 0), 0) / regs.length;
    return { grifo: g, cargas: regs.length, costo: regs.reduce((s, r) => s + Number(r.total || 0), 0), precProm };
  }).sort((a, b) => b.costo - a.costo);

  // ── Análisis por período (gasto + rendimiento km/gal por día/semana/mes) ──────
  // Respeta los filtros de arriba (vehículo/tipo/mes/búsqueda). El km recorrido de cada
  // carga sale del tramo entre esa carga y la anterior de la MISMA unidad+tipo (prevRegistro);
  // el rendimiento del período = Σ km / Σ galones (exacto si filtras una unidad+tipo, aproximado
  // si es la flota combinada). Los aditivos (urea) no cuentan para galones ni km.
  const rendLabelAnalisis = filtroTipo !== "todos" ? (COMBUSTIBLES[filtroTipo]?.rendimientoLabel || "km/gal") : "km/gal";
  const analisisPeriodos = useMemo(() => {
    const buckets: Record<string, { key: string; label: string; gasto: number; galones: number; km: number; cargas: number }> = {};
    for (const r of filtrados) {
      const tipo = r.tipo_combustible || "diesel";
      const { key, label } = clavePeriodo(r.fecha, granularidad);
      const b = buckets[key] ?? (buckets[key] = { key, label, gasto: 0, galones: 0, km: 0, cargas: 0 });
      b.gasto += Number(r.total || 0);
      b.cargas += 1;
      if (!COMBUSTIBLES[tipo]?.esAditivo) {
        b.galones += Number(r.galones || 0);
        const prev = prevRegistro[r.id];
        if (prev) {
          const dkm = Number(r.kilometraje) - Number(prev.kilometraje);
          if (dkm > 0) b.km += dkm;
        }
      }
    }
    return Object.values(buckets)
      .map(b => ({ ...b, rendimiento: b.km > 0 && b.galones > 0 ? b.km / b.galones : null }))
      .sort((a, b) => b.key.localeCompare(a.key));
  }, [filtrados, prevRegistro, granularidad]);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Combustible</h1>
          <p className="text-gray-400 text-sm mt-1">
            Diésel · GLP · GNV · Gasolina · Urea · Biodiésel — control multi-combustible con detección de anomalías
          </p>
        </div>
        <button onClick={() => { limpiar(); setMostrarForm(v => !v); }}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
          style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
          {mostrarForm ? "✕ Cancelar" : "⛽ Nueva carga"}
        </button>
      </div>

      {/* ALERTA ANOMALÍAS */}
      {totalAnomalias > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-center gap-3 text-sm text-red-800">
          🚨 <b>{totalAnomalias} registro{totalAnomalias > 1 ? "s" : ""} con anomalías</b> — carga excesiva o rendimiento anormal detectado
        </div>
      )}

      {/* KPIs GLOBALES */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total registros", valor: registros.length,       color: "#0b315f", bg: "#eef3f8" },
          { label: "Gasto total",     valor: fmtSoles(totalGastado), color: "#991b1b", bg: "#fee2e2" },
          { label: "Gasto este mes",  valor: fmtSoles(gastoMes),     color: "#6d28d9", bg: "#ede9fe" },
          { label: "Anomalías",       valor: totalAnomalias,         color: totalAnomalias > 0 ? "#991b1b" : "#166534", bg: totalAnomalias > 0 ? "#fee2e2" : "#dcfce7" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-xl font-black mt-0.5 leading-tight" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* KPIs POR TIPO DE COMBUSTIBLE */}
      {kpisPorTipo.length > 0 && (
        <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          {kpisPorTipo.map(({ tipo, cfg, cantidad, costo, cargas }) => (
            <div key={tipo} className="rounded-xl p-3 border cursor-pointer hover:shadow-sm transition-all"
              style={{ background: cfg.bg, borderColor: cfg.color + "33" }}
              onClick={() => { setFiltroTipo(tipo); setVista("historial"); }}>
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-base">{cfg.icon}</span>
                <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: cfg.color + "99" }}>{cfg.label}</p>
              </div>
              <p className="text-base font-black leading-tight" style={{ color: cfg.color }}>{fmtSoles(costo)}</p>
              <p className="text-[10px] mt-0.5" style={{ color: cfg.color + "88" }}>
                {fmtNum(cantidad)} {cfg.unidadLabel} · {cargas} carga{cargas > 1 ? "s" : ""}
              </p>
              {cfg.esAditivo && <span className="text-[9px] font-bold" style={{ color: cfg.color }}>ADITIVO</span>}
            </div>
          ))}
        </section>
      )}

      {/* FORMULARIO */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>
              {fuelCfg.icon}
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar carga" : "Registrar carga de combustible"}</h2>
              <p className="text-xs text-gray-400">Selecciona el tipo de combustible — la unidad y precio referencial se ajustan automáticamente</p>
            </div>
          </div>

          {/* Selector visual de tipo de combustible */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Tipo de combustible</p>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
              {Object.entries(COMBUSTIBLES).map(([tipo, cfg]) => {
                const activo = form.tipo_combustible === tipo;
                return (
                  <button key={tipo} onClick={() => cambiarTipo(tipo)}
                    className="flex flex-col items-center gap-1 px-3 py-2.5 rounded-xl border-2 transition-all text-center"
                    style={{
                      background:   activo ? cfg.bg      : "white",
                      borderColor:  activo ? cfg.color   : "#e5e7eb",
                      color:        activo ? cfg.color   : "#9ca3af",
                    }}>
                    <span className="text-xl">{cfg.icon}</span>
                    <span className="text-[10px] font-bold">{cfg.label}</span>
                    {cfg.esAditivo && <span className="text-[9px] opacity-70">Aditivo</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Datos */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos de la carga</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Vehículo *">
                <select className={inputCls()} value={form.vehiculo_id} onChange={e => setForm(p => ({ ...p, vehiculo_id: e.target.value }))}>
                  <option value="">Seleccionar vehículo</option>
                  {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa}{v.categoria ? ` · ${v.categoria}` : ""}</option>)}
                </select>
              </Campo>
              <Campo label="Fecha *">
                <input type="date" className={inputCls()} value={form.fecha}
                  onChange={e => setForm(p => ({ ...p, fecha: e.target.value }))} />
              </Campo>
              <Campo label="Kilometraje actual">
                <input type="number" className={inputCls("font-mono")} placeholder="Ej: 150000" value={form.kilometraje}
                  onChange={e => setForm(p => ({ ...p, kilometraje: e.target.value }))} />
              </Campo>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
              Cantidad y precio — <span style={{ color: fuelCfg.color }}>{fuelCfg.label} ({fuelCfg.unidadLabel})</span>
            </p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Campo label={`Cantidad * (${fuelCfg.unidadLabel}) · Cap. ~${form.vehiculo_id ? getCapacidad(vehiculos.find(v => v.id === Number(form.vehiculo_id)),form.tipo_combustible) : "—"} ${fuelCfg.unidadLabel}`}>
                <input type="number" min="0" className={inputCls(
                  form.vehiculo_id && Number(form.galones) > getCapacidad(vehiculos.find(v => v.id === Number(form.vehiculo_id)),form.tipo_combustible) * 1.1
                    ? "border-red-400 bg-red-50" : ""
                )} placeholder={`${fuelCfg.unidadLabel}`} value={form.galones}
                  onChange={e => setForm(p => ({ ...p, galones: e.target.value }))} />
                {form.vehiculo_id && Number(form.galones) > getCapacidad(vehiculos.find(v => v.id === Number(form.vehiculo_id)),form.tipo_combustible) * 1.1 && (
                  <p className="text-xs text-red-600 mt-1 font-bold">⚠ Supera capacidad del tanque</p>
                )}
              </Campo>
              <Campo label={`Precio S/ por ${fuelCfg.unidadLabel} · Ref: ${fmtSoles(fuelCfg.precioRef)}`}>
                <input type="number" min="0" className={inputCls()} placeholder={String(fuelCfg.precioRef)} value={form.precio_galon}
                  onChange={e => setForm(p => ({ ...p, precio_galon: e.target.value }))} />
              </Campo>
              <Campo label="Grifo / Estación">
                <input className={inputCls()} placeholder="Ej: Primax - Ate" value={form.grifo}
                  onChange={e => setForm(p => ({ ...p, grifo: e.target.value }))} />
              </Campo>
              <Campo label="Conductor">
                <select className={inputCls()} value={form.conductor}
                  onChange={e => setForm(p => ({ ...p, conductor: e.target.value }))}>
                  <option value="">Seleccionar conductor</option>
                  {conductores.map(c => <option key={c.id} value={c.nombre}>{c.nombre}</option>)}
                </select>
              </Campo>
            </div>

            {/* Preview total */}
            {totalPreview > 0 && (
              <div className="mt-3 flex items-center gap-6 rounded-xl px-4 py-3" style={{ background: fuelCfg.bg }}>
                <div>
                  <p className="text-[10px] font-bold uppercase" style={{ color: fuelCfg.color + "99" }}>Total calculado</p>
                  <p className="text-2xl font-black" style={{ color: fuelCfg.color }}>{fmtSoles(totalPreview)}</p>
                </div>
                <div className="text-xs" style={{ color: fuelCfg.color + "88" }}>
                  {form.galones} {fuelCfg.unidadLabel} × {fmtSoles(Number(form.precio_galon))} / {fuelCfg.unidadLabel}
                </div>
                {/* Rendimiento esperado */}
                {form.vehiculo_id && !fuelCfg.esAditivo && (() => {
                  const key  = `${form.vehiculo_id}-${form.tipo_combustible}`;
                  const prom = rendimientoPromedio[key];
                  return prom ? (
                    <div className="ml-auto text-right">
                      <p className="text-[10px] font-bold uppercase" style={{ color: fuelCfg.color + "99" }}>Rendimiento histórico</p>
                      <p className="font-black" style={{ color: fuelCfg.color }}>{fmtNum(prom, 1)} {fuelCfg.rendimientoLabel}</p>
                    </div>
                  ) : null;
                })()}
              </div>
            )}
          </div>

          <Campo label="Observaciones" span={3}>
            <input className={inputCls()} placeholder="Notas adicionales..." value={form.observaciones}
              onChange={e => setForm(p => ({ ...p, observaciones: e.target.value }))} />
          </Campo>

          <div className="flex gap-3">
            <button onClick={guardar} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar" : "Guardar carga"}
            </button>
            <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* PESTAÑAS */}
      <div className="flex gap-1 border-b overflow-x-auto">
        {([
          ["historial",     "📋 Historial"],
          ["analisis",      "📈 Análisis"],
          ["por_tipo",      "⛽ Por tipo"],
          ["por_vehiculo",  "🚌 Por vehículo"],
          ["por_conductor", "👤 Por conductor"],
          ["por_grifo",     "🏪 Por grifo"],
        ] as [VistaActiva, string][]).map(([v, l]) => (
          <button key={v} onClick={() => setVista(v)}
            className="px-4 py-2.5 text-sm font-bold border-b-2 -mb-px transition-all whitespace-nowrap"
            style={{ borderColor: vista === v ? "#0b315f" : "transparent", color: vista === v ? "#0b315f" : "#9ca3af" }}>
            {l}
          </button>
        ))}
      </div>

      {/* ── HISTORIAL ── */}
      {vista === "historial" && (
        <>
          <section className="flex flex-col md:flex-row gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[180px]">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
              <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
                placeholder="Buscar por placa, grifo, conductor o combustible..."
                value={busqueda} onChange={e => setBusqueda(e.target.value)} />
            </div>
            <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroVeh} onChange={e => setFiltroVeh(e.target.value)}>
              <option value="todos">Todos los vehículos</option>
              {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa}</option>)}
            </select>
            <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
              <option value="todos">Todos los tipos</option>
              {Object.entries(COMBUSTIBLES).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
            </select>
            <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroMes} onChange={e => setFiltroMes(e.target.value)}>
              <option value="todos">Todos los meses</option>
              {mesesUnicos.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">
              {filtrados.length} resultado{filtrados.length !== 1 ? "s" : ""}
            </div>
          </section>

          <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                    <th className="p-3 w-8"></th>
                    {["Fecha", "Vehículo", "Combustible", "Cantidad", "Precio/ud", "Total", "Rendimiento", "Grifo", "Conductor", "⚠", "Acciones"].map(h => (
                      <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={12} className="p-10 text-center text-gray-400">
                      <div className="flex items-center justify-center gap-2"><div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...</div>
                    </td></tr>
                  ) : filtrados.length === 0 ? (
                    <tr><td colSpan={12} className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">⛽</p><p>No hay registros</p></td></tr>
                  ) : filtrados.map(r => {
                    const tipo    = r.tipo_combustible || "diesel";
                    const cfg     = COMBUSTIBLES[tipo] || COMBUSTIBLES.diesel;
                    const unidLbl = r.unidad === "m3" ? "m³" : r.unidad || "gal";
                    const prev    = prevRegistro[r.id];
                    const rend    = calcRendimiento(r, prev);
                    const key     = `${r.vehiculo_id}-${tipo}`;
                    const promedio= rendimientoPromedio[key];
                    const veh     = vehiculos.find(v => v.id === r.vehiculo_id);
                    const cap     = getCapacidad(veh,tipo);
                    const expandido = expandidoId === r.id;

                    const anomaliaExceso = Number(r.galones) > cap * 1.1;
                    const anomaliaRend   = !cfg.esAditivo && rend !== null && promedio && ((promedio - rend) / promedio) > 0.3;
                    const tieneAnomalia  = anomaliaExceso || anomaliaRend;

                    return (
                      <React.Fragment key={r.id}>
                        <tr className={`border-t transition-colors cursor-pointer ${tieneAnomalia ? "bg-red-50/40" : "hover:bg-gray-50"}`}
                          style={{ borderColor: "#f1f5f9" }}
                          onClick={() => setExpandidoId(expandido ? null : r.id)}>
                          <td className="p-3 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>
                          <td className="p-3 text-xs text-gray-600 font-medium">{fmtFecha(r.fecha)}</td>
                          <td className="p-3 font-mono font-black text-xs text-[#0b315f]">{nombreVehiculo(r.vehiculo_id)}</td>
                          <td className="p-3">
                            <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: cfg.bg, color: cfg.color }}>
                              {cfg.icon} {cfg.label}
                            </span>
                          </td>
                          <td className="p-3 font-bold text-xs" style={{ color: cfg.color }}>
                            {fmtNum(Number(r.galones || 0))} {unidLbl}
                          </td>
                          <td className="p-3 text-xs text-gray-500">{fmtSoles(Number(r.precio_galon || 0))}/{unidLbl}</td>
                          <td className="p-3 font-black text-xs text-red-700">{fmtSoles(Number(r.total || 0))}</td>
                          <td className="p-3 text-xs font-bold">
                            {!cfg.esAditivo && rend !== null
                              ? <span style={{ color: promedio && rend < promedio * 0.7 ? "#dc2626" : "#166534" }}>
                                  {fmtNum(rend, 1)} {cfg.rendimientoLabel}
                                </span>
                              : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="p-3 text-xs text-gray-500 max-w-[90px]"><div className="truncate">{r.grifo || "—"}</div></td>
                          <td className="p-3 text-xs text-gray-500 max-w-[90px]"><div className="truncate">{r.conductor || "—"}</div></td>
                          <td className="p-3 text-center">
                            {tieneAnomalia ? <span className="text-base">🚨</span> : <span className="text-green-500 text-xs">✓</span>}
                          </td>
                          <td className="p-3" onClick={e => e.stopPropagation()}>
                            <div className="flex gap-1.5">
                              <button onClick={() => editar(r)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                              <button onClick={() => eliminar(r.id)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                            </div>
                          </td>
                        </tr>

                        {expandido && (
                          <tr style={{ background: "#f8fafc" }} className="border-t">
                            <td colSpan={12} className="px-6 py-4">
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                                <div className="space-y-1">
                                  <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Carga</p>
                                  <p><span className="text-gray-400">Fecha:</span> {fmtFecha(r.fecha)}</p>
                                  <p><span className="text-gray-400">Vehículo:</span> <b>{nombreVehiculo(r.vehiculo_id)}</b></p>
                                  <p><span className="text-gray-400">KM:</span> <span className="font-mono">{r.kilometraje ? fmtNum(Number(r.kilometraje), 0) : "—"}</span></p>
                                  <p><span className="text-gray-400">Conductor:</span> {r.conductor || "—"}</p>
                                </div>
                                <div className="space-y-1">
                                  <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Combustible</p>
                                  <p><span className="text-gray-400">Tipo:</span> <b style={{ color: cfg.color }}>{cfg.icon} {cfg.label}</b></p>
                                  <p><span className="text-gray-400">Cantidad:</span> <b>{fmtNum(Number(r.galones || 0))} {unidLbl}</b></p>
                                  <p><span className="text-gray-400">Precio/{unidLbl}:</span> {fmtSoles(Number(r.precio_galon || 0))}</p>
                                  <p><span className="text-gray-400">Total:</span> <b className="text-red-700">{fmtSoles(Number(r.total || 0))}</b></p>
                                  <p><span className="text-gray-400">Grifo:</span> {r.grifo || "—"}</p>
                                </div>
                                <div className="space-y-1">
                                  <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Rendimiento</p>
                                  {cfg.esAditivo
                                    ? <p className="text-gray-400 italic">Aditivo — sin cálculo de rendimiento</p>
                                    : <>
                                        <p><span className="text-gray-400">Este tramo:</span> {rend !== null ? <b style={{ color: promedio && rend < promedio * 0.7 ? "#dc2626" : "#166534" }}>{fmtNum(rend, 1)} {cfg.rendimientoLabel}</b> : "—"}</p>
                                        <p><span className="text-gray-400">Prom. vehículo:</span> {promedio ? <b>{fmtNum(promedio, 1)} {cfg.rendimientoLabel}</b> : "—"}</p>
                                        <p><span className="text-gray-400">Cap. tanque:</span> {cap} {unidLbl}</p>
                                      </>}
                                </div>
                                <div className="space-y-1">
                                  <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Estado</p>
                                  {!tieneAnomalia
                                    ? <div className="flex items-center gap-1.5 text-green-700"><span>✅</span><span className="font-bold">Sin anomalías</span></div>
                                    : <>
                                        {anomaliaExceso && <div className="rounded-lg px-2 py-1.5 bg-red-50 text-red-700 text-[10px] font-bold">🚨 Carga ({fmtNum(Number(r.galones))} {unidLbl}) supera capacidad ({cap} {unidLbl})</div>}
                                        {anomaliaRend   && <div className="rounded-lg px-2 py-1.5 bg-red-50 text-red-700 text-[10px] font-bold">🔴 Rendimiento anormal: {fmtNum(rend!, 1)} vs prom. {fmtNum(promedio!, 1)} {cfg.rendimientoLabel}</div>}
                                      </>}
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
            {filtrados.length > 0 && (
              <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
                <span>{filtrados.length} de {registros.length} · Total: {fmtSoles(filtrados.reduce((s, r) => s + Number(r.total || 0), 0))}</span>
                <span>AFA ERP · Flota</span>
              </div>
            )}
          </section>
        </>
      )}

      {/* ── POR TIPO ── */}
      {vista === "por_tipo" && (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {kpisPorTipo.map(({ tipo, cfg, cantidad, costo, cargas }) => (
            <div key={tipo} className="bg-white rounded-2xl border shadow-sm p-5" style={{ borderColor: cfg.color + "33" }}>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ background: cfg.bg }}>{cfg.icon}</div>
                <div>
                  <h3 className="font-black text-gray-900">{cfg.label}</h3>
                  <p className="text-xs text-gray-400">{cfg.unidadLabel} · {cfg.esAditivo ? "Aditivo" : "Combustible"} · {cargas} carga{cargas > 1 ? "s" : ""}</p>
                </div>
                <div className="ml-auto text-right">
                  <p className="text-xl font-black" style={{ color: cfg.color }}>{fmtSoles(costo)}</p>
                  <p className="text-xs text-gray-400">{fmtNum(cantidad)} {cfg.unidadLabel}</p>
                </div>
              </div>
              <div className="text-xs text-gray-500 space-y-1">
                <div className="flex justify-between"><span>Precio ref. Perú:</span><b>{fmtSoles(cfg.precioRef)}/{cfg.unidadLabel}</b></div>
                <div className="flex justify-between"><span>Precio promedio pagado:</span>
                  <b>{(() => { const regs = registros.filter(r => (r.tipo_combustible || "diesel") === tipo); return regs.length > 0 ? fmtSoles(regs.reduce((s, r) => s + Number(r.precio_galon || 0), 0) / regs.length) : "—"; })()}/{cfg.unidadLabel}</b>
                </div>
                <div className="flex justify-between"><span>Rendimiento:</span><span className="text-gray-400">{cfg.rendimientoLabel}</span></div>
              </div>
              <button onClick={() => { setFiltroTipo(tipo); setVista("historial"); }}
                className="mt-3 w-full py-2 rounded-xl text-xs font-bold border hover:bg-gray-50 text-gray-600">
                Ver historial de {cfg.label} →
              </button>
            </div>
          ))}
          {kpisPorTipo.length === 0 && (
            <div className="col-span-2 p-10 text-center text-gray-400 bg-white rounded-2xl border">
              <p className="text-3xl mb-2">⛽</p><p>Sin registros aún</p>
            </div>
          )}
        </section>
      )}

      {/* ── POR VEHÍCULO ── */}
      {vista === "por_vehiculo" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {["Vehículo", "Cargas", "Combustibles usados", "Costo total", "CPK", ""].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {datosVehiculo.map(d => (
                <tr key={d.vehiculo.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                  <td className="p-3 font-mono font-black text-[#0b315f]">{d.vehiculo.placa}<div className="text-xs text-gray-400 font-normal">{d.vehiculo.categoria}</div></td>
                  <td className="p-3 text-gray-600">{d.regs}</td>
                  <td className="p-3">
                    <div className="flex gap-1 flex-wrap">
                      {d.tipos.map(t => { const c = COMBUSTIBLES[t] || COMBUSTIBLES.diesel; return <span key={t} className="text-[10px] font-bold px-2 py-0.5 rounded" style={{ background: c.bg, color: c.color }}>{c.icon} {c.label}</span>; })}
                    </div>
                  </td>
                  <td className="p-3 font-bold text-red-700">{fmtSoles(d.costo)}</td>
                  <td className="p-3 font-bold" style={{ color: d.cpk ? (d.cpk > 0.5 ? "#dc2626" : "#16a34a") : "#9ca3af" }}>
                    {d.cpk ? `S/ ${fmtNum(d.cpk, 3)}/km` : "—"}
                  </td>
                  <td className="p-3">
                    <button onClick={() => { setFiltroVeh(String(d.vehiculo.id)); setVista("historial"); }}
                      className="text-xs font-bold text-[#0b315f] hover:underline">Ver →</button>
                  </td>
                </tr>
              ))}
              {datosVehiculo.length === 0 && <tr><td colSpan={6} className="p-10 text-center text-gray-400">Sin datos</td></tr>}
            </tbody>
          </table>
        </section>
      )}

      {/* ── POR CONDUCTOR ── */}
      {vista === "por_conductor" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {["Conductor", "Cargas", "Gasto total", "Prom. por carga", ""].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {datosConductor.length === 0 ? (
                <tr><td colSpan={5} className="p-10 text-center text-gray-400">Sin conductores en registros</td></tr>
              ) : datosConductor.map(d => (
                <tr key={d.conductor} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                  <td className="p-3 font-bold text-gray-800">👤 {d.conductor}</td>
                  <td className="p-3 text-gray-600">{d.cargas}</td>
                  <td className="p-3 font-bold text-red-700">{fmtSoles(d.costo)}</td>
                  <td className="p-3 text-gray-600">{d.cargas > 0 ? fmtSoles(d.costo / d.cargas) : "—"}</td>
                  <td className="p-3"><button onClick={() => { setVista("historial"); setBusqueda(d.conductor); }} className="text-xs font-bold text-[#0b315f] hover:underline">Ver →</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ── ANÁLISIS (gasto y rendimiento por período) ── */}
      {vista === "analisis" && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-xl border overflow-hidden">
              {([["dia", "Día"], ["semana", "Semana"], ["mes", "Mes"]] as [GranPeriodo, string][]).map(([g, l]) => (
                <button key={g} onClick={() => setGranularidad(g)}
                  className="px-4 py-2 text-sm font-bold transition-all"
                  style={{ background: granularidad === g ? "#0b315f" : "#fff", color: granularidad === g ? "#fff" : "#6b7280" }}>
                  {l}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 flex-1 min-w-[200px]">
              Gasto y rendimiento por período (respeta los filtros de vehículo/tipo).{" "}
              {filtroVeh === "todos" || filtroTipo === "todos"
                ? "Filtra por una unidad y un tipo para un rendimiento exacto; combinado es aproximado."
                : "Rendimiento exacto para el filtro seleccionado."}
            </p>
          </div>

          {/* Resumen del rango */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(() => {
              const totGasto = analisisPeriodos.reduce((s, b) => s + b.gasto, 0);
              const totKm = analisisPeriodos.reduce((s, b) => s + b.km, 0);
              const totGal = analisisPeriodos.reduce((s, b) => s + b.galones, 0);
              const rend = totKm > 0 && totGal > 0 ? totKm / totGal : null;
              const tarjetas = [
                { label: "Gasto en el rango", valor: fmtSoles(totGasto), color: "#991b1b", bg: "#fee2e2" },
                { label: "Km recorridos", valor: totKm > 0 ? `${fmtNum(totKm, 0)} km` : "—", color: "#0b315f", bg: "#eef3f8" },
                { label: "Cantidad total", valor: totGal > 0 ? `${fmtNum(totGal, 1)}` : "—", color: "#6d28d9", bg: "#ede9fe" },
                { label: "Rendimiento prom.", valor: rend != null ? `${fmtNum(rend, 1)} ${rendLabelAnalisis}` : "—", color: "#166534", bg: "#dcfce7" },
              ];
              return tarjetas.map(k => (
                <div key={k.label} className="rounded-2xl p-4" style={{ background: k.bg }}>
                  <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: k.color, opacity: 0.75 }}>{k.label}</p>
                  <p className="text-xl font-black mt-1" style={{ color: k.color }}>{k.valor}</p>
                </div>
              ));
            })()}
          </div>

          {/* Tabla por período */}
          <div className="bg-white rounded-2xl border shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  {["Período", "Cargas", "Cantidad", "Km recorridos", "Gasto", `Rendimiento (${rendLabelAnalisis})`].map(h => (
                    <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {analisisPeriodos.length === 0 ? (
                  <tr><td colSpan={6} className="p-10 text-center text-gray-400">Sin datos en el rango seleccionado</td></tr>
                ) : (() => {
                  const maxGasto = Math.max(...analisisPeriodos.map(x => x.gasto), 1);
                  return analisisPeriodos.map(b => (
                    <tr key={b.key} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                      <td className="p-3 font-bold text-gray-800 capitalize whitespace-nowrap">{b.label}</td>
                      <td className="p-3 text-gray-600">{b.cargas}</td>
                      <td className="p-3 text-gray-600">{b.galones > 0 ? fmtNum(b.galones, 1) : "—"}</td>
                      <td className="p-3 text-gray-600 whitespace-nowrap">{b.km > 0 ? `${fmtNum(b.km, 0)} km` : "—"}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <div className="h-2 rounded-full flex-shrink-0" style={{ width: `${Math.round((b.gasto / maxGasto) * 70)}px`, background: "#991b1b", opacity: 0.25 }} />
                          <span className="font-bold text-red-700 whitespace-nowrap">{fmtSoles(b.gasto)}</span>
                        </div>
                      </td>
                      <td className="p-3 font-bold whitespace-nowrap" style={{ color: b.rendimiento != null ? "#166534" : "#9ca3af" }}>
                        {b.rendimiento != null ? fmtNum(b.rendimiento, 1) : "—"}
                      </td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-400">
            Los km recorridos y el rendimiento se calculan con el odómetro registrado en cada carga (Radar IA, check-in o registro manual).
            En la Fase 3 (Check-in/Check-out) se separará el <b>km de servicio</b> del <b>km fantasma</b> para el costeo por servicio.
          </p>
        </section>
      )}

      {/* ── POR GRIFO ── */}
      {vista === "por_grifo" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {["Grifo / Estación", "Cargas", "Gasto total", "Precio prom./ud", ""].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {datosGrifo.length === 0 ? (
                <tr><td colSpan={5} className="p-10 text-center text-gray-400">Sin grifos registrados</td></tr>
              ) : datosGrifo.map(d => (
                <tr key={d.grifo} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                  <td className="p-3 font-bold text-gray-800">🏪 {d.grifo}</td>
                  <td className="p-3 text-gray-600">{d.cargas}</td>
                  <td className="p-3 font-bold text-red-700">{fmtSoles(d.costo)}</td>
                  <td className="p-3 font-bold text-gray-700">{fmtSoles(d.precProm)}</td>
                  <td className="p-3"><button onClick={() => { setVista("historial"); setBusqueda(d.grifo); }} className="text-xs font-bold text-[#0b315f] hover:underline">Ver →</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}