// lib/paginar-estricto.ts — Trae TODAS las filas de una consulta, o LANZA. Módulo PURO (recibe la consulta).
//
// La diferencia con `paginarFilas` (lib/huella.ts) es deliberada: aquella conserva lo acumulado ante una
// página fallida porque una huella GPS parcial es mejor que ninguna. Aquí lo leído se usa para AFIRMAR
// que algo falta («la unidad no tiene SOAT», «el legajo no tiene ficha RUC»), y una lista cortada por un
// error convertiría una caída de red en una acusación falsa. Quien llama atrapa el error y declara la
// fuente como no leída (EstadoLectura "error").
//
// `armar` debe devolver una consulta NUEVA en cada llamada y con orden TOTAL (p. ej. .order("id")):
// sin orden, PostgREST puede repetir o saltarse filas entre páginas.

export type ConsultaPaginable<T> = { range: (desde: number, hasta: number) => PromiseLike<{ data: T[] | null; error: unknown }> };

export class LecturaIncompleta extends Error {
  constructor(mensaje: string, readonly causa: unknown) { super(mensaje); this.name = "LecturaIncompleta"; }
}

export async function todasLasPaginas<T>(
  armar: () => ConsultaPaginable<T>,
  opts: { pagina?: number; maxFilas?: number } = {},
): Promise<T[]> {
  const PAG = Math.max(1, Math.min(opts.pagina ?? 1000, 1000)); // 1000 = max-rows de Supabase
  const tope = opts.maxFilas ?? 50_000;
  const todas: T[] = [];
  for (let desde = 0; ; desde += PAG) {
    if (desde >= tope) throw new LecturaIncompleta(`La consulta pasa de ${tope} filas: no se leyó completa.`, null);
    const { data, error } = await armar().range(desde, desde + PAG - 1);
    if (error) {
      const msg = (error as { message?: string })?.message ?? String(error);
      throw new LecturaIncompleta(msg, error);
    }
    const filas = data ?? [];
    todas.push(...filas);
    if (filas.length < PAG) return todas;
  }
}
