// ─────────────────────────────────────────────────────────────────────────────
// lib/radar/procedencia-placa.ts — ¿A QUÉ UNIDAD es la foto de un tablero?
//
// Módulo PURO (no lee la base), igual que coherencia-voucher.ts.
//
// El caso (12/09 y 16/09/2026): "~Cerna" mandó al grupo fotos de tablero con "Kilometraje
// final / unidad en la cochera / fin de servicio" — sin placa en el texto, y un tablero no
// muestra placa. El Radar grabó 24,484 km y después 24,736 km en la CWZ-371: la IA tenía
// delante la lista de guías de odómetro por placa (lib/radar/prompts.ts) y eligió la unidad
// cuyo tablero "se parecía". Ese km pasó a ser el vigente de la CWZ-371 y sus lecturas buenas
// de los días siguientes empezaron a descartarse como "retroceso".
//
// LA PLACA NO LA DECIDE LA IA. Se decide con lo que el ERP sabe, en este orden:
//   1. La placa está ESCRITA en el mensaje (o en su ráfaga). La lee el ERP del texto —
//      `escritasEnTexto` recorre la flota—, no se le cree al campo `placa` del modelo.
//   2. Si no está escrita: el NÚMERO de quien mandó la foto (su WhatsApp, contra la ficha de
//      los conductores propios Y de terceros) y la unidad que ese conductor tenía en servicio
//      ESE día. Con UNA sola, la foto es de esa unidad.
//   3. Si tampoco: la unidad queda SIN IDENTIFICAR y la lectura no se graba sola. Lo que la IA
//      haya propuesto se guarda como dato (`propuestaIA`) y no se usa NUNCA: es un parecido.
//
// La asimetría de siempre: un km en la unidad equivocada envenena su vigente, su mantenimiento
// y su rendimiento, y nadie lo nota hasta que algo deja de cuadrar; una lectura sin grabar
// cuesta teclearla a mano.
// ─────────────────────────────────────────────────────────────────────────────

export type FlotaUnidad = "propia" | "tercero";

/** Una unidad de cualquiera de las dos flotas (los ids de las dos tablas se repiten). */
export type UnidadRef = { flota: FlotaUnidad; id: number; placa: string };

/** Lo que el ERP sabe de QUIÉN mandó la foto, el día en que la mandó. */
export type Remitente =
  /** WhatsApp no entregó el número (vacío, o un identificador interno `@lid`). */
  | { codigo: "sin_telefono" }
  /** Hay número, pero no está en la ficha de ningún conductor (ni propio ni de tercero). */
  | { codigo: "no_registrado"; telefono: string }
  /** Conductor identificado por su número, con las unidades que tenía en servicio ese día. */
  | { codigo: "identificado"; telefono: string; conductores: string[]; asignadas: UnidadRef[] }
  /** La base no contestó: no se puede afirmar nada sobre el remitente. */
  | { codigo: "no_se_pudo_leer" };

export type CodigoUnidad =
  | "placa_escrita"     // la placa está escrita en el mensaje
  | "conflicto"         // está escrita, pero quien la mandó tenía asignada OTRA (única) ese día
  | "varias_escritas"   // el mensaje nombra 2+ unidades y nada decide cuál
  | "asignacion"        // no escrita: la unidad sale del número del remitente y su servicio del día
  | "varias_asignadas"  // no escrita, y el remitente manejó 2+ unidades ese día
  | "sin_servicio"      // no escrita, remitente identificado sin servicio ese día
  | "no_registrado"     // no escrita, el número no está en la ficha de ningún conductor
  | "sin_telefono"      // no escrita, WhatsApp no entregó el número
  | "no_se_pudo_leer";  // no escrita, y la base no contestó

export type DecisionUnidad = {
  codigo: CodigoUnidad;
  /** En qué unidad se graba la lectura; null → no hay unidad identificada. */
  unidad: UnidadRef | null;
  /** Si puede grabarse sin que una persona la vea. */
  auto: boolean;
  /** La que eligió la IA cuando NO está escrita. Solo queda como dato: jamás decide nada. */
  propuestaIA: UnidadRef | null;
  /** Las unidades que el remitente tenía en servicio ese día (para que la pantalla las ofrezca). */
  candidatas: UnidadRef[];
};

const soloAlnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Placa normalizada (sin guion ni espacios, en mayúsculas). */
export const placaComparable = (p: string | null | undefined) => soloAlnum(String(p ?? ""));

/** Misma unidad: misma flota y mismo id (los ids de `vehiculos` y `vehiculos_tercero` se repiten). */
export const mismaUnidad = (a: UnidadRef | null | undefined, b: UnidadRef | null | undefined) =>
  !!a && !!b && a.flota === b.flota && Number(a.id) === Number(b.id);

/**
 * ¿La placa aparece escrita en el texto? Tolera cómo la escriben los conductores:
 * "CWZ-371", "cwz 371", "C W Z 3 7 1", "placa: Cwz371". Se exige la placa completa
 * (letras + números, ≥ 5 caracteres): un "371" suelto es cualquier número.
 *
 * Y se exige que empiece y termine en un BORDE: pegando las palabras ("en la cochera 24736"
 * → "COCHERA24736") cualquier placa que empiece por "ERA" aparecería dentro sin estar escrita.
 * Con la flota entera contra el texto, ese falso positivo dejaría de ser teórico.
 */
export function placaEnTexto(placa: string | null | undefined, textos: (string | null | undefined)[]): boolean {
  const p = placaComparable(placa);
  if (p.length < 5 || !/[A-Z]/.test(p) || !/[0-9]/.test(p)) return false;
  const patron = new RegExp(`(?<![A-Z0-9])${p.split("").join("[\\s.\\-_/]*")}(?![A-Z0-9])`);
  return textos.some((t) => patron.test(String(t ?? "").toUpperCase()));
}

/** Las unidades de la flota cuya placa está escrita en el texto (sin repetir). */
export function escritasEnTexto(flota: UnidadRef[], textos: (string | null | undefined)[]): UnidadRef[] {
  const out: UnidadRef[] = [];
  for (const u of flota) {
    if (out.some((x) => mismaUnidad(x, u))) continue;
    if (placaEnTexto(u.placa, textos)) out.push(u);
  }
  return out;
}

/**
 * La unidad de una lectura de tablero. Ver la cabecera: la placa escrita manda; si no hay,
 * manda el número del remitente y su servicio del día; si tampoco, no hay unidad.
 */
export function decidirUnidad(opts: {
  /** Unidades de la flota cuya placa está escrita en el mensaje o su ráfaga. */
  escritas: UnidadRef[];
  /** La unidad que devolvió la IA (puede estar escrita… o ser un parecido). */
  unidadIA: UnidadRef | null;
  remitente: Remitente;
}): DecisionUnidad {
  const { escritas, unidadIA, remitente } = opts;
  const candidatas = remitente.codigo === "identificado" ? remitente.asignadas : [];

  // 1) ¿Está escrita? Si la IA eligió una de las escritas, es lectura del texto, no parecido.
  let escrita: UnidadRef | null = null;
  if (unidadIA && escritas.some((u) => mismaUnidad(u, unidadIA))) escrita = unidadIA;
  else if (escritas.length === 1) escrita = escritas[0];
  else if (escritas.length > 1) {
    // Dos placas en el mensaje ("pasé de la BUI-272 a la CWZ-371"): desempata el servicio del día.
    const enServicio = escritas.filter((u) => candidatas.some((c) => mismaUnidad(c, u)));
    if (enServicio.length === 1) escrita = enServicio[0];
    else return { codigo: "varias_escritas", unidad: null, auto: false, propuestaIA: null, candidatas };
  }
  if (escrita) {
    // Escrita, pero quien la mandó tenía OTRA unidad (y solo esa) ese día: ¿foto de otra unidad?
    // Se graba en la escrita —es lo que una persona tecleó— pero no sola.
    const otra = candidatas.length === 1 && !mismaUnidad(candidatas[0], escrita);
    return { codigo: otra ? "conflicto" : "placa_escrita", unidad: escrita, auto: !otra, propuestaIA: null, candidatas };
  }

  // 2) No está escrita: lo que la IA propuso es un parecido y queda solo como dato.
  const base = { propuestaIA: unidadIA, candidatas };
  switch (remitente.codigo) {
    case "identificado":
      if (remitente.asignadas.length === 1) {
        return { ...base, codigo: "asignacion", unidad: remitente.asignadas[0], auto: true };
      }
      return { ...base, codigo: remitente.asignadas.length > 1 ? "varias_asignadas" : "sin_servicio", unidad: null, auto: false };
    case "no_registrado":
      return { ...base, codigo: "no_registrado", unidad: null, auto: false };
    case "no_se_pudo_leer":
      return { ...base, codigo: "no_se_pudo_leer", unidad: null, auto: false };
    default:
      return { ...base, codigo: "sin_telefono", unidad: null, auto: false };
  }
}

/** "+51 961 097 763" a partir de los dígitos del número. */
export function telefonoLegible(digitos: string): string {
  const d = String(digitos ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("51")) return `+51 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  if (d.length === 9) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return d ? `+${d}` : "";
}

const listaPlacas = (us: UnidadRef[]) => us.map((u) => u.placa).join(", ");

/**
 * Por qué la lectura no se pudo atar a una unidad, y dónde se arregla. Lo usan la alerta del
 * Radar y la pantalla: dos redacciones del mismo hecho terminan diciendo cosas distintas.
 * `null` cuando hay unidad y puede grabarse sola.
 */
export function motivoDecision(
  d: DecisionUnidad,
  ctx: { remitente: Remitente; nombre?: string | null; fecha?: string | null },
): string | null {
  const quien = (ctx.nombre ?? "").trim() || "quien la mandó";
  const fecha = ctx.fecha ? fechaCorta(ctx.fecha) : "ese día";
  const tel = ctx.remitente.codigo === "identificado" || ctx.remitente.codigo === "no_registrado"
    ? telefonoLegible(ctx.remitente.telefono) : "";
  switch (d.codigo) {
    case "placa_escrita":
    case "asignacion":
      return null;
    case "conflicto":
      return `La placa ${d.unidad!.placa} está escrita, pero ${quien} tenía asignada la ${d.candidatas[0].placa} el ${fecha} — ¿foto de otra unidad? Confirma cuál es`;
    case "varias_escritas":
      return "El mensaje nombra más de una placa y nada decide de cuál es el tablero — elige la unidad";
    case "varias_asignadas":
      return `La placa no está escrita y ${quien} manejó ${d.candidatas.length} unidades el ${fecha} (${listaPlacas(d.candidatas)}): elige de cuál es el tablero`;
    case "sin_servicio":
      return `La placa no está escrita y ${quien}${tel ? ` (${tel})` : ""} no tenía ningún servicio asignado el ${fecha}: asígnale la unidad en Programación o registra el km a mano en la unidad correcta`;
    case "no_registrado":
      return `La placa no está escrita y el número ${tel} (${quien}) no está en la ficha de ningún conductor, propio ni de tercero: agrégalo en su ficha para que el Radar asocie sus fotos a la unidad que maneja ese día. Mientras tanto, registra el km a mano en la unidad correcta`;
    case "sin_telefono":
      return `La placa no está escrita y WhatsApp no entregó el número de ${quien} (llegó con un identificador interno): actualiza el servidor del Radar a la versión 1.4.0 o superior. Mientras tanto, registra el km a mano en la unidad correcta`;
    case "no_se_pudo_leer":
      return "La placa no está escrita y no se pudo consultar quién manda la foto ni su servicio del día — registra el km a mano en la unidad correcta";
  }
}

const fechaCorta = (iso: string) => {
  const [a, m, d] = String(iso).slice(0, 10).split("-");
  return a && m && d ? `${d}/${m}/${a}` : iso;
};

// ── La auditoría de lo que YA se grabó ──────────────────────────────────────
// Antes de este guard, el Radar grababa la placa que propusiera la IA. Esas lecturas siguen ahí,
// aceptadas, inflando el vigente de una unidad que no era. La auditoría vuelve a decidir con la
// MISMA regla y compara con la unidad donde quedó la lectura.

export type VeredictoPlaca =
  /** La unidad donde está la lectura es la que dice el mensaje o el servicio del remitente. */
  | "respaldada"
  /** El mensaje o el servicio del remitente señalan OTRA unidad: se propone pasarla. */
  | "otra_unidad"
  /** Nada respalda la unidad donde está: la placa salió del parecido del tablero (o no se sabe). */
  | "sin_respaldo";

export function auditarUnidadLectura(actual: UnidadRef | null, d: DecisionUnidad): {
  veredicto: VeredictoPlaca;
  /** La unidad a la que habría que pasarla (solo con `otra_unidad`). */
  propuesta: UnidadRef | null;
} {
  // `d.unidad` solo existe si la sacó el texto o el servicio del remitente — nunca el parecido.
  // Un `conflicto` (escrita, pero el remitente tenía otra) también cuenta: la placa la tecleó
  // una persona; la duda ya se avisó cuando llegó el mensaje.
  if (d.unidad && actual && mismaUnidad(d.unidad, actual)) return { veredicto: "respaldada", propuesta: null };
  if (d.unidad) return { veredicto: "otra_unidad", propuesta: d.unidad };
  return { veredicto: "sin_respaldo", propuesta: null };
}

/**
 * La frase de la auditoría para una lectura ya grabada. `null` si está respaldada. Con
 * `otra_unidad` dice de dónde sale la unidad propuesta; con `sin_respaldo`, por qué no hay
 * ninguna y dónde se arregla (la misma frase que la alerta del Radar).
 */
export function motivoAuditoria(
  actual: UnidadRef | null,
  d: DecisionUnidad,
  ctx: { remitente: Remitente; nombre?: string | null; fecha?: string | null },
): string | null {
  const { veredicto, propuesta } = auditarUnidadLectura(actual, d);
  if (veredicto === "respaldada") return null;
  const enActual = actual ? `quedó en la ${actual.placa}` : "quedó sin unidad";
  if (veredicto === "otra_unidad") {
    const quien = (ctx.nombre ?? "").trim() || "quien mandó la foto";
    const fecha = ctx.fecha ? fechaCorta(ctx.fecha) : "ese día";
    if (d.codigo === "asignacion") {
      return `La placa no está escrita en el mensaje y ${quien} tenía en servicio la ${propuesta!.placa} el ${fecha}, pero la lectura ${enActual}: la IA la eligió por el parecido del tablero`;
    }
    return `El mensaje dice ${propuesta!.placa}, pero la lectura ${enActual}`;
  }
  const porQue = motivoDecision(d, ctx);
  const placa = actual ? `la ${actual.placa}` : "la unidad";
  return `Nada respalda que sea de ${placa}: no está escrita en el mensaje, así que la eligió la IA mirando la foto — y un tablero no muestra la placa.${porQue ? ` ${porQue}` : ""}`;
}

// ── La persona CONFIRMA la unidad ────────────────────────────────────────────
//
// La auditoría solo sabe respaldar una placa con lo que está ESCRITO (el mensaje) o con el
// SERVICIO del remitente. Cuando no hay nada de eso —el conductor no es de la flota, no tenía
// servicio, el número llegó como @lid— la lectura queda «sin confirmar» para siempre aunque sea de
// esa unidad, y la única salida que ofrecía la pantalla era CAMBIARLA. Quien mira la foto puede
// saber que sí es esa unidad (el tablero, la hora, el conductor que la usa): esa es la tercera
// fuente, y la escribe una persona.
//
// Se guarda en el MENSAJE de origen (`radar_mensajes.resultado.unidad_confirmada`), sin migración:
// la confirmación es sobre la unidad que se decidió para ESE mensaje, y la auditoría ya lo lee. Vale
// solo para la unidad confirmada: si la lectura se pasa después a otra, vuelve a auditarse.

export type ConfirmacionUnidad = UnidadRef & {
  /** Quién la confirmó (correo del usuario del ERP), si se sabe. */
  por: string | null;
  /** Cuándo (ISO). */
  en: string;
};

/** La confirmación guardada en el `resultado` de un mensaje, o null. Sin confiar en su forma. */
export function confirmacionDe(resultado: unknown): ConfirmacionUnidad | null {
  const c = resultado && typeof resultado === "object" ? (resultado as Record<string, unknown>).unidad_confirmada : null;
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  const flota = o.flota === "tercero" ? "tercero" : o.flota === "propia" ? "propia" : null;
  const id = Number(o.id);
  if (!flota || !Number.isFinite(id) || id <= 0) return null;
  return {
    flota, id, placa: typeof o.placa === "string" ? o.placa : "",
    por: typeof o.por === "string" && o.por ? o.por : null,
    en: typeof o.en === "string" ? o.en : "",
  };
}

/** ¿La confirmación respalda la unidad donde está HOY la lectura? */
export const confirmaUnidad = (c: ConfirmacionUnidad | null, actual: UnidadRef | null): boolean =>
  !!c && !!actual && mismaUnidad(c, actual);

/** El `resultado` con la confirmación puesta (lo demás intacto). */
export function resultadoConConfirmacion(resultado: unknown, unidad: UnidadRef, por: string | null, en: string): Record<string, unknown> {
  const base = resultado && typeof resultado === "object" && !Array.isArray(resultado) ? { ...(resultado as Record<string, unknown>) } : {};
  base.unidad_confirmada = { flota: unidad.flota, id: unidad.id, placa: unidad.placa, por, en };
  return base;
}
