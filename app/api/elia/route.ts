// ============================================================
// POST /api/elia — Conversación con ELIA (streaming SSE).
// Bucle agéntico: Claude decide qué herramientas usar; cada delta de
// texto, cada herramienta y cada bloque visual se emite como evento SSE.
// ============================================================
import Anthropic from "@anthropic-ai/sdk";
import { autenticarElia } from "@/lib/elia/auth";
import {
  ejecutarToolElia,
  toolsPermitidas,
  ETIQUETA_TOOL,
  type CtxElia,
} from "@/lib/elia/herramientas";
import { PROMPT_ELIA, contextoDinamico } from "@/lib/elia/prompt";
import type { EventoElia, MensajeHistorial } from "@/lib/elia/tipos";

export const maxDuration = 60;

const MODELO = "claude-opus-4-8";
const MAX_ITERACIONES = 6;
const MAX_HISTORIAL = 20;

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return respuestaError("ELIA no está configurada todavía (falta la clave del servicio de IA).", 503);
  }

  const auth = await autenticarElia(request);
  if (!auth.ok) return respuestaError(auth.error, auth.status);
  const { usuario } = auth;

  let body: { mensajes?: MensajeHistorial[]; pagina?: string };
  try {
    body = await request.json();
  } catch {
    return respuestaError("Cuerpo inválido", 400);
  }

  const historial = (body.mensajes ?? []).slice(-MAX_HISTORIAL);
  if (historial.length === 0 || historial[historial.length - 1].rol !== "usuario") {
    return respuestaError("Falta el mensaje del usuario", 400);
  }

  const anthropic = new Anthropic();
  const tools = toolsPermitidas(usuario.permisos, usuario.rol);
  const system: any[] = [
    { type: "text", text: PROMPT_ELIA, cache_control: { type: "ephemeral" } },
    {
      type: "text",
      text: contextoDinamico({
        nombre: usuario.nombre,
        rol: usuario.rol,
        permisos: usuario.permisos,
        pagina: body.pagina,
      }),
    },
  ];

  // Historial cliente → mensajes Anthropic (solo texto; los bloques viven en el panel)
  const messages: any[] = historial
    .map((m) => ({ role: m.rol === "usuario" ? "user" : "assistant", content: m.texto }))
    .filter((m) => typeof m.content === "string" && m.content.trim().length > 0);
  while (messages.length && messages[0].role !== "user") messages.shift();

  const ctx: CtxElia = {
    sb: usuario.sb,
    permisos: usuario.permisos,
    rol: usuario.rol,
    nombreUsuario: usuario.nombre,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emitir = (ev: EventoElia) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));

      try {
        for (let iter = 0; iter < MAX_ITERACIONES; iter++) {
          const claudeStream = anthropic.messages.stream({
            model: MODELO,
            max_tokens: 8000,
            system,
            tools,
            messages,
            thinking: { type: "adaptive" },
            output_config: { effort: "low" },
          } as any);

          claudeStream.on("text", (delta: string) => emitir({ t: "texto", d: delta }));

          const msg: any = await claudeStream.finalMessage();
          const toolUses = (msg.content ?? []).filter((b: any) => b.type === "tool_use");

          if (msg.stop_reason !== "tool_use" || toolUses.length === 0) break;

          // Conservar el contenido completo (incluye bloques thinking) para el siguiente turno
          messages.push({ role: "assistant", content: msg.content });

          const resultados: any[] = [];
          for (const tu of toolUses) {
            emitir({ t: "tool", d: { nombre: tu.name, etiqueta: ETIQUETA_TOOL[tu.name] ?? "Consultando…" } });
            const r = await ejecutarToolElia(tu.name, tu.input, ctx);
            for (const bloque of Array.isArray(r.ui) ? r.ui : r.ui ? [r.ui] : []) emitir({ t: "ui", d: bloque });
            resultados.push({ type: "tool_result", tool_use_id: tu.id, content: r.paraModelo });
          }
          messages.push({ role: "user", content: resultados });
        }

        emitir({ t: "fin", d: null });
      } catch (e: any) {
        emitir({
          t: "error",
          d: "Uy, tuve un problema al procesar tu consulta. ¿Me la repites en un momento? (" + (e?.message ?? "error") + ")",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function respuestaError(mensaje: string, status: number) {
  return new Response(JSON.stringify({ error: mensaje }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
