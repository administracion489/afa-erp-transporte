// app/api/paradas/materializar/route.ts — Crea los paraderos de los servicios de HOY que nadie abrió.
//
//   GET (cron cada 10 min, Bearer CRON_SECRET) → para cada servicio de hoy que «Elige tu ruta de
//        hoy» podría ofrecer y que todavía no tiene filas en `paradas`, las crea desde su semilla
//        con las MISMAS reglas que el «Iniciar» del conductor (lib/paradas-materializar.ts). Después
//        geocodifica, por nombre como él, los paraderos de esos servicios que sigan sin coordenadas
//        — los recién creados y los de antes: el «Iniciar» devuelve tal cual las filas que ya
//        existen, así que lo que este cron cree sin coordenadas lo tiene que completar él.
//
// Por qué al empezar el día y no al generar el programa: ver la cabecera del motor. Es, a todos
// los efectos, alguien abriendo cada servicio de hoy de madrugada.
//
// LO QUE NO HACE, A PROPÓSITO:
//   · No toca servicios con paraderos (ni los completa ni los reordena).
//   · No crea paraderos de un retorno de cotización salvo que PRUEBE que son de retorno
//     (`estadoRetorno`): el dueño prohibió deducirlos de la ida — cada sentido tiene su paradero, y
//     su hora. Se listan en la respuesta, por cotización y con su motivo.
//   · No crea paraderos sin nombre (`semilla_sin_nombres`, el formato del Cotizador).
//   · No inventa paraderos desde `origen`/`destino` de texto libre (el respaldo del «Iniciar»):
//     sin semilla no hay paraderos definidos que ofrecer, y geocodificar texto suelto de
//     madrugada sin nadie mirando no es lo mismo que hacerlo con el conductor delante.
//   · Si una lectura falla, no escribe NADA: «no encontré filas» por un error haría duplicar los
//     paraderos de servicios que ya los tienen.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { esCronAutorizado } from "@/lib/api-auth";
import { hoyLima } from "@/lib/alertas";
import { geocodificarConCache } from "@/lib/geocode-cache";
import {
  ESTADOS_SIN_INICIAR, planDeServicio, sobrantesTrasCarrera, faltanCoordenadas,
  type ServicioSemilla, type CotizacionSemilla, type CodigoMaterializar, type PlanServicio,
} from "@/lib/paradas-materializar";

export const maxDuration = 60;

const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
type Admin = ReturnType<typeof admin>;

/** Deja de empezar trabajo nuevo pasado esto (servicio o geocodificación): el próximo tick (10 min)
 *  sigue donde quedó. Lo que no se alcanza a geocodificar queda sin coordenadas y se reintenta. */
const PRESUPUESTO_MS = 45_000;
const LOTE = 150;
const PAG = 1000;

/** Lee todas las páginas o falla entera: una lectura parcial aquí se convierte en filas duplicadas. */
async function todasLasPaginas<T>(
  pedir: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let desde = 0; ; desde += PAG) {
    const { data, error } = await pedir(desde, desde + PAG - 1);
    if (error) throw new Error(error.message);
    out.push(...(data || []));
    if (!data || data.length < PAG) return out;
  }
}

async function correr(sb: Admin, hoy: string) {
  const t0 = Date.now();

  // 1. Candidatos: lo mismo que la rama «hoy» de reservas_disponibles.
  const candidatos = await todasLasPaginas<ServicioSemilla>((d, h) =>
    sb.from("reservas")
      .select("id,fecha_servicio,estado,cliente_id,permite_autoseleccion,cotizacion_id,direccion_servicio,paradas_json")
      .eq("fecha_servicio", hoy)
      .in("estado", [...ESTADOS_SIN_INICIAR])
      .eq("permite_autoseleccion", true)
      .not("cliente_id", "is", null)
      .order("id")
      .range(d, h));
  const ids = candidatos.map((r) => r.id);

  // 2. Cuáles ya tienen paraderos.
  const conParaderos = new Set<number>();
  for (let i = 0; i < ids.length; i += LOTE) {
    const lote = ids.slice(i, i + LOTE);
    const filas = await todasLasPaginas<{ reserva_id: number }>((d, h) =>
      sb.from("paradas").select("reserva_id").in("reserva_id", lote).order("id").range(d, h));
    filas.forEach((f) => conParaderos.add(Number(f.reserva_id)));
  }

  // 3. Las cotizaciones de los que no los tienen (para la cascada y la regla del retorno).
  const cotIds = [...new Set(candidatos
    .filter((r) => !conParaderos.has(r.id) && r.cotizacion_id != null)
    .map((r) => Number(r.cotizacion_id)))];
  const cots = new Map<number, CotizacionSemilla>();
  for (let i = 0; i < cotIds.length; i += LOTE) {
    const { data, error } = await sb.from("cotizaciones")
      .select("id,paradas_json,paradas_retorno_json").in("id", cotIds.slice(i, i + LOTE));
    if (error) throw new Error(error.message);
    (data || []).forEach((c: any) => cots.set(Number(c.id), c));
  }

  // 4. El plan.
  const planes: PlanServicio[] = candidatos.map((r) =>
    planDeServicio(r, hoy, conParaderos.has(r.id),
      r.cotizacion_id != null ? (cots.get(Number(r.cotizacion_id)) ?? null) : undefined));

  const porCodigo: Partial<Record<CodigoMaterializar, number>> = {};
  const contar = (c: CodigoMaterializar) => { porCodigo[c] = (porCodigo[c] ?? 0) + 1; };
  const retornosSinLista = new Map<string, { cotizacion_id: number | null; motivo: CodigoMaterializar; reservas: number[] }>();
  const errores: string[] = [];
  let creados = 0, filasCreadas = 0, carreras = 0, geocodificadas = 0, sinCoordenadas = 0, pendientes = 0;
  const fueraDeTiempo = () => Date.now() - t0 > PRESUPUESTO_MS;

  for (const plan of planes) {
    if (plan.codigo !== "crear") {
      contar(plan.codigo);
      if (plan.codigo === "retorno_sin_lista" || plan.codigo === "retorno_semilla_distinta" || plan.codigo === "retorno_sin_cotizacion") {
        const k = `${plan.cotizacion_id}|${plan.codigo}`;
        const g = retornosSinLista.get(k) ?? { cotizacion_id: plan.cotizacion_id, motivo: plan.codigo, reservas: [] };
        g.reservas.push(plan.reserva_id);
        retornosSinLista.set(k, g);
      }
      continue;
    }
    if (fueraDeTiempo()) { pendientes++; continue; }

    // a. Justo antes de escribir: ¿alguien los creó mientras tanto?
    const ya = await sb.from("paradas").select("id").eq("reserva_id", plan.reserva_id).limit(1);
    if (ya.error) { errores.push(`#${plan.reserva_id}: ${ya.error.message}`); continue; }
    if ((ya.data || []).length > 0) { contar("ya_tiene_paraderos"); continue; }

    // b. Todas las filas del servicio en UNA sentencia: o entran todas o ninguna.
    const ins = await sb.from("paradas").insert(plan.filas).select("id");
    if (ins.error) { errores.push(`#${plan.reserva_id}: ${ins.error.message}`); continue; }
    const nuevas = (ins.data || []) as { id: number }[];

    // c. ¿Otro camino los creó a la vez? Entonces sobran los NUESTROS (las otras pueden tener ya
    //    un pasajero). Nunca se borra una fila que no hayamos insertado. Si dos corridas del cron
    //    chocan, las dos borran las suyas y el servicio queda sin paraderos hasta el próximo tick:
    //    se prefiere ese hueco de 10 minutos a un itinerario duplicado que nadie limpia.
    const act = await sb.from("paradas").select("id").eq("reserva_id", plan.reserva_id);
    if (act.error) { errores.push(`#${plan.reserva_id} (comprobación): ${act.error.message}`); }
    else {
      const sobran = sobrantesTrasCarrera(nuevas.map((n) => n.id), (act.data || []).map((a: any) => Number(a.id)));
      if (sobran.length > 0) {
        const pp = await sb.from("pasajeros_parada").select("parada_id").in("parada_id", sobran).limit(1);
        if (!pp.error && (pp.data || []).length === 0) {
          const del = await sb.from("paradas").delete().in("id", sobran);
          if (del.error) errores.push(`#${plan.reserva_id} (duplicado): ${del.error.message}`);
          carreras++;
          contar("ya_tiene_paraderos");
          continue;
        }
        errores.push(`#${plan.reserva_id}: se crearon paraderos a la vez desde otro lado; revisar duplicados`);
      }
    }
    creados++;
    filasCreadas += nuevas.length;
    contar("crear");
  }

  // 5. Coordenadas que falten, como el «Iniciar»: por nombre, con la caché compartida (que también
  //    memoriza los nombres irresolubles, así que repetirlos cada tick no vuelve a pagar a Google).
  //    Sobre TODOS los candidatos con paraderos —los de este tick y los de antes—, acotado por
  //    tiempo y no por cantidad: un tope de nombres dejaba atascados los mismos irresolubles al
  //    frente de la cola, y lo que no se alcanza hoy lo recoge el próximo tick.
  const memoGeo = new Map<string, { lat: number; lng: number } | null>();
  const conRows = candidatos.map((r) => r.id);
  geocodificar:
  for (let i = 0; i < conRows.length; i += LOTE) {
    if (fueraDeTiempo()) break;
    let sinCoords: { id: number; nombre: string | null; lat: number | null; lng: number | null }[];
    try {
      sinCoords = await todasLasPaginas((d, h) =>
        sb.from("paradas").select("id,nombre,lat,lng")
          .in("reserva_id", conRows.slice(i, i + LOTE))
          .or("lat.is.null,lng.is.null,lat.eq.0,lng.eq.0")
          .order("id").range(d, h));
    } catch (e: any) {
      // Los paraderos ya están creados; solo se pierde la geocodificación de este lote hasta el próximo tick.
      errores.push(`coordenadas (lectura): ${e?.message ?? e}`);
      continue;
    }
    for (const f of sinCoords) {
      if (!faltanCoordenadas(f)) continue;
      if (fueraDeTiempo()) break geocodificar;
      const nombre = String(f.nombre ?? "").trim();
      if (!nombre) { sinCoordenadas++; continue; }
      let coords = memoGeo.get(nombre);
      if (coords === undefined) {
        const g = await geocodificarConCache(nombre);
        coords = g ? { lat: g.lat, lng: g.lng } : null;
        memoGeo.set(nombre, coords);
      }
      if (!coords) { sinCoordenadas++; continue; }
      // Solo si sigue sin coordenadas: alguien pudo ponerlas a mano mientras tanto.
      const up = await sb.from("paradas").update({ lat: coords.lat, lng: coords.lng })
        .eq("id", f.id).or("lat.is.null,lng.is.null,lat.eq.0,lng.eq.0");
      if (up.error) { sinCoordenadas++; errores.push(`parada ${f.id}: ${up.error.message}`); }
      else geocodificadas++;
    }
  }

  return {
    ok: true,
    hoy,
    candidatos: candidatos.length,
    por_codigo: porCodigo,
    servicios_con_paraderos_nuevos: creados,
    filas_creadas: filasCreadas,
    geocodificadas,
    sin_coordenadas: sinCoordenadas,
    carreras,
    pendientes,
    retornos_sin_paraderos_propios: [...retornosSinLista.values()],
    errores,
  };
}

export async function GET(req: NextRequest) {
  if (!esCronAutorizado(req)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  try {
    const r = await correr(admin(), hoyLima());
    if (r.errores.length) console.error("[paradas/materializar]", r.errores.slice(0, 20));
    return NextResponse.json(r);
  } catch (e: any) {
    // Una lectura de la fase de planificación falló: no se escribió nada (ver todasLasPaginas).
    console.error("[paradas/materializar] lectura:", e?.message);
    return NextResponse.json({ ok: false, error: e?.message ?? "error" }, { status: 500 });
  }
}
