// components/licitaciones/editor/revision/emision-segura.ts — Una fila de `licitacion_emisiones` puede
// llegar MAL FORMADA: la política deja INSERTAR a mano a cualquier usuario del módulo (auditoría de
// seguridad, gravedad baja). La capa de datos también la normaliza, pero la pantalla no puede romperse ni
// pintar lo que no es: aquí se reconstruye cada emisión con tipos fijos (PURO, sin red).
//
//  · `archivos`, `hallazgos`, `omitidos` y `foto.fuentes` son arreglos SOLO si Array.isArray; si no, vacíos.
//    Cada elemento que no es un objeto se descarta; cada texto se vuelve texto (un objeto dentro de JSX
//    tumbaría la pantalla), cada número se valida.
//  · Un enlace de un archivo emitido solo se ofrece para abrir si es del bucket privado `licitaciones` de
//    ESTE proyecto (`enlaceEmitidoValido`): un enlace a otro sitio escrito a mano no se pinta como enlace.
import { origenArchivo } from "@/lib/licitaciones/archivos";
import { baseSupabase, objetoPrivadoDe } from "@/lib/storage-privado";
import { BUCKET_LICITACIONES } from "@/lib/licitaciones/tipos";
import type {
  ArchivoEmitido, CodigoHallazgo, FilaEmision, FotoEmision, Gravedad, HallazgoEmitido, OmitidoEmision, TipoArchivoEmitido,
} from "@/lib/licitaciones/tipos";

type Obj = Record<string, unknown>;
const esObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
/** Los elementos objeto de un arreglo; cualquier otra cosa → vacío. */
export const objetos = (x: unknown): Obj[] => (Array.isArray(x) ? x.filter(esObj) : []);

const txt = (v: unknown, max = 2000): string => {
  const s = typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : typeof v === "boolean" ? String(v) : "";
  return s.length > max ? s.slice(0, max) : s;
};
const txtONull = (v: unknown, max = 2000): string | null => { const s = txt(v, max); return s ? s : null; };
const entero = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const noNegativo = (v: unknown): number => { const n = typeof v === "number" && Number.isFinite(v) ? v : 0; return n > 0 ? n : 0; };

const TIPOS_ARCHIVO: readonly TipoArchivoEmitido[] = ["propuesta", "bloque", "expediente_completo", "zip"];
const GRAVEDADES: readonly Gravedad[] = ["alarma", "aviso", "info"];

function folios(v: unknown): ArchivoEmitido["folios"] {
  if (!esObj(v)) return null;
  const desde = entero(v.desde), hasta = entero(v.hasta);
  return desde != null && hasta != null && desde > 0 && hasta > 0 ? { desde, hasta } : null;
}

export function archivoEmitidoSeguro(o: Obj): ArchivoEmitido {
  const tipo = TIPOS_ARCHIVO.includes(o.tipo as TipoArchivoEmitido) ? (o.tipo as TipoArchivoEmitido) : "bloque";
  const pag = entero(o.paginas);
  return {
    nombre: txt(o.nombre, 300) || "(sin nombre)", tipo, bloqueId: txtONull(o.bloqueId, 100), bytes: noNegativo(o.bytes),
    paginas: pag != null && pag >= 0 ? pag : null, sha256: /^[0-9a-f]{64}$/.test(txt(o.sha256, 64)) ? txt(o.sha256, 64) : "",
    url: txtONull(o.url, 2000), motivoNoSubido: txtONull(o.motivoNoSubido, 500), folios: folios(o.folios),
  };
}

export function hallazgoEmitidoSeguro(o: Obj): HallazgoEmitido {
  return {
    clave: txt(o.clave, 400), codigo: txt(o.codigo, 80) as CodigoHallazgo,
    gravedad: GRAVEDADES.includes(o.gravedad as Gravedad) ? (o.gravedad as Gravedad) : "info",
    texto: txt(o.texto, 2000), aceptado: o.aceptado === true, nota: txtONull(o.nota, 1000),
  };
}

export function omitidoSeguro(o: Obj): OmitidoEmision {
  return {
    itemId: txt(o.itemId, 100), bloqueId: txt(o.bloqueId, 100), titulo: txt(o.titulo, 300) || "(sin título)",
    url: txtONull(o.url, 2000), codigo: txt(o.codigo, 80) as CodigoHallazgo, detalle: txt(o.detalle, 1000),
  };
}

/** Los tres arreglos de una emisión (resumen o completa), reconstruidos. El resto de la fila no se toca. */
export function emisionSegura<T extends Pick<FilaEmision, "archivos" | "hallazgos" | "omitidos">>(e: T): T {
  return {
    ...e,
    archivos: objetos(e.archivos).map(archivoEmitidoSeguro),
    hallazgos: objetos(e.hallazgos).map(hallazgoEmitidoSeguro),
    omitidos: objetos(e.omitidos).map(omitidoSeguro),
  };
}

/** La última emisión COMPLETA lista para la revisión: además de los arreglos, `foto.fuentes` (que
 *  revisarLicitacion recorre con .find) solo con elementos bien formados. */
export function ultimaSegura(e: FilaEmision | null): FilaEmision | null {
  if (!e) return null;
  const base = emisionSegura(e);
  const foto = esObj(e.foto) ? (e.foto as FotoEmision) : ({} as FotoEmision);
  const fuentes: FotoEmision["fuentes"] = objetos((foto as { fuentes?: unknown }).fuentes).map((f) => ({
    itemId: txt(f.itemId, 100), url: txt(f.url, 2000),
    sha256: /^[0-9a-f]{64}$/.test(txt(f.sha256, 64)) ? txt(f.sha256, 64) : null,
    bytes: noNegativo(f.bytes), paginas: entero(f.paginas),
  }));
  const version = entero(e.version);
  return { ...base, version: version ?? 0, foto: { ...foto, fuentes } };
}

/** ¿Este enlace es una copia emitida de verdad? Solo del bucket privado `licitaciones` de ESTE proyecto. */
export function enlaceEmitidoValido(url: string | null | undefined): boolean {
  if (!url) return false;
  const base = baseSupabase();
  if (!base) return false; // sin la URL del proyecto no se puede afirmar que sea de ESTE proyecto
  return origenArchivo(url, base) === "storage_privado" && objetoPrivadoDe(url, base)?.bucket === BUCKET_LICITACIONES;
}

/** Una versión que se puede enseñar (la que devolvió la fila), o null si no es un entero ≥ 1. */
export function versionMostrable(v: unknown): number | null {
  const n = entero(v);
  return n != null && n >= 1 ? n : null;
}
