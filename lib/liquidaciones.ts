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
import { totalesValorizacion, type LineaAgrupada } from "@/lib/liquidacion-agrupacion";

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

      const filasMonto = g.lineas.map((l) => ({
        tipo: "servicio" as const, cantidad: l.cantidad, precio_unitario: l.precio_unitario,
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
        const cantidad = l.cantidad === l.reservas.length ? suyas.length : l.cantidad;
        const { data: lin, error: eL } = await sb.from(t.linea).insert({
          liquidacion_id: id,
          item,
          tipo: "servicio",
          descripcion: l.descripcion,
          unidad_medida: l.unidad_medida,
          cantidad_programada: l.cantidad_programada,
          cantidad_ejecutada: suyas.length,
          cantidad,
          precio_unitario: l.precio_unitario,
          orden_compra: cab.orden_compra ?? null,
          total_linea: redondear(cantidad * l.precio_unitario),
          agrupacion_clave: l.clave,
          referencia: l.referencia,
        }).select("id").single();
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
      await anclarDetalleAServicios(sb, docId, ids);
    } catch (e: any) {
      aviso = "La liquidación quedó aprobada, pero no se generó la cuenta por pagar: falta correr el módulo de compras (supabase/finanzas-02).";
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
export async function anularLiquidacion(
  sb: any, lado: Lado, id: number, motivo: string, usuario?: string
): Promise<{ ok: boolean; error?: string }> {
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
    if (!data) throw new Error("La liquidación ya estaba anulada.");

    // Los servicios vuelven al pool: sin esto quedarían fuera de toda liquidación.
    const upd: any = { [t.fkReserva]: null, fecha_liquidacion: null };
    upd[t.estadoReserva] = lado === "cliente" ? "por_liquidar" : "por_conciliar";
    await sb.from("reservas").update(upd).eq(t.fkReserva, id);

    await registrarEvento(sb, lado, id, "anulada", { detalle: motivo, usuario });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
