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
 * sin decodificar nada. `opts` cambia los topes (el logo del perfil admite más).
 */
export function revisarJpeg(bytes: Uint8Array | null | undefined, opts: { maxBytes?: number; maxLado?: number } = {}): RevisionJpeg {
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
  if (!(b[fin - 2] === 0xff && b[fin - 1] === 0xd9)) return mal("truncado", "La foto está cortada (le falta el final del JPEG): vuelve a exportarla.");
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

export type RevisionPng = { ok: true; ancho: number; alto: number } | { ok: false; detalle: string };

/**
 * Las dimensiones de un PNG leídas de su IHDR, sin decodificarlo: es lo que frena una «bomba» (un
 * PNG de pocos KB que pdf-lib descomprimiría a cientos de MB). Topes no medidos: un logo real mide
 * cientos de px por lado.
 */
export function revisarPng(b: Uint8Array | null | undefined, opts: { maxLado?: number; maxPixeles?: number } = {}): RevisionPng {
  const maxLado = opts.maxLado ?? 4000;
  const maxPixeles = opts.maxPixeles ?? 4_000_000;
  const x = b ?? new Uint8Array(0);
  if (x.length < 33 || formatoPorFirma(x) !== "png") return { ok: false, detalle: "No es un PNG." };
  const tipo = String.fromCharCode(x[12], x[13], x[14], x[15]);
  if (tipo !== "IHDR") return { ok: false, detalle: "El PNG no empieza por su cabecera (IHDR)." };
  const u32 = (i: number) => ((x[i] << 24) >>> 0) + (x[i + 1] << 16) + (x[i + 2] << 8) + x[i + 3];
  const ancho = u32(16), alto = u32(20);
  if (!ancho || !alto) return { ok: false, detalle: "El PNG no declara sus dimensiones." };
  if (ancho > maxLado || alto > maxLado || ancho * alto > maxPixeles) return { ok: false, detalle: `El PNG mide ${ancho} × ${alto} px: es demasiado grande.` };
  return { ok: true, ancho, alto };
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
 * La ruta dentro del bucket `traslados-fotos` de una URL pública DEL PROPIO PROYECTO, o null si la URL
 * no es eso: otro host, otro bucket, http, usuario o contraseña en la URL, `..`, barras invertidas,
 * una consulta o un fragmento, o una ruta vacía.
 */
export function rutaDeUrlFoto(url: unknown, supabaseUrl: string | null | undefined): string | null {
  const host = hostDe(supabaseUrl);
  if (!host || typeof url !== "string" || !url.trim()) return null;
  const crudo = url.trim();
  if (crudo.includes("\\") || /%2e%2e|%2f|%5c/i.test(crudo)) return null;
  let u: URL;
  try { u = new URL(crudo); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.host !== host || u.search || u.hash) return null;
  if (!u.pathname.startsWith(RUTA_PUBLICA_FOTOS)) return null;
  let ruta: string;
  try { ruta = decodeURIComponent(u.pathname.slice(RUTA_PUBLICA_FOTOS.length)); } catch { return null; }
  if (!ruta || ruta.split("/").some((p) => p === "" || p === "." || p === "..")) return null;
  if (crudo.includes("/../") || crudo.includes("/./")) return null;
  return ruta;
}

/** ¿Es la URL pública de una foto del bucket `traslados-fotos` del propio proyecto? */
export function urlFotoPermitida(url: unknown, supabaseUrl: string | null | undefined): boolean {
  return rutaDeUrlFoto(url, supabaseUrl) != null;
}
