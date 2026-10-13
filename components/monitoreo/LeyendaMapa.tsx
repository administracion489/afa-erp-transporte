"use client";
// components/monitoreo/LeyendaMapa.tsx — qué significa cada color del mapa.
// Los colores salen de COLOR_CLASE y los minutos de las constantes del motor (EN_LINEA_MIN,
// SENAL_PERDIDA_MIN): si el motor cambia un umbral, la leyenda lo dice sola.
// En celular nace plegada (botón «ⓘ»); en escritorio, abierta. Las dos se pueden plegar.

import { COLOR_CLASE, EN_LINEA_MIN, SENAL_PERDIDA_MIN, ETIQUETA_CLASE } from "@/lib/monitoreo-estado";
import { IconVeh } from "./ListaUnidades";

type Props = {
  /** null = el defecto de cada pantalla (abierta en escritorio, plegada en celular). */
  abierta: boolean | null;
  onAbierta: (v: boolean) => void;
};

const FILAS = [
  { color: COLOR_CLASE.vivo, titulo: ETIQUETA_CLASE.vivo, texto: `Posición de hace ${EN_LINEA_MIN} min o menos` },
  { color: COLOR_CLASE.demora, titulo: ETIQUETA_CLASE.demora, texto: `En servicio, entre ${EN_LINEA_MIN} y ${SENAL_PERDIDA_MIN} min sin posición nueva` },
  { color: COLOR_CLASE.atender, titulo: ETIQUETA_CLASE.atender, texto: `SOS, servicio sin iniciar, o en servicio y más de ${SENAL_PERDIDA_MIN} min sin señal` },
  { color: COLOR_CLASE.reposo, titulo: "Gris", texto: "Sin servicio en curso: su última posición conocida, con la edad" },
];

export default function LeyendaMapa({ abierta, onAbierta }: Props) {
  const clasePanel = abierta == null ? "hidden md:block" : abierta ? "block" : "hidden";
  const claseBoton = abierta == null ? "md:hidden" : abierta ? "hidden" : "";
  return (
    // Abierta en celular, sube por encima de los botones flotantes de ELIA y de la ayuda.
    <div className={"absolute bottom-9 left-2 md:left-3 z-10 max-w-[calc(100%-1rem)]" + (abierta ? " max-md:bottom-24" : "")}>
      <button
        type="button"
        onClick={() => onAbierta(true)}
        className={claseBoton + " w-11 h-11 rounded-xl flex items-center justify-center text-lg font-black text-slate-200 shadow-lg border border-slate-600"}
        style={{ background: "rgba(15,23,42,0.92)" }}
        aria-label="Ver la leyenda de colores"
        title="Leyenda"
      >
        ⓘ
      </button>
      <div className={clasePanel + " rounded-xl px-3 py-2.5 text-xs w-72 max-w-full shadow-xl border border-slate-700"} style={{ background: "rgba(15,23,42,0.95)" }}>
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <p className="text-slate-400 font-bold uppercase tracking-wide text-[10px]">Qué significa cada color</p>
          <button
            type="button"
            onClick={() => onAbierta(false)}
            className="w-8 h-8 -mr-1.5 -my-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/60"
            aria-label="Plegar la leyenda"
          >
            ✕
          </button>
        </div>
        <div className="space-y-1.5">
          {FILAS.map((f) => (
            <div key={f.titulo} className="flex items-start gap-2">
              <span className="w-2.5 h-2.5 rounded-full mt-1 shrink-0" style={{ background: f.color }} />
              <span className="text-slate-300 leading-snug"><b className="text-white">{f.titulo}</b> · {f.texto}</span>
            </div>
          ))}
        </div>
        <div className="pt-1.5 mt-2 border-t border-slate-700 space-y-1">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded flex items-center justify-center shrink-0" style={{ background: COLOR_CLASE.vivo }}><IconVeh cat="BUS" size={16} /></span>
            <span className="text-slate-400">El ícono es el tipo de unidad</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[8px] font-black px-1 rounded shrink-0" style={{ background: "#f59e0b", color: "#3a2606" }}>3P</span>
            <span className="text-slate-400">Unidad de un proveedor tercerizado</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded flex items-center justify-center shrink-0" style={{ background: COLOR_CLASE.vivo }}>
              <svg viewBox="0 0 24 24" width="13" height="13"><circle cx="12" cy="8" r="4" fill="#fff" /><path d="M4 21 C4 15.5 7.6 13 12 13 C16.4 13 20 15.5 20 21 Z" fill="#fff" /></svg>
            </span>
            <span className="text-slate-400">Conductor conectado sin unidad asignada</span>
          </div>
          <p className="text-slate-500 text-[10.5px] leading-snug">Con el mapa alejado, las placas de las grises se ocultan; acerca para verlas.</p>
        </div>
      </div>
    </div>
  );
}
