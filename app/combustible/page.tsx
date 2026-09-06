"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { registrarLectura } from "@/lib/odometro";
import { sincronizarPrecioDesdeCarga } from "@/lib/precios-combustible";
import {
  esImagenLeida,
  fotosPorCarga,
  type FilaConFotos,
  type FotoLeida,
  type MediaDeMensaje,
} from "@/lib/radar/fotos-lectura";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Vehiculo  = { id: number; placa: string; categoria?: string; kilometraje_actual?: number; capacidad_tanque?: Record<string, number> | null; };
type Conductor = { id: number; nombre: string; };
// Unidad unificada (flota propia + tercerizada) con clave sintética `uid` — los ids de
// `vehiculos` y `vehiculos_tercero` se solapan, así que se distinguen por prefijo p/t.
type Unidad = Vehiculo & { uid: string; tipo: "propio" | "tercero" };

type Combustible = {
  id: number; vehiculo_id: number | null; vehiculo_tercero_id: number | null;
  fecha: string; kilometraje: number;
  galones: number; precio_galon: number; total: number;
  grifo: string | null; conductor: string | null;
  observaciones: string | null; created_at: string;
  tipo_combustible: string | null;
  unidad: string | null;
};

// Lo que el Radar IA guarda de la carga que él mismo registró. `combustible` no guarda NADA
// del Radar (ni el id de la lectura, ni la foto, ni el nº de nota), así que el puente es
// `radar_combustible.combustible_id` y se lee al revés: del Radar hacia la carga.
type LecturaRadar = FilaConFotos & { combustible_id: number | null; comprobante?: string | null };

type VistaActiva = "historial" | "analisis" | "por_vehiculo" | "por_conductor" | "por_grifo" | "por_tipo";
type GranPeriodo = "dia" | "semana" | "mes";

import { COMBUSTIBLES, familiaCombustible } from "@/lib/combustible-tipos";
import { paginarFilas } from "@/lib/huella";
import {
  seriesRendimiento, tramosPorCarga, juzgarTramo, etiquetaMotivo,
  type CargaRendimiento, type Tramo, type ResumenUnidad,
} from "@/lib/rendimiento";

// ─── CONFIGURACIÓN DE COMBUSTIBLES ───────────────────────────────────────────
// El catálogo vive en lib/combustible-tipos.ts: /radar-ia lo necesita para su columna de
// tipo, y dos copias con etiquetas o colores distintos serían el mismo combustible con dos
// caras. Ahí están además los grados de gasolina (regular/premium) y `familia`, que es con
// lo que se compara tanque, precio referencial y rendimiento.

const CAPACIDAD_TANQUE: Record<string, Record<string, number>> = {
  BUS:     { diesel: 100, gnv: 150, glp: 80,  gasolina: 80,  urea: 30 },
  MINIBUS: { diesel: 60,  gnv: 80,  glp: 50,  gasolina: 50,  urea: 15 },
  VAN:     { diesel: 20,  gnv: 40,  glp: 25,  gasolina: 20,  urea: 10 },
  AUTO:    { diesel: 12,  gnv: 30,  glp: 15,  gasolina: 12,  urea: 5  },
  DEFAULT: { diesel: 80,  gnv: 100, glp: 60,  gasolina: 60,  urea: 20 },
};

function getCapacidad(
  vehOCat: string | { categoria?: string | null; capacidad_tanque?: Record<string, number> | null } | null | undefined,
  tipo: string
): number {
  // La capacidad EDITABLE por vehículo (vehiculos.capacidad_tanque) tiene prioridad sobre la heurística.
  if (vehOCat && typeof vehOCat === "object") {
    const edit = vehOCat.capacidad_tanque?.[tipo];
    if (edit != null && Number(edit) > 0) return Number(edit);
  }
  const categoria = typeof vehOCat === "string" ? vehOCat : vehOCat?.categoria ?? undefined;
  if (!categoria) return CAPACIDAD_TANQUE.DEFAULT[tipo] || 80;
  const cat = categoria.toUpperCase();
  for (const [k, v] of Object.entries(CAPACIDAD_TANQUE)) {
    if (cat.includes(k)) return v[tipo] || v.diesel || 80;
  }
  return CAPACIDAD_TANQUE.DEFAULT[tipo] || 80;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtSoles(n: number) {
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtNum(n: number, dec = 2) {
  return n.toLocaleString("es-PE", { minimumFractionDigits: dec, maximumFractionDigits: dec });
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

/**
 * La(s) foto(s) que el Radar IA leyó para esta carga, al lado de los números que sacó de ellas.
 *
 * Sin esto, corregir una carga que registró el Radar era teclear de memoria: el galonaje, el
 * precio y el monto salieron de un papel que estaba en WhatsApp y que esta pantalla no
 * mostraba por ningún lado. Es la misma tira del panel de revisión de /radar-ia, con la
 * diferencia de que aquí la carga YA está en el libro y lo que se hace es enmendarla.
 *
 * Se abre en pestaña nueva a tamaño real: la miniatura sirve para reconocer el papel, no para
 * leer un dígito de matriz de puntos —que es justo el error que trae aquí a la gente.
 */
function FotosDelRadar({ fotos, nota, alto = "h-40" }: { fotos: FotoLeida[]; nota?: string | null; alto?: string }) {
  if (!fotos.length) return null;
  return (
    <div className="rounded-2xl border border-[#bfdbfe] bg-[#eff6ff] px-4 py-3">
      <p className="text-[10px] font-black uppercase tracking-widest text-[#1d4ed8] mb-2">
        📷 {fotos.length === 1 ? "Foto que leyó el Radar IA" : `${fotos.length} fotos que leyó el Radar IA`}
        {nota && <span className="ml-2 font-mono lowercase tracking-normal text-[#1e40af]">· nota {nota}</span>}
      </p>
      <div className="flex flex-wrap gap-2">
        {fotos.map((f, i) => esImagenLeida(f) ? (
          <a key={i} href={f.url} target="_blank" rel="noreferrer" title={f.nombre ?? "Abrir en tamaño real"} className="block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={f.url} alt={f.nombre ?? `Foto ${i + 1}`}
              className={`${alto} w-auto max-w-[240px] object-contain rounded-xl border border-blue-200 bg-white hover:ring-2 hover:ring-[#1d4ed8] transition`} />
          </a>
        ) : (
          // El bucket del Radar guarda también PDFs y audios: un adjunto que no es imagen se
          // ofrece como enlace y no como un <img> roto, que se lee igual que "no hay foto".
          <a key={i} href={f.url} target="_blank" rel="noreferrer"
            className={`${alto} w-[150px] flex flex-col items-center justify-center gap-1 rounded-xl border border-blue-200 bg-white text-center px-2 hover:ring-2 hover:ring-[#1d4ed8] transition`}>
            <span className="text-2xl">📄</span>
            <span className="text-[10px] font-bold text-[#1e40af] truncate max-w-full">{f.nombre ?? "Abrir adjunto"}</span>
          </a>
        ))}
      </div>
      <p className="text-[10px] text-[#1e40af]/70 mt-2">Ábrela en tamaño real y compara los números con lo que está guardado antes de corregir.</p>
    </div>
  );
}

/**
 * Las lecturas del Radar IA que YA se convirtieron en una carga de este libro.
 *
 * `fotos` llegó con una migración accesoria (supabase/radar-ia-combustible-revision.sql): si no
 * se corrió, la consulta falla nombrando la columna y se reintenta sin ella — igual que hacen
 * `guardarReservas` y el modal de adicionales. Ver una foto es un extra; que /combustible deje
 * de listar cargas porque falta un SQL accesorio, no.
 */
async function cargarLecturasRadar(): Promise<LecturaRadar[]> {
  const pedir = (cols: string) =>
    supabase.from("radar_combustible").select(cols).not("combustible_id", "is", null);
  let res = await pedir("combustible_id, mensaje_id, comprobante, fotos");
  if (res.error && /fotos/i.test(res.error.message || "")) res = await pedir("combustible_id, mensaje_id, comprobante");
  if (res.error || !res.data) return [];
  return res.data as unknown as LecturaRadar[];
}

/**
 * El rendimiento vive en lib/rendimiento.ts, no aquí.
 *
 * La versión que estaba en este archivo dividía el delta de odómetro entre los galones de
 * una sola carga SIN NINGÚN TECHO, y el color solo miraba hacia abajo. Con la CWZ-371 eso
 * publicó 162.9 km/gal en verde —1 592 km de un hueco de registro entre dos cargas—, y esa
 * fila subió la media de 28.6 a 43.5, dejando SIETE de nueve filas sanas marcadas 🚨.
 * Ver la cabecera de lib/rendimiento.ts.
 */
const cargaParaRendimiento = (r: Combustible, unidad: string): CargaRendimiento => ({
  id: r.id,
  unidad,
  fecha: String(r.fecha ?? "").slice(0, 10),
  kilometraje: r.kilometraje,
  cantidad: r.galones,
  unidadCantidad: r.unidad,
  tipo: r.tipo_combustible,
});

// Clave + etiqueta del período (día/semana/mes) para el análisis de gasto y rendimiento.
function clavePeriodo(fecha: string, gran: GranPeriodo): { key: string; label: string } {
  const d = new Date(fecha + "T00:00:00");
  if (gran === "mes") {
    return { key: fecha.slice(0, 7), label: d.toLocaleDateString("es-PE", { month: "long", year: "numeric" }) };
  }
  if (gran === "semana") {
    const diaLun = (d.getDay() + 6) % 7;            // 0 = lunes
    const lunes = new Date(d);
    lunes.setDate(d.getDate() - diaLun);
    const key = lunes.toISOString().slice(0, 10);
    return { key, label: `Semana del ${lunes.toLocaleDateString("es-PE", { day: "2-digit", month: "short" })}` };
  }
  return { key: fecha, label: d.toLocaleDateString("es-PE", { weekday: "short", day: "2-digit", month: "short" }) };
}

const FORM_VACIO = {
  vehiculo_id: "", fecha: new Date().toISOString().split("T")[0],
  kilometraje: "", galones: "", precio_galon: "",
  tipo_combustible: "diesel", unidad: "galones",
  grifo: "", conductor: "", observaciones: "",
};

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function CombustiblePage() {
  const [vehiculos,   setVehiculos]   = useState<Vehiculo[]>([]);
  const [vehiculosTercero, setVehiculosTercero] = useState<Vehiculo[]>([]);
  const [conductores, setConductores] = useState<Conductor[]>([]);
  const [registros,   setRegistros]   = useState<Combustible[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [guardando,   setGuardando]   = useState(false);
  const [editandoId,  setEditandoId]  = useState<number | null>(null);
  const [mostrarForm, setMostrarForm] = useState(false);
  const [expandidoId, setExpandidoId] = useState<number | null>(null);
  const [vista,       setVista]       = useState<VistaActiva>("historial");
  const [granularidad,setGranularidad]= useState<GranPeriodo>("mes");
  const [busqueda,    setBusqueda]    = useState("");
  const [filtroVeh,   setFiltroVeh]   = useState("todos");
  const [filtroFlota, setFiltroFlota] = useState<"todos" | "propio" | "tercero">("todos");
  const [filtroTipo,  setFiltroTipo]  = useState("todos");
  const [filtroMes,   setFiltroMes]   = useState("todos");
  const [form, setForm] = useState(FORM_VACIO);
  // Lo que leyó el Radar IA de las cargas que él registró, para poder corregirlas mirando el
  // papel. `mediaMensajes` es el respaldo de las filas viejas (sin `fotos`) y se pide de a una
  // al abrir la carga: son ids de mensajes, y pedirlos todos de golpe sería una URL kilométrica.
  const [lecturasRadar, setLecturasRadar] = useState<LecturaRadar[]>([]);
  const [mediaMensajes, setMediaMensajes] = useState<Record<string, MediaDeMensaje>>({});

  const fuelCfg = COMBUSTIBLES[form.tipo_combustible] || COMBUSTIBLES.diesel;
  const totalPreview = Number(form.galones || 0) * Number(form.precio_galon || 0);

  // Al cambiar tipo de combustible, actualizar unidad automáticamente
  const cambiarTipo = (tipo: string) => {
    const cfg = COMBUSTIBLES[tipo] || COMBUSTIBLES.diesel;
    setForm(p => ({ ...p, tipo_combustible: tipo, unidad: cfg.unidad, precio_galon: String(cfg.precioRef) }));
  };

  const cargarDatos = async () => {
    setLoading(true);
    const [vRes, vtRes, cRes, condRes, radRes] = await Promise.all([
      supabase.from("vehiculos").select("*").order("placa"),
      supabase.from("vehiculos_tercero").select("*").order("placa"),
      // Paginado, no `select("*")` a secas: PostgREST corta en 1000 filas sin avisar, y una
      // serie a la que le falte la cabeza pierde sus tramos más viejos EN SILENCIO — que es
      // justo lo que el módulo de rendimiento no puede permitirse. La misma trampa que ya
      // documentó lib/huella.ts y que truncó /programacion.
      paginarFilas(() =>
        supabase.from("combustible").select("*").order("fecha", { ascending: false }).order("id", { ascending: false })
      ).then(data => ({ data })),
      supabase.from("conductores").select("id,nombre").order("nombre"),
      cargarLecturasRadar(),
    ]);
    setVehiculos(vRes.data || []);
    setVehiculosTercero(vtRes.data || []);
    setRegistros(cRes.data || []);
    setConductores(condRes.data || []);
    setLecturasRadar(radRes);
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  // ── Unidades unificadas (flota propia + tercerizada) ───────────────────────
  const unidades = useMemo<Unidad[]>(() => [
    ...vehiculos.map(v => ({ ...v, uid: `p${v.id}`, tipo: "propio" as const })),
    ...vehiculosTercero.map(v => ({ ...v, uid: `t${v.id}`, tipo: "tercero" as const })),
  ], [vehiculos, vehiculosTercero]);
  // Clave sintética de la unidad de un registro (según a qué flota apunta).
  const uidReg = (r: Combustible) =>
    r.vehiculo_tercero_id != null ? `t${r.vehiculo_tercero_id}` : r.vehiculo_id != null ? `p${r.vehiculo_id}` : "";
  const unidadDe = (uid: string) => unidades.find(u => u.uid === uid);
  const placaReg = (r: Combustible) => unidadDe(uidReg(r))?.placa || "—";

  // ── Rendimiento ────────────────────────────────────────────────────────────
  //
  // Una sola llamada al módulo compartido reemplaza los dos useMemo que había aquí
  // (`rendimientoPromedio` con su media sin techo, y `prevRegistro` con su cadena ordenada
  // por kilometraje). El promedio es ahora MEDIANA, los tramos absurdos se descartan
  // declarando por qué, y las series van por FAMILIA de combustible: `gasolina_regular` y
  // `gasolina_premium` son el mismo tanque y eran dos cadenas separadas.
  //
  // Se calcula sobre `registros` (todo), NO sobre `filtrados`: el km entre dos cargas es un
  // hecho del vehículo y no cambia porque la pantalla esté filtrando un mes.
  const seriesRend = useMemo(
    () => seriesRendimiento(registros.map(r => cargaParaRendimiento(r, uidReg(r)))),
    [registros]
  );
  const rendDeCarga = useMemo(() => tramosPorCarga(seriesRend), [seriesRend]);

  // ── Lo que leyó el Radar IA ────────────────────────────────────────────────

  // Índice carga → fotos. La cascada (fila del Radar, y si no la media del mensaje) vive en
  // lib/radar/fotos-lectura.ts, compartida con el panel de revisión de /radar-ia.
  const fotosDeCarga = useMemo(() => fotosPorCarga(lecturasRadar, mediaMensajes), [lecturasRadar, mediaMensajes]);
  // El nº de nota de despacho: con dos fotos (nota y tablero) es lo que dice CUÁL papel es este.
  const notaDeCarga = useMemo(() => {
    const mapa: Record<number, string> = {};
    for (const l of lecturasRadar) {
      const id = Number(l.combustible_id);
      if (Number.isFinite(id) && l.comprobante && !mapa[id]) mapa[id] = l.comprobante;
    }
    return mapa;
  }, [lecturasRadar]);
  const lecturaDeCarga = (id: number) => lecturasRadar.find(l => Number(l.combustible_id) === id) || null;
  // Qué cargas nacieron de una foto. Se marca la CARGA, no la foto: en una fila vieja la foto
  // se pide recién al abrirla, y de todos modos lo que dice el marcador es de dónde salió el dato.
  const cargasDelRadar = useMemo(
    () => new Set(lecturasRadar.map(l => Number(l.combustible_id)).filter(Number.isFinite)),
    [lecturasRadar]);

  // Filas viejas (anteriores a la columna `fotos`): su única evidencia es la media del mensaje
  // de WhatsApp. Se pide al ABRIR la carga —una consulta de una fila— en vez de traer todos los
  // mensajes al cargar la pantalla.
  const asegurarMedia = async (mensajeId: string | null | undefined) => {
    if (!mensajeId || mediaMensajes[mensajeId] !== undefined) return;
    const { data } = await supabase
      .from("radar_mensajes").select("media_url, media_mime, media_nombre").eq("id", mensajeId).maybeSingle();
    // Se guarda incluso el vacío: marca la consulta como hecha y no se vuelve a pedir.
    setMediaMensajes(prev => ({ ...prev, [mensajeId]: (data as MediaDeMensaje) ?? {} }));
  };
  const verLoQueLeyoElRadar = (cargaId: number) => {
    const l = lecturaDeCarga(cargaId);
    if (l && !(l.fotos ?? []).length) asegurarMedia(l.mensaje_id);
  };
  // Los cuatro estados posibles, para no afirmar "no hay foto" mientras todavía se está
  // pidiendo: en una fila vieja la media se consulta al abrir la carga.
  const estadoFotoRadar = (cargaId: number): "sin_radar" | "cargando" | "sin_foto" | "hay" => {
    if ((fotosDeCarga[cargaId] ?? []).length) return "hay";
    const l = lecturaDeCarga(cargaId);
    if (!l) return "sin_radar";
    if (l.mensaje_id && mediaMensajes[l.mensaje_id] === undefined) return "cargando";
    return "sin_foto";
  };

  // ── CRUD ──────────────────────────────────────────────────────────────────

  const limpiar = () => { setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); };

  const guardar = async () => {
    if (!form.vehiculo_id || !form.fecha) { alert("Selecciona vehículo y fecha"); return; }
    if (!form.galones || !form.precio_galon) { alert("Ingresa cantidad y precio"); return; }

    // Unidad seleccionada (flota propia o tercerizada, según el prefijo del uid).
    const uSel = unidadDe(form.vehiculo_id);
    if (!uSel) { alert("Selecciona una unidad válida"); return; }
    const esTercero = uSel.tipo === "tercero";

    // Alerta capacidad
    const cap = getCapacidad(uSel, form.tipo_combustible);
    if (Number(form.galones) > cap * 1.1) {
      const ok = confirm(`⚠️ ALERTA: La cantidad (${form.galones} ${fuelCfg.unidadLabel}) supera la capacidad estimada del tanque de ${form.tipo_combustible} (${cap} ${fuelCfg.unidadLabel}).\n¿Continuar?`);
      if (!ok) return;
    }

    setGuardando(true);
    const payload = {
      vehiculo_id:         esTercero ? null : uSel.id,
      vehiculo_tercero_id: esTercero ? uSel.id : null,
      fecha:            form.fecha,
      kilometraje:      Number(form.kilometraje || 0),
      galones:          Number(form.galones),
      precio_galon:     Number(form.precio_galon),
      grifo:            form.grifo.trim()         || null,
      conductor:        form.conductor.trim()     || null,
      observaciones:    form.observaciones.trim() || null,
      tipo_combustible: form.tipo_combustible,
      unidad:           form.unidad,
    };

    const { error } = editandoId
      ? await supabase.from("combustible").update(payload).eq("id", editandoId)
      : await supabase.from("combustible").insert(payload);

    if (error) { alert(error.message); setGuardando(false); return; }

    // La carga real es la fuente de precio más actual → actualiza el precio vigente
    // que usa /configuracion/costos (Cotizador). No bloquea el guardado si falla.
    const { data: authData } = await supabase.auth.getUser();
    await sincronizarPrecioDesdeCarga(supabase, {
      tipoCombustible: form.tipo_combustible,
      precio:          Number(form.precio_galon),
      fecha:           form.fecha,
      actualizadoPor:  authData?.user?.email || undefined,
    });

    if (form.kilometraje) {
      if (editandoId) {
        // Edición: ajustar el vigente sin duplicar lectura en el historial
        if (Number(form.kilometraje) > Number(uSel.kilometraje_actual || 0)) {
          await supabase.from(esTercero ? "vehiculos_tercero" : "vehiculos")
            .update({ kilometraje_actual: Number(form.kilometraje) }).eq("id", uSel.id);
        }
      } else {
        // Registro nuevo: pasa por la consolidación de odómetro (anti-retroceso)
        await registrarLectura(supabase, {
          vehiculo_id: uSel.id,
          flota: esTercero ? "tercero" : "propia",
          km: Number(form.kilometraje),
          fuente: "combustible",
          fecha: form.fecha,
          ref_origen: "combustible",
        });
      }
    }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const editar = (r: Combustible) => {
    setForm({
      vehiculo_id:      uidReg(r),
      fecha:            r.fecha        || "",
      kilometraje:      r.kilometraje  ? String(r.kilometraje)  : "",
      galones:          r.galones      ? String(r.galones)      : "",
      precio_galon:     r.precio_galon ? String(r.precio_galon) : "",
      tipo_combustible: r.tipo_combustible || "diesel",
      unidad:           r.unidad           || "galones",
      grifo:            r.grifo        || "",
      conductor:        r.conductor    || "",
      observaciones:    r.observaciones|| "",
    });
    setEditandoId(r.id); setMostrarForm(true);
    verLoQueLeyoElRadar(r.id);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const eliminar = async (id: number) => {
    if (!confirm("¿Eliminar este registro?")) return;
    await supabase.from("combustible").delete().eq("id", id);
    cargarDatos();
  };

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const totalGastado = registros.reduce((s, r) => s + Number(r.total || 0), 0);
  const hoyMes  = new Date().getMonth();
  const hoyAnio = new Date().getFullYear();
  const resMes  = registros.filter(r => { const d = new Date(r.fecha + "T00:00:00"); return d.getMonth() === hoyMes && d.getFullYear() === hoyAnio; });
  const gastoMes= resMes.reduce((s, r) => s + Number(r.total || 0), 0);

  // KPIs por tipo de combustible
  const kpisPorTipo = Object.entries(COMBUSTIBLES).map(([tipo, cfg]) => {
    const regs = registros.filter(r => (r.tipo_combustible || "diesel") === tipo);
    return { tipo, cfg, cantidad: regs.reduce((s, r) => s + Number(r.galones || 0), 0), costo: regs.reduce((s, r) => s + Number(r.total || 0), 0), cargas: regs.length };
  }).filter(d => d.cargas > 0);

  // Anomalías. El hallazgo de rendimiento lo decide `juzgarTramo`, que ahora mira las DOS
  // cotas: un rendimiento imposiblemente ALTO es una carga que falta por registrar, y antes
  // se pintaba verde con ✓.
  const totalAnomalias = registros.filter(r => {
    const tipo = r.tipo_combustible || "diesel";
    const cap  = getCapacidad(unidadDe(uidReg(r)), tipo);
    if (Number(r.galones) > cap * 1.1) return true;
    const e = rendDeCarga[r.id];
    return !!(e && juzgarTramo(e.tramo, e.resumen));
  }).length;

  // Meses únicos
  const mesesUnicos = [...new Set(registros.map(r => r.fecha?.slice(0, 7)).filter(Boolean))].sort().reverse();

  // ── Filtrado ──────────────────────────────────────────────────────────────

  const filtrados = useMemo(() => registros.filter(r => {
    const u  = unidadDe(uidReg(r));
    const q  = busqueda.toLowerCase();
    const txt= `${u?.placa || ""} ${r.grifo || ""} ${r.conductor || ""} ${r.tipo_combustible || ""}`.toLowerCase();
    return txt.includes(q) &&
      (filtroFlota === "todos" || (u?.tipo ?? "propio") === filtroFlota) &&
      (filtroVeh  === "todos" || uidReg(r) === filtroVeh) &&
      (filtroTipo === "todos" || (r.tipo_combustible || "diesel") === filtroTipo) &&
      (filtroMes  === "todos" || r.fecha?.slice(0, 7) === filtroMes);
  }), [registros, busqueda, filtroFlota, filtroVeh, filtroTipo, filtroMes, unidades]);

  // ── Datos por vehículo (ambas flotas) ──────────────────────────────────────
  //
  // EL CPK. Antes era `costo del período ÷ vehiculos.kilometraje_actual`, es decir el gasto
  // de unas semanas dividido entre el odómetro de TODA LA VIDA del vehículo: un número que
  // no significa nada y que además se pintaba de verde por ser pequeño.
  //
  // Ahora es Σ soles de las cargas que cierran tramos MEDIDOS ÷ Σ km de esos tramos —
  // numerador y denominador de las mismas filas, sin una sola consulta nueva. Se publica con
  // su cobertura, y sin ningún tramo medido sale "—" en vez de un número sin sentido.
  //
  // El CPK contra el odómetro real (lecturas_odometro) NO se calcula aquí: esta pantalla no
  // tiene período —el filtro de mes admite "todos"— así que el denominador honesto sería la
  // historia entera de la flota, miles de filas para una columna. Ese número ya existe, es la
  // definición única del ERP y vive en /mantenimiento → Analítica de vehículo
  // (`indicadoresEconomicos.costoPorKm`, que sí usa el odómetro).
  const datosVehiculo = unidades.map(v => {
    const regs = registros.filter(r => uidReg(r) === v.uid);
    const costo = regs.reduce((s, r) => s + Number(r.total || 0), 0);
    const tipos = [...new Set(regs.map(r => r.tipo_combustible || "diesel"))];

    let kmMedido = 0, solesMedidos = 0;
    for (const r of regs) {
      const t = rendDeCarga[r.id]?.tramo;
      if (t && t.rendimiento !== null && t.km != null) {
        kmMedido += t.km;
        solesMedidos += Number(r.total || 0);
      }
    }
    // Una serie por familia: una unidad bimodal (diésel + GLP) tiene dos rendimientos y
    // promediarlos daría un número que no es de ninguno de los dos.
    const series = [...seriesRend.values()].filter(s => s.resumen.unidad === v.uid && s.resumen.n > 0);

    return {
      vehiculo: v, regs: regs.length, costo, tipos, series,
      cpk: kmMedido > 0 && solesMedidos > 0 ? solesMedidos / kmMedido : null,
      kmMedido,
      coberturaCargas: regs.filter(r => rendDeCarga[r.id]?.tramo.rendimiento !== null).length,
      sinOdometro: regs.filter(r => !Number(r.kilometraje)).length,
    };
  }).filter(d => d.regs > 0).sort((a, b) => b.costo - a.costo);

  // ── Datos por conductor ────────────────────────────────────────────────────
  //
  // Dos trampas, y las dos hay que declararlas o la columna miente:
  //
  // 1. UN TRAMO TIENE DOS CARGAS y puede tener dos conductores. Se atribuye al de la carga
  //    que CIERRA —los km medidos son los que recorrió antes de llenar— y solo si los dos
  //    extremos traen el mismo nombre. Con dos nombres distintos no se adivina: se cuenta
  //    aparte. Es la misma disciplina que `hermano_ambiguo` en liquidaciones, y aquí importa
  //    más porque el número señala a una persona.
  // 2. COMPARAR CONDUCTOR CONTRA CONDUCTOR NO SIGNIFICA NADA: quien maneja la van siempre le
  //    gana a quien maneja el bus. Lo que se compara es el Δ % contra la mediana de LA UNIDAD
  //    QUE MANEJÓ. Ésa es la columna principal; el km/gal crudo va al lado, de referencia.
  const conductoresUsados = [...new Set(registros.map(r => r.conductor?.trim()).filter(Boolean))] as string[];
  const datosConductor = conductoresUsados.map(cond => {
    const regs = registros.filter(r => r.conductor?.trim() === cond);
    const desvios: number[] = [];
    const rends: number[] = [];
    let ambiguos = 0;

    for (const r of regs) {
      const ent = rendDeCarga[r.id];
      if (!ent || ent.tramo.rendimiento === null || !ent.resumen.mediana) continue;
      const previa = ent.tramo.previaId != null ? registros.find(x => x.id === ent.tramo.previaId) : null;
      if (previa && previa.conductor?.trim() !== cond) { ambiguos++; continue; }
      rends.push(ent.tramo.rendimiento);
      desvios.push((ent.tramo.rendimiento - ent.resumen.mediana) / ent.resumen.mediana);
    }

    return {
      conductor: cond,
      cargas: regs.length,
      costo: regs.reduce((s, r) => s + Number(r.total || 0), 0),
      tramos: desvios.length,
      ambiguos,
      desvio: desvios.length ? desvios.reduce((a, b) => a + b, 0) / desvios.length : null,
      rendMedio: rends.length ? rends.reduce((a, b) => a + b, 0) / rends.length : null,
    };
  }).sort((a, b) => b.costo - a.costo);

  // Datos por grifo
  const grifosUsados = [...new Set(registros.map(r => r.grifo).filter(Boolean))] as string[];
  const datosGrifo = grifosUsados.map(g => {
    const regs = registros.filter(r => r.grifo === g);
    const precProm = regs.reduce((s, r) => s + Number(r.precio_galon || 0), 0) / regs.length;
    return { grifo: g, cargas: regs.length, costo: regs.reduce((s, r) => s + Number(r.total || 0), 0), precProm };
  }).sort((a, b) => b.costo - a.costo);

  // ── Análisis por período (gasto + rendimiento km/gal por día/semana/mes) ──────
  // Respeta los filtros de arriba (vehículo/tipo/mes/búsqueda). El km recorrido de cada
  // carga sale del tramo entre esa carga y la anterior de la MISMA unidad+tipo (prevRegistro);
  // el rendimiento del período = Σ km / Σ galones (exacto si filtras una unidad+tipo, aproximado
  // si es la flota combinada). Los aditivos (urea) no cuentan para galones ni km.
  const rendLabelAnalisis = filtroTipo !== "todos" ? (COMBUSTIBLES[filtroTipo]?.rendimientoLabel || "km/gal") : "km/gal";
  const analisisPeriodos = useMemo(() => {
    const buckets: Record<string, { key: string; label: string; gasto: number; galones: number; km: number; cargas: number }> = {};
    for (const r of filtrados) {
      const tipo = r.tipo_combustible || "diesel";
      const { key, label } = clavePeriodo(r.fecha, granularidad);
      const b = buckets[key] ?? (buckets[key] = { key, label, gasto: 0, galones: 0, km: 0, cargas: 0 });
      b.gasto += Number(r.total || 0);
      b.cargas += 1;
      if (!COMBUSTIBLES[tipo]?.esAditivo) {
        // Solo entran los tramos MEDIDOS: numerador y denominador de las mismas filas. Sumar
        // los galones de una carga cuyo km no se pudo medir inflaba el denominador y hundía
        // el rendimiento del período sin decir por qué.
        const t = rendDeCarga[r.id]?.tramo;
        if (t && t.rendimiento !== null && t.km != null && t.cantidad != null) {
          b.km += t.km;
          b.galones += t.cantidad;
        }
      }
    }
    return Object.values(buckets)
      .map(b => ({ ...b, rendimiento: b.km > 0 && b.galones > 0 ? b.km / b.galones : null }))
      .sort((a, b) => b.key.localeCompare(a.key));
  }, [filtrados, rendDeCarga, granularidad]);

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <main className="p-6 space-y-5 max-w-7xl mx-auto">

      {/* ENCABEZADO */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Combustible</h1>
          <p className="text-gray-400 text-sm mt-1">
            Diésel · GLP · GNV · Gasolina · Urea · Biodiésel — control multi-combustible con detección de anomalías
          </p>
        </div>
        <button onClick={() => { limpiar(); setMostrarForm(v => !v); }}
          className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
          style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
          {mostrarForm ? "✕ Cancelar" : "⛽ Nueva carga"}
        </button>
      </div>

      {/* ALERTA ANOMALÍAS */}
      {totalAnomalias > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-center gap-3 text-sm text-red-800">
          🚨 <b>{totalAnomalias} registro{totalAnomalias > 1 ? "s" : ""} con anomalías</b> — carga excesiva o rendimiento anormal detectado
        </div>
      )}

      {/* KPIs GLOBALES */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total registros", valor: registros.length,       color: "#0b315f", bg: "#eef3f8" },
          { label: "Gasto total",     valor: fmtSoles(totalGastado), color: "#991b1b", bg: "#fee2e2" },
          { label: "Gasto este mes",  valor: fmtSoles(gastoMes),     color: "#6d28d9", bg: "#ede9fe" },
          { label: "Anomalías",       valor: totalAnomalias,         color: totalAnomalias > 0 ? "#991b1b" : "#166534", bg: totalAnomalias > 0 ? "#fee2e2" : "#dcfce7" },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
            <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
            <p className="text-xl font-black mt-0.5 leading-tight" style={{ color: k.color }}>{k.valor}</p>
          </div>
        ))}
      </section>

      {/* KPIs POR TIPO DE COMBUSTIBLE */}
      {kpisPorTipo.length > 0 && (
        <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          {kpisPorTipo.map(({ tipo, cfg, cantidad, costo, cargas }) => (
            <div key={tipo} className="rounded-xl p-3 border cursor-pointer hover:shadow-sm transition-all"
              style={{ background: cfg.bg, borderColor: cfg.color + "33" }}
              onClick={() => { setFiltroTipo(tipo); setVista("historial"); }}>
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-base">{cfg.icon}</span>
                <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: cfg.color + "99" }}>{cfg.label}</p>
              </div>
              <p className="text-base font-black leading-tight" style={{ color: cfg.color }}>{fmtSoles(costo)}</p>
              <p className="text-[10px] mt-0.5" style={{ color: cfg.color + "88" }}>
                {fmtNum(cantidad)} {cfg.unidadLabel} · {cargas} carga{cargas > 1 ? "s" : ""}
              </p>
              {cfg.esAditivo && <span className="text-[9px] font-bold" style={{ color: cfg.color }}>ADITIVO</span>}
            </div>
          ))}
        </section>
      )}

      {/* FORMULARIO */}
      {mostrarForm && (
        <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>
              {fuelCfg.icon}
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar carga" : "Registrar carga de combustible"}</h2>
              <p className="text-xs text-gray-400">Selecciona el tipo de combustible — la unidad y precio referencial se ajustan automáticamente</p>
            </div>
          </div>

          {/* La foto del voucher, arriba de los campos: se corrige mirándola, no de memoria. */}
          {editandoId != null && (() => {
            const est = estadoFotoRadar(editandoId);
            if (est === "sin_radar") return null;
            if (est === "hay") return <FotosDelRadar fotos={fotosDeCarga[editandoId]} nota={notaDeCarga[editandoId]} />;
            return (
              <p className="rounded-2xl border border-blue-100 bg-[#f8fafc] px-4 py-3 text-xs text-gray-500">
                {est === "cargando" ? "Buscando la foto que leyó el Radar IA…" : <>
                  📷 Esta carga la registró el <b>Radar IA</b>, pero no quedó guardada la foto que leyó
                  {notaDeCarga[editandoId] ? <> (nota <span className="font-mono">{notaDeCarga[editandoId]}</span>)</> : null}.
                  {" "}Su lectura completa está en <Link href="/radar-ia?tab=combustible" className="font-bold text-[#1d4ed8] hover:underline">Radar IA → Combustible</Link>.
                </>}
              </p>
            );
          })()}

          {/* Selector visual de tipo de combustible */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">Tipo de combustible</p>
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
              {Object.entries(COMBUSTIBLES).map(([tipo, cfg]) => {
                const activo = form.tipo_combustible === tipo;
                return (
                  <button key={tipo} onClick={() => cambiarTipo(tipo)}
                    className="flex flex-col items-center gap-1 px-3 py-2.5 rounded-xl border-2 transition-all text-center"
                    style={{
                      background:   activo ? cfg.bg      : "white",
                      borderColor:  activo ? cfg.color   : "#e5e7eb",
                      color:        activo ? cfg.color   : "#9ca3af",
                    }}>
                    <span className="text-xl">{cfg.icon}</span>
                    <span className="text-[10px] font-bold">{cfg.label}</span>
                    {cfg.esAditivo && <span className="text-[9px] opacity-70">Aditivo</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Datos */}
          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Datos de la carga</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Campo label="Vehículo *">
                <select className={inputCls()} value={form.vehiculo_id} onChange={e => setForm(p => ({ ...p, vehiculo_id: e.target.value }))}>
                  <option value="">Seleccionar vehículo</option>
                  <optgroup label="Flota propia">
                    {unidades.filter(u => u.tipo === "propio").map(u => <option key={u.uid} value={u.uid}>{u.placa}{u.categoria ? ` · ${u.categoria}` : ""}</option>)}
                  </optgroup>
                  <optgroup label="Tercerizadas">
                    {unidades.filter(u => u.tipo === "tercero").map(u => <option key={u.uid} value={u.uid}>{u.placa}{u.categoria ? ` · ${u.categoria}` : ""}</option>)}
                  </optgroup>
                </select>
              </Campo>
              <Campo label="Fecha *">
                <input type="date" className={inputCls()} value={form.fecha}
                  onChange={e => setForm(p => ({ ...p, fecha: e.target.value }))} />
              </Campo>
              <Campo label="Kilometraje actual">
                <input type="number" className={inputCls("font-mono")} placeholder="Ej: 150000" value={form.kilometraje}
                  onChange={e => setForm(p => ({ ...p, kilometraje: e.target.value }))} />
              </Campo>
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
              Cantidad y precio — <span style={{ color: fuelCfg.color }}>{fuelCfg.label} ({fuelCfg.unidadLabel})</span>
            </p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <Campo label={`Cantidad * (${fuelCfg.unidadLabel}) · Cap. ~${form.vehiculo_id ? getCapacidad(unidadDe(form.vehiculo_id),form.tipo_combustible) : "—"} ${fuelCfg.unidadLabel}`}>
                <input type="number" min="0" className={inputCls(
                  form.vehiculo_id && Number(form.galones) > getCapacidad(unidadDe(form.vehiculo_id),form.tipo_combustible) * 1.1
                    ? "border-red-400 bg-red-50" : ""
                )} placeholder={`${fuelCfg.unidadLabel}`} value={form.galones}
                  onChange={e => setForm(p => ({ ...p, galones: e.target.value }))} />
                {form.vehiculo_id && Number(form.galones) > getCapacidad(unidadDe(form.vehiculo_id),form.tipo_combustible) * 1.1 && (
                  <p className="text-xs text-red-600 mt-1 font-bold">⚠ Supera capacidad del tanque</p>
                )}
              </Campo>
              <Campo label={`Precio S/ por ${fuelCfg.unidadLabel} · Ref: ${fmtSoles(fuelCfg.precioRef)}`}>
                <input type="number" min="0" className={inputCls()} placeholder={String(fuelCfg.precioRef)} value={form.precio_galon}
                  onChange={e => setForm(p => ({ ...p, precio_galon: e.target.value }))} />
              </Campo>
              <Campo label="Grifo / Estación">
                <input className={inputCls()} placeholder="Ej: Primax - Ate" value={form.grifo}
                  onChange={e => setForm(p => ({ ...p, grifo: e.target.value }))} />
              </Campo>
              <Campo label="Conductor">
                <select className={inputCls()} value={form.conductor}
                  onChange={e => setForm(p => ({ ...p, conductor: e.target.value }))}>
                  <option value="">Seleccionar conductor</option>
                  {conductores.map(c => <option key={c.id} value={c.nombre}>{c.nombre}</option>)}
                </select>
              </Campo>
            </div>

            {/* Preview total */}
            {totalPreview > 0 && (
              <div className="mt-3 flex items-center gap-6 rounded-xl px-4 py-3" style={{ background: fuelCfg.bg }}>
                <div>
                  <p className="text-[10px] font-bold uppercase" style={{ color: fuelCfg.color + "99" }}>Total calculado</p>
                  <p className="text-2xl font-black" style={{ color: fuelCfg.color }}>{fmtSoles(totalPreview)}</p>
                </div>
                <div className="text-xs" style={{ color: fuelCfg.color + "88" }}>
                  {form.galones} {fuelCfg.unidadLabel} × {fmtSoles(Number(form.precio_galon))} / {fuelCfg.unidadLabel}
                </div>
                {/* Rendimiento esperado */}
                {form.vehiculo_id && !fuelCfg.esAditivo && (() => {
                  const s = seriesRend.get(`${form.vehiculo_id}|${familiaCombustible(form.tipo_combustible)}`);
                  return s?.resumen.mediana ? (
                    <div className="ml-auto text-right">
                      <p className="text-[10px] font-bold uppercase" style={{ color: fuelCfg.color + "99" }}>Rendimiento histórico</p>
                      <p className="font-black" style={{ color: fuelCfg.color }}>{fmtNum(s.resumen.mediana, 1)} {s.resumen.label}</p>
                      <p className="text-[10px]" style={{ color: fuelCfg.color + "88" }}>
                        mediana de {s.resumen.n} tramo{s.resumen.n === 1 ? "" : "s"}
                      </p>
                    </div>
                  ) : null;
                })()}
              </div>
            )}
          </div>

          <Campo label="Observaciones" span={3}>
            <input className={inputCls()} placeholder="Notas adicionales..." value={form.observaciones}
              onChange={e => setForm(p => ({ ...p, observaciones: e.target.value }))} />
          </Campo>

          <div className="flex gap-3">
            <button onClick={guardar} disabled={guardando}
              className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
              style={{ background: "#0b315f" }}>
              {guardando ? "Guardando..." : editandoId ? "Actualizar" : "Guardar carga"}
            </button>
            <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
          </div>
        </section>
      )}

      {/* PESTAÑAS */}
      <div className="flex gap-1 border-b overflow-x-auto">
        {([
          ["historial",     "📋 Historial"],
          ["analisis",      "📈 Análisis"],
          ["por_tipo",      "⛽ Por tipo"],
          ["por_vehiculo",  "🚌 Por vehículo"],
          ["por_conductor", "👤 Por conductor"],
          ["por_grifo",     "🏪 Por grifo"],
        ] as [VistaActiva, string][]).map(([v, l]) => (
          <button key={v} onClick={() => setVista(v)}
            className="px-4 py-2.5 text-sm font-bold border-b-2 -mb-px transition-all whitespace-nowrap"
            style={{ borderColor: vista === v ? "#0b315f" : "transparent", color: vista === v ? "#0b315f" : "#9ca3af" }}>
            {l}
          </button>
        ))}
      </div>

      {/* ── HISTORIAL ── */}
      {vista === "historial" && (
        <>
          <section className="flex flex-col md:flex-row gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[180px]">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
              <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
                placeholder="Buscar por placa, grifo, conductor o combustible..."
                value={busqueda} onChange={e => setBusqueda(e.target.value)} />
            </div>
            <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroFlota} onChange={e => setFiltroFlota(e.target.value as "todos" | "propio" | "tercero")}>
              <option value="todos">Toda la flota</option>
              <option value="propio">Propios</option>
              <option value="tercero">Tercerizados</option>
            </select>
            <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroVeh} onChange={e => setFiltroVeh(e.target.value)}>
              <option value="todos">Todos los vehículos</option>
              <optgroup label="Flota propia">
                {unidades.filter(u => u.tipo === "propio").map(u => <option key={u.uid} value={u.uid}>{u.placa}</option>)}
              </optgroup>
              <optgroup label="Tercerizadas">
                {unidades.filter(u => u.tipo === "tercero").map(u => <option key={u.uid} value={u.uid}>{u.placa}</option>)}
              </optgroup>
            </select>
            <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)}>
              <option value="todos">Todos los tipos</option>
              {Object.entries(COMBUSTIBLES).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
            </select>
            <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroMes} onChange={e => setFiltroMes(e.target.value)}>
              <option value="todos">Todos los meses</option>
              {mesesUnicos.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">
              {filtrados.length} resultado{filtrados.length !== 1 ? "s" : ""}
            </div>
          </section>

          <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                    <th className="p-3 w-8"></th>
                    {["Fecha", "Vehículo", "Combustible", "Cantidad", "Precio/ud", "Total", "Rendimiento", "Grifo", "Conductor", "⚠", "Acciones"].map(h => (
                      <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={12} className="p-10 text-center text-gray-400">
                      <div className="flex items-center justify-center gap-2"><div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...</div>
                    </td></tr>
                  ) : filtrados.length === 0 ? (
                    <tr><td colSpan={12} className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">⛽</p><p>No hay registros</p></td></tr>
                  ) : filtrados.map(r => {
                    const tipo    = r.tipo_combustible || "diesel";
                    const cfg     = COMBUSTIBLES[tipo] || COMBUSTIBLES.diesel;
                    const unidLbl = r.unidad === "m3" ? "m³" : r.unidad || "gal";
                    const ent     = rendDeCarga[r.id];
                    const tramo   = ent?.tramo ?? null;
                    const resumen = ent?.resumen ?? null;
                    const rend    = tramo?.rendimiento ?? null;
                    const promedio= resumen?.mediana ?? null;
                    const hallazgo= ent ? juzgarTramo(ent.tramo, ent.resumen) : null;
                    const uni     = unidadDe(uidReg(r));
                    const cap     = getCapacidad(uni,tipo);
                    const expandido = expandidoId === r.id;

                    const anomaliaExceso = Number(r.galones) > cap * 1.1;
                    const tieneAnomalia  = anomaliaExceso || !!hallazgo;
                    // Rojo = consumió de más (plata que se fue). Ámbar = rindió de más de lo
                    // posible, que es una carga SIN REGISTRAR (plata que falta en los libros).
                    // Son dos cosas distintas y antes eran el mismo cubo — con el segundo caso
                    // pintado de verde.
                    const colorRend = !tramo || rend === null ? "#9ca3af"
                      : hallazgo?.codigo === "rendimiento_bajo" ? "#dc2626"
                      : hallazgo?.codigo === "rendimiento_alto" ? "#b45309"
                      : "#166534";

                    return (
                      <React.Fragment key={r.id}>
                        <tr className={`border-t transition-colors cursor-pointer ${tieneAnomalia ? "bg-red-50/40" : "hover:bg-gray-50"}`}
                          style={{ borderColor: "#f1f5f9" }}
                          onClick={() => { setExpandidoId(expandido ? null : r.id); if (!expandido) verLoQueLeyoElRadar(r.id); }}>
                          <td className="p-3 text-gray-300 text-xs">{expandido ? "▼" : "▶"}</td>
                          <td className="p-3 text-xs text-gray-600 font-medium whitespace-nowrap">
                            {fmtFecha(r.fecha)}
                            {cargasDelRadar.has(r.id) && (
                              <span className="ml-1.5" title="La leyó el Radar IA de una foto — ábrela para verla">📷</span>
                            )}
                          </td>
                          <td className="p-3 font-mono font-black text-xs text-[#0b315f]">
                            {placaReg(r)}
                            {uni?.tipo === "tercero" && <span className="ml-1.5 text-[9px] font-black text-[#7c3aed] bg-[#f3e8ff] px-1.5 py-0.5 rounded-full align-middle">tercero</span>}
                          </td>
                          <td className="p-3">
                            <span className="text-xs font-bold px-2 py-0.5 rounded-lg" style={{ background: cfg.bg, color: cfg.color }}>
                              {cfg.icon} {cfg.label}
                            </span>
                          </td>
                          <td className="p-3 font-bold text-xs" style={{ color: cfg.color }}>
                            {fmtNum(Number(r.galones || 0))} {unidLbl}
                          </td>
                          <td className="p-3 text-xs text-gray-500">{fmtSoles(Number(r.precio_galon || 0))}/{unidLbl}</td>
                          <td className="p-3 font-black text-xs text-red-700">{fmtSoles(Number(r.total || 0))}</td>
                          {/* El "—" colapsaba cinco casos distintos y cada uno se arregla en
                              otro lado. Ahora la celda dice CUÁL, y el detalle completo está
                              al desplegar la fila. */}
                          <td className="p-3 text-xs font-bold">
                            {rend !== null ? (
                              <span style={{ color: colorRend }}>
                                {fmtNum(rend, 1)} {resumen?.label ?? cfg.rendimientoLabel}
                              </span>
                            ) : tramo?.motivo ? (
                              <span className="text-gray-400 font-medium" title={tramo.detalle}>
                                {tramo.crudo !== null && (
                                  <span className="line-through text-gray-300 mr-1">{fmtNum(tramo.crudo, 1)}</span>
                                )}
                                {etiquetaMotivo(tramo.motivo)}
                              </span>
                            ) : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="p-3 text-xs text-gray-500 max-w-[90px]"><div className="truncate">{r.grifo || "—"}</div></td>
                          <td className="p-3 text-xs text-gray-500 max-w-[90px]"><div className="truncate">{r.conductor || "—"}</div></td>
                          <td className="p-3 text-center">
                            {tieneAnomalia ? <span className="text-base">🚨</span> : <span className="text-green-500 text-xs">✓</span>}
                          </td>
                          <td className="p-3" onClick={e => e.stopPropagation()}>
                            <div className="flex gap-1.5">
                              <button onClick={() => editar(r)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                              <button onClick={() => eliminar(r.id)} className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-red-500 border border-red-100 hover:bg-red-50">✕</button>
                            </div>
                          </td>
                        </tr>

                        {expandido && (
                          <tr style={{ background: "#f8fafc" }} className="border-t">
                            <td colSpan={12} className="px-6 py-4">
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                                <div className="space-y-1">
                                  <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Carga</p>
                                  <p><span className="text-gray-400">Fecha:</span> {fmtFecha(r.fecha)}</p>
                                  <p><span className="text-gray-400">Vehículo:</span> <b>{placaReg(r)}</b></p>
                                  <p><span className="text-gray-400">KM:</span> <span className="font-mono">{r.kilometraje ? fmtNum(Number(r.kilometraje), 0) : "—"}</span></p>
                                  <p><span className="text-gray-400">Conductor:</span> {r.conductor || "—"}</p>
                                </div>
                                <div className="space-y-1">
                                  <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Combustible</p>
                                  <p><span className="text-gray-400">Tipo:</span> <b style={{ color: cfg.color }}>{cfg.icon} {cfg.label}</b></p>
                                  <p><span className="text-gray-400">Cantidad:</span> <b>{fmtNum(Number(r.galones || 0))} {unidLbl}</b></p>
                                  <p><span className="text-gray-400">Precio/{unidLbl}:</span> {fmtSoles(Number(r.precio_galon || 0))}</p>
                                  <p><span className="text-gray-400">Total:</span> <b className="text-red-700">{fmtSoles(Number(r.total || 0))}</b></p>
                                  <p><span className="text-gray-400">Grifo:</span> {r.grifo || "—"}</p>
                                </div>
                                <div className="space-y-1">
                                  <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Rendimiento</p>
                                  {cfg.esAditivo
                                    ? <p className="text-gray-400 italic">Aditivo — su métrica es el consumo (lt/100km), no el rendimiento</p>
                                    : <>
                                        <p><span className="text-gray-400">Este tramo:</span>{" "}
                                          {rend !== null
                                            ? <b style={{ color: colorRend }}>{fmtNum(rend, 1)} {resumen?.label}</b>
                                            : <b className="text-gray-500">{tramo?.motivo ? etiquetaMotivo(tramo.motivo) : "—"}</b>}
                                          {tramo?.km != null && tramo.cantidad != null && (
                                            <span className="text-gray-400"> · {fmtNum(tramo.km, 0)} km ÷ {fmtNum(tramo.cantidad, 2)}</span>
                                          )}
                                        </p>
                                        <p><span className="text-gray-400">Mediana del vehículo:</span>{" "}
                                          {promedio
                                            ? <b>{fmtNum(promedio, 1)} {resumen?.label}</b>
                                            : <span className="text-gray-400">sin medir aún</span>}
                                          {resumen && resumen.n > 0 && (
                                            <span className={resumen.confiable ? "text-gray-400" : "text-amber-600"}>
                                              {" "}({resumen.n} tramo{resumen.n === 1 ? "" : "s"}{resumen.confiable ? "" : ", aún pocos"})
                                            </span>
                                          )}
                                        </p>
                                        <p><span className="text-gray-400">Cap. tanque:</span> {cap} {unidLbl}</p>
                                        {/* El porqué del "—", en la fila donde se puede arreglar. */}
                                        {tramo?.motivo && tramo.detalle && (
                                          <p className="text-[11px] text-gray-500 leading-snug pt-1">{tramo.detalle}</p>
                                        )}
                                        {resumen && resumen.cargasSinOdometro > 0 && (
                                          <p className="text-[11px] text-amber-700 leading-snug">
                                            Esta unidad tiene {resumen.cargasSinOdometro} carga(s) sin kilometraje:
                                            ponérselo mejora todos sus tramos.
                                          </p>
                                        )}
                                      </>}
                                </div>
                                <div className="space-y-1">
                                  <p className="font-bold text-[10px] uppercase tracking-widest text-gray-400">Estado</p>
                                  {!tieneAnomalia
                                    ? <div className="flex items-center gap-1.5 text-green-700"><span>✅</span><span className="font-bold">Sin anomalías</span></div>
                                    : <>
                                        {anomaliaExceso && <div className="rounded-lg px-2 py-1.5 bg-red-50 text-red-700 text-[10px] font-bold">🚨 Carga ({fmtNum(Number(r.galones))} {unidLbl}) supera capacidad ({cap} {unidLbl})</div>}
                                        {hallazgo && (
                                          <div className={`rounded-lg px-2 py-1.5 text-[10px] leading-snug ${hallazgo.codigo === "rendimiento_bajo" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-800"}`}>
                                            <b>{hallazgo.codigo === "rendimiento_bajo" ? "🔴 Consumió de más" : "🟠 Falta registrar una carga"}</b>
                                            <div className="font-medium mt-0.5">{hallazgo.detalle}</div>
                                          </div>
                                        )}
                                      </>}
                                </div>
                              </div>
                              {(() => {
                                const est = estadoFotoRadar(r.id);
                                if (est === "sin_radar") return null;
                                if (est === "hay") return (
                                  <div className="mt-4"><FotosDelRadar fotos={fotosDeCarga[r.id]} nota={notaDeCarga[r.id]} alto="h-28" /></div>
                                );
                                return (
                                  <p className="mt-3 text-[11px] text-gray-400">
                                    {est === "cargando"
                                      ? "Buscando la foto que leyó el Radar IA…"
                                      : "📷 La registró el Radar IA, pero no quedó guardada la foto que leyó."}
                                  </p>
                                );
                              })()}
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
              <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
                <span>{filtrados.length} de {registros.length} · Total: {fmtSoles(filtrados.reduce((s, r) => s + Number(r.total || 0), 0))}</span>
                <span>AFA ERP · Flota</span>
              </div>
            )}
          </section>
        </>
      )}

      {/* ── POR TIPO ── */}
      {vista === "por_tipo" && (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {kpisPorTipo.map(({ tipo, cfg, cantidad, costo, cargas }) => (
            <div key={tipo} className="bg-white rounded-2xl border shadow-sm p-5" style={{ borderColor: cfg.color + "33" }}>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ background: cfg.bg }}>{cfg.icon}</div>
                <div>
                  <h3 className="font-black text-gray-900">{cfg.label}</h3>
                  <p className="text-xs text-gray-400">{cfg.unidadLabel} · {cfg.esAditivo ? "Aditivo" : "Combustible"} · {cargas} carga{cargas > 1 ? "s" : ""}</p>
                </div>
                <div className="ml-auto text-right">
                  <p className="text-xl font-black" style={{ color: cfg.color }}>{fmtSoles(costo)}</p>
                  <p className="text-xs text-gray-400">{fmtNum(cantidad)} {cfg.unidadLabel}</p>
                </div>
              </div>
              <div className="text-xs text-gray-500 space-y-1">
                <div className="flex justify-between"><span>Precio ref. Perú:</span><b>{fmtSoles(cfg.precioRef)}/{cfg.unidadLabel}</b></div>
                <div className="flex justify-between"><span>Precio promedio pagado:</span>
                  <b>{(() => { const regs = registros.filter(r => (r.tipo_combustible || "diesel") === tipo); return regs.length > 0 ? fmtSoles(regs.reduce((s, r) => s + Number(r.precio_galon || 0), 0) / regs.length) : "—"; })()}/{cfg.unidadLabel}</b>
                </div>
                <div className="flex justify-between"><span>Rendimiento:</span><span className="text-gray-400">{cfg.rendimientoLabel}</span></div>
              </div>
              <button onClick={() => { setFiltroTipo(tipo); setVista("historial"); }}
                className="mt-3 w-full py-2 rounded-xl text-xs font-bold border hover:bg-gray-50 text-gray-600">
                Ver historial de {cfg.label} →
              </button>
            </div>
          ))}
          {kpisPorTipo.length === 0 && (
            <div className="col-span-2 p-10 text-center text-gray-400 bg-white rounded-2xl border">
              <p className="text-3xl mb-2">⛽</p><p>Sin registros aún</p>
            </div>
          )}
        </section>
      )}

      {/* ── POR VEHÍCULO ── */}
      {vista === "por_vehiculo" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {["Vehículo", "Cargas", "Combustibles usados", "Costo total", "Rendimiento", "CPK combustible", ""].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {datosVehiculo.map(d => (
                <tr key={d.vehiculo.uid} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                  <td className="p-3 font-mono font-black text-[#0b315f]">
                    {d.vehiculo.placa}
                    {d.vehiculo.tipo === "tercero" && <span className="ml-1.5 text-[9px] font-black text-[#7c3aed] bg-[#f3e8ff] px-1.5 py-0.5 rounded-full align-middle">tercero</span>}
                    <div className="text-xs text-gray-400 font-normal">{d.vehiculo.categoria}</div>
                  </td>
                  <td className="p-3 text-gray-600">{d.regs}</td>
                  <td className="p-3">
                    <div className="flex gap-1 flex-wrap">
                      {d.tipos.map(t => { const c = COMBUSTIBLES[t] || COMBUSTIBLES.diesel; return <span key={t} className="text-[10px] font-bold px-2 py-0.5 rounded" style={{ background: c.bg, color: c.color }}>{c.icon} {c.label}</span>; })}
                    </div>
                  </td>
                  <td className="p-3 font-bold text-red-700">{fmtSoles(d.costo)}</td>
                  {/* Mediana, una línea por familia. Con pocos tramos el número sale en gris
                      diciendo cuántos son: nunca escondido, nunca disfrazado de firme. */}
                  <td className="p-3">
                    {d.series.length === 0 ? <span className="text-gray-300">—</span> : (
                      <div className="space-y-0.5">
                        {d.series.map(s => (
                          <div key={s.resumen.familia} className="whitespace-nowrap">
                            <b className={s.resumen.confiable ? "text-[#166534]" : "text-gray-400"}>
                              {fmtNum(s.resumen.mediana ?? 0, 1)} {s.resumen.label}
                            </b>
                            <span className="text-[10px] text-gray-400 ml-1">
                              ({s.resumen.n} tramo{s.resumen.n === 1 ? "" : "s"}{s.resumen.confiable ? "" : ", pocos"})
                            </span>
                          </div>
                        ))}
                        {d.sinOdometro > 0 && (
                          <div className="text-[10px] text-amber-600">{d.sinOdometro} carga(s) sin km</div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="p-3">
                    {d.cpk ? (
                      <>
                        <b className="text-gray-800">S/ {fmtNum(d.cpk, 3)}/km</b>
                        <div className="text-[10px] text-gray-400">
                          medido entre cargas · {d.coberturaCargas} de {d.regs} · {fmtNum(d.kmMedido, 0)} km
                        </div>
                      </>
                    ) : (
                      <span className="text-gray-400 text-xs">
                        —<span className="block text-[10px]">sin tramos medidos</span>
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    <button onClick={() => { setFiltroVeh(d.vehiculo.uid); setVista("historial"); }}
                      className="text-xs font-bold text-[#0b315f] hover:underline">Ver →</button>
                  </td>
                </tr>
              ))}
              {datosVehiculo.length === 0 && <tr><td colSpan={7} className="p-10 text-center text-gray-400">Sin datos</td></tr>}
            </tbody>
          </table>
        </section>
      )}

      {/* ── POR CONDUCTOR ── */}
      {vista === "por_conductor" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {["Conductor", "Cargas", "Gasto total", "Prom. por carga", "vs. su unidad", "Rendimiento", ""].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {datosConductor.length === 0 ? (
                <tr><td colSpan={7} className="p-10 text-center text-gray-400">Sin conductores en registros</td></tr>
              ) : datosConductor.map(d => (
                <tr key={d.conductor} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                  <td className="p-3 font-bold text-gray-800">👤 {d.conductor}</td>
                  <td className="p-3 text-gray-600">{d.cargas}</td>
                  <td className="p-3 font-bold text-red-700">{fmtSoles(d.costo)}</td>
                  <td className="p-3 text-gray-600">{d.cargas > 0 ? fmtSoles(d.costo / d.cargas) : "—"}</td>
                  {/* La comparación que significa algo: contra la mediana de la unidad que
                      manejó, no contra los demás conductores. */}
                  <td className="p-3">
                    {d.desvio === null ? (
                      <span className="text-gray-300">—</span>
                    ) : (
                      <>
                        <b style={{ color: d.desvio < -0.1 ? "#dc2626" : d.desvio > 0.1 ? "#b45309" : "#166534" }}>
                          {d.desvio > 0 ? "+" : ""}{fmtNum(d.desvio * 100, 1)} %
                        </b>
                        <div className="text-[10px] text-gray-400">
                          {d.tramos} tramo{d.tramos === 1 ? "" : "s"} medido{d.tramos === 1 ? "" : "s"}
                          {d.ambiguos > 0 && ` · ${d.ambiguos} con cambio de conductor`}
                        </div>
                      </>
                    )}
                  </td>
                  <td className="p-3 text-gray-600 text-xs">
                    {d.rendMedio !== null ? fmtNum(d.rendMedio, 1) : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="p-3"><button onClick={() => { setVista("historial"); setBusqueda(d.conductor); }} className="text-xs font-bold text-[#0b315f] hover:underline">Ver →</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-3 text-[11px] text-gray-500 border-t leading-snug" style={{ borderColor: "#f1f5f9" }}>
            <b>vs. su unidad</b> compara cada tramo contra la mediana de la unidad que se manejó, no contra
            los demás conductores: quien conduce una van siempre rendiría más que quien conduce un bus.
            Un tramo cuyos dos extremos los cargaron personas distintas no se atribuye a ninguna
            —se cuenta aparte— porque aquí el número señala a alguien. <b>Una diferencia no es una acusación:</b>{" "}
            la ruta, el tráfico y el tanque llenado a medias explican la mayoría.
          </p>
        </section>
      )}

      {/* ── ANÁLISIS (gasto y rendimiento por período) ── */}
      {vista === "analisis" && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="inline-flex rounded-xl border overflow-hidden">
              {([["dia", "Día"], ["semana", "Semana"], ["mes", "Mes"]] as [GranPeriodo, string][]).map(([g, l]) => (
                <button key={g} onClick={() => setGranularidad(g)}
                  className="px-4 py-2 text-sm font-bold transition-all"
                  style={{ background: granularidad === g ? "#0b315f" : "#fff", color: granularidad === g ? "#fff" : "#6b7280" }}>
                  {l}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500 flex-1 min-w-[200px]">
              Gasto y rendimiento por período (respeta los filtros de vehículo/tipo).{" "}
              {filtroVeh === "todos" || filtroTipo === "todos"
                ? "Filtra por una unidad y un tipo para un rendimiento exacto; combinado es aproximado."
                : "Rendimiento exacto para el filtro seleccionado."}
            </p>
          </div>

          {/* Resumen del rango */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {(() => {
              const totGasto = analisisPeriodos.reduce((s, b) => s + b.gasto, 0);
              const totKm = analisisPeriodos.reduce((s, b) => s + b.km, 0);
              const totGal = analisisPeriodos.reduce((s, b) => s + b.galones, 0);
              const rend = totKm > 0 && totGal > 0 ? totKm / totGal : null;
              const tarjetas = [
                { label: "Gasto en el rango", valor: fmtSoles(totGasto), color: "#991b1b", bg: "#fee2e2" },
                { label: "Km recorridos", valor: totKm > 0 ? `${fmtNum(totKm, 0)} km` : "—", color: "#0b315f", bg: "#eef3f8" },
                { label: "Cantidad total", valor: totGal > 0 ? `${fmtNum(totGal, 1)}` : "—", color: "#6d28d9", bg: "#ede9fe" },
                { label: "Rendimiento prom.", valor: rend != null ? `${fmtNum(rend, 1)} ${rendLabelAnalisis}` : "—", color: "#166534", bg: "#dcfce7" },
              ];
              return tarjetas.map(k => (
                <div key={k.label} className="rounded-2xl p-4" style={{ background: k.bg }}>
                  <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: k.color, opacity: 0.75 }}>{k.label}</p>
                  <p className="text-xl font-black mt-1" style={{ color: k.color }}>{k.valor}</p>
                </div>
              ));
            })()}
          </div>

          {/* Tabla por período */}
          <div className="bg-white rounded-2xl border shadow-sm overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  {["Período", "Cargas", "Cantidad", "Km recorridos", "Gasto", `Rendimiento (${rendLabelAnalisis})`].map(h => (
                    <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {analisisPeriodos.length === 0 ? (
                  <tr><td colSpan={6} className="p-10 text-center text-gray-400">Sin datos en el rango seleccionado</td></tr>
                ) : (() => {
                  const maxGasto = Math.max(...analisisPeriodos.map(x => x.gasto), 1);
                  return analisisPeriodos.map(b => (
                    <tr key={b.key} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                      <td className="p-3 font-bold text-gray-800 capitalize whitespace-nowrap">{b.label}</td>
                      <td className="p-3 text-gray-600">{b.cargas}</td>
                      <td className="p-3 text-gray-600">{b.galones > 0 ? fmtNum(b.galones, 1) : "—"}</td>
                      <td className="p-3 text-gray-600 whitespace-nowrap">{b.km > 0 ? `${fmtNum(b.km, 0)} km` : "—"}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <div className="h-2 rounded-full flex-shrink-0" style={{ width: `${Math.round((b.gasto / maxGasto) * 70)}px`, background: "#991b1b", opacity: 0.25 }} />
                          <span className="font-bold text-red-700 whitespace-nowrap">{fmtSoles(b.gasto)}</span>
                        </div>
                      </td>
                      <td className="p-3 font-bold whitespace-nowrap" style={{ color: b.rendimiento != null ? "#166534" : "#9ca3af" }}>
                        {b.rendimiento != null ? fmtNum(b.rendimiento, 1) : "—"}
                      </td>
                    </tr>
                  ));
                })()}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-gray-400">
            Los km recorridos y el rendimiento se calculan con el odómetro registrado en cada carga (Radar IA, check-in o registro manual).
            En la Fase 3 (Check-in/Check-out) se separará el <b>km de servicio</b> del <b>km fantasma</b> para el costeo por servicio.
          </p>
        </section>
      )}

      {/* ── POR GRIFO ── */}
      {vista === "por_grifo" && (
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                {["Grifo / Estación", "Cargas", "Gasto total", "Precio prom./ud", ""].map(h => (
                  <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {datosGrifo.length === 0 ? (
                <tr><td colSpan={5} className="p-10 text-center text-gray-400">Sin grifos registrados</td></tr>
              ) : datosGrifo.map(d => (
                <tr key={d.grifo} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                  <td className="p-3 font-bold text-gray-800">🏪 {d.grifo}</td>
                  <td className="p-3 text-gray-600">{d.cargas}</td>
                  <td className="p-3 font-bold text-red-700">{fmtSoles(d.costo)}</td>
                  <td className="p-3 font-bold text-gray-700">{fmtSoles(d.precProm)}</td>
                  <td className="p-3"><button onClick={() => { setVista("historial"); setBusqueda(d.grifo); }} className="text-xs font-bold text-[#0b315f] hover:underline">Ver →</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}