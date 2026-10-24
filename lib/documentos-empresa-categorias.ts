// lib/documentos-empresa-categorias.ts — La lista ÚNICA de categorías de documentos_empresa. Módulo PURO.
//
// Había dos copias que ya decían cosas distintas: la lista fija de /documentos (app/documentos/page.tsx)
// y el enum de ELIA (lib/elia/herramientas.ts). El legajo de las licitaciones escribe en la MISMA tabla
// con categorías nuevas (ficha_ruc, copia_literal…), así que las tres pantallas importan esta lista: una
// categoría que /documentos no conoce sería una fila que nadie puede filtrar ni editar desde ahí.
//
// Las 9 generales van PRIMERO y en el mismo orden de siempre: son las que ya están escritas en la base.

import { CODIGOS_DOC_CONDUCTOR, CODIGOS_LEGAJO, type CodigoDocConductor, type CodigoLegajo } from "./licitaciones/tipos";
import { diasEntreFechas, fechaLima } from "./documentos-estado";

export const CATEGORIAS_GENERALES = [
  "contrato", "guia_remision", "sst", "capacitacion", "permiso", "legal", "factura", "interno", "otro",
] as const;
export type CategoriaGeneral = (typeof CATEGORIAS_GENERALES)[number];

/** Documentos del conductor que no son ya una categoría general («capacitacion» lo es). */
const CONDUCTOR_PROPIAS = CODIGOS_DOC_CONDUCTOR.filter((c) => !(CATEGORIAS_GENERALES as readonly string[]).includes(c));

export type CategoriaDocumento = CategoriaGeneral | CodigoLegajo | CodigoDocConductor;
export const CATEGORIAS_DOCUMENTO: readonly CategoriaDocumento[] = [
  ...CATEGORIAS_GENERALES, ...CODIGOS_LEGAJO, ...CONDUCTOR_PROPIAS,
];

export const GRUPOS_CATEGORIA: readonly { grupo: string; codigos: readonly CategoriaDocumento[] }[] = [
  { grupo: "Generales", codigos: CATEGORIAS_GENERALES },
  { grupo: "Legajo para licitaciones", codigos: CODIGOS_LEGAJO },
  { grupo: "Documentos del conductor", codigos: CONDUCTOR_PROPIAS },
];

const ETIQUETAS: Record<CategoriaDocumento, string> = {
  contrato: "Contrato", guia_remision: "Guía de remisión", sst: "SST", capacitacion: "Capacitación", permiso: "Permiso",
  legal: "Legal", factura: "Factura", interno: "Interno", otro: "Otro",
  ficha_ruc: "Ficha RUC", copia_literal: "Copia literal de partida registral", vigencia_poder: "Vigencia de poder del representante",
  dni_representante: "DNI del representante legal", autorizacion_transporte: "Autorización de transporte (MTC / ATU)",
  constancia_rnp: "Constancia RNP", certificado_inscripcion: "Certificado de inscripción o habilitación", brochure: "Brochure institucional",
  plan_sst: "Plan anual de SST", programa_sst: "Programa de SST", plan_emergencias: "Plan de respuesta ante emergencias",
  iperc: "Matriz IPERC", rit: "Reglamento interno de trabajo", politica_alcohol_drogas: "Política de alcohol y drogas",
  organigrama: "Organigrama", estados_financieros: "Estados financieros", certificacion: "Certificación (ISO u otra)",
  otro_legajo: "Otro documento para licitaciones",
  licencia_conducir: "Licencia de conducir", record_conductor: "Récord del conductor", antecedentes_penales: "Antecedentes penales",
  antecedentes_policiales: "Antecedentes policiales", examen_medico: "Examen médico ocupacional", psicosometrico: "Examen psicosomático",
};

/** Etiqueta para pantalla. Una categoría que no está en la lista (fila vieja) sale tal cual, legible. */
export function etiquetaCategoria(c: string | null | undefined): string {
  if (!c) return "Sin categoría";
  return (ETIQUETAS as Record<string, string>)[c] ?? c.replace(/_/g, " ");
}

export const esCategoriaConocida = (c: unknown): c is CategoriaDocumento =>
  typeof c === "string" && (CATEGORIAS_DOCUMENTO as readonly string[]).includes(c);

/**
 * El valor que /documentos guarda en la columna `estado` al insertar. SOLO para seguir llenándola: nadie
 * debe LEERLA para decidir nada (se queda vieja al día siguiente); el estado se deriva al pintar.
 * Días en calendario de Lima, no en UTC (el `new Date()` de antes cambiaba de día a las 19:00).
 */
export function estadoParaColumna(venc: string | null | undefined, hoy: string = fechaLima()): "vigente" | "por_vencer" | "vencido" {
  const dias = diasEntreFechas(hoy, venc ?? null);
  if (dias == null) return "vigente";
  if (dias < 0) return "vencido";
  if (dias <= 30) return "por_vencer";
  return "vigente";
}
