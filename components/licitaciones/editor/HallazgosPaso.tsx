"use client";
// components/licitaciones/editor/HallazgosPaso.tsx — Los hallazgos de la revisión que se corrigen en UN
// paso (los de `donde.paso === paso`), con su arreglo y un botón que lleva al sitio. Lo usa cualquier
// paso. Mientras no hay revisión dice «comprobando…»: nunca afirma «sin hallazgos» sin haber revisado.
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Gravedad, Hallazgo, Paso, Revision } from "@/lib/licitaciones/tipos";
import { ESTILO_GRAVEDAD, ETIQUETA_PASO } from "./etiquetas";

const ORDEN: Record<Gravedad, number> = { alarma: 0, aviso: 1, info: 2 };

/** Una lista de hallazgos con su gravedad, su texto, su arreglo y el camino a donde se corrige. */
export function ListaHallazgos({ hallazgos, irA, pasoActual }: {
  hallazgos: Hallazgo[]; irA: (p: Paso, ancla?: string | null) => void; pasoActual?: Paso;
}) {
  return (
    <ul className="space-y-1.5">
      {hallazgos.map((h) => {
        const e = ESTILO_GRAVEDAD[h.gravedad];
        const d = h.donde;
        return (
          <li key={h.clave} className="rounded-xl border px-3 py-2 text-xs" style={{ background: h.aceptado ? "#f9fafb" : e.bg, borderColor: h.aceptado ? "#e5e7eb" : e.bd, color: h.aceptado ? "#6b7280" : e.color }}>
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="min-w-0 flex-1">
                <p className="font-bold">
                  <span aria-hidden="true">{e.icono}</span> {h.titulo}
                  {h.sujeto.rotulo && <span className="font-normal opacity-80"> · {h.sujeto.rotulo}</span>}
                  {h.aceptado && <span className="font-normal"> · aceptado{h.aceptado.nota ? `: «${h.aceptado.nota}»` : ""}</span>}
                </p>
                <p className="mt-0.5 opacity-90">{h.texto}</p>
                {!h.aceptado && <p className="mt-0.5 opacity-75">Cómo se arregla: {h.arreglo}</p>}
              </div>
              {"ruta" in d ? (
                <Link href={d.ruta} className="shrink-0 px-2.5 py-1 rounded-lg border font-bold bg-white hover:bg-gray-50" style={{ borderColor: e.bd }}>
                  {d.etiqueta} →
                </Link>
              ) : (d.ancla || d.paso !== pasoActual) ? (
                <button type="button" onClick={() => irA(d.paso, d.ancla)} className="shrink-0 px-2.5 py-1 rounded-lg border font-bold bg-white hover:bg-gray-50" style={{ borderColor: e.bd }}>
                  {d.paso === pasoActual ? "Ir →" : `Ir a ${ETIQUETA_PASO[d.paso].corto} →`}
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

type Props = {
  revision: Revision | null;
  ctxCargando: boolean;
  paso: Paso;
  irA: (p: Paso, ancla?: string | null) => void;
  /** Filtro adicional (p. ej. dejar fuera los que ya se pintan junto a cada requisito). */
  filtro?: (h: Hallazgo) => boolean;
  id?: string;
};

export default function HallazgosPaso({ revision, ctxCargando, paso, irA, filtro, id }: Props) {
  const [abierto, setAbierto] = useState(true);
  const [verAceptados, setVerAceptados] = useState(false);
  const delPaso = useMemo(() => {
    const xs = (revision?.hallazgos ?? []).filter((h) => "paso" in h.donde && h.donde.paso === paso && (!filtro || filtro(h)));
    return xs.sort((a, b) => ORDEN[a.gravedad] - ORDEN[b.gravedad]);
  }, [revision, paso, filtro]);

  if (!revision) {
    return (
      <div id={id} className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-xs text-gray-500">
        {ctxCargando ? "Comprobando la revisión de este paso…" : "La revisión no está disponible todavía (no se pudo leer lo que el ERP sabe de la licitación): nada se da por cumplido ni por faltante."}
      </div>
    );
  }
  const abiertos = delPaso.filter((h) => !h.aceptado);
  const aceptados = delPaso.filter((h) => h.aceptado);
  const n = (g: Gravedad) => abiertos.filter((h) => h.gravedad === g).length;
  if (!delPaso.length) {
    return <div id={id} className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs text-emerald-800">La revisión no encuentra nada que corregir en este paso.</div>;
  }
  return (
    <section id={id} className="bg-white rounded-2xl border shadow-sm p-4 space-y-2">
      <button type="button" onClick={() => setAbierto((v) => !v)} className="w-full flex items-center justify-between gap-2 text-left">
        <span className="text-sm font-bold text-gray-800">
          {abierto ? "▾" : "▸"} Revisión de este paso
          {n("alarma") > 0 && <span className="ml-2 text-red-700">{n("alarma")} alarma{n("alarma") === 1 ? "" : "s"}</span>}
          {n("aviso") > 0 && <span className="ml-2 text-amber-700">{n("aviso")} aviso{n("aviso") === 1 ? "" : "s"}</span>}
          {n("info") > 0 && <span className="ml-2 text-blue-800 font-normal">{n("info")} info</span>}
        </span>
        <span className="text-[11px] text-gray-400">{abierto ? "ocultar" : "ver"}</span>
      </button>
      {abierto && (
        <>
          {abiertos.length > 0 ? <ListaHallazgos hallazgos={abiertos} irA={irA} pasoActual={paso} /> : <p className="text-xs text-emerald-800">Lo que había, se aceptó con nota.</p>}
          {aceptados.length > 0 && (
            <div>
              <button type="button" onClick={() => setVerAceptados((v) => !v)} className="text-[11px] font-bold text-gray-500 underline">
                {verAceptados ? "Ocultar" : "Ver"} {aceptados.length} aceptado{aceptados.length === 1 ? "" : "s"}
              </button>
              {verAceptados && <div className="mt-1.5"><ListaHallazgos hallazgos={aceptados} irA={irA} pasoActual={paso} /></div>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
