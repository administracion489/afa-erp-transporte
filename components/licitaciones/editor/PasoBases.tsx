"use client";
// components/licitaciones/editor/PasoBases.tsx — Paso 1 · Bases y requisitos.
//
// Arriba lo que la revisión pide corregir en este paso; después los datos del concurso (columnas), las
// bases subidas, la lectura con IA y su revisión (la IA PROPONE, la persona acepta cada punto), el
// checklist de requisitos con lo que comprueba el motor, y las consultas absueltas.
// Paneles (ids del DOM, contrato-editor.ts → PANELES): datos · bases_subidas · analisis · requisitos ·
// consultas; cada requisito es anclaDe("requisito", id) y cada consulta anclaDe("consulta", id).
import type { PasoProps } from "./contrato-editor";
import { useEditorExtra } from "./contexto-editor";
import { useTiendaIA } from "./analisis-ia";
import HallazgosPaso from "./HallazgosPaso";
import RevisarAnalisis from "./RevisarAnalisis";
import DatosConcurso from "./bases/DatosConcurso";
import ArchivosBases from "./bases/ArchivosBases";
import LeerConIA from "./bases/LeerConIA";
import RequisitosBases from "./bases/RequisitosBases";
import ConsultasBases from "./bases/ConsultasBases";

export default function PasoBases(p: PasoProps) {
  const { fase, pendiente } = useEditorExtra();
  const tienda = useTiendaIA();
  const conflicto = fase === "conflicto"
    ? "Otra persona guardó la licitación y el guardado está detenido: la IA lee lo GUARDADO, así que primero resuelve el conflicto (arriba)."
    : null;
  const resultado = tienda?.resultado ?? null;

  return (
    <div className="space-y-4">
      <HallazgosPaso revision={p.revision} ctxCargando={p.ctxCargando} paso="bases" irA={p.irA} />

      <DatosConcurso lic={p.lic} cambiarColumnas={p.cambiarColumnas} soloLectura={p.soloLectura} />

      <ArchivosBases lic={p.lic} doc={p.doc} cambiarDoc={p.cambiarDoc} soloLectura={p.soloLectura} bloqueado={null} aviso={p.aviso} />

      <div id={resultado ? undefined : "analisis"} className="space-y-4 scroll-mt-4">
        {tienda
          ? <LeerConIA doc={p.doc} tienda={tienda} soloLectura={p.soloLectura} bloqueado={conflicto} pendiente={pendiente} />
          : <p className="text-xs text-gray-500">La lectura con IA no está disponible fuera del editor.</p>}
        {tienda && resultado && (
          <RevisarAnalisis
            r={resultado} lic={p.lic} doc={p.doc} cambiarDoc={p.cambiarDoc} cambiarColumnas={p.cambiarColumnas}
            nuevoId={p.nuevoId} soloLectura={p.soloLectura} aviso={p.aviso} irA={p.irA}
            onCerrar={tienda.descartar} onAplicado={tienda.marcarAplicado}
          />
        )}
      </div>

      <RequisitosBases doc={p.doc} cambiarDoc={p.cambiarDoc} revision={p.revision} ctxCargando={p.ctxCargando}
        irA={p.irA} soloLectura={p.soloLectura} nuevoId={p.nuevoId} aviso={p.aviso} />

      <ConsultasBases doc={p.doc} cambiarDoc={p.cambiarDoc} soloLectura={p.soloLectura} nuevoId={p.nuevoId} />
    </div>
  );
}
