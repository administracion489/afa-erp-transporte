"use client";
// components/licitaciones/editor/EditorLicitacion.tsx — El editor de /licitaciones/[id]. Es el ÚNICO
// dueño del estado y del guardado (contrato-editor.ts): lee la licitación y el contexto del ERP,
// calcula la revisión (motor puro), guarda solo con antirrebote y bloqueo optimista, y reparte
// PasoProps a los cinco pasos. Los pasos nunca llaman a guardarLicitacion.
//
// Lo que no se afloja:
//  · Nunca dos guardados a la vez; con conflicto el guardado automático se DETIENE y se pregunta (R1).
//  · Mientras se lee, «comprobando…»: nunca se afirma un vacío (ni «sin hallazgos») sin contexto.
//  · Un paso que falla cae solo (LimitePaso): el trabajo sin guardar vive aquí, no en él.
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePermiso } from "@/lib/usePermiso";
import {
  archivarLicitacion, cargarContexto, crearLicitacion, leerLicitacion, nuevoUuid,
} from "@/lib/licitaciones/datos";
import { revisarLicitacion } from "@/lib/licitaciones/revision";
import { fechaLima } from "@/lib/documentos-estado";
import { diasISO, fechaDMY } from "@/lib/licitaciones/util";
import { PASOS, type ContextoLicitacion, type Gravedad, type Paso, type Revision } from "@/lib/licitaciones/tipos";
import type { PasoProps, TonoAviso } from "./contrato-editor";
import { ProveedorEditorExtra, type DestinoAncla, type EditorExtra, type FaseGuardado } from "./contexto-editor";
import { ProveedorIA, useLecturaIA } from "./analisis-ia";
import { useEdicionLicitacion } from "./useEdicionLicitacion";
import { candidatosAncla } from "./navegacion";
import { ETIQUETA_ESTADO, ETIQUETA_PASO, haceCuanto } from "./etiquetas";
import ModalConflicto from "./ModalConflicto";
import LimitePaso from "./LimitePaso";
import PasoBases from "./PasoBases";
import PasoRecursos from "./PasoRecursos";
import PasoContenido from "./PasoContenido";
import PasoExpediente from "./PasoExpediente";
import PasoRevision from "./PasoRevision";

type Carga =
  | { fase: "cargando" }
  | { fase: "ok" }
  | { fase: "error"; error: string; sinMigracion?: string; sinPermiso?: boolean; noExiste?: boolean };

type Toast = { id: number; texto: string; tono: TonoAviso };

const RETRASO_CONTEXTO_MS = 800;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

/** El paso de `?paso=` (bases si falta o no se reconoce). */
function pasoDe(v: string | null): Paso {
  return (PASOS as readonly string[]).includes(v ?? "") ? (v as Paso) : "bases";
}

/** Firma de lo que el contexto lee del doc: si cambia, el contexto se vuelve a leer. */
function firmaRecursos(d: PasoProps["doc"] | undefined): string {
  if (!d) return "";
  return JSON.stringify([
    d.unidades.map((u) => u.clave), d.conductores.map((c) => c.clave), d.experiencia.ids,
    d.contactos.map((c) => c.personalId), d.representante.personalId,
  ]);
}

/** Recorta por caracteres completos. */
const recortar = (s: string, max: number) => (Array.from(s).length <= max ? s : Array.from(s).slice(0, max).join(""));

export default function EditorLicitacion({ id }: { id: number }) {
  const { validando, permitido } = usePermiso("licitaciones");
  const router = useRouter();
  const sp = useSearchParams();
  const paso = pasoDe(sp.get("paso"));

  const edicion = useEdicionLicitacion();
  const { lic, guardada, cargar, cambiarDoc, cambiarColumnas, guardarAhora, licActual, soloLectura, olvidarCambios, ajustarGuardada } = edicion;
  const [carga, setCarga] = useState<Carga>({ fase: "cargando" });

  // ── Avisos breves ──
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nToast = useRef(0);
  const aviso = useCallback((texto: string, tono: TonoAviso = "ok") => {
    const tid = ++nToast.current;
    setToasts((t) => [...t.slice(-3), { id: tid, texto, tono }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== tid)), tono === "error" ? 9000 : 5000);
  }, []);

  // ── Contexto del ERP (antirrebote + se descarta la respuesta vieja) ──
  const [ctx, setCtx] = useState<ContextoLicitacion | null>(null);
  const [ctxCargando, setCtxCargando] = useState(true);
  const [ctxError, setCtxError] = useState<string | null>(null);
  const ctxN = useRef(0);
  const ctxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const leerCtx = useCallback(async () => {
    const l = licActual();
    if (!l) return;
    const n = ++ctxN.current;
    setCtxCargando(true);
    try {
      const c = await cargarContexto(l);
      if (n === ctxN.current) { setCtx(c); setCtxError(null); }
    } catch (e) {
      if (n === ctxN.current) setCtxError(msg(e) || "error inesperado");
    } finally {
      if (n === ctxN.current) setCtxCargando(false);
    }
  }, [licActual]);

  const recargarCtx = useCallback(() => {
    if (ctxTimer.current) clearTimeout(ctxTimer.current);
    ctxTimer.current = setTimeout(() => { ctxTimer.current = null; void leerCtx(); }, RETRASO_CONTEXTO_MS);
  }, [leerCtx]);

  useEffect(() => () => { if (ctxTimer.current) clearTimeout(ctxTimer.current); }, []);

  // ── Carga inicial ──
  useEffect(() => {
    if (!permitido) return;
    let vivo = true;
    (async () => {
      const r = await leerLicitacion(id);
      if (!vivo) return;
      if (r.ok) {
        cargar(r.lic);
        setCarga({ fase: "ok" });
        void leerCtx();
      } else {
        setCarga({ fase: "error", error: r.error, sinMigracion: r.sinMigracion, sinPermiso: r.sinPermiso, noExiste: r.noExiste });
        setCtxCargando(false);
      }
    })();
    return () => { vivo = false; };
  }, [permitido, id, cargar, leerCtx]);

  // Elegir o quitar recursos cambia lo que el contexto tiene que leer.
  const firma = useMemo(() => firmaRecursos(lic?.doc), [lic?.doc]);
  const firmaPrev = useRef<string | null>(null);
  useEffect(() => {
    if (!firma) return;
    if (firmaPrev.current === null) { firmaPrev.current = firma; return; }
    if (firmaPrev.current !== firma) { firmaPrev.current = firma; recargarCtx(); }
  }, [firma, recargarCtx]);

  // ── Revisión (motor puro), sobre una copia diferida para no frenar la escritura ──
  const licDiferida = useDeferredValue(lic);
  const rev = useMemo<{ revision: Revision | null; error: string | null }>(() => {
    if (!licDiferida || !ctx) return { revision: null, error: null };
    try { return { revision: revisarLicitacion(licDiferida, ctx), error: null }; }
    catch (e) { return { revision: null, error: msg(e) || "error inesperado" }; }
  }, [licDiferida, ctx]);

  const porPaso = useMemo(() => {
    const o = Object.fromEntries(PASOS.map((p) => [p, { alarma: 0, aviso: 0 }])) as Record<Paso, Record<Exclude<Gravedad, "info">, number>>;
    for (const h of rev.revision?.hallazgos ?? []) {
      if (h.aceptado || h.gravedad === "info" || !("paso" in h.donde)) continue;
      o[h.donde.paso][h.gravedad]++;
    }
    return o;
  }, [rev.revision]);

  // ── Pasos y anclas ──
  const cambiarPaso = useCallback((p: Paso) => {
    const q = new URLSearchParams(window.location.search);
    q.set("paso", p);
    window.history.replaceState(null, "", `${window.location.pathname}?${q.toString()}`);
  }, []);

  const [ancla, setAncla] = useState<DestinoAncla | null>(null);
  const nAncla = useRef(0);
  const altoCabecera = useRef(0);

  const irA = useCallback((p: Paso, a?: string | null) => {
    cambiarPaso(p);
    if (a) setAncla({ ids: candidatosAncla(a), n: ++nAncla.current });
    else window.scrollTo({ top: 0, behavior: "smooth" });
  }, [cambiarPaso]);

  useEffect(() => {
    if (!ancla) return;
    let intentos = 0;
    let t: ReturnType<typeof setTimeout> | null = null;
    const buscar = () => {
      for (const domId of ancla.ids) {
        const el = document.getElementById(domId);
        if (!el) continue;
        const y = el.getBoundingClientRect().top + window.scrollY - altoCabecera.current - 12;
        window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
        el.classList.add("ring-2", "ring-amber-400", "ring-offset-2");
        setTimeout(() => el.classList.remove("ring-2", "ring-amber-400", "ring-offset-2"), 1800);
        return;
      }
      if (++intentos < 30) t = setTimeout(buscar, 80);
    };
    t = setTimeout(buscar, 60);
    return () => { if (t) clearTimeout(t); };
  }, [ancla]);

  // ── Lectura con IA (vive aquí para sobrevivir al cambio de pestaña) ──
  const tiendaIA = useLecturaIA(guardada?.id ?? null, guardarAhora);

  // ── Conflicto ──
  const [modalConflicto, setModalConflicto] = useState(true);
  const recargarVersion = useCallback(async (): Promise<string | null> => {
    const r = await leerLicitacion(id);
    if (!r.ok) return r.error;
    cargar(r.lic);
    setModalConflicto(true);
    recargarCtx();
    aviso(`Se abrió la versión ${r.lic.version} guardada. Tus cambios sin guardar se descartaron.`, "aviso");
    return null;
  }, [id, cargar, recargarCtx, aviso]);

  const guardarCopia = useCallback(async (): Promise<string | null> => {
    const l = licActual();
    if (!l) return "No hay nada que copiar.";
    const r = await crearLicitacion({
      nombre: recortar(`${l.nombre} (copia)`, 200), cliente_id: l.cliente_id, cliente_nombre: l.cliente_nombre,
      codigo: l.codigo, objeto: l.objeto, atencion: l.atencion, fecha_consultas: l.fecha_consultas,
      fecha_presentacion: l.fecha_presentacion, hora_presentacion: l.hora_presentacion,
      fecha_inicio_servicio: l.fecha_inicio_servicio, plazo_meses: l.plazo_meses, estado: l.estado,
    }, l.doc);
    if (!r.ok) return r.error;
    olvidarCambios();
    aviso(`Tus cambios quedaron en la licitación N° ${r.lic.id}, «${r.lic.nombre}».`);
    router.push(`/licitaciones/${r.lic.id}?paso=${paso}`);
    return null;
  }, [licActual, olvidarCambios, aviso, router, paso]);

  // ── Desarchivar ──
  const [desarchivando, setDesarchivando] = useState(false);
  const desarchivar = useCallback(async () => {
    setDesarchivando(true);
    const r = await archivarLicitacion(id, false);
    setDesarchivando(false);
    if (!r.ok) { aviso(r.error, "error"); return; }
    ajustarGuardada((l) => ({ ...l, archivada: r.archivada, version: r.version, actualizado_en: r.actualizado_en }));
    aviso("Licitación desarchivada: ya se puede editar.");
  }, [id, ajustarGuardada, aviso]);

  // ── Guardar a mano: botón y Ctrl+S ──
  const hayConflicto = !!edicion.conflicto;
  const guardarYa = useCallback(async () => {
    const ok = await guardarAhora();
    if (!ok && hayConflicto) setModalConflicto(true);
  }, [guardarAhora, hayConflicto]);

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") { e.preventDefault(); void guardarYa(); }
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [guardarYa]);

  // ── Salir con algo pendiente ──
  // Un análisis en pantalla sin aplicar ya no avisa: quedó guardado y se puede retomar sin volver a pagar.
  // Una lectura EN CURSO sí: se cobra igual y, si se corta, puede no llegar a guardarse.
  const hayQueAvisarAlSalir = edicion.pendiente || tiendaIA.fase !== "inactivo";
  useEffect(() => {
    if (!hayQueAvisarAlSalir) return;
    const antes = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", antes);
    return () => window.removeEventListener("beforeunload", antes);
  }, [hayQueAvisarAlSalir]);

  // ── Reloj para «guardado hace…» y los días que faltan ──
  const [ahora, setAhora] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setAhora(Date.now());
    const t0 = setTimeout(tick, 0);
    const t = setInterval(tick, 20_000);
    return () => { clearTimeout(t0); clearInterval(t); };
  }, []);

  // ── Cabecera fija (el documento es el que scrollea: un sticky dentro de <main> no se pega) ──
  const contRef = useRef<HTMLDivElement | null>(null);
  const cabRef = useRef<HTMLDivElement | null>(null);
  const [caja, setCaja] = useState<{ left: number; width: number; alto: number } | null>(null);
  const hayEditor = carga.fase === "ok";
  useLayoutEffect(() => {
    const c = contRef.current, h = cabRef.current;
    if (!hayEditor || !c || !h) return;
    const medir = () => {
      const r = c.getBoundingClientRect();
      const alto = h.offsetHeight;
      altoCabecera.current = alto;
      setCaja((p) => (p && p.left === r.left && p.width === r.width && p.alto === alto ? p : { left: r.left, width: r.width, alto }));
    };
    const ro = new ResizeObserver(() => medir());
    ro.observe(c); ro.observe(h);
    window.addEventListener("resize", medir);
    return () => { ro.disconnect(); window.removeEventListener("resize", medir); };
  }, [hayEditor]);

  const extra = useMemo<EditorExtra>(() => ({
    fase: edicion.fase, pendiente: edicion.pendiente, errorGuardado: edicion.error, guardarAhora, ancla,
  }), [edicion.fase, edicion.pendiente, edicion.error, guardarAhora, ancla]);

  // ══ Pantallas de espera y de error ══
  if (validando || (permitido && carga.fase === "cargando")) {
    return <main className="p-4 md:p-6"><p className="text-sm text-gray-500">{validando ? "Comprobando permiso…" : "Abriendo la licitación…"}</p></main>;
  }
  if (!permitido) {
    return <main className="p-4 md:p-6"><p className="text-sm text-gray-600">Esta pantalla necesita el permiso del módulo «Licitaciones» (lo da un administrador en Usuarios).</p></main>;
  }
  if (carga.fase === "error" || !lic || !guardada) {
    const e = carga.fase === "error" ? carga : null;
    return (
      <main className="p-4 md:p-6 space-y-3 max-w-3xl">
        <Link href="/licitaciones" className="text-sm font-bold text-[#0b315f] hover:underline">← Licitaciones</Link>
        {e?.sinMigracion ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <p className="font-bold">Falta correr una migración</p>
            <p className="mt-1">{e.error}</p>
            <p className="mt-1 text-xs">Archivo: <code className="font-mono">{e.sinMigracion}</code> (Supabase → SQL Editor; el deploy no corre las migraciones).</p>
          </div>
        ) : e?.noExiste ? (
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
            <p className="font-bold">No se encontró la licitación</p>
            <p className="mt-1">{e.error}</p>
            <Link href="/licitaciones" className="inline-block mt-2 font-bold text-[#0b315f] underline">Ir a la lista de licitaciones</Link>
          </div>
        ) : (
          <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
            <p className="font-bold">{e?.sinPermiso ? "Sin permiso" : "No se pudo abrir la licitación"}</p>
            <p className="mt-1">{e?.error ?? "No se pudo leer la licitación."}</p>
            {!e?.sinPermiso && <button type="button" onClick={() => window.location.reload()} className="mt-2 px-3 py-1.5 rounded-lg border border-red-300 bg-white text-xs font-bold">Reintentar</button>}
          </div>
        )}
      </main>
    );
  }

  // ══ El editor ══
  const props: PasoProps = {
    lic, doc: lic.doc, cambiarDoc, cambiarColumnas, ctx, ctxCargando, recargarCtx, revision: rev.revision,
    irA, soloLectura, nuevoId: nuevoUuid, aviso,
  };
  const est = ETIQUETA_ESTADO[lic.estado];
  const hoy = ahora != null ? fechaLima(ahora) : null;
  const dias = hoy && lic.fecha_presentacion ? diasISO(hoy, lic.fecha_presentacion) : null;
  const textoDias = dias == null ? null : dias > 1 ? `faltan ${dias} días` : dias === 1 ? "es mañana" : dias === 0 ? "es hoy" : `pasó hace ${-dias} día${dias === -1 ? "" : "s"}`;
  const colorDias = dias == null ? "#6b7280" : dias < 0 && lic.estado === "preparacion" ? "#991b1b" : dias <= 3 && dias >= 0 ? "#92400e" : "#6b7280";

  return (
    <ProveedorEditorExtra value={extra}>
      <ProveedorIA value={tiendaIA}>
        <main className="p-3 md:p-6">
          <div ref={contRef} className="max-w-6xl mx-auto min-w-0">
            {/* ── Cabecera ── */}
            <div
              ref={cabRef}
              style={caja ? { position: "fixed", top: 0, left: caja.left, width: caja.width } : undefined}
              className="z-20 bg-white/95 backdrop-blur border-b border-gray-200 shadow-sm px-3 pt-2 pb-1.5 md:rounded-b-2xl"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <Link href="/licitaciones" className="font-bold text-[#0b315f] hover:underline">← Licitaciones</Link>
                    <span className="text-gray-400">N° {lic.id}</span>
                    <span className="font-bold px-2 py-0.5 rounded-lg" style={{ color: est.color, background: est.bg }}>{est.texto}</span>
                    {lic.archivada && <span className="font-bold px-2 py-0.5 rounded-lg bg-gray-200 text-gray-700">Archivada</span>}
                  </div>
                  <h1 className="text-base md:text-xl font-bold text-gray-900 truncate mt-0.5" title={lic.nombre}>{lic.nombre || "Licitación sin nombre"}</h1>
                  <p className="text-[11px] md:text-xs text-gray-500 truncate">
                    {lic.cliente_nombre || "Sin cliente"}
                    {lic.codigo ? ` · ${lic.codigo}` : ""}
                    {" · Presentación: "}
                    {lic.fecha_presentacion ? `${fechaDMY(lic.fecha_presentacion)}${lic.hora_presentacion ? ` ${lic.hora_presentacion}` : ""}` : "sin fecha"}
                    {textoDias && <span className="font-bold" style={{ color: colorDias }}> ({textoDias})</span>}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <IndicadorGuardado fase={edicion.fase} guardadoEn={edicion.guardadoEn} ahora={ahora} error={edicion.error} />
                  <button
                    type="button"
                    onClick={() => void guardarYa()}
                    disabled={soloLectura || !!edicion.conflicto || edicion.fase === "guardando" || (!edicion.pendiente && edicion.fase !== "error")}
                    title="Guardar ahora (Ctrl+S)"
                    className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-[#0b315f] hover:opacity-90 disabled:opacity-40"
                  >
                    {edicion.fase === "error" ? "Reintentar" : "Guardar"}
                  </button>
                </div>
              </div>
              {/* Pestañas */}
              <nav className="mt-1.5 grid grid-cols-5 gap-1" aria-label="Pasos de la licitación">
                {PASOS.map((p) => {
                  const e = ETIQUETA_PASO[p];
                  const c = porPaso[p];
                  const activo = p === paso;
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => { cambiarPaso(p); window.scrollTo({ top: 0 }); }}
                      aria-current={activo ? "page" : undefined}
                      className={`rounded-lg px-0.5 sm:px-1 py-1.5 font-bold border transition-colors min-w-0 ${activo ? "bg-[#0b315f] text-white border-[#0b315f]" : "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"}`}
                    >
                      <span className="block truncate text-[10px] sm:text-[11px] md:text-xs"><span className="opacity-70 hidden sm:inline">{e.n} </span><span className="hidden md:inline">{e.largo}</span><span className="md:hidden">{e.corto}</span></span>
                      <span className="flex justify-center gap-1 mt-0.5 min-h-[14px]">
                        {rev.revision == null
                          ? <span className={`text-[9px] font-normal ${activo ? "text-white/70" : "text-gray-400"}`}>{ctxCargando ? "…" : ""}</span>
                          : <>
                              {c.alarma > 0 && <span className="text-[9px] px-1 rounded bg-red-600 text-white" title={`${c.alarma} alarma(s) en este paso`}>{c.alarma}</span>}
                              {c.aviso > 0 && <span className="text-[9px] px-1 rounded bg-amber-400 text-amber-950" title={`${c.aviso} aviso(s) en este paso`}>{c.aviso}</span>}
                            </>}
                      </span>
                    </button>
                  );
                })}
              </nav>
            </div>
            {caja && <div style={{ height: caja.alto }} aria-hidden="true" />}

            {/* ── Franjas de estado ── */}
            <div className="space-y-2 mt-3">
              {lic.archivada && (
                <div className="rounded-xl border border-gray-300 bg-gray-100 px-4 py-2.5 text-sm text-gray-700 flex items-center justify-between gap-3 flex-wrap">
                  <span>Esta licitación está <b>archivada</b>: se ve en solo lectura. Para editarla, desarchívala.</span>
                  <button type="button" disabled={desarchivando} onClick={() => void desarchivar()} className="px-3 py-1.5 rounded-lg border border-gray-400 bg-white text-xs font-bold hover:bg-gray-50 disabled:opacity-50">
                    {desarchivando ? "Desarchivando…" : "Desarchivar"}
                  </button>
                </div>
              )}
              {edicion.sinPermiso && (
                <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800">
                  La base no deja guardar con tu usuario: la pantalla pasó a solo lectura. {edicion.error}
                </div>
              )}
              {edicion.fase === "error" && !edicion.sinPermiso && edicion.error && (
                <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800">
                  <b>No se guardó.</b> {edicion.error} Se reintenta con el próximo cambio, o pulsa «Reintentar».
                </div>
              )}
              {edicion.conflicto && !modalConflicto && (
                <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800 flex items-center justify-between gap-3 flex-wrap">
                  <span><b>{edicion.conflicto.por || "Otra persona"}</b> guardó esta licitación mientras editabas: el guardado automático está detenido y tus cambios aún no están en la base.</span>
                  <button type="button" onClick={() => setModalConflicto(true)} className="px-3 py-1.5 rounded-lg border border-red-300 bg-white text-xs font-bold hover:bg-red-100">Decidir qué hacer</button>
                </div>
              )}
              {ctxError && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900 flex items-center justify-between gap-3 flex-wrap">
                  <span>No se pudo leer lo que el ERP sabe de esta licitación ({ctxError}). {ctx ? "La revisión usa la última lectura." : "Mientras tanto no se calcula la revisión: nada se da por cumplido ni por faltante."}</span>
                  <button type="button" onClick={() => void leerCtx()} className="px-3 py-1.5 rounded-lg border border-amber-300 bg-white text-xs font-bold">Reintentar</button>
                </div>
              )}
              {rev.error && (
                <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
                  La revisión falló al calcularse ({rev.error}). Los pasos se pueden editar igual; avisa a soporte con este detalle.
                </div>
              )}
            </div>

            {/* ── El paso ── */}
            <div className="mt-3">
              <LimitePaso nombre={ETIQUETA_PASO[paso].largo} reintentoClave={paso}>
                {paso === "bases" && <PasoBases {...props} />}
                {paso === "recursos" && <PasoRecursos {...props} />}
                {paso === "contenido" && <PasoContenido {...props} />}
                {paso === "expediente" && <PasoExpediente {...props} />}
                {paso === "revision" && <PasoRevision {...props} />}
              </LimitePaso>
            </div>
          </div>

          {/* ── Conflicto ── */}
          {edicion.conflicto && modalConflicto && (
            <ModalConflicto
              conflicto={edicion.conflicto}
              nombre={lic.nombre}
              onRecargar={recargarVersion}
              onCopia={guardarCopia}
              onCerrar={() => setModalConflicto(false)}
            />
          )}

          {/* ── Avisos ── */}
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 space-y-2 w-[min(92vw,420px)] pointer-events-none" aria-live="polite">
            {toasts.map((t) => (
              <div key={t.id} className={`pointer-events-auto rounded-xl px-4 py-2.5 text-sm shadow-lg border ${t.tono === "error" ? "bg-red-50 border-red-300 text-red-800" : t.tono === "aviso" ? "bg-amber-50 border-amber-300 text-amber-900" : "bg-emerald-50 border-emerald-300 text-emerald-900"}`}>
                <div className="flex items-start gap-2">
                  <span className="flex-1">{t.texto}</span>
                  <button type="button" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="text-xs opacity-60 hover:opacity-100" aria-label="Cerrar aviso">✕</button>
                </div>
              </div>
            ))}
          </div>
        </main>
      </ProveedorIA>
    </ProveedorEditorExtra>
  );
}

function IndicadorGuardado({ fase, guardadoEn, ahora, error }: { fase: FaseGuardado; guardadoEn: number | null; ahora: number | null; error: string | null }) {
  const base = "text-[11px] font-bold whitespace-nowrap";
  switch (fase) {
    case "guardando": return <span className={`${base} text-gray-500`}>Guardando…</span>;
    case "sin_guardar": return <span className={`${base} text-amber-700`}>Sin guardar</span>;
    case "error": return <span className={`${base} text-red-700`} title={error ?? undefined}>No se guardó</span>;
    case "conflicto": return <span className={`${base} text-red-700`}>Conflicto: no se guarda</span>;
    case "solo_lectura": return <span className={`${base} text-gray-500`}>Solo lectura</span>;
    default: return <span className={`${base} text-emerald-700`}>{guardadoEn && ahora ? `Guardado ${haceCuanto(guardadoEn, ahora)}` : "Guardado"}</span>;
  }
}
