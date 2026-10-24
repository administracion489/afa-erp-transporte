"use client";
// components/licitaciones/editor/recursos/ModalDocConductor.tsx — Subir el archivo de un documento del
// conductor (licencia, récord, antecedentes, examen médico, psicosomático, capacitación) o corregir sus
// fechas. Escribe en documentos_empresa (alcance 'conductor'), la misma fila que ve /documentos.
//
// OJO con el conductor PROPIO (D5): el vencimiento que vale es el de su ficha (conductores.*_venc, se
// edita en /conductores). La fila del documento guarda el archivo y sus propias fechas; si no coinciden,
// la revisión lo avisa. Por eso aquí se precarga la fecha de la ficha y se dice de dónde sale.

import { useState } from "react";
import Link from "next/link";
import { actualizarFechasDocConductor, subirDocumentoConductor } from "@/lib/licitaciones/datos";
import type { DocConductorResumen } from "@/lib/licitaciones/recursos";
import type { CodigoDocConductor, ConductorERP } from "@/lib/licitaciones/tipos";
import { ArchivoOrigen, Boton, dmy, Etiqueta, Modal, Nota } from "./comun";

const CLASE = "w-full rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm focus:border-[#0b315f] focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";

export default function ModalDocConductor({ c, codigo, resumen, modo, onCerrar, onListo }: {
  c: ConductorERP; codigo: CodigoDocConductor; resumen: DocConductorResumen; modo: "subir" | "fechas";
  onCerrar: () => void; onListo: (mensaje: string) => void;
}) {
  const fila = resumen.fila;
  const fichaManda = c.flota === "p" && resumen.columna !== "no_aplica";
  const vencFicha = resumen.fuenteVenc === "ficha" ? resumen.venc : null;
  const [titulo, setTitulo] = useState("");
  const [emision, setEmision] = useState(modo === "fechas" ? fila?.fecha_emision ?? "" : "");
  const [vencimiento, setVencimiento] = useState(modo === "fechas" ? fila?.fecha_vencimiento ?? "" : vencFicha ?? "");
  const [archivo, setArchivo] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const faltan: string[] = [];
  if (modo === "subir" && !archivo) faltan.push("elegir el archivo (PDF, PNG o JPG)");
  if (emision && vencimiento && vencimiento < emision) faltan.push("que el vencimiento no sea anterior a la emisión");
  if (modo === "fechas" && fila && (emision || "") === (fila.fecha_emision ?? "") && (vencimiento || "") === (fila.fecha_vencimiento ?? "")) faltan.push("cambiar alguna fecha");

  const enviar = async () => {
    if (faltan.length || enviando) return;
    setEnviando(true); setError(null);
    try {
      const r = modo === "subir"
        ? await subirDocumentoConductor(c.clave, codigo, archivo as File, { titulo: titulo.trim() || null, fecha_emision: emision || null, fecha_vencimiento: vencimiento || null })
        : fila ? await actualizarFechasDocConductor(fila.id, { fecha_emision: emision || null, fecha_vencimiento: vencimiento || null })
        : { ok: false as const, error: "No hay documento que corregir." };
      if (!r.ok) { setError(r.error); return; }
      onListo(modo === "subir" ? `${resumen.etiqueta} de ${c.nombre}: archivo guardado.` : `${resumen.etiqueta} de ${c.nombre}: fechas corregidas.`);
    } catch (e) {
      setError(`No se pudo guardar: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setEnviando(false); }
  };

  return (
    <Modal
      titulo={`${modo === "subir" ? "Subir archivo" : "Corregir fechas"} · ${resumen.etiqueta}`}
      subtitulo={<>{c.nombre}{c.flota === "t" ? ` · tercerizado${c.empresa ? ` (${c.empresa.razon_social})` : ""}` : ""}. Se guarda en Documentos (alcance conductor).</>}
      onCerrar={onCerrar} ocupado={enviando}
      pie={
        <div className="space-y-2">
          {faltan.length > 0 && <p className="text-[11px] text-gray-600">Falta: {faltan.join("; ")}.</p>}
          {error && <Nota tono="rojo">{error}</Nota>}
          <div className="flex flex-wrap justify-end gap-2">
            <Boton onClick={onCerrar} disabled={enviando}>Cancelar</Boton>
            <Boton tono="primario" onClick={enviar} disabled={enviando || faltan.length > 0}>{enviando ? "Guardando…" : modo === "subir" ? "Subir archivo" : "Guardar fechas"}</Boton>
          </div>
        </div>
      }
    >
      {fila && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
          <p className="font-semibold text-gray-500">Archivo actual</p>
          <p className="mt-1">{fila.titulo || resumen.etiqueta} · emitido {dmy(fila.fecha_emision)} · vence {dmy(fila.fecha_vencimiento)}</p>
          <div className="mt-1"><ArchivoOrigen url={fila.archivo_url} origen={resumen.origen} /></div>
          {modo === "subir" && <p className="mt-1 text-gray-500">El archivo nuevo se registra aparte; el anterior queda como historial y vale el más reciente.</p>}
        </div>
      )}
      {fichaManda && (
        <Nota tono="azul">
          Para un conductor propio, el vencimiento que vale es el de su ficha{vencFicha ? `: ${dmy(vencFicha)}` : " (hoy está vacía)"}.
          Si el archivo dice otra fecha, la revisión lo avisa. <Link href="/conductores" target="_blank" rel="noopener noreferrer" className="font-semibold underline">Editar la ficha en Conductores ↗</Link>
        </Nota>
      )}
      {modo === "subir" && (
        <Etiqueta texto="Título (opcional)" ayuda={`Vacío = «${resumen.etiqueta}».`}>
          <input className={CLASE} value={titulo} maxLength={300} onChange={(e) => setTitulo(e.target.value)} />
        </Etiqueta>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Etiqueta texto="Fecha de emisión" ayuda="Con ella se comprueba la antigüedad que piden las bases.">
          <input type="date" className={CLASE} value={emision} onChange={(e) => setEmision(e.target.value)} />
        </Etiqueta>
        <Etiqueta texto="Fecha de vencimiento (opcional)">
          <input type="date" className={CLASE} value={vencimiento} onChange={(e) => setVencimiento(e.target.value)} />
        </Etiqueta>
      </div>
      {modo === "subir" && (
        <Etiqueta texto="Archivo" ayuda="PDF, PNG o JPG, hasta 50 MB.">
          <input type="file" accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg"
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-[#eef3f8] file:px-3 file:py-2 file:text-sm file:font-semibold file:text-[#0b315f]"
            onChange={(e) => setArchivo(e.target.files?.[0] ?? null)} />
        </Etiqueta>
      )}
    </Modal>
  );
}
