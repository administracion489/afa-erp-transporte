import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { ESTADO_ADMIN_INICIAL } from "@/lib/estados";

const adminClient = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

// ─────────────────────────────────────────────────────────────────────────────
// Helpers duplicados A PROPÓSITO (mismo bloque en ../finalizar/route.ts).
// Son copia literal de app/api/conductor/route.ts:79 y de la aritmética de Lima
// que ya se repite en lib/radar/acciones.ts:42 y lib/push.ts:402. No se extraen a
// un módulo común porque estas dos rutas se tocaron en una sesión con el repo
// vivo; unificarlas es un cambio mecánico cuando alguien pase por aquí.
// ─────────────────────────────────────────────────────────────────────────────

// ¿El error de Supabase/PostgREST es por una columna que NO existe en la tabla?
// PGRST204 = no está en el schema cache; 42703 = undefined_column. Se usa para que los
// reintentos de fallback NO confundan un error real de FK/constraint (que puede mencionar
// el nombre de la columna) con "columna ausente".
function esColumnaInexistente(err: any): boolean {
  if (!err) return false;
  if (err.code === "PGRST204" || err.code === "42703") return true;
  return /could not find the .* column|column .* does not exist/i.test(err.message || "");
}

/** ISO (instante absoluto) → "HH:MM:SS" en hora de LIMA (UTC-5, sin DST). null si no parsea.
 *  `reservas.hora_real_inicio/fin` son horas DEL DÍA sin fecha, ancladas a `fecha_servicio`
 *  (lib/servicio-tiempos.ts:67); el instante absoluto va aparte, en `*_real_ts`. */
function horaLimaDeIso(iso?: string | null): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  return new Date(t - 5 * 3600 * 1000).toISOString().slice(11, 19);
}

/** De qué acto salió la hora que se sella. Vocabulario CANÓNICO, idéntico al de
 *  app/api/conductor/route.ts, al `FuenteTiempo` de lib/servicio-tiempos.ts:67 y a los CHECK de
 *  supabase/servicio-horas-reales.sql: 'parada' = llegada al paradero marcada por el conductor;
 *  'conductor_finalizo' = pulsó finalizar (solo vale como hora de FIN). La cadena tiene que
 *  coincidir EXACTAMENTE con el CHECK o el UPDATE muere con 23514. */
type FuenteHoraReal = "parada" | "conductor_finalizo";

/**
 * Sella UNA de las dos horas reales del servicio SOLO si estaba NULL (`.is(col, null)` →
 * la condición viaja en el UPDATE, así que dos peticiones a la vez no se pisan y nunca se
 * sobrescribe una hora ya registrada, ni la del operador ni la de la otra vía).
 *
 * DOCTRINA (lib/avance-paradas.ts:30): "inferir para PINTAR es otra cosa que inferir para
 * ESCRIBIR". Aquí solo entra evidencia DURA de un acto humano registrado — el conductor
 * marcó la parada, el conductor pulsó finalizar. Ninguna hora estimada por GPS llega hasta
 * esta función.
 *
 * DEGRADA DE MÁS A MENOS COLUMNAS, y no solo cuando falta una columna: también cuando la BD
 * RECHAZA el valor de `fuente` por un CHECK. Es el mismo cascade de app/api/conductor/route.ts,
 * y existe porque el CHECK de supabase/servicio-horas-reales.sql y este vocabulario pueden ir
 * desacompasados: sin la degradación, el día que alguien corriera el SQL con una lista de
 * valores vieja, esta ruta dejaría de sellar la hora en silencio. Lo importante es que la hora
 * quede guardada; la procedencia es un extra. Best-effort de punta a punta: un fallo aquí se
 * loguea y jamás tumba la operación que lo llamó.
 */
async function sellarHoraReal(
  supabase: any,
  reservaId: number,
  extremo: "inicio" | "fin",
  iso: string,
  fuente: FuenteHoraReal,
) {
  const hhmmss = horaLimaDeIso(iso);
  if (!hhmmss) return;
  const col      = extremo === "inicio" ? "hora_real_inicio"   : "hora_real_fin";
  const colTs    = extremo === "inicio" ? "inicio_real_ts"     : "fin_real_ts";
  const colFuente= extremo === "inicio" ? "inicio_real_fuente" : "fin_real_fuente";
  // `checkin_realizado`: si el conductor marcó una parada, el servicio arrancó. Misma huella
  // que deja la app (app/api/conductor/route.ts), para que las dos vías no se distingan.
  const base: Record<string, any> = extremo === "inicio"
    ? { [col]: hhmmss, checkin_realizado: true }
    : { [col]: hhmmss };
  const intentos: Record<string, any>[] = [];
  const proponer = (p: Record<string, any>) => {
    const firma = Object.keys(p).sort().join(",");
    if (!intentos.some((q) => Object.keys(q).sort().join(",") === firma)) intentos.push(p);
  };
  proponer({ ...base, [colTs]: iso, [colFuente]: fuente });
  proponer(base);
  proponer({ [col]: hhmmss });

  let ultimo: any = null;
  for (const payload of intentos) {
    const { error } = await supabase.from("reservas").update(payload).eq("id", reservaId).is(col, null);
    if (!error) return;
    ultimo = error;
  }
  console.warn(`[conductor-tercero/parada] no se pudo sellar ${col}:`, ultimo?.message);
}

/**
 * Puente dimensión A → dimensión B (lib/estados.ts): el servicio que acaba de cerrarse entra al
 * embudo `por_liquidar`. Mismo helper que app/api/conductor/route.ts — hasta ahora SOLO lo
 * sembraba la ruta de la app, así que un servicio tercerizado cerrado por el link quedaba
 * operativamente terminado y administrativamente invisible: nunca entraba a liquidación. Y los
 * tercerizados son la mayor parte de la operación.
 * Solo si el servicio quedó `finalizada` y `estado_admin` estaba NULL; silencioso si la columna
 * todavía no existe (supabase/estado-admin.sql sin correr).
 */
async function sembrarEstadoAdmin(supabase: any, reservaId: number) {
  const { error } = await supabase.from("reservas")
    .update({ estado_admin: ESTADO_ADMIN_INICIAL })
    .eq("id", reservaId).eq("estado", "finalizada").is("estado_admin", null);
  if (error && !esColumnaInexistente(error)) {
    console.warn(`[conductor-tercero/parada] estado_admin reserva ${reservaId}:`, error.message);
  }
}

export async function POST(req: NextRequest) {
  const { token, paradaId } = await req.json() as { token: string; paradaId: number };
  if (!token || !paradaId) return NextResponse.json({ error: "Faltan datos" }, { status: 400 });

  const supabase = adminClient();

  const { data: reserva } = await supabase
    .from("reservas")
    .select("id, estado, token_expira_at")
    .eq("token_conductor_tercero", token)
    .single();

  if (!reserva) return NextResponse.json({ error: "Token inválido" }, { status: 404 });

  // Verificar que la parada pertenece a esta reserva
  const { data: parada } = await supabase
    .from("paradas")
    .select("id")
    .eq("id", paradaId)
    .eq("reserva_id", reserva.id)
    .single();

  if (!parada) return NextResponse.json({ error: "Parada no pertenece a esta reserva" }, { status: 403 });

  // `hora_llegada`: hora REAL de arribo al paradero. Hasta ahora esta ruta escribía SOLO
  // `estado`, así que todo servicio operado por link quedaba sin ninguna hora por paradero y
  // su línea de tiempo salía vacía (lib/servicio-tiempos.ts vive de esta columna: 90 % de las
  // paradas completadas la tienen... las que pasaron por la app). La columna es opcional
  // (SQL paradas-hora-llegada.sql); si el build de la BD aún no la tiene, se reintenta sin ella
  // para no romper el marcado — mismo patrón que app/api/conductor/route.ts:459-463.
  //
  // REGLA DE LA COLUMNA: GANA LA LLEGADA MÁS TEMPRANA YA REGISTRADA (misma que en la app,
  // app/api/conductor/route.ts). Sin guarda, cada reenvío de la misma parada —un toque doble,
  // un reintento por mala señal— la pisaba con un instante más tardío; y esto es evidencia
  // humana ya registrada, de la que vive la línea de tiempo y ahora también la hora que se
  // persiste en la reserva. Aquí el instante siempre es `now()`, así que en la práctica la regla
  // dice: manda el primer marcado, los reenvíos no lo mueven.
  const llegadaISO = new Date().toISOString();
  const marcado = await supabase.from("paradas")
    .update({ estado: "completada", hora_llegada: llegadaISO }, { count: "exact" })
    .eq("id", paradaId)
    .or(`hora_llegada.is.null,hora_llegada.gt."${llegadaISO}"`);
  let eParada = marcado.error;
  if (eParada && esColumnaInexistente(eParada)) {
    ({ error: eParada } = await supabase.from("paradas").update({ estado: "completada" }).eq("id", paradaId));
  } else if (!eParada && !marcado.count) {
    // La guarda rechazó la hora (ya había una anterior): se conserva y se asegura solo el estado.
    ({ error: eParada } = await supabase.from("paradas").update({ estado: "completada" }).eq("id", paradaId));
  }

  // Cerrar el servicio AQUÍ MISMO si ya no quedan paradas pendientes, en vez de depender de
  // que el conductor pulse "Finalizar" (POST /conductor-tercero/finalizar) por separado. Ese
  // segundo paso es una acción aparte del conductor: si no la hace —red caída, cerró el link,
  // se le acabó la batería justo al llegar— la reserva queda "en_curso" con todas las paradas
  // completadas, a veces indefinidamente. Ver el mismo patrón en app/api/conductor/route.ts
  // (marcar_parada), caso real: reserva 11165.
  //
  // Y de paso se SELLA el horario real del servicio con la evidencia que acaba de dejar el
  // conductor: sin esto, `reservas.hora_real_fin` seguía en 0 de 575 servicios y la liquidación
  // imprimía la llegada en blanco. Todo el bloque es best-effort: la parada ya quedó marcada.
  try {
    // El select pide `hora_llegada`, que es opcional → mismo reintento que arriba, o el bloque
    // entero se caería en una BD sin la migración y volveríamos a no cerrar el servicio.
    const leerParadas = (cols: string) =>
      supabase.from("paradas").select(cols).eq("reserva_id", reserva.id).order("orden");
    let { data: todas, error: eTodas } = await leerParadas("estado, hora_llegada");
    if (eTodas && esColumnaInexistente(eTodas)) ({ data: todas, error: eTodas } = await leerParadas("estado"));
    if (eTodas) throw new Error(eTodas.message);

    const lista = (todas ?? []) as any[];
    // Paradas completadas CON hora, en orden de recorrido. Misma regla que la cascada de
    // lib/servicio-tiempos.ts:541 y :581 → la primera es el arranque, la última es la llegada
    // que factura. Así la hora que se PERSISTE es exactamente la que el motor ya DERIVA.
    const conHora = lista.filter((p) => p.estado === "completada" && p.hora_llegada);
    const completas = lista.length > 0 && lista.every((p) => p.estado === "completada");

    // ¿El servicio quedó REALMENTE cerrado? El UPDATE lleva `.eq("estado", "en_curso")` y puede
    // afectar 0 filas (el conductor nunca pulsó iniciar, o el estado se movió por otra vía). La
    // ruta de la app comprueba esto antes de sellar el fin; aquí no se comprobaba y quedaba una
    // fila incoherente: hora de fin en un servicio que seguía "programada" — justo lo que el
    // commit 8fca81a existía para evitar. `.select("estado")` devuelve las filas que cambiaron,
    // así que no hace falta una consulta más en el camino feliz.
    let estadoAhora = String(reserva.estado ?? "");
    if (completas) {
      const { data: upd } = await supabase.from("reservas").update({ estado: "finalizada" })
        .eq("id", reserva.id).eq("estado", "en_curso").select("estado"); // no pisar un estado distinto
      if (upd?.length) estadoAhora = "finalizada";
      else {
        const { data: rNow } = await supabase.from("reservas").select("estado").eq("id", reserva.id).maybeSingle();
        estadoAhora = String(rNow?.estado ?? estadoAhora);
      }
    }

    // Un servicio cancelado no tiene horario que sellar (lib/servicio-tiempos.ts:533 lo
    // descarta igual); marcar una parada sobre él no puede resucitarle horas.
    if (estadoAhora !== "cancelada" && conHora.length) {
      await sellarHoraReal(supabase, reserva.id, "inicio", conHora[0].hora_llegada, "parada");
      // El fin solo cuando el recorrido está COMPLETO **y** el servicio quedó finalizado: la
      // llegada al último paradero es la que va a la liquidación, y mientras queden paradas
      // pendientes no sabemos cuál es.
      if (completas && estadoAhora === "finalizada") {
        await sellarHoraReal(supabase, reserva.id, "fin", conHora[conHora.length - 1].hora_llegada, "parada");
      }
    }
    if (estadoAhora === "finalizada") await sembrarEstadoAdmin(supabase, reserva.id);
  } catch (e: any) { console.warn("[conductor-tercero/parada] no se pudo auto-cerrar:", e?.message); }

  // El error del marcado se reporta DESPUÉS del bloque de arriba, a propósito. Antes de este
  // cambio la ruta se tragaba el fallo y devolvía {ok:true}; devolver 500 es más honesto (el
  // servidor no marcó nada) y es lo que ya hace la ruta de la app, pero un `return` temprano
  // se llevaba por delante el auto-cierre y el sellado, que son independientes de que ESTA
  // parada se haya podido escribir. Nota de contrato: el cliente
  // (app/conductor-tercero/[token]/page.tsx) no mira `res.ok` y marca la parada localmente
  // igual, así que el 500 hoy solo sirve para los logs — no bloquea al conductor en la calle.
  if (eParada) return NextResponse.json({ error: eParada.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
