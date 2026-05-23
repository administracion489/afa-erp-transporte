"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Factura = {
  id: number; reserva_id: number | null; cliente_id: number | null;
  cotizacion_id: number | null; tipo_comprobante: string;
  serie: string | null; numero: string | null;
  fecha_emision: string | null; fecha_vencimiento: string | null;
  moneda: string; tipo_cambio: number;
  subtotal: number; igv: number; total: number;
  estado: string; metodo_pago: string | null;
  sunat_estado: string | null; sunat_codigo: string | null;
  detraccion: boolean; monto_detraccion: number;
  nro_op_detraccion: string | null; fecha_detraccion: string | null;
  pdf_url: string | null; xml_url: string | null; cdr_url: string | null;
  items_json: ItemFactura[] | null; observaciones: string | null;
  es_nota_credito: boolean; nota_credito_tipo: string | null;
  nota_credito_ref: string | null; created_at: string;
};

type ItemFactura = {
  descripcion: string; cantidad: number; precio_unit: number; total: number;
};

type Cliente = {
  id: number; nombre: string; empresa?: string; tipo?: string;
  ruc?: string; dni?: string; email?: string; telefono?: string;
  direccion?: string;
};

type Cotizacion = {
  id: number; numero_cotizacion: string | null; origen: string; destino: string;
  precio_cliente: number; cliente_id: number | null; items_json: ItemFactura[] | null;
};

type Reserva = {
  id: number; origen: string; destino: string;
  precio_cliente: number; cliente_id: number | null;
  fecha_servicio: string | null;
};

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const TIPOS_COMP = [
  { valor: "factura",       label: "Factura",           serie: "F001", icon: "🧾", color: "#0b315f", bg: "#eef3f8" },
  { valor: "boleta",        label: "Boleta",            serie: "B001", icon: "📄", color: "#166534", bg: "#dcfce7" },
  { valor: "nota_credito",  label: "Nota de Crédito",   serie: "FC01", icon: "🔴", color: "#991b1b", bg: "#fee2e2" },
];

const TIPOS_NC = [
  { valor: "anulacion",  label: "Anulación total",    desc: "Anula la factura/boleta referenciada completamente" },
  { valor: "descuento",  label: "Descuento / rebaja", desc: "Reducción parcial del monto facturado" },
  { valor: "devolucion", label: "Devolución",          desc: "Por servicio no prestado o parcialmente" },
];

const ESTADOS_FACTURA = {
  emitida:  { label: "Emitida",  bg: "#e0f2fe", color: "#0369a1" },
  enviada:  { label: "Enviada",  bg: "#fef9c3", color: "#854d0e" },
  cobrada:  { label: "Cobrada",  bg: "#dcfce7", color: "#166534" },
  vencida:  { label: "Vencida",  bg: "#fee2e2", color: "#991b1b" },
  anulada:  { label: "Anulada",  bg: "#f3f4f6", color: "#4b5563" },
};

const METODOS_PAGO = [
  { valor: "transferencia", label: "🏦 Transferencia" },
  { valor: "deposito",      label: "🏛️ Depósito bancario" },
  { valor: "yape",          label: "💜 Yape" },
  { valor: "plin",          label: "💚 Plin" },
  { valor: "efectivo",      label: "💵 Efectivo" },
  { valor: "tarjeta",       label: "💳 Tarjeta" },
  { valor: "detraccion",    label: "🏛️ Detracción (BN)" },
  { valor: "credito_30",    label: "📅 Crédito 30 días" },
  { valor: "credito_60",    label: "📅 Crédito 60 días" },
];

const ITEM_VACIO: ItemFactura = { descripcion: "", cantidad: 1, precio_unit: 0, total: 0 };

const FORM_VACIO = {
  tipo_comprobante: "factura", serie: "F001", numero: "",
  cotizacion_id: "", reserva_id: "", cliente_id: "",
  fecha_emision: new Date().toISOString().split("T")[0],
  fecha_vencimiento: "",
  moneda: "PEN", tipo_cambio: "3.80",
  metodo_pago: "transferencia",
  estado: "emitida",
  sunat_estado: "", sunat_codigo: "",
  detraccion: false, nro_op_detraccion: "", fecha_detraccion: "",
  pdf_url: "", xml_url: "", cdr_url: "",
  es_nota_credito: false, nota_credito_tipo: "anulacion", nota_credito_ref: "",
  observaciones: "",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtMonto(n: number, moneda = "PEN") {
  const sym = moneda === "USD" ? "$ " : "S/ ";
  return `${sym}${Number(n || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function diasPara(f: string | null): number | null {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
}
function inputCls(e = "") {
  return `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${e}`;
}
function Campo({ label, span, children, hint }: { label: string; span?: number; hint?: string; children: React.ReactNode }) {
  return (
    <div className={span === 2 ? "md:col-span-2" : span === 3 ? "md:col-span-3" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function FacturacionPage() {
  const [facturas,    setFacturas]    = useState<Factura[]>([]);
  const [clientes,    setClientes]    = useState<Cliente[]>([]);
  const [cotizaciones,setCotizaciones]= useState<Cotizacion[]>([]);
  const [reservas,    setReservas]    = useState<Reserva[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [guardando,   setGuardando]   = useState(false);
  const [editandoId,  setEditandoId]  = useState<number | null>(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [expandidoId, setExpandidoId] = useState<number | null>(null);
  const [busqueda,    setBusqueda]    = useState("");
  const [filtroEst,   setFiltroEst]   = useState("todos");
  const [filtroTipo,  setFiltroTipo]  = useState("todos");
  const [filtroMes,   setFiltroMes]   = useState("todos");
  const [form, setForm]               = useState(FORM_VACIO);
  const [items, setItems]             = useState<ItemFactura[]>([{ ...ITEM_VACIO }]);
  const [pendDespacho, setPendDespacho] = useState(0);
  useEffect(() => {
    // Reservas de Despachador sin factura asociada
    supabase.from("reservas").select("id", { count: "exact", head: true })
      .eq("origen_despacho", true)
      .then(async (res: any) => {
        const count = (res.count as number) || 0;
        if (!count) { setPendDespacho(0); return; }
        const res2 = await supabase
          .from("facturas").select("id", { count: "exact", head: true })
          .not("reserva_id", "is", null);
        const facturadas = (res2.count as number) || 0;
        setPendDespacho(Math.max(0, count - facturadas));
      });
  }, []);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: (e.target as HTMLInputElement).type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));

  // ── Carga ──────────────────────────────────────────────────────────────────

  const cargarDatos = async () => {
    setLoading(true);
    const [fRes, clRes, cotRes, rRes] = await Promise.all([
      supabase.from("facturas").select("*").order("id", { ascending: false }),
      supabase.from("clientes").select("id,nombre,empresa,tipo,ruc,dni,email,telefono,direccion").order("nombre"),
      supabase.from("cotizaciones").select("id,numero_cotizacion,origen,destino,precio_cliente,cliente_id,items_json").eq("estado", "aprobado").order("id", { ascending: false }),
      supabase.from("reservas").select("id,origen,destino,precio_cliente,cliente_id,fecha_servicio").order("id", { ascending: false }).limit(100),
    ]);
    setFacturas(fRes.data   || []);
    setClientes(clRes.data  || []);
    setCotizaciones(cotRes.data || []);
    setReservas(rRes.data   || []);
    setLoading(false);
  };
  useEffect(() => { cargarDatos(); }, []);

  // ── Cálculos ──────────────────────────────────────────────────────────────

  const subtotalCalc = items.reduce((s, it) => s + Number(it.cantidad) * Number(it.precio_unit), 0);
  const igvCalc      = subtotalCalc * 0.18;
  const totalCalc    = subtotalCalc * 1.18;
  const detraccionCalc = form.detraccion && totalCalc >= 700 ? Math.round(totalCalc * 0.10 * 100) / 100 : 0;
  const neto         = totalCalc - detraccionCalc;

  // Autodetección detracción
  const debeDetraccion = totalCalc >= 700;

  // ── Auto-completar desde cotización ───────────────────────────────────────

  const aplicarCotizacion = (cotId: string) => {
    const cot = cotizaciones.find(c => c.id === Number(cotId));
    if (!cot) return;
    setForm(p => ({
      ...p, cotizacion_id: cotId,
      cliente_id: String(cot.cliente_id || ""),
    }));
    if (cot.items_json && cot.items_json.length > 0) {
      setItems(cot.items_json.map(it => ({
        descripcion: (it as any).descripcion || "",
        cantidad: (it as any).cantidad || 1,
        precio_unit: (it as any).precio_unit || 0,
        total: ((it as any).cantidad || 1) * ((it as any).precio_unit || 0),
      })));
    } else {
      const precioSinIgv = Number(cot.precio_cliente) / 1.18;
      setItems([{ descripcion: `Servicio de transporte — ${cot.origen} → ${cot.destino}`, cantidad: 1, precio_unit: Math.round(precioSinIgv * 100) / 100, total: Math.round(precioSinIgv * 100) / 100 }]);
    }
  };

  const aplicarReserva = (resId: string) => {
    const res = reservas.find(r => r.id === Number(resId));
    if (!res) return;
    setForm(p => ({ ...p, reserva_id: resId, cliente_id: String(res.cliente_id || "") }));
    const precioSinIgv = Number(res.precio_cliente) / 1.18;
    setItems([{ descripcion: `Servicio de transporte — ${res.origen} → ${res.destino}`, cantidad: 1, precio_unit: Math.round(precioSinIgv * 100) / 100, total: Math.round(precioSinIgv * 100) / 100 }]);
  };

  const actualizarItem = (i: number, k: keyof ItemFactura, v: string | number) => {
    setItems(prev => prev.map((it, idx) => {
      if (idx !== i) return it;
      const nuevo = { ...it, [k]: k === "descripcion" ? v : Number(v) };
      nuevo.total = nuevo.cantidad * nuevo.precio_unit;
      return nuevo;
    }));
  };

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const limpiar = () => { setForm(FORM_VACIO); setItems([{ ...ITEM_VACIO }]); setEditandoId(null); setMostrarForm(false); };

  const guardar = async () => {
    if (!form.cliente_id) { alert("Selecciona un cliente"); return; }
    if (!form.serie || !form.numero) { alert("Serie y número son obligatorios"); return; }
    if (items.some(it => !it.descripcion.trim())) { alert("Todos los items necesitan descripción"); return; }
    if (form.es_nota_credito && !form.nota_credito_ref.trim()) { alert("Indica el número de comprobante que se referencia"); return; }
    setGuardando(true);
    const payload = {
      cliente_id: Number(form.cliente_id),
      cotizacion_id: form.cotizacion_id ? Number(form.cotizacion_id) : null,
      reserva_id: form.reserva_id ? Number(form.reserva_id) : null,
      tipo_comprobante: form.tipo_comprobante,
      serie: form.serie.trim().toUpperCase(),
      numero: form.numero.trim(),
      fecha_emision: form.fecha_emision || null,
      fecha_vencimiento: form.fecha_vencimiento || null,
      moneda: form.moneda,
      tipo_cambio: form.moneda === "USD" ? Number(form.tipo_cambio) : 1,
      subtotal: subtotalCalc,
      igv: igvCalc,
      // total es columna generada (subtotal + igv) — Supabase la calcula automáticamente
      estado: form.estado,
      metodo_pago: form.metodo_pago || null,
      sunat_estado: form.sunat_estado || null,
      sunat_codigo: form.sunat_codigo || null,
      detraccion: form.detraccion && debeDetraccion,
      monto_detraccion: detraccionCalc,
      nro_op_detraccion: form.nro_op_detraccion.trim() || null,
      fecha_detraccion: form.fecha_detraccion || null,
      pdf_url: form.pdf_url.trim() || null,
      xml_url: form.xml_url.trim() || null,
      cdr_url: form.cdr_url.trim() || null,
      items_json: items,
      es_nota_credito: form.es_nota_credito,
      nota_credito_tipo: form.es_nota_credito ? form.nota_credito_tipo : null,
      nota_credito_ref: form.es_nota_credito ? form.nota_credito_ref.trim() : null,
      observaciones: form.observaciones.trim() || null,
    };
    const { error } = editandoId
      ? await supabase.from("facturas").update(payload).eq("id", editandoId)
      : await supabase.from("facturas").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const editar = (fa: Factura) => {
    setForm({
      tipo_comprobante: fa.tipo_comprobante || "factura",
      serie: fa.serie || "F001", numero: fa.numero || "",
      cotizacion_id: fa.cotizacion_id ? String(fa.cotizacion_id) : "",
      reserva_id: fa.reserva_id ? String(fa.reserva_id) : "",
      cliente_id: fa.cliente_id ? String(fa.cliente_id) : "",
      fecha_emision: fa.fecha_emision || "",
      fecha_vencimiento: fa.fecha_vencimiento || "",
      moneda: fa.moneda || "PEN", tipo_cambio: String(fa.tipo_cambio || "3.80"),
      metodo_pago: fa.metodo_pago || "transferencia",
      estado: fa.estado || "emitida",
      sunat_estado: fa.sunat_estado || "", sunat_codigo: fa.sunat_codigo || "",
      detraccion: fa.detraccion || false,
      nro_op_detraccion: fa.nro_op_detraccion || "", fecha_detraccion: fa.fecha_detraccion || "",
      pdf_url: fa.pdf_url || "", xml_url: fa.xml_url || "", cdr_url: fa.cdr_url || "",
      es_nota_credito: fa.es_nota_credito || false,
      nota_credito_tipo: fa.nota_credito_tipo || "anulacion",
      nota_credito_ref: fa.nota_credito_ref || "",
      observaciones: fa.observaciones || "",
    });
    if (fa.items_json && fa.items_json.length > 0) setItems(fa.items_json);
    setEditandoId(fa.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const cambiarEstado = async (id: number, estado: string) => {
    await supabase.from("facturas").update({ estado }).eq("id", id);
    setFacturas(prev => prev.map(f => f.id === id ? { ...f, estado } : f));
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar este comprobante?")) return;
    await supabase.from("facturas").delete().eq("id", id);
    cargarDatos();
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const hoy          = new Date().toISOString().split("T")[0];
  const totalFacturas= facturas.length;
  const emitidas     = facturas.filter(f => f.estado === "emitida").length;
  const cobradas     = facturas.filter(f => f.estado === "cobrada").length;
  const vencidas     = facturas.filter(f => f.estado !== "anulada" && f.fecha_vencimiento && diasPara(f.fecha_vencimiento)! < 0 && f.estado !== "cobrada").length;
  const detPendientes= facturas.filter(f => f.detraccion && !f.nro_op_detraccion && f.estado !== "anulada").length;
  const totalFacturado = facturas.filter(f => f.estado !== "anulada" && !f.es_nota_credito).reduce((s, f) => s + Number(f.total || 0), 0);
  const totalCobrado   = facturas.filter(f => f.estado === "cobrada").reduce((s, f) => s + Number(f.total || 0), 0);
  const totalPendiente = facturas.filter(f => ["emitida","enviada"].includes(f.estado)).reduce((s, f) => s + Number(f.total || 0), 0);
  const notasCredito   = facturas.filter(f => f.es_nota_credito).length;

  // Meses únicos
  const meses = [...new Set(facturas.map(f => f.fecha_emision?.slice(0, 7)).filter(Boolean))].sort().reverse() as string[];

  // Helpers
  const nombreCliente = (id: number | null) => { const c = clientes.find(c => c.id === id); return c ? (c.empresa || c.nombre) : "—"; };
  const rucCliente    = (id: number | null) => { const c = clientes.find(c => c.id === id); return c?.ruc || c?.dni || "—"; };

  // ── Filtrado ──────────────────────────────────────────────────────────────

  const filtradas = useMemo(() => facturas.filter(f => {
    const q = busqueda.toLowerCase();
    const ncl = nombreCliente(f.cliente_id).toLowerCase();
    const serie = `${f.serie}-${f.numero}`.toLowerCase();
    const txt = `${ncl} ${serie} ${f.observaciones || ""}`.toLowerCase();
    const mes = f.fecha_emision?.slice(0, 7);
    return txt.includes(q) &&
      (filtroEst  === "todos" || f.estado === filtroEst) &&
      (filtroTipo === "todos" || (filtroTipo === "nota_credito" ? f.es_nota_credito : !f.es_nota_credito && f.tipo_comprobante === filtroTipo)) &&
      (filtroMes  === "todos" || mes === filtroMes);
  }), [facturas, busqueda, filtroEst, filtroTipo, filtroMes, clientes]);

  const totalFiltrado = filtradas.reduce((s, f) => s + Number(f.total || 0), 0);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Facturación</h1>
          <p className="text-gray-400 text-sm mt-1">
            Facturas · boletas · notas de crédito · detracción 10% · SUNAT
          </p>
        </div>
        <button onClick={() => { limpiar(); setMostrarForm(v => !v); }}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
          style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
          {mostrarForm ? "✕ Cancelar" : "+ Nuevo comprobante"}
        </button>
      </div>

      {/* ALERTA DESPACHADOR */}
      {pendDespacho > 0 && (
        <div className="rounded-2xl border-2 border-purple-300 bg-purple-50 p-4 flex items-center gap-3">
          <span className="text-2xl">⚡</span>
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-purple-800">Servicios de Despachador pendientes de facturar</p>
            <p className="text-xs text-purple-700 mt-0.5">
              <b>{pendDespacho}</b> servicio{pendDespacho > 1 ? "s" : ""} generado{pendDespacho > 1 ? "s" : ""} por Despachador sin comprobante — revisa en Programación y emite la factura correspondiente.
            </p>
          </div>
          <a href="/despachador" className="ml-auto px-3 py-1.5 rounded-xl text-xs font-bold bg-purple-100 text-purple-700 hover:bg-purple-200 whitespace-nowrap">
            Ver despachador →
          </a>
        </div>
      )}

      {/* ALERTAS */}
      {(vencidas > 0 || detPendientes > 0) && (
        <div className="rounded-2xl border-2 border-red-300 bg-red-50 p-4 space-y-2">
          <p className="text-xs font-black uppercase tracking-widest text-red-800">🚨 Atención requerida</p>
          {vencidas      > 0 && <p className="text-xs text-red-700">• <b>{vencidas}</b> factura{vencidas > 1 ? "s" : ""} vencida{vencidas > 1 ? "s" : ""} sin cobrar — gestionar cobranza urgente</p>}
          {detPendientes > 0 && <p className="text-xs text-red-700">• <b>{detPendientes}</b> detracción{detPendientes > 1 ? "es" : ""} sin número de operación — plazo legal: 5to día hábil del mes siguiente</p>}
        </div>
      )}

      {/* KPIs GLOBALES */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {[
          { label: "Total facturado", valor: fmtMonto(totalFacturado), sub: `${totalFacturas} comprobantes`, color: "#0b315f", bg: "#eef3f8" },
          { label: "Cobrado",         valor: fmtMonto(totalCobrado),   sub: `${cobradas} facturas`,          color: "#166534", bg: "#dcfce7" },
          { label: "Por cobrar",      valor: fmtMonto(totalPendiente), sub: `${emitidas} pendientes`,        color: totalPendiente > 0 ? "#854d0e" : "#166534", bg: totalPendiente > 0 ? "#fef9c3" : "#dcfce7" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-4 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
            <p className="text-[11px] mt-1" style={{ color: k.color + "88" }}>{k.sub}</p>
          </div>
        ))}
      </div>

      {/* KPIs secundarios */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Vencidas",          valor: vencidas,      color: vencidas > 0 ? "#991b1b" : "#166534",       bg: vencidas > 0 ? "#fee2e2" : "#dcfce7" },
          { label: "Det. pendientes",   valor: detPendientes, color: detPendientes > 0 ? "#854d0e" : "#166534",   bg: detPendientes > 0 ? "#fef9c3" : "#dcfce7" },
          { label: "Notas de crédito",  valor: notasCredito,  color: "#991b1b", bg: "#fee2e2" },
          { label: "Cobradas",          valor: cobradas,      color: "#166534", bg: "#dcfce7" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* FORMULARIO */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <h2 className="text-lg font-bold">{editandoId ? "Editar comprobante" : "Nuevo comprobante"}</h2>

          {/* Tipo de comprobante */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Tipo de comprobante</p>
            <div className="grid grid-cols-3 gap-3">
              {TIPOS_COMP.map(t => {
                const act = form.tipo_comprobante === t.valor && !form.es_nota_credito;
                const actNC = t.valor === "nota_credito" && form.es_nota_credito;
                return (
                  <button key={t.valor}
                    onClick={() => {
                      if (t.valor === "nota_credito") {
                        setForm(p => ({ ...p, es_nota_credito: true, tipo_comprobante: "factura", serie: "FC01" }));
                      } else {
                        setForm(p => ({ ...p, es_nota_credito: false, tipo_comprobante: t.valor, serie: t.serie }));
                      }
                    }}
                    className="flex flex-col items-center gap-2 px-4 py-3 rounded-xl border-2 transition-all"
                    style={{ background: (act || actNC) ? t.bg : "white", borderColor: (act || actNC) ? t.color : "#e5e7eb", color: (act || actNC) ? t.color : "#9ca3af" }}>
                    <span className="text-3xl">{t.icon}</span>
                    <span className="font-black text-sm">{t.label}</span>
                    <span className="text-[10px] opacity-70">{t.valor === "nota_credito" ? "Anulación / descuento" : `Serie ${t.serie}`}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Si es Nota de Crédito */}
          {form.es_nota_credito && (
            <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4 space-y-3">
              <p className="text-xs font-black text-red-800 uppercase tracking-wide">📋 Nota de Crédito — Datos de referencia</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label="Tipo de nota de crédito">
                  <select className={inputCls()} value={form.nota_credito_tipo} onChange={f("nota_credito_tipo")}>
                    {TIPOS_NC.map(t => <option key={t.valor} value={t.valor}>{t.label}</option>)}
                  </select>
                  <p className="text-[10px] text-gray-500 mt-0.5">{TIPOS_NC.find(t => t.valor === form.nota_credito_tipo)?.desc}</p>
                </Campo>
                <Campo label="N° Comprobante que se referencia *">
                  <input className={inputCls("font-mono")} placeholder="Ej: F001-00025" value={form.nota_credito_ref} onChange={f("nota_credito_ref")} />
                  <p className="text-[10px] text-gray-500 mt-0.5">Serie y número de la factura/boleta original</p>
                </Campo>
                <Campo label="Serie Nota de Crédito">
                  <input className={inputCls("font-mono uppercase")} placeholder="FC01" value={form.serie} onChange={f("serie")} />
                </Campo>
              </div>
            </div>
          )}

          {/* Vinculación y cliente */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Vinculación y cliente</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Cotización aprobada (opcional)">
                <select className={inputCls()} value={form.cotizacion_id}
                  onChange={e => { f("cotizacion_id")(e); aplicarCotizacion(e.target.value); }}>
                  <option value="">Sin cotización</option>
                  {cotizaciones.map(c => (
                    <option key={c.id} value={c.id}>
                      #{c.numero_cotizacion || c.id} · {c.origen} → {c.destino}
                    </option>
                  ))}
                </select>
              </Campo>
              <Campo label="Reserva (opcional)">
                <select className={inputCls()} value={form.reserva_id}
                  onChange={e => { f("reserva_id")(e); if (!form.cotizacion_id) aplicarReserva(e.target.value); }}>
                  <option value="">Sin reserva</option>
                  {reservas.slice(0, 50).map(r => (
                    <option key={r.id} value={r.id}>#{r.id} · {r.origen} → {r.destino}</option>
                  ))}
                </select>
              </Campo>
              <Campo label="Cliente *">
                <select className={inputCls()} value={form.cliente_id} onChange={f("cliente_id")}>
                  <option value="">Seleccionar cliente</option>
                  {clientes.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.empresa || c.nombre} {c.ruc ? `— RUC ${c.ruc}` : c.dni ? `— DNI ${c.dni}` : ""}
                    </option>
                  ))}
                </select>
              </Campo>

              {/* Datos del cliente seleccionado */}
              {form.cliente_id && (() => {
                const cl = clientes.find(c => c.id === Number(form.cliente_id));
                if (!cl) return null;
                return (
                  <div className="md:col-span-3 rounded-xl px-4 py-3 text-xs flex gap-6 flex-wrap" style={{ background: "#f8fafc" }}>
                    <div><p className="text-gray-400">Cliente</p><p className="font-bold text-gray-800">{cl.empresa || cl.nombre}</p></div>
                    <div><p className="text-gray-400">{cl.ruc ? "RUC" : "DNI"}</p><p className="font-mono font-bold">{cl.ruc || cl.dni || "—"}</p></div>
                    {cl.email && <div><p className="text-gray-400">Email</p><p className="font-bold text-[#0b315f]">{cl.email}</p></div>}
                    {cl.telefono && <div><p className="text-gray-400">Tel</p><p className="font-bold">{cl.telefono}</p></div>}
                    {cl.direccion && <div><p className="text-gray-400">Dirección</p><p className="font-bold text-gray-600">{cl.direccion}</p></div>}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Datos del comprobante */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos del comprobante</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {!form.es_nota_credito && (
                <Campo label="Serie">
                  <input className={inputCls("font-mono uppercase")} value={form.serie} onChange={f("serie")} />
                </Campo>
              )}
              <Campo label="Número *">
                <input className={inputCls("font-mono")} placeholder="00001" value={form.numero} onChange={f("numero")} />
              </Campo>
              <Campo label="Fecha emisión *">
                <input type="date" className={inputCls()} value={form.fecha_emision} onChange={f("fecha_emision")} />
              </Campo>
              <Campo label="Fecha vencimiento">
                <input type="date" className={inputCls()} value={form.fecha_vencimiento} onChange={f("fecha_vencimiento")} />
                {form.fecha_vencimiento && diasPara(form.fecha_vencimiento) !== null && (
                  <p className="text-[10px] mt-0.5 font-bold" style={{ color: diasPara(form.fecha_vencimiento)! < 0 ? "#dc2626" : diasPara(form.fecha_vencimiento)! <= 7 ? "#d97706" : "#166534" }}>
                    {diasPara(form.fecha_vencimiento)! < 0 ? "⚠ Vencida" : `Vence en ${diasPara(form.fecha_vencimiento)}d`}
                  </p>
                )}
              </Campo>
              <Campo label="Moneda">
                <select className={inputCls()} value={form.moneda} onChange={f("moneda")}>
                  <option value="PEN">🇵🇪 Soles (S/)</option>
                  <option value="USD">🇺🇸 Dólares ($)</option>
                </select>
              </Campo>
              {form.moneda === "USD" && (
                <Campo label="Tipo de cambio">
                  <input type="number" step="0.01" className={inputCls("font-mono")} value={form.tipo_cambio} onChange={f("tipo_cambio")} />
                  <p className="text-[10px] text-gray-400 mt-0.5">Total en soles: {fmtMonto(totalCalc * Number(form.tipo_cambio))}</p>
                </Campo>
              )}
              <Campo label="Método de pago">
                <select className={inputCls()} value={form.metodo_pago} onChange={f("metodo_pago")}>
                  {METODOS_PAGO.map(m => <option key={m.valor} value={m.valor}>{m.label}</option>)}
                </select>
              </Campo>
              <Campo label="Estado">
                <select className={inputCls()} value={form.estado} onChange={f("estado")}>
                  <option value="emitida">Emitida</option>
                  <option value="enviada">Enviada al cliente</option>
                  <option value="cobrada">Cobrada</option>
                  <option value="vencida">Vencida</option>
                  <option value="anulada">Anulada</option>
                </select>
              </Campo>
            </div>
          </div>

          {/* Items */}
          <div>
            <div className="flex items-center justify-between border-b pb-1 mb-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Items / Descripción del servicio</p>
              <button onClick={() => setItems(p => [...p, { ...ITEM_VACIO }])} className="text-xs font-bold text-[#0b315f] hover:underline">+ Agregar item</button>
            </div>
            <div className="space-y-2">
              <div className="hidden md:grid grid-cols-12 gap-2 text-[10px] font-bold uppercase tracking-wide text-gray-400 px-2">
                <div className="col-span-6">Descripción</div>
                <div className="col-span-1 text-center">Cant.</div>
                <div className="col-span-2 text-right">P. Unit. ({form.moneda === "USD" ? "$" : "S/"})</div>
                <div className="col-span-2 text-right">Subtotal</div>
                <div className="col-span-1"></div>
              </div>
              {items.map((it, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center bg-gray-50 rounded-xl p-2">
                  <div className="col-span-12 md:col-span-6">
                    <input className={inputCls()} placeholder="Servicio de transporte..." value={it.descripcion} onChange={e => actualizarItem(i, "descripcion", e.target.value)} />
                  </div>
                  <div className="col-span-4 md:col-span-1">
                    <input type="number" min="1" className={inputCls("text-center")} value={it.cantidad} onChange={e => actualizarItem(i, "cantidad", e.target.value)} />
                  </div>
                  <div className="col-span-4 md:col-span-2">
                    <input type="number" min="0" className={inputCls("text-right")} placeholder="0.00" value={it.precio_unit || ""} onChange={e => actualizarItem(i, "precio_unit", e.target.value)} />
                  </div>
                  <div className="col-span-3 md:col-span-2 text-right font-bold text-sm pr-2">{fmtMonto(it.total, form.moneda)}</div>
                  <div className="col-span-1 flex justify-end">
                    {items.length > 1 && <button onClick={() => setItems(p => p.filter((_, idx) => idx !== i))} className="w-7 h-7 rounded-lg text-red-400 hover:bg-red-50 text-sm flex items-center justify-center">✕</button>}
                  </div>
                </div>
              ))}
            </div>

            {/* Totales */}
            <div className="flex justify-end mt-4">
              <div className="w-80 space-y-2 bg-gray-50 rounded-xl p-4">
                <div className="flex justify-between text-sm"><span className="text-gray-500">Subtotal (sin IGV)</span><span className="font-bold">{fmtMonto(subtotalCalc, form.moneda)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-gray-500">IGV 18%</span><span className="font-bold">{fmtMonto(igvCalc, form.moneda)}</span></div>
                <div className="flex justify-between text-lg border-t pt-2" style={{ borderColor: "#0b315f" }}>
                  <span className="font-black">Total</span>
                  <span className="font-black text-[#0b315f]">{fmtMonto(totalCalc, form.moneda)}</span>
                </div>

                {/* DETRACCIÓN */}
                <div className="border-t pt-2 space-y-1.5" style={{ borderColor: "#e5e7eb" }}>
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" className="w-4 h-4 accent-[#0b315f]" checked={form.detraccion} onChange={f("detraccion")} disabled={!debeDetraccion} />
                      <span className="text-xs font-bold text-gray-700">Detracción 10%</span>
                    </label>
                    {!debeDetraccion && <span className="text-[10px] text-gray-400">Solo si total ≥ S/700</span>}
                  </div>
                  {debeDetraccion && (
                    <div className="rounded-xl px-3 py-2 text-xs space-y-1.5" style={{ background: form.detraccion ? "#fef9c3" : "#f8fafc" }}>
                      <div className="flex justify-between font-bold">
                        <span className="text-amber-800">Monto detracción (10%)</span>
                        <span className="text-amber-800 font-mono">{fmtMonto(detraccionCalc)}</span>
                      </div>
                      <div className="flex justify-between text-green-700">
                        <span className="font-bold">Neto a cobrar</span>
                        <span className="font-black font-mono">{fmtMonto(neto, form.moneda)}</span>
                      </div>
                      <p className="text-[9px] text-gray-500">Cta. BN detracción: <b>00-091-069571</b> · Código servicio: 026</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* SUNAT y documentos */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">SUNAT — Estado y documentos</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Estado SUNAT" hint="Aceptada · Rechazada · Pendiente">
                <select className={inputCls()} value={form.sunat_estado} onChange={f("sunat_estado")}>
                  <option value="">Sin registrar</option>
                  <option value="aceptada">✅ Aceptada</option>
                  <option value="rechazada">❌ Rechazada</option>
                  <option value="pendiente">⏳ Pendiente</option>
                  <option value="baja">🚫 Dada de baja</option>
                </select>
              </Campo>
              <Campo label="Código / N° SUNAT" hint="Código de respuesta CDR">
                <input className={inputCls("font-mono")} placeholder="0" value={form.sunat_codigo} onChange={f("sunat_codigo")} />
              </Campo>
              <Campo label="PDF URL" hint="Link del comprobante PDF">
                <input className={inputCls()} placeholder="https://..." value={form.pdf_url} onChange={f("pdf_url")} />
              </Campo>
              <Campo label="XML URL (Clave SOL)">
                <input className={inputCls()} placeholder="https://..." value={form.xml_url} onChange={f("xml_url")} />
              </Campo>
              <Campo label="CDR URL (constancia SUNAT)">
                <input className={inputCls()} placeholder="https://..." value={form.cdr_url} onChange={f("cdr_url")} />
              </Campo>
            </div>
          </div>

          {/* Detracción registrada */}
          {form.detraccion && (
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">🏛️ Registro de detracción depositada</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Campo label="N° Operación Banco de la Nación">
                  <input className={inputCls("font-mono")} placeholder="Número de operación BN" value={form.nro_op_detraccion} onChange={f("nro_op_detraccion")} />
                  <p className="text-[10px] text-gray-400 mt-0.5">Registrar antes del 5to día hábil del mes siguiente</p>
                </Campo>
                <Campo label="Fecha de depósito detracción">
                  <input type="date" className={inputCls()} value={form.fecha_detraccion} onChange={f("fecha_detraccion")} />
                </Campo>
              </div>
            </div>
          )}

          <Campo label="Observaciones">
            <input className={inputCls()} placeholder="Notas internas..." value={form.observaciones} onChange={f("observaciones")} />
          </Campo>

          <div className="flex gap-3">
            <button onClick={guardar} disabled={guardando} className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60" style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar" : "Guardar comprobante"}
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
            placeholder="Buscar cliente, serie, número..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
          <option value="todos">Todos los tipos</option>
          <option value="factura">🧾 Facturas</option>
          <option value="boleta">📄 Boletas</option>
          <option value="nota_credito">🔴 Notas de crédito</option>
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEst} onChange={e => setFiltroEst(e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="emitida">Emitidas</option>
          <option value="enviada">Enviadas</option>
          <option value="cobrada">Cobradas</option>
          <option value="vencida">Vencidas</option>
          <option value="anulada">Anuladas</option>
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroMes} onChange={e => setFiltroMes(e.target.value)}>
          <option value="todos">Todos los meses</option>
          {meses.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400 whitespace-nowrap">
          {filtradas.length} · <b className="ml-1 text-gray-700">{fmtMonto(totalFiltrado)}</b>
        </div>
      </section>

      {/* TABLA */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <th className="p-3 w-8"></th>
                {["Comprobante", "Cliente / RUC", "Fecha", "Vence", "Total", "Detracción", "SUNAT", "Estado", "Acciones"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={10} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2"><div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...</div>
                </td></tr>
              ) : filtradas.length === 0 ? (
                <tr><td colSpan={10} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">🧾</p><p>Sin comprobantes registrados</p>
                </td></tr>
              ) : filtradas.map(fa => {
                const estCfg   = ESTADOS_FACTURA[fa.estado as keyof typeof ESTADOS_FACTURA] || ESTADOS_FACTURA.emitida;
                const expandido= expandidoId === fa.id;
                const dias     = diasPara(fa.fecha_vencimiento);
                const vencida  = dias !== null && dias < 0 && fa.estado !== "cobrada" && fa.estado !== "anulada";
                const tipoCfg  = fa.es_nota_credito ? TIPOS_COMP[2] : TIPOS_COMP.find(t => t.valor === fa.tipo_comprobante) || TIPOS_COMP[0];
                const rowBg    = vencida ? "#fff5f5" : fa.es_nota_credito ? "#fff8f8" : "white";

                return (
                  <React.Fragment key={fa.id}>
                    <tr className="border-t cursor-pointer hover:brightness-95 transition-all"
                      style={{ background: rowBg, borderColor: "#f1f5f9" }}
                      onClick={() => setExpandidoId(expandido ? null : fa.id)}>
                      <td className="p-3 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>

                      {/* Comprobante */}
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className="text-lg">{tipoCfg.icon}</span>
                          <div>
                            <p className="font-black font-mono text-gray-800">{fa.serie}-{fa.numero}</p>
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                              style={{ background: tipoCfg.bg, color: tipoCfg.color }}>
                              {fa.es_nota_credito ? `NC · ${fa.nota_credito_tipo}` : tipoCfg.label}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* Cliente */}
                      <td className="p-3">
                        <p className="font-bold text-gray-800 max-w-[140px] truncate">{nombreCliente(fa.cliente_id)}</p>
                        <p className="text-[10px] text-gray-400 font-mono">{rucCliente(fa.cliente_id)}</p>
                      </td>

                      {/* Fecha emisión */}
                      <td className="p-3 text-xs text-gray-600">{fmtFecha(fa.fecha_emision)}</td>

                      {/* Vence */}
                      <td className="p-3">
                        {fa.fecha_vencimiento ? (
                          <span className="text-xs font-bold px-2 py-0.5 rounded-lg"
                            style={{ background: vencida ? "#fee2e2" : dias !== null && dias <= 7 ? "#fef9c3" : "#f3f4f6", color: vencida ? "#991b1b" : "#4b5563" }}>
                            {vencida ? `${Math.abs(dias!)}d vencida` : `${dias}d`}
                          </span>
                        ) : <span className="text-gray-300 text-xs">—</span>}
                      </td>

                      {/* Total */}
                      <td className="p-3">
                        <p className="font-black text-gray-800">{fmtMonto(Number(fa.total || 0), fa.moneda)}</p>
                        {fa.moneda === "USD" && <p className="text-[10px] text-gray-400">≈ {fmtMonto(Number(fa.total || 0) * Number(fa.tipo_cambio || 1))}</p>}
                      </td>

                      {/* Detracción */}
                      <td className="p-3">
                        {fa.detraccion ? (
                          <div>
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg"
                              style={{ background: fa.nro_op_detraccion ? "#dcfce7" : "#fef9c3", color: fa.nro_op_detraccion ? "#166534" : "#854d0e" }}>
                              {fa.nro_op_detraccion ? "✅ Depositada" : "⚠️ Pendiente"}
                            </span>
                            <p className="text-[10px] text-gray-400 mt-0.5">{fmtMonto(Number(fa.monto_detraccion || 0))}</p>
                          </div>
                        ) : <span className="text-gray-300 text-xs">—</span>}
                      </td>

                      {/* SUNAT */}
                      <td className="p-3">
                        {fa.sunat_estado ? (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg"
                            style={{ background: fa.sunat_estado === "aceptada" ? "#dcfce7" : fa.sunat_estado === "rechazada" ? "#fee2e2" : "#fef9c3", color: fa.sunat_estado === "aceptada" ? "#166534" : fa.sunat_estado === "rechazada" ? "#991b1b" : "#854d0e" }}>
                            {fa.sunat_estado}
                          </span>
                        ) : <span className="text-gray-300 text-xs">Sin reg.</span>}
                      </td>

                      {/* Estado */}
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <select value={fa.estado} onChange={e => cambiarEstado(fa.id, e.target.value)}
                          className="text-xs font-bold px-2 py-1 rounded-lg border-0 cursor-pointer"
                          style={{ background: estCfg.bg, color: estCfg.color }}>
                          <option value="emitida">Emitida</option>
                          <option value="enviada">Enviada</option>
                          <option value="cobrada">Cobrada</option>
                          <option value="vencida">Vencida</option>
                          <option value="anulada">Anulada</option>
                        </select>
                      </td>

                      {/* Acciones */}
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <div className="flex gap-1 flex-wrap">
                          <button onClick={() => editar(fa)} className="px-2 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                          {fa.pdf_url && <a href={fa.pdf_url} target="_blank" rel="noreferrer" className="px-2 py-1.5 rounded-lg text-xs font-bold border text-[#0b315f]" style={{ background: "#eef3f8" }}>📄</a>}
                          {fa.xml_url && <a href={fa.xml_url} target="_blank" rel="noreferrer" className="px-2 py-1.5 rounded-lg text-xs font-bold border text-green-700" style={{ background: "#dcfce7" }}>XML</a>}
                          <button onClick={() => eliminar(fa.id)} className="px-2 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                        </div>
                      </td>
                    </tr>

                    {/* FILA EXPANDIDA */}
                    {expandido && (
                      <tr style={{ background: "#f8fafc" }} className="border-t">
                        <td colSpan={10} className="px-6 py-4">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Comprobante</p>
                              <p><span className="text-gray-400">Tipo:</span> <b>{fa.es_nota_credito ? "Nota de Crédito" : tipoCfg?.label}</b></p>
                              {fa.es_nota_credito && <p><span className="text-gray-400">Tipo NC:</span> {fa.nota_credito_tipo}</p>}
                              {fa.es_nota_credito && <p><span className="text-gray-400">Ref.:</span> <span className="font-mono font-bold">{fa.nota_credito_ref}</span></p>}
                              <p><span className="text-gray-400">Serie-N°:</span> <span className="font-mono font-bold">{fa.serie}-{fa.numero}</span></p>
                              <p><span className="text-gray-400">Emisión:</span> {fmtFecha(fa.fecha_emision)}</p>
                              <p><span className="text-gray-400">Vencimiento:</span> {fmtFecha(fa.fecha_vencimiento)}</p>
                              <p><span className="text-gray-400">Moneda:</span> {fa.moneda}{fa.moneda === "USD" && ` · TC: ${fa.tipo_cambio}`}</p>
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Importes</p>
                              <div className="flex justify-between"><span className="text-gray-400">Subtotal</span><span className="font-bold">{fmtMonto(Number(fa.subtotal), fa.moneda)}</span></div>
                              <div className="flex justify-between"><span className="text-gray-400">IGV 18%</span><span className="font-bold">{fmtMonto(Number(fa.igv), fa.moneda)}</span></div>
                              <div className="flex justify-between border-t pt-1" style={{ borderColor: "#e5e7eb" }}>
                                <span className="font-black">Total</span><span className="font-black text-[#0b315f]">{fmtMonto(Number(fa.total), fa.moneda)}</span>
                              </div>
                              {fa.detraccion && (
                                <>
                                  <div className="flex justify-between text-amber-700"><span>Detracción 10%</span><span className="font-bold">- {fmtMonto(Number(fa.monto_detraccion))}</span></div>
                                  <div className="flex justify-between text-green-700 border-t pt-1" style={{ borderColor: "#e5e7eb" }}>
                                    <span className="font-bold">Neto a cobrar</span><span className="font-black">{fmtMonto(Number(fa.total) - Number(fa.monto_detraccion))}</span>
                                  </div>
                                </>
                              )}
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Detracción</p>
                              {fa.detraccion ? (
                                <>
                                  <p><span className="text-gray-400">Monto:</span> <b>{fmtMonto(Number(fa.monto_detraccion))}</b></p>
                                  <p><span className="text-gray-400">N° Operación:</span> <span className="font-mono font-bold">{fa.nro_op_detraccion || "⚠ Sin registrar"}</span></p>
                                  <p><span className="text-gray-400">Fecha depósito:</span> {fmtFecha(fa.fecha_detraccion)}</p>
                                  <p className="text-[10px] text-gray-400">Cta. BN: 00-091-069571 · Código: 026</p>
                                </>
                              ) : <p className="text-gray-300">Sin detracción</p>}
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">SUNAT</p>
                              <p><span className="text-gray-400">Estado:</span> <b>{fa.sunat_estado || "—"}</b></p>
                              {fa.sunat_codigo && <p><span className="text-gray-400">Código:</span> <span className="font-mono">{fa.sunat_codigo}</span></p>}
                              <div className="flex gap-1.5 mt-2 flex-wrap">
                                {fa.pdf_url && <a href={fa.pdf_url} target="_blank" rel="noreferrer" className="px-2 py-1 rounded text-[10px] font-bold bg-[#eef3f8] text-[#0b315f]">📄 PDF</a>}
                                {fa.xml_url && <a href={fa.xml_url} target="_blank" rel="noreferrer" className="px-2 py-1 rounded text-[10px] font-bold bg-[#dcfce7] text-green-700">XML</a>}
                                {fa.cdr_url && <a href={fa.cdr_url} target="_blank" rel="noreferrer" className="px-2 py-1 rounded text-[10px] font-bold bg-[#fef9c3] text-amber-700">CDR</a>}
                              </div>
                              {fa.observaciones && <p className="text-gray-500 italic mt-1">"{fa.observaciones}"</p>}
                            </div>
                          </div>

                          {/* Items */}
                          {fa.items_json && fa.items_json.length > 0 && (
                            <div className="mt-4 pt-3 border-t" style={{ borderColor: "#e5e7eb" }}>
                              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Items del comprobante</p>
                              <table className="w-full text-xs">
                                <thead><tr className="border-b" style={{ borderColor: "#e5e7eb" }}>
                                  <th className="pb-1 text-left text-gray-400 font-bold">Descripción</th>
                                  <th className="pb-1 text-center text-gray-400 font-bold w-16">Cant.</th>
                                  <th className="pb-1 text-right text-gray-400 font-bold w-24">P. Unit.</th>
                                  <th className="pb-1 text-right text-gray-400 font-bold w-24">Total</th>
                                </tr></thead>
                                <tbody>
                                  {fa.items_json.map((it, i) => (
                                    <tr key={i} className="border-b last:border-0" style={{ borderColor: "#f1f5f9" }}>
                                      <td className="py-1.5">{it.descripcion}</td>
                                      <td className="py-1.5 text-center">{it.cantidad}</td>
                                      <td className="py-1.5 text-right font-mono">{fmtMonto(it.precio_unit, fa.moneda)}</td>
                                      <td className="py-1.5 text-right font-mono font-bold">{fmtMonto(it.total, fa.moneda)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
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
          <span>{filtradas.length} de {totalFacturas} comprobantes · Total visible: <b className="text-gray-700">{fmtMonto(totalFiltrado)}</b></span>
          <span>AFA ERP · Facturación · SUNAT</span>
        </div>
      </section>
    </main>
  );
}