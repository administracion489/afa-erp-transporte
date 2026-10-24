"use client";
// components/licitaciones/editor/bases/ConsultasBases.tsx — Las consultas absueltas (doc.consultas): la
// pregunta, la respuesta oficial y CÓMO LA INCORPORA el postor (lo que la propuesta dice al respecto).
// Salen en la propuesta (bloque automático «absolución de consultas»).
import { useMemo } from "react";
import type { ConsultaAbsuelta, DocLicitacion } from "@/lib/licitaciones/tipos";
import { anclaDe } from "../contrato-editor";
import { TextoCita } from "../RevisarAnalisis";
import { BOTON, BOTON_PRIMARIO, INPUT, Tarjeta } from "./ui";

/** Mismo tope que normalizarDoc (lib/licitaciones/normalizar.ts, T.maxConsultas). */
const MAX_CONSULTAS = 300;

type Props = {
  doc: DocLicitacion;
  cambiarDoc: (fn: (d: DocLicitacion) => DocLicitacion) => void;
  soloLectura: boolean;
  nuevoId: () => string;
};

export default function ConsultasBases({ doc, cambiarDoc, soloLectura, nuevoId }: Props) {
  const nombres = useMemo(() => new Map(doc.bases.map((b, i) => [b.id, `${i + 1}. ${b.nombre}`])), [doc.bases]);
  const cons = doc.consultas;
  const sinIncorporar = cons.filter((c) => !c.incorporacion.trim()).length;

  const actualizar = (id: string, p: Partial<ConsultaAbsuelta>) =>
    cambiarDoc((d) => ({ ...d, consultas: d.consultas.map((c) => (c.id === id ? { ...c, ...p } : c)) }));
  const agregar = () => {
    const id = nuevoId();
    cambiarDoc((d) => ({ ...d, consultas: [...d.consultas, { id, numero: null, pregunta: "", respuesta: "", incorporacion: "", cita: null }] }));
    setTimeout(() => document.getElementById(anclaDe("consulta", id))?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  };
  const quitar = (c: ConsultaAbsuelta) => {
    const rot = `${c.numero ? `${c.numero} · ` : ""}${Array.from(c.pregunta).slice(0, 80).join("") || "(sin pregunta)"}`;
    if (!window.confirm(`¿Quitar la consulta «${rot}»?`)) return;
    cambiarDoc((d) => ({ ...d, consultas: d.consultas.filter((x) => x.id !== c.id) }));
  };

  return (
    <Tarjeta id="consultas" titulo={`💬 Consultas absueltas (${cons.length})`}
      subtitulo={<>Lo que preguntaron los postores y lo que respondió la entidad. Una absolución puede cambiar un requisito: si lo hace, corrige el requisito de arriba.{sinIncorporar > 0 && <span className="text-amber-700"> {sinIncorporar} sin «cómo la incorpora el postor».</span>}</>}
      acciones={!soloLectura ? <button type="button" className={BOTON_PRIMARIO} disabled={cons.length >= MAX_CONSULTAS} onClick={agregar}>+ Agregar consulta</button> : undefined}>
      {cons.length >= MAX_CONSULTAS && !soloLectura && <p className="text-xs text-gray-500">No se pueden agregar más: el tope es {MAX_CONSULTAS} consultas.</p>}
      {cons.length === 0 ? (
        <p className="text-sm text-gray-500">No hay consultas absueltas. Si las bases tienen absolución, súbela y léela con IA, o escríbelas a mano.</p>
      ) : (
        <ul className="space-y-2">
          {cons.map((c, i) => (
            <li key={c.id} id={anclaDe("consulta", c.id)} className="rounded-xl border p-3 space-y-2 scroll-mt-4 transition-shadow">
              <div className="flex items-end gap-2">
                <span className="text-[11px] text-gray-400 pb-2 w-5 shrink-0">{i + 1}</span>
                <label className="block w-28 shrink-0">
                  <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">N.º</span>
                  <input className={`${INPUT} py-1.5`} value={c.numero ?? ""} maxLength={40} disabled={soloLectura} placeholder="Consulta 5"
                    onChange={(e) => actualizar(c.id, { numero: e.target.value.trim() ? e.target.value : null })} />
                </label>
                <div className="flex-1" />
                {!soloLectura && <button type="button" className={`${BOTON} text-red-700 border-red-200`} onClick={() => quitar(c)}>Quitar</button>}
              </div>
              <label className="block">
                <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Pregunta</span>
                <textarea className={`${INPUT} min-h-[48px] text-xs`} value={c.pregunta} maxLength={8000} disabled={soloLectura} onChange={(e) => actualizar(c.id, { pregunta: e.target.value })} />
              </label>
              <label className="block">
                <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Respuesta de la entidad</span>
                <textarea className={`${INPUT} min-h-[48px] text-xs`} value={c.respuesta} maxLength={8000} disabled={soloLectura} onChange={(e) => actualizar(c.id, { respuesta: e.target.value })} />
              </label>
              <label className="block">
                <span className="block text-[10px] font-bold uppercase text-gray-500 mb-0.5">Cómo la incorpora el postor (sale en la propuesta)</span>
                <textarea className={`${INPUT} min-h-[48px] text-xs ${!c.incorporacion.trim() ? "border-amber-300" : ""}`} value={c.incorporacion} maxLength={8000} disabled={soloLectura}
                  placeholder="P. ej. «La propuesta considera unidades de respaldo dentro del mismo grupo empresarial…»"
                  onChange={(e) => actualizar(c.id, { incorporacion: e.target.value })} />
              </label>
              {c.cita && (
                <div className="flex items-start justify-between gap-2">
                  <TextoCita cita={c.cita} nombres={nombres} />
                  {!soloLectura && <button type="button" className="text-[11px] text-gray-500 underline shrink-0" onClick={() => actualizar(c.id, { cita: null })}>Quitar cita</button>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Tarjeta>
  );
}
