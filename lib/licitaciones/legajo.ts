// lib/licitaciones/legajo.ts — El legajo de la empresa y los documentos del conductor. Módulo PURO.
//
// El legajo ES documentos_empresa (alcance 'empresa', categoria = CodigoLegajo); los documentos del
// conductor, la misma tabla con alcance 'conductor'. Aquí solo se decide QUÉ fila vale y en qué estado
// está a una fecha de referencia. El estado se DERIVA: la columna `estado` que /documentos guarda al
// insertar no se lee nunca (se queda vieja al día siguiente).
//
// «Antiguo» es la regla de las licitaciones: una copia literal o una vigencia de poder no vencen, pero
// las bases las piden emitidas hace como mucho N días. Los «sugeridos» son el valor que la pantalla
// propone al crear la regla — NO medidos ni sacados de una norma: los suele pedir así una base, y una
// persona los cambia por lo que diga la suya.

import { etiquetaCategoria } from "../documentos-empresa-categorias";
import type { CodigoDocConductor, CodigoLegajo, ConductorERP, FechaISO, FilaDocEmpresa } from "./tipos";
import { diasISO, fechaONull } from "./util";

/** Días de anticipación con que un vencimiento pasa a «por vencer» (el mismo 30 de /documentos). */
export const DIAS_POR_VENCER_LEGAJO = 30;

export type TipoLegajo = {
  codigo: CodigoLegajo; etiqueta: string; grupo: string;
  /** "fecha" = si la fila trae vencimiento, se juzga; "no_vence" = la fecha de vencimiento no significa nada. */
  vence: "fecha" | "no_vence";
  antiguedadSugeridaDias: number | null;
};

const G_EMPRESA = "Empresa y representación";
const G_AUTORIZ = "Autorizaciones";
const G_SST = "SST y políticas";
const G_INST = "Institucional";

const tipo = (codigo: CodigoLegajo, grupo: string, vence: TipoLegajo["vence"], antiguedadSugeridaDias: number | null = null): TipoLegajo =>
  ({ codigo, etiqueta: etiquetaCategoria(codigo), grupo, vence, antiguedadSugeridaDias });

/** Un renglón por CodigoLegajo, en el orden en que se piden. Las etiquetas son las de la lista única. */
export const TIPOS_LEGAJO: readonly TipoLegajo[] = [
  tipo("ficha_ruc", G_EMPRESA, "no_vence", 30),
  tipo("copia_literal", G_EMPRESA, "no_vence", 30),
  tipo("vigencia_poder", G_EMPRESA, "no_vence", 30),
  tipo("dni_representante", G_EMPRESA, "fecha"),
  tipo("autorizacion_transporte", G_AUTORIZ, "fecha"),
  tipo("constancia_rnp", G_AUTORIZ, "fecha"),
  tipo("certificado_inscripcion", G_AUTORIZ, "fecha"),
  tipo("plan_sst", G_SST, "fecha"),
  tipo("programa_sst", G_SST, "fecha"),
  tipo("plan_emergencias", G_SST, "fecha"),
  tipo("iperc", G_SST, "fecha"),
  tipo("rit", G_SST, "fecha"),
  tipo("politica_alcohol_drogas", G_SST, "fecha"),
  tipo("brochure", G_INST, "no_vence"),
  tipo("organigrama", G_INST, "no_vence"),
  tipo("estados_financieros", G_INST, "no_vence"),
  tipo("certificacion", G_INST, "fecha"),
  tipo("otro_legajo", G_INST, "fecha"),
];

export const tipoLegajo = (c: CodigoLegajo): TipoLegajo => TIPOS_LEGAJO.find((t) => t.codigo === c) ?? tipo(c, G_INST, "fecha");

export type ColumnaVencConductor = "vencimiento_licencia" | "examen_medico_venc" | "antecedentes_venc" | "psicosometrico_venc";
export type TipoDocConductor = {
  codigo: CodigoDocConductor; etiqueta: string;
  /** Dónde vive el vencimiento del conductor PROPIO (la fila del documento solo guarda el archivo). */
  columna: ColumnaVencConductor | null;
  antiguedadSugeridaDias: number | null;
};

/** Un renglón por CodigoDocConductor. Penales y policiales comparten la columna de la ficha. */
export const TIPOS_DOC_CONDUCTOR: readonly TipoDocConductor[] = [
  { codigo: "licencia_conducir", etiqueta: etiquetaCategoria("licencia_conducir"), columna: "vencimiento_licencia", antiguedadSugeridaDias: null },
  { codigo: "record_conductor", etiqueta: etiquetaCategoria("record_conductor"), columna: null, antiguedadSugeridaDias: 30 },
  { codigo: "antecedentes_penales", etiqueta: etiquetaCategoria("antecedentes_penales"), columna: "antecedentes_venc", antiguedadSugeridaDias: null },
  { codigo: "antecedentes_policiales", etiqueta: etiquetaCategoria("antecedentes_policiales"), columna: "antecedentes_venc", antiguedadSugeridaDias: null },
  { codigo: "examen_medico", etiqueta: etiquetaCategoria("examen_medico"), columna: "examen_medico_venc", antiguedadSugeridaDias: null },
  { codigo: "psicosometrico", etiqueta: etiquetaCategoria("psicosometrico"), columna: "psicosometrico_venc", antiguedadSugeridaDias: null },
  { codigo: "capacitacion", etiqueta: etiquetaCategoria("capacitacion"), columna: null, antiguedadSugeridaDias: null },
];

export const tipoDocConductor = (c: CodigoDocConductor): TipoDocConductor =>
  TIPOS_DOC_CONDUCTOR.find((t) => t.codigo === c) ?? { codigo: c, etiqueta: etiquetaCategoria(c), columna: null, antiguedadSugeridaDias: null };

const conArchivo = (f: FilaDocEmpresa) => typeof f.archivo_url === "string" && f.archivo_url.trim() !== "";

/** Más reciente primero: por fecha de emisión (sin fecha al final), luego por created_at, luego id. */
function porReciente(a: FilaDocEmpresa, b: FilaDocEmpresa): number {
  const ea = fechaONull(a.fecha_emision) ?? "", eb = fechaONull(b.fecha_emision) ?? "";
  if (ea !== eb) return ea < eb ? 1 : -1;
  const ca = String(a.created_at ?? ""), cb = String(b.created_at ?? "");
  if (ca !== cb) return ca < cb ? 1 : -1;
  return (b.id ?? 0) - (a.id ?? 0);
}

/**
 * La fila que vale para `codigo`. Con `fijadoId` (alguien eligió una en el expediente) esa, si existe y
 * es de esa categoría; si no, la MÁS RECIENTE CON ARCHIVO, y si ninguna tiene archivo la más reciente
 * (así el estado dice «sin archivo» y no «falta»). null = no hay ninguna de esa categoría.
 */
export function documentoVigente(codigo: string, filas: readonly FilaDocEmpresa[], fijadoId: number | null | undefined): FilaDocEmpresa | null {
  const delCodigo = (filas || []).filter((f) => !!f && f.categoria === codigo);
  if (fijadoId != null) {
    const f = delCodigo.find((x) => x.id === fijadoId);
    if (f) return f;
  }
  const orden = [...delCodigo].sort(porReciente);
  return orden.find(conArchivo) ?? orden[0] ?? null;
}

/** ¿El documento fijado existe entre las filas de esa categoría? */
export const fijadoExiste = (codigo: string, filas: readonly FilaDocEmpresa[], fijadoId: number): boolean =>
  (filas || []).some((f) => !!f && f.categoria === codigo && f.id === fijadoId);

export type EstadoLegajo = "falta" | "sin_archivo" | "vigente" | "por_vencer" | "vencido" | "antiguo" | "sin_fecha_emision";
export type ResultadoLegajo = {
  estado: EstadoLegajo; fila: FilaDocEmpresa | null;
  /** Días hasta el vencimiento a la fecha de referencia (negativo = vencido); null sin vencimiento. */
  dias: number | null;
  /** Días desde la emisión hasta la fecha de referencia; null sin fecha de emisión. */
  edad: number | null;
};

/**
 * Estado de un documento del legajo a la fecha `ref`, de la evidencia al juicio — gana el primero:
 * falta → vencido (subirlo no lo arregla) → sin archivo → antiguo → sin fecha de emisión (cuando se
 * exige antigüedad: sin la fecha no se puede juzgar) → por vencer → vigente. Un vencimiento ausente en
 * un documento que vence NO se da por vencido: /documentos lo trata como vigente y aquí igual.
 */
export function estadoLegajo(codigo: CodigoLegajo, filas: readonly FilaDocEmpresa[], ref: FechaISO, antiguedadMax: number | null, fijadoId?: number | null): ResultadoLegajo {
  const fila = documentoVigente(codigo, filas, fijadoId);
  if (!fila) return { estado: "falta", fila: null, dias: null, edad: null };
  const t = tipoLegajo(codigo);
  const venc = t.vence === "fecha" ? fechaONull(fila.fecha_vencimiento) : null;
  const emis = fechaONull(fila.fecha_emision);
  const dias = venc ? diasISO(ref, venc) : null;
  const edad = emis ? diasISO(emis, ref) : null;
  const r = (estado: EstadoLegajo): ResultadoLegajo => ({ estado, fila, dias, edad });
  if (dias !== null && dias < 0) return r("vencido");
  if (!conArchivo(fila)) return r("sin_archivo");
  if (antiguedadMax != null) {
    if (edad === null) return r("sin_fecha_emision");
    if (edad > antiguedadMax) return r("antiguo");
  }
  if (dias !== null && dias <= DIAS_POR_VENCER_LEGAJO) return r("por_vencer");
  return r("vigente");
}

/** Los archivos del conductor de esa categoría (alcance 'conductor'). */
export function archivosConductor(c: ConductorERP, codigo: CodigoDocConductor): FilaDocEmpresa[] {
  return (c.archivos || []).filter((f) => !!f && f.categoria === codigo && (f.alcance ?? "conductor") === "conductor");
}
