// ──────────────────────────────────────────────────────────────────────────────
// lib/finanzas/afectacion.ts — Tratamiento del IGV por operación (Catálogo 07 SUNAT).
//
// Espejo en TypeScript de supabase/pacto-00-tributario.sql. La BD es la autoridad
// (public.cat_afectacion_igv es EDITABLE porque las reglas cambian por resolución);
// esto es la copia mínima que necesita el navegador para pintar el panel de margen en
// vivo sin ir y volver del servidor en cada tecla.
//
// POR QUÉ EXISTE. Hasta ahora el ERP asumía que todo lleva IGV 18 %, y eso hace que el
// tablero recomiende al proveedor equivocado:
//
//     Proveedor A · factura GRAVADA por S/ 550 → el IGV vuelve como crédito fiscal
//                                              → te cuesta S/ 466.10
//     Proveedor B · taxi EXONERADO   por S/ 500 → no hay crédito que recuperar
//                                              → te cuesta S/ 500.00
//
// El "caro" es 7 % más barato. Nunca compares dos importes sin pasarlos antes por
// `costoReal`.
//
// Casos de AFA, confirmados con su contador:
//   · Transporte de PERSONAL          → 10 gravado (no es transporte público).
//   · Servicio de TAXI que AFA compra → 20 exonerado (Apéndice II num. 2).
//   · Paquete turístico a no domiciliado → 40 exportación (art. 33 num. 9).
//   · Sin IGV no hay detracción.
// ──────────────────────────────────────────────────────────────────────────────

import { redondear, gravaIgv } from "./dinero";

// El primitivo `gravaIgv` vive en dinero.ts (que no tiene dependencias) y se re-exporta
// aquí para que todo lo tributario se importe de un solo módulo.
export { gravaIgv };

/** Código del Catálogo 07 de SUNAT. Es texto porque así viaja al comprobante. */
export type CodigoAfectacion = "10" | "20" | "30" | "40";

export type Afectacion = {
  codigo: CodigoAfectacion;
  nombre: string;
  /** ¿El comprobante lleva IGV? Manda sobre config_tributaria.igv_pct. */
  grava: boolean;
  /** Lado compra: ¿el IGV pagado se recupera? La exportación da crédito pleno. */
  daCredito: boolean;
  /** Sin IGV no hay detracción. */
  admiteDetraccion: boolean;
  /** Etiqueta corta para chips y tablas. */
  etiqueta: string;
};

export const AFECTACIONES: Record<CodigoAfectacion, Afectacion> = {
  "10": { codigo: "10", nombre: "Gravado — operación onerosa", grava: true,  daCredito: true,  admiteDetraccion: true,  etiqueta: "Gravado" },
  "20": { codigo: "20", nombre: "Exonerado — operación onerosa", grava: false, daCredito: false, admiteDetraccion: false, etiqueta: "Exonerado" },
  "30": { codigo: "30", nombre: "Inafecto — operación onerosa", grava: false, daCredito: false, admiteDetraccion: false, etiqueta: "Inafecto" },
  "40": { codigo: "40", nombre: "Exportación de servicios",     grava: false, daCredito: true,  admiteDetraccion: false, etiqueta: "Exportación" },
};

export const AFECTACION_DEFECTO: CodigoAfectacion = "10";

/** Resuelve un código a su ficha. Un código desconocido cae en gravado, que es el caso normal. */
export function afectacionDe(codigo?: string | null): Afectacion {
  return AFECTACIONES[(codigo ?? AFECTACION_DEFECTO) as CodigoAfectacion] ?? AFECTACIONES[AFECTACION_DEFECTO];
}

/** ¿Esta operación admite detracción? Sin IGV, no. */
export function admiteDetraccion(codigo?: string | null): boolean {
  return afectacionDe(codigo).admiteDetraccion;
}

/** Cómo se teclean los importes en el ERP. Solo afecta la captura, no el almacenamiento. */
export type BaseCaptura = "neto" | "bruto";

/**
 * Convierte cualquier importe tecleado a NETO (base imponible) — la única base en la
 * que un margen es comparable entre operaciones con distinta afectación.
 *
 * Una operación sin IGV no tiene nada que separar: lo cobrado ES el neto.
 */
export function aNeto(monto: number, codigo?: string | null, base: BaseCaptura = "bruto", igvPct = 18): number {
  const m = Number(monto) || 0;
  if (m === 0) return 0;
  if (!gravaIgv(codigo)) return redondear(m);
  return redondear(base === "neto" ? m : m / (1 + igvPct / 100));
}

/** El inverso: lo que se le muestra o cobra al cliente, con IGV si corresponde. */
export function aBruto(neto: number, codigo?: string | null, igvPct = 18): number {
  const n = Number(neto) || 0;
  if (n === 0) return 0;
  return gravaIgv(codigo) ? redondear(n * (1 + igvPct / 100)) : redondear(n);
}

/**
 * EL COSTO REAL de una compra: lo que de verdad sale del bolsillo de AFA.
 *
 *   · Gravado y el proveedor emite factura → el IGV vuelve ⇒ cuesta el NETO.
 *   · Exonerado/inafecto, o proveedor sin factura (RUS, boleta) → no hay crédito
 *     que recuperar ⇒ cuesta el IMPORTE COMPLETO.
 *
 * Espejo exacto de public.fn_costo_real. Es la función que hace comparables al
 * proveedor de 550 y al de 500.
 */
export function costoReal(
  monto: number,
  codigo?: string | null,
  opts: { emiteFactura?: boolean; base?: BaseCaptura; igvPct?: number } = {}
): number {
  const m = Number(monto) || 0;
  if (m === 0) return 0;

  const { emiteFactura = true, base = "bruto", igvPct = 18 } = opts;
  const af = afectacionDe(codigo);

  // Sin IGV en el comprobante no hay nada que separar.
  if (!af.grava) return redondear(m);

  const bruto = base === "neto" ? m * (1 + igvPct / 100) : m;
  const recupera = af.daCredito && emiteFactura;
  return redondear(recupera ? bruto / (1 + igvPct / 100) : bruto);
}

/** Ingreso comparable de una venta: el neto, sin el IGV que es de SUNAT y no de AFA. */
export function ingresoReal(
  monto: number,
  codigo?: string | null,
  opts: { base?: BaseCaptura; igvPct?: number } = {}
): number {
  return aNeto(monto, codigo, opts.base ?? "bruto", opts.igvPct ?? 18);
}

export type Margen = {
  ingreso: number;
  costo: number;
  margen: number;
  /** Porcentaje sobre el ingreso. null cuando no hay ingreso con el que comparar. */
  pct: number | null;
};

/**
 * Margen de un servicio, ya normalizado a neto por ambos lados. Es lo que alimenta el
 * panel en vivo del modal de Programación: sin esta normalización el panel se equivoca
 * hasta en 30 % y el operador elige mal.
 */
export function margenServicio(
  precioCliente: number,
  costoProveedor: number,
  opts: {
    ventaAfectacion?: string | null;
    compraAfectacion?: string | null;
    emiteFactura?: boolean;
    base?: BaseCaptura;
    igvPct?: number;
  } = {}
): Margen {
  const { ventaAfectacion, compraAfectacion, emiteFactura = true, base = "bruto", igvPct = 18 } = opts;
  const ingreso = ingresoReal(precioCliente, ventaAfectacion, { base, igvPct });
  const costo = costoReal(costoProveedor, compraAfectacion, { emiteFactura, base, igvPct });
  const margen = redondear(ingreso - costo);
  return { ingreso, costo, margen, pct: ingreso > 0 ? redondear((margen / ingreso) * 100) : null };
}

/**
 * Explica en castellano por qué dos importes no se comparan de frente. Se muestra
 * junto al costo sugerido cuando el proveedor nuevo tiene otra afectación que el
 * anterior: es el momento exacto en que el operador está por elegir mal.
 */
export function explicarCosto(monto: number, codigo?: string | null, emiteFactura = true): string {
  const af = afectacionDe(codigo);
  const real = costoReal(monto, codigo, { emiteFactura });
  if (!af.grava) return `${af.etiqueta}: sin IGV que recuperar, te cuesta los S/ ${real.toFixed(2)} completos.`;
  if (!emiteFactura) return `Gravado pero sin factura: no hay crédito fiscal, te cuesta S/ ${real.toFixed(2)}.`;
  return `Gravado con factura: el IGV vuelve como crédito, te cuesta S/ ${real.toFixed(2)}.`;
}
