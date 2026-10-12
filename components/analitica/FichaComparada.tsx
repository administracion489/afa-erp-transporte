"use client";

// components/analitica/FichaComparada.tsx — La ficha "este periodo contra el anterior".
//
// Nació privada en app/combustible/ComparacionPeriodo.tsx y se sacó de ahí porque ahora la
// usan tres pantallas (Combustible, Uso de flota, Seguridad vial). Se EXTRAJO, no se
// reescribió: el render es byte a byte el de antes.
//
// LO ÚNICO QUE NO SE PUEDE AFLOJAR: el color NO es "sube malo, baja bueno" en todas las
// fichas. Más km es NEUTRO (es trabajo, y más facturación); menos rendimiento es rojo; más
// costo por km es rojo. Cada ficha DECLARA su sentido (`SentidoVariacion`) y el tono lo
// decide `tonoVariacion` de lib/rendimiento.ts — el motor, no esta pantalla. Deducirlo del
// signo pintaría de rojo un mes en que se trabajó más.
//
// Tampoco se decide aquí qué es "igual": eso también lo contesta `tonoVariacion`. Dos
// definiciones del umbral (una en el motor, otra en la ficha) es cómo una flecha dice "="
// mientras su color dice "subió".

import React from "react";
import { tonoVariacion } from "@/lib/rendimiento";
import type { SentidoVariacion, TonoVariacion } from "@/lib/rendimiento";

const fmtNum = (n: number, dec = 1) =>
  n.toLocaleString("es-PE", { minimumFractionDigits: dec, maximumFractionDigits: dec });

/**
 * El color de cada tono. Gris para lo que no se mueve o no se puede comparar, pizarra para
 * lo que se mueve sin ser bueno ni malo, y rojo / verde solo cuando el sentido lo declara.
 */
export const COLOR_TONO: Record<TonoVariacion, string> = {
  sin_dato: "#64748b",
  igual: "#64748b",
  neutro: "#334155",
  malo: "#b91c1c",
  bueno: "#166534",
};

/** La variación en % con su flecha. `v` ya viene en % (12.5 = +12.5 %). */
export function Delta({ v, sentido }: { v: number | null; sentido: SentidoVariacion }) {
  const tono = tonoVariacion(v, sentido);
  if (v === null || tono === "sin_dato") return <span className="text-gray-300 text-[11px]">sin comparación</span>;
  const cero = tono === "igual";
  return (
    <span className="text-[11px] font-bold tabular-nums" style={{ color: COLOR_TONO[tono] }}>
      {cero ? "=" : v > 0 ? "↑" : "↓"} {cero ? "igual" : `${fmtNum(Math.abs(v), 1)} %`}
    </span>
  );
}

/**
 * Una métrica con su valor, la variación y el valor del periodo anterior. `valor` y `previo`
 * llegan ya formateados: quien llama sabe si es «≥ 1 234 km», «S/ 12.40» o «—», y la ficha no
 * inventa un cero donde no hay dato.
 */
export function Ficha({ label, valor, previo, delta, sentido, nota }: {
  label: string;
  valor: string;
  previo: string;
  delta: number | null;
  sentido: SentidoVariacion;
  nota?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border p-3 bg-white">
      <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{label}</p>
      <p className="text-xl font-black mt-0.5 leading-tight text-[#0b315f] tabular-nums">{valor}</p>
      <div className="flex items-baseline gap-1.5 mt-1 flex-wrap">
        <Delta v={delta} sentido={sentido} />
        <span className="text-[10px] text-gray-400">antes {previo}</span>
      </div>
      {nota && <p className="text-[10px] text-gray-400 mt-0.5 leading-snug">{nota}</p>}
    </div>
  );
}
