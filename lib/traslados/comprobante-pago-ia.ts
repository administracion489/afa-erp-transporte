// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/comprobante-pago-ia.ts — EL LECTOR del comprobante de pago que manda el cliente por
// el chat: un modelo de visión en un EXTRACTOR APARTE del agente. SOLO SERVIDOR.
//
// LAS REGLAS QUE NO SE AFLOJAN:
//  1. SOLO VE LA IMAGEN O EL PDF. Ningún texto del chat, ninguna instrucción del agente, ningún
//     monto esperado: el prompt es `PROMPT_COMPROBANTE` (lib/traslados/comprobante-pago.ts, sin una
//     sola cifra). Un número en el prompt es un número que el modelo copia cuando no logra leer la
//     foto; el monto esperado entra solo al COTEJO, en el código.
//  2. LA RESPUESTA ES TEXTO NO CONFIABLE (la imagen la eligió el cliente): se normaliza con
//     `leerRespuestaComprobante` y nada de eso se interpreta como una orden. Una respuesta rota, un
//     rechazo del modelo o un archivo que no se pudo bajar son «sin lectura», nunca un pago.
//  3. EL MODELO ES EL DEL AGENTE (`crm_agentes_ia.modelo`, validado contra la misma lista que usa
//     lib/crm-ia.ts). Sin pensamiento extendido ni parámetros de muestreo: es una transcripción.
//  4. LA LECTURA ES EVIDENCIA, NUNCA AUTORIZA: el adelanto lo registra una persona de Tesorería al
//     ver el dinero en el banco.
// ──────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { BUCKET_CRM_MEDIA, bloqueParaIA } from "@/lib/crm-media";
import { PROMPT_COMPROBANTE, leerRespuestaComprobante, type LecturaComprobante } from "./comprobante-pago";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

/** Los modelos que acepta el agente (la misma lista de lib/crm-ia.ts). */
export const MODELOS_LECTOR = new Set(["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]);
export const MODELO_LECTOR_DEFECTO = "claude-opus-4-8";

/** El modelo con que se lee: el del agente si es uno de los aceptados; si no, el de siempre. */
export const modeloLector = (modeloAgente: unknown): string =>
  typeof modeloAgente === "string" && MODELOS_LECTOR.has(modeloAgente) ? modeloAgente : MODELO_LECTOR_DEFECTO;

/**
 * El PDF más grande que se manda a leer (el de las fotos sigue en 4.5 MB): un comprobante de banco
 * pesa unos KB, y un PDF de 10 MB son decenas de páginas que se pagan enteras al modelo. NO medido.
 * Solo para este lector: el resto del CRM sigue con su tope.
 */
export const MAX_PDF_LECTOR_BYTES = 2 * 1024 * 1024;

/** El archivo que se lee: solo del bucket del CRM (`crm-media`, donde el webhook guarda lo que manda el cliente). */
export const BUCKETS_LECTOR: readonly string[] = [BUCKET_CRM_MEDIA];

/** Lo único que acompaña a la imagen: una orden fija, sin datos de la conversación. */
export const PEDIDO_LECTOR = "Transcribe este comprobante con las claves indicadas. Responde solo con el objeto JSON.";

export type ResultadoLector =
  | { ok: true; lectura: LecturaComprobante | null; crudo: string }
  | { ok: false; codigo: "sin_archivo" | "sin_clave" | "error_modelo" | "rechazo"; detalle: string };

type Crear = (req: Record<string, unknown>) => Promise<{ content?: { type: string; text?: string }[]; stop_reason?: string | null }>;

/** Lo que se reemplaza en la matriz para correr sin red. */
export type DepsLector = {
  /** El bloque de imagen o documento del archivo (por defecto `bloqueParaIA`, del bucket privado). */
  bloque?: (sb: Sb, url: string) => Promise<unknown | null>;
  /** `anthropic.messages.create`. */
  crear?: Crear;
};

let cliente: Anthropic | null = null;
const crearPorDefecto: Crear = async (req) => {
  cliente ??= new Anthropic();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await cliente.messages.create(req as any)) as any;
};

/**
 * Lee el comprobante del mensaje (`mediaUrl`, el identificador del archivo en `crm-media`). Nunca
 * lanza: cualquier fallo vuelve con su código, y quien llama lo trata como «no se pudo leer».
 */
export async function leerComprobantePago(sb: Sb, mediaUrl: string | null | undefined, x: { modelo?: unknown } = {}, deps: DepsLector = {}): Promise<ResultadoLector> {
  if (!deps.crear && !process.env.ANTHROPIC_API_KEY) return { ok: false, codigo: "sin_clave", detalle: "Falta ANTHROPIC_API_KEY en el entorno." };
  const url = String(mediaUrl ?? "").trim();
  if (!url) return { ok: false, codigo: "sin_archivo", detalle: "El mensaje no trae archivo." };
  let bloque: unknown | null = null;
  try {
    bloque = await (deps.bloque ?? ((s: Sb, u: string) => bloqueParaIA(s, u, { buckets: BUCKETS_LECTOR, maxPdfBytes: MAX_PDF_LECTOR_BYTES })))(sb, url);
  } catch { bloque = null; }
  if (!bloque) return { ok: false, codigo: "sin_archivo", detalle: "No se pudo bajar el comprobante (no está en el almacenamiento del CRM, no es una imagen ni un PDF, o el PDF pasa de 2 MB)." };
  try {
    const resp = await (deps.crear ?? crearPorDefecto)({
      model: modeloLector(x.modelo),
      max_tokens: 1024,
      system: PROMPT_COMPROBANTE,
      messages: [{ role: "user", content: [bloque, { type: "text", text: PEDIDO_LECTOR }] }],
    });
    if (resp?.stop_reason === "refusal") return { ok: false, codigo: "rechazo", detalle: "El modelo no quiso leer el archivo." };
    const crudo = (resp?.content ?? []).filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("\n").slice(0, 8000);
    return { ok: true, lectura: leerRespuestaComprobante(crudo), crudo };
  } catch (e) {
    return { ok: false, codigo: "error_modelo", detalle: String((e as Error)?.message ?? e).slice(0, 300) };
  }
}
