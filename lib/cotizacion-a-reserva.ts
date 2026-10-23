// ══════════════════════════════════════════════════════════════════════════════
// lib/cotizacion-a-reserva.ts — EL PLAN de «→ Res.»: qué filas de `reservas` y `paradas` nacen de
// una cotización aprobada, y qué se le dice a quien la convierte. Motor PURO (no lee la base).
//
// Es `convertirAReserva` de app/cotizaciones/page.tsx EXTRAÍDA, no reescrita: la matriz
// (scripts/prueba-cotizacion-a-reserva.mts) corre el algoritmo viejo copiado literal y un ejecutor
// del plan sobre la misma base falsa y exige las MISMAS escrituras, en el mismo orden, y los mismos
// mensajes. La necesitan dos llamadores: la página (el botón) y la reserva de traslados que confirma
// un ejecutivo desde el CRM («Hay unidad»), que crea la ida y el retorno sin pasar por el navegador.
//
// Lo que decide el plan y no el ejecutor:
//  · si se puede convertir (solo `aprobado`), si ya se convirtió (alguna ida enlazada o cancelada,
//    o un retorno que apunta a alguna ida) y si falta completar SOLO el retorno;
//  · las filas: la ida (una, o una por vehículo de los ítems, con el importe de su grupo) con
//    «Permitir autoselección» al nacer (`AUTOSELECCION_AL_NACER`); los paraderos de la ida (en la
//    primera ida, como siempre); el retorno de cada ida (`planRetorno`: S/ 0.00, enlazado por los dos
//    lados) y sus paraderos;
//  · los textos de los avisos, byte a byte los de la página.
// Lo que hace el ejecutor: leer lo que ya existe (y, si el plan lo pide, si hay un retorno que
// apunta a las idas), insertar con `insertarServicioNuevo` (suelta la casilla SOLO si el error la
// nombra), soltar `direccion_servicio` SOLO si el error la nombra, y mostrar los avisos.
// ══════════════════════════════════════════════════════════════════════════════

import { planRetorno, type CotParaRetorno, type PlanRetorno } from "./cotizacion-retorno";
import { sugerirNombreRuta } from "./nombre-ruta";
import { AUTOSELECCION_AL_NACER } from "./reservas-autoseleccion";
import { aMonedaCot, normalizarMoneda, revisarTipoCambio, totalesEnMoneda, type Moneda } from "./cotizacion-moneda";

export type ItemCotReserva = {
  descripcion?: string; dias: number; cantidad: number; precio_unit: number; descuento_pct: number;
  vehiculo_flota_id?: number | null; vehiculo_tercero_id?: number | null;
};
export type ParadaCotReserva = { id?: string; tipo: string; nombre: string; direccion?: string | null; lat?: string | number | null; lng?: string | number | null; hora?: string | null };

/** Lo que el plan lee de la cotización (los nombres de columna de `cotizaciones`). */
export type CotParaReserva = CotParaRetorno & {
  id: number;
  estado: string | null;
  cliente_id: number | null;
  numero_cotizacion?: string | null;
  origen: string;
  destino: string;
  fecha_servicio: string | null;
  hora_ida: string | null;
  tipo_servicio: string | null;
  asunto: string | null;
  paradas_json: ParadaCotReserva[] | null;
  items_json: ItemCotReserva[] | null;
  incluye_igv: boolean | null;
  precio_cliente: number | null;
  vehiculo_flota_id: number | null;
  vehiculo_tercero_id: number | null;
  moneda?: string | null;
  tipo_cambio?: number | string | null;
};

/** Una reserva que ya existe con `cotizacion_id` = la cotización (`limit(20)`, como la página). */
export type ReservaExistente = { id: number; fecha_servicio: string | null; vehiculo_id: number | null; vehiculo_tercero_id: number | null; reserva_vinculada_id: number | null; estado: string | null };

/** La ida a la que se le crea el retorno. */
export type IdaDelRetorno = { id: number; vehiculo_id: number | null; vehiculo_tercero_id: number | null };

type PlanRetornoOk = Extract<PlanRetorno, { codigo: "ok" }>;

export type FilaIda = { fila: Record<string, unknown>; conParadas: boolean };

export type PlanConversion =
  | { codigo: "no_aprobada"; mensaje: string }
  /** Aprobada: el ejecutor lee las reservas que ya tiene (`cotizacion_id`, limit 20) y vuelve a llamar. */
  | { codigo: "leer_existentes" }
  | { codigo: "ya_convertida"; mensaje: string }
  /** Hay idas sin enlace: el ejecutor tiene que mirar si alguna reserva apunta a ellas (`reserva_vinculada_id in ids`, limit 1) y volver a llamar con `retornoAtras`. */
  | { codigo: "comprobar_retorno"; ids: number[] }
  | { codigo: "retorno_imposible"; mensaje: string }
  | { codigo: "completar_retorno"; confirmar: string; idas: ReservaExistente[]; retorno: PlanRetornoOk }
  | {
    codigo: "crear";
    /** Con dólares, lo que se le pregunta antes de crear (la página usa `confirm`); null en soles. */
    confirmar: string | null;
    idas: FilaIda[];
    /** Los paraderos de la ida, sin `reserva_id` (`paradasDeIda` los arma con el id). */
    paradas: ParadaCotReserva[];
    retorno: PlanRetorno;
    notaTc: string;
    multi: boolean;
  };

// ── Los textos (byte a byte los de la página) ────────────────────────────────

export const MENSAJE_NO_APROBADA = "Solo cotizaciones aprobadas";
export const MENSAJE_YA_CONVERTIDA = "Ya fue convertida en reserva";

/** Copiados de app/cotizaciones/page.tsx (fmtS / fmtM / fmtCot): los avisos dicen lo mismo. */
const fmtS = (n: number) => `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtM = (n: number, m: Moneda) => (m === "USD" ? `US$ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : fmtS(n));
const fmtCot = (pen: number, m: Moneda, tc: unknown) => { const v = aMonedaCot(pen, m, tc); return v == null ? fmtS(pen) : fmtM(v, m); };
const fechaDdMmAaaa = (f: string) => f.split("-").reverse().join("/");
const numCot = (c: Pick<CotParaReserva, "id" | "numero_cotizacion">) => c.numero_cotizacion || c.id;

export const mensajeErrorComprobar = (msg: string) => `No se pudo comprobar si la cotización ya tiene reservas, así que no se creó ninguna: ${msg}`;
export const mensajeErrorRetornoAtras = (msg: string) => `No se pudo comprobar si ya tiene retorno, así que no se creó nada: ${msg}`;

/** El aviso del retorno al final de la creación (o del completado). `errores`: lo que devolvió cada retorno (null = salió). */
export function textoRetorno(planRet: PlanRetorno, errores: (string | null)[], n: number): string {
  if (planRet.codigo === "no_aplica") return "";
  if (planRet.codigo !== "ok") return `\n⚠️ No se creó el RETORNO: ${planRet.motivo} Créalo desde Programación.`;
  const e = errores.filter(Boolean);
  return e.length ? `\n⚠️ Retorno: ${e.join(" · ")}` : `\n↩ Y ${n > 1 ? `${n} retornos` : "su retorno"} del ${fechaDdMmAaaa(planRet.fecha)} a las ${planRet.hora} (${planRet.origen} → ${planRet.destino}), en S/ 0.00: el importe va en la ida.`;
}

export const avisoParadas = (nParadas: number, e: string | null) => (e ? `\n⚠️ Pero sus ${nParadas} paradas no se pudieron crear (${e}): agrégalas desde Programación.` : "");

/** El resultado de crear un retorno: null si salió entero, o el motivo. */
export function resultadoRetorno(x: { insertError: string | null; enlaceError: string | null; paradasError: string | null }): string | null {
  if (x.insertError) return x.insertError;
  const avisos = [x.enlaceError ? `no se pudo enlazar a la ida (${x.enlaceError}): enlázalos desde Liquidaciones o Programación` : "", x.paradasError ? `sus paradas no se crearon (${x.paradasError})` : ""].filter(Boolean);
  return avisos.length ? `retorno creado, pero ${avisos.join(" y ")}` : null;
}

export const alertaRetornoCompletado = (planRet: PlanRetorno, errs: (string | null)[], n: number) => `✅ Retorno completado${textoRetorno(planRet, errs, n)}`;

export function alertaCreadaUna(x: { nParadas: number; eParadas: string | null; eRet: string | null; retorno: PlanRetorno; notaTc: string }): string {
  return `✅ Reserva creada${x.nParadas > 0 && !x.eParadas ? ` con ${x.nParadas} paradas` : ""}${avisoParadas(x.nParadas, x.eParadas)}${textoRetorno(x.retorno, [x.eRet], 1)}${x.notaTc}`;
}

/**
 * DIVERGENCIA DECLARADA con el código que vivía en /cotizaciones: con un solo vehículo asignado en
 * los ítems decía «✅ 1 reservacreada» (faltaba el espacio). Ahora «✅ 1 reserva creada»; la matriz
 * normaliza ese texto del viejo y exige que el caso exista.
 */
export function alertaCreadasMulti(x: { count: number; nParadas: number; eParadas: string | null; errsRet: (string | null)[]; retorno: PlanRetorno; notaTc: string }): string {
  return `✅ ${x.count} reserva${x.count > 1 ? "s creadas (una por vehículo)" : " creada"}${avisoParadas(x.nParadas, x.eParadas)}${textoRetorno(x.retorno, x.errsRet, x.count)}${x.notaTc}`;
}

/** Falló una ida del lote: las ya creadas se quedan (la cotización ya figura como convertida). */
export function alertaFalloMulti(x: { count: number; total: number; error: string; nParadas: number; eParadas: string | null }): string {
  return x.count > 0
    ? `⚠️ Se crearon ${x.count} de ${x.total} reservas y la siguiente falló: ${x.error}\nLas que faltan créalas desde Programación (esta cotización ya figura como convertida).${avisoParadas(x.nParadas, x.eParadas)}`
    : x.error;
}

// ── Las filas ────────────────────────────────────────────────────────────────

/** La fila del retorno de UNA ida (S/ 0.00, con el vehículo de su ida, apuntando a ella). */
export function filaRetorno(cot: CotParaReserva, planRet: PlanRetornoOk, ida: IdaDelRetorno): Record<string, unknown> {
  const paradasSemilla = planRet.paradas.map((p, i, a) => ({ id: `ret${i}`, tipo: i === 0 ? "inicio" : i === a.length - 1 ? "destino" : "intermedia", nombre: p.nombre, direccion: p.direccion || "", lat: p.lat != null ? String(p.lat) : "", lng: p.lng != null ? String(p.lng) : "", hora: p.hora || "" }));
  return {
    cliente_id: cot.cliente_id, cotizacion_id: cot.id, origen: planRet.origen, destino: planRet.destino, fecha_servicio: planRet.fecha, hora_servicio: planRet.hora,
    estado: "pendiente", tipo: "propia", tipo_servicio_detalle: cot.tipo_servicio || null, paradas_json: paradasSemilla, costo_proveedor: 0, precio_cliente: 0,
    vehiculo_id: ida.vehiculo_id, vehiculo_tercero_id: ida.vehiculo_tercero_id, reserva_vinculada_id: ida.id, direccion_servicio: "retorno",
    ruta_nombre: sugerirNombreRuta({ asunto: cot.asunto, paradas: paradasSemilla, hora: planRet.hora, sentido: "retorno" }) || null,
    permite_autoseleccion: AUTOSELECCION_AL_NACER,
  };
}

/** Lo que se le escribe a la ida para enlazarla con su retorno (sin `direccion_servicio` si la base no la tiene). */
export const enlaceIda = (retornoId: number, conDireccion = true): Record<string, unknown> =>
  conDireccion ? { reserva_vinculada_id: retornoId, direccion_servicio: "ida" } : { reserva_vinculada_id: retornoId };

/** Los paraderos del retorno. */
export function paradasDeRetorno(planRet: PlanRetornoOk, retornoId: number): Record<string, unknown>[] {
  return planRet.paradas.map((p) => ({ reserva_id: retornoId, orden: p.orden, nombre: p.nombre, direccion: p.direccion, lat: p.lat, lng: p.lng, hora_estimada: p.hora, estado: "pendiente" }));
}

/** Los paraderos de la ida: inicio, intermedias y destino, en ese orden. Vacío si la cotización no tiene. */
export function paradasDeIda(ps: readonly ParadaCotReserva[], reservaId: number): Record<string, unknown>[] {
  if (ps.length < 1) return [];
  return [...ps.filter((p) => p.tipo === "inicio"), ...ps.filter((p) => p.tipo === "intermedia"), ...ps.filter((p) => p.tipo === "destino")]
    .map((p, i) => ({ reserva_id: reservaId, orden: i + 1, nombre: p.nombre, direccion: p.direccion || null, lat: p.lat ? Number(p.lat) : null, lng: p.lng ? Number(p.lng) : null, hora_estimada: p.hora || null, estado: "pendiente" }));
}

/**
 * EL PLAN, por fases (el ejecutor lee lo que el plan le pide y vuelve a llamar):
 *  · `existentes` null → `leer_existentes` (o `no_aprobada`, antes de leer nada);
 *  · `existentes` es la lectura de las reservas con esta cotización (si falló, el ejecutor dice
 *    `mensajeErrorComprobar` y no crea nada);
 *  · `retornoAtras`: si alguna reserva apunta a esas idas (solo cuando el plan pidió
 *    `comprobar_retorno`; si esa lectura falló, `mensajeErrorRetornoAtras`).
 * `hoy` es la fecha de Lima (la de la ida si la cotización no tiene).
 */
export function planConversion(
  cot: CotParaReserva,
  x: { existentes: readonly ReservaExistente[] | null; hoy: string; retornoAtras?: boolean },
): PlanConversion {
  if (cot.estado !== "aprobado") return { codigo: "no_aprobada", mensaje: MENSAJE_NO_APROBADA };
  if (x.existentes == null) return { codigo: "leer_existentes" };
  const ps = cot.paradas_json || [];
  const pI = ps.find((p) => p.tipo === "inicio");
  const fechaIda = cot.fecha_servicio || x.hoy;
  const planRet = planRetorno(cot, fechaIda);

  if (x.existentes?.length) {
    const idas = [...x.existentes];
    if (planRet.codigo === "no_aplica" || idas.some((r) => r.reserva_vinculada_id != null || r.estado === "cancelada")) return { codigo: "ya_convertida", mensaje: MENSAJE_YA_CONVERTIDA };
    if (x.retornoAtras === undefined) return { codigo: "comprobar_retorno", ids: idas.map((r) => r.id) };
    if (x.retornoAtras) return { codigo: "ya_convertida", mensaje: MENSAJE_YA_CONVERTIDA };
    if (planRet.codigo !== "ok") return { codigo: "retorno_imposible", mensaje: `Ya fue convertida en reserva, pero le falta el RETORNO y no se puede crear: ${planRet.motivo} Créalo desde Programación.` };
    const confirmar = `La cotización #${numCot(cot)} ya tiene ${idas.length} reserva(s) de IDA, pero no su RETORNO.\n¿Crear ${idas.length > 1 ? `${idas.length} retornos` : "el retorno"}: ${fechaDdMmAaaa(planRet.fecha)} ${planRet.hora} · ${planRet.origen} → ${planRet.destino}, en S/ 0.00 (el importe sigue en la ida)?`;
    return { codigo: "completar_retorno", confirmar, idas, retorno: planRet };
  }

  const its = cot.items_json || [];
  const vehKey = (it: ItemCotReserva) => (it.vehiculo_flota_id ? `f_${it.vehiculo_flota_id}` : it.vehiculo_tercero_id ? `t_${it.vehiculo_tercero_id}` : "sin");
  const grupos = its.reduce((m, it) => { const k = vehKey(it); if (!m[k]) m[k] = []; m[k].push(it); return m; }, {} as Record<string, ItemCotReserva[]>);
  const keys = Object.keys(grupos);
  const useMulti = keys.length > 1 || (keys.length === 1 && keys[0] !== "sin" && (keys[0].startsWith("f_") || keys[0].startsWith("t_")));
  const basePayload = {
    cliente_id: cot.cliente_id, cotizacion_id: cot.id, origen: pI?.nombre || cot.origen, destino: cot.destino, fecha_servicio: fechaIda,
    hora_servicio: pI?.hora || cot.hora_ida || "06:00", estado: "pendiente", tipo: "propia", tipo_servicio_detalle: cot.tipo_servicio || null,
    paradas_json: cot.paradas_json || null, costo_proveedor: 0,
    ruta_nombre: sugerirNombreRuta({ asunto: cot.asunto, paradas: cot.paradas_json, hora: pI?.hora || cot.hora_ida, sentido: "ida" }) || null,
  };
  const monCot = normalizarMoneda(cot.moneda);
  const tcTxt = revisarTipoCambio(cot.tipo_cambio).tc ?? "—";
  const confirmar = monCot === "USD"
    ? `La cotización #${numCot(cot)} está en dólares (${fmtCot(Number(cot.precio_cliente || 0), "USD", cot.tipo_cambio)}).\nLa reserva se crea con el precio EN SOLES: ${fmtS(Number(cot.precio_cliente || 0))} al tipo de cambio de la cotización (S/ ${tcTxt} por US$).\n¿Crear la reserva?`
    : null;
  const notaTc = monCot === "USD" ? `\nℹ️ La cotización está en dólares: la reserva queda con el precio EN SOLES al tipo de cambio de la cotización (S/ ${tcTxt} por US$).` : "";

  const conCasilla = (f: Record<string, unknown>) => ({ ...f, permite_autoseleccion: AUTOSELECCION_AL_NACER });
  let idas: FilaIda[];
  if (!useMulti) {
    idas = [{ fila: conCasilla({ ...basePayload, precio_cliente: cot.precio_cliente, vehiculo_id: cot.vehiculo_flota_id || null, vehiculo_tercero_id: cot.vehiculo_tercero_id || null }), conParadas: true }];
  } else {
    idas = keys.map((k, i) => {
      const gTotal = totalesEnMoneda(grupos[k], "PEN", null, cot.incluye_igv !== false)!.total;
      const vehFlotaId = k.startsWith("f_") ? Number(k.slice(2)) : k === "sin" ? cot.vehiculo_flota_id || null : null;
      const vehTercId = k.startsWith("t_") ? Number(k.slice(2)) : k === "sin" ? cot.vehiculo_tercero_id || null : null;
      return { fila: conCasilla({ ...basePayload, precio_cliente: gTotal, vehiculo_id: vehFlotaId, vehiculo_tercero_id: vehTercId }), conParadas: i === 0 };
    });
  }
  return { codigo: "crear", confirmar, idas, paradas: [...ps], retorno: planRet, notaTc, multi: useMulti };
}
