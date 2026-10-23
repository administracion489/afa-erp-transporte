// app/api/alertas-flota/tick/route.ts
// Motor único de alertas operativas. Corre cada ~10 min (cron Vercel o pinger externo).
// Lee alerta_config (editable) y ejecuta cada bloque según su modo/umbral/destinatarios.
//
// PRINCIPIO ANTI-PÉRDIDA: el estado/dedupe SOLO avanza cuando el envío tuvo éxito. Un
// fallo transitorio de Meta NO marca la alerta como enviada → el próximo tick reintenta.
// Dedupe: reclamarEnvio (insert-once en alerta_enviada, con liberarEnvio de rollback) para
// recordatorios/no_inicio/docs/solape/jornada; avisos_conductor_estado (diff por reserva)
// para asignación/cambio/cancelación y el re-armado de "GPS sin señal".
//
// Auth: Bearer CRON_SECRET (fail-closed). ?force=1 ignora las ventanas horarias (pruebas).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  enviarAvisoWhatsApp, enviarAConductor, notificarReserva, notificarConductor,
  notificarConductorAsignacionAgrupada,
} from "@/lib/notificaciones";
import {
  cargarMotor, directorioDe, reclamarEnvio, liberarEnvio, cargarEstados, upsertEstado,
  hoyLima, ahoraLimaMin, hhmmAMin, telefonoContingencia, canalesConductor, type AlertaConfig,
} from "@/lib/alertas";
import { horarioDe, limaAUtcMs, minutosAHhmm, planDeEnvioConductor } from "@/lib/alertas-horario";
import { planRecordarCheckout, cadenciaEfectiva, escalaAlDirectorio, detalleEscaladaCheckout, type AlcanceRecordatorio, type LecturaCheckout } from "@/lib/alertas-checkout";
import { tsEfectivoLectura } from "@/lib/odometro-tiempo";
import {
  ANTICIPACION_DEFECTO_MIN,
  enViaRecordatorio as enViaRecordatorioPuro,
  enVentanaHoraFija as enVentanaHoraFijaPuro,
} from "@/lib/alertas-modo-tiempo";
import { detectarSolapesJornada, itinerarioDe, type ReservaFlota } from "@/lib/alertas-flota";
import { UMBRAL_DEFECTO } from "@/lib/alertas-tarjeta";
import { vencimientoFichaOPoliza } from "@/lib/seguros";
import { fechaLima } from "@/lib/documentos-estado";
import { leerPolizasPersonas } from "@/lib/seguros-datos";
import { CLAVE_ESPERA_ABANDONADO, paramsAvisoAbandonados, planDePendientes, type ServicioCerrado } from "@/lib/servicio-abandonado";
import { veredictosDelDia, guardarVeredictos, type VeredictoCtx } from "@/lib/retrasos-datos";
import { detalleAlertaPrevia, listaEnUnaLinea, noInicioRepiteDebio, textoPushInicio, type TextoPush } from "@/lib/escalera-inicio";
import { resumenAvisosDeReserva } from "@/lib/escalera-inicio-datos";
import {
  CLAVE_DEVOLUCION, CLAVE_SIN_CONFIRMAR, fechaReclamo, juzgarDevolucion, juzgarSinConfirmar, juzgarVencimiento,
  notaConCierre, notaVencida, paramsDevolucion, paramsSinConfirmar,
} from "@/lib/traslados/reserva-alertas";
import { cerrarSolicitudVencida, leerHechosAlertasReserva } from "@/lib/traslados/reserva-alertas-datos";
import { sincronizarCargosDeCancelaciones } from "@/lib/traslados/reserva-solicitud-datos";
import { normalizarConfigReserva } from "@/lib/traslados/reserva-pago";
import { plazosDe } from "@/lib/traslados/reserva-orden";

export const maxDuration = 60;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// La ventana del modo hora_fija (generosa a propósito: tolera ticks caídos sin perder el
// día) vive ahora en `lib/alertas-modo-tiempo.ts` como `VENTANA_HORA_FIJA_MIN`, junto a los
// dos predicados que la usan y a la tabla que la pantalla necesita para poder avisar.

const DIA_MS = 86_400_000;
// Techo de duración. 26 h y no 12: hay tours full day de hasta 24 h — mismo techo que
// lib/gps-huella-servicio.ts (DURACION_MAX_MS) y lib/servicio-tiempos.ts:308.
const DURACION_MAX_MS = 26 * 3_600_000;

type ResultadoEnvio = "enviado" | "sin_canal" | "fallo";

function fechaManana(): string {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 5);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}
function rutaDe(r: { origen?: string | null; destino?: string | null }): string {
  return [r.origen, r.destino].filter(Boolean).join(" → ") || "Servicio";
}
function nombreCorto(n?: string | null): string {
  return (n || "").trim().split(/\s+/).slice(0, 2).join(" ") || "Conductor";
}
function horaCorta(h?: string | null): string { return h?.slice(0, 5) ?? "-"; }

/**
 * Instante de fin de un servicio en ms UTC, anclando la hora a `fecha_servicio`.
 *
 * `reservas.hora_real_fin` es "HH:MM:SS" DEL DÍA, SIN fecha: componerla a pelo con
 * `fecha_servicio` deja un nocturno (sale 22:00, cierra 01:30) 20,5 h ANTES de su propia salida.
 * Un fin anterior al inicio se lee como cruce de medianoche (+24 h) y se acepta solo si la
 * duración cabe en el techo de 26 h; si no cabe, se cae a la hora pactada — que es lo que este
 * bloque usaba cuando la columna estaba vacía. Mismo criterio que lib/servicio-tiempos.ts:765 y
 * lib/alertas-flota.ts (`duracionMin`).
 */
function finServicioMs(r: {
  fecha_servicio?: string | null; hora_servicio?: string | null; hora_real_fin?: string | null;
}): number | null {
  const ini = limaAUtcMs(r.fecha_servicio, horaCorta(r.hora_servicio));
  const fin = limaAUtcMs(r.fecha_servicio, horaCorta(r.hora_real_fin));
  if (fin == null) return ini;
  if (ini == null) return fin;
  const corregido = fin < ini ? fin + DIA_MS : fin;
  return corregido - ini <= DURACION_MAX_MS ? corregido : ini;
}

/**
 * Lo que la jornada y el solape necesitan de cada servicio y `todas` no trae: la salida real
 * (`hora_real_inicio`, la sellan los endpoints del conductor) y el itinerario —hora y lugar del
 * primer y del último paradero— de las filas de `paradas` o, si aún no se materializaron, de la
 * semilla `paradas_json` (`itinerarioDe`, el mismo que usa la torre). null si ALGUNA lectura
 * falla: medir la mitad de los servicios con 4 h estimadas sería volver a alarmar por falta de datos.
 */
type Itinerario = Pick<ReservaFlota, "hora_real_inicio" | "plan_inicio" | "plan_fin" | "plan_origen" | "plan_destino">;
async function itinerariosDeHoy(ids: number[]): Promise<Map<number, Itinerario> | null> {
  const out = new Map<number, Itinerario>();
  if (!ids.length) return out;
  const { data: rs, error: eR } = await admin
    .from("reservas").select("id, hora_real_inicio, paradas_json").in("id", ids);
  if (eR) { console.error("[tick] jornada: reservas", eR.message); return null; }
  // Paradas paginadas con orden TOTAL: cortar una página a mitad de un servicio movería su último
  // paradero y con él la duración.
  const filas: { reserva_id: number; orden: number | null; hora_estimada: string | null; lat: number | null; lng: number | null }[] = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await admin
      .from("paradas").select("reserva_id, orden, hora_estimada, lat, lng").in("reserva_id", ids)
      .order("reserva_id").order("orden").order("id").range(desde, desde + 999);
    if (error) { console.error("[tick] jornada: paradas", error.message); return null; }
    filas.push(...((data ?? []) as typeof filas));
    if (!data || data.length < 1000) break;
  }
  const porReserva = new Map<number, typeof filas>();
  for (const f of filas) {
    const l = porReserva.get(f.reserva_id) ?? [];
    l.push(f); porReserva.set(f.reserva_id, l);
  }
  for (const r of (rs ?? []) as { id: number; hora_real_inicio: string | null; paradas_json: unknown }[]) {
    const it = itinerarioDe(porReserva.get(r.id), r.paradas_json);
    out.set(r.id, {
      hora_real_inicio: r.hora_real_inicio, plan_inicio: it.inicio, plan_fin: it.fin,
      plan_origen: it.origen, plan_destino: it.destino,
    });
  }
  return out;
}

export async function GET(req: NextRequest) { return handler(req); }
export async function POST(req: NextRequest) { return handler(req); }

async function handler(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";

  try {
    const { configs, destinatarios } = await cargarMotor();
    const activa = (clave: string): AlertaConfig | null => {
      const c = configs.get(clave);
      return c && c.activo ? c : null;
    };

    const hoy = hoyLima();
    const manana = fechaManana();
    const ahora = ahoraLimaMin();
    // Un solo instante para todo el tick: el horario de envío y el resto de los bloques
    // tienen que juzgar contra el mismo reloj, no contra el que cada uno lea al pasar.
    const ahoraMs = Date.now();
    const telConting = await telefonoContingencia();
    const res: Record<string, number> = {};

    const { data: reservas } = await admin
      .from("reservas")
      .select("id, fecha_servicio, hora_servicio, hora_real_fin, estado, conductor_id, conductor_tercero_id, vehiculo_id, vehiculo_tercero_id, empresa_tercerizada_id, tipo_asignacion, origen, destino")
      .in("fecha_servicio", [hoy, manana]);
    const todas = (reservas ?? []) as any[];

    // Estados de ciclo de vida (para el diff + para saber el conductor SALIENTE al reasignar).
    const propias = todas.filter((r) => r.tipo_asignacion === "propio");
    // El ciclo de vida (asignación/cambio/cancelación) cubre AMBAS flotas: la propia y
    // la tercerizada. Incluir las tercerizadas aunque el aviso esté apagado es
    // deliberado — así se graba su baseline y, el día que se encienda, NO se dispara
    // una avalancha de "servicio asignado" por reservas viejas.
    const cicloVida = todas.filter((r) => r.conductor_id || r.conductor_tercero_id);
    const estados = await cargarEstados(cicloVida.map((r) => r.id));

    // Mapa de conductores: los de las reservas actuales + los "avisados" previos (salientes).
    // Se cargan los conductores de las reservas actuales + los "avisados" previos (los
    // SALIENTES de una reasignación). Cada id se manda a su tabla: los ids de
    // `conductores` y `conductores_tercero` SE SOLAPAN (el 7 existe en ambas y son
    // personas distintas), así que son dos mapas, nunca uno solo por id.
    const condIds = new Set<number>();
    const terIds = new Set<number>();
    for (const r of todas) {
      if (r.conductor_id) condIds.add(r.conductor_id);
      if (r.conductor_tercero_id) terIds.add(r.conductor_tercero_id);
    }
    for (const e of estados.values()) {
      if (!e.conductor_avisado) continue;
      // Default 'conductores': lo grabado antes de esta versión era solo flota propia.
      if ((e.conductor_tabla_avisada ?? "conductores") === "conductores_tercero") terIds.add(e.conductor_avisado);
      else condIds.add(e.conductor_avisado);
    }

    type DatosCond = { nombre: string; telefono: string | null; email: string | null };
    const condMap = new Map<number, DatosCond>();
    if (condIds.size) {
      const { data } = await admin.from("conductores").select("id, nombre, telefono, email").in("id", [...condIds]);
      for (const c of data ?? []) condMap.set(c.id, { nombre: c.nombre, telefono: c.telefono, email: c.email });
    }

    // Conductores TERCERIZADOS. Históricamente NUNCA recibían avisos del motor; ahora
    // pueden, pero solo si el tipo de mensaje tiene `notifica_conductor_tercero`
    // encendido (default false ⇒ al desplegar no cambia ni un envío).
    const terMap = new Map<number, DatosCond>();
    if (terIds.size) {
      // `email` es columna nueva (supabase/conductores-tercero-avisos.sql): si la
      // migración no corrió, el select falla entero → se reintenta sin ella.
      const sel = await admin.from("conductores_tercero").select("id, nombre, telefono, email").in("id", [...terIds]);
      const filas = sel.error
        ? (await admin.from("conductores_tercero").select("id, nombre, telefono").in("id", [...terIds])).data
        : sel.data;
      for (const c of filas ?? []) {
        terMap.set(c.id, { nombre: c.nombre, telefono: c.telefono, email: (c as any).email ?? null });
      }
    }

    type RefCond = { id: number; tabla: "conductores" | "conductores_tercero" };
    /** Conductor de una reserva, sea propio o tercerizado (o null si no tiene). */
    function condDe(r: any): RefCond | null {
      if (r.conductor_id) return { id: r.conductor_id, tabla: "conductores" };
      if (r.conductor_tercero_id) return { id: r.conductor_tercero_id, tabla: "conductores_tercero" };
      return null;
    }
    const datosCond = (ref: RefCond) => (ref.tabla === "conductores" ? condMap : terMap).get(ref.id);
    /** ¿Este tipo de mensaje debe avisar a este conductor? */
    const avisaA = (cfg: AlertaConfig, ref: RefCond) =>
      ref.tabla === "conductores" ? true : cfg.notifica_conductor_tercero === true;
    // ── Helpers de envío (tri-estado: distingue "sin canal" de "fallo transitorio") ──
    // El CANAL ya no es fijo: sale por los que tenga habilitados ese tipo de mensaje
    // (canal_conductor_* en alerta_config). Ver lib/notificaciones.ts::enviarAConductor.
    async function aConductor(
      cfg: AlertaConfig, ref: RefCond | number | null, params: string[],
      extra?: {
        titulo?: string;
        /** Con la reserva, el aviso queda en `notificaciones_enviadas` con su clave: es lo
         *  que permite contestar después «¿le llegó?» (lib/escalera-inicio.ts). */
        reservaId?: number;
        /** Notificación del app de la escalera de inicio: urgente, con hora y punto. */
        push?: TextoPush;
      },
    ): Promise<ResultadoEnvio> {
      // Compat: los llamadores viejos pasan un id suelto = conductor propio.
      const r0: RefCond | null = typeof ref === "number" ? { id: ref, tabla: "conductores" } : ref;
      if (!r0 || !cfg.plantilla) return "sin_canal";
      if (!avisaA(cfg, r0)) return "sin_canal";       // tercerizado con el aviso apagado
      const c = datosCond(r0);
      if (!c) return "sin_canal";
      const r = await enviarAConductor({
        conductor: { id: r0.id, nombre: c.nombre, telefono: c.telefono, email: c.email },
        tabla: r0.tabla,
        plantilla: cfg.plantilla,
        parametros: params,
        canales: canalesConductor(cfg),
        titulo: extra?.titulo ?? cfg.nombre,
        reservaId: extra?.reservaId,
        trigger: "manual",
        alertaClave: cfg.clave,
        ...(extra?.push
          ? {
              pushTexto: extra.push.cuerpo,
              push: { titulo: extra.push.titulo, urgencia: "high" as const, ttl: extra.push.ttl, requireInteraction: extra.push.requireInteraction },
            }
          : {}),
      });
      return r.estado;
    }
    async function aDirectorio(cfg: AlertaConfig, params: string[]): Promise<{ enviados: number; fallos: number }> {
      let enviados = 0, fallos = 0;
      for (const d of directorioDe(cfg, destinatarios)) {
        const r = await enviarAvisoWhatsApp(d.telefono, cfg.plantilla_directorio || "coordinador_alerta", params);
        if (r.ok) enviados++; else fallos++;
      }
      return { enviados, fallos };
    }
    // Variante PERSONALIZADA: antepone el nombre propio de CADA destinatario (p.ej.
    // "Hola Moisés..." en vez de un texto genérico) — un envío distinto por persona.
    async function aDirectorioPersonalizado(cfg: AlertaConfig, paramsSinNombre: string[]): Promise<{ enviados: number; fallos: number }> {
      let enviados = 0, fallos = 0;
      for (const d of directorioDe(cfg, destinatarios)) {
        const r = await enviarAvisoWhatsApp(d.telefono, cfg.plantilla_directorio || "coordinador_alerta", [nombreCorto(d.nombre), ...paramsSinNombre]);
        if (r.ok) enviados++; else fallos++;
      }
      return { enviados, fallos };
    }

    // ── BLOQUE 1: asignación / cambio / cancelación / desasignación (diff por reserva) ──
    {
      const cAsig = activa("asignacion"), cCamb = activa("cambio"),
            cCanc = activa("cancelacion"), cDes = activa("desasignacion");
      if (cAsig || cCamb || cCanc || cDes) {
        let n = 0;
        // ── HORARIO DE ENVÍO (lib/alertas-horario.ts + supabase/alertas-horario-conductor.sql) ──
        // Este bloque es `modo_tiempo = 'evento'`: dispara cuando DETECTA el cambio. Y como
        // el motor solo mira `fecha_servicio in (hoy, mañana)`, un programa fijo creado con
        // semanas de antelación se detecta justo cuando su fecha pasa a ser "mañana" — a
        // MEDIANOCHE. De ahí los "vehículo asignado · 12:00 a. m." que reportó el dueño:
        // no era una hora mal puesta, era la primera vez que el motor veía la reserva.
        //
        // Retener NO pierde nada, y es por cómo está armado el bloque: el baseline
        // (`upsertEstado`) solo avanza cuando el envío SALE, así que una reserva retenida
        // se vuelve a detectar idéntica en el siguiente tick (~10 min) hasta que abra la
        // ventana. Es el mismo PRINCIPIO ANTI-PÉRDIDA de la cabecera del archivo.
        //
        // Lo que el motor NUNCA retiene lo decide `planDeEnvioConductor`, no este bucle:
        // un servicio de HOY y un servicio cuya hora llega antes que la ventana salen al
        // instante, sea la hora que sea.
        let enEspera = 0;
        const esperaA = (cfg: AlertaConfig | null | undefined, r: any): boolean => {
          if (!cfg) return false;
          const plan = planDeEnvioConductor({
            ahoraMs,
            fechaServicio: r.fecha_servicio,
            horaServicio: horaCorta(r.hora_servicio),
            horario: horarioDe(cfg),
          });
          if (plan.enviar) return false;
          enEspera++;
          return true;
        };
        // Las ASIGNACIONES no se envían dentro del bucle: se acumulan por conductor y
        // salen agrupadas al final (un conductor al que se le programan 5 servicios de
        // una sentada recibía 5 WhatsApp seguidos). El resto de avisos del bloque
        // —cambio, cancelación, desasignación— sigue saliendo aquí, uno por reserva:
        // cada uno informa un hecho distinto sobre un servicio concreto.
        //
        // Al diferir el envío hay que diferir también su upsertEstado: si se grabara
        // ahora y el envío agrupado fallara, la reserva quedaría marcada como avisada
        // y el conductor nunca se enteraría. Por eso `diferido` salta el grabado del
        // final del bucle y se hace después, sólo para las que salieron.
        const pendientesAsig = new Map<string, { ref: RefCond; reservas: number[] }>();
        for (const r of cicloVida) {
          const est = estados.get(r.id);
          const fecha = r.fecha_servicio; const hora = horaCorta(r.hora_servicio);
          const ruta = rutaDe(r);
          const ref = condDe(r);
          // Tabla del conductor ya avisado (default 'conductores': todo lo registrado
          // antes de esta versión era flota propia).
          const tablaPrev = (est?.conductor_tabla_avisada ?? "conductores") as RefCond["tabla"];
          const refPrev: RefCond | null = est?.conductor_avisado
            ? { id: est.conductor_avisado, tabla: tablaPrev } : null;
          const mismoCond = !!ref && !!refPrev && ref.id === refPrev.id && ref.tabla === refPrev.tabla;

          // Cancelación: avisar al conductor asignado. Solo marcar si el envío salió.
          // `esperaA` va DENTRO de la condición: retenido no se marca nada, así que el
          // próximo tick lo vuelve a ver pendiente (`cancelacion_avisada` sigue false).
          if (r.estado === "cancelada") {
            if (cCanc && ref && refPrev && !est?.cancelacion_avisada && !esperaA(cCanc, r)) {
              const nombre = nombreCorto(datosCond(ref)?.nombre);
              if ((await aConductor(cCanc, ref, [nombre, fecha, ruta])) === "enviado") {
                n++;
                await upsertEstado(r.id, { cancelacion_avisada: true });
              }
            }
            continue;
          }
          if (!ref) continue;

          let avanzar = true; // por defecto graba baseline (config off o sin cambio) para no
                              // disparar un "cambio" espurio después.
          let diferido = false; // asignación encolada: su estado se graba tras el envío agrupado
          const tieneTel = !!datosCond(ref)?.telefono;
          if (!mismoCond) {
            // El aviso al SALIENTE y el del entrante comparten el baseline de esta
            // reserva, así que se retienen juntos o ninguno: retener solo la asignación
            // dejaría el "ya no cubres ese servicio" saliendo en CADA tick hasta que
            // abriera la ventana — una ráfaga de WhatsApp facturables cada 10 min.
            // Manda la ventana de `asignacion` (es el aviso que motivó todo esto); si ese
            // tipo está apagado, la de `desasignacion`, que es el único que quedaría.
            //
            // Solo se retiene si de verdad iba a salir algo. Una reserva TERCERIZADA con
            // el aviso apagado pasa por aquí a propósito —para grabar su baseline y que
            // encenderlo algún día no dispare una avalancha por reservas viejas— y
            // retenerla sería aplazar ese grabado y, peor, contarla como "en espera"
            // cuando no hay ningún mensaje esperando.
            const vaSalirAlgo = (!!cDes && !!refPrev && avisaA(cDes, refPrev))
                             || (!!cAsig && avisaA(cAsig, ref));
            if (vaSalirAlgo && esperaA(cAsig ?? cDes, r)) continue;  // sin tocar estado → se reintenta
            // Reasignación: avisar al conductor SALIENTE que ya no cubre el servicio.
            if (cDes && refPrev) {
              const ant = nombreCorto(datosCond(refPrev)?.nombre);
              await aConductor(cDes, refPrev, [ant, fecha, ruta]);
            }
            if (cAsig && avisaA(cAsig, ref)) {
              // Sin teléfono aún → no encolar (evita log-spam); avanzar=false reintenta
              // cuando lo tenga.
              if (!tieneTel) { avanzar = false; }
              else {
                const clave = `${ref.tabla}:${ref.id}`;
                const g = pendientesAsig.get(clave) ?? { ref, reservas: [] };
                g.reservas.push(r.id);
                pendientesAsig.set(clave, g);
                diferido = true;
              }
            }
          } else if (est!.hora_avisada !== hora || est!.vehiculo_avisado !== (r.vehiculo_id ?? null)) {
            if (cCamb && avisaA(cCamb, ref)) {
              if (esperaA(cCamb, r)) continue;        // sin tocar estado → se reintenta
              if (!tieneTel) { avanzar = false; }
              else {
                const rc = await notificarConductor(r.id, "cambio", cCamb.plantilla ?? undefined, canalesConductor(cCamb));
                avanzar = rc.estado === "enviado";
                if (avanzar) n++;
              }
            }
          }
          if (avanzar && !diferido) {
            await upsertEstado(r.id, {
              conductor_avisado: ref.id,
              conductor_tabla_avisada: ref.tabla,
              vehiculo_avisado: r.vehiculo_id ?? null,
              hora_avisada: hora,
            });
          }
        }

        // ── Envío agrupado de las asignaciones encoladas ──
        // Un servicio → mensaje detallado de siempre (conserva los botones de mapa, que
        // son por servicio y se pierden al agrupar). Varios → un mensaje con la lista.
        const marcarEnviadas = async (g: { ref: RefCond; reservas: number[] }, ids: number[]) => {
          for (const id of ids) {
            const r = cicloVida.find((x) => x.id === id);
            if (!r) continue;
            await upsertEstado(id, {
              conductor_avisado: g.ref.id,
              conductor_tabla_avisada: g.ref.tabla,
              vehiculo_avisado: r.vehiculo_id ?? null,
              hora_avisada: horaCorta(r.hora_servicio),
            });
          }
        };

        for (const g of pendientesAsig.values()) {
          if (g.reservas.length === 1) {
            const rc = await notificarConductor(g.reservas[0], "asignacion", cAsig!.plantilla ?? undefined, canalesConductor(cAsig!));
            if (rc.estado === "enviado") { n++; await marcarEnviadas(g, g.reservas); }
            continue;   // si falló, sin grabar → el próximo tick reintenta
          }

          const c = datosCond(g.ref);
          const rc = await notificarConductorAsignacionAgrupada({
            reservaIds: g.reservas,
            conductor: { id: g.ref.id, nombre: c?.nombre, telefono: c?.telefono, email: c?.email },
            tabla: g.ref.tabla,
            canales: canalesConductor(cAsig!),
          });
          if (rc.estado === "enviado") { n++; await marcarEnviadas(g, g.reservas); continue; }

          // RESPALDO: el agrupado no salió — típicamente porque la plantilla
          // `conductor_asignacion_multiple` todavía no está creada/aprobada en Meta.
          // Se cae al envío de siempre, uno por reserva, para que el conductor se entere
          // igual; sin esto quedaría incomunicado y el tick reintentaría cada 10 min
          // indefinidamente. En cuanto la plantilla exista, el agrupado gana y esto
          // deja de ejecutarse solo.
          const enviadas: number[] = [];
          for (const id of g.reservas) {
            const r1 = await notificarConductor(id, "asignacion", cAsig!.plantilla ?? undefined, canalesConductor(cAsig!));
            if (r1.estado === "enviado") { n++; enviadas.push(id); }
          }
          await marcarEnviadas(g, enviadas);
        }
        res.ciclo_vida = n;
        // Cuántos avisos quedaron esperando a que abra el horario. Se publica para poder
        // contestar "¿por qué no le llegó todavía?" sin mirar la base: 0 significa que
        // nada está retenido, no que el horario esté apagado.
        if (enEspera) res.ciclo_vida_en_espera = enEspera;
      }
    }

    // ── BLOQUES 2/3: recordatorios (dedupe ATÓMICO compartido con el cron viejo vía
    //    reclamarEnvio; ambos endpoints reclaman la misma llave antes de enviar). ────
    const cRecC = activa("recordatorio_conductor"), cRecP = activa("recordatorio_pasajero");
    if (cRecC) {
      let n = 0;
      for (const r of todas) {
        const ref = condDe(r);
        if (!ref || !avisaA(cRecC, ref)) continue;   // tercerizado con el aviso apagado
        if (!["programada", "confirmada"].includes(r.estado)) continue;
        if (!enViaRecordatorio(cRecC, r, hoy, manana, ahora, force)) continue;
        if (!(await reclamarEnvio("recordatorio_conductor", r.id))) continue;
        try {
          const rc = await notificarConductor(r.id, "cron_recordatorio", undefined, canalesConductor(cRecC));
          if (rc.estado === "error") await liberarEnvio("recordatorio_conductor", r.id); // transitorio → reintentar
          else n++;
        } catch { await liberarEnvio("recordatorio_conductor", r.id); }
      }
      res.recordatorio_conductor = n;
    }
    if (cRecP) {
      let n = 0;
      for (const r of todas) {
        if (!["programada", "confirmada", "en_curso"].includes(r.estado)) continue;
        if (!enViaRecordatorio(cRecP, r, hoy, manana, ahora, force)) continue;
        if (!(await reclamarEnvio("recordatorio_pasajero", r.id))) continue;
        try {
          const rr = await notificarReserva(r.id, "cron_recordatorio", "recordatorio_pasajero");
          // Nada entregado y todo falló → transitorio: liberar para reintentar. Si no hubo
          // errores (simplemente no había canal), se deja reclamado para no reintentar en bucle.
          if (rr.resumen.enviados === 0 && rr.resumen.errores > 0) await liberarEnvio("recordatorio_pasajero", r.id);
          else n++;
        } catch { await liberarEnvio("recordatorio_pasajero", r.id); }
      }
      res.recordatorio_pasajero = n;
    }

    // ── BLOQUE 3b: avisos CORTOS pre-inicio (por tramo, NUNCA combinado ida+retorno:
    //    a esta hora cada tramo merece su propio empujón). Solo mientras el conductor
    //    NO haya iniciado el servicio en la app (estado sigue programada/confirmada) —
    //    varios tipos posibles a distintos minutos de anticipación (90min, 30min, …),
    //    cada uno su propia tarjeta/clave en el panel, misma lógica compartida aquí.
    async function avisoPreInicio(clave: string): Promise<number> {
      const cfg = activa(clave);
      if (!cfg) return 0;
      let n = 0;
      for (const r of todas) {
        const ref = condDe(r);
        if (!ref || !avisaA(cfg, ref)) continue;     // tercerizado con el aviso apagado
        if (!["programada", "confirmada"].includes(r.estado)) continue; // aún no inició
        if (!enViaRecordatorio(cfg, r, hoy, manana, ahora, force)) continue;
        if (!(await reclamarEnvio(clave, r.id))) continue;
        // `ref`, no `r.conductor_id`: con el id suelto, un conductor TERCERIZADO nunca recibía
        // este aviso aunque su tarjeta dijera «avisar también a tercerizados».
        const nombre = nombreCorto(datosCond(ref)?.nombre);
        const hora = horaCorta(r.hora_servicio);
        const origenTexto = r.origen || rutaDe(r);
        // Los minutos de la tarjeta (el push de «Recuerda iniciar» los dice): solo con
        // «Antes del servicio»; a una hora fija sale la víspera y no se promete ninguno.
        const minutos = cfg.modo_tiempo === "anticipacion" ? (cfg.min_anticipacion ?? ANTICIPACION_DEFECTO_MIN) : null;
        const rc = await aConductor(cfg, ref, [nombre, hora, origenTexto], {
          reservaId: r.id,
          push: textoPushInicio(clave, { hora, origen: r.origen || rutaDe(r), minutos }),
        });
        if (rc === "enviado") n++;
        else if (rc === "fallo") await liberarEnvio(clave, r.id); // transitorio → reintentar
        // "sin_canal" (sin teléfono/plantilla) queda reclamado: evita reintentar en bucle.
      }
      return n;
    }
    res.proximo_inicio  = await avisoPreInicio("proximo_inicio");
    res.recuerda_iniciar = await avisoPreInicio("recuerda_iniciar");

    // ── BLOQUE 3b-2: recordatorio PERSONAL al Coordinador para que llame al conductor
    //    ("Hola Moisés, debes llamar a…") — rutina de control 1h antes, no depende de
    //    si el conductor ya inició o no (a diferencia de la alerta previa de abajo).
    {
      const cfg = activa("llamar_conductor");
      if (cfg) {
        // AGRUPADO POR TICK (13-10-2026): antes salía un WhatsApp cobrado POR SERVICIO —con 40
        // servicios en la mañana, 40 mensajes al coordinador—. Ahora los que entran juntos a la
        // ventana van en UN mensaje por coordinador (`coordinador_alerta`). Con uno solo, el
        // mensaje personal de siempre (`coordinador_llamar_conductor`).
        const tocan: { id: number; linea: string; nombreCond: string; ruta: string; hora: string }[] = [];
        for (const r of todas) {
          if (r.tipo_asignacion !== "propio" || !r.conductor_id) continue;
          if (!["programada", "confirmada"].includes(r.estado)) continue;
          if (!enViaRecordatorio(cfg, r, hoy, manana, ahora, force)) continue;
          if (!(await reclamarEnvio("llamar_conductor", r.id))) continue;
          const nombreCond = nombreCorto(condMap.get(r.conductor_id)?.nombre);
          const hora = horaCorta(r.hora_servicio);
          const ruta = rutaDe(r);
          tocan.push({ id: r.id, nombreCond, ruta, hora, linea: `${hora} ${nombreCond} (${ruta})` });
        }
        let n = 0;
        if (tocan.length === 1) {
          const t = tocan[0];
          const rd = await aDirectorioPersonalizado(cfg, [t.nombreCond, t.ruta, t.hora]);
          if (rd.enviados > 0) n++;
          else if (rd.fallos > 0) await liberarEnvio("llamar_conductor", t.id); // transitorio → reintentar
        } else if (tocan.length > 1) {
          tocan.sort((a, b) => a.hora.localeCompare(b.hora));
          const detalle = listaEnUnaLinea(tocan.map((t) => t.linea), 600);
          let enviados = 0, fallos = 0;
          for (const d of directorioDe(cfg, destinatarios)) {
            const rr = await enviarAvisoWhatsApp(d.telefono, "coordinador_alerta",
              ["Llamar a conductores", `${tocan.length} conductores`, "Servicios de la próxima hora", detalle]);
            if (rr.ok) enviados++; else fallos++;
          }
          if (enviados > 0) n = tocan.length;
          else if (fallos > 0) for (const t of tocan) await liberarEnvio("llamar_conductor", t.id);
        }
        res.llamar_conductor = n;
      }
    }

    // ── BLOQUE 3c: alerta PREVIA al Coordinador (antes de la hora) — el conductor ya
    //    recibió el aviso de 90 min (y el de 30, si su tarjeta está encendida — el dueño lo
    //    apagó el 11-10-2026) y sigue sin iniciar el recorrido en la
    //    app (sin GPS, sin confirmar salida). A diferencia de "no_inicio" (que dispara
    //    DESPUÉS de la hora), esta es la escalada PREVENTIVA para que Operaciones
    //    pueda llamarlo antes de que el servicio arranque tarde. Reusa la plantilla
    //    genérica `coordinador_alerta`, que tiene que existir APROBADA en la cuenta de
    //    avisos (el 11-10-2026 no existía y ninguna alerta al coordinador salía: se crea
    //    con «Prellenar» en /configuracion/operaciones, lib/plantillas-sugeridas.ts).
    {
      const cfg = activa("alerta_no_inicio_previa");
      if (cfg) {
        let n = 0;
        for (const r of todas) {
          // Propios siempre; TERCERIZADOS si la tarjeta tiene «Incluir tercerizados» (13-10-2026:
          // antes solo propios, mientras «No inició a tiempo» sí los incluía).
          const ref = condDe(r);
          if (!ref) continue;
          if (ref.tabla === "conductores_tercero" && cfg.notifica_conductor_tercero !== true) continue;
          if (!["programada", "confirmada"].includes(r.estado)) continue; // aún no pulsa INICIAR RECORRIDO
          if (!enViaRecordatorio(cfg, r, hoy, manana, ahora, force)) continue;
          if (!(await reclamarEnvio("alerta_no_inicio_previa", r.id))) continue;
          const nombre = nombreCorto(datosCond(ref)?.nombre);
          const hora = horaCorta(r.hora_servicio);
          const ruta = rutaDe(r);
          const ini = hhmmAMin(r.hora_servicio);
          const faltan = ini == null ? Number(cfg.min_anticipacion ?? 25)
            : (r.fecha_servicio === hoy ? ini : ini + 1440) - ahora;
          // Lo que ya se le mandó y si le llegó: con «ningún WhatsApp le llegó» el coordinador
          // sabe que el teléfono no tiene datos y que lo que sirve es llamarlo.
          const evidencia = (await resumenAvisosDeReserva(r.id, ahoraMs)).texto;
          const rd = await aDirectorio(cfg, ["Falta iniciar recorrido", nombre, `${ruta} ${hora}`,
            detalleAlertaPrevia(faltan, evidencia)]);
          if (rd.enviados > 0) n++;
          else if (rd.fallos > 0) await liberarEnvio("alerta_no_inicio_previa", r.id); // transitorio → reintentar
        }
        res.alerta_no_inicio_previa = n;
      }
    }

    // ── SEMÁFORO DE PUNTUALIDAD (lib/retrasos.ts) ──────────────────────────────
    // Un solo cálculo por tick, compartido por los bloques 4 y 4b-4e. Este es el ÚNICO
    // punto del sistema que PAGA ETA con tráfico, y solo para los servicios en "franja
    // de duda" (lib/eta-trafico.ts); la torre reutiliza esa caché sin gastar nada.
    //
    // Se calcula SIEMPRE (aunque los avisos nuevos estén apagados) porque alimenta la
    // pantalla y la supresión del falso "no inició"; lo que se condiciona es el PAGO.
    const cfgRiesgo   = activa("riesgo_retraso");
    const cfgEnPunto  = activa("en_punto_sin_iniciar");
    const cfgEnRuta   = activa("retraso_en_ruta");
    const cfgSinRastreo = activa("sin_rastreo_previo");
    let puntualidad = new Map<number, VeredictoCtx>();
    try {
      const rp = await veredictosDelDia({
        fecha: hoy,
        permitirPago: !!(cfgRiesgo || cfgEnRuta),   // sin avisos de previsión, nada que pagar
      });
      puntualidad = rp.veredictos;
      await guardarVeredictos(puntualidad.values(), rp.previos);
    } catch (e: any) {
      // El semáforo es un extra: si falla, el motor sigue con sus bloques de siempre.
      console.warn("[tick] puntualidad:", e?.message);
    }
    const vere = (id: number) => puntualidad.get(id);

    // ── BLOQUE 4: no inició a tiempo ────────────────────────────────────────────
    {
      const cfg = activa("no_inicio");
      if (cfg) {
        const gracia = cfg.umbral ?? UMBRAL_DEFECTO.no_inicio;
        // Si «Ya debió iniciar» ya le escribió a este conductor el MISMO texto, el +10 va solo
        // al coordinador (noInicioRepiteDebio, por conductor: propio o tercerizado).
        const cfgDebio = activa("debio_iniciar");
        let n = 0;
        for (const r of todas) {
          if (r.fecha_servicio !== hoy) continue;
          if (!["programada", "confirmada"].includes(r.estado)) continue; // aún no inició
          const ini = hhmmAMin(r.hora_servicio);
          if (ini == null || ahora < ini + gracia) continue;
          // El bus ESTÁ en el paradero y el conductor solo olvidó pulsar Iniciar: eso no
          // es "no inició a tiempo", y mandarle ese texto (y despertar al coordinador) es
          // el falso positivo que este módulo viene a eliminar. Lo atiende el bloque 4b.
          // Solo se suprime si ese tipo de aviso está ENCENDIDO: con él apagado, el
          // comportamiento es exactamente el de antes (un deploy no debe silenciar nada).
          if (cfgEnPunto && vere(r.id)?.nivel === "en_punto_sin_iniciar") continue;
          if (!(await reclamarEnvio("no_inicio", r.id))) continue;
          const ruta = rutaDe(r); const hora = horaCorta(r.hora_servicio);
          // `condDe`: con `r.conductor_id` solo, el TERCERIZADO no recibía este aviso nunca.
          const ref = condDe(r);
          const nombre = ref ? nombreCorto(datosCond(ref)?.nombre) : "Conductor";
          let exitos = 0, fallos = 0;
          if (cfg.notifica_conductor && ref && !noInicioRepiteDebio(cfgDebio, ref.tabla === "conductores_tercero")) {
            const rc = await aConductor(cfg, ref, [nombre, hora, ruta, telConting], {
              reservaId: r.id,
              push: textoPushInicio("no_inicio", { hora, origen: r.origen || ruta }),
            });
            if (rc === "enviado") exitos++; else if (rc === "fallo") fallos++;
          }
          const evidencia = (await resumenAvisosDeReserva(r.id, ahoraMs)).texto;
          const rd = await aDirectorio(cfg, ["No inició a tiempo", nombre, `${ruta} ${hora}`,
            `Pasaron ${gracia}+ min de la hora y no marcó inicio.${evidencia ? ` ${evidencia}` : ""}`]);
          exitos += rd.enviados; fallos += rd.fallos;
          if (exitos === 0 && fallos > 0) { await liberarEnvio("no_inicio", r.id); continue; } // transitorio → reintentar
          n++;
        }
        res.no_inicio = n;
      }
    }

    // ── BLOQUE 4b: EN EL PUNTO, SIN INICIAR ────────────────────────────────────
    // El GPS confirma el bus dentro del geocerco del primer paradero, quieto y con
    // permanencia. Eso NO es un retraso: el bus está donde debe estar y lo único que
    // falta es el toque de "Iniciar". Dos avisos muy distintos, en este orden:
    //   1) al CONDUCTOR, un empujón — que resuelve el 100 % de los casos normales;
    //   2) al COORDINADOR, SOLO si persiste pasada la hora (v.escala): ahí ya no es un
    //      olvido, es un conductor dormido, sin batería o con la app rota.
    // Lo que NO se hace nunca: marcar el servicio como iniciado. lib/avance-paradas.ts:30
    // ya fijó que inferir para PINTAR no autoriza a inferir para ESCRIBIR.
    if (cfgEnPunto) {
      let n = 0;
      for (const r of todas) {
        if (r.fecha_servicio !== hoy) continue;
        const v = vere(r.id);
        if (v?.nivel !== "en_punto_sin_iniciar") continue;
        const ref = condDe(r);
        const hora = horaCorta(r.hora_servicio);
        const nombre = ref ? nombreCorto(datosCond(ref)?.nombre) : "Conductor";

        // 1) Empujón al conductor (una vez por servicio y día).
        if (cfgEnPunto.notifica_conductor && ref && await reclamarEnvio("en_punto_sin_iniciar", r.id)) {
          const rc = await aConductor(cfgEnPunto, ref, [nombre, hora, r.origen || rutaDe(r)], {
            reservaId: r.id,
            push: textoPushInicio("en_punto_sin_iniciar", { hora, origen: r.origen || rutaDe(r) }),
          });
          if (rc === "enviado") n++;
          else if (rc === "fallo") await liberarEnvio("en_punto_sin_iniciar", r.id); // transitorio
        }

        // 2) Escalada al coordinador solo si PERSISTE (clave de dedupe propia).
        if (v.escala && await reclamarEnvio("en_punto_escala", r.id)) {
          const rd = await aDirectorio(cfgEnPunto, [
            "En el punto y sin iniciar", nombre, `${rutaDe(r)} ${hora}`,
            `El GPS lo ubica en el paradero pero no marca inicio. ${v.evidencia}`,
          ]);
          if (rd.enviados > 0) n++;
          else if (rd.fallos > 0) await liberarEnvio("en_punto_escala", r.id);
        }
      }
      res.en_punto_sin_iniciar = n;
    }

    // ── BLOQUE 4c: RIESGO DE RETRASO (previsión, ANTES de la hora) ─────────────
    // La razón de ser del módulo: avisar cuando todavía se puede hacer algo. El bus está
    // lejos del primer paradero y, con el tráfico de AHORA, no llega al objetivo
    // (hora pactada menos la anticipación de embarque). El veredicto ya trae la
    // evidencia; aquí solo se reparte.
    if (cfgRiesgo) {
      let n = 0;
      for (const r of todas) {
        if (r.fecha_servicio !== hoy) continue;
        const v = vere(r.id);
        if (v?.nivel !== "riesgo" || !v.escala) continue;
        if ((v.minutos ?? 0) < (cfgRiesgo.umbral ?? UMBRAL_DEFECTO.riesgo_retraso)) continue;
        if (!(await reclamarEnvio("riesgo_retraso", r.id))) continue;
        const ref = condDe(r);
        const nombre = ref ? nombreCorto(datosCond(ref)?.nombre) : "Conductor";
        const rd = await aDirectorio(cfgRiesgo, [
          `Riesgo de retraso (~${v.minutos} min)`, nombre,
          `${rutaDe(r)} ${horaCorta(r.hora_servicio)}`,
          `Aún se puede reaccionar. ${v.evidencia}`,
        ]);
        if (rd.enviados > 0) n++;
        else if (rd.fallos > 0) await liberarEnvio("riesgo_retraso", r.id);
      }
      res.riesgo_retraso = n;
    }

    // ── BLOQUE 4d: RETRASO EN RUTA (servicio ya iniciado) ─────────────────────
    // El hueco más grande del sistema anterior: una vez en curso, el servicio era verde
    // para siempre aunque llegara 50 min tarde. Se compara el ETA contra la
    // `hora_estimada` del SIGUIENTE paradero — nunca contra "la hora de ahora" (bug b03caba).
    if (cfgEnRuta) {
      let n = 0;
      for (const r of todas) {
        if (r.fecha_servicio !== hoy || r.estado !== "en_curso") continue;
        const v = vere(r.id);
        if (v?.nivel !== "retraso_en_ruta") continue;
        if ((v.minutos ?? 0) < (cfgEnRuta.umbral ?? UMBRAL_DEFECTO.retraso_en_ruta)) continue;
        if (!(await reclamarEnvio("retraso_en_ruta", r.id))) continue;
        const ref = condDe(r);
        const nombre = ref ? nombreCorto(datosCond(ref)?.nombre) : "Conductor";
        const rd = await aDirectorio(cfgEnRuta, [
          `Retraso en ruta (~${v.minutos} min)`, nombre,
          `${rutaDe(r)} ${horaCorta(r.hora_servicio)}`,
          v.evidencia || v.causa,
        ]);
        if (rd.enviados > 0) n++;
        else if (rd.fallos > 0) await liberarEnvio("retraso_en_ruta", r.id);
      }
      res.retraso_en_ruta = n;
    }

    // ── BLOQUE 4e: SIN RASTREO antes del servicio ─────────────────────────────
    // NO dice "retraso": dice "no puedo saberlo". La cobertura de GPS en segundo plano
    // va de 36 % a 100 % según el conductor, así que la ausencia de señal jamás se lee
    // como ausencia de bus. Para un TERCERO el significado es otro y sí es exigible: no
    // abrió el link del token, que es su obligación de rastreo — por eso el aviso va
    // también a la empresa proveedora (decisión del operador, 2026-08-20) y queda en
    // retraso_evento para el reporte mensual de cumplimiento.
    if (cfgSinRastreo) {
      const antelacion = cfgSinRastreo.umbral ?? UMBRAL_DEFECTO.sin_rastreo_previo;
      const candidatos = todas.filter((r) => {
        if (r.fecha_servicio !== hoy) return false;
        if (vere(r.id)?.nivel !== "sin_rastreo") return false;
        const ini = hhmmAMin(r.hora_servicio);
        return ini != null && ahora >= ini - antelacion && ahora <= ini;
      });
      let n = 0;
      if (candidatos.length) {
        const empIds = [...new Set(candidatos.map((r) => r.empresa_tercerizada_id).filter(Boolean))];
        const empMap = new Map<number, { razon_social: string; telefono: string | null }>();
        if (empIds.length) {
          const { data } = await admin
            .from("empresas_tercerizadas").select("id, razon_social, telefono").in("id", empIds);
          for (const e of data ?? []) empMap.set(e.id, { razon_social: e.razon_social, telefono: e.telefono });
        }
        for (const r of candidatos) {
          if (!(await reclamarEnvio("sin_rastreo_previo", r.id))) continue;
          const emp = r.empresa_tercerizada_id ? empMap.get(r.empresa_tercerizada_id) : null;
          const quien = emp?.razon_social || (condDe(r) ? nombreCorto(datosCond(condDe(r)!)?.nombre) : "Unidad");
          const detalle = emp
            ? "La unidad no está enviando ubicación: el conductor aún no abrió el link de seguimiento."
            : "La unidad no está enviando ubicación. No se puede confirmar si llegará a tiempo.";
          const rd = await aDirectorio(cfgSinRastreo, [
            "Sin rastreo antes del servicio", quien,
            `${rutaDe(r)} ${horaCorta(r.hora_servicio)}`, detalle,
          ]);
          let exitos = rd.enviados;
          // Al PROVEEDOR: mismo texto, a su número. Es su incumplimiento, no el nuestro.
          if (emp?.telefono) {
            const re = await enviarAvisoWhatsApp(
              emp.telefono, cfgSinRastreo.plantilla_directorio || "coordinador_alerta",
              ["Sin rastreo antes del servicio", emp.razon_social,
               `${rutaDe(r)} ${horaCorta(r.hora_servicio)}`, detalle],
            );
            if (re.ok) exitos++;
          }
          if (exitos > 0) n++;
          else if (rd.fallos > 0) await liberarEnvio("sin_rastreo_previo", r.id);
        }
      }
      res.sin_rastreo_previo = n;
    }

    // ── BLOQUE 5: GPS sin señal (reservas en curso) ─────────────────────────────
    {
      const cfg = activa("gps_silencio");
      if (cfg) {
        const silencioMin = cfg.umbral ?? UMBRAL_DEFECTO.gps_silencio;
        const enCurso = todas.filter((r) => r.estado === "en_curso");
        // Estados propios de estos en_curso (incluye TERCERIZADOS, que no están en `estados`
        // que se cargó solo para propias) — necesario para deduplicar el re-envío.
        const estadosGps = await cargarEstados(enCurso.map((r) => r.id));
        let n = 0;
        for (const r of enCurso) {
          const { data: g } = await admin
            .from("ubicaciones_gps").select("fix_ts, created_at")
            .eq("reserva_id", r.id).order("created_at", { ascending: false }).limit(1);
          const ult = g?.[0];
          if (!ult) continue; // sin NINGÚN fix aún (recién arrancó): no es "se cortó la señal"
          const ts = Date.parse(ult.fix_ts || ult.created_at);
          if (!Number.isFinite(ts)) continue;
          const minsSin = (Date.now() - ts) / 60000;
          const est = estadosGps.get(r.id);
          if (minsSin > silencioMin) {
            if (!est?.gps_silencio_at) {
              const ruta = rutaDe(r);
              const nombre = r.conductor_id ? nombreCorto(condMap.get(r.conductor_id)?.nombre) : "Conductor";
              let exitos = 0;
              if (cfg.notifica_conductor && r.conductor_id) {
                if ((await aConductor(cfg, r.conductor_id, [nombre, ruta, telConting])) === "enviado") exitos++;
              }
              exitos += (await aDirectorio(cfg, ["GPS sin señal", nombre, ruta, `Sin ubicación hace ${Math.round(minsSin)} min.`])).enviados;
              if (exitos > 0) { await upsertEstado(r.id, { gps_silencio_at: new Date().toISOString() }); n++; }
              // sin entrega → no se arma: el próximo tick reintenta.
            }
          } else if (est?.gps_silencio_at) {
            await upsertEstado(r.id, { gps_silencio_at: null }); // recuperó señal → re-arma
          }
        }
        res.gps_silencio = n;
      }
    }

    // ── BLOQUE 5b: recordar CHECK-OUT de jornada (el odómetro final) ────────────
    // La decisión la toma `planRecordarCheckout` (lib/alertas-checkout.ts, PURO): cuando el
    // conductor cerró su último servicio del día (los cancelados no cuentan), pasado el tiempo de
    // espera (`umbral`) y sin check-out NI lectura de odómetro de la unidad después de ese
    // servicio —venga de la app, del grupo de WhatsApp (Radar) o de una carga a mano—, se le
    // recuerda; y se repite cada `jornada_config.recordar_checkout_cada_min` hasta que cumpla.
    // Tras ESCALAR_TRAS_RECORDATORIOS sin respuesta se avisa UNA vez al directorio marcado.
    {
      const cfg = activa("recordar_checkout");
      if (cfg && cfg.notifica_conductor) {
        // Servicios de hoy por conductor. Los ids de las dos tablas de conductores se solapan:
        // la clave lleva la tabla.
        type FilaServicio = (typeof todas)[number];
        const porConductor = new Map<string, { ref: RefCond; servicios: FilaServicio[] }>();
        for (const r of todas) {
          if (r.fecha_servicio !== hoy) continue;
          const ref = condDe(r);
          if (!ref) continue;
          const k = `${ref.tabla}:${ref.id}`;
          if (!porConductor.has(k)) porConductor.set(k, { ref, servicios: [] });
          porConductor.get(k)!.servicios.push(r);
        }
        const vehDe = (r: { vehiculo_id?: number | null; vehiculo_tercero_id?: number | null }): string | null =>
          r.vehiculo_id ? `propio:${r.vehiculo_id}` : r.vehiculo_tercero_id ? `tercero:${r.vehiculo_tercero_id}` : null;

        // ¿Quién ya hizo check-out hoy? Si la tabla no existe, nadie (la lectura cubre igual).
        const { data: cos } = await admin.from("checkout_conductor").select("conductor_id, es_tercero").eq("fecha", hoy);
        const yaCheckout = new Set<string>(((cos ?? []) as { conductor_id: number; es_tercero: boolean | null }[]).map((c) =>
          `${c.es_tercero ? "conductores_tercero" : "conductores"}:${Number(c.conductor_id)}`));

        // Lecturas de hoy de las unidades en juego. Si la consulta falla NO se recuerda en este
        // tick: sin saber si mandó la foto al grupo, el recordatorio podría llegarle a quien ya
        // cumplió (el próximo tick vuelve a intentarlo).
        const vProp = [...new Set(todas.filter((r) => r.fecha_servicio === hoy && r.vehiculo_id).map((r) => r.vehiculo_id))];
        const vTer = [...new Set(todas.filter((r) => r.fecha_servicio === hoy && r.vehiculo_tercero_id).map((r) => r.vehiculo_tercero_id))];
        const lecturas: LecturaCheckout[] = [];
        let lecturasOk = true;
        for (const [col, ids, pre] of [["vehiculo_id", vProp, "propio"], ["vehiculo_tercero_id", vTer, "tercero"]] as const) {
          if (!ids.length) continue;
          const { data, error } = await admin.from("lecturas_odometro")
            .select(`${col}, estado, capturado_en, created_at, fecha`)
            .eq("fecha", hoy).in(col, ids as number[]);
          if (error) { lecturasOk = false; break; }
          for (const l of (data ?? []) as unknown as Record<string, string | number | null>[]) {
            lecturas.push({
              vehiculo: `${pre}:${l[col]}`,
              ts: tsEfectivoLectura(l as { capturado_en?: string | null; created_at?: string | null; fecha?: string | null }),
              anulada: l.estado === "anulada",
            });
          }
        }

        // Cadencia: la que se configura en /auditoria-jornada («Recordar cada (min)»).
        const { data: jc } = await admin.from("jornada_config").select("recordar_checkout_cada_min").eq("id", 1).maybeSingle();
        const cadenciaMin = cadenciaEfectiva(jc?.recordar_checkout_cada_min);

        const hoyBonito = `${hoy.slice(8, 10)}/${hoy.slice(5, 7)}`; // "20/07" — legible en el mensaje
        let n = 0, escalados = 0;
        if (lecturasOk) for (const [k, { ref, servicios }] of porConductor) {
          const plan = planRecordarCheckout({
            servicios: servicios.map((s) => ({ estado: s.estado, finMs: finServicioMs(s), vehiculo: vehDe(s) })),
            checkoutHecho: yaCheckout.has(k),
            lecturas,
            ahoraMs,
            esperaMin: cfg.umbral ?? UMBRAL_DEFECTO.recordar_checkout,
            cadenciaMin,
          });
          if (plan.codigo !== "recordar") continue;
          const nombre = nombreCorto(datosCond(ref)?.nombre);
          const refEnvio = `${k}:${plan.turno}`;
          let rc: ResultadoEnvio | null = null;
          if (await reclamarEnvio("recordar_checkout", refEnvio)) {
            rc = await aConductor(cfg, ref, [nombre, hoyBonito]);
            if (rc === "fallo") await liberarEnvio("recordar_checkout", refEnvio); // transitorio → reintentar
            else if (rc === "enviado") n++;
            // sin_canal (sin teléfono/plantilla, o tercerizado con el aviso apagado): queda
            // reclamado para no reintentar en bucle.
          }
          // Escalar UNA vez por día al directorio marcado en la alerta («También avisar a»).
          if (escalaAlDirectorio(plan.ronda) && directorioDe(cfg, destinatarios).length) {
            const refDir = `dir:${k}`;
            if (await reclamarEnvio("recordar_checkout", refDir)) {
              // La clave de la unidad («propio:12») no es una placa: se busca solo al escalar.
              let placa = "su unidad";
              const [flota, idTxt] = (plan.vehiculo ?? "").split(":");
              if (idTxt) {
                const { data: v } = await admin.from(flota === "tercero" ? "vehiculos_tercero" : "vehiculos")
                  .select("placa").eq("id", Number(idTxt)).maybeSingle();
                if (v?.placa) placa = v.placa;
              }
              const fin = plan.finMs != null
                ? new Date(plan.finMs).toLocaleTimeString("es-PE", { timeZone: "America/Lima", hour: "2-digit", minute: "2-digit", hour12: false })
                : "-";
              // ¿Le pudieron llegar los recordatorios? Lo mismo que mira `aConductor` antes de enviar,
              // y el «sin canal» del envío de este tick si lo hubo.
              const alcance: AlcanceRecordatorio = !cfg.plantilla ? "sin_plantilla"
                : !avisaA(cfg, ref) ? "tercerizado_sin_aviso"
                : rc === "sin_canal" ? "sin_canal"
                : "recordado";
              const rd = await aDirectorio(cfg, [
                "Falta odómetro final", nombre, `Último servicio ${fin}`,
                detalleEscaladaCheckout({ placa, ronda: plan.ronda, alcance }),
              ]);
              if (rd.enviados === 0 && rd.fallos > 0) await liberarEnvio("recordar_checkout", refDir);
              else if (rd.enviados > 0) escalados++;
            }
          }
        }
        res.recordar_checkout = n;
        res.recordar_checkout_escalados = escalados;
        if (!lecturasOk) res.recordar_checkout_sin_lecturas = 1;
      }
    }

    // ── BLOQUE 6: documentos del conductor por vencer (respeta hora fija) ───────
    {
      const cfg = activa("doc_vence");
      if (cfg && enVentanaHoraFija(cfg, ahora, force)) {
        const dias = cfg.umbral ?? UMBRAL_DEFECTO.doc_vence;
        const limite = new Date(); limite.setUTCHours(limite.getUTCHours() - 5); limite.setDate(limite.getDate() + dias);
        const limiteISO = limite.toISOString().split("T")[0];
        const { data: conds } = await admin
          .from("conductores")
          .select("id, nombre, telefono, email, estado, vencimiento_licencia, sctr_salud_venc, sctr_pension_venc, examen_medico_venc, psicosometrico_venc, antecedentes_venc, vida_ley_venc, fecha_venc_contrato");
        const DOCS: [string, string][] = [
          ["vencimiento_licencia", "Licencia de conducir"], ["sctr_salud_venc", "SCTR Salud"],
          ["sctr_pension_venc", "SCTR Pensión"], ["examen_medico_venc", "Examen médico"],
          ["psicosometrico_venc", "Psicosométrico"], ["antecedentes_venc", "Antecedentes"],
          ["vida_ley_venc", "Vida Ley"], ["fecha_venc_contrato", "Contrato"],
        ];
        let n = 0;
        const cnlDoc = canalesConductor(cfg);
        // SCTR / Vida Ley: si el conductor está en una póliza de ese tipo, manda la PÓLIZA
        // (lib/seguros.ts, la regla de /seguros y de v_seguro_persona). Best-effort: sin las
        // tablas o con una lectura fallida, null → la ficha, exactamente como antes. La clave
        // de envío NO cambia (`${c.id}:${campo}`): cambiarla reenviaría WhatsApp ya pagados.
        const segPersona = await leerPolizasPersonas(admin);
        if (!segPersona) res.doc_vence_sin_polizas = 1;
        for (const c of (conds ?? []) as any[]) {
          // OJO: NO se descarta por falta de teléfono. Antes se filtraba aquí y un
          // conductor sin WhatsApp no recibía nada aunque tuviera correo — ahora decide
          // el fan-out, que sabe qué canales están habilitados y con qué datos cuenta.
          if (c.estado === "de_baja" || !cfg.plantilla) continue;
          for (const [campo, etiqueta] of DOCS) {
            const f = vencimientoFichaOPoliza({ clase: "conductor", id: Number(c.id) }, campo, c[campo],
              segPersona?.polizas ?? null, segPersona?.coberturas ?? null, fechaLima()).vencimiento;
            // null también para una inclusión PENDIENTE (pedida o por iniciar): no hay póliza que
            // venza ni la ficha la tapa → no se avisa «por vencer» de algo que aún no cubre.
            if (!f || f < hoy || f > limiteISO) continue; // vigente, ya vencido, o fuera de ventana
            if (!(await reclamarEnvio("doc_vence", `${c.id}:${campo}`))) continue;
            // Sin reservaId: este aviso no cuelga de ninguna reserva → no se loguea
            // en notificaciones_enviadas (igual que antes).
            const rr = await enviarAConductor({
              conductor: { id: c.id, nombre: c.nombre, telefono: c.telefono, email: c.email },
              plantilla: cfg.plantilla,
              parametros: [nombreCorto(c.nombre), etiqueta, f],
              canales: cnlDoc,
              titulo: `${etiqueta} por vencer (${f})`,
              trigger: "manual",
            });
            if (rr.estado === "enviado") n++;
            else if (rr.estado === "fallo") await liberarEnvio("doc_vence", `${c.id}:${campo}`); // transitorio → reintentar
            // sin_canal: queda reclamado para no reintentar en bucle.
          }
        }
        res.doc_vence = n;
      }
    }

    // ── BLOQUE 7: solape / jornada de conducción (hoy, respeta hora fija) ───────
    // Los dos se juzgan con la MISMA ventana por servicio (lib/alertas-flota.ts): lo real, si no el
    // itinerario de paraderos, y solo sin itinerario el bloque de 4 h. La jornada cuenta HORAS DE
    // CONDUCCIÓN (RENAT art. 30): el horario partido no es jornada extensa. El solape avisa solo lo
    // que AFIRMA (recorridos que se pisan, o un traslado que no da entre el último paradero de uno
    // y el primero del siguiente): antes cada servicio sin hora de fin «duraba» 4 h y una entrada y
    // su retorno salían como solape. La salida real, el itinerario y sus coordenadas no vienen en
    // `todas`: se leen aquí, solo de los servicios propios de hoy con conductor y solo si alguna de
    // las dos alertas está en ventana.
    {
      const cSol = activa("solape"), cJor = activa("jornada");
      const solOn = cSol && enVentanaHoraFija(cSol, ahora, force);
      const jorOn = cJor && enVentanaHoraFija(cJor, ahora, force);
      if (solOn || jorOn) {
        let hoyRes = todas.filter((r) => r.fecha_servicio === hoy && r.tipo_asignacion === "propio") as ReservaFlota[];
        // Sin el itinerario cada servicio contaría 4 h y el horario partido volvería a alarmar (las
        // dos alertas): si no se pudo leer, ESTE tick no juzga ninguna.
        const conItinerario = await itinerariosDeHoy(hoyRes.filter((r) => r.conductor_id && r.estado !== "cancelada").map((r) => r.id));
        const leido = !!conItinerario;
        // Un servicio EN CURSO lleva conduciendo al menos hasta ahora, vaya o no atrasado.
        if (conItinerario) hoyRes = hoyRes.map((r) => ({
          ...r, ...conItinerario.get(r.id),
          en_curso_ahora: r.estado === "en_curso" ? minutosAHhmm(ahora) : null,
        }));
        else res.flota_sin_itinerario = 1;
        const acumuladaMaxH = cJor?.umbral ?? UMBRAL_DEFECTO.jornada;
        const { solape, solapes, jornada, veredictos } = detectarSolapesJornada(hoyRes, { acumuladaMaxH });
        let nS = 0, nJ = 0;
        if (solOn && leido) {
          for (const [reservaId, condId] of solape) {
            if (!(await reclamarEnvio("solape", reservaId))) continue;
            // El detalle lo redacta el motor (una línea por choque): va el primero.
            const detalle = solapes.get(reservaId)?.detalle[0] ?? "Tiene servicios que no se pueden hacer seguidos.";
            const rd = await aDirectorio(cSol!, ["Solape de conductor", nombreCorto(condMap.get(condId)?.nombre), `Reserva #${reservaId}`, detalle]);
            if (rd.enviados === 0 && rd.fallos > 0) { await liberarEnvio("solape", reservaId); continue; }
            nS++;
          }
        }
        if (jorOn && leido) {
          const yaCond = new Set<number>();
          for (const [, condId] of jornada) {
            if (yaCond.has(condId)) continue; yaCond.add(condId);
            if (!(await reclamarEnvio("jornada", condId))) continue;
            // El motivo lo redacta el motor (una línea, sin saltos: va como parámetro de plantilla).
            const motivo = veredictos.get(condId)?.motivo ?? "Pasa los topes de conducción del día.";
            const rd = await aDirectorio(cJor!, ["Jornada de conducción", nombreCorto(condMap.get(condId)?.nombre), "Servicios de hoy", motivo]);
            if (rd.enviados === 0 && rd.fallos > 0) { await liberarEnvio("jornada", condId); continue; }
            nJ++;
          }
        }
        res.solape = nS; res.jornada = nJ;
      }
    }

    // ── BLOQUE 7: cerrar servicios ABANDONADOS ─────────────────────────────────
    // Una reserva pasa a "en_curso" cuando el conductor inicia, y solo vuelve a
    // "finalizada" cuando él la cierra. Si no la cierra (batería, app cerrada,
    // olvido) queda "en_curso" para siempre y NADIE se entera: los bloques de
    // arriba solo miran hoy/mañana, así que al día siguiente se vuelve invisible.
    // La app del pasajero sí la seguía viendo: elegía el servicio vigente más
    // antiguo y se quedaba anclada ahí, mostrando la posición GPS de aquel día
    // ("GPS sin señal, hace 9441 min") mientras el operador veía el bus real.
    // Este bloque corre SIEMPRE (no depende de una fila de config): es una
    // salvaguarda de integridad, no una alerta.
    //
    // EL AVISO, EN CAMBIO, RESPETA EL HORARIO DE SU TARJETA (lib/servicio-abandonado.ts). El
    // umbral se cruza a cualquier hora y el aviso despertaba al coordinador de madrugada. El
    // cierre deja un MARCADOR en alerta_enviada y el WhatsApp sale desde los marcadores, dentro
    // del horario y en un solo mensaje: una vez cerrado, el servicio ya no es «en curso» y
    // ningún tick lo volvería a encontrar.
    {
      const cfgAb = activa("servicio_abandonado");
      // 30 h por defecto: cubre full day de 24 h y nocturnos.
      const horasMax = cfgAb?.umbral ?? UMBRAL_DEFECTO.servicio_abandonado;
      const { data: colgadas } = await admin
        .from("reservas")
        .select("id, fecha_servicio, hora_servicio")
        .eq("estado", "en_curso")
        .lt("fecha_servicio", hoy);

      const abandonadas = (colgadas ?? []).filter((r: any) => {
        const inicioMs = limaAUtcMs(r.fecha_servicio, horaCorta(r.hora_servicio));
        // Sin hora utilizable: la fecha ya es anterior a hoy → se cierra igual.
        if (!inicioMs) return true;
        return (ahoraMs - inicioMs) / 3600000 > horasMax;
      });

      let nAb = 0;
      if (abandonadas.length) {
        const { data: cerradas, error: errCierre } = await admin
          .from("reservas")
          .update({ estado: "finalizada" })
          .in("id", abandonadas.map((r: any) => r.id))
          .eq("estado", "en_curso") // no pisar un cambio hecho entre el SELECT y el UPDATE
          .select("id");
        if (!errCierre) {
          nAb = (cerradas ?? []).length;
          // Solo con la tarjeta activa queda un aviso pendiente; el cierre ya ocurrió.
          if (cfgAb && nAb) {
            const { error: eEspera } = await admin.from("alerta_enviada").upsert(
              ((cerradas ?? []) as { id: number }[]).map((r) => ({ clave: CLAVE_ESPERA_ABANDONADO, ref: String(r.id), fecha: hoy })),
              { onConflict: "clave,ref,fecha", ignoreDuplicates: true },
            );
            // Sin marcador no hay aviso: se publica para que «¿por qué no me avisó?» tenga respuesta.
            if (eEspera) {
              console.error("[alertas-flota/tick] no se pudo dejar el aviso de servicio abandonado en espera:", eEspera.message);
              res.servicio_abandonado_sin_aviso = nAb;
            }
          }
        } else {
          console.error("[alertas-flota/tick] no se pudieron cerrar servicios abandonados:", errCierre.message);
        }
      }
      res.servicios_abandonados_cerrados = nAb;

      // ── El aviso: desde los marcadores, en cada tick, haya cerrado algo ahora o no ──
      const { data: marcas, error: eMarcas } = await admin
        .from("alerta_enviada")
        .select("ref, fecha, created_at")
        .eq("clave", CLAVE_ESPERA_ABANDONADO)
        .limit(500);
      type Marca = { ref: string | number; fecha: string; created_at: string | null };
      const lista = (marcas ?? []) as Marca[];
      if (eMarcas) console.error("[alertas-flota/tick] no se pudieron leer los avisos de servicio abandonado en espera:", eMarcas.message);
      else if (lista.length) {
        const plan = planDePendientes({
          ahoraMs, activa: !!cfgAb, horario: horarioDe(cfgAb ?? {}),
          pendientes: lista.map((m) => ({ ref: String(m.ref), fecha: String(m.fecha) })),
        });
        const cerradoMs = new Map<string, number>();
        for (const m of lista) {
          const t = Date.parse(String(m.created_at ?? ""));
          if (Number.isFinite(t)) cerradoMs.set(String(m.ref), t);
        }
        const borrar = new Set<string>(plan.descartar.map((d) => d.p.ref));

        if (cfgAb && plan.enviar.length) {
          // El reclamo de siempre, con la fecha del CIERRE: idempotente por servicio aunque el
          // aviso salga al día siguiente, y compatible con lo que ya quedó reclamado antes.
          const reclamados: { ref: string; fecha: string }[] = [];
          for (const p of plan.enviar) {
            if (await reclamarEnvio("servicio_abandonado", p.ref, p.fecha)) reclamados.push(p);
            else borrar.add(p.ref); // ya lo mandó otro tick
          }
          if (reclamados.length) {
            const ids = reclamados.map((p) => Number(p.ref)).filter(Number.isFinite);
            type FilaAb = {
              id: number; fecha_servicio: string; hora_servicio: string | null;
              conductor_id: number | null; conductor_tercero_id: number | null; origen: string | null; destino: string | null;
            };
            const { data: filasData, error: eFilas } = await admin
              .from("reservas")
              .select("id, fecha_servicio, hora_servicio, conductor_id, conductor_tercero_id, origen, destino")
              .in("id", ids);
            // Una lectura fallida no es «la reserva ya no existe»: se suelta el reclamo, el
            // marcador se queda y el próximo tick lo intenta otra vez.
            if (eFilas) {
              console.error("[alertas-flota/tick] no se pudieron leer los servicios abandonados a avisar:", eFilas.message);
              for (const p of reclamados) await liberarEnvio("servicio_abandonado", p.ref, p.fecha);
            }
            const filas = (eFilas ? [] : (filasData ?? [])) as FilaAb[];
            const porId = new Map<number, FilaAb>(filas.map((r) => [r.id, r]));
            // Los conductores de estos servicios no están en condMap/terMap (son de días
            // anteriores): se leen aquí, cada id en su tabla.
            const nomP = new Map<number, string>(), nomT = new Map<number, string>();
            const idsP = [...new Set(filas.map((r) => r.conductor_id).filter((x): x is number => x != null))];
            const idsT = [...new Set(filas.map((r) => r.conductor_tercero_id).filter((x): x is number => x != null))];
            if (idsP.length) for (const c of (await admin.from("conductores").select("id, nombre").in("id", idsP)).data ?? []) nomP.set(c.id, c.nombre);
            if (idsT.length) for (const c of (await admin.from("conductores_tercero").select("id, nombre").in("id", idsT)).data ?? []) nomT.set(c.id, c.nombre);

            const items: ServicioCerrado[] = [];
            for (const p of eFilas ? [] : reclamados) {
              const r = porId.get(Number(p.ref));
              if (!r) { borrar.add(p.ref); continue; } // la reserva ya no existe
              items.push({
                fecha: r.fecha_servicio,
                hora: r.hora_servicio ? horaCorta(r.hora_servicio) : null,
                conductor: nombreCorto(r.conductor_id ? nomP.get(r.conductor_id) : r.conductor_tercero_id ? nomT.get(r.conductor_tercero_id) : null),
                ruta: rutaDe(r),
                cerradoMs: cerradoMs.get(p.ref) ?? null,
              });
            }
            if (items.length) {
              const rd = await aDirectorio(cfgAb, paramsAvisoAbandonados(items, ahoraMs));
              if (rd.enviados === 0 && rd.fallos > 0) {
                // Transitorio: se suelta el reclamo y el marcador se queda — el próximo tick reintenta.
                for (const p of reclamados) await liberarEnvio("servicio_abandonado", p.ref, p.fecha);
              } else {
                // Salió, o no había a quién (sin contactos): no se reintenta en bucle.
                for (const p of reclamados) borrar.add(p.ref);
                res.servicio_abandonado_avisados = items.length;
              }
            }
          }
        }
        res.servicio_abandonado_en_espera = plan.esperan.length;
        if (borrar.size) {
          const { error: eBorrar } = await admin.from("alerta_enviada").delete()
            .eq("clave", CLAVE_ESPERA_ABANDONADO).in("ref", [...borrar]);
          if (eBorrar) console.error("[alertas-flota/tick] no se pudieron limpiar los avisos de servicio abandonado:", eBorrar.message);
        }
      }
    }

    // ── BLOQUE 8: las reservas de traslado que toma la IA del CRM ───────────────
    // Lo decide `lib/traslados/reserva-alertas.ts` (PURO) sobre lo que lee su lector:
    //  · «Reserva de traslado sin confirmar»: por confirmar o con pago reportado que pasó su plazo
    //    (+ umbral en min) o nació urgente; y un escalón más, una vez, si el servicio queda a menos de
    //    la mitad del margen de reserva (Ajustes de traslados) sin resolverse.
    //  · «Devolución de reserva pendiente»: lo devuelto sigue por debajo de lo acordado `umbral` h
    //    después de acordarlo (la cuenta de `queFalta`).
    //  · Y SIEMPRE, con la tarjeta encendida o no (como el cierre de servicios abandonados): una
    //    solicitud «esperando pago» SIN dinero en juego cuya cotización venció o cuyo servicio pasó
    //    se cierra como vencida. No le escribe al cliente.
    // El reclamo lleva la FECHA EN QUE NACIÓ la solicitud, no la de hoy: con la de hoy el mismo aviso
    // saldría cada día. Sin contactos marcados no se reclama nada: al marcarlos, sale. Sin la tabla
    // (reservas-09a no corrida) el bloque no hace nada; cualquier otro error se publica y el tick
    // termina igual.
    {
      const cSin = activa(CLAVE_SIN_CONFIRMAR), cDev = activa(CLAVE_DEVOLUCION);
      try {
        const lect = await leerHechosAlertasReserva(admin, { ahoraMs, sinConfirmar: !!cSin, devolucion: !!cDev });
        if (lect.sinTabla) res.reserva_sin_tabla = 1;
        else {
          if (lect.avisos.length) {
            console.warn("[alertas-flota/tick] reservas de traslado, lectura incompleta:", lect.avisos.join(" · "));
            res.reserva_lectura_incompleta = lect.avisos.length;
          }
          const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? null;
          type Envio = "enviado" | "ya_enviado" | "sin_contactos" | "fallo";
          const avisarReserva = async (cfg: AlertaConfig, clave: string, refs: string[], fecha: string, params: string[]): Promise<Envio> => {
            if (!directorioDe(cfg, destinatarios).length) return "sin_contactos";
            if (!(await reclamarEnvio(clave, refs[0], fecha))) return "ya_enviado";
            const extra: string[] = [];
            for (const r of refs.slice(1)) if (await reclamarEnvio(clave, r, fecha)) extra.push(r);
            const rd = await aDirectorio(cfg, params);
            if (rd.enviados === 0 && rd.fallos > 0) {        // transitorio → se suelta todo y se reintenta
              for (const r of [refs[0], ...extra]) await liberarEnvio(clave, r, fecha);
              return "fallo";
            }
            return "enviado";
          };

          if (cSin) {
            // M (minutos de margen antes del servicio) de Ajustes de traslados; sin la fila o sin la
            // columna, el defecto del motor de la reserva.
            const { data: tc } = await admin.from("traslados_config").select("*").eq("id", 1).maybeSingle();
            const margenMin = plazosDe(normalizarConfigReserva(tc as Record<string, unknown> | null)).M;
            const umbralMin = cSin.umbral ?? UMBRAL_DEFECTO.reserva_sin_confirmar;
            let encontradas = 0, enviadas = 0, sinContactos = 0;
            for (const h of lect.hechos) {
              const d = juzgarSinConfirmar(h, { ahoraMs, umbralMin, margenMin });
              if (!d.ref) continue;
              encontradas++;
              const r = await avisarReserva(cSin, CLAVE_SIN_CONFIRMAR, [d.ref, ...d.refsExtra], fechaReclamo(h.solicitud, hoy),
                paramsSinConfirmar(h, d, { ahoraMs, appUrl }));
              if (r === "enviado") enviadas++; else if (r === "sin_contactos") sinContactos++;
            }
            res.reserva_sin_confirmar_encontradas = encontradas;
            res.reserva_sin_confirmar = enviadas;
            if (sinContactos) res.reserva_sin_confirmar_sin_contactos = sinContactos;
          }

          if (cDev) {
            const umbralH = cDev.umbral ?? UMBRAL_DEFECTO.devolucion_pendiente;
            let encontradas = 0, enviadas = 0, sinContactos = 0, sinLectura = 0;
            for (const h of lect.hechos) {
              const d = juzgarDevolucion(h, { ahoraMs, umbralH });
              if (d.codigo === "sin_lectura") { sinLectura++; continue; }
              if (!d.ref) continue;
              encontradas++;
              const r = await avisarReserva(cDev, CLAVE_DEVOLUCION, [d.ref], fechaReclamo(h.solicitud, hoy),
                paramsDevolucion(h, d, { ahoraMs, appUrl }));
              if (r === "enviado") enviadas++; else if (r === "sin_contactos") sinContactos++;
            }
            res.devolucion_pendiente_encontradas = encontradas;
            res.devolucion_pendiente = enviadas;
            if (sinContactos) res.devolucion_pendiente_sin_contactos = sinContactos;
            if (sinLectura) res.devolucion_pendiente_sin_lectura = sinLectura;
          }

          // El auto-vencimiento: corre siempre.
          let vencidas = 0, cerradas = 0, conDinero = 0, conReserva = 0;
          const ahoraIso = new Date(ahoraMs).toISOString();
          for (const h of lect.hechos) {
            const v = juzgarVencimiento(h, { ahoraMs, hoy });
            // Vencida pero con un pago, un comprobante o una reserva: la resuelve una persona.
            if (v.codigo === "con_dinero") { conDinero++; continue; }
            if (v.codigo === "con_reserva") { conReserva++; continue; }
            if (v.codigo !== "vencer") continue;
            vencidas++;
            const nota = notaVencida(h, v.motivos);
            try {
              if (await cerrarSolicitudVencida(admin, { solicitud: h.solicitud, nota, notaSolicitud: notaConCierre(h.solicitud.nota, nota), ahoraIso })) cerradas++;
            } catch (e) {
              console.error("[alertas-flota/tick]", e instanceof Error ? e.message : String(e));
            }
          }
          res.reserva_vencidas_encontradas = vencidas;
          res.reserva_vencidas_cerradas = cerradas;
          if (conDinero) res.reserva_vencidas_con_dinero = conDinero;
          if (conReserva) res.reserva_vencidas_con_reserva = conReserva;

          // Y el comprobante del cargo de las cancelaciones con devolución parcial, al día con el dinero:
          // un cobro anulado en Finanzas no pasa por la tarjeta (mientras no tenga número se recalcula;
          // uno emitido no se toca y la tarjeta pide la nota de crédito).
          const cargos = await sincronizarCargosDeCancelaciones(admin, { ahoraMs: () => ahoraMs });
          if (cargos.miradas) res.reserva_cargos_mirados = cargos.miradas;
          if (cargos.cambiadas) res.reserva_cargos_al_dia = cargos.cambiadas;
          if (cargos.avisos.length) {
            console.warn("[alertas-flota/tick] cargo de cancelación:", cargos.avisos.join(" · "));
            res.reserva_cargos_con_aviso = cargos.avisos.length;
          }
        }
      } catch (e) {
        // Un extra: si falla, el resto del tick ya corrió y su respuesta lo dice.
        console.error("[alertas-flota/tick] reservas de traslado:", e instanceof Error ? e.message : String(e));
        res.reserva_error = 1;
      }
    }

    return NextResponse.json({ ok: true, hoy, ahora, force, resultados: res });
  } catch (error: any) {
    console.error("[alertas-flota/tick]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Los dos predicados de abajo viven en `lib/alertas-modo-tiempo.ts` (módulo PURO) y aquí
// solo se adaptan a la forma que usan los bloques. No es ceremonia: el panel tiene que
// avisar cuando el modo elegido no es uno de los que estos predicados saben ejecutar
// —`evento` en un recordatorio no envía NUNCA; un modo que no sea `hora_fija` en un barrido
// diario lo deja SIN ventana y sale a las 00:0x—, y un guard que mirara su propia copia de
// esa tabla sería el bug del semáforo de puntualidad, con el agravante de que el que
// mentiría es justo el que existe para no mentir.

/** ¿Estamos en la ventana de disparo del recordatorio? Piso amplio + dedupe = "una vez, sin perder". */
function enViaRecordatorio(
  cfg: AlertaConfig, r: any, hoy: string, manana: string, ahora: number, force: boolean,
): boolean {
  return enViaRecordatorioPuro({
    modo_tiempo: cfg.modo_tiempo, hora_fija: cfg.hora_fija, min_anticipacion: cfg.min_anticipacion,
    fechaServicio: r.fecha_servicio, horaServicio: r.hora_servicio,
    hoy, manana, ahoraMin: ahora, ahoraMs: Date.now(), force,
  });
}

/** Ventana para alertas de hora fija (docs/solape/jornada). Modos no-hora-fija: sin ventana. */
function enVentanaHoraFija(cfg: AlertaConfig, ahora: number, force: boolean): boolean {
  return enVentanaHoraFijaPuro({
    modo_tiempo: cfg.modo_tiempo, hora_fija: cfg.hora_fija, ahoraMin: ahora, force,
  });
}
