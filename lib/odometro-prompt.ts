// lib/odometro-prompt.ts
// Lo que se le dice al modelo sobre los NÚMEROS de un odómetro, en UN solo sitio para los dos
// carriles de lectura: lib/vision-ia.ts (app del conductor, /mantenimiento, /tercerizadas) y
// lib/radar/prompts.ts (fotos de los grupos de WhatsApp). Módulo puro: solo strings.
//
// LA REGLA: AL PROMPT NO VA NINGÚN KILOMETRAJE, NI SIQUIERA DE EJEMPLO.
//
// El ERP ya la tenía escrita para el km vigente («al prompt va la FORMA, jamás el km exacto: un
// número exacto en el prompt es un número que el modelo copia cuando no logra leer la foto»), y la
// rompía por dos puertas. (1) Para enseñar el dígito repetido, los dos prompts citaban desde el 23/09
// los casos reales con sus cifras (23980→239980 · 23379→233379 · 560473→5600473), y 23980 es el
// odómetro de la CUP-435 del 05/09. (2) Las lecciones copian la nota que el operador escribe al
// corregir, con sus cifras: «el tablero dice 23980» viajaba tal cual. Y la CTV-370 —que iba por
// 29,5xx-29,8xx— tiene DOS lecturas de exactamente 23,980 km, el 12/09 y el 17/09: el mismo número en
// dos días distintos, en una unidad que no podía marcarlo, y que es literalmente el del ejemplo. Es
// el eco que la regla existía para impedir. evaluarLectura las frenó («Retrocede 5,909 km»), pero
// cada una es una lectura perdida y un rojo que alguien tiene que mirar.
//
// Por eso el patrón se enseña con LETRAS (la forma del error sin ninguna cifra copiable), y lo que
// escribe una persona —la nota de una corrección, la guía de un tablero— entra con sus números
// largos tapados: «el total es 23980» enseña lo mismo como «el total es #####».

/**
 * El error medido de esta flota, sin una sola cifra: el modelo no inventa un dígito cualquiera,
 * REPITE uno que ya estaba. Los casos reales que lo midieron viven en scripts/prueba-odometro.mts,
 * que es donde tienen que estar; aquí solo va su forma.
 */
export const PATRON_DIGITO_REPETIDO =
  `El error medido en esta flota no es inventar una cifra cualquiera: es leer DOS VECES la misma. ` +
  `El patrón, escrito con letras en lugar de cifras (a propósito: ninguna cifra de estas instrucciones ` +
  `es el kilometraje de una unidad): un tablero que marca «ABCDE» se devolvió como «ABCCDE», y uno que ` +
  `marca «ABCDEF» como «ABCDDEF».`;

/** La abstención como regla explícita: el número sale de la foto o no sale. */
export const NUMERO_SOLO_DE_LA_FOTO =
  `El kilometraje sale SOLO de la foto o del texto del mensaje. Nunca completes una lectura dudosa con ` +
  `un número de estas instrucciones, de otra unidad o de lo que creas que esta debería marcar: ` +
  `si no lo lees, abstente.`;

/**
 * Desde cuántas cifras un número es copiable como kilometraje. Con 4 quedan tapados un trip
 * («1803.6»), un odómetro de cinco cifras y uno de siete, y siguen legibles las cosas cortas que
 * sí enseñan algo: «5 dígitos», una placa (CUP-435), una hora (20:25).
 */
export const MIN_CIFRAS_COPIABLES = 4;

/**
 * Tapa con «#» los números de MIN_CIFRAS_COPIABLES cifras o más, conservando su forma (cuántas
 * cifras y dónde iba el separador): «el total es 23,980 y no 239,980» → «el total es ##,### y no
 * ###,###». La forma es justo lo que enseña la corrección; el valor es lo que el modelo copiaría.
 *
 * Se aplica a lo que TECLEA una persona y viaja al prompt (la nota de una corrección, la guía de un
 * tablero): ahí no hay forma de saber si alguien escribió un kilometraje.
 */
export function sinCifrasCopiables(texto: string | null | undefined): string {
  return String(texto ?? "").replace(/\d(?:[\d.,]*\d)?/g, (m) =>
    m.replace(/\D/g, "").length >= MIN_CIFRAS_COPIABLES ? m.replace(/\d/g, "#") : m
  );
}
