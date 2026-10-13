// lib/servicio-abandonado.ts — EL AVISO DE «SERVICIO SIN CERRAR» RESPETA EL SUEÑO DEL COORDINADOR.
// Módulo PURO: no lee la base, no envía nada y no mira el reloj por su cuenta. Lo usa el bloque 7
// de /api/alertas-flota/tick. Matriz: `npx tsx scripts/prueba-servicio-abandonado.mts`.
//
// EL CASO (reportado por el dueño, 13-10-2026): «aquí falta respetar la hora de sueño del
// coordinador». El bloque 7 cierra como `finalizada` el servicio de un día anterior que sigue
// «en curso» 30 h después de su hora, y en ese MISMO tick le escribía a los contactos marcados.
// El tick corre cada 10 min, así que el umbral se cruza a cualquier hora: un servicio de las
// 22:00 se cerraba —y despertaba al coordinador— a las 04:00 del día subsiguiente.
//
// LO QUE NO SE TOCA ES EL CIERRE. Es integridad, no una alerta: mientras siga «en curso», la app
// del pasajero se queda anclada a ese servicio viejo. Cerrar a las 04:00 no molesta a nadie.
// Lo que espera es el WhatsApp.
//
// Y ESPERAR OBLIGA A RECORDAR. Una vez cerrado, el servicio deja de ser «en curso» y el tick
// siguiente ya no lo encuentra: retenerlo «como el bloque 1» (que vuelve a detectar el mismo diff
// en cada tick) lo PERDERÍA. Por eso el cierre deja un marcador en `alerta_enviada`
// (clave `servicio_abandonado_espera`, ref = la reserva, fecha = el día del cierre) y el aviso se
// despacha DESDE los marcadores, no desde el cierre. Es lo mismo que pasa siempre, haya o no
// horario: así un envío que falla también se reintenta — antes `liberarEnvio` soltaba el reclamo
// de una reserva que ningún tick volvía a mirar, y el aviso se perdía igual.
//
// AL ABRIR EL HORARIO SALE UN SOLO MENSAJE. Lo cerrado de noche son varios servicios a la vez, y
// un WhatsApp por servicio a las 07:00 es la misma molestia en otro horario. Con uno solo, el
// texto de siempre; con varios, la lista (mismo criterio que «Recordar llamar al conductor»).

import { fechaLima, minutosAHhmm, minutoDelDiaLima, planDeEnvioAviso, type Horario, type PlanEnvio } from "@/lib/alertas-horario";
import { listaEnUnaLinea } from "@/lib/escalera-inicio";

/** Clave del marcador «este aviso está pendiente» en `alerta_enviada`. */
export const CLAVE_ESPERA_ABANDONADO = "servicio_abandonado_espera";

/**
 * Días que un marcador puede esperar antes de darse por vencido. Ninguna ventana diaria retiene
 * más de 24 h, así que 2 cubre además un día sin cron. NO MEDIDO y declarado: un aviso de un
 * cierre de hace tres días ya no le dice nada útil a nadie, y los marcadores no pueden crecer
 * para siempre si la tarjeta queda encendida sin contactos.
 */
export const DIAS_ESPERA_MAX = 2;

/** Largo máximo de la lista en el parámetro de la plantilla (el mismo de «Recordar llamar»). */
export const LARGO_LISTA = 600;

export type Pendiente = { ref: string; fecha: string };

export type CodigoPendiente =
  /** Sale en este tick. */
  | "enviar"
  /** Fuera del horario de envío: espera a que abra. */
  | "espera"
  /** La tarjeta está apagada: «Apagada sigue cerrando: solo deja de avisar». */
  | "tarjeta_apagada"
  /** Lleva más de DIAS_ESPERA_MAX días esperando. */
  | "vencido"
  /** El marcador no trae una fecha o un ref utilizables. */
  | "invalido";

export type PlanPendientes = {
  enviar: Pendiente[];
  esperan: Pendiente[];
  descartar: { p: Pendiente; codigo: Exclude<CodigoPendiente, "enviar" | "espera"> }[];
  /** El plan de la ventana (null si la tarjeta está apagada: no se juzga). */
  plan: PlanEnvio | null;
};

/** Días entre dos fechas ISO (b − a). NaN si alguna no es fecha. */
function diasEntre(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`), tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * Qué hacer con cada marcador pendiente en este tick. Parte los marcadores en tres conjuntos
 * DISJUNTOS y EXHAUSTIVOS (la matriz lo barre): uno que no saliera en ninguno sería un aviso que
 * ni sale, ni espera, ni se borra — un marcador que queda para siempre sin que nadie lo explique.
 */
export function planDePendientes(args: {
  ahoraMs: number;
  /** La tarjeta encendida (null/false: apagada). */
  activa: boolean;
  horario: Horario;
  pendientes: Pendiente[];
}): PlanPendientes {
  const hoy = fechaLima(args.ahoraMs);
  const out: PlanPendientes = { enviar: [], esperan: [], descartar: [], plan: null };
  const vivos: Pendiente[] = [];
  for (const p of args.pendientes) {
    const fecha = String(p?.fecha ?? "").slice(0, 10);
    const dias = diasEntre(fecha, hoy);
    if (!p?.ref || !Number.isFinite(dias)) { out.descartar.push({ p, codigo: "invalido" }); continue; }
    if (!args.activa) { out.descartar.push({ p, codigo: "tarjeta_apagada" }); continue; }
    if (dias > DIAS_ESPERA_MAX) { out.descartar.push({ p, codigo: "vencido" }); continue; }
    vivos.push(p);
  }
  if (!args.activa) return out;
  out.plan = planDeEnvioAviso({ ahoraMs: args.ahoraMs, horario: args.horario });
  if (out.plan.enviar) out.enviar = vivos; else out.esperan = vivos;
  return out;
}

/** Un servicio cerrado, ya con lo que el mensaje necesita. */
export type ServicioCerrado = {
  fecha: string;
  hora: string | null;
  conductor: string;
  ruta: string;
  /** Cuándo lo cerró el motor (`alerta_enviada.created_at` del marcador), si se sabe. */
  cerradoMs: number | null;
};

/**
 * Un parámetro de plantilla de Meta: sin saltos ni tabulaciones, sin 4 espacios seguidos y
 * nunca vacío (Meta rechaza el envío entero).
 */
export function paramMeta(s: string | null | undefined, vacio = "-"): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t || vacio;
}

/**
 * Cuánto tiempo después del cierre tiene que salir el aviso para decir CUÁNDO se cerró. Enviado
 * en el mismo tick, la hora del cierre es la del mensaje y repetirla es ruido; enviado al abrir
 * el horario, sin ella el coordinador no sabe que el cierre fue de madrugada. NO MEDIDO: un tick
 * y medio.
 */
export const RETRASO_DICE_HORA_MIN = 15;

function cuandoSeCerro(cerradoMs: number | null, ahoraMs: number): string {
  if (cerradoMs == null || !Number.isFinite(cerradoMs)) return "";
  if (ahoraMs - cerradoMs < RETRASO_DICE_HORA_MIN * 60_000) return "";
  const hhmm = minutosAHhmm(minutoDelDiaLima(cerradoMs));
  const dia = fechaLima(cerradoMs);
  return dia === fechaLima(ahoraMs) ? ` hoy a las ${hhmm}` : ` el ${dia} a las ${hhmm}`;
}

/**
 * Los cuatro parámetros de `coordinador_alerta` (o de la plantilla del directorio de la tarjeta):
 * título · quién · qué · detalle. Con un servicio, el texto de siempre —más la hora del cierre si
 * esperó—; con varios, UN mensaje con la lista ordenada por fecha y hora.
 */
export function paramsAvisoAbandonados(items: ServicioCerrado[], ahoraMs: number): string[] {
  if (items.length === 1) {
    const s = items[0];
    return [
      "Servicio sin cerrar",
      paramMeta(s.conductor, "Conductor"),
      paramMeta(s.ruta, "Servicio"),
      paramMeta(`Quedó "en curso" desde el ${s.fecha}. Se cerró automáticamente${cuandoSeCerro(s.cerradoMs, ahoraMs)}.`),
    ];
  }
  const orden = [...items].sort((a, b) =>
    `${a.fecha} ${a.hora ?? ""}`.localeCompare(`${b.fecha} ${b.hora ?? ""}`));
  const prefijo = "Se cerraron automáticamente: ";
  const lineas = orden.map((s) =>
    `${s.fecha}${s.hora ? ` ${s.hora}` : ""} ${paramMeta(s.conductor, "Conductor")} (${paramMeta(s.ruta, "Servicio")})`);
  return [
    "Servicios sin cerrar",
    `${items.length} servicios`,
    "Quedaron \"en curso\" de días anteriores",
    paramMeta(prefijo + listaEnUnaLinea(lineas, LARGO_LISTA - prefijo.length)),
  ];
}
