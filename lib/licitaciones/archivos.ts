// lib/licitaciones/archivos.ts — Rutas y orígenes de los archivos del módulo Licitaciones. Módulo PURO.
//
// Escribir y leer con la MISMA identidad: la pantalla sube a `rutaNueva(...)`, guarda el enlace público
// como identificador (ArchivoRef.url) y quien lo usa recupera la ruta con objetoPrivadoDe(url). El
// servidor del análisis IA solo acepta rutas que casen con RE_RUTA_BASE(id) — la misma forma con que se
// escribieron — y nunca baja una URL que venga en el cuerpo de la petición.

import { BUCKETS_PRIVADOS } from "@/lib/storage-privado";
import { BUCKET_LICITACIONES, CARPETAS_LICITACION, type CarpetaLicitacion, type MimeArchivo, type OrigenArchivo } from "./tipos";

export const MIMES_PERMITIDOS: readonly MimeArchivo[] = [
  "application/pdf", "image/png", "image/jpeg", "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
];

const EXT_POR_MIME: Record<MimeArchivo, string> = {
  "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "application/zip": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
};
export const EXTENSIONES_PERMITIDAS = Object.values(EXT_POR_MIME);

export const esMimePermitido = (m: unknown): m is MimeArchivo =>
  typeof m === "string" && (MIMES_PERMITIDOS as readonly string[]).includes(m);

export function extDeMime(m: MimeArchivo): string { return EXT_POR_MIME[m]; }

/** El mime que corresponde a un nombre de archivo, o null si no es de los permitidos. */
export function mimeDeNombre(nombre: string): MimeArchivo | null {
  const ext = (nombre.split(".").pop() ?? "").toLowerCase();
  const e = ext === "jpeg" ? "jpg" : ext;
  const par = (Object.entries(EXT_POR_MIME) as [MimeArchivo, string][]).find(([, x]) => x === e);
  return par ? par[0] : null;
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const esUuid = (x: unknown): x is string => typeof x === "string" && RE_UUID.test(x);

/**
 * La ruta dentro del bucket `licitaciones` para un archivo nuevo. `carpeta/<licId>/<uuid>.<ext>`; la
 * carpeta `experiencia` es del catálogo de experiencia (no de una licitación) y va sin licId.
 * Lanza ante una carpeta, id, uuid o extensión fuera de lo permitido: una ruta inventada no se sube.
 */
export function rutaNueva(carpeta: CarpetaLicitacion, licId: number | null, uuid: string, ext: string): string {
  if (!(CARPETAS_LICITACION as readonly string[]).includes(carpeta)) throw new Error(`Carpeta no permitida: ${carpeta}`);
  if (!esUuid(uuid)) throw new Error("Identificador de archivo inválido");
  const e = ext.toLowerCase().replace(/^\./, "");
  if (!EXTENSIONES_PERMITIDAS.includes(e)) throw new Error(`Extensión no permitida: ${ext}`);
  if (carpeta === "experiencia") return `experiencia/${uuid}.${e}`;
  if (!Number.isSafeInteger(licId) || (licId as number) <= 0) throw new Error("Licitación inválida");
  return `${carpeta}/${licId}/${uuid}.${e}`;
}

/** La forma EXACTA de una base subida a esa licitación. El análisis IA no baja nada que no case. */
export function RE_RUTA_BASE(licId: number): RegExp {
  if (!Number.isSafeInteger(licId) || licId <= 0) return /^(?!)$/; // no casa con nada
  return new RegExp(`^bases/${licId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$`);
}

/**
 * Nombre de archivo emitido: ASCII, sin tildes, sin separadores de ruta ni `..`, ≤ 100 caracteres.
 * Se usa dentro del ZIP y en la ruta de Storage, así que tiene que ser el mismo en los dos.
 */
export function nombreArchivoEmitido(base: string, ext: string): string {
  const limpio = (base || "documento")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._ -]/g, " ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/ /g, "_")
    .replace(/^[._-]+/, "")
    .slice(0, 100)
    .replace(/[._-]+$/, "");
  const e = ext.toLowerCase().replace(/[^a-z0-9]/g, "") || "pdf";
  return `${limpio || "documento"}.${e}`;
}

/** Ruta de un archivo emitido: emisiones/<licId>/<carpeta uuid>/<nombre>. Lanza si algo no es válido. */
export function rutaEmision(licId: number, carpeta: string, nombre: string): string {
  if (!Number.isSafeInteger(licId) || licId <= 0) throw new Error("Licitación inválida");
  if (!esUuid(carpeta)) throw new Error("Carpeta de emisión inválida");
  if (!nombre || /[\\/]/.test(nombre) || nombre.includes("..") || nombre.startsWith(".")) throw new Error("Nombre de archivo inválido");
  return `emisiones/${licId}/${carpeta}/${nombre}`;
}

/**
 * ¿De dónde es este enlace? Solo `storage_privado` y `storage_publico` de ESTE proyecto se pueden bajar
 * desde el navegador y unir al expediente. Un enlace de Drive, de otro proyecto o cualquier otra web es
 * `externo`: no se baja (CORS) y la revisión lo nombra para que alguien suba el PDF.
 */
export function origenArchivo(url: unknown, base: string | null | undefined): OrigenArchivo {
  if (typeof url !== "string" || !url.trim()) return "vacio";
  let u: URL;
  try { u = new URL(url.trim()); } catch { return "externo"; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "externo";
  if (base) {
    let b: URL;
    try { b = new URL(base); } catch { return "externo"; }
    if (u.origin !== b.origin) return "externo";
  }
  const m = u.pathname.match(/^\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/.+$/);
  if (!m) return "externo";
  return (BUCKETS_PRIVADOS as readonly string[]).includes(m[1]) ? "storage_privado" : "storage_publico";
}

export { BUCKET_LICITACIONES };
