"use client";
// components/licitaciones/editor/contenido/ListaSecciones.tsx — El índice de trabajo del paso: preliminares
// (portada, control, carta, glosario, índice), las secciones en orden (arrastrables) y el cierre. En el
// celular se pliega en un botón con lo que se está editando.

import { useState } from "react";
import { TOPES_DOC, type DocLicitacion, type Seccion } from "@/lib/licitaciones/tipos";
import { Boton, TopeAlcanzado } from "./comun";
import { useSortable } from "@dnd-kit/sortable";
import { Asa, ContenedorOrdenable, estiloOrdenable } from "./ordenable";
import { NOMBRE_PANEL, PANELES_INICIO, panelActivo, type PanelPreliminar } from "./Preliminares";

export type Seleccion = { tipo: "panel"; panel: PanelPreliminar } | { tipo: "seccion"; id: string };
export const mismaSeleccion = (a: Seleccion, b: Seleccion) =>
  a.tipo === b.tipo && (a.tipo === "panel" ? a.panel === (b as typeof a).panel : a.id === (b as typeof a).id);

type Cuenta = { alarma: number; otras: number };
type Props = {
  doc: DocLicitacion;
  sel: Seleccion;
  elegir: (s: Seleccion) => void;
  numeros: Map<string, string>;
  cuentaPanel: (p: PanelPreliminar) => Cuenta;
  cuentaSeccion: (id: string) => Cuenta;
  soloLectura: boolean;
  agregarSeccion: () => void;
  moverSeccion: (de: number, a: number) => void;
};

function Contador({ c }: { c: Cuenta }) {
  if (!c.alarma && !c.otras) return null;
  return (
    <span className={`ml-auto shrink-0 rounded-full px-1.5 text-[10px] font-semibold ${c.alarma ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"}`}
      title={`${c.alarma} por corregir · ${c.otras} avisos`}>
      {c.alarma + c.otras}
    </span>
  );
}

export default function ListaSecciones(p: Props) {
  const { doc, sel } = p;
  const [abierta, setAbierta] = useState(false);
  const lleno = doc.secciones.length >= TOPES_DOC.maxSecciones;
  const actual = sel.tipo === "panel" ? NOMBRE_PANEL[sel.panel] : (() => {
    const s = doc.secciones.find((x) => x.id === sel.id);
    const n = s ? p.numeros.get(s.id) : null;
    return s ? `${n ? `${n}. ` : ""}${s.titulo || "Sección sin título"}` : "Secciones";
  })();
  const elegir = (s: Seleccion) => { p.elegir(s); setAbierta(false); };

  const itemPanel = (panel: PanelPreliminar) => {
    const activo = mismaSeleccion(sel, { tipo: "panel", panel });
    const enc = panelActivo(doc, panel);
    return (
      <li key={panel}>
        <button type="button" onClick={() => elegir({ tipo: "panel", panel })} aria-current={activo ? "true" : undefined}
          className={`flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm ${activo ? "bg-[#0b315f] text-white" : "text-gray-700 hover:bg-gray-100"}`}>
          <span className={`h-2 w-2 shrink-0 rounded-full ${enc ? (activo ? "bg-white" : "bg-emerald-500") : "bg-gray-300"}`} title={enc ? "Se imprime" : "No se imprime"} />
          <span className={`min-w-0 truncate ${enc ? "" : activo ? "text-white/70" : "text-gray-400"}`}>{NOMBRE_PANEL[panel]}</span>
          <Contador c={p.cuentaPanel(panel)} />
        </button>
      </li>
    );
  };

  return (
    <nav aria-label="Partes de la propuesta" className="min-w-0">
      <button type="button" onClick={() => setAbierta((x) => !x)} aria-expanded={abierta}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-left text-sm font-semibold text-gray-800 md:hidden">
        <span className="min-w-0 truncate">Editando: {actual}</span>
        <span className="shrink-0 text-xs text-gray-500">{abierta ? "Cerrar ▴" : `Ver todo (${doc.secciones.length}) ▾`}</span>
      </button>
      <div className={`${abierta ? "block" : "hidden"} mt-2 rounded-2xl border border-gray-200 bg-white p-2 md:sticky md:top-4 md:mt-0 md:block md:max-h-[calc(100vh-2rem)] md:overflow-y-auto`}>
        <p className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Antes de las secciones</p>
        <ul className="space-y-0.5">{PANELES_INICIO.map(itemPanel)}</ul>
        <p className="mt-3 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Secciones ({doc.secciones.length})</p>
        {doc.secciones.length ? (
          <ContenedorOrdenable ids={doc.secciones.map((s) => s.id)} mover={p.moverSeccion}>
            <ul className="space-y-0.5">
              {doc.secciones.map((s) => (
                <ItemSeccion key={s.id} s={s} numero={p.numeros.get(s.id) ?? null} activo={sel.tipo === "seccion" && sel.id === s.id}
                  elegir={() => elegir({ tipo: "seccion", id: s.id })} cuenta={p.cuentaSeccion(s.id)} soloLectura={p.soloLectura} />
              ))}
            </ul>
          </ContenedorOrdenable>
        ) : <p className="px-2 py-1 text-xs text-gray-500">Todavía no hay secciones.</p>}
        {!p.soloLectura ? (
          <div className="px-1 pt-2">
            <Boton tam="sm" onClick={() => { p.agregarSeccion(); setAbierta(false); }} disabled={lleno} className="w-full">+ Agregar sección</Boton>
            {lleno ? <TopeAlcanzado>Tope de {TOPES_DOC.maxSecciones} secciones.</TopeAlcanzado> : null}
          </div>
        ) : null}
        <p className="mt-3 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Después de las secciones</p>
        <ul className="space-y-0.5">{itemPanel("cierre")}</ul>
      </div>
    </nav>
  );
}

function ItemSeccion({ s, numero, activo, elegir, cuenta, soloLectura }: { s: Seccion; numero: string | null; activo: boolean; elegir: () => void; cuenta: Cuenta; soloLectura: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id, disabled: soloLectura });
  return (
    <li ref={setNodeRef} style={estiloOrdenable({ transform, transition, isDragging })} className={isDragging ? "rounded-lg bg-white shadow-md" : ""}>
      <div className={`flex min-h-9 items-center rounded-lg ${activo ? "bg-[#0b315f] text-white" : "text-gray-700 hover:bg-gray-100"}`}>
        {!soloLectura ? <span className={activo ? "text-white/60" : ""}><Asa atributos={attributes} escuchas={listeners} etiqueta={`la sección «${s.titulo || "sin título"}»`} /></span> : <span className="w-2" />}
        <button type="button" onClick={elegir} aria-current={activo ? "true" : undefined} className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 text-left text-sm">
          <span className={`w-6 shrink-0 font-mono text-xs ${activo ? "text-white/80" : "text-gray-400"}`}>{numero ? `${numero}.` : "—"}</span>
          <span className={`min-w-0 truncate ${s.activa ? "" : `line-through ${activo ? "text-white/60" : "text-gray-400"}`} ${s.titulo ? "" : "italic"}`}>{s.titulo || "Sección sin título"}</span>
          <Contador c={cuenta} />
        </button>
      </div>
    </li>
  );
}
