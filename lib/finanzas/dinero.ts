// ──────────────────────────────────────────────────────────────────────────────
// lib/finanzas/dinero.ts — Aritmética monetaria canónica del ERP (SIN dependencias).
//
// Reemplaza los cálculos hardcodeados de IGV 18% y detracción 10%/S/700 que hoy viven
// en el front (app/facturacion/page.tsx). Los parámetros se pasan explícitos (vienen
// de config_tributaria / cat_detraccion en la BD — ver supabase/finanzas-00). Nada de
// tasas fijadas en código: aquí solo está la MATEMÁTICA, no los valores legales.
//
// REGLA: todo importe se redondea a 2 decimales al presentar/guardar; los cálculos
// intermedios se hacen en number y se redondean UNA vez al final de cada operación.
// ──────────────────────────────────────────────────────────────────────────────

/** Redondeo bancario-simple a N decimales (evita el ruido binario de 1.005). */
export function redondear(n: number, decimales = 2): number {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, decimales);
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Formato en soles peruanos (mismo criterio que fmtSoles del resto de la app). */
export function fmtMoneda(n: number, moneda = "PEN"): string {
  const simbolo = moneda === "USD" ? "$" : "S/";
  return `${simbolo} ${redondear(n).toLocaleString("es-PE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export type DesgloseIgv = {
  base: number;      // base imponible (neto sin IGV)
  igv: number;       // impuesto
  total: number;     // base + igv
  igvPct: number;
};

/** A partir de un NETO (sin IGV) y el % vigente, calcula igv y total. */
export function desdeNeto(neto: number, igvPct: number): DesgloseIgv {
  const base = redondear(neto);
  const igv = redondear(base * (igvPct / 100));
  return { base, igv, total: redondear(base + igv), igvPct };
}

/** A partir de un TOTAL (con IGV incluido) y el % vigente, extrae base e igv. */
export function desdeTotal(total: number, igvPct: number): DesgloseIgv {
  const t = redondear(total);
  const base = redondear(t / (1 + igvPct / 100));
  return { base, igv: redondear(t - base), total: t, igvPct };
}

export type Detraccion = {
  aplica: boolean;
  porcentaje: number;
  monto: number;       // lo que se detrae (se deposita en Banco de la Nación)
  neto_a_pagar: number; // total − detracción (lo que se transfiere al proveedor)
  codigo?: string | null;
};

/**
 * Calcula la detracción sobre el TOTAL de un comprobante. Opera solo si el total
 * alcanza el umbral. El % y umbral vienen del catálogo (cat_detraccion), NO se fijan
 * aquí. AFA debe confirmar con su contador el código de servicio y la tasa vigente.
 */
export function calcularDetraccion(
  total: number,
  cfg: { porcentaje: number; umbral_min?: number; codigo?: string | null; activa?: boolean }
): Detraccion {
  const t = redondear(total);
  const umbral = cfg.umbral_min ?? 700;
  if (cfg.activa === false || cfg.porcentaje <= 0 || t < umbral) {
    return { aplica: false, porcentaje: cfg.porcentaje, monto: 0, neto_a_pagar: t, codigo: cfg.codigo ?? null };
  }
  const monto = redondear(t * (cfg.porcentaje / 100));
  return { aplica: true, porcentaje: cfg.porcentaje, monto, neto_a_pagar: redondear(t - monto), codigo: cfg.codigo ?? null };
}

/** Convierte un importe de moneda extranjera a PEN con el tipo de cambio dado. */
export function aPEN(monto: number, tipoCambio: number | null | undefined): number {
  const tc = Number(tipoCambio ?? 0);
  return tc > 0 ? redondear(monto * tc) : redondear(monto);
}

/**
 * Saldo pendiente de un comprobante = total − pagado (nunca negativo). El "saldo"
 * es SIEMPRE derivado; jamás se guarda. Ver lib/finanzas/pagos.ts.
 */
export function saldo(total: number | null | undefined, pagado: number | null | undefined): number {
  return redondear(Math.max(0, Number(total ?? 0) - Number(pagado ?? 0)));
}

/** ¿El comprobante está saldado? (con tolerancia de céntimo). */
export function estaSaldado(total: number | null | undefined, pagado: number | null | undefined): boolean {
  return Number(pagado ?? 0) + 0.005 >= Number(total ?? 0) && Number(total ?? 0) > 0;
}

/** Antigüedad de una deuda en días (positivo = vencida hace N días). */
export function diasVencido(fechaVencimiento: string | null | undefined, hoyISO?: string): number | null {
  if (!fechaVencimiento) return null;
  const hoy = hoyISO ? new Date(hoyISO + "T00:00:00-05:00") : new Date();
  const venc = new Date(fechaVencimiento + "T00:00:00-05:00");
  return Math.floor((hoy.getTime() - venc.getTime()) / 86400000);
}

/** Cubeta de aging (0-30 / 31-60 / 61-90 / +90) para reportes de CxC/CxP. */
export function cubetaAging(dias: number | null): "vigente" | "0-30" | "31-60" | "61-90" | "+90" {
  if (dias == null || dias < 0) return "vigente";
  if (dias <= 30) return "0-30";
  if (dias <= 60) return "31-60";
  if (dias <= 90) return "61-90";
  return "+90";
}
