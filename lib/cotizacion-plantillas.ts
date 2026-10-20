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
//    (lib/pdf-corporativo.ts, pdf-lib) y en castellano (`sirveParaIA`). Una celda `traslado_ia`
//    que apunta a otra cosa no se obedece: se usa la principal si sirve, y si no, nada — y quien
//    llama vuelve a las condiciones de `traslados_config`. Nunca se devuelve una plantilla inactiva.
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
// ──────────────────────────────────────────────────────────────────────────────

import { CONSID_VERSION, DEFAULT_CONSID_ES, esConsidFijada, normalizarIdioma, type ConsidCot, type ConsidFila, type Idioma } from "./cotizacion-idioma";
import { normalizarMoneda } from "./cotizacion-moneda";
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
  return `${ETIQUETA_SERVICIO[u.servicio]} · ${ETIQUETA_SEGMENTO[u.segmento].toLowerCase()}`;
}

/** El SQL que crea `diseno` y la tabla de reglas. Sin él, la pantalla lo nombra en ámbar. */
export const SQL_PLANTILLAS_USO = "supabase/cotizaciones-05-plantillas-uso.sql";

export const TABLA_PLANTILLAS = "cotizacion_plantillas";
export const TABLA_REGLAS = "cotizacion_plantilla_reglas";

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
 * ¿La IA puede mandar su PDF con esta plantilla? Solo si está activa, dibuja el diseño corporativo
 * (lo único que sabe dibujar el servidor) y no está en inglés (los textos del sistema del traslado
 * no tienen versión inglesa).
 */
export function sirveParaIA(p: PlantillaFila | null | undefined): boolean {
  return !!p && esActiva(p) && disenoDe(p) === "corporativo" && normalizarIdioma(p.idioma) !== "en";
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
 * - `regla`: la celda tiene una plantilla que se puede usar.
 * - `principal`: la celda está vacía → la principal.
 * - `regla_inactiva`: la celda apunta a una plantilla desactivada o que ya no existe → la principal.
 * - `regla_no_sirve_ia`: celda `traslado_ia` con una plantilla que la IA no dibuja → la principal.
 * - `sin_reglas`: falta la tabla de reglas (el SQL). En `traslado_ia` devuelve null (quien llama usa
 *   `traslados_config`, como antes); en los demás, la principal.
 * - `sin_plantilla`: no hay una principal que sirva → null.
 */
export type CodigoUso = "regla" | "principal" | "regla_inactiva" | "regla_no_sirve_ia" | "sin_reglas" | "sin_plantilla";

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

// ── Las condiciones de la fila ───────────────────────────────────────────────

const copia = (x: unknown): string[] => (Array.isArray(x) ? [...(x as string[])] : []);

/**
 * Las condiciones que se COPIAN a la fila al crear o guardar una cotización con la plantilla `p`
 * (versión 2). Una lista NULL de la plantilla («sin condiciones propias») toma la de `respaldo`;
 * una lista vacía de la plantilla es una lista vacía (la misma regla que imprimía `considParaPdf`).
 */
export function considSnapshot(p: PlantillaFila | null, respaldo: ConsidCot): ConsidFila {
  const de = (x: string[] | null | undefined, r: unknown): string[] => (Array.isArray(x) ? [...x] : copia(r));
  return {
    incluye: de(p?.condiciones_incluye, respaldo?.incluye),
    no_incluye: de(p?.condiciones_no_incluye, respaldo?.no_incluye),
    generales: de(p?.condiciones_generales, respaldo?.generales),
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
  if (fila && esConsidFijada(fila)) {
    return {
      incluye: copia(fila.incluye), no_incluye: copia(fila.no_incluye), generales: copia(fila.generales),
      version: CONSID_VERSION, plantilla: typeof fila.plantilla === "string" ? fila.plantilla : null,
    };
  }
  const base: ConsidCot = fila ?? DEFAULT_CONSID_ES;
  if (normalizarIdioma(idioma) === "es") {
    return {
      incluye: copia(cfg?.condiciones_incluye || base.incluye),
      no_incluye: copia(cfg?.condiciones_no_incluye || base.no_incluye),
      generales: copia(cfg?.condiciones_generales || base.generales),
    };
  }
  return { incluye: copia(base.incluye), no_incluye: copia(base.no_incluye), generales: copia(base.generales) };
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

// ── El editor honesto ────────────────────────────────────────────────────────

/**
 * Los campos de la plantilla que se pueden ofrecer en el editor. `cuentas` son las cuentas bancarias
 * (`mostrar_cuentas_bancarias`, `usar_bancos_propios` y `banco_N_*`). `idioma` no lo lee el diseño:
 * lo lee el formulario de la cotización (una plantilla en inglés preselecciona el PDF en inglés).
 */
export type CampoPlantilla =
  | "titulo_documento" | "mensaje_cierre"
  | "color_primario" | "color_secundario" | "color_acento"
  | "condiciones_incluye" | "condiciones_no_incluye" | "condiciones_generales"
  | "cuentas" | "idioma";

export const CAMPOS_PLANTILLA: readonly CampoPlantilla[] = [
  "titulo_documento", "mensaje_cierre", "color_primario", "color_secundario", "color_acento",
  "condiciones_incluye", "condiciones_no_incluye", "condiciones_generales", "cuentas", "idioma",
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
  cuentas: "Cuentas bancarias",
  idioma: "Idioma",
};

/**
 * QUÉ LEE CADA DISEÑO, medido contra `htmlCotizacion` (lib/cotizacion-pdf.ts) con valores centinela
 * en scripts/prueba-cotizacion-plantillas.mts. Lo que NO lee ninguno —`fuente`, `subtitulo`,
 * `mostrar_logo`, `mostrar_fotos_vehiculo`, `mostrar_itinerario`, `mostrar_precio_pax`,
 * `mostrar_sla`, la firma— no se ofrece. Detalles que la tabla no dice:
 *  · el corporativo tiene color fijo (`COLOR_CORPORATIVO`) y su título sale del diccionario;
 *  · en el moderno, el color secundario solo se ve en el anexo del itinerario;
 *  · en inglés, título, cierre y condiciones de la plantilla no se imprimen en ningún diseño.
 */
export const CAMPOS_POR_DISENO: Record<Diseno, readonly CampoPlantilla[]> = {
  corporativo: ["condiciones_incluye", "condiciones_no_incluye", "condiciones_generales", "cuentas", "idioma"],
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
