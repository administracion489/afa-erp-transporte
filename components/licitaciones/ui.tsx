"use client";
// components/licitaciones/ui.tsx — Piezas de pantalla que comparten las pestañas de /licitaciones
// (lista, legajo y experiencia). No decide nada del negocio: pinta lo que le dan.
//
//  · <Modal>: el del ERP (fondo oscuro, tarjeta blanca, cabecera fija). Esc y el fondo cierran,
//    salvo mientras `ocupado` (cerrar a mitad de una subida dejaría la pantalla diciendo que no
//    pasó nada sobre algo que sí se escribió).
//  · <AvisoFallo>: un resultado ok:false de lib/licitaciones/datos.ts. La migración que falta va en
//    ÁMBAR nombrando el SQL; la falta de permiso dice qué módulo; lo demás es un error con
//    «Reintentar». Nunca se convierte en «no hay datos».
//  · useAviso: un aviso breve (toast) para lo que YA salió bien. Lo que falla o falta se dice fijo
//    en la pantalla, no en un toast que se va.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { FalloDatos } from "@/lib/licitaciones/datos";

export const AZUL = "#0b315f";

export const claseCampo =
  "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] disabled:bg-gray-50 disabled:text-gray-400";
export const claseEtiqueta = "block text-xs font-bold text-gray-600 mb-1";
export const claseBotonPrimario =
  "px-4 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]";
export const claseBotonSecundario =
  "px-4 py-2.5 rounded-xl font-bold text-sm border border-gray-200 text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]";
export const claseBotonChico =
  "px-2.5 py-1.5 rounded-lg text-xs font-bold border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap";

export function Modal({ titulo, subtitulo, onCerrar, ocupado, children, pie, ancho = "max-w-2xl" }: {
  titulo: string; subtitulo?: ReactNode; onCerrar: () => void; ocupado?: boolean;
  children: ReactNode; pie?: ReactNode; ancho?: string;
}) {
  // Esc cierra, salvo mientras se escribe en la base.
  const cerrar = useRef(onCerrar);
  useEffect(() => { cerrar.current = onCerrar; }, [onCerrar]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !ocupado) cerrar.current(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [ocupado]);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-2 sm:p-4"
      onClick={() => { if (!ocupado) onCerrar(); }}>
      <div role="dialog" aria-modal="true" aria-label={titulo}
        className={`bg-white rounded-2xl shadow-xl w-full ${ancho} max-h-[94vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 px-4 sm:px-5 py-4 border-b">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-gray-900">{titulo}</h2>
            {subtitulo && <div className="text-xs text-gray-500 mt-0.5">{subtitulo}</div>}
          </div>
          <button type="button" onClick={onCerrar} disabled={ocupado} aria-label="Cerrar"
            className="w-10 h-10 flex-shrink-0 rounded-xl text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-30">✕</button>
        </div>
        <div className="px-4 sm:px-5 py-4 overflow-y-auto flex-1">{children}</div>
        {pie && <div className="px-4 sm:px-5 py-3 border-t bg-gray-50 rounded-b-2xl">{pie}</div>}
      </div>
    </div>
  );
}

/** Un fallo de la capa de datos dicho en la pantalla, con su arreglo. */
export function AvisoFallo({ fallo, onReintentar, que }: { fallo: FalloDatos; onReintentar?: () => void; que?: string }) {
  if (fallo.sinMigracion) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 space-y-1">
        <p className="font-bold">⚠️ Falta correr una migración en la base{que ? ` para ${que}` : ""}</p>
        <p className="text-xs">{fallo.error}</p>
        <p className="text-xs">
          Hay que correr <code className="font-mono bg-amber-100 px-1 rounded">{fallo.sinMigracion}</code> en Supabase → SQL Editor. Hasta entonces esta parte no se puede usar; el resto del ERP sigue igual.
        </p>
        {onReintentar && <button type="button" onClick={onReintentar} className="underline font-bold text-xs">Volver a comprobar</button>}
      </div>
    );
  }
  if (fallo.sinPermiso) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 space-y-1">
        <p className="font-bold">🔒 Sin permiso{que ? ` para ${que}` : ""}</p>
        <p className="text-xs">{fallo.error}</p>
        {onReintentar && <button type="button" onClick={onReintentar} className="underline font-bold text-xs">Reintentar</button>}
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 space-y-1">
      <p className="font-bold">🚨 No se pudo leer{que ? ` ${que}` : ""}</p>
      <p className="text-xs">{fallo.error}</p>
      <p className="text-xs">Mientras no se lea, la pantalla no afirma que falte nada.</p>
      {onReintentar && (
        <button type="button" onClick={onReintentar} className="mt-1 px-3 py-1.5 rounded-lg text-xs font-bold bg-white border border-red-300 text-red-800 hover:bg-red-100">
          ↻ Reintentar
        </button>
      )}
    </div>
  );
}

/** Mensaje de error fijo dentro de un formulario (no un toast). */
export function ErrorFijo({ texto }: { texto: string | null }) {
  if (!texto) return null;
  return <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{texto}</p>;
}

export function Cargando({ texto }: { texto: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-sm text-gray-400">
      <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
      {texto}
    </div>
  );
}

export type TonoChip = "rojo" | "ambar" | "verde" | "gris" | "azul";
const TONOS: Record<TonoChip, { bg: string; c: string }> = {
  rojo: { bg: "#fee2e2", c: "#991b1b" },
  ambar: { bg: "#fef3c7", c: "#92400e" },
  verde: { bg: "#dcfce7", c: "#166534" },
  gris: { bg: "#f3f4f6", c: "#4b5563" },
  azul: { bg: "#e0e7ef", c: AZUL },
};
export function Chip({ tono, children, title }: { tono: TonoChip; children: ReactNode; title?: string }) {
  const t = TONOS[tono];
  return (
    <span title={title} className="inline-block text-[11px] font-bold px-2 py-0.5 rounded-lg whitespace-nowrap" style={{ background: t.bg, color: t.c }}>
      {children}
    </span>
  );
}

/** Aviso breve para lo que ya salió bien. */
export function useAviso() {
  const [aviso, setAviso] = useState<{ texto: string; n: number } | null>(null);
  const reloj = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mostrar = useCallback((texto: string) => {
    if (reloj.current) clearTimeout(reloj.current);
    setAviso((a) => ({ texto, n: (a?.n ?? 0) + 1 }));
    reloj.current = setTimeout(() => setAviso(null), 4500);
  }, []);
  useEffect(() => () => { if (reloj.current) clearTimeout(reloj.current); }, []);
  const nodo = aviso ? (
    <div role="status" aria-live="polite"
      className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[60] max-w-[92vw] rounded-xl px-4 py-3 text-sm font-bold text-white shadow-lg"
      style={{ background: "#166534" }}>
      ✓ {aviso.texto}
    </div>
  ) : null;
  return { mostrar, nodo };
}
