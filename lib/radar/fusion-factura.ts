// ──────────────────────────────────────────────────────────────────────────────
// lib/radar/fusion-factura.ts — Motor PURO: FUSIONAR el voucher que leyó el Radar con la carga que
// registró la FACTURA del correo. No lee la base.
//
// LO PIDIÓ EL DUEÑO, sobre una fila real: el Radar decía «esta carga ya entró DESDE LA FACTURA del
// correo (registro #61, S/ 47.31, fechado el 2026-09-23)… descarta esta fila». La carga es la misma
// —un despacho entrado por las dos puertas—, pero descartar el voucher TIRA justo lo que la factura
// no tiene: la factura sale con su fecha de EMISIÓN (al día siguiente, en el lote nocturno de
// COESTI) y sin odómetro; el voucher trae la fecha del DESPACHO (22/09 17:08), el kilometraje del
// tablero, el conductor y la nota de despacho. «No debería descartarla: debería fusionarla con la
// factura, considerando que la fecha de despacho es la que se lee ahí».
//
// LA FUSIÓN NO CREA NI MUEVE PLATA: actualiza la carga que ya existe (`combustible`), nunca inserta
// otra. De cada lado se toma lo que ese lado sabe mejor:
//   • de la FACTURA (el comprobante legal): galones, precio, importe, tipo y unidad. No se tocan; si el
//     voucher dice otra cosa, se AVISA.
//   • del VOUCHER (el papel del despacho): la FECHA —es la que imprime el grifo al despachar—, el
//     ODÓMETRO —que la factura nunca trae—, el conductor y la nota de despacho.
//   • lo que una persona ya escribió en la carga (un km tecleado, un conductor) no se pisa: se avisa.
//
// QUÉ NO SE FUSIONA, cada uno con su código:
//   • `sin_fecha`: el voucher no tiene fecha; sin ella no hay nada que corregir.
//   • `fecha_lejana`: el voucher dice una fecha a más de MAX_DESFASE días de la carga. Un desfase de
//     facturación son uno o dos días; más es otra carga, o una fecha mal leída (el voucher de la
//     CTV-370 con el año 2025): mover el gasto ahí sería cambiarlo de mes —o de año— por un error.
//
// Y LA OTRA MITAD, también pedida por el dueño sobre una fila real (CWZ-371, 14/08, S/ 224.08): el
// Radar marcó «posible duplicado» porque la carga #15 ya existía —la había registrado el PROPIO Radar
// de otro reporte, solo con la foto del voucher—, y la fila nueva traía cuatro fotos (el tablero con el
// odómetro, el surtidor y la nota). «En vez de solo descartarla, fusionar ambos, previa verificación
// manual del operador». Descartarla tiraba esa evidencia. Así que una carga que NO es de una factura sin
// voucher —la registró el Radar, la tecleó una persona, o es de una factura que ya se fusionó— también
// se fusiona, en el modo `sumar` (`sumable`), que es más estricto que el de la factura:
//   • esta fila queda ENLAZADA a la carga (`radar_combustible.combustible_id`): sus fotos pasan a ser
//     evidencia de esa carga en Combustible (`fotosPorCarga` ya junta las de todas sus filas);
//   • la carga toma solo lo que le FALTA: el odómetro si no tiene, el conductor, el grifo, el tanque;
//   • la FECHA no se mueve: ya es un dato (la leyó el Radar de un voucher, la tecleó una persona, o vino
//     de la fusión con su voucher). Si este voucher dice otra, se avisa — no es el desfase de una factura;
//   • la plata no se toca, como siempre; y dos notas de despacho distintas se AVISAN (suelen ser dos
//     despachos), sin bloquear: un dígito mal leído es la otra explicación, y decide quien mira las fotos.
// Descartar sigue existiendo: es lo que corresponde cuando la fila no aporta nada. El modo `sumar` NO
// escribe marca: lo que registra la fusión es el enlace de la fila con la carga.
//
// Idempotente: la marca MARCA_FUSION_VOUCHER no se escribe dos veces, y una carga ya fusionada con la
// misma fecha y el mismo km no cambia (al volver a fusionarla cae en `sumar`, que no tiene nada que hacer).
// ──────────────────────────────────────────────────────────────────────────────

import {
  MARCA_FUSION_VOUCHER, esCargaDeFactura, esCargaFusionada, esCargaCompletada, notasEnTexto, normNota,
  TOLERANCIA_CANTIDAD, TOLERANCIA_MONTO,
} from "@/lib/combustible/factura-lineas";
import { MAX_DESFASE, diasEntre, esCargaDelRadar } from "@/lib/combustible/desfase-factura";
import { buscarCargaRegistrada, comprobanteEnTexto, type CargaRegistrada, type CargaYaRegistrada } from "@/lib/radar/album-recargas";

/**
 * La carga de `combustible` con la que se fusiona: la que registró una factura, el Radar o una persona.
 * (El nombre viene de cuando solo se fusionaba con las de la factura.)
 */
export type CargaDeFactura = {
  id: number;
  fecha: string;
  total: number | null;
  galones: number | null;
  kilometraje: number | null;
  conductor: string | null;
  grifo: string | null;
  observaciones: string | null;
  tanque_lleno?: boolean | null;
  /** Las notas de despacho que ya se conocen de la carga por sus filas del Radar (las de su observación se leen solas). */
  notas?: (string | null)[] | null;
};

/**
 * Cómo se fusiona con una carga. `factura`: una carga de factura que todavía no tiene su voucher — toma
 * la FECHA del despacho del voucher. `sumar`: cualquier otra (del Radar, tecleada, o de factura ya
 * fusionada) — solo suma la evidencia y lo que le falta; su fecha ya es un dato.
 */
export type ModoFusion = "factura" | "sumar";
export const modoDeFusion = (observaciones: string | null | undefined): ModoFusion =>
  esCargaDeFactura(observaciones) && !esCargaFusionada(observaciones) ? "factura" : "sumar";

/** De dónde salió una carga, en palabras (para el modo `sumar`). */
const origenDeCarga = (obs: string | null | undefined): string =>
  esCargaDelRadar(obs) ? "que registró el Radar" : esCargaDeFactura(obs) ? "que entró desde la factura y ya tiene su voucher" : "registrada a mano";

/** Lo que el voucher dice (con lo que la persona corrigió en el panel de revisión). */
export type VoucherAFusionar = {
  fecha: string | null;
  kilometraje: number | null;
  conductor: string | null;
  grifo: string | null;
  comprobante: string | null;
  cantidad: number | null;
  monto: number | null;
  tanqueLleno?: boolean | null;
  tanqueFuente?: string | null;
};

export type CodigoFusion = "fusionable" | "sumable" | "sin_fecha" | "fecha_lejana";

export type PlanFusion = {
  codigo: CodigoFusion;
  puede: boolean;
  modo: ModoFusion;
  /** Lo que se escribe en la carga. NUNCA galones, precio ni importe: los de la factura (o de la carga). */
  patch: Record<string, unknown>;
  /** `tanque_lleno` es de una migración accesoria: escritura aparte y best-effort, como al registrar. */
  patchTanque: Record<string, unknown> | null;
  /** Para la pantalla: qué cambia, de qué a qué. */
  cambios: { campo: string; de: string; a: string }[];
  avisos: string[];
  /** La fecha pasa a otro mes: cambia el mes del gasto en Finanzas. */
  cruzaMes: boolean;
  detalle: string;
};

const F = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
const km = (n: number) => `${n.toLocaleString("es-PE")} km`;
const soles = (n: number) => `S/ ${n.toFixed(2)}`;

export function planDeFusion(carga: CargaDeFactura, v: VoucherAFusionar): PlanFusion {
  const modo = modoDeFusion(carga.observaciones);
  const vacio = { modo, patch: {}, patchTanque: null, cambios: [], avisos: [], cruzaMes: false };
  const fecha = v.fecha && /^\d{4}-\d{2}-\d{2}$/.test(v.fecha.slice(0, 10)) ? v.fecha.slice(0, 10) : null;
  const patch: Record<string, unknown> = {};
  const cambios: PlanFusion["cambios"] = [];
  const avisos: string[] = [];

  if (modo === "factura") {
    if (!fecha) {
      return { ...vacio, codigo: "sin_fecha", puede: false, detalle: "Pon la fecha del voucher antes de fusionar: es lo que la factura no trae." };
    }
    const dias = Math.abs(diasEntre(carga.fecha, fecha));
    if (!(dias <= MAX_DESFASE)) {
      return {
        ...vacio, codigo: "fecha_lejana", puede: false,
        detalle: `El voucher dice ${F(fecha)} y la carga de la factura ${F(carga.fecha)}: a ${dias} días no es el desfase de la factura. Revisa la fecha del voucher contra la foto antes de fusionar.`,
      };
    }
    // Una carga que una persona COMPLETÓ a mano (lib/combustible/completar-carga.ts) ya no lleva la fecha
    // deducida de la factura: lleva la que esa persona confirmó. El voucher manda igual —es el papel—,
    // pero el cambio se nombra como lo que es.
    const completada = esCargaCompletada(carga.observaciones);
    if (fecha !== carga.fecha.slice(0, 10)) {
      patch.fecha = fecha;
      cambios.push({ campo: "Fecha", de: `${F(carga.fecha)} (${completada ? "confirmada a mano" : "emisión de la factura"})`, a: `${F(fecha)} (despacho, del voucher)` });
      if (completada) avisos.push(`La fecha ${F(carga.fecha)} la confirmó una persona y el voucher dice ${F(fecha)}: mira la foto antes de fusionar.`);
    }
  } else if (fecha && fecha !== carga.fecha.slice(0, 10)) {
    // La fecha de esta carga ya es un DATO —la leyó el Radar de un voucher, la tecleó una persona, o vino
    // de la fusión con su voucher—: un segundo papel no la mueve. Que diga otra se dice: o es otro
    // despacho, o una de las dos lecturas está mal.
    avisos.push(`Este voucher dice ${F(fecha)} y la carga ${F(carga.fecha)}: la carga conserva su fecha. Si no es la misma recarga, no la fusiones.`);
  }
  const kmVoucher = v.kilometraje != null && v.kilometraje > 0 ? Math.round(v.kilometraje) : null;
  let kmNuevo: number | null = null;
  if (kmVoucher != null) {
    if (!carga.kilometraje || carga.kilometraje <= 0) {
      patch.kilometraje = kmVoucher;
      kmNuevo = kmVoucher;
      cambios.push({ campo: "Odómetro", de: "sin odómetro", a: km(kmVoucher) });
    } else if (carga.kilometraje !== kmVoucher) {
      avisos.push(`La carga ya tiene ${km(carga.kilometraje)} (alguien lo escribió): se deja. El voucher dice ${km(kmVoucher)}.`);
    }
  }
  if (v.conductor && !carga.conductor) {
    patch.conductor = v.conductor;
    cambios.push({ campo: "Conductor", de: "—", a: v.conductor });
  }
  if (v.grifo && !carga.grifo) {
    patch.grifo = v.grifo;
    cambios.push({ campo: "Grifo", de: "—", a: v.grifo });
  }
  // Galones, precio e importe: los de la factura (o los de la carga que ya existe). Si el voucher dice
  // otra cosa, se dice.
  const deQuien = modo === "factura" ? "la factura" : "la carga";
  if (v.monto != null && carga.total != null && Math.abs(v.monto - Number(carga.total)) >= TOLERANCIA_MONTO) {
    avisos.push(modo === "factura"
      ? `El voucher dice ${soles(v.monto)} y la factura ${soles(Number(carga.total))}: se queda el importe de la factura (es el comprobante legal).`
      : `Este voucher dice ${soles(v.monto)} y la carga ${soles(Number(carga.total))}: se queda el importe de la carga. Si no es la misma recarga, no la fusiones.`);
  }
  if (v.cantidad != null && carga.galones != null && Math.abs(v.cantidad - Number(carga.galones)) > TOLERANCIA_CANTIDAD) {
    // El mismo despacho tiene la misma cantidad en el voucher y en la factura. Con el mismo importe y
    // otra cantidad suelen ser DOS recargas (otro día, otro precio): se dice, y decide quien mira la foto.
    avisos.push(`El voucher dice ${v.cantidad} y ${deQuien} ${carga.galones}. Si es la misma recarga, se queda la cantidad de ${deQuien}; si son dos recargas distintas (mismo importe, otro precio), no la fusiones: regístrala aparte.`);
  }
  // Dos notas de despacho distintas suelen ser DOS despachos. No se bloquea —la otra explicación es un
  // dígito mal leído, y eso lo ve quien tiene las fotos delante—, pero se dice con todas las letras.
  const obs = String(carga.observaciones ?? "");
  // Se comparan normalizadas (sin ceros de relleno) y se NOMBRAN como están escritas, que es como las ve
  // quien tiene el papel delante.
  const notasCarga = new Map<string, string>();
  for (const n of [...notasEnTexto(obs), ...(carga.notas ?? [])]) {
    const k = normNota(n);
    if (k && !notasCarga.has(k)) notasCarga.set(k, String(n));
  }
  const notaVoucher = normNota(v.comprobante);
  if (notaVoucher && notasCarga.size && !notasCarga.has(notaVoucher)) {
    avisos.push(`La carga #${carga.id} es de la nota ${[...notasCarga.values()].join(", ")} y este voucher de la ${v.comprobante}: dos notas de despacho distintas suelen ser DOS despachos. Fusiónala solo si en las fotos es el mismo papel (un dígito mal leído); si no, regístrala aparte.`);
  }
  // La marca, la nota de despacho (con ella la conciliación y el Radar la reconocen por nota) y por qué
  // cambió la fecha. Una carga con odómetro deja de decir «sin odómetro».
  if (modo === "factura") {
    // (El modo `factura` es, por definición, una carga de factura que todavía no tiene la marca.)
    const base = kmNuevo != null ? obs.replace(/ · sin odómetro\b/, "") : obs;
    const partes = [`🔗 ${MARCA_FUSION_VOUCHER}`];
    if (v.comprobante && !obs.includes(v.comprobante)) partes.push(`Nota ${v.comprobante}`);
    if (patch.fecha) partes.push(`fecha del despacho del voucher (la factura dice ${F(carga.fecha)})`);
    patch.observaciones = [base, ...partes].filter(Boolean).join(" · ");
  } else {
    // SIN MARCA NUEVA: lo que registra la fusión es el ENLACE de la fila del Radar con la carga (de ahí
    // salen sus fotos en Combustible). Una marca escrita aquí se repetiría al fusionar dos veces —una
    // carga de factura ya fusionada cae en este modo— y diría «otro reporte» de uno que es el mismo. Solo
    // se agrega la nota del voucher si la carga no la tiene, para que el próximo reporte del mismo papel
    // la encuentre por su comprobante.
    const base = kmNuevo != null ? obs.replace(/ · sin odómetro\b/, "") : obs;
    const partes = v.comprobante && !comprobanteEnTexto(v.comprobante, obs) ? [`Nota ${v.comprobante}`] : [];
    if (partes.length || base !== obs) patch.observaciones = [base, ...partes].filter(Boolean).join(" · ");
  }
  const patchTanque = v.tanqueFuente && carga.tanque_lleno == null && v.tanqueLleno != null
    ? { tanque_lleno: v.tanqueLleno, tanque_lleno_fuente: v.tanqueFuente } : null;
  const cruzaMes = !!patch.fecha && !!fecha && fecha.slice(0, 7) !== carga.fecha.slice(0, 7);
  if (cruzaMes) avisos.push(`La carga pasa de ${F(carga.fecha)} a ${F(fecha)}: cambia de mes, y con ella el gasto de ese mes en Finanzas.`);

  const toma = cambios.map((c) => c.campo.toLowerCase());
  if (modo === "sumar") {
    return {
      codigo: "sumable", puede: true, modo, patch, patchTanque, cambios, avisos, cruzaMes,
      detalle: `Es la misma recarga que la carga #${carga.id}, ${origenDeCarga(obs)}. Al fusionar, esta fila queda enlazada a esa ` +
        `carga —sus fotos pasan a ser evidencia de ella en Combustible—` + (toma.length ? ` y la carga toma de este voucher: ${toma.join(", ")}` : "") +
        `. La fecha, los galones, el precio y el importe de la carga no cambian. No se crea ninguna carga nueva.`,
    };
  }
  return {
    codigo: "fusionable", puede: true, modo, patch, patchTanque, cambios, avisos, cruzaMes,
    detalle: `Es la misma recarga que la carga #${carga.id}, registrada desde la factura del correo. Al fusionar, esa carga ` +
      (toma.length ? `toma del voucher: ${toma.join(", ")}` : "queda enlazada a este voucher") +
      `; los galones, el precio y el importe siguen siendo los de la factura. No se crea ninguna carga nueva.`,
  };
}

// ── ¿Ya está en Combustible? Se pregunta al REVISAR, no solo al procesar ────────
//
// El Radar comprueba si la recarga ya está en `combustible` UNA vez: cuando procesa el mensaje
// (lib/radar/acciones.ts → `posible_duplicado`). Pero una recarga puede quedarse días «Por revisar»,
// y mientras tanto la FACTURA del correo puede registrar la misma carga: pasada la espera de un día,
// cuando la recarga del Radar no casa con su línea —un importe mal leído, una placa sin identificar,
// una fecha que no se leyó—. La fila del Radar no lo sabía, el recuadro de fusión no salía, y el
// botón «Registrar» insertaba sin mirar: el mismo despacho dos veces en `combustible`, en v_egresos,
// en el costo por km y en el saldo de la cuenta. Hacerlo «al revés» —las facturas antes que el
// Radar— lo volvía el caso normal.
//
// Por eso se vuelve a preguntar AL REVISAR (el recuadro de la fila) y AL REGISTRAR (el botón), con lo
// que la persona corrigió en el panel y con la MISMA regla del procesamiento (buscarCargaRegistrada):
// dos reglas para «es la misma carga» terminan contestando distinto.

export type CodigoYaEsta = "libre" | "fusionar" | "ya_registrada" | "sin_comprobar";

export type YaEstaEnCombustible = {
  codigo: CodigoYaEsta;
  /** La carga encontrada (fusionar · ya_registrada). */
  id: number | string | null;
  /** Por qué se la encontró: mismo comprobante, mismo día e importe, o la factura con un día de margen. */
  por: CargaYaRegistrada["por"] | null;
  /** Para la pantalla y para el confirm() de «Registrar»: nombra la carga y dice qué hacer. */
  detalle: string;
};

/**
 * Qué hacer con una recarga por revisar ANTES de registrarla:
 *   • `libre`         → no está en Combustible: se registra.
 *   • `fusionar`      → ya entró desde la FACTURA (y nadie la fusionó todavía): se fusiona, no se registra
 *                       otra. Registrarla aparte queda como decisión explícita, para cuando de verdad es
 *                       OTRA recarga (mismo importe, otro día).
 *   • `ya_registrada` → ya está, registrada por el Radar, a mano o fusionada con otro voucher: si es la
 *                       misma recarga, se descarta.
 *   • `sin_comprobar` → no se pudo leer Combustible. No se afirma que esté libre: se pregunta.
 *
 * `candidatas` en null = la consulta falló. Una lista vacía por error haría pasar por nueva una carga ya
 * registrada (mismo criterio que la conciliación de facturas y que la acción del Radar).
 */
export function yaEstaEnCombustible(
  voucher: { fecha: string | null; comprobante: string | null; monto: number | null },
  candidatas: CargaRegistrada[] | null,
  errorLectura?: string | null,
): YaEstaEnCombustible {
  if (candidatas == null) {
    return {
      codigo: "sin_comprobar", id: null, por: null,
      detalle: `No se pudo comprobar si esta recarga ya está en Combustible${errorLectura ? ` (${errorLectura})` : ""}. ` +
        `Si la factura del correo ya la registró, registrarla aquí contaría el mismo gasto dos veces.`,
    };
  }
  const hallada = buscarCargaRegistrada(voucher, candidatas);
  if (!hallada) return { codigo: "libre", id: null, por: null, detalle: "" };
  const carga = candidatas.find((x) => String(x.id) === String(hallada.id));
  const obs = carga?.observaciones ?? null;
  const cual = `la carga #${hallada.id}${carga?.fecha ? ` del ${F(carga.fecha)}` : ""}${carga?.total != null ? ` por ${soles(Number(carga.total))}` : ""}`;
  if (esCargaDeFactura(obs) && !esCargaFusionada(obs)) {
    return {
      codigo: "fusionar", id: hallada.id, por: hallada.por,
      detalle: `Esta recarga ya está en Combustible: es ${cual}, que entró desde la factura del correo. Lo correcto es ` +
        `FUSIONARLA (el recuadro de arriba, sobre los botones): esa carga toma de este voucher la fecha del despacho, el ` +
        `odómetro y el conductor, sin contar el gasto dos veces.`,
    };
  }
  const origen = esCargaFusionada(obs) ? "que entró desde la factura y ya se fusionó con otro voucher"
    : esCargaDelRadar(obs) ? "registrada por el Radar" : esCargaDeFactura(obs) ? "registrada desde la factura" : "registrada a mano";
  // Antes decía «DESCARTA esta fila», y descartar tiraba las fotos que la carga no tiene (el tablero, el
  // surtidor). Ahora se FUSIONA en el modo `sumar` (planDeFusion): la carga se queda con esta evidencia.
  return {
    codigo: "ya_registrada", id: hallada.id, por: hallada.por,
    detalle: `Esta recarga ya parece estar en Combustible: ${cual}, ${origen}` +
      `${hallada.por === "comprobante" ? ", con el mismo comprobante" : ""}. Si es la misma recarga, FUSIÓNALA (el recuadro de arriba, ` +
      `sobre los botones): esa carga se queda con las fotos de esta fila y con lo que le falte, sin contar el gasto dos veces. ` +
      `Registrarla aparte contaría el mismo gasto dos veces.`,
  };
}

/** El confirm() de «Registrar» cuando la recarga no está libre. null = se registra sin preguntar. */
export function preguntaAntesDeRegistrar(v: YaEstaEnCombustible): string | null {
  if (v.codigo === "libre") return null;
  if (v.codigo === "fusionar") return `${v.detalle}\n\n¿Registrarla APARTE de todos modos? Hazlo solo si de verdad es OTRA recarga.`;
  if (v.codigo === "ya_registrada") return `${v.detalle}\n\n¿Registrarla igual, porque es otra recarga?`;
  return `${v.detalle}\n\n¿Registrar igual?`;
}
