// app/api/alertas-flota/inicio/route.ts
// LA ESCALERA DE INICIO FINA: «Inicia ahora» (5 min antes) y «Ya debió iniciar» (1 min
// después), al conductor que todavía no pulsó INICIAR en el app. Cron de UN minuto.
//
// Vive aparte del tick (/api/alertas-flota/tick, cada 10 min) por una razón medida: con un
// disparo cada 10 min, una ventana de 5 min queda fuera de su disparo la mitad de las veces
// (scripts/prueba-escalera-inicio.mts, sección 1) y el aviso no sale nunca. Esta ruta es
// liviana a propósito: solo mira los servicios sin iniciar de ayer/hoy/mañana y solo envía
// lo que `lib/escalera-inicio.ts` dice que toca.
//
// Dedupe: `reclamarEnvio` (insert-once en alerta_enviada) con la FECHA DEL SERVICIO, para que
// un servicio de las 00:02 no se reclame dos veces al cruzar la medianoche. PRINCIPIO
// ANTI-PÉRDIDA del tick: un fallo transitorio libera el reclamo y el minuto siguiente
// reintenta; «sin canal» (sin teléfono ni suscripción) queda reclamado para no reintentar en
// bucle.
//
// LA LLAMADA (lib/llamadas-central.ts): si sigue sin iniciar a la hora + su umbral (3 min), la
// llamada se pone en COLA para la central propia (/api/llamadas/central); este cron no llama a
// nadie. Se reclama igual que un aviso, y aquí mismo se limpia la cola (vencidas, colgadas).
//
// Auth: Bearer CRON_SECRET (fail-closed).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { esCronAutorizado } from "@/lib/api-auth";
import { enviarAConductor } from "@/lib/notificaciones";
import { cargarMotor, reclamarEnvio, liberarEnvio, telefonoContingencia, canalesConductor, type AlertaConfig } from "@/lib/alertas";
import { fechaLima } from "@/lib/alertas-horario";
import {
  CLAVE_DEBIO_INICIAR, CLAVE_INICIA_AHORA, ESTADOS_SIN_INICIAR,
  minutosIniciaAhora, pasosQueTocan, textoPushInicio,
} from "@/lib/escalera-inicio";
import { CLAVE_LLAMADA, juzgarLlamada, venceLlamadaMs } from "@/lib/llamadas-central";
import { encolarLlamada, limpiarCola } from "@/lib/llamadas-central-datos";

export const maxDuration = 60;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const DIA_MS = 86_400_000;
const PAGINA = 1000;

type Tabla = "conductores" | "conductores_tercero";
type RefCond = { id: number; tabla: Tabla };
type DatosCond = { nombre: string; telefono: string | null; email: string | null };
type FilaReserva = {
  id: number; fecha_servicio: string; hora_servicio: string | null; estado: string;
  conductor_id: number | null; conductor_tercero_id: number | null;
  origen: string | null; destino: string | null;
};

function nombreCorto(n?: string | null): string {
  return (n || "").trim().split(/\s+/).slice(0, 2).join(" ") || "Conductor";
}
function horaCorta(h?: string | null): string { return h?.slice(0, 5) ?? "-"; }
function rutaDe(r: { origen?: string | null; destino?: string | null }): string {
  return [r.origen, r.destino].filter(Boolean).join(" → ") || "Servicio";
}
function condDe(r: FilaReserva): RefCond | null {
  if (r.conductor_id) return { id: r.conductor_id, tabla: "conductores" };
  if (r.conductor_tercero_id) return { id: r.conductor_tercero_id, tabla: "conductores_tercero" };
  return null;
}

export async function GET(req: NextRequest) { return handler(req); }
export async function POST(req: NextRequest) { return handler(req); }

async function handler(req: NextRequest) {
  if (!esCronAutorizado(req)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  try {
    const { configs } = await cargarMotor();
    const cfgAhora = configs.get(CLAVE_INICIA_AHORA) ?? null;
    const cfgDebio = configs.get(CLAVE_DEBIO_INICIAR) ?? null;
    const cfgLlamada = configs.get(CLAVE_LLAMADA) ?? null;
    const ahoraMs = Date.now();
    // La cola de llamadas se limpia aunque la tarjeta esté apagada: lo que ya estaba en cola
    // (o una llamada de prueba) tiene que terminar en un estado que se pueda leer.
    if (cfgLlamada) await limpiarCola(ahoraMs);
    if (!cfgAhora?.activo && !cfgDebio?.activo && !cfgLlamada?.activo) {
      // Sin la migración (supabase/alertas-escalera-inicio.sql) las filas no existen.
      return NextResponse.json({ ok: true, apagado: true, falta_config: !cfgAhora && !cfgDebio });
    }

    const hoy = fechaLima(ahoraMs);
    const manana = fechaLima(ahoraMs + DIA_MS);
    const ayer = fechaLima(ahoraMs - DIA_MS);   // un servicio de las 23:58 de ayer: su «debió iniciar» es hoy
    const reloj = { ahoraMs, hoy, manana };

    // Paginado y con orden total: PostgREST corta en 1000 filas, y sin orden el corte cae en
    // cualquier parte — algunos servicios se quedarían sin aviso sin que nada lo dijera.
    const data: FilaReserva[] = [];
    for (let desde = 0; ; desde += PAGINA) {
      const { data: pag, error } = await admin
        .from("reservas")
        .select("id, fecha_servicio, hora_servicio, estado, conductor_id, conductor_tercero_id, origen, destino")
        .in("fecha_servicio", [ayer, hoy, manana])
        .in("estado", [...ESTADOS_SIN_INICIAR])
        .order("id", { ascending: true })
        .range(desde, desde + PAGINA - 1);
      if (error) throw new Error(error.message);
      data.push(...((pag ?? []) as FilaReserva[]));
      if (!pag || pag.length < PAGINA) break;
    }

    // Qué toca a cada servicio en ESTE minuto.
    const tareas: { r: FilaReserva; clave: string; cfg: AlertaConfig; ref: RefCond }[] = [];
    const llamadas: { r: FilaReserva; ref: RefCond }[] = [];
    let sinConductor = 0;
    for (const r of data) {
      const pasos = pasosQueTocan(r, { iniciaAhora: cfgAhora, debioIniciar: cfgDebio }, reloj);
      const llamar = juzgarLlamada(r, cfgLlamada, reloj) === "toca";
      if (pasos.length === 0 && !llamar) continue;
      const ref = condDe(r);
      if (!ref) { sinConductor++; continue; }
      for (const clave of pasos) {
        const cfg = clave === CLAVE_INICIA_AHORA ? cfgAhora! : cfgDebio!;
        if (!cfg.notifica_conductor || !cfg.plantilla) continue;
        // Un conductor TERCERIZADO solo si la tarjeta lo dice (decisión comercial).
        if (ref.tabla === "conductores_tercero" && cfg.notifica_conductor_tercero !== true) continue;
        tareas.push({ r, clave, cfg, ref });
      }
      if (llamar && cfgLlamada!.notifica_conductor !== false
          && (ref.tabla === "conductores" || cfgLlamada!.notifica_conductor_tercero === true)) {
        llamadas.push({ r, ref });
      }
    }
    const res: Record<string, number> = {
      [CLAVE_INICIA_AHORA]: 0, [CLAVE_DEBIO_INICIAR]: 0, sin_canal: 0, fallos: 0, sin_conductor: sinConductor,
      llamadas_en_cola: 0, llamadas_sin_telefono: 0,
    };
    if (tareas.length === 0 && llamadas.length === 0) return NextResponse.json({ ok: true, ...res });

    // Datos de los conductores, cada id en SU tabla: los ids de `conductores` y
    // `conductores_tercero` se solapan.
    const refs = [...tareas.map((x) => x.ref), ...llamadas.map((x) => x.ref)];
    const ids = (t: Tabla) => [...new Set(refs.filter((x) => x.tabla === t).map((x) => x.id))];
    const mapas: Record<Tabla, Map<number, DatosCond>> = { conductores: new Map(), conductores_tercero: new Map() };
    if (ids("conductores").length) {
      const { data: cs } = await admin.from("conductores").select("id, nombre, telefono, email").in("id", ids("conductores"));
      for (const c of cs ?? []) mapas.conductores.set(c.id, { nombre: c.nombre, telefono: c.telefono, email: c.email });
    }
    if (ids("conductores_tercero").length) {
      // `email` es de una migración accesoria (conductores-tercero-avisos.sql).
      const sel = await admin.from("conductores_tercero").select("id, nombre, telefono, email").in("id", ids("conductores_tercero"));
      const filas = sel.error
        ? (await admin.from("conductores_tercero").select("id, nombre, telefono").in("id", ids("conductores_tercero"))).data
        : sel.data;
      for (const c of (filas ?? []) as { id: number; nombre: string; telefono: string | null; email?: string | null }[]) {
        mapas.conductores_tercero.set(c.id, { nombre: c.nombre, telefono: c.telefono, email: c.email ?? null });
      }
    }
    const telConting = tareas.some((t) => t.clave === CLAVE_DEBIO_INICIAR) ? await telefonoContingencia() : "";

    for (const { r, clave, cfg, ref } of tareas) {
      const c = mapas[ref.tabla].get(ref.id);
      if (!c) { res.sin_canal++; continue; }
      if (!(await reclamarEnvio(clave, r.id, r.fecha_servicio))) continue;   // ya salió

      const nombre = nombreCorto(c.nombre);
      const hora = horaCorta(r.hora_servicio);
      const origen = r.origen || rutaDe(r);
      // Los parámetros son los de la plantilla que la migración le asigna a cada clave
      // (las mismas que ya salen hoy en «Recuerda iniciar» y en «No inició»).
      const parametros = clave === CLAVE_INICIA_AHORA
        ? [nombre, hora, origen]
        : [nombre, hora, rutaDe(r), telConting];
      const push = textoPushInicio(clave, { hora, origen, minutos: minutosIniciaAhora(cfg) });

      let estado: "enviado" | "sin_canal" | "fallo";
      try {
        const rc = await enviarAConductor({
          conductor: { id: ref.id, nombre: c.nombre, telefono: c.telefono, email: c.email },
          tabla: ref.tabla,
          plantilla: cfg.plantilla!,
          parametros,
          canales: canalesConductor(cfg),
          titulo: cfg.nombre,
          pushTexto: push.cuerpo,
          push: { titulo: push.titulo, urgencia: "high", ttl: push.ttl, requireInteraction: push.requireInteraction },
          reservaId: r.id,
          alertaClave: clave,
          trigger: "manual",
        });
        estado = rc.estado;
      } catch {
        estado = "fallo";
      }
      if (estado === "enviado") res[clave]++;
      else if (estado === "sin_canal") res.sin_canal++;
      else { res.fallos++; await liberarEnvio(clave, r.id, r.fecha_servicio); }   // transitorio → el próximo minuto
    }

    // ── La llamada: a la COLA de la central propia (ella marca; aquí no se llama a nadie) ──
    for (const { r, ref } of llamadas) {
      const c = mapas[ref.tabla].get(ref.id);
      const vence = venceLlamadaMs(r, cfgLlamada);
      if (!c || vence == null) continue;
      if (!(await reclamarEnvio(CLAVE_LLAMADA, r.id, r.fecha_servicio))) continue;   // ya está en cola
      const rc = await encolarLlamada({
        reservaId: r.id,
        fechaServicio: r.fecha_servicio,
        conductor: { id: ref.id, tabla: ref.tabla, nombre: c.nombre, telefono: c.telefono },
        hora: horaCorta(r.hora_servicio),
        origen: r.origen || rutaDe(r),
        destino: r.destino,
        venceMs: vence,
      });
      if (rc === "encolada" || rc === "ya_estaba") res.llamadas_en_cola++;
      else if (rc === "sin_telefono") res.llamadas_sin_telefono++;      // queda reclamada: reintentar no cambia nada
      else if (rc === "error") { res.fallos++; await liberarEnvio(CLAVE_LLAMADA, r.id, r.fecha_servicio); }
      // "sin_tabla": falta la migración de la central; queda reclamada para no insistir cada minuto.
    }

    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[alertas-flota/inicio]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
