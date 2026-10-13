// lib/flota/recorrido-datos.ts — SOLO SERVIDOR. Lee lo que arma lib/flota/recorrido.ts (puro):
//   · la traza de UN servicio, con sus filas, por el MISMO camino que la celda RASTREO de la torre y la
//     estadística por servicio de /uso-flota (`medirServicio` con `conHuella`, lib/gps-cobertura-datos.ts):
//     de ahí salen, de la misma lectura, la huella, los excesos y la medición de cobertura («sin señal»);
//   · la ruta prevista y los puentes que el modal GPS ya pagó y guardó en `rutas_cache`, en UNA sola
//     consulta (`leerRutasCache`, que LANZA si falla: un fallo nunca se lee como «no hay nada»);
//   · las horas de abordaje de los paraderos de la reserva (`pasajeros_parada`), solo las columnas que
//     hacen falta para la hora: con ellas se etiqueta cada exceso («antes del paradero 1 · sin pasajeros»).
//
// NO LLAMA A NINGÚN TERCERO: ni rutas, ni ajuste a la vía, ni direcciones. Las paradas sin coordenadas
// NO se ubican: sin ellas no hay ruta prevista que leer, y se dice. No devuelve teléfonos, nombres de
// pasajeros, identificadores de aparato ni las filas crudas: solo coordenadas, horas y velocidades.

/* eslint-disable @typescript-eslint/no-explicit-any -- el cliente de Supabase del ERP va sin tipos generados: las filas de ubicaciones_gps, reservas y paradas y los payloads de rutas_cache llegan como `any` */
import { createClient } from "@supabase/supabase-js";
import {
  medirServicio, paradasDeReservas, todas, trazaDe, fueraDelTecho, veredictoFueraDelTecho, type LectorTraza,
} from "../gps-cobertura-datos";
import { leerReservaDiag, type FilaReservaDiag } from "../gps-diagnostico-datos";
import { leerRutasCache } from "../rutas-cache";
import { vehiculoDeReserva } from "./servicio-estadistica";
import {
  recorridoDeServicio, clavesRutaPrevista, clavesPuentes, resolverRutaPrevista, hechosDelServicio,
  type RecorridoServicio, type EstadoRutaPrevista, type HechosContexto,
} from "./recorrido";
import type { VeredictoRastreo } from "../gps-cobertura";
import type { AbordajeTiempos } from "../servicio-tiempos";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/** El veredicto de un servicio cancelado: no se midió y no hay nada que juzgar. */
const CANCELADO: VeredictoRastreo = {
  codigo: "no_aplica", pct: null, problema: null, celda: "—", color: "#6b7280", bg: "#f3f4f6",
  detalle: "El servicio se canceló: no hay recorrido que medir.", ultimaSenalTs: null, enCurso: false,
};

/** Las horas de abordaje de los paraderos de la reserva: solo id (orden total), parada y hora. LANZA
 *  si la lectura falla (quien llama lo declara «no se pudieron leer», nunca «sin abordajes»). */
async function abordajesDe(paradaIds: number[]): Promise<AbordajeTiempos[]> {
  const out: AbordajeTiempos[] = [];
  for (let i = 0; i < paradaIds.length; i += 200) {
    const sub = paradaIds.slice(i, i + 200);
    const filas = await todas(() => admin.from("pasajeros_parada").select("id, parada_id, hora_abordaje")
      .in("parada_id", sub).not("hora_abordaje", "is", null)
      .order("parada_id", { ascending: true }).order("id", { ascending: true }));
    for (const f of filas) out.push({ parada_id: f.parada_id, hora_abordaje: f.hora_abordaje });
  }
  return out;
}

/** Quién lee cada cosa. Por defecto, la base; la matriz (scripts/prueba-recorrido.mts) pasa lectores
 *  falsos para correr la cadena entera sin red. */
export type LectoresRecorrido = {
  traza?: LectorTraza;
  /** una sola lectura de rutas_cache con todas las claves; LANZA si falla */
  rutasCache?: (claves: string[]) => Promise<Map<string, any>>;
  /** LANZA si falla */
  abordajes?: (paradaIds: number[]) => Promise<AbordajeTiempos[]>;
  /** ¿la torre dejó esta reserva fuera de su techo diario (MAX_RESERVAS)? best-effort: false si falla */
  fueraDelTecho?: (r: { id: number; fecha_servicio?: string | null }) => Promise<boolean>;
};

/**
 * El recorrido de una reserva ya leída, con sus paradas (en el orden de `paradasDeReservas`: `orden`,
 * `id`, el mismo que /seguimiento le pasa al modal GPS). La traza que no se puede leer sale
 * `sin_medir`; rutas_cache o los abordajes que no se pueden leer salen declarados como tales.
 */
export async function armarRecorrido(
  r: FilaReservaDiag,
  ps: any[],
  o: { hoy: string; ahoraMs: number; umbral: number },
  lectores: LectoresRecorrido = {},
): Promise<RecorridoServicio> {
  const leerTraza = lectores.traza ?? trazaDe;
  const leerCache = lectores.rutasCache ?? ((claves: string[]) => leerRutasCache(claves));
  const leerAbordajes = lectores.abordajes ?? abordajesDe;
  const techo = lectores.fueraDelTecho ?? fueraDelTecho;

  // Un servicio cancelado no se mide (la torre ni lo consulta): no hay recorrido que dibujar.
  const cancelado = r.estado === "cancelada";
  // EL TECHO DIARIO DE LA CELDA: `rastreoDelDia` mide solo las primeras MAX_RESERVAS reservas de su día
  // y al resto le da `sin_medir`. Aquí igual que en el modal de diagnóstico: el veredicto es `sin_medir`
  // y NO hay medición (sinSenal vacío, conteos en null: «no se pudo medir», nunca 0). La traza y los
  // excesos se dibujan igual: no dependen de la cobertura.
  const fuera = !cancelado && await techo({ id: Number(r.id), fecha_servicio: r.fecha_servicio ?? null });
  const m = cancelado ? null : await medirServicio(r, ps, { hoy: o.hoy, ahoraMs: o.ahoraMs, conHuella: true }, leerTraza);
  const crudas = m?.traza && Array.isArray(m.traza.crudas) ? m.traza.crudas : null;
  const aplica = !cancelado && !!m?.ctx.aplica;

  // ── rutas_cache: la ruta prevista y los puentes, en UNA consulta ──
  // Los extremos, como /seguimiento se los pasa al modal: el nombre de la primera y de la última parada,
  // o el origen/destino de la reserva.
  const extremos = {
    origen: ps[0]?.nombre ?? r.origen ?? null,
    destino: (ps.length > 1 ? ps[ps.length - 1].nombre : null) ?? r.destino ?? null,
  };
  const claves = clavesRutaPrevista(ps, Array.isArray(r.paradas_json) ? r.paradas_json : null, extremos);
  const clavesP = aplica && crudas ? clavesPuentes(crudas) : [];
  const todasClaves = [...claves.variantes.map((v) => v.firma), ...clavesP];

  const [mapa, abordajes] = await Promise.all([
    todasClaves.length
      ? leerCache(todasClaves).catch((e: unknown) => {
        console.error("[recorrido] rutas_cache", e instanceof Error ? e.message : String(e));
        return null;
      })
      : Promise.resolve(new Map<string, any>()),
    aplica
      ? leerAbordajes(ps.map((p) => Number(p.id)).filter((n) => Number.isSafeInteger(n) && n > 0)).catch((e: unknown) => {
        console.error("[recorrido] pasajeros_parada", e instanceof Error ? e.message : String(e));
        return null;
      })
      : Promise.resolve(null),
  ]);

  const { estado, ruta } = resolverRutaPrevista(claves, mapa);
  let estadoRuta: EstadoRutaPrevista = estado;
  // La ruta se resuelve sin consulta (sin paraderos o sin coordenadas) pero los puentes sí se pidieron
  // y la consulta falló: se dice, para no dar a entender que no hay tramos estimados guardados.
  if (!mapa && clavesP.length && estado.codigo !== "no_se_pudo_leer") {
    estadoRuta = { ...estado, detalle: `${estado.detalle} Además, no se pudieron leer los tramos estimados guardados.` };
  }

  const hechos: HechosContexto | null = aplica
    ? hechosDelServicio({ reserva: r, paradas: ps, abordajes, ahoraMs: o.ahoraMs, cierreTs: m?.traza?.cierreTs ?? null })
    : null;

  return recorridoDeServicio({
    reservaId: Number(r.id),
    crudas,
    aplica,
    trazaLeida: !!m?.traza,
    rastreo: !m ? CANCELADO : fuera ? veredictoFueraDelTecho(o.ahoraMs) : m.veredicto,
    umbral: o.umbral,
    vehiculo: vehiculoDeReserva(r)?.clave ?? null,
    medicion: fuera ? null : m?.medicion ?? null,
    ptsCobertura: fuera ? null : m?.traza?.pts ?? null,
    ruta,
    estadoRuta,
    puentesGuardados: mapa,
    hechos,
  });
}

/**
 * El recorrido de la reserva `id` con el umbral ya validado. `reserva` se pasa si ya se leyó (la ruta
 * la lee primero para decidir el 404 y la ventana de días). null si la reserva no existe. LANZA si no
 * se pudo leer la reserva o sus paradas; la traza que no se puede leer sale `sin_medir`, no lanza.
 */
export async function recorridoDeReserva(
  id: number,
  o: { hoy: string; ahoraMs: number; umbral: number; reserva?: FilaReservaDiag | null },
): Promise<RecorridoServicio | null> {
  const r = o.reserva ?? await leerReservaDiag(id);
  if (!r) return null;
  const ps = (await paradasDeReservas([id])).get(id) ?? [];
  return armarRecorrido(r, ps, { hoy: o.hoy, ahoraMs: o.ahoraMs, umbral: o.umbral });
}
