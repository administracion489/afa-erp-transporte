// lib/meta-token-respaldo.ts — PURO (no lee la base ni el entorno).
//
// Con qué token se le escribe a Meta por un número, y qué hacer si Meta lo rechaza
// por PERMISOS.
//
// EL CASO (20-10-2026): el número del CRM (+51 966 707 225) guarda desde el 15/10 su
// token propio, el que devolvió el Embedded Signup de coexistencia
// (`whatsapp_tokens`). Entre las 13:18 y las 15:32 de ese día ese token dejó de
// tener permiso para ENVIAR: cada respuesta del inbox, de la IA y cada PDF salía con
// «(#131005) Access denied», mientras las fotos que mandaba el cliente se seguían
// descargando con ese mismo token y el número de avisos (que usa META_WA_TOKEN)
// seguía enviando. `tokenParaNumero` usaba el propio si existía y NUNCA miraba el
// general: un token propio roto dejaba el número mudo aunque el system user de la
// empresa sí pudiera enviar por él.
//
// LA REGLA: se prueba primero el token propio (es el que manda: así funciona un
// número de OTRA empresa, que no cuelga del system user de AFA) y, solo si Meta lo
// rechaza por PERMISOS, se reintenta UNA vez con el general. Un rechazo por permiso
// no envía nada ni se cobra, así que el reintento no puede duplicar un mensaje.
// Cualquier otro error (fuera de la ventana de 24 h, plantilla inexistente, número
// inválido, un 5xx) NO se reintenta: el otro token no lo arregla, y un 5xx pudo
// haber salido igual.
//
// Si el general funciona, el propio queda «vetado» un rato (lo guarda quien llama):
// los envíos siguientes van directo con el general y no pagan dos llamadas. Si el
// general también es rechazado, el error dice los dos motivos, con el del propio
// primero (los llamadores reconocen el error por su código: 131047, 132001…).

/** El `error` de una respuesta de la Graph API. */
export type ErrorMeta = { code?: number | string; error_subcode?: number | string; message?: string; fbtrace_id?: string } | null | undefined;

/**
 * Códigos de la Graph API que significan «este token no puede hacer esto»:
 * 0 (AuthException), 3 (capacidad de la app), 10 (permiso denegado),
 * 190 (token inválido o vencido), 200-299 (permisos) y 131005 (Access denied de la
 * Cloud API: el permiso no se concedió o se retiró).
 */
const CODIGOS_PERMISO = new Set([0, 3, 10, 190, 131005]);

/** ¿Meta rechazó por permisos del TOKEN? Solo esto justifica probar con otro token. */
export function esErrorDePermiso(status: number, err: ErrorMeta): boolean {
  const code = err?.code == null || err.code === "" ? NaN : Number(err.code);
  if (Number.isFinite(code)) return CODIGOS_PERMISO.has(code) || (code >= 200 && code <= 299);
  // Sin código legible, solo un 401/403 dice «no autorizado».
  return status === 401 || status === 403;
}

/**
 * Orden en que se prueban los tokens. Normalmente el propio y después el general;
 * si el propio está vetado (ya fue rechazado hace poco), primero el general. Sin
 * repetir el mismo token y sin vacíos.
 */
export function tokensEnOrden(propio: string | null | undefined, general: string | null | undefined, propioVetado: boolean): string[] {
  const p = propio?.trim() || "";
  const g = general?.trim() || "";
  const orden = propioVetado ? [g, p] : [p, g];
  return orden.filter((t, i) => t && orden.indexOf(t) === i);
}

/** Respuesta de un intento, sin depender de `fetch` (para poder probarlo). */
export type IntentoMeta = { ok: boolean; status: number; data: any };

export type ResultadoEnvio =
  | { ok: true; data: any; token: string; intentos: number }
  | { ok: false; mensaje: string; intentos: number; porPermiso: boolean; fbtrace?: string | null };

/**
 * Prueba los tokens en orden. Reintenta con el siguiente SOLO ante un error de
 * permiso; ante cualquier otro error se detiene con ese mensaje.
 */
export async function enviarConRespaldo(
  tokens: string[],
  intentar: (token: string) => Promise<IntentoMeta>,
  mensajePorDefecto: string,
): Promise<ResultadoEnvio> {
  const mensajes: string[] = [];
  let intentos = 0;
  // El fbtrace_id del último rechazo: es lo que pide el soporte de Meta para rastrear
  // un envío concreto cuando su diagnóstico no explica el rechazo.
  let fbtrace: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const r = await intentar(tokens[i]);
    intentos++;
    if (r.ok) return { ok: true, data: r.data, token: tokens[i], intentos };
    const err: ErrorMeta = r.data?.error;
    mensajes.push(String(err?.message ?? mensajePorDefecto));
    const traza = err?.fbtrace_id;
    if (traza != null && String(traza).trim()) fbtrace = String(traza).trim().slice(0, 80);
    const porPermiso = esErrorDePermiso(r.status, err);
    if (!porPermiso || i === tokens.length - 1) {
      return { ok: false, mensaje: unirMensajes(mensajes), intentos, porPermiso, fbtrace };
    }
  }
  return { ok: false, mensaje: "No hay token de WhatsApp para este número: ni propio (whatsapp_tokens) ni META_WA_TOKEN en el entorno.", intentos: 0, porPermiso: false };
}

/** El primero manda (los llamadores lo reconocen por su código); el resto se agrega. */
export function unirMensajes(mensajes: string[]): string {
  const [primero, ...resto] = mensajes;
  if (!resto.length) return primero ?? "";
  const distintos = resto.filter((m) => m !== primero);
  return distintos.length
    ? `${primero} · con el token general: ${distintos.join(" · ")}`
    : `${primero} (también con el token general)`;
}

/** Cuánto se salta el token propio después de que Meta lo rechazó por permisos. No medido. */
export const VETO_TOKEN_PROPIO_MS = 30 * 60 * 1000;
