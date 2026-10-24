"use client";
// components/licitaciones/editor/recursos/ExigenciasBases.tsx — «Lo que piden las bases» para una parte del
// paso: los requisitos con regla de ese tema, con lo que exige cada uno (describirRegla) y cómo lo juzga
// HOY la revisión (revision.evaluaciones). La pantalla no evalúa nada: enseña lo que dijo el motor.

import { describirRegla } from "@/lib/licitaciones/reglas";
import type { EstadoFinal, Requisito, Revision, TipoRegla } from "@/lib/licitaciones/tipos";
import { anclaDe, type PasoProps } from "../contrato-editor";
import { Chip, type Tono } from "./comun";

const ESTADO: Record<EstadoFinal, { texto: string; tono: Tono }> = {
  cumple: { texto: "Cumple", tono: "verde" },
  no_cumple: { texto: "No cumple", tono: "rojo" },
  no_se_puede_juzgar: { texto: "No se puede comprobar", tono: "ambar" },
  pendiente: { texto: "Pendiente", tono: "gris" },
  no_aplica: { texto: "No aplica", tono: "gris" },
};

export default function ExigenciasBases({ requisitos, revision, tipos, irA }: {
  requisitos: readonly Requisito[]; revision: Revision | null; tipos: (t: TipoRegla) => boolean; irA: PasoProps["irA"];
}) {
  const lista = requisitos.filter((q) => q.regla && tipos(q.regla.tipo));
  if (!lista.length) return null;
  return (
    <div className="rounded-lg border border-[#d5e0ec] bg-[#f7f9fc] px-3 py-2">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[#0b315f]">Lo que piden las bases</p>
      <ul className="space-y-1">
        {lista.map((q) => {
          const ev = revision?.evaluaciones.find((e) => e.requisitoId === q.id) ?? null;
          const est = ev ? ESTADO[ev.final] : null;
          return (
            <li key={q.id} className="flex flex-wrap items-center gap-1.5 text-xs text-gray-700">
              {q.numeral && <span className="font-mono text-[11px] text-gray-500">{q.numeral}</span>}
              <span>{describirRegla(q.regla!)}</span>
              {est ? <Chip tono={est.tono}>{est.texto}{ev?.fuente === "manual" ? " (a mano)" : ""}</Chip> : <span className="text-[11px] text-gray-400">comprobando…</span>}
              {ev?.auto?.detalle && <span className="text-[11px] text-gray-500">· {ev.auto.detalle}</span>}
              <button type="button" onClick={() => irA("bases", anclaDe("requisito", q.id))} className="text-[11px] font-semibold text-[#0b315f] underline">ver requisito</button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
