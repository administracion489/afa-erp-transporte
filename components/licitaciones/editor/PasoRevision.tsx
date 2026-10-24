"use client";
// components/licitaciones/editor/PasoRevision.tsx — Paso 5 «Revisión y emisión» del editor de
// /licitaciones/[id]: los HALLAZGOS de toda la licitación (aceptables con nota), la comprobación de los
// archivos, la EMISIÓN en el navegador y el historial de emisiones.
//
// Sigue el contrato de contrato-editor.ts: el editor es el dueño del estado y del guardado; este paso solo
// cambia `doc.aceptados` con `cambiarDoc`. La emisión exige lo GUARDADO: llama a `guardarAhora()` (de
// useEditorExtra) y aborta diciendo por qué si no se pudo.
//
// Reglas de la pantalla:
//  · Nunca se afirma un vacío mientras se lee: «comprobando…», nunca «sin hallazgos» ni «sin emisiones»
//    sin haber leído (y una lectura fallida se dice como fallida).
//  · Ningún hallazgo bloquea la emisión (D7): se corrige o se acepta con nota, y queda registrado.
//  · La emisión es de escritorio (R12): arma PDF de cientos de MB que un teléfono no sostiene.
//  · Solo lectura: se ve todo y se abren las emisiones anteriores, pero no se emite ni se acepta.
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ultimaEmision } from "@/lib/licitaciones/datos";
import { revisarLicitacion } from "@/lib/licitaciones/revision";
import type { FilaEmision, Revision } from "@/lib/licitaciones/tipos";
import { CONSULTA_PANTALLA_CHICA, useConsultaMedia } from "@/lib/useConsultaMedia";
import type { PasoProps } from "./contrato-editor";
import { useEditorExtra } from "./contexto-editor";
import { instanteLima } from "./etiquetas";
import PanelHallazgos from "./revision/PanelHallazgos";
import ComprobarArchivos, { type Comprobacion } from "./revision/ComprobarArchivos";
import ModalEmision, { type Instantanea } from "./revision/ModalEmision";
import Historial, { useHistorial } from "./revision/Historial";
import { nombreUsuarioActual } from "./revision/consultas";
import { firmaArchivos } from "./revision/resumen";
import { BOTON_PRIMARIO, BOTON_SECUNDARIO, Nota, Seccion } from "./revision/ui";

/** La emisión arma PDF de cientos de MB en el navegador: solo desde una computadora. */
const CONSULTA_ESCRITORIO = "(min-width: 1024px)";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e ?? ""));

export default function PasoRevision(p: PasoProps) {
  const extra = useEditorExtra();
  const escritorio = useConsultaMedia(CONSULTA_ESCRITORIO);
  const pantallaChica = useConsultaMedia(CONSULTA_PANTALLA_CHICA);
  const licId = p.lic.id;

  // ── Quién acepta (best-effort; null si no se supo) ──
  const [nombreUsuario, setNombreUsuario] = useState<string | null>(null);
  useEffect(() => {
    let vivo = true;
    void nombreUsuarioActual().then((n) => { if (vivo) setNombreUsuario(n); });
    return () => { vivo = false; };
  }, []);

  // ── La última emisión COMPLETA (con su foto, hasta 6 MB): se pide solo cuando hace falta ──
  const [ultima, setUltima] = useState<FilaEmision | null>(null);
  const [errorUltima, setErrorUltima] = useState<string | null>(null);
  const ultimaPromesa = useRef<Promise<FilaEmision | null> | null>(null);
  const asegurarUltima = useCallback((): Promise<FilaEmision | null> => {
    if (!ultimaPromesa.current) {
      ultimaPromesa.current = ultimaEmision(licId).then(
        (r) => {
          if (r.ok) { setUltima(r.emision); setErrorUltima(null); return r.emision; }
          setErrorUltima(r.error); ultimaPromesa.current = null; return null;
        },
        (e) => { setErrorUltima(msg(e) || "error inesperado"); ultimaPromesa.current = null; return null; },
      );
    }
    return ultimaPromesa.current;
  }, [licId]);

  // ── Comprobación de archivos (el ensayo) y la revisión recalculada con ella ──
  const [comprobacion, setComprobacion] = useState<Comprobacion | null>(null);
  const firmaActual = useMemo(() => firmaArchivos(p.doc), [p.doc]);
  const alComprobar = useCallback((c: Comprobacion | null) => {
    setComprobacion(c);
    if (c) void asegurarUltima();
  }, [asegurarUltima]);

  const licDiferida = useDeferredValue(p.lic);
  const revLocal = useMemo<{ revision: Revision | null; error: string | null }>(() => {
    if (!comprobacion || !p.ctx) return { revision: null, error: null };
    try { return { revision: revisarLicitacion(licDiferida, p.ctx, comprobacion.revisiones, ultima), error: null }; }
    catch (e) { return { revision: null, error: msg(e) || "error inesperado" }; }
  }, [comprobacion, p.ctx, licDiferida, ultima]);
  const revision = revLocal.revision ?? p.revision;
  const conArchivos = comprobacion && revLocal.revision ? `Incluye la comprobación de archivos del ${instanteLima(comprobacion.en)}.` : null;

  // ── Historial ──
  const [vezHistorial, setVezHistorial] = useState(0);
  const historial = useHistorial(licId, vezHistorial);
  const proximaVersion = historial.fase === "ok" ? Math.max(0, ...historial.filas.map((f) => f.version)) + 1 : null;

  // ── Lo que el modal lee DESPUÉS de guardar (las props de ese momento quedan viejas) ──
  const inst = useRef<Instantanea>({ lic: p.lic, ctx: p.ctx, pendiente: extra.pendiente, fase: extra.fase, errorGuardado: extra.errorGuardado });
  useEffect(() => {
    inst.current = { lic: p.lic, ctx: p.ctx, pendiente: extra.pendiente, fase: extra.fase, errorGuardado: extra.errorGuardado };
  });
  const leer = useCallback(() => inst.current, []);

  const [modal, setModal] = useState(false);
  // Abierto el modal, no se desmonta por un parpadeo de la revisión (cancelaría una emisión en curso):
  // se queda con la última revisión válida.
  const [revModal, setRevModal] = useState<Revision | null>(null);
  if (revision && revision !== revModal) setRevModal(revision);
  const { aviso } = p;
  const onEmitida = useCallback((fila: FilaEmision) => {
    setUltima(fila);
    ultimaPromesa.current = Promise.resolve(fila);
    setVezHistorial((v) => v + 1);
    aviso(`Emisión versión ${fila.version} registrada.`);
  }, [aviso]);
  const cerrarModal = useCallback(() => setModal(false), []);

  const motivoNoEmitir: string | null =
    !p.ctx ? (p.ctxCargando ? "Leyendo lo que el ERP sabe de la licitación…" : "No se pudo leer lo que el ERP sabe de la licitación: reintenta arriba antes de emitir.")
    : !revision ? "Esperando la revisión…"
    : extra.fase === "conflicto" ? "Otra persona guardó esta licitación: resuelve el aviso de arriba (recargar o guardar como copia) antes de emitir."
    : null;
  const hayEmisiones = historial.fase === "ok" && historial.filas.length > 0;

  return (
    <div className="space-y-4">
      <PanelHallazgos
        revision={revision} ctxCargando={p.ctxCargando} doc={p.doc} soloLectura={p.soloLectura}
        irA={p.irA} cambiarDoc={p.cambiarDoc} recargarCtx={p.recargarCtx} aviso={p.aviso}
        nombreUsuario={nombreUsuario} conArchivos={conArchivos}
      />
      {revLocal.error && (
        <Nota tono="ambar">No se pudo recalcular la revisión con la comprobación de archivos ({revLocal.error}): se enseña la revisión sin ella.</Nota>
      )}

      <ComprobarArchivos
        lic={p.lic} ctx={p.ctx} revision={p.revision} comprobacion={comprobacion}
        firmaActual={firmaActual} pantallaChica={pantallaChica} onListo={alComprobar}
      />

      <Seccion
        id="emision"
        titulo="Emisión"
        subtitulo="Arma en tu navegador la propuesta técnica en PDF, un PDF por bloque del expediente y el expediente completo foliado; los descarga (ZIP o sueltos), guarda una copia de cada uno como constancia y registra la emisión. Lo emitido no se reescribe."
        acciones={!p.soloLectura && escritorio ? (
          <button type="button" onClick={() => setModal(true)} disabled={!!motivoNoEmitir} className={BOTON_PRIMARIO}>
            Emitir…
          </button>
        ) : undefined}
      >
        {p.soloLectura ? (
          <Nota tono="gris">Solo lectura (licitación archivada o sin permiso de escritura): se ve todo y se abren las emisiones anteriores, pero no se emite.</Nota>
        ) : !escritorio ? (
          <Nota tono="gris">La emisión se hace desde una computadora (pantalla de 1024 px o más): arma PDF que pueden pesar cientos de MB y un teléfono no los sostiene. Desde aquí puedes revisar los hallazgos y abrir las emisiones anteriores.</Nota>
        ) : (
          <>
            {motivoNoEmitir && <p className="text-xs text-gray-600">{motivoNoEmitir}</p>}
            {!motivoNoEmitir && extra.pendiente && <p className="text-xs text-gray-500">Hay cambios sin guardar: se guardan antes de emitir.</p>}
            {!motivoNoEmitir && extra.fase === "error" && extra.errorGuardado && (
              <Nota tono="ambar">El último guardado falló ({extra.errorGuardado}): al emitir se reintenta, y si vuelve a fallar no se emite.</Nota>
            )}
          </>
        )}
        {errorUltima && (
          <Nota tono="gris">
            No se pudo leer la última emisión ({errorUltima}): la revisión no podrá decir qué archivos cambiaron desde ella.
            <button type="button" onClick={() => void asegurarUltima()} className="ml-1 font-bold underline">Reintentar</button>
          </Nota>
        )}
        {hayEmisiones && p.lic.estado === "preparacion" && !p.soloLectura && (
          <Nota tono="gris">
            ¿Ya la presentaste? El estado sigue «En preparación».
            <button type="button" onClick={() => p.irA("bases", "datos")} className="ml-1 font-bold underline">Cambiarlo en Bases y requisitos</button>
          </Nota>
        )}

        <div className="border-t border-gray-100 pt-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-gray-800">Emisiones anteriores</h3>
            {historial.fase !== "cargando" && (
              <button type="button" onClick={() => setVezHistorial((v) => v + 1)} className={BOTON_SECUNDARIO}>Actualizar</button>
            )}
          </div>
          <Historial lectura={historial} onReintentar={() => setVezHistorial((v) => v + 1)} />
        </div>
      </Seccion>

      {modal && p.ctx && revModal && (
        <ModalEmision
          lic={p.lic} ctx={p.ctx} revision={revModal} comprobacion={comprobacion}
          comprobacionVieja={!!comprobacion && comprobacion.firma !== firmaActual}
          pendiente={extra.pendiente} faseGuardado={extra.fase}
          leer={leer} guardarAhora={extra.guardarAhora} asegurarUltima={asegurarUltima}
          proximaVersion={proximaVersion} onEmitida={onEmitida} onCerrar={cerrarModal}
        />
      )}
    </div>
  );
}
