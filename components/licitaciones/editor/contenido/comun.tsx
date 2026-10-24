"use client";
// components/licitaciones/editor/contenido/comun.tsx — Piezas que comparten los editores del paso
// «Contenido»: el campo de texto con su barra (B · Variable · [COMPLETAR]), la vista que pinta el texto
// como saldrá (negrita con trozosDe, variables con su valor, marcas a la vista), interruptores y botones.
//
// El texto admite SOLO **negrita**, {variables} y [COMPLETAR]: nada más se interpreta, y nada se pinta
// con HTML crudo. La vista es una AYUDA para leer: lo que manda es lo que arma resolverDocumento.

import { useId, useRef, useState, type ReactNode } from "react";
import { VARIABLES, trozosDe, esVariable, type ValoresVariables } from "@/lib/licitaciones/texto";
import { alternarNegrita, insertarEnCursor } from "./bloques";

export const MARCA_COMPLETAR = "[COMPLETAR]";

// ══ Botones e interruptores ═════════════════════════════════════════════════════

type BotonProps = {
  children: ReactNode; onClick?: () => void; disabled?: boolean; title?: string;
  tono?: "primario" | "normal" | "peligro" | "suave"; tam?: "sm" | "md"; type?: "button" | "submit"; className?: string;
};
export function Boton({ children, onClick, disabled, title, tono = "normal", tam = "md", type = "button", className = "" }: BotonProps) {
  const base = tam === "sm" ? "min-h-8 px-2.5 py-1 text-xs" : "min-h-9 px-3 py-1.5 text-sm";
  const color =
    tono === "primario" ? "bg-[#0b315f] text-white hover:bg-[#0a2a52] border border-[#0b315f]"
    : tono === "peligro" ? "border border-red-200 text-red-700 bg-white hover:bg-red-50"
    : tono === "suave" ? "border border-transparent text-gray-600 hover:bg-gray-100"
    : "border border-gray-300 text-gray-700 bg-white hover:bg-gray-50";
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${base} ${color} ${className}`}>
      {children}
    </button>
  );
}

/** Botón cuadrado de un ícono (↑ ↓ ⧉ ✕). El título se lee también como etiqueta accesible. */
export function BotonIcono({ children, onClick, disabled, title, peligro = false }: { children: ReactNode; onClick?: () => void; disabled?: boolean; title: string; peligro?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} aria-label={title}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sm transition disabled:cursor-not-allowed disabled:opacity-30 ${peligro ? "text-red-600 hover:bg-red-50" : "text-gray-600 hover:bg-gray-100"}`}>
      {children}
    </button>
  );
}

export function Interruptor({ marcado, cambiar, children, disabled, ayuda }: { marcado: boolean; cambiar: (v: boolean) => void; children: ReactNode; disabled?: boolean; ayuda?: string }) {
  return (
    <label className={`inline-flex min-h-8 items-center gap-2 text-sm ${disabled ? "text-gray-400" : "text-gray-700 cursor-pointer"}`} title={ayuda}>
      <input type="checkbox" className="h-4 w-4 accent-[#0b315f]" checked={marcado} disabled={disabled} onChange={(e) => cambiar(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/** Rótulo + control + ayuda debajo. */
export function Campo({ etiqueta, ayuda, children, htmlFor, extra }: { etiqueta: string; ayuda?: ReactNode; children: ReactNode; htmlFor?: string; extra?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-xs font-semibold text-gray-600">{etiqueta}</label>
        {extra}
      </div>
      {children}
      {ayuda ? <div className="mt-1 text-xs text-gray-500">{ayuda}</div> : null}
    </div>
  );
}

export const claseInput = "w-full min-w-0 rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[#0b315f] focus:outline-none focus:ring-1 focus:ring-[#0b315f] disabled:bg-gray-50 disabled:text-gray-600 read-only:bg-gray-50";

/** Mensaje fijo de un tope alcanzado (no un toast: tiene que seguir a la vista junto al botón apagado). */
export function TopeAlcanzado({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-xs text-amber-700">{children}</p>;
}

// ══ Vista del texto ═════════════════════════════════════════════════════════════

const RE_MARCAS = /(\{[a-z][a-z0-9_]{0,40}\}|\[\s*COMPLETAR\b[^\]]{0,200}\])/gi;

/** ¿El texto tiene algo que la vista aclare (negrita, variables o marcas)? */
export const tieneMarcas = (t: string) => /\*\*[\s\S]+?\*\*|\{[a-z][a-z0-9_]{0,40}\}|\[\s*COMPLETAR/i.test(t);

function partes(texto: string, valores: ValoresVariables | null, clave: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  for (const m of texto.matchAll(RE_MARCAS)) {
    const k = m.index ?? 0;
    if (k > i) out.push(texto.slice(i, k));
    const tok = m[0];
    if (tok.startsWith("{")) {
      const nombre = tok.slice(1, -1);
      if (!esVariable(nombre)) {
        out.push(<span key={`${clave}-${k}`} className="rounded bg-red-100 px-0.5 text-red-800" title={`{${nombre}} no es una variable conocida: se imprimirá tal cual`}>{tok}</span>);
      } else if (!valores) {
        out.push(<span key={`${clave}-${k}`} className="rounded bg-gray-100 px-0.5 text-gray-600" title="Comprobando el valor…">{tok}</span>);
      } else {
        const v = valores[nombre];
        out.push(v
          ? <span key={`${clave}-${k}`} className="rounded bg-emerald-50 px-0.5 text-emerald-900 underline decoration-emerald-300 decoration-dotted" title={`{${nombre}}`}>{v}</span>
          : <span key={`${clave}-${k}`} className="rounded bg-amber-100 px-0.5 text-amber-900" title={`{${nombre}} no tiene valor: se imprimirá tal cual y la revisión lo marca`}>{tok}</span>);
      }
    } else {
      out.push(<span key={`${clave}-${k}`} className="rounded bg-red-100 px-0.5 font-semibold text-red-800" title="Falta escribir este texto">{tok}</span>);
    }
    i = k + tok.length;
  }
  if (i < texto.length) out.push(texto.slice(i));
  return out;
}

/** El texto como se leerá: **negrita** (trozosDe), variables con su valor y [COMPLETAR] resaltado. */
export function TextoVista({ texto, valores, className = "" }: { texto: string; valores: ValoresVariables | null; className?: string }) {
  return (
    <span className={`whitespace-pre-wrap break-words ${className}`}>
      {trozosDe(texto).map((t, i) => (t.negrita
        ? <strong key={i} className="font-semibold text-gray-900">{partes(t.texto, valores, `t${i}`)}</strong>
        : <span key={i}>{partes(t.texto, valores, `t${i}`)}</span>))}
    </span>
  );
}

// ══ Campo de texto con barra ════════════════════════════════════════════════════

type CampoTextoProps = {
  valor: string;
  cambiar: (v: string) => void;
  max: number;
  multilinea?: boolean;
  filas?: number;
  placeholder?: string;
  /** Botón B (por defecto solo en los de varias líneas). */
  negrita?: boolean;
  /** Menú de variables y botón [COMPLETAR] (por defecto sí). */
  marcas?: boolean;
  /** Línea «Así se leerá» debajo cuando el texto tiene negrita, variables o marcas (por defecto sí). */
  vista?: boolean;
  valores: ValoresVariables | null;
  soloLectura: boolean;
  /** Para avisar cuando una inserción no cabe. */
  aviso?: (t: string, tono?: "ok" | "error" | "aviso") => void;
  id?: string;
  className?: string;
  /** Filtra el valor antes de guardarlo (p. ej. sin saltos de línea en un campo de una línea). */
  limpiar?: (v: string) => string;
};

/** Un input o textarea con la barra de marcas del texto de la propuesta y su contador al acercarse al tope. */
export function CampoTexto(p: CampoTextoProps) {
  const { valor, cambiar, max, multilinea = false, filas = 3, placeholder, valores, soloLectura, aviso } = p;
  const negrita = p.negrita ?? multilinea;
  const marcas = p.marcas ?? true;
  const vista = p.vista ?? true;
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const [menu, setMenu] = useState(false);
  const idAuto = useId();
  const id = p.id ?? idAuto;
  const limpiar = p.limpiar ?? ((v: string) => (multilinea ? v : v.replace(/[\r\n]+/g, " ")));

  const aplicar = (v: string, ini: number, fin: number) => {
    if (v.length > max) { aviso?.(`No cabe: el tope de este campo es ${max.toLocaleString("es-PE")} caracteres.`, "aviso"); return; }
    cambiar(limpiar(v));
    // El cursor vuelve donde estaba la inserción cuando React ya pintó el valor nuevo.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      try { el.setSelectionRange(ini, fin); } catch { /* algunos tipos de input no admiten selección */ }
    });
  };
  const seleccion = () => {
    const el = ref.current;
    return el ? { ini: el.selectionStart ?? valor.length, fin: el.selectionEnd ?? valor.length } : { ini: valor.length, fin: valor.length };
  };
  const insertar = (t: string) => {
    const s = seleccion();
    const r = insertarEnCursor(valor, s.ini, s.fin, t);
    aplicar(r.valor, r.cursor, r.cursor);
  };
  const conNegrita = () => {
    const s = seleccion();
    const r = alternarNegrita(valor, s.ini, s.fin);
    aplicar(r.valor, r.ini, r.fin);
  };

  const comunes = {
    id, value: valor, placeholder, maxLength: max, readOnly: soloLectura,
    onChange: (e: { target: { value: string } }) => cambiar(limpiar(e.target.value.slice(0, max))),
    className: `${claseInput} ${p.className ?? ""}`,
  };
  const cerca = valor.length >= max * 0.85;
  const barra = !soloLectura && (negrita || marcas);

  return (
    <div className="min-w-0">
      {barra ? (
        <div className="mb-1 flex flex-wrap items-center gap-1">
          {negrita ? (
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={conNegrita} title="Negrita: envuelve lo seleccionado en **…**"
              className="h-7 min-w-7 rounded-md border border-gray-200 bg-white px-2 text-xs font-bold text-gray-700 hover:bg-gray-50">B</button>
          ) : null}
          {marcas ? (
            <>
              <div className="relative">
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu((m) => !m)} aria-expanded={menu}
                  className="h-7 rounded-md border border-gray-200 bg-white px-2 text-xs text-gray-700 hover:bg-gray-50">{"{ }"} Insertar variable ▾</button>
                {menu ? <MenuVariables valores={valores} cerrar={() => setMenu(false)} elegir={(n) => { setMenu(false); insertar(`{${n}}`); }} /> : null}
              </div>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertar(MARCA_COMPLETAR)} title="Marca de texto pendiente: la revisión avisa mientras quede"
                className="h-7 rounded-md border border-gray-200 bg-white px-2 text-xs text-red-700 hover:bg-red-50">[COMPLETAR]</button>
            </>
          ) : null}
          {cerca ? <span className="ml-auto text-[11px] text-amber-700">{valor.length.toLocaleString("es-PE")} / {max.toLocaleString("es-PE")}</span> : null}
        </div>
      ) : null}
      {multilinea
        ? <textarea ref={ref} rows={filas} {...comunes} className={`${comunes.className} resize-y leading-relaxed [field-sizing:content] min-h-[4.5rem] max-h-[32rem]`} />
        : <input ref={ref} type="text" {...comunes} />}
      {vista && tieneMarcas(valor) ? (
        <div className="mt-1 rounded-md bg-gray-50 px-2 py-1 text-xs text-gray-600">
          <span className="mr-1 font-semibold text-gray-500">Así se leerá:</span>
          <TextoVista texto={valor} valores={valores} />
        </div>
      ) : null}
    </div>
  );
}

/** El menú del catálogo de variables, con lo que vale cada una en esta licitación. */
function MenuVariables({ valores, elegir, cerrar }: { valores: ValoresVariables | null; elegir: (n: string) => void; cerrar: () => void }) {
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={cerrar} aria-hidden />
      <div className="absolute left-0 z-40 mt-1 max-h-80 w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-gray-200 bg-white p-1 shadow-lg" role="menu">
        <p className="px-2 py-1.5 text-[11px] text-gray-500">Se reemplaza al imprimir. Sin valor queda visible tal cual y la revisión lo marca.</p>
        {VARIABLES.map((v) => {
          const val = valores ? valores[v.nombre] : undefined;
          return (
            <button key={v.nombre} type="button" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => elegir(v.nombre)}
              className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-gray-50">
              <span className="font-mono text-xs text-[#0b315f]">{`{${v.nombre}}`}</span>
              <span className="ml-2 text-xs text-gray-600">{v.descripcion}</span>
              <span className={`block truncate text-[11px] ${val ? "text-emerald-700" : val === null ? "text-amber-700" : "text-gray-400"}`}>
                {val ? `→ ${val}` : val === null ? "sin valor todavía" : "comprobando…"}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

/** Tarjeta con título para cada panel. */
export function Tarjeta({ titulo, children, acciones, id, resaltado = false, subtitulo }: { titulo: ReactNode; children: ReactNode; acciones?: ReactNode; id?: string; resaltado?: boolean; subtitulo?: ReactNode }) {
  return (
    <section id={id} className={`min-w-0 scroll-mt-24 rounded-2xl border bg-white p-4 transition-shadow sm:p-5 ${resaltado ? "border-amber-400 ring-2 ring-amber-300" : "border-gray-200"}`}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-[#0b315f]">{titulo}</h3>
          {subtitulo ? <div className="mt-0.5 text-xs text-gray-500">{subtitulo}</div> : null}
        </div>
        {acciones ? <div className="flex flex-wrap items-center gap-1.5">{acciones}</div> : null}
      </div>
      {children}
    </section>
  );
}
