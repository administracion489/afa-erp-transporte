// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/cotizar-ia-datos.ts — La herramienta `cotizar_traslado` del agente IA del CRM, de
// punta a punta: valida lo que propone el modelo, cotiza con el motor, guarda la cotización y la
// acción de la bandeja, arma el PDF y decide si se ENVÍA sola o la revisa un ejecutivo.
// SOLO SERVIDOR. No crea clientes al importarse (el de Supabase llega en `ctx`) y NO envía nada:
// devuelve el PDF listo (`envioPendiente`) para que el agente lo mande DESPUÉS de su mensaje, y
// solo si ese mensaje salió (lib/crm-ia.ts → enviarCotizacionTraslado).
//
// EL ORDEN, Y POR QUÉ:
//  1. La configuración (`leerConfigIA`): si se apagó entre el ofrecimiento y la llamada, se deriva.
//  2. La entrada con LISTA BLANCA (`entradaDelAgente`): la moneda sale del wa_id del remitente (o
//     dólares, si el modelo lo marca Y el cliente los nombró en sus mensajes) y las coordenadas solo
//     del enlace de una UBICACIÓN compartida (mensaje entrante de tipo «location»).
//  3. La IDEMPOTENCIA, antes de gastar Google: el mismo pedido (misma `firmaPedido`) en la misma
//     conversación en las últimas 2 h no crea otra cotización. Pendiente → se reusa y se vuelve a
//     decidir el envío (el caso típico: el envío anterior se canceló porque el cliente siguió
//     escribiendo); enviada → «ya te la envié»; rechazada → la ve un ejecutivo.
//  4. Los TOPES, contados antes de geocodificar (quien dispara las consultas es un desconocido).
//     Un conteo que no se pudo leer bloquea: se deriva.
//  5. El motor (`simularTrasladoConCatalogo`, el mismo del simulador de /tarifario).
//  6. La cotización (`cotizaciones` es la fila autoritativa), el PDF, el cuadre contra el motor y
//     `planEnvio` (que también juzga el recojo, el destino y el nombre como TEXTO LIBRE: con algo
//     sospechoso no sale sola); después la acción de la bandeja (`crm_acciones_ia`, tipo
//     `cotizacion_traslado`, siempre `pendiente`) y, si queda en revisión, una nota interna con los
//     motivos.
// ──────────────────────────────────────────────────────────────────────────────

import { faltaAlguna, faltaColumna } from "../columna-faltante";
import { empresaConDefectos } from "../empresa-perfil";
import { numeroCotizacion } from "../cotizacion-pdf";
import { fmtFechaDoc, fmtImporte } from "../cotizacion-idioma";
import { fechaLima } from "../alertas-horario";
import { telefonosE164 } from "../crm-telefono";
import { validarEntrada, type EntradaSimulador, type LugarEntrada } from "./api";
import { cargarCatalogo, leerConfigIA, leerIgvPct, SinMigracionTraslados, type CatalogoTraslados } from "./datos";
import {
  cifrasDeFila, cuadraConMotor, filaCotizacionTraslado, resultadoDeFila,
  type FilaCotizacion, type FilaCotizacionLeida,
} from "./cotizacion-traslado";
import {
  MOTIVO_REVISION, TOPES, decidirTope, entradaDelAgente, figurasPermitidas, firmaPedido, planEnvio,
  respuestaDerivar, respuestaEnRevision, respuestaParaModelo, respuestaYaEnviada, senalesEnTexto,
  textosDeUbicacion, textosLibresSospechosos,
  type CodigoRevision, type DecisionEnvio,
} from "./envio-ia";
import { ETIQUETA_TEXTO_LIBRE } from "./texto-libre";
import { armarPdfDeFila, leerCotizacionTraslado, leerPerfilPdf, type AvisoPdfTraslado, type LogoPdf, type PerfilPdf } from "./enviar-cotizacion-datos";
import { simularTrasladoConCatalogo } from "./servicio";
import type { ResultadoTraslado } from "./motor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

/** La clave del freno de consultas en `alerta_enviada` (índice único en clave + ref + fecha). */
export const CLAVE_CONSULTA_IA = "traslado_ia_consulta";

export type CtxCotizarIA = {
  sb: Sb;
  conv: { id: string; canal: string };
  contacto: { id?: string | null; nombre?: string | null; cliente_id?: number | null } | null;
  /** Copiado ANTES del bucle del agente: el canal y el wa_id del hilo, no lo que escriba el modelo. */
  remitente: { canal: string; waId: string | null };
  /** El mismo `modoAuto` con que el agente decide si envía (lib/crm-ia.ts). */
  modoAuto: boolean;
  /** Consultas al motor hechas en ESTE turno (se cuentan en memoria). */
  consultasTurno: { n: number };
  /**
   * Los mensajes ENTRANTES (contenido y tipo); si faltan, se leen. De todos salen las palabras de
   * pedido complejo; las coordenadas, SOLO de los de tipo «location».
   */
  entrantes?: { contenido: string | null; tipo: string | null }[];
};

export type CotizacionIA = {
  cotizacionId: number;
  numero: string;
  decision: DecisionEnvio;
  yaEnviada?: boolean;
  /** Las cifras que el mensaje del modelo puede mencionar (en revisión, ninguna). */
  figuras: number[];
  total?: string;
  validez?: string;
  accionId?: string;
};

export type ResultadoCotizarIA = {
  /** JSON con lista blanca para el modelo. */
  respuestaModelo: string;
  accion: "cotizar" | "preguntar" | "derivar";
  faltan?: string[];
  /** Lo atiende un ejecutivo: el agente deriva la conversación con esto (la nota es interna). */
  derivar?: { motivo: string; pedido: string; nota: string };
  /** El PDF listo para enviar DESPUÉS del mensaje del agente (solo en envío automático). */
  envioPendiente?: { accionId: string; cotizacionId: number; bytes: Uint8Array; nombre: string; caption: string };
  cotizacion?: CotizacionIA;
};

/** Lo que se reemplaza en la matriz para correr sin red ni Google. */
export type DepsCotizar = {
  simular?: typeof simularTrasladoConCatalogo;
  bajarLogo?: (url: string | null) => Promise<LogoPdf | null>;
  bajarFoto?: (url: string) => Promise<Uint8Array | null>;
  ahoraMs?: () => number;
  azar?: () => string;
};

/**
 * El cliente del ERP de esta cotización: el que ya está vinculado al contacto (lo vinculó una
 * persona), o el ÚNICO cliente con el MISMO número COMPLETO que el wa_id (`mismoTelefonoE164`: los 9
 * dígitos de un celular peruano se completan con 51; un wa_id de otro país nunca empareja con un
 * número local). Antes comparaba los últimos 9 dígitos, y +44 7987654321 recibía sin revisión el
 * RUC, el DNI y la dirección del cliente 987 654 321. Nunca por `contacto.telefono` ni por el correo
 * (los puede escribir el modelo). Ambiguo o ilegible → null (se completa en /cotizaciones).
 * LÍMITE: un número reciclado (otra persona con el número de un cliente) no se puede detectar.
 */
export async function clienteIdDeRemitente(sb: Sb, contacto: CtxCotizarIA["contacto"], waId: string | null): Promise<number | null> {
  if (contacto?.cliente_id != null && Number.isFinite(Number(contacto.cliente_id))) return Number(contacto.cliente_id);
  if (!waId || !/^\+?\d{8,15}$/.test(waId.trim())) return null;
  const wa = telefonosE164(waId);
  if (wa.length !== 1) return null;
  const ids = new Set<number>();
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await sb.from("clientes").select("id, telefono").not("telefono", "is", null).order("id", { ascending: true }).range(desde, desde + 999);
    if (error) return null;
    for (const c of (data ?? []) as { id: number; telefono: string | null }[]) if (telefonosE164(c.telefono).includes(wa[0])) ids.add(Number(c.id));
    if (!data || data.length < 1000) break;
  }
  return ids.size === 1 ? [...ids][0] : null;
}

type Entrante = { contenido: string | null; tipo: string | null };

/** Los mensajes entrantes de la conversación (más recientes primero), con su tipo. null si no se pudieron leer. */
async function entrantesDe(sb: Sb, convId: string): Promise<Entrante[] | null> {
  const { data, error } = await sb.from("crm_mensajes").select("contenido, tipo").eq("conversacion_id", convId).eq("direccion", "entrante")
    .order("created_at", { ascending: false }).limit(60);
  if (error) return null;
  return ((data ?? []) as Entrante[]).filter((m) => m && String(m.contenido ?? "").trim() !== "");
}

const textoLugar = (l: LugarEntrada) => (typeof l === "string" ? l : l.texto || `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}`);

/** El pedido en una línea, para la nota del ejecutivo. */
export function pedidoEnUnaLinea(e: EntradaSimulador): string {
  const sentido = e.sentido === "ida_retorno" ? `ida y retorno${e.fecha_retorno ? ` (vuelta ${e.fecha_retorno}${e.hora_retorno ? ` ${e.hora_retorno}` : ""})` : ""}` : e.sentido === "ida" ? "solo ida" : "sentido sin decir";
  return [
    `Traslado ${textoLugar(e.origen) || "?"} → ${textoLugar(e.destino) || "?"}`,
    `${e.fecha_servicio ?? "sin fecha"}${e.hora_servicio ? ` ${e.hora_servicio}` : ""}`,
    sentido, `${e.pax ?? "?"} pax`, `${e.maletas ?? "?"} maletas de 23 kg`,
    ...(e.pide_dolares ? ["pide la cotización en dólares"] : []),
  ].join(" · ").slice(0, 500);
}

type AccionFila = { id: string; estado: string | null; resuelta_at: string | null; resultado_id: number | null; payload: Record<string, unknown> | null };

/** Lee con `creada_at` (la columna real) y solo si el error la nombra, con `created_at`. */
async function conFecha<T>(consulta: (col: string) => PromiseLike<{ data?: T; error: { message?: string; code?: string } | null; count?: number | null }>) {
  let r = await consulta("creada_at");
  if (r.error && faltaColumna(r.error, "creada_at")) r = await consulta("created_at");
  return r;
}

async function accionPrevia(sb: Sb, convId: string, firma: string, ahora: number): Promise<{ ok: true; accion: AccionFila | null } | { ok: false; detalle: string }> {
  const desde = new Date(ahora - TOPES.VENTANA_MISMO_PEDIDO_MIN * 60_000).toISOString();
  const r = await conFecha<AccionFila[]>((col) => sb.from("crm_acciones_ia").select("id, estado, resuelta_at, resultado_id, payload")
    .eq("conversacion_id", convId).eq("tipo", "cotizacion_traslado").gte(col, desde).order(col, { ascending: false }).limit(50));
  if (r.error) return { ok: false, detalle: r.error.message ?? "error" };
  return { ok: true, accion: ((r.data ?? []) as AccionFila[]).find((a) => a?.payload && (a.payload as { firma?: unknown }).firma === firma) ?? null };
}

type Conteos = { consultasConv: number | null; consultasDia: number | null; cotizacionesConv: number | null; cotizacionesDia: number | null };

async function contarTopes(sb: Sb, convId: string, hoy: string): Promise<Conteos> {
  const n = (r: { count?: number | null; error: unknown }) => (r.error ? null : r.count ?? 0);
  const inicio = `${hoy}T05:00:00.000Z`; // 00:00 de Lima
  const consultas = (conv: boolean) => {
    let q = sb.from("alerta_enviada").select("ref", { count: "exact", head: true }).eq("clave", CLAVE_CONSULTA_IA).eq("fecha", hoy);
    if (conv) q = q.like("ref", `conv:${convId}:%`);
    return q;
  };
  const cotizaciones = (conv: boolean) => conFecha<unknown>((col) => {
    let q = sb.from("crm_acciones_ia").select("id", { count: "exact", head: true }).eq("tipo", "cotizacion_traslado").gte(col, inicio);
    if (conv) q = q.eq("conversacion_id", convId);
    return q;
  });
  const [a, b, c, d] = await Promise.all([consultas(true), consultas(false), cotizaciones(true), cotizaciones(false)]);
  return { consultasConv: n(a), consultasDia: n(b), cotizacionesConv: n(c), cotizacionesDia: n(d) };
}

type Insercion = { ok: true; id: number; numero: string | null; created_at: string | null } | { ok: false; motivo: string; detalle: string };

/**
 * Inserta la cotización. Solo reintenta si el error NOMBRA una columna accesoria (un INSERT que no
 * entró por eso no dejó nada escrito); ante cualquier otro error no se reintenta (duplicaría).
 */
async function insertarCotizacion(sb: Sb, fila: FilaCotizacion): Promise<Insercion> {
  const f: Record<string, unknown> = { ...fila };
  for (let i = 0; i < 4; i++) {
    const { data, error } = await sb.from("cotizaciones").insert(f).select("id, numero_cotizacion, created_at").single();
    if (!error && data) return { ok: true, id: Number(data.id), numero: data.numero_cotizacion ?? null, created_at: data.created_at ?? null };
    const col = faltaAlguna(error, ["crm_conversacion_id", "traslado_json", "moneda", "tipo_cambio", "idioma_pdf"] as const);
    if (!col) return { ok: false, motivo: "No se pudo guardar la cotización del traslado", detalle: String(error?.message ?? "sin respuesta") };
    if (col === "crm_conversacion_id" || col === "traslado_json") {
      return { ok: false, motivo: "Falta correr supabase/traslados-05-cotizacion-ia.sql", detalle: `La columna cotizaciones.${col} no existe.` };
    }
    if (fila.moneda === "USD") {
      return { ok: false, motivo: "Falta correr supabase/cotizaciones-04-moneda-idioma.sql", detalle: "Una cotización en dólares no se guarda sin su moneda y su tipo de cambio." };
    }
    delete f[col];
  }
  return { ok: false, motivo: "No se pudo guardar la cotización del traslado", detalle: "Demasiados reintentos." };
}

const deriva = (motivo: string, pedido: string, nota = ""): ResultadoCotizarIA =>
  ({ respuestaModelo: respuestaDerivar(), accion: "derivar", derivar: { motivo, pedido, nota } });

/**
 * La herramienta `cotizar_traslado`. Nunca lanza: lo inesperado se deriva a un ejecutivo con su
 * motivo, para que el cliente reciba el mensaje de derivación y no un silencio.
 */
export async function cotizarTrasladoIA(ctx: CtxCotizarIA, input: unknown, deps: DepsCotizar = {}): Promise<ResultadoCotizarIA> {
  try {
    return await cotizarInterno(ctx, input, deps);
  } catch (e) {
    console.error("[traslados/ia]", (e as Error)?.message);
    return deriva("Error inesperado al cotizar el traslado", "Cotizar un traslado", String((e as Error)?.message ?? e).slice(0, 500));
  }
}

async function cotizarInterno(ctx: CtxCotizarIA, input: unknown, deps: DepsCotizar): Promise<ResultadoCotizarIA> {
  const { sb } = ctx;
  const ahora = deps.ahoraMs?.() ?? Date.now();
  const hoy = fechaLima(ahora);

  // 1) ¿Sigue encendida?
  const cfg = await leerConfigIA(sb);
  if (!cfg.iaCotiza) return deriva("La cotización automática de traslados no está disponible", "Cotizar un traslado", cfg.detalle ?? "");

  // 2) La entrada, con lista blanca. Coordenadas solo de las ubicaciones compartidas.
  const entrantes = ctx.entrantes ?? (await entrantesDe(sb, ctx.conv.id));
  const textos = entrantes ? entrantes.map((m) => String(m.contenido ?? "")) : null;
  const v = validarEntrada(entradaDelAgente(input, ctx.remitente, textosDeUbicacion(entrantes), textos ?? []));
  if (!v.ok) return deriva(`Pedido de traslado que no se pudo leer: ${v.detalle}`, "Cotizar un traslado");
  const e = v.entrada;
  const pedido = pedidoEnUnaLinea(e);
  const firma = firmaPedido(e);
  const libres = camposLibres(e, ctx.contacto?.nombre ?? null);

  // 3) ¿Ya se cotizó este mismo pedido?
  const previa = await accionPrevia(sb, ctx.conv.id, firma, ahora);
  if (!previa.ok) return deriva("No se pudo comprobar si este pedido ya se cotizó", pedido, previa.detalle);
  if (previa.accion) return reusar(ctx, deps, previa.accion, { pedido, firma, textos, libres, ahora, hoy });

  // 4) Topes, antes de gastar Google.
  const conteos = await contarTopes(sb, ctx.conv.id, hoy);
  for (const fase of ["consulta", "cotizacion"] as const) {
    const t = decidirTope({ ...conteos, consultasTurno: ctx.consultasTurno.n }, fase);
    if (!t.ok) return deriva(t.motivo ?? "Tope de cotizaciones automáticas", pedido);
  }
  const azar = deps.azar?.() ?? Math.random().toString(36).slice(2, 10);
  const reg = await sb.from("alerta_enviada").insert({ clave: CLAVE_CONSULTA_IA, ref: `conv:${ctx.conv.id}:${ahora}-${azar}`, fecha: hoy });
  if (reg.error) return deriva("No se pudo registrar la consulta de traslado", pedido, reg.error.message);
  ctx.consultasTurno.n++;

  // 5) El motor.
  const sim = await (deps.simular ?? simularTrasladoConCatalogo)(sb, e, hoy);
  if (!sim.respuesta.ok) return deriva(`No se pudo cotizar el traslado: ${sim.respuesta.detalle}`, pedido);
  const r = sim.respuesta.resultado;
  if (r.accion === "preguntar") return { respuestaModelo: respuestaParaModelo({ resultado: r }), accion: "preguntar", faltan: r.faltan };
  if (r.accion === "derivar" || !sim.catalogo) {
    return { ...deriva(r.motivo, pedido, r.explicacion.join("\n")), respuestaModelo: respuestaParaModelo({ resultado: r }) };
  }

  // 6) La cotización.
  const clienteId = await clienteIdDeRemitente(sb, ctx.contacto, ctx.remitente.waId);
  const fila = filaCotizacionTraslado(r, e, {
    convId: ctx.conv.id, clienteId, atencion: ctx.contacto?.nombre ?? null, config: sim.catalogo.config, firma, hoy,
    ahora: new Date(ahora).toISOString(),
  });
  const ins = await insertarCotizacion(sb, fila);
  if (!ins.ok) return deriva(ins.motivo, pedido, ins.detalle);
  const leida: FilaCotizacionLeida = { ...fila, id: ins.id, numero_cotizacion: ins.numero, created_at: ins.created_at };
  return decidirYRegistrar(ctx, deps, { leida, resultado: r, catalogo: sim.catalogo, firma, textos, libres, pedido, nota: r.explicacion.join("\n") });
}

type CampoLibre = { campo: string; texto: string | null };

/** Lo que escribió el cliente (o el modelo) y podría imprimirse: el recojo, el destino y el nombre. */
function camposLibres(e: EntradaSimulador, nombre: string | null): CampoLibre[] {
  const t = (l: LugarEntrada) => (typeof l === "string" ? l : l.texto ?? null);
  return [{ campo: "Recojo", texto: t(e.origen) }, { campo: "Destino", texto: t(e.destino) }, { campo: "Nombre del contacto", texto: nombre }];
}

/** El mismo pedido otra vez: se reusa la cotización (y se vuelve a decidir el envío), se recuerda la enviada, o se deriva. */
async function reusar(
  ctx: CtxCotizarIA, deps: DepsCotizar, acc: AccionFila,
  x: { pedido: string; firma: string; textos: string[] | null; libres: CampoLibre[]; ahora: number; hoy: string },
): Promise<ResultadoCotizarIA> {
  const { sb } = ctx;
  if (acc.estado === "rechazada") return deriva("Un ejecutivo rechazó hace poco una cotización de este mismo pedido", x.pedido);
  const cotId = Number(acc.resultado_id ?? (acc.payload as { cotizacion_id?: unknown } | null)?.cotizacion_id);
  const leida = await leerCotizacionTraslado(sb, cotId);
  if (!leida) return deriva("La cotización de este pedido ya no existe (se borró en /cotizaciones)", x.pedido);
  const numero = numeroCotizacion(leida);
  const enCurso = acc.estado === "enviando" && !!acc.resuelta_at && Date.parse(acc.resuelta_at) > x.ahora;
  if (acc.estado === "aprobada" || enCurso) {
    const cifras = cifrasDeFila(leida);
    return {
      respuestaModelo: respuestaYaEnviada(numero, cifras),
      accion: "cotizar",
      cotizacion: {
        cotizacionId: leida.id, numero, decision: "automatico", yaEnviada: true,
        figuras: cifras?.figuras ?? [], total: cifras?.total, validez: cifras?.validez ?? undefined, accionId: acc.id,
      },
    };
  }
  // Pendiente (o un envío anterior que murió): se vuelve a decidir con el tarifario y el contexto de HOY.
  let catalogo: CatalogoTraslados;
  try {
    catalogo = await cargarCatalogo(sb);
  } catch (err) {
    if (err instanceof SinMigracionTraslados) return deriva(err.message, x.pedido);
    throw err;
  }
  const igv = await leerIgvPct(sb);
  const r = resultadoDeFila(leida, catalogo, igv);
  return decidirYRegistrar(ctx, deps, { leida, resultado: r, catalogo, firma: x.firma, textos: x.textos, libres: x.libres, pedido: x.pedido, nota: "", existente: acc });
}

/** PDF, cuadre, decisión de envío, acción de la bandeja y nota interna. Compartido por la cotización nueva y la reusada. */
async function decidirYRegistrar(
  ctx: CtxCotizarIA, deps: DepsCotizar,
  x: {
    leida: FilaCotizacionLeida; resultado: ResultadoTraslado | null; catalogo: Pick<CatalogoTraslados, "config" | "zonas">;
    firma: string; textos: string[] | null; libres: CampoLibre[]; pedido: string; nota: string; existente?: AccionFila;
  },
): Promise<ResultadoCotizarIA> {
  const { sb } = ctx;
  const numero = numeroCotizacion(x.leida);

  // El perfil (para el PDF y para saber si está configurado) y el PDF. Ninguno de los dos lanza aquí.
  let perfil: PerfilPdf | null = null;
  try { perfil = await leerPerfilPdf(sb); } catch { perfil = null; }
  const empresa = empresaConDefectos(perfil?.perfil ?? null);
  let pdf: { bytes: Uint8Array; nombre: string; caption: string; avisos: AvisoPdfTraslado[] } | null = null;
  let errorPdf = "";
  if (perfil) {
    // El CELULAR del PDF es el wa_id del hilo, copiado antes del bucle (nunca lo que escriba el modelo).
    // Los datos del cliente del ERP solo se imprimen si está vinculado al contacto o su número
    // COMPLETO es el wa_id (`clienteParaPdf`): si no, atención y celular.
    try {
      pdf = await armarPdfDeFila(sb, x.leida, {
        perfil, bajarLogo: deps.bajarLogo, bajarFoto: deps.bajarFoto, celular: ctx.remitente.waId,
        contactoClienteId: ctx.contacto?.cliente_id ?? null, ahoraMs: deps.ahoraMs?.(),
      });
    }
    catch (err) { errorPdf = String((err as Error)?.message ?? err); }
  } else errorPdf = "No se pudo leer el perfil de la empresa.";

  const palabras = x.textos == null ? ["(no se pudo leer la conversación)"] : senalesEnTexto(x.textos);
  let decision: DecisionEnvio;
  let motivos: CodigoRevision[];
  if (x.resultado) {
    const plan = planEnvio({
      resultado: x.resultado, envioMaestro: x.catalogo.config.envio_automatico === true, zonas: x.catalogo.zonas,
      canal: ctx.remitente.canal, waId: ctx.remitente.waId, modoAuto: ctx.modoAuto,
      perfilConfigurado: !!perfil && !empresa.sinConfigurar, cuadra: cuadraConMotor(x.leida, x.resultado),
      pdfOk: !!pdf, palabras, textosLibres: x.libres.map((c) => c.texto),
    });
    decision = plan.decision;
    motivos = plan.motivos;
  } else {
    // Sin poder reconstruir el precio de la tarifa vigente, no se envía sola.
    decision = "revision";
    motivos = ["importes_no_cuadran"];
  }

  // La acción de la bandeja: nueva, o la misma con la decisión de ahora.
  let accionId = x.existente?.id;
  const datos = { cotizacion_id: x.leida.id, numero, firma: x.firma, decision, motivos };
  if (x.existente) {
    const { error } = await sb.from("crm_acciones_ia")
      .update({ payload: { ...(x.existente.payload ?? {}), ...datos, redecidida_at: new Date(deps.ahoraMs?.() ?? Date.now()).toISOString() } })
      .eq("id", x.existente.id).in("estado", ["pendiente", "enviando"]);
    if (error) { decision = "revision"; }
  } else {
    const resumen = resumenAccion(x.leida, numero, decision);
    const { data, error } = await sb.from("crm_acciones_ia").insert({
      conversacion_id: ctx.conv.id, contacto_id: ctx.contacto?.id ?? null, tipo: "cotizacion_traslado", resumen,
      payload: datos, estado: "pendiente", resultado_tipo: "cotizaciones", resultado_id: x.leida.id,
    }).select("id").single();
    if (error || !data) {
      return deriva(
        `Se guardó la cotización N° ${numero} pero no su tarjeta en la bandeja`, x.pedido,
        `Ábrela en /cotizaciones?buscar=${numero} y envíala desde ahí. ${String(error?.message ?? "")}`.trim(),
      );
    }
    accionId = String(data.id);
  }

  // En revisión: una nota interna con los motivos y su arreglo (best-effort). La IA NO se pausa.
  if (decision === "revision" && !x.existente) {
    try {
      const lineas = [
        `🤖 La IA cotizó un traslado y lo dejó para que lo revises: cotización N° ${numero}.`,
        ...motivos.map((m) => `• ${MOTIVO_REVISION[m].texto} ${MOTIVO_REVISION[m].arreglo}`),
        ...textosLibresSospechosos(x.libres).map((c) => `  – ${c.campo}: ${ETIQUETA_TEXTO_LIBRE[c.motivo]}.`),
        errorPdf ? `• PDF: ${errorPdf.slice(0, 300)}` : "",
        // Lo que el PDF no pudo poner (no bloquea el envío; aquí solo se dice).
        ...(pdf?.avisos ?? []).map((a) => `• PDF: ${a.detalle}`),
        `Pedido: ${x.pedido}`,
        x.nota ? `Cómo se cotizó:\n${x.nota.slice(0, 1500)}` : "",
      ].filter(Boolean);
      await sb.from("crm_notas").insert({ conversacion_id: ctx.conv.id, texto: lineas.join("\n"), autor_nombre: "Asistente IA" });
    } catch { /* sin crm_notas, la tarjeta de la bandeja lo dice igual */ }
  }

  const r = x.resultado;
  const respuestaModelo = r ? respuestaParaModelo({ resultado: r, cotizacion: { numero, decision } }) : respuestaEnRevision(numero);
  const cotizacion: CotizacionIA = {
    cotizacionId: x.leida.id, numero, decision, accionId,
    figuras: decision === "automatico" && r?.precio ? figurasPermitidas("automatico", r.precio) : [],
    total: decision === "automatico" && r?.precio ? fmtImporte(r.precio.total, r.precio.moneda, "es") : undefined,
    validez: decision === "automatico" && r?.validez_hasta ? fmtFechaDoc(r.validez_hasta, "es", "corta") : undefined,
  };
  return {
    respuestaModelo, accion: "cotizar", cotizacion,
    envioPendiente: decision === "automatico" && pdf && accionId
      ? { accionId, cotizacionId: x.leida.id, bytes: pdf.bytes, nombre: pdf.nombre, caption: pdf.caption }
      : undefined,
  };
}

/** El texto de la tarjeta de la bandeja: el pedido, sin importes ni datos internos. */
function resumenAccion(f: FilaCotizacionLeida, numero: string, decision: DecisionEnvio): string {
  const sentido = f.tipo_servicio === "ida_retorno" ? "ida y retorno" : "solo ida";
  const fecha = f.fecha_servicio ? `${f.fecha_servicio}${f.hora_ida ? ` ${f.hora_ida}` : ""}` : "sin fecha";
  return `Traslado N° ${numero}: ${f.origen} → ${f.destino} · ${fecha} · ${sentido} · ${decision === "automatico" ? "envío automático" : "para revisar"}`.slice(0, 300);
}
