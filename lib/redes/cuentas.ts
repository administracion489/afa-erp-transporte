// ──────────────────────────────────────────────────────────────────────────────
// lib/redes/cuentas.ts — SOLO SERVIDOR. Las credenciales de publicación.
//
// NO SE INVENTA UN SEGUNDO CIFRADO. Reutiliza `cifrar`/`descifrar` de
// lib/meta-tokens.ts, que ya guarda los tokens de WhatsApp con AES-256-GCM y la
// misma `TOKEN_ENCRYPTION_KEY`. Dos módulos que cifran credenciales con dos formatos
// es cómo el día de la rotación uno se queda sin poder leer lo del otro — y aquí lo
// que se pierde es la capacidad de publicar, sin ningún mensaje que lo explique.
//
// Un token de publicación permite escribir en la cara pública de la empresa. Vale
// exactamente lo mismo que el de WhatsApp y recibe el mismo trato: cifrado en reposo,
// `redes_cuentas` sin política RLS permisiva (solo service-role), y NUNCA al navegador.
// Por eso existe `cuentasParaPantalla()`: la UI necesita saber qué hay conectado y qué
// caducó, y eso no requiere ver ni un carácter del token.
// ──────────────────────────────────────────────────────────────────────────────

import { createClient } from "@supabase/supabase-js";
import { cifrar, descifrar, cifradoDisponible } from "@/lib/meta-tokens";
import type { Red } from "./tipos";
import type { CuentaConectada } from "./plan";

function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export type CuentaRed = {
  id: number;
  red: Red;
  nombre_cuenta: string | null;
  cuenta_externa_id: string | null;
  token: string | null;
  refresh: string | null;
  token_expira_en: string | null;
  vigente: boolean;
  ultimo_error: string | null;
  destino_telefono: string | null;
};

/** Lo único que la pantalla necesita, y nada de lo que no debe ver. */
export type CuentaPublica = Omit<CuentaRed, "token" | "refresh">;

/**
 * La cuenta vigente de una red, con el token ya descifrado. SOLO servidor.
 *
 * Devuelve `null` con la misma cara en tres casos distintos —no hay fila, no hay
 * `TOKEN_ENCRYPTION_KEY`, el descifrado falló— y eso es deliberado: quien llama solo
 * puede hacer una cosa (no publicar). El detalle para el operador lo da
 * `diagnosticoCuentas()`, que es lo que pinta la pantalla de Cuentas.
 */
export async function cuentaDe(red: Red): Promise<CuentaRed | null> {
  const sb = db();
  if (!sb) return null;
  const { data } = await sb
    .from("redes_cuentas")
    .select("*")
    .eq("red", red)
    .eq("vigente", true)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    red: data.red,
    nombre_cuenta: data.nombre_cuenta,
    cuenta_externa_id: data.cuenta_externa_id,
    token: data.token_cifrado ? descifrar(data.token_cifrado) : null,
    refresh: data.refresh_cifrado ? descifrar(data.refresh_cifrado) : null,
    token_expira_en: data.token_expira_en,
    vigente: data.vigente,
    ultimo_error: data.ultimo_error,
    destino_telefono: data.destino_telefono,
  };
}

/**
 * Lo que el motor necesita saber de cada red: si hay cuenta, si sirve y cuánto lleva
 * publicado hoy.
 *
 * `publicadas_hoy` se DERIVA contando `redes_destinos` publicados hoy, no se guarda en
 * un contador: un contador hay que resetearlo a medianoche desde algún sitio, y el día
 * que ese cron falle la cuota quedaría agotada para siempre sin que nadie entienda por
 * qué. Contar es exacto y no tiene estado que mantener. (Misma regla que
 * `monto_rendido` en caja chica: se deriva, no se guarda.)
 */
export async function cuentasParaPlan(hoyLima: string): Promise<CuentaConectada[]> {
  const sb = db();
  if (!sb) return [];

  const { data: filas } = await sb
    .from("redes_cuentas")
    .select("red, vigente, token_cifrado, destino_telefono")
    .eq("vigente", true);
  if (!filas?.length) return [];

  // Las publicaciones de hoy, para la cuota. Se cuenta sobre `publicado`, nunca sobre
  // `preparado` ni `fallido`: un intento que no llegó a salir no gasta cuota.
  const { data: pubs } = await sb
    .from("redes_publicaciones")
    .select("id")
    .eq("fecha", hoyLima);
  const ids = (pubs ?? []).map((p: any) => p.id);

  const conteo = new Map<string, number>();
  if (ids.length) {
    const { data: dests } = await sb
      .from("redes_destinos")
      .select("red")
      .in("publicacion_id", ids)
      .eq("estado", "publicado");
    for (const d of dests ?? []) conteo.set(d.red, (conteo.get(d.red) ?? 0) + 1);
  }

  return filas.map((f: any) => ({
    red: f.red as Red,
    // Una cuenta marcada vigente cuyo token no se puede descifrar NO es vigente: el
    // publicador fallaría con un 401 y el operador leería "la plataforma rechazó",
    // cuando lo que pasa es que falta `TOKEN_ENCRYPTION_KEY` en el entorno.
    // El estado de WhatsApp no lleva token: su credencial es el número de destino.
    vigente:
      f.red === "whatsapp_estado"
        ? Boolean(f.destino_telefono)
        : Boolean(f.token_cifrado && descifrar(f.token_cifrado)),
    publicadas_hoy: conteo.get(f.red) ?? 0,
  }));
}

/** Para la pantalla. Nunca devuelve token ni refresh. */
export async function cuentasParaPantalla(): Promise<CuentaPublica[]> {
  const sb = db();
  if (!sb) return [];
  const { data } = await sb
    .from("redes_cuentas")
    .select("id, red, nombre_cuenta, cuenta_externa_id, token_expira_en, vigente, ultimo_error, destino_telefono")
    .order("red");
  return (data ?? []) as CuentaPublica[];
}

export type ResultadoGuardado = { ok: boolean; aviso?: string };

/**
 * Conecta (o reconecta) una cuenta.
 *
 * SIN `TOKEN_ENCRYPTION_KEY` NO SE GUARDA NADA, y se dice. Es la misma decisión que
 * `guardarToken` en meta-tokens.ts: guardar el token en claro «por ahora» convierte
 * una tabla de Supabase en el sitio desde el que alguien publica en nombre de la
 * empresa. Mejor no conectar y decir por qué.
 */
export async function guardarCuenta(opts: {
  red: Red;
  nombre_cuenta?: string | null;
  cuenta_externa_id?: string | null;
  token?: string | null;
  refresh?: string | null;
  token_expira_en?: string | null;
  destino_telefono?: string | null;
}): Promise<ResultadoGuardado> {
  const sb = db();
  if (!sb) return { ok: false, aviso: "Sin credenciales de Supabase en el servidor." };

  const necesitaToken = opts.red !== "whatsapp_estado";
  if (necesitaToken && opts.token && !cifradoDisponible()) {
    return {
      ok: false,
      aviso:
        "Falta TOKEN_ENCRYPTION_KEY en el entorno: no se guarda un token de publicación " +
        "en texto plano. Configúrala en Vercel y vuelve a conectar.",
    };
  }

  // Las cuentas anteriores de esa red se jubilan en vez de borrarse: `redes_destinos`
  // conserva qué se publicó y con qué cuenta, y borrar la fila dejaría ese historial
  // apuntando a nada. El índice único parcial exige que solo quede una vigente.
  await sb.from("redes_cuentas").update({ vigente: false }).eq("red", opts.red).eq("vigente", true);

  const { error } = await sb.from("redes_cuentas").insert({
    red: opts.red,
    nombre_cuenta: opts.nombre_cuenta ?? null,
    cuenta_externa_id: opts.cuenta_externa_id ?? null,
    token_cifrado: opts.token ? cifrar(opts.token) : null,
    refresh_cifrado: opts.refresh ? cifrar(opts.refresh) : null,
    token_expira_en: opts.token_expira_en ?? null,
    destino_telefono: opts.destino_telefono ?? null,
    vigente: true,
  });

  if (error) return { ok: false, aviso: error.message };
  return { ok: true };
}

/**
 * La plataforma dijo que el token ya no sirve.
 *
 * Se marca `vigente = false` y el motor lo lee como `cuenta_caducada`, que es un ámbar
 * en la pantalla. Lo importante es que se llame SOLO ante un 401/190/revocado: bajar la
 * bandera por un 500 pasajero de Meta apagaría la red hasta que alguien la reconectara
 * a mano, que es un daño mucho mayor que reintentar mañana.
 */
export async function marcarCuentaCaducada(red: Red, error: string): Promise<void> {
  const sb = db();
  if (!sb) return;
  await sb
    .from("redes_cuentas")
    .update({ vigente: false, ultimo_error: error.slice(0, 500), actualizado_en: new Date().toISOString() })
    .eq("red", red)
    .eq("vigente", true);
}

export async function marcarCuentaOk(red: Red): Promise<void> {
  const sb = db();
  if (!sb) return;
  await sb
    .from("redes_cuentas")
    .update({ ultimo_ok_en: new Date().toISOString(), ultimo_error: null })
    .eq("red", red)
    .eq("vigente", true);
}

/**
 * ¿Este error de la plataforma significa que la credencial murió, o que el intento
 * salió mal?
 *
 * Distinguirlos es lo que separa «reintenta mañana» de «hay que reconectar la cuenta»,
 * y colapsarlos tiene las dos direcciones caras: tratar todo como caducado apaga una
 * red buena al primer hipo de la API; tratar nada como caducado deja al operador
 * viendo «falló» cada día sin que nada le diga que el token se revocó hace una semana.
 */
export function esCredencialMuerta(err: unknown): boolean {
  const txt = String((err as any)?.message ?? err ?? "").toLowerCase();
  return (
    txt.includes("invalid_grant") ||
    txt.includes("invalid_token") ||
    txt.includes("access token") ||
    txt.includes("oauthexception") ||
    // Códigos de Meta: 190 = token inválido/caducado, 102 = sesión caducada.
    /\bcode["\s:]*190\b/.test(txt) ||
    /\bcode["\s:]*102\b/.test(txt) ||
    txt.includes("401") ||
    txt.includes("unauthorized")
  );
}
