// lib/odometro-tiempo.ts
// CUÁNDO OCURRIÓ una lectura de odómetro. Módulo PURO: no lee la base.
//
// El caso que lo abrió (CTV-370, 05/10/2026): la nota de despacho V70S-00043672 de COESTI
// imprime 13/09/2026 08:01:57 y kilometraje 29,647. Se confirmó desde el panel de revisión del
// Radar el 05/10 a las 16:25 y la lectura quedó con DOS defectos de tiempo, ninguno de lectura:
//
//   1. Al REGISTRARLA no viajó ninguna hora (el panel solo pasaba la del mensaje, y el mensaje
//      no estaba cargado), así que `tsDe("2026-09-13")` la ubicó a las 00:00 del 13/09 — ANTES
//      del check-in de las 05:25 (29,612 km). 29,647 > 29,612 se leyó como «la lectura que vino
//      después tiene menos km» y fue a revisión. La hora estaba IMPRESA en el voucher.
//   2. Al MOSTRARLA, sin `capturado_en` se caía a `created_at`: «13/09/2026 · ~16:25», con la
//      hora del 05/10, y la comparó contra la lectura viva anterior a ESE instante — la del
//      05/10 07:02 (31,265 km), veintidós días después de la recarga.
//
// La regla de este módulo: **el instante de una lectura nunca sale de su día**. `created_at` es
// cuándo ENTRÓ al ERP; solo sirve de aproximación si cae en el mismo día Lima que `fecha`. Una
// lectura cargada otro día —una recarga confirmada semanas después, un voucher reprocesado—
// sin hora conocida se ubica al FINAL de su día, que es la cota superior honesta: lo único
// cierto es que ocurrió ese día, y ubicarla a las 00:00 la pone antes de todo lo que pasó en
// la jornada. Con hora-tope, `contextoOdometro` la adelanta al hueco que su km exige.

const LIMA_MS = 5 * 3600_000;

/** Día Lima (YYYY-MM-DD) de un epoch ms. */
export function diaLimaDeTs(ts: number): string {
  return new Date(ts - LIMA_MS).toISOString().slice(0, 10);
}

function tsDeIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

function esFecha(f: string | null | undefined): f is string {
  return !!f && /^\d{4}-\d{2}-\d{2}$/.test(f.slice(0, 10));
}

/** Último segundo del día Lima de `fecha` (YYYY-MM-DD), en epoch ms. */
export function finDiaLimaTs(fecha: string): number {
  return new Date(`${fecha.slice(0, 10)}T23:59:59-05:00`).getTime();
}

export type InstanteLectura = {
  ts: number;
  /** De dónde sale el instante: cada uno merece un rótulo distinto en pantalla. */
  origen: "capturado" | "insercion" | "fin_del_dia";
};

/**
 * Instante EFECTIVO de una lectura guardada, para ordenar la jornada y buscar vecinas:
 *   · `capturado_en` si existe (cuándo se tomó);
 *   · `created_at` si cae en el MISMO día Lima que `fecha` (aproximación razonable);
 *   · si no, el final del día de `fecha`: nunca el instante de otro día.
 * Sin `fecha` (filas raras) se mantiene el comportamiento anterior.
 */
export function instanteLectura(l: {
  capturado_en?: string | null;
  created_at?: string | null;
  fecha?: string | null;
}): InstanteLectura {
  const cap = tsDeIso(l.capturado_en);
  if (cap != null) return { ts: cap, origen: "capturado" };
  const ins = tsDeIso(l.created_at);
  if (!esFecha(l.fecha)) return { ts: ins ?? 0, origen: "insercion" };
  if (ins != null && diaLimaDeTs(ins) === l.fecha!.slice(0, 10)) return { ts: ins, origen: "insercion" };
  return { ts: finDiaLimaTs(l.fecha!), origen: "fin_del_dia" };
}

/** Atajo: solo el epoch ms. */
export function tsEfectivoLectura(l: { capturado_en?: string | null; created_at?: string | null; fecha?: string | null }): number {
  return instanteLectura(l).ts;
}

/**
 * Lo que se le ENSEÑA al operador como hora: el ISO del instante si hay alguno que pertenezca
 * al día, o null («sin hora») cuando lo único que se sabe es la fecha. Inventar «23:59» en
 * pantalla sería afirmar una hora que nadie observó.
 */
export function isoHoraVisible(l: { capturado_en?: string | null; created_at?: string | null; fecha?: string | null }): string | null {
  const i = instanteLectura(l);
  if (i.origen === "capturado") return l.capturado_en ?? null;
  if (i.origen === "insercion") return l.created_at ?? null;
  return null;
}

/** "08:01:57" · "8:01" · "08:01 p. m." → "HH:MM:SS", o null si no es una hora. */
export function normalizarHoraVoucher(hora: string | null | undefined): string | null {
  if (!hora) return null;
  const m = /^\s*(\d{1,2})[:.h](\d{2})(?:[:.](\d{2}))?\s*([ap])?\.?\s*m?\.?\s*$/i.exec(String(hora));
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const s = m[3] != null ? Number(m[3]) : 0;
  const ap = m[4]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "p" && h < 12) h += 12;
    if (ap === "a" && h === 12) h = 0;
  }
  if (h > 23 || mi > 59 || s > 59) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(mi)}:${p(s)}`;
}

/**
 * Margen por el que la hora impresa puede ir POR DELANTE del envío del mensaje sin que eso sea
 * imposible: el reloj de la impresora del grifo y el del servidor de WhatsApp no son el mismo.
 */
const MARGEN_RELOJ_VOUCHER_MS = 15 * 60_000;

export type CapturaRecarga = {
  capturado_en: string | null;
  horaEsTope: boolean;
  fuente: "voucher" | "mensaje" | "solo_fecha";
};

/**
 * Hora con la que se registra el odómetro de una RECARGA, del dato más fuerte al más débil:
 *
 *   1. **La hora impresa en el voucher** (`radar_combustible.hora`). Es la del despacho, y el
 *      grifero teclea el kilometraje en ese momento: es exacta, no un tope. Se descarta solo si
 *      es imposible —posterior al envío del mensaje que trae la foto—, que es la firma de una
 *      hora mal leída.
 *   2. **La hora del mensaje**, como TOPE (la foto se tomó en o antes de mandarla), y solo si el
 *      mensaje es del MISMO día que la recarga. Un voucher del 13 mandado el 15 no tiene la hora
 *      del 15: usarla ubicaría la lectura dos días más tarde que su fecha.
 *   3. **Solo la fecha**: `capturado_en` null; `registrarLectura` la ubica al final de su día,
 *      como tope, y su kilometraje la coloca en el hueco que le corresponde.
 */
export function capturaDeRecarga(opts: {
  fecha: string;
  hora?: string | null;
  tsMensaje?: string | null;
}): CapturaRecarga {
  const fecha = opts.fecha.slice(0, 10);
  const tsMsg = tsDeIso(opts.tsMensaje);
  const hms = normalizarHoraVoucher(opts.hora);
  if (hms && esFecha(fecha)) {
    const iso = `${fecha}T${hms}-05:00`;
    const ts = tsDeIso(iso);
    const imposible = ts != null && tsMsg != null && ts > tsMsg + MARGEN_RELOJ_VOUCHER_MS;
    if (ts != null && !imposible) return { capturado_en: new Date(ts).toISOString(), horaEsTope: false, fuente: "voucher" };
  }
  if (tsMsg != null && diaLimaDeTs(tsMsg) === fecha) {
    return { capturado_en: new Date(tsMsg).toISOString(), horaEsTope: true, fuente: "mensaje" };
  }
  return { capturado_en: null, horaEsTope: true, fuente: "solo_fecha" };
}

/**
 * Instante (ISO) de una hora tecleada a mano sobre la FECHA de la lectura: «08:01» del 13/09 →
 * 2026-09-13T13:01:00Z. La hora se corrige dentro de su día; cambiar el día es otra corrección.
 * null si la hora no es una hora.
 */
export function capturaDeFechaHora(fecha: string | null | undefined, hora: string | null | undefined): string | null {
  if (!esFecha(fecha)) return null;
  const hms = normalizarHoraVoucher(hora);
  if (!hms) return null;
  const ts = tsDeIso(`${fecha!.slice(0, 10)}T${hms}-05:00`);
  return ts == null ? null : new Date(ts).toISOString();
}

/** "HH:MM:SS" Lima de un instante ISO (para precargar el campo de hora). */
export function horaLimaHms(iso: string | null | undefined): string | null {
  const ts = tsDeIso(iso);
  return ts == null ? null : new Date(ts - LIMA_MS).toISOString().slice(11, 19);
}
