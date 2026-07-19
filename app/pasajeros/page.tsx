"use client";

import React, { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { normalizarEmpresa, claveEmpresa, agruparEmpresas } from "@/lib/empresa";
import GruposPasajeros from "@/components/pasajeros/GruposPasajeros";
import { useCanalesInvitacion } from "@/lib/useCanalesInvitacion";

type Pasajero = {
  id: number;
  nombre: string;
  dni: string | null;
  tipo_documento?: string | null;
  empresa: string | null;
  cliente_id: number | null;
  telefono: string | null;
  email: string | null;
  qr_code: string | null;
  foto_url: string | null;
  activo: boolean;
  created_at: string;
};

type Cliente = {
  id: number;
  nombre: string;
  empresa: string | null;
  tipo?: string;
};

type Reserva = {
  id: number;
  origen: string;
  destino: string;
  fecha_servicio: string | null;
};

type Parada = {
  id: number;
  reserva_id: number;
  orden: number;
  nombre: string;
  direccion: string | null;
  hora_estimada: string | null;
};

type PasajeroParada = {
  id: number;
  parada_id: number;
  pasajero_id: number;
  estado: string;
};

type Vista = "pasajeros" | "grupos" | "asignaciones";

const FORM_VACIO = {
  nombre: "",
  dni: "",
  tipo_documento: "DNI",
  empresa: "",
  telefono: "",
  email: "",
  foto_url: "",
  cliente_id: "",
};

function inputCls(extra = "") {
  return "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all " + extra;
}

// El número de documento (columna `dni`) es la LLAVE de login del pasajero.
// No es solo DNI: los extranjeros usan Carné de Extranjería (9 dígitos) y hay
// pasaportes. Por eso el largo y la sanitización del campo dependen del tipo.
const DOC_TIPOS: { v: string; label: string }[] = [
  { v: "DNI", label: "DNI" },
  { v: "CE", label: "C.E." },
  { v: "PASAPORTE", label: "Pasap." },
  { v: "OTRO", label: "Otro" },
];
const maxDoc = (tipo: string) => (tipo === "DNI" ? 8 : 20);
// DNI: solo dígitos (8). Resto: alfanumérico en mayúsculas (CE peruano = 9 dígitos
// numéricos, pasaporte alfanumérico). Nunca truncamos a 8 lo que no es DNI.
const sanitizeDoc = (tipo: string, v: string) =>
  tipo === "DNI" ? v.replace(/\D/g, "") : v.toUpperCase().replace(/[^A-Z0-9]/g, "");

function Campo(props: { label: string; span?: number; hint?: string; children: React.ReactNode }) {
  const cls = props.span === 2 ? "md:col-span-2" : props.span === 3 ? "md:col-span-3" : "";
  return (
    <div className={cls}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{props.label}</label>
      {props.children}
      {props.hint ? <p className="text-[10px] text-gray-400 mt-0.5">{props.hint}</p> : null}
    </div>
  );
}

function esEmailValido(e: string) {
  if (!e) return true;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(e.trim());
}

function getFotoSrc(url: string) {
  if (url.indexOf("drive.google.com") >= 0) {
    const m = url.match(/\/d\/([^/]+)/);
    const fileId = m ? m[1] : "";
    return "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w100";
  }
  return url;
}

function ModalQR(props: { pasajero: Pasajero; onClose: () => void }) {
  const p = props.pasajero;
  const qrStr = p.qr_code || "";
  const url200 = "https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=" + encodeURIComponent(qrStr) + "&bgcolor=ffffff&color=0b315f&qzone=2";
  const url400 = "https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=" + encodeURIComponent(qrStr) + "&bgcolor=ffffff&color=0b315f&qzone=2";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.6)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="px-6 py-5 text-center" style={{ background: "#0b315f" }}>
          <p className="text-blue-200 text-xs font-bold uppercase tracking-widest">Codigo QR de embarque</p>
          <p className="text-white font-black text-lg mt-1">{p.nombre}</p>
          {p.empresa ? <p className="text-blue-300 text-sm">{p.empresa}</p> : null}
        </div>
        <div className="flex flex-col items-center py-8 px-6">
          {p.qr_code ? (
            <div className="p-3 rounded-2xl border-4 mb-4" style={{ borderColor: "#0b315f" }}>
              <img src={url200} alt="QR" className="w-48 h-48" />
            </div>
          ) : (
            <div className="py-8 text-center">
              <p className="text-gray-600 font-bold">QR aun no generado</p>
              <p className="text-gray-400 text-sm mt-1">Guarda el pasajero primero</p>
            </div>
          )}
          {p.qr_code ? <p className="font-mono text-xs font-bold text-gray-600 break-all text-center px-4">{p.qr_code}</p> : null}
        </div>
        <div className="mx-6 mb-4 rounded-xl p-4 space-y-2" style={{ background: "#f8fafc" }}>
          <div className="flex justify-between text-xs"><span className="text-gray-400 font-bold">{p.tipo_documento && p.tipo_documento !== "DNI" ? p.tipo_documento : "DNI"}</span><span className="text-gray-700 font-medium">{p.dni || "-"}</span></div>
          <div className="flex justify-between text-xs"><span className="text-gray-400 font-bold">Telefono</span><span className="text-gray-700 font-medium">{p.telefono || "-"}</span></div>
          <div className="flex justify-between text-xs"><span className="text-gray-400 font-bold">Email</span><span className="text-gray-700 font-medium">{p.email || "-"}</span></div>
          <div className="flex justify-between text-xs"><span className="text-gray-400 font-bold">Estado</span><span className="text-gray-700 font-medium">{p.activo ? "Activo" : "Inactivo"}</span></div>
        </div>
        <div className="px-6 pb-6 space-y-2">
          <a href={url400} target="_blank" rel="noreferrer" className="block w-full text-center py-2.5 rounded-xl text-sm font-bold border" style={{ borderColor: "#0b315f", color: "#0b315f" }}>Descargar QR</a>
          <button onClick={props.onClose} className="w-full py-2.5 rounded-xl text-sm font-bold text-white" style={{ background: "#0b315f" }}>Cerrar</button>
        </div>
      </div>
    </div>
  );
}

export default function PasajerosPage() {
  const [vista, setVista] = useState<Vista>("pasajeros");
  const [pasajeros, setPasajeros] = useState<Pasajero[]>([]);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [reservas, setReservas] = useState<Reserva[]>([]);
  const [paradas, setParadas] = useState<Parada[]>([]);
  const [asignaciones, setAsignaciones] = useState<PasajeroParada[]>([]);
  const [loading, setLoading] = useState(false);
  const [guardando, setGuardando] = useState(false);

  const [busqueda, setBusqueda] = useState("");
  const [filtroEmpresa, setFiltroEmpresa] = useState("todas");

  const [mostrarForm, setMostrarForm] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);
  const [form, setForm] = useState(FORM_VACIO);

  const [pasajeroQR, setPasajeroQR] = useState<Pasajero | null>(null);

  const [reservaSelId, setReservaSelId] = useState<number | null>(null);
  const [paradaSelId, setParadaSelId] = useState<number | null>(null);
  const [pasajerosSel, setPasajerosSel] = useState<number[]>([]);
  const [asigGuard, setAsigGuard] = useState(false);

  const [mostrarImport, setMostrarImport] = useState(false);
  const [importTexto, setImportTexto] = useState("");
  const [importEmpresa, setImportEmpresa] = useState("");
  const [importando, setImportando] = useState(false);
  const [importClienteId, setImportClienteId] = useState("");
  const { canalEmail, setCanalEmail, canalWhatsapp, setCanalWhatsapp } = useCanalesInvitacion();

  const f = (k: keyof typeof FORM_VACIO) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((p) => ({ ...p, [k]: e.target.value }));

  /** Correo + WhatsApp de invitación (automático) a pasajeros recién creados, según canales habilitados. */
  const enviarInvitaciones = async (pasajeroIds: number[]) => {
    if (!pasajeroIds.length || (!canalEmail && !canalWhatsapp)) return;
    try {
      await fetch("/api/pasajeros/invitacion", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pasajeroIds, canales: { email: canalEmail, whatsapp: canalWhatsapp } }),
      });
    } catch {}
  };

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

  useEffect(() => {
    if (!reservaSelId) { setParadas([]); setParadaSelId(null); return; }
    supabase.from("paradas").select("*").eq("reserva_id", reservaSelId).order("orden").then(({ data }) => setParadas(data || []));
  }, [reservaSelId]);

  useEffect(() => {
    if (!paradaSelId) return;
    supabase.from("pasajeros_parada").select("*").eq("parada_id", paradaSelId).then(({ data }) => {
      setAsignaciones(data || []);
      setPasajerosSel((data || []).map((pp: PasajeroParada) => pp.pasajero_id));
    });
  }, [paradaSelId]);

  const guardarPasajero = async () => {
    if (!form.nombre.trim()) { alert("El nombre es obligatorio"); return; }
    if (form.email.trim() && !esEmailValido(form.email)) { alert("El formato del email no es valido"); return; }
    const doc = form.dni.trim();
    // Aviso suave contra el truncamiento: un DNI peruano tiene 8 dígitos. Si tiene
    // otro largo, casi siempre es un extranjero cuyo tipo debería ser "C.E.".
    if (form.tipo_documento === "DNI" && doc && doc.length !== 8) {
      if (!confirm(`El DNI tiene ${doc.length} dígitos (deberían ser 8). Si es un extranjero, cambia el tipo a "C.E.". ¿Guardar de todas formas?`)) return;
    }
    setGuardando(true);
    const payload: any = {
      nombre: form.nombre.trim(),
      dni: doc || null,
      empresa: normalizarEmpresa(form.empresa),
      telefono: form.telefono.trim() || null,
      email: form.email.trim() || null,
      foto_url: form.foto_url.trim() || null,
      cliente_id: form.cliente_id ? Number(form.cliente_id) : null,
    };
    // `tipo_documento` puede no existir aún en BD (migración pasajeros-tipo-documento.sql).
    // Guardamos el número igual (lo crítico) y reintentamos SIN el tipo si la columna falta.
    const conTipo = { ...payload, tipo_documento: form.tipo_documento || "DNI" };
    let resp = editandoId
      ? await supabase.from("pasajeros").update(conTipo).eq("id", editandoId)
      : await supabase.from("pasajeros").insert({ ...conTipo, activo: true }).select("id").single();
    if (resp.error && /tipo_documento/i.test(resp.error.message || "")) {
      resp = editandoId
        ? await supabase.from("pasajeros").update(payload).eq("id", editandoId)
        : await supabase.from("pasajeros").insert({ ...payload, activo: true }).select("id").single();
    }
    if (resp.error) { alert(resp.error.message); setGuardando(false); return; }
    if (!editandoId && (resp.data as any)?.id) await enviarInvitaciones([(resp.data as any).id]);
    setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false);
    cargarTodo(); setGuardando(false);
  };

  const editarPasajero = (p: Pasajero) => {
    setForm({
      nombre: p.nombre,
      dni: p.dni || "",
      tipo_documento: p.tipo_documento || "DNI",
      empresa: p.empresa || "",
      telefono: p.telefono || "",
      email: p.email || "",
      foto_url: p.foto_url || "",
      cliente_id: p.cliente_id ? String(p.cliente_id) : "",
    });
    setEditandoId(p.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const toggleActivo = async (p: Pasajero) => {
    await supabase.from("pasajeros").update({ activo: !p.activo }).eq("id", p.id);
    cargarTodo();
  };

  const eliminarPasajero = async (id: number, nombre: string) => {
    if (!confirm("Eliminar a " + nombre + "? Se eliminaran tambien sus asignaciones.")) return;
    await supabase.from("pasajeros_parada").delete().eq("pasajero_id", id);
    await supabase.from("pasajeros").delete().eq("id", id);
    cargarTodo();
  };

  const importarLista = async () => {
    const lineas = importTexto.trim().split("\n").filter((l) => l.trim());
    if (lineas.length === 0) return;
    setImportando(true);
    let ok = 0;
    const nuevosIds: number[] = [];
    for (const linea of lineas) {
      const partes = linea.split(",").map((s) => s.trim());
      const nombre = partes[0];
      const dni = partes[1] || null;
      const email = partes[2] && esEmailValido(partes[2]) ? partes[2] : null;
      const telefono = partes[3] || null;
      if (!nombre) continue;
      const exResp = await supabase.from("pasajeros").select("id").eq("nombre", nombre).maybeSingle();
      if (!exResp.data) {
        const { data } = await supabase.from("pasajeros").insert({
          nombre,
          dni,
          email,
          telefono,
          empresa: normalizarEmpresa(importEmpresa),
          cliente_id: importClienteId ? Number(importClienteId) : null,
          activo: true,
        }).select("id").single();
        if (data) nuevosIds.push(data.id);
        ok++;
      }
    }
    alert("Se importaron " + ok + " pasajeros nuevos de " + lineas.length + " lineas");
    setImportTexto(""); setMostrarImport(false); setImportando(false);
    await enviarInvitaciones(nuevosIds);
    cargarTodo();
  };

  const guardarAsignaciones = async () => {
    if (!paradaSelId) { alert("Selecciona una parada"); return; }
    setAsigGuard(true);
    await supabase.from("pasajeros_parada").delete().eq("parada_id", paradaSelId);
    if (pasajerosSel.length > 0) {
      await supabase.from("pasajeros_parada").insert(
        pasajerosSel.map((pid) => ({
          parada_id: paradaSelId,
          pasajero_id: pid,
          estado: "esperando",
          estado_abordaje: "Pendiente",
        }))
      );
    }
    setAsigGuard(false);
    alert(pasajerosSel.length + " pasajeros asignados a la parada");
    const resp = await supabase.from("pasajeros_parada").select("*").eq("parada_id", paradaSelId);
    setAsignaciones(resp.data || []);
  };

  // Agrupamos por clave canónica (insensible a mayúsculas/espacios/punto final),
  // así "…S.R.L" y "…S.R.L." salen como UNA sola empresa con el conteo sumado y
  // la grafía más frecuente como etiqueta. `filtroEmpresa` guarda la clave.
  const gruposEmpresa = agruparEmpresas(pasajeros.map((p) => p.empresa));

  const filtrados = pasajeros.filter((p) => {
    const q = busqueda.toLowerCase();
    const ok = p.nombre.toLowerCase().includes(q) || (p.dni || "").includes(q) || (p.empresa || "").toLowerCase().includes(q) || (p.email || "").toLowerCase().includes(q);
    return ok && (filtroEmpresa === "todas" || claveEmpresa(p.empresa) === filtroEmpresa);
  });

  const total = pasajeros.length;
  const activos = pasajeros.filter((p) => p.activo).length;
  const conQR = pasajeros.filter((p) => p.qr_code).length;
  const conEmail = pasajeros.filter((p) => p.email).length;

  const kpis = [
    { label: "Total pasajeros", valor: total, color: "#0b315f", bg: "#eef3f8" },
    { label: "Activos", valor: activos, color: "#166534", bg: "#dcfce7" },
    { label: "Con QR", valor: conQR, color: "#1d4ed8", bg: "#dbeafe" },
    { label: "Con email", valor: conEmail, color: "#0891b2", bg: "#cffafe" },
    { label: "Empresas", valor: gruposEmpresa.length, color: "#854d0e", bg: "#fef9c3" },
  ];

  const tabs: Array<{ id: Vista; label: string }> = [
    { id: "pasajeros", label: "Pasajeros (" + total + ")" },
    { id: "grupos", label: "Grupos" },
    { id: "asignaciones", label: "Asignar a paradas" },
  ];

  return (
    <main className="p-6 space-y-6 max-w-7xl mx-auto">
      {pasajeroQR ? <ModalQR pasajero={pasajeroQR} onClose={() => setPasajeroQR(null)} /> : null}

      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Pasajeros</h1>
          <p className="text-gray-400 text-sm mt-1">Registro, QR de embarque, grupos reutilizables y asignacion a paradas</p>
        </div>
        {vista === "pasajeros" ? (
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => setMostrarImport((v) => !v)} className="px-4 py-2.5 rounded-xl font-bold text-sm border hover:bg-gray-50" style={{ borderColor: "#0b315f", color: "#0b315f" }}>Importar lista</button>
            <button onClick={() => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm((v) => !v); }} className="px-4 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90" style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>{mostrarForm ? "Cancelar" : "+ Pasajero"}</button>
          </div>
        ) : null}
      </div>

      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-xl p-4 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-3xl font-black mt-1" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      <div className="flex gap-1 border-b">
        {tabs.map((t) => {
          const activa = vista === t.id;
          return (
            <button key={t.id} onClick={() => setVista(t.id)} className="px-5 py-2.5 text-sm font-bold transition-all border-b-2 -mb-px" style={{ borderColor: activa ? "#0b315f" : "transparent", color: activa ? "#0b315f" : "#9ca3af" }}>{t.label}</button>
          );
        })}
      </div>

      {vista === "pasajeros" ? (
        <>
          {/* Sugerencias de empresas existentes (grafía canónica) — compartido por el
              formulario de registro y el de importar, para que se elija una grafía ya usada. */}
          <datalist id="empresas-list">{gruposEmpresa.map((g) => (<option key={g.clave} value={g.label} />))}</datalist>
          {mostrarImport ? (
            <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-4">
              <div>
                <h2 className="text-base font-bold text-gray-900">Importar lista de pasajeros</h2>
                <p className="text-xs text-gray-400">Una persona por linea. Formato: Nombre, DNI, Email, Telefono (DNI, email y telefono opcionales)</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Campo label="Empresa / Cliente (texto)">
                  <input className={inputCls()} placeholder="Ej: Compania Minera ABC" value={importEmpresa} onChange={(e) => setImportEmpresa(e.target.value)} list="empresas-list" />
                </Campo>
                <Campo label="Cliente registrado" hint="Vincula al cliente del ERP (opcional)">
                  <select className={inputCls()} value={importClienteId} onChange={(e) => setImportClienteId(e.target.value)}>
                    <option value="">Sin cliente</option>
                    {clientes.map((c) => (<option key={c.id} value={c.id}>{c.empresa || c.nombre}</option>))}
                  </select>
                </Campo>
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Lista de nombres</label>
                <textarea className={inputCls("resize-none")} rows={8} placeholder={"Juan Perez Garcia, 12345678, juan@empresa.pe, 987654321\nMaria Lopez Torres, 87654321\nCarlos Ramirez"} value={importTexto} onChange={(e) => setImportTexto(e.target.value)} />
                <p className="text-[10px] text-gray-400 mt-1">{importTexto.trim().split("\n").filter((l) => l.trim()).length} personas en la lista</p>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-[11px] text-gray-400 font-semibold">Enviar invitación automática a los nuevos por:</span>
                <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={canalEmail} onChange={(e) => setCanalEmail(e.target.checked)} /> ✉ Correo
                </label>
                <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 cursor-pointer">
                  <input type="checkbox" checked={canalWhatsapp} onChange={(e) => setCanalWhatsapp(e.target.checked)} /> 💬 WhatsApp
                </label>
              </div>
              <div className="flex gap-3">
                <button onClick={importarLista} disabled={importando || !importTexto.trim()} className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50" style={{ background: "#0b315f" }}>{importando ? "Importando..." : "Importar lista"}</button>
                <button onClick={() => setMostrarImport(false)} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
              </div>
            </section>
          ) : null}

          {mostrarForm ? (
            <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
              <div>
                <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar pasajero" : "Nuevo pasajero"}</h2>
                <p className="text-xs text-gray-400">El QR se genera automaticamente al registrar</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label="Nombre completo *" span={2}>
                  <input className={inputCls()} placeholder="Juan Perez Garcia" value={form.nombre} onChange={f("nombre")} />
                </Campo>
                <Campo label={form.tipo_documento === "DNI" ? "DNI" : "N° de documento"} hint="Es el usuario de acceso a la app del pasajero">
                  <div className="flex gap-2">
                    <select
                      className="border border-gray-200 rounded-xl px-2 py-2.5 text-sm font-semibold text-gray-700 bg-white shrink-0 focus:outline-none focus:border-[#0b315f]"
                      value={form.tipo_documento}
                      title="Tipo de documento"
                      onChange={(e) => setForm((p) => ({ ...p, tipo_documento: e.target.value, dni: sanitizeDoc(e.target.value, p.dni) }))}
                    >
                      {DOC_TIPOS.map((t) => (<option key={t.v} value={t.v}>{t.label}</option>))}
                    </select>
                    <input
                      className={inputCls("font-mono")}
                      placeholder={form.tipo_documento === "DNI" ? "12345678" : "Ej: 001234567"}
                      maxLength={maxDoc(form.tipo_documento)}
                      value={form.dni}
                      onChange={(e) => setForm((p) => ({ ...p, dni: sanitizeDoc(p.tipo_documento, e.target.value) }))}
                    />
                  </div>
                </Campo>
                <Campo label="Cliente registrado" hint="Vincula al cliente registrado en el ERP">
                  <select className={inputCls()} value={form.cliente_id} onChange={(e) => {
                    const cid = e.target.value;
                    const cl = clientes.find((c) => String(c.id) === cid);
                    setForm((p) => ({ ...p, cliente_id: cid, empresa: (cl && (cl.empresa || cl.nombre)) || p.empresa }));
                  }}>
                    <option value="">Sin cliente / independiente</option>
                    {clientes.map((c) => (<option key={c.id} value={c.id}>{c.empresa || c.nombre}</option>))}
                  </select>
                </Campo>
                <Campo label="Empresa / Area (texto libre)" hint="Se auto-rellena con el cliente elegido">
                  <input className={inputCls()} placeholder="Ej: Planta Industrial Norte" value={form.empresa} onChange={f("empresa")} list="empresas-list" />
                </Campo>
                <Campo label="Telefono">
                  <input className={inputCls()} placeholder="987654321" value={form.telefono} onChange={f("telefono")} />
                </Campo>
                <Campo label="Email" hint="Para envio de QR y notificaciones (opcional)">
                  <input type="email" className={inputCls(form.email && !esEmailValido(form.email) ? "border-red-300" : "")} placeholder="pasajero@empresa.pe" value={form.email} onChange={f("email")} />
                  {form.email && !esEmailValido(form.email) ? <p className="text-[10px] text-red-600 mt-1 font-bold">Formato de email invalido</p> : null}
                </Campo>
                <Campo label="Foto (URL)" span={2} hint="Google Drive, URL directa de imagen">
                  <input className={inputCls()} placeholder="https://drive.google.com/..." value={form.foto_url} onChange={f("foto_url")} />
                </Campo>
              </div>
              {!editandoId && (
                <div className="flex items-center gap-4">
                  <span className="text-[11px] text-gray-400 font-semibold">Al guardar, enviar invitación automática por:</span>
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 cursor-pointer">
                    <input type="checkbox" checked={canalEmail} onChange={(e) => setCanalEmail(e.target.checked)} /> ✉ Correo
                  </label>
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 cursor-pointer">
                    <input type="checkbox" checked={canalWhatsapp} onChange={(e) => setCanalWhatsapp(e.target.checked)} /> 💬 WhatsApp
                  </label>
                </div>
              )}
              <div className="flex gap-3">
                <button onClick={guardarPasajero} disabled={guardando} className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60" style={{ background: "#0b315f" }}>{guardando ? "Guardando..." : editandoId ? "Actualizar" : "Guardar pasajero"}</button>
                <button onClick={() => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); }} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
              </div>
            </section>
          ) : null}

          <div className="flex flex-col md:flex-row gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[180px]">
              <input className="w-full border rounded-xl pl-3 pr-4 py-2.5 text-sm focus:outline-none" placeholder="Buscar nombre, DNI, empresa o email..." value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
            </div>
            <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEmpresa} onChange={(e) => setFiltroEmpresa(e.target.value)}>
              <option value="todas">Todas las empresas</option>
              {gruposEmpresa.map((g) => (<option key={g.clave} value={g.clave}>{g.label} ({g.count})</option>))}
            </select>
            <div className="flex items-center px-4 py-2.5 border rounded-xl text-sm text-gray-400 bg-gray-50">{filtrados.length} pasajeros</div>
          </div>

          <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                    {["Pasajero", "DNI", "Empresa", "Contacto", "QR", "Estado", "Acciones"].map((h) => (
                      <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={7} className="p-10 text-center text-gray-400">Cargando...</td></tr>
                  ) : filtrados.length === 0 ? (
                    <tr><td colSpan={7} className="p-12 text-center">
                      <p className="font-bold text-gray-600">No se encontraron pasajeros</p>
                      <button onClick={() => { setMostrarForm(true); setForm(FORM_VACIO); }} className="mt-4 px-5 py-2 rounded-xl text-sm font-bold text-white" style={{ background: "#0b315f" }}>+ Registrar primero</button>
                    </td></tr>
                  ) : filtrados.map((p) => {
                    const cl = clientes.find((c) => c.id === p.cliente_id);
                    return (
                      <tr key={p.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                        <td className="p-3">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-black overflow-hidden flex-shrink-0" style={{ background: "#0b315f" }}>
                              {p.foto_url ? (
                                <img src={getFotoSrc(p.foto_url)} alt="" className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                              ) : (
                                p.nombre.charAt(0)
                              )}
                            </div>
                            <div>
                              <p className="font-bold text-gray-900">{p.nombre}</p>
                              <p className="text-[10px] text-gray-400">Reg. {new Date(p.created_at).toLocaleDateString("es-PE")}</p>
                            </div>
                          </div>
                        </td>
                        <td className="p-3 font-mono text-xs text-gray-600">{p.dni || "-"}</td>
                        <td className="p-3">
                          <div className="space-y-0.5">
                            {cl ? <span className="text-[10px] font-black px-2 py-0.5 rounded-full block w-fit" style={{ background: "#eef3f8", color: "#0b315f" }}>{cl.empresa || cl.nombre}</span> : null}
                            {p.empresa ? <span className="text-xs text-gray-600">{p.empresa}</span> : <span className="text-gray-300 text-xs">-</span>}
                          </div>
                        </td>
                        <td className="p-3 text-xs">
                          <div className="space-y-0.5">
                            {p.telefono ? <a href={"tel:" + p.telefono} className="text-[#0b315f] font-bold hover:underline block">{p.telefono}</a> : null}
                            {p.email ? <a href={"mailto:" + p.email} className="text-gray-600 hover:underline block truncate max-w-[160px]" title={p.email}>{p.email}</a> : null}
                            {!p.telefono && !p.email ? <span className="text-gray-300">-</span> : null}
                          </div>
                        </td>
                        <td className="p-3">
                          {p.qr_code ? (
                            <button onClick={() => setPasajeroQR(p)} className="text-xs font-bold px-2.5 py-1.5 rounded-lg hover:bg-blue-50" style={{ color: "#0b315f" }}>Ver QR</button>
                          ) : (
                            <span className="text-gray-300 text-xs">Sin QR</span>
                          )}
                        </td>
                        <td className="p-3">
                          <button onClick={() => toggleActivo(p)} className="text-xs font-bold px-2.5 py-1 rounded-lg transition-all" style={{ background: p.activo ? "#dcfce7" : "#fee2e2", color: p.activo ? "#166534" : "#991b1b" }}>{p.activo ? "Activo" : "Inactivo"}</button>
                        </td>
                        <td className="p-3">
                          <div className="flex gap-1.5">
                            <button onClick={() => editarPasajero(p)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">Editar</button>
                            <button onClick={() => eliminarPasajero(p.id, p.nombre)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-600 border border-red-100 hover:bg-red-50">X</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}

      {vista === "grupos" ? (
        <GruposPasajeros clientes={clientes} pasajeros={pasajeros} onRefresh={cargarTodo} />
      ) : null}

      {vista === "asignaciones" ? (
        <div className="space-y-5">
          <div className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
            <div>
              <h2 className="text-base font-bold text-gray-900">Asignar pasajeros a paradas</h2>
              <p className="text-xs text-gray-400 mt-0.5">Elige reserva, parada, y marca los pasajeros que suben en ese punto</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Campo label="1. Reserva / Servicio">
                <select className={inputCls()} value={reservaSelId || ""} onChange={(e) => { setReservaSelId(Number(e.target.value) || null); setParadaSelId(null); setPasajerosSel([]); }}>
                  <option value="">Seleccionar reserva...</option>
                  {reservas.map((r) => {
                    const fechaTxt = r.fecha_servicio ? " - " + new Date(r.fecha_servicio + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit" }) : "";
                    return (<option key={r.id} value={r.id}>#{r.id} - {r.origen} a {r.destino}{fechaTxt}</option>);
                  })}
                </select>
              </Campo>
              <Campo label="2. Parada de recojo">
                <select className={inputCls()} value={paradaSelId || ""} onChange={(e) => setParadaSelId(Number(e.target.value) || null)} disabled={!reservaSelId || paradas.length === 0}>
                  <option value="">{reservaSelId ? (paradas.length === 0 ? "Sin paradas configuradas" : "Seleccionar parada...") : "Primero elige una reserva"}</option>
                  {paradas.map((p) => (<option key={p.id} value={p.id}>{p.orden}. {p.nombre}{p.hora_estimada ? " - " + p.hora_estimada : ""}</option>))}
                </select>
              </Campo>
            </div>
          </div>

          {paradaSelId ? (
            <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: "#f1f5f9" }}>
                <div>
                  <p className="font-bold text-gray-900">3. Seleccionar pasajeros para esta parada</p>
                  <p className="text-xs text-gray-400 mt-0.5">{pasajerosSel.length} seleccionados de {pasajeros.filter((p) => p.activo).length} activos</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setPasajerosSel(pasajeros.filter((p) => p.activo).map((p) => p.id))} className="text-xs font-bold px-3 py-1.5 rounded-lg border hover:bg-gray-50">Todos</button>
                  <button onClick={() => setPasajerosSel([])} className="text-xs font-bold px-3 py-1.5 rounded-lg border hover:bg-gray-50">Ninguno</button>
                </div>
              </div>
              <div className="max-h-96 overflow-y-auto">
                {pasajeros.filter((p) => p.activo).map((p) => {
                  const sel = pasajerosSel.includes(p.id);
                  return (
                    <div key={p.id} onClick={() => setPasajerosSel((prev) => sel ? prev.filter((id) => id !== p.id) : [...prev, p.id])} className="flex items-center gap-3 px-5 py-3 border-b cursor-pointer hover:bg-gray-50 transition-all" style={{ borderColor: "#f1f5f9", background: sel ? "#eef3f8" : "white" }}>
                      <div className="w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0" style={{ background: sel ? "#0b315f" : "white", borderColor: sel ? "#0b315f" : "#d1d5db" }}>
                        {sel ? <span className="text-white text-xs font-black">v</span> : null}
                      </div>
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-black text-sm flex-shrink-0" style={{ background: "#0b315f" }}>{p.nombre.charAt(0)}</div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-gray-900 text-sm truncate">{p.nombre}</p>
                        <p className="text-[10px] text-gray-400">{p.empresa || "Sin empresa"} {p.dni ? "- DNI " + p.dni : ""}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="px-5 py-4 border-t" style={{ borderColor: "#f1f5f9" }}>
                <button onClick={guardarAsignaciones} disabled={asigGuard} className="w-full py-3 rounded-xl font-black text-base text-white disabled:opacity-60" style={{ background: "#0b315f" }}>{asigGuard ? "Guardando..." : "Guardar " + pasajerosSel.length + " pasajeros en esta parada"}</button>
              </div>
            </section>
          ) : null}

          {reservaSelId && paradas.length === 0 ? (
            <div className="bg-white rounded-2xl border shadow-sm p-8 text-center">
              <p className="font-bold text-gray-700">Esta reserva no tiene paradas configuradas</p>
              <p className="text-gray-400 text-sm mt-1">Ve a Reservas / Programacion para agregar las paradas del recorrido</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}