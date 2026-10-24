"use client";
// components/licitaciones/editor/expediente/ui.tsx — Piezas de pantalla del paso «Expediente». No deciden
// nada del negocio: pintan lo que les dan. Viven aparte de las de otros pasos para no pisarse.
//
//  · Un campo de texto enseña lo tecleado mientras tiene el foco, aunque el doc vuelva normalizado (sin
//    espacios al final): si no, escribir «Sección II » sería imposible.
//  · Rojo = hay que actuar · ámbar = cambia lo que hace el sistema · gris/azul = informativo.
import { useState, type ReactNode } from "react";

export type Tono = "rojo" | "ambar" | "verde" | "gris" | "azul";
const TONO: Record<Tono, string> = {
  rojo: "bg-red-50 text-red-700 border-red-200",
  ambar: "bg-amber-50 text-amber-800 border-amber-200",
  verde: "bg-emerald-50 text-emerald-700 border-emerald-200",
  gris: "bg-gray-100 text-gray-600 border-gray-200",
  azul: "bg-[#eef3f8] text-[#0b315f] border-[#d5e0ec]",
};

export function Chip({ tono, children, title }: { tono: Tono; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold ${TONO[tono]}`}>
      {children}
    </span>
  );
}

/** Caja de aviso FIJA (no un toast). */
export function Nota({ tono, children }: { tono: Tono; children: ReactNode }) {
  return <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${TONO[tono]}`}>{children}</div>;
}

export function Boton({ children, onClick, disabled, tono = "normal", title, chico }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; tono?: "normal" | "primario" | "peligro" | "suave"; title?: string; chico?: boolean;
}) {
  const base = chico ? "min-h-[36px] px-2.5 text-xs" : "min-h-[44px] px-3.5 text-sm";
  const estilos = {
    normal: "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
    primario: "border border-[#0b315f] bg-[#0b315f] text-white hover:bg-[#0a2a52]",
    peligro: "border border-red-200 bg-white text-red-700 hover:bg-red-50",
    suave: "border border-transparent text-[#0b315f] hover:bg-[#eef3f8]",
  }[tono];
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className={`inline-flex items-center justify-center gap-1 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${base} ${estilos}`}>
      {children}
    </button>
  );
}

/** Botón cuadrado de un ícono (↑ ↓ ⧉ ✕): el título es también la etiqueta accesible. */
export function BotonIcono({ children, onClick, disabled, title, peligro }: { children: ReactNode; onClick?: () => void; disabled?: boolean; title: string; peligro?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} aria-label={title}
      className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-sm transition disabled:cursor-not-allowed disabled:opacity-30 ${peligro ? "border-red-200 text-red-600 hover:bg-red-50" : "border-gray-200 text-gray-600 hover:bg-gray-100"}`}>
      {children}
    </button>
  );
}

export const claseCampo = "w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[#0b315f] focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 disabled:bg-gray-50 disabled:text-gray-500";

/**
 * Texto del doc. Mientras tiene el foco enseña lo tecleado. `alSalir`: solo se manda al salir del campo o
 * con Enter, y `validar` puede rechazarlo: no se manda, el campo vuelve a lo guardado y el motivo queda
 * FIJO debajo (nombrando lo que se rechazó).
 */
export function CampoTexto({ valor, onCambio, placeholder, maxLength, disabled, ariaLabel, alSalir, validar, id }: {
  valor: string; onCambio: (v: string) => void; placeholder?: string; maxLength?: number; disabled?: boolean; ariaLabel?: string;
  alSalir?: boolean; validar?: (v: string) => string | null; id?: string;
}) {
  const [local, setLocal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirmar = () => {
    if (local === null) return;
    if (alSalir) {
      const e = validar?.(local) ?? null;
      setError(e);
      if (!e && local !== valor) onCambio(local);
    }
    setLocal(null);
  };
  return (
    <div className="min-w-0">
      <input
        id={id} type="text" aria-label={ariaLabel} placeholder={placeholder} maxLength={maxLength} disabled={disabled}
        aria-invalid={error ? true : undefined}
        className={`${claseCampo} ${error ? "border-red-400" : ""}`}
        value={local ?? valor}
        onFocus={() => { if (local === null) setLocal(valor); }}
        onChange={(e) => { setLocal(e.target.value); if (!alSalir) onCambio(e.target.value); }}
        onBlur={confirmar}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
      />
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

export function Rotulo({ texto, children, ayuda }: { texto: string; children: ReactNode; ayuda?: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">{texto}</span>
      {children}
      {ayuda && <span className="mt-1 block text-[11px] text-gray-500">{ayuda}</span>}
    </label>
  );
}

export function Casilla({ marcado, cambiar, children, disabled, title }: { marcado: boolean; cambiar: (v: boolean) => void; children: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label title={title} className={`inline-flex min-h-[36px] items-center gap-2 text-sm ${disabled ? "text-gray-400" : "cursor-pointer text-gray-700"}`}>
      <input type="checkbox" className="h-4 w-4 accent-[#0b315f]" checked={marcado} disabled={disabled} onChange={(e) => cambiar(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export const claseSelect = `${claseCampo} pr-8`;
/** Un desplegable chico de acción (sin ancho completo): «Mover a…». */
export const claseSelectChico = "h-9 min-w-0 max-w-[11rem] rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 focus:border-[#0b315f] focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";
