"use client";
// ──────────────────────────────────────────────────────────────────────────────
// ChipEtiquetas — "🏷 RUTA A · T1 · M2 · 50 PAX": las etiquetas que deciden el ítem de
// la liquidación, leídas del DÍA (la ida y su retorno), con los PAX contratados al lado.
//
// Solo se pinta cuando hay etiquetas: un «sin etiqueta» en cada fila de Programación se
// volvería paisaje, y el cierre de Liquidaciones ya dice cuántos faltan.
// ──────────────────────────────────────────────────────────────────────────────
import {
  etiquetasDelDia, rotuloEtiquetas, type TramoConEtiquetas,
} from "@/lib/liquidacion-etiquetas";

export default function ChipEtiquetas({
  tramos, pax, className = "",
}: {
  /** El tramo y, si se conoce, su hermano: las etiquetas son del día. La ida primero. */
  tramos: (TramoConEtiquetas | null | undefined)[];
  /** PAX contratados resueltos (la cascada de siempre). Solo se enseñan. */
  pax?: number | null;
  className?: string;
}) {
  const { etiquetas, conflicto } = etiquetasDelDia(tramos);
  if (!etiquetas) return null;
  const titulo =
    `Ítem de liquidación: ${etiquetas.ruta} · TURNO ${etiquetas.turno}` +
    (etiquetas.movil ? ` · MÓVIL ${etiquetas.movil}` : "") +
    (pax ? ` · ${pax} PAX contratados` : "") +
    "\nLos servicios con las mismas etiquetas, tarifa y PAX van en UN solo ítem aunque cambie la hora." +
    (conflicto
      ? `\n⚠ La ida y el retorno tienen etiquetas distintas (${rotuloEtiquetas(conflicto.gana)} / ${rotuloEtiquetas(conflicto.pierde)}): manda la ida. Iguálalas con 🏷 Etiquetas.`
      : "");
  return (
    <span title={titulo}
      className={`inline-flex items-center gap-1 text-[9px] font-black px-1.5 py-0.5 rounded-full whitespace-nowrap ${className}`}
      style={conflicto ? { background: "#fef3c7", color: "#92400e" } : { background: "#e0f2fe", color: "#075985" }}>
      🏷 {rotuloEtiquetas(etiquetas, pax)}{conflicto ? " ⚠" : ""}
    </span>
  );
}
