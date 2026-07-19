// lib/km-servicio.ts — KM real recorrido en un servicio (reserva), desde la huella GPS.
//
// Reúsa las primitivas PURAS de lib/huella.ts (paginarFilas → filasAPuntos → anclarImprecisos
// → limpiarHuella → resumenViaje), que ya corren fuera del DOM/Mapbox. Server-side: recibe un
// cliente Supabase (idealmente service-role para leer terceros sin tropezar con RLS, mismo
// patrón que app/api/cliente/gps).
//
// OJO (subestimación por huecos): kmRecorridos sale de resumenViaje sobre la huella LIMPIA, que
// EXCLUYE saltos > 300 m contándolos como huecos → un GPS con cortes SUBESTIMA el km. `medidoPct`
// es el termómetro (bajo % = poco confiable). Por eso la auditoría de jornada cruza esto con el
// odómetro (check-out − check-in), que es independiente del GPS. Ver [[project_radar_combustible_multifoto]].

import { paginarFilas, filasAPuntos, anclarImprecisos, limpiarHuella, resumenViaje } from "./huella";

export type KmServicio = {
  reserva_id: number;
  kmRecorridos: number;      // km medidos por GPS en la huella limpia
  medidoPct: number;         // 0..100 — % de la ruta realmente medido (bajo = km poco confiable)
  puntos: number;
  horaSalida: number | null; // ms epoch
  horaLlegada: number | null;
};

/** KM recorrido de UNA reserva a partir de sus puntos GPS (ubicaciones_gps.reserva_id). */
export async function kmDeServicio(client: any, reservaId: number): Promise<KmServicio> {
  const vacio: KmServicio = { reserva_id: reservaId, kmRecorridos: 0, medidoPct: 0, puntos: 0, horaSalida: null, horaLlegada: null };
  if (!reservaId) return vacio;

  const filas = await paginarFilas(() =>
    client
      .from("ubicaciones_gps")
      .select("lat,lng,velocidad,precision_m,rumbo,created_at,timestamp")
      .eq("reserva_id", reservaId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
  );
  const crudos = filasAPuntos(filas);
  if (crudos.length < 2) return { ...vacio, puntos: crudos.length };

  const limpia = limpiarHuella(anclarImprecisos(crudos));
  const resumen = resumenViaje(limpia, crudos);
  if (!resumen) return { ...vacio, puntos: crudos.length };

  return {
    reserva_id: reservaId,
    kmRecorridos: Math.round(resumen.kmRecorridos * 10) / 10,
    medidoPct: Math.round(resumen.medidoPct),
    puntos: resumen.puntosTotales,
    horaSalida: resumen.horaSalida || null,
    horaLlegada: resumen.horaLlegada || null,
  };
}

/** Suma de km de servicio ("km operativos" de la jornada) de varias reservas. */
export async function kmOperativosDia(
  client: any,
  reservaIds: number[]
): Promise<{ total: number; porReserva: KmServicio[] }> {
  const porReserva: KmServicio[] = [];
  for (const id of reservaIds) porReserva.push(await kmDeServicio(client, id));
  const total = Math.round(porReserva.reduce((s, r) => s + r.kmRecorridos, 0) * 10) / 10;
  return { total, porReserva };
}
