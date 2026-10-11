// lib/escalera-inicio-datos.ts — SOLO SERVIDOR. Lee lo que ya se le avisó a un conductor por
// un servicio (`notificaciones_enviadas`), para el resumen que recibe el coordinador. La
// regla vive en lib/escalera-inicio.ts (puro); aquí solo se lee.

import { createClient } from "@supabase/supabase-js";
import { resumenAvisosConductor, type FilaAviso, type ResumenAvisos } from "@/lib/escalera-inicio";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const VACIO: ResumenAvisos = { texto: "", sinEntregar: false, conEstados: false };

/**
 * Resumen de los avisos de la escalera ya enviados al conductor por esta reserva.
 * Best-effort: si la lectura falla, vacío — el aviso al coordinador sale igual, sin la
 * evidencia, en vez de no salir.
 */
export async function resumenAvisosDeReserva(reservaId: number, ahoraMs = Date.now(), maxLargo = 260): Promise<ResumenAvisos> {
  try {
    // `*` y no una lista: las columnas de entrega son de una migración accesoria
    // (alertas-escalera-inicio.sql) y pedirlas por nombre tumbaría la consulta sin ella.
    const { data, error } = await admin
      .from("notificaciones_enviadas")
      .select("*")
      .eq("reserva_id", reservaId)
      .not("conductor_id", "is", null)
      .gte("created_at", new Date(ahoraMs - 36 * 3_600_000).toISOString())
      .order("created_at", { ascending: true })
      .limit(100);
    if (error || !data) return VACIO;
    return resumenAvisosConductor(data as FilaAviso[], ahoraMs, maxLargo);
  } catch {
    return VACIO;
  }
}
