"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { abrirImprimible } from "@/lib/documentos-servicio";
import { cotejarFacturaConOT, type ItemCosto } from "@/lib/mantenimiento/costo-ot";
import {
  repartoDeOT, facturasDeOT, valorizarManoObraPropia,
  TIPOS_LINEA, ORIGENES_LINEA, type TipoLinea, type OrigenLinea, type TarifaHora,
} from "@/lib/mantenimiento/lineas-costo";
import {
  guardarCostoItem, guardarCostoOT, sincronizarLibro, registrarFacturaTaller, urlFactura,
  cargarLineas, guardarLinea, borrarLinea, tarifaDeTaller, type LineaGuardada,
} from "@/lib/mantenimiento/ot-factura";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Vehiculo = {
  id: number; placa: string; categoria: string | null;
  kilometraje_actual: number | null; nro_serie?: string | null;
};

type PlanFabricante = {
  id: string; marca: string; modelo: string; motor: string | null;
  intervalo_base_km: number | null; intervalo_base_meses: number | null;
};

type Proveedor = {
  id: number; nombre: string; telefono: string | null;
  direccion: string | null; tipo: string; estado: string;
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
  taller_proveedor_id?: number | null;   // del directorio de Proveedores (tipo=taller)
  fecha_programada?: string | null;      // cuándo se planea llevar la unidad
  // La fila de `mantenimiento` que esta OT asentó, y la factura del taller. Las dos son de
  // `mantenimiento-05-costo-factura-cxp.sql`: sin esa migración llegan en undefined y la
  // pantalla lo dice en vez de fingir que el costo viaja.
  mantenimiento_id?: number | null;
  documento_compra_id?: number | null;
};

type ChecklistOT = {
  id: number; orden_trabajo_id: number; item: string;
  categoria: string | null; completado: boolean; observacion: string | null;
  accion_plan?: string | null;  // C/I/R — snapshot del plan al crear el ítem, no se edita
  accion_final?: string | null; // editable: qué pasó realmente
  foto_url?: string | null;
  repuesto?: string | null;
  costo?: number | null;   // null = sin teclear (≠ 0). Ver lib/mantenimiento/costo-ot.ts
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

// Prefiere el proveedor del directorio; si no hay, cae al texto libre (taller ocasional).
function nombreTaller(ot: OrdenTrabajo, talleres: Proveedor[]): string | null {
  if (ot.taller_proveedor_id) {
    const t = talleres.find(x => x.id === ot.taller_proveedor_id);
    if (t) return t.nombre + (t.telefono ? ` · ${t.telefono}` : "");
  }
  return ot.taller || null;
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
  const [talleres,    setTalleres]  = useState<Proveedor[]>([]);
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
  // Lo que el costo NO pudo hacer: sin ancla con el libro, o sin la migración corrida. Se dice,
  // porque un costo que parece guardarse y no llega al egreso es peor que un error.
  const [avisoCosto,      setAvisoCosto]      = useState("");
  const [facturaOT,       setFacturaOT]       = useState<{ ot: OrdenTrabajo; lineaId?: number | string | null } | null>(null);
  // Las líneas de costo de todas las OT a la vista, y con qué se valoriza una hora de casa.
  // Las dos son de `mantenimiento-06-lineas-de-costo.sql`, accesoria: sin ella llegan vacías y la
  // pantalla se comporta exactamente como antes (un costo plano, todo desembolso).
  const [lineas,       setLineas]       = useState<LineaGuardada[]>([]);
  const [tarifaTaller, setTarifaTaller] = useState<TarifaHora | null>(null);
  const [lineaEditada, setLineaEditada] = useState<{ otId: number; id?: number | string } | null>(null);

  // Form OT
  const FORM_OT_VACIO = { vehiculo_id: "", plantilla_id: "", km_apertura: "", fecha_apertura: new Date().toISOString().split("T")[0], fecha_programada: "", mecanico: "", taller_proveedor_id: "", taller: "", costo_total: "", estado: "abierta", observaciones: "" };
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
    const [vRes, plRes, chPlRes, otRes, chOtRes, pfRes, tlRes] = await Promise.all([
      supabase.from("vehiculos").select("id,placa,categoria,kilometraje_actual,nro_serie").order("placa"),
      supabase.from("plantillas_mantenimiento").select("*").order("nombre"),
      supabase.from("checklist_plantilla").select("*").order("orden"),
      supabase.from("ordenes_trabajo").select("*").order("created_at", { ascending: false }),
      supabase.from("checklist_ot").select("*"),
      supabase.from("planes_mantenimiento").select("id,marca,modelo,motor,intervalo_base_km,intervalo_base_meses"),
      supabase.from("proveedores").select("id,nombre,telefono,direccion,tipo,estado").eq("tipo", "taller").order("nombre"),
    ]);
    setVehiculos(vRes.data    || []);
    setPlantillas(plRes.data  || []);
    setChecklistPl(chPlRes.data || []);
    setOrdenes(otRes.data     || []);
    setChecklistOT(chOtRes.data || []);
    setPlanesFab(pfRes.data   || []);
    setTalleres(tlRes.data    || []);

    // Las líneas cuelgan de las órdenes ya cargadas: sin ellas no hay a qué preguntarle.
    const ids = ((otRes.data as OrdenTrabajo[] | null) ?? []).map(o => o.id);
    const [ls, tf] = await Promise.all([cargarLineas(ids), tarifaDeTaller()]);
    setLineas(ls);
    setTarifaTaller(tf);
    setLoading(false);
  };

  /** Las líneas y el reparto de UNA orden, derivados por el mismo camino en toda la pantalla. */
  const repartoDe = (ot: OrdenTrabajo, items?: ChecklistOT[]) => {
    const ls = lineas.filter(l => l.orden_trabajo_id === ot.id);
    const its = (items ?? checklistOT.filter(c => c.orden_trabajo_id === ot.id))
      .map(i => ({ id: i.id, costo: i.costo ?? null }));
    return { lineas: ls, items: its, reparto: repartoDeOT(ls, its, ot.costo_total),
             facturas: facturasDeOT(ot.documento_compra_id, ls) };
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

    // El total que se guarda es el DERIVADO, no el tecleado a secas: si los ítems de esta OT ya
    // llevan costo, mandan ellos. Guardar aquí el tecleado dejaría el encabezado diciendo un
    // número y su propio detalle diciendo otro.
    const itemsDeLaOT = editandoOtId
      ? checklistOT.filter(c => c.orden_trabajo_id === editandoOtId).map(c => ({ id: c.id, costo: c.costo ?? null }))
      : [];
    const lineasDeLaOT = editandoOtId ? lineas.filter(l => l.orden_trabajo_id === editandoOtId) : [];
    const repartoForm = repartoDeOT(lineasDeLaOT, itemsDeLaOT, formOT.costo_total ? Number(formOT.costo_total) : null);
    const totalDerivado = repartoForm.total;

    const payload = {
      vehiculo_id:    Number(formOT.vehiculo_id),
      plantilla_id:   formOT.plantilla_id ? Number(formOT.plantilla_id) : null,
      km_apertura:    formOT.km_apertura  ? Number(formOT.km_apertura)  : null,
      fecha_apertura: formOT.fecha_apertura,
      fecha_programada: formOT.fecha_programada || null,
      mecanico:       formOT.mecanico.trim()     || null,
      taller_proveedor_id: formOT.taller_proveedor_id ? Number(formOT.taller_proveedor_id) : null,
      taller:         formOT.taller.trim()       || null,
      costo_total:    totalDerivado,
      estado:         formOT.estado,
      observaciones:  formOT.observaciones.trim() || null,
    };

    let otId = editandoOtId;

    if (editandoOtId) {
      await supabase.from("ordenes_trabajo").update(payload).eq("id", editandoOtId);
      // Y el costo BAJA al libro. Sin esto, editar el importe de una OT ya cerrada se quedaba en
      // una columna que no lee nadie más: ni el egreso, ni el margen del servicio, ni el S/km.
      const prev = ordenes.find(o => o.id === editandoOtId);
      const r = await sincronizarLibro({
        id: editandoOtId, estado: payload.estado, km_cierre: prev?.km_cierre ?? null,
        costo_total: totalDerivado, mantenimiento_id: prev?.mantenimiento_id ?? null,
        documento_compra_id: prev?.documento_compra_id ?? null,
      }, repartoForm, facturasDeOT(prev?.documento_compra_id ?? null, lineasDeLaOT));
      if (r.aviso) setAvisoCosto(r.aviso);
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
    // El costo que se asienta es el DERIVADO (líneas, ítems o tecleado), el mismo que enseña la
    // pantalla. Y se asienta REPARTIDO: `costo` lleva solo el desembolso —que es lo que
    // `v_egresos` cuenta— y lo pagado por otra vía va a `costo_imputado`, que no es egreso pero
    // sí costo del vehículo.
    const { reparto: repCierre, facturas: facCierre } = repartoDe(ot);
    const filaLibro: Record<string, unknown> = {
      vehiculo_id: ot.vehiculo_id, fecha: hoy, tipo: "preventivo", kilometraje: km,
      descripcion: `OT #${ot.id}${veh ? " — " + veh.placa : ""}`,
      proveedor: ot.taller || null, costo: repCierre.desembolsado, estado: "finalizado",
      proximo_km: 0, observaciones: ot.observaciones || null,
      costo_imputado: repCierre.imputado,
      documento_compra_id: facCierre.principal,
    };
    let { data: mant, error: eMant } = await supabase.from("mantenimiento").insert(filaLibro).select("id").single();
    if (eMant && /costo_imputado|documento_compra_id/i.test(eMant.message)) {
      // Se sueltan las columnas accesorias antes que perder el asiento entero. Lo que se pierde
      // se dice: sin `costo_imputado`, la mano de obra propia no cuenta para el S/km medido.
      const { costo_imputado: _ci, documento_compra_id: _dc, ...base } = filaLibro;
      const r2 = await supabase.from("mantenimiento").insert(base).select("id").single();
      mant = r2.data; eMant = r2.error;
      if (!eMant && repCierre.imputado > 0) setAvisoCosto(
        "La orden se cerró, pero el costo de casa (mano de obra propia) no llegó al libro: " +
        "falta correr supabase/mantenimiento-06-lineas-de-costo.sql. Hasta entonces no cuenta para el S/km medido.");
    }
    if (eMant) {
      // La OT sí quedó cerrada; que falle el ancla no debe bloquear al usuario, pero
      // sí avisarle — si no, el "próximo mantenimiento" queda desfasado en silencio.
      alert("La OT se cerró, pero no se pudo actualizar el historial de mantenimiento: " + eMant.message);
    }

    // EL ANCLA. Sin este FK, corregir el costo después del cierre no llegaría nunca al egreso:
    // el único vínculo era el texto "OT #N" dentro de la descripción, que nadie puede seguir al
    // revés con seguridad. Si la columna no existe todavía (migración accesoria sin correr), se
    // dice — el costo se queda congelado como antes y hay que saberlo.
    if (mant?.id) {
      const { error: eAncla } = await supabase.from("ordenes_trabajo")
        .update({ mantenimiento_id: Number(mant.id) }).eq("id", ot.id);
      if (eAncla) setAvisoCosto(
        "La orden se cerró y el costo se asentó, pero no quedó amarrada a su fila del libro: " +
        "falta correr supabase/mantenimiento-05-costo-factura-cxp.sql. Hasta entonces, corregir el " +
        "costo después de cerrar no llegará al egreso ni al S/km medido.");
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
              <p class="obs ${it.repuesto ? "" : "linea"}">Repuesto: ${it.repuesto ? esc(it.repuesto) : "________________"} &nbsp;&nbsp; Costo: ${it.costo != null ? "S/ " + Number(it.costo).toFixed(2) : "S/ __________"}</p>
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
    <div class="kv"><span class="lbl">Programado para</span><span class="val">${ot.fecha_programada ? fmtFecha(ot.fecha_programada) : "—"}</span></div>
    <div class="kv"><span class="lbl">Estado</span><span class="val">${esc(ESTADO_OT[ot.estado]?.label || ot.estado)}</span></div>
  </div>
  <div class="box2">
    <div class="kv"><span class="lbl">Taller</span><span class="val">${esc(nombreTaller(ot, talleres) || "—")}</span></div>
    <div class="kv"><span class="lbl">Dirección taller</span><span class="val">${esc((ot.taller_proveedor_id && talleres.find(t => t.id === ot.taller_proveedor_id)?.direccion) || "—")}</span></div>
    <div class="kv"><span class="lbl">Mecánico</span><span class="val">${esc(ot.mecanico || "—")}</span></div>
    <div class="kv"><span class="lbl">Costo</span><span class="val">${ot.costo_total ? fmtSoles(ot.costo_total) : "—"}</span></div>
  </div>
  <div class="box2">
    <div class="kv"><span class="lbl">Plan fabricante</span><span class="val">${plan ? esc(`${plan.marca} ${plan.modelo}${plan.motor ? " · " + plan.motor : ""}`) : "—"}</span></div>
    <div class="kv"><span class="lbl">Intervalo del plan</span><span class="val">${plan ? esc([plan.intervalo_base_km ? Number(plan.intervalo_base_km).toLocaleString("es-PE") + " km" : null, plan.intervalo_base_meses ? plan.intervalo_base_meses + " m" : null].filter(Boolean).join(" / ") || "—") : "—"}</span></div>
    <div class="kv"><span class="lbl">N° serie / chasis</span><span class="val">${esc(veh?.nro_serie || "—")}</span></div>
    <div class="kv"><span class="lbl">Fecha límite sugerida</span><span class="val">${ot.fecha_limite_sugerida ? fmtFecha(ot.fecha_limite_sugerida) : "—"}</span></div>
  </div>
</div>
${ot.observaciones ? `<p style="font-size:10px;color:#64748b;margin:-4px 0 12px"><b>Observaciones:</b> ${esc(ot.observaciones)}</p>` : ""}
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

  /**
   * El costo de un ítem. Vacío escribe `null`, que NO es 0: el total de la orden se deriva de los
   * ítems solo cuando alguien tecleó alguno, y un 0 ("esta revisión no costó nada") sí cuenta.
   * Al guardar se vuelve a derivar el total y se propaga al libro de mantenimiento: si no, el
   * número se quedaría en una columna que no lee nadie más.
   */
  const actualizarCostoItem = async (item: ChecklistOT, texto: string) => {
    const costo = texto.trim() === "" ? null : Number(texto);
    if (costo !== null && !Number.isFinite(costo)) return;
    const r = await guardarCostoItem(item.id, costo);
    if (!r.ok) { alert(r.error); return; }
    const items = checklistOT.map(c => c.id === item.id ? { ...c, costo } : c);
    setChecklistOT(items);
    const ot = ordenes.find(o => o.id === item.orden_trabajo_id);
    if (ot) await propagarTotal(ot, items.filter(c => c.orden_trabajo_id === ot.id));
  };

  /**
   * Deriva el total de la OT y lo manda por la única puerta (`guardarCostoOT`), que además
   * reescribe la fila de `mantenimiento`. Antes esa copia ocurría SOLO al cerrar, así que una OT
   * cerrada en S/ 0.00 se quedaba en cero en el egreso, en el margen del servicio y en el S/km
   * medido de su categoría, aunque el costo se corrigiera después.
   */
  const propagarTotal = async (ot: OrdenTrabajo, items: ChecklistOT[], tecleado?: number | null, lineasNuevas?: LineaGuardada[]) => {
    const ls = (lineasNuevas ?? lineas).filter(l => l.orden_trabajo_id === ot.id);
    const its = items.map(i => ({ id: i.id, costo: i.costo ?? null }));
    const teclea = tecleado !== undefined ? tecleado : ot.costo_total;
    const t = repartoDeOT(ls, its, teclea);
    const r = await guardarCostoOT(
      { id: ot.id, estado: ot.estado, km_cierre: ot.km_cierre ?? null, costo_total: ot.costo_total,
        mantenimiento_id: ot.mantenimiento_id ?? null, documento_compra_id: ot.documento_compra_id ?? null },
      its, teclea, ls);
    if (!r.ok) { alert(r.error); return; }
    setAvisoCosto(r.aviso ?? "");
    setOrdenes(prev => prev.map(o => o.id === ot.id ? { ...o, costo_total: t.total } : o));
  };

  // ── Líneas de costo ────────────────────────────────────────────────────────
  // Una orden la pagan varios bolsillos: el repuesto en un sitio, la mano de obra en otro, y —con
  // mecánico propio— una parte que no sale de la caja. Cada renglón es una línea con su tipo, su
  // origen, su proveedor y su comprobante; el reparto entre egreso e imputado sale de `origen`.

  const guardarLineaOT = async (ot: OrdenTrabajo, datos: Parameters<typeof guardarLinea>[1], lineaId?: number | string | null) => {
    const r = await guardarLinea(ot.id, datos, lineaId);
    if (!r.ok) { alert(r.error); return; }
    const ls = await cargarLineas([ot.id]);
    const nuevas = [...lineas.filter(l => l.orden_trabajo_id !== ot.id), ...ls];
    setLineas(nuevas);
    setLineaEditada(null);
    await propagarTotal(ot, checklistOT.filter(c => c.orden_trabajo_id === ot.id), undefined, nuevas);
  };

  const borrarLineaOT = async (ot: OrdenTrabajo, lineaId: number | string) => {
    if (!confirm("¿Quitar esta línea de costo de la orden?")) return;
    const r = await borrarLinea(lineaId);
    if (!r.ok) { alert(r.error); return; }
    const nuevas = lineas.filter(l => l.id !== lineaId);
    setLineas(nuevas);
    await propagarTotal(ot, checklistOT.filter(c => c.orden_trabajo_id === ot.id), undefined, nuevas);
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
            <Campo label="Programado para (ingreso al taller)">
              <input type="date" className={inputCls()} value={formOT.fecha_programada} onChange={fot("fecha_programada")} />
            </Campo>
            <Campo label="KM al abrir OT">
              <input type="number" className={inputCls("font-mono")} placeholder="Ej: 150000" value={formOT.km_apertura} onChange={fot("km_apertura")} />
            </Campo>
            {/* Si los ítems de esta OT ya llevan costo, el total lo manda la SUMA y este campo se
                bloquea: dejarlo editable invita a teclear un total que no cuadra con su propio
                detalle, y entonces el ERP tendría dos números para el mismo dinero. */}
            {(() => {
              const itemsOT = editandoOtId ? checklistOT.filter(c => c.orden_trabajo_id === editandoOtId) : [];
              const lineasOT = editandoOtId ? lineas.filter(l => l.orden_trabajo_id === editandoOtId) : [];
              const t = repartoDeOT(lineasOT, itemsOT.map(i => ({ id: i.id, costo: i.costo ?? null })), formOT.costo_total ? Number(formOT.costo_total) : null);
              const derivado = t.origen === "items" || t.origen === "lineas";
              return (
                <Campo label={derivado ? "Costo total S/ · derivado" : "Costo total S/"}>
                  <input type="number" className={inputCls()} placeholder="0.00"
                    value={derivado ? t.total.toFixed(2) : formOT.costo_total}
                    onChange={fot("costo_total")} readOnly={derivado}
                    style={derivado ? { background: "#f9fafb", color: "#6b7280" } : undefined} />
                  {derivado && <p className="text-[10px] text-gray-400 mt-1">{t.detalle}</p>}
                </Campo>
              );
            })()}
            <Campo label="Mecánico responsable">
              <input className={inputCls()} placeholder="Nombre del mecánico" value={formOT.mecanico} onChange={fot("mecanico")} />
            </Campo>
            <Campo label="Taller (directorio de Proveedores)">
              <select className={inputCls()} value={formOT.taller_proveedor_id} onChange={fot("taller_proveedor_id")}>
                <option value="">— Sin registrar —</option>
                {talleres.map(t => <option key={t.id} value={t.id}>{t.nombre}{t.telefono ? ` · ${t.telefono}` : ""}</option>)}
              </select>
            </Campo>
            <Campo label="Taller ocasional (si no está en el directorio)">
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
                        {ot.fecha_programada && <> · 📅 {fmtFecha(ot.fecha_programada)}</>}
                        {!ot.fecha_programada && nombreTaller(ot, talleres) && <> · 🏢 {nombreTaller(ot, talleres)}</>}
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
                      <button onClick={() => { setFormOT({ vehiculo_id: String(ot.vehiculo_id || ""), plantilla_id: String(ot.plantilla_id || ""), km_apertura: String(ot.km_apertura || ""), fecha_apertura: ot.fecha_apertura, fecha_programada: ot.fecha_programada || "", mecanico: ot.mecanico || "", taller_proveedor_id: String(ot.taller_proveedor_id || ""), taller: ot.taller || "", costo_total: String(ot.costo_total || ""), estado: ot.estado, observaciones: ot.observaciones || "" }); setEditandoOtId(ot.id); setMostrarFormOT(true); setMostrarFormPl(false); window.scrollTo({ top: 0, behavior: "smooth" }); }}
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
                      {nombreTaller(ot, talleres) && <span className="text-xs text-gray-400">🏢 {nombreTaller(ot, talleres)}</span>}
                      {ot.fecha_programada && (() => {
                        const vencido = (ot.estado === "abierta" || ot.estado === "en_proceso") && new Date(ot.fecha_programada + "T00:00:00") < new Date(new Date().toISOString().split("T")[0] + "T00:00:00");
                        return (
                          <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: vencido ? "#fee2e2" : "#f0fdf4", color: vencido ? "#991b1b" : "#166534" }}>
                            📅 Programado: {fmtFecha(ot.fecha_programada)}
                          </span>
                        );
                      })()}
                      {ot.observaciones && <span className="text-xs text-gray-400 italic">"{ot.observaciones}"</span>}
                    </div>

                    {/* ── COSTO Y FACTURA ──────────────────────────────────────────────
                        El total con su ORIGEN declarado, y el estado de su viaje al libro de
                        mantenimiento — que es la fila que `v_egresos` cuenta, la que cruza
                        `v_costo_servicio` y con la que se mide el S/km de la categoría. */}
                    {(() => {
                      const { reparto: t, lineas: lsOT, facturas } = repartoDe(ot, items);
                      const cerrada = String(ot.estado).toLowerCase() === "cerrada";
                      const sinAncla = cerrada && !ot.mantenimiento_id;
                      return (
                        <div className="rounded-xl border p-3 mb-3" style={{ background: "#fafafa", borderColor: "#e5e7eb" }}>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-wider text-gray-400">Costo de la orden</p>
                              <p className="font-black text-lg" style={{ color: t.origen === "sin_dato" ? "#d1d5db" : "#991b1b" }}>
                                {t.origen === "sin_dato" ? "—" : fmtSoles(t.total)}
                                <span className="ml-2 text-[10px] font-bold uppercase text-gray-400">
                                  {t.origen === "lineas" ? `${lsOT.length} línea(s)` : t.origen === "items" ? `suma de ${t.itemsSueltos} ítem(s)` : t.origen === "tecleado" ? "total tecleado" : "sin costo"}
                                </span>
                              </p>
                            </div>
                            {/* LOS DOS NÚMEROS, CON ETIQUETAS DISTINTAS. El de casa no es egreso —la
                                planilla ya lo pagó— pero sí es costo del vehículo; enseñar solo el
                                total haría creer que salió esa plata de la caja. */}
                            {t.imputado > 0 && (
                              <div className="flex items-center gap-4 px-3 py-1 rounded-lg" style={{ background: "#eff6ff" }}>
                                <div>
                                  <p className="text-[9px] font-black uppercase tracking-wider text-gray-400">Salió de caja</p>
                                  <p className="font-bold text-sm text-red-800">{fmtSoles(t.desembolsado)}</p>
                                </div>
                                <div>
                                  <p className="text-[9px] font-black uppercase tracking-wider text-gray-400">De casa (no es egreso)</p>
                                  <p className="font-bold text-sm text-blue-800">{fmtSoles(t.imputado)}</p>
                                </div>
                              </div>
                            )}
                            <button onClick={() => setFacturaOT({ ot })}
                              className="px-3 py-1.5 rounded-lg text-xs font-bold border hover:bg-white"
                              style={{ borderColor: facturas.ids.length ? "#86efac" : "#e5e7eb", color: facturas.ids.length ? "#166534" : "#374151" }}>
                              {facturas.ids.length
                                ? `🧾 ${facturas.ids.length} factura(s) · CxP ${facturas.ids.map(i => "#" + i).join(" ")}`
                                : "🧾 Registrar factura del taller"}
                            </button>
                            {cerrada && ot.mantenimiento_id && (
                              <span className="text-[11px] text-green-700">✓ Asentado en el libro de mantenimiento</span>
                            )}
                            {!cerrada && (
                              <span className="text-[11px] text-gray-400">El costo entra al libro al cerrar la orden.</span>
                            )}
                          </div>
                          <p className="text-[11px] text-gray-400 mt-1.5">{t.detalle}</p>
                          {facturas.detalle && (
                            <p className="text-[11px] text-gray-500 mt-1">{facturas.detalle}</p>
                          )}

                          {/* ── LÍNEAS DE COSTO ─────────────────────────────────────────
                              Los materiales por un lado y la mano de obra por otro, cada uno con
                              su proveedor y su comprobante. Y la hora del mecánico de casa, que
                              cuenta para el costo del vehículo y NO para el egreso. */}
                          <div className="mt-3 pt-3 border-t" style={{ borderColor: "#e5e7eb" }}>
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-[10px] font-black uppercase tracking-wider text-gray-400">
                                Desglose · materiales, mano de obra y servicios
                              </p>
                              <button onClick={() => setLineaEditada({ otId: ot.id })}
                                className="text-[11px] font-bold px-2.5 py-1 rounded-lg border hover:bg-white" style={{ borderColor: "#e5e7eb" }}>
                                + Agregar línea
                              </button>
                            </div>
                            {lsOT.length === 0 && lineaEditada?.otId !== ot.id && (
                              <p className="text-[11px] text-gray-400">
                                Sin desglose. Úsalo cuando el repuesto se compra en un sitio y la mano de obra se paga en
                                otro, o cuando el trabajo lo hace el mecánico de casa.
                              </p>
                            )}
                            {lsOT.map(l => {
                              const cfg = TIPOS_LINEA.find(x => x.valor === l.tipo);
                              const propia = l.origen === "propio";
                              return (
                                <div key={String(l.id)} className="flex flex-wrap items-center gap-2 py-1.5 border-b last:border-0" style={{ borderColor: "#f1f5f9" }}>
                                  <span className="text-xs">{cfg?.icono ?? "•"}</span>
                                  <span className="text-xs font-medium text-gray-800 flex-1 min-w-[140px]">
                                    {l.concepto || cfg?.label}
                                    {l.horas ? <span className="text-gray-400"> · {l.horas} h × {fmtSoles(l.tarifa_hora ?? 0)}</span> : null}
                                  </span>
                                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg"
                                    style={propia ? { background: "#dbeafe", color: "#1e40af" } : { background: "#f3f4f6", color: "#4b5563" }}>
                                    {propia ? "DE CASA" : "COMPRADO"}
                                  </span>
                                  <span className="text-xs font-bold font-mono" style={{ color: propia ? "#1e40af" : "#991b1b" }}>{fmtSoles(l.monto)}</span>
                                  {!propia && (
                                    <button onClick={() => setFacturaOT({ ot, lineaId: l.id })}
                                      className="text-[10px] font-bold px-2 py-0.5 rounded-lg border hover:bg-white"
                                      style={{ borderColor: l.documento_compra_id ? "#86efac" : "#e5e7eb", color: l.documento_compra_id ? "#166534" : "#6b7280" }}>
                                      {l.documento_compra_id ? `🧾 CxP #${l.documento_compra_id}` : "🧾 Factura"}
                                    </button>
                                  )}
                                  <button onClick={() => setLineaEditada({ otId: ot.id, id: l.id })}
                                    className="text-[11px] text-gray-400 hover:text-gray-700 px-1">✎</button>
                                  <button onClick={() => borrarLineaOT(ot, l.id)}
                                    className="text-[11px] text-gray-300 hover:text-red-500 px-1">✕</button>
                                </div>
                              );
                            })}
                            {lineaEditada?.otId === ot.id && (
                              <FormLinea
                                tarifa={tarifaTaller}
                                talleres={talleres}
                                inicial={lineaEditada.id ? lsOT.find(l => l.id === lineaEditada.id) ?? null : null}
                                onCancelar={() => setLineaEditada(null)}
                                onGuardar={datos => guardarLineaOT(ot, datos, lineaEditada.id ?? null)}
                              />
                            )}
                          </div>
                          {sinAncla && (
                            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-2">
                              ⚠ Esta orden se cerró sin vínculo con el libro de mantenimiento, así que corregir su costo
                              aquí no llega al egreso. Lo repara <b>supabase/mantenimiento-05-costo-factura-cxp.sql</b>;
                              mientras tanto, el importe se corrige en Mantenimiento → Historial.
                            </p>
                          )}
                        </div>
                      );
                    })()}

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
                                <div className="flex items-center gap-2">
                                  <input
                                    className="flex-1 min-w-0 text-xs border-0 bg-transparent text-gray-400 placeholder-gray-300 focus:outline-none"
                                    placeholder="Repuesto/insumo usado (opcional)..."
                                    defaultValue={item.repuesto || ""}
                                    onBlur={e => actualizarRepuesto(item.id, e.target.value)}
                                  />
                                  {/* EL COSTO DEL ÍTEM. El PDF impreso de la OT llevaba desde siempre
                                      un «Costo: S/ ______» aquí, para rellenar a mano; este es ese
                                      campo dentro del ERP. Vacío ≠ 0: ver totalDeOT. */}
                                  <span className="text-[10px] text-gray-300 font-bold">S/</span>
                                  <input type="number" step="0.01" min="0" onClick={e => e.stopPropagation()}
                                    className="w-20 text-xs text-right border-0 border-b border-dashed border-gray-200 bg-transparent text-gray-600 placeholder-gray-300 focus:outline-none focus:border-[#0b315f]"
                                    placeholder="costo"
                                    defaultValue={item.costo ?? ""}
                                    onBlur={e => actualizarCostoItem(item, e.target.value)}
                                  />
                                </div>
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

      {/* Lo que el costo no pudo hacer. Nunca se calla: un importe que parece guardarse y no
          llega al egreso es peor que un error a la cara. */}
      {avisoCosto && (
        <div className="fixed bottom-5 left-5 right-5 md:left-auto md:w-[460px] z-50 rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 shadow-lg">
          <p className="text-xs text-amber-800">⚠ {avisoCosto}</p>
          <button onClick={() => setAvisoCosto("")} className="text-[11px] font-bold text-amber-700 mt-1 hover:underline">Entendido</button>
        </div>
      )}

      {facturaOT && (() => {
        const lineaFac = facturaOT.lineaId ? lineas.find(l => l.id === facturaOT.lineaId) ?? null : null;
        const { reparto, items: itemsFac } = repartoDe(facturaOT.ot);
        return (
          <ModalFacturaTaller
            ot={facturaOT.ot} talleres={talleres} linea={lineaFac} items={itemsFac}
            placa={vehiculos.find(v => v.id === facturaOT.ot.vehiculo_id)?.placa || null}
            // El importe contra el que se coteja la factura es el de la LÍNEA cuando la factura
            // respalda un renglón: comparar la factura del repuesto contra el costo entero de la
            // orden daría un desacuerdo falso cada vez que hay dos proveedores.
            total={lineaFac ? lineaFac.monto : reparto.desembolsado}
            onCerrar={() => setFacturaOT(null)}
            onListo={(aviso) => { setFacturaOT(null); if (aviso) setAvisoCosto(aviso); cargarDatos(); }}
          />
        );
      })()}
    </main>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// LA FACTURA DEL TALLER · entra como COMPROBANTE DE COMPRA, no como gasto
//
// Pedir que «se suba a gastos» habría contado el mismo sol dos veces: `v_egresos` ya suma
// `mantenimiento.costo` con su vehículo y su servicio. Lo que faltaba es el lado FISCAL — el
// comprobante que se aprueba, entra a un lote de pago, se concilia contra el banco y sustenta el
// crédito fiscal del IGV. `documentos_compra` se suma aparte, así que enlazarlo no duplica nada.
// ═══════════════════════════════════════════════════════════════════════════════

function ModalFacturaTaller({ ot, talleres, placa, total, linea, items, onCerrar, onListo }: {
  ot: OrdenTrabajo; talleres: Proveedor[]; placa: string | null; total: number;
  /** La línea que esta factura respalda. Con dos proveedores, el comprobante es del renglón. */
  linea: LineaGuardada | null;
  items: ItemCosto[];
  onCerrar: () => void; onListo: (aviso?: string) => void;
}) {
  const tallerDir = talleres.find(t => t.id === (linea?.proveedor_id ?? ot.taller_proveedor_id)) || null;
  const [f, setF] = useState({
    ruc_emisor: (tallerDir as any)?.ruc || "",
    razon_social: tallerDir?.nombre || ot.taller || "",
    tipo_comprobante: "factura",
    serie: "", numero: "",
    fecha_emision: ot.fecha_cierre || new Date().toISOString().split("T")[0],
    total: "", igv: "",
  });
  const [archivo, setArchivo] = useState<File | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF(p => ({ ...p, [k]: e.target.value }));

  // Se cotejan los DOS números, no se copia uno sobre el otro: el total de la factura lleva IGV y
  // el costo del taller va sin él, porque el IGV se recupera como crédito fiscal y meterlo subiría
  // el S/km de toda la categoría un 18 %.
  const cotejo = cotejarFacturaConOT(total, f.total ? Number(f.total) : null);

  const guardar = async () => {
    setError(""); setGuardando(true);
    const r = await registrarFacturaTaller(
      { id: ot.id, estado: ot.estado, km_cierre: ot.km_cierre ?? null, costo_total: ot.costo_total,
        mantenimiento_id: ot.mantenimiento_id ?? null, documento_compra_id: ot.documento_compra_id ?? null },
      { ruc_emisor: f.ruc_emisor, razon_social: f.razon_social, tipo_comprobante: f.tipo_comprobante,
        serie: f.serie, numero: f.numero, fecha_emision: f.fecha_emision,
        total: Number(f.total || 0), igv: f.igv ? Number(f.igv) : null,
        proveedor_id: linea?.proveedor_id ?? ot.taller_proveedor_id ?? null,
        vehiculo_placa: placa, archivo, linea_id: linea?.id ?? null },
      items);
    setGuardando(false);
    if (!r.ok) { setError(r.error || "No se pudo registrar"); return; }
    onListo(r.accion === "existente"
      ? `Esa factura ya estaba registrada en Cuentas por Pagar (#${r.documento_compra_id}); la orden quedó enlazada a ella en vez de duplicarla.${r.aviso ? " " + r.aviso : ""}`
      : r.aviso);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onCerrar}>
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b">
          <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">
            Factura del taller · OT #{ot.id}{linea ? ` · línea «${linea.concepto || linea.tipo}»` : ""}
          </p>
          <h3 className="font-black text-lg text-[#0b315f]">Registrar como Cuenta por Pagar</h3>
          <p className="text-xs text-gray-400 mt-1">
            Entra a Tesorería → CxP: se aprueba, se paga en lote y se concilia con el banco.
            <b> No duplica el gasto</b> — el egreso de mantenimiento ya se cuenta por la orden.
          </p>
          {linea && (
            <p className="text-[11px] text-gray-500 mt-1.5">
              Se coteja contra los <b>{fmtSoles(total)}</b> de esa línea, no contra el total de la orden:
              con dos proveedores, comparar la factura del repuesto contra el costo entero daría un
              desacuerdo que no existe.
            </p>
          )}
        </div>

        <div className="p-6 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Campo label="RUC del taller *"><input className={inputCls("font-mono")} value={f.ruc_emisor} onChange={set("ruc_emisor")} placeholder="20123456789" /></Campo>
            <Campo label="Tipo">
              <select className={inputCls()} value={f.tipo_comprobante} onChange={set("tipo_comprobante")}>
                <option value="factura">Factura</option>
                <option value="boleta">Boleta</option>
                <option value="recibo_honorarios">Recibo por honorarios</option>
              </select>
            </Campo>
          </div>
          <Campo label="Razón social *"><input className={inputCls()} value={f.razon_social} onChange={set("razon_social")} /></Campo>
          <div className="grid grid-cols-3 gap-3">
            <Campo label="Serie *"><input className={inputCls("font-mono")} value={f.serie} onChange={set("serie")} placeholder="F001" /></Campo>
            <Campo label="Número *"><input className={inputCls("font-mono")} value={f.numero} onChange={set("numero")} placeholder="00025" /></Campo>
            <Campo label="Emisión"><input type="date" className={inputCls()} value={f.fecha_emision} onChange={set("fecha_emision")} /></Campo>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Campo label="Total de la factura S/ *"><input type="number" step="0.01" className={inputCls("font-mono")} value={f.total} onChange={set("total")} /></Campo>
            <Campo label="IGV S/"><input type="number" step="0.01" className={inputCls("font-mono")} value={f.igv} onChange={set("igv")} /></Campo>
          </div>

          {cotejo.codigo === "difiere_igv" && (
            <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">ℹ {cotejo.detalle}</p>
          )}
          {cotejo.codigo === "discrepa" && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">⚠ {cotejo.detalle}</p>
          )}

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Archivo de la factura (PDF o foto)</label>
            <input type="file" accept="image/*,application/pdf" className="text-xs"
              onChange={e => setArchivo(e.target.files?.[0] ?? null)} />
            <p className="text-[10px] text-gray-400 mt-1">
              Se guarda en el bucket privado: una factura trae la placa, el RUC y el domicilio fiscal, así que nunca queda con enlace público.
            </p>
          </div>

          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">⚠ {error}</p>}
        </div>

        <div className="px-6 py-4 border-t flex justify-end gap-3">
          <button onClick={onCerrar} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          <button onClick={guardar} disabled={guardando || !f.ruc_emisor || !f.serie || !f.numero || !f.total}
            className="px-5 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50 hover:opacity-90" style={{ background: "#0b315f" }}>
            {guardando ? "Registrando…" : "Registrar factura"}
          </button>
        </div>
      </div>
    </div>
  );
}
// ═══════════════════════════════════════════════════════════════════════════════
// UNA LÍNEA DE COSTO · qué es, de dónde sale, a quién y con qué papel
//
// Los cuatro datos que antes no existían y que un costo plano no puede contestar: con el
// repuesto comprado en un sitio y la mano de obra pagada en otro, «el costo de la orden» y «la
// factura de la orden» son dos ficciones. Y con mecánico propio hay una parte que NO salió de la
// caja: `origen` es lo único que decide si ese sol entra a `v_egresos` o solo al costo por km.
//
// LA HORA PROPIA SE VALORIZA, NO SE TECLEA. El monto sale de horas × tarifa y la tarifa la
// resuelve `tarifaHoraMecanico` por cascada, con su fuente a la vista: el costo empresa real del
// mecánico cuando su sueldo está configurado, la tarifa de taller si no. Sin ninguna de las dos
// el campo queda bloqueado y se NOMBRA qué llenar — un S/hora inventado se multiplica por las
// horas de cada orden y termina moviendo el precio de venta de una categoría entera.
// ═══════════════════════════════════════════════════════════════════════════════

function FormLinea({ inicial, tarifa, talleres, onGuardar, onCancelar }: {
  inicial: LineaGuardada | null;
  tarifa: TarifaHora | null;
  talleres: Proveedor[];
  onGuardar: (datos: {
    concepto: string; tipo: TipoLinea; origen: OrigenLinea; monto: number;
    horas?: number | null; tarifa_hora?: number | null; tarifa_fuente?: string | null;
    proveedor_id?: number | null;
  }) => void;
  onCancelar: () => void;
}) {
  const [tipo, setTipo]       = useState<TipoLinea>(inicial?.tipo ?? "material");
  const [origen, setOrigen]   = useState<OrigenLinea>(inicial?.origen ?? "comprado");
  const [concepto, setConcepto] = useState(inicial?.concepto ?? "");
  const [monto, setMonto]     = useState(inicial ? String(inicial.monto) : "");
  const [horas, setHoras]     = useState(inicial?.horas != null ? String(inicial.horas) : "");
  const [proveedorId, setProveedorId] = useState(inicial?.proveedor_id ? String(inicial.proveedor_id) : "");

  // Mano de obra de casa: el monto es DERIVADO y el campo va en solo lectura, por lo mismo que
  // el total de la orden cuando hay ítems con costo — dos números para el mismo dinero no.
  const esPropia = origen === "propio" && tipo === "mano_obra";
  // Se valoriza con la tarifa YA resuelta (la cascada corrió en el cargador, una sola vez): así
  // la pantalla no vuelve a decidir cuál de los dos métodos manda.
  const val = esPropia
    ? valorizarManoObraPropia(Number(horas) || 0,
        { tarifa_hora: tarifa?.falta ? null : (tarifa?.tarifa ?? null), mecanico: null, regimen: null, horas_mes: null })
    : null;
  const montoFinal = esPropia ? (val?.monto ?? 0) : Number(monto) || 0;

  const puede = montoFinal > 0 || (!esPropia && monto.trim() !== "");

  return (
    <div className="mt-2 rounded-xl border p-3 space-y-2" style={{ background: "#fff", borderColor: "#c7d2fe" }}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Qué es</label>
          <select className={inputCls("text-xs")} value={tipo} onChange={e => setTipo(e.target.value as TipoLinea)}>
            {TIPOS_LINEA.map(t => <option key={t.valor} value={t.valor}>{t.icono} {t.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">De dónde sale</label>
          <select className={inputCls("text-xs")} value={origen} onChange={e => setOrigen(e.target.value as OrigenLinea)}>
            {ORIGENES_LINEA.map(o => <option key={o.valor} value={o.valor}>{o.label}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Concepto</label>
          <input className={inputCls("text-xs")} value={concepto} onChange={e => setConcepto(e.target.value)}
            placeholder={tipo === "mano_obra" ? "Cambio de embrague" : "Kit de embrague"} />
        </div>
      </div>

      <p className="text-[10px] text-gray-400">{ORIGENES_LINEA.find(o => o.valor === origen)?.ayuda}</p>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {esPropia && (
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Horas</label>
            <input type="number" step="0.5" className={inputCls("text-xs font-mono")} value={horas}
              onChange={e => setHoras(e.target.value)} placeholder="6" />
          </div>
        )}
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">
            {esPropia ? "Monto S/ · derivado" : "Monto S/ (sin IGV)"}
          </label>
          <input type="number" step="0.01" className={inputCls("text-xs font-mono")}
            value={esPropia ? (montoFinal ? montoFinal.toFixed(2) : "") : monto}
            onChange={e => setMonto(e.target.value)} readOnly={esPropia}
            style={esPropia ? { background: "#f9fafb", color: "#6b7280" } : undefined} placeholder="0.00" />
        </div>
        {origen === "comprado" && (
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Proveedor</label>
            <select className={inputCls("text-xs")} value={proveedorId} onChange={e => setProveedorId(e.target.value)}>
              <option value="">— Sin registrar —</option>
              {talleres.map(t => <option key={t.id} value={t.id}>{t.nombre}</option>)}
            </select>
          </div>
        )}
      </div>

      {esPropia && (
        tarifa?.falta
          ? <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">⚠ {tarifa.falta}</p>
          : <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-200 rounded-lg px-2.5 py-1.5">
              S/ {(tarifa?.tarifa ?? 0).toFixed(2)} por hora · {tarifa?.base}
            </p>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={onCancelar} className="px-3 py-1.5 rounded-lg text-xs font-bold border text-gray-600 hover:bg-gray-50">Cancelar</button>
        <button disabled={!puede}
          onClick={() => onGuardar({
            concepto, tipo, origen, monto: montoFinal,
            horas: esPropia ? Number(horas) || 0 : null,
            tarifa_hora: esPropia ? (tarifa?.tarifa ?? null) : null,
            tarifa_fuente: esPropia ? (tarifa?.fuente ?? null) : null,
            proveedor_id: origen === "comprado" && proveedorId ? Number(proveedorId) : null,
          })}
          className="px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-50 hover:opacity-90" style={{ background: "#0b315f" }}>
          {inicial ? "Guardar línea" : "Agregar línea"}
        </button>
      </div>
    </div>
  );
}
