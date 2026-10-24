// app/api/licitaciones/analizar/route.ts
// POST — Lee las BASES / TDR de una licitación con Claude y devuelve una PROPUESTA (requisitos con su
// regla, datos del concurso, consultas absueltas, estructura, penalidades, criterios). La IA propone;
// la persona acepta ítem por ítem en /licitaciones/[id] → Bases. Con `estimar: true` solo cuenta los
// tokens y devuelve el costo máximo, sin llamar al modelo ni dejar registro.
//
// Cuerpo: { licitacion_id: number, archivo_ids: string[], texto: string | null, estimar: boolean }.
// Son IDS de `licitaciones.doc.bases`: el servidor baja los PDF de la fila, nunca de una URL del cuerpo.
//
// Capas, en orden: mismo origen → sesión del ERP con el módulo «licitaciones» → tasa por usuario (en
// memoria, por instancia: 3 análisis cada 10 min; las estimaciones aparte, 20 cada 10 min) → clave de
// Anthropic → analizarBases (tope diario de la instalación y candado en la base).
//
// Respuestas (el cuerpo es SIEMPRE JSON; la pantalla decide por `ok` y `codigo`, no por el estado HTTP):
//   200 { ok:true, modo:"estimacion", tokensEntrada, paginas, costoUsdMax }
//   200 { ok:true, modo:"analisis", analisisId, resultado, avisos, uso }
//   200 { ok:false, codigo, error, reintentarEnSeg? }  — los errores esperados
//   400 entrada_invalida · 401/403 sin_permiso · 403 origen · 409 en_curso · 429 tasa (con Retry-After)
//   500 { ok:false, codigo:"error_interno", error }   — lo inesperado; el detalle va solo al log

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { guardarGasto, limitarTasa, segundosParaReintentar } from "@/lib/api-guard";
import { mensajeSeguro } from "@/lib/mensaje-seguro";
import { TOPES_ANALISIS, validarEntradaAnalisis, type RespuestaRutaAnalisis } from "@/lib/licitaciones/analisis";
import { analizarBases, type DepsAnalisis } from "@/lib/licitaciones/analisis-datos";
import type { CodigoErrorAnalisis } from "@/lib/licitaciones/tipos";

// El modelo tiene 280 s; el resto es para bajar los PDF y guardar el resultado. (Un POST nunca se cachea:
// no hace falta `dynamic`, que Next 16 retira con Cache Components.)
export const maxDuration = 300;

/** Estado HTTP de cada error esperado; los que no están van en 200 (la pantalla lee el cuerpo). */
const ESTADO_HTTP: Partial<Record<CodigoErrorAnalisis, number>> = { entrada_invalida: 400, en_curso: 409 };

const GENERICO = "No se pudieron leer las bases por un error del servidor. Vuelve a intentarlo en un momento.";

let anthropic: Anthropic | null = null;
const clienteAnthropic = (): Anthropic => (anthropic ??= new Anthropic());

const responder = (cuerpo: RespuestaRutaAnalisis, status = 200, headers?: Record<string, string>) =>
  NextResponse.json(cuerpo, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function POST(req: NextRequest) {
  // Desde otro sitio, no (un POST cross-origin lo delata el Origin).
  if (guardarGasto(req, { etiqueta: "licitaciones-analizar" })) {
    return responder({ ok: false, codigo: "origen", error: "Origen no permitido." }, 403);
  }

  // Gasta tokens de Claude y lee archivos de licitaciones: solo quien tiene el módulo.
  const auth = await verificarUsuarioApi(req, "licitaciones");
  if (!auth.ok) return responder({ ok: false, codigo: "sin_permiso", error: auth.error }, auth.status);

  let cuerpo: unknown;
  try { cuerpo = await req.json(); } catch { cuerpo = null; }
  const v = validarEntradaAnalisis(cuerpo);
  if (!v.ok) return responder({ ok: false, codigo: v.codigo, error: v.error }, v.codigo === "entrada_invalida" ? 400 : 200);

  // Freno por usuario. Estimar no llama al modelo: va en su propia cubeta para no comerse los análisis.
  const estimar = v.entrada.estimar;
  const clave = `${estimar ? "lic-estimar" : "lic-analizar"}:${auth.userId}`;
  const limite = estimar ? TOPES_ANALISIS.estimacionesPorUsuario : TOPES_ANALISIS.porUsuario;
  if (!limitarTasa(clave, limite, TOPES_ANALISIS.ventanaUsuarioMs)) {
    const seg = Math.max(1, segundosParaReintentar(clave));
    const min = Math.ceil(seg / 60);
    const ventana = Math.round(TOPES_ANALISIS.ventanaUsuarioMs / 60_000);
    return responder(
      { ok: false, codigo: "tasa", error: `Hiciste ${limite} ${estimar ? "estimaciones" : "lecturas con IA"} en ${ventana} minutos: vuelve a intentarlo en ${min} min.`, reintentarEnSeg: seg },
      429, { "Retry-After": String(seg) },
    );
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return responder({ ok: false, codigo: "sin_clave", error: "Falta ANTHROPIC_API_KEY en el servidor (Vercel → Environment Variables): sin ella no se pueden leer las bases con IA." });
  }

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const deps: DepsAnalisis = {
    db: sb,
    descargar: async (bucket, ruta) => {
      const { data, error } = await sb.storage.from(bucket).download(ruta);
      if (error || !data) throw new Error(`Storage no entregó ${bucket}/${ruta}: ${error?.message ?? "sin datos"}`);
      return new Uint8Array(await data.arrayBuffer());
    },
    contarTokens: async (params) => (await clienteAnthropic().messages.countTokens(params)).input_tokens,
    crear: (params, señal) => clienteAnthropic().messages.stream(params, { signal: señal }).finalMessage(),
  };

  try {
    const r = await analizarBases(v.entrada, { userId: auth.userId }, deps);
    if (r.ok) return responder(r);
    const status = ESTADO_HTTP[r.codigo] ?? 200;
    const headers: Record<string, string> | undefined = r.reintentarEnSeg && status !== 200 ? { "Retry-After": String(r.reintentarEnSeg) } : undefined;
    return responder(r, status, headers);
  } catch (e) {
    console.error("[api/licitaciones/analizar] error inesperado:", e);
    return responder({ ok: false, codigo: "error_interno", error: mensajeSeguro(e, { propios: /^(?!)/, generico: GENERICO }) }, 500);
  }
}
