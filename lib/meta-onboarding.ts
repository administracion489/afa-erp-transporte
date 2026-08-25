// lib/meta-onboarding.ts — SOLO SERVIDOR.
//
// Las llamadas a la Graph API que hay que hacer DESPUÉS de que el Embedded Signup
// termina en el navegador. Sin ellas el número queda a medio conectar: el usuario
// ve "conectado ✓" en la ventana de Meta pero el ERP no puede ni enviar ni recibir.
//
// ┌─ EL DETALLE QUE ROMPÍA TODO ────────────────────────────────────────────────┐
// │ El `code` que devuelve el Embedded Signup vive **30 segundos**.             │
// │ Antes el modal lo mostraba en pantalla con un "guárdalo, aún falta          │
// │ activarlo": para cuando alguien lo copiaba ya estaba vencido, así que la    │
// │ conexión NUNCA llegaba a completarse. El canje tiene que salir del          │
// │ navegador al servidor en el mismo instante en que Meta lo entrega.          │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// COEXISTENCIA (el número sigue en el celular y además entra a la Cloud API):
// el paso `POST /{phone_number_id}/register` de la conexión clásica NO se hace —
// el número ya está registrado por la app WhatsApp Business. Llamarlo es lo que
// desvincularía el teléfono, justo lo que la coexistencia evita. En su lugar se
// piden las dos sincronizaciones de `smb_app_data` (contactos e historial).

const GRAPH_VERSION = "v25.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

/** App de Meta del ERP. El id también está en el cliente (no es secreto); el secret jamás. */
export function appId(): string | undefined {
  return process.env.META_APP_ID ?? process.env.NEXT_PUBLIC_META_APP_ID;
}
function appSecret(): string | undefined {
  return process.env.META_APP_SECRET;
}

/** Mensaje de error de Graph, prefiriendo el redactado para humanos. */
function errorDeGraph(d: any, porDefecto: string): string {
  const e = d?.error;
  if (!e) return porDefecto;
  const partes = [e.error_user_msg || e.message || porDefecto];
  if (e.code) partes.push(`(código ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""})`);
  return partes.join(" ");
}

async function graph(
  url: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ ok: boolean; data: any }> {
  const { token, ...resto } = init;
  const res = await fetch(url, {
    ...resto,
    headers: {
      ...(resto.headers ?? {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(resto.body ? { "Content-Type": "application/json" } : {}),
    },
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

// ── 1) Canje del código por el token de negocio ────────────────────────────

export type TokenNegocio = { token: string; expiresIn: number | null };

/**
 * Cambia el `code` del Embedded Signup por el business integration system user
 * access token de la empresa que acaba de conectarse.
 *
 * Es un GET a /oauth/access_token con el app secret. NO lleva `redirect_uri` ni
 * `grant_type`: este canje es el de Facebook Login for Business, no el OAuth web
 * clásico, y añadirlos hace que Meta responda "redirect_uri isn't an absolute URI".
 */
export async function canjearCodigo(code: string): Promise<TokenNegocio> {
  const id = appId();
  const secret = appSecret();
  if (!id) throw new Error("Falta META_APP_ID en el entorno del servidor.");
  if (!secret) {
    throw new Error(
      "Falta META_APP_SECRET en el entorno del servidor. Está en el panel de Meta → Configuración de la app → Básica → Clave secreta de la app.",
    );
  }

  const url =
    `${GRAPH}/oauth/access_token` +
    `?client_id=${encodeURIComponent(id)}` +
    `&client_secret=${encodeURIComponent(secret)}` +
    `&code=${encodeURIComponent(code)}`;

  const { ok, data } = await graph(url);
  if (!ok || !data?.access_token) {
    // El fallo más común y el más confuso: el código venció. Meta lo reporta como
    // un OAuthException genérico, así que se traduce a algo accionable.
    const bruto = errorDeGraph(data, "No se pudo canjear el código.");
    const vencido = /expired|invalid.*code|been used/i.test(bruto);
    throw new Error(
      vencido
        ? `El código de autorización ya venció (dura 30 segundos) o ya se usó. Vuelve a tocar "Conectar mi WhatsApp" y deja que termine solo. Detalle de Meta: ${bruto}`
        : bruto,
    );
  }
  return {
    token: String(data.access_token),
    expiresIn: Number.isFinite(Number(data.expires_in)) ? Number(data.expires_in) : null,
  };
}

// ── 2) Suscribir la app del ERP a los webhooks de esa cuenta ───────────────

/**
 * Sin esto no llega NINGÚN mensaje: el webhook se configura a nivel de app, pero
 * cada WABA tiene que suscribir la app explícitamente. Es el paso que más se
 * olvida, y su síntoma es "conecté el número y el Inbox sigue vacío".
 */
export async function suscribirApp(wabaId: string, token: string): Promise<void> {
  const { ok, data } = await graph(`${GRAPH}/${wabaId}/subscribed_apps`, { method: "POST", token });
  if (!ok) throw new Error(errorDeGraph(data, "No se pudo suscribir la app a la cuenta de WhatsApp."));
}

// ── 3) Verificar cómo quedó el número ──────────────────────────────────────

export type EstadoNumero = {
  display_phone_number: string | null; // normalizado a dígitos, como lo manda el webhook
  verified_name: string | null;
  is_on_biz_app: boolean | null;
  platform_type: string | null;
};

/**
 * Confirma contra Meta que el número quedó bien. En coexistencia se espera
 * `is_on_biz_app: true` (sigue en la app del celular) y `platform_type: "CLOUD_API"`.
 * Si `is_on_biz_app` viene false en un onboarding de coexistencia, el número
 * quedó como API pura: el teléfono se desvinculó y hay que revisarlo.
 */
export async function verificarNumero(phoneNumberId: string, token: string): Promise<EstadoNumero> {
  const { ok, data } = await graph(
    `${GRAPH}/${phoneNumberId}?fields=display_phone_number,verified_name,is_on_biz_app,platform_type`,
    { token },
  );
  if (!ok) throw new Error(errorDeGraph(data, "No se pudo consultar el número en Meta."));
  return {
    // Meta lo devuelve como "+51 966 707 225"; el webhook lo manda como
    // "51966707225". Se normaliza a la forma del webhook para poder cruzarlos.
    display_phone_number: data.display_phone_number
      ? String(data.display_phone_number).replace(/\D/g, "")
      : null,
    verified_name: data.verified_name ?? null,
    is_on_biz_app: typeof data.is_on_biz_app === "boolean" ? data.is_on_biz_app : null,
    platform_type: data.platform_type ?? null,
  };
}

// ── 4) Sincronizaciones propias de la coexistencia ─────────────────────────

export type TipoSync = "smb_app_state_sync" | "history";

/**
 * Pide a Meta que reenvíe por webhook los contactos (`smb_app_state_sync`) o hasta
 * seis meses de conversaciones (`history`) que ya estaban en el celular.
 *
 * ⚠️ Meta solo acepta esto dentro de las **24 h** siguientes al onboarding. Pasado
 * el plazo hay que dar de baja el número y repetir todo el proceso, así que se
 * dispara de inmediato al conectar y se guarda la fecha en `whatsapp_numeros`.
 *
 * Los datos NO llegan en esta respuesta: llegan después, por el webhook.
 */
export async function sincronizarDatosApp(
  phoneNumberId: string,
  token: string,
  tipo: TipoSync,
): Promise<void> {
  const { ok, data } = await graph(`${GRAPH}/${phoneNumberId}/smb_app_data`, {
    method: "POST",
    token,
    body: JSON.stringify({ messaging_product: "whatsapp", sync_type: tipo }),
  });
  if (!ok) throw new Error(errorDeGraph(data, `No se pudo pedir la sincronización (${tipo}).`));
}
