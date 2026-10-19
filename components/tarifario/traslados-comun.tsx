"use client";
// components/tarifario/traslados-comun.tsx — Piezas de UI que comparten las pestañas de «Zonas y
// traslados»: el aviso flotante, el modal, el editor de alias (chips) y los buscadores de zona.
// No deciden nada: qué alias se rechaza lo dice `motivoAliasInvalido`, cómo se ordenan y agrupan
// las zonas lo dicen las funciones de traslados-pantalla.ts.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ComboBuscador, { Resaltado, type ArmadoCombo } from "@/components/ComboBuscador";
import {
  coincideZona, mapaZonas, ordenarZonas, seccionBuscador, type ZonaFila,
} from "./traslados-pantalla";

export const AZUL = "#0b315f";

export const iCls = (extra = "") =>
  `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all bg-white ${extra}`;

// ── Aviso flotante ───────────────────────────────────────────────────────────

export type TonoAviso = "ok" | "error" | "info";
export type Decir = (texto: string, tono?: TonoAviso) => void;
type Aviso = { texto: string; tono: TonoAviso; n: number };

/** Un aviso a la vez. Los errores duran más y tienen ✕: un error que se va solo antes de leerlo no se dijo. */
export function useAviso(): { aviso: Aviso | null; decir: Decir; cerrar: () => void } {
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const reloj = useRef<number | null>(null);
  const cerrar = useCallback(() => {
    if (reloj.current) window.clearTimeout(reloj.current);
    setAviso(null);
  }, []);
  const decir = useCallback<Decir>((texto, tono = "ok") => {
    if (reloj.current) window.clearTimeout(reloj.current);
    setAviso({ texto, tono, n: Date.now() });
    reloj.current = window.setTimeout(() => setAviso(null), tono === "error" ? 12000 : 4500);
  }, []);
  useEffect(() => () => { if (reloj.current) window.clearTimeout(reloj.current); }, []);
  return { aviso, decir, cerrar };
}

export function AvisoFlotante({ aviso, onCerrar }: { aviso: Aviso | null; onCerrar: () => void }) {
  if (!aviso) return null;
  const estilo = aviso.tono === "error"
    ? "bg-red-50 border-red-300 text-red-800"
    : aviso.tono === "info" ? "bg-sky-50 border-sky-200 text-sky-900" : "bg-green-50 border-green-300 text-green-800";
  return (
    <div role={aviso.tono === "error" ? "alert" : "status"}
      className={`fixed z-[60] bottom-24 left-4 right-4 sm:left-auto sm:right-6 sm:max-w-md border rounded-xl shadow-lg px-4 py-3 text-sm flex items-start gap-3 ${estilo}`}>
      <span className="flex-1 whitespace-pre-line">{aviso.texto}</span>
      <button type="button" onClick={onCerrar} aria-label="Cerrar aviso" className="font-black opacity-60 hover:opacity-100 px-1">✕</button>
    </div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

export function Modal({ titulo, onCerrar, children, ancho = "max-w-2xl", bloqueado = false }: {
  titulo: React.ReactNode; onCerrar: () => void; children: React.ReactNode; ancho?: string; bloqueado?: boolean;
}) {
  const cb = useRef({ onCerrar, bloqueado });
  useEffect(() => { cb.current = { onCerrar, bloqueado }; });
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => { if (e.key === "Escape" && !cb.current.bloqueado) cb.current.onCerrar(); };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, []);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true">
      <div className={`bg-white w-full ${ancho} rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[94dvh] flex flex-col`}>
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b">
          <h3 className="text-base font-bold text-gray-800">{titulo}</h3>
          <button type="button" onClick={() => { if (!bloqueado) onCerrar(); }} disabled={bloqueado} aria-label="Cerrar"
            className="w-9 h-9 -mr-2 -mt-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 font-black disabled:opacity-40">✕</button>
        </div>
        <div className="overflow-y-auto px-5 py-4 space-y-4">{children}</div>
      </div>
    </div>
  );
}

// ── Interruptor activo / inactivo ────────────────────────────────────────────

export function InterruptorActivo({ activo, onCambiar, ocupado, titulo }: {
  activo: boolean; onCambiar: (v: boolean) => void; ocupado?: boolean; titulo: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={activo} disabled={ocupado} title={titulo}
      onClick={() => onCambiar(!activo)}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-bold border transition-all disabled:opacity-50 min-h-[32px] ${activo ? "bg-green-50 border-green-300 text-green-700" : "bg-gray-100 border-gray-300 text-gray-500"}`}>
      <span className={`w-2.5 h-2.5 rounded-full ${activo ? "bg-green-500" : "bg-gray-400"}`} />
      {activo ? "Activa" : "Inactiva"}
    </button>
  );
}

// ── Editor de alias (chips) ──────────────────────────────────────────────────

/**
 * Chips con ✕ y un campo para agregar (Enter, «Agregar» o al salir del campo). Los chips son los
 * de `alias` (la base o el formulario): mientras se guarda no se pintan como guardados. Un alias
 * rechazado se queda escrito con su motivo en rojo debajo, fijo.
 */
export function EditorAlias({ alias, onGuardar, validar, titulo, placeholder = "＋ alias", ocupado = false }: {
  alias: readonly string[];
  onGuardar: (nuevo: string[]) => Promise<boolean> | boolean;
  validar: (a: string, actuales: readonly string[]) => string | null;
  titulo: string;
  placeholder?: string;
  ocupado?: boolean;
}) {
  const [texto, setTexto] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const bloqueado = ocupado || guardando;

  const guardar = async (nuevo: string[]) => {
    setGuardando(true);
    const ok = await onGuardar(nuevo);
    setGuardando(false);
    return ok;
  };
  const agregar = async () => {
    const a = texto.trim();
    if (!a || bloqueado) return;
    const motivo = validar(a, alias);
    if (motivo) { setError(motivo); return; }
    setError(null);
    if (await guardar([...alias, a])) setTexto("");
  };
  const quitar = async (i: number) => {
    if (bloqueado) return;
    setError(null);
    await guardar(alias.filter((_, k) => k !== i));
  };

  return (
    <div title={titulo}>
      <div className="flex flex-wrap items-center gap-1.5">
        {alias.map((a, i) => (
          <span key={`${a}-${i}`} className="inline-flex items-center gap-1 bg-[#eef3f8] text-[#0b315f] text-[11px] font-bold rounded-full pl-2.5 pr-1 py-0.5">
            {a}
            <button type="button" disabled={bloqueado} onClick={() => quitar(i)} aria-label={`Quitar el alias ${a}`}
              className="w-5 h-5 rounded-full hover:bg-white/80 text-[#0b315f]/60 hover:text-red-600 disabled:opacity-40">✕</button>
          </span>
        ))}
        <input value={texto} disabled={bloqueado} placeholder={placeholder} aria-label="Agregar alias"
          onChange={(e) => { setTexto(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void agregar(); } }}
          onBlur={() => { if (texto.trim()) void agregar(); }}
          className="min-w-[8rem] flex-1 sm:flex-none sm:w-40 border border-dashed border-gray-300 rounded-full px-3 py-1 text-[11px] focus:outline-none focus:border-[#0b315f] disabled:bg-gray-50" />
        {guardando && <span className="text-[10px] text-gray-400">guardando…</span>}
      </div>
      {error && <p className="text-[11px] text-red-600 mt-1">{error}</p>}
    </div>
  );
}

// ── Buscador de una zona (origen) ────────────────────────────────────────────

const etiquetaTipo = (z: ZonaFila, porId: Map<number, ZonaFila>) =>
  z.tipo === "punto" ? `geocerca · radio ${z.radio_m ?? "?"} m`
    : z.tipo === "subzona" ? `subzona de ${z.padre_id != null ? porId.get(z.padre_id)?.nombre ?? "?" : "?"}`
      : "distrito";

export function BuscadorZona({ zonas, valor, onElegir, conteo, placeholder, cargando = false }: {
  zonas: readonly ZonaFila[];
  valor: number | null;
  onElegir: (id: number | null) => void;
  /** Cuántos precios tiene cada zona: se enseña al lado, para no elegir a ciegas. */
  conteo?: Map<number, number>;
  placeholder: string;
  cargando?: boolean;
}) {
  const porId = useMemo(() => mapaZonas(zonas), [zonas]);
  const ordenadas = useMemo(() => ordenarZonas(zonas, porId), [zonas, porId]);
  const armar = useCallback((q: string): ArmadoCombo<ZonaFila> => {
    const lista = ordenadas.filter((z) => coincideZona(z, q, porId));
    const tope = 250;
    return {
      opciones: lista.slice(0, tope).map((z) => ({ tipo: "item" as const, clave: String(z.id), dato: z, seccion: seccionBuscador(z, porId) })),
      pies: lista.length > tope ? [`y ${lista.length - tope} más: escribe para acotar`] : [],
    };
  }, [ordenadas, porId]);
  const elegida = valor != null ? porId.get(valor) : undefined;
  return (
    <ComboBuscador<ZonaFila>
      valor={valor == null ? "" : String(valor)}
      rotuloElegido={elegida ? elegida.nombre : null}
      armar={armar}
      renderItem={(z, q) => (
        <>
          <span className={`text-sm font-bold ${z.activo === false ? "text-gray-400 line-through" : "text-gray-800"}`}>
            {z.tipo === "punto" ? "📍 " : z.tipo === "subzona" ? "↳ " : ""}<Resaltado texto={z.nombre} q={q} />
          </span>
          <span className="text-[10px] text-gray-400">
            {etiquetaTipo(z, porId)}
            {(z.alias ?? []).length > 0 && ` · ${(z.alias ?? []).join(", ")}`}
            {z.activo === false && " · inactiva"}
            {conteo && ` · ${conteo.get(z.id) ?? 0} precio${(conteo.get(z.id) ?? 0) === 1 ? "" : "s"}`}
          </span>
        </>
      )}
      onElegir={(z) => onElegir(z.id)}
      onLimpiar={() => onElegir(null)}
      vacio={(q) => (q ? <>Ninguna zona se llama «{q}». Si es un distrito nuevo, créalo en la pestaña Zonas.</> : <>No hay zonas.</>)}
      cargando={cargando}
      textoCargando="Cargando zonas…"
      anuncioCargando="Cargando zonas"
      ariaLabel="Zona de origen"
      ariaLista="Zonas"
      etiquetaLimpiar="Quitar la zona elegida"
      placeholder={placeholder}
      reservaDerecha="pr-12"
    />
  );
}

// ── Selector de varias zonas (destinos) ──────────────────────────────────────

export function SelectorZonasMultiple({ zonas, elegidas, onCambiar, nota }: {
  zonas: readonly ZonaFila[];
  elegidas: ReadonlySet<number>;
  onCambiar: (nuevas: Set<number>) => void;
  /** Texto extra por zona (p. ej. «ya tiene 14 precios»). */
  nota?: (z: ZonaFila) => string | null;
}) {
  const [q, setQ] = useState("");
  const porId = useMemo(() => mapaZonas(zonas), [zonas]);
  const visibles = useMemo(() => ordenarZonas(zonas, porId).filter((z) => coincideZona(z, q, porId)), [zonas, porId, q]);
  const alternar = (id: number) => {
    const n = new Set(elegidas);
    if (n.has(id)) n.delete(id); else n.add(id);
    onCambiar(n);
  };
  const marcarVisibles = () => onCambiar(new Set([...elegidas, ...visibles.map((z) => z.id)]));
  const elegidasNombres = [...elegidas].map((id) => porId.get(id)?.nombre).filter(Boolean) as string[];
  return (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap items-center">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Buscar zona por nombre o alias…" className={iCls("flex-1 min-w-[12rem]")} />
        <button type="button" onClick={marcarVisibles} disabled={visibles.length === 0}
          className="px-3 py-2 rounded-xl text-xs font-bold border text-gray-600 hover:bg-gray-50 disabled:opacity-40">
          Marcar {q.trim() ? `las ${visibles.length} visibles` : "todas"}
        </button>
        {elegidas.size > 0 && (
          <button type="button" onClick={() => onCambiar(new Set())} className="px-3 py-2 rounded-xl text-xs font-bold text-gray-400 hover:text-gray-700">✕ Limpiar</button>
        )}
      </div>
      <div className="border border-gray-200 rounded-xl max-h-64 overflow-y-auto overscroll-contain">
        {visibles.length === 0 && <p className="px-3 py-3 text-xs text-gray-500">Ninguna zona coincide con «{q.trim()}».</p>}
        {visibles.map((z, i) => {
          const sec = seccionBuscador(z, porId);
          const cab = i === 0 || seccionBuscador(visibles[i - 1], porId) !== sec;
          const extra = nota?.(z);
          return (
            <React.Fragment key={z.id}>
              {cab && <p className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-gray-400 bg-gray-50 sticky top-0">{sec}</p>}
              <label className={`flex items-center gap-3 px-3 py-2 min-h-[44px] cursor-pointer hover:bg-gray-50 ${z.tipo === "subzona" ? "pl-7" : ""}`}>
                <input type="checkbox" className="w-4 h-4 accent-[#0b315f] flex-shrink-0" checked={elegidas.has(z.id)} onChange={() => alternar(z.id)} />
                <span className="flex-1 min-w-0">
                  <span className={`block text-sm font-bold truncate ${z.activo === false ? "text-gray-400" : "text-gray-800"}`}>
                    {z.tipo === "punto" ? "📍 " : z.tipo === "subzona" ? "↳ " : ""}{z.nombre}
                  </span>
                  <span className="block text-[10px] text-gray-400 truncate">
                    {etiquetaTipo(z, porId)}{z.activo === false ? " · inactiva" : ""}{extra ? ` · ${extra}` : ""}
                  </span>
                </span>
              </label>
            </React.Fragment>
          );
        })}
      </div>
      <p className="text-[11px] text-gray-500">
        {elegidas.size === 0 ? "Ningún destino marcado." : `${elegidas.size} destino${elegidas.size === 1 ? "" : "s"}: ${elegidasNombres.slice(0, 6).join(" · ")}${elegidasNombres.length > 6 ? ` y ${elegidasNombres.length - 6} más` : ""}`}
      </p>
    </div>
  );
}

