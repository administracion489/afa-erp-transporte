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
 * EL ÚLTIMO TAMBOR DE UN ODÓMETRO MECÁNICO SON DÉCIMAS, NO KILÓMETROS.
 *
 * El caso (B4N-968, octubre 2026): el tablero es de rodillos y muestra «5 6 1 2 9 [2]», con el
 * último tambor en otro color. Ese tambor marca décimas: la unidad va en 56,129 km. La IA lo leyó
 * como una cifra más y devolvió 561,292 (y con un dígito repetido, 5,612,926) — diez o cien veces
 * el kilometraje. Y como pasó desde las primeras lecturas, el historial de la unidad quedó entero
 * en la escala equivocada: el km vigente decía «6 cifras» y el prompt EMPUJABA a leer el tambor
 * de décimas como kilómetros. Los dos prompts decían «el total va sin decimales», que es cierto
 * en una pantalla digital y no le dice nada al modelo frente a un tambor sin punto ni coma.
 *
 * La regla pide además TRANSCRIBIR el tambor después de un punto en el texto leído: así, si el
 * modelo igual lo mete en el número, el ERP tiene su propia transcripción para deshacerlo
 * (`decimalComoEntero`, lib/odometro-seleccion.ts) sin adivinar nada.
 *
 * `campoTexto` y `campoMotivo` (ya entre comillas) cambian entre carriles (texto_leido/motivo en la
 * app, texto_leido/observaciones o texto_kilometraje en el Radar); la regla es UNA.
 */
export function reglaTamborDecimal(campoTexto: string, campoMotivo: string): string {
  return (
    `ODÓMETRO DE TAMBORES (mecánico, con rodillos de números): el ÚLTIMO tambor de la derecha casi siempre ` +
    `marca DÉCIMAS de kilómetro, no kilómetros. Se reconoce porque tiene OTRO COLOR que los demás (fondo ` +
    `blanco o rojo, o los colores invertidos), va separado por un marco o una línea, o es más pequeño. Ese ` +
    `dígito NO es parte del kilometraje: déjalo FUERA del número y, en ${campoTexto}, escríbelo después de ` +
    `un punto («ABCDE.F»). Un tablero de seis tambores «ABCDE[F]» con el último de décimas marca ABCDE km: ` +
    `leerlo como ABCDEF es multiplicar el kilometraje por diez. Que el total tenga un tambor de décimas NO lo ` +
    `convierte en el parcial/trip: sigue siendo el total. Si no logras distinguir si el último tambor ` +
    `es de décimas, baja la confianza y dilo en ${campoMotivo}.`
  );
}

/**
 * CUÁNTAS CIFRAS TIENE EL ODÓMETRO — y cuándo deja de ser seguro decirlo.
 *
 * Decirle al modelo «esta unidad tiene 5 cifras» es lo que frena el dígito de más, el error más
 * frecuente de la flota. Pero un odómetro SUBE de cifra: de 99,950 pasa a 100,020 con 70 km de
 * recorrido, y con la regla dicha a secas («si te salen 6, te sobra una») el modelo dudaría de la
 * única lectura correcta de ese día. El texto anterior lo sabía a medias: decía que pasar a la
 * cifra siguiente «exige un salto enorme desde la última lectura», que es falso.
 *
 * Por eso la forma se DERIVA del km con su margen: lejos de la cifra siguiente se dice el número
 * de cifras tal cual; cerca, se dice que puede tener una más y CÓMO es ese número — tras dar la
 * vuelta empieza por «10» (100,0xx · 1,000,0xx), así que el freno sigue funcionando: un dígito de
 * más sobre 95,950 da 959,950, que no empieza por 10.
 *
 * La validación del ERP no depende de esto: `elegirOdometro` y `evaluarLectura` juzgan el VALOR
 * contra las lecturas de la unidad, y aceptan 99,950 → 100,020 tal cual. Esto solo cuida lo que
 * se le dice al modelo.
 */
export type FormaOdometro = {
  /** Cifras del km que el ERP tiene de la unidad. */
  cifras: number;
  /** El km está a menos de UMBRAL_CAMBIO_DE_CIFRA de la cifra siguiente: puede tener una más. */
  puedeSubir: boolean;
};

/**
 * Desde qué fracción de la cifra siguiente se avisa que el odómetro puede tener una más: 90 % es
 * 90,000 km en un odómetro de 5 cifras (10,000 km antes del cambio) y 900,000 en uno de 6.
 * NO está medido y se declara: el margen cubre que el km del ERP se quede atrás (lecturas por
 * revisar que no se aceptaron) sin que la frase quede vieja el día del cambio. Bajarlo da más
 * margen a cambio de un freno menos estricto en la última franja; el lado seguro es bajarlo.
 */
export const UMBRAL_CAMBIO_DE_CIFRA = 0.9;

/** La forma del odómetro a partir del km que el ERP tiene de la unidad. null sin km. */
export function formaOdometro(kmVigente: number | null | undefined): FormaOdometro | null {
  const km = Math.round(Math.abs(Number(kmVigente) || 0));
  if (km <= 0) return null;
  const cifras = String(km).length;
  return { cifras, puedeSubir: km >= Math.pow(10, cifras) * UMBRAL_CAMBIO_DE_CIFRA };
}

/** Las cifras de la forma son de KILÓMETROS: el tambor de décimas de un odómetro mecánico no cuenta. */
const SIN_DECIMAS = " (sin contar el tambor de décimas, si lo tiene)";

/**
 * La frase que describe la forma, LA MISMA en los dos carriles. Sin cifras copiables: la cantidad
 * de dígitos y el «10» con que empieza tras el cambio no son el kilometraje de nadie.
 */
export function fraseFormaOdometro(f: FormaOdometro): string {
  if (!f.puedeSubir) return `el odómetro TOTAL es un número de ${f.cifras} dígitos${SIN_DECIMAS}`;
  return (
    `el odómetro TOTAL es un número de ${f.cifras} dígitos${SIN_DECIMAS} y está cerca de pasar a ${f.cifras + 1}: ` +
    `un número de ${f.cifras + 1} dígitos solo es válido si empieza por «10» (el odómetro acaba de dar ` +
    `la vuelta); cualquier otro de ${f.cifras + 1} dígitos es un dígito de más`
  );
}

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
