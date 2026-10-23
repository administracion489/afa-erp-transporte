// ══════════════════════════════════════════════════════════════════════════════
// lib/cotizacion-a-reserva-datos.ts — EL EJECUTOR de «→ Res.»: hace lo que dice el plan de
// lib/cotizacion-a-reserva.ts (PURO) contra la base. Recibe el cliente de Supabase INYECTADO (el del
// navegador en /cotizaciones, el de service-role en el «Hay unidad» del CRM), así que no crea ninguno
// al importarse y vale para los dos lados.
//
// Es `convertirAReserva` de app/cotizaciones/page.tsx sin los `alert`/`confirm`: devuelve el mismo
// aviso (`mensaje`, byte a byte el de la página), si hay que refrescar, y los ids de lo que creó.
// La matriz (scripts/prueba-cotizacion-a-reserva.mts) lo corre contra el algoritmo viejo copiado
// literal sobre la misma base falsa y exige las MISMAS escrituras en el mismo orden, los mismos
// avisos y las mismas preguntas.
//
// Lo que hace (y nada más que eso):
//  · lee lo que ya existe (`cotizacion_id`, limit 20) y, si el plan lo pide, si un retorno apunta a
//    las idas; una lectura que falla NO es «todavía no tiene reservas»: no se crea nada;
//  · inserta con `insertarServicioNuevo` (suelta la casilla SOLO si el error la nombra) y suelta
//    `direccion_servicio` SOLO si el error la nombra;
//  · crea los paraderos de la ida (en la primera) y el retorno de cada ida, con sus paraderos, y los
//    enlaza por los dos lados.
//
// EL CANDADO (supabase/cotizaciones-07-candado-conversion.sql). «→ Res.» y el «Hay unidad» del CRM
// convierten la MISMA cotización con este mismo ejecutor; pulsados a la vez, los dos leían «todavía no
// tiene reservas» y los dos creaban: la reserva quedaba duplicada. Ahora, justo antes de escribir (y
// DESPUÉS de la pregunta de la página: un `confirm` abierto no retiene a nadie), se toma el candado de
// la cotización con la hora del servidor, se VUELVE a leer lo que ya tiene y se vuelve a planear; si
// el plan cambió (otra persona la convirtió mientras tanto), no se escribe nada. El candado se suelta
// al terminar, falle lo que falle. Sin la migración (o con un cliente que no llama funciones) se
// convierte como antes y `aviso` lo dice; con el candado tomado por otro, `ocupada`.
// ══════════════════════════════════════════════════════════════════════════════

import {
  alertaCreadaUna, alertaCreadasMulti, alertaFalloMulti, alertaRetornoCompletado, enlaceIda, filaRetorno,
  mensajeErrorComprobar, mensajeErrorRetornoAtras, paradasDeIda, paradasDeRetorno, planConversion, resultadoRetorno,
  type CotParaReserva, type IdaDelRetorno, type PlanConversion,
} from "./cotizacion-a-reserva";
import type { PlanRetorno } from "./cotizacion-retorno";
import { insertarServicioNuevo } from "./reservas-autoseleccion";
import { faltaColumna, funcionQueFalta } from "./columna-faltante";

// El cliente llega de dos sitios (navegador y servicio): se tipa lo mínimo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

/**
 * La cotización como la lee el plan. `select("*")` a propósito (como el detalle de /cotizaciones):
 * varias columnas que el plan mira son de migraciones accesorias (moneda, retorno, coordenadas), y
 * una que falta llega `undefined`, que el plan ya trata como «no hay». LANZA si no se puede leer.
 */
export async function leerCotParaReserva(sb: Sb, id: number): Promise<CotParaReserva | null> {
  const { data, error } = await sb.from("cotizaciones").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`No se pudo leer la cotización ${id}: ${error.message}`);
  return (data ?? null) as CotParaReserva | null;
}

export type CodigoConversion =
  /** Se crearon las idas (y sus retornos, salvo lo que diga el aviso). */
  | "creada"
  /** Faltaba solo el retorno de una conversión de antes, y se creó. */
  | "retorno_completado"
  | "no_aprobada" | "ya_convertida" | "retorno_imposible"
  /** Quien convierte dijo que no a la pregunta (dólares, completar el retorno): no se escribió nada. */
  | "cancelada"
  /** No se creó ninguna ida (lectura caída o la primera inserción falló). */
  | "error"
  /** Se crearon algunas idas y la siguiente falló (las creadas se quedan). */
  | "parcial"
  /** Otra persona está convirtiendo esta cotización en este momento (el candado está tomado): no se escribió nada. */
  | "ocupada"
  /** Mientras se preguntaba, otra persona creó o cambió sus reservas: no se escribió nada. */
  | "cambio";

export type ResultadoConversion = {
  codigo: CodigoConversion;
  /** El aviso de la página, byte a byte. "" si no hay que decir nada (respondió que no). */
  mensaje: string;
  /** La página vuelve a leer la lista. */
  refrescar: boolean;
  /** Las idas que se crearon (en orden) y los retornos que se crearon. */
  idas: number[];
  retornos: number[];
  /** Lo que la pantalla dice APARTE del aviso (hoy: que se convirtió sin el candado). */
  aviso?: string | null;
};

// ── El candado (supabase/cotizaciones-07-candado-conversion.sql) ─────────────

export const SQL_CANDADO_CONVERSION = "supabase/cotizaciones-07-candado-conversion.sql";
/** Cuánto dura el candado si la conversión muere a mitad (operativo, NO medido: crear ida, retorno y paraderos tarda segundos). */
export const SEGUNDOS_CANDADO = 120;
export const MENSAJE_OCUPADA = "Otra persona está creando la reserva de esta cotización en este mismo momento (desde «→ Res.» o desde «Hay unidad» del CRM). Espera unos segundos y vuelve a intentarlo: no se creó nada.";
export const MENSAJE_CAMBIO = "Mientras confirmabas, otra persona creó o cambió las reservas de esta cotización. No se creó nada: vuelve a pulsar para ver cómo quedó.";
export const AVISO_SIN_CANDADO = `Se convirtió sin candado: falta correr ${SQL_CANDADO_CONVERSION}. Sin él, dos personas convirtiendo la misma cotización a la vez pueden duplicar la reserva.`;

export type Candado =
  | { codigo: "tomado"; hasta: string }
  | { codigo: "ocupado" }
  /** La función no existe (falta la migración) o el cliente no llama funciones: se convierte como antes. */
  | { codigo: "sin_candado" }
  | { codigo: "error"; detalle: string };

/** Toma el candado de la cotización con la hora del SERVIDOR. Nunca lanza. */
export async function reclamarConversion(sb: Sb, cotId: number, segundos = SEGUNDOS_CANDADO): Promise<Candado> {
  if (typeof sb?.rpc !== "function") return { codigo: "sin_candado" };
  try {
    const { data, error } = await sb.rpc("fn_cotizacion_reclamar_conversion", { p_cotizacion_id: cotId, p_segundos: segundos });
    if (error) {
      if (funcionQueFalta(error) != null || faltaColumna(error, "conversion_hasta")) return { codigo: "sin_candado" };
      return { codigo: "error", detalle: `No se pudo tomar el turno para crear la reserva (${String(error.message ?? "error")}). Vuelve a intentar en un momento: no se creó nada.` };
    }
    const estado = String((data as { estado?: unknown } | null)?.estado ?? "");
    const hasta = String((data as { hasta?: unknown } | null)?.hasta ?? "");
    if (estado === "tomado" && hasta) return { codigo: "tomado", hasta };
    if (estado === "ocupado") return { codigo: "ocupado" };
    if (estado === "no_existe") return { codigo: "error", detalle: "La cotización ya no existe (o no tienes permiso para verla): no se creó nada." };
    // «no_tomado» (y «sin_permiso», el nombre de una versión anterior del SQL): la fila se veía libre y no se
    // pudo escribir. O alguien la tomó en ese mismo instante, o esta sesión no puede editar la cotización.
    if (estado === "no_tomado" || estado === "sin_permiso") return { codigo: "error", detalle: "No se pudo tomar el turno para crear la reserva: otra persona la está convirtiendo en este mismo momento, o no tienes permiso para editar esta cotización. Espera unos segundos y vuelve a intentarlo: no se creó nada." };
    return { codigo: "error", detalle: "No se pudo tomar el turno para crear la reserva. Vuelve a intentar en un momento: no se creó nada." };
  } catch (e) {
    return { codigo: "error", detalle: `No se pudo tomar el turno para crear la reserva (${e instanceof Error ? e.message : String(e)}). Vuelve a intentar en un momento: no se creó nada.` };
  }
}

/** Suelta el candado SI sigue siendo el nuestro. Nunca lanza (si falla, vence solo). */
export async function soltarConversion(sb: Sb, cotId: number, hasta: string): Promise<void> {
  try { await sb.rpc("fn_cotizacion_soltar_conversion", { p_cotizacion_id: cotId, p_hasta: hasta }); } catch { /* vence solo */ }
}

const res = (codigo: CodigoConversion, mensaje: string, refrescar: boolean, idas: number[] = [], retornos: number[] = []): ResultadoConversion =>
  ({ codigo, mensaje, refrescar, idas, retornos });

/**
 * Ejecuta «→ Res.» sobre `cot` (la fila entera, `leerCotParaReserva`). `confirmar` es la pregunta de la
 * página (`confirm`): con dólares o al completar un retorno; quien no pregunta (el CRM) pasa
 * `() => true`. `hoy` es la fecha de Lima (la de la ida si la cotización no tiene).
 */
export async function ejecutarConversion(
  sb: Sb,
  cot: CotParaReserva,
  opts: { hoy: string; confirmar?: (texto: string) => boolean | Promise<boolean> },
): Promise<ResultadoConversion> {
  const preguntar = async (t: string) => (opts.confirmar ? !!(await opts.confirmar(t)) : true);
  const hoy = opts.hoy;
  const inicial: PlanConversion = planConversion(cot, { existentes: null, hoy });
  if (inicial.codigo === "no_aprobada") return res("no_aprobada", inicial.mensaje, false);
  const leido = await leerYPlanear(sb, cot, hoy);
  if (!leido.ok) return res("error", leido.mensaje, false);
  let plan: PlanConversion = leido.plan;

  // Lo que no escribe nada sale antes del candado.
  if (plan.codigo === "ya_convertida") return res("ya_convertida", plan.mensaje, false);
  if (plan.codigo === "retorno_imposible") return res("retorno_imposible", plan.mensaje, false);
  if (plan.codigo !== "crear" && plan.codigo !== "completar_retorno") return res("error", "", false);
  const pregunta = plan.confirmar || null;
  if (pregunta && !(await preguntar(pregunta))) return res("cancelada", "", false);

  const candado = await reclamarConversion(sb, cot.id);
  if (candado.codigo === "ocupado") return res("ocupada", MENSAJE_OCUPADA, false);
  if (candado.codigo === "error") return res("error", candado.detalle, false);
  const aviso = candado.codigo === "sin_candado" ? AVISO_SIN_CANDADO : null;
  try {
    if (candado.codigo === "tomado") {
      // Bajo el candado: lo que se leyó antes de la pregunta puede ser viejo.
      const otra = await leerYPlanear(sb, cot, hoy);
      if (!otra.ok) return res("error", otra.mensaje, false);
      if (JSON.stringify(otra.plan) !== JSON.stringify(plan)) {
        if (otra.plan.codigo === "ya_convertida") return res("ya_convertida", otra.plan.mensaje, true);
        return res("cambio", MENSAJE_CAMBIO, true);
      }
      plan = otra.plan;
    }
    const r = await escribirPlan(sb, cot, plan);
    return aviso ? { ...r, aviso } : r;
  } finally {
    if (candado.codigo === "tomado") await soltarConversion(sb, cot.id, candado.hasta);
  }
}

/** Lee lo que ya existe de la cotización y planea. Una lectura que falla NO es «todavía no tiene reservas». */
async function leerYPlanear(sb: Sb, cot: CotParaReserva, hoy: string): Promise<{ ok: true; plan: PlanConversion } | { ok: false; mensaje: string }> {
  const { data: existentes, error: eEx } = await sb.from("reservas").select("id,fecha_servicio,vehiculo_id,vehiculo_tercero_id,reserva_vinculada_id,estado").eq("cotizacion_id", cot.id).limit(20);
  if (eEx) return { ok: false, mensaje: mensajeErrorComprobar(eEx.message) };
  let plan = planConversion(cot, { existentes: existentes ?? [], hoy });
  if (plan.codigo === "comprobar_retorno") {
    const { data: atras, error: eAt } = await sb.from("reservas").select("id").in("reserva_vinculada_id", plan.ids).limit(1);
    if (eAt) return { ok: false, mensaje: mensajeErrorRetornoAtras(eAt.message) };
    plan = planConversion(cot, { existentes: existentes ?? [], hoy, retornoAtras: !!atras?.length });
  }
  return { ok: true, plan };
}

/** Escribe lo que dice el plan («crear» o «completar_retorno»; lo demás no escribe nada). */
async function escribirPlan(sb: Sb, cot: CotParaReserva, plan: PlanConversion): Promise<ResultadoConversion> {

  const insertar = (f: Record<string, unknown>) => insertarServicioNuevo((x) => sb.from("reservas").insert(x).select().single(), f);
  const retornos: number[] = [];
  const crearRetorno = async (ida: IdaDelRetorno, retorno: PlanRetorno): Promise<string | null> => {
    if (retorno.codigo !== "ok") return null;
    const fila = filaRetorno(cot, retorno, ida);
    let ins = await insertar(fila);
    if (ins.error && faltaColumna(ins.error, "direccion_servicio")) { const { direccion_servicio: _d, ...sin } = fila; void _d; ins = await insertar(sin); }
    if (ins.error || !ins.data) return resultadoRetorno({ insertError: ins.error?.message || "sin respuesta", enlaceError: null, paradasError: null });
    const retId = ins.data.id as number;
    retornos.push(retId);
    let up = await sb.from("reservas").update(enlaceIda(retId)).eq("id", ida.id);
    if (up.error && faltaColumna(up.error, "direccion_servicio")) up = await sb.from("reservas").update(enlaceIda(retId, false)).eq("id", ida.id);
    const { error: eP } = await sb.from("paradas").insert(paradasDeRetorno(retorno, retId));
    return resultadoRetorno({ insertError: null, enlaceError: up.error?.message ?? null, paradasError: eP?.message ?? null });
  };

  switch (plan.codigo) {
    case "completar_retorno": {
      const errs: (string | null)[] = [];
      for (const ida of plan.idas) errs.push(await crearRetorno(ida, plan.retorno));
      return res("retorno_completado", alertaRetornoCompletado(plan.retorno, errs, plan.idas.length), true, [], retornos);
    }
    case "crear": {
      const p = plan;
      const insertParadas = async (id: number): Promise<string | null> => {
        if (p.paradas.length < 1) return null;
        const { error } = await sb.from("paradas").insert(paradasDeIda(p.paradas, id));
        return error ? error.message : null;
      };
      const idas: number[] = [];
      if (!p.multi) {
        const { data: r, error } = await insertar(p.idas[0].fila);
        if (error) return res("error", String(error.message), false);
        if (r) idas.push(r.id as number);
        const eParadas = r ? await insertParadas(r.id) : null;
        const eRet = r ? await crearRetorno(r, p.retorno) : null;
        return res("creada", alertaCreadaUna({ nParadas: p.paradas.length, eParadas, eRet, retorno: p.retorno, notaTc: p.notaTc }), true, idas, retornos);
      }
      let count = 0; let eParadas: string | null = null; const errsRet: (string | null)[] = [];
      for (const ida of p.idas) {
        const { data: r, error } = await insertar(ida.fila);
        if (error) {
          return res(count > 0 ? "parcial" : "error", alertaFalloMulti({ count, total: p.idas.length, error: `${error.message}`, nParadas: p.paradas.length, eParadas }), true, idas, retornos);
        }
        if (r) idas.push(r.id as number);
        if (r && ida.conParadas) eParadas = await insertParadas(r.id);
        if (r) errsRet.push(await crearRetorno(r, p.retorno));
        count++;
      }
      return res("creada", alertaCreadasMulti({ count, nParadas: p.paradas.length, eParadas, errsRet, retorno: p.retorno, notaTc: p.notaTc }), true, idas, retornos);
    }
    default: return res("error", "", false);
  }
}
