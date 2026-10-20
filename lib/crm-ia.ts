// ============================================================
// Agente IA del CRM — Claude (Anthropic)
// Motor conversacional con tool-use contra el ERP real.
// SOLO servidor: usa ANTHROPIC_API_KEY + service-role de Supabase.
// ============================================================
import Anthropic from "@anthropic-ai/sdk";
import { bloqueParaIA } from "@/lib/crm-media";
import { normalizarAjustes, saludoParaHora, presentacion, type AjustesIA } from "@/lib/crm-ia-ajustes";
import { esAudio, esTranscripcion, transcribirMensaje, PREFIJO_TRANSCRIPCION } from "@/lib/crm-audio";
import { createClient } from "@supabase/supabase-js";
import { enviarWhatsApp, enviarMessenger, enviarInstagram, marcarLeidoYEscribiendo } from "@/lib/crm-meta";
import { enviarEmail } from "@/lib/crm-gmail";
import { textoLegible } from "@/lib/crm-gmail-reglas";
import { phonePara } from "@/lib/whatsapp-numeros";
import {
  HERRAMIENTA_COTIZAR_TRASLADO, entradaDelAgente, planEnvio, respuestaDerivar,
  respuestaParaModelo, senalesEnTexto, textoFinalTraslado,
} from "@/lib/traslados/envio-ia";
import { cuadraConMotor, filaCotizacionTraslado } from "@/lib/traslados/cotizacion-traslado";
import { cotizarTrasladoIA, type ResultadoCotizarIA } from "@/lib/traslados/cotizar-ia-datos";
import { enviarCotizacionTraslado } from "@/lib/traslados/enviar-cotizacion-datos";
import { leerConfigIA } from "@/lib/traslados/datos";
import { validarEntrada } from "@/lib/traslados/api";
import { simularTrasladoConCatalogo } from "@/lib/traslados/servicio";
import { fechaLima } from "@/lib/alertas-horario";
import { faltaColumna } from "@/lib/columna-faltante";
import { inicioVentanaHumano, inicioConteoTurnos } from "@/lib/crm-ia-reactivacion";

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

// Lo que el sistema NO encuentra no se le dice al cliente como «no encontré sus servicios»:
// asusta (parece que no existe su reserva) cuando casi siempre es que su número no está
// vinculado a la ficha del cliente. Se deriva a una persona, que sí sabe buscarlo.
// Las reglas y textos se editan en /crm/agente → Ajustes (lib/crm-ia-ajustes.ts).
const ajustesDe = (agente: any): AjustesIA => normalizarAjustes(agente?.comportamiento);

const vecesTxt = (n: number) => (n === 1 ? "UNA vez" : `hasta ${n} veces`);

function notaSinResultados(aj: AjustesIA): string {
  if (!aj.no_decir_no_encontre)
    return "Sin resultados en el sistema (puede que el número no esté vinculado a la ficha del cliente). Pide la fecha o el número de servicio.";
  const pedir = aj.intentos_pedir_datos > 0
    ? `Si aún no le pediste la fecha o el número de servicio, pídeselo (${vecesTxt(aj.intentos_pedir_datos)} como máximo en el chat); si ya lo pediste o no lo sabe, `
    : "No le pidas más datos: ";
  return "Sin resultados en el sistema (suele ser que este número no está vinculado a la ficha del cliente, no que el servicio no exista). " +
    `NO le digas al cliente que no encontraste nada ni que no hay registros. ${pedir}llama a escalar_a_humano (motivo + pedido) y responde con el mensaje de derivación.`;
}

/** Nombre de la empresa (perfil), para presentarse. Best-effort, memoizado 5 min. */
let empresaCache: { v: string; t: number } | null = null;
async function nombreEmpresa(sb: SB): Promise<string> {
  if (empresaCache && Date.now() - empresaCache.t < 300_000) return empresaCache.v;
  let v = "";
  try {
    const { data } = await sb.from("empresa_perfil").select("nombre, razon_social").eq("id", 1).maybeSingle();
    v = String((data as any)?.nombre || (data as any)?.razon_social || "").trim();
  } catch { /* sin perfil: «la empresa» */ }
  empresaCache = { v, t: Date.now() };
  return v;
}

const MENSAJE_DERIVACION_DEFECTO =
  "Gracias, {nombre}. Ya registré tu solicitud y un ejecutivo de nuestro equipo la está revisando para enviarte la información por este mismo chat a la brevedad. 🙌";

function primerNombre(contacto: any): string {
  const nombre = String(contacto?.nombre ?? "").trim().split(/\s+/)[0] ?? "";
  return nombre && !/^\+?\d/.test(nombre) ? nombre.charAt(0).toUpperCase() + nombre.slice(1).toLowerCase() : "";
}

/** Hora de Lima (UTC-5, sin horario de verano) y el saludo que le toca. */
function ahoraLima(aj?: AjustesIA): { fecha: string; hora: string; saludo: string; inicioDiaUtc: string } {
  const lima = new Date(Date.now() - 5 * 3600_000);
  const iso = lima.toISOString();
  const saludo = saludoParaHora(aj ?? normalizarAjustes(null), lima.getUTCHours());
  return {
    fecha: iso.slice(0, 10),
    hora: iso.slice(11, 16),
    saludo,
    inicioDiaUtc: new Date(`${iso.slice(0, 10)}T05:00:00.000Z`).toISOString(),
  };
}

function mensajeDerivacion(agente: any, contacto: any): string {
  const plantilla = String(agente?.mensaje_derivacion ?? "").trim() || MENSAJE_DERIVACION_DEFECTO;
  const n = primerNombre(contacto);
  return plantilla.replace(/\{nombre\}/g, n).replace(/,\s*([.!?])/g, "$1").replace(/\s+,/g, ",");
}

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
      "Devuelve un rango de precio REFERENCIAL basado en el histórico real de cotizaciones y servicios de la empresa para una ruta. Úsala cuando tengas al menos origen y destino. Siempre aclara al cliente que es un estimado y que el equipo confirma el precio final. Precios en PEN, sin IGV.",
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
      "Lista los tipos de vehículo y capacidades disponibles (flota propia y de terceros). Úsala para responder si la empresa tiene un bus de X asientos o qué unidades maneja.",
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
      "Pasa la conversación a un ejecutivo y pausa tu intervención. Úsala si el cliente lo pide, está molesto, hay un reclamo, contrato/licitación, si no encuentras en el sistema lo que pide (servicios, choferes, placas, documentos), si no puedes escuchar una nota de voz, o algo fuera de tu alcance. Una solicitud de COTIZACIÓN no es motivo para derivar: para eso están cotizacion_estimada y proponer_cotizacion. Tras llamarla responde con el mensaje de derivación: un ejecutivo revisará y le enviará la información por este chat.",
    input_schema: {
      type: "object",
      properties: {
        motivo: { type: "string", description: "Por qué derivas (p. ej. «no encontré sus servicios en el sistema»)." },
        pedido: { type: "string", description: "Qué necesita el cliente, en una línea, con los datos que dio (fechas, ruta, empresa, números). Lo lee el ejecutivo." },
      },
      required: ["motivo", "pedido"],
    },
  },
];

// ── Ejecutor de herramientas ─────────────────────────────────────────────────

type Ctx = {
  sb: SB; contacto: any; conv: any; agente: any; escalado: { v: boolean };
  /** Copia tomada ANTES del bucle: el canal y el wa_id del hilo. `actualizar_contacto` no lo toca. */
  remitente?: { canal: string; waId: string | null };
  /** Calculado UNA vez, con la misma expresión con que se decide enviar: la herramienta y el envío leen este. */
  modoAuto?: boolean;
  /** Consultas al cotizador de traslados en este turno. */
  consultasTurno?: { n: number };
  /** Se ofrece `cotizar_traslado` en este turno. */
  traslados?: boolean;
  /** Lo que devolvió la última llamada a `cotizar_traslado` en este turno. */
  cotizacionTraslado?: ResultadoCotizarIA | null;
};

/** El número peruano con que la PRUEBA del agente (/crm/agente) cotiza traslados. No es de nadie. */
export const TELEFONO_PRUEBA_TRASLADOS = "51900000000";

/**
 * Deriva la conversación a un ejecutivo: pausa la IA, la etiqueta y deja una nota interna con el
 * motivo y el pedido (y, si se da, el detalle interno: lo lee el ejecutivo, nunca el cliente).
 * Es el cuerpo de `escalar_a_humano`, extraído para que `cotizar_traslado` derive igual.
 */
async function derivarConversacion(ctx: Ctx, motivo: unknown, pedido: unknown, detalle?: string): Promise<void> {
  const { sb, conv } = ctx;
  await sb
    .from("crm_conversaciones")
    .update({ ia_pausada: true, estado: "en_progreso" })
    .eq("id", conv.id);
  ctx.escalado.v = true;
  // Para que el ejecutivo sepa QUÉ enviar sin releer el chat: etiqueta + nota interna.
  // Best-effort: sin crm-inbox-equipo.sql corrido no hay etiquetas ni notas.
  const aj = ajustesDe(ctx.agente);
  try {
    if (aj.etiqueta_derivacion) {
      const { data: e } = await sb.from("crm_conversaciones").select("etiquetas").eq("id", conv.id).maybeSingle();
      const etq: string[] = Array.isArray((e as any)?.etiquetas) ? (e as any).etiquetas : [];
      if (!etq.includes(aj.etiqueta_derivacion))
        await sb.from("crm_conversaciones").update({ etiquetas: [...etq, aj.etiqueta_derivacion] }).eq("id", conv.id);
    }
    if (aj.nota_interna_derivacion) await sb.from("crm_notas").insert({
      conversacion_id: conv.id,
      texto: `🤖 La IA derivó este chat.\nMotivo: ${String(motivo ?? "—").slice(0, 300)}\nPedido del cliente: ${String(pedido ?? "—").slice(0, 500)}${detalle ? `\n${detalle.slice(0, 1500)}` : ""}`,
      autor_nombre: "Asistente IA",
    });
  } catch { /* sin etiquetas/notas: la derivación ya quedó hecha */ }
}

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
            return JSON.stringify({ encontrados: 0, nota: notaSinResultados(ajustesDe(ctx.agente)) });
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
        if (rows.length === 0) return JSON.stringify({ encontrados: 0, nota: notaSinResultados(ajustesDe(ctx.agente)) });
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
        await derivarConversacion(ctx, input?.motivo, input?.pedido);
        return JSON.stringify({ ok: true, nota: "Derivado a un ejecutivo e IA pausada. Responde AHORA con el mensaje de derivación (sin decir que no encontraste nada)." });
      }

      case "cotizar_traslado": {
        if (!ctx.traslados || !ctx.remitente || !ctx.consultasTurno)
          return JSON.stringify({ error: "La cotización automática de traslados no está disponible en este chat." });
        const r = await cotizarTrasladoIA(
          { sb, conv, contacto, remitente: ctx.remitente, modoAuto: ctx.modoAuto === true, consultasTurno: ctx.consultasTurno },
          input,
        );
        ctx.cotizacionTraslado = r;
        if (r.derivar) await derivarConversacion(ctx, r.derivar.motivo, r.derivar.pedido, r.derivar.nota);
        return r.respuestaModelo;
      }

      default:
        return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
    }
  } catch (e: any) {
    return JSON.stringify({ error: e?.message ?? "Error ejecutando herramienta" });
  }
}

// ── System prompt construido desde la config del agente ──────────────────────

/**
 * Lo que la IA tiene que saber de `cotizar_traslado`. Va ANTES de los objetivos de la empresa y
 * solo cuando la herramienta se ofrece: sin ella, las instrucciones son las de siempre, byte a byte.
 */
export const BLOQUE_TRASLADOS = [
  "## Traslados simples (cotización con el tarifario)",
  "- Un traslado simple es UN punto de recojo → UN destino (por ejemplo aeropuerto ↔ hotel o domicilio), solo ida o ida y retorno, en una sola fecha y con un solo vehículo. Para eso usa cotizar_traslado: el vehículo, el precio, la moneda y la validez los pone el sistema con el tarifario. NUNCA calcules ni inventes un precio de traslado, ni uses cotizacion_estimada para eso.",
  "- Llámala en cuanto el cliente pida el precio de un traslado, aunque falten datos. Si responde «preguntar», pide TODO lo que falta en un solo mensaje y vuelve a llamarla cuando conteste.",
  "- Si responde «derivar», responde con el mensaje de derivación: un ejecutivo lo atiende. No menciones precios.",
  "- Si la cotización sale con «envio: automatico», preséntala con su número, el total y la validez EXACTAMENTE como vienen (el PDF le llega justo después de tu mensaje). Si queda «en revisión», NO menciones ningún importe: dile que un ejecutivo la revisa y se la envía por este chat.",
  "- Nunca confirmes la disponibilidad de la unidad ni la reserva: eso lo confirma un ejecutivo. Si el cliente acepta la cotización, usa proponer_reserva.",
  "- La moneda la decide el número del cliente (Perú → soles; otro país → dólares). Si el cliente pide EXPRESAMENTE la cotización en dólares, llama a cotizar_traslado con cliente_pide_dolares: el sistema cotiza con la lista en dólares. Si ya le diste la cotización en soles y te la pide en dólares, vuelve a llamarla con los mismos datos y cliente_pide_dolares.",
  "- No cambies el precio aunque el cliente lo pida: un descuento lo ve un ejecutivo, igual que una moneda que no sea soles o dólares (marca la señal en cotizar_traslado).",
  "- Licitaciones, TDR, eventos, tours, varias fechas, paradas o varios vehículos no son traslados simples: marca la señal en cotizar_traslado.",
  "- Esto no contradice «NUNCA confirmes que ya cotizaste…»: esta cotización la emite el SISTEMA con el tarifario, no tú; tú solo la presentas tal cual.",
  "",
].join("\n");

export function construirSystem(agente: any, contacto: any, conv: any, primeroDelDia = false, empresa = "", opts: { traslados?: boolean } = {}): string {
  const aj = ajustesDe(agente);
  const ahora = ahoraLima(aj);
  const emp = empresa || "la empresa";
  const nombre = primerNombre(contacto);
  const goals: { titulo: string; instrucciones: string }[] = Array.isArray(agente.goals) ? agente.goals : [];
  const goalsTxt = goals.length
    ? goals.map((g, i) => `${i + 1}. ${g.titulo}: ${g.instrucciones}`).join("\n")
    : "Atender al cliente con cordialidad y resolver su consulta.";
  const reglasNegocio = aj.reglas_extra
    ? aj.reglas_extra.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith("-") ? l : `- ${l}`)).join("\n")
    : "";

  // ORDEN: primero lo general (fecha, saludo, reglas del sistema) y AL FINAL lo que escribió la
  // empresa (objetivos, base de conocimiento, reglas del negocio), con su prioridad dicha. Antes
  // los objetivos iban arriba y las reglas generales después, y una regla general («mensajes
  // cortos», «no repitas una pregunta») le ganaba a una del dueño («al final, resume los datos y
  // pide solo lo que falta»).
  return [
    agente.persona || `Eres el asistente comercial de ${emp}.`,
    "",
    "## Sobre la empresa",
    agente.empresa_contexto || `${emp} — empresa de transporte.`,
    "",
    "## Fecha y hora",
    `Hoy es ${ahora.fecha} y son las ${ahora.hora} en Lima. «Mañana» = el día siguiente a esa fecha.`,
    "",
    !aj.saludo_activo ? "" : primeroDelDia
      ? `## SALUDO OBLIGATORIO\nEs tu PRIMER mensaje del día con este cliente: tu respuesta DEBE empezar con «${ahora.saludo}${nombre ? `, ${nombre}` : ""}», seguido de una presentación breve si corresponde, y recién después responder o preguntar. No omitas el saludo aunque el cliente no salude ni aunque necesites pedirle datos.\n`
      : "## Saludo\nYa conversaste hoy con este cliente: NO vuelvas a saludar ni a presentarte.\n",
    "## Canal y contacto",
    `Estás respondiendo por ${conv.canal}. Cliente: ${contacto.nombre ?? "desconocido"}${contacto.empresa ? ` (${contacto.empresa})` : ""}${contacto.telefono ? `, tel ${contacto.telefono}` : ""}.`,
    "",
    "## Reglas generales",
    "- Responde SIEMPRE en el idioma del cliente (por defecto español peruano). Mensajes claros y útiles, estilo WhatsApp, sin relleno (el resumen del pedido no cuenta como relleno).",
    "- Usa las herramientas para consultar datos reales antes de afirmar precios, horarios o estados. No inventes información.",
    "- Para precios: usa cotizacion_estimada y deja claro que es REFERENCIAL; el equipo confirma el precio final.",
    "- NUNCA confirmes que ya cotizaste/reservaste/agendaste algo. Para eso usa proponer_cotizacion / proponer_reserva (un humano aprueba) y dile al cliente que el equipo confirmará.",
    "- Cuando obtengas datos del cliente (nombre, empresa, correo, ruta, pasajeros), guárdalos con actualizar_contacto / registrar_lead.",
    agente.escalar_si ? `- Escala a un humano (escalar_a_humano) si el mensaje menciona: ${agente.escalar_si}.` : "",
    aj.no_decir_no_encontre
      ? `- Si no encuentras en el sistema lo que el cliente pide (servicios, choferes, placas, horarios, documentos), NUNCA digas «no encontré», «no hay registros», «no existe» ni «no tengo información»: eso asusta al cliente. ${aj.intentos_pedir_datos > 0 ? `Pide la fecha o el número de servicio ${vecesTxt(aj.intentos_pedir_datos)} como máximo; si ya lo pediste, no lo sabe o igual no aparece, ` : "No pidas más datos: "}llama a escalar_a_humano (con motivo y pedido) y responde con el mensaje de derivación.`
      : "",
    aj.transcribir_audios
      ? "- Las notas de voz llegan transcritas como «[Nota de voz del cliente, transcrita]»: respóndelas como cualquier mensaje. Nunca digas que no puedes escuchar audios. Si llega «[…nota de voz que no se pudo transcribir]», llama a escalar_a_humano y responde con el mensaje de derivación (un ejecutivo escuchará el audio)."
      : "- Si el cliente manda una nota de voz, no digas que no puedes escucharla: llama a escalar_a_humano y responde con el mensaje de derivación (un ejecutivo escuchará el audio).",
    `- Mensaje de derivación (adáptalo mínimamente, sin quitar la idea de que un ejecutivo revisará y enviará la información por este chat): «${mensajeDerivacion(agente, contacto)}»`,
    aj.ocultar_ia
      ? `- No reveles que eres una IA salvo que te lo pregunten directamente; preséntate como ${presentacion(aj, emp)}.`
      : `- Preséntate como ${presentacion(aj, emp)}.`,
    "- No compartas costos internos, márgenes ni datos de otros clientes.",
    "- Devuelve solo el texto del mensaje al cliente, sin prefijos como 'Asistente:'.",
    !aj.leer_archivos ? "- Si el cliente envía fotos o documentos, dile que un ejecutivo los revisará (no los ves)." : "- Si el cliente envía FOTOS o DOCUMENTOS, LÉELOS: extrae fechas, horarios, número de pasajeros, origen, destino y lo que pida. Nunca digas que no puedes verlos.",
    aj.resumen_pedido
      ? "- No insistas con una pregunta suelta que ya hiciste. Lo que falte va en el «Solo me falta» del resumen del pedido, que SÍ va en cada respuesta mientras el pedido no esté completo."
      : "- No repitas una pregunta que ya hiciste con otras palabras. Si el cliente no la contestó, espera; no insistas en el mismo mensaje ni en el siguiente.",
    "- Un sticker o una reacción no es una pregunta: no contestes solo por eso.",
    "- Formato WhatsApp: negrita con *un* asterisco (nunca **dos**). Un solo mensaje por turno.",
    "",
    aj.recordar_datos
      ? [
          "## Lo que el cliente YA dijo (no se vuelve a pedir)",
          "- Antes de responder, relee TODA la conversación —también lo que el cliente le contestó a una persona del equipo— y arma la ficha del pedido.",
          "- NUNCA vuelvas a pedir un dato que ya está en la conversación, aunque lo haya dado en otro orden, en un solo bloque o repartido en varios mensajes.",
          "- Si el cliente repite su pedido o pregunta «¿me pueden dar la cotización?», es que espera una respuesta: no le pidas lo que ya dio; avanza con lo que tienes.",
          aj.lugares_conocidos ? `- No necesitan dirección exacta: ${aj.lugares_conocidos}.` : "",
          "- Si falta algo indispensable, pide TODO lo que falte en un solo mensaje. No condiciones la atención a que te dé su nombre: si falta, pídelo en el mismo mensaje en que avanzas.",
          "- Con los datos del servicio completos, avanza: precio referencial con cotizacion_estimada y proponer_cotizacion para que el equipo lo confirme.",
          "",
        ].filter(Boolean).join("\n")
      : "",
    aj.resumen_pedido
      ? [
          "## Resumen del pedido (al final de tu respuesta)",
          `- Mientras el cliente esté pidiendo un servicio (cotización o reserva), TERMINA cada respuesta con el resumen de lo que ya dio y pide SOLO lo que falta. Datos del pedido: ${aj.campos_pedido}.`,
          "- Formato:",
          "📋 *Resumen de su solicitud*",
          "• <dato>: <lo que dio el cliente>",
          "• …",
          "*Solo me falta:* <los datos que faltan, juntos en una línea>",
          "- Si ya está todo, cambia la última línea por «Con esto ya tengo todo lo necesario».",
          "- Nunca pongas en el resumen un dato que el cliente no dio: lo que no dio va en «Solo me falta».",
          "- También al derivar a un ejecutivo. No lo pongas en respuestas que no son de un pedido (consultas sobre un servicio en curso, saludos, agradecimientos).",
          "",
        ].join("\n")
      : "",
    opts.traslados ? BLOQUE_TRASLADOS : "",
    "## Tus objetivos (goals)",
    goalsTxt,
    "",
    agente.conocimiento ? `## Base de conocimiento\n${agente.conocimiento}\n` : "",
    reglasNegocio ? `## Reglas del negocio\n${reglasNegocio}\n` : "",
    "## Prioridad",
    "Tus objetivos, la base de conocimiento y las reglas del negocio los escribió la empresa: si chocan con una regla general de arriba, MANDAN ELLOS. Lo único que no se negocia: no inventar datos, no dar por confirmada una cotización o reserva que aprueba una persona, y no compartir costos internos ni datos de otros clientes.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Historial de la conversación → mensajes para Claude ──────────────────────

async function cargarHistorial(sb: SB, convId: string, aj: AjustesIA = normalizarAjustes(null)): Promise<Anthropic.MessageParam[]> {
  // Los 40 MÁS RECIENTES: antes se pedían los 40 más antiguos (orden ascendente + limit),
  // así que en un hilo largo la IA contestaba sin ver lo último que escribió el cliente.
  // Cuántos relee lo dice Ajustes (40 por defecto): con 20, en un chat donde el cliente repitió
  // su pedido varias veces, los datos del principio quedaban fuera y la IA los volvía a pedir.
  const { data } = await sb
    .from("crm_mensajes")
    .select("id, direccion, contenido, tipo, media_url, created_at")
    .eq("conversacion_id", convId)
    .order("created_at", { ascending: false })
    .limit(aj.mensajes_historial);
  const msgs = (data ?? []).reverse();
  // Notas de voz que el webhook no alcanzó a transcribir (o anteriores a esta función):
  // se transcriben ahora y quedan guardadas. Solo las últimas, por costo.
  const audiosPend = !aj.transcribir_audios ? [] : msgs
    .filter((m: any) => m.direccion === "entrante" && esAudio(m.tipo) && m.media_url && !esTranscripcion(m.contenido))
    .slice(-aj.max_audios);
  for (const m of audiosPend as any[]) {
    const nuevo = await transcribirMensaje(sb as any, { id: m.id }, m.media_url, m.contenido);
    if (nuevo) m.contenido = nuevo;
  }
  // Las fotos y PDF que mandó el cliente van como IMAGEN/DOCUMENTO para que la IA los LEA
  // (antes recibía «[image]» y contestaba «no puedo verlas»). Solo los últimos, por costo.
  const conArchivo = !aj.leer_archivos ? [] : msgs
    .map((m: any, i: number) => ({ m, i }))
    .filter(({ m }) => m.direccion === "entrante" && m.media_url && ["image", "document", "imagen"].includes(m.tipo))
    .slice(-aj.max_archivos);
  const bloques = new Map<number, any>();
  for (const { m, i } of conArchivo) {
    const b = await bloqueParaIA(sb as any, m.media_url);
    if (b) bloques.set(i, b);
  }
  const out: Anthropic.MessageParam[] = [];
  msgs.forEach((m: any, i: number) => {
    const role = m.direccion === "entrante" ? "user" : "assistant";
    if (m.tipo === "reaction") {
      if (role === "user") out.push({ role, content: `[El cliente reaccionó con ${m.contenido ?? "un emoji"}]` });
      return;
    }
    // Un correo importado como HTML (antes de que la lectura lo pasara a texto) se lee como
    // texto: si no, el agente se gasta los tokens leyendo CSS.
    if (esAudio(m.tipo) && role === "user") {
      out.push({
        role,
        content: esTranscripcion(m.contenido)
          ? `[Nota de voz del cliente, transcrita] ${String(m.contenido).slice(PREFIJO_TRANSCRIPCION.length)}`
          : "[El cliente envió una nota de voz que no se pudo transcribir]",
      });
      return;
    }
    const crudo = textoLegible(m.contenido)?.trim() ?? "";
    const texto = /^\[[a-z_]+\]$/i.test(crudo) ? "" : crudo;
    const archivo = bloques.get(i);
    if (archivo) {
      const etiqueta = archivo.type === "image" ? "[El cliente envió esta imagen]" : "[El cliente envió este documento]";
      out.push({ role: "user", content: [archivo, { type: "text", text: texto ? `${etiqueta} ${texto}` : etiqueta }] as any });
      return;
    }
    const final = texto || (m.tipo && m.tipo !== "texto" ? `[${m.tipo === "sticker" ? "sticker" : m.tipo}]` : "");
    if (!final) return;
    out.push({ role, content: final });
  });
  // La conversación debe empezar con un mensaje del usuario
  while (out.length && out[0].role !== "user") out.shift();
  // …y TERMINAR con uno: si el último es nuestro, la API lo toma como «prefill» y
  // los modelos nuevos lo rechazan con un 400 (lo que salía en rojo al pedir borrador).
  while (out.length && out[out.length - 1].role !== "user") out.pop();
  return out;
}

// ── Envío por canal (modo autónomo) ──────────────────────────────────────────

/** El número de WhatsApp al que se responde: el wa_id del hilo o, sin él, el teléfono del contacto. */
function waDestinoDe(contacto: { wa_id?: unknown; telefono?: unknown } | null | undefined): string {
  if (contacto?.wa_id) return String(contacto.wa_id);
  return contacto?.telefono ? String(contacto.telefono).replace(/\D/g, "") : "";
}

/**
 * `waDestino`, si se pasa, es el número copiado ANTES del bucle del agente: `actualizar_contacto`
 * deja al modelo reescribir `contacto.telefono` en este mismo turno, y sin wa_id la respuesta iría
 * al número que escribió el modelo.
 */
async function enviarPorCanal(sb: SB, conv: any, contacto: any, texto: string, waDestinoFijo?: string): Promise<string | null> {
  let metaId: string | null = null;
  let gmailMsgId: string | null = null;
  let error: string | null = null;
  try {
    // Por el mismo número que usó el cliente (ver app/api/crm/mensajes/enviar).
    // Sin wa_id (contacto creado a mano, o por el historial) se usa su teléfono.
    const waDestino = waDestinoFijo !== undefined ? waDestinoFijo : waDestinoDe(contacto);
    if (conv.canal === "whatsapp" && waDestino)
      metaId = await enviarWhatsApp(waDestino, texto, conv.phone_number_id ?? (await phonePara("crm")));
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

/**
 * Si en este turno se usó `cotizar_traslado`: con una cotización, el mensaje lo escribe SIEMPRE el
 * código (el modelo no pone el total, el IGV ni la validez); sin ella, el del modelo solo pasa si
 * no menciona dinero (`textoFinalTraslado`). Sin la herramienta en el turno, el texto no se toca.
 */
export function textoSinImportesAjenos(texto: string, ct: ResultadoCotizarIA | null | undefined, agente: any, contacto: any): string {
  return textoFinalTraslado(texto, ct ?? null, { nombre: primerNombre(contacto), derivacion: mensajeDerivacion(agente, contacto) });
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
// El cliente suele escribir en varios mensajes seguidos («Hola» · «quiero cotizar» · foto).
// La IA espera a que deje de escribir: responde cuando pasan SILENCIO_MS sin mensajes
// nuevos, con un tope de ESPERA_MAX_MS para no dejarlo esperando si escribe sin parar.
// Solo contesta la corrida del ÚLTIMO mensaje: las de los anteriores ven que llegó uno
// más nuevo y se retiran, así sale UNA respuesta que une todo lo recibido.
const SILENCIO_MS = 12_000;
// Un mensaje que ya parece completo (una pregunta, o un texto largo con los datos, o un
// documento) espera poco; uno corto o suelto («Hola», «una consulta», una foto sola) espera
// los 12 s porque casi siempre viene algo más. Es una regla aproximada, no una certeza.
const SILENCIO_COMPLETO_MS = 4_000;
export function silencioPara(
  m: { tipo?: string | null; contenido?: string | null } | null,
  aj?: AjustesIA,
): number {
  const largo = aj ? aj.silencio_seg * 1000 : SILENCIO_MS;
  const corto = aj ? aj.silencio_completo_seg * 1000 : SILENCIO_COMPLETO_MS;
  if (!m) return largo;
  const t = (m.contenido ?? "").trim();
  if (m.tipo === "document") return corto;
  if (m.tipo && m.tipo !== "texto" && m.tipo !== "text") return largo;
  if (/\?\s*$/.test(t) || t.length >= 60) return corto;
  return largo;
}
const CANDADO_MS = 90_000;

export async function responderConIA(
  convId: string,
  opts: { forzarBorrador?: boolean } = {}
): Promise<ResultadoIA> {
  const candado = { tomado: false };
  let resultado: ResultadoIA | null = null;
  try {
    resultado = await responderConIAInterno(convId, opts, candado);
    return resultado;
  } catch (e: any) {
    resultado = { ok: false, accion: "omitido", error: e?.message ?? "Error inesperado de la IA." };
    throw e;
  } finally {
    // Solo suelta el candado quien lo ganó: soltarlo desde una llamada perdedora
    // abriría la puerta a la respuesta duplicada.
    if (candado.tomado)
      await db().from("crm_conversaciones").update({ ia_respondiendo_at: null }).eq("id", convId);
    if (resultado) await registrarDecision(convId, resultado, !!opts.forzarBorrador);
  }
}

// Por qué la IA respondió o no, guardado en la conversación: antes, si no contestaba, no quedaba
// rastro en ningún sitio (el webhook descarta el resultado) y no había forma de saber si estaba
// pausada, si una persona había respondido o si Claude devolvió un error.
// Las corridas que se retiran porque otra se encarga (ráfaga, candado) no se anotan: pisarían la
// decisión de la que sí respondió.
const MOTIVOS_DE_RELEVO = [
  "Llegó otro mensaje del cliente",
  "Otra respuesta de la IA ya está en curso",
  "El cliente siguió escribiendo",
];
async function registrarDecision(convId: string, r: ResultadoIA, aPedido: boolean) {
  const motivo = r.error ?? r.motivo ?? null;
  if (r.accion === "omitido" && motivo && MOTIVOS_DE_RELEVO.some((m) => motivo.startsWith(m))) return;
  console.log(`[crm-ia] ${convId} ${r.accion}${motivo ? ` · ${motivo}` : ""}`);
  try {
    await db()
      .from("crm_conversaciones")
      .update({
        ia_ultima_decision: {
          accion: r.accion,
          ok: r.ok,
          motivo: motivo ? String(motivo).slice(0, 300) : null,
          a_pedido: aPedido,
          at: new Date().toISOString(),
        },
      })
      .eq("id", convId);
  } catch { /* sin la columna (crm-ia-decision.sql) no se anota: la IA funciona igual */ }
}

async function responderConIAInterno(
  convId: string,
  opts: { forzarBorrador?: boolean },
  candado: { tomado: boolean }
): Promise<ResultadoIA> {
  const inicioRespuesta = new Date().toISOString();
  let ultimoVisto: string | null = null;
  if (!process.env.ANTHROPIC_API_KEY)
    return { ok: false, accion: "omitido", error: "Falta ANTHROPIC_API_KEY en el entorno." };

  const sb = db();

  // Agente activo
  const { data: agentes } = await sb.from("crm_agentes_ia").select("*").order("created_at").limit(1);
  const agente = agentes?.[0];
  if (!agente) return { ok: false, accion: "omitido", error: "No hay agente IA configurado." };
  if (!opts.forzarBorrador && !agente.activo) return { ok: true, accion: "omitido", motivo: "Agente desactivado." };

  // Conversación + contacto
  // `ia_reactivada_at` es de una migración accesoria (crm-ia-reactivacion.sql): sin ella se lee sin la columna.
  const COLS_CONV = "id, canal, estado, asunto, gmail_thread_id, pipeline_id, ia_pausada, contacto_id, phone_number_id, crm_contactos(*)";
  let rConv: any = await sb.from("crm_conversaciones").select(`${COLS_CONV}, ia_reactivada_at`).eq("id", convId).single();
  if (rConv.error && faltaColumna(rConv.error, "ia_reactivada_at"))
    rConv = await sb.from("crm_conversaciones").select(COLS_CONV).eq("id", convId).single();
  const conv = rConv.data;
  if (!conv) return { ok: false, accion: "omitido", error: "Conversación no encontrada." };
  const reactivadaAt: string | null = (conv as any).ia_reactivada_at ?? null;
  const contacto = (conv as any).crm_contactos;

  if (!opts.forzarBorrador) {
    if (conv.ia_pausada) return { ok: true, accion: "omitido", motivo: "IA pausada en este hilo." };
    if (contacto?.ia_desactivada === true)
      return { ok: true, accion: "omitido", motivo: "IA desactivada para este contacto (proveedor / conductor)." };
    // Sin modo autónomo para este canal (o fuera de horario) la IA solo redacta cuando el
    // operador lo PIDE con el botón ✨ IA: antes armaba un borrador con cada mensaje y
    // gastaba IA en sugerencias que nadie había pedido.
    const autonomosPre: string[] = Array.isArray(agente.canales_autonomos) ? agente.canales_autonomos : [];
    if (!autonomosPre.includes(conv.canal) || !dentroHorario(agente))
      return { ok: true, accion: "omitido", motivo: "Modo copiloto: la sugerencia se pide con el botón ✨ IA." };
    // Si una persona del equipo respondió hace poco (desde el CRM o el celular), la IA se
    // aparta unas horas: el cliente ya está atendido por un humano.
    const horasPausa = Number.isFinite(Number(agente.pausa_humano_horas)) ? Number(agente.pausa_humano_horas) : 12;
    // Si una persona REACTIVÓ la IA en este chat, solo cuentan las respuestas humanas posteriores.
    if (horasPausa > 0) {
      const desde = inicioVentanaHumano(Date.now(), horasPausa, reactivadaAt);
      const { count: humanos } = await sb
        .from("crm_mensajes").select("id", { count: "exact", head: true })
        .eq("conversacion_id", convId).eq("direccion", "saliente")
        .or("generado_por_ia.is.null,generado_por_ia.eq.false")
        .gte("created_at", desde);
      if ((humanos ?? 0) > 0)
        return {
          ok: true, accion: "omitido",
          motivo: reactivadaAt && desde === inicioConteoTurnos(reactivadaAt)
            ? "Una persona respondió después de reactivar la IA: la IA no interviene."
            : `Una persona respondió en las últimas ${horasPausa} h: la IA no interviene (pulsa «IA activa» para que vuelva a contestar).`,
        };
    }
    // El agente solo atiende números de ATENCIÓN AL CLIENTE. Un número marcado solo para
    // avisos automáticos (usa_avisos y no usa_crm) nunca responde con IA.
    if (conv.canal === "whatsapp" && (conv as any).phone_number_id) {
      const { data: num } = await sb
        .from("whatsapp_numeros")
        .select("usa_crm, usa_avisos")
        .eq("phone_number_id", (conv as any).phone_number_id)
        .maybeSingle();
      if (num && num.usa_crm === false)
        return { ok: true, accion: "omitido", motivo: "Número de avisos: el agente IA no atiende aquí." };
    }
    if (conv.estado === "resuelta" || conv.estado === "spam")
      return { ok: true, accion: "omitido", motivo: `Conversación ${conv.estado}.` };
    const canales: string[] = Array.isArray(agente.canales) ? agente.canales : [];
    if (!canales.includes(conv.canal))
      return { ok: true, accion: "omitido", motivo: `Canal ${conv.canal} no atendido por el agente.` };
    // Límite de turnos automáticos
    // Tras una reactivación se cuentan solo los turnos posteriores: si no, el hilo que ya llegó al
    // límite se volvería a pausar solo en el siguiente mensaje.
    if (agente.max_turnos_auto > 0) {
      const desdeTurnos = inicioConteoTurnos(reactivadaAt);
      let qTurnos = sb
        .from("crm_mensajes")
        .select("id", { count: "exact", head: true })
        .eq("conversacion_id", convId)
        .eq("generado_por_ia", true);
      if (desdeTurnos) qTurnos = qTurnos.gte("created_at", desdeTurnos);
      const { count } = await qTurnos;
      if ((count ?? 0) >= agente.max_turnos_auto) {
        await sb.from("crm_conversaciones").update({ ia_pausada: true, estado: "en_progreso" }).eq("id", convId);
        return { ok: true, accion: "escalado", motivo: "Límite de turnos automáticos alcanzado." };
      }
    }
  }

  if (!opts.forzarBorrador) {
    // Ráfaga: tres mensajes seguidos son tres webhooks y antes eran tres respuestas.
    const ultimoEntrante = async () => {
      const { data } = await sb
        .from("crm_mensajes").select("id, created_at, tipo, contenido, meta_message_id").eq("conversacion_id", convId)
        .eq("direccion", "entrante").order("created_at", { ascending: false }).limit(1).maybeSingle();
      return data as { id: string; created_at: string; tipo: string | null; contenido: string | null; meta_message_id: string | null } | null;
    };
    const propio = await ultimoEntrante();
    // «escribiendo…» y ✓✓ azules mientras se espera, solo si la IA va a contestar sola
    // (en modo copiloto contesta una persona y el indicador sería una promesa falsa).
    const autonomosIni: string[] = Array.isArray(agente.canales_autonomos) ? agente.canales_autonomos : [];
    const mostrarEscribiendo =
      conv.canal === "whatsapp" && autonomosIni.includes("whatsapp") && dentroHorario(agente) && !!propio?.meta_message_id;
    if (mostrarEscribiendo) await marcarLeidoYEscribiendo(propio!.meta_message_id!, (conv as any).phone_number_id);
    const ajEspera = ajustesDe(agente);
    const silencio = silencioPara(propio, ajEspera);
    const tope = Date.now() + ajEspera.espera_max_seg * 1000;
    for (;;) {
      const ult = await ultimoEntrante();
      if (ult && propio && ult.id !== propio.id)
        return { ok: true, accion: "omitido", motivo: "Llegó otro mensaje del cliente: responde la corrida de ese." };
      const quieto = ult ? Date.now() - new Date(ult.created_at).getTime() : silencio;
      if (quieto >= silencio || Date.now() >= tope) break;
      await new Promise((r) => setTimeout(r, Math.min(silencio - quieto + 200, tope - Date.now())));
    }
    ultimoVisto = propio?.id ?? null;
    // El indicador dura ~25 s: se renueva justo antes de redactar.
    if (mostrarEscribiendo) await marcarLeidoYEscribiendo(propio!.meta_message_id!, (conv as any).phone_number_id);
    // Candado por hilo. Si otra corrida lo tiene (la de un mensaje anterior que ya estaba
    // redactando), se espera a que lo suelte: esa corrida verá que llegó este mensaje y se
    // retirará sin enviar, y entonces contesta esta con todo junto.
    let gano: any[] | null = null;
    let errLock: any = null;
    for (let intento = 0; intento < 6; intento++) {
      const limite = new Date(Date.now() - CANDADO_MS).toISOString();
      const r = await sb
        .from("crm_conversaciones")
        .update({ ia_respondiendo_at: new Date().toISOString() })
        .eq("id", convId)
        .or(`ia_respondiendo_at.is.null,ia_respondiendo_at.lt.${limite}`)
        .select("id");
      gano = r.data; errLock = r.error;
      if (errLock || (gano && gano.length > 0)) break;
      await new Promise((res) => setTimeout(res, 8000));
      const ult = await ultimoEntrante();
      if (ult && propio && ult.id !== propio.id)
        return { ok: true, accion: "omitido", motivo: "Llegó otro mensaje del cliente: responde la corrida de ese." };
    }
    if (!errLock && (!gano || gano.length === 0))
      return { ok: true, accion: "omitido", motivo: "Otra respuesta de la IA ya está en curso." };
    candado.tomado = !errLock;
    const { data: ult } = await sb
      .from("crm_mensajes").select("direccion, tipo").eq("conversacion_id", convId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (ult?.direccion === "saliente") {
      return { ok: true, accion: "omitido", motivo: "El último mensaje ya es nuestro." };
    }
    if (ult?.tipo === "sticker" || ult?.tipo === "reaction")
      return { ok: true, accion: "omitido", motivo: "Un sticker o reacción no se contesta." };
  }

  const modelo = MODELOS_VALIDOS.has(agente.modelo) ? agente.modelo : "claude-opus-4-8";
  // ¿Ya le escribimos hoy (hora de Lima) en este hilo? Si no, el saludo es obligatorio.
  const { count: salientesHoy } = await sb
    .from("crm_mensajes").select("id", { count: "exact", head: true })
    .eq("conversacion_id", convId).eq("direccion", "saliente")
    .gte("created_at", ahoraLima().inicioDiaUtc);
  // Se decide UNA vez si esta respuesta sale sola: la herramienta de traslados lo necesita para
  // saber si la cotización se envía sola, y el envío del final lee esta MISMA variable.
  const autonomos: string[] = Array.isArray(agente.canales_autonomos) ? agente.canales_autonomos : [];
  const modoAuto =
    // Al derivar SÍ se envía el mensaje de derivación: antes quedaba como borrador y el
    // cliente se quedaba sin saber que un ejecutivo lo iba a atender.
    !opts.forzarBorrador && autonomos.includes(conv.canal) && dentroHorario(agente);
  // El remitente se copia AHORA: el modelo puede reescribir datos del contacto con sus herramientas.
  const remitente = { canal: String(conv.canal ?? ""), waId: contacto?.wa_id ? String(contacto.wa_id) : null };
  // También el número al que se responde y el nombre del saludo: `actualizar_contacto` puede
  // cambiar `contacto.telefono` y `contacto.nombre` en este mismo turno.
  const waDestinoInicial = waDestinoDe(contacto);
  const contactoInicial = { ...contacto };
  // `cotizar_traslado` solo en WhatsApp, con el interruptor encendido y las migraciones corridas.
  const traslados = conv.canal === "whatsapp" && (await leerConfigIA(sb)).iaCotiza;

  const system = construirSystem(agente, contacto, conv, (salientesHoy ?? 0) === 0, await nombreEmpresa(sb), { traslados });
  const messages = await cargarHistorial(sb, convId, ajustesDe(agente));
  if (messages.length === 0) return { ok: true, accion: "omitido", motivo: "Sin mensajes del cliente." };

  const ctx: Ctx = {
    sb, contacto, conv, agente, escalado: { v: false },
    remitente, modoAuto, consultasTurno: { n: 0 }, traslados, cotizacionTraslado: null,
  };
  const herramientas = traslados ? [...TOOLS, HERRAMIENTA_COTIZAR_TRASLADO] : TOOLS;

  // ── Bucle agéntico (manual) ────────────────────────────────────────────────
  let textoFinal = "";
  try {
    for (let iter = 0; iter < 6; iter++) {
      const req: any = {
        model: modelo,
        max_tokens: 1500,
        system,
        tools: herramientas,
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

  // El modelo no pone números: si su texto trae un importe que no es de la cotización de traslado
  // de este turno (en revisión, ninguno), el mensaje lo escribe el código.
  textoFinal = textoSinImportesAjenos(textoFinal, ctx.cotizacionTraslado, agente, contactoInicial);

  if (agente.firma) textoFinal = `${textoFinal}\n${agente.firma}`;

  // ── Decidir: enviar (autónomo) o dejar borrador (copiloto) ──────────────────
  const puedeAuto = modoAuto;

  if (puedeAuto) {
    // Justo antes de enviar: si mientras pensaba contestó una persona (desde el celular o el
    // CRM), u otra corrida de la IA, o se pausó la IA, no se manda: serían dos respuestas.
    const { data: ahora } = await sb.from("crm_conversaciones").select("ia_pausada").eq("id", convId).maybeSingle();
    const { count: nuevos } = await sb
      .from("crm_mensajes").select("id", { count: "exact", head: true })
      .eq("conversacion_id", convId).eq("direccion", "saliente").gte("created_at", inicioRespuesta);
    // …y si el cliente escribió otra cosa mientras se redactaba, responde la corrida de ese
    // mensaje con todo junto (esta respuesta ya quedó vieja).
    const { data: ultEnt } = await sb
      .from("crm_mensajes").select("id").eq("conversacion_id", convId).eq("direccion", "entrante")
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (ultimoVisto && ultEnt && ultEnt.id !== ultimoVisto)
      return { ok: true, accion: "omitido", motivo: "El cliente siguió escribiendo; responde la corrida de su último mensaje." };
    // La pausa que puso esta misma corrida al derivar no cuenta.
    if ((ahora?.ia_pausada && !ctx.escalado.v) || (nuevos ?? 0) > 0)
      return { ok: true, accion: "omitido", motivo: "Ya respondió otra persona o la IA se pausó mientras se redactaba." };
    if (agente.delay_segundos > 0)
      await new Promise((r) => setTimeout(r, Math.min(agente.delay_segundos, 30) * 1000));
    const err = await enviarPorCanal(sb, conv, contacto, textoFinal, waDestinoInicial);
    if (err) {
      // Si falla el envío, al menos deja el borrador
      await sb.from("crm_conversaciones").update({ borrador_ia: textoFinal, borrador_ia_at: new Date().toISOString() }).eq("id", convId);
      return { ok: false, accion: "borrador", texto: textoFinal, error: err };
    }
    // El PDF de la cotización de traslado sale DESPUÉS del texto, y solo si el texto salió. Si
    // falla, la acción vuelve a «pendiente» con su error y la envía un ejecutivo desde la bandeja.
    const pdf = ctx.cotizacionTraslado?.envioPendiente;
    if (pdf) {
      try {
        const env = await enviarCotizacionTraslado(sb, {
          accionId: pdf.accionId, por: "automatico", bytes: pdf.bytes, nombre: pdf.nombre, caption: pdf.caption,
          esperado: { conversacionId: String(conv.id), cotizacionId: pdf.cotizacionId },
        });
        if (!env.ok) console.warn(`[crm-ia] ${convId} cotización de traslado no enviada: ${env.codigo} · ${env.detalle}`);
      } catch (e: any) {
        console.error(`[crm-ia] ${convId} cotización de traslado:`, e?.message ?? e);
      }
    }
    return { ok: true, accion: ctx.escalado.v ? "escalado" : "enviado", texto: textoFinal };
  }

  // Copiloto: guardar como borrador para que un humano lo apruebe
  await sb
    .from("crm_conversaciones")
    .update({ borrador_ia: textoFinal, borrador_ia_at: new Date().toISOString() })
    .eq("id", convId);
  return { ok: true, accion: ctx.escalado.v ? "escalado" : "borrador", texto: textoFinal };
}

/** Prueba el agente con historial multi-turno (no envía nada, no toca el ERP de forma destructiva salvo lecturas). */
export async function probarAgente(mensaje: string, historial: Anthropic.MessageParam[] = []): Promise<{ ok: boolean; texto?: string; herramientas: string[]; error?: string }> {
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, herramientas: [], error: "Falta ANTHROPIC_API_KEY." };
  const sb = db();
  const { data: agentes } = await sb.from("crm_agentes_ia").select("*").order("created_at").limit(1);
  const agente = agentes?.[0];
  if (!agente) return { ok: false, herramientas: [], error: "No hay agente configurado." };

  const contacto = { id: "test", nombre: null, empresa: null, telefono: null, wa_id: null, email: null };
  const conv = { id: "test", canal: "whatsapp", estado: "abierta", pipeline_id: null };
  const ctx: Ctx = { sb, contacto, conv, agente, escalado: { v: false } };
  const modelo = MODELOS_VALIDOS.has(agente.modelo) ? agente.modelo : "claude-opus-4-8";
  const empresa = await nombreEmpresa(sb);
  const traslados = (await leerConfigIA(sb)).iaCotiza;
  // En la prueba, «primer mensaje del día» = el agente todavía no contestó en este chat de prueba.
  const system = construirSystem(agente, contacto, conv, !historial.some((m) => m.role === "assistant"), empresa, { traslados });
  const messages: Anthropic.MessageParam[] = [...historial, { role: "user", content: mensaje }];
  const usadas: string[] = [];
  const textosCliente = messages.filter((m) => m.role === "user" && typeof m.content === "string").map((m) => m.content as string);
  const herramientas = traslados ? [...TOOLS, HERRAMIENTA_COTIZAR_TRASLADO] : TOOLS;

  try {
    let textoFinal = "";
    for (let iter = 0; iter < 6; iter++) {
      const req: any = { model: modelo, max_tokens: 1500, system, tools: herramientas, messages, ...modelExtras(modelo) };
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
            : tu.name === "cotizar_traslado"
            ? await cotizarTrasladoDePrueba(sb, agente, tu.input, textosCliente, empresa)
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

/** Las instrucciones exactas que recibe la IA con la configuración guardada (para mostrarlas
 *  en /crm/agente). Cliente de ejemplo, primer mensaje del día. */
export async function vistaPreviaInstrucciones(): Promise<string | null> {
  const sb = db();
  const { data } = await sb.from("crm_agentes_ia").select("*").order("created_at").limit(1);
  const agente = data?.[0];
  if (!agente) return null;
  const contacto = { id: "ejemplo", nombre: "María Pérez", empresa: null, telefono: null };
  const traslados = (await leerConfigIA(sb)).iaCotiza;
  return construirSystem(agente, contacto, { id: "ejemplo", canal: "whatsapp" }, true, await nombreEmpresa(sb), { traslados });
}

/**
 * `cotizar_traslado` en la PRUEBA del agente: cotiza con el motor de verdad (el mismo del
 * simulador) como si escribiera un número peruano de prueba, y dice qué haría con el envío. No
 * crea cotización, acción ni nota, y no envía nada.
 */
async function cotizarTrasladoDePrueba(sb: SB, agente: any, input: any, textos: string[], empresa: string): Promise<string> {
  try {
    // En la prueba no hay ubicaciones compartidas: las coordenadas que proponga el modelo no valen.
    // Los mensajes de prueba sí cuentan para confirmar un pedido de dólares, como en un chat real.
    const v = validarEntrada(entradaDelAgente(input, { canal: "whatsapp", waId: TELEFONO_PRUEBA_TRASLADOS }, [], textos));
    if (!v.ok) return respuestaDerivar();
    const hoy = fechaLima(Date.now());
    const sim = await simularTrasladoConCatalogo(sb, v.entrada, hoy);
    if (!sim.respuesta.ok || !sim.catalogo) return respuestaDerivar();
    const r = sim.respuesta.resultado;
    if (r.codigo !== "cotizable") return respuestaParaModelo({ resultado: r });
    const fila = filaCotizacionTraslado(r, v.entrada, { convId: "prueba", clienteId: null, atencion: null, config: sim.catalogo.config, firma: "prueba", hoy });
    const autonomos: string[] = Array.isArray(agente.canales_autonomos) ? agente.canales_autonomos : [];
    const plan = planEnvio({
      resultado: r, envioMaestro: sim.catalogo.config.envio_automatico === true, zonas: sim.catalogo.zonas,
      canal: "whatsapp", waId: TELEFONO_PRUEBA_TRASLADOS, modoAuto: autonomos.includes("whatsapp") && dentroHorario(agente),
      perfilConfigurado: !!empresa, cuadra: cuadraConMotor(fila, r), pdfOk: true, palabras: senalesEnTexto(textos),
      textosLibres: [input?.origen_texto, input?.destino_texto],
    });
    return respuestaParaModelo({ resultado: r, cotizacion: { numero: "PRUEBA", decision: plan.decision } });
  } catch {
    return respuestaDerivar();
  }
}
