"use client";
/**
 * Combobox genérico de búsqueda (input con lupa + lista ARIA combobox/listbox).
 *
 * Nació dentro de `SelectorCliente` y se extrajo para los buscadores de unidad de
 * /cotizaciones (`SelectorVehiculo`). NO decide nada: qué se ofrece, en qué orden y en qué
 * sección lo dice `armar` (que llama a su motor PURO); qué se pinta en cada fila, `renderItem`.
 * Aquí solo vive el comportamiento común, que tiene que ser IDÉNTICO en todos:
 *  - Cerrado enseña al elegido (`rotuloElegido`) y una ✕; abierto, lo que se teclea.
 *  - Esc o salir del campo sin elegir RESTAURA el valor: nunca queda puesto lo resaltado.
 *  - ↑↓ mueven, Enter elige, Tab elige lo resaltado (o cierra).
 *  - mousedown dentro de la lista no quita el foco (onMouseDown + preventDefault).
 *  - Mientras carga dice `textoCargando`, jamás «sin resultados», y no deja elegir lo que no se ve.
 *  - Un valor que no está en la lista se enseña como «#N» (gris): existe algo, no se finge vacío.
 */
import React, { useId, useMemo, useState } from "react";
import { tramosResaltados } from "@/lib/clientes-buscador";

/** `cuenta: false` = opción que no es un resultado (p. ej. «Sin vehículo»): no entra al conteo. */
export type OpcionCombo<T> =
  | { tipo: "item"; clave: string; dato: T; seccion?: string; cuenta?: boolean }
  | { tipo: "crear"; texto: string };

export type ArmadoCombo<T> = { opciones: OpcionCombo<T>[]; pies: string[] };

type Props<T> = {
  valor: string;
  /** Rótulo del elegido; null si no hay valor o no se encontró en la lista. */
  rotuloElegido: string | null;
  /** Lo que se ofrece para la consulta YA recortada. Memoizar en quien llama. */
  armar: (q: string) => ArmadoCombo<T>;
  renderItem: (dato: T, texto: string) => React.ReactNode;
  onElegir: (dato: T) => void;
  onLimpiar: () => void;
  onCrear?: (texto: string) => void;
  renderCrear?: (texto: string) => React.ReactNode;
  /** Mensaje cuando no hay ningún resultado (q recortada). */
  vacio: (q: string) => React.ReactNode;
  cargando?: boolean;
  textoCargando: string;
  anuncioCargando: string;
  ariaLabel: string;
  ariaLista: string;
  etiquetaLimpiar: string;
  placeholder: string;
  /** Cómo se enseña un valor que no está en la lista. Por defecto «#N». */
  rotuloSinDato?: (valor: string) => string;
  /** Lo que va a la derecha del elegido, antes de la ✕ (p. ej. el RUC). */
  extraElegido?: React.ReactNode;
  /** Padding derecho del input con elegido (reserva el sitio de extra + ✕). */
  reservaDerecha?: string;
};

/** Texto con sus tramos resaltados como <mark> (nodos React, nunca HTML crudo). */
export function Resaltado({ texto, q }: { texto: string; q: string }) {
  const tramos = q.trim() ? tramosResaltados(texto, q) : [];
  if (!tramos.length) return <>{texto}</>;
  const out: React.ReactNode[] = [];
  let i = 0;
  tramos.forEach((t, k) => {
    if (t.desde > i) out.push(texto.slice(i, t.desde));
    out.push(<mark key={k} className="bg-amber-100 text-inherit rounded-sm">{texto.slice(t.desde, t.hasta)}</mark>);
    i = t.hasta;
  });
  if (i < texto.length) out.push(texto.slice(i));
  return <>{out}</>;
}

export default function ComboBuscador<T>({
  valor, rotuloElegido, armar, renderItem, onElegir, onLimpiar, onCrear, renderCrear, vacio,
  cargando, textoCargando, anuncioCargando, ariaLabel, ariaLista, etiquetaLimpiar, placeholder,
  rotuloSinDato, extraElegido, reservaDerecha = "pr-24",
}: Props<T>) {
  const idBase = useId();
  const listId = `${idBase}-lista`;
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState("");
  const [activo, setActivo] = useState(-1);

  const { opciones, pies } = useMemo(() => armar(texto.trim()), [armar, texto]);
  const nResultados = opciones.filter(o => o.tipo === "item" && o.cuenta !== false).length;
  const elegido = rotuloElegido != null;

  const cerrar = () => { setAbierto(false); setTexto(""); setActivo(-1); };
  const abrir = () => { if (abierto) return; setAbierto(true); setTexto(""); setActivo(-1); };
  const elegir = (o: OpcionCombo<T> | undefined) => {
    if (!o || cargando) return; // lo que se ve es «Cargando…»: no se elige lo que no se ve
    if (o.tipo === "crear") onCrear?.(o.texto);
    else onElegir(o.dato);
    cerrar();
  };
  const mover = (d: number) => {
    if (!opciones.length) return;
    const n = activo < 0 ? (d > 0 ? 0 : opciones.length - 1) : (activo + d + opciones.length) % opciones.length;
    setActivo(n);
    document.getElementById(`${idBase}-op-${n}`)?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (!abierto) abrir(); else mover(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (!abierto) abrir(); else mover(-1); }
    else if (e.key === "Enter") { if (abierto) { e.preventDefault(); if (activo >= 0) elegir(opciones[activo]); } }
    else if (e.key === "Escape") { if (abierto) { e.preventDefault(); e.stopPropagation(); cerrar(); } }
    else if (e.key === "Tab") { if (abierto && activo >= 0) elegir(opciones[activo]); else if (abierto) cerrar(); }
  };

  const mostrado = abierto ? texto
    : elegido ? rotuloElegido
    : valor ? (cargando ? "Cargando…" : (rotuloSinDato ? rotuloSinDato(valor) : `#${valor}`)) : "";
  const idActivo = abierto && !cargando && activo >= 0 ? `${idBase}-op-${activo}` : undefined;
  const anuncio = !abierto ? "" : cargando ? anuncioCargando : `${nResultados} resultado${nResultados === 1 ? "" : "s"}`;

  return (
    <div className="relative w-full">
      <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">🔍</span>
      <input
        role="combobox" aria-label={ariaLabel} aria-expanded={abierto} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={idActivo} inputMode="search" autoComplete="off" spellCheck={false}
        className={`w-full border border-gray-200 rounded-xl pl-9 ${elegido && !abierto ? reservaDerecha : "pr-3"} py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${!abierto && !elegido && valor ? "text-gray-400" : ""}`}
        placeholder={abierto && elegido ? rotuloElegido! : placeholder}
        value={mostrado ?? ""}
        onFocus={abrir}
        onClick={abrir}
        onBlur={cerrar}
        onChange={e => { setAbierto(true); setTexto(e.target.value); setActivo(e.target.value.trim() ? 0 : -1); }}
        onKeyDown={onKeyDown}
      />
      {elegido && !abierto && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
          {extraElegido}
          <button type="button" aria-label={etiquetaLimpiar} title={etiquetaLimpiar}
            onMouseDown={e => e.preventDefault()} onClick={onLimpiar}
            className="w-7 h-7 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 flex items-center justify-center text-sm">✕</button>
        </div>
      )}
      <span className="sr-only" aria-live="polite">{anuncio}</span>
      {abierto && (
        // mousedown dentro de la lista (también su barra de desplazamiento) no quita el foco al campo.
        <div onMouseDown={e => e.preventDefault()} className="absolute left-0 right-0 z-30 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
          <ul id={listId} role="listbox" aria-label={ariaLista} className="max-h-[50vh] overflow-y-auto overscroll-contain">
            {cargando ? (
              <li role="presentation" className="px-3 py-3 text-xs text-gray-400">{textoCargando}</li>
            ) : opciones.map((o, i) => {
              const previa = i > 0 ? opciones[i - 1] : undefined;
              const cab = o.tipo === "item" && o.seccion && (previa?.tipo !== "item" || previa.seccion !== o.seccion) ? o.seccion : null;
              const act = i === activo;
              const base = `px-3 py-2 min-h-[44px] cursor-pointer flex flex-col justify-center ${act ? "bg-[#eef3f8]" : "hover:bg-gray-50"}`;
              const comunes = {
                id: `${idBase}-op-${i}`, role: "option" as const, "aria-selected": act,
                onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); elegir(o); },
                onMouseEnter: () => setActivo(i),
              };
              if (o.tipo === "crear") return (
                <li key="crear" {...comunes} className={`${base} border-t border-gray-100 text-sm font-bold text-[#0b315f]`}>
                  {renderCrear ? renderCrear(o.texto) : <>+ Crear «{o.texto}»</>}
                </li>
              );
              return (
                <React.Fragment key={`${o.seccion ?? ""}-${o.clave}`}>
                  {cab && <li role="presentation" className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-gray-400 bg-gray-50">{cab}</li>}
                  <li {...comunes} className={base}>{renderItem(o.dato, texto)}</li>
                </React.Fragment>
              );
            })}
            {!cargando && nResultados === 0 && (
              <li role="presentation" className="px-3 py-3 text-xs text-gray-500">{vacio(texto.trim())}</li>
            )}
          </ul>
          {!cargando && pies.length > 0 && (
            <div className="border-t border-gray-100 bg-gray-50 px-3 py-1.5 space-y-0.5">
              {pies.map(p => <p key={p} className="text-[10px] text-gray-400">{p}</p>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
