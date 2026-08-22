"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { etiquetaAdmin, etiquetaEstado, etiquetaProveedor } from "@/lib/estados";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import { configCategoriaCC, ESTADOS_REVISION, hoyLima } from "@/lib/finanzas/caja-chica";
import { exportarXlsx, type Columna } from "@/lib/finanzas/exportar";
import type { CostoServicio } from "@/lib/finanzas/tipos";
import VistaCostoServicio, { ChipAdmin, ChipProveedor, margenPct } from "./ModalCostoServicio";

// ─── TIPOS ORIGINALES ─────────────────────────────────────────────────────────

type GastoPropio = {
  id: number; fecha: string; categoria: string; tipo_gasto: string | null;
  descripcion: string; monto: number;
  vehiculo_id: number | null; proveedor_id: number | null;
  reserva_id: number | null; conductor_id: number | null;
  empresa_tercerizada_id: number | null;
  metodo_pago: string; comprobante_url: string | null;
  estado: string; observaciones: string | null;
  documento_compra_id: number | null;
};
type RegCombustible = {
  id: number; fecha: string; vehiculo_id: number | null;
  galones: number; precio_galon: number; total: number;
  grifo: string | null; conductor: string | null;
  tipo_combustible: string | null; unidad: string | null;
  reserva_id: number | null; documento_compra_id: number | null;
};
type RegMantenimiento = {
  id: number; vehiculo_id: number | null; tipo: string | null;
  descripcion: string | null; fecha: string | null;
  costo: number; estado: string | null; proveedor_id: number | null;
  reserva_id: number | null; documento_compra_id: number | null;
};
type RegNeumatico = {
  id: number; vehiculo_id: number | null; marca: string | null;
  medida: string | null; posicion: string | null;
  fecha_instalacion: string | null; costo_compra: number | null;
  estado: string; documento_compra_id: number | null;
};

// ─── TIPOS DE LAS FUENTES NUEVAS (fase 06) ────────────────────────────────────

type RegCajaChica = {
  id: number; rendicion_id: number; fecha: string; categoria: string;
  descripcion: string | null; monto: number; moneda: string;
  vehiculo_id: number | null; reserva_id: number | null; proveedor_id: number | null;
  conductor_id: number | null; estado_revision: string; tipo_comprobante: string | null;
};
type RegGastoGeneral = {
  id: number; codigo: string | null; categoria: string; concepto: string;
  beneficiario_nombre: string; periodo: string | null; fecha: string;
  monto: number; moneda: string;
  vehiculo_id: number | null; reserva_id: number | null; proveedor_id: number | null;
  estado_pago: string; estado_aprobacion: string;
};

/** El servicio con SUS DOS CICLOS (admin = cliente, proveedor = tercero). */
type ReservaCiclo = {
  id: number; codigo: string | null; origen: string; destino: string;
  fecha_servicio: string | null; precio_cliente: number | null;
  estado: string | null; estado_admin: string | null; estado_proveedor: string | null;
  tipo_asignacion: string | null;
  liquidacion_cliente_id: number | null; liquidacion_proveedor_id: number | null;
};

type Vehiculo    = { id: number; placa: string; categoria?: string };
type Proveedor   = { id: number; nombre: string };
type Conductor   = { id: number; nombre: string; tipo_contrato?: string };
type EmpresaTerc = { id: number; razon_social: string };

// ─── TIPO UNIFICADO ───────────────────────────────────────────────────────────

type Fuente = "gasto" | "combustible" | "mantenimiento" | "neumatico" | "caja_chica" | "gasto_general";

type EntradaUnificada = {
  key:          string;
  fuente:       Fuente;
  id:           number;
  fecha:        string;
  categoria:    string;
  descripcion:  string;
  monto:        number;
  vehiculo_id:  number | null;
  reserva_id:   number | null;
  /** Comprobante de compra que respalda el egreso (chip "Con factura"). */
  documento_compra_id: number | null;
  estado:       string;
  editable:     boolean;
  href:         string | null;
  raw:          GastoPropio | RegCombustible | RegMantenimiento | RegNeumatico | RegCajaChica | RegGastoGeneral;
};

// ─── CONFIG ───────────────────────────────────────────────────────────────────

type CatConfig = { label: string; icon: string; color: string; bg: string; tipoGasto: string };

const CATEGORIAS: Record<string, CatConfig> = {
  peajes:             { label: "Peajes",               icon: "🛣️", color: "#7c3aed", bg: "#ede9fe", tipoGasto: "operativo"      },
  viaticos:           { label: "Viáticos",             icon: "🍽️", color: "#0369a1", bg: "#e0f2fe", tipoGasto: "operativo"      },
  estacionamiento:    { label: "Estacionamiento",      icon: "🅿️", color: "#4b5563", bg: "#f3f4f6", tipoGasto: "operativo"      },
  multa:              { label: "Multa / papeleta",     icon: "🚨", color: "#991b1b", bg: "#fee2e2", tipoGasto: "operativo"      },
  conductor_servicio: { label: "Conductor por servicio",icon: "🧑‍✈️",color: "#1d4ed8", bg: "#dbeafe", tipoGasto: "conductor"      },
  pago_tercero:       { label: "Pago empresa terc.",   icon: "🤝", color: "#6d28d9", bg: "#ede9fe", tipoGasto: "tercerizado"    },
  planilla:           { label: "Planilla",             icon: "👥", color: "#166534", bg: "#dcfce7", tipoGasto: "administrativo" },
  seguro:             { label: "Seguro / póliza",      icon: "🛡️", color: "#1d4ed8", bg: "#dbeafe", tipoGasto: "administrativo" },
  impuesto:           { label: "Impuestos / SUNAT",    icon: "🧾", color: "#dc2626", bg: "#fee2e2", tipoGasto: "administrativo" },
  detraccion:         { label: "Detracción",           icon: "🏦", color: "#0b315f", bg: "#eef3f8", tipoGasto: "administrativo" },
  alquiler:           { label: "Alquiler / local",     icon: "🏢", color: "#4b5563", bg: "#f3f4f6", tipoGasto: "administrativo" },
  administrativo:     { label: "Administrativo",       icon: "📋", color: "#4b5563", bg: "#f3f4f6", tipoGasto: "administrativo" },
  otro:               { label: "Otro",                 icon: "💸", color: "#6b7280", bg: "#f9fafb", tipoGasto: "operativo"      },
};

// Categorías de solo lectura (gestionadas desde sus módulos)
const CAT_READONLY: Record<string, CatConfig> = {
  combustible:   { label: "Combustible",   icon: "⛽", color: "#ea580c", bg: "#fff7ed", tipoGasto: "operativo" },
  mantenimiento: { label: "Mantenimiento", icon: "🔧", color: "#854d0e", bg: "#fef9c3", tipoGasto: "operativo" },
  neumaticos:    { label: "Neumáticos",    icon: "🛞", color: "#0f766e", bg: "#f0fdfa", tipoGasto: "operativo" },
};

// Categorías de gastos_generales (espejo del CHECK de la tabla en finanzas-06). No es
// un diccionario de estados de reserva: no colisiona con la regla de @/lib/estados.
const CAT_GG: Record<string, CatConfig> = {
  planilla:        { label: "Planilla",        icon: "👥", color: "#166534", bg: "#dcfce7", tipoGasto: "administrativo" },
  gasto_gerencia:  { label: "Gasto gerencia",  icon: "🧑‍💼", color: "#6d28d9", bg: "#ede9fe", tipoGasto: "administrativo" },
  tercerizado:     { label: "Tercerizado",     icon: "🤝", color: "#6d28d9", bg: "#ede9fe", tipoGasto: "tercerizado"    },
  servicios_fijos: { label: "Servicios fijos", icon: "🏢", color: "#4b5563", bg: "#f3f4f6", tipoGasto: "administrativo" },
  tributos:        { label: "Tributos",        icon: "🧾", color: "#dc2626", bg: "#fee2e2", tipoGasto: "administrativo" },
  mantenimiento:   { label: "Mantenimiento",   icon: "🔧", color: "#854d0e", bg: "#fef9c3", tipoGasto: "operativo"      },
  financiero:      { label: "Financiero",      icon: "🏦", color: "#0b315f", bg: "#eef3f8", tipoGasto: "administrativo" },
  otro:            { label: "Otro",            icon: "📌", color: "#4b5563", bg: "#f3f4f6", tipoGasto: "administrativo" },
};

/** Metadatos de cada fuente: pastilla, filtro, tarjeta KPI y módulo donde se edita. */
const FUENTES: Record<Fuente, { label: string; corto: string; color: string; bg: string; href: string | null }> = {
  gasto:         { label: "💸 Gastos directos",   corto: "Gasto directo",  color: "#4b5563", bg: "#f3f4f6", href: null },
  combustible:   { label: "⛽ Combustible",        corto: "Combustible",    color: "#ea580c", bg: "#fff7ed", href: "/combustible" },
  mantenimiento: { label: "🔧 Mantenimiento",     corto: "Mantenimiento",  color: "#854d0e", bg: "#fef9c3", href: "/mantenimiento?tab=historial" },
  neumatico:     { label: "🛞 Neumáticos",        corto: "Neumático",      color: "#0f766e", bg: "#f0fdfa", href: "/neumaticos" },
  caja_chica:    { label: "🧾 Caja chica",        corto: "Caja chica",     color: "#0f766e", bg: "#f0fdfa", href: "/caja-chica" },
  gasto_general: { label: "🏢 Gastos generales",  corto: "Gasto general",  color: "#6d28d9", bg: "#ede9fe", href: null },
};

const GRUPOS_CAT = {
  "⚙️ Operativos":      ["peajes","viaticos","estacionamiento","multa"],
  "🧑‍✈️ Conductor":      ["conductor_servicio"],
  "🤝 Tercerizado":     ["pago_tercero"],
  "📋 Administrativos": ["planilla","seguro","impuesto","detraccion","alquiler","administrativo","otro"],
};

const METODOS_PAGO = [
  { valor: "efectivo",      label: "💵 Efectivo" },
  { valor: "yape",          label: "💜 Yape" },
  { valor: "plin",          label: "💚 Plin" },
  { valor: "transferencia", label: "🏦 Transferencia" },
  { valor: "bcp",           label: "🔵 BCP" },
  { valor: "bbva",          label: "💙 BBVA" },
  { valor: "tarjeta",       label: "💳 Tarjeta" },
  { valor: "detraccion",    label: "🏛️ Detracción" },
  { valor: "credito",       label: "📅 Crédito" },
  { valor: "otro",          label: "🔄 Otro" },
];

/**
 * Filtro por el punto del CICLO ADMINISTRATIVO del servicio al que está imputado el
 * egreso. Es lo que responde "¿cuánto gasté en servicios ya liquidados?", que antes
 * era imposible porque /gastos ni siquiera leía reservas.estado_admin.
 */
const FILTROS_LIQUIDACION: { valor: string; label: string }[] = [
  { valor: "todos",        label: "Todo el ciclo de liquidación" },
  { valor: "sin_servicio", label: "Sin servicio asignado" },
  { valor: "por_liquidar", label: "Servicio por liquidar" },
  { valor: "liquidada",    label: "Ya liquidado" },
  { valor: "facturada",    label: "Ya facturado" },
  { valor: "cobrada",      label: "Ya cobrado" },
];

/**
 * Formulario en blanco. Es una FUNCIÓN, no una constante de módulo: la fecha por
 * defecto tiene que ser "hoy en Lima" en el instante en que se abre el formulario.
 * Como constante quedaba congelada al cargar el bundle (una pestaña abierta desde
 * ayer proponía la fecha de ayer) y además salía de `toISOString()` crudo, que a
 * partir de las 19:00 de Lima ya devuelve el día siguiente (UTC-5).
 */
function formVacio() {
  return {
    fecha: hoyLima(),
    categoria: "peajes", tipo_gasto: "operativo",
    descripcion: "", monto: "",
    vehiculo_id: "", proveedor_id: "", reserva_id: "",
    conductor_id: "", empresa_tercerizada_id: "",
    metodo_pago: "efectivo", comprobante_url: "",
    estado: "pagado", observaciones: "",
  };
}
type FormGasto = ReturnType<typeof formVacio>;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtFecha(f: string | null) {
  if (!f) return "—";
  // El "T00:00:00" es obligatorio: sin él, `new Date("2026-08-22")` se interpreta como
  // medianoche UTC y en Lima (UTC-5) se muestra el día anterior. El slice(0,10) tolera
  // que una fuente devuelva un timestamptz en vez de un date (si no, "Invalid Date").
  return new Date(String(f).slice(0, 10) + "T00:00:00")
    .toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}
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

function BadgeFuente({ fuente }: { fuente: Fuente }) {
  const cfg = FUENTES[fuente];
  return <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide whitespace-nowrap" style={{ background: cfg.bg, color: cfg.color }}>{cfg.corto}</span>;
}

/** Chip que separa el egreso RESPALDADO por comprobante del que no lo está. */
function BadgeFactura() {
  return (
    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide whitespace-nowrap" style={{ background: "#dbeafe", color: "#1d4ed8" }}>
      🧾 Con factura
    </span>
  );
}

/** Cada fuente trae su propio vocabulario de categorías; aquí se unifican. */
function configCategoria(e: EntradaUnificada): CatConfig {
  if (e.fuente === "caja_chica") {
    const c = configCategoriaCC(e.categoria);
    return { label: c.label, icon: c.emoji, color: c.color, bg: c.bg, tipoGasto: "operativo" };
  }
  if (e.fuente === "gasto_general") return CAT_GG[e.categoria] || CAT_GG.otro;
  return CAT_READONLY[e.categoria] || CATEGORIAS[e.categoria] || CATEGORIAS.otro;
}

const ESTADOS_FILA: Record<string, { bg: string; color: string; label: string }> = {
  pagado:    { bg: "#dcfce7", color: "#166534", label: "Pagado" },
  pendiente: { bg: "#fef9c3", color: "#854d0e", label: "Pendiente" },
  anulado:   { bg: "#fee2e2", color: "#991b1b", label: "Anulado" },
};
function configEstadoFila(estado: string) {
  return ESTADOS_FILA[estado] || ESTADOS_FILA.anulado;
}

type RespuestaSupabase<T> = { data: T[] | null; error: { message: string } | null };

/**
 * Una fuente caída (tabla o vista que todavía no existe en el entorno) no debe tumbar
 * la pantalla entera: se registra en consola y se devuelve vacía.
 */
async function safe<T>(q: PromiseLike<RespuestaSupabase<T>>): Promise<T[]> {
  const r = await q;
  if (r.error) { console.warn(r.error.message); return []; }
  return r.data ?? [];
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function GastosPage() {
  const router = useRouter();

  const [gastosP,    setGastosP]    = useState<GastoPropio[]>([]);
  const [combustible,setCombustible]= useState<RegCombustible[]>([]);
  const [mantenimien,setMantenimien]= useState<RegMantenimiento[]>([]);
  const [neumaticos, setNeumaticos] = useState<RegNeumatico[]>([]);
  const [cajaChica,  setCajaChica]  = useState<RegCajaChica[]>([]);
  const [gastosGen,  setGastosGen]  = useState<RegGastoGeneral[]>([]);
  const [costos,     setCostos]     = useState<CostoServicio[]>([]);
  const [vehiculos,  setVehiculos]  = useState<Vehiculo[]>([]);
  const [proveedores,setProveedores]= useState<Proveedor[]>([]);
  const [reservas,   setReservas]   = useState<ReservaCiclo[]>([]);
  const [conductores,setConductores]= useState<Conductor[]>([]);
  const [empresasTer,setEmpresasTer]= useState<EmpresaTerc[]>([]);
  // Arranca en `true` porque la primera carga se dispara en el efecto de montaje: si
  // naciera en `false` habría un parpadeo de "Sin registros" antes de la primera fila.
  const [loading,    setLoading]    = useState(true);
  const [guardando,  setGuardando]  = useState(false);
  const [exportando, setExportando] = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);
  const [mostrarForm,setMostrarForm]= useState(false);
  const [expandidoKey,setExpandidoKey] = useState<string | null>(null);
  const [vista,      setVista]      = useState<"movimientos" | "rentabilidad">("movimientos");
  const [soloLiquidados, setSoloLiquidados] = useState(false);
  const [busqueda,   setBusqueda]   = useState("");
  const [filtroFuente,setFiltroFuente] = useState("todas");
  const [filtroEst,  setFiltroEst]  = useState("todos");
  const [filtroMes,  setFiltroMes]  = useState("todos");
  const [filtroRes,  setFiltroRes]  = useState("todas");
  const [filtroLiq,  setFiltroLiq]  = useState("todos");
  const [form, setForm] = useState<FormGasto>(formVacio);

  const f = (k: keyof FormGasto) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  const cambiarCategoria = (cat: string) => {
    const cfg = CATEGORIAS[cat] || CATEGORIAS.otro;
    setForm(p => ({ ...p, categoria: cat, tipo_gasto: cfg.tipoGasto }));
  };

  // ── Carga ──────────────────────────────────────────────────────────────────

  // `traerTodo` y `aplicar` van en useCallback con deps vacías (uno solo usa el cliente
  // Supabase de módulo, el otro solo setters, que React garantiza estables) para poder
  // declararlos de verdad como dependencias del efecto de montaje, en vez de silenciar
  // la regla con un eslint-disable.

  /** Las 12 consultas, sin tocar estado de React: solo devuelve datos. */
  const traerTodo = useCallback(() => Promise.all([
      safe<GastoPropio>(supabase.from("gastos").select("*").order("fecha", { ascending: false })),
      safe<RegCombustible>(supabase.from("combustible").select("id,fecha,vehiculo_id,galones,precio_galon,total,grifo,conductor,tipo_combustible,unidad,reserva_id,documento_compra_id").order("fecha", { ascending: false })),
      safe<RegMantenimiento>(supabase.from("mantenimiento").select("id,vehiculo_id,tipo,descripcion,fecha,costo,estado,proveedor_id,reserva_id,documento_compra_id").order("fecha", { ascending: false })),
      safe<RegNeumatico>(supabase.from("neumaticos").select("id,vehiculo_id,marca,medida,posicion,fecha_instalacion,costo_compra,estado,documento_compra_id").order("fecha_instalacion", { ascending: false })),
      // Caja chica: SOLO los gastos que aún NO se promovieron al libro `gastos`
      // (gasto_id null). Es la regla de oro del ERP — contarlos también aquí sería
      // sumar el mismo sol dos veces. Es exactamente el filtro que aplica v_egresos.
      safe<RegCajaChica>(supabase.from("caja_chica_gastos").select("id,rendicion_id,fecha,categoria,descripcion,monto,moneda,vehiculo_id,reserva_id,proveedor_id,conductor_id,estado_revision,tipo_comprobante").is("gasto_id", null).order("fecha", { ascending: false })),
      // Gastos generales: los rechazados por gerencia no son un egreso de la empresa.
      safe<RegGastoGeneral>(supabase.from("gastos_generales").select("id,codigo,categoria,concepto,beneficiario_nombre,periodo,fecha,monto,moneda,vehiculo_id,reserva_id,proveedor_id,estado_pago,estado_aprobacion").neq("estado_aprobacion", "rechazado").order("fecha", { ascending: false })),
      safe<CostoServicio>(supabase.from("v_costo_servicio").select("*").order("fecha_servicio", { ascending: false })),
      safe<Vehiculo>(supabase.from("vehiculos").select("id,placa,categoria").order("placa")),
      safe<Proveedor>(supabase.from("proveedores").select("id,nombre").order("nombre")),
      // El ciclo completo del servicio: sin estado_admin / estado_proveedor no se puede
      // decir a qué altura de la liquidación se imputó cada gasto.
      safe<ReservaCiclo>(supabase.from("reservas").select("id,codigo,origen,destino,fecha_servicio,precio_cliente,estado,estado_admin,estado_proveedor,tipo_asignacion,liquidacion_cliente_id,liquidacion_proveedor_id").order("id", { ascending: false })),
      safe<Conductor>(supabase.from("conductores").select("id,nombre,tipo_contrato").order("nombre")),
      safe<EmpresaTerc>(supabase.from("empresas_tercerizadas").select("id,razon_social").order("razon_social")),
    ]), []);

  const aplicar = useCallback((datos: Awaited<ReturnType<typeof traerTodo>>) => {
    const [gRes, cbRes, mRes, nRes, ccRes, ggRes, csRes, vRes, pRes, rRes, cRes, etRes] = datos;
    setGastosP(gRes);
    setCombustible(cbRes);
    setMantenimien(mRes);
    setNeumaticos(nRes);
    setCajaChica(ccRes);
    setGastosGen(ggRes);
    setCostos(csRes);
    setVehiculos(vRes);
    setProveedores(pRes);
    setReservas(rRes);
    setConductores(cRes);
    setEmpresasTer(etRes);
  }, []);

  /** Recarga desde la UI (tras guardar o eliminar), con su spinner. */
  const cargarDatos = async () => {
    setLoading(true);
    aplicar(await traerTodo());
    setLoading(false);
  };

  // El montaje NO llama a cargarDatos(): eso ejecutaría setLoading(true) de forma
  // síncrona dentro del efecto (react-hooks/set-state-in-effect) y encadenaría un
  // render de más. `loading` ya nace en true, y el guard `vivo` evita escribir estado
  // sobre un componente desmontado si el usuario navega antes de que respondan las
  // 12 consultas.
  useEffect(() => {
    let vivo = true;
    traerTodo().then(datos => {
      if (!vivo) return;
      aplicar(datos);
      setLoading(false);
    });
    return () => { vivo = false; };
  }, [traerTodo, aplicar]);

  // ── Helpers de nombre ──────────────────────────────────────────────────────

  const reservaPorId = useMemo(() => new Map(reservas.map(r => [r.id, r])), [reservas]);

  const nombreVeh   = (id: number | null) => vehiculos.find(v => v.id === id)?.placa || "—";
  const nombreProv  = (id: number | null) => proveedores.find(p => p.id === id)?.nombre || "—";
  const nombreCond  = (id: number | null) => conductores.find(c => c.id === id)?.nombre || "—";
  const nombreEmpT  = (id: number | null) => empresasTer.find(e => e.id === id)?.razon_social || "—";
  const nombreRes   = (id: number | null) => {
    if (id == null) return "—";
    const r = reservaPorId.get(id);
    return r ? `${r.codigo || `#${r.id}`} · ${r.origen} → ${r.destino}` : `#${id}`;
  };
  const codigoRes   = (id: number | null) => {
    if (id == null) return "";
    const r = reservaPorId.get(id);
    return r ? (r.codigo || `#${r.id}`) : `#${id}`;
  };

  // ── Normalizar todo en una sola lista ──────────────────────────────────────
  //
  // El conjunto de filas replica el de la vista v_egresos (supabase/finanzas-06) para
  // que la banda navy de "GASTO TOTAL REAL" cuadre con /finanzas. Si alguna vez se
  // añade o quita una fuente allí, hay que reflejarlo aquí.

  const entradas = useMemo<EntradaUnificada[]>(() => {
    const lista: EntradaUnificada[] = [];

    // 1. Gastos propios (editables desde aquí)
    gastosP.forEach(g => {
      lista.push({
        key: `g-${g.id}`, fuente: "gasto", id: g.id,
        fecha: g.fecha, categoria: g.categoria,
        descripcion: g.descripcion,
        monto: Number(g.monto || 0),
        vehiculo_id: g.vehiculo_id, reserva_id: g.reserva_id,
        documento_compra_id: g.documento_compra_id ?? null,
        estado: g.estado, editable: true,
        href: null, raw: g,
      });
    });

    // 2. Combustible — solo lectura, editar en /combustible.
    //    Desde la fase 06 puede venir atado a un servicio: se lee, ya no se fuerza null.
    combustible.forEach(c => {
      lista.push({
        key: `c-${c.id}`, fuente: "combustible", id: c.id,
        fecha: c.fecha,  categoria: "combustible",
        descripcion: `${c.tipo_combustible || "Diésel"} · ${c.galones} ${c.unidad || "gal"}${c.grifo ? ` · ${c.grifo}` : ""}${c.conductor ? ` · ${c.conductor}` : ""}`,
        monto: Number(c.total || 0),
        vehiculo_id: c.vehiculo_id, reserva_id: c.reserva_id ?? null,
        documento_compra_id: c.documento_compra_id ?? null,
        estado: "pagado", editable: false,
        href: "/combustible", raw: c,
      });
    });

    // 3. Mantenimiento — solo lectura, editar en /mantenimiento. Igual que combustible:
    //    reserva_id se lee de la fila desde la fase 06.
    mantenimien.filter(m => Number(m.costo || 0) > 0).forEach(m => {
      lista.push({
        key: `m-${m.id}`, fuente: "mantenimiento", id: m.id,
        fecha: m.fecha || "", categoria: "mantenimiento",
        descripcion: `${m.tipo || "Mantenimiento"}${m.descripcion ? ` · ${m.descripcion}` : ""}`,
        monto: Number(m.costo || 0),
        vehiculo_id: m.vehiculo_id, reserva_id: m.reserva_id ?? null,
        documento_compra_id: m.documento_compra_id ?? null,
        estado: m.estado || "pagado", editable: false,
        href: "/mantenimiento?tab=historial", raw: m,
      });
    });

    // 4. Neumáticos — solo lectura, editar en /neumaticos (solo si tiene costo).
    //    OJO: reserva_id queda en null A PROPÓSITO. Un neumático es costo de VEHÍCULO
    //    (se amortiza por kilómetro), no de un servicio puntual; la tabla ni siquiera
    //    tiene la columna. No lo "arregles" atándolo a una reserva: inflaría el costo
    //    del viaje que casualmente coincidió con el cambio de llanta.
    neumaticos.filter(n => Number(n.costo_compra || 0) > 0).forEach(n => {
      lista.push({
        key: `n-${n.id}`, fuente: "neumatico", id: n.id,
        fecha: n.fecha_instalacion || "", categoria: "neumaticos",
        descripcion: `${n.marca || "Neumático"}${n.medida ? ` ${n.medida}` : ""}${n.posicion ? ` · Pos. ${n.posicion}` : ""}`,
        monto: Number(n.costo_compra || 0),
        vehiculo_id: n.vehiculo_id, reserva_id: null,
        documento_compra_id: n.documento_compra_id ?? null,
        estado: "pagado", editable: false,
        href: "/neumaticos", raw: n,
      });
    });

    // 5. Caja chica — comprobantes rendidos aún no promovidos al libro `gastos`.
    cajaChica.forEach(cg => {
      const cat = configCategoriaCC(cg.categoria);
      lista.push({
        key: `cc-${cg.id}`, fuente: "caja_chica", id: cg.id,
        fecha: cg.fecha, categoria: cg.categoria,
        descripcion: `${cat.label}${cg.descripcion ? ` · ${cg.descripcion}` : ""} · Rendición #${cg.rendicion_id}`,
        monto: Number(cg.monto || 0),
        vehiculo_id: cg.vehiculo_id, reserva_id: cg.reserva_id ?? null,
        // Un ticket de peaje no genera documento de compra: la evidencia es la foto.
        documento_compra_id: null,
        estado: cg.estado_revision === "aprobado" ? "pagado" : cg.estado_revision === "rechazado" ? "anulado" : "pendiente",
        editable: false,
        href: "/caja-chica", raw: cg,
      });
    });

    // 6. Gastos generales — planilla, alquileres, tributos… el gasto de estructura.
    gastosGen.forEach(gg => {
      lista.push({
        key: `gg-${gg.id}`, fuente: "gasto_general", id: gg.id,
        fecha: gg.fecha, categoria: gg.categoria,
        descripcion: `${gg.concepto} · ${gg.beneficiario_nombre}${gg.periodo ? ` · ${gg.periodo}` : ""}`,
        monto: Number(gg.monto || 0),
        vehiculo_id: gg.vehiculo_id, reserva_id: gg.reserva_id ?? null,
        documento_compra_id: null,
        estado: gg.estado_pago === "pagada" ? "pagado" : "pendiente",
        editable: false,
        href: null, raw: gg,
      });
    });

    // Ordenar por fecha descendente
    return lista.sort((a, b) => {
      if (!a.fecha) return 1; if (!b.fecha) return -1;
      return b.fecha.localeCompare(a.fecha);
    });
  }, [gastosP, combustible, mantenimien, neumaticos, cajaChica, gastosGen]);

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const totalUnificado = entradas.reduce((s, e) => s + e.monto, 0);
  const totalGastosP   = gastosP.reduce((s, g) => s + Number(g.monto || 0), 0);
  const totalCombust   = combustible.reduce((s, c) => s + Number(c.total || 0), 0);
  const totalMant      = mantenimien.reduce((s, m) => s + Number(m.costo || 0), 0);
  const totalNeu       = neumaticos.reduce((s, n) => s + Number(n.costo_compra || 0), 0);
  const totalCC        = cajaChica.reduce((s, c) => s + Number(c.monto || 0), 0);
  const totalGG        = gastosGen.reduce((s, g) => s + Number(g.monto || 0), 0);
  const pendientes     = gastosP.filter(g => g.estado === "pendiente").length;
  const montoPend      = gastosP.filter(g => g.estado === "pendiente").reduce((s, g) => s + Number(g.monto || 0), 0);

  // Meses únicos de todas las entradas
  const mesesUnicos = [...new Set(entradas.map(e => e.fecha?.slice(0, 7)).filter(Boolean))].sort().reverse();

  // ── Filtrado ──────────────────────────────────────────────────────────────

  const filtradas = useMemo(() => entradas.filter(e => {
    const q   = busqueda.toLowerCase();
    const veh = vehiculos.find(v => v.id === e.vehiculo_id);
    const res = e.reserva_id != null ? reservaPorId.get(e.reserva_id) : undefined;
    const txt = `${e.descripcion} ${e.categoria} ${veh?.placa || ""} ${res?.codigo || ""}`.toLowerCase();
    const mes = e.fecha?.slice(0, 7);
    const liqOk =
      filtroLiq === "todos"        ? true :
      filtroLiq === "sin_servicio" ? e.reserva_id === null :
      (res?.estado_admin ?? "") === filtroLiq;
    return txt.includes(q) &&
      (filtroFuente === "todas"   || e.fuente   === filtroFuente) &&
      (filtroEst    === "todos"   || e.estado   === filtroEst) &&
      (filtroMes    === "todos"   || mes        === filtroMes) &&
      (filtroRes    === "todas"   ||
       (filtroRes === "con_reserva" ? e.reserva_id !== null : e.reserva_id === null)) &&
      liqOk;
  }), [entradas, busqueda, filtroFuente, filtroEst, filtroMes, filtroRes, filtroLiq, vehiculos, reservaPorId]);

  const totalFiltrado = filtradas.reduce((s, e) => s + e.monto, 0);

  // Rentabilidad por servicio (v_costo_servicio). El filtro rápido deja solo los
  // servicios ya cerrados del lado del cliente.
  const costosFiltrados = useMemo(
    () => (soloLiquidados ? costos.filter(c => c.liquidado_cliente) : costos),
    [costos, soloLiquidados],
  );

  // Rentabilidad por reserva (gastos propios vinculados a reserva)
  const rentabilidadReservas = useMemo(() => {
    const map: Record<number, { gastos: number; reserva: ReservaCiclo }> = {};
    gastosP.filter(g => g.reserva_id && g.estado !== "anulado").forEach(g => {
      const r = g.reserva_id != null ? reservaPorId.get(g.reserva_id) : undefined;
      if (!r) return;
      if (!map[r.id]) map[r.id] = { gastos: 0, reserva: r };
      map[r.id].gastos += Number(g.monto || 0);
    });
    return Object.values(map).sort((a, b) => b.gastos - a.gastos);
  }, [gastosP, reservaPorId]);

  // ── Exportar a Excel ──────────────────────────────────────────────────────

  const subtituloFiltros = useMemo(() => {
    const partes: string[] = [];
    if (busqueda.trim())        partes.push(`Búsqueda: "${busqueda.trim()}"`);
    if (filtroFuente !== "todas") partes.push(`Fuente: ${FUENTES[filtroFuente as Fuente]?.corto ?? filtroFuente}`);
    if (filtroEst !== "todos")  partes.push(`Estado: ${configEstadoFila(filtroEst).label}`);
    if (filtroMes !== "todos")  partes.push(`Mes: ${filtroMes}`);
    if (filtroRes !== "todas")  partes.push(filtroRes === "con_reserva" ? "Solo con servicio" : "Solo sin servicio");
    if (filtroLiq !== "todos")  partes.push(`Liquidación: ${FILTROS_LIQUIDACION.find(x => x.valor === filtroLiq)?.label ?? filtroLiq}`);
    const base = partes.length ? partes.join(" · ") : "Sin filtros aplicados";
    return `${base} · ${filtradas.length} registros · Total ${fmtMoneda(totalFiltrado)}`;
  }, [busqueda, filtroFuente, filtroEst, filtroMes, filtroRes, filtroLiq, filtradas.length, totalFiltrado]);

  const exportar = async () => {
    setExportando(true);
    try {
      if (vista === "rentabilidad") {
        const columnas: Columna<CostoServicio>[] = [
          { titulo: "Fecha servicio",     valor: c => c.fecha_servicio, tipo: "fecha" },
          { titulo: "Código",             valor: c => c.codigo || `#${c.reserva_id}` },
          { titulo: "Origen",             valor: c => c.origen ?? "" },
          { titulo: "Destino",            valor: c => c.destino ?? "" },
          { titulo: "Tipo",               valor: c => (c.tipo_asignacion === "tercerizado" ? "Tercerizado" : "Propio") },
          { titulo: "Ingreso",            valor: c => Number(c.ingreso || 0), tipo: "monto" },
          { titulo: "Gastos directos",    valor: c => Number(c.costo_gastos || 0), tipo: "monto" },
          { titulo: "Combustible",        valor: c => Number(c.costo_combustible || 0), tipo: "monto" },
          { titulo: "Mantenimiento",      valor: c => Number(c.costo_mantenimiento || 0), tipo: "monto" },
          { titulo: "Caja chica",         valor: c => Number(c.costo_caja_chica || 0), tipo: "monto" },
          { titulo: "Gastos generales",   valor: c => Number(c.costo_gastos_generales || 0), tipo: "monto" },
          { titulo: "Facturado tercero",  valor: c => Number(c.costo_facturado_tercero || 0), tipo: "monto" },
          { titulo: "Costo real",         valor: c => Number(c.costo_real || 0), tipo: "monto" },
          { titulo: "Margen real",        valor: c => Number(c.margen_real || 0), tipo: "monto" },
          // "entero" y no "numero" a propósito: exportarXlsx suma la columna de totales
          // en los tipos monto/numero, y la suma de porcentajes no significa nada. El
          // valor real va completo en la celda; solo se muestra redondeado.
          { titulo: "Margen %",           valor: c => { const p = margenPct(c); return p === null ? "" : p; }, tipo: "entero" },
          { titulo: "N.º de egresos",     valor: c => Number(c.egresos_registrados || 0), tipo: "entero" },
          { titulo: "Estado admin",       valor: c => (c.estado_admin ? etiquetaAdmin(c.estado_admin) : "") },
          { titulo: "Estado proveedor",   valor: c => (c.tipo_asignacion === "tercerizado" && c.estado_proveedor ? etiquetaProveedor(c.estado_proveedor) : "") },
        ];
        await exportarXlsx(costosFiltrados, columnas, {
          nombre: "rentabilidad_por_servicio",
          hoja: "Rentabilidad",
          titulo: "AFA · Rentabilidad por servicio",
          subtitulo: `${soloLiquidados ? "Solo servicios liquidados al cliente" : "Todos los servicios finalizados"} · ${costosFiltrados.length} servicios`,
          totales: true,
        });
        return;
      }

      const columnas: Columna<EntradaUnificada>[] = [
        { titulo: "Fecha",            valor: e => e.fecha, tipo: "fecha" },
        { titulo: "Fuente",           valor: e => FUENTES[e.fuente].corto },
        { titulo: "Categoría",        valor: e => configCategoria(e).label },
        { titulo: "Descripción",      valor: e => e.descripcion, ancho: 44 },
        { titulo: "Vehículo",         valor: e => (e.vehiculo_id ? nombreVeh(e.vehiculo_id) : "") },
        { titulo: "Servicio",         valor: e => codigoRes(e.reserva_id) },
        { titulo: "Fecha servicio",   valor: e => (e.reserva_id != null ? reservaPorId.get(e.reserva_id)?.fecha_servicio ?? "" : ""), tipo: "fecha" },
        { titulo: "Estado admin",     valor: e => { const r = e.reserva_id != null ? reservaPorId.get(e.reserva_id) : undefined; return r?.estado_admin ? etiquetaAdmin(r.estado_admin) : ""; } },
        { titulo: "Estado proveedor", valor: e => { const r = e.reserva_id != null ? reservaPorId.get(e.reserva_id) : undefined; return r?.tipo_asignacion === "tercerizado" && r.estado_proveedor ? etiquetaProveedor(r.estado_proveedor) : ""; } },
        { titulo: "Con factura",      valor: e => (e.documento_compra_id ? "Sí" : "No") },
        { titulo: "Estado",           valor: e => configEstadoFila(e.estado).label },
        { titulo: "Monto",            valor: e => e.monto, tipo: "monto" },
      ];
      await exportarXlsx(filtradas, columnas, {
        nombre: "gastos_vista_unificada",
        hoja: "Gastos",
        titulo: "AFA · Gastos (vista unificada)",
        subtitulo: subtituloFiltros,
        totales: true,
      });
    } finally {
      setExportando(false);
    }
  };

  // ── CRUD (solo para gastos propios) ───────────────────────────────────────

  const limpiar = () => { setForm(formVacio()); setEditandoId(null); setMostrarForm(false); };

  const guardar = async () => {
    if (!form.fecha || !form.descripcion || !form.monto) { alert("Fecha, descripción y monto son obligatorios"); return; }
    setGuardando(true);
    const cfg = CATEGORIAS[form.categoria] || CATEGORIAS.otro;
    const payload = {
      fecha: form.fecha, categoria: form.categoria, tipo_gasto: cfg.tipoGasto,
      descripcion: form.descripcion.trim(), monto: Number(form.monto),
      vehiculo_id:            form.vehiculo_id            ? Number(form.vehiculo_id)            : null,
      proveedor_id:           form.proveedor_id           ? Number(form.proveedor_id)           : null,
      reserva_id:             form.reserva_id             ? Number(form.reserva_id)             : null,
      conductor_id:           form.conductor_id           ? Number(form.conductor_id)           : null,
      empresa_tercerizada_id: form.empresa_tercerizada_id ? Number(form.empresa_tercerizada_id) : null,
      metodo_pago: form.metodo_pago,
      comprobante_url: form.comprobante_url.trim() || null,
      estado: form.estado, observaciones: form.observaciones.trim() || null,
    };
    const { error } = editandoId
      ? await supabase.from("gastos").update(payload).eq("id", editandoId)
      : await supabase.from("gastos").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const editar = (g: GastoPropio) => {
    setForm({
      fecha: g.fecha || "", categoria: g.categoria || "peajes",
      tipo_gasto: g.tipo_gasto || "operativo",
      descripcion: g.descripcion || "", monto: g.monto ? String(g.monto) : "",
      vehiculo_id:            g.vehiculo_id            ? String(g.vehiculo_id)            : "",
      proveedor_id:           g.proveedor_id           ? String(g.proveedor_id)           : "",
      reserva_id:             g.reserva_id             ? String(g.reserva_id)             : "",
      conductor_id:           g.conductor_id           ? String(g.conductor_id)           : "",
      empresa_tercerizada_id: g.empresa_tercerizada_id ? String(g.empresa_tercerizada_id) : "",
      metodo_pago: g.metodo_pago || "efectivo",
      comprobante_url: g.comprobante_url || "",
      estado: g.estado || "pagado", observaciones: g.observaciones || "",
    });
    setEditandoId(g.id); setMostrarForm(true); setVista("movimientos");
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar este gasto?")) return;
    await supabase.from("gastos").delete().eq("id", id);
    cargarDatos();
  };

  // ── Servicio seleccionado en el formulario ────────────────────────────────

  const reservaForm = form.reserva_id ? reservaPorId.get(Number(form.reserva_id)) : undefined;
  // Imputar costo a un servicio ya facturado o cobrado no cambia lo que se le cobró al
  // cliente: la liquidación ya se cerró. El gasto es real, pero se come el margen.
  const servicioCerrado = reservaForm?.estado_admin === "facturada" || reservaForm?.estado_admin === "cobrada";

  const reservasSelect = useMemo(() => {
    const base = reservas.slice(0, 200);
    const sel = Number(form.reserva_id);
    // Al editar un gasto atado a un servicio antiguo, el select debe seguir mostrándolo
    // aunque quede fuera de las 200 reservas más recientes (si no, se perdería el vínculo).
    if (sel && !base.some(r => r.id === sel)) {
      const extra = reservaPorId.get(sel);
      if (extra) return [extra, ...base];
    }
    return base;
  }, [reservas, form.reserva_id, reservaPorId]);

  const etiquetaCicloReserva = (r: ReservaCiclo) =>
    r.estado_admin ? etiquetaAdmin(r.estado_admin) : etiquetaEstado(r.estado);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Gastos</h1>
          <p className="text-gray-400 text-sm mt-1">
            Vista unificada · gastos directos + <span className="text-orange-500 font-bold">⛽ combustible</span> + <span className="text-amber-600 font-bold">🔧 mantenimiento</span> + <span className="text-teal-600 font-bold">🛞 neumáticos</span> + <span className="text-teal-700 font-bold">🧾 caja chica</span> + <span className="text-violet-700 font-bold">🏢 gastos generales</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportar} disabled={exportando}
            className="px-4 py-2.5 rounded-xl font-bold text-sm border transition-all hover:bg-gray-50 disabled:opacity-60"
            style={{ borderColor: "#0b315f", color: "#0b315f" }}>
            {exportando ? "Generando…" : "⬇️ Exportar"}
          </button>
          <button onClick={() => { limpiar(); setVista("movimientos"); setMostrarForm(v => !v); }}
            className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
            style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
            {mostrarForm ? "✕ Cancelar" : "+ Nuevo gasto directo"}
          </button>
        </div>
      </div>

      {/* ALERTA PENDIENTES */}
      {pendientes > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
          ⚠️ <span><b>{pendientes} gasto{pendientes > 1 ? "s" : ""} pendiente{pendientes > 1 ? "s" : ""} de pago</b> · {fmtMoneda(montoPend)}</span>
        </div>
      )}

      {/* KPI GLOBAL */}
      <section className="rounded-2xl border-2 p-4" style={{ background: "#0b315f", borderColor: "#0b315f" }}>
        <p className="text-[10px] font-bold uppercase tracking-widest text-blue-200 mb-1">Gasto total real (todos los módulos)</p>
        <p className="text-4xl font-black text-white">{fmtMoneda(totalUnificado)}</p>
        <p className="text-blue-200 text-xs mt-1">{entradas.length} registros de 6 fuentes · mismo conjunto que v_egresos, cuadra con /finanzas</p>
      </section>

      {/* PESTAÑAS DE VISTA */}
      <div className="flex gap-1 border-b overflow-x-auto">
        {([
          { key: "movimientos",  label: `📄 Movimientos (${entradas.length})` },
          { key: "rentabilidad", label: `📈 Rentabilidad por servicio (${costos.length})` },
        ] as const).map(t => (
          <button key={t.key} onClick={() => setVista(t.key)}
            className="px-4 py-2.5 text-sm font-bold border-b-2 -mb-px transition-all whitespace-nowrap"
            style={{ borderColor: vista === t.key ? "#0b315f" : "transparent", color: vista === t.key ? "#0b315f" : "#9ca3af" }}>
            {t.label}
          </button>
        ))}
      </div>

      {vista === "rentabilidad" ? (
        <VistaCostoServicio
          filas={costosFiltrados}
          loading={loading}
          soloLiquidados={soloLiquidados}
          onSoloLiquidados={setSoloLiquidados}
          totalServicios={costos.length}
        />
      ) : (
      <>

      {/* KPIs POR FUENTE */}
      <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: FUENTES.gasto.label,         valor: totalGastosP, count: gastosP.length,      color: FUENTES.gasto.color,         bg: FUENTES.gasto.bg,         href: FUENTES.gasto.href },
          { label: FUENTES.combustible.label,   valor: totalCombust, count: combustible.length,  color: FUENTES.combustible.color,   bg: FUENTES.combustible.bg,   href: FUENTES.combustible.href },
          { label: FUENTES.mantenimiento.label, valor: totalMant,    count: mantenimien.filter(m => m.costo > 0).length,             color: FUENTES.mantenimiento.color, bg: FUENTES.mantenimiento.bg, href: FUENTES.mantenimiento.href },
          { label: FUENTES.neumatico.label,     valor: totalNeu,     count: neumaticos.filter(n => (n.costo_compra||0) > 0).length,  color: FUENTES.neumatico.color,     bg: FUENTES.neumatico.bg,     href: FUENTES.neumatico.href },
          { label: FUENTES.caja_chica.label,    valor: totalCC,      count: cajaChica.length,    color: FUENTES.caja_chica.color,    bg: FUENTES.caja_chica.bg,    href: FUENTES.caja_chica.href },
          { label: FUENTES.gasto_general.label, valor: totalGG,      count: gastosGen.length,    color: FUENTES.gasto_general.color, bg: FUENTES.gasto_general.bg, href: FUENTES.gasto_general.href },
        ].map(k => (
          <div key={k.label} className={`rounded-xl p-3 border transition-all ${k.href ? "cursor-pointer hover:shadow-md" : ""}`}
            style={{ background: k.bg, borderColor: k.color + "33" }}
            onClick={() => k.href && router.push(k.href)}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-lg font-black mt-0.5" style={{ color: k.color }}>{fmtMoneda(k.valor)}</p>
            <p className="text-[10px] mt-0.5" style={{ color: k.color + "88" }}>
              {k.count} registro{k.count !== 1 ? "s" : ""}
              {k.href && <span className="ml-1">· Ver módulo →</span>}
            </p>
          </div>
        ))}
      </section>

      {/* AVISO MÓDULOS SINCRONIZADOS */}
      <div className="rounded-xl border px-4 py-3 text-xs flex items-start gap-3" style={{ background: "#f0fdf4", borderColor: "#86efac" }}>
        <span className="text-lg mt-0.5">✅</span>
        <div className="text-green-800">
          <b>Sincronización automática activa.</b> Combustible, Mantenimiento, Neumáticos, Caja chica y Gastos generales se leen directamente de sus módulos — sin duplicación. De caja chica solo entran los comprobantes que aún <b>no</b> se promovieron al libro de gastos, para no contar el mismo sol dos veces. Para editar esos registros usa el módulo correspondiente (botón → en cada fila).
        </div>
      </div>

      {/* MARGEN RÁPIDO POR RESERVA (solo gastos directos) */}
      {rentabilidadReservas.length > 0 && (
        <section className="bg-white rounded-2xl border shadow-sm p-5">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
            <h2 className="text-sm font-bold text-gray-700">💰 Margen rápido por reserva (solo gastos directos)</h2>
            <button onClick={() => setVista("rentabilidad")}
              className="px-3 py-1 rounded-lg text-xs font-bold border transition-all hover:bg-gray-50"
              style={{ borderColor: "#0b315f", color: "#0b315f" }}>
              Ver costo real completo →
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {rentabilidadReservas.slice(0, 6).map(d => {
              const precio   = Number(d.reserva.precio_cliente || 0);
              const margen   = precio - d.gastos;
              const margenPctReserva = precio > 0 ? Math.round((margen / precio) * 100) : 0;
              const color    = margen >= 0 ? "#166534" : "#dc2626";
              return (
                <div key={d.reserva.id} className="rounded-xl border px-4 py-3"
                  style={{ borderColor: margen >= 0 ? "#86efac" : "#fca5a5", background: margen >= 0 ? "#f0fdf4" : "#fff5f5" }}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-gray-800 truncate">
                        <span className="font-mono text-[#0b315f]">{d.reserva.codigo || `#${d.reserva.id}`}</span> · {d.reserva.origen} → {d.reserva.destino}
                      </p>
                      <p className="text-[10px] text-gray-400">{fmtFecha(d.reserva.fecha_servicio || null)}</p>
                      <div className="flex gap-1 mt-1 flex-wrap">
                        <ChipAdmin estado={d.reserva.estado_admin} />
                        {d.reserva.tipo_asignacion === "tercerizado" && <ChipProveedor estado={d.reserva.estado_proveedor} />}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-sm font-black" style={{ color }}>
                        {fmtMoneda(margen)} <span className="text-[10px]">({margenPctReserva}%)</span>
                      </p>
                      <p className="text-[10px] text-gray-400">Gastos: {fmtMoneda(d.gastos)}</p>
                    </div>
                  </div>
                  {precio > 0 && (
                    <div className="mt-2 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${Math.min(100, (d.gastos / precio) * 100)}%`, background: margen >= 0 ? "#ef4444" : "#dc2626" }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* FORMULARIO — solo gastos directos */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg"
              style={{ background: CATEGORIAS[form.categoria]?.bg || "#f3f4f6" }}>
              {CATEGORIAS[form.categoria]?.icon || "💸"}
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar gasto" : "Nuevo gasto directo"}</h2>
              <p className="text-xs text-gray-400">
                Para combustible, mantenimiento o neumáticos → registra en sus módulos (se sincronizarán aquí automáticamente)
              </p>
            </div>
          </div>

          {/* Accesos directos a módulos sincronizados */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {[
              { label: "Registrar combustible", icon: "⛽", color: "#ea580c", bg: "#fff7ed", href: "/combustible" },
              { label: "Registrar mantenimiento", icon: "🔧", color: "#854d0e", bg: "#fef9c3", href: "/mantenimiento?tab=historial" },
              { label: "Registrar neumático", icon: "🛞", color: "#0f766e", bg: "#f0fdfa", href: "/neumaticos" },
              { label: "Rendir caja chica", icon: "🧾", color: "#0f766e", bg: "#f0fdfa", href: "/caja-chica" },
            ].map(m => (
              <button key={m.href} onClick={() => router.push(m.href)}
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 transition-all text-left hover:shadow-sm"
                style={{ background: m.bg, borderColor: m.color + "44", color: m.color }}>
                <span className="text-lg">{m.icon}</span>
                <span className="text-[11px] font-bold">{m.label} →</span>
              </button>
            ))}
          </div>

          {/* Categorías del formulario (sin combustible/mantenimiento/neumaticos) */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Tipo de gasto directo</p>
            {Object.entries(GRUPOS_CAT).map(([grupo, cats]) => (
              <div key={grupo} className="mb-3">
                <p className="text-[10px] font-bold uppercase text-gray-400 mb-1.5">{grupo}</p>
                <div className="grid grid-cols-3 md:grid-cols-6 gap-1.5">
                  {cats.map(cat => {
                    const cfg = CATEGORIAS[cat]; const act = form.categoria === cat;
                    return (
                      <button key={cat} onClick={() => cambiarCategoria(cat)}
                        className="flex flex-col items-center gap-1 px-2 py-2 rounded-xl border-2 transition-all text-center"
                        style={{ background: act ? cfg.bg : "white", borderColor: act ? cfg.color : "#e5e7eb", color: act ? cfg.color : "#9ca3af" }}>
                        <span className="text-base">{cfg.icon}</span>
                        <span className="text-[9px] font-bold leading-tight">{cfg.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos del gasto</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Fecha *"><input type="date" className={inputCls()} value={form.fecha} onChange={f("fecha")} /></Campo>
              <Campo label="Monto S/ *"><input type="number" min="0" className={inputCls()} placeholder="0.00" value={form.monto} onChange={f("monto")} /></Campo>
              <Campo label="Estado">
                <select className={inputCls()} value={form.estado} onChange={f("estado")}>
                  <option value="pagado">✅ Pagado</option>
                  <option value="pendiente">⏳ Pendiente</option>
                  <option value="anulado">❌ Anulado</option>
                </select>
              </Campo>
              <Campo label="Descripción *" span={3}><input className={inputCls()} placeholder="Describe el gasto..." value={form.descripcion} onChange={f("descripcion")} /></Campo>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Vincular a</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Reserva / Servicio">
                <select className={inputCls(servicioCerrado ? "border-amber-400 bg-amber-50" : "")} value={form.reserva_id} onChange={f("reserva_id")}>
                  <option value="">Sin reserva</option>
                  {reservasSelect.map(r => (
                    <option key={r.id} value={r.id}>
                      {r.codigo || `#${r.id}`} · {fmtFecha(r.fecha_servicio)} · {r.origen} → {r.destino} · {etiquetaCicloReserva(r)}
                    </option>
                  ))}
                </select>
                {reservaForm && (
                  <p className="text-[10px] text-gray-400 mt-1">
                    Estado del servicio: <b>{etiquetaCicloReserva(reservaForm)}</b>
                    {reservaForm.tipo_asignacion === "tercerizado" && reservaForm.estado_proveedor
                      ? ` · Proveedor: ${etiquetaProveedor(reservaForm.estado_proveedor)}`
                      : ""}
                  </p>
                )}
              </Campo>
              <Campo label="Vehículo">
                <select className={inputCls()} value={form.vehiculo_id} onChange={f("vehiculo_id")}>
                  <option value="">Sin vehículo</option>
                  {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa} · {v.categoria}</option>)}
                </select>
              </Campo>
              <Campo label={form.categoria === "conductor_servicio" ? "🧑‍✈️ Conductor del servicio *" : "Conductor"}>
                <select className={inputCls(form.categoria === "conductor_servicio" ? "border-blue-400 bg-blue-50" : "")}
                  value={form.conductor_id} onChange={f("conductor_id")}>
                  <option value="">Sin conductor</option>
                  {conductores.map(c => <option key={c.id} value={c.id}>{c.nombre}{c.tipo_contrato && c.tipo_contrato !== "planilla" ? ` · ${c.tipo_contrato}` : ""}</option>)}
                </select>
                {form.categoria === "conductor_servicio" && <p className="text-[10px] text-blue-600 mt-1 font-bold">Se descuenta del margen de la reserva</p>}
              </Campo>
              <Campo label={form.categoria === "pago_tercero" ? "🤝 Empresa tercerizada *" : "Empresa tercerizada"}>
                <select className={inputCls(form.categoria === "pago_tercero" ? "border-purple-400 bg-purple-50" : "")}
                  value={form.empresa_tercerizada_id} onChange={f("empresa_tercerizada_id")}>
                  <option value="">Sin empresa</option>
                  {empresasTer.map(e => <option key={e.id} value={e.id}>{e.razon_social}</option>)}
                </select>
              </Campo>
              <Campo label="Proveedor">
                <select className={inputCls()} value={form.proveedor_id} onChange={f("proveedor_id")}>
                  <option value="">Sin proveedor</option>
                  {proveedores.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                </select>
              </Campo>
              <Campo label="Método de pago">
                <select className={inputCls()} value={form.metodo_pago} onChange={f("metodo_pago")}>
                  {METODOS_PAGO.map(m => <option key={m.valor} value={m.valor}>{m.label}</option>)}
                </select>
              </Campo>
            </div>

            {/* Aviso: el servicio ya cerró su ciclo con el cliente */}
            {servicioCerrado && (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm text-amber-800">
                ⚠️
                <span>
                  <b>Este servicio ya está {reservaForm?.estado_admin === "cobrada" ? "cobrado" : "facturado"}:</b> el costo no se reflejará en la
                  liquidación al cliente. Regístralo igual si el gasto es real — se descontará del margen, no de lo facturado.
                </span>
              </div>
            )}

            {/* Preview margen */}
            {form.reserva_id && form.monto && (() => {
              const reserva = reservaForm;
              if (!reserva?.precio_cliente) return null;
              const gastosExist = gastosP.filter(g => g.reserva_id === Number(form.reserva_id) && g.estado !== "anulado" && g.id !== editandoId).reduce((s, g) => s + Number(g.monto || 0), 0);
              const totalConEste = gastosExist + Number(form.monto);
              const margen = Number(reserva.precio_cliente) - totalConEste;
              return (
                <div className="mt-3 rounded-xl px-4 py-3 flex gap-6 items-center flex-wrap" style={{ background: "#eef3f8" }}>
                  <div className="text-xs"><p className="text-gray-400">Precio {reserva.codigo || `#${reserva.id}`}</p><p className="font-black text-gray-800">{fmtMoneda(Number(reserva.precio_cliente))}</p></div>
                  <div className="text-xs"><p className="text-gray-400">Total gastos incl. este</p><p className="font-black text-red-700">{fmtMoneda(totalConEste)}</p></div>
                  <div className="text-xs"><p className="text-gray-400">Margen estimado</p><p className="font-black text-xl" style={{ color: margen >= 0 ? "#166534" : "#dc2626" }}>{fmtMoneda(margen)}</p></div>
                </div>
              );
            })()}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Campo label="URL comprobante"><input className={inputCls()} placeholder="https://..." value={form.comprobante_url} onChange={f("comprobante_url")} /></Campo>
            <Campo label="Observaciones"><input className={inputCls()} placeholder="Notas..." value={form.observaciones} onChange={f("observaciones")} /></Campo>
          </div>

          <div className="flex gap-3">
            <button onClick={guardar} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar" : "Guardar gasto"}
            </button>
            <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* FILTROS */}
      <section className="flex flex-col md:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Buscar por descripción, vehículo, código de servicio..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroFuente} onChange={e => setFiltroFuente(e.target.value)}>
          <option value="todas">Todas las fuentes</option>
          {(Object.keys(FUENTES) as Fuente[]).map(k => <option key={k} value={k}>{FUENTES[k].label}</option>)}
        </select>
        <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroEst} onChange={e => setFiltroEst(e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="pagado">✅ Pagados</option>
          <option value="pendiente">⏳ Pendientes</option>
        </select>
        <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroMes} onChange={e => setFiltroMes(e.target.value)}>
          <option value="todos">Todos los meses</option>
          {mesesUnicos.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroRes} onChange={e => setFiltroRes(e.target.value)}>
          <option value="todas">Con y sin reserva</option>
          <option value="con_reserva">Con reserva</option>
          <option value="sin_reserva">Sin reserva</option>
        </select>
        <select className="border rounded-xl px-3 py-2.5 text-sm" value={filtroLiq} onChange={e => setFiltroLiq(e.target.value)}>
          {FILTROS_LIQUIDACION.map(o => <option key={o.valor} value={o.valor}>{o.label}</option>)}
        </select>
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400 whitespace-nowrap">
          {filtradas.length} · <b className="ml-1 text-gray-700">{fmtMoneda(totalFiltrado)}</b>
        </div>
      </section>

      {/* TABLA UNIFICADA */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <th className="p-3 w-8"></th>
                {["Fecha", "Fuente", "Categoría", "Descripción", "Servicio", "Vehículo", "Monto", "Estado", "Acciones"].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={10} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2"><div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...</div>
                </td></tr>
              ) : filtradas.length === 0 ? (
                <tr><td colSpan={10} className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">💸</p><p>Sin registros</p></td></tr>
              ) : filtradas.map(e => {
                const catCfg   = configCategoria(e);
                const expandido= expandidoKey === e.key;
                const estCfg   = configEstadoFila(e.estado);
                const rowBg    = !e.editable ? "#fafafa" : e.estado === "pendiente" ? "#fffbeb" : "white";
                const res      = e.reserva_id != null ? reservaPorId.get(e.reserva_id) : undefined;

                return (
                  <React.Fragment key={e.key}>
                    <tr className="border-t cursor-pointer hover:brightness-95 transition-all"
                      style={{ background: rowBg, borderColor: "#f1f5f9" }}
                      onClick={() => setExpandidoKey(expandido ? null : e.key)}>
                      <td className="p-3 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>
                      <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">{fmtFecha(e.fecha)}</td>
                      <td className="p-3"><BadgeFuente fuente={e.fuente} /></td>
                      <td className="p-3">
                        <span className="text-xs font-bold px-2 py-0.5 rounded-lg whitespace-nowrap" style={{ background: catCfg.bg, color: catCfg.color }}>
                          {catCfg.icon} {catCfg.label}
                        </span>
                      </td>
                      <td className="p-3 text-xs text-gray-700 max-w-[200px]">
                        <div className="truncate">{e.descripcion}</div>
                        {e.documento_compra_id && <div className="mt-1"><BadgeFactura /></div>}
                      </td>
                      {/* SERVICIO: el enganche gasto ↔ servicio ejecutado y liquidado */}
                      <td className="p-3">
                        {res ? (
                          <div className="min-w-0">
                            <p className="font-mono font-black text-xs text-[#0b315f] leading-tight">{res.codigo || `#${res.id}`}</p>
                            <p className="text-[10px] text-gray-400">{fmtFecha(res.fecha_servicio)}</p>
                            <div className="flex gap-1 mt-0.5 flex-wrap">
                              <ChipAdmin estado={res.estado_admin} />
                              {res.tipo_asignacion === "tercerizado" && <ChipProveedor estado={res.estado_proveedor} />}
                            </div>
                          </div>
                        ) : e.reserva_id != null ? (
                          <span className="font-mono text-xs text-gray-400">#{e.reserva_id}</span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="p-3 text-xs text-gray-500">{e.vehiculo_id ? nombreVeh(e.vehiculo_id) : "—"}</td>
                      <td className="p-3 font-black text-red-700 whitespace-nowrap">{fmtMoneda(e.monto)}</td>
                      <td className="p-3">
                        <span className="text-xs font-bold px-2.5 py-1 rounded-lg" style={{ background: estCfg.bg, color: estCfg.color }}>{estCfg.label}</span>
                      </td>
                      <td className="p-3" onClick={ev => ev.stopPropagation()}>
                        {e.editable ? (
                          <div className="flex gap-1.5">
                            <button onClick={() => editar(e.raw as GastoPropio)}
                              className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                            <button onClick={() => eliminar(e.id)}
                              className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                          </div>
                        ) : e.href ? (
                          <button onClick={() => router.push(e.href as string)}
                            className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-600">
                            Editar en módulo →
                          </button>
                        ) : (
                          <span className="text-xs text-gray-300">—</span>
                        )}
                      </td>
                    </tr>

                    {/* FILA EXPANDIDA */}
                    {expandido && (
                      <tr style={{ background: "#f8fafc" }} className="border-t">
                        <td colSpan={10} className="px-6 py-4">
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-xs">
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Detalle</p>
                              <p><span className="text-gray-400">Fuente:</span> <BadgeFuente fuente={e.fuente} /></p>
                              <p><span className="text-gray-400">Fecha:</span> {fmtFecha(e.fecha)}</p>
                              <p><span className="text-gray-400">Categoría:</span> {catCfg.icon} <b>{catCfg.label}</b></p>
                              <p><span className="text-gray-400">Descripción:</span> {e.descripcion}</p>
                              <p><span className="text-gray-400">Vehículo:</span> {e.vehiculo_id ? nombreVeh(e.vehiculo_id) : "—"}</p>
                              <p><span className="text-gray-400">Respaldo:</span> {e.documento_compra_id ? <b className="text-blue-700">Comprobante de compra #{e.documento_compra_id}</b> : "Sin factura registrada"}</p>
                            </div>

                            {/* Datos específicos por fuente */}
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">
                                {e.fuente === "gasto" ? "Vínculos" : "Datos del módulo"}
                              </p>
                              {res && (
                                <p>🎫 <b>{nombreRes(res.id)}</b> · <ChipAdmin estado={res.estado_admin} />
                                  {res.tipo_asignacion === "tercerizado" && <> <ChipProveedor estado={res.estado_proveedor} /></>}
                                </p>
                              )}
                              {e.fuente === "gasto" && (() => {
                                const g = e.raw as GastoPropio;
                                return <>
                                  {g.conductor_id && <p>🧑‍✈️ <b>{nombreCond(g.conductor_id)}</b></p>}
                                  {g.empresa_tercerizada_id && <p>🤝 <b>{nombreEmpT(g.empresa_tercerizada_id)}</b></p>}
                                  {g.proveedor_id && <p>🏢 <b>{nombreProv(g.proveedor_id)}</b></p>}
                                  <p><span className="text-gray-400">Método:</span> {METODOS_PAGO.find(m => m.valor === g.metodo_pago)?.label || g.metodo_pago}</p>
                                  {g.comprobante_url && <a href={g.comprobante_url} target="_blank" rel="noreferrer" className="text-blue-500 font-bold underline">📄 Comprobante</a>}
                                </>;
                              })()}
                              {e.fuente === "combustible" && (() => {
                                const c = e.raw as RegCombustible;
                                return <>
                                  <p><span className="text-gray-400">Tipo:</span> {c.tipo_combustible || "Diésel"}</p>
                                  <p><span className="text-gray-400">Cantidad:</span> {c.galones} {c.unidad || "gal"}</p>
                                  <p><span className="text-gray-400">Precio/{c.unidad || "gal"}:</span> {fmtMoneda(c.precio_galon)}</p>
                                  {c.grifo && <p><span className="text-gray-400">Grifo:</span> {c.grifo}</p>}
                                  {c.conductor && <p><span className="text-gray-400">Conductor:</span> {c.conductor}</p>}
                                </>;
                              })()}
                              {e.fuente === "mantenimiento" && (() => {
                                const m = e.raw as RegMantenimiento;
                                return <>
                                  <p><span className="text-gray-400">Tipo:</span> {m.tipo}</p>
                                  {m.descripcion && <p><span className="text-gray-400">Detalle:</span> {m.descripcion}</p>}
                                  {m.proveedor_id && <p><span className="text-gray-400">Proveedor:</span> {nombreProv(m.proveedor_id)}</p>}
                                  <p><span className="text-gray-400">Estado:</span> {m.estado}</p>
                                </>;
                              })()}
                              {e.fuente === "neumatico" && (() => {
                                const n = e.raw as RegNeumatico;
                                return <>
                                  <p><span className="text-gray-400">Marca:</span> {n.marca}</p>
                                  {n.medida && <p><span className="text-gray-400">Medida:</span> {n.medida}</p>}
                                  {n.posicion && <p><span className="text-gray-400">Posición:</span> {n.posicion}</p>}
                                  <p><span className="text-gray-400">Estado:</span> {n.estado}</p>
                                  <p className="text-gray-400 italic">Costo de vehículo: no se imputa a un servicio.</p>
                                </>;
                              })()}
                              {e.fuente === "caja_chica" && (() => {
                                const cg = e.raw as RegCajaChica;
                                return <>
                                  <p><span className="text-gray-400">Rendición:</span> #{cg.rendicion_id}</p>
                                  <p><span className="text-gray-400">Revisión:</span> {ESTADOS_REVISION[cg.estado_revision as keyof typeof ESTADOS_REVISION]?.label ?? cg.estado_revision}</p>
                                  {cg.tipo_comprobante && <p><span className="text-gray-400">Comprobante:</span> {cg.tipo_comprobante}</p>}
                                  {cg.conductor_id && <p><span className="text-gray-400">Conductor:</span> {nombreCond(cg.conductor_id)}</p>}
                                  {cg.proveedor_id && <p><span className="text-gray-400">Proveedor:</span> {nombreProv(cg.proveedor_id)}</p>}
                                </>;
                              })()}
                              {e.fuente === "gasto_general" && (() => {
                                const gg = e.raw as RegGastoGeneral;
                                return <>
                                  {gg.codigo && <p><span className="text-gray-400">Código:</span> <b className="font-mono text-[#0b315f]">{gg.codigo}</b></p>}
                                  <p><span className="text-gray-400">Beneficiario:</span> {gg.beneficiario_nombre}</p>
                                  {gg.periodo && <p><span className="text-gray-400">Periodo:</span> {gg.periodo}</p>}
                                  <p><span className="text-gray-400">Aprobación:</span> {gg.estado_aprobacion}</p>
                                  <p><span className="text-gray-400">Pago:</span> {gg.estado_pago}</p>
                                </>;
                              })()}
                            </div>

                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Monto y acción</p>
                              <p className="text-2xl font-black text-red-700">{fmtMoneda(e.monto)}</p>
                              {!e.editable && e.href && (
                                <button onClick={() => router.push(e.href as string)}
                                  className="mt-2 px-4 py-2 rounded-xl text-xs font-bold text-white w-full"
                                  style={{ background: "#0b315f" }}>
                                  Editar en {FUENTES[e.fuente].corto} →
                                </button>
                              )}
                              {res && (() => {
                                // Margen del servicio leído de v_costo_servicio cuando está
                                // disponible: es el costo REAL (todas las fuentes), no solo
                                // los gastos directos.
                                const costo = costos.find(c => c.reserva_id === res.id);
                                if (costo) {
                                  const m = Number(costo.margen_real || 0);
                                  return (
                                    <div className="mt-2 rounded-lg px-3 py-2" style={{ background: m >= 0 ? "#dcfce7" : "#fee2e2" }}>
                                      <p className="text-[9px] font-bold uppercase text-gray-400">Margen real {costo.codigo || `#${costo.reserva_id}`}</p>
                                      <p className="font-black" style={{ color: m >= 0 ? "#166534" : "#dc2626" }}>{fmtMoneda(m)}</p>
                                      <p className="text-[9px] text-gray-500">{costo.egresos_registrados} egreso(s) · costo {fmtMoneda(Number(costo.costo_real || 0))}</p>
                                    </div>
                                  );
                                }
                                if (!res.precio_cliente) return null;
                                const gastosRes = gastosP.filter(g => g.reserva_id === res.id && g.estado !== "anulado").reduce((s, g) => s + Number(g.monto || 0), 0);
                                const margen = Number(res.precio_cliente) - gastosRes;
                                return (
                                  <div className="mt-2 rounded-lg px-3 py-2" style={{ background: margen >= 0 ? "#dcfce7" : "#fee2e2" }}>
                                    <p className="text-[9px] font-bold uppercase text-gray-400">Margen estimado {res.codigo || `#${res.id}`}</p>
                                    <p className="font-black" style={{ color: margen >= 0 ? "#166534" : "#dc2626" }}>{fmtMoneda(margen)}</p>
                                    <p className="text-[9px] text-gray-500">Solo gastos directos</p>
                                  </div>
                                );
                              })()}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
          <span>{filtradas.length} de {entradas.length} registros · Total visible: <b className="text-gray-700">{fmtMoneda(totalFiltrado)}</b></span>
          <span>AFA ERP · Finanzas · Vista unificada</span>
        </div>
      </section>
      </>
      )}
    </main>
  );
}
