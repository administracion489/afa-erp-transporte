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
  TIPOS_SEGURO, SCTR_SIN_PRECISAR, CODIGOS_FALTANTE, FUENTES_SEGURO, kpisSeguros, estadoDe,
  type FilaSeguro, type FuenteSeguro, type Faltante, type ClaveAsegurado,
} from "@/lib/seguros";
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

/** Columnas de `seguros` que trae una migración accesoria (seguros-01): se sueltan si el error las nombra. */
const COLS_ACCESORIAS = ["vehiculo_tercero_id", "alcance"] as const;

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

const FORM_VACIO = {
  tipo: "sctr_salud", aseguradora: "", numero_poliza: "", titular: "",
  vehiculo_id: "", proveedor_id: "", fecha_inicio: "",
  fecha_vencimiento: "", prima_total: "", cuota_mensual: "",
  archivo_url: "", observaciones: "",
};

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
  // Asegurados de la póliza en edición: clave → id de la fila de seguro_cobertura (null = de la póliza vieja).
  const [cubOriginal, setCubOriginal] = useState<Map<string, number | null>>(new Map());
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

  // ── CRUD de pólizas ───────────────────────────────────────────────────────

  const limpiar = () => {
    setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false);
    setArchivoNuevo(null); setArchivoUrlOriginal("");
    setCubOriginal(new Map()); setCubSel(new Set()); setVehiculoIdOriginal(null); setCobNoLeida(null);
    setBusCub({ conductor: "", personal: "", vehiculo: "", vehiculo_tercero: "" });
  };

  const nuevo = () => { limpiar(); setMostrarForm(true); setAvisoGuardado([]); };

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

    // Asegurados actuales.
    const orig = new Map<string, number | null>();
    const cob = await supabase.from("seguro_cobertura")
      .select("id,conductor_id,personal_administrativo_id,vehiculo_id,vehiculo_tercero_id").eq("seguro_id", id);
    if (cob.error) {
      // Sin poder leerlos no se ofrece el selector: guardar con la lista vacía los BORRARÍA.
      if (tablaFaltante(cob.error, "seguro_cobertura")) setCobSinTabla(true);
      else setCobNoLeida(cob.error.message);
    } else {
      for (const r of cob.data ?? []) {
        const clase: ClaseCubierto | null = r.conductor_id != null ? "conductor" : r.personal_administrativo_id != null ? "personal"
          : r.vehiculo_id != null ? "vehiculo" : r.vehiculo_tercero_id != null ? "vehiculo_tercero" : null;
        if (!clase) continue;
        orig.set(claveCub(clase, r[COLUMNA_COBERTURA[clase]]), Number(r.id));
      }
      // Póliza vieja sin filas de cobertura: su vehículo es el asegurado.
      if (orig.size === 0 && s.vehiculo_id != null) orig.set(claveCub("vehiculo", s.vehiculo_id), null);
      if (orig.size === 0 && s.vehiculo_tercero_id != null) orig.set(claveCub("vehiculo_tercero", s.vehiculo_tercero_id), null);
    }
    setCubOriginal(orig);
    setCubSel(new Set(orig.keys()));
    setEditandoId(id); setMostrarForm(true); setCargandoPoliza(false);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const esDocumentoVehicular = TIPOS_DE_DOCUMENTO.includes(form.tipo);
  const bloqueoGuardar: string | null =
    !editandoId && esDocumentoVehicular ? "El SOAT/CAT es de cada placa: se registra en Documentos vehiculares, no como póliza colectiva."
    : !form.aseguradora ? "Falta elegir la aseguradora."
    : !form.fecha_vencimiento ? "Falta la fecha de vencimiento."
    : null;

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
    const payload: Record<string, unknown> = {
      tipo:              form.tipo,
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
        avisos.push(`La columna «${acc}» de seguros no existe todavía: se guardó sin ella (corre supabase/seguros-01-base.sql en Supabase → SQL Editor).`);
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

    // 3. Asegurados: borrar e insertar SOLO las diferencias, comprobando cada error.
    if (selectorDisponible) {
      const quitar = [...cubOriginal.entries()].filter(([k]) => !cubSel.has(k));
      const idsQuitar = quitar.map(([, id]) => id).filter((x): x is number => x != null);
      const agregar = [...cubSel].filter((k) => !cubOriginal.has(k) || cubOriginal.get(k) == null);
      let cobOk = true;
      if (idsQuitar.length) {
        const d = await supabase.from("seguro_cobertura").delete().in("id", idsQuitar);
        if (d.error) { cobOk = false; avisos.push(`No se pudieron quitar ${idsQuitar.length} asegurado(s): ${d.error.message}`); }
      }
      if (agregar.length) {
        const filas = agregar.map((k) => {
          const [clase, id] = k.split(":") as [ClaseCubierto, string];
          return { seguro_id: seguroId, [COLUMNA_COBERTURA[clase]]: Number(id) };
        });
        const ins = await supabase.from("seguro_cobertura").insert(filas);
        if (ins.error) {
          cobOk = false;
          avisos.push(tablaFaltante(ins.error, "seguro_cobertura")
            ? "La póliza se guardó, pero sus asegurados no: falta la tabla seguro_cobertura (corre supabase/seguros-02-cobertura.sql en Supabase → SQL Editor)."
            : `La póliza se guardó, pero no se pudieron agregar ${agregar.length} asegurado(s): ${ins.error.message}`);
          if (tablaFaltante(ins.error, "seguro_cobertura")) setCobSinTabla(true);
        }
      }
      // La póliza vieja que usaba vehiculo_id: sus asegurados viven ahora en seguro_cobertura.
      if (cobOk && vehiculoIdOriginal != null) {
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
  const faltVisibles = verTodosFalt ? faltantes : faltantes.slice(0, 12);

  const nCubiertos = (clase: ClaseCubierto) => [...cubSel].filter((c) => c.startsWith(clase + ":")).length;
  const candidatosDe = (clase: ClaseCubierto) => {
    const q = sinTildes(busCub[clase].trim());
    return candidatos.filter((c) => c.clase === clase && (!q || sinTildes(c.rotulo).includes(q)))
      .sort((a, b) => Number(b.activo) - Number(a.activo) || a.rotulo.localeCompare(b.rotulo));
  };
  const alternar = (clave: string) => setCubSel((s) => { const n = new Set(s); if (n.has(clave)) n.delete(clave); else n.add(clave); return n; });
  const marcarTodos = (clase: ClaseCubierto, marcar: boolean) => setCubSel((s) => {
    const n = new Set(s);
    for (const c of candidatosDe(clase)) { if (marcar) n.add(c.clave); else n.delete(c.clave); }
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
          {faltantes.length > 12 && (
            <button onClick={() => setVerTodosFalt((v) => !v)} className="text-xs font-bold text-[#0b315f] underline">
              {verTodosFalt ? "Ver menos" : `Ver los ${faltantes.length}`}
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
                      <button key={kk} type="button" onClick={() => setForm((p) => ({ ...p, tipo: kk }))}
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
              Asegurados de la póliza {selectorDisponible && <span className="text-[#0b315f]">· {cubSel.size} marcado(s)</span>}
            </p>
            {cobNoLeida || res?.coberturas === "error" ? (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800">
                No se pudieron leer los asegurados{cobNoLeida ? `: ${cobNoLeida}` : ""}. El selector se oculta para no borrarlos por error al guardar; recarga para reintentar.
              </div>
            ) : !selectorDisponible ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
                ⚠️ No se puede elegir a quién cubre la póliza: falta la tabla <b>seguro_cobertura</b>. Corre <b>supabase/seguros-02-cobertura.sql</b> en Supabase → SQL Editor.
                Mientras tanto la póliza se guarda sin asegurados y las personas siguen leyéndose de su ficha.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {GRUPOS_CUBIERTOS.map((g) => {
                  const lista = candidatosDe(g.clase);
                  const todosMarcados = lista.length > 0 && lista.every((c) => cubSel.has(c.clave));
                  return (
                    <div key={g.clase} className="border rounded-xl p-3">
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <p className="text-xs font-bold text-gray-700">{g.icon} {g.titulo} <span className="text-gray-400">· {nCubiertos(g.clase)}</span></p>
                        <button type="button" disabled={lista.length === 0} onClick={() => marcarTodos(g.clase, !todosMarcados)}
                          className="text-[11px] font-bold text-[#0b315f] underline disabled:opacity-40">
                          {todosMarcados ? "Desmarcar" : "Marcar"} {busCub[g.clase] ? "los filtrados" : "todos"}
                        </button>
                      </div>
                      <input className={inputCls("py-1.5 mb-2")} placeholder="Buscar…" value={busCub[g.clase]}
                        onChange={(e) => setBusCub((b) => ({ ...b, [g.clase]: e.target.value }))} />
                      <div className="max-h-44 overflow-y-auto space-y-0.5">
                        {lista.length === 0 && <p className="text-[11px] text-gray-400 px-1">{candidatos.length === 0 ? "Comprobando…" : "Nadie coincide."}</p>}
                        {lista.map((c) => (
                          <label key={c.clave} className="flex items-center gap-2 px-1 py-1 rounded hover:bg-gray-50 cursor-pointer text-xs">
                            <input type="checkbox" className="w-4 h-4 accent-[#0b315f]" checked={cubSel.has(c.clave)} onChange={() => alternar(c.clave)} />
                            <span className={c.activo ? "text-gray-800" : "text-gray-400"}>{c.rotulo}{!c.activo && " (inactivo)"}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
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
                              {s.fuente === "poliza" ? (
                                cubre.length === 0 ? <p className="text-gray-400">{res?.coberturas === "sin_tabla" ? "Sin asegurados: falta supabase/seguros-02-cobertura.sql." : "Ningún asegurado vigente registrado."}</p>
                                  : <p className="text-gray-700">{cubre.slice(0, 30).map((c) => rotuloCub.get(claveCub(c.clase, c.id)) ?? `${c.clase} #${c.id}`).join(" · ")}{cubre.length > 30 ? ` · y ${cubre.length - 30} más` : ""}</p>
                              ) : <p className="text-gray-700">{s.asegurado.rotulo}</p>}
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
