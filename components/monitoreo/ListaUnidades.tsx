"use client";
// components/monitoreo/ListaUnidades.tsx — la lista de unidades de /monitoreo.
// Cada tarjeta pinta lo que dice su veredicto (color, etiqueta, detalle): no compone ningún estado.
// Una unidad con posición se toca para centrarla en el mapa; una sin posición (o cuya lectura
// falló) se ve en gris, con su motivo, y no es clicable: no hay a dónde llevar el mapa.

import { IconBuilding, IconBus } from "@/app/_components/icons";
import { CAT_LABEL, catKey, svgVehiculo } from "./marcadores";
import type { UnidadVista } from "./tipos";

export function IconVeh({ cat, size = 22, color = "#fff" }: { cat: string | null; size?: number; color?: string }) {
  return <span style={{ display: "inline-flex" }} dangerouslySetInnerHTML={{ __html: svgVehiculo(cat, size, color) }} />;
}

/** Texto legible sobre fondo oscuro para el color del veredicto (los grises se aclaran). */
function tintaDe(color: string, clase: string | undefined): string {
  return clase === "reposo" || clase === "sin_dato" ? "#94a3b8" : color;
}

type Props = {
  unidades: UnidadVista[];
  seleccion: string | null;
  onElegir: (clave: string) => void;
  /** Frase del vacío (la decide la página: depende de la búsqueda y los filtros). */
  vacio: string;
};

export default function ListaUnidades({ unidades, seleccion, onElegir, vacio }: Props) {
  if (unidades.length === 0) {
    return (
      <div className="text-center py-10 px-4 text-slate-500">
        <div className="flex justify-center mb-2"><IconBus size={34} color="#475569" /></div>
        <p className="text-xs">{vacio}</p>
      </div>
    );
  }
  return (
    <ul className="space-y-1.5">
      {unidades.map((u) => {
        const v = u.veredicto;
        const color = v?.color ?? "#64748b";
        const tinta = tintaDe(color, v?.clase);
        const clicable = v?.dibujar === true && u.posicion != null;
        const activo = seleccion === u.clave;
        const atender = v?.clase === "atender";
        const conductor = u.conductor?.nombre ? u.conductor.nombre.trim().split(/\s+/).slice(0, 2).join(" ") : null;
        return (
          <li key={u.clave}>
            <button
              type="button"
              data-unidad={u.clave}
              disabled={!clicable}
              onClick={() => clicable && onElegir(u.clave)}
              aria-current={activo ? "true" : undefined}
              title={clicable ? "Centrar en el mapa" : undefined}
              className="w-full text-left rounded-xl p-3 border transition-colors disabled:cursor-default enabled:hover:brightness-110"
              style={{
                background: activo ? "#1e3a5f" : atender ? "#1c0606" : "#1e293b",
                borderColor: activo ? "#3b82f6" : atender ? "#7f1d1d" : "#334155",
                opacity: clicable || !v ? 1 : 0.62,
              }}
            >
              <div className="flex items-start gap-2.5">
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
                  style={{ background: color + (v?.atenuado || !clicable ? "1a" : "2e") }}
                >
                  <IconVeh cat={u.categoria} size={24} color={v ? color : "#475569"} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-black text-white font-mono text-sm truncate">{u.placa}</span>
                    <span className="text-[10.5px] font-black shrink-0" style={{ color: v ? tinta : "#64748b" }}>
                      {v ? v.etiqueta : "…"}
                    </span>
                  </div>
                  <p className="text-[11px] leading-snug mt-0.5 line-clamp-2" style={{ color: v ? (atender ? "#fca5a5" : "#94a3b8") : "#64748b" }}>
                    {v ? v.detalle : "Comprobando posición…"}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    <span className="text-[11px] text-slate-400 truncate max-w-full">
                      {CAT_LABEL[catKey(u.categoria)]}{conductor ? " · " + conductor : ""}
                    </span>
                    {u.esTercero && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] font-black px-1.5 py-0.5 rounded-full shrink-0" style={{ background: "#3a2606", color: "#fbbf24" }}>
                        <IconBuilding size={9} color="#fbbf24" /> 3P
                      </span>
                    )}
                    {u.tipoServicio && (
                      <span
                        className="text-[9px] font-black px-1.5 py-0.5 rounded-full shrink-0"
                        style={{
                          background: u.tipoServicio === "eventual" ? "#1e1b4b" : "#0c1a2e",
                          color: u.tipoServicio === "eventual" ? "#a5b4fc" : "#60a5fa",
                        }}
                      >
                        {u.tipoServicio === "eventual" ? "Eventual" : "Fijo"}
                      </span>
                    )}
                  </div>
                  {u.proveedor && <p className="text-[10.5px] text-amber-500/80 truncate mt-0.5">{u.proveedor}</p>}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
