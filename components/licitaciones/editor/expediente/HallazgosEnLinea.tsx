"use client";
// components/licitaciones/editor/expediente/HallazgosEnLinea.tsx — Los hallazgos de la revisión que
// pertenecen a un bloque o a un ítem, pintados junto a él. Solo los abiertos (los aceptados están en la
// lista del paso). El texto, el arreglo y el sitio los da la revisión: aquí no se redacta nada.
import Link from "next/link";
import type { Hallazgo, Paso } from "@/lib/licitaciones/tipos";
import { ETIQUETA_PASO } from "../etiquetas";

const TONO = { alarma: "border-red-200 bg-red-50 text-red-800", aviso: "border-amber-200 bg-amber-50 text-amber-900", info: "border-gray-200 bg-gray-50 text-gray-700" } as const;

export function HallazgosEnLinea({ hallazgos, irA }: { hallazgos: Hallazgo[]; irA: (p: Paso, ancla?: string | null) => void }) {
  const abiertos = hallazgos.filter((h) => !h.aceptado);
  if (!abiertos.length) return null;
  return (
    <ul className="space-y-1">
      {abiertos.map((h) => (
        <li key={h.clave} className={`rounded-lg border px-2 py-1.5 text-xs ${TONO[h.gravedad]}`}>
          <span className="font-semibold">{h.titulo}.</span> {h.texto}
          <span className="block opacity-80">→ {h.arreglo}</span>
          {"ruta" in h.donde ? (
            <Link href={h.donde.ruta} target="_blank" rel="noopener noreferrer" className="text-[11px] font-semibold underline">Abrir {h.donde.etiqueta} ↗</Link>
          ) : h.donde.paso !== "expediente" ? (
            <button type="button" onClick={() => { const d = h.donde as { paso: Paso; ancla: string | null }; irA(d.paso, d.ancla); }} className="text-[11px] font-semibold underline">
              Ir a {ETIQUETA_PASO[h.donde.paso].corto} →
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
