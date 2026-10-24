// lib/licitaciones/analisis-datos.ts — SOLO SERVIDOR. Lee las bases de una licitación desde Storage,
// se las manda a Claude y guarda la PROPUESTA en licitacion_analisis. Todo lo que sale hacia fuera
// (la base, Storage, la API de Anthropic, el reloj) llega INYECTADO en `deps`, para que la matriz
// (scripts/prueba-licitaciones-analisis.mts) recorra el camino entero sin red y sin clave.
//
// LO QUE NO SE PUEDE AFLOJAR:
//  · EL CUERPO NUNCA DICE QUÉ BAJAR. Trae ids; las URLs salen de `licitaciones.doc->bases` de LA FILA
//    leída con service-role, y cada una tiene que ser un objeto del bucket `licitaciones` con la forma
//    EXACTA con que se subió (RE_RUTA_BASE): `bases/<id de ESA licitación>/<uuid>.pdf`. Nada se baja con
//    fetch a una URL: se baja con `deps.descargar(bucket, ruta)` (el Storage del proyecto).
//  · UN PDF CIFRADO SE OMITE Y SE NOMBRA (R11), nunca se abre con ignoreEncryption. Si todos lo están,
//    `pdf_protegido`.
//  · EL GASTO SE CONTROLA EN LA BASE. El tope diario cuenta las filas de hoy (Lima) que LLAMARON al modelo
//    (las `en_curso` y las que tienen tokens_entrada); un análisis que falló antes de llamarlo no cuenta.
//    El candado es el índice único `(licitacion_id) where estado='en_curso'`: el doble clic choca ahí
//    (23505 → `en_curso`), y uno más viejo que `candadoMs` (la función murió) se cierra como error.
//  · ESTIMAR NO CREA FILA: cuenta tokens (count_tokens no se cobra) y devuelve el costo máximo. Crear una
//    fila «en curso» para luego cerrarla como error ensuciaría la bitácora de análisis con algo que no fue.
//  · LA FILA SE CIERRA SIEMPRE (finally): listo con su resultado, o error con el motivo. Un análisis que
//    llamó al modelo y falló (cortado, rechazado, ilegible) guarda igual sus tokens y su costo: se pagó.
//
// Errores ESPERADOS → `{ ok:false, codigo, error }` en castellano. Un error de la base o de la red que no
// es de los esperados LANZA: la ruta lo convierte en un mensaje genérico y deja el detalle en el log.

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PDFDocument, ParseSpeeds } from "pdf-lib";
import { fechaLima } from "@/lib/documentos-estado";
import { objetoPrivadoDe, baseSupabase } from "@/lib/storage-privado";
import { tablaFaltante, type ErrorSupabase } from "@/lib/columna-faltante";
import { RE_RUTA_BASE } from "./archivos";
import { BUCKET_LICITACIONES, type ArchivoBase, type AvisoAnalisis, type CodigoErrorAnalisis, type EntradaAnalisis, type RespuestaAnalisis, type TipoBase } from "./tipos";
import {
  MODELO_ANALISIS, TOPES_ANALISIS, costoUsd, contenidoAnalisis, etiquetaArchivo, leerAnalisisBases,
  parametrosAnalisis, parametrosConteo, validarEntradaAnalisis, type ArchivoParaModelo,
} from "./analisis";

export type SupabaseServiceRole = SupabaseClient<any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Lo único del mensaje final que se usa (un Anthropic.Message cabe aquí). */
export type MensajeFinal = {
  stop_reason: string | null;
  content: ReadonlyArray<{ type: string; text?: string }>;
  usage: { input_tokens: number; output_tokens: number } | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
};

export type DepsAnalisis = {
  db: SupabaseServiceRole;
  /** Baja un objeto de Storage (bucket, ruta) con service-role. Lanza si no puede. */
  descargar: (bucket: string, ruta: string) => Promise<Uint8Array>;
  contarTokens: (params: Anthropic.MessageCountTokensParams) => Promise<number>;
  crear: (params: Anthropic.MessageCreateParamsNonStreaming, señal: AbortSignal) => Promise<MensajeFinal>;
  ahora?: () => number;
  /** URL del proyecto de Supabase con la que se comparan los enlaces (por defecto NEXT_PUBLIC_SUPABASE_URL). */
  base?: string | null;
  /** Solo pruebas: el plazo del modelo, para no esperar 280 s. */
  plazoModeloMs?: number;
};

type Falla = { ok: false; codigo: CodigoErrorAnalisis; error: string; reintentarEnSeg?: number };
const falla = (codigo: CodigoErrorAnalisis, error: string, reintentarEnSeg?: number): Falla =>
  reintentarEnSeg === undefined ? { ok: false, codigo, error } : { ok: false, codigo, error, reintentarEnSeg };

const MIGRACION = "supabase/licitaciones-01a-tablas.sql";
const sinMigracion = (): Falla =>
  falla("sin_migracion", `Falta correr ${MIGRACION} en Supabase (el deploy no corre las migraciones): sin las tablas de licitaciones no se pueden leer las bases.`);

const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const mb = (bytes: number): string => (bytes / (1024 * 1024)).toLocaleString("es-PE", { maximumFractionDigits: 1 });

/** El instante de las 00:00 de hoy en Lima (UTC-5, sin horario de verano). */
function inicioDiaLima(ms: number): { iso: string; ms: number } {
  const f = fechaLima(ms);
  const inicio = Date.parse(`${f}T00:00:00-05:00`);
  return { iso: new Date(inicio).toISOString(), ms: inicio };
}

/** ¿El PDF está cifrado? pdf-lib lanza EncryptedPDFError, pero su clase no sobrevive a `instanceof`
 *  (ES5 extendiendo Error): se reconoce por el mensaje y, de respaldo, por el /Encrypt del tráiler. */
function esCifrado(e: unknown, bytes: Uint8Array): boolean {
  const m = String((e as { message?: unknown } | null)?.message ?? "");
  if (/encrypted/i.test(m)) return true;
  const cola = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 4096))).toString("latin1");
  return /\/Encrypt\b/.test(cola);
}

/** ¿Empieza como un PDF? La firma `%PDF-` puede venir tras algo de basura, dentro del primer KiB. */
function parecePdf(bytes: Uint8Array): boolean {
  const cabeza = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  return cabeza.includes("%PDF-");
}

const statusDe = (e: unknown): number | undefined =>
  e instanceof Anthropic.APIError ? e.status : typeof (e as { status?: unknown } | null)?.status === "number" ? (e as { status: number }).status : undefined;

/** El error de la API de Anthropic, en castellano y sin su detalle crudo (el detalle va al log). */
function errorDelModelo(e: unknown, abortado: boolean, plazoSeg: number): Falla {
  if (abortado || e instanceof Anthropic.APIUserAbortError) {
    return falla("error_modelo", `La lectura tardó más de ${plazoSeg} s y se cortó. Elige menos archivos (o solo las secciones de requisitos) y vuelve a intentarlo.`);
  }
  const s = statusDe(e);
  if (s === 401 || s === 403) return falla("sin_clave", "Anthropic rechazó la clave del servidor (ANTHROPIC_API_KEY). Revísala en Vercel → Environment Variables.");
  if (s === 429) return falla("error_modelo", "Anthropic está limitando las peticiones en este momento. Vuelve a intentarlo en unos minutos.", 120);
  if (s === 413) return falla("demasiado_grande", "Anthropic rechazó la petición por su tamaño. Elige menos archivos o archivos más livianos.");
  if (s === 400) return falla("error_modelo", "Anthropic rechazó la petición (400). El detalle quedó en el registro del servidor; avisa a soporte.");
  if (s !== undefined && s >= 500) return falla("error_modelo", "El servicio de Anthropic falló o está sobrecargado. Vuelve a intentarlo en unos minutos.", 60);
  return falla("error_modelo", "No se pudo hablar con el servicio de Anthropic. Vuelve a intentarlo en un momento.");
}

type ArchivoLeido = { base: ArchivoBase; ruta: string; bytes: Uint8Array; paginas: number; sha: string };
type FilaArchivo = { id: string; nombre: string; tipo: TipoBase | null; bytes: number | null; paginas: number | null; sha256: string | null; omitido: string | null };

/** Una base guardada en el doc, con lo mínimo para usarla; null si la entrada no tiene esa forma. */
function baseDe(x: unknown): ArchivoBase | null {
  if (!x || typeof x !== "object") return null;
  const b = x as Record<string, unknown>;
  if (typeof b.id !== "string" || typeof b.url !== "string") return null;
  return {
    id: b.id, url: b.url, nombre: typeof b.nombre === "string" ? b.nombre : "", mime: "application/pdf",
    bytes: typeof b.bytes === "number" ? b.bytes : 0, sha256: typeof b.sha256 === "string" ? b.sha256 : null,
    paginas: typeof b.paginas === "number" ? b.paginas : null, subidoEn: typeof b.subidoEn === "string" ? b.subidoEn : "",
    tipo: (typeof b.tipo === "string" ? b.tipo : "otro") as TipoBase,
  };
}

/**
 * Analiza las bases de una licitación. `entrada` se vuelve a validar aquí aunque la ruta ya lo haya hecho:
 * este es el único sitio que baja archivos y gasta, y no puede depender de que quien llama acierte.
 */
export async function analizarBases(entrada: EntradaAnalisis, auth: { userId: string }, deps: DepsAnalisis): Promise<RespuestaAnalisis> {
  const ahora = deps.ahora ?? Date.now;
  const inicio = ahora();
  const v = validarEntradaAnalisis(entrada);
  if (!v.ok) return falla(v.codigo, v.error);
  const { licitacion_id: licId, archivo_ids: ids, texto, estimar } = v.entrada;
  const db = deps.db;
  const base = deps.base === undefined ? baseSupabase() : deps.base;

  // 1 · La licitación y sus bases, de LA FILA (nunca del cuerpo).
  const lec = await db.from("licitaciones").select("id, bases:doc->bases").eq("id", licId).maybeSingle();
  if (lec.error) {
    if (tablaFaltante(lec.error as ErrorSupabase, "licitaciones")) return sinMigracion();
    throw new Error(`No se pudo leer la licitación ${licId}: ${lec.error.message}`);
  }
  if (!lec.data) return falla("entrada_invalida", `La licitación ${licId} no existe (o se borró).`);
  const guardadas = (Array.isArray((lec.data as { bases?: unknown }).bases) ? (lec.data as { bases: unknown[] }).bases : [])
    .map(baseDe).filter((b): b is ArchivoBase => !!b);

  // 2 · Cada archivo pedido: de esta licitación, del bucket privado y con la forma exacta de una base PDF.
  const elegidas: { base: ArchivoBase; ruta: string }[] = [];
  const reBase = RE_RUTA_BASE(licId);
  for (const id of ids) {
    const b = guardadas.find((g) => g.id === id);
    if (!b) return falla("archivo_ajeno", "Uno de los archivos elegidos no está entre las bases de esta licitación. Recarga la página y vuelve a elegirlos.");
    const obj = objetoPrivadoDe(b.url, base);
    if (!obj || obj.bucket !== BUCKET_LICITACIONES || !obj.ruta.startsWith(`bases/${licId}/`)) {
      return falla("archivo_ajeno", `«${b.nombre || "archivo"}» no es una base subida a esta licitación: vuelve a subirlo desde el paso «Bases».`);
    }
    if (!reBase.test(obj.ruta)) {
      return falla("no_es_pdf", `«${b.nombre || "archivo"}» no es un PDF. La IA solo lee las bases en PDF.`);
    }
    elegidas.push({ base: b, ruta: obj.ruta });
  }
  const declarados = elegidas.reduce((s, e) => s + (e.base.bytes > 0 ? e.base.bytes : 0), 0);
  if (declarados > TOPES_ANALISIS.maxBytesCrudos) {
    return falla("demasiado_grande", `Los archivos elegidos pesan ${mb(declarados)} MB: la IA lee como máximo ${mb(TOPES_ANALISIS.maxBytesCrudos)} MB por vez. Elige menos o sube solo las secciones de requisitos.`);
  }

  // 3 · Tope diario (también al estimar: que la persona sepa antes de esperar).
  const dia = inicioDiaLima(ahora());
  const cuenta = await db.from("licitacion_analisis").select("id", { count: "exact", head: true })
    .gte("creado_en", dia.iso).or("estado.eq.en_curso,tokens_entrada.not.is.null");
  if (cuenta.error) {
    if (tablaFaltante(cuenta.error as ErrorSupabase, "licitacion_analisis")) return sinMigracion();
    throw new Error(`No se pudo contar los análisis de hoy: ${cuenta.error.message}`);
  }
  if ((cuenta.count ?? 0) >= TOPES_ANALISIS.porDia) {
    const seg = Math.max(60, Math.ceil((dia.ms + 86_400_000 - ahora()) / 1000));
    return falla("tope_diario", `Ya se hicieron ${TOPES_ANALISIS.porDia} lecturas con IA hoy (el tope diario de la instalación). Se puede volver a leer desde las 00:00.`, seg);
  }

  // 4 · Candado (solo para analizar): se cierran los «en curso» colgados y se toma uno nuevo.
  let filaId: number | null = null;
  let cerrada = false;
  let cierre: { estado: "listo" | "error"; patch: Record<string, unknown> } = { estado: "error", patch: { error: "El análisis se interrumpió antes de terminar." } };
  const archivosFila: FilaArchivo[] = elegidas.map((e) => ({ id: e.base.id, nombre: e.base.nombre, tipo: e.base.tipo, bytes: null, paginas: null, sha256: null, omitido: null }));
  const textoSha = texto ? sha256(texto) : null;

  if (!estimar) {
    const corte = new Date(ahora() - TOPES_ANALISIS.candadoMs).toISOString();
    const exp = await db.from("licitacion_analisis")
      .update({ estado: "error", error: "Se cortó sin terminar (el servidor no respondió a tiempo).", terminado_en: new Date(ahora()).toISOString() })
      .eq("licitacion_id", licId).eq("estado", "en_curso").lt("creado_en", corte);
    if (exp.error) {
      if (tablaFaltante(exp.error as ErrorSupabase, "licitacion_analisis")) return sinMigracion();
      throw new Error(`No se pudo liberar el candado del análisis: ${exp.error.message}`);
    }
    const ins = await db.from("licitacion_analisis")
      .insert({ licitacion_id: licId, estado: "en_curso", usuario_id: auth.userId, modelo: MODELO_ANALISIS, archivos: archivosFila, texto_sha256: textoSha })
      .select("id").single();
    if (ins.error) {
      if ((ins.error as { code?: string }).code === "23505") {
        return falla("en_curso", "Ya hay una lectura con IA en curso para esta licitación. Espera a que termine (puede tardar unos minutos).", 60);
      }
      if (tablaFaltante(ins.error as ErrorSupabase, "licitacion_analisis")) return sinMigracion();
      throw new Error(`No se pudo registrar el análisis: ${ins.error.message}`);
    }
    filaId = Number((ins.data as { id: unknown }).id);
  }

  const cerrar = async () => {
    if (filaId === null || cerrada) return;
    cerrada = true;
    const patch: Record<string, unknown> = { estado: cierre.estado, archivos: archivosFila, terminado_en: new Date(ahora()).toISOString(), ...cierre.patch };
    if (typeof patch.error === "string") patch.error = Array.from(patch.error).slice(0, 1000).join("");
    const r = await db.from("licitacion_analisis").update(patch).eq("id", filaId);
    if (r.error) console.error(`[licitaciones/analizar] no se pudo cerrar el análisis ${filaId}:`, r.error.message);
  };
  const fallar = (f: Falla): Falla => { cierre = { estado: "error", patch: { error: f.error } }; return f; };

  try {
    // 5 · Bajar y revisar cada PDF. Ningún fetch: Storage del proyecto, con la ruta ya validada.
    const avisos: AvisoAnalisis[] = [];
    const leidos: ArchivoLeido[] = [];
    let cifrados = 0, ilegibles = 0, sinBajar = 0, crudos = 0;
    for (let i = 0; i < elegidas.length; i++) {
      const { base: b, ruta } = elegidas[i];
      const nombre = b.nombre || "archivo";
      let bytes: Uint8Array;
      try {
        bytes = await deps.descargar(BUCKET_LICITACIONES, ruta);
      } catch (e) {
        console.error(`[licitaciones/analizar] no se pudo bajar ${ruta}:`, (e as Error)?.message);
        sinBajar++;
        archivosFila[i].omitido = "no_descargado";
        avisos.push({ codigo: "archivo_omitido", detalle: `«${nombre}» no se pudo bajar del almacenamiento; no se leyó.` });
        continue;
      }
      archivosFila[i].bytes = bytes.length;
      archivosFila[i].sha256 = sha256(bytes);
      crudos += bytes.length;
      if (bytes.length > TOPES_ANALISIS.maxBytesCrudos || crudos > TOPES_ANALISIS.maxBytesCrudos) {
        return fallar(falla("demasiado_grande", `Los archivos elegidos pesan más de ${mb(TOPES_ANALISIS.maxBytesCrudos)} MB, el máximo que la IA lee por vez. Elige menos o sube solo las secciones de requisitos.`));
      }
      if (!parecePdf(bytes)) {
        return fallar(falla("no_es_pdf", `«${nombre}» no es un PDF (el archivo no empieza como uno). Vuelve a subirlo exportado a PDF.`));
      }
      let paginas: number;
      try {
        const pdf = await PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: ParseSpeeds.Fastest });
        paginas = pdf.getPageCount();
      } catch (e) {
        if (esCifrado(e, bytes)) {
          cifrados++;
          archivosFila[i].omitido = "pdf_protegido";
          avisos.push({ codigo: "archivo_omitido", detalle: `«${nombre}» está protegido (cifrado o con contraseña); no se leyó. Sube una copia sin protección.` });
        } else {
          ilegibles++;
          archivosFila[i].omitido = "pdf_ilegible";
          avisos.push({ codigo: "archivo_omitido", detalle: `«${nombre}» está dañado o no se pudo abrir como PDF; no se leyó.` });
        }
        continue;
      }
      archivosFila[i].paginas = paginas;
      leidos.push({ base: b, ruta, bytes, paginas, sha: archivosFila[i].sha256! });
    }

    if (!leidos.length && !texto) {
      if (cifrados && cifrados === elegidas.length) {
        return fallar(falla("pdf_protegido", elegidas.length === 1
          ? "El PDF elegido está protegido (cifrado o con contraseña): la IA no puede leerlo. Sube una copia sin protección."
          : "Todos los PDF elegidos están protegidos (cifrados o con contraseña): la IA no puede leerlos. Sube copias sin protección."));
      }
      if (ilegibles && !sinBajar && !cifrados) return fallar(falla("no_es_pdf", "Ninguno de los archivos elegidos se pudo abrir como PDF. Vuelve a subirlos."));
      return fallar(falla("sin_archivos", `No quedó ningún archivo que leer: ${avisos.map((a) => a.detalle).join(" ")}`));
    }

    const paginas = leidos.reduce((s, a) => s + a.paginas, 0);
    if (paginas > TOPES_ANALISIS.maxPaginas) {
      return fallar(falla("demasiadas_paginas", `Los archivos elegidos suman ${paginas} páginas: la IA lee como máximo ${TOPES_ANALISIS.maxPaginas} por vez. Elige menos archivos o sube solo las secciones de requisitos.`));
    }

    // 6 · La petición. El tope de 32 MB de la API cuenta el base64, no los bytes crudos.
    const paraModelo: ArchivoParaModelo[] = leidos.map((a, i) => ({
      etiqueta: etiquetaArchivo(i), nombre: a.base.nombre, tipo: a.base.tipo, paginas: a.paginas, base64: Buffer.from(a.bytes).toString("base64"),
    }));
    const pesoPeticion = paraModelo.reduce((s, a) => s + a.base64.length, 0) + Buffer.byteLength(texto ?? "", "utf8");
    if (pesoPeticion > TOPES_ANALISIS.maxBytesPeticion) {
      return fallar(falla("demasiado_grande", `La petición pesaría ${mb(pesoPeticion)} MB (los PDF van codificados en base64, que pesa un tercio más): el máximo es ${mb(TOPES_ANALISIS.maxBytesPeticion)} MB. Elige menos archivos.`));
    }
    const params = parametrosAnalisis(contenidoAnalisis(paraModelo, texto));
    const enviados = leidos.map((a) => ({ id: a.base.id, nombre: a.base.nombre }));

    // 7 · Contar tokens (no se cobra). Un error de la API aquí es un error del modelo, no del servidor.
    let tokensEntrada: number;
    try {
      tokensEntrada = await deps.contarTokens(parametrosConteo(params));
    } catch (e) {
      console.error("[licitaciones/analizar] count_tokens falló:", (e as Error)?.message);
      return fallar(errorDelModelo(e, false, 0));
    }
    if (!Number.isFinite(tokensEntrada) || tokensEntrada <= 0) {
      return fallar(falla("error_modelo", "No se pudo contar el tamaño de la petición. Vuelve a intentarlo en un momento."));
    }
    if (tokensEntrada > TOPES_ANALISIS.maxTokensEntrada) {
      return fallar(falla("demasiados_tokens", `Los archivos suman ${tokensEntrada.toLocaleString("es-PE")} tokens: el máximo que se lee por vez es ${TOPES_ANALISIS.maxTokensEntrada.toLocaleString("es-PE")}. Elige menos archivos.`));
    }
    if (estimar) {
      return { ok: true, modo: "estimacion", tokensEntrada, paginas, costoUsdMax: costoUsd(tokensEntrada, TOPES_ANALISIS.maxTokensSalida) };
    }

    // 8 · Llamar al modelo. Desde aquí el análisis CUENTA para el tope diario (tokens_entrada no nulo).
    const restante = TOPES_ANALISIS.plazoTotalMs - (ahora() - inicio);
    const plazo = Math.min(deps.plazoModeloMs ?? TOPES_ANALISIS.plazoModeloMs, restante);
    if (plazo < Math.min(TOPES_ANALISIS.minPlazoModeloMs, deps.plazoModeloMs ?? Infinity)) {
      return fallar(falla("error_modelo", "Se agotó el tiempo preparando los archivos antes de poder leerlos. Elige menos archivos y vuelve a intentarlo."));
    }
    const marca = await db.from("licitacion_analisis").update({ tokens_entrada: tokensEntrada }).eq("id", filaId!);
    if (marca.error) throw new Error(`No se pudo registrar el inicio del análisis: ${marca.error.message}`);

    const control = new AbortController();
    const reloj = setTimeout(() => control.abort(), plazo);
    let msg: MensajeFinal;
    try {
      msg = await deps.crear(params, control.signal);
    } catch (e) {
      console.error("[licitaciones/analizar] el modelo falló:", statusDe(e), (e as Error)?.message);
      return fallar(errorDelModelo(e, control.signal.aborted, Math.round(plazo / 1000)));
    } finally {
      clearTimeout(reloj);
    }

    const uso = {
      tokensEntrada: msg.usage?.input_tokens ?? tokensEntrada,
      tokensSalida: msg.usage?.output_tokens ?? 0,
      costoUsd: msg.usage ? costoUsd(msg.usage.input_tokens, msg.usage.output_tokens) : null,
    };
    const patchUso = { tokens_entrada: uso.tokensEntrada, tokens_salida: msg.usage ? uso.tokensSalida : null, costo_usd: uso.costoUsd };
    const fallarPagado = (f: Falla): Falla => { cierre = { estado: "error", patch: { error: f.error, ...patchUso } }; return f; };

    if (msg.stop_reason === "refusal") {
      const cat = msg.stop_details?.category ? ` (motivo: ${msg.stop_details.category})` : "";
      return fallarPagado(falla("rechazo", `El modelo se negó a analizar estos archivos${cat}. Revisa que sean las bases del concurso; si lo son, prueba con menos archivos o pega el texto de los requisitos.`));
    }
    if (msg.stop_reason === "max_tokens") {
      return fallarPagado(falla("respuesta_cortada", "La respuesta del modelo se cortó por largo (las bases traen demasiados requisitos para una sola lectura). Lee los archivos de a uno, o solo las secciones de requisitos."));
    }
    const textoRespuesta = msg.content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
    let json: unknown;
    try {
      json = JSON.parse(textoRespuesta);
    } catch {
      const i = textoRespuesta.indexOf("{"), f = textoRespuesta.lastIndexOf("}");
      try { json = i >= 0 && f > i ? JSON.parse(textoRespuesta.slice(i, f + 1)) : undefined; } catch { json = undefined; }
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return fallarPagado(falla("respuesta_ilegible", "La respuesta del modelo no se pudo leer como el formato esperado. Vuelve a intentarlo; si se repite, avisa a soporte."));
    }

    // 9 · Normalizar y guardar.
    const { resultado, avisos: avisosLectura } = leerAnalisisBases(json, enviados);
    const todos = [...avisos, ...avisosLectura];
    cierre = { estado: "listo", patch: { resultado, avisos: todos, ...patchUso, error: null } };
    await cerrar();
    return { ok: true, modo: "analisis", analisisId: filaId!, resultado, avisos: todos, uso };
  } finally {
    await cerrar();
  }
}

// Re-exportado para que la ruta no tenga que conocer el módulo puro.
export { MODELO_ANALISIS };
export type { FilaArchivo };
