"use client";

// /seguros — una vista DERIVADA de todas las fuentes (lib/seguros-datos.ts → lib/seguros.ts).
//
// Cada fila dice de dónde sale y se corrige DONDE vive: el SOAT/CAT en los documentos de la
// unidad, el SCTR/Vida Ley de una persona en su ficha, lo del tercero en /tercerizadas. Esta
// pantalla solo ESCRIBE las pólizas colectivas (`seguros` + sus asegurados en `seguro_cobertura`):
// un solo camino de escritura por dato.

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { EnlacePrivado } from "@/components/ArchivoPrivado";
import {
  TIPOS_SEGURO, SCTR_SIN_PRECISAR, CODIGOS_FALTANTE, FUENTES_SEGURO, TIPOS_PERSONA, kpisSeguros, estadoDe,
  tiposDePoliza, estadoCobertura, inicioEfectivo, etiquetaDeTipos,
  type FilaSeguro, type FuenteSeguro, type Faltante, type ClaveAsegurado, type TipoPersona,
  type CoberturaRow, type PolizaRow,
} from "@/lib/seguros";
import { listaInclusion, type PersonaInclusion } from "@/lib/seguros-inclusion";
import { usePuedeVer } from "@/lib/usePuedeVer";
import { cargarSeguros, type ResultadoSeguros } from "@/lib/seguros-datos";
import { columnaFaltante, tablaFaltante } from "@/lib/columna-faltante";
import { diasEntreFechas } from "@/lib/documentos-estado";
import { subirEvidencias, retirarSubidas, preguntaSinRespaldo, revisarArchivo, type StorageCliente } from "@/lib/evidencia";

// ─── CONSTANTES DE PANTALLA ───────────────────────────────────────────────────

const FUENTE_LABEL: Record<FuenteSeguro, { label: string; color: string; bg: string }> = {
  documento_vehiculo: { label: "Documentos vehiculares", color: "#1d4ed8", bg: "#dbeafe" },
  documento_tercero:  { label: "Tercerizadas",           color: "#92400e", bg: "#fef3c7" },
  ficha_conductor:    { label: "Ficha del conductor",    color: "#0f766e", bg: "#ccfbf1" },
  ficha_personal:     { label: "Ficha del personal",     color: "#6d28d9", bg: "#ede9fe" },
  poliza:             { label: "Póliza",                 color: "#0b315f", bg: "#e0e7ef" },
};

/** Nombre de la pantalla a la que lleva `editarEn` (la ruta la decide el motor). */
const PANTALLA: Record<string, string> = {
  "/vehiculos": "Vehículos",
  "/documentos-vehiculares": "Documentos vehiculares",
  "/tercerizadas": "Tercerizadas",
  "/conductores": "Conductores",
  "/personal-administrativo": "Personal administrativo",
  "/seguros": "Seguros",
};
const pantallaDe = (ruta: string) => PANTALLA[ruta] ?? ruta;

const ASEGURADORAS = [
  "Rimac Seguros", "Pacífico Seguros", "La Positiva Seguros",
  "Mapfre Perú", "Interseguro", "Protecta Security",
  "Chubb Perú", "Zurich Seguros", "BNP Paribas Cardif",
  "AFOCAT (regional)", "Otra",
];

/** Lo que va al SOAT/CAT de cada placa: no es una póliza colectiva. */
const TIPOS_DE_DOCUMENTO = ["soat", "cat"];
const TIPOS_VEHICULARES = ["soat", "cat", "todo_riesgo", "responsabilidad_civil"];

/** Columnas de `seguros` que trae una migración accesoria (seguros-01 / -04a): se sueltan si el error las nombra. */
const COLS_ACCESORIAS = ["vehiculo_tercero_id", "alcance", "coberturas"] as const;
const SQL_04A = "supabase/seguros-04a-coberturas-e-inclusion.sql";

/** Los tres tipos de persona que una sola póliza puede cubrir a la vez (orden canónico). */
const ETQ_PERSONA: Record<TipoPersona, string> = { sctr_salud: "SCTR Salud", sctr_pension: "SCTR Pensión", vida_ley: "Vida Ley" };
const esTipoPersona = (t: string): t is TipoPersona => (TIPOS_PERSONA as string[]).includes(t);
const canonico = (ts: TipoPersona[]) => TIPOS_PERSONA.filter((t) => ts.includes(t));

/** Lo que se lee de cada fila de `seguro_cobertura` de la póliza abierta. */
type CobFila = {
  id: number | null; desde: string | null; hasta: string | null;
  estado: string | null; solicitada_en: string | null; constancia_url: string | null; nota: string | null;
};
const COLS_COB_04A = ["estado", "solicitada_en", "constancia_url", "nota"];
/** Módulos que dejan ver la remuneración en la lista para el bróker (constante: usePuedeVer la usa como clave). */
const MODULOS_SUELDO = ["conductores", "personal-administrativo"] as const;

type ClaseCubierto = "conductor" | "personal" | "vehiculo" | "vehiculo_tercero";
const COLUMNA_COBERTURA: Record<ClaseCubierto, string> = {
  conductor: "conductor_id",
  personal: "personal_administrativo_id",
  vehiculo: "vehiculo_id",
  vehiculo_tercero: "vehiculo_tercero_id",
};
const GRUPOS_CUBIERTOS: { clase: ClaseCubierto; titulo: string; icon: string }[] = [
  { clase: "conductor", titulo: "Conductores", icon: "🧑‍✈️" },
  { clase: "personal", titulo: "Personal administrativo", icon: "🧑‍💼" },
  { clase: "vehiculo", titulo: "Vehículos propios", icon: "🚌" },
  { clase: "vehiculo_tercero", titulo: "Vehículos de terceros", icon: "🚐" },
];
type Candidato = { clave: string; clase: ClaseCubierto; id: number; rotulo: string; activo: boolean };
const claveCub = (clase: string, id: unknown) => `${clase}:${Number(id)}`;
const claveDeFila = (c: Pick<CoberturaRow, "conductor_id" | "personal_administrativo_id" | "vehiculo_id" | "vehiculo_tercero_id">): string | null =>
  c.conductor_id != null ? claveCub("conductor", c.conductor_id) : c.personal_administrativo_id != null ? claveCub("personal", c.personal_administrativo_id)
  : c.vehiculo_id != null ? claveCub("vehiculo", c.vehiculo_id) : c.vehiculo_tercero_id != null ? claveCub("vehiculo_tercero", c.vehiculo_tercero_id) : null;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtSoles(n: number) {
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtFecha(f: string | null | undefined) {
  const s = String(f ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "—";
  const [a, m, d] = s.split("-");
  return `${d}/${m}/${a}`;
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
const activoDe = (estado: unknown) => {
  const e = String(estado ?? "").trim().toLowerCase();
  return e !== "inactivo" && e !== "de_baja" && e !== "baja";
};
const sinTildes = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const rutaDeArreglo = (arreglo: string) => arreglo.match(/^\/[\w-]+/)?.[0] ?? null;
const esTercerizada = (f: FilaSeguro) =>
  f.fuente === "documento_tercero" ||
  f.asegurado.clase === "vehiculo_tercero" || f.asegurado.clase === "empresa_tercero" ||
  (f.cubre ?? []).some((c) => c.clase === "vehiculo_tercero");

type FilaLeida = Record<string, unknown>;
async function leerTodo(tabla: string, cols: string): Promise<{ filas: FilaLeida[]; error: { message?: string } | null }> {
  const out: FilaLeida[] = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase.from(tabla).select(cols).order("id", { ascending: true }).range(desde, desde + 999);
    if (error) return { filas: [], error };
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return { filas: out, error: null };
  }
}

function fmtDM(f: string | null | undefined) {
  const s = String(f ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "—";
  return `${s.slice(8, 10)}/${s.slice(5, 7)}`;
}

/** Baja = 'excluida' o (sin la columna estado) un `hasta` ya pasado. */
const esBaja = (c: Pick<CobFila, "estado" | "hasta">, hoy: string) =>
  estadoCobertura(c) === "excluida" || (!!c.hasta && !!hoy && c.hasta < hoy);

/** El chip de un asegurado dentro de su póliza: Incluido · Solicitada hace N días · Por iniciar DD/MM · Baja DD/MM. */
function chipCobertura(c: CobFila, poliza: Pick<PolizaRow, "fecha_inicio"> | null, hoy: string): { texto: string; bg: string; color: string } {
  if (esBaja(c, hoy)) return { texto: `Baja ${fmtDM(c.hasta)}`, bg: "#f3f4f6", color: "#4b5563" };
  if (estadoCobertura(c) === "solicitada") {
    const n = c.solicitada_en && hoy ? diasEntreFechas(c.solicitada_en, hoy) : null;
    return { texto: n === null ? "Solicitada" : n === 0 ? "Solicitada hoy" : `Solicitada hace ${n} día${n === 1 ? "" : "s"}`, bg: "#fef3c7", color: "#92400e" };
  }
  const ini = inicioEfectivo(c, poliza);
  if (ini && hoy && ini > hoy) return { texto: `Por iniciar ${fmtDM(ini)}`, bg: "#fef3c7", color: "#92400e" };
  return { texto: c.desde ? `Incluido desde ${fmtDM(c.desde)}` : "Incluido", bg: "#dcfce7", color: "#166534" };
}

const FORM_VACIO = {
  tipo: "sctr_salud", aseguradora: "", numero_poliza: "", titular: "",
  vehiculo_id: "", proveedor_id: "", fecha_inicio: "",
  fecha_vencimiento: "", prima_total: "", cuota_mensual: "",
  archivo_url: "", observaciones: "",
};

/** El resultado de «Copiar lista para el bróker»: qué se copió y a quién le falta un dato. */
function PanelCopia({ copia, onCerrar }: {
  copia: { titulo: string; filas: number; faltan: string[]; tsv: string; copiado: boolean; error?: string } | null;
  onCerrar: () => void;
}) {
  if (!copia) return null;
  return (
    <div className={`rounded-lg border px-3 py-2 text-[11px] space-y-1 ${copia.error || copia.faltan.length ? "border-amber-200 bg-amber-50 text-amber-900" : "border-green-200 bg-green-50 text-green-900"}`}>
      {copia.error ? <p>⚠️ {copia.error}</p> : (
        <>
          <p><b>{copia.copiado ? "✓ Copiada" : "No se pudo copiar al portapapeles: selecciónala abajo y cópiala"}</b> — {copia.filas} persona(s) · {copia.titulo}. Pégala en el correo o en Excel.</p>
          {copia.faltan.length > 0 && <p>⚠️ Sin estos datos la aseguradora devuelve la inclusión: {copia.faltan.join(" · ")}. Complétalos en su ficha antes de enviarla.</p>}
          {!copia.copiado && <textarea readOnly className="w-full h-24 font-mono text-[10px] border rounded p-1" value={copia.tsv} onFocus={(e) => e.currentTarget.select()} />}
        </>
      )}
      <button type="button" onClick={onCerrar} className="underline font-bold">Cerrar</button>
    </div>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function SegurosPage() {
  const [res,        setRes]        = useState<ResultadoSeguros | null>(null);
  const [errorCarga, setErrorCarga] = useState<string | null>(null);
  const [candidatos, setCandidatos] = useState<Candidato[]>([]);
  const [proveedores,setProveedores]= useState<{ id: number; nombre: string }[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [guardando,  setGuardando]  = useState(false);
  const [editandoId, setEditandoId] = useState<number | null>(null);
  const [mostrarForm,setMostrarForm]= useState(false);
  const [expandido,  setExpandido]  = useState<string | null>(null);
  const [busqueda,   setBusqueda]   = useState("");
  const [filtroEst,  setFiltroEst]  = useState("todos");
  const [filtroTipo, setFiltroTipo] = useState("todos");
  const [filtroCat,  setFiltroCat]  = useState("todos");
  const [filtroFuente, setFiltroFuente] = useState<"todos" | FuenteSeguro>("todos");
  const [filtroFlota,  setFiltroFlota]  = useState<"todas" | "propia" | "tercerizada">("todas");
  const [verTodosFalt, setVerTodosFalt] = useState(false);
  const [avisoGuardado, setAvisoGuardado] = useState<string[]>([]);
  const [form, setForm] = useState(FORM_VACIO);
  const [archivoUrlOriginal, setArchivoUrlOriginal] = useState("");
  const [archivoNuevo, setArchivoNuevo] = useState<File | null>(null);
  // Asegurados de la póliza en edición: clave → su fila de seguro_cobertura (id null = de la póliza vieja).
  const [cubOriginal, setCubOriginal] = useState<Map<string, CobFila>>(new Map());
  /** Tipos de persona que cubre la póliza (SCTR Salud · SCTR Pensión · Vida Ley), orden canónico. */
  const [coberturasSel, setCoberturasSel] = useState<TipoPersona[]>(["sctr_salud"]);
  /** «Ya figuran en la constancia»: los marcados nacen incluidos. Marcado al crear, no al agregar a una existente. */
  const [yaFiguran, setYaFiguran] = useState(true);
  /** Acción en curso sobre un asegurado (marcar incluido / dar de baja), con su fecha y constancia. */
  const [accionCob, setAccionCob] = useState<{ clave: string; tipo: "incluir" | "baja"; fecha: string; archivo: File | null } | null>(null);
  const [aplicando, setAplicando] = useState(false);
  const [conSueldo, setConSueldo] = useState(false);
  const [copia, setCopia] = useState<{ titulo: string; filas: number; faltan: string[]; tsv: string; copiado: boolean; error?: string } | null>(null);
  /** Sin la columna estado de seguro_cobertura (seguros-04a) en la póliza abierta. */
  const [sinEstadoCob, setSinEstadoCob] = useState(false);
  const puedeVer = usePuedeVer(MODULOS_SUELDO);
  const puedeVerSueldo = !!puedeVer && (puedeVer["conductores"] || puedeVer["personal-administrativo"]);
  const [cubSel, setCubSel] = useState<Set<string>>(new Set());
  const [busCub, setBusCub] = useState<Record<ClaseCubierto, string>>({ conductor: "", personal: "", vehiculo: "", vehiculo_tercero: "" });
  const [vehiculoIdOriginal, setVehiculoIdOriginal] = useState<number | null>(null);
  const [cobSinTabla, setCobSinTabla] = useState(false);
  /** Los asegurados de la póliza abierta no se pudieron leer (no es que falte la tabla). */
  const [cobNoLeida, setCobNoLeida] = useState<string | null>(null);
  const [cargandoPoliza, setCargandoPoliza] = useState(false);

  const tipoCfg = TIPOS_SEGURO[form.tipo] || TIPOS_SEGURO.otro;
  const hoy = res?.hoy ?? "";

  const cargarDatos = async () => {
    setLoading(true);
    setErrorCarga(null);
    try {
      const r = await cargarSeguros();
      setRes(r);
      if (r.coberturas === "sin_tabla") setCobSinTabla(true);
    } catch (e: unknown) {
      setErrorCarga(e instanceof Error ? e.message : "no se pudo leer");
    }
    // Directorio para el selector de asegurados y el broker: best-effort, no tapa la vista.
    const [c, p, v, vt, pr] = await Promise.all([
      leerTodo("conductores", "id,nombre,estado"),
      leerTodo("personal_administrativo", "id,nombre,estado"),
      leerTodo("vehiculos", "id,placa,estado"),
      leerTodo("vehiculos_tercero", "id,placa,estado"),
      supabase.from("proveedores").select("id,nombre").order("nombre"),
    ]);
    setCandidatos([
      ...c.filas.map((x) => ({ clave: claveCub("conductor", x.id), clase: "conductor" as const, id: Number(x.id), rotulo: String(x.nombre ?? `#${x.id}`), activo: activoDe(x.estado) })),
      ...p.filas.map((x) => ({ clave: claveCub("personal", x.id), clase: "personal" as const, id: Number(x.id), rotulo: String(x.nombre ?? `#${x.id}`), activo: activoDe(x.estado) })),
      ...v.filas.map((x) => ({ clave: claveCub("vehiculo", x.id), clase: "vehiculo" as const, id: Number(x.id), rotulo: String(x.placa ?? `#${x.id}`), activo: activoDe(x.estado) })),
      ...vt.filas.map((x) => ({ clave: claveCub("vehiculo_tercero", x.id), clase: "vehiculo_tercero" as const, id: Number(x.id), rotulo: String(x.placa ?? `#${x.id}`), activo: activoDe(x.estado) })),
    ]);
    setProveedores(pr.data || []);
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  const rotuloCub = useMemo(() => new Map(candidatos.map((c) => [c.clave, c.rotulo])), [candidatos]);

  const selectorDisponible = !cobSinTabla && !cobNoLeida && res?.coberturas !== "error";
  /** Se puede registrar una inclusión SOLICITADA solo con la columna `estado` (seguros-04a): sin ella
   *  una fila nueva queda null = incluida = cubierto, que es justo lo que no se puede afirmar. */
  const puedeSolicitar = !!res?.inclusiones && !sinEstadoCob;
  const esPersonaForm = esTipoPersona(form.tipo);
  const multiples = !!res?.coberturasMultiples;

  // ── CRUD de pólizas ───────────────────────────────────────────────────────

  const limpiar = () => {
    setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false);
    setArchivoNuevo(null); setArchivoUrlOriginal("");
    setCubOriginal(new Map()); setCubSel(new Set()); setVehiculoIdOriginal(null); setCobNoLeida(null);
    setCoberturasSel(["sctr_salud"]); setYaFiguran(true); setAccionCob(null); setCopia(null); setSinEstadoCob(false);
    setBusCub({ conductor: "", personal: "", vehiculo: "", vehiculo_tercero: "" });
  };

  const nuevo = () => { limpiar(); setMostrarForm(true); setAvisoGuardado([]); };

  /** Lee los asegurados de la póliza abierta. Suelta SOLO las columnas de seguros-04a que el error
   *  nombre; cualquier otro error oculta el selector (guardar a ciegas podría duplicar o perder filas). */
  const recargarCoberturas = async (id: number, s?: { vehiculo_id?: unknown; vehiculo_tercero_id?: unknown }) => {
    let cols = ["id", "conductor_id", "personal_administrativo_id", "vehiculo_id", "vehiculo_tercero_id", "desde", "hasta", ...COLS_COB_04A];
    let sinEstado = false;
    for (let intento = 0; intento <= COLS_COB_04A.length; intento++) {
      const cob = await supabase.from("seguro_cobertura").select(cols.join(",")).eq("seguro_id", id).order("id", { ascending: true });
      if (cob.error) {
        const col = columnaFaltante(cob.error);
        if (col && COLS_COB_04A.includes(col) && cols.includes(col)) { cols = cols.filter((c) => c !== col); if (col === "estado") sinEstado = true; continue; }
        if (tablaFaltante(cob.error, "seguro_cobertura")) setCobSinTabla(true);
        else setCobNoLeida(cob.error.message);
        return;
      }
      const orig = new Map<string, CobFila>();
      for (const r of (cob.data ?? []) as unknown as Record<string, unknown>[]) {
        const clase: ClaseCubierto | null = r.conductor_id != null ? "conductor" : r.personal_administrativo_id != null ? "personal"
          : r.vehiculo_id != null ? "vehiculo" : r.vehiculo_tercero_id != null ? "vehiculo_tercero" : null;
        if (!clase) continue;
        orig.set(claveCub(clase, r[COLUMNA_COBERTURA[clase]]), {
          id: Number(r.id), desde: (r.desde as string) ?? null, hasta: (r.hasta as string) ?? null,
          estado: (r.estado as string) ?? null, solicitada_en: (r.solicitada_en as string) ?? null,
          constancia_url: (r.constancia_url as string) ?? null, nota: (r.nota as string) ?? null,
        });
      }
      // Póliza vieja sin filas de cobertura: su vehículo es el asegurado.
      const vacia: CobFila = { id: null, desde: null, hasta: null, estado: null, solicitada_en: null, constancia_url: null, nota: null };
      if (orig.size === 0 && s?.vehiculo_id != null) orig.set(claveCub("vehiculo", s.vehiculo_id), vacia);
      if (orig.size === 0 && s?.vehiculo_tercero_id != null) orig.set(claveCub("vehiculo_tercero", s.vehiculo_tercero_id), vacia);
      setSinEstadoCob(sinEstado);
      setCobNoLeida(null);
      setCubOriginal(orig);
      setCubSel(new Set());
      return;
    }
  };

  const editar = async (id: number) => {
    limpiar();
    setAvisoGuardado([]);
    setCargandoPoliza(true);
    const { data: s, error } = await supabase.from("seguros").select("*").eq("id", id).maybeSingle();
    if (error || !s) { setCargandoPoliza(false); alert(`No se pudo abrir la póliza #${id}: ${error?.message ?? "no existe"}`); return; }
    setForm({
      tipo:              s.tipo              || "otro",
      aseguradora:       s.aseguradora       || "",
      numero_poliza:     s.numero_poliza     || "",
      titular:           s.titular           || "",
      vehiculo_id:       s.vehiculo_id ? String(s.vehiculo_id) : "",
      proveedor_id:      s.proveedor_id ? String(s.proveedor_id) : "",
      fecha_inicio:      s.fecha_inicio      || "",
      fecha_vencimiento: s.fecha_vencimiento || "",
      prima_total:       s.prima_total != null ? String(s.prima_total) : "",
      cuota_mensual:     s.cuota_mensual != null ? String(s.cuota_mensual) : "",
      archivo_url:       s.archivo_url       || "",
      observaciones:     s.observaciones     || "",
    });
    setArchivoUrlOriginal(s.archivo_url || "");
    setVehiculoIdOriginal(s.vehiculo_id != null ? Number(s.vehiculo_id) : null);
    const tipos = tiposDePoliza(s as PolizaRow).filter(esTipoPersona);
    setCoberturasSel(tipos.length ? canonico(tipos) : esTipoPersona(String(s.tipo)) ? [s.tipo as TipoPersona] : ["sctr_salud"]);
    // A una póliza que ya existe, lo que se agrega es una inclusión que hay que PEDIR (si se puede).
    setYaFiguran(!res?.inclusiones);

    await recargarCoberturas(id, s);
    setEditandoId(id); setMostrarForm(true); setCargandoPoliza(false);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const esDocumentoVehicular = TIPOS_DE_DOCUMENTO.includes(form.tipo);
  const bloqueoGuardar: string | null =
    !editandoId && esDocumentoVehicular ? "El SOAT/CAT es de cada placa: se registra en Documentos vehiculares, no como póliza colectiva."
    : !form.aseguradora ? "Falta elegir la aseguradora."
    : !form.fecha_vencimiento ? "Falta la fecha de vencimiento."
    : null;

  /**
   * Agrega a la póliza lo marcado en el selector (y migra el vehículo de una póliza vieja).
   * Nace 'incluida' si «Ya figuran en la constancia» está marcado; si no, 'solicitada' con
   * solicitada_en = hoy (Lima). NUNCA se guarda a alguien como solicitado soltando la columna
   * estado: sin seguros-04a no se ofrece y aquí se fuerza incluida solo si así lo pidió la pantalla.
   * Un dado de baja que se vuelve a marcar se REINCLUYE en su misma fila (índice único), con rastro en nota.
   */
  const agregarAsegurados = async (seguroId: number, alCrear: boolean): Promise<{ ok: boolean; avisos: string[]; n: number }> => {
    const avisos: string[] = [];
    const incluidos = yaFiguran || !puedeSolicitar;
    if (!incluidos && !puedeSolicitar) return { ok: false, avisos: [`No se registró ninguna inclusión: falta ${SQL_04A}.`], n: 0 };
    const legado = [...cubOriginal.entries()].filter(([, f]) => f.id == null).map(([k]) => k);
    const nuevas = [...cubSel].filter((k) => !cubOriginal.has(k));
    const reincluir = [...cubSel].filter((k) => { const f = cubOriginal.get(k); return !!f && f.id != null && esBaja(f, hoy); });
    const estadoNuevo = (incl: boolean): Record<string, unknown> => !res?.inclusiones || sinEstadoCob ? {}
      : incl ? { estado: "incluida", solicitada_en: null } : { estado: "solicitada", solicitada_en: hoy };
    let ok = true;
    const filas = [
      ...legado.map((k) => ({ k, incl: true })),
      ...nuevas.map((k) => ({ k, incl: incluidos })),
    ].map(({ k, incl }) => {
      const [clase, id] = k.split(":") as [ClaseCubierto, string];
      return { seguro_id: seguroId, [COLUMNA_COBERTURA[clase]]: Number(id), ...estadoNuevo(incl) };
    });
    if (filas.length) {
      const ins = await supabase.from("seguro_cobertura").insert(filas);
      if (ins.error) {
        ok = false;
        avisos.push(tablaFaltante(ins.error, "seguro_cobertura")
          ? "La póliza se guardó, pero sus asegurados no: falta la tabla seguro_cobertura (corre supabase/seguros-02-cobertura.sql en Supabase → SQL Editor)."
          : `No se pudieron agregar ${filas.length} asegurado(s): ${ins.error.message}. Nadie quedó agregado; vuelve a intentarlo.`);
        if (tablaFaltante(ins.error, "seguro_cobertura")) setCobSinTabla(true);
      }
    }
    for (const k of reincluir) {
      const f = cubOriginal.get(k)!;
      const rastro = `Reincluido el ${fmtFecha(hoy)} (baja anterior hasta ${fmtFecha(f.hasta)}).`;
      const patch: Record<string, unknown> = { hasta: null, desde: null, ...estadoNuevo(incluidos) };
      if (res?.inclusiones && !sinEstadoCob) patch.nota = f.nota ? `${f.nota} · ${rastro}` : rastro;
      const u = await supabase.from("seguro_cobertura").update(patch).eq("id", f.id);
      if (u.error) { ok = false; avisos.push(`No se pudo reincluir a ${rotuloCub.get(k) ?? k}: ${u.error.message}`); }
    }
    const n = nuevas.length + reincluir.length;
    if (ok && n > 0 && !incluidos) avisos.push(`${n} inclusión(es) registradas como SOLICITADAS el ${fmtFecha(hoy)}: no quedan cubiertos hasta que marques «Incluido» con la fecha de la constancia.`);
    if (ok && n > 0 && !puedeSolicitar && !alCrear) avisos.push(`${n} asegurado(s) se agregaron como INCLUIDOS: sin ${SQL_04A} no se puede registrar una inclusión pendiente.`);
    return { ok, avisos, n };
  };

  /** Agregar ahora (sin tocar el resto de la póliza): en una póliza existente. */
  const agregarAhora = async () => {
    if (!editandoId || cubSel.size === 0) return;
    const nombres = [...cubSel].map((k) => rotuloCub.get(k) ?? k);
    const incl = yaFiguran || !puedeSolicitar;
    if (!confirm(`${incl ? "Agregar como INCLUIDOS" : "Registrar como inclusión SOLICITADA hoy"} a ${nombres.length} asegurado(s) de la póliza ${form.numero_poliza ? `N° ${form.numero_poliza}` : `#${editandoId}`}:\n\n${nombres.slice(0, 20).join("\n")}${nombres.length > 20 ? `\n… y ${nombres.length - 20} más` : ""}${incl ? "" : "\n\nNo quedan cubiertos hasta marcarlos incluidos."}`)) return;
    setAplicando(true);
    const r = await agregarAsegurados(editandoId, false);
    setAvisoGuardado(r.avisos);
    await recargarCoberturas(editandoId);
    void cargarDatos();
    setAplicando(false);
  };

  /** Marcar incluido (fecha efectiva obligatoria + constancia opcional) o dar de baja (fecha de baja). */
  const aplicarAccion = async () => {
    if (!accionCob || !editandoId) return;
    const f = cubOriginal.get(accionCob.clave);
    if (!f || f.id == null) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(accionCob.fecha)) { alert(accionCob.tipo === "incluir" ? "Falta la fecha desde la que cubre (la de la constancia)." : "Falta la fecha de baja."); return; }
    const quien = rotuloCub.get(accionCob.clave) ?? accionCob.clave;
    setAplicando(true);
    let subidas: Awaited<ReturnType<typeof subirEvidencias>>["subidas"] = [];
    const patch: Record<string, unknown> = {};
    if (accionCob.tipo === "incluir") {
      patch.estado = "incluida"; patch.desde = accionCob.fecha; patch.solicitada_en = f.solicitada_en;
      if (accionCob.archivo) {
        const up = await subirEvidencias(supabase as unknown as StorageCliente, [{ archivo: accionCob.archivo, clase: "constancia" }], "seguros");
        if (up.fallidas.length) {
          if (!confirm(preguntaSinRespaldo(up.fallidas, "la inclusión"))) { setAplicando(false); return; }
        } else { subidas = up.subidas; patch.constancia_url = up.subidas[0]?.url ?? null; }
      }
    } else {
      patch.hasta = accionCob.fecha;
      if (res?.inclusiones && !sinEstadoCob) patch.estado = "excluida";
    }
    const u = await supabase.from("seguro_cobertura").update(patch).eq("id", f.id);
    if (u.error) {
      await retirarSubidas(supabase as unknown as StorageCliente, subidas);
      alert(`No se guardó (${quien}): ${u.error.message}`);
      setAplicando(false);
      return;
    }
    setAvisoGuardado([accionCob.tipo === "incluir"
      ? `${quien}: incluido desde el ${fmtFecha(accionCob.fecha)}${accionCob.fecha > hoy ? " (todavía no está cubierto: empieza ese día)" : ""}.`
      : `${quien}: dado de baja el ${fmtFecha(accionCob.fecha)}.`]);
    setAccionCob(null);
    await recargarCoberturas(editandoId);
    void cargarDatos();
    setAplicando(false);
  };

  /** Quitar: SOLO una inclusión solicitada por error (no deja rastro de cobertura que borrar). */
  const quitarSolicitada = async (clave: string) => {
    const f = cubOriginal.get(clave);
    if (!editandoId || !f || f.id == null || estadoCobertura(f) !== "solicitada") return;
    const quien = rotuloCub.get(clave) ?? clave;
    if (!confirm(`¿Quitar la inclusión SOLICITADA de ${quien}${f.solicitada_en ? ` (pedida el ${fmtFecha(f.solicitada_en)})` : ""}?\n\nÚsalo solo si se pidió por error: si el bróker ya la tramitó, márcalo incluido.`)) return;
    setAplicando(true);
    const d = await supabase.from("seguro_cobertura").delete().eq("id", f.id);
    if (d.error) alert(`No se quitó: ${d.error.message}`);
    await recargarCoberturas(editandoId);
    void cargarDatos();
    setAplicando(false);
  };

  /**
   * Copia al portapapeles la lista para el bróker (lib/seguros-inclusion.ts): de las personas
   * `claves`. Lee DNI, nacimiento, cargo e ingreso de su ficha; la remuneración solo si se pidió y
   * quien copia ve Conductores o Personal. Nombra a quién le falta DNI o fecha de nacimiento.
   */
  const copiarLista = async (seguroId: number, claves: string[]) => {
    const personas = claves.filter((k) => k.startsWith("conductor:") || k.startsWith("personal:"));
    if (!personas.length) { setCopia({ titulo: "", filas: 0, faltan: [], tsv: "", copiado: false, error: "No hay personas en la lista (los vehículos no van a la lista del bróker)." }); return; }
    const leer = async (tabla: string, base: string[], opc: string[], ids: number[]) => {
      let cols = [...base, ...opc];
      for (let intento = 0; intento <= opc.length; intento++) {
        const { data, error } = await supabase.from(tabla).select(cols.join(",")).in("id", ids);
        if (!error) return (data ?? []) as unknown as Record<string, unknown>[];
        const col = columnaFaltante(error);
        if (col && opc.includes(col) && cols.includes(col)) { cols = cols.filter((c) => c !== col); continue; }
        throw new Error(error.message);
      }
      return [];
    };
    const sueldo = conSueldo && puedeVerSueldo;
    const idsDe = (pre: string) => personas.filter((k) => k.startsWith(pre)).map((k) => Number(k.split(":")[1]));
    try {
      const [c, p] = await Promise.all([
        idsDe("conductor:").length ? leer("conductores", ["id", "nombre"], ["dni", "fecha_nacimiento", "fecha_ingreso", ...(sueldo ? ["sueldo_basico"] : [])], idsDe("conductor:")) : Promise.resolve([]),
        idsDe("personal:").length ? leer("personal_administrativo", ["id", "nombre"], ["dni", "fecha_nacimiento", "cargo", "fecha_ingreso", ...(sueldo ? ["sueldo_basico"] : [])], idsDe("personal:")) : Promise.resolve([]),
      ]);
      const lista: PersonaInclusion[] = [
        ...c.map((r) => ({ clase: "conductor" as const, id: Number(r.id), nombre: (r.nombre as string) ?? null, dni: (r.dni as string) ?? null, fecha_nacimiento: (r.fecha_nacimiento as string) ?? null, fecha_ingreso: (r.fecha_ingreso as string) ?? null, sueldo_basico: (r.sueldo_basico as number) ?? null })),
        ...p.map((r) => ({ clase: "personal" as const, id: Number(r.id), nombre: (r.nombre as string) ?? null, dni: (r.dni as string) ?? null, fecha_nacimiento: (r.fecha_nacimiento as string) ?? null, cargo: (r.cargo as string) ?? null, fecha_ingreso: (r.fecha_ingreso as string) ?? null, sueldo_basico: (r.sueldo_basico as number) ?? null })),
      ];
      const pol = (res?.polizas ?? []).find((x) => Number(x.id) === seguroId) ?? null;
      const l = listaInclusion(lista, pol, { conSueldo: sueldo });
      let copiado = false;
      try { await navigator.clipboard.writeText(l.tsv); copiado = true; } catch { copiado = false; }
      setCopia({ titulo: l.titulo, filas: l.filas, tsv: l.tsv, copiado, faltan: l.faltan.map((x) => `${x.nombre}: falta ${x.campos.join(" y ")}`) });
    } catch (e: unknown) {
      setCopia({ titulo: "", filas: 0, faltan: [], tsv: "", copiado: false, error: `No se pudo leer las fichas: ${e instanceof Error ? e.message : "error"}` });
    }
  };

  const guardar = async () => {
    if (bloqueoGuardar) return;
    setGuardando(true);
    const avisos: string[] = [];

    // 1. PDF de la póliza → bucket privado `documentos` (se guarda su URL pública como identificador).
    let archivoUrl: string | null = form.archivo_url.trim() || null;
    let subidas: Awaited<ReturnType<typeof subirEvidencias>>["subidas"] = [];
    if (archivoNuevo) {
      const r = await subirEvidencias(supabase as unknown as StorageCliente, [{ archivo: archivoNuevo, clase: "constancia" }], "seguros");
      if (r.fallidas.length) {
        if (!confirm(preguntaSinRespaldo(r.fallidas, "la póliza"))) { setGuardando(false); return; }
      } else {
        subidas = r.subidas;
        archivoUrl = r.subidas[0]?.url ?? archivoUrl;
      }
    }

    // 2. La póliza. Las columnas accesorias se sueltan SOLO si el error las nombra.
    const venc = form.fecha_vencimiento;
    // Póliza de persona: `tipo` = la primera cobertura marcada (orden canónico) y `coberturas` = todas
    // (solo con seguros-04a, y solo si son varias: null = «solo cubre `tipo`», lo de siempre).
    const tiposPersona = esPersonaForm ? canonico(coberturasSel.length ? coberturasSel : [form.tipo as TipoPersona]) : [];
    const tipoGuardar = esPersonaForm ? (multiples ? tiposPersona[0] : form.tipo) : form.tipo;
    const payload: Record<string, unknown> = {
      tipo:              tipoGuardar,
      aseguradora:       form.aseguradora.trim(),
      numero_poliza:     form.numero_poliza.trim() || null,
      titular:           form.titular.trim()       || null,
      vehiculo_id:       selectorDisponible ? (editandoId ? vehiculoIdOriginal : null) : (form.vehiculo_id ? Number(form.vehiculo_id) : null),
      proveedor_id:      form.proveedor_id ? Number(form.proveedor_id) : null,
      fecha_inicio:      form.fecha_inicio || null,
      fecha_vencimiento: venc,
      prima_total:       form.prima_total.trim() === "" ? null : Number(form.prima_total),
      cuota_mensual:     form.cuota_mensual.trim() === "" ? null : Number(form.cuota_mensual),
      estado:            estadoDe(venc, hoy).estado,
      archivo_url:       archivoUrl,
      observaciones:     form.observaciones.trim() || null,
      alcance:           "colectiva",
    };
    if (esPersonaForm && multiples) payload.coberturas = tiposPersona.length > 1 ? tiposPersona : null;
    // La columna prima/cuota es NOT NULL default 0 en algunas bases: vacío no se convierte en 0
    // aquí; si la base lo exige, se avisa abajo.
    let seguroId: number | null = editandoId;
    let error: { message?: string; code?: string } | null = null;
    for (let intento = 0; intento <= COLS_ACCESORIAS.length; intento++) {
      const r = editandoId
        ? await supabase.from("seguros").update(payload).eq("id", editandoId)
        : await supabase.from("seguros").insert(payload).select("id").single();
      error = r.error;
      if (!error) { if (!editandoId) seguroId = Number((r as { data?: { id?: unknown } }).data?.id); break; }
      const col = columnaFaltante(error);
      const acc = COLS_ACCESORIAS.find((c) => c === col);
      if (acc && acc in payload) {
        delete payload[acc];
        avisos.push(acc === "coberturas"
          ? `La columna «coberturas» de seguros no existe todavía: la póliza se guardó cubriendo SOLO ${ETQ_PERSONA[tipoGuardar as TipoPersona] ?? tipoGuardar} (corre ${SQL_04A} en Supabase → SQL Editor).`
          : `La columna «${acc}» de seguros no existe todavía: se guardó sin ella (corre supabase/seguros-01-base.sql en Supabase → SQL Editor).`);
        continue;
      }
      break;
    }
    if (error || !seguroId) {
      await retirarSubidas(supabase as unknown as StorageCliente, subidas);
      const msg = String(error?.message ?? "no se obtuvo el id");
      alert(/null value in column "(prima_total|cuota_mensual)"/.test(msg)
        ? `No se guardó: la base exige un importe en ${msg.match(/"(\w+)"/)?.[1]}. Escribe el monto (puede ser 0 si de verdad no costó nada).`
        : `No se guardó la póliza: ${msg}`);
      setGuardando(false);
      return;
    }

    // 3. Asegurados: solo se AGREGA (o se reincluye) desde aquí; quitar y dar de baja son acciones
    //    de cada fila. Cada escritura comprueba su error.
    if (selectorDisponible) {
      const r = await agregarAsegurados(seguroId, !editandoId);
      avisos.push(...r.avisos);
      // La póliza vieja que usaba vehiculo_id: sus asegurados viven ahora en seguro_cobertura.
      if (r.ok && vehiculoIdOriginal != null) {
        const u = await supabase.from("seguros").update({ vehiculo_id: null }).eq("id", seguroId);
        if (u.error) avisos.push(`No se pudo retirar el vehículo antiguo de la póliza: ${u.error.message}`);
      }
    }

    setAvisoGuardado(avisos);
    limpiar();
    await cargarDatos();
    setGuardando(false);
  };

  const eliminar = async (f: FilaSeguro) => {
    const n = f.cubiertos ?? 0;
    if (!confirm(`¿Eliminar la póliza ${f.numero ? `N° ${f.numero}` : `#${f.origenId}`} (${f.etiqueta}${f.aseguradora ? `, ${f.aseguradora}` : ""})?\n\n` +
      `${n > 0 ? `Cubre a ${n} asegurado(s): dejarán de figurar como cubiertos por ella.` : "No tiene asegurados registrados."}`)) return;
    const { error } = await supabase.from("seguros").delete().eq("id", f.origenId);
    if (error) { alert(`No se eliminó: ${error.message}`); return; }
    cargarDatos();
  };

  // ── Vista ─────────────────────────────────────────────────────────────────

  const filas = useMemo(() => res?.filas ?? [], [res]);
  const k = useMemo(() => kpisSeguros(filas), [filas]);
  const fuentesConError = (res ? FUENTES_SEGURO.filter((f) => res.fuentes[f] === "error") : []);
  const algunError = !!errorCarga || fuentesConError.length > 0;
  const kv = (n: number) => (algunError ? "?" : n);
  const primaDesconocida = !!errorCarga || res?.fuentes.poliza === "error";

  const proximosVencer = filas
    .filter((s) => s.dias !== null && s.dias >= 0 && s.dias <= 60)
    .sort((a, b) => (a.dias ?? 0) - (b.dias ?? 0));

  const filtrados = filas.filter((s) => {
    const q = sinTildes(busqueda.trim());
    const txt = sinTildes(`${s.aseguradora ?? ""} ${s.numero ?? ""} ${s.asegurado.rotulo} ${s.etiqueta} ${FUENTE_LABEL[s.fuente].label}`);
    const cat = s.tipo === SCTR_SIN_PRECISAR ? "obligatorio" : (TIPOS_SEGURO[s.tipo]?.categoria || "complementario");
    const terc = esTercerizada(s);
    return (!q || txt.includes(q)) &&
      (filtroEst  === "todos" || s.estado === filtroEst) &&
      (filtroTipo === "todos" || s.tipo   === filtroTipo) &&
      (filtroCat  === "todos" || cat      === filtroCat) &&
      (filtroFuente === "todos" || s.fuente === filtroFuente) &&
      (filtroFlota === "todas" || (filtroFlota === "tercerizada" ? terc : !terc));
  });

  const faltantes: Faltante[] = res?.faltantes ?? [];
  const alarmas = faltantes.filter((f) => f.alarma);
  /** Las inclusiones en trámite se agrupan por póliza (con los días esperando); el resto, en la lista. */
  const esInclusion = (f: Faltante) => f.codigo === "inclusion_solicitada" || f.codigo === "inclusion_por_iniciar";
  const otrosFalt = faltantes.filter((f) => !esInclusion(f));
  const inclusionesPorPoliza = (() => {
    const m = new Map<number, Faltante[]>();
    for (const f of faltantes) if (esInclusion(f) && f.seguroId != null) m.set(f.seguroId, [...(m.get(f.seguroId) ?? []), f]);
    return [...m.entries()].map(([sid, fs]) => ({ sid, fs, pol: (res?.polizas ?? []).find((p) => Number(p.id) === sid) ?? null }));
  })();
  const faltVisibles = verTodosFalt ? otrosFalt : otrosFalt.slice(0, 12);

  /** Ya está en la póliza y no de baja: no se vuelve a marcar (se gestiona en su fila). */
  const enPoliza = (clave: string) => { const f = cubOriginal.get(clave); return !!f && !esBaja(f, hoy); };
  const nVigentes = [...cubOriginal.keys()].filter(enPoliza).length;
  const nCubiertos = (clase: ClaseCubierto) =>
    [...cubOriginal.keys()].filter((c) => c.startsWith(clase + ":") && enPoliza(c)).length + [...cubSel].filter((c) => c.startsWith(clase + ":")).length;
  const candidatosDe = (clase: ClaseCubierto) => {
    const q = sinTildes(busCub[clase].trim());
    return candidatos.filter((c) => c.clase === clase && (!q || sinTildes(c.rotulo).includes(q)))
      .sort((a, b) => Number(b.activo) - Number(a.activo) || a.rotulo.localeCompare(b.rotulo));
  };
  const alternar = (clave: string) => setCubSel((s) => { const n = new Set(s); if (n.has(clave)) n.delete(clave); else n.add(clave); return n; });
  const marcarTodos = (clase: ClaseCubierto, marcar: boolean) => setCubSel((s) => {
    const n = new Set(s);
    for (const c of candidatosDe(clase)) { if (enPoliza(c.clave)) continue; if (marcar) n.add(c.clave); else n.delete(c.clave); }
    return n;
  });

  const diasForm = form.fecha_vencimiento && hoy ? diasEntreFechas(hoy, form.fecha_vencimiento) : null;

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-4 md:p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Seguros</h1>
          <p className="text-gray-400 text-sm mt-1">
            Todo lo asegurado, venga de donde venga: SOAT/CAT de cada placa, SCTR y Vida Ley de cada persona, y las pólizas colectivas.
          </p>
        </div>
        <button onClick={() => (mostrarForm ? limpiar() : nuevo())}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
          style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
          {mostrarForm ? "✕ Cancelar" : "+ Nueva póliza colectiva"}
        </button>
      </div>

      {/* ERRORES DE LECTURA / MIGRACIONES */}
      {errorCarga && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          🚨 No se pudieron leer los seguros: {errorCarga}. Los números de abajo no se muestran; recarga para reintentar.
        </div>
      )}
      {res && res.errores.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 space-y-1">
          {res.errores.map((e, i) => <p key={i}>⚠️ {e}</p>)}
        </div>
      )}
      {avisoGuardado.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 space-y-1">
          {avisoGuardado.map((e, i) => <p key={i}>⚠️ {e}</p>)}
          <button onClick={() => setAvisoGuardado([])} className="underline font-bold">Entendido</button>
        </div>
      )}

      {/* COBERTURA FALTANTE */}
      {res && (faltantes.length > 0 || res.sinJuzgar.length > 0) && (
        <section className="bg-white rounded-2xl border shadow-sm p-5 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-sm font-bold text-gray-800">
              🧭 Cobertura faltante {alarmas.length > 0 && <span className="ml-1 text-red-700">· {alarmas.length} por atender</span>}
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(CODIGOS_FALTANTE).map(([cod, cfg]) => {
                const n = faltantes.filter((f) => f.codigo === cod).length;
                if (!n) return null;
                return (
                  <span key={cod} className="text-[10px] font-bold px-2 py-0.5 rounded-lg"
                    style={cfg.alarma ? { background: "#fee2e2", color: "#991b1b" } : { background: "#f3f4f6", color: "#4b5563" }}>
                    {cfg.titulo}: {n}
                  </span>
                );
              })}
            </div>
          </div>
          {res.sinJuzgar.length > 0 && (
            <p className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              ⚠️ No se juzgó (una fuente no se pudo leer o falta su migración): {res.sinJuzgar.join(" · ")}. Que no salga aquí no significa que esté cubierto.
            </p>
          )}
          {inclusionesPorPoliza.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-bold text-amber-900">📨 Inclusiones en trámite — no están cubiertos todavía</p>
              {inclusionesPorPoliza.map(({ sid, fs, pol }) => (
                <div key={sid} className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="font-bold">
                      {pol ? etiquetaDeTipos(tiposDePoliza(pol)) : "Póliza"} · {pol?.numero_poliza ? `N° ${pol.numero_poliza}` : `#${sid}`}{pol?.aseguradora ? ` · ${pol.aseguradora}` : ""}
                      <span className="font-normal"> — {fs.length} persona(s)</span>
                    </p>
                    <button onClick={() => editar(sid)} className="px-2.5 py-1 rounded-lg border border-amber-300 bg-white font-bold hover:bg-amber-100">Gestionar →</button>
                  </div>
                  <ul className="mt-1 space-y-0.5">
                    {fs.map((f, i) => {
                      const n = f.codigo === "inclusion_solicitada" && f.fechaInclusion && hoy ? diasEntreFechas(f.fechaInclusion, hoy) : null;
                      return (
                        <li key={`${f.asegurado.clase}:${f.asegurado.id}:${i}`}>
                          <b>{f.asegurado.rotulo}</b> · {etiquetaDeTipos(f.tipos ?? [f.tipo])} ·{" "}
                          {f.codigo === "inclusion_solicitada"
                            ? (f.fechaInclusion ? `solicitada el ${fmtDM(f.fechaInclusion)} · ${n} día${n === 1 ? "" : "s"} esperando` : "solicitada (sin fecha)")
                            : `incluido desde el ${fmtDM(f.fechaInclusion)}: no asignarlo antes`}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
          <div className="space-y-1.5">
            {faltVisibles.map((f, i) => {
              const cfg = CODIGOS_FALTANTE[f.codigo];
              const rojo = cfg.alarma && /vencid|sin_soat/.test(f.codigo);
              const estilo = !cfg.alarma ? { bg: "#f9fafb", bd: "#e5e7eb", tx: "#4b5563" }
                : rojo ? { bg: "#fef2f2", bd: "#fecaca", tx: "#991b1b" } : { bg: "#fffbeb", bd: "#fde68a", tx: "#92400e" };
              const ruta = rutaDeArreglo(f.arreglo);
              return (
                <div key={`${f.codigo}:${f.asegurado.clase}:${f.asegurado.id}:${f.tipo}:${i}`}
                  className="rounded-xl border px-3 py-2 text-xs flex items-start justify-between gap-3 flex-wrap"
                  style={{ background: estilo.bg, borderColor: estilo.bd, color: estilo.tx }}>
                  <div className="min-w-0">
                    <p><b>{cfg.titulo}</b> — {f.texto}</p>
                    <p className="opacity-80 mt-0.5">Se corrige en: {f.arreglo}</p>
                  </div>
                  {ruta && (
                    <Link href={ruta} className="shrink-0 px-2.5 py-1.5 rounded-lg border font-bold bg-white hover:bg-gray-50" style={{ borderColor: estilo.bd }}>
                      Ir a {pantallaDe(ruta)} →
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
          {otrosFalt.length > 12 && (
            <button onClick={() => setVerTodosFalt((v) => !v)} className="text-xs font-bold text-[#0b315f] underline">
              {verTodosFalt ? "Ver menos" : `Ver los ${otrosFalt.length}`}
            </button>
          )}
        </section>
      )}
      {res && faltantes.length === 0 && res.sinJuzgar.length === 0 && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-xs text-gray-600">
          🧭 Cobertura: toda la flota activa tiene SOAT/CAT vigente y todas las personas activas tienen SCTR Salud, SCTR Pensión y Vida Ley.
        </div>
      )}

      {/* KPIs */}
      <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {[
          { label: "Seguros",       valor: loading && !res ? "…" : kv(k.total),       color: "#0b315f", bg: "#eef3f8" },
          { label: "Vigentes",      valor: loading && !res ? "…" : kv(k.vigentes),    color: "#166534", bg: "#dcfce7" },
          { label: "Por vencer",    valor: loading && !res ? "…" : kv(k.porVencer),   color: "#854d0e", bg: "#fef9c3" },
          { label: "Vencidos",      valor: loading && !res ? "…" : kv(k.vencidos),    color: "#991b1b", bg: "#fee2e2" },
          { label: "Sin fecha",     valor: loading && !res ? "…" : kv(k.sinFecha),    color: "#4b5563", bg: "#f3f4f6" },
          { label: "Prima anual (AFA)",   valor: loading && !res ? "…" : primaDesconocida ? "?" : fmtSoles(k.primaTotal), color: "#6d28d9", bg: "#ede9fe" },
          { label: "Cuota mensual (AFA)", valor: loading && !res ? "…" : primaDesconocida ? "?" : fmtSoles(k.cuotaTotal), color: "#0f766e", bg: "#f0fdfa" },
        ].map((x) => (
          <div key={x.label} className="rounded-xl p-3 border" style={{ background: x.bg, borderColor: x.color + "22" }}
            title={algunError ? `No se pudo leer: ${fuentesConError.map((f) => FUENTE_LABEL[f].label).join(", ") || "los seguros"}` : undefined}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: x.color + "99" }}>{x.label}</p>
            <p className="text-lg font-black mt-0.5 leading-tight" style={{ color: x.color }}>{x.valor}</p>
          </div>
        ))}
      </section>
      {res && (
        <p className="text-[11px] text-gray-400 -mt-2">
          Las primas de las unidades tercerizadas no suman: cuentan para el cumplimiento, pero las paga su empresa.
          {algunError && <span className="text-red-700 font-bold"> «?» = una fuente no se pudo leer ({fuentesConError.map((f) => FUENTE_LABEL[f].label).join(", ") || "todo"}).</span>}
        </p>
      )}

      {/* TIMELINE — próximos 60 días */}
      {proximosVencer.length > 0 && (
        <section className="bg-white rounded-2xl border shadow-sm p-5">
          <h2 className="text-sm font-bold text-gray-700 mb-4">📅 Próximos vencimientos — 60 días</h2>
          <div className="space-y-2">
            {proximosVencer.slice(0, 15).map((s) => {
              const dias = s.dias ?? 0;
              const cfg = TIPOS_SEGURO[s.tipo] || TIPOS_SEGURO.otro;
              const urgente = dias <= 7, proximo = dias <= 30;
              const barW = Math.max(0, 100 - (dias / 60) * 100);
              return (
                <div key={s.clave} className="flex items-center gap-4 rounded-xl px-4 py-2.5"
                  style={{ background: urgente ? "#fee2e2" : proximo ? "#fef9c3" : "#f8fafc" }}>
                  <div className="text-xl">{cfg.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm text-gray-800">{s.etiqueta}</span>
                      <span className="text-xs text-gray-600">— {s.asegurado.rotulo}</span>
                      {s.aseguradora && <span className="text-xs text-gray-400">{s.aseguradora}</span>}
                    </div>
                    <div className="mt-1.5 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${barW}%`, background: urgente ? "#dc2626" : proximo ? "#eab308" : "#0b315f" }} />
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="font-black text-sm" style={{ color: urgente ? "#dc2626" : proximo ? "#854d0e" : "#0b315f" }}>{dias === 0 ? "Hoy" : `${dias}d`}</div>
                    <div className="text-[10px] text-gray-400">{fmtFecha(s.vencimiento)}</div>
                  </div>
                </div>
              );
            })}
            {proximosVencer.length > 15 && <p className="text-xs text-gray-400">y {proximosVencer.length - 15} más (filtra por «Por vencer» abajo).</p>}
          </div>
        </section>
      )}

      {/* FORMULARIO — PÓLIZA COLECTIVA */}
      {cargandoPoliza && <p className="text-sm text-gray-500">Abriendo la póliza…</p>}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-4 md:p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-xl flex-shrink-0" style={{ background: tipoCfg.bg }}>{tipoCfg.icon}</div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar póliza" : "Registrar póliza colectiva"}</h2>
              <p className="text-xs text-gray-500">SCTR Salud/Pensión, Vida Ley, Responsabilidad Civil o Todo Riesgo de flota… una póliza que cubre a varios. El SOAT de cada placa va en sus documentos.</p>
            </div>
          </div>

          {/* Tipo */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Tipo de seguro</p>
            {(["obligatorio", "complementario"] as const).map((cat) => (
              <div key={cat} className="mb-3">
                <p className={`text-[10px] font-bold uppercase mb-1.5 ${cat === "obligatorio" ? "text-red-500" : "text-blue-500"}`}>
                  {cat === "obligatorio" ? "🔴 Obligatorios" : "🔵 Complementarios"}
                </p>
                <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
                  {Object.entries(TIPOS_SEGURO).filter(([, v]) => v.categoria === cat).map(([kk, v]) => {
                    const activo = form.tipo === kk;
                    return (
                      <button key={kk} type="button" onClick={() => {
                        setForm((p) => ({ ...p, tipo: kk }));
                        if (esTipoPersona(kk) && !coberturasSel.includes(kk)) setCoberturasSel(multiples ? canonico([...coberturasSel, kk]) : [kk]);
                      }}
                        className="flex flex-col items-center gap-1 px-2 py-2.5 rounded-xl border-2 transition-all text-center min-h-[44px]"
                        style={{ background: activo ? v.bg : "white", borderColor: activo ? v.color : "#e5e7eb", color: activo ? v.color : "#9ca3af" }}>
                        <span className="text-lg">{v.icon}</span>
                        <span className="text-[10px] font-bold leading-tight">{v.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {esPersonaForm && (
              <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 mt-1 space-y-2">
                <p className="text-[11px] font-bold text-gray-700">Esta póliza cubre:</p>
                <div className="flex flex-wrap gap-3">
                  {TIPOS_PERSONA.map((t) => {
                    const marcado = coberturasSel.includes(t);
                    const bloqueado = !multiples && t !== form.tipo;
                    return (
                      <label key={t} className={`flex items-center gap-2 text-xs min-h-[32px] ${bloqueado ? "text-gray-300" : "text-gray-800 cursor-pointer"}`}>
                        <input type="checkbox" className="w-4 h-4 accent-[#0b315f]" disabled={bloqueado}
                          checked={multiples ? marcado : t === form.tipo}
                          onChange={() => {
                            if (!multiples) return;
                            const sig = marcado ? coberturasSel.filter((x) => x !== t) : canonico([...coberturasSel, t]);
                            if (sig.length === 0) return; // al menos una
                            setCoberturasSel(sig);
                            setForm((p) => ({ ...p, tipo: sig[0] }));
                          }} />
                        {ETQ_PERSONA[t]}
                      </label>
                    );
                  })}
                </div>
                {multiples ? (
                  <p className="text-[10px] text-gray-500">
                    Se guarda como una sola póliza «{etiquetaDeTipos(canonico(coberturasSel))}»: una fila en la tabla, la prima se cuenta una vez, y cada asegurado queda cubierto en los {coberturasSel.length} tipos.
                  </p>
                ) : (
                  <p className="text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                    ⚠️ Esta base solo admite UN tipo por póliza: falta la columna «coberturas». Corre <b>{SQL_04A}</b> en Supabase → SQL Editor para registrar SCTR Salud + Pensión + Vida Ley en una sola póliza. Mientras tanto, una póliza por tipo.
                  </p>
                )}
              </div>
            )}
            {esDocumentoVehicular && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                ⚠️ El <b>{tipoCfg.label}</b> es de cada placa y se registra en sus documentos, con su fecha y su archivo:
                así la unidad pasa a «No apto» si vence. {editandoId ? "Esta póliza ya existía como registro aquí; puedes corregirla, pero conviene pasarla a los documentos de la unidad y eliminarla de aquí." : "Aquí no se guarda."}{" "}
                <Link href="/documentos-vehiculares" className="font-bold underline">Ir a Documentos vehiculares →</Link>
              </div>
            )}
          </div>

          {/* Datos */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos de la póliza</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Aseguradora *">
                <select className={inputCls()} value={form.aseguradora} onChange={(e) => setForm((p) => ({ ...p, aseguradora: e.target.value }))}>
                  <option value="">Seleccionar aseguradora</option>
                  {ASEGURADORAS.map((a) => <option key={a} value={a}>{a}</option>)}
                  {form.aseguradora && !ASEGURADORAS.includes(form.aseguradora) && <option value={form.aseguradora}>{form.aseguradora}</option>}
                </select>
              </Campo>
              <Campo label="Número de póliza">
                <input className={inputCls("font-mono")} placeholder="Ej: POL-2024-001234" value={form.numero_poliza} onChange={(e) => setForm((p) => ({ ...p, numero_poliza: e.target.value }))} />
              </Campo>
              <Campo label="Titular / Contratante">
                <input className={inputCls()} placeholder="Razón social del contratante" value={form.titular} onChange={(e) => setForm((p) => ({ ...p, titular: e.target.value }))} />
              </Campo>
              {!selectorDisponible && TIPOS_VEHICULARES.includes(form.tipo) && (
                <Campo label="Vehículo asociado">
                  <select className={inputCls()} value={form.vehiculo_id} onChange={(e) => setForm((p) => ({ ...p, vehiculo_id: e.target.value }))}>
                    <option value="">Aplica a toda la flota</option>
                    {candidatos.filter((c) => c.clase === "vehiculo").map((v) => <option key={v.id} value={v.id}>{v.rotulo}</option>)}
                  </select>
                </Campo>
              )}
              <Campo label="Broker / Proveedor">
                <select className={inputCls()} value={form.proveedor_id} onChange={(e) => setForm((p) => ({ ...p, proveedor_id: e.target.value }))}>
                  <option value="">Sin broker</option>
                  {proveedores.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
                </select>
              </Campo>
            </div>
          </div>

          {/* Vigencia y costos */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Vigencia y costos</p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Campo label="Fecha de inicio">
                <input type="date" className={inputCls()} value={form.fecha_inicio} onChange={(e) => setForm((p) => ({ ...p, fecha_inicio: e.target.value }))} />
              </Campo>
              <Campo label="Fecha de vencimiento *">
                <input type="date" className={inputCls(diasForm !== null && diasForm < 0 ? "border-red-400 bg-red-50" : "")}
                  value={form.fecha_vencimiento} onChange={(e) => setForm((p) => ({ ...p, fecha_vencimiento: e.target.value }))} />
                {diasForm !== null && (
                  <p className="text-[10px] mt-1 font-bold" style={{ color: diasForm < 0 ? "#dc2626" : diasForm <= 30 ? "#854d0e" : "#166534" }}>
                    {diasForm < 0 ? "⚠ Póliza vencida" : diasForm === 0 ? "Vence hoy" : `Vence en ${diasForm} días`}
                  </p>
                )}
              </Campo>
              <Campo label="Prima total S/">
                <input type="number" min="0" step="0.01" className={inputCls()} placeholder="sin dato" value={form.prima_total} onChange={(e) => setForm((p) => ({ ...p, prima_total: e.target.value }))} />
              </Campo>
              <Campo label="Cuota mensual S/">
                <input type="number" min="0" step="0.01" className={inputCls()} placeholder="sin dato" value={form.cuota_mensual} onChange={(e) => setForm((p) => ({ ...p, cuota_mensual: e.target.value }))} />
              </Campo>
            </div>
          </div>

          {/* Asegurados */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
              Asegurados de la póliza {selectorDisponible && <span className="text-[#0b315f]">· {nVigentes} en la póliza{cubSel.size > 0 ? ` · ${cubSel.size} por agregar` : ""}</span>}
            </p>
            {cobNoLeida || res?.coberturas === "error" ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">
                No se pudieron leer los asegurados{cobNoLeida ? `: ${cobNoLeida}` : ""}. El selector se oculta para no duplicarlos ni perderlos al guardar; recarga para reintentar.
              </div>
            ) : !selectorDisponible ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                ⚠️ No se puede elegir a quién cubre la póliza: falta la tabla <b>seguro_cobertura</b>. Corre <b>supabase/seguros-02-cobertura.sql</b> en Supabase → SQL Editor.
                Mientras tanto la póliza se guarda sin asegurados y las personas siguen leyéndose de su ficha.
              </div>
            ) : (
              <div className="space-y-3">
                {/* Los que ya están en la póliza, con su estado y sus acciones */}
                {editandoId && cubOriginal.size > 0 && (
                  <div className="border rounded-xl p-3 space-y-1.5">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <p className="text-xs font-bold text-gray-700">En la póliza ({cubOriginal.size})</p>
                      {(() => {
                        const solicitados = [...cubOriginal.entries()].filter(([, f]) => estadoCobertura(f) === "solicitada").map(([k]) => k);
                        const marcadosPersona = [...cubSel].filter((k) => k.startsWith("conductor:") || k.startsWith("personal:"));
                        const objetivo = marcadosPersona.length ? marcadosPersona : solicitados;
                        return (
                          <div className="flex items-center gap-2 flex-wrap">
                            {puedeVerSueldo && (
                              <label className="flex items-center gap-1.5 text-[11px] text-gray-600">
                                <input type="checkbox" className="w-3.5 h-3.5 accent-[#0b315f]" checked={conSueldo} onChange={(e) => setConSueldo(e.target.checked)} /> incluir remuneración
                              </label>
                            )}
                            <button type="button" disabled={objetivo.length === 0} onClick={() => copiarLista(editandoId, objetivo)}
                              className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg border bg-white hover:bg-gray-50 disabled:opacity-40">
                              📋 Copiar lista para el bróker ({objetivo.length})
                            </button>
                            {objetivo.length === 0 && <span className="text-[10px] text-gray-400">Sin inclusiones solicitadas ni personas marcadas abajo.</span>}
                            {objetivo.length > 0 && <span className="text-[10px] text-gray-400">{marcadosPersona.length ? "de los marcados abajo" : "de las inclusiones solicitadas"}</span>}
                          </div>
                        );
                      })()}
                    </div>
                    <PanelCopia copia={copia} onCerrar={() => setCopia(null)} />
                    <div className="max-h-72 overflow-y-auto divide-y">
                      {[...cubOriginal.entries()]
                        .sort(([ka, a], [kb, b]) => Number(estadoCobertura(b) === "solicitada") - Number(estadoCobertura(a) === "solicitada")
                          || Number(esBaja(a, hoy)) - Number(esBaja(b, hoy)) || (rotuloCub.get(ka) ?? ka).localeCompare(rotuloCub.get(kb) ?? kb))
                        .map(([k, f]) => {
                          const chip = chipCobertura(f, { fecha_inicio: form.fecha_inicio || null }, hoy);
                          const sol = estadoCobertura(f) === "solicitada";
                          const baja = esBaja(f, hoy);
                          const abierta = accionCob?.clave === k;
                          return (
                            <div key={k} className="py-1.5 text-xs">
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="text-gray-800 font-semibold truncate">{rotuloCub.get(k) ?? k}</span>
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: chip.bg, color: chip.color }}>{chip.texto}</span>
                                  {f.constancia_url && <EnlacePrivado href={f.constancia_url} target="_blank" rel="noopener noreferrer" className="text-[10px] font-bold text-blue-600 underline">📄 constancia</EnlacePrivado>}
                                  {f.id == null && <span className="text-[10px] text-gray-400">(de la póliza antigua: se pasa a la lista al guardar)</span>}
                                </div>
                                {f.id != null && (
                                  <div className="flex items-center gap-1.5">
                                    {puedeSolicitar && !baja && (sol || (chip.texto.startsWith("Por iniciar"))) && (
                                      <button type="button" disabled={aplicando} onClick={() => setAccionCob({ clave: k, tipo: "incluir", fecha: f.desde ?? "", archivo: null })}
                                        className="px-2 py-1 rounded-lg border border-green-200 text-green-800 font-bold hover:bg-green-50">✓ Marcar incluido</button>
                                    )}
                                    {!baja && !sol && (
                                      <button type="button" disabled={aplicando} onClick={() => setAccionCob({ clave: k, tipo: "baja", fecha: hoy, archivo: null })}
                                        className="px-2 py-1 rounded-lg border text-gray-700 font-bold hover:bg-gray-50">Dar de baja</button>
                                    )}
                                    {sol && (
                                      <button type="button" disabled={aplicando} onClick={() => quitarSolicitada(k)}
                                        className="px-2 py-1 rounded-lg border border-red-100 text-red-600 font-bold hover:bg-red-50">Quitar</button>
                                    )}
                                    {baja && <span className="text-[10px] text-gray-400">márcalo abajo para reincluirlo</span>}
                                  </div>
                                )}
                              </div>
                              {f.nota && <p className="text-[10px] text-gray-400 mt-0.5">{f.nota}</p>}
                              {abierta && accionCob && (
                                <div className="mt-1.5 rounded-lg border bg-gray-50 px-3 py-2 flex items-end gap-3 flex-wrap">
                                  <div>
                                    <label className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">
                                      {accionCob.tipo === "incluir" ? "Cubre desde * (la fecha de la constancia)" : "Fecha de baja *"}
                                    </label>
                                    <input type="date" className={inputCls("py-1.5")} value={accionCob.fecha}
                                      onChange={(e) => setAccionCob((a) => a && ({ ...a, fecha: e.target.value }))} />
                                  </div>
                                  {accionCob.tipo === "incluir" && (
                                    <div>
                                      <label className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Constancia (opcional)</label>
                                      <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="text-[11px]"
                                        onChange={(e) => {
                                          const a = e.target.files?.[0] ?? null;
                                          if (a) { const r = revisarArchivo(a); if (!r.ok) { alert(`No se puede adjuntar «${a.name}»: ${r.motivo}`); e.target.value = ""; return; } }
                                          setAccionCob((x) => x && ({ ...x, archivo: a }));
                                        }} />
                                    </div>
                                  )}
                                  <button type="button" disabled={aplicando || !accionCob.fecha} onClick={aplicarAccion}
                                    className="px-3 py-1.5 rounded-lg text-white font-bold disabled:opacity-50" style={{ background: "#0b315f" }}>
                                    {aplicando ? "Guardando…" : accionCob.tipo === "incluir" ? "Guardar inclusión" : "Guardar baja"}
                                  </button>
                                  <button type="button" onClick={() => setAccionCob(null)} className="px-3 py-1.5 rounded-lg border font-bold text-gray-600">Cancelar</button>
                                  {!accionCob.fecha && <p className="w-full text-[10px] text-gray-500">Falta la fecha: {accionCob.tipo === "incluir" ? "desde cuándo cubre según la constancia del bróker." : "desde cuándo deja de estar cubierto."}</p>}
                                </div>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  </div>
                )}

                {/* Interruptor: cómo nacen los que se agregan */}
                <div className={`rounded-xl border px-3 py-2 text-xs ${yaFiguran || !puedeSolicitar ? "border-gray-200 bg-white" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
                  <label className="flex items-center gap-2 font-bold cursor-pointer">
                    <input type="checkbox" className="w-4 h-4 accent-[#0b315f]" checked={yaFiguran || !puedeSolicitar} disabled={!puedeSolicitar}
                      onChange={(e) => setYaFiguran(e.target.checked)} />
                    Ya figuran en la constancia de la póliza
                  </label>
                  <p className="mt-1 text-[11px]">
                    {yaFiguran || !puedeSolicitar
                      ? "Los que marques abajo entran como INCLUIDOS: cubiertos desde el inicio de la póliza."
                      : `Los que marques abajo entran como inclusión SOLICITADA el ${fmtFecha(hoy)}: NO quedan cubiertos hasta que marques «Incluido» con la fecha de la constancia del bróker.`}
                  </p>
                  {!puedeSolicitar && (
                    <p className="mt-1 text-[11px] text-amber-900">
                      ⚠️ No se puede registrar una inclusión pendiente: falta la columna «estado» de seguro_cobertura. Corre <b>{SQL_04A}</b> en Supabase → SQL Editor. Mientras tanto todo lo que agregues queda como incluido (cubierto).
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {GRUPOS_CUBIERTOS.map((g) => {
                    const lista = candidatosDe(g.clase);
                    const marcables = lista.filter((c) => !enPoliza(c.clave));
                    const todosMarcados = marcables.length > 0 && marcables.every((c) => cubSel.has(c.clave));
                    return (
                      <div key={g.clase} className="border rounded-xl p-3">
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <p className="text-xs font-bold text-gray-700">{g.icon} {g.titulo} <span className="text-gray-400">· {nCubiertos(g.clase)}</span></p>
                          <button type="button" disabled={marcables.length === 0} onClick={() => marcarTodos(g.clase, !todosMarcados)}
                            className="text-[11px] font-bold text-[#0b315f] underline disabled:opacity-40">
                            {todosMarcados ? "Desmarcar" : "Marcar"} {busCub[g.clase] ? "los filtrados" : "todos"}
                          </button>
                        </div>
                        <input className={inputCls("py-1.5 mb-2")} placeholder="Buscar…" value={busCub[g.clase]}
                          onChange={(e) => setBusCub((b) => ({ ...b, [g.clase]: e.target.value }))} />
                        <div className="max-h-44 overflow-y-auto space-y-0.5">
                          {lista.length === 0 && <p className="text-[11px] text-gray-400 px-1">{candidatos.length === 0 ? "Comprobando…" : "Nadie coincide."}</p>}
                          {lista.map((c) => {
                            const ya = cubOriginal.get(c.clave);
                            const fija = enPoliza(c.clave);
                            const chip = ya ? chipCobertura(ya, { fecha_inicio: form.fecha_inicio || null }, hoy) : null;
                            return (
                              <label key={c.clave} className={`flex items-center gap-2 px-1 py-1 rounded text-xs ${fija ? "" : "hover:bg-gray-50 cursor-pointer"}`}>
                                <input type="checkbox" className="w-4 h-4 accent-[#0b315f]" disabled={fija}
                                  checked={fija || cubSel.has(c.clave)} onChange={() => alternar(c.clave)} />
                                <span className={c.activo ? "text-gray-800" : "text-gray-400"}>{c.rotulo}{!c.activo && " (inactivo)"}</span>
                                {chip && <span className="text-[9px] font-bold px-1 rounded" style={{ background: chip.bg, color: chip.color }}>{chip.texto}{!fija ? " · reincluir" : ""}</span>}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {editandoId && cubSel.size > 0 && (
                  <div className="flex items-center gap-3 flex-wrap">
                    <button type="button" disabled={aplicando} onClick={agregarAhora}
                      className="px-4 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-50" style={{ background: yaFiguran || !puedeSolicitar ? "#0b315f" : "#b45309" }}>
                      {aplicando ? "Guardando…" : yaFiguran || !puedeSolicitar ? `Agregar ${cubSel.size} como incluidos` : `Solicitar inclusión de ${cubSel.size}`}
                    </button>
                    <span className="text-[11px] text-gray-500">También se aplica al pulsar «Actualizar póliza».</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Archivo y notas */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Campo label="PDF de la póliza">
              {archivoUrlOriginal && (
                <div className="mb-2 space-y-1">
                  <EnlacePrivado href={form.archivo_url || archivoUrlOriginal} target="_blank" rel="noopener noreferrer" className="text-xs font-bold text-blue-600 underline">📄 Ver el archivo actual</EnlacePrivado>
                  <input className={inputCls("text-xs")} placeholder="URL del archivo" value={form.archivo_url}
                    onChange={(e) => setForm((p) => ({ ...p, archivo_url: e.target.value }))} />
                  <p className="text-[10px] text-gray-400">Vacía el campo para quitar el archivo, o sube otro abajo para reemplazarlo.</p>
                </div>
              )}
              <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="text-xs"
                onChange={(e) => {
                  const a = e.target.files?.[0] ?? null;
                  if (a) { const r = revisarArchivo(a); if (!r.ok) { alert(`No se puede adjuntar «${a.name}»: ${r.motivo}`); e.target.value = ""; return; } }
                  setArchivoNuevo(a);
                }} />
              {archivoNuevo && <p className="text-[10px] text-gray-500 mt-1">Se subirá al guardar: {archivoNuevo.name}</p>}
            </Campo>
            <Campo label="Observaciones">
              <input className={inputCls()} placeholder="Notas adicionales..." value={form.observaciones} onChange={(e) => setForm((p) => ({ ...p, observaciones: e.target.value }))} />
            </Campo>
          </div>

          <div>
            <div className="flex gap-3 flex-wrap">
              <button onClick={guardar} disabled={guardando || !!bloqueoGuardar}
                className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-50 hover:opacity-90" style={{ background: "#0b315f" }}>
                {guardando ? "Guardando..." : editandoId ? "Actualizar póliza" : "Guardar póliza"}
              </button>
              <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
            </div>
            {bloqueoGuardar && <p className="text-xs text-gray-500 mt-2">No se puede guardar todavía: {bloqueoGuardar}</p>}
          </div>
        </section>
      )}

      {/* FILTROS */}
      <section className="flex flex-col md:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
            placeholder="Buscar por asegurado, placa, aseguradora, póliza…" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
        </div>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroFuente} onChange={(e) => setFiltroFuente(e.target.value as "todos" | FuenteSeguro)}>
          <option value="todos">Todas las fuentes</option>
          {FUENTES_SEGURO.map((f) => (
            <option key={f} value={f}>{FUENTE_LABEL[f].label}{res?.fuentes[f] === "error" ? " (no se pudo leer)" : res?.fuentes[f] === "sin_tabla" ? " (falta migración)" : ""}</option>
          ))}
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroFlota} onChange={(e) => setFiltroFlota(e.target.value as "todas" | "propia" | "tercerizada")}>
          <option value="todas">Propia y tercerizada</option>
          <option value="propia">Flota propia / AFA</option>
          <option value="tercerizada">Flota tercerizada</option>
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroCat} onChange={(e) => setFiltroCat(e.target.value)}>
          <option value="todos">Todas las categorías</option>
          <option value="obligatorio">🔴 Obligatorios</option>
          <option value="complementario">🔵 Complementarios</option>
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value)}>
          <option value="todos">Todos los tipos</option>
          {Object.entries(TIPOS_SEGURO).map(([kk, v]) => <option key={kk} value={kk}>{v.icon} {v.label}</option>)}
          <option value={SCTR_SIN_PRECISAR}>⚠️ SCTR sin precisar</option>
        </select>
        <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEst} onChange={(e) => setFiltroEst(e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="vigente">✅ Vigentes</option>
          <option value="por_vencer">⚠️ Por vencer</option>
          <option value="vencido">🔴 Vencidos</option>
          <option value="sin_fecha">— Sin fecha</option>
        </select>
        <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">
          {loading && !res ? "…" : `${filtrados.length} resultado${filtrados.length !== 1 ? "s" : ""}`}
        </div>
      </section>

      {/* TABLA */}
      <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                <th className="p-3 w-8"></th>
                {["Tipo", "Asegurado", "Fuente", "Aseguradora", "Póliza / N°", "Vigencia", "Días", "Prima", "Estado", "Acciones"].map((h) => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && !res ? (
                <tr><td colSpan={11} className="p-10 text-center text-gray-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Leyendo documentos, fichas y pólizas…
                  </div>
                </td></tr>
              ) : filtrados.length === 0 ? (
                <tr><td colSpan={11} className="p-10 text-center text-gray-400">
                  <p className="text-3xl mb-2">🛡️</p>
                  <p className="font-medium">
                    {errorCarga ? "No se pudo leer: no se puede afirmar que no haya seguros."
                      : filas.length === 0 ? (algunError ? "Sin seguros en las fuentes que sí se pudieron leer." : "No hay seguros registrados en ninguna fuente.")
                      : "Ningún seguro coincide con los filtros."}
                  </p>
                </td></tr>
              ) : filtrados.map((s) => {
                const cfg = TIPOS_SEGURO[s.tipo] || TIPOS_SEGURO.otro;
                const abierto = expandido === s.clave;
                const esOblig = s.tipo === SCTR_SIN_PRECISAR || cfg.categoria === "obligatorio";
                const rowBg = s.estado === "vencido" ? "#fff5f5" : s.estado === "por_vencer" ? "#fffbeb" : "white";
                const est = s.estado === "vigente" ? { bg: "#dcfce7", c: "#166534", l: "✅ Vigente" }
                  : s.estado === "por_vencer" ? { bg: "#fef9c3", c: "#854d0e", l: "⚠️ Por vencer" }
                  : s.estado === "vencido" ? { bg: "#fee2e2", c: "#991b1b", l: "🔴 Vencido" }
                  : { bg: "#f3f4f6", c: "#4b5563", l: "— Sin fecha" };
                const fl = FUENTE_LABEL[s.fuente];
                const cubre: ClaveAsegurado[] = s.cubre ?? [];
                return (
                  <React.Fragment key={s.clave}>
                    <tr className="border-t transition-colors cursor-pointer hover:brightness-95" style={{ background: rowBg, borderColor: "#f1f5f9" }}
                      onClick={() => setExpandido(abierto ? null : s.clave)}>
                      <td className="p-3 text-gray-300 text-xs">{abierto ? "▼" : "▶"}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-1.5">
                          <span className="text-base">{s.tipo === SCTR_SIN_PRECISAR ? "⚠️" : cfg.icon}</span>
                          <div>
                            <div className="text-xs font-black" style={{ color: s.tipo === SCTR_SIN_PRECISAR ? "#92400e" : cfg.color }}>{s.etiqueta}</div>
                            {esOblig && <div className="text-[9px] text-red-500 font-bold uppercase">Obligatorio</div>}
                          </div>
                        </div>
                      </td>
                      <td className="p-3 text-xs font-bold text-gray-800">
                        {s.asegurado.rotulo}
                        {s.solicitados > 0 && <div className="text-[9px] font-bold text-amber-800">{s.solicitados} inclusión(es) solicitada(s)</div>}
                        {!s.deAfa && <div className="text-[9px] font-bold uppercase text-amber-700">tercerizada</div>}
                      </td>
                      <td className="p-3">
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg whitespace-nowrap" style={{ background: fl.bg, color: fl.color }}>{fl.label}</span>
                      </td>
                      <td className="p-3 text-xs text-gray-700">{s.aseguradora || "—"}</td>
                      <td className="p-3 font-mono text-xs text-gray-500">{s.numero || "—"}</td>
                      <td className="p-3 text-xs text-gray-500 whitespace-nowrap">
                        {s.inicio && <div>{fmtFecha(s.inicio)} →</div>}
                        <div className="font-bold text-gray-700">{fmtFecha(s.vencimiento)}</div>
                      </td>
                      <td className="p-3">
                        {s.dias !== null ? (
                          <div className="text-center">
                            <div className="font-black text-sm" style={{ color: s.dias < 0 || s.dias <= 7 ? "#dc2626" : s.dias <= 30 ? "#d97706" : "#166534" }}>
                              {s.dias < 0 ? `+${Math.abs(s.dias)}d` : `${s.dias}d`}
                            </div>
                            <div className="text-[9px] text-gray-400">{s.dias < 0 ? "vencido" : "restantes"}</div>
                          </div>
                        ) : "—"}
                      </td>
                      <td className="p-3 font-bold text-xs text-gray-700 whitespace-nowrap">
                        {s.prima != null ? fmtSoles(s.prima) : "—"}
                        {s.cuota != null && s.cuota > 0 && <div className="text-[10px] font-normal text-gray-500">{fmtSoles(s.cuota)}/mes</div>}
                      </td>
                      <td className="p-3">
                        <span className="text-xs font-bold px-2 py-1 rounded-lg whitespace-nowrap" style={{ background: est.bg, color: est.c }}>{est.l}</span>
                      </td>
                      <td className="p-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5">
                          {s.archivo && (
                            <EnlacePrivado href={s.archivo} target="_blank" rel="noopener noreferrer"
                              className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-blue-50 text-blue-600 border-blue-100">📄</EnlacePrivado>
                          )}
                          {s.fuente === "poliza" ? (
                            <>
                              <button onClick={() => editar(s.origenId)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700" title="Editar póliza">✏️</button>
                              <button onClick={() => eliminar(s)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50" title="Eliminar póliza">✕</button>
                            </>
                          ) : (
                            <Link href={s.editarEn} className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700 whitespace-nowrap">
                              Editar en {pantallaDe(s.editarEn)} →
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>

                    {abierto && (
                      <tr style={{ background: "#f8fafc" }} className="border-t">
                        <td colSpan={11} className="px-6 py-4">
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">De dónde sale</p>
                              <p><span className="text-gray-400">Fuente:</span> <b>{fl.label}</b></p>
                              <p className="text-gray-500">
                                {s.fuente === "poliza" ? "Póliza registrada en esta pantalla: se edita aquí."
                                  : `Este dato vive en ${pantallaDe(s.editarEn)} y se corrige allí; esta pantalla solo lo enseña.`}
                              </p>
                              {s.tipo === SCTR_SIN_PRECISAR && <p className="text-amber-800 font-bold">Este «SCTR» no dice si es Salud o Pensión: no cuenta para ninguno de los dos hasta que se corrija su tipo.</p>}
                              {!s.deAfa && <p className="text-amber-800">Es de una unidad tercerizada: cuenta para el cumplimiento, su prima no la paga AFA.</p>}
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Cubre a</p>
                              {s.fuente === "poliza" ? (() => {
                                const pol = (res?.polizas ?? []).find((x) => Number(x.id) === s.origenId) ?? null;
                                const suyas = (res?.asegurados ?? []).filter((c) => Number(c.seguro_id) === s.origenId);
                                if (suyas.length === 0) {
                                  return cubre.length === 0
                                    ? <p className="text-gray-400">{res?.coberturas === "sin_tabla" ? "Sin asegurados: falta supabase/seguros-02-cobertura.sql." : "Ningún asegurado registrado."}</p>
                                    : <p className="text-gray-700">{cubre.map((c) => rotuloCub.get(claveCub(c.clase, c.id)) ?? `${c.clase} #${c.id}`).join(" · ")}</p>;
                                }
                                const filasCob = suyas.map((c) => ({ c, k: claveDeFila(c) })).filter((x): x is { c: CoberturaRow; k: string } => !!x.k);
                                const solicitados = filasCob.filter((x) => estadoCobertura(x.c) === "solicitada").map((x) => x.k);
                                return (
                                  <div className="space-y-1">
                                    <div className="max-h-48 overflow-y-auto space-y-0.5">
                                      {filasCob.map(({ c, k }) => {
                                        const chip = chipCobertura({ id: c.id ?? null, desde: c.desde ?? null, hasta: c.hasta ?? null, estado: (c.estado as string) ?? null, solicitada_en: c.solicitada_en ?? null, constancia_url: c.constancia_url ?? null, nota: c.nota ?? null }, pol, hoy);
                                        return (
                                          <div key={k} className="flex items-center gap-1.5">
                                            <span className="text-gray-700">{rotuloCub.get(k) ?? k}</span>
                                            <span className="text-[9px] font-bold px-1 rounded" style={{ background: chip.bg, color: chip.color }}>{chip.texto}</span>
                                            {c.constancia_url && <EnlacePrivado href={c.constancia_url} target="_blank" rel="noopener noreferrer" className="text-[9px] text-blue-600 underline">constancia</EnlacePrivado>}
                                          </div>
                                        );
                                      })}
                                    </div>
                                    <div className="flex items-center gap-2 flex-wrap pt-1">
                                      <button onClick={() => editar(s.origenId)} className="text-[11px] font-bold px-2 py-1 rounded-lg border bg-white hover:bg-gray-50">Gestionar asegurados</button>
                                      <button disabled={solicitados.length === 0} onClick={() => copiarLista(s.origenId, solicitados)}
                                        className="text-[11px] font-bold px-2 py-1 rounded-lg border bg-white hover:bg-gray-50 disabled:opacity-40">📋 Copiar lista para el bróker ({solicitados.length})</button>
                                      {puedeVerSueldo && (
                                        <label className="flex items-center gap-1 text-[10px] text-gray-600">
                                          <input type="checkbox" className="w-3.5 h-3.5 accent-[#0b315f]" checked={conSueldo} onChange={(e) => setConSueldo(e.target.checked)} /> con remuneración
                                        </label>
                                      )}
                                    </div>
                                    {solicitados.length === 0 && <p className="text-[10px] text-gray-400">No hay inclusiones solicitadas en esta póliza.</p>}
                                    {!mostrarForm && <PanelCopia copia={copia} onCerrar={() => setCopia(null)} />}
                                  </div>
                                );
                              })() : <p className="text-gray-700">{s.asegurado.rotulo}</p>}
                            </div>
                            <div className="space-y-1.5">
                              <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Detalle</p>
                              <p className="text-gray-500 italic">{s.tipo === SCTR_SIN_PRECISAR ? "SCTR sin precisar" : cfg.descripcion}</p>
                              <p><span className="text-gray-400">Vencimiento:</span> <b>{fmtFecha(s.vencimiento)}</b>{s.dias !== null && ` (${s.dias < 0 ? `vencido hace ${Math.abs(s.dias)} días` : `${s.dias} días`})`}</p>
                              {s.fuente === "poliza" && s.cuota != null && <p><span className="text-gray-400">Cuota mensual:</span> {fmtSoles(s.cuota)}</p>}
                              {s.archivo
                                ? <EnlacePrivado href={s.archivo} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-blue-600 font-bold hover:underline">📄 Ver archivo</EnlacePrivado>
                                : <p className="text-gray-300">Sin archivo adjunto</p>}
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
        {filtrados.length > 0 && (
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between flex-wrap gap-2" style={{ borderColor: "#f1f5f9" }}>
            <span>{filtrados.length} de {filas.length} seguros</span>
            <span>Fuentes: {FUENTES_SEGURO.map((f) => `${FUENTE_LABEL[f].label} ${res?.fuentes[f] === "error" ? "?" : filas.filter((x) => x.fuente === f).length}`).join(" · ")}</span>
          </div>
        )}
      </section>
    </main>
  );
}
