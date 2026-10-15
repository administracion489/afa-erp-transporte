// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/db.ts — SOLO SERVIDOR. Escritura degradable de RRHH.
//
// La migración supabase/rrhh-01-perfil-asistencia.sql EL DEPLOY NO LA CORRE. Por eso cada
// escritura de este módulo tiene que poder toparse con:
//   · la TABLA entera ausente (nadie corrió el SQL)        → señal `sinMigracion`, 422 arriba.
//   · una COLUMNA accesoria ausente (una migración posterior aún no corrida, o una columna
//     que todavía no está en el esquema que ve PostgREST)  → se SUELTA la que el error NOMBRA
//     y se reintenta. Nunca a ciegas: si el error no nombra la columna (PGRST204/42703 sin
//     parsear) o es OTRA cosa (CHECK, FK, red), se devuelve el error — un reintento ciego de
//     un INSERT duplicaría la fila.
//
// Se apoya en lib/columna-faltante.ts (la única que entiende las dos formas: PostgREST en el
// INSERT/UPDATE y Postgres en el SELECT). `run` recibe la fila (mutable entre reintentos) y
// corre el INSERT / UPSERT / UPDATE: así el mismo motor sirve para los tres.
// ──────────────────────────────────────────────────────────────────────────────

import { columnaFaltante, tablaFaltante } from "@/lib/columna-faltante";

export type ResultadoEscritura<T = Record<string, unknown>> = {
  ok: boolean;
  data: T | null;
  /** La tabla entera no existe: falta correr el SQL de la fase. */
  sinMigracion: boolean;
  /** Columnas accesorias que se soltaron para que la escritura entrara. */
  columnasOmitidas: string[];
  error: { message: string; code?: string | null } | null;
};

const MAX_REINTENTOS = 12;

/**
 * Corre una escritura soltando la columna que el error nombra y reintentando. `tabla` es el
 * nombre (sin esquema) para distinguir «falta la tabla» de «falta una columna».
 */
export async function escribirDegradando<T = Record<string, unknown>>(
  tabla: string,
  fila: Record<string, unknown>,
  // `run` devuelve el builder de Supabase tal cual (es PromiseLike, no Promise): se awaitea aquí.
  run: (fila: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<ResultadoEscritura<T>> {
  const actual: Record<string, unknown> = { ...fila };
  const omitidas: string[] = [];

  for (let i = 0; i < MAX_REINTENTOS; i++) {
    const { data, error } = await run(actual);
    if (!error) {
      const row = Array.isArray(data) ? (data[0] ?? null) : data;
      return { ok: true, data: (row as T) ?? null, sinMigracion: false, columnasOmitidas: omitidas, error: null };
    }
    const err = error as { message?: string | null; code?: string | null };

    // La tabla entera no existe → falta la migración. No es una columna que soltar.
    if (tablaFaltante(err, tabla)) {
      return { ok: false, data: null, sinMigracion: true, columnasOmitidas: omitidas,
        error: { message: String(err.message ?? ""), code: err.code ?? null } };
    }

    // ¿El error nombra una columna que de verdad estamos mandando? Se suelta y se reintenta.
    const col = columnaFaltante(err);
    if (col && col in actual) {
      delete actual[col];
      omitidas.push(col);
      continue;
    }

    // Columna faltante sin nombre (col === "") u OTRO error: no se reintenta a ciegas.
    return { ok: false, data: null, sinMigracion: false, columnasOmitidas: omitidas,
      error: { message: String(err.message ?? ""), code: err.code ?? null } };
  }
  return { ok: false, data: null, sinMigracion: false, columnasOmitidas: omitidas,
    error: { message: "demasiados reintentos soltando columnas" } };
}
