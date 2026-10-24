"use client";
// components/licitaciones/editor/analisis-ia.tsx — La lectura de las bases con IA, en la MEMORIA DEL
// EDITOR (no del paso): una lectura tarda de 1 a 3 minutos y el operador puede cambiar de pestaña
// mientras tanto; si el estado viviera en PasoBases, al desmontarse se perdería.
//
// Flujo de `leer`: (1) guardar lo pendiente — el servidor lee las bases de la FILA guardada, nunca del
// cuerpo —; (2) estimar (count_tokens, no se cobra) → confirm() que NOMBRA el costo máximo; (3) leer.
// Nunca dos a la vez. La IA PROPONE: nada de lo que devuelve entra al doc sin un clic (RevisarAnalisis).
//
// RETOMAR: el servidor guarda cada análisis listo (licitacion_analisis). Al montar, si la memoria no tiene
// uno, se pregunta por el último (ultimoAnalisis, ya normalizado) y se ofrece retomarlo SIN volver a pagar;
// se carga exactamente como uno recién leído, con su id (para doc.analisis.aplicadoId). Si esa consulta
// falla no se rompe nada: solo no se ofrece retomar, y la pantalla lo dice.
//
// ETIQUETAS A1, A2…: el servidor etiqueta solo los archivos que de verdad LEYÓ (un PDF protegido se salta
// y corre las etiquetas). Recién leído no se sabe cuál se omitió (la respuesta lo dice en un aviso de
// texto): con algún `archivo_omitido` no se afirma ninguna etiqueta. Retomado, la fila dice cuáles.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { cabecerasErp } from "@/lib/fetch-erp";
import { ultimoAnalisis, type AnalisisGuardado } from "@/lib/licitaciones/datos";
import { TOPES_ANALISIS, etiquetaArchivo, type RespuestaRutaAnalisis } from "@/lib/licitaciones/analisis";
import type { AnalisisBases, AvisoAnalisis, EntradaAnalisis } from "@/lib/licitaciones/tipos";

export type FaseIA = "inactivo" | "guardando" | "estimando" | "analizando";

export type EstimacionIA = { tokensEntrada: number; paginas: number; costoUsdMax: number | null; archivos: number; conTexto: boolean };

export type ArchivoAnalisis = {
  id: string;
  /** Nombre con que se leyó (el del momento del análisis); el de hoy se busca en doc.bases. */
  nombre: string | null;
  /** A1, A2… si se sabe; null si no se puede afirmar (ver la cabecera). */
  etiqueta: string | null;
  /** Por qué no se leyó (pdf_protegido, pdf_ilegible, no_descargado…); null = se leyó o no se sabe. */
  omitido: string | null;
};

export type ResultadoIA = {
  analisisId: number;
  /** «lectura» = recién leído en esta pantalla · «guardado» = retomado de licitacion_analisis. */
  origen: "lectura" | "guardado";
  resultado: AnalisisBases;
  avisos: AvisoAnalisis[];
  /** Tokens: null si no se saben (un análisis retomado solo guarda su costo). */
  uso: { tokensEntrada: number | null; tokensSalida: number | null; costoUsd: number | null };
  archivos: ArchivoAnalisis[];
  conTexto: boolean | null;
  /** Instante (ms) en que se leyó. */
  en: number;
  porNombre: string | null;
};

export type ErrorIA = { codigo: string; texto: string; reintentarHasta: number | null };

/** El último análisis guardado, para «Retomar». */
export type Retomable =
  | { estado: "comprobando" }
  | { estado: "ninguno" }
  | { estado: "error"; texto: string }
  | { estado: "listo"; analisis: AnalisisGuardado };

export type TiendaIA = {
  fase: FaseIA;
  inicio: number | null;
  estimacion: EstimacionIA | null;
  resultado: ResultadoIA | null;
  error: ErrorIA | null;
  /** El operador ya pasó algo del resultado al doc. */
  aplicado: boolean;
  retomable: Retomable;
  /** Se puede volver a abrir el último análisis después de cerrarlo (la consulta funciona). */
  puedeRetomar: boolean;
  leer: (archivoIds: string[], texto: string | null) => Promise<void>;
  retomar: () => void;
  descartar: () => void;
  limpiarError: () => void;
  marcarAplicado: () => void;
};

const Contexto = createContext<TiendaIA | null>(null);
export const ProveedorIA = Contexto.Provider;
export function useTiendaIA(): TiendaIA | null { return useContext(Contexto); }

/** Plazo del navegador: la ruta vive 300 s; pasado esto, la conexión se da por perdida. */
const PLAZO_NAVEGADOR_MS = 330_000;

type Respuesta = RespuestaRutaAnalisis | { ok: false; codigo: "red" | "sin_respuesta"; error: string };

const MSG_PERMISO = "Hace falta el permiso del módulo «Licitaciones» (lo da un administrador en Usuarios).";
const MSG_RETOMAR = "Si la lectura llegó a terminar en el servidor, quedó guardada: búscala en «Retomar el análisis» de este panel.";

async function llamar(cuerpo: EntradaAnalisis, señal: AbortSignal): Promise<Respuesta> {
  let res: Response;
  try {
    res = await fetch("/api/licitaciones/analizar", {
      method: "POST", headers: await cabecerasErp(), body: JSON.stringify(cuerpo), signal: señal, cache: "no-store",
    });
  } catch {
    if (señal.aborted) {
      return { ok: false, codigo: "sin_respuesta", error: `El servidor no respondió en más de 5 minutos y esta pantalla dejó de esperar. ${MSG_RETOMAR}` };
    }
    return { ok: false, codigo: "red", error: "No hay conexión con el servidor: revisa tu red y vuelve a intentarlo." };
  }
  let j: unknown = null;
  try { j = await res.json(); } catch { j = null; }
  if (j && typeof j === "object" && "ok" in j) {
    const r = j as RespuestaRutaAnalisis;
    if (!r.ok && r.codigo === "sin_permiso") return { ...r, error: `${r.error} ${MSG_PERMISO}` };
    return r;
  }
  if (res.status === 401 || res.status === 403) return { ok: false, codigo: "sin_permiso", error: `Tu sesión venció o no tiene permiso para leer las bases con IA. ${MSG_PERMISO}` };
  if (res.status === 504 || res.status === 502) return { ok: false, codigo: "sin_respuesta", error: `La lectura tardó más de lo que el servidor permite y se cortó la respuesta. ${MSG_RETOMAR} Si no aparece, elige menos archivos (o solo las secciones de requisitos) y vuelve a intentarlo.` };
  return { ok: false, codigo: "sin_respuesta", error: `El servidor respondió ${res.status} sin explicación. Vuelve a intentarlo en un momento.` };
}

const usd = (n: number) => `US$ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Un análisis guardado como resultado de la pantalla (idéntico a uno recién leído, con su id). */
export function resultadoDeGuardado(a: AnalisisGuardado): ResultadoIA {
  let i = 0;
  const archivos: ArchivoAnalisis[] = a.archivos.map((x) => ({
    id: x.id, nombre: x.nombre, omitido: x.omitido, etiqueta: x.omitido == null ? etiquetaArchivo(i++) : null,
  }));
  const en = Date.parse(a.terminado_en ?? a.creado_en);
  return {
    analisisId: a.id, origen: "guardado", resultado: a.resultado, avisos: a.avisos,
    uso: { tokensEntrada: null, tokensSalida: null, costoUsd: a.costo_usd },
    archivos, conTexto: null, en: Number.isFinite(en) ? en : 0, porNombre: a.usuario_nombre,
  };
}

/**
 * La tienda de la lectura con IA de UNA licitación. Vive en el editor; `guardarAhora` es la del editor.
 * `licId` es el id de la fila (no cambia mientras el editor esté montado).
 */
export function useLecturaIA(licId: number | null, guardarAhora: () => Promise<boolean>): TiendaIA {
  const [fase, setFase] = useState<FaseIA>("inactivo");
  const [inicio, setInicio] = useState<number | null>(null);
  const [estimacion, setEstimacion] = useState<EstimacionIA | null>(null);
  const [resultado, setResultado] = useState<ResultadoIA | null>(null);
  const [error, setError] = useState<ErrorIA | null>(null);
  const [aplicado, setAplicado] = useState(false);
  const [retomable, setRetomable] = useState<Retomable>({ estado: "comprobando" });
  const [nConsulta, setNConsulta] = useState(0);
  const enCurso = useRef(false);

  // El último análisis guardado (al montar, y otra vez tras una lectura que terminó o se cortó).
  useEffect(() => {
    if (licId == null) return;
    let vivo = true;
    (async () => {
      try {
        const r = await ultimoAnalisis(licId);
        if (!vivo) return;
        if (!r.ok) { setRetomable({ estado: "error", texto: r.error }); return; }
        const a = r.analisis;
        setRetomable(a ? { estado: "listo", analisis: a } : { estado: "ninguno" });
        // El recién leído es este mismo: la fila dice cuáles se omitieron, así que ahora sí hay etiquetas.
        if (a) {
          setResultado((prev) => (prev && prev.origen === "lectura" && prev.analisisId === a.id
            ? { ...prev, archivos: resultadoDeGuardado(a).archivos, porNombre: prev.porNombre ?? a.usuario_nombre }
            : prev));
        }
      } catch (e) {
        if (vivo) setRetomable({ estado: "error", texto: e instanceof Error ? e.message : String(e ?? "error") });
      }
    })();
    return () => { vivo = false; };
  }, [licId, nConsulta]);

  const fallo = useCallback((r: { codigo: string; error: string; reintentarEnSeg?: number }) => {
    const seg = typeof r.reintentarEnSeg === "number" && r.reintentarEnSeg > 0 ? r.reintentarEnSeg : null;
    setError({ codigo: r.codigo, texto: r.error, reintentarHasta: seg ? Date.now() + seg * 1000 : null });
  }, []);

  const leer = useCallback(async (archivoIds: string[], texto: string | null) => {
    if (enCurso.current || licId == null) return;
    const ids = [...new Set(archivoIds)];
    const t = texto && texto.trim() ? texto.trim() : null;
    if (!ids.length && !t) { setError({ codigo: "sin_archivos", texto: "Elige al menos un PDF de las bases o pega el texto de los requisitos.", reintentarHasta: null }); return; }
    if (ids.length > TOPES_ANALISIS.maxArchivos) { setError({ codigo: "entrada_invalida", texto: `La IA lee como máximo ${TOPES_ANALISIS.maxArchivos} archivos a la vez: desmarca alguno.`, reintentarHasta: null }); return; }
    enCurso.current = true;
    setError(null);
    let llegoAlModelo = false;
    try {
      // 1 · Lo guardado es lo que lee el servidor.
      setFase("guardando");
      const guardado = await guardarAhora();
      if (!guardado) {
        setError({ codigo: "no_guardado", texto: "No se pudo guardar la licitación, y la IA lee las bases desde lo guardado. Mira el aviso de guardado de arriba, corrígelo y vuelve a intentarlo.", reintentarHasta: null });
        return;
      }
      // 2 · Estimar y confirmar el costo.
      setFase("estimando");
      const ctrlE = new AbortController();
      const relojE = setTimeout(() => ctrlE.abort(), 60_000);
      const est = await llamar({ licitacion_id: licId, archivo_ids: ids, texto: t, estimar: true }, ctrlE.signal);
      clearTimeout(relojE);
      if (!est.ok) { fallo(est); return; }
      if (est.modo !== "estimacion") { setError({ codigo: "sin_respuesta", texto: "El servidor no devolvió la estimación del costo: no se leyó nada.", reintentarHasta: null }); return; }
      const e: EstimacionIA = { tokensEntrada: est.tokensEntrada, paginas: est.paginas, costoUsdMax: est.costoUsdMax, archivos: ids.length, conTexto: !!t };
      setEstimacion(e);
      const que = [ids.length ? `${ids.length} archivo${ids.length === 1 ? "" : "s"} PDF (${e.paginas} página${e.paginas === 1 ? "" : "s"})` : null, t ? "el texto pegado" : null].filter(Boolean).join(" y ");
      const costo = e.costoUsdMax == null
        ? "No se pudo calcular el costo máximo."
        : `Costará como máximo ${usd(e.costoUsdMax)} (se cobra aunque la lectura falle a mitad).`;
      const ok = window.confirm(
        `Leer con IA ${que}: unos ${e.tokensEntrada.toLocaleString("es-PE")} tokens de entrada.\n\n${costo}\n\nTarda de 1 a 3 minutos. La IA solo PROPONE: después revisas y aceptas cada punto.\n\n¿Leer las bases?`,
      );
      if (!ok) return;
      // 3 · Leer.
      setFase("analizando");
      setInicio(Date.now());
      llegoAlModelo = true;
      const ctrl = new AbortController();
      const reloj = setTimeout(() => ctrl.abort(), PLAZO_NAVEGADOR_MS);
      const r = await llamar({ licitacion_id: licId, archivo_ids: ids, texto: t, estimar: false }, ctrl.signal);
      clearTimeout(reloj);
      if (!r.ok) { fallo(r); return; }
      if (r.modo !== "analisis") { setError({ codigo: "sin_respuesta", texto: "El servidor no devolvió el análisis.", reintentarHasta: null }); return; }
      const avisos = r.avisos ?? [];
      const hayOmitidos = avisos.some((a) => a.codigo === "archivo_omitido");
      setResultado({
        analisisId: r.analisisId, origen: "lectura", resultado: r.resultado, avisos, uso: r.uso,
        archivos: ids.map((id, i) => ({ id, nombre: null, omitido: null, etiqueta: hayOmitidos ? null : etiquetaArchivo(i) })),
        conTexto: !!t, en: Date.now(), porNombre: null,
      });
      setAplicado(false);
    } finally {
      enCurso.current = false;
      setFase("inactivo");
      setInicio(null);
      // Lo leído (o lo que se cortó y pudo terminar en el servidor) queda como «último análisis».
      if (llegoAlModelo) setNConsulta((n) => n + 1);
    }
  }, [licId, guardarAhora, fallo]);

  const retomar = useCallback(() => {
    if (retomable.estado !== "listo" || enCurso.current) return;
    setResultado(resultadoDeGuardado(retomable.analisis));
    setAplicado(false);
    setError(null);
  }, [retomable]);

  const descartar = useCallback(() => { setResultado(null); setAplicado(false); }, []);
  const limpiarError = useCallback(() => setError(null), []);
  const marcarAplicado = useCallback(() => setAplicado(true), []);

  return {
    fase, inicio, estimacion, resultado, error, aplicado, retomable, puedeRetomar: retomable.estado === "listo",
    leer, retomar, descartar, limpiarError, marcarAplicado,
  };
}
