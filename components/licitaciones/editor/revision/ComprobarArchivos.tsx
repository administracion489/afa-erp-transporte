"use client";
// components/licitaciones/editor/revision/ComprobarArchivos.tsx — El ENSAYO de la emisión: baja y revisa
// cada archivo que la emisión usaría (comprobarArchivos de lib/licitaciones/emitir.ts) SIN armar nada,
// para enterarse ANTES de emitir de un PDF protegido, uno ilegible, un enlace de Drive o un formato que
// el expediente no une. El resultado pasa a la revisión (los hallazgos de arriba lo incluyen) y a la
// emisión (que avisa si un archivo cambió entre el ensayo y la emisión).
//
// emitir.ts, documento.ts y pdf-lib se cargan al pulsar, no con la pantalla.
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { empresaConDefectos } from "@/lib/empresa-perfil";
import { revisarLicitacion } from "@/lib/licitaciones/revision";
import type { ContextoLicitacion, Licitacion, ProgresoEmision, Revision, RevisionArchivo } from "@/lib/licitaciones/tipos";
import { instanteLima, tamanoArchivo } from "../etiquetas";
import { etiquetasDeArchivos, filasComprobacion, type UsoArchivo } from "./resumen";
import { BOTON_PRIMARIO, BOTON_SECUNDARIO, Barra, Chip, ETIQUETA_PROBLEMA_ARCHIVO, Nota, Seccion, plural } from "./ui";

export type Comprobacion = {
  revisiones: Record<string, RevisionArchivo>;
  usos: Record<string, UsoArchivo>;
  /** Cuándo terminó (ms). */
  en: number;
  /** firmaArchivos(doc) al comprobar: si cambia, lo nuevo no está comprobado. */
  firma: string;
  cancelada: boolean;
  /** Cuántos archivos distintos usaría la emisión (para decir cuántos quedaron sin revisar). */
  total: number;
};

type Props = {
  lic: Licitacion;
  ctx: ContextoLicitacion | null;
  revision: Revision | null;
  comprobacion: Comprobacion | null;
  firmaActual: string;
  pantallaChica: boolean;
  onListo: (c: Comprobacion | null) => void;
};

type Corriendo = { hecho: number; total: number; detalle: string };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

export default function ComprobarArchivos(p: Props) {
  const [corriendo, setCorriendo] = useState<Corriendo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => () => { ctrlRef.current?.abort(); }, []);

  const comprobar = async () => {
    const { lic, ctx, revision } = p;
    if (!ctx || !revision || ctrlRef.current) return;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setError(null);
    setCorriendo({ hecho: 0, total: 0, detalle: "Cargando el comprobador…" });
    try {
      const [mE, mD, mX] = await Promise.all([
        import("@/lib/licitaciones/emitir"), import("@/lib/licitaciones/documento"), import("@/lib/licitaciones/expediente"),
      ]);
      if (ctrl.signal.aborted) return;
      const deps = mE.depsNavegador(supabase, { resolverDocumento: mD.resolverDocumento, resolverExpediente: mX.resolverExpediente, revisarLicitacion });
      const logo = empresaConDefectos(ctx.perfil).logo;
      const usos = etiquetasDeArchivos(mX.resolverExpediente(lic, ctx, revision), mD.resolverDocumento(lic, ctx, revision), logo);
      const revisiones = await mE.comprobarArchivos(lic, ctx, revision, deps, ctrl.signal, {
        logo,
        onProgreso: (pr: ProgresoEmision) => setCorriendo({ hecho: pr.hecho, total: pr.total, detalle: pr.detalle }),
      });
      p.onListo({ revisiones, usos, en: Date.now(), firma: p.firmaActual, cancelada: ctrl.signal.aborted, total: Object.keys(usos).length });
    } catch (e) {
      setError(`No se pudo comprobar los archivos (${msg(e) || "error inesperado"}). La emisión los comprueba igual al bajarlos.`);
    } finally {
      ctrlRef.current = null;
      setCorriendo(null);
    }
  };

  const c = p.comprobacion;
  const filas = useMemo(() => (c ? filasComprobacion(c.revisiones, c.usos) : []), [c]);
  const malos = filas.filter((f) => !f.r.ok).length;
  const buenos = filas.length - malos;
  const vieja = !!c && c.firma !== p.firmaActual;
  const sinRevisar = c ? Math.max(0, c.total - filas.length) : 0;

  const motivoDeshabilitado = !p.ctx ? "Esperando lo que el ERP sabe de la licitación…" : !p.revision ? "Esperando la revisión…" : null;

  return (
    <Seccion
      titulo="Comprobar los archivos (recomendado)"
      subtitulo="Baja y revisa cada archivo que la emisión uniría, sin armar ningún PDF: así sabes antes de emitir si hay un PDF protegido, uno dañado, un enlace de Drive o un formato que no se puede unir."
      acciones={corriendo ? (
        <button type="button" onClick={() => ctrlRef.current?.abort()} className={BOTON_SECUNDARIO}>Cancelar</button>
      ) : (
        <button type="button" onClick={() => void comprobar()} disabled={!!motivoDeshabilitado} className={BOTON_PRIMARIO}>
          {c ? "Volver a comprobar" : "Comprobar archivos"}
        </button>
      )}
    >
      {motivoDeshabilitado && !corriendo && <p className="text-xs text-gray-500">{motivoDeshabilitado}</p>}
      {p.pantallaChica && !corriendo && (
        <Nota tono="gris">Baja todos los archivos del expediente: con datos móviles puede ser mucho. Mejor desde una computadora con buena conexión.</Nota>
      )}
      {corriendo && (
        <div className="space-y-1.5">
          <Barra hecho={corriendo.hecho} total={corriendo.total} />
          <p className="text-xs text-gray-600">{corriendo.detalle}{corriendo.total > 0 ? ` · ${corriendo.hecho} de ${corriendo.total}` : ""}</p>
        </div>
      )}
      {error && <Nota tono="rojo">{error}</Nota>}
      {c && !corriendo && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-700">
            <span>Comprobado el {instanteLima(c.en)}:</span>
            <Chip tono="verde">{plural(buenos, "sin problema", "sin problema")}</Chip>
            <Chip tono={malos ? "rojo" : "gris"}>{plural(malos, "con problema", "con problema")}</Chip>
            <button type="button" onClick={() => p.onListo(null)} className="ml-1 font-bold text-gray-500 underline">Descartar resultado</button>
          </div>
          {c.cancelada && sinRevisar > 0 && (
            <Nota tono="ambar">Se canceló a medias: {plural(sinRevisar, "archivo quedó", "archivos quedaron")} sin revisar. Lo revisado sí cuenta en los hallazgos.</Nota>
          )}
          {vieja && (
            <Nota tono="gris">Cambiaste el expediente, los recursos o las imágenes desde la comprobación: lo nuevo no está comprobado. Vuelve a comprobar antes de emitir.</Nota>
          )}
          {filas.length === 0 ? (
            <p className="text-xs text-gray-500">La emisión no usaría ningún archivo (solo hojas que arma el ERP).</p>
          ) : (
            <details open={malos > 0 && malos <= 30} className="group rounded-xl border border-gray-200">
              <summary className="cursor-pointer list-none px-3 py-2 text-xs font-bold text-gray-700">
                <span className="group-open:hidden">▸ Ver</span><span className="hidden group-open:inline">▾ Ocultar</span> el detalle por archivo ({filas.length})
              </summary>
              <ul className="divide-y divide-gray-100 border-t border-gray-200">
                {filas.map((f) => (
                  <li key={f.url} className="flex flex-wrap items-start justify-between gap-2 px-3 py-1.5 text-xs">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold text-gray-800 break-words">{f.uso?.titulo ?? (f.url.split("/").pop() || "Archivo")}</p>
                      <p className="text-[11px] text-gray-500">{f.uso?.donde ?? "—"}{f.uso && f.uso.usos > 1 ? ` · se usa ${f.uso.usos} veces` : ""}</p>
                      {!f.r.ok && <p className="mt-0.5 text-red-800">{f.r.detalle}</p>}
                    </div>
                    {f.r.ok ? (
                      <Chip tono="verde">{f.r.formato.toUpperCase()}{f.r.formato === "pdf" && f.r.paginas != null ? ` · ${f.r.paginas} pág.` : ""} · {tamanoArchivo(f.r.bytes)}</Chip>
                    ) : (
                      <Chip tono={f.r.codigo === "archivo_externo" || f.r.codigo === "archivo_formato_no_soportado" || f.r.codigo === "archivo_demasiado_grande" ? "ambar" : "rojo"}>
                        {ETIQUETA_PROBLEMA_ARCHIVO[f.r.codigo]}
                      </Chip>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {malos > 0 && (
            <p className="text-[11px] text-gray-500">Lo que no se puede unir no frena la emisión: se omite y se nombra en ella. Los hallazgos de arriba ya lo incluyen, con dónde se corrige.</p>
          )}
        </div>
      )}
    </Seccion>
  );
}
