"use client";
// components/licitaciones/editor/bases/RetomarAnalisis.tsx — «Retomar el análisis del …»: el último
// análisis LISTO que guardó el servidor (licitacion_analisis), para volver a revisarlo SIN volver a pagar.
// Se carga en RevisarAnalisis exactamente como uno recién leído (con su id, que es el aplicadoId del doc).
// Tri-estado: mientras se comprueba se dice «buscando…»; si la consulta falla, se dice en gris y no se
// ofrece (la lectura nueva funciona igual); sin análisis guardado no se pinta nada.
import type { DocLicitacion } from "@/lib/licitaciones/tipos";
import { resultadoDeGuardado, type TiendaIA } from "../analisis-ia";
import { instanteLima } from "../etiquetas";
import { MOTIVO_OMITIDO, nombreArchivo } from "../RevisarAnalisis";
import { BOTON } from "./ui";

type Props = { doc: DocLicitacion; tienda: TiendaIA };

export default function RetomarAnalisis({ doc, tienda }: Props) {
  const rt = tienda.retomable;
  if (tienda.resultado) return null;
  if (rt.estado === "comprobando") return <p className="text-[11px] text-gray-400" role="status">Buscando si hay un análisis guardado de esta licitación…</p>;
  if (rt.estado === "ninguno") return null;
  if (rt.estado === "error") {
    return <p className="text-[11px] text-gray-500">No se pudo comprobar si hay un análisis guardado ({rt.texto}), así que no se ofrece retomarlo. Leer las bases de nuevo funciona igual.</p>;
  }
  const a = rt.analisis;
  const r = resultadoDeGuardado(a);
  const omitidos = r.archivos.filter((x) => x.omitido != null);
  const leidos = r.archivos.filter((x) => x.omitido == null);
  const aplicado = doc.analisis.aplicadoId === a.id;
  const trabajando = tienda.fase !== "inactivo";
  const costo = a.costo_usd != null ? `US$ ${a.costo_usd.toFixed(2)}` : "costo no registrado";
  const entre = a.usuario_nombre ? `por ${a.usuario_nombre}, ${costo}` : costo;
  return (
    <div className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 space-y-1.5 text-xs text-gray-700">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <p className="min-w-0">
          <b>Hay un análisis guardado (N° {a.id})</b> del {instanteLima(r.en)} ({entre}). Retomarlo no se cobra.
        </p>
        <button type="button" className={BOTON} disabled={trabajando} onClick={tienda.retomar}>
          Retomar el análisis del {instanteLima(r.en)}
        </button>
      </div>
      {aplicado && <p className="text-blue-800">Ya aplicaste este análisis: lo que no marcaste sigue disponible para agregarlo.</p>}
      <p className="text-[11px] text-gray-500">
        Leyó {leidos.length ? leidos.map((x) => nombreArchivo(x, doc.bases)).join(" · ") : "solo el texto pegado"}.
      </p>
      {omitidos.length > 0 && (
        <ul className="text-[11px] text-amber-800 list-disc pl-4 space-y-0.5">
          {omitidos.map((x) => <li key={x.id}>No leyó <span className="break-all">{nombreArchivo(x, doc.bases)}</span>: {MOTIVO_OMITIDO[x.omitido ?? ""] ?? `no se pudo leer (${x.omitido})`}</li>)}
        </ul>
      )}
      {trabajando && <p className="text-[11px] text-gray-500">Se puede retomar cuando termine la lectura en curso.</p>}
    </div>
  );
}
