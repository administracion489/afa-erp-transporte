// lib/costos/rendimiento-flota.ts — El CARGADOR: lee Supabase y devuelve las placas ya
// medidas, con la forma que `lib/costos/rendimiento-tipo.ts` sabe agregar. No decide nada:
// no compara contra el parámetro, no propone y no escribe. Es la misma separación que
// `lib/costeo-propio.ts` (motor puro) contra quien le resuelve los parámetros — y la que
// permite que la matriz de pruebas corra sin base de datos.
//
// NO MIDE NADA POR SU CUENTA. El rendimiento lo calcula `seriesRendimiento` (lib/rendimiento.ts),
// el mismo motor que pinta /combustible y que juzga los vouchers del Radar. Un segundo motor
// aquí sería el bug que este ERP ya pagó en el semáforo de puntualidad: dos mitades del
// tablero contestando distinto a la misma pregunta.
import {
  seriesRendimiento, juzgarTramo, mediana, MIN_TRAMOS_CONFIABLE,
  type CargaRendimiento, type Serie, type Tramo, type MotivoSinRendimiento,
} from "@/lib/rendimiento";
import { hoyLima, sumarDias } from "@/lib/odometro-analitica";
import { paginarFilas } from "@/lib/huella";
import { DIAS_RECIENTE, type Flota, type PlacaMedida } from "./rendimiento-tipo";

/** Las columnas de `combustible` que hacen falta para medir. Nunca `select("*")`: esta
 *  pantalla no muestra cargas, solo las mide, y la tabla entera son miles de filas. */
const COLS_COMBUSTIBLE =
  "id,vehiculo_id,vehiculo_tercero_id,fecha,kilometraje,galones,unidad,tipo_combustible,total";

type FilaVehiculo = { id: number; placa: string | null; tipo_vehiculo_costeo: string | null };

/**
 * Los descartes que se ENSEÑAN tachados. Es el MISMO conjunto que `resumen.tramosDescartados`
 * de lib/rendimiento.ts, heredado literal y no reelegido: dos definiciones de "este tramo se
 * descartó" son dos números que un día discrepan en la misma pantalla.
 *
 * Deja fuera `primera_carga` / `sin_odometro_previo` (no son descartes: es la cabeza de la
 * cadena, no hay nada antes) y `sin_odometro` / `sin_cantidad` (la carga no llegó a ser un
 * tramo; su conteo va aparte, en `cargasSinOdometro`).
 */
const MOTIVOS_DESCARTE: MotivoSinRendimiento[] = [
  "implausible", "eslabon_saltado", "familia_cruzada", "odometro_retrocede",
];

/**
 * Todas las placas de las dos flotas que apuntan a un tipo de costeo, con su serie resuelta.
 *
 * Una unidad BICOMBUSTIBLE devuelve DOS filas (la CWQ400: glp y gasolina), porque las cadenas
 * se arman por `(unidad, familia)`. Colapsarlas es trabajo del agregador, que es el único que
 * sabe qué familia pide el parámetro.
 *
 * Nunca lanza: ante un fallo de red devuelve lo que pudo leer. La pantalla que lo consume
 * publica un parámetro tecleado que sigue siendo válido; quedarse sin la columna MEDIDO es
 * peor experiencia, no un dato equivocado.
 */
export async function cargarPlacasMedidas(sb: any): Promise<PlacaMedida[]> {
  // 1 · LAS UNIDADES. Solo las que apuntan a un tipo: una placa sin categoría de costeo no
  //     entra a ningún cubo del agregado, así que traer sus cargas sería medir para nadie.
  const [propRes, terRes] = await Promise.all([
    sb.from("vehiculos").select("id,placa,tipo_vehiculo_costeo").not("tipo_vehiculo_costeo", "is", null),
    sb.from("vehiculos_tercero").select("id,placa,tipo_vehiculo_costeo").not("tipo_vehiculo_costeo", "is", null),
  ]);

  const unidades = new Map<string, { vehiculoId: number; placa: string; flota: Flota; tipoCosteo: string | null }>();
  for (const v of (propRes?.data as FilaVehiculo[] | null) ?? []) {
    unidades.set(`p${v.id}`, { vehiculoId: v.id, placa: v.placa || `#${v.id}`, flota: "propia", tipoCosteo: v.tipo_vehiculo_costeo });
  }
  for (const v of (terRes?.data as FilaVehiculo[] | null) ?? []) {
    unidades.set(`t${v.id}`, { vehiculoId: v.id, placa: v.placa || `#${v.id}`, flota: "tercero", tipoCosteo: v.tipo_vehiculo_costeo });
  }
  if (!unidades.size) return [];

  // 2 · LAS CARGAS. Paginadas y filtradas EN MEMORIA, no con un `.in()`.
  //
  //     Dos razones, y la primera es de corrección: una fila de `combustible` apunta a una de
  //     las DOS flotas (`vehiculo_id` xor `vehiculo_tercero_id`), así que un solo `.in()` se
  //     dejaría fuera la mitad en silencio, y un `.or()` con las dos listas de ids es
  //     exactamente la URL kilométrica que este repo ya reventó en /cotizaciones. La segunda
  //     es que `paginarFilas` es obligatorio pase lo que pase: PostgREST corta en 1000 filas
  //     sin avisar y una serie a la que le falte la cabeza pierde sus tramos más viejos —el
  //     mismo silencio que documenta /combustible.
  //
  //     El orden tiene que ser ESTABLE para que las páginas no se solapen ni salten filas.
  const filas = await paginarFilas(() =>
    sb.from("combustible").select(COLS_COMBUSTIBLE).order("fecha", { ascending: true }).order("id", { ascending: true })
  );

  const cargas: CargaRendimiento[] = [];
  for (const r of filas as any[]) {
    const uid = r.vehiculo_tercero_id != null ? `t${r.vehiculo_tercero_id}`
      : r.vehiculo_id != null ? `p${r.vehiculo_id}` : "";
    if (!uid || !unidades.has(uid)) continue;
    cargas.push({
      id: r.id,
      unidad: uid,
      fecha: String(r.fecha ?? "").slice(0, 10),
      kilometraje: r.kilometraje,
      cantidad: r.galones,
      unidadCantidad: r.unidad,
      tipo: r.tipo_combustible,
      gasto: r.total,
    });
  }

  // 3 · UNA SOLA LLAMADA AL MOTOR. `seriesRendimiento` es el único sitio que ve todas las
  //     familias de una unidad a la vez, así que el manejo BICOMBUSTIBLE (los tramos que
  //     cruzan el otro tanque, `familia_cruzada`) sale gratis y honesto. Partir el lote por
  //     familia antes de llamarlo lo apagaría.
  const series = seriesRendimiento(cargas);

  const desde = sumarDias(hoyLima(), -DIAS_RECIENTE);
  const out: PlacaMedida[] = [];
  for (const s of series.values()) {
    const u = unidades.get(s.resumen.unidad);
    if (!u) continue;                       // no debería pasar: las cargas ya vienen filtradas
    out.push(placaMedida(s, u, desde));
  }
  return out;
}

/** Una serie → una fila de placa medida. Aislada para que la matriz la pueda probar sin base. */
export function placaMedida(
  s: Serie,
  u: { vehiculoId: number; placa: string; flota: Flota; tipoCosteo: string | null },
  desdeReciente: string
): PlacaMedida {
  const r = s.resumen;

  // EL GATE DE HALLAZGOS CUENTA SOLO LOS NO FÍSICOS, y esto no es un detalle.
  //
  // `juzgarTramo` devuelve `rendimiento_alto` en dos casos muy distintos: el techo CONSTANTE
  // superado (`fisico: true`, un tramo que ni siquiera tiene número — el 162.9 km/gal de la
  // CWZ-371) y la banda estadística (`fisico: false`, un tramo que SÍ midió y entró a la
  // mediana 1.4× por encima del patrón de su unidad).
  //
  // El primero ya quedó fuera de la mediana por construcción: no la infla, y contarlo aquí
  // dejaría el caso que motivó toda esta funcionalidad bloqueado para siempre en
  // "revisar_cargas". El segundo SÍ está dentro de la mediana y es la firma de una carga
  // comprada, consumida y no registrada — o sea plata que falta en los libros, que es
  // exactamente el modo de fallo que abarata el presupuesto sin dejar rastro.
  let tramosAltos = 0, tramosBajos = 0;
  for (const t of s.tramos) {
    const h = juzgarTramo(t, r);
    if (!h || h.fisico) continue;
    if (h.codigo === "rendimiento_alto") tramosAltos++;
    else tramosBajos++;
  }

  // LA VENTANA RECIENTE SE FILTRA, NO SE VUELVE A SERIALIZAR. Re-partir la cadena desde una
  // fecha inventaría un eslabón: el primer tramo del recorte no tendría carga previa dentro
  // de la ventana y saldría como `primera_carga`, perdiendo un tramo bueno cada vez. Los
  // tramos ya medidos son hechos del vehículo y no cambian porque se mire un trozo del
  // calendario — la misma razón por la que /combustible mide sobre `registros` y no sobre
  // `filtrados`.
  const buenos = s.tramos.filter((t) => t.rendimiento !== null);
  const recientes = buenos.filter((t) => String(t.fecha ?? "") >= desdeReciente);

  const conFecha = s.tramos.filter((t) => !!t.fecha);
  const fechas = conFecha.map((t) => String(t.fecha)).sort();

  return {
    uid: r.unidad,
    vehiculoId: u.vehiculoId,
    placa: u.placa,
    flota: u.flota,
    tipoCosteo: u.tipoCosteo,
    familia: r.familia,
    label: r.label,
    mediana: r.mediana,
    tramos: r.n,
    confiable: r.confiable,
    medianaReciente: mediana(recientes.map((t) => t.rendimiento as number)),
    tramosReciente: recientes.length,
    tramosAltos,
    tramosBajos,
    cargasSinOdometro: r.cargasSinOdometro,
    descartes: s.tramos
      .filter((t) => t.motivo !== null && MOTIVOS_DESCARTE.includes(t.motivo))
      .map((t: Tramo) => ({ fecha: t.fecha, codigo: t.motivo as MotivoSinRendimiento, crudo: t.crudo })),
    desde: fechas[0] ?? null,
    hasta: fechas[fechas.length - 1] ?? null,
  };
}

/** Reexportado para que quien pinte la pantalla no tenga que importar de dos módulos el
 *  mismo umbral que decide si una placa vota. */
export { MIN_TRAMOS_CONFIABLE };
