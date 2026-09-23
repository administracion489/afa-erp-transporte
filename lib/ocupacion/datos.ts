// ══════════════════════════════════════════════════════════════════════════════
// lib/ocupacion/datos.ts
// El que LEE. `lib/ocupacion/semanal.ts` es el motor puro y no toca la base; acá
// se juntan las cuatro piezas que necesita y se le entregan ya resueltas.
//
// NADA SE MIDE NI SE DECIDE AQUÍ. Este módulo no cuenta pasajeros (lo hace
// `lib/manifiesto-conteo.ts`, el mismo que usa el portal), no resuelve el pax
// contratado (lo hace `resolverPaxDeServicio`, el mismo que usa /programacion) y
// no juzga si cabe una unidad menor (lo hace el motor). Un cargador que además
// midiera sería un segundo motor contestando las mismas preguntas — y el correo
// del sábado le diría al cliente algo distinto de lo que ve en su portal.
// ══════════════════════════════════════════════════════════════════════════════

import { normalizaEstado } from "@/lib/estados";
import { contarPasajeros } from "@/lib/manifiesto-conteo";
import { identidadRuta } from "@/lib/ruta-identidad";
import { sentidoDeReserva } from "@/lib/liquidacion-agrupacion";
import {
  resolverPaxDeServicio,
  cargarPaxDeCotizaciones,
  cargarRutasContratadas,
} from "@/lib/liquidacion-rutas";
import type { ServicioOcupacion, EscalonFlota } from "@/lib/ocupacion/semanal";

const COLS =
  "id,fecha_servicio,hora_servicio,estado,origen,destino,ruta_nombre,cliente_id," +
  "cotizacion_id,reserva_vinculada_id,capacidad_contratada,vehiculo_id,vehiculo_tercero_id";
const COLS_SIN_MIGRACION =
  "id,fecha_servicio,hora_servicio,estado,origen,destino,ruta_nombre,cliente_id," +
  "cotizacion_id,reserva_vinculada_id,vehiculo_id,vehiculo_tercero_id";

/** Mismo patrón que `faltaColumnaTanque`: se suelta SOLO la columna que el error NOMBRA. */
const faltaCapacidadContratada = (e: { message?: string } | null | undefined): boolean => {
  const m = String(e?.message ?? "").toLowerCase();
  return m.includes("capacidad_contratada") && m.includes("does not exist");
};

// ─── La escalera de la flota ─────────────────────────────────────────────────

/**
 * Las capacidades que AFA sabe cotizar y asignar, de `parametros_costos`.
 *
 * **NO se lee de `vehiculos`/`vehiculos_tercero`, y es deliberado.** Lo que se le
 * propone a un cliente es una CATEGORÍA con su tarifa («Sprinter 20 pax»), no una
 * placa concreta: AFA cubre la ruta con la unidad que esté disponible ese día. Es
 * la misma distinción que ya sostiene todo el costeo — la ficha es el tipo, la
 * placa es quién lo cubre. Y como es editable desde /configuracion/costos, dar de
 * alta una categoría nueva cambia lo que el reporte puede proponer sin tocar código.
 */
export async function cargarEscaleraFlota(db: any): Promise<EscalonFlota[]> {
  const { data, error } = await db
    .from("parametros_costos")
    .select("tipo_vehiculo,nombre,capacidad")
    .eq("activo", true);
  if (error) return [];
  return ((data as any[]) ?? [])
    .map((p) => ({
      clave: String(p.tipo_vehiculo ?? ""),
      nombre: String(p.nombre ?? p.tipo_vehiculo ?? ""),
      capacidad: Number(p.capacidad ?? 0),
    }))
    .filter((e) => e.clave && e.capacidad > 0);
}

// ─── Los servicios del periodo ───────────────────────────────────────────────

export type CargaOcupacion = {
  servicios: ServicioOcupacion[];
  /** false = no se pudo leer `capacidad_contratada`: falta `liquidaciones-03`. */
  hayCapacidad: boolean;
};

/**
 * Los servicios de un cliente entre dos fechas, ya con embarcados, esperados y
 * asientos contratados resueltos.
 */
export async function cargarOcupacion(
  db: any,
  clienteId: number,
  inicio: string,
  fin: string,
): Promise<CargaOcupacion> {
  let filas: any[] = [];
  let hayCapacidad = true;

  const pedir = async (cols: string) => {
    const { data, error } = await db
      .from("reservas")
      .select(cols)
      .eq("cliente_id", clienteId)
      .gte("fecha_servicio", inicio)
      .lte("fecha_servicio", fin)
      .order("fecha_servicio")
      .order("hora_servicio");
    if (error) throw new Error(error.message);
    return ((data as any[]) ?? []);
  };

  try {
    filas = await pedir(COLS);
  } catch (e: any) {
    if (!faltaCapacidadContratada(e)) throw e;
    hayCapacidad = false;
    filas = await pedir(COLS_SIN_MIGRACION);
  }

  if (!filas.length) return { servicios: [], hayCapacidad };

  const ids = filas.map((r) => Number(r.id));

  // El HERMANO puede caer fuera de la ventana —un nocturno que retorna al día
  // siguiente— y su capacidad es un escalón de la cascada. Se piden aparte los que
  // falten en vez de dar el escalón por perdido: costaría un «sin contratado»
  // falso justo en las rutas que cruzan la medianoche.
  const dentro = new Set(ids);
  const hermanosFuera = [...new Set(
    filas.map((r) => Number(r.reserva_vinculada_id ?? 0)).filter((v) => v > 0 && !dentro.has(v))
  )];

  const [conteo, paxCotizacion, catalogo, extra] = await Promise.all([
    contarPasajeros(db, ids),
    cargarPaxDeCotizaciones(db, filas.map((r) => Number(r.cotizacion_id ?? 0))),
    cargarRutasContratadas(db, [clienteId]),
    hermanosFuera.length && hayCapacidad
      ? db.from("reservas").select("id,capacidad_contratada,ruta_nombre").in("id", hermanosFuera)
          .then((r: any) => ((r.data as any[]) ?? [])).catch(() => [])
      : Promise.resolve([] as any[]),
  ]);

  const porId = new Map<number, any>([
    ...filas.map((r) => [Number(r.id), r] as [number, any]),
    ...extra.map((r: any) => [Number(r.id), r] as [number, any]),
  ]);

  // Los DOS sentidos del enlace: `reserva_vinculada_id` se escribe en dos pasos y
  // borrar un tramo deja en NULL el del superviviente, así que seguirlo solo hacia
  // adelante dejaría a todo retorno «sin contratado». Hacia atrás SOLO cuando es
  // inequívoco — con dos filas apuntando a la misma, adivinar sería leer los
  // asientos de otro servicio.
  const apuntanA = new Map<number, number[]>();
  for (const r of filas) {
    const v = Number(r.reserva_vinculada_id ?? 0);
    if (v > 0) apuntanA.set(v, [...(apuntanA.get(v) ?? []), Number(r.id)]);
  }

  const servicios: ServicioOcupacion[] = filas.map((r) => {
    const id = Number(r.id);
    const adelante = porId.get(Number(r.reserva_vinculada_id ?? 0)) ?? null;
    const atras = apuntanA.get(id);
    const hermano = adelante ?? (atras?.length === 1 ? porId.get(atras[0]) ?? null : null);

    const { pax } = hayCapacidad
      ? resolverPaxDeServicio(
          { ...r, cliente_id: clienteId } as any,
          hermano as any,
          { paxCotizacion, catalogo },
        )
      : { pax: null as number | null };

    const c = conteo.get(id) ?? { embarcados: 0, esperados: 0 };
    const idr = identidadRuta(r as any);

    return {
      reserva_id: id,
      fecha: r.fecha_servicio ?? null,
      hora: r.hora_servicio ? String(r.hora_servicio).slice(0, 5) : null,
      ruta_nombre: idr.nombre,
      recorrido: idr.recorrido,
      contratado: pax,
      embarcados: c.embarcados,
      esperados: c.esperados,
      cancelado: normalizaEstado(r.estado) === "cancelada",
      placa: null,
      // El MISMO hermano que ya resuelve el pax contratado, sin una segunda
      // definición de «quién es el hermano de este tramo». Solo sirve si está
      // DENTRO del periodo: el motor no encuentra al de fuera y deja el tramo solo,
      // que es lo correcto — su día se mide en el otro reporte.
      hermano_id: hermano ? Number(hermano.id) : null,
      // Solo ROTULA cuál es la ida y cuál el retorno. `direccion_servicio` NO se
      // pide a propósito: es de una migración accesoria y arriesgar el reporte
      // entero por una etiqueta no vale la pena. `sentidoDeReserva` cae al nombre
      // de la ruta, y como la identidad del grupo es el CONJUNTO de los dos
      // nombres, equivocarse aquí intercambia dos etiquetas y nada más.
      sentido: sentidoDeReserva(r as any),
    };
  });

  return { servicios, hayCapacidad };
}

// ─── Las placas, solo para el detalle ────────────────────────────────────────

/**
 * Rellena `placa` en los servicios. Va APARTE y es best-effort: la placa no entra
 * en ninguna decisión del motor —lo que se contrata es una categoría, no una
 * unidad— y solo sirve para que el detalle del correo diga con qué se cubrió cada
 * día. Que falle no puede dejar al cliente sin reporte.
 */
export async function anotarPlacas(
  db: any,
  servicios: ServicioOcupacion[],
  filas: { id: number; vehiculo_id: number | null; vehiculo_tercero_id: number | null }[],
): Promise<void> {
  try {
    const propios = [...new Set(filas.map((f) => Number(f.vehiculo_id ?? 0)).filter(Boolean))];
    const terceros = [...new Set(filas.map((f) => Number(f.vehiculo_tercero_id ?? 0)).filter(Boolean))];
    const [p, t] = await Promise.all([
      propios.length ? db.from("vehiculos").select("id,placa").in("id", propios) : Promise.resolve({ data: [] }),
      terceros.length ? db.from("vehiculos_tercero").select("id,placa").in("id", terceros) : Promise.resolve({ data: [] }),
    ]);
    const placaPropio = new Map(((p.data as any[]) ?? []).map((v) => [Number(v.id), String(v.placa ?? "")]));
    const placaTercero = new Map(((t.data as any[]) ?? []).map((v) => [Number(v.id), String(v.placa ?? "")]));
    const porReserva = new Map(filas.map((f) => [Number(f.id), f]));
    for (const s of servicios) {
      const f = porReserva.get(s.reserva_id);
      if (!f) continue;
      s.placa = placaPropio.get(Number(f.vehiculo_id ?? 0))
        ?? placaTercero.get(Number(f.vehiculo_tercero_id ?? 0))
        ?? null;
    }
  } catch {
    // Sin placas el reporte sale igual: no deciden nada.
  }
}
