"use client";
// components/licitaciones/editor/contenido/ImportarWord.tsx — «Importar desde Word (.docx)».
//
// El importador (lib/licitaciones/docx/importar.ts, puro) lee el archivo EN EL NAVEGADOR y devuelve
// secciones, preliminares (control, glosario, carta, imagen de portada y el texto suelto de antes del primer
// título), imágenes y avisos. Esta pantalla:
//  · enseña lo que trajo y deja ELEGIR: qué secciones, si reemplazan o se agregan al final, y si se aplican
//    el control, la carta, el glosario y la portada (nada de eso se pisa sin que se marque);
//  · sube SOLO las imágenes que usan los bloques elegidos (y la portada, si se elige), y solo PNG/JPG — un
//    GIF se convierte a PNG en el navegador; lo que no se puede, se NOMBRA y el bloque queda sin archivo
//    (la revisión lo marca como «imagen sin archivo»);
//  · aplica todo en UN cambio del documento, cuando las subidas terminaron.
// Se carga recién al pulsar el botón (`await import`), como pdf-lib.
// El bucket no deja borrar (R3): una imagen subida y no usada (p. ej. si se cierra a mitad) queda en él.

import { useEffect, useRef, useState } from "react";
import { TOPES_DOC, type ArchivoRef, type Bloque, type Carta, type ControlDocumento, type DocLicitacion, type EntradaGlosario, type ResultadoImportacion, type Seccion } from "@/lib/licitaciones/tipos";
import { Boton, Interruptor } from "./comun";
import { LIM } from "./bloques";

type ResultadoOk = Extract<ResultadoImportacion, { ok: true }>;
type Aviso = (texto: string, tono?: "ok" | "error" | "aviso") => void;
type Fase =
  | { f: "elegir" }
  | { f: "leyendo"; nombre: string }
  | { f: "error"; detalle: string }
  | { f: "resumen"; nombre: string; r: ResultadoOk }
  | { f: "aplicando"; hecho: number; total: number; detalle: string }
  | { f: "hecho"; secciones: number; imagenes: number; fallos: string[]; primera: string | null };

type Opciones = {
  modo: "reemplazar" | "agregar";
  fuera: Set<string>;                   // secciones NO elegidas
  control: boolean; carta: boolean; portada: boolean; resto: boolean;
  glosario: "reemplazar" | "agregar" | "no";
};

const ETQ_CONTROL: Partial<Record<keyof ControlDocumento, string>> = {
  documento: "Documento", version: "Versión", codigo: "Código", elaboradoPor: "Elaborado por", revisadoPor: "Revisado por",
  aprobadoPor: "Aprobado por", fecha: "Fecha", confidencialidad: "Confidencialidad",
};
const ETQ_CARTA: Partial<Record<keyof Carta, string>> = {
  lugarFecha: "Lugar y fecha", destinatario: "Destinatario", atencion: "Atención", referencia: "Referencia", cuerpo: "Cuerpo", despedida: "Despedida",
};

const conTexto = (v: unknown) => (typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined);

/** Pone en `base` los campos que el Word sí trae (los vacíos no pisan nada). */
function fusionar<T extends object>(base: T, parcial: Partial<T> | null): T {
  if (!parcial) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(parcial)) if (conTexto(v)) out[k] = v;
  return out as T;
}

const claveTermino = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

async function gifAPng(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/gif" }));
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext("2d");
    if (!g) return null;
    g.drawImage(bmp, 0, 0);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch { return null; }
}

const imagenesDe = (s: Seccion, pendientes: Record<string, string>) => s.bloques.filter((b) => b.tipo === "imagen" && pendientes[b.id]).length;

export default function ImportarWord({ doc, cambiarDoc, nuevoId, aviso, subirImagen, cerrar, alTerminar }: {
  doc: DocLicitacion;
  cambiarDoc: (fn: (d: DocLicitacion) => DocLicitacion) => void;
  nuevoId: () => string;
  aviso: Aviso;
  subirImagen: (file: File) => Promise<ArchivoRef>;
  cerrar: () => void;
  alTerminar: (primeraSeccionId: string | null) => void;
}) {
  const [fase, setFase] = useState<Fase>({ f: "elegir" });
  const [opc, setOpc] = useState<Opciones>({ modo: "agregar", fuera: new Set(), control: true, carta: true, portada: true, resto: false, glosario: "agregar" });
  const [portadaUrl, setPortadaUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  const ocupado = fase.f === "leyendo" || fase.f === "aplicando";
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => { if (e.key === "Escape" && !ocupado) cerrar(); };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [ocupado, cerrar]);

  const leer = async (file: File | undefined) => {
    if (!file) return;
    setFase({ f: "leyendo", nombre: file.name });
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; setPortadaUrl(null); }
    await new Promise((r) => setTimeout(r, 30));          // que se pinte «Leyendo…» antes del trabajo pesado
    let r: ResultadoImportacion;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { importarDocx } = await import("@/lib/licitaciones/docx/importar");
      r = importarDocx(bytes, { nuevoId });
    } catch (e) {
      setFase({ f: "error", detalle: e instanceof Error ? `No se pudo leer el archivo: ${e.message}` : "No se pudo leer el archivo." });
      return;
    }
    if (!r.ok) { setFase({ f: "error", detalle: r.detalle }); return; }
    const p = r.preliminares;
    const img = p.portadaImagen ? r.imagenes.find((i) => i.clave === p.portadaImagen) : null;
    if (img) {
      const u = URL.createObjectURL(new Blob([img.bytes as BlobPart], { type: img.mime }));
      urlRef.current = u;
      setPortadaUrl(u);
    }
    setOpc({
      modo: doc.secciones.length ? "agregar" : "reemplazar", fuera: new Set(),
      control: !!p.control, carta: !!p.carta, portada: !!p.portadaImagen, resto: false,
      glosario: p.glosario?.length ? (doc.glosario.entradas.length ? "agregar" : "reemplazar") : "no",
    });
    setFase({ f: "resumen", nombre: file.name, r });
  };

  const aplicar = async (r: ResultadoOk) => {
    const p = r.preliminares;
    const elegidas = r.secciones.filter((s) => !opc.fuera.has(s.id));
    const restoSec: Seccion | null = opc.resto && p.resto.length
      ? { id: nuevoId(), titulo: "Texto antes del primer título (importado)", activa: false, numerada: false, bloques: p.resto.slice(0, TOPES_DOC.maxBloquesSeccion) }
      : null;
    const cupo = opc.modo === "reemplazar" ? TOPES_DOC.maxSecciones : Math.max(0, TOPES_DOC.maxSecciones - doc.secciones.length);
    const nuevas = [...(restoSec ? [restoSec] : []), ...elegidas].slice(0, cupo);

    // Imágenes que de verdad se usan (una vez por clave).
    const claves: string[] = [];
    for (const s of nuevas) for (const b of s.bloques) if (b.tipo === "imagen") { const k = r.pendientes[b.id]; if (k && !claves.includes(k)) claves.push(k); }
    if (opc.portada && p.portadaImagen && !claves.includes(p.portadaImagen)) claves.push(p.portadaImagen);
    const porClave = new Map(r.imagenes.map((i) => [i.clave, i]));
    const subidas = new Map<string, ArchivoRef>();
    const fallos: string[] = [];
    for (let k = 0; k < claves.length; k++) {
      const img = porClave.get(claves[k]);
      let nombre = img?.ruta.split("/").pop() || `imagen-${k + 1}`;
      setFase({ f: "aplicando", hecho: k, total: claves.length, detalle: `Subiendo «${nombre}» (${k + 1} de ${claves.length})…` });
      if (!img) { fallos.push(`Una imagen del documento no se encontró dentro del archivo.`); continue; }
      let bytes: Uint8Array | null = img.bytes;
      let mime: "image/png" | "image/jpeg" | null = img.mime === "image/png" || img.mime === "image/jpeg" ? img.mime : null;
      if (img.mime === "image/gif") {
        bytes = await gifAPng(img.bytes);
        mime = bytes ? "image/png" : null;
        nombre = nombre.replace(/\.gif$/i, "") + ".png";
        if (!bytes) { fallos.push(`«${nombre}» es un GIF que no se pudo convertir: conviértela a PNG y súbela en su bloque.`); continue; }
      }
      if (!mime || !bytes) { fallos.push(`«${nombre}» no es PNG ni JPG: conviértela a PNG y súbela en su bloque.`); continue; }
      try {
        subidas.set(claves[k], await subirImagen(new File([bytes as BlobPart], nombre, { type: mime })));
      } catch (e) {
        fallos.push(`«${nombre}» no se pudo subir: ${e instanceof Error ? e.message : "error desconocido"}`);
      }
    }
    setFase({ f: "aplicando", hecho: claves.length, total: claves.length, detalle: "Aplicando al documento…" });

    const conArchivo = (b: Bloque): Bloque => {
      if (b.tipo !== "imagen") return b;
      const k = r.pendientes[b.id];
      return k ? { ...b, archivo: subidas.get(k) ?? null } : b;
    };
    const listas = nuevas.map((s) => ({ ...s, bloques: s.bloques.map(conArchivo) }));
    const portadaRef = opc.portada && p.portadaImagen ? subidas.get(p.portadaImagen) ?? null : null;
    const glos = p.glosario ?? [];
    cambiarDoc((d) => {
      let entradas: EntradaGlosario[] = d.glosario.entradas;
      if (opc.glosario === "reemplazar" && glos.length) entradas = glos.slice(0, LIM.glosario);
      else if (opc.glosario === "agregar" && glos.length) {
        const vistos = new Set(d.glosario.entradas.map((e) => claveTermino(e.termino)));
        entradas = [...d.glosario.entradas, ...glos.filter((e) => !vistos.has(claveTermino(e.termino)))].slice(0, LIM.glosario);
      }
      return {
        ...d,
        secciones: (opc.modo === "reemplazar" ? listas : [...d.secciones, ...listas]).slice(0, TOPES_DOC.maxSecciones),
        control: opc.control && p.control ? { ...fusionar(d.control, p.control), activo: true } : d.control,
        carta: opc.carta && p.carta ? { ...fusionar(d.carta, p.carta), activa: true } : d.carta,
        glosario: opc.glosario !== "no" && glos.length ? { activo: true, entradas } : d.glosario,
        portada: portadaRef ? { ...d.portada, modo: "imagen", imagen: portadaRef } : d.portada,
      };
    });
    const primera = elegidas.find((s) => nuevas.includes(s))?.id ?? listas[0]?.id ?? null;
    setFase({ f: "hecho", secciones: listas.length, imagenes: subidas.size, fallos, primera });
    aviso(`Importado: ${listas.length} ${listas.length === 1 ? "sección" : "secciones"}${subidas.size ? ` y ${subidas.size} ${subidas.size === 1 ? "imagen" : "imágenes"}` : ""}.`, fallos.length ? "aviso" : "ok");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Importar desde Word">
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden bg-white sm:max-h-[92vh] sm:rounded-2xl">
        <div className="flex items-center gap-2 border-b border-gray-200 px-4 py-3">
          <h2 className="min-w-0 flex-1 text-base font-semibold text-[#0b315f]">Importar desde Word (.docx)</h2>
          <Boton tam="sm" tono="suave" onClick={cerrar} disabled={ocupado}>✕ Cerrar</Boton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {fase.f === "elegir" || fase.f === "error" ? (
            <div className="space-y-3">
              <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
                <li>Cada <b>Título 1</b> del Word abre una sección; <b>Título 2 y 3</b> son subtítulos. La numeración escrita a mano se quita (la pone el ERP).</li>
                <li>Las tablas, listas, negritas e imágenes PNG/JPG entran como bloques. Las imágenes EMF/WMF y los gráficos no: se avisa.</li>
                <li>Lo que va antes del primer título se reconoce como control del documento, glosario, carta e imagen de portada; el índice del Word se omite (el ERP arma el suyo).</li>
                <li>Antes de aplicar se enseña todo y se elige qué entra: nada se reemplaza sin marcarlo.</li>
              </ul>
              <label className="flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-[#0b315f]/30 bg-[#0b315f]/[0.03] p-4 text-center hover:bg-[#0b315f]/[0.06]">
                <span className="text-sm font-semibold text-[#0b315f]">Elegir el archivo .docx</span>
                <span className="text-xs text-gray-500">Un documento de Word (.docx). Los .doc antiguos hay que guardarlos antes como .docx.</span>
                <input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr-only"
                  onChange={(e) => { void leer(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
              {fase.f === "error" ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{fase.detalle}</p> : null}
            </div>
          ) : fase.f === "leyendo" ? (
            <p className="py-10 text-center text-sm text-gray-600">Leyendo «{fase.nombre}»…</p>
          ) : fase.f === "aplicando" ? (
            <div className="py-10 text-center">
              <p className="text-sm text-gray-700">{fase.detalle}</p>
              {fase.total ? (
                <div className="mx-auto mt-3 h-2 w-64 max-w-full overflow-hidden rounded-full bg-gray-200">
                  <div className="h-full bg-[#0b315f] transition-all" style={{ width: `${Math.round((fase.hecho / fase.total) * 100)}%` }} />
                </div>
              ) : null}
              <p className="mt-3 text-xs text-gray-500">No cierres esta ventana hasta que termine.</p>
            </div>
          ) : fase.f === "hecho" ? (
            <div className="space-y-3">
              <p className="text-sm text-gray-800">Se importaron <b>{fase.secciones}</b> {fase.secciones === 1 ? "sección" : "secciones"}{fase.imagenes ? <> y se subieron <b>{fase.imagenes}</b> {fase.imagenes === 1 ? "imagen" : "imágenes"}</> : null}. El documento se guarda solo.</p>
              {fase.fallos.length ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                  <p className="font-semibold">{fase.fallos.length} {fase.fallos.length === 1 ? "imagen quedó" : "imágenes quedaron"} sin archivo (sus bloques siguen ahí, para subirlas a mano):</p>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">{fase.fallos.map((f, i) => <li key={i}>{f}</li>)}</ul>
                </div>
              ) : null}
              <p className="text-xs text-gray-500">Revisa las observaciones del contenido: el Word puede traer marcas, variables o datos de otra licitación.</p>
            </div>
          ) : (
            <Resumen r={fase.r} nombre={fase.nombre} doc={doc} opc={opc} setOpc={setOpc} portadaUrl={portadaUrl} />
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 px-4 py-3">
          {fase.f === "resumen" ? (
            <>
              <Boton tono="suave" onClick={() => setFase({ f: "elegir" })}>Elegir otro archivo</Boton>
              <Boton tono="primario" disabled={fase.r.secciones.every((s) => opc.fuera.has(s.id)) && !opc.control && !opc.carta && opc.glosario === "no" && !opc.portada && !opc.resto}
                onClick={() => {
                  const r = fase.r;
                  const n = r.secciones.filter((s) => !opc.fuera.has(s.id)).length;
                  if (opc.modo === "reemplazar" && doc.secciones.length && n
                    && !window.confirm(`Las ${doc.secciones.length} secciones actuales se reemplazarán por las ${n} del Word. No se puede deshacer. ¿Seguir?`)) return;
                  void aplicar(r);
                }}>
                Importar
              </Boton>
            </>
          ) : fase.f === "hecho" ? (
            <>
              <Boton onClick={cerrar}>Cerrar</Boton>
              {fase.primera ? <Boton tono="primario" onClick={() => alTerminar(fase.primera)}>Ir a lo importado →</Boton> : null}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Resumen({ r, nombre, doc, opc, setOpc, portadaUrl }: {
  r: ResultadoOk; nombre: string; doc: DocLicitacion; opc: Opciones; setOpc: (fn: (o: Opciones) => Opciones) => void; portadaUrl: string | null;
}) {
  const p = r.preliminares;
  const elegidas = r.secciones.filter((s) => !opc.fuera.has(s.id)).length + (opc.resto && p.resto.length ? 1 : 0);
  const cupo = opc.modo === "reemplazar" ? TOPES_DOC.maxSecciones : Math.max(0, TOPES_DOC.maxSecciones - doc.secciones.length);
  const bloques = r.secciones.reduce((a, s) => a + s.bloques.length, 0);
  const alternar = (id: string) => setOpc((o) => { const f = new Set(o.fuera); if (f.has(id)) f.delete(id); else f.add(id); return { ...o, fuera: f }; });
  const filasControl = p.control ? Object.entries(p.control).filter(([k, v]) => ETQ_CONTROL[k as keyof ControlDocumento] && conTexto(v)) : [];
  const filasCarta = p.carta ? Object.entries(p.carta).filter(([k, v]) => ETQ_CARTA[k as keyof Carta] && conTexto(v)) : [];
  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-700">«{nombre}»: {r.secciones.length} {r.secciones.length === 1 ? "sección" : "secciones"} con {bloques} bloques{r.imagenes.length ? ` y ${r.imagenes.length} ${r.imagenes.length === 1 ? "imagen" : "imágenes"}` : ""}.</p>

      {r.avisos.length ? (
        <details className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900" open={r.avisos.length <= 6}>
          <summary className="cursor-pointer font-semibold">{r.avisos.length} {r.avisos.length === 1 ? "aviso de la importación" : "avisos de la importación"} (lo que no entró igual que en el Word)</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {r.avisos.map((a, i) => <li key={i}>{a.texto}{a.donde ? <span className="text-amber-700"> · {a.donde}</span> : null}</li>)}
          </ul>
        </details>
      ) : null}

      <section>
        <h3 className="mb-1 text-sm font-semibold text-gray-800">Secciones</h3>
        {doc.secciones.length ? (
          <div className="mb-2 flex flex-wrap gap-4">
            <label className="inline-flex items-center gap-2 text-sm text-gray-700"><input type="radio" className="accent-[#0b315f]" checked={opc.modo === "agregar"} onChange={() => setOpc((o) => ({ ...o, modo: "agregar" }))} />Agregarlas al final de las {doc.secciones.length} actuales</label>
            <label className="inline-flex items-center gap-2 text-sm text-gray-700"><input type="radio" className="accent-[#0b315f]" checked={opc.modo === "reemplazar"} onChange={() => setOpc((o) => ({ ...o, modo: "reemplazar" }))} />Reemplazar las {doc.secciones.length} actuales</label>
          </div>
        ) : null}
        {elegidas > cupo ? <p className="mb-2 text-xs text-amber-800">Caben {cupo} de las {elegidas} elegidas (tope de {TOPES_DOC.maxSecciones} secciones): las últimas no entrarán.</p> : null}
        <ul className="max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-gray-200 p-1">
          {r.secciones.map((s, i) => {
            const nImg = imagenesDe(s, r.pendientes);
            return (
              <li key={s.id}>
                <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-gray-50">
                  <input type="checkbox" className="h-4 w-4 accent-[#0b315f]" checked={!opc.fuera.has(s.id)} onChange={() => alternar(s.id)} />
                  <span className="w-6 shrink-0 font-mono text-xs text-gray-400">{i + 1}.</span>
                  <span className="min-w-0 flex-1 truncate">{s.titulo || "Sin título"}</span>
                  <span className="shrink-0 text-[11px] text-gray-500">{s.bloques.length} bl.{nImg ? ` · ${nImg} img.` : ""}</span>
                </label>
              </li>
            );
          })}
        </ul>
        {p.resto.length ? (
          <div className="mt-2">
            <Interruptor marcado={opc.resto} cambiar={(v) => setOpc((o) => ({ ...o, resto: v }))}>
              Agregar los {p.resto.length} bloques sueltos de antes del primer título como una sección desactivada al principio
            </Interruptor>
          </div>
        ) : null}
      </section>

      {p.portadaImagen ? (
        <section className="flex flex-wrap items-start gap-3">
          {portadaUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={portadaUrl} alt="Portada del Word" className="h-32 w-auto rounded border border-gray-200 object-contain" />
          ) : null}
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-gray-800">Imagen de portada</h3>
            <Interruptor marcado={opc.portada} cambiar={(v) => setOpc((o) => ({ ...o, portada: v }))}>Usarla como portada (hoja completa)</Interruptor>
            {doc.portada.imagen && opc.portada ? <p className="text-xs text-amber-800">Reemplaza la imagen de portada actual.</p> : null}
          </div>
        </section>
      ) : null}

      {filasControl.length ? (
        <section>
          <h3 className="mb-1 text-sm font-semibold text-gray-800">Control del documento</h3>
          <TablaCampos filas={filasControl.map(([k, v]) => [ETQ_CONTROL[k as keyof ControlDocumento] ?? k, String(v)])} />
          <Interruptor marcado={opc.control} cambiar={(v) => setOpc((o) => ({ ...o, control: v }))}>Aplicarlo (pisa solo estos campos)</Interruptor>
        </section>
      ) : null}

      {filasCarta.length ? (
        <section>
          <h3 className="mb-1 text-sm font-semibold text-gray-800">Carta de presentación</h3>
          <TablaCampos filas={filasCarta.map(([k, v]) => [ETQ_CARTA[k as keyof Carta] ?? k, String(v)])} />
          <Interruptor marcado={opc.carta} cambiar={(v) => setOpc((o) => ({ ...o, carta: v }))}>Aplicarla (pisa solo estos campos)</Interruptor>
          <p className="text-xs text-gray-500">Revisa después que no nombre a otra empresa ni a otro cliente.</p>
        </section>
      ) : null}

      {p.glosario?.length ? (
        <section>
          <h3 className="mb-1 text-sm font-semibold text-gray-800">Glosario ({p.glosario.length} términos)</h3>
          <p className="mb-1 truncate text-xs text-gray-500">{p.glosario.slice(0, 8).map((e) => e.termino).join(" · ")}{p.glosario.length > 8 ? " …" : ""}</p>
          <div className="flex flex-wrap gap-4">
            {(["agregar", "reemplazar", "no"] as const).map((m) => (
              <label key={m} className="inline-flex items-center gap-2 text-sm text-gray-700">
                <input type="radio" className="accent-[#0b315f]" checked={opc.glosario === m} onChange={() => setOpc((o) => ({ ...o, glosario: m }))} />
                {m === "agregar" ? `Agregar los nuevos${doc.glosario.entradas.length ? ` a los ${doc.glosario.entradas.length} actuales` : ""}` : m === "reemplazar" ? "Reemplazar el glosario" : "No aplicarlo"}
              </label>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function TablaCampos({ filas }: { filas: [string, string][] }) {
  return (
    <div className="mb-1 max-h-48 overflow-y-auto rounded-lg border border-gray-200">
      <table className="w-full text-xs">
        <tbody>
          {filas.map(([k, v]) => (
            <tr key={k} className="border-t border-gray-100 first:border-0">
              <td className="w-32 px-2 py-1 align-top font-semibold text-gray-600">{k}</td>
              <td className="whitespace-pre-wrap break-words px-2 py-1 text-gray-800">{v.length > 400 ? `${v.slice(0, 400)}…` : v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
