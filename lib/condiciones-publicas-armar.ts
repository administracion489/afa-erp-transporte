// ──────────────────────────────────────────────────────────────────────────────
// lib/condiciones-publicas-armar.ts — Lo que devuelve GET /api/condiciones/[token], armado desde la
// fila de la cotización y el perfil de la empresa. PURO (la ruta lee; esto decide qué sale).
//
// QUÉ SALE Y QUÉ NO: la política de reserva, cambios y cancelación GUARDADA EN ESA COTIZACIÓN
// (`consideraciones_json.reserva`, la que se le informó al cliente antes de pagar) y su resumen; el
// número, la fecha de emisión y el idioma de la cotización; y de la empresa solo lo que se imprime en
// el pie de un documento (nombre, razón social, RUC, logo, web, teléfono, correo). NUNCA datos del
// cliente, precios, cuentas bancarias ni la ruta: quien tiene el enlace es quien lo recibió, pero un
// enlace se reenvía.
// ──────────────────────────────────────────────────────────────────────────────

import { DETALLE_CONDICIONES, type EmpresaCondiciones, type RespuestaCondicionesPublicas } from "./condiciones-publicas";
import { numeroCotizacion } from "./cotizacion-corporativo";
import { normalizarIdioma } from "./cotizacion-idioma";
import { empresaConDefectos, type PerfilEmpresa } from "./empresa-perfil";
import { fechaLima } from "./alertas-horario";

/** Las columnas de `cotizaciones` que lee la ruta pública (y ninguna otra). */
export const COLS_CONDICIONES_PUBLICAS = ["id", "numero_cotizacion", "created_at", "consideraciones_json", "idioma_pdf"] as const;
/** De una migración accesoria (cotizaciones-04): sin ella, la página va en castellano. */
export const COLS_CONDICIONES_ACCESORIAS = ["idioma_pdf"] as const;
/** Las columnas del perfil que se enseñan. */
export const COLS_PERFIL_CONDICIONES = "nombre, razon_social, ruc, logo_url, telefono, email, web";

export type FilaCondiciones = {
  id: number;
  numero_cotizacion?: string | null;
  created_at?: string | null;
  consideraciones_json?: unknown;
  idioma_pdf?: string | null;
};

const limpia = (l: unknown): string[] => (Array.isArray(l) ? l.map((x) => String(x ?? "").replace(/\s+/g, " ").trim()).filter(Boolean) : []);
const o = (x: unknown): string | null => { const t = String(x ?? "").trim(); return t ? t : null; };

/** Lo que se enseña de la empresa: el pie de un documento, sin el aviso de «configura el perfil». */
export function empresaParaCondiciones(perfil: PerfilEmpresa | null | undefined): EmpresaCondiciones {
  const e = empresaConDefectos(perfil);
  return {
    nombre: e.sinConfigurar ? null : e.nombre,
    razon_social: o(perfil?.razon_social),
    ruc: o(e.ruc),
    logo_url: e.logo,
    web: o(e.web),
    telefono: o(e.telefono),
    email: o(e.email),
  };
}

/**
 * La respuesta de la ruta pública para una cotización ya encontrada por su token. Sin política
 * guardada en la fila → `sin_condiciones` (la ruta responde 404).
 */
export function armarCondicionesPublicas(fila: FilaCondiciones, perfil: PerfilEmpresa | null | undefined): RespuestaCondicionesPublicas {
  const cj = fila?.consideraciones_json && typeof fila.consideraciones_json === "object" && !Array.isArray(fila.consideraciones_json)
    ? (fila.consideraciones_json as Record<string, unknown>) : {};
  const politica = limpia(cj.reserva);
  if (!politica.length) return { ok: false, codigo: "sin_condiciones", detalle: DETALLE_CONDICIONES.sin_condiciones };
  const ms = fila.created_at ? Date.parse(fila.created_at) : NaN;
  return {
    ok: true,
    empresa: empresaParaCondiciones(perfil),
    numero: numeroCotizacion({ id: Number(fila.id), numero_cotizacion: fila.numero_cotizacion ?? null }),
    emitida: Number.isFinite(ms) ? fechaLima(ms) : null,
    idioma: normalizarIdioma(fila.idioma_pdf),
    politica,
    resumen: limpia(cj.reserva_resumen),
  };
}
