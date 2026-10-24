// ──────────────────────────────────────────────────────────────────────────────
// lib/idioma-cliente.ts — ¿En qué idioma escribe el cliente? Motor PURO: no lee la base ni llama a
// ningún modelo. Matriz: npx tsx scripts/prueba-idioma-cliente.mts
//
// EL IDIOMA LO DECIDE EL CÓDIGO, NUNCA EL MODELO. El idioma mueve la moneda por defecto de un
// traslado (un cliente en inglés recibe la lista en dólares aunque escriba desde un +51), y el
// modelo no decide nada de dinero. Por eso se deriva de lo que ESCRIBIÓ EL CLIENTE (sus mensajes
// entrantes), con listas de palabras y signos, sin preguntarle a nadie.
//
// LA REGLA:
//  · Cuentan los mensajes de texto (tipo «texto», «text» o sin tipo) y las transcripciones de las
//    notas de voz (se les quita el «🎤 »). Nunca una ubicación, una imagen, un documento, un video,
//    un sticker ni una reacción: su texto lo pone el sistema («[El cliente envió…]») o es un pie de
//    foto, y no dice en qué idioma conversa el cliente.
//  · Cada mensaje se juzga solo: se quitan enlaces, correos, dígitos y emojis; los signos «¿» y «¡»
//    suman 2 al castellano y la «ñ» 1; «ç ã õ» al portugués, «ß ä ö ü» al alemán y «è ê à œ» al
//    francés; después, palabras COMPLETAS de listas propias de cada idioma (sobre todo palabras
//    gramaticales y fórmulas de viaje). El mensaje DECIDE un idioma si este tiene al menos
//    `MIN_PUNTOS_IDIOMA` puntos y el doble que el siguiente. Portugués, francés, alemán o italiano
//    son «otro» (se le contesta en inglés).
//  · La conversación se juzga por MAYORÍA de los `DECISIVOS_IDIOMA` últimos mensajes que deciden,
//    de las últimas `VENTANA_IDIOMA_H` horas; con empate, el más reciente. Sin ningún mensaje que
//    decida: null (`sin_evidencia`), que es castellano y lo de siempre. Así un «Thank you» suelto
//    en un chat en castellano no cambia el idioma de la próxima cotización, y un primer mensaje en
//    inglés seguido de direcciones y horas sigue siendo inglés.
//
// LAS LISTAS, Y POR QUÉ NO ESTÁN TODAS LAS PALABRAS. Una palabra está en UNA sola lista (la matriz
// lo comprueba). Fuera de todas, a propósito, las que aparecen en nombres de hoteles y lugares que
// escribe un cliente en castellano («Hilton Garden Inn», «Hampton by Hilton», «Real Plaza», «Holiday
// Inn Express», «Lima Airport») y las que un peruano usa en inglés sin hablarlo («ok», «transfer»,
// «tour», «full day», «city», «taxi», «van», «bus», «bye»): si contaran, «Quiero un full day a
// Paracas» sería inglés. El castellano admite además palabras que comparte con el portugués o el
// italiano («al», «ir», «en», «que»): equivocarse hacia el castellano es el lado seguro (es lo de
// hoy); equivocarse hacia el inglés le cambia al cliente el idioma del PDF y la moneda.
//
// LOS TRES UMBRALES NO ESTÁN MEDIDOS y se declaran: los mide scripts/diagnostico-idioma-traslados.mts
// sobre las conversaciones reales antes de encender el inglés. El lado seguro es subirlos.
// ──────────────────────────────────────────────────────────────────────────────

import { esAudio, esTranscripcion, PREFIJO_TRANSCRIPCION } from "./crm-audio";
import { ETIQUETA_INICIAL } from "./crm-ia-mensaje";

export type IdiomaCliente = "es" | "en" | "otro";
export type CodigoIdiomaCliente = "sin_evidencia" | "castellano" | "ingles" | "otro_idioma";
export type MensajeParaIdioma = { contenido: string | null; tipo?: string | null; created_at?: string | null };

/** Horas hacia atrás que se miran (no medido). */
export const VENTANA_IDIOMA_H = 48;
/** Cuántos mensajes que deciden se juzgan por mayoría (no medido). */
export const DECISIVOS_IDIOMA = 3;
/** Puntos que necesita un idioma para que el mensaje lo decida (no medido). */
export const MIN_PUNTOS_IDIOMA = 2;

export type IdiomaPalabras = "es" | "en" | "pt" | "fr" | "de" | "it";
export const IDIOMAS_PALABRAS: readonly IdiomaPalabras[] = ["es", "en", "pt", "fr", "de", "it"];

/** Lo más largo de un mensaje que se mira (un texto pegado de varias páginas no aporta más). */
const MAX_CARACTERES = 2000;
/** Lo más que se recorre de la conversación. */
const MAX_MENSAJES = 80;

/**
 * Las palabras de cada idioma, sin tildes y en minúsculas, por palabra COMPLETA. Ninguna está en dos
 * listas ni es una de `PALABRAS_EXCLUIDAS` (la matriz lo comprueba).
 */
export const PALABRAS_IDIOMA: Record<IdiomaPalabras, readonly string[]> = {
  es: [
    "el", "los", "las", "del", "al", "y", "en", "con", "para", "por", "que", "es", "una", "unos", "unas", "mi", "mis",
    "su", "sus", "muy", "pero", "hola", "buenas", "buenos", "buen", "dias", "tardes", "noches", "gracias",
    "quiero", "quisiera", "queria", "quisieramos", "necesito", "necesitamos", "necesitaria", "queremos", "somos",
    "estamos", "estoy", "tengo", "tenemos", "llevamos", "voy", "vamos", "viajo", "viajamos", "llego", "llegamos",
    "llegada", "salida", "recojo", "recoger", "recogen", "traslado", "traslados", "movilidad", "cotizacion",
    "cotizar", "precio", "cuanto", "cuanta", "cuantos", "cuesta", "cuestan", "aeropuerto", "vuelo", "manana",
    "hoy", "pasajeros", "personas", "maletas", "equipaje", "donde", "cuando", "ahora", "usted", "ustedes",
    "senor", "senora", "tambien", "hasta", "desde", "esta", "este", "eso", "esto", "aqui", "hay", "saludos",
    "disculpe", "porfa", "ir", "seria", "ida", "vuelta",
  ],
  en: [
    "the", "and", "is", "are", "was", "i", "you", "your", "my", "we", "our", "they", "to", "from", "for", "with",
    "at", "of", "this", "that", "what", "how", "much", "many", "need", "needs", "want", "would", "could", "can",
    "will", "please", "pls", "hello", "hey", "hi", "thanks", "thank", "there", "here", "get", "pick", "up",
    "drop", "tomorrow", "today", "tonight", "morning", "afternoon", "evening", "night", "price", "cost", "quote",
    "people", "persons", "passengers", "luggage", "bags", "suitcases", "flight", "arrive", "arrival", "arriving",
    "landing", "leave", "leaving", "going", "go", "be", "have", "has", "does", "dont", "it", "yes", "not", "also",
    "just", "where", "when", "which", "who", "room", "trip", "ride", "driver", "wait", "waiting", "round", "way",
    "two", "three", "five", "six", "seven", "eight", "nine", "ten", "good", "great", "sure", "like", "if", "an",
    "or", "all", "any", "some", "about", "around", "book", "reservation", "car", "know", "let", "sorry", "time",
    "hours", "hour", "minutes", "sir", "madam",
  ],
  pt: [
    "um", "uma", "voce", "voces", "obrigado", "obrigada", "quero", "gostaria", "gostariamos", "amanha", "hoje",
    "nao", "sim", "estou", "aeroporto", "bagagem", "pessoas", "passageiros", "custa", "oi", "bom", "boa", "noite",
    "ao", "aos", "na", "em", "pra", "tambem", "muito", "voo", "chegada", "saida", "vou", "ate", "onde", "isso",
    "esse", "essa", "meu", "minha", "agradeco", "tchau",
  ],
  fr: [
    "je", "nous", "vous", "bonjour", "bonsoir", "merci", "voudrais", "voudrions", "besoin", "demain", "aujourd",
    "avec", "pour", "est", "une", "des", "aux", "du", "au", "oui", "suis", "sommes", "avons", "aeroport",
    "bagages", "valises", "combien", "plait", "personnes", "vol", "arrivee", "depart",
  ],
  de: [
    "ich", "wir", "bitte", "danke", "hallo", "guten", "morgen", "abend", "brauche", "brauchen", "moechte",
    "mochte", "mochten", "flughafen", "vom", "zum", "zur", "nach", "und", "ist", "ein", "eine", "einen", "fur",
    "koffer", "personen", "heute", "wie", "viel", "kostet", "uhr", "mit", "der", "dem", "sie",
  ],
  it: [
    "il", "gli", "sono", "siamo", "vorrei", "vorremmo", "ciao", "buongiorno", "buonasera", "grazie", "domani",
    "oggi", "bagagli", "valigie", "persone", "della", "dello", "dall", "dalla", "nel", "nella", "sul", "alla",
    "allo", "che", "voglio", "abbiamo", "ho", "anche", "molto", "prezzo", "partenza", "arrivo", "volo",
    "stasera", "notte", "mattina", "pomeriggio", "prego", "possiamo",
  ],
};

/**
 * Las que NO cuentan para ningún idioma: nombres de hoteles y lugares, el inglés que se usa en
 * castellano, y las que comparten demasiados idiomas («de», «la», «a», «un», «no», «me»). La matriz
 * exige que ninguna esté en una lista.
 */
export const PALABRAS_EXCLUIDAS: readonly string[] = [
  "hotel", "inn", "by", "garden", "plaza", "transfer", "tour", "city", "ok", "taxi", "van", "bus", "full", "day",
  "airport", "park", "center", "centre", "convention", "express", "holiday", "suites", "resort", "club",
  "country", "house", "boutique", "tower", "towers", "beach", "point", "points", "four", "best", "western",
  "double", "tree", "one", "home", "premium", "mall", "shopping", "booking", "bye", "am", "pm", "us", "do",
  "no", "me", "minivan", "favor", "son", "de", "a", "o", "la", "un", "com",
];

const INDICE: ReadonlyMap<string, IdiomaPalabras> = new Map(
  IDIOMAS_PALABRAS.flatMap((l) => PALABRAS_IDIOMA[l].map((p) => [p, l] as [string, IdiomaPalabras])),
);

const ENLACE = /https?:\/\/\S+|www\.\S+|\b[\w.-]+\.(?:com|pe|net|org|io|me|app|info|co)\b\S*/gi;
const CORREO = /\S+@\S+/g;

/** Los signos que delatan un idioma ANTES de quitar las tildes (una vez por mensaje cada grupo). */
const SIGNOS: { re: RegExp; idioma: IdiomaPalabras; puntos: number }[] = [
  { re: /[¿¡]/, idioma: "es", puntos: 2 },
  { re: /ñ/, idioma: "es", puntos: 1 },
  { re: /[çãõ]/, idioma: "pt", puntos: 1 },
  { re: /[ßäöü]/, idioma: "de", puntos: 1 },
  { re: /[èêàœ]/, idioma: "fr", puntos: 1 },
];

const ceros = (): Record<IdiomaPalabras, number> => ({ es: 0, en: 0, pt: 0, fr: 0, de: 0, it: 0 });

/** El idioma del cliente de un ganador por palabras: el portugués, el francés, el alemán y el italiano son «otro». */
const comoCliente = (l: IdiomaPalabras): IdiomaCliente => (l === "es" ? "es" : l === "en" ? "en" : "otro");

/**
 * Un mensaje solo: sus puntos por idioma y el idioma que DECIDE (null si ninguno tiene
 * `MIN_PUNTOS_IDIOMA` puntos y el doble que el siguiente). Un mensaje sin letras nunca decide.
 */
export function idiomaDeMensaje(texto: string): { idioma: IdiomaCliente | null; puntos: Record<IdiomaPalabras, number> } {
  const puntos = ceros();
  const crudo = typeof texto === "string" ? texto.slice(0, MAX_CARACTERES) : "";
  if (!crudo.trim()) return { idioma: null, puntos };
  const sinEnlaces = crudo.replace(ENLACE, " ").replace(CORREO, " ").toLowerCase();
  for (const s of SIGNOS) if (s.re.test(sinEnlaces)) puntos[s.idioma] += s.puntos;
  const palabras = sinEnlaces.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]+/g, " ").trim().split(" ");
  for (const p of palabras) {
    const l = p ? INDICE.get(p) : undefined;
    if (l) puntos[l]++;
  }
  const orden = [...IDIOMAS_PALABRAS].sort((a, b) => puntos[b] - puntos[a]);
  const [primero, segundo] = orden;
  const decide = puntos[primero] >= MIN_PUNTOS_IDIOMA && puntos[primero] >= 2 * puntos[segundo];
  return { idioma: decide ? comoCliente(primero) : null, puntos };
}

const TIPOS_TEXTO: ReadonlySet<string> = new Set(["texto", "text", ""]);

/**
 * El texto con que el mensaje cuenta, o null si no cuenta: el de un mensaje de texto, o la
 * transcripción de una nota de voz sin su «🎤 ». Sin la etiqueta inicial «[…]».
 */
function textoQueCuenta(m: MensajeParaIdioma): string | null {
  if (!m || typeof m.contenido !== "string") return null;
  const tipo = m.tipo == null ? "" : String(m.tipo).trim().toLowerCase();
  let t: string;
  if (TIPOS_TEXTO.has(tipo)) t = m.contenido;
  else if (esAudio(tipo) && esTranscripcion(m.contenido)) t = m.contenido.slice(PREFIJO_TRANSCRIPCION.length);
  else return null;
  t = t.replace(ETIQUETA_INICIAL, "");
  return t.trim() ? t : null;
}

const NOMBRE_IDIOMA: Record<IdiomaCliente, string> = { es: "castellano", en: "inglés", otro: "otro idioma" };
const CODIGO_DE: Record<IdiomaCliente, CodigoIdiomaCliente> = { es: "castellano", en: "ingles", otro: "otro_idioma" };

/**
 * El idioma del cliente en la conversación. `entrantesRecientesPrimero` son SOLO sus mensajes
 * entrantes, del más reciente al más antiguo (como los devuelve la lectura del CRM). Un mensaje sin
 * `created_at` (o con una fecha que no se entiende) cuenta como reciente: no se puede probar que sea
 * viejo. `detalle` va en castellano: lo lee el ejecutivo y el simulador.
 */
export function idiomaDelCliente(
  entrantesRecientesPrimero: readonly MensajeParaIdioma[],
  ahoraMs: number,
): { idioma: IdiomaCliente | null; codigo: CodigoIdiomaCliente; decisivos: number; detalle: string } {
  const desde = Number.isFinite(ahoraMs) ? ahoraMs - VENTANA_IDIOMA_H * 3_600_000 : -Infinity;
  const decisivos: IdiomaCliente[] = [];
  const lista = Array.isArray(entrantesRecientesPrimero) ? entrantesRecientesPrimero.slice(0, MAX_MENSAJES) : [];
  for (const m of lista) {
    if (decisivos.length >= DECISIVOS_IDIOMA) break;
    const ms = m?.created_at ? Date.parse(m.created_at) : NaN;
    if (Number.isFinite(ms) && ms < desde) continue;
    const t = textoQueCuenta(m);
    if (t == null) continue;
    const d = idiomaDeMensaje(t).idioma;
    if (d) decisivos.push(d);
  }
  if (decisivos.length === 0) {
    return {
      idioma: null, codigo: "sin_evidencia", decisivos: 0,
      detalle: `Ningún mensaje del cliente de las últimas ${VENTANA_IDIOMA_H} h dice en qué idioma escribe: se trata como castellano.`,
    };
  }
  const cuenta = new Map<IdiomaCliente, number>();
  for (const d of decisivos) cuenta.set(d, (cuenta.get(d) ?? 0) + 1);
  const max = Math.max(...cuenta.values());
  // Con empate, el más reciente de los empatados (la lista va del más reciente al más antiguo).
  const idioma = decisivos.find((d) => cuenta.get(d) === max) as IdiomaCliente;
  const n = decisivos.length;
  const cuantos = n === 1 ? "su único mensaje con idioma claro" : `${cuenta.get(idioma)} de sus ${n} últimos mensajes con idioma claro`;
  return {
    idioma, codigo: CODIGO_DE[idioma], decisivos: n,
    detalle: `El cliente escribe en ${NOMBRE_IDIOMA[idioma]}: ${cuantos} (últimas ${VENTANA_IDIOMA_H} h).`,
  };
}
