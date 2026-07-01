"use client";

import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { kmPorDia } from "@/lib/odometro";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Vehiculo = {
  id: number; placa: string; categoria?: string;
  marca?: string; modelo?: string; anio?: number; color?: string;
  nro_serie?: string; kilometraje_actual?: number;
};
type Plan = {
  id: string; marca: string; modelo: string; motor?: string;
  intervalo_base_km?: number; intervalo_base_meses?: number;
};
type Enrol = { vehiculo_id: number; km_base?: number; fecha_base?: string; plan: Plan | null };
type Mant = { vehiculo_id: number; fecha: string; kilometraje: number; tipo: string };
type Lectura = { vehiculo_id: number; km: number; fecha: string };

type Config = {
  correos_alerta: string; umbral_km: number; umbral_dias: number;
  km_dia_max: number; alertas_activas: boolean;
};

type Venc = {
  vehiculo: Vehiculo; plan: Plan;
  kmActual: number; kmDia: number | null;
  dueKm: number | null; faltanKm: number | null; diasPorKm: number | null;
  dueFecha: string | null; faltanDias: number | null;
  estado: "vencido" | "proximo" | "ok";
  motivo: string;
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtNum(n: number | null | undefined) {
  return n === null || n === undefined ? "—" : Number(n).toLocaleString("es-PE");
}
function fmtFecha(f: string | null | undefined) {
  if (!f) return "—";
  return new Date(f + (f.length <= 10 ? "T00:00:00" : "")).toLocaleDateString("es-PE", {
    day: "2-digit", month: "2-digit", year: "numeric",
  });
}
function addMeses(fechaISO: string, meses: number): string {
  const d = new Date(fechaISO + "T00:00:00");
  d.setMonth(d.getMonth() + meses);
  return d.toISOString().split("T")[0];
}
function hoyLima(): string {
  const d = new Date(); d.setUTCHours(d.getUTCHours() - 5);
  return d.toISOString().split("T")[0];
}
function diasHasta(fechaISO: string): number {
  return Math.ceil(
    (new Date(fechaISO + "T00:00:00").getTime() - new Date(hoyLima() + "T00:00:00").getTime()) / 86400000
  );
}
function inputCls(extra = "") {
  return `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${extra}`;
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function ProgramaTab() {
  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([]);
  const [terceros, setTerceros]   = useState<Vehiculo[]>([]);
  const [enrol, setEnrol]         = useState<Enrol[]>([]);
  const [mants, setMants]         = useState<Mant[]>([]);
  const [lecturas, setLecturas]   = useState<Lectura[]>([]);
  const [cfg, setCfg]             = useState<Config>({
    correos_alerta: "", umbral_km: 500, umbral_dias: 7, km_dia_max: 1500, alertas_activas: true,
  });
  const [loading, setLoading]   = useState(true);
  const [guardandoCfg, setGuardandoCfg] = useState(false);

  // Export
  const [exportOpen, setExportOpen]       = useState(false);
  const [sel, setSel]                     = useState<Set<number>>(new Set());
  const [buscarSel, setBuscarSel]         = useState("");
  const [catSel, setCatSel]               = useState("todas");
  const [incluirTerceros, setIncluirTerceros] = useState(false);

  const cargar = async () => {
    setLoading(true);
    const desde = addMeses(hoyLima(), -4);
    const [vRes, tRes, eRes, mRes, lRes, cRes] = await Promise.all([
      supabase.from("vehiculos").select("id,placa,categoria,marca,modelo,anio,color,nro_serie,kilometraje_actual").order("placa"),
      supabase.from("vehiculos_tercero").select("id,placa,categoria,marca,modelo").order("placa"),
      supabase.from("vehiculos_plan").select("vehiculo_id,km_base,fecha_base,plan:planes_mantenimiento(id,marca,modelo,motor,intervalo_base_km,intervalo_base_meses)").eq("activo", true),
      supabase.from("mantenimiento").select("vehiculo_id,fecha,kilometraje,tipo").eq("tipo", "preventivo").order("fecha", { ascending: false }),
      supabase.from("lecturas_odometro").select("vehiculo_id,km,fecha").eq("estado", "aceptada").gte("fecha", desde),
      supabase.from("config_mantenimiento").select("*").eq("id", 1).maybeSingle(),
    ]);
    setVehiculos(vRes.data || []);
    setTerceros(tRes.data || []);
    setEnrol((eRes.data || []).map((e: any) => ({ ...e, plan: Array.isArray(e.plan) ? e.plan[0] : e.plan })));
    setMants(mRes.data || []);
    setLecturas(lRes.data || []);
    if (cRes.data) setCfg({
      correos_alerta: cRes.data.correos_alerta || "",
      umbral_km: cRes.data.umbral_km ?? 500,
      umbral_dias: cRes.data.umbral_dias ?? 7,
      km_dia_max: cRes.data.km_dia_max ?? 1500,
      alertas_activas: cRes.data.alertas_activas ?? true,
    });
    setLoading(false);
  };

  useEffect(() => { cargar(); }, []);

  // ── Cálculo de vencimientos (lo que ocurra primero) ──────────────────────────

  const vencimientos: Venc[] = useMemo(() => {
    const vehMap = new Map(vehiculos.map(v => [v.id, v]));
    const ultMant: Record<number, Mant> = {};
    for (const m of mants) if (!ultMant[m.vehiculo_id]) ultMant[m.vehiculo_id] = m;
    const lectPorVeh: Record<number, Lectura[]> = {};
    for (const l of lecturas) (lectPorVeh[l.vehiculo_id] ??= []).push(l);

    const out: Venc[] = [];
    for (const e of enrol) {
      const plan = e.plan; const v = vehMap.get(e.vehiculo_id);
      if (!plan || !v) continue;
      const um = ultMant[e.vehiculo_id];
      const baseFecha = um?.fecha ?? e.fecha_base ?? null;
      const kmActual = Number(v.kilometraje_actual ?? 0);
      const kmDia = kmPorDia(lectPorVeh[e.vehiculo_id] || []);

      // Próximo servicio por KM. El plan del fabricante es por odómetro ABSOLUTO
      // (5k, 10k, 15k…). Si hay un servicio preventivo registrado, el calendario se
      // re-ancla a él (próximo = servicio + intervalo, puede quedar vencido). Si no
      // hay historial, se toma el siguiente hito de la rejilla MAYOR al km actual
      // (una unidad con 7 217 km y plan de 5 000 → próximo 10 000, no 12 217).
      let dueKm: number | null = null, faltanKm: number | null = null, diasPorKm: number | null = null;
      const inter = Number(plan.intervalo_base_km || 0);
      if (inter > 0) {
        const ultServ = um?.kilometraje ?? null;
        dueKm = ultServ !== null
          ? Number(ultServ) + inter
          : (Math.floor(kmActual / inter) + 1) * inter;
        faltanKm = dueKm - kmActual;
        diasPorKm = kmDia && kmDia > 0 && faltanKm > 0 ? Math.round(faltanKm / kmDia) : null;
      }
      let dueFecha: string | null = null, faltanDias: number | null = null;
      if (plan.intervalo_base_meses && baseFecha) {
        dueFecha = addMeses(baseFecha, Number(plan.intervalo_base_meses));
        faltanDias = diasHasta(dueFecha);
      }

      const vencido = (faltanKm !== null && faltanKm <= 0) || (faltanDias !== null && faltanDias <= 0);
      const proximoKm = faltanKm !== null && faltanKm <= cfg.umbral_km;
      const proximoFe = faltanDias !== null && faltanDias <= cfg.umbral_dias;
      const estado = vencido ? "vencido" : (proximoKm || proximoFe) ? "proximo" : "ok";
      const motivo = vencido ? "Vencido" : proximoKm && proximoFe ? "km y fecha" : proximoKm ? "km" : proximoFe ? "fecha" : "—";

      out.push({ vehiculo: v, plan, kmActual, kmDia, dueKm, faltanKm, diasPorKm, dueFecha, faltanDias, estado, motivo });
    }
    // Vencidos primero, luego próximos, luego ok; dentro, por lo que menos falta
    const peso = { vencido: 0, proximo: 1, ok: 2 } as const;
    return out.sort((a, b) =>
      peso[a.estado] - peso[b.estado] ||
      ((a.faltanDias ?? a.diasPorKm ?? 9999) - (b.faltanDias ?? b.diasPorKm ?? 9999))
    );
  }, [vehiculos, enrol, mants, lecturas, cfg.umbral_km, cfg.umbral_dias]);

  const nVencidos = vencimientos.filter(v => v.estado === "vencido").length;
  const nProximos = vencimientos.filter(v => v.estado === "proximo").length;
  const nSinPlan  = vehiculos.length - new Set(enrol.map(e => e.vehiculo_id)).size;

  // ── Config ───────────────────────────────────────────────────────────────────

  const guardarConfig = async () => {
    setGuardandoCfg(true);
    const { error } = await supabase.from("config_mantenimiento").update({
      correos_alerta: cfg.correos_alerta.trim() || null,
      umbral_km: Number(cfg.umbral_km) || 0,
      umbral_dias: Number(cfg.umbral_dias) || 0,
      km_dia_max: Number(cfg.km_dia_max) || 1500,
      alertas_activas: cfg.alertas_activas,
      updated_at: new Date().toISOString(),
    }).eq("id", 1);
    setGuardandoCfg(false);
    if (error) alert("Error al guardar: " + error.message);
    else alert("Configuración guardada ✓");
  };

  // ── Export Excel ──────────────────────────────────────────────────────────────

  const abrirExport = () => {
    setSel(new Set(vehiculos.map(v => v.id))); // preselección: todos los propios
    setExportOpen(true);
  };

  const propiosFiltrados = vehiculos.filter(v => {
    const q = buscarSel.trim().toLowerCase();
    const okQ = !q || `${v.placa} ${v.marca || ""} ${v.modelo || ""}`.toLowerCase().includes(q);
    const okC = catSel === "todas" || (v.categoria || "") === catSel;
    return okQ && okC;
  });
  const categorias = [...new Set(vehiculos.map(v => v.categoria).filter(Boolean))] as string[];

  const toggleSel = (id: number) =>
    setSel(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selTodosFiltrados = () => setSel(prev => { const n = new Set(prev); propiosFiltrados.forEach(v => n.add(v.id)); return n; });
  const selNinguno = () => setSel(new Set());
  const selInvertir = () => setSel(prev => {
    const n = new Set(prev); propiosFiltrados.forEach(v => n.has(v.id) ? n.delete(v.id) : n.add(v.id)); return n;
  });

  const descripcionVeh = (v: Vehiculo) =>
    [v.categoria, v.marca, v.modelo, v.color, v.anio].filter(Boolean).join(" ");

  const generarExcel = () => {
    const sel100 = vehiculos.filter(v => sel.has(v.id));
    if (sel100.length === 0 && !incluirTerceros) { alert("Selecciona al menos un vehículo"); return; }

    const vencMap = new Map(vencimientos.map(x => [x.vehiculo.id, x]));
    const ultMant: Record<number, Mant> = {};
    for (const m of mants) if (!ultMant[m.vehiculo_id]) ultMant[m.vehiculo_id] = m;

    // Hoja 1: Vehículos
    const hojaVeh: any[][] = [[
      "Nro", "Tipo", "Marca", "Modelo", "Placa", "Nro serie", "Color", "Año",
      "Descripción completa", "Odómetro a la fecha (km)",
    ]];
    let n = 0;
    for (const v of sel100) {
      hojaVeh.push([
        ++n, v.categoria || "", v.marca || "", v.modelo || "", v.placa,
        v.nro_serie || "", v.color || "", v.anio || "",
        descripcionVeh(v), v.kilometraje_actual ?? "",
      ]);
    }
    if (incluirTerceros) {
      for (const v of terceros) {
        hojaVeh.push([
          ++n, v.categoria || "", v.marca || "", v.modelo || "", v.placa,
          "", "", "", [v.categoria, v.marca, v.modelo].filter(Boolean).join(" "), "",
        ]);
      }
    }

    // Hoja 2: Próximos Mantenimientos (solo propios seleccionados)
    const hojaProg: any[][] = [[
      "Placa", "Descripción", "Plan", "Odómetro actual (km)", "Último mnto (km)", "Último mnto (fecha)",
      "Próximo mnto (km)", "Faltan (km)", "Próxima fecha", "Faltan (días)", "Estado",
    ]];
    for (const v of sel100) {
      const x = vencMap.get(v.id);
      const um = ultMant[v.id];
      hojaProg.push([
        v.placa, descripcionVeh(v),
        x ? `${x.plan.marca} ${x.plan.modelo}${x.plan.motor ? " " + x.plan.motor : ""}` : "Sin plan",
        v.kilometraje_actual ?? "",
        um?.kilometraje ?? "", um?.fecha ? fmtFecha(um.fecha) : "",
        x?.dueKm ?? "", x?.faltanKm ?? "",
        x?.dueFecha ? fmtFecha(x.dueFecha) : "", x?.faltanDias ?? "",
        x ? (x.estado === "vencido" ? "VENCIDO" : x.estado === "proximo" ? "PRÓXIMO" : "OK") : "Sin plan",
      ]);
    }

    const wb = XLSX.utils.book_new();
    const wsVeh = XLSX.utils.aoa_to_sheet(hojaVeh);
    const wsProg = XLSX.utils.aoa_to_sheet(hojaProg);
    wsVeh["!cols"] = [{ wch: 5 }, { wch: 10 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 20 }, { wch: 12 }, { wch: 7 }, { wch: 34 }, { wch: 18 }];
    wsProg["!cols"] = [{ wch: 12 }, { wch: 28 }, { wch: 22 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, wsVeh, "Vehículos");
    XLSX.utils.book_append_sheet(wb, wsProg, "Próximos Mantenimientos");
    XLSX.writeFile(wb, `Mantenimiento Preventivo AFA — ${hoyLima()}.xlsx`);
    setExportOpen(false);
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-6 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Programa de Mantenimiento</h1>
          <p className="text-gray-400 text-sm mt-1">
            Próximos servicios por km y por tiempo (lo que ocurra primero) · alertas · exportación
          </p>
        </div>
        <button onClick={abrirExport}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white transition-all hover:opacity-90"
          style={{ background: "#166534" }}>
          ⬇ Exportar Excel
        </button>
      </div>

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Vencidos", valor: nVencidos, color: "#991b1b", bg: "#fee2e2" },
          { label: "Próximos", valor: nProximos, color: "#854d0e", bg: "#fef9c3" },
          { label: "Con plan", valor: enrol.length, color: "#166534", bg: "#dcfce7" },
          { label: "Sin plan", valor: nSinPlan, color: "#4b5563", bg: "#f3f4f6" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-2xl font-black mt-0.5 leading-tight" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* TABLA VENCIMIENTOS */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <h2 className="font-bold text-gray-800 text-sm">Próximos / Vencidos</h2>
          <span className="text-xs text-gray-400">{vencimientos.length} con plan</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {["Placa", "Modelo / Plan", "Km actual", "Próximo km", "Faltan km", "Próxima fecha", "Faltan días", "Estado"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="p-10 text-center text-gray-400">Cargando…</td></tr>
              ) : vencimientos.length === 0 ? (
                <tr><td colSpan={8} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">🗓️</p>
                  <p className="font-medium">No hay vehículos enrolados a un plan</p>
                  <p className="text-xs mt-1">Crea un plan en <b>Planes Fabricante</b> y enrola unidades.</p>
                </td></tr>
              ) : vencimientos.map(x => {
                const cfgEst = x.estado === "vencido"
                  ? { bg: "#fee2e2", color: "#991b1b", label: "Vencido" }
                  : x.estado === "proximo"
                  ? { bg: "#fef9c3", color: "#854d0e", label: "Próximo" }
                  : { bg: "#dcfce7", color: "#166534", label: "OK" };
                return (
                  <tr key={x.vehiculo.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                    <td className="p-3 font-black font-mono text-[#0b315f] text-xs">{x.vehiculo.placa}</td>
                    <td className="p-3 text-xs text-gray-600">
                      {x.plan.marca} {x.plan.modelo}{x.plan.motor ? ` · ${x.plan.motor}` : ""}
                    </td>
                    <td className="p-3 font-mono text-xs text-gray-700">{fmtNum(x.kmActual)}</td>
                    <td className="p-3 font-mono text-xs text-gray-700">{fmtNum(x.dueKm)}</td>
                    <td className="p-3 font-mono text-xs" style={{ color: (x.faltanKm ?? 1) <= 0 ? "#991b1b" : "#374151" }}>
                      {x.faltanKm === null ? "—" : x.faltanKm <= 0 ? `Vencido` : fmtNum(x.faltanKm)}
                      {x.diasPorKm !== null && x.faltanKm !== null && x.faltanKm > 0 ? (
                        <span className="text-gray-400"> (~{x.diasPorKm}d)</span>
                      ) : null}
                    </td>
                    <td className="p-3 text-xs text-gray-700">{fmtFecha(x.dueFecha)}</td>
                    <td className="p-3 text-xs" style={{ color: (x.faltanDias ?? 1) <= 0 ? "#991b1b" : "#374151" }}>
                      {x.faltanDias === null ? "—" : x.faltanDias <= 0 ? "Vencido" : `${x.faltanDias}d`}
                    </td>
                    <td className="p-3">
                      <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: cfgEst.bg, color: cfgEst.color }}>
                        {cfgEst.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* CONFIG ALERTAS */}
      <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>✉️</div>
          <div>
            <h2 className="text-lg font-bold text-gray-900">Alertas por correo</h2>
            <p className="text-xs text-gray-400">Se envía un resumen diario automático a los destinatarios</p>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Correos destinatarios (separados por coma)</label>
            <input className={inputCls()} placeholder="administracion@afatoursperu.com, jefe.flota@..."
              value={cfg.correos_alerta} onChange={e => setCfg(c => ({ ...c, correos_alerta: e.target.value }))} />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Avisar cuando falten ≤ (km)</label>
            <input type="number" className={inputCls("font-mono")} value={cfg.umbral_km}
              onChange={e => setCfg(c => ({ ...c, umbral_km: Number(e.target.value) }))} />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Avisar cuando falten ≤ (días)</label>
            <input type="number" className={inputCls("font-mono")} value={cfg.umbral_dias}
              onChange={e => setCfg(c => ({ ...c, umbral_dias: Number(e.target.value) }))} />
          </div>
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Tope km/día (validación odómetro)</label>
            <input type="number" className={inputCls("font-mono")} value={cfg.km_dia_max}
              onChange={e => setCfg(c => ({ ...c, km_dia_max: Number(e.target.value) }))} />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" checked={cfg.alertas_activas}
                onChange={e => setCfg(c => ({ ...c, alertas_activas: e.target.checked }))} />
              Alertas automáticas activas
            </label>
          </div>
        </div>
        <button onClick={guardarConfig} disabled={guardandoCfg}
          className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90" style={{ background: "#0b315f" }}>
          {guardandoCfg ? "Guardando…" : "Guardar configuración"}
        </button>
      </section>

      {/* MODAL EXPORT */}
      {exportOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={() => setExportOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl mt-10" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b flex items-center justify-between">
              <h3 className="font-bold text-gray-900">Exportar a Excel — selección de placas</h3>
              <button onClick={() => setExportOpen(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex flex-wrap gap-2">
                <input className={inputCls("flex-1 min-w-[180px]")} placeholder="Buscar placa o modelo…"
                  value={buscarSel} onChange={e => setBuscarSel(e.target.value)} />
                <select className="border rounded-xl px-3 py-2.5 text-sm" value={catSel} onChange={e => setCatSel(e.target.value)}>
                  <option value="todas">Todas las categorías</option>
                  {categorias.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <button onClick={selTodosFiltrados} className="px-3 py-1.5 rounded-lg border font-bold text-gray-700 hover:bg-gray-50">Todos los filtrados</button>
                <button onClick={selNinguno} className="px-3 py-1.5 rounded-lg border font-bold text-gray-700 hover:bg-gray-50">Ninguno</button>
                <button onClick={selInvertir} className="px-3 py-1.5 rounded-lg border font-bold text-gray-700 hover:bg-gray-50">Invertir</button>
                <span className="px-3 py-1.5 rounded-lg bg-gray-50 border text-gray-500">{sel.size} seleccionada(s)</span>
              </div>
              <div className="border rounded-xl max-h-72 overflow-y-auto divide-y">
                {propiosFiltrados.map(v => (
                  <label key={v.id} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                    <input type="checkbox" checked={sel.has(v.id)} onChange={() => toggleSel(v.id)} />
                    <span className="font-mono font-bold text-[#0b315f] w-24">{v.placa}</span>
                    <span className="text-gray-600 flex-1">{v.marca} {v.modelo}{v.categoria ? ` · ${v.categoria}` : ""}</span>
                    <span className="text-gray-400 font-mono text-xs">{fmtNum(v.kilometraje_actual)} km</span>
                  </label>
                ))}
                {propiosFiltrados.length === 0 && <p className="p-4 text-center text-gray-400 text-sm">Sin resultados</p>}
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="checkbox" checked={incluirTerceros} onChange={e => setIncluirTerceros(e.target.checked)} />
                Incluir vehículos de terceros ({terceros.length}) — se listan sin kilometraje
              </label>
            </div>
            <div className="px-6 py-4 border-t flex justify-end gap-3">
              <button onClick={() => setExportOpen(false)} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
              <button onClick={generarExcel} className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90" style={{ background: "#166534" }}>
                ⬇ Descargar Excel
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
