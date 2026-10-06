// lib/mantenimiento/proximo-servicio-datos.ts
// El estado de las OT que nombra el libro de mantenimiento, para `porQueNoAncla`
// (proximo-servicio.ts, que es puro y no lee la base). Lo usan Próximos, el cron de OT automáticas,
// la analítica del vehículo y el Historial: los cuatro tienen que juzgar igual qué fila ancla.
//
// Recibe el cliente inyectado (navegador o service-role). Si la consulta falla devuelve `null`, y
// con `null` el motor NO juzga por OT: una consulta caída no puede convertir todo el libro en
// filas huérfanas y mandar el próximo servicio de cada unidad a la rejilla.

import { otsMencionadas, type EstadosOT, type FilaLibro } from "./proximo-servicio";

export async function cargarEstadosOT(client: any, filas: FilaLibro[]): Promise<EstadosOT | null> {
  const ids = otsMencionadas(filas);
  const mapa: EstadosOT = new Map();
  if (ids.length === 0) return mapa;
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await client.from("ordenes_trabajo").select("id,estado").in("id", ids.slice(i, i + 200));
      if (error) return null;
      for (const o of (data || []) as { id: number; estado: string | null }[]) mapa.set(Number(o.id), String(o.estado ?? ""));
    }
    return mapa;
  } catch {
    return null;
  }
}
