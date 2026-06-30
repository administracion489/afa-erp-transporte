"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Tarea = {
  tarea: string; especificacion?: string | null; categoria?: string | null;
  cantidad?: number | null; unidad?: string | null;
  km_intervalo?: number | null; meses_intervalo?: number | null;
  cada_servicio?: boolean; acciones?: { km: number; accion: string }[];
};
type PlanDraft = {
  marca: string; modelo: string; motor?: string | null;
  anio_desde?: number | null; anio_hasta?: number | null;
  intervalo_base_km?: number | null; intervalo_base_meses?: number | null;
  tareas: Tarea[];
};
type PlanRow = {
  id: string; marca: string; modelo: string; motor: string | null;
  intervalo_base_km: number | null; intervalo_base_meses: number | null;
  estado: string; parsed_por_ia: boolean; fuente_doc_url: string | null; created_at: string;
};
type Vehiculo = { id: number; placa: string; marca?: string; modelo?: string; categoria?: string; kilometraje_actual?: number };

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function inputCls(extra = "") {
  return `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${extra}`;
}
function hoyISO() { return new Date().toISOString().split("T")[0]; }

/** File → {tipo, media_type, base64} para el endpoint de visión */
function fileToAdjunto(file: File): Promise<{ tipo: "image" | "pdf"; media_type: string; data: string }> {
  return new Promise((resolve, reject) => {
    if (file.size > 20 * 1024 * 1024) return reject(new Error("El archivo supera 20 MB"));
    if (!["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"].includes(file.type)) {
      return reject(new Error("Formato no soportado (usa JPG, PNG, WEBP o PDF)"));
    }
    const r = new FileReader();
    r.onload = () => {
      const res = String(r.result || "");
      const base64 = res.includes(",") ? res.split(",")[1] : res;
      const esPdf = file.type === "application/pdf";
      resolve({ tipo: esPdf ? "pdf" : "image", media_type: esPdf ? "application/pdf" : (file.type || "image/jpeg"), data: base64 });
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function PlanesPage() {
  const [planes, setPlanes]       = useState<PlanRow[]>([]);
  const [conteo, setConteo]       = useState<Record<string, { tareas: number; veh: number }>>({});
  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([]);
  const [loading, setLoading]     = useState(true);

  const [archivo, setArchivo]     = useState<File | null>(null);
  const [leyendo, setLeyendo]     = useState(false);
  const [draft, setDraft]         = useState<PlanDraft | null>(null);
  const [guardando, setGuardando] = useState(false);

  // Enrolar
  const [enrolPlan, setEnrolPlan] = useState<PlanRow | null>(null);
  const [enrolSel, setEnrolSel]   = useState<Set<number>>(new Set());
  const [yaEnrolados, setYaEnrolados] = useState<Set<number>>(new Set());

  const cargar = async () => {
    setLoading(true);
    const [pRes, tRes, vpRes, vRes] = await Promise.all([
      supabase.from("planes_mantenimiento").select("*").order("created_at", { ascending: false }),
      supabase.from("plan_tareas").select("plan_id"),
      supabase.from("vehiculos_plan").select("plan_id,vehiculo_id").eq("activo", true),
      supabase.from("vehiculos").select("id,placa,marca,modelo,categoria,kilometraje_actual").order("placa"),
    ]);
    const cnt: Record<string, { tareas: number; veh: number }> = {};
    (tRes.data || []).forEach((t: any) => { (cnt[t.plan_id] ??= { tareas: 0, veh: 0 }).tareas++; });
    (vpRes.data || []).forEach((v: any) => { (cnt[v.plan_id] ??= { tareas: 0, veh: 0 }).veh++; });
    setPlanes(pRes.data || []);
    setConteo(cnt);
    setVehiculos(vRes.data || []);
    setLoading(false);
  };
  useEffect(() => { cargar(); }, []);

  // ── Leer con IA ──────────────────────────────────────────────────────────────

  const leerConIA = async () => {
    if (!archivo) { alert("Selecciona una foto o PDF del plan"); return; }
    setLeyendo(true);
    try {
      const adj = await fileToAdjunto(archivo);
      const res = await fetch("/api/mantenimiento/leer-plan", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adjuntos: [adj] }),
      });
      // El servidor puede devolver una página de error NO-JSON (timeout/crash de
      // la función). Leer como texto y parsear con cuidado para mostrar la causa real.
      const raw = await res.text();
      let data: any;
      try { data = JSON.parse(raw); }
      catch {
        if (res.status === 504 || /timeout|FUNCTION_INVOCATION/i.test(raw))
          throw new Error("El servidor tardó demasiado leyendo el plan (límite de tiempo). Prueba con una imagen más nítida o recortada al cuadro de mantenimiento.");
        throw new Error(`El servidor respondió ${res.status}. ${raw.slice(0, 140)}`);
      }
      if (!res.ok || !data.ok) throw new Error(data?.error || `Error ${res.status}`);
      const p = data.plan;
      setDraft({
        marca: p.marca || "", modelo: p.modelo || "", motor: p.motor || "",
        anio_desde: p.anio_desde ?? null, anio_hasta: p.anio_hasta ?? null,
        intervalo_base_km: p.intervalo_base_km ?? null, intervalo_base_meses: p.intervalo_base_meses ?? null,
        tareas: Array.isArray(p.tareas) ? p.tareas : [],
      });
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setLeyendo(false);
    }
  };

  const setD = (patch: Partial<PlanDraft>) => setDraft(d => d ? { ...d, ...patch } : d);
  const setTarea = (i: number, patch: Partial<Tarea>) =>
    setDraft(d => d ? { ...d, tareas: d.tareas.map((t, j) => j === i ? { ...t, ...patch } : t) } : d);
  const quitarTarea = (i: number) =>
    setDraft(d => d ? { ...d, tareas: d.tareas.filter((_, j) => j !== i) } : d);
  const agregarTarea = () =>
    setDraft(d => d ? { ...d, tareas: [...d.tareas, { tarea: "", categoria: "Otros", cada_servicio: false, acciones: [] }] } : d);

  // ── Guardar plan ───────────────────────────────────────────────────────────────

  const guardarPlan = async () => {
    if (!draft || !draft.marca.trim() || !draft.modelo.trim()) { alert("Marca y modelo son obligatorios"); return; }
    setGuardando(true);
    try {
      // Subir documento original (si hay)
      let fuenteUrl: string | null = null;
      if (archivo) {
        const ext = archivo.name.split(".").pop() || "bin";
        const path = `planes-mantenimiento/${Date.now()}.${ext}`;
        const up = await supabase.storage.from("documentos").upload(path, archivo, { upsert: true });
        if (!up.error) fuenteUrl = supabase.storage.from("documentos").getPublicUrl(path).data.publicUrl;
      }

      const { data: plan, error } = await supabase.from("planes_mantenimiento").insert({
        marca: draft.marca.trim(), modelo: draft.modelo.trim(), motor: draft.motor?.trim() || null,
        anio_desde: draft.anio_desde || null, anio_hasta: draft.anio_hasta || null,
        intervalo_base_km: draft.intervalo_base_km || null, intervalo_base_meses: draft.intervalo_base_meses || null,
        fuente_doc_url: fuenteUrl, parsed_por_ia: true, estado: "borrador",
      }).select("*").single();
      if (error) throw error;

      const tareas = draft.tareas.filter(t => t.tarea.trim()).map((t, idx) => ({
        plan_id: plan.id, orden: idx, tarea: t.tarea.trim(),
        especificacion: t.especificacion?.trim() || null, categoria: t.categoria || null,
        cantidad: t.cantidad ?? null, unidad: t.unidad || null,
        km_intervalo: t.km_intervalo ?? null, meses_intervalo: t.meses_intervalo ?? null,
        cada_servicio: !!t.cada_servicio, acciones: t.acciones || [],
      }));
      if (tareas.length) {
        const { error: e2 } = await supabase.from("plan_tareas").insert(tareas);
        if (e2) throw e2;
      }

      setDraft(null); setArchivo(null);
      await cargar();
      abrirEnrolar(plan as PlanRow); // pasar directo a enrolar
    } catch (e: any) {
      alert("Error al guardar: " + e.message);
    } finally {
      setGuardando(false);
    }
  };

  // ── Enrolar vehículos ─────────────────────────────────────────────────────────

  const vehiculosDelModelo = (p: PlanRow) =>
    vehiculos.filter(v =>
      (v.modelo || "").toLowerCase().trim() === p.modelo.toLowerCase().trim() &&
      (!p.marca || (v.marca || "").toLowerCase().trim() === p.marca.toLowerCase().trim())
    );

  const abrirEnrolar = async (p: PlanRow) => {
    const { data } = await supabase.from("vehiculos_plan").select("vehiculo_id").eq("plan_id", p.id).eq("activo", true);
    const ya = new Set<number>((data || []).map((r: any) => r.vehiculo_id));
    setYaEnrolados(ya);
    // preselección: los del modelo + los ya enrolados
    const pre = new Set<number>(ya);
    vehiculosDelModelo(p).forEach(v => pre.add(v.id));
    setEnrolSel(pre);
    setEnrolPlan(p);
  };

  const aplicarEnrol = async () => {
    if (!enrolPlan) return;
    setGuardando(true);
    try {
      const ids = [...enrolSel];
      if (ids.length) {
        // No sobrescribir km_base/fecha_base de los que ya existían (preservar ancla histórica)
        const { data: existentes } = await supabase.from("vehiculos_plan").select("vehiculo_id").eq("plan_id", enrolPlan.id);
        const yaHay = new Set<number>((existentes || []).map((r: any) => r.vehiculo_id));
        const nuevos = ids.filter(id => !yaHay.has(id));
        const reactivar = ids.filter(id => yaHay.has(id));
        if (nuevos.length) {
          const filas = nuevos.map(vid => {
            const v = vehiculos.find(x => x.id === vid);
            return { vehiculo_id: vid, plan_id: enrolPlan.id, activo: true, km_base: v?.kilometraje_actual ?? null, fecha_base: hoyISO() };
          });
          const { error } = await supabase.from("vehiculos_plan").insert(filas);
          if (error) throw error;
        }
        if (reactivar.length) {
          const { error } = await supabase.from("vehiculos_plan").update({ activo: true })
            .eq("plan_id", enrolPlan.id).in("vehiculo_id", reactivar);
          if (error) throw error;
        }
      }
      // desactivar los desmarcados que estaban enrolados
      const quitar = [...yaEnrolados].filter(id => !enrolSel.has(id));
      if (quitar.length) {
        await supabase.from("vehiculos_plan").update({ activo: false })
          .eq("plan_id", enrolPlan.id).in("vehiculo_id", quitar);
      }
      setEnrolPlan(null);
      await cargar();
      alert("Unidades enroladas ✓");
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setGuardando(false);
    }
  };

  const aprobarPlan = async (p: PlanRow) => {
    await supabase.from("planes_mantenimiento").update({ estado: p.estado === "aprobado" ? "borrador" : "aprobado" }).eq("id", p.id);
    cargar();
  };
  const eliminarPlan = async (p: PlanRow) => {
    if (!confirm(`¿Eliminar el plan ${p.marca} ${p.modelo}? Se quitarán sus tareas y enrolamientos.`)) return;
    await supabase.from("planes_mantenimiento").delete().eq("id", p.id);
    cargar();
  };

  const enrolListados = enrolPlan ? (() => {
    const delModelo = vehiculosDelModelo(enrolPlan);
    const otros = vehiculos.filter(v => !delModelo.some(d => d.id === v.id));
    return { delModelo, otros };
  })() : null;

  // ─── RENDER ───────────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Planes del Fabricante</h1>
        <p className="text-gray-400 text-sm mt-1">
          Sube la foto/PDF del plan y la IA lo arma · revísalo · enrola las unidades del modelo
        </p>
      </div>

      {/* CARGA */}
      {!draft && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>🤖</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">Cargar plan con IA</h2>
              <p className="text-xs text-gray-400">Foto (JPG/PNG) o PDF del cuadro de mantenimiento del fabricante</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <input type="file" accept="image/*,application/pdf"
              onChange={e => setArchivo(e.target.files?.[0] || null)}
              className="text-sm file:mr-3 file:px-4 file:py-2 file:rounded-xl file:border-0 file:bg-[#0b315f] file:text-white file:font-bold file:text-xs hover:file:opacity-90" />
            <button onClick={leerConIA} disabled={!archivo || leyendo}
              className="px-5 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90" style={{ background: "#0b315f" }}>
              {leyendo ? "Leyendo con IA…" : "Leer con IA"}
            </button>
          </div>
        </section>
      )}

      {/* REVISIÓN */}
      {draft && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-gray-900">Revisa y corrige el plan</h2>
            <button onClick={() => setDraft(null)} className="text-gray-400 hover:text-gray-600 text-sm">✕ Descartar</button>
          </div>
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
            ⚠️ La IA puede equivocarse al leer la matriz. Verifica intervalos y tareas antes de guardar.
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div><label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Marca *</label>
              <input className={inputCls()} value={draft.marca} onChange={e => setD({ marca: e.target.value })} /></div>
            <div><label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Modelo *</label>
              <input className={inputCls()} value={draft.modelo} onChange={e => setD({ modelo: e.target.value })} /></div>
            <div><label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Motor</label>
              <input className={inputCls()} value={draft.motor || ""} onChange={e => setD({ motor: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-2">
              <div><label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Cada (km)</label>
                <input type="number" className={inputCls("font-mono")} value={draft.intervalo_base_km ?? ""} onChange={e => setD({ intervalo_base_km: e.target.value ? Number(e.target.value) : null })} /></div>
              <div><label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Cada (meses)</label>
                <input type="number" className={inputCls("font-mono")} value={draft.intervalo_base_meses ?? ""} onChange={e => setD({ intervalo_base_meses: e.target.value ? Number(e.target.value) : null })} /></div>
            </div>
          </div>

          {/* tareas */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400">Tareas ({draft.tareas.length})</p>
              <button onClick={agregarTarea} className="text-xs font-bold text-[#0b315f] hover:underline">+ Agregar tarea</button>
            </div>
            <div className="overflow-x-auto border rounded-xl">
              <table className="w-full text-sm">
                <thead><tr style={{ background: "#f8fafc" }}>
                  {["Tarea", "Especificación", "Categoría", "Cambio c/km", "Cambio c/meses", "Cada serv.", ""].map(h =>
                    <th key={h} className="p-2 text-left text-[10px] font-bold text-gray-500 uppercase">{h}</th>)}
                </tr></thead>
                <tbody>
                  {draft.tareas.map((t, i) => (
                    <tr key={i} className="border-t" style={{ borderColor: "#f1f5f9" }}>
                      <td className="p-1.5"><input className="w-full border rounded-lg px-2 py-1 text-xs" value={t.tarea} onChange={e => setTarea(i, { tarea: e.target.value })} /></td>
                      <td className="p-1.5"><input className="w-full border rounded-lg px-2 py-1 text-xs" value={t.especificacion || ""} onChange={e => setTarea(i, { especificacion: e.target.value })} /></td>
                      <td className="p-1.5"><input className="w-28 border rounded-lg px-2 py-1 text-xs" value={t.categoria || ""} onChange={e => setTarea(i, { categoria: e.target.value })} /></td>
                      <td className="p-1.5"><input type="number" className="w-24 border rounded-lg px-2 py-1 text-xs font-mono" value={t.km_intervalo ?? ""} onChange={e => setTarea(i, { km_intervalo: e.target.value ? Number(e.target.value) : null })} /></td>
                      <td className="p-1.5"><input type="number" className="w-20 border rounded-lg px-2 py-1 text-xs font-mono" value={t.meses_intervalo ?? ""} onChange={e => setTarea(i, { meses_intervalo: e.target.value ? Number(e.target.value) : null })} /></td>
                      <td className="p-1.5 text-center"><input type="checkbox" checked={!!t.cada_servicio} onChange={e => setTarea(i, { cada_servicio: e.target.checked })} /></td>
                      <td className="p-1.5"><button onClick={() => quitarTarea(i)} className="text-red-400 hover:text-red-600 text-xs">✕</button></td>
                    </tr>
                  ))}
                  {draft.tareas.length === 0 && <tr><td colSpan={7} className="p-4 text-center text-gray-400 text-xs">Sin tareas. Agrega manualmente.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={guardarPlan} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90" style={{ background: "#0b315f" }}>
              {guardando ? "Guardando…" : "Guardar y enrolar unidades"}
            </button>
            <button onClick={() => setDraft(null)} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* LISTA DE PLANES */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b"><h2 className="font-bold text-gray-800 text-sm">Planes registrados</h2></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
              {["Modelo", "Servicio cada", "Tareas", "Unidades", "Estado", "Acciones"].map(h =>
                <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>)}
            </tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="p-10 text-center text-gray-400">Cargando…</td></tr>
              ) : planes.length === 0 ? (
                <tr><td colSpan={6} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">📋</p><p className="font-medium">Aún no hay planes. Carga uno con IA.</p>
                </td></tr>
              ) : planes.map(p => {
                const c = conteo[p.id] || { tareas: 0, veh: 0 };
                const aprob = p.estado === "aprobado";
                return (
                  <tr key={p.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                    <td className="p-3">
                      <span className="font-bold text-gray-800">{p.marca} {p.modelo}</span>
                      {p.motor ? <span className="text-gray-400 text-xs"> · {p.motor}</span> : null}
                    </td>
                    <td className="p-3 text-xs text-gray-600">
                      {p.intervalo_base_km ? `${p.intervalo_base_km.toLocaleString("es-PE")} km` : ""}
                      {p.intervalo_base_km && p.intervalo_base_meses ? " / " : ""}
                      {p.intervalo_base_meses ? `${p.intervalo_base_meses} meses` : ""}
                      {!p.intervalo_base_km && !p.intervalo_base_meses ? "—" : ""}
                    </td>
                    <td className="p-3 text-xs text-gray-600">{c.tareas}</td>
                    <td className="p-3 text-xs text-gray-600">{c.veh}</td>
                    <td className="p-3">
                      <span className="text-xs font-bold px-2 py-0.5 rounded-lg"
                        style={{ background: aprob ? "#dcfce7" : "#fef9c3", color: aprob ? "#166534" : "#854d0e" }}>
                        {aprob ? "Aprobado" : "Borrador"}
                      </span>
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <button onClick={() => abrirEnrolar(p)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">🚍 Enrolar</button>
                        <button onClick={() => aprobarPlan(p)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">{aprob ? "↩ A borrador" : "✓ Aprobar"}</button>
                        <button onClick={() => eliminarPlan(p)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* MODAL ENROLAR */}
      {enrolPlan && enrolListados && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={() => setEnrolPlan(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl mt-10" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b flex items-center justify-between">
              <div>
                <h3 className="font-bold text-gray-900">Enrolar unidades — {enrolPlan.marca} {enrolPlan.modelo}</h3>
                <p className="text-xs text-gray-400">Las del modelo vienen marcadas. Puedes ajustar a cuáles aplica.</p>
              </div>
              <button onClick={() => setEnrolPlan(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-widest text-gray-400 mb-2">Unidades de este modelo ({enrolListados.delModelo.length})</p>
                {enrolListados.delModelo.length === 0 && <p className="text-xs text-gray-400">No hay vehículos con marca/modelo que coincidan exactamente.</p>}
                <div className="space-y-1">
                  {enrolListados.delModelo.map(v => (
                    <label key={v.id} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50 rounded-lg cursor-pointer border">
                      <input type="checkbox" checked={enrolSel.has(v.id)}
                        onChange={() => setEnrolSel(p => { const n = new Set(p); n.has(v.id) ? n.delete(v.id) : n.add(v.id); return n; })} />
                      <span className="font-mono font-bold text-[#0b315f] w-24">{v.placa}</span>
                      <span className="text-gray-600 flex-1">{v.marca} {v.modelo}</span>
                      <span className="text-gray-400 text-xs font-mono">{(v.kilometraje_actual ?? 0).toLocaleString("es-PE")} km</span>
                    </label>
                  ))}
                </div>
              </div>
              <details>
                <summary className="text-[11px] font-bold uppercase tracking-widest text-gray-400 cursor-pointer">Otras unidades ({enrolListados.otros.length})</summary>
                <div className="space-y-1 mt-2">
                  {enrolListados.otros.map(v => (
                    <label key={v.id} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50 rounded-lg cursor-pointer border">
                      <input type="checkbox" checked={enrolSel.has(v.id)}
                        onChange={() => setEnrolSel(p => { const n = new Set(p); n.has(v.id) ? n.delete(v.id) : n.add(v.id); return n; })} />
                      <span className="font-mono font-bold text-[#0b315f] w-24">{v.placa}</span>
                      <span className="text-gray-600 flex-1">{v.marca} {v.modelo}{v.categoria ? ` · ${v.categoria}` : ""}</span>
                    </label>
                  ))}
                </div>
              </details>
            </div>
            <div className="px-6 py-4 border-t flex justify-between items-center">
              <span className="text-xs text-gray-500">{enrolSel.size} unidad(es) seleccionada(s)</span>
              <div className="flex gap-3">
                <button onClick={() => setEnrolPlan(null)} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
                <button onClick={aplicarEnrol} disabled={guardando}
                  className="px-5 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90" style={{ background: "#0b315f" }}>
                  {guardando ? "Aplicando…" : "Aplicar a seleccionadas"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
