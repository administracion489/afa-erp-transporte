// ──────────────────────────────────────────────────────────────────────────────
// lib/crm-gmail-reglas.ts — Motor PURO de la lectura del Gmail del CRM. No llama a Google ni a
// la base: decide desde cuándo leer, a quién no importar y cómo decir lo que salió mal.
//
// EL DEFECTO QUE LO ORIGINA («ni el CRM lee los correos»): la lectura guarda un marcador de
// Gmail (`historyId`) para pedir solo lo nuevo. Gmail lo conserva más o menos una semana; si la
// conexión estuvo caída más que eso, el marcador VENCE y Google responde 404. El código no miraba
// la respuesta: leía `history` (vacío), no avanzaba el marcador, y desde ahí CADA lectura traía
// 0 correos — para siempre, porque reconectar el Gmail no borraba el marcador viejo. Nada fallaba
// y nada avisaba: la pantalla decía «sincronizado correctamente».
// ──────────────────────────────────────────────────────────────────────────────

/** Sin marcador (primera conexión) se trae la última semana del INBOX. */
export const DIAS_VENTANA_INICIAL = 7;
/** Una recuperación nunca mira más de un mes atrás: un CRM no necesita el archivo del año. */
export const DIAS_VENTANA_MAX = 30;
/** Tope por lectura: el cron corre cada 10 min, lo que no entre ahora entra en la siguiente. */
export const MAX_MENSAJES_POR_LECTURA = 100;

/**
 * Cuántos días leer cuando NO hay marcador utilizable. Con la última lectura buena conocida se
 * cubre exactamente el hueco (+1 día de margen); sin ella, la semana inicial. Siempre en
 * [1, DIAS_VENTANA_MAX]. Volver a leer de más no duplica nada: se deduplica por id de mensaje.
 */
export function diasRecuperacion(ultimaLecturaIso: string | null | undefined, ahoraMs: number): number {
  if (!ultimaLecturaIso) return DIAS_VENTANA_INICIAL;
  const t = Date.parse(ultimaLecturaIso);
  if (!Number.isFinite(t)) return DIAS_VENTANA_INICIAL;
  const dias = Math.ceil(Math.max(0, ahoraMs - t) / 86_400_000) + 1;
  return Math.min(DIAS_VENTANA_MAX, Math.max(1, dias));
}

/** Gmail contesta 404 cuando el `startHistoryId` venció (o no existe): hay que releer por fecha. */
export function marcadorVencido(status: number, mensaje?: string | null): boolean {
  if (status === 404) return true;
  return status === 400 && /startHistoryId/i.test(mensaje ?? "");
}

/** El encabezado From → dirección y nombre. «Juan <juan@x.pe>», «juan@x.pe», «"Juan" <...>». */
export function remitenteDe(from: string | null | undefined): { email: string; nombre: string } {
  const f = String(from ?? "").trim();
  const enAngulos = /<([^>]+)>/.exec(f)?.[1];
  const suelto = /([^\s<>"']+@[^\s<>"']+)/.exec(f)?.[1];
  const email = (enAngulos ?? suelto ?? "").trim().toLowerCase();
  const nombre = f.replace(/<[^>]*>/, "").replace(/["']/g, "").trim() || email;
  return { email, nombre };
}

/** Dominios de correo gratuito: compartirlos no te hace de la misma empresa. */
const DOMINIOS_PUBLICOS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.es", "outlook.com", "outlook.es",
  "live.com", "msn.com", "yahoo.com", "yahoo.es", "icloud.com", "me.com", "proton.me", "protonmail.com",
]);

const dominio = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

/**
 * ¿Lo mandó la propia empresa? Un compañero que escribe al buzón del CRM no es un cliente, y
 * meterlo en la bandeja la llena de ruido interno. Se mira el DOMINIO del buzón conectado —que
 * es la regla que había, escrita como `includes("afatoursperu.com")`, y que en la instalación
 * de un comprador del ERP no habría filtrado nada—, salvo que ese dominio sea un correo gratuito:
 * con un buzón @gmail.com, «mismo dominio» descartaría a todos los clientes que escriben desde
 * Gmail. Ahí solo cuenta la dirección exacta.
 */
export function esRemitentePropio(remitente: string, cuentaEmail: string | null | undefined): boolean {
  const r = remitente.trim().toLowerCase();
  const c = String(cuentaEmail ?? "").trim().toLowerCase();
  if (!r || !c) return false;
  if (r === c) return true;
  const d = dominio(c);
  return !!d && !DOMINIOS_PUBLICOS.has(d) && dominio(r) === d;
}

/** ¿Este mensaje es de la bandeja de entrada? Lo enviado, el spam y la papelera no son conversaciones. */
export function esDeLaBandeja(labelIds: string[] | null | undefined): boolean {
  const l = new Set(labelIds ?? []);
  if (l.has("SPAM") || l.has("TRASH") || l.has("DRAFT")) return false;
  return l.has("INBOX");
}

/** El error de Google, dicho en castellano y con el arreglo. */
export function explicarErrorGoogle(mensaje: string | null | undefined): string {
  const m = String(mensaje ?? "").trim();
  if (/invalid_grant|expired or revoked|token has been expired/i.test(m)) {
    return "Google ya no acepta el permiso guardado (se quitó el acceso, se cambió la contraseña o caducó): vuelve a conectar el Gmail. " +
      "Si se corta cada 7 días, la app de Google está en modo «Prueba»: en Google Cloud → Pantalla de consentimiento de OAuth pásala a «En producción» (o a «Interna» si usan Google Workspace).";
  }
  if (/invalid_client|unauthorized_client/i.test(m)) {
    return "Google rechaza el cliente OAuth: revisa GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en Vercel.";
  }
  if (/insufficient.*scope|insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(m)) {
    return "El permiso concedido no alcanza para leer el correo: vuelve a conectar el Gmail aceptando todos los permisos.";
  }
  if (/Gmail API has not been used|accessNotConfigured|SERVICE_DISABLED/i.test(m)) {
    return "La API de Gmail está desactivada en el proyecto de Google Cloud: actívala (APIs y servicios → Gmail API → Habilitar).";
  }
  return m || "Error desconocido de Google.";
}

/** «hace 5 min», «hace 3 h», «hace 2 días» — para la línea de estado. */
export function haceCuanto(iso: string | null | undefined, ahoraMs: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.round((ahoraMs - t) / 60_000));
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} días`;
}
