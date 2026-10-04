// lib/odometro-gps.ts — coteja el odómetro del día de un conductor contra el GPS de sus servicios.
//
// Server-side (recibe el cliente service-role). La decisión es de `cotejarOdometroGps`
// (lib/odometro-confirmacion.ts, PURO); aquí solo se reúnen los dos números:
//   · odómetro del día = km_fin − km del CHECK-IN de ESE conductor en esa unidad ese día
//     (la lectura se busca por la misma `idem_key` con que el route la escribió: si dos
//     conductores comparten unidad, cada uno se mide contra su propio inicio);
//   · GPS = suma de `kmDeServicio` de los servicios de ese conductor con esa unidad ese día.
// Best-effort: cualquier fallo devuelve `sin_gps` y nada se bloquea.

import { kmOperativosDia } from "@/lib/km-servicio";
import { cotejarOdometroGps, type CotejoGps } from "@/lib/odometro-confirmacion";

export type CotejoGpsDia = CotejoGps & { odoDia: number | null; gpsKm: number; medidoPct: number; servicios: number };

export async function cotejoGpsDelDia(
  admin: any,
  o: { conductorId: number; campoConductor: string; vehiculoId: number; esTercero: boolean; fecha: string; kmFin: number },
): Promise<CotejoGpsDia> {
  const vacio: CotejoGpsDia = { codigo: "sin_gps", detalle: null, odoDia: null, gpsKm: 0, medidoPct: 0, servicios: 0 };
  try {
    const idemCheckin = `checkin:${o.esTercero ? "t" : "p"}:${o.vehiculoId}:${o.fecha}:${o.conductorId}`;
    const { data: ini } = await admin.from("lecturas_odometro")
      .select("km,estado").eq("idem_key", idemCheckin).neq("estado", "anulada").limit(1).maybeSingle();
    const kmIni = ini ? Number(ini.km) : null;
    const odoDia = kmIni != null && Number.isFinite(kmIni) && kmIni > 0 ? Math.round(o.kmFin - kmIni) : null;

    const fkVeh = o.esTercero ? "vehiculo_tercero_id" : "vehiculo_id";
    const { data: rs } = await admin.from("reservas")
      .select("id").eq("fecha_servicio", o.fecha).eq(fkVeh, o.vehiculoId).eq(o.campoConductor, o.conductorId)
      .in("estado", ["en_curso", "finalizada"]);
    const ids = ((rs as any[]) ?? []).map((r) => Number(r.id)).filter(Boolean).slice(0, 12);
    if (!ids.length) return { ...vacio, odoDia, codigo: odoDia == null ? "sin_odometro" : "sin_gps" };

    const { total, porReserva } = await kmOperativosDia(admin, ids);
    // % medido ponderado por km: un servicio corto mal medido no debe tumbar el juicio de la jornada.
    const peso = porReserva.reduce((s, r) => s + r.kmRecorridos, 0);
    const medidoPct = peso > 0 ? Math.round(porReserva.reduce((s, r) => s + r.kmRecorridos * r.medidoPct, 0) / peso) : 0;
    const c = cotejarOdometroGps({ odoDia, gpsKm: total, medidoPct });
    return { ...c, odoDia, gpsKm: total, medidoPct, servicios: ids.length };
  } catch {
    return vacio;
  }
}
