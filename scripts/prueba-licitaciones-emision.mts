// scripts/prueba-licitaciones-emision.mts — Matriz de lib/licitaciones/emitir.ts (la emisión de una licitación:
// comprobar archivos, bajar, armar la propuesta y los bloques, foliar, empacar, subir y registrar).
//   npx tsx scripts/prueba-licitaciones-emision.mts            (DETALLE=1 imprime los folios leídos)
//
// Corre la emisión ENTERA en node con la base, el almacenamiento, la descarga y los resolvedores FALSOS en
// memoria. Fija: el ciclo de identidad (el `url` guardado vuelve por objetoPrivadoDe EXACTAMENTE a la ruta
// subida); reemitir no pisa nada (otra carpeta; con la misma carpeta, el almacenamiento rechaza y no se
// reintenta en otra); el tope de subida; el conflicto de versión no baja, no sube ni registra; PDF
// protegido y enlace externo van a `omitidos` con su código; los folios ascendentes y descendentes son los
// MISMOS en el completo y en los bloques sueltos (lo lee pdftotext) y la relación de adjuntos de la
// propuesta imprime los rangos reales, también cuando meter los folios cambia sus páginas (dos pasadas);
// la firma es sha256 hex de 64 de canonico(foto); el INSERT va sin emitido_por/emitido_en; un choque de
// versión se reintenta UNA vez y uno de carpeta no; un registro fallido devuelve igual los archivos; la
// cancelación entre pasos; el RangeError → «memoria»; y los helpers puros (nombresUnicos, debeSubir,
// sha256 puro ≡ node:crypto, firmaDeFoto, hallazgosParaEmision).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import {
  comprobarArchivos, emitirLicitacion, registrarEmision, nombresUnicos, debeSubir, firmaDeFoto,
  sha256Puro, sha256Hex, sha256DePartes, Sha256, hallazgosParaEmision, pesoFuentes, docTieneRelacionAdjuntos,
  TOPE_FUENTES_BYTES, ErrorDescarga,
  type DepsEmision, type ExtraEmision, type FoliosPorBloque, type StorageEmision, type ResultadoEmitir,
} from "../lib/licitaciones/emitir";
import { textoRangoFolios } from "../lib/licitaciones/pdf/expediente";
import { objetoPrivadoDe } from "../lib/storage-privado";
import { canonico } from "../lib/json-canonico";
import { docVacio } from "../lib/licitaciones/normalizar";
import { TOPES_DOC } from "../lib/licitaciones/tipos";
import type {
  BloqueExpedienteResuelto, ContextoLicitacion, DocumentoResuelto, ExpedienteResuelto, FotoEmision, Hallazgo,
  Licitacion, OpcionesEmision, OpcionesFoliado, ProgresoEmision, Revision, RevisionArchivo,
} from "../lib/licitaciones/tipos";

let ok = 0, fallos = 0;
const check = (c: unknown, m: string) => { if (c) ok++; else { fallos++; console.log("  ✗", m); } };
const sec = (t: string) => console.log(`\n── ${t}`);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lic-emi-"));
const tiene = (bin: string) => { try { execFileSync("which", [bin], { stdio: "ignore" }); return true; } catch { return false; } };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ══ Fixtures ═══════════════════════════════════════════════════════════════════
const BASE = "https://proyecto.supabase.co";
const pub = (bucket: string, ruta: string) => `${BASE}/storage/v1/object/public/${bucket}/${encodeURI(ruta)}`;

function pdfAMano(objetos: string[], trailerExtra: string): Uint8Array {
  let s = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offs: number[] = [];
  objetos.forEach((o, i) => { offs.push(Buffer.byteLength(s, "latin1")); s += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(s, "latin1");
  s += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const o of offs) s += `${String(o).padStart(10, "0")} 00000 n \n`;
  s += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(s, "latin1"));
}
const PDF_PROTEGIDO = pdfAMano([
  "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>",
  "<< /Filter /Standard /V 1 /R 2 /Length 40 /O <28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A> /U <B5A4C8C0A9E2A3E9B6F4E4A8D2C3E1F0A9B8C7D6E5F4A3B2C1D0E9F8A7B6C5D4> /P -44 >>",
], "/Encrypt 4 0 R /ID [<0123456789ABCDEF0123456789ABCDEF> <0123456789ABCDEF0123456789ABCDEF>]");

async function pdfDePaginas(n: number, rotulo: string): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const p = d.addPage([595.28, 841.89]);
    p.drawText(`${rotulo} hoja ${i + 1}`, { x: 60, y: 760, size: 14, font: f });
  }
  return d.save();
}
const imagen = async (fmt: "png" | "jpeg" | "webp", w = 120, h = 80) =>
  new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: { r: 30, g: 90, b: 160 } } })[fmt]().toBuffer());

const PDF2 = await pdfDePaginas(2, "Ficha RUC");
const PDF3 = await pdfDePaginas(3, "Vigencia de poder");
const PNG = await imagen("png");
const JPG = await imagen("jpeg");
const WEBP = await imagen("webp");
const HEIC = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftypheic"), 0, 0, 0, 0, ...Buffer.from("mif1heic")]);
const BASURA = new Uint8Array(Buffer.from("esto no es un PDF ni una imagen"));

const U = {
  pdf2: pub("documentos", "legajo/ficha-ruc.pdf"),
  pdf3: pub("licitaciones", "adjuntos/7/11111111-1111-4111-8111-111111111111.pdf"),
  png: pub("licitaciones", "adjuntos/7/22222222-2222-4222-8222-222222222222.png"),
  jpg: pub("vehiculos-fotos", "unidad/abc.jpg"),
  webp: pub("vehiculos-fotos", "unidad/abc.webp"),
  heic: pub("licitaciones", "adjuntos/7/33333333-3333-4333-8333-333333333333.jpg"),
  protegido: pub("documentos", "legajo/copia-literal.pdf"),
  ilegible: pub("documentos", "legajo/roto.pdf"),
  noExiste: pub("documentos", "legajo/borrado.pdf"),
  grande: pub("documentos", "legajo/enorme.pdf"),
  lento: pub("documentos", "legajo/lento.pdf"),
  externo: "https://drive.google.com/file/d/abc/view",
  logo: pub("empresa", "logo.png"),
  imgProp: pub("licitaciones", "imagenes/7/44444444-4444-4444-8444-444444444444.png"),
};
const ARCHIVOS: Record<string, Uint8Array> = {
  [U.pdf2]: PDF2, [U.pdf3]: PDF3, [U.png]: PNG, [U.jpg]: JPG, [U.webp]: WEBP, [U.heic]: HEIC,
  [U.protegido]: PDF_PROTEGIDO, [U.ilegible]: BASURA, [U.logo]: PNG, [U.imgProp]: PNG,
  [U.grande]: new Uint8Array(5000), [U.lento]: PDF2,
};

/** Descarga falsa: cuenta las bajadas por URL y la concurrencia; la URL llega FIRMADA (?firmado=1). */
function descargaFalsa(o: { lento?: boolean } = {}) {
  const veces = new Map<string, number>();
  let enCurso = 0, maxEnCurso = 0, firmadas = 0;
  const descargar = async (url: string, tope: number, senal: AbortSignal): Promise<Uint8Array> => {
    if (url.endsWith("?firmado=1")) firmadas++;
    const limpio = url.replace(/\?firmado=1$/, "");
    veces.set(limpio, (veces.get(limpio) ?? 0) + 1);
    enCurso++; maxEnCurso = Math.max(maxEnCurso, enCurso);
    try {
      await new Promise((r) => setTimeout(r, 2));
      if (limpio === U.lento && o.lento) await new Promise((r) => setTimeout(r, 5000));
      if (senal.aborted) throw new Error("abortada");
      if (limpio === U.noExiste) throw new ErrorDescarga("http", "el servidor respondió 404", 404);
      const b = ARCHIVOS[limpio];
      if (!b) throw new ErrorDescarga("http", "404", 404);
      if (b.length > tope) throw new ErrorDescarga("demasiado_grande", "grande");
      return b;
    } finally { enCurso--; }
  };
  return { descargar, veces, max: () => maxEnCurso, firmadas: () => firmadas };
}
const firmarFalso = async (urls: string[]) => new Map(urls.filter((u) => u.startsWith(BASE)).map((u) => [u, `${u}?firmado=1`] as [string, string]));

class StorageFalso implements StorageEmision {
  objetos = new Map<string, Uint8Array>();
  subidas = 0;
  urlMala = false;
  async subir(bucket: string, ruta: string, bytes: Uint8Array) {
    this.subidas++;
    const k = `${bucket}/${ruta}`;
    if (this.objetos.has(k)) return { error: "Ya hay un archivo en esa ruta: lo emitido no se sobrescribe.", url: null };
    this.objetos.set(k, new Uint8Array(bytes));
    return { error: null, url: this.urlMala ? pub(bucket, ruta + "-otra") : pub(bucket, ruta) };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fila = Record<string, any>;
class DbFalsa {
  filas: Fila[] = [];
  intentos = 0;
  enviados: Fila[] = [];
  lecturas = 0;
  fallarInsert: { code: string; message: string } | null = null;
  fallarLectura: { code: string; message: string } | null = null;
  choqueUnaVez = false;
  storage?: unknown;
  from(tabla: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    if (tabla !== "licitacion_emisiones") throw new Error(`tabla inesperada ${tabla}`);
    return {
      select() {
        const f: Record<string, unknown> = {};
        const q = {
          eq(c: string, v: unknown) { f[c] = v; return q; }, order() { return q; }, limit() { return q; },
          then(res: (x: unknown) => unknown, rej?: (e: unknown) => unknown) {
            self.lecturas++;
            if (self.fallarLectura) return Promise.resolve({ data: null, error: self.fallarLectura }).then(res, rej);
            const rows = self.filas.filter((x) => x.licitacion_id === f.licitacion_id).sort((a, b) => b.version - a.version).slice(0, 1).map((x) => ({ version: x.version }));
            return Promise.resolve({ data: rows, error: null }).then(res, rej);
          },
        };
        return q;
      },
      insert(fila: Fila) {
        self.intentos++;
        const copia = JSON.parse(JSON.stringify(fila));
        self.enviados.push(copia);
        return { select(cols: string) { return { async single() {
          if (self.fallarInsert) return { data: null, error: self.fallarInsert };
          if (self.choqueUnaVez) {
            self.choqueUnaVez = false;
            self.filas.push({ ...copia, id: 900, carpeta: "00000000-0000-4000-8000-000000000000" });
            return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "uq_licitacion_emisiones_version"' } };
          }
          if (self.filas.some((x) => x.licitacion_id === copia.licitacion_id && x.version === copia.version)) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "uq_licitacion_emisiones_version"' } };
          if (self.filas.some((x) => x.carpeta === copia.carpeta)) return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "uq_licitacion_emisiones_carpeta"' } };
          const row = { ...copia, id: self.filas.length + 1, emitido_por: "usuario-sesion", emitido_en: "2026-10-24T15:00:00.000Z" };
          self.filas.push(row);
          const out: Fila = {};
          for (const c of cols.split(",")) out[c] = row[c];
          return { data: out, error: null };
        } }; } };
      },
    };
  }
}

// ── Licitación, contexto, revisión y resolvedores falsos ──
let idN = 0;
const nuevoId = () => `id-${++idN}`;
function licitacion(o: { foliado?: Partial<OpcionesFoliado>; primero?: boolean; relacion?: boolean } = {}): Licitacion {
  const doc = docVacio(nuevoId);
  doc.expediente.foliado = { modo: "ascendente", formato: "Folio {n}", digitos: 3, posicion: "inferior_derecha", foliarPortadas: true, foliarBloquesSueltos: true, ...o.foliado };
  doc.expediente.propuestaEnCompleto = o.primero ? "primero" : "no";
  if (o.relacion !== false) doc.secciones = [{ id: "s1", titulo: "Relación de adjuntos", activa: true, numerada: true, bloques: [{ id: "auto1", tipo: "auto", auto: "relacion_adjuntos", titulo: null, filasExtra: [], conContacto: false }] }];
  return {
    id: 7, nombre: "Transporte de personal planta Sur", cliente_id: null, cliente_nombre: "Cliente de prueba S.A.", codigo: "LP-001-2026",
    objeto: null, atencion: null, fecha_consultas: null, fecha_presentacion: "2026-11-05", hora_presentacion: null, fecha_inicio_servicio: null,
    plazo_meses: 12, estado: "preparacion", archivada: false, doc, version: 3, creado_por: null, creado_en: "2026-10-01T00:00:00Z",
    actualizado_por: null, actualizado_en: "2026-10-20T00:00:00Z",
  };
}
const CTX: ContextoLicitacion = {
  hoy: "2026-10-24", perfil: { nombre: "Postor de Prueba", razon_social: "Postor de Prueba S.A.C.", ruc: "20000000001", direccion: "Av. Siempre Viva 123", autorizacion_mtc: "R.D. 000-2000" },
  unidades: {}, conductores: {}, legajo: [], experiencia: {}, seguros: [], personal: {}, otras: [],
  lecturas: { perfil: "ok", unidades: "ok", conductores: "ok", legajo: "ok", experiencia: "ok", seguros: "ok", personal: "ok", otras: "ok" },
  migraciones: { anioTercero: true, conductorTercero: true, fechaConstitucion: true },
};
const H1: Hallazgo = { clave: "marca_completar|seccion:s1||", codigo: "marca_completar", gravedad: "alarma", titulo: "t", texto: "Queda un [COMPLETAR]", arreglo: "a", donde: { paso: "contenido", ancla: null }, sujeto: { tipo: "seccion", id: "s1", rotulo: "S1" }, requisitoId: null, aceptado: null };
const H2: Hallazgo = { ...H1, clave: "legajo_antiguo|legajo:x||", codigo: "legajo_antiguo", texto: "Ficha RUC antigua", aceptado: { clave: "legajo_antiguo|legajo:x||", nota: "Se pidió una nueva", por: null, en: "2026-10-23T00:00:00Z" } };
const REV: Revision = { hallazgos: [H1, H2], evaluaciones: [], cuenta: { alarma: 2, aviso: 0, info: 0 }, fechaReferencia: "2026-11-05", referenciaEs: "presentacion" };

function bloque1(o: { externo?: boolean; protegido?: boolean; noExiste?: boolean } = {}): BloqueExpedienteResuelto {
  return {
    id: "B1", conPortada: true,
    separador: { titulo: "SECCIÓN I", subtitulo: "REQUISITOS LEGALES", referencia: "Bases 5.1", contenido: ["Ficha RUC", "Croquis", "Copia literal"] },
    partes: [
      { tipo: "archivo", itemId: "i1", titulo: "Ficha RUC", url: U.pdf2, nombre: "ficha.pdf", origen: "storage_privado", etiquetaFuente: "Legajo" },
      { tipo: "archivo", itemId: "i2", titulo: "Croquis", url: U.png, nombre: "croquis.png", origen: "storage_privado", etiquetaFuente: "Adjunto" },
      { tipo: "faltante", itemId: "i3", titulo: "Vigencia de poder", codigo: "expediente_item_sin_archivo" },
      ...(o.protegido !== false ? [{ tipo: "archivo" as const, itemId: "i4", titulo: "Copia literal", url: U.protegido, nombre: "copia.pdf", origen: "storage_privado" as const, etiquetaFuente: "Legajo" }] : []),
      ...(o.externo !== false ? [{ tipo: "archivo" as const, itemId: "i5", titulo: "SOAT de ABC-123", url: U.externo, nombre: "soat", origen: "externo" as const, etiquetaFuente: "Unidad" }] : []),
      ...(o.noExiste ? [{ tipo: "archivo" as const, itemId: "i6", titulo: "Borrado", url: U.noExiste, nombre: "b.pdf", origen: "storage_privado" as const, etiquetaFuente: "Legajo" }] : []),
    ],
  };
}
const bloque2 = (): BloqueExpedienteResuelto => ({
  id: "B2", conPortada: false, separador: { titulo: "SECCIÓN II", subtitulo: "PROPUESTA TÉCNICA", referencia: "", contenido: [] },
  partes: [
    { tipo: "propuesta", itemId: "j1" },
    { tipo: "archivo", itemId: "j2", titulo: "Ficha RUC (otra vez)", url: U.pdf2, nombre: "ficha.pdf", origen: "storage_privado", etiquetaFuente: "Legajo" },
  ],
});
const expediente = (bs: BloqueExpedienteResuelto[]): ExpedienteResuelto => ({ bloques: bs, cabecera: "Postor de Prueba S.A.C. · LP-001-2026", color: "#1f4e79" });

/** El documento: una tabla con los folios de cada bloque (la relación de adjuntos). `crece` agrega filas al recibir folios. */
function documento(ids: string[], folios: FoliosPorBloque | undefined, crece = 0): DocumentoResuelto {
  const filas = ids.map((id) => [`Bloque ${id}`, folios ? `FOLIOS ${id} ${textoRangoFolios(folios[id] ?? { desde: 0, hasta: 0 }, 3)}` : "—"]);
  if (folios) for (let k = 0; k < crece; k++) filas.push([`Fila adicional ${k + 1}`, "texto de relleno para que la propuesta crezca al meter los folios"]);
  return {
    cabecera: "Postor de Prueba S.A.C. · Propuesta técnica", color: "#1f4e79",
    portada: { modo: "generada", imagenUrl: null, titulo: "PROPUESTA TÉCNICA", subtitulo: "LP-001-2026", lineas: ["Cliente de prueba S.A."] },
    control: null, carta: null, glosario: null, indice: null,
    secciones: [{ id: "s1", numero: "1", titulo: "Relación de adjuntos", bloques: [
      { id: "img1", tipo: "imagen", url: U.imgProp, pie: "Foto de la flota", anchoPct: 40 },
      { id: "t1", tipo: "tabla", titulo: "Relación de documentos", columnas: ["Bloque", "Folios"], filas, anchos: null, pie: null },
    ] }],
    cierre: null, firmante: null, pie: { izquierda: "Postor de Prueba", derecha: "Página {pagina} de {total}" },
  };
}

function deps(o: { exp?: ExpedienteResuelto; crece?: number; storage?: StorageEmision | null; db?: DbFalsa; uuid?: () => string; lento?: boolean; topes?: DepsEmision["topes"]; revisar?: DepsEmision["revisarLicitacion"]; webp?: boolean } = {}) {
  const dl = descargaFalsa({ lento: o.lento });
  const exp = o.exp ?? expediente([bloque1(), bloque2()]);
  const ids = exp.bloques.map((b) => b.id);
  const llamadasDoc: (FoliosPorBloque | undefined)[] = [];
  let n = 0;
  const d: DepsEmision = {
    db: o.db ?? new DbFalsa(), storage: o.storage === undefined ? new StorageFalso() : o.storage,
    descargar: dl.descargar, firmar: firmarFalso,
    resolverDocumento: (_l, _c, _r, op) => { llamadasDoc.push(op?.folios); return documento(ids, op?.folios, o.crece ?? 0); },
    resolverExpediente: () => exp,
    revisarLicitacion: o.revisar,
    ahora: () => new Date("2026-10-24T15:00:00Z"),
    uuid: o.uuid ?? (() => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, "0")}`),
    base: BASE, topes: o.topes,
    webpAJpeg: o.webp ? async (b) => new Uint8Array(await sharp(Buffer.from(b)).jpeg().toBuffer()) : undefined,
  };
  return { d, dl, llamadasDoc };
}
const EXTRA = (lic: Licitacion, o: Partial<ExtraEmision> = {}): ExtraEmision => ({ versionGuardada: lic.version, hayCambiosSinGuardar: false, logo: U.logo, nota: "Emisión de prueba", ...o });
const OPTS = (o: Partial<OpcionesEmision> = {}): OpcionesEmision => ({ propuesta: true, bloques: true, completo: true, empaque: "zip", subirCopias: true, ...o });

/** El texto de cada hoja de un PDF (pdftotext) y el folio que lleva cada una. */
function hojas(bytes: Uint8Array, nombre: string): string[] {
  const f = path.join(TMP, nombre);
  fs.writeFileSync(f, bytes);
  return execFileSync("pdftotext", ["-layout", f, "-"], { encoding: "utf8" }).split("\f").slice(0, -1);
}
const folioDe = (t: string) => { const m = /Folio (\d{3})/.exec(t); return m ? Number(m[1]) : null; };
const bytesDe = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const RUTA_EMISION = /^emisiones\/7\/[0-9a-f-]{36}\/[A-Za-z0-9._-]+\.pdf$/;
const PDFTOTEXT = tiene("pdftotext");
const DETALLE = !!process.env.DETALLE;

// ══ 1. Helpers puros ════════════════════════════════════════════════════════════
sec("1. Helpers puros");
{
  const n = nombresUnicos(["a.pdf", "A.pdf", "a.pdf", "b.pdf", "a_2.pdf"]);
  check(JSON.stringify(n) === JSON.stringify(["a.pdf", "A_2.pdf", "a_3.pdf", "b.pdf", "a_2_2.pdf"]), `nombresUnicos sin distinguir mayúsculas: ${JSON.stringify(n)}`);
  const largo = "x".repeat(100) + ".pdf";
  const nl = nombresUnicos([largo, largo]);
  check(nl[1].length <= 104 && nl[1].endsWith("_2.pdf") && nl[0] === largo, "el sufijo no pasa de 100 + extensión");
  check(new Set(nombresUnicos(Array.from({ length: 30 }, () => "Bloque.PDF")).map((x) => x.toLowerCase())).size === 30, "30 iguales → 30 distintos");

  check(debeSubir(10).sube === true, "debeSubir: 10 bytes sí");
  const d0 = debeSubir(0);
  check(!d0.sube && /vac/i.test(d0.motivo), "debeSubir: vacío no");
  const dg = debeSubir(TOPES_DOC.maxBytesArchivo + 1);
  check(!dg.sube && /50 MB/.test(dg.motivo), `debeSubir: sobre el tope no, y lo dice: ${!dg.sube && dg.motivo}`);
  check(debeSubir(TOPES_DOC.maxBytesArchivo).sube === true, "debeSubir: justo el tope sí");
  check(debeSubir(new Uint8Array(5), 4).sube === false, "debeSubir acepta bytes y un tope propio");

  let todosIguales = true;
  for (const L of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4096, 100_003]) {
    const b = new Uint8Array(L); for (let i = 0; i < L; i++) b[i] = (i * 31 + L) & 255;
    if (sha256Puro(b) !== sha(b)) { todosIguales = false; console.log("    sha256Puro difiere en", L); }
    const corte = Math.floor(L / 3);
    if (sha256DePartes([b.subarray(0, corte), b.subarray(corte, corte + 7), b.subarray(corte + 7)]) !== sha(b)) { todosIguales = false; console.log("    sha256DePartes difiere en", L); }
    if (new Sha256().actualizar(b.subarray(0, 1)).actualizar(b.subarray(1)).hex() !== sha(b)) { todosIguales = false; console.log("    incremental difiere en", L); }
  }
  check(todosIguales, "sha256 puro, por partes e incremental ≡ node:crypto en 17 largos (bordes de bloque incluidos)");
  check(await sha256Hex(PDF2) === sha(PDF2), "sha256Hex (crypto.subtle) ≡ node:crypto");

  const fotoA = { b: 1, a: { y: [1, 2], x: "ñ" } } as unknown as FotoEmision;
  const fotoB = { a: { x: "ñ", y: [1, 2] }, b: 1 } as unknown as FotoEmision;
  const fa = await firmaDeFoto(fotoA);
  check(/^[0-9a-f]{64}$/.test(fa) && fa === await firmaDeFoto(fotoB), "firmaDeFoto: 64 hex y no depende del orden de las claves");
  check(fa === sha(new TextEncoder().encode(canonico(fotoA))), "firmaDeFoto = sha256(canonico(foto))");

  const hs = hallazgosParaEmision(REV, [{ clave: H1.clave, codigo: H1.codigo, gravedad: H1.gravedad, texto: H1.texto, aceptado: true, nota: "Se completa a mano en la versión impresa" }]);
  const h1 = hs.find((h) => h.clave === H1.clave), h2 = hs.find((h) => h.clave === H2.clave);
  check(hs.length === 2 && h1?.aceptado && h1.nota === "Se completa a mano en la versión impresa" && h2?.aceptado && h2.nota === "Se pidió una nueva", "hallazgos: abiertos y aceptados con su nota (el del confirm manda)");
  check(hallazgosParaEmision(REV).find((h) => h.clave === H1.clave)?.aceptado === false, "sin aceptar al emitir, el abierto queda abierto");
  check(hallazgosParaEmision({ hallazgos: [] }, [{ ...hs[0] }]).length === 1, "un aceptado que la revisión ya no da se conserva");
  check(pesoFuentes({ a: { url: "a", ok: true, formato: "pdf", paginas: 1, bytes: 10, sha256: "x" }, b: { url: "b", ok: false, codigo: "archivo_externo", detalle: "" } }) === 10, "pesoFuentes suma solo lo bajado");
  check(docTieneRelacionAdjuntos(licitacion().doc) && !docTieneRelacionAdjuntos(licitacion({ relacion: false }).doc), "docTieneRelacionAdjuntos");
  const fuente = fs.readFileSync(new URL("../lib/licitaciones/emitir.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check(!/ignoreEncryption/.test(fuente), "el código (sin comentarios) no usa ignoreEncryption (R11)");
  check(!/emitido_por\s*:/.test(fuente.split("export async function registrarEmision")[1]?.split("const d = data")[0] ?? "x"), "la fila que se inserta no arma emitido_por");
  try {
    const rev = await import("../lib/licitaciones/revision");
    check((rev as { MAX_BYTES_EXPEDIENTE?: number }).MAX_BYTES_EXPEDIENTE === TOPE_FUENTES_BYTES, "TOPE_FUENTES_BYTES ≡ MAX_BYTES_EXPEDIENTE de la revisión (R12, un solo número)");
  } catch { console.log("  (lib/licitaciones/revision no se pudo cargar: se omite el cotejo del tope)"); }
}

// ══ 2. comprobarArchivos (el ensayo) ════════════════════════════════════════════
sec("2. comprobarArchivos: un código por archivo, nunca lanza");
{
  const exp = expediente([{
    id: "BX", conPortada: false, separador: { titulo: "X", subtitulo: "", referencia: "", contenido: [] },
    partes: [
      { tipo: "archivo", itemId: "a", titulo: "PDF", url: U.pdf3, nombre: "x", origen: "storage_privado", etiquetaFuente: "" },
      { tipo: "archivo", itemId: "b", titulo: "Protegido", url: U.protegido, nombre: "x", origen: "storage_privado", etiquetaFuente: "" },
      { tipo: "archivo", itemId: "c", titulo: "Ilegible", url: U.ilegible, nombre: "x", origen: "storage_privado", etiquetaFuente: "" },
      { tipo: "archivo", itemId: "d", titulo: "HEIC", url: U.heic, nombre: "x", origen: "storage_privado", etiquetaFuente: "" },
      { tipo: "archivo", itemId: "e", titulo: "Externo", url: U.externo, nombre: "x", origen: "externo", etiquetaFuente: "" },
      { tipo: "archivo", itemId: "f", titulo: "Borrado", url: U.noExiste, nombre: "x", origen: "storage_privado", etiquetaFuente: "" },
      { tipo: "archivo", itemId: "g", titulo: "Grande", url: U.grande, nombre: "x", origen: "storage_privado", etiquetaFuente: "" },
      { tipo: "archivo", itemId: "h", titulo: "Lento", url: U.lento, nombre: "x", origen: "storage_privado", etiquetaFuente: "" },
      { tipo: "ficha_unidad", itemId: "fi", ficha: { codigo: "U1", rol: "titular", uso: "", placa: "ABC-123", marcaModelo: "", anio: 2020, capacidad: 30, flota: "Propia", fotoExternaUrl: U.jpg, fotoInternaUrl: U.webp, documentos: [] } },
    ],
  }]);
  const lic = licitacion();
  const { d, dl } = deps({ exp, lento: true, topes: { descarga: 4000, tiempoMs: 300 } });
  const r = await comprobarArchivos(lic, CTX, REV, d, new AbortController().signal, { logo: U.logo });
  const cod = (u: string) => { const x = r[u]; return x ? (x.ok ? `ok:${x.formato}` : x.codigo) : "—"; };
  check(cod(U.pdf3) === "ok:pdf" && (r[U.pdf3] as Extract<RevisionArchivo, { ok: true }>).paginas === 3, "PDF sano: ok con 3 páginas");
  check((r[U.pdf3] as Extract<RevisionArchivo, { ok: true }>).sha256 === sha(PDF3), "sha256 del archivo bajado");
  check(cod(U.protegido) === "pdf_protegido", `protegido: ${cod(U.protegido)}`);
  check(cod(U.ilegible) === "archivo_formato_no_soportado", `basura con nombre .pdf: no es PDF por su firma → formato no soportado (${cod(U.ilegible)})`);
  check(cod(U.heic) === "archivo_formato_no_soportado" && /HEIC/.test((r[U.heic] as { detalle: string }).detalle), "HEIC: formato no soportado, y lo nombra");
  check(cod(U.externo) === "archivo_externo", "enlace de Drive: archivo_externo (no se baja)");
  check(!dl.veces.has(U.externo), "el externo NO se intentó bajar");
  check(cod(U.noExiste) === "archivo_no_descargable" && /ya no está/.test((r[U.noExiste] as { detalle: string }).detalle), "404: no descargable, «ya no está»");
  check(cod(U.grande) === "archivo_demasiado_grande", `sobre el tope de descarga: ${cod(U.grande)}`);
  check(cod(U.lento) === "archivo_no_descargable" && /Tardó/.test((r[U.lento] as { detalle: string }).detalle), `lento: corta por tiempo (${cod(U.lento)})`);
  check(cod(U.jpg) === "ok:jpg" && cod(U.webp) === "archivo_formato_no_soportado", "foto JPG ok · WEBP sin conversor: no soportado");
  check(cod(U.imgProp) === "ok:png" && cod(U.logo) === "ok:png", "imagen de la propuesta y logo revisados");
  check(dl.max() <= 3, `a lo sumo 3 descargas a la vez (máximo ${dl.max()})`);
  check(dl.firmadas() > 0, "baja la URL FIRMADA");

  const con = deps({ exp, webp: true });
  const r2 = await comprobarArchivos(lic, CTX, REV, con.d, new AbortController().signal, { logo: null });
  check(r2[U.webp]?.ok === true && (r2[U.webp] as { formato: string }).formato === "jpg", "WEBP con conversor → ok como JPG");
  check(!r2[U.logo], "logo null → no se revisa logo");

  // Cancelación: devuelve lo que alcanzó, sin lanzar.
  const ac = new AbortController(); ac.abort();
  let lanzo = false;
  try { await comprobarArchivos(lic, CTX, REV, deps({ exp }).d, ac.signal); } catch { lanzo = true; }
  check(!lanzo, "cancelado de entrada: no lanza");
}

// ══ 3. Emisión ascendente: identidad, omitidos, folios, firma, registro ═════════
sec("3. Emisión completa · ascendente · ZIP · copias");
let primera: ResultadoEmitir | null = null;
const almacen = new StorageFalso();
const db = new DbFalsa();
{
  const lic = licitacion();
  const { d, dl, llamadasDoc } = deps({ storage: almacen, db });
  const prog: ProgresoEmision[] = [];
  const r = await emitirLicitacion(lic, CTX, REV, OPTS(), d, (p) => prog.push(p), new AbortController().signal, EXTRA(lic));
  primera = r;
  check(r.ok, `ok: ${!r.ok ? r.codigo + " · " + r.detalle : ""}`);
  if (r.ok) {
    const porTipo = (t: string) => r.emitidos.filter((e) => e.tipo === t);
    check(porTipo("propuesta").length === 1 && porTipo("bloque").length === 2 && porTipo("expediente_completo").length === 1 && porTipo("zip").length === 1, `archivos: ${r.emitidos.map((e) => e.nombre).join(", ")}`);
    check(r.archivos.length === 1 && r.archivos[0].nombre.endsWith(".zip"), "con empaque ZIP se descarga UN archivo");
    const zip = await bytesDe(r.archivos[0].blob);
    check(zip[0] === 0x50 && zip[1] === 0x4b && porTipo("zip")[0].sha256 === sha(zip) && porTipo("zip")[0].bytes === zip.length, "el ZIP es un ZIP y su sha256/bytes son los del blob");
    check(porTipo("zip")[0].url === null && /no se sube dos veces/.test(porTipo("zip")[0].motivoNoSubido ?? ""), "el ZIP no se sube (y lo dice)");

    // Ciclo de identidad
    const pdfs = r.emitidos.filter((e) => e.tipo !== "zip");
    let identidad = true;
    for (const e of pdfs) {
      const obj = objetoPrivadoDe(e.url, BASE);
      const ruta = `emisiones/7/${r.carpeta}/${e.nombre}`;
      if (!obj || obj.bucket !== "licitaciones" || obj.ruta !== ruta || !RUTA_EMISION.test(obj.ruta) || !almacen.objetos.has(`licitaciones/${ruta}`)) identidad = false;
      if (sha(almacen.objetos.get(`licitaciones/${ruta}`) ?? new Uint8Array()) !== e.sha256) identidad = false;
    }
    check(identidad && pdfs.length === 4, "cada url guardada vuelve por objetoPrivadoDe EXACTAMENTE a la ruta subida, y lo subido tiene su sha256");

    // Omitidos con su código
    const om = (item: string) => r.omitidos.find((o) => o.itemId === item);
    check(om("i4")?.codigo === "pdf_protegido" && om("i4")?.bloqueId === "B1", `PDF protegido → omitido pdf_protegido (${om("i4")?.codigo})`);
    check(om("i5")?.codigo === "expediente_item_archivo_externo" && om("i5")?.url === U.externo, `enlace externo → omitido con su url (${om("i5")?.codigo})`);
    check(om("i3")?.codigo === "expediente_item_sin_archivo", "parte faltante → omitida con su código");
    check(r.revisiones[U.protegido]?.ok === false && (r.revisiones[U.protegido] as { codigo: string }).codigo === "pdf_protegido", "la revisión del archivo registra el cifrado que descubrió el armado");
    check((dl.veces.get(U.pdf2) ?? 0) === 1, `el PDF usado en dos bloques se bajó UNA vez (${dl.veces.get(U.pdf2)})`);
    check(!dl.veces.has(U.externo), "el externo no se intentó bajar");

    // Registro
    check(db.intentos === 1 && db.enviados.length === 1, "un solo INSERT");
    const env = db.enviados[0];
    check(!("emitido_por" in env) && !("emitido_en" in env) && !("id" in env), "el INSERT va SIN emitido_por, emitido_en ni id");
    check(env.version === 1 && env.doc_version === 3 && env.carpeta === r.carpeta && env.licitacion_id === 7, "versión 1, doc_version = la de la licitación, la carpeta de las copias");
    check(/^[0-9a-f]{64}$/.test(env.firma) && env.firma === sha(new TextEncoder().encode(canonico(env.foto))), "firma = sha256 hex de 64 de canonico(foto), recalculable desde lo guardado");
    check(r.emision?.emitido_por === "usuario-sesion" && r.emision?.version === 1, "la fila devuelta trae lo que selló la base");
    check(env.hallazgos.length === 2 && env.hallazgos.some((h: { aceptado: boolean; nota: string }) => h.aceptado && h.nota === "Se pidió una nueva"), "hallazgos abiertos y aceptados con su nota");
    check(env.omitidos.length === r.omitidos.length && env.archivos.length === 5, "omitidos y archivos van en la fila");
    check(env.nota === "Emisión de prueba" && env.foto.empresa.ruc === "20000000001" && env.foto.empresa.autorizacion === "R.D. 000-2000", "nota y empresa (del perfil, no de un literal)");
    const fu = env.foto.fuentes.find((x: { url: string; itemId: string }) => x.url === U.pdf2 && x.itemId === "i1");
    check(fu?.sha256 === sha(PDF2) && fu?.paginas === 2, "fuentes: sha256 y páginas de cada archivo usado");
    check(!("doc" in env.foto.licitacion) && env.foto.doc.esquema === 1, "foto.licitacion sin doc; el doc va aparte");
    check(llamadasDoc.length >= 2 && llamadasDoc[0] === undefined && llamadasDoc.at(-1) != null, "resolverDocumento: primero sin folios, después con folios");

    // Progreso
    const fases = [...new Set(prog.map((p) => p.fase))];
    check(["comprobando", "bajando", "armando_propuesta", "armando_bloques", "foliando", "empacando", "subiendo", "registrando", "listo"].every((f) => fases.includes(f as never)), `fases: ${fases.join(" → ")}`);
    check(prog.every((p) => p.hecho <= p.total && p.hecho >= 0), "hecho ≤ total en cada aviso de progreso");

    // Folios: completo ascendente ≡ bloques sueltos
    const b1 = r.emitidos.find((e) => e.bloqueId === "B1")!, b2 = r.emitidos.find((e) => e.bloqueId === "B2")!;
    const comp = r.emitidos.find((e) => e.tipo === "expediente_completo")!;
    check(b1.paginas === 4 && b1.folios?.desde === 1 && b1.folios?.hasta === 4, `B1: portada + 2 + 1 = 4 páginas, folios 1–4 (${JSON.stringify(b1.folios)})`);
    check(b2.folios?.desde === 5 && b2.folios?.hasta === b1.paginas! + b2.paginas!, `B2 sigue en 5 (${JSON.stringify(b2.folios)})`);
    check(comp.paginas === b1.paginas! + b2.paginas! && comp.folios?.desde === 1 && comp.folios?.hasta === comp.paginas, "completo = B1 + B2 (la propuesta no va primero), folios 1..N");
    check(r.emitidos.find((e) => e.tipo === "propuesta")!.folios === null, "la propuesta suelta no lleva folio (no está en el mapa)");
    if (PDFTOTEXT) {
      const objeto = (e: { nombre: string }) => almacen.objetos.get(`licitaciones/emisiones/7/${r.carpeta}/${e.nombre}`)!;
      const fc = hojas(objeto(comp), "c.pdf").map(folioDe);
      const fb = [...hojas(objeto(b1), "b1.pdf").map(folioDe), ...hojas(objeto(b2), "b2.pdf").map(folioDe)];
      if (DETALLE) console.log("    completo:", JSON.stringify(fc), "· sueltos:", JSON.stringify(fb), "· avisos:", JSON.stringify(r.avisos));
      check(JSON.stringify(fc) === JSON.stringify(Array.from({ length: comp.paginas! }, (_, i) => i + 1)), `completo: Folio 001..${comp.paginas} en orden (${JSON.stringify(fc)})`);
      check(JSON.stringify(fb) === JSON.stringify(fc), "los bloques sueltos llevan EXACTAMENTE los folios del completo");
      const prop = hojas(objeto(r.emitidos.find((e) => e.tipo === "propuesta")!), "p.pdf").join("\n");
      check(prop.includes(`FOLIOS B1 001–004`) && prop.includes(`FOLIOS B2 ${textoRangoFolios(b2.folios!, 3)}`), "la relación de adjuntos de la propuesta imprime los rangos REALES");
      check(hojas(objeto(b2), "b2b.pdf").join("\n").includes("FOLIOS B1 001–004"), "el bloque que lleva la propuesta lleva la FINAL (con folios), no la del primer pase");
      check(!prop.includes("Folio 0"), "la propuesta suelta sin folio impreso");
    } else console.log("  (pdftotext no está: se omite la lectura de folios)");
  }
}

// ══ 4. Descendente, sin foliar portadas, propuesta primero, dos pasadas ═════════
sec("4. Descendente · portadas sin folio · propuesta primero · la propuesta crece con los folios");
{
  const lic = licitacion({ foliado: { modo: "descendente", foliarPortadas: false }, primero: true });
  const { d, llamadasDoc } = deps({ crece: 70 });
  const r = await emitirLicitacion(lic, CTX, REV, OPTS({ empaque: "sueltos" }), d, () => {}, new AbortController().signal, EXTRA(lic));
  check(r.ok, `ok: ${!r.ok ? r.codigo + " · " + r.detalle : ""}`);
  if (r.ok) {
    check(llamadasDoc.length === 3, `meter los folios cambió las páginas → recalcula UNA vez (${llamadasDoc.length} llamadas al resolvedor)`);
    check(!r.avisos.some((a) => /corridos/.test(a)), "tras recalcular, los folios casan (sin aviso de folios corridos)");
    check(r.avisos.some((a) => /dos veces en el expediente completo/.test(a)), "avisa que la propuesta va dos veces (primero y dentro de B2)");
    check(r.archivos.length === r.emitidos.length && r.archivos.every((a) => a.nombre.endsWith(".pdf")), "sueltos: un archivo por pieza");
    const prop = r.emitidos.find((e) => e.tipo === "propuesta")!, b1 = r.emitidos.find((e) => e.bloqueId === "B1")!, b2 = r.emitidos.find((e) => e.bloqueId === "B2")!;
    const comp = r.emitidos.find((e) => e.tipo === "expediente_completo")!;
    const foliables = comp.paginas! - 2; // la portada de la propuesta y la de B1 no llevan folio
    check(comp.folios?.desde === foliables && comp.folios?.hasta === 1, `completo descendente ${foliables}..1 (${JSON.stringify(comp.folios)})`);
    check(prop.folios?.desde === foliables && b2.folios?.hasta === 1, "la propuesta (primera) lleva los más altos y B2 termina en 1");
    if (PDFTOTEXT) {
      const blobDe = async (nombre: string) => bytesDe(r.archivos.find((a) => a.nombre === nombre)!.blob);
      const fc = hojas(await blobDe(comp.nombre), "dc.pdf").map(folioDe);
      const fs_ = [prop, b1, b2].map(async (e) => hojas(await blobDe(e.nombre), `d-${e.nombre}`).map(folioDe));
      const sueltos = (await Promise.all(fs_)).flat();
      const esperado: (number | null)[] = [];
      let k = foliables;
      for (let i = 0; i < comp.paginas!; i++) esperado.push(i === 0 || i === prop.paginas ? null : k--);
      if (DETALLE) console.log("    completo:", JSON.stringify(fc), "· sueltos:", JSON.stringify(sueltos), "· piezas:", r.emitidos.map((e) => `${e.nombre} ${e.paginas}p ${JSON.stringify(e.folios)}`).join(" | "));
      check(JSON.stringify(fc) === JSON.stringify(esperado), `completo: portadas sin folio y el resto bajando hasta 001 (${JSON.stringify(fc.slice(0, 6))}…)`);
      check(JSON.stringify(sueltos) === JSON.stringify(fc), "propuesta + B1 + B2 sueltos llevan EXACTAMENTE los folios del completo");
      const texto = hojas(await blobDe(prop.nombre), "dp.pdf").join("\n");
      check(texto.includes(`FOLIOS B1 ${textoRangoFolios(b1.folios!, 3)}`) && texto.includes(`FOLIOS B2 ${textoRangoFolios(b2.folios!, 3)}`), `relación: rangos descendentes reales (${textoRangoFolios(b1.folios!, 3)} · ${textoRangoFolios(b2.folios!, 3)})`);
    }
  }
}

// ══ 5. Reemitir no pisa nada ═════════════════════════════════════════════════════
sec("5. Reemitir: otra carpeta, nada se pisa; con la MISMA carpeta el almacenamiento rechaza");
{
  const lic = licitacion();
  const antes = new Map(almacen.objetos);
  const { d } = deps({ storage: almacen, db, uuid: () => "bbbbbbbb-0000-4000-8000-000000000002" });
  const r = await emitirLicitacion(lic, CTX, REV, OPTS(), d, () => {}, new AbortController().signal, EXTRA(lic));
  check(r.ok && r.emision?.version === 2, `segunda emisión = versión 2 (${r.ok ? r.emision?.version : r.codigo})`);
  if (r.ok && primera?.ok) {
    check(r.carpeta !== primera.carpeta, "otra carpeta");
    check([...antes.keys()].every((k) => sha(almacen.objetos.get(k)!) === sha(antes.get(k)!)), "las copias de la primera emisión siguen intactas");
    check(almacen.objetos.size === antes.size + 4, "se agregaron 4 copias nuevas");
  }
  // Misma carpeta otra vez: el almacenamiento rechaza cada ruta y la base rechaza la carpeta (no se reintenta).
  const intentos0 = db.intentos;
  const r3 = await emitirLicitacion(lic, CTX, REV, OPTS(), deps({ storage: almacen, db, uuid: () => "bbbbbbbb-0000-4000-8000-000000000002" }).d, () => {}, new AbortController().signal, EXTRA(lic));
  check(!r3.ok && r3.codigo === "registro_fallido", `misma carpeta: registro_fallido (${r3.ok ? "ok" : r3.codigo})`);
  if (!r3.ok) {
    check(r3.emitidos.filter((e) => e.tipo !== "zip").every((e) => e.url === null && /no se sobrescribe/.test(e.motivoNoSubido ?? "")), "ninguna copia se pisó: cada una quedó con su motivo");
    check(db.intentos - intentos0 === 1, "el choque de CARPETA no se reintenta");
    check(r3.archivos.length === 1 && r3.archivos[0].blob.size > 0, "aun así devuelve el ZIP para descargar");
    check(almacen.objetos.size === antes.size + 4, "el almacenamiento no cambió");
  }
}

// ══ 6. Tope de subida ════════════════════════════════════════════════════════════
sec("6. Un archivo sobre el tope no se sube y lo dice");
{
  const lic = licitacion();
  const r0 = primera?.ok ? primera : null;
  const comp0 = r0?.emitidos.find((e) => e.tipo === "expediente_completo");
  const tope = (comp0?.bytes ?? 100000) - 1;
  const st = new StorageFalso();
  const r = await emitirLicitacion(lic, CTX, REV, OPTS(), deps({ storage: st, topes: { subida: tope } }).d, () => {}, new AbortController().signal, EXTRA(lic));
  check(r.ok, "ok");
  if (r.ok) {
    const comp = r.emitidos.find((e) => e.tipo === "expediente_completo")!;
    check(comp.bytes > tope && comp.url === null && /Pesa/.test(comp.motivoNoSubido ?? ""), `el completo (${comp.bytes} > ${tope}) no se subió: ${comp.motivoNoSubido}`);
    check(r.emitidos.filter((e) => e.tipo === "bloque" || e.tipo === "propuesta").every((e) => e.url && !e.motivoNoSubido), "los demás sí");
    check(st.objetos.size === 3, "3 copias en el almacenamiento");
  }
  const r2 = await emitirLicitacion(lic, CTX, REV, OPTS({ subirCopias: false }), deps({ storage: st }).d, () => {}, new AbortController().signal, EXTRA(lic));
  check(r2.ok && r2.emitidos.every((e) => e.url === null && e.motivoNoSubido) && st.objetos.size === 3, "sin subirCopias: nada se sube, cada archivo dice por qué, y la emisión se registra igual");
}

// ══ 7. Conflicto de versión ══════════════════════════════════════════════════════
sec("7. Conflicto de versión: no baja, no sube, no registra");
for (const caso of [{ hayCambiosSinGuardar: true }, { versionGuardada: 2 }]) {
  const lic = licitacion();
  const st = new StorageFalso(), dbx = new DbFalsa();
  const { d, dl } = deps({ storage: st, db: dbx });
  const r = await emitirLicitacion(lic, CTX, REV, OPTS(), d, () => {}, new AbortController().signal, EXTRA(lic, caso));
  check(!r.ok && r.codigo === "conflicto_version" && st.subidas === 0 && dbx.intentos === 0 && dbx.lecturas === 0 && dl.veces.size === 0, `${JSON.stringify(caso)} → conflicto_version sin tocar nada`);
}

// ══ 8. Registro fallido devuelve los archivos ════════════════════════════════════
sec("8. Registro fallido: los archivos se devuelven igual y la fila se puede reintentar");
{
  const lic = licitacion();
  const dbx = new DbFalsa();
  dbx.fallarInsert = { code: "42501", message: "new row violates row-level security policy for table \"licitacion_emisiones\"" };
  const r = await emitirLicitacion(lic, CTX, REV, OPTS({ empaque: "sueltos" }), deps({ db: dbx }).d, () => {}, new AbortController().signal, EXTRA(lic));
  check(!r.ok && r.codigo === "registro_fallido" && /permiso/.test(r.detalle), `registro_fallido con su motivo: ${!r.ok && r.detalle}`);
  if (!r.ok) {
    check(r.archivos.length === 4 && r.archivos.every((a) => a.blob.size > 0), "los 4 PDF vienen para descargar");
    check(r.registroPendiente != null && r.emitidos.filter((e) => e.url).length === 4, "la fila pendiente y las copias subidas");
    check(dbx.intentos === 1, "un error que no es choque de versión no se reintenta");
    dbx.fallarInsert = null;
    const rr = await registrarEmision(dbx, r.registroPendiente!);
    check(rr.ok && rr.fila.version === 1 && rr.fila.carpeta === r.carpeta, "registrarEmision con la fila pendiente: registra");
  }
  const dbL = new DbFalsa();
  dbL.fallarLectura = { code: "08006", message: "Failed to fetch" };
  const rl = await emitirLicitacion(lic, CTX, REV, OPTS(), deps({ db: dbL }).d, () => {}, new AbortController().signal, EXTRA(lic));
  check(!rl.ok && rl.codigo === "registro_fallido" && dbL.intentos === 0 && /última versión/.test(rl.detalle), "si no se puede leer la última versión NO se inserta (una lectura fallida no es «no hay emisiones»)");
  const dbC = new DbFalsa();
  dbC.choqueUnaVez = true;
  const rc = await emitirLicitacion(lic, CTX, REV, OPTS(), deps({ db: dbC }).d, () => {}, new AbortController().signal, EXTRA(lic));
  check(rc.ok && rc.emision?.version === 2 && dbC.intentos === 2, `choque en uq_licitacion_emisiones_version → se reintenta UNA vez con la siguiente (${rc.ok ? rc.emision?.version : rc.codigo}, ${dbC.intentos} intentos)`);
}

// ══ 9. Cancelación y memoria ═════════════════════════════════════════════════════
sec("9. Cancelación entre pasos · RangeError → memoria · sin nada que emitir");
{
  const lic = licitacion();
  for (const [fase, hecho] of [["armando_bloques", 1], ["subiendo", 1], ["bajando", 1]] as const) {
    const ac = new AbortController();
    const st = new StorageFalso(), dbx = new DbFalsa();
    const r = await emitirLicitacion(lic, CTX, REV, OPTS(), deps({ storage: st, db: dbx }).d, (p) => { if (p.fase === fase && p.hecho >= hecho) ac.abort(); }, ac.signal, EXTRA(lic));
    check(!r.ok && r.codigo === "cancelada" && dbx.intentos === 0, `cancelar en «${fase}» → cancelada, sin registro`);
    if (fase === "subiendo") check(!r.ok && st.subidas === 1 && /1 copia/.test(r.detalle), `cancelar subiendo: 1 copia subida y lo dice (${!r.ok && r.detalle})`);
    else check(st.subidas === 0, `cancelar en «${fase}»: nada subido`);
  }
  const { d } = deps();
  d.resolverExpediente = () => { throw new RangeError("Array buffer allocation failed"); };
  const rm = await emitirLicitacion(lic, CTX, REV, OPTS(), d, () => {}, new AbortController().signal, EXTRA(lic));
  check(!rm.ok && rm.codigo === "memoria" && /por bloques/.test(rm.detalle), "RangeError → memoria, recomienda emitir por bloques");
  const rn = await emitirLicitacion(lic, CTX, REV, OPTS({ propuesta: false, bloques: false, completo: false }), deps().d, () => {}, new AbortController().signal, EXTRA(lic));
  check(!rn.ok && rn.codigo === "sin_nada_que_emitir", "nada marcado → sin_nada_que_emitir");
  let lanzo = false;
  const dx = deps().d;
  dx.resolverDocumento = () => { throw new Error("error de programación"); };
  try { await emitirLicitacion(lic, CTX, REV, OPTS(), dx, () => {}, new AbortController().signal, EXTRA(lic)); } catch { lanzo = true; }
  check(lanzo, "un error propio (no un archivo, no memoria) LANZA");
}

// ══ 10. Casos sueltos ════════════════════════════════════════════════════════════
sec("10. Descarga fallida con su motivo · enlace que no casa · storage por defecto · revisar inyectado");
{
  const lic = licitacion();
  const r = await emitirLicitacion(lic, CTX, REV, OPTS(), deps({ exp: expediente([bloque1({ noExiste: true }), bloque2()]) }).d, () => {}, new AbortController().signal, EXTRA(lic));
  const om = r.ok ? r.omitidos.find((o) => o.itemId === "i6") : undefined;
  check(om?.codigo === "archivo_no_descargable" && /ya no está/.test(om.detalle), `el 404 se nombra con SU motivo, no el genérico (${om?.detalle})`);

  const mala = new StorageFalso(); mala.urlMala = true;
  const rm = await emitirLicitacion(lic, CTX, REV, OPTS(), deps({ storage: mala }).d, () => {}, new AbortController().signal, EXTRA(lic));
  check(rm.ok && rm.emitidos.filter((e) => e.tipo !== "zip").every((e) => e.url === null && /no apunta/.test(e.motivoNoSubido ?? "")), "un enlace devuelto que no vuelve a la ruta subida no se guarda");

  // storageDeDb: upload sin upsert + getPublicUrl
  const subidas: { ruta: string; upsert: unknown; contentType: unknown }[] = [];
  const dbS = new DbFalsa();
  dbS.storage = { from: (bucket: string) => ({
    upload: async (ruta: string, _b: Uint8Array, o: { upsert: unknown; contentType: unknown }) => { subidas.push({ ruta, upsert: o.upsert, contentType: o.contentType }); return subidas.length === 2 ? { error: { message: "The resource already exists", statusCode: "409" } } : { error: null }; },
    getPublicUrl: (ruta: string) => ({ data: { publicUrl: pub(bucket, ruta) } }),
  }) };
  const rs = await emitirLicitacion(lic, CTX, REV, OPTS(), deps({ storage: null, db: dbS }).d, () => {}, new AbortController().signal, EXTRA(lic));
  check(rs.ok && subidas.length === 4 && subidas.every((s) => s.upsert === false && s.contentType === "application/pdf"), "storage por defecto: db.storage.upload con upsert:false y application/pdf");
  check(rs.ok && rs.emitidos.filter((e) => e.url).length === 3 && rs.emitidos.some((e) => /no se sobrescribe/.test(e.motivoNoSubido ?? "")), "un 409 del almacenamiento queda como «no se sobrescribe»");

  const revisada: Revision = { ...REV, hallazgos: [...REV.hallazgos, { ...H1, clave: `pdf_protegido|archivo:${U.protegido}||`, codigo: "pdf_protegido", texto: "Copia literal protegida", aceptado: null }] };
  let vio: Record<string, RevisionArchivo> | undefined;
  const rr = await emitirLicitacion(lic, CTX, REV, OPTS(), deps({ revisar: (_l, _c, a) => { vio = a; return revisada; } }).d, () => {}, new AbortController().signal, EXTRA(lic));
  check(rr.ok && vio?.[U.protegido]?.ok === false && rr.emision?.hallazgos.some((h) => h.codigo === "pdf_protegido"), "revisarLicitacion inyectada recibe lo bajado y sus hallazgos son los que se registran");

  const solo = await emitirLicitacion(licitacion({ relacion: false }), CTX, REV, OPTS({ bloques: false, completo: false }), deps().d, () => {}, new AbortController().signal, EXTRA(licitacion()));
  check(solo.ok && solo.emitidos.length === 2 && solo.emitidos[0].tipo === "propuesta", "solo la propuesta (sin relación de adjuntos): no se arman los bloques");
  const { d: dSolo, dl: dlSolo } = deps();
  const soloRel = await emitirLicitacion(lic, CTX, REV, OPTS({ bloques: false, completo: false }), dSolo, () => {}, new AbortController().signal, EXTRA(lic));
  check(soloRel.ok && dlSolo.veces.has(U.pdf2) && soloRel.emitidos.filter((e) => e.tipo === "bloque").length === 0, "solo la propuesta CON relación de adjuntos foliada: los bloques se arman para contar folios, pero no se emiten");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${ok} ok · ${fallos} fallo(s)`);
process.exit(fallos ? 1 : 0);
