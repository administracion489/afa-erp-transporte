"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { paginarFilas } from "@/lib/huella";
import OdometroTerceroModal from "./_components/OdometroTerceroModal";
import { DISTRITOS_LIMA, distanciaDistritos, etiquetaDistancia } from "@/lib/distritos-lima";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Empresa = {
  id: number; razon_social: string; ruc: string | null;
  telefono: string | null; email: string | null;
  contacto_nombre: string | null; contacto_telefono: string | null;
  autorizacion_mtc: string | null; habilitacion_sutran: string | null;
  venc_autorizacion: string | null; venc_habilitacion: string | null;
  estado: string; observaciones?: string | null; created_at?: string;
  direccion_fiscal?: string | null; distrito_fiscal?: string | null;
  direccion_cochera?: string | null; distrito_cochera?: string | null;
  lat_cochera?: number | null; lng_cochera?: number | null;
};

type VehiculoTercero = {
  id: number; empresa_id: number; placa: string;
  categoria: string | null; marca: string | null; modelo: string | null;
  capacidad: number | null; estado: string;
  foto_externa_url?: string | null; foto_interna_url?: string | null;
  descripcion_unidad?: string | null;
  tipo_vehiculo_costeo?: string | null;
  kilometraje_actual?: number | null;
  direccion_cochera?: string | null; distrito_cochera?: string | null; // override — si es null, usa el de la empresa
};

type ParamVeh = { tipo_vehiculo: string; nombre: string; grupo_vehiculo: string | null };

type ConductorTercero = {
  id: number; empresa_id: number; nombre: string; dni: string | null;
  licencia: string | null; categoria_licencia: string | null;
  vencimiento_licencia: string | null; telefono: string | null; email?: string | null;
  estado?: string; pin_acceso?: string | null; activo_app?: boolean | null;
};

type DocumentoTercero = {
  id: number; empresa_id: number; vehiculo_id: number | null;
  tipo: string; numero?: string | null;
  fecha_vencimiento: string | null; entidad_emisora?: string | null;
  archivo_url?: string | null; observaciones?: string | null;
};

type TabActiva = "flota" | "conductores" | "documentos";
type Nivel = "alto" | "medio" | "ok";

// Detalle completo de UNA empresa, cacheado en memoria. El índice global es ligero
// (sin fotos ni descripciones) para aguantar miles de unidades; esto se trae recién
// cuando el operador abre la ficha.
type DetalleEmpresa = {
  vehs: VehiculoTercero[];
  conds: ConductorTercero[];
  docs: DocumentoTercero[];
  sosp: Record<number, number>;   // vehiculo_tercero_id → lecturas de odómetro por revisar
};

// ─── TIPOS DOC ────────────────────────────────────────────────────────────────

const TIPOS_DOC_TERCERO: Record<string, { icon: string; obligatorio: boolean }> = {
  "SOAT":                     { icon: "🚗", obligatorio: true  },
  "Revisión Técnica (CITV)":  { icon: "🔍", obligatorio: true  },
  "Habilitación SUTRAN":      { icon: "✅", obligatorio: true  },
  "Permiso Operación MTC":    { icon: "🏛️", obligatorio: true  },
  "Tarjeta de Propiedad":     { icon: "📋", obligatorio: true  },
  "SCTR Salud":               { icon: "🏥", obligatorio: true  },
  "SCTR Pensión":             { icon: "💼", obligatorio: true  },
  "Seguro Todo Riesgo":       { icon: "🛡️", obligatorio: false },
  "Responsabilidad Civil":    { icon: "⚖️", obligatorio: false },
  "Otro":                     { icon: "📄", obligatorio: false },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function diasPara(f: string | null): number | null {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
}
function estadoDoc(f: string | null): "vigente" | "por_vencer" | "vencido" | "sin_fecha" {
  const d = diasPara(f);
  if (d === null) return "sin_fecha";
  if (d < 0)    return "vencido";
  if (d <= 30)  return "por_vencer";
  return "vigente";
}
function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
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

// Normalización de texto para buscar: sin tildes, sin mayúsculas.
const norm = (s: string | null | undefined) =>
  (s || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Normalización de PLACA: "abc-123", "ABC 123" y "abc.123" son la MISMA unidad. Se compara
// con includes() y no con startsWith(): de una foto de WhatsApp a veces solo se leen los
// últimos dígitos.
const normPlaca = (s: string | null | undefined) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Teléfono a E.164 asumiendo Perú (misma regla que lib/notificaciones.ts) para los wa.me.
const telE164 = (t: string | null | undefined) => {
  const d = (t || "").replace(/\D/g, "");
  if (!d) return "";
  return d.length === 9 ? "51" + d : d;
};

const ESTADO_DOC_CFG = {
  vigente:    { label: "Vigente",    bg: "#dcfce7", color: "#166534", dot: "#16a34a" },
  por_vencer: { label: "Por vencer", bg: "#fef9c3", color: "#854d0e", dot: "#eab308" },
  vencido:    { label: "Vencido",    bg: "#fee2e2", color: "#991b1b", dot: "#dc2626" },
  sin_fecha:  { label: "Sin fecha",  bg: "#f3f4f6", color: "#4b5563", dot: "#9ca3af" },
};

const NIVEL_CFG: Record<Nivel, { label: string; bg: string; color: string; borde: string; icono: string }> = {
  alto:  { label: "NO ASIGNAR", bg: "#fee2e2", color: "#991b1b", borde: "#dc2626", icono: "🚨" },
  medio: { label: "REVISAR",    bg: "#fef9c3", color: "#854d0e", borde: "#eab308", icono: "⚠️" },
  ok:    { label: "APTO",       bg: "#dcfce7", color: "#166534", borde: "#16a34a", icono: "✅" },
};

const OBLIGATORIOS = Object.entries(TIPOS_DOC_TERCERO).filter(([, v]) => v.obligatorio).map(([k]) => k);

// Riesgo de la EMPRESA: documentos obligatorios vencidos/por vencer, licencias y las
// habilitaciones propias de la empresa (MTC/SUTRAN), que antes no entraban al semáforo.
function calcRiesgo(docs: DocumentoTercero[], conductores: ConductorTercero[], emp?: Empresa | null): Nivel {
  if (emp && emp.estado === "suspendido") return "alto";
  const docVencidos = docs.filter(d => estadoDoc(d.fecha_vencimiento) === "vencido" &&
    TIPOS_DOC_TERCERO[d.tipo]?.obligatorio).length;
  const licVencidas = conductores.filter(c => {
    const d = diasPara(c.vencimiento_licencia);
    return d !== null && d < 0;
  }).length;
  const habVencidas = emp
    ? [emp.venc_autorizacion, emp.venc_habilitacion].filter(f => estadoDoc(f) === "vencido").length
    : 0;
  if (docVencidos > 0 || licVencidas > 0 || habVencidas > 0) return "alto";
  const docPorV = docs.filter(d => estadoDoc(d.fecha_vencimiento) === "por_vencer" &&
    TIPOS_DOC_TERCERO[d.tipo]?.obligatorio).length;
  const licPorV = conductores.filter(c => {
    const d = diasPara(c.vencimiento_licencia);
    return d !== null && d >= 0 && d <= 30;
  }).length;
  const habPorV = emp
    ? [emp.venc_autorizacion, emp.venc_habilitacion].filter(f => estadoDoc(f) === "por_vencer").length
    : 0;
  if (docPorV > 0 || licPorV > 0 || habPorV > 0) return "medio";
  return "ok";
}

// PUNTO CIEGO HISTÓRICO: calcRiesgo solo castiga documentos REGISTRADOS y vencidos, así que
// un proveedor que nunca cargó su SOAT salía ✅ verde. Esto lo detecta, pero como dimensión
// aparte (chip "Sin documentos") para no teñir de rojo a toda la cartera.
function docsObligFaltantes(docs: DocumentoTercero[]): string[] {
  const presentes = new Set(docs.map(d => d.tipo));
  return OBLIGATORIOS.filter(t => !presentes.has(t));
}

// Veredicto de UNA unidad, en una frase con causa concreta: es lo que el operador
// responde por WhatsApp. Cruza documentos del propio vehículo + documentos generales de
// la empresa + habilitaciones y estado de la empresa.
function calcAptitud(
  veh: { id: number } | null,
  emp: Empresa | undefined,
  docsEmp: DocumentoTercero[],
  conds: ConductorTercero[],
): { nivel: Nivel; causa: string } {
  if (!emp) return { nivel: "medio", causa: "Proveedor no encontrado" };
  if (emp.estado === "suspendido") return { nivel: "alto", causa: "Proveedor suspendido" };
  if (emp.estado === "inactivo")   return { nivel: "alto", causa: "Proveedor inactivo" };

  // Documentos que aplican: los del propio vehículo + los generales de la empresa.
  const aplican = docsEmp.filter(d => !veh || d.vehiculo_id === null || d.vehiculo_id === veh.id);

  type Cand = { nivel: Nivel; dias: number; texto: string };
  const cands: Cand[] = [];

  for (const d of aplican) {
    if (!TIPOS_DOC_TERCERO[d.tipo]?.obligatorio) continue;
    const est = estadoDoc(d.fecha_vencimiento);
    const dias = diasPara(d.fecha_vencimiento);
    if (est === "vencido" && dias !== null) cands.push({ nivel: "alto",  dias, texto: `${d.tipo} vencido hace ${Math.abs(dias)} d` });
    if (est === "por_vencer" && dias !== null) cands.push({ nivel: "medio", dias, texto: `${d.tipo} vence en ${dias} d` });
    if (est === "sin_fecha") cands.push({ nivel: "medio", dias: 9999, texto: `${d.tipo} sin fecha de vencimiento` });
  }
  for (const h of [
    { label: "Autorización MTC", f: emp.venc_autorizacion },
    { label: "Habilitación SUTRAN", f: emp.venc_habilitacion },
  ]) {
    const est = estadoDoc(h.f);
    const dias = diasPara(h.f);
    if (est === "vencido" && dias !== null) cands.push({ nivel: "alto",  dias, texto: `${h.label} vencida hace ${Math.abs(dias)} d` });
    if (est === "por_vencer" && dias !== null) cands.push({ nivel: "medio", dias, texto: `${h.label} vence en ${dias} d` });
  }
  const licVenc = conds.filter(c => { const d = diasPara(c.vencimiento_licencia); return d !== null && d < 0; });
  if (licVenc.length > 0) cands.push({ nivel: "alto", dias: 0, texto: `${licVenc.length} licencia${licVenc.length > 1 ? "s" : ""} de conductor vencida${licVenc.length > 1 ? "s" : ""}` });

  const altos = cands.filter(c => c.nivel === "alto").sort((a, b) => a.dias - b.dias);
  if (altos.length) return { nivel: "alto", causa: altos[0].texto };
  const medios = cands.filter(c => c.nivel === "medio").sort((a, b) => a.dias - b.dias);
  if (medios.length) return { nivel: "medio", causa: medios[0].texto };

  const faltan = docsObligFaltantes(aplican);
  if (faltan.length >= OBLIGATORIOS.length) return { nivel: "medio", causa: "Sin documentos cargados" };
  if (faltan.length > 0) return { nivel: "medio", causa: `Faltan ${faltan.length} documento${faltan.length > 1 ? "s" : ""} obligatorio${faltan.length > 1 ? "s" : ""}` };
  return { nivel: "ok", causa: "Sin vencimientos próximos" };
}

const FORM_EMP = {
  razon_social: "", ruc: "", telefono: "", email: "",
  contacto_nombre: "", contacto_telefono: "",
  autorizacion_mtc: "", habilitacion_sutran: "",
  venc_autorizacion: "", venc_habilitacion: "",
  estado: "activo", observaciones: "",
  direccion_fiscal: "", distrito_fiscal: "",
  direccion_cochera: "", distrito_cochera: "",
};
const FORM_VEH = { placa: "", categoria: "BUS", marca: "", modelo: "", capacidad: "", estado: "disponible", foto_externa_url: "", foto_interna_url: "", descripcion_unidad: "", tipo_vehiculo_costeo: "", distrito_cochera: "" };
const FORM_COND = { nombre: "", dni: "", licencia: "", categoria_licencia: "A-IIb", vencimiento_licencia: "", telefono: "", email: "", estado: "disponible", pin_acceso: "", activo_app: false };
const FORM_DOC = { vehiculo_id: "", tipo: "SOAT", numero: "", fecha_vencimiento: "", entidad_emisora: "", archivo_url: "", observaciones: "" };

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function EmpresasTercerizadasPage() {
  // Índice ligero global: alimenta la lista, los contadores y la búsqueda instantánea.
  const [empresas,   setEmpresas]   = useState<Empresa[]>([]);
  const [vehIdx,     setVehIdx]     = useState<VehiculoTercero[]>([]);
  const [condIdx,    setCondIdx]    = useState<ConductorTercero[]>([]);
  const [docIdx,     setDocIdx]     = useState<DocumentoTercero[]>([]);
  const [paramsVeh,  setParamsVeh]  = useState<ParamVeh[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [guardando,  setGuardando]  = useState(false);

  // Detalle completo por empresa, cacheado.
  const [detalles, setDetalles] = useState<Record<number, DetalleEmpresa>>({});
  const [cargandoDetalle, setCargandoDetalle] = useState(false);

  const [empresaSel,  setEmpresaSel]  = useState<number | null>(null);
  const [tabActiva,   setTabActiva]   = useState<TabActiva>("flota");
  const [mostrarFormEmp,  setMostrarFormEmp]  = useState(false);
  const [mostrarFormVeh,  setMostrarFormVeh]  = useState(false);
  const [mostrarFormCond, setMostrarFormCond] = useState(false);
  const [mostrarFormDoc,  setMostrarFormDoc]  = useState(false);
  const [editEmpId,   setEditEmpId]   = useState<number | null>(null);
  const [editVehId,   setEditVehId]   = useState<number | null>(null);
  const [editCondId,  setEditCondId]  = useState<number | null>(null);
  const [editDocId,   setEditDocId]   = useState<number | null>(null);
  const [formEmp,  setFormEmp]  = useState(FORM_EMP);
  const [formVeh,  setFormVeh]  = useState(FORM_VEH);
  const [formCond, setFormCond] = useState(FORM_COND);
  const [formDoc,  setFormDoc]  = useState(FORM_DOC);
  const [subiendoFoto, setSubiendoFoto] = useState<"externa"|"interna"|null>(null);
  const [modalOdoVeh, setModalOdoVeh] = useState<VehiculoTercero | null>(null);
  const [confirmarBorrado, setConfirmarBorrado] = useState<Empresa | null>(null);
  const [textoBorrado, setTextoBorrado] = useState("");
  const [geocodificando, setGeocodificando] = useState(false);

  // Búsqueda + filtros de la lista.
  const [busqueda,   setBusqueda]   = useState("");
  const [busqActiva, setBusqActiva] = useState("");
  const [filtroRiesgo, setFiltroRiesgo] = useState<"todos" | Nivel | "sin_docs">("todos");
  const [filtroEstado, setFiltroEstado] = useState("activo");
  const [filtroDistrito, setFiltroDistrito] = useState(""); // "" = sin filtro de cercanía
  const [orden,        setOrden]        = useState<"riesgo" | "az" | "flota">("riesgo");
  const [limiteLista,  setLimiteLista]  = useState(60);
  const debRef  = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Vista de la pestaña Flota.
  const [vistaFlota, setVistaFlota] = useState<"tabla" | "fichas">("tabla");
  const [busqFlota,  setBusqFlota]  = useState("");
  const [filtroEstVeh, setFiltroEstVeh] = useState("todos");
  const [vehExpandido, setVehExpandido] = useState<number | null>(null);
  const [resaltarVeh,  setResaltarVeh]  = useState<number | null>(null);
  const [limiteFlota,  setLimiteFlota]  = useState(50);

  // Filtros de Conductores / Documentos.
  const [busqCond,   setBusqCond]   = useState("");
  const [filtroLic,  setFiltroLic]  = useState<"todos" | "vencida" | "por_vencer" | "app">("todos");
  const [limiteCond, setLimiteCond] = useState(50);
  const [filtroDoc,  setFiltroDoc]  = useState<"todos" | "vencido" | "por_vencer" | "vigente" | "sin_fecha">("todos");
  const [filtroDocVeh, setFiltroDocVeh] = useState("");
  const [limiteDoc,  setLimiteDoc]  = useState(50);

  const fe = (k: keyof typeof FORM_EMP) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setFormEmp(p => ({ ...p, [k]: e.target.value }));

  // ── Carga: capa 1, índice ligero ───────────────────────────────────────────
  // Proyección explícita (sin fotos, descripciones ni jsonb) y TODO paginado con
  // paginarFilas(): PostgREST recorta cualquier respuesta al max-rows del servidor (1000)
  // sin avisar — el bug que ya truncó la huella GPS y /programacion.

  const cargarIndice = async () => {
    setLoading(true);
    const [eRows, vRows, cRows, dRows] = await Promise.all([
      paginarFilas(() => supabase.from("empresas_tercerizadas")
        .select("id,razon_social,ruc,estado,telefono,email,contacto_nombre,contacto_telefono,autorizacion_mtc,habilitacion_sutran,venc_autorizacion,venc_habilitacion,direccion_fiscal,distrito_fiscal,direccion_cochera,distrito_cochera,lat_cochera,lng_cochera")
        .order("razon_social").order("id")),
      paginarFilas(() => supabase.from("vehiculos_tercero")
        .select("id,empresa_id,placa,categoria,marca,modelo,capacidad,estado,distrito_cochera")
        .order("placa").order("id")),
      paginarFilas(() => supabase.from("conductores_tercero")
        .select("id,empresa_id,nombre,dni,licencia,categoria_licencia,vencimiento_licencia,telefono")
        .order("nombre").order("id")),
      // Proyección ultraligera pero SIN filtrar por fecha: hace falta saber qué tipos están
      // registrados para detectar los obligatorios AUSENTES (el punto ciego del semáforo).
      // Si documentos_tercero superara ~30 000 filas, acotar aquí a
      // .or("fecha_vencimiento.is.null,fecha_vencimiento.lte.<hoy+45d>") y asumir que se
      // pierde la detección de faltantes.
      paginarFilas(() => supabase.from("documentos_tercero")
        .select("id,empresa_id,vehiculo_id,tipo,fecha_vencimiento")
        .order("fecha_vencimiento").order("id")),
    ]);
    setEmpresas(eRows as Empresa[]);
    setVehIdx(vRows as VehiculoTercero[]);
    setCondIdx(cRows as ConductorTercero[]);
    setDocIdx(dRows as DocumentoTercero[]);
    setLoading(false);
  };

  useEffect(() => { cargarIndice(); }, []);

  // ── Carga: capa 2, detalle bajo demanda con caché ──────────────────────────

  const cargarDetalle = async (id: number) => {
    setCargandoDetalle(true);
    const [vRes, cRes, dRes] = await Promise.all([
      supabase.from("vehiculos_tercero").select("*").eq("empresa_id", id).order("placa"),
      supabase.from("conductores_tercero").select("*").eq("empresa_id", id).order("nombre"),
      supabase.from("documentos_tercero").select("*").eq("empresa_id", id).order("fecha_vencimiento"),
    ]);
    const vehs = (vRes.data || []) as VehiculoTercero[];
    // Lecturas sospechosas acotadas a las unidades de ESTA empresa, en lotes: .in() acota
    // QUÉ filas, no CUÁNTAS devuelve PostgREST.
    const sosp: Record<number, number> = {};
    const ids = vehs.map(v => v.id);
    for (let i = 0; i < ids.length; i += 80) {
      const lote = ids.slice(i, i + 80);
      const filas = await paginarFilas(() => supabase.from("lecturas_odometro")
        .select("vehiculo_tercero_id")
        .eq("estado", "sospechosa").in("vehiculo_tercero_id", lote)
        .order("vehiculo_tercero_id"));
      for (const f of filas) sosp[f.vehiculo_tercero_id] = (sosp[f.vehiculo_tercero_id] || 0) + 1;
    }
    setDetalles(p => ({ ...p, [id]: { vehs, conds: (cRes.data || []) as ConductorTercero[], docs: (dRes.data || []) as DocumentoTercero[], sosp } }));
    setCargandoDetalle(false);
  };

  useEffect(() => {
    if (empresaSel && !detalles[empresaSel]) cargarDetalle(empresaSel);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [empresaSel]);

  // Invalidación EXPLÍCITA del caché tras cada guardado/borrado: si no, el operador
  // sigue viendo la placa vieja.
  const refrescarDetalle = async (id: number | null) => {
    if (!id) return;
    setDetalles(p => { const c = { ...p }; delete c[id]; return c; });
    await cargarDetalle(id);
  };

  // Capa 3: los parámetros de costeo solo viajan si alguien abre el formulario de vehículo.
  useEffect(() => {
    if (!mostrarFormVeh || paramsVeh.length > 0) return;
    supabase.from("parametros_costos").select("tipo_vehiculo,nombre,grupo_vehiculo")
      .eq("activo", true).order("grupo_vehiculo").order("capacidad")
      .then(({ data }: any) => setParamsVeh(data || []));
  }, [mostrarFormVeh, paramsVeh.length]);

  // ── Derivados ──────────────────────────────────────────────────────────────

  const empActual  = empresas.find(e => e.id === empresaSel);
  const det        = empresaSel ? detalles[empresaSel] : null;
  const vehEmpresa  = det?.vehs  ?? [];
  const condEmpresa = det?.conds ?? [];
  const docEmpresa  = det?.docs  ?? [];
  const odoPorVeh   = det?.sosp  ?? {};

  // Agrupaciones del índice: se calculan UNA vez, no dentro de un .filter() por empresa
  // (con 1000 × 50 000 eso serían 50 millones de iteraciones por render).
  const porEmpresa = useMemo(() => {
    const vehs: Record<number, VehiculoTercero[]> = {};
    const conds: Record<number, ConductorTercero[]> = {};
    const docs: Record<number, DocumentoTercero[]> = {};
    for (const v of vehIdx)  (vehs[v.empresa_id]  ||= []).push(v);
    for (const c of condIdx) (conds[c.empresa_id] ||= []).push(c);
    for (const d of docIdx)  (docs[d.empresa_id]  ||= []).push(d);
    return { vehs, conds, docs };
  }, [vehIdx, condIdx, docIdx]);

  const riesgoPorEmp = useMemo(() => {
    const m: Record<number, { nivel: Nivel; faltan: number; venc: number }> = {};
    for (const e of empresas) {
      const docs  = porEmpresa.docs[e.id]  || [];
      const conds = porEmpresa.conds[e.id] || [];
      m[e.id] = {
        nivel: calcRiesgo(docs, conds, e),
        faltan: docsObligFaltantes(docs).length,
        venc: docs.filter(d => estadoDoc(d.fecha_vencimiento) === "vencido").length
            + conds.filter(c => { const x = diasPara(c.vencimiento_licencia); return x !== null && x < 0; }).length,
      };
    }
    return m;
  }, [empresas, porEmpresa]);

  // ── KPIs globales ─────────────────────────────────────────────────────────

  const totalEmpresas = empresas.length;
  const totalAlerta   = empresas.filter(e => riesgoPorEmp[e.id]?.nivel === "alto").length;
  const totalSinDocs  = empresas.filter(e => riesgoPorEmp[e.id]?.faltan === OBLIGATORIOS.length).length;
  const totalFlota    = vehIdx.length;

  // ── Alertas empresa seleccionada ──────────────────────────────────────────

  const riesgoEmp = empActual ? calcRiesgo(docEmpresa, condEmpresa, empActual) : "ok";
  const docsVencOblig  = docEmpresa.filter(d => estadoDoc(d.fecha_vencimiento) === "vencido" && TIPOS_DOC_TERCERO[d.tipo]?.obligatorio);
  const docsPorVOblig  = docEmpresa.filter(d => estadoDoc(d.fecha_vencimiento) === "por_vencer" && TIPOS_DOC_TERCERO[d.tipo]?.obligatorio);
  const licVencidas    = condEmpresa.filter(c => diasPara(c.vencimiento_licencia) !== null && diasPara(c.vencimiento_licencia)! < 0);
  const aptitudEmp     = empActual ? calcAptitud(null, empActual, docEmpresa, condEmpresa) : null;

  // ── Búsqueda instantánea (100 % en cliente sobre el índice) ────────────────

  useEffect(() => {
    clearTimeout(debRef.current);
    debRef.current = setTimeout(() => setBusqActiva(busqueda), 250);
    return () => clearTimeout(debRef.current);
  }, [busqueda]);

  useEffect(() => { setLimiteLista(60); }, [busqActiva, filtroRiesgo, filtroEstado, orden]);
  useEffect(() => { setLimiteFlota(50); setVehExpandido(null); }, [busqFlota, filtroEstVeh, empresaSel]);
  useEffect(() => { setLimiteCond(50); }, [busqCond, filtroLic, empresaSel]);
  useEffect(() => { setLimiteDoc(50); }, [filtroDoc, filtroDocVeh, empresaSel]);

  // Atajos: "/" enfoca el buscador, Esc lo limpia.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement | null;
      const escribiendo = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (ev.key === "/" && !escribiendo) { ev.preventDefault(); inputRef.current?.focus(); }
      if (ev.key === "Escape" && document.activeElement === inputRef.current) { setBusqueda(""); inputRef.current?.blur(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const indices = useMemo(() => {
    const empPorId: Record<number, Empresa> = {};
    for (const e of empresas) empPorId[e.id] = e;
    return {
      empPorId,
      veh:  vehIdx.map(v => ({ v, placaN: normPlaca(v.placa), blob: norm(`${v.marca || ""} ${v.modelo || ""} ${v.categoria || ""}`) })),
      emp:  empresas.map(e => ({ e, blob: norm(`${e.razon_social} ${e.ruc || ""} ${e.contacto_nombre || ""}`) })),
      cond: condIdx.map(c => ({ c, blob: norm(`${c.nombre} ${c.dni || ""} ${c.licencia || ""}`) })),
    };
  }, [empresas, vehIdx, condIdx]);

  const resultados = useMemo(() => {
    const q = busqActiva.trim();
    if (q.length < 2) return { veh: [] as typeof indices.veh, emp: [] as typeof indices.emp, cond: [] as typeof indices.cond, total: 0 };
    const qn = norm(q);
    const qp = normPlaca(q);

    const veh = qp.length >= 2
      ? indices.veh.filter(x => x.placaN.includes(qp)).concat(
          indices.veh.filter(x => !x.placaN.includes(qp) && x.blob.includes(qn)))
      : indices.veh.filter(x => x.blob.includes(qn));
    // Coincidencia exacta primero, luego por prefijo, luego el resto.
    veh.sort((a, b) => {
      const pa = a.placaN === qp ? 0 : a.placaN.startsWith(qp) ? 1 : 2;
      const pb = b.placaN === qp ? 0 : b.placaN.startsWith(qp) ? 1 : 2;
      return pa - pb || a.placaN.localeCompare(b.placaN);
    });
    const emp  = indices.emp.filter(x => x.blob.includes(qn));
    const cond = indices.cond.filter(x => x.blob.includes(qn));
    return { veh, emp, cond, total: veh.length + emp.length + cond.length };
  }, [busqActiva, indices]);

  const buscando = busqActiva.trim().length >= 2;
  const mejorVeh = resultados.veh[0] || null;
  // Placa registrada en más de un proveedor: es un hallazgo, no ruido — se rotula.
  const placaDuplicada = mejorVeh
    ? resultados.veh.filter(x => x.placaN === mejorVeh.placaN).length > 1
    : false;

  // ── Lista lateral filtrada ────────────────────────────────────────────────

  const empresasIdsConMatch = useMemo(() => {
    if (!buscando) return null;
    const s = new Set<number>();
    for (const x of resultados.veh)  s.add(x.v.empresa_id);
    for (const x of resultados.emp)  s.add(x.e.id);
    for (const x of resultados.cond) s.add(x.c.empresa_id);
    return s;
  }, [buscando, resultados]);

  // Distritos donde una empresa realmente tiene unidades: el de su cochera general, más el
  // override de cada vehículo que lo tenga distinto (una empresa grande puede tener unidades
  // repartidas en varios puntos de Lima). Vacío si no cargó ningún distrito.
  const distritosPorEmpresa = useMemo(() => {
    const out: Record<number, Set<string>> = {};
    for (const e of empresas) {
      const s = new Set<string>();
      if (e.distrito_cochera) s.add(e.distrito_cochera);
      out[e.id] = s;
    }
    for (const v of vehIdx) {
      if (v.distrito_cochera && out[v.empresa_id]) out[v.empresa_id].add(v.distrito_cochera);
    }
    return out;
  }, [empresas, vehIdx]);

  /** Menor cantidad de saltos entre el distrito buscado y CUALQUIER distrito de esta empresa. */
  const distanciaEmpresa = (empId: number, distritoObjetivo: string): number | null => {
    const disponibles = distritosPorEmpresa[empId];
    if (!disponibles || disponibles.size === 0) return null;
    let mejor: number | null = null;
    for (const d of disponibles) {
      const h = distanciaDistritos(distritoObjetivo, d);
      if (h !== null && (mejor === null || h < mejor)) mejor = h;
    }
    return mejor;
  };

  const listaFiltrada = useMemo(() => {
    const ordRiesgo: Record<Nivel, number> = { alto: 0, medio: 1, ok: 2 };
    let out = empresas.filter(e => {
      if (filtroEstado !== "todos" && e.estado !== filtroEstado) return false;
      const r = riesgoPorEmp[e.id];
      if (filtroRiesgo === "sin_docs") { if ((r?.faltan ?? 0) !== OBLIGATORIOS.length) return false; }
      else if (filtroRiesgo !== "todos" && r?.nivel !== filtroRiesgo) return false;
      if (empresasIdsConMatch && !empresasIdsConMatch.has(e.id)) return false;
      return true;
    });
    out = out.sort((a, b) => {
      // Con un distrito buscado activo, la cercanía manda sobre el orden elegido — pero
      // dentro del mismo nivel de cercanía (ej. dos empresas "a 1 distrito"), el orden
      // elegido sigue desempatando.
      if (filtroDistrito) {
        const da = distanciaEmpresa(a.id, filtroDistrito);
        const db = distanciaEmpresa(b.id, filtroDistrito);
        const pa = da === null ? 99 : da, pb = db === null ? 99 : db;
        if (pa !== pb) return pa - pb;
      }
      if (orden === "az") return a.razon_social.localeCompare(b.razon_social);
      if (orden === "flota") return (porEmpresa.vehs[b.id]?.length || 0) - (porEmpresa.vehs[a.id]?.length || 0);
      const ra = ordRiesgo[riesgoPorEmp[a.id]?.nivel ?? "ok"], rb = ordRiesgo[riesgoPorEmp[b.id]?.nivel ?? "ok"];
      return ra - rb || a.razon_social.localeCompare(b.razon_social);
    });
    return out;
  }, [empresas, filtroEstado, filtroRiesgo, empresasIdsConMatch, orden, riesgoPorEmp, porEmpresa, filtroDistrito, distritosPorEmpresa]);

  const selFueraDeFiltro = !!empresaSel && !listaFiltrada.some(e => e.id === empresaSel);

  // Por qué coincidió esta empresa (segunda línea de la fila, solo al buscar).
  const motivoMatch = (empId: number): string | null => {
    if (!buscando) return null;
    const v = resultados.veh.find(x => x.v.empresa_id === empId);
    if (v) return `placa ${v.v.placa}`;
    const c = resultados.cond.find(x => x.c.empresa_id === empId);
    if (c) return `conductor ${c.c.nombre}`;
    return null;
  };

  const abrirVehiculo = (v: VehiculoTercero) => {
    setEmpresaSel(v.empresa_id);
    setTabActiva("flota");
    setResaltarVeh(v.id);
  };

  // Resalta y centra la fila de la unidad tras saltar desde la búsqueda.
  useEffect(() => {
    if (!resaltarVeh || !det) return;
    const t = setTimeout(() => {
      document.getElementById(`veh-${resaltarVeh}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 120);
    const t2 = setTimeout(() => setResaltarVeh(null), 2600);
    return () => { clearTimeout(t); clearTimeout(t2); };
  }, [resaltarVeh, det]);

  // ── CRUD Empresa ──────────────────────────────────────────────────────────

  const guardarEmpresa = async () => {
    if (!formEmp.razon_social.trim()) { alert("Razón social obligatoria"); return; }
    setGuardando(true);
    const payload = {
      razon_social: formEmp.razon_social.trim(),
      ruc: formEmp.ruc.trim() || null,
      telefono: formEmp.telefono.trim() || null,
      email: formEmp.email.trim() || null,
      contacto_nombre: formEmp.contacto_nombre.trim() || null,
      contacto_telefono: formEmp.contacto_telefono.trim() || null,
      autorizacion_mtc: formEmp.autorizacion_mtc.trim() || null,
      habilitacion_sutran: formEmp.habilitacion_sutran.trim() || null,
      venc_autorizacion: formEmp.venc_autorizacion || null,
      venc_habilitacion: formEmp.venc_habilitacion || null,
      estado: formEmp.estado,
      observaciones: formEmp.observaciones.trim() || null,
      direccion_fiscal: formEmp.direccion_fiscal.trim() || null,
      distrito_fiscal: formEmp.distrito_fiscal || null,
      direccion_cochera: formEmp.direccion_cochera.trim() || null,
      distrito_cochera: formEmp.distrito_cochera || null,
    };
    const { error } = editEmpId
      ? await supabase.from("empresas_tercerizadas").update(payload).eq("id", editEmpId)
      : await supabase.from("empresas_tercerizadas").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    setFormEmp(FORM_EMP); setEditEmpId(null); setMostrarFormEmp(false);
    await cargarIndice();
    if (editEmpId) await refrescarDetalle(editEmpId);
    setGuardando(false);
  };

  const editarEmpresa = (e: Empresa) => {
    setFormEmp({
      razon_social: e.razon_social || "", ruc: e.ruc || "",
      telefono: e.telefono || "", email: e.email || "",
      contacto_nombre: e.contacto_nombre || "",
      contacto_telefono: e.contacto_telefono || "",
      autorizacion_mtc: e.autorizacion_mtc || "",
      habilitacion_sutran: e.habilitacion_sutran || "",
      venc_autorizacion: e.venc_autorizacion || "",
      venc_habilitacion: e.venc_habilitacion || "",
      estado: e.estado || "activo", observaciones: e.observaciones || "",
      direccion_fiscal: e.direccion_fiscal || "", distrito_fiscal: e.distrito_fiscal || "",
      direccion_cochera: e.direccion_cochera || "", distrito_cochera: e.distrito_cochera || "",
    });
    setEditEmpId(e.id); setMostrarFormEmp(true);
  };

  // Coordenadas exactas de la cochera — detalle OPCIONAL, el filtro de cercanía principal
  // usa solo distrito_cochera (arriba). Reusa el mismo pipeline de geocodificación cacheada
  // que ya usan las paradas (lib/geocode-cache.ts vía /api/geocodificar-punto), pero sin
  // escribir en la tabla `paradas` — el resultado se guarda directo en la empresa.
  const geocodificarCochera = async () => {
    if (!formEmp.direccion_cochera.trim()) { alert("Escribe la dirección de la cochera primero"); return; }
    setGeocodificando(true);
    try {
      const res = await fetch("/api/geocodificar-punto", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direccion: formEmp.direccion_cochera.trim() }),
      });
      const data = await res.json();
      if (data.status !== "OK" || data.lat == null) {
        alert("No se pudo ubicar esa dirección. Verifica que esté bien escrita (con distrito/referencia).");
        return;
      }
      if (!editEmpId) { alert("Guarda la empresa primero, luego geocodifica la cochera."); return; }
      const { error } = await supabase.from("empresas_tercerizadas")
        .update({ lat_cochera: data.lat, lng_cochera: data.lng }).eq("id", editEmpId);
      if (error) { alert("Error al guardar coordenadas: " + error.message); return; }
      await cargarIndice();
      alert(`Ubicado: ${data.direccion || formEmp.direccion_cochera}`);
    } finally {
      setGeocodificando(false);
    }
  };

  // Borrar arrastra en cascada las lecturas de odómetro de todas sus unidades: se confirma
  // tecleando el RUC (o la razón social si no tiene RUC), no con un confirm() de un clic.
  const eliminarEmpresa = async () => {
    if (!confirmarBorrado) return;
    const clave = confirmarBorrado.ruc || confirmarBorrado.razon_social;
    if (textoBorrado.trim() !== clave) { alert("El texto no coincide."); return; }
    setGuardando(true);
    const { error } = await supabase.from("empresas_tercerizadas").delete().eq("id", confirmarBorrado.id);
    setGuardando(false);
    if (error) { alert(error.message); return; }
    if (empresaSel === confirmarBorrado.id) setEmpresaSel(null);
    setConfirmarBorrado(null); setTextoBorrado("");
    cargarIndice();
  };

  // ── CRUD Vehículo tercero ─────────────────────────────────────────────────

  const comprimirImagen = (file: File, maxW = 1200, maxH = 800, quality = 0.80): Promise<Blob> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      const objUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objUrl);
        let { width, height } = img;
        const ratio = Math.min(1, maxW / width, maxH / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
        canvas.toBlob(b => b ? resolve(b) : reject(new Error("canvas vacío")), "image/jpeg", quality);
      };
      img.onerror = reject;
      img.src = objUrl;
    });

  const subirFotoVeh = async (file: File, tipo: "externa" | "interna"): Promise<string | null> => {
    const blob = await comprimirImagen(file).catch(e => { alert("Error al comprimir: " + e.message); return null; });
    if (!blob) return null;
    const path = `vehiculo-tercero/${empresaSel}_${Date.now()}_${tipo}.jpg`;
    const { error } = await supabase.storage.from("vehiculos-fotos").upload(path, blob, { upsert: true, contentType: "image/jpeg" });
    if (error) { alert("Error al subir foto: " + error.message); return null; }
    const { data } = supabase.storage.from("vehiculos-fotos").getPublicUrl(path);
    return data.publicUrl;
  };

  const guardarVehiculo = async () => {
    if (!formVeh.placa.trim() || !empresaSel) { alert("Placa obligatoria"); return; }
    setGuardando(true);
    const payload = {
      empresa_id: empresaSel,
      placa: formVeh.placa.trim().toUpperCase(),
      categoria: formVeh.categoria || null,
      marca: formVeh.marca.trim() || null,
      modelo: formVeh.modelo.trim() || null,
      capacidad: formVeh.capacidad ? Number(formVeh.capacidad) : null,
      estado: formVeh.estado,
      foto_externa_url: formVeh.foto_externa_url.trim() || null,
      foto_interna_url: formVeh.foto_interna_url.trim() || null,
      descripcion_unidad: formVeh.descripcion_unidad.trim() || null,
      tipo_vehiculo_costeo: formVeh.tipo_vehiculo_costeo || null,
      distrito_cochera: formVeh.distrito_cochera || null,
    };
    const { error } = editVehId
      ? await supabase.from("vehiculos_tercero").update(payload).eq("id", editVehId)
      : await supabase.from("vehiculos_tercero").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    setFormVeh(FORM_VEH); setEditVehId(null); setMostrarFormVeh(false);
    await Promise.all([refrescarDetalle(empresaSel), cargarIndice()]);
    setGuardando(false);
  };

  // ── CRUD Conductor tercero ────────────────────────────────────────────────

  const guardarConductor = async () => {
    if (!formCond.nombre.trim() || !empresaSel) { alert("Nombre obligatorio"); return; }
    setGuardando(true);
    const payload = {
      empresa_id: empresaSel,
      nombre: formCond.nombre.trim(),
      dni: formCond.dni.trim() || null,
      licencia: formCond.licencia.trim() || null,
      categoria_licencia: formCond.categoria_licencia || null,
      vencimiento_licencia: formCond.vencimiento_licencia || null,
      telefono: formCond.telefono.trim() || null,
      email: formCond.email.trim().toLowerCase() || null,
      estado: formCond.estado,
      pin_acceso: formCond.pin_acceso.trim() || null,
      activo_app: formCond.activo_app,
    };
    const { error } = editCondId
      ? await supabase.from("conductores_tercero").update(payload).eq("id", editCondId)
      : await supabase.from("conductores_tercero").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    setFormCond(FORM_COND); setEditCondId(null); setMostrarFormCond(false);
    await Promise.all([refrescarDetalle(empresaSel), cargarIndice()]);
    setGuardando(false);
  };

  // ── CRUD Documento tercero ────────────────────────────────────────────────

  const guardarDocumento = async () => {
    if (!formDoc.tipo || !empresaSel) { alert("Tipo obligatorio"); return; }
    setGuardando(true);
    const payload = {
      empresa_id: empresaSel,
      vehiculo_id: formDoc.vehiculo_id ? Number(formDoc.vehiculo_id) : null,
      tipo: formDoc.tipo,
      numero: formDoc.numero.trim() || null,
      fecha_vencimiento: formDoc.fecha_vencimiento || null,
      entidad_emisora: formDoc.entidad_emisora.trim() || null,
      archivo_url: formDoc.archivo_url.trim() || null,
      observaciones: formDoc.observaciones.trim() || null,
    };
    const { error } = editDocId
      ? await supabase.from("documentos_tercero").update(payload).eq("id", editDocId)
      : await supabase.from("documentos_tercero").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    setFormDoc(FORM_DOC); setEditDocId(null); setMostrarFormDoc(false);
    await Promise.all([refrescarDetalle(empresaSel), cargarIndice()]);
    setGuardando(false);
  };

  // ── Listas de las pestañas ────────────────────────────────────────────────

  const flotaFiltrada = useMemo(() => {
    const q = norm(busqFlota), qp = normPlaca(busqFlota);
    return vehEmpresa.filter(v => {
      if (filtroEstVeh !== "todos" && v.estado !== filtroEstVeh) return false;
      if (!busqFlota.trim()) return true;
      return normPlaca(v.placa).includes(qp) || norm(`${v.marca || ""} ${v.modelo || ""} ${v.categoria || ""}`).includes(q);
    });
  }, [vehEmpresa, busqFlota, filtroEstVeh]);

  const condFiltrados = useMemo(() => {
    const q = norm(busqCond);
    return condEmpresa.filter(c => {
      const d = diasPara(c.vencimiento_licencia);
      if (filtroLic === "vencida"    && !(d !== null && d < 0)) return false;
      if (filtroLic === "por_vencer" && !(d !== null && d >= 0 && d <= 30)) return false;
      if (filtroLic === "app"        && !c.activo_app) return false;
      if (!busqCond.trim()) return true;
      return norm(`${c.nombre} ${c.dni || ""} ${c.licencia || ""}`).includes(q);
    }).sort((a, b) => {
      const da = diasPara(a.vencimiento_licencia), db = diasPara(b.vencimiento_licencia);
      if (da === null && db === null) return a.nombre.localeCompare(b.nombre);
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    });
  }, [condEmpresa, busqCond, filtroLic]);

  // Copia antes de ordenar: docEmpresa viene del estado y .sort() lo mutaría en pleno render.
  const docsFiltrados = useMemo(() => {
    const ord = { vencido: 0, por_vencer: 1, sin_fecha: 2, vigente: 3 };
    return [...docEmpresa]
      .filter(d => {
        if (filtroDoc !== "todos" && estadoDoc(d.fecha_vencimiento) !== filtroDoc) return false;
        if (filtroDocVeh === "empresa" && d.vehiculo_id !== null) return false;
        if (filtroDocVeh && filtroDocVeh !== "empresa" && String(d.vehiculo_id) !== filtroDocVeh) return false;
        return true;
      })
      .sort((a, b) => (ord[estadoDoc(a.fecha_vencimiento)] ?? 3) - (ord[estadoDoc(b.fecha_vencimiento)] ?? 3));
  }, [docEmpresa, filtroDoc, filtroDocVeh]);

  // ── Piezas de UI reutilizadas ─────────────────────────────────────────────

  const ChipVeredicto = ({ nivel, causa, grande }: { nivel: Nivel; causa: string; grande?: boolean }) => {
    const c = NIVEL_CFG[nivel];
    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full font-black ${grande ? "px-3 py-1.5 text-[11px]" : "px-2 py-0.5 text-[10px]"}`}
        style={{ background: c.bg, color: c.color }}>
        <span>{c.icono}</span>{c.label}<span className="font-semibold opacity-80">— {causa}</span>
      </span>
    );
  };

  const Segmented = <T extends string>({ valor, onChange, ops }: { valor: T; onChange: (v: T) => void; ops: [T, string][] }) => (
    <div className="flex gap-1 bg-gray-50 rounded-xl p-1">
      {ops.map(([v, l]) => (
        <button key={v} onClick={() => onChange(v)}
          className={`px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all ${valor === v ? "bg-white shadow-sm text-[#0b315f]" : "text-gray-400 hover:text-gray-600"}`}>
          {l}
        </button>
      ))}
    </div>
  );

  const AccionesContacto = ({ tel, chico }: { tel: string | null | undefined; chico?: boolean }) => {
    const e164 = telE164(tel);
    if (!e164) return null;
    return (
      <span className="inline-flex items-center gap-1">
        <a href={`tel:+${e164}`} onClick={ev => ev.stopPropagation()}
          className={`${chico ? "text-[10px]" : "text-xs"} font-bold text-[#0b315f] hover:underline`}>📞</a>
        <a href={`https://wa.me/${e164}`} target="_blank" rel="noreferrer" onClick={ev => ev.stopPropagation()}
          className={`${chico ? "text-[10px]" : "text-xs"} font-bold text-green-600 hover:underline`}>💬</a>
      </span>
    );
  };

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 pt-0 space-y-4 max-w-7xl mx-auto">

      {/* ── BARRA DE MANDO (sticky): el buscador nunca se pierde al scrollear ── */}
      <div className="sticky top-0 z-30 -mx-6 px-6 py-3 border-b border-gray-200 bg-[#eef3f8]/95 backdrop-blur flex items-center gap-3 flex-wrap">
        <div className="flex-shrink-0">
          <h1 className="text-2xl font-black leading-none" style={{ color: "#0b315f" }}>Empresas Tercerizadas</h1>
          <p className="text-[11px] text-gray-400 mt-1">Flota externa · conductores · documentos</p>
        </div>

        <div className="relative flex-1 min-w-[280px] max-w-2xl">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">🔍</span>
          <input ref={inputRef} autoFocus value={busqueda} onChange={e => setBusqueda(e.target.value)}
            placeholder="Buscar placa, proveedor, RUC, conductor o DNI…"
            className="w-full border border-gray-200 bg-white rounded-xl pl-9 pr-16 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all" />
          {busqueda ? (
            <button onClick={() => { setBusqueda(""); inputRef.current?.focus(); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 text-sm">✕</button>
          ) : (
            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono text-gray-300 border border-gray-200 rounded px-1.5 py-0.5">/</kbd>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={cargarIndice} disabled={loading}
            className="px-3 py-2.5 rounded-xl border border-gray-200 bg-white text-sm text-gray-500 hover:text-[#0b315f] disabled:opacity-50"
            title="Recargar">{loading ? "⏳" : "↻"}</button>
          <button onClick={() => { setFormEmp(FORM_EMP); setEditEmpId(null); setMostrarFormEmp(true); }}
            className="px-4 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
            style={{ background: "#0b315f" }}>+ Nueva empresa</button>
        </div>
      </div>

      {/* ── RESPUESTA RÁPIDA (solo al buscar) ── o ── CHIPS RESUMEN ──
          Se SUSTITUYEN, nunca se apilan: apilarlos reintroduce el scroll que este
          rediseño vino a eliminar. */}
      {buscando ? (
        <section className="space-y-2">
          {mejorVeh ? (() => {
            const v = mejorVeh.v;
            const emp = indices.empPorId[v.empresa_id];
            const docsEmp = porEmpresa.docs[v.empresa_id] || [];
            const condsEmp = porEmpresa.conds[v.empresa_id] || [];
            const apt = calcAptitud(v, emp, docsEmp, condsEmp);
            const cfg = NIVEL_CFG[apt.nivel];
            const fichaTexto = `${v.placa} · ${emp?.razon_social || "—"} · RUC ${emp?.ruc || "—"} · ${emp?.contacto_nombre || ""} ${emp?.contacto_telefono || emp?.telefono || ""} · ${cfg.label}: ${apt.causa}`;
            return (
              <div className="bg-white rounded-2xl border-2 shadow-sm p-4" style={{ borderColor: cfg.borde }}>
                <div className="flex items-start gap-5 flex-wrap">
                  <div className="min-w-[150px]">
                    <p className="text-3xl font-black font-mono text-gray-900 leading-none">{v.placa}</p>
                    <p className="text-[11px] text-gray-400 mt-1.5">
                      {[v.categoria, [v.marca, v.modelo].filter(Boolean).join(" "), v.capacidad ? `${v.capacidad} pax` : null].filter(Boolean).join(" · ")}
                    </p>
                  </div>

                  <div className="flex-1 min-w-[220px]">
                    <button onClick={() => abrirVehiculo(v)}
                      className="text-lg font-black hover:underline text-left leading-tight" style={{ color: "#0b315f" }}>
                      {emp?.razon_social || "Proveedor desconocido"}
                    </button>
                    <p className="text-[11px] text-gray-400 font-mono mt-0.5">RUC {emp?.ruc || "—"}</p>
                    {emp?.contacto_nombre && (
                      <p className="text-xs text-gray-600 mt-1">Contacto: <b>{emp.contacto_nombre}</b></p>
                    )}
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      {telE164(emp?.contacto_telefono || emp?.telefono) && (
                        <>
                          <a href={`tel:+${telE164(emp?.contacto_telefono || emp?.telefono)}`}
                            className="text-[11px] font-bold px-2.5 py-1 rounded-lg border border-gray-200 hover:bg-gray-50">📞 Llamar</a>
                          <a href={`https://wa.me/${telE164(emp?.contacto_telefono || emp?.telefono)}`} target="_blank" rel="noreferrer"
                            className="text-[11px] font-bold px-2.5 py-1 rounded-lg border border-green-200 text-green-700 hover:bg-green-50">💬 WhatsApp</a>
                        </>
                      )}
                      <button onClick={() => navigator.clipboard?.writeText(fichaTexto)}
                        className="text-[11px] font-bold px-2.5 py-1 rounded-lg border border-gray-200 hover:bg-gray-50">📋 Copiar ficha</button>
                      <button onClick={() => setModalOdoVeh(v)}
                        className="text-[11px] font-bold px-2.5 py-1 rounded-lg border border-gray-200 hover:bg-gray-50">📷 Odómetro</button>
                      <button onClick={() => abrirVehiculo(v)}
                        className="text-[11px] font-bold text-[#0b315f] hover:underline">Ver ficha completa →</button>
                    </div>
                  </div>

                  <div className="text-right">
                    <ChipVeredicto nivel={apt.nivel} causa={apt.causa} grande />
                    {emp && emp.estado !== "activo" && (
                      <p className="text-[10px] font-bold text-red-600 mt-1.5 uppercase">Proveedor {emp.estado}</p>
                    )}
                  </div>
                </div>
                {placaDuplicada && (
                  <p className="mt-3 text-[11px] font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                    ⚠ Esta placa está registrada en {resultados.veh.filter(x => x.placaN === mejorVeh.placaN).length} proveedores — revisa cuál corresponde antes de asignar.
                  </p>
                )}
              </div>
            );
          })() : resultados.total === 0 ? (
            <div className="bg-white rounded-2xl border p-8 text-center">
              <p className="text-4xl mb-3">🔍</p>
              <p className="font-bold text-gray-700">Sin coincidencias para “{busqActiva}”</p>
              <p className="text-xs text-gray-400 mt-1">No hay ninguna placa, proveedor ni conductor con ese texto.</p>
              <button onClick={() => { setFormEmp(FORM_EMP); setEditEmpId(null); setMostrarFormEmp(true); }}
                className="mt-4 px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#0b315f" }}>
                + Registrar un proveedor nuevo
              </button>
            </div>
          ) : null}

          {/* Coincidencias restantes */}
          {(resultados.veh.length > 1 || resultados.emp.length > 0 || resultados.cond.length > 0) && (
            <div className="bg-white rounded-2xl border p-3 space-y-2">
              {resultados.veh.length > 1 && (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">Otras unidades</p>
                  {resultados.veh.slice(1, 6).map(x => {
                    const emp = indices.empPorId[x.v.empresa_id];
                    const apt = calcAptitud(x.v, emp, porEmpresa.docs[x.v.empresa_id] || [], porEmpresa.conds[x.v.empresa_id] || []);
                    return (
                      <button key={x.v.id} onClick={() => abrirVehiculo(x.v)}
                        className="w-full flex items-center gap-2 text-left py-1.5 border-b border-gray-50 last:border-0 hover:bg-gray-50 rounded px-1">
                        <span className="font-mono font-black text-xs text-gray-900 w-24 flex-shrink-0">{x.v.placa}</span>
                        <span className="text-xs text-gray-500 truncate flex-1">{emp?.razon_social || "—"}</span>
                        <span className="text-sm flex-shrink-0">{NIVEL_CFG[apt.nivel].icono}</span>
                      </button>
                    );
                  })}
                  {resultados.veh.length > 6 && <p className="text-[10px] text-gray-400 pt-1">+{resultados.veh.length - 6} unidades más — afina la búsqueda</p>}
                </div>
              )}
              {resultados.emp.length > 0 && (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">Proveedores</p>
                  {resultados.emp.slice(0, 5).map(x => (
                    <button key={x.e.id} onClick={() => setEmpresaSel(x.e.id)}
                      className="w-full flex items-center gap-2 text-left py-1.5 border-b border-gray-50 last:border-0 hover:bg-gray-50 rounded px-1">
                      <span className="text-xs font-bold text-gray-900 truncate flex-1">{x.e.razon_social}</span>
                      <span className="text-[10px] font-mono text-gray-400">{x.e.ruc || "sin RUC"}</span>
                      <span className="text-[10px] font-mono text-gray-400 w-14 text-right">{porEmpresa.vehs[x.e.id]?.length || 0} veh</span>
                      <span className="text-sm flex-shrink-0">{NIVEL_CFG[riesgoPorEmp[x.e.id]?.nivel ?? "ok"].icono}</span>
                    </button>
                  ))}
                  {resultados.emp.length > 5 && <p className="text-[10px] text-gray-400 pt-1">+{resultados.emp.length - 5} proveedores más</p>}
                </div>
              )}
              {resultados.cond.length > 0 && (
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-1">Conductores</p>
                  {resultados.cond.slice(0, 5).map(x => {
                    const d = diasPara(x.c.vencimiento_licencia);
                    return (
                      <button key={x.c.id} onClick={() => { setEmpresaSel(x.c.empresa_id); setTabActiva("conductores"); }}
                        className="w-full flex items-center gap-2 text-left py-1.5 border-b border-gray-50 last:border-0 hover:bg-gray-50 rounded px-1">
                        <span className="text-xs font-bold text-gray-900 truncate flex-1">{x.c.nombre}</span>
                        <span className="text-[10px] font-mono text-gray-400">{x.c.dni || "—"}</span>
                        <span className="text-[10px] text-gray-400 truncate max-w-[160px]">{indices.empPorId[x.c.empresa_id]?.razon_social}</span>
                        <span className="text-[10px] font-bold flex-shrink-0" style={{ color: d !== null && d < 0 ? "#dc2626" : "#9ca3af" }}>
                          {d !== null && d < 0 ? "🔴 Lic. vencida" : ""}
                        </span>
                      </button>
                    );
                  })}
                  {resultados.cond.length > 5 && <p className="text-[10px] text-gray-400 pt-1">+{resultados.cond.length - 5} conductores más</p>}
                </div>
              )}
            </div>
          )}
        </section>
      ) : (
        <section className="flex gap-2 flex-wrap items-center">
          {([
            { k: "todos",    label: "proveedores", valor: totalEmpresas, color: "#0b315f", bg: "#eef3f8" },
            { k: "alto",     label: "riesgo alto", valor: totalAlerta,   color: "#991b1b", bg: "#fee2e2" },
            { k: "sin_docs", label: "sin documentos", valor: totalSinDocs, color: "#854d0e", bg: "#fef9c3" },
          ] as const).map(c => (
            <button key={c.k} onClick={() => setFiltroRiesgo(r => (r === c.k ? "todos" : c.k as any))}
              className="rounded-full px-3 py-1.5 text-xs font-bold border transition-all"
              style={{
                background: filtroRiesgo === c.k ? c.bg : "white",
                color: c.color,
                borderColor: filtroRiesgo === c.k ? c.color : "#e5e7eb",
              }}>
              <span className="font-black">{c.valor}</span> {c.label}
            </button>
          ))}
          <span className="rounded-full px-3 py-1.5 text-xs font-bold border border-gray-200 bg-white" style={{ color: "#1d4ed8" }}>
            <span className="font-black">{totalFlota}</span> vehículos
          </span>
          <span className="rounded-full px-3 py-1.5 text-xs font-bold border border-gray-200 bg-white" style={{ color: "#6d28d9" }}>
            <span className="font-black">{condIdx.length}</span> conductores
          </span>
          {totalSinDocs > 0 && (
            <span className="text-[10px] text-gray-400 ml-1">Sin documentos = ningún obligatorio cargado; no cuenta como riesgo alto.</span>
          )}
        </section>
      )}

      {/* ── MASTER-DETAIL ── */}
      <div className="grid grid-cols-1 xl:grid-cols-[300px_minmax(0,1fr)] gap-4 items-start">

        {/* Lista de proveedores: altura fija + scroll interno. Con 16 o con 1000 la
            página mide lo mismo. */}
        <div className={empresaSel ? "hidden xl:block" : "block"}>
          <div className="bg-white rounded-t-2xl border border-b-0 px-3 py-2.5 space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Proveedores</p>
              <p className="text-[10px] font-mono text-gray-400">
                {listaFiltrada.length === empresas.length
                  ? `${empresas.length}`
                  : `${Math.min(limiteLista, listaFiltrada.length)} de ${listaFiltrada.length}`}
              </p>
            </div>
            <Segmented valor={filtroRiesgo === "sin_docs" ? "todos" : filtroRiesgo} onChange={v => setFiltroRiesgo(v)}
              ops={[["todos", "Todos"], ["alto", "🚨"], ["medio", "⚠️"], ["ok", "✅"]] as ["todos" | Nivel, string][]} />
            <div className="grid grid-cols-2 gap-1.5">
              <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value)}
                className="border border-gray-200 rounded-xl px-2 py-1.5 text-[11px] focus:outline-none focus:border-[#0b315f]">
                <option value="activo">Activos</option>
                <option value="todos">Todos</option>
                <option value="inactivo">Inactivos</option>
                <option value="suspendido">Suspendidos</option>
              </select>
              <select value={orden} onChange={e => setOrden(e.target.value as any)}
                className="border border-gray-200 rounded-xl px-2 py-1.5 text-[11px] focus:outline-none focus:border-[#0b315f]">
                <option value="riesgo">Riesgo primero</option>
                <option value="az">A–Z</option>
                <option value="flota">Más vehículos</option>
              </select>
            </div>
            <select value={filtroDistrito} onChange={e => setFiltroDistrito(e.target.value)}
              className="w-full border border-gray-200 rounded-xl px-2 py-1.5 text-[11px] focus:outline-none focus:border-[#0b315f]"
              title="Ordena por cercanía de cochera al distrito elegido, sin ocultar a nadie">
              <option value="">📍 Cercano a un distrito…</option>
              {DISTRITOS_LIMA.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            {selFueraDeFiltro && (
              <p className="text-[10px] text-amber-700 bg-amber-50 rounded-lg px-2 py-1">
                1 seleccionada fuera del filtro
              </p>
            )}
          </div>

          <div className="bg-white border border-t-0 overflow-y-auto h-[calc(100vh-330px)] min-h-[420px]">
            {loading ? (
              <div className="p-6 text-center text-gray-400 text-xs">Cargando…</div>
            ) : listaFiltrada.length === 0 ? (
              <div className="p-6 text-center text-gray-400">
                <p className="text-2xl mb-1">🚌</p>
                <p className="text-xs">{empresas.length === 0 ? "Sin empresas registradas" : "Ningún proveedor con estos filtros"}</p>
              </div>
            ) : listaFiltrada.slice(0, limiteLista).map(e => {
              const r = riesgoPorEmp[e.id];
              const activa = empresaSel === e.id;
              const franja = activa ? "#0b315f" : r?.nivel === "alto" ? "#dc2626" : r?.nivel === "medio" ? "#eab308" : "#d1d5db";
              const motivo = motivoMatch(e.id);
              const distanciaTxt = filtroDistrito ? etiquetaDistancia(distanciaEmpresa(e.id, filtroDistrito), filtroDistrito) : null;
              return (
                <button key={e.id} onClick={() => setEmpresaSel(e.id)}
                  className="w-full text-left flex items-center gap-2 pl-0 pr-2.5 py-2 border-b hover:bg-gray-50 transition-colors"
                  style={{ borderColor: "#f1f5f9", background: activa ? "#eef3f8" : undefined }}>
                  <span className="w-[3px] self-stretch rounded-r flex-shrink-0" style={{ background: franja }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-bold truncate" style={{ color: activa ? "#0b315f" : "#111827" }}>
                      {e.razon_social}
                    </span>
                    {distanciaTxt
                      ? <span className="block text-[10px] font-bold truncate" style={{ color: distanciaTxt.startsWith("🎯") ? "#166534" : "#854d0e" }}>{distanciaTxt}</span>
                      : motivo
                      ? <span className="block text-[10px] text-[#0b315f] truncate">coincide {motivo}</span>
                      : e.estado !== "activo" && <span className="block text-[10px] text-red-500 uppercase font-bold">{e.estado}</span>}
                  </span>
                  {r?.venc ? (
                    <span className="text-[10px] font-black rounded px-1.5 py-0.5 flex-shrink-0" style={{ background: "#fee2e2", color: "#991b1b" }}>
                      {r.venc} venc.
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono text-gray-400 flex-shrink-0">{porEmpresa.vehs[e.id]?.length || 0} veh</span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="bg-white rounded-b-2xl border border-t-0 px-3 py-2">
            {listaFiltrada.length > limiteLista ? (
              <button onClick={() => setLimiteLista(l => l + 60)}
                className="w-full text-[11px] font-bold text-[#0b315f] hover:underline py-1">
                Cargar más ({listaFiltrada.length - limiteLista} restantes)
              </button>
            ) : (
              <p className="text-[10px] text-gray-300 text-center py-1">— fin de la lista —</p>
            )}
          </div>
        </div>

        {/* Detalle empresa seleccionada */}
        <div className={`space-y-4 ${empresaSel ? "block" : "hidden xl:block"}`}>
          {!empActual ? (
            <div className="bg-white rounded-2xl border p-10 text-center text-gray-400">
              <p className="text-3xl mb-2">🚌</p>
              <p className="font-medium">Busca una placa o selecciona un proveedor</p>
              <p className="text-xs mt-1">Pulsa <kbd className="font-mono border rounded px-1">/</kbd> para saltar al buscador</p>
            </div>
          ) : (
            <>
              {/* Header empresa */}
              <div className="bg-white rounded-2xl border shadow-sm p-4">
                <button onClick={() => setEmpresaSel(null)}
                  className="xl:hidden text-[11px] font-bold text-[#0b315f] mb-2">← Proveedores</button>

                <div className="flex items-start justify-between flex-wrap gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-xl font-black text-gray-900">{empActual.razon_social}</h2>
                      <span className="text-xs font-bold px-2.5 py-0.5 rounded-lg"
                        style={{ background: empActual.estado === "activo" ? "#dcfce7" : "#fee2e2", color: empActual.estado === "activo" ? "#166634" : "#991b1b" }}>
                        {empActual.estado.charAt(0).toUpperCase() + empActual.estado.slice(1)}
                      </span>
                      {aptitudEmp && <ChipVeredicto nivel={aptitudEmp.nivel} causa={aptitudEmp.causa} />}
                    </div>
                    <p className="text-xs text-gray-400 mt-1 flex items-center gap-3 flex-wrap">
                      {empActual.ruc && <span className="font-mono">RUC: {empActual.ruc}</span>}
                      {empActual.telefono && (
                        <span className="flex items-center gap-1">
                          <a href={`tel:+${telE164(empActual.telefono)}`} className="hover:underline">📱 {empActual.telefono}</a>
                          <AccionesContacto tel={empActual.telefono} chico />
                        </span>
                      )}
                      {empActual.email && <a href={`mailto:${empActual.email}`} className="hover:underline">✉️ {empActual.email}</a>}
                      {empActual.distrito_cochera && (
                        <span title={empActual.direccion_cochera || undefined}>🅿️ Cochera: {empActual.distrito_cochera}</span>
                      )}
                    </p>
                    {empActual.contacto_nombre && (
                      <p className="text-xs text-gray-500 mt-1 flex items-center gap-1.5">
                        Contacto: <b>{empActual.contacto_nombre}</b>
                        {empActual.contacto_telefono && <span className="text-gray-400">· {empActual.contacto_telefono}</span>}
                        <AccionesContacto tel={empActual.contacto_telefono} chico />
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    <button onClick={() => editarEmpresa(empActual)}
                      className="text-[11px] font-bold px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">✏️ Editar</button>
                    <button onClick={() => { setConfirmarBorrado(empActual); setTextoBorrado(""); }}
                      className="text-[11px] font-bold px-3 py-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50">✕ Eliminar</button>
                  </div>
                </div>

                {/* Habilitaciones: chips en línea si ambas están vigentes; tarjetas cuando
                    hay algo que atender. */}
                {(() => {
                  const habs = [
                    { label: "MTC", full: "Autorización MTC", num: empActual.autorizacion_mtc, venc: empActual.venc_autorizacion },
                    { label: "SUTRAN", full: "Habilitación SUTRAN", num: empActual.habilitacion_sutran, venc: empActual.venc_habilitacion },
                  ];
                  const hayQueAtender = habs.some(h => ["vencido", "por_vencer"].includes(estadoDoc(h.venc)));
                  if (!hayQueAtender) {
                    return (
                      <div className="flex gap-2 mt-3 flex-wrap">
                        {habs.map(h => {
                          const cfg = ESTADO_DOC_CFG[estadoDoc(h.venc)];
                          return (
                            <span key={h.label} className="inline-flex items-center gap-1.5 text-[11px] rounded-lg px-2.5 py-1 border" style={{ borderColor: "#e5e7eb" }}>
                              <span className="font-bold text-gray-400">{h.label}</span>
                              <span className="font-mono font-bold text-gray-700">{h.num || "—"}</span>
                              <span className="w-1.5 h-1.5 rounded-full" style={{ background: cfg.dot }} />
                              <span className="text-gray-400">{h.venc ? `vence ${fmtFecha(h.venc)}` : "sin fecha"}</span>
                            </span>
                          );
                        })}
                      </div>
                    );
                  }
                  return (
                    <div className="grid grid-cols-2 gap-3 mt-3">
                      {habs.map(h => {
                        const est = estadoDoc(h.venc);
                        const cfg = ESTADO_DOC_CFG[est];
                        return (
                          <div key={h.label} className="rounded-xl px-3 py-2.5 border" style={{ background: cfg.bg + "44" }}>
                            <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{h.full}</p>
                            <p className="font-mono font-bold text-sm text-gray-800">{h.num || "—"}</p>
                            <div className="flex items-center gap-1.5 mt-1">
                              <div className="w-2 h-2 rounded-full" style={{ background: cfg.dot }} />
                              <span className="text-[10px] font-bold" style={{ color: cfg.color }}>
                                {h.venc ? `${cfg.label} · ${fmtFecha(h.venc)}` : "Sin fecha"}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                {/* Alertas empresa */}
                {riesgoEmp === "alto" && (
                  <div className="mt-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-xs text-red-800 space-y-1">
                    <p className="font-black">🚨 RIESGO ALTO — No asignar a servicios hasta resolver:</p>
                    {docsVencOblig.map(d => {
                      const veh = vehEmpresa.find(v => v.id === d.vehiculo_id);
                      const dias = diasPara(d.fecha_vencimiento);
                      return (
                        <p key={d.id}>
                          · <b>{d.tipo}</b> vencido{dias !== null ? ` hace ${Math.abs(dias)} d` : ""} —{" "}
                          {veh ? <span className="font-mono font-bold">{veh.placa}</span> : "empresa (general)"}
                        </p>
                      );
                    })}
                    {licVencidas.map(c => <p key={c.id}>· Licencia vencida: <b>{c.nombre}</b></p>)}
                    {estadoDoc(empActual.venc_autorizacion) === "vencido" && <p>· <b>Autorización MTC</b> vencida</p>}
                    {estadoDoc(empActual.venc_habilitacion) === "vencido" && <p>· <b>Habilitación SUTRAN</b> vencida</p>}
                    <button onClick={() => { setTabActiva("documentos"); setFiltroDoc("vencido"); }}
                      className="font-bold underline">Ver documentos →</button>
                  </div>
                )}
                {riesgoEmp === "medio" && docsPorVOblig.length > 0 && (
                  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-center justify-between gap-2 flex-wrap">
                    <span>⚠️ {docsPorVOblig.length} documento{docsPorVOblig.length > 1 ? "s" : ""} obligatorio{docsPorVOblig.length > 1 ? "s" : ""} por vencer — renovar antes de asignar</span>
                    <button onClick={() => { setTabActiva("documentos"); setFiltroDoc("por_vencer"); }}
                      className="font-bold underline">Ver documentos →</button>
                  </div>
                )}
                {docEmpresa.length === 0 && !cargandoDetalle && (
                  <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 flex items-center justify-between gap-2 flex-wrap">
                    <span>📄 Este proveedor no tiene ningún documento cargado — el semáforo no puede validarlo.</span>
                    <button onClick={() => { setTabActiva("documentos"); setFormDoc(FORM_DOC); setEditDocId(null); setMostrarFormDoc(true); }}
                      className="font-bold underline text-[#0b315f]">Cargar documentos →</button>
                  </div>
                )}
              </div>

              {/* PESTAÑAS */}
              <div className="flex gap-1 border-b bg-white rounded-t-xl px-4 pt-3">
                {([
                  ["flota",      `🚌 Flota (${vehEmpresa.length})`],
                  ["conductores",`👤 Conductores (${condEmpresa.length})`],
                  ["documentos", `📄 Documentos (${docEmpresa.length})`],
                ] as [TabActiva, string][]).map(([t, l]) => (
                  <button key={t} onClick={() => setTabActiva(t)}
                    className="px-4 py-2 text-sm font-bold border-b-2 -mb-px transition-all"
                    style={{ borderColor: tabActiva === t ? "#0b315f" : "transparent", color: tabActiva === t ? "#0b315f" : "#9ca3af" }}>
                    {l}
                  </button>
                ))}
                {cargandoDetalle && <span className="ml-auto text-[11px] text-gray-400 py-2">cargando…</span>}
              </div>

              {/* ── TAB: FLOTA ── */}
              {tabActiva === "flota" && (
                <div className="bg-white rounded-b-2xl border shadow-sm p-4 space-y-3">
                  <div className="flex justify-between items-center gap-3 flex-wrap">
                    <div className="relative flex-1 min-w-[180px] max-w-sm">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs pointer-events-none">🔍</span>
                      <input value={busqFlota} onChange={e => setBusqFlota(e.target.value)}
                        placeholder="Filtrar placa, marca o modelo…"
                        className="w-full border border-gray-200 rounded-xl pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:border-[#0b315f]" />
                    </div>
                    <Segmented valor={filtroEstVeh} onChange={setFiltroEstVeh}
                      ops={[["todos", "Todos"], ["disponible", "Disponibles"], ["ocupado", "Ocupados"], ["inactivo", "Inactivos"]]} />
                    <Segmented valor={vistaFlota} onChange={v => setVistaFlota(v)}
                      ops={[["tabla", "☰ Tabla"], ["fichas", "▦ Fichas"]] as ["tabla" | "fichas", string][]} />
                    <button onClick={() => { setFormVeh(FORM_VEH); setEditVehId(null); setMostrarFormVeh(v => !v); }}
                      className="px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#0b315f" }}>
                      + Agregar vehículo
                    </button>
                  </div>
                  {mostrarFormVeh && (
                    <div className="rounded-xl border p-4 bg-gray-50 space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        <Campo label="Placa *">
                          <input className={inputCls("font-mono uppercase")} placeholder="ABC-123"
                            value={formVeh.placa} onChange={e => setFormVeh(p => ({ ...p, placa: e.target.value }))} />
                        </Campo>
                        <Campo label="Categoría">
                          <select className={inputCls()} value={formVeh.categoria}
                            onChange={e => setFormVeh(p => ({ ...p, categoria: e.target.value }))}>
                            {["AUTO","SUV","VAN","MINIBUS","BUS","CUSTER"].map(c => <option key={c}>{c}</option>)}
                          </select>
                        </Campo>
                        <Campo label="Categoría de costeo">
                          <select className={inputCls()} value={formVeh.tipo_vehiculo_costeo}
                            onChange={e => setFormVeh(p => ({ ...p, tipo_vehiculo_costeo: e.target.value }))}>
                            <option value="">— sin asignar —</option>
                            {paramsVeh.map(p => <option key={p.tipo_vehiculo} value={p.tipo_vehiculo}>{p.nombre} ({p.tipo_vehiculo})</option>)}
                          </select>
                        </Campo>
                        <Campo label="Capacidad pax">
                          <input type="number" className={inputCls()} placeholder="45"
                            value={formVeh.capacidad} onChange={e => setFormVeh(p => ({ ...p, capacidad: e.target.value }))} />
                        </Campo>
                        <Campo label="Marca">
                          <input className={inputCls()} placeholder="Mercedes Benz"
                            value={formVeh.marca} onChange={e => setFormVeh(p => ({ ...p, marca: e.target.value }))} />
                        </Campo>
                        <Campo label="Modelo">
                          <input className={inputCls()} value={formVeh.modelo}
                            onChange={e => setFormVeh(p => ({ ...p, modelo: e.target.value }))} />
                        </Campo>
                        <Campo label="Estado">
                          <select className={inputCls()} value={formVeh.estado}
                            onChange={e => setFormVeh(p => ({ ...p, estado: e.target.value }))}>
                            <option value="disponible">Disponible</option>
                            <option value="ocupado">Ocupado</option>
                            <option value="inactivo">Inactivo</option>
                          </select>
                        </Campo>
                        <Campo label="Distrito de cochera (si difiere del de la empresa)">
                          <select className={inputCls()} value={formVeh.distrito_cochera}
                            onChange={e => setFormVeh(p => ({ ...p, distrito_cochera: e.target.value }))}>
                            <option value="">— Usa el de la empresa —</option>
                            {DISTRITOS_LIMA.map(d => <option key={d} value={d}>{d}</option>)}
                          </select>
                        </Campo>
                        <Campo label="Foto exterior">
                          <div className="space-y-1.5">
                            {formVeh.foto_externa_url && (
                              <div className="relative">
                                <img src={formVeh.foto_externa_url} alt="Foto exterior" className="w-full h-24 object-cover rounded-xl border" />
                                <button type="button" onClick={() => setFormVeh(p => ({ ...p, foto_externa_url: "" }))}
                                  className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-[10px] flex items-center justify-center hover:bg-black/80">✕</button>
                              </div>
                            )}
                            <label className={`flex items-center gap-2 cursor-pointer w-full border border-dashed border-gray-300 rounded-xl px-3 py-2 text-xs text-gray-500 hover:border-[#0b315f] hover:text-[#0b315f] transition-all ${subiendoFoto === "externa" ? "opacity-60 pointer-events-none" : ""}`}>
                              <span>{subiendoFoto === "externa" ? "⏳ Subiendo..." : "📷 Subir foto exterior"}</span>
                              <input type="file" accept="image/*" className="hidden" disabled={subiendoFoto !== null}
                                onChange={async e => {
                                  const f = e.target.files?.[0]; if (!f) return;
                                  setSubiendoFoto("externa");
                                  const url = await subirFotoVeh(f, "externa");
                                  if (url) setFormVeh(p => ({ ...p, foto_externa_url: url }));
                                  setSubiendoFoto(null); e.target.value = "";
                                }} />
                            </label>
                          </div>
                        </Campo>
                        <Campo label="Foto interior">
                          <div className="space-y-1.5">
                            {formVeh.foto_interna_url && (
                              <div className="relative">
                                <img src={formVeh.foto_interna_url} alt="Foto interior" className="w-full h-24 object-cover rounded-xl border" />
                                <button type="button" onClick={() => setFormVeh(p => ({ ...p, foto_interna_url: "" }))}
                                  className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 text-white text-[10px] flex items-center justify-center hover:bg-black/80">✕</button>
                              </div>
                            )}
                            <label className={`flex items-center gap-2 cursor-pointer w-full border border-dashed border-gray-300 rounded-xl px-3 py-2 text-xs text-gray-500 hover:border-[#0b315f] hover:text-[#0b315f] transition-all ${subiendoFoto === "interna" ? "opacity-60 pointer-events-none" : ""}`}>
                              <span>{subiendoFoto === "interna" ? "⏳ Subiendo..." : "🪑 Subir foto interior"}</span>
                              <input type="file" accept="image/*" className="hidden" disabled={subiendoFoto !== null}
                                onChange={async e => {
                                  const f = e.target.files?.[0]; if (!f) return;
                                  setSubiendoFoto("interna");
                                  const url = await subirFotoVeh(f, "interna");
                                  if (url) setFormVeh(p => ({ ...p, foto_interna_url: url }));
                                  setSubiendoFoto(null); e.target.value = "";
                                }} />
                            </label>
                          </div>
                        </Campo>
                        <Campo label="Características de la unidad" span={3}>
                          <textarea
                            rows={3}
                            className={inputCls("resize-none")}
                            placeholder="Ej: Bus con capacidad para 50 pasajeros, A/C, asientos reclinables, bodega, GPS, sistema de audio/video."
                            value={formVeh.descripcion_unidad}
                            onChange={e => setFormVeh(p => ({ ...p, descripcion_unidad: e.target.value }))}
                          />
                        </Campo>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={guardarVehiculo} disabled={guardando}
                          className="px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#0b315f" }}>
                          {guardando ? "..." : editVehId ? "Actualizar" : "Guardar"}
                        </button>
                        <button onClick={() => { setFormVeh(FORM_VEH); setEditVehId(null); setMostrarFormVeh(false); }}
                          className="px-4 py-2 rounded-xl text-xs font-bold border text-gray-600">Cancelar</button>
                      </div>
                    </div>
                  )}

                  {flotaFiltrada.length === 0 ? (
                    <p className="text-center text-gray-400 py-6 text-sm">
                      {vehEmpresa.length === 0 ? "Sin vehículos registrados" : "Ninguna unidad con ese filtro"}
                    </p>
                  ) : vistaFlota === "tabla" ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                            {["", "Placa", "Cat.", "Marca / Modelo", "Pax", "Km actual", "Docs", "Estado", ""].map((h, i) => (
                              <th key={i} className="p-2 text-left font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {flotaFiltrada.slice(0, limiteFlota).map(v => {
                            const apt = calcAptitud(v, empActual, docEmpresa, condEmpresa);
                            const abierto = vehExpandido === v.id;
                            const resaltada = resaltarVeh === v.id;
                            return (
                              <React.Fragment key={v.id}>
                                <tr id={`veh-${v.id}`} className="border-t cursor-pointer hover:bg-gray-50"
                                  style={{ borderColor: "#f1f5f9", boxShadow: resaltada ? "inset 0 0 0 2px #0b315f" : undefined }}
                                  onClick={() => setVehExpandido(abierto ? null : v.id)}>
                                  <td className="p-2 text-gray-300 w-4">{abierto ? "▾" : "▸"}</td>
                                  <td className="p-2 font-mono font-black text-gray-900">{v.placa}</td>
                                  <td className="p-2 text-gray-500">{v.categoria || "—"}</td>
                                  <td className="p-2 text-gray-500">{[v.marca, v.modelo].filter(Boolean).join(" ") || "—"}</td>
                                  <td className="p-2 text-gray-500">{v.capacidad ?? "—"}</td>
                                  <td className="p-2 font-mono text-gray-700">
                                    {v.kilometraje_actual != null ? Number(v.kilometraje_actual).toLocaleString("es-PE") : "—"}
                                    {(odoPorVeh[v.id] ?? 0) > 0 && (
                                      <span className="ml-1 text-[10px] font-bold text-amber-700 bg-amber-100 px-1 py-0.5 rounded">⚠ {odoPorVeh[v.id]}</span>
                                    )}
                                  </td>
                                  <td className="p-2">
                                    <span className="inline-flex items-center gap-1" style={{ color: NIVEL_CFG[apt.nivel].color }}>
                                      <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: NIVEL_CFG[apt.nivel].borde }} />
                                      <span className="font-bold text-[10px]">{apt.nivel === "ok" ? "OK" : apt.causa}</span>
                                    </span>
                                  </td>
                                  <td className="p-2">
                                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg"
                                      style={{ background: v.estado === "disponible" ? "#dcfce7" : "#f3f4f6", color: v.estado === "disponible" ? "#166534" : "#4b5563" }}>
                                      {v.estado}
                                    </span>
                                  </td>
                                  <td className="p-2">
                                    <div className="flex gap-1.5" onClick={ev => ev.stopPropagation()}>
                                      <button onClick={() => setModalOdoVeh(v)} title="Odómetro" className="hover:opacity-70">📷</button>
                                      <button title="Editar" className="text-gray-400 hover:text-gray-800"
                                        onClick={() => { setFormVeh({ placa: v.placa, categoria: v.categoria || "BUS", marca: v.marca || "", modelo: v.modelo || "", capacidad: v.capacidad ? String(v.capacidad) : "", estado: v.estado, foto_externa_url: v.foto_externa_url || "", foto_interna_url: v.foto_interna_url || "", descripcion_unidad: v.descripcion_unidad || "", tipo_vehiculo_costeo: v.tipo_vehiculo_costeo || "", distrito_cochera: v.distrito_cochera || "" }); setEditVehId(v.id); setMostrarFormVeh(true); }}>✏️</button>
                                      <button className="text-red-400 hover:text-red-600" title="Eliminar"
                                        onClick={async () => { if (!confirm(`¿Eliminar la unidad ${v.placa}?`)) return; await supabase.from("vehiculos_tercero").delete().eq("id", v.id); await Promise.all([refrescarDetalle(empresaSel), cargarIndice()]); }}>✕</button>
                                    </div>
                                  </td>
                                </tr>
                                {abierto && (
                                  <tr style={{ background: "#f8fafc" }}>
                                    <td colSpan={9} className="p-3">
                                      <div className="flex gap-3 flex-wrap">
                                        {v.foto_externa_url
                                          ? <img src={v.foto_externa_url} alt="Exterior" loading="lazy" className="w-48 h-28 object-cover rounded-xl border" />
                                          : <div className="w-48 h-28 rounded-xl border bg-gray-100 flex items-center justify-center text-[10px] text-gray-400">Sin foto ext.</div>}
                                        {v.foto_interna_url
                                          ? <img src={v.foto_interna_url} alt="Interior" loading="lazy" className="w-48 h-28 object-cover rounded-xl border" />
                                          : <div className="w-48 h-28 rounded-xl border bg-gray-100 flex items-center justify-center text-[10px] text-gray-400">Sin foto int.</div>}
                                        <div className="flex-1 min-w-[200px]">
                                          <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Características</p>
                                          <p className="text-xs text-gray-600">{v.descripcion_unidad || "Sin descripción registrada."}</p>
                                          {v.tipo_vehiculo_costeo && (
                                            <p className="text-[10px] text-gray-400 mt-1.5">Costeo: <span className="font-mono">{v.tipo_vehiculo_costeo}</span></p>
                                          )}
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
                      {flotaFiltrada.length > limiteFlota && (
                        <button onClick={() => setLimiteFlota(l => l + 50)}
                          className="w-full text-[11px] font-bold text-[#0b315f] hover:underline py-2">
                          Cargar más ({flotaFiltrada.length - limiteFlota} restantes)
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {flotaFiltrada.slice(0, limiteFlota).map(v => (
                          <div key={v.id} id={`veh-${v.id}`} className="rounded-xl border overflow-hidden"
                            style={{ boxShadow: resaltarVeh === v.id ? "inset 0 0 0 2px #0b315f" : undefined }}>
                            {(v.foto_externa_url || v.foto_interna_url) && (
                              <div className="grid grid-cols-2 gap-0.5 bg-gray-100">
                                {v.foto_externa_url
                                  ? <img src={v.foto_externa_url} alt="Exterior" loading="lazy" className="w-full h-28 object-cover" />
                                  : <div className="h-28 bg-gray-100 flex items-center justify-center text-xs text-gray-400">Sin foto ext.</div>}
                                {v.foto_interna_url
                                  ? <img src={v.foto_interna_url} alt="Interior" loading="lazy" className="w-full h-28 object-cover" />
                                  : <div className="h-28 bg-gray-100 flex items-center justify-center text-xs text-gray-400">Sin foto int.</div>}
                              </div>
                            )}
                            <div className="flex items-center gap-3 px-4 py-3">
                              {!v.foto_externa_url && !v.foto_interna_url && <span className="text-2xl">🚌</span>}
                              <div className="flex-1">
                                <p className="font-black font-mono text-gray-900">{v.placa}</p>
                                <p className="text-xs text-gray-400">{v.categoria} · {v.marca} {v.modelo}{v.capacidad ? ` · ${v.capacidad} pax` : ""}</p>
                                {v.descripcion_unidad && (
                                  <p className="text-[10px] text-gray-500 mt-0.5 line-clamp-2">{v.descripcion_unidad}</p>
                                )}
                                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                  <span className="text-[11px] font-mono font-bold text-gray-700">
                                    {v.kilometraje_actual != null ? `${Number(v.kilometraje_actual).toLocaleString("es-PE")} km` : "Sin km"}
                                  </span>
                                  {(odoPorVeh[v.id] ?? 0) > 0 && (
                                    <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">⚠ {odoPorVeh[v.id]} por revisar</span>
                                  )}
                                  <button onClick={() => setModalOdoVeh(v)}
                                    className="text-[11px] font-bold text-[#0b315f] hover:underline">📷 Odómetro</button>
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-bold px-2 py-0.5 rounded-lg"
                                  style={{ background: v.estado === "disponible" ? "#dcfce7" : "#f3f4f6", color: v.estado === "disponible" ? "#166534" : "#4b5563" }}>
                                  {v.estado}
                                </span>
                                <button onClick={() => { setFormVeh({ placa: v.placa, categoria: v.categoria || "BUS", marca: v.marca || "", modelo: v.modelo || "", capacidad: v.capacidad ? String(v.capacidad) : "", estado: v.estado, foto_externa_url: v.foto_externa_url || "", foto_interna_url: v.foto_interna_url || "", descripcion_unidad: v.descripcion_unidad || "", tipo_vehiculo_costeo: v.tipo_vehiculo_costeo || "", distrito_cochera: v.distrito_cochera || "" }); setEditVehId(v.id); setMostrarFormVeh(true); }}
                                  className="text-xs font-bold text-gray-500 hover:text-gray-800">✏️</button>
                                <button onClick={async () => { if (!confirm("¿Eliminar?")) return; await supabase.from("vehiculos_tercero").delete().eq("id", v.id); await Promise.all([refrescarDetalle(empresaSel), cargarIndice()]); }}
                                  className="text-xs font-bold text-red-400 hover:text-red-600">✕</button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      {flotaFiltrada.length > limiteFlota && (
                        <button onClick={() => setLimiteFlota(l => l + 50)}
                          className="w-full text-[11px] font-bold text-[#0b315f] hover:underline py-2">
                          Cargar más ({flotaFiltrada.length - limiteFlota} restantes)
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* ── TAB: CONDUCTORES ── */}
              {tabActiva === "conductores" && (
                <div className="bg-white rounded-b-2xl border shadow-sm p-4 space-y-3">
                  <div className="flex justify-between items-center gap-3 flex-wrap">
                    <div className="relative flex-1 min-w-[180px] max-w-sm">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs pointer-events-none">🔍</span>
                      <input value={busqCond} onChange={e => setBusqCond(e.target.value)}
                        placeholder="Nombre, DNI o licencia…"
                        className="w-full border border-gray-200 rounded-xl pl-8 pr-3 py-1.5 text-xs focus:outline-none focus:border-[#0b315f]" />
                    </div>
                    <Segmented valor={filtroLic} onChange={setFiltroLic}
                      ops={[["todos", "Todos"], ["vencida", "🔴 Vencida"], ["por_vencer", "⚠️ Por vencer"], ["app", "📱 Con app"]] as ["todos" | "vencida" | "por_vencer" | "app", string][]} />
                    <button onClick={() => { setFormCond(FORM_COND); setEditCondId(null); setMostrarFormCond(v => !v); }}
                      className="px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#0b315f" }}>
                      + Agregar conductor
                    </button>
                  </div>
                  {mostrarFormCond && (
                    <div className="rounded-xl border p-4 bg-gray-50 space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        <Campo label="Nombre *">
                          <input className={inputCls()} value={formCond.nombre} onChange={e => setFormCond(p => ({ ...p, nombre: e.target.value }))} />
                        </Campo>
                        <Campo label="DNI">
                          <input className={inputCls("font-mono")} maxLength={8} value={formCond.dni} onChange={e => setFormCond(p => ({ ...p, dni: e.target.value }))} />
                        </Campo>
                        <Campo label="Licencia">
                          <input className={inputCls("font-mono uppercase")} value={formCond.licencia} onChange={e => setFormCond(p => ({ ...p, licencia: e.target.value }))} />
                        </Campo>
                        <Campo label="Categoría">
                          <select className={inputCls()} value={formCond.categoria_licencia} onChange={e => setFormCond(p => ({ ...p, categoria_licencia: e.target.value }))}>
                            {["A-I","A-IIa","A-IIb","A-IIIa","A-IIIb","A-IIIc"].map(c => <option key={c}>{c}</option>)}
                          </select>
                        </Campo>
                        <Campo label="Venc. licencia">
                          <input type="date" className={inputCls()} value={formCond.vencimiento_licencia} onChange={e => setFormCond(p => ({ ...p, vencimiento_licencia: e.target.value }))} />
                        </Campo>
                        <Campo label="Teléfono">
                          <input className={inputCls()} value={formCond.telefono} onChange={e => setFormCond(p => ({ ...p, telefono: e.target.value }))} />
                        </Campo>
                        <Campo label="Correo">
                          <input type="email" className={inputCls()} placeholder="conductor@empresa.com"
                            value={formCond.email} onChange={e => setFormCond(p => ({ ...p, email: e.target.value }))} />
                        </Campo>
                        <Campo label="PIN acceso app (4 dígitos)">
                          <input className={inputCls("font-mono")} type="text" inputMode="numeric" maxLength={4}
                            placeholder="Ej: 1234" value={formCond.pin_acceso} onChange={e => setFormCond(p => ({ ...p, pin_acceso: e.target.value.replace(/\D/g, "").slice(0, 4) }))} />
                        </Campo>
                        <div className="flex items-center gap-2 pt-5">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" className="w-4 h-4 accent-[#0b315f]" checked={formCond.activo_app}
                              onChange={e => setFormCond(p => ({ ...p, activo_app: e.target.checked }))} />
                            <span className="text-xs font-semibold text-gray-700">Activo en app</span>
                          </label>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={guardarConductor} disabled={guardando}
                          className="px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#0b315f" }}>
                          {guardando ? "..." : editCondId ? "Actualizar" : "Guardar"}
                        </button>
                        <button onClick={() => { setFormCond(FORM_COND); setEditCondId(null); setMostrarFormCond(false); }}
                          className="px-4 py-2 rounded-xl text-xs font-bold border text-gray-600">Cancelar</button>
                      </div>
                    </div>
                  )}
                  {condFiltrados.length === 0 ? (
                    <p className="text-center text-gray-400 py-6 text-sm">
                      {condEmpresa.length === 0 ? "Sin conductores registrados" : "Ningún conductor con ese filtro"}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {condFiltrados.slice(0, limiteCond).map(c => {
                        const dias = diasPara(c.vencimiento_licencia);
                        const licEst = dias === null ? "sin_fecha" : dias < 0 ? "vencida" : dias <= 30 ? "por_vencer" : "vigente";
                        const licColor = licEst === "vencida" ? "#dc2626" : licEst === "por_vencer" ? "#d97706" : "#166534";
                        return (
                          <div key={c.id} className="flex items-center gap-3 rounded-xl border px-4 py-3"
                            style={{ borderColor: licEst === "vencida" ? "#fca5a5" : "#e5e7eb", background: licEst === "vencida" ? "#fff5f5" : "white" }}>
                            <div className="w-9 h-9 rounded-full flex items-center justify-center font-black text-white text-sm flex-shrink-0" style={{ background: "#0b315f" }}>
                              {c.nombre.charAt(0)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-bold text-gray-900">{c.nombre}</p>
                              <p className="text-xs text-gray-400 flex items-center gap-2 flex-wrap">
                                {c.licencia && <span className="font-mono">{c.licencia}</span>}
                                {c.categoria_licencia && <span>Cat. {c.categoria_licencia}</span>}
                                {c.telefono && <span className="flex items-center gap-1">📱 {c.telefono} <AccionesContacto tel={c.telefono} chico /></span>}
                                {c.activo_app && <span className="text-[10px] font-bold text-[#0b315f] bg-[#eef3f8] px-1.5 py-0.5 rounded">app</span>}
                              </p>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <div className="text-xs font-bold" style={{ color: licColor }}>
                                {licEst === "vencida" ? "🔴 Vencida" : licEst === "por_vencer" ? `⚠️ ${dias}d` : licEst === "vigente" ? `✅ ${dias}d` : "Sin fecha"}
                              </div>
                              <p className="text-[10px] text-gray-400">{fmtFecha(c.vencimiento_licencia)}</p>
                            </div>
                            <div className="flex gap-1">
                              <button onClick={() => { setFormCond({ nombre: c.nombre, dni: c.dni || "", licencia: c.licencia || "", categoria_licencia: c.categoria_licencia || "A-IIb", vencimiento_licencia: c.vencimiento_licencia || "", telefono: c.telefono || "", email: c.email || "", estado: c.estado || "disponible", pin_acceso: c.pin_acceso || "", activo_app: c.activo_app || false }); setEditCondId(c.id); setMostrarFormCond(true); }}
                                className="text-xs font-bold text-gray-400 hover:text-gray-800">✏️</button>
                              <button onClick={async () => { if (!confirm("¿Eliminar?")) return; await supabase.from("conductores_tercero").delete().eq("id", c.id); await Promise.all([refrescarDetalle(empresaSel), cargarIndice()]); }}
                                className="text-xs font-bold text-red-400 hover:text-red-600">✕</button>
                            </div>
                          </div>
                        );
                      })}
                      {condFiltrados.length > limiteCond && (
                        <button onClick={() => setLimiteCond(l => l + 50)}
                          className="w-full text-[11px] font-bold text-[#0b315f] hover:underline py-2">
                          Cargar más ({condFiltrados.length - limiteCond} restantes)
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ── TAB: DOCUMENTOS ── */}
              {tabActiva === "documentos" && (
                <div className="bg-white rounded-b-2xl border shadow-sm p-4 space-y-3">
                  <div className="flex justify-between items-center gap-3 flex-wrap">
                    <Segmented valor={filtroDoc} onChange={setFiltroDoc}
                      ops={[["todos", "Todos"], ["vencido", "Vencidos"], ["por_vencer", "Por vencer"], ["vigente", "Vigentes"], ["sin_fecha", "Sin fecha"]] as ["todos" | "vencido" | "por_vencer" | "vigente" | "sin_fecha", string][]} />
                    <select value={filtroDocVeh} onChange={e => setFiltroDocVeh(e.target.value)}
                      className="border border-gray-200 rounded-xl px-2 py-1.5 text-xs focus:outline-none focus:border-[#0b315f]">
                      <option value="">Todas las unidades</option>
                      <option value="empresa">Solo empresa (general)</option>
                      {vehEmpresa.map(v => <option key={v.id} value={v.id}>{v.placa}</option>)}
                    </select>
                    <button onClick={() => { setFormDoc(FORM_DOC); setEditDocId(null); setMostrarFormDoc(v => !v); }}
                      className="px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#0b315f" }}>
                      + Agregar documento
                    </button>
                  </div>

                  {/* Obligatorios que ningún registro cubre: el semáforo por sí solo no los ve. */}
                  {(() => {
                    const faltan = docsObligFaltantes(docEmpresa);
                    if (!faltan.length || cargandoDetalle) return null;
                    return (
                      <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2">
                        <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1">Obligatorios sin registrar ({faltan.length})</p>
                        <div className="flex gap-1.5 flex-wrap">
                          {faltan.map(t => (
                            <button key={t} onClick={() => { setFormDoc({ ...FORM_DOC, tipo: t }); setEditDocId(null); setMostrarFormDoc(true); }}
                              className="text-[11px] font-bold px-2 py-0.5 rounded-lg border border-gray-300 bg-white text-gray-600 hover:border-[#0b315f] hover:text-[#0b315f]">
                              {TIPOS_DOC_TERCERO[t]?.icon} {t} +
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {mostrarFormDoc && (
                    <div className="rounded-xl border p-4 bg-gray-50 space-y-3">
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        <Campo label="Tipo *">
                          <select className={inputCls()} value={formDoc.tipo} onChange={e => setFormDoc(p => ({ ...p, tipo: e.target.value }))}>
                            {Object.entries(TIPOS_DOC_TERCERO).map(([k, v]) => <option key={k} value={k}>{v.icon} {k}</option>)}
                          </select>
                        </Campo>
                        <Campo label="Vehículo asociado">
                          <select className={inputCls()} value={formDoc.vehiculo_id} onChange={e => setFormDoc(p => ({ ...p, vehiculo_id: e.target.value }))}>
                            <option value="">Empresa (general)</option>
                            {vehEmpresa.map(v => <option key={v.id} value={v.id}>{v.placa}</option>)}
                          </select>
                        </Campo>
                        <Campo label="Número">
                          <input className={inputCls("font-mono")} value={formDoc.numero} onChange={e => setFormDoc(p => ({ ...p, numero: e.target.value }))} />
                        </Campo>
                        <Campo label="Fecha vencimiento">
                          <input type="date" className={inputCls()} value={formDoc.fecha_vencimiento} onChange={e => setFormDoc(p => ({ ...p, fecha_vencimiento: e.target.value }))} />
                        </Campo>
                        <Campo label="Entidad emisora">
                          <input className={inputCls()} value={formDoc.entidad_emisora} onChange={e => setFormDoc(p => ({ ...p, entidad_emisora: e.target.value }))} />
                        </Campo>
                        <Campo label="URL archivo">
                          <input className={inputCls()} placeholder="https://..." value={formDoc.archivo_url} onChange={e => setFormDoc(p => ({ ...p, archivo_url: e.target.value }))} />
                        </Campo>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={guardarDocumento} disabled={guardando}
                          className="px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#0b315f" }}>
                          {guardando ? "..." : editDocId ? "Actualizar" : "Guardar"}
                        </button>
                        <button onClick={() => { setFormDoc(FORM_DOC); setEditDocId(null); setMostrarFormDoc(false); }}
                          className="px-4 py-2 rounded-xl text-xs font-bold border text-gray-600">Cancelar</button>
                      </div>
                    </div>
                  )}
                  {docsFiltrados.length === 0 ? (
                    <p className="text-center text-gray-400 py-6 text-sm">
                      {docEmpresa.length === 0 ? "Sin documentos registrados" : "Ningún documento con ese filtro"}
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                            {["Tipo", "Vehículo", "Número", "Vencimiento", "Días", "Estado", "Archivo", ""].map(h => (
                              <th key={h} className="p-2 text-left font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {docsFiltrados.slice(0, limiteDoc).map(d => {
                            const est = estadoDoc(d.fecha_vencimiento);
                            const cfg = ESTADO_DOC_CFG[est];
                            const dias = diasPara(d.fecha_vencimiento);
                            const tipoCfg = TIPOS_DOC_TERCERO[d.tipo] || { icon: "📄", obligatorio: false };
                            // Solo entre las unidades de ESTA empresa: las secuencias de id de
                            // `vehiculos` y `vehiculos_tercero` se solapan.
                            const veh = vehEmpresa.find(v => v.id === d.vehiculo_id);
                            const rowBg = est === "vencido" ? "#fff5f5" : est === "por_vencer" ? "#fffbeb" : "white";
                            return (
                              <tr key={d.id} className="border-t" style={{ background: rowBg, borderColor: "#f1f5f9" }}>
                                <td className="p-2">
                                  <div className="flex items-center gap-1">
                                    <span>{tipoCfg.icon}</span>
                                    <span className="font-bold text-gray-800">{d.tipo}</span>
                                    {tipoCfg.obligatorio && <span className="text-[9px] text-red-500 font-bold">OBL</span>}
                                  </div>
                                </td>
                                <td className="p-2 font-mono text-[#0b315f]">{veh ? veh.placa : "Empresa"}</td>
                                <td className="p-2 font-mono text-gray-500">{d.numero || "—"}</td>
                                <td className="p-2">{fmtFecha(d.fecha_vencimiento)}</td>
                                <td className="p-2 font-black" style={{ color: dias !== null && dias < 0 ? "#dc2626" : dias !== null && dias <= 30 ? "#d97706" : "#166534" }}>
                                  {dias !== null ? (dias < 0 ? `${Math.abs(dias)}d venc.` : `${dias}d`) : "—"}
                                </td>
                                <td className="p-2">
                                  <span className="font-bold px-2 py-0.5 rounded-lg text-[10px]"
                                    style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                                </td>
                                <td className="p-2">
                                  {d.archivo_url
                                    ? <a href={d.archivo_url} target="_blank" rel="noreferrer" className="text-blue-500 font-bold underline">Ver</a>
                                    : <span className="text-gray-300">—</span>}
                                </td>
                                <td className="p-2">
                                  <div className="flex gap-1">
                                    <button onClick={() => { setFormDoc({ vehiculo_id: d.vehiculo_id ? String(d.vehiculo_id) : "", tipo: d.tipo, numero: d.numero || "", fecha_vencimiento: d.fecha_vencimiento || "", entidad_emisora: d.entidad_emisora || "", archivo_url: d.archivo_url || "", observaciones: d.observaciones || "" }); setEditDocId(d.id); setMostrarFormDoc(true); }}
                                      className="text-gray-400 hover:text-gray-800">✏️</button>
                                    <button onClick={async () => { if (!confirm("¿Eliminar?")) return; await supabase.from("documentos_tercero").delete().eq("id", d.id); await Promise.all([refrescarDetalle(empresaSel), cargarIndice()]); }}
                                      className="text-red-400 hover:text-red-600">✕</button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {docsFiltrados.length > limiteDoc && (
                        <button onClick={() => setLimiteDoc(l => l + 50)}
                          className="w-full text-[11px] font-bold text-[#0b315f] hover:underline py-2">
                          Cargar más ({docsFiltrados.length - limiteDoc} restantes)
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── MODAL: empresa (antes empujaba toda la página hacia abajo) ── */}
      {mostrarFormEmp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => { setFormEmp(FORM_EMP); setEditEmpId(null); setMostrarFormEmp(false); }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl p-6 space-y-5 max-h-[90vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900">{editEmpId ? "Editar empresa tercerizada" : "Nueva empresa tercerizada"}</h2>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos de la empresa</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label="Razón social *" span={2}><input className={inputCls()} placeholder="Transportes XYZ SAC" value={formEmp.razon_social} onChange={fe("razon_social")} /></Campo>
                <Campo label="RUC"><input className={inputCls("font-mono")} placeholder="20123456789" value={formEmp.ruc} onChange={fe("ruc")} /></Campo>
                <Campo label="Teléfono"><input className={inputCls()} value={formEmp.telefono} onChange={fe("telefono")} /></Campo>
                <Campo label="Email"><input className={inputCls()} value={formEmp.email} onChange={fe("email")} /></Campo>
                <Campo label="Estado">
                  <select className={inputCls()} value={formEmp.estado} onChange={fe("estado")}>
                    <option value="activo">Activo</option>
                    <option value="inactivo">Inactivo</option>
                    <option value="suspendido">Suspendido</option>
                  </select>
                </Campo>
                <Campo label="Contacto principal"><input className={inputCls()} value={formEmp.contacto_nombre} onChange={fe("contacto_nombre")} /></Campo>
                <Campo label="Teléfono contacto"><input className={inputCls()} value={formEmp.contacto_telefono} onChange={fe("contacto_telefono")} /></Campo>
              </div>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Ubicación</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Campo label="Dirección fiscal">
                  <input className={inputCls()} placeholder="Dirección legal/administrativa" value={formEmp.direccion_fiscal} onChange={fe("direccion_fiscal")} />
                </Campo>
                <Campo label="Distrito fiscal">
                  <select className={inputCls()} value={formEmp.distrito_fiscal} onChange={fe("distrito_fiscal")}>
                    <option value="">— Sin especificar —</option>
                    {DISTRITOS_LIMA.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </Campo>
                <Campo label="Dirección de cochera / estacionamiento" span={2}>
                  <div className="flex gap-2">
                    <input className={inputCls()} placeholder="Dónde estaciona la flota — usada para 'proveedor más cercano'" value={formEmp.direccion_cochera} onChange={fe("direccion_cochera")} />
                    <button type="button" onClick={geocodificarCochera} disabled={geocodificando}
                      className="px-3 py-2.5 rounded-xl text-xs font-bold border whitespace-nowrap hover:bg-gray-50 disabled:opacity-60"
                      title="Opcional: ubica la dirección exacta en coordenadas">
                      {geocodificando ? "…" : "📍 Ubicar"}
                    </button>
                  </div>
                  {editEmpId && empresas.find(e => e.id === editEmpId)?.lat_cochera && (
                    <p className="text-[10px] text-green-700 mt-1">✓ Coordenadas guardadas</p>
                  )}
                </Campo>
                <Campo label="Distrito de cochera (filtro de cercanía)">
                  <select className={inputCls()} value={formEmp.distrito_cochera} onChange={fe("distrito_cochera")}>
                    <option value="">— Sin especificar —</option>
                    {DISTRITOS_LIMA.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </Campo>
              </div>
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Habilitaciones legales</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Campo label="N° Autorización MTC">
                  <input className={inputCls("font-mono")} placeholder="Ej: MTC-001-2024" value={formEmp.autorizacion_mtc} onChange={fe("autorizacion_mtc")} />
                </Campo>
                <Campo label="Vencimiento autorización MTC">
                  <input type="date" className={inputCls()} value={formEmp.venc_autorizacion} onChange={fe("venc_autorizacion")} />
                  {formEmp.venc_autorizacion && (
                    <p className="text-[10px] mt-1 font-bold" style={{ color: diasPara(formEmp.venc_autorizacion) !== null && diasPara(formEmp.venc_autorizacion)! <= 0 ? "#dc2626" : "#166534" }}>
                      {diasPara(formEmp.venc_autorizacion) !== null && diasPara(formEmp.venc_autorizacion)! <= 0 ? "⚠ Vencida" : `Vence en ${diasPara(formEmp.venc_autorizacion)} días`}
                    </p>
                  )}
                </Campo>
                <Campo label="N° Habilitación SUTRAN">
                  <input className={inputCls("font-mono")} placeholder="Ej: SUTRAN-001-2024" value={formEmp.habilitacion_sutran} onChange={fe("habilitacion_sutran")} />
                </Campo>
                <Campo label="Vencimiento habilitación SUTRAN">
                  <input type="date" className={inputCls()} value={formEmp.venc_habilitacion} onChange={fe("venc_habilitacion")} />
                  {formEmp.venc_habilitacion && (
                    <p className="text-[10px] mt-1 font-bold" style={{ color: diasPara(formEmp.venc_habilitacion) !== null && diasPara(formEmp.venc_habilitacion)! <= 0 ? "#dc2626" : "#166534" }}>
                      {diasPara(formEmp.venc_habilitacion) !== null && diasPara(formEmp.venc_habilitacion)! <= 0 ? "⚠ Vencida" : `Vence en ${diasPara(formEmp.venc_habilitacion)} días`}
                    </p>
                  )}
                </Campo>
              </div>
            </div>
            <Campo label="Observaciones"><input className={inputCls()} value={formEmp.observaciones} onChange={fe("observaciones")} /></Campo>
            <div className="flex gap-3">
              <button onClick={guardarEmpresa} disabled={guardando}
                className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
                style={{ background: "#0b315f" }}>
                {guardando ? "Guardando..." : editEmpId ? "Actualizar" : "Guardar empresa"}
              </button>
              <button onClick={() => { setFormEmp(FORM_EMP); setEditEmpId(null); setMostrarFormEmp(false); }}
                className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL: confirmar borrado de empresa ── */}
      {confirmarBorrado && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => { setConfirmarBorrado(null); setTextoBorrado(""); }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-black text-red-700">Eliminar proveedor</h2>
            <p className="text-sm text-gray-600">
              Se borrará <b>{confirmarBorrado.razon_social}</b> junto con sus{" "}
              <b>{porEmpresa.vehs[confirmarBorrado.id]?.length || 0} vehículos</b>,{" "}
              <b>{porEmpresa.conds[confirmarBorrado.id]?.length || 0} conductores</b>,{" "}
              sus documentos y las lecturas de odómetro de todas sus unidades. No se puede deshacer.
            </p>
            <div>
              <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
                Escribe <span className="font-mono text-gray-700">{confirmarBorrado.ruc || confirmarBorrado.razon_social}</span> para confirmar
              </label>
              <input className={inputCls("font-mono")} value={textoBorrado} onChange={e => setTextoBorrado(e.target.value)} autoFocus />
            </div>
            <div className="flex gap-2">
              <button onClick={eliminarEmpresa} disabled={guardando || textoBorrado.trim() !== (confirmarBorrado.ruc || confirmarBorrado.razon_social)}
                className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-red-600 disabled:opacity-40">
                {guardando ? "Eliminando…" : "Eliminar definitivamente"}
              </button>
              <button onClick={() => { setConfirmarBorrado(null); setTextoBorrado(""); }}
                className="px-4 py-2 rounded-xl text-sm font-bold border text-gray-600">Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {modalOdoVeh && (
        <OdometroTerceroModal
          vehiculo={modalOdoVeh}
          onClose={() => setModalOdoVeh(null)}
          onSaved={() => refrescarDetalle(modalOdoVeh.empresa_id)}
        />
      )}

    </main>
  );
}
