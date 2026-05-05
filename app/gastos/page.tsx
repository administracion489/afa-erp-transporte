"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ORIGINALES ─────────────────────────────────────────────────────────

type GastoPropio = {
  id: number; fecha: string; categoria: string; tipo_gasto: string | null;
  descripcion: string; monto: number;
  vehiculo_id: number | null; proveedor_id: number | null;
  reserva_id: number | null; conductor_id: number | null;
  empresa_tercerizada_id: number | null;
  metodo_pago: string; comprobante_url: string | null;
  estado: string; observaciones: string | null;
};
type RegCombustible = {
  id: number; fecha: string; vehiculo_id: number | null;
  galones: number; precio_galon: number; total: number;
  grifo: string | null; conductor: string | null;
  tipo_combustible: string | null; unidad: string | null;
};
type RegMantenimiento = {
  id: number; vehiculo_id: number | null; tipo: string | null;
  descripcion: string | null; fecha: string | null;
  costo: number; estado: string | null; proveedor_id: number | null;
};
type RegNeumatico = {
  id: number; vehiculo_id: number | null; marca: string | null;
  medida: string | null; posicion: string | null;
  fecha_instalacion: string | null; costo_compra: number | null;
  estado: string;
};

// ─── TIPO UNIFICADO ───────────────────────────────────────────────────────────

type Fuente = "gasto" | "combustible" | "mantenimiento" | "neumatico";

type EntradaUnificada = {
  key:          string;
  fuente:       Fuente;
  id:           number;
  fecha:        string;
  categoria:    string;
  descripcion:  string;
  monto:        number;
  vehiculo_id:  number | null;
  reserva_id:   number | null;
  estado:       string;
  editable:     boolean;
  href:         string;
  raw:          GastoPropio | RegCombustible | RegMantenimiento | RegNeumatico;
};

// ─── CONFIG ───────────────────────────────────────────────────────────────────

type CatConfig = { label: string; icon: string; color: string; bg: string; tipoGasto: string };

const CATEGORIAS: Record<string, CatConfig> = {
  peajes:             { label: "Peajes",               icon: "🛣️", color: "#7c3aed", bg: "#ede9fe", tipoGasto: "operativo"      },
  viaticos:           { label: "Viáticos",             icon: "🍽️", color: "#0369a1", bg: "#e0f2fe", tipoGasto: "operativo"      },
  estacionamiento:    { label: "Estacionamiento",      icon: "🅿️", color: "#4b5563", bg: "#f3f4f6", tipoGasto: "operativo"      },
  multa:              { label: "Multa / papeleta",     icon: "🚨", color: "#991b1b", bg: "#fee2e2", tipoGasto: "operativo"      },
  conductor_servicio: { label: "Conductor por servicio",icon: "🧑‍✈️",color: "#1d4ed8", bg: "#dbeafe", tipoGasto: "conductor"      },
  pago_tercero:       { label: "Pago empresa terc.",   icon: "🤝", color: "#6d28d9", bg: "#ede9fe", tipoGasto: "tercerizado"    },
  planilla:           { label: "Planilla",             icon: "👥", color: "#166534", bg: "#dcfce7", tipoGasto: "administrativo" },
  seguro:             { label: "Seguro / póliza",      icon: "🛡️", color: "#1d4ed8", bg: "#dbeafe", tipoGasto: "administrativo" },
  impuesto:           { label: "Impuestos / SUNAT",    icon: "🧾", color: "#dc2626", bg: "#fee2e2", tipoGasto: "administrativo" },
  detraccion:         { label: "Detracción",           icon: "🏦", color: "#0b315f", bg: "#eef3f8", tipoGasto: "administrativo" },
  alquiler:           { label: "Alquiler / local",     icon: "🏢", color: "#4b5563", bg: "#f3f4f6", tipoGasto: "administrativo" },
  administrativo:     { label: "Administrativo",       icon: "📋", color: "#4b5563", bg: "#f3f4f6", tipoGasto: "administrativo" },
  otro:               { label: "Otro",                 icon: "💸", color: "#6b7280", bg: "#f9fafb", tipoGasto: "operativo"      },
};

// Categorías de solo lectura (gestionadas desde sus módulos)
const CAT_READONLY: Record<string, CatConfig> = {
  combustible:   { label: "Combustible",   icon: "⛽", color: "#ea580c", bg: "#fff7ed", tipoGasto: "operativo" },
  mantenimiento: { label: "Mantenimiento", icon: "🔧", color: "#854d0e", bg: "#fef9c3", tipoGasto: "operativo" },
  neumaticos:    { label: "Neumáticos",    icon: "🛞", color: "#0f766e", bg: "#f0fdfa", tipoGasto: "operativo" },
};

const GRUPOS_CAT = {
  "⚙️ Operativos":      ["peajes","viaticos","estacionamiento","multa"],
  "🧑‍✈️ Conductor":      ["conductor_servicio"],
  "🤝 Tercerizado":     ["pago_tercero"],
  "📋 Administrativos": ["planilla","seguro","impuesto","detraccion","alquiler","administrativo","otro"],
};

const METODOS_PAGO = [
  { valor: "efectivo",      label: "💵 Efectivo" },
  { valor: "yape",          label: "💜 Yape" },
  { valor: "plin",          label: "💚 Plin" },
  { valor: "transferencia", label: "🏦 Transferencia" },
  { valor: "bcp",           label: "🔵 BCP" },
  { valor: "bbva",          label: "💙 BBVA" },
  { valor: "tarjeta",       label: "💳 Tarjeta" },
  { valor: "detraccion",    label: "🏛️ Detracción" },
  { valor: "credito",       label: "📅 Crédito" },
  { valor: "otro",          label: "🔄 Otro" },
];

const FORM_VACIO = {
  fecha: new Date().toISOString().split("T")[0],
  categoria: "peajes", tipo_gasto: "operativo",
  descripcion: "", monto: "",
  vehiculo_id: "", proveedor_id: "", reserva_id: "",
  conductor_id: "", empresa_tercerizada_id: "",
  metodo_pago: "efectivo", comprobante_url: "",
  estado: "pagado", observaciones: "",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtSoles(n: number) {
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

function BadgeFuente({ fuente }: { fuente: Fuente }) {
  const cfg = {
    gasto:        { label: "Gasto directo", bg: "#f3f4f6", color: "#4b5563" },
    combustible:  { label: "Combustible",   bg: "#fff7ed", color: "#ea580c" },
    mantenimiento:{ label: "Mantenimiento", bg: "#fef9c3", color: "#854d0e" },
    neumatico:    { label: "Neumático",     bg: "#f0fdfa", color: "#0f766e" },
  }[fuente];
  return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>;
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function GastosPage() {
  const router = useRouter();

  const [gastosP,    setGastosP]    = useState<GastoPropio[]>([]);
  const [combustible,setCombustible]= useState<RegCombustible[]>([]);
  const [mantenimien,setMantenimien]= useState<RegMantenimiento[]>([]);
  const [neumaticos, setNeumaticos] = useState<RegNeumatico[]>([]);
  const [vehiculos,  setVehiculos]  = useState<{id:number;placa:string;categoria?:string}[]>([]);
  const [proveedores,setProveedores]= useState<{id:number;nombre:string}[]>([]);
  const [reservas,   setReservas]   = useState<{id:number;origen:string;destino:string;fecha_servicio?:string;precio_cliente?:number}[]>([]);
  const [conductores,setConductores]= useState<{id:number;nombre:string;tipo_contrato?:string}[]>([]);
  const [empresasTer,setEmpresasTer]= useState<{id:number;razon_social:string}[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [guardando,  setGuardando]  = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);
  const [mostrarForm,setMostrarForm]= useState(false);
  const [expandidoKey,setExpandidoKey] = useState<string | null>(null);
  const [busqueda,   setBusqueda]   = useState("");
  const [filtroFuente,setFiltroFuente] = useState("todas");
  const [filtroEst,  setFiltroEst]  = useState("todos");
  const [filtroMes,  setFiltroMes]  = useState("todos");
  const [filtroRes,  setFiltroRes]  = useState("todas");
  const [form, setForm] = useState(FORM_VACIO);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  const cambiarCategoria = (cat: string) => {
    const cfg = CATEGORIAS[cat] || CATEGORIAS.otro;
    setForm(p => ({ ...p, categoria: cat, tipo_gasto: cfg.tipoGasto }));
  };

  // ── Carga ──────────────────────────────────────────────────────────────────

  const cargarDatos = async () => {
    setLoading(true);
    const safe = async (q: Promise<{data:any;error:any}>) => {
      const r = await q; if (r.error) { console.warn(r.error.message); return {data:[]}; } return r;
    };
    const [gRes, cbRes, mRes, nRes, vRes, pRes, rRes, cRes, etRes] = await Promise.all([
      safe(supabase.from("gastos").select("*").order("fecha", { ascending: false })),
      safe(supabase.from("combustible").select("id,fecha,vehiculo_id,galones,precio_galon,total,grifo,conductor,tipo_combustible,unidad").order("fecha", { ascending: false })),
      safe(supabase.from("mantenimiento").select("id,vehiculo_id,tipo,descripcion,fecha,costo,estado,proveedor_id").order("fecha", { ascending: false })),
      safe(supabase.from("neumaticos").select("id,vehiculo_id,marca,medida,posicion,fecha_instalacion,costo_compra,estado").order("fecha_instalacion", { ascending: false })),
      safe(supabase.from("vehiculos").select("id,placa,categoria").order("placa")),
      safe(supabase.from("proveedores").select("id,nombre").order("nombre")),
      safe(supabase.from("reservas").select("id,origen,destino,fecha_servicio,precio_cliente").order("id", { ascending: false })),
      safe(supabase.from("conductores").select("id,nombre,tipo_contrato").order("nombre")),
      safe(supabase.from("empresas_tercerizadas").select("id,razon_social").order("razon_social")),
    ]);
    setGastosP(gRes.data      || []);
    setCombustible(cbRes.data || []);
    setMantenimien(mRes.data  || []);
    setNeumaticos(nRes.data   || []);
    setVehiculos(vRes.data    || []);
    setProveedores(pRes.data  || []);
    setReservas(rRes.data     || []);
    setConductores(cRes.data  || []);
    setEmpresasTer(etRes.data || []);
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  // ── Helpers de nombre ──────────────────────────────────────────────────────

  const nombreVeh   = (id: number | null) => vehiculos.find(v => v.id === id)?.placa || "—";
  const nombreProv  = (id: number | null) => proveedores.find(p => p.id === id)?.nombre || "—";
  const nombreCond  = (id: number | null) => conductores.find(c => c.id === id)?.nombre || "—";
  const nombreEmpT  = (id: number | null) => empresasTer.find(e => e.id === id)?.razon_social || "—";
  const nombreRes   = (id: number | null) => { const r = reservas.find(x => x.id === id); return r ? `#${r.id} ${r.origen} → ${r.destino}` : "—"; };

  // ── Normalizar todo en una sola lista ──────────────────────────────────────

  const entradas = useMemo<EntradaUnificada[]>(() => {
    const lista: EntradaUnificada[] = [];

    // 1. Gastos propios (editables desde aquí)
    gastosP.forEach(g => {
      const cfg = CATEGORIAS[g.categoria] || CAT_READONLY[g.categoria] || CATEGORIAS.otro;
      lista.push({
        key: `g-${g.id}`, fuente: "gasto", id: g.id,
        fecha: g.fecha, categoria: g.categoria,
        descripcion: g.descripcion,
        monto: Number(g.monto || 0),
        vehiculo_id: g.vehiculo_id, reserva_id: g.reserva_id,
        estado: g.estado, editable: true,
        href: "/gastos", raw: g,
      });
    });

    // 2. Combustible — solo lectura, editar en /combustible
    combustible.forEach(c => {
      lista.push({
        key: `c-${c.id}`, fuente: "combustible", id: c.id,
        fecha: c.fecha,  categoria: "combustible",
        descripcion: `${c.tipo_combustible || "Diésel"} · ${c.galones} ${c.unidad || "gal"}${c.grifo ? ` · ${c.grifo}` : ""}${c.conductor ? ` · ${c.conductor}` : ""}`,
        monto: Number(c.total || 0),
        vehiculo_id: c.vehiculo_id, reserva_id: null,
        estado: "pagado", editable: false,
        href: "/combustible", raw: c,
      });
    });

    // 3. Mantenimiento — solo lectura, editar en /mantenimiento
    mantenimien.filter(m => Number(m.costo || 0) > 0).forEach(m => {
      lista.push({
        key: `m-${m.id}`, fuente: "mantenimiento", id: m.id,
        fecha: m.fecha || "", categoria: "mantenimiento",
        descripcion: `${m.tipo || "Mantenimiento"}${m.descripcion ? ` · ${m.descripcion}` : ""}`,
        monto: Number(m.costo || 0),
        vehiculo_id: m.vehiculo_id, reserva_id: null,
        estado: m.estado || "pagado", editable: false,
        href: "/mantenimiento", raw: m,
      });
    });

    // 4. Neumáticos — solo lectura, editar en /neumaticos (solo si tiene costo)
    neumaticos.filter(n => Number(n.costo_compra || 0) > 0).forEach(n => {
      lista.push({
        key: `n-${n.id}`, fuente: "neumatico", id: n.id,
        fecha: n.fecha_instalacion || "", categoria: "neumaticos",
        descripcion: `${n.marca || "Neumático"}${n.medida ? ` ${n.medida}` : ""}${n.posicion ? ` · Pos. ${n.posicion}` : ""}`,
        monto: Number(n.costo_compra || 0),
        vehiculo_id: n.vehiculo_id, reserva_id: null,
        estado: "pagado", editable: false,
        href: "/neumaticos", raw: n,
      });
    });

    // Ordenar por fecha descendente
    return lista.sort((a, b) => {
      if (!a.fecha) return 1; if (!b.fecha) return -1;
      return b.fecha.localeCompare(a.fecha);
    });
  }, [gastosP, combustible, mantenimien, neumaticos]);

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const totalUnificado = entradas.reduce((s, e) => s + e.monto, 0);
  const totalGastosP   = gastosP.reduce((s, g) => s + Number(g.monto || 0), 0);
  const totalCombust   = combustible.reduce((s, c) => s + Number(c.total || 0), 0);
  const totalMant      = mantenimien.reduce((s, m) => s + Number(m.costo || 0), 0);
  const totalNeu       = neumaticos.reduce((s, n) => s + Number(n.costo_compra || 0), 0);
  const pendientes     = gastosP.filter(g => g.estado === "pendiente").length;
  const montoPend      = gastosP.filter(g => g.estado === "pendiente").reduce((s, g) => s + Number(g.monto || 0), 0);

  // Meses únicos de todas las entradas
  const mesesUnicos = [...new Set(entradas.map(e => e.fecha?.slice(0, 7)).filter(Boolean))].sort().reverse();

  // ── Filtrado ──────────────────────────────────────────────────────────────

  const filtradas = useMemo(() => entradas.filter(e => {
    const q   = busqueda.toLowerCase();
    const veh = vehiculos.find(v => v.id === e.vehiculo_id);
    const txt = `${e.descripcion} ${e.categoria} ${veh?.placa || ""}`.toLowerCase();
    const mes = e.fecha?.slice(0, 7);
    return txt.includes(q) &&
      (filtroFuente === "todas"   || e.fuente   === filtroFuente) &&
      (filtroEst    === "todos"   || e.estado   === filtroEst) &&
      (filtroMes    === "todos"   || mes        === filtroMes) &&
      (filtroRes    === "todas"   ||
       (filtroRes === "con_reserva" ? e.reserva_id !== null : e.reserva_id === null));
  }), [entradas, busqueda, filtroFuente, filtroEst, filtroMes, filtroRes, vehiculos]);

  const totalFiltrado = filtradas.reduce((s, e) => s + e.monto, 0);

  // Rentabilidad por reserva (gastos propios vinculados a reserva)
  const rentabilidadReservas = useMemo(() => {
    const map: Record<number, { gastos: number; reserva: typeof reservas[0] }> = {};
    gastosP.filter(g => g.reserva_id && g.estado !== "anulado").forEach(g => {
      const r = reservas.find(r => r.id === g.reserva_id);
      if (!r) return;
      if (!map[r.id]) map[r.id] = { gastos: 0, reserva: r };
      map[r.id].gastos += Number(g.monto || 0);
    });
    return Object.values(map).sort((a, b) => b.gastos - a.gastos);
  }, [gastosP, reservas]);

  // ── CRUD (solo para gastos propios) ───────────────────────────────────────

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const guardar = async () => {
    if (!form.fecha || !form.descripcion || !form.monto) { alert("Fecha, descripción y monto son obligatorios"); return; }
    setGuardando(true);
    const cfg = CATEGORIAS[form.categoria] || CATEGORIAS.otro;
    const payload = {
      fecha: form.fecha, categoria: form.categoria, tipo_gasto: cfg.tipoGasto,
      descripcion: form.descripcion.trim(), monto: Number(form.monto),
      vehiculo_id:            form.vehiculo_id            ? Number(form.vehiculo_id)            : null,
      proveedor_id:           form.proveedor_id           ? Number(form.proveedor_id)           : null,
      reserva_id:             form.reserva_id             ? Number(form.reserva_id)             : null,
      conductor_id:           form.conductor_id           ? Number(form.conductor_id)           : null,
      empresa_tercerizada_id: form.empresa_tercerizada_id ? Number(form.empresa_tercerizada_id) : null,
      metodo_pago: form.metodo_pago,
      comprobante_url: form.comprobante_url.trim() || null,
      estado: form.estado, observaciones: form.observaciones.trim() || null,
    };
    const { error } = editandoId
      ? await supabase.from("gastos").update(payload).eq("id", editandoId)
      : await supabase.from("gastos").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const editar = (g: GastoPropio) => {
    setForm({
      fecha: g.fecha || "", categoria: g.categoria || "peajes",
      tipo_gasto: g.tipo_gasto || "operativo",
      descripcion: g.descripcion || "", monto: g.monto ? String(g.monto) : "",
      vehiculo_id:            g.vehiculo_id            ? String(g.vehiculo_id)            : "",
      proveedor_id:           g.proveedor_id           ? String(g.proveedor_id)           : "",
      reserva_id:             g.reserva_id             ? String(g.reserva_id)             : "",
      conductor_id:           g.conductor_id           ? String(g.conductor_id)           : "",
      empresa_tercerizada_id: g.empresa_tercerizada_id ? String(g.empresa_tercerizada_id) : "",
      metodo_pago: g.metodo_pago || "efectivo",
      comprobante_url: g.comprobante_url || "",
      estado: g.estado || "pagado", observaciones: g.observaciones || "",
    });
    setEditandoId(g.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar este gasto?")) return;
    await supabase.from("gastos").delete().eq("id", id);
    cargarDatos();
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Gastos</h1>
          <p className="text-gray-400 text-sm mt-1">
            Vista unificada · gastos directos + <span className="text-orange-500 font-bold">⛽ combustible</span> + <span className="text-amber-600 font-bold">🔧 mantenimiento</span> + <span className="text-teal-600 font-bold">🛞 neumáticos</span>
          </p>
        </div>
        <button onClick={() => { limpiar(); setMostrarForm(v => !v); }}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
          style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
          {mostrarForm ? "✕ Cancelar" : "+ Nuevo gasto directo"}
        </button>
      </div>

      {/* ALERTA PENDIENTES */}
      {pendientes > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
          ⚠️ <span><b>{pendientes} gasto{pendientes > 1 ? "s" : ""} pendiente{pendientes > 1 ? "s" : ""} de pago</b> · {fmtSoles(montoPend)}</span>
        </div>
      )}

      {/* KPI GLOBAL */}
      <section className="rounded-2xl border-2 p-4" style={{ background: "#0b315f", borderColor: "#0b315f" }}>
        <p className="text-[10px] font-bold uppercase tracking-widest text-blue-200 mb-1">Gasto total real (todos los módulos)</p>
        <p className="text-4xl font-black text-white">{fmtSoles(totalUnificado)}</p>
        <p className="text-blue-200 text-xs mt-1">{entradas.length} registros de 4 fuentes</p>
      </section>

      {/* KPIs POR FUENTE */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "💸 Gastos directos", valor: totalGastosP, count: gastosP.length,      color: "#4b5563", bg: "#f3f4f6", href: null         },
          { label: "⛽ Combustible",      valor: totalCombust, count: combustible.length,  color: "#ea580c", bg: "#fff7ed", href: "/combustible" },
          { label: "🔧 Mantenimiento",   valor: totalMant,    count: mantenimien.filter(m => m.costo > 0).length, color: "#854d0e", bg: "#fef9c3", href: "/mantenimiento" },
          { label: "🛞 Neumáticos",      valor: totalNeu,     count: neumaticos.filter(n => (n.costo_compra||0) > 0).length, color: "#0f766e", bg: "#f0fdfa", href: "/neumaticos" },
        ].map(k => (
          <div key={k.label} className={`rounded-xl p-3 border transition-all ${k.href ? "cursor-pointer hover:shadow-md" : ""}`}
            style={{ background: k.bg, borderColor: k.color + "33" }}
            onClick={() => k.href && router.push(k.href)}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-lg font-black mt-0.5" style={{ color: k.color }}>{fmtSoles(k.valor)}</p>
            <p className="text-[10px] mt-0.5" style={{ color: k.color + "88" }}>
              {k.count} registro{k.count !== 1 ? "s" : ""}
              {k.href && <span className="ml-1">· Ver módulo →</span>}
            </p>
          </div>
        ))}
      </section>

      {/* AVISO MÓDULOS SINCRONIZADOS */}
      <div className="rounded-xl border px-4 py-3 text-xs flex items-start gap-3" style={{ background: "#f0fdf4", borderColor: "#86efac" }}>
        <span className="text-lg mt-0.5">✅</span>
        <div className="text-green-800">
          <b>Sincronización automática activa.</b> Los registros de Combustible, Mantenimiento y Neumáticos se leen directamente de sus módulos — sin duplicación. Para editar esos registros usa el módulo correspondiente (botón → en cada fila).
        </div>
      </div>

      {/* RENTABILIDAD POR RESERVA */}
      {rentabilidadReservas.length > 0 && (
        <section className="bg-white rounded-2xl border shadow-sm p-5">
          <h2 className="text-sm font-bold text-gray-700 mb-4">💰 Rentabilidad por reserva (gastos directos)</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {rentabilidadReservas.slice(0, 6).map(d => {
              const precio   = Number(d.reserva.precio_cliente || 0);
              const margen   = precio - d.gastos;
              const margenPct= precio > 0 ? Math.round((margen / precio) * 100) : 0;
              const color    = margen >= 0 ? "#166534" : "#dc2626";
              return (
                <div key={d.reserva.id} className="rounded-xl border px-4 py-3"
                  style={{ borderColor: margen >= 0 ? "#86efac" : "#fca5a5", background: margen >= 0 ? "#f0fdf4" : "#fff5f5" }}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-gray-800 truncate">
                        <span className="font-mono text-[#0b315f]">#{d.reserva.id}</span> · {d.reserva.origen} → {d.reserva.destino}
                      </p>
                      <p className="text-[10px] text-gray-400">{fmtFecha(d.reserva.fecha_servicio || null)}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-black" style={{ color }}>
                        {fmtSoles(margen)} <span className="text-[10px]">({margenPct}%)</span>
                      </p>
                      <p className="text-[10px] text-gray-400">Gastos: {fmtSoles(d.gastos)}</p>
                    </div>
                  </div>
                  {precio > 0 && (
                    <div className="mt-2 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${Math.min(100, (d.gastos / precio) * 100)}%`, background: margen >= 0 ? "#ef4444" : "#dc2626" }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* FORMULARIO — solo gastos directos */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg"
              style={{ background: CATEGORIAS[form.categoria]?.bg || "#f3f4f6" }}>
              {CATEGORIAS[form.categoria]?.icon || "💸"}
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar gasto" : "Nuevo gasto directo"}</h2>
              <p className="text-xs text-gray-400">
                Para combustible, mantenimiento o neumáticos → registra en sus módulos (se sincronizarán aquí automáticamente)
              </p>
            </div>
          </div>

          {/* Accesos directos a módulos sincronizados */}
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: "Registrar combustible", icon: "⛽", color: "#ea580c", bg: "#fff7ed", href: "/combustible" },
              { label: "Registrar mantenimiento", icon: "🔧", color: "#854d0e", bg: "#fef9c3", href: "/mantenimiento" },
              { label: "Registrar neumático", icon: "🛞", color: "#0f766e", bg: "#f0fdfa", href: "/neumaticos" },
            ].map(m => (
              <button key={m.href} onClick={() => router.push(m.href)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 transition-all text-left hover:shadow-sm"
                style={{ background: m.bg, borderColor: m.color + "44", color: m.color }}>
                <span className="text-lg">{m.icon}</span>
                <span className="text-[11px] font-bold">{m.label} →</span>
              </button>
            ))}
          </div>

          {/* Categorías del formulario (sin combustible/mantenimiento/neumaticos) */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Tipo de gasto directo</p>
            {Object.entries(GRUPOS_CAT).map(([grupo, cats]) => (
              <div key={grupo} className="mb-3">
                <p className="text-[10px] font-bold uppercase text-gray-400 mb-1.5">{grupo}</p>
                <div className="grid grid-cols-3 md:grid-cols-6 gap-1.5">
                  {cats.map(cat => {
                    const cfg = CATEGORIAS[cat]; const act = form.categoria === cat;
                    return (
                      <button key={cat} onClick={() => cambiarCategoria(cat)}
                        className="flex flex-col items-center gap-1 px-2 py-2 rounded-xl border-2 transition-all text-center"
                        style={{ background: act ? cfg.bg : "white", borderColor: act ? cfg.color : "#e5e7eb", color: act ? cfg.color : "#9ca3af" }}>
                        <span className="text-base">{cfg.icon}</span>
                        <span className="text-[9px] font-bold leading-tight">{cfg.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos del gasto</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Fecha *"><input type="date" className={inputCls()} value={form.fecha} onChange={f("fecha")} /></Campo>
              <Campo label="Monto S/ *"><input type="number" min="0" className={inputCls()} placeholder="0.00" value={form.monto} onChange={f("monto")} /></Campo>
              <Campo label="Estado">
                <select className={inputCls()} value={form.estado} onChange={f("estado")}>
                  <option value="pagado">✅ Pagado</option>
                  <option value="pendiente">⏳ Pendiente</option>
                  <option value="anulado">❌ Anulado</option>
                </select>
              </Campo>
              <Campo label="Descripción *" span={3}><input className={inputCls()} placeholder="Describe el gasto..." value={form.descripcion} onChange={f("descripcion")} /></Campo>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Vincular a</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Reserva / Servicio">
                <select className={inputCls()} value={form.reserva_id} onChange={f("reserva_id")}>
                  <option value="">Sin reserva</option>
                  {reservas.slice(0, 50).map(r => <option key={r.id} value={r.id}>#{r.id} · {r.origen} → {r.destino}</option>)}
                </select>
              </Campo>
              <Campo label="Vehículo">
                <select className={inputCls()} value={form.vehiculo_id} onChange={f("vehiculo_id")}>
                  <option value="">Sin vehículo</option>
                  {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa} · {v.categoria}</option>)}
                </select>
              </Campo>
              <Campo label={form.categoria === "conductor_servicio" ? "🧑‍✈️ Conductor del servicio *" : "Conductor"}>
                <select className={inputCls(form.categoria === "conductor_servicio" ? "border-blue-400 bg-blue-50" : "")}
                  value={form.conductor_id} onChange={f("conductor_id")}>
                  <option value="">Sin conductor</option>
                  {conductores.map(c => <option key={c.id} value={c.id}>{c.nombre}{c.tipo_contrato && c.tipo_contrato !== "planilla" ? ` · ${c.tipo_contrato}` : ""}</option>)}
                </select>
                {form.categoria === "conductor_servicio" && <p className="text-[10px] text-blue-600 mt-1 font-bold">Se descuenta del margen de la reserva</p>}
              </Campo>
              <Campo label={form.categoria === "pago_tercero" ? "🤝 Empresa tercerizada *" : "Empresa tercerizada"}>
                <select className={inputCls(form.categoria === "pago_tercero" ? "border-purple-400 bg-purple-50" : "")}
                  value={form.empresa_tercerizada_id} onChange={f("empresa_tercerizada_id")}>
                  <option value="">Sin empresa</option>
                  {empresasTer.map(e => <option key={e.id} value={e.id}>{e.razon_social}</option>)}
                </select>
              </Campo>
              <Campo label="Proveedor">
                <select className={inputCls()} value={form.proveedor_id} onChange={f("proveedor_id")}>
                  <option value="">Sin proveedor</option>
                  {proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                </select>
              </Campo>
              <Campo label="Método de pago">
                <select className={inputCls()} value={form.metodo_pago} onChange={f("metodo_pago")}>
                  {METODOS_PAGO.map(m => <option key={m.valor} value={m.valor}>{m.label}</option>)}
                </select>
              </Campo>
            </div>

            {/* Preview margen */}
            {form.reserva_id && form.monto && (() => {
              const reserva = reservas.find(r => r.id === Number(form.reserva_id));
              if (!reserva?.precio_cliente) return null;
              const gastosExist = gastosP.filter(g => g.reserva_id === Number(form.reserva_id) && g.estado !== "anulado" && g.id !== editandoId).reduce((s, g) => s + Number(g.monto || 0), 0);
              const totalConEste = gastosExist + Number(form.monto);
              const margen = Number(reserva.precio_cliente) - totalConEste;
              return (
                <div className="mt-3 rounded-xl px-4 py-3 flex gap-6 items-center flex-wrap" style={{ background: "#eef3f8" }}>
                  <div className="text-xs"><p className="text-gray-400">Precio reserva #{reserva.id}</p><p className="font-black text-gray-800">{fmtSoles(Number(reserva.precio_cliente))}</p></div>
                  <div className="text-xs"><p className="text-gray-400">Total gastos incl. este</p><p className="font-black text-red-700">{fmtSoles(totalConEste)}</p></div>
                  <div className="text-xs"><p className="text-gray-400">Margen estimado</p><p className="font-black text-xl" style={{ color: margen >= 0 ? "#166534" : "#dc2626" }}>{fmtSoles(margen)}</p></div>
                </div>
              );
            })()}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Campo label="URL comprobante"><input className={inputCls()} placeholder="https://..." value={form.comprobante_url} onChange={f("comprobante_url")} /></Campo>
            <Campo label="Observaciones"><input className={inputCls()} placeholder="Notas..." value={form.observaciones} onChange={f("observaciones")} /></Campo>
          </div>

          <div className="flex gap-3">
            <button onClick={guardar} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar" : "Guardar gasto"}
            </button>
            <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* FILTROS */}
      <section className="flex flex-col md:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Buscar por descripción, vehículo..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroFuente} onChange={e => setFiltroFuente(e.target.value)}>
          <option value="todas">Todas las fuentes</option>
          <option value="gasto">💸 Gastos directos</option>
          <option value="combustible">⛽ Combustible</option>
          <option value="mantenimiento">🔧 Mantenimiento</option>
          <option value="neumatico">🛞 Neumáticos</option>
        </select>
        <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroEst} onChange={e => setFiltroEst(e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="pagado">✅ Pagados</option>
          <option value="pendiente">⏳ Pendientes</option>
        </select>
        <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroMes} onChange={e => setFiltroMes(e.target.value)}>
          <option value="todos">Todos los meses</option>
          {mesesUnicos.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroRes} onChange={e => setFiltroRes(e.target.value)}>
          <option value="todas">Con y sin reserva</option>
          <option value="con_reserva">Con reserva</option>
          <option value="sin_reserva">Sin reserva</option>
        </select>
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400 whitespace-nowrap">
          {filtradas.length} · <b className="ml-1 text-gray-700">{fmtSoles(totalFiltrado)}</b>
        </div>
      </section>

      {/* TABLA UNIFICADA */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <th className="p-3 w-8"></th>
                {["Fecha", "Fuente", "Categoría", "Descripción", "Vehículo", "Monto", "Estado", "Acciones"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2"><div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...</div>
                </td></tr>
              ) : filtradas.length === 0 ? (
                <tr><td colSpan={9} className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">💸</p><p>Sin registros</p></td></tr>
              ) : filtradas.map(e => {
                const catCfg   = CAT_READONLY[e.categoria] || CATEGORIAS[e.categoria] || CATEGORIAS.otro;
                const expandido= expandidoKey === e.key;
                const estCfg   = e.estado === "pagado" ? { bg: "#dcfce7", color: "#166534", label: "Pagado" }
                  : e.estado === "pendiente"            ? { bg: "#fef9c3", color: "#854d0e", label: "Pendiente" }
                  :                                       { bg: "#fee2e2", color: "#991b1b", label: "Anulado" };
                const rowBg    = !e.editable ? "#fafafa" : e.estado === "pendiente" ? "#fffbeb" : "white";

                return (
                  <React.Fragment key={e.key}>
                    <tr className="border-t cursor-pointer hover:brightness-95 transition-all"
                      style={{ background: rowBg, borderColor: "#f1f5f9" }}
                      onClick={() => setExpandidoKey(expandido ? null : e.key)}>
                      <td className="p-3 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>
                      <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtFecha(e.fecha)}</td>
                      <td className="p-3"><BadgeFuente fuente={e.fuente} /></td>
                      <td className="p-3">
                        <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: catCfg.bg, color: catCfg.color }}>
                          {catCfg.icon} {catCfg.label}
                        </span>
                      </td>
                      <td className="p-3 text-xs text-gray-700 max-w-[200px]"><div className="truncate">{e.descripcion}</div></td>
                      <td className="p-3 text-xs text-gray-500">{e.vehiculo_id ? nombreVeh(e.vehiculo_id) : "—"}</td>
                      <td className="p-3 font-black text-red-700">{fmtSoles(e.monto)}</td>
                      <td className="p-3">
                        <span className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: estCfg.bg, color: estCfg.color }}>{estCfg.label}</span>
                      </td>
                      <td className="p-3" onClick={ev => ev.stopPropagation()}>
                        {e.editable ? (
                          <div className="flex gap-1.5">
                            <button onClick={() => editar(e.raw as GastoPropio)}
                              className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                            <button onClick={() => eliminar(e.id)}
                              className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                          </div>
                        ) : (
                          <button onClick={() => router.push(e.href)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-600">
                            Editar en módulo →
                          </button>
                        )}
                      </td>
                    </tr>

                    {/* FILA EXPANDIDA */}
                    {expandido && (
                      <tr style={{ background: "#f8fafc" }} className="border-t">
                        <td colSpan={9} className="px-6 py-4">
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-xs">
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Detalle</p>
                              <p><span className="text-gray-400">Fuente:</span> <BadgeFuente fuente={e.fuente} /></p>
                              <p><span className="text-gray-400">Fecha:</span> {fmtFecha(e.fecha)}</p>
                              <p><span className="text-gray-400">Categoría:</span> {catCfg.icon} <b>{catCfg.label}</b></p>
                              <p><span className="text-gray-400">Descripción:</span> {e.descripcion}</p>
                              <p><span className="text-gray-400">Vehículo:</span> {e.vehiculo_id ? nombreVeh(e.vehiculo_id) : "—"}</p>
                            </div>

                            {/* Datos específicos por fuente */}
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">
                                {e.fuente === "gasto" ? "Vínculos" : "Datos del módulo"}
                              </p>
                              {e.fuente === "gasto" && (() => {
                                const g = e.raw as GastoPropio;
                                return <>
                                  {g.reserva_id && <p>🎫 <b>{nombreRes(g.reserva_id)}</b></p>}
                                  {g.conductor_id && <p>🧑‍✈️ <b>{nombreCond(g.conductor_id)}</b></p>}
                                  {g.empresa_tercerizada_id && <p>🤝 <b>{nombreEmpT(g.empresa_tercerizada_id)}</b></p>}
                                  {g.proveedor_id && <p>🏢 <b>{nombreProv(g.proveedor_id)}</b></p>}
                                  <p><span className="text-gray-400">Método:</span> {METODOS_PAGO.find(m => m.valor === g.metodo_pago)?.label || g.metodo_pago}</p>
                                  {g.comprobante_url && <a href={g.comprobante_url} target="_blank" rel="noreferrer" className="text-blue-500 font-bold underline">📄 Comprobante</a>}
                                </>;
                              })()}
                              {e.fuente === "combustible" && (() => {
                                const c = e.raw as RegCombustible;
                                return <>
                                  <p><span className="text-gray-400">Tipo:</span> {c.tipo_combustible || "Diésel"}</p>
                                  <p><span className="text-gray-400">Cantidad:</span> {c.galones} {c.unidad || "gal"}</p>
                                  <p><span className="text-gray-400">Precio/{c.unidad || "gal"}:</span> {fmtSoles(c.precio_galon)}</p>
                                  {c.grifo && <p><span className="text-gray-400">Grifo:</span> {c.grifo}</p>}
                                  {c.conductor && <p><span className="text-gray-400">Conductor:</span> {c.conductor}</p>}
                                </>;
                              })()}
                              {e.fuente === "mantenimiento" && (() => {
                                const m = e.raw as RegMantenimiento;
                                return <>
                                  <p><span className="text-gray-400">Tipo:</span> {m.tipo}</p>
                                  {m.descripcion && <p><span className="text-gray-400">Detalle:</span> {m.descripcion}</p>}
                                  {m.proveedor_id && <p><span className="text-gray-400">Proveedor:</span> {nombreProv(m.proveedor_id)}</p>}
                                  <p><span className="text-gray-400">Estado:</span> {m.estado}</p>
                                </>;
                              })()}
                              {e.fuente === "neumatico" && (() => {
                                const n = e.raw as RegNeumatico;
                                return <>
                                  <p><span className="text-gray-400">Marca:</span> {n.marca}</p>
                                  {n.medida && <p><span className="text-gray-400">Medida:</span> {n.medida}</p>}
                                  {n.posicion && <p><span className="text-gray-400">Posición:</span> {n.posicion}</p>}
                                  <p><span className="text-gray-400">Estado:</span> {n.estado}</p>
                                </>;
                              })()}
                            </div>

                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Monto y acción</p>
                              <p className="text-2xl font-black text-red-700">{fmtSoles(e.monto)}</p>
                              {!e.editable && (
                                <button onClick={() => router.push(e.href)}
                                  className="mt-2 px-4 py-2 rounded-xl text-xs font-bold text-white w-full"
                                  style={{ background: "#0b315f" }}>
                                  Editar en {e.fuente === "combustible" ? "Combustible" : e.fuente === "mantenimiento" ? "Mantenimiento" : "Neumáticos"} →
                                </button>
                              )}
                              {e.fuente === "gasto" && e.reserva_id && (() => {
                                const reserva = reservas.find(r => r.id === e.reserva_id);
                                if (!reserva?.precio_cliente) return null;
                                const gastosRes = gastosP.filter(g => g.reserva_id === e.reserva_id && g.estado !== "anulado").reduce((s, g) => s + Number(g.monto || 0), 0);
                                const margen = Number(reserva.precio_cliente) - gastosRes;
                                return (
                                  <div className="mt-2 rounded-lg px-3 py-2" style={{ background: margen >= 0 ? "#dcfce7" : "#fee2e2" }}>
                                    <p className="text-[9px] font-bold uppercase text-gray-400">Margen reserva #{reserva.id}</p>
                                    <p className="font-black" style={{ color: margen >= 0 ? "#166534" : "#dc2626" }}>{fmtSoles(margen)}</p>
                                  </div>
                                );
                              })()}
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
        <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
          <span>{filtradas.length} de {entradas.length} registros · Total visible: <b className="text-gray-700">{fmtSoles(totalFiltrado)}</b></span>
          <span>AFA ERP · Finanzas · Vista unificada</span>
        </div>
      </section>
    </main>
  );
}