// lib/meta-salud-datos.ts — SOLO SERVIDOR.
//
// Le pregunta a Meta por qué un número no puede enviar (lib/meta-salud.ts decide
// qué significa la respuesta). Se llama cuando un envío se rechaza POR PERMISOS con
// todos los tokens: el texto del veredicto se pega al error que ve el operador en el
// inbox, y la última lectura queda en `crm_config` (`wa_salud_<phone_number_id>`)
// para poder consultarla sin volver a pedirla.
//
// Nada de esto sale con un token: a la pantalla y a la base solo van el veredicto y
// lo que Meta dijo de cada entidad.

import { createClient } from "@supabase/supabase-js";
import { appId } from "@/lib/meta-onboarding";
import { porPhoneId, phonePara, wabaPara } from "@/lib/whatsapp-numeros";
import { leerPermisos, leerSalud, veredictoSalud, type LecturaToken, type Veredicto } from "@/lib/meta-salud";

const GRAPH = "https://graph.facebook.com/v25.0";
/** Una lectura por número cada tanto: mientras el bloqueo siga, cada envío repite el mismo veredicto. No medido. */
const VIGENCIA_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 6000;

const cache = new Map<string, { hasta: number; v: Veredicto }>();

async function pedir(url: string, token?: string): Promise<{ status: number; data: any }> {
  try {
    const r = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch (e: any) {
    return { status: 0, data: { error: { message: e?.name === "TimeoutError" ? "Meta no respondió a tiempo" : String(e?.message ?? e) } } };
  }
}

async function wabaDe(phoneId: string): Promise<string | null> {
  try {
    const fila = await porPhoneId(phoneId);
    if (fila?.waba_id) return String(fila.waba_id);
    if ((await phonePara("crm")) === phoneId) return (await wabaPara("crm")) ?? null;
    if ((await phonePara("avisos")) === phoneId) return (await wabaPara("avisos")) ?? null;
  } catch {
    /* sin la tabla, sin WABA: el permiso se juzga como «no se sabe» */
  }
  return null;
}

async function guardar(phoneId: string, valor: unknown) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
  await db.from("crm_config").upsert({ clave: `wa_salud_${phoneId}`, valor: JSON.stringify(valor), updated_at: new Date().toISOString() }, { onConflict: "clave" });
}

/**
 * Pregunta a Meta, con cada token, si el número puede enviar y si el token tiene el
 * permiso de mensajería sobre su cuenta. Nunca lanza: ante cualquier fallo devuelve
 * un veredicto «no se pudo consultar».
 */
export async function diagnosticarEnvio(
  phoneId: string,
  tokens: { propio?: string | null; general?: string | null },
): Promise<Veredicto> {
  const enCache = cache.get(phoneId);
  if (enCache && enCache.hasta > Date.now()) return enCache.v;
  try {
    const wabaId = await wabaDe(phoneId);
    const id = appId();
    const secreto = process.env.META_APP_SECRET;
    const lista: { cual: "propio" | "general"; token: string }[] = [];
    const p = tokens.propio?.trim();
    const g = tokens.general?.trim();
    if (p) lista.push({ cual: "propio", token: p });
    if (g && g !== p) lista.push({ cual: "general", token: g });

    const lecturas: LecturaToken[] = await Promise.all(
      lista.map(async ({ cual, token }) => {
        const [s, d] = await Promise.all([
          pedir(`${GRAPH}/${encodeURIComponent(phoneId)}?fields=health_status`, token),
          id && secreto
            ? pedir(`${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(`${id}|${secreto}`)}`)
            : Promise.resolve(null),
        ]);
        return {
          cual,
          salud: leerSalud(s.status, s.data),
          permisos: d ? leerPermisos(d.status, d.data, wabaId) : null,
        };
      }),
    );
    const v = veredictoSalud(lecturas, wabaId);
    cache.set(phoneId, { hasta: Date.now() + VIGENCIA_MS, v });
    await guardar(phoneId, { en: new Date().toISOString(), waba_id: wabaId, veredicto: v, lecturas }).catch(() => {});
    return v;
  } catch (e: any) {
    return { codigo: "no_se_sabe", texto: `No se pudo consultar a Meta el estado del número (${String(e?.message ?? e)}).` };
  }
}
