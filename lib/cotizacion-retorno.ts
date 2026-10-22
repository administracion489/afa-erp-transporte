// ══════════════════════════════════════════════════════════════════════════════
// EL RETORNO DE UNA COTIZACIÓN EVENTUAL ES SU PROPIA RESERVA (motor PURO)
//
// «→ Res.» de /cotizaciones creaba SOLO la ida: una cotización «Ida y Retorno» como la #736
// (Aeropuerto → Paracas el 22, Paracas → JW Marriott Miraflores el 23) llegaba a Programación con
// un tramo, sin conductor ni paraderos para la vuelta, y la Confirmación de Reserva no la nombraba.
//
// Reglas:
//  · Solo eventuales «Ida y Retorno» / «Con Paradas» (un fijo genera su programa en Programación;
//    un Full Day es un servicio del día entero; un multi-día tiene su cronograma).
//  · El recorrido del retorno es el que la cotización DECLARA (`paradas_retorno_json`) y, si no,
//    sus extremos: destino → punto de retorno (o el origen, si no se escribió otro). Nunca la lista
//    de la ida dada vuelta.
//  · Fecha: `fecha_retorno`, o la del servicio. Hora: la del primer paradero del retorno, o
//    `hora_retorno`. SIN HORA NO SE CREA (no se inventa un 06:00): se dice y se crea a mano.
//  · El importe va en la ida; el retorno nace en S/ 0.00 (la tarifa del día cubre los dos tramos)
//    y enlazado a su ida por los dos lados de `reserva_vinculada_id`.
// ══════════════════════════════════════════════════════════════════════════════

export type ParadaCotRet = { tipo?: string | null; nombre?: string | null; direccion?: string | null; lat?: string | number | null; lng?: string | number | null; hora?: string | null };

export type CotParaRetorno = {
  modo_servicio?: string | null;
  tipo_servicio?: string | null;
  origen?: string | null;
  destino?: string | null;
  punto_retorno?: string | null;
  fecha_servicio?: string | null;
  fecha_retorno?: string | null;
  hora_retorno?: string | null;
  paradas_retorno_json?: ParadaCotRet[] | null;
  ruta_coords_json?: unknown;
};

/** Los tipos eventuales que vuelven en otro tramo. */
export const TIPOS_CON_RETORNO = ["ida_retorno", "ida_retorno_paradas"] as const;

export type ParadaRetorno = { orden: number; nombre: string; direccion: string | null; lat: number | null; lng: number | null; hora: string | null };

export type PlanRetorno =
  | { codigo: "no_aplica" }
  | { codigo: "sin_hora" | "fecha_anterior" | "sin_destino"; motivo: string }
  | { codigo: "ok"; fecha: string; hora: string; origen: string; destino: string; paradas: ParadaRetorno[] };

const txt = (v: unknown) => String(v ?? "").trim();
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** «HH:MM» o «HH:MM:SS» válida, normalizada a «HH:MM»; si no, null. */
export function horaValida(v: unknown): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(txt(v));
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}
const fechaIso = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(txt(v)) ? txt(v) : null);

function punto(raw: unknown, k: "destino" | "retorno" | "origen"): { lat: number; lng: number } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = raw && typeof raw === "object" ? (raw as any)[k] : null;
  const lat = num(p?.lat), lng = num(p?.lng);
  return lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

export function planRetorno(c: CotParaRetorno, fechaIda: string): PlanRetorno {
  if (c.modo_servicio === "fijo" || !(TIPOS_CON_RETORNO as readonly string[]).includes(txt(c.tipo_servicio))) return { codigo: "no_aplica" };

  const declaradas = (c.paradas_retorno_json ?? []).filter((p) => txt(p?.nombre));
  const ord = (t: string) => (t === "inicio" ? 0 : t === "destino" ? 2 : 1);
  let paradas: ParadaRetorno[];
  if (declaradas.length >= 2) {
    paradas = [...declaradas]
      .map((p, i) => ({ p, i }))
      .sort((a, b) => ord(txt(a.p.tipo)) - ord(txt(b.p.tipo)) || a.i - b.i)
      .map(({ p }, i) => ({ orden: i + 1, nombre: txt(p.nombre), direccion: txt(p.direccion) || null, lat: num(p.lat), lng: num(p.lng), hora: horaValida(p.hora) }));
  } else {
    const desde = txt(c.destino);
    const retTxt = txt(c.punto_retorno);
    const hasta = retTxt || txt(c.origen);
    if (!desde || !hasta) return { codigo: "sin_destino", motivo: "La cotización no dice desde dónde ni hasta dónde vuelve." };
    const pd = punto(c.ruta_coords_json, "destino");
    const ph = punto(c.ruta_coords_json, retTxt ? "retorno" : "origen");
    paradas = [
      { orden: 1, nombre: desde, direccion: null, lat: pd?.lat ?? null, lng: pd?.lng ?? null, hora: null },
      { orden: 2, nombre: hasta, direccion: null, lat: ph?.lat ?? null, lng: ph?.lng ?? null, hora: null },
    ];
  }

  const hora = paradas[0].hora ?? horaValida(c.hora_retorno);
  if (!hora) return { codigo: "sin_hora", motivo: "La cotización no tiene hora de retorno." };
  if (!paradas[0].hora) paradas[0] = { ...paradas[0], hora };

  const fecha = fechaIso(c.fecha_retorno) ?? fechaIso(c.fecha_servicio) ?? fechaIda;
  if (fecha < fechaIda) return { codigo: "fecha_anterior", motivo: `La fecha de retorno (${fecha}) es anterior a la de la ida (${fechaIda}).` };

  return { codigo: "ok", fecha, hora, origen: paradas[0].nombre, destino: paradas[paradas.length - 1].nombre, paradas };
}
