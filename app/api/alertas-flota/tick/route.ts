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
import { enviarAvisoWhatsApp, notificarReserva, notificarConductor } from "@/lib/notificaciones";
import {
  cargarMotor, directorioDe, reclamarEnvio, liberarEnvio, cargarEstados, upsertEstado,
  hoyLima, ahoraLimaMin, hhmmAMin, telefonoContingencia, type AlertaConfig,
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
      .select("id, fecha_servicio, hora_servicio, hora_real_fin, estado, conductor_id, vehiculo_id, vehiculo_tercero_id, tipo_asignacion, origen, destino")
      .in("fecha_servicio", [hoy, manana]);
    const todas = (reservas ?? []) as any[];

    // Estados de ciclo de vida (para el diff + para saber el conductor SALIENTE al reasignar).
    const propias = todas.filter((r) => r.tipo_asignacion === "propio");
    const estados = await cargarEstados(propias.map((r) => r.id));

    // Mapa de conductores: los de las reservas actuales + los "avisados" previos (salientes).
    const condIds = new Set<number>();
    for (const r of todas) if (r.conductor_id) condIds.add(r.conductor_id);
    for (const e of estados.values()) if (e.conductor_avisado) condIds.add(e.conductor_avisado);
    const condMap = new Map<number, { nombre: string; telefono: string | null }>();
    if (condIds.size) {
      const { data } = await admin.from("conductores").select("id, nombre, telefono").in("id", [...condIds]);
      for (const c of data ?? []) condMap.set(c.id, { nombre: c.nombre, telefono: c.telefono });
    }
    // ── Helpers de envío (tri-estado: distingue "sin canal" de "fallo transitorio") ──
    async function aConductor(cfg: AlertaConfig, conductorId: number, params: string[]): Promise<ResultadoEnvio> {
      const c = condMap.get(conductorId);
      if (!c?.telefono || !cfg.plantilla) return "sin_canal";
      const r = await enviarAvisoWhatsApp(c.telefono, cfg.plantilla, params);
      return r.ok ? "enviado" : "fallo";
    }
    async function aDirectorio(cfg: AlertaConfig, params: string[]): Promise<{ enviados: number; fallos: number }> {
      let enviados = 0, fallos = 0;
      for (const d of directorioDe(cfg, destinatarios)) {
        const r = await enviarAvisoWhatsApp(d.telefono, cfg.plantilla_directorio || "coordinador_alerta", params);
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
        for (const r of propias) {
          const est = estados.get(r.id);
          const fecha = r.fecha_servicio; const hora = horaCorta(r.hora_servicio);
          const ruta = rutaDe(r);

          // Cancelación: avisar al conductor asignado. Solo marcar si el envío salió.
          if (r.estado === "cancelada") {
            if (cCanc && r.conductor_id && est?.conductor_avisado && !est?.cancelacion_avisada) {
              const nombre = nombreCorto(condMap.get(r.conductor_id)?.nombre);
              if ((await aConductor(cCanc, r.conductor_id, [nombre, fecha, ruta])) === "enviado") {
                n++;
                await upsertEstado(r.id, { cancelacion_avisada: true });
              }
            }
            continue;
          }
          if (!r.conductor_id) continue;

          let avanzar = true; // por defecto graba baseline (config off o sin cambio) para no
                              // disparar un "cambio" espurio después.
          const tieneTel = !!condMap.get(r.conductor_id)?.telefono;
          if (!est || est.conductor_avisado !== r.conductor_id) {
            // Reasignación: avisar al conductor SALIENTE que ya no cubre el servicio.
            if (cDes && est?.conductor_avisado && est.conductor_avisado !== r.conductor_id) {
              const ant = nombreCorto(condMap.get(est.conductor_avisado)?.nombre);
              await aConductor(cDes, est.conductor_avisado, [ant, fecha, ruta]);
            }
            if (cAsig) {
              // notificarConductor arma los datos ricos (origen/destino/dirección + botón de mapa).
              // Sin teléfono aún → no llamar (evita log-spam); avanzar=false reintenta cuando lo tenga.
              if (!tieneTel) { avanzar = false; }
              else {
                const rc = await notificarConductor(r.id, "asignacion", cAsig.plantilla ?? undefined);
                avanzar = rc.estado === "enviado";
                if (avanzar) n++;
              }
            }
          } else if (est.hora_avisada !== hora || est.vehiculo_avisado !== (r.vehiculo_id ?? null)) {
            if (cCamb) {
              if (!tieneTel) { avanzar = false; }
              else {
                const rc = await notificarConductor(r.id, "cambio", cCamb.plantilla ?? undefined);
                avanzar = rc.estado === "enviado";
                if (avanzar) n++;
              }
            }
          }
          if (avanzar) {
            await upsertEstado(r.id, {
              conductor_avisado: r.conductor_id,
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
        if (r.tipo_asignacion !== "propio" || !r.conductor_id) continue;
        if (!["programada", "confirmada"].includes(r.estado)) continue;
        if (!enViaRecordatorio(cRecC, r, hoy, manana, ahora, force)) continue;
        if (!(await reclamarEnvio("recordatorio_conductor", r.id))) continue;
        try {
          const rc = await notificarConductor(r.id, "cron_recordatorio");
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
          const rr = await notificarReserva(r.id, "cron_recordatorio");
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
        if (r.tipo_asignacion !== "propio" || !r.conductor_id) continue;
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

    // ── BLOQUE 6: documentos del conductor por vencer (respeta hora fija) ───────
    {
      const cfg = activa("doc_vence");
      if (cfg && enVentanaHoraFija(cfg, ahora, force)) {
        const dias = cfg.umbral ?? 15;
        const limite = new Date(); limite.setUTCHours(limite.getUTCHours() - 5); limite.setDate(limite.getDate() + dias);
        const limiteISO = limite.toISOString().split("T")[0];
        const { data: conds } = await admin
          .from("conductores")
          .select("id, nombre, telefono, estado, vencimiento_licencia, sctr_salud_venc, sctr_pension_venc, examen_medico_venc, psicosometrico_venc, antecedentes_venc, vida_ley_venc, fecha_venc_contrato");
        const DOCS: [string, string][] = [
          ["vencimiento_licencia", "Licencia de conducir"], ["sctr_salud_venc", "SCTR Salud"],
          ["sctr_pension_venc", "SCTR Pensión"], ["examen_medico_venc", "Examen médico"],
          ["psicosometrico_venc", "Psicosométrico"], ["antecedentes_venc", "Antecedentes"],
          ["vida_ley_venc", "Vida Ley"], ["fecha_venc_contrato", "Contrato"],
        ];
        let n = 0;
        for (const c of (conds ?? []) as any[]) {
          if (c.estado === "de_baja" || !c.telefono || !cfg.plantilla) continue;
          for (const [campo, etiqueta] of DOCS) {
            const f = c[campo];
            if (!f || f < hoy || f > limiteISO) continue; // vigente, ya vencido, o fuera de ventana
            if (!(await reclamarEnvio("doc_vence", `${c.id}:${campo}`))) continue;
            const rr = await enviarAvisoWhatsApp(c.telefono, cfg.plantilla, [nombreCorto(c.nombre), etiqueta, f]);
            if (rr.ok) n++;
            else await liberarEnvio("doc_vence", `${c.id}:${campo}`); // transitorio → reintentar
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
