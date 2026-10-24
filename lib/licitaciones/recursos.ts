// lib/licitaciones/recursos.ts — Qué documentos tiene cada unidad y cada conductor elegido, a la fecha de
// presentación y a la de inicio del servicio. Módulo PURO.
//
// No se escribió un segundo motor documental: el documento de la unidad se reconoce con `tipoCanonico`
// (la misma identidad con que se ESCRIBEN las filas, vía CANONICOS_DOC_UNIDAD), se elige con
// `mejorPorVencimiento` (extraído de evaluarAptitud, misma regla: el de vencimiento más lejano) y la
// Tarjeta de Propiedad no vence por `docSinVencimiento`. Si /seguimiento dice que el SOAT de una placa
// está vigente, la licitación no puede decir lo contrario.
//
// El ARCHIVO se juzga aparte del vencimiento: un SOAT vigente cuyo enlace es de Drive está vigente, pero
// no se puede UNIR al expediente (origenArchivo → `externo`). Son dos hallazgos distintos.

import { docSinVencimiento, mejorPorVencimiento, tipoCanonico } from "../documentos-estado";
import { normalizarCategoria } from "../licencias-conducir";
import { estaActivo } from "../seguros";
import { baseSupabase } from "../storage-privado";
import { origenArchivo } from "./archivos";
import { archivosConductor, DIAS_POR_VENCER_LEGAJO, documentoVigente, tipoDocConductor } from "./legajo";
import {
  CANONICOS_DOC_UNIDAD, CODIGOS_DOC_CONDUCTOR, DOCS_UNIDAD_LIC,
  type CategoriaLicencia, type ClaveRecurso, type CodigoDocConductor, type ConductorERP, type DocUnidadERP,
  type DocUnidadLic, type FechaISO, type FilaDocEmpresa, type Flota, type OrigenArchivo, type UnidadERP,
} from "./tipos";
import { anioDe, diasISO, fechaONull } from "./util";

export const ETIQUETA_DOC_UNIDAD: Record<DocUnidadLic, string> = {
  soat: "SOAT", citv: "Revisión técnica (CITV)", tarjeta_propiedad: "Tarjeta de propiedad",
  tuc: "Tarjeta Única de Circulación (TUC)", habilitacion: "Habilitación vehicular",
};

export type EstadoVigencia = "vigente" | "por_vencer" | "vencido" | "sin_fecha" | "no_vence";
export type EstadoDocUnidad = "falta" | EstadoVigencia;

export type DocUnidadResumen = {
  doc: DocUnidadLic; etiqueta: string; estado: EstadoDocUnidad;
  fila: DocUnidadERP | null; vence: FechaISO | null;
  /** Días de la fecha de referencia al vencimiento (negativo = vencido). */
  dias: number | null;
  origen: OrigenArchivo; deEmpresa: boolean;
};

/** Vigencia de una fecha de vencimiento a `ref` (sin vencimiento → «sin_fecha»). */
export function vigencia(venc: FechaISO | null, ref: FechaISO): { estado: EstadoVigencia; dias: number | null } {
  if (!venc) return { estado: "sin_fecha", dias: null };
  const dias = diasISO(ref, venc);
  if (dias < 0) return { estado: "vencido", dias };
  if (dias <= DIAS_POR_VENCER_LEGAJO) return { estado: "por_vencer", dias };
  return { estado: "vigente", dias };
}

const conArchivo = (d: { archivo_url: string | null }) => typeof d.archivo_url === "string" && d.archivo_url.trim() !== "";
const canonicoDe = (d: DocUnidadERP): string | null => d.canonico ?? tipoCanonico(d.tipo)?.canonico ?? null;

/**
 * El documento `doc` de la unidad a la fecha `ref`. Terceros: también los de la EMPRESA (deEmpresa),
 * la regla de app/tercerizadas; propios: solo los de la placa. Entre varias filas, la de vencimiento más
 * lejano; a igualdad, la que tiene archivo. `base` = URL del proyecto (por defecto la del entorno).
 */
export function docsDeUnidad(u: UnidadERP, doc: DocUnidadLic, ref: FechaISO, base: string | null = baseSupabase()): DocUnidadResumen {
  const canon = CANONICOS_DOC_UNIDAD[doc];
  const cands = (u.docs || []).filter((d) => !!d && (u.flota === "t" || !d.deEmpresa) && canon.includes(canonicoDe(d) ?? ""));
  const etiqueta = ETIQUETA_DOC_UNIDAD[doc];
  if (!cands.length) return { doc, etiqueta, estado: "falta", fila: null, vence: null, dias: null, origen: "vacio", deEmpresa: false };
  const orden = [...cands.filter(conArchivo), ...cands.filter((d) => !conArchivo(d))];
  const fila = mejorPorVencimiento(orden, ref);
  const origen = origenArchivo(fila.archivo_url, base);
  if (docSinVencimiento(canonicoDe(fila))) {
    return { doc, etiqueta, estado: "no_vence", fila, vence: null, dias: null, origen, deEmpresa: fila.deEmpresa };
  }
  const vence = fechaONull(fila.fecha_vencimiento);
  const v = vigencia(vence, ref);
  return { doc, etiqueta, estado: v.estado, fila, vence, dias: v.dias, origen, deEmpresa: fila.deEmpresa };
}

export type RefsRecurso = { presentacion: FechaISO; inicio: FechaISO | null };

export type ResumenUnidad = {
  clave: ClaveRecurso; flota: Flota; placa: string; tercerizada: boolean; activa: boolean;
  anio: number | null;
  /** Años de antigüedad al año de la presentación (año − año de fabricación); null sin año. */
  antiguedad: number | null;
  capacidad: number | null;
  marcaModelo: string | null;
  /** "Bus 50 asientos": categoría y capacidad de la ficha, o null sin ninguna. */
  tipo: string | null;
  docs: Record<DocUnidadLic, { presentacion: DocUnidadResumen; inicio: DocUnidadResumen | null }>;
  fotos: { externa: OrigenArchivo; interna: OrigenArchivo; completas: boolean };
  empresa: { razonSocial: string; autorizacion: "vigente" | "vencida" | "sin_dato" } | null;
};

const texto = (x: string | null | undefined) => (typeof x === "string" && x.trim() ? x.trim() : null);

export function resumenUnidad(u: UnidadERP, refs: RefsRecurso, base: string | null = baseSupabase()): ResumenUnidad {
  const docs = {} as ResumenUnidad["docs"];
  for (const d of DOCS_UNIDAD_LIC) {
    docs[d] = {
      presentacion: docsDeUnidad(u, d, refs.presentacion, base),
      inicio: refs.inicio ? docsDeUnidad(u, d, refs.inicio, base) : null,
    };
  }
  const externa = origenArchivo(u.foto_externa_url, base);
  const interna = origenArchivo(u.foto_interna_url, base);
  const marcaModelo = [texto(u.marca), texto(u.modelo)].filter(Boolean).join(" ") || null;
  const tipo = [texto(u.categoria), u.capacidad ? `${u.capacidad} asientos` : null].filter(Boolean).join(" ") || null;
  let empresa: ResumenUnidad["empresa"] = null;
  if (u.flota === "t" && u.empresa) {
    const venc = fechaONull(u.empresa.venc_autorizacion);
    const tiene = !!texto(u.empresa.autorizacion_mtc);
    empresa = {
      razonSocial: u.empresa.razon_social,
      autorizacion: !tiene ? "sin_dato" : venc && diasISO(refs.presentacion, venc) < 0 ? "vencida" : "vigente",
    };
  }
  return {
    clave: u.clave, flota: u.flota, placa: u.placa, tercerizada: u.flota === "t", activa: estaActivo(u.estado),
    anio: u.anio, antiguedad: u.anio ? anioDe(refs.presentacion) - u.anio : null,
    capacidad: u.capacidad, marcaModelo, tipo, docs,
    fotos: { externa, interna, completas: externa !== "vacio" && interna !== "vacio" },
    empresa,
  };
}

/** Tri-estado de la columna de vencimiento de la ficha: no existe (terceros) ≠ vacía ≠ con fecha. */
export type ColumnaFicha = "no_aplica" | "no_existe" | "vacia" | "con_fecha";

export type DocConductorResumen = {
  codigo: CodigoDocConductor; etiqueta: string;
  columna: ColumnaFicha;
  /** Vencimiento que vale: el de la ficha (propios) o, si la columna no existe o está vacía, el de la fila del archivo. */
  venc: FechaISO | null; fuenteVenc: "ficha" | "archivo" | null;
  presentacion: { estado: EstadoVigencia; dias: number | null };
  inicio: { estado: EstadoVigencia; dias: number | null } | null;
  fila: FilaDocEmpresa | null; origen: OrigenArchivo;
  /** Días desde la emisión del archivo a la presentación (para la antigüedad máxima). */
  edad: number | null;
  /** La ficha y la fila del archivo traen vencimientos distintos. */
  fechasDistintas: boolean;
};

export type ResumenConductor = {
  clave: ClaveRecurso; flota: Flota; nombre: string; tercerizado: boolean; activo: boolean;
  licencia: string | null; categoria: CategoriaLicencia | null; categoriaTexto: string | null;
  docs: Record<CodigoDocConductor, DocConductorResumen>;
};

export function docDeConductor(c: ConductorERP, codigo: CodigoDocConductor, refs: RefsRecurso, base: string | null = baseSupabase()): DocConductorResumen {
  const t = tipoDocConductor(codigo);
  const fila = documentoVigente(codigo, archivosConductor(c, codigo), null);
  const vencFila = fila ? fechaONull(fila.fecha_vencimiento) : null;
  let columna: ColumnaFicha = "no_aplica";
  let vencFicha: FechaISO | null = null;
  if (t.columna) {
    const v = (c as Record<string, unknown>)[t.columna];
    if (v === undefined) columna = "no_existe";
    else { vencFicha = fechaONull(v); columna = vencFicha ? "con_fecha" : "vacia"; }
  }
  const venc = vencFicha ?? vencFila;
  const fuenteVenc = vencFicha ? "ficha" : vencFila ? "archivo" : null;
  const sinConcepto = t.columna === null && !vencFila;          // récord, capacitación: no vencen
  const juzgar = (ref: FechaISO) => (sinConcepto ? { estado: "no_vence" as const, dias: null } : vigencia(venc, ref));
  const emis = fila ? fechaONull(fila.fecha_emision) : null;
  return {
    codigo, etiqueta: t.etiqueta, columna, venc, fuenteVenc,
    presentacion: juzgar(refs.presentacion),
    inicio: refs.inicio ? juzgar(refs.inicio) : null,
    fila, origen: origenArchivo(fila?.archivo_url, base),
    edad: emis ? diasISO(emis, refs.presentacion) : null,
    fechasDistintas: !!vencFicha && !!vencFila && vencFicha !== vencFila,
  };
}

export function resumenConductor(c: ConductorERP, refs: RefsRecurso, base: string | null = baseSupabase()): ResumenConductor {
  const docs = {} as ResumenConductor["docs"];
  for (const d of CODIGOS_DOC_CONDUCTOR) docs[d] = docDeConductor(c, d, refs, base);
  return {
    clave: c.clave, flota: c.flota, nombre: c.nombre, tercerizado: c.flota === "t", activo: estaActivo(c.estado),
    licencia: texto(c.licencia), categoria: normalizarCategoria(c.categoria_licencia), categoriaTexto: texto(c.categoria_licencia),
    docs,
  };
}
