// ──────────────────────────────────────────────────────────────────────────────
// lib/redes/publicadores/tipos.ts — El contrato que cumple cada plataforma.
//
// Un publicador recibe una pieza ya validada por el motor y devuelve SIEMPRE un
// resultado, nunca lanza. Quien lo llama (lib/redes/despachar.ts) está a mitad de un
// bucle de cinco redes: una excepción que suba ahí abortaría las que faltan, y el
// operador vería «no se publicó nada» cuando en realidad Facebook ya había salido.
//
// `ok: false` con el error CRUDO de la plataforma es deliberado. El catálogo evita la
// llamada imposible; esto es lo que queda cuando la plataforma rechaza por algo que no
// está escrito en ninguna documentación (su clasificador, una canción con copyright,
// una verificación pendiente). Interpretarlo aquí sería inventar una causa.
// ──────────────────────────────────────────────────────────────────────────────

import type { CuentaRed } from "../cuentas";

export type PiezaAPublicar = {
  texto: string;
  /** Solo YouTube lo usa. Los demás publican `texto` como caption. */
  titulo?: string | null;
  media: { tipo: "imagen" | "video"; url: string } | null;
};

export type ResultadoPublicacion = {
  ok: boolean;
  /** El id que devuelve la plataforma. Es lo que demuestra que salió. */
  id_externo?: string;
  /** Enlace directo al post, cuando se puede componer sin otra llamada. */
  url?: string;
  /** Error crudo, sin interpretar. */
  error?: string;
  /**
   * Un matiz que el operador tiene que saber aunque la publicación haya salido bien:
   * «quedó como borrador», «YouTube la puso en privado». Sale sobre fondo azul, no
   * ámbar: no es un fallo, es lo que la plataforma hizo con ella.
   */
  nota?: string;
};

export type Publicador = (
  cuenta: CuentaRed,
  pieza: PiezaAPublicar,
) => Promise<ResultadoPublicacion>;

/**
 * Lee la respuesta de una API dejando SIEMPRE algo que se pueda leer en pantalla.
 *
 * Un `res.json()` sobre un 502 con HTML de un balanceador lanza `Unexpected token <`,
 * y ese es el texto que acabaría guardado como «por qué no se publicó» — o sea, el
 * operador leyendo un error de parseo en vez del de la plataforma.
 */
export async function leerRespuesta(res: Response): Promise<{ ok: boolean; json: any; texto: string }> {
  const texto = await res.text();
  let json: any = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch {
    /* no era JSON: nos quedamos con el texto crudo */
  }
  return { ok: res.ok, json, texto };
}

/** El mensaje más útil que se pueda sacar de una respuesta fallida. */
export function errorDe(res: Response, json: any, texto: string): string {
  const meta = json?.error?.message ?? json?.error?.error_user_msg;
  const google = json?.error?.errors?.[0]?.message;
  const tiktok = json?.error?.message && json?.error?.code !== "ok" ? json.error.message : null;
  const detalle = meta ?? google ?? tiktok ?? texto.slice(0, 400) ?? "";
  return `HTTP ${res.status}${detalle ? " · " + detalle : ""}`;
}

/**
 * Espera con tope. Los contenedores de video de Instagram y TikTok se procesan en sus
 * servidores y hay que preguntar hasta que terminen.
 *
 * El tope NO es una comodidad: una ruta de Vercel se corta a los 60 s (`maxDuration`),
 * así que un sondeo sin límite no espera «hasta que termine», sino hasta que la función
 * muere a mitad — y entonces el destino se queda en `pendiente` sin error, que es el
 * estado del que nadie se entera. Con tope, el operador lee «seguía procesándose» y el
 * próximo tick lo recoge.
 */
export function esperar(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
