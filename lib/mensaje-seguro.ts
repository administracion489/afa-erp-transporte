// ──────────────────────────────────────────────────────────────────────────────
// lib/mensaje-seguro.ts — Qué parte de un error se le ENSEÑA al usuario del ERP. PURO.
//
// Un error de la base (PostgREST/Postgres), de la red o de una librería no se enseña: nombra tablas,
// columnas, restricciones y a veces valores, y no le dice al usuario qué hacer. Va al log (lo escribe
// quien llama) y la pantalla recibe un texto genérico. Lo que el propio módulo escribió (sus reglas
// de negocio: «Ese cobro ya está aplicado…», «Falta correr supabase/…») sí se enseña.
//
// Nació en app/api/reservas/confirmacion/route.ts; se mudó aquí para que la reserva de traslados
// (lib/traslados/reserva-solicitud-datos.ts) use la MISMA regla en vez de una copia. Sin opciones se
// comporta byte a byte como el original (los mismos tres prefijos, el mismo genérico).
// ──────────────────────────────────────────────────────────────────────────────

/** El texto que recibe el usuario cuando el error no es uno escrito por el módulo. */
export const MENSAJE_GENERICO = "No se pudo completar la operación. Vuelve a intentar en un momento.";

/** Los mensajes propios del módulo de la Confirmación de Reserva (los del route de siempre). */
export const PROPIOS_CONFIRMACION = /^(Ese cobro|Otra persona|Falta correr)/;

/** Los mensajes «No se pudo…: <detalle>» que escribe un módulo: el detalle casi siempre es el texto de la base. */
const RE_NO_SE_PUDO = /^(No se pudo|No se pudieron)\b/;

const textoDe = (e: unknown): string =>
  typeof e === "string" ? e : String((e as { message?: unknown } | null | undefined)?.message ?? "");

/**
 * Lo que se le enseña al usuario de un error.
 *  · `propios`: los prefijos de los mensajes que escribió el módulo (por defecto, los de la
 *    Confirmación de Reserva). Lo que no empiece así recibe `generico`.
 *  · `cortarDetalle`: de un mensaje propio de la forma «No se pudo X: <detalle>» se enseña solo
 *    «No se pudo X. Vuelve a intentar en un momento.» (el detalle es el error crudo que el módulo
 *    pegó detrás). Un mensaje propio sin esa forma se enseña entero.
 * No escribe en el log: el detalle crudo lo registra quien llama.
 */
export function mensajeSeguro(e: unknown, x: { propios?: RegExp; generico?: string; cortarDetalle?: boolean } = {}): string {
  const m = textoDe(e).trim();
  const propios = x.propios ?? PROPIOS_CONFIRMACION;
  const generico = x.generico ?? MENSAJE_GENERICO;
  if (!m || !propios.test(m)) return generico;
  if (x.cortarDetalle && RE_NO_SE_PUDO.test(m)) {
    const i = m.indexOf(": ");
    if (i > 0) return `${m.slice(0, i).replace(/[\s.,;:]+$/, "")}. Vuelve a intentar en un momento.`;
  }
  return m;
}
