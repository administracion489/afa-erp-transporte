// ──────────────────────────────────────────────────────────────────────────────
// lib/reservas-autoseleccion-datos.ts — El que LEE para la herencia de «Permitir autoselección».
// La regla vive en lib/reservas-autoseleccion.ts (puro); aquí solo se traen las filas.
// ──────────────────────────────────────────────────────────────────────────────

import { faltaAlguna } from "@/lib/columna-faltante";
import { sentidoDeReserva } from "@/lib/liquidacion-agrupacion";
import type { FilaAnterior } from "@/lib/reservas-autoseleccion";

/**
 * Cuántas filas recientes del contrato se miran (orden descendente: solo hace falta la cabeza). Si
 * en esa ventana no aparece un sentido, ese sentido nace marcado — el lado seguro. No está medido;
 * un mes de un contrato con ida y retorno y tres móviles son ~180 filas.
 */
export const VENTANA_HERENCIA = 500;

const NECESARIAS = ["permite_autoseleccion", "autoseleccion_apagada_en"] as const;
const OPCIONALES = ["movil", "origen_contractual", "direccion_servicio"] as const; // migraciones accesorias

export type LecturaAnteriores =
  | { estado: "ok"; filas: FilaAnterior[] }
  | { estado: "sin_columna"; columna: string }   // sin la migración: todo nace marcado, como antes
  | { estado: "error"; mensaje: string };

/** Los servicios del contrato anteriores a `antesDe`, con el sentido resuelto por `sentidoDeReserva`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function leerAnterioresDelContrato(sb: any, cotizacionId: number, antesDe: string): Promise<LecturaAnteriores> {
  let opcionales: string[] = [...OPCIONALES];
  for (let i = 0; i <= OPCIONALES.length; i++) {
    const cols = ["id", "fecha_servicio", "estado", "ruta_nombre", ...NECESARIAS, ...opcionales].join(",");
    const { data, error } = await sb.from("reservas").select(cols)
      .eq("cotizacion_id", cotizacionId).lt("fecha_servicio", antesDe)
      .order("fecha_servicio", { ascending: false }).order("id", { ascending: false })
      .range(0, VENTANA_HERENCIA - 1);
    if (!error) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const filas: FilaAnterior[] = (data ?? []).map((r: any) => ({
        id: r.id,
        fecha_servicio: String(r.fecha_servicio ?? "").slice(0, 10),
        estado: r.estado ?? null,
        sentido: sentidoDeReserva(r),
        permite_autoseleccion: r.permite_autoseleccion ?? null,
        autoseleccion_apagada_en: r.autoseleccion_apagada_en ?? null,
        movil: r.movil ?? null,
        origen_contractual: r.origen_contractual ?? null,
      }));
      return { estado: "ok", filas };
    }
    const necesaria = faltaAlguna(error, NECESARIAS);
    if (necesaria) return { estado: "sin_columna", columna: necesaria };
    const opcional = faltaAlguna(error, opcionales);
    if (!opcional) return { estado: "error", mensaje: error.message };
    opcionales = opcionales.filter((c) => c !== opcional);
  }
  return { estado: "error", mensaje: "No se pudo leer" };
}
