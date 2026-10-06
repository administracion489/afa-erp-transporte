// lib/radar/salud-datos.ts — Lee lo que necesita el motor de salud del Radar (lib/radar/salud.ts) y lo
// juzga. Lo usan /radar-ia (su aviso arriba de las pestañas) y la pestaña 📧 Facturas de /combustible
// (por qué las cargas están entrando sin odómetro): las dos pantallas preguntan con la MISMA función.
//
// Seis lecturas chicas y todas best-effort: la que falla entra como `null` y el motor no afirma nada
// sobre ella (un fallo de lectura nunca se convierte en «el Radar está caído»).

import { saludRadar, type SaludRadar, type MensajeTerminado } from "@/lib/radar/salud";
import { normalizarConfigRadar } from "@/lib/radar/config";

/** Los últimos mensajes terminados que se miran para contar una racha de fallos. */
const ULTIMOS = 20;

async function intento<T>(f: () => PromiseLike<{ data: unknown; error: unknown; count?: number | null }>, mapa: (r: { data: unknown; count?: number | null }) => T): Promise<T | null> {
  try {
    const r = await f();
    if (r.error) return null;
    return mapa(r);
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- el cliente de Supabase del ERP va sin tipos (lib/supabase.ts)
export async function leerSaludRadar(sb: any, ahora: number = Date.now()): Promise<SaludRadar> {
  const inicioDiaUtc = `${new Date(ahora - 5 * 3600_000).toISOString().slice(0, 10)}T05:00:00.000Z`; // 00:00 Lima, como el motor
  const [estado, config, ultimos, cola, gastoHoy, gruposSinAcceso] = await Promise.all([
    intento(() => sb.from("radar_estado").select("estado, detalle, ultimo_latido, numero").eq("id", 1).maybeSingle(),
      (r) => (r.data ?? null) as { estado: string | null; detalle: string | null; ultimo_latido: string | null; numero: string | null } | null),
    intento(() => sb.from("radar_config").select("*").eq("id", 1).maybeSingle(),
      (r) => (r.data ? normalizarConfigRadar(r.data) : null)),
    intento(() => sb.from("radar_mensajes").select("estado, accion, error, resultado, procesado_en")
      .not("procesado_en", "is", null).order("procesado_en", { ascending: false }).limit(ULTIMOS),
      (r) => ((r.data as MensajeTerminado[] | null) ?? [])),
    intento(() => sb.from("radar_mensajes").select("recibido_en", { count: "exact" })
      .eq("estado", "pendiente").order("recibido_en", { ascending: true }).limit(1),
      (r) => ({ cuantos: Number(r.count ?? 0), masViejo: ((r.data as { recibido_en: string }[] | null) ?? [])[0]?.recibido_en ?? null })),
    // El mismo gasto que suma el motor antes de su freno (Gate 3 de lib/radar/motor.ts).
    intento(() => sb.from("radar_mensajes").select("costo_usd").gte("procesado_en", inicioDiaUtc),
      (r) => ((r.data as { costo_usd: number | string | null }[] | null) ?? []).reduce((s, x) => s + Number(x.costo_usd || 0), 0)),
    // `visible` es de una migración accesoria (radar-ia-grupos-vigencia.sql): sin ella, el error deja
    // esto en null y el motor no dice nada de los grupos.
    intento(() => sb.from("radar_grupos").select("id", { count: "exact", head: true }).eq("activo", true).eq("visible", false),
      (r) => Number(r.count ?? 0)),
  ]);
  return saludRadar({ ahora, estado, config, ultimos, cola, gastoHoy, gruposSinAcceso });
}
