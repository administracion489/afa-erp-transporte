// Copias GIRADAS de las fotos de un reporte, para el reintento de lectura del voucher (solo servidor).
// Qué girar y cuándo lo decide lib/radar/voucher-girado.ts (PURO); acá solo se bajan las fotos y se
// giran con `sharp` (el mismo que usa Next para optimizar imágenes).
//
// Todo es best-effort: si `sharp` no carga, una foto no baja o no es una imagen, esa copia no se hace y
// el reporte sigue con la primera lectura — nunca peor que antes del reintento.

import type { Giro } from "@/lib/radar/voucher-girado";

export type CopiaGirada = {
  /** Posición (0-based) de la foto original dentro de las que se mandaron al modelo. */
  indice: number;
  giro: Giro;
  /** JPEG en base64, listo para un bloque `image` de Anthropic. */
  base64: string;
  mime: "image/jpeg";
};

/** Lado mayor de la copia. 1568 px es el tamaño en que la API de visión deja de reducir la imagen. */
const LADO_MAX = 1568;
/** Una foto de WhatsApp pesa < 1 MB; más de esto no es una foto de voucher. */
const MAX_BYTES_ORIGINAL = 15 * 1024 * 1024;
const TIMEOUT_DESCARGA_MS = 15_000;

async function cargarSharp(): Promise<any | null> {
  try {
    const m: any = await import("sharp");
    return m?.default ?? m;
  } catch {
    return null;
  }
}

async function bajar(url: string): Promise<Buffer | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_DESCARGA_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength === 0 || ab.byteLength > MAX_BYTES_ORIGINAL) return null;
    return Buffer.from(ab);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Baja cada foto (por su URL ya FIRMADA: `radar-media` es privado) y devuelve sus copias giradas, en
 * el orden foto → giro. `null` si `sharp` no está disponible (no hay reintento posible).
 */
export async function copiasGiradas(urls: string[], giros: Giro[]): Promise<CopiaGirada[] | null> {
  if (!urls.length || !giros.length) return [];
  const sharp = await cargarSharp();
  if (!sharp) return null;
  const porFoto = await Promise.all(
    urls.map(async (url, indice) => {
      const buf = await bajar(url);
      if (!buf) return [] as CopiaGirada[];
      const copias: CopiaGirada[] = [];
      for (const giro of giros) {
        try {
          // autoOrient primero: si la foto trae orientación EXIF, el giro se aplica sobre lo que se VE.
          const out: Buffer = await sharp(buf, { failOn: "none" })
            .autoOrient()
            .rotate(giro)
            .resize({ width: LADO_MAX, height: LADO_MAX, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
          copias.push({ indice, giro, base64: out.toString("base64"), mime: "image/jpeg" });
        } catch {
          // No es una imagen que sharp entienda: sin copias de esta foto.
        }
      }
      return copias;
    })
  );
  return porFoto.flat();
}
