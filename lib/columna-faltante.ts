// ──────────────────────────────────────────────────────────────────────────────
// lib/columna-faltante.ts — Motor PURO: ¿el error de Supabase dice que falta una COLUMNA, y cuál?
//
// EL RADAR DEJÓ DE GUARDAR RECARGAS DEL 14/09 AL 06/10 POR NO SABER LEER ESTE ERROR.
// La fila de `radar_combustible` empezó a llevar `nivel_tanque`, de una migración que el deploy no
// corre (combustible-02). El respaldo «si falta la columna, se suelta y se reintenta» existía, pero
// reconocía solo el texto de Postgres —`column "x" … does not exist`—, y en un INSERT o un UPDATE
// quien rechaza la columna no es Postgres: es PostgREST, ANTES de llegar a la base, con otro código
// y otra frase:
//
//     PGRST204 · Could not find the 'nivel_tanque' column of 'radar_combustible' in the schema cache
//
// El respaldo no lo reconoció, lanzó, y cada recarga se perdió entera durante tres semanas.
//
// LAS DOS FORMAS, Y CUÁNDO SALE CADA UNA:
//   • INSERT / UPDATE / UPSERT con una clave que la tabla no tiene → PGRST204 (PostgREST).
//   • SELECT, filtro u orden sobre una columna que no existe       → 42703   (Postgres).
// Un chequeo escrito mirando solo una de las dos funciona en un camino y falla en el otro. Por eso
// vive aquí, una vez, y devuelve el NOMBRE de la columna: quien reintenta suelta LA QUE EL ERROR
// NOMBRA, no un juego fijo (con un juego fijo el aviso acaba acusando a la migración equivocada).
// ──────────────────────────────────────────────────────────────────────────────

export type ErrorSupabase = { code?: string | null; message?: string | null } | null | undefined;

const RE_POSTGREST = /could not find the ['"]?([\w.]+)['"]? column of ['"]?[\w.]+['"]? in the schema cache/i;
const RE_POSTGRES_RELACION = /column ["']?([\w]+)["']? of relation ["']?[\w.]+["']? does not exist/i;
const RE_POSTGRES = /column ["']?([\w.]+)["']? does not exist/i;

/**
 * La columna que el error dice que no existe, o null si el error es OTRA cosa (un CHECK, un permiso,
 * una red caída). `""` si es seguro que falta una columna pero el mensaje no dice cuál.
 */
export function columnaFaltante(error: ErrorSupabase): string | null {
  if (!error) return null;
  const msg = String(error.message ?? "");
  const m = RE_POSTGREST.exec(msg) ?? RE_POSTGRES_RELACION.exec(msg) ?? RE_POSTGRES.exec(msg);
  if (m) {
    // `tabla.columna` (forma del SELECT) → solo la columna.
    const partes = m[1].split(".");
    return partes[partes.length - 1].toLowerCase();
  }
  if (error.code === "PGRST204" || error.code === "42703") return "";
  return null;
}

/** ¿Falta una columna? Con `columna`, solo si el error nombra ESA. */
export function faltaColumna(error: ErrorSupabase, columna?: string): boolean {
  const c = columnaFaltante(error);
  if (c == null) return false;
  if (!columna) return true;
  return c === columna.toLowerCase();
}

/** De una lista de columnas accesorias, la que el error nombra (para soltarla y reintentar). */
export function faltaAlguna<T extends string>(error: ErrorSupabase, columnas: readonly T[]): T | null {
  const c = columnaFaltante(error);
  if (!c) return null;
  return columnas.find((x) => x.toLowerCase() === c) ?? null;
}
