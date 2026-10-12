"use client";

// components/graficos/SerieComparada.tsx — Barras dobles por día: este periodo contra el
// anterior, el día i de uno junto al día i del otro.
//
// SVG propio, como app/mantenimiento/_tabs/_charts.tsx (el proyecto no trae librería de
// gráficos). Tres decisiones que no son de gusto:
//
//   · UN SOLO EJE. Las dos series son la misma métrica en dos periodos, así que comparten
//     escala por definición. Nunca un segundo eje Y: si alguien necesita otra métrica, es
//     otro gráfico.
//   · UN DÍA SIN DATO NO ES UN CERO. `valor: null` no pinta barra y su tooltip dice "sin
//     dato"; un 0 sí es un dato y se ve como la ausencia de barra sobre la línea base. La
//     diferencia vive en el tooltip porque en la barra no se puede ver — que es justo por lo
//     que el llamador tiene que mandar `null` y no 0 cuando no midió.
//   · EL ANCHO SE MIDE, NO SE ESCALA. Con un viewBox fijo, en un teléfono el texto de los
//     ejes se encoge hasta 5 px. Aquí el SVG se dibuja al ancho real del contenedor
//     (`useAnchoMedido`): los rótulos conservan su tamaño y no hay scroll horizontal.
//
// Sin número encima de cada barra: el eje, la leyenda y el tooltip (`<title>`) los llevan.

import React, { useEffect, useRef, useState } from "react";

export type PuntoSerie = { fecha: string; valor: number | null };

const AZUL = "#0b315f";   // periodo actual
const GRIS = "#94a3b8";   // periodo anterior (de-énfasis)
const REJILLA = "#eef2f7";
const EJE = "#cbd5e1";
const TINTA_SUAVE = "#64748b";
const SUPERFICIE = "#ffffff";
const EJE_HUECO = "#94a3b8"; // el círculo hueco de "sin dato"

const ALTO = 200;
const BARRA_MAX = 24;     // una barra nunca pasa de 24 px de grueso: el resto es aire
const HUECO = 2;          // la separación entre las dos barras del día, en color de fondo

/** El ancho real del contenedor, para dibujar a escala 1. Antes de medir, `inicial`. */
export function useAnchoMedido<T extends HTMLElement>(inicial = 640): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [ancho, setAncho] = useState(inicial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const medir = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      if (w > 0) setAncho((prev) => (prev === w ? prev : w));
    };
    medir();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, ancho];
}

const fmtFechaCorta = (f: string) => {
  const d = new Date(f + "T00:00:00");
  return Number.isNaN(d.getTime()) ? f : d.toLocaleDateString("es-PE", { day: "2-digit", month: "short" });
};
const fmtFechaLarga = (f: string) => {
  const d = new Date(f + "T00:00:00");
  return Number.isNaN(d.getTime()) ? f : d.toLocaleDateString("es-PE", { weekday: "short", day: "2-digit", month: "short" });
};
const fmtNumero = (n: number) =>
  n.toLocaleString("es-PE", { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 1 });

/** Rótulo compacto del eje: 0 · 500 · 1.5 K · 2 M. */
function fmtEje(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toLocaleString("es-PE", { maximumFractionDigits: 1 })} M`;
  if (a >= 1e4) return `${(n / 1e3).toLocaleString("es-PE", { maximumFractionDigits: 0 })} K`;
  if (a >= 1e3) return `${(n / 1e3).toLocaleString("es-PE", { maximumFractionDigits: 1 })} K`;
  return n.toLocaleString("es-PE", { maximumFractionDigits: a >= 10 ? 0 : 2 });
}

/** Paso "redondo" (1, 2, 2.5, 5 × 10^k) para que el eje tenga ~`marcas` divisiones limpias. */
export function pasoLimpio(rango: number, marcas = 4): number {
  if (!(rango > 0) || !Number.isFinite(rango)) return 1;
  const crudo = rango / marcas;
  const pot = Math.pow(10, Math.floor(Math.log10(crudo)));
  const f = crudo / pot;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return m * pot;
}

/**
 * Una barra con su extremo de DATO redondeado (4 px) y el de la línea base recto. `y0` es la
 * línea base, `y1` el valor: si `y1 > y0` la barra crece hacia abajo (valor negativo).
 */
function caminoBarra(x: number, w: number, y0: number, y1: number): string {
  const h = Math.abs(y1 - y0);
  if (h < 0.5 || w <= 0) return "";
  const r = Math.min(4, w / 2, h);
  if (y1 <= y0) {
    return `M${x},${y0} V${y1 + r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 + r} V${y0} Z`;
  }
  return `M${x},${y0} V${y1 - r} Q${x},${y1} ${x + r},${y1} H${x + w - r} Q${x + w},${y1} ${x + w},${y1 - r} V${y0} Z`;
}

const sinDato = (p: PuntoSerie | undefined) => !!p && (p.valor === null || !Number.isFinite(p.valor));

function rangoTexto(s: PuntoSerie[]): string {
  if (!s.length) return "";
  const a = s[0].fecha, b = s[s.length - 1].fecha;
  return a === b ? fmtFechaCorta(a) : `${fmtFechaCorta(a)} – ${fmtFechaCorta(b)}`;
}

export default function SerieComparada({
  actual, previa, unidad, etiquetas, formatear, cargando = false, vacio = "Sin datos en el periodo",
}: {
  /** El periodo que se mira, un elemento por día, en orden. */
  actual: PuntoSerie[];
  /** El periodo contra el que se compara. Su día i se pinta junto al día i de `actual`. */
  previa: PuntoSerie[];
  /** La unidad de la métrica ("km", "servicios", "h", "kg CO₂"…). Rotula el eje y el tooltip. */
  unidad: string;
  /** Cómo se llama cada periodo en la leyenda ("Últimos 7 días", "7 días anteriores"). */
  etiquetas: { actual: string; previa: string };
  /** Formato del valor en el tooltip. Por defecto: el número y la unidad ("1 234 km"). */
  formatear?: (v: number) => string;
  /** Mientras se mide: sin datos dice "Midiendo…" (nunca afirma un vacío); con datos los atenúa. */
  cargando?: boolean;
  /** El texto del vacío cuando ya se midió y no hay nada que pintar. */
  vacio?: string;
}) {
  const [ref, ancho] = useAnchoMedido<HTMLDivElement>();
  const fmtValor = formatear ?? ((v: number) => `${fmtNumero(v)} ${unidad}`);

  const n = Math.max(actual.length, previa.length);
  const valores: number[] = [];
  for (const p of [...actual, ...previa]) {
    if (p.valor !== null && Number.isFinite(p.valor)) valores.push(p.valor);
  }
  const hayDatos = valores.length > 0;
  const haySinDato = actual.some(sinDato) || previa.some(sinDato);

  const leyenda = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-600">
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block w-2.5 h-2.5 rounded-[2px]" style={{ background: AZUL }} />
        <b className="text-gray-700">{etiquetas.actual}</b>
        {actual.length > 0 && <span className="text-gray-400">({rangoTexto(actual)})</span>}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block w-2.5 h-2.5 rounded-[2px]" style={{ background: GRIS }} />
        <span>{etiquetas.previa}</span>
        {previa.length > 0 && <span className="text-gray-400">({rangoTexto(previa)})</span>}
      </span>
      {haySinDato && (
        <span className="inline-flex items-center gap-1.5 text-gray-500">
          <svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="3" fill={SUPERFICIE} stroke={EJE_HUECO} strokeWidth={1.5} /></svg>
          sin dato (no es cero)
        </span>
      )}
    </div>
  );

  if (!hayDatos) {
    return (
      <div ref={ref} className="space-y-2">
        {leyenda}
        <div className="h-24 flex items-center justify-center text-xs text-gray-400 bg-gray-50 rounded-xl px-4 text-center">
          {cargando ? "Midiendo…" : vacio}
        </div>
      </div>
    );
  }

  // Dominio: siempre incluye el 0 (las barras crecen desde la línea base).
  const vMax = Math.max(0, ...valores);
  const vMin = Math.min(0, ...valores);
  const paso = pasoLimpio(vMax - vMin || 1);
  const techo = vMax > 0 ? Math.ceil(vMax / paso) * paso : 0;
  const piso = vMin < 0 ? Math.floor(vMin / paso) * paso : 0;
  const marcas: number[] = [];
  for (let m = piso; m <= techo + paso / 2; m += paso) marcas.push(Math.round(m / paso) * paso);
  if (marcas.length < 2) marcas.push(piso + paso);
  const domMax = marcas[marcas.length - 1];
  const domMin = marcas[0];

  const W = Math.max(240, ancho);
  const H = ALTO;
  const anchoEje = Math.max(...marcas.map((m) => fmtEje(m).length)) * 6 + 8;
  const padL = anchoEje, padR = 12, padT = 18, padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const y = (v: number) => padT + plotH * (1 - (v - domMin) / (domMax - domMin || 1));
  const y0 = y(0);

  const banda = plotW / Math.max(1, n);
  // El par de un día ocupa el 70 % de su banda: el 30 % de aire es lo que separa un día del
  // siguiente (si no, con 31 días no se sabe qué barra gris va con qué barra azul).
  const anchoBarra = Math.max(1, Math.min(BARRA_MAX, (banda * 0.7 - HUECO) / 2));
  const grupo = anchoBarra * 2 + HUECO;

  // Rótulos del eje X: uno cada `cada` días, para que no se pisen (~40 px por rótulo).
  const cada = Math.max(1, Math.ceil(40 / banda));

  return (
    <div ref={ref} className="space-y-2" style={{ opacity: cargando ? 0.5 : 1, transition: "opacity .2s" }}>
      {leyenda}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" style={{ display: "block", overflow: "visible" }}
        aria-label={`${etiquetas.actual} contra ${etiquetas.previa}, en ${unidad}`}>
        {/* Unidad del eje, arriba a la izquierda. */}
        <text x={0} y={10} fontSize={10} fill={TINTA_SUAVE}>{unidad}</text>

        {/* Rejilla: líneas finas, sólidas y tenues. */}
        {marcas.map((m) => (
          <g key={m}>
            <line x1={padL} x2={W - padR} y1={y(m)} y2={y(m)} stroke={m === 0 ? EJE : REJILLA} strokeWidth={1} />
            <text x={padL - 6} y={y(m) + 3} textAnchor="end" fontSize={10} fill={TINTA_SUAVE}
              style={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtEje(m)}
            </text>
          </g>
        ))}

        {Array.from({ length: n }, (_, i) => {
          const pa = actual[i];
          const pp = previa[i];
          const x0 = padL + i * banda + (banda - grupo) / 2;
          const etiquetaDia = pa ? fmtFechaLarga(pa.fecha) : `día ${i + 1}`;
          const linea = (nombre: string, p: PuntoSerie | undefined) =>
            p ? `${nombre} (${fmtFechaLarga(p.fecha)}): ${p.valor === null ? "sin dato" : fmtValor(p.valor)}`
              : `${nombre}: no tiene día ${i + 1}`;
          const resumenDia = `Día ${i + 1} · ${etiquetaDia}\n${linea(etiquetas.actual, pa)}\n${linea(etiquetas.previa, pp)}`;
          const barra = (p: PuntoSerie | undefined, x: number, color: string, nombre: string) => {
            if (!p || p.valor === null || !Number.isFinite(p.valor)) return null;
            const d = caminoBarra(x, anchoBarra, y0, y(p.valor));
            if (!d) return null;
            return (
              <path d={d} fill={color}>
                <title>{`${nombre} · ${fmtFechaLarga(p.fecha)}: ${fmtValor(p.valor)}`}</title>
              </path>
            );
          };
          return (
            <g key={i}>
              {/* Objetivo de hover del día entero, DETRÁS de las barras: sobre el hueco dice los
                  dos valores; sobre una barra manda el tooltip de esa barra. */}
              <rect x={padL + i * banda} y={padT} width={banda} height={plotH} fill="transparent">
                <title>{resumenDia}</title>
              </rect>
              {barra(pa, x0, AZUL, etiquetas.actual)}
              {barra(pp, x0 + anchoBarra + HUECO, GRIS, etiquetas.previa)}
              {/* Un día sin dato se marca en la base con un círculo hueco: "no se midió". Un cero
                  no lleva nada, porque es un dato (la barra mide 0). */}
              {sinDato(pa) && <circle cx={x0 + anchoBarra / 2} cy={y0 - 4} r={2.5} fill={SUPERFICIE} stroke={EJE_HUECO} strokeWidth={1.5} />}
              {sinDato(pp) && <circle cx={x0 + anchoBarra + HUECO + anchoBarra / 2} cy={y0 - 4} r={2.5} fill={SUPERFICIE} stroke={EJE_HUECO} strokeWidth={1.5} />}
              {i % cada === 0 && (
                <text x={padL + i * banda + banda / 2} y={H - 6} textAnchor="middle" fontSize={10} fill={TINTA_SUAVE}>
                  {pa ? fmtFechaCorta(pa.fecha) : `d${i + 1}`}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
