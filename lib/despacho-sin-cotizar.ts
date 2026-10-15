// ──────────────────────────────────────────────────────────────────────────────
// lib/despacho-sin-cotizar.ts — Motor PURO: ¿este servicio del Despachador falta cotizarlo?
//
// El chip «⚡ N sin cotizar (Despachador)» de /cotizaciones contaba toda reserva con
// origen_despacho=true y cotizacion_id null, sin mirar el estado: un servicio CANCELADO
// seguía pidiendo cotización, y uno que no la necesita (cortesía, interno) no tenía cómo
// salir de la cuenta. El motivo se DECLARA (cinco códigos) y solo `requiere_cotizacion` cuenta.
// ──────────────────────────────────────────────────────────────────────────────

export type MotivoDespacho = "requiere_cotizacion" | "cancelado" | "no_requiere" | "vinculado" | "no_es_despacho";

export type ReservaDespacho = {
  id: number;
  codigo?: string | null;
  fecha_servicio?: string | null;
  hora_servicio?: string | null;
  cliente_id?: number | null;
  origen?: string | null;
  destino?: string | null;
  ruta_nombre?: string | null;
  estado?: string | null;
  precio_cliente?: number | string | null;
  costo_proveedor?: number | string | null;
  cotizacion_id?: number | null;
  reserva_vinculada_id?: number | null;
  origen_despacho?: boolean | null;
  cotizacion_no_requerida_motivo?: string | null;
  cotizacion_no_requerida_en?: string | null;
};

export const IGV = 0.18;
/** Texto que usa la autodescripción de /cotizaciones para un servicio eventual. */
export const DESCRIPCION_EVENTUAL = "SERVICIO DE TRANSPORTE TURÍSTICO";
export const MIN_MOTIVO_NO_REQUIERE = 5;

/** De la evidencia al juicio; gana el primero. */
export function motivoDespacho(r: ReservaDespacho): MotivoDespacho {
  if (r.origen_despacho !== true) return "no_es_despacho";
  if (r.cotizacion_id != null) return "vinculado";
  if (String(r.estado ?? "").toLowerCase() === "cancelada") return "cancelado";
  if (String(r.cotizacion_no_requerida_motivo ?? "").trim()) return "no_requiere";
  return "requiere_cotizacion";
}

export function pendientesDeCotizar<T extends ReservaDespacho>(rows: T[]): T[] {
  return rows.filter((r) => motivoDespacho(r) === "requiere_cotizacion");
}

const txt = (s: string | null | undefined) => String(s ?? "").trim();

export type ItemPrellenado = { descripcion: string; cantidad: number; precio_unit: number | null };
export type PrellenadoCotizacion = {
  cliente_id: number | null;
  origen: string;
  destino: string;
  fecha_servicio: string;
  hora_ida: string;
  modo_servicio: "eventual";
  tipo_servicio: "solo_ida" | "ida_retorno";
  asunto: string;
  items: ItemPrellenado[];
};

/** "06:30:00" → "06:30"; lo que no es una hora queda vacío (no se inventa). */
function horaHHMM(h: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(txt(h));
  if (!m) return "";
  const hh = Number(m[1]);
  if (hh > 23 || Number(m[2]) > 59) return "";
  return `${String(hh).padStart(2, "0")}:${m[2]}`;
}

/** Precio con IGV → sin IGV, a 2 decimales. Null si no hay precio (> 0). */
export function sinIgv(conIgv: number | string | null | undefined): number | null {
  const n = Number(conIgv);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n / (1 + IGV)) * 100) / 100;
}

/**
 * Campos para el formulario de cotización desde un servicio del Despachador.
 * - `reservas.precio_cliente` es CON IGV (convención del ERP; el despachador lo escribe tal cual
 *   lo teclea el operador), así que el ítem va sin IGV: precio_cliente / 1.18.
 * - tipo_servicio: "ida_retorno" solo si la reserva ya tiene `reserva_vinculada_id` (el dato
 *   escrito de que tiene un tramo hermano). Ojo: en ese caso el precio de la reserva puede ser
 *   el del día entero o solo el de este tramo; se usa tal cual y lo confirma el operador.
 * - Nada se inventa: lo que falta queda vacío (o null). `hoy` solo se usa para no prellenar
 *   una fecha imposible: se respeta la fecha del servicio aunque sea pasada (es el dato).
 */
export function prellenadoCotizacion(r: ReservaDespacho, _hoy: string): PrellenadoCotizacion {
  const origen = txt(r.origen);
  const destino = txt(r.destino);
  const ruta = txt(r.ruta_nombre);
  const asunto = ruta || (origen && destino ? `${origen} → ${destino}` : origen || destino);
  const fecha = /^\d{4}-\d{2}-\d{2}$/.test(txt(r.fecha_servicio)) ? txt(r.fecha_servicio) : "";
  return {
    cliente_id: r.cliente_id ?? null,
    origen,
    destino,
    fecha_servicio: fecha,
    hora_ida: horaHHMM(r.hora_servicio),
    modo_servicio: "eventual",
    tipo_servicio: r.reserva_vinculada_id != null ? "ida_retorno" : "solo_ida",
    asunto,
    items: [{ descripcion: DESCRIPCION_EVENTUAL, cantidad: 1, precio_unit: sinIgv(r.precio_cliente) }],
  };
}

export type CotizacionVinculable = { id: number; cliente_id?: number | null; modo_servicio?: string | null; estado?: string | null };

export function puedeVincular(
  reserva: ReservaDespacho,
  cot: CotizacionVinculable,
): { ok: boolean; motivo: string | null } {
  if (reserva.origen_despacho !== true) return { ok: false, motivo: "El servicio no salió del Despachador." };
  if (String(reserva.estado ?? "").toLowerCase() === "cancelada") return { ok: false, motivo: "El servicio está cancelado: no necesita cotización." };
  if (reserva.cotizacion_id != null) return { ok: false, motivo: "El servicio ya está vinculado a una cotización." };
  if (reserva.cliente_id == null || cot.cliente_id == null || reserva.cliente_id !== cot.cliente_id)
    return { ok: false, motivo: "La cotización es de otro cliente (o le falta el cliente)." };
  if (cot.modo_servicio === "fijo")
    return { ok: false, motivo: "Es un contrato fijo: sus servicios se generan desde Programación, no se vinculan a mano." };
  if (["rechazado", "rechazada"].includes(String(cot.estado ?? "").toLowerCase()))
    return { ok: false, motivo: "La cotización está rechazada." };
  return { ok: true, motivo: null };
}

/** Motivo de «no requiere cotización»: obligatorio, ≥ 5 caracteres tras recortar. */
export function validarMotivoNoRequiere(m: string | null | undefined): { ok: boolean; motivo: string; error: string | null } {
  const t = txt(m);
  if (t.length < MIN_MOTIVO_NO_REQUIERE)
    return { ok: false, motivo: t, error: `Escribe por qué no requiere cotización (mínimo ${MIN_MOTIVO_NO_REQUIERE} caracteres).` };
  return { ok: true, motivo: t, error: null };
}
