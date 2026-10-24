"use client";
// components/licitaciones/editor/ModalConflicto.tsx — «Otra persona guardó» (decisión R1). No se fusiona
// nada: o se recarga la versión de la otra persona (lo local se pierde, con confirm) o lo local se guarda
// como OTRA licitación. Cerrar no guarda nada: el guardado automático queda detenido hasta decidir.
import { useState } from "react";
import type { Conflicto } from "./useEdicionLicitacion";
import { instanteLima } from "./etiquetas";

type Props = {
  conflicto: Conflicto;
  nombre: string;
  onRecargar: () => Promise<string | null>;   // null = bien; texto = error
  onCopia: () => Promise<string | null>;
  onCerrar: () => void;
};

export default function ModalConflicto({ conflicto, nombre, onRecargar, onCopia, onCerrar }: Props) {
  const [ocupado, setOcupado] = useState<"recargar" | "copia" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const quien = conflicto.por || "otra persona";

  const correr = async (cual: "recargar" | "copia") => {
    if (cual === "recargar" && !window.confirm(
      `Se descartarán TUS cambios sin guardar de «${nombre}» y se abrirá la versión ${conflicto.version} que guardó ${quien} (${instanteLima(conflicto.en)}).\n\n¿Descartar lo tuyo y recargar?`,
    )) return;
    setOcupado(cual); setError(null);
    const e = cual === "recargar" ? await onRecargar() : await onCopia();
    setOcupado(null);
    if (e) setError(e);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="conflicto-titulo">
      <div className="bg-white rounded-2xl shadow-xl max-w-lg w-full p-5 space-y-4">
        <div className="space-y-1">
          <h2 id="conflicto-titulo" className="text-lg font-bold text-gray-900">Otra persona guardó esta licitación</h2>
          <p className="text-sm text-gray-600">
            <b>{quien}</b> guardó la versión {conflicto.version} el {instanteLima(conflicto.en)}, mientras tenías cambios sin guardar.
            Para no pisar su trabajo, el guardado automático se detuvo. <b>Nada se mezcla</b>: elige qué hacer con lo tuyo.
          </p>
        </div>
        <div className="space-y-2">
          <button type="button" disabled={!!ocupado} onClick={() => void correr("recargar")}
            className="w-full text-left rounded-xl border-2 border-gray-200 px-4 py-3 hover:bg-gray-50 disabled:opacity-60">
            <span className="block font-bold text-sm text-gray-900">{ocupado === "recargar" ? "Recargando…" : `Recargar la versión de ${quien}`}</span>
            <span className="block text-xs text-gray-500">Se pierden tus cambios sin guardar. Se te pedirá confirmación.</span>
          </button>
          <button type="button" disabled={!!ocupado} onClick={() => void correr("copia")}
            className="w-full text-left rounded-xl border-2 border-[#0b315f33] bg-[#eef3f8] px-4 py-3 hover:bg-[#e2eaf3] disabled:opacity-60">
            <span className="block font-bold text-sm text-[#0b315f]">{ocupado === "copia" ? "Guardando la copia…" : "Guardar lo mío como copia"}</span>
            <span className="block text-xs text-gray-600">
              Crea otra licitación, «{nombre} (copia)», con tus datos y tu documento, y te lleva a ella. La original queda como la dejó {quien}.
              Las bases subidas a la original siguen siendo de ella: para leerlas con IA en la copia, vuelve a subirlas allí.
            </span>
          </button>
        </div>
        {error && <p className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
        <div className="flex justify-end">
          <button type="button" disabled={!!ocupado} onClick={onCerrar} className="text-xs font-bold text-gray-500 underline disabled:opacity-60">
            Cerrar sin decidir (no se guarda nada)
          </button>
        </div>
      </div>
    </div>
  );
}
