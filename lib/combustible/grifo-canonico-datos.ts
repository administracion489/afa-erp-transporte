// lib/combustible/grifo-canonico-datos.ts — Lee las fuentes del catálogo de grifos (lib/combustible/grifo-canonico.ts).
// Recibe el cliente de Supabase (no crea ninguno): lo usan el Radar y la conciliación de facturas con
// service-role, y /combustible con el cliente del navegador (las tres tablas tienen RLS para usuarios
// del ERP).
//
// TODO ES BEST-EFFORT: una fuente que no se puede leer (una migración sin correr, una red caída) solo
// achica el catálogo. Con el catálogo vacío el grifo se guarda como se leyó, que es el comportamiento
// de siempre — nunca se deja de registrar una carga por no poder nombrar su grifo.

import { construirCatalogoGrifos, type CatalogoGrifos, type FuentesCatalogo } from "./grifo-canonico";

/** Cuántas filas de cada fuente: de sobra para votar el nombre de cada RUC, y acotado. */
const TOPE_FILAS = 1000;

async function filas<T>(consulta: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await consulta;
    return error ? [] : ((data as T[] | null) ?? []);
  } catch {
    return [];
  }
}

/**
 * Las tres fuentes, crudas. `sinCargas`: quien ya tiene las cargas en memoria (/combustible) las
 * suma él mismo y no las vuelve a pedir.
 */
export async function cargarFuentesCatalogo(sb: any, opts: { sinCargas?: boolean } = {}): Promise<Required<FuentesCatalogo>> {
  const [facturas, cuentas, cargas] = await Promise.all([
    filas<NonNullable<FuentesCatalogo["facturas"]>[number]>(
      sb.from("radar_facturas").select("ruc_emisor, razon_social")
        .not("ruc_emisor", "is", null).order("id", { ascending: false }).limit(TOPE_FILAS)
    ),
    filas<NonNullable<FuentesCatalogo["cuentas"]>[number]>(sb.from("combustible_cuentas").select("rucs")),
    opts.sinCargas
      ? Promise.resolve([] as NonNullable<FuentesCatalogo["cargas"]>)
      : filas<NonNullable<FuentesCatalogo["cargas"]>[number]>(
          sb.from("combustible").select("ruc_proveedor, grifo")
            .not("ruc_proveedor", "is", null).order("id", { ascending: false }).limit(TOPE_FILAS)
        ),
  ]);
  return { facturas, cuentas, cargas };
}

export async function cargarCatalogoGrifos(sb: any): Promise<CatalogoGrifos> {
  return construirCatalogoGrifos(await cargarFuentesCatalogo(sb));
}

// Memo de 5 minutos para el servidor: el lote del Radar procesa hasta 50 mensajes y no tiene sentido
// releer tres tablas por cada uno. Mismo criterio que `cargarEmpresasConocidas` en lib/radar/acciones.ts.
const TTL_MS = 5 * 60_000;
let memo: { cat: CatalogoGrifos; en: number } | null = null;

export async function catalogoGrifosMemo(sb: any): Promise<CatalogoGrifos> {
  if (memo && Date.now() - memo.en < TTL_MS) return memo.cat;
  const cat = await cargarCatalogoGrifos(sb);
  memo = { cat, en: Date.now() };
  return cat;
}
