"use client";

// components/EvidenciaPicker.tsx — Adjuntar el respaldo de un registro manual (foto del tablero,
// voucher, constancia). Las reglas viven en lib/evidencia.ts; esto solo las pinta.
//
// DOS BOTONES Y NO UNO, a propósito: `capture="environment"` abre la cámara directo en el celular y
// NO deja elegir un archivo, así que con un solo input no había forma de adjuntar el voucher que
// llegó por WhatsApp o el PDF de una constancia. En la PC los dos abren el selector de archivos.
//
// Un archivo que no sirve se rechaza AL ELEGIRLO, con su motivo, en vez de descubrirse al guardar.

import { useEffect, useMemo, useRef, useState } from "react";
import { ImgPrivada, EnlacePrivado } from "@/components/ArchivoPrivado";
import {
  revisarArchivo, esImagenEvidencia, MAX_EVIDENCIAS,
  type Evidencia,
} from "@/lib/evidencia";

export default function EvidenciaPicker({
  titulo, ayuda, archivos, onChange, guardadas = [], onQuitarGuardada,
  soloImagen = false, max = MAX_EVIDENCIAS, deshabilitado = false,
}: {
  titulo: string;
  ayuda?: string;
  archivos: File[];
  onChange: (archivos: File[]) => void;
  /** Lo ya guardado en el registro (al editar). */
  guardadas?: Evidencia[];
  onQuitarGuardada?: (url: string) => void;
  soloImagen?: boolean;
  max?: number;
  deshabilitado?: boolean;
}) {
  const camara = useRef<HTMLInputElement>(null);
  const galeria = useRef<HTMLInputElement>(null);
  const [rechazos, setRechazos] = useState<string[]>([]);
  const lleno = archivos.length + guardadas.length >= max;

  // Vistas previas de lo nuevo; se liberan al cambiar la lista (si no, cada foto queda en memoria).
  const previas = useMemo(() => archivos.map((f) => (f.type.startsWith("image/") ? URL.createObjectURL(f) : null)), [archivos]);
  useEffect(() => () => previas.forEach((u) => u && URL.revokeObjectURL(u)), [previas]);

  const agregar = (lista: FileList | null) => {
    if (!lista?.length) return;
    const ok: File[] = [];
    const malos: string[] = [];
    for (const f of Array.from(lista)) {
      const r = revisarArchivo(f, { soloImagen });
      if (r.ok) ok.push(f); else malos.push(`${f.name}: ${r.motivo}`);
    }
    const cupo = Math.max(0, max - guardadas.length - archivos.length);
    if (ok.length > cupo) malos.push(`solo caben ${max} archivos por registro: ${ok.length - cupo} no se agregaron`);
    setRechazos(malos);
    if (ok.length && cupo > 0) onChange([...archivos, ...ok.slice(0, cupo)]);
  };

  const accept = soloImagen ? "image/jpeg,image/png,image/webp,image/gif" : "image/jpeg,image/png,image/webp,image/gif,application/pdf";
  const multiple = max > 1;

  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{titulo}</p>
      {ayuda && <p className="text-xs text-gray-500 mb-2">{ayuda}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={deshabilitado || lleno} onClick={() => camara.current?.click()}
          className="px-3 py-2 rounded-xl text-xs font-bold border text-[#0b315f] hover:bg-gray-50 disabled:opacity-50">
          📷 Tomar foto
        </button>
        <button type="button" disabled={deshabilitado || lleno} onClick={() => galeria.current?.click()}
          className="px-3 py-2 rounded-xl text-xs font-bold border text-[#0b315f] hover:bg-gray-50 disabled:opacity-50">
          📎 {soloImagen ? "Elegir imagen" : "Elegir foto o PDF"}
        </button>
        {lleno && <span className="text-[11px] text-gray-400">máximo {max}</span>}
        <input ref={camara} type="file" accept="image/*" capture="environment" className="hidden"
          onChange={(e) => { agregar(e.target.files); e.target.value = ""; }} />
        <input ref={galeria} type="file" accept={accept} multiple={multiple} className="hidden"
          onChange={(e) => { agregar(e.target.files); e.target.value = ""; }} />
      </div>

      {(guardadas.length > 0 || archivos.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {guardadas.map((g) => (
            <div key={g.url} className="relative rounded-lg border overflow-hidden bg-gray-50" title={`${g.nombre} · ya guardado`}>
              {esImagenEvidencia(g)
                ? <EnlacePrivado href={g.url} target="_blank" rel="noreferrer"><ImgPrivada src={g.url} alt={g.nombre} className="w-20 h-16 object-cover" /></EnlacePrivado>
                : <EnlacePrivado href={g.url} target="_blank" rel="noreferrer" className="w-20 h-16 flex flex-col items-center justify-center text-[10px] text-blue-700 px-1 text-center">📄<span className="truncate w-full">{g.nombre}</span></EnlacePrivado>}
              {onQuitarGuardada && !deshabilitado && (
                <button type="button" onClick={() => onQuitarGuardada(g.url)} title="Quitar de este registro"
                  className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-white/90 text-red-600 text-xs font-bold shadow">✕</button>
              )}
            </div>
          ))}
          {archivos.map((f, i) => (
            <div key={`${f.name}-${i}`} className="relative rounded-lg border border-blue-200 overflow-hidden bg-blue-50" title={`${f.name} · se sube al guardar`}>
              {previas[i]
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={previas[i]!} alt={f.name} className="w-20 h-16 object-cover" />
                : <div className="w-20 h-16 flex flex-col items-center justify-center text-[10px] text-blue-700 px-1 text-center">📄<span className="truncate w-full">{f.name}</span></div>}
              {!deshabilitado && (
                <button type="button" onClick={() => onChange(archivos.filter((_, j) => j !== i))} title="Quitar"
                  className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-white/90 text-red-600 text-xs font-bold shadow">✕</button>
              )}
            </div>
          ))}
        </div>
      )}
      {archivos.length > 0 && <p className="mt-1 text-[11px] text-blue-700">Se sube{archivos.length === 1 ? "" : "n"} al guardar.</p>}
      {rechazos.length > 0 && (
        <ul className="mt-1 text-[11px] font-semibold text-amber-800 list-disc pl-4">
          {rechazos.map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
    </div>
  );
}
