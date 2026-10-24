"use client";
// components/licitaciones/editor/recursos/comun.tsx — Piezas de pantalla que comparten las secciones del
// paso «Recursos». NO deciden nada del negocio: vigencias, orígenes y hallazgos vienen de los motores
// (lib/licitaciones/recursos, archivos, revision); aquí solo se pintan.
//
// Dos reglas que se repiten en todo el paso y por eso viven aquí:
//  · Un campo de texto muestra lo que se teclea mientras tiene el foco aunque el doc vuelva normalizado
//    (sin espacios al final): si no, escribir «Ruta A » sería imposible.
//  · Un enlace externo se pinta como enlace SOLO si es http(s): un `javascript:` guardado en una ficha
//    no llega nunca a un href.

import { useEffect, useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { EnlacePrivado } from "@/components/ArchivoPrivado";
import type { DondeSeCorrige, Gravedad, Hallazgo, OrigenArchivo, Paso } from "@/lib/licitaciones/tipos";
import type { EstadoDocUnidad } from "@/lib/licitaciones/recursos";
import { fechaDMY } from "@/lib/licitaciones/util";

// ══ Tonos ═══════════════════════════════════════════════════════════════════════
export type Tono = "rojo" | "ambar" | "verde" | "gris" | "azul";
const TONO: Record<Tono, string> = {
  rojo: "bg-red-50 text-red-700 border-red-200",
  ambar: "bg-amber-50 text-amber-800 border-amber-200",
  verde: "bg-emerald-50 text-emerald-700 border-emerald-200",
  gris: "bg-gray-100 text-gray-600 border-gray-200",
  azul: "bg-[#eef3f8] text-[#0b315f] border-[#d5e0ec]",
};
export const tonoDeGravedad = (g: Gravedad): Tono => (g === "alarma" ? "rojo" : g === "aviso" ? "ambar" : "gris");

export function Chip({ tono, children, title }: { tono: Tono; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TONO[tono]}`}>
      {children}
    </span>
  );
}

/** Caja de aviso fija (no un toast): ámbar = cambia lo que hace el sistema; rojo = hay que actuar. */
export function Nota({ tono, children }: { tono: Tono; children: ReactNode }) {
  return <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${TONO[tono]}`}>{children}</div>;
}

// ══ Sección con ancla ═══════════════════════════════════════════════════════════
export function Seccion({ id, titulo, subtitulo, acciones, children }: {
  id: string; titulo: string; subtitulo?: ReactNode; acciones?: ReactNode; children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 rounded-2xl border border-gray-200 bg-white p-3 sm:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-[#0b315f]">{titulo}</h2>
          {subtitulo && <div className="mt-0.5 text-xs text-gray-500">{subtitulo}</div>}
        </div>
        {acciones && <div className="flex flex-wrap items-center gap-2">{acciones}</div>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

// ══ Botones ═════════════════════════════════════════════════════════════════════
export function Boton({ children, onClick, disabled, tono = "normal", title, type = "button", chico }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; tono?: "normal" | "primario" | "peligro" | "suave";
  title?: string; type?: "button" | "submit"; chico?: boolean;
}) {
  const base = chico ? "min-h-[32px] px-2 text-xs" : "min-h-[40px] px-3 text-sm";
  const estilos = {
    normal: "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
    primario: "bg-[#0b315f] text-white hover:bg-[#0a2a52]",
    peligro: "border border-red-200 bg-white text-red-700 hover:bg-red-50",
    suave: "text-[#0b315f] hover:bg-[#eef3f8]",
  }[tono];
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title}
      className={`inline-flex items-center justify-center gap-1 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${base} ${estilos}`}>
      {children}
    </button>
  );
}

// ══ Campos ══════════════════════════════════════════════════════════════════════
const CLASE_CAMPO = "w-full rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm focus:border-[#0b315f] focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 disabled:bg-gray-50 disabled:text-gray-500";

/**
 * Texto que se edita en el doc. Mientras tiene el foco enseña lo tecleado (aunque el doc vuelva
 * recortado); `alSalir` = solo se manda al salir del campo o con Enter (para lo que reordena la lista).
 */
export function CampoTexto({ valor, onCambio, alSalir, placeholder, maxLength, disabled, ariaLabel, className, inputMode, mayusculas, list }: {
  valor: string; onCambio: (v: string) => void; alSalir?: boolean; placeholder?: string; maxLength?: number;
  disabled?: boolean; ariaLabel?: string; className?: string; inputMode?: "text" | "numeric" | "email" | "tel"; mayusculas?: boolean;
  /** id de un <datalist> con sugerencias. */
  list?: string;
}) {
  const [local, setLocal] = useState<string | null>(null);
  const mostrado = local ?? valor;
  const confirmar = () => {
    if (local === null) return;
    const v = mayusculas ? local.toUpperCase() : local;
    if (alSalir && v !== valor) onCambio(v);
    setLocal(null);
  };
  return (
    <input
      type={inputMode === "email" ? "email" : inputMode === "tel" ? "tel" : "text"} inputMode={inputMode}
      aria-label={ariaLabel} placeholder={placeholder} maxLength={maxLength} disabled={disabled} list={list}
      className={`${CLASE_CAMPO} ${className ?? ""}`}
      value={mostrado}
      onFocus={() => setLocal(valor)}
      onChange={(e) => {
        setLocal(e.target.value);
        if (!alSalir) onCambio(mayusculas ? e.target.value.toUpperCase() : e.target.value);
      }}
      onBlur={confirmar}
      onKeyDown={(e) => { if (e.key === "Enter" && alSalir) { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
    />
  );
}

export function AreaTexto({ valor, onCambio, placeholder, maxLength, disabled, ariaLabel, filas = 3 }: {
  valor: string; onCambio: (v: string) => void; placeholder?: string; maxLength?: number; disabled?: boolean; ariaLabel?: string; filas?: number;
}) {
  const [local, setLocal] = useState<string | null>(null);
  return (
    <textarea
      aria-label={ariaLabel} placeholder={placeholder} maxLength={maxLength} disabled={disabled} rows={filas}
      className={`${CLASE_CAMPO} resize-y`}
      value={local ?? valor}
      onFocus={() => setLocal(valor)}
      onChange={(e) => { setLocal(e.target.value); onCambio(e.target.value); }}
      onBlur={() => setLocal(null)}
    />
  );
}

/**
 * Entero opcional. Vacío = null (borra el dato), nunca 0. Se manda al salir del campo; un valor fuera
 * de rango NO se manda y se dice debajo, fijo.
 */
export function CampoEntero({ valor, onCambio, min, max, placeholder, disabled, ariaLabel, className }: {
  valor: number | null; onCambio: (v: number | null) => void; min: number; max: number;
  placeholder?: string; disabled?: boolean; ariaLabel?: string; className?: string;
}) {
  const [local, setLocal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mostrado = local ?? (valor == null ? "" : String(valor));
  const confirmar = () => {
    if (local === null) return;
    const t = local.trim();
    if (!t) { setError(null); setLocal(null); if (valor !== null) onCambio(null); return; }
    const n = Number(t);
    if (!Number.isInteger(n) || n < min || n > max) { setError(`Escribe un número entero entre ${min} y ${max}, o déjalo vacío.`); return; }
    setError(null); setLocal(null);
    if (n !== valor) onCambio(n);
  };
  return (
    <div className={className}>
      <input
        type="text" inputMode="numeric" aria-label={ariaLabel} placeholder={placeholder} disabled={disabled}
        className={`${CLASE_CAMPO} ${error ? "border-red-400" : ""}`}
        value={mostrado}
        onFocus={() => { if (local === null) setLocal(valor == null ? "" : String(valor)); }}
        onChange={(e) => setLocal(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={confirmar}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
      />
      {error && <p className="mt-1 text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

export function Etiqueta({ texto, children, ayuda }: { texto: string; children: ReactNode; ayuda?: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">{texto}</span>
      {children}
      {ayuda && <span className="mt-1 block text-[11px] text-gray-500">{ayuda}</span>}
    </label>
  );
}

// ══ Vigencias ═══════════════════════════════════════════════════════════════════
/** El estado de un documento a una fecha, como chip. Los textos dicen el número de días. */
export function ChipVigencia({ estado, dias }: { estado: EstadoDocUnidad; dias: number | null }) {
  switch (estado) {
    case "falta": return <Chip tono="rojo">No registrado</Chip>;
    case "vencido": return <Chip tono="rojo">Vencido{dias != null ? ` · hace ${-dias} d` : ""}</Chip>;
    case "por_vencer": return <Chip tono="ambar">Vence en {dias} d</Chip>;
    case "vigente": return <Chip tono="verde">Vigente</Chip>;
    case "sin_fecha": return <Chip tono="gris">Sin vencimiento registrado</Chip>;
    case "no_vence": return <Chip tono="gris">No vence</Chip>;
  }
}

// ══ Archivos ════════════════════════════════════════════════════════════════════
/** ¿Es un enlace http(s) que se puede pintar como `<a>`? (un `javascript:` nunca). */
export function hrefSeguro(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch { return null; }
}
const esDrive = (url: string) => { try { return /(^|\.)(drive|docs)\.google\.com$/i.test(new URL(url).hostname); } catch { return false; } };

/**
 * De dónde es el archivo y cómo se abre. Lo del ERP se abre firmado (EnlacePrivado); un enlace externo
 * se abre tal cual y se DICE que no se puede unir al expediente; sin archivo, se dice.
 */
export function ArchivoOrigen({ url, origen, compacto }: { url: string | null | undefined; origen: OrigenArchivo; compacto?: boolean }) {
  if (origen === "vacio" || !url) return <span className="text-xs text-gray-500">{compacto ? "Sin archivo" : "Sin archivo: no se puede adjuntar"}</span>;
  if (origen === "storage_privado" || origen === "storage_publico") {
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        <Chip tono="verde">Subido al ERP</Chip>
        <EnlacePrivado href={url} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-[#0b315f] underline">Ver</EnlacePrivado>
      </span>
    );
  }
  const href = hrefSeguro(url);
  const etiqueta = esDrive(url) ? "Drive — no se puede unir al expediente: sube el PDF" : "Enlace externo — no se puede unir al expediente: sube el PDF";
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Chip tono="ambar" title={etiqueta}>{esDrive(url) ? "Drive" : "Enlace externo"}</Chip>
      {href
        ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-xs text-amber-800 underline">{compacto ? "abrir" : etiqueta}</a>
        : <span className="text-xs text-amber-800">{etiqueta} (el enlace guardado no es válido)</span>}
    </span>
  );
}

// ══ Modal ═══════════════════════════════════════════════════════════════════════
export function Modal({ titulo, subtitulo, onCerrar, children, pie, ocupado }: {
  titulo: string; subtitulo?: ReactNode; onCerrar: () => void; children: ReactNode; pie?: ReactNode; ocupado?: boolean;
}) {
  const idTitulo = useId();
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => { if (e.key === "Escape" && !ocupado) onCerrar(); };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [onCerrar, ocupado]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={() => { if (!ocupado) onCerrar(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby={idTitulo}
        className="flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-2xl bg-white shadow-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2 border-b border-gray-100 px-4 py-3">
          <div className="min-w-0">
            <h3 id={idTitulo} className="text-sm font-bold text-[#0b315f]">{titulo}</h3>
            {subtitulo && <div className="mt-0.5 text-xs text-gray-500">{subtitulo}</div>}
          </div>
          <button type="button" onClick={onCerrar} disabled={ocupado} aria-label="Cerrar"
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-40">✕</button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">{children}</div>
        {pie && <div className="border-t border-gray-100 px-4 py-3">{pie}</div>}
      </div>
    </div>
  );
}

// ══ Hallazgos ═══════════════════════════════════════════════════════════════════
const NOMBRE_PASO: Record<Paso, string> = { bases: "Bases y requisitos", recursos: "Recursos", contenido: "Contenido", expediente: "Expediente", revision: "Revisión" };

/** Lo que se puede pulsar en un hallazgo: ir al elemento (dentro del paso), a otro paso, o abrir otra pantalla. */
export function AccionDonde({ donde, irA, anclaLocal, etiquetaLocal = "Ver" }: {
  donde: DondeSeCorrige; irA: (paso: Paso, ancla?: string | null) => void; anclaLocal?: string | null; etiquetaLocal?: string;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {anclaLocal && (
        <button type="button" onClick={() => irA("recursos", anclaLocal)} className="text-xs font-semibold text-[#0b315f] underline">{etiquetaLocal}</button>
      )}
      {"ruta" in donde ? (
        <Link href={donde.ruta} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-[#0b315f] underline">
          Abrir {donde.etiqueta} ↗
        </Link>
      ) : donde.paso !== "recursos" ? (
        <button type="button" onClick={() => irA(donde.paso, donde.ancla)} className="text-xs font-semibold text-[#0b315f] underline">
          Ir a {NOMBRE_PASO[donde.paso]}
        </button>
      ) : null}
    </span>
  );
}

/** Lista de hallazgos con su gravedad, su texto y su arreglo. Los aceptados salen en gris. */
export function ListaHallazgos({ hallazgos, irA, anclaDe }: {
  hallazgos: Hallazgo[]; irA: (paso: Paso, ancla?: string | null) => void;
  /** El ancla del elemento al que pertenece (null = el hallazgo ya está en su sitio). */
  anclaDe?: (h: Hallazgo) => string | null;
}) {
  if (!hallazgos.length) return null;
  return (
    <ul className="space-y-1.5">
      {hallazgos.map((h) => {
        const tono = h.aceptado ? "gris" : tonoDeGravedad(h.gravedad);
        return (
          <li key={h.clave} className={`rounded-lg border px-2.5 py-2 text-xs ${TONO[tono]} ${h.aceptado ? "opacity-70" : ""}`}>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-bold">{h.titulo}</span>
              {h.aceptado && <Chip tono="gris" title={h.aceptado.nota}>Aceptado</Chip>}
            </div>
            <p className="mt-0.5">{h.texto}</p>
            <p className="mt-0.5 opacity-90">→ {h.arreglo}</p>
            {h.aceptado?.nota && <p className="mt-0.5 italic">Nota: {h.aceptado.nota}</p>}
            <div className="mt-1"><AccionDonde donde={h.donde} irA={irA} anclaLocal={anclaDe?.(h) ?? null} /></div>
          </li>
        );
      })}
    </ul>
  );
}

/** «17/10/2026» o la raya. */
export const dmy = (f: string | null | undefined) => fechaDMY(f);
