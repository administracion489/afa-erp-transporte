"use client";

// app/combustible/ComparacionPeriodo.tsx — La ficha del final del historial.
//
// POR QUÉ NO BASTA CON PONER LOS NÚMEROS LADO A LADO. Cuando el gasto de combustible
// sube hay TRES causas posibles y se gestionan de forma opuesta:
//
//   · recorrió más km      → no es anomalía, es más trabajo (y más facturación)
//   · rinde menos km/gal   → SÍ es anomalía: mecánica, manejo, o una fuga
//   · el combustible subió → es del mercado, no de la flota
//
// En los datos reales el diésel pasó de S/ 24.70 (14/08) a S/ 25.74 (03/09): +4.2 % de
// gasto sin que nadie haya hecho nada mal. Una ficha que solo dijera "gastaste más"
// haría leer eso como problema operativo — y un aviso que salta por algo que nadie
// puede arreglar se vuelve paisaje, que es justo lo que este módulo acaba de corregir.
//
// La aritmética que reparte la diferencia vive en lib/rendimiento.ts (`compararVentanas`)
// con su matriz: aquí solo se pinta.
//
// DOS COSAS QUE NO SE PUEDEN AFLOJAR EN LA PANTALLA:
//
//   · El color NO es "sube malo, baja bueno" en todas las fichas. Más km es NEUTRO (es
//     trabajo). Menos rendimiento es rojo. Más costo/km es rojo. Cada ficha declara su
//     sentido; deducirlo del signo pintaría de rojo un mes en que se trabajó más.
//   · Sin filtro de vehículo el total ESCONDE la anomalía: con diez unidades, una que
//     empeoró 25 % mueve el agregado un 2.5 % y nadie la ve. Por eso debajo va la lista
//     por unidad, que es "dónde mirar".

import React from "react";
import type { Comparacion } from "@/lib/rendimiento";

const fmtSoles = (n: number) =>
  `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtNum = (n: number, dec = 1) =>
  n.toLocaleString("es-PE", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const fmtFecha = (f: string) =>
  new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "short" });

/** Qué significa que el número suba. `neutro` = no es ni bueno ni malo (más trabajo). */
type Sentido = "subir_malo" | "bajar_malo" | "neutro";

function colorDelta(v: number | null, sentido: Sentido): string {
  if (v === null || Math.abs(v) < 0.05) return "#64748b";
  if (sentido === "neutro") return "#334155";
  const malo = sentido === "subir_malo" ? v > 0 : v < 0;
  return malo ? "#b91c1c" : "#166534";
}

function Delta({ v, sentido }: { v: number | null; sentido: Sentido }) {
  if (v === null) return <span className="text-gray-300 text-[11px]">sin comparación</span>;
  const cero = Math.abs(v) < 0.05;
  return (
    <span className="text-[11px] font-bold tabular-nums" style={{ color: colorDelta(v, sentido) }}>
      {cero ? "=" : v > 0 ? "↑" : "↓"} {cero ? "igual" : `${fmtNum(Math.abs(v), 1)} %`}
    </span>
  );
}

function Ficha({ label, valor, previo, delta, sentido, nota }: {
  label: string; valor: string; previo: string; delta: number | null; sentido: Sentido; nota?: string;
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

export default function ComparacionPeriodo({ c, porUnidad, onVerUnidad }: {
  c: Comparacion;
  porUnidad: { uid: string; placa: string; tipo: string; c: Comparacion; firme: boolean }[];
  onVerUnidad: (uid: string) => void;
}) {
  const { actual: a, previa: p, efectos: e, variacion: v } = c;

  const cabecera = (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 className="font-bold text-gray-800 text-sm flex items-center gap-2">
        <span>📊</span>¿Cambió algo respecto al periodo anterior?
      </h3>
      <p className="text-[11px] text-gray-500">
        <b className="text-gray-700">{a.label}</b> ({fmtFecha(a.desde)} – {fmtFecha(a.hasta)}, {a.dias} días)
        {" vs "}
        <b className="text-gray-700">{p.label}</b> ({fmtFecha(p.desde)} – {fmtFecha(p.hasta)}, {p.dias} días)
      </p>
    </div>
  );

  // Sin nada que comparar se dice por qué y se para: un −100 % sería peor que un hueco.
  if (!c.comparable || !e) {
    return (
      <section className="bg-white rounded-2xl border shadow-sm p-4 space-y-2">
        {cabecera}
        <p className="text-xs text-gray-500 leading-snug bg-gray-50 rounded-lg px-3 py-2">{c.motivo}</p>
      </section>
    );
  }

  const label = a.familias.length === 1 ? (a.familias[0] === "gnv" ? "km/m³" : "km/gal") : "km/gal";
  const subeGasto = e.total > 0;

  // Las tres barras, ordenadas por cuánto pesan. `rendimiento` es la única accionable.
  const partes = [
    { k: "km", titulo: "porque recorrió más o menos", monto: e.km,
      detalle: `${fmtNum(a.km, 0)} km contra ${fmtNum(p.km, 0)} km`, accionable: false },
    { k: "rendimiento", titulo: "porque la unidad rinde distinto", monto: e.rendimiento,
      detalle: a.rendimiento && p.rendimiento ? `${fmtNum(p.rendimiento, 1)} → ${fmtNum(a.rendimiento, 1)} ${label}` : "—",
      accionable: true },
    { k: "precio", titulo: "porque cambió el precio del combustible", monto: e.precio,
      detalle: a.precioMedio && p.precioMedio ? `${fmtSoles(p.precioMedio)} → ${fmtSoles(a.precioMedio)} por unidad` : "—",
      accionable: false },
  ].sort((x, y) => Math.abs(y.monto) - Math.abs(x.monto));

  const mayor = Math.max(...partes.map(x => Math.abs(x.monto)), 1);

  return (
    <section className="bg-white rounded-2xl border shadow-sm p-4 space-y-3.5">
      {cabecera}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        {/* Más km NO es malo: es más trabajo. Por eso va como neutro. */}
        <Ficha label="Km recorridos" sentido="neutro"
          valor={`${fmtNum(a.km, 0)} km`} previo={`${fmtNum(p.km, 0)} km`} delta={v.km} />
        <Ficha label={`Rendimiento (${label})`} sentido="bajar_malo"
          valor={a.rendimiento ? fmtNum(a.rendimiento, 1) : "—"}
          previo={p.rendimiento ? fmtNum(p.rendimiento, 1) : "—"} delta={v.rendimiento}
          nota="la señal: no depende de cuánto se trabajó" />
        <Ficha label="Costo por km" sentido="subir_malo"
          valor={a.costoKm ? `S/ ${fmtNum(a.costoKm, 2)}` : "—"}
          previo={p.costoKm ? `S/ ${fmtNum(p.costoKm, 2)}` : "—"} delta={v.costoKm} />
        {/* El gasto de la ficha es el MEDIDO; el total va en la nota porque es el que
            cuadra con caja y con el KPI de arriba. Enseñar solo uno haría dudar del otro. */}
        <Ficha label="Gasto medido" sentido="subir_malo"
          valor={fmtSoles(a.gasto)} previo={fmtSoles(p.gasto)} delta={v.gasto}
          nota={a.gasto !== a.gastoTotal ? `de ${fmtSoles(a.gastoTotal)} en total · ${a.cargasMedidas} de ${a.cargas} cargas medidas` : `${a.cargas} carga(s)`} />
      </div>

      {/* El porqué, que es la razón de existir de esta ficha. */}
      <div className="rounded-xl border p-3" style={{ background: "#f8fafc", borderColor: "#e2e8f0" }}>
        <p className="text-xs font-bold text-gray-700 mb-2">
          El gasto {subeGasto ? "subió" : Math.abs(e.total) < 0.01 ? "no se movió" : "bajó"}{" "}
          <span style={{ color: subeGasto ? "#b91c1c" : "#166534" }}>{fmtSoles(Math.abs(e.total))}</span>
          {v.gasto !== null && Math.abs(v.gasto) >= 0.05 && (
            <span className="text-gray-400 font-medium"> ({v.gasto > 0 ? "+" : "−"}{fmtNum(Math.abs(v.gasto), 1)} %)</span>
          )}
          {" — "}<span className="font-medium text-gray-500">repartido entre sus tres causas:</span>
        </p>
        <div className="space-y-1.5">
          {partes.map(x => {
            const positivo = x.monto > 0;
            const color = x.accionable ? (positivo ? "#b91c1c" : "#166534") : "#94a3b8";
            return (
              <div key={x.k} className="flex items-center gap-2 text-xs">
                <div className="w-[86px] shrink-0 text-right font-bold tabular-nums" style={{ color }}>
                  {positivo ? "+" : "−"}{fmtSoles(Math.abs(x.monto)).replace("S/ ", "S/ ")}
                </div>
                <div className="w-24 shrink-0 h-2.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${Math.max(3, (Math.abs(x.monto) / mayor) * 100)}%`, background: color }} />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-gray-600">{x.titulo}</span>
                  <span className="text-gray-400"> · {x.detalle}</span>
                  {x.accionable && Math.abs(x.monto) > 0.01 && (
                    <span className="ml-1.5 text-[9px] font-black uppercase tracking-wide px-1.5 py-0.5 rounded"
                      style={{ background: positivo ? "#fee2e2" : "#dcfce7", color: positivo ? "#b91c1c" : "#166534" }}>
                      {positivo ? "lo único que se puede arreglar" : "mejoró"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {c.motivo && (
        <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg px-3 py-2 leading-snug">{c.motivo}</p>
      )}

      {/* El agregado esconde a la unidad que empeoró: esta lista es dónde mirar. */}
      {porUnidad.length > 1 && (
        <div className="pt-1">
          <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">
            Por unidad · ordenadas por cuánto se movió su rendimiento
          </p>
          <div className="space-y-1">
            {porUnidad.map(u => {
              const d = u.c.variacion.rendimiento;
              const ra = u.c.actual.rendimiento, rp = u.c.previa.rendimiento;
              return (
                <button key={u.uid} onClick={() => onVerUnidad(u.uid)}
                  className="w-full flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg hover:bg-gray-50 text-left">
                  <span className="font-mono font-black text-[#0b315f] w-[74px] shrink-0">{u.placa}</span>
                  <span className="w-[74px] shrink-0"><Delta v={d} sentido="bajar_malo" /></span>
                  <span className="text-gray-500 tabular-nums">
                    {rp ? fmtNum(rp, 1) : "—"} → {ra ? fmtNum(ra, 1) : "—"} {label}
                  </span>
                  {!u.firme && (
                    <span className="text-[9px] text-gray-400 italic">
                      pocos tramos ({Math.min(u.c.actual.cargasMedidas, u.c.previa.cargasMedidas)})
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-gray-300">ver →</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
