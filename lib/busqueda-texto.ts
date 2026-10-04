/**
 * Búsqueda PERMISIVA de texto libre — módulo PURO (no lee la base).
 *
 * El caso (03-10-2026): en /programacion se tecleó «COMPAÑIA HARD» y no salió nada.
 * La búsqueda ya ignoraba mayúsculas, pero comparaba el texto LITERAL: la ficha dice
 * «Compañía …» (con tilde en la í), así que «compañia» no estaba contenido en
 * «compañía» y la pantalla contestaba «No hay reservas» sobre un cliente que sí existe.
 * Para quien busca eso se lee como «el sistema quiere que lo escriba exacto».
 *
 * Reglas:
 *  - Mayúsculas, tildes y diéresis no importan («compania» encuentra «COMPAÑÍA»).
 *  - Puntos y signos no importan («sac» encuentra «S.A.C.», «os 2026» encuentra
 *    «OS-2026-006532»).
 *  - Las palabras se buscan en CUALQUIER orden y cada una puede ser un trozo
 *    («hard comp» encuentra «Compañía Hard…»). Todas tienen que estar.
 *  - Una búsqueda vacía deja pasar todo.
 */

/** Forma canónica para comparar. NUNCA se persiste: es solo para buscar. */
export function normalizarBusqueda(raw?: string | number | null): string {
  return String(raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")  // tildes, diéresis y la virgulilla de la ñ
    .toLowerCase()
    .replace(/\./g, "")               // S.A.C. → sac
    .replace(/[^a-z0-9]+/g, " ")      // cualquier otro signo separa palabras
    .trim();
}

/** Palabras de la búsqueda ya normalizadas (sin vacías). */
export function terminosBusqueda(q?: string | null): string[] {
  const n = normalizarBusqueda(q);
  return n ? n.split(" ") : [];
}

/**
 * ¿El texto contiene TODAS las palabras buscadas, en cualquier orden?
 * `terminos` se precalcula con `terminosBusqueda` para no normalizar la consulta
 * en cada fila.
 */
export function coincideBusqueda(texto: string | null | undefined, terminos: string[]): boolean {
  if (!terminos.length) return true;
  const hay = " " + normalizarBusqueda(texto) + " ";
  return terminos.every(t => hay.includes(t));
}
