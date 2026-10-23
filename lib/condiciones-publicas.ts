// ──────────────────────────────────────────────────────────────────────────────
// lib/condiciones-publicas.ts — El ENLACE a las condiciones completas de reserva, cambios y
// cancelación de UNA cotización (`<dominio del ERP>/condiciones/<token>`), cuándo se resume la
// política, y el contrato de la respuesta pública. PURO y sin dependencias: lo importan el modelo
// del PDF (lib/cotizacion-corporativo.ts), los textos del WhatsApp (lib/traslados/reserva-pago.ts),
// la ruta pública (app/api/condiciones/[token]/route.ts) y la página /condiciones/[token].
//
// LA REGLA QUE NO SE AFLOJA: sin resumen O sin enlace, la política va ENTERA, como siempre. El
// resumen (4-5 puntos de dinero que escribe una persona: `condiciones_reserva_resumen`, copiado a la
// fila como `consideraciones_json.reserva_resumen`) solo reemplaza a la política cuando el cliente
// tiene a mano el texto completo: el enlace. Nunca se esconde lo que mueve dinero.
//
// EL ENLACE ABRE LA POLÍTICA GUARDADA EN ESA COTIZACIÓN (la fila, no la plantilla de hoy): es la
// constancia de lo que se le informó antes de pagar. Por eso el token es uno por cotización
// (`cotizaciones.condiciones_token`, supabase/cotizaciones-08) y la base solo puede ser un origen
// limpio (https://host, o http://localhost para probar): nada de rutas, consultas ni credenciales.
// ──────────────────────────────────────────────────────────────────────────────

/** La ruta pública de las condiciones (app/condiciones/[token]). */
export const RUTA_CONDICIONES = "/condiciones";

/** El SQL que agrega el resumen y el token. Sin él, el PDF y el WhatsApp siguen con la política entera. */
export const SQL_RESUMEN_CONDICIONES = "supabase/cotizaciones-08-resumen-condiciones.sql";

/** Un uuid (cualquier versión), sin llaves ni espacios. */
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lo más largo que puede ser el origen: un enlace desmesurado no cabe en el QR ni en un renglón del PDF. */
export const MAX_ORIGEN_CONDICIONES = 100;

const HOSTS_LOCALES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** ¿Es un token de condiciones (un uuid)? */
export function esTokenCondiciones(x: unknown): x is string {
  return typeof x === "string" && RE_UUID.test(x.trim());
}

/**
 * El origen limpio del ERP (`https://host[:puerto]`, o `http://localhost[:puerto]`), sin la barra
 * final, o null si no es eso: con ruta, consulta, fragmento, usuario o contraseña, otro protocolo, o
 * más largo que `MAX_ORIGEN_CONDICIONES`. Se aceptan las barras finales («https://x.pe/»).
 */
export function origenCondiciones(base: unknown): string | null {
  if (typeof base !== "string") return null;
  const b = base.trim().replace(/\/+$/, "");
  if (!b || /[\s"'<>\\`]/.test(b)) return null;
  let u: URL;
  try { u = new URL(b); } catch { return null; }
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return null;
  if (!u.hostname) return null;
  const local = HOSTS_LOCALES.has(u.hostname.toLowerCase());
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  const origen = `${u.protocol}//${u.host}`.toLowerCase();
  // El texto pedido tiene que ser ese origen (sin rarezas que `URL` normalice en silencio).
  if (origen !== b.toLowerCase()) return null;
  return origen.length <= MAX_ORIGEN_CONDICIONES ? origen : null;
}

/**
 * EL ENLACE A LAS CONDICIONES de una cotización: `${origen}/condiciones/${token}`, o null si la base
 * no es un origen limpio (`origenCondiciones`) o el token no es un uuid. Sin enlace, la política va
 * entera (`politicaParaImprimir`).
 */
export function enlaceCondiciones(base: unknown, token: unknown): string | null {
  const origen = origenCondiciones(base);
  if (!origen || !esTokenCondiciones(token)) return null;
  return `${origen}${RUTA_CONDICIONES}/${token.trim().toLowerCase()}`;
}

/** ¿Es exactamente un enlace que arma `enlaceCondiciones`? (lo que llega de fuera se comprueba antes de imprimirlo). */
export function esEnlaceCondiciones(x: unknown): x is string {
  if (typeof x !== "string") return false;
  const i = x.lastIndexOf(`${RUTA_CONDICIONES}/`);
  if (i <= 0) return false;
  return enlaceCondiciones(x.slice(0, i), x.slice(i + RUTA_CONDICIONES.length + 1)) === x;
}

// ── Cuándo se resume la política ─────────────────────────────────────────────

/** `completa`: la política entera (la de siempre). `resumen`: los puntos del resumen + el enlace. */
export type ModoPolitica = "completa" | "resumen";

export type PoliticaImprimible = {
  modo: ModoPolitica;
  /** Lo que se imprime como lista: la política (completa) o el resumen. Vacío = no se imprime nada. */
  items: string[];
  /** Solo en `resumen`: el enlace a la política completa. */
  enlace: string | null;
};

/** Las líneas como se imprimen: texto, sin las vacías (el contenido de cada una no se toca). */
export const lineasImprimibles = (l: unknown): string[] =>
  Array.isArray(l) ? l.map((x) => String(x ?? "")).filter((x) => x.trim() !== "") : [];

/**
 * QUÉ SE IMPRIME DE LA POLÍTICA DE RESERVA. `resumen` solo si hay política, el resumen tiene líneas
 * Y hay un enlace válido (`esEnlaceCondiciones`); si no, la política entera, como siempre (sin
 * política no se imprime nada, ni el enlace: la página diría «sin condiciones»).
 */
export function politicaParaImprimir(x: { politica: unknown; resumen?: unknown; enlace?: unknown }): PoliticaImprimible {
  const politica = lineasImprimibles(x.politica);
  if (!politica.length) return { modo: "completa", items: [], enlace: null };
  const resumen = lineasImprimibles(x.resumen);
  if (resumen.length && esEnlaceCondiciones(x.enlace)) return { modo: "resumen", items: resumen, enlace: x.enlace };
  return { modo: "completa", items: politica, enlace: null };
}

// ── La respuesta de GET /api/condiciones/[token] ─────────────────────────────

/** Lo que la página pública enseña de la empresa (de `empresa_perfil`; null = sin configurar). */
export type EmpresaCondiciones = {
  nombre: string | null;
  razon_social: string | null;
  ruc: string | null;
  logo_url: string | null;
  web: string | null;
  telefono: string | null;
  email: string | null;
};

export type CondicionesPublicasOk = {
  ok: true;
  empresa: EmpresaCondiciones;
  /** El número que imprime el PDF (`numeroCotizacion`). */
  numero: string;
  /** La fecha de emisión de la cotización, en hora de Lima (AAAA-MM-DD), o null. */
  emitida: string | null;
  idioma: "es" | "en";
  /** La política de reserva, cambios y cancelación guardada en ESA cotización. Nunca vacía. */
  politica: string[];
  /** Su resumen (puede ir vacío). */
  resumen: string[];
};

/** `no_existe`: el token no es un uuid o no es de ninguna cotización. `sin_condiciones`: la cotización no guardó política. `sin_migracion`: falta el SQL. */
export type CodigoCondicionesPublicas = "no_existe" | "sin_condiciones" | "sin_migracion" | "demasiadas" | "error";

export type CondicionesPublicasError = { ok: false; codigo: CodigoCondicionesPublicas; detalle: string };

export type RespuestaCondicionesPublicas = CondicionesPublicasOk | CondicionesPublicasError;

/** Los textos (en castellano) de cada error de la ruta pública: una sola definición para la ruta y la página. */
export const DETALLE_CONDICIONES: Record<CodigoCondicionesPublicas, string> = {
  no_existe: "Este enlace no corresponde a ninguna cotización. Revisa que esté completo o pide uno nuevo a quien te lo envió.",
  sin_condiciones: "Esta cotización no tiene condiciones de reserva, cambios y cancelación guardadas. Pide las condiciones a quien te envió la cotización.",
  sin_migracion: "Las condiciones todavía no están disponibles en línea. Pide las condiciones a quien te envió la cotización.",
  demasiadas: "Demasiadas consultas seguidas. Espera un minuto y vuelve a abrir el enlace.",
  error: "No se pudieron cargar las condiciones. Vuelve a intentar en un momento.",
};
