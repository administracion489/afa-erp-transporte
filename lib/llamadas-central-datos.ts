// lib/llamadas-central-datos.ts — SOLO SERVIDOR. La cola de llamadas de la central propia: poner
// una llamada en cola, limpiar las que ya no sirven y leer las de un servicio. La regla vive en
// lib/llamadas-central.ts (puro); aquí solo se lee y se escribe.
//
// Todo es best-effort hacia afuera: una cola que falla NO puede tumbar el cron de un minuto ni el
// aviso al coordinador. Sin la migración (supabase/llamadas-01-central.sql) la tabla no existe:
// se nombra una vez y no se insiste.

import { createClient } from "@supabase/supabase-js";
import { tablaFaltante } from "@/lib/columna-faltante";
import { empresaConDefectos, type PerfilEmpresa } from "@/lib/empresa-perfil";
import {
  CLAVE_LLAMADA, MARCANDO_MAX_MIN, MAX_INTENTOS, telefonoParaLlamar, textoLlamada, type FilaLlamada,
} from "@/lib/llamadas-central";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

let avisadoSinTabla = false;
function sinTabla(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const falta = tablaFaltante(error, "llamadas_conductor");
  if (falta && !avisadoSinTabla) {
    console.warn("[llamadas] falta supabase/llamadas-01-central.sql:", error.message);
    avisadoSinTabla = true;
  }
  return falta;
}

/** Nombre de la empresa para la voz de la llamada, o "" si el perfil no está llenado. */
let empresaCache: { nombre: string; hasta: number } | null = null;
export async function nombreEmpresaParaLlamada(): Promise<string> {
  const ahora = Date.now();
  if (empresaCache && empresaCache.hasta > ahora) return empresaCache.nombre;
  let nombre = "";
  try {
    const { data } = await admin.from("empresa_perfil").select("nombre,razon_social").eq("id", 1).maybeSingle();
    const e = empresaConDefectos((data ?? null) as PerfilEmpresa | null);
    // Nunca se pronuncia el aviso de «configura el perfil»: sin nombre, «la central de operaciones».
    nombre = e.sinConfigurar ? "" : e.nombre;
  } catch { /* sin perfil: sin nombre */ }
  empresaCache = { nombre, hasta: ahora + 10 * 60_000 };
  return nombre;
}

export type ResultadoEncolar = "encolada" | "ya_estaba" | "sin_telefono" | "sin_tabla" | "error";

/** Pone en cola la llamada de un servicio. Una por servicio y motivo (índice único). */
export async function encolarLlamada(args: {
  reservaId: number | null;
  fechaServicio: string | null;
  motivo?: string;
  conductor: { id: number | null; tabla: "conductores" | "conductores_tercero" | null; nombre?: string | null; telefono?: string | null };
  hora?: string | null;
  origen?: string | null;
  destino?: string | null;
  venceMs: number;
  maxIntentos?: number;
  creadoPor?: string | null;
}): Promise<ResultadoEncolar> {
  const tel = telefonoParaLlamar(args.conductor.telefono);
  if (!tel) return "sin_telefono";
  const empresa = await nombreEmpresaParaLlamada();
  const t = textoLlamada({ nombre: args.conductor.nombre, hora: args.hora, origen: args.origen, empresa });
  const fila = {
    reserva_id: args.reservaId,
    fecha_servicio: args.fechaServicio,
    conductor_id: args.conductor.id,
    conductor_tabla: args.conductor.tabla,
    telefono: tel,
    motivo: args.motivo ?? CLAVE_LLAMADA,
    mensaje: t.mensaje,
    menu: t.menu,
    datos: {
      nombre: String(args.conductor.nombre ?? "").trim() || null,
      hora: String(args.hora ?? "").slice(0, 5) || null,
      origen: args.origen ?? null,
      destino: args.destino ?? null,
    },
    max_intentos: args.maxIntentos ?? MAX_INTENTOS,
    vence_en: new Date(args.venceMs).toISOString(),
    creado_por: args.creadoPor ?? null,
  };
  try {
    const { error } = await admin.from("llamadas_conductor").insert(fila);
    if (!error) return "encolada";
    if (error.code === "23505" || /duplicate key/i.test(error.message ?? "")) return "ya_estaba";
    if (sinTabla(error)) return "sin_tabla";
    console.warn("[llamadas] no se pudo encolar:", error.message);
    return "error";
  } catch (e) {
    console.warn("[llamadas] no se pudo encolar:", e instanceof Error ? e.message : e);
    return "error";
  }
}

/**
 * Lo que ya no sirve sale de la cola: las pendientes vencidas (nadie las tomó a tiempo) y las que
 * se quedaron «marcando» sin resultado (la central se cayó a mitad). Best-effort.
 */
export async function limpiarCola(ahoraMs = Date.now()): Promise<void> {
  const ahora = new Date(ahoraMs).toISOString();
  try {
    const v = await admin.from("llamadas_conductor")
      .update({ estado: "vencida", terminada_en: ahora })
      .eq("estado", "pendiente").lt("vence_en", ahora);
    if (sinTabla(v.error)) return;
    await admin.from("llamadas_conductor")
      .update({ estado: "fallida", terminada_en: ahora, detalle: "la central no informó el resultado" })
      .eq("estado", "marcando").lt("tomada_en", new Date(ahoraMs - MARCANDO_MAX_MIN * 60_000).toISOString());
  } catch { /* la cola es un extra: el cron sigue */ }
}

/** Las llamadas de un servicio, para la evidencia al coordinador. Best-effort: [] si falla. */
export async function llamadasDeReserva(reservaId: number): Promise<FilaLlamada[]> {
  try {
    const { data, error } = await admin.from("llamadas_conductor")
      .select("estado, intentos, created_at, tomada_en, terminada_en, proximo_intento_en, duracion_seg, opcion, detalle, motivo")
      .eq("reserva_id", reservaId).order("created_at", { ascending: true }).limit(10);
    if (error) { sinTabla(error); return []; }
    return (data ?? []) as FilaLlamada[];
  } catch {
    return [];
  }
}

export { admin as adminLlamadas };
