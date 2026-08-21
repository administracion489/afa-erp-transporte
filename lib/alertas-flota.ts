// lib/alertas-flota.ts — Lógica PURA (sin React/DOM) de detección de solape de
// conductor y jornada extensa. Portada de app/seguimiento/page.tsx (detectarAlertasFlota)
// para poder reutilizarla server-side en el motor de alertas (/api/alertas-flota/tick).
// Son heurísticas de ADVERTENCIA, no certezas (no hay campo de duración en reservas;
// el fin se estima con un bloque por defecto cuando no hay hora_real_fin).
//
// OJO con `hora_real_fin`: llevaba un año VACÍA (0 de 575 servicios en 30 días), así que este
// módulo caía SIEMPRE al bloque estimado. Desde que los endpoints del conductor la sellan, el
// valor entra de verdad — y es "HH:MM:SS" sin fecha, con dos formas de mentir (cruce de
// medianoche y cierre anticipado). Ver `duracionMin`: que el dato mejore no puede empeorar la
// alerta.

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

const DIA_MIN = 24 * 60;

// Techo de duración. 26 h y no 12: hay tours full day de hasta 24 h — mismo techo que
// app/api/cliente/gps/route.ts:60 (DURACION_MAX_MS) y lib/servicio-tiempos.ts:308.
const DURACION_MAX_MIN = 26 * 60;

// Por debajo de esto NO se cree la hora de fin y se vuelve al bloque estimado. `hora_real_fin`
// se sella con MAX(paradas.hora_llegada) de las paradas COMPLETADAS: si el conductor solo marcó
// el primer paradero, el valor queda pegado a la hora de salida y la ventana colapsaría a unos
// minutos, dejando CIEGO al detector (que es peor que estimar de más). El bloque estimado es
// exactamente lo que este módulo hacía hasta ahora, así que caer a él nunca es una regresión.
const DUR_MIN_FIABLE_MIN = 30;

function aMin(hhmm?: string | null): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isNaN(h) ? null : h * 60 + (m || 0);
}

/**
 * Minutos que dura el bloque a reservar para una reserva, a partir de su inicio pactado.
 *
 * `hora_real_fin` es "HH:MM:SS" DEL DÍA, SIN fecha (misma trampa que documenta
 * lib/servicio-tiempos.ts:67). Un nocturno que sale 22:00 y cierra 01:30 da fin=90 < ini=1320:
 * antes `Math.max(fin, ini + 1)` lo colapsaba a UN minuto y el detector se quedaba ciego justo
 * en ese servicio. Aquí un fin ANTERIOR al inicio se lee como cruce de medianoche (+24 h) y solo
 * se acepta si la duración cabe en el techo de 26 h; si no cabe —o si es implausiblemente corta—
 * se cae al bloque estimado, que es el comportamiento previo.
 */
function duracionMin(r: ReservaFlota, ini: number): number {
  const finCrudo = aMin(r.hora_real_fin);
  if (finCrudo == null) return DUR_ESTIMADA_MIN;
  const fin = finCrudo < ini ? finCrudo + DIA_MIN : finCrudo;
  const dur = fin - ini;
  if (dur > DURACION_MAX_MIN || dur < DUR_MIN_FIABLE_MIN) return DUR_ESTIMADA_MIN;
  return dur;
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
    // El fin puede pasar de 1440 (nocturno que cierra al día siguiente): las comparaciones de
    // solape y el span de jornada son restas, así que aguantan valores > 24 h sin más.
    return [ini, ini + duracionMin(r, ini)];
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
