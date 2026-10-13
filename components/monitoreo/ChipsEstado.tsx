"use client";
// components/monitoreo/ChipsEstado.tsx — cuántas unidades hay en cada clase, y filtro por clase.
// Los números salen de `resumenFlota` (lib/monitoreo-estado.ts) y las etiquetas y colores, de
// ETIQUETA_CLASE / COLOR_CLASE: la pantalla no redacta ni elige colores de estado.
// Un clic deja solo esa clase (en la lista Y en el mapa); otro clic sobre la misma, todas.
// Una clase en 0 se pinta neutra: un «0 Atender» en rojo saldría todo el día y se volvería paisaje.

import { CLASES_MONITOREO, COLOR_CLASE, ETIQUETA_CLASE, type ClaseMonitoreo } from "@/lib/monitoreo-estado";

type Props = {
  /** null mientras la primera lectura no terminó (se muestra «…», nunca un 0). */
  resumen: Record<ClaseMonitoreo, number> | null;
  filtro: ClaseMonitoreo | null;
  onFiltro: (c: ClaseMonitoreo | null) => void;
  /** «panel»: envuelve en filas (escritorio). «fila»: una sola fila con scroll horizontal (celular). */
  variante: "panel" | "fila";
};

export default function ChipsEstado({ resumen, filtro, onFiltro, variante }: Props) {
  return (
    <div
      role="group"
      aria-label="Filtrar por estado"
      className={variante === "fila"
        ? "flex gap-2 overflow-x-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        : "flex flex-wrap gap-1.5"}
    >
      {CLASES_MONITOREO.map((c) => {
        const n = resumen ? resumen[c] : null;
        const activo = filtro === c;
        const color = COLOR_CLASE[c];
        const vivo = n != null && n > 0;
        // Gris: el texto se aclara para que se lea sobre fondo oscuro.
        const tinta = c === "reposo" || c === "sin_dato" ? "#cbd5e1" : color;
        return (
          <button
            key={c}
            type="button"
            aria-pressed={activo}
            onClick={() => onFiltro(activo ? null : c)}
            title={activo ? "Quitar el filtro" : `Ver solo: ${ETIQUETA_CLASE[c]}`}
            className={(variante === "fila" ? "min-h-11 px-3.5 shrink-0" : "min-h-9 px-2.5") +
              " inline-flex items-center gap-1.5 rounded-xl border text-xs font-bold transition-colors whitespace-nowrap"}
            style={{
              background: activo ? color + "33" : vivo ? color + "14" : "#1e293b",
              borderColor: activo ? color : vivo ? color + "55" : "#334155",
              color: vivo || activo ? tinta : "#64748b",
            }}
          >
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: vivo || activo ? color : "#475569" }} />
            <span className="font-black tabular-nums">{n ?? "…"}</span>
            <span>{ETIQUETA_CLASE[c]}</span>
          </button>
        );
      })}
    </div>
  );
}
