// ──────────────────────────────────────────────────────────────────────────────
// lib/cotizacion-plantillas-datos.ts — Lee las plantillas del PDF y sus reglas de uso. Recibe el
// cliente de Supabase (navegador con la sesión, o servidor con service-role). La regla vive en
// lib/cotizacion-plantillas.ts (PURO); aquí solo se lee.
//
// UNA LECTURA QUE FALLA NO ES UNA LISTA VACÍA. Sin reglas, cada cotización usa la principal, y en
// el traslado de la IA eso cambia qué condiciones se le mandan al cliente: tomar un error por «no
// hay reglas» elegiría en silencio otra plantilla. Por eso:
//   · `reglas: null` SOLO si la tabla no existe (falta supabase/cotizaciones-05: el comportamiento
//     de antes, y quien llama lo dice);
//   · cualquier otro error → `ok: false` con el motivo en `error`, y quien llama decide (la IA
//     deriva; la pantalla lo pinta).
// `sinDiseno`: las filas no traen la columna `diseno` (la misma migración sin correr): el diseño
// sale del id (`disenoDe`), y duplicar no se ofrece.
// `reglasTraslado` (idioma × moneda del traslado de la IA, cotizaciones-09) sigue la MISMA regla:
// null SOLO si falta su tabla (la IA cotiza en castellano con las reglas viejas, como antes); otro
// error → `ok: false`. Sin la tabla vieja tampoco puede existir la nueva: null.
// ──────────────────────────────────────────────────────────────────────────────

import { tablaFaltante } from "./columna-faltante";
import {
  normalizarReglas, normalizarReglasTraslado, TABLA_PLANTILLAS, TABLA_REGLAS, TABLA_REGLAS_TRASLADO,
  type PlantillaFila, type ReglaPlantilla, type ReglaTraslado,
} from "./cotizacion-plantillas";

// El cliente llega de varios sitios (servidor con service-role, navegador): se tipa lo mínimo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

export type LecturaPlantillas =
  | { ok: true; plantillas: PlantillaFila[]; reglas: ReglaPlantilla[] | null; reglasTraslado: ReglaTraslado[] | null; sinDiseno: boolean; error: null }
  | { ok: false; plantillas: PlantillaFila[]; reglas: null; reglasTraslado: null; sinDiseno: boolean; error: string };

const PAGINA = 1000;
/** Techo de sanidad (no operativo): una base con más plantillas que esto tiene otro problema. */
const MAX_PLANTILLAS = 5000;

const msg = (e: unknown): string => String((e as { message?: unknown })?.message ?? e ?? "error desconocido");

/** Todas las plantillas (con todas sus columnas), en orden total: `orden`, luego `id`. */
async function leerPlantillas(sb: Sb): Promise<{ filas: PlantillaFila[]; faltaTabla: boolean; error: string | null }> {
  const filas: PlantillaFila[] = [];
  for (let desde = 0; desde < MAX_PLANTILLAS; desde += PAGINA) {
    let r: { data: unknown[] | null; error: { code?: string; message?: string } | null };
    try {
      r = await sb.from(TABLA_PLANTILLAS).select("*")
        .order("orden", { ascending: true, nullsFirst: false }).order("id", { ascending: true })
        .range(desde, desde + PAGINA - 1);
    } catch (e) {
      return { filas: [], faltaTabla: false, error: msg(e) };
    }
    if (r.error) {
      if (tablaFaltante(r.error, TABLA_PLANTILLAS)) return { filas: [], faltaTabla: true, error: null };
      return { filas: [], faltaTabla: false, error: msg(r.error) };
    }
    const data = r.data ?? [];
    for (const f of data) {
      if (f && typeof f === "object" && typeof (f as { id?: unknown }).id === "string" && (f as { id: string }).id.trim()) {
        const p = f as PlantillaFila;
        filas.push({ ...p, nombre: typeof p.nombre === "string" ? p.nombre : p.id });
      }
    }
    if (data.length < PAGINA) break;
  }
  return { filas, faltaTabla: false, error: null };
}

/** Las plantillas y las reglas de uso. Ver la cabecera: `reglas: null` solo si falta la tabla. */
export async function leerPlantillasYReglas(sb: Sb): Promise<LecturaPlantillas> {
  const pl = await leerPlantillas(sb);
  if (pl.error) {
    return { ok: false, plantillas: [], reglas: null, reglasTraslado: null, sinDiseno: false, error: `No se pudieron leer las plantillas del PDF (${TABLA_PLANTILLAS}): ${pl.error}` };
  }
  // Sin la tabla de plantillas no puede haber reglas (las reglas la referencian).
  if (pl.faltaTabla) return { ok: true, plantillas: [], reglas: null, reglasTraslado: null, sinDiseno: true, error: null };
  const sinDiseno = pl.filas.length > 0 && pl.filas.some(f => !Object.prototype.hasOwnProperty.call(f, "diseno"));

  let r: { data: unknown[] | null; error: { code?: string; message?: string } | null };
  try {
    // Una celda por par (servicio, segmento): son 12 como mucho, cabe en una página.
    r = await sb.from(TABLA_REGLAS).select("servicio, segmento, plantilla_id")
      .order("servicio", { ascending: true }).order("segmento", { ascending: true });
  } catch (e) {
    return { ok: false, plantillas: pl.filas, reglas: null, reglasTraslado: null, sinDiseno, error: `No se pudieron leer las reglas de uso de las plantillas (${TABLA_REGLAS}): ${msg(e)}` };
  }
  if (r.error) {
    if (tablaFaltante(r.error, TABLA_REGLAS)) return { ok: true, plantillas: pl.filas, reglas: null, reglasTraslado: null, sinDiseno, error: null };
    return { ok: false, plantillas: pl.filas, reglas: null, reglasTraslado: null, sinDiseno, error: `No se pudieron leer las reglas de uso de las plantillas (${TABLA_REGLAS}): ${msg(r.error)}` };
  }
  const reglas = normalizarReglas(r.data);

  let t: { data: unknown[] | null; error: { code?: string; message?: string } | null };
  try {
    // Una celda por par (idioma, moneda): 4 como mucho.
    t = await sb.from(TABLA_REGLAS_TRASLADO).select("idioma, moneda, plantilla_id")
      .order("idioma", { ascending: true }).order("moneda", { ascending: true });
  } catch (e) {
    return { ok: false, plantillas: pl.filas, reglas: null, reglasTraslado: null, sinDiseno, error: `No se pudieron leer las reglas del traslado por idioma (${TABLA_REGLAS_TRASLADO}): ${msg(e)}` };
  }
  if (t.error) {
    if (tablaFaltante(t.error, TABLA_REGLAS_TRASLADO)) return { ok: true, plantillas: pl.filas, reglas, reglasTraslado: null, sinDiseno, error: null };
    return { ok: false, plantillas: pl.filas, reglas: null, reglasTraslado: null, sinDiseno, error: `No se pudieron leer las reglas del traslado por idioma (${TABLA_REGLAS_TRASLADO}): ${msg(t.error)}` };
  }
  return { ok: true, plantillas: pl.filas, reglas, reglasTraslado: normalizarReglasTraslado(t.data), sinDiseno, error: null };
}
