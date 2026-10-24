// ──────────────────────────────────────────────────────────────────────────────
// lib/licitaciones/datos.ts — La capa de DATOS del módulo Licitaciones (navegador).
//
// Lee y escribe; no decide nada del negocio (eso es de los motores puros: revision, reglas, legajo…).
// Arma el ContextoLicitacion que consume la revisión, guarda la licitación con bloqueo optimista, sube
// archivos y lleva el CRUD del legajo, de los documentos del conductor, de los documentos de unidad y
// del catálogo de experiencia.
//
// REGLAS QUE NO SE AFLOJAN
//  · UNA LECTURA FALLIDA NUNCA ES UNA LISTA VACÍA. Todo se lee con `todasLasPaginas` (LANZA ante una
//    página fallida) y orden total; una fuente que falla queda en "error" y la revisión dice
//    «no se pudo leer», nunca «falta». Una tabla de una migración sin correr es "sin_tabla".
//  · UNA COLUMNA DE UNA MIGRACIÓN ACCESORIA SE SUELTA SOLO SI EL ERROR LA NOMBRA (lib/columna-faltante),
//    y solo esa. Un INSERT/UPDATE rechazado por PostgREST (PGRST204) no llegó a la base, y uno que
//    falla en Postgres se deshace entero (PostgREST corre cada petición en una transacción): por eso
//    se puede reintentar sin la columna nombrada sin duplicar. Ante CUALQUIER otro error no se
//    reintenta.
//  · GUARDAR ES UN SOLO UPDATE con `.eq("version", v)`. Cero filas → se relee: si la versión cambió,
//    «otra persona guardó» (con quién y cuándo); no se fusiona nada (decisión R1).
//  · Las unidades y conductores del contexto son SOLO los elegidos en el doc (el doc guarda claves,
//    D2): todo lo demás (año, vencimientos, archivos) se DERIVA al abrir.
//  · Tri-estado de los conductores tercerizados: `conductores_tercero` no tiene examen médico,
//    antecedentes ni psicosomático → esas claves NO existen en su ConductorERP (undefined), que no es
//    lo mismo que null (la columna existe y está vacía).
//  · El archivo se identifica por su enlace público (getPublicUrl), como el resto del ERP; quien lo
//    pinta lo firma (components/ArchivoPrivado). Nunca se guarda un enlace firmado.
//  · El mime con que se SUBE sale de la lista permitida y del contenido del archivo, nunca de lo que
//    diga `file.type` a secas: un .exe renombrado a .pdf no se sube como PDF.
//
// EL CLIENTE: por defecto el del navegador (lib/supabase.ts), importado AL USARLO para que la matriz
// inyecte uno falso con `fijarClienteDatos` sin cargar supabase-js ni pedir variables de entorno.
// Matriz: npx tsx scripts/prueba-licitaciones-datos.mts
// ──────────────────────────────────────────────────────────────────────────────

import { todasLasPaginas, LecturaIncompleta } from "@/lib/paginar-estricto";
import { columnaFaltante, tablaFaltante, type ErrorSupabase } from "@/lib/columna-faltante";
import { cargarSeguros, type ResultadoSeguros } from "@/lib/seguros-datos";
import { estaActivo } from "@/lib/seguros";
import { tipoCanonico, fechaLima, docSinVencimiento, TIPOS_DOC_UNIDAD } from "@/lib/documentos-estado";
import { estadoParaColumna, etiquetaCategoria } from "@/lib/documentos-empresa-categorias";
import { hashArchivo } from "@/lib/finanzas/caja-chica";
import { guardarDocumentoVehiculo } from "@/lib/documentos-vehiculo-datos";
import { rutaNueva, mimeDeNombre, esMimePermitido, extDeMime, MIMES_PERMITIDOS } from "./archivos";
import { normalizarDoc, normalizarArchivo, bytesDoc } from "./normalizar";
import { esFechaISO, textoONull, textoCorto, enteroEn, claveRecurso, esObjeto, lista } from "./util";
import {
  BUCKET_LICITACIONES, CODIGOS_LEGAJO, CODIGOS_DOC_CONDUCTOR, CANONICOS_DOC_UNIDAD, COLUMNAS_EDITABLES,
  ESTADOS_LICITACION, TOPES_DOC,
  type ArchivoRef, type CarpetaLicitacion, type ClaveRecurso, type CodigoDocConductor, type CodigoLegajo,
  type ConductorERP, type ContextoLicitacion, type DocLicitacion, type DocUnidadERP, type EmpresaTerceroERP,
  type EstadoLectura, type EstadoLicitacion, type Experiencia, type FechaISO, type FilaDocEmpresa, type FilaEmision,
  type Flota, type FuenteContexto, type InstanteISO, type Licitacion, type MimeArchivo, type Moneda,
  type OtraLicitacion, type PersonaERP, type SustentoTipo, type UnidadERP,
} from "./tipos";

// ══ Cliente ═══════════════════════════════════════════════════════════════════
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClienteDb = any;
let clienteFijado: ClienteDb | null = null;
/** Inyecta el cliente (la matriz usa uno falso en memoria). `null` vuelve al del navegador. */
export function fijarClienteDatos(db: ClienteDb | null): void { clienteFijado = db; }
async function cliente(): Promise<ClienteDb> {
  if (clienteFijado) return clienteFijado;
  return (await import("@/lib/supabase")).supabase;
}

// ══ Migraciones que el código nombra cuando faltan ═════════════════════════════
export const SQL_LICITACIONES = {
  tablas: "supabase/licitaciones-01a-tablas.sql",
  rls: "supabase/licitaciones-01b-rls.sql",
  experiencia: "supabase/licitaciones-02-experiencia.sql",
  bucket: "supabase/licitaciones-03-bucket.sql",
  accesorias: "supabase/licitaciones-04-columnas-accesorias.sql",
} as const;

// ══ Resultados ════════════════════════════════════════════════════════════════
export type FalloDatos = { ok: false; error: string; sinMigracion?: string; sinPermiso?: boolean; noExiste?: boolean };
export type Resultado<T extends object> = ({ ok: true } & T) | FalloDatos;

/** Lo que LANZA `subirArchivo` (su firma devuelve el ArchivoRef). El mensaje ya es para el operador. */
export class ErrorLicitaciones extends Error {
  readonly sinMigracion: string | null;
  readonly sinPermiso: boolean;
  constructor(mensaje: string, extra: { sinMigracion?: string | null; sinPermiso?: boolean } = {}) {
    super(mensaje);
    this.name = "ErrorLicitaciones";
    this.sinMigracion = extra.sinMigracion ?? null;
    this.sinPermiso = extra.sinPermiso ?? false;
  }
}

// ══ Errores en castellano ═════════════════════════════════════════════════════
type Err = (ErrorSupabase & { details?: string | null; statusCode?: string | number | null; error?: string | null }) | null | undefined;
type Contexto = { accion: string; tabla: string; sql?: string; modulo?: string };

const msgDe = (e: unknown): string => {
  if (!e) return "";
  if (typeof e === "string") return e;
  const o = e as { message?: unknown; error?: unknown };
  return String(o.message ?? o.error ?? e);
};
const esRed = (m: string) => /failed to fetch|networkerror|network request failed|load failed|fetch failed|err_network/i.test(m);
const esPermiso = (e: Err) => String(e?.code ?? "") === "42501" || /row-level security|permission denied/i.test(msgDe(e));

/** Lo que dice la base, en castellano y con dónde se arregla. Nunca el mensaje crudo de Postgres solo. */
function explicar(e: Err, ctx: Contexto): FalloDatos {
  const m = msgDe(e);
  const sql = ctx.sql ? ` Corre ${ctx.sql} en Supabase → SQL Editor.` : "";
  if (tablaFaltante(e, ctx.tabla)) {
    return { ok: false, error: `No se pudo ${ctx.accion}: falta la tabla ${ctx.tabla}.${sql}`, ...(ctx.sql ? { sinMigracion: ctx.sql } : {}) };
  }
  const col = columnaFaltante(e);
  if (col != null) {
    return { ok: false, error: `No se pudo ${ctx.accion}: a la tabla ${ctx.tabla} le falta la columna ${col || "que pide el ERP"}.${sql}`, ...(ctx.sql ? { sinMigracion: ctx.sql } : {}) };
  }
  if (esPermiso(e)) {
    const modulo = ctx.modulo ?? "Licitaciones";
    const rls = modulo === "Licitaciones" ? ` (o falta correr ${SQL_LICITACIONES.rls})` : "";
    return { ok: false, sinPermiso: true, error: `No se pudo ${ctx.accion}: tu usuario no tiene el permiso del módulo ${modulo}${rls}. Lo da un administrador en Usuarios.` };
  }
  const code = String(e?.code ?? "");
  if (code === "23514") {
    const regla = /check constraint "([^"]+)"/i.exec(m)?.[1];
    return { ok: false, error: `No se pudo ${ctx.accion}: un dato no cumple la regla ${regla ? `«${regla}» ` : ""}de la tabla ${ctx.tabla}. Revisa los campos y vuelve a intentarlo.` };
  }
  if (code === "23503") return { ok: false, error: `No se pudo ${ctx.accion}: un dato apunta a un registro que ya no existe (por ejemplo, un cliente borrado). Recarga y vuelve a elegirlo.` };
  if (code === "23505") return { ok: false, error: `No se pudo ${ctx.accion}: ya existe un registro igual en ${ctx.tabla}.` };
  if (code === "22001") return { ok: false, error: `No se pudo ${ctx.accion}: un texto es más largo de lo que admite la tabla ${ctx.tabla}.` };
  if (esRed(m)) return { ok: false, error: `No se pudo ${ctx.accion}: no hay conexión con la base. Revisa tu red y vuelve a intentarlo.` };
  return { ok: false, error: `No se pudo ${ctx.accion}${m ? ` (la base respondió: ${m})` : ""}.` };
}

/** Errores del almacenamiento (storage-js): bucket faltante, permiso, tipo, tamaño. */
function explicarStorage(e: Err, bucket: string, nombre: string, sql?: string): FalloDatos {
  const m = msgDe(e);
  const st = String(e?.statusCode ?? "");
  if (/bucket not found/i.test(m)) {
    return { ok: false, error: `No se pudo subir «${nombre}»: falta el almacenamiento «${bucket}».${sql ? ` Corre ${sql} en Supabase → SQL Editor.` : ""}`, ...(sql ? { sinMigracion: sql } : {}) };
  }
  if (/row-level security|unauthorized|permission|not allowed/i.test(m) || st === "403" || st === "401") {
    return { ok: false, sinPermiso: true, error: `No se pudo subir «${nombre}» a «${bucket}»: tu usuario no tiene permiso de subir ahí${bucket === BUCKET_LICITACIONES ? ` (módulo Licitaciones, o falta correr ${SQL_LICITACIONES.bucket})` : ""}.` };
  }
  if (/mime type|not supported|invalid_mime/i.test(m) || st === "415") {
    return { ok: false, error: `No se pudo subir «${nombre}»: el almacenamiento «${bucket}» no acepta ese tipo de archivo. Súbelo como PDF, PNG o JPG.` };
  }
  if (/exceeded the maximum|too large|payload too large|entity too large/i.test(m) || st === "413") {
    return { ok: false, error: `No se pudo subir «${nombre}»: pesa más de lo que acepta el almacenamiento «${bucket}». Comprímelo o divídelo.` };
  }
  if (/already exists|duplicate/i.test(m) || st === "409") {
    return { ok: false, error: `No se pudo subir «${nombre}»: ya hay un archivo con ese identificador. Vuelve a intentarlo.` };
  }
  if (esRed(m)) return { ok: false, error: `No se pudo subir «${nombre}»: no hay conexión. Revisa tu red y vuelve a intentarlo.` };
  return { ok: false, error: `No se pudo subir «${nombre}»${m ? ` (el almacenamiento respondió: ${m})` : ""}.` };
}

const aExcepcion = (f: FalloDatos) => new ErrorLicitaciones(f.error, { sinMigracion: f.sinMigracion, sinPermiso: f.sinPermiso });

// ══ Lectura paginada con columnas accesorias ═══════════════════════════════════
type Fila = Record<string, unknown>;
type Lectura = { estado: EstadoLectura; filas: Fila[]; soltadas: string[]; error: string | null; causa: Err; faltaColumna: string | null };
type Orden = { col: string; asc?: boolean; nullsFirst?: boolean };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;

const LECTURA_VACIA: Lectura = { estado: "ok", filas: [], soltadas: [], error: null, causa: null, faltaColumna: null };

/**
 * Lee TODA la consulta o declara la fuente: "ok" con sus filas, "sin_tabla", o "error" SIN filas
 * (media lista es peor que ninguna: haría decir «falta» a la revisión). Si el error nombra una
 * columna de `opcionales`, se suelta SOLO esa y se relee desde cero.
 */
async function leer(db: ClienteDb, tabla: string, columnas: readonly string[], opcionales: readonly string[],
  filtrar: (q: Q) => Q = (q) => q, orden: readonly Orden[] = [{ col: "id" }]): Promise<Lectura> {
  let cols = [...columnas];
  const soltadas: string[] = [];
  for (;;) {
    try {
      const filas = await todasLasPaginas<Fila>(() => {
        let q = filtrar(db.from(tabla).select(cols.join(",")));
        for (const o of orden) q = q.order(o.col, { ascending: o.asc ?? true, ...(o.nullsFirst != null ? { nullsFirst: o.nullsFirst } : {}) });
        return q;
      });
      return { estado: "ok", filas, soltadas, error: null, causa: null, faltaColumna: null };
    } catch (e) {
      const causa: Err = e instanceof LecturaIncompleta ? (e.causa as Err) : { message: msgDe(e) };
      if (causa && tablaFaltante(causa, tabla)) return { estado: "sin_tabla", filas: [], soltadas, error: msgDe(causa), causa, faltaColumna: null };
      const col = causa ? columnaFaltante(causa) : null;
      if (col && opcionales.includes(col) && cols.includes(col)) {
        cols = cols.filter((c) => c !== col);
        soltadas.push(col);
        continue;
      }
      return { estado: "error", filas: [], soltadas, error: msgDe(causa) || msgDe(e), causa, faltaColumna: col || null };
    }
  }
}

const TANDA_IDS = 150; // ids por petición: un .in() de cientos de ids alarga la URL más de lo que aguanta un proxy

/** `leer` por tandas de ids. Una tanda fallida deja la fuente entera en error (sin filas). */
async function leerPorIds(db: ClienteDb, tabla: string, columnas: readonly string[], opcionales: readonly string[],
  campo: string, ids: readonly number[], extra: (q: Q) => Q = (q) => q, orden: readonly Orden[] = [{ col: "id" }]): Promise<Lectura> {
  const unicos = [...new Set(ids)];
  if (!unicos.length) return { ...LECTURA_VACIA, filas: [], soltadas: [] };
  const filas: Fila[] = [];
  const soltadas = new Set<string>();
  for (let i = 0; i < unicos.length; i += TANDA_IDS) {
    const parte = unicos.slice(i, i + TANDA_IDS);
    const l = await leer(db, tabla, columnas, opcionales, (q) => extra(q.in(campo, parte)), orden);
    l.soltadas.forEach((c) => soltadas.add(c));
    if (l.estado !== "ok") return { ...l, filas: [], soltadas: [...soltadas] };
    filas.push(...l.filas);
  }
  return { estado: "ok", filas, soltadas: [...soltadas], error: null, causa: null, faltaColumna: null };
}

const peor = (...e: EstadoLectura[]): EstadoLectura => e.includes("error") ? "error" : e.includes("sin_tabla") ? "sin_tabla" : "ok";

// ══ Conversión de filas ═══════════════════════════════════════════════════════
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const ent = (v: unknown): number | null => { const n = Number(v); return v != null && v !== "" && Number.isSafeInteger(n) ? n : null; };
const num = (v: unknown): number | null => { const n = Number(v); return v != null && v !== "" && Number.isFinite(n) ? n : null; };
const fecha = (v: unknown): FechaISO | null => (typeof v === "string" && esFechaISO(v.slice(0, 10)) ? v.slice(0, 10) : null);
const instante = (v: unknown): InstanteISO => (typeof v === "string" ? v : "");
/** "HH:MM" (la columna es `time` y devuelve "HH:MM:SS"; los segundos no se teclean nunca). */
const hora = (v: unknown): string | null => {
  const m = typeof v === "string" ? /^([01]\d|2[0-3]):([0-5]\d)/.exec(v) : null;
  return m ? `${m[1]}:${m[2]}` : null;
};
const enteros = (xs: unknown[]): number[] => [...new Set(xs.map((x) => ent(x)).filter((n): n is number => n != null && n > 0))];

/** Identificador estable del navegador (uuid v4). crypto.randomUUID en contexto seguro; si no, getRandomValues. */
export function nuevoUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  if (c && typeof c.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  throw new ErrorLicitaciones("Este navegador no puede generar identificadores seguros: abre el ERP con https en un navegador actualizado.");
}

/** Partir claves "p:12"/"t:5" en ids por flota (las inválidas se ignoran: normalizarDoc ya las limpió). */
function partirClaves(claves: unknown[]): Record<Flota, number[]> {
  const r: Record<Flota, number[]> = { p: [], t: [] };
  for (const x of claves) {
    const c = claveRecurso(x);
    if (!c) continue;
    const id = Number(c.slice(2));
    const f = c[0] as Flota;
    if (!r[f].includes(id)) r[f].push(id);
  }
  return r;
}

// ══ Licitaciones: columnas, filas y validación ═════════════════════════════════
const COLS_LISTA = [
  "id", "nombre", "cliente_id", "cliente_nombre", "codigo", "objeto", "atencion", "fecha_consultas", "fecha_presentacion",
  "hora_presentacion", "fecha_inicio_servicio", "plazo_meses", "estado", "archivada", "version",
  "creado_por", "creado_en", "actualizado_por", "actualizado_en"] as const;
const COLS_FILA = [...COLS_LISTA, "doc"].join(",");

function columnasDeLicitacion(r: Fila): Omit<Licitacion, "doc"> {
  const estado = (ESTADOS_LICITACION as readonly string[]).includes(String(r.estado)) ? (r.estado as EstadoLicitacion) : "preparacion";
  return {
    id: Number(r.id), nombre: String(r.nombre ?? ""), cliente_id: ent(r.cliente_id), cliente_nombre: String(r.cliente_nombre ?? ""),
    codigo: str(r.codigo), objeto: str(r.objeto), atencion: str(r.atencion),
    fecha_consultas: fecha(r.fecha_consultas), fecha_presentacion: fecha(r.fecha_presentacion),
    hora_presentacion: hora(r.hora_presentacion), fecha_inicio_servicio: fecha(r.fecha_inicio_servicio),
    plazo_meses: ent(r.plazo_meses), estado, archivada: r.archivada === true, version: Number(r.version) || 1,
    creado_por: str(r.creado_por), creado_en: instante(r.creado_en),
    actualizado_por: str(r.actualizado_por), actualizado_en: instante(r.actualizado_en),
  };
}
const aLicitacion = (r: Fila): Licitacion => ({ ...columnasDeLicitacion(r), doc: normalizarDoc(r.doc ?? {}, nuevoUuid) });

type ColumnaEditable = typeof COLUMNAS_EDITABLES[number];
export type CambiosLicitacion = Partial<Pick<Licitacion, ColumnaEditable>>;
export type DatosLicitacionNueva = {
  nombre: string; cliente_id: number | null; cliente_nombre: string;
  codigo?: string | null; objeto?: string | null; atencion?: string | null;
  fecha_consultas?: FechaISO | null; fecha_presentacion?: FechaISO | null; hora_presentacion?: string | null;
  fecha_inicio_servicio?: FechaISO | null; plazo_meses?: number | null; estado?: EstadoLicitacion;
};

const largo = (s: string) => [...s].length;
const tiene = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Valida y limpia las columnas que van a la base (las mismas reglas que los CHECK de 01a, dichas en
 * castellano ANTES de mandar nada). Solo procesa las claves presentes. `nueva` exige nombre y cliente.
 */
function limpiarColumnas(c: Record<string, unknown>, nueva: boolean): { patch: Record<string, unknown> } | { error: string } {
  const patch: Record<string, unknown> = {};
  const texto = (k: string, max: number, rotulo: string, obligatorio: boolean): string | null => {
    if (!tiene(c, k)) { if (obligatorio && nueva) throw new Error(`Falta ${rotulo}.`); return null; }
    const v = c[k];
    const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
    if (!s) { if (obligatorio) throw new Error(`Falta ${rotulo}.`); patch[k] = null; return null; }
    if (largo(s) > max) throw new Error(`${rotulo[0].toUpperCase()}${rotulo.slice(1)} pasa de ${max} caracteres.`);
    patch[k] = s;
    return s;
  };
  try {
    texto("nombre", 200, "el nombre de la licitación", true);
    texto("cliente_nombre", 200, "el cliente (la entidad que convoca)", true);
    texto("codigo", 80, "el código del concurso", false);
    texto("objeto", 2000, "el objeto del servicio", false);
    texto("atencion", 200, "el campo «Atención»", false);
    if (tiene(c, "cliente_id")) {
      const v = c.cliente_id;
      if (v == null || v === "") patch.cliente_id = null;
      else { const n = enteroEn(v, 1, Number.MAX_SAFE_INTEGER); if (n == null) throw new Error("El cliente elegido no es válido: vuelve a elegirlo."); patch.cliente_id = n; }
    }
    const rotulosFecha: Record<string, string> = {
      fecha_consultas: "la fecha de consultas", fecha_presentacion: "la fecha de presentación", fecha_inicio_servicio: "la fecha de inicio del servicio",
    };
    for (const k of Object.keys(rotulosFecha)) {
      if (!tiene(c, k)) continue;
      const v = c[k];
      if (v == null || v === "") { patch[k] = null; continue; }
      if (!esFechaISO(v)) throw new Error(`${rotulosFecha[k][0].toUpperCase()}${rotulosFecha[k].slice(1)} no es una fecha válida (AAAA-MM-DD).`);
      patch[k] = v;
    }
    if (tiene(c, "hora_presentacion")) {
      const v = c.hora_presentacion;
      if (v == null || v === "") patch.hora_presentacion = null;
      else { const h = typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(v) ? v.slice(0, 5) : null; if (!h) throw new Error("La hora de presentación no es válida (HH:MM)."); patch.hora_presentacion = h; }
    }
    if (tiene(c, "plazo_meses")) {
      const v = c.plazo_meses;
      if (v == null || v === "") patch.plazo_meses = null;
      else { const n = enteroEn(v, 1, 240); if (n == null) throw new Error("El plazo debe ser un número entero de meses entre 1 y 240."); patch.plazo_meses = n; }
    }
    if (tiene(c, "estado")) {
      if (!(ESTADOS_LICITACION as readonly string[]).includes(String(c.estado))) throw new Error("El estado de la licitación no es válido.");
      patch.estado = c.estado;
    }
    if (tiene(c, "archivada")) {
      if (typeof c.archivada !== "boolean") throw new Error("«Archivada» debe ser sí o no.");
      patch.archivada = c.archivada;
    }
  } catch (e) {
    return { error: msgDe(e) };
  }
  return { patch };
}

/** El doc normalizado (topes de TOPES_DOC) y su peso, o el motivo por el que no se puede guardar. */
function docParaGuardar(raw: unknown): { doc: DocLicitacion } | { error: string } {
  let doc: DocLicitacion;
  try { doc = normalizarDoc(raw, nuevoUuid); } catch (e) { return { error: `El documento de la licitación no es válido (${msgDe(e)}).` }; }
  const bytes = bytesDoc(doc);
  if (bytes > TOPES_DOC.maxBytesDoc) {
    const mb = (n: number) => (n / 1_000_000).toFixed(1);
    return { error: `La licitación pesa ${mb(bytes)} MB y el tope es ${mb(TOPES_DOC.maxBytesDoc)} MB: quita secciones o tablas largas (los archivos no cuentan, van aparte).` };
  }
  return { doc };
}

/** Nombres de usuarios por id (best-effort: sin acceso a `usuarios`, el nombre queda en null). */
async function nombresDeUsuarios(db: ClienteDb, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unicos = [...new Set(ids.filter((x): x is string => typeof x === "string" && !!x))];
  const m = new Map<string, string>();
  if (!unicos.length) return m;
  try {
    for (let i = 0; i < unicos.length; i += TANDA_IDS) {
      const { data, error } = await db.from("usuarios").select("id, nombre").in("id", unicos.slice(i, i + TANDA_IDS));
      if (error) return m;
      for (const u of (data ?? []) as Fila[]) if (str(u.nombre)) m.set(String(u.id), String(u.nombre).trim());
    }
  } catch { /* best-effort */ }
  return m;
}

// ══ Licitaciones: lista, una, crear, guardar, duplicar, archivar ════════════════
export type ResumenEmision = { version: number; emitido_en: InstanteISO; emitido_por: string | null; emitido_por_nombre: string | null };
export type FilaListaLicitacion = Omit<Licitacion, "doc"> & { actualizado_por_nombre: string | null; ultimaEmision: ResumenEmision | null };

/**
 * La lista liviana (sin `doc`) con la última emisión de cada una. `archivadas`: false/omitido = solo las
 * vigentes · true = solo las archivadas · "todas". Orden: presentación más reciente primero (sin fecha al
 * final), id de desempate (orden total). Si las emisiones no se pueden leer, la lista sale igual y
 * `emisiones` lo dice — nunca se afirma «sin emitir» por un error.
 */
export async function leerLicitaciones(opts: { archivadas?: boolean | "todas" } = {}): Promise<Resultado<{
  filas: FilaListaLicitacion[]; emisiones: EstadoLectura; avisos: string[];
}>> {
  const db = await cliente();
  const arch = opts.archivadas ?? false;
  const l = await leer(db, "licitaciones", COLS_LISTA, [],
    (q) => (arch === "todas" ? q : q.eq("archivada", arch === true)),
    [{ col: "fecha_presentacion", asc: false, nullsFirst: false }, { col: "id", asc: false }]);
  if (l.estado !== "ok") return explicar(l.causa, { accion: "leer las licitaciones", tabla: "licitaciones", sql: SQL_LICITACIONES.tablas });
  const filas = l.filas.map(columnasDeLicitacion);
  const avisos: string[] = [];
  const ids = filas.map((f) => f.id);
  const em = ids.length
    ? await leerPorIds(db, "licitacion_emisiones", ["id", "licitacion_id", "version", "emitido_en", "emitido_por"], [], "licitacion_id", ids)
    : LECTURA_VACIA;
  if (em.estado === "sin_tabla") avisos.push(`No se pueden leer las emisiones: falta la tabla licitacion_emisiones (corre ${SQL_LICITACIONES.tablas}).`);
  if (em.estado === "error") avisos.push(`No se pudieron leer las emisiones (${em.error}): la columna «Última emisión» no se muestra. Recarga para reintentar.`);
  const ultima = new Map<number, Fila>();
  for (const e of em.filas) {
    const lid = Number(e.licitacion_id);
    const prev = ultima.get(lid);
    if (!prev || Number(e.version) > Number(prev.version)) ultima.set(lid, e);
  }
  const nombres = await nombresDeUsuarios(db, [...filas.map((f) => f.actualizado_por), ...[...ultima.values()].map((e) => str(e.emitido_por))]);
  return {
    ok: true, emisiones: em.estado, avisos,
    filas: filas.map((f) => {
      const e = ultima.get(f.id);
      return {
        ...f, actualizado_por_nombre: f.actualizado_por ? nombres.get(f.actualizado_por) ?? null : null,
        ultimaEmision: e ? { version: Number(e.version), emitido_en: instante(e.emitido_en), emitido_por: str(e.emitido_por), emitido_por_nombre: nombres.get(String(e.emitido_por)) ?? null } : null,
      };
    }),
  };
}

/** La licitación completa, con su doc normalizado. */
export async function leerLicitacion(id: number): Promise<Resultado<{ lic: Licitacion }>> {
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, noExiste: true, error: "La licitación pedida no es válida." };
  const db = await cliente();
  const { data, error } = await db.from("licitaciones").select(COLS_FILA).eq("id", id).maybeSingle();
  if (error) return explicar(error, { accion: "abrir la licitación", tabla: "licitaciones", sql: SQL_LICITACIONES.tablas });
  if (!data) return { ok: false, noExiste: true, error: `La licitación N° ${id} no existe o tu usuario no tiene el permiso del módulo Licitaciones.` };
  return { ok: true, lic: aLicitacion(data as Fila) };
}

/** Crea una licitación (versión 1; quién y cuándo los pone el trigger). */
export async function crearLicitacion(datos: DatosLicitacionNueva, doc: DocLicitacion): Promise<Resultado<{ lic: Licitacion }>> {
  const c = limpiarColumnas({ estado: "preparacion", ...datos }, true);
  if ("error" in c) return { ok: false, error: c.error };
  const d = docParaGuardar(doc);
  if ("error" in d) return { ok: false, error: d.error };
  const db = await cliente();
  const { data, error } = await db.from("licitaciones").insert({ ...c.patch, archivada: false, doc: d.doc }).select(COLS_FILA);
  if (error) return explicar(error, { accion: "crear la licitación", tabla: "licitaciones", sql: SQL_LICITACIONES.tablas });
  const fila = ((data ?? []) as Fila[])[0];
  if (!fila) return { ok: false, sinPermiso: true, error: `La licitación no se pudo leer después de crearla: revisa el permiso del módulo Licitaciones (o falta correr ${SQL_LICITACIONES.rls}).` };
  return { ok: true, lic: aLicitacion(fila) };
}

export type ResultadoGuardar =
  | { ok: true; lic: Licitacion }
  | { ok: false; conflicto: true; version: number; por: string | null; porId: string | null; en: InstanteISO }
  | { ok: false; conflicto: false; error: string; sinMigracion?: string; sinPermiso?: boolean; noExiste?: boolean };

/**
 * Guarda con BLOQUEO OPTIMISTA: un solo UPDATE … where id = lic.id and version = lic.version (el trigger
 * sube la versión y sella quién/cuándo). Cero filas → se relee: versión distinta = conflicto con quién y
 * cuándo guardó; fila ausente = no existe (o sin permiso). Solo viajan las columnas de COLUMNAS_EDITABLES
 * presentes en `cambios`; el doc se normaliza (topes) antes de mandarlo. Sin cambios no se llama a la base.
 */
export async function guardarLicitacion(lic: Licitacion, cambios: CambiosLicitacion): Promise<ResultadoGuardar> {
  const mal = (f: FalloDatos): ResultadoGuardar => ({ ...f, conflicto: false });
  const entrada: Record<string, unknown> = {};
  for (const k of COLUMNAS_EDITABLES) if (tiene(cambios, k)) entrada[k] = (cambios as Record<string, unknown>)[k];
  if (!Object.keys(entrada).length) return { ok: true, lic };
  const c = limpiarColumnas(entrada, false);
  if ("error" in c) return { ok: false, conflicto: false, error: c.error };
  const patch = { ...c.patch };
  if (tiene(entrada, "doc")) {
    const d = docParaGuardar(entrada.doc);
    if ("error" in d) return { ok: false, conflicto: false, error: d.error };
    patch.doc = d.doc;
  }
  const db = await cliente();
  const { data, error } = await db.from("licitaciones").update(patch).eq("id", lic.id).eq("version", lic.version).select(COLS_FILA);
  if (error) return mal(explicar(error, { accion: "guardar la licitación", tabla: "licitaciones", sql: SQL_LICITACIONES.tablas }));
  const fila = ((data ?? []) as Fila[])[0];
  if (fila) return { ok: true, lic: aLicitacion(fila) };
  // Cero filas: ¿otra persona guardó, ya no existe, o la base no dejó?
  const r = await db.from("licitaciones").select("id, version, actualizado_por, actualizado_en").eq("id", lic.id).maybeSingle();
  if (r.error) return mal(explicar(r.error, { accion: "comprobar si otra persona guardó la licitación (no se guardó nada)", tabla: "licitaciones", sql: SQL_LICITACIONES.tablas }));
  if (!r.data) return { ok: false, conflicto: false, noExiste: true, error: `No se guardó: la licitación N° ${lic.id} ya no existe o tu usuario no tiene el permiso del módulo Licitaciones.` };
  const actual = r.data as Fila;
  if (Number(actual.version) !== lic.version) {
    const porId = str(actual.actualizado_por);
    const nombres = await nombresDeUsuarios(db, [porId]);
    return { ok: false, conflicto: true, version: Number(actual.version), por: porId ? nombres.get(porId) ?? null : null, porId, en: instante(actual.actualizado_en) };
  }
  return { ok: false, conflicto: false, sinPermiso: true, error: `No se guardó: la base no aceptó el cambio. Revisa que tu usuario tenga el permiso del módulo Licitaciones (o que esté corrida ${SQL_LICITACIONES.rls}).` };
}

/**
 * Crea una licitación nueva a partir de otra. Se copian el cliente, el objeto, «Atención» y el plazo;
 * NO el código ni las fechas (son del concurso nuevo). `datos` pisa cualquiera de ellos. El doc ya viene
 * armado (duplicarDoc de normalizar.ts, con su `copiaDe`).
 */
export async function duplicarLicitacion(origen: Licitacion, nombre: string, docNuevo: DocLicitacion,
  datos: Partial<DatosLicitacionNueva> = {}): Promise<Resultado<{ lic: Licitacion }>> {
  return crearLicitacion({
    nombre, cliente_id: origen.cliente_id, cliente_nombre: origen.cliente_nombre, objeto: origen.objeto,
    atencion: origen.atencion, plazo_meses: origen.plazo_meses, codigo: null, fecha_consultas: null,
    fecha_presentacion: null, hora_presentacion: null, fecha_inicio_servicio: null, estado: "preparacion", ...datos,
  }, docNuevo);
}

/**
 * Archiva o desarchiva. Sube la versión (el trigger): quien la tenga abierta verá «otra persona guardó»
 * al guardar, que es cierto. Devuelve la versión nueva para que la pantalla la adopte.
 */
export async function archivarLicitacion(id: number, archivada: boolean): Promise<Resultado<{ version: number; archivada: boolean; actualizado_en: InstanteISO }>> {
  const db = await cliente();
  const { data, error } = await db.from("licitaciones").update({ archivada: archivada === true }).eq("id", id).select("id, version, archivada, actualizado_en");
  if (error) return explicar(error, { accion: archivada ? "archivar la licitación" : "desarchivar la licitación", tabla: "licitaciones", sql: SQL_LICITACIONES.tablas });
  const f = ((data ?? []) as Fila[])[0];
  if (!f) return { ok: false, noExiste: true, error: `La licitación N° ${id} no existe o tu usuario no tiene el permiso del módulo Licitaciones.` };
  return { ok: true, version: Number(f.version), archivada: f.archivada === true, actualizado_en: instante(f.actualizado_en) };
}

// ══ Contexto que consume la revisión ═══════════════════════════════════════════
const COLS_PERFIL = ["nombre", "razon_social", "ruc", "logo_url", "logo_claro_url", "telefono", "email", "direccion", "web", "autorizacion_mtc", "fecha_constitucion"];
const OPC_PERFIL = ["logo_claro_url", "autorizacion_mtc", "fecha_constitucion"];
const COLS_VEH = ["id", "placa", "marca", "modelo", "anio", "capacidad_pasajeros", "categoria", "estado", "foto_externa_url", "foto_interna_url"];
const OPC_VEH = ["foto_externa_url", "foto_interna_url"];
const COLS_VT = ["id", "empresa_id", "placa", "marca", "modelo", "anio", "capacidad", "categoria", "estado", "foto_externa_url", "foto_interna_url"];
const OPC_VT = ["anio", "foto_externa_url", "foto_interna_url"];
const COLS_EMP = ["id", "razon_social", "ruc", "autorizacion_mtc", "venc_autorizacion", "estado"];
const OPC_EMP = ["ruc", "autorizacion_mtc", "venc_autorizacion"];
const COLS_DV = ["id", "vehiculo_id", "tipo", "numero", "fecha_emision", "fecha_vencimiento", "entidad_emisora", "archivo_url"];
const COLS_DT = ["id", "empresa_id", "vehiculo_id", "tipo", "numero", "fecha_emision", "fecha_vencimiento", "entidad_emisora", "archivo_url"];
/** Las mismas que suelta lib/seguros-datos.ts en esas dos tablas (las escriben /vehiculos y /tercerizadas). */
const OPC_DOC = ["numero", "fecha_emision", "entidad_emisora", "archivo_url"];
const VENC_COND = ["examen_medico_venc", "antecedentes_venc", "psicosometrico_venc"] as const;
const COLS_COND = ["id", "nombre", "dni", "licencia", "categoria_licencia", "vencimiento_licencia", ...VENC_COND, "estado"];
const COLS_CT = ["id", "empresa_id", "nombre", "dni", "licencia", "categoria_licencia", "vencimiento_licencia", "estado"];
const OPC_CT = ["estado"];
const COLS_DE = ["id", "titulo", "categoria", "alcance", "archivo_url", "archivo_nombre", "fecha_emision", "fecha_vencimiento", "conductor_id", "conductor_tercero_id", "created_at"];
const COLS_EXP = [
  "id", "cliente_id", "cliente_nombre", "cliente_ruc", "contacto_nombre", "contacto_cargo", "contacto_telefono", "contacto_email",
  "objeto", "sector", "zona", "inicio", "fin", "vigente", "sustento_tipo", "sustento_ref", "sustento_fecha", "importe", "moneda",
  "importe_incluye_igv", "sustentos", "notas", "activo"];
const COLS_PERS = ["id", "nombre", "dni", "cargo", "telefono", "email"];

function aEmpresa(r: Fila): EmpresaTerceroERP {
  return { id: Number(r.id), razon_social: String(r.razon_social ?? `Empresa #${r.id}`), ruc: str(r.ruc), autorizacion_mtc: str(r.autorizacion_mtc), venc_autorizacion: fecha(r.venc_autorizacion), estado: str(r.estado) };
}
function aDocUnidad(r: Fila, origen: DocUnidadERP["origen"], deEmpresa: boolean): DocUnidadERP {
  const tipo = String(r.tipo ?? "");
  return {
    origen, id: Number(r.id), tipo, canonico: tipoCanonico(tipo)?.canonico ?? null, numero: str(r.numero),
    fecha_emision: fecha(r.fecha_emision), fecha_vencimiento: fecha(r.fecha_vencimiento), archivo_url: str(r.archivo_url), deEmpresa,
    entidad_emisora: str(r.entidad_emisora),
  };
}
function aFilaDoc(r: Fila): FilaDocEmpresa {
  return {
    id: Number(r.id), titulo: String(r.titulo ?? ""), categoria: String(r.categoria ?? ""), alcance: String(r.alcance ?? ""),
    archivo_url: str(r.archivo_url), archivo_nombre: str(r.archivo_nombre), fecha_emision: fecha(r.fecha_emision),
    fecha_vencimiento: fecha(r.fecha_vencimiento), conductor_id: ent(r.conductor_id), conductor_tercero_id: ent(r.conductor_tercero_id),
    created_at: instante(r.created_at),
  };
}
const SUSTENTOS: readonly SustentoTipo[] = ["oc", "factura", "carta", "contrato", "conformidad", "otro"];
/** Un ArchivoRef leído de jsonb, con la MISMA regla que el doc (normalizarArchivo); sin url no hay archivo. */
const aArchivoRef = (x: unknown): ArchivoRef | null =>
  normalizarArchivo(x, (id) => (typeof id === "string" && id.trim() ? id.trim().slice(0, 80) : nuevoUuid()));
function aExperiencia(r: Fila): Experiencia {
  const st = String(r.sustento_tipo ?? "");
  return {
    id: Number(r.id), cliente_id: ent(r.cliente_id), cliente_nombre: String(r.cliente_nombre ?? ""), cliente_ruc: str(r.cliente_ruc),
    contacto_nombre: str(r.contacto_nombre), contacto_cargo: str(r.contacto_cargo), contacto_telefono: str(r.contacto_telefono), contacto_email: str(r.contacto_email),
    objeto: String(r.objeto ?? ""), sector: str(r.sector), zona: str(r.zona), inicio: fecha(r.inicio) ?? "", fin: fecha(r.fin), vigente: r.vigente === true,
    sustento_tipo: (SUSTENTOS as readonly string[]).includes(st) ? (st as SustentoTipo) : null, sustento_ref: str(r.sustento_ref), sustento_fecha: fecha(r.sustento_fecha),
    importe: num(r.importe), moneda: r.moneda === "USD" ? "USD" : "PEN",
    importe_incluye_igv: typeof r.importe_incluye_igv === "boolean" ? r.importe_incluye_igv : null,
    sustentos: lista(r.sustentos).map(aArchivoRef).filter((a): a is ArchivoRef => !!a), notas: str(r.notas), activo: r.activo !== false,
  };
}
function aPersona(r: Fila): PersonaERP {
  return { id: Number(r.id), nombre: String(r.nombre ?? `#${r.id}`), dni: str(r.dni), cargo: str(r.cargo), telefono: str(r.telefono), email: str(r.email) };
}

/** El perfil de la empresa (fila única). `fecha_constitucion` solo existe con licitaciones-04. */
async function leerPerfil(db: ClienteDb): Promise<{ estado: EstadoLectura; perfil: ContextoLicitacion["perfil"]; soltadas: string[] }> {
  let cols = [...COLS_PERFIL];
  const soltadas: string[] = [];
  for (;;) {
    let r: { data: unknown; error: Err };
    try { r = await db.from("empresa_perfil").select(cols.join(",")).eq("id", 1).maybeSingle(); }
    catch { return { estado: "error", perfil: null, soltadas }; }
    if (r.error) {
      if (tablaFaltante(r.error, "empresa_perfil")) return { estado: "sin_tabla", perfil: null, soltadas };
      const col = columnaFaltante(r.error);
      if (col && OPC_PERFIL.includes(col) && cols.includes(col)) { cols = cols.filter((c) => c !== col); soltadas.push(col); continue; }
      return { estado: "error", perfil: null, soltadas };
    }
    if (!r.data) return { estado: "ok", perfil: null, soltadas };
    const d = r.data as Fila;
    const perfil: NonNullable<ContextoLicitacion["perfil"]> = {
      nombre: str(d.nombre), razon_social: str(d.razon_social), ruc: str(d.ruc), logo_url: str(d.logo_url),
      logo_claro_url: str(d.logo_claro_url), telefono: str(d.telefono), email: str(d.email), direccion: str(d.direccion),
      web: str(d.web), autorizacion_mtc: str(d.autorizacion_mtc),
    };
    if (!soltadas.includes("fecha_constitucion")) perfil.fecha_constitucion = fecha(d.fecha_constitucion);
    return { estado: "ok", perfil, soltadas };
  }
}

/** Estado de la fuente «seguros» a partir de cargarSeguros: una fuente con error la deja en error. */
function estadoSeguros(r: ResultadoSeguros): EstadoLectura {
  if (Object.values(r.fuentes).includes("error") || r.coberturas === "error") return "error";
  // `fuentes.poliza` junta `seguros` y `seguro_cobertura`: si la que falta es `seguros` (las pólizas de la
  // empresa: RC, deshonestidad, SCTR), la fuente no se pudo leer.
  if (r.fuentes.poliza === "sin_tabla" && r.coberturas !== "sin_tabla") return "sin_tabla";
  return "ok";
}

/**
 * El contexto de la revisión, leído en paralelo. Cada fuente declara su EstadoLectura; una que falla
 * queda en "error" con sus datos vacíos (la revisión dice «no se pudo leer», nunca «falta»).
 *  · unidades / conductores: SOLO los elegidos en el doc (claves). Un elegido que no está en la base
 *    queda AUSENTE del Record (la revisión: «no existe»).
 *  · documentos de un tercero: los de su placa y los de su empresa sin placa (deEmpresa).
 *  · experiencia: las elegidas en doc.experiencia.ids (activas o no: la revisión decide qué decir).
 *  · personal: los personalId de los contactos y del representante.
 */
export async function cargarContexto(lic: Licitacion): Promise<ContextoLicitacion> {
  const db = await cliente();
  const hoy = fechaLima();
  const doc = lic.doc;
  const u = partirClaves(lista(doc?.unidades).map((x) => (esObjeto(x) ? x.clave : null)));
  const c = partirClaves(lista(doc?.conductores).map((x) => (esObjeto(x) ? x.clave : null)));
  const expIds = enteros(lista(doc?.experiencia?.ids));
  const persIds = enteros([...lista(doc?.contactos).map((x) => (esObjeto(x) ? x.personalId : null)), doc?.representante?.personalId]);

  const seguros = async (): Promise<{ estado: EstadoLectura; filas: ContextoLicitacion["seguros"] }> => {
    try { const r = await cargarSeguros(db, hoy); return { estado: estadoSeguros(r), filas: estadoSeguros(r) === "ok" ? r.filas : [] }; }
    catch { return { estado: "error", filas: [] }; }
  };
  const otras = async (): Promise<{ estado: EstadoLectura; otras: OtraLicitacion[] }> => {
    const l = await leer(db, "licitaciones", ["id", "nombre", "cliente_nombre", "codigo", "cliente_id"], [], (q) => q.neq("id", lic.id));
    if (l.estado !== "ok") return { estado: l.estado, otras: [] };
    const cli = await leerPorIds(db, "clientes", ["id", "nombre", "empresa"], ["empresa"], "id", enteros(l.filas.map((f) => f.cliente_id)));
    if (cli.estado !== "ok") return { estado: "error", otras: [] };
    const nombreCli = new Map(cli.filas.map((f) => [Number(f.id), str(f.empresa) ?? str(f.nombre)]));
    return {
      estado: "ok",
      otras: l.filas.map((f) => ({
        id: Number(f.id), nombre: String(f.nombre ?? ""), cliente_nombre: String(f.cliente_nombre ?? ""), codigo: str(f.codigo),
        cliente_erp: ent(f.cliente_id) != null ? nombreCli.get(Number(f.cliente_id)) ?? null : null,
      })),
    };
  };

  // ── Fase 1: todo lo que no depende de otra lectura ──
  const [perfil, veh, vt, dv, dtv, cond, ct, archP, archT, leg, exp, seg, pers, otr] = await Promise.all([
    leerPerfil(db),
    leerPorIds(db, "vehiculos", COLS_VEH, OPC_VEH, "id", u.p),
    // Sin terceros elegidos se sondea igual (id = -1): así se sabe si existe la columna `anio`.
    u.t.length ? leerPorIds(db, "vehiculos_tercero", COLS_VT, OPC_VT, "id", u.t) : leer(db, "vehiculos_tercero", ["id", "anio"], ["anio"], (q) => q.eq("id", -1)),
    leerPorIds(db, "documentos_vehiculo", COLS_DV, OPC_DOC, "vehiculo_id", u.p),
    leerPorIds(db, "documentos_tercero", COLS_DT, OPC_DOC, "vehiculo_id", u.t),
    leerPorIds(db, "conductores", COLS_COND, VENC_COND, "id", c.p),
    leerPorIds(db, "conductores_tercero", COLS_CT, OPC_CT, "id", c.t),
    leerPorIds(db, "documentos_empresa", COLS_DE, ["conductor_tercero_id"], "conductor_id", c.p, (q) => q.eq("alcance", "conductor")),
    // El filtro usa conductor_tercero_id: sin licitaciones-04 la consulta entera falla nombrándola.
    leerPorIds(db, "documentos_empresa", COLS_DE, [], "conductor_tercero_id", c.t, (q) => q.eq("alcance", "conductor")),
    leer(db, "documentos_empresa", COLS_DE, ["conductor_tercero_id"], (q) => q.eq("alcance", "empresa").in("categoria", [...CODIGOS_LEGAJO])),
    expIds.length ? leerPorIds(db, "experiencia_empresa", COLS_EXP, [], "id", expIds) : leer(db, "experiencia_empresa", ["id"], [], (q) => q.eq("id", -1)),
    seguros(),
    leerPorIds(db, "personal_administrativo", COLS_PERS, [], "id", persIds),
    otras(),
  ]);

  // ── Fase 2: las empresas de los terceros y los documentos de su empresa ──
  const empUnidades = enteros(u.t.length ? vt.filas.map((f) => f.empresa_id) : []);
  const empIds = enteros([...empUnidades, ...ct.filas.map((f) => f.empresa_id)]);
  const [emp, dte] = await Promise.all([
    leerPorIds(db, "empresas_tercerizadas", COLS_EMP, OPC_EMP, "id", empIds),
    leerPorIds(db, "documentos_tercero", COLS_DT, OPC_DOC, "empresa_id", empUnidades, (q) => q.is("vehiculo_id", null)),
  ]);
  const empresas = new Map(emp.filas.map((f) => [Number(f.id), aEmpresa(f)]));

  // ── Unidades ──
  const unidades: Record<string, UnidadERP> = {};
  const estadoUnidades = peor(
    u.p.length ? peor(veh.estado, dv.estado) : "ok",
    u.t.length ? peor(vt.estado, dtv.estado, empUnidades.length ? peor(emp.estado, dte.estado) : "ok") : "ok");
  if (estadoUnidades === "ok") {
    for (const r of veh.filas) {
      const id = Number(r.id);
      unidades[`p:${id}`] = {
        clave: `p:${id}`, flota: "p", id, placa: String(r.placa ?? `#${id}`), marca: str(r.marca), modelo: str(r.modelo),
        anio: enteroEn(r.anio, 1900, 2200), capacidad: num(r.capacidad_pasajeros), categoria: str(r.categoria), estado: str(r.estado),
        foto_externa_url: str(r.foto_externa_url), foto_interna_url: str(r.foto_interna_url), empresa: null,
        docs: dv.filas.filter((d) => Number(d.vehiculo_id) === id).map((d) => aDocUnidad(d, "documentos_vehiculo", false)),
      };
    }
    if (u.t.length) for (const r of vt.filas) {
      const id = Number(r.id);
      const empId = ent(r.empresa_id);
      unidades[`t:${id}`] = {
        clave: `t:${id}`, flota: "t", id, placa: String(r.placa ?? `#${id}`), marca: str(r.marca), modelo: str(r.modelo),
        anio: vt.soltadas.includes("anio") ? null : enteroEn(r.anio, 1900, 2200), capacidad: num(r.capacidad),
        categoria: str(r.categoria), estado: str(r.estado),
        foto_externa_url: str(r.foto_externa_url), foto_interna_url: str(r.foto_interna_url),
        empresa: empId != null ? empresas.get(empId) ?? null : null,
        docs: [
          ...dtv.filas.filter((d) => Number(d.vehiculo_id) === id).map((d) => aDocUnidad(d, "documentos_tercero", false)),
          ...(empId != null ? dte.filas.filter((d) => Number(d.empresa_id) === empId).map((d) => aDocUnidad(d, "documentos_tercero", true)) : []),
        ],
      };
    }
  }

  // ── Conductores ──
  const sinColTercero = leg.soltadas.includes("conductor_tercero_id") || archP.soltadas.includes("conductor_tercero_id")
    || (archT.estado === "error" && archT.faltaColumna === "conductor_tercero_id");
  const estadoArchT: EstadoLectura = archT.estado === "error" && archT.faltaColumna === "conductor_tercero_id" ? "ok" : archT.estado;
  const empCond = enteros(ct.filas.map((f) => f.empresa_id));
  const estadoConductores = peor(
    c.p.length ? peor(cond.estado, archP.estado) : "ok",
    c.t.length ? peor(ct.estado, estadoArchT, empCond.length ? emp.estado : "ok") : "ok");
  const conductores: Record<string, ConductorERP> = {};
  if (estadoConductores === "ok") {
    for (const r of cond.filas) {
      const id = Number(r.id);
      const k: ConductorERP = {
        clave: `p:${id}`, flota: "p", id, nombre: String(r.nombre ?? `#${id}`), dni: str(r.dni), licencia: str(r.licencia),
        categoria_licencia: str(r.categoria_licencia), vencimiento_licencia: fecha(r.vencimiento_licencia), estado: str(r.estado),
        empresa: null, archivos: archP.filas.filter((d) => Number(d.conductor_id) === id).map(aFilaDoc),
      };
      // Tri-estado: una columna soltada (no existe) queda AUSENTE; una vacía, null.
      for (const v of VENC_COND) if (!cond.soltadas.includes(v)) k[v] = fecha(r[v]);
      conductores[k.clave] = k;
    }
    for (const r of ct.filas) {
      const id = Number(r.id);
      const empId = ent(r.empresa_id);
      conductores[`t:${id}`] = {
        clave: `t:${id}`, flota: "t", id, nombre: String(r.nombre ?? `#${id}`), dni: str(r.dni), licencia: str(r.licencia),
        categoria_licencia: str(r.categoria_licencia), vencimiento_licencia: fecha(r.vencimiento_licencia), estado: str(r.estado),
        empresa: empId != null ? empresas.get(empId) ?? null : null,
        archivos: sinColTercero ? [] : archT.filas.filter((d) => Number(d.conductor_tercero_id) === id).map(aFilaDoc),
      };
    }
  }

  const experiencia: Record<number, Experiencia> = {};
  if (exp.estado === "ok" && expIds.length) for (const r of exp.filas) experiencia[Number(r.id)] = aExperiencia(r);
  const personal: Record<number, PersonaERP> = {};
  if (pers.estado === "ok") for (const r of pers.filas) personal[Number(r.id)] = aPersona(r);

  const lecturas: Record<FuenteContexto, EstadoLectura> = {
    perfil: perfil.estado, unidades: estadoUnidades, conductores: estadoConductores, legajo: leg.estado,
    experiencia: exp.estado, seguros: seg.estado, personal: pers.estado, otras: otr.estado,
  };
  return {
    hoy, perfil: perfil.perfil, unidades, conductores,
    legajo: leg.estado === "ok" ? leg.filas.map(aFilaDoc) : [],
    experiencia, seguros: seg.filas, personal, otras: otr.otras, lecturas,
    migraciones: {
      anioTercero: !vt.soltadas.includes("anio"),
      conductorTercero: !sinColTercero,
      fechaConstitucion: !perfil.soltadas.includes("fecha_constitucion"),
    },
  };
}

// ══ Para ELEGIR en la pantalla de Recursos ══════════════════════════════════════
export type OpcionUnidad = {
  clave: ClaveRecurso; flota: Flota; id: number; placa: string; marca: string | null; modelo: string | null;
  anio: number | null; capacidad: number | null; categoria: string | null; estado: string | null;
  activo: boolean; empresaId: number | null; empresa: string | null; conFotos: boolean;
};
export type OpcionConductor = {
  clave: ClaveRecurso; flota: Flota; id: number; nombre: string; dni: string | null; licencia: string | null;
  categoria_licencia: string | null; vencimiento_licencia: FechaISO | null; estado: string | null;
  activo: boolean; empresaId: number | null; empresa: string | null;
};
type Opciones<T, X extends object = object> = Resultado<{ opciones: T[]; lecturas: Record<Flota, EstadoLectura>; avisos: string[] } & X>;

const ordenOpciones = <T extends { activo: boolean; flota: Flota; clave: string }>(rotulo: (x: T) => string) => (a: T, b: T) =>
  Number(b.activo) - Number(a.activo) || rotulo(a).localeCompare(rotulo(b), "es", { numeric: true, sensitivity: "base" })
  || (a.flota === b.flota ? 0 : a.flota === "p" ? -1 : 1) || (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0);

async function empresasTodas(db: ClienteDb): Promise<{ lectura: Lectura; mapa: Map<number, Fila> }> {
  const l = await leer(db, "empresas_tercerizadas", ["id", "razon_social", "estado"], []);
  return { lectura: l, mapa: new Map(l.filas.map((f) => [Number(f.id), f])) };
}

/**
 * Las dos flotas completas, ACTIVAS PRIMERO (una unidad tercera de una empresa inactiva cuenta como
 * inactiva), por placa. Si una flota no se pudo leer, la otra sale igual y `lecturas`/`avisos` lo dicen;
 * con las dos caídas, ok:false. `anioTercero` = existe vehiculos_tercero.anio (licitaciones-04).
 */
export async function buscarUnidades(): Promise<Opciones<OpcionUnidad, { anioTercero: boolean }>> {
  const db = await cliente();
  const [p, t, emp] = await Promise.all([
    leer(db, "vehiculos", ["id", "placa", "marca", "modelo", "anio", "capacidad_pasajeros", "categoria", "estado", "foto_externa_url", "foto_interna_url"], OPC_VEH),
    leer(db, "vehiculos_tercero", ["id", "empresa_id", "placa", "marca", "modelo", "anio", "capacidad", "categoria", "estado", "foto_externa_url", "foto_interna_url"], OPC_VT),
    empresasTodas(db),
  ]);
  const estT = peor(t.estado, emp.lectura.estado);
  if (p.estado !== "ok" && estT !== "ok") return explicar(p.causa ?? t.causa, { accion: "leer la flota", tabla: "vehiculos", modulo: "Vehículos" });
  const avisos: string[] = [];
  if (p.estado !== "ok") avisos.push(`No se pudo leer la flota propia (${p.error}). Recarga para reintentar.`);
  if (estT !== "ok") avisos.push(`No se pudo leer la flota tercerizada (${t.error ?? emp.lectura.error}). Recarga para reintentar.`);
  if (t.soltadas.includes("anio")) avisos.push(`Las unidades tercerizadas no tienen año en el ERP: corre ${SQL_LICITACIONES.accesorias} para poder escribirlo.`);
  const opciones: OpcionUnidad[] = [];
  if (p.estado === "ok") for (const r of p.filas) {
    const id = Number(r.id);
    opciones.push({
      clave: `p:${id}`, flota: "p", id, placa: String(r.placa ?? `#${id}`), marca: str(r.marca), modelo: str(r.modelo),
      anio: enteroEn(r.anio, 1900, 2200), capacidad: num(r.capacidad_pasajeros), categoria: str(r.categoria), estado: str(r.estado),
      activo: estaActivo(str(r.estado)), empresaId: null, empresa: null, conFotos: !!(str(r.foto_externa_url) || str(r.foto_interna_url)),
    });
  }
  if (estT === "ok") for (const r of t.filas) {
    const id = Number(r.id);
    const e = emp.mapa.get(Number(r.empresa_id));
    opciones.push({
      clave: `t:${id}`, flota: "t", id, placa: String(r.placa ?? `#${id}`), marca: str(r.marca), modelo: str(r.modelo),
      anio: t.soltadas.includes("anio") ? null : enteroEn(r.anio, 1900, 2200), capacidad: num(r.capacidad),
      categoria: str(r.categoria), estado: str(r.estado), activo: estaActivo(str(r.estado)) && (!e || estaActivo(str(e.estado))),
      empresaId: ent(r.empresa_id), empresa: e ? str(e.razon_social) : null, conFotos: !!(str(r.foto_externa_url) || str(r.foto_interna_url)),
    });
  }
  opciones.sort(ordenOpciones<OpcionUnidad>((x) => x.placa));
  return { ok: true, opciones, lecturas: { p: p.estado, t: estT }, avisos, anioTercero: !t.soltadas.includes("anio") };
}

/** Los conductores de las dos flotas, activos primero, por nombre. Misma regla de lecturas que buscarUnidades. */
export async function buscarConductores(): Promise<Opciones<OpcionConductor>> {
  const db = await cliente();
  const [p, t, emp] = await Promise.all([
    leer(db, "conductores", ["id", "nombre", "dni", "licencia", "categoria_licencia", "vencimiento_licencia", "estado"], []),
    leer(db, "conductores_tercero", ["id", "empresa_id", "nombre", "dni", "licencia", "categoria_licencia", "vencimiento_licencia", "estado"], OPC_CT),
    empresasTodas(db),
  ]);
  const estT = peor(t.estado, emp.lectura.estado);
  if (p.estado !== "ok" && estT !== "ok") return explicar(p.causa ?? t.causa, { accion: "leer los conductores", tabla: "conductores", modulo: "Conductores" });
  const avisos: string[] = [];
  if (p.estado !== "ok") avisos.push(`No se pudieron leer los conductores propios (${p.error}). Recarga para reintentar.`);
  if (estT !== "ok") avisos.push(`No se pudieron leer los conductores tercerizados (${t.error ?? emp.lectura.error}). Recarga para reintentar.`);
  const opciones: OpcionConductor[] = [];
  const base = (r: Fila, flota: Flota) => ({
    id: Number(r.id), nombre: String(r.nombre ?? `#${r.id}`), dni: str(r.dni), licencia: str(r.licencia),
    categoria_licencia: str(r.categoria_licencia), vencimiento_licencia: fecha(r.vencimiento_licencia), estado: str(r.estado), flota,
  });
  if (p.estado === "ok") for (const r of p.filas) {
    const b = base(r, "p");
    opciones.push({ ...b, clave: `p:${b.id}`, activo: estaActivo(b.estado), empresaId: null, empresa: null });
  }
  if (estT === "ok") for (const r of t.filas) {
    const b = base(r, "t");
    const e = emp.mapa.get(Number(r.empresa_id));
    opciones.push({ ...b, clave: `t:${b.id}`, activo: estaActivo(b.estado) && (!e || estaActivo(str(e.estado))), empresaId: ent(r.empresa_id), empresa: e ? str(e.razon_social) : null });
  }
  opciones.sort(ordenOpciones<OpcionConductor>((x) => x.nombre));
  return { ok: true, opciones, lecturas: { p: p.estado, t: estT }, avisos };
}

// ══ Personal (contactos y representante legal) ══════════════════════════════════
/**
 * El personal administrativo ACTIVO (estaActivo: ni «inactivo» ni de baja), con las mismas columnas que
 * lee cargarContexto, por nombre e id (orden total). Para elegir contactos y el representante legal.
 */
export async function leerPersonal(): Promise<Resultado<{ filas: PersonaERP[] }>> {
  const db = await cliente();
  const l = await leer(db, "personal_administrativo", [...COLS_PERS, "estado"], [], (q) => q, [{ col: "nombre" }, { col: "id" }]);
  if (l.estado !== "ok") return explicar(l.causa, { accion: "leer el personal", tabla: "personal_administrativo", modulo: "Personal administrativo" });
  return { ok: true, filas: l.filas.filter((r) => estaActivo(str(r.estado))).map(aPersona) };
}

export type FirmaAnterior = {
  licitacionId: number; nombre: string; actualizado_en: InstanteISO;
  /** Con `personalId`, nombre/dni/cargo se DERIVAN de personal_administrativo (vacíos en el doc). */
  representante: { nombre: string; dni: string; cargo: string; personalId: number | null };
  firma: ArchivoRef;
};
const FIRMAS_ANTERIORES = 20;
/**
 * Las firmas del representante de las últimas 20 licitaciones que tienen una (más reciente primero),
 * distintas por url: para «Reusar la última firma». Lee SOLO id, nombre, actualizado_en y la ruta jsonb
 * doc->representante (PostgREST), nunca el doc entero. La firma pasa por normalizarArchivo (la misma regla
 * del doc) y solo vale una imagen (PNG/JPG): es lo que el PDF puede dibujar.
 */
export async function firmasAnteriores(excluirId: number): Promise<Resultado<{ filas: FirmaAnterior[] }>> {
  const db = await cliente();
  // `->>` (texto): un `firma: null` del doc es NULL en SQL; con `->` sería el json null, que NO es NULL.
  const { data, error } = await db.from("licitaciones").select("id, nombre, actualizado_en, representante:doc->representante")
    .neq("id", excluirId).not("doc->representante->>firma", "is", null)
    .order("actualizado_en", { ascending: false }).order("id", { ascending: false }).limit(FIRMAS_ANTERIORES);
  if (error) return explicar(error, { accion: "leer las firmas de otras licitaciones", tabla: "licitaciones", sql: SQL_LICITACIONES.tablas });
  const vistas = new Set<string>();
  const filas: FirmaAnterior[] = [];
  for (const r of (data ?? []) as Fila[]) {
    const rep = esObjeto(r.representante) ? r.representante : {};
    const firma = aArchivoRef(rep.firma);
    if (!firma || (firma.mime !== "image/png" && firma.mime !== "image/jpeg") || vistas.has(firma.url)) continue;
    vistas.add(firma.url);
    filas.push({
      licitacionId: Number(r.id), nombre: String(r.nombre ?? ""), actualizado_en: instante(r.actualizado_en),
      representante: { nombre: textoCorto(rep.nombre, 200), dni: textoCorto(rep.dni, 20), cargo: textoCorto(rep.cargo, 200), personalId: enteroEn(rep.personalId, 1, Number.MAX_SAFE_INTEGER) },
      firma,
    });
  }
  // Con personalId el doc no guarda nombre/dni/cargo: se derivan (best-effort; sin lectura quedan vacíos).
  const ids = enteros(filas.filter((f) => f.representante.personalId != null && !f.representante.nombre).map((f) => f.representante.personalId));
  if (ids.length) {
    const p = await leerPorIds(db, "personal_administrativo", COLS_PERS, [], "id", ids);
    if (p.estado === "ok") {
      const m = new Map(p.filas.map((x) => [Number(x.id), aPersona(x)]));
      for (const f of filas) {
        const per = f.representante.personalId != null ? m.get(f.representante.personalId) : undefined;
        if (per && !f.representante.nombre) f.representante = { ...f.representante, nombre: per.nombre, dni: f.representante.dni || (per.dni ?? ""), cargo: f.representante.cargo || (per.cargo ?? "") };
      }
    }
  }
  return { ok: true, filas };
}

// ══ Archivos ═════════════════════════════════════════════════════════════════
/** Carpetas que solo aceptan imágenes (la portada, las imágenes de un bloque, la firma). */
const MIMES_POR_CARPETA: Partial<Record<CarpetaLicitacion, readonly MimeArchivo[]>> = {
  imagenes: ["image/png", "image/jpeg"],
  firmas: ["image/png", "image/jpeg"],
};
/** Lo que se puede UNIR a un expediente: PDF, PNG y JPG (legajo, documentos de unidad y de conductor). */
const MIMES_UNIBLES: readonly MimeArchivo[] = ["application/pdf", "image/png", "image/jpeg"];
const ETIQUETA_MIME: Record<MimeArchivo, string> = {
  "application/pdf": "PDF", "image/png": "PNG", "image/jpeg": "JPG", "application/zip": "ZIP",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word (.docx)",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel (.xlsx)",
  "application/vnd.ms-excel": "Excel (.xls)",
};

type Firma = "pdf" | "png" | "jpeg" | "zip" | "cfb";
/** Qué ES el archivo por sus primeros bytes (null = ninguno de los que se aceptan). */
export function firmaDeBytes(b: Uint8Array): Firma | null {
  const empieza = (...xs: number[]) => xs.every((x, i) => b[i] === x);
  if (empieza(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (empieza(0xff, 0xd8, 0xff)) return "jpeg";
  if (empieza(0x50, 0x4b, 0x03, 0x04) || empieza(0x50, 0x4b, 0x05, 0x06)) return "zip";
  if (empieza(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return "cfb";
  // %PDF- puede venir tras basura en los primeros 1024 bytes (lo admite la norma).
  const lim = Math.min(b.length - 5, 1019);
  for (let i = 0; i <= lim; i++) if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 && b[i + 4] === 0x2d) return "pdf";
  return null;
}
const FIRMA_DE_MIME: Record<MimeArchivo, Firma> = {
  "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpeg", "application/zip": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "zip",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "zip",
  "application/vnd.ms-excel": "cfb",
};

/**
 * El mime con que se sube: el permitido que corresponde al archivo (por su tipo declarado o, si no, su
 * extensión) y que coincide con su CONTENIDO. Una imagen con la extensión cambiada (JPG llamado .png)
 * se corrige a lo que es; cualquier otra discrepancia se rechaza diciendo qué es. Lanza ErrorLicitaciones.
 */
async function mimeVerificado(file: Blob & { name?: string }, permitidos: readonly MimeArchivo[]): Promise<MimeArchivo> {
  const nombre = file.name ?? "archivo";
  const declarado: MimeArchivo | null = esMimePermitido(file.type) ? file.type : mimeDeNombre(nombre);
  const aceptados = permitidos.map((m) => ETIQUETA_MIME[m]).filter((x, i, a) => a.indexOf(x) === i).join(", ");
  if (/\.hei[cf]$/i.test(nombre) || /image\/hei[cf]/i.test(file.type)) {
    throw new ErrorLicitaciones(`«${nombre}» es una foto HEIC (iPhone), que el expediente no puede unir. Expórtala como JPG o PDF y súbela de nuevo.`);
  }
  if (!declarado || !permitidos.includes(declarado)) throw new ErrorLicitaciones(`«${nombre}» no es de un tipo que se acepte aquí. Se aceptan: ${aceptados}.`);
  let cab: Uint8Array;
  try { cab = new Uint8Array(await file.slice(0, 1024).arrayBuffer()); }
  catch { throw new ErrorLicitaciones(`No se pudo leer «${nombre}» desde tu equipo: vuelve a elegirlo.`); }
  const firma = firmaDeBytes(cab);
  if (firma === FIRMA_DE_MIME[declarado]) return declarado;
  const imagen: Partial<Record<Firma, MimeArchivo>> = { png: "image/png", jpeg: "image/jpeg" };
  const real = firma ? imagen[firma] : undefined;
  if (real && permitidos.includes(real) && (declarado === "image/png" || declarado === "image/jpeg")) return real;
  const que = firma === "pdf" ? "un PDF" : firma === "png" ? "un PNG" : firma === "jpeg" ? "un JPG" : firma === "zip" ? "un archivo comprimido" : firma === "cfb" ? "un Excel antiguo" : "un tipo que el ERP no reconoce";
  throw new ErrorLicitaciones(`«${nombre}» dice ser ${ETIQUETA_MIME[declarado]} pero su contenido es ${que}. Vuelve a exportarlo como ${ETIQUETA_MIME[declarado]}.`);
}

async function contarPaginasPdf(bytes: ArrayBuffer): Promise<number | null> {
  try {
    const { PDFDocument } = await import("pdf-lib");
    // Sin ignoreEncryption (R11): un PDF cifrado lanza y queda sin contar; la emisión lo omite y lo nombra.
    const d = await PDFDocument.load(bytes, { updateMetadata: false });
    return d.getPageCount();
  } catch {
    return null;
  }
}

const nombreArchivo = (x: string | undefined, ext: string): string => textoCorto(x ?? "", 200) || `archivo.${ext}`;

/**
 * Sube un archivo de la licitación al bucket PRIVADO `licitaciones` (R3: solo INSERT, sin sobrescribir)
 * y devuelve su ArchivoRef. Ruta = rutaNueva(carpeta, licId, uuid, ext) — `experiencia` va sin licId.
 * Valida tipo (y contenido) y tamaño ANTES de subir. `paginas` se cuenta con pdf-lib si es PDF (null si
 * está cifrado o no se pudo leer). LANZA ErrorLicitaciones con el motivo en castellano.
 */
export async function subirArchivo(carpeta: CarpetaLicitacion, licId: number | null, file: File,
  opts: { nombre?: string; contarPaginas?: boolean } = {}): Promise<ArchivoRef> {
  const permitidos = MIMES_POR_CARPETA[carpeta] ?? MIMES_PERMITIDOS;
  if (!file || typeof file.size !== "number") throw new ErrorLicitaciones("No se eligió ningún archivo.");
  if (file.size <= 0) throw new ErrorLicitaciones(`«${file.name}» está vacío.`);
  if (file.size > TOPES_DOC.maxBytesArchivo) {
    throw new ErrorLicitaciones(`«${file.name}» pesa ${(file.size / 1048576).toFixed(1)} MB y el tope es ${TOPES_DOC.maxBytesArchivo / 1048576} MB: comprímelo o divídelo.`);
  }
  const mime = await mimeVerificado(file, permitidos);
  const ext = extDeMime(mime);
  const uuid = nuevoUuid();
  let ruta: string;
  try { ruta = rutaNueva(carpeta, licId, uuid, ext); }
  catch (e) { throw new ErrorLicitaciones(`No se pudo preparar la subida: ${msgDe(e)}. Guarda la licitación antes de subir archivos.`); }
  const db = await cliente();
  const nombre = nombreArchivo(opts.nombre ?? file.name, ext);
  const { error } = await db.storage.from(BUCKET_LICITACIONES).upload(ruta, file, { upsert: false, contentType: mime, cacheControl: "3600" });
  if (error) throw aExcepcion(explicarStorage(error, BUCKET_LICITACIONES, nombre, SQL_LICITACIONES.bucket));
  const url = String(db.storage.from(BUCKET_LICITACIONES).getPublicUrl(ruta)?.data?.publicUrl ?? "");
  if (!url) throw new ErrorLicitaciones(`«${nombre}» se subió pero no se pudo obtener su enlace. Vuelve a intentarlo.`);
  const sha256 = await hashArchivo(file);
  let paginas: number | null = null;
  if (mime === "application/pdf" && opts.contarPaginas !== false) {
    try { paginas = await contarPaginasPdf(await file.arrayBuffer()); } catch { paginas = null; }
  }
  return { id: uuid, url, nombre, mime, bytes: file.size, sha256, paginas, subidoEn: new Date().toISOString() };
}

/** Sube al bucket `documentos` (el de documentos_empresa, documentos_vehiculo y documentos_tercero). */
async function subirADocumentos(db: ClienteDb, carpeta: string, file: File): Promise<{ ok: true; url: string; ruta: string; nombre: string; mime: MimeArchivo } | FalloDatos> {
  if (!file || typeof file.size !== "number") return { ok: false, error: "No se eligió ningún archivo." };
  if (file.size <= 0) return { ok: false, error: `«${file.name}» está vacío.` };
  if (file.size > TOPES_DOC.maxBytesArchivo) return { ok: false, error: `«${file.name}» pesa ${(file.size / 1048576).toFixed(1)} MB y el tope es ${TOPES_DOC.maxBytesArchivo / 1048576} MB.` };
  let mime: MimeArchivo;
  try { mime = await mimeVerificado(file, MIMES_UNIBLES); }
  catch (e) { return { ok: false, error: msgDe(e) }; }
  const ruta = `${carpeta}/${nuevoUuid()}.${extDeMime(mime)}`;
  const nombre = nombreArchivo(file.name, extDeMime(mime));
  const { error } = await db.storage.from("documentos").upload(ruta, file, { upsert: false, contentType: mime, cacheControl: "3600" });
  if (error) return explicarStorage(error, "documentos", nombre);
  const url = String(db.storage.from("documentos").getPublicUrl(ruta)?.data?.publicUrl ?? "");
  if (!url) return { ok: false, error: `«${nombre}» se subió pero no se pudo obtener su enlace. Vuelve a intentarlo.` };
  return { ok: true, url, ruta, nombre, mime };
}
/** Si la fila no se pudo escribir, el objeto recién subido sobra (best-effort: el bucket `documentos` lo permite). */
async function retirarSubido(db: ClienteDb, ruta: string): Promise<void> {
  try { await db.storage.from("documentos").remove([ruta]); } catch { /* best-effort */ }
}

// ══ Legajo de la empresa y documentos del conductor (documentos_empresa) ════════
type FechasDoc = { titulo?: string | null; fecha_emision?: FechaISO | null; fecha_vencimiento?: FechaISO | null };

function validarFechas(f: FechasDoc): { fecha_emision?: FechaISO | null; fecha_vencimiento?: FechaISO | null } | { error: string } {
  const out: { fecha_emision?: FechaISO | null; fecha_vencimiento?: FechaISO | null } = {};
  for (const k of ["fecha_emision", "fecha_vencimiento"] as const) {
    if (!tiene(f, k)) continue;
    const v = f[k];
    if (v == null || v === "") { out[k] = null; continue; }
    if (!esFechaISO(v)) return { error: `La fecha de ${k === "fecha_emision" ? "emisión" : "vencimiento"} no es válida (AAAA-MM-DD).` };
    out[k] = v;
  }
  if (out.fecha_emision && out.fecha_vencimiento && out.fecha_vencimiento < out.fecha_emision) {
    return { error: "La fecha de vencimiento es anterior a la de emisión: revisa las dos." };
  }
  return out;
}

const OPC_DE = ["conductor_tercero_id"];
async function insertarDocEmpresa(db: ClienteDb, fila: Record<string, unknown>, ruta: string): Promise<Resultado<{ fila: FilaDocEmpresa }>> {
  let cols = [...COLS_DE];
  for (;;) {
    const { data, error } = await db.from("documentos_empresa").insert(fila).select(cols.join(","));
    if (!error) {
      const f = ((data ?? []) as Fila[])[0];
      if (!f) return { ok: false, sinPermiso: true, error: "El documento se guardó pero no se pudo leer de vuelta: recarga la pantalla." };
      return { ok: true, fila: aFilaDoc(f) };
    }
    // La columna faltante en lo que se PIDE de vuelta (no en lo que se escribe): la petición se deshizo
    // entera, así que se puede repetir sin ella. Si la que falta es la que se ESCRIBE, se dice.
    const col = columnaFaltante(error);
    if (col && OPC_DE.includes(col) && cols.includes(col) && !tiene(fila, col)) { cols = cols.filter((c) => c !== col); continue; }
    await retirarSubido(db, ruta);
    if (col === "conductor_tercero_id") {
      return { ok: false, sinMigracion: SQL_LICITACIONES.accesorias, error: `Para guardar documentos de un conductor tercerizado hay que correr ${SQL_LICITACIONES.accesorias} en Supabase → SQL Editor.` };
    }
    if (String(error.code ?? "") === "23514") {
      const regla = /check constraint "([^"]+)"/i.exec(msgDe(error))?.[1];
      return { ok: false, error: `La tabla documentos_empresa rechazó el documento por su regla ${regla ? `«${regla}» ` : ""}(puede no aceptar la categoría «${String(fila.categoria)}»). Corre supabase/diagnostico-licitaciones.sql y envía el resultado a soporte.` };
    }
    return explicar(error, { accion: "guardar el documento", tabla: "documentos_empresa", modulo: "Documentos" });
  }
}

async function actualizarDocEmpresa(db: ClienteDb, id: number, alcance: "empresa" | "conductor", f: FechasDoc,
  categorias: readonly string[]): Promise<Resultado<{ fila: FilaDocEmpresa }>> {
  const v = validarFechas(f);
  if ("error" in v) return { ok: false, error: v.error };
  const patch: Record<string, unknown> = { ...v };
  if (tiene(f, "titulo")) { const t = textoONull(f.titulo, 300); if (!t) return { ok: false, error: "El título no puede quedar vacío." }; patch.titulo = t; }
  if (tiene(v, "fecha_vencimiento")) patch.estado = estadoParaColumna(v.fecha_vencimiento ?? null);
  if (!Object.keys(patch).length) return { ok: false, error: "No hay nada que cambiar." };
  let cols = [...COLS_DE];
  for (;;) {
    const { data, error } = await db.from("documentos_empresa").update(patch).eq("id", id).eq("alcance", alcance).in("categoria", [...categorias]).select(cols.join(","));
    if (error) {
      const col = columnaFaltante(error);
      if (col && OPC_DE.includes(col) && cols.includes(col)) { cols = cols.filter((c) => c !== col); continue; }
      return explicar(error, { accion: "actualizar el documento", tabla: "documentos_empresa", modulo: "Documentos" });
    }
    const fila = ((data ?? []) as Fila[])[0];
    if (!fila) return { ok: false, noExiste: true, error: `El documento N° ${id} ya no existe (o no es de esta sección).` };
    return { ok: true, fila: aFilaDoc(fila) };
  }
}

async function borrarDocEmpresa(db: ClienteDb, id: number, alcance: "empresa" | "conductor", categorias: readonly string[]): Promise<Resultado<{ id: number }>> {
  // Igual que /documentos: se borra la FILA; el archivo queda en el bucket (otras emisiones pueden citarlo).
  const { data, error } = await db.from("documentos_empresa").delete().eq("id", id).eq("alcance", alcance).in("categoria", [...categorias]).select("id");
  if (error) return explicar(error, { accion: "eliminar el documento", tabla: "documentos_empresa", modulo: "Documentos" });
  if (!((data ?? []) as Fila[]).length) return { ok: false, noExiste: true, error: `El documento N° ${id} ya no existe (o no es de esta sección).` };
  return { ok: true, id };
}

/** El legajo: documentos_empresa con alcance 'empresa' y categoría del legajo, todas las versiones (id asc). */
export async function leerLegajo(): Promise<Resultado<{ filas: FilaDocEmpresa[]; conductorTercero: boolean }>> {
  const db = await cliente();
  const l = await leer(db, "documentos_empresa", COLS_DE, OPC_DE, (q) => q.eq("alcance", "empresa").in("categoria", [...CODIGOS_LEGAJO]));
  if (l.estado !== "ok") return explicar(l.causa, { accion: "leer el legajo de la empresa", tabla: "documentos_empresa", modulo: "Documentos" });
  return { ok: true, filas: l.filas.map(aFilaDoc), conductorTercero: !l.soltadas.includes("conductor_tercero_id") };
}

/**
 * Sube un documento del legajo como una fila NUEVA (las anteriores se conservan: el más reciente manda,
 * documentoVigente de legajo.ts). Archivo al bucket `documentos` en legajo/<codigo>/<uuid>.<ext>; fila con
 * alcance 'empresa', categoria = código, privado, y `estado` para /documentos (estadoParaColumna).
 */
export async function subirDocumentoLegajo(codigo: CodigoLegajo, file: File,
  datos: { titulo?: string | null; fecha_emision: FechaISO | null; fecha_vencimiento: FechaISO | null }): Promise<Resultado<{ fila: FilaDocEmpresa }>> {
  if (!(CODIGOS_LEGAJO as readonly string[]).includes(codigo)) return { ok: false, error: "El tipo de documento del legajo no es válido." };
  const v = validarFechas(datos);
  if ("error" in v) return { ok: false, error: v.error };
  const db = await cliente();
  const sub = await subirADocumentos(db, `legajo/${codigo}`, file);
  if (!sub.ok) return sub;
  return insertarDocEmpresa(db, {
    titulo: textoONull(datos.titulo, 300) ?? etiquetaCategoria(codigo), categoria: codigo, alcance: "empresa",
    archivo_url: sub.url, archivo_nombre: sub.nombre, privado: true,
    fecha_emision: v.fecha_emision ?? null, fecha_vencimiento: v.fecha_vencimiento ?? null,
    estado: estadoParaColumna(v.fecha_vencimiento ?? null),
  }, sub.ruta);
}
export async function actualizarFechasLegajo(id: number, fechas: FechasDoc): Promise<Resultado<{ fila: FilaDocEmpresa }>> {
  return actualizarDocEmpresa(await cliente(), id, "empresa", fechas, CODIGOS_LEGAJO);
}
/** Borra la fila (como /documentos). Una licitación que la tenía fijada lo dice (legajo_documento_fijado_no_existe). */
export async function borrarDocumentoLegajo(id: number): Promise<Resultado<{ id: number }>> {
  return borrarDocEmpresa(await cliente(), id, "empresa", CODIGOS_LEGAJO);
}

/** Documentos de UN conductor (alcance 'conductor'). Tercero sin licitaciones-04 → sinMigracion. */
export async function leerDocsConductor(clave: ClaveRecurso): Promise<Resultado<{ filas: FilaDocEmpresa[] }>> {
  const k = claveRecurso(clave);
  if (!k) return { ok: false, error: "El conductor no es válido." };
  const id = Number(k.slice(2));
  const db = await cliente();
  const campo = k[0] === "p" ? "conductor_id" : "conductor_tercero_id";
  const l = await leer(db, "documentos_empresa", COLS_DE, k[0] === "p" ? OPC_DE : [], (q) => q.eq("alcance", "conductor").eq(campo, id));
  if (l.estado !== "ok") {
    if (l.faltaColumna === "conductor_tercero_id") return { ok: false, sinMigracion: SQL_LICITACIONES.accesorias, error: `Los documentos de conductores tercerizados necesitan ${SQL_LICITACIONES.accesorias} (corre ese SQL en Supabase → SQL Editor).` };
    return explicar(l.causa, { accion: "leer los documentos del conductor", tabla: "documentos_empresa", modulo: "Documentos" });
  }
  return { ok: true, filas: l.filas.map(aFilaDoc) };
}

/**
 * Sube un documento del conductor (fila nueva, alcance 'conductor', conductor_id o conductor_tercero_id).
 * Al bucket `documentos` en conductores/<p|t>-<id>/<codigo>/<uuid>.<ext>. OJO (D5): para el conductor
 * PROPIO la fecha que manda es la de su ficha (conductores.*_venc, se edita en /conductores); la fila
 * guarda el archivo y sus fechas, y la revisión avisa si no coinciden (conductor_doc_fechas_distintas).
 */
export async function subirDocumentoConductor(clave: ClaveRecurso, codigo: CodigoDocConductor, file: File,
  datos: { titulo?: string | null; fecha_emision: FechaISO | null; fecha_vencimiento: FechaISO | null }): Promise<Resultado<{ fila: FilaDocEmpresa }>> {
  const k = claveRecurso(clave);
  if (!k) return { ok: false, error: "El conductor no es válido." };
  if (!(CODIGOS_DOC_CONDUCTOR as readonly string[]).includes(codigo)) return { ok: false, error: "El tipo de documento del conductor no es válido." };
  const v = validarFechas(datos);
  if ("error" in v) return { ok: false, error: v.error };
  const id = Number(k.slice(2));
  const db = await cliente();
  if (k[0] === "t") {
    // Sin la columna no hay dónde guardar de quién es: se dice ANTES de subir nada.
    const probe = await leer(db, "documentos_empresa", ["id", "conductor_tercero_id"], [], (q) => q.eq("id", -1));
    if (probe.faltaColumna === "conductor_tercero_id") return { ok: false, sinMigracion: SQL_LICITACIONES.accesorias, error: `Para subir documentos de un conductor tercerizado hay que correr ${SQL_LICITACIONES.accesorias} en Supabase → SQL Editor.` };
  }
  const sub = await subirADocumentos(db, `conductores/${k[0]}-${id}/${codigo}`, file);
  if (!sub.ok) return sub;
  return insertarDocEmpresa(db, {
    titulo: textoONull(datos.titulo, 300) ?? etiquetaCategoria(codigo), categoria: codigo, alcance: "conductor",
    ...(k[0] === "p" ? { conductor_id: id } : { conductor_tercero_id: id }),
    archivo_url: sub.url, archivo_nombre: sub.nombre, privado: true,
    fecha_emision: v.fecha_emision ?? null, fecha_vencimiento: v.fecha_vencimiento ?? null,
    estado: estadoParaColumna(v.fecha_vencimiento ?? null),
  }, sub.ruta);
}
export async function actualizarFechasDocConductor(id: number, fechas: FechasDoc): Promise<Resultado<{ fila: FilaDocEmpresa }>> {
  return actualizarDocEmpresa(await cliente(), id, "conductor", fechas, CODIGOS_DOC_CONDUCTOR);
}
export async function borrarDocumentoConductor(id: number): Promise<Resultado<{ id: number }>> {
  return borrarDocEmpresa(await cliente(), id, "conductor", CODIGOS_DOC_CONDUCTOR);
}

// ══ Documentos de UNIDAD (la fila autoritativa: documentos_vehiculo / documentos_tercero) ══
/** Exigen vencimiento al subirse desde la licitación: un SOAT o una CITV sin fecha no se pueden juzgar. */
const CANONICOS_CON_VENCIMIENTO: readonly string[] = [...CANONICOS_DOC_UNIDAD.soat, ...CANONICOS_DOC_UNIDAD.citv];

/** Agrega «Enlace anterior: …» a las observaciones (una vez) para no perder el enlace que se reemplaza. */
export function observacionesConEnlaceAnterior(obs: string | null, anterior: string | null, nueva: string): string | null {
  const a = (anterior ?? "").trim();
  const o = (obs ?? "").trim();
  if (!a || a === nueva || o.includes(a)) return o || null;
  return `${o ? `${o}\n` : ""}Enlace anterior: ${a}`;
}

export type DatosDocUnidad = {
  docId: number | null; numero: string | null; fecha_emision: string | null; fecha_vencimiento: string | null; entidad_emisora: string | null;
};

/**
 * Sube el PDF/foto de un documento de unidad y lo escribe en SU fila autoritativa — la que leen
 * /vehiculos, /documentos-vehiculares, /tercerizadas, /seguros y la licitación —, no en una copia.
 * Hoy casi todos esos documentos son enlaces de Drive, que no se pueden unir al expediente: este es el
 * camino para dejar el archivo en el ERP.
 *  · Archivo: bucket `documentos`, vehiculos/<p|t>-<id>/<uuid>.<ext> (PDF, PNG o JPG).
 *  · Propios: por guardarDocumentoVehiculo (la única puerta de documentos_vehiculo).
 *  · Terceros: documentos_tercero con la empresa DE LA UNIDAD (leída de la base, no la del llamador).
 *  · Con `docId` se ACTUALIZA esa fila conservando lo que no se manda (un null = sin cambio); el enlace
 *    anterior que se reemplaza queda en observaciones («Enlace anterior: …»). Sin `docId`, fila nueva.
 *  · SOAT/CAT y CITV exigen vencimiento; un documento que no vence (Tarjeta de Propiedad) lo guarda en null.
 */
export async function subirDocUnidad(u: { clave: ClaveRecurso; empresaId: number | null }, canonico: string, file: File,
  datos: DatosDocUnidad): Promise<{ ok: true; url: string; docId: number | null } | FalloDatos> {
  const k = claveRecurso(u?.clave);
  if (!k) return { ok: false, error: "La unidad no es válida." };
  const id = Number(k.slice(2));
  const tipoDoc = TIPOS_DOC_UNIDAD.find((t) => t.canonico === canonico);
  if (!tipoDoc) return { ok: false, error: `«${canonico}» no es un tipo de documento de unidad del ERP.` };
  const noVence = docSinVencimiento(canonico);
  const fv = noVence ? null : (datos.fecha_vencimiento || null);
  const fe = datos.fecha_emision || null;
  if (fv && !esFechaISO(fv)) return { ok: false, error: "La fecha de vencimiento no es válida (AAAA-MM-DD)." };
  if (fe && !esFechaISO(fe)) return { ok: false, error: "La fecha de emisión no es válida (AAAA-MM-DD)." };
  if (fe && fv && fv < fe) return { ok: false, error: "La fecha de vencimiento es anterior a la de emisión: revisa las dos." };
  if (CANONICOS_CON_VENCIMIENTO.includes(canonico) && !fv) return { ok: false, error: `El ${canonico} necesita su fecha de vencimiento: escríbela antes de subirlo (sin ella no se puede saber si está vigente al presentar).` };
  const numero = textoONull(datos.numero, 80);
  const entidad = textoONull(datos.entidad_emisora, 200);
  const docId = datos.docId != null ? enteroEn(datos.docId, 1, Number.MAX_SAFE_INTEGER) : null;
  if (datos.docId != null && docId == null) return { ok: false, error: "El documento a reemplazar no es válido." };
  const db = await cliente();
  const tabla = k[0] === "p" ? "documentos_vehiculo" : "documentos_tercero";

  // ── Lo que hay que leer ANTES de subir: la empresa del tercero y la fila que se actualiza ──
  let empresaId: number | null = null;
  if (k[0] === "t") {
    const { data, error } = await db.from("vehiculos_tercero").select("id, empresa_id").eq("id", id).maybeSingle();
    if (error) return explicar(error, { accion: "leer la unidad tercerizada", tabla: "vehiculos_tercero", modulo: "Tercerizadas" });
    if (!data) return { ok: false, noExiste: true, error: `La unidad tercerizada N° ${id} ya no existe.` };
    empresaId = ent((data as Fila).empresa_id);
    if (empresaId == null) return { ok: false, error: "La unidad tercerizada no tiene empresa asignada: corrígela en Tercerizadas." };
  }
  let previa: Fila | null = null;
  if (docId != null) {
    const cols = k[0] === "p"
      ? "id, vehiculo_id, tipo, numero, fecha_emision, fecha_vencimiento, entidad_emisora, archivo_url, observaciones"
      : "id, empresa_id, vehiculo_id, tipo, numero, fecha_vencimiento, entidad_emisora, archivo_url, observaciones";
    const { data, error } = await db.from(tabla).select(cols).eq("id", docId).maybeSingle();
    if (error) return explicar(error, { accion: "leer el documento a reemplazar", tabla, modulo: k[0] === "p" ? "Vehículos" : "Tercerizadas" });
    if (!data) return { ok: false, noExiste: true, error: `El documento N° ${docId} ya no existe: recarga la pantalla.` };
    previa = data as Fila;
    if (Number(previa.vehiculo_id) !== id) return { ok: false, error: `El documento N° ${docId} es de otra unidad: recarga la pantalla.` };
    if (tipoCanonico(String(previa.tipo ?? ""))?.canonico !== canonico) return { ok: false, error: `El documento N° ${docId} es de otro tipo («${String(previa.tipo ?? "")}»), no ${canonico}.` };
  }

  const sub = await subirADocumentos(db, `vehiculos/${k[0]}-${id}`, file);
  if (!sub.ok) return sub;
  const observaciones = observacionesConEnlaceAnterior(str(previa?.observaciones), str(previa?.archivo_url), sub.url);
  const conservar = <T>(nuevo: T | null, viejo: unknown): T | null => (nuevo != null ? nuevo : ((viejo ?? null) as T | null));

  if (k[0] === "p") {
    const { error } = await guardarDocumentoVehiculo(db, {
      ...(docId != null ? { id: docId } : {}),
      vehiculo_id: id, tipo: canonico,
      numero: conservar(numero, previa?.numero),
      fecha_emision: conservar(fe, previa?.fecha_emision),
      fecha_vencimiento: noVence ? null : conservar(fv, previa?.fecha_vencimiento),
      entidad_emisora: conservar(entidad, previa?.entidad_emisora),
      archivo_url: sub.url, observaciones,
    });
    if (error) { await retirarSubido(db, sub.ruta); return explicar(error, { accion: "guardar el documento de la unidad", tabla, modulo: "Vehículos" }); }
    return { ok: true, url: sub.url, docId };
  }

  // Terceros: las columnas que escribe /tercerizadas. `fecha_emision` no la escribe esa pantalla: se manda
  // solo si viene y se suelta si la tabla no la tiene (la petición rechazada no escribió nada).
  const payload: Record<string, unknown> = {
    empresa_id: empresaId, vehiculo_id: id, tipo: canonico,
    numero: conservar(numero, previa?.numero),
    fecha_vencimiento: noVence ? null : conservar(fv, previa?.fecha_vencimiento),
    entidad_emisora: conservar(entidad, previa?.entidad_emisora),
    archivo_url: sub.url, observaciones,
  };
  if (fe) payload.fecha_emision = fe;
  for (;;) {
    const r = docId != null
      ? await db.from("documentos_tercero").update(payload).eq("id", docId).select("id")
      : await db.from("documentos_tercero").insert(payload).select("id");
    if (r.error) {
      if (tiene(payload, "fecha_emision") && columnaFaltante(r.error) === "fecha_emision") { delete payload.fecha_emision; continue; }
      await retirarSubido(db, sub.ruta);
      return explicar(r.error, { accion: "guardar el documento de la unidad tercerizada", tabla: "documentos_tercero", modulo: "Tercerizadas" });
    }
    const f = ((r.data ?? []) as Fila[])[0];
    if (!f && docId != null) { await retirarSubido(db, sub.ruta); return { ok: false, noExiste: true, error: `El documento N° ${docId} ya no existe: recarga la pantalla.` }; }
    return { ok: true, url: sub.url, docId: f ? Number(f.id) : docId };
  }
}

// ══ Experiencia (experiencia_empresa, licitaciones-02) ═══════════════════════════
const SQL_EXP = SQL_LICITACIONES.experiencia;

/** El catálogo. Por defecto solo las activas; del contrato más reciente al más antiguo. */
export async function leerExperiencia(opts: { incluirInactivas?: boolean } = {}): Promise<Resultado<{ filas: Experiencia[] }>> {
  const db = await cliente();
  const l = await leer(db, "experiencia_empresa", COLS_EXP, [], (q) => (opts.incluirInactivas ? q : q.eq("activo", true)),
    [{ col: "inicio", asc: false }, { col: "id", asc: false }]);
  if (l.estado !== "ok") return explicar(l.causa, { accion: "leer la experiencia de la empresa", tabla: "experiencia_empresa", sql: SQL_EXP });
  return { ok: true, filas: l.filas.map(aExperiencia) };
}

export type EntradaExperiencia = Omit<Experiencia, "id" | "activo"> & { id?: number | null; activo?: boolean };

/** Valida con las reglas de licitaciones-02, en castellano y antes de mandar nada. */
export function validarExperiencia(e: EntradaExperiencia): { fila: Record<string, unknown> } | { error: string } {
  const t = (x: unknown) => (typeof x === "string" ? x.trim() : x == null ? "" : String(x).trim());
  const cliente_nombre = t(e.cliente_nombre);
  if (!cliente_nombre) return { error: "Falta el nombre del cliente." };
  if (largo(cliente_nombre) > 200) return { error: "El nombre del cliente pasa de 200 caracteres." };
  const rucCrudo = t(e.cliente_ruc).replace(/[\s.-]/g, "");
  if (rucCrudo && !/^\d{11}$/.test(rucCrudo)) return { error: "El RUC del cliente debe tener 11 dígitos." };
  const objeto = t(e.objeto) || "Transporte de personal";
  if (largo(objeto) > 500) return { error: "El objeto pasa de 500 caracteres." };
  const cortos: Record<string, [unknown, number, string]> = {
    contacto_nombre: [e.contacto_nombre, 120, "el nombre del contacto"], contacto_cargo: [e.contacto_cargo, 120, "el cargo del contacto"],
    contacto_telefono: [e.contacto_telefono, 120, "el teléfono del contacto"], contacto_email: [e.contacto_email, 120, "el correo del contacto"],
    sector: [e.sector, 80, "el sector"], zona: [e.zona, 200, "la zona"], sustento_ref: [e.sustento_ref, 120, "la referencia del sustento"],
    notas: [e.notas, 2000, "las notas"],
  };
  const fila: Record<string, unknown> = { cliente_nombre, cliente_ruc: rucCrudo || null, objeto };
  for (const [k, [v, max, rotulo]] of Object.entries(cortos)) {
    const s = t(v);
    if (largo(s) > max) return { error: `${rotulo[0].toUpperCase()}${rotulo.slice(1)} pasa de ${max} caracteres.` };
    fila[k] = s || null;
  }
  if (!esFechaISO(e.inicio)) return { error: "Falta la fecha de inicio del contrato (o no es válida)." };
  if (e.fin != null && e.fin !== ("" as unknown) && !esFechaISO(e.fin)) return { error: "La fecha de fin no es válida." };
  const fin = e.fin ? e.fin : null;
  if (fin && fin < e.inicio) return { error: "La fecha de fin es anterior a la de inicio." };
  if (e.sustento_fecha && !esFechaISO(e.sustento_fecha)) return { error: "La fecha del sustento no es válida." };
  if (e.sustento_tipo != null && !(SUSTENTOS as readonly string[]).includes(e.sustento_tipo)) return { error: "El tipo de sustento no es válido." };
  let importe: number | null = null;
  if (e.importe != null && (e.importe as unknown) !== "") {
    const n = Number(e.importe);
    if (!Number.isFinite(n) || n < 0 || n > 999_999_999_999.99) return { error: "El importe debe ser un número mayor o igual a cero." };
    importe = Math.round(n * 100) / 100;
  }
  if (e.moneda != null && e.moneda !== "PEN" && e.moneda !== "USD") return { error: "La moneda debe ser soles (PEN) o dólares (USD)." };
  const moneda: Moneda = e.moneda === "USD" ? "USD" : "PEN";
  const sustentos = lista(e.sustentos).map(aArchivoRef).filter((a): a is ArchivoRef => !!a);
  if (sustentos.length > 20) return { error: "Hay más de 20 archivos de sustento: deja los que acreditan el contrato." };
  if (e.cliente_id != null && enteroEn(e.cliente_id, 1, Number.MAX_SAFE_INTEGER) == null) return { error: "El cliente del ERP elegido no es válido." };
  Object.assign(fila, {
    cliente_id: e.cliente_id ?? null, inicio: e.inicio, fin, vigente: e.vigente === true, sustento_tipo: e.sustento_tipo ?? null,
    sustento_fecha: e.sustento_fecha || null, importe, moneda,
    importe_incluye_igv: typeof e.importe_incluye_igv === "boolean" ? e.importe_incluye_igv : null,
    sustentos, ...(e.activo != null ? { activo: e.activo === true } : {}),
  });
  return { fila };
}

/** Inserta (sin id) o actualiza (con id) una experiencia. Devuelve la fila como quedó en la base. */
export async function guardarExperiencia(entrada: EntradaExperiencia): Promise<Resultado<{ fila: Experiencia }>> {
  const v = validarExperiencia(entrada);
  if ("error" in v) return { ok: false, error: v.error };
  const db = await cliente();
  const id = entrada.id != null ? enteroEn(entrada.id, 1, Number.MAX_SAFE_INTEGER) : null;
  const { data, error } = id != null
    ? await db.from("experiencia_empresa").update(v.fila).eq("id", id).select(COLS_EXP.join(","))
    : await db.from("experiencia_empresa").insert(v.fila).select(COLS_EXP.join(","));
  if (error) return explicar(error, { accion: "guardar la experiencia", tabla: "experiencia_empresa", sql: SQL_EXP });
  const f = ((data ?? []) as Fila[])[0];
  if (!f) return { ok: false, noExiste: id != null, sinPermiso: id == null, error: id != null ? `La experiencia N° ${id} ya no existe.` : "La experiencia no se pudo leer después de guardarla: revisa el permiso del módulo Licitaciones." };
  return { ok: true, fila: aExperiencia(f) };
}

/**
 * Se DESACTIVA, no se borra: las licitaciones guardan los ids de su experiencia (D2) y las emisiones ya
 * presentadas la citan; borrarla dejaría esas referencias apuntando a nada. Desactivada sale del catálogo
 * para elegir, y una licitación que la tenía la sigue viendo (y la revisión lo dice).
 */
export async function desactivarExperiencia(id: number): Promise<Resultado<{ fila: Experiencia }>> { return activarExperiencia(id, false); }
export async function reactivarExperiencia(id: number): Promise<Resultado<{ fila: Experiencia }>> { return activarExperiencia(id, true); }
async function activarExperiencia(id: number, activo: boolean): Promise<Resultado<{ fila: Experiencia }>> {
  const db = await cliente();
  const { data, error } = await db.from("experiencia_empresa").update({ activo }).eq("id", id).select(COLS_EXP.join(","));
  if (error) return explicar(error, { accion: activo ? "reactivar la experiencia" : "desactivar la experiencia", tabla: "experiencia_empresa", sql: SQL_EXP });
  const f = ((data ?? []) as Fila[])[0];
  if (!f) return { ok: false, noExiste: true, error: `La experiencia N° ${id} ya no existe.` };
  return { ok: true, fila: aExperiencia(f) };
}

export type SugerenciaReservas = {
  clienteId: number; desde: FechaISO; hasta: FechaISO;
  /** tramos no cancelados (ida y retorno cuentan por separado) */
  servicios: number; dias: number;
  /** Σ reservas.precio_cliente de esos tramos (el retorno suele ir en 0: la tarifa del día vive en un tramo) */
  importe: number; sinPrecio: number;
};
/**
 * SOLO INFORMATIVA (se enseña al lado del formulario; nunca se escribe en experiencia_empresa): desde
 * cuándo, cuántos servicios y cuánto registra Programación para ese cliente. Sin servicios → null.
 */
export async function sugerenciaReservas(clienteId: number): Promise<Resultado<{ sugerencia: SugerenciaReservas | null }>> {
  if (!Number.isSafeInteger(clienteId) || clienteId <= 0) return { ok: true, sugerencia: null };
  const db = await cliente();
  const l = await leer(db, "reservas", ["id", "fecha_servicio", "precio_cliente", "estado"], [],
    (q) => q.eq("cliente_id", clienteId).or("estado.is.null,estado.neq.cancelada"),
    [{ col: "fecha_servicio" }, { col: "id" }]);
  if (l.estado !== "ok") return explicar(l.causa, { accion: "leer los servicios del cliente", tabla: "reservas", modulo: "Programación" });
  const filas = l.filas.filter((r) => fecha(r.fecha_servicio));
  if (!filas.length) return { ok: true, sugerencia: null };
  let importe = 0, sinPrecio = 0;
  const dias = new Set<string>();
  for (const r of filas) {
    dias.add(String(fecha(r.fecha_servicio)));
    const p = num(r.precio_cliente);
    if (p != null && p > 0) importe += p; else sinPrecio++;
  }
  const fechas = filas.map((r) => fecha(r.fecha_servicio) as string).sort();
  return {
    ok: true, sugerencia: {
      clienteId, desde: fechas[0], hasta: fechas[fechas.length - 1], servicios: filas.length, dias: dias.size,
      importe: Math.round(importe * 100) / 100, sinPrecio,
    },
  };
}

// ══ Año de una unidad tercerizada (licitaciones-04) ═══════════════════════════════
/** Escribe vehiculos_tercero.anio (la fila autoritativa, desde Recursos). null lo borra. */
export async function guardarAnioTercero(id: number, anio: number | null): Promise<Resultado<{ anio: number | null }>> {
  const valor = anio == null ? null : enteroEn(anio, 1950, 2100);
  if (anio != null && valor == null) return { ok: false, error: "El año debe ser un número entre 1950 y 2100." };
  const db = await cliente();
  const { data, error } = await db.from("vehiculos_tercero").update({ anio: valor }).eq("id", id).select("id, anio");
  if (error) {
    if (columnaFaltante(error) === "anio") return { ok: false, sinMigracion: SQL_LICITACIONES.accesorias, error: `Las unidades tercerizadas todavía no tienen dónde guardar el año: corre ${SQL_LICITACIONES.accesorias} en Supabase → SQL Editor.` };
    return explicar(error, { accion: "guardar el año de la unidad", tabla: "vehiculos_tercero", modulo: "Tercerizadas" });
  }
  const f = ((data ?? []) as Fila[])[0];
  if (!f) return { ok: false, noExiste: true, error: `La unidad tercerizada N° ${id} ya no existe (o no tienes permiso de editarla).` };
  return { ok: true, anio: ent(f.anio) };
}

// ══ Emisiones ═════════════════════════════════════════════════════════════════
export type FilaEmisionResumen = Omit<FilaEmision, "foto"> & { emitido_por_nombre: string | null };
const COLS_EMISION = ["id", "licitacion_id", "version", "carpeta", "emitido_por", "emitido_en", "doc_version", "firma", "archivos", "hallazgos", "omitidos", "nota"];

function aEmision(r: Fila): Omit<FilaEmision, "foto"> {
  return {
    id: Number(r.id), licitacion_id: Number(r.licitacion_id), version: Number(r.version), carpeta: String(r.carpeta ?? ""),
    emitido_por: String(r.emitido_por ?? ""), emitido_en: instante(r.emitido_en), doc_version: Number(r.doc_version),
    firma: String(r.firma ?? ""), archivos: lista(r.archivos) as FilaEmision["archivos"], hallazgos: lista(r.hallazgos) as FilaEmision["hallazgos"],
    omitidos: lista(r.omitidos) as FilaEmision["omitidos"], nota: str(r.nota),
  };
}

/** Las emisiones de una licitación, de la más reciente a la primera, SIN la foto (pesa hasta 6 MB). */
export async function leerEmisiones(licId: number): Promise<Resultado<{ filas: FilaEmisionResumen[] }>> {
  const db = await cliente();
  const l = await leer(db, "licitacion_emisiones", COLS_EMISION, [], (q) => q.eq("licitacion_id", licId), [{ col: "version", asc: false }, { col: "id", asc: false }]);
  if (l.estado !== "ok") return explicar(l.causa, { accion: "leer las emisiones", tabla: "licitacion_emisiones", sql: SQL_LICITACIONES.tablas });
  const filas = l.filas.map(aEmision);
  const nombres = await nombresDeUsuarios(db, filas.map((f) => f.emitido_por));
  return { ok: true, filas: filas.map((f) => ({ ...f, emitido_por_nombre: nombres.get(f.emitido_por) ?? null })) };
}

/** La última emisión COMPLETA (con su foto), o null si nunca se emitió. La revisión la usa para decir qué cambió. */
export async function ultimaEmision(licId: number): Promise<Resultado<{ emision: FilaEmision | null }>> {
  const db = await cliente();
  const { data, error } = await db.from("licitacion_emisiones").select([...COLS_EMISION, "foto"].join(","))
    .eq("licitacion_id", licId).order("version", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
  if (error) return explicar(error, { accion: "leer la última emisión", tabla: "licitacion_emisiones", sql: SQL_LICITACIONES.tablas });
  if (!data) return { ok: true, emision: null };
  const r = data as Fila;
  return { ok: true, emision: { ...aEmision(r), foto: (esObjeto(r.foto) ? r.foto : {}) as FilaEmision["foto"] } };
}
