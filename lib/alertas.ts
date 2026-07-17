// lib/alertas.ts — SOLO SERVIDOR. Núcleo del "centro de control de mensajes":
// carga la config editable (alerta_config + alerta_destinatarios), resuelve
// destinatarios y ofrece el dedupe insert-once (alerta_enviada). El endpoint
// /api/alertas-flota/tick usa esto; nada de esto está hardcodeado.

import { createClient } from "@supabase/supabase-js";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export type ModoTiempo = "evento" | "anticipacion" | "hora_fija";

export type AlertaConfig = {
  clave: string;
  nombre: string;
  activo: boolean;
  modo_tiempo: ModoTiempo;
  min_anticipacion: number | null;
  hora_fija: string | null;              // "HH:MM"
  umbral: number | null;
  notifica_conductor: boolean;
  notifica_pasajero: boolean;
  destinatarios: number[];               // ids de alerta_destinatarios
  plantilla: string | null;
  plantilla_directorio: string | null;
};

export type Destinatario = { id: number; nombre: string; funcion: string | null; telefono: string; activo: boolean };

// ─── FECHA / HORA LIMA (UTC-5) ─────────────────────────────────────────────────

/** Fecha local de Lima (YYYY-MM-DD). */
export function hoyLima(): string {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 5);
  return d.toISOString().split("T")[0];
}

/** Minutos transcurridos del día en Lima (0..1439). */
export function ahoraLimaMin(): number {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 5);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** "HH:MM" → minutos del día (o null). */
export function hhmmAMin(hhmm?: string | null): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : null;
}

// ─── CARGA DE CONFIG ───────────────────────────────────────────────────────────

export async function cargarMotor(): Promise<{
  configs: Map<string, AlertaConfig>;
  destinatarios: Map<number, Destinatario>;
}> {
  const [cfgR, destR] = await Promise.all([
    admin.from("alerta_config").select("*"),
    admin.from("alerta_destinatarios").select("*").eq("activo", true),
  ]);
  const configs = new Map<string, AlertaConfig>();
  for (const c of (cfgR.data ?? []) as any[]) {
    configs.set(c.clave, {
      ...c,
      destinatarios: Array.isArray(c.destinatarios) ? c.destinatarios.map(Number) : [],
    });
  }
  const destinatarios = new Map<number, Destinatario>();
  for (const d of (destR.data ?? []) as any[]) destinatarios.set(Number(d.id), d);
  return { configs, destinatarios };
}

/** Teléfonos del directorio elegidos para una alerta (solo activos). */
export function directorioDe(cfg: AlertaConfig, destMap: Map<number, Destinatario>): Destinatario[] {
  return cfg.destinatarios
    .map((id) => destMap.get(Number(id)))
    .filter((d): d is Destinatario => !!d && d.activo && !!d.telefono);
}

/**
 * Teléfono de CONTINGENCIA que se muestra en los mensajes al conductor ("si tienes un
 * problema, llama al Coordinador: …"). Sale del directorio (es_contingencia=true) para
 * poder cambiarlo desde el ERP sin re-aprobar plantillas en Meta. Fallback: número fijo.
 */
export async function telefonoContingencia(): Promise<string> {
  try {
    const { data } = await admin
      .from("alerta_destinatarios")
      .select("telefono")
      .eq("activo", true)
      .eq("es_contingencia", true)
      .limit(1)
      .maybeSingle();
    const t = (data?.telefono || "").trim();
    if (t) return t.startsWith("+") ? t : (t.replace(/\D/g, "").length === 9 ? `+51 ${t}` : t);
  } catch { /* tabla/columna aún sin migrar → fallback */ }
  return "+51 912 569 005";
}

// ─── DEDUPE INSERT-ONCE (alerta_enviada) ───────────────────────────────────────

/**
 * Intenta marcar (clave, ref, fecha) como enviado HOY. Devuelve true si es la
 * PRIMERA vez (hay que enviar); false si ya estaba (23505 → no reenviar).
 * `fecha` por defecto = hoy Lima. Para eventos de una sola vez usar ref único.
 */
export async function reclamarEnvio(clave: string, ref: string | number, fecha?: string): Promise<boolean> {
  const f = fecha ?? hoyLima();
  const { error } = await admin.from("alerta_enviada").insert({ clave, ref: String(ref), fecha: f });
  if (!error) return true;
  // Tabla aún no creada (migración pendiente): NO bloquear el envío — el llamador (p.ej.
  // el cron viejo de recordatorios) tiene su propio dedupe. Sin esto, un deploy antes de
  // correr el SQL rompería en silencio los recordatorios ya en producción.
  if (error.code === "42P01" || /does not exist/i.test(error.message || "")) return true;
  const dup = error.code === "23505" || /duplicate key value/i.test(error.message || "");
  if (!dup) console.warn("[alertas] reclamarEnvio:", error.message);
  return false; // duplicado (ya enviado) → no reenviar
}

/**
 * Libera un reclamo (rollback) cuando el envío falló de forma transitoria, para que un
 * tick posterior reintente. NO usar cuando simplemente no había destinatario (eso es
 * "nada que enviar", se deja reclamado para no reintentar en bucle).
 */
export async function liberarEnvio(clave: string, ref: string | number, fecha?: string): Promise<void> {
  const f = fecha ?? hoyLima();
  await admin.from("alerta_enviada").delete().match({ clave, ref: String(ref), fecha: f });
}

// ─── ESTADO DE CICLO DE VIDA (avisos_conductor_estado) ─────────────────────────

export type EstadoAviso = {
  reserva_id: number;
  conductor_avisado: number | null;
  vehiculo_avisado: number | null;
  hora_avisada: string | null;
  cancelacion_avisada: boolean;
  aviso_90_at: string | null;
  no_inicio_at: string | null;
  gps_silencio_at: string | null;
};

export async function cargarEstados(reservaIds: number[]): Promise<Map<number, EstadoAviso>> {
  const m = new Map<number, EstadoAviso>();
  if (reservaIds.length === 0) return m;
  const { data } = await admin.from("avisos_conductor_estado").select("*").in("reserva_id", reservaIds);
  for (const e of (data ?? []) as any[]) m.set(Number(e.reserva_id), e);
  return m;
}

export async function upsertEstado(reservaId: number, patch: Partial<EstadoAviso>): Promise<void> {
  await admin
    .from("avisos_conductor_estado")
    .upsert({ reserva_id: reservaId, ...patch, updated_at: new Date().toISOString() }, { onConflict: "reserva_id" });
}

export { admin as adminAlertas };
