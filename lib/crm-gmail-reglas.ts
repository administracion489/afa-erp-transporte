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

// ── La configuración del cliente OAuth de Google ─────────────────────────────────────────────
// La pantalla decía «falta configurar Google en Vercel (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
// GOOGLE_REDIRECT_URI)» igual si faltaban las tres que si faltaba una, y no decía QUÉ valor poner
// en la de redirección, que es la que se escribe mal: tiene que ser la dirección exacta del
// callback de ESTA instalación, la misma en Vercel y en Google Cloud. Y «Conectar Gmail» mandaba a
// Google de todos modos, con `client_id=undefined`, a una página de error en inglés que no nombra
// ninguna variable. El diagnóstico se compone aquí para que el CRM, el correo de facturas y el
// error del botón digan lo mismo.

/** Las tres variables del cliente OAuth, en el orden en que se crean en Vercel. */
export const VARIABLES_GOOGLE = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"] as const;
export type VariableGoogle = (typeof VARIABLES_GOOGLE)[number];

/** El callback del ERP (sirve a los dos buzones): es la ruta que se autoriza en Google Cloud. */
export const RUTA_CALLBACK_GMAIL = "/api/crm/gmail/callback";

/**
 * Un valor pegado en Vercel, sin espacios ni saltos de línea en los bordes y sin comillas
 * envolventes. Son los errores de pegado más comunes —copiar el ID desde el JSON que descarga
 * Google trae las comillas— y son invisibles en el panel: el valor «se ve bien» y Google lo
 * rechaza con un `invalid_client` que no dice por qué. Ninguno de los tres valores válidos lleva
 * comillas ni espacios, así que limpiar no puede estropear uno bueno.
 */
export function limpiarValorEnv(v: string | null | undefined): string {
  const s = String(v ?? "").trim();
  const m = /^(["'])([\s\S]*)\1$/.exec(s);
  return m ? m[2].trim() : s;
}

/** Qué le pasa a GOOGLE_REDIRECT_URI. Solo `otro_sitio` deja conectar: puede ser a propósito. */
export type ProblemaRedirect = "invalido" | "no_https" | "otra_ruta" | "otro_sitio";

export type DiagnosticoGoogle = {
  /** Las variables vacías o ausentes, en el orden de VARIABLES_GOOGLE. */
  faltan: VariableGoogle[];
  /** Lo que dice GOOGLE_REDIRECT_URI, ya limpio; null si falta. */
  redirect: string | null;
  /** El valor exacto que debe tener GOOGLE_REDIRECT_URI para el ERP que se está usando (sale de
   *  la dirección desde la que se abrió la pantalla); null si no se sabe. */
  redirect_sugerido: string | null;
  problema_redirect: ProblemaRedirect | null;
  /** Con esto NO se puede conectar: falta una variable o el redirect no puede funcionar nunca. */
  bloquea: boolean;
  /** La frase entera, con el arreglo; null si no hay nada que decir. */
  texto: string | null;
};

const esLocal = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";
/** `www.` no hace otro sitio: Vercel redirige el uno al otro y el callback llega igual. */
const sinWww = (host: string) => host.toLowerCase().replace(/^www\./, "");
const enLista = (xs: readonly string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} y ${xs[xs.length - 1]}`;

function urlHttp(v: string | null | undefined): URL | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch { return null; }
}

/**
 * Qué falta o qué está mal en el cliente OAuth, dicho con el arreglo. `origen` es la dirección
 * desde la que se usa el ERP: de ahí sale el valor exacto de GOOGLE_REDIRECT_URI. Se sugiere
 * SIEMPRE con https fuera de localhost —Google no acepta otra cosa en producción, y detrás de un
 * proxy el servidor puede ver `http:` aunque el navegador esté en https—, y por lo mismo se
 * compara el SITIO (host sin `www.` y puerto), no el protocolo.
 */
export function diagnosticarGoogle(
  env: Partial<Record<VariableGoogle, string | null | undefined>>,
  origen?: string | null,
): DiagnosticoGoogle {
  const faltan = VARIABLES_GOOGLE.filter((k) => !limpiarValorEnv(env[k]));
  const redirect = limpiarValorEnv(env.GOOGLE_REDIRECT_URI) || null;
  const base = urlHttp(origen);
  const redirect_sugerido = base
    ? `${esLocal(base.hostname) ? base.protocol : "https:"}//${base.host}${RUTA_CALLBACK_GMAIL}`
    : null;
  const correcto = redirect_sugerido ?? `https://TU-DOMINIO${RUTA_CALLBACK_GMAIL}`;

  let problema: ProblemaRedirect | null = null;
  const u = urlHttp(redirect);
  if (redirect) {
    if (!u) problema = "invalido";
    else if (u.protocol !== "https:" && !esLocal(u.hostname)) problema = "no_https";
    else if (u.pathname.replace(/\/+$/, "") !== RUTA_CALLBACK_GMAIL) problema = "otra_ruta";
    else if (base && (sinWww(u.hostname) !== sinWww(base.hostname) || u.port !== base.port)) problema = "otro_sitio";
  }

  const partes: string[] = [];
  if (faltan.length) {
    partes.push(`Falta${faltan.length > 1 ? "n" : ""} en Vercel ${enLista(faltan)}.`);
    if (faltan.includes("GOOGLE_REDIRECT_URI")) {
      partes.push(`El valor de GOOGLE_REDIRECT_URI es ${correcto} (la misma dirección se autoriza en Google Cloud).`);
    }
  }
  if (problema === "invalido") partes.push(`GOOGLE_REDIRECT_URI («${redirect}») no es una dirección completa: tiene que ser ${correcto}.`);
  if (problema === "no_https") partes.push(`GOOGLE_REDIRECT_URI («${redirect}») tiene que empezar con https://: ${correcto}.`);
  if (problema === "otra_ruta") {
    partes.push(`GOOGLE_REDIRECT_URI («${redirect}») no lleva al ERP: tiene que terminar en ${RUTA_CALLBACK_GMAIL}, o sea ${correcto}.`);
  }
  if (problema === "otro_sitio" && u && base) {
    partes.push(
      `GOOGLE_REDIRECT_URI apunta a ${u.host} y el ERP se está usando en ${base.host}: al volver de Google se termina en ${u.host}. ` +
      `Si no es a propósito, cámbiala a ${correcto} y autoriza esa dirección en Google Cloud.`,
    );
  }
  if (partes.length) partes.push("Después de guardar en Vercel hay que hacer Redeploy: las variables solo entran en un despliegue nuevo.");

  return {
    faltan,
    redirect,
    redirect_sugerido,
    problema_redirect: problema,
    bloquea: faltan.length > 0 || (problema !== null && problema !== "otro_sitio"),
    texto: partes.length ? partes.join(" ") : null,
  };
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
