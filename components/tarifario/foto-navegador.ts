// components/tarifario/foto-navegador.ts — SOLO NAVEGADOR. Las fotos de la categoría de traslado
// (exterior e interior) que van en el PDF de la cotización: se achican AQUÍ y se suben por
// POST /api/traslados/categorias/foto, que es la única puerta de escritura del bucket
// `traslados-fotos` (sin ninguna política para las sesiones: supabase/traslados-07).
//
// NADA SE DECODIFICA EN EL SERVIDOR: el navegador convierte la foto (JPG, PNG, WebP…) a un JPEG de
// hasta `LADO_OBJETIVO` px por lado en un canvas, con fondo blanco (un PNG transparente saldría
// negro), y la comprueba con `revisarJpeg` —el MISMO control que aplica el servidor— antes de
// mandarla: un rechazo se dice aquí, con su motivo, sin gastar la subida.
//
// UNA FOTO DE LA FLOTA NO SE ENLAZA, SE COPIA: se baja del almacenamiento público del propio
// Supabase con `fetch` (CORS, sin caché: así el canvas nunca queda «contaminado» por una copia
// guardada sin CORS), se achica igual y se sube como foto NUEVA. La URL de `vehiculos-fotos`
// nunca se guarda en la categoría: ese bucket lo puede sobrescribir cualquier sesión del ERP, y lo
// que la IA manda a clientes sin revisión no puede salir de ahí.

import { cabecerasErp } from "@/lib/fetch-erp";
import { FOTO_MAX_BYTES, formatoPorFirma, revisarJpeg, type LadoFoto } from "@/lib/traslados/fotos-categoria";
import { esHeic, mensajeRespuestaFoto, MOTIVO_HEIC, type RespuestaFoto } from "./traslados-pantalla";

/** El lado mayor del JPEG que se sube (el servidor admite hasta 1600: el margen es del redondeo). */
export const LADO_OBJETIVO = 1280;
/** Si a 1280 px no cabe en 600 KB ni con la calidad más baja, se prueba más chico. */
const LADOS = [LADO_OBJETIVO, 1024, 800] as const;
const CALIDADES = [0.82, 0.74, 0.66, 0.58, 0.5, 0.42] as const;
/** Lo que se acepta como ORIGEN antes de achicar (no medido: una foto de celular pesa 2-12 MB). */
export const MAX_ARCHIVO_ORIGEN = 30 * 1024 * 1024;
/** Más píxeles que esto el navegador del celular puede no decodificarlos (no medido). */
const MAX_PIXELES_ORIGEN = 80_000_000;
/** Por debajo de este lado mayor, la foto se ve borrosa en el PDF: se avisa, no se bloquea (no medido). */
export const LADO_MINIMO_NITIDO = 700;

export type FotoLista =
  | { ok: true; blob: Blob; ancho: number; alto: number; pequena: boolean }
  | { ok: false; detalle: string };

const mal = (detalle: string): FotoLista => ({ ok: false, detalle });

/** Decodifica en un <img> (aplica la orientación EXIF, como la ve la persona). */
async function decodificar(blob: Blob): Promise<{ img: HTMLImageElement; liberar: () => void } | null> {
  const url = URL.createObjectURL(blob);
  const liberar = () => { try { URL.revokeObjectURL(url); } catch { /* ya liberada */ } };
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) { liberar(); return null; }
    return { img, liberar };
  } catch {
    liberar();
    return null;
  }
}

function lienzo(ancho: number, alto: number): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const c = document.createElement("canvas");
  c.width = ancho;
  c.height = alto;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  return { c, ctx };
}

/**
 * La imagen al tamaño pedido, achicando por mitades (un solo salto de 4000 a 1280 px pierde
 * detalle en algunos navegadores) y sobre fondo blanco.
 */
function redimensionar(img: HTMLImageElement, ancho: number, alto: number): HTMLCanvasElement | null {
  let fuente: CanvasImageSource = img;
  let w = img.naturalWidth;
  let h = img.naturalHeight;
  while (w / 2 >= ancho * 1.5 && h / 2 >= alto * 1.5) {
    const paso = lienzo(Math.round(w / 2), Math.round(h / 2));
    if (!paso) return null;
    paso.ctx.drawImage(fuente, 0, 0, paso.c.width, paso.c.height);
    fuente = paso.c;
    w = paso.c.width;
    h = paso.c.height;
  }
  const fin = lienzo(ancho, alto);
  if (!fin) return null;
  fin.ctx.fillStyle = "#ffffff";
  fin.ctx.fillRect(0, 0, ancho, alto);
  fin.ctx.drawImage(fuente, 0, 0, ancho, alto);
  return fin.c;
}

const aJpeg = (c: HTMLCanvasElement, calidad: number) =>
  new Promise<Blob | null>((r) => { try { c.toBlob((b) => r(b), "image/jpeg", calidad); } catch { r(null); } });

/**
 * La foto lista para subir: un JPEG de hasta 1280 px por lado y ≤ 600 KB que pasa `revisarJpeg`.
 * Rechaza (con su motivo) un HEIC, un PDF, un archivo vacío o enorme, o algo que no es imagen.
 */
export async function prepararFoto(origen: Blob, nombre?: string | null): Promise<FotoLista> {
  if (!origen || origen.size === 0) return mal("El archivo está vacío.");
  if (origen.size > MAX_ARCHIVO_ORIGEN) return mal(`El archivo pesa ${Math.round(origen.size / 1024 / 1024)} MB: elige una foto de menos de ${MAX_ARCHIVO_ORIGEN / 1024 / 1024} MB.`);
  let cabecera: Uint8Array | null = null;
  try { cabecera = new Uint8Array(await origen.slice(0, 32).arrayBuffer()); } catch { cabecera = null; }
  if (esHeic(origen.type, nombre, cabecera)) return mal(MOTIVO_HEIC);
  if (cabecera && formatoPorFirma(cabecera) === "pdf") return mal("Es un PDF, no una foto: sube la foto (JPG o PNG) o una captura de pantalla de ella.");
  const dec = await decodificar(origen);
  if (!dec) return mal("El navegador no pudo leer la imagen (¿está dañada o en un formato raro?). Elige un JPG o PNG.");
  try {
    const w0 = dec.img.naturalWidth;
    const h0 = dec.img.naturalHeight;
    if (w0 * h0 > MAX_PIXELES_ORIGEN) return mal(`La foto mide ${w0} × ${h0} px: es demasiado grande para convertirla en el navegador. Expórtala más chica.`);
    for (const lado of LADOS) {
      const f = Math.min(1, lado / Math.max(w0, h0));
      const ancho = Math.max(1, Math.round(w0 * f));
      const alto = Math.max(1, Math.round(h0 * f));
      const c = redimensionar(dec.img, ancho, alto);
      if (!c) return mal("El navegador no pudo preparar la foto (sin lienzo de dibujo). Prueba con otro navegador.");
      for (const q of CALIDADES) {
        const b = await aJpeg(c, q);
        if (!b) return mal("El navegador no pudo convertir la foto a JPEG. Prueba con otro navegador.");
        if (b.type && b.type !== "image/jpeg") return mal("Este navegador no sabe guardar JPEG desde la pantalla. Prueba con Chrome, Edge o Safari.");
        if (b.size > FOTO_MAX_BYTES) continue;
        const rev = revisarJpeg(new Uint8Array(await b.arrayBuffer()));
        if (!rev.ok) return mal(`La foto convertida no es un JPEG que el PDF pueda usar: ${rev.detalle}`);
        return { ok: true, blob: b, ancho: rev.ancho, alto: rev.alto, pequena: Math.max(w0, h0) < LADO_MINIMO_NITIDO };
      }
    }
    return mal(`Ni achicada a ${LADOS[LADOS.length - 1]} px la foto baja de ${Math.floor(FOTO_MAX_BYTES / 1024)} KB: elige otra (o una captura de pantalla).`);
  } finally {
    dec.liberar();
  }
}

/** Una foto de la flota (almacenamiento público del propio Supabase) como archivo, para achicarla y subirla. */
export async function bajarFotoDeFlota(url: string): Promise<{ ok: true; blob: Blob } | { ok: false; detalle: string }> {
  try {
    const res = await fetch(url, { mode: "cors", cache: "no-store", credentials: "omit" });
    if (!res.ok) return { ok: false, detalle: `No se pudo bajar la foto de la unidad (el almacenamiento respondió ${res.status}). Descárgala y súbela con «Subir foto».` };
    const largo = Number(res.headers.get("content-length"));
    if (Number.isFinite(largo) && largo > MAX_ARCHIVO_ORIGEN) return { ok: false, detalle: "La foto de la unidad pesa demasiado para convertirla aquí: descárgala, achícala y súbela." };
    const blob = await res.blob();
    return { ok: true, blob };
  } catch (e) {
    return { ok: false, detalle: `No se pudo bajar la foto de la unidad (${(e as Error)?.message ?? "sin conexión"}). Descárgala y súbela con «Subir foto».` };
  }
}

export type ResultadoFoto =
  | { ok: true; url: string | null }
  | { ok: false; codigo: string; detalle: string; sinMigracion: boolean };

/** Las cabeceras del ERP SIN Content-Type: el multipart lo pone el navegador (con su separador). */
async function cabecerasSinTipo(): Promise<Record<string, string>> {
  const h = await cabecerasErp();
  delete h["Content-Type"];
  return h;
}

async function leerRespuesta(res: Response): Promise<RespuestaFoto> {
  return (await res.json().catch(() => null)) as RespuestaFoto;
}

/** Sube la foto (ya preparada) de un lado de la categoría. */
export async function subirFotoCategoria(clave: string, lado: LadoFoto, foto: Blob): Promise<ResultadoFoto> {
  try {
    const form = new FormData();
    form.append("clave", clave);
    form.append("lado", lado);
    form.append("archivo", foto, `${lado}.jpg`);
    const res = await fetch("/api/traslados/categorias/foto", { method: "POST", headers: await cabecerasSinTipo(), body: form });
    const d = await leerRespuesta(res);
    if (res.ok && d?.ok && typeof d.url === "string" && d.url) return { ok: true, url: d.url };
    if (res.ok && !d) return { ok: false, codigo: "error", detalle: "No se guardó la foto: el servidor respondió sin un resultado legible.", sinMigracion: false };
    return { ok: false, ...mensajeRespuestaFoto(res.status, d, "subir") };
  } catch (e) {
    return { ok: false, codigo: "red", detalle: `No se guardó la foto: sin conexión con el servidor (${(e as Error)?.message ?? "error de red"}).`, sinMigracion: false };
  }
}

/** Quita la foto de un lado de la categoría (la columna vuelve a null y se borra el archivo). */
export async function quitarFotoCategoria(clave: string, lado: LadoFoto): Promise<ResultadoFoto> {
  try {
    const q = new URLSearchParams({ clave, lado });
    const res = await fetch(`/api/traslados/categorias/foto?${q}`, { method: "DELETE", headers: await cabecerasSinTipo() });
    const d = await leerRespuesta(res);
    if (res.ok && d?.ok) return { ok: true, url: null };
    if (res.ok && !d) return { ok: false, codigo: "error", detalle: "No se quitó la foto: el servidor respondió sin un resultado legible.", sinMigracion: false };
    return { ok: false, ...mensajeRespuestaFoto(res.status, d, "quitar") };
  } catch (e) {
    return { ok: false, codigo: "red", detalle: `No se quitó la foto: sin conexión con el servidor (${(e as Error)?.message ?? "error de red"}).`, sinMigracion: false };
  }
}
