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
// ══════════════════════════════════════════════════════════════════════════════

import {
  alertaCreadaUna, alertaCreadasMulti, alertaFalloMulti, alertaRetornoCompletado, enlaceIda, filaRetorno,
  mensajeErrorComprobar, mensajeErrorRetornoAtras, paradasDeIda, paradasDeRetorno, planConversion, resultadoRetorno,
  type CotParaReserva, type IdaDelRetorno, type PlanConversion,
} from "./cotizacion-a-reserva";
import type { PlanRetorno } from "./cotizacion-retorno";
import { insertarServicioNuevo } from "./reservas-autoseleccion";
import { faltaColumna } from "./columna-faltante";

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
  | "parcial";

export type ResultadoConversion = {
  codigo: CodigoConversion;
  /** El aviso de la página, byte a byte. "" si no hay que decir nada (respondió que no). */
  mensaje: string;
  /** La página vuelve a leer la lista. */
  refrescar: boolean;
  /** Las idas que se crearon (en orden) y los retornos que se crearon. */
  idas: number[];
  retornos: number[];
};

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
  let plan: PlanConversion = planConversion(cot, { existentes: null, hoy });
  if (plan.codigo === "no_aprobada") return res("no_aprobada", plan.mensaje, false);
  const { data: existentes, error: eEx } = await sb.from("reservas").select("id,fecha_servicio,vehiculo_id,vehiculo_tercero_id,reserva_vinculada_id,estado").eq("cotizacion_id", cot.id).limit(20);
  if (eEx) return res("error", mensajeErrorComprobar(eEx.message), false);
  plan = planConversion(cot, { existentes: existentes ?? [], hoy });
  if (plan.codigo === "comprobar_retorno") {
    const { data: atras, error: eAt } = await sb.from("reservas").select("id").in("reserva_vinculada_id", plan.ids).limit(1);
    if (eAt) return res("error", mensajeErrorRetornoAtras(eAt.message), false);
    plan = planConversion(cot, { existentes: existentes ?? [], hoy, retornoAtras: !!atras?.length });
  }

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
    case "ya_convertida": return res("ya_convertida", plan.mensaje, false);
    case "retorno_imposible": return res("retorno_imposible", plan.mensaje, false);
    case "completar_retorno": {
      if (!(await preguntar(plan.confirmar))) return res("cancelada", "", false);
      const errs: (string | null)[] = [];
      for (const ida of plan.idas) errs.push(await crearRetorno(ida, plan.retorno));
      return res("retorno_completado", alertaRetornoCompletado(plan.retorno, errs, plan.idas.length), true, [], retornos);
    }
    case "crear": {
      if (plan.confirmar && !(await preguntar(plan.confirmar))) return res("cancelada", "", false);
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
