"use client";
// components/licitaciones/editor/recursos/ModalDocUnidad.tsx — «Subir PDF» de un documento de la unidad
// (SOAT, CITV, tarjeta de propiedad, TUC, habilitación).
//
// El PDF NO se guarda en la licitación: va a la FICHA de la unidad (documentos_vehiculo o
// documentos_tercero) por `subirDocUnidad`, la misma fila que leen Docs. Vehiculares, Tercerizadas y
// Seguimiento. Casi todos esos documentos son hoy un enlace de Drive, que no se puede unir al
// expediente: este es el camino para dejar el archivo en el ERP. El enlace anterior no se pierde, queda
// en las observaciones de la fila.

import { useMemo, useState } from "react";
import { subirDocUnidad } from "@/lib/licitaciones/datos";
import { ETIQUETA_DOC_UNIDAD, type DocUnidadResumen } from "@/lib/licitaciones/recursos";
import { CANONICOS_DOC_UNIDAD, type DocUnidadLic, type UnidadERP } from "@/lib/licitaciones/tipos";
import { docSinVencimiento, TIPOS_DOC_UNIDAD } from "@/lib/documentos-estado";
import { ArchivoOrigen, Boton, ChipVigencia, dmy, Etiqueta, Modal, Nota } from "./comun";

const CLASE = "w-full rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-sm focus:border-[#0b315f] focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";
const CON_VENCIMIENTO: readonly string[] = [...CANONICOS_DOC_UNIDAD.soat, ...CANONICOS_DOC_UNIDAD.citv];

export default function ModalDocUnidad({ u, doc, resumen, onCerrar, onListo }: {
  u: UnidadERP; doc: DocUnidadLic; resumen: DocUnidadResumen;
  onCerrar: () => void; onListo: (mensaje: string) => void;
}) {
  const fila = resumen.fila;
  // Los tipos de la ficha que cumplen esta exigencia y que esta flota registra (el CAT solo es de la propia).
  const tipos = useMemo(() => CANONICOS_DOC_UNIDAD[doc].filter((c) => {
    const t = TIPOS_DOC_UNIDAD.find((x) => x.canonico === c);
    return !!t && !(u.flota === "t" && t.exige === "propia");
  }), [doc, u.flota]);
  const reemplazable = !!fila && !fila.deEmpresa;
  const [modo, setModo] = useState<"reemplazar" | "nuevo">(reemplazable ? "reemplazar" : "nuevo");
  const [canonico, setCanonico] = useState<string>(fila?.canonico && tipos.includes(fila.canonico) ? fila.canonico : tipos[0] ?? CANONICOS_DOC_UNIDAD[doc][0]);
  const [numero, setNumero] = useState(reemplazable ? fila?.numero ?? "" : "");
  const [emision, setEmision] = useState(reemplazable ? fila?.fecha_emision ?? "" : "");
  const [vencimiento, setVencimiento] = useState(reemplazable ? fila?.fecha_vencimiento ?? "" : "");
  const [entidad, setEntidad] = useState(reemplazable ? fila?.entidad_emisora ?? "" : "");
  const [archivo, setArchivo] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const noVence = docSinVencimiento(canonico);
  const exigeVenc = CON_VENCIMIENTO.includes(canonico);
  const faltan: string[] = [];
  if (!archivo) faltan.push("elegir el archivo (PDF, PNG o JPG)");
  if (!noVence && exigeVenc && !vencimiento) faltan.push(`la fecha de vencimiento (sin ella no se sabe si el ${canonico} está vigente al presentar)`);
  if (!noVence && emision && vencimiento && vencimiento < emision) faltan.push("que el vencimiento no sea anterior a la emisión");

  const cambiarModo = (m: "reemplazar" | "nuevo") => {
    setModo(m);
    if (m === "reemplazar" && fila) { setNumero(fila.numero ?? ""); setEmision(fila.fecha_emision ?? ""); setVencimiento(fila.fecha_vencimiento ?? ""); setEntidad(fila.entidad_emisora ?? ""); }
    else { setNumero(""); setEmision(""); setVencimiento(""); setEntidad(""); }
  };

  const enviar = async () => {
    if (!archivo || faltan.length || enviando) return;
    setEnviando(true); setError(null);
    try {
      const r = await subirDocUnidad({ clave: u.clave, empresaId: u.empresa?.id ?? null }, canonico, archivo, {
        docId: modo === "reemplazar" && fila ? fila.id : null,
        numero: numero.trim() || null,
        fecha_emision: emision || null,
        fecha_vencimiento: noVence ? null : vencimiento || null,
        entidad_emisora: entidad.trim() || null,
      });
      if (!r.ok) { setError(r.sinMigracion ? `${r.error} (${r.sinMigracion})` : r.error); return; }
      onListo(`${ETIQUETA_DOC_UNIDAD[doc]} de ${u.placa}: el archivo quedó guardado en la ficha de la unidad.`);
    } catch (e) {
      setError(`No se pudo subir: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setEnviando(false);
    }
  };

  const fichaEn = u.flota === "t" ? "Tercerizadas" : "Docs. Vehiculares";
  return (
    <Modal
      titulo={`Subir PDF · ${ETIQUETA_DOC_UNIDAD[doc]} · ${u.placa}`}
      subtitulo={<>Se guarda en la ficha de la unidad ({fichaEn}), no solo en esta licitación.</>}
      onCerrar={onCerrar} ocupado={enviando}
      pie={
        <div className="space-y-2">
          {faltan.length > 0 && <p className="text-[11px] text-gray-600">Para subirlo falta: {faltan.join("; ")}.</p>}
          {error && <Nota tono="rojo">{error}</Nota>}
          <div className="flex flex-wrap justify-end gap-2">
            <Boton onClick={onCerrar} disabled={enviando}>Cancelar</Boton>
            <Boton tono="primario" onClick={enviar} disabled={enviando || faltan.length > 0}>{enviando ? "Subiendo…" : "Subir y guardar en la ficha"}</Boton>
          </div>
        </div>
      }
    >
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
        <p className="font-semibold text-gray-500">Hoy en la ficha</p>
        {fila ? (
          <div className="mt-1 space-y-1">
            <p>{fila.tipo || ETIQUETA_DOC_UNIDAD[doc]}{fila.numero ? ` · N° ${fila.numero}` : " · sin número"}{fila.entidad_emisora ? ` · ${fila.entidad_emisora}` : ""}{resumen.estado === "no_vence" ? " · no vence" : fila.fecha_vencimiento ? ` · vence ${dmy(fila.fecha_vencimiento)}` : " · sin vencimiento"}</p>
            <div className="flex flex-wrap items-center gap-2"><ChipVigencia estado={resumen.estado} dias={resumen.dias} /><ArchivoOrigen url={fila.archivo_url} origen={resumen.origen} /></div>
            {fila.deEmpresa && <p className="text-amber-800">Es un documento de la empresa {u.empresa?.razon_social ?? "tercerizada"}, no de la placa: el PDF se registrará como documento de {u.placa}.</p>}
          </div>
        ) : <p className="mt-1">No hay {ETIQUETA_DOC_UNIDAD[doc].toLowerCase()} registrado para {u.placa}: se crea el registro con este archivo.</p>}
      </div>

      {reemplazable && (
        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">¿Qué es este archivo?</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="modo-doc-unidad" className="mt-1" checked={modo === "reemplazar"} onChange={() => cambiarModo("reemplazar")} />
            <span>El mismo documento{fila?.numero ? ` (N° ${fila.numero})` : ""}: reemplaza su archivo. <span className="text-xs text-gray-500">Un campo vacío conserva lo que ya tiene la ficha.</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="modo-doc-unidad" className="mt-1" checked={modo === "nuevo"} onChange={() => cambiarModo("nuevo")} />
            <span>Un documento nuevo (renovación): se registra aparte y el anterior queda como historial.</span>
          </label>
        </fieldset>
      )}

      {tipos.length > 1 && (
        <Etiqueta texto="Tipo">
          <select className={CLASE} value={canonico} onChange={(e) => setCanonico(e.target.value)}>
            {tipos.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Etiqueta>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Etiqueta texto="Número">
          <input className={CLASE} value={numero} maxLength={80} onChange={(e) => setNumero(e.target.value)} />
        </Etiqueta>
        <Etiqueta texto="Entidad emisora (opcional)" ayuda={modo === "reemplazar" ? "Vacío = conserva la de la ficha." : undefined}>
          <input className={CLASE} value={entidad} maxLength={200} onChange={(e) => setEntidad(e.target.value)} />
        </Etiqueta>
        <Etiqueta texto="Fecha de emisión">
          <input type="date" className={CLASE} value={emision} onChange={(e) => setEmision(e.target.value)} />
        </Etiqueta>
        {noVence ? (
          <div className="text-xs text-gray-500 sm:pt-6">La {canonico.toLowerCase()} no vence: no se guarda fecha de vencimiento.</div>
        ) : (
          <Etiqueta texto={`Fecha de vencimiento${exigeVenc ? "" : " (opcional)"}`}>
            <input type="date" className={CLASE} value={vencimiento} onChange={(e) => setVencimiento(e.target.value)} />
          </Etiqueta>
        )}
      </div>
      <Etiqueta texto="Archivo" ayuda="PDF, PNG o JPG, hasta 50 MB. Una foto de iPhone (HEIC) hay que exportarla antes como JPG o PDF.">
        <input type="file" accept="application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg"
          className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-[#eef3f8] file:px-3 file:py-2 file:text-sm file:font-semibold file:text-[#0b315f]"
          onChange={(e) => setArchivo(e.target.files?.[0] ?? null)} />
      </Etiqueta>
      {resumen.origen === "externo" && (
        <Nota tono="gris">El enlace de Drive que tiene hoy no se borra: queda anotado en las observaciones del documento.</Nota>
      )}
    </Modal>
  );
}
