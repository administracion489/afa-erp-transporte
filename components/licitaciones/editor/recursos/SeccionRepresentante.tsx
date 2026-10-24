"use client";
// components/licitaciones/editor/recursos/SeccionRepresentante.tsx — El representante legal que firma la
// carta, el cierre y el cuadro de experiencia, con la imagen de su firma.
//
// Estos datos viven SOLO en la licitación (doc.representante) y la firma en el bucket PRIVADO
// `licitaciones` (carpeta firmas/). Nunca en empresa_perfil: esa fila la puede leer cualquiera (anon).
// Lo que sale impreso lo dice `representanteDe` (lib/licitaciones/texto), el mismo que usa el PDF.
//
// Dos modos: ELEGIDO del personal del ERP (se guarda `personalId`; nombre, DNI y cargo van vacíos porque
// se derivan) o ESCRITO a mano. La firma se sube o se REUSA de otra licitación (firmasAnteriores): se
// copia la referencia al archivo, y solo si se marca la casilla, también los datos de ese representante.

import { useState } from "react";
import { ImgPrivada } from "@/components/ArchivoPrivado";
import { ErrorLicitaciones, firmasAnteriores, subirArchivo, type FirmaAnterior } from "@/lib/licitaciones/datos";
import { representanteDe } from "@/lib/licitaciones/texto";
import { fechaLima } from "@/lib/documentos-estado";
import type { Hallazgo, PersonaERP, Representante } from "@/lib/licitaciones/tipos";
import type { PasoProps } from "../contrato-editor";
import { Boton, CampoTexto, dmy, Etiqueta, ListaHallazgos, Modal, Nota, Seccion } from "./comun";
import { generalesDe } from "./hallazgos";
import SelectorPersonal, { type ResPersonal } from "./SelectorPersonal";

type ResFirmas = Awaited<ReturnType<typeof firmasAnteriores>>;
const fechaDeInstante = (x: string) => { const ms = Date.parse(x); return Number.isFinite(ms) ? dmy(fechaLima(ms)) : "—"; };

export default function SeccionRepresentante({ p, hallazgos, personal, recargarPersonal }: {
  p: PasoProps; hallazgos: Hallazgo[]; personal: ResPersonal | null; recargarPersonal: () => void;
}) {
  const { lic, doc, ctx, soloLectura } = p;
  const rep = doc.representante;
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eligiendo, setEligiendo] = useState(false);
  const [anteriores, setAnteriores] = useState<ResFirmas | null>(null);
  const [verAnteriores, setVerAnteriores] = useState(false);
  const [copiarDatos, setCopiarDatos] = useState(false);
  const derivado = ctx ? representanteDe(doc, ctx) : null;
  const enlazado = rep.personalId != null;
  const personalLeido = ctx?.lecturas.personal === "ok";
  const comprobando = enlazado && (!ctx || ((personal === null || p.ctxCargando) && !!derivado?.personalNoEncontrado));
  const hayDatos = enlazado || !!(rep.nombre.trim() || rep.dni.trim() || rep.cargo.trim());

  const cambiar = (c: Partial<Representante>) => p.cambiarDoc((d) => ({ ...d, representante: { ...d.representante, ...c } }));

  const subirFirma = async (file: File | null) => {
    if (!file) return;
    setSubiendo(true); setError(null);
    try {
      const ref = await subirArchivo("firmas", lic.id, file, { contarPaginas: false });
      cambiar({ firma: ref });
      p.aviso("Firma subida. Se usará en la carta, el cierre y el cuadro de experiencia.", "ok");
    } catch (e) {
      const m = e instanceof ErrorLicitaciones ? e.message : `No se pudo subir la firma: ${e instanceof Error ? e.message : String(e)}`;
      setError(m);
      p.aviso(m, "error");
    } finally { setSubiendo(false); }
  };
  const quitarFirma = () => {
    if (!window.confirm("¿Quitar la firma de esta licitación? Los documentos saldrán sin firma hasta que subas o elijas otra. La imagen sigue guardada como constancia.")) return;
    cambiar({ firma: null });
  };
  const elegirPersona = (x: PersonaERP) => {
    setEligiendo(false);
    if (x.id === rep.personalId) return;
    const escrito = !enlazado ? [rep.nombre, rep.dni, rep.cargo].filter((s) => s.trim()) : [];
    if (escrito.length && !window.confirm(`Se reemplazan los datos escritos del representante (${escrito.join(" · ")}) por los de ${x.nombre}, que se leerán de su ficha del personal. ¿Seguir?`)) return;
    cambiar({ personalId: x.id, nombre: "", dni: "", cargo: "" });
    p.recargarCtx();
  };
  const desenlazar = () => {
    if (!window.confirm("El representante dejará de leer sus datos del personal administrativo y quedará escrito a mano con lo que dice hoy su ficha. ¿Seguir?")) return;
    cambiar({ personalId: null, nombre: derivado?.nombre ?? "", dni: derivado?.dni ?? "", cargo: derivado?.cargo ?? "" });
    setEligiendo(false);
  };
  const abrirAnteriores = () => {
    setVerAnteriores(true);
    setAnteriores(null);
    firmasAnteriores(lic.id).then(setAnteriores, (e) => setAnteriores({ ok: false, error: `No se pudieron leer las firmas: ${e instanceof Error ? e.message : String(e)}.` }));
  };
  const reusar = (f: FirmaAnterior) => {
    const cambios: string[] = [];
    if (rep.firma && rep.firma.url !== f.firma.url) cambios.push("reemplaza la firma actual");
    if (copiarDatos && hayDatos) cambios.push(`reemplaza los datos del representante por los de ${f.representante.nombre || "esa licitación"}`);
    if (cambios.length && !window.confirm(`¿Usar la firma de «${f.nombre || `licitación N° ${f.licitacionId}`}»? Esto ${cambios.join(" y ")}.`)) return;
    const datos: Partial<Representante> = !copiarDatos ? {}
      : f.representante.personalId != null ? { personalId: f.representante.personalId, nombre: "", dni: "", cargo: "" }
      : { personalId: null, nombre: f.representante.nombre, dni: f.representante.dni, cargo: f.representante.cargo };
    cambiar({ firma: { ...f.firma, id: p.nuevoId() }, ...datos });
    if (copiarDatos && f.representante.personalId != null) p.recargarCtx();
    setVerAnteriores(false);
    p.aviso(copiarDatos ? "Firma y datos del representante copiados." : "Firma copiada de la otra licitación.", "ok");
  };

  return (
    <Seccion id="representante" titulo="Representante legal"
      subtitulo="Quien firma la carta de presentación, el cierre y el cuadro de experiencia. Se guarda solo en esta licitación.">
      <ListaHallazgos hallazgos={generalesDe(hallazgos, "representante")} irA={p.irA} />

      {enlazado ? (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Persona del personal del ERP</p>
          {comprobando ? <p className="text-xs text-gray-500">Comprobando…</p>
            : !personalLeido && derivado?.personalNoEncontrado ? <Nota tono="ambar">No se pudo leer el personal administrativo: no se muestran sus datos (no es que falten).</Nota>
            : derivado?.personalNoEncontrado ? <Nota tono="rojo">La persona enlazada (#{rep.personalId}) ya no está en el personal administrativo: elige otra o escribe los datos a mano.</Nota>
            : <p className="text-sm text-gray-800">{[derivado?.nombre, derivado?.dni ? `DNI ${derivado.dni}` : null, derivado?.cargo].filter(Boolean).join(" · ") || "—"}</p>}
          {!soloLectura && (
            <div className="mt-1 flex flex-wrap gap-3">
              <button type="button" onClick={() => setEligiendo(!eligiendo)} className="text-xs font-semibold text-[#0b315f] underline">{eligiendo ? "Cancelar" : "Cambiar persona"}</button>
              <button type="button" onClick={desenlazar} className="text-xs font-semibold text-[#0b315f] underline">Escribir a mano</button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Etiqueta texto="Nombre completo"><CampoTexto valor={rep.nombre} onCambio={(v) => cambiar({ nombre: v })} maxLength={120} disabled={soloLectura} /></Etiqueta>
            <Etiqueta texto="DNI"><CampoTexto valor={rep.dni} onCambio={(v) => cambiar({ dni: v })} maxLength={20} inputMode="numeric" disabled={soloLectura} /></Etiqueta>
            <Etiqueta texto="Cargo"><CampoTexto valor={rep.cargo} onCambio={(v) => cambiar({ cargo: v })} maxLength={120} disabled={soloLectura} placeholder="p. ej. Gerente general" /></Etiqueta>
          </div>
          {!soloLectura && (
            <button type="button" onClick={() => setEligiendo(!eligiendo)} className="text-xs font-semibold text-[#0b315f] underline">{eligiendo ? "Cancelar" : "Elegir del personal del ERP"}</button>
          )}
        </>
      )}
      {eligiendo && !soloLectura && (
        <SelectorPersonal personal={personal} recargar={recargarPersonal} actualId={rep.personalId} etiqueta="Buscar al representante en el personal" onElegir={elegirPersona} />
      )}

      <div className="flex flex-wrap items-start gap-4">
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Imagen de la firma</p>
          {rep.firma ? (
            <ImgPrivada src={rep.firma.url} alt="Firma del representante" className="h-24 w-56 rounded-lg border border-gray-200 bg-white object-contain p-1" />
          ) : (
            <div className="flex h-24 w-56 items-center justify-center rounded-lg border border-dashed border-gray-300 text-xs text-gray-400">Sin firma</div>
          )}
          {!soloLectura && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className={`inline-flex min-h-[40px] cursor-pointer items-center rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 ${subiendo ? "pointer-events-none opacity-50" : ""}`}>
                {subiendo ? "Subiendo…" : rep.firma ? "Cambiar firma" : "Subir firma"}
                <input type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" className="sr-only" disabled={subiendo}
                  onChange={(e) => { const f = e.target.files?.[0] ?? null; e.target.value = ""; void subirFirma(f); }} />
              </label>
              <Boton onClick={abrirAnteriores} disabled={subiendo}>Reusar una firma anterior</Boton>
              {rep.firma && <Boton tono="peligro" onClick={quitarFirma} disabled={subiendo}>Quitar</Boton>}
            </div>
          )}
          <p className="mt-1 text-[11px] text-gray-500">PNG o JPG, idealmente con fondo blanco o transparente.</p>
          {error && <p className="mt-1 max-w-xs text-[11px] text-red-600">{error}</p>}
        </div>

        <div className="min-w-[200px] flex-1 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Así sale al pie de lo que se firma</p>
          {!derivado || comprobando ? <p className="text-xs text-gray-500">Comprobando…</p> : (
            <div className="text-center text-xs text-gray-800">
              {derivado.firmaUrl ? <ImgPrivada src={derivado.firmaUrl} alt="" className="mx-auto h-12 object-contain" /> : <p className="text-gray-400">[sin firma]</p>}
              <div className="mx-auto mt-1 w-48 border-t border-gray-400 pt-1">
                {derivado.nombre && <p className="font-bold">{derivado.nombre}</p>}
                {derivado.dni && <p>DNI N° {derivado.dni}</p>}
                {derivado.cargo && <p>{derivado.cargo}</p>}
              </div>
              {(!derivado.nombre || !derivado.dni || !derivado.cargo) && (
                <p className="mt-1 text-[11px] text-gray-500">Falta {[!derivado.nombre && "el nombre", !derivado.dni && "el DNI", !derivado.cargo && "el cargo"].filter(Boolean).join(", ")}: esa línea no sale.</p>
              )}
            </div>
          )}
        </div>
      </div>

      {verAnteriores && (
        <Modal titulo="Reusar una firma anterior" subtitulo="Las firmas de las últimas licitaciones que tienen una. Se copia la referencia al archivo; la imagen no se duplica."
          onCerrar={() => setVerAnteriores(false)}>
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" className="mt-1 h-4 w-4" checked={copiarDatos} onChange={(e) => setCopiarDatos(e.target.checked)} />
            <span>Copiar también el nombre, DNI y cargo (o la persona del personal) del representante de esa licitación.</span>
          </label>
          {!anteriores ? (
            <p className="text-xs text-gray-500">Buscando firmas en otras licitaciones…</p>
          ) : !anteriores.ok ? (
            <Nota tono="rojo">{anteriores.error} <button type="button" className="font-semibold underline" onClick={abrirAnteriores}>Reintentar</button></Nota>
          ) : !anteriores.filas.length ? (
            <p className="text-sm text-gray-500">Ninguna otra licitación tiene una firma guardada (PNG o JPG). Sube la imagen de la firma.</p>
          ) : (
            <ul className="space-y-2">
              {anteriores.filas.map((f) => {
                const enUso = rep.firma?.url === f.firma.url;
                return (
                  <li key={`${f.licitacionId}-${f.firma.url}`} className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 p-2">
                    <ImgPrivada src={f.firma.url} alt={`Firma usada en ${f.nombre}`} className="h-14 w-32 flex-shrink-0 rounded border border-gray-200 bg-white object-contain p-0.5" />
                    <div className="min-w-0 flex-1 text-xs">
                      <p className="font-semibold text-gray-800">{f.nombre || `Licitación N° ${f.licitacionId}`}</p>
                      <p className="text-gray-500">Guardada el {fechaDeInstante(f.actualizado_en)}</p>
                      <p className="text-gray-600">{[f.representante.nombre, f.representante.dni ? `DNI ${f.representante.dni}` : null, f.representante.cargo].filter(Boolean).join(" · ") || "Sin datos del representante"}</p>
                    </div>
                    <Boton chico tono={enUso ? "suave" : "primario"} onClick={() => reusar(f)} disabled={enUso && !copiarDatos}
                      title={enUso && !copiarDatos ? "Es la firma que ya usa esta licitación" : undefined}>
                      {enUso ? (copiarDatos ? "Copiar sus datos" : "En uso") : "Elegir esta firma"}
                    </Boton>
                  </li>
                );
              })}
            </ul>
          )}
        </Modal>
      )}
    </Seccion>
  );
}
