// lib/crm-ia-atencion.ts — EL HORARIO DE ATENCIÓN DEL EQUIPO, para lo que dice el agente IA del CRM.
// Módulo PURO: no lee la base ni mira el reloj; la fecha (ISO de Lima) y la hora entran por parámetro.
//
// NO ES EL HORARIO DE LA IA. `crm_agentes_ia.hora_inicio/hora_fin` dice cuándo la IA contesta sola;
// éste dice cuándo hay una PERSONA del equipo para atender. Solo sirve para que la derivación no
// prometa una respuesta inmediata un sábado a las 18:00: «un ejecutivo le responderá el lunes desde
// las 09:00». Antes ese dato vivía tres veces en texto libre (la persona, «Sobre la empresa» y la base
// de conocimiento), con tres horarios distintos, y el código no leía ninguno.
//
// Vive en `comportamiento` (lib/crm-ia-ajustes.ts: atencion_activa, atencion_dias, atencion_desde,
// atencion_hasta). Un horario sin días o con el cierre antes de la apertura se CONSERVA tal cual lo
// escribió la persona (no se le inventa otro), pero no se usa: atencionValida = false, no entra al
// prompt y la pantalla lo pinta en ámbar con `PROBLEMA_ATENCION`.

import { diaSemanaLima, sumarDias } from "@/lib/comisiones/calendario";
import { hhmmAMinutos } from "@/lib/alertas-horario";
import { horaHHMM, type AjustesIA, type Tratamiento } from "@/lib/crm-ia-ajustes";

export type Atencion = {
  /** La persona lo declaró. Apagado no se usa aunque los días y las horas estén bien. */
  activa: boolean;
  /** 0 = domingo … 6 = sábado. */
  dias: number[];
  /** "HH:MM" de Lima. La hora de cierre NO está dentro (de 09:00 a 17:00: a las 17:00 ya cerró). */
  desde: string;
  hasta: string;
};

/** El horario de atención de unos ajustes (ya normalizados por `normalizarAjustes`). */
export function atencionDe(
  aj: Pick<AjustesIA, "atencion_activa" | "atencion_dias" | "atencion_desde" | "atencion_hasta">,
): Atencion {
  return {
    activa: aj.atencion_activa === true,
    dias: Array.isArray(aj.atencion_dias) ? [...aj.atencion_dias] : [],
    desde: aj.atencion_desde,
    hasta: aj.atencion_hasta,
  };
}

export type ProblemaAtencion = "sin_dias" | "dias_invalidos" | "hora_invalida" | "cierre_no_posterior";

/** Qué le falta al horario para poder usarse, o null si se puede. No mira `activa`. */
export function problemaAtencion(at: Atencion): ProblemaAtencion | null {
  if (!Array.isArray(at.dias) || at.dias.length === 0) return "sin_dias";
  if (at.dias.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return "dias_invalidos";
  const desde = minutos(at.desde), hasta = minutos(at.hasta);
  if (desde == null || hasta == null) return "hora_invalida";
  return hasta > desde ? null : "cierre_no_posterior";
}

/** La frase con que la pantalla explica por qué no se usa (y dónde se arregla). */
export const PROBLEMA_ATENCION: Record<ProblemaAtencion, string> = {
  sin_dias: "No marcaste ningún día de atención: el horario no se usa hasta que marques al menos uno.",
  dias_invalidos: "Los días de atención no se entienden: vuelve a marcarlos.",
  hora_invalida: "Las horas de atención no se entienden: escríbelas como 09:00.",
  cierre_no_posterior:
    "La hora de cierre tiene que ser posterior a la de apertura (un horario que cruza la medianoche no se admite): el horario no se usa.",
};

/** Se puede usar: tiene días y el cierre es posterior a la apertura. No mira `activa`. */
export function atencionValida(at: Atencion): boolean {
  return problemaAtencion(at) === null;
}

/** Declarado y válido: lo único que entra al prompt y a la derivación. */
export function atencionEnUso(at: Atencion): boolean {
  return at.activa === true && atencionValida(at);
}

// ── Cómo se dice ──────────────────────────────────────────────────────────────────────────────────

const NOMBRE_DIA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
/** La semana empieza el lunes (así se dice en Perú: «de lunes a sábado», no «de domingo a…»). */
const ORDEN = [1, 2, 3, 4, 5, 6, 0];
const posicion = (d: number) => ORDEN.indexOf(d);

function lista(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

/** «de lunes a sábado» · «lunes, miércoles y viernes» · «sábado y domingo» · «todos los días».
 *  Tres o más días seguidos son un rango; dos seguidos, «x y y». La semana da la vuelta: con sábado,
 *  domingo y lunes se dice «de sábado a lunes». */
export function describirDias(dias: number[]): string {
  const sel = new Set((Array.isArray(dias) ? dias : []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  if (sel.size === 0) return "ningún día";
  if (sel.size === 7) return "todos los días";
  if (sel.size === 1) {
    const [d] = [...sel];
    return `los ${NOMBRE_DIA[d]}${NOMBRE_DIA[d].endsWith("s") ? "" : "s"}`;
  }
  // Se empieza en el tramo que contiene el lunes (para que lun-sáb no salga como «sábado, lunes…»),
  // o, si no hay lunes, en el primer día que abre un tramo en el orden de la semana.
  const abreTramo = (d: number) => sel.has(d) && !sel.has(ORDEN[(posicion(d) + 6) % 7]);
  let inicio = ORDEN.find(abreTramo)!;
  if (sel.has(1)) {
    let p = posicion(1);
    while (sel.has(ORDEN[(p + 6) % 7])) p = (p + 6) % 7;
    inicio = ORDEN[p];
  }
  const tramos: number[][] = [];
  for (let k = 0, p = posicion(inicio); k < 7; k++, p = (p + 1) % 7) {
    const d = ORDEN[p];
    if (!sel.has(d)) continue;
    const ultimo = tramos[tramos.length - 1];
    if (ultimo && ultimo[ultimo.length - 1] === ORDEN[(p + 6) % 7]) ultimo.push(d);
    else tramos.push([d]);
  }
  const items = tramos.flatMap((t) =>
    t.length >= 3 ? [`de ${NOMBRE_DIA[t[0]]} a ${NOMBRE_DIA[t[t.length - 1]]}`] : t.map((d) => NOMBRE_DIA[d]),
  );
  return lista(items);
}

/** «de lunes a sábado, de 09:00 a 17:00». */
export function describirAtencion(at: Atencion): string {
  return `${describirDias(at.dias)}, de ${at.desde} a ${at.hasta}`;
}

// ── Dónde cae un momento ──────────────────────────────────────────────────────────────────────────

const minutos = (hhmm: unknown): number | null => {
  const h = horaHHMM(hhmm);
  return h == null ? null : hhmmAMinutos(h);
};
const fechaValida = (f: unknown): f is string =>
  typeof f === "string" && /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(`${f}T12:00:00Z`));

/** ¿Ese momento (fecha ISO de Lima + "HH:MM") cae dentro del horario? Un horario que no se puede
 *  usar, o una fecha/hora que no se entiende, no está dentro de nada. No mira `activa`. */
export function dentroDeAtencion(at: Atencion, fecha: string, hhmm: string): boolean {
  const m = minutos(hhmm);
  if (!atencionValida(at) || !fechaValida(fecha) || m == null) return false;
  return at.dias.includes(diaSemanaLima(fecha)) && m >= minutos(at.desde)! && m < minutos(at.hasta)!;
}

/** «las 09:00», pero «la 01:00». */
const aLas = (hhmm: string) => (hhmm.startsWith("01:") ? `la ${hhmm}` : `las ${hhmm}`);

/** Cuándo vuelve a atender una persona, dicho para el cliente: «hoy desde las 09:00»,
 *  «mañana martes desde las 09:00», «el lunes desde las 09:00» (o «el próximo lunes» si falta una
 *  semana entera). Dentro del horario, «ahora». null si el horario no se puede usar o la fecha/hora
 *  no se entiende: no se inventa una respuesta. No mira `activa`. */
export function proximaAtencion(at: Atencion, fecha: string, hhmm: string): string | null {
  const m = minutos(hhmm);
  if (!atencionValida(at) || !fechaValida(fecha) || m == null) return null;
  const desde = minutos(at.desde)!, hasta = minutos(at.hasta)!;
  const abre = `desde ${aLas(horaHHMM(at.desde)!)}`;
  if (at.dias.includes(diaSemanaLima(fecha))) {
    if (m < desde) return `hoy ${abre}`;
    if (m < hasta) return "ahora";
  }
  for (let k = 1; k <= 7; k++) {
    const d = diaSemanaLima(sumarDias(fecha, k));
    if (!at.dias.includes(d)) continue;
    if (k === 1) return `mañana ${NOMBRE_DIA[d]} ${abre}`;
    return `${k === 7 ? "el próximo" : "el"} ${NOMBRE_DIA[d]} ${abre}`;
  }
  return null; // inalcanzable con un horario válido (tiene al menos un día)
}

/** Lo que se añade a la derivación fuera del horario, con su espacio inicial:
 *  « Nuestro horario de atención es de lunes a sábado, de 09:00 a 17:00; un ejecutivo le responderá
 *  el lunes desde las 09:00.» (con tú, «te responderá»). "" si el horario no está en uso (apagado o
 *  inválido), si ese momento cae dentro de él, o si la fecha/hora no se entiende: así quien la usa
 *  puede añadirla siempre, y una plantilla con {atencion} queda limpia en horario. */
export function fraseFueraDeAtencion(at: Atencion, fecha: string, hhmm: string, t: Tratamiento): string {
  if (!atencionEnUso(at) || dentroDeAtencion(at, fecha, hhmm)) return "";
  const prox = proximaAtencion(at, fecha, hhmm);
  if (!prox || prox === "ahora") return "";
  return ` Nuestro horario de atención es ${describirAtencion(at)}; un ejecutivo ${t === "tu" ? "te" : "le"} responderá ${prox}.`;
}
