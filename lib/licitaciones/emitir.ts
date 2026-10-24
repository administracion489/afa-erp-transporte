// ──────────────────────────────────────────────────────────────────────────────
// lib/licitaciones/emitir.ts — La EMISIÓN de una licitación, de punta a punta, en el NAVEGADOR (D10):
// comprueba y baja las fuentes, arma la propuesta técnica y un PDF por bloque del expediente, los
// FOLIA con un solo mapa (D13), arma el completo, empaca, sube las copias al bucket privado
// `licitaciones` y registra la emisión INMUTABLE en `licitacion_emisiones`.
//
// TODO LO QUE TOCA LA RED O LA BASE LLEGA INYECTADO (`DepsEmision`): el cliente de Supabase, la descarga,
// la firma de enlaces, el almacenamiento y —mientras su agente los termina— los dos resolvedores
// (`resolverDocumento`, `resolverExpediente`) y, opcional, `revisarLicitacion`. Así la matriz
// (scripts/prueba-licitaciones-emision.mts) corre la emisión ENTERA en node con todo falso en memoria.
// `depsNavegador(db, resolvedores)` arma las de verdad para la pantalla.
//
// REGLAS QUE NO SE AFLOJAN
//  · UN ARCHIVO NUNCA TUMBA LA EMISIÓN (D7, R11). Lo que no se puede unir —un enlace externo (Drive),
//    un PDF cifrado (también el de solo contraseña de propietario; nunca `ignoreEncryption`), uno
//    ilegible, un formato que no es PDF/PNG/JPG, uno que no bajó o que pesa más del tope— se OMITE y
//    se NOMBRA con su código en `omitidos`, y el resto sale igual. `comprobarArchivos` nunca lanza por
//    un archivo.
//  · CONFLICTO DE VERSIÓN ANTES DE TODO: con cambios sin guardar, o con la licitación en otra versión que
//    la guardada, no se baja, no se sube ni se registra nada (`conflicto_version`). Lo emitido tiene que
//    ser exactamente lo guardado: la fila registra `doc_version`.
//  · LA COPIA EMITIDA NO SE PISA (R3, R10). Cada emisión sube a SU carpeta (`emisiones/<lic>/<uuid>/…`,
//    `rutaEmision`) con `upsert: false`; el bucket no admite UPDATE ni DELETE. Una ruta que ya existe
//    queda con su motivo y NO se reintenta en otra. Un archivo que pasa de `TOPES_DOC.maxBytesArchivo`
//    (el límite del bucket) no se sube y lo dice; un fallo de subida no aborta: queda en
//    `motivoNoSubido`. El ZIP NO se sube: es el empaque de los mismos PDF que sí se suben (su sha256 queda
//    registrado). El enlace guardado es el público (IDENTIFICADOR, como el resto del ERP) y se comprueba
//    que `objetoPrivadoDe(url)` devuelva EXACTAMENTE la ruta subida: escribir y leer con la misma identidad.
//  · EL REGISTRO LO SELLA LA BASE: no se mandan `emitido_por` ni `emitido_en` (los pone el trigger
//    fn_licitacion_emisiones_sellar). `version` = la mayor de esa licitación + 1, leída en el momento; un
//    choque en `uq_licitacion_emisiones_version` (dos pestañas a la vez) se reintenta UNA vez con la
//    siguiente. Una lectura de la versión que falla NO es «no hay emisiones»: no se registra
//    (`registro_fallido`). Un registro fallido DEVUELVE IGUAL los archivos armados (no se pierde el
//    trabajo) y la fila pendiente para reintentar con `registrarEmision`.
//  · LA FIRMA es sha256 (hex minúscula) de `canonico(foto)` (lib/json-canonico, la misma regla que la
//    Confirmación de Reserva). Sin `crypto.subtle` (contexto no seguro) se calcula en JS puro: la base
//    exige la firma, así que no puede depender del navegador.
//
// CÓMO SE ARMA (y por qué en este orden)
//  1. Se resuelven el expediente y el documento (SIN folios) y se cuenta quién usa cada URL.
//  2. La comprobación va JUNTO con la descarga: cada fuente se baja UNA vez (3 a la vez, con tope de tiempo
//     y de bytes), cuando el primer bloque la necesita, y se revisa ahí (sha256, formato por la firma de
//     los bytes, cifrado). Sus bytes se SUELTAN apenas el último bloque que la usa terminó (R12: ~250 MB
//     de fuentes). Las imágenes de la propuesta, el logo y la firma (pocas y chicas) se conservan hasta el
//     final. Lo que devolvió el ensayo (`extra.revisiones`) NO evita bajar —hacen falta los bytes, y el
//     bucket `documentos` deja sobrescribir—: sirve para AVISAR si un archivo cambió entre el ensayo y la
//     emisión. Una fuente que ya se sabe externa no se intenta bajar.
//  3. Propuesta SIN folios (P0) → cada bloque activo con `armarBloque`, de a uno (con P0 donde un bloque
//     lleva la parte `propuesta`). Un bloque de 0 páginas no se emite (se avisa).
//  4. `mapaFolios` sobre [propuesta si `propuestaEnCompleto = "primero"`] + bloques.
//  5. DOS PASADAS: `resolverDocumento` con los folios de cada bloque (la relación de adjuntos) →
//     `dibujarPropuesta`. Si las páginas de la propuesta cambian al meter los folios (no debería: el ancho
//     es fijo, «000–000») se recalcula UNA vez; si aun así no casan, se avisa. Después la propuesta FINAL
//     reemplaza a P0 dentro de los bloques que la llevan (sus páginas se sustituyen en el PDF ya armado:
//     no hace falta volver a bajar nada).
//  6. Folios: el completo con todos; cada bloque suelto (y la propuesta suelta) con el que tendría en el
//     completo si `foliarBloquesSueltos`. Los dos salen del MISMO mapa: no pueden discrepar.
//  7. Completo = `unirPdfs` de las partes YA foliadas. 8. ZIP. 9. Subida. 10. Registro. 11. Descargas.
//
// DECISIONES DECLARADAS
//  · Los folios de un bloque suelto y del completo salen del MISMO arreglo (`mapa.foliosDeBloque`).
//    `ArchivoEmitido.folios` es el rango que el ARCHIVO lleva impreso; null = el archivo no lleva folios.
//  · La PORTADA de la propuesta cuenta como portada para `foliarPortadas` (igual que la separadora).
//  · Si `propuestaEnCompleto = "primero"`, los folios de los bloques (sueltos y en la relación de adjuntos)
//    cuentan las páginas de la propuesta aunque el completo no se emita: un folio no cambia con lo que se
//    eligió descargar. Por lo mismo, si solo se emite la propuesta y tiene «relación de adjuntos» con
//    foliado, los bloques se ARMAN (sin emitirse) para que sus folios sean reales.
//  · Un error PROPIO (pdf-lib al guardar, un error de programación) LANZA: no es un archivo. Un
//    RangeError (el navegador sin memoria) devuelve `memoria`.
//  · Umbrales NO medidos: TIEMPO_DESCARGA_MS (3 min por archivo), CONCURRENCIA_DESCARGAS (3),
//    TOPE_FUENTES_BYTES (250 MB, el R12, solo AVISA).
// ──────────────────────────────────────────────────────────────────────────────

import { PDFDocument } from "pdf-lib";
import { dibujarPropuesta, type ResultadoPropuesta } from "./pdf/propuesta";
import {
  armarBloque, revisarPdf, mapaFolios, foliar, unirPdfs, formatoDeBytes,
  type ArchivoBajado, type ComunBloque, type MapaFolios,
} from "./pdf/expediente";
import { revisarImagenLic, type ImagenPdf } from "./pdf/comun";
import { armarZip } from "../zip-sin-compresion";
import { origenArchivo, rutaEmision, nombreArchivoEmitido } from "./archivos";
import { canonico } from "../json-canonico";
import { formatoPorFirma } from "../traslados/fotos-categoria";
import { objetoPrivadoDe, baseSupabase } from "../storage-privado";
import { firmarUrls, type ClienteStorage } from "../storage-firmado";
import { empresaConDefectos } from "../empresa-perfil";
import {
  BUCKET_LICITACIONES, TOPES_DOC,
  type ArchivoEmitido, type BloqueExpedienteResuelto, type CodigoHallazgo, type ContextoLicitacion, type DocLicitacion,
  type DocumentoResuelto, type ExpedienteResuelto, type FaseEmision, type FilaEmision, type FotoEmision, type HallazgoEmitido,
  type Licitacion, type OmitidoEmision, type OpcionesEmision, type OrigenArchivo, type ParteFuente, type ProgresoEmision,
  type ResultadoEmision, type Revision, type RevisionArchivo, type TipoArchivoEmitido,
} from "./tipos";

// ══ Constantes declaradas (no medidas) ══════════════════════════════════════════

/** Tope de tiempo por descarga. Un PDF de 50 MB a 2 Mbps tarda ~200 s: 3 min deja el lado lento afuera. */
export const TIEMPO_DESCARGA_MS = 180_000;
/** Descargas a la vez: lo justo para no esperar archivo por archivo sin saturar la red de la oficina. */
export const CONCURRENCIA_DESCARGAS = 3;
/** R12: tope declarado de las fuentes de una emisión. Solo AVISA (la revisión lo nombra como expediente_pesa_mucho). */
export const TOPE_FUENTES_BYTES = 250 * 1024 * 1024;
/** Lado máximo al convertir una WEBP en el navegador (un canvas enorme es memoria que no se recupera). */
const LADO_MAX_CONVERSION = 6000;
const COLUMNAS_FILA_EMISION = ["id", "licitacion_id", "version", "carpeta", "emitido_por", "emitido_en", "doc_version", "firma"];

// ══ Dependencias inyectadas ═════════════════════════════════════════════════════

export type FoliosPorBloque = Record<string /* bloqueId */, { desde: number; hasta: number }>;
export type ResolverDocumento = (lic: Licitacion, ctx: ContextoLicitacion, rev: Revision, opts?: { folios?: FoliosPorBloque }) => DocumentoResuelto;
export type ResolverExpediente = (lic: Licitacion, ctx: ContextoLicitacion, rev: Revision) => ExpedienteResuelto;
export type RevisarLicitacion = (lic: Licitacion, ctx: ContextoLicitacion, archivos?: Record<string, RevisionArchivo>, ultima?: FilaEmision | null) => Revision;
export type StorageEmision = {
  /** Sube SIN sobrescribir (upsert false). `url` = el enlace público del objeto (identificador). */
  subir(bucket: string, ruta: string, bytes: Uint8Array, contentType: string): Promise<{ error: string | null; url: string | null }>;
};

export type DepsEmision = {
  /** Cliente de Supabase del navegador (lib/supabase.ts). Se usa para el registro y, sin `storage`, para subir. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  /** null = sube con `db.storage` (upload upsert:false + getPublicUrl). */
  storage: StorageEmision | null;
  /** Baja una URL YA FIRMADA. Debe respetar `tope` (bytes) y `senal`; si no, se corta igual desde aquí. */
  descargar(url: string, tope: number, senal: AbortSignal): Promise<Uint8Array>;
  /** Firma en lote: enlace guardado → enlace que se puede abrir (firmarUrls). Lo que no venga, se usa tal cual. */
  firmar(urls: string[]): Promise<Map<string, string>>;
  resolverDocumento: ResolverDocumento;
  resolverExpediente: ResolverExpediente;
  /** Opcional: con ella, los hallazgos que se REGISTRAN se recalculan con lo que se bajó (pdf_protegido…). */
  revisarLicitacion?: RevisarLicitacion;
  ahora?: () => Date;
  uuid?: () => string;
  /** WEBP → JPEG (canvas del navegador). null o ausente → la WEBP se omite como formato no soportado. */
  webpAJpeg?: (bytes: Uint8Array) => Promise<Uint8Array | null>;
  /** URL del proyecto para `origenArchivo`. Por defecto `baseSupabase()`; null = no se compara el origen. */
  base?: string | null;
  /** Para la matriz: los topes de descarga y de subida y el tiempo por descarga. Por defecto los declarados. */
  topes?: { descarga?: number; subida?: number; tiempoMs?: number };
};

/** Lo que la emisión necesita además de la licitación (lo sabe la pantalla). */
export type ExtraEmision = {
  /** La `version` de la licitación tal como quedó GUARDADA (la de la fila leída o del último guardado). */
  versionGuardada: number;
  hayCambiosSinGuardar: boolean;
  /** URL del logo (empresa_perfil.logo_url). null = sin logo. */
  logo: string | null;
  /** Hallazgos ACEPTADOS al emitir (el confirm() con nota). Sin esto, salen de `rev` (Hallazgo.aceptado). */
  aceptados?: HallazgoEmitido[];
  nota: string | null;
  /** Lo que devolvió `comprobarArchivos` (el ensayo): se usa para avisar si un archivo CAMBIÓ entre el ensayo y la emisión. */
  revisiones?: Record<string, RevisionArchivo>;
  /** La última emisión (para `revisarLicitacion`: archivo_cambio_desde_emision). */
  ultima?: FilaEmision | null;
};

export type DescargaEmision = { nombre: string; blob: Blob };
/** La fila que se inserta (sin lo que pone la base). */
export type EmisionNueva = Omit<FilaEmision, "id" | "version" | "emitido_por" | "emitido_en">;

/**
 * `ResultadoEmision` del contrato + lo que la pantalla necesita para no perder nada. Es ASIGNABLE a
 * ResultadoEmision. En un fallo, `archivos` solo trae algo en `registro_fallido` (y en `cancelada` si ya
 * se había armado todo); `registroPendiente` es la fila para reintentar con `registrarEmision`.
 */
export type ResultadoEmitir =
  | (Extract<ResultadoEmision, { ok: true }> & { carpeta: string; emitidos: ArchivoEmitido[]; revisiones: Record<string, RevisionArchivo> })
  | (Extract<ResultadoEmision, { ok: false }> & {
      archivos: DescargaEmision[]; omitidos: OmitidoEmision[]; avisos: string[]; carpeta: string | null;
      emitidos: ArchivoEmitido[]; revisiones: Record<string, RevisionArchivo>; registroPendiente: EmisionNueva | null;
    });

// ══ Helpers puros (probados en la matriz) ═══════════════════════════════════════

const claveNombre = (n: string) => n.normalize("NFC").toLocaleLowerCase("es-PE");

/**
 * Nombres únicos SIN distinguir mayúsculas (en Windows y macOS «Anexo.pdf» y «anexo.pdf» son el mismo
 * archivo, y armarZip los rechaza): el segundo «x.pdf» pasa a «x_2.pdf», el tercero a «x_3.pdf». El
 * sufijo va antes de la extensión y la base se acorta para no pasar de 100 caracteres (nombreArchivoEmitido).
 */
export function nombresUnicos(nombres: string[]): string[] {
  const vistos = new Set<string>();
  return nombres.map((n0) => {
    const n = String(n0 ?? "");
    const punto = n.lastIndexOf(".");
    const base = punto > 0 ? n.slice(0, punto) : n;
    const ext = punto > 0 ? n.slice(punto) : "";
    let cand = n;
    for (let k = 2; vistos.has(claveNombre(cand)); k++) {
      const suf = `_${k}`;
      cand = `${base.slice(0, Math.max(1, 100 - suf.length))}${suf}${ext}`;
    }
    vistos.add(claveNombre(cand));
    return cand;
  });
}

/** ¿Se sube esta copia? No, si pasa del tope del bucket (TOPES_DOC.maxBytesArchivo) o está vacía. */
export function debeSubir(bytes: number | Uint8Array, tope: number = TOPES_DOC.maxBytesArchivo): { sube: true } | { sube: false; motivo: string } {
  const n = typeof bytes === "number" ? bytes : bytes?.length ?? 0;
  if (!Number.isFinite(n) || n <= 0) return { sube: false, motivo: "El archivo salió vacío: no hay nada que subir." };
  if (n > tope) {
    return { sube: false, motivo: `Pesa ${mb(n)} y el almacenamiento acepta hasta ${mb(tope)} por archivo: no se subió la copia. Descárgalo y guárdalo tú, o emite por bloques.` };
  }
  return { sube: true };
}

const mb = (n: number) => `${(n / 1048576).toFixed(n >= 10 * 1048576 ? 0 : 1)} MB`;

// ── SHA-256 ──
const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * SHA-256 INCREMENTAL en JS puro: el respaldo cuando no hay crypto.subtle, y el que se usa sobre las
 * PARTES de un ZIP sin juntarlas en un solo buffer (juntarlas duplicaría su tamaño en memoria).
 */
export class Sha256 {
  private readonly H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly W = new Uint32Array(64);
  private readonly resto = new Uint8Array(64);
  private enResto = 0;
  private largo = 0;

  private comprimir(b: Uint8Array, o: number): void {
    const W = this.W, H = this.H;
    for (let t = 0; t < 16; t++) W[t] = (b[o + 4 * t] << 24) | (b[o + 4 * t + 1] << 16) | (b[o + 4 * t + 2] << 8) | b[o + 4 * t + 3];
    for (let t = 16; t < 64; t++) {
      const x = W[t - 15], y = W[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let a = H[0], b2 = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[t] + W[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b2) ^ (a & c) ^ (b2 & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b2; b2 = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b2; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }

  actualizar(datos: Uint8Array): this {
    let i = 0;
    const n = datos.length;
    this.largo += n;
    if (this.enResto) {
      const k = Math.min(64 - this.enResto, n);
      this.resto.set(datos.subarray(0, k), this.enResto);
      this.enResto += k; i = k;
      if (this.enResto < 64) return this;
      this.comprimir(this.resto, 0);
      this.enResto = 0;
    }
    for (; i + 64 <= n; i += 64) this.comprimir(datos, i);
    if (i < n) { this.resto.set(datos.subarray(i), 0); this.enResto = n - i; }
    return this;
  }

  hex(): string {
    const cola = new Uint8Array(this.enResto + 9 <= 64 ? 64 : 128);
    cola.set(this.resto.subarray(0, this.enResto));
    cola[this.enResto] = 0x80;
    const bits = this.largo * 8;
    const hi = Math.floor(bits / 0x1_0000_0000), lo = bits >>> 0;
    const L = cola.length;
    cola[L - 8] = hi >>> 24; cola[L - 7] = hi >>> 16; cola[L - 6] = hi >>> 8; cola[L - 5] = hi;
    cola[L - 4] = lo >>> 24; cola[L - 3] = lo >>> 16; cola[L - 2] = lo >>> 8; cola[L - 1] = lo;
    for (let o = 0; o < L; o += 64) this.comprimir(cola, o);
    return Array.from(this.H, (x) => x.toString(16).padStart(8, "0")).join("");
  }
}

/** SHA-256 en JS puro de un solo buffer. Hex minúscula. */
export function sha256Puro(datos: Uint8Array): string {
  return new Sha256().actualizar(datos).hex();
}

/** SHA-256 hex minúscula: crypto.subtle si hay (contexto seguro); si no, `sha256Puro`. Nunca null. */
export async function sha256Hex(datos: Uint8Array): Promise<string> {
  const sutil = globalThis.crypto?.subtle;
  if (sutil && typeof sutil.digest === "function") {
    try {
      const d = await sutil.digest("SHA-256", datos as unknown as BufferSource);
      return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
    } catch { /* cae al respaldo */ }
  }
  return sha256Puro(datos);
}

/** SHA-256 de varias partes seguidas (como si fueran un solo archivo), sin juntarlas. */
export function sha256DePartes(partes: Uint8Array[]): string {
  const h = new Sha256();
  for (const p of partes) h.actualizar(p);
  return h.hex();
}

/** La firma de la emisión: sha256 hex minúscula de `canonico(foto)` (el CHECK de la tabla exige ^[0-9a-f]{64}$). */
export async function firmaDeFoto(foto: FotoEmision): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonico(foto)));
}

/**
 * Los hallazgos que quedan en la emisión: TODOS los de la revisión (abiertos y aceptados), cada uno con
 * `aceptado` y su nota. Un aceptado al emitir (`aceptados`, el confirm() con nota) manda sobre el del doc;
 * uno aceptado que la revisión ya no da se conserva (lo aceptó una persona).
 */
export function hallazgosParaEmision(rev: Pick<Revision, "hallazgos">, aceptados: HallazgoEmitido[] = []): HallazgoEmitido[] {
  const alEmitir = new Map(aceptados.filter((a) => a && a.aceptado).map((a) => [a.clave, a]));
  const out: HallazgoEmitido[] = (rev.hallazgos ?? []).map((h) => {
    const a = alEmitir.get(h.clave);
    if (a) return { clave: h.clave, codigo: h.codigo, gravedad: h.gravedad, texto: h.texto, aceptado: true, nota: a.nota ?? h.aceptado?.nota ?? null };
    return { clave: h.clave, codigo: h.codigo, gravedad: h.gravedad, texto: h.texto, aceptado: !!h.aceptado, nota: h.aceptado?.nota ?? null };
  });
  const vistos = new Set(out.map((h) => h.clave));
  for (const a of alEmitir.values()) if (!vistos.has(a.clave)) out.push({ ...a, aceptado: true, nota: a.nota ?? null });
  return out;
}

/** Cuánto suman las fuentes que se pudieron bajar (para el aviso del R12). */
export function pesoFuentes(revisiones: Record<string, RevisionArchivo>): number {
  return Object.values(revisiones ?? {}).reduce((a, r) => a + (r && r.ok ? r.bytes : 0), 0);
}

/** ¿El doc imprime la «relación de adjuntos»? (sus folios obligan a armar los bloques). */
export function docTieneRelacionAdjuntos(doc: DocLicitacion): boolean {
  return (doc?.secciones ?? []).some((s) => s?.activa && (s.bloques ?? []).some((b) => b?.tipo === "auto" && b.auto === "relacion_adjuntos"));
}

// ══ Descarga y revisión de una fuente ══════════════════════════════════════════

/** Lo que tira `descargarConFetch` (y lo que se entiende si lo tira otra `descargar`). */
export class ErrorDescarga extends Error {
  readonly codigo: "demasiado_grande" | "http" | "red";
  readonly status: number | null;
  constructor(codigo: "demasiado_grande" | "http" | "red", mensaje: string, status: number | null = null) {
    super(mensaje);
    this.codigo = codigo;
    this.status = status;
    this.name = "ErrorDescarga";
    Object.setPrototypeOf(this, ErrorDescarga.prototype);
  }
}

class Cancelada extends Error {
  constructor() { super("cancelada"); this.name = "Cancelada"; Object.setPrototypeOf(this, Cancelada.prototype); }
}

type Uso = "documento" | "imagen";
type Formato = "pdf" | "png" | "jpg";
type Bajado = { rev: RevisionArchivo; bytes: Uint8Array | null; formato: Formato | null };

function rechazo(url: string, codigo: Extract<RevisionArchivo, { ok: false }>["codigo"], detalle: string): RevisionArchivo {
  return { url, ok: false, codigo, detalle };
}

/** Una promesa que se rechaza cuando la señal se aborta (para cortar una `descargar` que no la respeta). */
function alAbortar(senal: AbortSignal): Promise<never> {
  return new Promise((_, rej) => {
    if (senal.aborted) { rej(new Cancelada()); return; }
    senal.addEventListener("abort", () => rej(new Cancelada()), { once: true });
  });
}

/** Baja UNA fuente con tope de tiempo y de bytes. Nunca lanza salvo que se cancele la emisión (`Cancelada`). */
async function bajarFuente(url: string, firmada: string, deps: DepsEmision, senal: AbortSignal): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; rev: RevisionArchivo }> {
  const tope = deps.topes?.descarga ?? TOPES_DOC.maxBytesArchivo;
  const tiempo = deps.topes?.tiempoMs ?? TIEMPO_DESCARGA_MS;
  if (senal.aborted) throw new Cancelada();
  const ctrl = new AbortController();
  const propagar = () => ctrl.abort();
  senal.addEventListener("abort", propagar, { once: true });
  let vencio = false;
  const reloj = setTimeout(() => { vencio = true; ctrl.abort(); }, tiempo);
  try {
    const bytes = await Promise.race([deps.descargar(firmada, tope, ctrl.signal), alAbortar(ctrl.signal)]);
    if (!(bytes instanceof Uint8Array)) return { ok: false, rev: rechazo(url, "archivo_no_descargable", "La descarga no devolvió el archivo.") };
    if (bytes.length > tope) return { ok: false, rev: rechazo(url, "archivo_demasiado_grande", `Pesa ${mb(bytes.length)} y el tope por archivo es ${mb(tope)}. Comprímelo o divídelo.`) };
    if (!bytes.length) return { ok: false, rev: rechazo(url, "archivo_no_descargable", "El archivo bajó vacío (0 bytes). Vuelve a subirlo.") };
    return { ok: true, bytes };
  } catch (e) {
    if (senal.aborted) throw new Cancelada();
    if (vencio) return { ok: false, rev: rechazo(url, "archivo_no_descargable", `Tardó más de ${Math.round(tiempo / 1000)} s en bajar. Revisa tu conexión y vuelve a emitir.`) };
    const err = e as { codigo?: string; status?: number | null; message?: string };
    if (err?.codigo === "demasiado_grande") return { ok: false, rev: rechazo(url, "archivo_demasiado_grande", `Pesa más del tope por archivo (${mb(tope)}). Comprímelo o divídelo.`) };
    const st = Number(err?.status ?? 0);
    if (st === 404) return { ok: false, rev: rechazo(url, "archivo_no_descargable", "El archivo ya no está en el almacenamiento (se borró o se movió). Vuelve a subirlo.") };
    if (st === 400 || st === 401 || st === 403) return { ok: false, rev: rechazo(url, "archivo_no_descargable", `El almacenamiento rechazó la descarga (${st}): tu usuario no puede leer ese archivo o el enlace venció. Recarga y vuelve a emitir.`) };
    const m = String(err?.message ?? e ?? "").slice(0, 160);
    return { ok: false, rev: rechazo(url, "archivo_no_descargable", `No se pudo bajar${m ? ` (${m})` : ""}. Revisa tu conexión y vuelve a emitir.`) };
  } finally {
    clearTimeout(reloj);
    senal.removeEventListener("abort", propagar);
  }
}

const NOMBRE_FORMATO_RARO: Record<string, string> = {
  heic: "una foto HEIC (la del iPhone)", gif: "una imagen GIF", webp: "una imagen WebP",
};

/**
 * Qué se puede hacer con estos bytes según para qué se usan. Documento: PDF, PNG o JPG; imagen: PNG o
 * JPG. WEBP → JPEG si hay conversor. El formato sale de la FIRMA de los bytes, nunca del nombre.
 */
async function clasificar(url: string, bytes: Uint8Array, uso: Uso, deps: DepsEmision): Promise<{ ok: true; bytes: Uint8Array; formato: Formato } | { ok: false; rev: RevisionArchivo }> {
  const f = formatoDeBytes(bytes);
  if (f === "pdf") {
    if (uso === "imagen") return { ok: false, rev: rechazo(url, "archivo_formato_no_soportado", "Es un PDF y aquí va una imagen (PNG o JPG). Súbela como imagen.") };
    return { ok: true, bytes, formato: "pdf" };
  }
  if (f === "png" || f === "jpg") {
    // Antes de que pdf-lib la toque: un PNG animado o que declara medidas enormes cuelga la pestaña.
    const seg = revisarImagenLic(bytes);
    if (!seg.ok) return { ok: false, rev: rechazo(url, "archivo_formato_no_soportado", seg.detalle) };
    return { ok: true, bytes, formato: f };
  }
  const raro = formatoPorFirma(bytes);
  if (raro === "webp") {
    if (deps.webpAJpeg) {
      let jpg: Uint8Array | null = null;
      try { jpg = await deps.webpAJpeg(bytes); } catch { jpg = null; }
      if (jpg && formatoDeBytes(jpg) === "jpg" && revisarImagenLic(jpg).ok) return { ok: true, bytes: jpg, formato: "jpg" };
      return { ok: false, rev: rechazo(url, "archivo_formato_no_soportado", "Es una imagen WebP y el navegador no pudo convertirla a JPG. Guárdala como JPG o PNG y vuelve a subirla.") };
    }
    return { ok: false, rev: rechazo(url, "archivo_formato_no_soportado", "Es una imagen WebP, que el PDF no puede unir. Guárdala como JPG o PNG y vuelve a subirla.") };
  }
  const que = raro ? NOMBRE_FORMATO_RARO[raro] ?? `un archivo ${raro}` : "un tipo que el ERP no reconoce";
  const se = uso === "imagen" ? "PNG o JPG" : "PDF, PNG o JPG";
  return { ok: false, rev: rechazo(url, "archivo_formato_no_soportado", `Es ${que}: el expediente solo une ${se}. Expórtalo a ${se} y vuelve a subirlo.`) };
}

/**
 * Prueba que pdf-lib pueda incrustar la imagen (lo mismo que hará el PDF). Solo en el ensayo, y solo
 * DESPUÉS de `revisarImagenLic` (que ya pasó en `clasificar`; se repite aquí por si alguien la llama sola).
 */
async function imagenLegible(bytes: Uint8Array, formato: "png" | "jpg"): Promise<boolean> {
  if (!revisarImagenLic(bytes).ok) return false;
  try {
    const d = await PDFDocument.create();
    if (formato === "png") await d.embedPng(new Uint8Array(bytes)); else await d.embedJpg(new Uint8Array(bytes));
    return true;
  } catch { return false; }
}

async function enParalelo<T>(items: T[], n: number, fn: (x: T) => Promise<void>, senal: AbortSignal): Promise<void> {
  let i = 0;
  const trabajador = async () => {
    while (i < items.length && !senal.aborted) { const k = i++; await fn(items[k]); }
  };
  await Promise.all(Array.from({ length: Math.max(0, Math.min(n, items.length)) }, trabajador));
}

/** Firma en lote; si la firma falla, cada enlace se usa tal cual (y su descarga dirá por qué falló). */
async function firmarLote(urls: string[], deps: DepsEmision): Promise<Map<string, string>> {
  if (!urls.length) return new Map();
  try { return (await deps.firmar(urls)) ?? new Map(); } catch { return new Map(); }
}

// ══ Qué URL usa quién ═══════════════════════════════════════════════════════════

type UsoUrl = { url: string; uso: Uso; itemId: string; origen: OrigenArchivo };

function usosDeDocumento(doc: DocumentoResuelto, base: string | null): UsoUrl[] {
  const out: UsoUrl[] = [];
  const add = (url: string | null | undefined, itemId: string) => {
    const u = String(url ?? "").trim();
    if (u) out.push({ url: u, uso: "imagen", itemId, origen: origenArchivo(u, base) });
  };
  if (doc.portada?.modo === "imagen") add(doc.portada.imagenUrl, "propuesta:portada");
  for (const s of doc.secciones ?? []) for (const b of s.bloques ?? []) if (b.tipo === "imagen") add(b.url, `propuesta:${b.id}`);
  add(doc.firmante?.firmaUrl, "propuesta:firma");
  return out;
}

function usosDeBloque(b: BloqueExpedienteResuelto, base: string | null): UsoUrl[] {
  const out: UsoUrl[] = [];
  for (const p of b.partes ?? []) {
    if (p.tipo === "archivo") {
      const u = String(p.url ?? "").trim();
      if (u) out.push({ url: u, uso: "documento", itemId: p.itemId, origen: p.origen ?? origenArchivo(u, base) });
    } else if (p.tipo === "ficha_unidad") {
      for (const u0 of [p.ficha.fotoExternaUrl, p.ficha.fotoInternaUrl]) {
        const u = String(u0 ?? "").trim();
        if (u) out.push({ url: u, uso: "imagen", itemId: p.itemId, origen: origenArchivo(u, base) });
      }
    } else if (p.tipo === "cuadro_experiencia") {
      const u = String(p.cuadro.firmante?.firmaUrl ?? "").trim();
      if (u) out.push({ url: u, uso: "imagen", itemId: p.itemId, origen: origenArchivo(u, base) });
    }
  }
  return out;
}

const bajable = (o: OrigenArchivo) => o === "storage_privado" || o === "storage_publico";
const EXTERNO_DETALLE = "Es un enlace externo (Drive u otro sitio): el navegador no lo puede bajar. Súbelo como PDF al ERP.";

// ══ Ensayo: comprobarArchivos ═══════════════════════════════════════════════════

/**
 * Ensayo SIN emitir: baja y revisa cada archivo que la emisión usaría (partes de los bloques, fotos de las
 * fichas, la firma del cuadro, las imágenes y la firma de la propuesta, y el logo). Por URL: externo →
 * `archivo_externo`; si no, firma en lote, baja (3 a la vez, tope de tiempo y bytes), sha256, formato por
 * la firma de los bytes, y PDF → revisarPdf (protegido / ilegible). NUNCA lanza por un archivo; si se
 * cancela devuelve lo que alcanzó a revisar. `opts.logo` por defecto el del perfil.
 */
export async function comprobarArchivos(
  lic: Licitacion, ctx: ContextoLicitacion, rev: Revision, deps: DepsEmision, senal: AbortSignal,
  opts: { logo?: string | null; onProgreso?: (p: ProgresoEmision) => void } = {},
): Promise<Record<string, RevisionArchivo>> {
  const base = deps.base !== undefined ? deps.base : baseSupabase();
  const exp = deps.resolverExpediente(lic, ctx, rev);
  const doc = deps.resolverDocumento(lic, ctx, rev);
  const logo = opts.logo !== undefined ? opts.logo : empresaConDefectos(ctx.perfil).logo;
  const usos: UsoUrl[] = [...usosDeDocumento(doc, base), ...exp.bloques.flatMap((b) => usosDeBloque(b, base))];
  if (logo && String(logo).trim()) usos.push({ url: String(logo).trim(), uso: "imagen", itemId: "logo", origen: origenArchivo(String(logo).trim(), base) });

  // Una URL que se use como documento en algún sitio se revisa como documento (un PDF vale ahí).
  const porUrl = new Map<string, { uso: Uso; origen: OrigenArchivo }>();
  for (const u of usos) {
    const prev = porUrl.get(u.url);
    porUrl.set(u.url, { uso: prev?.uso === "documento" || u.uso === "documento" ? "documento" : "imagen", origen: prev?.origen ?? u.origen });
  }
  const salida: Record<string, RevisionArchivo> = {};
  const pendientes: string[] = [];
  for (const [url, u] of porUrl) {
    if (u.origen === "vacio") continue;
    if (!bajable(u.origen)) salida[url] = rechazo(url, "archivo_externo", EXTERNO_DETALLE);
    else pendientes.push(url);
  }
  const avisar = (hecho: number, detalle: string) => { try { opts.onProgreso?.({ fase: "comprobando", hecho, total: pendientes.length, detalle }); } catch { /* la pantalla no tumba el ensayo */ } };
  avisar(0, "Firmando los enlaces…");
  const firmados = await firmarLote(pendientes, deps);
  let hecho = 0;
  await enParalelo(pendientes, CONCURRENCIA_DESCARGAS, async (url) => {
    try {
      const b = await bajarFuente(url, firmados.get(url) ?? url, deps, senal);
      if (!b.ok) { salida[url] = b.rev; return; }
      const sha256 = await sha256Hex(b.bytes);
      const c = await clasificar(url, b.bytes, porUrl.get(url)!.uso, deps);
      if (!c.ok) { salida[url] = c.rev; return; }
      if (c.formato === "pdf") {
        const r = await revisarPdf(c.bytes);
        salida[url] = r.ok
          ? { url, ok: true, formato: "pdf", paginas: r.paginas, bytes: b.bytes.length, sha256 }
          : rechazo(url, r.codigo, r.detalle);
      } else if (await imagenLegible(c.bytes, c.formato)) {
        salida[url] = { url, ok: true, formato: c.formato, paginas: null, bytes: b.bytes.length, sha256 };
      } else {
        salida[url] = rechazo(url, "archivo_formato_no_soportado", "Dice ser una imagen pero no se pudo leer (dañada o de un tipo que el PDF no incrusta). Vuelve a exportarla como JPG o PNG.");
      }
    } catch (e) {
      if (e instanceof Cancelada) return; // se corta: queda sin revisar
      salida[url] = rechazo(url, "archivo_no_descargable", `No se pudo revisar (${String((e as Error)?.message ?? e).slice(0, 160)}).`);
    } finally {
      hecho++;
      avisar(hecho, `Revisados ${hecho} de ${pendientes.length}`);
    }
  }, senal);
  return salida;
}

// ══ Almacenamiento y registro ═══════════════════════════════════════════════════

function explicarSubida(e: unknown): string {
  const err = e as { message?: string; statusCode?: string | number; status?: number; error?: string } | null;
  const m = String(err?.message ?? err?.error ?? e ?? "");
  const st = String(err?.statusCode ?? err?.status ?? "");
  if (/bucket not found/i.test(m)) return "Falta el almacenamiento «licitaciones»: corre supabase/licitaciones-03-bucket.sql en Supabase → SQL Editor.";
  if (/already exists|duplicate/i.test(m) || st === "409") return "Ya hay un archivo en esa ruta: lo emitido no se sobrescribe, así que esta copia no se subió.";
  if (/row-level security|unauthorized|permission|not allowed/i.test(m) || st === "403" || st === "401") return "Tu usuario no tiene permiso de subir al almacenamiento «licitaciones» (módulo Licitaciones).";
  if (/exceeded the maximum|too large|payload too large|entity too large/i.test(m) || st === "413") return "Pesa más de lo que acepta el almacenamiento: no se subió la copia.";
  if (/mime type|not supported|invalid_mime/i.test(m) || st === "415") return "El almacenamiento no acepta ese tipo de archivo (falta en allowed_mime_types de licitaciones-03-bucket.sql).";
  if (/fetch|network|failed to fetch|load failed|timeout/i.test(m)) return "No hay conexión con el almacenamiento: la copia no se subió.";
  return `El almacenamiento rechazó la copia${m ? ` (${m.slice(0, 160)})` : ""}.`;
}

/** El almacenamiento por defecto: `db.storage` (upload SIN upsert + getPublicUrl). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function storageDeDb(db: any): StorageEmision {
  return {
    async subir(bucket, ruta, bytes, contentType) {
      try {
        const { error } = await db.storage.from(bucket).upload(ruta, bytes, { upsert: false, contentType, cacheControl: "3600" });
        if (error) return { error: explicarSubida(error), url: null };
        const url = String(db.storage.from(bucket).getPublicUrl(ruta)?.data?.publicUrl ?? "");
        return url ? { error: null, url } : { error: "Se subió pero no se pudo obtener su enlace.", url: null };
      } catch (e) {
        return { error: explicarSubida(e), url: null };
      }
    },
  };
}

function explicarRegistro(e: unknown): string {
  const err = e as { message?: string; code?: string; details?: string } | null;
  const m = String(err?.message ?? e ?? "");
  const code = String(err?.code ?? "");
  if (code === "42P01" || code === "PGRST205" || /relation .*licitacion_emisiones.* does not exist|could not find the table/i.test(m)) {
    return "Falta la tabla de emisiones: corre supabase/licitaciones-01a-tablas.sql y licitaciones-01b-rls.sql en Supabase → SQL Editor.";
  }
  if (code === "42501" || /row-level security|permission denied/i.test(m)) return "Tu usuario no tiene permiso de registrar emisiones (módulo Licitaciones).";
  if (code === "23514") return /foto/i.test(m) ? "La foto de la emisión pesa más de lo que admite la tabla (6 MB)." : `Un dato de la emisión no cumple una regla de la tabla (${m.slice(0, 160)}).`;
  if (code === "23503") return "La licitación ya no existe (o tu usuario no está en la tabla de usuarios).";
  if (code === "23505") return "Ya hay una emisión registrada con esa carpeta o esa versión.";
  if (/fetch|network|failed to fetch|load failed/i.test(m)) return "No hay conexión con la base.";
  return `La base rechazó el registro${m ? ` (${m.slice(0, 200)})` : ""}.`;
}

const esChoqueDeVersion = (e: unknown) => {
  const err = e as { code?: string; message?: string; details?: string } | null;
  return String(err?.code ?? "") === "23505" && /uq_licitacion_emisiones_version|\(licitacion_id, ?version\)/i.test(`${err?.message ?? ""} ${err?.details ?? ""}`);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function siguienteVersion(db: any, licId: number): Promise<{ ok: true; version: number } | { ok: false; detalle: string }> {
  try {
    const { data, error } = await db.from("licitacion_emisiones").select("version").eq("licitacion_id", licId)
      .order("version", { ascending: false }).limit(1);
    if (error) return { ok: false, detalle: `No se pudo leer la última versión emitida: ${explicarRegistro(error)}` };
    const v = Number((data ?? [])[0]?.version);
    return { ok: true, version: Number.isSafeInteger(v) && v >= 1 ? v + 1 : 1 };
  } catch (e) {
    return { ok: false, detalle: `No se pudo leer la última versión emitida: ${explicarRegistro(e)}` };
  }
}

/**
 * Registra la emisión (INSERT). NO manda emitido_por ni emitido_en (los sella el trigger). La `version` que
 * se manda (la mayor + 1, leída ahora) es solo una PROPUESTA: la base puede asignar la suya (el trigger
 * BEFORE INSERT pone max + 1 ignorando la del cliente), así que la fila devuelta MANDA y nada de aquí en
 * adelante depende de que coincidan. Un choque en uq_licitacion_emisiones_version (dos emisiones a la vez)
 * se reintenta UNA vez; cualquier otro error, no (un INSERT reintentado a ciegas duplica). Si no se puede
 * leer la última versión no se inserta (una lectura fallida no es «no hay emisiones»). Sirve también para
 * reintentar un registro fallido.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registrarEmision(db: any, nueva: EmisionNueva): Promise<{ ok: true; fila: FilaEmision } | { ok: false; detalle: string }> {
  for (let intento = 0; intento < 2; intento++) {
    const v = await siguienteVersion(db, nueva.licitacion_id);
    if (!v.ok) return v;
    const fila = {
      licitacion_id: nueva.licitacion_id, version: v.version, carpeta: nueva.carpeta, doc_version: nueva.doc_version,
      firma: nueva.firma, foto: nueva.foto, archivos: nueva.archivos, hallazgos: nueva.hallazgos, omitidos: nueva.omitidos, nota: nueva.nota,
    };
    let data: Record<string, unknown> | null = null;
    let error: unknown = null;
    try {
      const r = await db.from("licitacion_emisiones").insert(fila).select(COLUMNAS_FILA_EMISION.join(",")).single();
      data = r?.data ?? null;
      error = r?.error ?? null;
    } catch (e) { error = e; }
    if (error) {
      if (intento === 0 && esChoqueDeVersion(error)) continue;
      return { ok: false, detalle: explicarRegistro(error) };
    }
    let d: Record<string, unknown> = data ?? {};
    let version = Number(d.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      // Se insertó pero la respuesta no trae la versión: se relee la fila por su carpeta (única).
      try {
        const r = await db.from("licitacion_emisiones").select(COLUMNAS_FILA_EMISION.join(",")).eq("carpeta", nueva.carpeta).limit(1);
        const fila0 = (r?.data ?? [])[0] as Record<string, unknown> | undefined;
        if (fila0) { d = fila0; version = Number(fila0.version); }
      } catch { /* queda sin versión */ }
      if (!Number.isSafeInteger(version) || version < 1) {
        return { ok: false, detalle: "La emisión se registró pero la base no devolvió su versión: recarga la pantalla para verla en el historial (no la vuelvas a registrar)." };
      }
    }
    return {
      ok: true,
      fila: {
        id: Number(d.id), licitacion_id: Number(d.licitacion_id ?? nueva.licitacion_id), version,
        carpeta: String(d.carpeta ?? nueva.carpeta), emitido_por: String(d.emitido_por ?? ""), emitido_en: String(d.emitido_en ?? ""),
        doc_version: Number(d.doc_version ?? nueva.doc_version), firma: String(d.firma ?? nueva.firma),
        foto: nueva.foto, archivos: nueva.archivos, hallazgos: nueva.hallazgos, omitidos: nueva.omitidos, nota: nueva.nota,
      },
    };
  }
  return { ok: false, detalle: "Otra emisión de esta licitación se registró al mismo tiempo dos veces seguidas. Vuelve a intentar el registro." };
}

// ══ La emisión ══════════════════════════════════════════════════════════════════

type Armado = {
  b: BloqueExpedienteResuelto;
  bytes: Uint8Array | null;
  paginas: number;
  paginasPorParte: { itemId: string; paginas: number }[];
  /** Cuántas partes `propuesta` quedaron insertadas y con cuántas páginas cada una. */
  propPartes: number;
  propPaginas: number;
};

const blob = (partes: Uint8Array[], type: string) => new Blob(partes as unknown as BlobPart[], { type });

function uuidPorDefecto(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const esMemoria = (e: unknown) => e instanceof RangeError
  || /out of memory|allocation failed|array buffer allocation|invalid array length|invalid typed array length/i.test(String((e as Error)?.message ?? ""));

/** RevisionArchivo → CodigoHallazgo para `omitidos` (archivo_externo se nombra como el ítem externo). */
const codigoDeRevision = (r: Extract<RevisionArchivo, { ok: false }>): CodigoHallazgo =>
  r.codigo === "archivo_externo" ? "expediente_item_archivo_externo" : r.codigo;

/**
 * Sustituye las páginas de la parte `propuesta` dentro de un bloque YA armado por las de la propuesta
 * final. Las demás páginas se copian tal cual (es un PDF propio: no hace falta volver a bajar nada).
 */
async function sustituirPropuesta(a: Armado, propuesta: Uint8Array): Promise<Armado> {
  if (!a.bytes || !a.propPartes) return a;
  const viejo = await PDFDocument.load(a.bytes, { updateMetadata: false });
  const prop = await PDFDocument.load(propuesta, { updateMetadata: false });
  const nuevo = await PDFDocument.create();
  const titulo = viejo.getTitle();
  if (titulo) nuevo.setTitle(titulo);
  nuevo.setProducer("pdf-lib");
  const copiar = async (src: PDFDocument, idx: number[]) => {
    if (!idx.length) return;
    for (const p of await nuevo.copyPages(src, idx)) nuevo.addPage(p);
  };
  const rango = (desde: number, n: number) => Array.from({ length: n }, (_, i) => desde + i);
  const enPartes = a.paginasPorParte.reduce((s, x) => s + x.paginas, 0);
  const portada = Math.max(0, a.paginas - enPartes);
  await copiar(viejo, rango(0, portada));
  let cursor = portada;
  const ppp: { itemId: string; paginas: number }[] = [];
  const partes = a.b.partes ?? [];
  for (let k = 0; k < a.paginasPorParte.length; k++) {
    const n = a.paginasPorParte[k].paginas;
    if (partes[k]?.tipo === "propuesta" && n > 0) {
      await copiar(prop, prop.getPageIndices());
      ppp.push({ itemId: a.paginasPorParte[k].itemId, paginas: prop.getPageCount() });
    } else {
      await copiar(viejo, rango(cursor, n));
      ppp.push({ itemId: a.paginasPorParte[k].itemId, paginas: n });
    }
    cursor += n;
  }
  const bytes = await nuevo.save({ addDefaultPage: false });
  return { ...a, bytes, paginas: nuevo.getPageCount(), paginasPorParte: ppp, propPaginas: prop.getPageCount() };
}

/**
 * Emite la licitación. Ver la cabecera para el orden y las reglas. `onProgreso` recibe cada fase con
 * hecho/total; `senal` cancela entre pasos (y entre descargas y subidas) → `cancelada`. Las copias que
 * ya se subieron antes de cancelar quedan en su carpeta SIN registro (el bucket no deja borrar).
 */
export async function emitirLicitacion(
  lic: Licitacion, ctx: ContextoLicitacion, rev: Revision, opts: OpcionesEmision, deps: DepsEmision,
  onProgreso: (p: ProgresoEmision) => void, senal: AbortSignal, extra: ExtraEmision,
): Promise<ResultadoEmitir> {
  const avisos: string[] = [];
  const revisiones: Record<string, RevisionArchivo> = {};
  const estado = { carpeta: null as string | null, subidos: 0, archivos: [] as DescargaEmision[], emitidos: [] as ArchivoEmitido[], omitidos: [] as OmitidoEmision[] };
  const fallo = (codigo: Extract<ResultadoEmision, { ok: false }>["codigo"], detalle: string, pendiente: EmisionNueva | null = null): ResultadoEmitir => ({
    ok: false, codigo, detalle, archivos: estado.archivos, omitidos: estado.omitidos, avisos, carpeta: estado.carpeta,
    emitidos: estado.emitidos, revisiones, registroPendiente: pendiente,
  });

  // (1) Conflicto de versión: nada se baja, se sube ni se registra.
  if (extra.hayCambiosSinGuardar || lic.version !== extra.versionGuardada) {
    return fallo("conflicto_version", extra.hayCambiosSinGuardar
      ? "Hay cambios sin guardar: guarda la licitación antes de emitir (se emite exactamente lo guardado)."
      : `La licitación cambió (versión ${lic.version} en pantalla, ${extra.versionGuardada} guardada): recarga y vuelve a emitir.`);
  }
  if (!opts.propuesta && !opts.bloques && !opts.completo) return fallo("sin_nada_que_emitir", "Marca al menos la propuesta, los bloques o el expediente completo.");

  try {
    return await emitirInterno(lic, ctx, rev, opts, deps, onProgreso, senal, extra, avisos, revisiones, estado, fallo);
  } catch (e) {
    if (e instanceof Cancelada || senal.aborted) {
      return fallo("cancelada", estado.subidos
        ? `Se canceló la emisión. ${estado.subidos} copia(s) ya se habían subido a su carpeta y quedan ahí sin registro (lo emitido no se borra).`
        : "Se canceló la emisión: no se subió ni se registró nada.");
    }
    if (esMemoria(e)) {
      return fallo("memoria", "El navegador se quedó sin memoria armando el expediente. Emite por bloques: desmarca «Expediente completo» y el ZIP, o emite unos bloques primero y los demás después (cierra otras pestañas pesadas).");
    }
    throw e;
  }
}

async function emitirInterno(
  lic: Licitacion, ctx: ContextoLicitacion, rev: Revision, opts: OpcionesEmision, deps: DepsEmision,
  onProgreso: (p: ProgresoEmision) => void, senal: AbortSignal, extra: ExtraEmision,
  avisos: string[], revisiones: Record<string, RevisionArchivo>,
  estado: { carpeta: string | null; subidos: number; archivos: DescargaEmision[]; emitidos: ArchivoEmitido[]; omitidos: OmitidoEmision[] },
  fallo: (codigo: Extract<ResultadoEmision, { ok: false }>["codigo"], detalle: string, pendiente?: EmisionNueva | null) => ResultadoEmitir,
): Promise<ResultadoEmitir> {
  const base = deps.base !== undefined ? deps.base : baseSupabase();
  const ahora = deps.ahora ?? (() => new Date());
  const progreso = (fase: FaseEmision, hecho: number, total: number, detalle: string) => {
    try { onProgreso({ fase, hecho, total, detalle }); } catch { /* la pantalla no tumba la emisión */ }
  };
  const seguir = () => { if (senal.aborted) throw new Cancelada(); };
  const foliado = lic.doc.expediente.foliado;
  const foliando = foliado.modo !== "ninguno";
  const propuestaPrimero = lic.doc.expediente.propuestaEnCompleto === "primero";

  // ── Resolver y planear ──
  progreso("comprobando", 0, 1, "Preparando lo que se va a emitir…");
  const exp = deps.resolverExpediente(lic, ctx, rev);
  const doc0 = deps.resolverDocumento(lic, ctx, rev);
  const bloques = exp.bloques ?? [];
  const conPropuesta = new Set(bloques.filter((b) => (b.partes ?? []).some((p) => p.tipo === "propuesta")).map((b) => b.id));
  const emitirBloques = opts.bloques || opts.completo;
  const armarBloques = bloques.length > 0 && (emitirBloques || (opts.propuesta && foliando && docTieneRelacionAdjuntos(lic.doc)));
  const necesitaPropuesta = opts.propuesta || (opts.completo && propuestaPrimero)
    || (emitirBloques && conPropuesta.size > 0) || (armarBloques && propuestaPrimero && foliando);
  if (!necesitaPropuesta && !(emitirBloques && bloques.length)) {
    return fallo("sin_nada_que_emitir", "El expediente no tiene bloques activos y no se pidió la propuesta: no hay nada que emitir.");
  }
  if (propuestaPrimero && opts.completo && conPropuesta.size) {
    avisos.push("La propuesta técnica va dos veces en el expediente completo: primero y dentro de un bloque. Revisa la estructura si no es lo que quieres.");
  }

  // ── Quién usa cada URL ──
  const usosProp = necesitaPropuesta ? usosDeDocumento(doc0, base) : [];
  const logoUrl = String(extra.logo ?? "").trim();
  const usosLogo: UsoUrl[] = logoUrl ? [{ url: logoUrl, uso: "imagen", itemId: "logo", origen: origenArchivo(logoUrl, base) }] : [];
  const usosPorBloque = armarBloques ? bloques.map((b) => usosDeBloque(b, base)) : bloques.map(() => [] as UsoUrl[]);
  const todos: UsoUrl[] = [...usosLogo, ...usosProp, ...usosPorBloque.flat()];
  const permanentes = new Set([...usosLogo, ...usosProp].map((u) => u.url));
  const restantes = new Map<string, number>(); // bloques que todavía la necesitan
  usosPorBloque.forEach((us) => { for (const url of new Set(us.map((u) => u.url))) restantes.set(url, (restantes.get(url) ?? 0) + 1); });
  const usoDe = new Map<string, Uso>();
  for (const u of todos) usoDe.set(u.url, usoDe.get(u.url) === "documento" || u.uso === "documento" ? "documento" : "imagen");
  for (const u of todos) if (!bajable(u.origen) && u.origen !== "vacio") revisiones[u.url] = rechazo(u.url, "archivo_externo", EXTERNO_DETALLE);
  const aBajar = [...new Set(todos.filter((u) => bajable(u.origen)).map((u) => u.url))];
  progreso("comprobando", 1, 1, `${aBajar.length} archivo(s) por bajar`);

  // ── Descargas (una vez por URL; los bytes se sueltan al último uso) ──
  const cache = new Map<string, Bajado>();
  let bajados = 0;
  const asegurar = async (urls: string[]) => {
    const faltan = [...new Set(urls)].filter((u) => !revisiones[u] || (revisiones[u].ok && !cache.get(u)?.bytes));
    if (!faltan.length) return;
    const firmados = await firmarLote(faltan, deps);
    await enParalelo(faltan, CONCURRENCIA_DESCARGAS, async (url) => {
      const b = await bajarFuente(url, firmados.get(url) ?? url, deps, senal);
      bajados++;
      progreso("bajando", Math.min(bajados, aBajar.length), aBajar.length, `Bajados ${Math.min(bajados, aBajar.length)} de ${aBajar.length}`);
      if (!b.ok) { revisiones[url] = b.rev; cache.set(url, { rev: b.rev, bytes: null, formato: null }); return; }
      const sha256 = await sha256Hex(b.bytes);
      const antes = extra.revisiones?.[url];
      if (antes?.ok && antes.sha256 && antes.sha256 !== sha256) avisos.push(`Un archivo cambió entre la comprobación y la emisión (se emitió la versión nueva): ${url.split("/").pop()}`);
      const c = await clasificar(url, b.bytes, usoDe.get(url) ?? "documento", deps);
      if (!c.ok) { revisiones[url] = c.rev; cache.set(url, { rev: c.rev, bytes: null, formato: null }); return; }
      const r: RevisionArchivo = { url, ok: true, formato: c.formato, paginas: null, bytes: b.bytes.length, sha256 };
      revisiones[url] = r;
      cache.set(url, { rev: r, bytes: c.bytes, formato: c.formato });
    }, senal);
    seguir();
  };
  const imagenDe = (url: string | null | undefined): ImagenPdf | null => {
    const c = url ? cache.get(String(url).trim()) : undefined;
    return c?.bytes && (c.formato === "png" || c.formato === "jpg") ? { bytes: c.bytes, tipo: c.formato } : null;
  };

  // ── Logo e imágenes de la propuesta ──
  await asegurar([...permanentes]);
  const logo = imagenDe(logoUrl);
  if (logoUrl && !logo) avisos.push(`El logo no se pudo usar (${revisiones[logoUrl] && !revisiones[logoUrl].ok ? (revisiones[logoUrl] as { detalle: string }).detalle : "no se bajó"}): los PDF salen sin logo.`);

  const dibujar = async (doc: DocumentoResuelto): Promise<ResultadoPropuesta> => {
    const imagenes: Record<string, ImagenPdf | null> = {};
    for (const u of usosDeDocumento(doc, base)) imagenes[u.url] = imagenDe(u.url);
    return dibujarPropuesta({ doc, imagenes, logo, firma: imagenDe(doc.firmante?.firmaUrl) });
  };
  let P: ResultadoPropuesta | null = null;
  let documento = doc0;
  if (necesitaPropuesta) {
    progreso("armando_propuesta", 0, 1, "Armando la propuesta técnica…");
    P = await dibujar(doc0);
    progreso("armando_propuesta", 1, 1, `Propuesta: ${P.paginas} página(s)`);
    seguir();
  }
  const P0 = P;

  // ── Bloques, de a uno ──
  const armados: Armado[] = [];
  if (armarBloques) {
    for (let i = 0; i < bloques.length; i++) {
      const b = bloques[i];
      progreso("armando_bloques", i, bloques.length, `Bloque ${i + 1} de ${bloques.length}: ${b.separador?.titulo || b.separador?.subtitulo || "sin título"}`);
      const us = usosPorBloque[i];
      await asegurar(us.filter((u) => bajable(u.origen)).map((u) => u.url));
      const archivos: Record<string, ArchivoBajado | null> = {};
      const imagenes: Record<string, ImagenPdf | null> = {};
      for (const u of us) {
        const c = cache.get(u.url);
        if (u.uso === "documento") archivos[u.url] = c?.bytes && c.formato ? { bytes: c.bytes, formato: c.formato } : null;
        else imagenes[u.url] = imagenDe(u.url);
      }
      const comun: ComunBloque = {
        cabecera: exp.cabecera, color: exp.color, logo, firma: imagenDe(documento.firmante?.firmaUrl),
        archivos, imagenes, propuesta: P?.bytes ?? null,
      };
      const r = await armarBloque(b, comun);
      // Lo que no bajó o no sirvió se nombra con SU motivo, no con el genérico de armarBloque.
      for (const o of r.omitidos) {
        const rv = o.url ? revisiones[o.url] : undefined;
        if (o.codigo === "archivo_no_descargable" && rv && !rv.ok) { o.codigo = codigoDeRevision(rv); o.detalle = rv.detalle; }
      }
      // Lo que armarBloque descubrió al leer un PDF (cifrado, ilegible) queda en la revisión del archivo.
      (b.partes ?? []).forEach((p, k) => {
        if (p.tipo !== "archivo" || !p.url) return;
        const rv = revisiones[p.url];
        const om = r.omitidos.find((o) => o.itemId === p.itemId && o.url === p.url);
        if (rv?.ok && om && (om.codigo === "pdf_protegido" || om.codigo === "pdf_ilegible" || om.codigo === "archivo_formato_no_soportado")) {
          revisiones[p.url] = rechazo(p.url, om.codigo, om.detalle);
        } else if (rv?.ok && rv.formato === "pdf" && rv.paginas == null && !om) {
          revisiones[p.url] = { ...rv, paginas: r.paginasPorParte[k]?.paginas ?? null };
        }
      });
      estado.omitidos.push(...r.omitidos);
      avisos.push(...r.avisos);
      const propIdx = (b.partes ?? []).map((p, k) => (p.tipo === "propuesta" && (r.paginasPorParte[k]?.paginas ?? 0) > 0 ? k : -1)).filter((k) => k >= 0);
      armados.push({
        b, bytes: r.paginas > 0 ? r.bytes : null, paginas: r.paginas, paginasPorParte: r.paginasPorParte,
        propPartes: propIdx.length, propPaginas: propIdx.length && P ? P.paginas : 0,
      });
      if (r.paginas === 0 && emitirBloques) avisos.push(`El bloque «${b.separador?.titulo || b.separador?.subtitulo || b.id}» quedó sin páginas (sin portada y todo se omitió): no se emite.`);
      // Soltar los bytes que ya ningún bloque necesita.
      for (const url of new Set(us.map((u) => u.url))) {
        const n = (restantes.get(url) ?? 1) - 1;
        restantes.set(url, n);
        if (n <= 0 && !permanentes.has(url)) { const c = cache.get(url); if (c) c.bytes = null; }
      }
      progreso("armando_bloques", i + 1, bloques.length, `Bloque ${i + 1} de ${bloques.length} listo (${r.paginas} página(s))`);
      seguir();
    }
  }

  // ── Folios y las dos pasadas de la propuesta ──
  // La propuesta entra al mapa si va primero en el completo: así el folio de cada bloque (suelto, en el
  // completo y en la relación de adjuntos) es el mismo número, se emita o no el completo.
  const enMapa = propuestaPrimero && P != null;
  const hayMapa = armarBloques || enMapa;
  const mapaCon = (pPaginas: number): MapaFolios => mapaFolios(
    [...(enMapa ? [pPaginas] : []), ...armados.map((a) => a.paginas + a.propPartes * (pPaginas - a.propPaginas))],
    foliado,
    { paginasPortada: [...(enMapa ? [true] : []), ...armados.map((a) => a.b.conPortada)] },
  );
  const off = enMapa ? 1 : 0;
  const foliosDe = (m: MapaFolios): FoliosPorBloque => {
    const out: FoliosPorBloque = {};
    armados.forEach((a, i) => { out[a.b.id] = m.porBloque[i + off] ?? { desde: 0, hasta: 0 }; });
    return out;
  };
  if (armarBloques && foliando) {
    if (P) {
      let previo = P;
      let consistente = false;
      for (let intento = 0; intento < 2 && !consistente; intento++) {
        progreso("armando_propuesta", intento, 2, intento ? "Recalculando los folios de la propuesta…" : "Poniendo los folios en la propuesta…");
        documento = deps.resolverDocumento(lic, ctx, rev, { folios: foliosDe(mapaCon(previo.paginas)) });
        const nueva = await dibujar(documento);
        consistente = nueva.paginas === previo.paginas;
        previo = nueva;
        seguir();
      }
      if (!consistente) avisos.push("Al meter los folios la propuesta cambió de número de páginas dos veces: los folios de la «relación de adjuntos» pueden estar corridos. Los folios impresos en cada hoja sí son los reales.");
      P = previo;
    } else {
      documento = deps.resolverDocumento(lic, ctx, rev, { folios: foliosDe(mapaCon(0)) });
    }
  }
  if (P) avisos.push(...P.recortes);
  // La propuesta final reemplaza a P0 dentro de los bloques que la llevan (si cambió).
  if (P && P !== P0) {
    for (let i = 0; i < armados.length; i++) {
      if (armados[i].propPartes) { armados[i] = await sustituirPropuesta(armados[i], P.bytes); seguir(); }
    }
  }
  const mapa: MapaFolios | null = hayMapa ? mapaCon(P?.paginas ?? 0) : null;

  // ── Foliar ── (los sueltos y el completo con el MISMO mapa: no pueden discrepar)
  type Pieza = { nombreBase: string; tipo: TipoArchivoEmitido; bloqueId: string | null; bytes: Uint8Array; paginas: number; folios: { desde: number; hasta: number } | null };
  const piezas: Pieza[] = [];
  const conRango = (r: { desde: number; hasta: number } | undefined) => (r && r.desde && r.hasta ? { desde: r.desde, hasta: r.hasta } : null);
  const llevaFolio = (fs: (number | null)[] | null): fs is (number | null)[] => foliando && !!fs && fs.some((f) => f != null);
  const totalFoliar = (opts.propuesta && P ? 1 : 0) + (opts.bloques ? armados.filter((a) => a.bytes).length : 0) + (opts.completo ? 1 : 0);
  let foliados = 0;
  const avanzaFolio = (detalle: string) => { foliados++; progreso("foliando", Math.min(foliados, totalFoliar), totalFoliar, detalle); };
  progreso("foliando", 0, totalFoliar, "Foliando…");

  const folioProp = enMapa && mapa ? mapa.foliosDeBloque(0) : null;
  let propFoliada: Uint8Array | null = null;
  if (P && llevaFolio(folioProp) && ((opts.propuesta && foliado.foliarBloquesSueltos) || opts.completo)) propFoliada = await foliar(P.bytes, folioProp, foliado);
  if (opts.propuesta && P) {
    const conFolio = foliado.foliarBloquesSueltos && propFoliada != null;
    piezas.push({ nombreBase: "00 Propuesta tecnica", tipo: "propuesta", bloqueId: null, bytes: conFolio ? propFoliada! : P.bytes, paginas: P.paginas, folios: conFolio && mapa ? conRango(mapa.porBloque[0]) : null });
    avanzaFolio("Propuesta lista");
    seguir();
  }
  const partesCompleto: Uint8Array[] = [];
  let paginasCompleto = 0;
  if (opts.completo && enMapa && P) { partesCompleto.push(propFoliada ?? P.bytes); paginasCompleto += P.paginas; }
  propFoliada = null;
  for (let i = 0; i < armados.length; i++) {
    const a = armados[i];
    if (!a.bytes || !emitirBloques) continue;
    const folios = mapa ? mapa.foliosDeBloque(i + off) : null;
    const hace = llevaFolio(folios) && (opts.completo || (opts.bloques && foliado.foliarBloquesSueltos));
    const conFolio = hace ? await foliar(a.bytes, folios!, foliado) : a.bytes;
    if (opts.completo) { partesCompleto.push(conFolio); paginasCompleto += a.paginas; }
    if (opts.bloques) {
      const foliadoSuelto = foliado.foliarBloquesSueltos && hace;
      const s = a.b.separador;
      piezas.push({
        nombreBase: `${String(i + 1).padStart(2, "0")} ${[s?.titulo, s?.subtitulo].filter((x) => String(x ?? "").trim()).join(" ") || "Bloque"}`,
        tipo: "bloque", bloqueId: a.b.id, bytes: foliadoSuelto ? conFolio : a.bytes, paginas: a.paginas,
        folios: foliadoSuelto && mapa ? conRango(mapa.porBloque[i + off]) : null,
      });
      avanzaFolio(`Bloque ${i + 1} listo`);
    }
    armados[i] = { ...a, bytes: null }; // ya está en las piezas o en el completo
    seguir();
  }
  if (opts.completo) {
    if (partesCompleto.length) {
      const bytes = await unirPdfs(partesCompleto);
      partesCompleto.length = 0;
      const todos_ = mapa?.todos.filter((f): f is number => f != null) ?? [];
      piezas.push({
        nombreBase: "Expediente completo", tipo: "expediente_completo", bloqueId: null, bytes, paginas: paginasCompleto,
        folios: foliando && todos_.length ? { desde: todos_[0], hasta: todos_[todos_.length - 1] } : null,
      });
      avanzaFolio("Expediente completo unido");
    } else avisos.push("El expediente completo no tiene páginas (ningún bloque salió y la propuesta no va primero): no se emite.");
    seguir();
  }
  if (!piezas.length) return fallo("sin_nada_que_emitir", "Todo lo pedido salió sin páginas: no hay nada que emitir. Revisa los bloques y la propuesta.");

  // ── Nombres, sha256, empaque ──
  progreso("empacando", 0, 1, "Empacando…");
  const nombres = nombresUnicos(piezas.map((p) => nombreArchivoEmitido(p.nombreBase, "pdf")));
  const emitidos: ArchivoEmitido[] = [];
  for (let k = 0; k < piezas.length; k++) {
    const p = piezas[k];
    emitidos.push({ nombre: nombres[k], tipo: p.tipo, bloqueId: p.bloqueId, bytes: p.bytes.length, paginas: p.paginas, sha256: await sha256Hex(p.bytes), url: null, motivoNoSubido: null, folios: p.folios });
  }
  const sueltos = () => piezas.map((p, k) => ({ nombre: nombres[k], blob: blob([p.bytes], "application/pdf") }));
  let descargas: DescargaEmision[] | null = null;
  let zipEmitido: ArchivoEmitido | null = null;
  if (opts.empaque === "zip") {
    try {
      const nombreZip = nombreArchivoEmitido(`Licitacion ${lic.codigo || lic.nombre || lic.id}`, "zip");
      const fecha = ahora();
      const z = armarZip(piezas.map((p, k) => ({ nombre: nombres[k], bytes: p.bytes, fecha })));
      zipEmitido = { nombre: nombreZip, tipo: "zip", bloqueId: null, bytes: z.bytes, paginas: null, sha256: sha256DePartes(z.partes), url: null, motivoNoSubido: "Es el empaque de los mismos PDF que sí se suben: no se sube dos veces (su sha256 queda registrado).", folios: null };
      descargas = [{ nombre: nombreZip, blob: blob(z.partes, "application/zip") }];
    } catch (e) {
      avisos.push(`No se pudo armar el ZIP (${String((e as Error)?.message ?? e).slice(0, 160)}): se entregan los archivos sueltos.`);
    }
  }
  if (!descargas) descargas = sueltos();
  estado.archivos = descargas;
  progreso("empacando", 1, 1, opts.empaque === "zip" && zipEmitido ? "ZIP listo" : `${descargas.length} archivo(s) listos`);
  seguir();

  // ── Subida de las copias ──
  const carpeta = (deps.uuid ?? uuidPorDefecto)();
  estado.carpeta = carpeta;
  estado.emitidos = [...emitidos, ...(zipEmitido ? [zipEmitido] : [])];
  if (opts.subirCopias) {
    const almacen = deps.storage ?? storageDeDb(deps.db);
    for (let k = 0; k < piezas.length; k++) {
      const e = emitidos[k];
      progreso("subiendo", k, piezas.length, `Subiendo ${e.nombre}…`);
      seguir();
      const d = debeSubir(piezas[k].bytes, deps.topes?.subida ?? TOPES_DOC.maxBytesArchivo);
      if (!d.sube) { e.motivoNoSubido = d.motivo; continue; }
      let ruta: string;
      try { ruta = rutaEmision(lic.id, carpeta, e.nombre); }
      catch (err) { e.motivoNoSubido = `No se pudo armar su ruta (${String((err as Error)?.message ?? err)}).`; continue; }
      const r = await almacen.subir(BUCKET_LICITACIONES, ruta, piezas[k].bytes, "application/pdf").catch((err: unknown) => ({ error: explicarSubida(err), url: null }));
      if (r.error || !r.url) { e.motivoNoSubido = r.error || "El almacenamiento no devolvió el enlace."; continue; }
      const obj = objetoPrivadoDe(r.url, base);
      if (!obj || obj.bucket !== BUCKET_LICITACIONES || obj.ruta !== ruta) {
        e.motivoNoSubido = "Se subió, pero el enlace que devolvió el almacenamiento no apunta a esa copia: no se guarda (no se podría volver a abrir).";
        estado.subidos++;
        continue;
      }
      e.url = r.url;
      estado.subidos++;
    }
    progreso("subiendo", piezas.length, piezas.length, `${estado.subidos} de ${piezas.length} copia(s) subidas`);
  } else {
    for (const e of emitidos) e.motivoNoSubido = "No se pidió subir las copias.";
  }
  if (zipEmitido && !opts.subirCopias) zipEmitido.motivoNoSubido = "No se pidió subir las copias.";
  piezas.length = 0;
  seguir();

  // ── Registro ──
  progreso("registrando", 0, 1, "Registrando la emisión…");
  const peso = pesoFuentes(revisiones);
  if (peso > TOPE_FUENTES_BYTES) avisos.push(`Las fuentes suman ${mb(peso)} y el tope declarado es ${mb(TOPE_FUENTES_BYTES)}: si el navegador se pone lento o se queda sin memoria, emite por bloques.`);
  const revFinal = deps.revisarLicitacion ? deps.revisarLicitacion(lic, ctx, revisiones, extra.ultima ?? null) : rev;
  const aceptados = extra.aceptados ?? [];
  const hallazgos = hallazgosParaEmision(revFinal, aceptados);
  const empresa = empresaConDefectos(ctx.perfil);
  const fuentes: FotoEmision["fuentes"] = [];
  const vistos = new Set<string>();
  for (const u of todos) {
    const k = `${u.itemId}|${u.url}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    const r = revisiones[u.url];
    fuentes.push({ itemId: u.itemId, url: u.url, sha256: r?.ok ? r.sha256 : null, bytes: r?.ok ? r.bytes : 0, paginas: r?.ok ? r.paginas : null });
  }
  const { doc: _doc, ...licSinDoc } = lic;
  void _doc;
  const foto: FotoEmision = {
    licitacion: licSinDoc, doc: lic.doc, documento, expediente: exp, fuentes,
    empresa: { nombre: empresa.nombre, razonSocial: empresa.razonSocial, ruc: empresa.ruc, direccion: empresa.direccion, autorizacion: empresa.autorizacion },
    hoy: ctx.hoy,
  };
  const nueva: EmisionNueva = {
    licitacion_id: lic.id, carpeta, doc_version: lic.version, firma: await firmaDeFoto(foto), foto,
    archivos: estado.emitidos, hallazgos, omitidos: estado.omitidos, nota: extra.nota ? String(extra.nota).slice(0, 2000) : null,
  };
  const reg = await registrarEmision(deps.db, nueva);
  if (!reg.ok) {
    return fallo("registro_fallido", `${reg.detalle} Los archivos se armaron igual: descárgalos y reintenta el registro.`, nueva);
  }
  progreso("registrando", 1, 1, `Emisión versión ${reg.fila.version} registrada`);
  progreso("listo", 1, 1, "Listo");
  return { ok: true, emision: reg.fila, archivos: descargas, omitidos: estado.omitidos, avisos, carpeta, emitidos: estado.emitidos, revisiones };
}

// ══ Lo del navegador (la pantalla de emisión) ═══════════════════════════════════

/** Baja una URL con fetch respetando el tope de bytes (por content-length y leyendo por trozos). */
export async function descargarConFetch(url: string, tope: number, senal: AbortSignal): Promise<Uint8Array> {
  let res: Response;
  try { res = await fetch(url, { signal: senal, cache: "no-store", credentials: "omit" }); }
  catch (e) { throw new ErrorDescarga("red", String((e as Error)?.message ?? e)); }
  if (!res.ok) throw new ErrorDescarga("http", `el servidor respondió ${res.status}`, res.status);
  const largo = Number(res.headers.get("content-length"));
  if (Number.isFinite(largo) && largo > tope) throw new ErrorDescarga("demasiado_grande", `pesa ${largo} bytes`);
  if (!res.body) {
    const b = new Uint8Array(await res.arrayBuffer());
    if (b.length > tope) throw new ErrorDescarga("demasiado_grande", `pesa ${b.length} bytes`);
    return b;
  }
  const lector = res.body.getReader();
  const trozos: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.length;
    if (total > tope) { try { await lector.cancel(); } catch { /* ya se corta */ } throw new ErrorDescarga("demasiado_grande", `pasa de ${tope} bytes`); }
    trozos.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const t of trozos) { out.set(t, o); o += t.length; }
  return out;
}

/** WEBP → JPEG con el canvas del navegador (fondo blanco). null si no hay canvas o no se pudo. */
export async function webpAJpegCanvas(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    if (typeof createImageBitmap !== "function") return null;
    const bmp = await createImageBitmap(blob([bytes], "image/webp"));
    const s = Math.min(1, LADO_MAX_CONVERSION / Math.max(1, bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
    let salida: Blob | null = null;
    if (typeof OffscreenCanvas !== "undefined") {
      const c = new OffscreenCanvas(w, h);
      const g = c.getContext("2d");
      if (!g) return null;
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
      salida = await c.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    } else if (typeof document !== "undefined") {
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const g = c.getContext("2d");
      if (!g) return null;
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
      salida = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", 0.9));
    }
    try { bmp.close(); } catch { /* sin close */ }
    return salida ? new Uint8Array(await salida.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** Las dependencias de verdad para la pantalla: fetch, firmarUrls con el cliente, db.storage y el canvas. */
export function depsNavegador(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  r: { resolverDocumento: ResolverDocumento; resolverExpediente: ResolverExpediente; revisarLicitacion?: RevisarLicitacion },
): DepsEmision {
  return {
    db, storage: null, descargar: descargarConFetch,
    firmar: (urls) => firmarUrls(db as ClienteStorage, urls),
    resolverDocumento: r.resolverDocumento, resolverExpediente: r.resolverExpediente, revisarLicitacion: r.revisarLicitacion,
    webpAJpeg: webpAJpegCanvas,
  };
}

/** Las partes de un bloque resuelto que el expediente omitirá seguro (sin bajar nada): para la vista previa. */
export function partesSinArchivo(b: BloqueExpedienteResuelto): ParteFuente[] {
  return (b.partes ?? []).filter((p) => p.tipo === "faltante" || (p.tipo === "archivo" && !bajable(p.origen)));
}
