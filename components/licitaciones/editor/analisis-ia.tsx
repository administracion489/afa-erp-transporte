"use client";
// components/licitaciones/editor/analisis-ia.tsx — La lectura de las bases con IA, en la MEMORIA DEL
// EDITOR (no del paso): una lectura tarda de 1 a 3 minutos y el operador puede cambiar de pestaña
// mientras tanto; si el estado viviera en PasoBases, al desmontarse se perdería el resultado que ya
// se pagó. El resultado no se recupera de la base desde aquí: si se cierra la pantalla sin aplicarlo,
// hay que volver a leer las bases (y la pantalla lo dice).
//
// Flujo de `leer`: (1) guardar lo pendiente — el servidor lee las bases de la FILA guardada, nunca del
// cuerpo —; (2) estimar (count_tokens, no se cobra) → confirm() que NOMBRA el costo máximo; (3) leer.
// Nunca dos a la vez. La IA PROPONE: nada de lo que devuelve entra al doc sin un clic (RevisarAnalisis).
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { cabecerasErp } from "@/lib/fetch-erp";
import { TOPES_ANALISIS, type RespuestaRutaAnalisis } from "@/lib/licitaciones/analisis";
import type { AnalisisBases, AvisoAnalisis, EntradaAnalisis } from "@/lib/licitaciones/tipos";

export type FaseIA = "inactivo" | "guardando" | "estimando" | "analizando";

export type EstimacionIA = { tokensEntrada: number; paginas: number; costoUsdMax: number | null; archivos: number; conTexto: boolean };

export type ResultadoIA = {
  analisisId: number;
  resultado: AnalisisBases;
  avisos: AvisoAnalisis[];
  uso: { tokensEntrada: number; tokensSalida: number; costoUsd: number | null };
  /** Los archivos ENVIADOS, en el orden de sus etiquetas (A1 = el primero). */
  archivos: { id: string; etiqueta: string }[];
  conTexto: boolean;
  en: number;
};

export type ErrorIA = { codigo: string; texto: string; reintentarHasta: number | null };

export type TiendaIA = {
  fase: FaseIA;
  inicio: number | null;
  estimacion: EstimacionIA | null;
  resultado: ResultadoIA | null;
  error: ErrorIA | null;
  /** El operador ya pasó algo del resultado al doc (para no avisar al salir por un resultado usado). */
  aplicado: boolean;
  leer: (archivoIds: string[], texto: string | null) => Promise<void>;
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

async function llamar(cuerpo: EntradaAnalisis, señal: AbortSignal): Promise<Respuesta> {
  let res: Response;
  try {
    res = await fetch("/api/licitaciones/analizar", {
      method: "POST", headers: await cabecerasErp(), body: JSON.stringify(cuerpo), signal: señal, cache: "no-store",
    });
  } catch {
    if (señal.aborted) {
      return { ok: false, codigo: "sin_respuesta", error: "El servidor no respondió en más de 5 minutos. Si la lectura llegó a terminar, quedó registrada en el servidor, pero esta pantalla no la recibió: vuelve a intentarlo con menos archivos." };
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
  if (res.status === 504 || res.status === 502) return { ok: false, codigo: "sin_respuesta", error: "La lectura tardó más de lo que el servidor permite y se cortó. Elige menos archivos (o solo las secciones de requisitos) y vuelve a intentarlo." };
  return { ok: false, codigo: "sin_respuesta", error: `El servidor respondió ${res.status} sin explicación. Vuelve a intentarlo en un momento.` };
}

const usd = (n: number) => `US$ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
  const enCurso = useRef(false);
  const abortar = useRef<AbortController | null>(null);

  // Al salir del editor no se aborta la petición (el servidor sigue y la cobra igual); solo se suelta.
  useEffect(() => () => { abortar.current = null; }, []);

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
      abortar.current = ctrlE;
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
      const ctrl = new AbortController();
      abortar.current = ctrl;
      const reloj = setTimeout(() => ctrl.abort(), PLAZO_NAVEGADOR_MS);
      const r = await llamar({ licitacion_id: licId, archivo_ids: ids, texto: t, estimar: false }, ctrl.signal);
      clearTimeout(reloj);
      if (!r.ok) { fallo(r); return; }
      if (r.modo !== "analisis") { setError({ codigo: "sin_respuesta", texto: "El servidor no devolvió el análisis.", reintentarHasta: null }); return; }
      setResultado({
        analisisId: r.analisisId, resultado: r.resultado, avisos: r.avisos ?? [], uso: r.uso,
        archivos: ids.map((id, i) => ({ id, etiqueta: `A${i + 1}` })), conTexto: !!t, en: Date.now(),
      });
      setAplicado(false);
    } finally {
      enCurso.current = false;
      abortar.current = null;
      setFase("inactivo");
      setInicio(null);
    }
  }, [licId, guardarAhora, fallo]);

  const descartar = useCallback(() => { setResultado(null); setAplicado(false); }, []);
  const limpiarError = useCallback(() => setError(null), []);
  const marcarAplicado = useCallback(() => setAplicado(true), []);

  return { fase, inicio, estimacion, resultado, error, aplicado, leer, descartar, limpiarError, marcarAplicado };
}
