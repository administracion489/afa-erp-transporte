// ──────────────────────────────────────────────────────────────────────────────
// lib/tipo-cambio-sunat.ts — El tipo de cambio del día publicado por SUNAT. SOLO SERVIDOR (el
// fetch); el parseo es PURO y lo prueba scripts/prueba-tipo-cambio-sunat.mts.
//
// Fuente principal: https://www.sunat.gob.pe/a/txt/tipoCambio.txt, que devuelve una línea
// «19/10/2026|3.423|3.431|» (fecha|compra|venta). Su firewall RECHAZA las peticiones sin un
// User-Agent de navegador («Request Rejected»), por eso se manda uno. Respaldo: la API pública
// de apis.net.pe (v1, sin token), que republica el mismo dato de SUNAT.
//
// Llena la tabla `tipo_cambio` (finanzas-00), que ya leía /cotizaciones para SUGERIR el tipo de
// cambio y que nadie llenaba. La cotización automática de traslados en dólares lo necesita: los
// importes del ERP se guardan en soles.
// ──────────────────────────────────────────────────────────────────────────────

import { revisarTipoCambio } from "./cotizacion-moneda";

export type TipoCambioDia = { fecha: string; compra: number; venta: number; fuente: string };

/** «19/10/2026|3.423|3.431|» → { fecha: "2026-10-19", compra, venta }. null si no es eso. */
export function parsearTxtSunat(txt: string): Omit<TipoCambioDia, "fuente"> | null {
  const m = String(txt ?? "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\|([\d.]+)\|([\d.]+)\|?/);
  if (!m) return null;
  const fecha = `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(`${fecha}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== fecha) return null;
  const compra = revisarTipoCambio(m[4]).tc;
  const venta = revisarTipoCambio(m[5]).tc;
  if (compra == null || venta == null) return null;
  return { fecha, compra, venta };
}

/** { fecha: "2026-10-19", compra: 3.423, venta: 3.431 } de apis.net.pe v1. */
export function parsearJsonApisNet(j: unknown): Omit<TipoCambioDia, "fuente"> | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const fecha = typeof o.fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.fecha) ? o.fecha : null;
  const compra = revisarTipoCambio(o.compra).tc;
  const venta = revisarTipoCambio(o.venta).tc;
  if (!fecha || compra == null || venta == null) return null;
  return { fecha, compra, venta };
}

/** Más de una semana: no es el tipo de cambio de hoy (mismo tope que la cotización de traslados). */
export const TC_MAX_DIAS_GUARDAR = 7;
/**
 * Salto máximo, respecto del último guardado, que se acepta del RESPALDO (apis.net.pe). NO MEDIDO:
 * el sol rara vez se mueve 3 % en un día. La fuente principal (SUNAT) no se frena: es la oficial.
 * Un salto mayor del respaldo no se guarda y lo revisa una persona.
 */
export const SALTO_MAX_RESPALDO = 0.03;

/** ¿Se puede guardar este tipo de cambio? Fecha ni futura ni vieja, y el respaldo sin saltos. */
export function revisarParaGuardar(
  tc: TipoCambioDia, hoy: string, ultimo: { venta: number } | null,
): { ok: true } | { ok: false; detalle: string } {
  if (tc.fecha > hoy) return { ok: false, detalle: `La fecha ${tc.fecha} es posterior a hoy (${hoy}).` };
  const dias = Math.round((Date.parse(`${hoy}T00:00:00Z`) - Date.parse(`${tc.fecha}T00:00:00Z`)) / 86400000);
  if (dias > TC_MAX_DIAS_GUARDAR) return { ok: false, detalle: `El tipo de cambio es del ${tc.fecha}: tiene ${dias} días.` };
  if (tc.fuente !== "SUNAT" && ultimo && ultimo.venta > 0) {
    const salto = Math.abs(tc.venta - ultimo.venta) / ultimo.venta;
    if (salto > SALTO_MAX_RESPALDO) {
      return { ok: false, detalle: `${tc.fuente} da ${tc.venta}, un ${(salto * 100).toFixed(1)} % distinto del último guardado (${ultimo.venta}): no se guarda sin revisarlo.` };
    }
  }
  return { ok: true };
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function obtenerTipoCambioSunat(): Promise<{ ok: true; tc: TipoCambioDia } | { ok: false; detalle: string }> {
  const errores: string[] = [];
  try {
    const r = await fetch("https://www.sunat.gob.pe/a/txt/tipoCambio.txt", {
      headers: { "User-Agent": UA, Accept: "text/plain,*/*" }, cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    const txt = await r.text();
    const p = r.ok ? parsearTxtSunat(txt) : null;
    if (p) return { ok: true, tc: { ...p, fuente: "SUNAT" } };
    errores.push(`SUNAT respondió ${r.status} sin un tipo de cambio legible`);
  } catch (e) {
    errores.push(`SUNAT: ${(e as Error)?.message ?? "sin respuesta"}`);
  }
  try {
    const r = await fetch("https://api.apis.net.pe/v1/tipo-cambio-sunat", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    const p = r.ok ? parsearJsonApisNet(await r.json()) : null;
    if (p) return { ok: true, tc: { ...p, fuente: "SUNAT (apis.net.pe)" } };
    errores.push(`apis.net.pe respondió ${r.status} sin un tipo de cambio legible`);
  } catch (e) {
    errores.push(`apis.net.pe: ${(e as Error)?.message ?? "sin respuesta"}`);
  }
  return { ok: false, detalle: errores.join(" · ") };
}
