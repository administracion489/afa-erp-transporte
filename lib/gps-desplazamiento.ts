// lib/gps-desplazamiento.ts
// ─────────────────────────────────────────────────────────────────────────────
// ¿Se movió la unidad? — verificación del odómetro contra el GPS.
//
// POR QUÉ NO MEDIMOS KILÓMETROS AQUÍ
// El ERP ya mide km por GPS en lib/km-servicio.ts, pero atado a UNA reserva y sobre la huella
// limpia, que descarta los saltos > 300 m como huecos y por diseño SUBESTIMA. Medido contra el
// odómetro en 19 jornadas reales de esta flota (09/08/2026), el km del GPS crudo dio entre el
// 9 % y el 427 % del odómetro: el jitter de una unidad parada infla la suma de tramos y la
// cobertura intermitente la hunde. Con ese error no se puede afirmar "recorrió N km", y menos
// insinuar que alguien ocultó kilometraje.
//
// LO QUE SÍ SE PUEDE AFIRMAR
// Dos cantidades que no dependen de medir bien la trayectoria, solo de dónde estuvo la unidad:
//
//   · radioKm  — lo más lejos que se la vio del punto de partida. El ruido GPS no aleja: oscila
//                alrededor del sitio. Un vehículo parado tiene radio de metros aunque la suma
//                de sus tramos dé kilómetros.
//   · kmMinimo — cota INFERIOR del recorrido: se conservan solo los puntos que distan ≥ SALTO_MIN
//                del anterior conservado y se suman esos tramos. Por desigualdad triangular el
//                recorrido real nunca es menor, así que este número JAMÁS sobreestima. Y como
//                SALTO_MIN es mucho mayor que el error del GPS, el jitter no suma.
//
// En las mismas 19 jornadas, 2 × radioKm no superó al odómetro NI UNA VEZ: por eso la
// contradicción se declara sobre esa cota y no sobre una medición.
//
// Se consulta por (vehículo, rango) — no por reserva — porque el recorrido que no queda en
// ninguna reserva es justamente el que un odómetro desactualizado no muestra.
// ─────────────────────────────────────────────────────────────────────────────

import { distM, paginarFilas } from "@/lib/huella";

/** Salto mínimo (m) para que un punto cuente como desplazamiento y no como ruido del GPS. */
const SALTO_MIN_M = 300;

/** Precisión (m) por encima de la cual el fix se descarta: es triangulación de red, no satélite. */
const PRECISION_MAX_M = 150;

/** Radio (m) por debajo del cual la unidad se considera QUIETA (cubre el jitter de un parqueo). */
export const RADIO_QUIETO_M = 300;

/** Hueco (min) que parte la cobertura: por encima, el GPS estuvo apagado, no la unidad quieta. */
const HUECO_COBERTURA_MIN = 15;

export type Flota = "propia" | "tercero";

export type Desplazamiento = {
  puntos: number;              // fixes utilizables en la ventana
  radioKm: number;             // lo más lejos del punto de partida
  kmMinimo: number;            // cota INFERIOR del recorrido (nunca sobreestima)
  minutosConGps: number;       // minutos realmente cubiertos por el GPS
  minutosVentana: number;      // minutos que dura la ventana pedida
  coberturaPct: number;        // minutosConGps / minutosVentana (0 si no hay ventana)
  desdeGps: string | null;     // primer y último fix utilizable (ISO)
  hastaGps: string | null;
  /** Terminó cerca de donde empezó ⇒ tuvo que desandar el camino (duplica la cota inferior). */
  volvioAlOrigen: boolean;
};

const VACIO: Desplazamiento = {
  puntos: 0, radioKm: 0, kmMinimo: 0, minutosConGps: 0,
  minutosVentana: 0, coberturaPct: 0, desdeGps: null, hastaGps: null, volvioAlOrigen: false,
};

/**
 * Desplazamiento de UNA unidad entre dos instantes, leyendo `ubicaciones_gps` por vehículo.
 * `client` debe ser service-role: los puntos de la flota tercerizada no son legibles con RLS.
 */
export async function desplazamientoGps(
  client: any,
  opts: { vehiculo_id: number; flota: Flota; desde: string | Date; hasta: string | Date }
): Promise<Desplazamiento> {
  const desde = new Date(opts.desde), hasta = new Date(opts.hasta);
  if (!opts.vehiculo_id || !Number.isFinite(desde.getTime()) || !Number.isFinite(hasta.getTime())) return VACIO;
  const minutosVentana = Math.max(0, Math.round((hasta.getTime() - desde.getTime()) / 60000));
  if (minutosVentana <= 0) return { ...VACIO, minutosVentana };

  const col = opts.flota === "tercero" ? "vehiculo_tercero_id" : "vehiculo_id";
  // paginarFilas: PostgREST corta a 1000 y una jornada densa (fix cada 3 s) pasa de 10 000 puntos.
  // Sin paginar, la huella queda truncada y el desplazamiento sale corto — el error que ya
  // truncó la huella GPS y las reservas en este repo.
  const filas = await paginarFilas(() =>
    client
      .from("ubicaciones_gps")
      .select("lat,lng,precision_m,created_at,timestamp")
      .eq(col, opts.vehiculo_id)
      .gte("created_at", desde.toISOString())
      .lte("created_at", hasta.toISOString())
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
  );

  return calcularDesplazamiento(filas, minutosVentana);
}

/**
 * Núcleo puro (sin red): filas crudas → desplazamiento. Exportado para poder probarlo y para
 * reusarlo cuando los puntos ya se cargaron por otra vía.
 */
export function calcularDesplazamiento(filas: any[], minutosVentana = 0): Desplazamiento {
  const pts = (filas || [])
    .map((f) => ({
      lat: Number(f.lat),
      lng: Number(f.lng),
      acc: f.precision_m != null ? Number(f.precision_m) : 25,
      ts: new Date(f.created_at || f.timestamp || 0).getTime(),
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.acc <= PRECISION_MAX_M && p.ts > 0)
    .sort((a, b) => a.ts - b.ts);

  if (!pts.length) return { ...VACIO, minutosVentana };

  const base = pts[0];
  let radioM = 0;
  let kmMinimo = 0;
  let ancla = base;
  let minutosConGps = 0;

  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const dBase = distM(base.lat, base.lng, p.lat, p.lng);
    if (dBase > radioM) radioM = dBase;

    // Cota inferior: solo cuentan los avances reales, nunca el temblor sobre el mismo sitio.
    const dAncla = distM(ancla.lat, ancla.lng, p.lat, p.lng);
    if (dAncla >= SALTO_MIN_M) { kmMinimo += dAncla; ancla = p; }

    // Cobertura: se suman los intervalos entre fixes, salvo los huecos largos (GPS apagado).
    if (i > 0) {
      const gapMin = (p.ts - pts[i - 1].ts) / 60000;
      if (gapMin <= HUECO_COBERTURA_MIN) minutosConGps += gapMin;
    }
  }

  // Volvió si terminó a menos de un tercio del radio (o a menos de 1 km) del punto de partida.
  // Es la diferencia entre "fue y volvió" (recorrido ≥ 2 × radio) y "se quedó allá" (≥ 1 × radio).
  const fin = pts[pts.length - 1];
  const dFin = distM(base.lat, base.lng, fin.lat, fin.lng);
  const volvioAlOrigen = radioM > 0 && (dFin <= Math.max(1000, radioM / 3));

  return {
    puntos: pts.length,
    radioKm: Math.round(radioM / 100) / 10,
    kmMinimo: Math.round(kmMinimo / 100) / 10,
    minutosConGps: Math.round(minutosConGps),
    minutosVentana,
    coberturaPct: minutosVentana > 0 ? Math.min(100, Math.round((minutosConGps / minutosVentana) * 100)) : 0,
    desdeGps: new Date(pts[0].ts).toISOString(),
    hastaGps: new Date(pts[pts.length - 1].ts).toISOString(),
    volvioAlOrigen,
  };
}

export type VeredictoGps =
  | "sin_gps"        // no hay puntos utilizables: el GPS no puede opinar
  | "sin_odometro"   // la unidad se movió pero la jornada no tiene con qué medirla (falta cierre)
  | "detenida"       // el GPS confirma que la unidad no se movió
  | "coherente"      // lo que muestra el GPS cabe dentro del km del odómetro
  | "supera";        // el GPS prueba un recorrido MAYOR que el que registró el odómetro

export type Verificacion = {
  veredicto: VeredictoGps;
  /** Recorrido mínimo que el GPS demuestra, en km (la cota más exigente de las dos). */
  kmProbado: number;
  /** Cuánto excede ese mínimo al km del odómetro (0 si no lo excede). */
  excedeKm: number;
  gps: Desplazamiento;
  detalle: string;
};

/**
 * Contrasta el km que registró el odómetro con lo que el GPS puede DEMOSTRAR.
 *
 * `kmProbado` se apoya SOLO en el radio, no en `kmMinimo`:
 *   · si la unidad terminó cerca de donde empezó, para volver tuvo que desandar lo andado
 *     → recorrido ≥ 2 × radio;
 *   · si terminó lejos, → recorrido ≥ radio.
 *
 * Por qué no se usa `kmMinimo` para acusar, aunque también sea una cota inferior: cuando el fix
 * viene de triangulación de red la posición oscila entre torres separadas cientos de metros, y
 * esos brincos superan el filtro de ruido y se suman como si fueran avance. Contrastado con las
 * 29 jornadas de esta flota que tienen km de odómetro (09/08/2026), `kmMinimo` habría señalado 6
 * —incluida una de 388 km dentro de un radio de 6,7 km, imposible— mientras que 2 × radio no
 * señaló NINGUNA. El radio no se deja engañar por esas oscilaciones: para subirlo hay que
 * alejarse de verdad. `kmMinimo` viaja igual en el resultado, como dato de contexto.
 *
 * El precio de esa prudencia: no se detecta a quien acumula muchos kilómetros en vueltas cortas
 * sin alejarse. Se detecta lo que se puede probar sin margen de duda.
 *
 * `supera` NO es una acusación: puede faltar la lectura de cierre, el check-out, o el odómetro
 * pudo leerse de una foto anterior. El texto lo dice así a propósito — el módulo entero evita
 * acusar (ver la cabecera de app/api/jornada/auditoria/route.ts).
 */
export function verificarConGps(
  kmOdometro: number | null,
  gps: Desplazamiento,
  opts: { toleranciaKm?: number; volvioAlOrigen?: boolean } = {}
): Verificacion {
  const tol = opts.toleranciaKm != null ? Math.max(0, opts.toleranciaKm) : 5;
  if (!gps.puntos) {
    return { veredicto: "sin_gps", kmProbado: 0, excedeKm: 0, gps, detalle: "Sin puntos GPS utilizables en la jornada" };
  }

  if (gps.radioKm * 1000 <= RADIO_QUIETO_M) {
    return {
      veredicto: "detenida",
      kmProbado: 0,
      excedeKm: 0,
      gps,
      detalle: `El GPS confirma la unidad detenida: no se alejó más de ${Math.round(gps.radioKm * 1000)} m en ${gps.minutosConGps} min de señal`,
    };
  }

  // ¿Volvió al punto de partida? Lo decide la propia traza; el llamador puede forzarlo.
  const volvio = opts.volvioAlOrigen ?? gps.volvioAlOrigen;
  const kmProbado = Math.round(gps.radioKm * (volvio ? 2 : 1) * 10) / 10;

  const odo = kmOdometro != null && Number.isFinite(kmOdometro) ? Number(kmOdometro) : null;
  if (odo == null) {
    // Se movió, pero la jornada no tiene dos lecturas con las que medirla. No hay contradicción
    // que declarar —falta el dato—, y decir "supera" aquí sería acusar a quien no cerró jornada.
    return {
      veredicto: "sin_odometro",
      kmProbado,
      excedeKm: 0,
      gps,
      detalle: `La unidad se movió (se alejó ${gps.radioKm} km, al menos ${kmProbado} km de recorrido) pero la jornada no tiene kilometraje con qué compararlo: falta la lectura de cierre`,
    };
  }

  const exceso = Math.round((kmProbado - odo) * 10) / 10;
  if (exceso > tol) {
    return {
      veredicto: "supera",
      kmProbado,
      excedeKm: exceso,
      gps,
      detalle: `El GPS muestra al menos ${kmProbado} km (se alejó ${gps.radioKm} km del punto de partida y volvió) y el odómetro registró ${odo} km: faltan ${exceso} km por explicar`,
    };
  }

  return {
    veredicto: "coherente",
    kmProbado,
    excedeKm: 0,
    gps,
    detalle: `El recorrido del GPS (mínimo ${kmProbado} km) cabe dentro de los ${odo} km del odómetro`,
  };
}
