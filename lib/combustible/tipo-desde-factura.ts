// lib/combustible/tipo-desde-factura.ts — Motor PURO: cargas registradas con un combustible
// DISTINTO al que dice su factura.
//
// EL CASO (CWQ400, van bicombustible GLP + gasolina): la factura F882-0130996 trae una línea
// «G-PREMIUM G-PRIX - GASOHOL» de S/ 152.61 que la conciliación dio por «Ya registrada (carga
// #147, por placa + fecha + importe)» — y en Combustible no había NINGUNA carga de gasolina
// premium: la carga existía, pero con otro combustible. El cruce casa por placa, fecha e importe
// y nunca mira el producto, así que enlazar no lo detectaba, y la carga mal tipificada se queda
// sumando a la serie de GLP (rendimiento, tanque, precio de referencia) para siempre.
//
// LA FACTURA ES EL DOCUMENTO LEGAL DEL PRODUCTO (la misma regla de la fusión con el voucher: de la
// factura quedan galones, precio, importe, TIPO y unidad). Pero un enlace por importe puede, en
// teoría, casar dos despachos distintos del mismo día, así que el tipo solo se propone corregir
// cuando la CANTIDAD también casa: con importe Y cantidad iguales es el mismo despacho y lo único
// que difiere es cómo se rotuló. Se PROPONE con la lista a la vista; lo aplica una persona.

import { familiaCombustible, configCombustible, unidadDeCarga } from "@/lib/combustible-tipos";
import { TOLERANCIA_CANTIDAD, TOLERANCIA_MONTO } from "@/lib/combustible/factura-lineas";

export type LineaConTipo = { n: number; tipo_combustible: string | null; cantidad: number | null; total: number | null; descripcion?: string | null };
export type PlanConCarga = { n: number; codigo: string; casa_con?: number | string | null; combustible_id?: number | string | null };
export type FacturaParaTipo = { id: number; serie: string | null; numero: string | null; lineas: LineaConTipo[]; conciliacion: PlanConCarga[] };
export type CargaParaTipo = { id: number; tipo_combustible: string | null; unidad: string | null; galones: number | null; total: number | null; fecha: string; placa: string | null };

export type TipoPorCorregir = {
  carga_id: number;
  fecha: string;
  placa: string | null;
  total: number | null;
  galones: number | null;
  /** Lo que dice HOY la carga (null = sin tipo, que el ERP pinta como diésel). */
  tipo_carga: string | null;
  /** Lo que dice la factura. */
  tipo_factura: string;
  /** La unidad que corresponde al tipo de la factura (galones / m³), respetando litros declarados. */
  unidad_factura: string;
  factura_id: number;
  comprobante: string;
  producto: string;
};

/**
 * ¿La carga está rotulada con otro combustible que su factura? Cuenta como distinto un cambio de
 * FAMILIA (GLP ↔ gasolina) o una carga con el tipo legado «gasolina» a secas, sin octanaje, cuando
 * la factura sí dice cuál (regular / premium). Dos tipos de la misma familia ya precisos no se
 * tocan: no hay nada que la factura aclare.
 */
export function tipoDistinto(tipoCarga: string | null, tipoFactura: string): boolean {
  if (!tipoFactura || tipoCarga === tipoFactura) return false;
  if (familiaCombustible(tipoCarga) !== familiaCombustible(tipoFactura)) return true;
  return !!configCombustible(tipoCarga).legado && !configCombustible(tipoFactura).legado;
}

export function tiposPorCorregir(facturas: FacturaParaTipo[], cargas: Map<number, CargaParaTipo>): TipoPorCorregir[] {
  const out: TipoPorCorregir[] = [];
  const vistas = new Set<number>();
  for (const f of facturas) {
    const lineas = new Map((Array.isArray(f.lineas) ? f.lineas : []).map((l) => [Number(l.n), l]));
    for (const p of Array.isArray(f.conciliacion) ? f.conciliacion : []) {
      if (p.codigo !== "ya_registrada" && p.codigo !== "registrar") continue;
      const id = Number(p.combustible_id ?? p.casa_con);
      if (!Number.isFinite(id) || vistas.has(id)) continue;
      const c = cargas.get(id);
      const l = lineas.get(Number(p.n));
      if (!c || !l?.tipo_combustible) continue;
      if (!tipoDistinto(c.tipo_combustible, l.tipo_combustible)) continue;
      // Mismo despacho: importe Y cantidad. Sin los dos, podría ser otra carga del mismo día.
      if (c.total == null || l.total == null || Math.abs(Number(c.total) - Number(l.total)) >= TOLERANCIA_MONTO) continue;
      if (c.galones == null || l.cantidad == null || Math.abs(Number(c.galones) - Number(l.cantidad)) > TOLERANCIA_CANTIDAD) continue;
      vistas.add(id);
      out.push({
        carga_id: id, fecha: c.fecha, placa: c.placa, total: c.total, galones: c.galones,
        tipo_carga: c.tipo_combustible, tipo_factura: l.tipo_combustible,
        unidad_factura: unidadDeCarga(l.tipo_combustible, c.unidad),
        factura_id: f.id, comprobante: `${f.serie ?? ""}-${f.numero ?? ""}`, producto: String(l.descripcion ?? ""),
      });
    }
  }
  return out.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : a.carga_id - b.carga_id));
}

/** Lo que se escribe en `observaciones` al corregir: quién lo dijo y qué decía antes. */
export const notaTipoCorregido = (antes: string | null, comprobante: string): string =>
  `Combustible corregido según la factura ${comprobante} (decía ${antes ? configCombustible(antes).label : "sin tipo"}).`;
