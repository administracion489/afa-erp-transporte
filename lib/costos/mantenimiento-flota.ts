// lib/costos/mantenimiento-flota.ts — El CARGADOR del mantenimiento medido: lee Supabase y
// devuelve las placas con su serie ya resuelta, con la forma que
// `lib/costos/mantenimiento-tipo.ts` sabe agregar. No decide nada: no compara contra el
// parámetro, no propone y no escribe. Es la misma separación que `rendimiento-flota.ts` contra
// `rendimiento-tipo.ts` — y la que permite que la matriz corra sin base de datos.
//
// POR QUÉ AQUÍ SÍ VIVE EL MOTOR DE MEDIDA (y en el del rendimiento no). `rendimiento-flota.ts`
// no mide: siembra `seriesRendimiento`, que ya existía. El S/km de mantenimiento NO lo calcula
// ningún otro sitio del ERP —`indicadoresEconomicos.costoPorKm` es el del COMBUSTIBLE, no el del
// taller—, así que el motor nace en el módulo puro (`serieMantenimiento`) y este cargador solo
// le entrega filas. El día que otra pantalla necesite el mismo número, lo importa de ahí: dos
// motores que contestan la misma pregunta terminan contestando distinto, que es literalmente el
// bug del semáforo de puntualidad.
import { hoyLima } from "@/lib/odometro-analitica";
import { paginarFilas } from "@/lib/huella";
import type { Flota } from "./rendimiento-tipo";
import { serieMantenimiento, type OtMantenimiento, type PlacaMantenimiento } from "./mantenimiento-tipo";

/** Las columnas de `mantenimiento` que hacen falta para medir. Nunca `select("*")`: esta
 *  pantalla no muestra órdenes, solo las mide. */
const COLS_MANTENIMIENTO = "id,vehiculo_id,fecha,kilometraje,costo,costo_imputado,estado,tipo,descripcion";
/** Las mismas sin la columna de `mantenimiento-06`, que el deploy no corre. */
const COLS_SIN_IMPUTADO = "id,vehiculo_id,fecha,kilometraje,costo,estado,tipo,descripcion";

type FilaVehiculo = { id: number; placa: string | null; anio?: number | null; tipo_vehiculo_costeo: string | null };

/**
 * Todas las placas de las dos flotas que apuntan a un tipo de costeo, con su serie de
 * mantenimiento resuelta.
 *
 * `mantenimiento` NO tiene `vehiculo_tercero_id` (a diferencia de `combustible` y
 * `lecturas_odometro`, que sí lo recibieron): las órdenes de trabajo son siempre de la flota
 * propia. Las de tercero se traen igual —y sin serie— porque HEREDAN el parámetro del tipo y la
 * pantalla tiene que nombrarlas: una unidad que se ve en la flota y no aparece en ninguna lista
 * es una unidad que el operador busca y no está.
 *
 * Nunca lanza: ante un fallo devuelve lo que pudo leer. La pantalla que lo consume publica un
 * parámetro tecleado que sigue siendo válido; quedarse sin la columna MEDIDO es peor
 * experiencia, no un dato equivocado.
 */
export async function cargarPlacasMantenimiento(sb: any, hoy: string = hoyLima()): Promise<PlacaMantenimiento[]> {
  // 1 · LAS UNIDADES. Solo las que apuntan a un tipo: una placa sin categoría de costeo no entra
  //     a ningún cubo del agregado, así que traer sus órdenes sería medir para nadie.
  //
  //     `anio` solo existe en `vehiculos`. Se pide aquí —y no en un tercer cargador— porque el
  //     cotejo de antigüedad (`cotejarAntiguedadTipo`) reparte las placas por el MISMO
  //     `tipo_vehiculo_costeo` y con la misma lista: dos lecturas de la misma flota es como una
  //     se queda atrás.
  const [propRes, terRes] = await Promise.all([
    sb.from("vehiculos").select("id,placa,anio,tipo_vehiculo_costeo").not("tipo_vehiculo_costeo", "is", null),
    sb.from("vehiculos_tercero").select("id,placa,tipo_vehiculo_costeo").not("tipo_vehiculo_costeo", "is", null),
  ]);

  const unidades = new Map<string, Omit<PlacaMantenimiento, "serie" | "otsTotales">>();
  for (const v of (propRes?.data as FilaVehiculo[] | null) ?? []) {
    unidades.set(`p${v.id}`, {
      uid: `p${v.id}`, vehiculoId: v.id, placa: v.placa || `#${v.id}`,
      flota: "propia" as Flota, tipoCosteo: v.tipo_vehiculo_costeo,
      anio: v.anio != null ? Number(v.anio) : null,
    });
  }
  for (const v of (terRes?.data as FilaVehiculo[] | null) ?? []) {
    unidades.set(`t${v.id}`, {
      uid: `t${v.id}`, vehiculoId: v.id, placa: v.placa || `#${v.id}`,
      flota: "tercero" as Flota, tipoCosteo: v.tipo_vehiculo_costeo,
      // `vehiculos_tercero` no tiene año de fabricación. Un null es "no se sabe", y el cotejo de
      // antigüedad lo trata como tal en vez de inventarle una edad.
      anio: null,
    });
  }
  if (!unidades.size) return [];

  // 2 · LAS ÓRDENES. Paginadas: PostgREST corta en 1000 filas sin avisar, y una serie a la que
  //     le falte la cabeza pierde sus tramos más viejos — el mismo silencio que ya truncó la
  //     huella del GPS y las reservas de /programacion. El orden tiene que ser ESTABLE para que
  //     las páginas no se solapen ni salten filas.
  //
  //     EL COSTO QUE SE MIDE ES EL DESEMBOLSO **MÁS** EL IMPUTADO, y esa suma es la mitad que
  //     hace honesto el mecánico propio. `mantenimiento.costo` solo lleva lo que salió de la
  //     caja; la hora del mecánico de planilla y el repuesto de almacén viven en
  //     `costo_imputado` (mantenimiento-06) porque `v_egresos` no puede contarlos —ya los pagó
  //     la planilla—. Pero el kilómetro SÍ los costó: sin sumarlos, el día que AFA contrate un
  //     mecánico el S/km medido bajaría sin que el costo real hubiera bajado, la columna
  //     «Medido» propondría ese número y el precio ofertado de la categoría bajaría con él.
  //     Un costo corto se descubre cuando el servicio ya se prestó.
  //
  //     Se reintenta sin la columna: `mantenimiento-06` es accesoria y el deploy no la corre.
  let filas = await paginarFilas(() =>
    sb.from("mantenimiento").select(COLS_MANTENIMIENTO)
      .order("fecha", { ascending: true }).order("id", { ascending: true })
  );
  if (!filas.length) {
    filas = await paginarFilas(() =>
      sb.from("mantenimiento").select(COLS_SIN_IMPUTADO)
        .order("fecha", { ascending: true }).order("id", { ascending: true })
    );
  }

  const porUnidad = new Map<string, OtMantenimiento[]>();
  for (const r of filas as any[]) {
    if (r.vehiculo_id == null) continue;
    const uid = `p${r.vehiculo_id}`;
    if (!unidades.has(uid)) continue;
    if (!porUnidad.has(uid)) porUnidad.set(uid, []);
    porUnidad.get(uid)!.push({
      id: r.id,
      fecha: String(r.fecha ?? "").slice(0, 10),
      km: r.kilometraje != null ? Number(r.kilometraje) : null,
      costo: Number(r.costo || 0) + Number(r.costo_imputado || 0),
      estado: r.estado ?? null,
      tipo: r.tipo ?? null,
      descripcion: r.descripcion ?? null,
    });
  }

  const out: PlacaMantenimiento[] = [];
  for (const [uid, u] of unidades) {
    const ots = porUnidad.get(uid) ?? [];
    out.push({ ...u, otsTotales: ots.length, serie: serieMantenimiento(ots, hoy) });
  }
  return out;
}
