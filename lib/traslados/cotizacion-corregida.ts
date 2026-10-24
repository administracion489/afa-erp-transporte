// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/cotizacion-corregida.ts — ¿Puede la IA usar una cotización de traslado que una PERSONA
// corrigió después de que la IA la escribió? Motor PURO: no lee la base ni mira el reloj (`ahoraMs`
// entra por parámetro). Lo leen lib/traslados/reserva-solicitud-datos.ts y cotizar-ia-datos.ts.
//
// EL CASO (hallazgo C de la revisión de seguridad, 24-10-2026): después de enviar la cotización, quien
// tiene el módulo Cotizaciones puede editar la fila (importes, la política de reserva, su resumen…), y
// los pasos de la reserva la leían tal cual y la mandaban SOLOS desde el número oficial: el pedido del
// adelanto con las cuentas (T1), su reenvío, las políticas al pie de la letra (T8) y el «ya te la
// envié» con el total.
//
// LA REGLA (decisión del dueño, 24-10-2026): «Que sí la dé, siempre en cuando respete los tiempos de
// actividad del ejecutivo, es decir solo cuando la IA se vuelve a activar por inactividad del ejecutivo
// que ya están configuradas». Corregir la cotización ES actividad del ejecutivo, y cuenta como una
// respuesta suya en el chat: la IA la usa recién cuando pasó `pausa_humano_horas` desde la última vez
// que una persona la tocó (`cotizaciones.editada_at`, supabase/cotizaciones-10-actividad-ejecutivo.sql),
// o antes si alguien REACTIVÓ la IA en el chat DESPUÉS de esa corrección (`ia_reactivada_at`).
//
// LOS CÓDIGOS, de la evidencia al juicio (gana el primero que aplica):
//   sin_cambios      la fila es la que escribió la IA (su huella coincide)              → usa
//   pausa_apagada    `pausa_humano_horas` ≤ 0: la configuración no aparta a la IA       → usa
//   sin_hora         corregida y no se sabe cuándo (falta la columna, la lectura falló,
//                    o la hora no se entiende)                                          → ESPERA
//   sin_persona      corregida, y ninguna sesión del ERP la tocó desde que existe la
//                    columna (la cambió un proceso del servidor: el cambio de clave de
//                    una categoría, «Vincular cliente»…)                                → usa
//   reactivada       alguien reactivó la IA en el chat DESPUÉS de la corrección         → usa
//   pausa_cumplida   pasaron las N h desde la corrección                                → usa
//   ejecutivo_activo la corrección es de hace menos de N h                              → ESPERA (retomaMs)
// La frontera es la del chat (`inicioVentanaHumano` + `gte`, lib/crm-ia-reactivacion.ts): una
// corrección de hace EXACTAMENTE N h todavía aparta a la IA, igual que una respuesta en el chat. La
// matriz cruza esta regla con `inicioVentanaHumano` en todo el barrido.
//
// LO QUE NO HACE: decidir qué se envía. Quien llama, con `usar: false`, no deriva (derivar pausa la IA
// para siempre, y la decisión es que vuelva sola): manda un aviso sin importes ni políticas y deja una
// nota para el ejecutivo.
// Matriz: npx tsx scripts/prueba-cotizacion-corregida.mts
// ──────────────────────────────────────────────────────────────────────────────

import { HORAS_PAUSA_DEFECTO } from "../crm-ia-reactivacion";
import { fechaLima, minutoDelDiaLima, minutosAHhmm } from "../alertas-horario";
import { aLas } from "../crm-ia-atencion";

/** La migración que registra la última actividad de una persona en la cotización. */
export const SQL_ACTIVIDAD_EJECUTIVO = "supabase/cotizaciones-10-actividad-ejecutivo.sql";

export type CodigoCorreccion =
  | "sin_cambios" | "pausa_apagada" | "sin_hora" | "sin_persona" | "reactivada" | "pausa_cumplida" | "ejecutivo_activo";

/** Cada código, si deja usar la fila corregida y qué dice de ella (para las notas internas). */
export const CORRECCION: Record<CodigoCorreccion, { usar: boolean; texto: string }> = {
  sin_cambios: { usar: true, texto: "La cotización es la que escribió la IA." },
  pausa_apagada: { usar: true, texto: "La pausa tras la actividad de una persona está apagada (0 h en /crm/agente → Ajustes)." },
  sin_hora: { usar: false, texto: `La cotización se corrigió después de enviarla y no se sabe cuándo (falta correr ${SQL_ACTIVIDAD_EJECUTIVO}, o no se pudo leer).` },
  sin_persona: { usar: true, texto: "Ninguna sesión del ERP la tocó desde que se registra la actividad: la cambió un proceso del sistema." },
  reactivada: { usar: true, texto: "Alguien reactivó la IA en este chat después de la corrección." },
  pausa_cumplida: { usar: true, texto: "Ya pasó la pausa desde la última corrección." },
  ejecutivo_activo: { usar: false, texto: "Una persona corrigió la cotización hace menos de la pausa configurada." },
};

export const CODIGOS_CORRECCION = Object.keys(CORRECCION) as CodigoCorreccion[];

export type JuicioCorreccion = {
  codigo: CodigoCorreccion;
  /** ¿Se puede usar la fila tal como está ahora? */
  usar: boolean;
  /** Las horas de pausa con que se juzgó (las del agente, normalizadas). */
  horas: number;
  /** Cuándo la tocó una persona por última vez (null si no se sabe o si no aplica). */
  editadaMs: number | null;
  /** Desde cuándo la IA la usaría (solo con `ejecutivo_activo`). */
  retomaMs: number | null;
};

const msDe = (iso: unknown): number | null => {
  if (typeof iso !== "string" || !iso.trim()) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** Las horas de la pausa: un número (≤ 0 apaga); lo que no es un número, el defecto (12). */
export const horasDePausa = (h: unknown): number => (typeof h === "number" && Number.isFinite(h) ? h : HORAS_PAUSA_DEFECTO);

/**
 * El juicio sobre una cotización (ver la cabecera). `editada`: la huella guardada al crearla no es la
 * de la fila de ahora, o no se puede comprobar (`filaEditada`). `editadaAt`: `cotizaciones.editada_at`
 * — un texto ISO, null («ninguna persona la tocó desde que existe la columna») o undefined (la columna
 * no existe o la lectura falló: no se sabe). `reactivadaAt`: `crm_conversaciones.ia_reactivada_at`
 * (null o undefined = no se reactivó, o no se sabe: lo mismo).
 */
export function juzgarCotizacionCorregida(x: {
  editada: boolean;
  editadaAt: string | null | undefined;
  horasPausa: number;
  reactivadaAt: string | null | undefined;
  ahoraMs: number;
}): JuicioCorreccion {
  const horas = horasDePausa(x.horasPausa);
  const j = (codigo: CodigoCorreccion, editadaMs: number | null = null, retomaMs: number | null = null): JuicioCorreccion =>
    ({ codigo, usar: CORRECCION[codigo].usar, horas, editadaMs, retomaMs });
  if (x.editada !== true) return j("sin_cambios");
  if (horas <= 0) return j("pausa_apagada");
  if (x.editadaAt === undefined) return j("sin_hora");
  if (x.editadaAt === null) return j("sin_persona");
  const ed = msDe(x.editadaAt);
  if (ed == null || !Number.isFinite(x.ahoraMs)) return j("sin_hora");
  const re = msDe(x.reactivadaAt);
  if (re != null && re > ed) return j("reactivada", ed);
  const pausaMs = horas * 3_600_000;
  if (x.ahoraMs - pausaMs > ed) return j("pausa_cumplida", ed);
  return j("ejecutivo_activo", ed, ed + pausaMs);
}

/** ¿Se puede usar la cotización como está? (el `usar` del código). */
export const puedeUsar = (j: Pick<JuicioCorreccion, "codigo">): boolean => CORRECCION[j.codigo]?.usar === true;

/**
 * Una hora para una nota interna, en Lima: «15:30» si es el mismo día que `ahoraMs`, «15:30 del 25/10»
 * si no. null sin instante. Lo que lee un ejecutivo, no el cliente (al cliente no se le promete una hora).
 */
export function horaLimaNota(ms: number | null | undefined, ahoraMs: number): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  const hhmm = minutosAHhmm(minutoDelDiaLima(ms));
  const dia = fechaLima(ms);
  return Number.isFinite(ahoraMs) && dia === fechaLima(ahoraMs) ? hhmm : `${hhmm} del ${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
}

/** «12 h», «1 h», «1.5 h». */
const textoHoras = (h: number) => `${Math.round(h * 100) / 100} h`;

/** Lo que la IA deja de enviar mientras espera, y cómo lo envía el ejecutivo. */
export type LoQueEspera = "adelanto" | "politicas" | "importes" | "adelanto_esperado";

const ESPERA: Record<LoQueEspera, { cosa: string; tu: string }> = {
  adelanto: { cosa: "el pedido de adelanto con las cuentas", tu: "Envíaselo tú si el cliente lo necesita antes" },
  politicas: { cosa: "las políticas de reserva, cambios y cancelación", tu: "Envíaselas tú si el cliente las necesita antes" },
  importes: { cosa: "los importes de la cotización", tu: "Envíaselos tú si el cliente los necesita antes" },
  adelanto_esperado: { cosa: "el monto del adelanto al confirmar el comprobante", tu: "Díselo tú si hace falta" },
};

/**
 * La nota interna cuando la IA ESPERA (`usar: false`): qué no envió, desde cuándo lo enviaría y cómo
 * lo destraba el ejecutivo. null si el juicio deja usar la fila (no hay nada que avisar).
 */
export function notaEsperaCorreccion(j: JuicioCorreccion, x: { numero: string | null; que: LoQueEspera; ahoraMs: number }): string | null {
  if (j.usar) return null;
  const n = x.numero ? `N° ${x.numero} ` : "";
  const e = ESPERA[x.que];
  if (j.codigo === "ejecutivo_activo") {
    const desde = horaLimaNota(j.editadaMs, x.ahoraMs), hasta = horaLimaNota(j.retomaMs, x.ahoraMs);
    return `🕒 La cotización ${n}se corrigió a ${aLas(desde ?? "")}. La IA no envía ${e.cosa} hasta ${aLas(hasta ?? "")} (pausa de ${textoHoras(j.horas)} desde la última actividad en la cotización). ${e.tu}, o reactiva la IA en este chat (🤖) cuando termines de corregirla.`;
  }
  return `🕒 La cotización ${n}se corrigió después de que la IA la escribió y no se sabe a qué hora (falta correr ${SQL_ACTIVIDAD_EJECUTIVO}, o no se pudo leer): la IA no envía ${e.cosa} con la cotización corregida. ${e.tu}.`;
}

/**
 * Lo que queda escrito en la solicitud (`reserva_solicitudes.nota`, la tarjeta lo muestra) cuando el
 * pedido del adelanto se pasó a «disponibilidad primero» por una corrección. null si no aplica.
 */
export function notaSolicitudCorregida(j: JuicioCorreccion, ahoraMs: number): string | null {
  if (j.usar) return null;
  if (j.codigo === "ejecutivo_activo") {
    return `La cotización se corrigió a ${aLas(horaLimaNota(j.editadaMs, ahoraMs) ?? "")}: el adelanto lo pide el ejecutivo desde la tarjeta (la IA lo pediría desde ${aLas(horaLimaNota(j.retomaMs, ahoraMs) ?? "")}).`;
  }
  return "La cotización se corrigió después de enviarla y no se sabe a qué hora: el adelanto lo pide el ejecutivo desde la tarjeta.";
}

/**
 * La nota interna cuando la IA SÍ usó una cotización corregida para pedir el adelanto (una vez, al
 * crear la solicitud): que el ejecutivo sepa que salió con la fila editada. null si la fila no estaba
 * corregida o si el juicio fue esperar.
 */
export function notaUsoCorreccion(j: JuicioCorreccion, x: { numero: string | null; ahoraMs: number }): string | null {
  if (!j.usar || j.codigo === "sin_cambios") return null;
  const n = x.numero ? `N° ${x.numero} ` : "";
  const por =
    j.codigo === "pausa_cumplida" ? `la última corrección de una persona fue a ${aLas(horaLimaNota(j.editadaMs, x.ahoraMs) ?? "")} y ya pasó la pausa de ${textoHoras(j.horas)}`
    : j.codigo === "reactivada" ? "alguien reactivó la IA en este chat después de la corrección"
    : j.codigo === "pausa_apagada" ? "la pausa tras la actividad de una persona está apagada (0 h)"
    : "ninguna sesión del ERP la tocó desde que se registra la actividad (la cambió un proceso del sistema)";
  return `📅 El pedido de adelanto de la cotización ${n}salió con la cotización CORREGIDA (no es la que escribió la IA): ${por}. Revisa que los importes y las condiciones sean los que corresponden.`;
}
