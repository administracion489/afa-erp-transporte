"use client";
// components/licitaciones/editor/contenido/VistaPrevia.tsx — «👁 Vista previa PDF» del paso Contenido.
//
// Arma el PDF en el NAVEGADOR con el MISMO camino que la emisión (D10, D11): resolverDocumento decide qué
// se imprime y dibujarPropuesta lo dibuja con pdf-lib, que se carga recién al pulsar (no pesa en el resto
// del editor). No se arma en cada tecla: al pulsar, y otra vez con «Volver a generar».
//
// Solo se baja lo que es del storage de ESTE proyecto (la regla de la emisión, esArchivoDelErp): una URL de
// fuera escrita en el doc no se pide nunca. Las de los buckets privados se firman (firmarUrls) y se bajan en
// ese momento; el firmado no se guarda en ningún lado. Una imagen que no baja no tumba la vista previa: el PDF dibuja su recuadro con
// «imagen no disponible» y aquí se nombra. La marca BORRADOR va en cada hoja; los folios de la relación de
// adjuntos se calculan al emitir (aquí salen «—»).

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { firmarUrls } from "@/lib/storage-firmado";
import { resolverDocumento } from "@/lib/licitaciones/documento";
import { nombreArchivoEmitido } from "@/lib/licitaciones/archivos";
import type { ContextoLicitacion, Licitacion, Revision } from "@/lib/licitaciones/tipos";
import type { ImagenPdf } from "@/lib/pdf-corporativo";
import { Boton, esArchivoDelErp } from "./comun";

const TIMEOUT_IMAGEN_MS = 20_000;
const SIMULTANEAS = 4;

export type EstadoVista =
  | { fase: "cerrada" }
  | { fase: "armando"; paso: string }
  | { fase: "error"; detalle: string }
  | { fase: "lista"; url: string; nombre: string; paginas: number; bytes: number; recortes: string[]; faltantes: string[]; generadoEn: string };

function tipoPorBytes(b: Uint8Array): ImagenPdf["tipo"] | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  return null;
}

async function bajar(url: string): Promise<{ img: ImagenPdf } | { motivo: string }> {
  const ctl = new AbortController();
  const reloj = setTimeout(() => ctl.abort(), TIMEOUT_IMAGEN_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!r.ok) return { motivo: `el servidor respondió ${r.status}` };
    const b = new Uint8Array(await r.arrayBuffer());
    const tipo = tipoPorBytes(b);
    return tipo ? { img: { bytes: b, tipo } } : { motivo: "no es PNG ni JPG" };
  } catch (e) {
    return { motivo: ctl.signal.aborted ? "tardó demasiado en bajar" : e instanceof Error ? e.message : "no se pudo bajar" };
  } finally {
    clearTimeout(reloj);
  }
}

/** Qué es cada imagen del documento, para nombrarla si no baja. */
function rotulosDeImagenes(lic: Licitacion): Map<string, string> {
  const out = new Map<string, string>();
  const d = lic.doc;
  if (d.portada.modo === "imagen" && d.portada.imagen) out.set(d.portada.imagen.url, "la imagen de portada");
  for (const s of d.secciones) {
    if (!s.activa) continue;
    for (const b of s.bloques) if (b.tipo === "imagen" && b.archivo && !out.has(b.archivo.url)) out.set(b.archivo.url, `«${b.archivo.nombre}» de «${s.titulo || "sección sin título"}»`);
  }
  return out;
}

/** Arma el PDF de borrador. Nunca lanza: los problemas vuelven en `error` o en `faltantes`/`recortes`. */
export async function armarVistaPrevia(lic: Licitacion, ctx: ContextoLicitacion, rev: Revision, progreso: (paso: string) => void): Promise<Exclude<EstadoVista, { fase: "cerrada" | "armando" }>> {
  await Promise.resolve();
  let docRes;
  try {
    progreso("Resolviendo el contenido…");
    docRes = resolverDocumento(lic, ctx, rev);
  } catch (e) {
    return { fase: "error", detalle: `No se pudo resolver el contenido: ${e instanceof Error ? e.message : String(e)}` };
  }

  const rotulos = rotulosDeImagenes(lic);
  const imagenUrls = new Set<string>();
  if (docRes.portada.modo === "imagen" && docRes.portada.imagenUrl) imagenUrls.add(docRes.portada.imagenUrl);
  for (const s of docRes.secciones) for (const b of s.bloques) if (b.tipo === "imagen" && b.url) imagenUrls.add(b.url);
  const logoUrl = ctx.perfil?.logo_url?.trim() || null;
  const firmaUrl = docRes.firmante?.firmaUrl ?? null;
  const todas = [...imagenUrls, ...(logoUrl ? [logoUrl] : []), ...(firmaUrl ? [firmaUrl] : [])];

  const faltantes: string[] = [];
  const bajadas = new Map<string, ImagenPdf | null>();
  const que = (u: string) => (u === logoUrl ? "el logo de la empresa" : u === firmaUrl ? "la imagen de la firma" : rotulos.get(u) ?? "una imagen");
  // La misma regla que la emisión: solo se pide lo que es del storage de este proyecto. Una URL de fuera
  // no se toca (ni se firma ni se baja): se nombra y el PDF dibuja su recuadro.
  const cola = [...new Set(todas)].filter((u) => {
    if (esArchivoDelErp(u)) return true;
    bajadas.set(u, null);
    faltantes.push(`No se bajó ${que(u)}: no es un archivo del ERP (enlace externo). Súbela de nuevo.`);
    return false;
  });
  if (cola.length) {
    progreso(`Bajando ${cola.length} ${cola.length === 1 ? "imagen" : "imágenes"}…`);
    let firmadas = new Map<string, string>();
    try { firmadas = await firmarUrls(supabase, cola); } catch { /* se usan los originales */ }
    const trabajar = async () => {
      for (let u = cola.shift(); u !== undefined; u = cola.shift()) {
        const r = await bajar(firmadas.get(u) ?? u);
        if ("img" in r) bajadas.set(u, r.img);
        else {
          bajadas.set(u, null);
          faltantes.push(`No se pudo bajar ${que(u)}: ${r.motivo}.`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SIMULTANEAS, cola.length) }, trabajar));
  }

  progreso("Dibujando el PDF…");
  try {
    const { dibujarPropuesta } = await import("@/lib/licitaciones/pdf/propuesta");
    const imagenes: Record<string, ImagenPdf | null> = {};
    for (const u of imagenUrls) imagenes[u] = bajadas.get(u) ?? null;
    const r = await dibujarPropuesta(
      { doc: docRes, imagenes, logo: logoUrl ? bajadas.get(logoUrl) ?? null : null, firma: firmaUrl ? bajadas.get(firmaUrl) ?? null : null },
      { marcaAgua: "BORRADOR" },
    );
    const blob = new Blob([r.bytes as BlobPart], { type: "application/pdf" });
    return {
      fase: "lista", url: URL.createObjectURL(blob), nombre: nombreArchivoEmitido(`Borrador ${lic.nombre || "propuesta tecnica"}`, "pdf"),
      paginas: r.paginas, bytes: r.bytes.length, recortes: r.recortes, faltantes,
      generadoEn: new Date().toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", timeZone: "America/Lima" }),
    };
  } catch (e) {
    return { fase: "error", detalle: `No se pudo dibujar el PDF: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Estado de la vista previa con su blob: el enlace anterior se libera al regenerar, cerrar o desmontar. */
export function useVistaPrevia() {
  const [estado, setEstado] = useState<EstadoVista>({ fase: "cerrada" });
  const urlRef = useRef<string | null>(null);
  const turno = useRef(0);
  const liberar = () => { if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; } };
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);

  const generar = useCallback((lic: Licitacion, ctx: ContextoLicitacion, rev: Revision) => {
    const mio = ++turno.current;
    liberar();
    setEstado({ fase: "armando", paso: "Preparando…" });
    void armarVistaPrevia(lic, ctx, rev, (paso) => { if (turno.current === mio) setEstado({ fase: "armando", paso }); }).then((r) => {
      if (turno.current !== mio) { if (r.fase === "lista") URL.revokeObjectURL(r.url); return; }
      if (r.fase === "lista") urlRef.current = r.url;
      setEstado(r);
    });
  }, []);
  const cerrar = useCallback(() => { turno.current++; liberar(); setEstado({ fase: "cerrada" }); }, []);
  return { estado, generar, cerrar };
}

export function ModalVistaPrevia({ estado, cerrar, regenerar }: { estado: EstadoVista; cerrar: () => void; regenerar: () => void }) {
  useEffect(() => {
    if (estado.fase === "cerrada") return;
    const tecla = (e: KeyboardEvent) => { if (e.key === "Escape") cerrar(); };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [estado.fase, cerrar]);
  const [detalles, setDetalles] = useState(false);
  if (estado.fase === "cerrada") return null;
  const lista = estado.fase === "lista" ? estado : null;
  const avisos = lista ? [...lista.faltantes, ...lista.recortes] : [];
  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 sm:p-4" role="dialog" aria-modal="true" aria-label="Vista previa de la propuesta técnica">
      <div className="flex h-full w-full max-w-6xl flex-col overflow-hidden bg-white sm:rounded-2xl">
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2 sm:px-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-[#0b315f]">Vista previa · borrador</h2>
            <p className="text-[11px] text-gray-500">
              {lista ? `${lista.paginas} ${lista.paginas === 1 ? "página" : "páginas"} · ${(lista.bytes / 1048576).toFixed(1)} MB · generada a las ${lista.generadoEn}. No se actualiza sola.` : "Lleva la marca BORRADOR; el PDF final se arma al emitir."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Boton tam="sm" onClick={regenerar} disabled={estado.fase === "armando"}>↻ Volver a generar</Boton>
            {lista ? (
              <>
                <a href={lista.url} target="_blank" rel="noopener" className="inline-flex min-h-8 items-center rounded-lg border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50">Abrir en otra pestaña</a>
                <a href={lista.url} download={lista.nombre} className="inline-flex min-h-8 items-center rounded-lg border border-[#0b315f] bg-[#0b315f] px-2.5 py-1 text-xs font-medium text-white hover:bg-[#0a2a52]">⬇ Descargar borrador</a>
              </>
            ) : null}
            <Boton tam="sm" tono="suave" onClick={cerrar}>✕ Cerrar</Boton>
          </div>
        </div>
        {avisos.length ? (
          <div className="border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 sm:px-4">
            <button type="button" onClick={() => setDetalles((x) => !x)} className="font-semibold underline" aria-expanded={detalles}>
              {avisos.length} {avisos.length === 1 ? "cosa no salió como está escrita" : "cosas no salieron como están escritas"} {detalles ? "▴" : "▾"}
            </button>
            {detalles ? <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5">{avisos.map((a, i) => <li key={i}>{a}</li>)}</ul> : null}
          </div>
        ) : null}
        <div className="relative min-h-0 flex-1 bg-gray-100">
          {estado.fase === "armando" ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-gray-600">{estado.paso}</div>
          ) : estado.fase === "error" ? (
            <div className="flex h-full items-center justify-center p-6"><p className="max-w-lg text-center text-sm text-red-700">{estado.detalle}</p></div>
          ) : lista ? (
            <>
              <iframe src={lista.url} title="Vista previa del PDF" className="h-full w-full" />
              <p className="absolute bottom-0 left-0 right-0 bg-white/90 px-3 py-1 text-center text-[11px] text-gray-500 sm:hidden">En el celular, si no se ve, usa «Abrir en otra pestaña» o «Descargar borrador».</p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
