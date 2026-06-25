// ============================================================
// Agente IA del CRM — Claude (Anthropic)
// Motor conversacional con tool-use contra el ERP real.
// SOLO servidor: usa ANTHROPIC_API_KEY + service-role de Supabase.
// ============================================================
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { enviarWhatsApp, enviarMessenger, enviarInstagram } from "@/lib/crm-meta";
import { enviarEmail } from "@/lib/crm-gmail";

const anthropic = new Anthropic(); // lee ANTHROPIC_API_KEY del entorno

const db = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

type SB = ReturnType<typeof db>;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Últimos 9 dígitos (móviles Perú) para emparejar teléfonos guardados con distinto formato
const tel9 = (s?: string | null) => (s ?? "").replace(/\D/g, "").slice(-9);

// Hora actual en Lima (UTC-5), formato "HH:MM"
function horaLima(): string {
  const ahora = new Date();
  const lima = new Date(ahora.getTime() - 5 * 3600 * 1000);
  return lima.toISOString().slice(11, 16);
}

function dentroHorario(agente: any): boolean {
  if (!agente?.horario_activo) return true;
  const h = horaLima();
  const ini = agente.hora_inicio ?? "08:00";
  const fin = agente.hora_fin ?? "20:00";
  return h >= ini && h <= fin;
}

// Parámetros extra según el modelo (effort/thinking no existen en Haiku)
function modelExtras(modelo: string): Record<string, unknown> {
  if (!modelo || modelo.startsWith("claude-haiku")) return {};
  return { thinking: { type: "adaptive" }, output_config: { effort: "low" } };
}

const MODELOS_VALIDOS = new Set(["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]);

// ── Definición de herramientas (lo que Claude puede hacer) ───────────────────

const TOOLS = [
  {
    name: "buscar_servicios",
    description:
      "Consulta los servicios/viajes (reservas) del cliente actual o por filtros. Úsala cuando el cliente pregunte por el estado de su servicio, a qué hora pasa el bus, qué unidad o conductor le asignaron, o el historial. Si no se pasa reserva_id, busca por el teléfono/correo del contacto actual.",
    input_schema: {
      type: "object",
      properties: {
        reserva_id: { type: "integer", description: "ID exacto del servicio si el cliente lo menciona." },
        fecha: { type: "string", description: "Filtrar por fecha YYYY-MM-DD (opcional)." },
        estado: {
          type: "string",
          enum: ["programada", "confirmada", "en_curso", "finalizada", "cancelada"],
          description: "Filtrar por estado (opcional).",
        },
      },
    },
  },
  {
    name: "cotizacion_estimada",
    description:
      "Devuelve un rango de precio REFERENCIAL basado en el histórico real de cotizaciones y servicios de AFA para una ruta. Úsala cuando tengas al menos origen y destino. Siempre aclara al cliente que es un estimado y que el equipo confirma el precio final. Precios en PEN, sin IGV.",
    input_schema: {
      type: "object",
      properties: {
        origen: { type: "string", description: "Punto de partida." },
        destino: { type: "string", description: "Destino." },
        tipo_vehiculo: { type: "string", description: "BUS, MINIBUS, VAN, AUTO (opcional)." },
      },
      required: ["origen", "destino"],
    },
  },
  {
    name: "consultar_flota",
    description:
      "Lista los tipos de vehículo y capacidades disponibles (flota propia y de terceros). Úsala para responder si AFA tiene un bus de X asientos o qué unidades maneja.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "actualizar_contacto",
    description:
      "Guarda/actualiza los datos del contacto en el CRM cuando el cliente los proporcione (nombre, empresa, correo, teléfono). Llama esto en cuanto conozcas un dato nuevo.",
    input_schema: {
      type: "object",
      properties: {
        nombre: { type: "string" },
        empresa: { type: "string" },
        email: { type: "string" },
        telefono: { type: "string" },
      },
    },
  },
  {
    name: "registrar_lead",
    description:
      "Registra o actualiza la oportunidad de venta (pipeline) con lo que califiques del cliente: etapa, n.º de trabajadores/pasajeros, descripción de rutas, frecuencia y monto estimado. Úsala para no perder el lead.",
    input_schema: {
      type: "object",
      properties: {
        etapa: {
          type: "string",
          enum: ["nuevo_lead", "calificando", "cotizacion_enviada", "negociacion"],
        },
        n_trabajadores: { type: "integer" },
        rutas_descripcion: { type: "string" },
        frecuencia: { type: "string", enum: ["diaria", "semanal", "mensual", "eventual"] },
        monto_estimado: { type: "number" },
        notas: { type: "string" },
      },
    },
  },
  {
    name: "proponer_cotizacion",
    description:
      "Crea una PROPUESTA de cotización que un humano del equipo debe aprobar antes de que exista. NO confirmas precios finales ni le digas al cliente que ya está cotizado: dile que el equipo confirmará en breve. Usa esto cuando el cliente quiera una cotización formal.",
    input_schema: {
      type: "object",
      properties: {
        origen: { type: "string" },
        destino: { type: "string" },
        fecha_servicio: { type: "string", description: "YYYY-MM-DD" },
        hora_ida: { type: "string", description: "HH:MM" },
        tipo_vehiculo: { type: "string" },
        tipo_servicio: { type: "string", description: "ej. solo_ida, ida_retorno, full_day" },
        precio_cliente: { type: "number", description: "Precio referencial estimado en PEN, sin IGV." },
        observaciones: { type: "string" },
      },
      required: ["origen", "destino"],
    },
  },
  {
    name: "proponer_reserva",
    description:
      "Crea una PROPUESTA de reserva/servicio que un humano debe aprobar. No le digas al cliente que ya está reservado: dile que se confirmará. Usa esto solo cuando el cliente quiera cerrar/agendar un servicio concreto.",
    input_schema: {
      type: "object",
      properties: {
        origen: { type: "string" },
        destino: { type: "string" },
        fecha_servicio: { type: "string", description: "YYYY-MM-DD" },
        hora_servicio: { type: "string", description: "HH:MM" },
        tipo: { type: "string", description: "ej. eventual, ida_retorno" },
        precio_cliente: { type: "number", description: "PEN, sin IGV (opcional)." },
        observaciones: { type: "string" },
      },
      required: ["origen", "destino", "fecha_servicio"],
    },
  },
  {
    name: "escalar_a_humano",
    description:
      "Pasa la conversación a un agente humano y pausa tu intervención. Úsala si el cliente lo pide, está molesto, hay un reclamo, contrato/licitación, o algo fuera de tu alcance. Tras llamarla, despídete indicando que un asesor continuará.",
    input_schema: {
      type: "object",
      properties: { motivo: { type: "string" } },
      required: ["motivo"],
    },
  },
];

// ── Ejecutor de herramientas ─────────────────────────────────────────────────

type Ctx = { sb: SB; contacto: any; conv: any; agente: any; escalado: { v: boolean } };

async function clientesDelContacto(sb: SB, contacto: any): Promise<number[]> {
  const ids = new Set<number>();
  if (contacto?.cliente_id) ids.add(contacto.cliente_id);
  const tel = tel9(contacto?.telefono || contacto?.wa_id);
  if (tel) {
    const { data } = await sb.from("clientes").select("id, telefono").not("telefono", "is", null);
    for (const c of data ?? []) if (tel9(c.telefono) === tel) ids.add(c.id);
  }
  if (contacto?.email) {
    const { data } = await sb.from("clientes").select("id").ilike("email", contacto.email);
    for (const c of data ?? []) ids.add(c.id);
  }
  return [...ids];
}

async function ejecutarTool(name: string, input: any, ctx: Ctx): Promise<string> {
  const { sb, contacto, conv } = ctx;
  try {
    switch (name) {
      case "buscar_servicios": {
        let q = sb
          .from("reservas")
          .select(
            "id, origen, destino, fecha_servicio, hora_servicio, estado, tipo, vehiculo_id, conductor_id, precio_cliente"
          );
        if (input.reserva_id) {
          q = q.eq("id", input.reserva_id);
        } else {
          const ids = await clientesDelContacto(sb, contacto);
          if (ids.length === 0)
            return JSON.stringify({ encontrados: 0, nota: "No hay cliente vinculado a este contacto. Pide el ID del servicio o sus datos." });
          q = q.in("cliente_id", ids);
        }
        if (input.fecha) q = q.eq("fecha_servicio", input.fecha);
        if (input.estado) q = q.eq("estado", input.estado);
        const { data } = await q.order("fecha_servicio", { ascending: false }).limit(8);
        const rows = data ?? [];
        // Enriquecer placa/conductor
        const vehIds = [...new Set(rows.map((r) => r.vehiculo_id).filter(Boolean))];
        const conIds = [...new Set(rows.map((r) => r.conductor_id).filter(Boolean))];
        const placas: Record<number, string> = {};
        const choferes: Record<number, string> = {};
        if (vehIds.length) {
          const { data: v } = await sb.from("vehiculos").select("id, placa").in("id", vehIds);
          for (const x of v ?? []) placas[x.id] = x.placa;
        }
        if (conIds.length) {
          const { data: c } = await sb.from("conductores").select("id, nombre, telefono").in("id", conIds);
          for (const x of c ?? []) choferes[x.id] = x.nombre;
        }
        return JSON.stringify({
          encontrados: rows.length,
          servicios: rows.map((r) => ({
            id: r.id,
            origen: r.origen,
            destino: r.destino,
            fecha: r.fecha_servicio,
            hora: r.hora_servicio,
            estado: r.estado,
            tipo: r.tipo,
            unidad: r.vehiculo_id ? placas[r.vehiculo_id] ?? null : null,
            conductor: r.conductor_id ? choferes[r.conductor_id] ?? null : null,
          })),
        });
      }

      case "cotizacion_estimada": {
        const precios: number[] = [];
        // 1) Cotizaciones históricas con ruta similar
        let cq = sb.from("cotizaciones").select("precio_cliente, origen, destino, tipo_vehiculo").not("precio_cliente", "is", null);
        if (input.origen) cq = cq.ilike("origen", `%${input.origen}%`);
        if (input.destino) cq = cq.ilike("destino", `%${input.destino}%`);
        if (input.tipo_vehiculo) cq = cq.ilike("tipo_vehiculo", `%${input.tipo_vehiculo}%`);
        const { data: cots } = await cq.limit(50);
        for (const c of cots ?? []) if (c.precio_cliente > 0) precios.push(Number(c.precio_cliente));
        // 2) Reservas reales con ruta similar (respaldo)
        let rq = sb.from("reservas").select("precio_cliente, origen, destino").not("precio_cliente", "is", null);
        if (input.origen) rq = rq.ilike("origen", `%${input.origen}%`);
        if (input.destino) rq = rq.ilike("destino", `%${input.destino}%`);
        const { data: res } = await rq.limit(50);
        for (const r of res ?? []) if (r.precio_cliente > 0) precios.push(Number(r.precio_cliente));

        if (precios.length === 0)
          return JSON.stringify({
            sin_historico: true,
            nota: "No hay precios históricos para esta ruta. Recoge los datos y propón una cotización para que el equipo la calcule.",
          });
        precios.sort((a, b) => a - b);
        const prom = precios.reduce((s, n) => s + n, 0) / precios.length;
        return JSON.stringify({
          muestras: precios.length,
          moneda: "PEN",
          incluye_igv: false,
          minimo: Math.round(precios[0]),
          maximo: Math.round(precios[precios.length - 1]),
          promedio: Math.round(prom),
          nota: "Rango REFERENCIAL basado en histórico. El precio final lo confirma el equipo.",
        });
      }

      case "consultar_flota": {
        const { data: propios } = await sb.from("vehiculos").select("categoria, capacidad_pasajeros");
        const { data: terceros } = await sb.from("vehiculos_tercero").select("categoria, capacidad");
        const acc: Record<string, { min: number; max: number; n: number }> = {};
        const add = (cat: string | null, cap: number | null) => {
          const k = (cat || "OTRO").toUpperCase();
          const c = Number(cap) || 0;
          if (!acc[k]) acc[k] = { min: c || 999, max: c, n: 0 };
          acc[k].n++;
          if (c) {
            acc[k].min = Math.min(acc[k].min, c);
            acc[k].max = Math.max(acc[k].max, c);
          }
        };
        for (const v of propios ?? []) add(v.categoria, v.capacidad_pasajeros);
        for (const v of terceros ?? []) add(v.categoria, v.capacidad);
        return JSON.stringify({
          flota: Object.entries(acc).map(([categoria, x]) => ({
            categoria,
            capacidad_min: x.min === 999 ? null : x.min,
            capacidad_max: x.max || null,
            unidades: x.n,
          })),
        });
      }

      case "actualizar_contacto": {
        const patch: any = {};
        for (const k of ["nombre", "empresa", "email", "telefono"]) if (input[k]) patch[k] = input[k];
        if (Object.keys(patch).length === 0) return JSON.stringify({ ok: false, nota: "Sin datos." });
        await sb.from("crm_contactos").update(patch).eq("id", contacto.id);
        Object.assign(ctx.contacto, patch);
        return JSON.stringify({ ok: true });
      }

      case "registrar_lead": {
        // Reusar pipeline existente de la conversación o crear uno
        let pipelineId = conv.pipeline_id as string | null;
        const fields: any = {
          contacto_id: contacto.id,
          empresa_nombre: contacto.empresa ?? null,
        };
        for (const k of ["etapa", "n_trabajadores", "rutas_descripcion", "frecuencia", "monto_estimado", "notas"])
          if (input[k] != null) fields[k] = input[k];
        if (pipelineId) {
          await sb.from("crm_pipeline").update(fields).eq("id", pipelineId);
        } else {
          const { data: p } = await sb
            .from("crm_pipeline")
            .insert({ etapa: input.etapa ?? "nuevo_lead", ...fields })
            .select("id")
            .single();
          if (p) {
            pipelineId = p.id;
            await sb.from("crm_conversaciones").update({ pipeline_id: p.id }).eq("id", conv.id);
          }
        }
        return JSON.stringify({ ok: true, pipeline_id: pipelineId });
      }

      case "proponer_cotizacion":
      case "proponer_reserva": {
        const tipo = name === "proponer_cotizacion" ? "cotizacion" : "reserva";
        const resumen =
          tipo === "cotizacion"
            ? `Cotización: ${input.origen} → ${input.destino}${input.fecha_servicio ? ` (${input.fecha_servicio})` : ""}${input.tipo_vehiculo ? ` · ${input.tipo_vehiculo}` : ""}${input.precio_cliente ? ` · ~S/${input.precio_cliente}` : ""}`
            : `Reserva: ${input.origen} → ${input.destino} · ${input.fecha_servicio ?? ""} ${input.hora_servicio ?? ""}`;
        await sb.from("crm_acciones_ia").insert({
          conversacion_id: conv.id,
          contacto_id: contacto.id,
          tipo,
          resumen,
          payload: input,
          estado: "pendiente",
        });
        return JSON.stringify({
          ok: true,
          estado: "pendiente_de_aprobacion",
          nota: "Propuesta registrada para revisión humana. Dile al cliente que el equipo confirmará en breve; NO afirmes que ya está cotizado/reservado.",
        });
      }

      case "escalar_a_humano": {
        await sb
          .from("crm_conversaciones")
          .update({ ia_pausada: true, estado: "en_progreso" })
          .eq("id", conv.id);
        ctx.escalado.v = true;
        return JSON.stringify({ ok: true, nota: "Conversación derivada a un humano y IA pausada en este hilo." });
      }

      default:
        return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
    }
  } catch (e: any) {
    return JSON.stringify({ error: e?.message ?? "Error ejecutando herramienta" });
  }
}

// ── System prompt construido desde la config del agente ──────────────────────

function construirSystem(agente: any, contacto: any, conv: any): string {
  const goals: { titulo: string; instrucciones: string }[] = Array.isArray(agente.goals) ? agente.goals : [];
  const goalsTxt = goals.length
    ? goals.map((g, i) => `${i + 1}. ${g.titulo}: ${g.instrucciones}`).join("\n")
    : "Atender al cliente con cordialidad y resolver su consulta.";

  return [
    agente.persona || "Eres el asistente comercial de AFA Transportes.",
    "",
    "## Sobre la empresa",
    agente.empresa_contexto || "AFA Transportes — operador de transporte en Perú.",
    "",
    "## Tus objetivos (goals)",
    goalsTxt,
    "",
    agente.conocimiento ? `## Base de conocimiento\n${agente.conocimiento}\n` : "",
    "## Canal y contacto",
    `Estás respondiendo por ${conv.canal}. Cliente: ${contacto.nombre ?? "desconocido"}${contacto.empresa ? ` (${contacto.empresa})` : ""}${contacto.telefono ? `, tel ${contacto.telefono}` : ""}.`,
    "",
    "## Reglas",
    "- Responde SIEMPRE en el idioma del cliente (por defecto español peruano). Mensajes breves, claros y útiles, estilo WhatsApp.",
    "- Usa las herramientas para consultar datos reales antes de afirmar precios, horarios o estados. No inventes información.",
    "- Para precios: usa cotizacion_estimada y deja claro que es REFERENCIAL; el equipo confirma el precio final.",
    "- NUNCA confirmes que ya cotizaste/reservaste/agendaste algo. Para eso usa proponer_cotizacion / proponer_reserva (un humano aprueba) y dile al cliente que el equipo confirmará.",
    "- Cuando obtengas datos del cliente (nombre, empresa, correo, ruta, pasajeros), guárdalos con actualizar_contacto / registrar_lead.",
    agente.escalar_si ? `- Escala a un humano (escalar_a_humano) si el mensaje menciona: ${agente.escalar_si}.` : "",
    "- No reveles que eres una IA salvo que te lo pregunten directamente; preséntate como el asistente de AFA.",
    "- No compartas costos internos, márgenes ni datos de otros clientes.",
    "- Devuelve solo el texto del mensaje al cliente, sin prefijos como 'Asistente:'.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Historial de la conversación → mensajes para Claude ──────────────────────

async function cargarHistorial(sb: SB, convId: string): Promise<Anthropic.MessageParam[]> {
  const { data } = await sb
    .from("crm_mensajes")
    .select("direccion, contenido, tipo, created_at")
    .eq("conversacion_id", convId)
    .order("created_at", { ascending: true })
    .limit(40);
  const msgs = (data ?? []).slice(-20);
  const out: Anthropic.MessageParam[] = [];
  for (const m of msgs) {
    const role = m.direccion === "entrante" ? "user" : "assistant";
    const texto = m.contenido?.trim() || (m.tipo && m.tipo !== "texto" ? `[${m.tipo}]` : "");
    if (!texto) continue;
    out.push({ role, content: texto });
  }
  // La conversación debe empezar con un mensaje del usuario
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

// ── Envío por canal (modo autónomo) ──────────────────────────────────────────

async function enviarPorCanal(sb: SB, conv: any, contacto: any, texto: string): Promise<string | null> {
  let metaId: string | null = null;
  let gmailMsgId: string | null = null;
  let error: string | null = null;
  try {
    if (conv.canal === "whatsapp" && contacto?.wa_id) metaId = await enviarWhatsApp(contacto.wa_id, texto);
    else if (conv.canal === "messenger" && contacto?.fb_psid) metaId = await enviarMessenger(contacto.fb_psid, texto);
    else if (conv.canal === "instagram" && contacto?.ig_id) metaId = await enviarInstagram(contacto.ig_id, texto);
    else if (conv.canal === "gmail" && contacto?.gmail_email) {
      const r = await enviarEmail(contacto.gmail_email, conv.asunto ?? "Re: Consulta", texto.replace(/\n/g, "<br>"), conv.gmail_thread_id ?? undefined);
      gmailMsgId = r.messageId;
    } else error = "Canal sin datos para enviar";
  } catch (e: any) {
    error = e?.message ?? "Error de envío";
  }
  await sb.from("crm_mensajes").insert({
    conversacion_id: conv.id,
    direccion: "saliente",
    tipo: "texto",
    contenido: texto,
    meta_message_id: metaId,
    gmail_message_id: gmailMsgId,
    generado_por_ia: true,
    error,
  });
  await sb.from("crm_conversaciones").update({ ultimo_mensaje_at: new Date().toISOString() }).eq("id", conv.id);
  return error;
}

// ── Entrada principal ────────────────────────────────────────────────────────

export type ResultadoIA = {
  ok: boolean;
  texto?: string;
  accion: "enviado" | "borrador" | "escalado" | "omitido";
  motivo?: string;
  error?: string;
};

/**
 * Genera (y según el modo envía o deja como borrador) una respuesta de la IA.
 * @param convId  conversación a atender
 * @param opts.forzarBorrador  pedido manual desde el inbox: siempre deja borrador
 */
export async function responderConIA(
  convId: string,
  opts: { forzarBorrador?: boolean } = {}
): Promise<ResultadoIA> {
  if (!process.env.ANTHROPIC_API_KEY)
    return { ok: false, accion: "omitido", error: "Falta ANTHROPIC_API_KEY en el entorno." };

  const sb = db();

  // Agente activo
  const { data: agentes } = await sb.from("crm_agentes_ia").select("*").order("created_at").limit(1);
  const agente = agentes?.[0];
  if (!agente) return { ok: false, accion: "omitido", error: "No hay agente IA configurado." };
  if (!opts.forzarBorrador && !agente.activo) return { ok: true, accion: "omitido", motivo: "Agente desactivado." };

  // Conversación + contacto
  const { data: conv } = await sb
    .from("crm_conversaciones")
    .select("id, canal, estado, asunto, gmail_thread_id, pipeline_id, ia_pausada, contacto_id, crm_contactos(*)")
    .eq("id", convId)
    .single();
  if (!conv) return { ok: false, accion: "omitido", error: "Conversación no encontrada." };
  const contacto = (conv as any).crm_contactos;

  if (!opts.forzarBorrador) {
    if (conv.ia_pausada) return { ok: true, accion: "omitido", motivo: "IA pausada en este hilo." };
    if (conv.estado === "resuelta" || conv.estado === "spam")
      return { ok: true, accion: "omitido", motivo: `Conversación ${conv.estado}.` };
    const canales: string[] = Array.isArray(agente.canales) ? agente.canales : [];
    if (!canales.includes(conv.canal))
      return { ok: true, accion: "omitido", motivo: `Canal ${conv.canal} no atendido por el agente.` };
    // Límite de turnos automáticos
    if (agente.max_turnos_auto > 0) {
      const { count } = await sb
        .from("crm_mensajes")
        .select("id", { count: "exact", head: true })
        .eq("conversacion_id", convId)
        .eq("generado_por_ia", true);
      if ((count ?? 0) >= agente.max_turnos_auto) {
        await sb.from("crm_conversaciones").update({ ia_pausada: true, estado: "en_progreso" }).eq("id", convId);
        return { ok: true, accion: "escalado", motivo: "Límite de turnos automáticos alcanzado." };
      }
    }
  }

  const modelo = MODELOS_VALIDOS.has(agente.modelo) ? agente.modelo : "claude-opus-4-8";
  const system = construirSystem(agente, contacto, conv);
  const messages = await cargarHistorial(sb, convId);
  if (messages.length === 0) return { ok: true, accion: "omitido", motivo: "Sin mensajes del cliente." };

  const ctx: Ctx = { sb, contacto, conv, agente, escalado: { v: false } };

  // ── Bucle agéntico (manual) ────────────────────────────────────────────────
  let textoFinal = "";
  try {
    for (let iter = 0; iter < 6; iter++) {
      const req: any = {
        model: modelo,
        max_tokens: 1500,
        system,
        tools: TOOLS,
        messages,
        ...modelExtras(modelo),
      };
      const resp: any = await anthropic.messages.create(req);

      // Acumular texto y detectar tool_use
      const toolUses = (resp.content ?? []).filter((b: any) => b.type === "tool_use");
      const textos = (resp.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text);
      if (textos.length) textoFinal = textos.join("\n").trim();

      if (resp.stop_reason !== "tool_use" || toolUses.length === 0) break;

      // Ejecutar herramientas y devolver resultados
      messages.push({ role: "assistant", content: resp.content });
      const results: any[] = [];
      for (const tu of toolUses) {
        const out = await ejecutarTool(tu.name, tu.input, ctx);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (e: any) {
    return { ok: false, accion: "omitido", error: e?.message ?? "Error llamando a Claude." };
  }

  if (ctx.escalado.v && !textoFinal)
    return { ok: true, accion: "escalado", motivo: "Derivado a humano." };
  if (!textoFinal) return { ok: true, accion: "omitido", motivo: "Sin texto de respuesta." };

  if (agente.firma) textoFinal = `${textoFinal}\n${agente.firma}`;

  // ── Decidir: enviar (autónomo) o dejar borrador (copiloto) ──────────────────
  const autonomos: string[] = Array.isArray(agente.canales_autonomos) ? agente.canales_autonomos : [];
  const puedeAuto =
    !opts.forzarBorrador && !ctx.escalado.v && autonomos.includes(conv.canal) && dentroHorario(agente);

  if (puedeAuto) {
    if (agente.delay_segundos > 0)
      await new Promise((r) => setTimeout(r, Math.min(agente.delay_segundos, 30) * 1000));
    const err = await enviarPorCanal(sb, conv, contacto, textoFinal);
    if (err) {
      // Si falla el envío, al menos deja el borrador
      await sb.from("crm_conversaciones").update({ borrador_ia: textoFinal, borrador_ia_at: new Date().toISOString() }).eq("id", convId);
      return { ok: false, accion: "borrador", texto: textoFinal, error: err };
    }
    return { ok: true, accion: "enviado", texto: textoFinal };
  }

  // Copiloto: guardar como borrador para que un humano lo apruebe
  await sb
    .from("crm_conversaciones")
    .update({ borrador_ia: textoFinal, borrador_ia_at: new Date().toISOString() })
    .eq("id", convId);
  return { ok: true, accion: ctx.escalado.v ? "escalado" : "borrador", texto: textoFinal };
}

/** Prueba el agente con un mensaje suelto (no envía nada, no toca el ERP de forma destructiva salvo lecturas). */
export async function probarAgente(mensaje: string): Promise<{ ok: boolean; texto?: string; herramientas: string[]; error?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, herramientas: [], error: "Falta ANTHROPIC_API_KEY." };
  const sb = db();
  const { data: agentes } = await sb.from("crm_agentes_ia").select("*").order("created_at").limit(1);
  const agente = agentes?.[0];
  if (!agente) return { ok: false, herramientas: [], error: "No hay agente configurado." };

  const contacto = { id: "test", nombre: "Cliente de prueba", empresa: null, telefono: null, wa_id: null, email: null };
  const conv = { id: "test", canal: "whatsapp", estado: "abierta", pipeline_id: null };
  const ctx: Ctx = { sb, contacto, conv, agente, escalado: { v: false } };
  const modelo = MODELOS_VALIDOS.has(agente.modelo) ? agente.modelo : "claude-opus-4-8";
  const system = construirSystem(agente, contacto, conv);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: mensaje }];
  const usadas: string[] = [];

  try {
    let textoFinal = "";
    for (let iter = 0; iter < 6; iter++) {
      const req: any = { model: modelo, max_tokens: 1500, system, tools: TOOLS, messages, ...modelExtras(modelo) };
      const resp: any = await anthropic.messages.create(req);
      const toolUses = (resp.content ?? []).filter((b: any) => b.type === "tool_use");
      const textos = (resp.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text);
      if (textos.length) textoFinal = textos.join("\n").trim();
      if (resp.stop_reason !== "tool_use" || toolUses.length === 0) break;
      messages.push({ role: "assistant", content: resp.content });
      const results: any[] = [];
      for (const tu of toolUses) {
        usadas.push(tu.name);
        // En prueba, evitamos crear propuestas/escalar (efectos secundarios)
        const out =
          tu.name === "proponer_cotizacion" || tu.name === "proponer_reserva"
            ? JSON.stringify({ ok: true, estado: "pendiente_de_aprobacion", nota: "(simulado en prueba)" })
            : tu.name === "escalar_a_humano"
            ? JSON.stringify({ ok: true, nota: "(simulado en prueba)" })
            : tu.name === "actualizar_contacto" || tu.name === "registrar_lead"
            ? JSON.stringify({ ok: true, nota: "(simulado en prueba)" })
            : await ejecutarTool(tu.name, tu.input, ctx);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      messages.push({ role: "user", content: results });
    }
    return { ok: true, texto: textoFinal, herramientas: [...new Set(usadas)] };
  } catch (e: any) {
    return { ok: false, herramientas: usadas, error: e?.message ?? "Error llamando a Claude." };
  }
}
