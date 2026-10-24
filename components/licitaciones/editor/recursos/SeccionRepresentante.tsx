"use client";
// components/licitaciones/editor/recursos/SeccionRepresentante.tsx — El representante legal que firma la
// carta, el cierre y el cuadro de experiencia, con la imagen de su firma.
//
// Estos datos viven SOLO en la licitación (doc.representante) y la firma en el bucket PRIVADO
// `licitaciones` (carpeta firmas/). Nunca en empresa_perfil: esa fila la puede leer cualquiera (anon).
// Lo que sale impreso lo dice `representanteDe` (lib/licitaciones/texto), el mismo que usa el PDF.

import { useState } from "react";
import { ImgPrivada } from "@/components/ArchivoPrivado";
import { ErrorLicitaciones, subirArchivo } from "@/lib/licitaciones/datos";
import { representanteDe } from "@/lib/licitaciones/texto";
import type { Hallazgo, Representante } from "@/lib/licitaciones/tipos";
import type { PasoProps } from "../contrato-editor";
import { Boton, CampoTexto, Etiqueta, ListaHallazgos, Nota, Seccion } from "./comun";
import { generalesDe } from "./hallazgos";

export default function SeccionRepresentante({ p, hallazgos }: { p: PasoProps; hallazgos: Hallazgo[] }) {
  const { lic, doc, ctx, soloLectura } = p;
  const rep = doc.representante;
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const derivado = ctx ? representanteDe(doc, ctx) : null;
  const enlazado = rep.personalId != null;
  const personalLeido = ctx?.lecturas.personal === "ok";

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
    if (!window.confirm("¿Quitar la firma de esta licitación? Los documentos saldrán sin firma hasta que subas otra. La imagen sigue guardada como constancia.")) return;
    cambiar({ firma: null });
  };
  const desenlazar = () => {
    if (!derivado) return;
    if (!window.confirm("El representante dejará de leer sus datos del personal administrativo y quedará escrito a mano con lo que dice hoy su ficha. ¿Seguir?")) return;
    cambiar({ personalId: null, nombre: derivado.nombre, dni: derivado.dni, cargo: derivado.cargo });
  };

  return (
    <Seccion id="representante" titulo="Representante legal"
      subtitulo="Quien firma la carta de presentación, el cierre y el cuadro de experiencia. Se guarda solo en esta licitación.">
      <ListaHallazgos hallazgos={generalesDe(hallazgos, "representante")} irA={p.irA} />

      {enlazado ? (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Persona del personal administrativo</p>
          {!ctx ? <p className="text-xs text-gray-500">Comprobando…</p>
            : !personalLeido ? <Nota tono="ambar">No se pudo leer el personal administrativo: no se muestran sus datos (no es que falten).</Nota>
            : derivado?.personalNoEncontrado ? <Nota tono="rojo">La persona enlazada (#{rep.personalId}) ya no está en el personal administrativo.</Nota>
            : <p className="text-sm text-gray-800">{[derivado?.nombre, derivado?.dni ? `DNI ${derivado.dni}` : null, derivado?.cargo].filter(Boolean).join(" · ") || "—"}</p>}
          {!soloLectura && ctx && personalLeido && <button type="button" onClick={desenlazar} className="mt-1 text-xs font-semibold text-[#0b315f] underline">Escribir a mano</button>}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <Etiqueta texto="Nombre completo"><CampoTexto valor={rep.nombre} onCambio={(v) => cambiar({ nombre: v })} maxLength={120} disabled={soloLectura} /></Etiqueta>
          <Etiqueta texto="DNI"><CampoTexto valor={rep.dni} onCambio={(v) => cambiar({ dni: v })} maxLength={20} inputMode="numeric" disabled={soloLectura} /></Etiqueta>
          <Etiqueta texto="Cargo"><CampoTexto valor={rep.cargo} onCambio={(v) => cambiar({ cargo: v })} maxLength={120} disabled={soloLectura} placeholder="p. ej. Gerente general" /></Etiqueta>
        </div>
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
              {rep.firma && <Boton tono="peligro" onClick={quitarFirma} disabled={subiendo}>Quitar</Boton>}
            </div>
          )}
          <p className="mt-1 text-[11px] text-gray-500">PNG o JPG, idealmente con fondo blanco o transparente.</p>
          {error && <p className="mt-1 max-w-xs text-[11px] text-red-600">{error}</p>}
        </div>

        <div className="min-w-[200px] flex-1 rounded-lg border border-gray-200 bg-gray-50 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Así sale al pie de lo que se firma</p>
          {!derivado ? <p className="text-xs text-gray-500">Comprobando…</p> : (
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
    </Seccion>
  );
}
