// ──────────────────────────────────────────────────────────────────────────────
// components/cotizaciones/plantillas/pantalla.ts — Lo que la pantalla /cotizaciones/plantillas
// necesita y no es regla de negocio: escribir pidiendo la fila de vuelta, contar las cotizaciones
// antiguas, limpiar listas y el aviso de las líneas que la IA manda sin revisión. Qué plantilla se
// usa, qué lee cada diseño y qué condiciones se copian viven en lib/cotizacion-plantillas.ts (PURO):
// esta pantalla los IMPORTA, no compone su propia versión.
// ──────────────────────────────────────────────────────────────────────────────

import { faltaAlguna, type ErrorSupabase } from "@/lib/columna-faltante";
import { plantillaPorId, type Diseno, type PlantillaFila, type Segmento } from "@/lib/cotizacion-plantillas";
import { cuentaEnUnaLinea, cuentasFrenteACorporativo } from "@/lib/traslados/cotizacion-traslado";
import type { PerfilEmpresa } from "@/lib/empresa-perfil";
import { ETIQUETA_TEXTO_LIBRE, MOTIVOS_CONDICION_REVISION, motivosLineaIA } from "@/lib/traslados/texto-libre";
import { colorValido } from "@/lib/cotizacion-pdf";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

// ── Escrituras: con RLS, «sin permiso» puede ser un error O cero filas ───────────────────

/** Escribir plantillas y reglas exige el módulo Cotizaciones (supabase/seguridad-04 y cotizaciones-05). */
export const SIN_PERMISO_COTIZACIONES = "te falta el módulo Cotizaciones (lo da un administrador en Usuarios)";

/** El error de una escritura dicho para quien lo lee, con lo que hay que hacer cuando se sabe. */
export function textoErrorEscritura(e: ErrorSupabase, que: string): string {
  const code = String(e?.code ?? "");
  const msg = String(e?.message ?? "");
  if (code === "42501" || /row-level security|permission denied/i.test(msg)) return `${que}: no se guardó porque ${SIN_PERMISO_COTIZACIONES}.`;
  if (code === "23505") return `${que}: ya existe una plantilla con ese identificador (otra persona la acaba de crear). Prueba con otro nombre.`;
  if (code === "23503") return `${que}: la plantilla elegida ya no existe (recarga la pantalla).`;
  if (code === "23514") return `${que}: un dato no cumple las reglas de la base (identificador, diseño, servicio o tipo de cliente).`;
  if (/failed to fetch|network/i.test(msg)) return `${que}: sin conexión con la base. Revisa tu internet y vuelve a intentarlo.`;
  return `${que}: ${msg || "error desconocido"}`;
}

/**
 * Lo que devolvió una escritura hecha CON `.select()`. Con RLS, un UPDATE, un DELETE o el lado
 * «update» de un upsert sin permiso NO da error: afecta cero filas. Cero filas nunca se da por guardado.
 */
export function filasDeVuelta<T>(
  res: { data: T[] | T | null; error: ErrorSupabase },
  que: string,
): { ok: true; filas: T[] } | { ok: false; detalle: string; cero: boolean } {
  if (res.error) return { ok: false, detalle: textoErrorEscritura(res.error, que), cero: false };
  const filas = res.data == null ? [] : Array.isArray(res.data) ? res.data : [res.data];
  if (filas.length === 0) return { ok: false, detalle: `${que}: no se guardó porque ${SIN_PERMISO_COTIZACIONES}.`, cero: true };
  return { ok: true, filas };
}

// ── Las cotizaciones antiguas que imprimen las condiciones de la plantilla EN VIVO ─────────

/** Columnas de migraciones accesorias que afinan el conteo; si faltan, se cuenta sin ellas. */
const OPCIONALES_CONTEO = ["idioma_pdf", "traslado_json"] as const;

/**
 * Cuántas cotizaciones ANTIGUAS (sin `consideraciones_json->>version`: guardadas antes de que cada
 * cotización copiara sus condiciones) imprimen hoy las condiciones de esta plantilla al
 * reimprimirse: las que la tienen en `plantilla_pdf` (la corporativa, también las que no dicen
 * ninguna), en castellano (en inglés la plantilla no se imprime) y que no son un traslado de la IA
 * (esas imprimen las de su fila).
 *
 * Con GET y `limit(1)`, no con HEAD: un HEAD que falla vuelve sin cuerpo, y sin el motivo no se
 * puede soltar la columna accesoria que falte. Lanza si no se pudo contar: nunca un 0 falso.
 */
export async function contarAntiguas(sb: Sb, plantillaId: string): Promise<number> {
  const usar = new Set<string>(OPCIONALES_CONTEO);
  for (let intento = 0; intento <= OPCIONALES_CONTEO.length; intento++) {
    let q = sb.from("cotizaciones").select("id", { count: "exact" }).is("consideraciones_json->>version", null);
    q = plantillaId === "corporativo" ? q.or("plantilla_pdf.eq.corporativo,plantilla_pdf.is.null") : q.eq("plantilla_pdf", plantillaId);
    if (usar.has("idioma_pdf")) q = q.or("idioma_pdf.is.null,idioma_pdf.neq.en");
    if (usar.has("traslado_json")) q = q.is("traslado_json", null);
    const { count, error } = await q.limit(1);
    if (!error) {
      if (typeof count !== "number") throw new Error("la base no devolvió el conteo");
      return count;
    }
    const col = faltaAlguna(error, [...usar]);
    if (!col) throw new Error(String(error?.message || "error desconocido"));
    usar.delete(col);
  }
  throw new Error("no se pudo contar");
}

// ── Listas y textos ──────────────────────────────────────────────────────────

/** Una lista de condiciones tal como se guarda: NULL sigue siendo NULL; las líneas, sin espacios de más y sin las vacías. */
export function listaLimpia(x: unknown): string[] | null {
  if (x == null) return null;
  if (!Array.isArray(x)) return null;
  return x.map(s => String(s ?? "").trim()).filter(Boolean);
}

export function mismaLista(a: string[] | null, b: string[] | null): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Un texto opcional: vacío → null (así el diseño usa el suyo y un dato mal puesto se puede borrar). */
export function textoOpcional(x: unknown): string | null {
  const t = String(x ?? "").trim();
  return t ? t : null;
}

/** Un color `#RRGGBB` (vive en lib/cotizacion-pdf.ts: el PDF tampoco interpola otra cosa en su CSS). */
export { colorValido };

/**
 * Los colores, títulos y cierres de fábrica de cada diseño, para «Restaurar». Sin nombres de
 * ninguna empresa (este ERP se vende). La corporativa no tiene: su color es fijo y su título sale
 * del idioma del PDF.
 */
export const DE_FABRICA: Partial<Record<Diseno, Record<string, string>>> = {
  moderno_fotos: { color_primario: "#1a1a2e", color_secundario: "#2f8ee9", titulo_documento: "PROPUESTA DE SERVICIO", mensaje_cierre: "Gracias por su confianza. Quedamos a su disposición para su próximo traslado." },
  turistico: { color_primario: "#b45309", color_secundario: "#d97706", titulo_documento: "COTIZACIÓN TURÍSTICA", mensaje_cierre: "¡Gracias por elegirnos! Nos vemos pronto." },
  ejecutivo: { color_primario: "#1a1a1a", color_acento: "#C8A24B", titulo_documento: "SERVICE QUOTATION / COTIZACIÓN", mensaje_cierre: "Thank you for your preference. We look forward to serving you." },
};

// ── Lo que la IA manda SIN revisión ──────────────────────────────────────────

/** Movida a lib/traslados/texto-libre.ts (el servidor la usa de respaldo); se re-exporta para la pantalla. */
export { motivosLineaIA };

/**
 * El aviso de una línea de condiciones de una plantilla que la IA usa (`enUso`) o puede usar (sirve
 * para traslados). Dice lo que de verdad pasa: con un enlace o un número de 6+ dígitos, el servidor
 * deja la cotización para revisión (`condicionesSospechosas`); con palabras de pago, sale igual sin
 * revisión, y por eso se pide revisar que no pida pagos.
 */
export function avisoLineaIA(linea: string, opts: { enUso?: boolean } = {}): string | null {
  const m = motivosLineaIA(linea);
  if (!m.length) return null;
  const enUso = opts.enUso !== false;
  const que = `Esta línea ${m.map(x => ETIQUETA_TEXTO_LIBRE[x]).join(" y ")}.`;
  if (m.some(x => MOTIVOS_CONDICION_REVISION.includes(x))) {
    return enUso
      ? `${que} Con ella, la IA no envía sola sus cotizaciones de traslado: quedan para que las revise un ejecutivo.`
      : `${que} Si asignas esta plantilla a traslados, la IA no enviará sola sus cotizaciones: quedarán para que las revise un ejecutivo.`;
  }
  return enUso
    ? `${que} La manda la IA sin revisión: revisa que no pida pagos.`
    : `${que} Si la asignas a traslados, esta línea la manda la IA sin revisión: revisa que no pida pagos.`;
}

/**
 * Lo que el `confirm()` de una celda «Traslado de la IA» dice de la plantilla que RESULTA (también al
 * vaciar la celda, que pasa a la principal): las cuentas que imprimirá el PDF en la moneda del
 * segmento —con la MISMA cuenta que el servidor (`cuentasFrenteACorporativo`), y si no son las de
 * `corporativo` la IA dejará cada cotización para revisión— y las líneas de sus condiciones que
 * merecen mirarse (`motivosLineaIA`). `perfil` undefined = no se pudo leer (no se afirman cuentas).
 * `resultante` null = la IA usa las condiciones de Ajustes y las cuentas de `corporativo`.
 */
export function lineasConfirmTraslado(x: {
  resultante: PlantillaFila | null;
  plantillas: readonly PlantillaFila[];
  perfil: PerfilEmpresa | null | undefined;
  segmento: Segmento;
}): string[] {
  const out: string[] = [];
  const moneda = x.segmento === "extranjero" ? "USD" : "PEN";
  const corp = plantillaPorId(x.plantillas, "corporativo");
  const pl = x.resultante ?? corp;
  if (x.perfil === undefined) {
    out.push("No se pudo leer el perfil de la empresa: no se puede decir qué cuentas bancarias imprimirá el PDF.");
  } else {
    const f = cuentasFrenteACorporativo({
      plantilla: pl,
      referencia: !x.resultante || x.resultante.id === "corporativo" ? { estado: "misma" } : { estado: "leida", cfg: corp },
      empresa: x.perfil, moneda,
    });
    out.push(`Cuentas bancarias que imprimirá el PDF (${moneda === "USD" ? "dólares" : "soles"}): ${f.plantilla.length ? f.plantilla.map(cuentaEnUnaLinea).join("; ") : "ninguna"}.`);
    if (f.codigo === "distintas") out.push("⚠ No son las de la plantilla «corporativo»: la IA dejará cada cotización de traslado para que la revise un ejecutivo antes de enviarla.");
  }
  if (x.resultante) {
    const lineas = [x.resultante.condiciones_incluye, x.resultante.condiciones_no_incluye, x.resultante.condiciones_generales]
      .flatMap(l => (Array.isArray(l) ? l : [])).map(s => String(s ?? "").trim()).filter(Boolean);
    for (const l of lineas) {
      const m = motivosLineaIA(l);
      if (!m.length) continue;
      const revisa = m.some(y => MOTIVOS_CONDICION_REVISION.includes(y));
      const corta = Array.from(l).length > 120 ? `${Array.from(l).slice(0, 119).join("")}…` : l;
      out.push(`⚠ «${corta}» ${m.map(y => ETIQUETA_TEXTO_LIBRE[y]).join(" y ")}${revisa ? ": con ella, la IA deja sus cotizaciones para revisión." : ": la IA la manda sin revisión, revisa que no pida pagos."}`);
    }
  }
  return out;
}
