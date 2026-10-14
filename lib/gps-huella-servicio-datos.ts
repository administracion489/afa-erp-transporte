// lib/gps-huella-servicio-datos.ts — el que LEE la huella de un servicio (solo servidor).
//
// Las consultas que hacía `/api/cliente/gps` en modo huella, mudadas aquí sin cambiarlas (mismas
// columnas, mismos filtros, mismo orden, mismo paginado) para que el modal GPS y el cálculo de la
// traza ajustada que se guarda (lib/gps-traza-ajustada*.ts) lean POR EL MISMO CAMINO. Las decisiones
// (ventana, rama por vehículo, tramo del servicio, filtro de precisión) son del motor puro
// `lib/gps-huella-servicio.ts`. La matriz (scripts/prueba-traza-ajustada.mts §6) compara esto contra
// el bloque original de la ruta copiado literal, con una base falsa en memoria.
//
// DOS MODOS DE LECTURA, y el defecto es el de siempre:
//   • indulgente (defecto, el de la ruta): `paginarFilas` conserva lo acumulado si una página falla
//     —«huella parcial > vacía» para DIBUJAR— y la lectura de la reserva ignora su error. Byte a byte
//     lo de antes. `completa` dice si algo de eso pasó, para que nadie FIRME ni GUARDE sobre una
//     lectura a medias (tri-estado: un fallo de lectura no es una huella más corta).
//   • estricto (`{ estricto: true }`, el del cálculo que se guarda): cualquier error LANZA. Una traza
//     ajustada sobre media huella, guardada para siempre, sería peor que ninguna.

import { paginarFilas } from "./huella";
import {
  ventanaDelServicio, usaRamaVehiculo, rangoPorVehiculo, filasDelServicio, servicioDeHuella,
  type ServicioHuella,
} from "./gps-huella-servicio";

/* eslint-disable @typescript-eslint/no-explicit-any -- cliente de Supabase y filas crudas de PostgREST */

/** Columnas de la huella: las que el modal recibe (y las únicas que se firman). */
export const HCOLS_HUELLA = "lat,lng,velocidad,rumbo,created_at,timestamp,reserva_id,vehiculo_id,vehiculo_tercero_id,precision_m,fix_ts";
/** Techo de sanidad del paginado (el defecto de `paginarFilas`): llegar a él es una lectura TOPADA. */
export const MAX_FILAS_HUELLA = 35000;

export type ConsultaHuella = { reservaId: number | null; vehiculoId: number | null; vehiculoTerceroId: number | null };

/** Lo que el lector sabe de la reserva (además de lo que usa la ventana, sus dos vehículos). */
export type ReservaHuella = {
  estado: string | null;
  fecha_servicio: string | null;
  hora_servicio: string | null;
  vehiculo_id: number | null;
  vehiculo_tercero_id: number | null;
};

export type HuellaServicio = {
  /** Las filas que se devuelven al modal (norm aparte, en la ruta). */
  filasOk: any[];
  servicio: ServicioHuella;
  /** null sin reservaId, o si la reserva no se encontró / no se pudo leer (ver `completa`). */
  reserva: ReservaHuella | null;
  /** false si alguna consulta devolvió error o el paginado llegó a su techo: la huella puede estar
   *  incompleta y NO sirve para firmar ni guardar. */
  completa: boolean;
};

/** Error de lectura en modo estricto. */
export class LecturaHuellaFallida extends Error {
  constructor(que: string, detalle?: string) {
    super(`No se pudo leer ${que}${detalle ? `: ${detalle}` : ""}`);
    this.name = "LecturaHuellaFallida";
  }
}

/**
 * La huella del servicio, por el mismo camino que /api/cliente/gps (modo huella).
 * `ahora`: el reloj. Un número fija el instante (pruebas, el cálculo); una función se consulta en el
 * MISMO punto donde la ruta llamaba a `Date.now()` —después de leer la reserva, antes de la rama por
 * vehículo—, así que con el defecto la respuesta es byte a byte la de antes.
 */
export async function huellaDelServicio(
  admin: any,
  q: ConsultaHuella,
  ahora: number | (() => number) = Date.now,
  opts?: { estricto?: boolean },
): Promise<HuellaServicio> {
  const estricto = !!opts?.estricto;
  let completa = true;

  // `paginarFilas` sin tocar (mismo tamaño de página, mismo techo, misma tolerancia), observado:
  // se anota si alguna página falló, que es justo lo que `paginarFilas` calla.
  const paginar = async (que: string, armar: () => any): Promise<any[]> => {
    let fallo: any = null;
    const filas = await paginarFilas(() => {
      const consulta = armar();
      return {
        range: (desde: number, hasta: number) =>
          consulta.range(desde, hasta).then((r: any) => { if (r?.error && !fallo) fallo = r.error; return r; }),
      };
    }, MAX_FILAS_HUELLA);
    if (fallo || filas.length >= MAX_FILAS_HUELLA) {
      completa = false;
      if (estricto) throw new LecturaHuellaFallida(que, fallo ? String(fallo?.message ?? fallo) : `más de ${MAX_FILAS_HUELLA} posiciones`);
    }
    return filas;
  };

  const { reservaId, vehiculoId, vehiculoTerceroId } = q;
  let filas: any[] = [];
  let viaVehiculo = false; // ¿se usó la rama por-vehículo (sin reserva_id)?
  // PAGINADO (paginarFilas): PostgREST recorta toda respuesta al max-rows del servidor
  // (1000) aunque se pida .limit(5000) → la huella se congelaba en el punto 1000 y el
  // resto del viaje salía como "tramo estimado". Orden created_at+id = páginas estables.
  if (reservaId != null) {
    filas = await paginar("las posiciones del servicio", () =>
      admin.from("ubicaciones_gps").select(HCOLS_HUELLA)
        .eq("reserva_id", reservaId)
        .order("created_at", { ascending: true }).order("id", { ascending: true }));
  }

  let rsv: ReservaHuella | null = null;
  if (reservaId != null) {
    const r = await admin.from("reservas")
      .select("fecha_servicio,hora_servicio,estado,vehiculo_id,vehiculo_tercero_id")
      .eq("id", reservaId).maybeSingle();
    if (r?.error) {
      completa = false;
      if (estricto) throw new LecturaHuellaFallida("la reserva", String(r.error?.message ?? r.error));
    }
    rsv = r?.data
      ? {
          estado: r.data.estado ?? null,
          fecha_servicio: r.data.fecha_servicio ?? null,
          hora_servicio: r.data.hora_servicio ?? null,
          vehiculo_id: r.data.vehiculo_id ?? null,
          vehiculo_tercero_id: r.data.vehiculo_tercero_id ?? null,
        }
      : null;
  }

  const ahoraMs = typeof ahora === "function" ? ahora() : ahora;
  const v = ventanaDelServicio(rsv, filas.length > 0, ahoraMs);
  if (usaRamaVehiculo(filas.length, vehiculoId, vehiculoTerceroId, v)) {
    const { desde, hasta } = rangoPorVehiculo(v, ahoraMs);
    filas = await paginar("las posiciones de la unidad", () => {
      let qq = admin.from("ubicaciones_gps").select(HCOLS_HUELLA)
        .gte("created_at", desde)
        .order("created_at", { ascending: true }).order("id", { ascending: true });
      if (hasta) qq = qq.lte("created_at", hasta);
      return vehiculoTerceroId != null ? qq.eq("vehiculo_tercero_id", vehiculoTerceroId) : qq.eq("vehiculo_id", vehiculoId);
    });
    viaVehiculo = true;
  }

  const filasOk = filasDelServicio(filas, viaVehiculo, v.progMs);
  return { filasOk, servicio: servicioDeHuella(v, filasOk, viaVehiculo, rsv?.estado), reserva: rsv, completa };
}
