// lib/mantenimiento/costo-ot.ts — Cuánto costó una orden de trabajo, adónde va ese número y
// cómo se ata a la factura del taller. Módulo PURO: no lee la base, no escribe nada.
//
// ══════════════════════════════════════════════════════════════════════════════
// EL BUG, QUE ES PEOR QUE «NO HAY DÓNDE PONER EL COSTO»
//
// El campo «Costo total S/» ya existía en el formulario de la OT. Lo que no existía era que ese
// número LLEGARA a donde se lee: `ordenes_trabajo.costo_total` no lo consulta nadie fuera de esa
// pantalla. Quien cuenta el dinero es `mantenimiento.costo` — `v_egresos` lo publica como egreso
// con su vehículo y su servicio, `v_costo_servicio` lo cruza contra el ingreso, y la columna
// «Medido» de 🔧 Mantenimiento mide con él el S/km de la categoría.
//
// Y la copia entre las dos ocurría UNA sola vez, en el instante de cerrar la OT:
//
//     insert into mantenimiento (..., costo: Number(ot.costo_total || 0), ...)
//
// Una OT automática nace en 0 y se cierra en 0, así que esa fila queda en **cero para siempre**;
// teclear el costo después no mueve ni el egreso, ni el margen del servicio, ni el S/km medido.
// Eso es lo que se ve en pantalla: dos OT cerradas y «COSTO TOTAL S/ 0.00».
//
// Y NO HABÍA FORMA DE ARREGLARLO SOLO, porque el único vínculo de vuelta era el TEXTO
// `"OT #4 — CWZ-371"` metido dentro de `mantenimiento.descripcion`. Escribir bajo una clave y
// leer con otra: el patrón que este repo ya pagó cinco veces. Por eso `costos-factura-cxp`
// agrega `ordenes_trabajo.mantenimiento_id` — un FK de verdad — y adopta las filas viejas
// parseando ese texto UNA vez, solo cuando es inequívoco.
//
// ══════════════════════════════════════════════════════════════════════════════
// EL GASTO YA ESTABA EN GASTOS. LO QUE FALTABA ERA LA CUENTA POR PAGAR.
//
// La petición original era «que la factura se suba a gastos», y eso habría contado el mismo sol
// DOS VECES: `v_egresos` ya suma `mantenimiento.costo`. Es exactamente lo que evita
// `promoverGastos` de caja chica filtrando `gasto_id is null`.
//
// Lo que de verdad falta es que la factura del taller sea un **comprobante de compra**
// (`documentos_compra`): ahí se aprueba, entra a un lote de pago, se concilia contra el banco y
// sustenta el crédito fiscal del IGV. `mantenimiento.documento_compra_id` ya existía y
// `v_egresos` ya lo publicaba — ninguna pantalla lo escribía. Y no duplica nada: el propio
// `v_egresos` declara que «documentos_compra se suma aparte para no contar el mismo sol dos
// veces».
// ══════════════════════════════════════════════════════════════════════════════

/** Un ítem del checklist con su costo. `null` = nadie lo tecleó (distinto de 0, que es «gratis»). */
export type ItemCosto = { id: number | string; costo: number | null };

export type OrigenTotal =
  | "items"      // hay ítems con costo: el total es su SUMA y el campo va en solo lectura
  | "tecleado"   // nadie itemizó: el total es el número que alguien escribió
  | "sin_dato";  // ni ítems ni total — la OT todavía no dice cuánto costó

export type TotalOT = {
  total: number;
  origen: OrigenTotal;
  itemsConCosto: number;
  itemsTotales: number;
  /** Lo que la pantalla imprime debajo del campo. Nunca se redacta en la pantalla. */
  detalle: string;
};

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** Redondeo al céntimo. Sumar decimales en coma flotante deja 1234.5600000000002. */
export const aCentimos = (v: number): number => Math.round(n(v) * 100) / 100;

/**
 * EL TOTAL DE LA OT, CON SU ORIGEN DECLARADO.
 *
 * Hay dos formas legítimas de saber cuánto costó una orden y **una sola puede mandar a la vez**,
 * o el ERP tendría dos números para el mismo dinero — lo que la regla de oro prohíbe:
 *
 *   · Alguien itemizó (el PDF impreso de la OT lleva desde siempre un «Costo: S/ ______» al lado
 *     de cada repuesto, para rellenar a mano). Entonces el total es la SUMA y el campo se pone en
 *     solo lectura: dejarlo editable invita a teclear un total que no cuadra con su propio detalle.
 *   · Nadie itemizó — una factura de taller suele llegar con un importe global. Entonces manda el
 *     total tecleado, y repartirlo entre catorce ítems sería inventar el reparto.
 *
 * Un ítem en **0 cuenta como itemizado**: «esta revisión no costó nada» es un dato que alguien
 * escribió. Lo que no cuenta es `null`, que es no haberlo tocado.
 */
export function totalDeOT(items: ItemCosto[], totalTecleado: number | null | undefined): TotalOT {
  const conCosto = items.filter(i => i.costo !== null && i.costo !== undefined && Number.isFinite(Number(i.costo)));
  const tecleado = totalTecleado === null || totalTecleado === undefined ? null : n(totalTecleado);

  if (conCosto.length) {
    const suma = aCentimos(conCosto.reduce((s, i) => s + n(i.costo), 0));
    return {
      total: suma, origen: "items",
      itemsConCosto: conCosto.length, itemsTotales: items.length,
      detalle: `Suma de ${conCosto.length} ítem(s) con costo${items.length > conCosto.length ? ` de ${items.length}` : ""}. Para teclear un total distinto, borra los costos de los ítems.`,
    };
  }
  if (tecleado !== null && tecleado > 0) {
    return {
      total: aCentimos(tecleado), origen: "tecleado",
      itemsConCosto: 0, itemsTotales: items.length,
      detalle: items.length
        ? "Total de la orden. Si pones el costo de algún ítem, el total pasa a salir de la suma."
        : "Total de la orden.",
    };
  }
  return {
    total: 0, origen: "sin_dato",
    itemsConCosto: 0, itemsTotales: items.length,
    detalle: "Sin costo: esta orden entra al libro de mantenimiento en S/ 0.00, y ese cero baja el S/km medido de toda su categoría.",
  };
}

// ── La fila autoritativa ─────────────────────────────────────────────────────

export type CodigoSincro =
  | "sin_cierre"   // la OT sigue abierta: el egreso nace al cerrar, no antes
  | "actualiza"    // hay que reescribir la fila de `mantenimiento`
  | "sin_cambio"   // la fila ya dice lo mismo
  | "sin_ancla";   // está cerrada y no se sabe qué fila de `mantenimiento` es suya

export type PlanSincro = {
  codigo: CodigoSincro;
  /** Lo que hay que escribir en `mantenimiento`. Vacío cuando no hay nada que hacer. */
  patch: { costo?: number; costo_imputado?: number; kilometraje?: number; documento_compra_id?: number | null };
  detalle: string;
};

export type EstadoOT = {
  estado: string | null;
  mantenimiento_id: number | null;
  km_cierre: number | null;
  documento_compra_id: number | null;
};

export type FilaMantenimiento = {
  costo: number | null;
  kilometraje: number | null;
  documento_compra_id: number | null;
  /** Lo que costó sin que saliera plata (mano de obra propia, almacén). De `mantenimiento-06`. */
  costo_imputado?: number | null;
};

/**
 * QUÉ HAY QUE ESCRIBIR EN `mantenimiento` PARA QUE EL EGRESO DIGA LA VERDAD.
 *
 * Es la mitad que faltaba: el costo no se copia solo al cerrar, se **sigue** copiando cada vez
 * que cambia. Sin esto, corregir un importe tres días después es un cambio que no llega a
 * ninguna de las tres pantallas que lo leen.
 *
 * Reglas duras:
 *  · **Una OT abierta no es un egreso.** El dinero se asienta cuando el servicio se hizo; antes
 *    es un presupuesto. Misma razón por la que el presupuesto de un servicio nunca va a
 *    `reservas.costo_proveedor`.
 *  · **El kilometraje se arrastra igual.** Es el otro dato del que vive el S/km medido: un tramo
 *    sin kilometraje no se puede medir, y el modal de «Medido» lo dice tipo por tipo.
 *  · **Sin ancla no se inventa una fila.** Insertar una nueva cuando el FK falta duplicaría el
 *    egreso de una OT que ya lo tiene asentado — el error caro, y en la dirección que no vuelve.
 *    Se NOMBRA y lo resuelve la migración de adopción, que es donde hay con qué buscarla.
 *
 * `total` ES EL DESEMBOLSO, NO EL COSTO ENTERO DE LA ORDEN. Desde `mantenimiento-06`, lo que se
 * pagó por otra vía —la hora del mecánico de planilla, el repuesto de almacén— viaja aparte en
 * `imputado` y va a su propia columna: `v_egresos` lee `mantenimiento.costo` y contar ahí un
 * sueldo que la planilla ya pagó sería el mismo sol dos veces. Omitirlo deja el comportamiento
 * anterior intacto, que es lo que hacen las órdenes sin líneas de costo.
 */
export function planDeSincronizacion(
  ot: EstadoOT, total: number, fila: FilaMantenimiento | null, imputado?: number
): PlanSincro {
  if (String(ot.estado || "").toLowerCase() !== "cerrada") {
    return {
      codigo: "sin_cierre", patch: {},
      detalle: "La orden sigue abierta: el costo se asienta en el libro de mantenimiento al cerrarla.",
    };
  }
  if (!ot.mantenimiento_id || !fila) {
    return {
      codigo: "sin_ancla", patch: {},
      detalle: "Esta orden se cerró antes de que existiera el vínculo con el libro de mantenimiento, " +
        "así que no se sabe cuál de sus filas le corresponde y no se toca ninguna. " +
        "Lo resuelve la migración `mantenimiento-05-costo-factura-cxp.sql`.",
    };
  }

  const patch: PlanSincro["patch"] = {};
  if (aCentimos(n(fila.costo)) !== aCentimos(total)) patch.costo = aCentimos(total);
  if (imputado !== undefined && aCentimos(n(fila.costo_imputado)) !== aCentimos(imputado)) {
    patch.costo_imputado = aCentimos(imputado);
  }
  if (ot.km_cierre != null && n(fila.kilometraje) !== n(ot.km_cierre)) patch.kilometraje = n(ot.km_cierre);
  if ((fila.documento_compra_id ?? null) !== (ot.documento_compra_id ?? null)) {
    patch.documento_compra_id = ot.documento_compra_id ?? null;
  }

  if (!Object.keys(patch).length) {
    return { codigo: "sin_cambio", patch: {}, detalle: "El libro de mantenimiento ya dice lo mismo." };
  }
  const partes: string[] = [];
  if (patch.costo !== undefined) partes.push(`costo S/ ${aCentimos(n(fila.costo)).toFixed(2)} → S/ ${patch.costo.toFixed(2)}`);
  if (patch.costo_imputado !== undefined) partes.push(`costo de casa S/ ${aCentimos(n(fila.costo_imputado)).toFixed(2)} → S/ ${patch.costo_imputado.toFixed(2)}`);
  if (patch.kilometraje !== undefined) partes.push(`km ${n(fila.kilometraje).toLocaleString("es-PE")} → ${patch.kilometraje.toLocaleString("es-PE")}`);
  if (patch.documento_compra_id !== undefined) partes.push(patch.documento_compra_id ? "se enlaza la factura" : "se suelta la factura");
  return { codigo: "actualiza", patch, detalle: partes.join(" · ") };
}

// ── La factura del taller ────────────────────────────────────────────────────

/**
 * LA LLAVE FISCAL DE UN COMPROBANTE, derivada en UN solo sitio.
 *
 * Es la del índice único de `documentos_compra` `(ruc_emisor, tipo_comprobante, serie, numero)`,
 * la misma con la que `conciliarFactura` (lib/contabilidad/factura-ia.ts) deduplica las facturas
 * que llegan por correo. Que las dos puertas deriven la clave por el mismo camino es lo único
 * que impide que la misma factura de taller entre dos veces: una por Contabilidad y otra desde
 * la OT. Devuelve null cuando falta alguna pieza — sin llave no se puede afirmar que sea nueva.
 */
export function llaveFiscal(f: {
  ruc_emisor?: string | null; tipo_comprobante?: string | null;
  serie?: string | null; numero?: string | null;
}): string | null {
  const ruc = (f.ruc_emisor || "").replace(/\D/g, "");
  const serie = (f.serie || "").trim().toUpperCase();
  const numero = (f.numero || "").trim().replace(/^0+/, "");
  if (!ruc || !serie || !numero) return null;
  return [ruc, (f.tipo_comprobante || "factura").trim().toLowerCase(), serie, numero].join("|");
}

export type CodigoCotejoFactura = "sin_factura" | "coincide" | "difiere_igv" | "discrepa";

export type CotejoFactura = { codigo: CodigoCotejoFactura; detalle: string; diferencia: number };

/** 18 %: la tasa vigente. El cotejo solo la usa para NOMBRAR una diferencia, nunca para calcular. */
const IGV = 0.18;
/** Un céntimo de holgura: los totales se redondean en dos sitios distintos. */
const HOLGURA = 0.02;

/**
 * EL IMPORTE DE LA FACTURA CONTRA EL COSTO DE LA ORDEN — se COTEJA, no se sobrescribe.
 *
 * Tener dos lecturas del mismo hecho y no cruzarlas es peor que tener una (la lección de
 * `esFalsaDiscrepancia` y del tipo de combustible), pero copiar el importe de la factura sobre el
 * costo de la orden sería peor todavía: el total de la factura lleva IGV y el S/km de la flota se
 * mediría 18 % por encima del real, subiendo el precio de cada cotización de esa categoría.
 *
 * Por eso la diferencia de ~18 % tiene su propio código en vez de salir como un desacuerdo
 * genérico: es el caso normal —factura con IGV contra costo sin IGV— y no hay nada que corregir.
 * Quien decide qué número queda es una persona, como en todo lo que mueve dinero aquí.
 */
export function cotejarFacturaConOT(total: number, importeFactura: number | null | undefined): CotejoFactura {
  if (importeFactura === null || importeFactura === undefined || !Number.isFinite(Number(importeFactura))) {
    return { codigo: "sin_factura", detalle: "", diferencia: 0 };
  }
  const f = aCentimos(n(importeFactura));
  const t = aCentimos(n(total));
  const dif = aCentimos(f - t);

  if (Math.abs(dif) <= HOLGURA) return { codigo: "coincide", detalle: "", diferencia: 0 };
  if (t > 0 && Math.abs(f - aCentimos(t * (1 + IGV))) <= Math.max(HOLGURA, t * 0.002)) {
    return {
      codigo: "difiere_igv", diferencia: dif,
      detalle: `El total de la factura (S/ ${f.toFixed(2)}) es el costo de la orden más el IGV. Es lo normal: el costo del taller se lleva SIN IGV, porque el IGV se recupera como crédito fiscal y meterlo subiría el S/km de toda la categoría un 18 %.`,
    };
  }
  return {
    codigo: "discrepa", diferencia: dif,
    detalle: `La factura dice S/ ${f.toFixed(2)} y la orden S/ ${t.toFixed(2)} — ${dif > 0 ? "S/ " + dif.toFixed(2) + " de más" : "S/ " + Math.abs(dif).toFixed(2) + " de menos"}. Revisa cuál de los dos está bien antes de cerrar: el de la orden es el que va al costo por kilómetro de la categoría.`,
  };
}

/**
 * El número de OT escrito dentro de `mantenimiento.descripcion` (`"OT #4 — CWZ-371"`).
 *
 * Existe SOLO para la adopción de las filas viejas y para poder probarla: es la identidad de
 * texto que nunca debió ser la única, y a partir de esta migración la verdad es el FK
 * `ordenes_trabajo.mantenimiento_id`. No se usa en ningún camino vivo.
 */
export function otEnDescripcion(descripcion: string | null | undefined): number | null {
  const m = /(?:^|\s)OT\s*#\s*(\d+)\b/i.exec(String(descripcion || ""));
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}
