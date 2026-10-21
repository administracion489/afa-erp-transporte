// ──────────────────────────────────────────────────────────────────────────────
// lib/confirmacion-reserva-datos.ts — SOLO SERVIDOR. Lee lo que necesita la Confirmación de
// Reserva, emite sus versiones y registra el adelanto. Recibe el cliente de Supabase (el de
// service-role de /api/reservas/confirmacion): la tabla de versiones no tiene política RLS.
//
// LO QUE SE LEE, Y DE DÓNDE (nada se copia):
//  · los tramos del DÍA: la reserva y su hermano ida↔retorno por los DOS sentidos del enlace
//    (`reserva_vinculada_id`), y el de atrás solo si es inequívoco (uno solo) y del mismo cliente;
//  · el cliente, la cotización (moneda, tipo de cambio, IGV, idioma), la unidad y el conductor de
//    cada tramo (propios o de tercero, por su FK) y los cobros de `pagos` con `reserva_id`;
//  · la última versión emitida, para decidir si se reusa o se emite otra (`planVersion`).
// Una lectura que falla LANZA: una confirmación con un dato que no se pudo leer no se emite.
// ──────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { faltaAlguna, tablaFaltante, faltaColumna } from "./columna-faltante";
import { canonico, codigoDocumento, planVersion, type AsignacionConf, type CodigoCambio, type DatosConfirmacion,
  type EntradaConfirmacion, type ExtrasConf, type PagoConf, type TramoConf, type VersionGuardada } from "./confirmacion-reserva";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = any;

export const SQL_CONFIRMACION = "supabase/reservas-08-confirmacion-reserva.sql";

const COLS_TRAMO_BASE = "id, codigo, fecha_servicio, hora_servicio, estado, origen, destino, ruta_nombre, precio_cliente, tipo_servicio_detalle, cliente_id, cotizacion_id, reserva_vinculada_id, tipo_asignacion, vehiculo_id, vehiculo_tercero_id, conductor_id, conductor_tercero_id";
const COLS_TRAMO_ACCESORIAS = ["direccion_servicio", "capacidad_contratada"] as const;

type TramoLeido = TramoConf & { vehiculo_id: number | null; vehiculo_tercero_id: number | null; conductor_id: number | null; conductor_tercero_id: number | null };

/** Un select que suelta SOLO las columnas accesorias que el error nombra. */
async function conAccesorias(hacer: (cols: string) => PromiseLike<{ data: unknown; error: unknown }>, base: string, acc: readonly string[]) {
  let quedan = [...acc];
  for (let i = 0; i <= acc.length; i++) {
    const r = await hacer([base, ...quedan].join(", "));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const col = r.error ? faltaAlguna(r.error as any, quedan) : null;
    if (!col) return r;
    quedan = quedan.filter((c) => c !== col);
  }
  return hacer(base);
}

async function leerTramos(sb: Sb, filtro: (q: Sb) => Sb): Promise<TramoLeido[]> {
  const r = await conAccesorias((cols) => filtro(sb.from("reservas").select(cols)), COLS_TRAMO_BASE, COLS_TRAMO_ACCESORIAS);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (r.error) throw new Error(`No se pudo leer la reserva: ${(r.error as any).message}`);
  return ((r.data as TramoLeido[] | null) ?? []);
}

/** La reserva y su hermano del día (por los dos sentidos del enlace). */
export async function tramosDelDia(sb: Sb, reservaId: number): Promise<TramoLeido[]> {
  const [r] = await leerTramos(sb, (q) => q.eq("id", reservaId).limit(1));
  if (!r) return [];
  let hermano: TramoLeido | null = null;
  if (r.reserva_vinculada_id) {
    [hermano] = await leerTramos(sb, (q) => q.eq("id", r.reserva_vinculada_id).limit(1));
  }
  if (!hermano) {
    const atras = await leerTramos(sb, (q) => q.eq("reserva_vinculada_id", r.id).limit(2));
    if (atras.length === 1) hermano = atras[0];
  }
  if (hermano && hermano.cliente_id !== r.cliente_id) hermano = null;
  return hermano ? [r, hermano] : [r];
}

async function una<T>(sb: Sb, tabla: string, cols: string, id: number | null | undefined): Promise<T | null> {
  if (!id) return null;
  const { data, error } = await sb.from(tabla).select(cols).eq("id", id).maybeSingle();
  if (error) throw new Error(`No se pudo leer ${tabla}: ${error.message}`);
  return (data as T) ?? null;
}

export type LecturaConfirmacion = {
  entrada: EntradaConfirmacion;
  /** La columna `pagos.reserva_id` o la tabla de versiones no existen todavía. */
  sinMigracion: boolean;
};

export async function leerEntrada(sb: Sb, reservaId: number, extras: ExtrasConf | null): Promise<LecturaConfirmacion> {
  const tramos = await tramosDelDia(sb, reservaId);
  const base = tramos[0];
  const cliente = base ? await una<EntradaConfirmacion["cliente"]>(sb, "clientes", "id, nombre, empresa, telefono, operativo_nombre, operativo_celular, condicion_pago", base.cliente_id) : null;
  const cotId = tramos.find((t) => t.cotizacion_id)?.cotizacion_id ?? null;
  let cotizacion: EntradaConfirmacion["cotizacion"] = null;
  if (cotId) {
    const r = await conAccesorias((cols) => sb.from("cotizaciones").select(cols).eq("id", cotId).maybeSingle(),
      "id, numero_cotizacion, atencion, incluye_igv, tipo_servicio, modo_servicio", ["moneda", "tipo_cambio", "idioma_pdf", "traslado_json"]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (r.error) throw new Error(`No se pudo leer la cotización: ${(r.error as any).message}`);
    cotizacion = (r.data as EntradaConfirmacion["cotizacion"]) ?? null;
  }

  const asignaciones: Record<number, AsignacionConf> = {};
  for (const t of tramos) {
    const v = t.vehiculo_tercero_id
      ? await una<{ placa: string; marca: string | null; modelo: string | null; categoria: string | null }>(sb, "vehiculos_tercero", "placa, marca, modelo, categoria", t.vehiculo_tercero_id)
      : await una<{ placa: string; marca: string | null; modelo: string | null; categoria: string | null }>(sb, "vehiculos", "placa, marca, modelo, categoria", t.vehiculo_id);
    const c = t.conductor_tercero_id
      ? await una<{ nombre: string; telefono: string | null }>(sb, "conductores_tercero", "nombre, telefono", t.conductor_tercero_id)
      : await una<{ nombre: string; telefono: string | null }>(sb, "conductores", "nombre, telefono", t.conductor_id);
    asignaciones[t.id] = { vehiculo: v, conductor: c };
  }

  let pagos: PagoConf[] = [];
  let sinMigracion = false;
  if (tramos.length) {
    const { data, error } = await sb.from("pagos").select("id, codigo, fecha, monto, moneda, metodo, anulado, reserva_id")
      .eq("sentido", "cobro").in("reserva_id", tramos.map((t) => t.id));
    if (error && faltaColumna(error, "reserva_id")) sinMigracion = true;
    else if (error) throw new Error(`No se pudieron leer los cobros: ${error.message}`);
    else pagos = (data as PagoConf[]) ?? [];
  }

  return { entrada: { tramos, asignaciones, cliente, cotizacion, pagos, extras }, sinMigracion };
}

// ── Versiones ────────────────────────────────────────────────────────────────

export const firmaDe = (d: DatosConfirmacion) => createHash("sha256").update(canonico(d)).digest("hex");

export type VersionResumen = { id: number; version: number; codigo: string; cambios: CodigoCambio[]; generado_en: string; generado_por_nombre: string | null; datos: DatosConfirmacion };

/** Las versiones del día, de la más nueva a la más vieja. `null` = falta la tabla (sin migración). */
export async function leerVersiones(sb: Sb, idDocumento: number): Promise<VersionResumen[] | null> {
  const { data, error } = await sb.from("reserva_confirmaciones")
    .select("id, version, codigo, cambios, generado_en, generado_por_nombre, datos, firma")
    .eq("reserva_id", idDocumento).order("version", { ascending: false }).limit(50);
  if (error && tablaFaltante(error, "reserva_confirmaciones")) return null;
  if (error) throw new Error(`No se pudo leer el historial de confirmaciones: ${error.message}`);
  return (data as VersionResumen[]) ?? [];
}

export async function leerVersion(sb: Sb, versionId: number): Promise<(VersionResumen & { reserva_id: number }) | null> {
  const { data, error } = await sb.from("reserva_confirmaciones")
    .select("id, reserva_id, version, codigo, cambios, generado_en, generado_por_nombre, datos").eq("id", versionId).maybeSingle();
  if (error) throw new Error(`No se pudo leer la confirmación: ${error.message}`);
  return (data as VersionResumen & { reserva_id: number }) ?? null;
}

/**
 * Emite la versión (o devuelve la vigente si la foto no cambió). Dos clics a la vez no crean dos
 * versiones: el índice único (reserva_id, version) rechaza la segunda y se relee la que ganó.
 */
export async function emitirVersion(sb: Sb, idDocumento: number, datos: DatosConfirmacion, quien: { id: string; nombre: string | null }):
  Promise<{ id: number; version: number; codigo: string; nueva: boolean; cambios: CodigoCambio[] }> {
  const firma = firmaDe(datos);
  for (let intento = 0; intento < 3; intento++) {
    const { data: ult, error: e1 } = await sb.from("reserva_confirmaciones").select("id, version, firma, datos, codigo, cambios")
      .eq("reserva_id", idDocumento).order("version", { ascending: false }).limit(1).maybeSingle();
    if (e1) throw new Error(`No se pudo leer la última confirmación: ${e1.message}`);
    const ultima = (ult as (VersionGuardada & { codigo: string; cambios: CodigoCambio[] }) | null) ?? null;
    const plan = planVersion(ultima, datos, firma);
    if (plan.accion === "reusar") return { id: plan.id, version: plan.version, codigo: ultima!.codigo, nueva: false, cambios: ultima!.cambios ?? [] };
    const codigo = codigoDocumento(datos, plan.version);
    const { data, error } = await sb.from("reserva_confirmaciones").insert({
      reserva_id: idDocumento, version: plan.version, codigo, firma, datos, cambios: plan.cambios,
      generado_por: quien.id, generado_por_nombre: quien.nombre,
    }).select("id").single();
    if (!error) return { id: Number(data.id), version: plan.version, codigo, nueva: true, cambios: plan.cambios };
    if (error.code !== "23505") throw new Error(`No se pudo guardar la confirmación: ${error.message}`);
  }
  throw new Error("Otra persona está emitiendo esta confirmación a la vez: vuelve a intentarlo.");
}

// ── El adelanto ──────────────────────────────────────────────────────────────

export type AdelantoNuevo = { monto: number; moneda: string; fecha: string; metodo: string | null; referencia: string | null };

/**
 * Registra el cobro en `pagos`, SIN aplicar (es un anticipo, finanzas-01). No asienta un
 * movimiento de banco: eso lo hace la conciliación de Tesorería con el extracto, como con
 * cualquier otro cobro.
 */
export async function registrarAdelanto(sb: Sb, reservaId: number, clienteId: number | null, a: AdelantoNuevo, quien: string): Promise<{ id: number; codigo: string | null }> {
  const { data, error } = await sb.from("pagos").insert({
    sentido: "cobro", fecha: a.fecha, monto: a.monto, moneda: a.moneda, metodo: a.metodo, referencia: a.referencia,
    contraparte_tipo: "cliente", contraparte_id: clienteId,
    reserva_id: reservaId, observaciones: "Adelanto de reserva", creado_por: quien,
  }).select("id, codigo").single();
  if (error) throw new Error(faltaColumna(error, "reserva_id") ? `Falta correr ${SQL_CONFIRMACION}.` : `No se pudo registrar el cobro: ${error.message}`);
  return { id: Number(data.id), codigo: data.codigo ?? null };
}

/**
 * Anula un cobro de esta reserva (soft-delete, como el resto de `pagos`). Uno ya aplicado a una
 * factura NO se anula desde aquí: su saldo lo deriva Finanzas y se corrige allá.
 */
export async function anularAdelanto(sb: Sb, pagoId: number, ids: number[]): Promise<void> {
  const { count, error: e0 } = await sb.from("pagos_aplicacion").select("id", { count: "exact", head: true }).eq("pago_id", pagoId);
  if (e0) throw new Error(`No se pudo comprobar el cobro: ${e0.message}`);
  if ((count ?? 0) > 0) throw new Error("Ese cobro ya está aplicado a un comprobante: se corrige en Finanzas.");
  // Uno ya casado con el banco tampoco: el depósito quedaría conciliado con un cobro anulado.
  const [m, x] = await Promise.all([
    sb.from("movimientos_tesoreria").select("id", { count: "exact", head: true }).eq("pago_id", pagoId).eq("conciliado", true),
    sb.from("extractos_bancarios_movimientos").select("id", { count: "exact", head: true }).eq("pago_id", pagoId).eq("estado_conciliacion", "conciliado"),
  ]);
  if (m.error || x.error) throw new Error(`No se pudo comprobar la conciliación del cobro: ${(m.error ?? x.error).message}`);
  if ((m.count ?? 0) + (x.count ?? 0) > 0) throw new Error("Ese cobro ya está conciliado con el banco: se corrige en Tesorería → Conciliación.");
  const { data, error } = await sb.from("pagos").update({ anulado: true }).eq("id", pagoId).eq("sentido", "cobro")
    .in("reserva_id", ids).eq("anulado", false).select("id");
  if (error) throw new Error(`No se pudo anular el cobro: ${error.message}`);
  if (!(data as unknown[] | null)?.length) throw new Error("Ese cobro no es de esta reserva o ya estaba anulado.");
}
