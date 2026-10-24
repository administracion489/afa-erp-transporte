/* eslint-disable @typescript-eslint/no-explicit-any -- la base falsa y las aserciones sobre JSON leen campos sueltos */
// scripts/prueba-licitaciones-analisis.mts — Matriz de la lectura de bases con IA (lib/licitaciones/analisis*.ts).
//   npx tsx scripts/prueba-licitaciones-analisis.mts
//
// SIN RED Y SIN CLAVE: la base, Storage y la API de Anthropic son FALSOS (inyectados en `deps`). Lo que fija:
//  1. El cuerpo no decide qué se baja: un id que no está en doc.bases, una base de OTRA licitación, de otro
//     bucket o de otro proyecto → archivo_ajeno, y `descargar` NUNCA se llama (espía). Claves extra del
//     cuerpo (url, ruta…) se ignoran.
//  2. Topes: páginas, bytes declarados y reales; el tope crudo cabe en el de la petición.
//  3. PDF cifrado (fixture con /Encrypt): se omite y se nombra; todos cifrados → pdf_protegido.
//  4. Candado: un «en curso» reciente → en_curso; uno colgado se cierra y se toma otro; dos a la vez → uno.
//  5. Estimar no llama al modelo NI crea fila. Tope diario: cuenta solo lo que llamó al modelo hoy (Lima).
//  6. max_tokens → respuesta_cortada; refusal → rechazo; 429/401/abort; JSON ilegible. La fila se cierra
//     SIEMPRE, con tokens y costo cuando se llamó al modelo.
//  7. Normalización: regla desconocida o con parámetros inválidos, 2026-02-30, categoría rara, cita a un
//     archivo no enviado, recortes, claves únicas, idempotencia — y el corolario: cada regla del catálogo
//     SÍ se lee (un lector que devolviera siempre null pasaría lo demás).
//  8. Barrido del prompt y del esquema: ningún número de 4+ cifras ni nombre de empresa; additionalProperties
//     false en todo objeto, cero uniones, ≤ 24 opcionales, nada que structured outputs no compile.

import Anthropic from "@anthropic-ai/sdk";
import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import {
  MODELO_ANALISIS, TOPES_ANALISIS, PRECIO_ANALISIS, PROMPT_ANALISIS, ESQUEMA_ANALISIS, PARAMETROS_REGLA,
  TIPOS_SEGURO_LIC, DOCS_CONDUCTOR_REGLA, costoUsd, leerAnalisisBases, leerRegla, requisitoDePropuesto,
  bloquesDeEstructura, validarEntradaAnalisis, parametrosAnalisis, contenidoAnalisis, fechaValida, horaValida,
} from "../lib/licitaciones/analisis";
import { analizarBases, type DepsAnalisis, type MensajeFinal, type SupabaseServiceRole } from "../lib/licitaciones/analisis-datos";
import { CODIGOS_LEGAJO, DOCS_UNIDAD_LIC, TIPOS_REGLA, CATEGORIAS_REQUISITO, type EntradaAnalisis, type RespuestaAnalisis } from "../lib/licitaciones/tipos";
import { CATEGORIAS_CLASE_A } from "../lib/licencias-conducir";

let ok = 0, fallos = 0;
const check = (c: unknown, m: string) => { if (c) ok++; else { fallos++; console.log("  ✗", m); } };
const sec = (t: string) => console.log(`\n── ${t}`);

const BASE = "https://proyecto-prueba.supabase.co";
const LIC = 12;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const urlDe = (ruta: string, base = BASE, bucket = "licitaciones") => `${base}/storage/v1/object/public/${bucket}/${ruta}`;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ── Fixtures PDF ─────────────────────────────────────────────────────────────────
async function pdf(paginas: number): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (let i = 0; i < paginas; i++) d.addPage([200, 200]);
  return d.save();
}
async function pdfCifrado(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage([200, 200]);
  d.context.trailerInfo.Encrypt = d.context.obj({ Filter: "Standard", V: 1, R: 2 });
  return d.save({ useObjectStreams: false });
}
const PDF2 = await pdf(2);
const PDF3 = await pdf(3);
const PDF601 = await pdf(601);
const CIFRADO = await pdfCifrado();
const NO_PDF = new TextEncoder().encode("PK\u0003\u0004 esto es un zip, no un PDF");

// ── Base falsa ───────────────────────────────────────────────────────────────────
type Fila = Record<string, any>;
type Reloj = { t: number };
class FakeDb {
  licitaciones = new Map<number, { id: number; doc: any }>();
  analisis: Fila[] = [];
  faltaTabla: string | null = null;
  ops: string[] = [];
  nextId = 100;
  constructor(public reloj: Reloj) {}
  from(t: string) { return new Q(this, t); }
}
class Q implements PromiseLike<any> {
  op: "select" | "update" | "insert" = "select";
  cols = ""; opts: any; patch: any; row: any; modo: "many" | "maybeSingle" | "single" = "many";
  filtros: ((f: Fila) => boolean)[] = [];
  constructor(private db: FakeDb, private t: string) {}
  select(cols: string, opts?: any) { if (this.op === "select") { this.cols = cols; this.opts = opts; } return this; }
  eq(c: string, v: unknown) { this.filtros.push((f) => f[c] === v); return this; }
  lt(c: string, v: any) { this.filtros.push((f) => f[c] < v); return this; }
  gte(c: string, v: any) { this.filtros.push((f) => f[c] >= v); return this; }
  or(expr: string) {
    if (expr !== "estado.eq.en_curso,tokens_entrada.not.is.null") throw new Error(`or no previsto: ${expr}`);
    this.filtros.push((f) => f.estado === "en_curso" || f.tokens_entrada != null);
    return this;
  }
  update(p: any) { this.op = "update"; this.patch = p; return this; }
  insert(r: any) { this.op = "insert"; this.row = r; return this; }
  maybeSingle() { this.modo = "maybeSingle"; return this; }
  single() { this.modo = "single"; return this; }
  then<A, B>(res?: ((v: any) => A | PromiseLike<A>) | null, rej?: ((e: any) => B | PromiseLike<B>) | null) {
    return Promise.resolve(this.ejecutar()).then(res, rej);
  }
  private ejecutar(): any {
    const db = this.db;
    db.ops.push(`${this.op}:${this.t}`);
    if (db.faltaTabla === this.t) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${this.t}' in the schema cache` } };
    if (this.t === "licitaciones") {
      const filas = [...db.licitaciones.values()].filter((f) => this.filtros.every((p) => p(f)));
      const f = filas[0];
      return { data: f ? { id: f.id, bases: f.doc?.bases ?? null } : null, error: null };
    }
    if (this.t !== "licitacion_analisis") throw new Error(`tabla no prevista: ${this.t}`);
    if (this.op === "insert") {
      const r = this.row;
      if (r.estado === "en_curso" && db.analisis.some((f) => f.licitacion_id === r.licitacion_id && f.estado === "en_curso")) {
        return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"uq_licitacion_analisis_en_curso\"" } };
      }
      const fila = { id: db.nextId++, creado_en: new Date(db.reloj.t).toISOString(), tokens_entrada: null, tokens_salida: null, costo_usd: null, resultado: null, avisos: [], error: null, terminado_en: null, ...structuredClone(r) };
      db.analisis.push(fila);
      return { data: { id: fila.id }, error: null };
    }
    const sel = db.analisis.filter((f) => this.filtros.every((p) => p(f)));
    if (this.op === "update") { for (const f of sel) Object.assign(f, structuredClone(this.patch)); return { data: null, error: null }; }
    if (this.opts?.head) return { data: null, count: sel.length, error: null };
    return { data: sel, error: null };
  }
}

// ── El mundo de una prueba ─────────────────────────────────────────────────────────
type Mundo = {
  db: FakeDb; reloj: Reloj; storage: Map<string, Uint8Array>;
  bajadas: string[]; conteos: number; creados: Anthropic.MessageCreateParamsNonStreaming[];
  deps: DepsAnalisis;
};
const MOMENTO = Date.parse("2026-10-24T15:00:00Z"); // 10:00 en Lima

function respuestaOk(json: unknown, uso = { input_tokens: 5000, output_tokens: 1200 }): MensajeFinal {
  return { stop_reason: "end_turn", content: [{ type: "thinking" }, { type: "text", text: JSON.stringify(json) }], usage: uso, stop_details: null };
}
const JSON_BASICO = {
  concurso: { cliente_nombre: "Cliente de prueba", codigo: "LP-01", objeto: "Transporte de personal", atencion: "", fecha_consultas: "", fecha_presentacion: "2026-11-20", hora_presentacion: "10:00", fecha_inicio_servicio: "", plazo_meses: 12 },
  requisitos: [
    { numeral: "5.1", texto: "Copia literal con antigüedad no mayor a 30 días", categoria: "legal", obligatorio: true, regla: { tipo: "doc_empresa", legajo: "copia_literal", antiguedadMaxDias: 30 }, cita: { archivoId: "A1", pagina: 2, texto: "copia literal" } },
  ],
  consultas: [], estructura: [], penalidades: [], criterios: [], advertencias: [],
};

function mundo(opts: { bases?: any[]; crear?: DepsAnalisis["crear"]; tokens?: number; plazoModeloMs?: number } = {}): Mundo {
  const reloj = { t: MOMENTO };
  const db = new FakeDb(reloj);
  const storage = new Map<string, Uint8Array>();
  const m: Mundo = {
    db, reloj, storage, bajadas: [], conteos: 0, creados: [],
    deps: null as unknown as DepsAnalisis,
  };
  db.licitaciones.set(LIC, { id: LIC, doc: { bases: opts.bases ?? [] } });
  m.deps = {
    db: db as unknown as SupabaseServiceRole,
    base: BASE,
    ahora: () => reloj.t,
    plazoModeloMs: opts.plazoModeloMs,
    descargar: async (bucket, ruta) => {
      m.bajadas.push(`${bucket}/${ruta}`);
      const b = bucket === "licitaciones" ? storage.get(ruta) : undefined;
      if (!b) throw new Error("no existe");
      return b;
    },
    contarTokens: async () => { m.conteos++; return opts.tokens ?? 5000; },
    crear: async (p, s) => { m.creados.push(p); return opts.crear ? opts.crear(p, s) : respuestaOk(JSON_BASICO); },
  };
  return m;
}
function base(n: number, bytes: Uint8Array | null, extra: Partial<{ url: string; nombre: string; tipo: string; bytes: number }> = {}) {
  const ruta = `bases/${LIC}/${uuid(n)}.pdf`;
  return { id: `b${n}`, url: extra.url ?? urlDe(ruta), nombre: extra.nombre ?? `bases-${n}.pdf`, mime: "application/pdf", bytes: extra.bytes ?? bytes?.length ?? 0, sha256: null, paginas: null, subidoEn: "2026-10-01T00:00:00Z", tipo: extra.tipo ?? "bases", _ruta: ruta, _bytes: bytes };
}
function poblar(m: Mundo, bs: ReturnType<typeof base>[]) {
  m.db.licitaciones.set(LIC, { id: LIC, doc: { bases: bs.map((b) => { const c: Record<string, unknown> = { ...b }; delete c._ruta; delete c._bytes; return c; }) } });
  for (const b of bs) if (b._bytes) m.storage.set(b._ruta, b._bytes);
}
const entrada = (ids: string[], x: Partial<EntradaAnalisis> = {}): EntradaAnalisis => ({ licitacion_id: LIC, archivo_ids: ids, texto: null, estimar: false, ...x });
const codigo = (r: RespuestaAnalisis) => (r.ok ? r.modo : r.codigo);
const AUTH = { userId: "11111111-1111-4111-8111-111111111111" };

// ══ 1 · El cuerpo no decide qué se baja ════════════════════════════════════════════
sec("1. Validación del cuerpo y archivos ajenos");
{
  check(validarEntradaAnalisis(null).ok === false, "sin cuerpo → inválido");
  check((validarEntradaAnalisis({ licitacion_id: "12", archivo_ids: [] }) as any).codigo === "entrada_invalida", "licitacion_id en texto → inválido");
  check((validarEntradaAnalisis({ licitacion_id: 12 }) as any).codigo === "sin_archivos", "sin archivos ni texto → sin_archivos");
  check((validarEntradaAnalisis({ licitacion_id: 12, archivo_ids: ["https://x.com/a.pdf"] }) as any).codigo === "entrada_invalida", "una URL como id → inválido");
  check((validarEntradaAnalisis({ licitacion_id: 12, archivo_ids: ["a", "b", "c", "d", "e", "f"] }) as any).codigo === "entrada_invalida", "6 archivos → inválido");
  const dup = validarEntradaAnalisis({ licitacion_id: 12, archivo_ids: ["a", "a", "b"] });
  check(dup.ok && dup.entrada.archivo_ids.join() === "a,b", "ids repetidos se juntan");
  check((validarEntradaAnalisis({ licitacion_id: 12, texto: "x".repeat(TOPES_ANALISIS.maxTexto + 1) }) as any).codigo === "entrada_invalida", "texto de más → inválido");
  const conUrl = validarEntradaAnalisis({ licitacion_id: 12, archivo_ids: ["a"], url: "https://evil/x.pdf", ruta: "bases/99/x.pdf" });
  check(conUrl.ok && Object.keys(conUrl.entrada).sort().join() === "archivo_ids,estimar,licitacion_id,texto", "claves extra del cuerpo se ignoran");

  // Un id que no está en doc.bases.
  let m = mundo(); poblar(m, [base(1, PDF2)]);
  let r = await analizarBases(entrada(["b9"]), AUTH, m.deps);
  check(codigo(r) === "archivo_ajeno", "id fuera de doc.bases → archivo_ajeno");
  check(m.bajadas.length === 0 && m.db.analisis.length === 0, "…sin bajar nada ni crear fila");

  // Una base de OTRA licitación (la ruta dice bases/99/…).
  m = mundo(); poblar(m, [base(1, PDF2, { url: urlDe(`bases/99/${uuid(1)}.pdf`) })]);
  r = await analizarBases(entrada(["b1"]), AUTH, m.deps);
  check(codigo(r) === "archivo_ajeno" && m.bajadas.length === 0, "base de otra licitación → archivo_ajeno, sin bajar");

  // Otro bucket (documentos, también privado) y otro proyecto.
  m = mundo(); poblar(m, [base(1, PDF2, { url: urlDe(`bases/${LIC}/${uuid(1)}.pdf`, BASE, "documentos") })]);
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "archivo_ajeno" && m.bajadas.length === 0, "otro bucket → archivo_ajeno");
  m = mundo(); poblar(m, [base(1, PDF2, { url: urlDe(`bases/${LIC}/${uuid(1)}.pdf`, "https://otro.supabase.co") })]);
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "archivo_ajeno" && m.bajadas.length === 0, "otro proyecto → archivo_ajeno");
  m = mundo(); poblar(m, [base(1, PDF2, { url: "https://drive.google.com/file/d/abc/view" })]);
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "archivo_ajeno" && m.bajadas.length === 0, "enlace de Drive → archivo_ajeno");
  // Ruta con «..» que intenta salir de la carpeta.
  m = mundo(); poblar(m, [base(1, PDF2, { url: urlDe(`bases/${LIC}/../99/${uuid(1)}.pdf`) })]);
  check(["archivo_ajeno", "no_es_pdf"].includes(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps))) && m.bajadas.length === 0, "ruta con .. → no se baja");
  // Un docx en la carpeta de bases.
  m = mundo(); poblar(m, [base(1, PDF2, { url: urlDe(`bases/${LIC}/${uuid(1)}.docx`) })]);
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "no_es_pdf" && m.bajadas.length === 0, "docx en bases → no_es_pdf, sin bajar");

  // Lo que SÍ se baja es exactamente la ruta de la fila (espía), aunque el cuerpo traiga otra cosa.
  m = mundo(); poblar(m, [base(1, PDF2), base(2, PDF3)]);
  r = await analizarBases({ ...entrada(["b2"]), url: urlDe(`bases/${LIC}/${uuid(1)}.pdf`) } as EntradaAnalisis, AUTH, m.deps);
  check(r.ok && m.bajadas.join() === `licitaciones/bases/${LIC}/${uuid(2)}.pdf`, "solo se baja la ruta de la fila elegida");
  const docs = (m.creados[0]?.messages[0].content as Anthropic.ContentBlockParam[]).filter((b) => b.type === "document") as Anthropic.DocumentBlockParam[];
  check(docs.length === 1 && sha(Buffer.from((docs[0].source as Anthropic.Base64PDFSource).data, "base64")) === sha(PDF3), "el PDF enviado es el de la fila, intacto");

  // Licitación inexistente y tabla faltante.
  m = mundo(); m.db.licitaciones.clear();
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "entrada_invalida", "licitación que no existe → entrada_invalida");
  m = mundo(); m.db.faltaTabla = "licitaciones";
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "sin_migracion", "sin la tabla → sin_migracion");
  m = mundo(); poblar(m, [base(1, PDF2)]); m.db.faltaTabla = "licitacion_analisis";
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "sin_migracion", "sin licitacion_analisis → sin_migracion");
}

// ══ 2 · Topes ═══════════════════════════════════════════════════════════════════════
sec("2. Topes de páginas y de bytes");
{
  let m = mundo(); poblar(m, [base(1, PDF601)]);
  let r = await analizarBases(entrada(["b1"]), AUTH, m.deps);
  check(codigo(r) === "demasiadas_paginas", "601 páginas → demasiadas_paginas");
  check(m.creados.length === 0 && m.conteos === 0, "…sin contar ni llamar al modelo");
  const f = m.db.analisis[0];
  check(f?.estado === "error" && f.tokens_entrada === null && /601/.test(f.error), "…la fila se cierra como error, sin tokens (no cuenta para el tope)");

  m = mundo(); poblar(m, [base(1, PDF2, { bytes: TOPES_ANALISIS.maxBytesCrudos + 1 })]);
  r = await analizarBases(entrada(["b1"]), AUTH, m.deps);
  check(codigo(r) === "demasiado_grande" && m.bajadas.length === 0 && m.db.analisis.length === 0, "bytes declarados de más → demasiado_grande antes de bajar");

  const enorme = new Uint8Array(TOPES_ANALISIS.maxBytesCrudos + 10);
  enorme.set(new TextEncoder().encode("%PDF-1.7\n"));
  m = mundo(); poblar(m, [base(1, enorme, { bytes: 0 })]);
  r = await analizarBases(entrada(["b1"]), AUTH, m.deps);
  check(codigo(r) === "demasiado_grande" && m.creados.length === 0, "bytes reales de más → demasiado_grande");

  m = mundo(); poblar(m, [base(1, NO_PDF)]);
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "no_es_pdf", "sin %PDF- → no_es_pdf");

  m = mundo({ tokens: TOPES_ANALISIS.maxTokensEntrada + 1 }); poblar(m, [base(1, PDF2)]);
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "demasiados_tokens" && m.creados.length === 0, "tokens de más → demasiados_tokens, sin llamar al modelo");

  // El tope crudo, en base64, cabe en el de la petición con el texto pegado más largo (4 bytes por carácter).
  check(Math.ceil(TOPES_ANALISIS.maxBytesCrudos / 3) * 4 + TOPES_ANALISIS.maxTexto * 4 <= TOPES_ANALISIS.maxBytesPeticion, "el tope crudo cabe en el de la petición");
  check(TOPES_ANALISIS.maxBytesPeticion + 200_000 < 32_000_000, "la petición deja margen bajo los 32 MB de la API");
  check(TOPES_ANALISIS.maxTokensEntrada + TOPES_ANALISIS.maxTokensSalida <= 1_000_000, "entrada + salida caben en 1M de contexto");
  check(TOPES_ANALISIS.plazoTotalMs < 300_000 && TOPES_ANALISIS.plazoModeloMs < TOPES_ANALISIS.plazoTotalMs, "plazos bajo los 300 s de la ruta");
  check(TOPES_ANALISIS.candadoMs > 300_000, "el candado vence después de lo que puede vivir la ruta");
}

// ══ 3 · PDF cifrado ═════════════════════════════════════════════════════════════════
sec("3. PDF cifrado se omite y se nombra");
{
  let m = mundo(); poblar(m, [base(1, CIFRADO, { nombre: "bases-protegidas.pdf" }), base(2, PDF2, { nombre: "tdr.pdf" })]);
  const json = { ...JSON_BASICO, requisitos: [{ ...JSON_BASICO.requisitos[0], cita: { archivoId: "A1", pagina: 1, texto: "x" } }] };
  m.deps.crear = async (p) => { m.creados.push(p); return respuestaOk(json); };
  const r = await analizarBases(entrada(["b1", "b2"]), AUTH, m.deps);
  check(r.ok && r.modo === "analisis", "uno cifrado y uno bueno → se analiza el bueno");
  if (r.ok && r.modo === "analisis") {
    const av = r.avisos.find((a) => a.codigo === "archivo_omitido");
    check(!!av && /bases-protegidas\.pdf/.test(av.detalle) && /protegido/.test(av.detalle), "…con aviso archivo_omitido que nombra el archivo");
    check(r.resultado.requisitos[0].cita.archivoId === "b2", "…y A1 es el archivo que SÍ se envió (tdr.pdf)");
  }
  const cont = m.creados[0].messages[0].content as Anthropic.ContentBlockParam[];
  check(cont.filter((b) => b.type === "document").length === 1, "…un solo documento enviado");
  check(cont.some((b) => b.type === "text" && /Archivo A1 · bases · «tdr\.pdf»/.test(b.text)), "…etiquetado A1");
  check(m.db.analisis[0].archivos.find((a: any) => a.id === "b1")?.omitido === "pdf_protegido", "…la fila registra el omitido");

  m = mundo(); poblar(m, [base(1, CIFRADO)]);
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "pdf_protegido" && m.conteos === 0, "todos cifrados → pdf_protegido");
  m = mundo(); poblar(m, [base(1, CIFRADO)]);
  const conTexto = await analizarBases(entrada(["b1"], { texto: "Requisito: SOAT vigente." }), AUTH, m.deps);
  check(conTexto.ok, "cifrado + texto pegado → se analiza el texto");

  m = mundo(); poblar(m, [base(1, PDF2)]); m.storage.clear();
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "sin_archivos", "no se pudo bajar el único → sin_archivos");
}

// ══ 4 · Candado ═════════════════════════════════════════════════════════════════════
sec("4. Candado en curso");
{
  let m = mundo(); poblar(m, [base(1, PDF2)]);
  m.db.analisis.push({ id: 1, licitacion_id: LIC, estado: "en_curso", creado_en: new Date(MOMENTO - 60_000).toISOString(), tokens_entrada: 900 });
  let r = await analizarBases(entrada(["b1"]), AUTH, m.deps);
  check(codigo(r) === "en_curso" && m.creados.length === 0 && m.bajadas.length === 0, "uno en curso hace 1 min → en_curso, sin bajar ni llamar");

  m = mundo(); poblar(m, [base(1, PDF2)]);
  m.db.analisis.push({ id: 1, licitacion_id: LIC, estado: "en_curso", creado_en: new Date(MOMENTO - 7 * 60_000).toISOString(), tokens_entrada: 900 });
  r = await analizarBases(entrada(["b1"]), AUTH, m.deps);
  check(r.ok && m.db.analisis[0].estado === "error" && /cortó/.test(m.db.analisis[0].error), "uno colgado (7 min) se cierra como error y se analiza");

  // Dos a la vez: el segundo choca con el índice único.
  m = mundo(); poblar(m, [base(1, PDF2)]);
  let soltar!: () => void;
  const espera = new Promise<void>((s) => (soltar = s));
  m.deps.crear = async (p) => { m.creados.push(p); await espera; return respuestaOk(JSON_BASICO); };
  const p1 = analizarBases(entrada(["b1"]), AUTH, m.deps);
  await new Promise((s) => setTimeout(s, 30));
  const r2 = await analizarBases(entrada(["b1"]), AUTH, m.deps);
  soltar();
  const r1 = await p1;
  check(r1.ok && codigo(r2) === "en_curso" && m.creados.length === 1, "dos a la vez → uno analiza, el otro en_curso");
  check(m.db.analisis.length === 1 && m.db.analisis[0].estado === "listo", "…una sola fila, cerrada como listo");
}

// ══ 5 · Estimar y tope diario ════════════════════════════════════════════════════════
sec("5. Estimar y tope diario");
{
  let m = mundo({ tokens: 120_000 }); poblar(m, [base(1, PDF2), base(2, PDF3)]);
  const r = await analizarBases(entrada(["b1", "b2"], { estimar: true }), AUTH, m.deps);
  check(r.ok && r.modo === "estimacion" && r.tokensEntrada === 120_000 && r.paginas === 5, "estimar → tokens y páginas");
  check(r.ok && r.modo === "estimacion" && r.costoUsdMax === costoUsd(120_000, TOPES_ANALISIS.maxTokensSalida), "…costo máximo con la salida tope");
  check(m.creados.length === 0 && m.db.analisis.length === 0 && m.conteos === 1, "…sin llamar al modelo ni crear fila");

  const hoy = (h: number) => new Date(Date.parse("2026-10-24T05:00:00Z") + h * 3_600_000).toISOString(); // 00:00 Lima + h
  m = mundo(); poblar(m, [base(1, PDF2)]);
  for (let i = 0; i < TOPES_ANALISIS.porDia; i++) m.db.analisis.push({ id: i + 1, licitacion_id: 50 + i, estado: "listo", creado_en: hoy(1), tokens_entrada: 1000 });
  let t = await analizarBases(entrada(["b1"]), AUTH, m.deps);
  check(codigo(t) === "tope_diario" && !t.ok && (t.reintentarEnSeg ?? 0) > 0, "20 hoy → tope_diario con reintentarEnSeg");
  check(m.bajadas.length === 0 && m.creados.length === 0, "…sin bajar ni llamar");
  t = await analizarBases(entrada(["b1"], { estimar: true }), AUTH, m.deps);
  check(codigo(t) === "tope_diario", "…también al estimar");

  m = mundo(); poblar(m, [base(1, PDF2)]);
  for (let i = 0; i < 30; i++) m.db.analisis.push({ id: i + 1, licitacion_id: 50 + i, estado: "listo", creado_en: new Date(Date.parse("2026-10-24T04:59:00Z")).toISOString(), tokens_entrada: 1000 }); // 23:59 de ayer en Lima
  for (let i = 0; i < 30; i++) m.db.analisis.push({ id: 100 + i, licitacion_id: 90 + i, estado: "error", creado_en: hoy(2), tokens_entrada: null }); // fallaron antes del modelo
  t = await analizarBases(entrada(["b1"]), AUTH, m.deps);
  check(t.ok, "lo de ayer (Lima) y lo que falló antes del modelo no cuentan");
}

// ══ 6 · El modelo y el cierre de la fila ═════════════════════════════════════════════
sec("6. Respuestas del modelo");
{
  const conMensaje = (msg: MensajeFinal) => { const m = mundo({ crear: async () => msg }); poblar(m, [base(1, PDF2)]); return m; };
  let m = conMensaje({ stop_reason: "max_tokens", content: [{ type: "text", text: "{\"concurso\":" }], usage: { input_tokens: 9000, output_tokens: 48000 } });
  let r = await analizarBases(entrada(["b1"]), AUTH, m.deps);
  let f = m.db.analisis[0];
  check(codigo(r) === "respuesta_cortada", "max_tokens → respuesta_cortada");
  check(f.estado === "error" && f.tokens_salida === 48000 && f.costo_usd === costoUsd(9000, 48000) && f.terminado_en, "…la fila guarda tokens y costo (se pagó)");

  m = conMensaje({ stop_reason: "refusal", content: [], usage: { input_tokens: 9000, output_tokens: 10 }, stop_details: { category: "cyber", explanation: null } });
  r = await analizarBases(entrada(["b1"]), AUTH, m.deps);
  check(codigo(r) === "rechazo" && m.db.analisis[0].estado === "error" && m.db.analisis[0].costo_usd !== null, "refusal → rechazo, con costo");

  m = conMensaje({ stop_reason: "end_turn", content: [{ type: "text", text: "no es json" }], usage: { input_tokens: 9000, output_tokens: 10 } });
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "respuesta_ilegible", "texto que no es JSON → respuesta_ilegible");
  m = conMensaje({ stop_reason: "end_turn", content: [{ type: "text", text: "[1,2]" }], usage: { input_tokens: 9000, output_tokens: 10 } });
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "respuesta_ilegible", "un arreglo → respuesta_ilegible");

  const lanza = (e: unknown) => { const mm = mundo({ crear: async () => { throw e; } }); poblar(mm, [base(1, PDF2)]); return mm; };
  m = lanza(Anthropic.APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "x" } }, "x", new Headers()));
  r = await analizarBases(entrada(["b1"]), AUTH, m.deps);
  check(codigo(r) === "error_modelo" && m.db.analisis[0].estado === "error" && m.db.analisis[0].tokens_entrada === 5000, "429 → error_modelo; la fila cuenta (llamó al modelo)");
  m = lanza(Anthropic.APIError.generate(401, { type: "error", error: { type: "authentication_error", message: "x" } }, "x", new Headers()));
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "sin_clave", "401 → sin_clave");
  m = lanza(new Error("ECONNRESET"));
  check(codigo(await analizarBases(entrada(["b1"]), AUTH, m.deps)) === "error_modelo", "red caída → error_modelo");

  m = mundo({ plazoModeloMs: 40, crear: (_p, s) => new Promise((_, rej) => s.addEventListener("abort", () => rej(new Anthropic.APIUserAbortError()))) });
  poblar(m, [base(1, PDF2)]);
  r = await analizarBases(entrada(["b1"]), AUTH, m.deps);
  check(codigo(r) === "error_modelo" && !r.ok && /tardó/.test(r.error), "plazo vencido → se aborta y lo dice");

  // Éxito: la fila queda lista con el resultado normalizado.
  m = mundo(); poblar(m, [base(1, PDF2)]);
  r = await analizarBases(entrada(["b1"], { texto: "  Requisito extra pegado  " }), AUTH, m.deps);
  f = m.db.analisis[0];
  check(r.ok && r.modo === "analisis" && r.analisisId === f.id, "éxito → analisisId de la fila");
  check(f.estado === "listo" && f.resultado?.requisitos?.length === 1 && f.error === null && f.usuario_id === AUTH.userId, "…fila lista con su resultado y usuario");
  check(f.modelo === MODELO_ANALISIS && f.archivos[0].sha256 === sha(PDF2) && f.archivos[0].paginas === 2 && f.archivos[0].bytes === PDF2.length, "…con modelo y archivos (sha256, páginas, bytes)");
  check(f.texto_sha256 === createHash("sha256").update("Requisito extra pegado").digest("hex"), "…y el sha256 del texto pegado");
  check(r.ok && r.modo === "analisis" && r.uso.costoUsd === costoUsd(5000, 1200) && f.costo_usd === r.uso.costoUsd, "…costo calculado y guardado");
  const p = m.creados[0];
  check(p.model === "claude-opus-5-5" && p.max_tokens === 48000 && (p.thinking as any)?.type === "adaptive", "petición: modelo, max_tokens y pensamiento adaptativo");
  check((p.output_config as any)?.effort === "high" && (p.output_config as any)?.format?.type === "json_schema" && JSON.stringify((p.output_config as any)?.format?.schema) === JSON.stringify(ESQUEMA_ANALISIS), "…effort high y el esquema");
  check(!("tools" in p) && !("tool_choice" in p) && !("temperature" in p), "…sin tools, tool_choice ni temperature");
  check((p.messages[0].content as Anthropic.ContentBlockParam[]).some((b) => b.type === "text" && b.text.includes("<texto_pegado>")), "…el texto pegado va marcado");
}

// ══ 7 · Normalización ════════════════════════════════════════════════════════════════
sec("7. leerAnalisisBases");
{
  const ARCH = [{ id: "uuid-a", nombre: "bases.pdf" }, { id: "uuid-b", nombre: "absolucion.pdf" }];
  const crudo = {
    concurso: { cliente_nombre: "  Entidad  X ", codigo: "", objeto: "", atencion: "", fecha_consultas: "2026-02-30", fecha_presentacion: "2026-11-20", hora_presentacion: "25:00", fecha_inicio_servicio: "2026-12-01", plazo_meses: 999 },
    requisitos: [
      { numeral: "1", texto: "A", categoria: "legal", obligatorio: true, regla: { tipo: "inventada" }, cita: { archivoId: "A1", pagina: 3, texto: "x" } },
      { numeral: "2", texto: "B", categoria: "rarisima", obligatorio: false, regla: { tipo: "ninguna" }, cita: { archivoId: "A7", pagina: 2, texto: "y" } },
      { numeral: "3", texto: "C", categoria: "unidad", obligatorio: true, regla: { tipo: "unidad_antiguedad_max", anios: 0 }, cita: { archivoId: "", pagina: 0, texto: "" } },
      { numeral: "4", texto: "D".repeat(2000), categoria: "experiencia", regla: { tipo: "experiencia_monto_min", monto: 500000 }, cita: { archivoId: "uuid-b", pagina: 9999, texto: "" } },
      { numeral: "5", texto: "   ", categoria: "legal", regla: null, cita: {} },
      { numeral: "6", texto: "E", categoria: "conductor", obligatorio: true, regla: { tipo: "conductor_licencia", categorias: ["A-IIIb", "a-iiib", "A IIIc"] }, cita: { archivoId: "a2", pagina: 4, texto: "lic" } },
      { clave: "req-1", numeral: "7", texto: "F", categoria: "seguro", obligatorio: true, regla: { tipo: "seguro", seguro: "deshonestidad" }, cita: null },
    ],
    consultas: [{ numero: "1", pregunta: "¿Se acepta retén?", respuesta: "Sí", cita: { archivoId: "A2", pagina: 1, texto: "" } }],
    estructura: [{ titulo: "Sección II", subtitulo: "Requisitos legales", referencia: "Num. 5", contenido: ["Copia literal", "", "Ficha RUC"] }],
    penalidades: [{ texto: "Retraso: descuento", cita: { archivoId: "A1", pagina: 5, texto: "" } }],
    criterios: [{ texto: "Experiencia", peso: "", cita: {} }],
    advertencias: ["La absolución cambia la fecha", ""],
  };
  const { resultado: R, avisos: A } = leerAnalisisBases(crudo, ARCH);
  const cod = (c: string) => A.filter((a) => a.codigo === c);
  check(R.concurso.fecha_consultas === null && cod("fecha_invalida").some((a) => /2026-02-30/.test(a.detalle)), "2026-02-30 → null + aviso");
  check(R.concurso.fecha_presentacion === "2026-11-20" && R.concurso.fecha_inicio_servicio === "2026-12-01", "fechas válidas se conservan");
  check(R.concurso.hora_presentacion === null && cod("fecha_invalida").some((a) => /25:00/.test(a.detalle)), "hora 25:00 → null + aviso");
  check(R.concurso.plazo_meses === null && cod("numero_fuera_de_rango").some((a) => /999/.test(a.detalle)), "plazo 999 → null + aviso");
  check(R.concurso.cliente_nombre === "Entidad X" && R.concurso.codigo === null, "texto limpio; vacío → null");
  check(R.requisitos.length === 6, "requisito vacío descartado");
  check(R.requisitos[0].regla === null && cod("regla_desconocida").some((a) => /inventada/.test(a.detalle)), "regla fuera del catálogo → null + aviso");
  check(R.requisitos[1].categoria === "otro" && cod("categoria_desconocida").length === 1, "categoría rara → otro + aviso");
  check(R.requisitos[1].obligatorio === false, "obligatorio false se respeta");
  check(R.requisitos[1].cita.archivoId === null && R.requisitos[1].cita.pagina === null, "cita a A7 (no enviado) → sin archivo ni página");
  check(R.requisitos[0].cita.archivoId === "uuid-a" && R.requisitos[0].cita.pagina === 3, "A1 → id del primer archivo");
  check(R.requisitos[2].regla === null && cod("regla_desconocida").some((a) => /unidad_antiguedad_max/.test(a.detalle)), "parámetro faltante → regla null + aviso");
  check(R.requisitos[3].regla === null && cod("regla_desconocida").some((a) => /moneda/.test(a.detalle)), "monto sin moneda → regla null");
  check(Array.from(R.requisitos[3].texto).length === 1000 && R.requisitos[3].texto.endsWith("…") && cod("texto_recortado").length >= 1, "texto largo → recortado a 1000 + aviso");
  check(R.requisitos[3].cita.archivoId === "uuid-b" && R.requisitos[3].cita.pagina === null && cod("numero_fuera_de_rango").some((a) => /9999/.test(a.detalle)), "página fuera de rango → null + aviso");
  const lic = R.requisitos[4].regla;
  check(lic?.tipo === "conductor_licencia" && lic.categorias.join() === "A-IIIb,A-IIIc", "categorías de licencia normalizadas y sin repetir");
  check(R.requisitos[4].cita.archivoId === "uuid-b", "«a2» → segundo archivo");
  check(R.requisitos[5].regla?.tipo === "seguro" && (R.requisitos[5].regla as any).vigenteAl === "presentacion", "seguro sin vigenteAl → presentacion (defecto declarado)");
  check(R.requisitos[5].obligatorio === true && R.requisitos[0].obligatorio === true, "obligatorio ausente → true");
  const clavesReq = R.requisitos.map((r) => r.clave);
  check(new Set(clavesReq).size === clavesReq.length && clavesReq.includes("req-1") && clavesReq[5] === "req-1", "claves únicas; una guardada válida se conserva");
  check(R.estructura[0].contenido.join("|") === "Copia literal|Ficha RUC", "estructura sin documentos vacíos");
  check(R.criterios[0].peso === null && R.advertencias.length === 1, "peso vacío → null; advertencia vacía fuera");
  check(R.consultas[0].clave === "con-1" && R.penalidades[0].clave === "pen-1" && R.estructura[0].clave === "est-1" && R.criterios[0].clave === "cri-1", "claves por prefijo");

  // Idempotencia: lo guardado vuelve igual y sin avisos nuevos.
  const segunda = leerAnalisisBases(JSON.parse(JSON.stringify(R)), ARCH);
  check(JSON.stringify(segunda.resultado) === JSON.stringify(R), "idempotente: el resultado guardado se relee igual");
  check(segunda.avisos.length === 0, "…y sin avisos nuevos");

  // Basura: nunca lanza.
  let lanzo = false;
  for (const x of [null, undefined, 3, "x", [], { requisitos: "no" }, { requisitos: [null, 1, "a", { texto: 5 }] }, { concurso: [] }, { estructura: [{ contenido: "x" }] }]) {
    try { leerAnalisisBases(x, ARCH); } catch { lanzo = true; }
  }
  check(!lanzo, "entradas basura no lanzan");
  const vacio = leerAnalisisBases(null, ARCH).resultado;
  check(vacio.requisitos.length === 0 && vacio.concurso.fecha_presentacion === null, "null → resultado vacío");

  // Tope de requisitos y de avisos por código.
  const muchos = { requisitos: Array.from({ length: 340 }, (_, i) => ({ numeral: String(i), texto: `R${i}`, categoria: "nada", regla: { tipo: "no" } })) };
  const L = leerAnalisisBases(muchos, ARCH);
  check(L.resultado.requisitos.length === TOPES_ANALISIS.maxRequisitos && L.avisos.some((a) => a.codigo === "texto_recortado" && /340/.test(a.detalle)), "340 requisitos → 300 + aviso");
  check(L.avisos.filter((a) => a.codigo === "regla_desconocida").length === TOPES_ANALISIS.maxAvisosPorCodigo + 1, "avisos por código topados, con un resumen");
}

sec("7b. Cada regla del catálogo SÍ se lee (corolario)");
{
  const validas: Record<string, Record<string, unknown>> = {
    doc_empresa: { legajo: "ficha_ruc", antiguedadMaxDias: 30 },
    unidad_antiguedad_max: { anios: 10, referencia: "inicio_servicio" },
    unidad_capacidad_min: { asientos: 30, uso: "Ruta norte" },
    unidad_doc: { doc: "citv", vigenteAl: "presentacion" },
    unidad_fotos: {},
    unidades_titulares_min: { n: 4 },
    unidades_reten_min: { n: 1 },
    conductor_licencia: { categorias: ["A-IIIa"] },
    conductor_doc: { doc: "examen_medico", antiguedadMaxDias: 90 },
    conductores_relevo_min: { n: 2 },
    prohibe_subcontratacion: {},
    experiencia_anios_min: { anios: 5, desde: "constitucion" },
    experiencia_monto_min: { monto: 250000.555, moneda: "PEN" },
    experiencia_cartas_min: { n: 3 },
    experiencia_ventana_anios: { anios: 5 },
    seguro: { seguro: "sctr_salud", vigenteAl: "inicio_servicio" },
  };
  check(Object.keys(validas).sort().join() === [...TIPOS_REGLA].sort().join(), "el barrido cubre todo TIPOS_REGLA");
  for (const t of TIPOS_REGLA) {
    const { regla, problema } = leerRegla({ tipo: t, ...validas[t], legajoExtra: "x", n_otro: 3 });
    check(regla?.tipo === t && problema === null, `${t}: se lee`);
    // Solo las claves de su tipo (las demás se ignoran).
    const permitidas = new Set(["tipo", ...Object.keys(validas[t]), ...(t === "doc_empresa" || t === "conductor_doc" ? ["antiguedadMaxDias"] : []), ...(t === "unidad_capacidad_min" ? ["uso"] : [])]);
    check(regla !== null && Object.keys(regla).every((k) => permitidas.has(k)), `${t}: sin parámetros ajenos`);
    // Idempotente: una regla ya guardada se lee igual.
    check(JSON.stringify(leerRegla(regla).regla) === JSON.stringify(regla), `${t}: idempotente`);
  }
  check((leerRegla({ tipo: "experiencia_monto_min", monto: 250000.555, moneda: "PEN" }).regla as any).monto === 250000.56, "monto a 2 decimales");
  check(leerRegla({ tipo: "doc_empresa", legajo: "ficha_ruc" }).regla?.tipo === "doc_empresa" && (leerRegla({ tipo: "doc_empresa", legajo: "ficha_ruc" }).regla as any).antiguedadMaxDias === null, "antigüedad ausente → null (sin tope)");
  for (const [t, p] of [
    ["doc_empresa", { legajo: "pasaporte" }], ["doc_empresa", { legajo: "ficha_ruc", antiguedadMaxDias: -3 }], ["doc_empresa", { legajo: "ficha_ruc", antiguedadMaxDias: 2.5 }],
    ["unidad_antiguedad_max", { anios: 99 }], ["unidad_antiguedad_max", { anios: 10, referencia: "ayer" }], ["unidad_capacidad_min", { asientos: 500 }],
    ["unidad_doc", { doc: "examen_medico" }], ["conductor_doc", { doc: "soat" }], ["conductor_doc", { doc: "licencia_conducir" }],
    ["conductor_licencia", { categorias: [] }], ["conductor_licencia", { categorias: ["B-IIb"] }], ["unidades_reten_min", { n: 0 }],
    ["experiencia_monto_min", { monto: -1, moneda: "PEN" }], ["experiencia_monto_min", { monto: 10, moneda: "EUR" }], ["experiencia_anios_min", { anios: 5, desde: "ayer" }],
    ["seguro", { seguro: "soat" }], ["experiencia_ventana_anios", { anios: "5" }],
  ] as [string, Record<string, unknown>][]) {
    const r = leerRegla({ tipo: t, ...p });
    check(r.regla === null && !!r.problema, `${t} ${JSON.stringify(p)}: inválida → null con problema`);
  }
  check(leerRegla({ tipo: "ninguna" }).regla === null && leerRegla({ tipo: "ninguna" }).problema === null, "ninguna → null sin problema");
  check(leerRegla(null).problema === null && leerRegla("x").problema !== null, "null sin problema; texto → problema");
  // Barrido de basura: nunca lanza, y lo que devuelve es del catálogo.
  const valores = [undefined, null, 0, -1, 1, 7, 2.5, 1e9, "", "x", "PEN", "A-IIIa", true, [], ["A-I"], {}];
  let lanzo = false, fuera = false;
  for (const t of [...TIPOS_REGLA, "ninguna", "otra", 3]) for (const v of valores) {
    const o: Record<string, unknown> = { tipo: t };
    for (const k of PARAMETROS_REGLA) o[k] = v;
    try { const r = leerRegla(o); if (r.regla && !(TIPOS_REGLA as readonly string[]).includes(r.regla.tipo)) fuera = true; } catch { lanzo = true; }
  }
  check(!lanzo && !fuera, "barrido de parámetros: nunca lanza ni sale del catálogo");
}

sec("7c. requisitoDePropuesto y bloquesDeEstructura");
{
  let n = 0;
  const nuevoId = () => `id-${++n}`;
  const { resultado } = leerAnalisisBases(JSON_BASICO, [{ id: "uuid-a", nombre: "a.pdf" }]);
  const p = resultado.requisitos[0];
  const q = requisitoDePropuesto(p, nuevoId);
  check(q.id === "id-1" && q.origen === "ia" && q.manual === null && q.enMatriz && q.sustento === "" && q.bloqueExpedienteId === null, "requisito: origen ia, sin estado manual");
  check(q.cita?.archivoId === "uuid-a" && q.cita?.pagina === 2 && q.regla?.tipo === "doc_empresa", "…con su cita y su regla");
  check(q.regla !== p.regla && q.cita !== p.cita, "…copias, no referencias");
  const bl = bloquesDeEstructura([{ clave: "est-1", titulo: "", subtitulo: "Legal", referencia: "Num. 5", contenido: ["Ficha RUC", "Copia literal"] }], nuevoId);
  check(bl.length === 1 && bl[0].titulo === "Bloque 1" && bl[0].activo && bl[0].conPortada, "bloque con título de respaldo");
  check(bl[0].items.length === 2 && bl[0].items.every((i) => i.fuente.tipo === "adjunto" && (i.fuente as any).archivo === null && i.incluido) && bl[0].items[0].titulo === "Ficha RUC", "…cada documento es un adjunto pendiente con su título");
  check(new Set([bl[0].id, ...bl[0].items.map((i) => i.id)]).size === 3, "…ids nuevos");
}

sec("7d. Fechas y horas");
{
  check(fechaValida("2026-02-28") === "2026-02-28" && fechaValida("2026-02-29") === null && fechaValida("2028-02-29") === "2028-02-29", "29 de febrero solo en bisiesto");
  check(fechaValida("2026-13-01") === null && fechaValida("26-11-20") === null && fechaValida("2026-11-20T10:00") === null, "formatos inválidos");
  check(horaValida("9:05") === "09:05" && horaValida("23:59:59") === "23:59" && horaValida("24:00") === null && horaValida("10h") === null, "horas");
  check(costoUsd(1_000_000, 0) === PRECIO_ANALISIS.entradaUsdPorMillon && costoUsd(0, 1_000_000) === PRECIO_ANALISIS.salidaUsdPorMillon, "costo por millón");
  check(costoUsd(12_345, 678) === Math.round((12_345 * 4 + 678 * 20) / 1_000_000 * 10_000) / 10_000 && costoUsd(null, 1) === null && costoUsd(-1, 1) === null, "costo redondeado; sin dato → null");
}

// ══ 8 · Barrido del prompt y del esquema ═════════════════════════════════════════════
sec("8. Prompt y esquema");
{
  const esquemaTxt = JSON.stringify(ESQUEMA_ANALISIS);
  const conteo = parametrosAnalisis(contenidoAnalisis([], "x"));
  const sistema = String(conteo.system);
  check(sistema === PROMPT_ANALISIS, "el system es el prompt declarado");
  check(!/\d{4,}/.test(PROMPT_ANALISIS) && !/\d{4,}/.test(esquemaTxt), "ningún número de 4 o más cifras en el prompt ni en el esquema");
  const EMPRESAS = ["AFA", "MASS", "SNACKS", "PIERIPLAST", "COESTI", "PRIMAX", "GLOBAL BUS", "LOGÍSTICA", "AMERICA LATINA", "TOURS"];
  const hay = (t: string) => EMPRESAS.filter((e) => new RegExp(`(^|[^\\p{L}])${e}([^\\p{L}]|$)`, "iu").test(t));
  check(hay(PROMPT_ANALISIS).length === 0 && hay(esquemaTxt).length === 0, `ningún nombre de empresa (${[...hay(PROMPT_ANALISIS), ...hay(esquemaTxt)].join(", ")})`);
  check(!/\b\d{11}\b/.test(PROMPT_ANALISIS), "ningún RUC");
  for (const t of TIPOS_REGLA) check(PROMPT_ANALISIS.includes(`- ${t}:`), `el prompt explica la regla ${t}`);
  for (const c of CODIGOS_LEGAJO) check(PROMPT_ANALISIS.includes(c), `el prompt nombra el legajo ${c}`);
  for (const c of [...DOCS_UNIDAD_LIC, ...DOCS_CONDUCTOR_REGLA, ...TIPOS_SEGURO_LIC, ...CATEGORIAS_CLASE_A]) check(PROMPT_ANALISIS.includes(c), `el prompt nombra ${c}`);
  for (const c of CATEGORIAS_REQUISITO) check(PROMPT_ANALISIS.includes(c), `el prompt nombra la categoría ${c}`);

  // Recorrido del esquema.
  let objetos = 0, sinAP = 0, uniones = 0, opcionales = 0;
  const malos: string[] = [];
  const PROHIBIDAS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "maxItems", "uniqueItems", "anyOf", "oneOf", "allOf", "not", "$ref", "if", "then"];
  const recorrer = (n: any, ruta: string) => {
    if (!n || typeof n !== "object") return;
    for (const k of PROHIBIDAS) if (k in n) malos.push(`${ruta}.${k}`);
    if (Array.isArray(n.type)) uniones++;
    if ("minItems" in n && n.minItems !== 0 && n.minItems !== 1) malos.push(`${ruta}.minItems`);
    if (n.type === "object") {
      objetos++;
      if (n.additionalProperties !== false) sinAP++;
      const props = Object.keys(n.properties ?? {});
      const req: string[] = n.required ?? [];
      if (!req.every((r) => props.includes(r))) malos.push(`${ruta}.required`);
      opcionales += props.filter((p) => !req.includes(p)).length;
      for (const p of props) recorrer(n.properties[p], `${ruta}.${p}`);
    }
    if (n.type === "array") recorrer(n.items, `${ruta}[]`);
    if (n.enum && !n.enum.every((v: unknown) => typeof v === "string")) malos.push(`${ruta}.enum`);
  };
  recorrer(ESQUEMA_ANALISIS, "$");
  check(objetos >= 10 && sinAP === 0, `additionalProperties:false en los ${objetos} objetos`);
  check(uniones === 0, "cero tipos unión");
  check(opcionales <= 24 && opcionales === PARAMETROS_REGLA.length, `opcionales = parámetros de la regla (${opcionales} ≤ 24)`);
  check(malos.length === 0, `nada que structured outputs no compile (${malos.join(", ")})`);
  const regla = (ESQUEMA_ANALISIS as any).properties.requisitos.items.properties.regla;
  check(JSON.stringify(regla.properties.tipo.enum) === JSON.stringify(["ninguna", ...TIPOS_REGLA]), "regla.tipo = ninguna + catálogo");
  check(JSON.stringify(regla.properties.legajo.enum) === JSON.stringify([...CODIGOS_LEGAJO]), "legajo = CODIGOS_LEGAJO");
  check(JSON.stringify(Object.keys(regla.properties).filter((k) => k !== "tipo")) === JSON.stringify([...PARAMETROS_REGLA]), "PARAMETROS_REGLA = propiedades de la regla");
  check(JSON.stringify(regla.properties.categorias.items.enum) === JSON.stringify([...CATEGORIAS_CLASE_A]), "categorías de licencia");
  check((ESQUEMA_ANALISIS as any).required.join() === "concurso,requisitos,consultas,estructura,penalidades,criterios,advertencias", "raíz con las siete partes");
  check(esquemaTxt.length < 20_000, "esquema compacto");
}

console.log(`\n${ok} bien · ${fallos} mal`);
if (fallos) process.exit(1);
