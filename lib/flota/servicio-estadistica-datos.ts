// lib/flota/servicio-estadistica-datos.ts — SOLO SERVIDOR. Lee lo que mide lib/flota/servicio-estadistica.ts
// (puro): la estadística de cada servicio de UN día.
//
// LEE UNA SOLA VEZ CADA TRAZA, y con el mismo camino que la torre: `medirServiciosDelDia` con
// `conHuella` (lib/gps-cobertura-datos.ts) da el conjunto de servicios, el techo, el veredicto RASTREO
// y las filas crudas. En cuanto un servicio se mide se calcula su HUELLA (`huellaDeServicio`: km,
// excesos, conductor del teléfono) y se SUELTAN las filas: un día son decenas de miles de posiciones
// y no hace falta tenerlas todas en memoria a la vez.
//
// El contexto de combustible se resuelve POR UNIDAD (no por servicio), una vez por petición:
//   · `vehiculos` / `vehiculos_tercero` → `tipo_vehiculo_costeo` y placa;
//   · `parametros_costos` de esos tipos y `precios_combustible`, una sola lectura cada uno;
//   · para las PROPIAS, `rendimientoMedido` y `precioUltimaCarga` de lib/costeo-servicio.ts
//     (IMPORTADOS, no copiados: es la misma cascada del presupuesto del servicio);
//   · para los TERCEROS, nada de medición ni de costo (`contextoCombustible` lo decide).
//
// UN FALLO DE LECTURA NO ES UN CERO: si no se pudo leer la unidad o su parámetro, ese servicio sale
// `sin_lectura` (nunca «sin categoría de costeo»), y si no se pudieron leer los precios, el costo sale
// `sin_lectura` y el volumen y el CO₂ se estiman igual. Todo lo que degradó la respuesta va en `avisos`.
//
// HEREDADO SIN CAMBIAR (y declarado): `rendimientoMedido` y `precioUltimaCarga` devuelven null ante un
// error de lectura, así que ahí el costo cae al rendimiento del parámetro y al precio de referencia —
// lo mismo que hace hoy el presupuesto. Y `precioUltimaCarga` toma la última carga con precio de
// CUALQUIER combustible de la placa (hallazgo del plan, sin resolver aquí: moverlo cambia el presupuesto).
//
// No devuelve teléfonos ni identificadores de aparato.

/* eslint-disable @typescript-eslint/no-explicit-any -- el cliente de Supabase del ERP va sin tipos generados */
import { createClient } from "@supabase/supabase-js";
import { medirServiciosDelDia, todas, MAX_RESERVAS } from "../gps-cobertura-datos";
import { rendimientoMedido, precioUltimaCarga } from "../costeo-servicio";
import type { ParametrosUnidad, PreciosCombustible } from "../costeo-propio";
import type { MedicionPlaca } from "../costos/rendimiento-aplica";
import {
  huellaDeServicio, componerEstadistica, contextoCombustible, resumirPorCliente, totalDelDia, metodoServicios,
  vehiculoDeReserva, conductorDeReservaClave,
  type ServicioParaEstadistica, type HuellaServicio, type ContextoCombustibleUnidad, type EstadisticaServicio,
  type RespuestaServicios, type Flota,
} from "./servicio-estadistica";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/** Unidades en paralelo al resolver la medición y la última carga (dos consultas cada una). */
const LOTE_UNIDADES = 8;

/** Lee las filas de `tabla` cuyos `col` están en `ids`, de a 200 por consulta, TODAS o lanza. */
async function porIds(tabla: string, cols: string, col: string, ids: (number | string)[], orden: string): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const sub = ids.slice(i, i + 200);
    out.push(...await todas(() => admin.from(tabla).select(cols).in(col, sub).order(orden, { ascending: true })));
  }
  return out;
}

const motivo = (e: unknown) => String((e as any)?.message ?? e ?? "error de lectura");

type Unidad = { flota: Flota; id: number; clave: string };

/**
 * El contexto de combustible de cada unidad del día, indexado por su clave ("p:ID" / "t:ID"), y la
 * placa de cada una. Nunca lanza: lo que no se pudo leer queda declarado en el contexto (`fallo`,
 * `falloPrecios`) y en `avisos`.
 */
async function contextosDeUnidades(unidades: Unidad[], avisos: string[]): Promise<{
  ctx: Map<string, ContextoCombustibleUnidad>;
  placa: Map<string, string>;
}> {
  const ctx = new Map<string, ContextoCombustibleUnidad>();
  const placa = new Map<string, string>();
  if (!unidades.length) return { ctx, placa };

  // 1 · Las unidades: placa y categoría de costeo. Propias y terceros son dos tablas (los ids se solapan).
  const fichas = new Map<string, { placa: string | null; tipoCosteo: string | null }>();
  const falloFicha = new Map<Flota, string>();
  await Promise.all((["propia", "tercero"] as Flota[]).map(async (flota) => {
    const ids = unidades.filter((u) => u.flota === flota).map((u) => u.id);
    if (!ids.length) return;
    try {
      const filas = await porIds(flota === "propia" ? "vehiculos" : "vehiculos_tercero", "id,placa,tipo_vehiculo_costeo", "id", ids, "id");
      for (const v of filas) {
        const tipo = v.tipo_vehiculo_costeo != null && String(v.tipo_vehiculo_costeo).trim() ? String(v.tipo_vehiculo_costeo) : null;
        fichas.set(`${flota === "propia" ? "p" : "t"}:${v.id}`, { placa: v.placa ? String(v.placa) : null, tipoCosteo: tipo });
      }
    } catch (e) {
      falloFicha.set(flota, motivo(e));
      avisos.push(`No se pudieron leer las unidades ${flota === "propia" ? "propias" : "tercerizadas"}: su placa y su combustible estimado no se muestran.`);
    }
  }));

  // 2 · Los parámetros de esos tipos y los precios de referencia, una lectura cada uno.
  const tipos = [...new Set([...fichas.values()].map((f) => f.tipoCosteo).filter((t): t is string => !!t))];
  const parametros = new Map<string, ParametrosUnidad>();
  let falloParametros: string | null = null;
  if (tipos.length) {
    try {
      for (const p of await porIds("parametros_costos", "*", "tipo_vehiculo", tipos, "tipo_vehiculo")) {
        parametros.set(String(p.tipo_vehiculo), p as ParametrosUnidad);
      }
    } catch (e) {
      falloParametros = motivo(e);
      avisos.push("No se pudieron leer los parámetros de costos: el combustible, el costo y el CO₂ estimados no se muestran.");
    }
  }
  const precios: PreciosCombustible = {};
  let falloPrecios: string | null = null;
  try {
    const { data, error } = await admin.from("precios_combustible").select("tipo,precio");
    if (error) throw new Error(error.message);
    for (const p of (data as any[]) ?? []) precios[p.tipo] = Number(p.precio) || 0;
  } catch (e) {
    falloPrecios = motivo(e);
    avisos.push("No se pudieron leer los precios de combustible: el costo estimado no se muestra (el volumen y el CO₂ sí).");
  }

  // 3 · Lo MEDIDO de cada propia con parámetro: la misma cascada del presupuesto (importada).
  const medida = new Map<string, { medicion: MedicionPlaca | null; ultima: { precio: number; fecha: string } | null }>();
  const propias = unidades.filter((u) => {
    if (u.flota !== "propia") return false;
    const f = fichas.get(u.clave);
    return !!f?.tipoCosteo && parametros.has(f.tipoCosteo);
  });
  for (let i = 0; i < propias.length; i += LOTE_UNIDADES) {
    await Promise.all(propias.slice(i, i + LOTE_UNIDADES).map(async (u) => {
      const [medicion, ultima] = await Promise.all([
        rendimientoMedido(admin, u.id).catch(() => null),
        precioUltimaCarga(admin, u.id).catch(() => null),
      ]);
      medida.set(u.clave, { medicion, ultima });
    }));
  }

  // 4 · El contexto de cada unidad.
  for (const u of unidades) {
    const f = fichas.get(u.clave);
    if (f?.placa) placa.set(u.clave, f.placa);
    const fallo = falloFicha.get(u.flota)
      ?? (!f ? "la unidad no se encontró en su tabla" : f.tipoCosteo && falloParametros ? falloParametros : null);
    const m = medida.get(u.clave);
    ctx.set(u.clave, contextoCombustible({
      flota: u.flota,
      tipoCosteo: f?.tipoCosteo ?? null,
      parametros: f?.tipoCosteo ? parametros.get(f.tipoCosteo) ?? null : null,
      medicion: m?.medicion ?? null,
      precioUltimaCarga: m?.ultima ?? null,
      preciosReferencia: precios,
      fallo,
      falloPrecios,
    }));
  }
  return { ctx, placa };
}

/** Nombres de conductores (las dos tablas) y clientes. Sin teléfonos. Nunca lanza. */
async function nombresDe(claves: string[], clientes: number[], avisos: string[]): Promise<{
  conductor: Map<string, string>; cliente: Map<number, string>;
}> {
  const conductor = new Map<string, string>();
  const cliente = new Map<number, string>();
  const ids = (pre: string) => [...new Set(claves.filter((c) => c.startsWith(pre)).map((c) => Number(c.slice(2))))];
  let fallo = false;
  await Promise.all([
    (async () => {
      const p = ids("p:");
      if (!p.length) return;
      try { for (const c of await porIds("conductores", "id,nombre", "id", p, "id")) if (c.nombre) conductor.set(`p:${c.id}`, String(c.nombre)); }
      catch { fallo = true; }
    })(),
    (async () => {
      const t = ids("t:");
      if (!t.length) return;
      try { for (const c of await porIds("conductores_tercero", "id,nombre", "id", t, "id")) if (c.nombre) conductor.set(`t:${c.id}`, String(c.nombre)); }
      catch { fallo = true; }
    })(),
    (async () => {
      const c = [...new Set(clientes)];
      if (!c.length) return;
      try {
        for (const x of await porIds("clientes", "id,nombre,empresa", "id", c, "id")) {
          const n = (x.empresa && String(x.empresa).trim()) || (x.nombre && String(x.nombre).trim()) || null;
          if (n) cliente.set(Number(x.id), n);
        }
      } catch { avisos.push("No se pudieron leer los nombres de los clientes: se muestran por su número."); }
    })(),
  ]);
  if (fallo) avisos.push("No se pudieron leer todos los nombres de conductores.");
  return { conductor, cliente };
}

/**
 * La estadística de cada servicio de `fecha` (el conjunto, el techo y el veredicto de la torre), con
 * su corte por cliente. `umbral` es el de los excesos (km/h, ya validado por la ruta). Lanza solo si
 * no se pudieron leer las reservas o sus paradas: entonces no hay nada honesto que contestar.
 */
export async function estadisticaDelDia(fecha: string, hoy: string, ahoraMs: number, umbral: number): Promise<RespuestaServicios> {
  const medidos: { s: ServicioParaEstadistica; huella: HuellaServicio }[] = [];
  const { fueraDelTecho } = await medirServiciosDelDia(fecha, hoy, ahoraMs, {
    conHuella: true,
    alMedir: (s) => {
      const huella = huellaDeServicio(s, umbral);
      // Lo que hacía falta de las filas crudas ya está en `huella`: se sueltan la traza y sus filas.
      medidos.push({ s: { reserva: s.reserva, paradas: s.paradas, ctx: s.ctx, traza: null, veredicto: s.veredicto }, huella });
    },
  });

  const avisos: string[] = [];
  const unidades = new Map<string, Unidad>();
  for (const { s } of medidos) {
    const v = vehiculoDeReserva(s.reserva);
    if (v) unidades.set(v.clave, { flota: v.flota, id: v.id, clave: v.clave });
  }
  const claves = new Set<string>();
  const clientes: number[] = [];
  for (const { s, huella } of medidos) {
    const c = conductorDeReservaClave(s.reserva);
    if (c) claves.add(c);
    if (huella.conductorGps) claves.add(huella.conductorGps);
    const cid = Number(s.reserva?.cliente_id);
    if (Number.isSafeInteger(cid) && cid > 0) clientes.push(cid);
  }

  const [{ ctx, placa }, nombres] = await Promise.all([
    contextosDeUnidades([...unidades.values()], avisos),
    nombresDe([...claves], clientes, avisos),
  ]);

  const servicios: EstadisticaServicio[] = medidos.map(({ s, huella }) => {
    const v = vehiculoDeReserva(s.reserva);
    return componerEstadistica({
      s, huella,
      ctxComb: v ? ctx.get(v.clave) ?? null : null,
      ahoraMs, hoy,
      nombres: {
        conductor: (c) => nombres.conductor.get(c) ?? null,
        cliente: (id) => nombres.cliente.get(id) ?? null,
        placa: (c) => placa.get(c) ?? null,
      },
    });
  });
  // Como la torre: por hora planificada, y por id a igual hora (sin hora, al final).
  servicios.sort((a, b) => (a.hora ?? "99:99").localeCompare(b.hora ?? "99:99") || a.reservaId - b.reservaId);
  if (fueraDelTecho.length) {
    avisos.push(`${fueraDelTecho.length} servicio(s) del día no se midieron por pasar del tope de ${MAX_RESERVAS}: no tienen km ni CO₂ (no es un cero).`);
  }

  return {
    fecha,
    umbral,
    medidoEn: new Date(ahoraMs).toISOString(),
    servicios,
    porCliente: resumirPorCliente(servicios),
    total: totalDelDia(servicios),
    fueraDelTecho,
    tope: MAX_RESERVAS,
    metodo: metodoServicios(),
    avisos,
  };
}
