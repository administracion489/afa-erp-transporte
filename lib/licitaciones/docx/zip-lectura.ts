// ──────────────────────────────────────────────────────────────────────────────
// lib/licitaciones/docx/zip-lectura.ts — Abre el ZIP de un .docx. PURO e isomórfico.
//
// El inflado lo hace XLSX.CFB (SheetJS trae su propio inflate y sirve igual en el navegador y en
// Node: lo usa ya lib/combustible/facturas-correo.ts). Lo que este archivo agrega son los TOPES, y
// hay que ponerlos ANTES de llamar a CFB, porque CFB descomprime todas las entradas de una vez:
//
//  · entrada ≤ 25 MB y ≤ 2 000 entradas;
//  · la suma de tamaños descomprimidos DECLARADOS en el directorio central ≤ TOPE (bomba zip);
//  · y CFB reserva para cada entrada exactamente el tamaño que dice su cabecera LOCAL, o crece sin
//    límite si esa cabecera dice 0 (archivos con «descriptor de datos»). Por eso se copia el archivo
//    y se escriben en cada cabecera local los tamaños del directorio central ya comprobados: así la
//    memoria queda acotada por el tope aunque una entrada mienta sobre lo que infla (lo que sobra se
//    descarta y el XML sale cortado → ilegible).
//    Límite declarado: el TIEMPO de inflar una entrada que miente no se acota (se recorre el flujo
//    comprimido entero); como el archivo lo elige quien lo importa y se lee en su navegador, el
//    daño es esa pestaña.
//
// Un archivo OLE (Word 97-2003 .doc, o un .docx protegido con contraseña, que Word guarda dentro
// de un contenedor OLE cifrado) no es un zip: se nombra con su propio código.
// ──────────────────────────────────────────────────────────────────────────────
import * as XLSX from "xlsx";

/** Topes NO medidos, declarados. El lado seguro es bajarlos. */
export const TOPES_ZIP = {
  maxBytesEntrada: 25 * 1024 * 1024,
  maxEntradas: 2_000,
  maxBytesDescomprimidos: 150 * 1024 * 1024,
} as const;
export type TopesZip = { maxBytesEntrada: number; maxEntradas: number; maxBytesDescomprimidos: number };

export type CodigoErrorZip =
  | "no_es_zip" | "ole" | "demasiado_grande" | "demasiadas_entradas" | "bomba_zip"
  | "zip_cifrado" | "zip_no_soportado" | "zip_ilegible";
export class ErrorZip extends Error {
  codigo: CodigoErrorZip;
  constructor(codigo: CodigoErrorZip, detalle: string) {
    super(detalle);
    this.name = "ErrorZip";
    this.codigo = codigo;
  }
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const w32 = (b: Uint8Array, o: number, v: number) => {
  b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = (v >>> 16) & 0xff; b[o + 3] = (v >>> 24) & 0xff;
};
const latin1 = (b: Uint8Array) => { let s = ""; for (let k = 0; k < b.length; k++) s += String.fromCharCode(b[k]); return s; };

type EntradaCD = { nombre: string; crudo: string; metodo: number; csz: number; usz: number; local: number; esDir: boolean };

/** Lee el zip, comprueba topes y devuelve nombre de parte (sin "/" inicial, tal cual viene) → bytes. */
export function leerZip(bytes: Uint8Array, topes: TopesZip = TOPES_ZIP): Map<string, Uint8Array> {
  if (!(bytes instanceof Uint8Array)) throw new ErrorZip("no_es_zip", "No llegó un archivo.");
  if (bytes.length > topes.maxBytesEntrada) {
    throw new ErrorZip("demasiado_grande", `El archivo pesa ${(bytes.length / 1048576).toFixed(1)} MB; el máximo es ${Math.round(topes.maxBytesEntrada / 1048576)} MB.`);
  }
  if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new ErrorZip("ole", "Es un documento de Word antiguo (.doc) o un .docx protegido con contraseña.");
  }
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new ErrorZip("no_es_zip", "El archivo no es un documento de Word (.docx).");
  }

  // ── Fin del directorio central (EOCD) ──
  let eocd = -1;
  const desde = Math.max(0, bytes.length - 22 - 0xffff);
  for (let k = bytes.length - 22; k >= desde; k--) {
    if (bytes[k] === 0x50 && bytes[k + 1] === 0x4b && bytes[k + 2] === 0x05 && bytes[k + 3] === 0x06) { eocd = k; break; }
  }
  if (eocd < 0) throw new ErrorZip("zip_ilegible", "El archivo está incompleto o dañado (no tiene directorio central).");
  const disco = u16(bytes, eocd + 4), discoCd = u16(bytes, eocd + 6);
  const enDisco = u16(bytes, eocd + 8), total = u16(bytes, eocd + 10);
  const tamCd = u32(bytes, eocd + 12), iniCd = u32(bytes, eocd + 16);
  if (disco !== 0 || discoCd !== 0 || enDisco !== total) throw new ErrorZip("zip_no_soportado", "El archivo está partido en varios volúmenes.");
  if (total === 0xffff || tamCd === 0xffffffff || iniCd === 0xffffffff) throw new ErrorZip("zip_no_soportado", "El archivo usa el formato ZIP64, que no se admite.");
  if (total > topes.maxEntradas) throw new ErrorZip("demasiadas_entradas", `El archivo tiene ${total} partes; el máximo es ${topes.maxEntradas}.`);
  if (iniCd + tamCd > eocd) throw new ErrorZip("zip_ilegible", "El directorio central del archivo está dañado.");

  // ── Directorio central ──
  const entradas: EntradaCD[] = [];
  const vistos = new Set<string>();
  let suma = 0;
  let p = iniCd;
  const dec = new TextDecoder("utf-8");
  for (let k = 0; k < total; k++) {
    if (p + 46 > eocd || u32(bytes, p) !== 0x02014b50) throw new ErrorZip("zip_ilegible", "El directorio central del archivo está dañado.");
    const flags = u16(bytes, p + 8), metodo = u16(bytes, p + 10);
    let csz = u32(bytes, p + 20), usz = u32(bytes, p + 24);
    const lNom = u16(bytes, p + 28), lExt = u16(bytes, p + 30), lCom = u16(bytes, p + 32);
    let local = u32(bytes, p + 42);
    const nomB = bytes.subarray(p + 46, p + 46 + lNom);
    const ext = bytes.subarray(p + 46 + lNom, p + 46 + lNom + lExt);
    if (p + 46 + lNom + lExt + lCom > eocd) throw new ErrorZip("zip_ilegible", "El directorio central del archivo está dañado.");
    // ZIP64 por entrada (0x0001): los campos en 0xFFFFFFFF vienen en el extra, en este orden.
    if (usz === 0xffffffff || csz === 0xffffffff || local === 0xffffffff) {
      let q = 0, hecho = false;
      while (q + 4 <= ext.length && !hecho) {
        const id = u16(ext, q), lon = u16(ext, q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          const leer = () => { const v = u32(ext, r) + u32(ext, r + 4) * 0x100000000; r += 8; return v; };
          if (usz === 0xffffffff && r + 8 <= q + 4 + lon) usz = leer();
          if (csz === 0xffffffff && r + 8 <= q + 4 + lon) csz = leer();
          if (local === 0xffffffff && r + 8 <= q + 4 + lon) local = leer();
          hecho = true;
        }
        q += 4 + lon;
      }
      if (usz === 0xffffffff || csz === 0xffffffff || local === 0xffffffff) throw new ErrorZip("zip_no_soportado", "El archivo usa el formato ZIP64, que no se admite.");
    }
    if (flags & 0x41 || metodo === 99) throw new ErrorZip("zip_cifrado", "El documento está protegido con contraseña.");
    const crudo = latin1(nomB);
    const nombre = (flags & 0x800 ? dec.decode(nomB) : crudo).replace(/^\/+/, "");
    const esDir = nombre.endsWith("/");
    if (!esDir) {
      if (metodo !== 0 && metodo !== 8) throw new ErrorZip("zip_no_soportado", `La parte «${nombre.slice(0, 60)}» usa una compresión que no se admite.`);
      if (metodo === 0 && csz !== usz) throw new ErrorZip("zip_ilegible", `La parte «${nombre.slice(0, 60)}» está dañada.`);
      const clave = nombre.toLowerCase();
      if (vistos.has(clave)) throw new ErrorZip("zip_ilegible", `El archivo repite la parte «${nombre.slice(0, 60)}».`);
      vistos.add(clave);
      suma += usz;
      if (suma > topes.maxBytesDescomprimidos) {
        throw new ErrorZip("bomba_zip", `Descomprimido pesaría más de ${Math.round(topes.maxBytesDescomprimidos / 1048576)} MB: no se abre.`);
      }
    }
    entradas.push({ nombre, crudo, metodo, csz, usz, local, esDir });
    p += 46 + lNom + lExt + lCom;
  }

  // ── Copia con las cabeceras locales fijadas a los tamaños ya comprobados ──
  const copia = bytes.slice();
  for (const e of entradas) {
    if (e.local + 30 > iniCd || u32(copia, e.local) !== 0x04034b50) throw new ErrorZip("zip_ilegible", `La parte «${e.nombre.slice(0, 60)}» está dañada.`);
    const lNom = u16(copia, e.local + 26), lExt = u16(copia, e.local + 28);
    if (e.local + 30 + lNom + lExt + e.csz > iniCd) throw new ErrorZip("zip_ilegible", `La parte «${e.nombre.slice(0, 60)}» está dañada.`);
    const lFlags = u16(copia, e.local + 6), lMet = u16(copia, e.local + 8);
    if (lFlags & 0x41) throw new ErrorZip("zip_cifrado", "El documento está protegido con contraseña.");
    if (!e.esDir && lMet !== e.metodo) throw new ErrorZip("zip_ilegible", `La parte «${e.nombre.slice(0, 60)}» está dañada.`);
    if (e.csz <= 0xfffffffe && e.usz <= 0xfffffffe) {
      // ZIP64 local: los campos extendidos del extra local quedan como estén; los de 32 bits valen.
      w32(copia, e.local + 18, e.csz);
      w32(copia, e.local + 22, e.usz);
    }
  }

  let cfb: any;
  try {
    cfb = (XLSX as any).CFB.read(copia, { type: "array" });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/encrypt/i.test(msg)) throw new ErrorZip("zip_cifrado", "El documento está protegido con contraseña.");
    throw new ErrorZip("zip_ilegible", "El archivo está dañado y no se pudo descomprimir.");
  }

  // CFB nombra cada entrada como ("Root Entry/" + nombre crudo).replace("//","/").
  const raizCfb = String(cfb?.FullPaths?.[0] ?? "Root Entry/");
  const contenido = new Map<string, unknown>();
  (cfb?.FileIndex ?? []).forEach((f: any, k: number) => {
    if (!f || f.type !== 2) return;
    const fp = String(cfb.FullPaths?.[k] ?? "");
    if (fp.startsWith(raizCfb)) contenido.set(fp.slice(raizCfb.length), f.content);
  });

  const out = new Map<string, Uint8Array>();
  let real = 0;
  for (const e of entradas) {
    if (e.esDir) continue;
    const clave = (raizCfb + e.crudo).replace("//", "/").slice(raizCfb.length);
    const c = contenido.get(clave);
    const u8 = aU8(c);
    if (!u8 && e.usz > 0) throw new ErrorZip("zip_ilegible", `No se pudo descomprimir la parte «${e.nombre.slice(0, 60)}».`);
    const v = u8 ?? new Uint8Array(0);
    real += v.length;
    if (real > topes.maxBytesDescomprimidos) throw new ErrorZip("bomba_zip", `Descomprimido pesaría más de ${Math.round(topes.maxBytesDescomprimidos / 1048576)} MB: no se abre.`);
    out.set(e.nombre, v);
  }
  return out;
}

function aU8(c: unknown): Uint8Array | null {
  if (c instanceof Uint8Array) return new Uint8Array(c.buffer, c.byteOffset, c.byteLength);
  if (Array.isArray(c)) return Uint8Array.from(c as number[]);
  return null;
}

/** Busca una parte sin distinguir mayúsculas (los nombres de partes OPC no las distinguen). */
export function parteZip(zip: Map<string, Uint8Array>, nombre: string): Uint8Array | null {
  const limpio = nombre.replace(/^\/+/, "");
  const directo = zip.get(limpio);
  if (directo) return directo;
  const bajo = limpio.toLowerCase();
  for (const [k, v] of zip) if (k.toLowerCase() === bajo) return v;
  return null;
}
