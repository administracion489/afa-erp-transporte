// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/fotos-categoria.ts — Las fotos de la CATEGORÍA de traslado (exterior e interior)
// que van en el PDF que la IA del CRM manda por WhatsApp. Motor PURO: valida bytes, rutas y URLs.
//
// LAS FOTOS VIVEN EN SU PROPIO BUCKET, `traslados-fotos` (supabase/traslados-07-fotos-categoria.sql):
// público para LEER (pdf-lib y la pantalla bajan la foto por su URL pública) y SIN NINGUNA política
// de escritura: solo sube el servidor (`/api/traslados/categorias/foto`, módulo «tarifas»). No se
// sirven desde `vehiculos-fotos`, que cualquier sesión del ERP puede sobrescribir: lo que la IA manda
// sin revisión no puede salir de un sitio que cualquiera cambia.
//
// NADA SE DECODIFICA EN EL SERVIDOR. El navegador achica la foto (canvas → JPEG ≤ 1280 px) y el
// servidor solo mira la FIRMA (FF D8 FF), el marcador SOF (dimensiones, componentes, precisión) y
// el final (FF D9). pdf-lib incrusta el JPEG tal cual (DCTDecode) sin decodificarlo: por eso el
// recorrido de segmentos es el MISMO que hace pdf-lib para encontrar el SOF (sin bytes de relleno
// ni marcadores sueltos antes del SOF), y lo que pdf-lib no sabría leer igual se rechaza aquí.
//
// CADA FOTO TIENE NOMBRE NUEVO (uuid): una subida nunca sobrescribe otra, y la URL vieja que ya viajó
// en un PDF enviado sigue apuntando a la foto que se mandó (hasta que se borra al reemplazarla).
// ──────────────────────────────────────────────────────────────────────────────

export const BUCKET_FOTOS_TRASLADO = "traslados-fotos";
/** El tramo de la URL pública de una foto de este bucket (lo comprueba también el CHECK de la columna). */
export const RUTA_PUBLICA_FOTOS = `/storage/v1/object/public/${BUCKET_FOTOS_TRASLADO}/`;

/** Tope de bytes: el mismo `file_size_limit` del bucket (614 400). */
export const FOTO_MAX_BYTES = 600 * 1024;
/** Tope de cada lado (px). El navegador la achica a 1280; el margen es para no rechazar un redondeo. */
export const FOTO_MAX_LADO = 1600;

export type LadoFoto = "externa" | "interna";
export const LADOS_FOTO: readonly LadoFoto[] = ["externa", "interna"];

/** La columna de `traslado_categorias` de cada lado. */
export const COLUMNA_FOTO: Record<LadoFoto, "foto_externa_url" | "foto_interna_url"> = {
  externa: "foto_externa_url",
  interna: "foto_interna_url",
};

export type CodigoJpeg =
  | "ok" | "vacio" | "no_es_jpeg" | "muy_pesado" | "truncado" | "estructura" | "no_soportado"
  | "sin_dimensiones" | "muy_grande" | "canales" | "precision";

export type RevisionJpeg =
  | { ok: true; codigo: "ok"; ancho: number; alto: number; progresivo: boolean; detalle: "" }
  | { ok: false; codigo: Exclude<CodigoJpeg, "ok">; detalle: string };

/** El formato por su firma, para decir QUÉ se subió cuando no es un JPEG. */
export function formatoPorFirma(b: Uint8Array): "jpeg" | "png" | "webp" | "gif" | "heic" | "pdf" | null {
  const a = (i: number) => b[i] ?? -1;
  const txt = (i: number, n: number) => String.fromCharCode(...Array.from(b.subarray(i, i + n)));
  if (a(0) === 0xff && a(1) === 0xd8 && a(2) === 0xff) return "jpeg";
  if (a(0) === 0x89 && txt(1, 3) === "PNG") return "png";
  if (txt(0, 4) === "RIFF" && txt(8, 4) === "WEBP") return "webp";
  if (txt(0, 4) === "GIF8") return "gif";
  if (txt(4, 4) === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1|avif)$/.test(txt(8, 4))) return "heic";
  if (txt(0, 5) === "%PDF-") return "pdf";
  return null;
}

const NOMBRE_FORMATO: Record<string, string> = {
  png: "una imagen PNG", webp: "una imagen WebP", gif: "una imagen GIF",
  heic: "una foto HEIC (la del iPhone)", pdf: "un PDF",
};

/** Los SOF que se aceptan: baseline, secuencial extendido y progresivo (los que leen todos los visores de PDF). */
const SOF_ACEPTADOS = new Set([0xc0, 0xc1, 0xc2]);
/** Los que pdf-lib toma por SOF y no se aceptan (sin pérdida, jerárquicos, aritméticos, y C8/CC que pdf-lib confunde). */
const SOF_RECHAZADOS = new Set([0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf]);

/**
 * ¿Estos bytes son un JPEG que el PDF puede incrustar tal cual? Recorre los segmentos hasta el SOF
 * sin decodificar nada. `opts` cambia los topes (el logo del perfil admite más). `exigirFin: false`
 * (el expediente de licitaciones) no exige que los últimos bytes sean FF D9: la cámara de varios
 * teléfonos agrega datos DESPUÉS del final del JPEG (la «foto en movimiento»), y esa foto se ve bien.
 * Por defecto se exige, como siempre (las fotos de traslado las re-codifica el navegador).
 */
export function revisarJpeg(bytes: Uint8Array | null | undefined, opts: { maxBytes?: number; maxLado?: number; exigirFin?: boolean } = {}): RevisionJpeg {
  const maxBytes = opts.maxBytes ?? FOTO_MAX_BYTES;
  const maxLado = opts.maxLado ?? FOTO_MAX_LADO;
  const b = bytes ?? new Uint8Array(0);
  const mal = (codigo: Exclude<CodigoJpeg, "ok">, detalle: string): RevisionJpeg => ({ ok: false, codigo, detalle });
  if (!b.length) return mal("vacio", "El archivo está vacío.");
  if (b.length > maxBytes) return mal("muy_pesado", `La foto pesa ${Math.ceil(b.length / 1024)} KB y el máximo es ${Math.floor(maxBytes / 1024)} KB: achícala antes de subirla.`);
  const fmt = formatoPorFirma(b);
  if (fmt !== "jpeg") {
    return mal("no_es_jpeg", fmt && NOMBRE_FORMATO[fmt]
      ? `Es ${NOMBRE_FORMATO[fmt]}, no un JPEG: la pantalla la convierte a JPEG antes de subirla.`
      : "No es una imagen JPEG.");
  }
  // El final: FF D9 (se toleran ceros de relleno detrás). Sin él la foto está cortada.
  let fin = b.length;
  while (fin > 2 && b[fin - 1] === 0x00) fin--;
  if (opts.exigirFin !== false && !(b[fin - 2] === 0xff && b[fin - 1] === 0xd9)) return mal("truncado", "La foto está cortada (le falta el final del JPEG): vuelve a exportarla.");
  // Los segmentos hasta el SOF, como los recorre pdf-lib: marcador de 2 bytes + longitud de 2 bytes.
  let pos = 2;
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) return mal("estructura", "La estructura del JPEG no es la esperada: vuelve a exportarla.");
    const marcador = b[pos + 1];
    // Relleno (FF FF) o marcadores sin longitud (RST, TEM) antes del SOF: pdf-lib se perdería.
    if (marcador === 0xff || marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd7)) {
      return mal("estructura", "La estructura del JPEG no es la esperada: vuelve a exportarla.");
    }
    if (marcador === 0xd9 || marcador === 0xda) return mal("sin_dimensiones", "El JPEG no declara sus dimensiones antes de los datos.");
    const largo = (b[pos + 2] << 8) | b[pos + 3];
    if (largo < 2 || pos + 2 + largo > b.length) return mal("truncado", "La foto está cortada: vuelve a exportarla.");
    if (SOF_RECHAZADOS.has(marcador)) return mal("no_soportado", "Es un JPEG de un tipo poco común (sin pérdida o aritmético) que los visores de PDF no muestran: vuelve a exportarla.");
    if (SOF_ACEPTADOS.has(marcador)) {
      if (largo < 8) return mal("truncado", "La foto está cortada: vuelve a exportarla.");
      const precision = b[pos + 4];
      const alto = (b[pos + 5] << 8) | b[pos + 6];
      const ancho = (b[pos + 7] << 8) | b[pos + 8];
      const comps = b[pos + 9];
      if (precision !== 8) return mal("precision", "El JPEG no es de 8 bits: vuelve a exportarlo.");
      if (!ancho || !alto) return mal("sin_dimensiones", "El JPEG no declara sus dimensiones.");
      if (ancho > maxLado || alto > maxLado) return mal("muy_grande", `La foto mide ${ancho} × ${alto} px y el máximo es ${maxLado} px por lado: achícala antes de subirla.`);
      // 1 = gris, 3 = color (YCbCr). 4 = CMYK: el PDF la pintaría con los colores invertidos.
      if (comps !== 1 && comps !== 3) return mal("canales", comps === 4 ? "Es un JPEG en CMYK (de imprenta): conviértelo a RGB." : "El JPEG tiene un número de canales que no se puede mostrar.");
      return { ok: true, codigo: "ok", ancho, alto, progresivo: marcador === 0xc2, detalle: "" };
    }
    pos += 2 + largo;
  }
  return mal("sin_dimensiones", "El JPEG no declara sus dimensiones.");
}

export type LimpiezaJpeg =
  | { ok: true; bytes: Uint8Array; quitados: number; bytesQuitados: number }
  | { ok: false; codigo: "estructura" | "truncado"; detalle: string };

/**
 * El JPEG sin sus metadatos: quita los segmentos APP1…APP15 (EXIF con el GPS de quien tomó la foto,
 * XMP, ICC, miniaturas) y los comentarios (COM), salvo APP0 «JFIF» y APP14 «Adobe», que describen
 * cómo leer la imagen. Recorre los segmentos hasta el comienzo de los datos (SOS) —el mismo
 * recorrido de `revisarJpeg`— y copia el resto tal cual: la imagen no se decodifica ni se recomprime.
 * La pantalla ya sube un JPEG del canvas (sin EXIF); esto cubre un POST directo al endpoint.
 */
export function limpiarJpeg(b: Uint8Array): LimpiezaJpeg {
  const mal = (codigo: "estructura" | "truncado", detalle: string): LimpiezaJpeg => ({ ok: false, codigo, detalle });
  if (!(b.length > 4 && b[0] === 0xff && b[1] === 0xd8)) return mal("estructura", "No es un JPEG.");
  const partes: Uint8Array[] = [b.subarray(0, 2)];
  let quitados = 0;
  let pos = 2;
  const empieza = (ini: number, txt: string) => [...txt].every((c, i) => b[ini + i] === c.charCodeAt(0));
  while (pos < b.length) {
    if (b[pos] !== 0xff) return mal("estructura", "La estructura del JPEG no es la esperada: vuelve a exportarla.");
    let m = pos + 1;
    while (m < b.length && b[m] === 0xff) m++; // bytes de relleno: se descartan
    if (m >= b.length) return mal("truncado", "La foto está cortada: vuelve a exportarla.");
    const marcador = b[m];
    if (marcador === 0xda) {
      partes.push(b.subarray(m - 1));
      const out = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
      let o = 0;
      for (const p of partes) { out.set(p, o); o += p.length; }
      return { ok: true, bytes: out, quitados, bytesQuitados: b.length - out.length };
    }
    if (marcador === 0xd8 || marcador === 0xd9 || marcador === 0x01 || marcador === 0x00 || (marcador >= 0xd0 && marcador <= 0xd7)) {
      return mal("estructura", "La estructura del JPEG no es la esperada: vuelve a exportarla.");
    }
    if (m + 3 > b.length) return mal("truncado", "La foto está cortada: vuelve a exportarla.");
    const largo = (b[m + 1] << 8) | b[m + 2];
    const fin = m + 1 + largo;
    if (largo < 2 || fin > b.length) return mal("truncado", "La foto está cortada: vuelve a exportarla.");
    const app = marcador >= 0xe0 && marcador <= 0xef;
    const conservar = !(app || marcador === 0xfe)
      || (marcador === 0xe0 && empieza(m + 3, "JFIF\0"))
      || (marcador === 0xee && empieza(m + 3, "Adobe"));
    if (conservar) partes.push(b.subarray(m - 1, fin));
    else quitados++;
    pos = fin;
  }
  return mal("estructura", "El JPEG no trae los datos de la imagen.");
}

// ── El PNG del logo ──────────────────────────────────────────────────────────
//
// pdf-lib (UPNG) DESCOMPRIME el PNG entero para incrustarlo, y no pone ningún tope: el IHDR no
// basta. Una animación (APNG) declara en su `fcTL` las medidas de cada fotograma y UPNG reserva
// memoria para esas, no para las de la cabecera (un PNG de 162 B con un fotograma de 16000 × 16000
// tardó 24 s y ~1.1 GB); y el IDAT se infla entero aunque traiga mucho más de lo que la imagen ocupa.
// Por eso `revisarPng` recorre TODOS los chunks (que cada uno quepa en el archivo, sin animación, IDAT
// seguidos) y comprueba el tamaño del IDAT contra el que la cabecera permite; y si se le pasa
// `inflar` (el servidor: `zlib.inflateSync` con `maxOutputLength`), lo infla con TOPE y exige
// exactamente los bytes que la cabecera declara. Sin `inflar` no se descomprime nada (es puro y la
// pantalla también lo puede usar), y entonces el tope es el del tamaño del IDAT.

export type CodigoPng =
  | "ok" | "vacio" | "no_es_png" | "muy_pesado" | "truncado" | "estructura" | "animado" | "formato"
  | "sin_dimensiones" | "muy_grande" | "sin_datos" | "idat_desproporcionado" | "idat_invalido";

export type RevisionPng =
  | { ok: true; codigo: "ok"; ancho: number; alto: number; entrelazado: boolean; detalle: "" }
  | { ok: false; codigo: Exclude<CodigoPng, "ok">; detalle: string };

/** Canales por tipo de color (IHDR) y profundidades de bit válidas para cada uno (PNG 1.2, tabla 11.1). */
const CANALES_PNG: Record<number, { canales: number; bits: readonly number[] }> = {
  0: { canales: 1, bits: [1, 2, 4, 8, 16] },
  2: { canales: 3, bits: [8, 16] },
  3: { canales: 1, bits: [1, 2, 4, 8] },
  4: { canales: 2, bits: [8, 16] },
  6: { canales: 4, bits: [8, 16] },
};
/** Las siete pasadas de Adam7: (x0, y0, dx, dy). */
const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];
/** Los chunks de una animación (APNG): UPNG los decodifica con las medidas que ellos declaran. */
const CHUNKS_ANIMACION = new Set(["acTL", "fcTL", "fdAT"]);

/**
 * Cuántos bytes ocupa la imagen YA INFLADA (con el byte de filtro de cada línea): lo que debe dar
 * exactamente el IDAT. Con entrelazado (Adam7) es la suma de las siete subimágenes.
 */
export function bytesCrudosPng(ancho: number, alto: number, tipoColor: number, profundidad: number, entrelazado: boolean): number {
  const bitsPx = (CANALES_PNG[tipoColor]?.canales ?? 4) * profundidad;
  const linea = (w: number) => Math.ceil((w * bitsPx) / 8) + 1;
  if (!entrelazado) return linea(ancho) * alto;
  let total = 0;
  for (const [x0, y0, dx, dy] of ADAM7) {
    const w = ancho > x0 ? Math.ceil((ancho - x0) / dx) : 0;
    const h = alto > y0 ? Math.ceil((alto - y0) / dy) : 0;
    if (w && h) total += linea(w) * h;
  }
  return total;
}

/**
 * El mayor IDAT (comprimido) que un PNG honesto puede necesitar para `crudos` bytes: deflate sin
 * comprimir («stored») añade 5 bytes cada 65 535 más los 6 de zlib; se deja un margen amplio para
 * codificadores que expanden un poco los datos que no se comprimen (no medido).
 */
export const idatMaximo = (crudos: number) => crudos + Math.ceil(crudos / 8) + 1024;

/**
 * ¿Es un PNG que pdf-lib puede incrustar sin riesgo? Recorre todos sus chunks sin decodificar nada;
 * con `inflar` (servidor), además infla el IDAT con tope. Topes no medidos: un logo real mide
 * cientos de px por lado y pesa decenas de KB.
 */
export function revisarPng(
  b: Uint8Array | null | undefined,
  opts: { maxLado?: number; maxPixeles?: number; maxBytes?: number; inflar?: (zlib: Uint8Array, maxSalida: number) => number } = {},
): RevisionPng {
  const maxLado = opts.maxLado ?? 4000;
  const maxPixeles = opts.maxPixeles ?? 4_000_000;
  const maxBytes = opts.maxBytes ?? Infinity;
  const x = b ?? new Uint8Array(0);
  const mal = (codigo: Exclude<CodigoPng, "ok">, detalle: string): RevisionPng => ({ ok: false, codigo, detalle });
  if (!x.length) return mal("vacio", "El archivo está vacío.");
  if (x.length > maxBytes) return mal("muy_pesado", `El PNG pesa ${Math.ceil(x.length / 1024)} KB y el máximo es ${Math.floor(maxBytes / 1024)} KB.`);
  if (formatoPorFirma(x) !== "png" || x[4] !== 0x0d || x[5] !== 0x0a || x[6] !== 0x1a || x[7] !== 0x0a) return mal("no_es_png", "No es un PNG.");
  const u32 = (i: number) => ((x[i] << 24) >>> 0) + (x[i + 1] << 16) + (x[i + 2] << 8) + x[i + 3];
  const letra = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

  let pos = 8;
  let ihdr: { ancho: number; alto: number; prof: number; color: number; entrelazado: boolean } | null = null;
  let hayPlte = false, fin = false, idatCerrado = false;
  const idats: [number, number][] = [];
  let idatTotal = 0;
  while (pos < x.length) {
    if (pos + 12 > x.length) return mal("truncado", "El PNG está cortado.");
    const largo = u32(pos);
    if (largo > 0x7fffffff || pos + 12 + largo > x.length) return mal("truncado", "El PNG está cortado (un bloque dice medir más que el archivo).");
    if (![4, 5, 6, 7].every((i) => letra(x[pos + i]))) return mal("estructura", "La estructura del PNG no es la esperada.");
    const tipo = String.fromCharCode(x[pos + 4], x[pos + 5], x[pos + 6], x[pos + 7]);
    const datos = pos + 8;
    if (!ihdr && tipo !== "IHDR") return mal("estructura", "El PNG no empieza por su cabecera (IHDR).");
    if (CHUNKS_ANIMACION.has(tipo)) return mal("animado", "Es un PNG animado (APNG): usa uno sin animación.");
    if (tipo === "IHDR") {
      if (ihdr || largo !== 13) return mal("estructura", "La cabecera del PNG no es la esperada.");
      const prof = x[datos + 8], color = x[datos + 9], compresion = x[datos + 10], filtro = x[datos + 11], entre = x[datos + 12];
      const ancho = u32(datos), alto = u32(datos + 4);
      if (!ancho || !alto) return mal("sin_dimensiones", "El PNG no declara sus dimensiones.");
      if (ancho > maxLado || alto > maxLado || ancho * alto > maxPixeles) return mal("muy_grande", `El PNG mide ${ancho} × ${alto} px: es demasiado grande.`);
      if (!CANALES_PNG[color]?.bits.includes(prof) || compresion !== 0 || filtro !== 0 || (entre !== 0 && entre !== 1)) {
        return mal("formato", "El PNG usa un formato que no corresponde (tipo de color, bits o compresión).");
      }
      ihdr = { ancho, alto, prof, color, entrelazado: entre === 1 };
    } else if (tipo === "PLTE") {
      if (largo === 0 || largo % 3 !== 0 || largo > 768 || idats.length) return mal("estructura", "La paleta del PNG no es la esperada.");
      hayPlte = true;
    } else if (tipo === "IDAT") {
      // Los IDAT van seguidos: uno después de otro chunk que ya cerró la serie es un archivo armado a mano.
      if (idatCerrado) return mal("estructura", "Los datos del PNG no van seguidos.");
      idats.push([datos, largo]);
      idatTotal += largo;
    } else if (tipo === "IEND") {
      if (largo !== 0) return mal("estructura", "El final del PNG no es el esperado.");
      fin = true;
      break;
    }
    if (tipo !== "IDAT" && idats.length) idatCerrado = true;
    pos += 12 + largo;
  }
  if (!ihdr) return mal("estructura", "El PNG no tiene cabecera.");
  if (!fin) return mal("truncado", "El PNG está cortado (le falta su final).");
  if (!idats.length || !idatTotal) return mal("sin_datos", "El PNG no trae la imagen.");
  if (ihdr.color === 3 && !hayPlte) return mal("estructura", "El PNG de paleta no trae su paleta.");
  const crudos = bytesCrudosPng(ihdr.ancho, ihdr.alto, ihdr.color, ihdr.prof, ihdr.entrelazado);
  if (idatTotal > idatMaximo(crudos)) {
    return mal("idat_desproporcionado", "El PNG trae muchos más datos de los que su imagen puede ocupar.");
  }
  if (opts.inflar) {
    const zlib = new Uint8Array(idatTotal);
    let o = 0;
    for (const [ini, n] of idats) { zlib.set(x.subarray(ini, ini + n), o); o += n; }
    let salida: number;
    try { salida = opts.inflar(zlib, crudos); } catch { return mal("idat_invalido", "Los datos del PNG no se pueden leer o miden más de lo que declara su cabecera."); }
    if (salida !== crudos) return mal("idat_invalido", "Los datos del PNG no miden lo que declara su cabecera.");
  }
  return { ok: true, codigo: "ok", ancho: ihdr.ancho, alto: ihdr.alto, entrelazado: ihdr.entrelazado, detalle: "" };
}

const RE_CLAVE = /^[A-Z0-9_]{1,30}$/;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** La clave de la categoría tal como la guarda la pantalla (MAYÚSCULAS, sin espacios, ≤ 30). */
export function claveValida(clave: unknown): clave is string {
  return typeof clave === "string" && RE_CLAVE.test(clave);
}

/**
 * La ruta de una foto NUEVA dentro del bucket: `categorias/<CLAVE>/<lado>-<uuid>.jpg`. Valida cada
 * pieza (no se arma una ruta con lo que no lo es) y LANZA si alguna no sirve.
 */
export function rutaFoto(clave: string, lado: LadoFoto, uuid: string): string {
  if (!claveValida(clave)) throw new Error("Clave de categoría inválida.");
  if (!LADOS_FOTO.includes(lado)) throw new Error("Lado inválido (externa o interna).");
  if (!RE_UUID.test(uuid)) throw new Error("Identificador inválido.");
  return `categorias/${clave}/${lado}-${uuid.toLowerCase()}.jpg`;
}

/** El host de un `NEXT_PUBLIC_SUPABASE_URL` https, o null. */
export function hostDe(base: string | null | undefined): string | null {
  try {
    const u = new URL(String(base ?? ""));
    return u.protocol === "https:" ? u.host : null;
  } catch {
    return null;
  }
}

/**
 * La forma EXACTA de la ruta de una foto (la que produce `rutaFoto`): categoría, lado, uuid en
 * minúsculas y `.jpg`. La comparte la migración traslados-07 (CHECK de las columnas), escrita como
 * `^https://[^/]+/storage/v1/object/public/traslados-fotos/categorias/<clave>/<lado>-<uuid>\.jpg$`
 * con la clave y el lado de la propia columna.
 */
export const RE_RUTA_FOTO = /^categorias\/([A-Z0-9_]{1,30})\/(externa|interna)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

/**
 * La ruta dentro del bucket `traslados-fotos` de una URL pública DEL PROPIO PROYECTO, o null si la URL
 * no es EXACTAMENTE `https://<host del proyecto>/storage/v1/object/public/traslados-fotos/` + una ruta
 * con la forma de `rutaFoto` (`RE_RUTA_FOTO`): otro host, otro bucket, http, usuario, puerto o
 * mayúsculas que la normalización cambiaría, codificaciones `%xx`, consulta, fragmento, `..`, o una
 * ruta con otra forma. Con `esperado`, además, la ruta tiene que ser de ESA categoría y ESE lado:
 * la columna se puede escribir por PostgREST con el módulo Tarifas, y sin esto «Quitar» o
 * «Reemplazar» en una categoría borraría la foto de OTRA.
 */
export function rutaDeUrlFoto(url: unknown, supabaseUrl: string | null | undefined, esperado?: { clave: string; lado: LadoFoto }): string | null {
  const host = hostDe(supabaseUrl);
  if (!host || typeof url !== "string") return null;
  const crudo = url.trim();
  const prefijo = `https://${host}${RUTA_PUBLICA_FOTOS}`;
  if (!crudo.startsWith(prefijo)) return null;
  const ruta = crudo.slice(prefijo.length);
  const m = RE_RUTA_FOTO.exec(ruta);
  if (!m) return null;
  // La URL tiene que ser ya su forma normalizada (nada que el parser reescriba por el camino).
  try { if (new URL(crudo).href !== crudo) return null; } catch { return null; }
  if (esperado && (m[1] !== esperado.clave || m[2] !== esperado.lado)) return null;
  return ruta;
}

/** ¿Es la URL pública de una foto del bucket `traslados-fotos` del propio proyecto (de esa categoría y lado, si se dicen)? */
export function urlFotoPermitida(url: unknown, supabaseUrl: string | null | undefined, esperado?: { clave: string; lado: LadoFoto }): boolean {
  return rutaDeUrlFoto(url, supabaseUrl, esperado) != null;
}
