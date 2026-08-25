// lib/whatsapp-registro.ts — SOLO SERVIDOR.
//
// Alta/actualización de una fila de `whatsapp_numeros`. Vive aparte porque lo
// necesitan dos rutas: el registro simple (/api/crm/whatsapp/registrar) y la
// activación completa de la coexistencia (/api/crm/whatsapp/activar), y el upsert
// tiene una trampa que no conviene duplicar mal en dos sitios.

import { createClient } from "@supabase/supabase-js";
import { invalidarCacheNumeros } from "@/lib/whatsapp-numeros";

function db() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export type DatosNumero = {
  phone_number_id: string;
  waba_id?: string | null;
  /** Nombre corto para la interfaz. Si no viene se deduce del verified_name o del número. */
  alias?: string | null;
  /** Como lo manda el webhook: solo dígitos ("51966707225"). */
  display_phone_number?: string | null;
  /** Columnas extra de la coexistencia (es_coexistencia, platform_type, onboarding_*, …). */
  extra?: Record<string, unknown>;
};

export type ResultadoRegistro =
  | { ok: true; numero: any; creado: boolean }
  | { ok: false; error: string };

/**
 * Registra o actualiza un número.
 *
 * La trampa: `phone_number_id` y `display_phone_number` son AMBOS UNIQUE, así que
 * un upsert por phone_number_id no basta — si el mismo número físico se reconecta
 * y Meta le asigna otro phone_number_id, el upsert intenta INSERTAR y choca contra
 * el otro índice con un error críptico. Por eso se busca antes por cualquiera de
 * las dos claves y se decide insert vs update a mano.
 *
 * Lo que NUNCA se toca al actualizar:
 *   · los usos (usa_crm / usa_avisos / usa_campanas) — activarlos aquí desplazaría
 *     en silencio al número que hoy cumple ese papel y cambiaría por dónde salen
 *     los mensajes de la empresa;
 *   · `activo` — si alguien dio de baja un número, reconectarlo no debe revivirlo
 *     con sus usos intactos (y el índice único parcial devolvería un 500).
 */
export async function registrarNumero(datos: DatosNumero): Promise<ResultadoRegistro> {
  const supabase = db();
  const display = datos.display_phone_number ?? null;

  const { data: existente } = await supabase
    .from("whatsapp_numeros")
    .select("*")
    .or(
      display
        ? `phone_number_id.eq.${datos.phone_number_id},display_phone_number.eq.${display}`
        : `phone_number_id.eq.${datos.phone_number_id}`,
    )
    .maybeSingle();

  const fila: Record<string, unknown> = {
    phone_number_id: String(datos.phone_number_id),
    display_phone_number: display,
    waba_id: datos.waba_id ? String(datos.waba_id) : (existente?.waba_id ?? null),
    alias: (datos.alias || existente?.alias || display || "Número nuevo").toString().slice(0, 60),
    updated_at: new Date().toISOString(),
    ...(datos.extra ?? {}),
  };

  const q = existente
    ? supabase.from("whatsapp_numeros").update(fila).eq("id", existente.id)
    : supabase.from("whatsapp_numeros").insert({ ...fila, activo: true });

  const { data, error } = await q.select().single();

  if (error) {
    // Las columnas de coexistencia son de una migración posterior: si aún no se
    // corrió, se reintenta sin ellas para no bloquear el alta del número.
    // El reintento va con `extra` vacío, así que no puede volver a entrar aquí.
    if (/column .* does not exist/i.test(error.message) && datos.extra) {
      const reintento = await registrarNumero({ ...datos, extra: undefined });
      if (reintento.ok) return reintento;
    }
    return {
      ok: false,
      error: `No se pudo registrar el número: ${error.message}. ¿Corriste supabase/whatsapp-numeros.sql y supabase/whatsapp-coexistencia.sql?`,
    };
  }

  invalidarCacheNumeros();
  return { ok: true, numero: data, creado: !existente };
}
