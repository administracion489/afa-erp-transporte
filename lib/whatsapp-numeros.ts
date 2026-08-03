// Números de WhatsApp de la empresa. Fuente de verdad: tabla `whatsapp_numeros`
// (supabase/whatsapp-numeros.sql). Sustituye a META_PHONE_NUMBER_ID* como origen del
// número de salida, para poder añadir números sin tocar código ni redesplegar.
//
// RESPALDO A ENV: si la tabla no existe todavía, está vacía, o no tiene número para
// el uso pedido, se cae a las variables de entorno de siempre. Así el despliegue no
// depende de que alguien corra la migración, y una tabla mal configurada nunca deja
// a la empresa sin poder enviar. Todo esto es servidor: nada de esto llega al bundle.
//
// El token NO vive aquí (sigue en META_WA_TOKEN): todos los números de AFA cuelgan
// del mismo system user de Meta. Un token por empresa hará falta al vender el ERP.

import { createClient } from "@supabase/supabase-js";

export type Uso = "crm" | "avisos" | "campanas";

export type NumeroWhatsApp = {
  id: string;
  phone_number_id: string;
  display_phone_number: string | null;
  waba_id: string | null;
  alias: string;
  usa_crm: boolean;
  usa_avisos: boolean;
  usa_campanas: boolean;
  activo: boolean;
};

const COLUMNA_USO: Record<Uso, keyof NumeroWhatsApp> = {
  crm: "usa_crm",
  avisos: "usa_avisos",
  campanas: "usa_campanas",
};

// WABA histórico de cada uso, para cuando la fila existe pero le falta waba_id (por
// ejemplo si se registró desde el Embedded Signup antes de que Meta lo devolviera).
// Se exporta porque /api/crm/whatsapp/detectar los usa como punto de partida para
// preguntarle a Meta qué números tiene cada cuenta.
export const WABA_FALLBACK: Record<Uso, string | undefined> = {
  crm: "428943170988671",       // Afa Transporte (+51 966707225)
  campanas: "428943170988671",  // las campañas salen del mismo número que el CRM
  avisos: "1336334522036982",   // Afa Notificaciones (+51 905438216)
};

/**
 * Número que el entorno tiene configurado para un uso. Es el respaldo mientras la tabla
 * esté vacía, y además lo que /api/crm/whatsapp/detectar consulta para deducir los usos
 * al sembrar por primera vez: así la migración no cambia por dónde sale ningún mensaje.
 */
export function envPhone(uso: Uso): string | undefined {
  if (uso === "avisos") {
    // Nombre canónico y el histórico, que sigue configurado en algunos entornos.
    return process.env.META_PHONE_NUMBER_ID_AVISOS ?? process.env.META_PHONE_NUMBER_ID_PASAJEROS;
  }
  // El CRM y las campañas comparten número.
  return process.env.META_PHONE_NUMBER_ID;
}

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

// Caché en memoria: estos datos cambian cuando alguien conecta un número, o sea casi
// nunca, y sin ella cada mensaje de una campaña haría una consulta extra.
let cache: { filas: NumeroWhatsApp[]; hasta: number } | null = null;
const TTL_MS = 5 * 60 * 1000;

// El fallo TAMBIÉN se cachea, con una ventana corta. Mientras la tabla no exista (el
// .sql se corre a mano) cada consulta falla, y sin esto un aviso a una reserva de 40
// pasajeros dispararía 40 consultas fallidas: phoneAvisos() se llama por pasajero.
// La ventana es corta para que, al correr por fin la migración, se note enseguida.
const TTL_FALLO_MS = 60 * 1000;

export function invalidarCacheNumeros() {
  cache = null;
}

export async function listarNumeros(): Promise<NumeroWhatsApp[]> {
  if (cache && Date.now() < cache.hasta) return cache.filas;

  const supabase = db();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("whatsapp_numeros")
    .select("*")
    .eq("activo", true)
    .order("alias");

  // Tabla inexistente o RLS: se degrada a las env vars, no se rompe el envío.
  if (error) {
    console.warn("[whatsapp-numeros] no se pudo leer la tabla, usando env:", error.message);
    cache = { filas: [], hasta: Date.now() + TTL_FALLO_MS };
    return [];
  }

  const filas = (data ?? []) as NumeroWhatsApp[];
  cache = { filas, hasta: Date.now() + TTL_MS };
  return filas;
}

/** phone_number_id con el que ENVIAR para un uso dado. undefined si no hay ninguno. */
export async function phonePara(uso: Uso): Promise<string | undefined> {
  const filas = await listarNumeros();
  const fila = filas.find((f) => f[COLUMNA_USO[uso]] === true);
  return fila?.phone_number_id ?? envPhone(uso);
}

/** WABA para listar o crear plantillas del número de ese uso. */
export async function wabaPara(uso: Uso): Promise<string | undefined> {
  const filas = await listarNumeros();
  const fila = filas.find((f) => f[COLUMNA_USO[uso]] === true);
  return fila?.waba_id ?? WABA_FALLBACK[uso];
}

/** Busca por el número tal como lo manda el webhook ("51966707225"). */
export async function porDisplay(display: string): Promise<NumeroWhatsApp | undefined> {
  const filas = await listarNumeros();
  return filas.find((f) => f.display_phone_number === display);
}

/** Busca por el id de Meta. */
export async function porPhoneId(phoneId: string): Promise<NumeroWhatsApp | undefined> {
  const filas = await listarNumeros();
  return filas.find((f) => f.phone_number_id === phoneId);
}

/**
 * ¿Este número entrante es el de avisos? Decide si contesta el agente IA: quien
 * responde a un recordatorio no debe caer en el bot de ventas.
 * Con la tabla vacía mantiene la comparación contra la env var de siempre.
 */
export async function esNumeroDeAvisos(phoneId: string | undefined): Promise<boolean> {
  if (!phoneId) return false;

  // El entorno se consulta PRIMERO y manda. Si sólo se mirara la fila, registrar el
  // número de avisos desde el modal lo rompería: /registrar lo guarda sin usos
  // (usa_avisos = false a propósito, para no desplazar en silencio al número que hoy
  // cumple ese papel), así que la fila existiría diciendo "no soy avisos" y el bot de
  // ventas se pondría a contestarle a los pasajeros que responden un recordatorio.
  if (phoneId === envPhone("avisos")) return true;

  const fila = await porPhoneId(phoneId);
  return fila?.usa_avisos ?? false;
}
