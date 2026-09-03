// ──────────────────────────────────────────────────────────────────────────────
// lib/liquidacion-rutas.ts — Cuántos asientos se CONTRATARON, que no es lo mismo
// que cuántos tiene el bus que salió ese día.
//
// EL PROBLEMA
//
// El formato imprimía "17 PAX" tomándolo de la capacidad del vehículo asignado. Pero
// AFA asigna por disponibilidad: una ruta contratada para 15 personas puede cubrirse
// un lunes con un bus de 17, el martes con uno de 20 y el jueves con uno de 16. El
// documento terminaba declarándole al cliente 20 asientos sobre un contrato de 15 —
// un número que nadie escribió y con el que se puede observar una factura.
//
// LA CASCADA
//
// La capacidad contratada es un hecho del CONTRATO, y en este ERP vive en cuatro
// sitios distintos según cómo nació el servicio. Se consultan en este orden:
//
//   1. La línea de la liquidación   — lo que el operador corrigió a mano en el
//                                     borrador. Es la última palabra sobre ESE documento.
//   2. reservas.capacidad_contratada — snapshot que el servicio lleva encima desde que
//                                     se programó. Gana sobre el contrato vigente porque
//                                     un contrato renegociado en junio no puede cambiar
//                                     lo que se pactó para agosto.
//   3. El ítem de la cotización     — el origen del acuerdo, para los servicios
//                                     generados antes de que existiera la columna.
//   4. cliente_ruta                 — el catálogo de rutas contratadas: la red de
//                                     seguridad, y lo que se corrige una sola vez.
//   5. NADA                         — se devuelve null, el formato sale SIN el "N PAX"
//                                     y la pantalla de cierre lo avisa.
//
// EL PASO 5 ES LA REGLA DURA: **nunca se cae a la capacidad del vehículo**. Un dato de
// menos se completa; un dato falso se descubre cuando el cliente rechaza la valorización.
//
// Todo es tolerante a que el SQL no se haya corrido todavía (supabase/liquidaciones-03-
// ruta-contratada.sql): sin la tabla, la cascada simplemente pierde su último escalón.
// ──────────────────────────────────────────────────────────────────────────────

import type { ParServicio, ReservaLiq } from "@/lib/liquidacion-agrupacion";
import { nombreRuta } from "@/lib/liquidacion-agrupacion";

/**
 * Normaliza un nombre de ruta para compararlo. DEBE producir lo mismo que
 * `public.fn_norm_ruta` en supabase/liquidaciones-03-ruta-contratada.sql, que es la
 * expresión del índice único del catálogo: si los dos criterios se separan, el ERP
 * creería que una ruta no está fichada mientras Postgres rechaza insertarla por
 * duplicada.
 */
export const normalizarNombreRuta = (s: string | null | undefined) =>
  String(s ?? "").trim().replace(/\s+/g, " ").toUpperCase();

export type RutaContratada = {
  id: number;
  cliente_id: number | null;
  cliente_sede_id: number | null;
  nombre_ida: string | null;
  nombre_retorno: string | null;
  pax_contratado: number | null;
  notas?: string | null;
  activo?: boolean;
};

/**
 * Identidad de una ruta contratada. Es la MISMA tupla con la que `agruparServicios`
 * arma sus líneas, así que cada renglón del formato mapea 1:1 contra una ficha: por eso
 * corregir el pax en el borrador alcanza para que el mes siguiente salga bien solo.
 */
export function claveRuta(
  clienteId: number | null | undefined,
  sedeId: number | null | undefined,
  nombreIda: string | null | undefined,
  nombreRetorno: string | null | undefined
): string {
  return [
    clienteId ?? 0,
    sedeId ?? 0,
    normalizarNombreRuta(nombreIda),
    normalizarNombreRuta(nombreRetorno),
  ].join("|");
}

/** Los nombres de los dos tramos de un servicio, por su sentido y no por quién cobra. */
export function nombresDelPar(par: ParServicio): { ida: string | null; retorno: string | null } {
  return {
    ida: par.ida ? nombreRuta(par.ida) : null,
    retorno: par.retorno ? nombreRuta(par.retorno) : null,
  };
}

// ── Catálogo ────────────────────────────────────────────────────────────────

export type CatalogoRutas = {
  /** clave → ficha. Ver `claveRuta`. */
  porClave: Map<string, RutaContratada>;
  filas: RutaContratada[];
  /** false si todavía no se corrió el SQL: la UI lo dice en vez de fallar. */
  disponible: boolean;
};

const VACIO: CatalogoRutas = { porClave: new Map(), filas: [], disponible: false };

/**
 * Lee las rutas contratadas de un cliente (o de todos, si no se acota). No lanza: si la
 * tabla no existe todavía devuelve un catálogo vacío marcado `disponible: false`.
 */
export async function cargarRutasContratadas(sb: any, clienteIds?: number[]): Promise<CatalogoRutas> {
  try {
    let q = sb.from("cliente_ruta").select("*").eq("activo", true);
    if (clienteIds?.length) q = q.in("cliente_id", clienteIds);
    const { data, error } = await q;
    if (error) return VACIO;
    const filas = ((data as any[]) ?? []) as RutaContratada[];
    const porClave = new Map<string, RutaContratada>();
    for (const f of filas)
      porClave.set(claveRuta(f.cliente_id, f.cliente_sede_id, f.nombre_ida, f.nombre_retorno), f);
    return { porClave, filas, disponible: true };
  } catch {
    return VACIO;
  }
}

/**
 * Crea o actualiza la ficha de una ruta. `pax` en null borra el dato en vez de guardar
 * un cero: "no sé cuántos se contrataron" y "se contrataron 0" no son lo mismo, y el
 * CHECK de la tabla rechaza el cero justamente por eso.
 */
export async function guardarPaxContratado(
  sb: any,
  ruta: {
    clienteId: number | null;
    sedeId: number | null;
    nombreIda: string | null;
    nombreRetorno: string | null;
    pax: number | null;
    notas?: string | null;
  }
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!ruta.clienteId) throw new Error("La ruta necesita un cliente para poder ficharse.");
    if (!ruta.nombreIda && !ruta.nombreRetorno)
      throw new Error("La ruta no tiene nombre: no hay contra qué guardar la capacidad.");
    const pax = ruta.pax != null && Number(ruta.pax) > 0 ? Math.round(Number(ruta.pax)) : null;

    // Se busca por el nombre YA normalizado, igual que el índice único de la tabla, para
    // no crear una segunda ficha por un espacio de más.
    const { data: existentes } = await sb
      .from("cliente_ruta")
      .select("id,cliente_sede_id,nombre_ida,nombre_retorno")
      .eq("cliente_id", ruta.clienteId);

    const clave = claveRuta(ruta.clienteId, ruta.sedeId, ruta.nombreIda, ruta.nombreRetorno);
    const yaEsta = ((existentes as any[]) ?? []).find(
      (f) => claveRuta(ruta.clienteId, f.cliente_sede_id, f.nombre_ida, f.nombre_retorno) === clave
    );

    const campos = {
      cliente_id: ruta.clienteId,
      cliente_sede_id: ruta.sedeId ?? null,
      nombre_ida: ruta.nombreIda ?? ruta.nombreRetorno,
      nombre_retorno: ruta.nombreIda ? ruta.nombreRetorno ?? null : null,
      pax_contratado: pax,
      ...(ruta.notas !== undefined ? { notas: ruta.notas } : {}),
      updated_at: new Date().toISOString(),
    };

    const { error } = yaEsta
      ? await sb.from("cliente_ruta").update(campos).eq("id", yaEsta.id)
      : await sb.from("cliente_ruta").insert(campos);
    if (error) throw new Error(error.message);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Escribe los asientos contratados EN LOS SERVICIOS, no en la ficha de la ruta.
 *
 * Hace falta porque `cliente_ruta` tiene un índice único por (cliente, sede, nombre de ida,
 * nombre de retorno): una ruta = una ficha = UN número. Y hay rutas que en el mismo periodo
 * salen con dos contratos distintos. El caso que lo destapó: la RUTA C de retorno con tres
 * adicionales, uno contratado por 4 asientos y dos por 10, todos con el mismo par de
 * nombres. La ficha no puede sostener los dos números; el servicio sí, y además es el
 * escalón que MANDA sobre ella en la cascada (ver la cabecera de este archivo).
 *
 * Es también lo correcto conceptualmente: `reservas.capacidad_contratada` es un snapshot de
 * lo que se pactó PARA ESE SERVICIO, igual que `precio_cliente`. La ficha es la red de
 * seguridad para los que no lo traen escrito.
 *
 * `pax` en null borra el snapshot y devuelve esos servicios a la cascada, que es distinto
 * de escribir un cero.
 */
export async function guardarPaxDeServicios(
  sb: any,
  reservaIds: number[],
  pax: number | null
): Promise<{ ok: boolean; escritos: number; error?: string }> {
  const ids = [...new Set(reservaIds.filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return { ok: true, escritos: 0 };
  const valor = pax != null && Number(pax) > 0 ? Math.round(Number(pax)) : null;
  let escritos = 0;
  try {
    // Por lotes: un `.in()` con cientos de ids desborda la URL y PostgREST responde 400.
    for (let i = 0; i < ids.length; i += 80) {
      const lote = ids.slice(i, i + 80);
      const { error } = await sb.from("reservas").update({ capacidad_contratada: valor }).in("id", lote);
      // Se corta al primer fallo y se dice cuántos SÍ entraron: dejar creer que se
      // guardaron 200 cuando entraron 80 es peor que el propio fallo.
      if (error) return { ok: false, escritos, error: error.message };
      escritos += lote.length;
    }
    return { ok: true, escritos };
  } catch (e: any) {
    return { ok: false, escritos, error: String(e?.message ?? e) };
  }
}

// ── Pax de la cotización ────────────────────────────────────────────────────

/**
 * Pax contratado por cotización, leído de `items_json`.
 *
 * Una cotización puede tener varios ítems y la reserva no guarda a cuál pertenece. Por
 * eso solo se usa el número cuando NO hay ambigüedad: si todos los ítems que declaran
 * pax declaran el mismo, ese es; si declaran distintos, se devuelve null y la cascada
 * sigue de largo. Adivinar aquí sería volver al problema que este módulo viene a
 * resolver, solo que con otra fuente.
 */
export async function cargarPaxDeCotizaciones(
  sb: any,
  cotizacionIds: number[]
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const ids = [...new Set(cotizacionIds.filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return out;
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await sb
        .from("cotizaciones")
        .select("id,items_json")
        .in("id", ids.slice(i, i + 200));
      if (error) return out;
      for (const c of ((data as any[]) ?? [])) {
        const items = Array.isArray(c.items_json) ? c.items_json : [];
        const paxes = [
          ...new Set(
            items
              .map((it: any) => Number(it?.pax_contratado ?? 0))
              .filter((n: number) => Number.isFinite(n) && n > 0)
          ),
        ];
        if (paxes.length === 1) out.set(Number(c.id), Number(paxes[0]));
      }
    }
  } catch {
    /* la cotización es un escalón opcional de la cascada */
  }
  return out;
}

// ── La cascada ──────────────────────────────────────────────────────────────

export type ContextoPax = {
  catalogo: CatalogoRutas;
  /** cotizacion_id → pax, de `cargarPaxDeCotizaciones`. */
  paxCotizacion: Map<number, number>;
  /** Sede del grupo que se está liquidando (las fichas se guardan por cliente+sede). */
  sedeId?: number | null;
  /** Overrides ya guardados en el documento, por clave de ruta. Solo al reconstruir uno emitido. */
  override?: Map<string, number>;
};

/** El primer número > 0 de los tramos del servicio, mirando la ida antes que el retorno. */
function paxDeLosTramos(par: ParServicio): number | null {
  const tramos: (ReservaLiq | null | undefined)[] = [par.ida, par.retorno, par.cabeza, ...par.adjuntas];
  for (const t of tramos) {
    const n = Number(t?.capacidad_contratada ?? 0);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
}

/**
 * Resuelve los asientos contratados de un servicio. Devuelve null cuando ninguna fuente
 * lo sabe — y ese null es una respuesta, no un fallo: significa "no lo escribas en el
 * formato". Ver la cabecera del archivo para el orden y el porqué.
 */
export function resolverPaxContratado(par: ParServicio, ctx: ContextoPax): number | null {
  for (const clave of clavesCandidatas(par, ctx)) {
    const manual = ctx.override?.get(clave);
    if (manual && manual > 0) return manual;
  }

  const delServicio = paxDeLosTramos(par);
  if (delServicio) return delServicio;

  const cot = Number(par.cabeza.cotizacion_id ?? 0);
  const deCotizacion = cot ? ctx.paxCotizacion.get(cot) : undefined;
  if (deCotizacion && deCotizacion > 0) return deCotizacion;

  for (const clave of clavesCandidatas(par, ctx)) {
    const deFicha = Number(ctx.catalogo.porClave.get(clave)?.pax_contratado ?? 0);
    if (deFicha > 0) return deFicha;
  }

  // Deliberadamente NO se cae a catalogo.capacidadDe(): ver la cabecera.
  return null;
}

/**
 * Las claves con las que buscar la ficha, de la más específica a la más general.
 *
 * La sede de un servicio se adivina por patrones cuando la reserva no la trae escrita
 * (ver `sedeDe` en app/liquidaciones/page.tsx), así que la misma ruta puede consultarse
 * con la sede del grupo, con la de la reserva o sin ninguna. Se prueban las tres antes
 * de dar por no fichada una ruta que sí lo está: una ficha guardada sin sede tiene que
 * servir igual para el grupo que la resolvió por patrón.
 */
function clavesCandidatas(par: ParServicio, ctx: ContextoPax): string[] {
  const { ida, retorno } = nombresDelPar(par);
  const clienteId = par.cabeza.cliente_id ?? null;
  const sedes = [ctx.sedeId, par.cabeza.cliente_sede_id, null];
  const vistas = new Set<string>();
  const claves: string[] = [];
  for (const s of sedes) {
    const k = claveRuta(clienteId, s ?? null, ida, retorno);
    if (!vistas.has(k)) { vistas.add(k); claves.push(k); }
  }
  return claves;
}

// ── La misma cascada, para UN servicio suelto ───────────────────────────────
//
// `resolverPaxContratado` razona sobre un `ParServicio`, que solo existe cuando ya se
// agruparon los servicios de un periodo. Programación edita un servicio a la vez y no
// tiene ese armado — pero necesita responder la MISMA pregunta, con el mismo orden y
// las mismas negativas, o las dos pantallas dirían números distintos sobre el mismo
// contrato. Por eso vive acá y no en la página: si mañana la cascada gana un escalón,
// se ve de un vistazo que hay dos sitios que actualizar.
//
// Dos diferencias, y las dos son por lo que Programación SÍ sabe y la liquidación no:
//
//   · El HERMANO es un escalón explícito. El generador escribe la capacidad solo en la
//     ida (ver ModalGenerarPrograma), así que al abrir un retorno el campo estaría
//     vacío y el operador escribiría el número otra vez — o uno distinto, que la
//     liquidación descartaría en silencio porque `paxDeLosTramos` mira la ida primero.
//
//   · La ficha se busca por NOMBRE de ruta, no por la clave completa: un servicio suelto
//     no siempre trae su sede, y la sede de la clave se adivina por patrones recién al
//     liquidar. Con más de un pax distinto entre las fichas que calzan se devuelve null,
//     igual que hace `cargarPaxDeCotizaciones` con los ítems ambiguos: acá adivinar sería
//     volver justo al problema que este módulo vino a resolver.

export type FuentePax = "servicio" | "hermano" | "cotizacion" | "ficha";

export type PaxResuelto = {
  /** null = ninguna fuente lo sabe. El ítem se imprime SIN el «N PAX». */
  pax: number | null;
  fuente: FuentePax | null;
};

/** Servicio suelto, con lo mínimo que hace falta para resolver su pax. */
export type ServicioPax = {
  capacidad_contratada?: number | null;
  cotizacion_id?: number | null;
  cliente_id?: number | null;
  ruta_nombre?: string | null;
};

const paxValido = (v: unknown): number | null => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/**
 * Pax de las fichas del cliente que calzan por NOMBRE con alguno de los tramos, sin
 * mirar la sede. Ambiguo (dos fichas con capacidades distintas) → null.
 */
export function paxDeFichaPorNombre(
  catalogo: CatalogoRutas,
  clienteId: number | null | undefined,
  nombres: (string | null | undefined)[]
): number | null {
  const buscados = new Set(
    nombres.map((n) => normalizarNombreRuta(n)).filter((n) => n.length > 0)
  );
  if (!buscados.size) return null;
  const paxes = new Set<number>();
  for (const f of catalogo.filas) {
    if (clienteId != null && f.cliente_id != null && Number(f.cliente_id) !== Number(clienteId)) continue;
    const calza =
      buscados.has(normalizarNombreRuta(f.nombre_ida)) ||
      buscados.has(normalizarNombreRuta(f.nombre_retorno));
    const p = paxValido(f.pax_contratado);
    if (calza && p) paxes.add(p);
  }
  return paxes.size === 1 ? [...paxes][0] : null;
}

/**
 * Los asientos contratados de UN servicio, y de dónde salió el número. La `fuente` no es
 * decoración: "15, escrito en este servicio" y "15, de la ficha de la ruta" se corrigen
 * en sitios distintos, y el operador no puede saber cuál sin que se lo digan.
 */
export function resolverPaxDeServicio(
  servicio: ServicioPax,
  hermano: { capacidad_contratada?: number | null; ruta_nombre?: string | null } | null,
  ctx: { paxCotizacion?: Map<number, number>; catalogo?: CatalogoRutas }
): PaxResuelto {
  const propio = paxValido(servicio.capacidad_contratada);
  if (propio) return { pax: propio, fuente: "servicio" };

  const delHermano = paxValido(hermano?.capacidad_contratada);
  if (delHermano) return { pax: delHermano, fuente: "hermano" };

  const cot = Number(servicio.cotizacion_id ?? 0);
  const deCotizacion = cot ? paxValido(ctx.paxCotizacion?.get(cot)) : null;
  if (deCotizacion) return { pax: deCotizacion, fuente: "cotizacion" };

  const deFicha = ctx.catalogo
    ? paxDeFichaPorNombre(ctx.catalogo, servicio.cliente_id, [servicio.ruta_nombre, hermano?.ruta_nombre])
    : null;
  if (deFicha) return { pax: deFicha, fuente: "ficha" };

  // Igual que en la cascada del par: NUNCA se cae a la capacidad del vehículo.
  return { pax: null, fuente: null };
}
