// scripts/prueba-licitaciones-datos.mts — Matriz de lib/licitaciones/datos.ts (la capa de datos del módulo).
//   npx tsx scripts/prueba-licitaciones-datos.mts
//
// Corre las funciones DE VERDAD contra un Supabase FALSO en memoria (tablas con sus columnas, paginado,
// filtros, triggers de versión y almacenamiento). Lo que fija, y por qué:
//  1. Guardar es UN update con .eq("version"): versión vieja → conflicto con QUIÉN y CUÁNDO (no se fusiona).
//  2. Una fuente que falla en la página 2 queda en "error" (no "ok" con media lista); las demás, "ok".
//     Barrido: un error en CUALQUIER tabla de una fuente la deja en "error"; sin errores, todas "ok" (corolario).
//  3. Tabla inexistente → "sin_tabla"; columna accesoria inexistente → se suelta SOLO esa y se dice
//     (migraciones.anioTercero / conductorTercero / fechaConstitucion).
//  4. Tri-estado del conductor tercerizado: sus vencimientos médicos NO existen (undefined), no son null.
//  5. Documentos del tercero: los de su placa y los de su empresa sin placa (deEmpresa); no los de otra.
//  6. subirArchivo usa rutaNueva, upsert:false y el mime del CONTENIDO; nunca sube algo que no es lo que dice.
//  7. subirDocUnidad escribe la fila AUTORITATIVA conservando lo que no se manda y el enlace anterior.
//  8. Retoques: ELIA lee la lista única de categorías; TIPOS_SEGURO tiene `deshonestidad`.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import {
  fijarClienteDatos, guardarLicitacion, crearLicitacion, leerLicitacion, leerLicitaciones, duplicarLicitacion, archivarLicitacion,
  cargarContexto, buscarUnidades, buscarConductores, subirArchivo, ErrorLicitaciones, leerLegajo, subirDocumentoLegajo,
  actualizarFechasLegajo, borrarDocumentoLegajo, subirDocumentoConductor, leerDocsConductor, subirDocUnidad, leerExperiencia,
  guardarExperiencia, desactivarExperiencia, sugerenciaReservas, guardarAnioTercero, leerEmisiones, ultimaEmision,
  SQL_LICITACIONES, firmaDeBytes, observacionesConEnlaceAnterior, type ResultadoGuardar,
} from "../lib/licitaciones/datos";
import { normalizarDoc, docVacio } from "../lib/licitaciones/normalizar";
import { rutaNueva } from "../lib/licitaciones/archivos";
import type { Licitacion, FuenteContexto, TipoSeguroLic } from "../lib/licitaciones/tipos";
import { TIPOS_SEGURO } from "../lib/seguros";
import { CATEGORIAS_DOCUMENTO } from "../lib/documentos-empresa-categorias";

let ok = 0, fallos = 0;
const check = (c: unknown, m: string) => { if (c) ok++; else { fallos++; console.log("  ✗", m); } };
const sec = (t: string) => console.log(`\n── ${t}`);
const BASE = "https://proyecto.supabase.co";
let contador = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++contador).padStart(12, "0")}`;

// ══ Supabase falso ═════════════════════════════════════════════════════════════
type Fila = Record<string, unknown>;
type Tabla = { cols: string[]; filas: Fila[] };
type Fallo = { tabla: string; op?: string; desde?: number; error: { code?: string; message: string } };
type Llamada = { tabla: string; op: string; patch?: Fila; filas?: Fila[]; filtros: string[]; cols: string[] };

class DbFalsa {
  tablas: Record<string, Tabla | undefined> = {};
  fallos: Fallo[] = [];
  usuario = "u-yo";
  reloj = 0;
  llamadas: Llamada[] = [];
  buckets: Record<string, Map<string, { tam: number; opts: Fila }>> = {};
  subidas: { bucket: string; ruta: string; opts: Fila }[] = [];
  removidos: string[] = [];
  ahora() { return `2026-10-24T12:00:${String(++this.reloj % 60).padStart(2, "0")}Z`; }
  tabla(t: string, cols: string[], filas: Fila[] = []) { this.tablas[t] = { cols, filas: filas.map((f) => ({ ...f })) }; return this; }
  from(t: string) { return new Consulta(this, t); }
  get storage() {
    return {
      from: (b: string) => ({
        upload: async (ruta: string, cuerpo: Blob, opts: Fila) => {
          const bk = this.buckets[b];
          if (!bk) return { data: null, error: { message: "Bucket not found", statusCode: "404" } };
          if (bk.has(ruta) && !opts?.upsert) return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
          bk.set(ruta, { tam: cuerpo.size, opts });
          this.subidas.push({ bucket: b, ruta, opts });
          return { data: { path: ruta }, error: null };
        },
        getPublicUrl: (ruta: string) => ({ data: { publicUrl: `${BASE}/storage/v1/object/public/${b}/${ruta}` } }),
        remove: async (rutas: string[]) => { for (const r of rutas) { this.buckets[b]?.delete(r); this.removidos.push(`${b}/${r}`); } return { data: null, error: null }; },
      }),
    };
  }
}

type Filtro = { col: string; fn: (f: Fila) => boolean; txt: string };
class Consulta {
  op: "select" | "update" | "insert" | "delete" = "select";
  cols: string[] = [];
  retorna = false;
  filtros: Filtro[] = [];
  orden: { col: string; asc: boolean; nullsFirst: boolean }[] = [];
  rango: [number, number] | null = null;
  limite: number | null = null;
  modo: "lista" | "maybe" | "single" = "lista";
  patch: Fila | null = null;
  nuevas: Fila[] = [];
  constructor(private db: DbFalsa, private t: string) {}
  select(c = "*") {
    const cols = c.split(",").map((x) => x.trim()).filter(Boolean);
    if (this.op === "select") this.cols = cols; else { this.retorna = true; this.cols = cols; }
    return this;
  }
  insert(f: Fila | Fila[]) { this.op = "insert"; this.nuevas = (Array.isArray(f) ? f : [f]).map((x) => ({ ...x })); return this; }
  update(p: Fila) { this.op = "update"; this.patch = { ...p }; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col: string, v: unknown) { this.filtros.push({ col, fn: (f) => f[col] === v, txt: `${col}=eq.${v}` }); return this; }
  neq(col: string, v: unknown) { this.filtros.push({ col, fn: (f) => f[col] != null && f[col] !== v, txt: `${col}=neq.${v}` }); return this; }
  in(col: string, vs: unknown[]) { this.filtros.push({ col, fn: (f) => vs.includes(f[col]), txt: `${col}=in.(${vs.join(",")})` }); return this; }
  is(col: string, v: null) { this.filtros.push({ col, fn: (f) => f[col] == v, txt: `${col}=is.${v}` }); return this; }
  or(expr: string) {
    const partes = expr.split(",").map((p) => { const [col, op, ...val] = p.split("."); return { col, op, val: val.join(".") }; });
    this.filtros.push({
      col: partes[0].col, txt: `or=(${expr})`,
      fn: (f) => partes.some((p) => p.op === "is" ? f[p.col] == null : p.op === "neq" ? f[p.col] != null && String(f[p.col]) !== p.val : String(f[p.col]) === p.val),
    });
    return this;
  }
  order(col: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    const asc = o.ascending ?? true;
    this.orden.push({ col, asc, nullsFirst: o.nullsFirst ?? !asc });
    return this;
  }
  range(a: number, b: number) { this.rango = [a, b]; return this; }
  limit(n: number) { this.limite = n; return this; }
  maybeSingle() { this.modo = "maybe"; return this; }
  single() { this.modo = "single"; return this; }
  then<A, B>(res: (v: { data: unknown; error: unknown }) => A, rej?: (e: unknown) => B) { return Promise.resolve(this.exec()).then(res, rej); }

  private exec(): { data: unknown; error: unknown } {
    const db = this.db, t = this.t;
    db.llamadas.push({ tabla: t, op: this.op, patch: this.patch ?? undefined, filas: this.nuevas, filtros: this.filtros.map((f) => f.txt), cols: this.cols });
    const tb = db.tablas[t];
    if (!tb) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${t}' in the schema cache` } };
    const fallo = db.fallos.find((f) => f.tabla === t && (f.op ?? "select") === this.op && (f.desde == null || this.rango?.[0] === f.desde));
    if (fallo) return { data: null, error: fallo.error };
    for (const k of [...(this.patch ? Object.keys(this.patch) : []), ...this.nuevas.flatMap((n) => Object.keys(n))]) {
      if (!tb.cols.includes(k)) return { data: null, error: { code: "PGRST204", message: `Could not find the '${k}' column of '${t}' in the schema cache` } };
    }
    for (const c of [...this.cols.filter((c) => c !== "*"), ...this.filtros.map((f) => f.col), ...this.orden.map((o) => o.col)]) {
      if (!tb.cols.includes(c)) return { data: null, error: { code: "42703", message: `column ${t}.${c} does not exist` } };
    }
    const pasa = (f: Fila) => this.filtros.every((x) => x.fn(f));
    const proyectar = (f: Fila) => (this.cols.length && !this.cols.includes("*") ? Object.fromEntries(this.cols.map((c) => [c, f[c] ?? null])) : { ...f });
    let salida: Fila[];
    if (this.op === "insert") {
      salida = [];
      for (const n of this.nuevas) {
        const id = Math.max(0, ...tb.filas.map((f) => Number(f.id) || 0)) + 1;
        const fila: Fila = { ...Object.fromEntries(tb.cols.map((c) => [c, null])), id, ...n };
        if (t === "licitaciones") Object.assign(fila, { version: 1, creado_por: db.usuario, creado_en: db.ahora(), actualizado_por: db.usuario, actualizado_en: db.ahora() });
        if (tb.cols.includes("created_at") && !fila.created_at) fila.created_at = db.ahora();
        if (tb.cols.includes("activo") && fila.activo == null) fila.activo = true;
        tb.filas.push(fila); salida.push(fila);
      }
      if (!this.retorna) return { data: null, error: null };
    } else if (this.op === "update") {
      salida = tb.filas.filter(pasa);
      for (const f of salida) {
        Object.assign(f, this.patch);
        if (t === "licitaciones") Object.assign(f, { version: Number(f.version) + 1, actualizado_por: db.usuario, actualizado_en: db.ahora() });
      }
      if (!this.retorna) return { data: null, error: null };
    } else if (this.op === "delete") {
      salida = tb.filas.filter(pasa);
      tb.filas = tb.filas.filter((f) => !pasa(f));
      if (!this.retorna) return { data: null, error: null };
    } else {
      salida = tb.filas.filter(pasa);
    }
    salida = [...salida].sort((a, b) => {
      for (const o of this.orden) {
        const x = a[o.col], y = b[o.col];
        if (x == null && y == null) continue;
        if (x == null) return o.nullsFirst ? -1 : 1;
        if (y == null) return o.nullsFirst ? 1 : -1;
        if (x === y) continue;
        return (x < y ? -1 : 1) * (o.asc ? 1 : -1);
      }
      return 0;
    });
    if (this.rango) salida = salida.slice(this.rango[0], this.rango[1] + 1);
    if (this.limite != null) salida = salida.slice(0, this.limite);
    const data = salida.map(proyectar);
    if (this.modo === "maybe") return { data: data[0] ?? null, error: null };
    if (this.modo === "single") return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
    return { data, error: null };
  }
}

// ══ Esquema base (columnas reales del repo) ════════════════════════════════════
const C_LIC = ["id", "nombre", "cliente_id", "cliente_nombre", "codigo", "objeto", "atencion", "fecha_consultas", "fecha_presentacion",
  "hora_presentacion", "fecha_inicio_servicio", "plazo_meses", "estado", "archivada", "doc", "version", "creado_por", "creado_en", "actualizado_por", "actualizado_en"];
const C_EMI = ["id", "licitacion_id", "version", "carpeta", "emitido_por", "emitido_en", "doc_version", "firma", "foto", "archivos", "hallazgos", "omitidos", "nota"];
const C_PERFIL = ["id", "nombre", "razon_social", "ruc", "logo_url", "logo_claro_url", "telefono", "email", "direccion", "web", "autorizacion_mtc", "cuentas_bancarias", "fecha_constitucion"];
const C_VEH = ["id", "placa", "marca", "modelo", "anio", "capacidad_pasajeros", "categoria", "estado", "foto_externa_url", "foto_interna_url"];
const C_VT = ["id", "empresa_id", "placa", "marca", "modelo", "anio", "capacidad", "categoria", "estado", "foto_externa_url", "foto_interna_url"];
const C_EMP = ["id", "razon_social", "ruc", "autorizacion_mtc", "venc_autorizacion", "estado"];
const C_DV = ["id", "vehiculo_id", "conductor_id", "tipo", "numero", "fecha_emision", "fecha_vencimiento", "entidad_emisora", "archivo_url", "observaciones", "created_at"];
const C_DT = ["id", "empresa_id", "vehiculo_id", "tipo", "numero", "fecha_emision", "fecha_vencimiento", "entidad_emisora", "archivo_url", "observaciones"];
const C_COND = ["id", "nombre", "dni", "licencia", "categoria_licencia", "vencimiento_licencia", "examen_medico_venc", "antecedentes_venc", "psicosometrico_venc", "estado",
  "sctr_salud_venc", "sctr_pension_venc", "vida_ley", "vida_ley_venc"];
const C_CT = ["id", "empresa_id", "nombre", "dni", "licencia", "categoria_licencia", "vencimiento_licencia", "telefono", "estado"];
const C_DE = ["id", "titulo", "categoria", "alcance", "archivo_url", "archivo_nombre", "cliente_id", "reserva_id", "proveedor_id", "conductor_id", "conductor_tercero_id",
  "privado", "fecha_emision", "fecha_vencimiento", "estado", "created_at"];
const C_EXP = ["id", "cliente_id", "cliente_nombre", "cliente_ruc", "contacto_nombre", "contacto_cargo", "contacto_telefono", "contacto_email", "objeto", "sector", "zona",
  "inicio", "fin", "vigente", "sustento_tipo", "sustento_ref", "sustento_fecha", "importe", "moneda", "importe_incluye_igv", "sustentos", "notas", "activo", "creado_por", "creado_en", "actualizado_en"];
const C_PERS = ["id", "nombre", "dni", "cargo", "telefono", "email", "estado", "sctr_salud_venc", "sctr_pension_venc", "vida_ley", "vida_ley_venc"];

const DOC_BASE = (extra: Fila = {}) => normalizarDoc({
  unidades: [
    { id: "u1", clave: "p:1", codigo: "U1", rol: "titular", uso: "", capacidadExigida: null },
    { id: "u2", clave: "t:5", codigo: "U2", rol: "titular", uso: "", capacidadExigida: null },
    { id: "u3", clave: "p:99", codigo: "U3", rol: "reten", uso: "", capacidadExigida: null },
  ],
  conductores: [{ id: "c1", clave: "p:3", rol: "titular", unidadCodigo: "U1" }, { id: "c2", clave: "t:7", rol: "relevo", unidadCodigo: null }],
  experiencia: { ids: [11, 12], ventanaAnios: null, conContacto: false, introduccion: "" },
  contactos: [{ id: "k1", rol: "Operaciones", personalId: 21, nombre: "", cargo: "", telefono: "", email: "", emergencia: false }],
  representante: { personalId: 22, nombre: "", dni: "", cargo: "", firma: null },
  ...extra,
}, uuid);

function dbBase(): DbFalsa {
  const db = new DbFalsa();
  db.buckets = { licitaciones: new Map(), documentos: new Map() };
  const doc = DOC_BASE();
  db.tabla("usuarios", ["id", "nombre"], [{ id: "u-yo", nombre: "Yo Mismo" }, { id: "u-ana", nombre: "Ana Pérez" }])
    .tabla("licitaciones", C_LIC, [
      { id: 1, nombre: "Transporte planta Lurín", cliente_id: 40, cliente_nombre: "CLIENTE UNO SAC", codigo: "LP-001", objeto: null, atencion: null,
        fecha_consultas: null, fecha_presentacion: "2026-11-10", hora_presentacion: "10:00:00", fecha_inicio_servicio: "2026-12-01", plazo_meses: 24,
        estado: "preparacion", archivada: false, doc, version: 3, creado_por: "u-yo", creado_en: "2026-10-01T00:00:00Z", actualizado_por: "u-ana", actualizado_en: "2026-10-20T15:00:00Z" },
      { id: 2, nombre: "Otra licitación", cliente_id: 41, cliente_nombre: "OTRO CLIENTE SA", codigo: "CP-77", objeto: null, atencion: null,
        fecha_consultas: null, fecha_presentacion: null, hora_presentacion: null, fecha_inicio_servicio: null, plazo_meses: null,
        estado: "presentada", archivada: false, doc: {}, version: 1, creado_por: "u-yo", creado_en: "2026-09-01T00:00:00Z", actualizado_por: "u-yo", actualizado_en: "2026-09-01T00:00:00Z" },
      { id: 3, nombre: "Archivada", cliente_id: null, cliente_nombre: "VIEJO SAC", codigo: null, objeto: null, atencion: null,
        fecha_consultas: null, fecha_presentacion: "2025-01-01", hora_presentacion: null, fecha_inicio_servicio: null, plazo_meses: null,
        estado: "desierta", archivada: true, doc: {}, version: 1, creado_por: "u-yo", creado_en: "2025-01-01T00:00:00Z", actualizado_por: "u-yo", actualizado_en: "2025-01-01T00:00:00Z" },
    ])
    .tabla("licitacion_emisiones", C_EMI, [
      { id: 1, licitacion_id: 1, version: 1, carpeta: uuid(), emitido_por: "u-ana", emitido_en: "2026-10-10T10:00:00Z", doc_version: 2, firma: "a".repeat(64), foto: { hoy: "2026-10-10" }, archivos: [], hallazgos: [], omitidos: [], nota: null },
      { id: 2, licitacion_id: 1, version: 2, carpeta: uuid(), emitido_por: "u-yo", emitido_en: "2026-10-15T10:00:00Z", doc_version: 3, firma: "b".repeat(64), foto: { hoy: "2026-10-15" }, archivos: [], hallazgos: [], omitidos: [], nota: "segunda" },
    ])
    .tabla("clientes", ["id", "nombre", "empresa"], [{ id: 40, nombre: "Juan", empresa: "CLIENTE UNO SAC" }, { id: 41, nombre: "OTRO CLIENTE", empresa: null }])
    .tabla("empresa_perfil", C_PERFIL, [{ id: 1, nombre: "MI EMPRESA", razon_social: "MI EMPRESA SAC", ruc: "20123456789", autorizacion_mtc: "R.D. 1", fecha_constitucion: "2010-05-04" }])
    .tabla("vehiculos", C_VEH, [{ id: 1, placa: "AAA-111", marca: "Mercedes", modelo: "O500", anio: 2019, capacidad_pasajeros: 50, categoria: "BUS", estado: "disponible", foto_externa_url: null, foto_interna_url: null },
      { id: 2, placa: "BBB-222", marca: "Toyota", modelo: "Coaster", anio: 2015, capacidad_pasajeros: 30, categoria: "MINIBUS", estado: "inactivo" }])
    .tabla("vehiculos_tercero", C_VT, [{ id: 5, empresa_id: 9, placa: "TTT-555", marca: "Hyundai", modelo: "County", anio: 2018, capacidad: 30, categoria: "MINIBUS", estado: "activo" },
      { id: 6, empresa_id: 9, placa: "TTT-666", marca: "Hyundai", modelo: "County", anio: 2020, capacidad: 30, categoria: "MINIBUS", estado: "activo" },
      { id: 8, empresa_id: 10, placa: "ZZZ-888", marca: "Kia", modelo: "Granbird", anio: 2016, capacidad: 45, categoria: "BUS", estado: "activo" }])
    .tabla("empresas_tercerizadas", C_EMP, [{ id: 9, razon_social: "TRANSPORTES SUR SAC", ruc: "20999999999", autorizacion_mtc: "R.D. 9", venc_autorizacion: "2027-01-01", estado: "activo" },
      { id: 10, razon_social: "INACTIVA SAC", ruc: null, autorizacion_mtc: null, venc_autorizacion: null, estado: "inactivo" }])
    .tabla("documentos_vehiculo", C_DV, [{ id: 50, vehiculo_id: 1, tipo: "SOAT", numero: "N1", fecha_emision: "2026-01-01", fecha_vencimiento: "2027-01-01", entidad_emisora: "Rimac",
      archivo_url: "https://drive.google.com/file/d/abc/view", observaciones: "Original" },
      { id: 51, vehiculo_id: 2, tipo: "SOAT", numero: "N2", fecha_emision: null, fecha_vencimiento: "2027-01-01", archivo_url: null }])
    .tabla("documentos_tercero", C_DT, [
      { id: 60, empresa_id: 9, vehiculo_id: 5, tipo: "revision tecnica", numero: "R5", fecha_vencimiento: "2026-12-01", archivo_url: null },
      { id: 61, empresa_id: 9, vehiculo_id: null, tipo: "SCTR Salud", numero: "S9", fecha_vencimiento: "2027-02-01", archivo_url: null },
      { id: 62, empresa_id: 10, vehiculo_id: null, tipo: "SCTR Salud", numero: "S10", fecha_vencimiento: "2027-02-01", archivo_url: null },
      { id: 63, empresa_id: 9, vehiculo_id: 6, tipo: "SOAT", numero: "X6", fecha_vencimiento: "2027-02-01", archivo_url: null }])
    .tabla("conductores", C_COND, [{ id: 3, nombre: "PEDRO", dni: "12345678", licencia: "Q1", categoria_licencia: "A-IIIc", vencimiento_licencia: "2028-01-01",
      examen_medico_venc: "2027-03-01", antecedentes_venc: null, psicosometrico_venc: "2026-12-31", estado: "activo" }])
    .tabla("conductores_tercero", C_CT, [{ id: 7, empresa_id: 9, nombre: "LUIS", dni: "87654321", licencia: "Q7", categoria_licencia: "A-IIIb", vencimiento_licencia: "2027-01-01", estado: "activo" }])
    .tabla("documentos_empresa", C_DE, [
      { id: 70, titulo: "Ficha RUC", categoria: "ficha_ruc", alcance: "empresa", archivo_url: `${BASE}/storage/v1/object/public/documentos/x.pdf`, fecha_emision: "2026-10-01", created_at: "2026-10-01T00:00:00Z" },
      { id: 71, titulo: "Contrato", categoria: "contrato", alcance: "empresa", archivo_url: null, created_at: "2026-10-01T00:00:00Z" },
      { id: 72, titulo: "Examen", categoria: "examen_medico", alcance: "conductor", conductor_id: 3, archivo_url: "u", created_at: "2026-10-01T00:00:00Z" },
      { id: 73, titulo: "Licencia", categoria: "licencia_conducir", alcance: "conductor", conductor_id: null, conductor_tercero_id: 7, archivo_url: "u", created_at: "2026-10-01T00:00:00Z" }])
    .tabla("experiencia_empresa", C_EXP, [
      { id: 11, cliente_nombre: "LATAM", inicio: "2023-01-01", fin: "2024-01-01", vigente: false, objeto: "Transporte de personal", moneda: "PEN", importe: 1000, sustentos: [], activo: true },
      { id: 12, cliente_nombre: "MAKRO", inicio: "2020-01-01", fin: null, vigente: true, objeto: "Transporte de personal", moneda: "USD", importe: null, sustentos: [{ url: `${BASE}/storage/v1/object/public/licitaciones/experiencia/x.pdf`, nombre: "oc.pdf", mime: "application/pdf" }], activo: false },
      { id: 13, cliente_nombre: "NO ELEGIDA", inicio: "2021-01-01", fin: null, vigente: false, objeto: "x", moneda: "PEN", sustentos: [], activo: true }])
    .tabla("personal_administrativo", C_PERS, [{ id: 21, nombre: "ROSA", dni: "11112222", cargo: "Jefa de operaciones", telefono: "999", email: "r@x", estado: "activo" },
      { id: 22, nombre: "JORGE", dni: "33334444", cargo: "Gerente general", telefono: null, email: null, estado: "activo" }])
    .tabla("seguros", ["id", "tipo", "aseguradora", "numero_poliza", "titular", "vehiculo_id", "fecha_inicio", "fecha_vencimiento", "prima_total", "cuota_mensual", "archivo_url", "vehiculo_tercero_id", "alcance", "coberturas"],
      [{ id: 1, tipo: "deshonestidad", aseguradora: "Rimac", numero_poliza: "D-1", fecha_vencimiento: "2027-01-01", alcance: "colectiva" }])
    .tabla("seguro_cobertura", ["id", "seguro_id", "conductor_id", "personal_administrativo_id", "vehiculo_id", "vehiculo_tercero_id", "desde", "hasta", "estado", "solicitada_en", "constancia_url", "nota"], [])
    .tabla("reservas", ["id", "cliente_id", "fecha_servicio", "precio_cliente", "estado"], [
      { id: 1, cliente_id: 40, fecha_servicio: "2026-05-02", precio_cliente: 500, estado: "finalizada" },
      { id: 2, cliente_id: 40, fecha_servicio: "2026-05-02", precio_cliente: 0, estado: "finalizada" },
      { id: 3, cliente_id: 40, fecha_servicio: "2026-06-10", precio_cliente: 700, estado: "cancelada" },
      { id: 4, cliente_id: 40, fecha_servicio: "2026-07-01", precio_cliente: 300.5, estado: null },
      { id: 5, cliente_id: 41, fecha_servicio: "2026-08-01", precio_cliente: 999, estado: "finalizada" }]);
  return db;
}
const usar = (db: DbFalsa) => { fijarClienteDatos(db); return db; };
const licDe = async (db: DbFalsa, id = 1): Promise<Licitacion> => { const r = await leerLicitacion(id); if (!r.ok) throw new Error(r.error); void db; return r.lic; };
const sinCol = (db: DbFalsa, tabla: string, col: string) => { const t = db.tablas[tabla]!; t.cols = t.cols.filter((c) => c !== col); for (const f of t.filas) delete f[col]; };
const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ══ 1. Guardar con bloqueo optimista ═══════════════════════════════════════════
sec("1. guardarLicitacion: un solo UPDATE con .eq(version); conflicto con quién y cuándo");
{
  const db = usar(dbBase());
  const lic = await licDe(db);
  check(lic.version === 3 && lic.hora_presentacion === "10:00" && lic.doc.unidades.length === 3, "leerLicitacion: fila completa con doc normalizado y hora HH:MM");
  db.llamadas = [];
  const r = await guardarLicitacion(lic, { nombre: "  Nuevo nombre  ", plazo_meses: 12 });
  const ups = db.llamadas.filter((l) => l.tabla === "licitaciones" && l.op === "update");
  check(ups.length === 1 && ups[0].filtros.includes("id=eq.1") && ups[0].filtros.includes("version=eq.3"), "UN update con id y version");
  check(r.ok && r.lic.version === 4 && r.lic.nombre === "Nuevo nombre" && r.lic.plazo_meses === 12, "guardar bien → versión nueva y datos recortados");
  check(!ups[0].patch || !("doc" in ups[0].patch), "sin doc en cambios no viaja el doc");
  // otra pestaña con la versión vieja
  const r2: ResultadoGuardar = await guardarLicitacion(lic, { nombre: "Pisaría" });
  check(!r2.ok && r2.conflicto === true && r2.version === 4 && r2.por === "Yo Mismo" && r2.porId === "u-yo" && !!r2.en, "versión vieja → conflicto con quién (nombre) y cuándo");
  check((await licDe(db)).nombre === "Nuevo nombre", "el conflicto no escribió nada");
  // quien guardó fue otra persona
  db.usuario = "u-ana";
  const l4 = await licDe(db);
  await guardarLicitacion(l4, { codigo: "X" });
  db.usuario = "u-yo";
  const r3 = await guardarLicitacion(l4, { codigo: "Y" });
  check(!r3.ok && r3.conflicto && r3.por === "Ana Pérez", "conflicto nombra a la otra persona");
  // doc: se normaliza y viaja
  const l5 = await licDe(db);
  const r4 = await guardarLicitacion(l5, { doc: { ...l5.doc, unidades: [] } as unknown as Licitacion["doc"] });
  check(r4.ok && r4.lic.doc.unidades.length === 0 && r4.lic.doc.esquema === 1, "el doc se guarda normalizado");
  // validaciones antes de la red
  db.llamadas = [];
  const v1 = await guardarLicitacion(r4.ok ? r4.lic : l5, { nombre: "   " });
  const v2 = await guardarLicitacion(r4.ok ? r4.lic : l5, { fecha_presentacion: "2026-02-30" });
  const v3 = await guardarLicitacion(r4.ok ? r4.lic : l5, { plazo_meses: 241 });
  const v4 = await guardarLicitacion(r4.ok ? r4.lic : l5, { hora_presentacion: "25:00" });
  check(!v1.ok && !v2.ok && !v3.ok && !v4.ok && db.llamadas.length === 0, "nombre vacío, fecha inexistente, plazo y hora inválidos: error sin llamar a la base");
  check(!v2.ok && !v2.conflicto && /fecha de presentación/.test(v2.error), "el error nombra el campo");
  const sin = await guardarLicitacion(l5, {});
  check(sin.ok && db.llamadas.length === 0, "sin cambios no se llama a la base");
  const grande = await guardarLicitacion(l5, { doc: { ...l5.doc, secciones: Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, titulo: "T", activa: true, numerada: true, bloques: Array.from({ length: 300 }, (_, j) => ({ id: `b${i}-${j}`, tipo: "parrafo", texto: "x".repeat(400) })) })) } as unknown as Licitacion["doc"] });
  check(!grande.ok && !grande.conflicto && /tope es 3\.0 MB/.test(grande.error) && db.llamadas.length === 0, "doc de más de 3 MB: error antes de mandar");
  // borrada por otro
  db.tablas.licitaciones!.filas = db.tablas.licitaciones!.filas.filter((f) => f.id !== 1);
  const r5 = await guardarLicitacion(l5, { nombre: "Z" });
  check(!r5.ok && !r5.conflicto && r5.noExiste === true, "fila borrada → noExiste, no conflicto");
  // sin la tabla
  const db2 = usar(dbBase()); const l6 = await licDe(db2); db2.tablas.licitaciones = undefined;
  const r6 = await guardarLicitacion(l6, { nombre: "Z" });
  check(!r6.ok && !r6.conflicto && r6.sinMigracion === SQL_LICITACIONES.tablas && /licitaciones-01a/.test(r6.error), "sin la tabla → nombra licitaciones-01a");
  // RLS: el update no toca filas y la relectura ve la misma versión
  const db3 = usar(dbBase()); const l7 = await licDe(db3);
  db3.fallos.push({ tabla: "licitaciones", op: "update", error: { code: "42501", message: "new row violates row-level security policy for table \"licitaciones\"" } });
  const r7 = await guardarLicitacion(l7, { nombre: "Z" });
  check(!r7.ok && !r7.conflicto && r7.sinPermiso === true && /permiso del módulo Licitaciones/.test(r7.error), "RLS → sinPermiso en castellano");
}

// ══ 2. Crear, duplicar, archivar, lista ═══════════════════════════════════════
sec("2. crear · duplicar · archivar · lista liviana con última emisión");
{
  const db = usar(dbBase());
  const c = await crearLicitacion({ nombre: "Nueva", cliente_id: 40, cliente_nombre: "CLIENTE UNO SAC", codigo: "N-1", fecha_presentacion: "2026-12-01" }, docVacio(uuid));
  check(c.ok && c.lic.version === 1 && c.lic.creado_por === "u-yo" && c.lic.estado === "preparacion" && !c.lic.archivada, "crear: versión 1, creado por la sesión");
  const sinCliente = await crearLicitacion({ nombre: "X", cliente_id: null, cliente_nombre: " " }, docVacio(uuid));
  check(!sinCliente.ok && /cliente/.test(sinCliente.error), "crear sin cliente → error");
  if (c.ok) {
    const d = await duplicarLicitacion(c.lic, "Copia", docVacio(uuid));
    check(d.ok && d.lic.cliente_id === 40 && d.lic.codigo === null && d.lic.fecha_presentacion === null && d.lic.id !== c.lic.id, "duplicar: copia el cliente, no el código ni las fechas");
    const a = await archivarLicitacion(c.lic.id, true);
    check(a.ok && a.archivada && a.version === 2, "archivar sube la versión");
  }
  db.llamadas = [];
  const l = await leerLicitaciones();
  const sel = db.llamadas.find((x) => x.tabla === "licitaciones");
  check(l.ok && !!sel && !sel.cols.includes("doc"), "la lista no pide el doc");
  if (l.ok) {
    check(l.filas.every((f) => !f.archivada) && l.filas.some((f) => f.id === 1), "por defecto solo las vigentes");
    const f1 = l.filas.find((f) => f.id === 1)!;
    check(f1.ultimaEmision?.version === 2 && f1.ultimaEmision.emitido_por_nombre === "Yo Mismo" && f1.actualizado_por_nombre === "Ana Pérez", "última emisión = la de mayor versión, con nombre");
    check(l.filas.find((f) => f.id === 2)!.ultimaEmision === null && l.emisiones === "ok", "sin emisiones → null (leída)");
    const orden = l.filas.map((f) => f.fecha_presentacion);
    check(orden.indexOf(null) === orden.length - 1 || !orden.includes(null), "sin fecha de presentación al final");
  }
  const arch = await leerLicitaciones({ archivadas: true });
  check(arch.ok && arch.filas.length >= 1 && arch.filas.every((f) => f.archivada), "archivadas: true → solo archivadas");
  const todas = await leerLicitaciones({ archivadas: "todas" });
  check(todas.ok && todas.filas.length === db.tablas.licitaciones!.filas.length, "todas");
  db.tablas.licitacion_emisiones = undefined;
  const l2 = await leerLicitaciones();
  check(l2.ok && l2.emisiones === "sin_tabla" && l2.avisos.some((a) => a.includes("licitaciones-01a")) && l2.filas.every((f) => f.ultimaEmision === null), "sin tabla de emisiones: la lista sale y lo dice");
  db.tablas.licitaciones = undefined;
  const l3 = await leerLicitaciones();
  check(!l3.ok && l3.sinMigracion === SQL_LICITACIONES.tablas, "sin tabla de licitaciones → nombra 01a");
  const nx = await leerLicitacion(5);
  check(!nx.ok && nx.sinMigracion === SQL_LICITACIONES.tablas, "leerLicitacion sin tabla → 01a");
  usar(dbBase());
  const nx2 = await leerLicitacion(999);
  check(!nx2.ok && nx2.noExiste === true, "leerLicitacion de un id que no existe → noExiste");
}

// ══ 3. Contexto: todo leído ═══════════════════════════════════════════════════
sec("3. cargarContexto: lo elegido, derivado; tri-estado; documentos de la empresa del tercero");
{
  const db = usar(dbBase());
  const ctx = await cargarContexto(await licDe(db));
  const L = ctx.lecturas;
  check(Object.values(L).every((e) => e === "ok"), `todas las fuentes ok (${JSON.stringify(L)})`);
  check(ctx.migraciones.anioTercero && ctx.migraciones.conductorTercero && ctx.migraciones.fechaConstitucion, "con las columnas: migraciones en true");
  check(/^\d{4}-\d{2}-\d{2}$/.test(ctx.hoy), "hoy en ISO");
  check(ctx.perfil?.ruc === "20123456789" && ctx.perfil.fecha_constitucion === "2010-05-04", "perfil con fecha de constitución");
  const p1 = ctx.unidades["p:1"], t5 = ctx.unidades["t:5"];
  check(!!p1 && p1.anio === 2019 && p1.capacidad === 50 && p1.empresa === null && p1.docs.length === 1 && p1.docs[0].canonico === "SOAT" && !p1.docs[0].deEmpresa, "propio con su doc (canónico)");
  check(!("p:2" in ctx.unidades) && !("t:6" in ctx.unidades), "solo las elegidas");
  check(!("p:99" in ctx.unidades), "elegida inexistente → ausente del Record");
  check(!!t5 && t5.capacidad === 30 && t5.anio === 2018 && t5.empresa?.razon_social === "TRANSPORTES SUR SAC" && t5.empresa.ruc === "20999999999", "tercero con capacidad, año y empresa");
  const ids5 = t5?.docs.map((d) => d.id).sort();
  check(JSON.stringify(ids5) === JSON.stringify([60, 61]), `docs del tercero: su placa + su empresa sin placa (${ids5})`);
  check(t5?.docs.find((d) => d.id === 61)?.deEmpresa === true && t5?.docs.find((d) => d.id === 60)?.deEmpresa === false, "deEmpresa marcado");
  check(t5?.docs.find((d) => d.id === 60)?.canonico === "Revisión Técnica (CITV)", "canónico por tipoCanonico (texto tecleado)");
  const c3 = ctx.conductores["p:3"], c7 = ctx.conductores["t:7"];
  check(!!c3 && c3.examen_medico_venc === "2027-03-01" && c3.antecedentes_venc === null && "antecedentes_venc" in c3, "propio: vencimientos (null = vacía)");
  check(!!c7 && c7.examen_medico_venc === undefined && !("examen_medico_venc" in c7) && !("antecedentes_venc" in c7) && !("psicosometrico_venc" in c7), "tercero: los tres vencimientos NO existen (undefined)");
  check(c3?.archivos.map((a) => a.id).join() === "72" && c7?.archivos.map((a) => a.id).join() === "73" && c7.empresa?.id === 9, "archivos por conductor_id / conductor_tercero_id");
  check(ctx.legajo.map((f) => f.id).join() === "70", "legajo: solo alcance empresa y categorías del legajo");
  check(Object.keys(ctx.experiencia).sort().join() === "11,12" && ctx.experiencia[12].activo === false && ctx.experiencia[12].sustentos.length === 1 && ctx.experiencia[12].moneda === "USD", "experiencia: las elegidas (también inactivas), con sustentos");
  check(ctx.personal[21]?.cargo === "Jefa de operaciones" && ctx.personal[22]?.nombre === "JORGE" && Object.keys(ctx.personal).length === 2, "personal: contactos + representante");
  check(ctx.otras.length === 2 && !ctx.otras.some((o) => o.id === 1) && ctx.otras.find((o) => o.id === 2)?.cliente_erp === "OTRO CLIENTE", "otras: sin la propia, con cliente del ERP");
  check(ctx.seguros.some((s) => s.tipo === "deshonestidad"), "seguros por cargarSeguros (incluye deshonestidad)");
}

// ══ 4. Una página fallida ═════════════════════════════════════════════════════
sec("4. Fuente que falla en la página 2 → «error» (no «ok» con media lista); las demás «ok»");
{
  const db = usar(dbBase());
  const filas = db.tablas.documentos_vehiculo!.filas;
  for (let i = 0; i < 1500; i++) filas.push({ id: 1000 + i, vehiculo_id: 1, tipo: "Tarjeta de Propiedad", fecha_vencimiento: null });
  const lic = await licDe(db);
  const ok1 = await cargarContexto(lic);
  check(ok1.lecturas.unidades === "ok" && ok1.unidades["p:1"].docs.length === 1501, "sin falla: lee las 1501 filas paginadas");
  db.fallos.push({ tabla: "documentos_vehiculo", desde: 1000, error: { code: "57014", message: "canceling statement due to statement timeout" } });
  const ctx = await cargarContexto(lic);
  check(ctx.lecturas.unidades === "error", "unidades = error");
  check(Object.keys(ctx.unidades).length === 0, "sin unidades a medias");
  const otras = (Object.keys(ctx.lecturas) as FuenteContexto[]).filter((k) => k !== "unidades");
  check(otras.every((k) => ctx.lecturas[k] === "ok"), `las demás ok (${JSON.stringify(ctx.lecturas)})`);
}

// ══ 5. Sin tabla / sin columna ════════════════════════════════════════════════
sec("5. Migraciones sin correr: sin_tabla y columnas accesorias");
{
  const db = usar(dbBase()); const lic = await licDe(db);
  db.tablas.experiencia_empresa = undefined;
  const ctx = await cargarContexto(lic);
  check(ctx.lecturas.experiencia === "sin_tabla" && Object.keys(ctx.experiencia).length === 0, "experiencia_empresa inexistente → sin_tabla");
  const sinElegir = await cargarContexto({ ...lic, doc: { ...lic.doc, experiencia: { ...lic.doc.experiencia, ids: [] } } });
  check(sinElegir.lecturas.experiencia === "sin_tabla", "sin_tabla aunque no haya ninguna elegida (se sondea)");
}
{
  const db = usar(dbBase()); const lic = await licDe(db);
  sinCol(db, "vehiculos_tercero", "anio");
  const ctx = await cargarContexto(lic);
  check(ctx.lecturas.unidades === "ok" && ctx.unidades["t:5"]?.anio === null && ctx.migraciones.anioTercero === false, "tercero sin columna anio → anio null y anioTercero=false");
  const sinT = await cargarContexto({ ...lic, doc: { ...lic.doc, unidades: lic.doc.unidades.filter((u) => u.clave.startsWith("p")) } });
  check(sinT.migraciones.anioTercero === false && sinT.lecturas.unidades === "ok", "se sabe aunque no haya terceros elegidos");
}
{
  const db = usar(dbBase()); const lic = await licDe(db);
  sinCol(db, "documentos_empresa", "conductor_tercero_id");
  const ctx = await cargarContexto(lic);
  check(ctx.migraciones.conductorTercero === false && ctx.lecturas.conductores === "ok" && ctx.lecturas.legajo === "ok", "sin conductor_tercero_id: conductorTercero=false, fuentes ok");
  check(ctx.conductores["t:7"]?.archivos.length === 0 && ctx.conductores["p:3"]?.archivos.length === 1, "tercero sin archivos (no se pueden leer); propio igual");
  check(ctx.legajo.length === 1 && ctx.legajo[0].conductor_tercero_id === null, "legajo leído sin la columna");
}
{
  const db = usar(dbBase()); const lic = await licDe(db);
  sinCol(db, "empresa_perfil", "fecha_constitucion");
  const ctx = await cargarContexto(lic);
  check(ctx.migraciones.fechaConstitucion === false && ctx.perfil?.ruc === "20123456789" && ctx.perfil && !("fecha_constitucion" in ctx.perfil), "sin fecha_constitucion: perfil leído sin ella (undefined)");
}
{
  const db = usar(dbBase()); const lic = await licDe(db);
  sinCol(db, "conductores", "antecedentes_venc");
  const ctx = await cargarContexto(lic);
  check(ctx.conductores["p:3"] && !("antecedentes_venc" in ctx.conductores["p:3"]) && ctx.conductores["p:3"].examen_medico_venc === "2027-03-01", "columna de ficha soltada → ausente, las otras siguen");
}

// ══ 6. Barrido: un error en cualquier tabla de una fuente la deja en «error» ═════════
sec("6. Barrido de fallas por tabla (invariante + corolario)");
{
  const MAPA: Record<string, FuenteContexto[]> = {
    empresa_perfil: ["perfil"], vehiculos: ["unidades"], vehiculos_tercero: ["unidades"], documentos_vehiculo: ["unidades", "seguros"],
    documentos_tercero: ["unidades", "seguros"], empresas_tercerizadas: ["unidades", "conductores", "seguros"], conductores: ["conductores", "seguros"],
    conductores_tercero: ["conductores"], documentos_empresa: ["conductores", "legajo"], experiencia_empresa: ["experiencia"],
    personal_administrativo: ["personal", "seguros"], seguros: ["seguros"], licitaciones: ["otras"], clientes: ["otras"],
  };
  let malos = 0, casos = 0;
  for (const [tabla, fuentes] of Object.entries(MAPA)) {
    const db = usar(dbBase()); const lic = await licDe(db);
    db.fallos.push({ tabla, error: { code: "08006", message: "connection failure" } });
    const ctx = await cargarContexto(lic);
    casos++;
    for (const f of fuentes) if (ctx.lecturas[f] !== "error") { malos++; console.log(`    ${tabla} → ${f} = ${ctx.lecturas[f]}`); }
    for (const f of Object.keys(ctx.lecturas) as FuenteContexto[]) if (!fuentes.includes(f) && ctx.lecturas[f] !== "ok") { malos++; console.log(`    ${tabla} contagió ${f} = ${ctx.lecturas[f]}`); }
  }
  check(malos === 0 && casos === 14, `${casos} tablas: cada falla deja SU fuente en error y no contagia a otras (${malos} incoherencias)`);
  const db = usar(dbBase());
  const c = await cargarContexto(await licDe(db));
  check(Object.values(c.lecturas).every((e) => e === "ok") && Object.keys(c.unidades).length === 2, "corolario: sin fallas todo ok y con datos");
}

// ══ 7. Para elegir ════════════════════════════════════════════════════════════
sec("7. buscarUnidades / buscarConductores");
{
  const db = usar(dbBase());
  const u = await buscarUnidades();
  check(u.ok && u.opciones.length === 5 && u.anioTercero === true, "las dos flotas completas");
  if (u.ok) {
    const pos = (k: string) => u.opciones.findIndex((o) => o.clave === k);
    check(pos("p:2") > pos("t:5") && pos("t:8") > pos("t:5") && !u.opciones.find((o) => o.clave === "t:8")!.activo, "activos primero; tercero de empresa inactiva = inactivo");
    check(u.opciones.find((o) => o.clave === "t:5")?.empresa === "TRANSPORTES SUR SAC", "con su empresa");
  }
  db.fallos.push({ tabla: "vehiculos_tercero", error: { message: "timeout" } });
  const u2 = await buscarUnidades();
  check(u2.ok && u2.lecturas.t === "error" && u2.opciones.every((o) => o.flota === "p") && u2.avisos.length === 1, "una flota caída: la otra sale y lo dice");
  db.fallos.push({ tabla: "vehiculos", error: { message: "timeout" } });
  const u3 = await buscarUnidades();
  check(!u3.ok, "las dos caídas → ok:false");
  usar(dbBase());
  const c = await buscarConductores();
  check(c.ok && c.opciones.length === 2 && c.opciones.some((o) => o.clave === "t:7" && o.empresa === "TRANSPORTES SUR SAC"), "conductores de las dos flotas");
}

// ══ 8. subirArchivo ═══════════════════════════════════════════════════════════
sec("8. subirArchivo: rutaNueva, upsert:false, mime del CONTENIDO, páginas con pdf-lib");
{
  const db = usar(dbBase());
  const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage();
  const bytes = await pdf.save();
  const f = new File([bytes], "Bases del concurso.pdf", { type: "application/pdf" });
  const a = await subirArchivo("bases", 12, f);
  const s = db.subidas[0];
  const ruta = s?.ruta ?? "";
  const id = ruta.match(/^bases\/12\/([0-9a-f-]{36})\.pdf$/)?.[1];
  check(!!id && ruta === rutaNueva("bases", 12, id, "pdf") && s.bucket === "licitaciones", `ruta = rutaNueva(bases, 12, uuid, pdf) (${ruta})`);
  check(s?.opts.upsert === false && s.opts.contentType === "application/pdf", "upsert:false y contentType del mime permitido");
  check(a.url === `${BASE}/storage/v1/object/public/licitaciones/${ruta}` && a.id === id, "url = getPublicUrl (identificador) e id = el uuid de la ruta");
  check(a.sha256 === hex(bytes) && a.paginas === 2 && a.bytes === bytes.length && a.nombre === "Bases del concurso.pdf" && a.mime === "application/pdf", "sha256, páginas (2), bytes y nombre");
  // JPEG con extensión .png → se sube como lo que es
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
  const b = await subirArchivo("imagenes", 12, new File([jpg], "foto.png", { type: "image/png" }));
  check(b.mime === "image/jpeg" && /\.jpg$/.test(db.subidas[1].ruta) && db.subidas[1].opts.contentType === "image/jpeg", "JPG llamado .png → se sube como JPG");
  const falla = async (fn: () => Promise<unknown>, re: RegExp) => { try { await fn(); return false; } catch (e) { return e instanceof ErrorLicitaciones && re.test(e.message); } };
  const antes = db.subidas.length;
  check(await falla(() => subirArchivo("bases", 12, new File([new Uint8Array([1, 2, 3, 4, 5])], "x.pdf", { type: "application/pdf" })), /dice ser PDF/), "un .pdf que no es PDF → no se sube");
  check(await falla(() => subirArchivo("imagenes", 12, new File([bytes], "x.pdf", { type: "application/pdf" })), /no es de un tipo/), "imágenes: no acepta PDF");
  check(await falla(() => subirArchivo("bases", 12, new File([new Uint8Array([1])], "x.exe", { type: "application/x-msdownload" })), /no es de un tipo/), "tipo no permitido");
  check(await falla(() => subirArchivo("adjuntos", 12, new File([jpg], "IMG_1.HEIC", { type: "image/heic" })), /HEIC/), "HEIC se nombra");
  const gigante = { name: "g.pdf", type: "application/pdf", size: 60 * 1024 * 1024, slice: () => new Blob([bytes]), arrayBuffer: async () => bytes.buffer } as unknown as File;
  check(await falla(() => subirArchivo("bases", 12, gigante), /tope es 50 MB/), "más de 50 MB → no se sube");
  check(await falla(() => subirArchivo("bases", null, f), /Guarda la licitación/), "bases sin licitación → error (rutaNueva)");
  check(db.subidas.length === antes, "ninguna de las rechazadas llegó al almacenamiento");
  const e = await subirArchivo("experiencia", null, new File([bytes], "oc.pdf", { type: "" }));
  check(/^experiencia\/[0-9a-f-]{36}\.pdf$/.test(db.subidas[db.subidas.length - 1].ruta) && e.mime === "application/pdf", "experiencia sin licitación; mime por la extensión si el navegador no lo da");
  db.buckets = { documentos: new Map() };
  let sinBucket: unknown = null;
  try { await subirArchivo("bases", 12, f); } catch (x) { sinBucket = x; }
  check(sinBucket instanceof ErrorLicitaciones && sinBucket.sinMigracion === SQL_LICITACIONES.bucket, "sin el bucket → nombra licitaciones-03");
  check(firmaDeBytes(new Uint8Array([0x50, 0x4b, 3, 4])) === "zip" && firmaDeBytes(new TextEncoder().encode("basura %PDF-1.7")) === "pdf", "firmas: zip y %PDF tras basura");
}

// ══ 9. Legajo y documentos del conductor ═══════════════════════════════════════
sec("9. Legajo (documentos_empresa) y documentos del conductor");
{
  const db = usar(dbBase());
  const pdf = new File([new TextEncoder().encode("%PDF-1.4 x")], "ficha.pdf", { type: "application/pdf" });
  const mal = await subirDocumentoLegajo("vigencia_poder", pdf, { fecha_emision: "2026-10-10", fecha_vencimiento: "2026-10-01" });
  check(!mal.ok && /anterior/.test(mal.error) && db.subidas.length === 0, "vencimiento antes de la emisión → error sin subir");
  const r = await subirDocumentoLegajo("ficha_ruc", pdf, { fecha_emision: "2026-10-20", fecha_vencimiento: "2020-01-01" });
  check(!r.ok, "vencimiento anterior a emisión (2020 < 2026) también");
  const r2 = await subirDocumentoLegajo("ficha_ruc", pdf, { fecha_emision: "2020-01-01", fecha_vencimiento: "2021-01-01" });
  const ins = db.llamadas.filter((l) => l.tabla === "documentos_empresa" && l.op === "insert").pop();
  const fila = ins?.filas?.[0] ?? {};
  check(r2.ok && fila.alcance === "empresa" && fila.categoria === "ficha_ruc" && fila.privado === true && fila.estado === "vencido" && fila.titulo === "Ficha RUC", "fila nueva: alcance empresa, categoría, privado, estado y título por defecto");
  check(/^legajo\/ficha_ruc\/[0-9a-f-]{36}\.pdf$/.test(db.subidas[0].ruta) && db.subidas[0].bucket === "documentos" && db.subidas[0].opts.upsert === false, "al bucket documentos en legajo/<codigo>/<uuid>.pdf");
  const leg = await leerLegajo();
  check(leg.ok && leg.filas.length === 2 && leg.conductorTercero, "leerLegajo: las del legajo (no el contrato)");
  if (r2.ok) {
    const u = await actualizarFechasLegajo(r2.fila.id, { fecha_vencimiento: "2099-01-01" });
    check(u.ok && u.fila.fecha_vencimiento === "2099-01-01" && db.tablas.documentos_empresa!.filas.find((f) => f.id === r2.fila.id)?.estado === "vigente", "actualizar fechas recalcula el estado");
    const b = await borrarDocumentoLegajo(r2.fila.id);
    check(b.ok && !db.tablas.documentos_empresa!.filas.some((f) => f.id === r2.fila.id), "borrar la fila (como /documentos)");
  }
  const b2 = await borrarDocumentoLegajo(71);
  check(!b2.ok && b2.noExiste === true && db.tablas.documentos_empresa!.filas.some((f) => f.id === 71), "no borra un documento que no es del legajo");
  db.fallos.push({ tabla: "documentos_empresa", op: "insert", error: { code: "23514", message: 'new row for relation "documentos_empresa" violates check constraint "documentos_empresa_categoria_check"' } });
  const r3 = await subirDocumentoLegajo("iperc", pdf, { fecha_emision: null, fecha_vencimiento: null });
  check(!r3.ok && /categoría «iperc»/.test(r3.error) && /diagnostico-licitaciones/.test(r3.error) && db.removidos.length === 1, "CHECK de categoría: lo dice y retira el archivo subido");
}
{
  const db = usar(dbBase());
  sinCol(db, "documentos_empresa", "conductor_tercero_id");
  const pdf = new File([new TextEncoder().encode("%PDF-1.4 x")], "lic.pdf", { type: "application/pdf" });
  const r = await subirDocumentoConductor("t:7", "licencia_conducir", pdf, { fecha_emision: null, fecha_vencimiento: "2027-01-01" });
  check(!r.ok && r.sinMigracion === SQL_LICITACIONES.accesorias && db.subidas.length === 0, "tercero sin la columna → nombra licitaciones-04 sin subir nada");
  const l = await leerDocsConductor("t:7");
  check(!l.ok && l.sinMigracion === SQL_LICITACIONES.accesorias, "leer docs del tercero sin la columna → 04");
  const p = await subirDocumentoConductor("p:3", "examen_medico", pdf, { fecha_emision: "2026-01-01", fecha_vencimiento: "2027-01-01" });
  check(p.ok && p.fila.conductor_id === 3 && p.fila.alcance === "conductor", "propio sí, sin la columna");
  const db2 = usar(dbBase());
  const t = await subirDocumentoConductor("t:7", "psicosometrico", pdf, { fecha_emision: null, fecha_vencimiento: null });
  check(t.ok && t.fila.conductor_tercero_id === 7 && t.fila.conductor_id === null && /^conductores\/t-7\/psicosometrico\//.test(db2.subidas[0].ruta), "tercero con la columna: conductor_tercero_id");
}

// ══ 10. subirDocUnidad ════════════════════════════════════════════════════════
sec("10. subirDocUnidad: la fila AUTORITATIVA, conservando lo que no se manda y el enlace anterior");
{
  const db = usar(dbBase());
  const pdf = new File([new TextEncoder().encode("%PDF-1.4 soat")], "soat.pdf", { type: "application/pdf" });
  const r = await subirDocUnidad({ clave: "p:1", empresaId: null }, "SOAT", pdf, { docId: 50, numero: null, fecha_emision: null, fecha_vencimiento: "2027-06-01", entidad_emisora: null });
  const f = db.tablas.documentos_vehiculo!.filas.find((x) => x.id === 50)!;
  check(r.ok && f.archivo_url === (r.ok ? r.url : "") && /\/documentos\/vehiculos\/p-1\/[0-9a-f-]{36}\.pdf$/.test(String(f.archivo_url)), "propio: actualiza la fila 50 con el archivo nuevo (vehiculos/p-1/…)");
  check(f.numero === "N1" && f.entidad_emisora === "Rimac" && f.fecha_emision === "2026-01-01" && f.fecha_vencimiento === "2027-06-01" && f.tipo === "SOAT", "conserva lo que no se manda; cambia el vencimiento");
  check(String(f.observaciones) === "Original\nEnlace anterior: https://drive.google.com/file/d/abc/view", `el enlace de Drive queda en observaciones (${f.observaciones})`);
  check(db.subidas[0].opts.contentType === "application/pdf" && db.subidas[0].opts.upsert === false && db.subidas[0].bucket === "documentos", "bucket documentos, upsert:false, mime permitido");
  // re-subir no duplica el «enlace anterior» del mismo archivo
  check(observacionesConEnlaceAnterior("Original\nEnlace anterior: https://drive.google.com/file/d/abc/view", "https://drive.google.com/file/d/abc/view", "z") === "Original\nEnlace anterior: https://drive.google.com/file/d/abc/view", "el enlace anterior no se repite");
  const t = await subirDocUnidad({ clave: "t:5", empresaId: 999 }, "Revisión Técnica (CITV)", pdf, { docId: null, numero: "C-5", fecha_emision: "2026-01-02", fecha_vencimiento: "2027-01-02", entidad_emisora: "Lima Norte" });
  const ins = db.tablas.documentos_tercero!.filas.find((x) => x.numero === "C-5");
  check(t.ok && !!ins && ins.empresa_id === 9 && ins.vehiculo_id === 5 && ins.tipo === "Revisión Técnica (CITV)" && ins.fecha_emision === "2026-01-02", "tercero: inserta con la empresa DE LA UNIDAD (no la del llamador)");
  check(t.ok && t.docId === ins?.id && /\/vehiculos\/t-5\//.test(String(ins?.archivo_url)), "devuelve el id nuevo");
  const antes = db.subidas.length;
  const s = await subirDocUnidad({ clave: "p:1", empresaId: null }, "SOAT", pdf, { docId: null, numero: "N", fecha_emision: null, fecha_vencimiento: null, entidad_emisora: null });
  check(!s.ok && /vencimiento/.test(s.error) && db.subidas.length === antes, "SOAT sin vencimiento → error, sin subir");
  const c = await subirDocUnidad({ clave: "t:5", empresaId: 9 }, "Revisión Técnica (CITV)", pdf, { docId: null, numero: null, fecha_emision: null, fecha_vencimiento: "", entidad_emisora: null });
  check(!c.ok && /CITV/.test(c.error), "CITV sin vencimiento → error");
  const tp = await subirDocUnidad({ clave: "p:1", empresaId: null }, "Tarjeta de Propiedad", pdf, { docId: null, numero: "TP", fecha_emision: "2019-01-01", fecha_vencimiento: "2030-01-01", entidad_emisora: null });
  const tpf = db.tablas.documentos_vehiculo!.filas.find((x) => x.numero === "TP");
  check(tp.ok && tpf?.fecha_vencimiento === null, "Tarjeta de Propiedad no vence: se guarda null");
  const otra = await subirDocUnidad({ clave: "p:1", empresaId: null }, "SOAT", pdf, { docId: 51, numero: null, fecha_emision: null, fecha_vencimiento: "2027-01-01", entidad_emisora: null });
  check(!otra.ok && /otra unidad/.test(otra.error), "una fila de otra unidad no se toca");
  const tipo = await subirDocUnidad({ clave: "p:1", empresaId: null }, "Revisión Técnica (CITV)", pdf, { docId: 50, numero: null, fecha_emision: null, fecha_vencimiento: "2027-01-01", entidad_emisora: null });
  check(!tipo.ok && /otro tipo/.test(tipo.error), "una fila de otro tipo no se reemplaza");
  const inv = await subirDocUnidad({ clave: "p:1", empresaId: null }, "Seguro inventado", pdf, { docId: null, numero: null, fecha_emision: null, fecha_vencimiento: null, entidad_emisora: null });
  check(!inv.ok, "tipo que no es canónico → error");
  // tercero sin fecha_emision en la tabla: se suelta solo esa
  const db2 = usar(dbBase()); sinCol(db2, "documentos_tercero", "fecha_emision");
  const t2 = await subirDocUnidad({ clave: "t:5", empresaId: 9 }, "SOAT", pdf, { docId: 60, numero: null, fecha_emision: "2026-01-01", fecha_vencimiento: "2027-03-03", entidad_emisora: null });
  const f60 = db2.tablas.documentos_tercero!.filas.find((x) => x.id === 60);
  check(!t2.ok && /otro tipo/.test(t2.error), "doc 60 es CITV: no se reemplaza por SOAT");
  const t3 = await subirDocUnidad({ clave: "t:5", empresaId: 9 }, "Revisión Técnica (CITV)", pdf, { docId: 60, numero: null, fecha_emision: "2026-01-01", fecha_vencimiento: "2027-03-03", entidad_emisora: null });
  check(t3.ok && f60?.fecha_vencimiento === "2027-03-03" && f60?.numero === "R5" && !("fecha_emision" in (f60 ?? {})), "sin columna fecha_emision: se suelta y se actualiza conservando el número");
}

// ══ 11. Experiencia ═══════════════════════════════════════════════════════════
sec("11. Experiencia: validar, guardar, desactivar (no borrar), sugerencia de reservas");
{
  const db = usar(dbBase());
  const base = { cliente_id: null, cliente_nombre: "NUEVO CLIENTE", cliente_ruc: null, contacto_nombre: null, contacto_cargo: null, contacto_telefono: null, contacto_email: null,
    objeto: "", sector: null, zona: null, inicio: "2024-01-01", fin: null, vigente: true, sustento_tipo: "oc" as const, sustento_ref: null, sustento_fecha: null,
    importe: 1234.567, moneda: "PEN" as const, importe_incluye_igv: null, sustentos: [], notas: null };
  const malRuc = await guardarExperiencia({ ...base, cliente_ruc: "123" });
  const malFin = await guardarExperiencia({ ...base, fin: "2023-01-01" });
  const malImp = await guardarExperiencia({ ...base, importe: -1 });
  const malIni = await guardarExperiencia({ ...base, inicio: "" });
  check(!malRuc.ok && !malFin.ok && !malImp.ok && !malIni.ok && !db.llamadas.some((l) => l.tabla === "experiencia_empresa" && l.op !== "select"), "RUC, fin < inicio, importe negativo, sin inicio: error sin escribir");
  const g = await guardarExperiencia({ ...base, cliente_ruc: "20 123 456 789".replace(/ /g, "").slice(0, 11) });
  check(g.ok && g.fila.importe === 1234.57 && g.fila.objeto === "Transporte de personal" && g.fila.cliente_ruc === "20123456789" && g.fila.activo, "guardar: importe al céntimo, objeto por defecto");
  if (g.ok) {
    const d = await desactivarExperiencia(g.fila.id);
    check(d.ok && d.fila.activo === false && db.tablas.experiencia_empresa!.filas.some((f) => f.id === g.fila.id), "desactivar: activo=false, la fila sigue");
  }
  const l = await leerExperiencia();
  check(l.ok && l.filas.every((f) => f.activo) && l.filas[0].inicio >= l.filas[l.filas.length - 1].inicio, "por defecto solo activas, más reciente primero");
  const l2 = await leerExperiencia({ incluirInactivas: true });
  check(l2.ok && l2.filas.some((f) => !f.activo), "con inactivas");
  const s = await sugerenciaReservas(40);
  check(s.ok && s.sugerencia?.servicios === 3 && s.sugerencia.dias === 2 && s.sugerencia.importe === 800.5 && s.sugerencia.sinPrecio === 1 && s.sugerencia.desde === "2026-05-02" && s.sugerencia.hasta === "2026-07-01", "sugerencia: sin cancelados, con estado null, solo ese cliente");
  const s0 = await sugerenciaReservas(77);
  check(s0.ok && s0.sugerencia === null, "cliente sin servicios → null");
  check(!db.llamadas.some((x) => x.tabla === "experiencia_empresa" && x.op === "update" && x.patch && "importe" in x.patch && x.patch.importe === 800.5), "la sugerencia nunca se escribe");
  db.tablas.experiencia_empresa = undefined;
  const sx = await leerExperiencia();
  check(!sx.ok && sx.sinMigracion === SQL_LICITACIONES.experiencia, "sin la tabla → nombra licitaciones-02");
  const gx = await guardarExperiencia(base);
  check(!gx.ok && gx.sinMigracion === SQL_LICITACIONES.experiencia, "guardar sin la tabla → 02");
}

// ══ 12. Año del tercero y emisiones ═══════════════════════════════════════════
sec("12. guardarAnioTercero · leerEmisiones · ultimaEmision");
{
  const db = usar(dbBase());
  const a = await guardarAnioTercero(5, 2017);
  check(a.ok && a.anio === 2017 && db.tablas.vehiculos_tercero!.filas.find((f) => f.id === 5)?.anio === 2017, "año guardado en la fila autoritativa");
  const m = await guardarAnioTercero(5, 1949);
  check(!m.ok && /1950/.test(m.error), "fuera de rango → error");
  sinCol(db, "vehiculos_tercero", "anio");
  const s = await guardarAnioTercero(5, 2017);
  check(!s.ok && s.sinMigracion === SQL_LICITACIONES.accesorias && /licitaciones-04/.test(s.error), "sin la columna → nombra licitaciones-04");
  const e = await leerEmisiones(1);
  const sel = db.llamadas.filter((x) => x.tabla === "licitacion_emisiones").pop();
  check(e.ok && e.filas.length === 2 && e.filas[0].version === 2 && !sel?.cols.includes("foto") && e.filas[1].emitido_por_nombre === "Ana Pérez", "leerEmisiones: más reciente primero, sin la foto, con nombre");
  const u = await ultimaEmision(1);
  check(u.ok && u.emision?.version === 2 && (u.emision.foto as unknown as { hoy: string }).hoy === "2026-10-15", "ultimaEmision: la de mayor versión, con foto");
  const u0 = await ultimaEmision(2);
  check(u0.ok && u0.emision === null, "sin emisiones → null");
}

// ══ 13. Retoques en módulos ajenos ═════════════════════════════════════════════
sec("13. ELIA usa la lista única de categorías; TIPOS_SEGURO tiene deshonestidad");
{
  const src = readFileSync(new URL("../lib/elia/herramientas.ts", import.meta.url), "utf8");
  check(/enum: \[\.\.\.CATEGORIAS_DOCUMENTO\]/.test(src) && !src.includes(`enum: ["contrato", "guia_remision"`), "ELIA: enum = CATEGORIAS_DOCUMENTO (sin copia)");
  check(CATEGORIAS_DOCUMENTO.includes("ficha_ruc") && CATEGORIAS_DOCUMENTO.includes("examen_medico"), "la lista única trae legajo y conductor");
  check(TIPOS_SEGURO.deshonestidad?.categoria === "complementario" && TIPOS_SEGURO.deshonestidad.entidadLabel === "empresa", "deshonestidad: complementario, de la empresa");
  const exigidos: TipoSeguroLic[] = ["responsabilidad_civil", "deshonestidad", "todo_riesgo", "sctr_salud", "sctr_pension", "vida_ley"];
  check(exigidos.every((k) => !!TIPOS_SEGURO[k]), "cada TipoSeguroLic existe en TIPOS_SEGURO");
}

fijarClienteDatos(null);
console.log(`\n${fallos ? "✗" : "✓"} ${ok} ok · ${fallos} fallos`);
if (fallos) process.exit(1);
