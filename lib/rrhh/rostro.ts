// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/rostro.ts — MOTOR PURO de la verificación facial 1:1 de la marcación.
// ¿El rostro de quien marca AHORA es el mismo que se guardó al enrolar? Sin base, sin
// fetch, sin `window`, sin face-api: recibe los DESCRIPTORES ya calculados (arrays de
// 128 números que produce face-api en el cliente) y devuelve una decisión con un
// `codigo` declarado. Ver CLAUDE.md → "Motor PURO + lector + matriz".
//
// EL MOTOR NO DESCIFRA NADA. La referencia del enrolamiento vive CIFRADA (Ley 29733,
// el descriptor es un dato biométrico); quien llama la descifra y se la pasa YA en
// claro a `decidirRostro`. El motor solo compara dos vectores: así es puro, barrible,
// y jamás toca la clave.
//
// "QUÉ ES UN DESCRIPTOR UTILIZABLE" SE DEFINE UNA SOLA VEZ (`esDescriptorValido`):
// exactamente 128 valores finitos. `distancia` y `decidirRostro` la reúsan — dos
// definiciones de "vector válido" terminarían discrepando (el bug del semáforo).
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Umbral de distancia euclídea bajo el cual dos descriptores se consideran la MISMA
 * persona. **NO medido, declarado.** face-api recomienda 0.6; aquí se baja a 0.55
 * porque el lado seguro es BAJARLO: cuanto más estricto el umbral, menos falsos
 * positivos de identidad (que alguien marque haciéndose pasar por otro). Un falso
 * negativo solo obliga a repetir la foto o a que RRHH marque por PIN; un falso
 * positivo deja pasar una suplantación, que es el daño que no se deshace.
 */
export const UMBRAL_DISTANCIA = 0.55;

/** Longitud del descriptor que entrega face-api. Un vector de otra longitud no es
 *  comparable con los nuestros y se trata como inválido. */
export const DIM_DESCRIPTOR = 128;

/**
 * ¿`d` es un descriptor utilizable? Exactamente 128 valores finitos. Definición ÚNICA
 * de "vector válido" del módulo: la reúsan `distancia` y `decidirRostro`. Un NaN o un
 * Infinity (un descriptor a medio calcular, o corrompido en el transporte) lo invalida
 * entero — no se compara contra basura.
 */
export function esDescriptorValido(d: unknown): d is number[] {
  if (!Array.isArray(d) || d.length !== DIM_DESCRIPTOR) return false;
  for (let i = 0; i < DIM_DESCRIPTOR; i++) {
    if (!Number.isFinite(d[i])) return false;
  }
  return true;
}

/**
 * Distancia euclídea entre dos descriptores. Es la medida ÚNICA de "qué tan parecidos
 * son dos rostros" del módulo; el juicio (¿es la misma persona?) lo aplica `coincide`
 * con el umbral.
 *
 * - Si alguno de los dos no es un descriptor utilizable (longitud ≠ 128 o algún valor
 *   no finito), devuelve `Infinity`: "no puedo comparar" nunca es "distancia 0". NUNCA
 *   lanza — un descriptor corrupto no puede tumbar la marcación.
 * - Simétrica por construcción —(a−b)² = (b−a)²— y `distancia(a, a) === 0`.
 */
export function distancia(a: number[], b: number[]): number {
  if (!esDescriptorValido(a) || !esDescriptorValido(b)) return Infinity;
  let suma = 0;
  for (let i = 0; i < DIM_DESCRIPTOR; i++) {
    const delta = a[i] - b[i];
    suma += delta * delta;
  }
  return Math.sqrt(suma);
}

/**
 * ¿Los dos descriptores son la misma persona? Devuelve el veredicto y la distancia que
 * lo sustenta. Borde INCLUSIVO: exactamente en el umbral cuenta como coincidencia
 * (igual criterio que la geocerca de `validarMarca`).
 *
 * El guard `Number.isFinite(d)` evita el falso positivo del borde: una distancia
 * `Infinity` (descriptor inválido) con un `umbral` también `Infinity` daría
 * `Infinity <= Infinity === true`; aquí nunca coincide sin una distancia real.
 */
export function coincide(
  a: number[],
  b: number[],
  umbral: number = UMBRAL_DISTANCIA,
): { coincide: boolean; distancia: number } {
  const d = distancia(a, b);
  return { coincide: Number.isFinite(d) && d <= umbral, distancia: d };
}

/**
 * Serializa un descriptor a JSON (string) para guardarlo, o `null` si no es utilizable.
 * Acepta el `Float32Array` que entrega face-api tal cual, además de `number[]`.
 *
 * - Valida EXACTAMENTE 128 valores finitos antes de escribir nada: un vector a medias
 *   o con un NaN no se persiste (se guardaría una referencia que nunca va a coincidir).
 * - Redondea a ~6 decimales: es más precisión de la que la comparación necesita y
 *   acota el tamaño del texto guardado. El ciclo serializar→deserializar recupera el
 *   valor redondeado de forma exacta (JSON round-trip de un double es exacto), así que
 *   la referencia leída es idéntica a la escrita.
 */
export function serializarDescriptor(
  d: number[] | Float32Array | null | undefined,
): string | null {
  if (d == null) return null;
  if (!Array.isArray(d) && !(d instanceof Float32Array)) return null;
  if (d.length !== DIM_DESCRIPTOR) return null;
  const salida: number[] = new Array(DIM_DESCRIPTOR);
  for (let i = 0; i < DIM_DESCRIPTOR; i++) {
    const v = d[i];
    if (!Number.isFinite(v)) return null;
    salida[i] = Math.round(v * 1e6) / 1e6;
  }
  return JSON.stringify(salida);
}

/**
 * Inverso de `serializarDescriptor`: lee el JSON guardado y devuelve el descriptor, o
 * `null` si no parsea o no son exactamente 128 valores finitos. Un texto corrupto o de
 * otra forma no se adivina: `null`, y el llamador lo trata como "sin referencia". NUNCA
 * lanza.
 */
export function deserializarDescriptor(s: string | null | undefined): number[] | null {
  if (typeof s !== "string") return null;
  let parseado: unknown;
  try {
    parseado = JSON.parse(s);
  } catch {
    return null;
  }
  if (!Array.isArray(parseado) || parseado.length !== DIM_DESCRIPTOR) return null;
  const salida: number[] = new Array(DIM_DESCRIPTOR);
  for (let i = 0; i < DIM_DESCRIPTOR; i++) {
    const v = parseado[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    salida[i] = v;
  }
  return salida;
}

/** El resultado declarado de `decidirRostro`. El `codigo` es la razón; `accion` es lo
 *  que el llamador debe hacer. La pantalla enruta por `codigo`, no olfatea el texto. */
export type DecisionRostro = {
  accion: "enrolar" | "verificar" | "rechazar";
  coincide?: boolean;
  distancia?: number;
  codigo: "sin_referencia" | "coincide" | "no_coincide" | "descriptor_invalido";
};

/**
 * La decisión 1:1 de la marcación facial. PURO: recibe la referencia YA descifrada (el
 * descriptor guardado al enrolar) y el candidato recién capturado. No descifra, no lee
 * la base, no decide si guardar — eso lo hace el llamador según el `codigo`.
 *
 * ORDEN de los chequeos, de lo que invalida todo a lo que decide:
 *  1. Candidato inválido → `rechazar`/`descriptor_invalido`. Va PRIMERO: sin un rostro
 *     utilizable AHORA no hay nada que verificar ni que enrolar, exista o no referencia.
 *  2. Sin referencia válida (primera vez, o referencia corrupta) y candidato bueno →
 *     `enrolar`/`sin_referencia`. Este descriptor pasa a ser la referencia.
 *  3. Ambos válidos → se verifica contra el umbral:
 *       coincide → `verificar`/`coincide`
 *       no coincide → `rechazar`/`no_coincide`
 *     Los dos llevan la `distancia` que sustenta el veredicto (para la evidencia de RRHH).
 */
export function decidirRostro(
  ref: number[] | null,
  cand: number[] | null,
): DecisionRostro {
  if (!esDescriptorValido(cand)) {
    return { accion: "rechazar", codigo: "descriptor_invalido" };
  }
  if (!esDescriptorValido(ref)) {
    return { accion: "enrolar", codigo: "sin_referencia" };
  }
  const r = coincide(ref, cand);
  if (r.coincide) {
    return { accion: "verificar", coincide: true, distancia: r.distancia, codigo: "coincide" };
  }
  return { accion: "rechazar", coincide: false, distancia: r.distancia, codigo: "no_coincide" };
}
