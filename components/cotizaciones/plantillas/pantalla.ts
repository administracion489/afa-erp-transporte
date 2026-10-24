// ──────────────────────────────────────────────────────────────────────────────
// components/cotizaciones/plantillas/pantalla.ts — Lo que la pantalla /cotizaciones/plantillas
// necesita y no es regla de negocio: escribir pidiendo la fila de vuelta, contar las cotizaciones
// antiguas, limpiar listas y el aviso de las líneas que la IA manda sin revisión. Qué plantilla se
// usa, qué lee cada diseño y qué condiciones se copian viven en lib/cotizacion-plantillas.ts (PURO):
// esta pantalla los IMPORTA, no compone su propia versión.
// ──────────────────────────────────────────────────────────────────────────────

import { faltaAlguna, type ErrorSupabase } from "@/lib/columna-faltante";
import {
  CELDAS_TRASLADO, ETIQUETA_SERVICIO, disenoDe, esActiva, etiquetaCeldaTraslado, inglesActivo, inglesDisponible,
  plantillaPorId, plantillaTrasladoIA,
  type CeldaTraslado, type Diseno, type InglesTraslado, type PlantillaFila, type ReglaTraslado, type Segmento, type UsoPlantillaTraslado,
} from "@/lib/cotizacion-plantillas";
import { normalizarIdioma, type Idioma } from "@/lib/cotizacion-idioma";
import type { Moneda } from "@/lib/cotizacion-moneda";
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
 * La moneda sale de la celda: la de idioma × moneda (`celda`, cotizaciones-09) si viene; si no, la
 * vieja por segmento (dólares = `extranjero`).
 */
export function lineasConfirmTraslado(x: {
  resultante: PlantillaFila | null;
  plantillas: readonly PlantillaFila[];
  perfil: PerfilEmpresa | null | undefined;
  /** La celda idioma × moneda de la regla del traslado (cotizaciones-09). Manda sobre `segmento`. */
  celda?: CeldaTraslado;
  /** La celda vieja (servicio × segmento), sin cotizaciones-09. */
  segmento?: Segmento;
}): string[] {
  const out: string[] = [];
  const moneda: Moneda = x.celda ? (x.celda.moneda === "USD" ? "USD" : "PEN") : x.segmento === "extranjero" ? "USD" : "PEN";
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
    const lineas = [x.resultante.condiciones_incluye, x.resultante.condiciones_no_incluye, x.resultante.condiciones_generales, x.resultante.condiciones_reserva, x.resultante.condiciones_reserva_resumen]
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

// ── El traslado de la IA por idioma × moneda (supabase/cotizaciones-09) ────────────────────
// Qué plantilla usa cada celda lo dice `plantillaTrasladoIA` y si el inglés está encendido lo dice
// `inglesDisponible` (lib/cotizacion-plantillas.ts, PURO): aquí solo se decide CÓMO SE DICE. La única
// regla propia de la pantalla es que una celda «inglés» con el inglés apagado no se usa (la IA cotiza
// todo en castellano), así que lo que el motor contesta para ella es lo que PASARÍA, no lo que pasa:
// se pinta en gris, salvo que tenga una regla escrita que la IA no puede usar (ámbar: alguien quiso
// encender el inglés y no quedó encendido).

const NOMBRE_MONEDA: Record<Moneda, string> = { PEN: "soles", USD: "dólares" };

/** La fila «Castellano» de la cuadrícula del traslado. */
export const DESCRIPCION_FILA_CASTELLANO = "El cliente escribe en castellano (o no se sabe en qué idioma escribe).";
/** La fila «Inglés» de la cuadrícula del traslado. */
export const DESCRIPCION_FILA_INGLES = "El cliente escribe en inglés u otro idioma: el PDF y los mensajes van en inglés.";
/** Sin ninguna celda «inglés» que sirva. */
export const INGLES_APAGADO = "Inglés apagado: los clientes que escriben en inglés reciben todo en castellano, como hoy.";
/**
 * Lo que pasa al encender el inglés. La moneda es la de `monedaDelPedido` (lib/traslados/motor.ts):
 * la matriz de esta pantalla comprueba la frase contra el motor, para que no describa otra cosa.
 */
export const AL_ENCENDER_INGLES = "Se ENCIENDE el inglés: a quien escribe en inglés u otro idioma, la IA le cotiza en inglés (el PDF y los mensajes del sistema). A quien escribe en inglés se le cotiza con la lista en dólares aunque escriba desde un número peruano, salvo que pida soles.";
export const AL_APAGAR_INGLES = "Se APAGA el inglés: los clientes que escriben en inglés vuelven a recibir todo en castellano, como antes.";

export type TonoCelda = "ok" | "gris" | "ambar";

export type EstadoCeldaTraslado = {
  celda: CeldaTraslado;
  /** La regla escrita en la celda; null = vacía. */
  regla: ReglaTraslado | null;
  /** Lo que contesta el motor (`plantillaTrasladoIA`). En una celda «inglés» con el inglés apagado es lo que PASARÍA. */
  uso: UsoPlantillaTraslado;
  /** ¿La IA usa hoy esta celda? Castellano: siempre. Inglés: solo con el inglés encendido (`inglesActivo`). */
  vigente: boolean;
  /** ok = la usa la IA sin nada que decir; gris = no se usa; ámbar = la regla escrita no es la que se usa, o queda en revisión. */
  tono: TonoCelda;
  texto: string;
};

export type EstadoTraslado = { ingles: InglesTraslado; activo: boolean; celdas: EstadoCeldaTraslado[] };

/** Por qué la IA no puede usar esa plantilla en ese idioma (la opción «⚠» del desplegable y los avisos). */
export function porQueNoSirveIA(p: PlantillaFila | null, idioma: Idioma): string {
  if (!p) return "ya no existe";
  if (!esActiva(p)) return "está desactivada";
  if (disenoDe(p) !== "corporativo") return "no es del diseño Corporativo (es el único que dibuja la IA)";
  return idioma === "en" ? "no está en inglés" : "está en inglés";
}

const nombrePl = (p: PlantillaFila) => `«${p.nombre || p.id}»`;
const celdaIgual = (a: CeldaTraslado, b: CeldaTraslado) => a.idioma === b.idioma && a.moneda === b.moneda;

/** Las cuatro celdas de la regla del traslado y el interruptor del inglés, como los pinta la cuadrícula. */
export function estadosTraslado(plantillas: readonly PlantillaFila[], reglasTraslado: readonly ReglaTraslado[]): EstadoTraslado {
  const ingles = inglesDisponible(plantillas, reglasTraslado) ?? { PEN: false, USD: false };
  const activo = inglesActivo(ingles);
  const celdas = CELDAS_TRASLADO.map((celda): EstadoCeldaTraslado => {
    const regla = reglasTraslado.find(r => celdaIgual(r, celda)) ?? null;
    // Con la tabla nueva el motor no mira las reglas viejas: `legado` va por la firma.
    const uso = plantillaTrasladoIA(celda, plantillas, reglasTraslado, { reglas: null, segmento: celda.moneda === "USD" ? "extranjero" : "particular" });
    const vigente = celda.idioma === "es" || activo;
    let tono: TonoCelda;
    let texto: string;
    if (!vigente) {
      if (!regla) {
        tono = "gris";
        texto = "Sin plantilla: el inglés está apagado.";
      } else {
        // Una regla escrita que la IA no puede usar (si pudiera, el inglés estaría encendido).
        const p = plantillaPorId(plantillas, regla.plantilla_id);
        tono = "ambar";
        texto = `${etiquetaCeldaTraslado(celda)}: la regla apunta a ${p ? nombrePl(p) : `«${regla.plantilla_id}»`}, que ${porQueNoSirveIA(p, "en")}: la IA no la puede usar, así que el inglés sigue apagado.`;
      }
    } else if ((uso.codigo === "regla" || uso.codigo === "principal") && uso.plantilla) {
      tono = "ok";
      texto = `Usa ${nombrePl(uso.plantilla)} (${uso.codigo === "regla" ? "por esta regla" : "la principal"}).`;
    } else {
      // regla_inactiva, regla_no_sirve_ia, sin_plantilla o sin_plantilla_idioma: lo explica el motor.
      tono = "ambar";
      texto = uso.detalle;
    }
    return { celda, regla, uso, vigente, tono, texto };
  });
  return { ingles, activo, celdas };
}

/** El texto de una celda con su nombre delante (los del motor ya lo traen). */
export function textoConCelda(e: EstadoCeldaTraslado): string {
  const et = etiquetaCeldaTraslado(e.celda);
  return e.texto.startsWith(et) ? e.texto : `${et}: ${e.texto}`;
}

/** «castellano · soles»: el nombre corto de una celda (sin «Traslado de la IA · »). */
export function celdaTrasladoCorta(c: CeldaTraslado): string {
  const et = etiquetaCeldaTraslado(c);
  const pre = `${ETIQUETA_SERVICIO.traslado_ia} · `;
  return et.startsWith(pre) ? et.slice(pre.length) : et;
}

/** La línea del inglés bajo la cuadrícula: gris apagado (con cómo se enciende), o encendido. */
export function lineaInglesTraslado(e: EstadoTraslado, plantillasEnIngles: number): { tono: TonoCelda; texto: string } {
  if (!e.activo) {
    const como = plantillasEnIngles > 0
      ? "Para encenderlo, asigna una plantilla en inglés a una de las dos celdas de la fila Inglés."
      : "Todavía no hay ninguna plantilla en inglés que la IA pueda usar: duplica una del diseño Corporativo, ponle el idioma English y escribe sus condiciones en inglés.";
    return { tono: "gris", texto: `${INGLES_APAGADO} ${como}` };
  }
  return { tono: "ok", texto: "Inglés encendido: a quien escribe en inglés u otro idioma, la IA le cotiza en inglés (el PDF y los mensajes del sistema), en soles y en dólares. Qué plantilla lleva cada moneda lo dice su celda." };
}

export type CambioTraslado = {
  antes: EstadoTraslado;
  despues: EstadoTraslado;
  ingles: "enciende" | "apaga" | null;
  /** Las celdas en que cambia lo que pasa: si se usan, con qué plantilla, por qué (el código del motor) o su tono. Un nombre nuevo no cuenta. */
  celdas: { celda: CeldaTraslado; antes: EstadoCeldaTraslado; despues: EstadoCeldaTraslado }[];
};

/** Qué cambia en el traslado de la IA entre dos estados (reglas o plantillas distintas), con el mismo motor. */
export function cambiosTraslado(
  antes: { plantillas: readonly PlantillaFila[]; reglasTraslado: readonly ReglaTraslado[] },
  despues: { plantillas: readonly PlantillaFila[]; reglasTraslado: readonly ReglaTraslado[] },
): CambioTraslado {
  const a = estadosTraslado(antes.plantillas, antes.reglasTraslado);
  const d = estadosTraslado(despues.plantillas, despues.reglasTraslado);
  const celdas = a.celdas.map((x, i) => ({ celda: x.celda, antes: x, despues: d.celdas[i] }))
    .filter(c => c.antes.vigente !== c.despues.vigente || c.antes.tono !== c.despues.tono || c.antes.uso.codigo !== c.despues.uso.codigo
      || (c.antes.uso.plantilla?.id ?? null) !== (c.despues.uso.plantilla?.id ?? null));
  return { antes: a, despues: d, ingles: !a.activo && d.activo ? "enciende" : a.activo && !d.activo ? "apaga" : null, celdas };
}

/**
 * Lo que cambia en el traslado de la IA, dicho en líneas (para el `confirm()` al guardar o activar
 * una plantilla y para la pestaña Idioma): si el inglés se enciende o se apaga, y cómo queda cada
 * celda que cambia. Vacío = nada cambia.
 */
export function lineasCambioTraslado(c: CambioTraslado): string[] {
  const out: string[] = [];
  if (c.ingles === "enciende") out.push(AL_ENCENDER_INGLES);
  if (c.ingles === "apaga") out.push(AL_APAGAR_INGLES);
  for (const x of c.celdas) {
    const ambar = x.despues.tono === "ambar";
    if (x.despues.vigente || ambar) out.push(`${ambar ? "⚠ " : ""}${textoConCelda(x.despues)}`);
    else if (x.antes.vigente) out.push(`${etiquetaCeldaTraslado(x.celda)}: deja de usarse (el inglés queda apagado).`);
    // una celda «inglés» que sigue sin usarse y sin aviso: nada que decir.
  }
  return out;
}

/**
 * El `confirm()` de una celda de la regla del traslado: si el inglés se enciende o se apaga, a quién
 * le llegan desde ahora qué condiciones y qué cuentas (`lineasConfirmTraslado`), y las otras celdas
 * que pasan a ámbar (al encender el inglés, la otra moneda sin plantilla en inglés queda en revisión).
 * `nuevo` vacío = quitar la regla.
 */
export function confirmCeldaTraslado(x: {
  celda: CeldaTraslado;
  nuevo: string;
  plantillas: readonly PlantillaFila[];
  reglasTraslado: readonly ReglaTraslado[];
  perfil: PerfilEmpresa | null | undefined;
}): string {
  const c: CeldaTraslado = { idioma: normalizarIdioma(x.celda?.idioma), moneda: x.celda?.moneda === "USD" ? "USD" : "PEN" };
  const otras = x.reglasTraslado.filter(r => !celdaIgual(r, c));
  const nuevas = x.nuevo ? [...otras, { ...c, plantilla_id: x.nuevo }] : otras;
  const cambio = cambiosTraslado({ plantillas: x.plantillas, reglasTraslado: x.reglasTraslado }, { plantillas: x.plantillas, reglasTraslado: nuevas });
  const e = cambio.despues.celdas.find(z => celdaIgual(z.celda, c)) as EstadoCeldaTraslado;
  const partes: string[] = [];
  if (cambio.ingles === "enciende") partes.push(AL_ENCENDER_INGLES);
  if (cambio.ingles === "apaga") partes.push(AL_APAGAR_INGLES);
  let detalle: string[] = [];
  if (e.vigente) {
    const quien = c.idioma === "en"
      ? `a clientes que escriben en inglés u otro idioma, en ${NOMBRE_MONEDA[c.moneda]},`
      : cambio.despues.activo ? `a clientes que escriben en castellano, en ${NOMBRE_MONEDA[c.moneda]},` : `en ${NOMBRE_MONEDA[c.moneda]}`;
    const destino = e.uso.plantilla
      ? `las condiciones y las cuentas de la plantilla ${nombrePl(e.uso.plantilla)}`
      : "las condiciones de /tarifario → Ajustes de traslados (no queda una plantilla que la IA pueda usar)";
    partes.push(`Los traslados que cotiza la IA ${quien} salen por WhatsApp SIN revisión. Desde ahora llevarán ${destino}.`);
    detalle = lineasConfirmTraslado({ resultante: e.uso.plantilla, plantillas: x.plantillas, perfil: x.perfil, celda: c });
  } else {
    partes.push("El inglés queda apagado: esta celda no se usa hasta que una de las dos celdas de la fila Inglés tenga una plantilla en inglés que la IA pueda usar.");
  }
  const avisos = [e, ...cambio.celdas.filter(z => !celdaIgual(z.celda, c)).map(z => z.despues)]
    .filter(z => z.tono === "ambar").map(z => `⚠ ${textoConCelda(z)}`);
  const lineas = [...detalle, ...avisos];
  return `${partes.join("\n\n")}${lineas.length ? `\n\n• ${lineas.join("\n• ")}` : ""}\n\n¿Cambiar la regla ${etiquetaCeldaTraslado(c)}?`;
}
