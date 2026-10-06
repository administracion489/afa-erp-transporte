// ──────────────────────────────────────────────────────────────────────────────
// lib/combustible/orden-revision.ts — Motor PURO: en qué orden se revisan las recargas del Radar IA
// y las facturas del correo, y qué se le dice al operador en cada pantalla. No lee la base.
//
// LO PREGUNTÓ EL DUEÑO: «¿primero debo revisar el Radar IA —que no quede ninguna recarga observada— y
// recién después las facturas? Si es así, acláralo para que los operadores no tengan problemas al
// registrar o cruzar información».
//
// SÍ: PRIMERO EL RADAR, DESPUÉS LAS FACTURAS. No es una costumbre, sale de cómo se cruzan:
//   • El VOUCHER que lee el Radar trae lo que la factura NO tiene: la fecha del despacho, el
//     odómetro, el conductor y la nota de despacho. La factura trae el comprobante legal.
//   • Una recarga registrada en el Radar se ENLAZA sola con su línea de factura en la próxima
//     lectura del correo (`ya_registrada`, lib/combustible/factura-lineas.ts): nadie tiene que hacer
//     nada en la pestaña de facturas.
//   • Mientras la recarga siga «Por revisar», la línea de su factura queda «En revisión del Radar»
//     (`en_radar_pendiente`) y la factura no se cierra: desde la factura no hay nada que hacer con
//     ella. Revisar las facturas primero es encontrarse con eso.
//   • Lo que la factura registre sola —cuando el Radar no capturó la carga, o la capturó con un
//     número que no casa— entra SIN odómetro, y si después aparece su voucher hay que FUSIONARLO
//     (lib/radar/fusion-factura.ts) en vez de registrarlo. Trabajo de más, no un error: desde este
//     cambio el botón «Registrar» del Radar lo detecta y lo dice antes de duplicar nada.
//
// Por eso las frases viven aquí y no dentro de cada TSX: las dos pantallas y la ayuda tienen que
// describir el MISMO orden, y una frase compuesta en una pantalla puede quedarse atrás sin que nada
// falle (la etiqueta invertida del horario del conductor).
// ──────────────────────────────────────────────────────────────────────────────

import { normPlaca, type PlanLinea } from "@/lib/combustible/factura-lineas";

/** Los dos pasos, con el rótulo de cada pantalla tal como aparece en el ERP. */
export const PASOS_REVISION = [
  { n: 1, donde: "Radar IA → Combustible", que: "Revisa las recargas «Por revisar» hasta que no quede ninguna: regístralas (o fusiónalas con la carga que ya entró desde su factura) o descártalas." },
  { n: 2, donde: "Combustible → 📧 Facturas", que: "Las facturas se cruzan solas con lo registrado: confirma solo lo que quede en «Revisar»." },
] as const;

export type AvisoOrden = {
  /** `pendiente`: falta el paso 1. `listo`: el Radar está al día. */
  tono: "pendiente" | "listo";
  titulo: string;
  detalle: string;
};

/**
 * El aviso de la pestaña de FACTURAS. `pendientesRadar` en null = no se pudo contar: no se afirma
 * nada (ni «al día» ni un número que puede estar corto). `lineasEsperando`: líneas de las facturas en
 * pantalla que esperan a una recarga del Radar (`en_radar_pendiente`).
 */
export function avisoOrdenEnFacturas(n: { pendientesRadar: number | null; lineasEsperando: number }): AvisoOrden | null {
  if (n.pendientesRadar == null) return null;
  if (n.pendientesRadar === 0) {
    return {
      tono: "listo",
      titulo: "✓ El Radar IA está al día: no queda ninguna recarga por revisar.",
      detalle: n.lineasEsperando
        ? `${n.lineasEsperando} línea(s) todavía dicen «En revisión del Radar»: se cierran solas en la próxima lectura del correo (cada 3 h, o con «📧 Leer correo ahora»).`
        : "Lo que quede aquí en «Revisar» es de la factura: confírmalo con su placa y su fecha.",
    };
  }
  return {
    tono: "pendiente",
    titulo: `Primero el Radar: hay ${n.pendientesRadar} recarga(s) por revisar en Radar IA → Combustible.`,
    detalle:
      "Revísalas antes que las facturas. Cada recarga que registres allá se cruza sola con su línea de factura en la próxima lectura " +
      "del correo, con la fecha del despacho y el odómetro que la factura no trae." +
      (n.lineasEsperando
        ? ` ${n.lineasEsperando} línea(s) de estas facturas las están esperando («En revisión del Radar»): desde aquí no se pueden cerrar.`
        : "") +
      " Si registras aquí una carga cuyo voucher sigue por revisar allá, después habrá que fusionarlas.",
  };
}

/** El aviso de Radar IA → Combustible. `conFactura`: de las por revisar, cuántas ya tienen su factura esperando. */
export function avisoOrdenEnRadar(n: { pendientes: number; conFactura: number }): AvisoOrden {
  if (n.pendientes === 0) {
    return {
      tono: "listo",
      titulo: "✓ No queda ninguna recarga por revisar.",
      detalle: "Ya puedes pasar a las facturas (Combustible → 📧 Facturas): lo que registraste aquí se cruza solo con ellas.",
    };
  }
  return {
    tono: "pendiente",
    titulo: `Revisa estas ${n.pendientes} recarga(s) antes que las facturas.`,
    detalle:
      "Primero el Radar, después las facturas (Combustible → 📧 Facturas). Cada recarga que registres —o fusiones con la carga que ya " +
      "entró desde su factura— se cruza sola con su factura; mientras siga aquí, la línea de su factura queda «En revisión del Radar»." +
      (n.conFactura ? ` ${n.conFactura} ya tienen su factura esperando (📧).` : ""),
  };
}

/**
 * Cómo se encuentran EN LA BASE las facturas con líneas que esperan al Radar. Una factura con una
 * línea `en_radar_pendiente` queda `parcial` (nunca «conciliada»); `procesada` cubre las viejas.
 * Va como TEXTO JSON por la misma trampa que FILTRO_HISTORICO: supabase-js convierte un array pasado
 * tal cual a `.contains()` en `cs.{[object Object]}`, que no encuentra nada.
 */
export const FILTRO_ESPERAN_RADAR = {
  estados: ["parcial", "procesada"],
  conciliacion: JSON.stringify([{ codigo: "en_radar_pendiente" }]),
} as const;

/** Las facturas que ESPERAN a una recarga del Radar: id de la fila del Radar → «F882-0124552». */
export function facturasQueEsperan(
  filas: { serie?: string | null; numero?: string | null; conciliacion?: PlanLinea[] | null }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of filas ?? []) {
    const etiqueta = f.serie && f.numero ? `${f.serie}-${f.numero}` : "una factura del correo";
    for (const p of Array.isArray(f.conciliacion) ? f.conciliacion : []) {
      if (p?.codigo === "en_radar_pendiente" && p.casa_con != null && !out.has(String(p.casa_con))) out.set(String(p.casa_con), etiqueta);
    }
  }
  return out;
}

/** Una recarga del Radar por revisar, con lo justo para cruzarla con una línea de factura. */
export type RecargaPorRevisar = { id: string; placa: string | null; fecha: string | null; monto: number | null };

const T = (f: string) => Date.parse(`${f.slice(0, 10)}T12:00:00Z`);

/**
 * Las recargas del Radar por revisar de ESA placa cerca de la fecha de una línea de factura (±`dias`).
 * Es el aviso de la pestaña de facturas antes de «Registrar esta carga»: si una de ellas es esa carga,
 * lo que corresponde es registrarla en el Radar —trae el odómetro y la fecha del despacho— y dejar que
 * la línea se cruce sola. No exige el mismo importe a propósito: la que no casó con la línea suele ser
 * justo la que tiene un número mal leído.
 */
export function pendientesCerca(
  linea: { placa: string | null; fecha: string | null },
  pendientes: RecargaPorRevisar[],
  dias = 3,
): RecargaPorRevisar[] {
  const placa = normPlaca(linea.placa);
  if (!placa || !linea.fecha) return [];
  const t = T(linea.fecha);
  if (!Number.isFinite(t)) return [];
  return (pendientes ?? []).filter((r) => {
    if (normPlaca(r.placa) !== placa || !r.fecha) return false;
    const d = Math.abs(T(r.fecha) - t) / 86_400_000;
    return Number.isFinite(d) && d <= dias;
  });
}
