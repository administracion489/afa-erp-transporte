"use client";

import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { kmPorDia } from "@/lib/odometro";
import { abrirImprimible } from "@/lib/documentos-servicio";

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
type Enrol = {
  id?: string; vehiculo_id: number; plan_id?: string;
  km_base?: number | null; fecha_base?: string | null;
  intervalo_km_override?: number | null; intervalo_meses_override?: number | null;
  notas?: string | null;
  plan: Plan | null;
};
type Mant = { vehiculo_id: number; fecha: string; kilometraje: number; tipo: string };
type Lectura = { vehiculo_id: number; km: number; fecha: string };

type Config = {
  correos_alerta: string; umbral_km: number; umbral_dias: number;
  km_dia_max: number; alertas_activas: boolean;
  umbral_ot_km: number; umbral_ot_dias: number; ot_automatica_activa: boolean;
};

type Venc = {
  vehiculo: Vehiculo; plan: Plan; enrol: Enrol;
  interKm: number | null; interMeses: number | null;
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
function esc(s: any) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inputCls(extra = "") {
  return `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${extra}`;
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function ProgramaTab() {
  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([]);
  const [terceros, setTerceros]   = useState<Vehiculo[]>([]);
  const [enrol, setEnrol]         = useState<Enrol[]>([]);
  const [planes, setPlanes]       = useState<Plan[]>([]);
  const [mants, setMants]         = useState<Mant[]>([]);
  const [lecturas, setLecturas]   = useState<Lectura[]>([]);
  const [cfg, setCfg]             = useState<Config>({
    correos_alerta: "", umbral_km: 500, umbral_dias: 7, km_dia_max: 1500, alertas_activas: true,
    umbral_ot_km: 100, umbral_ot_dias: 2, ot_automatica_activa: true,
  });
  const [loading, setLoading]   = useState(true);
  const [guardandoCfg, setGuardandoCfg] = useState(false);

  // Export
  const [exportOpen, setExportOpen]       = useState(false);
  const [sel, setSel]                     = useState<Set<number>>(new Set());
  const [buscarSel, setBuscarSel]         = useState("");
  const [catSel, setCatSel]               = useState("todas");
  const [incluirTerceros, setIncluirTerceros] = useState(false);

  // Edición del programa de una unidad
  type EditDraft = {
    vehiculo: Vehiculo; enrolId: string | null; planId: string;
    kmActual: string; kmBase: string; fechaBase: string;
    interKm: string; interMeses: string; notas: string;
  };
  const [edit, setEdit] = useState<EditDraft | null>(null);
  const [guardandoEdit, setGuardandoEdit] = useState(false);

  const cargar = async () => {
    setLoading(true);
    const desde = addMeses(hoyLima(), -4);
    const [vRes, tRes, eRes, mRes, lRes, cRes, pRes] = await Promise.all([
      supabase.from("vehiculos").select("id,placa,categoria,marca,modelo,anio,color,nro_serie,kilometraje_actual").order("placa"),
      supabase.from("vehiculos_tercero").select("id,placa,categoria,marca,modelo").order("placa"),
      // `*` a propósito: los override por unidad son columnas nuevas (ver
      // supabase/mantenimiento-programa-editable.sql). Nombrarlas rompería la
      // consulta en una base donde ese SQL todavía no se corrió.
      supabase.from("vehiculos_plan").select("*,plan:planes_mantenimiento(id,marca,modelo,motor,intervalo_base_km,intervalo_base_meses)").eq("activo", true),
      supabase.from("mantenimiento").select("vehiculo_id,fecha,kilometraje,tipo").eq("tipo", "preventivo").order("fecha", { ascending: false }),
      supabase.from("lecturas_odometro").select("vehiculo_id,km,fecha").not("vehiculo_id", "is", null).eq("estado", "aceptada").gte("fecha", desde),
      supabase.from("config_mantenimiento").select("*").eq("id", 1).maybeSingle(),
      supabase.from("planes_mantenimiento").select("id,marca,modelo,motor,intervalo_base_km,intervalo_base_meses").order("marca"),
    ]);
    setVehiculos(vRes.data || []);
    setTerceros(tRes.data || []);
    setPlanes(pRes.data || []);
    setEnrol((eRes.data || []).map((e: any) => ({ ...e, plan: Array.isArray(e.plan) ? e.plan[0] : e.plan })));
    setMants(mRes.data || []);
    setLecturas(lRes.data || []);
    if (cRes.data) setCfg({
      correos_alerta: cRes.data.correos_alerta || "",
      umbral_km: cRes.data.umbral_km ?? 500,
      umbral_dias: cRes.data.umbral_dias ?? 7,
      km_dia_max: cRes.data.km_dia_max ?? 1500,
      alertas_activas: cRes.data.alertas_activas ?? true,
      umbral_ot_km: cRes.data.umbral_ot_km ?? 100,
      umbral_ot_dias: cRes.data.umbral_ot_dias ?? 2,
      ot_automatica_activa: cRes.data.ot_automatica_activa ?? true,
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
      // El intervalo por unidad (si se editó en el modal) manda sobre el del plan.
      const interKm    = e.intervalo_km_override    ?? plan.intervalo_base_km    ?? null;
      const interMeses = e.intervalo_meses_override ?? plan.intervalo_base_meses ?? null;

      let dueKm: number | null = null, faltanKm: number | null = null, diasPorKm: number | null = null;
      const inter = Number(interKm || 0);
      if (inter > 0) {
        const ultServ = um?.kilometraje ?? null;
        dueKm = ultServ !== null
          ? Number(ultServ) + inter
          : (Math.floor(kmActual / inter) + 1) * inter;
        faltanKm = dueKm - kmActual;
        diasPorKm = kmDia && kmDia > 0 && faltanKm > 0 ? Math.round(faltanKm / kmDia) : null;
      }
      let dueFecha: string | null = null, faltanDias: number | null = null;
      if (interMeses && baseFecha) {
        dueFecha = addMeses(baseFecha, Number(interMeses));
        faltanDias = diasHasta(dueFecha);
      }

      const vencido = (faltanKm !== null && faltanKm <= 0) || (faltanDias !== null && faltanDias <= 0);
      const proximoKm = faltanKm !== null && faltanKm <= cfg.umbral_km;
      const proximoFe = faltanDias !== null && faltanDias <= cfg.umbral_dias;
      const estado = vencido ? "vencido" : (proximoKm || proximoFe) ? "proximo" : "ok";
      const motivo = vencido ? "Vencido" : proximoKm && proximoFe ? "km y fecha" : proximoKm ? "km" : proximoFe ? "fecha" : "—";

      out.push({ vehiculo: v, plan, enrol: e, interKm, interMeses, kmActual, kmDia, dueKm, faltanKm, diasPorKm, dueFecha, faltanDias, estado, motivo });
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
    const campos: any = {
      correos_alerta: cfg.correos_alerta.trim() || null,
      umbral_km: Number(cfg.umbral_km) || 0,
      umbral_dias: Number(cfg.umbral_dias) || 0,
      km_dia_max: Number(cfg.km_dia_max) || 1500,
      alertas_activas: cfg.alertas_activas,
      umbral_ot_km: Number(cfg.umbral_ot_km) || 0,
      umbral_ot_dias: Number(cfg.umbral_ot_dias) || 0,
      ot_automatica_activa: cfg.ot_automatica_activa,
      updated_at: new Date().toISOString(),
    };
    let { error } = await supabase.from("config_mantenimiento").update(campos).eq("id", 1);
    let faltanColumnas = false;
    if (error && (error.code === "PGRST204" || /column .* does not exist|Could not find the/i.test(error.message || ""))) {
      faltanColumnas = true;
      const { umbral_ot_km, umbral_ot_dias, ot_automatica_activa, ...resto } = campos;
      ({ error } = await supabase.from("config_mantenimiento").update(resto).eq("id", 1));
    }
    setGuardandoCfg(false);
    if (error) alert("Error al guardar: " + error.message);
    else alert(faltanColumnas
      ? "Guardado ✓ — pero la OT automática NO se guardó: falta correr supabase/mantenimiento-ot-automatica.sql"
      : "Configuración guardada ✓");
  };

  // ── Edición del programa por unidad ───────────────────────────────────────────

  const sinPlan = useMemo(() => {
    const conPlan = new Set(enrol.map(e => e.vehiculo_id));
    return vehiculos.filter(v => !conPlan.has(v.id));
  }, [vehiculos, enrol]);

  const abrirEdit = (v: Vehiculo) => {
    const e = enrol.find(x => x.vehiculo_id === v.id);
    setEdit({
      vehiculo: v,
      enrolId: e?.id ?? null,
      planId: e?.plan_id ?? e?.plan?.id ?? "",
      kmActual: String(v.kilometraje_actual ?? ""),
      kmBase: e?.km_base != null ? String(e.km_base) : "",
      fechaBase: e?.fecha_base ?? "",
      interKm: e?.intervalo_km_override != null ? String(e.intervalo_km_override) : "",
      interMeses: e?.intervalo_meses_override != null ? String(e.intervalo_meses_override) : "",
      notas: e?.notas ?? "",
    });
  };

  const numOrNull = (s: string) => (s.trim() === "" ? null : Number(s));

  const guardarEdit = async () => {
    if (!edit) return;
    if (!edit.planId) { alert("Elige un plan para esta unidad"); return; }
    setGuardandoEdit(true);
    try {
      // 1) Km actual del vehículo (vive en `vehiculos`, no en el enrolamiento)
      const kmAct = numOrNull(edit.kmActual);
      if (kmAct !== (edit.vehiculo.kilometraje_actual ?? null)) {
        const { error } = await supabase.from("vehiculos").update({ kilometraje_actual: kmAct }).eq("id", edit.vehiculo.id);
        if (error) throw error;
      }

      // 2) Enrolamiento. Cambiar de plan = desactivar los otros y activar/crear el elegido.
      const campos: any = {
        km_base: numOrNull(edit.kmBase),
        fecha_base: edit.fechaBase || null,
        intervalo_km_override: numOrNull(edit.interKm),
        intervalo_meses_override: numOrNull(edit.interMeses),
        notas: edit.notas.trim() || null,
        activo: true,
      };
      // Si el SQL de override todavía no se corrió, PostgREST rechaza esas columnas:
      // se reintenta sin ellas para que la edición del resto no se pierda.
      const sinOverride = (o: any) => { const { intervalo_km_override, intervalo_meses_override, notas, ...r } = o; return r; };
      const esColumnaFaltante = (err: any) => err?.code === "PGRST204" || err?.code === "42703" || /column .* does not exist|Could not find the/i.test(err?.message || "");

      await supabase.from("vehiculos_plan")
        .update({ activo: false }).eq("vehiculo_id", edit.vehiculo.id).neq("plan_id", edit.planId);

      const { data: existente } = await supabase.from("vehiculos_plan")
        .select("id").eq("vehiculo_id", edit.vehiculo.id).eq("plan_id", edit.planId).maybeSingle();

      let faltanColumnas = false;
      const ejecutar = async (payload: any) =>
        existente
          ? supabase.from("vehiculos_plan").update(payload).eq("id", existente.id)
          : supabase.from("vehiculos_plan").insert({ ...payload, vehiculo_id: edit.vehiculo.id, plan_id: edit.planId });

      let { error } = await ejecutar(campos);
      if (error && esColumnaFaltante(error)) {
        faltanColumnas = true;
        ({ error } = await ejecutar(sinOverride(campos)));
      }
      if (error) throw error;

      setEdit(null);
      await cargar();
      alert(faltanColumnas
        ? "Guardado ✓ — pero los intervalos por unidad NO se guardaron: falta correr supabase/mantenimiento-programa-editable.sql"
        : "Programa actualizado ✓");
    } catch (e: any) {
      alert("Error al guardar: " + e.message);
    } finally {
      setGuardandoEdit(false);
    }
  };

  const quitarDelPlan = async () => {
    if (!edit || !edit.enrolId) return;
    if (!confirm(`¿Quitar a ${edit.vehiculo.placa} de su plan? Dejará de aparecer en el programa.`)) return;
    setGuardandoEdit(true);
    const { error } = await supabase.from("vehiculos_plan").update({ activo: false }).eq("id", edit.enrolId);
    setGuardandoEdit(false);
    if (error) { alert("Error: " + error.message); return; }
    setEdit(null);
    await cargar();
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

  // ── Export PDF (imprimible A4 apaisado → "Guardar como PDF") ──────────────────
  // Mismo criterio que el Excel: las placas seleccionadas en el modal.

  const generarPDF = () => {
    const sel100 = vehiculos.filter(v => sel.has(v.id));
    if (sel100.length === 0) { alert("Selecciona al menos un vehículo"); return; }

    const vencMap = new Map(vencimientos.map(x => [x.vehiculo.id, x]));
    const ultMant: Record<number, Mant> = {};
    for (const m of mants) if (!ultMant[m.vehiculo_id]) ultMant[m.vehiculo_id] = m;

    const filas = sel100.map(v => {
      const x = vencMap.get(v.id);
      const um = ultMant[v.id];
      const est = x ? (x.estado === "vencido" ? "VENCIDO" : x.estado === "proximo" ? "PRÓXIMO" : "OK") : "SIN PLAN";
      const clase = est === "VENCIDO" ? "e-ven" : est === "PRÓXIMO" ? "e-pro" : est === "OK" ? "e-ok" : "e-sp";
      return `<tr>
  <td class="mono b">${esc(v.placa)}</td>
  <td>${esc(descripcionVeh(v))}</td>
  <td>${x ? esc(`${x.plan.marca} ${x.plan.modelo}${x.plan.motor ? " " + x.plan.motor : ""}`) : "Sin plan"}</td>
  <td class="mono r">${fmtNum(v.kilometraje_actual)}</td>
  <td class="mono r">${um ? fmtNum(um.kilometraje) : "—"}</td>
  <td class="r">${um ? fmtFecha(um.fecha) : "—"}</td>
  <td class="mono r">${fmtNum(x?.dueKm)}</td>
  <td class="mono r">${x?.faltanKm == null ? "—" : x.faltanKm <= 0 ? "Vencido" : fmtNum(x.faltanKm)}</td>
  <td class="r">${fmtFecha(x?.dueFecha)}</td>
  <td class="r">${x?.faltanDias == null ? "—" : x.faltanDias <= 0 ? "Vencido" : `${x.faltanDias} d`}</td>
  <td><span class="chip ${clase}">${est}</span></td>
</tr>`;
    }).join("");

    const css = `@page{size:A4 landscape;margin:12mm 10mm}
*{box-sizing:border-box}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:10px;color:#1e293b;margin:0;background:#fff}
.hd{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #0b315f;padding-bottom:8px;margin-bottom:4px}
.hd h1{font-size:15px;margin:0;color:#0b315f;text-transform:uppercase;letter-spacing:1px}
.hd p{margin:2px 0 0;font-size:9px;color:#64748b}
.kpis{display:flex;gap:8px;margin:10px 0}
.kpi{border:1px solid #e2e8f0;border-radius:6px;padding:6px 12px;min-width:90px}
.kpi span{display:block;font-size:8px;text-transform:uppercase;letter-spacing:.6px;color:#94a3b8;font-weight:700}
.kpi b{font-size:16px}
table{width:100%;border-collapse:collapse;font-size:9.5px}
thead tr{background:#f1f5f9}
th{padding:6px 5px;text-align:left;font-size:8px;color:#475569;font-weight:800;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid #cbd5e1}
td{padding:5px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
tbody tr:nth-child(even){background:#f8fafc}
.mono{font-family:'Consolas',monospace}
.b{font-weight:800;color:#0b315f}
.r{text-align:right}
.chip{display:inline-block;padding:1.5px 6px;border-radius:5px;font-weight:800;font-size:8px}
.e-ven{background:#fee2e2;color:#991b1b}.e-pro{background:#fef9c3;color:#854d0e}
.e-ok{background:#dcfce7;color:#166534}.e-sp{background:#f3f4f6;color:#4b5563}
.ft{margin-top:14px;border-top:1px solid #e2e8f0;padding-top:8px;text-align:center;font-size:8px;color:#94a3b8}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}thead{display:table-header-group}}`;

    const body = `<div class="hd">
  <div><h1>Programa de Mantenimiento Preventivo</h1>
  <p>AFA Tours Peru SAC · Próximo servicio por km y por tiempo (lo que ocurra primero)</p></div>
  <div style="text-align:right;font-size:9px;color:#64748b">
    Emitido: <b>${fmtFecha(hoyLima())}</b><br/>Unidades: <b>${sel100.length}</b>
  </div>
</div>
<div class="kpis">
  <div class="kpi"><span>Vencidos</span><b style="color:#991b1b">${nVencidos}</b></div>
  <div class="kpi"><span>Próximos</span><b style="color:#854d0e">${nProximos}</b></div>
  <div class="kpi"><span>Con plan</span><b style="color:#166534">${enrol.length}</b></div>
  <div class="kpi"><span>Sin plan</span><b style="color:#4b5563">${nSinPlan}</b></div>
</div>
<table><thead><tr>
  <th>Placa</th><th>Descripción</th><th>Plan</th><th class="r">Odóm. actual</th>
  <th class="r">Últ. mnto (km)</th><th class="r">Últ. mnto (fecha)</th>
  <th class="r">Próximo km</th><th class="r">Faltan km</th>
  <th class="r">Próxima fecha</th><th class="r">Faltan días</th><th>Estado</th>
</tr></thead><tbody>${filas}</tbody></table>
<p class="ft">Umbrales de aviso: ≤ ${cfg.umbral_km} km / ≤ ${cfg.umbral_dias} días · Generado por el ERP AFA Transportes</p>`;

    abrirImprimible(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
<title>Programa de Mantenimiento AFA — ${hoyLima()}</title><style>${css}</style></head>
<body>${body}<script>window.onload=()=>window.print()<\/script></body></html>`);
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
        <div className="flex gap-2">
          <button onClick={abrirExport}
            className="px-5 py-2.5 rounded-xl font-bold text-sm text-white transition-all hover:opacity-90"
            style={{ background: "#166534" }}>
            ⬇ Exportar Excel
          </button>
          <button onClick={abrirExport}
            className="px-5 py-2.5 rounded-xl font-bold text-sm text-white transition-all hover:opacity-90"
            style={{ background: "#991b1b" }}>
            🖨 Exportar PDF
          </button>
        </div>
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
                {["Placa", "Modelo / Plan", "Km actual", "Próximo km", "Faltan km", "Próxima fecha", "Faltan días", "Estado", ""].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="p-10 text-center text-gray-400">Cargando…</td></tr>
              ) : vencimientos.length === 0 ? (
                <tr><td colSpan={9} className="p-10 text-center text-gray-400">
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
                      {x.enrol.intervalo_km_override || x.enrol.intervalo_meses_override ? (
                        <span className="ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: "#e0e7ff", color: "#3730a3" }}>
                          ajustado
                        </span>
                      ) : null}
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
                    <td className="p-3 text-right">
                      <button onClick={() => abrirEdit(x.vehiculo)}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-bold border text-gray-700 hover:bg-gray-50">
                        ✎ Editar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* SIN PLAN */}
      {!loading && sinPlan.length > 0 && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b flex items-center justify-between">
            <h2 className="font-bold text-gray-800 text-sm">Unidades sin plan</h2>
            <span className="text-xs text-gray-400">{sinPlan.length} sin programa</span>
          </div>
          <div className="divide-y">
            {sinPlan.map(v => (
              <div key={v.id} className="flex items-center gap-3 px-5 py-2.5 text-sm hover:bg-gray-50">
                <span className="font-mono font-black text-[#0b315f] text-xs w-24">{v.placa}</span>
                <span className="text-gray-600 flex-1 text-xs">{v.marca} {v.modelo}{v.categoria ? ` · ${v.categoria}` : ""}</span>
                <span className="text-gray-400 font-mono text-xs">{fmtNum(v.kilometraje_actual)} km</span>
                <button onClick={() => abrirEdit(v)}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-white hover:opacity-90" style={{ background: "#0b315f" }}>
                  + Asignar plan
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

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

        <div className="rounded-xl border bg-gray-50 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-lg">🔧</span>
            <div>
              <p className="text-sm font-bold text-gray-800">OT automática</p>
              <p className="text-[11px] text-gray-500">
                Umbral aparte, más ajustado que el aviso de arriba: al entrar en este rango se abre sola una
                orden de trabajo (checklist tomado del plan del fabricante) y ese vehículo deja de mandar
                correo — sigue viéndose Próximo/Vencido en esta tabla, y NO se le quita la unidad de Programación.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Crear OT cuando falten ≤ (km)</label>
              <input type="number" className={inputCls("font-mono bg-white")} value={cfg.umbral_ot_km}
                onChange={e => setCfg(c => ({ ...c, umbral_ot_km: Number(e.target.value) }))} />
            </div>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Crear OT cuando falten ≤ (días)</label>
              <input type="number" className={inputCls("font-mono bg-white")} value={cfg.umbral_ot_dias}
                onChange={e => setCfg(c => ({ ...c, umbral_ot_dias: Number(e.target.value) }))} />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input type="checkbox" checked={cfg.ot_automatica_activa}
                  onChange={e => setCfg(c => ({ ...c, ot_automatica_activa: e.target.checked }))} />
                OT automática activa
              </label>
            </div>
          </div>
        </div>

        <button onClick={guardarConfig} disabled={guardandoCfg}
          className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90" style={{ background: "#0b315f" }}>
          {guardandoCfg ? "Guardando…" : "Guardar configuración"}
        </button>
      </section>

      {/* MODAL EDITAR PROGRAMA DE LA UNIDAD */}
      {edit && (() => {
        const planSel = planes.find(p => p.id === edit.planId);
        const setE = (patch: Partial<typeof edit>) => setEdit(d => d ? { ...d, ...patch } : d);
        return (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={() => setEdit(null)}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl mt-10" onClick={e => e.stopPropagation()}>
              <div className="px-6 py-4 border-b flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-gray-900">Programa de {edit.vehiculo.placa}</h3>
                  <p className="text-xs text-gray-400">{[edit.vehiculo.marca, edit.vehiculo.modelo, edit.vehiculo.anio].filter(Boolean).join(" ")}</p>
                </div>
                <button onClick={() => setEdit(null)} className="text-gray-400 hover:text-gray-600">✕</button>
              </div>
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Plan del fabricante *</label>
                  <select className={inputCls()} value={edit.planId} onChange={e => setE({ planId: e.target.value })}>
                    <option value="">— Elegir plan —</option>
                    {planes.map(p => (
                      <option key={p.id} value={p.id}>
                        {p.marca} {p.modelo}{p.motor ? ` · ${p.motor}` : ""}
                        {p.intervalo_base_km ? ` — cada ${p.intervalo_base_km.toLocaleString("es-PE")} km` : ""}
                        {p.intervalo_base_meses ? ` / ${p.intervalo_base_meses} m` : ""}
                      </option>
                    ))}
                  </select>
                  {planes.length === 0 && (
                    <p className="text-xs text-amber-700 mt-1">No hay planes cargados. Crea uno en <b>Planes Fabricante</b>.</p>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Odómetro actual (km)</label>
                    <input type="number" className={inputCls("font-mono")} value={edit.kmActual}
                      onChange={e => setE({ kmActual: e.target.value })} />
                    <p className="text-[10px] text-gray-400 mt-1">Se guarda en la ficha del vehículo.</p>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Km del último servicio</label>
                    <input type="number" className={inputCls("font-mono")} value={edit.kmBase}
                      onChange={e => setE({ kmBase: e.target.value })} />
                    <p className="text-[10px] text-gray-400 mt-1">Ancla de cálculo si no hay servicio registrado.</p>
                  </div>
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Fecha del último servicio</label>
                    <input type="date" className={inputCls()} value={edit.fechaBase}
                      onChange={e => setE({ fechaBase: e.target.value })} />
                  </div>
                </div>

                <div className="rounded-xl border bg-gray-50 p-4 space-y-3">
                  <p className="text-[11px] font-bold uppercase tracking-widest text-gray-500">Intervalo solo para esta unidad</p>
                  <p className="text-[11px] text-gray-500 -mt-2">
                    Vacío = usa el plan
                    {planSel ? ` (${planSel.intervalo_base_km ? planSel.intervalo_base_km.toLocaleString("es-PE") + " km" : "sin km"}${planSel.intervalo_base_meses ? " / " + planSel.intervalo_base_meses + " meses" : ""})` : ""}.
                    Cambiarlo aquí NO afecta a las demás unidades del modelo.
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Servicio cada (km)</label>
                      <input type="number" className={inputCls("font-mono bg-white")} placeholder={planSel?.intervalo_base_km ? String(planSel.intervalo_base_km) : "—"}
                        value={edit.interKm} onChange={e => setE({ interKm: e.target.value })} />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Servicio cada (meses)</label>
                      <input type="number" className={inputCls("font-mono bg-white")} placeholder={planSel?.intervalo_base_meses ? String(planSel.intervalo_base_meses) : "—"}
                        value={edit.interMeses} onChange={e => setE({ interMeses: e.target.value })} />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Notas</label>
                  <textarea className={inputCls()} rows={2} value={edit.notas} onChange={e => setE({ notas: e.target.value })}
                    placeholder="Ej. unidad de ruta larga, se adelanta el cambio de aceite" />
                </div>
              </div>
              <div className="px-6 py-4 border-t flex justify-between items-center">
                {edit.enrolId ? (
                  <button onClick={quitarDelPlan} disabled={guardandoEdit}
                    className="px-4 py-2.5 rounded-xl font-bold text-xs text-red-600 border border-red-100 hover:bg-red-50 disabled:opacity-60">
                    Quitar del plan
                  </button>
                ) : <span />}
                <div className="flex gap-3">
                  <button onClick={() => setEdit(null)} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
                  <button onClick={guardarEdit} disabled={guardandoEdit}
                    className="px-5 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90" style={{ background: "#0b315f" }}>
                    {guardandoEdit ? "Guardando…" : "Guardar cambios"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* MODAL EXPORT */}
      {exportOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={() => setExportOpen(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl mt-10" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b flex items-center justify-between">
              <h3 className="font-bold text-gray-900">Exportar programa — selección de placas</h3>
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
              <button onClick={generarPDF} className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90" style={{ background: "#991b1b" }}>
                🖨 Descargar PDF
              </button>
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
