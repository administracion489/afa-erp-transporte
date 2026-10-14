// lib/alertas-flota.ts — Lógica PURA (sin React/DOM) del SOLAPE (unidad o conductor en dos
// servicios que no se pueden hacer seguidos) y de la JORNADA DE CONDUCCIÓN. La usan el motor de
// alertas (/api/alertas-flota/tick) y la torre (/seguimiento): dos pantallas que contestan
// "¿este conductor maneja de más?" o "¿esta unidad llega?" tienen que contestar con el mismo motor.
// Las dos parten de la MISMA ventana por servicio (`ventanaConduccion`), que va de lo real al
// itinerario de paraderos y solo sin itinerario al bloque de 4 h — y entonces lo declara.
//
// OJO con `hora_real_fin`: llevaba un año VACÍA (0 de 575 servicios en 30 días), así que este
// módulo caía SIEMPRE al bloque estimado. Desde que los endpoints del conductor la sellan, el
// valor entra de verdad — y es "HH:MM:SS" sin fecha, con dos formas de mentir (cruce de
// medianoche y cierre anticipado). Ver `ventanaConduccion`: que el dato mejore no puede empeorar
// la alerta.
//
// ── LA JORNADA SE MIDE EN HORAS DE CONDUCCIÓN, NO EN «PRIMERA SALIDA → ÚLTIMO FIN» ──────────
// Lo reportó el dueño el 13-10-2026 con la torre delante: los conductores de I.C. LOGÍSTICA
// (CWQ400, CWZ-371) salían con el chip JORNADA porque hacen ENTRADA de madrugada y RETORNO por
// la tarde, y entre los dos DESCANSAN. Es horario partido. La regla vieja medía la AMPLITUD
// (05:29 → 19:40 = 14 h > 13) o contaba servicios (≥ 4), así que cada servicio de horario
// partido era «jornada extensa»: un chip que sale siempre se vuelve paisaje, y el día que un
// conductor maneje 6 h seguidas sin parar ya nadie lo mira.
//
// LA NORMA mide otra cosa (RENAT, D.S. 017-2009-MTC, art. 30, texto de `REFERENCIA_NORMA`):
//   · 30.7: «jornada de conducción» es el tiempo dedicado a CONDUCIR durante la circulación del
//     vehículo. La espera entre una entrada y su retorno no es conducción.
//   · 30.2 / 30.9: no más de 5 h de conducción CONTINUA de día ni 4 h de noche (30.3: noche es
//     22:00–05:59), y no más de 10 h ACUMULADAS en 24 h.
//   · 30.5 / 30.9: entre jornadas de conducción, un descanso no menor de 1 h; si la jornada
//     efectiva fue menor de 2 h, no menor de 30 min.
// Por eso: un descanso que llega al mínimo PARTE la conducción en dos bloques, y uno que no
// llega NO la parte (una pausa de 20 min no es descanso). Se alarma solo si un bloque pasa su
// tope continuo o si la conducción del día pasa del acumulado. La amplitud y el número de
// servicios se PUBLICAN como evidencia y no deciden nada.
//
// LO QUE ESTE NÚMERO NO VE, Y SE DECLARA: es un PISO. Cuenta el itinerario de cada servicio
// (del primer al último paradero), no los traslados en vacío a la cochera o al siguiente punto,
// que también son conducción. Y mide el DÍA de la torre: un nocturno que sigue tras la
// medianoche cuenta en el día en que empezó, no en una ventana móvil de 24 h.
//
// DE DÓNDE SALE LA DURACIÓN DE CADA SERVICIO (`ventanaConduccion`), de la evidencia al supuesto:
// la salida real si existe (si no, el primer paradero del itinerario o la hora del servicio) y
// el fin real; si no hay fin real, la duración PLANIFICADA del itinerario (último paradero −
// primero) contada desde la salida; y solo si no hay itinerario, el bloque de 4 h de siempre —
// que se CUENTA aparte (`estimados`) y la alerta lo dice, porque inflado por estimación no es
// lo mismo que medido.

import { minutosAHhmm, textoDuracion } from "@/lib/alertas-horario";
import { distM } from "@/lib/huella";
import { ordenarTramo } from "@/lib/paradas-materializar";

/** Un punto del mapa (paradero). */
export type PuntoGeo = { lat: number; lng: number };

export type ReservaFlota = {
  id: number;
  estado?: string | null;
  conductor_id?: number | null;
  vehiculo_id?: number | null;
  vehiculo_tercero_id?: number | null;
  hora_servicio?: string | null;
  hora_real_fin?: string | null;
  /** "HH:MM[:SS]" — salida REAL (la torre la deriva de la evidencia; el tick lee la columna). */
  hora_real_inicio?: string | null;
  /** "HH:MM" — hora planificada del PRIMER paradero del itinerario (`itinerarioDe`). */
  plan_inicio?: string | null;
  /** "HH:MM" — hora planificada del ÚLTIMO paradero del itinerario (`itinerarioDe`). */
  plan_fin?: string | null;
  /**
   * "HH:MM" de AHORA, solo para un servicio EN CURSO hoy: lleva al menos hasta este minuto
   * conduciendo, aunque su itinerario dijera que ya debía haber terminado (un servicio atrasado
   * sigue sumando). Sin fin real; con fin real no se usa.
   */
  en_curso_ahora?: string | null;
  /** Coordenadas del PRIMER paradero del itinerario (`itinerarioDe`): de dónde sale. */
  plan_origen?: PuntoGeo | null;
  /** Coordenadas del ÚLTIMO paradero del itinerario (`itinerarioDe`): dónde termina. */
  plan_destino?: PuntoGeo | null;
  /** Cómo nombrar este servicio en el texto del solape («OS-2026-006599 · 17:50»). */
  rotulo?: string | null;
};

const DUR_ESTIMADA_MIN = 240; // 4 h: bloque por defecto para estimar el fin de un servicio

/**
 * Ya NO dispara la alerta de jornada (ver cabecera): cuatro servicios cortos con descansos son
 * horario partido, no fatiga. Se conserva exportado porque la tarjeta lo usó en su texto y la
 * matriz lo cita; ningún motor lo lee.
 * @deprecated La jornada se juzga por horas de conducción (`evaluarJornada`).
 */
export const MAX_SERVICIOS_JORNADA = 4;

const DIA_MIN = 24 * 60;

// ── Los números de la norma (RENAT art. 30). HEREDADOS de la norma, no elegidos. ──────────
/** Cita corta para los textos: dónde está escrita la regla. */
export const REFERENCIA_NORMA = "RENAT, D.S. 017-2009-MTC, art. 30";
/** 30.2 / 30.9: conducción continua máxima de DÍA. */
export const CONTINUA_DIURNA_MAX_MIN = 5 * 60;
/** 30.2: conducción continua máxima de NOCHE. */
export const CONTINUA_NOCTURNA_MAX_MIN = 4 * 60;
/** 30.5 / 30.9: descanso mínimo entre jornadas de conducción. */
export const DESCANSO_MIN = 60;
/** 30.5 / 30.9: …o 30 min cuando la jornada de conducción efectiva fue menor de 2 h. */
export const DESCANSO_CORTO_MIN = 30;
export const JORNADA_CORTA_MIN = 2 * 60;
/**
 * 30.2 / 30.9: conducción acumulada máxima en 24 h. Es el DEFAULT del umbral de la tarjeta
 * «jornada» (UMBRAL_DEFECTO.jornada lo importa de aquí). Entre 2017 y junio de 2023 el MTC
 * suspendió varias veces este tope y lo subió a 12 h (último: D.S. 016-2022-MTC, hasta el
 * 30-06-2023): por eso es editable y no una constante dura.
 */
export const CONDUCCION_ACUMULADA_MAX_H = 10;
/** 30.3: servicio nocturno de 22:00 a 05:59. */
const NOCHE_DESDE_MIN = 22 * 60;
const NOCHE_HASTA_MIN = 6 * 60;

/**
 * Cuánto puede separarse el itinerario de la hora del servicio para creerle. Existe por un
 * defecto conocido (CLAUDE.md, «Los paraderos de HOY…»): un retorno de una cotización sin lista
 * de retorno lleva en su semilla los paraderos de la IDA con las horas de la mañana. Ese
 * itinerario no describe el servicio de la tarde y se descarta. 3 h: no medido; el lado seguro
 * es bajarlo (se cae al bloque estimado, que cuenta MÁS conducción).
 */
const DESVIO_ITINERARIO_MIN = 180;
/** Una salida real a más de 12 h de lo planificado no es la de este servicio. */
const DESVIO_INICIO_REAL_MIN = 12 * 60;
/** Un itinerario de menos de esto (un solo paradero, o todos a la misma hora) no dice nada. */
const DUR_MIN_PLAN = 5;
/**
 * Un fin real hasta 3 h ANTES del inicio con el que se ubicó el servicio no es un viaje de 21 h
 * que cruzó la medianoche: es un inicio mal ubicado (ver `ventanaConduccion`). Más allá sí se
 * lee como un tour largo, igual que siempre. No medido.
 */
const FIN_ANTES_DEL_INICIO_MIN = 180;

// Techo de duración. 26 h y no 12: hay tours full day de hasta 24 h — mismo techo que
// lib/gps-huella-servicio.ts (DURACION_MAX_MS) y lib/servicio-tiempos.ts:308.
const DURACION_MAX_MIN = 26 * 60;

// Por debajo de esto NO se cree la hora de fin y se vuelve al bloque estimado. `hora_real_fin`
// se sella con MAX(paradas.hora_llegada) de las paradas COMPLETADAS: si el conductor solo marcó
// el primer paradero, el valor queda pegado a la hora de salida y la ventana colapsaría a unos
// minutos, dejando CIEGO al detector (que es peor que estimar de más). El bloque estimado es
// exactamente lo que este módulo hacía hasta ahora, así que caer a él nunca es una regresión.
const DUR_MIN_FIABLE_MIN = 30;

function aMin(hhmm?: string | null): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isNaN(h) ? null : h * 60 + (m || 0);
}

// ══════════════════════════════════════════════════════════════════════════════════════
// LA VENTANA DE CONDUCCIÓN DE UN SERVICIO
// ══════════════════════════════════════════════════════════════════════════════════════

/** De dónde salió la DURACIÓN de la ventana. Solo `estimado` es un supuesto del módulo. */
export type FuenteVentana = "real" | "plan" | "estimado";

export type VentanaConduccion = {
  reservaId: number;
  /** minuto del día (puede ser negativo o pasar de 1440: las cuentas son restas) */
  ini: number;
  fin: number;
  fuente: FuenteVentana;
};

/** Distancia entre dos minutos del día, dando la vuelta al reloj (0..720). */
function distCircular(a: number, b: number): number {
  const d = Math.abs(((a - b) % DIA_MIN + DIA_MIN) % DIA_MIN);
  return Math.min(d, DIA_MIN - d);
}

/** `x` corrido ±24 h para quedar a menos de 12 h de `ref` (23:55 frente a 00:10 → −5). */
function alinear(x: number, ref: number): number {
  let v = x;
  while (v - ref > DIA_MIN / 2) v -= DIA_MIN;
  while (ref - v > DIA_MIN / 2) v += DIA_MIN;
  return v;
}

type ParadaPlan = {
  orden?: number | null; hora_estimada?: string | null;
  lat?: number | string | null; lng?: number | string | null;
};

/** Un par lat/lng utilizable, o null (vacío, no numérico o el (0,0) de un dato sin poner). */
function puntoDe(lat: unknown, lng: unknown): PuntoGeo | null {
  if (lat == null || lng == null || lat === "" || lng === "") return null;
  const a = Number(lat), b = Number(lng);
  if (!Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) return null;
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return { lat: a, lng: b };
}

/**
 * El itinerario planificado: hora del primer y del último paradero, y DÓNDE están. Primero las
 * filas de `paradas` (en orden), y si no traen el dato, la semilla `paradas_json` (ordenada como
 * el «Iniciar», `ordenarTramo`). Para la duración hacen falta DOS horas distintas: con una sola no
 * hay nada que medir. El origen y el destino son el primer y el último paradero de la lista, y
 * solo si ESE paradero tiene coordenadas: tomar el siguiente que las tenga movería el extremo.
 */
export function itinerarioDe(
  paradas: ParadaPlan[] | null | undefined,
  semilla?: unknown,
): { inicio: string | null; fin: string | null; origen: PuntoGeo | null; destino: PuntoGeo | null } {
  const deLista = (horas: (string | null | undefined)[]) => {
    const validas = horas.filter((h): h is string => aMin(h) != null);
    return validas.length >= 2 ? { inicio: validas[0], fin: validas[validas.length - 1] } : null;
  };
  const filas = [...(paradas ?? [])].sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
  const orden = Array.isArray(semilla)
    ? ordenarTramo(semilla as { tipo?: string | null; hora?: string | null; lat?: unknown; lng?: unknown }[])
    : [];
  const horas = deLista(filas.map((p) => p.hora_estimada))
    ?? deLista(orden.map((p) => (typeof p?.hora === "string" ? p.hora : null)))
    ?? { inicio: null, fin: null };
  const extremos = (l: { lat?: unknown; lng?: unknown }[]) =>
    l.length ? { origen: puntoDe(l[0]?.lat, l[0]?.lng), destino: puntoDe(l[l.length - 1]?.lat, l[l.length - 1]?.lng) } : null;
  const geo = extremos(filas) ?? extremos(orden) ?? { origen: null, destino: null };
  return { ...horas, ...geo };
}

/**
 * Cuándo condujo (o va a conducir) el conductor en este servicio. null si no tiene ninguna hora
 * con la que ubicarlo en el día — y entonces no se suma ni se inventa: se cuenta en `sinHora`.
 */
export function ventanaConduccion(r: ReservaFlota): VentanaConduccion | null {
  const horaServ = aMin(r.hora_servicio);

  // El itinerario, solo si es coherente con la hora del servicio (ver DESVIO_ITINERARIO_MIN).
  let planIni: number | null = null, planDur: number | null = null;
  const pIni = aMin(r.plan_inicio), pFinCrudo = aMin(r.plan_fin);
  if (pIni != null && pFinCrudo != null) {
    const pFin = pFinCrudo < pIni ? pFinCrudo + DIA_MIN : pFinCrudo;
    const d = pFin - pIni;
    const coherente = horaServ == null || distCircular(pIni, horaServ) <= DESVIO_ITINERARIO_MIN;
    if (coherente && d >= DUR_MIN_PLAN && d <= DURACION_MAX_MIN) {
      planIni = horaServ == null ? pIni : alinear(pIni, horaServ);
      planDur = d;
    }
  }

  const ref = planIni ?? horaServ;
  const realCrudo = aMin(r.hora_real_inicio);
  let ini: number;
  if (realCrudo != null && (ref == null || distCircular(realCrudo, ref) <= DESVIO_INICIO_REAL_MIN)) {
    ini = ref == null ? realCrudo : alinear(realCrudo, ref);
  } else if (ref != null) {
    ini = ref;
  } else {
    return null;
  }

  // Fin REAL: un fin anterior al inicio se lee como cruce de medianoche (un nocturno 22:00 →
  // 01:30 no dura un minuto), con techo de 26 h y un piso de 30 min por debajo del cual el sello
  // no se cree (`hora_real_fin` se sella con el último paradero MARCADO: si solo se marcó el
  // primero, la ventana colapsaría y el detector quedaría ciego).
  const finCrudo = aMin(r.hora_real_fin);
  if (finCrudo != null) {
    const finAl = alinear(finCrudo, ini);
    if (finAl < ini && ini - finAl <= FIN_ANTES_DEL_INICIO_MIN) {
      // Terminó ANTES de la hora con la que se ubicó el inicio: lo que está mal es el inicio, no
      // el fin. Pasa en las ENTRADAS cuya hora del servicio es la de llegada a la planta y que
      // no traen salida real. Sumar 24 h daría un servicio de 23 h; el fin es un hecho y la
      // duración se cuenta hacia atrás desde él.
      const dur = planDur ?? DUR_ESTIMADA_MIN;
      return { reservaId: r.id, ini: finAl - dur, fin: finAl, fuente: planDur != null ? "plan" : "estimado" };
    }
    const fin = finAl < ini ? finAl + DIA_MIN : finAl;
    const dur = fin - ini;
    if (dur >= DUR_MIN_FIABLE_MIN && dur <= DURACION_MAX_MIN) return { reservaId: r.id, ini, fin, fuente: "real" };
  }
  const v: VentanaConduccion = planDur != null
    ? { reservaId: r.id, ini, fin: ini + planDur, fuente: "plan" }
    : { reservaId: r.id, ini, fin: ini + DUR_ESTIMADA_MIN, fuente: "estimado" };
  const ahora = aMin(r.en_curso_ahora);
  if (ahora != null) {
    const ahoraAl = alinear(ahora, ini);
    if (ahoraAl > v.fin && ahoraAl - ini <= DURACION_MAX_MIN) v.fin = ahoraAl;
  }
  return v;
}

// ══════════════════════════════════════════════════════════════════════════════════════
// LA JORNADA DE CONDUCCIÓN DE UN CONDUCTOR EN EL DÍA
// ══════════════════════════════════════════════════════════════════════════════════════

/** Qué tope se pasó. Se declara; las pantallas no lo deducen del texto. */
export type CodigoJornada = "continua" | "acumulada";

export type BloqueConduccion = {
  ini: number;
  fin: number;
  /** minutos conduciendo dentro del bloque (sin las pausas que no llegaron a descanso) */
  conduccionMin: number;
  /** 30.3: la mayor parte de su conducción cae entre las 22:00 y las 05:59 */
  nocturno: boolean;
  limiteMin: number;
  excede: boolean;
};

export type VeredictoJornada = {
  excede: boolean;
  codigos: CodigoJornada[];
  /** conducción del día: unión de las ventanas (dos servicios que se pisan no cuentan doble) */
  conduccionMin: number;
  limiteAcumuladoMin: number;
  bloques: BloqueConduccion[];
  /** primera salida → último fin. Informativo: NO decide nada (ver cabecera). */
  amplitudMin: number;
  /** el descanso más largo del día; null con un solo bloque de conducción */
  descansoMayorMin: number | null;
  servicios: number;
  /** servicios contados con el bloque de 4 h por no tener fin real ni itinerario */
  estimados: number;
  /** servicios sin ninguna hora: no se pudieron ubicar ni sumar */
  sinHora: number;
  /** una línea, sin saltos: va al chip, a la ficha y al WhatsApp del coordinador */
  motivo: string;
  /** el detalle por bloque, una línea cada uno, para la ficha */
  detalle: string[];
};

/** Minutos de [a, b) que caen en la noche del 30.3 (22:00–05:59), sobre cualquier día. */
function minutosNocturnos(a: number, b: number): number {
  let total = 0;
  // Ventanas nocturnas que pueden tocar [a, b): [22:00 del día d, 06:00 del día d+1).
  for (let d = Math.floor(a / DIA_MIN) - 1; d * DIA_MIN <= b; d++) {
    const nIni = d * DIA_MIN + NOCHE_DESDE_MIN;
    const nFin = (d + 1) * DIA_MIN + NOCHE_HASTA_MIN;
    total += Math.max(0, Math.min(b, nFin) - Math.max(a, nIni));
  }
  return total;
}

const hh = (m: number) => minutosAHhmm(m);

/**
 * Juzga la conducción de UN conductor en el día a partir de las ventanas de sus servicios.
 * `acumuladaMaxMin`: el tope acumulado (el umbral de la tarjeta, en minutos).
 */
export function evaluarJornada(
  ventanas: VentanaConduccion[],
  opts: { acumuladaMaxMin: number; sinHora?: number },
): VeredictoJornada {
  const vs = [...ventanas].sort((x, y) => x.ini - y.ini || x.fin - y.fin);
  const estimados = vs.filter((v) => v.fuente === "estimado").length;

  // Unión: dos servicios que se pisan son UNA conducción (el solape es otra alerta).
  const union: [number, number][] = [];
  for (const v of vs) {
    const ult = union[union.length - 1];
    if (ult && v.ini <= ult[1]) ult[1] = Math.max(ult[1], v.fin);
    else union.push([v.ini, v.fin]);
  }
  const conduccionMin = union.reduce((s, [a, b]) => s + (b - a), 0);

  // Bloques de conducción continua: una pausa que no llega al descanso mínimo NO los parte.
  type Acum = { ini: number; fin: number; cond: number; noche: number };
  const acc: Acum[] = [];
  let descansoMayorMin: number | null = null;
  for (const [a, b] of union) {
    const cur = acc[acc.length - 1];
    if (cur) {
      const pausa = a - cur.fin;
      const minimo = cur.cond < JORNADA_CORTA_MIN ? DESCANSO_CORTO_MIN : DESCANSO_MIN;
      if (pausa < minimo) {
        cur.fin = b; cur.cond += b - a; cur.noche += minutosNocturnos(a, b);
        continue;
      }
      descansoMayorMin = Math.max(descansoMayorMin ?? 0, pausa);
    }
    acc.push({ ini: a, fin: b, cond: b - a, noche: minutosNocturnos(a, b) });
  }
  const bloques: BloqueConduccion[] = acc.map((k) => {
    const nocturno = k.noche * 2 > k.cond;
    const limiteMin = nocturno ? CONTINUA_NOCTURNA_MAX_MIN : CONTINUA_DIURNA_MAX_MIN;
    return { ini: k.ini, fin: k.fin, conduccionMin: k.cond, nocturno, limiteMin, excede: k.cond > limiteMin };
  });

  const codigos: CodigoJornada[] = [];
  if (bloques.some((k) => k.excede)) codigos.push("continua");
  if (conduccionMin > opts.acumuladaMaxMin) codigos.push("acumulada");

  const amplitudMin = vs.length ? Math.max(...vs.map((v) => v.fin)) - Math.min(...vs.map((v) => v.ini)) : 0;

  // ── Textos (una sola redacción para la torre, la ficha y el WhatsApp) ──
  const partes: string[] = [];
  const peor = bloques.filter((k) => k.excede).sort((x, y) => (y.conduccionMin - y.limiteMin) - (x.conduccionMin - x.limiteMin))[0];
  if (peor) {
    partes.push(
      `Conduce ${textoDuracion(peor.conduccionMin)} seguidas (${hh(peor.ini)}–${hh(peor.fin)}) sin un descanso de ` +
      `${textoDuracion(DESCANSO_MIN)}: el máximo ${peor.nocturno ? "de noche" : "de día"} es ${textoDuracion(peor.limiteMin)}`,
    );
  }
  if (codigos.includes("acumulada")) {
    partes.push(`Conduce ${textoDuracion(conduccionMin)} en el día: el máximo es ${textoDuracion(opts.acumuladaMaxMin)}`);
  }
  if (partes.length) {
    if (estimados) partes.push(`${estimados} servicio(s) sin itinerario se contaron como ${textoDuracion(DUR_ESTIMADA_MIN)}`);
    partes.push(REFERENCIA_NORMA);
  }
  const motivo = partes.length
    ? partes.join(". ") + "."
    : `${textoDuracion(conduccionMin)} de conducción en el día` +
      (descansoMayorMin != null ? `, con descanso de hasta ${textoDuracion(descansoMayorMin)}` : "") +
      ": dentro de los topes.";

  const detalle = bloques.map((k) =>
    `${hh(k.ini)}–${hh(k.fin)} · ${textoDuracion(k.conduccionMin)} de conducción ` +
    `(máx. ${textoDuracion(k.limiteMin)} ${k.nocturno ? "de noche" : "de día"})${k.excede ? " — EXCEDE" : ""}`,
  );
  if (bloques.length > 1 && descansoMayorMin != null) {
    detalle.push(`Descanso más largo: ${textoDuracion(descansoMayorMin)} (no cuenta como conducción)`);
  }
  detalle.push(`Conducción del día: ${textoDuracion(conduccionMin)} de ${textoDuracion(opts.acumuladaMaxMin)} · amplitud ${textoDuracion(amplitudMin)}`);

  return {
    excede: codigos.length > 0, codigos, conduccionMin, limiteAcumuladoMin: opts.acumuladaMaxMin,
    bloques, amplitudMin, descansoMayorMin, servicios: vs.length, estimados, sinHora: opts.sinHora ?? 0,
    motivo, detalle,
  };
}

// ══════════════════════════════════════════════════════════════════════════════════════
// EL SOLAPE: ¿LA MISMA UNIDAD (O EL MISMO CONDUCTOR) PUEDE HACER LOS DOS SERVICIOS?
// ══════════════════════════════════════════════════════════════════════════════════════
//
// Lo reportó el dueño el 13-10-2026: «Posible solape de unidad» en servicios que la unidad SÍ
// alcanza a cubrir, «incluso con tráfico». La regla vieja suponía que todo servicio sin hora de
// fin real duraba 4 h desde su hora programada, así que una ENTRADA de las 05:50 y su RETORNO de
// las 07:00 —40 minutos de recorrido y una hora libre en la planta— salían como solape toda la
// mañana, hasta que el primero se cerraba. Y no miraba DÓNDE termina uno y empieza el otro.
//
// Ahora cada servicio usa la MISMA ventana que la jornada (`ventanaConduccion`: lo real, si no el
// itinerario de paraderos, y solo sin itinerario el bloque de 4 h) y el juicio va de la evidencia
// al supuesto, con su nivel declarado:
//   · `cruce`: los recorridos se pisan con duraciones conocidas (o salen con menos de 30 min de
//     diferencia, que ninguna duración salva). La unidad no puede estar en los dos.
//   · `traslado_justo`: no se pisan, pero entre el último paradero de uno y el primero del
//     siguiente no da el tiempo ni a velocidad de ciudad (`trasladoMin`).
//   · `posible`: se pisan SOLO porque uno no tiene itinerario ni hora de fin y se le supusieron
//     4 h. No se afirma: se dice qué falta para saberlo.
// Sin coordenadas en algún extremo el traslado no se juzga (no se acusa por falta de un dato).

/**
 * Velocidad con la que se estima un traslado entre servicios, ya con tráfico de Lima, y cuánto
 * más larga es la calle que la línea recta. NO MEDIDOS y declarados: con ellos 10 km en línea
 * recta son ~31 min. Es una cota para decir «no llega», no un ETA: el lado que evita falsos
 * avisos es SUBIR la velocidad; el que no deja pasar un doble agendamiento, bajarla.
 */
export const VEL_TRASLADO_KMH = 25;
export const FACTOR_RUTA = 1.3;

/** Minutos estimados de traslado entre dos puntos, o null sin coordenadas. */
export function trasladoMin(a: PuntoGeo | null | undefined, b: PuntoGeo | null | undefined): number | null {
  if (!a || !b) return null;
  const km = (distM(a.lat, a.lng, b.lat, b.lng) / 1000) * FACTOR_RUTA;
  return Math.round((km / VEL_TRASLADO_KMH) * 60);
}

export type NivelSolape = "cruce" | "traslado_justo" | "posible";
/** Cuánto pesa cada nivel: el que se enseña es el peor de una reserva. */
const PESO_SOLAPE: Record<NivelSolape, number> = { posible: 1, traslado_justo: 2, cruce: 3 };

export type SolapeReserva = {
  nivel: NivelSolape;
  /** las otras reservas con las que choca */
  con: number[];
  /** una línea por choque, lista para la ficha y el título del chip; la PRIMERA es la del choque
   *  más grave (la que va en el WhatsApp) */
  detalle: string[];
};

/**
 * Juzga, para cada grupo (una unidad, un conductor), qué servicios no se pueden hacer seguidos.
 * `clave` dice a qué grupo va cada reserva (null = no se juzga). Las canceladas no cuentan.
 */
export function juzgarSolapes(
  reservas: ReservaFlota[],
  clave: (r: ReservaFlota) => string | null,
): Map<number, SolapeReserva> {
  const out = new Map<number, SolapeReserva>();
  const grupos = new Map<string, { r: ReservaFlota; v: VentanaConduccion }[]>();
  for (const r of reservas) {
    if (r.estado === "cancelada") continue;
    const k = clave(r); if (!k) continue;
    const v = ventanaConduccion(r); if (!v) continue;
    const g = grupos.get(k) ?? [];
    g.push({ r, v }); grupos.set(k, g);
  }
  const marcar = (id: number, otro: number, nivel: NivelSolape, texto: string) => {
    const x = out.get(id) ?? { nivel, con: [], detalle: [] };
    if (!x.con.includes(otro)) x.con.push(otro);
    // El texto del choque más grave va PRIMERO: es el que viaja en el WhatsApp (detalle[0]).
    if (PESO_SOLAPE[nivel] > PESO_SOLAPE[x.nivel]) { x.nivel = nivel; x.detalle.unshift(texto); }
    else x.detalle.push(texto);
    out.set(id, x);
  };
  const nombre = (r: ReservaFlota) => r.rotulo || `Reserva #${r.id}`;

  for (const g of grupos.values()) {
    g.sort((x, y) => x.v.ini - y.v.ini || x.v.fin - y.v.fin);
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const A = g[i], B = g[j];
        const finConocido = A.v.fuente !== "estimado";
        const arranqueJunto = B.v.ini - A.v.ini < DUR_MIN_FIABLE_MIN;
        let nivel: NivelSolape | null = null;
        let texto = "";
        if (B.v.ini < A.v.fin) {
          if (finConocido || arranqueJunto) {
            nivel = "cruce";
            // Un servicio EN CURSO lleva su fin hasta ahora (`ventanaConduccion`): ese fin no es
            // una hora de término, es que sigue abierto. Decir «termina a las…» sería inventarla.
            const sigueAbierto = A.r.hora_real_fin == null && aMin(A.r.en_curso_ahora) != null
              && alinear(aMin(A.r.en_curso_ahora)!, A.v.ini) === A.v.fin;
            texto = arranqueJunto && !finConocido
              ? `Sale a las ${hh(B.v.ini)}, ${B.v.ini - A.v.ini} min después de ${nombre(A.r)} (${hh(A.v.ini)}): no da tiempo a terminar uno y empezar el otro.`
              : sigueAbierto
                ? `${nombre(A.r)} sigue en curso a las ${hh(A.v.fin)} y este debía salir a las ${hh(B.v.ini)}: o se va a atrasar, o aquel no se cerró en el app.`
                : `${nombre(A.r)} termina a las ${hh(A.v.fin)} y este sale a las ${hh(B.v.ini)}: los recorridos se pisan ${A.v.fin - B.v.ini} min.`;
          } else {
            nivel = "posible";
            texto = `${nombre(A.r)} (${hh(A.v.ini)}) no tiene itinerario ni hora de fin: se le supusieron ${textoDuracion(DUR_ESTIMADA_MIN)} y con eso se pisaría con este (${hh(B.v.ini)}). ` +
              "Con sus paraderos y horas, o al cerrarse, se sabrá si de verdad se cruzan.";
          }
        } else if (j === i + 1 && finConocido) {
          // Solo el siguiente inmediato: el traslado se juzga entre servicios consecutivos.
          const t = trasladoMin(A.r.plan_destino, B.r.plan_origen);
          const libre = B.v.ini - A.v.fin;
          if (t != null && libre < t) {
            nivel = "traslado_justo";
            texto = `${nombre(A.r)} termina a las ${hh(A.v.fin)} y este sale a las ${hh(B.v.ini)}: ${textoDuracion(libre)} para un traslado ` +
              `que se estima en ${textoDuracion(t)} a velocidad de ciudad.`;
          }
        }
        if (nivel) {
          marcar(A.r.id, B.r.id, nivel, texto);
          marcar(B.r.id, A.r.id, nivel, texto);
        }
      }
    }
  }
  return out;
}

/** Los niveles que de verdad afirman un choque (los que avisan por WhatsApp). */
export function solapeAfirmado(s: SolapeReserva | null | undefined): boolean {
  return !!s && s.nivel !== "posible";
}

/**
 * El titular de un solape para la torre y la ficha. Vive aquí, junto a los niveles, para que la
 * fila y la ficha digan lo mismo y ninguna vuelva a llamar «posible» a un choque afirmado (ni al
 * revés: afirmar uno que solo sale de suponer 4 h).
 */
export function tituloSolape(nivel: NivelSolape, recurso: "unidad" | "conductor"): string {
  const sujeto = recurso === "unidad" ? "La unidad" : "El conductor";
  switch (nivel) {
    case "cruce": return `${sujeto} tiene dos servicios que se pisan`;
    case "traslado_justo": return `${sujeto} no llega a tiempo de un servicio al siguiente`;
    case "posible": return `Solape de ${recurso} sin confirmar: falta el itinerario de un servicio`;
  }
}

/**
 * Detecta, sobre las reservas de un día, qué conductores tienen servicios que no se pueden hacer
 * seguidos (`juzgarSolapes`) y cuáles pasan los topes de conducción (`evaluarJornada`).
 *
 * `solape` y `jornada` devuelven, por reserva marcada, el conductor_id involucrado — para poder
 * notificar. `solape` lleva SOLO los choques afirmados (`cruce`, `traslado_justo`): el `posible`
 * es falta de un dato, no un choque, y por WhatsApp sería ruido. `solapes` trae el detalle de
 * todos y `veredictos` el juicio de jornada de CADA conductor (pase o no), con su evidencia.
 */
export function detectarSolapesJornada(
  reservas: ReservaFlota[],
  opts: { acumuladaMaxH: number },
): {
  solape: Map<number, number>; jornada: Map<number, number>;
  solapes: Map<number, SolapeReserva>; veredictos: Map<number, VeredictoJornada>;
} {
  const solape = new Map<number, number>();  // reserva_id → conductor_id
  const jornada = new Map<number, number>();
  const veredictos = new Map<number, VeredictoJornada>(); // conductor_id → veredicto
  const acumuladaMaxMin = Math.round(opts.acumuladaMaxH * 60);

  // Agrupar por conductor (solo propios con conductor asignado, no cancelados).
  const grupos = new Map<number, ReservaFlota[]>();
  for (const r of reservas) {
    if (r.estado === "cancelada") continue;
    if (!r.conductor_id) continue;
    let g = grupos.get(r.conductor_id);
    if (!g) { g = []; grupos.set(r.conductor_id, g); }
    g.push(r);
  }

  const solapes = juzgarSolapes(reservas, (r) => (r.conductor_id ? `c${r.conductor_id}` : null));
  for (const r of reservas) {
    if (r.conductor_id && solapeAfirmado(solapes.get(r.id))) solape.set(r.id, r.conductor_id);
  }

  for (const [condId, g] of grupos) {
    // Jornada de CONDUCCIÓN (no la amplitud del día ni el número de servicios).
    const ventanas = g.map(ventanaConduccion).filter((v): v is VentanaConduccion => !!v);
    const v = evaluarJornada(ventanas, { acumuladaMaxMin, sinHora: g.length - ventanas.length });
    veredictos.set(condId, v);
    if (v.excede) for (const r of g) jornada.set(r.id, condId);
  }

  return { solape, jornada, solapes, veredictos };
}
