// lib/radar/motor.ts — Motor del pipeline Radar IA (SOLO servidor).
//
// procesarPendientes() es el único punto de entrada (lo llaman /api/radar/procesar —
// trigger del worker y cron de barrido — y /api/radar/reprocesar). Por cada mensaje
// pendiente de radar_mensajes:
//   0. Reportes multi-mensaje (p.ej. combustible: texto con la placa + foto del odómetro +
//      foto del voucher, en cualquier orden): se espera un período de gracia y se fusionan
//      en una sola extracción combinada — ver "Agrupado de reportes multi-mensaje" abajo.
//   1. Gates: radar activo, horario de monitoreo, presupuesto diario de IA.
//   2. Texto → triage con el modelo económico (Haiku) → extracción por categoría.
//      Imagen/PDF → una sola llamada con visión (clasifica + extrae).
//      Nota de voz → transcripción opcional (lib/radar/transcripcion.ts) → ruta de texto.
//   3. lib/radar/acciones.ts ejecuta la acción de la categoría (oportunidad, combustible…).
//   4. Se persiste todo en la fila: categoría, confianza, resumen, extracción, acción,
//      tokens y costo. Los errores de un mensaje jamás tumban el lote.

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { enviarEmail } from "@/lib/notificaciones";
import { leccionesOdometro } from "@/lib/odometro";
import { leccionesCombustible } from "./lecciones-combustible";
import { ejecutarAccion, crearAlerta, fechaLima, horaLima, fechaLimaDeTs, horaLimaDeTs } from "./acciones";
import {
  FILTRO_FALLIDOS,
  FILTRO_SIN_TERMINAR,
  esFallido,
  estadoTrasAccion,
  rafagaAReactivar,
  raizDeReproceso,
  type MensajeRafaga,
} from "./reproceso";
import { promptTriage, promptExtraccion, promptExtraccionMedia, type ContextoPrompt } from "./prompts";
import { transcribirAudio } from "./transcripcion";
import { miembrosDelMismoRemitente, pareceCombustible, remitenteUtilizable } from "./cluster-remitente";
import { CONFIG_DEFECTO, normalizarConfigRadar, dentroDeHorario } from "./config";
import { LISTA_CATEGORIAS, type CategoriaRadar, type RadarConfig, type ResumenProcesamiento } from "./tipos";
import { firmarUrl, firmarUrls } from "@/lib/storage-firmado";

// ── Cliente admin (patrón de la casa) ────────────────────────────────────────

const db = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

// Cliente Anthropic perezoso (mismo criterio que lib/vision-ia.ts: el route no debe
// reventar al cargar el módulo si falta la clave).
let _anthropic: Anthropic | null = null;
const getAnthropic = () => (_anthropic ??= new Anthropic());

// ── Costos por millón de tokens (USD) para el freno de presupuesto ───────────

const PRECIOS: Record<string, { entrada: number; salida: number }> = {
  "claude-haiku-4-5": { entrada: 1, salida: 5 },
  "claude-sonnet-5": { entrada: 3, salida: 15 },
  "claude-opus-4-8": { entrada: 5, salida: 25 },
};

function costoUsd(modelo: string, entrada: number, salida: number): number {
  const p = PRECIOS[modelo] ?? PRECIOS["claude-sonnet-5"];
  return (entrada * p.entrada + salida * p.salida) / 1_000_000;
}

// Parámetros extra por modelo (mismo patrón que extrasModelo() en lib/elia/config.ts)
function extras(modelo: string): Record<string, unknown> {
  if (modelo.startsWith("claude-haiku")) return {};
  return { thinking: { type: "adaptive" }, output_config: { effort: "low" } };
}

// ── Extracción de JSON de la respuesta del modelo (patrón de lib/vision-ia.ts) ──

function extraerJSON(texto: string): any {
  const limpio = texto.replace(/```json/gi, "").replace(/```/g, "").replace(/^`+|`+$/g, "").trim();
  const ini = limpio.indexOf("{");
  const fin = limpio.lastIndexOf("}");
  if (ini === -1 || fin === -1) throw new Error("La IA no devolvió un JSON reconocible (respuesta vacía o truncada)");
  const frag = limpio.slice(ini, fin + 1);
  try {
    return JSON.parse(frag);
  } catch (e: any) {
    throw new Error(`No se pudo interpretar el JSON de la IA: ${e.message}. Inicio: ${frag.slice(0, 120)}`);
  }
}

// ── Config con defaults seguros (si la tabla aún no existe o está vacía) ─────
// La normalización vive en lib/radar/config.ts (normalizarConfigRadar) y la comparte
// la UI del dashboard, para que lo que ve el operador == lo que ejecuta este motor.

async function cargarConfig(sb: any): Promise<RadarConfig> {
  try {
    const { data } = await sb.from("radar_config").select("*").eq("id", 1).maybeSingle();
    return normalizarConfigRadar(data);
  } catch {
    return { ...CONFIG_DEFECTO };
  }
}

// ── Llamada al modelo (no streaming) ─────────────────────────────────────────

type RespuestaIA = { texto: string; entrada: number; salida: number };

async function llamarIA(modelo: string, content: any[]): Promise<RespuestaIA> {
  const resp: any = await getAnthropic().messages.create({
    model: modelo,
    max_tokens: 2500,
    messages: [{ role: "user", content }],
    ...extras(modelo),
  } as any);
  const texto = (resp?.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n");
  return {
    texto,
    entrada: Number(resp?.usage?.input_tokens ?? 0),
    salida: Number(resp?.usage?.output_tokens ?? 0),
  };
}

// ── Punto de entrada ─────────────────────────────────────────────────────────

export async function procesarPendientes(opts?: {
  limite?: number;
  soloMensajeId?: string;
  forzar?: boolean;
  /**
   * Si `forzar` salta también las categorías apagadas (por defecto, sí: es el botón «Reprocesar» de
   * UN mensaje, que alguien pulsó mirándolo). El reproceso EN LOTE las respeta: un mensaje que se
   * cayó antes de clasificarse no puede terminar ejecutando una categoría que el operador apagó.
   */
  forzarCategorias?: boolean;
}): Promise<ResumenProcesamiento> {
  const sb = db();
  const limite = Math.min(50, Math.max(1, opts?.limite ?? 20));
  const forzar = opts?.forzar === true;
  const forzarCategorias = opts?.forzarCategorias ?? forzar;
  const resumen: ResumenProcesamiento = { procesados: 0, descartados: 0, errores: 0, omitidos: 0, costo_usd: 0 };

  const config = await cargarConfig(sb);

  // Candidatos (el conteo alimenta "omitidos" cuando un gate frena el lote)
  let consulta = sb
    .from("radar_mensajes")
    .select("*")
    .eq("estado", "pendiente")
    .order("recibido_en", { ascending: true })
    .limit(limite);
  if (opts?.soloMensajeId) consulta = consulta.eq("id", opts.soloMensajeId);
  const { data: pendientes, error: errSel } = await consulta;
  if (errSel) throw new Error(`radar_mensajes: ${errSel.message}`);
  // Los mensajes con pinta de reporte de combustible fragmentado esperan su período de
  // gracia (para que sus "hermanos" alcancen a llegar) salvo que se fuerce el reproceso.
  const lote = ((pendientes as any[]) ?? []).filter((m) => forzar || !dentroDeGraciaCluster(m));
  if (!lote.length) return resumen;

  // Contexto por grupo (nota del operador + restricción de categorías) — se carga en lote
  // para no hacer una consulta por mensaje.
  const gruposInfo = await cargarGruposInfo(sb, lote);
  // ¿El lote trae algo que pueda ser un tablero o un voucher? (una foto siempre puede serlo;
  // un texto solo si menciona el rubro). Gobierna las tres cargas de contexto de abajo para no
  // gastar consultas en lotes de puro texto irrelevante.
  const traeCombustibleOFoto = lote.some((m) => pareceCombustible(m) || m.media_url);
  // Guías de odómetro por vehículo. Antes el gate era `lote.some(pareceCombustible)`, más
  // estrecho: un reporte de kilometraje sin vocabulario de combustible ("el km de la móvil
  // BUI-272 es …") llegaba a la extracción SIN las guías que el operador había configurado.
  const guiasOdometro = traeCombustibleOFoto ? await cargarGuiasOdometro(sb) : [];
  // Correcciones humanas de lectura de odómetro (dataset de aprendizaje). Se inyectan en el
  // prompt de extracción para que el Radar —el único camino que auto-registra— no repita
  // el dígito mal leído ni confunda el parcial con el total.
  const leccionesOdo = traeCombustibleOFoto ? await leccionesOdometro(sb).catch(() => "") : "";
  // Correcciones humanas de lectura de vouchers (grifo/cantidad/precio/monto) → mismo
  // gate que odómetro: solo si el lote trae algo con pinta de combustible o una foto.
  const leccionesComb = traeCombustibleOFoto ? await leccionesCombustible(sb).catch(() => "") : "";

  // Gate 1: radar apagado → los mensajes quedan pendientes (se procesan al reactivar)
  if (!config.activo && !forzar) {
    resumen.omitidos = lote.length;
    return resumen;
  }

  // Gate 2: fuera del horario de monitoreo → el cron los recoge dentro de la ventana. La regla vive en
  // lib/radar/config.ts (dentroDeHorario): el aviso de salud del Radar la usa para no llamar
  // «atascada» a una cola que solo espera su horario.
  if (!forzar && !dentroDeHorario(config, horaLima())) {
    resumen.omitidos = lote.length;
    return resumen;
  }

  // Gate 3: presupuesto diario de IA (suma de costo_usd de lo procesado hoy, hora Lima)
  const inicioDiaUtc = `${fechaLima()}T05:00:00.000Z`; // 00:00 Lima = 05:00 UTC
  let gastoHoy = 0;
  try {
    const { data: gastos } = await sb
      .from("radar_mensajes")
      .select("costo_usd")
      .gte("procesado_en", inicioDiaUtc);
    gastoHoy = ((gastos as any[]) ?? []).reduce((acc, r) => acc + Number(r.costo_usd || 0), 0);
  } catch {
    // sin datos de gasto: seguir con 0
  }
  if (gastoHoy >= config.limite_diario_usd && !forzar) {
    resumen.omitidos = lote.length;
    await alertaPresupuesto(sb, inicioDiaUtc, config.limite_diario_usd);
    return resumen;
  }

  for (const mensaje of lote) {
    // Freno de presupuesto también a mitad de lote
    if (!forzar && gastoHoy + resumen.costo_usd >= config.limite_diario_usd) {
      resumen.omitidos++;
      continue;
    }

    // Claim optimista: si el cron y el trigger corren a la vez, solo uno toma el mensaje
    const { data: claim } = await sb
      .from("radar_mensajes")
      .update({ estado: "procesando" })
      .eq("id", mensaje.id)
      .eq("estado", "pendiente")
      .select("id");
    if (!claim || !(claim as any[]).length) continue;

    try {
      const grupoInfo = mensaje.grupo_id ? gruposInfo.get(mensaje.grupo_id) ?? null : null;
      const r = await procesarMensaje(sb, mensaje, config, forzarCategorias, grupoInfo, guiasOdometro, leccionesOdo, leccionesComb);
      resumen.costo_usd += r.costo;
      if (r.estado === "procesado") resumen.procesados++;
      else if (r.estado === "error") resumen.errores++;
      else resumen.descartados++;
    } catch (e: any) {
      resumen.errores++;
      const msg = String(e?.message ?? e).slice(0, 500);
      console.error("[radar/motor] mensaje", mensaje.id, msg);
      await sb
        .from("radar_mensajes")
        .update({ estado: "error", error: msg, procesado_en: new Date().toISOString() })
        .eq("id", mensaje.id);
    }
  }

  resumen.costo_usd = Math.round(resumen.costo_usd * 10000) / 10000;
  return resumen;
}

// Info de radar_grupos necesaria para el pipeline (contexto para el prompt + restricción de categorías).
type GrupoInfo = { contexto: string | null; categorias_permitidas: CategoriaRadar[] | null };

/** Carga en un solo select el contexto/restricciones de los grupos presentes en el lote. */
async function cargarGruposInfo(sb: any, lote: any[]): Promise<Map<string, GrupoInfo>> {
  const mapa = new Map<string, GrupoInfo>();
  const grupoIds = Array.from(new Set(lote.map((m) => m.grupo_id).filter(Boolean)));
  if (!grupoIds.length) return mapa;
  try {
    const { data } = await sb.from("radar_grupos").select("id, contexto, categorias_permitidas").in("id", grupoIds);
    for (const g of (data as any[]) ?? []) {
      mapa.set(g.id, {
        contexto: g.contexto ?? null,
        categorias_permitidas: Array.isArray(g.categorias_permitidas) ? g.categorias_permitidas : null,
      });
    }
  } catch {
    // sin contexto de grupo: el pipeline sigue con las categorías globales
  }
  return mapa;
}

// ── Agrupado de reportes multi-mensaje ───────────────────────────────────────
// Los conductores mandan el reporte de combustible (o de solo kilometraje, categoría
// "odometro") en 2-3 mensajes seguidos, no siempre en orden (texto con la placa, foto del
// odómetro, foto del voucher — cada una por su lado). Sin esto, cada mensaje se procesaba
// solo y ninguno tenía el cuadro completo. El nombre quedó "combustible" pero el agrupado
// aplica igual a "odometro" — la clasificación final (con o sin datos de compra) la decide
// la extracción combinada, no este heurístico.

// Heurística liviana: ¿este mensaje PODRÍA ser parte de un reporte de combustible/odómetro
// fragmentado? Se usa para el período de gracia y para buscar hermanos. Vive en
// cluster-remitente.ts (`pareceCombustible`) porque el reproceso tiene que decidir con la MISMA
// regla qué mensajes vuelven a la cola junto a uno.

// Antes de procesar un mensaje con pinta de combustible se espera este tiempo, para que
// sus "hermanos" (enviados en los minutos siguientes) ya estén en la base cuando se arme
// el reporte combinado. VENTANA_CLUSTER_MS es el radio (antes y después) donde se buscan.
const GRACIA_CLUSTER_MS = 5 * 60_000;
const VENTANA_CLUSTER_MS = 10 * 60_000;

function dentroDeGraciaCluster(mensaje: any): boolean {
  if (!pareceCombustible(mensaje)) return false;
  return Date.now() - new Date(mensaje.recibido_en).getTime() < GRACIA_CLUSTER_MS;
}

type ResolucionCluster = { primaria: boolean; primariaId?: string; miembros?: any[] };

/**
 * Busca otros mensajes de LA MISMA PERSONA en el MISMO grupo, dentro de la ventana, que
 * también "parecen combustible". El más antiguo del grupo se vuelve la "primaria" (la que
 * dispara la extracción combinada); el resto se fusiona en ella sin generar su propia fila.
 *
 * **Quién mandó el mensaje se decide en `lib/radar/cluster-remitente.ts`, no con el `.eq()`.**
 * En producción se fusionaron fotos de VARIOS celulares en una sola recarga: basta con que el
 * jid llegue vacío o con un valor de relleno para que el filtro empareje a todo el grupo — un
 * comodín compartido casa con todos. Por eso el jid se valida antes de agrupar y cada
 * candidato se vuelve a comprobar aquí, cruzando el número con el pushName.
 */
async function resolverCluster(sb: any, mensaje: any): Promise<ResolucionCluster> {
  if (!pareceCombustible(mensaje) || !remitenteUtilizable(mensaje) || !mensaje.grupo_id) {
    return { primaria: true };
  }
  const centro = new Date(mensaje.recibido_en).getTime();
  const desde = new Date(centro - VENTANA_CLUSTER_MS).toISOString();
  const hasta = new Date(centro + VENTANA_CLUSTER_MS).toISOString();
  const { data } = await sb
    .from("radar_mensajes")
    // `remitente_wa`/`remitente_nombre` viajan para poder VERIFICAR el remitente, no solo
    // filtrarlo; `media_nombre` porque es el nombre de archivo que se guarda como evidencia.
    .select("id, recibido_en, estado, tipo, texto, transcripcion, media_url, media_mime, media_nombre, remitente_wa, remitente_nombre")
    .eq("remitente_wa", mensaje.remitente_wa)
    .eq("grupo_id", mensaje.grupo_id)
    .neq("estado", "fusionado")
    .gte("recibido_en", desde)
    .lte("recibido_en", hasta);
  const candidatos = miembrosDelMismoRemitente(
    mensaje,
    ((data as any[]) ?? []).filter((m) => pareceCombustible(m))
  );
  if (candidatos.length <= 1) return { primaria: true };

  candidatos.sort((a, b) => new Date(a.recibido_en).getTime() - new Date(b.recibido_en).getTime());
  const primaria = candidatos[0];
  if (primaria.id === mensaje.id) return { primaria: true, miembros: candidatos };
  // Si la "primaria" del cluster ya quedó terminada (p.ej. la descartaron como "otros" antes
  // de que llegara este hermano), no fusionarlo ahí a ciegas: se evalúa por su cuenta — peor
  // caso, queda como si no hubiera agrupado; nunca se pierde en un mensaje ya cerrado.
  if (["procesado", "descartado", "error"].includes(primaria.estado)) return { primaria: true };
  return { primaria: false, primariaId: primaria.id };
}

/**
 * Elige hasta `cap` archivos del cluster para la ÚNICA llamada de visión, SIN sesgar contra
 * los que llegan al final del álbum. La NOTA DE DESPACHO (la foto con galones/precio/total y
 * la identidad del grifo) suele enviarse al final; el viejo `.slice(0, 4)` la recortaba justo
 * a ella. Aquí se prioriza: (1) los documentos/PDF (nota cuando llega como PDF) y (2) un abanico
 * de imágenes que EMPIEZA por las más recientes (donde suele estar la nota-foto) y va llenando
 * hacia atrás. Al final se reordenan por hora de envío para que el modelo las vea en secuencia.
 */
function seleccionarMediaCluster(candidatos: any[], cap: number): any[] {
  if (candidatos.length <= cap) return candidatos;
  const ts = (m: any) => new Date(m.recibido_en).getTime();
  const docs = candidatos.filter((m) => m.tipo === "documento");
  const imgs = candidatos.filter((m) => m.tipo !== "documento").sort((a, b) => ts(a) - ts(b));
  const elegidos: any[] = [];
  const push = (m: any) => { if (m && elegidos.length < cap && !elegidos.includes(m)) elegidos.push(m); };
  docs.forEach(push); // 1) la nota, cuando es PDF
  // 2) abanico de imágenes: primero la más reciente (nota-foto suele ir al final), luego la más
  //    antigua (el tablero/caption suele ir al inicio), alternando hacia el centro.
  let i = 0, j = imgs.length - 1;
  while (elegidos.length < cap && i <= j) {
    push(imgs[j--]);
    if (elegidos.length < cap && i <= j) push(imgs[i++]);
  }
  return elegidos.sort((a, b) => ts(a) - ts(b));
}

/**
 * Cómo se lee el odómetro de cada unidad: la guía del operador (vehiculos.guia_odometro /
 * vehiculos_tercero.guia_odometro) y CUÁNTOS DÍGITOS tiene su odómetro. Se carga una sola vez
 * por lote, solo si hay algún candidato con pinta de combustible (para no gastar la consulta
 * en lotes sin eso).
 *
 * La consulta filtraba `.not("guia_odometro","is",null)`, así que una unidad sin guía escrita a
 * mano no llegaba al prompt NI SIQUIERA con su número de dígitos — que el ERP siempre sabe, sale
 * de `kilometraje_actual`. Dos datos distintos con dueños distintos: la guía es una opinión que
 * alguien teclea, la forma del número es un hecho de la base. Atar el hecho a la opinión es lo
 * que dejó al modelo leyendo tableros a ciegas y devolviendo un dígito de más (ver
 * `bloqueFormaOdometro` en lib/vision-ia.ts, el mismo agujero en el otro carril de lectura).
 * Cuesta una línea corta de prompt por unidad; leer mal un odómetro cuesta bastante más.
 */
async function cargarGuiasOdometro(sb: any): Promise<{ placa: string; guia: string | null; digitos: number | null }[]> {
  try {
    // Se manda la cantidad de dígitos, nunca el km exacto (ver ContextoPrompt.guiasOdometro).
    const [{ data: propios }, { data: terceros }] = await Promise.all([
      sb.from("vehiculos").select("placa, guia_odometro, kilometraje_actual"),
      sb.from("vehiculos_tercero").select("placa, guia_odometro, kilometraje_actual"),
    ]);
    const filas = [...((propios as any[]) ?? []), ...((terceros as any[]) ?? [])];
    return filas
      .map((f) => {
        const km = Number(f.kilometraje_actual ?? 0);
        return {
          placa: String(f.placa ?? "").trim(),
          guia: String(f.guia_odometro ?? "").trim() || null,
          digitos: km > 0 ? Math.round(km).toString().length : null,
        };
      })
      // Una unidad sin placa no se puede nombrar, y una sin guía NI dígitos no aporta nada.
      .filter((f) => f.placa && (f.guia || f.digitos));
  } catch {
    return [];
  }
}

// Alerta única por día cuando se agota el presupuesto de IA.
async function alertaPresupuesto(sb: any, inicioDiaUtc: string, limite: number) {
  try {
    const { data } = await sb
      .from("radar_alertas")
      .select("id")
      .eq("tipo", "sistema")
      .gte("created_at", inicioDiaUtc)
      .limit(1);
    if ((data as any[])?.length) return;
    await crearAlerta(sb, {
      tipo: "sistema",
      severidad: "atencion",
      titulo: "🛰️ Radar IA en pausa: límite diario de gasto IA alcanzado",
      detalle: `Se alcanzó el límite de $${limite} configurado. Los mensajes quedan pendientes y se procesarán mañana, o sube el límite en /radar-ia > Configuración.`,
      href: "/radar-ia?tab=configuracion",
    });
  } catch {
    // la alerta es cortesía: nunca frena el pipeline
  }
}

// ── Procesamiento de un mensaje ──────────────────────────────────────────────

type ResultadoMensaje = { estado: "procesado" | "descartado" | "fusionado" | "error"; costo: number };

async function procesarMensaje(
  sb: any,
  mensaje: any,
  config: RadarConfig,
  /** Ejecutar la categoría aunque esté apagada (global o para el grupo). */
  forzarCategorias: boolean,
  grupoInfo: GrupoInfo | null,
  guiasOdometro: { placa: string; guia: string | null; digitos: number | null }[],
  leccionesOdo: string,
  leccionesComb: string
): Promise<ResultadoMensaje> {
  const ctx: ContextoPrompt = {
    grupo: mensaje.grupo_nombre,
    remitente: mensaje.remitente_nombre ?? mensaje.remitente_wa,
    // "Hoy" para la IA es el día en que se MANDÓ el mensaje, no el día en que se procesa. En vivo es
    // lo mismo (se procesa a los minutos); al reprocesar las recargas de hace tres semanas no: un
    // caption «cargué hoy» se habría fechado el día del reproceso, y el año de un voucher se juzga
    // contra el «hoy» que diga el prompt.
    fechaHoy: fechaLimaDeTs(mensaje.ts_mensaje) ?? fechaLima(),
    horaAhora: horaLimaDeTs(mensaje.ts_mensaje) ?? horaLima(),
    palabrasClave: config.palabras_clave,
    contextoGrupo: grupoInfo?.contexto ?? null,
    guiaVoucher: config.guia_voucher,
    guiasOdometro,
    leccionesOdometro: leccionesOdo,
    leccionesCombustible: leccionesComb,
  };

  // Categorías efectivas para ESTE grupo: las globales, restringidas además por
  // radar_grupos.categorias_permitidas si el operador definió una lista para el grupo.
  const categoriasEfectivas =
    grupoInfo?.categorias_permitidas && grupoInfo.categorias_permitidas.length > 0
      ? config.categorias_activas.filter((c) => grupoInfo.categorias_permitidas!.includes(c))
      : config.categorias_activas;

  let entrada = 0;
  let salida = 0;
  let costoTotal = 0;
  const modeloTriage = config.modelo_triage || "claude-haiku-4-5";
  const modeloExtraccion = config.modelo_extraccion || "claude-sonnet-5";
  // Acumula tokens y costo atribuyendo cada llamada a su propio modelo
  const sumar = (modelo: string, r: RespuestaIA) => {
    entrada += r.entrada;
    salida += r.salida;
    costoTotal += costoUsd(modelo, r.entrada, r.salida);
  };

  const finalizar = async (
    estado: ResultadoMensaje["estado"],
    campos: Record<string, unknown>
  ): Promise<ResultadoMensaje> => {
    const costo = Math.round(costoTotal * 10000) / 10000;
    await sb
      .from("radar_mensajes")
      .update({
        estado,
        tokens_entrada: entrada,
        tokens_salida: salida,
        costo_usd: costo,
        procesado_en: new Date().toISOString(),
        error: null,
        ...campos,
      })
      .eq("id", mensaje.id);
    return { estado, costo };
  };

  // 0) ¿Es parte de un reporte multi-mensaje (texto+foto odómetro+foto voucher) que ya
  //    tiene una "primaria" más antigua? Si sí, se fusiona sin gastar IA en esta fila.
  const cluster = await resolverCluster(sb, mensaje);
  if (!cluster.primaria) {
    return finalizar("fusionado", {
      accion: "fusionado_en_otro_mensaje",
      resumen_ia: "Mensaje fusionado con otro del mismo reporte (mismo remitente y grupo, pocos minutos de diferencia)",
      resultado: { fusionado_en: cluster.primariaId },
    });
  }

  // 1) Resolver el texto a analizar según el tipo de mensaje
  let texto: string = String(mensaje.texto ?? "").trim();

  if (mensaje.tipo === "audio") {
    let transcripcion: string | null = mensaje.transcripcion ?? null;
    if (!transcripcion && mensaje.media_url) {
      // `radar-media` es privado: el enlace guardado ya no se descarga; se firma para esta bajada.
      transcripcion = await transcribirAudio((await firmarUrl(sb, mensaje.media_url)) ?? mensaje.media_url, mensaje.media_mime);
      if (transcripcion) await sb.from("radar_mensajes").update({ transcripcion }).eq("id", mensaje.id);
    }
    if (!transcripcion) {
      return finalizar("descartado", {
        categoria: "otros",
        accion: "sin_transcripcion",
        resumen_ia: "Nota de voz sin transcripción disponible (configura OPENAI_API_KEY para transcribir)",
      });
    }
    texto = transcripcion;
  }

  if (mensaje.tipo === "video" && !texto) {
    return finalizar("descartado", {
      categoria: "otros",
      accion: "tipo_no_soportado",
      resumen_ia: "Video sin texto: el Radar no analiza videos",
    });
  }

  const esPdf = (mensaje.media_mime ?? "").toLowerCase().includes("pdf");

  // 1b) Vista combinada del cluster: si hay "hermanos" (misma ráfaga de reporte), se juntan
  //     sus textos y sus fotos (voucher + odómetro) en una sola extracción, no una por mensaje.
  const clusterMiembros = cluster.miembros && cluster.miembros.length > 1 ? cluster.miembros : [mensaje];
  const textoClusterCombinado = clusterMiembros
    .map((m) => (m.id === mensaje.id ? texto : String(m.texto ?? m.transcripcion ?? "").trim()))
    .filter(Boolean)
    .join("\n");
  const MAX_MEDIA_CLUSTER = 8;
  const mediaCandidatos = clusterMiembros.filter(
    (m) =>
      !!m.media_url &&
      (m.tipo === "imagen" || (m.tipo === "documento" && (m.media_mime ?? "").toLowerCase().includes("pdf")))
  );
  const miembrosConMedia = seleccionarMediaCluster(mediaCandidatos, MAX_MEDIA_CLUSTER);
  const conVisionCluster = miembrosConMedia.length > 0;

  // Documento no-PDF sin caption y sin nada más útil en el cluster: nada que analizar
  if (mensaje.tipo === "documento" && !esPdf && !textoClusterCombinado && !conVisionCluster) {
    return finalizar("descartado", {
      categoria: "otros",
      accion: "tipo_no_soportado",
      resumen_ia: `Documento ${mensaje.media_nombre ?? ""} en formato no analizable (solo PDF)`.trim(),
    });
  }
  if (
    (mensaje.tipo === "imagen" || mensaje.tipo === "documento") &&
    !mensaje.media_url &&
    !textoClusterCombinado &&
    !conVisionCluster
  ) {
    return finalizar("descartado", {
      categoria: "otros",
      accion: "sin_contenido",
      resumen_ia: "Adjunto sin descargar y sin texto: nada que analizar",
    });
  }

  // 2) Clasificar (+ extraer, si aplica)
  let categoria: CategoriaRadar;
  let confianza: number;
  let resumenIa: string;
  let datos: any = null;

  if (conVisionCluster) {
    // Imagen/PDF (uno o varios del mismo reporte): una sola llamada con visión que clasifica y extrae.
    // `radar-media` es PRIVADO: Anthropic descarga la foto por su enlace, así que se le pasa uno
    // FIRMADO (1 h: cubre el reintento de abajo). El guardado ya no abre nada, y sin esto cada
    // voucher caería en "fotos no disponibles" sin que ningún error lo dijera.
    const firmadas = await firmarUrls(sb, miembrosConMedia.map((m) => m.media_url));
    const urlDe = (u: string) => firmadas.get(u) ?? u;
    const bloquesMedia = miembrosConMedia.map((m) =>
      m.tipo === "imagen"
        ? { type: "image", source: { type: "url", url: urlDe(m.media_url) } }
        : { type: "document", source: { type: "url", url: urlDe(m.media_url) } }
    );
    const notaMultiple =
      bloquesMedia.length > 1
        // OJO con lo que se le pide aquí: la versión anterior decía "son parte del MISMO
        // reporte … combínalos en UNA sola extracción, no los trates por separado", sin
        // excepción. Un conductor que al cerrar turno manda juntos los vouchers del DÍA hacía
        // que el modelo obedeciera y fusionara dos despachos de dos placas distintas en uno,
        // perdiendo el segundo. Ahora la ráfaga es un solo reporte SALVO prueba en contrario,
        // y la prueba son los datos del propio papel (ver album-recargas.ts).
        ? `\n\nSe adjuntan ${bloquesMedia.length} archivos que el remitente envió JUNTOS. No ignores ninguno (la nota con los importes suele ir al final del álbum).\nLo NORMAL es que sean UN mismo reporte fotografiado por partes, con ROLES distintos (tablero/odómetro, nivel de combustible, surtidor del grifo, NOTA DE DESPACHO): en ese caso combínalos en UNA sola extracción cruzando sus datos.\nPERO antes COMPRUÉBALO: si ves DOS NOTAS con número de comprobante distinto, o placas distintas, o importes distintos, son DOS RECARGAS y NO se mezclan — un conductor manda juntos los vouchers del día al cerrar el turno. Ahí, la primera va en los campos de siempre y CADA UNA DE LAS DEMÁS en "recargas_adicionales". Nunca elijas una ni promedies: los datos de un despacho no describen al otro.`
        : "";
    const prompt =
      promptExtraccionMedia(ctx) +
      (textoClusterCombinado ? `\n\nTexto/caption que acompaña al/los archivo(s):\n"""${textoClusterCombinado}"""` : "") +
      notaMultiple;
    // Robustez: si una URL de media venció o falló su descarga, la llamada ENTERA revienta y el
    // reporte se perdería (estado 'error'). Se reintenta una vez y, si sigue fallando, se degrada
    // (clasificar por el texto si lo hay, o dejar alerta de revisión) en vez de tumbar el reporte.
    let r: RespuestaIA;
    try {
      r = await llamarIA(modeloExtraccion, [...bloquesMedia, { type: "text", text: prompt }]);
    } catch (e1) {
      try {
        r = await llamarIA(modeloExtraccion, [...bloquesMedia, { type: "text", text: prompt }]);
      } catch (e2: any) {
        const detalle = String(e2?.message ?? e2).slice(0, 200);
        console.warn("[radar/motor] visión con media falló tras reintento:", detalle);
        if (textoClusterCombinado) {
          const t = await llamarIA(modeloTriage, [
            { type: "text", text: `${promptTriage(ctx)}\n\n(No se pudieron leer las fotos adjuntas; clasifica solo por el texto)\nMensaje:\n"""${textoClusterCombinado}"""` },
          ]);
          sumar(modeloTriage, t);
          const tj = extraerJSON(t.texto);
          await crearAlerta(sb, {
            mensaje_id: mensaje.id, tipo: "sistema", severidad: "atencion",
            titulo: "🛰️ Radar IA: no se pudieron leer las fotos de un reporte",
            detalle: "Las imágenes adjuntas no se pudieron descargar/analizar; se clasificó solo por el texto. Revisar el mensaje en WhatsApp.",
            href: "/radar-ia",
          }).catch(() => {});
          return finalizar("procesado", {
            categoria: normalizarCategoria(tj?.categoria),
            confianza: normalizarConfianza(tj?.confianza),
            resumen_ia: String(tj?.resumen ?? "Fotos no legibles").slice(0, 300),
            accion: "media_no_disponible",
            resultado: { nota: "Fotos no descargables; clasificado por texto.", error_media: detalle },
          });
        }
        await crearAlerta(sb, {
          mensaje_id: mensaje.id, tipo: "sistema", severidad: "atencion",
          titulo: "🛰️ Radar IA: fotos de un reporte no se pudieron leer",
          detalle: "Un mensaje con fotos (posible recarga de combustible) no se pudo analizar porque las imágenes no se descargaron. Revisar el mensaje en WhatsApp.",
          href: "/radar-ia",
        }).catch(() => {});
        return finalizar("descartado", {
          categoria: "otros", accion: "media_no_disponible",
          resumen_ia: "Fotos no disponibles/no legibles — se dejó alerta para revisión manual",
        });
      }
    }
    sumar(modeloExtraccion, r);
    const json = extraerJSON(r.texto);
    categoria = normalizarCategoria(json?.categoria);
    confianza = normalizarConfianza(json?.confianza);
    resumenIa = String(json?.resumen ?? "").slice(0, 300) || "Sin resumen";
    datos = json?.datos ?? {};
  } else {
    // Texto: triage barato primero (con el texto combinado del cluster, si lo hay)
    const textoParaClasificar = textoClusterCombinado || texto;
    const t = await llamarIA(modeloTriage, [
      { type: "text", text: `${promptTriage(ctx)}\n\nMensaje a clasificar:\n"""${textoParaClasificar}"""` },
    ]);
    sumar(modeloTriage, t);
    const triage = extraerJSON(t.texto);
    categoria = normalizarCategoria(triage?.categoria);
    confianza = normalizarConfianza(triage?.confianza);
    resumenIa = String(triage?.resumen ?? "").slice(0, 300) || "Sin resumen";

    if (categoria !== "otros" && (categoriasEfectivas.includes(categoria) || forzarCategorias)) {
      const e = await llamarIA(modeloExtraccion, [
        { type: "text", text: `${promptExtraccion(categoria, ctx)}\n\nMensaje:\n"""${textoParaClasificar}"""` },
      ]);
      sumar(modeloExtraccion, e);
      datos = extraerJSON(e.texto);
    }
  }

  // 3) Gates de categoría
  if (categoria === "otros") {
    return finalizar("descartado", {
      categoria,
      confianza,
      resumen_ia: resumenIa,
      accion: "sin_relevancia",
    });
  }
  if (!categoriasEfectivas.includes(categoria) && !forzarCategorias) {
    // Distingue si la bloqueó la config global o la restricción propia del grupo (para el feed).
    const bloqueadaSoloPorGrupo = config.categorias_activas.includes(categoria);
    return finalizar("descartado", {
      categoria,
      confianza,
      resumen_ia: resumenIa,
      accion: bloqueadaSoloPorGrupo ? "categoria_no_permitida_en_grupo" : "categoria_inactiva",
    });
  }

  // 4) Acción de la categoría (si el cluster trajo fotos y esta fila no tiene una propia,
  //    se usa la primera del cluster como evidencia — p.ej. la foto del odómetro para /combustible)
  // Todas las fotos del cluster (voucher + surtidor + odómetro) para que el panel de
  // revisión de combustible las muestre — no solo la primera. Deduplicado por URL.
  const fotosCluster = miembrosConMedia
    .filter((m: any) => !!m.media_url)
    .map((m: any) => ({ url: m.media_url as string, mime: (m.media_mime as string) ?? null, nombre: (m.media_nombre as string) ?? null }))
    .filter((f: any, i: number, arr: any[]) => arr.findIndex((x) => x.url === f.url) === i);
  const mensajeParaAccion = {
    ...mensaje,
    media_url: mensaje.media_url || miembrosConMedia[0]?.media_url || mensaje.media_url,
    fotos_cluster: fotosCluster,
    // El texto de TODA la ráfaga: la placa puede venir en el mensaje de al lado de la foto, y
    // `procedenciaPlaca` necesita verla escrita para no tomarla por adivinada.
    texto_cluster: textoClusterCombinado,
  };
  const resultado = await ejecutarAccion({ sb, mensaje: mensajeParaAccion, categoria, datos: datos ?? {}, confianza, config });

  // 4b) Fusionar el resto del cluster en esta fila (si los hubo) — ya no se procesan solos.
  if (clusterMiembros.length > 1) {
    const otrosIds = clusterMiembros.filter((m) => m.id !== mensaje.id).map((m) => m.id);
    if (otrosIds.length) {
      await sb
        .from("radar_mensajes")
        .update({
          estado: "fusionado",
          accion: "fusionado_en_otro_mensaje",
          resultado: { fusionado_en: mensaje.id },
          procesado_en: new Date().toISOString(),
          error: null,
        })
        .in("id", otrosIds)
        .eq("estado", "pendiente");
    }
  }

  // 5) UNA ACCIÓN QUE FALLÓ NO ES UN MENSAJE PROCESADO. Esto terminaba en "procesado" pasara lo que
  //    pasara, así que del 14/09 al 06/10 el feed enseñó en verde cada recarga que NO se guardó
  //    —con `error_accion` escondido en el detalle— y nadie supo que faltaban hasta revisar
  //    /combustible a mano. El motivo va a `error`, que es lo que la pantalla pinta en rojo, y el
  //    resultado se conserva entero para que el reproceso sepa qué dejó escrito esta corrida.
  const estadoFinal = estadoTrasAccion(resultado.accion);
  if (estadoFinal === "error") {
    return finalizar("error", {
      categoria,
      confianza,
      resumen_ia: resumenIa,
      resultado: { extraccion: datos, accion: resultado },
      accion: resultado.accion,
      error: String(resultado.detalle ?? "La acción falló").slice(0, 500),
    });
  }

  // 6) Notificación por correo (crítico u oportunidad) — cortesía, nunca frena
  await notificarPorCorreo(config, mensaje, categoria, resumenIa, resultado).catch(() => {});

  return finalizar("procesado", {
    categoria,
    confianza,
    resumen_ia: resumenIa,
    resultado: { extraccion: datos, accion: resultado },
    accion: resultado.accion,
  });
}

function normalizarCategoria(v: unknown): CategoriaRadar {
  const c = String(v ?? "").toLowerCase().trim() as CategoriaRadar;
  return (LISTA_CATEGORIAS as string[]).includes(c) ? c : "otros";
}

function normalizarConfianza(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

// ── Correo de alerta (Resend vía lib/notificaciones) ─────────────────────────

async function notificarPorCorreo(
  config: RadarConfig,
  mensaje: any,
  categoria: CategoriaRadar,
  resumenIa: string,
  resultado: { accion: string; detalle: string; datos?: Record<string, unknown> }
) {
  if (!config.notificar_email || !config.correos_alerta) return;
  const severidad = String((resultado.datos as any)?.severidad ?? "");
  const esRelevante = severidad === "critico" || categoria === "oportunidad_comercial";
  if (!esRelevante) return;

  const correos = config.correos_alerta
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.includes("@"));
  if (!correos.length) return;

  const titulo = String((resultado.datos as any)?.titulo ?? resumenIa);
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 560px;">
      <h2 style="color:#0b315f; margin-bottom:4px;">🛰️ Radar IA</h2>
      <p style="font-size:15px; margin:12px 0;"><strong>${titulo}</strong></p>
      <p style="color:#444;">${resultado.detalle}</p>
      <p style="color:#666; font-size:13px;">Grupo: ${mensaje.grupo_nombre ?? "—"} · Remitente: ${mensaje.remitente_nombre ?? "—"}</p>
      <p style="color:#888; font-size:12px; white-space:pre-wrap;">${String(mensaje.texto ?? "").slice(0, 400)}</p>
      <p style="font-size:13px;"><a href="${process.env.NEXT_PUBLIC_APP_URL ?? ""}/radar-ia" style="color:#1262bd;">Abrir el Radar IA</a></p>
    </div>`;
  for (const to of correos) {
    await enviarEmail({ to, subject: `🛰️ Radar IA: ${titulo.slice(0, 80)}`, html }).catch((e) =>
      console.warn("[radar/motor] email falló:", e?.message ?? e)
    );
  }
}

// ── Reproceso: un mensaje con su ráfaga, y en lote los que fallaron ──────────

const COLS_RAFAGA = "id, estado, accion, grupo_id, tipo, texto, remitente_wa, remitente_nombre, recibido_en, resultado";

/**
 * Hasta dónde se buscan eslabones de una ráfaga encadenada al reprocesar (seis ventanas: una hora a
 * cada lado). No está medido: es holgado para un reporte de recarga, que dura minutos. Lo que quede
 * más allá no se pierde: sigue fallido y entra en la vuelta siguiente.
 */
const ALCANCE_RAFAGA_MS = 6 * VENTANA_CLUSTER_MS;

/**
 * Vuelve a pasar UN mensaje por el pipeline CON SU RÁFAGA (ver `rafagaAReactivar`): sin esto,
 * reprocesar la foto principal de un reporte la analizaba sola, sin la nota de despacho que se
 * había fundido en ella. Lo que el mensaje ya dejó escrito lo cuida `ejecutarAccion` (lo propuesto
 * se retira, lo comprometido no se repite) y lo que otros caminos registraron —a mano o desde la
 * factura— lo cuida el cruce contra /combustible de la acción de combustible.
 *
 * Devuelve `primaria`: el mensaje que de verdad se procesó (el más antiguo de la ráfaga, que puede
 * no ser el que se pulsó). El resultado de la ráfaga entera vive en esa fila.
 */
export async function reprocesarMensaje(
  mensajeId: string,
  opts?: { forzarCategorias?: boolean; yaIntentadosHasta?: string | null }
): Promise<ResumenProcesamiento & { reactivados: number; primaria: string }> {
  const sb = db();
  const leer = async (id: string): Promise<MensajeRafaga | null> => {
    const { data, error } = await sb.from("radar_mensajes").select(COLS_RAFAGA).eq("id", id).maybeSingle();
    if (error) throw new Error(`radar_mensajes: ${error.message}`);
    return (data as MensajeRafaga | null) ?? null;
  };
  const pulsado = await leer(mensajeId);
  if (!pulsado) throw new Error("Mensaje no encontrado");
  // Uno fusionado se reprocesa desde la principal en que se fundió (`raizDeReproceso`); si esa ya
  // no existe, desde él mismo.
  const raiz = raizDeReproceso(pulsado);
  const m = (raiz !== pulsado.id ? await leer(raiz) : null) ?? pulsado;
  if (m.estado === "procesando") throw new Error("El mensaje se está procesando en este momento: espera un minuto y vuelve a intentarlo.");

  // 1) Lo sin terminar de esa persona en ese grupo, con margen para encadenar la ráfaga: el
  //    encadenado lo decide `rafagaAReactivar`, aquí solo se trae de dónde elegir.
  const centro = Date.parse(m.recibido_en);
  let cercanos: MensajeRafaga[] = [];
  if (m.grupo_id && Number.isFinite(centro) && m.remitente_wa) {
    const { data, error } = await sb.from("radar_mensajes").select(COLS_RAFAGA)
      .or(FILTRO_SIN_TERMINAR).eq("grupo_id", m.grupo_id).eq("remitente_wa", m.remitente_wa)
      .gte("recibido_en", new Date(centro - ALCANCE_RAFAGA_MS).toISOString())
      .lte("recibido_en", new Date(centro + ALCANCE_RAFAGA_MS).toISOString());
    if (error) throw new Error(`radar_mensajes (ráfaga): ${error.message}`);
    cercanos = (data as MensajeRafaga[]) ?? [];
  }
  const ya = { yaIntentadosHasta: opts?.yaIntentadosHasta ?? null };
  // 2) Lo fundido en CUALQUIERA de ellos, no solo en `m`: cada uno pudo ser la principal de su
  //    propio trozo de la ráfaga.
  const componente = rafagaAReactivar(m, cercanos, VENTANA_CLUSTER_MS, ya).ids;
  const { data: fundidas, error: eF } = await sb.from("radar_mensajes").select(COLS_RAFAGA)
    .eq("estado", "fusionado").in("resultado->>fusionado_en", componente);
  if (eF) throw new Error(`radar_mensajes (ráfaga): ${eF.message}`);
  const plan = rafagaAReactivar(m, [...cercanos, ...((fundidas as MensajeRafaga[]) ?? [])], VENTANA_CLUSTER_MS, ya);

  // Volver a pendiente (permite reprocesar procesados, descartados y con error). Nunca uno que otra
  // corrida tiene tomado: devolverlo a pendiente en mitad de su proceso lo haría correr dos veces.
  const { error: eUpd } = await sb
    .from("radar_mensajes")
    .update({ estado: "pendiente", error: null, accion: null })
    .in("id", plan.ids)
    .neq("estado", "procesando");
  if (eUpd) throw new Error(`radar_mensajes: ${eUpd.message}`);

  const forzarCategorias = opts?.forzarCategorias ?? true;
  const resumen = await procesarPendientes({ limite: 1, soloMensajeId: plan.primaria, forzar: true, forzarCategorias });

  // 3) Lo reactivado que el motor no juntó con la primaria —una ráfaga más larga que la ventana, o
  //    una primaria que procesó sola porque al lado había un mensaje ya terminado— se procesa aquí,
  //    en orden, en vez de quedarse en la cola esperando al cron sin que la pantalla lo cuente.
  const { data: quedan } = await sb.from("radar_mensajes").select("id")
    .in("id", plan.ids).eq("estado", "pendiente").order("recibido_en", { ascending: true });
  for (const q of (quedan as { id: string }[] | null) ?? []) {
    const r = await procesarPendientes({ limite: 1, soloMensajeId: q.id, forzar: true, forzarCategorias });
    resumen.procesados += r.procesados;
    resumen.descartados += r.descartados;
    resumen.errores += r.errores;
    resumen.omitidos += r.omitidos;
    resumen.costo_usd = Math.round((resumen.costo_usd + r.costo_usd) * 10000) / 10000;
  }
  return { ...resumen, reactivados: Math.max(0, plan.ids.length - 1), primaria: plan.primaria };
}

export type ResultadoReprocesoLote = {
  reprocesados: number;
  /** Terminaron bien (procesado, descartado o fundido en otro). */
  resueltos: number;
  /** Volvieron a fallar: siguen en la lista, con su motivo. */
  siguen: number;
  /** Mensajes de sus ráfagas que volvieron a la cola con ellos (fundidos o fallidos de al lado). */
  arrastrados: number;
  /** Fallidos que todavía no se miraron en esta pasada. */
  quedan: number;
  /** `recibido_en` del último mirado: la próxima llamada sigue DESPUÉS de él. */
  ultimo: string | null;
  costo_usd: number;
  detalle: { id: string; primaria: string; estado: string; accion: string | null; error: string | null }[];
};

/**
 * Reprocesa, de a uno y del más viejo al más nuevo, los mensajes que FALLARON desde `desde`
 * (FILTRO_FALLIDOS: el mismo con que la pantalla los cuenta), cada uno CON SU RÁFAGA. Cada uno una
 * sola vez por pasada: se avanza con un cursor, porque uno que vuelve a fallar seguiría siendo «el
 * más viejo» y ocuparía todas las vueltas, y el cursor viaja también al reproceso de la ráfaga
 * (`yaIntentadosHasta`) para que un fallido ya intentado no se vuelva a pagar arrastrado por el de al
 * lado. Respeta las categorías apagadas (un mensaje que se cayó antes de clasificarse no puede
 * terminar ejecutando lo que el operador apagó).
 *
 * Por tiempo, no por cantidad: una lectura con fotos tarda de segundos a un minuto, y la función
 * tiene un techo. Pasado el presupuesto no se EMPIEZA otro: el que está en curso termina. Lo que
 * falta lo pide la pantalla en la siguiente llamada.
 */
export async function reprocesarFallidos(opts: {
  desde: string;
  despuesDe?: string | null;
  presupuestoMs?: number;
}): Promise<ResultadoReprocesoLote> {
  const sb = db();
  const inicio = Date.now();
  const presupuesto = opts.presupuestoMs ?? 150_000;
  const res: ResultadoReprocesoLote = {
    reprocesados: 0, resueltos: 0, siguen: 0, arrastrados: 0, quedan: 0, ultimo: opts.despuesDe ?? null, costo_usd: 0, detalle: [],
  };
  const siguiente = () => {
    let q = sb.from("radar_mensajes").select("id, recibido_en")
      .or(FILTRO_FALLIDOS).gte("recibido_en", opts.desde)
      .order("recibido_en", { ascending: true }).limit(1);
    if (res.ultimo) q = q.gt("recibido_en", res.ultimo);
    return q;
  };

  while (Date.now() - inicio < presupuesto) {
    const { data, error } = await siguiente();
    if (error) throw new Error(`radar_mensajes: ${error.message}`);
    const sig = ((data as { id: string; recibido_en: string }[]) ?? [])[0];
    if (!sig) break;
    const yaIntentadosHasta = res.ultimo;
    res.ultimo = sig.recibido_en;
    res.reprocesados++;
    let motivo: string | null = null;
    let primaria = sig.id;
    let errores = 0;
    try {
      const r = await reprocesarMensaje(sig.id, { forzarCategorias: false, yaIntentadosHasta });
      res.costo_usd += r.costo_usd;
      res.arrastrados += r.reactivados;
      primaria = r.primaria;
      errores = r.errores;
    } catch (e: unknown) {
      motivo = String((e as Error)?.message ?? e).slice(0, 300);
    }
    // Se juzga por la PRIMARIA: si `sig` se fundió en una más antigua, su propio estado diría
    // «fusionado» —un éxito— aunque la ráfaga entera haya vuelto a fallar.
    const { data: fin } = await sb.from("radar_mensajes").select("estado, accion, error").eq("id", primaria).maybeSingle();
    const final = (fin as { estado?: string; accion?: string | null; error?: string | null } | null) ?? null;
    const estado = String(final?.estado ?? "error");
    const quedoMal = motivo != null || errores > 0 || esFallido({ estado, accion: final?.accion ?? null });
    if (quedoMal) res.siguen++;
    else res.resueltos++;
    res.detalle.push({
      id: sig.id,
      primaria,
      estado,
      accion: final?.accion ?? null,
      error: motivo ?? final?.error ?? null,
    });
  }

  let qc = sb.from("radar_mensajes").select("id", { count: "exact", head: true }).or(FILTRO_FALLIDOS).gte("recibido_en", opts.desde);
  if (res.ultimo) qc = qc.gt("recibido_en", res.ultimo);
  const { count } = await qc;
  res.quedan = count ?? 0;
  res.costo_usd = Math.round(res.costo_usd * 10000) / 10000;
  return res;
}
