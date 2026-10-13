// lib/odometro-decimas.ts
// LA UNIDAD CUYO ÚLTIMO TAMBOR MARCA DÉCIMAS — y lo que el ERP hace cuando lo sabe.
// Módulo PURO: no lee la base (eso es lib/odometro-decimas-datos.ts). Lo importan el selector
// (lib/odometro-seleccion.ts), los dos carriles de lectura (app/Radar) y el modal de corrección.
//
// EL CASO (B4N-968, reportado el 13/10/2026). El tablero es mecánico, de rodillos: seis tambores
// de kilómetros y un SÉPTIMO de décimas, en otro color. El 26/08 marcaba 560,243.2 km y entró
// como 5,602,432 — la IA leyó bien todas las cifras y metió la décima en el número. El ERP ya
// tenía un arreglo para esto (`decimalComoEntero`, octubre 2026), pero solo funciona cuando el
// modelo TRANSCRIBE el punto («560243.2»); si lee siete cifras seguidas no queda nada en la foto
// leída que diga cuál es la décima, y la lectura entraba diez veces mayor. Peor: con siete cifras
// y un par repetido —el 5,600,473 de agosto— el colapso del dígito repetido daba 560,473 cuando el
// tablero, con su décima, decía 560,047.3. Un arreglo genérico aplicado a la unidad equivocada.
//
// (El arreglo de octubre describía este tablero como «5 6 1 2 9 [2]» = 56,129.2 km: seis tambores
// en vez de siete. La unidad va por los 560 mil, y la corrección del dueño lo dejó escrito.)
//
// LO QUE ARREGLA: el ERP no tiene que adivinar en cada foto si el último dígito es una décima. Lo
// dijo una persona al corregir una lectura —mirando la foto— y eso es un hecho de ESE tablero que
// no cambia de una foto a otra. Se DERIVA de `odometro_correcciones`, no se guarda en una columna
// (mismo criterio que la unidad bicombustible): sin migración, y el día que alguien corrige la
// primera lectura así, la unidad queda conocida para todas las siguientes.
//
// Cuándo una corrección dice «este tablero tiene décimas», de la evidencia al juicio:
//   1. el motivo es «La IA leyó la décima como km» (`MOTIVO_DECIMAS`): lo declaró una persona;
//   2. o el km correcto es EXACTAMENTE el leído sin su última cifra, y esa cifra no repite la
//      anterior: es lo que hace una persona que corrige la décima con otro motivo («Otro»,
//      «La IA leyó mal un dígito»). Con las dos últimas cifras iguales no se cuenta: quitar la
//      última es también lo que haría el colapso de un dígito repetido, y ahí no hay forma de
//      saber cuál de los dos errores corrigió.
//
// LO QUE NO SE HACE: dividir entre diez cualquier número de una cifra de más. La décima solo se
// quita cuando el número resultante está en la MISMA ESCALA que la corrección que lo declaró
// (`mismaEscala`): el día que un odómetro de seis cifras pase de 999,999 a 1,000,0xx, esa lectura
// de siete cifras es legítima y dividirla dejaría la unidad en 100 mil.

/** La clave del motivo en `odometro_correcciones.motivo_tipo` (texto libre, sin CHECK). */
export const MOTIVO_DECIMAS = "decimas";

/** Lo que una corrección guarda y este módulo lee. */
export type CorreccionOdometro = {
  motivo_tipo: string | null;
  km_leido: number | null;
  km_correcto: number | null;
  created_at?: string | null;
};

/** El tablero de una unidad tiene tambor de décimas, y desde qué corrección se sabe. */
export type TamborDecimas = {
  /** El km entero que escribió la persona en esa corrección: fija la ESCALA de la unidad. */
  kmCorrecto: number;
  /** Cifras de kilómetros del tablero (sin la décima). */
  cifras: number;
  /** Cuándo se corrigió (ISO), para nombrarlo. */
  fecha: string | null;
  /** Lo declaró el motivo, o se reconoció por la forma del número que se escribió. */
  por: "motivo" | "forma";
};

/** Cuántas cifras tiene un kilometraje entero. */
const cifrasDe = (n: number): number => String(Math.floor(Math.abs(n))).length;

/** El km sin la décima: la parte entera, NUNCA redondeada (560,243.7 todavía no es 560,244). */
export const kmSinDecima = (kmConDecima: number): number => Math.floor(Math.abs(kmConDecima) / 10);

/**
 * ¿Esta corrección dice que el tablero tiene tambor de décimas? null si no.
 * Ver la cabecera: el motivo lo declara; la forma solo cuenta cuando no hay otra lectura posible.
 */
export function correccionDeDecimas(c: CorreccionOdometro): "motivo" | "forma" | null {
  const leido = Number(c.km_leido);
  const correcto = Number(c.km_correcto);
  if (c.motivo_tipo === MOTIVO_DECIMAS) return correcto > 0 ? "motivo" : null;
  if (!(leido >= 1000) || !(correcto > 0) || !Number.isInteger(leido) || !Number.isInteger(correcto)) return null;
  if (correcto !== kmSinDecima(leido)) return null;
  const s = String(leido);
  // Las dos últimas iguales: también es el colapso de un dígito repetido. No se puede saber.
  if (s[s.length - 1] === s[s.length - 2]) return null;
  return "forma";
}

/**
 * El tambor de décimas de una unidad, a partir de SUS correcciones. Gana la más reciente: fija la
 * escala con el km más cercano al de hoy. null si ninguna lo dice.
 */
export function tamborDecimasDe(correcciones: CorreccionOdometro[]): TamborDecimas | null {
  let mejor: TamborDecimas | null = null;
  for (const c of correcciones) {
    const por = correccionDeDecimas(c);
    if (!por) continue;
    const km = Math.floor(Number(c.km_correcto));
    const fecha = c.created_at ?? null;
    if (!mejor || (fecha ?? "") > (mejor.fecha ?? "")) mejor = { kmCorrecto: km, cifras: cifrasDe(km), fecha, por };
  }
  return mejor;
}

/**
 * ¿Un km entero está en la MISMA ESCALA que la corrección que declaró el tambor? Entre la mitad y
 * el doble. NO está medido y se declara: una unidad no duplica su odómetro entre dos lecturas, y
 * una lectura diez veces mayor o menor queda muy lejos de los dos bordes. Es lo que impide dividir
 * entre diez el 1,000,0xx legítimo de un odómetro que acaba de pasar a siete cifras.
 */
export const ESCALA_MIN = 0.5;
export const ESCALA_MAX = 2;
export function mismaEscala(km: number, t: TamborDecimas): boolean {
  return km >= t.kmCorrecto * ESCALA_MIN && km <= t.kmCorrecto * ESCALA_MAX;
}

/**
 * Si este número es el odómetro de la unidad CON la décima metida como cifra, el km sin ella; si
 * no, null. Exige las dos cosas: una cifra más que el tablero, y que sin ella caiga en su escala.
 */
export function sinDecimaDeUnidad(km: number | null | undefined, t: TamborDecimas | null | undefined): number | null {
  if (!t || km == null || !(Number(km) > 0)) return null;
  const n = Math.floor(Number(km));
  if (cifrasDe(n) !== t.cifras + 1) return null;
  const sin = kmSinDecima(n);
  return mismaEscala(sin, t) ? sin : null;
}

/**
 * El km de la unidad en SU escala: la usan los prompts para decirle al modelo cuántas cifras tiene
 * el tablero. Con el historial contaminado el vigente lleva la décima (5,6xx,xxx) y la frase diría
 * «7 dígitos» — empujando al modelo a repetir el error. Sin tambor, el km tal cual.
 */
export function kmEnEscala(km: number | null | undefined, t: TamborDecimas | null | undefined): number {
  const n = Number(km) || 0;
  return sinDecimaDeUnidad(n, t) ?? n;
}

// ── Lo que TECLEA una persona en el modal de corrección ─────────────────────────────────

/**
 * Un kilometraje escrito a mano, con su décima si la trae. El ERP guarda km ENTEROS
 * (`lecturas_odometro.km` es INT): la décima se lee para reconocer el caso y se descarta.
 *
 *   «560243.2» · «560243,2» · «560,243.2» · «560 243.2»  → { km: 560243, decima: 2 }
 *   «560243» · «560,243»                                   → { km: 560243, decima: null }
 *   «560.243»                                              → { km: 560243, decima: null } (miles)
 *
 * Con TRES cifras tras el separador son miles; con UNA es la décima; con dos —«560243.25»— no es
 * ni una cosa ni la otra y se rechaza (null) en vez de adivinar.
 */
export function leerKmConDecima(texto: string | null | undefined): { km: number; decima: number | null } | null {
  const t = String(texto ?? "").trim().replace(/\s+/g, "");
  if (!t) return null;
  let m = t.match(/^(\d{1,3}(?:[.,]\d{3})*)(?:[.,](\d))?$/);
  if (!m) m = t.match(/^(\d+)(?:[.,](\d))?$/);
  if (!m) return null;
  const km = Number(m[1].replace(/[.,]/g, ""));
  if (!Number.isFinite(km) || km <= 0) return null;
  return { km, decima: m[2] != null ? Number(m[2]) : null };
}

/**
 * ¿Lo que escribió la persona es la lectura de la IA con la décima en su sitio? 5,602,432 leído
 * y «560243.2» escrito: mismas cifras, y la última es la décima.
 */
export function esDecimaLeidaComoKm(kmLeido: number, entrada: { km: number; decima: number | null } | null): boolean {
  if (!entrada || entrada.decima == null) return false;
  return `${entrada.km}${entrada.decima}` === String(Math.floor(Number(kmLeido)));
}

// ── Las OTRAS lecturas de la unidad que llevan la décima como cifra ─────────────────────

export type LecturaEnEscala = { id: string; km: number; estado: string; fecha: string | null; ref_origen?: string | null };
export type LecturaACorregir = LecturaEnEscala & { kmNuevo: number };

/** Estados que no se tocan: lo anulado ya está fuera, y un reinicio es otro tablero. */
const ESTADOS_FUERA = new Set(["anulada", "reinicio"]);

/**
 * Las lecturas VIVAS de la unidad que tienen la décima metida como cifra (una más que el tablero
 * y, sin ella, en su escala), con el km que les corresponde. Ordenadas por fecha. La lectura que se
 * está corrigiendo se excluye por id. Una lectura que ya es una corrección (`correccion:`) no entra:
 * la escribió una persona.
 */
export function lecturasConDecima(lecturas: LecturaEnEscala[], t: TamborDecimas, excluirId?: string | null): LecturaACorregir[] {
  const out: LecturaACorregir[] = [];
  for (const l of lecturas) {
    if (l.id === excluirId || ESTADOS_FUERA.has(String(l.estado))) continue;
    if (String(l.ref_origen ?? "").startsWith("correccion:")) continue;
    const kmNuevo = sinDecimaDeUnidad(l.km, t);
    if (kmNuevo != null) out.push({ ...l, kmNuevo });
  }
  return out.sort((a, b) => (a.fecha ?? "").localeCompare(b.fecha ?? "") || a.km - b.km);
}

/** La frase con la que el ERP nombra el tambor de una unidad (prompts y motivos). */
export function fraseTambor(t: TamborDecimas): string {
  // `created_at` va en UTC: la fecha que se nombra es la de Lima (UTC-5).
  const ms = t.fecha ? Date.parse(t.fecha) : NaN;
  const dia = Number.isFinite(ms) ? new Date(ms - 5 * 3600_000).toISOString().slice(0, 10) : null;
  const cuando = dia ? ` el ${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}` : "";
  return t.por === "motivo"
    ? `el equipo lo marcó al corregir una lectura${cuando}`
    : `una persona corrigió una lectura${cuando} quitándole la décima`;
}
