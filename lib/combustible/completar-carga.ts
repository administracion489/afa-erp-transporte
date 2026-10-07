// ──────────────────────────────────────────────────────────────────────────────
// lib/combustible/completar-carga.ts — Motor PURO: las cargas que registró la FACTURA del correo sin
// que el Radar leyera su voucher, y cómo las COMPLETA una persona. No lee la base.
//
// LO PLANTEÓ EL DUEÑO: «¿qué pasa cuando el Radar IA falla —es Baileys, WhatsApp puede eliminar esa
// línea, o se queda sin saldo de API para leer—? La factura registrará el combustible al día
// siguiente, y el operador deberá registrar a mano el odómetro y reconfirmar la fecha de despacho
// que inicialmente consideramos un día antes de la emisión de la factura. Para que no se escape
// ninguna.»
//
// EL HUECO QUE CIERRA: la factura es el respaldo del Radar y registra sola lo que el Radar no
// capturó, pero esa carga entra con DOS datos que no son de nadie: `kilometraje 0` (la factura no
// trae odómetro) y una fecha DEDUCIDA de la emisión (el desfase medido de la cuenta). Hasta ahora
// quedaba así para siempre y nada lo pedía: el tramo siguiente de la unidad salía `eslabon_saltado`
// —sin rendimiento—, el km vigente y el vencimiento de mantenimiento no avanzaban, y la fecha se
// quedaba en una deducción. Esto es la COLA de esas cargas y el plan para completarlas.
//
// QUÉ ENTRA EN LA COLA, y nada más (`colaPorCompletar`):
//   • la registró una factura (MARCA_CARGA_DE_FACTURA), nadie la FUSIONÓ con su voucher (el Radar,
//     si vuelve y lo lee, la completa mejor: trae el km del tablero) y nadie la COMPLETÓ;
//   • y le falta algo: el odómetro, o una fecha que no sea deducida. Una fecha que trae la propia
//     línea de la factura, o que eligió una persona al confirmarla, no se vuelve a pedir.
//   • Se pide lo de los últimos DIAS_REGISTRO_AUTOMATICO días —lo que el ERP registra solo—. Lo más
//     viejo NO desaparece: se cuenta aparte (`antiguas`), porque son las del historial que una
//     persona registró de golpe sabiendo que entraban sin odómetro, y pedirle a alguien el km de un
//     despacho de hace cinco meses es pedirle que lo invente.
//
// CÓMO SE COMPLETA (`planDeCompletar`), con la misma regla que la FUSIÓN con el voucher:
//   • NO TOCA LA PLATA: galones, precio, importe y tipo son los de la factura.
//   • El ODÓMETRO va a la carga y, por separado, a `lecturas_odometro` por `registrarLectura` —la misma
//     puerta que el resto del ERP, con su anti-retroceso—: quien llama lo registra con `lectura`.
//     También se puede declarar que NO HAY odómetro (voucher perdido): la carga sale de la cola sin
//     inventar un número, y el rendimiento sigue sabiendo que ese tramo no se puede medir.
//   • La FECHA se confirma o se corrige. Lo imposible se BLOQUEA: posterior a la emisión de su factura
//     (nadie factura un despacho que no ocurrió) o posterior a hoy. Lo raro se PREGUNTA: más de
//     MAX_DESFASE días antes de la emisión (más que el desfase de facturación), o un cambio de mes
//     (mueve el gasto de mes en Finanzas).
//   • Lo que una persona ya escribió en la carga (un km, un conductor) no se pisa en silencio.
//   • Queda la marca MARCA_COMPLETADA_A_MANO: «Moverlas a la fecha del despacho» no vuelve a correr
//     esa fecha (cargasPorMover), y el Radar, si después lee el voucher, todavía la reconoce para
//     fusionarla (sigue siendo una carga de factura).
//
// EL RANGO DEL DÍA (`rangoKmDelDia`): una carga sin hora puede haber sido a cualquier hora de su día,
// así que lo único que la acota son la última lectura ANTERIOR a ese día y la primera POSTERIOR (con
// la hora del voucher, también las de ese día). Se ENSEÑA como referencia y avisa si el km tecleado se
// sale; nunca se ofrece «usar este» —copiar el km del check-out sería fabricar una lectura que nadie
// tomó—, y no bloquea: `registrarLectura` juzga igual y deja la lectura por revisar si no cuadra.
// ──────────────────────────────────────────────────────────────────────────────

import {
  DIAS_REGISTRO_AUTOMATICO, MARCA_COMPLETADA_A_MANO,
  esCargaDeFactura, esCargaFusionada, esCargaCompletada, referenciaEnObservacion,
} from "@/lib/combustible/factura-lineas";
import {
  MAX_DESFASE, diasEntre, sumarDias, origenFechaLinea, generadaDespues,
  type OrigenFecha,
} from "@/lib/combustible/desfase-factura";
import { toleranciaRetroceso } from "@/lib/odometro";
import { instanteLectura, normalizarHoraVoucher } from "@/lib/odometro-tiempo";

const F = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
const fmtKm = (n: number) => `${Math.round(n).toLocaleString("es-PE")} km`;
const esISO = (f: string | null | undefined): f is string =>
  !!f && /^\d{4}-\d{2}-\d{2}$/.test(f) && Number.isFinite(Date.parse(`${f}T12:00:00Z`)) &&
  new Date(`${f}T12:00:00Z`).toISOString().slice(0, 10) === f;

// ── La carga y su factura ─────────────────────────────────────────────────────

/** Una carga de `combustible`, con lo que hace falta para decidir si falta completarla. */
export type CargaDeFacturaBD = {
  id: number;
  fecha: string;
  kilometraje: number | null;
  total: number | null;
  galones: number | null;
  unidad?: string | null;
  tipo_combustible?: string | null;
  conductor?: string | null;
  observaciones: string | null;
  placa: string | null;
  /** A qué tabla y fila apunta (vehiculo_id xor vehiculo_tercero_id). null = sin unidad. */
  vehiculo: { flota: "propia" | "tercero"; id: number } | null;
};

/** Lo que la FACTURA sabe de esa carga: su línea y la conciliación que la registró. */
export type OrigenDeCarga = {
  factura_id: number;
  comprobante: string;
  fecha_emision: string | null;
  /** De dónde salió la fecha con que se registró la carga (la conciliación lo dejó escrito). */
  fecha_origen: OrigenFecha | null;
  /** Cuántos días se corrió de la emisión al despacho (el desfase de la cuenta). */
  dias_corridos: number;
  nota_despacho: string | null;
  /** Cierre de mes: la factura se generó después de su fecha y puede juntar varios días. */
  generada_despues: boolean;
};

/** Una factura guardada (radar_facturas) con lo que se lee de ella: sus líneas y su conciliación. */
export type FacturaConCargas = {
  factura_id: number;
  serie: string | null;
  numero: string | null;
  fecha_emision: string | null;
  recibido_en?: string | null;
  lineas: { n: number; fecha?: string | null; fecha_origen?: OrigenFecha | null; tipo_combustible?: string | null; nota_despacho?: string | null }[];
  conciliacion: {
    n: number; codigo?: string; combustible_id?: number | string | null; casa_con?: number | string | null;
    fecha_origen?: OrigenFecha | null; desfase?: { emision: string; dias: number } | null;
  }[];
};

/**
 * Qué factura registró cada carga, y cómo se fechó. La carga es la de la línea que quedó `registrar`
 * (con su `combustible_id`) o `ya_registrada` (en una pasada posterior la misma línea se reconoce como
 * enlazada a la carga que esa factura creó): el mismo id que lee `cargasPorMover`. La primera factura
 * que nombra a una carga gana; el origen de la fecha sale del plan y, en las líneas leídas antes de
 * que existiera, con la MISMA condición con que se escribió (`origenFechaLinea`).
 */
export function origenesDeCargas(facturas: readonly FacturaConCargas[]): Map<number, OrigenDeCarga> {
  const out = new Map<number, OrigenDeCarga>();
  for (const f of facturas ?? []) {
    const lineas = Array.isArray(f.lineas) ? f.lineas : [];
    const conc = Array.isArray(f.conciliacion) ? f.conciliacion : [];
    const nComb = lineas.filter((l) => l.tipo_combustible).length;
    for (const c of conc) {
      const id = Number(c.codigo === "registrar" ? c.combustible_id : c.codigo === "ya_registrada" ? c.casa_con : NaN);
      if (!Number.isFinite(id) || out.has(id)) continue;
      const l = lineas.find((x) => x.n === c.n);
      const emision = f.fecha_emision ? String(f.fecha_emision).slice(0, 10) : null;
      out.set(id, {
        factura_id: Number(f.factura_id),
        comprobante: `${f.serie ?? ""}-${f.numero ?? ""}`,
        fecha_emision: emision,
        fecha_origen: c.fecha_origen ?? (l ? origenFechaLinea(l, emision, nComb) : null),
        dias_corridos: c.desfase && Number.isFinite(Number(c.desfase.dias)) ? Number(c.desfase.dias) : 0,
        nota_despacho: l?.nota_despacho ?? null,
        generada_despues: generadaDespues(emision, f.recibido_en ?? null),
      });
    }
  }
  return out;
}

// ── La cola ──────────────────────────────────────────────────────────────────

export type CargaPorCompletar = {
  carga: CargaDeFacturaBD;
  origen: OrigenDeCarga | null;
  /** Sin odómetro (0 y null son lo mismo, como en todo el ERP). */
  falta_km: boolean;
  /** La fecha se DEDUJO de la factura (o no se sabe de dónde salió): hay que confirmarla. */
  falta_fecha: boolean;
  /** Por qué la carga tiene la fecha que tiene, en una frase. */
  por_que_fecha: string;
  /** El comprobante y la nota de despacho, para buscar el voucher en el grupo de WhatsApp. */
  comprobante: string | null;
  nota_despacho: string | null;
};

export type ColaCompletar = {
  /** Las de los últimos `dias` días: las que se piden. Del despacho más viejo al más nuevo. */
  cola: CargaPorCompletar[];
  /** Las más viejas, igual de incompletas: se cuentan y se pueden ver, pero no se piden. */
  antiguas: CargaPorCompletar[];
};

/** ¿La fecha con que se registró es un DATO (la trae la línea, la eligió una persona) o una deducción? */
export const fechaEsDato = (o: OrigenFecha | null | undefined): boolean => o === "linea" || o === "manual";

/** La frase que explica de dónde salió la fecha de la carga. */
export function porQueFecha(carga: { fecha: string }, origen: OrigenDeCarga | null): string {
  if (!origen) return "No se encontró la factura que la registró: confirma la fecha contra el voucher.";
  const em = origen.fecha_emision;
  switch (origen.fecha_origen) {
    case "linea": return "La fecha la trae la línea de la factura.";
    case "manual": return "La fecha la eligió una persona al confirmar la línea de la factura.";
    case "consolidada":
      return `La factura junta varias cargas y no trae la fecha de cada una: se tomó ${F(carga.fecha)} por lo medido en esta cuenta${em ? ` (emitida el ${F(em)})` : ""}.`;
    case "emision": {
      // Lo que la carga dice HOY contra la emisión, no lo que dejó escrito la conciliación: «Moverlas a
      // la fecha del despacho» pudo correrla después, y la frase tiene que describir la fecha que se ve.
      const d = em ? diasEntre(carga.fecha.slice(0, 10), em) : Number.NaN;
      // Solo una diferencia que cabe en un desfase de facturación se explica como desfase; más que eso
      // (o hacia adelante) la puso alguien, y se dice así.
      if (d > 0 && d <= MAX_DESFASE) return `La factura se emitió el ${F(em)} y en esta cuenta sale ${d} día(s) después del despacho: se tomó el ${F(carga.fecha)}.`;
      if (d === 0 || !em) {
        return `Es la fecha de EMISIÓN de la factura${em ? ` (${F(em)})` : ""}: no trae la del despacho.` +
          (origen.generada_despues ? " Es un cierre de mes: puede juntar despachos de varios días." : "");
      }
      return `La carga dice ${F(carga.fecha)} y su factura se emitió el ${F(em)}: confírmala contra el voucher.`;
    }
    default:
      return "No se sabe de dónde salió la fecha: confírmala contra el voucher.";
  }
}

const notaEnObs = (obs: string | null): string | null => /\bNota\s+([A-Z0-9][A-Z0-9-]*)/i.exec(String(obs ?? ""))?.[1] ?? null;
const comprobanteEnObs = (obs: string | null): string | null => referenciaEnObservacion(obs);

/**
 * La cola de cargas por completar. `hoy` es el día Lima (YYYY-MM-DD) —se pasa, no se calcula: el
 * navegador vive en UTC y a las 19:00 de Lima ya es mañana—. `dias` = la ventana que se pide.
 */
export function colaPorCompletar(
  cargas: readonly CargaDeFacturaBD[],
  origenes: ReadonlyMap<number, OrigenDeCarga>,
  hoy: string,
  dias: number = DIAS_REGISTRO_AUTOMATICO,
): ColaCompletar {
  const desde = sumarDias(hoy, -dias);
  const cola: CargaPorCompletar[] = [], antiguas: CargaPorCompletar[] = [];
  const vistas = new Set<number>();
  for (const c of cargas ?? []) {
    if (!c || vistas.has(c.id)) continue;
    vistas.add(c.id);
    const obs = c.observaciones;
    if (!esCargaDeFactura(obs) || esCargaFusionada(obs) || esCargaCompletada(obs)) continue;
    const origen = origenes.get(Number(c.id)) ?? null;
    const falta_km = !(Number(c.kilometraje) > 0);
    const falta_fecha = !fechaEsDato(origen?.fecha_origen);
    if (!falta_km && !falta_fecha) continue;
    const item: CargaPorCompletar = {
      carga: c, origen, falta_km, falta_fecha,
      por_que_fecha: porQueFecha(c, origen),
      comprobante: origen?.comprobante && origen.comprobante !== "-" ? origen.comprobante : comprobanteEnObs(obs),
      nota_despacho: origen?.nota_despacho ?? notaEnObs(obs),
    };
    (String(c.fecha).slice(0, 10) >= desde ? cola : antiguas).push(item);
  }
  const orden = (a: CargaPorCompletar, b: CargaPorCompletar) =>
    a.carga.fecha < b.carga.fecha ? -1 : a.carga.fecha > b.carga.fecha ? 1 : a.carga.id - b.carga.id;
  return { cola: cola.sort(orden), antiguas: antiguas.sort(orden) };
}

// ── El rango de km del día ───────────────────────────────────────────────────

/** Una lectura viva de `lecturas_odometro`, tal como se lee de la base. */
export type LecturaOdometroBD = {
  km: number | string;
  fecha: string | null;
  capturado_en?: string | null;
  created_at?: string | null;
  fuente?: string | null;
  momento?: string | null;
  estado?: string | null;
};

export type LecturaDeReferencia = { km: number; fecha: string; hora: string | null; etiqueta: string };

export type RangoKmDelDia = {
  fecha: string;
  /** La última lectura viva ANTES de la carga: el día anterior o, con hora, antes de esa hora. */
  antes: LecturaDeReferencia | null;
  /** Las de ese mismo día que no se pudieron ubicar antes ni después (sin la hora de la carga, todas). */
  delDia: LecturaDeReferencia[];
  /** La primera lectura viva DESPUÉS de la carga. */
  despues: LecturaDeReferencia | null;
};

/** Cómo se nombra una lectura de referencia: de dónde salió. */
export function etiquetaLectura(l: { fuente?: string | null; momento?: string | null }): string {
  if (l.momento === "checkin") return "check-in del conductor";
  if (l.momento === "checkout") return "check-out del conductor";
  switch (l.fuente) {
    case "combustible": return "carga de combustible";
    case "whatsapp_foto": case "whatsapp_manual": return "Radar IA";
    case "checklist": return "checklist";
    case "servicio": return "servicio";
    case "manual": return "registrada a mano";
    default: return "lectura";
  }
}

const VIVAS = new Set(["aceptada", "reinicio"]);
const horaLima = (ts: number) => new Date(ts - 5 * 3600_000).toISOString().slice(11, 16);
/** «17:08», «5:08 pm», «17.08» → «17:08» (la misma lectura de hora que el voucher del Radar). */
const normHora = (h: string | null | undefined): string | null => normalizarHoraVoucher(h)?.slice(0, 5) ?? null;

/**
 * Lo que acota el km de una carga de `fecha`: la última lectura viva anterior y la primera posterior.
 * Sin la hora de la carga, las del mismo día no acotan nada —la carga pudo ser antes o después de
 * cada una— y se enseñan aparte. Con la hora (la del voucher), las del día con hora conocida se
 * reparten antes y después. Una lectura de solo fecha nunca se ubica dentro de su día.
 */
export function rangoKmDelDia(lecturas: readonly LecturaOdometroBD[], fecha: string, hora?: string | null): RangoKmDelDia {
  const h = normHora(hora);
  const vivas = (lecturas ?? [])
    .filter((l) => l && l.fecha && VIVAS.has(String(l.estado ?? "aceptada")) && Number(l.km) > 0)
    .map((l) => {
      const inst = instanteLectura({ capturado_en: l.capturado_en ?? null, created_at: l.created_at ?? null, fecha: l.fecha ?? null });
      const conHora = inst.origen !== "fin_del_dia";
      return {
        ref: {
          km: Number(l.km), fecha: String(l.fecha).slice(0, 10),
          hora: conHora && inst.ts ? horaLima(inst.ts) : null,
          etiqueta: etiquetaLectura(l),
        } as LecturaDeReferencia,
        ts: inst.ts || Date.parse(`${String(l.fecha).slice(0, 10)}T23:59:59-05:00`),
      };
    })
    .sort((a, b) => a.ts - b.ts);
  let antes: (typeof vivas)[number] | null = null, despues: (typeof vivas)[number] | null = null;
  const delDia: LecturaDeReferencia[] = [];
  for (const x of vivas) {
    const f = x.ref.fecha;
    const lado: "antes" | "despues" | "dia" =
      f < fecha ? "antes" : f > fecha ? "despues"
        : h && x.ref.hora ? (x.ref.hora <= h ? "antes" : "despues") : "dia";
    if (lado === "antes") { if (!antes || x.ts >= antes.ts) antes = x; }
    else if (lado === "despues") { if (!despues || x.ts < despues.ts) despues = x; }
    else delDia.push(x.ref);
  }
  return { fecha, antes: antes?.ref ?? null, delDia, despues: despues?.ref ?? null };
}

const nombrar = (r: LecturaDeReferencia) => `${r.etiqueta} del ${F(r.fecha)}${r.hora ? ` ${r.hora}` : ""} (${fmtKm(r.km)})`;

/**
 * ¿El km tecleado cabe en el rango? Devuelve por qué no, o null. Misma regla que `kmFueraDeSuMomento`
 * (lib/odometro.ts): más que la lectura posterior no puede ser; menos que la anterior, solo dentro de
 * la tolerancia del ruido de lectura.
 */
export function kmFueraDelRango(km: number, r: RangoKmDelDia | null | undefined): string | null {
  if (!r || !(km > 0)) return null;
  if (r.despues && km > r.despues.km) {
    return `${fmtKm(km)} es MÁS que la lectura posterior a esa carga: ${nombrar(r.despues)}. El odómetro no baja.`;
  }
  if (r.antes && km < r.antes.km - toleranciaRetroceso(r.antes.km)) {
    return `${fmtKm(km)} es MENOS que la lectura anterior a esa carga: ${nombrar(r.antes)}. El odómetro no retrocede.`;
  }
  return null;
}

// ── El plan para completar una carga ─────────────────────────────────────────

export type EntradaCompletar = {
  /** El odómetro del voucher. null = no se tecleó. */
  km: number | null;
  /** «No hay odómetro para esta carga»: sale de la cola sin inventar un número. */
  sinOdometro: boolean;
  /** La fecha del despacho, confirmada o corregida (YYYY-MM-DD). */
  fecha: string | null;
  /** Opcional: la hora impresa en el voucher (HH:MM). Ubica la lectura del odómetro en su día. */
  hora?: string | null;
  /** Opcional: quién cargó, si la carga no lo tiene. */
  conductor?: string | null;
};

export type CodigoCompletar =
  | "completable"
  | "no_es_de_factura" | "ya_fusionada" | "ya_completada"
  | "falta_km" | "km_invalido"
  | "falta_fecha" | "fecha_futura" | "despues_de_emision"
  | "hora_invalida";

export type PlanCompletar = {
  codigo: CodigoCompletar;
  puede: boolean;
  /** Lo que se escribe en la carga. NUNCA galones, precio ni importe: los de la factura. */
  patch: Record<string, unknown>;
  cambios: { campo: string; de: string; a: string }[];
  avisos: string[];
  /** Lo que quien llama registra en `lecturas_odometro` (registrarLectura). null = ninguna lectura. */
  lectura: { km: number; fecha: string; hora: string | null } | null;
  /** La fecha pasa a otro mes: cambia el mes del gasto en Finanzas. */
  cruzaMes: boolean;
  /** Algo raro que la persona tiene que confirmar aparte (un cambio de mes, una fecha lejos de la factura). */
  pideConfirmar: boolean;
  detalle: string;
};

/** Km máximo que se acepta como número (8 cifras ya no es un odómetro de bus: es un dígito de más). */
export const KM_MAXIMO = 9_999_999;

export function planDeCompletar(
  carga: CargaDeFacturaBD,
  origen: OrigenDeCarga | null,
  e: EntradaCompletar,
  hoy: string,
  rango?: RangoKmDelDia | null,
): PlanCompletar {
  const vacio = { patch: {}, cambios: [], avisos: [], lectura: null, cruzaMes: false, pideConfirmar: false };
  const no = (codigo: CodigoCompletar, detalle: string): PlanCompletar => ({ ...vacio, codigo, puede: false, detalle });
  const obs = String(carga.observaciones ?? "");
  if (!esCargaDeFactura(obs)) return no("no_es_de_factura", `La carga #${carga.id} no la registró una factura: se corrige en el formulario de Combustible.`);
  if (esCargaFusionada(obs)) return no("ya_fusionada", `La carga #${carga.id} ya se fusionó con su voucher del Radar: tiene la fecha y el odómetro del papel.`);
  if (esCargaCompletada(obs)) return no("ya_completada", `La carga #${carga.id} ya se completó a mano.`);

  // ── La fecha ──
  const fecha = e.fecha ? String(e.fecha).slice(0, 10) : null;
  if (!esISO(fecha)) return no("falta_fecha", "Pon la fecha del despacho (la del voucher).");
  if (fecha > hoy) return no("fecha_futura", `La fecha ${F(fecha)} es posterior a hoy.`);
  const emision = origen?.fecha_emision ?? null;
  if (emision && fecha > emision) {
    return no("despues_de_emision", `La factura ${origen?.comprobante ?? ""} se emitió el ${F(emision)}: el despacho no puede ser posterior. Revisa la fecha del voucher.`);
  }
  const hora = e.hora != null && String(e.hora).trim() !== "" ? normHora(e.hora) : null;
  if (e.hora != null && String(e.hora).trim() !== "" && !hora) return no("hora_invalida", `La hora «${e.hora}» no se entiende: escríbela como 17:08.`);

  // ── El odómetro ── «No hay odómetro» manda sobre un número a medio teclear: es lo último que se
  // decidió. Pero nunca BORRA uno que la carga ya tenía: eso no lo dice nadie al marcar la casilla.
  const kmActual = Number(carga.kilometraje) > 0 ? Math.round(Number(carga.kilometraje)) : null;
  let kmNuevo: number | null = null;
  if (!e.sinOdometro && e.km != null && String(e.km).trim() !== "") {
    const k = Math.round(Number(e.km));
    if (!Number.isFinite(k) || k <= 0 || k > KM_MAXIMO) return no("km_invalido", `«${e.km}» no es un odómetro: escribe el número del voucher, sin puntos ni comas.`);
    kmNuevo = k;
  } else if (!e.sinOdometro && kmActual == null) {
    return no("falta_km", "Escribe el odómetro del voucher, o marca que no lo hay.");
  }

  const patch: Record<string, unknown> = {};
  const cambios: PlanCompletar["cambios"] = [];
  const avisos: string[] = [];
  let pideConfirmar = false;

  const fechaAntes = carga.fecha.slice(0, 10);
  if (fecha !== fechaAntes) {
    patch.fecha = fecha;
    cambios.push({ campo: "Fecha", de: `${F(fechaAntes)} (deducida de la factura)`, a: `${F(fecha)} (del voucher)` });
  }
  if (emision) {
    const lejos = diasEntre(fecha, emision);
    if (lejos > MAX_DESFASE) {
      avisos.push(`El despacho queda ${lejos} días antes de la factura (emitida el ${F(emision)}): más que el desfase de facturación. Ponla solo si el voucher lo dice.`);
      pideConfirmar = true;
    }
  }
  const cruzaMes = !!patch.fecha && fecha.slice(0, 7) !== fechaAntes.slice(0, 7);
  if (cruzaMes) {
    avisos.push(`La carga pasa de ${F(fechaAntes)} a ${F(fecha)}: cambia de mes, y con ella el gasto de ese mes en Finanzas.`);
    pideConfirmar = true;
  }

  let lectura: PlanCompletar["lectura"] = null;
  if (kmNuevo != null) {
    if (kmNuevo !== kmActual) {
      patch.kilometraje = kmNuevo;
      cambios.push({ campo: "Odómetro", de: kmActual != null ? fmtKm(kmActual) : "sin odómetro", a: fmtKm(kmNuevo) });
      if (kmActual != null) avisos.push(`La carga ya tenía ${fmtKm(kmActual)} (alguien lo escribió): se reemplaza por ${fmtKm(kmNuevo)}.`);
      lectura = { km: kmNuevo, fecha, hora };
    }
    const fuera = kmFueraDelRango(kmNuevo, rango);
    if (fuera) avisos.push(`${fuera} Se guarda igual, y la lectura queda por revisar en Mantenimiento → Odómetro.`);
  } else if (e.sinOdometro && kmActual == null) {
    cambios.push({ campo: "Odómetro", de: "sin odómetro", a: "no hay (confirmado)" });
    avisos.push("Sin odómetro, el tramo que cierra esta carga no se puede medir: el rendimiento de esa unidad lo dirá así.");
  }

  const conductor = String(e.conductor ?? "").trim();
  if (conductor && !String(carga.conductor ?? "").trim()) {
    patch.conductor = conductor;
    cambios.push({ campo: "Conductor", de: "—", a: conductor });
  }

  // La marca, con lo que se completó. Una carga con odómetro deja de decir «sin odómetro».
  const kmFinal = kmNuevo ?? kmActual;
  const base = kmFinal != null ? obs.replace(/ · sin odómetro\b/, "") : obs;
  const partes = [
    kmNuevo != null ? `odómetro ${fmtKm(kmNuevo)} del voucher` : kmFinal != null ? `odómetro ${fmtKm(kmFinal)}` : "no hay odómetro (no se pudo obtener)",
    fecha !== fechaAntes ? `fecha del despacho corregida a ${F(fecha)} (tenía ${F(fechaAntes)})` : `fecha del despacho confirmada (${F(fecha)})`,
    ...(hora ? [`hora ${hora}`] : []),
  ];
  patch.observaciones = [base, `✍ ${MARCA_COMPLETADA_A_MANO}: ${partes.join(", ")}`].filter(Boolean).join(" · ");

  return {
    codigo: "completable", puede: true, patch, cambios, avisos, lectura, cruzaMes, pideConfirmar,
    detalle: `La carga #${carga.id} queda completa` +
      (cambios.length ? `: ${cambios.map((c) => c.campo.toLowerCase()).join(", ")}` : " (se confirma tal como está)") +
      ". Los galones, el precio y el importe siguen siendo los de la factura.",
  };
}

/**
 * ¿A esta carga le falta el odómetro y se puede completar desde la factura? Para el historial de
 * Combustible, que no tiene la factura a mano: solo mira la carga. Es la mitad «falta_km» de la cola,
 * con la MISMA ventana.
 */
export function faltaOdometroDeFactura(c: { fecha: string; kilometraje: number | null; observaciones: string | null }, hoy: string, dias: number = DIAS_REGISTRO_AUTOMATICO): boolean {
  const obs = c.observaciones;
  return esCargaDeFactura(obs) && !esCargaFusionada(obs) && !esCargaCompletada(obs) &&
    !(Number(c.kilometraje) > 0) && String(c.fecha).slice(0, 10) >= sumarDias(hoy, -dias);
}
