/**
 * Cómo EMPIEZA y cómo se LIMPIA el mensaje del agente IA.
 *
 * El caso (21-10-2026, 22:11, conversación de prueba del dueño): el cliente escribió «Hola quiero
 * una minivan para mañana» y la IA contestó sin saludar. La regla era «saluda solo en tu PRIMER
 * mensaje del día con este cliente», y ese primer mensaje se contaba mal por dos lados:
 *
 *   1. Contaba TODO lo saliente de hoy, también los envíos que Meta rechazó (`crm_mensajes.error`):
 *      esa tarde el número estuvo bloqueado por el método de pago y había seis «OK» fallidos. Un
 *      mensaje que no le llegó al cliente no es «ya conversamos hoy».
 *   2. Aunque hubiera conversación de verdad más temprano (con una persona del equipo), un cliente
 *      que vuelve diciendo «Hola» espera que le devuelvan el saludo. Callarlo se lee como frialdad.
 *
 * Ahora el saludo sale de tres casos (`saludoDelTurno`): ningún mensaje le llegó hoy → el saludo
 * obligatorio de siempre; ya le llegó alguno y el cliente abre saludando → se le devuelve el
 * saludo en pocas palabras (y se presenta solo si la IA todavía no habló hoy en ese chat); si no,
 * no se vuelve a saludar. Que el cliente salude lo decide el CÓDIGO (`abreConSaludo`), no el
 * modelo: así se puede probar.
 *
 * Y el texto del modelo se limpia de marcas de fin de secuencia que a veces se cuelan al final
 * («</s>», «<|im_end|>»): el 21-10-2026 una salió al cliente pegada a la pregunta de las maletas.
 *
 * Módulo PURO: no lee la base. Matriz: `npx tsx scripts/prueba-crm-ia-mensaje.mts`.
 */

/** Qué hace el agente con el saludo en ESTA respuesta. */
export type SaludoDelTurno = {
  /** primero = ningún mensaje le llegó hoy; devolver = el cliente saluda; no = ya conversaron. */
  modo: "primero" | "devolver" | "no";
  /** Solo en «devolver»: la IA todavía no habló hoy en este chat (habló una persona del equipo). */
  presentarse: boolean;
};

/** Minúsculas, sin tildes y sin lo que precede a la primera letra (¡, emojis, espacios…). */
function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, "");
}

/**
 * Las fórmulas con las que un cliente abre saludando, al INICIO del mensaje y como palabra completa
 * («Hilton» no es «hi»; «holanda» no es «hola»). Español de Perú, más las inglesas de un turista.
 */
const SALUDO_INICIAL =
  /^(?:h?ola+|holi+|holis|buen(?:as|os)?(?:\s+(?:dias?|tardes?|noches?))?|saludos|que\s+tal|alo|hello|hi|hey|good\s+(?:morning|afternoon|evening))(?![a-z0-9])/;

/** Las etiquetas con que el historial presenta un archivo o una nota de voz («[El cliente envió…]»). */
export const ETIQUETA_INICIAL = /^\s*\[[^\]]*\]\s*/;

/** ¿Este mensaje del cliente abre saludando? «Hola, quiero…», «Buenas noches», «¡Buen día!». */
export function abreConSaludo(texto: string | null | undefined): boolean {
  if (typeof texto !== "string") return false;
  const t = normalizar(texto.replace(ETIQUETA_INICIAL, ""));
  return SALUDO_INICIAL.test(t);
}

/** El texto de un mensaje del historial (cadena, o los bloques de texto de un mensaje con archivo). */
export function textoDeContenido(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: unknown) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? (b as { text?: unknown }).text : null))
    .filter((t): t is string => typeof t === "string")
    .join("\n");
}

/** Lo que el cliente escribió DESPUÉS de nuestra última respuesta: lo que este turno contesta. */
export function textosSinContestar(mensajes: readonly { role: string; content: unknown }[]): string[] {
  const out: string[] = [];
  for (let k = mensajes.length - 1; k >= 0; k--) {
    const m = mensajes[k];
    if (m.role === "assistant") break;
    if (m.role === "user") out.unshift(textoDeContenido(m.content));
  }
  return out;
}

/**
 * La decisión del saludo. `alcanzadosHoy`: mensajes nuestros de hoy (hora de Lima) que SÍ le
 * llegaron al cliente (de la IA o de una persona); `iaHoy`: los de la IA, de esos. `textosCliente`:
 * lo que este turno contesta.
 */
export function saludoDelTurno(x: { alcanzadosHoy: number; iaHoy: number; textosCliente: readonly string[] }): SaludoDelTurno {
  if (!(x.alcanzadosHoy > 0)) return { modo: "primero", presentarse: true };
  if (x.textosCliente.some((t) => abreConSaludo(t))) return { modo: "devolver", presentarse: !(x.iaHoy > 0) };
  return { modo: "no", presentarse: false };
}

/** La forma de antes (un booleano «primer mensaje del día»): true = primero, false = no saludar. */
export function saludoDeBooleano(primeroDelDia: boolean): SaludoDelTurno {
  return primeroDelDia ? { modo: "primero", presentarse: true } : { modo: "no", presentarse: false };
}

/**
 * Marcas de fin de secuencia y de rol que un modelo puede dejar en su texto: `</s>`, `<s>`,
 * `<|im_end|>`, `<|eot_id|>`, `<eos>`… No son texto del cliente ni de la empresa: nunca se envían.
 */
const MARCA_TOKEN = /<\/?s>|<\|[a-z_]{2,20}\|>|<\/?(?:eos|bos|eot)>/gi;

/** El texto del modelo sin esas marcas, y sin los espacios o saltos que dejan al final. */
export function limpiarTextoModelo(texto: string): string {
  return texto.replace(MARCA_TOKEN, "").replace(/[ \t]+$/gm, "").trim();
}
