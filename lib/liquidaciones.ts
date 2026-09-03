// ──────────────────────────────────────────────────────────────────────────────
// lib/liquidaciones.ts — Dominio de LIQUIDACIONES (Cliente y Proveedor).
//
// Dos procesos independientes entre Operaciones y Finanzas:
//
//   Liquidación al CLIENTE   → confirma el importe DEFINITIVO del periodo, se envía
//                              para conformidad y, al aprobarse, emite la `factura`.
//   Liquidación al PROVEEDOR → solo tercerizados. Al aprobarse genera la Cuenta por
//                              Pagar (`documentos_compra`, si ese módulo está corrido).
//
// El documento es una VALORIZACIÓN por cliente + SEDE con líneas agrupadas (N
// servicios de la misma ruta/turno/móvil a la misma tarifa), no una fila por viaje:
// así sale el formato AFA-FL-07 que el cliente ya firma. La agrupación la calcula
// lib/liquidacion-agrupacion.ts; aquí solo se persiste y se gobierna el ciclo.
//
// Reglas que sostienen todo esto:
//   · Los montos se calculan y se guardan como SNAPSHOT; la factura/CxP se DERIVA de
//     ese snapshot. El dinero entra a contabilidad una sola vez, a nivel comprobante.
//   · Ninguna reserva puede estar en dos liquidaciones: al crear se marca
//     reservas.liquidacion_cliente_id (o _proveedor_id) y la agrupación la excluye.
//   · Las transiciones de estado usan CLAIM ATÓMICO (un UPDATE condicional): dos
//     clics o dos operadores no pueden emitir dos comprobantes de la misma liquidación.
//
// Requiere supabase/liquidaciones-v2.sql. `sb` es el cliente Supabase (browser anon o
// service-role); tipado `any` como en el resto del ERP.
// ──────────────────────────────────────────────────────────────────────────────

import { redondear, calcularDetraccion } from "@/lib/finanzas/dinero";
import {
  totalesValorizacion, descripcionLinea, sentidoDeReserva, nombreRuta, origenDeTramos,
  analizarServicios, precioUnitario,
  type LineaAgrupada, type ParServicio, type ReservaLiq,
} from "@/lib/liquidacion-agrupacion";
import {
  cargarRutasContratadas, cargarPaxDeCotizaciones, resolverPaxContratado,
} from "@/lib/liquidacion-rutas";
import { guardarReservas } from "@/lib/reservas-pacto";

export type Lado = "cliente" | "proveedor";

const T = {
  cliente: {
    cab: "liquidacion_cliente",
    linea: "liquidacion_cliente_linea",
    puente: "liquidacion_cliente_linea_reserva",
    fkReserva: "liquidacion_cliente_id",
    estadoReserva: "estado_admin",
  },
  proveedor: {
    cab: "liquidacion_proveedor",
    linea: "liquidacion_proveedor_linea",
    puente: "liquidacion_proveedor_linea_reserva",
    fkReserva: "liquidacion_proveedor_id",
    estadoReserva: "estado_proveedor",
  },
} as const;

const ahora = () => new Date().toISOString();
/** Fecha de hoy en Perú (UTC-5). No usar toISOString() pelado: adelanta el día. */
export const hoyLima = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

// ── Configuración tributaria ────────────────────────────────────────────────

/** Lee el IGV vigente de config_tributaria (fallback 18). */
export async function igvVigente(sb: any): Promise<number> {
  try {
    const { data } = await sb.from("config_tributaria").select("igv_pct").eq("id", 1).maybeSingle();
    const v = Number(data?.igv_pct);
    return Number.isFinite(v) && v > 0 ? v : 18;
  } catch {
    return 18;
  }
}

/** Detracción del catálogo por código de servicio SUNAT (null si no aplica). */
export async function detraccionDe(
  sb: any,
  codigo: string | null | undefined
): Promise<{ codigo: string; porcentaje: number; umbral_min: number } | null> {
  if (!codigo) return null;
  try {
    const { data } = await sb
      .from("cat_detraccion")
      .select("codigo,porcentaje,umbral_min,activo")
      .eq("codigo", codigo)
      .maybeSingle();
    if (!data || data.activo === false) return null;
    return { codigo: data.codigo, porcentaje: Number(data.porcentaje), umbral_min: Number(data.umbral_min ?? 700) };
  } catch {
    return null;
  }
}

// ── Bitácora ────────────────────────────────────────────────────────────────

export async function registrarEvento(
  sb: any,
  entidad: Lado,
  liquidacionId: number,
  evento: string,
  extra?: { detalle?: string; usuario?: string; ip?: string }
): Promise<void> {
  try {
    await sb.from("liquidacion_evento").insert({
      entidad, liquidacion_id: liquidacionId, evento,
      detalle: extra?.detalle ?? null, usuario: extra?.usuario ?? null, ip: extra?.ip ?? null,
    });
  } catch {
    // La bitácora nunca debe tumbar la operación principal.
  }
}

// ── Totales ─────────────────────────────────────────────────────────────────

export type LineaPersistida = {
  id?: number;
  item: number;
  tipo: "servicio" | "adicional" | "penalidad" | "descuento";
  descripcion: string;
  unidad_medida: string;
  cantidad_programada?: number | null;
  cantidad_ejecutada?: number | null;
  cantidad: number;
  cantidad_motivo?: string | null;
  precio_unitario: number;
  orden_compra?: string | null;
  total_linea: number;
  agrupacion_clave?: string | null;
  referencia?: string | null;
  reservas?: number[];
};

export type TotalesProveedorExt = {
  subtotal: number; igv: number; totalComprobante: number;
  detraccionPct: number | null; detraccionMonto: number; anticipos: number; total: number;
};

/**
 * Totales del lado proveedor. Ojo con el orden: la detracción y los anticipos son
 * mecanismos de PAGO, no reducen el comprobante. Por eso `totalComprobante` queda
 * intacto (es lo que el tercero factura y lo que va al Registro de Compras) y solo
 * el NETO A PAGAR los descuenta.
 */
export function totalesProveedorExt(
  lineas: { tipo: LineaPersistida["tipo"]; cantidad: number; precio_unitario: number }[],
  opts: {
    igvPct: number;
    detraccion?: { porcentaje: number; umbral_min?: number; codigo?: string | null; activa?: boolean } | null;
    anticipos?: number;
  }
): TotalesProveedorExt {
  const t = totalesValorizacion(lineas, opts.igvPct);
  const totalComprobante = t.total;
  const det = opts.detraccion ? calcularDetraccion(totalComprobante, opts.detraccion) : { monto: 0, porcentaje: null as any };
  const anticipos = redondear(opts.anticipos ?? 0);
  return {
    subtotal: t.subtotal,
    igv: t.igv,
    totalComprobante,
    detraccionPct: opts.detraccion?.porcentaje ?? null,
    detraccionMonto: redondear(det.monto),
    anticipos,
    total: redondear(Math.max(0, totalComprobante - det.monto - anticipos)),
  };
}

/** Relee las líneas de la BD y reescribe los totales de la cabecera. */
export async function recalcularTotales(sb: any, lado: Lado, id: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const t = T[lado];
    const { data: cab } = await sb.from(t.cab).select("*").eq("id", id).maybeSingle();
    if (!cab) throw new Error("La liquidación no existe.");
    const { data: lineas } = await sb
      .from(t.linea)
      .select("tipo,cantidad,precio_unitario")
      .eq("liquidacion_id", id);
    const filas = ((lineas as any[]) ?? []).map((l) => ({
      tipo: l.tipo, cantidad: Number(l.cantidad ?? 0), precio_unitario: Number(l.precio_unitario ?? 0),
    }));
    const igvPct = Number(cab.igv_pct ?? 18);

    if (lado === "cliente") {
      const tot = totalesValorizacion(filas, igvPct);
      await sb.from(t.cab).update({ subtotal: tot.subtotal, igv: tot.igv, total: tot.total }).eq("id", id);
    } else {
      const det = await detraccionDe(sb, cab.detraccion_codigo);
      const tot = totalesProveedorExt(filas, {
        igvPct, detraccion: det, anticipos: Number(cab.anticipos ?? 0),
      });
      await sb.from(t.cab).update({
        subtotal: tot.subtotal, igv: tot.igv, total_comprobante: tot.totalComprobante,
        detraccion_pct: tot.detraccionPct, detraccion_monto: tot.detraccionMonto, total: tot.total,
      }).eq("id", id);
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── Creación ────────────────────────────────────────────────────────────────

export type GrupoALiquidar = {
  /** Cliente o empresa tercerizada, según el lado. */
  contraparteId: number | null;
  sedeId?: number | null;
  lineas: LineaAgrupada[];
  /** Snapshot de la sección 1 (viene de cliente_sedes; el operador puede corregirlo). */
  cabecera?: {
    area_solicitante?: string | null;
    usuario_solicita?: string | null;
    cargo_solicita?: string | null;
    servicio_contratado?: string | null;
    ubicacion_servicio?: string | null;
    orden_compra?: string | null;
    moneda?: string | null;
    detraccion_codigo?: string | null;
    responsable_afa?: string | null;
    cargo_responsable?: string | null;
    cuenta_detraccion?: string | null;
    proveedor_id?: number | null;
  };
};

export type OpcionesCreacion = {
  lado: Lado;
  periodoDesde: string;
  periodoHasta: string;
  periodoLabel?: string | null;
  igvPct: number;
  preciosIncluyenIgv: boolean;
  usuario?: string | null;
};

export type ResultadoCreacion = {
  ok: boolean;
  creadas: { id: number; codigo: string | null; contraparteId: number | null; sedeId: number | null; total: number; servicios: number }[];
  errores: string[];
};

/**
 * Crea UNA liquidación en borrador por grupo (cliente+sede / empresa tercerizada).
 * Esto es la "liquidación masiva": la pantalla arma N grupos y esto devuelve N
 * documentos listos para revisar.
 *
 * Cada grupo se procesa de forma independiente: si uno falla, los demás igual se
 * crean y el error se reporta. Cerrar un periodo no puede quedarse a medias por un
 * cliente con datos incompletos.
 */
export async function crearLiquidaciones(
  sb: any,
  grupos: GrupoALiquidar[],
  opts: OpcionesCreacion
): Promise<ResultadoCreacion> {
  const t = T[opts.lado];
  const res: ResultadoCreacion = { ok: true, creadas: [], errores: [] };

  for (const g of grupos) {
    try {
      if (!g.lineas.length) throw new Error("El grupo no tiene servicios que liquidar.");
      const cab = g.cabecera ?? {};
      const moneda = cab.moneda || "PEN";
      const periodoLabel =
        opts.periodoLabel || `${opts.periodoDesde} al ${opts.periodoHasta}`;

      // El tipo sale de la línea, no se fuerza a "servicio": lo que el cliente pidió
      // por encima del contrato tiene que caer en el subtotal de adicionales del
      // formato, no en el de servicios contratados.
      const filasMonto = g.lineas.map((l) => ({
        tipo: l.tipo, cantidad: l.cantidad, precio_unitario: l.precio_unitario,
      }));

      const base: any = {
        periodo: periodoLabel,
        periodo_desde: opts.periodoDesde,
        periodo_hasta: opts.periodoHasta,
        fecha_valorizacion: hoyLima(),
        fecha_inicio_servicio: opts.periodoDesde,
        fecha_fin_servicio: opts.periodoHasta,
        moneda,
        estado: "borrador",
        precios_incluyen_igv: opts.preciosIncluyenIgv,
        igv_pct: opts.igvPct,
        servicio_contratado: cab.servicio_contratado ?? null,
        ubicacion_servicio: cab.ubicacion_servicio ?? null,
        orden_compra: cab.orden_compra ?? null,
      };

      if (opts.lado === "cliente") {
        const tot = totalesValorizacion(filasMonto, opts.igvPct);
        Object.assign(base, {
          cliente_id: g.contraparteId,
          cliente_sede_id: g.sedeId ?? null,
          area_solicitante: cab.area_solicitante ?? null,
          usuario_solicita: cab.usuario_solicita ?? null,
          cargo_solicita: cab.cargo_solicita ?? null,
          grado_satisfaccion: "CONFORME",
          subtotal: tot.subtotal, igv: tot.igv, total: tot.total,
        });
      } else {
        const det = await detraccionDe(sb, cab.detraccion_codigo);
        const tot = totalesProveedorExt(filasMonto, { igvPct: opts.igvPct, detraccion: det, anticipos: 0 });
        Object.assign(base, {
          empresa_tercerizada_id: g.contraparteId,
          proveedor_id: cab.proveedor_id ?? null,
          responsable_afa: cab.responsable_afa ?? null,
          cargo_responsable: cab.cargo_responsable ?? null,
          cuenta_detraccion: cab.cuenta_detraccion ?? null,
          detraccion_codigo: cab.detraccion_codigo ?? null,
          evaluacion: "CONFORME",
          subtotal: tot.subtotal, igv: tot.igv, total_comprobante: tot.totalComprobante,
          detraccion_pct: tot.detraccionPct, detraccion_monto: tot.detraccionMonto,
          anticipos: 0, total: tot.total,
        });
      }

      const { data: cabRow, error } = await sb.from(t.cab).insert(base).select("id,codigo,total").single();
      if (error) throw new Error(error.message);
      const id = Number(cabRow.id);

      // RECLAMO ATÓMICO de los servicios, ANTES de escribir las líneas.
      //
      // El UPDATE condicional (… where liquidacion_x_id is null) serializa a nivel de
      // fila: si dos operadores cierran el mismo periodo a la vez, cada servicio lo
      // gana UNO solo y el otro simplemente no lo recibe. Sin esto, ambos armarían
      // liquidaciones con los mismos viajes y el cliente terminaría facturado dos
      // veces por el mismo servicio.
      const candidatas = [...new Set(g.lineas.flatMap((l) => l.reservas))];
      const reclamadas = new Set<number>();
      if (candidatas.length) {
        const upd: any = { [t.fkReserva]: id, fecha_liquidacion: ahora() };
        upd[t.estadoReserva] = opts.lado === "cliente" ? "liquidada" : "conciliada";
        for (let i = 0; i < candidatas.length; i += 300) {
          const { data: ok } = await sb.from("reservas")
            .update(upd)
            .in("id", candidatas.slice(i, i + 300))
            .is(t.fkReserva, null)
            .select("id");
          for (const r of ((ok as any[]) ?? [])) reclamadas.add(Number(r.id));
        }
      }
      const perdidas = candidatas.length - reclamadas.size;

      // Líneas: solo con lo efectivamente reclamado, y recalculando la cantidad.
      let item = 0;
      const reservasTodas: number[] = [];
      for (const l of g.lineas) {
        const suyas = l.reservas.filter((rid) => reclamadas.has(rid));
        if (!suyas.length) continue;   // otro operador se llevó todos los de esta línea
        item += 1;

        // SERVICIOS ejecutados, no reservas: `suyas` trae los dos tramos del día (la
        // ida que cobra y el retorno incluido), así que contar sobre ella duplicaba —
        // 19 servicios se imprimían "19 / 38" en la columna PROG./EJEC. del formato que
        // firma el cliente, y como la cantidad (19) ya no coincidía con la ejecutada
        // (38), el editor exigía un "motivo del ajuste" en TODAS las líneas de un
        // documento que no tenía ningún ajuste.
        const ejecutadas = (l.servicios ?? l.reservas).filter((rid) => reclamadas.has(rid)).length;
        // Si quien llama no tocó la cantidad, se cobra lo efectivamente reclamado; si la
        // ajustó a mano, manda su número.
        const cantidad = Number(l.cantidad) === Number(l.cantidad_ejecutada) ? ejecutadas : l.cantidad;

        const fila: any = {
          liquidacion_id: id,
          item,
          tipo: l.tipo,
          descripcion: l.descripcion,
          unidad_medida: l.unidad_medida,
          cantidad_programada: l.cantidad_programada,
          cantidad_ejecutada: ejecutadas,
          cantidad,
          // Snapshot de los asientos CONTRATADOS que se imprimieron. Si mañana se
          // corrige la ficha de la ruta, el papel que el cliente ya firmó no puede
          // cambiar de número por debajo.
          pax_contratado: l.pax_contratado ?? null,
          precio_unitario: l.precio_unitario,
          orden_compra: cab.orden_compra ?? null,
          total_linea: redondear(cantidad * l.precio_unitario),
          agrupacion_clave: l.clave,
          referencia: l.referencia,
        };
        // La columna del pax es de supabase/liquidaciones-03: si esa migración todavía
        // no se corrió, se reintenta sin ella. Cerrar el periodo no puede quedarse
        // bloqueado por un dato accesorio del formato.
        let { data: lin, error: eL } = await sb.from(t.linea).insert(fila).select("id").single();
        if (eL && /pax_contratado/i.test(String(eL.message))) {
          delete fila.pax_contratado;
          ({ data: lin, error: eL } = await sb.from(t.linea).insert(fila).select("id").single());
        }
        if (eL) throw new Error(`línea: ${eL.message}`);
        const lineaId = Number(lin.id);

        const puente = suyas.map((rid) => ({ linea_id: lineaId, reserva_id: rid }));
        for (let i = 0; i < puente.length; i += 500) {
          const { error: eP } = await sb.from(t.puente).insert(puente.slice(i, i + 500));
          if (eP) throw new Error(`puente: ${eP.message}`);
        }
        reservasTodas.push(...suyas);
      }

      if (!reservasTodas.length) {
        // Todos los servicios ya estaban en otra liquidación: la cabecera vacía se
        // borra en vez de dejar un documento fantasma en la lista.
        await sb.from(t.cab).delete().eq("id", id);
        throw new Error("Los servicios de este grupo ya fueron liquidados por otro usuario.");
      }

      // Los totales se rehacen contra lo que quedó escrito, no contra lo estimado.
      await recalcularTotales(sb, opts.lado, id);

      await registrarEvento(sb, opts.lado, id, "creada", {
        detalle: `${item} línea(s) · ${reservasTodas.length} servicio(s)` +
          (perdidas > 0 ? ` · ${perdidas} servicio(s) ya estaban liquidados y se omitieron` : ""),
        usuario: opts.usuario ?? undefined,
      });

      const { data: fin } = await sb.from(t.cab).select("total").eq("id", id).maybeSingle();
      res.creadas.push({
        id, codigo: cabRow.codigo ?? null,
        contraparteId: g.contraparteId, sedeId: g.sedeId ?? null,
        total: Number(fin?.total ?? cabRow.total ?? 0), servicios: reservasTodas.length,
      });
    } catch (e: any) {
      res.ok = false;
      res.errores.push(String(e?.message ?? e));
    }
  }
  return res;
}

// ── Recalcular las descripciones de un borrador ─────────────────────────────

const COLS_RECALCULO =
  "id,codigo,fecha_servicio,hora_servicio,estado,cliente_id,cliente_sede_id,ruta_nombre," +
  "direccion_servicio,origen,destino,reserva_vinculada_id,cotizacion_id,capacidad_contratada," +
  "precio_cliente,costo_proveedor,vehiculo_id,vehiculo_tercero_id";

/** La agrega supabase/reservas-04: se pide aparte para no romper el recálculo si falta. */
const COL_ORIGEN_CONTRACTUAL = "origen_contractual";

/** El nombre de ruta que más veces aparece en un conjunto de tramos. */
function nombreMasFrecuente(filas: ReservaLiq[]): string | null {
  const cuenta = new Map<string, number>();
  for (const r of filas) {
    const n = nombreRuta(r);
    if (n && n !== "SIN NOMBRE DE RUTA") cuenta.set(n, (cuenta.get(n) ?? 0) + 1);
  }
  if (!cuenta.size) return null;
  return [...cuenta].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

/**
 * Reescribe la DESCRIPCIÓN (y el pax contratado) de las líneas de servicio de un
 * borrador, a partir de los datos de hoy. No toca cantidades, precios ni totales: solo
 * el texto que se imprime.
 *
 * Existe porque la descripción es un SNAPSHOT: un documento creado antes de este cambio
 * conserva para siempre el "RUTA B / TURNO DÍA / MÓVIL 1" que se le escribió al nacer,
 * y sin esto la única forma de verlo con el formato nuevo sería anular la liquidación y
 * volver a cerrar el periodo entero.
 *
 * Cada línea se reconstruye con SUS PROPIAS reservas, no re-agrupando el periodo: así el
 * documento mantiene exactamente los mismos renglones, los mismos importes y el mismo
 * Anexo 1, y solo cambia lo que dicen. Si dos renglones antiguos resultan tener ahora el
 * mismo texto es porque son la misma ruta partida por un eje que no se imprimía — queda
 * a la vista para juntarlos a mano.
 *
 * Solo sobre borradores: un documento emitido ya lo vio el cliente.
 *
 * `opts.lineas` la acota a esas líneas. Lo usa `actualizarPaxContratado`: al cambiar el
 * pax de UN renglón hay que rehacer SU texto (lleva el «N PAX» adentro) sin pisar las
 * descripciones que alguien haya ajustado a mano en los otros.
 */
export async function recalcularDescripciones(
  sb: any,
  lado: Lado,
  id: number,
  opts?: { usuario?: string | null; lineas?: number[] }
): Promise<{ ok: boolean; actualizadas?: number; sinPax?: number; error?: string }> {
  try {
    const t = T[lado];
    const { data: cab } = await sb.from(t.cab).select("*").eq("id", id).maybeSingle();
    if (!cab) throw new Error("La liquidación no existe.");
    if (cab.estado !== "borrador")
      throw new Error("Solo se recalcula un borrador: este documento ya salió de la casa. Reábrelo primero.");

    const { data: lineasRaw } = await sb
      .from(t.linea)
      .select("id,item,tipo,descripcion,agrupacion_clave")
      .eq("liquidacion_id", id)
      .order("item");
    // Las líneas que salieron de la AGRUPACIÓN, que son las que tienen reservas detrás
    // y por lo tanto se pueden recalcular. Una adicional generada desde Programación es
    // una de ellas (lleva `agrupacion_clave`); una adicional escrita a mano en el editor
    // no lo es, y reescribirle la descripción borraría lo que alguien tecleó.
    const soloEstas = opts?.lineas?.length ? new Set(opts.lineas.map(Number)) : null;
    const lineas = ((lineasRaw as any[]) ?? []).filter(
      (l) => (l.tipo === "servicio" || (l.tipo === "adicional" && l.agrupacion_clave))
          && (!soloEstas || soloEstas.has(Number(l.id)))
    );
    if (!lineas.length) return { ok: true, actualizadas: 0, sinPax: 0 };

    // Puente línea ↔ reserva, por lotes: un periodo largo pasa del corte de PostgREST.
    const lineaIds = lineas.map((l) => Number(l.id));
    const puente: any[] = [];
    for (let i = 0; i < lineaIds.length; i += 100) {
      const { data } = await sb.from(t.puente).select("linea_id,reserva_id").in("linea_id", lineaIds.slice(i, i + 100));
      puente.push(...((data as any[]) ?? []));
    }
    const reservaIds = [...new Set(puente.map((p) => Number(p.reserva_id)))];
    const reservas: any[] = [];
    for (let i = 0; i < reservaIds.length; i += 300) {
      const trozo = reservaIds.slice(i, i + 300);
      let r = await sb.from("reservas").select(`${COLS_RECALCULO},${COL_ORIGEN_CONTRACTUAL}`).in("id", trozo);
      if (r.error) r = await sb.from("reservas").select(COLS_RECALCULO).in("id", trozo);
      reservas.push(...((r.data as any[]) ?? []));
    }
    const porId = new Map<number, ReservaLiq>(reservas.map((r) => [Number(r.id), r as ReservaLiq]));

    // Contexto de la cascada del pax contratado.
    const [catalogo, paxCotizacion, sedeR] = await Promise.all([
      cargarRutasContratadas(sb, cab.cliente_id ? [Number(cab.cliente_id)] : undefined),
      cargarPaxDeCotizaciones(sb, reservas.map((r) => Number(r.cotizacion_id ?? 0))),
      cab.cliente_sede_id
        ? sb.from("cliente_sedes").select("nombre,servicio_contratado").eq("id", cab.cliente_sede_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const sede: any = (sedeR as any)?.data ?? null;
    const concepto =
      (cab.servicio_contratado || sede?.servicio_contratado || "").replace(/^SERVICIO DE /i, "") ||
      "TRANSPORTE DE PERSONAL";

    let actualizadas = 0;
    let sinPax = 0;

    for (const l of lineas) {
      const filas = puente
        .filter((p) => Number(p.linea_id) === Number(l.id))
        .map((p) => porId.get(Number(p.reserva_id)))
        .filter(Boolean) as ReservaLiq[];
      if (!filas.length) continue;

      const idas = filas.filter((r) => sentidoDeReserva(r) === "IDA");
      const retornos = filas.filter((r) => sentidoDeReserva(r) === "RETORNO");
      const nombreIda = nombreMasFrecuente(idas);
      const nombreRetorno = nombreMasFrecuente(retornos);

      // Un servicio representativo para resolver el pax: la ida (con su retorno si lo
      // tiene), que es la unidad con la que se contrató la ruta.
      const cabeza = idas[0] ?? filas[0];
      const par: ParServicio = {
        cabeza,
        adjuntas: [],
        ejecutado: true,
        ejecutados: [cabeza],
        sentido: idas.length && retornos.length ? "IDA Y RETORNO" : sentidoDeReserva(cabeza),
        ida: idas[0] ?? null,
        retorno: retornos[0] ?? null,
      };
      const pax = resolverPaxContratado(par, {
        catalogo,
        paxCotizacion,
        sedeId: cab.cliente_sede_id ?? null,
      });
      if (pax == null) sinPax += 1;

      // Móviles con el mismo criterio que la agrupación: 2+ salidas en el mismo
      // (fecha, hora). Sobre las reservas de ESTA línea, un documento antiguo partido
      // por placa da 1 y el "MÓVIL 1" inventado desaparece, que es lo correcto.
      const porSalida = new Map<string, number>();
      for (const r of (idas.length ? idas : filas)) {
        const k = `${r.fecha_servicio ?? ""}|${String(r.hora_servicio ?? "").slice(0, 5)}`;
        porSalida.set(k, (porSalida.get(k) ?? 0) + 1);
      }
      const moviles = Math.max(1, ...porSalida.values());
      const movil = Number(/\|M(\d+)$/.exec(String(l.agrupacion_clave ?? ""))?.[1] ?? 1);

      const descripcion = descripcionLinea({
        concepto,
        sede: sede?.nombre ?? null,
        pax,
        desde: cab.periodo_desde ?? null,
        hasta: cab.periodo_hasta ?? null,
        nombreIda,
        nombreRetorno,
        movil,
        totalMoviles: moviles,
        // La MISMA regla que la agrupación (`origenDelPar`): clasifica el tramo que
        // LLEVA EL IMPORTE. Antes esto contagiaba desde cualquier tramo de la línea
        // —que son los 26 días, no el par de un día—, así que un solo retorno marcado
        // rotulaba "SERVICIO ADICIONAL" el renglón entero mientras `tipo` seguía
        // diciendo "servicio" y el importe sumaba bajo Servicios del periodo. Crear y
        // recalcular daban dos textos distintos para la misma línea.
        origen: origenDeTramos(filas, lado),
      });
      if (descripcion === l.descripcion) continue;

      const campos: any = { descripcion, pax_contratado: pax };
      let { error } = await sb.from(t.linea).update(campos).eq("id", l.id);
      if (error && /pax_contratado/i.test(String(error.message))) {
        delete campos.pax_contratado;   // falta la migración liquidaciones-03
        ({ error } = await sb.from(t.linea).update(campos).eq("id", l.id));
      }
      if (error) throw new Error(error.message);
      actualizadas += 1;
    }

    await registrarEvento(sb, lado, id, "descripciones_recalculadas", {
      detalle:
        `${actualizadas} de ${lineas.length} línea(s) reescrita(s)` +
        (sinPax ? ` · ${sinPax} sin capacidad contratada: salen sin el "N PAX"` : ""),
      usuario: opts?.usuario ?? undefined,
    });
    return { ok: true, actualizadas, sinPax };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── Corregir los PAX contratados desde el editor de la liquidación ──────────

/**
 * Cuántos servicios hay detrás de una línea. Lo pide la pantalla ANTES de vaciar el pax:
 * "vas a borrar la capacidad contratada de 52 servicios" es una advertencia; "vas a
 * borrarla" no lo es, y la diferencia entre corregir un número y borrar el snapshot
 * contractual de un periodo entero se juega justo ahí.
 */
export async function contarServiciosDeLinea(
  sb: any, lado: Lado, lineaId: number
): Promise<number> {
  try {
    const { data } = await sb.from(T[lado].puente).select("reserva_id").eq("linea_id", lineaId);
    return new Set(((data as any[]) ?? []).map((p) => Number(p.reserva_id))).size;
  } catch {
    return 0;
  }
}

/**
 * Escribe los asientos CONTRATADOS de una línea del documento.
 *
 * Y los escribe donde son verdad: en `reservas.capacidad_contratada` de los servicios
 * que hay detrás de esa línea, no solo en el renglón. La misma regla de oro que aplica
 * `ModalServicios` con el precio — **una fila autoritativa, el resto se DERIVA**. Si se
 * guardara únicamente en `liquidacion_*_linea.pax_contratado`:
 *
 *   · «↻ Recalcular descripciones» lo borraría, porque reconstruye el texto desde la
 *     cascada y la cascada no sabe nada de ese renglón (el escalón "línea editada" solo
 *     se consulta al reconstruir un documento ya emitido);
 *   · Programación seguiría mostrando el número viejo, o ninguno;
 *   · y ni "↻ Recalcular" ni reabrir el documento lo recuperarían, porque nada cambió
 *     en los servicios.
 *
 * Con la fila autoritativa escrita, recalcular es idempotente: la cascada vuelve a leer
 * el mismo número por el escalón 2. Por eso al final se rehace SOLO el texto de esta
 * línea, que lleva el «N PAX» adentro.
 *
 * Lo que esto NO hace, y la pantalla tiene que decirlo: arreglar los meses siguientes.
 * Se escriben los servicios de ESTE periodo —los del puente de esta línea—; los de
 * septiembre son otras filas y nacen del ítem de la cotización. El único escalón que
 * sirve para siempre es la ficha de `cliente_ruta`, y se escribe desde Rutas contratadas.
 * Tampoco se la escribe de acá: sería propagar el dato a una segunda tabla —el catálogo
 * de TODO el cliente— como efecto colateral de corregir un renglón de un mes.
 *
 * `pax` en null borra el dato ("no lo sé"), que NO es lo mismo que cero: el CHECK de la
 * base rechaza el cero justamente por eso.
 *
 * Solo sobre borradores: en un documento emitido el importe y el texto ya los vio el
 * cliente. El camino escrito es reabrirlo.
 */
export async function actualizarPaxContratado(
  sb: any,
  lado: Lado,
  lineaId: number,
  pax: number | null,
  opts?: { usuario?: string | null }
): Promise<{
  ok: boolean;
  /** Servicios REALMENTE escritos. 0 = la columna no existe y no se escribió nada. */
  reservas?: number;
  /** false = no se pudo releer el renglón, así que no se afirma nada sobre el ítem. */
  paxLeido?: boolean;
  /** Descripciones realmente reescritas (0 = el texto no cambió). */
  descripciones?: number;
  /** Con qué PAX queda imprimiéndose el ítem, ya resuelto por la cascada. */
  paxResultante?: number | null;
  aviso?: string;
  error?: string;
}> {
  try {
    const t = T[lado];
    const limpio = pax != null && Number(pax) > 0 ? Math.round(Number(pax)) : null;

    const { data: linea } = await sb
      .from(t.linea).select("id,liquidacion_id,descripcion").eq("id", lineaId).maybeSingle();
    if (!linea) throw new Error("La línea no existe.");

    const { data: cab } = await sb
      .from(t.cab).select("id,estado").eq("id", linea.liquidacion_id).maybeSingle();
    if (!cab) throw new Error("La liquidación no existe.");
    if (cab.estado !== "borrador")
      throw new Error("Solo se corrige sobre un borrador: este documento ya salió de la casa. Reábrelo primero.");

    const { data: puente } = await sb
      .from(t.puente).select("reserva_id").eq("linea_id", lineaId);
    const ids = [...new Set(((puente as any[]) ?? []).map((p) => Number(p.reserva_id)))];
    if (!ids.length)
      throw new Error("Esta línea no tiene servicios detrás: no hay dónde escribir la capacidad contratada.");

    // Lo que decían ANTES, para la bitácora. Vaciar la capacidad de 52 servicios sin
    // dejar rastro del número anterior es irreversible, y el evento solo guardaba el
    // valor nuevo. No es crítico (si la columna no existe se sigue igual), pero es la
    // única forma de reconstruir un borrado hecho por error.
    let antes: (number | null)[] = [];
    const prev = await sb.from("reservas").select("capacidad_contratada").in("id", ids);
    if (!prev.error)
      antes = [...new Set(((prev.data as any[]) ?? []).map((x) => x.capacidad_contratada ?? null))];

    // Por la ÚNICA puerta de escritura de reservas, igual que Programación: trae de
    // regalo el reintento sin la columna cuando falta la migración liquidaciones-03, el
    // troceo en lotes y el "cuál falló" fila por fila. Sin `cambio`: no dispara actas
    // (el trigger solo mira costo, precio, empresa y unidad) y un motivo pegado en esas
    // filas contaminaría el acta del próximo cambio de dinero.
    const res = await guardarReservas(sb, ids, { capacidad_contratada: limpio });
    if (!res.ok)
      throw new Error(`${res.rechazos.length} servicio(s) no aceptaron la capacidad: `
                    + (res.rechazos[0]?.motivo ?? "error desconocido"));

    // El renglón se rehace desde la cascada, que ahora lee lo recién escrito. Se pide
    // solo esta línea para no pisar las descripciones ajustadas a mano en las otras.
    const rd = await recalcularDescripciones(sb, lado, Number(linea.liquidacion_id), {
      usuario: opts?.usuario, lineas: [Number(lineaId)],
    });
    if (!rd.ok) throw new Error(rd.error);

    // Con qué número queda el ítem DE VERDAD, que no siempre es el que se escribió:
    // borrar la capacidad de los servicios no deja el ítem sin PAX si la cotización o la
    // ficha de la ruta lo siguen sabiendo — la cascada sigue de largo hasta el escalón 3.
    // Devolverlo es lo que permite que la pantalla diga lo que pasó en vez de suponerlo.
    // `paxLeido` separa "quedó sin dato" de "no se pudo leer": sin la migración
    // liquidaciones-03 la columna del renglón tampoco existe y este select siempre
    // falla, y confundir las dos cosas hacía que la pantalla afirmara que el ítem queda
    // sin «N PAX» —cuando puede seguir imprimiendo el suyo— y mandara al operador a una
    // pantalla que esa misma migración que falta es la que respalda.
    let paxResultante: number | null | undefined;
    const rl = await sb.from(t.linea).select("pax_contratado").eq("id", lineaId).maybeSingle();
    const paxLeido = !rl.error;
    if (paxLeido) paxResultante = rl.data?.pax_contratado ?? null;

    await registrarEvento(sb, lado, Number(linea.liquidacion_id), "pax_contratado_corregido", {
      detalle: `Ítem #${lineaId}: ${limpio ?? "sin dato"} PAX contratados, escritos en ${ids.length} `
             + `servicio(s) (antes: ${antes.map((v) => v ?? "sin dato").join(", ") || "—"}). `
             + `El ítem queda con ${paxLeido ? (paxResultante ?? "sin dato") : "…no se pudo releer el renglón"}.`,
      usuario: opts?.usuario ?? undefined,
    });
    return {
      // Lo REALMENTE escrito, no los candidatos: `guardarReservas` suelta la columna
      // cuando la migración no corrió, y ahí no se escribió ninguna fila.
      ok: true, reservas: res.guardados.length, descripciones: rd.actualizadas ?? 0,
      paxLeido, paxResultante, aviso: res.aviso,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── Volver a derivar los importes de un borrador ────────────────────────────

/**
 * Columnas que necesita `analizarServicios` para rehacer los pares de UNA línea.
 *
 * A propósito NO se piden `liquidacion_cliente_id` ni `liquidacion_proveedor_id`: estas
 * reservas están, por definición, dentro de esta misma liquidación, y `bloqueosDe` trata
 * ese FK como "ya está en otra liquidación". Pidiéndolas, el análisis bloquearía las
 * filas y la línea quedaría en cero servicios. `empresa_tercerizada_id` sí va, porque sin
 * ella el lado proveedor bloquearía todo por "Sin empresa tercerizada".
 */
const COLS_RESINCRONIZAR =
  "id,codigo,fecha_servicio,hora_servicio,estado,cliente_id,ruta_nombre,direccion_servicio," +
  "origen,destino,reserva_vinculada_id,precio_cliente,costo_proveedor," +
  "empresa_tercerizada_id,tipo_asignacion";

export type ResultadoResincronizacion = {
  ok: boolean;
  /** Líneas que se volvieron a derivar. */
  lineas?: number;
  /** De ésas, cuántas cambiaron de importe o de cantidad. */
  cambiadas?: number;
  /** Líneas cuya cantidad está fijada a mano con motivo: se respetó. */
  cantidadFijada?: number;
  /** Líneas cuyos servicios ya no tienen un mismo precio: se tomó el más repetido. */
  preciosDispares?: number;
  error?: string;
};

/**
 * Vuelve a DERIVAR los importes de un borrador desde sus reservas.
 *
 * Es la mitad que faltaba para poder corregir un precio desde Liquidaciones. La regla de
 * oro dice que el monto autoritativo es UNO —aquí, `reservas.precio_cliente`— y que el
 * resto lo referencia y lo deriva; pero la línea del documento es un SNAPSHOT tomado al
 * cerrar el periodo. Sin esta función, arreglar el precio en la reserva dejaba el
 * documento diciendo el número viejo, que es justo la divergencia que la regla existe
 * para impedir.
 *
 * Solo sobre BORRADORES: un documento emitido ya lo vio el cliente, y cambiarle el
 * importe por detrás es exactamente lo que no puede pasar. Para eso está "↩ Reabrir".
 *
 * Cada línea se rehace con SUS PROPIAS reservas (las del puente), nunca re-agrupando el
 * periodo: el documento conserva los mismos renglones y el mismo Anexo 1, y solo cambian
 * los números que las reservas ahora dicen. Dos cosas que NO se tocan:
 *
 *   · `cantidad_programada` — el puente solo guarda los tramos ejecutados, así que desde
 *     aquí no se puede saber cuántos había programados. Reescribirla con lo que se ve
 *     sería inventar un "26/26" donde hubo 26 programados y 25 prestados.
 *   · `cantidad` cuando lleva `cantidad_motivo` — alguien la fijó a mano y dejó escrito
 *     por qué. Pisarla borraría esa decisión sin decirlo.
 */
export async function resincronizarImportes(
  sb: any,
  lado: Lado,
  id: number,
  opts?: { usuario?: string | null }
): Promise<ResultadoResincronizacion> {
  try {
    const t = T[lado];
    const { data: cab } = await sb.from(t.cab).select("*").eq("id", id).maybeSingle();
    if (!cab) throw new Error("La liquidación no existe.");
    if (cab.estado !== "borrador")
      throw new Error(
        `${cab.codigo ?? "#" + id} está en estado "${cab.estado}": los importes de un documento emitido no se tocan por detrás. Reábrelo como borrador primero.`
      );

    const { data: lineasRaw } = await sb
      .from(t.linea)
      .select("id,item,tipo,descripcion,agrupacion_clave,cantidad,cantidad_ejecutada,cantidad_motivo,precio_unitario")
      .eq("liquidacion_id", id)
      .order("item");
    // Mismo discriminante que `recalcularDescripciones`: `agrupacion_clave` es lo que
    // dice "esta línea tiene reservas detrás". Una adicional escrita a mano en el editor
    // no las tiene y no se deriva de nada.
    const lineas = ((lineasRaw as any[]) ?? []).filter((l) => !!l.agrupacion_clave);
    if (!lineas.length) return { ok: true, lineas: 0, cambiadas: 0 };

    const lineaIds = lineas.map((l) => Number(l.id));
    const puente: any[] = [];
    for (let i = 0; i < lineaIds.length; i += 100) {
      const { data } = await sb.from(t.puente).select("linea_id,reserva_id").in("linea_id", lineaIds.slice(i, i + 100));
      puente.push(...((data as any[]) ?? []));
    }
    const reservaIds = [...new Set(puente.map((p) => Number(p.reserva_id)))];
    const reservas: any[] = [];
    for (let i = 0; i < reservaIds.length; i += 300) {
      const { data } = await sb.from("reservas").select(COLS_RESINCRONIZAR).in("id", reservaIds.slice(i, i + 300));
      reservas.push(...((data as any[]) ?? []));
    }
    const porId = new Map<number, ReservaLiq>(reservas.map((r) => [Number(r.id), r as ReservaLiq]));

    const opcionesPrecio = {
      preciosIncluyenIgv: !!cab.precios_incluyen_igv,
      igvPct: Number(cab.igv_pct ?? 18),
    };

    let cambiadas = 0;
    let cantidadFijada = 0;
    let preciosDispares = 0;

    for (const l of lineas) {
      const filas = puente
        .filter((p) => Number(p.linea_id) === Number(l.id))
        .map((p) => porId.get(Number(p.reserva_id)))
        .filter(Boolean) as ReservaLiq[];
      if (!filas.length) continue;

      const pares = analizarServicios(filas, lado).pares;
      const ejecutados = pares.filter((p) => p.ejecutado);
      // Sin ningún par valorizable (alguien puso los dos tramos en 0) no se escribe: una
      // línea que se pone sola en S/ 0.00 es una fuga silenciosa. Se deja como está y el
      // bloque rojo del cierre ya reclama el precio que falta.
      if (!ejecutados.length) continue;

      // Todos los servicios de una línea comparten tarifa —es parte de la clave de
      // agrupación—, así que normalmente hay un solo precio. Si ya no lo comparten es
      // que alguien cambió unos y no otros: se toma el más repetido y se DICE.
      const cuenta = new Map<number, number>();
      for (const p of ejecutados) {
        const v = precioUnitario(p.cabeza, lado, opcionesPrecio);
        cuenta.set(v, (cuenta.get(v) ?? 0) + 1);
      }
      if (cuenta.size > 1) preciosDispares += 1;
      const precio = [...cuenta].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];

      const ejecutada = ejecutados.length;
      const fijada = !!String(l.cantidad_motivo ?? "").trim();
      if (fijada) cantidadFijada += 1;
      const cantidad = fijada ? Number(l.cantidad ?? 0) : ejecutada;

      const igual =
        Number(l.precio_unitario ?? 0) === precio &&
        Number(l.cantidad_ejecutada ?? 0) === ejecutada &&
        Number(l.cantidad ?? 0) === cantidad;
      if (igual) continue;

      const { error } = await sb.from(t.linea).update({
        precio_unitario: precio,
        cantidad_ejecutada: ejecutada,
        cantidad,
        total_linea: redondear(cantidad * precio),
      }).eq("id", l.id);
      if (error) throw new Error(`línea ${l.item ?? l.id}: ${error.message}`);
      cambiadas += 1;
    }

    if (cambiadas) {
      await recalcularTotales(sb, lado, id);
      await registrarEvento(sb, lado, id, "importes_resincronizados", {
        detalle:
          `${cambiadas} de ${lineas.length} línea(s) vueltas a derivar de sus servicios` +
          (cantidadFijada ? ` · ${cantidadFijada} con cantidad fijada a mano: respetada` : "") +
          (preciosDispares ? ` · ${preciosDispares} con precios distintos entre sus servicios` : ""),
        usuario: opts?.usuario ?? undefined,
      });
    }

    return { ok: true, lineas: lineas.length, cambiadas, cantidadFijada, preciosDispares };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── Edición de líneas ───────────────────────────────────────────────────────

/**
 * Cambia la cantidad a cobrar de una línea. Si difiere de la ejecutada exige motivo:
 * es la única forma de que meses después se sepa por qué se cobraron 25 de 26.
 */
export async function actualizarCantidad(
  sb: any,
  lado: Lado,
  lineaId: number,
  cantidad: number,
  opts: { motivo?: string | null; usuario?: string | null }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const t = T[lado];
    const { data: linea } = await sb.from(t.linea)
      .select("id,liquidacion_id,cantidad_ejecutada,precio_unitario,tipo").eq("id", lineaId).maybeSingle();
    if (!linea) throw new Error("La línea no existe.");

    const difiere = linea.cantidad_ejecutada != null && Number(linea.cantidad_ejecutada) !== Number(cantidad);
    if (difiere && !opts.motivo?.trim())
      throw new Error("Indica el motivo: la cantidad no coincide con los servicios ejecutados.");

    const { error } = await sb.from(t.linea).update({
      cantidad,
      total_linea: redondear(cantidad * Number(linea.precio_unitario ?? 0)),
      cantidad_motivo: difiere ? (opts.motivo ?? null) : null,
      cantidad_editada_por: difiere ? (opts.usuario ?? null) : null,
      cantidad_editada_at: difiere ? ahora() : null,
    }).eq("id", lineaId);
    if (error) throw new Error(error.message);

    await recalcularTotales(sb, lado, Number(linea.liquidacion_id));
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Agrega una línea manual: adicional autorizado, penalidad o descuento. */
export async function agregarLineaManual(
  sb: any,
  lado: Lado,
  liquidacionId: number,
  linea: { tipo: "adicional" | "penalidad" | "descuento"; descripcion: string; cantidad: number; precio_unitario: number; detalle?: string | null }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const t = T[lado];
    const { data: max } = await sb.from(t.linea)
      .select("item").eq("liquidacion_id", liquidacionId).order("item", { ascending: false }).limit(1);
    const item = Number((max as any[])?.[0]?.item ?? 0) + 1;
    const bruto = redondear(linea.cantidad * linea.precio_unitario);
    const { error } = await sb.from(t.linea).insert({
      liquidacion_id: liquidacionId,
      item, tipo: linea.tipo,
      descripcion: linea.descripcion,
      unidad_medida: "SERV.",
      cantidad: linea.cantidad,
      precio_unitario: linea.precio_unitario,
      total_linea: linea.tipo === "adicional" ? bruto : -bruto,
      referencia: linea.detalle ?? null,
    });
    if (error) throw new Error(error.message);
    await recalcularTotales(sb, lado, liquidacionId);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function eliminarLinea(sb: any, lado: Lado, lineaId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const t = T[lado];
    const { data: linea } = await sb.from(t.linea).select("liquidacion_id,tipo").eq("id", lineaId).maybeSingle();
    if (!linea) throw new Error("La línea no existe.");
    if (linea.tipo === "servicio")
      throw new Error("Una línea de servicios no se borra: ajusta su cantidad o quita los servicios del periodo.");
    // Un ADICIONAL puede ser de dos clases y solo una es borrable: la escrita a mano en
    // el editor. La que salió de la agrupación tiene reservas reclamadas detrás, y
    // borrar la línea las dejaría marcadas como liquidadas sin nada que las cobre —
    // servicios prestados que no vuelven a aparecer en ningún cierre.
    const { count } = await sb.from(t.puente)
      .select("reserva_id", { count: "exact", head: true }).eq("linea_id", lineaId);
    if (Number(count ?? 0) > 0)
      throw new Error(
        `Esta línea tiene ${count} servicio(s) liquidados detrás: no se borra. ` +
        `Quita esos servicios del periodo o anula la liquidación.`
      );
    const { error } = await sb.from(t.linea).delete().eq("id", lineaId);
    if (error) throw new Error(error.message);
    await recalcularTotales(sb, lado, Number(linea.liquidacion_id));
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── Emisión (borrador → emitida) ────────────────────────────────────────────

/**
 * Congela la liquidación y la deja lista para enviar. A partir de aquí el documento
 * ya salió de la casa: cambiar montos exige devolverla a borrador explícitamente.
 */
export async function emitirLiquidacion(
  sb: any,
  lado: Lado,
  id: number,
  usuario?: string
): Promise<{ ok: boolean; token?: string; codigo?: string; error?: string }> {
  try {
    const t = T[lado];
    const { data, error } = await sb.from(t.cab)
      .update({ estado: "emitida" })
      .eq("id", id)
      .eq("estado", "borrador")
      .select("id,codigo,token")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Solo se puede emitir una liquidación en borrador.");
    await registrarEvento(sb, lado, id, "emitida", { usuario });
    return { ok: true, token: data.token, codigo: data.codigo };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Devuelve una liquidación emitida a borrador (aún sin conformidad ni factura). */
export async function volverABorrador(
  sb: any, lado: Lado, id: number, usuario?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const t = T[lado];
    const { data, error } = await sb.from(t.cab)
      .update({ estado: "borrador" })
      .eq("id", id)
      .in("estado", ["emitida", "observada"])
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Solo se puede reabrir una liquidación emitida u observada.");
    await registrarEvento(sb, lado, id, "reabierta", { usuario });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── Conformidad (la registra la API pública con service-role) ───────────────

/** Sello corto y verificable, derivado del código y el token. Determinista. */
export function selloConformidad(codigo: string, token: string): string {
  let h = 0x811c9dc5;
  const s = `${codigo}::${token}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const hex = h.toString(16).toUpperCase().padStart(8, "0");
  const hex2 = Math.imul(h ^ s.length, 0x85ebca6b).toString(16).toUpperCase().slice(-4).padStart(4, "0");
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex2}`;
}

export async function registrarConformidad(
  sb: any,
  lado: Lado,
  token: string,
  datos: { decision: "conforme" | "observada"; por: string; cargo?: string | null; comentario?: string | null; canal: string; ip?: string | null }
): Promise<{ ok: boolean; codigo?: string; error?: string }> {
  try {
    const t = T[lado];
    const { data: cab } = await sb.from(t.cab)
      .select("id,codigo,token,estado,conformidad_estado").eq("token", token).maybeSingle();
    if (!cab) throw new Error("El enlace no corresponde a ninguna liquidación.");
    if (cab.estado === "anulada") throw new Error("Esta liquidación fue anulada.");
    if (cab.conformidad_estado !== "pendiente")
      throw new Error("Esta liquidación ya fue respondida.");
    if (datos.decision === "observada" && !datos.comentario?.trim())
      throw new Error("Para observar el servicio hay que indicar el motivo.");

    const sello = selloConformidad(String(cab.codigo ?? cab.id), token);
    const campos: any = {
      conformidad_estado: datos.decision,
      conformidad_por: datos.por,
      conformidad_at: ahora(),
      conformidad_ip: datos.ip ?? null,
      conformidad_canal: datos.canal,
      conformidad_sello: sello,
      conformidad_comentario: datos.comentario ?? null,
      estado: datos.decision === "conforme" ? "conformada" : "observada",
    };
    if (lado === "cliente") {
      campos.conformidad_cargo = datos.cargo ?? null;
      campos.grado_satisfaccion = datos.decision === "conforme" ? "CONFORME" : "CONFORME CON OBSERVACIONES";
    } else {
      campos.evaluacion = datos.decision === "conforme" ? "CONFORME" : "CONFORME CON OBSERVACIONES";
    }

    // Claim atómico sobre conformidad_estado: dos clics en el correo no registran
    // dos conformidades ni pisan la primera respuesta del cliente.
    const { data, error } = await sb.from(t.cab)
      .update(campos)
      .eq("id", cab.id)
      .eq("conformidad_estado", "pendiente")
      .select("id,codigo")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Esta liquidación ya fue respondida.");

    await registrarEvento(sb, lado, Number(cab.id), datos.decision === "conforme" ? "conformada" : "observada", {
      detalle: `${datos.por}${datos.comentario ? " — " + datos.comentario : ""}`,
      usuario: datos.por, ip: datos.ip ?? undefined,
    });
    return { ok: true, codigo: data.codigo };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Marca que el cliente abrió el enlace (evidencia de entrega). No falla nunca. */
export async function marcarVista(sb: any, lado: Lado, token: string, ip?: string | null): Promise<void> {
  try {
    const t = T[lado];
    const { data } = await sb.from(t.cab).select("id,vista_at").eq("token", token).maybeSingle();
    if (!data || data.vista_at) return;
    await sb.from(t.cab).update({ vista_at: ahora() }).eq("id", data.id);
    await registrarEvento(sb, lado, Number(data.id), "vista", { ip: ip ?? undefined });
  } catch {
    /* sin efecto */
  }
}

// ── Aprobación (dispara la emisión aguas abajo) ─────────────────────────────

/**
 * Aprueba la liquidación al cliente → emite una `factura` con el total consolidado y
 * marca las reservas incluidas como estado_admin='facturada'.
 *
 * El CLAIM ATÓMICO (un único UPDATE condicional) serializa la transición a nivel de
 * fila: solo una de N ejecuciones concurrentes gana y las demás abortan SIN emitir un
 * segundo comprobante. Se marca el estado ANTES de insertar la factura; si el insert
 * falla, la liquidación queda "facturada" sin factura_id — recuperable y, sobre todo,
 * sin dinero duplicado (el lado seguro del error).
 */
export async function aprobarLiquidacionCliente(
  sb: any,
  liquidacionId: number,
  usuario?: string,
  opts?: { exigirConformidad?: boolean }
): Promise<{ ok: boolean; factura_id?: number; error?: string }> {
  try {
    if (opts?.exigirConformidad) {
      const { data: chk } = await sb.from("liquidacion_cliente")
        .select("conformidad_estado").eq("id", liquidacionId).maybeSingle();
      if (chk?.conformidad_estado !== "conforme")
        throw new Error("El cliente todavía no dio conformidad a esta liquidación.");
    }

    const { data: liq, error } = await sb
      .from("liquidacion_cliente")
      .update({ estado: "facturada", aprobada_por: usuario ?? null, fecha_aprobacion: ahora() })
      .eq("id", liquidacionId)
      .in("estado", ["borrador", "emitida", "conformada"])
      .select("id, cliente_id, moneda, subtotal, igv, total, codigo, periodo")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!liq) throw new Error("La liquidación ya fue facturada o no está en un estado facturable.");

    const { data: lineas } = await sb
      .from("liquidacion_cliente_linea")
      .select("id, descripcion, cantidad, precio_unitario, total_linea, tipo")
      .eq("liquidacion_id", liquidacionId)
      .order("item");
    const filas = ((lineas as any[]) ?? []);

    // Las reservas cubiertas salen del puente (una consulta por lote de líneas).
    const ids = filas.map((l) => l.id);
    const reservaIds: number[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const { data: p } = await sb.from("liquidacion_cliente_linea_reserva")
        .select("reserva_id").in("linea_id", ids.slice(i, i + 100));
      reservaIds.push(...((p as any[]) ?? []).map((x) => Number(x.reserva_id)));
    }

    // items_json espejo del formato que ya usa app/facturacion.
    const itemsJson = filas.map((l) => ({
      descripcion: l.descripcion,
      cantidad: Number(l.cantidad ?? 0),
      precio_unit: Number(l.precio_unitario ?? 0),
      total: Number(l.total_linea ?? 0),
    }));

    const { data: fac, error: eFac } = await sb
      .from("facturas")
      .insert({
        cliente_id: liq.cliente_id,
        reserva_id: reservaIds.length === 1 ? reservaIds[0] : null, // consolidada: sin reserva única
        tipo_comprobante: "factura",
        fecha_emision: hoyLima(),
        moneda: liq.moneda ?? "PEN",
        subtotal: Number(liq.subtotal ?? 0),
        igv: Number(liq.igv ?? 0),
        total: Number(liq.total ?? 0),
        estado: "emitida",
        items_json: itemsJson,
        observaciones: `Liquidación ${liq.codigo ?? "#" + liquidacionId} · ${liq.periodo ?? ""}`.trim(),
      })
      .select("id")
      .single();
    if (eFac) throw new Error(`facturas: ${eFac.message}`);
    const facturaId = Number((fac as any).id);

    await sb.from("liquidacion_cliente").update({ factura_id: facturaId }).eq("id", liquidacionId);

    if (reservaIds.length) {
      for (let i = 0; i < reservaIds.length; i += 300) {
        await sb.from("reservas")
          .update({ estado_admin: "facturada", fecha_facturacion: ahora() })
          .in("id", reservaIds.slice(i, i + 300));
      }
    }

    await registrarEvento(sb, "cliente", liquidacionId, "facturada", {
      detalle: `factura #${facturaId} · ${reservaIds.length} servicio(s)`, usuario,
    });
    return { ok: true, factura_id: facturaId };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * Ancla cada línea de la CxP al SERVICIO que la originó (documentos_compra_detalle.
 * reserva_id).
 *
 * Sin esto, `costo_facturado_tercero` de v_costo_servicio vale 0 SIEMPRE: la vista
 * hace el join por `dd.reserva_id` desde finanzas-06, pero hasta ahora ningún código
 * del repo escribía esa columna — el único insert sobre la tabla
 * (lib/contabilidad/factura-ia.ts:242) solo llena `combustible_id`. Resultado: todo
 * servicio tercerizado aparecía con 100 % de margen, y "pactado vs. facturado" no se
 * podía comparar porque el facturado era siempre cero.
 *
 * El importe de la línea se reparte entre las reservas que cubre en proporción a su
 * costo pactado. Eso resuelve solo el caso normal del par IDA+RETORNO: la tarifa va
 * en la ida y el retorno está incluido en S/ 0.00, así que la ida se lleva todo. Si
 * ninguna tiene costo, se reparte en partes iguales para no perder el importe. La
 * suma de los detalles siempre es el total de la línea.
 *
 * Es best-effort: si falla, la liquidación ya está aprobada y no se revierte por esto.
 */
async function anclarDetalleAServicios(sb: any, docId: number, lineaIds: number[]): Promise<void> {
  if (!lineaIds.length) return;

  const { data: lineas } = await sb
    .from("liquidacion_proveedor_linea")
    .select("id,descripcion,total_linea")
    .in("id", lineaIds);

  const puentes: any[] = [];
  for (let i = 0; i < lineaIds.length; i += 100) {
    const { data } = await sb
      .from("liquidacion_proveedor_linea_reserva")
      .select("linea_id,reserva_id")
      .in("linea_id", lineaIds.slice(i, i + 100));
    puentes.push(...((data as any[]) ?? []));
  }
  if (!puentes.length) return;

  const reservaIds = [...new Set(puentes.map((p) => Number(p.reserva_id)))];
  const costos = new Map<number, number>();
  for (let i = 0; i < reservaIds.length; i += 300) {
    const { data } = await sb
      .from("reservas")
      .select("id,costo_proveedor")
      .in("id", reservaIds.slice(i, i + 300));
    for (const r of ((data as any[]) ?? [])) costos.set(Number(r.id), Number(r.costo_proveedor ?? 0));
  }

  const filas: any[] = [];
  for (const l of ((lineas as any[]) ?? [])) {
    const deLaLinea = puentes.filter((p) => Number(p.linea_id) === Number(l.id));
    if (!deLaLinea.length) continue;

    const total = redondear(Number(l.total_linea ?? 0));
    const pesos = deLaLinea.map((p) => costos.get(Number(p.reserva_id)) ?? 0);
    const suma = pesos.reduce((a, b) => a + b, 0);

    let asignado = 0;
    deLaLinea.forEach((p, i) => {
      // El último se lleva el remanente: así la suma cuadra exacta con la línea aunque
      // el reparto tenga decimales que no cierran.
      const monto = i === deLaLinea.length - 1
        ? redondear(total - asignado)
        : redondear(suma > 0 ? (total * pesos[i]) / suma : total / deLaLinea.length);
      asignado = redondear(asignado + monto);
      filas.push({
        documento_compra_id: docId,
        descripcion: l.descripcion ?? "Servicio tercerizado",
        cantidad: 1,
        unidad: "SERV.",
        precio_unitario: monto,
        subtotal: monto,
        reserva_id: Number(p.reserva_id),
      });
    });
  }

  for (let i = 0; i < filas.length; i += 200) {
    await sb.from("documentos_compra_detalle").insert(filas.slice(i, i + 200));
  }
}

/**
 * Aprueba la liquidación al proveedor → genera la Cuenta por Pagar y avanza la
 * dimensión C. Si el módulo de compras (documentos_compra) todavía no está corrido,
 * la liquidación igual queda "por_pagar" y se avisa: el cierre operativo no se
 * bloquea por una tabla contable que aún no existe.
 */
export async function aprobarLiquidacionProveedor(
  sb: any,
  liquidacionId: number,
  usuario?: string
): Promise<{ ok: boolean; documento_compra_id?: number; aviso?: string; error?: string }> {
  try {
    const { data: liq, error } = await sb
      .from("liquidacion_proveedor")
      .update({ estado: "por_pagar", aprobada_por: usuario ?? null, fecha_aprobacion: ahora() })
      .eq("id", liquidacionId)
      .in("estado", ["borrador", "emitida", "conformada"])
      .select("id, empresa_tercerizada_id, proveedor_id, moneda, subtotal, igv, detraccion_pct, detraccion_monto, total_comprobante, codigo")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!liq) throw new Error("La liquidación ya fue aprobada o no está en un estado aprobable.");

    const { data: lineas } = await sb.from("liquidacion_proveedor_linea")
      .select("id").eq("liquidacion_id", liquidacionId);
    const ids = ((lineas as any[]) ?? []).map((l) => l.id);
    const reservaIds: number[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const { data: p } = await sb.from("liquidacion_proveedor_linea_reserva")
        .select("reserva_id").in("linea_id", ids.slice(i, i + 100));
      reservaIds.push(...((p as any[]) ?? []).map((x) => Number(x.reserva_id)));
    }

    let docId: number | undefined;
    let aviso: string | undefined;
    try {
      const { data: doc, error: eDoc } = await sb
        .from("documentos_compra")
        .insert({
          proveedor_id: liq.proveedor_id ?? null,
          tipo_comprobante: "liquidacion",
          categoria: "tercero",
          moneda: liq.moneda ?? "PEN",
          subtotal: Number(liq.subtotal ?? 0),
          igv: Number(liq.igv ?? 0),
          detraccion_pct: liq.detraccion_pct,
          detraccion_monto: Number(liq.detraccion_monto ?? 0),
          // El total del comprobante es el BRUTO (subtotal + IGV), NO el neto a pagar:
          // así el asiento cuadra y el Registro de Compras no queda subvaluado. La
          // detracción y los anticipos se manejan como mecanismos de PAGO.
          total: Number(liq.total_comprobante ?? 0),
          estado_conciliacion: "pendiente",
          origen: "liquidacion",
          liquidacion_proveedor_id: liquidacionId,
          empresa_tercerizada_id: liq.empresa_tercerizada_id,
          observaciones: `Cuenta por pagar de la liquidación ${liq.codigo ?? "#" + liquidacionId}`,
        })
        .select("id")
        .single();
      if (eDoc) throw new Error(eDoc.message);
      docId = Number((doc as any).id);
      await sb.from("liquidacion_proveedor").update({ documento_compra_id: docId }).eq("id", liquidacionId);
    } catch (e: any) {
      aviso = "La liquidación quedó aprobada, pero no se generó la cuenta por pagar: falta correr el módulo de compras (supabase/finanzas-02).";
    }

    // El anclaje al servicio va en su PROPIO try: si falla, la CxP igual quedó bien
    // creada y decir "no se generó la cuenta por pagar" sería falso. Lo único que se
    // pierde es el cruce pactado ↔ facturado, que se puede rehacer después.
    if (docId) {
      try {
        await anclarDetalleAServicios(sb, docId, ids);
      } catch {
        aviso = "La cuenta por pagar se creó, pero no se pudo enlazar con los servicios: "
              + "el costo facturado no aparecerá en el margen por servicio.";
      }
    }

    if (reservaIds.length) {
      for (let i = 0; i < reservaIds.length; i += 300) {
        await sb.from("reservas")
          .update({ estado_proveedor: "por_pagar" })
          .in("id", reservaIds.slice(i, i + 300));
      }
    }

    await registrarEvento(sb, "proveedor", liquidacionId, "aprobada", {
      detalle: docId ? `CxP #${docId}` : (aviso ?? ""), usuario,
    });
    return { ok: true, documento_compra_id: docId, aviso };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

// ── Anulación ───────────────────────────────────────────────────────────────

/**
 * Anula una liquidación y DEVUELVE sus servicios al pool de por liquidar. No se
 * permite si ya generó comprobante: para eso está la nota de crédito, no el borrado.
 */
/**
 * Devuelve al pool los servicios que una liquidación tenía reclamados.
 *
 * Vive aparte de `anularLiquidacion` para poder REINTENTARSE. Antes iba embebida y su
 * error se descartaba, así que si el UPDATE fallaba —una columna que falta, RLS, lo que
 * sea— la cabecera quedaba `anulada` y las reservas seguían con su FK apuntando a ella.
 * Como el pool del cierre excluye toda reserva con FK, esos servicios desaparecían del
 * mes ENTERO sin ningún mensaje, y la pantalla decía "✅ Anulada".
 *
 * Devuelve cuántas se liberaron de verdad: sin ese número nadie puede afirmar que
 * volvieron.
 */
export async function liberarServicios(
  sb: any, lado: Lado, id: number
): Promise<{ ok: boolean; liberados?: number; error?: string }> {
  try {
    const t = T[lado];
    const upd: any = { [t.fkReserva]: null, fecha_liquidacion: null };
    upd[t.estadoReserva] = lado === "cliente" ? "por_liquidar" : "por_conciliar";

    let { data, error } = await sb.from("reservas").update(upd).eq(t.fkReserva, id).select("id");
    // `fecha_liquidacion` es accesoria: que falte no puede impedir devolver el servicio.
    if (error && /fecha_liquidacion/i.test(String(error.message))) {
      delete upd.fecha_liquidacion;
      ({ data, error } = await sb.from("reservas").update(upd).eq(t.fkReserva, id).select("id"));
    }
    if (error) throw new Error(error.message);
    return { ok: true, liberados: ((data as any[]) ?? []).length };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export async function anularLiquidacion(
  sb: any, lado: Lado, id: number, motivo: string, usuario?: string
): Promise<{ ok: boolean; liberados?: number; yaEstaba?: boolean; error?: string }> {
  try {
    if (!motivo?.trim()) throw new Error("Indica el motivo de la anulación.");
    const t = T[lado];
    const { data: cab } = await sb.from(t.cab).select("*").eq("id", id).maybeSingle();
    if (!cab) throw new Error("La liquidación no existe.");
    if (lado === "cliente" && cab.factura_id)
      throw new Error("Esta liquidación ya tiene factura: anula el comprobante primero.");
    if (lado === "proveedor" && cab.documento_compra_id)
      throw new Error("Esta liquidación ya generó una cuenta por pagar: anúlala primero.");

    const { data, error } = await sb.from(t.cab)
      .update({ estado: "anulada", observaciones: motivo })
      .eq("id", id)
      .not("estado", "eq", "anulada")
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);

    // Que ya estuviera anulada NO es un error: es la forma natural de reintentar cuando
    // la liberación falló la primera vez. Abortar aquí dejaba el peor estado posible
    // —documento anulado con sus servicios secuestrados— como el único sin salida.
    const yaEstaba = !data;

    const lib = await liberarServicios(sb, lado, id);
    if (!lib.ok)
      throw new Error(
        `La liquidación quedó anulada, pero sus servicios SIGUEN retenidos y no volverán al ` +
        `cierre: ${lib.error}. Vuelve a anularla para reintentar la liberación.`
      );

    // El orden importa y es deliberado: primero se anula el documento y después se
    // sueltan los servicios. Al revés, si la anulación fallara quedarían servicios
    // libres con el documento vivo, y eso es facturar el mismo mes dos veces. Este
    // orden falla del lado recuperable.
    if (!yaEstaba)
      await registrarEvento(sb, lado, id, "anulada", {
        detalle: `${motivo} · ${lib.liberados} servicio(s) devueltos al cierre`, usuario,
      });
    return { ok: true, liberados: lib.liberados, yaEstaba };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
