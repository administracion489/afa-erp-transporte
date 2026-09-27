// ──────────────────────────────────────────────────────────────────────────────
// lib/liquidacion-etiquetas.ts — Las ETIQUETAS que deciden el ítem de la liquidación:
// RUTA, TURNO y MÓVIL. Módulo PURO (sin Supabase, sin React).
//
// EL PROBLEMA, CON LAS PALABRAS DEL DUEÑO
//
// El ítem del AFA-FL-07 salía de redactar el nombre de la ruta, y ese nombre lleva la
// HORA dentro ("RUTA A/ ENTRADA 04:35/ SANTA ANITA→BSF"). Cuando el cliente corre el
// horario —la RUTA A turno 1 sale a las 04:35 una semana y a las 05:00 la siguiente—
// el mismo servicio contratado quedaba partido en dos ítems. Lo que el dueño pidió:
//
//     TRANSPORTE DE PERSONAL / 50 PAX / DEL 01-09-2026 AL 30-09-2026 / RUTA A / TURNO 1
//
// y abrir OTRO ítem solo cuando cambia la RUTA, el TURNO, el MÓVIL (dos buses a la vez
// en la misma ruta y turno: MÓVIL 1 DE 2), los PAX contratados o la tarifa.
//
// LA REGLA QUE SOSTIENE TODO EL MÓDULO: LAS ETIQUETAS SE ESCRIBEN, NO SE DEDUCEN.
//
// La versión anterior al formato actual ya imprimía "RUTA B / TURNO DÍA / MÓVIL 1" y de
// esas piezas ninguna existía como dato: el turno salía de la hora, el móvil era un
// índice calculado. Se retiró por eso (ver liquidaciones-03). Esto NO es volver a eso:
// aquí RUTA, TURNO y MÓVIL son columnas de `reservas` que escribe una persona. El ERP
// puede PROPONERLAS por horario (lib/liquidacion-etiquetas-propuesta.ts), pero la
// propuesta solo llena un formulario: nada se guarda sin que alguien lo confirme.
//
// LOS PAX NO SON UNA ETIQUETA NUEVA. Ya existen como `capacidad_contratada` y la
// liquidación los resuelve con su cascada de siempre (lib/liquidacion-rutas.ts). Aquí
// solo se enseñan al lado, para que el rótulo se lea como el ítem entero.
//
// SIN ETIQUETAS, NADA CAMBIA. Un servicio sin RUTA y TURNO se agrupa exactamente como
// antes (por el nombre sin la hora y por los extremos en el mapa). Correr la migración
// no mueve un solo ítem de ningún documento.
//
// Matriz: npx tsx scripts/prueba-etiquetas.mts
// ──────────────────────────────────────────────────────────────────────────────

/** Las tres etiquetas de un servicio. RUTA y TURNO obligatorias; MÓVIL solo con 2+ buses a la vez. */
export type EtiquetasItem = {
  /** "RUTA A", "RUTA 12", "RUTA NORTE". Siempre normalizada (ver `normalizarRutaEtiqueta`). */
  ruta: string;
  /** 1 = la salida más temprana de la ruta. */
  turno: number;
  /** null = único móvil. Para agrupar, null y 1 son lo mismo (ver `claveEtiquetas`). */
  movil: number | null;
};

/** Lo mínimo que hay que traer de una reserva para leer sus etiquetas. */
export type TramoConEtiquetas = {
  ruta_etiqueta?: string | null;
  turno?: number | string | null;
  movil?: number | string | null;
};

/** Las columnas de `reservas` y el archivo que las crea: los avisos lo nombran. */
export const COLUMNAS_ETIQUETAS = ["ruta_etiqueta", "turno", "movil"] as const;
export const SQL_ETIQUETAS = "supabase/liquidaciones-04-etiquetas-item.sql";

/** Topes: los mismos CHECK de la migración. Validar aquí evita el error crudo de Postgres. */
export const MAX_LARGO_RUTA = 40;
export const MAX_TURNO = 99;
export const MAX_MOVIL = 99;

// ─── Normalización ───────────────────────────────────────────────────────────

/**
 * "a" · "Ruta a" · "RUTA-A" · "ruta: a" → "RUTA A". Un texto más largo se respeta
 * ("RUTA NORTE", "EXPRESO SUR"), solo en mayúsculas y con los espacios colapsados.
 *
 * El prefijo "RUTA" se AGREGA solo cuando lo escrito es un identificador corto (1 a 3
 * letras o números), que es como se nombran las rutas de AFA y como el cliente las
 * reconoce. Es una convención de escritura, no una deducción: el operador tecleó "A" y
 * el ítem va a decir "RUTA A".
 *
 * Idempotente: normalizar lo ya normalizado devuelve lo mismo, y por eso se puede
 * aplicar al escribir Y al leer sin que la clave de agrupación cambie entre los dos.
 */
export function normalizarRutaEtiqueta(v: unknown): string | null {
  const s = String(v ?? "").replace(/\s+/g, " ").trim().toUpperCase();
  if (!s) return null;
  const corto = /^(?:RUTA[\s:.\-–—_/#]*)?([A-Z0-9]{1,3})$/.exec(s);
  if (corto) return `RUTA ${corto[1]}`;
  return s;
}

/**
 * Turno o móvil como número entero de 1 a `max`. Acepta "1", " 01 ", "T1", "TURNO 2",
 * "M2", "MÓVIL 3" — lo que alguien teclea cuando ya tiene la palabra en la cabeza.
 * Cualquier otra cosa (0, 1.5, "primero") devuelve null: un turno a medias no existe.
 */
export function normalizarNumeroEtiqueta(v: unknown, max = MAX_TURNO): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isInteger(v) && v >= 1 && v <= max ? v : null;
  const s = String(v).trim().toUpperCase().replace(/^(TURNO|MÓVIL|MOVIL|T|M)[\s:.\-#]*/, "");
  if (!/^\d{1,2}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= max ? n : null;
}

// ─── Lectura ─────────────────────────────────────────────────────────────────

/** Las etiquetas de UN tramo, solo si están COMPLETAS (RUTA y TURNO). Si no, null. */
export function etiquetasDeTramo(r: TramoConEtiquetas | null | undefined): EtiquetasItem | null {
  if (!r) return null;
  const ruta = normalizarRutaEtiqueta(r.ruta_etiqueta);
  const turno = normalizarNumeroEtiqueta(r.turno, MAX_TURNO);
  if (!ruta || !turno) return null;
  return { ruta, turno, movil: normalizarNumeroEtiqueta(r.movil, MAX_MOVIL) };
}

/** ¿El tramo tiene ALGUNA etiqueta escrita, aunque esté incompleta? */
export function tieneAlgunaEtiqueta(r: TramoConEtiquetas | null | undefined): boolean {
  if (!r) return false;
  return !!normalizarRutaEtiqueta(r.ruta_etiqueta)
    || normalizarNumeroEtiqueta(r.turno, MAX_TURNO) != null
    || normalizarNumeroEtiqueta(r.movil, MAX_MOVIL) != null;
}

/** El móvil con el que se AGRUPA: sin móvil escrito es el único, o sea el 1. */
export const movilEfectivo = (e: EtiquetasItem): number => e.movil ?? 1;

/** ¿Van al mismo ítem? Móvil vacío y móvil 1 son el mismo puesto. */
export function mismasEtiquetas(a: EtiquetasItem | null | undefined, b: EtiquetasItem | null | undefined): boolean {
  if (!a || !b) return false;
  return a.ruta === b.ruta && a.turno === b.turno && movilEfectivo(a) === movilEfectivo(b);
}

export type EtiquetasDelDia = {
  /** Las que valen para el día. null = el día no está etiquetado (se agrupa como antes). */
  etiquetas: EtiquetasItem | null;
  /**
   * Los dos tramos traen etiquetas COMPLETAS y DISTINTAS. Gana el primero (la ida), y se
   * AVISA: la ida y el retorno son el mismo servicio y no pueden estar en dos ítems. Es la
   * misma regla que el PAX (`paxDeLosTramos`): la ida por delante, y el conflicto no se
   * traga en silencio.
   */
  conflicto: { gana: EtiquetasItem; pierde: EtiquetasItem } | null;
  /** Tramos del día que NO llevan etiquetas completas (se completan al guardar el día). */
  tramosSinEtiqueta: number;
  /** Algún tramo tiene RUTA sin TURNO o al revés: escrito a medias. */
  aMedias: boolean;
};

/**
 * Las etiquetas del DÍA, leídas de sus tramos EN ORDEN DE PRIORIDAD (la ida primero).
 *
 * El día es la unidad que se cobra (ida + retorno = una tarifa), así que las etiquetas
 * son del día como los PAX: se escriben en los dos tramos, y basta con que uno las
 * lleve para que el día entero caiga en su ítem. Un retorno sin etiqueta cuya ida sí la
 * tiene no parte el día en dos.
 */
export function etiquetasDelDia(tramos: (TramoConEtiquetas | null | undefined)[]): EtiquetasDelDia {
  const vistos: TramoConEtiquetas[] = [];
  for (const t of tramos) if (t && !vistos.includes(t)) vistos.push(t);
  const completas = vistos.map(etiquetasDeTramo);
  const etiquetas = completas.find((e): e is EtiquetasItem => !!e) ?? null;
  const distinta = etiquetas ? completas.find((e) => !!e && !mismasEtiquetas(e, etiquetas)) ?? null : null;
  return {
    etiquetas,
    conflicto: etiquetas && distinta ? { gana: etiquetas, pierde: distinta } : null,
    tramosSinEtiqueta: completas.filter((e) => !e).length,
    aMedias: vistos.some((t, i) => !completas[i] && tieneAlgunaEtiqueta(t)),
  };
}

// ─── Identidad del ítem ──────────────────────────────────────────────────────

/** RUTA + TURNO + MÓVIL: lo que separa un ítem de otro por el lado de las etiquetas. */
export const claveEtiquetas = (e: EtiquetasItem): string => `${e.ruta}|T${e.turno}|M${movilEfectivo(e)}`;

/** RUTA + TURNO, sin el móvil: el alcance dentro del cual se cuentan los móviles. */
export const claveRutaTurno = (e: EtiquetasItem): string => `${e.ruta}|T${e.turno}`;

/**
 * Cuántos móviles tiene cada RUTA + TURNO: el mayor número de móvil escrito. Es el "DE N"
 * de "MÓVIL 1 DE 2", y se DERIVA de las etiquetas en vez de guardarse: un N escrito aparte
 * se quedaría viejo el día que se agrega o se retira un bus.
 *
 * Se cuenta sobre el alcance del documento. En la liquidación de un PROVEEDOR que cubre
 * solo el móvil 2, eso da "MÓVIL 2 DE 2" (el 2 ya dice que hay otro); si cubre solo el
 * móvil 1, no se imprime móvil — no hay forma honesta de saber cuántos más hay.
 */
export function totalMoviles(lista: (EtiquetasItem | null | undefined)[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of lista) {
    if (!e) continue;
    const k = claveRutaTurno(e);
    out.set(k, Math.max(out.get(k) ?? 1, movilEfectivo(e)));
  }
  return out;
}

/** Las piezas que imprime el ítem: ["RUTA A", "TURNO 1", "MÓVIL 1 DE 2"]. */
export function segmentosEtiquetas(e: EtiquetasItem, moviles: number): string[] {
  const s = [e.ruta, `TURNO ${e.turno}`];
  if (moviles > 1) s.push(`MÓVIL ${movilEfectivo(e)} DE ${moviles}`);
  return s;
}

/** El chip corto de las listas: "RUTA A · T1 · M2 · 50 PAX". */
export function rotuloEtiquetas(e: EtiquetasItem, pax?: number | null): string {
  return [
    e.ruta,
    `T${e.turno}`,
    e.movil ? `M${e.movil}` : "",
    pax ? `${pax} PAX` : "",
  ].filter(Boolean).join(" · ");
}

/** Orden natural de ítems: RUTA (con los números en orden: 2 antes que 10), TURNO, MÓVIL. */
export function compararEtiquetas(a: EtiquetasItem | null | undefined, b: EtiquetasItem | null | undefined): number {
  if (!a || !b) return 0;
  return a.ruta.localeCompare(b.ruta, "es", { numeric: true })
    || a.turno - b.turno
    || movilEfectivo(a) - movilEfectivo(b);
}

// ─── Escritura ───────────────────────────────────────────────────────────────

export type TextoEtiquetas = { ruta: string; turno: string; movil: string };

export type ValidacionEtiquetas =
  /** `etiquetas` null = las tres vacías: quitar las etiquetas (o no ponerlas). */
  | { ok: true; etiquetas: EtiquetasItem | null }
  | { ok: false; error: string };

/**
 * Lo que alguien tecleó en los tres campos → etiquetas válidas, o el porqué no.
 *
 * RUTA y TURNO van juntos o no van: una RUTA sin TURNO no define ningún ítem, y aceptarla
 * dejaría el servicio "etiquetado a medias", que se agrupa como si no tuviera nada. Mejor
 * decirlo antes de guardar que descubrirlo en el cierre.
 */
export function validarEtiquetas(t: TextoEtiquetas): ValidacionEtiquetas {
  const rutaTxt = String(t.ruta ?? "").trim();
  const turnoTxt = String(t.turno ?? "").trim();
  const movilTxt = String(t.movil ?? "").trim();
  if (!rutaTxt && !turnoTxt && !movilTxt) return { ok: true, etiquetas: null };

  const ruta = normalizarRutaEtiqueta(rutaTxt);
  if (!ruta) return { ok: false, error: "Falta la RUTA (por ejemplo A, B o C)." };
  if (ruta.length > MAX_LARGO_RUTA)
    return { ok: false, error: `La RUTA es demasiado larga (máximo ${MAX_LARGO_RUTA} caracteres).` };
  const turno = normalizarNumeroEtiqueta(turnoTxt, MAX_TURNO);
  if (!turno) return { ok: false, error: "Falta el TURNO: un número del 1 en adelante (1 = la salida más temprana)." };
  let movil: number | null = null;
  if (movilTxt) {
    movil = normalizarNumeroEtiqueta(movilTxt, MAX_MOVIL);
    if (!movil) return { ok: false, error: "El MÓVIL tiene que ser un número del 1 en adelante, o quedar vacío si sale un solo bus." };
  }
  return { ok: true, etiquetas: { ruta, turno, movil } };
}

/** El patch de `reservas` para unas etiquetas (null = quitarlas). */
export function patchEtiquetas(e: EtiquetasItem | null): { ruta_etiqueta: string | null; turno: number | null; movil: number | null } {
  return { ruta_etiqueta: e?.ruta ?? null, turno: e?.turno ?? null, movil: e?.movil ?? null };
}

/**
 * ¿Escribir estas etiquetas cambia algo en el tramo? Compara lo NORMALIZADO y exacto (un
 * móvil vacío y un móvil 1 se agrupan igual, pero se escribe lo que la persona dejó): así
 * guardar dos veces no escribe dos veces, y un contador de "N servicios actualizados" no
 * cuenta los que ya decían eso.
 */
export function cambiaEtiquetas(r: TramoConEtiquetas, e: EtiquetasItem | null): boolean {
  const p = patchEtiquetas(e);
  return normalizarRutaEtiqueta(r.ruta_etiqueta) !== p.ruta_etiqueta
    || normalizarNumeroEtiqueta(r.turno, MAX_TURNO) !== p.turno
    || normalizarNumeroEtiqueta(r.movil, MAX_MOVIL) !== p.movil;
}

/** Las etiquetas como texto para precargar los tres campos de un formulario. */
export function textoDeEtiquetas(e: EtiquetasItem | null | undefined): TextoEtiquetas {
  return { ruta: e?.ruta ?? "", turno: e?.turno ? String(e.turno) : "", movil: e?.movil ? String(e.movil) : "" };
}

/** Lo mismo desde un tramo, aunque esté a medias: el formulario enseña lo que hay escrito. */
export function textoDeTramo(r: TramoConEtiquetas | null | undefined): TextoEtiquetas {
  return {
    ruta: normalizarRutaEtiqueta(r?.ruta_etiqueta) ?? "",
    turno: normalizarNumeroEtiqueta(r?.turno, MAX_TURNO)?.toString() ?? "",
    movil: normalizarNumeroEtiqueta(r?.movil, MAX_MOVIL)?.toString() ?? "",
  };
}

/**
 * ¿El error de Postgres/PostgREST dice que faltan estas columnas? Es la señal de que la
 * migración no se corrió, y la pantalla lo dice nombrando el SQL en vez de enseñar el
 * error crudo.
 */
export const faltaMigracionEtiquetas = (msg: unknown): boolean =>
  COLUMNAS_ETIQUETAS.some((c) => new RegExp(`\\b${c}\\b`, "i").test(String(msg ?? "")))
  && /does not exist|schema cache|column/i.test(String(msg ?? ""));
