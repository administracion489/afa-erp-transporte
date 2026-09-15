// ──────────────────────────────────────────────────────────────────────────────
// lib/paradas-hora.ts — CUANDO LA HORA DE UN SERVICIO SE MUEVE, SUS PARADEROS SE
// MUEVEN CON ELLA. Motor PURO: no lee la base.
//
// EL CASO (lunes 14-09, reportado por el dueño): el operador corrió el horario de un
// contrato fijo desde /programacion y lo propagó al resto del contrato. `reservas.
// hora_servicio` cambió en los 100 servicios futuros… y al abrir el lunes 21 los
// PARADEROS seguían con la hora vieja. La pantalla decía una hora y el paradero otra.
//
// LA HORA DE UN SERVICIO VIVE EN TRES SITIOS Y LOS TRES TIENEN QUE DECIR LO MISMO:
//
//   1 · `reservas.hora_servicio`  — la que se ve en la lista de Programación.
//   2 · `paradas.hora_estimada`   — el itinerario REAL. De aquí salen el aviso al
//       pasajero (lib/notificaciones.ts: `hora: parada?.hora_estimada`), la app del
//       conductor, el portal del cliente, la hoja de ruta impresa y el semáforo de
//       puntualidad (lib/retrasos.ts compara contra la hora del siguiente paradero).
//   3 · `reservas.paradas_json`   — la SEMILLA. Un programa fijo recién generado NO
//       tiene filas en `paradas`: `ModalGenerarPrograma` solo escribe este JSON, y
//       `cargarParadasReserva` las materializa la primera vez que alguien abre el
//       servicio. Dejarla vieja no es un detalle cosmético: RE-INYECTA la hora vieja
//       cada vez que un servicio futuro materializa sus paraderos, así que el arreglo
//       se deshace solo, servicio por servicio, durante los meses que dure el contrato.
//
// De los tres, los tres escritores de la hora en /programacion tocaban solo el 1 (el
// editor inline además el 2, y por eso el defecto se veía "a veces": dependía de si
// alguien había abierto ese servicio antes o no).
//
// LA REGLA: SE CORRE POR DELTA, NO SE FIJA EL PRIMERO. Los paraderos llevan un
// espaciado que alguien planificó (05:10 · 05:25 · 05:40). Poner la hora nueva en el
// primero y dejar el resto rompería el itinerario en vez de moverlo; correrlos todos
// por el mismo desplazamiento lo conserva. Es la regla que ya aplicaba el editor
// inline de la fila — aquí está EXTRAÍDA, no reescrita, para que los tres caminos que
// mueven la hora no puedan volver a contestar distinto.
// ──────────────────────────────────────────────────────────────────────────────

/** "HH:MM" o "HH:MM:SS" → minutos desde medianoche. */
export function minutosHHMM(s: string): number {
  const [h, m] = s.slice(0, 5).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function fmtHHMM(min: number): string {
  let t = min % 1440; if (t < 0) t += 1440; // envolver dentro del día (una parada podría cruzar medianoche)
  return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
}

/** Corre una hora "HH:MM(:SS)" por un delta en minutos, devolviendo "HH:MM". */
export function correrHora(hhmm: string, deltaMin: number): string {
  return fmtHHMM(minutosHHMM(hhmm) + deltaMin);
}

/** Delta con signo legible: "+30 min · sale después" / "−15 min · sale antes". */
export function etiquetaDelta(deltaMin: number): string {
  if (deltaMin === 0) return "sin cambio";
  const signo = deltaMin > 0 ? "+" : "−";
  const abs = Math.abs(deltaMin);
  const txt = abs >= 60
    ? `${Math.floor(abs / 60)}h${abs % 60 ? " " + (abs % 60) + "min" : ""}`
    : `${abs} min`;
  return `${signo}${txt} · sale ${deltaMin > 0 ? "después" : "antes"}`;
}

/** "HH:MM" limpio, o "" si el valor no es una hora. */
const hhmm = (v: unknown): string => {
  const s = String(v ?? "").trim();
  return /^\d{1,2}:\d{2}/.test(s) ? s.slice(0, 5).padStart(5, "0") : "";
};

/**
 * Cuánto se movió la hora del servicio, en minutos.
 *
 * `null` significa NO SE SABE, que no es lo mismo que cero: sin hora anterior no hay
 * desde dónde medir el desplazamiento, y suponerlo movería los paraderos por una
 * cantidad que nadie declaró. El lado seguro es no tocarlos.
 */
export function deltaHoras(
  antes: string | null | undefined,
  despues: string | null | undefined,
): number | null {
  const a = hhmm(antes), b = hhmm(despues);
  if (!b) return 0;      // no se está moviendo la hora a ningún lado
  if (!a) return null;   // hay destino pero no origen: no se inventa el desplazamiento
  return minutosHHMM(b) - minutosHHMM(a);
}

/** Una fila de `paradas` (solo lo que el motor necesita mirar). */
export type ParadaFila = {
  id: number;
  nombre?: string | null;
  hora_estimada?: string | null;
  estado?: string | null;
};

/** Un paradero de la semilla `reservas.paradas_json` / `cotizaciones.paradas_json`. */
export type ParadaSemilla = { hora?: string | null; nombre?: string | null; [k: string]: any };

export type CodigoHoraParaderos =
  /** Hay desplazamiento y hay paraderos con hora: se corren. */
  | "corre"
  /** La hora no se movió (o no se dio una hora nueva). */
  | "sin_delta"
  /** Hay hora nueva pero el servicio no traía hora previa: no se inventa el desplazamiento. */
  | "sin_hora_anterior"
  /** El servicio no declara paraderos por ningún lado (ni filas ni semilla). */
  | "sin_paraderos"
  /** Tiene paraderos, pero ninguno declara hora: no hay nada que correr — y no se inventa. */
  | "sin_horas";

export type CorridaParada = { id: number; nombre: string; de: string; a: string };

export type PlanHoraParaderos = {
  deltaMin: number;
  codigo: CodigoHoraParaderos;
  /** Frase lista para la pantalla. Nombra el problema, no el código. */
  motivo: string;
  /** Filas de `paradas` a reescribir, con el antes y el después. */
  filas: CorridaParada[];
  /** La semilla `paradas_json` ya corrida, o `null` si no hay nada que reescribir. */
  semilla: ParadaSemilla[] | null;
  /**
   * Paraderos YA PASADOS que conservan su hora planificada. Esa hora es el patrón
   * contra el que se midió si el bus llegó tarde; correrla reescribiría el veredicto
   * de un tramo que ya ocurrió.
   */
  congeladas: number;
};

const vacio = (deltaMin: number, codigo: CodigoHoraParaderos, motivo: string): PlanHoraParaderos =>
  ({ deltaMin, codigo, motivo, filas: [], semilla: null, congeladas: 0 });

/** Un paradero ya recorrido: su hora planificada es historia, no un plan. */
const yaPasada = (p: ParadaFila) => String(p.estado ?? "") === "completada";

/**
 * Qué les pasa a los paraderos de UN servicio cuando su hora se mueve de `horaAntes`
 * a `horaNueva`.
 *
 * Se le pasan las dos fuentes porque son dos caras del mismo itinerario y hay que
 * moverlas juntas: las filas de `paradas` (si ya se materializaron) y la semilla
 * `paradas_json` (de la que se materializan las que todavía no existen). Correr una
 * sola deja al servicio diciendo dos horas distintas según quién lo mire.
 */
export function planDeHoraParaderos({
  horaAntes, horaNueva, filas = [], semilla = null,
}: {
  horaAntes?: string | null;
  horaNueva?: string | null;
  filas?: ParadaFila[];
  semilla?: ParadaSemilla[] | null;
}): PlanHoraParaderos {
  const d = deltaHoras(horaAntes, horaNueva);

  if (d === null)
    return vacio(0, "sin_hora_anterior",
      "El servicio no tenía hora anterior, así que no se sabe cuánto correr sus paraderos. "
      + "Revisa sus horas una por una.");
  if (d === 0) return vacio(0, "sin_delta", "La hora no se movió: los paraderos quedan igual.");

  const hayFilas   = filas.length > 0;
  const haySemilla = Array.isArray(semilla) && semilla.length > 0;
  if (!hayFilas && !haySemilla)
    return vacio(d, "sin_paraderos",
      "Este servicio no tiene paraderos propios: su itinerario sale de la cotización. "
      + "La hora nueva no se refleja ahí hasta que se propague desde Cotizaciones.");

  const conHora = filas.filter(p => hhmm(p.hora_estimada));
  const corribles = conHora.filter(p => !yaPasada(p));
  const nuevasFilas: CorridaParada[] = corribles.map(p => ({
    id: p.id,
    nombre: String(p.nombre ?? ""),
    de: hhmm(p.hora_estimada),
    a: correrHora(hhmm(p.hora_estimada), d),
  }));

  // La semilla no tiene estado —describe lo planificado, no lo ocurrido— así que se
  // corre entera. Solo se devuelve si de verdad cambia: escribir un JSON idéntico
  // sería un UPDATE por servicio que no arregla nada.
  let nuevaSemilla: ParadaSemilla[] | null = null;
  if (haySemilla) {
    let tocada = false;
    const corrida = (semilla as ParadaSemilla[]).map(p => {
      const h = hhmm(p?.hora);
      if (!h) return p;
      tocada = true;
      return { ...p, hora: correrHora(h, d) };
    });
    if (tocada) nuevaSemilla = corrida;
  }

  if (nuevasFilas.length === 0 && !nuevaSemilla)
    return vacio(d, "sin_horas",
      "Los paraderos de este servicio no tienen hora escrita, así que no hay nada que correr. "
      + "Si necesitas horarios por paradero, ponlos en el detalle del servicio.");

  return {
    deltaMin: d,
    codigo: "corre",
    motivo: `Los paraderos se corren ${etiquetaDelta(d)}.`,
    filas: nuevasFilas,
    semilla: nuevaSemilla,
    congeladas: conHora.length - corribles.length,
  };
}
