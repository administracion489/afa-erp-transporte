// ──────────────────────────────────────────────────────────────────────────────
// lib/zip-sin-compresion.ts — Empaca archivos en un ZIP SIN COMPRESIÓN (método 0, «stored»). PURO e
// isomórfico: navegador, servidor y matrices. No lee nada ni toca el reloj.
//
// POR QUÉ SIN COMPRIMIR: lo que se empaca son PDF y JPEG, que ya van comprimidos por dentro; deflate
// los dejaría casi igual y costaría segundos de CPU en el navegador con un expediente de 200 MB. Y
// «stored» deja devolver las PARTES sin copiarlas: los bytes de cada archivo se entregan tal cual, y
// el navegador arma el Blob con `new Blob(partes)` sin duplicar la memoria.
//
// Lo que hace, y lo que NO:
//  · Nombres en UTF-8 con la bandera de la especificación (bit 11): «Sección II – Requisitos.pdf»
//    sale con sus tildes en Windows, macOS y Linux. El nombre se normaliza a NFC (un nombre que viene
//    de macOS en NFD no sale con las tildes sueltas).
//  · Fecha y hora DOS en hora de LIMA (UTC-5 fijo, Perú no tiene horario de verano): el extractor la
//    lee como hora local, y quien abre el ZIP está en Perú. Sin `fecha`, 1980-01-01 00:00 (la época
//    DOS): un motor puro no lee el reloj — quien llama pasa la hora de la emisión.
//  · SIN ZIP64: 65 534 entradas y 4 GiB como mucho (LIMITES_ZIP). Pasarse LANZA un `ErrorZip` con su
//    código: un ZIP32 «estirado» se abre roto o truncado en silencio, que es peor que no tenerlo.
//  · Un nombre vacío, con `..`, que empieza por `/` o `\`, con letra de unidad («C:») o con
//    caracteres de control LANZA (es la puerta del «zip slip»: un extractor descuidado escribiría
//    fuera de la carpeta). Dos nombres iguales también lanzan — comparados sin distinguir mayúsculas,
//    porque en Windows y macOS «Anexo.pdf» y «anexo.pdf» son el mismo archivo y uno pisaría al otro.
// Matriz: scripts/prueba-licitaciones-expediente.mts (lo lee de vuelta con XLSX.CFB y coteja el CRC
// contra zlib.crc32 de node).
// ──────────────────────────────────────────────────────────────────────────────

/** Topes de un ZIP sin ZIP64. 0xFFFF y 0xFFFFFFFF son los centinelas de ZIP64, por eso uno menos. */
export const LIMITES_ZIP = {
  maxEntradas: 65_534,
  maxBytes: 0xFFFF_FFFE,            // 4 GiB − 2: ningún desplazamiento ni tamaño puede llegar al centinela
  maxBytesNombre: 0xFFFF,
} as const;

export type CodigoErrorZip = "zip_nombre_invalido" | "zip_nombre_repetido" | "zip_demasiadas_entradas" | "zip_demasiado_grande";

export class ErrorZip extends Error {
  readonly codigo: CodigoErrorZip;
  constructor(codigo: CodigoErrorZip, mensaje: string) {
    super(mensaje);
    this.codigo = codigo;
    this.name = "ErrorZip";
    // Con target ES5/ES2017 + transpiladores, `instanceof` de una subclase de Error puede fallar: el
    // código viaja en la propiedad, que es lo que se debe mirar.
    Object.setPrototypeOf(this, ErrorZip.prototype);
  }
}

export type EntradaZip = { nombre: string; bytes: Uint8Array; fecha?: Date };

// ── CRC-32 (IEEE 802.3, el de ZIP y PNG), por tabla ────────────────────────────

const TABLA_CRC: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 de `b` (sin signo). «123456789» → 0xCBF43926. `previo` encadena varios trozos. */
export function crc32(b: Uint8Array, previo = 0): number {
  let c = (previo ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < b.length; i++) c = TABLA_CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ── Nombres ───────────────────────────────────────────────────────────────────

/** El problema del nombre, o null si sirve. Lo usa `armarZip`; se exporta para que la pantalla avise antes. */
export function problemaNombreZip(nombre: string): string | null {
  const n = String(nombre ?? "").normalize("NFC");
  if (!n.trim()) return "El nombre está vacío.";
  if (n.includes("..")) return `«${n}» trae «..».`;
  if (n.startsWith("/") || n.startsWith("\\")) return `«${n}» empieza por una barra.`;
  if (/^[A-Za-z]:/.test(n)) return `«${n}» empieza por una letra de unidad.`;
  if (n.endsWith("/") || n.endsWith("\\")) return `«${n}» termina en barra (sería una carpeta).`;
  if (/[\u0000-\u001f\u007f]/.test(n)) return `«${n}» trae caracteres de control.`;
  if (new TextEncoder().encode(n).length > LIMITES_ZIP.maxBytesNombre) return "El nombre es demasiado largo.";
  return null;
}

// ── Fecha DOS en hora de Lima ─────────────────────────────────────────────────

const LIMA_MS = -5 * 3600_000;

/** {fecha, hora} DOS de `d` en hora de Lima. Fuera de 1980–2107 se acota (DOS no tiene otra cosa). */
export function fechaDos(d?: Date): { fecha: number; hora: number } {
  const t = d && Number.isFinite(d.getTime()) ? new Date(d.getTime() + LIMA_MS) : null;
  if (!t) return { fecha: (0 << 9) | (1 << 5) | 1, hora: 0 };
  let anio = t.getUTCFullYear();
  if (anio < 1980) return { fecha: (0 << 9) | (1 << 5) | 1, hora: 0 };
  if (anio > 2107) anio = 2107;
  const fecha = ((anio - 1980) << 9) | ((t.getUTCMonth() + 1) << 5) | t.getUTCDate();
  const hora = (t.getUTCHours() << 11) | (t.getUTCMinutes() << 5) | Math.floor(t.getUTCSeconds() / 2);
  return { fecha, hora };
}

// ── Armado ────────────────────────────────────────────────────────────────────

const FIRMA_LOCAL = 0x04034b50, FIRMA_CENTRAL = 0x02014b50, FIRMA_FIN = 0x06054b50;
const BANDERA_UTF8 = 0x0800;
const VERSION_NECESARIA = 20;                       // 2.0
const VERSION_HECHA = (3 << 8) | 20;                // Unix · 2.0 (los permisos de abajo valen en Linux/macOS)
const ATRIB_EXTERNOS = (0o100644 << 16) >>> 0;      // archivo regular rw-r--r--

/**
 * El ZIP en PARTES (encabezado local, datos tal cual, …, directorio central, fin) y su tamaño total.
 * En el navegador: `new Blob(partes, { type: "application/zip" })`. Los datos de cada entrada son el
 * MISMO Uint8Array que se pasó (no se copia): no lo modifiques hasta armar el Blob.
 * LANZA `ErrorZip` (con `.codigo`) ante un nombre inválido o repetido, o si pasa LIMITES_ZIP.
 */
export function armarZip(entradas: EntradaZip[]): { partes: Uint8Array[]; bytes: number } {
  if (entradas.length > LIMITES_ZIP.maxEntradas) {
    throw new ErrorZip("zip_demasiadas_entradas", `El ZIP llevaría ${entradas.length} archivos; sin ZIP64 el tope es ${LIMITES_ZIP.maxEntradas}.`);
  }
  const enc = new TextEncoder();
  const vistos = new Set<string>();
  const partes: Uint8Array[] = [];
  const centrales: Uint8Array[] = [];
  let offset = 0;

  for (const e of entradas) {
    const nombre = String(e.nombre ?? "").normalize("NFC");
    const problema = problemaNombreZip(nombre);
    if (problema) throw new ErrorZip("zip_nombre_invalido", problema);
    const clave = nombre.toLocaleLowerCase("es-PE");
    if (vistos.has(clave)) throw new ErrorZip("zip_nombre_repetido", `«${nombre}» está dos veces en el ZIP.`);
    vistos.add(clave);

    const datos = e.bytes ?? new Uint8Array(0);
    const nb = enc.encode(nombre);
    const crc = crc32(datos);
    const { fecha, hora } = fechaDos(e.fecha);
    const tamLocal = 30 + nb.length;
    if (offset + tamLocal + datos.length > LIMITES_ZIP.maxBytes) {
      throw new ErrorZip("zip_demasiado_grande", `El ZIP pasaría de 4 GiB (sin ZIP64) al agregar «${nombre}».`);
    }

    const local = new Uint8Array(tamLocal);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, FIRMA_LOCAL, true);
    lv.setUint16(4, VERSION_NECESARIA, true);
    lv.setUint16(6, BANDERA_UTF8, true);
    lv.setUint16(8, 0, true);                       // método 0 = stored
    lv.setUint16(10, hora, true);
    lv.setUint16(12, fecha, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, datos.length, true);           // comprimido = sin comprimir
    lv.setUint32(22, datos.length, true);
    lv.setUint16(26, nb.length, true);
    lv.setUint16(28, 0, true);                      // sin campo extra
    local.set(nb, 30);

    const central = new Uint8Array(46 + nb.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, FIRMA_CENTRAL, true);
    cv.setUint16(4, VERSION_HECHA, true);
    cv.setUint16(6, VERSION_NECESARIA, true);
    cv.setUint16(8, BANDERA_UTF8, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, hora, true);
    cv.setUint16(14, fecha, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, datos.length, true);
    cv.setUint32(24, datos.length, true);
    cv.setUint16(28, nb.length, true);
    cv.setUint16(30, 0, true);                      // extra
    cv.setUint16(32, 0, true);                      // comentario
    cv.setUint16(34, 0, true);                      // disco
    cv.setUint16(36, 0, true);                      // atributos internos
    cv.setUint32(38, ATRIB_EXTERNOS, true);
    cv.setUint32(42, offset, true);
    central.set(nb, 46);

    partes.push(local, datos);
    centrales.push(central);
    offset += tamLocal + datos.length;
  }

  const inicioCentral = offset;
  let tamCentral = 0;
  for (const c of centrales) { partes.push(c); tamCentral += c.length; }
  if (inicioCentral + tamCentral + 22 > LIMITES_ZIP.maxBytes) {
    throw new ErrorZip("zip_demasiado_grande", "El ZIP pasaría de 4 GiB (sin ZIP64).");
  }

  const fin = new Uint8Array(22);
  const fv = new DataView(fin.buffer);
  fv.setUint32(0, FIRMA_FIN, true);
  fv.setUint16(4, 0, true);
  fv.setUint16(6, 0, true);
  fv.setUint16(8, centrales.length, true);
  fv.setUint16(10, centrales.length, true);
  fv.setUint32(12, tamCentral, true);
  fv.setUint32(16, inicioCentral, true);
  fv.setUint16(20, 0, true);
  partes.push(fin);

  return { partes, bytes: inicioCentral + tamCentral + 22 };
}
