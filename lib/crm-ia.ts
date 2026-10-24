// ============================================================
// Agente IA del CRM — Claude (Anthropic)
// Motor conversacional con tool-use contra el ERP real.
// SOLO servidor: usa ANTHROPIC_API_KEY + service-role de Supabase.
// ============================================================
import Anthropic from "@anthropic-ai/sdk";
import { bloqueParaIA } from "@/lib/crm-media";
import {
  normalizarAjustes, saludoParaHora, presentacion, estiloDe, mensajeDerivacionDefecto, tituloResumen, cierreResumen,
  MOTIVOS_DERIVACION_SISTEMA, type AjustesIA, type ModoPreguntas,
} from "@/lib/crm-ia-ajustes";
import { atencionDe, atencionEnUso, describirAtencion, dentroDeAtencion, proximaAtencion, fraseFueraDeAtencion } from "@/lib/crm-ia-atencion";
import { esAudio, esTranscripcion, transcribirMensaje, PREFIJO_TRANSCRIPCION } from "@/lib/crm-audio";
import { createClient } from "@supabase/supabase-js";
import { marcarLeidoYEscribiendo } from "@/lib/crm-meta";
import { textoLegible } from "@/lib/crm-gmail-reglas";
import {
  entradaDelAgente, figurasPermitidas, herramientaCotizarTraslado, idiomaDeGuarda, planEnvio, respuestaDerivar,
  respuestaParaModelo, senalesEnTexto, textoFinalTraslado,
} from "@/lib/traslados/envio-ia";
import { fmtFechaDoc, fmtImporte, type Idioma } from "@/lib/cotizacion-idioma";
import { cuadraConMotor, filaCotizacionTraslado } from "@/lib/traslados/cotizacion-traslado";
import { cotizarTrasladoIA, entrantesDe, idiomaDelTurno, type ResultadoCotizarIA } from "@/lib/traslados/cotizar-ia-datos";
import { leerInglesTraslado } from "@/lib/traslados/plantilla-traslado-datos";
import { inglesActivo, type InglesTraslado } from "@/lib/cotizacion-plantillas";
import { idiomaDelCliente, type IdiomaCliente, type MensajeParaIdioma } from "@/lib/idioma-cliente";
import { enviarCotizacionTraslado } from "@/lib/traslados/enviar-cotizacion-datos";
import { leerConfigIA, type ConfigIA } from "@/lib/traslados/datos";
import { validarEntrada } from "@/lib/traslados/api";
import { simularTrasladoConCatalogo } from "@/lib/traslados/servicio";
import { fechaLima } from "@/lib/alertas-horario";
import { faltaColumna } from "@/lib/columna-faltante";
import { inicioVentanaHumano, inicioConteoTurnos, horasPausaHumano as horasPausaDeAgente } from "@/lib/crm-ia-reactivacion";
import { primerNombreSeguro, type IdiomaTexto } from "@/lib/traslados/texto-libre";
import { limpiarTextoModelo, saludoDeBooleano, saludoDelTurno, textosSinContestar, type SaludoDelTurno } from "@/lib/crm-ia-mensaje";
import { CONTESTA, MOTIVO_ULTIMO, juzgarUltimo, leerMarca, marcaVigente, ordenarRafaga, type MarcaRespuesta } from "@/lib/crm-ia-rafaga";
import { enviarTextoCRM, waDestinoDe } from "@/lib/crm-enviar-texto";
import {
  HERRAMIENTAS_RESERVA, FRASE_PROPONER_RESERVA_TRASLADOS, FRASE_RESERVAR_TRASLADO, bloqueReservaTraslados, respuestaReservaParaModelo,
  textoFinalReserva, type ResultadoReservaIA,
} from "@/lib/traslados/reserva-ia";
import type { ConfigReserva } from "@/lib/traslados/reserva-pago";
import { cancelarIA, cotizacionTrasladoDelChat, politicasIA, reportarPagoIA, reservaEstadoIA, reservarTrasladoIA, type CtxReservaIA } from "@/lib/traslados/reserva-solicitud-datos";

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

/** Un momento de Lima: fecha ISO y "HH:MM". */
export type MomentoLima = { fecha: string; hora: string };

/** Lo que leen de `crm_agentes_ia` el prompt y los textos del código (el resto de la fila, tal cual). */
export type AgenteIAConfig = {
  comportamiento?: unknown;
  nombre?: string | null;
  escalar_si?: string | null;
  pausa_humano_horas?: unknown;
  mensaje_derivacion?: string | null;
  idioma?: string | null;
  [columna: string]: unknown;
};

/**
 * El mensaje de derivación con el nombre del cliente puesto. Lo escribe el CÓDIGO (lo cita el prompt
 * y lo usa `textoFinalTraslado`), así que habla con el trato del agente:
 *  · sin plantilla propia, la de `mensajeDerivacionDefecto(tratamiento)` (con «tu», byte a byte la
 *    de antes de existir el ajuste) y, fuera del horario de atención del equipo declarado y válido,
 *    la frase de cuándo responde un ejecutivo (`fraseFueraDeAtencion`, "" dentro del horario);
 *  · con la plantilla del dueño, su texto tal cual: la frase del horario solo entra donde él
 *    escriba {atencion} (si no la escribe, el auditor lo avisa en /crm/agente; no se le pega nada
 *    a un texto que escribió una persona).
 *  · EN INGLÉS (`opts.idioma`, lo decide el código: el idioma de la cotización o del cliente en el
 *    turno), la plantilla propia del dueño NO se usa —está en castellano y no se traduce lo que
 *    escribió una persona—: va la del sistema en inglés, con la frase del horario en inglés.
 * `ahora` (Lima) es para probarlo; sin él, el momento actual.
 */
export function mensajeDerivacion(
  agente: AgenteIAConfig | null | undefined, contacto: { nombre?: string | null } | null | undefined, ahora?: MomentoLima,
  opts: { idioma?: Idioma } = {},
): string {
  const aj = ajustesDe(agente);
  const m = ahora ?? ahoraLima(aj);
  const en = opts.idioma === "en";
  const fuera = fraseFueraDeAtencion(atencionDe(aj), m.fecha, m.hora, aj.tratamiento, en ? "en" : "es");
  const propia = en ? "" : String(agente?.mensaje_derivacion ?? "").trim();
  let plantilla = propia || `${mensajeDerivacionDefecto(aj.tratamiento, en ? "en" : "es")}${fuera}`;
  if (propia && /\{atencion\}/.test(propia)) {
    // La frase trae su espacio inicial: «…brevedad.{atencion}» y «…brevedad. {atencion}» quedan
    // iguales, y dentro del horario la llave se va sin dejar espacios colgando.
    plantilla = propia.replace(/\{atencion\}/g, () => fuera).replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/gm, "").trim();
  }
  // El nombre lo elige el cliente en su perfil de WhatsApp y este mensaje lo escribe el código:
  // pasa por el mismo filtro que el mensaje de la cotización (un «S/150» no se repite).
  const n = primerNombreSeguro(primerNombre(contacto));
  return plantilla.replace(/\{nombre\}/g, () => n).replace(/,\s*([.!?])/g, "$1").replace(/\s+,/g, ",").replace(/[ \t]+([.!?])/g, "$1");
}

/** Horas que la IA se aparta cuando contesta una persona del equipo. La MISMA lectura con que el
 *  motor decide (responderConIAInterno) y con que el prompt lo dice: 12 si no hay un número. Vive en
 *  lib/crm-ia-reactivacion.ts (pura): la reserva de traslados la usa sin importar este módulo. */
export function horasPausaHumano(agente: AgenteIAConfig | null | undefined): number {
  return horasPausaDeAgente(agente);
}

/** El idioma por defecto de las respuestas (`crm_agentes_ia.idioma`). */
function idiomaPorDefecto(agente: AgenteIAConfig | null | undefined): string {
  return agente?.idioma === "en" ? "inglés" : "español peruano";
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
      // Los motivos son una constante compartida con el bloque «Ajustes del agente» y el auditor de
      // /crm/agente (lib/crm-ia-coherencia.ts): los tres dicen lo mismo de cuándo se deriva.
      `Pasa la conversación a un ejecutivo y pausa tu intervención. Úsala ${MOTIVOS_DERIVACION_SISTEMA}. Una solicitud de COTIZACIÓN no es motivo para derivar: para eso están cotizacion_estimada y proponer_cotizacion. Tras llamarla responde con el mensaje de derivación: un ejecutivo revisará y le enviará la información por este chat.`,
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
  /**
   * El idioma del cliente y si el inglés está encendido, resueltos por el CÓDIGO una vez por turno
   * (`idiomaDelCliente` sobre sus mensajes + `leerInglesTraslado`): `cotizar_traslado` los lee de aquí.
   */
  idiomaIA?: { cliente: IdiomaCliente | null; ingles: InglesTraslado | null };
  /**
   * La reserva de traslados (lib/traslados/reserva-solicitud-datos.ts): se ofrece SOLO con
   * traslados, `reserva_ia` encendida (y las migraciones corridas) y el agente autónomo. Lo que
   * devuelve cada herramienta de reserva en el turno va a `resultados` (de ahí sale el texto final).
   */
  reserva?: { activa: boolean; cfg: ConfigReserva; turno: { n: number }; resultados: ResultadoReservaIA[] };
  /**
   * La pausa tras la actividad de una persona (`pausa_humano_horas`) y la reactivación del chat
   * (`ia_reactivada_at`), las MISMAS con que este turno decidió contestar: la cotización de traslado que
   * una persona corrigió se juzga con ellas (lib/traslados/cotizacion-corregida.ts).
   */
  pausa?: { horas: number; reactivadaAt: string | null };
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
          {
            sb, conv, contacto, remitente: ctx.remitente, modoAuto: ctx.modoAuto === true, consultasTurno: ctx.consultasTurno,
            // El modo de preguntar sale de los ajustes del agente, y el idioma del código: nunca del modelo.
            preguntas: ajustesDe(ctx.agente).preguntas,
            ...(ctx.idiomaIA ? { idioma: ctx.idiomaIA } : {}),
            ...(ctx.pausa ? { pausa: ctx.pausa } : {}),
          },
          input,
        );
        ctx.cotizacionTraslado = r;
        if (r.derivar) await derivarConversacion(ctx, r.derivar.motivo, r.derivar.pedido, r.derivar.nota);
        return r.respuestaModelo;
      }

      case "reservar_traslado":
      case "reportar_pago_traslado":
      case "politicas_reserva":
      case "cancelar_reserva_traslado": {
        if (!ctx.reserva?.activa || !ctx.remitente)
          return respuestaReservaParaModelo("derivar");
        const cr: CtxReservaIA = {
          sb, conv, contacto, remitente: ctx.remitente, agente: ctx.agente, modoAuto: ctx.modoAuto === true,
          cfg: ctx.reserva.cfg, turno: ctx.reserva.turno, ...(ctx.pausa ? { pausa: ctx.pausa } : {}),
        };
        const fn = name === "reservar_traslado" ? reservarTrasladoIA
          : name === "reportar_pago_traslado" ? reportarPagoIA
          : name === "politicas_reserva" ? politicasIA : cancelarIA;
        const r = await fn(cr, input);
        ctx.reserva.resultados.push(r);
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
 * El único renglón que depende de un ajuste es el de preguntar: con «uno por mensaje» pide SOLO el
 * siguiente dato, el que indique la herramienta (su orden es el del motor, el mismo que usa el
 * «me falta» que escribe el código: lib/traslados/envio-ia.ts → fraseFaltanTraslado).
 */
export function bloqueTraslados(p: ModoPreguntas, opts: { reserva?: boolean; ingles?: boolean } = {}): string {
  const lineas = [
    "## Traslados simples (cotización con el tarifario)",
    "- Un traslado simple es UN punto de recojo → UN destino (por ejemplo aeropuerto ↔ hotel o domicilio), solo ida o ida y retorno, en una sola fecha y con un solo vehículo. Para eso usa cotizar_traslado: el vehículo, el precio, la moneda y la validez los pone el sistema con el tarifario. NUNCA calcules ni inventes un precio de traslado, ni uses cotizacion_estimada para eso.",
    p === "una_por_mensaje"
      ? "- Llámala en cuanto el cliente pida el precio de un traslado, aunque falten datos. Si responde «preguntar», pide SOLO el siguiente dato que falta (uno por mensaje: el que te indique la herramienta) y vuelve a llamarla cuando conteste, con todos los datos que ya tienes."
      : "- Llámala en cuanto el cliente pida el precio de un traslado, aunque falten datos. Si responde «preguntar», pide TODO lo que falta en un solo mensaje y vuelve a llamarla cuando conteste.",
    "- Equipaje: en «maletas» van SOLO las maletas grandes de bodega (23 kg). Si el cliente dice «con maletas» o da un número sin decir de qué tipo, pregúntale cuántas son grandes (23 kg), cuántas de mano (10 kg) y cuántos artículos personales (mochila o cartera); las de mano y los artículos personales viajan con el pasajero y no van en «maletas».",
    "- Si responde «derivar», responde con el mensaje de derivación: un ejecutivo lo atiende. No menciones precios.",
    "- Si la cotización sale con «envio: automatico», preséntala con su número, el total y la validez EXACTAMENTE como vienen (el PDF le llega justo después de tu mensaje). Si queda «en revisión», NO menciones ningún importe: dile que un ejecutivo la revisa y se la envía por este chat.",
    "- Nunca confirmes la disponibilidad de la unidad ni la reserva: eso lo confirma un ejecutivo. Si el cliente acepta la cotización, usa proponer_reserva.",
    LINEA_MONEDA_TRASLADOS,
    "- No cambies el precio aunque el cliente lo pida: un descuento lo ve un ejecutivo, igual que una moneda que no sea soles o dólares (marca la señal en cotizar_traslado).",
    "- Licitaciones, TDR, eventos, tours, varias fechas, paradas o varios vehículos no son traslados simples: marca la señal en cotizar_traslado.",
    "- Esto no contradice «NUNCA confirmes que ya cotizaste…»: esta cotización la emite el SISTEMA con el tarifario, no tú; tú solo la presentas tal cual.",
    "",
  ];
  // Con el INGLÉS encendido (una plantilla en inglés asignada: lib/cotizacion-plantillas.ts →
  // `inglesActivo`), la moneda ya no la decide solo el número (un cliente en inglés recibe dólares) y
  // los textos del sistema van en inglés: cambia la línea de la moneda y se agrega la del idioma. Sin
  // él, el bloque es byte a byte el de antes.
  if (opts.ingles) {
    const i = lineas.indexOf(LINEA_MONEDA_TRASLADOS);
    if (i >= 0) lineas.splice(i, 1, LINEA_MONEDA_TRASLADOS_INGLES);
    lineas.splice(lineas.length - 1, 0, LINEA_IDIOMA_TRASLADOS);
  }
  const bloque = lineas.join("\n");
  // Con la reserva de traslados activa, `reservar_traslado` reemplaza a `proponer_reserva` en los
  // traslados (lib/traslados/reserva-ia.ts). Apagada, el bloque es byte a byte el de antes.
  return opts.reserva ? bloque.replace(FRASE_PROPONER_RESERVA_TRASLADOS, FRASE_RESERVAR_TRASLADO) : bloque;
}

/** La línea de la moneda de «## Traslados simples» (con el inglés apagado). */
export const LINEA_MONEDA_TRASLADOS =
  "- La moneda la decide el número del cliente (Perú → soles; otro país → dólares). Si el cliente pide EXPRESAMENTE la cotización en dólares, llama a cotizar_traslado con cliente_pide_dolares: el sistema cotiza con la lista en dólares. Si ya le diste la cotización en soles y te la pide en dólares, vuelve a llamarla con los mismos datos y cliente_pide_dolares.";
/** La misma línea con el inglés encendido (la misma regla que la descripción de la herramienta). */
export const LINEA_MONEDA_TRASLADOS_INGLES =
  "- La moneda la decide el sistema según el idioma del cliente y su número (en castellano, por el número: Perú → soles, otro país → dólares; en inglés, dólares). Si el cliente pide EXPRESAMENTE la cotización en dólares, llama a cotizar_traslado con cliente_pide_dolares; si la pide en soles, con cliente_pide_soles (en castellano desde un número de otro país, los soles los ve un ejecutivo: marca la señal otra_moneda). Si ya le diste la cotización en una moneda y te la pide en la otra, vuelve a llamarla con los mismos datos y la marca de la moneda que pidió.";
/** Lo que se agrega con el inglés encendido: a un cliente en otro idioma se le contesta en inglés (el código le escribe en inglés). */
export const LINEA_IDIOMA_TRASLADOS =
  "- Si el cliente escribe en un idioma que no es castellano ni inglés, contéstale en inglés: la cotización, el PDF y los mensajes del sistema le llegan en inglés.";

/** El bloque con el modo de preguntar por defecto («todo junto»). */
export const BLOQUE_TRASLADOS = bloqueTraslados("todo_junto");

/**
 * «## Ajustes del agente»: UNA línea por tema que tiene ajuste en /crm/agente, armada con los MISMOS
 * ajustes que leen los textos del código (la derivación, el «me falta» de traslados, el resumen).
 * Va entre las reglas del negocio y la prioridad, y la prioridad dice que en estos temas MANDA EL
 * AJUSTE aunque la persona, «Sobre la empresa», los objetivos o la base de conocimiento digan otra
 * cosa (antes un ajuste perdía contra cualquier frase de la empresa: se veía y no decidía).
 * Solo van los temas con valor: un booleano apagado (saludo, resumen, ocultar la IA) no tiene línea,
 * y ahí sigue mandando lo que escribió la empresa. El trato, el modo de preguntar y cuándo se deriva
 * van siempre. `ahora` (Lima) es para probarlo; sin él, el momento actual.
 */
export function bloqueAjustes(agente: AgenteIAConfig | null | undefined, empresa = "", ahora?: MomentoLima): string {
  const aj = ajustesDe(agente);
  const m = ahora ?? ahoraLima(aj);
  const emp = empresa || "la empresa";
  const una = aj.preguntas === "una_por_mensaje";
  const l: string[] = ["## Ajustes del agente (mandan sobre lo que digan los textos de la empresa)"];
  l.push(aj.tratamiento === "tu"
    ? "- Trato: de tú (tú, tu, te) en todos tus mensajes."
    : "- Trato: de usted (usted, su, le) en todos tus mensajes, aunque el cliente te tutee.");
  // Sin el bloque del resumen, «los datos del pedido» no estarían en ninguna parte: se nombran aquí.
  l.push(una
    ? `- Datos que faltan: pide UNO por mensaje, en el orden de los datos del pedido; cuando conteste, el siguiente. No adelantes las otras preguntas.${aj.resumen_pedido ? "" : ` Datos del pedido, en orden: ${aj.campos_pedido}.`}`
    : "- Datos que faltan: pídelos todos juntos, en un solo mensaje.");
  if (aj.resumen_pedido) {
    l.push(`- Resumen del pedido: ${aj.resumen_cuando === "cada_respuesta" ? "al final de cada respuesta mientras falten datos" : "una sola vez, al final"}, con el formato de «Resumen del pedido».`);
  }
  if (aj.saludo_activo) {
    l.push(`- Saludo y presentación: los del bloque de saludo; te presentas como ${presentacion(aj, emp, agente?.nombre)}. No uses otro saludo, otra presentación ni otro menú.`);
    const menu = aj.menu_saludo.trim();
    if (menu) l.push(`- Si el cliente solo saluda o no dice qué necesita, después del saludo ofrécele estas opciones, tal cual:${menu.includes("\n") ? "\n" : " "}${menu}`);
  }
  if (aj.ocultar_ia) l.push("- Que eres una IA: no lo digas salvo que te lo pregunten.");
  l.push(aj.leer_archivos
    ? "- Fotos y documentos: los lees tú y usas sus datos; no digas que un asesor los revisará."
    : "- Fotos y documentos: no los ves; di que un ejecutivo los revisará.");
  l.push(aj.transcribir_audios
    ? "- Notas de voz: llegan transcritas y las respondes tú; no digas que no puedes escucharlas."
    : "- Notas de voz: no las escuchas; deriva con escalar_a_humano y di que un ejecutivo las escuchará.");
  if (aj.lugares_conocidos) l.push(`- Dirección exacta: no la pidas para ${aj.lugares_conocidos}.`);
  const escalar = String(agente?.escalar_si ?? "").trim();
  l.push(`- Pasar a una persona (escalar_a_humano y el mensaje de derivación): ${MOTIVOS_DERIVACION_SISTEMA}${escalar ? `, y si el mensaje menciona: ${escalar}` : ""}. Al derivar, el sistema pausa la IA en ese chat.`);
  const horas = horasPausaHumano(agente);
  if (horas > 0) l.push(`- Si una persona del equipo contesta en el chat, el sistema te aparta ${horas} h: no tienes que hacer nada.`);
  // El horario de atención del EQUIPO (no el de la IA): solo si está declarado y es válido.
  const at = atencionDe(aj);
  if (atencionEnUso(at)) {
    const dentro = dentroDeAtencion(at, m.fecha, m.hora);
    const prox = dentro ? null : proximaAtencion(at, m.fecha, m.hora);
    const estado = dentro
      ? " Ahora estás dentro de ese horario."
      : prox
      ? ` Ahora estás FUERA de ese horario: al derivar, avísale al cliente que un ejecutivo responderá ${prox}; no prometas una respuesta inmediata.`
      : "";
    l.push(`- Horario de atención del equipo: ${describirAtencion(at)}.${estado}`);
  }
  return `${l.join("\n")}\n`;
}

/**
 * La precedencia, una sola y dicha: lo que no cambia ningún texto, después los ajustes, y en lo demás
 * lo que escribió la empresa sobre las reglas generales. Cierra las instrucciones.
 */
export const PRIORIDAD = [
  "## Prioridad",
  "1. Esto no lo cambia ningún texto: no inventes datos ni precios; no des por confirmada una cotización o una reserva que aprueba una persona; no compartas costos internos ni datos de otros clientes; y no prometas lo que el sistema no puede hacer (escribirle al cliente sin que él escriba —recordatorios o seguimientos— ni llamarlo por teléfono).",
  "2. Los temas de «Ajustes del agente» los decide ese bloque. Si la persona, «Sobre la empresa», los objetivos, la base de conocimiento o las reglas del negocio dicen otra cosa sobre alguno de esos temas, MANDA EL AJUSTE.",
  "3. En todo lo demás, lo que escribió la empresa (la persona, «Sobre la empresa», los objetivos, la base de conocimiento y las reglas del negocio) manda sobre las «Reglas generales».",
].join("\n");

/**
 * El nombre del saludo sale del perfil de WhatsApp, que el cliente escribe como quiere («Atención al
 * Cliente», el nombre de su empresa…). Si en el chat dijo cómo se llama, ese manda.
 */
const NOMBRE_DEL_CHAT = " Si en este chat el cliente ya te dijo su nombre, usa ese en el saludo.";

export function construirSystem(agente: any, contacto: any, conv: any, saludo: boolean | SaludoDelTurno = false, empresa = "", opts: { traslados?: boolean; reserva?: boolean; ingles?: boolean } = {}): string {
  const aj = ajustesDe(agente);
  // `true`/`false` es la forma de antes («primer mensaje del día»); lib/crm-ia-mensaje.ts decide los tres casos.
  const sal = typeof saludo === "boolean" ? saludoDeBooleano(saludo) : saludo;
  const ahora = ahoraLima(aj);
  const emp = empresa || "la empresa";
  const nombre = primerNombre(contacto);
  const una = aj.preguntas === "una_por_mensaje";
  // «Datos del pedido» escritos con emojis (📅 Fecha, 👥 Pasajeros…): el resumen los usa en vez de «•».
  const conEmoji = /\p{Extended_Pictographic}/u.test(aj.campos_pedido);
  const goals: { titulo: string; instrucciones: string }[] = Array.isArray(agente.goals) ? agente.goals : [];
  const goalsTxt = goals.length
    ? goals.map((g, i) => `${i + 1}. ${g.titulo}: ${g.instrucciones}`).join("\n")
    : "Atender al cliente con cordialidad y resolver su consulta.";
  const reglasNegocio = aj.reglas_extra
    ? aj.reglas_extra.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => (l.startsWith("-") ? l : `- ${l}`)).join("\n")
    : "";
  // El SIGUIENTE dato, no todos: lo que dicen el resumen, «lo que el cliente ya dijo» y traslados
  // cuando el agente pregunta de a uno (comportamiento.preguntas = "una_por_mensaje").
  const SIGUIENTE = "pide SOLO el siguiente dato que falta (uno por mensaje, en el orden de los datos del pedido)";

  // ORDEN: primero lo general (fecha, saludo, reglas del sistema) y AL FINAL lo que escribió la
  // empresa (objetivos, base de conocimiento, reglas del negocio), los AJUSTES del agente y la
  // prioridad que dice quién manda. Antes los objetivos iban arriba y las reglas generales después,
  // y una regla general («mensajes cortos», «no repitas una pregunta») le ganaba a una del dueño
  // («al final, resume los datos y pide solo lo que falta»).
  return [
    agente.persona || `Eres el asistente comercial de ${emp}.`,
    "",
    "## Sobre la empresa",
    agente.empresa_contexto || `${emp} — empresa de transporte.`,
    "",
    "## Fecha y hora",
    `Hoy es ${ahora.fecha} y son las ${ahora.hora} en Lima. «Mañana» = el día siguiente a esa fecha.`,
    "",
    !aj.saludo_activo ? "" : sal.modo === "primero"
      ? `## SALUDO OBLIGATORIO\nEs tu PRIMER mensaje del día con este cliente: tu respuesta DEBE empezar con «${ahora.saludo}${nombre ? `, ${nombre}` : ""}», seguido de una presentación breve si corresponde, y recién después responder o preguntar. No omitas el saludo aunque el cliente no salude ni aunque necesites pedirle datos.${NOMBRE_DEL_CHAT}\n`
      : sal.modo === "devolver"
      ? `## SALUDO\nYa conversaron hoy, pero el cliente te acaba de saludar: tu respuesta DEBE empezar devolviéndole el saludo en pocas palabras («${ahora.saludo}${nombre ? `, ${nombre}` : ""}»)${sal.presentarse ? ", seguido de una presentación breve (todavía no te presentaste hoy en este chat)" : ""}, y recién después responder o preguntar.${sal.presentarse ? "" : " No te vuelvas a presentar."}${NOMBRE_DEL_CHAT}\n`
      : "## Saludo\nYa conversaste hoy con este cliente: NO vuelvas a saludar ni a presentarte.\n",
    "## Canal y contacto",
    `Estás respondiendo por ${conv.canal}. Cliente: ${contacto.nombre ?? "desconocido"}${contacto.empresa ? ` (${contacto.empresa})` : ""}${contacto.telefono ? `, tel ${contacto.telefono}` : ""}.`,
    "",
    "## Reglas generales",
    `- Responde SIEMPRE en el idioma del cliente (por defecto ${idiomaPorDefecto(agente)}). Mensajes claros y útiles, estilo WhatsApp, sin relleno (el resumen del pedido no cuenta como relleno).`,
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
    `- Mensaje de derivación (adáptalo mínimamente, sin quitar la idea de que un ejecutivo revisará y enviará la información por este chat): «${mensajeDerivacion(agente, contacto, ahora)}»`,
    aj.ocultar_ia
      ? `- No reveles que eres una IA salvo que te lo pregunten directamente; preséntate como ${presentacion(aj, emp, agente?.nombre)}.`
      : `- Preséntate como ${presentacion(aj, emp, agente?.nombre)}.`,
    "- No compartas costos internos, márgenes ni datos de otros clientes.",
    "- Devuelve solo el texto del mensaje al cliente, sin prefijos como 'Asistente:'.",
    !aj.leer_archivos ? "- Si el cliente envía fotos o documentos, dile que un ejecutivo los revisará (no los ves)." : "- Si el cliente envía FOTOS o DOCUMENTOS, LÉELOS: extrae fechas, horarios, número de pasajeros, origen, destino y lo que pida. Nunca digas que no puedes verlos.",
    aj.resumen_pedido && aj.resumen_cuando === "cada_respuesta"
      ? `- No insistas con una pregunta suelta que ya hiciste. Lo que falte va en el ${una ? "«Lo siguiente que necesito» del resumen del pedido (de a uno)" : "«Solo me falta» del resumen del pedido"}, que SÍ va en cada respuesta mientras el pedido no esté completo.`
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
          una
            ? `- Si falta algo indispensable, ${SIGUIENTE}. No condiciones la atención a que te dé su nombre: avanza con lo que tienes y pídeselo cuando le toque.`
            : "- Si falta algo indispensable, pide TODO lo que falte en un solo mensaje. No condiciones la atención a que te dé su nombre: si falta, pídelo en el mismo mensaje en que avanzas.",
          "- Con los datos del servicio completos, avanza: precio referencial con cotizacion_estimada y proponer_cotizacion para que el equipo lo confirme.",
          "",
        ].filter(Boolean).join("\n")
      : "",
    aj.resumen_pedido && aj.resumen_cuando === "al_final"
      ? [
          "## Resumen del pedido (UNA vez, cuando ya tienes todos los datos)",
          `- Datos del pedido: ${aj.campos_pedido}.`,
          `- Mientras falte alguno, NO resumas, no repitas ni confirmes lo que el cliente ya dio: ${una ? `${SIGUIENTE}.` : "pide SOLO lo que falta, todo junto en un solo mensaje."}`,
          "- Cuando ya tengas todos, muestra el resumen completo con este formato:",
          tituloResumen(aj),
          "• <dato>: <lo que dio el cliente>",
          "• …",
          ...(conEmoji ? ["(Si un dato de «Datos del pedido» lleva su emoji, pon ese emoji en su renglón en lugar de «•».)"] : []),
          `y termina con «${cierreResumen(aj, nombre)}».`,
          "- Si después el cliente corrige un dato, vuelve a mostrar el resumen completo actualizado.",
          "- Nunca pongas en el resumen un dato que el cliente no dio.",
          "- Al derivar a un ejecutivo, sí muestra el resumen de lo que ya dio (ahí termina tu parte). No lo pongas en respuestas que no son de un pedido (consultas sobre un servicio en curso, saludos, agradecimientos).",
          "",
        ].join("\n")
      : aj.resumen_pedido
      ? [
          "## Resumen del pedido (al final de tu respuesta)",
          `- Mientras el cliente esté pidiendo un servicio (cotización o reserva), TERMINA cada respuesta con el resumen de lo que ya dio y ${una ? SIGUIENTE : "pide SOLO lo que falta"}. Datos del pedido: ${aj.campos_pedido}.`,
          "- Formato:",
          tituloResumen(aj),
          "• <dato>: <lo que dio el cliente>",
          "• …",
          ...(conEmoji ? ["(Si un dato de «Datos del pedido» lleva su emoji, pon ese emoji en su renglón en lugar de «•».)"] : []),
          una ? "*Lo siguiente que necesito:* <UN dato: el siguiente que falta>" : "*Solo me falta:* <los datos que faltan, juntos en una línea>",
          `- Si ya está todo, cambia la última línea por «${cierreResumen(aj, nombre)}».`,
          una
            ? "- Nunca pongas en el resumen un dato que el cliente no dio: lo que falta se pide en «Lo siguiente que necesito», de a uno."
            : "- Nunca pongas en el resumen un dato que el cliente no dio: lo que no dio va en «Solo me falta».",
          "- También al derivar a un ejecutivo. No lo pongas en respuestas que no son de un pedido (consultas sobre un servicio en curso, saludos, agradecimientos).",
          "",
        ].join("\n")
      : "",
    opts.traslados ? bloqueTraslados(aj.preguntas, { reserva: opts.reserva === true, ...(opts.ingles ? { ingles: true } : {}) }) : "",
    // «## Reserva y pago de traslados»: SOLO con traslados y la reserva activa (si no, nada: el prompt es el de antes).
    opts.traslados && opts.reserva ? bloqueReservaTraslados() : "",
    "## Tus objetivos (goals)",
    goalsTxt,
    "",
    agente.conocimiento ? `## Base de conocimiento\n${agente.conocimiento}\n` : "",
    reglasNegocio ? `## Reglas del negocio\n${reglasNegocio}\n` : "",
    bloqueAjustes(agente, empresa, ahora),
    PRIORIDAD,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Historial de la conversación → mensajes para Claude ──────────────────────

async function cargarHistorial(
  sb: SB, convId: string, aj: AjustesIA = normalizarAjustes(null), marca: MarcaRespuesta | null = null,
): Promise<Anthropic.MessageParam[]> {
  // Los 40 MÁS RECIENTES: antes se pedían los 40 más antiguos (orden ascendente + limit),
  // así que en un hilo largo la IA contestaba sin ver lo último que escribió el cliente.
  // Cuántos relee lo dice Ajustes (40 por defecto): con 20, en un chat donde el cliente repitió
  // su pedido varias veces, los datos del principio quedaban fuera y la IA los volvía a pedir.
  const { data } = await sb
    .from("crm_mensajes")
    .select("id, direccion, contenido, tipo, media_url, created_at, generado_por_ia")
    .eq("conversacion_id", convId)
    .order("created_at", { ascending: false })
    .limit(aj.mensajes_historial);
  // Lo que el cliente escribió mientras la última respuesta se enviaba va DESPUÉS de ella
  // (lib/crm-ia-rafaga.ts): esa respuesta no lo leyó.
  const msgs = ordenarRafaga((data ?? []).reverse(), marca);
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

/**
 * `waDestino`, si se pasa, es el número copiado ANTES del bucle del agente: `actualizar_contacto`
 * deja al modelo reescribir `contacto.telefono` en este mismo turno, y sin wa_id la respuesta iría
 * al número que escribió el modelo. El envío y el registro en el hilo son los de
 * lib/crm-enviar-texto.ts (extraídos de aquí: los usan también las acciones de la reserva).
 */
async function enviarPorCanal(sb: SB, conv: any, contacto: any, texto: string, waDestinoFijo?: string): Promise<string | null> {
  const r = await enviarTextoCRM(sb, conv, contacto, texto, { waDestino: waDestinoFijo });
  return r.error;
}

/**
 * Si en este turno se usó `cotizar_traslado`: con una cotización, el mensaje lo escribe SIEMPRE el
 * código (el modelo no pone el total, el IGV ni la validez); sin ella, el del modelo solo pasa si
 * no menciona dinero (`textoFinalTraslado`). Sin la herramienta en el turno, el texto no se toca.
 * Lo que escribe el código va con el trato y el modo de preguntar del agente (`estiloDe`), los
 * mismos que lee el prompt: si no, el prompt diría «de usted» y el código tutearía.
 * El IDIOMA: el de la cotización del turno (su fila) y, sin cotización, `idiomaTurno` (el del
 * cliente con el inglés encendido; «es» por defecto, byte a byte lo de antes). La GUARDA del dinero
 * va aparte (`idiomaGuarda`, de `idiomaDeGuarda`): «en» también con el inglés APAGADO si el cliente
 * escribe en inglés u otro idioma, porque el modelo le contesta en inglés; el mensaje que la
 * reemplaza sigue en el idioma de siempre. Sin ella, «es»: byte a byte lo de antes.
 */
export function textoSinImportesAjenos(texto: string, ct: ResultadoCotizarIA | null | undefined, agente: any, contacto: any, idiomaTurno: Idioma = "es", idiomaGuarda: IdiomaTexto = "es"): string {
  const en = (ct?.cotizacion?.idioma ?? idiomaTurno) === "en";
  const estilo = estiloDe(ajustesDe(agente));
  return textoFinalTraslado(texto, ct ?? null, {
    derivacion: mensajeDerivacion(agente, contacto, undefined, en ? { idioma: "en" } : {}), estilo: en ? { ...estilo, idioma: "en" } : estilo,
    ...(idiomaGuarda === "en" ? { idiomaGuarda } : {}),
  });
}

/**
 * El idioma del cliente en un turno, resuelto por el CÓDIGO una sola vez: `idiomaDelCliente` sobre
 * sus mensajes y, solo si escribe en inglés u otro idioma, si el inglés está encendido. Sin traslados,
 * sin evidencia o con una lectura que falla: castellano y el inglés apagado (lo de siempre).
 */
async function idiomaDeTurno(sb: SB, x: { convId?: string; mensajes?: MensajeParaIdioma[] | null; traslados: boolean }): Promise<{ cliente: IdiomaCliente | null; ingles: InglesTraslado | null; inglesOn: boolean }> {
  if (!x.traslados) return { cliente: null, ingles: null, inglesOn: false };
  const [ent, li] = await Promise.all([
    x.mensajes !== undefined ? Promise.resolve(x.mensajes) : entrantesDe(sb, x.convId ?? ""),
    leerInglesTraslado(sb).catch(() => ({ ok: false as const, detalle: "" })),
  ]);
  const ingles = li.ok ? li.ingles : null;
  const cliente = ent ? idiomaDelCliente(ent, Date.now()).idioma : null;
  return { cliente, ingles, inglesOn: inglesActivo(ingles) };
}

// ── Entrada principal ────────────────────────────────────────────────────────

export type ResultadoIA = {
  ok: boolean;
  texto?: string;
  accion: "enviado" | "borrador" | "escalado" | "omitido";
  motivo?: string;
  error?: string;
  /** Solo si se ENVIÓ: hasta qué mensaje del cliente leyó esta respuesta (lib/crm-ia-rafaga.ts). */
  marca?: MarcaRespuesta;
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
    // La decisión va ANTES de soltar el candado: lleva la marca de qué leyó la respuesta, y la
    // corrida que espera el turno la lee apenas lo toma (lib/crm-ia-rafaga.ts).
    if (resultado) await registrarDecision(convId, resultado, !!opts.forzarBorrador);
    // Solo suelta el candado quien lo ganó: soltarlo desde una llamada perdedora
    // abriría la puerta a la respuesta duplicada.
    if (candado.tomado)
      await db().from("crm_conversaciones").update({ ia_respondiendo_at: null }).eq("id", convId);
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
    // La marca de la última respuesta ENVIADA sobrevive a las decisiones que no envían.
    const marca = r.marca ? r.marca : marcaVigente(null, (await leerDecision(convId)));
    await db()
      .from("crm_conversaciones")
      .update({
        ia_ultima_decision: {
          accion: r.accion,
          ok: r.ok,
          motivo: motivo ? String(motivo).slice(0, 300) : null,
          a_pedido: aPedido,
          at: new Date().toISOString(),
          ...(marca ? { marca } : {}),
        },
      })
      .eq("id", convId);
  } catch { /* sin la columna (crm-ia-decision.sql) no se anota: la IA funciona igual */ }
}

/** `ia_ultima_decision` de la conversación; null si no hay, o sin la columna (crm-ia-decision.sql). */
async function leerDecision(convId: string): Promise<unknown> {
  try {
    const { data, error } = await db().from("crm_conversaciones").select("ia_ultima_decision").eq("id", convId).maybeSingle();
    return error ? null : (data as any)?.ia_ultima_decision ?? null;
  } catch {
    return null;
  }
}

async function responderConIAInterno(
  convId: string,
  opts: { forzarBorrador?: boolean },
  candado: { tomado: boolean }
): Promise<ResultadoIA> {
  // Desde cuándo una respuesta nuestra cuenta como «otra respuesta salió mientras se redactaba»:
  // desde que esta corrida tiene el turno. Contar desde que despertó tomaría por nueva la respuesta
  // que se envió sin leer este mensaje, que es justo la que esta corrida viene a completar.
  let inicioRespuesta = new Date().toISOString();
  let ultimoVisto: string | null = null;
  let vistoAt: string | null = null;
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
    const horasPausa = horasPausaHumano(agente);
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
      const desdeTurnos = inicioConteoTurnos(reactivadaAt, Date.now());
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
    vistoAt = propio?.created_at ?? null;
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
      .from("crm_mensajes").select("id, direccion, tipo, created_at, generado_por_ia").eq("conversacion_id", convId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    // Que el último mensaje sea nuestro no basta para callar: si es una respuesta de la IA que
    // se escribió SIN leer este mensaje (llegó mientras se enviaba), este mensaje sigue sin
    // contestar. Lo dice la marca que dejó esa respuesta (lib/crm-ia-rafaga.ts).
    const juicio = juzgarUltimo(ult as any, propio, ult?.direccion === "saliente" ? leerMarca(await leerDecision(convId)) : null);
    if (!CONTESTA[juicio])
      return { ok: true, accion: "omitido", motivo: MOTIVO_ULTIMO[juicio as keyof typeof MOTIVO_ULTIMO] };
    const delCliente = juicio === "no_lo_vio" ? propio : ult;
    if (delCliente?.tipo === "sticker" || delCliente?.tipo === "reaction")
      return { ok: true, accion: "omitido", motivo: "Un sticker o reacción no se contesta." };
    inicioRespuesta = new Date().toISOString();
  }

  const modelo = MODELOS_VALIDOS.has(agente.modelo) ? agente.modelo : "claude-opus-4-8";
  // ¿Ya le llegó hoy (hora de Lima) algún mensaje nuestro en este hilo? Solo cuentan los que SALIERON:
  // un envío que Meta rechazó (`error`) no es «ya conversamos». Y cuáles fueron de la IA, para
  // saber si todavía no se presentó hoy (lib/crm-ia-mensaje.ts → saludoDelTurno).
  const { data: llegadosHoy } = await sb
    .from("crm_mensajes").select("generado_por_ia")
    .eq("conversacion_id", convId).eq("direccion", "saliente").is("error", null)
    .gte("created_at", ahoraLima().inicioDiaUtc)
    .limit(500);
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
  const cfgIA = await leerConfigIA(sb);
  const traslados = conv.canal === "whatsapp" && cfgIA.iaCotiza;
  // Las herramientas de RESERVA, además, solo con la reserva encendida (y sus migraciones) y el agente
  // autónomo: hacen cosas (crean la solicitud, leen el comprobante) que una propuesta no puede deshacer.
  const reservaActiva = traslados && cfgIA.reservaIA && modoAuto;

  const messages = await cargarHistorial(sb, convId, ajustesDe(agente), leerMarca(await leerDecision(convId)));
  if (messages.length === 0) return { ok: true, accion: "omitido", motivo: "Sin mensajes del cliente." };
  const saludo = saludoDelTurno({
    alcanzadosHoy: llegadosHoy?.length ?? 0,
    iaHoy: (llegadosHoy ?? []).filter((m: { generado_por_ia?: boolean | null }) => m.generado_por_ia === true).length,
    textosCliente: textosSinContestar(messages),
  });
  // El idioma del cliente, UNA vez por turno y por el código (nunca el modelo: mueve la moneda). Con
  // el inglés apagado (o sin traslados), todo es castellano, byte a byte lo de antes.
  const idiomaIA = await idiomaDeTurno(sb, { convId, traslados });
  const idiomaTurno: Idioma = idiomaDelTurno(idiomaIA);
  // La GUARDA del dinero, aparte del idioma del mensaje: en inglés también con el inglés apagado si el
  // cliente escribe en inglés u otro idioma (sin traslados, `cliente` es null: «es», lo de siempre).
  const guardaTurno: IdiomaTexto = idiomaDeGuarda(idiomaIA.cliente, idiomaTurno);
  const system = construirSystem(agente, contacto, conv, saludo, await nombreEmpresa(sb), { traslados, reserva: reservaActiva, ...(idiomaIA.inglesOn ? { ingles: true } : {}) });

  const ctx: Ctx = {
    sb, contacto, conv, agente, escalado: { v: false },
    remitente, modoAuto, consultasTurno: { n: 0 }, traslados, cotizacionTraslado: null,
    // La misma pausa y la misma reactivación con que arriba se decidió si la IA contesta.
    pausa: { horas: horasPausaHumano(agente), reactivadaAt },
    ...(traslados ? { idiomaIA: { cliente: idiomaIA.cliente, ingles: idiomaIA.ingles } } : {}),
    ...(reservaActiva ? { reserva: { activa: true, cfg: cfgIA.reserva, turno: { n: 0 }, resultados: [] } } : {}),
  };
  const cotizar = herramientaCotizarTraslado({ ingles: idiomaIA.inglesOn });
  const herramientas = reservaActiva
    ? [...TOOLS, cotizar, ...HERRAMIENTAS_RESERVA]
    : traslados ? [...TOOLS, cotizar] : TOOLS;

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
      if (textos.length) textoFinal = limpiarTextoModelo(textos.join("\n"));

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

  // Con la reserva activa, el texto lo decide primero `textoFinalReserva`: los mensajes que arma el
  // código (T1–T11), la derivación, o la guarda T10 si el modelo habló de dinero con una cotización
  // de traslado en el chat. Si no decide (null), sigue como siempre.
  let decidioReserva = false;
  if (ctx.reserva) {
    const ultimaCot = await cotizacionTrasladoDelChat(sb, convId);
    // El idioma: el de la cotización del turno, si no el de la última del chat, y si no el del cliente.
    const idiomaReserva: Idioma = ctx.cotizacionTraslado?.cotizacion?.idioma ?? ultimaCot?.idioma ?? idiomaTurno;
    const est = estiloDe(ajustesDe(agente));
    const tf = textoFinalReserva(textoFinal, ctx.reserva.resultados, {
      estilo: idiomaReserva === "en" ? { ...est, idioma: "en" } : est, numeroCotizacion: ultimaCot?.numero ?? null, hayCotizacionTraslado: !!ultimaCot,
      derivacion: mensajeDerivacion(agente, contactoInicial, undefined, idiomaReserva === "en" ? { idioma: "en" } : {}), cotizoEnElTurno: !!ctx.cotizacionTraslado?.cotizacion,
      ...(guardaTurno === "en" ? { idiomaGuarda: guardaTurno } : {}),
    });
    if (tf != null) { textoFinal = tf; decidioReserva = true; }
  }

  if (ctx.escalado.v && !textoFinal)
    return { ok: true, accion: "escalado", motivo: "Derivado a humano." };
  if (!textoFinal) return { ok: true, accion: "omitido", motivo: "Sin texto de respuesta." };

  // El modelo no pone números: si su texto trae un importe que no es de la cotización de traslado
  // de este turno (en revisión, ninguno), el mensaje lo escribe el código.
  if (!decidioReserva) textoFinal = textoSinImportesAjenos(textoFinal, ctx.cotizacionTraslado, agente, contactoInicial, idiomaTurno, guardaTurno);

  if (agente.firma) textoFinal = `${textoFinal}\n${agente.firma}`;

  // ── Decidir: enviar (autónomo) o dejar borrador (copiloto) ──────────────────
  const puedeAuto = modoAuto;

  if (puedeAuto) {
    // La espera va ANTES de las comprobaciones: con ella después, un mensaje que el cliente
    // escribía durante esos segundos salía sin leer (el caso de lib/crm-ia-rafaga.ts).
    if (agente.delay_segundos > 0)
      await new Promise((r) => setTimeout(r, Math.min(agente.delay_segundos, 30) * 1000));
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
    // Hasta qué mensaje leyó esta respuesta: si el cliente escribió mientras se enviaba, la
    // corrida de ese mensaje lo sabrá y no se callará por ver una respuesta nuestra al final.
    const marca: MarcaRespuesta | undefined = ultimoVisto && vistoAt
      ? { visto_id: ultimoVisto, visto_at: vistoAt, hasta: new Date().toISOString() }
      : undefined;
    return { ok: true, accion: ctx.escalado.v ? "escalado" : "enviado", texto: textoFinal, marca };
  }

  // Copiloto: guardar como borrador para que un humano lo apruebe
  await sb
    .from("crm_conversaciones")
    .update({ borrador_ia: textoFinal, borrador_ia_at: new Date().toISOString() })
    .eq("id", convId);
  return { ok: true, accion: ctx.escalado.v ? "escalado" : "borrador", texto: textoFinal };
}

/**
 * Prueba el agente con historial multi-turno (no envía nada, no toca el ERP de forma destructiva
 * salvo lecturas). Devuelve el texto que vería el cliente: el del modelo pasado por el MISMO texto
 * final del código que en un chat real (`textoSinImportesAjenos`: con una cotización de traslado lo
 * escribe el código, con el trato del agente) y con la firma. Antes devolvía el texto crudo del
 * modelo y la prueba no enseñaba lo que el código cambia.
 */
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
  const cfgIA = await leerConfigIA(sb);
  const traslados = cfgIA.iaCotiza;
  // La reserva se prueba como la vería el cliente con el agente autónomo en WhatsApp; SIMULADA: no
  // crea solicitudes, no lee comprobantes, no manda correos ni mensajes.
  const autonomosP: string[] = Array.isArray(agente.canales_autonomos) ? agente.canales_autonomos : [];
  const reservaPrueba = traslados && cfgIA.reservaIA && autonomosP.includes("whatsapp");
  // En la prueba, «primer mensaje del día» = el agente todavía no contestó en este chat de prueba
  // (y todo lo de ese chat es de la IA).
  const contestados = historial.filter((m) => m.role === "assistant").length;
  const saludo = saludoDelTurno({ alcanzadosHoy: contestados, iaHoy: contestados, textosCliente: [mensaje] });
  const messages: Anthropic.MessageParam[] = [...historial, { role: "user", content: mensaje }];
  const usadas: string[] = [];
  /** Lo que «devolvieron» las herramientas de reserva simuladas (como `ctx.reserva.resultados`). */
  const reservaResultados: ResultadoReservaIA[] = [];
  const textosCliente = messages.filter((m) => m.role === "user" && typeof m.content === "string").map((m) => m.content as string);
  // El idioma, con la MISMA detección que un chat real, sobre lo que escribió el cliente de prueba
  // (del más reciente al más antiguo; sin hora: todo cuenta como reciente).
  const idiomaIA = await idiomaDeTurno(sb, {
    traslados, mensajes: [...textosCliente].reverse().map((contenido) => ({ contenido, tipo: "texto", created_at: null })),
  });
  const idiomaTurno: Idioma = idiomaDelTurno(idiomaIA);
  const guardaTurno: IdiomaTexto = idiomaDeGuarda(idiomaIA.cliente, idiomaTurno);
  const system = construirSystem(agente, contacto, conv, saludo, empresa, { traslados, reserva: reservaPrueba, ...(idiomaIA.inglesOn ? { ingles: true } : {}) });
  const cotizar = herramientaCotizarTraslado({ ingles: idiomaIA.inglesOn });
  const herramientas = reservaPrueba
    ? [...TOOLS, cotizar, ...HERRAMIENTAS_RESERVA]
    : traslados ? [...TOOLS, cotizar] : TOOLS;
  /** Lo que devolvió la última `cotizar_traslado` de prueba (como `ctx.cotizacionTraslado`). */
  let trasladoPrueba: ResultadoCotizarIA | null = null;

  try {
    let textoFinal = "";
    for (let iter = 0; iter < 6; iter++) {
      const req: any = { model: modelo, max_tokens: 1500, system, tools: herramientas, messages, ...modelExtras(modelo) };
      const resp: any = await anthropic.messages.create(req);
      const toolUses = (resp.content ?? []).filter((b: any) => b.type === "tool_use");
      const textos = (resp.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text);
      if (textos.length) textoFinal = limpiarTextoModelo(textos.join("\n"));
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
            ? (trasladoPrueba = await cotizarTrasladoDePrueba(sb, agente, tu.input, textosCliente, empresa, idiomaIA)).respuestaModelo
            : reservaPrueba && RESERVA_DE_PRUEBA[tu.name]
            ? (() => { const r = RESERVA_DE_PRUEBA[tu.name](); reservaResultados.push(r); return r.respuestaModelo; })()
            : await ejecutarTool(tu.name, tu.input, ctx);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      messages.push({ role: "user", content: results });
    }
    // Como en un chat real: primero el texto de la reserva (si decide), después el final del código y la firma.
    let decidioReserva = false;
    if (reservaPrueba) {
      const idiomaReserva: Idioma = trasladoPrueba?.cotizacion?.idioma ?? idiomaTurno;
      const est = estiloDe(ajustesDe(agente));
      const tf = textoFinalReserva(textoFinal, reservaResultados, {
        estilo: idiomaReserva === "en" ? { ...est, idioma: "en" } : est, numeroCotizacion: trasladoPrueba?.cotizacion ? "PRUEBA" : null,
        hayCotizacionTraslado: !!trasladoPrueba?.cotizacion, derivacion: mensajeDerivacion(agente, contacto, undefined, idiomaReserva === "en" ? { idioma: "en" } : {}),
        cotizoEnElTurno: !!trasladoPrueba?.cotizacion, ...(guardaTurno === "en" ? { idiomaGuarda: guardaTurno } : {}),
      });
      if (tf != null) { textoFinal = tf; decidioReserva = true; }
    }
    if (textoFinal) {
      if (!decidioReserva) textoFinal = textoSinImportesAjenos(textoFinal, trasladoPrueba, agente, contacto, idiomaTurno, guardaTurno);
      if (agente.firma) textoFinal = `${textoFinal}\n${agente.firma}`;
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
  const cfgIA = await leerConfigIA(sb);
  const traslados = cfgIA.iaCotiza;
  // La reserva va en las instrucciones como las recibiría un chat de WhatsApp con el agente autónomo.
  const autonomos: string[] = Array.isArray(agente.canales_autonomos) ? agente.canales_autonomos : [];
  const reserva = traslados && cfgIA.reservaIA && autonomos.includes("whatsapp");
  // Con el inglés encendido, las instrucciones llevan sus dos líneas (la moneda y el idioma).
  const ingles = traslados ? (await idiomaDeTurno(sb, { traslados, mensajes: null })).inglesOn : false;
  return construirSystem(agente, contacto, { id: "ejemplo", canal: "whatsapp" }, true, await nombreEmpresa(sb), { traslados, reserva, ...(ingles ? { ingles: true } : {}) });
}

/**
 * Las herramientas de reserva en la PRUEBA del agente: SIMULADAS. Devuelven la lista blanca de
 * siempre y, en vez del mensaje con montos y cuentas, una línea que dice qué haría el sistema (en la
 * prueba no hay cotización enviada que reservar). No escriben nada.
 */
const RESERVA_DE_PRUEBA: Record<string, () => ResultadoReservaIA> = {
  reservar_traslado: () => ({ respuestaModelo: respuestaReservaParaModelo("pedir_pago", { numero: "PRUEBA" }), mensaje: "(Prueba) Aquí el sistema le enviaría al cliente el monto del adelanto, las cuentas de pago y el plazo de confirmación (o le pediría esperar a que un ejecutivo confirme la unidad)." }),
  reportar_pago_traslado: () => ({ respuestaModelo: respuestaReservaParaModelo("comprobante_registrado", { numero: "PRUEBA" }), mensaje: "(Prueba) Aquí el sistema leería el comprobante, le confirmaría al cliente que lo recibió y avisaría a Tesorería para verificarlo en el banco." }),
  politicas_reserva: () => ({ respuestaModelo: respuestaReservaParaModelo("enviar_politicas", { numero: "PRUEBA" }), mensaje: "(Prueba) Aquí el sistema le enviaría al cliente las políticas de reserva, cambios y cancelación de su cotización, al pie de la letra." }),
  cancelar_reserva_traslado: () => ({ respuestaModelo: respuestaReservaParaModelo("cancelacion_registrada", { numero: "PRUEBA" }), mensaje: "(Prueba) Aquí el sistema registraría el pedido de cancelación con la hora del mensaje y un ejecutivo resolvería la devolución." }),
};

/**
 * `cotizar_traslado` en la PRUEBA del agente: cotiza con el motor de verdad (el mismo del
 * simulador) como si escribiera un número peruano de prueba, y dice qué haría con el envío. No
 * crea cotización, acción ni nota, y no envía nada. Devuelve lo mismo que la herramienta real
 * (`ResultadoCotizarIA`, sin PDF ni acción): con eso `probarAgente` arma el texto final del código.
 */
async function cotizarTrasladoDePrueba(
  sb: SB, agente: any, input: any, textos: string[], empresa: string,
  idiomaIA: { cliente: IdiomaCliente | null; ingles: InglesTraslado | null } = { cliente: null, ingles: null },
): Promise<ResultadoCotizarIA> {
  const derivar = (): ResultadoCotizarIA => ({ respuestaModelo: respuestaDerivar(), accion: "derivar" });
  const preguntas = ajustesDe(agente).preguntas;
  try {
    // En la prueba no hay ubicaciones compartidas: las coordenadas que proponga el modelo no valen.
    // Los mensajes de prueba sí cuentan para confirmar un pedido de dólares (o de soles), como en un
    // chat real, y el idioma es el que detectó el código en ellos.
    const v = validarEntrada(entradaDelAgente(input, { canal: "whatsapp", waId: TELEFONO_PRUEBA_TRASLADOS }, [], textos, idiomaIA));
    if (!v.ok) return derivar();
    const idioma: Idioma = v.entrada.idioma_cliente ? "en" : "es";
    // La guarda de los textos libres, como en la herramienta real: en inglés también con el inglés apagado.
    const guarda: IdiomaTexto = idiomaDeGuarda(idiomaIA.cliente, idioma);
    const hoy = fechaLima(Date.now());
    const sim = await simularTrasladoConCatalogo(sb, v.entrada, hoy);
    if (!sim.respuesta.ok || !sim.catalogo) return derivar();
    const r = sim.respuesta.resultado;
    if (r.codigo !== "cotizable") {
      return r.accion === "preguntar"
        ? { respuestaModelo: respuestaParaModelo({ resultado: r, preguntas }), accion: "preguntar", faltan: r.faltan }
        : { respuestaModelo: respuestaParaModelo({ resultado: r, preguntas }), accion: "derivar" };
    }
    const fila = filaCotizacionTraslado(r, v.entrada, {
      convId: "prueba", clienteId: null, atencion: null, config: sim.catalogo.config, firma: "prueba", hoy, ...(idioma === "en" ? { idioma } : {}),
      ...(guarda === "en" && idioma !== "en" ? { guarda } : {}),
    });
    const autonomos: string[] = Array.isArray(agente.canales_autonomos) ? agente.canales_autonomos : [];
    const plan = planEnvio({
      resultado: r, envioMaestro: sim.catalogo.config.envio_automatico === true, zonas: sim.catalogo.zonas,
      canal: "whatsapp", waId: TELEFONO_PRUEBA_TRASLADOS, modoAuto: autonomos.includes("whatsapp") && dentroHorario(agente),
      perfilConfigurado: !!empresa, cuadra: cuadraConMotor(fila, r), pdfOk: true, palabras: senalesEnTexto(textos, idioma),
      textosLibres: [input?.origen_texto, input?.destino_texto], ...(guarda === "en" ? { idioma: guarda } : {}),
    });
    // Las mismas cifras que la herramienta real le deja usar al código (en revisión, ninguna), en el idioma de la fila.
    const auto = plan.decision === "automatico" && !!r.precio;
    return {
      respuestaModelo: respuestaParaModelo({ resultado: r, cotizacion: { numero: "PRUEBA", decision: plan.decision }, preguntas, ...(idioma === "en" ? { idioma } : {}) }),
      accion: "cotizar",
      cotizacion: {
        cotizacionId: 0, numero: "PRUEBA", decision: plan.decision, idioma,
        figuras: auto ? figurasPermitidas("automatico", r.precio) : [],
        total: auto ? fmtImporte(r.precio!.total, r.precio!.moneda, idioma) : undefined,
        validez: auto && r.validez_hasta ? fmtFechaDoc(r.validez_hasta, idioma, idioma === "en" ? "media" : "corta") : undefined,
      },
    };
  } catch {
    return derivar();
  }
}

/**
 * ¿La IA del CRM cotiza traslados? Para /crm/agente (el auditor solo afirma lo de traslados si es
 * `true`). `false` = apagado o sin la migración; `null` = no se pudo leer (no se afirma nada).
 */
export function trasladosDeConfig(cfg: Pick<ConfigIA, "iaCotiza" | "sinMigracion" | "detalle"> | null | undefined): boolean | null {
  if (!cfg) return null;
  if (cfg.iaCotiza === true) return true;
  return cfg.sinMigracion === true || cfg.detalle == null ? false : null;
}

/** `trasladosDeConfig` con la configuración guardada. Nunca lanza: un fallo es `null`. */
export async function trasladosActivosIA(): Promise<boolean | null> {
  try {
    return trasladosDeConfig(await leerConfigIA(db()));
  } catch {
    return null;
  }
}

/**
 * ¿La IA del CRM RESERVA traslados? Para /crm/agente (el auditor y Ajustes): `reserva` es
 * `estadoReservaIA(...).activa` (null si no se pudo leer: no se afirma nada) y `politica_reserva`
 * las líneas distintas de la política de las plantillas que usa la IA. Nunca lanza.
 */
export async function reservaActivaIA(): Promise<{ reserva: boolean | null; politica_reserva: string[] | null; lineas: string[] | null; ambar: boolean | null }> {
  try {
    return await reservaEstadoIA(db());
  } catch {
    return { reserva: null, politica_reserva: null, lineas: null, ambar: null };
  }
}
