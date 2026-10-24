"use client";
// components/licitaciones/editor/bases/ArchivosBases.tsx — Los archivos de las bases (doc.bases). Se
// suben al bucket PRIVADO de la licitación (subirArchivo valida tipo y contenido antes de subir) y se
// pintan con EnlacePrivado. Quitar uno lo saca del doc; el archivo queda en el almacenamiento a
// propósito: el bucket no admite borrar, y una emisión pasada puede citarlo.
import { useRef, useState } from "react";
import { EnlacePrivado } from "@/components/ArchivoPrivado";
import { subirArchivo, ErrorLicitaciones, SQL_LICITACIONES } from "@/lib/licitaciones/datos";
import { EXTENSIONES_PERMITIDAS } from "@/lib/licitaciones/archivos";
import { LIMITES_TEXTO } from "@/lib/licitaciones/normalizar";
import type { ArchivoBase, DocLicitacion, Licitacion, TipoBase } from "@/lib/licitaciones/tipos";
import type { TonoAviso } from "../contrato-editor";
import { ETIQUETA_TIPO_BASE, TIPOS_BASE_LISTA, instanteLima, tamanoArchivo } from "../etiquetas";
import { BOTON, BOTON_PRIMARIO, INPUT, Tarjeta } from "./ui";

/** El tope con que normalizarDoc recorta doc.bases: más allá se perdería al guardar. */
const MAX_BASES = LIMITES_TEXTO.maxBases;

type Props = {
  lic: Licitacion;
  doc: DocLicitacion;
  cambiarDoc: (fn: (d: DocLicitacion) => DocLicitacion) => void;
  soloLectura: boolean;
  bloqueado: string | null;     // motivo por el que no se puede subir (conflicto…)
  aviso: (t: string, tono?: TonoAviso) => void;
};

export default function ArchivosBases({ lic, doc, cambiarDoc, soloLectura, bloqueado, aviso }: Props) {
  const [tipo, setTipo] = useState<TipoBase>("bases");
  const [subiendo, setSubiendo] = useState<{ hecho: number; total: number; nombre: string } | null>(null);
  const [errores, setErrores] = useState<{ texto: string; sql: string | null }[]>([]);
  const input = useRef<HTMLInputElement | null>(null);

  const quedan = MAX_BASES - doc.bases.length;
  const motivoNoSubir = soloLectura ? "La licitación está en solo lectura." : bloqueado ? bloqueado : quedan <= 0 ? `Ya hay ${MAX_BASES} archivos: quita alguno para subir otro.` : null;

  const subir = async (files: FileList | null) => {
    if (!files || !files.length || motivoNoSubir) return;
    const lista = Array.from(files).slice(0, Math.max(0, quedan));
    const errs: { texto: string; sql: string | null }[] = [];
    if (files.length > lista.length) errs.push({ texto: `Solo caben ${quedan} archivo(s) más: no se subieron ${files.length - lista.length}.`, sql: null });
    let ok = 0;
    for (let i = 0; i < lista.length; i++) {
      const f = lista[i];
      setSubiendo({ hecho: i, total: lista.length, nombre: f.name });
      try {
        const ref = await subirArchivo("bases", lic.id, f);
        const base: ArchivoBase = { ...ref, tipo };
        cambiarDoc((d) => ({ ...d, bases: [...d.bases, base] }));
        ok++;
      } catch (e) {
        const texto = e instanceof Error ? e.message : String(e ?? `No se pudo subir «${f.name}».`);
        errs.push({ texto, sql: e instanceof ErrorLicitaciones ? e.sinMigracion : null });
      }
    }
    setSubiendo(null);
    setErrores(errs);
    if (input.current) input.current.value = "";
    if (ok) aviso(`${ok === 1 ? "Se subió 1 archivo" : `Se subieron ${ok} archivos`} a las bases.`);
  };

  const cambiarTipo = (id: string, t: TipoBase) => cambiarDoc((d) => ({ ...d, bases: d.bases.map((b) => (b.id === id ? { ...b, tipo: t } : b)) }));
  const quitar = (b: ArchivoBase) => {
    const citan = doc.requisitos.filter((r) => r.cita?.archivoId === b.id).length + doc.consultas.filter((c) => c.cita?.archivoId === b.id).length;
    const extra = citan ? `\n\n${citan} requisito(s) o consulta(s) citan este archivo: la cita se queda, pero ya no apuntará a un archivo de la lista.` : "";
    if (!window.confirm(`¿Quitar «${b.nombre}» de las bases de esta licitación?\n\nEl archivo no se borra del almacenamiento (a propósito: una emisión pasada puede citarlo); solo deja de figurar aquí y la IA ya no lo podrá leer.${extra}`)) return;
    cambiarDoc((d) => ({ ...d, bases: d.bases.filter((x) => x.id !== b.id) }));
  };

  return (
    <Tarjeta id="bases_subidas" titulo={`📎 Bases subidas (${doc.bases.length})`}
      subtitulo="Las bases, el TDR, la absolución de consultas, los anexos y los requisitos que mandó el cliente. La IA solo lee los PDF.">
      {!soloLectura && (
        <div className="rounded-xl border border-dashed border-gray-300 p-3 space-y-2">
          <div className="flex items-end gap-2 flex-wrap">
            <label className="min-w-0 flex-1 sm:flex-none sm:w-64">
              <span className="block text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1">Tipo de lo que vas a subir</span>
              <select className={INPUT} value={tipo} onChange={(e) => setTipo(e.target.value as TipoBase)} disabled={!!subiendo}>
                {TIPOS_BASE_LISTA.map((t) => <option key={t} value={t}>{ETIQUETA_TIPO_BASE[t]}</option>)}
              </select>
            </label>
            <input ref={input} type="file" multiple className="hidden" accept={EXTENSIONES_PERMITIDAS.map((e) => `.${e}`).join(",") + ",.jpeg"}
              onChange={(e) => void subir(e.target.files)} />
            <button type="button" className={BOTON_PRIMARIO} disabled={!!subiendo || !!motivoNoSubir} onClick={() => input.current?.click()}>
              {subiendo ? `Subiendo ${subiendo.hecho + 1} de ${subiendo.total}…` : "⬆ Subir archivos"}
            </button>
          </div>
          {subiendo && <p className="text-xs text-gray-500 truncate">Subiendo «{subiendo.nombre}»…</p>}
          {motivoNoSubir && <p className="text-xs text-gray-500">No se puede subir: {motivoNoSubir}</p>}
          <p className="text-[11px] text-gray-400">PDF, Word, Excel, imágenes o ZIP, hasta 50 MB cada uno. Una foto del iPhone (HEIC) hay que exportarla como JPG o PDF.</p>
        </div>
      )}
      {errores.length > 0 && (
        <div className="space-y-1">
          {errores.map((e, i) => (
            <p key={i} className={`text-xs rounded-lg px-3 py-2 border ${e.sql ? "bg-amber-50 border-amber-200 text-amber-900" : "bg-red-50 border-red-200 text-red-800"}`}>
              {e.texto}{e.sql && <> Archivo: <code className="font-mono">{e.sql}</code>.</>}
            </p>
          ))}
          <button type="button" className="text-[11px] font-bold text-gray-500 underline" onClick={() => setErrores([])}>Entendido</button>
        </div>
      )}
      {errores.some((e) => e.sql === SQL_LICITACIONES.bucket) && (
        <p className="text-xs text-amber-900">Sin ese SQL no existe el almacenamiento privado de las licitaciones: no se puede subir nada.</p>
      )}

      {doc.bases.length === 0 ? (
        <p className="text-sm text-gray-500">Todavía no hay archivos. Sube las bases para leerlas con IA, o escribe los requisitos a mano más abajo.</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {doc.bases.map((b, i) => (
            <li key={b.id} className="px-3 py-2 flex items-start gap-3 flex-wrap sm:flex-nowrap">
              <span className="text-[11px] font-bold text-gray-400 w-6 shrink-0 pt-1">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <EnlacePrivado href={b.url} target="_blank" rel="noopener noreferrer" className="text-sm font-bold text-[#0b315f] hover:underline break-all">
                  {b.nombre}
                </EnlacePrivado>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {b.mime === "application/pdf"
                    ? (b.paginas != null ? `PDF · ${b.paginas} página${b.paginas === 1 ? "" : "s"}` : <span className="text-amber-700">PDF · no se pudieron contar las páginas (¿protegido con contraseña?: la IA no lo podrá leer)</span>)
                    : <span>{etiquetaMime(b.mime)} · <span className="text-gray-400">la IA no lo lee (solo PDF)</span></span>}
                  {" · "}{tamanoArchivo(b.bytes)}{b.subidoEn ? ` · subido ${instanteLima(b.subidoEn)}` : ""}
                </p>
              </div>
              <select className={`${INPUT} sm:w-56 py-1.5 text-xs`} value={b.tipo} disabled={soloLectura} aria-label="Tipo del archivo"
                onChange={(e) => cambiarTipo(b.id, e.target.value as TipoBase)}>
                {TIPOS_BASE_LISTA.map((t) => <option key={t} value={t}>{ETIQUETA_TIPO_BASE[t]}</option>)}
              </select>
              {!soloLectura && <button type="button" className={`${BOTON} text-red-700 border-red-200`} onClick={() => quitar(b)}>Quitar</button>}
            </li>
          ))}
        </ul>
      )}
    </Tarjeta>
  );
}

function etiquetaMime(m: string): string {
  if (m === "image/png") return "PNG";
  if (m === "image/jpeg") return "JPG";
  if (m === "application/zip") return "ZIP";
  if (m.includes("wordprocessingml")) return "Word";
  if (m.includes("spreadsheetml") || m === "application/vnd.ms-excel") return "Excel";
  return "Archivo";
}
