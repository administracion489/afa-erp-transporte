"use client";
// components/licitaciones/editor/contenido/EditorSeccion.tsx — La sección seleccionada: su cabecera
// (título, activa, numerada, mover, duplicar, quitar) y sus bloques, que se agregan, insertan, duplican,
// mueven (asa o ↑ ↓) y quitan dentro del tope de TOPES_DOC.

import { useState } from "react";
import { TOPES_DOC, type ArchivoRef, type Bloque, type Hallazgo, type Paso, type Seccion, type TipoAuto, type TipoBloque } from "@/lib/licitaciones/tipos";
import type { ValoresVariables } from "@/lib/licitaciones/texto";
import { anclaDe } from "../contrato-editor";
import { Boton, BotonIcono, CampoTexto, Interruptor, TopeAlcanzado } from "./comun";
import EditorBloque, { MenuTipos, type VistaAuto } from "./EditorBloque";
import { ContenedorOrdenable } from "./ordenable";
import { LIM, bloqueNuevo, bloquesConContenido, copiarBloque, mover, numerosDeSubtitulos, rotuloBloque, tieneContenido } from "./bloques";

type Props = {
  seccion: Seccion;
  /** Número que se imprimirá (null = desactivada o sin numerar). */
  numero: string | null;
  indice: number;
  total: number;
  cambiar: (fn: (s: Seccion) => Seccion) => void;
  mover: (d: -1 | 1) => void;
  duplicar: () => void;
  quitar: () => void;
  puedeAgregarSeccion: boolean;
  soloLectura: boolean;
  valores: ValoresVariables | null;
  aviso: (texto: string, tono?: "ok" | "error" | "aviso") => void;
  nuevoId: () => string;
  subirImagen: (file: File) => Promise<ArchivoRef>;
  irA: (paso: Paso, ancla?: string | null) => void;
  vistaDe: (bloqueId: string) => VistaAuto | null;
  hallazgosDe: (bloqueId: string) => Hallazgo[];
  hallazgosSeccion: Hallazgo[];
  resaltado: string | null;
};

const MAXB = TOPES_DOC.maxBloquesSeccion;

export default function EditorSeccion(p: Props) {
  const { seccion: s, cambiar, soloLectura, nuevoId } = p;
  const [menuFinal, setMenuFinal] = useState(false);
  const lleno = s.bloques.length >= MAXB;
  const numeros = numerosDeSubtitulos(s, p.numero);
  const domSeccion = anclaDe("seccion", s.id);

  const irAlBloque = (id: string) => requestAnimationFrame(() => document.getElementById(anclaDe("bloque", id))?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  const conBloques = (fn: (bs: Bloque[]) => Bloque[]) => cambiar((x) => ({ ...x, bloques: fn(x.bloques) }));
  const insertar = (pos: number, t: TipoBloque, auto?: TipoAuto) => {
    if (lleno) return;
    const nb = bloqueNuevo(t, nuevoId, auto);
    conBloques((bs) => { if (bs.length >= MAXB) return bs; const o = [...bs]; o.splice(pos, 0, nb); return o; });
    irAlBloque(nb.id);
  };
  const duplicarBloque = (i: number) => {
    if (lleno) return;
    const c = copiarBloque(s.bloques[i], nuevoId);
    conBloques((bs) => { if (bs.length >= MAXB) return bs; const o = [...bs]; o.splice(i + 1, 0, c); return o; });
    irAlBloque(c.id);
  };
  const quitarBloque = (i: number) => {
    const b = s.bloques[i];
    if (tieneContenido(b) && !window.confirm(`¿Quitar ${rotuloBloque(b)} de «${s.titulo || "la sección"}»? No se puede deshacer.`)) return;
    conBloques((bs) => bs.filter((x) => x.id !== b.id));
  };

  const quitarSeccion = () => p.quitar();
  const conContenido = bloquesConContenido(s);

  return (
    <div className="min-w-0 space-y-3">
      <section id={domSeccion} className={`scroll-mt-24 rounded-2xl border bg-white p-4 sm:p-5 ${p.resaltado === domSeccion ? "border-amber-400 ring-2 ring-amber-300" : "border-gray-200"}`}>
        <div className="flex flex-wrap items-start gap-2">
          <span className="mt-1.5 shrink-0 rounded-md bg-[#0b315f]/10 px-2 py-0.5 font-mono text-sm font-semibold text-[#0b315f]" title={p.numero ? "Número con que se imprime" : "No se numera"}>
            {p.numero ? `${p.numero}.` : "—"}
          </span>
          <div className="min-w-0 flex-1">
            <CampoTexto valor={s.titulo} max={LIM.tituloSeccion} valores={p.valores} soloLectura={soloLectura} aviso={p.aviso} negrita={false}
              placeholder="Título de la sección" className="text-base font-semibold"
              cambiar={(titulo) => cambiar((x) => ({ ...x, titulo }))} />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <Interruptor marcado={s.activa} disabled={soloLectura} cambiar={(activa) => cambiar((x) => ({ ...x, activa }))}
            ayuda="Una sección desactivada se conserva aquí pero no se imprime ni cuenta en la numeración">
            Activa (se imprime)
          </Interruptor>
          <Interruptor marcado={s.numerada} disabled={soloLectura} cambiar={(numerada) => cambiar((x) => ({ ...x, numerada }))}
            ayuda="Sin número: la sección sale con su título solo, y sus subtítulos tampoco se numeran">
            Numerada
          </Interruptor>
          {!soloLectura ? (
            <div className="ml-auto flex flex-wrap items-center gap-1">
              <BotonIcono title="Subir la sección" disabled={p.indice === 0} onClick={() => p.mover(-1)}>↑</BotonIcono>
              <BotonIcono title="Bajar la sección" disabled={p.indice === p.total - 1} onClick={() => p.mover(1)}>↓</BotonIcono>
              <Boton tam="sm" onClick={p.duplicar} disabled={!p.puedeAgregarSeccion} title={p.puedeAgregarSeccion ? "Copia la sección debajo, con todos sus bloques" : `Tope de ${TOPES_DOC.maxSecciones} secciones`}>⧉ Duplicar</Boton>
              <Boton tam="sm" tono="peligro" onClick={quitarSeccion}>Quitar</Boton>
            </div>
          ) : null}
        </div>
        {!s.activa ? <p className="mt-2 rounded-lg bg-gray-50 px-3 py-1.5 text-xs text-gray-600">Desactivada: no sale en el PDF ni en el índice, y la revisión no la mira. Se conserva para volver a activarla.</p> : null}
        {p.hallazgosSeccion.filter((h) => !h.aceptado).map((h) => (
          <p key={h.clave} className={`mt-2 text-xs ${h.gravedad === "alarma" ? "text-red-700" : h.gravedad === "aviso" ? "text-amber-800" : "text-gray-600"}`}>• {h.texto}</p>
        ))}
        {!p.puedeAgregarSeccion && !soloLectura ? <TopeAlcanzado>La propuesta llegó al tope de {TOPES_DOC.maxSecciones} secciones: para duplicar esta, quita otra.</TopeAlcanzado> : null}
        <p className="mt-2 text-[11px] text-gray-500">{s.bloques.length} {s.bloques.length === 1 ? "bloque" : "bloques"}{s.bloques.length ? ` · ${conContenido} con contenido` : ""}</p>
      </section>

      {s.bloques.length ? (
        <ContenedorOrdenable ids={s.bloques.map((b) => b.id)} mover={(de, a) => conBloques((bs) => mover(bs, de, a))}>
          <div className="space-y-2">
            {s.bloques.map((b, i) => (
              <EditorBloque key={b.id} bloque={b} indice={i} total={s.bloques.length} numero={numeros.get(b.id) ?? null}
                cambiar={(fn) => conBloques((bs) => bs.map((x) => (x.id === b.id ? fn(x) : x)))}
                mover={(d) => conBloques((bs) => mover(bs, i, i + d))}
                duplicar={() => duplicarBloque(i)} quitar={() => quitarBloque(i)}
                insertarDebajo={(t, a) => insertar(i + 1, t, a)} puedeAgregar={!lleno}
                soloLectura={soloLectura} valores={p.valores} aviso={p.aviso} subirImagen={p.subirImagen} irA={p.irA}
                vistaAuto={b.tipo === "auto" ? p.vistaDe(b.id) : null} hallazgos={p.hallazgosDe(b.id)}
                resaltado={p.resaltado === anclaDe("bloque", b.id)} domId={anclaDe("bloque", b.id)} />
            ))}
          </div>
        </ContenedorOrdenable>
      ) : (
        <div className="rounded-2xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
          La sección no tiene bloques. {soloLectura ? "" : "Agrega un párrafo, una tabla o una tabla automática."}
        </div>
      )}

      {!soloLectura ? (
        <div className="relative">
          <Boton onClick={() => setMenuFinal((m) => !m)} disabled={lleno}>+ Agregar bloque al final</Boton>
          {menuFinal ? <MenuTipos cerrar={() => setMenuFinal(false)} elegir={(t, a) => { setMenuFinal(false); insertar(s.bloques.length, t, a); }} /> : null}
          {lleno ? <TopeAlcanzado>La sección llegó al tope de {MAXB} bloques: divídela en dos secciones.</TopeAlcanzado> : null}
        </div>
      ) : null}
    </div>
  );
}
