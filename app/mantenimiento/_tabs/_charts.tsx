"use client";

// Gráficos SVG mínimos (sin dependencias externas — el proyecto no trae librería de
// charts). Todo se dibuja con viewBox responsive y colores de la paleta AFA.

import React from "react";

const AZUL = "#0b315f";

function fmt(n: number) {
  return Math.round(n).toLocaleString("es-PE");
}

// ─── Barras verticales (serie de tiempo: km por día) ─────────────────────────

export function BarrasVertical({
  data,
  height = 160,
  color = AZUL,
  unidad = "km",
}: {
  data: { label: string; value: number; resaltar?: "max" | "min" | null }[];
  height?: number;
  color?: string;
  unidad?: string;
}) {
  if (!data.length) return <VacioChart />;
  const W = Math.max(320, data.length * 26);
  const H = height;
  const padB = 26, padT = 14, padL = 4, padR = 4;
  const max = Math.max(1, ...data.map((d) => d.value));
  const bw = (W - padL - padR) / data.length;
  const escala = (v: number) => (H - padB - padT) * (v / max);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: Math.min(W, 640), maxWidth: W }} role="img">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={padL} x2={W - padR} y1={padT + (H - padB - padT) * (1 - f)} y2={padT + (H - padB - padT) * (1 - f)}
            stroke="#eef2f7" strokeWidth={1} />
        ))}
        {data.map((d, i) => {
          const h = escala(d.value);
          const x = padL + i * bw + bw * 0.15;
          const y = H - padB - h;
          const c = d.resaltar === "max" ? "#166534" : d.resaltar === "min" ? "#b45309" : color;
          return (
            <g key={i}>
              <rect x={x} y={y} width={bw * 0.7} height={Math.max(0, h)} rx={2} fill={c}>
                <title>{`${d.label}: ${fmt(d.value)} ${unidad}`}</title>
              </rect>
              {data.length <= 16 && (
                <text x={x + bw * 0.35} y={H - padB + 12} textAnchor="middle" fontSize={8} fill="#94a3b8">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Barras horizontales (ranking: conductor / cliente / ruta / comparativo) ──

export function BarrasHorizontal({
  data,
  color = AZUL,
  unidad = "km",
  max: maxProp,
}: {
  data: { label: string; value: number; sub?: string }[];
  color?: string;
  unidad?: string;
  max?: number;
}) {
  if (!data.length) return <VacioChart />;
  const max = Math.max(1, maxProp ?? Math.max(...data.map((d) => d.value)));
  return (
    <div className="space-y-1.5">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <div className="w-32 shrink-0 truncate text-gray-600" title={d.label}>{d.label}</div>
          <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
            <div className="h-full rounded-full flex items-center justify-end pr-1.5" style={{ width: `${Math.max(3, (d.value / max) * 100)}%`, background: color }}>
              <span className="text-[9px] font-bold text-white whitespace-nowrap">{fmt(d.value)}</span>
            </div>
          </div>
          <div className="w-14 shrink-0 text-right text-gray-400 tabular-nums">{d.sub || `${unidad}`}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Línea de tendencia (semanas / meses) ────────────────────────────────────

export function LineaTendencia({
  data,
  height = 150,
  color = "#0f766e",
  unidad = "km",
}: {
  data: { label: string; value: number }[];
  height?: number;
  color?: string;
  unidad?: string;
}) {
  if (data.length < 2) return <VacioChart texto="Datos insuficientes para la tendencia" />;
  const W = Math.max(320, data.length * 60);
  const H = height;
  const padB = 24, padT = 14, padX = 24;
  const max = Math.max(1, ...data.map((d) => d.value));
  const dx = (W - padX * 2) / (data.length - 1);
  const px = (i: number) => padX + i * dx;
  const py = (v: number) => padT + (H - padB - padT) * (1 - v / max);
  const puntos = data.map((d, i) => `${px(i)},${py(d.value)}`).join(" ");

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: Math.min(W, 640), maxWidth: W }} role="img">
        {[0.5, 1].map((f) => (
          <line key={f} x1={padX} x2={W - padX} y1={py(max * f)} y2={py(max * f)} stroke="#eef2f7" strokeWidth={1} />
        ))}
        <polyline points={puntos} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => (
          <g key={i}>
            <circle cx={px(i)} cy={py(d.value)} r={3} fill={color}>
              <title>{`${d.label}: ${fmt(d.value)} ${unidad}`}</title>
            </circle>
            <text x={px(i)} y={H - padB + 14} textAnchor="middle" fontSize={8} fill="#94a3b8">{d.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function VacioChart({ texto = "Sin datos en el período" }: { texto?: string }) {
  return (
    <div className="h-24 flex items-center justify-center text-xs text-gray-400 bg-gray-50 rounded-xl">
      {texto}
    </div>
  );
}
