// lib/radar/coherencia-voucher.ts — El cuadre aritmético de un voucher de grifo.
// Módulo PURO (no toca la base ni secretos), mismo criterio que lib/costeo-propio.ts:
// recibe los números que leyó la IA y devuelve un veredicto. Lo consume
// lib/radar/acciones.ts (accionCombustible) y lo prueba scripts/prueba-voucher.mts.
//
// POR QUÉ EXISTE. Un voucher de grifo imprime TRES números atados por una identidad:
//
//     CANTIDAD × PRECIO UNITARIO = IMPORTE
//
// así que el propio papel trae con qué verificar su lectura. Cuando la IA leyó
// "6.799" donde decía "8.799" (nota de despacho V72S-00023776, COESTI/Macarena),
// el ERP tenía los tres números y podía saberlo sin mirar la foto: 6.799 × 24.640
// = S/ 167.53 y el total impreso era S/ 216.81. Hasta ahora solo se levantaba la
// anomalía "monto_inconsistente" —"no cuadra"— y el revisor tenía que abrir la
// foto, encontrar el dígito y teclearlo. La aritmética dice MÁS que eso: dividiendo
// el total entre el precio sale 8.799, que difiere de lo leído en UN SOLO DÍGITO
// (6→8, el par que más se confunde en impresión de matriz de puntos). Eso ya no es
// una sospecha, es el número.
//
// LA REGLA QUE SEPARA UN DÍGITO MAL LEÍDO DE UN DESCUENTO DEL GRIFO. Un voucher
// puede no cuadrar por motivos legítimos (promoción, redondeo, vale de descuento).
// La diferencia es que esos descuadres son de un importe arbitrario, mientras que un
// dígito mal leído produce una diferencia que se explica EXACTAMENTE cambiando una
// cifra. Por eso solo se propone una corrección cuando el valor que impone la
// aritmética está a UN error de lectura del que leyó la IA (un dígito distinto, el
// punto decimal corrido, o una cifra de más/de menos) y además el trío corregido
// cuadra de verdad. Si no, se informa el descuadre y no se toca nada.
//
// Y LO QUE NUNCA HACE: registrar solo. Una corrección aritmética es una PROPUESTA —
// quien decide sobre plata es una persona. acciones.ts la marca bloqueante para que
// la carga pase por /radar-ia?tab=combustible con el número ya puesto en el
// formulario, a un clic de confirmarse contra la foto.

/** Lo que la IA leyó del voucher. `null` = no lo leyó. */
export type LecturaVoucher = {
  /** Galones o litros despachados. */
  cantidad: number | null;
  /** Precio por galón/litro. */
  precio: number | null;
  /** Importe total del comprobante. */
  monto: number | null;
  /**
   * Los dígitos de la cantidad TAL CUAL los transcribió la IA ("8.799x"), si los dio.
   * Es una segunda lectura independiente del mismo dato: cuando confirma lo que impone
   * la aritmética, la corrección deja de depender de una sola pasada del modelo.
   */
  cantidadTexto?: string | null;
  /** "gal" | "lt" — solo para redactar el detalle. */
  unidad?: string | null;
};

export type CampoVoucher = "cantidad" | "precio" | "monto";

export type CorreccionVoucher = {
  campo: CampoVoucher;
  /** Lo que leyó la IA. `null` cuando el campo faltaba y se derivó de los otros dos. */
  leido: number | null;
  corregido: number;
  tipo: "digito" | "decimal" | "digito_de_mas" | "digito_de_menos" | "derivado";
  /** Descripción corta del error de lectura ("6→8"). */
  cambio: string;
  /** La transcripción literal de la IA coincide con el valor corregido. */
  confirmadoPorTexto?: boolean;
};

export type CoherenciaVoucher = {
  estado:
    | "incompleto"   // faltan dos o más de los tres números: no hay con qué verificar
    | "cuadra"       // cantidad × precio = importe (dentro del redondeo del voucher)
    | "completado"   // faltaba UNO de los tres y los otros dos lo determinan
    | "corregible"   // no cuadra y UN error de lectura lo explica: hay número corregido
    | "ambiguo"      // no cuadra y hay más de una lectura que lo explicaría: no se toca
    | "descuadra";   // no cuadra y ningún error de lectura lo explica (¿descuento?)
  /** cantidad × precio con lo que leyó la IA, redondeado a céntimos. */
  producto: number | null;
  /** Diferencia contra el importe leído (soles). */
  diferencia: number | null;
  /** La corrección a aplicar. Solo en "corregible" y "completado". */
  correccion: CorreccionVoucher | null;
  /** Las lecturas que explicarían el descuadre cuando hay más de una ("ambiguo"). */
  candidatos: CorreccionVoucher[];
  /** Texto listo para la anomalía / la alerta. "" cuando no hay nada que decir. */
  detalle: string;
};

// ── Tolerancia ───────────────────────────────────────────────────────────────
// El voucher imprime el importe redondeado a céntimos y el precio a 3 decimales, así
// que el producto nunca da exacto: 8.799 × 24.640 = 216.80736 y el papel dice 216.81.
// 4 por mil (con piso de 5 céntimos) absorbe ese redondeo y sigue detectando un dígito
// mal leído, que mueve el importe mucho más que eso.

export const TOLERANCIA_MINIMA = 0.05;
export const TOLERANCIA_RELATIVA = 0.004;

export function toleranciaCuadre(monto: number): number {
  return Math.max(TOLERANCIA_MINIMA, TOLERANCIA_RELATIVA * Math.abs(monto));
}

// ── Utilidades numéricas ─────────────────────────────────────────────────────

const pos = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

const redondear = (n: number, dec: number) => Math.round(n * 10 ** dec) / 10 ** dec;

/** Con cuántos decimales reportó la IA este número (los vouchers no imprimen más de 3). */
function decimalesDe(n: number, tope = 3): number {
  const s = String(n);
  const i = s.indexOf(".");
  if (i === -1 || /e/i.test(s)) return 0;
  return Math.min(tope, s.length - i - 1);
}

/** Los dígitos del número tal como se imprimirían con `dec` decimales ("6.799" → "6799"). */
const digitosImpresos = (n: number, dec: number) => Math.abs(n).toFixed(dec).replace(/\D/g, "");

/** Dígitos significativos, sin punto ni ceros de relleno: 8.799, 87.99 y 8799 dan "8799". */
function digitosSignificativos(n: number): string {
  const s = Math.abs(n).toFixed(6).replace(".", "");
  return s.replace(/^0+/, "").replace(/0+$/, "");
}

type ErrorDeLectura = { tipo: CorreccionVoucher["tipo"]; cambio: string };

/**
 * ¿`a` y `b` (dos cadenas de dígitos) están a UN error de lectura? Una cifra distinta,
 * una de más o una de menos. Cualquier otra distancia devuelve null: a partir de dos
 * cambios ya no es una confusión de lectura, es otro número.
 */
function editoUnDigito(a: string, b: string): ErrorDeLectura | null {
  if (a === b) return null;
  if (a.length === b.length) {
    let idx = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        if (idx !== -1) return null; // dos o más cifras distintas
        idx = i;
      }
    }
    return idx === -1 ? null : { tipo: "digito", cambio: `${a[idx]}→${b[idx]}` };
  }
  const sobra = a.length > b.length;
  const [largo, corto] = sobra ? [a, b] : [b, a];
  if (largo.length - corto.length !== 1) return null;
  for (let i = 0; i < largo.length; i++) {
    if (largo.slice(0, i) + largo.slice(i + 1) === corto) {
      return sobra
        ? { tipo: "digito_de_mas", cambio: `sobra la cifra "${largo[i]}"` }
        : { tipo: "digito_de_menos", cambio: `falta la cifra "${largo[i]}"` };
    }
  }
  return null;
}

/**
 * Pares de dígitos que de verdad se confunden leyendo un voucher: la nota de despacho
 * sale de una impresora de matriz de puntos o térmica (tinta corrida, papel arrugado) y
 * el surtidor es un display de 7 segmentos, donde un segmento apagado convierte un 8 en
 * casi cualquier cosa. Solo se usa para REDACTAR: la evidencia es la aritmética, no la
 * tipografía, así que un par que no esté en esta lista igual se corrige.
 */
const PARES_CONFUNDIBLES = new Set([
  "68", "86", "08", "80", "89", "98", "38", "83", "58", "85", "28", "82",
  "05", "50", "06", "60", "09", "90", "56", "65", "35", "53", "39", "93",
  "17", "71", "14", "41", "27", "72", "23", "32", "49", "94", "45", "54",
]);

const esParConfundible = (cambio: string) => {
  const m = /^(\d)→(\d)$/.exec(cambio);
  return !!m && PARES_CONFUNDIBLES.has(m[1] + m[2]);
};

// ── Formateo del detalle ─────────────────────────────────────────────────────

const soles = (n: number) =>
  `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const conUnidad = (n: number, unidad: string) => `${n} ${unidad}`;

const ETIQUETA: Record<CampoVoucher, string> = {
  cantidad: "la cantidad",
  precio: "el precio unitario",
  monto: "el importe total",
};

/** El valor de un campo con su unidad, para el texto. */
function valorTexto(campo: CampoVoucher, n: number, unidad: string): string {
  if (campo === "cantidad") return conUnidad(n, unidad);
  return soles(n);
}

// ── Parseo de la transcripción literal ("8.799x") ────────────────────────────

/**
 * Número de una transcripción cruda del voucher. Acepta "8.799", "8.799x", "8,799 UGL".
 * Devuelve null ante cualquier ambigüedad (dos separadores, nada numérico): esto solo
 * CORROBORA la aritmética, así que quedarse callado es gratis y adivinar no.
 */
export function numeroDeTranscripcion(txt: string | null | undefined): number | null {
  if (txt == null) return null;
  const s = String(txt).replace(/[^0-9.,]/g, "");
  if (!/\d/.test(s)) return null;
  const separadores = (s.match(/[.,]/g) ?? []).length;
  if (separadores > 1) return null; // "1,234.56" y compañía: no es una cantidad de grifo
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── El veredicto ─────────────────────────────────────────────────────────────

const vacio = (extra: Partial<CoherenciaVoucher> = {}): CoherenciaVoucher => ({
  estado: "incompleto",
  producto: null,
  diferencia: null,
  correccion: null,
  candidatos: [],
  detalle: "",
  ...extra,
});

/**
 * Cuadra los tres números del voucher y, si no cuadran, dice cuál se leyó mal y cuál es
 * su valor. Nunca inventa: solo propone el número que imponen los otros dos, y solo
 * cuando está a un error de lectura del que se leyó.
 */
export function revisarCoherenciaVoucher(l: LecturaVoucher): CoherenciaVoucher {
  const unidad = (l.unidad ?? "gal").trim() || "gal";
  const cantidad = pos(l.cantidad);
  const precio = pos(l.precio);
  const monto = pos(l.monto);
  const textoCantidad = numeroDeTranscripcion(l.cantidadTexto);

  // Falta más de uno: el voucher no se verifica a sí mismo.
  const conocidos = [cantidad, precio, monto].filter((v) => v != null).length;
  if (conocidos < 2) return vacio();

  // Falta exactamente uno y los otros dos lo determinan: se completa (siempre a revisión,
  // ver acciones.ts — un número derivado de la plata no es una lectura del papel).
  if (conocidos === 2) {
    const derivada = derivar(cantidad, precio, monto, unidad);
    return derivada ?? vacio({ producto: cantidad != null && precio != null ? redondear(cantidad * precio, 2) : null });
  }

  const producto = redondear(cantidad! * precio!, 2);
  const diferencia = redondear(producto - monto!, 2);
  const tol = toleranciaCuadre(monto!);
  if (Math.abs(diferencia) <= tol) {
    return { estado: "cuadra", producto, diferencia, correccion: null, candidatos: [], detalle: "" };
  }

  // No cuadra. Para cada uno de los tres: si ESE fuera el mal leído, ¿qué valor imponen
  // los otros dos, y está a un error de lectura del que leyó la IA?
  const hipotesis: { campo: CampoVoucher; leido: number; real: number }[] = [
    { campo: "cantidad", leido: cantidad!, real: monto! / precio! },
    { campo: "precio", leido: precio!, real: monto! / cantidad! },
    { campo: "monto", leido: monto!, real: cantidad! * precio! },
  ];

  const candidatos: CorreccionVoucher[] = [];
  for (const h of hipotesis) {
    // El valor que imponen los otros dos hay que redondearlo para compararlo con lo leído, y
    // con CUÁNTOS decimales no es obvio: los del número leído (el caso normal, un dígito
    // cambiado conserva la forma) y los que de verdad imprime el voucher. El segundo es el
    // que atrapa el punto decimal corrido — "8548" leído donde decía "8.548" no tiene
    // decimales, así que redondear a los suyos daría 9 y no explicaría nada.
    const decNatural = h.campo === "monto" ? 2 : 3;
    const posibles = Array.from(new Set([redondear(h.real, decimalesDe(h.leido)), redondear(h.real, decNatural)]));
    for (const corregido of posibles) {
      if (!(corregido > 0)) continue;
      // El trío corregido tiene que cuadrar DE VERDAD: redondear el valor derivado a los
      // decimales que imprime el voucher puede dejarlo fuera de tolerancia, y entonces la
      // hipótesis no explica nada.
      const trio: [number, number, number] =
        h.campo === "cantidad" ? [corregido, precio!, monto!]
        : h.campo === "precio" ? [cantidad!, corregido, monto!]
        : [cantidad!, precio!, corregido];
      if (Math.abs(trio[0] * trio[1] - trio[2]) > toleranciaCuadre(trio[2])) continue;

      const err = diferenciaDeLectura(h.leido, corregido);
      if (!err) continue;
      candidatos.push({
        campo: h.campo,
        leido: h.leido,
        corregido,
        tipo: err.tipo,
        cambio: err.cambio,
        confirmadoPorTexto: h.campo === "cantidad" && textoCantidad != null && textoCantidad === corregido,
      });
      break; // una explicación por campo basta; dos redondeos del mismo campo no son dos dudas
    }
  }

  const base = { producto, diferencia };
  if (candidatos.length === 0) {
    return {
      ...base,
      estado: "descuadra",
      correccion: null,
      candidatos: [],
      detalle:
        `El voucher no cuadra: ${conUnidad(cantidad!, unidad)} × ${soles(precio!)} = ${soles(producto)}, ` +
        `pero el importe leído es ${soles(monto!)} (${soles(Math.abs(diferencia))} de diferencia). ` +
        `Ningún dígito mal leído lo explica — puede ser un descuento del grifo, otro producto en el mismo ` +
        `comprobante o un número que no se llegó a leer. Revisar los tres contra la foto.`,
    };
  }

  // La transcripción literal desempata: si la IA escribió "8.799" al costado, esa hipótesis
  // tiene una segunda lectura a favor y las otras no.
  const confirmados = candidatos.filter((c) => c.confirmadoPorTexto);
  const elegidos = confirmados.length === 1 ? confirmados : candidatos;

  if (elegidos.length > 1) {
    return {
      ...base,
      estado: "ambiguo",
      correccion: null,
      candidatos,
      detalle:
        `El voucher no cuadra (${conUnidad(cantidad!, unidad)} × ${soles(precio!)} = ${soles(producto)} ` +
        `contra ${soles(monto!)} impresos) y hay más de una lectura que lo explicaría: ` +
        candidatos
          .map((c) => `${ETIQUETA[c.campo]} podría ser ${valorTexto(c.campo, c.corregido, unidad)} (${c.cambio})`)
          .join("; ") +
        `. No se corrigió nada: hay que mirar la foto y decidir.`,
    };
  }

  const c = elegidos[0];
  return {
    ...base,
    estado: "corregible",
    correccion: c,
    candidatos,
    detalle: detalleCorreccion(c, { cantidad: cantidad!, precio: precio!, monto: monto! }, producto, unidad),
  };
}

/** Texto de la anomalía cuando la aritmética identificó el dígito mal leído. */
function detalleCorreccion(
  c: CorreccionVoucher,
  leidos: { cantidad: number; precio: number; monto: number },
  producto: number,
  unidad: string
): string {
  const explicacion =
    c.tipo === "decimal"
      ? "el punto decimal quedó corrido"
      : c.tipo === "digito"
        ? `un solo dígito distinto (${c.cambio})${esParConfundible(c.cambio) ? ", el par que más se confunde en la impresión del voucher" : ""}`
        : c.tipo === "digito_de_mas"
          ? `una cifra de más (${c.cambio})`
          : `una cifra de menos (${c.cambio})`;
  const confirma = c.confirmadoPorTexto ? ", y coincide con los dígitos que la propia IA transcribió del papel" : "";
  return (
    `La IA leyó ${ETIQUETA[c.campo]} como ${valorTexto(c.campo, c.leido!, unidad)} y el voucher no cuadra: ` +
    `${conUnidad(leidos.cantidad, unidad)} × ${soles(leidos.precio)} = ${soles(producto)} contra ${soles(leidos.monto)} impresos. ` +
    `Con los otros dos números ${ETIQUETA[c.campo]} solo puede ser ${valorTexto(c.campo, c.corregido, unidad)} — ` +
    `${explicacion}${confirma}. Se corrigió a ${valorTexto(c.campo, c.corregido, unidad)}: confírmalo contra la foto antes de registrar.`
  );
}

/** Completa el único número que faltaba a partir de los otros dos. */
function derivar(
  cantidad: number | null,
  precio: number | null,
  monto: number | null,
  unidad: string
): CoherenciaVoucher | null {
  const arma = (campo: CampoVoucher, valor: number, comoSaleDe: string): CoherenciaVoucher => ({
    estado: "completado",
    producto: null,
    diferencia: null,
    correccion: { campo, leido: null, corregido: valor, tipo: "derivado", cambio: comoSaleDe },
    candidatos: [],
    detalle:
      `No se leyó ${ETIQUETA[campo]} del voucher, pero los otros dos números la determinan: ` +
      `${comoSaleDe} = ${valorTexto(campo, valor, unidad)}. Es un número CALCULADO a partir de los otros dos, ` +
      `no leído del papel.`,
  });
  if (cantidad == null && precio != null && monto != null) {
    const v = redondear(monto / precio, 3);
    return v > 0 ? arma("cantidad", v, `${soles(monto)} ÷ ${soles(precio)}`) : null;
  }
  if (precio == null && cantidad != null && monto != null) {
    const v = redondear(monto / cantidad, 3);
    return v > 0 ? arma("precio", v, `${soles(monto)} ÷ ${conUnidad(cantidad, unidad)}`) : null;
  }
  if (monto == null && cantidad != null && precio != null) {
    const v = redondear(cantidad * precio, 2);
    return v > 0 ? arma("monto", v, `${conUnidad(cantidad, unidad)} × ${soles(precio)}`) : null;
  }
  return null;
}

// ── La inversión que el cuadre NO puede ver ──────────────────────────────────

export type InversionVoucher = {
  cantidad: number;
  precio: number;
  detalle: string;
};

/**
 * ¿Están intercambiados la cantidad y el precio?
 *
 * **La multiplicación es conmutativa, así que el cuadre de arriba es CIEGO a esto.** La nota
 * V87T-00008182 imprime `040002072 UGL 8.829x 6.990` con `GLP-G 61.71`: 8.829 galones a
 * S/ 6.990. La IA guardó 6.99 galones a S/ 8.829 — y `6.99 × 8.829 = 61.71` cuadra igual de
 * bien que `8.829 × 6.990`. Ninguna cuenta con esos tres números puede distinguir un caso del
 * otro; hace falta una CUARTA cifra que venga de fuera del voucher.
 *
 * Esa cifra es el **precio referencial del tipo de combustible** (`precios_combustible`, que
 * AFA mantiene al día por tipo). Con GLP a S/ 7.00: lo que quedó en "cantidad" (6.99) es el
 * precio referencial casi exacto, y lo que quedó en "precio" (8.829) se le va un 26 %. Esa
 * asimetría es la firma de la inversión.
 *
 * Se exige que la evidencia sea fuerte por los dos lados —el valor en `cantidad` pegado al
 * referencial (≤ 8 %) **y** el de `precio` claramente fuera (> 20 %)— porque el fallo caro
 * aquí es al revés: dar por invertida una compra legítima intercambia los dos números y
 * escribe un galonaje y un precio que nadie despachó. Sin referencial (0 o ausente) no se
 * juzga nada: el guard se abstiene antes que adivinar.
 */
export function detectarInversionCantidadPrecio(
  cantidad: number | null,
  precio: number | null,
  precioRef: number | null,
  unidad = "gal"
): InversionVoucher | null {
  const c = pos(cantidad);
  const p = pos(precio);
  const ref = pos(precioRef);
  if (c == null || p == null || ref == null) return null;
  if (Math.abs(c - p) < 1e-9) return null; // iguales: intercambiarlos no cambia nada

  const desvio = (v: number) => Math.abs(v - ref) / ref;
  const CERCA = 0.08; // el valor que ocupa "cantidad" es, en realidad, el precio
  const LEJOS = 0.2;  // y el que ocupa "precio" no puede serlo
  if (!(desvio(c) <= CERCA && desvio(p) > LEJOS)) return null;

  return {
    cantidad: p,
    precio: c,
    detalle:
      `La cantidad y el precio están intercambiados: se leyó ${c} ${unidad} a ${soles(p)}, pero ${c} es ` +
      `justo el precio referencial de este combustible (${soles(ref)}) y ${soles(p)} se le aleja un ` +
      `${Math.round(desvio(p) * 100)} %. El voucher imprime la cantidad pegada a la "x" y el precio después, ` +
      `así que lo despachado son ${p} ${unidad} a ${soles(c)}. El cuadre no lo detecta solo: ` +
      `${c} × ${p} da el mismo total que ${p} × ${c}. Se corrigió — confírmalo contra la foto.`,
  };
}

/** ¿`leido` y `corregido` se explican por UN error de lectura? */
function diferenciaDeLectura(leido: number, corregido: number): ErrorDeLectura | null {
  if (leido === corregido) return null;
  if (digitosSignificativos(leido) === digitosSignificativos(corregido)) {
    return { tipo: "decimal", cambio: `${leido} → ${corregido}` };
  }
  // Los dos con los MISMOS decimales, y los del más preciso: comparar "8.79" contra "8.80"
  // (el redondeo de 8.799) inventaría dos cifras distintas donde solo falta una.
  const dec = Math.max(decimalesDe(leido), decimalesDe(corregido));
  return editoUnDigito(digitosImpresos(leido, dec), digitosImpresos(corregido, dec));
}
