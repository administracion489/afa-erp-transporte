"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { registrarLectura, aceptarLectura, marcarReinicio, type FuenteLectura } from "@/lib/odometro";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Vehiculo = { id: number; placa: string; marca?: string; modelo?: string; kilometraje_actual?: number };
type Lectura = {
  id: string; vehiculo_id: number; km: number; fuente: string; fecha: string;
  foto_url: string | null; estado: string; motivo: string | null; created_at: string;
};

const FUENTE_LABEL: Record<string, string> = {
  combustible: "Combustible", checklist: "Inicio servicio", servicio: "Servicio",
  whatsapp_foto: "WhatsApp (foto)", whatsapp_manual: "WhatsApp (manual)", manual: "Manual",
};
const ESTADO_CFG: Record<string, { label: string; bg: string; color: string }> = {
  aceptada:   { label: "Aceptada",   bg: "#dcfce7", color: "#166534" },
  sospechosa: { label: "Por revisar", bg: "#fef9c3", color: "#854d0e" },
  rechazada:  { label: "Rechazada",  bg: "#fee2e2", color: "#991b1b" },
  reinicio:   { label: "Reinicio",   bg: "#dbeafe", color: "#1d4ed8" },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function inputCls(extra = "") {
  return `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${extra}`;
}
function fmtFecha(f: string | null | undefined) {
  if (!f) return "—";
  return new Date(f + (f.length <= 10 ? "T00:00:00" : "")).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function hoyISO() { return new Date().toISOString().split("T")[0]; }

function fileToAdjunto(file: File): Promise<{ tipo: "image"; media_type: string; data: string }> {
  return new Promise((resolve, reject) => {
    if (file.size > 20 * 1024 * 1024) return reject(new Error("La foto supera 20 MB"));
    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      return reject(new Error("Formato no soportado (usa JPG, PNG o WEBP)"));
    }
    const r = new FileReader();
    r.onload = () => {
      const res = String(r.result || "");
      resolve({ tipo: "image", media_type: file.type || "image/jpeg", data: res.includes(",") ? res.split(",")[1] : res });
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function OdometroTab() {
  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([]);
  const [lecturas, setLecturas]   = useState<Lectura[]>([]);
  const [kmDiaMax, setKmDiaMax]   = useState(1500);
  const [loading, setLoading]     = useState(true);

  const [form, setForm] = useState({ vehiculo_id: "", km: "", fecha: hoyISO(), fuente: "manual" as FuenteLectura });
  const [foto, setFoto] = useState<File | null>(null);
  const [leyendo, setLeyendo]     = useState(false);
  const [guardando, setGuardando] = useState(false);

  const cargar = async () => {
    setLoading(true);
    const [vRes, lRes, cRes] = await Promise.all([
      supabase.from("vehiculos").select("id,placa,marca,modelo,kilometraje_actual").order("placa"),
      supabase.from("lecturas_odometro").select("*").order("created_at", { ascending: false }).limit(200),
      supabase.from("config_mantenimiento").select("km_dia_max").eq("id", 1).maybeSingle(),
    ]);
    setVehiculos(vRes.data || []);
    setLecturas(lRes.data || []);
    if (cRes.data?.km_dia_max) setKmDiaMax(cRes.data.km_dia_max);
    setLoading(false);
  };
  useEffect(() => { cargar(); }, []);

  const vehName = (id: number) => {
    const v = vehiculos.find(x => x.id === id);
    return v ? v.placa : `#${id}`;
  };

  // ── Leer odómetro con IA ──────────────────────────────────────────────────────

  const leerFoto = async () => {
    if (!foto) { alert("Selecciona una foto del odómetro"); return; }
    setLeyendo(true);
    try {
      const adj = await fileToAdjunto(foto);
      const res = await fetch("/api/mantenimiento/leer-odometro", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adjunto: adj }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "No se pudo leer");
      if (!data.km) { alert("La IA no pudo leer el km con seguridad. Ingrésalo manualmente."); }
      else {
        setForm(f => ({ ...f, km: String(data.km), fuente: "whatsapp_foto" }));
        alert(`Leído: ${Number(data.km).toLocaleString("es-PE")} km (confianza ${data.confianza}). Revisa antes de registrar.`);
      }
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setLeyendo(false);
    }
  };

  // ── Registrar ──────────────────────────────────────────────────────────────────

  const registrar = async () => {
    if (!form.vehiculo_id || !form.km) { alert("Selecciona vehículo e ingresa el km"); return; }
    setGuardando(true);
    try {
      let fotoUrl: string | null = null;
      if (foto) {
        const ext = foto.name.split(".").pop() || "jpg";
        const path = `odometro/${form.vehiculo_id}/${Date.now()}.${ext}`;
        const up = await supabase.storage.from("vehiculos-fotos").upload(path, foto, { upsert: true });
        if (!up.error) fotoUrl = supabase.storage.from("vehiculos-fotos").getPublicUrl(path).data.publicUrl;
      }
      const r = await registrarLectura(supabase, {
        vehiculo_id: Number(form.vehiculo_id),
        km: Number(form.km),
        fuente: form.fuente,
        fecha: form.fecha,
        foto_url: fotoUrl,
        kmDiaMax,
      });
      if (!r.ok) throw new Error(r.error || "No se pudo registrar");
      if (r.estado === "sospechosa") {
        alert(`Registrada pero marcada para revisión: ${r.motivo}`);
      } else {
        alert("Lectura registrada ✓");
      }
      setForm({ vehiculo_id: "", km: "", fecha: hoyISO(), fuente: "manual" });
      setFoto(null);
      await cargar();
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setGuardando(false);
    }
  };

  // ── Acciones del panel de revisión ──────────────────────────────────────────────

  const aceptar = async (l: Lectura) => {
    await aceptarLectura(supabase, l.id);
    cargar();
  };
  const rechazar = async (l: Lectura) => {
    await supabase.from("lecturas_odometro").update({ estado: "rechazada", motivo: "Rechazada manualmente" }).eq("id", l.id);
    cargar();
  };
  const reiniciar = async (l: Lectura) => {
    if (!confirm(`¿Marcar ${Number(l.km).toLocaleString("es-PE")} km como REINICIO de odómetro para ${vehName(l.vehiculo_id)}? El km vigente se re-anclará a este valor.`)) return;
    await marcarReinicio(supabase, { vehiculo_id: l.vehiculo_id, km: l.km, fecha: l.fecha });
    await supabase.from("lecturas_odometro").update({ estado: "reinicio", motivo: "Confirmado como reinicio" }).eq("id", l.id);
    cargar();
  };

  const porRevisar = lecturas.filter(l => l.estado === "sospechosa");

  // ─── RENDER ───────────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Odómetro</h1>
        <p className="text-gray-400 text-sm mt-1">
          Kilometraje consolidado de varias fuentes · registro manual o por foto (IA) · se conserva el mayor
        </p>
      </div>

      {/* FORM REGISTRO */}
      <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>📷</div>
          <div>
            <h2 className="text-lg font-bold text-gray-900">Registrar lectura</h2>
            <p className="text-xs text-gray-400">Sube la foto del odómetro y léela con IA, o ingresa el km a mano</p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Vehículo *</label>
            <select className={inputCls()} value={form.vehiculo_id} onChange={e => setForm(f => ({ ...f, vehiculo_id: e.target.value }))}>
              <option value="">Seleccionar</option>
              {vehiculos.map(v => (
                <option key={v.id} value={v.id}>{v.placa}{v.kilometraje_actual ? ` · ${Number(v.kilometraje_actual).toLocaleString("es-PE")} km` : ""}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Kilometraje *</label>
            <input type="number" className={inputCls("font-mono")} placeholder="Ej: 152340" value={form.km} onChange={e => setForm(f => ({ ...f, km: e.target.value }))} />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Fecha</label>
            <input type="date" className={inputCls()} value={form.fecha} onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Fuente</label>
            <select className={inputCls()} value={form.fuente} onChange={e => setForm(f => ({ ...f, fuente: e.target.value as FuenteLectura }))}>
              <option value="manual">Manual</option>
              <option value="whatsapp_manual">WhatsApp (manual)</option>
              <option value="whatsapp_foto">WhatsApp (foto)</option>
              <option value="servicio">Servicio</option>
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input type="file" accept="image/*" capture="environment" onChange={e => setFoto(e.target.files?.[0] || null)}
            className="text-sm file:mr-3 file:px-4 file:py-2 file:rounded-xl file:border-0 file:bg-gray-100 file:text-gray-700 file:font-bold file:text-xs" />
          <button onClick={leerFoto} disabled={!foto || leyendo}
            className="px-4 py-2 rounded-xl font-bold text-sm border text-[#0b315f] disabled:opacity-50 hover:bg-gray-50">
            {leyendo ? "Leyendo…" : "🤖 Leer foto con IA"}
          </button>
          <div className="flex-1" />
          <button onClick={registrar} disabled={guardando}
            className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90" style={{ background: "#0b315f" }}>
            {guardando ? "Registrando…" : "Registrar lectura"}
          </button>
        </div>
      </section>

      {/* PANEL POR REVISAR */}
      {porRevisar.length > 0 && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b bg-amber-50">
            <h2 className="font-bold text-amber-800 text-sm">⚠️ Lecturas por revisar ({porRevisar.length})</h2>
            <p className="text-xs text-amber-700">Retroceden o saltan de forma improbable. No actualizan el km vigente hasta que decidas.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr style={{ background: "#fffbeb" }}>
                {["Vehículo", "Km", "Fecha", "Fuente", "Motivo", "Acciones"].map(h =>
                  <th key={h} className="p-3 text-left text-xs font-bold text-amber-700 uppercase tracking-wide">{h}</th>)}
              </tr></thead>
              <tbody>
                {porRevisar.map(l => (
                  <tr key={l.id} className="border-t" style={{ borderColor: "#fde68a" }}>
                    <td className="p-3 font-mono font-bold text-[#0b315f] text-xs">{vehName(l.vehiculo_id)}</td>
                    <td className="p-3 font-mono text-xs">{Number(l.km).toLocaleString("es-PE")}</td>
                    <td className="p-3 text-xs text-gray-600">{fmtFecha(l.fecha)}</td>
                    <td className="p-3 text-xs text-gray-600">{FUENTE_LABEL[l.fuente] || l.fuente}</td>
                    <td className="p-3 text-xs text-amber-800">{l.motivo}</td>
                    <td className="p-3">
                      <div className="flex gap-1.5 flex-wrap">
                        <button onClick={() => aceptar(l)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-green-700 border border-green-200 hover:bg-green-50">✓ Aceptar</button>
                        <button onClick={() => rechazar(l)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕ Rechazar</button>
                        <button onClick={() => reiniciar(l)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-blue-700 border border-blue-200 hover:bg-blue-50">↻ Reinicio tablero</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* HISTORIAL */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b"><h2 className="font-bold text-gray-800 text-sm">Historial de lecturas</h2></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
              {["Vehículo", "Km", "Fecha", "Fuente", "Estado", "Foto"].map(h =>
                <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>)}
            </tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="p-10 text-center text-gray-400">Cargando…</td></tr>
              ) : lecturas.length === 0 ? (
                <tr><td colSpan={6} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">📷</p><p className="font-medium">Sin lecturas registradas</p>
                </td></tr>
              ) : lecturas.map(l => {
                const est = ESTADO_CFG[l.estado] || ESTADO_CFG.aceptada;
                return (
                  <tr key={l.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                    <td className="p-3 font-mono font-bold text-[#0b315f] text-xs">{vehName(l.vehiculo_id)}</td>
                    <td className="p-3 font-mono text-xs text-gray-700">{Number(l.km).toLocaleString("es-PE")}</td>
                    <td className="p-3 text-xs text-gray-600">{fmtFecha(l.fecha)}</td>
                    <td className="p-3 text-xs text-gray-600">{FUENTE_LABEL[l.fuente] || l.fuente}</td>
                    <td className="p-3">
                      <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: est.bg, color: est.color }}>{est.label}</span>
                    </td>
                    <td className="p-3 text-xs">
                      {l.foto_url ? <a href={l.foto_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">ver</a> : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
