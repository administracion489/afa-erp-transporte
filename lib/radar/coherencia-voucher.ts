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
//
// HAY DOS TOLERANCIAS Y HACEN TRABAJOS DISTINTOS.
//  · `toleranciaRedondeo` decide si el voucher CUADRA: lo único que puede separar el producto del
//    importe sin que nada esté mal leído es el redondeo de los tres números. Se acota con la mitad
//    de la SEGUNDA cifra decimal de la cantidad y del precio (holgada a propósito: un precio impreso
//    con 2 decimales, o una cantidad que la IA devolvió redondeada a 2, siguen cuadrando) más medio
//    céntimo del importe.
//  · `toleranciaCuadre` (4 por mil, piso de 5 céntimos) era la que decidía lo anterior, y era
//    demasiado ancha: en una carga de S/ 260 dejaba pasar S/ 1.04. La nota de la CWZ-371 del
//    11/10/2026 imprimía `10.527x 24.720 = 260.23` y la IA leyó el precio como 24.64 —el del ejemplo
//    del prompt—: 10.527 × 24.64 = 259.39, ochenta y cuatro céntimos menos, «cuadraba», y la carga
//    se guardó con el precio de otra nota y S/ 0.84 menos de gasto (combustible.total es
//    galones × precio). Ahora solo marca la «banda fina»: lo que antes se daba por bueno y hoy se
//    corrige sin mandar a revisión (ver acciones.ts).

export const TOLERANCIA_MINIMA = 0.05;
export const TOLERANCIA_RELATIVA = 0.004;

/** Media unidad de la segunda cifra decimal: lo más que se mueve un número al redondearlo a 2. */
export const MEDIA_UNIDAD_REDONDEO = 0.005;
/** Piso de la tolerancia de redondeo (céntimos de holgura para la aritmética en coma flotante). */
export const TOLERANCIA_REDONDEO_MIN = 0.02;

/**
 * Cuánto pueden separarse `cantidad × precio` y el importe impreso SOLO por redondeo: medio céntimo
 * del importe, más lo que mueve redondear la cantidad y el precio a 2 decimales (cada uno pesa por el
 * otro). Más allá de esto algún número está mal leído —o el grifo hizo un descuento—, aunque la
 * diferencia sea de céntimos.
 */
export function toleranciaRedondeo(cantidad: number, precio: number): number {
  return Math.max(
    TOLERANCIA_REDONDEO_MIN,
    MEDIA_UNIDAD_REDONDEO + MEDIA_UNIDAD_REDONDEO * (Math.abs(cantidad) + Math.abs(precio))
  );
}

/**
 * Desde cuánto un descuadre que ningún dígito explica es `monto_inconsistente` (bloquea) en vez de
 * corregirse tomando el importe como el dato que manda. Vivía en acciones.ts como un literal; está
 * aquí porque `precioSegunImporte` lo usa de techo y las dos reglas tienen que decir lo mismo.
 */
export function umbralImporteInconsistente(monto: number): number {
  return Math.max(2, 0.05 * Math.abs(monto));
}

// ── Qué tan cerca del precio referencial hay que estar para que cuente como evidencia ────
// Las usa `detectarInversionCantidadPrecio` (¿el precio y la cantidad están cambiados?) y
// `revisarTipoContraPrecio` de tipo-voucher.ts (¿este precio es el de OTRO combustible?). Las dos
// preguntas se contestan con la misma asimetría —un valor clavado en el referencial y el otro
// claramente fuera— así que comparten los números: dos umbrales que se llamen igual y valgan
// distinto son dos módulos que discrepan sobre el mismo voucher.
/** Pegado al referencial: cuenta como "este valor ES el de ese combustible". */
export const CERCA_REFERENCIAL = 0.08;
/** Claramente fuera: cuenta como "este valor NO puede ser el de ese combustible". */
export const LEJOS_REFERENCIAL = 0.2;

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
  // Con el producto SIN redondear: redondear a céntimos antes de comparar le regala medio céntimo.
  if (Math.abs(cantidad! * precio! - monto!) <= toleranciaRedondeo(cantidad!, precio!)) {
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
      if (Math.abs(trio[0] * trio[1] - trio[2]) > toleranciaRedondeo(trio[0], trio[1])) continue;

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

// ── EL IMPORTE MANDA SOBRE EL PRECIO ─────────────────────────────────────────

export type AjustePrecio = {
  /** Lo que leyó la IA. */
  leido: number;
  /** El precio que reproduce el importe impreso: importe ÷ cantidad, a 3 decimales. */
  precio: number;
  detalle: string;
};

/** Un precio con hasta 3 decimales, que es como lo imprime el voucher (S/ 24.72, S/ 7.549). */
const precioTexto = (n: number) =>
  `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`;

/**
 * Cuando el voucher no cuadra y NINGÚN dígito mal leído lo explica, ¿qué se guarda?
 *
 * Hasta ahora, el precio leído. Y `combustible.total` es una columna GENERADA
 * (`galones × precio_galon`), así que guardar el precio leído es guardar un gasto que no es el del
 * comprobante: la carga de la CWZ-371 entró a S/ 259.39 con el papel diciendo S/ 260.23, porque el
 * precio era el del ejemplo del prompt. De los tres números, el IMPORTE es el que manda: es el dato
 * del comprobante (se imprime dos veces, en la línea y en el TOTAL, y el surtidor lo muestra), es lo
 * que se pagó, y el prompt ya le pide a la IA usarlo como valor oficial. Entonces el precio que se
 * guarda es el que lo reproduce: importe ÷ cantidad.
 *
 * Eso es mejor en los tres casos que producen un descuadre así —un precio mal leído en más de un
 * dígito, una cantidad mal leída en más de uno, o un descuento del grifo—: en los tres el gasto
 * queda igual al comprobante, y en el tercero el precio guardado es el que de verdad se pagó. Solo
 * empeoraría con un IMPORTE mal leído en dos cifras a la vez, y es el número más redundante del papel.
 *
 * Por debajo de `umbralImporteInconsistente`, que es exactamente donde hasta hoy el descuadre pasaba
 * en SILENCIO con el precio leído. Por encima, sigue siendo `monto_inconsistente` y lo decide una
 * persona. No bloquea —es la misma cuenta que el ERP ya hace con un precio que no se leyó (`dato_derivado`)—
 * pero queda escrito en la fila, con los dos precios.
 */
export function precioSegunImporte(l: LecturaVoucher, r: CoherenciaVoucher): AjustePrecio | null {
  if (r.estado !== "descuadra") return null;
  const cantidad = pos(l.cantidad);
  const precio = pos(l.precio);
  const monto = pos(l.monto);
  if (cantidad == null || precio == null || monto == null) return null;
  const producto = cantidad * precio;
  const dif = producto - monto;
  if (Math.abs(dif) > umbralImporteInconsistente(monto)) return null;
  const nuevo = redondear(monto / cantidad, 3);
  if (!(nuevo > 0) || nuevo === precio) return null;
  const unidad = (l.unidad ?? "gal").trim() || "gal";
  return {
    leido: precio,
    precio: nuevo,
    detalle:
      `Con el precio leído (${precioTexto(precio)}) el voucher no cuadra: ${conUnidad(cantidad, unidad)} × ${precioTexto(precio)} = ` +
      `${soles(redondear(producto, 2))} contra ${soles(monto)} impresos (${soles(Math.abs(redondear(dif, 2)))} de diferencia), ` +
      `y ningún dígito mal leído lo explica. El importe es el dato del comprobante —se imprime dos veces y es lo que se pagó—, ` +
      `así que manda: se guardó el precio que lo reproduce, ${precioTexto(nuevo)} (${soles(monto)} ÷ ${conUnidad(cantidad, unidad)}). ` +
      `Si fue un descuento del grifo, ese es el precio efectivo; si la mal leída fue la cantidad, el precio también lo está: compruébalo contra la foto.`,
  };
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
  if (!(desvio(c) <= CERCA_REFERENCIAL && desvio(p) > LEJOS_REFERENCIAL)) return null;

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

/**
 * Cómo se equivocó una lectura numérica, dicho SIN los números: es lo que viaja al prompt como
 * lección (lib/radar/lecciones-combustible.ts). Un «lo correcto era 24.720» en el prompt es un
 * precio que el modelo copia en el voucher siguiente — el mismo eco que dejó una carga a S/ 24.64
 * por el ejemplo de las instrucciones. «Un solo dígito distinto (6→8)» enseña el error y no deja
 * nada que copiar. `null` si no hay UN error de lectura que lo explique.
 */
export function errorDeLecturaSinCifras(leido: number, correcto: number): string | null {
  if (!(leido > 0) || !(correcto > 0)) return null;
  const e = diferenciaDeLectura(leido, correcto);
  if (!e) return null;
  if (e.tipo === "decimal") return "el punto decimal quedó corrido";
  if (e.tipo === "digito") {
    const m = /^(\d)→(\d)$/.exec(e.cambio);
    return m ? `un solo dígito distinto (leíste un ${m[1]} donde el papel decía ${m[2]})` : "un solo dígito distinto";
  }
  // "sobra la cifra "9"" / "falta la cifra "2"": una cifra suelta no es un número copiable.
  return e.tipo === "digito_de_mas" ? `una cifra de más (${e.cambio})` : `una cifra de menos (${e.cambio})`;
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
