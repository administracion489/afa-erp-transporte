"use client";
// components/licitaciones/editor/useEdicionLicitacion.ts — El estado de edición de UNA licitación y su
// GUARDADO AUTOMÁTICO con bloqueo optimista (decisión R1 de lib/licitaciones/datos.ts).
//
//  · La pantalla guarda la ÚLTIMA versión guardada (`guardada`) y, aparte, las columnas y el doc EN
//    EDICIÓN. Cada cambio sube un contador y anota en qué número se tocó cada columna (y el doc); un
//    guardado manda SOLO lo tocado desde el último guardado bueno.
//  · Antirrebote de RETRASO_GUARDADO_MS tras el último cambio. NUNCA dos guardados a la vez: si hay uno
//    en vuelo, se encola UNO más (que manda lo que haya cambiado mientras tanto).
//  · Guardado bueno sin cambios nuevos en vuelo → se adopta lo que devolvió la base (el doc ya pasó por
//    normalizarDoc: lo que se ve es lo que quedó guardado). Con cambios nuevos, se conservan los locales.
//  · Conflicto (otra persona guardó) → el guardado automático SE DETIENE y queda `conflicto`. No se
//    fusiona nada: recargar descarta lo local; «guardar como copia» lo lleva a otra licitación.
//  · Al desmontar con cambios pendientes (navegar a otra pantalla antes del antirrebote) se manda un
//    último guardado sin esperar respuesta.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { guardarLicitacion, type CambiosLicitacion } from "@/lib/licitaciones/datos";
import { COLUMNAS_EDITABLES, type DocLicitacion, type InstanteISO, type Licitacion } from "@/lib/licitaciones/tipos";
import type { ColumnasLic } from "./contrato-editor";
import type { FaseGuardado } from "./contexto-editor";

export type ColumnaFila = Exclude<(typeof COLUMNAS_EDITABLES)[number], "doc">;
export type Columnas = Pick<Licitacion, ColumnaFila>;
/** Las que viajan en el guardado. `archivada` NO: se cambia con archivarLicitacion. */
const CLAVES_GUARDADO = COLUMNAS_EDITABLES.filter((k): k is Exclude<ColumnaFila, "archivada"> => k !== "doc" && k !== "archivada");
const CLAVES_COLUMNAS = COLUMNAS_EDITABLES.filter((k): k is ColumnaFila => k !== "doc");

export const RETRASO_GUARDADO_MS = 3000;

export function columnasDe(l: Licitacion): Columnas {
  const o: Record<string, unknown> = {};
  for (const k of CLAVES_COLUMNAS) o[k] = l[k];
  return o as Columnas;
}

export type Conflicto = { version: number; por: string | null; porId: string | null; en: InstanteISO };

type Tocado = { cols: Partial<Record<ColumnaFila, number>>; doc: number };
type ResultadoVuelta = "ok" | "detener";

export type Edicion = {
  guardada: Licitacion | null;
  /** La licitación en edición: columnas + doc en edición; `id` y `version` de la última guardada. */
  lic: Licitacion | null;
  fase: FaseGuardado;
  error: string | null;
  sinPermiso: boolean;
  conflicto: Conflicto | null;
  guardadoEn: number | null;
  /** Hay cambios que la base no tiene (sin guardar, en vuelo o fallidos). */
  pendiente: boolean;
  cargar: (l: Licitacion) => void;
  cambiarDoc: (fn: (d: DocLicitacion) => DocLicitacion) => void;
  cambiarColumnas: (c: ColumnasLic) => void;
  guardarAhora: () => Promise<boolean>;
  /** Para las acciones que cambian la fila por otra vía (desarchivar): adopta versión y columnas. */
  ajustarGuardada: (fn: (l: Licitacion) => Licitacion) => void;
  /** Archivada, o la base dijo que el usuario no puede escribir: no se aceptan cambios ni se guarda. */
  soloLectura: boolean;
  /** La licitación en edición leída de las refs (para callbacks: no depende del último render). */
  licActual: () => Licitacion | null;
  /** Da por guardado todo lo local (tras «guardar como copia»: lo local ya vive en otra fila). */
  olvidarCambios: () => void;
};

const iguales = (a: unknown, b: unknown) => a === b || (a == null && b == null);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

export function useEdicionLicitacion(): Edicion {
  const [guardada, setGuardada] = useState<Licitacion | null>(null);
  const [cols, setCols] = useState<Columnas | null>(null);
  const [doc, setDoc] = useState<DocLicitacion | null>(null);
  const [nCambio, setNCambio] = useState(0);
  const [nGuardado, setNGuardado] = useState(0);
  const [fase, setFase] = useState<FaseGuardado>("guardado");
  const [error, setError] = useState<string | null>(null);
  const [sinPermiso, setSinPermiso] = useState(false);
  const [conflicto, setConflicto] = useState<Conflicto | null>(null);
  const [guardadoEn, setGuardadoEn] = useState<number | null>(null);

  const guardadaRef = useRef<Licitacion | null>(null);
  const colsRef = useRef<Columnas | null>(null);
  const docRef = useRef<DocLicitacion | null>(null);
  const cambioN = useRef(0);
  const guardadoN = useRef(0);
  const tocado = useRef<Tocado>({ cols: {}, doc: 0 });
  const enVuelo = useRef<Promise<void> | null>(null);
  const otraVuelta = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detenido = useRef(false);        // conflicto: no se guarda más
  const soloLectura = !!guardada?.archivada || sinPermiso;
  const soloRef = useRef(false);

  useEffect(() => { soloRef.current = soloLectura; }, [soloLectura]);

  const fijarGuardadoN = useCallback((n: number) => { guardadoN.current = n; setNGuardado(n); }, []);

  const cargar = useCallback((l: Licitacion) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    guardadaRef.current = l; setGuardada(l);
    const c = columnasDe(l); colsRef.current = c; setCols(c);
    docRef.current = l.doc; setDoc(l.doc);
    tocado.current = { cols: {}, doc: 0 };
    fijarGuardadoN(cambioN.current);
    setNCambio(cambioN.current);
    detenido.current = false;
    setConflicto(null); setError(null); setSinPermiso(false);
    setFase("guardado");
  }, [fijarGuardadoN]);

  const marcar = useCallback((claves: (ColumnaFila | "doc")[]) => {
    const n = ++cambioN.current;
    for (const k of claves) {
      if (k === "doc") tocado.current.doc = n;
      else tocado.current.cols[k] = n;
    }
    setNCambio(n);
    setFase((f) => (f === "guardando" || f === "conflicto" || f === "solo_lectura" ? f : "sin_guardar"));
  }, []);

  const cambiarDoc = useCallback((fn: (d: DocLicitacion) => DocLicitacion) => {
    if (soloRef.current) return;
    const prev = docRef.current;
    if (!prev) return;
    const next = fn(prev);
    if (!next || next === prev) return;
    docRef.current = next;
    setDoc(next);
    marcar(["doc"]);
  }, [marcar]);

  const cambiarColumnas = useCallback((c: ColumnasLic) => {
    if (soloRef.current) return;
    const prev = colsRef.current;
    if (!prev) return;
    const tocadas: ColumnaFila[] = [];
    const next: Record<string, unknown> = { ...prev };
    for (const k of CLAVES_GUARDADO) {
      if (!Object.prototype.hasOwnProperty.call(c, k)) continue;
      const v = (c as Record<string, unknown>)[k];
      if (iguales(v, (prev as Record<string, unknown>)[k])) continue;
      next[k] = v;
      tocadas.push(k);
    }
    if (!tocadas.length) return;
    colsRef.current = next as Columnas;
    setCols(next as Columnas);
    marcar(tocadas);
  }, [marcar]);

  /** UN guardado: lo tocado desde el último bueno. */
  const unaVuelta = useCallback(async (): Promise<ResultadoVuelta> => {
    const g = guardadaRef.current;
    const c = colsRef.current;
    const d = docRef.current;
    if (!g || !c || !d) return "detener";
    const n = cambioN.current;
    const base = guardadoN.current;
    const cambios: CambiosLicitacion = {};
    const salida = cambios as Record<string, unknown>;
    for (const k of CLAVES_GUARDADO) if ((tocado.current.cols[k] ?? 0) > base) salida[k] = c[k];
    if (tocado.current.doc > base) cambios.doc = d;
    if (!Object.keys(cambios).length) {
      fijarGuardadoN(n);
      setFase((f) => (f === "conflicto" || f === "solo_lectura" ? f : "guardado"));
      return "ok";
    }
    setFase("guardando");
    let r: Awaited<ReturnType<typeof guardarLicitacion>>;
    try { r = await guardarLicitacion(g, cambios); }
    catch (e) { r = { ok: false, conflicto: false, error: `No se pudo guardar (${msg(e) || "error inesperado"}).` }; }
    if (r.ok) {
      guardadaRef.current = r.lic; setGuardada(r.lic);
      fijarGuardadoN(n);
      setError(null); setSinPermiso(false);
      setGuardadoEn(Date.now());
      if (cambioN.current === n) {
        docRef.current = r.lic.doc; setDoc(r.lic.doc);
        const nc = columnasDe(r.lic); colsRef.current = nc; setCols(nc);
        setFase("guardado");
      } else {
        setFase("sin_guardar");
      }
      return "ok";
    }
    if (r.conflicto) {
      detenido.current = true;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      setConflicto({ version: r.version, por: r.por, porId: r.porId, en: r.en });
      setFase("conflicto");
      return "detener";
    }
    setError(r.error);
    setSinPermiso(r.sinPermiso === true);
    setFase("error");
    return "detener";
  }, [fijarGuardadoN]);

  const ejecutar = useCallback(async (): Promise<void> => {
    if (enVuelo.current) { otraVuelta.current = true; return enVuelo.current; }
    const p = (async () => {
      for (;;) {
        otraVuelta.current = false;
        if (detenido.current || soloRef.current) return;
        const r = await unaVuelta();
        if (r !== "ok" || !otraVuelta.current) return;
      }
    })();
    enVuelo.current = p;
    try { await p; } finally { enVuelo.current = null; }
  }, [unaVuelta]);

  // Antirrebote: cada cambio reprograma el guardado.
  useEffect(() => {
    if (nCambio <= guardadoN.current || detenido.current || soloRef.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void ejecutar(); }, RETRASO_GUARDADO_MS);
  }, [nCambio, ejecutar]);

  const guardarAhora = useCallback(async (): Promise<boolean> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (detenido.current || soloRef.current) return false;
    if (cambioN.current > guardadoN.current || enVuelo.current) await ejecutar();
    return cambioN.current === guardadoN.current && !detenido.current;
  }, [ejecutar]);

  const ajustarGuardada = useCallback((fn: (l: Licitacion) => Licitacion) => {
    const g = guardadaRef.current;
    if (!g) return;
    const n = fn(g);
    guardadaRef.current = n; setGuardada(n);
    const c = colsRef.current;
    if (c) { const nc = { ...c, archivada: n.archivada }; colsRef.current = nc; setCols(nc); }
  }, []);

  const licActual = useCallback((): Licitacion | null => {
    const g = guardadaRef.current, c = colsRef.current, d = docRef.current;
    return g && c && d ? { ...g, ...c, doc: d } : null;
  }, []);

  const olvidarCambios = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    detenido.current = true;
    fijarGuardadoN(cambioN.current);
  }, [fijarGuardadoN]);

  // Al desmontar: lo pendiente se manda sin esperar (salvo conflicto o solo lectura).
  useEffect(() => () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const salir = () => {
      if (detenido.current || soloRef.current || cambioN.current <= guardadoN.current) return;
      const g = guardadaRef.current, c = colsRef.current, d = docRef.current;
      if (!g || !c || !d) return;
      const base = guardadoN.current;
      const cambios: CambiosLicitacion = {};
      const salida = cambios as Record<string, unknown>;
      for (const k of CLAVES_GUARDADO) if ((tocado.current.cols[k] ?? 0) > base) salida[k] = c[k];
      if (tocado.current.doc > base) cambios.doc = d;
      if (Object.keys(cambios).length) void guardarLicitacion(g, cambios).catch(() => undefined);
    };
    const vuelo = enVuelo.current;
    if (vuelo) void vuelo.then(salir, salir); else salir();
  }, []);

  const lic = useMemo<Licitacion | null>(() => (guardada && cols && doc ? { ...guardada, ...cols, doc } : null), [guardada, cols, doc]);
  const faseFinal: FaseGuardado = soloLectura && fase !== "error" ? "solo_lectura" : fase;
  const pendiente = nCambio > nGuardado || fase === "guardando";

  return {
    guardada, lic, fase: faseFinal, error, sinPermiso, conflicto, guardadoEn, pendiente, soloLectura,
    cargar, cambiarDoc, cambiarColumnas, guardarAhora, ajustarGuardada, licActual, olvidarCambios,
  };
}
