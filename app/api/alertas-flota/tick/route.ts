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
import { enviarAvisoWhatsApp, enviarAConductor, notificarReserva, notificarConductor } from "@/lib/notificaciones";
import {
  cargarMotor, directorioDe, reclamarEnvio, liberarEnvio, cargarEstados, upsertEstado,
  hoyLima, ahoraLimaMin, hhmmAMin, telefonoContingencia, canalesConductor, type AlertaConfig,
} from "@/lib/alertas";
import { detectarSolapesJornada, type ReservaFlota } from "@/lib/alertas-flota";

export const maxDuration = 60;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Ventana generosa para modo hora_fija: tolera ticks caídos (un hueco no pierde el día).
// El dedupe garantiza "una sola vez", así que ampliar la ventana solo permite recuperar.
const VENTANA_HORA_FIJA = 120;

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
    const telConting = await telefonoContingencia();
    const res: Record<string, number> = {};

    const { data: reservas } = await admin
      .from("reservas")
      .select("id, fecha_servicio, hora_servicio, hora_real_fin, estado, conductor_id, conductor_tercero_id, vehiculo_id, vehiculo_tercero_id, tipo_asignacion, origen, destino")
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
      extra?: { titulo?: string; reservaId?: number },
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
          if (r.estado === "cancelada") {
            if (cCanc && ref && refPrev && !est?.cancelacion_avisada) {
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
          const tieneTel = !!datosCond(ref)?.telefono;
          if (!mismoCond) {
            // Reasignación: avisar al conductor SALIENTE que ya no cubre el servicio.
            if (cDes && refPrev) {
              const ant = nombreCorto(datosCond(refPrev)?.nombre);
              await aConductor(cDes, refPrev, [ant, fecha, ruta]);
            }
            if (cAsig && avisaA(cAsig, ref)) {
              // notificarConductor arma los datos ricos (origen/destino/dirección + botón de mapa).
              // Sin teléfono aún → no llamar (evita log-spam); avanzar=false reintenta cuando lo tenga.
              if (!tieneTel) { avanzar = false; }
              else {
                const rc = await notificarConductor(r.id, "asignacion", cAsig.plantilla ?? undefined, canalesConductor(cAsig));
                avanzar = rc.estado === "enviado";
                if (avanzar) n++;
              }
            }
          } else if (est!.hora_avisada !== hora || est!.vehiculo_avisado !== (r.vehiculo_id ?? null)) {
            if (cCamb && avisaA(cCamb, ref)) {
              if (!tieneTel) { avanzar = false; }
              else {
                const rc = await notificarConductor(r.id, "cambio", cCamb.plantilla ?? undefined, canalesConductor(cCamb));
                avanzar = rc.estado === "enviado";
                if (avanzar) n++;
              }
            }
          }
          if (avanzar) {
            await upsertEstado(r.id, {
              conductor_avisado: ref.id,
              conductor_tabla_avisada: ref.tabla,
              vehiculo_avisado: r.vehiculo_id ?? null,
              hora_avisada: hora,
            });
          }
        }
        res.ciclo_vida = n;
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
        const nombre = nombreCorto(condMap.get(r.conductor_id)?.nombre);
        const hora = horaCorta(r.hora_servicio);
        const origenTexto = r.origen || rutaDe(r);
        const rc = await aConductor(cfg, r.conductor_id, [nombre, hora, origenTexto]);
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
        let n = 0;
        for (const r of todas) {
          if (r.tipo_asignacion !== "propio" || !r.conductor_id) continue;
          if (!["programada", "confirmada"].includes(r.estado)) continue;
          if (!enViaRecordatorio(cfg, r, hoy, manana, ahora, force)) continue;
          if (!(await reclamarEnvio("llamar_conductor", r.id))) continue;
          const nombreCond = nombreCorto(condMap.get(r.conductor_id)?.nombre);
          const hora = horaCorta(r.hora_servicio);
          const ruta = rutaDe(r);
          const rd = await aDirectorioPersonalizado(cfg, [nombreCond, ruta, hora]);
          if (rd.enviados > 0) n++;
          else if (rd.fallos > 0) await liberarEnvio("llamar_conductor", r.id); // transitorio → reintentar
        }
        res.llamar_conductor = n;
      }
    }

    // ── BLOQUE 3c: alerta PREVIA al Coordinador (antes de la hora) — el conductor ya
    //    recibió 2 recordatorios (90/30 min) y sigue sin iniciar el recorrido en la
    //    app (sin GPS, sin confirmar salida). A diferencia de "no_inicio" (que dispara
    //    DESPUÉS de la hora), esta es la escalada PREVENTIVA para que Operaciones
    //    pueda llamarlo antes de que el servicio arranque tarde. Reusa la plantilla
    //    genérica `coordinador_alerta` — no requiere aprobar una plantilla nueva.
    {
      const cfg = activa("alerta_no_inicio_previa");
      if (cfg) {
        let n = 0;
        for (const r of todas) {
          if (r.tipo_asignacion !== "propio" || !r.conductor_id) continue;
          if (!["programada", "confirmada"].includes(r.estado)) continue; // sin GPS ni salida confirmada
          if (!enViaRecordatorio(cfg, r, hoy, manana, ahora, force)) continue;
          if (!(await reclamarEnvio("alerta_no_inicio_previa", r.id))) continue;
          const nombre = nombreCorto(condMap.get(r.conductor_id)?.nombre);
          const hora = horaCorta(r.hora_servicio);
          const ruta = rutaDe(r);
          const rd = await aDirectorio(cfg, ["Falta iniciar recorrido", nombre, `${ruta} ${hora}`, "Faltan ~25 min y el conductor aún no confirma salida (sin GPS) en la app."]);
          if (rd.enviados > 0) n++;
          else if (rd.fallos > 0) await liberarEnvio("alerta_no_inicio_previa", r.id); // transitorio → reintentar
        }
        res.alerta_no_inicio_previa = n;
      }
    }

    // ── BLOQUE 4: no inició a tiempo ────────────────────────────────────────────
    {
      const cfg = activa("no_inicio");
      if (cfg) {
        const gracia = cfg.umbral ?? 10;
        let n = 0;
        for (const r of todas) {
          if (r.fecha_servicio !== hoy) continue;
          if (!["programada", "confirmada"].includes(r.estado)) continue; // aún no inició
          const ini = hhmmAMin(r.hora_servicio);
          if (ini == null || ahora < ini + gracia) continue;
          if (!(await reclamarEnvio("no_inicio", r.id))) continue;
          const ruta = rutaDe(r); const hora = horaCorta(r.hora_servicio);
          const nombre = r.conductor_id ? nombreCorto(condMap.get(r.conductor_id)?.nombre) : "Conductor";
          let exitos = 0, fallos = 0;
          if (cfg.notifica_conductor && r.conductor_id) {
            const rc = await aConductor(cfg, r.conductor_id, [nombre, hora, ruta, telConting]);
            if (rc === "enviado") exitos++; else if (rc === "fallo") fallos++;
          }
          const rd = await aDirectorio(cfg, ["No inició a tiempo", nombre, `${ruta} ${hora}`, `Pasaron ${gracia}+ min de la hora y no marcó inicio.`]);
          exitos += rd.enviados; fallos += rd.fallos;
          if (exitos === 0 && fallos > 0) { await liberarEnvio("no_inicio", r.id); continue; } // transitorio → reintentar
          n++;
        }
        res.no_inicio = n;
      }
    }

    // ── BLOQUE 5: GPS sin señal (reservas en curso) ─────────────────────────────
    {
      const cfg = activa("gps_silencio");
      if (cfg) {
        const silencioMin = cfg.umbral ?? 8;
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

    // ── BLOQUE 5b: recordar CHECK-OUT de jornada ────────────────────────────────
    // Cuando un conductor TERMINÓ todos sus servicios de hoy (todas finalizada) pero aún NO
    // registró su check-out (no hay fila en checkout_conductor del día). Se repite cada HORA
    // (dedupe por bucket horario) hasta que lo complete; al registrar el check-out deja de
    // matchear y el recordatorio para solo.
    {
      const cfg = activa("recordar_checkout");
      if (cfg && cfg.notifica_conductor) {
        const graciaMin = cfg.umbral ?? 60; // min tras el último servicio antes de empezar a recordar
        const hoyRes = todas.filter((r) => r.fecha_servicio === hoy && r.conductor_id);
        const porConductor = new Map<number, any[]>();
        for (const r of hoyRes) {
          if (!porConductor.has(r.conductor_id)) porConductor.set(r.conductor_id, []);
          porConductor.get(r.conductor_id)!.push(r);
        }
        // ¿Quién ya hizo check-out hoy? (query aparte → si la tabla nueva no existe, set vacío)
        const { data: cos } = await admin.from("checkout_conductor").select("conductor_id").eq("fecha", hoy);
        const yaCheckout = new Set<number>((cos ?? []).map((c: any) => Number(c.conductor_id)));
        const horaBucket = `${hoy.replace(/-/g, "")}-${String(Math.floor(ahora / 60)).padStart(2, "0")}`; // YYYYMMDD-HH (Lima)
        const hoyBonito = `${hoy.slice(8, 10)}/${hoy.slice(5, 7)}`; // "20/07" — legible en el mensaje (hoy sigue en ISO para las queries de arriba)
        let n = 0;
        for (const [cid, servicios] of porConductor) {
          if (yaCheckout.has(cid)) continue;                       // ya cerró la jornada
          if (!servicios.every((s) => s.estado === "finalizada")) continue; // aún tiene servicios abiertos
          const tiempos = servicios
            .map((s) => limaAUtcMs(s.fecha_servicio, horaCorta(s.hora_real_fin ?? s.hora_servicio)))
            .filter((t): t is number => Number.isFinite(t as any) && (t as number) > 0);
          const finMs = tiempos.length ? Math.max(...tiempos) : 0;
          if (finMs > 0 && (Date.now() - finMs) / 60000 < graciaMin) continue; // aún dentro de la gracia
          // Cadencia HORARIA: el bucket en el ref hace que cada hora sea un envío nuevo.
          if (!(await reclamarEnvio("recordar_checkout", `${cid}:${horaBucket}`))) continue;
          const rc = await aConductor(cfg, cid, [nombreCorto(condMap.get(cid)?.nombre), hoyBonito]);
          if (rc === "fallo") { await liberarEnvio("recordar_checkout", `${cid}:${horaBucket}`); continue; } // transitorio → reintentar
          if (rc === "enviado") n++;
          // sin_canal (sin teléfono/plantilla): se deja reclamado para no reintentar en bucle.
        }
        res.recordar_checkout = n;
      }
    }

    // ── BLOQUE 6: documentos del conductor por vencer (respeta hora fija) ───────
    {
      const cfg = activa("doc_vence");
      if (cfg && enVentanaHoraFija(cfg, ahora, force)) {
        const dias = cfg.umbral ?? 15;
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
        for (const c of (conds ?? []) as any[]) {
          // OJO: NO se descarta por falta de teléfono. Antes se filtraba aquí y un
          // conductor sin WhatsApp no recibía nada aunque tuviera correo — ahora decide
          // el fan-out, que sabe qué canales están habilitados y con qué datos cuenta.
          if (c.estado === "de_baja" || !cfg.plantilla) continue;
          for (const [campo, etiqueta] of DOCS) {
            const f = c[campo];
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

    // ── BLOQUE 7: solape / jornada extensa (hoy, respeta hora fija) ─────────────
    {
      const cSol = activa("solape"), cJor = activa("jornada");
      const solOn = cSol && enVentanaHoraFija(cSol, ahora, force);
      const jorOn = cJor && enVentanaHoraFija(cJor, ahora, force);
      if (solOn || jorOn) {
        const hoyRes = todas.filter((r) => r.fecha_servicio === hoy && r.tipo_asignacion === "propio") as ReservaFlota[];
        const jornadaMaxH = cJor?.umbral ?? 13;
        const { solape, jornada } = detectarSolapesJornada(hoyRes, { jornadaMaxH, maxServicios: 4 });
        let nS = 0, nJ = 0;
        if (solOn) {
          for (const [reservaId, condId] of solape) {
            if (!(await reclamarEnvio("solape", reservaId))) continue;
            const rd = await aDirectorio(cSol!, ["Solape de conductor", nombreCorto(condMap.get(condId)?.nombre), `Reserva #${reservaId}`, "Tiene servicios que se cruzan en horario."]);
            if (rd.enviados === 0 && rd.fallos > 0) { await liberarEnvio("solape", reservaId); continue; }
            nS++;
          }
        }
        if (jorOn) {
          const yaCond = new Set<number>();
          for (const [, condId] of jornada) {
            if (yaCond.has(condId)) continue; yaCond.add(condId);
            if (!(await reclamarEnvio("jornada", condId))) continue;
            const rd = await aDirectorio(cJor!, ["Jornada extensa", nombreCorto(condMap.get(condId)?.nombre), "Servicios de hoy", "Supera la jornada máxima o el nº de servicios."]);
            if (rd.enviados === 0 && rd.fallos > 0) { await liberarEnvio("jornada", condId); continue; }
            nJ++;
          }
        }
        res.solape = nS; res.jornada = nJ;
      }
    }

    return NextResponse.json({ ok: true, hoy, ahora, force, resultados: res });
  } catch (error: any) {
    console.error("[alertas-flota/tick]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/** "YYYY-MM-DD" + "HH:MM" en hora Lima (UTC-5 fijo, sin horario de verano) → ms UTC absolutos. */
function limaAUtcMs(fecha?: string | null, horaHHMM?: string | null): number | null {
  if (!fecha) return null;
  const [y, m, d] = fecha.split("-").map(Number);
  const [hh, mm] = (horaHHMM || "00:00").split(":").map(Number);
  if (!y || !m || !d || !Number.isFinite(hh)) return null;
  return Date.UTC(y, m - 1, d, hh + 5, mm || 0);
}

/** ¿Estamos en la ventana de disparo del recordatorio? Piso amplio + dedupe = "una vez, sin perder". */
function enViaRecordatorio(
  cfg: AlertaConfig, r: any, hoy: string, manana: string, ahora: number, force: boolean,
): boolean {
  if (force) return true;
  if (cfg.modo_tiempo === "hora_fija") {
    if (r.fecha_servicio !== manana) return false; // hora fija → recuerda los de MAÑANA
    const hf = hhmmAMin(cfg.hora_fija) ?? 480;
    return ahora >= hf && ahora < hf + VENTANA_HORA_FIJA;
  }
  if (cfg.modo_tiempo === "anticipacion") {
    // Fecha absoluta (no solo "minutos del día de hoy"): una anticipación de varias
    // horas sobre un servicio de MAÑANA temprano dispara HOY en la noche — cruza la
    // medianoche, y comparar solo r.fecha_servicio===hoy lo perdía por completo.
    if (r.fecha_servicio !== hoy && r.fecha_servicio !== manana) return false;
    const inicioMs = limaAUtcMs(r.fecha_servicio, r.hora_servicio);
    if (inicioMs == null) return false;
    const disparoMs = inicioMs - (cfg.min_anticipacion ?? 90) * 60_000;
    const nowMs = Date.now();
    return nowMs >= disparoMs && nowMs < inicioMs; // desde X min antes hasta la hora de inicio
  }
  return false;
}

/** Ventana para alertas de hora fija (docs/solape/jornada). Modos no-hora-fija: sin ventana. */
function enVentanaHoraFija(cfg: AlertaConfig, ahora: number, force: boolean): boolean {
  if (force) return true;
  if (cfg.modo_tiempo !== "hora_fija") return true;
  const hf = hhmmAMin(cfg.hora_fija);
  if (hf == null) return true;
  return ahora >= hf && ahora < hf + VENTANA_HORA_FIJA;
}
