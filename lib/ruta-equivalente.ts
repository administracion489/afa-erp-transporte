// lib/ruta-equivalente.ts
// ¿Qué servicios son "la misma ruta" que este? Fuente ÚNICA de esa definición.
//
// La necesitan dos pantallas que hasta ahora no se hablaban:
//   · el "Aplicar a rango de fechas" de Configurar ruta (components/programacion/ModalManifiesto.tsx),
//     que traía su propia `huellaRuta` local, y
//   · el renombrado en lote del nombre de ruta desde la torre de control
//     (app/seguimiento/page.tsx → components/seguimiento/ModalRutaMasiva.tsx).
// Si cada una decidiera por su cuenta qué es "la misma ruta", el mismo lote saldría distinto
// segun por donde entres — y el nombre de ruta lo LEE EL PASAJERO, asi que la incoherencia se
// ve fuera. Mantener AQUI.
//
// OJO: `lib/huella.ts` es otra cosa (la huella GPS del recorrido). Aqui "huella" es la firma
// de los PARADEROS de una ruta. Solo comparten el nombre.

import { supabase } from "@/lib/supabase";
import { paginarFilas } from "@/lib/huella";

export type ParadaHuella = { orden?: number | null; nombre?: string | null; lat?: number | null; lng?: number | null };

/**
 * Huella de ruta = secuencia ORDENADA de paraderos "nombre@lat,lng".
 * Es sensible al orden ⇒ una ruta en sentido inverso produce una huella distinta.
 * Sirve para decidir si dos servicios recorren exactamente el mismo camino.
 */
export function huellaRuta(lista: ParadaHuella[] | undefined | null): string {
  if (!lista || lista.length === 0) return "";
  return [...lista]
    .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0))
    .map((p) => {
      const nom = (p.nombre || "").trim().toLowerCase().replace(/\s+/g, " ");
      const lat = p.lat == null ? "" : Number(p.lat).toFixed(4);
      const lng = p.lng == null ? "" : Number(p.lng).toFixed(4);
      return `${nom}@${lat},${lng}`;
    })
    .join(" › ");
}

/** Un paradero tal como viaja dentro de `paradas_json` (snapshot, no la tabla `paradas`). */
export type ParadaJson = ParadaHuella & { tipo?: string | null };

/** Ordena un `paradas_json` como lo hace resolverParadasJSON: inicio → intermedia → destino. */
export function ordenarTramo<T extends { tipo?: string | null }>(arr: T[]): T[] {
  return [
    ...arr.filter((p) => p.tipo === "inicio"),
    ...arr.filter((p) => p.tipo === "intermedia"),
    ...arr.filter((p) => p.tipo === "destino"),
    ...arr.filter((p) => !["inicio", "intermedia", "destino"].includes(String(p.tipo))),
  ];
}

/**
 * Los dos ejes por los que un operador reconoce "los demas dias de esta misma ruta":
 *
 *  · `ruta`   — mismos paraderos, mismo orden, mismo sentido, dentro de la MISMA cotizacion.
 *               Es el criterio del manifiesto: preciso, y el unico que sirve cuando el
 *               servicio todavia NO tiene nombre (que es justo cuando hay que ponerselo).
 *  · `nombre` — los que HOY se llaman exactamente igual. Es el criterio que al manifiesto le
 *               falta: alli el boton ni siquiera aparece si el servicio no cuelga de una
 *               cotizacion, asi que renombrar una ruta ya bautizada era imposible en lote.
 */
export type CriterioEquivalencia = "ruta" | "nombre";

export type ServicioEquivalente = {
  id: number;
  fecha_servicio: string | null;
  hora_servicio: string | null;
  ruta_nombre: string | null;
  cliente_id: number | null;
  vehiculo_id: number | null;
  vehiculo_tercero_id: number | null;
  estado: string | null;
};

/** Lo MINIMO que hace falta para emparejar por recorrido: el sentido y el snapshot de
 *  paraderos. Lo cumplen tanto las filas de PostgREST como la propia referencia, que llega
 *  con menos campos (no necesita fecha ni cliente para compararse). */
type FuenteRuta = { direccion_servicio?: string | null; paradas_json?: unknown };

/** Fila cruda tal como vuelve de PostgREST: lo de `ServicioEquivalente` + lo de emparejar. */
type FilaRuta = ServicioEquivalente & FuenteRuta;

export type ResultadoEquivalentes = {
  servicios: ServicioEquivalente[];
  /** Cerrados (finalizada/cancelada) que calzaban pero NO se ofrecen. Ver `cerrado()`. */
  cerrados: number;
  /** Por que no se pudo buscar, si `servicios` viene vacio por imposibilidad y no por falta de coincidencias. */
  imposible?: string;
};

const COLUMNAS =
  "id,fecha_servicio,hora_servicio,ruta_nombre,cliente_id,vehiculo_id,vehiculo_tercero_id,estado,direccion_servicio,paradas_json";

/**
 * Un servicio CERRADO no entra al lote aunque calce.
 *
 * No es pudor: `ruta_nombre` no es un rotulo suelto. La liquidacion lo PARSEA para sacar la
 * etiqueta de ruta, el turno y el sentido (lib/liquidacion-agrupacion.ts), y de un servicio
 * finalizado ese texto ya viajo al papel que firmo el cliente. Reescribirlo hacia atras
 * cambiaria un documento emitido. El manifiesto ya excluia estos dos estados; aqui ademas se
 * CUENTAN y se dicen, que es lo que faltaba: antes desaparecian sin explicacion.
 */
function cerrado(estado: string | null | undefined): boolean {
  const e = String(estado || "").toLowerCase();
  return e === "cancelada" || e === "finalizada";
}

/** Normaliza para comparar nombres de ruta: sin extremos, sin dobles espacios, sin may/min. */
export function normalizarNombre(s: string | null | undefined): string {
  return (s || "").trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * Devuelve los servicios equivalentes al de referencia dentro de un rango de fechas.
 *
 * Se PAGINA siempre: PostgREST recorta cualquier respuesta al max-rows del servidor
 * (Supabase: 1000) aunque pidas mas, y una programacion masiva de temporada pasa de mil
 * servicios sin despeinarse — sin paginar, el lote silenciosamente dejaria fuera la cola.
 */
export async function buscarEquivalentes(opts: {
  criterio: CriterioEquivalencia;
  referencia: {
    id: number;
    cotizacion_id?: number | null;
    direccion_servicio?: string | null;
    paradas_json?: unknown;
    ruta_nombre?: string | null;
  };
  desde: string;
  hasta: string;
}): Promise<ResultadoEquivalentes> {
  const { criterio, referencia, desde, hasta } = opts;
  if (!desde || !hasta) return { servicios: [], cerrados: 0, imposible: "Falta el rango de fechas." };

  if (criterio === "nombre") {
    const nombre = normalizarNombre(referencia.ruta_nombre);
    if (!nombre) {
      return {
        servicios: [], cerrados: 0,
        imposible: "Este servicio todavia no tiene nombre de ruta, asi que no hay por donde reconocer a sus hermanos. Usa «la misma ruta».",
      };
    }
    // `ilike` sin comodines = igualdad sin distinguir mayusculas. Los nombres se escriben a
    // mano en dos sitios (aqui y el manifiesto) y un "Ruta B" contra un "RUTA B" es el mismo
    // servicio para cualquiera que lo mire.
    const filas = await paginarFilas(() =>
      supabase.from("reservas").select(COLUMNAS)
        .ilike("ruta_nombre", nombre)
        .gte("fecha_servicio", desde).lte("fecha_servicio", hasta)
        .order("fecha_servicio").order("hora_servicio").order("id"),
    );
    return partir(filas as ServicioEquivalente[]);
  }

  // criterio === "ruta"
  if (!referencia.cotizacion_id) {
    return {
      servicios: [], cerrados: 0,
      imposible: "Este servicio no cuelga de una cotizacion, asi que no hay con que emparejarlo por recorrido. Si ya tiene nombre, usa «los que hoy se llaman igual».",
    };
  }

  const filas = await paginarFilas(() =>
    supabase.from("reservas").select(COLUMNAS)
      .eq("cotizacion_id", referencia.cotizacion_id)
      .gte("fecha_servicio", desde).lte("fecha_servicio", hasta)
      .order("fecha_servicio").order("hora_servicio").order("id"),
  );

  // Fuente de la huella: el snapshot `paradas_json` de cada reserva, con respaldo en la
  // cotizacion por tramo. NO la tabla `paradas`: la programacion masiva inserta cientos de
  // reservas con paradas_json pero SIN materializar filas en `paradas` hasta que cada
  // servicio se abre, y comparar por `paradas` dejaba fuera justo a esos (huella vacia).
  const { data } = await supabase.from("cotizaciones")
    .select("paradas_json,paradas_retorno_json").eq("id", referencia.cotizacion_id).maybeSingle();
  const cot = (data || null) as { paradas_json?: unknown; paradas_retorno_json?: unknown } | null;

  const fuente = (r: FuenteRuta | null | undefined): ParadaJson[] => {
    if (Array.isArray(r?.paradas_json) && r.paradas_json.length > 0) return ordenarTramo(r.paradas_json as ParadaJson[]);
    if (r?.direccion_servicio === "retorno") {
      const ret = Array.isArray(cot?.paradas_retorno_json) && cot.paradas_retorno_json.length > 0
        ? cot.paradas_retorno_json : cot?.paradas_json;
      return Array.isArray(ret) ? ordenarTramo(ret as ParadaJson[]) : [];
    }
    return Array.isArray(cot?.paradas_json) ? ordenarTramo(cot.paradas_json as ParadaJson[]) : [];
  };

  // El RETORNO de una cotizacion sin `paradas_retorno_json` propio se guarda con el MISMO
  // paradas_json de la ida (mismos paraderos, sin invertir): su huella coincidiria con la de
  // la ida. Exigir el mismo tramo evita ponerle a los retornos el nombre de la ida.
  const tramo = (r: FuenteRuta | null | undefined): string => (r?.direccion_servicio === "retorno" ? "retorno" : "ida");
  const tramoRef = tramo(referencia);
  const huellaRef = huellaRuta(fuente(referencia));

  const mismos = (filas as FilaRuta[]).filter((r) => {
    if (tramo(r) !== tramoRef) return false;
    if (r.id === referencia.id) return true;              // la referencia siempre calza consigo misma
    if (huellaRef === "") return false;                   // sin huella no se afirma parecido: mejor nada que de mas
    return huellaRuta(fuente(r)) === huellaRef;
  });

  if (huellaRef === "" && mismos.length <= 1) {
    return {
      servicios: [], cerrados: 0,
      imposible: "No se pudo leer el recorrido de este servicio (no tiene paraderos guardados). Si ya tiene nombre, usa «los que hoy se llaman igual».",
    };
  }
  return partir(mismos as unknown as ServicioEquivalente[]);
}

/** Separa lo aplicable de lo cerrado, conservando el conteo de lo que se deja fuera. */
function partir(filas: ServicioEquivalente[]): ResultadoEquivalentes {
  const servicios: ServicioEquivalente[] = [];
  let cerrados = 0;
  for (const f of filas) { if (cerrado(f.estado)) cerrados++; else servicios.push(f); }
  return { servicios, cerrados };
}

/**
 * Escribe el nombre en lote. Devuelve los valores ANTERIORES para poder deshacer —
 * lo que al manifiesto le falta: alli, una vez aplicado a "este servicio en adelante",
 * no hay vuelta atras salvo repetir la operacion a mano con el nombre viejo (que ya nadie
 * recuerda, porque acaba de sobrescribirse en cientos de filas).
 *
 * Va por lotes: un `.in()` con miles de ids desborda la URL y PostgREST responde 400.
 */
const LOTE_IDS = 80;

export async function aplicarNombreEnLote(
  ids: number[],
  nombre: string | null,
): Promise<{ ok: number; error?: string }> {
  let ok = 0;
  for (let i = 0; i < ids.length; i += LOTE_IDS) {
    const lote = ids.slice(i, i + LOTE_IDS);
    if (!lote.length) continue;
    const { error } = await supabase.from("reservas").update({ ruta_nombre: nombre }).in("id", lote);
    // Se corta al primer fallo y se informa cuantos SI entraron: dejar creer que se
    // aplicaron 300 cuando entraron 80 es peor que el propio fallo.
    if (error) return { ok, error: error.message };
    ok += lote.length;
  }
  return { ok };
}

/** Restaura valor por valor (cada servicio tenia el suyo, no hay un "nombre anterior" comun). */
export async function deshacerNombres(previos: Array<{ id: number; ruta_nombre: string | null }>): Promise<{ ok: number; error?: string }> {
  let ok = 0;
  // Se agrupan por valor para no hacer un UPDATE por fila: los lotes de temporada comparten
  // el mismo nombre anterior (o el mismo vacio), asi que suelen colapsar a uno o dos grupos.
  const porValor = new Map<string, number[]>();
  for (const p of previos) {
    const clave = p.ruta_nombre ?? " null";
    const arr = porValor.get(clave);
    if (arr) arr.push(p.id); else porValor.set(clave, [p.id]);
  }
  for (const [clave, ids] of porValor) {
    const valor = clave === " null" ? null : clave;
    const r = await aplicarNombreEnLote(ids, valor);
    ok += r.ok;
    if (r.error) return { ok, error: r.error };
  }
  return { ok };
}
