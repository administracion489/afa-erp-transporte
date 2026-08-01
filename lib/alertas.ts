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
  /** Avisar también al conductor TERCERIZADO. Separado de notifica_conductor a
   *  propósito: es personal de otra empresa, así que encenderlo es una decisión
   *  comercial. Default false = comportamiento histórico (no se les avisaba nunca). */
  notifica_conductor_tercero?: boolean | null;
  destinatarios: number[];               // ids de alerta_destinatarios
  plantilla: string | null;
  plantilla_directorio: string | null;
  // ── Canales por tipo (supabase/canales-por-tipo.sql) ──
  // Opcionales: si la migración aún no corrió, llegan undefined y los helpers de
  // abajo caen a los defaults que reproducen el comportamiento previo.
  canal_conductor_whatsapp?: boolean | null;
  canal_conductor_email?: boolean | null;
  canal_conductor_push?: boolean | null;
  canal_pasajero_push?: boolean | null;
  canal_pasajero_email?: boolean | null;
  canal_pasajero_email_solo_sin_app?: boolean | null;
  canal_pasajero_whatsapp?: boolean | null;
  canal_pasajero_whatsapp_solo_sin_app?: boolean | null;
  tiempo_editable?: boolean | null;
};

export type CanalesConductor = { whatsapp: boolean; email: boolean; push: boolean };
export type CanalesPasajero = {
  push: boolean;
  email: boolean;
  emailSoloSinApp: boolean;
  whatsapp: boolean;
  whatsappSoloSinApp: boolean;
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

// ─── CANALES POR TIPO DE MENSAJE ───────────────────────────────────────────────
// El canal dejó de ser fijo: cada fila de alerta_config elige por dónde sale su
// aviso. Ver supabase/canales-por-tipo.sql.
//
// REGLA DE ORO de los defaults: cuando falta el dato (migración sin correr, fila
// inexistente, error de red) se devuelve EXACTAMENTE el comportamiento anterior —
// conductor solo WhatsApp, pasajero los 3 canales sin filtrar por app. Así un
// despliegue sin migración no cambia ni un envío.

/** Canales del CONDUCTOR para un tipo. Default histórico: solo WhatsApp. */
export function canalesConductor(cfg: Pick<AlertaConfig,
  "canal_conductor_whatsapp" | "canal_conductor_email" | "canal_conductor_push">): CanalesConductor {
  return {
    whatsapp: cfg.canal_conductor_whatsapp ?? true,
    email:    cfg.canal_conductor_email    ?? false,
    push:     cfg.canal_conductor_push     ?? false,
  };
}

/** Defaults del PASAJERO = comportamiento previo del código (lib/notificaciones.ts).
 *  OJO: `soloSinApp` va en false aquí aunque el DDL de config_canales lo tenga en
 *  true. No "corregir" esa asimetría: cambiarla altera envíos en producción. El
 *  backfill copia la fila REAL, que es la que manda. */
const CANALES_PASAJERO_DEFAULT: CanalesPasajero = {
  push: true, email: true, emailSoloSinApp: false, whatsapp: true, whatsappSoloSinApp: false,
};

/**
 * Canales del PASAJERO para un tipo de mensaje. Cascada:
 *   1. alerta_config[clave]  (control por tipo — lo nuevo)
 *   2. config_canales id=1   (bloque global viejo — fallback si (1) no existe aún)
 *   3. defaults              (comportamiento histórico)
 * NUNCA lanza: un fallo de red aquí no puede tumbar un envío.
 */
export async function cargarCanalesPasajero(clave?: string): Promise<CanalesPasajero> {
  // 1) Por tipo
  if (clave) {
    try {
      const { data } = await admin
        .from("alerta_config")
        .select("canal_pasajero_push, canal_pasajero_email, canal_pasajero_email_solo_sin_app, canal_pasajero_whatsapp, canal_pasajero_whatsapp_solo_sin_app")
        .eq("clave", clave)
        .maybeSingle();
      // Solo se usa si la COLUMNA existe (migración corrida). Si la fila existe pero
      // las columnas son undefined, se cae al bloque global.
      if (data && (data as any).canal_pasajero_push !== undefined && (data as any).canal_pasajero_push !== null) {
        const d = data as any;
        return {
          push:               d.canal_pasajero_push,
          email:              d.canal_pasajero_email ?? true,
          emailSoloSinApp:    d.canal_pasajero_email_solo_sin_app ?? false,
          whatsapp:           d.canal_pasajero_whatsapp ?? true,
          whatsappSoloSinApp: d.canal_pasajero_whatsapp_solo_sin_app ?? false,
        };
      }
    } catch { /* sigue a la cascada */ }
  }
  // 2) Bloque global viejo
  try {
    const { data } = await admin.from("config_canales").select("*").eq("id", 1).maybeSingle();
    if (data) {
      return {
        push:               data.push_activo            ?? true,
        email:              data.email_activo           ?? true,
        emailSoloSinApp:    data.email_solo_sin_app     ?? false,
        whatsapp:           data.whatsapp_activo        ?? true,
        whatsappSoloSinApp: data.whatsapp_solo_sin_app  ?? false,
      };
    }
  } catch { /* sigue a defaults */ }
  // 3) Defaults
  return { ...CANALES_PASAJERO_DEFAULT };
}

/** Una sola fila de alerta_config por clave (para los llamadores fuera del tick). */
export async function cargarConfigAlerta(clave: string): Promise<AlertaConfig | null> {
  try {
    const { data } = await admin.from("alerta_config").select("*").eq("clave", clave).maybeSingle();
    if (!data) return null;
    return { ...(data as any), destinatarios: Array.isArray((data as any).destinatarios) ? (data as any).destinatarios.map(Number) : [] };
  } catch {
    return null;
  }
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
  /** Tabla del conductor avisado. Necesario porque los ids de `conductores` y
   *  `conductores_tercero` se solapan: sin esto, pasar del propio #7 al tercerizado
   *  #7 parecería "sin cambios" y no se avisaría la reasignación. */
  conductor_tabla_avisada?: "conductores" | "conductores_tercero" | null;
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
