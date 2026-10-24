"use client";
// components/licitaciones/editor/bases/ui.tsx — Piezas de pantalla del paso «Bases y requisitos».
import type { ReactNode } from "react";

export const INPUT =
  "w-full rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#0b315f]/30 focus:border-[#0b315f] disabled:bg-gray-50 disabled:text-gray-500";
export const BOTON =
  "px-3 py-1.5 rounded-lg border text-xs font-bold bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed";
export const BOTON_PRIMARIO =
  "px-3 py-2 rounded-lg text-xs font-bold text-white bg-[#0b315f] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed";

export function Tarjeta({ id, titulo, subtitulo, acciones, children }: {
  id?: string; titulo: ReactNode; subtitulo?: ReactNode; acciones?: ReactNode; children: ReactNode;
}) {
  return (
    <section id={id} className="bg-white rounded-2xl border shadow-sm p-4 md:p-5 space-y-3 scroll-mt-4 transition-shadow">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-gray-800">{titulo}</h2>
          {subtitulo && <p className="text-xs text-gray-500 mt-0.5">{subtitulo}</p>}
        </div>
        {acciones && <div className="flex items-center gap-2 flex-wrap">{acciones}</div>}
      </div>
      {children}
    </section>
  );
}

export function Campo({ etiqueta, ayuda, error, children, className }: {
  etiqueta: ReactNode; ayuda?: ReactNode; error?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <label className={`block min-w-0 ${className ?? ""}`}>
      <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1">{etiqueta}</span>
      {children}
      {error ? <span className="block text-[11px] text-red-700 mt-0.5">{error}</span>
        : ayuda ? <span className="block text-[11px] text-gray-400 mt-0.5">{ayuda}</span> : null}
    </label>
  );
}

export function Chip({ texto, color, bg, title }: { texto: ReactNode; color: string; bg: string; title?: string }) {
  return <span title={title} className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded-md whitespace-nowrap" style={{ color, background: bg }}>{texto}</span>;
}

/** Recorta a un máximo de caracteres completos (para inputs con tope). */
export function aTope(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join("");
}

/** Texto normalizado para comparar (sin tildes, minúsculas, espacios colapsados). */
export function claveTexto(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
