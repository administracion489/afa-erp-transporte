// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/reserva-orden.ts — ¿Le pedimos el pago al cliente YA, o primero confirma la unidad
// un ejecutivo? Motor PURO: no lee la base ni mira el reloj (`ahoraMs` entra por parámetro).
//
// LA REGLA (decisión del dueño, 22-10-2026: «pago primero, con condiciones»):
//   pedir_pago             ⟺ es elegible ∧ el horario de atención está en uso ∧
//                             confirmarAntesDe(máx(ahora, próxima apertura), P) + M ≤ inicio
//   derivar                ⟺ la próxima apertura es ≥ inicio (ninguna persona alcanza a
//                             confirmar antes del servicio), o el servicio ya empezó
//   confirmar_disponibilidad, en cualquier otro caso («no pague todavía»).
//  · P (`plazoConfirmacionMin`, defecto 120) son MINUTOS DE ATENCIÓN: lo que tiene el equipo para
//    verificar el pago y confirmar la unidad, contado solo dentro del horario
//    (`sumarMinutosAtencion`, lib/crm-ia-atencion.ts). De noche SÍ se pide el pago si la próxima
//    apertura + P + M llega a tiempo: el mensaje dice la hora exacta (`frasePlazo`).
//  · M (`margenMin`, defecto 360) son minutos REALES entre esa confirmación y el inicio.
//  · Los dos defectos NO están medidos: los decidió el dueño.
//  · `zona_sin_envio` (ni el recojo ni el destino tienen envío automático) FUERZA «disponibilidad
//    primero»: nunca `pedir_pago` (decisión del dueño). Si además ninguna persona alcanza antes del
//    servicio, `derivar` — que también es disponibilidad primero (estado por_confirmar, urgente):
//    prometer un plazo que vence después del servicio sería mentir.
//  · Cualquier motivo de elegibilidad impide pedir el pago; los de TIEMPO los añade este motor.
//  · Más tarde «ahora» nunca hace aparecer `pedir_pago`; un servicio más tarde nunca lo quita
//    (la matriz lo barre: scripts/prueba-reserva-orden.mts).
// ──────────────────────────────────────────────────────────────────────────────

import {
  aLas, atencionEnUso, fechaMediaIngles, nombreDia, sumarMinutosAtencion, ultimoInstanteAtencionAntes, type Atencion,
  type IdiomaFrase,
} from "../crm-ia-atencion";
import { fechaLima, minutoDelDiaLima, minutosAHhmm } from "../alertas-horario";
import { diaSemanaLima } from "../comisiones/calendario";
import type { ConfigReserva } from "./reserva-pago";

/** Minutos de atención para confirmar (decisión del dueño, no medido). */
export const PLAZO_CONFIRMACION_DEFECTO_MIN = 120;
/** Minutos reales entre la confirmación y el servicio (decisión del dueño, no medido). */
export const MARGEN_DEFECTO_MIN = 360;

/** Lo que impide pedir el pago por la cotización, el cliente o la configuración. */
export type MotivoElegibilidad =
  | "zona_sin_envio" | "cotizacion_no_enviada" | "cotizacion_vencida" | "servicio_pasado"
  | "sin_adelanto_config" | "credito" | "sin_cuentas" | "cuentas_distintas"
  | "perfil_sin_configurar" | "politica_sospechosa";

/** Lo que impide pedir el pago por el reloj. Los pone `ordenDeReserva`. */
export type MotivoTiempo = "sin_horario_equipo" | "sin_hora" | "muy_pronto" | "no_alcanza_tras_apertura" | "no_llega";

export type MotivoOrden = MotivoElegibilidad | MotivoTiempo;

export const MOTIVOS_ELEGIBILIDAD: readonly MotivoElegibilidad[] = [
  "zona_sin_envio", "cotizacion_no_enviada", "cotizacion_vencida", "servicio_pasado",
  "sin_adelanto_config", "credito", "sin_cuentas", "cuentas_distintas",
  "perfil_sin_configurar", "politica_sospechosa",
];
export const MOTIVOS_TIEMPO: readonly MotivoTiempo[] = ["sin_horario_equipo", "sin_hora", "muy_pronto", "no_alcanza_tras_apertura", "no_llega"];

/** Por qué no se pidió el pago, dicho para el ejecutivo (la tarjeta y el correo). */
export const MOTIVO_ORDEN: Record<MotivoOrden, string> = {
  zona_sin_envio: "Ni el recojo ni el destino están en una zona con envío automático: primero se confirma la unidad.",
  cotizacion_no_enviada: "La cotización todavía no se le envió al cliente.",
  cotizacion_vencida: "La cotización ya venció: hay que volver a cotizar.",
  servicio_pasado: "La hora del servicio ya pasó.",
  sin_adelanto_config: "No hay un porcentaje de adelanto configurado (/tarifario → Zonas y traslados → Ajustes).",
  credito: "El cliente tiene condición de pago a crédito: no se le pide adelanto.",
  sin_cuentas: "La cotización no tiene cuentas bancarias en su moneda (Configuración → Perfil de la empresa).",
  cuentas_distintas: "Las cuentas de la plantilla de la cotización no son las de «corporativo» (o no se pudo comprobar).",
  perfil_sin_configurar: "El perfil de la empresa no tiene nombre (/configuracion/perfil).",
  politica_sospechosa: "Las políticas de reserva de la cotización traen un enlace o un número largo: revísalas en /cotizaciones/plantillas.",
  sin_horario_equipo: "El horario de atención del equipo no está declarado (/crm/agente → Ajustes): no se puede prometer un plazo.",
  sin_hora: "La cotización no tiene fecha u hora del servicio.",
  muy_pronto: "El servicio es muy pronto: no alcanza el plazo de confirmación más el margen.",
  no_alcanza_tras_apertura: "Fuera del horario de atención, y desde la próxima apertura no alcanza el plazo de confirmación más el margen.",
  no_llega: "Ninguna persona del equipo alcanza a confirmar antes del servicio (la próxima apertura es después del inicio).",
};

export type AccionOrden = "pedir_pago" | "confirmar_disponibilidad" | "derivar";

export type OrdenReserva = {
  accion: AccionOrden;
  /** Todo lo que impidió pedir el pago (vacío con `pedir_pago`). */
  motivos: MotivoOrden[];
  /** Hasta cuándo tiene el equipo para confirmar (dentro de una ventana de atención); null sin horario o al derivar. */
  confirmarAntesMs: number | null;
  /** Hay que mirarla ya: no alcanza el plazo normal, o nadie alcanza antes del servicio. */
  urgente: boolean;
};

const entero = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : def;
};

/** P y M de la configuración, con sus defectos si faltan o se salen del rango de la migración. */
export function plazosDe(cfg: Pick<ConfigReserva, "plazoConfirmacionMin" | "margenMin"> | null | undefined): { P: number; M: number } {
  return {
    P: entero(cfg?.plazoConfirmacionMin, PLAZO_CONFIRMACION_DEFECTO_MIN, 15, 1440),
    M: entero(cfg?.margenMin, MARGEN_DEFECTO_MIN, 0, 4320),
  };
}

const adelantoValido = (pct: unknown): boolean => typeof pct === "number" && Number.isFinite(pct) && pct > 0 && pct <= 100;

/**
 * ¿Le pedimos el pago ya, primero confirmamos la unidad, o lo pasamos a una persona? Ver la
 * cabecera. Los motivos de elegibilidad que no se conocen se descartan; los repetidos, también.
 */
export function ordenDeReserva(x: {
  ahoraMs: number;
  inicioMs: number | null;
  atencion: Atencion;
  cfg: ConfigReserva;
  elegibilidad: MotivoOrden[];
}): OrdenReserva {
  const { P, M } = plazosDe(x.cfg);
  const eleg: MotivoOrden[] = [];
  const poner = (m: MotivoOrden) => { if (!eleg.includes(m)) eleg.push(m); };
  for (const m of x.elegibilidad ?? []) if ((MOTIVOS_ELEGIBILIDAD as readonly string[]).includes(m)) poner(m);
  if (!adelantoValido(x.cfg?.adelantoPct) && !eleg.includes("credito")) poner("sin_adelanto_config");

  const ahora = x.ahoraMs;
  const inicio = typeof x.inicioMs === "number" && Number.isFinite(x.inicioMs) ? x.inicioMs : null;
  const conTiempo = (t: MotivoTiempo) => [...eleg, t];

  if (inicio != null && inicio <= ahora) {
    if (!eleg.includes("servicio_pasado")) poner("servicio_pasado");
    return { accion: "derivar", motivos: [...eleg], confirmarAntesMs: null, urgente: true };
  }
  if (!atencionEnUso(x.atencion)) {
    const urgente = inicio != null && inicio - ahora < (P + M) * 60_000;
    return { accion: "confirmar_disponibilidad", motivos: conTiempo("sin_horario_equipo"), confirmarAntesMs: null, urgente };
  }
  const apertura = sumarMinutosAtencion(x.atencion, ahora, 0)!;
  if (inicio != null && apertura >= inicio) {
    return { accion: "derivar", motivos: conTiempo("no_llega"), confirmarAntesMs: null, urgente: true };
  }
  const C = sumarMinutosAtencion(x.atencion, ahora, P)!;
  if (inicio == null) {
    return { accion: "confirmar_disponibilidad", motivos: conTiempo("sin_hora"), confirmarAntesMs: C, urgente: false };
  }
  if (C + M * 60_000 <= inicio) {
    return eleg.length === 0
      ? { accion: "pedir_pago", motivos: [], confirmarAntesMs: C, urgente: false }
      : { accion: "confirmar_disponibilidad", motivos: [...eleg], confirmarAntesMs: C, urgente: false };
  }
  // No alcanza el plazo normal: se confirma igual, pero ya. El plazo es el de siempre si cae antes
  // del servicio; si no, el último momento de atención antes de él (siempre ≥ la apertura, que es
  // anterior al inicio).
  const tiempo: MotivoTiempo = apertura === ahora ? "muy_pronto" : "no_alcanza_tras_apertura";
  const tope = C <= inicio ? C : ultimoInstanteAtencionAntes(x.atencion, inicio) ?? apertura;
  return { accion: "confirmar_disponibilidad", motivos: conTiempo(tiempo), confirmarAntesMs: tope, urgente: true };
}

/** El plazo que tiene el equipo para confirmar, contado desde `desdeMs` (lo mismo que `ordenDeReserva`). */
export function confirmarAntesDe(atencion: Atencion, desdeMs: number, P: number): number | null {
  if (!atencionEnUso(atencion)) return null;
  return sumarMinutosAtencion(atencion, desdeMs, P);
}

const fechaCorta = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * El plazo dicho para el cliente, desde el día de `ahoraMs` en Lima: «hoy antes de las 15:30»,
 * «mañana martes antes de las 10:30», «el jueves antes de las 11:00», y desde una semana después
 * «el jueves 05/11 antes de las 11:00». null sin plazo. Sin pronombres: vale de usted y de tú.
 * En inglés (24 h y siempre «(Lima time)»: quien escribe en inglés suele estar en otro huso):
 * «today by 15:30 (Lima time)», «tomorrow, Tuesday, by 10:30 (Lima time)», «on Thursday by 11:00
 * (Lima time)» y, desde una semana después, «on Thursday, Nov 5, by 11:00 (Lima time)» (el mes con
 * su nombre: «05/11» se lee al revés en inglés).
 */
export function frasePlazo(confirmarAntesMs: number | null | undefined, ahoraMs: number, idioma: IdiomaFrase = "es"): string | null {
  if (typeof confirmarAntesMs !== "number" || !Number.isFinite(confirmarAntesMs) || !Number.isFinite(ahoraMs)) return null;
  const hoy = fechaLima(ahoraMs), dia = fechaLima(confirmarAntesMs);
  const k = Math.round((Date.parse(`${dia}T12:00:00Z`) - Date.parse(`${hoy}T12:00:00Z`)) / 86_400_000);
  if (idioma === "en") {
    const hh = `${minutosAHhmm(minutoDelDiaLima(confirmarAntesMs))} (Lima time)`;
    const dEn = nombreDia(diaSemanaLima(dia), "en");
    if (k <= 0) return `today by ${hh}`;
    if (k === 1) return `tomorrow, ${dEn}, by ${hh}`;
    if (k < 7) return `on ${dEn} by ${hh}`;
    return `on ${dEn}, ${fechaMediaIngles(dia, false)}, by ${hh}`;
  }
  const hora = aLas(minutosAHhmm(minutoDelDiaLima(confirmarAntesMs)));
  const nd = nombreDia(diaSemanaLima(dia));
  if (k <= 0) return `hoy antes de ${hora}`;
  if (k === 1) return `mañana ${nd} antes de ${hora}`;
  if (k < 7) return `el ${nd} antes de ${hora}`;
  return `el ${nd} ${fechaCorta(dia)} antes de ${hora}`;
}

/** Con qué orden queda la solicitud: solo `pedir_pago` es «pago primero». */
export const ordenDeSolicitud = (accion: AccionOrden): "pago_primero" | "disponibilidad_primero" =>
  accion === "pedir_pago" ? "pago_primero" : "disponibilidad_primero";

/**
 * Los motivos de elegibilidad de una cotización de traslado, de los hechos que ya conoce quien
 * llama. PURO. `cuentasFrente` es el código de `cuentasFrenteACorporativo`: «distintas» y
 * «sin_comprobar» impiden pedir el pago (las cuentas que se mandan por el chat tienen que ser las
 * de la empresa).
 */
export function elegibilidadDeReserva(x: {
  zonaConEnvio: boolean;
  cotizacionEnviada: boolean;
  /** `traslado_json.validez_hasta` (ISO). null = sin validez escrita (no vence por esto). */
  validezHasta: string | null;
  hoy: string;
  inicioMs: number | null;
  ahoraMs: number;
  adelantoPct: number | null;
  credito: boolean;
  /** Cuántas cuentas en la moneda de la cotización (`cuentasEnMensaje`). */
  cuentas: number;
  cuentasFrente: "misma_plantilla" | "iguales" | "distintas" | "sin_comprobar" | null;
  perfilConfigurado: boolean;
  politicaSospechosa: boolean;
}): MotivoElegibilidad[] {
  const out: MotivoElegibilidad[] = [];
  if (x.zonaConEnvio !== true) out.push("zona_sin_envio");
  if (x.cotizacionEnviada !== true) out.push("cotizacion_no_enviada");
  if (typeof x.validezHasta === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x.validezHasta) && x.validezHasta < x.hoy) out.push("cotizacion_vencida");
  if (typeof x.inicioMs === "number" && x.inicioMs <= x.ahoraMs) out.push("servicio_pasado");
  if (x.credito === true) out.push("credito");
  else if (!adelantoValido(x.adelantoPct)) out.push("sin_adelanto_config");
  if (!(x.cuentas > 0) && x.credito !== true) out.push("sin_cuentas");
  if (x.cuentasFrente === "distintas" || x.cuentasFrente === "sin_comprobar") out.push("cuentas_distintas");
  if (x.perfilConfigurado !== true) out.push("perfil_sin_configurar");
  if (x.politicaSospechosa === true) out.push("politica_sospechosa");
  return out;
}
