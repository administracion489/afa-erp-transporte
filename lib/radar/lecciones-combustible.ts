// lib/radar/lecciones-combustible.ts
// Dataset de aprendizaje de lectura de vouchers de grifo. Espejo de
// leccionesOdometro() en lib/odometro.ts: lee las últimas correcciones de
// radar_combustible_correcciones y las formatea en texto plano para inyectarlas en el prompt
// de extracción con visión, de modo que ELIA no repita el mismo error de lectura (grifo,
// cantidad, precio, monto).
//
// Las correcciones llegan de DOS sitios y los dos enseñan: el revisor que edita un campo en
// /radar-ia?tab=combustible, y el CUADRE ARITMÉTICO del propio voucher, que atrapa el dígito
// mal leído sin que nadie mire la foto (lib/radar/coherencia-voucher.ts, `usuario="radar_ia"`).
// El segundo es el que cierra el ciclo solo: sin él, un 6 leído donde decía 8 seguía
// apareciendo mes tras mes hasta que alguien se tomara el trabajo de corregirlo a mano.

import { errorDeLecturaSinCifras } from "./coherencia-voucher";
import { sinCifrasCopiables } from "../odometro-prompt";

/** Etiqueta legible por campo corregido, para el texto de la lección. */
const CAMPO_LABEL: Record<string, string> = {
  grifo:   "el grifo/proveedor",
  galones: "los galones",
  litros:  "los litros",
  precio:  "el precio unitario",
  monto:   "el monto total",
  fecha:   "la fecha",
  // Los dos que el panel de revisión ya escribía sin etiqueta: sin ellas la lección salía con
  // el nombre crudo de la columna ("Para tipo_combustible leíste…").
  kilometraje: "el kilometraje del odómetro",
  tipo_combustible: "el tipo de combustible",
};

/**
 * Los campos NUMÉRICOS de un voucher. Su lección se dice sin el número: «para el precio leíste
 * "24.64" y lo correcto era "24.720"» deja en el prompt un precio que el modelo copia en la nota
 * siguiente —la de otra semana, con otro precio—, que es justo el eco que este archivo existe para
 * cortar. Se describe el ERROR (un dígito distinto, el punto corrido, una cifra de más) y no el valor,
 * con la misma regla que las lecciones del odómetro (lib/odometro-prompt.ts → sinCifrasCopiables).
 */
const CAMPOS_NUMERICOS = new Set(["galones", "litros", "precio", "monto", "kilometraje"]);

const aNumero = (v: string | null | undefined): number | null => {
  const t = String(v ?? "").trim().replace(/[^0-9.,-]/g, "");
  if (!t) return null;
  // Un solo separador: coma o punto decimal. Con los dos, la coma es de miles (forma peruana).
  const n = Number(t.includes(".") && t.includes(",") ? t.replace(/,/g, "") : t.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** La lección de UNA corrección, en una línea, sin cifras copiables. Exportada para la matriz. */
export function textoLeccion(c: { campo: string; valor_ia: string | null; valor_correcto: string | null; nota: string | null }): string {
  const campo = CAMPO_LABEL[c.campo] ?? c.campo;
  const nota = c.nota ? sinCifrasCopiables(String(c.nota).trim()).slice(0, 200) : "";
  const cola = nota ? ` (${nota})` : "";
  if (CAMPOS_NUMERICOS.has(c.campo)) {
    const leido = aNumero(c.valor_ia);
    const correcto = aNumero(c.valor_correcto);
    if (leido == null) return `- En ${campo} no leíste nada y el papel sí lo traía${cola}.`;
    if (correcto == null) return `- En ${campo} el número que diste estaba mal${cola}.`;
    const err = errorDeLecturaSinCifras(leido, correcto);
    return err
      ? `- En ${campo} te equivocaste en ${err}: vuelve a leerlo cifra por cifra${cola}.`
      : `- En ${campo} diste un número que no era el impreso: léelo de la foto y compruébalo con el cuadre, nunca lo completes con uno de otra nota${cola}.`;
  }
  const leido = c.valor_ia != null && String(c.valor_ia).trim() !== ""
    ? `leíste "${String(c.valor_ia).trim()}"`
    : "no leíste nada";
  const corr = c.valor_correcto != null && String(c.valor_correcto).trim() !== ""
    ? `y lo correcto era "${String(c.valor_correcto).trim()}"`
    : "y estaba mal";
  return `- Para ${campo} ${leido} ${corr}${cola}.`;
}

/**
 * Cuántas de las lecciones pueden venir del cuadre aritmético en vez de una persona.
 * El cuadre (lib/radar/coherencia-voucher.ts) escribe una corrección cada vez que atrapa un
 * dígito, y sin este tope se comería la ventana entera: las correcciones de una persona son
 * las únicas que enseñan lo que ninguna cuenta puede deducir (un grifo mal identificado, una
 * fecha, un comprobante), así que se les reserva la mayoría de los ejemplos.
 */
const MAX_LECCIONES_MAQUINA = 4;

/**
 * Últimas correcciones de lectura de vouchers, en texto plano, para inyectar como ejemplos en
 * el prompt de visión de combustible. Devuelve "" si no hay ninguna.
 *
 * Mezcla las de una persona (las que llegan del panel de revisión, sin `usuario`) con las que
 * detectó el cuadre aritmético del propio voucher (`usuario = "radar_ia"`), estas últimas
 * topeadas. Se piden en dos consultas y no en una: un solo `order by created_at` deja que una
 * ráfaga de correcciones automáticas desplace a todas las humanas.
 */
type FilaCorreccion = {
  campo: string;
  valor_ia: string | null;
  valor_correcto: string | null;
  nota: string | null;
  created_at: string | null;
};

/** Las filas de una consulta, o ninguna si falla: una lección es cortesía, nunca frena el pipeline. */
async function filasDe(consulta: PromiseLike<{ data: unknown }>): Promise<FilaCorreccion[]> {
  try {
    const { data } = await consulta;
    return (data ?? []) as FilaCorreccion[];
  } catch {
    return [];
  }
}

export async function leccionesCombustible(client: any, limite = 12): Promise<string> {
  const cols = "campo,valor_ia,valor_correcto,nota,created_at";
  const tabla = () => client.from("radar_combustible_correcciones").select(cols);
  const [maquina, humanas] = await Promise.all([
    filasDe(tabla().eq("usuario", "radar_ia").order("created_at", { ascending: false }).limit(MAX_LECCIONES_MAQUINA)),
    filasDe(
      tabla()
        // `usuario` viene NULL desde el panel de revisión (nadie lo llena ahí) y `neq` descarta
        // los NULL en Postgres, así que sin el `is.null` se perderían justo las humanas.
        .or("usuario.is.null,usuario.neq.radar_ia")
        .order("created_at", { ascending: false })
        .limit(limite)
    ),
  ]);

  const filas = [...humanas.slice(0, Math.max(0, limite - maquina.length)), ...maquina].sort((a, b) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
  );
  if (!filas.length) return "";
  return filas.map(textoLeccion).join("\n");
}
