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
//   • `no_es_de_factura`: la carga encontrada no la registró una factura (la registró el Radar o una
//     persona). Ahí sí es un duplicado de verdad, y descartar es lo correcto.
//   • `sin_fecha`: el voucher no tiene fecha; sin ella no hay nada que corregir.
//   • `fecha_lejana`: el voucher dice una fecha a más de MAX_DESFASE días de la carga. Un desfase de
//     facturación son uno o dos días; más es otra carga, o una fecha mal leída (el voucher de la
//     CTV-370 con el año 2025): mover el gasto ahí sería cambiarlo de mes —o de año— por un error.
//
// Idempotente: la marca MARCA_FUSION_VOUCHER no se escribe dos veces, y una carga ya fusionada con
// la misma fecha y el mismo km no cambia.
// ──────────────────────────────────────────────────────────────────────────────

import { MARCA_FUSION_VOUCHER, esCargaDeFactura, esCargaFusionada, TOLERANCIA_CANTIDAD, TOLERANCIA_MONTO } from "@/lib/combustible/factura-lineas";
import { MAX_DESFASE, diasEntre } from "@/lib/combustible/desfase-factura";

/** La carga que registró la factura, tal como está en `combustible`. */
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
};

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

export type CodigoFusion = "fusionable" | "no_es_de_factura" | "sin_fecha" | "fecha_lejana";

export type PlanFusion = {
  codigo: CodigoFusion;
  puede: boolean;
  /** Lo que se escribe en la carga. NUNCA galones, precio ni importe: los de la factura. */
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
  const vacio = { patch: {}, patchTanque: null, cambios: [], avisos: [], cruzaMes: false };
  if (!esCargaDeFactura(carga.observaciones)) {
    return {
      ...vacio, codigo: "no_es_de_factura", puede: false,
      detalle: `La carga #${carga.id} no la registró una factura: si es la misma recarga, es un duplicado de verdad — descarta esta fila.`,
    };
  }
  const fecha = v.fecha && /^\d{4}-\d{2}-\d{2}$/.test(v.fecha.slice(0, 10)) ? v.fecha.slice(0, 10) : null;
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

  const patch: Record<string, unknown> = {};
  const cambios: PlanFusion["cambios"] = [];
  const avisos: string[] = [];
  if (fecha !== carga.fecha.slice(0, 10)) {
    patch.fecha = fecha;
    cambios.push({ campo: "Fecha", de: `${F(carga.fecha)} (emisión de la factura)`, a: `${F(fecha)} (despacho, del voucher)` });
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
  // Galones, precio e importe: los de la factura. Si el voucher dice otra cosa, se dice.
  if (v.monto != null && carga.total != null && Math.abs(v.monto - Number(carga.total)) >= TOLERANCIA_MONTO) {
    avisos.push(`El voucher dice ${soles(v.monto)} y la factura ${soles(Number(carga.total))}: se queda el importe de la factura (es el comprobante legal).`);
  }
  if (v.cantidad != null && carga.galones != null && Math.abs(v.cantidad - Number(carga.galones)) > TOLERANCIA_CANTIDAD) {
    avisos.push(`El voucher dice ${v.cantidad} y la factura ${carga.galones}: se queda la cantidad de la factura.`);
  }
  // La marca, la nota de despacho (con ella la conciliación y el Radar la reconocen por nota) y por qué
  // cambió la fecha. Una carga con odómetro deja de decir «sin odómetro».
  const obs = String(carga.observaciones ?? "");
  if (!esCargaFusionada(obs)) {
    const base = kmNuevo != null ? obs.replace(/ · sin odómetro\b/, "") : obs;
    const partes = [`🔗 ${MARCA_FUSION_VOUCHER}`];
    if (v.comprobante && !obs.includes(v.comprobante)) partes.push(`Nota ${v.comprobante}`);
    if (patch.fecha) partes.push(`fecha del despacho del voucher (la factura dice ${F(carga.fecha)})`);
    patch.observaciones = [base, ...partes].filter(Boolean).join(" · ");
  } else if (kmNuevo != null && / · sin odómetro\b/.test(obs)) {
    patch.observaciones = obs.replace(/ · sin odómetro\b/, "");
  }
  const patchTanque = v.tanqueFuente && carga.tanque_lleno == null && v.tanqueLleno != null
    ? { tanque_lleno: v.tanqueLleno, tanque_lleno_fuente: v.tanqueFuente } : null;
  const cruzaMes = !!patch.fecha && fecha.slice(0, 7) !== carga.fecha.slice(0, 7);
  if (cruzaMes) avisos.push(`La carga pasa de ${F(carga.fecha)} a ${F(fecha)}: cambia de mes, y con ella el gasto de ese mes en Finanzas.`);

  const toma = cambios.map((c) => c.campo.toLowerCase());
  return {
    codigo: "fusionable", puede: true, patch, patchTanque, cambios, avisos, cruzaMes,
    detalle: `Es la misma recarga que la carga #${carga.id}, registrada desde la factura del correo. Al fusionar, esa carga ` +
      (toma.length ? `toma del voucher: ${toma.join(", ")}` : "queda enlazada a este voucher") +
      `; los galones, el precio y el importe siguen siendo los de la factura. No se crea ninguna carga nueva.`,
  };
}
