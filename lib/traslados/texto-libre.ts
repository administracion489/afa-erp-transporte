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
/**
 * Una palabra de precio seguida (a tres palabras como mucho) de una cifra que no es una hora, una
 * fecha ni una cantidad de pasajeros, maletas o días: «serán aprox 300», «el total sería 150».
 */
const PISTA_Y_CIFRA = new RegExp(
  String.raw`\b(?:total|precios?|costos?|cuesta|cuestan|costaria|costara|costaran|cobr[a-z]*|tarifas?|monto|importe|pagar|pago|abonar|seran|seria|saldria|aprox[a-z]*|alrededor|valor|vale)\b` +
  String.raw`(?:[^a-z0-9]+[a-z]+){0,3}?[^a-z0-9]+${CIFRA}` +
  String.raw`(?![0-9]|[.,][0-9]|[-/:][0-9]|\s*(?:h\b|hrs?\b|horas?\b|am\b|pm\b|a\.\s?m|p\.\s?m|pax\b|pasajer|persona|maleta|kg\b|kilo|km\b|min|dia|noche|asiento|unidad|vehicul|bus\b|van\b|auto\b|de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre)))`,
);

/**
 * El texto menciona dinero: un importe con o sin símbolo junto a una moneda (también en letras),
 * un porcentaje, «descuento», «rebaja», «gratis», «IGV», o una palabra de precio con una cifra.
 * Pensado para el texto del MODELO cuando no hay cotización: el falso positivo cuesta que el
 * mensaje lo escriba el código; el falso negativo, un precio que nadie calculó.
 */
export function mencionaDinero(texto: string): boolean {
  const t = minusculas(texto);
  if (!t.trim()) return false;
  return importesEnTexto(texto).length > 0
    || MONEDA_Y_MONTO.test(t) || MONTO_Y_MONEDA.test(t)
    || PORCENTAJE.test(t) || PALABRAS_DINERO.test(t) || PISTA_Y_CIFRA.test(t);
}

// ── 3. ¿Se puede imprimir lo que escribió el cliente? ────────────────────────

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
 * Por qué un texto libre NO se puede imprimir sin que lo vea una persona, o null si se puede. Se
 * declara el motivo (el primero que aplica, en este orden) para que la nota del ejecutivo lo diga.
 */
export function textoLibreSospechoso(s: string | null | undefined): MotivoTextoLibre | null {
  const crudo = String(s ?? "");
  if (!crudo.trim()) return null;
  const t = minusculas(crudo);
  if (ENLACE.test(t)) return "enlace";
  if (importesEnTexto(crudo).length > 0 || mencionaDinero(crudo)) return "importe";
  const pal = porPalabra(crudo);
  if (PALABRAS_PAGO.some((p) => pal.includes(` ${p} `))) return "palabra_de_pago";
  if (NUMERO_LARGO.test(t)) return "numero_largo";
  if (Array.from(crudo.trim()).length > MAX_REFERENCIA) return "muy_largo";
  return null;
}

const unaLinea = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();

/** La referencia del cliente que se puede imprimir (en una línea), o null si no hay o es sospechosa. */
export function referenciaImprimible(s: string | null | undefined): string | null {
  const t = unaLinea(String(s ?? ""));
  if (!t || textoLibreSospechoso(t)) return null;
  return t;
}

/** El «Atención:» que se puede imprimir: hasta 60 caracteres, o null si no hay o es sospechoso. */
export function atencionImprimible(s: string | null | undefined): string | null {
  const t = unaLinea(String(s ?? ""));
  if (!t || textoLibreSospechoso(t)) return null;
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
export function motivosLineaIA(linea: string): MotivoTextoLibre[] {
  const t = String(linea ?? "");
  if (!t.trim()) return [];
  const out: MotivoTextoLibre[] = [];
  if (textoLibreSospechoso(t) === "enlace") out.push("enlace");
  if (t.split(/[^\p{L}\p{N}]+/u).some(w => w && textoLibreSospechoso(w) === "palabra_de_pago")) out.push("palabra_de_pago");
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
