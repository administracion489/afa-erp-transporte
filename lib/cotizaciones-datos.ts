// ──────────────────────────────────────────────────────────────────────────────
// lib/cotizaciones-datos.ts — El que LEE las cotizaciones (cliente de Supabase inyectado).
//
// Las reglas viven en lib/cotizaciones-filtros.ts (PURO). Aquí solo se consulta, y con dos
// reglas que no se aflojan:
//  • PAGINADO COMPLETO CON ORDEN TOTAL (`id desc`, único): PostgREST corta en 1000 filas.
//  • UNA PÁGINA QUE FALLA LANZA. No se usa `paginarFilas` (lib/huella.ts) porque conserva lo
//    acumulado ante un error: una lista cortada se leería como «no hay más cotizaciones», y sobre
//    ella se cuentan los KPIs y el uso de clientes y unidades.
// ──────────────────────────────────────────────────────────────────────────────

import { columnaFaltante } from "@/lib/columna-faltante";
import {
  colsSelect, limitesConsulta, sumarDias, COLS_OPCIONALES_LISTA,
  type CotLista, type EjeFecha, type RangoPeriodo,
} from "@/lib/cotizaciones-filtros";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

const PAG = 1000;
const MAX_PAGINAS = 200; // techo de sanidad (200 000 filas), no un límite operativo

/** Lee todas las páginas de una consulta; lanza el error de la primera que falle. */
async function todasLasPaginas<T>(armar: () => { range: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: unknown }> }): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < MAX_PAGINAS; p++) {
    const { data, error } = await armar().range(p * PAG, p * PAG + PAG - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < PAG) return out;
  }
  throw new Error(`La lista de cotizaciones pasa de ${MAX_PAGINAS * PAG} filas: acota el periodo.`);
}

/**
 * La lista liviana del periodo. `sinColumnas` dice qué columnas accesorias se tuvieron que soltar
 * porque la migración no está corrida (la pantalla puede decirlo). Si el error nombra una columna
 * accesoria se reintenta DESDE CERO sin ella; cualquier otro error lanza.
 */
export async function leerListaPeriodo(
  sb: Sb, eje: EjeFecha, r: Pick<RangoPeriodo, "desde" | "hastaExcl">,
): Promise<{ filas: CotLista[]; sinColumnas: string[] }> {
  const lim = limitesConsulta(eje, r);
  const sin: string[] = [];
  for (;;) {
    try {
      const filas = await todasLasPaginas<CotLista>(() => {
        let q = sb.from("cotizaciones").select(colsSelect(sin));
        if (lim.gte) q = q.gte(lim.columna, lim.gte);
        if (lim.lt) q = q.lt(lim.columna, lim.lt);
        return q.order("id", { ascending: false });
      });
      // Paginar por offset puede repetir una fila si alguien crea una cotización entre dos páginas.
      const vistos = new Set<number>();
      const unicas = filas.filter((f) => (vistos.has(f.id) ? false : (vistos.add(f.id), true)));
      return { filas: unicas, sinColumnas: sin };
    } catch (e) {
      const col = columnaFaltante(e as { code?: string; message?: string });
      const opcional = col ? COLS_OPCIONALES_LISTA.find((c) => c === col && !sin.includes(c)) : undefined;
      if (!opcional) throw e;
      sin.push(opcional);
    }
  }
}

export type FilaHistorialSelector = Pick<CotLista, "cliente_id" | "vehiculo_flota_id" | "vehiculo_tercero_id" | "created_at">;

/**
 * Lo que necesitan «Recientes» y «Más cotizados» de los selectores de cliente y unidad: los
 * últimos 365 días de emisión, independientes del periodo que se esté mirando en la lista.
 */
export async function leerHistorialSelector(sb: Sb, hoy: string): Promise<FilaHistorialSelector[]> {
  const desde = `${sumarDias(hoy, -364)}T00:00:00-05:00`;
  return todasLasPaginas<FilaHistorialSelector & { id: number }>(() =>
    sb.from("cotizaciones")
      .select("id,cliente_id,vehiculo_flota_id,vehiculo_tercero_id,created_at")
      .gte("created_at", desde)
      .order("id", { ascending: false }),
  );
}

/** La cotización completa (jsonb incluidos), para editar, duplicar, imprimir o convertir. */
export async function leerCotizacion<T = Record<string, unknown>>(sb: Sb, id: number): Promise<T | null> {
  const { data, error } = await sb.from("cotizaciones").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as T) ?? null;
}
