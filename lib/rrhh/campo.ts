// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/campo.ts — MOTOR PURO (Fase 2, trabajo en campo): ¿hay HOY una autorización
// de campo APROBADA y vigente?
//
// En la Fase 1 la persona FICHA EN LA SEDE y la geocerca mide si está ahí. El trabajo en
// CAMPO es lo contrario: la persona marca LEJOS de la sede, y eso solo es legítimo si una
// autorización de campo aprobada cubre ESTE instante. Este motor contesta esa pregunta y
// NADA MÁS: recibe las autorizaciones y el instante, y devuelve la decisión con un `motivo`
// DECLARADO por código. No lee la base, no mira el reloj, no bloquea nada — la DECISIÓN de
// aceptar o rechazar una marca fuera de la geocerca vive en el llamador (la ingesta de GPS,
// el gate de la cámara), igual que `geocerca_bloquea` no lo aplica `validarMarca`.
//
// REGLA DURA (la fija la matriz por barrido): `ventanaCampoVigente` NUNCA reporta `vigente`
// sin una autorización con estado 'aprobada' cuya ventana [vigente_desde, vigente_hasta]
// CONTIENE `ahora`. Una solicitud, un rechazo, una ventana que aún no abre o ya venció, y un
// estado desconocido NO autorizan campo. Su corolario (anti-trivial): cuando SÍ existe tal
// autorización, reporta `vigente`.
//
// EL INSTANTE SE RECIBE, no se mira. `ahora` es epoch-ms (lo resuelve el llamador; para "hoy"
// en Perú, con la hora Lima pura de lib/alertas-horario.ts). Las cotas de la ventana son
// INSTANTES — ISO-8601 (`"2026-10-20"` o `"2026-10-20T13:00:00-05:00"`) o epoch-ms —, así que
// un cruce de día o de mes se resuelve con los propios timestamps y no hace falta caso
// especial (que sería el bug, el mismo que en `calcularJornada`).
// ──────────────────────────────────────────────────────────────────────────────

/** Estado GUARDADO de una autorización de campo (el que escribe quien la crea/aprueba).
 *  Tolerante a datos legados: cualquier otro valor se trata como "no aprobada". */
export type EstadoAutorizacionCampoGuardado =
  | "solicitada" | "aprobada" | "rechazada" | (string & {});

/** Una autorización de campo tal como llega del registro. `vigente_desde`/`vigente_hasta`
 *  son INSTANTES (ISO con o sin hora, o epoch-ms); su ausencia o basura = "cota desconocida".
 *  `id` permite al llamador identificar cuál cubrió la marca. */
export type AutorizacionCampo = {
  id?: number | string | null;
  estado: EstadoAutorizacionCampoGuardado;
  vigente_desde: string | number | null | undefined;
  vigente_hasta: string | number | null | undefined;
};

/** Estado EFECTIVO en `ahora`: lo guardado, pero con el tiempo resuelto. Una 'aprobada' cuya
 *  ventana ya pasó se lee 'vencida'; cuya ventana contiene `ahora`, 'vigente'. */
export type EstadoAutorizacionCampo =
  | "solicitada" | "aprobada" | "vigente" | "vencida" | "rechazada";

/** Motivo DECLARADO del veredicto de ventana. Cada código nombra el porqué y se arregla en
 *  otro sitio: `sin_autorizacion` (solicitar una), `no_aprobada` (que RRHH la apruebe),
 *  `fuera_de_ventana` (esperar a que abra), `vencida` (pedir una nueva). */
export type MotivoCampo =
  | "vigente" | "sin_autorizacion" | "fuera_de_ventana" | "no_aprobada" | "vencida";

export type VeredictoCampo = {
  vigente: boolean;
  autorizacion: AutorizacionCampo | null;
  motivo: MotivoCampo;
};

/** Parse tolerante de una cota a epoch-ms. `null` = cota desconocida (ausente o basura):
 *  "no sé desde/hasta cuándo" NO es "siempre" ni "nunca". */
function msDe(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Estado EFECTIVO de UNA autorización en `ahora`. El orden del juicio va de lo que no
 * depende del tiempo (rechazada, no-aprobada) a lo que sí (vencida → vigente → aún-no-abre):
 *
 *  - 'rechazada'            → estado guardado 'rechazada'.
 *  - 'solicitada'           → cualquier estado NO aprobado (solicitada o desconocido): no
 *                             autoriza, y describirlo como "pendiente" es el lado seguro.
 *  - aprobada + hasta < ahora          → 'vencida' (la cota de fin manda; sin inicio igual vence).
 *  - aprobada + desde ≤ ahora ≤ hasta  → 'vigente' (requiere AMBAS cotas: una ventana sin una
 *                                        de sus puntas no "contiene" nada).
 *  - aprobada en cualquier otro caso   → 'aprobada' (ventana futura, o cotas incompletas:
 *                                        aprobada pero todavía/aún no utilizable).
 */
export function estadoAutorizacion(a: AutorizacionCampo, ahora: number): EstadoAutorizacionCampo {
  const estado = String(a?.estado ?? "").toLowerCase();
  if (estado === "rechazada") return "rechazada";
  if (estado !== "aprobada") return "solicitada";

  const hasta = msDe(a?.vigente_hasta);
  if (hasta != null && ahora > hasta) return "vencida";

  const desde = msDe(a?.vigente_desde);
  if (desde != null && hasta != null && ahora >= desde && ahora <= hasta) return "vigente";

  return "aprobada";
}

/** Rank de relevancia para elegir, cuando NINGUNA está vigente, cuál autorización describe el
 *  motivo: la aprobada-pero-fuera-de-ventana (casi utilizable) pesa más que una vencida, y esta
 *  más que una solo solicitada o rechazada. 'vigente' se retorna antes de usar este rank. */
const RANK_NO_VIGENTE: Record<EstadoAutorizacionCampo, number> = {
  vigente: -1,
  aprobada: 0,
  vencida: 1,
  solicitada: 2,
  rechazada: 3,
};

/** Estado efectivo (no vigente) → motivo declarado. Una aprobada cuya ventana aún no abre es
 *  `fuera_de_ventana`; una vencida, `vencida`; una solicitada o rechazada, `no_aprobada`. */
const MOTIVO_NO_VIGENTE: Record<EstadoAutorizacionCampo, MotivoCampo> = {
  vigente: "vigente",
  aprobada: "fuera_de_ventana",
  vencida: "vencida",
  solicitada: "no_aprobada",
  rechazada: "no_aprobada",
};

/**
 * ¿Hay una autorización de campo APROBADA y vigente en `ahora`?
 *
 * La firma que reusarán la ingesta de GPS y el frontend:
 *   ventanaCampoVigente(autorizaciones, ahora) → { vigente, autorizacion, motivo }
 *
 *  - Sin autorizaciones → `{ false, null, "sin_autorizacion" }`.
 *  - Si ALGUNA está vigente → gana la vigente: `{ true, <esa>, "vigente" }`.
 *  - Si ninguna vigente → `vigente:false`, y `autorizacion`/`motivo` describen la MÁS RELEVANTE
 *    (aprobada-futura > vencida > solicitada > rechazada), para que la pantalla diga qué falta.
 */
export function ventanaCampoVigente(
  autorizaciones: ReadonlyArray<AutorizacionCampo> | null | undefined,
  ahora: number,
): VeredictoCampo {
  const lista = (autorizaciones ?? []).filter((a): a is AutorizacionCampo => a != null);
  if (lista.length === 0) {
    return { vigente: false, autorizacion: null, motivo: "sin_autorizacion" };
  }

  let masRelevante: AutorizacionCampo | null = null;
  let rankRelevante = Infinity;

  for (const a of lista) {
    const estado = estadoAutorizacion(a, ahora);
    if (estado === "vigente") {
      return { vigente: true, autorizacion: a, motivo: "vigente" };
    }
    const r = RANK_NO_VIGENTE[estado];
    if (r < rankRelevante) {
      rankRelevante = r;
      masRelevante = a;
    }
  }

  const estadoRel = masRelevante ? estadoAutorizacion(masRelevante, ahora) : "solicitada";
  return { vigente: false, autorizacion: masRelevante, motivo: MOTIVO_NO_VIGENTE[estadoRel] };
}
