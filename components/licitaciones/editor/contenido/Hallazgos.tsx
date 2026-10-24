"use client";
// components/licitaciones/editor/contenido/Hallazgos.tsx — Las observaciones de la revisión que se
// corrigen en este paso (variable sin valor, [COMPLETAR], texto de otra licitación, «flota propia» con
// recursos tercerizados, sección vacía, imagen sin archivo…), cada una con el botón que lleva al bloque.
// Mientras no hay revisión dice «comprobando»: nunca afirma que no hay nada.

import { useState } from "react";
import type { Hallazgo } from "@/lib/licitaciones/tipos";

const ESTILO: Record<Hallazgo["gravedad"], { punto: string; texto: string; nombre: string }> = {
  alarma: { punto: "bg-red-500", texto: "text-red-800", nombre: "por corregir" },
  aviso: { punto: "bg-amber-500", texto: "text-amber-900", nombre: "avisos" },
  info: { punto: "bg-gray-400", texto: "text-gray-700", nombre: "informativas" },
};
const VISIBLES = 5;

export default function Hallazgos({ hallazgos, ir, irRevision }: { hallazgos: Hallazgo[] | null; ir: (h: Hallazgo) => void; irRevision: () => void }) {
  const [todos, setTodos] = useState(false);
  if (!hallazgos) return <p className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs text-gray-500">Comprobando el contenido…</p>;
  const abiertos = hallazgos.filter((h) => !h.aceptado);
  const aceptados = hallazgos.length - abiertos.length;
  if (!abiertos.length) {
    return (
      <p className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs text-gray-500">
        Sin observaciones en el contenido.{aceptados ? ` ${aceptados} ${aceptados === 1 ? "aceptada" : "aceptadas"} en Revisión.` : ""}
      </p>
    );
  }
  const cuenta = (g: Hallazgo["gravedad"]) => abiertos.filter((h) => h.gravedad === g).length;
  const lista = todos ? abiertos : abiertos.slice(0, VISIBLES);
  const hayAlarma = cuenta("alarma") > 0;
  return (
    <section aria-label="Observaciones del contenido" className={`rounded-2xl border p-3 sm:p-4 ${hayAlarma ? "border-red-200 bg-red-50/40" : "border-amber-200 bg-amber-50/40"}`}>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-gray-800">Observaciones del contenido</h3>
        {(["alarma", "aviso", "info"] as const).map((g) => (cuenta(g) ? (
          <span key={g} className={`inline-flex items-center gap-1 text-xs ${ESTILO[g].texto}`}><span className={`h-2 w-2 rounded-full ${ESTILO[g].punto}`} />{cuenta(g)} {ESTILO[g].nombre}</span>
        ) : null))}
        {aceptados ? <button type="button" onClick={irRevision} className="text-xs text-gray-500 underline">{aceptados} {aceptados === 1 ? "aceptada" : "aceptadas"} en Revisión</button> : null}
      </div>
      <ul className="space-y-1.5">
        {lista.map((h) => (
          <li key={h.clave} className="flex items-start gap-2 rounded-lg bg-white/80 px-2.5 py-2">
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ESTILO[h.gravedad].punto}`} />
            <div className="min-w-0 flex-1">
              <p className={`text-xs font-semibold ${ESTILO[h.gravedad].texto}`}>{h.titulo}</p>
              <p className="text-xs text-gray-700">{h.texto}</p>
              <p className="text-[11px] text-gray-500">{h.arreglo}</p>
            </div>
            <button type="button" onClick={() => ir(h)} className="shrink-0 rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-[#0b315f] hover:bg-gray-50">Ir →</button>
          </li>
        ))}
      </ul>
      {abiertos.length > VISIBLES ? (
        <button type="button" onClick={() => setTodos((x) => !x)} className="mt-2 text-xs font-semibold text-[#0b315f] underline">
          {todos ? "Ver menos" : `Ver las ${abiertos.length}`}
        </button>
      ) : null}
    </section>
  );
}
