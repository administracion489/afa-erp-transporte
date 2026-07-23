"use client";

// Modal de odómetro para un vehículo TERCERIZADO. Espejo del OdometroTab de flota
// propia (app/mantenimiento/_tabs/OdometroTab.tsx) pero acotado a un solo vehículo y
// a la flota "tercero": registro manual o por foto (IA), panel de revisión y historial.
// Reusa el motor consolidado lib/odometro.ts (anti-retroceso) y el endpoint de foto-IA
// /api/mantenimiento/leer-odometro (agnóstico de flota).

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { registrarLectura, aceptarLectura, marcarReinicio, type FuenteLectura } from "@/lib/odometro";
import AnularLecturaOdometro from "@/components/AnularLecturaOdometro";

type Lectura = {
  id: string; km: number; fuente: string; fecha: string;
  foto_url: string | null; estado: string; motivo: string | null; created_at: string;
};

const FUENTE_LABEL: Record<string, string> = {
  combustible: "Combustible", checklist: "Pre-viaje", servicio: "Servicio",
  whatsapp_foto: "Foto (IA)", whatsapp_manual: "Manual", manual: "Manual",
};
const ESTADO_CFG: Record<string, { label: string; bg: string; color: string }> = {
  aceptada:   { label: "Aceptada",    bg: "#dcfce7", color: "#166534" },
  sospechosa: { label: "Por revisar", bg: "#fef9c3", color: "#854d0e" },
  rechazada:  { label: "Rechazada",   bg: "#fee2e2", color: "#991b1b" },
  reinicio:   { label: "Reinicio",    bg: "#dbeafe", color: "#1d4ed8" },
  anulada:    { label: "Anulada",     bg: "#f1f5f9", color: "#64748b" },
};

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

export default function OdometroTerceroModal({
  vehiculo, onClose, onSaved,
}: {
  vehiculo: { id: number; placa: string; kilometraje_actual?: number | null };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [lecturas, setLecturas] = useState<Lectura[]>([]);
  const [kmVigente, setKmVigente] = useState<number | null>(vehiculo.kilometraje_actual ?? null);
  const [kmDiaMax, setKmDiaMax] = useState(1500);
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState({ km: "", fecha: hoyISO(), fuente: "manual" as FuenteLectura });
  const [foto, setFoto] = useState<File | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [anular, setAnular] = useState<Lectura | null>(null);

  const cargar = async () => {
    setLoading(true);
    const [lRes, cRes, vRes] = await Promise.all([
      supabase.from("lecturas_odometro").select("id,km,fuente,fecha,foto_url,estado,motivo,created_at")
        .eq("vehiculo_tercero_id", vehiculo.id).order("created_at", { ascending: false }).limit(100),
      supabase.from("config_mantenimiento").select("km_dia_max").eq("id", 1).maybeSingle(),
      supabase.from("vehiculos_tercero").select("kilometraje_actual").eq("id", vehiculo.id).maybeSingle(),
    ]);
    setLecturas(lRes.data || []);
    if (cRes.data?.km_dia_max) setKmDiaMax(cRes.data.km_dia_max);
    setKmVigente(vRes.data?.kilometraje_actual ?? null);
    setLoading(false);
  };
  useEffect(() => { cargar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [vehiculo.id]);

  const leerFoto = async () => {
    if (!foto) { alert("Selecciona una foto del odómetro"); return; }
    setLeyendo(true);
    try {
      const adj = await fileToAdjunto(foto);
      const res = await fetch("/api/mantenimiento/leer-odometro", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adjunto: adj }),
      });
      const raw = await res.text();
      let data: any;
      try { data = JSON.parse(raw); }
      catch {
        if (res.status === 504 || /timeout|FUNCTION_INVOCATION/i.test(raw))
          throw new Error("El servidor tardó demasiado leyendo la foto. Intenta de nuevo con una imagen más nítida.");
        throw new Error(`El servidor respondió ${res.status}. ${raw.slice(0, 140)}`);
      }
      if (!res.ok || !data.ok) throw new Error(data?.error || `Error ${res.status}`);
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

  const registrar = async () => {
    if (!form.km) { alert("Ingresa el km"); return; }
    setGuardando(true);
    try {
      let fotoUrl: string | null = null;
      if (foto) {
        const ext = foto.name.split(".").pop() || "jpg";
        const path = `odometro-tercero/${vehiculo.id}/${Date.now()}.${ext}`;
        const up = await supabase.storage.from("vehiculos-fotos").upload(path, foto, { upsert: true });
        if (!up.error) fotoUrl = supabase.storage.from("vehiculos-fotos").getPublicUrl(path).data.publicUrl;
      }
      const r = await registrarLectura(supabase, {
        vehiculo_id: vehiculo.id,
        km: Number(form.km),
        fuente: form.fuente,
        fecha: form.fecha,
        foto_url: fotoUrl,
        kmDiaMax,
        flota: "tercero",
      });
      if (!r.ok) throw new Error(r.error || "No se pudo registrar");
      if (r.estado === "sospechosa") alert(`Registrada pero marcada para revisión: ${r.motivo}`);
      else alert("Lectura registrada ✓");
      setForm({ km: "", fecha: hoyISO(), fuente: "manual" });
      setFoto(null);
      await cargar();
      onSaved();
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setGuardando(false);
    }
  };

  const aceptar = async (l: Lectura) => { await aceptarLectura(supabase, l.id); await cargar(); onSaved(); };
  // "Rechazar" abre el modal de corrección (setAnular): corregir el km + enseñar a la
  // IA, o descartar con motivo. No se descarta la lectura en silencio.
  const reiniciar = async (l: Lectura) => {
    if (!confirm(`¿Marcar ${Number(l.km).toLocaleString("es-PE")} km como REINICIO de odómetro para ${vehiculo.placa}? El km vigente se re-anclará a este valor.`)) return;
    await marcarReinicio(supabase, { vehiculo_id: vehiculo.id, km: l.km, fecha: l.fecha, flota: "tercero" });
    await supabase.from("lecturas_odometro").update({ estado: "reinicio", motivo: "Confirmado como reinicio" }).eq("id", l.id);
    await cargar();
    onSaved();
  };

  const porRevisar = lecturas.filter(l => l.estado === "sospechosa");

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl my-8" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>📷</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Odómetro · <span className="font-mono">{vehiculo.placa}</span></h2>
              <p className="text-xs text-gray-400">
                Km vigente: <b className="font-mono text-gray-700">{kmVigente != null ? `${Number(kmVigente).toLocaleString("es-PE")} km` : "—"}</b>
              </p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 text-lg">✕</button>
        </div>

        <div className="p-6 space-y-5">
          {/* FORM REGISTRO */}
          <section className="space-y-3">
            <p className="text-xs text-gray-400">Sube la foto del odómetro y léela con IA, o ingresa el km a mano.</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Kilometraje *</label>
                <input type="number" className={inputCls("font-mono")} placeholder="Ej: 152340" value={form.km}
                  onChange={e => setForm(f => ({ ...f, km: e.target.value }))} />
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Fecha</label>
                <input type="date" className={inputCls()} value={form.fecha}
                  onChange={e => setForm(f => ({ ...f, fecha: e.target.value }))} />
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Fuente</label>
                <select className={inputCls()} value={form.fuente}
                  onChange={e => setForm(f => ({ ...f, fuente: e.target.value as FuenteLectura }))}>
                  <option value="manual">Manual</option>
                  <option value="whatsapp_manual">WhatsApp (manual)</option>
                  <option value="whatsapp_foto">Foto (IA)</option>
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
            <section className="rounded-2xl border overflow-hidden">
              <div className="px-4 py-2.5 border-b bg-amber-50">
                <h3 className="font-bold text-amber-800 text-sm">⚠️ Por revisar ({porRevisar.length})</h3>
                <p className="text-[11px] text-amber-700">Retroceden o saltan de forma improbable. No actualizan el km vigente hasta que decidas.</p>
              </div>
              <div className="divide-y">
                {porRevisar.map(l => (
                  <div key={l.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5" style={{ background: "#fffbeb" }}>
                    <span className="font-mono font-bold text-xs">{Number(l.km).toLocaleString("es-PE")} km</span>
                    <span className="text-xs text-gray-500">{fmtFecha(l.fecha)}</span>
                    <span className="text-[11px] text-amber-800 flex-1 min-w-[120px]">{l.motivo}</span>
                    <div className="flex gap-1.5">
                      <button onClick={() => aceptar(l)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-green-700 border border-green-200 hover:bg-green-50">✓ Aceptar</button>
                      <button onClick={() => setAnular(l)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50" title="Corregir el km o descartar con motivo (no se pierde la lectura)">✕ Rechazar</button>
                      <button onClick={() => reiniciar(l)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-blue-700 border border-blue-200 hover:bg-blue-50">↻ Reinicio</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* HISTORIAL */}
          <section className="rounded-2xl border overflow-hidden">
            <div className="px-4 py-2.5 border-b"><h3 className="font-bold text-gray-800 text-sm">Historial de lecturas</h3></div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  {["Km", "Fecha", "Fuente", "Estado", "Foto", ""].map(h =>
                    <th key={h} className="p-2.5 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>)}
                </tr></thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={6} className="p-8 text-center text-gray-400">Cargando…</td></tr>
                  ) : lecturas.length === 0 ? (
                    <tr><td colSpan={6} className="p-8 text-center text-gray-400">
                      <p className="text-3xl mb-2">📷</p><p className="font-medium">Sin lecturas registradas</p>
                    </td></tr>
                  ) : lecturas.map(l => {
                    const est = ESTADO_CFG[l.estado] || ESTADO_CFG.aceptada;
                    return (
                      <tr key={l.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                        <td className="p-2.5 font-mono text-xs text-gray-700">{Number(l.km).toLocaleString("es-PE")}</td>
                        <td className="p-2.5 text-xs text-gray-600">{fmtFecha(l.fecha)}</td>
                        <td className="p-2.5 text-xs text-gray-600">{FUENTE_LABEL[l.fuente] || l.fuente}</td>
                        <td className="p-2.5">
                          <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: est.bg, color: est.color }}>{est.label}</span>
                        </td>
                        <td className="p-2.5 text-xs">
                          {l.foto_url ? <a href={l.foto_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">ver</a> : "—"}
                        </td>
                        <td className="p-2.5 text-right">
                          {l.estado !== "anulada" && (
                            <button onClick={() => setAnular(l)}
                              className="text-xs font-bold text-red-500 hover:underline whitespace-nowrap"
                              title="Anular esta lectura indicando el error">🗑 Anular</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>

      {/* stopPropagation: el overlay padre cierra al hacer click, y este modal vive dentro de él */}
      {anular && (
        <div onClick={e => e.stopPropagation()}>
        <AnularLecturaOdometro
          lectura={anular}
          placa={vehiculo.placa}
          onClose={() => setAnular(null)}
          onAnulada={async () => { await cargar(); onSaved(); }}
        />
        </div>
      )}
    </div>
  );
}
