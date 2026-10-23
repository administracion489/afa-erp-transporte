// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/renombrar-categoria-datos.ts — SOLO SERVIDOR (service-role). Ejecuta el cambio de
// CLAVE de una categoría de traslado con las reglas de `lib/traslados/renombrar-categoria.ts`.
//
// SIN TRANSACCIÓN ENTRE BASE Y ALMACENAMIENTO, así que el orden es el que deja todo arreglable:
//  1. Se COPIAN las fotos a la carpeta de la clave nueva (las viejas siguen puestas: si algo falla
//     aquí, nada cambió y se borran las copias).
//  2. UN solo UPDATE cambia la clave y las URLs de las fotos. La FK de `tarifas_traslado` es
//     `on update cascade`: los precios se mueven en esa misma sentencia. Es CONDICIONAL (la clave y
//     las fotos que se leyeron): si otra persona cambió algo entretanto, no cambia nada.
//  3. Se borran las fotos viejas (best-effort: un fallo deja un archivo huérfano que nadie usa).
//  4. Las cotizaciones guardadas con la clave vieja (`traslado_json.categoria.clave`) pasan a la
//     nueva, una por una y de forma condicional. Si alguna no se pudo, el resultado dice cuántas
//     quedan y `completarRenombre` (el «Reintentar» de la pantalla) termina el trabajo.
// `sb` se inyecta (la matriz corre todo esto contra una base falsa).
// ──────────────────────────────────────────────────────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js";
import { columnaFaltante, faltaAlguna, tablaQueFalta, type ErrorSupabase } from "@/lib/columna-faltante";
import { BUCKET_FOTOS_TRASLADO, COLUMNA_FOTO, LADOS_FOTO, rutaDeUrlFoto, type LadoFoto } from "./fotos-categoria";
import { planFoto, revisarRenombre, trasladoJsonRenombrado, type CodigoRenombre, type PlanFoto, type PreviaRenombre } from "./renombrar-categoria";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = SupabaseClient<any, any, any>;

/** Las columnas de la categoría que vuelven a la pantalla (las de `COLS_CATEGORIA` + las de traslados-07). */
const COLS_CATEGORIA = "clave, nombre, capacidad, maletas_bodega, tipo_vehiculo, orden, activo";
const COLS_CATEGORIA_FOTOS = ["foto_externa_url", "foto_interna_url", "descripcion_cliente"] as const;
/** El camino PostgREST a la clave dentro de `cotizaciones.traslado_json`. */
export const RUTA_CLAVE_COTIZACION = "traslado_json->categoria->>clave";
/** Cotizaciones por vuelta al reescribir (y tope de vueltas: 50 × 200 = 10 000, operativo). */
const LOTE_COTIZACIONES = 200;
const MAX_VUELTAS = 50;

export type CodigoResultado =
  | "ok" | "parcial" | Exclude<CodigoRenombre, "ok">
  | "sin_migracion" | "foto" | "cambio_concurrente" | "no_aplica" | "error";

export type ResultadoRenombre = {
  ok: boolean;
  status: number;
  codigo: CodigoResultado;
  detalle: string;
  de: string;
  a: string;
  /** La fila con la clave nueva (para que la pantalla la ponga en su sitio). */
  categoria: Record<string, unknown> | null;
  /** Precios que quedaron con la clave nueva (null = no se pudieron contar). */
  tarifas: number | null;
  fotos_movidas: number;
  /** Lados cuya URL no era una foto de esta categoría: se dejaron tal cual. */
  fotos_ajenas: LadoFoto[];
  /** Fotos viejas que no se pudieron borrar (quedan huérfanas; ningún PDF las usa). */
  fotos_sin_borrar: number;
  cotizaciones: number;
  /** Cotizaciones que siguen con la clave vieja (null = no se pudieron contar). */
  cotizaciones_pendientes: number | null;
};

const vacio = (de: string, a: string): ResultadoRenombre => ({
  ok: false, status: 500, codigo: "error", detalle: "", de, a, categoria: null, tarifas: null,
  fotos_movidas: 0, fotos_ajenas: [], fotos_sin_borrar: 0, cotizaciones: 0, cotizaciones_pendientes: null,
});

const fallo = (de: string, a: string, status: number, codigo: CodigoResultado, detalle: string, extra: Partial<ResultadoRenombre> = {}): ResultadoRenombre =>
  ({ ...vacio(de, a), status, codigo, detalle, ...extra });

const SIN_TABLAS = "Falta correr supabase/traslados-01-tablas.sql: no existen las categorías de traslado.";

/** La categoría con sus fotos (suelta solo las columnas de traslados-07 que el error nombre). */
async function leerCategoria(sb: Sb, clave: string): Promise<
  { ok: true; fila: Record<string, unknown> | null; conFotos: LadoFoto[] } | { ok: false; error: ErrorSupabase }
> {
  let quedan: string[] = [...COLS_CATEGORIA_FOTOS];
  for (;;) {
    const cols = quedan.length ? `${COLS_CATEGORIA}, ${quedan.join(", ")}` : COLS_CATEGORIA;
    const r = await sb.from("traslado_categorias").select(cols).eq("clave", clave).maybeSingle();
    const col = r.error ? faltaAlguna(r.error, quedan) : null;
    if (col) { quedan = quedan.filter((c) => c !== col); continue; }
    if (r.error) return { ok: false, error: r.error };
    const conFotos = LADOS_FOTO.filter((l) => quedan.includes(COLUMNA_FOTO[l]));
    return { ok: true, fila: (r.data as Record<string, unknown> | null) ?? null, conFotos };
  }
}

/** Cuántas cotizaciones guardan esa clave. 0 si `cotizaciones.traslado_json` no existe; null si no se pudo leer. */
export async function contarCotizaciones(sb: Sb, clave: string): Promise<number | null> {
  const r = await sb.from("cotizaciones").select("id", { count: "exact", head: true }).eq(RUTA_CLAVE_COTIZACION, clave);
  if (r.error) return columnaFaltante(r.error) != null ? 0 : null;
  return typeof r.count === "number" ? r.count : null;
}

async function contarTarifas(sb: Sb, clave: string): Promise<number | null> {
  const r = await sb.from("tarifas_traslado").select("id", { count: "exact", head: true }).eq("categoria", clave);
  return r.error || typeof r.count !== "number" ? null : r.count;
}

/**
 * Las cotizaciones con la clave `de` pasan a `a`, una por una (PostgREST no reescribe un campo
 * dentro de un jsonb). Cada UPDATE exige que la fila siga con `de`. Recorre por id (las que fallan
 * no se vuelven a pedir en la misma pasada) y al final vuelve a contar las que quedan.
 */
export async function actualizarCotizaciones(sb: Sb, de: string, a: string): Promise<{ actualizadas: number; pendientes: number | null }> {
  let actualizadas = 0;
  let ultimo = 0;
  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const r = await sb.from("cotizaciones").select("id, traslado_json").eq(RUTA_CLAVE_COTIZACION, de)
      .gt("id", ultimo).order("id", { ascending: true }).limit(LOTE_COTIZACIONES);
    if (r.error) {
      if (columnaFaltante(r.error) != null) return { actualizadas, pendientes: 0 };
      console.error("[traslados/renombrar] lectura de cotizaciones", r.error.message);
      break;
    }
    const filas = (r.data ?? []) as { id: number; traslado_json: unknown }[];
    if (!filas.length) break;
    for (const f of filas) {
      ultimo = Math.max(ultimo, Number(f.id) || 0);
      const nuevo = trasladoJsonRenombrado(f.traslado_json, de, a);
      if (!nuevo) continue;
      const u = await sb.from("cotizaciones").update({ traslado_json: nuevo }).eq("id", f.id).eq(RUTA_CLAVE_COTIZACION, de).select("id");
      if (u.error) { console.error("[traslados/renombrar] cotización", f.id, u.error.message); continue; }
      actualizadas += (u.data ?? []).length;
    }
    if (filas.length < LOTE_COTIZACIONES) break;
  }
  return { actualizadas, pendientes: await contarCotizaciones(sb, de) };
}

/** Lo que va a pasar si se renombra `de` (para enseñarlo antes del botón). */
export async function previaRenombre(sb: Sb, de: string, supabaseUrl: string | null | undefined): Promise<
  { ok: true; previa: PreviaRenombre } | { ok: false; status: number; codigo: CodigoResultado; detalle: string }
> {
  const cat = await leerCategoria(sb, de);
  if (!cat.ok) {
    if (tablaQueFalta(cat.error) != null) return { ok: false, status: 409, codigo: "sin_migracion", detalle: SIN_TABLAS };
    console.error("[traslados/renombrar] previa", cat.error?.message);
    return { ok: false, status: 500, codigo: "error", detalle: "No se pudo leer la categoría. Vuelve a intentarlo en un momento." };
  }
  if (!cat.fila) return { ok: false, status: 404, codigo: "no_existe", detalle: `No existe la categoría ${de}: recarga la pantalla.` };
  // Las que se moverían: las fotos DE ESTA categoría (las demás se dejan tal cual).
  const fotos = cat.conFotos.filter((l) => rutaDeUrlFoto(cat.fila![COLUMNA_FOTO[l]], supabaseUrl, { clave: de, lado: l }) != null).length;
  const [tarifas, cotizaciones] = await Promise.all([contarTarifas(sb, de), contarCotizaciones(sb, de)]);
  return { ok: true, previa: { tarifas, fotos, cotizaciones } };
}

/** Cambia la clave `de` por `aTecleada`, con sus precios, sus fotos y sus cotizaciones guardadas. */
export async function renombrarCategoria(sb: Sb, x: { de: string; aTecleada: string; supabaseUrl: string | null | undefined }): Promise<ResultadoRenombre> {
  const { de } = x;
  const claves = await sb.from("traslado_categorias").select("clave");
  if (claves.error) {
    if (tablaQueFalta(claves.error) != null) return fallo(de, "", 409, "sin_migracion", SIN_TABLAS);
    console.error("[traslados/renombrar] claves", claves.error.message);
    return fallo(de, "", 500, "error", "No se pudieron leer las categorías. Vuelve a intentarlo en un momento.");
  }
  const rev = revisarRenombre(de, x.aTecleada, ((claves.data ?? []) as { clave: string }[]).map((c) => String(c.clave)));
  if (!rev.ok) return fallo(de, rev.a, rev.codigo === "no_existe" ? 404 : rev.codigo === "ya_existe" ? 409 : 400, rev.codigo, rev.detalle);
  const a = rev.a;

  const cat = await leerCategoria(sb, de);
  if (!cat.ok) {
    console.error("[traslados/renombrar] categoría", cat.error?.message);
    return fallo(de, a, 500, "error", "No se pudo leer la categoría. Vuelve a intentarlo en un momento.");
  }
  if (!cat.fila) return fallo(de, a, 404, "no_existe", `No existe la categoría ${de}: recarga la pantalla.`);

  // 1. Las fotos: copiarlas a la carpeta de la clave nueva (las de hoy siguen puestas).
  const bucket = sb.storage.from(BUCKET_FOTOS_TRASLADO);
  const copiadas: string[] = [];
  const deshacerCopias = async () => {
    if (!copiadas.length) return;
    try { await bucket.remove(copiadas); } catch { /* quedan huérfanas: ningún PDF las usa */ }
  };
  const planes: Partial<Record<LadoFoto, PlanFoto>> = {};
  const nuevasUrl: Partial<Record<LadoFoto, string>> = {};
  for (const lado of cat.conFotos) {
    const plan = planFoto(cat.fila[COLUMNA_FOTO[lado]], x.supabaseUrl, de, a, lado);
    planes[lado] = plan;
    if (plan.codigo !== "mover") continue;
    const c = await bucket.copy(plan.desde, plan.hasta);
    // Ya copiada por un intento anterior que no llegó a terminar (mismo nombre único): sirve igual.
    if (c.error && !/already exists|duplicate/i.test(String(c.error.message ?? ""))) {
      await deshacerCopias();
      console.error("[traslados/renombrar] copiar foto", lado, c.error.message);
      return fallo(de, a, 502, "foto",
        `No se pudo copiar la foto ${lado === "externa" ? "exterior" : "interior"} de ${de} a la carpeta de ${a}. Si el archivo ya no existe, quítala en «📷 Fotos y descripción» y vuelve a intentarlo; si no, inténtalo en un momento. No se cambió nada.`);
    }
    copiadas.push(plan.hasta);
    const url = bucket.getPublicUrl(plan.hasta).data.publicUrl;
    if (!rutaDeUrlFoto(url, x.supabaseUrl, { clave: a, lado })) {
      await deshacerCopias();
      return fallo(de, a, 500, "error", "La dirección pública de la foto no es la esperada: revisa NEXT_PUBLIC_SUPABASE_URL en Vercel. No se cambió nada.");
    }
    nuevasUrl[lado] = url;
  }

  // 2. Un solo UPDATE: la clave (y en cascada sus precios) y las URLs de las fotos. Condicional.
  const patch: Record<string, unknown> = { clave: a };
  for (const lado of LADOS_FOTO) if (nuevasUrl[lado]) patch[COLUMNA_FOTO[lado]] = nuevasUrl[lado];
  let q = sb.from("traslado_categorias").update(patch).eq("clave", de);
  for (const lado of cat.conFotos) {
    const col = COLUMNA_FOTO[lado];
    const v = cat.fila[col];
    q = v == null ? q.is(col, null) : q.eq(col, v as string);
  }
  const cols = cat.conFotos.length ? `${COLS_CATEGORIA}, ${COLS_CATEGORIA_FOTOS.join(", ")}` : COLS_CATEGORIA;
  const up = await q.select(cols);
  if (up.error) {
    await deshacerCopias();
    if (up.error.code === "23505") return fallo(de, a, 409, "ya_existe", `Ya existe la clave ${a}: elige otra. No se cambió nada.`);
    console.error("[traslados/renombrar] update", up.error.message);
    return fallo(de, a, 500, "error", "No se pudo cambiar la clave. Vuelve a intentarlo en un momento. No se cambió nada.");
  }
  const filas = (up.data ?? []) as unknown as Record<string, unknown>[];
  if (!filas.length) {
    await deshacerCopias();
    return fallo(de, a, 409, "cambio_concurrente", `Otra persona cambió ${de} (o sus fotos) mientras tanto: recarga la pantalla y vuelve a intentarlo. No se cambió nada.`);
  }

  // 3. Las fotos viejas ya no las usa nadie.
  let sinBorrar = 0;
  const viejas = LADOS_FOTO.map((l) => planes[l]).filter((p): p is Extract<PlanFoto, { codigo: "mover" }> => p?.codigo === "mover").map((p) => p.desde);
  if (viejas.length) {
    try {
      const r = await bucket.remove(viejas);
      if (r.error) sinBorrar = viejas.length;
    } catch { sinBorrar = viejas.length; }
  }

  // 4. Las cotizaciones guardadas con la clave vieja.
  const cot = await actualizarCotizaciones(sb, de, a);
  const tarifas = await contarTarifas(sb, a);
  const completo = cot.pendientes === 0;
  return {
    ok: true, status: 200, codigo: completo ? "ok" : "parcial",
    detalle: completo ? "" : cot.pendientes == null
      ? `La clave ya es ${a}, pero no se pudo comprobar si quedan cotizaciones guardadas con ${de}: pulsa «Reintentar» para terminar.`
      : `La clave ya es ${a}, pero ${cot.pendientes === 1 ? "1 cotización guardada sigue" : `${cot.pendientes} cotizaciones guardadas siguen`} con ${de} (su PDF saldría sin las fotos del vehículo): pulsa «Reintentar» para terminar.`,
    de, a, categoria: filas[0], tarifas,
    fotos_movidas: viejas.length,
    fotos_ajenas: LADOS_FOTO.filter((l) => planes[l]?.codigo === "ajena"),
    fotos_sin_borrar: sinBorrar,
    cotizaciones: cot.actualizadas, cotizaciones_pendientes: cot.pendientes,
  };
}

/**
 * Termina un renombre que dejó cotizaciones con la clave vieja. Solo si `de` ya no existe y `a` sí
 * (es decir, el renombre ya se hizo): nunca le pasa a una categoría las cotizaciones de otra viva.
 */
export async function completarRenombre(sb: Sb, x: { de: string; a: string }): Promise<ResultadoRenombre> {
  const { de, a } = x;
  const r = await sb.from("traslado_categorias").select("clave").in("clave", [de, a]);
  if (r.error) {
    if (tablaQueFalta(r.error) != null) return fallo(de, a, 409, "sin_migracion", SIN_TABLAS);
    console.error("[traslados/renombrar] completar", r.error.message);
    return fallo(de, a, 500, "error", "No se pudieron leer las categorías. Vuelve a intentarlo en un momento.");
  }
  const hay = new Set(((r.data ?? []) as { clave: string }[]).map((c) => String(c.clave)));
  if (hay.has(de) || !hay.has(a)) {
    return fallo(de, a, 409, "no_aplica", hay.has(de)
      ? `${de} todavía existe: no hay ningún cambio de clave que terminar.`
      : `No existe la categoría ${a}: recarga la pantalla.`);
  }
  const cat = await leerCategoria(sb, a);
  const cot = await actualizarCotizaciones(sb, de, a);
  const completo = cot.pendientes === 0;
  return {
    ...vacio(de, a), ok: true, status: 200, codigo: completo ? "ok" : "parcial",
    detalle: completo ? "" : cot.pendientes == null
      ? `No se pudo comprobar si quedan cotizaciones guardadas con ${de}: vuelve a intentarlo en un momento.`
      : `${cot.pendientes === 1 ? "1 cotización guardada sigue" : `${cot.pendientes} cotizaciones guardadas siguen`} con ${de}: vuelve a intentarlo en un momento.`,
    categoria: cat.ok ? cat.fila : null, tarifas: await contarTarifas(sb, a),
    cotizaciones: cot.actualizadas, cotizaciones_pendientes: cot.pendientes,
  };
}
