"use client";
// components/licitaciones/editor/PasoContenido.tsx — Paso 3 «Contenido» del editor de licitaciones: la
// PROPUESTA TÉCNICA. Portada, control del documento, carta, glosario, índice, las secciones con sus
// bloques y el cierre; la importación desde Word y la vista previa en PDF.
//
// Reglas del paso (contrato-editor.ts): el estado y el guardado son del editor; aquí solo se proponen
// cambios INMUTABLES con cambiarDoc. Lo que se imprime lo decide resolverDocumento (el mismo para la vista
// previa y la emisión); este paso no compone su propia versión de «esto saldrá».
//
// Anclas: los paneles llevan su nombre como id del DOM («portada», «control», «carta», «glosario»,
// «indice», «cierre», y «secciones» en la lista) y los elementos anclaDe("seccion"|"bloque", id). Como
// solo se pinta la sección elegida, el editor puede pasar `ancla` (opcional, misma forma que
// Hallazgo.donde.ancla) para que el paso elija la sección o el panel antes de llevar a él; también se
// atiende un #ancla de la dirección.

import { useCallback, useDeferredValue, useEffect, useEffectEvent, useMemo, useState } from "react";
import { subirArchivo } from "@/lib/licitaciones/datos";
import { resolverDocumento } from "@/lib/licitaciones/documento";
import { docDesdePlantilla } from "@/lib/licitaciones/plantilla-base";
import { valoresVariables } from "@/lib/licitaciones/texto";
import { TOPES_DOC, type DocLicitacion, type Hallazgo, type Seccion } from "@/lib/licitaciones/tipos";
import { anclaDe, type PasoProps } from "./contrato-editor";
import { Boton, TopeAlcanzado } from "./contenido/comun";
import { bloqueNuevo, bloquesConContenido, copiarSeccion, LIM, mover, numerosDeSecciones } from "./contenido/bloques";
import type { VistaAuto } from "./contenido/EditorBloque";
import EditorSeccion from "./contenido/EditorSeccion";
import Hallazgos from "./contenido/Hallazgos";
import ImportarWord from "./contenido/ImportarWord";
import ListaSecciones, { type Seleccion } from "./contenido/ListaSecciones";
import Comienzo from "./contenido/Comienzo";
import PanelPreliminarEditor, { PANELES_INICIO, type PanelPreliminar } from "./contenido/Preliminares";
import { ModalVistaPrevia, useVistaPrevia } from "./contenido/VistaPrevia";

const PANELES: readonly PanelPreliminar[] = [...PANELES_INICIO, "cierre"];
const esPanel = (x: string): x is PanelPreliminar => (PANELES as readonly string[]).includes(x);

/** La selección vigente: si la sección elegida ya no existe (se quitó), cae a la primera o a la portada. */
function selValida(s: Seleccion, doc: DocLicitacion): Seleccion {
  if (s.tipo === "seccion" && !doc.secciones.some((x) => x.id === s.id)) {
    return doc.secciones[0] ? { tipo: "seccion", id: doc.secciones[0].id } : { tipo: "panel", panel: "portada" };
  }
  return s;
}

/** A qué selección y a qué elemento del DOM lleva un ancla (la forma de Hallazgo.donde.ancla). */
function destinoDeAncla(ancla: string | null, doc: DocLicitacion): { sel: Seleccion | null; domId: string } {
  if (ancla) {
    const i = ancla.indexOf(":");
    const tipo = i < 0 ? ancla : ancla.slice(0, i), id = i < 0 ? "" : ancla.slice(i + 1);
    if (tipo === "bloque") {
      const s = doc.secciones.find((x) => x.bloques.some((b) => b.id === id));
      if (s) return { sel: { tipo: "seccion", id: s.id }, domId: anclaDe("bloque", id) };
    } else if (tipo === "seccion") {
      if (doc.secciones.some((x) => x.id === id)) return { sel: { tipo: "seccion", id }, domId: anclaDe("seccion", id) };
    } else if (i < 0 && esPanel(ancla)) {
      return { sel: { tipo: "panel", panel: ancla }, domId: ancla };
    }
  }
  return { sel: null, domId: "secciones" };
}

/** ¿Es un ancla de este paso? (para el #hash: el editor puede usarlo para otras cosas). */
const esAnclaDelPaso = (a: string) => a.startsWith("bloque:") || a.startsWith("seccion:") || esPanel(a);

/** Qué del contenido actual reemplazaría la plantilla base (para nombrarlo en la confirmación). */
function loQueSeReemplaza(doc: DocLicitacion): string[] {
  const out: string[] = [];
  if (doc.secciones.length) {
    const b = doc.secciones.reduce((a, s) => a + s.bloques.length, 0);
    out.push(`las ${doc.secciones.length} ${doc.secciones.length === 1 ? "sección actual" : "secciones actuales"} (${b} ${b === 1 ? "bloque" : "bloques"})`);
  }
  if ((doc.portada.titulo.trim() && doc.portada.titulo.trim() !== "Propuesta Técnica") || doc.portada.subtitulo.trim()) out.push("el título y el subtítulo de la portada");
  const c = doc.control;
  if ([c.documento, c.version, c.codigo, c.elaboradoPor, c.revisadoPor, c.aprobadoPor, c.confidencialidad].some((x) => x.trim())) out.push("el control del documento");
  const k = doc.carta;
  if ([k.lugarFecha, k.destinatario, k.atencion, k.referencia, k.cuerpo].some((x) => x.trim())) out.push("la carta de presentación");
  if (doc.glosario.entradas.length) out.push(`el glosario (${doc.glosario.entradas.length} ${doc.glosario.entradas.length === 1 ? "término" : "términos"})`);
  if (doc.cierre.texto.trim()) out.push("el cierre");
  return out;
}

type Cuenta = { alarma: number; otras: number };
const sumar = (m: Map<string, Cuenta>, k: string, h: Hallazgo) => {
  const c = m.get(k) ?? { alarma: 0, otras: 0 };
  if (h.gravedad === "alarma") c.alarma++; else c.otras++;
  m.set(k, c);
};
const CERO: Cuenta = { alarma: 0, otras: 0 };

export default function PasoContenido(p: PasoProps & { ancla?: string | null }) {
  const { lic, doc, cambiarDoc, ctx, revision, irA, soloLectura, nuevoId, aviso } = p;
  const [selElegida, setSel] = useState<Seleccion>(() => (doc.secciones[0] ? { tipo: "seccion", id: doc.secciones[0].id } : { tipo: "panel", panel: "portada" }));
  const sel = selValida(selElegida, doc);
  const [resaltado, setResaltado] = useState<string | null>(null);
  const [importando, setImportando] = useState(false);
  const vista = useVistaPrevia();

  const valores = useMemo(() => (ctx ? valoresVariables(lic, ctx) : null), [lic, ctx]);
  const numeros = useMemo(() => numerosDeSecciones(doc.secciones), [doc.secciones]);

  // ── Hallazgos de este paso, indexados por dónde se corrigen
  const hallazgos = useMemo(() => (revision ? revision.hallazgos.filter((h) => "paso" in h.donde && h.donde.paso === "contenido") : null), [revision]);
  const indice = useMemo(() => {
    const porBloque = new Map<string, Hallazgo[]>(), porSeccionH = new Map<string, Hallazgo[]>();
    const cuentaSeccion = new Map<string, Cuenta>(), cuentaPanel = new Map<string, Cuenta>();
    const seccionDeBloque = new Map<string, string>();
    for (const s of doc.secciones) for (const b of s.bloques) seccionDeBloque.set(b.id, s.id);
    for (const h of hallazgos ?? []) {
      if (h.aceptado || !("paso" in h.donde)) continue;
      const a = h.donde.ancla ?? "";
      if (a.startsWith("bloque:")) {
        const id = a.slice(7);
        porBloque.set(id, [...(porBloque.get(id) ?? []), h]);
        const s = seccionDeBloque.get(id);
        if (s) sumar(cuentaSeccion, s, h);
      } else if (a.startsWith("seccion:")) {
        const id = a.slice(8);
        porSeccionH.set(id, [...(porSeccionH.get(id) ?? []), h]);
        sumar(cuentaSeccion, id, h);
      } else if (esPanel(a)) sumar(cuentaPanel, a, h);
    }
    return { porBloque, porSeccionH, cuentaSeccion, cuentaPanel };
  }, [hallazgos, doc.secciones]);

  // ── Vista previa de las tablas automáticas de la sección elegida (el mismo resolvedor del PDF)
  const seccionSel = sel.tipo === "seccion" ? doc.secciones.find((s) => s.id === sel.id) ?? null : null;
  const selId = seccionSel?.id ?? null;
  const hayAuto = !!seccionSel?.bloques.some((b) => b.tipo === "auto");
  const licDiferida = useDeferredValue(lic);
  const vistaSeccion = useMemo<VistaAuto | null>(() => {
    if (!hayAuto || !selId) return null;
    if (!ctx || !revision) return { estado: "cargando" };
    try {
      const d = resolverDocumento(licDiferida, ctx, revision);
      return { estado: "ok", bloques: d.secciones.find((x) => x.id === selId)?.bloques ?? [] };
    } catch (e) {
      return { estado: "error", detalle: e instanceof Error ? e.message : String(e) };
    }
  }, [hayAuto, selId, ctx, revision, licDiferida]);

  const subirImagen = useCallback((file: File) => subirArchivo("imagenes", lic.id, file), [lic.id]);

  // ── Navegación a un ancla (hallazgos, el editor, el #hash)
  const llevarA = useCallback((domId: string) => {
    setResaltado(domId);
    setTimeout(() => document.getElementById(domId)?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
    setTimeout(() => setResaltado((r) => (r === domId ? null : r)), 2600);
  }, []);
  const navegar = useCallback((ancla: string | null) => {
    const d = destinoDeAncla(ancla, doc);
    if (d.sel) setSel(d.sel);
    llevarA(d.domId);
  }, [doc, llevarA]);
  const alAncla = useEffectEvent((a: string) => navegar(a));
  useEffect(() => {
    const a = p.ancla;
    if (!a) return;
    const t = setTimeout(() => alAncla(a), 0);
    return () => clearTimeout(t);
  }, [p.ancla]);
  useEffect(() => {
    const leer = () => {
      let h = "";
      try { h = decodeURIComponent(window.location.hash.slice(1)); } catch { h = ""; }
      if (h && esAnclaDelPaso(h)) alAncla(h);
    };
    const t = setTimeout(leer, 0);
    window.addEventListener("hashchange", leer);
    return () => { clearTimeout(t); window.removeEventListener("hashchange", leer); };
  }, []);

  // ── Secciones
  const lleno = doc.secciones.length >= TOPES_DOC.maxSecciones;
  const cambiarSeccion = (id: string, fn: (s: Seccion) => Seccion) => cambiarDoc((d) => ({ ...d, secciones: d.secciones.map((s) => (s.id === id ? fn(s) : s)) }));
  const insertarSeccion = (s: Seccion, pos: number) => {
    cambiarDoc((d) => {
      if (d.secciones.length >= TOPES_DOC.maxSecciones) return d;
      const o = [...d.secciones];
      o.splice(Math.min(pos, o.length), 0, s);
      return { ...d, secciones: o };
    });
    setSel({ tipo: "seccion", id: s.id });
    llevarA(anclaDe("seccion", s.id));
  };
  const agregarSeccion = () => {
    if (lleno) return;
    insertarSeccion({ id: nuevoId(), titulo: "", activa: true, numerada: true, bloques: [bloqueNuevo("parrafo", nuevoId)] }, doc.secciones.length);
  };
  const duplicarSeccion = (i: number) => {
    if (lleno) return;
    const s = doc.secciones[i];
    insertarSeccion(copiarSeccion(s, nuevoId, s.titulo ? `${s.titulo} (copia)`.slice(0, LIM.tituloSeccion) : ""), i + 1);
  };
  const quitarSeccion = (i: number) => {
    const s = doc.secciones[i];
    const n = bloquesConContenido(s);
    if (!window.confirm(`¿Quitar la sección «${s.titulo || "sin título"}»${n ? ` con sus ${n} ${n === 1 ? "bloque escrito" : "bloques escritos"}` : ""}? No se puede deshacer.`)) return;
    const vecina = doc.secciones[i + 1] ?? doc.secciones[i - 1] ?? null;
    cambiarDoc((d) => ({ ...d, secciones: d.secciones.filter((x) => x.id !== s.id) }));
    setSel(vecina ? { tipo: "seccion", id: vecina.id } : { tipo: "panel", panel: "portada" });
  };
  const moverSeccion = (de: number, a: number) => cambiarDoc((d) => ({ ...d, secciones: mover(d.secciones, de, a) }));

  // ── Comienzos
  const usarPlantilla = () => {
    const partes = loQueSeReemplaza(doc);
    if (partes.length && !window.confirm(`La plantilla base reemplazará ${partes.join(", ")}. El color y la imagen de portada se conservan. No se puede deshacer. ¿Seguir?`)) return;
    const base = docDesdePlantilla(nuevoId);
    cambiarDoc((d) => ({
      ...d,
      portada: { ...d.portada, titulo: base.portada.titulo, subtitulo: base.portada.subtitulo },
      control: base.control, carta: base.carta, glosario: base.glosario, indice: base.indice,
      secciones: base.secciones, cierre: base.cierre,
    }));
    if (base.secciones[0]) setSel({ tipo: "seccion", id: base.secciones[0].id });
    aviso(`Plantilla base aplicada: ${base.secciones.length} secciones. Completa las marcas [COMPLETAR] que nombra la revisión.`, "ok");
  };
  const empezarEnBlanco = () => agregarSeccion();

  const ir = (h: Hallazgo) => {
    if ("paso" in h.donde) {
      if (h.donde.paso === "contenido") navegar(h.donde.ancla);
      else irA(h.donde.paso, h.donde.ancla);
    }
  };
  const puedeVer = !!ctx && !!revision;
  const indiceSel = seccionSel ? doc.secciones.findIndex((s) => s.id === seccionSel.id) : -1;

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-[#0b315f]">Contenido de la propuesta técnica</h2>
          <p className="text-xs text-gray-500">El texto admite **negrita**, {"{variables}"} que salen del ERP y la marca [COMPLETAR]. Se guarda solo.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Boton tono="primario" onClick={() => { if (ctx && revision) vista.generar(lic, ctx, revision); }} disabled={!puedeVer}>👁 Vista previa PDF</Boton>
          {!soloLectura ? (
            <>
              <Boton onClick={() => setImportando(true)}>📄 Importar desde Word</Boton>
              <Boton tono="suave" onClick={usarPlantilla}>📋 Plantilla base</Boton>
            </>
          ) : null}
        </div>
      </div>
      {!puedeVer ? <p className="-mt-2 text-right text-xs text-gray-500">La vista previa se habilita cuando terminen de leerse los datos del ERP…</p> : null}

      <Hallazgos hallazgos={hallazgos} ir={ir} irRevision={() => irA("revision", "hallazgos")} />

      {!doc.secciones.length && !soloLectura ? <Comienzo plantilla={usarPlantilla} importar={() => setImportando(true)} blanco={empezarEnBlanco} /> : null}

      <div className="grid min-w-0 gap-4 md:grid-cols-[15rem_minmax(0,1fr)] lg:grid-cols-[17rem_minmax(0,1fr)]">
        <div id="secciones" className="min-w-0 scroll-mt-24">
          <ListaSecciones doc={doc} sel={sel} elegir={setSel} numeros={numeros} soloLectura={soloLectura}
            cuentaPanel={(x) => indice.cuentaPanel.get(x) ?? CERO} cuentaSeccion={(id) => indice.cuentaSeccion.get(id) ?? CERO}
            agregarSeccion={agregarSeccion} moverSeccion={moverSeccion} />
        </div>
        <div className="min-w-0">
          {sel.tipo === "panel" ? (
            <PanelPreliminarEditor panel={sel.panel} lic={lic} doc={doc} ctx={ctx} cambiarDoc={cambiarDoc} soloLectura={soloLectura}
              valores={valores} aviso={aviso} subirImagen={subirImagen} irA={irA} nuevoId={nuevoId}
              resaltado={resaltado === sel.panel} domId={sel.panel} />
          ) : seccionSel ? (
            <EditorSeccion key={seccionSel.id} seccion={seccionSel} numero={numeros.get(seccionSel.id) ?? null} indice={indiceSel} total={doc.secciones.length}
              cambiar={(fn) => cambiarSeccion(seccionSel.id, fn)}
              mover={(d) => moverSeccion(indiceSel, indiceSel + d)}
              duplicar={() => duplicarSeccion(indiceSel)} quitar={() => quitarSeccion(indiceSel)} puedeAgregarSeccion={!lleno}
              soloLectura={soloLectura} valores={valores} aviso={aviso} nuevoId={nuevoId} subirImagen={subirImagen} irA={irA}
              vistaDe={() => vistaSeccion} hallazgosDe={(id) => indice.porBloque.get(id) ?? []}
              hallazgosSeccion={indice.porSeccionH.get(seccionSel.id) ?? []} resaltado={resaltado} />
          ) : (
            <div className="rounded-2xl border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
              Elige una parte de la propuesta en la lista.
              {lleno ? <TopeAlcanzado>Tope de {TOPES_DOC.maxSecciones} secciones.</TopeAlcanzado> : null}
            </div>
          )}
        </div>
      </div>

      {importando ? (
        <ImportarWord doc={doc} cambiarDoc={cambiarDoc} nuevoId={nuevoId} aviso={aviso} subirImagen={subirImagen}
          cerrar={() => setImportando(false)}
          alTerminar={(id) => { setImportando(false); if (id) { setSel({ tipo: "seccion", id }); llevarA(anclaDe("seccion", id)); } }} />
      ) : null}
      <ModalVistaPrevia estado={vista.estado} cerrar={vista.cerrar} regenerar={() => { if (ctx && revision) vista.generar(lic, ctx, revision); }} />
    </div>
  );
}
