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
// Helpers duplicados A PROPÓSITO (mismo bloque en ../parada/route.ts). Ver allí
// la nota: copia literal de app/api/conductor/route.ts:79 + aritmética de Lima.
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
 *  app/api/conductor/route.ts y al `FuenteTiempo` de lib/servicio-tiempos.ts:67: 'parada' =
 *  llegada al paradero marcada por el conductor; 'conductor_finalizo' = pulsó finalizar, que solo
 *  vale como hora de FIN. Es la cadena EXACTA que admite el CHECK del SQL. */
type FuenteHoraReal = "parada" | "conductor_finalizo";

/**
 * Sella UNA de las dos horas reales del servicio SOLO si estaba NULL (`.is(col, null)` →
 * la condición viaja en el UPDATE, así que nunca se sobrescribe una hora ya registrada:
 * ni la que tecleó el operador, ni la que dejó el marcado de la última parada).
 *
 * DOCTRINA (lib/avance-paradas.ts:30): "inferir para PINTAR es otra cosa que inferir para
 * ESCRIBIR". Solo entra evidencia DURA de un acto humano registrado. Ninguna hora estimada
 * por GPS llega hasta aquí.
 *
 * DEGRADA DE MÁS A MENOS COLUMNAS, y no solo cuando falta una columna: también cuando la BD
 * RECHAZA el valor de `fuente` por un CHECK (ver la nota gemela en ../parada/route.ts). Lo
 * importante es que la hora quede guardada; la procedencia es un extra.
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
  console.warn(`[conductor-tercero/finalizar] no se pudo sellar ${col}:`, ultimo?.message);
}

/** Puente dimensión A → dimensión B (lib/estados.ts): el servicio recién cerrado entra al embudo
 *  `por_liquidar`. Copia del helper de ../parada/route.ts y de app/api/conductor/route.ts — las
 *  tres vías de cierre tienen que dejar la MISMA huella o el tercerizado nunca llega a cobrarse. */
async function sembrarEstadoAdmin(supabase: any, reservaId: number) {
  const { error } = await supabase.from("reservas")
    .update({ estado_admin: ESTADO_ADMIN_INICIAL })
    .eq("id", reservaId).eq("estado", "finalizada").is("estado_admin", null);
  if (error && !esColumnaInexistente(error)) {
    console.warn(`[conductor-tercero/finalizar] estado_admin reserva ${reservaId}:`, error.message);
  }
}

export async function POST(req: NextRequest) {
  const { token, lat, lng } = await req.json() as { token: string; lat?: number; lng?: number };
  if (!token) return NextResponse.json({ error: "Token requerido" }, { status: 400 });

  const supabase = adminClient();

  const { data: reserva } = await supabase
    .from("reservas")
    .select("id, estado, vehiculo_id, vehiculo_tercero_id, conductor_id, conductor_tercero_id, token_expira_at")
    .eq("token_conductor_tercero", token)
    .single();

  if (!reserva) return NextResponse.json({ error: "Token inválido" }, { status: 404 });

  // Instante del CIERRE: el conductor acaba de pulsar finalizar. Se captura ANTES de escribir
  // nada para que el punto GPS 'finalizado', el estado y la hora real cuenten el mismo hecho.
  const cierreISO = new Date().toISOString();

  if (lat != null && lng != null) {
    await supabase.from("ubicaciones_gps").insert({
      vehiculo_id:          reserva.vehiculo_tercero_id != null ? null : (reserva.vehiculo_id ?? null),
      vehiculo_tercero_id:  reserva.vehiculo_tercero_id ?? null,
      conductor_id:         reserva.conductor_tercero_id != null ? null : (reserva.conductor_id ?? null),
      conductor_tercero_id: reserva.conductor_tercero_id ?? null,
      reserva_id: reserva.id,
      lat, lng, velocidad: 0, rumbo: 0, precision_m: 0,
      estado: "finalizado",
      created_at: cierreISO,
      fix_ts: cierreISO, // posición capturada AHORA = fix fresco (coherencia con el stream)
    });
  }

  // `.neq("estado", "cancelada")`: un servicio anulado en el ERP no se resucita desde el link.
  // El conductor puede tenerlo abierto desde antes de la cancelación —o dispararlo el
  // auto-finalizar por geocerco— y hasta ahora este UPDATE lo devolvía a "finalizada" sin
  // condición: la guarda de más abajo protegía las horas, pero la decisión de operación ya había
  // sido destruida una línea antes. `.select("estado")` además dice si de verdad cambió algo, y
  // de ahí sale el permiso para sellar el fin (la ruta de la app hace la misma comprobación).
  const { data: cerrada } = await supabase.from("reservas")
    .update({ estado: "finalizada" }).eq("id", reserva.id).neq("estado", "cancelada").select("estado");
  const quedoFinalizada = !!cerrada?.length;

  // Sellar el horario real del servicio. Hasta ahora esta ruta cerraba la reserva y nada más:
  // `reservas.hora_real_fin` estaba en 0 de 575 servicios en 30 días, así que la liquidación
  // imprimía la llegada en blanco y las alertas de solape asumían 4 h por defecto
  // (lib/alertas-flota.ts:40) sobre un servicio del que SÍ se sabía cuándo terminó.
  //
  // Todo best-effort: el cierre del servicio ya ocurrió y no puede fallar por esto.
  try {
    if (quedoFinalizada) {
      // Las paradas se leen ANTES de decidir ninguna hora. Antes se sellaba el fin con `cierreISO`
      // —el instante del CLIC— y solo DESPUÉS se leían las paradas, para el inicio: el mismo
      // servicio contaba dos historias distintas según por dónde se operara (por la app, la
      // llegada al último paradero; por el link, 10 h más tarde si el conductor cerró al volver a
      // cochera). Aquí se aplica la MISMA cascada que app/api/conductor/route.ts y que el motor
      // (lib/servicio-tiempos.ts:541 y :581), en orden de recorrido:
      //   INICIO = llegada a la PRIMERA parada marcada.
      //   FIN    = llegada a la ÚLTIMA parada marcada; y solo si no hay NINGUNA, el instante del
      //            cierre, que entonces sí es el único hecho registrado que existe.
      // `hora_llegada` es columna opcional → si no existe, se relee sin ella y el fin cae al
      // instante del cierre, que es lo único que queda.
      const leerParadas = (cols: string) =>
        supabase.from("paradas").select(cols).eq("reserva_id", reserva.id).order("orden");
      let { data: todas, error: eTodas } = await leerParadas("estado, hora_llegada, orden");
      if (eTodas && esColumnaInexistente(eTodas)) ({ data: todas, error: eTodas } = await leerParadas("estado, orden"));
      if (eTodas) throw new Error(eTodas.message);
      const conHora = ((todas ?? []) as any[]).filter((p) => p.estado === "completada" && p.hora_llegada);

      if (conHora.length) await sellarHoraReal(supabase, reserva.id, "inicio", conHora[0].hora_llegada, "parada");
      const fin: { iso: string; fuente: FuenteHoraReal } = conHora.length
        ? { iso: conHora[conHora.length - 1].hora_llegada, fuente: "parada" }
        : { iso: cierreISO, fuente: "conductor_finalizo" };
      await sellarHoraReal(supabase, reserva.id, "fin", fin.iso, fin.fuente);

      // El servicio cerró: que entre al embudo administrativo, igual que por la app.
      await sembrarEstadoAdmin(supabase, reserva.id);
    }
  } catch (e: any) { console.warn("[conductor-tercero/finalizar] no se pudo sellar el horario:", e?.message); }

  return NextResponse.json({ ok: true });
}
