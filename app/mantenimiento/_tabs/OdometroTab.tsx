"use client";

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { paginarFilas } from "@/lib/huella";
import { registrarLectura, aceptarLectura, marcarReinicio, type FuenteLectura } from "@/lib/odometro";
import {
  analizarVehiculo, resumenPeriodo, claveVehiculo, hoyLima, sumarDias,
  type LecturaCruda, type DiaRecorrido, type Anomalia,
} from "@/lib/odometro-analitica";
import { BarrasHorizontal } from "./_charts";
import AnaliticaVehiculo, { type VehiculoAnalitica } from "./_AnaliticaVehiculo";
import AnularLecturaOdometro from "@/components/AnularLecturaOdometro";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Vehiculo = { id: number; placa: string; categoria?: string; marca?: string; modelo?: string; kilometraje_actual?: number };
type Lectura = LecturaCruda;

const FUENTE_LABEL: Record<string, string> = {
  combustible: "Combustible", checklist: "Inicio servicio", servicio: "Servicio",
  whatsapp_foto: "WhatsApp (foto)", whatsapp_manual: "WhatsApp (manual)", manual: "Manual",
};
const ESTADO_CFG: Record<string, { label: string; bg: string; color: string }> = {
  aceptada:   { label: "Aceptada",   bg: "#dcfce7", color: "#166534" },
  sospechosa: { label: "Por revisar", bg: "#fef9c3", color: "#854d0e" },
  rechazada:  { label: "Rechazada",  bg: "#fee2e2", color: "#991b1b" },
  reinicio:   { label: "Reinicio",   bg: "#dbeafe", color: "#1d4ed8" },
  anulada:    { label: "Anulada",    bg: "#f1f5f9", color: "#64748b" },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function inputCls(extra = "") {
  return `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${extra}`;
}
function fmtFecha(f: string | null | undefined) {
  if (!f) return "—";
  return new Date(f + (f.length <= 10 ? "T00:00:00" : "")).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function fmtNum(n: number | null | undefined) { return n == null ? "—" : Number(n).toLocaleString("es-PE"); }

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

// Peor severidad de una lista de anomalías (para pintar el badge de la jornada).
function peorSeveridad(anoms: Anomalia[]): "critico" | "advertencia" | null {
  if (anoms.some((a) => a.severidad === "critico" && a.tipo !== "sin_recorrido")) return "critico";
  if (anoms.some((a) => a.severidad === "advertencia")) return "advertencia";
  return null;
}

const VENTANA_DIAS = 180; // histórico cargado para la analítica/jornadas

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function OdometroTab() {
  const hoy = hoyLima();

  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([]);
  const [terceros, setTerceros]   = useState<Vehiculo[]>([]);
  const [lecturas, setLecturas]   = useState<Lectura[]>([]);
  const [sospechosas, setSospechosas] = useState<Lectura[]>([]);
  const [kmDiaMax, setKmDiaMax]   = useState(1500);
  const [loading, setLoading]     = useState(true);

  // Filtros / vista
  const [vista, setVista]         = useState<"jornada" | "historial">("jornada");
  const [buscar, setBuscar]       = useState("");
  const [flota, setFlota]         = useState<"propia" | "tercero" | "todas">("propia");
  const [fEstado, setFEstado]     = useState("todos");
  const [fFuente, setFFuente]     = useState("todas");
  const [desde, setDesde]         = useState(sumarDias(hoy, -29));
  const [hasta, setHasta]         = useState(hoy);

  // Drawer de analítica
  const [vehSel, setVehSel]       = useState<VehiculoAnalitica | null>(null);

  // Visor de la foto del tablero (evidencia de la lectura)
  const [fotoZoom, setFotoZoom]   = useState<{ url: string; titulo: string } | null>(null);

  // Anulación de una lectura (con motivo → alimenta el aprendizaje de la IA)
  const [anular, setAnular]       = useState<Lectura | null>(null);

  // Registro
  const [form, setForm] = useState({ vehiculo_id: "", km: "", fecha: hoy, fuente: "manual" as FuenteLectura });
  const [foto, setFoto] = useState<File | null>(null);
  const [leyendo, setLeyendo]     = useState(false);
  const [guardando, setGuardando] = useState(false);

  const cargar = async () => {
    setLoading(true);
    const desdeVentana = sumarDias(hoy, -VENTANA_DIAS);
    const [vRes, tRes, cRes, lecAll, sospRes] = await Promise.all([
      supabase.from("vehiculos").select("id,placa,categoria,marca,modelo,kilometraje_actual").order("placa"),
      supabase.from("vehiculos_tercero").select("id,placa,categoria,marca,modelo,kilometraje_actual").order("placa"),
      supabase.from("config_mantenimiento").select("km_dia_max").eq("id", 1).maybeSingle(),
      // Ambas flotas, todos los estados, ventana de 180 días (paginado para no truncar a 1000).
      paginarFilas(() =>
        supabase.from("lecturas_odometro")
          .select("id,vehiculo_id,vehiculo_tercero_id,km,fuente,fecha,estado,motivo,created_at,momento,foto_url")
          .gte("fecha", desdeVentana)
          .order("fecha", { ascending: false })
      ),
      // "Por revisar" completo (independiente de la ventana): pocas filas, siempre accionables.
      supabase.from("lecturas_odometro")
        .select("id,vehiculo_id,vehiculo_tercero_id,km,fuente,fecha,estado,motivo,created_at,momento,foto_url")
        .eq("estado", "sospechosa").order("created_at", { ascending: false }).limit(300),
    ]);
    setVehiculos(vRes.data || []);
    setTerceros(tRes.data || []);
    setLecturas((lecAll || []) as Lectura[]);
    setSospechosas((sospRes.data || []) as Lectura[]);
    if (cRes.data?.km_dia_max) setKmDiaMax(cRes.data.km_dia_max);
    setLoading(false);
  };
  useEffect(() => { cargar(); }, []);

  // Mapa clave → placa (ambas flotas).
  const placaMap = useMemo(() => {
    const m = new Map<string, string>();
    vehiculos.forEach((v) => m.set(`p:${v.id}`, v.placa));
    terceros.forEach((v) => m.set(`t:${v.id}`, v.placa));
    return m;
  }, [vehiculos, terceros]);
  const placaDe = (l: { vehiculo_id: number | null; vehiculo_tercero_id?: number | null }) =>
    placaMap.get(claveVehiculo(l)) || `#${l.vehiculo_tercero_id ?? l.vehiculo_id}`;
  const placaDeKey = (k: string) => placaMap.get(k) || k;

  const pasaFlota = (k: string) =>
    flota === "todas" || (flota === "propia" ? k.startsWith("p:") : k.startsWith("t:"));
  const pasaBuscar = (placa: string) => !buscar.trim() || placa.toLowerCase().includes(buscar.trim().toLowerCase());

  // Análisis por vehículo (sanea + recorridos + anomalías) sobre la ventana cargada.
  const analisisPorVeh = useMemo(() => {
    const porVeh = new Map<string, Lectura[]>();
    for (const l of lecturas) {
      const k = claveVehiculo(l);
      const arr = porVeh.get(k); if (arr) arr.push(l); else porVeh.set(k, [l]);
    }
    const res = new Map<string, ReturnType<typeof analizarVehiculo>>();
    for (const [k, ls] of porVeh) res.set(k, analizarVehiculo(ls));
    return res;
  }, [lecturas]);

  // Jornadas (recorrido diario) filtradas.
  const jornadas = useMemo(() => {
    const rows: (DiaRecorrido & { placa: string })[] = [];
    for (const [k, a] of analisisPorVeh) {
      if (!pasaFlota(k)) continue;
      const placa = placaDeKey(k);
      if (!pasaBuscar(placa)) continue;
      for (const d of a.dias) {
        if (d.fecha < desde || d.fecha > hasta) continue;
        rows.push({ ...d, placa });
      }
    }
    return rows.sort((a, b) => (a.fecha !== b.fecha ? (a.fecha < b.fecha ? 1 : -1) : a.placa.localeCompare(b.placa)));
  }, [analisisPorVeh, flota, buscar, desde, hasta, placaMap]);

  // Historial plano filtrado.
  const historial = useMemo(() => {
    return lecturas
      .filter((l) => {
        const k = claveVehiculo(l);
        if (!pasaFlota(k)) return false;
        if (!pasaBuscar(placaDeKey(k))) return false;
        if (fEstado !== "todos" && l.estado !== fEstado) return false;
        if (fFuente !== "todas" && l.fuente !== fFuente) return false;
        if (l.fecha < desde || l.fecha > hasta) return false;
        return true;
      })
      .sort((a, b) => (new Date(b.created_at).getTime() || 0) - (new Date(a.created_at).getTime() || 0));
  }, [lecturas, flota, buscar, fEstado, fFuente, desde, hasta, placaMap]);

  // Comparativo entre vehículos (km del mes en curso, por odómetro).
  const comparativo = useMemo(() => {
    const inicioMes = hoy.slice(0, 8) + "01";
    const arr: { label: string; value: number; sub?: string }[] = [];
    for (const [k, a] of analisisPorVeh) {
      if (!pasaFlota(k)) continue;
      const placa = placaDeKey(k);
      if (!pasaBuscar(placa)) continue;
      const r = resumenPeriodo(a.dias, inicioMes, hoy);
      if (r.kmTotal > 0) arr.push({ label: placa, value: r.kmTotal, sub: `${r.diasConDato}d` });
    }
    return arr.sort((a, b) => b.value - a.value).slice(0, 15);
  }, [analisisPorVeh, flota, buscar, placaMap, hoy]);

  // Totales del período filtrado (para el encabezado de la vista jornada).
  const totalPeriodo = useMemo(() => {
    let km = 0, dias = 0, pend = 0, anom = 0;
    for (const j of jornadas) {
      if (j.pendiente) pend++;
      else if (j.recorrido != null) { km += j.recorrido; dias++; }
      if (peorSeveridad(j.anomalias)) anom++;
    }
    return { km: Math.round(km), dias, pend, anom };
  }, [jornadas]);

  const vehName = (l: { vehiculo_id: number | null; vehiculo_tercero_id?: number | null }) => placaDe(l);

  // ── Leer odómetro con IA ──────────────────────────────────────────────────────

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
      if (r.estado === "sospechosa") alert(`Registrada pero marcada para revisión: ${r.motivo}`);
      else alert("Lectura registrada ✓");
      setForm({ vehiculo_id: "", km: "", fecha: hoy, fuente: "manual" });
      setFoto(null);
      await cargar();
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setGuardando(false);
    }
  };

  // ── Acciones del panel de revisión ──────────────────────────────────────────────

  const aceptar = async (l: Lectura) => { await aceptarLectura(supabase, l.id); cargar(); };
  const rechazar = async (l: Lectura) => {
    await supabase.from("lecturas_odometro").update({ estado: "rechazada", motivo: "Rechazada manualmente" }).eq("id", l.id);
    cargar();
  };
  const reiniciar = async (l: Lectura) => {
    if (!confirm(`¿Marcar ${Number(l.km).toLocaleString("es-PE")} km como REINICIO de odómetro para ${vehName(l)}? El km vigente se re-anclará a este valor.`)) return;
    const esTercero = l.vehiculo_tercero_id != null;
    await marcarReinicio(supabase, {
      vehiculo_id: esTercero ? (l.vehiculo_tercero_id as number) : (l.vehiculo_id as number),
      km: l.km, fecha: l.fecha, flota: esTercero ? "tercero" : "propia",
    });
    await supabase.from("lecturas_odometro").update({ estado: "reinicio", motivo: "Confirmado como reinicio" }).eq("id", l.id);
    cargar();
  };

  const abrirAnalitica = (key: string) => {
    const esTercero = key.startsWith("t:");
    const id = Number(key.slice(2));
    const src = (esTercero ? terceros : vehiculos).find((v) => v.id === id);
    setVehSel({
      key, id, flota: esTercero ? "tercero" : "propia",
      placa: src?.placa || placaDeKey(key), categoria: src?.categoria, kilometraje_actual: src?.kilometraje_actual,
    });
  };

  const porRevisar = sospechosas;
  const fuentesDisponibles = useMemo(() => [...new Set(lecturas.map((l) => l.fuente))], [lecturas]);

  // ─── RENDER ───────────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Odómetro</h1>
        <p className="text-gray-400 text-sm mt-1">
          Recorrido por jornada · validación anti-trampa · analítica operativa por vehículo · alertas de patrón
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
                {["Foto", "Vehículo", "Km", "Fecha", "Fuente", "Motivo", "Acciones"].map(h =>
                  <th key={h} className="p-3 text-left text-xs font-bold text-amber-700 uppercase tracking-wide">{h}</th>)}
              </tr></thead>
              <tbody>
                {porRevisar.map(l => (
                  <tr key={l.id} className="border-t" style={{ borderColor: "#fde68a" }}>
                    <td className="p-2">
                      {l.foto_url ? (
                        <button type="button"
                          onClick={() => setFotoZoom({ url: l.foto_url!, titulo: `${vehName(l)} · ${Number(l.km).toLocaleString("es-PE")} km · ${fmtFecha(l.fecha)}` })}
                          className="block rounded-lg overflow-hidden border border-amber-200 hover:ring-2 hover:ring-amber-400"
                          title="Ver foto del tablero">
                          <img src={l.foto_url} alt="Tablero" className="w-16 h-12 object-cover" />
                        </button>
                      ) : (
                        <span className="text-[11px] text-gray-400">sin foto</span>
                      )}
                    </td>
                    <td className="p-3 font-mono font-bold text-[#0b315f] text-xs">{vehName(l)}</td>
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

      {/* FILTROS */}
      <section className="bg-white rounded-2xl border shadow-sm p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[160px]">
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Buscar placa</label>
            <input className={inputCls()} placeholder="Ej: BUB-236" value={buscar} onChange={e => setBuscar(e.target.value)} list="placas-odo" />
            <datalist id="placas-odo">
              {[...vehiculos, ...terceros].map(v => <option key={v.placa} value={v.placa} />)}
            </datalist>
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Flota</label>
            <select className={inputCls()} value={flota} onChange={e => setFlota(e.target.value as any)}>
              <option value="propia">Propia</option>
              <option value="tercero">Terceros</option>
              <option value="todas">Todas</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Desde</label>
            <input type="date" className={inputCls()} value={desde} max={hasta} onChange={e => setDesde(e.target.value)} />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Hasta</label>
            <input type="date" className={inputCls()} value={hasta} min={desde} onChange={e => setHasta(e.target.value)} />
          </div>
          {vista === "historial" && (
            <>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Estado</label>
                <select className={inputCls()} value={fEstado} onChange={e => setFEstado(e.target.value)}>
                  <option value="todos">Todos</option>
                  {Object.entries(ESTADO_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Fuente</label>
                <select className={inputCls()} value={fFuente} onChange={e => setFFuente(e.target.value)}>
                  <option value="todas">Todas</option>
                  {fuentesDisponibles.map(f => <option key={f} value={f}>{FUENTE_LABEL[f] || f}</option>)}
                </select>
              </div>
            </>
          )}
        </div>
        {/* Toggle vista */}
        <div className="flex gap-1 mt-3 border-t pt-3">
          {([["jornada", "🚌 Recorrido por jornada"], ["historial", "📋 Historial de lecturas"]] as const).map(([k, lbl]) => (
            <button key={k} onClick={() => setVista(k)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${vista === k ? "bg-[#0b315f] text-white" : "text-gray-500 hover:bg-gray-100"}`}>
              {lbl}
            </button>
          ))}
        </div>
      </section>

      {loading ? (
        <div className="p-10 text-center text-gray-400">Cargando…</div>
      ) : vista === "jornada" ? (
        <>
          {/* RESUMEN DEL PERÍODO */}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: "Km del período", valor: fmtNum(totalPeriodo.km), color: "#0b315f", bg: "#eff6ff" },
              { label: "Jornadas con dato", valor: totalPeriodo.dias, color: "#166534", bg: "#dcfce7" },
              { label: "Pendientes", valor: totalPeriodo.pend, color: "#854d0e", bg: "#fef9c3" },
              { label: "Con anomalía", valor: totalPeriodo.anom, color: "#991b1b", bg: "#fee2e2" },
            ].map(k => (
              <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
                <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
                <p className="text-2xl font-black mt-0.5 leading-tight" style={{ color: k.color }}>{k.valor}</p>
              </div>
            ))}
          </section>

          {/* TABLA JORNADAS */}
          <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
            <div className="px-5 py-3 border-b flex items-center justify-between">
              <h2 className="font-bold text-gray-800 text-sm">Recorrido por jornada</h2>
              <span className="text-xs text-gray-400">{jornadas.length} jornadas</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  {["Vehículo", "Fecha", "Primera", "Última", "Recorrido", "Lecturas", "Estado", ""].map(h =>
                    <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>)}
                </tr></thead>
                <tbody>
                  {jornadas.length === 0 ? (
                    <tr><td colSpan={8} className="p-10 text-center text-gray-400">
                      <p className="text-3xl mb-2">🚌</p><p className="font-medium">Sin jornadas en el filtro</p>
                    </td></tr>
                  ) : jornadas.map((j) => {
                    const sev = peorSeveridad(j.anomalias);
                    return (
                      <tr key={`${j.key}-${j.fecha}`} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                        <td className="p-3 font-mono font-bold text-[#0b315f] text-xs">{j.placa}</td>
                        <td className="p-3 text-xs text-gray-600">{fmtFecha(j.fecha)}</td>
                        <td className="p-3 text-xs text-gray-600 font-mono">{fmtNum(j.primeraKm)}<span className="text-gray-300"> · {j.primeraHora || "—"}</span></td>
                        <td className="p-3 text-xs text-gray-600 font-mono">{j.pendiente ? "—" : fmtNum(j.ultimaKm)}<span className="text-gray-300">{j.ultimaHora && !j.pendiente ? ` · ${j.ultimaHora}` : ""}</span></td>
                        <td className="p-3 text-xs font-mono font-bold">
                          {j.pendiente ? <span className="text-amber-600 font-sans font-normal">Pendiente</span>
                            : j.reinicio ? <span className="text-blue-600 font-sans font-normal">Reinicio</span>
                            : j.recorrido == null ? "—"
                            : <span style={{ color: sev === "critico" ? "#991b1b" : sev === "advertencia" ? "#b45309" : "#0b315f" }}>{fmtNum(j.recorrido)} km</span>}
                        </td>
                        <td className="p-3 text-xs text-gray-500">{j.nLecturas}</td>
                        <td className="p-3">
                          {sev ? (
                            <span className="text-[11px] font-bold px-2 py-0.5 rounded-lg" style={{ background: sev === "critico" ? "#fee2e2" : "#fef9c3", color: sev === "critico" ? "#991b1b" : "#854d0e" }}
                              title={j.anomalias.map(a => a.mensaje).join(" · ")}>
                              {sev === "critico" ? "❌ Revisar" : "⚠ Atención"}
                            </span>
                          ) : j.pendiente ? (
                            <span className="text-[11px] text-amber-600">⏳</span>
                          ) : (
                            <span className="text-[11px] text-green-600">✓</span>
                          )}
                        </td>
                        <td className="p-3 text-right">
                          <button onClick={() => abrirAnalitica(j.key)} className="text-xs font-bold text-[#0b315f] hover:underline whitespace-nowrap">Analítica →</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* COMPARATIVO ENTRE VEHÍCULOS */}
          {comparativo.length > 0 && (
            <section className="bg-white rounded-2xl border shadow-sm p-5 space-y-3">
              <h2 className="font-bold text-gray-800 text-sm">Comparativo entre vehículos — km del mes</h2>
              <BarrasHorizontal data={comparativo} />
            </section>
          )}
        </>
      ) : (
        /* HISTORIAL PLANO */
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b flex items-center justify-between">
            <h2 className="font-bold text-gray-800 text-sm">Historial de lecturas</h2>
            <span className="text-xs text-gray-400">{historial.length} lecturas</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {["Vehículo", "Km", "Fecha", "Fuente", "Estado", "Foto", ""].map(h =>
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>)}
              </tr></thead>
              <tbody>
                {historial.length === 0 ? (
                  <tr><td colSpan={7} className="p-10 text-center text-gray-400">
                    <p className="text-3xl mb-2">📷</p><p className="font-medium">Sin lecturas en el filtro</p>
                  </td></tr>
                ) : historial.map(l => {
                  const est = ESTADO_CFG[l.estado] || ESTADO_CFG.aceptada;
                  return (
                    <tr key={l.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                      <td className="p-3 font-mono font-bold text-[#0b315f] text-xs">{vehName(l)}</td>
                      <td className="p-3 font-mono text-xs text-gray-700">{Number(l.km).toLocaleString("es-PE")}</td>
                      <td className="p-3 text-xs text-gray-600">{fmtFecha(l.fecha)}</td>
                      <td className="p-3 text-xs text-gray-600">{FUENTE_LABEL[l.fuente] || l.fuente}</td>
                      <td className="p-3">
                        <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: est.bg, color: est.color }}>{est.label}</span>
                      </td>
                      <td className="p-3 text-xs">
                        {l.foto_url
                          ? <button type="button" className="text-blue-600 hover:underline"
                              onClick={() => setFotoZoom({ url: l.foto_url!, titulo: `${vehName(l)} · ${Number(l.km).toLocaleString("es-PE")} km · ${fmtFecha(l.fecha)}` })}>ver</button>
                          : "—"}
                      </td>
                      <td className="p-3 text-right whitespace-nowrap">
                        {l.estado !== "anulada" && (
                          <button onClick={() => setAnular(l)} className="text-xs font-bold text-red-500 hover:underline mr-3"
                            title="Anular esta lectura indicando el error">🗑 Anular</button>
                        )}
                        <button onClick={() => abrirAnalitica(claveVehiculo(l))} className="text-xs font-bold text-[#0b315f] hover:underline">Analítica →</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* DRAWER ANALÍTICA */}
      {vehSel && <AnaliticaVehiculo veh={vehSel} onClose={() => setVehSel(null)} />}

      {/* ANULAR LECTURA (con motivo que se le enseña a la IA) */}
      {anular && (
        <AnularLecturaOdometro
          lectura={{ id: String(anular.id), km: Number(anular.km), fecha: anular.fecha, fuente: anular.fuente, foto_url: anular.foto_url ?? null, estado: anular.estado }}
          placa={vehName(anular)}
          onClose={() => setAnular(null)}
          onAnulada={() => { cargar(); }}
        />
      )}

      {/* VISOR FOTO TABLERO */}
      {fotoZoom && (
        <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center p-4 bg-black/80"
          onClick={() => setFotoZoom(null)}>
          <div className="flex items-center gap-3 mb-2 text-white text-sm font-bold">
            <span>{fotoZoom.titulo}</span>
            <a href={fotoZoom.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
              className="text-xs font-normal underline opacity-80 hover:opacity-100">abrir original</a>
          </div>
          <img src={fotoZoom.url} alt="Foto del tablero"
            className="max-h-[80vh] max-w-full rounded-xl shadow-2xl object-contain"
            onClick={e => e.stopPropagation()} />
          <button onClick={() => setFotoZoom(null)}
            className="mt-3 px-4 py-2 rounded-xl bg-white text-sm font-bold">Cerrar</button>
        </div>
      )}
    </main>
  );
}
