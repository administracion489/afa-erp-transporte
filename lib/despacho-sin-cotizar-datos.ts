// lib/despacho-sin-cotizar-datos.ts — lee y escribe (cliente de Supabase inyectado).
import { faltaAlguna } from "@/lib/columna-faltante";
import { guardarReservas } from "@/lib/reservas-pacto";
import {
  puedeVincular, validarMotivoNoRequiere,
  type ReservaDespacho, type CotizacionVinculable,
} from "@/lib/despacho-sin-cotizar";

const BASE = ["id", "codigo", "fecha_servicio", "hora_servicio", "cliente_id", "origen", "destino", "ruta_nombre",
  "estado", "precio_cliente", "costo_proveedor", "cotizacion_id", "reserva_vinculada_id", "origen_despacho"];
export const ACCESORIAS = ["cotizacion_no_requerida_motivo", "cotizacion_no_requerida_en"] as const;
export const SQL_MIGRACION = "supabase/reservas-07-despacho-sin-cotizar.sql";
const PAGINA = 1000;

/** Todas (paginado, orden total). Lanza si una página falla: una lista cortada contaría de menos. */
export async function leerDespachosSinCotizar(sb: any): Promise<{ filas: ReservaDespacho[]; sinColumnas: string[] }> {
  const sinColumnas: string[] = [];
  for (let intento = 0; intento <= ACCESORIAS.length; intento++) {
    const cols = [...BASE, ...ACCESORIAS.filter((c) => !sinColumnas.includes(c))].join(",");
    const filas: ReservaDespacho[] = [];
    let soltada: string | null = null;
    for (let desde = 0; ; desde += PAGINA) {
      const { data, error } = await sb.from("reservas").select(cols)
        .eq("origen_despacho", true).is("cotizacion_id", null)
        .order("fecha_servicio", { ascending: false }).order("id", { ascending: false })
        .range(desde, desde + PAGINA - 1);
      if (error) {
        const c = faltaAlguna(error, ACCESORIAS.filter((x) => !sinColumnas.includes(x)));
        if (c) { soltada = c; break; }
        throw new Error(`No se pudieron leer los servicios del Despachador sin cotizar: ${error.message ?? error}`);
      }
      filas.push(...((data ?? []) as ReservaDespacho[]));
      if (!data || data.length < PAGINA) break;
    }
    if (!soltada) return { filas, sinColumnas };
    sinColumnas.push(soltada);
  }
  throw new Error("No se pudieron leer los servicios del Despachador sin cotizar.");
}

/** Vincula una reserva del Despachador a una cotización existente. Solo escribe `cotizacion_id`. */
export async function vincularCotizacion(sb: any, reservaId: number, cotId: number): Promise<{ ok: boolean; error: string | null }> {
  const { data: r, error: e1 } = await sb.from("reservas")
    .select("id,cliente_id,cotizacion_id,origen_despacho,estado").eq("id", reservaId).maybeSingle();
  if (e1 || !r) return { ok: false, error: `No se pudo leer el servicio #${reservaId}${e1 ? `: ${e1.message}` : ""}.` };
  const { data: c, error: e2 } = await sb.from("cotizaciones")
    .select("id,cliente_id,modo_servicio,estado").eq("id", cotId).maybeSingle();
  if (e2 || !c) return { ok: false, error: `No se pudo leer la cotización #${cotId}${e2 ? `: ${e2.message}` : ""}.` };
  const v = puedeVincular(r as ReservaDespacho, c as CotizacionVinculable);
  if (!v.ok) return { ok: false, error: v.motivo };
  // Por guardarReservas (la puerta de Programación), sin `cambio`: no es dinero, no levanta acta.
  // Límite declarado: guardarReservas no admite la condición `cotizacion_id is null`; la relectura
  // de arriba la comprueba, y una carrera solo podría re-vincular a otra cotización del MISMO cliente.
  const res = await guardarReservas(sb, [reservaId], { cotizacion_id: cotId });
  if (!res.ok || !res.guardados.includes(reservaId))
    return { ok: false, error: `No se pudo vincular: ${res.rechazos[0]?.motivo ?? "sin respuesta de la base"}.` };
  return { ok: true, error: null };
}

async function escribirAccesorias(sb: any, reservaId: number, patch: Record<string, any>) {
  // Solo servicios del Despachador sin cotización; y un update que no tocó ninguna fila no es "guardado".
  const { data, error } = await sb.from("reservas").update(patch).eq("id", reservaId)
    .eq("origen_despacho", true).is("cotizacion_id", null).select("id");
  if (!error && Array.isArray(data) && data.length > 0) return { ok: true, error: null, sinMigracion: false };
  if (!error) return { ok: false, error: `El servicio #${reservaId} ya no existe, ya tiene cotización o no salió del Despachador.`, sinMigracion: false };
  if (faltaAlguna(error, ACCESORIAS))
    return { ok: false, error: `Falta correr ${SQL_MIGRACION} para poder marcar servicios que no requieren cotización.`, sinMigracion: true };
  return { ok: false, error: `No se pudo guardar en el servicio #${reservaId}: ${error.message ?? error}`, sinMigracion: false };
}

export async function marcarNoRequiere(sb: any, reservaId: number, motivo: string) {
  const v = validarMotivoNoRequiere(motivo);
  if (!v.ok) return { ok: false, error: v.error, sinMigracion: false };
  return escribirAccesorias(sb, reservaId, {
    cotizacion_no_requerida_motivo: v.motivo,
    cotizacion_no_requerida_en: new Date().toISOString(), // instante (timestamptz), no "hoy"
  });
}

export async function quitarNoRequiere(sb: any, reservaId: number) {
  return escribirAccesorias(sb, reservaId, { cotizacion_no_requerida_motivo: null, cotizacion_no_requerida_en: null });
}
