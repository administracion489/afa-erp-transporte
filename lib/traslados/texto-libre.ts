// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/texto-libre.ts — Lo que escribe el cliente (o el modelo) y puede terminar IMPRESO
// en una cotización que sale sola por WhatsApp: el recojo, el destino y el nombre del contacto.
// Motor PURO, sin dependencias del resto del módulo (lo importan cotizacion-traslado.ts y
// envio-ia.ts, que se importan entre sí: aquí no puede haber ciclo).
//
// LA REGLA (auditoría de seguridad de la fase 2):
//  · Un texto libre es SOSPECHOSO si trae un enlace, 6 o más dígitos seguidos (con o sin espacios,
//    puntos o guiones entre ellos: así se escribe un teléfono o una cuenta), un importe, palabras
//    de pago (Yape, Plin, depósito, transferencia, cuenta, CCI, bancos…) o pasa de 80 caracteres.
//    «Miraflores. Para confirmar su reserva deposite S/ 50 al Yape 987 654 321» es una dirección
//    que, impresa en el PDF con el nombre y el RUC de la empresa, se lee como una instrucción de
//    pago de la empresa.
//  · Lo sospechoso NO se imprime: en el PDF queda solo el nombre de la zona, y la cotización va a
//    REVISIÓN (`texto_libre_sospechoso` en envio-ia.ts). Lo que no es sospechoso se imprime como
//    REFERENCIA corta junto al nombre de la zona, nunca en su lugar.
//  · `mencionaDinero` es la misma idea para el TEXTO del modelo cuando la herramienta no devolvió
//    ninguna cotización: si habla de dinero, el mensaje lo escribe el código.
//  · Las CONDICIONES del PDF (sección 4) las escribe una persona en la plantilla: `motivosLineaIA`
//    las marca en ámbar en /cotizaciones/plantillas y, de respaldo en el servidor, una con un enlace o
//    un número de 6+ dígitos deja la cotización para revisión (`condicionesSospechosas`).
//
// EN INGLÉS (`idioma = "en"`) LOS GUARDS SON CASTELLANO ∪ INGLÉS, nunca solo inglés: un cliente que
// escribe en inglés puede escribir también en castellano («S/ 150», «deposite al Yape»), y el modelo
// puede contestarle en cualquiera de los dos. Por construcción `mencionaDinero(x, "en")` ⊇
// `mencionaDinero(x, "es")` (la matriz lo barre), y con `"es"` —el defecto— todo es byte a byte lo de
// siempre. «transfer» NUNCA es una palabra de pago: es el nombre del servicio que se cotiza.
//
// LO QUE SE SUMÓ EN LA REVISIÓN DE SEGURIDAD S1 (23-10-2026), SIEMPRE COMO ALTERNATIVAS NUEVAS:
// ninguna expresión anterior se tocó, así que lo nuevo solo puede ser MÁS estricto (la sección 26 de
// scripts/prueba-traslados-ia.mts corre las de antes copiadas literal y exige nuevo ⊇ viejo, con cada
// divergencia DECLARADA). Pasaban impresas en el PDF que sale sin revisión «Miraflores. Send £50 to
// confirm», «send 50 via Revolut to @joe», «Advance via Bitcoin, wallet in chat» o «Envíe 50 por
// Skrill para confirmar», y el modelo podía escribir «That will be 150.» o «El total sería ciento
// cincuenta». Se agregaron: (1) monedas (£, GBP, CHF, CAD, AUD, BTC, USDT, dlls; «libras» y «pounds»
// solo DETRÁS del importe, porque delante son el nombre de una calle); (2) palabras de pago de
// servicios y criptomonedas en inglés y «adelanto», «prepago», «cripto», «billetera» en castellano
// (solo para el TEXTO LIBRE: las condiciones de la plantilla —`motivosLineaIA`— siguen con las listas
// de antes, porque «adelanto» es la palabra con que toda política de reserva describe el adelanto y
// marcarla pintaría de ámbar la política de cada empresa); (3) el RESPALDO ESTRUCTURAL: una cifra de 2+
// dígitos junto a un verbo que ordena pagar o confirmar («send», «envíe», «pay», «pague», «prepay»,
// «confirm», «confirmar») es sospechosa aunque no nombre ninguna moneda; y (4) en `mencionaDinero`, un
// importe EN LETRAS después de una palabra de precio («El total sería ciento cincuenta») y pistas
// nuevas en inglés («the fare is», «that will be», «it's just», «it comes to»), con sus exclusiones.
// ──────────────────────────────────────────────────────────────────────────────

/** Lo más largo que se imprime de una referencia del cliente (no medido: una dirección cabe). */
export const MAX_REFERENCIA = 80;
/** Lo más largo que se imprime en «Atención». */
export const MAX_ATENCION = 60;

/** Minúsculas y sin tildes, CONSERVANDO los símbolos ($, €, S/, %): para mirar importes. */
const minusculas = (s: string): string =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Por PALABRA: todo lo que no es letra o número es espacio. */
const porPalabra = (s: string): string => ` ${minusculas(s).replace(/[^a-z0-9]+/g, " ").trim()} `;

// ── 1. Los importes (movidos tal cual desde envio-ia.ts, que los reexporta) ──

const SIMBOLO = String.raw`(?:S\/\.?|US\$|U\$S|USD|PEN|\$|soles?|d[oó]lares?)`;
const NUM = String.raw`(\d[\d.,]*)`;
const IMPORTE_PREFIJO = new RegExp(String.raw`(?:^|[^A-Za-z0-9])${SIMBOLO}\s*${NUM}`, "gi");
const IMPORTE_SUFIJO = new RegExp(String.raw`${NUM}\s*(?:soles?|d[oó]lares?|USD|PEN|S\/)(?![A-Za-z])`, "gi");

/**
 * Un importe escrito, con separadores de miles o decimales: «1,234.50» → 1234.5; «120,50» → 120.5;
 * «1.234.567» → 1234567. Un punto solo es decimal (así se escribe en Perú).
 */
export function leerImporte(s: string): number | null {
  let t = String(s ?? "").replace(/[.,]+$/, "");
  if (!t) return null;
  const tienePunto = t.includes("."), tieneComa = t.includes(",");
  if (tienePunto && tieneComa) {
    const dec = t.lastIndexOf(".") > t.lastIndexOf(",") ? "." : ",";
    const miles = dec === "." ? "," : ".";
    t = t.split(miles).join("").replace(dec, ".");
  } else if (tieneComa) {
    t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  } else if (tienePunto && /^\d{1,3}(\.\d{3}){2,}$/.test(t)) {
    t = t.replace(/\./g, "");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Los importes CON símbolo de moneda que aparecen en un texto. «4 pax», horas y fechas no cuentan. */
export function importesEnTexto(texto: string): number[] {
  const out: number[] = [];
  const s = String(texto ?? "");
  for (const re of [IMPORTE_PREFIJO, IMPORTE_SUFIJO]) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) {
      const n = leerImporte(m[1]);
      if (n != null) out.push(n);
    }
  }
  return out;
}

// ── 2. ¿El texto habla de dinero? ────────────────────────────────────────────

/** Monedas, ya en minúsculas y sin tildes. Las largas antes que las cortas. */
const MONEDA = String.raw`(?:nuevos?\s+soles|soles?|dolares?(?:\s+americanos)?|euros?|usd|pen|eur|us\$|u\$s?|s\/\.?|\$|€)`;
const CIFRA = String.raw`\d+(?:[.,]\d+)*`;
const PALABRA_NUMERO = String.raw`(?:cero|un[oa]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieci[a-z]+|veinte|veinti[a-z]+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|quinient[oa]s|[a-z]+cient[oa]s|mil|millon(?:es)?)`;
const EN_LETRAS = String.raw`${PALABRA_NUMERO}(?:\s+(?:y\s+)?${PALABRA_NUMERO})*`;
const MONTO = String.raw`(?:${CIFRA}|${EN_LETRAS})`;

/** «S/ 150», «US$283.20», «€ 150», «PEN 99». */
const MONEDA_Y_MONTO = new RegExp(String.raw`(?:^|[^a-z0-9])${MONEDA}\s*${MONTO}(?![a-z0-9])`);
/** «150 nuevos soles», «150$», «283.20 dólares», «ciento cincuenta soles». */
const MONTO_Y_MONEDA = new RegExp(String.raw`(?:^|[^a-z0-9])${MONTO}\s*${MONEDA}(?![a-z])`);
/** «50 %», «50 por ciento». */
const PORCENTAJE = /%|\bpor\s*ciento\b/;
/** Palabras que ya son dinero aunque no lleven cifra. */
const PALABRAS_DINERO = /\b(?:descuentos?|rebajas?|rebajar|rebajamos|gratis|gratuit[oa]s?|igv)\b/;
/** Las palabras de precio del castellano (las de siempre). */
const PISTAS_PRECIO = String.raw`(?:total|precios?|costos?|cuesta|cuestan|costaria|costara|costaran|cobr[a-z]*|tarifas?|monto|importe|pagar|pago|abonar|seran|seria|saldria|aprox[a-z]*|alrededor|valor|vale)`;
/** Lo que, después de la cifra, dice que NO es dinero: una hora, una fecha, pasajeros, maletas, días… */
const NO_ES_DINERO = String.raw`h\b|hrs?\b|horas?\b|am\b|pm\b|a\.\s?m|p\.\s?m|pax\b|pasajer|persona|maleta|kg\b|kilo|km\b|min|dia|noche|asiento|unidad|vehicul|bus\b|van\b|auto\b|de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre)`;
/**
 * Una palabra de precio seguida (a tres palabras como mucho) de una cifra que no es una hora, una
 * fecha ni una cantidad de pasajeros, maletas o días: «serán aprox 300», «el total sería 150».
 */
const PISTA_Y_CIFRA = new RegExp(
  String.raw`\b${PISTAS_PRECIO}\b` +
  String.raw`(?:[^a-z0-9]+[a-z]+){0,3}?[^a-z0-9]+${CIFRA}` +
  String.raw`(?![0-9]|[.,][0-9]|[-/:][0-9]|\s*(?:${NO_ES_DINERO}))`,
);

// ── 2a. Lo que se SUMÓ en la revisión S1 (alternativas nuevas: las de arriba no cambian) ──────────

/** Monedas nuevas, delante o detrás del importe: «£150», «GBP 150», «150 usdt», «0.01 btc», «150 dlls». */
const MONEDA_MAS = String.raw`(?:usdt|gbp|chf|cad|aud|btc|dlls?|dls|£)`;
/** Solo DETRÁS del importe («50 libras», «50 pounds»): delante serían el nombre de una calle («Calle Libra 123»). */
const MONEDA_MAS_SUFIJO = String.raw`(?:pounds?|libras?)`;
const MONEDA_MAS_Y_MONTO = new RegExp(String.raw`(?:^|[^a-z0-9])${MONEDA_MAS}\s*${MONTO}(?![a-z0-9])`);
const MONTO_Y_MONEDA_MAS = new RegExp(String.raw`(?:^|[^a-z0-9])${MONTO}\s*(?:${MONEDA_MAS}|${MONEDA_MAS_SUFIJO})(?![a-z])`);
/**
 * Un importe EN LETRAS que no es un «un», «una» o «dos» suelto (que casi siempre cuentan otra cosa:
 * «sería un placer», «serán dos personas»): dos o más palabras de número («ciento cincuenta») o una de
 * veinte para arriba («cincuenta», «doscientos», «mil»).
 */
const GRANDE = String.raw`(?:veinte|veinti[a-z]+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|quinient[oa]s|[a-z]+cient[oa]s|mil|millon(?:es)?)`;
const LETRAS_IMPORTE = String.raw`(?:${PALABRA_NUMERO}(?:\s+(?:y\s+)?${PALABRA_NUMERO})+|${GRANDE})(?![a-z])`;
/** Lo que, después de un número en letras, dice que no es dinero (además de `NO_ES_DINERO`). */
const NO_ES_DINERO_LETRAS = String.raw`${NO_ES_DINERO}|y\s+media|y\s+cuarto|en\s+punto|anos?\b|veces|vez\b|cuadras?\b|metros?\b`;
/** Antes del número en letras: «a las veinte» es una hora. */
const NO_ES_HORA = String.raw`(?<!\b(?:a\s+)?las?\s+)`;
/** «El total sería ciento cincuenta», «Le cobramos ciento cincuenta»: la palabra de precio con un importe en letras. */
const PISTA_Y_LETRAS = new RegExp(
  String.raw`\b${PISTAS_PRECIO}\b(?:[^a-z0-9]+[a-z]+){0,3}?[^a-z0-9]+${NO_ES_HORA}${LETRAS_IMPORTE}(?!\s*(?:${NO_ES_DINERO_LETRAS}))`,
);
/** Una cifra de 2+ dígitos (o un importe en letras): las pistas de una sola palabra que no alcanzan con un «4». */
const CIFRA_2 = String.raw`\d{2,}(?:[.,]\d+)*(?![0-9]|[.,][0-9]|[-/:][0-9])`;
/**
 * Pistas cortas, pegadas al importe (a lo sumo «solo»/«apenas»/«unos» en medio), con una cifra de 2+
 * dígitos o un importe en letras: «Son 150 por la van» (solo si sigue lo que se cobra: «por la van»,
 * «por tramo», «en total»…; «son 4 pasajeros» o «son 2 maletas» no), «Quedaría en ciento cincuenta»,
 * «Le sale en 150».
 */
const PISTA_CORTA = new RegExp(
  String.raw`\b(?:son\s+(?:solo\s+|nada\s+mas\s+|unos\s+|unas\s+|apenas\s+)?(?:${CIFRA_2}|${LETRAS_IMPORTE})\s+(?:por\s+(?:la\s+|el\s+|cada\s+)?(?:van|auto|bus|camioneta|minivan|servicio|traslado|tramo|trayecto|viaje|persona|pasajero|ida|vuelta|retorno|todo)|en\s+total|cada\s+uno|c\/u|ida\s+y\s+vuelta|mas\s+igv|con\s+igv|sin\s+igv)\b` +
  String.raw`|(?:quedarian?\s+en|(?:le|te|les|nos)\s+(?:sale|saldria|saldra)\s+(?:en|a))\s+(?:solo\s+|apenas\s+|unos\s+)?(?:${CIFRA_2}|${NO_ES_HORA}${LETRAS_IMPORTE})(?!\s*(?:${NO_ES_DINERO_LETRAS})))`,
);
/** «150 por tramo», «150 cada tramo»: el importe con la unidad que se cobra. */
const CIFRA_POR_TRAMO = new RegExp(String.raw`(?:^|[^a-z0-9.,])${CIFRA_2}\s+(?:por\s+(?:tramo|trayecto)|cada\s+tramo)\b`);

/** Las alternativas nuevas del castellano (también corren en inglés, que es castellano ∪ inglés). */
function mencionaDineroMas(t: string): boolean {
  return MONEDA_MAS_Y_MONTO.test(t) || MONTO_Y_MONEDA_MAS.test(t) || PISTA_Y_LETRAS.test(t) || PISTA_CORTA.test(t) || CIFRA_POR_TRAMO.test(t);
}

// ── 2b. Lo mismo en inglés (se SUMA al castellano, nunca lo reemplaza) ─────────

/** Las monedas que se escriben en inglés, más las de castellano («150 soles» también es inglés). */
const MONEDA_INGLES = String.raw`(?:us\s+dollars?|dollars?|bucks?|${MONEDA})`;
const PALABRA_NUMERO_INGLES = String.raw`(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?)`;
const EN_LETRAS_INGLES = String.raw`${PALABRA_NUMERO_INGLES}(?:[\s-]+(?:and\s+)?${PALABRA_NUMERO_INGLES})*`;
const MONTO_INGLES = String.raw`(?:${CIFRA}|${EN_LETRAS_INGLES}|${EN_LETRAS})`;

/** «USD 150», «dollars one hundred» (raro, pero es dinero). */
const MONEDA_Y_MONTO_INGLES = new RegExp(String.raw`(?:^|[^a-z0-9])${MONEDA_INGLES}\s*${MONTO_INGLES}(?![a-z0-9])`);
/** «150 dollars», «one hundred fifty dollars», «20 bucks», «ninety soles». */
const MONTO_Y_MONEDA_INGLES = new RegExp(String.raw`(?:^|[^a-z0-9])${MONTO_INGLES}\s*${MONEDA_INGLES}(?![a-z])`);
/** «20 percent», «20 per cent». */
const PORCENTAJE_INGLES = /\bper\s*cent\b|\bpercent\b/;
/**
 * Palabras que ya son dinero en inglés. «off» solo DESPUÉS de una cifra («20 off», «$20 off»):
 * «drop off» es una parada y no un descuento. «free» no cuenta en «feel free»: es una fórmula de
 * cortesía, no algo gratis.
 */
const PALABRAS_DINERO_INGLES = /\b(?:discounts?|discounted|complimentary|cheap|cheaper|cheapest|tax|taxes|vat)\b|(?<!feel\s)\bfree\b|\d\s*%?\s*off\b/;
const MESES_INGLES = String.raw`(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)`;
/**
 * Una palabra de precio en inglés seguida (a tres palabras como mucho, que no sean un mes) de una
 * cifra que no es una hora, una fecha ni una cantidad de pasajeros, maletas o días: «the total would
 * be 150», «around 300». Las exclusiones son las del castellano más las del inglés.
 */
const PISTA_Y_CIFRA_INGLES = new RegExp(
  String.raw`\b(?:total|prices?|costs?|fees?|rates?|charges?|charged|pay|around|approx[a-z]*|about|would\s+be)\b` +
  String.raw`(?:[^a-z0-9]+(?!${MESES_INGLES}\b)[a-z]+){0,3}?[^a-z0-9]+${CIFRA}` +
  String.raw`(?![0-9]|[.,][0-9]|[-/:][0-9]|\s*(?:h\b|hrs?\b|horas?\b|am\b|pm\b|a\.\s?m|p\.\s?m|pax\b|pasajer|persona|maleta|kg\b|kilo|km\b|min|dia|noche|asiento|unidad|vehicul|bus\b|van\b|auto\b|de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre)` +
  String.raw`|people\b|persons?\b|passengers?\b|bags?\b|suitcases?\b|luggage\b|minutes?\b|hours?\b|days?\b|nights?\b|seats?\b|flights?\b|${MESES_INGLES}\b|st\b|nd\b|rd\b|th\b|of\s+${MESES_INGLES}\b))`,
);

/** Solo la parte inglesa de `mencionaDinero` (el castellano se mira aparte). */
function mencionaDineroIngles(t: string): boolean {
  return MONEDA_Y_MONTO_INGLES.test(t) || MONTO_Y_MONEDA_INGLES.test(t)
    || PORCENTAJE_INGLES.test(t) || PALABRAS_DINERO_INGLES.test(t) || PISTA_Y_CIFRA_INGLES.test(t);
}

/**
 * El texto menciona dinero: un importe con o sin símbolo junto a una moneda (también en letras),
 * un porcentaje, «descuento», «rebaja», «gratis», «IGV», o una palabra de precio con una cifra.
 * Pensado para el texto del MODELO cuando no hay cotización: el falso positivo cuesta que el
 * mensaje lo escriba el código; el falso negativo, un precio que nadie calculó. Con `"en"`, además
 * lo mismo en inglés («the total would be 150», «around one hundred fifty dollars», «free waiting
 * time», «VAT included»): castellano ∪ inglés.
 */
export function mencionaDinero(texto: string, idioma: IdiomaTexto = "es"): boolean {
  const t = minusculas(texto);
  if (!t.trim()) return false;
  const castellano = importesEnTexto(texto).length > 0
    || MONEDA_Y_MONTO.test(t) || MONTO_Y_MONEDA.test(t)
    || PORCENTAJE.test(t) || PALABRAS_DINERO.test(t) || PISTA_Y_CIFRA.test(t);
  return castellano || (idioma === "en" && mencionaDineroIngles(t));
}

// ── 3. ¿Se puede imprimir lo que escribió el cliente? ────────────────────────

/** El idioma de los guards: "en" = castellano ∪ inglés (un cliente en inglés puede escribir en los dos). */
export type IdiomaTexto = "es" | "en";

export type MotivoTextoLibre = "enlace" | "importe" | "palabra_de_pago" | "numero_largo" | "muy_largo";

export const ETIQUETA_TEXTO_LIBRE: Record<MotivoTextoLibre, string> = {
  enlace: "trae un enlace",
  importe: "menciona dinero",
  palabra_de_pago: "trae palabras de pago (Yape, Plin, depósito, cuenta…)",
  numero_largo: "trae un número de 6 o más dígitos (un teléfono o una cuenta)",
  muy_largo: `pasa de ${MAX_REFERENCIA} caracteres`,
};

const ENLACE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|pe|net|org|io|ly|me|app|info|link|co|xyz|site|online|store|shop|gl|gg|to|tk|click|top|biz)\b/;
/** Seis dígitos o más, con un espacio, punto o guion como mucho entre cada dos. */
const NUMERO_LARGO = /(?:\d[\s.\-]?){5}\d/;
/** Por palabra completa, sin tildes. */
const PALABRAS_PAGO = [
  "yape", "yapea", "yapear", "yapeame", "yapeo", "plin", "plinea", "plinear", "plineame",
  "deposito", "depositos", "deposite", "depositen", "depositar", "deposita", "depositas", "depositame",
  "transferencia", "transferencias", "transfiera", "transfieran", "transferir", "transfiere", "transfieres",
  "cuenta", "cuentas", "cci", "banco", "bcp", "bbva", "interbank", "scotiabank",
  "pago", "pagos", "pagar", "pague", "paguen", "abono", "abonar", "abone", "abonen",
];
/**
 * Las de inglés, que se SUMAN a las de castellano con `idioma = "en"`. Nunca «transfer» (es el
 * servicio que se cotiza: «airport transfer» es una dirección normal). «western union» va aparte
 * porque son dos palabras.
 */
const PALABRAS_PAGO_INGLES = [
  "paypal", "zelle", "venmo", "wire", "deposit", "deposits", "account", "accounts", "bank", "banks",
  "pay", "payment", "payments",
];
const FRASES_PAGO_INGLES = ["western union"];

const traePalabraDePago = (crudo: string, idioma: IdiomaTexto): boolean => {
  const pal = porPalabra(crudo);
  if (PALABRAS_PAGO.some((p) => pal.includes(` ${p} `))) return true;
  if (idioma !== "en") return false;
  return PALABRAS_PAGO_INGLES.some((p) => pal.includes(` ${p} `)) || FRASES_PAGO_INGLES.some((p) => pal.includes(` ${p} `));
};

/**
 * Por qué un texto libre NO se puede imprimir sin que lo vea una persona, o null si se puede. Se
 * declara el motivo (el primero que aplica, en este orden) para que la nota del ejecutivo lo diga.
 */
export function textoLibreSospechoso(s: string | null | undefined, idioma: IdiomaTexto = "es"): MotivoTextoLibre | null {
  const crudo = String(s ?? "");
  if (!crudo.trim()) return null;
  const t = minusculas(crudo);
  if (ENLACE.test(t)) return "enlace";
  if (importesEnTexto(crudo).length > 0 || mencionaDinero(crudo, idioma)) return "importe";
  if (traePalabraDePago(crudo, idioma)) return "palabra_de_pago";
  if (NUMERO_LARGO.test(t)) return "numero_largo";
  if (Array.from(crudo.trim()).length > MAX_REFERENCIA) return "muy_largo";
  return null;
}

const unaLinea = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();

/** La referencia del cliente que se puede imprimir (en una línea), o null si no hay o es sospechosa. */
export function referenciaImprimible(s: string | null | undefined, idioma: IdiomaTexto = "es"): string | null {
  const t = unaLinea(String(s ?? ""));
  if (!t || textoLibreSospechoso(t, idioma)) return null;
  return t;
}

/** El «Atención:» que se puede imprimir: hasta 60 caracteres, o null si no hay o es sospechoso. */
export function atencionImprimible(s: string | null | undefined, idioma: IdiomaTexto = "es"): string | null {
  const t = unaLinea(String(s ?? ""));
  if (!t || textoLibreSospechoso(t, idioma)) return null;
  const c = Array.from(t);
  return c.length <= MAX_ATENCION ? t : c.slice(0, MAX_ATENCION).join("").trim();
}

/**
 * El primer nombre para el saludo, SOLO si es una palabra de letras (sin cifras, enlaces ni
 * símbolos) y no es una palabra de pago. Si no, "" (y el saludo queda «Hola,»).
 */
export function primerNombreSeguro(nombre: string | null | undefined): string {
  const p = unaLinea(String(nombre ?? "")).split(" ")[0] ?? "";
  if (!/^[\p{L}][\p{L}'’-]{0,29}$/u.test(p)) return "";
  if (PALABRAS_PAGO.includes(porPalabra(p).trim())) return "";
  return p;
}

// ── 4. Las condiciones que la IA imprime en el PDF ───────────────────────────
// Las condiciones del PDF del traslado las escribe una persona en la plantilla de su regla
// (/cotizaciones/plantillas) y la IA las manda sin revisión. Movida aquí desde
// components/cotizaciones/plantillas/pantalla.ts (que la importa): la pantalla AVISA con ella y el
// servidor la usa de RESPALDO (lib/traslados/cotizar-ia-datos.ts): una sola definición.

/**
 * Por qué una línea de condiciones merece mirarse: un enlace, un número de 6+ dígitos (un teléfono o
 * una cuenta) o palabras de pago (Yape, Plin, depósito, transferencia, cuenta, CCI…). Usa el MISMO
 * detector que el texto libre del cliente; como ese devuelve solo el primer motivo y en su orden el
 * importe va antes, cada motivo se pregunta por separado. El importe y el largo NO cuentan aquí: una
 * condición dice «IGV (18 %)» o «adelanto del 50 %» con toda normalidad, y un aviso que sale siempre
 * se vuelve paisaje.
 */
export function motivosLineaIA(linea: string, idioma: IdiomaTexto = "es"): MotivoTextoLibre[] {
  const t = String(linea ?? "");
  if (!t.trim()) return [];
  const out: MotivoTextoLibre[] = [];
  if (textoLibreSospechoso(t) === "enlace") out.push("enlace");
  // Una plantilla en inglés se mira además con las palabras de pago del inglés («Pay to account…»);
  // las frases de dos palabras («western union») se miran sobre la línea entera.
  if (t.split(/[^\p{L}\p{N}]+/u).some(w => w && textoLibreSospechoso(w, idioma) === "palabra_de_pago")
    || (idioma === "en" && traePalabraDePago(t, "en"))) out.push("palabra_de_pago");
  // Fechas y horas no son un teléfono ni una cuenta («válido hasta el 31/12/2026»): se quitan antes.
  const sinFechas = t.replace(/\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
  if (textoLibreSospechoso(sinFechas.replace(/[^\d\s.\-]/g, " ")) === "numero_largo") out.push("numero_largo");
  return out;
}

/**
 * Los motivos que, en una condición del PDF que manda la IA, la dejan para que la revise un
 * ejecutivo: un enlace o un número de 6+ dígitos. Las palabras de pago NO: «el pago del parqueo
 * corre por cuenta del pasajero» es una condición normal (la pantalla las marca en ámbar igual).
 */
export const MOTIVOS_CONDICION_REVISION: readonly MotivoTextoLibre[] = ["enlace", "numero_largo"];

export type CondicionSospechosa = { lista: "incluye" | "no_incluye" | "generales" | "reserva" | "reserva_resumen"; linea: string; motivos: MotivoTextoLibre[] };

/**
 * Las líneas de las condiciones de una cotización (`consideraciones_json`) que la dejan para revisión
 * (`MOTIVOS_CONDICION_REVISION`), en el orden en que se imprimen. Se miran las líneas como las
 * imprime el PDF (sin espacios de más ni vacías). Incluye la política de reserva, cambios y
 * cancelación (`reserva`): la IA la manda al cliente igual que las otras, así que un enlace o un
 * número de 6+ dígitos en ella (un teléfono, una cuenta) también la deja para revisión. Por eso la
 * política no lleva los datos de contacto: los añade el código desde el perfil de la empresa. Lo
 * mismo su RESUMEN (`reserva_resumen`, cotizaciones-08): la IA lo manda en el PDF y en el WhatsApp. El
 * ENLACE a las condiciones completas no es una línea: lo agrega el código, y no se juzga aquí.
 */
export function condicionesSospechosas(c: unknown): CondicionSospechosa[] {
  const o = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
  const out: CondicionSospechosa[] = [];
  for (const lista of ["incluye", "no_incluye", "generales", "reserva", "reserva_resumen"] as const) {
    const ls = Array.isArray(o[lista]) ? (o[lista] as unknown[]).map(s => String(s ?? "").trim()).filter(Boolean) : [];
    for (const linea of ls) {
      const motivos = motivosLineaIA(linea).filter(m => MOTIVOS_CONDICION_REVISION.includes(m));
      if (motivos.length) out.push({ lista, linea, motivos });
    }
  }
  return out;
}
