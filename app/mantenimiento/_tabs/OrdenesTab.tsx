"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { abrirImprimible } from "@/lib/documentos-servicio";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Vehiculo = {
  id: number; placa: string; categoria: string | null;
  kilometraje_actual: number | null; nro_serie?: string | null;
};

type PlanFabricante = {
  id: string; marca: string; modelo: string; motor: string | null;
  intervalo_base_km: number | null; intervalo_base_meses: number | null;
};

type Plantilla = {
  id: number; vehiculo_id: number | null; nombre: string;
  tipo: string; km_intervalo: number | null; meses_intervalo: number | null;
  descripcion: string | null; activo: boolean;
};

type ChecklistItem = {
  id: number; plantilla_id: number; orden: number;
  categoria: string | null; item: string; obligatorio: boolean;
};

type OrdenTrabajo = {
  id: number; vehiculo_id: number | null; plantilla_id: number | null;
  km_apertura: number | null; fecha_apertura: string;
  fecha_cierre: string | null; mecanico: string | null;
  taller: string | null; costo_total: number; estado: string;
  observaciones: string | null; created_at: string;
  origen?: string | null; // 'manual' | 'automatica' — la crea el cron de alertas al llegar al umbral_ot
  plan_mantenimiento_id?: string | null;
  km_cierre?: number | null;
  fecha_limite_sugerida?: string | null; // solo OT automáticas
};

type ChecklistOT = {
  id: number; orden_trabajo_id: number; item: string;
  categoria: string | null; completado: boolean; observacion: string | null;
  accion_plan?: string | null;  // C/I/R — snapshot del plan al crear el ítem, no se edita
  accion_final?: string | null; // editable: qué pasó realmente
  foto_url?: string | null;
  repuesto?: string | null;
};

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

type Vista = "ordenes" | "plantillas";

const ESTADO_OT: Record<string, { label: string; bg: string; color: string }> = {
  abierta:   { label: "Abierta",    bg: "#dbeafe", color: "#1d4ed8" },
  en_proceso:{ label: "En proceso", bg: "#fef9c3", color: "#854d0e" },
  cerrada:   { label: "Cerrada",    bg: "#dcfce7", color: "#166534" },
  cancelada: { label: "Cancelada",  bg: "#fee2e2", color: "#991b1b" },
};

const CATEGORIAS_CHECKLIST = [
  "Motor", "Frenos", "Fluidos", "Neumáticos", "Eléctrico",
  "Carrocería", "Transmisión", "Suspensión", "Seguridad", "Otros",
];

// Categorías con impacto directo en seguridad — se resaltan aparte en la tarjeta de OT.
const CATEGORIAS_SEGURIDAD = new Set(["Frenos", "Suspensión", "Seguridad"]);

// Convención del plan del fabricante (ver PROMPT_PLAN en lib/vision-ia.ts).
const ACCION_CFG: Record<string, { label: string; bg: string; color: string }> = {
  C: { label: "Cambio",        bg: "#fee2e2", color: "#991b1b" },
  I: { label: "Inspección",    bg: "#dbeafe", color: "#1d4ed8" },
  R: { label: "Cada servicio", bg: "#f3f4f6", color: "#4b5563" },
};

// Checklist base según rutina
const CHECKLIST_BASE: Record<string, { categoria: string; item: string }[]> = {
  "R1 - Básico": [
    { categoria: "Motor",   item: "Verificar nivel de aceite de motor" },
    { categoria: "Motor",   item: "Cambiar aceite de motor" },
    { categoria: "Fluidos", item: "Verificar nivel de agua del radiador" },
    { categoria: "Fluidos", item: "Verificar nivel de líquido de frenos" },
    { categoria: "Seguridad", item: "Inspección visual de luces delanteras y traseras" },
    { categoria: "Seguridad", item: "Verificar bocina" },
    { categoria: "Neumáticos", item: "Verificar presión de neumáticos" },
  ],
  "R2 - Intermedio": [
    { categoria: "Motor",        item: "Cambiar filtro de aceite" },
    { categoria: "Motor",        item: "Cambiar filtro de aire" },
    { categoria: "Motor",        item: "Cambiar filtro de cabina" },
    { categoria: "Neumáticos",   item: "Rotación de neumáticos" },
    { categoria: "Neumáticos",   item: "Alineamiento y balanceo" },
    { categoria: "Frenos",       item: "Inspección de pastillas de freno" },
    { categoria: "Frenos",       item: "Inspección de discos de freno" },
    { categoria: "Fluidos",      item: "Cambiar líquido de frenos" },
  ],
  "R3 - Mayor": [
    { categoria: "Transmisión",  item: "Cambiar aceite de transmisión" },
    { categoria: "Transmisión",  item: "Cambiar aceite de diferencial" },
    { categoria: "Frenos",       item: "Cambiar pastillas de freno" },
    { categoria: "Suspensión",   item: "Inspección de amortiguadores" },
    { categoria: "Suspensión",   item: "Inspección de rótulas y terminales" },
    { categoria: "Eléctrico",    item: "Verificar batería y alternador" },
    { categoria: "Motor",        item: "Inspección de correas" },
  ],
  "R4 - Overhaul": [
    { categoria: "Motor",        item: "Cambiar kit de distribución" },
    { categoria: "Motor",        item: "Cambiar fajas" },
    { categoria: "Fluidos",      item: "Cambiar refrigerante" },
    { categoria: "Motor",        item: "Revisión de inyectores" },
    { categoria: "Motor",        item: "Inspección de culata" },
    { categoria: "Transmisión",  item: "Revisión completa de transmisión" },
    { categoria: "Frenos",       item: "Cambio completo de sistema de frenos" },
  ],
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

function esc(s: any) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtSoles(n: number) {
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function diasAbierta(fechaApertura: string): number {
  return Math.floor((Date.now() - new Date(fechaApertura + "T00:00:00").getTime()) / 86400000);
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function OrdenesTab() {
  const [vista, setVista]           = useState<Vista>("ordenes");
  const [vehiculos,   setVehiculos] = useState<Vehiculo[]>([]);
  const [plantillas,  setPlantillas]= useState<Plantilla[]>([]);
  const [checklistPl, setChecklistPl] = useState<ChecklistItem[]>([]);
  const [ordenes,     setOrdenes]   = useState<OrdenTrabajo[]>([]);
  const [checklistOT, setChecklistOT] = useState<ChecklistOT[]>([]);
  const [planesFab,   setPlanesFab] = useState<PlanFabricante[]>([]);
  const [loading,     setLoading]   = useState(false);
  const [guardando,   setGuardando] = useState(false);

  // Forms
  const [mostrarFormOT,  setMostrarFormOT]  = useState(false);
  const [mostrarFormPl,  setMostrarFormPl]  = useState(false);
  const [otActiva,       setOtActiva]       = useState<number | null>(null); // OT con checklist abierto
  const [editandoOtId,   setEditandoOtId]   = useState<number | null>(null);
  const [editandoPlId,   setEditandoPlId]   = useState<number | null>(null);
  const [catColapsada,   setCatColapsada]   = useState<Set<string>>(new Set()); // claves "otId:categoria"
  const [cerrarOT,        setCerrarOT]        = useState<{ ot: OrdenTrabajo; km: string } | null>(null);
  const [subiendoFotoId,  setSubiendoFotoId]  = useState<number | null>(null);

  // Form OT
  const FORM_OT_VACIO = { vehiculo_id: "", plantilla_id: "", km_apertura: "", fecha_apertura: new Date().toISOString().split("T")[0], mecanico: "", taller: "", costo_total: "", estado: "abierta", observaciones: "" };
  const [formOT, setFormOT] = useState(FORM_OT_VACIO);

  // Form Plantilla
  const FORM_PL_VACIO = { vehiculo_id: "", nombre: "", tipo: "preventivo", km_intervalo: "", meses_intervalo: "", descripcion: "" };
  const [formPl, setFormPl] = useState(FORM_PL_VACIO);
  const [itemsPl, setItemsPl] = useState<{ categoria: string; item: string; obligatorio: boolean }[]>([]);

  const fot = (k: keyof typeof FORM_OT_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setFormOT(p => ({ ...p, [k]: e.target.value }));

  const fpl = (k: keyof typeof FORM_PL_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setFormPl(p => ({ ...p, [k]: e.target.value }));

  // ── Carga ──────────────────────────────────────────────────────────────────

  const cargarDatos = async () => {
    setLoading(true);
    const [vRes, plRes, chPlRes, otRes, chOtRes, pfRes] = await Promise.all([
      supabase.from("vehiculos").select("id,placa,categoria,kilometraje_actual,nro_serie").order("placa"),
      supabase.from("plantillas_mantenimiento").select("*").order("nombre"),
      supabase.from("checklist_plantilla").select("*").order("orden"),
      supabase.from("ordenes_trabajo").select("*").order("created_at", { ascending: false }),
      supabase.from("checklist_ot").select("*"),
      supabase.from("planes_mantenimiento").select("id,marca,modelo,motor,intervalo_base_km,intervalo_base_meses"),
    ]);
    setVehiculos(vRes.data    || []);
    setPlantillas(plRes.data  || []);
    setChecklistPl(chPlRes.data || []);
    setOrdenes(otRes.data     || []);
    setChecklistOT(chOtRes.data || []);
    setPlanesFab(pfRes.data   || []);
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  // ── Plantilla: cargar checklist base ──────────────────────────────────────

  const cargarChecklistBase = (nombrePlantilla: string) => {
    const base = CHECKLIST_BASE[nombrePlantilla] || [];
    setItemsPl(base.map(i => ({ ...i, obligatorio: true })));
  };

  // ── CRUD Plantillas ───────────────────────────────────────────────────────

  const guardarPlantilla = async () => {
    if (!formPl.nombre.trim()) { alert("El nombre es obligatorio"); return; }
    setGuardando(true);
    const payload = {
      vehiculo_id:     formPl.vehiculo_id ? Number(formPl.vehiculo_id) : null,
      nombre:          formPl.nombre.trim(),
      tipo:            formPl.tipo,
      km_intervalo:    formPl.km_intervalo    ? Number(formPl.km_intervalo)    : null,
      meses_intervalo: formPl.meses_intervalo ? Number(formPl.meses_intervalo) : null,
      descripcion:     formPl.descripcion.trim() || null,
      activo:          true,
    };
    let plId = editandoPlId;
    if (editandoPlId) {
      await supabase.from("plantillas_mantenimiento").update(payload).eq("id", editandoPlId);
      await supabase.from("checklist_plantilla").delete().eq("plantilla_id", editandoPlId);
    } else {
      const { data } = await supabase.from("plantillas_mantenimiento").insert(payload).select().single();
      plId = data?.id || null;
    }
    // Insertar items
    if (plId && itemsPl.length > 0) {
      await supabase.from("checklist_plantilla").insert(
        itemsPl.map((it, i) => ({ plantilla_id: plId, orden: i + 1, categoria: it.categoria, item: it.item, obligatorio: it.obligatorio }))
      );
    }
    setFormPl(FORM_PL_VACIO); setItemsPl([]); setEditandoPlId(null); setMostrarFormPl(false);
    cargarDatos(); setGuardando(false);
  };

  const eliminarPlantilla = async (id: number) => {
    if (!confirm("¿Eliminar esta plantilla?")) return;
    await supabase.from("plantillas_mantenimiento").delete().eq("id", id);
    cargarDatos();
  };

  // ── CRUD Órdenes de Trabajo ───────────────────────────────────────────────

  const guardarOT = async () => {
    if (!formOT.vehiculo_id) { alert("Selecciona un vehículo"); return; }
    setGuardando(true);

    const payload = {
      vehiculo_id:    Number(formOT.vehiculo_id),
      plantilla_id:   formOT.plantilla_id ? Number(formOT.plantilla_id) : null,
      km_apertura:    formOT.km_apertura  ? Number(formOT.km_apertura)  : null,
      fecha_apertura: formOT.fecha_apertura,
      mecanico:       formOT.mecanico.trim()     || null,
      taller:         formOT.taller.trim()       || null,
      costo_total:    formOT.costo_total ? Number(formOT.costo_total) : 0,
      estado:         formOT.estado,
      observaciones:  formOT.observaciones.trim() || null,
    };

    let otId = editandoOtId;

    if (editandoOtId) {
      await supabase.from("ordenes_trabajo").update(payload).eq("id", editandoOtId);
    } else {
      const { data } = await supabase.from("ordenes_trabajo").insert(payload).select().single();
      otId = data?.id || null;

      // Auto-poblar checklist desde plantilla
      if (otId && formOT.plantilla_id) {
        const items = checklistPl.filter(c => c.plantilla_id === Number(formOT.plantilla_id));
        if (items.length > 0) {
          await supabase.from("checklist_ot").insert(
            items.map(it => ({ orden_trabajo_id: otId, item: it.item, categoria: it.categoria, completado: false }))
          );
        }
      }
    }

    setFormOT(FORM_OT_VACIO); setEditandoOtId(null); setMostrarFormOT(false);
    cargarDatos(); setGuardando(false);

    // Abrir checklist de la OT recién creada
    if (otId && !editandoOtId) setOtActiva(otId);
  };

  // Cerrar pide el km real aparte (abre el modal); los demás estados se aplican directo.
  const cambiarEstadoOT = async (ot: OrdenTrabajo, estado: string) => {
    if (estado === "cerrada") {
      const veh = vehiculos.find(v => v.id === ot.vehiculo_id);
      setCerrarOT({ ot, km: String(veh?.kilometraje_actual ?? ot.km_apertura ?? "") });
      return;
    }
    await supabase.from("ordenes_trabajo").update({ estado }).eq("id", ot.id);
    setOrdenes(prev => prev.map(o => o.id === ot.id ? { ...o, estado } : o));
  };

  // Cerrar una OT re-ancla "próximo mantenimiento": sin escribir en `mantenimiento`,
  // el cron seguiría viendo el mismo hito vencido mañana y crearía otra OT automática
  // para exactamente lo mismo. `mantenimiento` es la tabla que usan ProgramaTab y el
  // cron como "último servicio conocido" — no es exclusiva de las OT automáticas.
  const confirmarCierre = async () => {
    if (!cerrarOT) return;
    const km = Number(cerrarOT.km);
    if (!km || km <= 0) { alert("Ingresa el kilometraje real de cierre"); return; }
    setGuardando(true);
    const { ot } = cerrarOT;
    const hoy = new Date().toISOString().split("T")[0];

    const { error } = await supabase.from("ordenes_trabajo")
      .update({ estado: "cerrada", fecha_cierre: hoy, km_cierre: km }).eq("id", ot.id);
    if (error) { alert("Error al cerrar: " + error.message); setGuardando(false); return; }

    const veh = vehiculos.find(v => v.id === ot.vehiculo_id);
    const { error: eMant } = await supabase.from("mantenimiento").insert({
      vehiculo_id: ot.vehiculo_id, fecha: hoy, tipo: "preventivo", kilometraje: km,
      descripcion: `OT #${ot.id}${veh ? " — " + veh.placa : ""}`,
      proveedor: ot.taller || null, costo: Number(ot.costo_total || 0), estado: "finalizado",
      proximo_km: 0, observaciones: ot.observaciones || null,
    });
    if (eMant) {
      // La OT sí quedó cerrada; que falle el ancla no debe bloquear al usuario, pero
      // sí avisarle — si no, el "próximo mantenimiento" queda desfasado en silencio.
      alert("La OT se cerró, pero no se pudo actualizar el historial de mantenimiento: " + eMant.message);
    }

    setCerrarOT(null);
    setGuardando(false);
    cargarDatos();
  };

  const eliminarOT = async (id: number) => {
    if (!confirm("¿Eliminar esta orden de trabajo?")) return;
    await supabase.from("ordenes_trabajo").delete().eq("id", id);
    if (otActiva === id) setOtActiva(null);
    cargarDatos();
  };

  // ── Descargar OT en PDF (para entregar al conductor/taller) ──────────────────

  const generarPdfOT = (ot: OrdenTrabajo) => {
    const veh = vehiculos.find(v => v.id === ot.vehiculo_id);
    const pl = plantillas.find(p => p.id === ot.plantilla_id);
    const plan = ot.plan_mantenimiento_id ? planesFab.find(p => p.id === ot.plan_mantenimiento_id) : null;
    const items = checklistOT.filter(c => c.orden_trabajo_id === ot.id);
    const grupos = [
      ...CATEGORIAS_CHECKLIST.filter(cat => items.some(i => i.categoria === cat)),
      ...(items.some(i => !i.categoria || !CATEGORIAS_CHECKLIST.includes(i.categoria)) ? ["Otros ítems"] : []),
    ];
    const itemsDe = (cat: string) => cat === "Otros ítems"
      ? items.filter(i => !i.categoria || !CATEGORIAS_CHECKLIST.includes(i.categoria))
      : items.filter(i => i.categoria === cat);

    const filasGrupo = grupos.map(cat => `
      <div class="grupo">
        <p class="cat">${esc(cat)}</p>
        ${itemsDe(cat).map(it => {
          const acc = it.accion_final && ACCION_CFG[it.accion_final] ? ACCION_CFG[it.accion_final].label : null;
          return `
          <div class="item">
            <span class="box">${it.completado ? "☑" : "☐"}</span>
            <div class="item-txt">
              <p class="${it.completado ? "tachado" : ""}">${acc ? `<span class="acc">[${esc(acc)}]</span> ` : ""}${esc(it.item)}</p>
              <p class="obs ${it.observacion ? "" : "linea"}">Obs: ${it.observacion ? esc(it.observacion) : "____________________________"}</p>
              <p class="obs ${it.repuesto ? "" : "linea"}">Repuesto: ${it.repuesto ? esc(it.repuesto) : "________________"} &nbsp;&nbsp; Costo: S/ __________</p>
            </div>
          </div>`;
        }).join("")}
      </div>`).join("");

    const css = `@page{size:A4;margin:14mm 12mm}*{box-sizing:border-box}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#1e293b;margin:0;background:#fff}
.hd{display:flex;justify-content:space-between;align-items:center;border:1.5px solid #cbd5e1;border-left:5px solid #0b315f;padding:12px 18px;border-radius:6px;margin-bottom:14px;background:#f8faff}
.hd h1{font-size:16px;margin:0;color:#0b315f}
.hd p{margin:3px 0 0;font-size:10px;color:#64748b}
.hd-right{text-align:right}
.chip{display:inline-block;padding:2px 8px;border-radius:6px;font-weight:800;font-size:9px;margin-left:6px}
.g2{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px}
.box2{border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px}
.kv{display:flex;justify-content:space-between;padding:3px 0;font-size:10.5px;border-bottom:1px solid #f1f5f9}
.kv:last-child{border-bottom:none}
.kv .lbl{color:#64748b}.kv .val{font-weight:700}
.grupo{margin-bottom:12px;break-inside:avoid}
.cat{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#0b315f;border-bottom:1.5px solid #e2e8f0;padding-bottom:4px;margin:0 0 6px}
.item{display:flex;gap:8px;padding:6px 0;border-bottom:1px dashed #f1f5f9;break-inside:avoid}
.box{font-size:15px;line-height:1.1}
.item-txt p{margin:0}
.item-txt .tachado{text-decoration:line-through;color:#94a3b8}
.item-txt .obs{font-size:9.5px;color:#94a3b8;margin-top:2px}
.item-txt .obs.linea{color:#cbd5e1}
.acc{font-weight:800;color:#0b315f}
.firmas{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:28px}
.firma{border-top:1.5px solid #1e293b;padding-top:6px;text-align:center;font-size:9.5px;color:#64748b}
.ft{border-top:1.5px solid #e2e8f0;padding-top:8px;margin-top:18px;text-align:center;font-size:8.5px;color:#94a3b8}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;

    const body = `<div class="hd">
  <div><h1>Orden de Trabajo #${ot.id}${ot.origen === "automatica" ? '<span class="chip" style="background:#e0e7ff;color:#3730a3">🤖 Auto</span>' : ""}</h1>
    <p>AFA Tours Peru SAC · Mantenimiento preventivo${pl ? " · " + esc(pl.nombre) : ""}</p></div>
  <div class="hd-right"><p style="font-size:11px;font-weight:800;color:#0b315f">${esc(veh?.placa || "—")}</p>
    <p>${esc(veh?.categoria || "")}</p></div>
</div>
<div class="g2">
  <div class="box2">
    <div class="kv"><span class="lbl">Vehículo</span><span class="val">${esc(veh?.placa || "—")}${veh?.categoria ? " · " + esc(veh.categoria) : ""}</span></div>
    <div class="kv"><span class="lbl">Km de apertura</span><span class="val">${ot.km_apertura ? Number(ot.km_apertura).toLocaleString("es-PE") + " km" : "—"}</span></div>
    <div class="kv"><span class="lbl">Fecha de apertura</span><span class="val">${fmtFecha(ot.fecha_apertura)}</span></div>
    <div class="kv"><span class="lbl">Estado</span><span class="val">${esc(ESTADO_OT[ot.estado]?.label || ot.estado)}</span></div>
  </div>
  <div class="box2">
    <div class="kv"><span class="lbl">Taller</span><span class="val">${esc(ot.taller || "—")}</span></div>
    <div class="kv"><span class="lbl">Mecánico</span><span class="val">${esc(ot.mecanico || "—")}</span></div>
    <div class="kv"><span class="lbl">Costo</span><span class="val">${ot.costo_total ? fmtSoles(ot.costo_total) : "—"}</span></div>
    <div class="kv"><span class="lbl">Observaciones</span><span class="val">${esc(ot.observaciones || "—")}</span></div>
  </div>
  <div class="box2">
    <div class="kv"><span class="lbl">Plan fabricante</span><span class="val">${plan ? esc(`${plan.marca} ${plan.modelo}${plan.motor ? " · " + plan.motor : ""}`) : "—"}</span></div>
    <div class="kv"><span class="lbl">Intervalo del plan</span><span class="val">${plan ? esc([plan.intervalo_base_km ? Number(plan.intervalo_base_km).toLocaleString("es-PE") + " km" : null, plan.intervalo_base_meses ? plan.intervalo_base_meses + " m" : null].filter(Boolean).join(" / ") || "—") : "—"}</span></div>
    <div class="kv"><span class="lbl">N° serie / chasis</span><span class="val">${esc(veh?.nro_serie || "—")}</span></div>
    <div class="kv"><span class="lbl">Fecha límite sugerida</span><span class="val">${ot.fecha_limite_sugerida ? fmtFecha(ot.fecha_limite_sugerida) : "—"}</span></div>
  </div>
</div>
${filasGrupo || '<p style="color:#94a3b8;text-align:center">Sin ítems en el checklist.</p>'}
<div class="firmas">
  <div class="firma">Conductor<br/>Nombre y firma</div>
  <div class="firma">Taller / Mecánico<br/>Nombre y firma</div>
</div>
<p class="ft">AFA Transportes · R.D. N° 1946-2009-MTC-15 · Tel: 966707225 / 01-3453707 · Generado ${fmtFecha(new Date().toISOString())}</p>`;

    abrirImprimible(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
<title>OT #${ot.id} — ${esc(veh?.placa || "AFA")}</title><style>${css}</style></head>
<body>${body}<script>window.onload=()=>window.print()<\/script></body></html>`);
  };

  // ── Checklist OT ──────────────────────────────────────────────────────────

  const toggleItem = async (item: ChecklistOT) => {
    const nuevo = !item.completado;
    await supabase.from("checklist_ot").update({ completado: nuevo }).eq("id", item.id);
    setChecklistOT(prev => prev.map(c => c.id === item.id ? { ...c, completado: nuevo } : c));
  };

  const actualizarObservacion = async (id: number, obs: string) => {
    await supabase.from("checklist_ot").update({ observacion: obs || null }).eq("id", id);
    setChecklistOT(prev => prev.map(c => c.id === id ? { ...c, observacion: obs } : c));
  };

  const agregarItemOT = async (otId: number, item: string, categoria: string) => {
    if (!item.trim()) return;
    const { data } = await supabase.from("checklist_ot").insert({ orden_trabajo_id: otId, item: item.trim(), categoria: categoria || "Otros", completado: false }).select().single();
    if (data) setChecklistOT(prev => [...prev, data]);
  };

  // Qué pasó realmente con el ítem — puede diferir de lo que decía el plan (una
  // inspección que terminó en cambio real, por ejemplo). "" = quitar la acción.
  const cambiarAccion = async (item: ChecklistOT, accion: string) => {
    const valor = accion || null;
    await supabase.from("checklist_ot").update({ accion_final: valor }).eq("id", item.id);
    setChecklistOT(prev => prev.map(c => c.id === item.id ? { ...c, accion_final: valor } : c));
  };

  const actualizarRepuesto = async (id: number, repuesto: string) => {
    await supabase.from("checklist_ot").update({ repuesto: repuesto || null }).eq("id", id);
    setChecklistOT(prev => prev.map(c => c.id === id ? { ...c, repuesto } : c));
  };

  // Foto de evidencia por ítem — subida desde el ERP (no desde el app del conductor,
  // ver conversación: el taller manda su propio reporte y factura aparte).
  const subirFotoItem = async (item: ChecklistOT, file: File) => {
    setSubiendoFotoId(item.id);
    const ext = file.name.split(".").pop() || "jpg";
    const path = `ot-checklist/${item.id}-${Date.now()}.${ext}`;
    const up = await supabase.storage.from("vehiculos-fotos").upload(path, file, { upsert: true });
    if (up.error) { alert("Error al subir la foto: " + up.error.message); setSubiendoFotoId(null); return; }
    const url = supabase.storage.from("vehiculos-fotos").getPublicUrl(path).data.publicUrl;
    await supabase.from("checklist_ot").update({ foto_url: url }).eq("id", item.id);
    setChecklistOT(prev => prev.map(c => c.id === item.id ? { ...c, foto_url: url } : c));
    setSubiendoFotoId(null);
  };

  const toggleCategoria = (otId: number, cat: string) => {
    const clave = `${otId}:${cat}`;
    setCatColapsada(prev => { const n = new Set(prev); n.has(clave) ? n.delete(clave) : n.add(clave); return n; });
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const totalOT     = ordenes.length;
  const abiertas    = ordenes.filter(o => o.estado === "abierta").length;
  const enProceso   = ordenes.filter(o => o.estado === "en_proceso").length;
  const cerradas    = ordenes.filter(o => o.estado === "cerrada").length;
  const costoTotal  = ordenes.reduce((s, o) => s + Number(o.costo_total || 0), 0);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  const [nuevoItemOT, setNuevoItemOT] = useState("");
  const [nuevaCatOT,  setNuevaCatOT]  = useState("Motor");

  return (
    <main className="p-6 space-y-6 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Órdenes de Trabajo</h1>
          <p className="text-gray-400 text-sm mt-1">Plantillas · OT digitales · Checklist por vehículo</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => { setMostrarFormPl(v => !v); setMostrarFormOT(false); }}
            className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all hover:bg-gray-50"
            style={{ borderColor: mostrarFormPl ? "#6b7280" : "#0b315f", color: mostrarFormPl ? "#6b7280" : "#0b315f" }}>
            {mostrarFormPl ? "✕ Cancelar" : "📋 Nueva plantilla"}
          </button>
          <button onClick={() => { setMostrarFormOT(v => !v); setMostrarFormPl(false); }}
            className="px-4 py-2.5 rounded-xl font-bold text-sm text-white transition-all hover:opacity-90"
            style={{ background: mostrarFormOT ? "#6b7280" : "#0b315f" }}>
            {mostrarFormOT ? "✕ Cancelar" : "+ Nueva OT"}
          </button>
        </div>
      </div>

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: "Total OT",    valor: totalOT,   color: "#0b315f", bg: "#eef3f8" },
          { label: "Abiertas",    valor: abiertas,  color: "#1d4ed8", bg: "#dbeafe" },
          { label: "En proceso",  valor: enProceso, color: "#854d0e", bg: "#fef9c3" },
          { label: "Cerradas",    valor: cerradas,  color: "#166534", bg: "#dcfce7" },
          { label: "Costo total", valor: fmtSoles(costoTotal), color: "#991b1b", bg: "#fee2e2" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* FORM PLANTILLA */}
      {mostrarFormPl && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>📋</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoPlId ? "Editar plantilla" : "Nueva plantilla de mantenimiento"}</h2>
              <p className="text-xs text-gray-400">Define la rutina y el checklist que se usará en las OT</p>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Configuración</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Nombre de la rutina *">
                <select className={inputCls()} value={formPl.nombre}
                  onChange={e => { fpl("nombre")(e); cargarChecklistBase(e.target.value); }}>
                  <option value="">Seleccionar rutina</option>
                  {Object.keys(CHECKLIST_BASE).map(n => <option key={n}>{n}</option>)}
                  <option value="Personalizado">Personalizado</option>
                </select>
              </Campo>
              <Campo label="Tipo">
                <select className={inputCls()} value={formPl.tipo} onChange={fpl("tipo")}>
                  <option value="preventivo">Preventivo</option>
                  <option value="correctivo">Correctivo</option>
                </select>
              </Campo>
              <Campo label="Vehículo (opcional)">
                <select className={inputCls()} value={formPl.vehiculo_id} onChange={fpl("vehiculo_id")}>
                  <option value="">Aplica a toda la flota</option>
                  {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa} · {v.categoria}</option>)}
                </select>
              </Campo>
              <Campo label="Intervalo KM">
                <input type="number" className={inputCls("font-mono")} placeholder="Ej: 5000" value={formPl.km_intervalo} onChange={fpl("km_intervalo")} />
              </Campo>
              <Campo label="Intervalo meses">
                <input type="number" className={inputCls()} placeholder="Ej: 3" value={formPl.meses_intervalo} onChange={fpl("meses_intervalo")} />
              </Campo>
              <Campo label="Descripción">
                <input className={inputCls()} placeholder="Descripción breve" value={formPl.descripcion} onChange={fpl("descripcion")} />
              </Campo>
            </div>
          </div>

          {/* Checklist items */}
          <div>
            <div className="flex items-center justify-between border-b pb-1 mb-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Checklist ({itemsPl.length} items)</p>
              <button onClick={() => setItemsPl(p => [...p, { categoria: "Motor", item: "", obligatorio: true }])}
                className="text-xs font-bold text-[#0b315f] hover:underline">+ Agregar item</button>
            </div>

            {itemsPl.length === 0 && (
              <p className="text-sm text-gray-400 text-center py-4">Selecciona una rutina para cargar el checklist base, o agrega items manualmente</p>
            )}

            <div className="space-y-2">
              {itemsPl.map((it, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center bg-gray-50 rounded-xl p-2">
                  <div className="col-span-3">
                    <select className={inputCls("text-xs")} value={it.categoria}
                      onChange={e => setItemsPl(p => p.map((x, j) => j === i ? { ...x, categoria: e.target.value } : x))}>
                      {CATEGORIAS_CHECKLIST.map(c => <option key={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="col-span-7">
                    <input className={inputCls("text-xs")} placeholder="Descripción del item" value={it.item}
                      onChange={e => setItemsPl(p => p.map((x, j) => j === i ? { ...x, item: e.target.value } : x))} />
                  </div>
                  <div className="col-span-1 flex justify-center">
                    <input type="checkbox" checked={it.obligatorio}
                      onChange={e => setItemsPl(p => p.map((x, j) => j === i ? { ...x, obligatorio: e.target.checked } : x))}
                      title="Obligatorio" className="w-4 h-4 accent-[#0b315f]" />
                  </div>
                  <div className="col-span-1 flex justify-end">
                    <button onClick={() => setItemsPl(p => p.filter((_, j) => j !== i))}
                      className="w-7 h-7 rounded-lg text-red-400 hover:bg-red-50 text-sm font-bold flex items-center justify-center">✕</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={guardarPlantilla} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoPlId ? "Actualizar" : "Guardar plantilla"}
            </button>
            <button onClick={() => { setFormPl(FORM_PL_VACIO); setItemsPl([]); setEditandoPlId(null); setMostrarFormPl(false); }}
              className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* FORM OT */}
      {mostrarFormOT && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>🔧</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoOtId ? `Editar OT #${editandoOtId}` : "Nueva Orden de Trabajo"}</h2>
              <p className="text-xs text-gray-400">El checklist se genera automáticamente desde la plantilla seleccionada</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Campo label="Vehículo *">
              <select className={inputCls()} value={formOT.vehiculo_id} onChange={fot("vehiculo_id")}>
                <option value="">Seleccionar vehículo</option>
                {vehiculos.map(v => (
                  <option key={v.id} value={v.id}>
                    {v.placa} · {v.categoria}
                    {v.kilometraje_actual ? ` · ${Number(v.kilometraje_actual).toLocaleString()} km` : ""}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo label="Plantilla (genera checklist automático)">
              <select className={inputCls()} value={formOT.plantilla_id} onChange={fot("plantilla_id")}>
                <option value="">Sin plantilla</option>
                {plantillas.filter(p => p.activo).map(p => (
                  <option key={p.id} value={p.id}>
                    {p.nombre}{p.km_intervalo ? ` · cada ${Number(p.km_intervalo).toLocaleString()} km` : ""}
                  </option>
                ))}
              </select>
            </Campo>
            <Campo label="Estado">
              <select className={inputCls()} value={formOT.estado} onChange={fot("estado")}>
                <option value="abierta">Abierta</option>
                <option value="en_proceso">En proceso</option>
                <option value="cerrada">Cerrada</option>
                <option value="cancelada">Cancelada</option>
              </select>
            </Campo>
            <Campo label="Fecha de apertura">
              <input type="date" className={inputCls()} value={formOT.fecha_apertura} onChange={fot("fecha_apertura")} />
            </Campo>
            <Campo label="KM al abrir OT">
              <input type="number" className={inputCls("font-mono")} placeholder="Ej: 150000" value={formOT.km_apertura} onChange={fot("km_apertura")} />
            </Campo>
            <Campo label="Costo total S/">
              <input type="number" className={inputCls()} placeholder="0.00" value={formOT.costo_total} onChange={fot("costo_total")} />
            </Campo>
            <Campo label="Mecánico responsable">
              <input className={inputCls()} placeholder="Nombre del mecánico" value={formOT.mecanico} onChange={fot("mecanico")} />
            </Campo>
            <Campo label="Taller / Proveedor">
              <input className={inputCls()} placeholder="Nombre del taller" value={formOT.taller} onChange={fot("taller")} />
            </Campo>
            <Campo label="Observaciones">
              <input className={inputCls()} placeholder="Notas adicionales" value={formOT.observaciones} onChange={fot("observaciones")} />
            </Campo>
          </div>

          {/* Preview items de plantilla */}
          {formOT.plantilla_id && (() => {
            const items = checklistPl.filter(c => c.plantilla_id === Number(formOT.plantilla_id));
            return items.length > 0 ? (
              <div className="rounded-xl p-3 text-xs" style={{ background: "#f0f9ff", border: "1px solid #bae6fd" }}>
                <p className="font-bold text-blue-800 mb-2">✅ Se generarán {items.length} items en el checklist:</p>
                <div className="grid grid-cols-2 gap-1">
                  {items.slice(0, 8).map(it => (
                    <div key={it.id} className="flex items-center gap-1 text-blue-700">
                      <span className="text-[10px]">◆</span> {it.item}
                    </div>
                  ))}
                  {items.length > 8 && <div className="text-blue-500">+{items.length - 8} más...</div>}
                </div>
              </div>
            ) : null;
          })()}

          <div className="flex gap-3">
            <button onClick={guardarOT} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoOtId ? "Actualizar OT" : "Crear OT"}
            </button>
            <button onClick={() => { setFormOT(FORM_OT_VACIO); setEditandoOtId(null); setMostrarFormOT(false); }}
              className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* PESTAÑAS */}
      <div className="flex gap-1 border-b">
        {([["ordenes", `🔧 Órdenes de trabajo (${totalOT})`], ["plantillas", `📋 Plantillas (${plantillas.length})`]] as [Vista, string][]).map(([v, l]) => (
          <button key={v} onClick={() => setVista(v)}
            className="px-5 py-2.5 text-sm font-bold border-b-2 -mb-px transition-all"
            style={{ borderColor: vista === v ? "#0b315f" : "transparent", color: vista === v ? "#0b315f" : "#9ca3af" }}>
            {l}
          </button>
        ))}
      </div>

      {/* ── VISTA: ÓRDENES ── */}
      {vista === "ordenes" && (
        <div className="space-y-4">
          {loading ? (
            <div className="p-10 text-center text-gray-400">
              <div className="w-8 h-8 border-4 border-gray-200 border-t-[#0b315f] rounded-full animate-spin mx-auto mb-3" />
              Cargando órdenes...
            </div>
          ) : ordenes.length === 0 ? (
            <div className="p-10 text-center text-gray-400 bg-white rounded-2xl border">
              <p className="text-3xl mb-2">🔧</p>
              <p className="font-medium">No hay órdenes de trabajo</p>
              <p className="text-sm mt-1">Crea la primera con el botón "+ Nueva OT"</p>
            </div>
          ) : ordenes.map(ot => {
            const veh      = vehiculos.find(v => v.id === ot.vehiculo_id);
            const pl       = plantillas.find(p => p.id === ot.plantilla_id);
            const estCfg   = ESTADO_OT[ot.estado] || ESTADO_OT.abierta;
            const items    = checklistOT.filter(c => c.orden_trabajo_id === ot.id);
            const completados = items.filter(c => c.completado).length;
            const pctCheck = items.length > 0 ? Math.round((completados / items.length) * 100) : 0;
            const abierto  = otActiva === ot.id;

            return (
              <div key={ot.id} className="bg-white rounded-2xl border shadow-sm overflow-hidden">
                {/* Header OT */}
                <div className="px-5 py-4 flex items-center justify-between flex-wrap gap-3 cursor-pointer"
                  onClick={() => setOtActiva(abierto ? null : ot.id)}>
                  <div className="flex items-center gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-black font-mono text-[#0b315f]">OT #{ot.id}</span>
                        <span className="text-xs font-bold px-2.5 py-1 rounded-lg"
                          style={{ background: estCfg.bg, color: estCfg.color }}>{estCfg.label}</span>
                        {pl && <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">{pl.nombre}</span>}
                        {ot.origen === "automatica" && (
                          <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: "#e0e7ff", color: "#3730a3" }} title="Creada automáticamente al llegar al kilometraje/fecha del plan del fabricante">
                            🤖 Auto
                          </span>
                        )}
                        {(ot.estado === "abierta" || ot.estado === "en_proceso") && (() => {
                          const d = diasAbierta(ot.fecha_apertura);
                          if (d < 3) return null;
                          const urgente = d >= 7;
                          return (
                            <span className="text-xs font-bold px-2 py-0.5 rounded-lg"
                              style={{ background: urgente ? "#fee2e2" : "#fef9c3", color: urgente ? "#991b1b" : "#854d0e" }}
                              title="Días desde que se abrió, sin cerrar">
                              ⏱ {d} d abierta
                            </span>
                          );
                        })()}
                      </div>
                      <div className="text-sm text-gray-500 mt-0.5">
                        🚌 <b>{veh?.placa || "—"}</b> · {veh?.categoria}
                        {ot.km_apertura && <> · <span className="font-mono">{Number(ot.km_apertura).toLocaleString()} km</span></>}
                        {ot.mecanico && <> · 👤 {ot.mecanico}</>}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {/* Progreso checklist */}
                    {items.length > 0 && (
                      <div className="text-right min-w-[100px]">
                        <div className="text-xs font-bold text-gray-600 mb-1">
                          {completados}/{items.length} items · {pctCheck}%
                        </div>
                        <div className="h-2 bg-gray-100 rounded-full overflow-hidden w-28">
                          <div className="h-full rounded-full transition-all"
                            style={{ width: `${pctCheck}%`, background: pctCheck === 100 ? "#16a34a" : pctCheck > 50 ? "#eab308" : "#3b82f6" }} />
                        </div>
                      </div>
                    )}

                    {/* Info */}
                    <div className="text-right text-xs text-gray-400">
                      <div>{fmtFecha(ot.fecha_apertura)}</div>
                      {ot.costo_total > 0 && <div className="font-bold text-red-700">{fmtSoles(ot.costo_total)}</div>}
                    </div>

                    <span className="text-gray-300">{abierto ? "▲" : "▼"}</span>
                  </div>
                </div>

                {/* CHECKLIST EXPANDIDO */}
                {abierto && (
                  <div className="border-t px-5 py-4 space-y-4" style={{ borderColor: "#f1f5f9" }}>

                    {/* Acciones OT */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <select value={ot.estado}
                        onChange={e => cambiarEstadoOT(ot, e.target.value)}
                        className="text-xs font-bold px-3 py-1.5 rounded-lg border-0 cursor-pointer"
                        style={{ background: estCfg.bg, color: estCfg.color }}>
                        <option value="abierta">Abierta</option>
                        <option value="en_proceso">En proceso</option>
                        <option value="cerrada">Cerrada</option>
                        <option value="cancelada">Cancelada</option>
                      </select>
                      <button onClick={() => { setFormOT({ vehiculo_id: String(ot.vehiculo_id || ""), plantilla_id: String(ot.plantilla_id || ""), km_apertura: String(ot.km_apertura || ""), fecha_apertura: ot.fecha_apertura, mecanico: ot.mecanico || "", taller: ot.taller || "", costo_total: String(ot.costo_total || ""), estado: ot.estado, observaciones: ot.observaciones || "" }); setEditandoOtId(ot.id); setMostrarFormOT(true); setMostrarFormPl(false); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">
                        ✏️ Editar OT
                      </button>
                      <button onClick={() => generarPdfOT(ot)}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold text-white hover:opacity-90" style={{ background: "#991b1b" }}>
                        🖨 PDF
                      </button>
                      <button onClick={() => eliminarOT(ot.id)}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">
                        ✕ Eliminar
                      </button>
                      {ot.taller && <span className="text-xs text-gray-400">🏢 {ot.taller}</span>}
                      {ot.observaciones && <span className="text-xs text-gray-400 italic">"{ot.observaciones}"</span>}
                    </div>

                    {/* Items checklist agrupados por categoría */}
                    {items.length === 0 ? (
                      <p className="text-sm text-gray-400 text-center py-4">
                        Sin items en el checklist. Agrega items manualmente abajo.
                      </p>
                    ) : (() => {
                      const renderItem = (item: ChecklistOT) => (
                        <div key={item.id} className={`p-3 rounded-xl border transition-all ${item.completado ? "bg-green-50 border-green-100" : "bg-gray-50 border-gray-100"}`}>
                          <div className="flex items-start gap-3">
                            <input type="checkbox" checked={item.completado}
                              onChange={() => toggleItem(item)}
                              className="mt-0.5 w-4 h-4 accent-green-600 cursor-pointer flex-shrink-0" />
                            <div className="flex-1 min-w-0 space-y-1.5">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className={`text-sm font-medium ${item.completado ? "line-through text-gray-400" : "text-gray-800"}`}>
                                  {item.item}
                                </p>
                                <select value={item.accion_final || ""} onChange={e => cambiarAccion(item, e.target.value)}
                                  onClick={e => e.stopPropagation()}
                                  className="text-[10px] font-bold px-2 py-0.5 rounded-lg border-0 cursor-pointer"
                                  style={item.accion_final && ACCION_CFG[item.accion_final]
                                    ? { background: ACCION_CFG[item.accion_final].bg, color: ACCION_CFG[item.accion_final].color }
                                    : { background: "#f3f4f6", color: "#9ca3af" }}>
                                  <option value="">Sin acción</option>
                                  <option value="C">Cambio</option>
                                  <option value="I">Inspección</option>
                                  <option value="R">Cada servicio</option>
                                </select>
                                {item.accion_plan && item.accion_final && item.accion_plan !== item.accion_final && (
                                  <span className="text-[10px] text-gray-400" title="Lo que decía el plan del fabricante para este hito">
                                    plan: {ACCION_CFG[item.accion_plan]?.label || item.accion_plan}
                                  </span>
                                )}
                              </div>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1">
                                <input
                                  className="w-full text-xs border-0 bg-transparent text-gray-400 placeholder-gray-300 focus:outline-none"
                                  placeholder="Observación (opcional)..."
                                  defaultValue={item.observacion || ""}
                                  onBlur={e => actualizarObservacion(item.id, e.target.value)}
                                />
                                <input
                                  className="w-full text-xs border-0 bg-transparent text-gray-400 placeholder-gray-300 focus:outline-none"
                                  placeholder="Repuesto/insumo usado (opcional)..."
                                  defaultValue={item.repuesto || ""}
                                  onBlur={e => actualizarRepuesto(item.id, e.target.value)}
                                />
                              </div>
                              <div className="flex items-center gap-2">
                                {item.foto_url && (
                                  <a href={item.foto_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>
                                    <img src={item.foto_url} alt="Evidencia" className="w-9 h-9 rounded-lg object-cover border" />
                                  </a>
                                )}
                                <label className="text-[10px] font-bold text-[#0b315f] cursor-pointer hover:underline" onClick={e => e.stopPropagation()}>
                                  {subiendoFotoId === item.id ? "Subiendo…" : item.foto_url ? "📷 Cambiar foto" : "📷 Adjuntar foto"}
                                  <input type="file" accept="image/*" className="hidden"
                                    onChange={e => { const f = e.target.files?.[0]; if (f) subirFotoItem(item, f); e.target.value = ""; }} />
                                </label>
                              </div>
                            </div>
                            {item.completado && <span className="text-green-500 text-base flex-shrink-0">✓</span>}
                          </div>
                        </div>
                      );

                      return (
                        <div className="space-y-3">
                          {CATEGORIAS_CHECKLIST.filter(cat => items.some(i => i.categoria === cat)).map(cat => {
                            const catItems = items.filter(i => i.categoria === cat);
                            const clave = `${ot.id}:${cat}`;
                            const colapsada = catColapsada.has(clave);
                            const esSeguridad = CATEGORIAS_SEGURIDAD.has(cat);
                            return (
                              <div key={cat} className={esSeguridad ? "border-l-4 pl-3" : ""} style={esSeguridad ? { borderColor: "#dc2626" } : undefined}>
                                <button onClick={() => toggleCategoria(ot.id, cat)} className="flex items-center gap-2 w-full text-left mb-2">
                                  <span className="text-gray-300 text-[10px]">{colapsada ? "▶" : "▼"}</span>
                                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">{cat}</p>
                                  {esSeguridad && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: "#fee2e2", color: "#991b1b" }}>⚠ Seguridad</span>}
                                  <span className="text-[10px] text-gray-300">({catItems.filter(i => i.completado).length}/{catItems.length})</span>
                                </button>
                                {!colapsada && <div className="space-y-1.5">{catItems.map(renderItem)}</div>}
                              </div>
                            );
                          })}
                          {/* Items sin categoría */}
                          {items.filter(i => !i.categoria || !CATEGORIAS_CHECKLIST.includes(i.categoria)).map(renderItem)}
                        </div>
                      );
                    })()}

                    {/* Agregar item manual */}
                    <div className="flex gap-2 pt-2 border-t" style={{ borderColor: "#f1f5f9" }}>
                      <select className="border rounded-xl px-3 py-2 text-xs min-w-[130px]"
                        value={nuevaCatOT} onChange={e => setNuevaCatOT(e.target.value)}>
                        {CATEGORIAS_CHECKLIST.map(c => <option key={c}>{c}</option>)}
                      </select>
                      <input className="flex-1 border rounded-xl px-3 py-2 text-xs focus:outline-none"
                        placeholder="Agregar item al checklist..."
                        value={nuevoItemOT}
                        onChange={e => setNuevoItemOT(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") { agregarItemOT(ot.id, nuevoItemOT, nuevaCatOT); setNuevoItemOT(""); } }} />
                      <button onClick={() => { agregarItemOT(ot.id, nuevoItemOT, nuevaCatOT); setNuevoItemOT(""); }}
                        className="px-4 py-2 rounded-xl text-xs font-bold text-white"
                        style={{ background: "#0b315f" }}>
                        + Agregar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── VISTA: PLANTILLAS ── */}
      {vista === "plantillas" && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {plantillas.length === 0 ? (
            <div className="col-span-3 p-10 text-center text-gray-400 bg-white rounded-2xl border">
              <p className="text-3xl mb-2">📋</p>
              <p className="font-medium">No hay plantillas definidas</p>
              <p className="text-sm mt-1">Crea la primera con "📋 Nueva plantilla"</p>
            </div>
          ) : plantillas.map(pl => {
            const items = checklistPl.filter(c => c.plantilla_id === pl.id);
            const veh   = vehiculos.find(v => v.id === pl.vehiculo_id);
            return (
              <div key={pl.id} className="bg-white rounded-2xl border shadow-sm p-5 space-y-3">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="font-black text-gray-900">{pl.nombre}</h3>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded"
                        style={{ background: pl.tipo === "preventivo" ? "#dbeafe" : "#fee2e2", color: pl.tipo === "preventivo" ? "#1d4ed8" : "#991b1b" }}>
                        {pl.tipo}
                      </span>
                      {pl.km_intervalo && <span className="text-[10px] text-gray-400">cada {Number(pl.km_intervalo).toLocaleString()} km</span>}
                      {pl.meses_intervalo && <span className="text-[10px] text-gray-400">· {pl.meses_intervalo} meses</span>}
                    </div>
                    {veh && <p className="text-xs text-gray-400 mt-1">🚌 {veh.placa} · {veh.categoria}</p>}
                    {!pl.vehiculo_id && <p className="text-xs text-gray-400 mt-1">Aplica a toda la flota</p>}
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => eliminarPlantilla(pl.id)}
                      className="px-2 py-1 rounded-lg text-xs text-red-500 hover:bg-red-50">✕</button>
                  </div>
                </div>

                {pl.descripcion && <p className="text-xs text-gray-500 italic">"{pl.descripcion}"</p>}

                {/* Items del checklist */}
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">
                    Checklist ({items.length} items)
                  </p>
                  <div className="space-y-1 max-h-36 overflow-y-auto">
                    {items.map(it => (
                      <div key={it.id} className="flex items-center gap-2 text-xs text-gray-600">
                        <span className="text-gray-300">◆</span>
                        <span className={it.obligatorio ? "font-medium" : "text-gray-400"}>{it.item}</span>
                        {!it.obligatorio && <span className="text-[10px] text-gray-300">(opcional)</span>}
                      </div>
                    ))}
                    {items.length === 0 && <p className="text-xs text-gray-300">Sin items definidos</p>}
                  </div>
                </div>

                {/* Usar plantilla */}
                <button
                  onClick={() => { setFormOT(p => ({ ...p, plantilla_id: String(pl.id), vehiculo_id: pl.vehiculo_id ? String(pl.vehiculo_id) : "" })); setMostrarFormOT(true); setMostrarFormPl(false); setVista("ordenes"); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                  className="w-full py-2 rounded-xl text-xs font-bold text-white hover:opacity-90"
                  style={{ background: "#0b315f" }}>
                  + Crear OT con esta plantilla
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* MODAL CERRAR OT — pide el km real para re-anclar el próximo mantenimiento */}
      {cerrarOT && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setCerrarOT(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b">
              <h3 className="font-bold text-gray-900">Cerrar OT #{cerrarOT.ot.id}</h3>
              <p className="text-xs text-gray-400 mt-1">
                El km real de cierre mueve el próximo mantenimiento de este vehículo — si no lo indicas,
                el sistema seguirá viéndolo vencido y volverá a generar la misma OT.
              </p>
            </div>
            <div className="p-6 space-y-2">
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Odómetro real al cerrar (km) *</label>
              <input type="number" autoFocus className={inputCls("font-mono")}
                value={cerrarOT.km} onChange={e => setCerrarOT(c => c ? { ...c, km: e.target.value } : c)} />
            </div>
            <div className="px-6 py-4 border-t flex justify-end gap-3">
              <button onClick={() => setCerrarOT(null)} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
              <button onClick={confirmarCierre} disabled={guardando}
                className="px-5 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90" style={{ background: "#166534" }}>
                {guardando ? "Cerrando…" : "Cerrar OT"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}