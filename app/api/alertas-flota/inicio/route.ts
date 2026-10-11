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

export const maxDuration = 60;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const DIA_MS = 86_400_000;

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
    if (!cfgAhora?.activo && !cfgDebio?.activo) {
      // Sin la migración (supabase/alertas-escalera-inicio.sql) las filas no existen.
      return NextResponse.json({ ok: true, apagado: true, falta_config: !cfgAhora && !cfgDebio });
    }

    const ahoraMs = Date.now();
    const hoy = fechaLima(ahoraMs);
    const manana = fechaLima(ahoraMs + DIA_MS);
    const ayer = fechaLima(ahoraMs - DIA_MS);   // un servicio de las 23:58 de ayer: su «debió iniciar» es hoy
    const reloj = { ahoraMs, hoy, manana };

    const { data, error } = await admin
      .from("reservas")
      .select("id, fecha_servicio, hora_servicio, estado, conductor_id, conductor_tercero_id, origen, destino")
      .in("fecha_servicio", [ayer, hoy, manana])
      .in("estado", [...ESTADOS_SIN_INICIAR]);
    if (error) throw new Error(error.message);

    // Qué toca a cada servicio en ESTE minuto.
    const tareas: { r: FilaReserva; clave: string; cfg: AlertaConfig; ref: RefCond }[] = [];
    let sinConductor = 0;
    for (const r of (data ?? []) as FilaReserva[]) {
      const pasos = pasosQueTocan(r, { iniciaAhora: cfgAhora, debioIniciar: cfgDebio }, reloj);
      if (pasos.length === 0) continue;
      const ref = condDe(r);
      if (!ref) { sinConductor++; continue; }
      for (const clave of pasos) {
        const cfg = clave === CLAVE_INICIA_AHORA ? cfgAhora! : cfgDebio!;
        if (!cfg.notifica_conductor || !cfg.plantilla) continue;
        // Un conductor TERCERIZADO solo si la tarjeta lo dice (decisión comercial).
        if (ref.tabla === "conductores_tercero" && cfg.notifica_conductor_tercero !== true) continue;
        tareas.push({ r, clave, cfg, ref });
      }
    }
    const res: Record<string, number> = { [CLAVE_INICIA_AHORA]: 0, [CLAVE_DEBIO_INICIAR]: 0, sin_canal: 0, fallos: 0, sin_conductor: sinConductor };
    if (tareas.length === 0) return NextResponse.json({ ok: true, ...res });

    // Datos de los conductores, cada id en SU tabla: los ids de `conductores` y
    // `conductores_tercero` se solapan.
    const ids = (t: Tabla) => [...new Set(tareas.filter((x) => x.ref.tabla === t).map((x) => x.ref.id))];
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

    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[alertas-flota/inicio]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
