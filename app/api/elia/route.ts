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
import {
  cargarConfigElia,
  registrarUsoElia,
  extrasModelo,
  acumularUso,
  usoVacio,
} from "@/lib/elia/config";
import { PROMPT_ELIA, contextoDinamico } from "@/lib/elia/prompt";
import type { EventoElia, MensajeHistorial } from "@/lib/elia/tipos";

export const maxDuration = 60;

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

  // ── Configuración: encendido, modelo y límite de presupuesto mensual
  const config = await cargarConfigElia(usuario.sb);
  if (!config.activa) {
    return respuestaSSEUnica(
      "Ahora mismo estoy **desactivada por el administrador**. Si necesitas que vuelva, pídele que me encienda en Configuración → ELIA. 🙏"
    );
  }
  if (config.limiteMensualUsd > 0 && config.gastoMes >= config.limiteMensualUsd) {
    return respuestaSSEUnica(
      `Llegué al **límite de presupuesto de este mes** (US$ ${config.limiteMensualUsd.toFixed(0)}), así que voy a descansar hasta el próximo mes para cuidar los costos. ` +
        `Si me necesitas antes, un administrador puede ampliar el límite en **Configuración → ELIA**.`
    );
  }
  const MODELO = config.modelo;

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

      const uso = usoVacio();
      try {
        for (let iter = 0; iter < MAX_ITERACIONES; iter++) {
          const claudeStream = anthropic.messages.stream({
            model: MODELO,
            max_tokens: 8000,
            system,
            tools,
            messages,
            ...extrasModelo(MODELO),
          } as any);

          claudeStream.on("text", (delta: string) => emitir({ t: "texto", d: delta }));

          const msg: any = await claudeStream.finalMessage();
          acumularUso(uso, msg.usage);
          const toolUses = (msg.content ?? []).filter((b: any) => b.type === "tool_use");

          if (msg.stop_reason !== "tool_use" || toolUses.length === 0) break;

          // Conservar el contenido completo (incluye bloques thinking) para el siguiente turno
          messages.push({ role: "assistant", content: msg.content });

          const resultados: any[] = [];
          for (const tu of toolUses) {
            uso.herramientas++;
            emitir({ t: "tool", d: { nombre: tu.name, etiqueta: ETIQUETA_TOOL[tu.name] ?? "Consultando…" } });
            const r = await ejecutarToolElia(tu.name, tu.input, ctx);
            for (const bloque of Array.isArray(r.ui) ? r.ui : r.ui ? [r.ui] : []) emitir({ t: "ui", d: bloque });
            resultados.push({ type: "tool_result", tool_use_id: tu.id, content: r.paraModelo });
          }
          messages.push({ role: "user", content: resultados });
        }

        emitir({ t: "fin", d: null });
        await registrarUsoElia(usuario.sb, {
          usuarioId: usuario.usuarioId,
          usuarioNombre: usuario.nombre,
          modelo: MODELO,
          uso,
        });
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

/** Respuesta SSE de un solo mensaje (ELIA apagada o límite alcanzado): no llama al modelo, costo cero. */
function respuestaSSEUnica(texto: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ t: "texto", d: texto })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ t: "fin", d: null })}\n\n`));
      controller.close();
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
