"use client";

import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Pasajero = {
  id: number; nombre: string; dni: string | null; empresa: string | null;
  cliente_id: number | null;
  telefono: string | null; qr_code: string | null; foto_url: string | null;
  activo: boolean; created_at: string;
};
type Cliente = { id: number; nombre: string; empresa: string | null; tipo?: string; };
type Reserva  = { id: number; origen: string; destino: string; fecha_servicio: string | null; };
type Parada   = { id: number; reserva_id: number; orden: number; nombre: string; direccion: string | null; hora_estimada: string | null; };
type PasajeroParada = { id: number; parada_id: number; pasajero_id: number; estado: string; };

type Vista = "pasajeros" | "asignaciones";

// ─── FORM VACÍO ───────────────────────────────────────────────────────────────

const FORM_VACIO = {
  nombre: "", dni: "", empresa: "", telefono: "", foto_url: "", cliente_id: "",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function inputCls(extra = "") {
  return `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${extra}`;
}
function Campo({ label, span, hint, children }: { label: string; span?: number; hint?: string; children: React.ReactNode }) {
  return (
    <div className={span === 2 ? "md:col-span-2" : span === 3 ? "md:col-span-3" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

// ─── MODAL QR ─────────────────────────────────────────────────────────────────

function ModalQR({ pasajero, onClose }: { pasajero: Pasajero; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.6)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 text-center" style={{ background: "#0b315f" }}>
          <p className="text-blue-200 text-xs font-bold uppercase tracking-widest">Código QR de embarque</p>
          <p className="text-white font-black text-lg mt-1">{pasajero.nombre}</p>
          {pasajero.empresa && <p className="text-blue-300 text-sm">{pasajero.empresa}</p>}
        </div>

        {/* QR */}
        <div className="flex flex-col items-center py-8 px-6">
          {pasajero.qr_code ? (
            <>
              <div className="p-3 rounded-2xl border-4 mb-4" style={{ borderColor: "#0b315f" }}>
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(pasajero.qr_code)}&bgcolor=ffffff&color=0b315f&qzone=2`}
                  alt="QR"
                  className="w-48 h-48"
                />
              </div>
              <p className="text-xs text-gray-400 mb-1">Código único del pasajero</p>
              <p className="font-mono text-xs font-bold text-gray-600 break-all text-center px-4">
                {pasajero.qr_code}
              </p>
            </>
          ) : (
            <div className="py-8 text-center">
              <p className="text-4xl mb-3">⏳</p>
              <p className="text-gray-600 font-bold">QR aún no generado</p>
              <p className="text-gray-400 text-sm mt-1">Guarda el pasajero primero</p>
            </div>
          )}
        </div>

        {/* Datos */}
        <div className="mx-6 mb-4 rounded-xl p-4 space-y-2" style={{ background: "#f8fafc" }}>
          {[
            ["DNI", pasajero.dni || "—"],
            ["Teléfono", pasajero.telefono || "—"],
            ["Estado", pasajero.activo ? "✅ Activo" : "❌ Inactivo"],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between text-xs">
              <span className="text-gray-400 font-bold">{k}</span>
              <span className="text-gray-700 font-medium">{v}</span>
            </div>
          ))}
        </div>

        <div className="px-6 pb-6">
          <a
            href={`https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(pasajero.qr_code || "")}&bgcolor=ffffff&color=0b315f&qzone=2`}
            target="_blank" rel="noreferrer"
            className="block w-full text-center py-2.5 rounded-xl text-sm font-bold border mb-2"
            style={{ borderColor: "#0b315f", color: "#0b315f" }}>
            📥 Descargar QR
          </a>
          <button onClick={onClose}
            className="w-full py-2.5 rounded-xl text-sm font-bold text-white"
            style={{ background: "#0b315f" }}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function PasajerosPage() {

  const [vista,        setVista]        = useState<Vista>("pasajeros");
  const [pasajeros,    setPasajeros]    = useState<Pasajero[]>([]);
  const [clientes,     setClientes]     = useState<Cliente[]>([]);
  const [reservas,     setReservas]     = useState<Reserva[]>([]);
  const [paradas,      setParadas]      = useState<Parada[]>([]);
  const [asignaciones, setAsignaciones] = useState<PasajeroParada[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [guardando,    setGuardando]    = useState(false);

  // ── Filtros ────────────────────────────────────────────────────────────────
  const [busqueda,     setBusqueda]     = useState("");
  const [filtroEmpresa,setFiltroEmpresa]= useState("todas");

  // ── Form pasajero ──────────────────────────────────────────────────────────
  const [mostrarForm,  setMostrarForm]  = useState(false);
  const [editandoId,   setEditandoId]   = useState<number | null>(null);
  const [form,         setForm]         = useState(FORM_VACIO);

  // ── Modal QR ───────────────────────────────────────────────────────────────
  const [pasajeroQR,   setPasajeroQR]   = useState<Pasajero | null>(null);

  // ── Asignaciones ──────────────────────────────────────────────────────────
  const [reservaSelId, setReservaSelId] = useState<number | null>(null);
  const [paradaSelId,  setParadaSelId]  = useState<number | null>(null);
  const [pasajerosSel, setPasajerosSel] = useState<number[]>([]);
  const [asigGuard,    setAsigGuard]    = useState(false);

  // ── Importar empresa ──────────────────────────────────────────────────────
  const [mostrarImport,setMostrarImport]= useState(false);
  const [importTexto,  setImportTexto]  = useState("");
  const [importEmpresa,setImportEmpresa]= useState("");
  const [importando,   setImportando]   = useState(false);
  const [importClienteId, setImportClienteId] = useState("");

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  // ── Carga ──────────────────────────────────────────────────────────────────

  const cargarTodo = useCallback(async () => {
    setLoading(true);
    const hoy = new Date().toISOString().split("T")[0];
    const [pRes, cRes, rRes] = await Promise.all([
      supabase.from("pasajeros").select("*").order("nombre"),
      supabase.from("clientes").select("id,nombre,empresa").order("nombre"),
      supabase.from("reservas").select("id,origen,destino,fecha_servicio").gte("fecha_servicio", hoy).order("fecha_servicio"),
    ]);
    setPasajeros(pRes.data || []);
    setClientes(cRes.data || []);
    setReservas(rRes.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { cargarTodo(); }, [cargarTodo]);

  // Cargar paradas al seleccionar reserva
  useEffect(() => {
    if (!reservaSelId) { setParadas([]); setParadaSelId(null); return; }
    supabase.from("paradas").select("*").eq("reserva_id", reservaSelId).order("orden")
      .then(({ data }) => setParadas(data || []));
    supabase.from("pasajeros_parada").select("*").in("parada_id",
      paradas.map(p => p.id)).then(({ data }) => setAsignaciones(data || []));
  }, [reservaSelId]);

  // Recargar asignaciones al seleccionar parada
  useEffect(() => {
    if (!paradaSelId) return;
    supabase.from("pasajeros_parada").select("*").eq("parada_id", paradaSelId)
      .then(({ data }) => {
        setAsignaciones(data || []);
        setPasajerosSel((data || []).map((pp: PasajeroParada) => pp.pasajero_id));
      });
  }, [paradaSelId]);

  // ── CRUD Pasajero ──────────────────────────────────────────────────────────

  const guardarPasajero = async () => {
    if (!form.nombre.trim()) { alert("El nombre es obligatorio"); return; }
    setGuardando(true);
    const payload = {
      nombre: form.nombre.trim(),
      dni: form.dni.trim() || null,
      empresa: form.empresa.trim() || null,
      telefono: form.telefono.trim() || null,
      foto_url: form.foto_url.trim() || null,
      cliente_id: form.cliente_id ? Number(form.cliente_id) : null,
    };
    const { error } = editandoId
      ? await supabase.from("pasajeros").update(payload).eq("id", editandoId)
      : await supabase.from("pasajeros").insert({ ...payload, activo: true });
    if (error) { alert(error.message); setGuardando(false); return; }
    setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false);
    cargarTodo(); setGuardando(false);
  };

  const editarPasajero = (p: Pasajero) => {
    setForm({ nombre: p.nombre, dni: p.dni || "", empresa: p.empresa || "", telefono: p.telefono || "", foto_url: p.foto_url || "", cliente_id: p.cliente_id ? String(p.cliente_id) : "" });
    setEditandoId(p.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const toggleActivo = async (p: Pasajero) => {
    await supabase.from("pasajeros").update({ activo: !p.activo }).eq("id", p.id);
    cargarTodo();
  };

  const eliminarPasajero = async (id: number, nombre: string) => {
    if (!confirm(`¿Eliminar a ${nombre}? Se eliminarán también sus asignaciones.`)) return;
    await supabase.from("pasajeros_parada").delete().eq("pasajero_id", id);
    await supabase.from("pasajeros").delete().eq("id", id);
    cargarTodo();
  };

  // ── Importar lista ─────────────────────────────────────────────────────────

  const importarLista = async () => {
    const lineas = importTexto.trim().split("\n").filter(l => l.trim());
    if (lineas.length === 0) return;
    setImportando(true);
    let ok = 0;
    for (const linea of lineas) {
      // Formato: "Nombre Apellido, DNI (opcional)"
      const partes = linea.split(",").map(s => s.trim());
      const nombre = partes[0];
      const dni = partes[1] || null;
      if (!nombre) continue;
      // Verificar si ya existe
      const { data: existe } = await supabase.from("pasajeros").select("id").eq("nombre", nombre).maybeSingle();
      if (!existe) {
        await supabase.from("pasajeros").insert({ nombre, dni, empresa: importEmpresa || null, cliente_id: importClienteId ? Number(importClienteId) : null, activo: true });
        ok++;
      }
    }
    alert(`✅ Se importaron ${ok} pasajeros nuevos de ${lineas.length} líneas`);
    setImportTexto(""); setMostrarImport(false); setImportando(false);
    cargarTodo();
  };

  // ── Asignaciones ──────────────────────────────────────────────────────────

  const guardarAsignaciones = async () => {
    if (!paradaSelId) { alert("Selecciona una parada"); return; }
    setAsigGuard(true);
    // Eliminar asignaciones actuales de esta parada
    await supabase.from("pasajeros_parada").delete().eq("parada_id", paradaSelId);
    // Insertar las seleccionadas
    if (pasajerosSel.length > 0) {
      await supabase.from("pasajeros_parada").insert(
        pasajerosSel.map(pid => ({ parada_id: paradaSelId, pasajero_id: pid, estado: "esperando" }))
      );
    }
    setAsigGuard(false);
    alert(`✅ ${pasajerosSel.length} pasajeros asignados a la parada`);
    // Recargar
    const { data } = await supabase.from("pasajeros_parada").select("*").eq("parada_id", paradaSelId);
    setAsignaciones(data || []);
  };

  // ── Derivados ──────────────────────────────────────────────────────────────

  const empresas = [...new Set(pasajeros.map(p => p.empresa).filter(Boolean))].sort() as string[];

  const filtrados = pasajeros.filter(p => {
    const q = busqueda.toLowerCase();
    const ok = p.nombre.toLowerCase().includes(q) || (p.dni || "").includes(q) || (p.empresa || "").toLowerCase().includes(q);
    return ok && (filtroEmpresa === "todas" || p.empresa === filtroEmpresa);
  });

  const total    = pasajeros.length;
  const activos  = pasajeros.filter(p => p.activo).length;
  const conQR    = pasajeros.filter(p => p.qr_code).length;
  const porEmpresa: Record<string, number> = {};
  pasajeros.forEach(p => { if (p.empresa) porEmpresa[p.empresa] = (porEmpresa[p.empresa] || 0) + 1; });

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-6 max-w-7xl mx-auto">

      {pasajeroQR && <ModalQR pasajero={pasajeroQR} onClose={() => setPasajeroQR(null)} />}

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Pasajeros</h1>
          <p className="text-gray-400 text-sm mt-1">Registro · QR de embarque · asignación a paradas · importación por empresa</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setMostrarImport(v => !v)}
            className="px-4 py-2.5 rounded-xl font-bold text-sm border hover:bg-gray-50"
            style={{ borderColor: "#0b315f", color: "#0b315f" }}>
            📋 Importar lista
          </button>
          <button onClick={() => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(v => !v); }}
            className="px-4 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
            style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
            {mostrarForm ? "✕ Cancelar" : "+ Pasajero"}
          </button>
        </div>
      </div>

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total pasajeros", valor: total,   color: "#0b315f", bg: "#eef3f8" },
          { label: "Activos",         valor: activos, color: "#166534", bg: "#dcfce7" },
          { label: "Con QR",          valor: conQR,   color: "#1d4ed8", bg: "#dbeafe" },
          { label: "Empresas",        valor: empresas.length, color: "#854d0e", bg: "#fef9c3" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-4 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-3xl font-black mt-1" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* PESTAÑAS */}
      <div className="flex gap-1 border-b">
        {([
          { id: "pasajeros",    label: `👥 Pasajeros (${total})` },
          { id: "asignaciones", label: "🗺️ Asignar a paradas" },
        ] as { id: Vista; label: string }[]).map(t => (
          <button key={t.id} onClick={() => setVista(t.id)}
            className="px-5 py-2.5 text-sm font-bold transition-all border-b-2 -mb-px"
            style={{ borderColor: vista === t.id ? "#0b315f" : "transparent", color: vista === t.id ? "#0b315f" : "#9ca3af" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── VISTA PASAJEROS ── */}
      {vista === "pasajeros" && (
        <>
          {/* IMPORTAR LISTA */}
          {mostrarImport && (
            <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center text-xl" style={{ background: "#eef3f8" }}>📋</div>
                <div>
                  <h2 className="text-base font-bold text-gray-900">Importar lista de pasajeros</h2>
                  <p className="text-xs text-gray-400">Una persona por línea · Formato: Nombre Apellido, DNI (DNI opcional)</p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Campo label="Empresa / Cliente">
                  <input className={inputCls()} placeholder="Ej: Compañía Minera ABC" value={importEmpresa} onChange={e => setImportEmpresa(e.target.value)}
                    list="empresas-list" />
                  <datalist id="empresas-list">{empresas.map(e => <option key={e} value={e} />)}</datalist>
                </Campo>
                <div />
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Lista de nombres</label>
                <textarea className={inputCls("resize-none")} rows={8}
                  placeholder={"Juan Pérez García, 12345678\nMaria López Torres, 87654321\nCarlos Ramírez"}
                  value={importTexto} onChange={e => setImportTexto(e.target.value)} />
                <p className="text-[10px] text-gray-400 mt-1">
                  {importTexto.trim().split("\n").filter(l => l.trim()).length} personas en la lista
                </p>
              </div>
              <div className="flex gap-3">
                <button onClick={importarLista} disabled={importando || !importTexto.trim()}
                  className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50"
                  style={{ background: "#0b315f" }}>
                  {importando ? "Importando..." : "✅ Importar lista"}
                </button>
                <button onClick={() => setMostrarImport(false)}
                  className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
                  Cancelar
                </button>
              </div>
            </section>
          )}

          {/* FORM PASAJERO */}
          {mostrarForm && (
            <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center text-xl text-white" style={{ background: "#0b315f" }}>👤</div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar pasajero" : "Nuevo pasajero"}</h2>
                  <p className="text-xs text-gray-400">El QR se genera automáticamente al registrar</p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label="Nombre completo *" span={2}>
                  <input className={inputCls()} placeholder="Juan Pérez García" value={form.nombre} onChange={f("nombre")} />
                </Campo>
                <Campo label="DNI">
                  <input className={inputCls("font-mono")} placeholder="12345678" maxLength={8} value={form.dni} onChange={f("dni")} />
                </Campo>
                <Campo label="Cliente registrado" hint="Vincula al cliente registrado en el ERP">
                  <select className={inputCls()} value={form.cliente_id} onChange={e => {
                    const cid = e.target.value;
                    const cl = clientes.find(c => String(c.id) === cid);
                    setForm(p => ({ ...p, cliente_id: cid, empresa: cl?.empresa || cl?.nombre || p.empresa }));
                  }}>
                    <option value="">Sin cliente / independiente</option>
                    {clientes.map(c => (
                      <option key={c.id} value={c.id}>
                        {c.empresa || c.nombre}{c.tipo === "b2b" ? " 🏢" : ""}
                      </option>
                    ))}
                  </select>
                </Campo>
                <Campo label="Empresa / Área (texto libre)" hint="Se auto-rellena con el cliente elegido">
                  <input className={inputCls()} placeholder="Ej: Planta Industrial Norte" value={form.empresa} onChange={f("empresa")} />
                </Campo>
                <Campo label="Teléfono">
                  <input className={inputCls()} placeholder="987654321" value={form.telefono} onChange={f("telefono")} />
                </Campo>
                <Campo label="Foto (URL)" hint="Google Drive, URL directa de imagen">
                  <input className={inputCls()} placeholder="https://drive.google.com/..." value={form.foto_url} onChange={f("foto_url")} />
                </Campo>
              </div>
              <div className="flex gap-3">
                <button onClick={guardarPasajero} disabled={guardando}
                  className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
                  style={{ background: "#0b315f" }}>
                  {guardando ? "Guardando..." : editandoId ? "Actualizar" : "Guardar pasajero"}
                </button>
                <button onClick={() => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); }}
                  className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
                  Cancelar
                </button>
              </div>
            </section>
          )}

          {/* FILTROS */}
          <div className="flex flex-col md:flex-row gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[180px]">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
              <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
                placeholder="Buscar nombre, DNI o empresa..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
            </div>
            <select className="border rounded-xl px-4 py-2.5 text-sm"
              value={filtroEmpresa} onChange={e => setFiltroEmpresa(e.target.value)}>
              <option value="todas">Todas las empresas</option>
              {empresas.map(e => <option key={e} value={e}>{e} ({porEmpresa[e]})</option>)}
            </select>
            <div className="flex items-center px-4 py-2.5 border rounded-xl text-sm text-gray-400 bg-gray-50">
              {filtrados.length} pasajeros
            </div>
          </div>

          {/* RESUMEN POR EMPRESA */}
          {empresas.length > 0 && filtroEmpresa === "todas" && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {empresas.slice(0, 8).map(emp => (
                <button key={emp} onClick={() => setFiltroEmpresa(emp)}
                  className="flex items-center justify-between rounded-xl px-3 py-2.5 border hover:border-[#0b315f] hover:bg-blue-50 text-left transition-all"
                  style={{ background: "white" }}>
                  <div>
                    <p className="text-xs font-bold text-gray-700 truncate">{emp}</p>
                    <p className="text-[10px] text-gray-400">{porEmpresa[emp]} personas</p>
                  </div>
                  <span className="text-lg text-gray-300">›</span>
                </button>
              ))}
            </div>
          )}

          {/* TABLA PASAJEROS */}
          <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                    {["Pasajero", "DNI", "Empresa", "Teléfono", "QR", "Estado", "Acciones"].map(h => (
                      <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={7} className="p-10 text-center text-gray-400">
                      <div className="flex items-center justify-center gap-2">
                        <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                        Cargando...
                      </div>
                    </td></tr>
                  ) : filtrados.length === 0 ? (
                    <tr><td colSpan={7} className="p-12 text-center">
                      <p className="text-4xl mb-3">👥</p>
                      <p className="font-bold text-gray-600">No se encontraron pasajeros</p>
                      <button onClick={() => { setMostrarForm(true); setForm(FORM_VACIO); }}
                        className="mt-4 px-5 py-2 rounded-xl text-sm font-bold text-white" style={{ background: "#0b315f" }}>
                        + Registrar primero
                      </button>
                    </td></tr>
                  ) : filtrados.map(p => (
                    <tr key={p.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                      {/* Pasajero */}
                      <td className="p-3">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-black overflow-hidden flex-shrink-0"
                            style={{ background: "#0b315f" }}>
                            {p.foto_url
                              ? <img src={p.foto_url.includes("drive.google.com")
                                  ? `https://drive.google.com/thumbnail?id=${p.foto_url.match(/\/d\/([^/]+)/)?.[1]}&sz=w100`
                                  : p.foto_url}
                                  alt="" className="w-full h-full object-cover"
                                  onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                              : p.nombre.charAt(0)}
                          </div>
                          <div>
                            <p className="font-bold text-gray-900">{p.nombre}</p>
                            <p className="text-[10px] text-gray-400">Reg. {new Date(p.created_at).toLocaleDateString("es-PE")}</p>
                          </div>
                        </div>
                      </td>
                      <td className="p-3 font-mono text-xs text-gray-600">{p.dni || "—"}</td>
                      <td className="p-3">
                        <div className="space-y-0.5">
                          {p.cliente_id && (() => {
                            const cl = clientes.find(c => c.id === p.cliente_id);
                            return cl ? <span className="text-[10px] font-black px-2 py-0.5 rounded-full block w-fit" style={{ background: "#eef3f8", color: "#0b315f" }}>{cl.empresa || cl.nombre}</span> : null;
                          })()}
                          {p.empresa
                            ? <span className="text-xs text-gray-600">{p.empresa}</span>
                            : <span className="text-gray-300 text-xs">—</span>}
                        </div>
                      </td>
                      <td className="p-3 text-xs text-gray-600">
                        {p.telefono ? <a href={`tel:${p.telefono}`} className="text-[#0b315f] font-bold hover:underline">📞 {p.telefono}</a> : "—"}
                      </td>
                      <td className="p-3">
                        {p.qr_code
                          ? <button onClick={() => setPasajeroQR(p)} className="flex items-center gap-1.5 text-xs font-bold px-2.5 py-1.5 rounded-lg hover:bg-blue-50" style={{ color: "#0b315f" }}>
                              <img src={`https://api.qrserver.com/v1/create-qr-code/?size=32x32&data=${encodeURIComponent(p.qr_code)}&bgcolor=ffffff&color=0b315f&qzone=1`} alt="QR" className="w-6 h-6" />
                              Ver QR
                            </button>
                          : <span className="text-gray-300 text-xs">Sin QR</span>}
                      </td>
                      <td className="p-3">
                        <button onClick={() => toggleActivo(p)}
                          className="text-xs font-bold px-2.5 py-1 rounded-lg transition-all"
                          style={{ background: p.activo ? "#dcfce7" : "#fee2e2", color: p.activo ? "#166534" : "#991b1b" }}>
                          {p.activo ? "✅ Activo" : "❌ Inactivo"}
                        </button>
                      </td>
                      <td className="p-3">
                        <div className="flex gap-1.5">
                          <button onClick={() => editarPasajero(p)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                          <button onClick={() => setPasajeroQR(p)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-blue-50 text-blue-600 border-blue-100">QR</button>
                          <button onClick={() => eliminarPasajero(p.id, p.nombre)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-600 border border-red-100 hover:bg-red-50">✕</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtrados.length > 0 && (
              <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
                <span>{filtrados.length} de {total} pasajeros{filtroEmpresa !== "todas" ? ` · ${filtroEmpresa}` : ""}</span>
                <span>AFA ERP · Pasajeros</span>
              </div>
            )}
          </section>
        </>
      )}

      {/* ── VISTA ASIGNACIONES ── */}
      {vista === "asignaciones" && (
        <div className="space-y-5">
          <div className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
            <div>
              <h2 className="text-base font-bold text-gray-900">Asignar pasajeros a paradas</h2>
              <p className="text-xs text-gray-400 mt-0.5">Elige la reserva → la parada → marca los pasajeros que suben en ese punto</p>
            </div>

            {/* Selección reserva */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Campo label="1. Reserva / Servicio">
                <select className={inputCls()} value={reservaSelId || ""}
                  onChange={e => { setReservaSelId(Number(e.target.value) || null); setParadaSelId(null); setPasajerosSel([]); }}>
                  <option value="">Seleccionar reserva...</option>
                  {reservas.map(r => (
                    <option key={r.id} value={r.id}>
                      #{r.id} · {r.origen} → {r.destino} {r.fecha_servicio ? `· ${new Date(r.fecha_servicio + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit" })}` : ""}
                    </option>
                  ))}
                </select>
              </Campo>

              <Campo label="2. Parada de recojo">
                <select className={inputCls()} value={paradaSelId || ""}
                  onChange={e => setParadaSelId(Number(e.target.value) || null)}
                  disabled={!reservaSelId || paradas.length === 0}>
                  <option value="">{reservaSelId ? (paradas.length === 0 ? "Sin paradas configuradas" : "Seleccionar parada...") : "Primero elige una reserva"}</option>
                  {paradas.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.orden}. {p.nombre} {p.hora_estimada ? `· ${p.hora_estimada}` : ""}
                    </option>
                  ))}
                </select>
              </Campo>
            </div>

            {/* Info de la parada */}
            {paradaSelId && (
              <div className="rounded-xl px-4 py-3" style={{ background: "#eef3f8" }}>
                {(() => {
                  const parada = paradas.find(p => p.id === paradaSelId);
                  return parada ? (
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">📍</span>
                      <div>
                        <p className="text-[#0b315f] font-black text-sm">{parada.nombre}</p>
                        {parada.direccion && <p className="text-gray-500 text-xs">{parada.direccion}</p>}
                        {parada.hora_estimada && <p className="text-gray-500 text-xs">🕐 {parada.hora_estimada}</p>}
                      </div>
                      <div className="ml-auto text-right">
                        <p className="text-[#0b315f] font-black text-lg">{pasajerosSel.length}</p>
                        <p className="text-gray-400 text-[10px]">asignados</p>
                      </div>
                    </div>
                  ) : null;
                })()}
              </div>
            )}
          </div>

          {/* Selección de pasajeros */}
          {paradaSelId && (
            <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: "#f1f5f9" }}>
                <div>
                  <p className="font-bold text-gray-900">3. Seleccionar pasajeros para esta parada</p>
                  <p className="text-xs text-gray-400 mt-0.5">{pasajerosSel.length} seleccionados de {pasajeros.filter(p => p.activo).length} activos</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setPasajerosSel(pasajeros.filter(p => p.activo).map(p => p.id))}
                    className="text-xs font-bold px-3 py-1.5 rounded-lg border hover:bg-gray-50">
                    ☑ Todos
                  </button>
                  <button onClick={() => setPasajerosSel([])}
                    className="text-xs font-bold px-3 py-1.5 rounded-lg border hover:bg-gray-50">
                    ☐ Ninguno
                  </button>
                </div>
              </div>

              {/* Filtro empresa */}
              <div className="px-5 py-3 border-b" style={{ borderColor: "#f1f5f9" }}>
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => setFiltroEmpresa("todas")}
                    className="text-xs font-bold px-3 py-1.5 rounded-lg border transition-all"
                    style={{ background: filtroEmpresa === "todas" ? "#0b315f" : "white", color: filtroEmpresa === "todas" ? "white" : "#6b7280", borderColor: filtroEmpresa === "todas" ? "#0b315f" : "#e5e7eb" }}>
                    Todas
                  </button>
                  {empresas.map(emp => (
                    <button key={emp} onClick={() => setFiltroEmpresa(filtroEmpresa === emp ? "todas" : emp)}
                      className="text-xs font-bold px-3 py-1.5 rounded-lg border transition-all"
                      style={{ background: filtroEmpresa === emp ? "#0b315f" : "white", color: filtroEmpresa === emp ? "white" : "#6b7280", borderColor: filtroEmpresa === emp ? "#0b315f" : "#e5e7eb" }}>
                      {emp} ({porEmpresa[emp]})
                    </button>
                  ))}
                </div>
              </div>

              {/* Lista checkeable */}
              <div className="max-h-96 overflow-y-auto">
                {pasajeros.filter(p => p.activo && (filtroEmpresa === "todas" || p.empresa === filtroEmpresa)).map(p => {
                  const seleccionado = pasajerosSel.includes(p.id);
                  return (
                    <div key={p.id}
                      onClick={() => setPasajerosSel(prev => seleccionado ? prev.filter(id => id !== p.id) : [...prev, p.id])}
                      className="flex items-center gap-3 px-5 py-3 border-b cursor-pointer hover:bg-gray-50 transition-all"
                      style={{ borderColor: "#f1f5f9", background: seleccionado ? "#eef3f8" : "white" }}>
                      {/* Checkbox */}
                      <div className="w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-all"
                        style={{ background: seleccionado ? "#0b315f" : "white", borderColor: seleccionado ? "#0b315f" : "#d1d5db" }}>
                        {seleccionado && <span className="text-white text-xs font-black">✓</span>}
                      </div>
                      {/* Foto */}
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-black text-sm overflow-hidden flex-shrink-0"
                        style={{ background: "#0b315f" }}>
                        {p.foto_url ? <img src={p.foto_url} alt="" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} /> : p.nombre.charAt(0)}
                      </div>
                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-gray-900 text-sm truncate">{p.nombre}</p>
                        <p className="text-[10px] text-gray-400">{p.empresa || "Sin empresa"} {p.dni ? `· DNI ${p.dni}` : ""}</p>
                      </div>
                      {seleccionado && <span className="text-[#0b315f] text-xs font-black flex-shrink-0">✓ Asignado</span>}
                    </div>
                  );
                })}
              </div>

              {/* Botón guardar */}
              <div className="px-5 py-4 border-t" style={{ borderColor: "#f1f5f9" }}>
                <button onClick={guardarAsignaciones} disabled={asigGuard}
                  className="w-full py-3 rounded-xl font-black text-base text-white disabled:opacity-60"
                  style={{ background: "#0b315f" }}>
                  {asigGuard ? "Guardando..." : `✅ Guardar ${pasajerosSel.length} pasajeros en esta parada`}
                </button>
              </div>
            </section>
          )}

          {/* Estado de asignaciones */}
          {reservaSelId && paradas.length === 0 && (
            <div className="bg-white rounded-2xl border shadow-sm p-8 text-center">
              <p className="text-3xl mb-3">🗺️</p>
              <p className="font-bold text-gray-700">Esta reserva no tiene paradas configuradas</p>
              <p className="text-gray-400 text-sm mt-1">Ve a Reservas → Programación para agregar las paradas del recorrido</p>
            </div>
          )}
        </div>
      )}

    </main>
  );
}