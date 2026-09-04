// lib/radar/lecciones-combustible.ts
// Dataset de aprendizaje de lectura de vouchers de grifo. Espejo de
// leccionesOdometro() en lib/odometro.ts: lee las últimas correcciones que hizo el
// revisor en /radar-ia?tab=combustible (tabla radar_combustible_correcciones) y las
// formatea en texto plano para inyectarlas en el prompt de extracción con visión, de
// modo que ELIA no repita el mismo error de lectura (grifo, cantidad, precio, monto).

/** Etiqueta legible por campo corregido, para el texto de la lección. */
const CAMPO_LABEL: Record<string, string> = {
  grifo:   "el grifo/proveedor",
  galones: "los galones",
  litros:  "los litros",
  precio:  "el precio unitario",
  monto:   "el monto total",
  fecha:   "la fecha",
  tipo_combustible: "el tipo de combustible",
};

/**
 * Últimas correcciones humanas de lectura de vouchers, en texto plano, para inyectar
 * como ejemplos en el prompt de visión de combustible. Devuelve "" si no hay ninguna.
 */
export async function leccionesCombustible(client: any, limite = 12): Promise<string> {
  const { data } = await client
    .from("radar_combustible_correcciones")
    .select("campo,valor_ia,valor_correcto,nota")
    .order("created_at", { ascending: false })
    .limit(limite);
  const filas = (data || []) as any[];
  if (!filas.length) return "";
  return filas
    .map((c) => {
      const campo = CAMPO_LABEL[c.campo] ?? c.campo;
      const leido = c.valor_ia != null && String(c.valor_ia).trim() !== ""
        ? `leíste "${String(c.valor_ia).trim()}"`
        : "no leíste nada";
      const corr = c.valor_correcto != null && String(c.valor_correcto).trim() !== ""
        ? `y lo correcto era "${String(c.valor_correcto).trim()}"`
        : "y estaba mal";
      return `- Para ${campo} ${leido} ${corr}${c.nota ? ` (${c.nota})` : ""}.`;
    })
    .join("\n");
}
