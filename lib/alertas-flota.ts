// lib/alertas-flota.ts — Lógica PURA (sin React/DOM) de detección de solape de
// conductor y jornada extensa. Portada de app/seguimiento/page.tsx (detectarAlertasFlota)
// para poder reutilizarla server-side en el motor de alertas (/api/alertas-flota/tick).
// Son heurísticas de ADVERTENCIA, no certezas (no hay campo de duración en reservas;
// el fin se estima con un bloque por defecto cuando no hay hora_real_fin).

export type ReservaFlota = {
  id: number;
  estado?: string | null;
  conductor_id?: number | null;
  vehiculo_id?: number | null;
  vehiculo_tercero_id?: number | null;
  hora_servicio?: string | null;
  hora_real_fin?: string | null;
};

const DUR_ESTIMADA_MIN = 240; // 4 h: bloque por defecto para estimar el fin de un servicio

function aMin(hhmm?: string | null): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isNaN(h) ? null : h * 60 + (m || 0);
}

/**
 * Detecta, sobre las reservas de un día, qué conductores tienen servicios que se
 * cruzan (solape) y cuáles tienen jornada extensa (span > jornadaMaxH o ≥ maxServicios).
 * Devuelve, por reserva marcada, el conductor_id involucrado — para poder notificar.
 */
export function detectarSolapesJornada(
  reservas: ReservaFlota[],
  opts: { jornadaMaxH: number; maxServicios: number },
): { solape: Map<number, number>; jornada: Map<number, number> } {
  const solape = new Map<number, number>();  // reserva_id → conductor_id
  const jornada = new Map<number, number>();

  const intervalo = (r: ReservaFlota): [number, number] | null => {
    const ini = aMin(r.hora_servicio);
    if (ini == null) return null;
    const fin = aMin(r.hora_real_fin) ?? ini + DUR_ESTIMADA_MIN;
    return [ini, Math.max(fin, ini + 1)];
  };

  // Agrupar por conductor (solo propios con conductor asignado, no cancelados).
  const grupos = new Map<number, ReservaFlota[]>();
  for (const r of reservas) {
    if (r.estado === "cancelada") continue;
    if (!r.conductor_id) continue;
    let g = grupos.get(r.conductor_id);
    if (!g) { g = []; grupos.set(r.conductor_id, g); }
    g.push(r);
  }

  for (const [condId, g] of grupos) {
    // Solape: pares de servicios cuyos intervalos se cruzan.
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = intervalo(g[i]), b = intervalo(g[j]);
        if (a && b && a[0] < b[1] && b[0] < a[1]) {
          solape.set(g[i].id, condId);
          solape.set(g[j].id, condId);
        }
      }
    }
    // Jornada extensa: span (1ª salida → último fin) o cantidad de servicios.
    const inicios = g.map(intervalo).filter((x): x is [number, number] => !!x).map((x) => x[0]);
    const fines   = g.map(intervalo).filter((x): x is [number, number] => !!x).map((x) => x[1]);
    if (inicios.length && fines.length) {
      const spanH = (Math.max(...fines) - Math.min(...inicios)) / 60;
      if (spanH > opts.jornadaMaxH || g.length >= opts.maxServicios) {
        for (const r of g) jornada.set(r.id, condId);
      }
    }
  }

  return { solape, jornada };
}
