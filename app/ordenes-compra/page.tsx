"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Proveedor = { id: number; nombre: string; tipo: string; estado: string };
type Vehiculo   = { id: number; placa: string; marca: string | null; modelo: string | null };

type OrdenCompra = {
  id: number; numero: string | null; proveedor_id: number | null; categoria: string;
  vehiculo_id: number | null; fecha_emision: string; fecha_entrega_esperada: string | null;
  estado: string; condicion_pago: string; moneda: string; incluye_igv: boolean;
  subtotal: number; igv: number; total: number; observaciones: string | null;
  comprobante_url: string | null; motivo_anulacion: string | null;
  creado_por: string | null; aprobado_por: string | null; fecha_aprobacion: string | null;
  gasto_id: number | null; created_at: string;
};

type ItemOC = {
  id: number; orden_compra_id: number; descripcion: string; cantidad: number;
  unidad_medida: string; precio_unitario: number; subtotal: number; vehiculo_id: number | null;
};

type ItemForm = { descripcion: string; cantidad: string; unidad_medida: string; precio_unitario: string; vehiculo_id: string };

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const CATEGORIAS_OC: Record<string, { label: string; icon: string; color: string; bg: string }> = {
  taller:          { label: "Taller mecánico",    icon: "🔧", color: "#854d0e", bg: "#fef9c3" },
  grifo:           { label: "Grifo / combustible", icon: "⛽", color: "#ea580c", bg: "#fff7ed" },
  repuestos:       { label: "Repuestos",           icon: "⚙️", color: "#4b5563", bg: "#f3f4f6" },
  seguros:         { label: "Seguros / broker",    icon: "🛡️", color: "#1d4ed8", bg: "#dbeafe" },
  neumaticos:      { label: "Neumáticos",          icon: "🛞", color: "#0f766e", bg: "#f0fdfa" },
  lavadero:        { label: "Lavadero",            icon: "🚿", color: "#0284c7", bg: "#e0f2fe" },
  vulcanizadora:   { label: "Vulcanizadora",       icon: "🔩", color: "#7c3aed", bg: "#ede9fe" },
  electricista:    { label: "Electricista",        icon: "⚡", color: "#d97706", bg: "#fef3c7" },
  administrativo:  { label: "Administrativo",      icon: "📋", color: "#166534", bg: "#dcfce7" },
  otro:            { label: "Otro",                icon: "🏢", color: "#6b7280", bg: "#f9fafb" },
};

const ESTADOS_OC: Record<string, { label: string; icon: string; color: string; bg: string }> = {
  borrador:             { label: "Borrador",         icon: "📝", color: "#6b7280", bg: "#f3f4f6" },
  pendiente_aprobacion: { label: "Pend. aprobación", icon: "⏳", color: "#854d0e", bg: "#fef9c3" },
  aprobada:             { label: "Aprobada",         icon: "✅", color: "#1d4ed8", bg: "#dbeafe" },
  enviada:              { label: "Enviada",          icon: "📤", color: "#7c3aed", bg: "#ede9fe" },
  recibida_parcial:     { label: "Recibida parcial", icon: "📦", color: "#c2410c", bg: "#fff7ed" },
  recibida:             { label: "Recibida",         icon: "📥", color: "#166534", bg: "#dcfce7" },
  anulada:              { label: "Anulada",          icon: "✕",  color: "#991b1b", bg: "#fee2e2" },
};

const CONDICIONES_PAGO: Record<string, string> = {
  contado: "Contado", credito_15: "Crédito 15 días", credito_30: "Crédito 30 días",
  detraccion: "Detracción", otro: "Otro",
};

// Mapeo a la taxonomía de /gastos al generar el gasto desde una OC recibida.
const OC_A_GASTO: Record<string, { categoria: string; tipoGasto: string }> = {
  seguros:        { categoria: "seguro",         tipoGasto: "administrativo" },
  administrativo: { categoria: "administrativo", tipoGasto: "administrativo" },
};

const UNIDADES = ["und", "gal", "kg", "lt", "juego", "servicio", "km"];

const ITEM_VACIO: ItemForm = { descripcion: "", cantidad: "1", unidad_medida: "und", precio_unitario: "0", vehiculo_id: "" };

const FORM_VACIO = {
  proveedor_id: "", categoria: "otro", vehiculo_id: "",
  fecha_emision: new Date().toISOString().split("T")[0],
  fecha_entrega_esperada: "", condicion_pago: "contado", moneda: "PEN",
  incluye_igv: true, comprobante_url: "", observaciones: "",
};

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
function fmtMonto(n: number, moneda = "PEN") {
  const simbolo = moneda === "USD" ? "$" : "S/";
  return `${simbolo} ${Number(n || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function OrdenesCompraPage() {
  const [ordenes,    setOrdenes]    = useState<OrdenCompra[]>([]);
  const [items,      setItems]      = useState<ItemOC[]>([]);
  const [proveedores,setProveedores]= useState<Proveedor[]>([]);
  const [vehiculos,  setVehiculos]  = useState<Vehiculo[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [guardando,  setGuardando]  = useState(false);
  const [usuarioNombre, setUsuarioNombre] = useState<string | null>(null);

  const [editandoId,  setEditandoId]  = useState<number | null>(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [expandidoId, setExpandidoId] = useState<number | null>(null);

  const [busqueda,      setBusqueda]      = useState("");
  const [filtroEstado,  setFiltroEstado]  = useState("todos");
  const [filtroCategoria, setFiltroCategoria] = useState("todos");
  const [filtroProveedor, setFiltroProveedor] = useState("todos");

  const [form, setForm] = useState(FORM_VACIO);
  const [itemsForm, setItemsForm] = useState<ItemForm[]>([ITEM_VACIO]);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  // ── Carga ──────────────────────────────────────────────────────────────────

  const cargarDatos = async () => {
    setLoading(true);
    const [rOc, rItems, rProv, rVeh] = await Promise.all([
      supabase.from("ordenes_compra").select("*").order("created_at", { ascending: false }),
      supabase.from("ordenes_compra_items").select("*"),
      supabase.from("proveedores").select("id,nombre,tipo,estado").order("nombre"),
      supabase.from("vehiculos").select("id,placa,marca,modelo").order("placa"),
    ]);
    if (rOc.error) alert(rOc.error.message);
    setOrdenes(rOc.data || []);
    setItems(rItems.data || []);
    setProveedores(rProv.data || []);
    setVehiculos(rVeh.data || []);
    setLoading(false);
  };

  useEffect(() => {
    cargarDatos();
    (async () => {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user.id;
      if (!uid) return;
      const { data: u } = await supabase.from("usuarios").select("nombre").eq("id", uid).maybeSingle();
      if (u?.nombre) setUsuarioNombre(u.nombre);
    })();
  }, []);

  const provNombre = (id: number | null) => proveedores.find(p => p.id === id)?.nombre || "—";
  const vehLabel = (id: number | null) => {
    const v = vehiculos.find(x => x.id === id);
    return v ? `${v.placa}${v.marca ? ` · ${v.marca}` : ""}` : null;
  };

  // ── Ítems del formulario ─────────────────────────────────────────────────

  const agregarItem = () => setItemsForm(p => [...p, { ...ITEM_VACIO }]);
  const quitarItem   = (idx: number) => setItemsForm(p => p.length > 1 ? p.filter((_, i) => i !== idx) : p);
  const actualizarItem = (idx: number, campo: keyof ItemForm, valor: string) =>
    setItemsForm(p => p.map((it, i) => i === idx ? { ...it, [campo]: valor } : it));

  const itemsValidos = useMemo(
    () => itemsForm.filter(it => it.descripcion.trim() && Number(it.cantidad) > 0),
    [itemsForm]
  );
  const subtotalCalc = useMemo(
    () => itemsValidos.reduce((s, it) => s + Number(it.cantidad || 0) * Number(it.precio_unitario || 0), 0),
    [itemsValidos]
  );
  const igvCalc   = form.incluye_igv ? subtotalCalc * 0.18 : 0;
  const totalCalc = subtotalCalc + igvCalc;

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const limpiar = () => { setForm(FORM_VACIO); setItemsForm([{ ...ITEM_VACIO }]); setEditandoId(null); setMostrarForm(false); };

  const nuevaOC = () => { limpiar(); setMostrarForm(true); };

  const seleccionarProveedor = (id: string) => {
    const prov = proveedores.find(p => p.id === Number(id));
    setForm(p => ({ ...p, proveedor_id: id, categoria: prov && CATEGORIAS_OC[prov.tipo] ? prov.tipo : p.categoria }));
  };

  const guardar = async () => {
    if (!form.proveedor_id) { alert("Selecciona un proveedor"); return; }
    if (itemsValidos.length === 0) { alert("Agrega al menos un ítem con descripción y cantidad"); return; }
    setGuardando(true);

    const payload = {
      proveedor_id: Number(form.proveedor_id), categoria: form.categoria,
      vehiculo_id: form.vehiculo_id ? Number(form.vehiculo_id) : null,
      fecha_emision: form.fecha_emision, fecha_entrega_esperada: form.fecha_entrega_esperada || null,
      condicion_pago: form.condicion_pago, moneda: form.moneda, incluye_igv: form.incluye_igv,
      subtotal: subtotalCalc, igv: igvCalc, total: totalCalc,
      observaciones: form.observaciones.trim() || null,
      comprobante_url: form.comprobante_url.trim() || null,
    };

    let ocId = editandoId;
    if (editandoId) {
      const { error } = await supabase.from("ordenes_compra").update(payload).eq("id", editandoId);
      if (error) { alert(error.message); setGuardando(false); return; }
      await supabase.from("ordenes_compra_items").delete().eq("orden_compra_id", editandoId);
    } else {
      const { data, error } = await supabase.from("ordenes_compra")
        .insert({ ...payload, estado: "borrador", creado_por: usuarioNombre || null })
        .select("id").single();
      if (error) { alert(error.message); setGuardando(false); return; }
      ocId = data.id;
    }

    const itemsPayload = itemsValidos.map(it => ({
      orden_compra_id: ocId,
      descripcion: it.descripcion.trim(),
      cantidad: Number(it.cantidad),
      unidad_medida: it.unidad_medida.trim() || "und",
      precio_unitario: Number(it.precio_unitario || 0),
      subtotal: Number(it.cantidad) * Number(it.precio_unitario || 0),
      vehiculo_id: it.vehiculo_id ? Number(it.vehiculo_id) : null,
    }));
    const { error: errItems } = await supabase.from("ordenes_compra_items").insert(itemsPayload);
    if (errItems) { alert(errItems.message); setGuardando(false); return; }

    limpiar(); cargarDatos(); setGuardando(false);
  };

  const editar = (oc: OrdenCompra) => {
    setForm({
      proveedor_id: oc.proveedor_id ? String(oc.proveedor_id) : "", categoria: oc.categoria || "otro",
      vehiculo_id: oc.vehiculo_id ? String(oc.vehiculo_id) : "",
      fecha_emision: oc.fecha_emision, fecha_entrega_esperada: oc.fecha_entrega_esperada || "",
      condicion_pago: oc.condicion_pago || "contado", moneda: oc.moneda || "PEN",
      incluye_igv: oc.incluye_igv, comprobante_url: oc.comprobante_url || "", observaciones: oc.observaciones || "",
    });
    const itemsDeOC = items.filter(it => it.orden_compra_id === oc.id);
    setItemsForm(itemsDeOC.length
      ? itemsDeOC.map(it => ({
          descripcion: it.descripcion, cantidad: String(it.cantidad), unidad_medida: it.unidad_medida,
          precio_unitario: String(it.precio_unitario), vehiculo_id: it.vehiculo_id ? String(it.vehiculo_id) : "",
        }))
      : [{ ...ITEM_VACIO }]);
    setEditandoId(oc.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const eliminar = async (id: number, numero: string | null) => {
    if (!confirm(`¿Eliminar la orden ${numero || "#" + id}? Esto borra también sus ítems.`)) return;
    await supabase.from("ordenes_compra").delete().eq("id", id);
    cargarDatos();
  };

  const cambiarEstado = async (oc: OrdenCompra, nuevo: string) => {
    if (nuevo === "anulada") {
      const motivo = window.prompt(`Motivo de anulación de ${oc.numero}:`);
      if (motivo === null) return;
      const { error } = await supabase.from("ordenes_compra").update({ estado: "anulada", motivo_anulacion: motivo || null }).eq("id", oc.id);
      if (error) { alert(error.message); return; }
    } else {
      const payload: Record<string, unknown> = { estado: nuevo };
      if (nuevo === "aprobada") { payload.aprobado_por = usuarioNombre || null; payload.fecha_aprobacion = new Date().toISOString(); }
      const { error } = await supabase.from("ordenes_compra").update(payload).eq("id", oc.id);
      if (error) { alert(error.message); return; }
    }
    cargarDatos();
  };

  const registrarGasto = async (oc: OrdenCompra) => {
    if (oc.gasto_id) return;
    if (!confirm(`¿Registrar ${oc.numero} como gasto por ${fmtMonto(oc.total, oc.moneda)}?`)) return;
    const map = OC_A_GASTO[oc.categoria] || { categoria: "otro", tipoGasto: "operativo" };
    const payload = {
      fecha: oc.fecha_emision, categoria: map.categoria, tipo_gasto: map.tipoGasto,
      descripcion: `Orden de compra ${oc.numero} — ${provNombre(oc.proveedor_id)}`,
      monto: oc.total, vehiculo_id: oc.vehiculo_id, proveedor_id: oc.proveedor_id,
      metodo_pago: oc.condicion_pago === "contado" ? "transferencia" : "credito",
      comprobante_url: oc.comprobante_url,
      estado: oc.condicion_pago === "contado" ? "pagado" : "pendiente",
      observaciones: `Generado automáticamente desde ${oc.numero}`,
    };
    const { data, error } = await supabase.from("gastos").insert(payload).select("id").single();
    if (error) { alert(error.message); return; }
    await supabase.from("ordenes_compra").update({ gasto_id: data.id }).eq("id", oc.id);
    cargarDatos();
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const pendientesAprob = ordenes.filter(o => o.estado === "pendiente_aprobacion");
  const enCurso         = ordenes.filter(o => ["aprobada", "enviada", "recibida_parcial"].includes(o.estado));
  const mesActual       = new Date().toISOString().slice(0, 7);
  const recibidasMes    = ordenes.filter(o => o.estado === "recibida" && (o.fecha_emision || "").slice(0, 7) === mesActual);
  const montoPend       = pendientesAprob.reduce((s, o) => s + Number(o.total || 0), 0);
  const montoEnCurso    = enCurso.reduce((s, o) => s + Number(o.total || 0), 0);
  const montoRecibMes   = recibidasMes.reduce((s, o) => s + Number(o.total || 0), 0);

  // ── Filtrado ──────────────────────────────────────────────────────────────

  const filtradas = useMemo(() => ordenes.filter(o => {
    const q   = busqueda.toLowerCase();
    const nombreProv = proveedores.find(p => p.id === o.proveedor_id)?.nombre || "";
    const txt = `${o.numero || ""} ${nombreProv} ${o.observaciones || ""}`.toLowerCase();
    return txt.includes(q) &&
      (filtroEstado    === "todos" || o.estado    === filtroEstado) &&
      (filtroCategoria === "todos" || o.categoria === filtroCategoria) &&
      (filtroProveedor === "todos" || String(o.proveedor_id) === filtroProveedor);
  }), [ordenes, busqueda, filtroEstado, filtroCategoria, filtroProveedor, proveedores]);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">
      <datalist id="unidades-oc">
        {UNIDADES.map(u => <option key={u} value={u} />)}
      </datalist>

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Órdenes de Compra</h1>
          <p className="text-gray-400 text-sm mt-1">Compras a proveedores: repuestos, combustible, servicios y más</p>
        </div>
        <button onClick={() => mostrarForm ? limpiar() : nuevaOC()}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
          style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
          {mostrarForm ? "✕ Cancelar" : "+ Nueva orden"}
        </button>
      </div>

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total OC",             valor: ordenes.length,                          color: "#0b315f", bg: "#eef3f8" },
          { label: "Pend. aprobación",     valor: `${pendientesAprob.length} · ${fmtMonto(montoPend)}`,   color: "#854d0e", bg: "#fef9c3" },
          { label: "En curso (comprometido)", valor: fmtMonto(montoEnCurso),                color: "#1d4ed8", bg: "#dbeafe" },
          { label: "Recibidas este mes",    valor: fmtMonto(montoRecibMes),                 color: "#166534", bg: "#dcfce7" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* FORMULARIO */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg flex-shrink-0"
              style={{ background: CATEGORIAS_OC[form.categoria]?.bg || "#f3f4f6" }}>
              {CATEGORIAS_OC[form.categoria]?.icon || "🏢"}
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar orden de compra" : "Nueva orden de compra"}</h2>
              <p className="text-xs text-gray-400">{editandoId ? "Los ítems se reemplazan al guardar" : "Se genera un número correlativo automático"}</p>
            </div>
          </div>

          {/* Datos generales */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos generales</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Proveedor *" span={2}>
                <select className={inputCls()} value={form.proveedor_id} onChange={e => seleccionarProveedor(e.target.value)}>
                  <option value="">Selecciona un proveedor</option>
                  {proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                </select>
              </Campo>
              <Campo label="Categoría">
                <select className={inputCls()} value={form.categoria} onChange={f("categoria")}>
                  {Object.entries(CATEGORIAS_OC).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
                </select>
              </Campo>
              <Campo label="Unidad destino (opcional)">
                <select className={inputCls()} value={form.vehiculo_id} onChange={f("vehiculo_id")}>
                  <option value="">— Sin unidad específica —</option>
                  {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa}{v.marca ? ` · ${v.marca}` : ""}</option>)}
                </select>
              </Campo>
              <Campo label="Fecha de emisión">
                <input type="date" className={inputCls()} value={form.fecha_emision} onChange={f("fecha_emision")} />
              </Campo>
              <Campo label="Entrega esperada">
                <input type="date" className={inputCls()} value={form.fecha_entrega_esperada} onChange={f("fecha_entrega_esperada")} />
              </Campo>
              <Campo label="Condición de pago">
                <select className={inputCls()} value={form.condicion_pago} onChange={f("condicion_pago")}>
                  {Object.entries(CONDICIONES_PAGO).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
              </Campo>
              <Campo label="Moneda">
                <select className={inputCls()} value={form.moneda} onChange={f("moneda")}>
                  <option value="PEN">S/ Soles</option>
                  <option value="USD">$ Dólares</option>
                </select>
              </Campo>
              <Campo label="IGV (18%)">
                <label className="flex items-center gap-2 h-[42px] px-3 border border-gray-200 rounded-xl text-sm">
                  <input type="checkbox" checked={form.incluye_igv} onChange={e => setForm(p => ({ ...p, incluye_igv: e.target.checked }))} />
                  Incluye IGV
                </label>
              </Campo>
              <Campo label="Comprobante / cotización (URL)">
                <input className={inputCls()} placeholder="https://..." value={form.comprobante_url} onChange={f("comprobante_url")} />
              </Campo>
              <Campo label="Observaciones" span={3}>
                <input className={inputCls()} placeholder="Notas internas..." value={form.observaciones} onChange={f("observaciones")} />
              </Campo>
            </div>
          </div>

          {/* Ítems */}
          <div>
            <div className="flex items-center justify-between border-b pb-1 mb-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Ítems</p>
              <button onClick={agregarItem} className="text-xs font-bold px-2.5 py-1 rounded-lg border hover:bg-gray-50" style={{ color: "#0b315f" }}>+ Agregar ítem</button>
            </div>
            <div className="space-y-2">
              {itemsForm.map((it, idx) => (
                <div key={idx} className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end bg-gray-50 rounded-xl p-2.5">
                  <div className="md:col-span-4">
                    <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Descripción</label>
                    <input className={inputCls("bg-white")} placeholder="Ej: Filtro de aceite" value={it.descripcion}
                      onChange={e => actualizarItem(idx, "descripcion", e.target.value)} />
                  </div>
                  <div className="md:col-span-1">
                    <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Cant.</label>
                    <input type="number" min="0" step="any" className={inputCls("bg-white")} value={it.cantidad}
                      onChange={e => actualizarItem(idx, "cantidad", e.target.value)} />
                  </div>
                  <div className="md:col-span-1">
                    <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Unidad</label>
                    <input list="unidades-oc" className={inputCls("bg-white")} value={it.unidad_medida}
                      onChange={e => actualizarItem(idx, "unidad_medida", e.target.value)} />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">P. unitario</label>
                    <input type="number" min="0" step="any" className={inputCls("bg-white")} value={it.precio_unitario}
                      onChange={e => actualizarItem(idx, "precio_unitario", e.target.value)} />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Unidad destino</label>
                    <select className={inputCls("bg-white")} value={it.vehiculo_id} onChange={e => actualizarItem(idx, "vehiculo_id", e.target.value)}>
                      <option value="">—</option>
                      {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa}</option>)}
                    </select>
                  </div>
                  <div className="md:col-span-1">
                    <label className="block text-[10px] font-bold uppercase text-gray-400 mb-1">Subtotal</label>
                    <div className="px-3 py-2.5 text-sm font-bold text-gray-700">
                      {fmtMonto(Number(it.cantidad || 0) * Number(it.precio_unitario || 0), form.moneda)}
                    </div>
                  </div>
                  <div className="md:col-span-1 flex justify-end">
                    <button onClick={() => quitarItem(idx)} className="px-2.5 py-2 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                  </div>
                </div>
              ))}
            </div>

            {/* Totales */}
            <div className="flex justify-end mt-3">
              <div className="w-full md:w-72 space-y-1 text-sm">
                <div className="flex justify-between text-gray-500"><span>Subtotal</span><span className="font-bold text-gray-700">{fmtMonto(subtotalCalc, form.moneda)}</span></div>
                {form.incluye_igv && <div className="flex justify-between text-gray-500"><span>IGV (18%)</span><span className="font-bold text-gray-700">{fmtMonto(igvCalc, form.moneda)}</span></div>}
                <div className="flex justify-between pt-1 border-t text-base"><span className="font-bold text-gray-900">Total</span><span className="font-black" style={{ color: "#0b315f" }}>{fmtMonto(totalCalc, form.moneda)}</span></div>
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={guardar} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar orden" : "Guardar orden"}
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
            placeholder="Buscar por número, proveedor, observaciones..."
            value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}>
          <option value="todos">Todos los estados</option>
          {Object.entries(ESTADOS_OC).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroCategoria} onChange={e => setFiltroCategoria(e.target.value)}>
          <option value="todos">Todas las categorías</option>
          {Object.entries(CATEGORIAS_OC).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroProveedor} onChange={e => setFiltroProveedor(e.target.value)}>
          <option value="todos">Todos los proveedores</option>
          {proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
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
                <th className="p-3 w-8"></th>
                {["N° Orden", "Proveedor", "Categoría", "Unidad", "Emisión", "Total", "Estado", "Acciones"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...
                  </div>
                </td></tr>
              ) : filtradas.length === 0 ? (
                <tr><td colSpan={9} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">🧾</p><p className="font-medium">No hay órdenes de compra</p>
                </td></tr>
              ) : filtradas.map(oc => {
                const catCfg = CATEGORIAS_OC[oc.categoria] || CATEGORIAS_OC.otro;
                const estCfg = ESTADOS_OC[oc.estado] || ESTADOS_OC.borrador;
                const expandido = expandidoId === oc.id;
                const itemsOC = items.filter(it => it.orden_compra_id === oc.id);
                const editable = ["borrador", "pendiente_aprobacion"].includes(oc.estado);

                return (
                  <React.Fragment key={oc.id}>
                    <tr className="border-t hover:bg-gray-50 cursor-pointer" style={{ borderColor: "#f1f5f9" }}
                      onClick={() => setExpandidoId(expandido ? null : oc.id)}>
                      <td className="p-3 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>
                      <td className="p-3 font-mono font-bold text-gray-900">{oc.numero || `#${oc.id}`}</td>
                      <td className="p-3 text-gray-700">{provNombre(oc.proveedor_id)}</td>
                      <td className="p-3">
                        <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: catCfg.bg, color: catCfg.color }}>
                          {catCfg.icon} {catCfg.label}
                        </span>
                      </td>
                      <td className="p-3 text-xs text-gray-500">{vehLabel(oc.vehiculo_id) || "—"}</td>
                      <td className="p-3 text-xs text-gray-500">{fmtFecha(oc.fecha_emision)}</td>
                      <td className="p-3 font-bold text-gray-900">{fmtMonto(oc.total, oc.moneda)}</td>
                      <td className="p-3">
                        <span className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: estCfg.bg, color: estCfg.color }}>
                          {estCfg.icon} {estCfg.label}
                        </span>
                      </td>
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <div className="flex gap-1.5">
                          {editable && (
                            <button onClick={() => editar(oc)}
                              className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                          )}
                          <button onClick={() => eliminar(oc.id, oc.numero)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                        </div>
                      </td>
                    </tr>

                    {expandido && (
                      <tr style={{ background: "#f8fafc" }} className="border-t">
                        <td colSpan={9} className="px-6 py-4">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs mb-4">
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Condiciones</p>
                              <p><span className="text-gray-400">Pago:</span> {CONDICIONES_PAGO[oc.condicion_pago] || oc.condicion_pago}</p>
                              <p><span className="text-gray-400">Entrega esperada:</span> {fmtFecha(oc.fecha_entrega_esperada)}</p>
                              {oc.comprobante_url && <p><a href={oc.comprobante_url} target="_blank" rel="noreferrer" className="text-blue-600 underline">Ver comprobante / cotización</a></p>}
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Trazabilidad</p>
                              <p><span className="text-gray-400">Creado por:</span> {oc.creado_por || "—"}</p>
                              {oc.aprobado_por && <p><span className="text-gray-400">Aprobado por:</span> {oc.aprobado_por} ({fmtFecha(oc.fecha_aprobacion)})</p>}
                              {oc.estado === "anulada" && oc.motivo_anulacion && <p><span className="text-gray-400">Motivo anulación:</span> {oc.motivo_anulacion}</p>}
                              {oc.observaciones && <p><span className="text-gray-400">Observaciones:</span> {oc.observaciones}</p>}
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Acciones de estado</p>
                              <div className="flex flex-wrap gap-1.5">
                                {oc.estado === "borrador" && (
                                  <button onClick={() => cambiarEstado(oc, "pendiente_aprobacion")} className="px-2.5 py-1 rounded-lg text-xs font-bold border hover:bg-white">Enviar a aprobación</button>
                                )}
                                {oc.estado === "pendiente_aprobacion" && (
                                  <button onClick={() => cambiarEstado(oc, "aprobada")} className="px-2.5 py-1 rounded-lg text-xs font-bold text-white" style={{ background: "#166534" }}>Aprobar</button>
                                )}
                                {oc.estado === "aprobada" && (
                                  <button onClick={() => cambiarEstado(oc, "enviada")} className="px-2.5 py-1 rounded-lg text-xs font-bold text-white" style={{ background: "#7c3aed" }}>Marcar enviada</button>
                                )}
                                {(oc.estado === "enviada" || oc.estado === "recibida_parcial") && (
                                  <>
                                    <button onClick={() => cambiarEstado(oc, "recibida_parcial")} className="px-2.5 py-1 rounded-lg text-xs font-bold border hover:bg-white">Recepción parcial</button>
                                    <button onClick={() => cambiarEstado(oc, "recibida")} className="px-2.5 py-1 rounded-lg text-xs font-bold text-white" style={{ background: "#166534" }}>Marcar recibida</button>
                                  </>
                                )}
                                {oc.estado === "recibida" && (
                                  oc.gasto_id
                                    ? <span className="px-2.5 py-1 rounded-lg text-xs font-bold" style={{ background: "#dcfce7", color: "#166534" }}>💸 Registrada como gasto</span>
                                    : <button onClick={() => registrarGasto(oc)} className="px-2.5 py-1 rounded-lg text-xs font-bold text-white" style={{ background: "#0b315f" }}>💸 Registrar como gasto</button>
                                )}
                                {!["recibida", "anulada"].includes(oc.estado) && (
                                  <button onClick={() => cambiarEstado(oc, "anulada")} className="px-2.5 py-1 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">Anular</button>
                                )}
                              </div>
                            </div>
                          </div>

                          <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400 mb-2">Ítems ({itemsOC.length})</p>
                          <div className="overflow-x-auto rounded-xl border bg-white">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-gray-50 border-b">
                                  <th className="p-2 text-left font-bold text-gray-500">Descripción</th>
                                  <th className="p-2 text-left font-bold text-gray-500">Cant.</th>
                                  <th className="p-2 text-left font-bold text-gray-500">Unidad</th>
                                  <th className="p-2 text-left font-bold text-gray-500">P. unitario</th>
                                  <th className="p-2 text-left font-bold text-gray-500">Unidad destino</th>
                                  <th className="p-2 text-left font-bold text-gray-500">Subtotal</th>
                                </tr>
                              </thead>
                              <tbody>
                                {itemsOC.map(it => (
                                  <tr key={it.id} className="border-b last:border-0">
                                    <td className="p-2">{it.descripcion}</td>
                                    <td className="p-2">{it.cantidad}</td>
                                    <td className="p-2">{it.unidad_medida}</td>
                                    <td className="p-2">{fmtMonto(it.precio_unitario, oc.moneda)}</td>
                                    <td className="p-2">{vehLabel(it.vehiculo_id) || "—"}</td>
                                    <td className="p-2 font-bold">{fmtMonto(it.subtotal, oc.moneda)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <div className="flex justify-end mt-2 text-xs space-x-4 text-gray-500">
                            <span>Subtotal: <b className="text-gray-800">{fmtMonto(oc.subtotal, oc.moneda)}</b></span>
                            {oc.incluye_igv && <span>IGV: <b className="text-gray-800">{fmtMonto(oc.igv, oc.moneda)}</b></span>}
                            <span>Total: <b style={{ color: "#0b315f" }}>{fmtMonto(oc.total, oc.moneda)}</b></span>
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
      </section>
    </main>
  );
}
