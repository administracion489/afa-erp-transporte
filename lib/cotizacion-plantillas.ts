// ──────────────────────────────────────────────────────────────────────────────
// lib/cotizacion-plantillas.ts — Las plantillas del PDF de la cotización: qué DISEÑO dibuja cada
// una, cuál se usa para cada cotización (REGLAS de uso) y qué CONDICIONES quedan escritas en la
// fila. Motor PURO (navegador y servidor): no lee la base; eso es lib/cotizacion-plantillas-datos.ts.
// Matriz: npx tsx scripts/prueba-cotizacion-plantillas.mts
//
// 1. LA PLANTILLA ES EL CONTENIDO Y LLEVA SU DISEÑO. Antes el id era a la vez el diseño (cuatro
//    filas fijas: `corporativo`, `moderno_fotos`, `turistico`, `ejecutivo`), así que no podía haber
//    dos plantillas con el mismo diseño. Desde supabase/cotizaciones-05 la columna `diseno` dice
//    cuál de los cuatro dibuja; sin la migración, el id de las cuatro de siempre ES su diseño
//    (`disenoDe`), y cualquier otra cosa dibuja la corporativa, como hacía `htmlCotizacion`.
//
// 2. QUÉ PLANTILLA SE USA LO DECIDEN REGLAS, servicio × segmento (`plantillaParaUso`). Una celda
//    vacía usa la PRINCIPAL. El segmento sale del cliente y de la moneda (`segmentoDeCliente`):
//    dólares es `extranjero` aunque el cliente sea una empresa, porque es la lista de precio turista
//    y sus condiciones (`consideraciones_usd`) son otras. El servicio sale de la cotización
//    (`servicioDeCotizacion`). Las reglas eligen AL CREAR; la cotización recuerda su plantilla en
//    `plantilla_pdf` y al imprimir se puede cambiar.
//
// 3. EL TRASLADO DE LA IA SOLO PUEDE USAR LO QUE EL SERVIDOR SABE DIBUJAR: diseño corporativo
//    (lib/pdf-corporativo.ts, pdf-lib) y en el IDIOMA de la cotización (`sirveParaIA(p, idioma)`).
//    Una celda que apunta a otra cosa no se obedece: se usa la principal si sirve, y si no, nada — y
//    quien llama vuelve a las condiciones de `traslados_config`. Nunca se devuelve una plantilla
//    inactiva. Desde supabase/cotizaciones-09 la regla del traslado es IDIOMA × MONEDA, en su propia
//    tabla (`TABLA_REGLAS_TRASLADO`, cuatro celdas: `plantillaTrasladoIA`); sin esa tabla, la de
//    siempre (servicio × segmento), byte a byte. EL INGLÉS SE ENCIENDE CON UN DATO, NO CON UN SQL:
//    solo cuando una persona asigna una plantilla en inglés que la IA pueda usar a una celda
//    «inglés» (`inglesDisponible`). Correr la migración no lo enciende: los +51 que escriben en
//    inglés pasarían a dólares sin que nadie lo decidiera. En inglés, una celda sin plantilla
//    inglesa que sirva cae a la de castellano de la MISMA moneda y lo DICE (`sin_plantilla_idioma`):
//    las condiciones salen en castellano y la cotización queda en revisión (envio-ia.ts →
//    `condiciones_en_otro_idioma`) — no se traduce lo que nadie escribió. EN INGLÉS NUNCA SE CAE A LA
//    PRINCIPAL (revisión de seguridad, 23-10-2026): una principal en inglés no es la decisión de cotizar
//    en inglés en ESA moneda, y con ella la cotización salía sola con las condiciones de la principal
//    mientras Ajustes decía «queda en revisión». Solo una celda inglés ASIGNADA alimenta un envío
//    automático en inglés.
//
// 4. LAS CONDICIONES SE COPIAN A LA FILA (versión 2, `CONSID_VERSION` en lib/cotizacion-idioma.ts).
//    Antes, en español, las de la plantilla ganaban sobre las de la fila al IMPRIMIR: lo que el
//    operador editaba en «Consideraciones» se guardaba y no salía, y editar la plantilla cambiaba
//    el PDF de cotizaciones ya enviadas. Ahora `considSnapshot` las copia al crear y el PDF imprime
//    la fila. Las filas de antes no cambian de PDF; al abrir una, el formulario carga lo que su PDF
//    imprime hoy (`considParaFormulario`), así que guardarla tampoco lo cambia (la matriz barre ese
//    ciclo contra el HTML entero de los cuatro diseños).
//
// 5. EL EDITOR SOLO OFRECE LO QUE EL DISEÑO LEE (`CAMPOS_POR_DISENO`). La matriz lo comprueba
//    contra `htmlCotizacion` con valores centinela: el campo se ofrece ⟺ cambia el PDF. Un control
//    que el sistema no lee es peor que no ofrecerlo.
//
// 6. ESTE ERP SE VENDE: ni un nombre, RUC ni texto de una empresa en este archivo. El ejemplo de la
//    vista previa (`ejemploParaVistaPrevia`) es de mentira a propósito.
//
// 7. LA CUARTA LISTA: «RESERVA, CAMBIOS Y CANCELACIÓN» (`condiciones_reserva` de la plantilla →
//    `consideraciones_json.reserva` de la fila; supabase/cotizaciones-06, `SQL_POLITICA_RESERVA`).
//    Es la política que la IA del CRM envía al cliente y que el PDF imprime: una sola fuente. Sigue
//    las reglas de las otras tres (se copia al crear, versión 2, la plantilla gana en una fila de
//    antes en castellano) con dos diferencias: no tiene lista de fábrica (la escribe cada empresa) y
//    es OPCIONAL de punta a punta — sin la columna, con NULL o sin la clave en la fila, el snapshot no
//    la lleva y el PDF no imprime nada, así que todo lo de antes sale byte a byte igual. Solo la
//    imprime el diseño corporativo (`CAMPOS_POR_DISENO`, medido con centinelas como las demás).
//
// 8. SU RESUMEN (`condiciones_reserva_resumen` → `consideraciones_json.reserva_resumen`;
//    supabase/cotizaciones-08, `SQL_RESUMEN_CONDICIONES`). Los 4-5 puntos de dinero que escribe una
//    persona; el ERP no recorta la política. Se copia con la política y SOLO si la fila lleva líneas
//    de política (un resumen sin política no resume nada), y siempre de la MISMA fuente que la
//    política (la plantilla, o el respaldo si la plantilla no tiene política). El PDF lo imprime en
//    lugar de la política solo con el enlace a las condiciones completas de la cotización
//    (`politicaParaImprimir`); sin enlace, la política entera.
// ──────────────────────────────────────────────────────────────────────────────

import { CONSID_VERSION, DEFAULT_CONSID_ES, esConsidFijada, normalizarIdioma, type ConsidCot, type ConsidFila, type Idioma } from "./cotizacion-idioma";
import { SQL_RESUMEN_CONDICIONES } from "./condiciones-publicas";
import { normalizarMoneda, type Moneda } from "./cotizacion-moneda";
import type { AvisoPdf, EntradaPdfCot, PlantillaPdfCfg } from "./cotizacion-pdf";

// Viven en lib/cotizacion-idioma.ts (los lee `considParaPdf`, que no puede importar este módulo sin
// un ciclo) y se re-exportan aquí, que es donde los buscan las pantallas.
export { CONSID_VERSION, esConsidFijada };
export type { ConsidFila };

// ── El catálogo ──────────────────────────────────────────────────────────────

export const DISENOS = ["corporativo", "moderno_fotos", "turistico", "ejecutivo"] as const;
export type Diseno = (typeof DISENOS)[number];

export const SERVICIOS_PLANTILLA = ["traslado_ia", "eventual", "turismo", "fijo"] as const;
export type ServicioPlantilla = (typeof SERVICIOS_PLANTILLA)[number];

export const SEGMENTOS = ["empresa", "particular", "extranjero"] as const;
export type Segmento = (typeof SEGMENTOS)[number];

export const ETIQUETA_DISENO: Record<Diseno, string> = {
  corporativo: "Corporativo",
  moderno_fotos: "Moderno con fotos",
  turistico: "Turístico",
  ejecutivo: "Ejecutivo",
};

export const ETIQUETA_SERVICIO: Record<ServicioPlantilla, string> = {
  traslado_ia: "Traslado de la IA",
  eventual: "Eventual",
  turismo: "Turismo",
  fijo: "Fijo",
};

export const DESCRIPCION_SERVICIO: Record<ServicioPlantilla, string> = {
  traslado_ia: "El traslado que cotiza la IA del CRM y se envía por WhatsApp.",
  eventual: "Servicio eventual: solo ida, ida y retorno, con paradas.",
  turismo: "Full day y multi-día.",
  fijo: "Servicio fijo (transporte de personal).",
};

export const ETIQUETA_SEGMENTO: Record<Segmento, string> = {
  empresa: "Empresa",
  particular: "Particular",
  extranjero: "Extranjero",
};

export const DESCRIPCION_SEGMENTO: Record<Segmento, string> = {
  empresa: "Cliente del ERP de tipo empresa (B2B), cotizado en soles.",
  particular: "Cliente particular (B2C) o sin cliente del ERP, cotizado en soles.",
  extranjero: "Cotizado en dólares, sea cual sea el tipo de cliente.",
};

/** «Turismo · particular»: el nombre de una celda de las reglas. */
export function etiquetaCelda(u: { servicio: ServicioPlantilla; segmento: Segmento }): string {
  return `${ETIQUETA_SERVICIO[u.servicio] ?? String(u.servicio)} · ${(ETIQUETA_SEGMENTO[u.segmento] ?? String(u.segmento)).toLowerCase()}`;
}

/** El SQL que crea `diseno` y la tabla de reglas. Sin él, la pantalla lo nombra en ámbar. */
export const SQL_PLANTILLAS_USO = "supabase/cotizaciones-05-plantillas-uso.sql";

/** El SQL que agrega `condiciones_reserva` (la política de reserva). Sin él, el editor lo nombra. */
export const SQL_POLITICA_RESERVA = "supabase/cotizaciones-06-politica-reserva.sql";

/** El SQL que agrega el resumen de la política y el token del enlace (vive en lib/condiciones-publicas.ts). */
export { SQL_RESUMEN_CONDICIONES };

export const TABLA_PLANTILLAS = "cotizacion_plantillas";
export const TABLA_REGLAS = "cotizacion_plantilla_reglas";

/** La regla del traslado de la IA por idioma × moneda (cotizaciones-09). Sin ella, la vieja por segmento. */
export const TABLA_REGLAS_TRASLADO = "cotizacion_plantilla_reglas_traslado";
/** El SQL que crea esa tabla. Sin él, la pantalla lo nombra y la IA cotiza en castellano, como siempre. */
export const SQL_REGLAS_TRASLADO = "supabase/cotizaciones-09-reglas-traslado-idioma.sql";

/** Las plantillas a las que la migración traspasa las condiciones de `traslados_config`. */
export const ID_PLANTILLA_TRASLADOS = "traslados_ia";
export const ID_PLANTILLA_TRASLADOS_USD = "traslados_ia_usd";

// ── Tipos ────────────────────────────────────────────────────────────────────

/** Una fila de `cotizacion_plantillas` (`select *`): lo que lee el PDF más su identidad y su uso. */
export type PlantillaFila = PlantillaPdfCfg & {
  id: string;
  nombre: string;
  activa?: boolean | null;
  es_principal?: boolean | null;
  /** cotizaciones-05. Ausente (sin la migración) → `disenoDe` usa el id. */
  diseno?: string | null;
  idioma?: string | null;
  orden?: number | null;
  icono?: string | null;
  descripcion?: string | null;
};

/** Una celda de `cotizacion_plantilla_reglas`. */
export type ReglaPlantilla = { servicio: ServicioPlantilla; segmento: Segmento; plantilla_id: string };

/** Una celda de la regla del traslado de la IA (cotizaciones-09): idioma × moneda. */
export type CeldaTraslado = { idioma: Idioma; moneda: Moneda };
/** Una fila de `cotizacion_plantilla_reglas_traslado`. */
export type ReglaTraslado = CeldaTraslado & { plantilla_id: string };

/** Las cuatro celdas, en el orden en que se pintan (los MISMOS valores que los CHECK de cotizaciones-09). */
export const CELDAS_TRASLADO: readonly CeldaTraslado[] = [
  { idioma: "es", moneda: "PEN" }, { idioma: "es", moneda: "USD" },
  { idioma: "en", moneda: "PEN" }, { idioma: "en", moneda: "USD" },
];

const NOMBRE_IDIOMA_CELDA: Record<Idioma, string> = { es: "castellano", en: "inglés" };
const NOMBRE_MONEDA_CELDA: Record<Moneda, string> = { PEN: "soles", USD: "dólares" };

/** «Traslado de la IA · inglés · dólares»: el nombre de una celda de la regla del traslado. */
export function etiquetaCeldaTraslado(c: CeldaTraslado): string {
  return `${ETIQUETA_SERVICIO.traslado_ia} · ${NOMBRE_IDIOMA_CELDA[c?.idioma] ?? String(c?.idioma)} · ${NOMBRE_MONEDA_CELDA[c?.moneda] ?? String(c?.moneda)}`;
}

// ── Diseño, segmento y servicio ──────────────────────────────────────────────

export function esDiseno(x: unknown): x is Diseno {
  return typeof x === "string" && (DISENOS as readonly string[]).includes(x);
}

/** El diseño que dibuja la plantilla: el declarado si es válido; si no, el id si es un diseño; si no, la corporativa. */
export function disenoDe(p: { id: string; diseno?: string | null }): Diseno {
  const d = String(p?.diseno ?? "").trim().toLowerCase();
  if (esDiseno(d)) return d;
  const id = String(p?.id ?? "").trim().toLowerCase();
  if (esDiseno(id)) return id;
  return "corporativo";
}

/** Una plantilla está activa salvo que diga `activa = false` (sin el dato, como la columna por defecto). */
export function esActiva(p: { activa?: boolean | null } | null | undefined): boolean {
  return !!p && p.activa !== false;
}

/**
 * El segmento de una cotización: (1) en dólares → `extranjero` (la lista de precio turista; gana
 * sobre el tipo de cliente); (2) cliente `b2b` → `empresa`; (3) lo demás —b2c o sin cliente del
 * ERP— → `particular`. En la IA, `tipoCliente` solo puede salir de un cliente ya VERIFICADO.
 */
export function segmentoDeCliente(x: { moneda: unknown; tipoCliente?: string | null }): Segmento {
  if (normalizarMoneda(x?.moneda) === "USD") return "extranjero";
  if (String(x?.tipoCliente ?? "").trim().toLowerCase() === "b2b") return "empresa";
  return "particular";
}

/**
 * ¿Es un traslado cotizado por la IA? (`traslado_json` es un objeto). Extraída de
 * components/cotizaciones/pdf-traslado.ts, que la re-exporta: una sola definición.
 */
export function esTrasladoIA(cot: { traslado_json?: unknown } | null | undefined): boolean {
  const tj = cot?.traslado_json;
  return !!tj && typeof tj === "object" && !Array.isArray(tj);
}

const TIPOS_TURISMO = ["full_day", "multi_dia"];

/**
 * El servicio de una cotización: (1) traslado de la IA (`traslado_json`); (2) `modo_servicio =
 * fijo`; (3) full day o multi-día (en `tipo_servicio` o en `modo_servicio`); (4) eventual.
 */
export function servicioDeCotizacion(c: { traslado_json?: unknown; modo_servicio?: string | null; tipo_servicio?: string | null }): ServicioPlantilla {
  if (esTrasladoIA(c)) return "traslado_ia";
  const modo = String(c?.modo_servicio ?? "").trim().toLowerCase();
  const tipo = String(c?.tipo_servicio ?? "").trim().toLowerCase();
  if (modo === "fijo") return "fijo";
  if (TIPOS_TURISMO.includes(tipo) || TIPOS_TURISMO.includes(modo)) return "turismo";
  return "eventual";
}

/**
 * ¿La IA puede mandar su PDF con esta plantilla, en ese idioma? Solo si está activa, dibuja el
 * diseño corporativo (lo único que sabe dibujar el servidor) y está en el idioma de la cotización.
 * En castellano (el defecto) es exactamente la regla de siempre: cualquier idioma que no sea el
 * inglés. En inglés, solo una plantilla marcada en inglés: unas condiciones en castellano en un PDF
 * en inglés serían un documento a medias.
 */
export function sirveParaIA(p: PlantillaFila | null | undefined, idioma: Idioma = "es"): boolean {
  if (!p || !esActiva(p) || disenoDe(p) !== "corporativo") return false;
  return idioma === "en" ? normalizarIdioma(p.idioma) === "en" : normalizarIdioma(p.idioma) !== "en";
}

// ── Qué plantilla se usa ─────────────────────────────────────────────────────

const ordenar = (a: PlantillaFila, b: PlantillaFila): number => {
  const oa = typeof a.orden === "number" && Number.isFinite(a.orden) ? a.orden : Infinity;
  const ob = typeof b.orden === "number" && Number.isFinite(b.orden) ? b.orden : Infinity;
  if (oa !== ob) return oa < ob ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/** La plantilla principal: activa y marcada `es_principal` (con dos, la de menor `orden`, luego id). */
export function plantillaPrincipal(plantillas: readonly PlantillaFila[]): PlantillaFila | null {
  const cand = (plantillas ?? []).filter(p => p && p.es_principal === true && esActiva(p));
  return cand.length ? [...cand].sort(ordenar)[0] : null;
}

export function plantillaPorId(plantillas: readonly PlantillaFila[], id: string | null | undefined): PlantillaFila | null {
  if (!id) return null;
  return (plantillas ?? []).find(p => p && p.id === id) ?? null;
}

/** Las celdas que apuntan a esta plantilla (para «Se usa en: …» y para no desactivarla en uso). */
export function reglasQueUsan(reglas: readonly ReglaPlantilla[] | null | undefined, plantillaId: string): ReglaPlantilla[] {
  return (reglas ?? []).filter(r => r.plantilla_id === plantillaId);
}

/** Las filas de la tabla de reglas que se pueden usar: servicio y segmento conocidos, una por celda. */
export function normalizarReglas(filas: readonly unknown[] | null | undefined): ReglaPlantilla[] {
  const out: ReglaPlantilla[] = [];
  const vistas = new Set<string>();
  for (const f of filas ?? []) {
    if (!f || typeof f !== "object") continue;
    const r = f as { servicio?: unknown; segmento?: unknown; plantilla_id?: unknown };
    if (!(SERVICIOS_PLANTILLA as readonly unknown[]).includes(r.servicio)) continue;
    if (!(SEGMENTOS as readonly unknown[]).includes(r.segmento)) continue;
    if (typeof r.plantilla_id !== "string" || !r.plantilla_id.trim()) continue;
    const clave = `${r.servicio}|${r.segmento}`;
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    out.push({ servicio: r.servicio as ServicioPlantilla, segmento: r.segmento as Segmento, plantilla_id: r.plantilla_id });
  }
  return out;
}

/**
 * Las filas de la regla del traslado que se pueden usar: idioma y moneda conocidos (los valores
 * EXACTOS del CHECK; nada se normaliza: escribir y leer con la misma identidad), una por celda.
 */
export function normalizarReglasTraslado(filas: readonly unknown[] | null | undefined): ReglaTraslado[] {
  const out: ReglaTraslado[] = [];
  const vistas = new Set<string>();
  for (const f of filas ?? []) {
    if (!f || typeof f !== "object") continue;
    const r = f as { idioma?: unknown; moneda?: unknown; plantilla_id?: unknown };
    if (r.idioma !== "es" && r.idioma !== "en") continue;
    if (r.moneda !== "PEN" && r.moneda !== "USD") continue;
    if (typeof r.plantilla_id !== "string" || !r.plantilla_id.trim()) continue;
    const clave = `${r.idioma}|${r.moneda}`;
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    out.push({ idioma: r.idioma, moneda: r.moneda, plantilla_id: r.plantilla_id });
  }
  return out;
}

/** Las celdas de la regla del traslado que apuntan a esta plantilla. */
export function reglasTrasladoQueUsan(r: readonly ReglaTraslado[] | null | undefined, id: string): ReglaTraslado[] {
  return (r ?? []).filter(x => x.plantilla_id === id);
}

/**
 * - `regla`: la celda tiene una plantilla que se puede usar.
 * - `principal`: la celda está vacía → la principal.
 * - `regla_inactiva`: la celda apunta a una plantilla desactivada o que ya no existe → la principal.
 * - `regla_no_sirve_ia`: celda `traslado_ia` con una plantilla que la IA no dibuja → la principal.
 * - `sin_reglas`: falta la tabla de reglas (el SQL). En `traslado_ia` devuelve null (quien llama usa
 *   `traslados_config`, como antes); en los demás, la principal.
 * - `sin_plantilla`: no hay una principal que sirva → null.
 * - `sin_plantilla_idioma` (solo `plantillaTrasladoIA`): la celda «inglés» no tiene ASIGNADA una
 *   plantilla en inglés que sirva (la principal no cuenta en inglés) → la de la celda castellano de
 *   la MISMA moneda, con sus condiciones en castellano (`idiomaCondiciones: "es"`).
 */
export type CodigoUso = "regla" | "principal" | "regla_inactiva" | "regla_no_sirve_ia" | "sin_reglas" | "sin_plantilla" | "sin_plantilla_idioma";

export type UsoPlantilla = { plantilla: PlantillaFila | null; codigo: CodigoUso; detalle: string };

/** La plantilla que usa una cotización de ese servicio y ese segmento. Nunca devuelve una inactiva. */
export function plantillaParaUso(
  u: { servicio: ServicioPlantilla; segmento: Segmento },
  plantillas: readonly PlantillaFila[],
  reglas: readonly ReglaPlantilla[] | null,
): UsoPlantilla {
  const esIA = u.servicio === "traslado_ia";
  const celdaTxt = etiquetaCelda(u);
  const principal = plantillaPrincipal(plantillas);
  const sirve = (p: PlantillaFila | null): p is PlantillaFila => !!p && esActiva(p) && (!esIA || sirveParaIA(p));
  const nombre = (p: PlantillaFila) => `«${p.nombre || p.id}»`;

  const conPrincipal = (codigo: CodigoUso, porque: string): UsoPlantilla => {
    if (sirve(principal)) return { plantilla: principal, codigo, detalle: `${porque} Se usa la plantilla principal ${nombre(principal)}.` };
    const falta = !principal
      ? "No hay una plantilla principal activa."
      : `La plantilla principal ${nombre(principal)} no la puede usar la IA (solo dibuja el diseño corporativo y en castellano).`;
    return { plantilla: null, codigo: "sin_plantilla", detalle: `${porque} ${falta}${esIA ? " La IA usa las condiciones de Ajustes de traslados." : ""}` };
  };

  if (reglas === null) {
    if (esIA) {
      return { plantilla: null, codigo: "sin_reglas", detalle: `Falta ${SQL_PLANTILLAS_USO}: el traslado de la IA usa las condiciones de Ajustes de traslados, como siempre.` };
    }
    return conPrincipal("sin_reglas", `Falta ${SQL_PLANTILLAS_USO}: todavía no hay reglas de uso.`);
  }

  const celda = reglas.find(r => r.servicio === u.servicio && r.segmento === u.segmento);
  if (!celda) return conPrincipal("principal", `${celdaTxt}: sin regla.`);
  const p = plantillaPorId(plantillas, celda.plantilla_id);
  if (!p || !esActiva(p)) {
    return conPrincipal("regla_inactiva", `${celdaTxt}: la regla apunta a ${p ? `${nombre(p)}, que está desactivada` : `«${celda.plantilla_id}», que ya no existe`}.`);
  }
  if (esIA && !sirveParaIA(p)) {
    return conPrincipal("regla_no_sirve_ia", `${celdaTxt}: la regla apunta a ${nombre(p)}, que la IA no puede dibujar (solo el diseño corporativo y en castellano).`);
  }
  return { plantilla: p, codigo: "regla", detalle: `${celdaTxt}: por la regla, plantilla ${nombre(p)}.` };
}

/** La plantilla del traslado de la IA, con la celda que la eligió y el idioma de sus condiciones. */
export type UsoPlantillaTraslado = UsoPlantilla & {
  /** La celda idioma × moneda de la regla nueva; null = la regla vieja por segmento (sin cotizaciones-09). */
  celda: CeldaTraslado | null;
  /** El idioma de las condiciones que se copian: el de la plantilla elegida; null sin plantilla (las de Ajustes). */
  idiomaCondiciones: Idioma | null;
};

/**
 * La plantilla del PDF del traslado de la IA para la celda idioma × moneda `c`.
 *  · SIN la tabla nueva (`reglasTraslado === null`): EXACTAMENTE `plantillaParaUso({servicio:
 *    "traslado_ia", segmento}, …)` con las reglas viejas (`legado`), byte a byte lo de hoy.
 *  · Con ella: la celda si su plantilla sirve en ESE idioma (`regla`); si no (vacía, inactiva o que
 *    la IA no dibuja en ese idioma):
 *     - en castellano, la principal si sirve en castellano; y si tampoco, `sin_plantilla` y null
 *       (quien llama usa las condiciones de Ajustes de traslados, como hoy);
 *     - en inglés, NUNCA la principal (aunque sea una corporativa en inglés): lo que daría la celda
 *       castellano de la MISMA moneda, con `sin_plantilla_idioma` y sus condiciones en castellano, y
 *       la cotización queda en revisión (`condiciones_en_otro_idioma`). Así solo una celda inglés
 *       ASIGNADA por una persona alimenta un envío automático en inglés, que es lo mismo que dice
 *       `inglesDisponible` (la principal no enciende el inglés) y lo que dice Ajustes.
 * Nunca devuelve una plantilla inactiva (`sirveParaIA` lo exige).
 */
export function plantillaTrasladoIA(
  c: CeldaTraslado,
  plantillas: readonly PlantillaFila[],
  reglasTraslado: readonly ReglaTraslado[] | null,
  legado: { reglas: readonly ReglaPlantilla[] | null; segmento: Segmento },
): UsoPlantillaTraslado {
  const idiomaDe = (p: PlantillaFila | null): Idioma | null => (p ? normalizarIdioma(p.idioma) : null);
  if (reglasTraslado === null) {
    const u = plantillaParaUso({ servicio: "traslado_ia", segmento: legado.segmento }, plantillas, legado.reglas);
    return { ...u, celda: null, idiomaCondiciones: idiomaDe(u.plantilla) };
  }
  const idioma: Idioma = c?.idioma === "en" ? "en" : "es";
  const moneda: Moneda = c?.moneda === "USD" ? "USD" : "PEN";
  const celda: CeldaTraslado = { idioma, moneda };
  const celdaTxt = etiquetaCeldaTraslado(celda);
  const nombre = (p: PlantillaFila) => `«${p.nombre || p.id}»`;
  const queDibuja = idioma === "en" ? "solo el diseño corporativo y en inglés" : "solo el diseño corporativo y en castellano";
  const principal = plantillaPrincipal(plantillas);

  const r = (reglasTraslado ?? []).find(x => x.idioma === idioma && x.moneda === moneda);
  const p = r ? plantillaPorId(plantillas, r.plantilla_id) : null;
  if (r && p && sirveParaIA(p, idioma)) {
    return { plantilla: p, codigo: "regla", detalle: `${celdaTxt}: por la regla, plantilla ${nombre(p)}.`, celda, idiomaCondiciones: idioma };
  }
  // Por qué no se obedece la celda (o que no tiene), y su código si se usa la principal.
  const [codigoCelda, porque]: [CodigoUso, string] = !r
    ? ["principal", `${celdaTxt}: sin regla.`]
    : !p || !esActiva(p)
      ? ["regla_inactiva", `${celdaTxt}: la regla apunta a ${p ? `${nombre(p)}, que está desactivada` : `«${r.plantilla_id}», que ya no existe`}.`]
      : ["regla_no_sirve_ia", `${celdaTxt}: la regla apunta a ${nombre(p)}, que la IA no puede usar aquí (${queDibuja}).`];
  // En inglés la principal no cuenta (ver arriba): solo en castellano se cae a ella.
  if (idioma === "es" && sirveParaIA(principal, idioma)) {
    return {
      plantilla: principal, codigo: codigoCelda, detalle: `${porque} Se usa la plantilla principal ${nombre(principal as PlantillaFila)}.`,
      celda, idiomaCondiciones: idioma,
    };
  }
  if (idioma === "es") {
    const falta = !principal
      ? "No hay una plantilla principal activa."
      : `La plantilla principal ${nombre(principal)} no la puede usar la IA (${queDibuja}).`;
    return {
      plantilla: null, codigo: "sin_plantilla", detalle: `${porque} ${falta} La IA usa las condiciones de Ajustes de traslados.`,
      celda, idiomaCondiciones: null,
    };
  }
  // En inglés sin una plantilla inglesa ASIGNADA que sirva (la principal no cuenta): la de castellano
  // de la misma moneda, y se dice.
  const es = plantillaTrasladoIA({ idioma: "es", moneda }, plantillas, reglasTraslado, legado);
  const conQue = es.plantilla
    ? `Se usa la de ${etiquetaCeldaTraslado({ idioma: "es", moneda })}, ${nombre(es.plantilla)}, con sus condiciones en castellano`
    : "Se usan las condiciones de Ajustes de traslados, en castellano";
  // La razón va ANTES de la frase « No hay una plantilla en inglés que la IA pueda usar.»: la pantalla
  // de /tarifario separa por ella (`MARCA_SIN_PLANTILLA_INGLES`), así que la frase no cambia.
  const razon = !r ? `${celdaTxt}: sin regla (en inglés no se usa la plantilla principal).` : porque;
  return {
    plantilla: es.plantilla, codigo: "sin_plantilla_idioma",
    detalle: `${razon} No hay una plantilla en inglés que la IA pueda usar. ${conQue}: la cotización queda en revisión. Se arregla asignando una plantilla en inglés a ${celdaTxt} en /cotizaciones/plantillas.`,
    celda, idiomaCondiciones: "es",
  };
}

/** En qué monedas puede cotizar la IA en inglés: la celda «inglés» tiene una plantilla en inglés que sirve. */
export type InglesTraslado = { PEN: boolean; USD: boolean };

/**
 * ¿Está encendido el inglés, y en qué monedas? null = falta la tabla nueva (todo en castellano, como
 * hoy). Solo cuenta una celda «inglés» ASIGNADA por una persona con una plantilla en inglés que la
 * IA pueda usar: la principal no lo enciende (una plantilla principal en inglés no es la decisión de
 * cotizar en inglés).
 */
export function inglesDisponible(plantillas: readonly PlantillaFila[], reglasTraslado: readonly ReglaTraslado[] | null): InglesTraslado | null {
  if (reglasTraslado === null) return null;
  const sirve = (moneda: Moneda): boolean => {
    const r = (reglasTraslado ?? []).find(x => x.idioma === "en" && x.moneda === moneda);
    return !!r && sirveParaIA(plantillaPorId(plantillas, r.plantilla_id), "en");
  };
  return { PEN: sirve("PEN"), USD: sirve("USD") };
}

/** El inglés está encendido en alguna moneda. Sin la tabla nueva o sin celda útil, apagado. */
export const inglesActivo = (i: InglesTraslado | null | undefined): boolean => !!i && (i.PEN === true || i.USD === true);

// ── Las condiciones de la fila ───────────────────────────────────────────────

const copia = (x: unknown): string[] => (Array.isArray(x) ? [...(x as string[])] : []);

/**
 * La política de reserva de una plantilla (y si no, la del respaldo), o null si ninguna la tiene. A
 * diferencia de las otras tres, «no tiene» deja la clave FUERA de la fila: sin política, la fila es
 * byte a byte la de antes y el PDF no imprime el bloque.
 */
const reservaDe = (x: unknown, r: unknown): string[] | null => (Array.isArray(x) ? [...(x as string[])] : Array.isArray(r) ? [...(r as string[])] : null);

/** ¿La lista tiene alguna línea que se imprima? */
const conLineas = (l: readonly unknown[] | null | undefined): boolean => Array.isArray(l) && l.some(x => String(x ?? "").trim() !== "");

/**
 * El RESUMEN de la política (cotizaciones-08) que va con ella: de la MISMA fuente que la política
 * (`deLaFuente`, la plantilla o el respaldo) y solo si la política tiene líneas. null = sin la clave.
 */
const resumenDe = (reserva: string[] | null, deLaFuente: unknown): string[] | null =>
  conLineas(reserva) && Array.isArray(deLaFuente) ? [...(deLaFuente as string[])] : null;

/**
 * Las condiciones que se COPIAN a la fila al crear o guardar una cotización con la plantilla `p`
 * (versión 2). Una lista NULL de la plantilla («sin condiciones propias») toma la de `respaldo`;
 * una lista vacía de la plantilla es una lista vacía (la misma regla que imprimía `considParaPdf`).
 * La política de reserva (`reserva`) solo va si la plantilla o el respaldo la tienen.
 */
export function considSnapshot(p: PlantillaFila | null, respaldo: ConsidCot): ConsidFila {
  const de = (x: string[] | null | undefined, r: unknown): string[] => (Array.isArray(x) ? [...x] : copia(r));
  const reserva = reservaDe(p?.condiciones_reserva, respaldo?.reserva);
  // El resumen sale de donde salió la política: la plantilla si la tiene, si no el respaldo.
  const resumen = resumenDe(reserva, Array.isArray(p?.condiciones_reserva) ? p?.condiciones_reserva_resumen : respaldo?.reserva_resumen);
  return {
    incluye: de(p?.condiciones_incluye, respaldo?.incluye),
    no_incluye: de(p?.condiciones_no_incluye, respaldo?.no_incluye),
    generales: de(p?.condiciones_generales, respaldo?.generales),
    ...(reserva ? { reserva } : {}),
    ...(resumen ? { reserva_resumen: resumen } : {}),
    version: CONSID_VERSION,
    plantilla: p?.id ?? null,
  };
}

/**
 * Lo que el formulario carga al abrir una cotización: EXACTAMENTE lo que su PDF imprime hoy, para
 * que guardarla (ya en versión 2) no le cambie el PDF.
 *  · fila fijada (versión 2) → la fila;
 *  · fila de antes en español → `cfg?.x || fila.x` (la plantilla ganaba al imprimir);
 *  · fila de antes en inglés → la fila tal cual (en inglés la plantilla nunca se imprimió);
 *  · sin fila → como una fila con las de fábrica (lo que imprimía el PDF).
 * `cfg` es la plantilla con la que se imprime hoy (`plantilla_pdf`, o la corporativa).
 */
export function considParaFormulario(cfg: PlantillaPdfCfg | null, fila: ConsidFila | null, idioma: Idioma): ConsidFila {
  // La política de reserva sigue la misma regla, y sin ninguna no se agrega la clave. Su resumen va
  // con ella y SOLO de la fila (`considParaPdf` nunca imprime el de la plantilla): si gana la
  // política de la plantilla, sin resumen.
  const conReserva = (r: string[] | null, resumenFila: unknown) => {
    const resumen = resumenDe(r, resumenFila);
    return { ...(r ? { reserva: r } : {}), ...(resumen ? { reserva_resumen: resumen } : {}) };
  };
  if (fila && esConsidFijada(fila)) {
    return {
      incluye: copia(fila.incluye), no_incluye: copia(fila.no_incluye), generales: copia(fila.generales),
      ...conReserva(reservaDe(fila.reserva, null), fila.reserva_resumen),
      version: CONSID_VERSION, plantilla: typeof fila.plantilla === "string" ? fila.plantilla : null,
    };
  }
  const base: ConsidCot = fila ?? DEFAULT_CONSID_ES;
  if (normalizarIdioma(idioma) === "es") {
    const ganaPlantilla = !!cfg?.condiciones_reserva;
    return {
      incluye: copia(cfg?.condiciones_incluye || base.incluye),
      no_incluye: copia(cfg?.condiciones_no_incluye || base.no_incluye),
      generales: copia(cfg?.condiciones_generales || base.generales),
      ...conReserva(reservaDe(cfg?.condiciones_reserva, base.reserva), ganaPlantilla ? null : base.reserva_resumen),
    };
  }
  return { incluye: copia(base.incluye), no_incluye: copia(base.no_incluye), generales: copia(base.generales), ...conReserva(reservaDe(base.reserva, null), base.reserva_resumen) };
}

/**
 * El aviso del modal de impresión cuando la cotización tiene sus condiciones fijadas desde OTRA
 * plantilla: el PDF imprime las de la fila, no las de la elegida, y callarlo haría creer lo contrario.
 */
export function avisoCondicionesDeOtraPlantilla(
  consid: ConsidFila | null | undefined,
  elegida: { id: string; nombre: string },
  nombreDe: (id: string) => string | null,
): AvisoPdf | null {
  if (!consid || !esConsidFijada(consid)) return null;
  const de = typeof consid.plantilla === "string" ? consid.plantilla.trim() : "";
  if (!de || de === elegida.id) return null;
  const nDe = nombreDe(de) || de;
  const nEl = elegida.nombre || elegida.id;
  return {
    codigo: "condiciones_de_otra_plantilla",
    bloquea: false,
    detalle: `Las condiciones de esta cotización se copiaron de la plantilla «${nDe}» al guardarla, y son las que imprime el PDF también con «${nEl}». Para usar las de «${nEl}», cárgalas en Consideraciones y guarda la cotización.`,
  };
}

// ── Topes de las listas de condiciones ───────────────────────────────────────
// Lo que la IA manda sin revisión lo dibuja el servidor con pdf-lib, y una lista que no cabe en una
// hoja se pierde; una línea desmesurada se recorta. Los dos números NO están medidos: son los de la
// pantalla (el editor no deja agregar la línea 31 ni escribir el carácter 501) y una cotización de
// traslado que los pasa no sale sola (`condiciones_demasiadas`, lib/traslados/envio-ia.ts).

/** Líneas que puede tener una lista de condiciones (Incluye, No incluye, Consideraciones generales, la política de reserva o su resumen). */
export const MAX_LINEAS_CONDICIONES = 30;
/** Caracteres que puede tener una línea de condiciones. */
export const MAX_CARACTERES_CONDICION = 500;

export type ListaConsid = "incluye" | "no_incluye" | "generales" | "reserva" | "reserva_resumen";
/**
 * Las listas de `consideraciones_json`, en el orden en que las imprime el PDF. El resumen va al final:
 * se imprime en lugar de la política (con el enlace), así que cuenta para los topes como las demás.
 */
export const LISTAS_CONSID: readonly ListaConsid[] = ["incluye", "no_incluye", "generales", "reserva", "reserva_resumen"];

/** El nombre de cada lista para las notas y los avisos (una sola definición). */
export const ETIQUETA_LISTA_CONSID: Record<ListaConsid, string> = {
  incluye: "Incluye",
  no_incluye: "No incluye",
  generales: "Consideraciones generales",
  reserva: "Reserva, cambios y cancelación",
  reserva_resumen: "Resumen de la reserva, cambios y cancelación",
};

/** Las líneas de una lista como las imprime el PDF: texto, sin espacios de más, sin las vacías. */
export function lineasDeLista(l: unknown): string[] {
  return Array.isArray(l) ? l.map(s => String(s ?? "").trim()).filter(Boolean) : [];
}

export type ExcesoCondiciones = { lista: ListaConsid; motivo: "demasiadas_lineas" | "linea_larga"; n: number };

/**
 * Qué listas de condiciones de una cotización (`consideraciones_json`: incluye, no incluye,
 * generales, la política de reserva y su resumen) pasan de los topes, con cuántas líneas tienen o cuántos caracteres la línea más larga.
 * Vacío = caben. Se cuenta como imprime el PDF (sin las líneas vacías) y por caracteres completos.
 */
export function excesoCondiciones(c: unknown): ExcesoCondiciones[] {
  const o = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
  const out: ExcesoCondiciones[] = [];
  for (const lista of LISTAS_CONSID) {
    const ls = lineasDeLista(o[lista]);
    if (ls.length > MAX_LINEAS_CONDICIONES) out.push({ lista, motivo: "demasiadas_lineas", n: ls.length });
    const larga = ls.reduce((m, s) => Math.max(m, Array.from(s).length), 0);
    if (larga > MAX_CARACTERES_CONDICION) out.push({ lista, motivo: "linea_larga", n: larga });
  }
  return out;
}

// ── El editor honesto ────────────────────────────────────────────────────────

/**
 * Los campos de la plantilla que se pueden ofrecer en el editor. `cuentas` son las cuentas bancarias
 * (`mostrar_cuentas_bancarias`, `usar_bancos_propios` y `banco_N_*`). `idioma` no lo lee el diseño:
 * lo lee el formulario de la cotización (una plantilla en inglés preselecciona el PDF en inglés).
 */
export type CampoPlantilla =
  | "titulo_documento" | "mensaje_cierre"
  | "color_primario" | "color_secundario" | "color_acento"
  | "condiciones_incluye" | "condiciones_no_incluye" | "condiciones_generales" | "condiciones_reserva"
  | "condiciones_reserva_resumen" | "cuentas" | "idioma";

export const CAMPOS_PLANTILLA: readonly CampoPlantilla[] = [
  "titulo_documento", "mensaje_cierre", "color_primario", "color_secundario", "color_acento",
  "condiciones_incluye", "condiciones_no_incluye", "condiciones_generales", "condiciones_reserva", "condiciones_reserva_resumen", "cuentas", "idioma",
];

export const ETIQUETA_CAMPO: Record<CampoPlantilla, string> = {
  titulo_documento: "Título del documento",
  mensaje_cierre: "Mensaje de cierre",
  color_primario: "Color primario",
  color_secundario: "Color secundario",
  color_acento: "Color de acento",
  condiciones_incluye: "Incluye",
  condiciones_no_incluye: "No incluye",
  condiciones_generales: "Consideraciones generales",
  condiciones_reserva: "Reserva, cambios y cancelación",
  condiciones_reserva_resumen: "Resumen de la reserva (con enlace a las condiciones completas)",
  cuentas: "Cuentas bancarias",
  idioma: "Idioma",
};

/**
 * QUÉ LEE CADA DISEÑO, medido contra `htmlCotizacion` (lib/cotizacion-pdf.ts) con valores centinela
 * en scripts/prueba-cotizacion-plantillas.mts. Lo que NO lee ninguno —`fuente`, `subtitulo`,
 * `mostrar_logo`, `mostrar_fotos_vehiculo`, `mostrar_itinerario`, `mostrar_precio_pax`,
 * `mostrar_sla`, la firma— no se ofrece. Detalles que la tabla no dice:
 *  · el corporativo tiene color fijo (`COLOR_CORPORATIVO`) y su título sale del diccionario; es el
 *    único que imprime la política de reserva (`condiciones_reserva`) y su resumen
 *    (`condiciones_reserva_resumen`: se copia a la fila con la política y se imprime, en su lugar, solo
 *    con el enlace a las condiciones completas — la matriz lo mide con un token y una base);
 *  · en el moderno, el color secundario solo se ve en el anexo del itinerario;
 *  · en inglés, título, cierre y condiciones de la plantilla no se imprimen en ningún diseño.
 */
export const CAMPOS_POR_DISENO: Record<Diseno, readonly CampoPlantilla[]> = {
  corporativo: ["condiciones_incluye", "condiciones_no_incluye", "condiciones_generales", "condiciones_reserva", "condiciones_reserva_resumen", "cuentas", "idioma"],
  moderno_fotos: ["color_primario", "color_secundario", "titulo_documento", "mensaje_cierre", "condiciones_incluye", "condiciones_no_incluye", "idioma"],
  turistico: ["color_primario", "color_secundario", "titulo_documento", "mensaje_cierre", "condiciones_incluye", "condiciones_no_incluye", "idioma"],
  ejecutivo: ["color_primario", "color_acento", "titulo_documento", "mensaje_cierre", "condiciones_incluye", "condiciones_no_incluye", "idioma"],
};

export function leeCampo(diseno: Diseno, campo: CampoPlantilla): boolean {
  return CAMPOS_POR_DISENO[diseno].includes(campo);
}

// ── Plantillas nuevas ────────────────────────────────────────────────────────

/** El formato del id: va en la URL (`?editar=`) y en la base. */
export const RE_ID_PLANTILLA = /^[a-z0-9_]{3,40}$/;

/** Ids que una plantilla nueva no puede tomar: los nombres de diseño y los de la migración. */
export const IDS_RESERVADOS: readonly string[] = [...DISENOS, ID_PLANTILLA_TRASLADOS, ID_PLANTILLA_TRASLADOS_USD];

export function esIdPlantillaValido(id: unknown): boolean {
  return typeof id === "string" && RE_ID_PLANTILLA.test(id);
}

const slug = (s: string): string =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/**
 * El id de una plantilla nueva (al duplicar), sacado de su nombre: `^[a-z0-9_]{3,40}$`, que no
 * choque con las que existen ni con un nombre de diseño o de la migración. Si choca, se le agrega
 * un sufijo del `azar` que pasa quien llama (y, si aun así choca, un número).
 */
export function idNuevaPlantilla(nombre: string, existentes: readonly string[], azar: string): string {
  const tomado = new Set<string>([...(existentes ?? []).map(x => String(x ?? "").trim().toLowerCase()), ...IDS_RESERVADOS]);
  const libre = (id: string) => RE_ID_PLANTILLA.test(id) && !tomado.has(id);
  let base = slug(nombre).slice(0, 40).replace(/_+$/, "");
  if (base.length < 3) base = "plantilla";
  if (libre(base)) return base;
  const conSufijo = (suf: string) => `${base.slice(0, 40 - suf.length - 1).replace(/_+$/, "")}_${suf}`;
  const az = String(azar ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  if (az) { const c = conSufijo(az); if (libre(c)) return c; }
  for (let n = 2; ; n++) { const c = conSufijo(String(n)); if (libre(c)) return c; }
}

// ── La vista previa ──────────────────────────────────────────────────────────

const isoMasDias = (d: Date, n: number): string => {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
  return x.toISOString().slice(0, 10);
};

/**
 * Una cotización DE MENTIRA para la vista previa de una plantilla: ningún dato real (ni de la
 * empresa ni de un cliente). Sin `consid`, así la vista previa imprime las condiciones de la
 * plantilla (o las de fábrica si no tiene). Quien llama agrega `plantilla: disenoDe(p)`, `cfg` y
 * `empresa` (el perfil: así el PDF de ejemplo sale con el nombre y las cuentas de quien lo mira).
 */
export function ejemploParaVistaPrevia(ahora: Date = new Date()): Omit<EntradaPdfCot, "cfg" | "empresa" | "plantilla"> {
  return {
    cot: {
      id: 0,
      numero_cotizacion: "EJEMPLO",
      origen: "Punto de origen", destino: "Punto de destino", km: 120,
      atencion: "Persona de contacto", asunto: "Cotización de ejemplo", punto_retorno: null,
      fecha_servicio: isoMasDias(ahora, 7), fecha_retorno: null,
      hora_ida: "08:00", hora_retorno: "18:00",
      tipo_servicio: "ida_retorno", incluye_igv: true,
      itinerario_texto: "Día 1\n08:00 – Salida desde el punto de origen\n12:00 – Llegada al punto de destino\n18:00 – Retorno",
      created_at: ahora.toISOString(),
      paradas_json: [{ nombre: "Punto de origen", tipo: "inicio", hora: "08:00" }, { nombre: "Punto de destino", tipo: "destino", hora: "12:00" }],
      fechas_multidia_json: null,
      modo_servicio: "eventual",
      tipo_vehiculo: null,
      moneda: "PEN", tipo_cambio: null, idioma_pdf: "es",
    },
    cliente: { nombre: "Nombre del contacto", empresa: "Cliente de ejemplo", tipo: "b2b", ruc: "00000000000", direccion: "Dirección del cliente", telefono: "000 000 000" },
    items: [
      { descripcion: "SERVICIO DE TRANSPORTE - UNIDAD DE EJEMPLO", dias: 1, cantidad: 1, precio_unit: 1000, descuento_pct: 0 },
      { descripcion: "Horas adicionales (ejemplo)", dias: 1, cantidad: 2, precio_unit: 80, descuento_pct: 0 },
    ],
    vehiculos: [{ categoria: "BUS", capacidad_pasajeros: 20, equipamiento: "full_equipo", foto_externa_url: null, foto_interna_url: null, descripcion_unidad: null }],
    repr: "Nombre del representante",
    ahora,
  };
}
