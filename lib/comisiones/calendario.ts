// ──────────────────────────────────────────────────────────────────────────────
// lib/comisiones/calendario.ts — Días hábiles y horas hábiles en Perú (UTC-5).
//
// POR QUÉ VIVE AQUÍ: la rapidez del bono de atención se mide en HORAS HÁBILES (una
// respuesta un viernes a las 17:00 contestada el lunes a las 09:00 no tardó 64 horas,
// tardó 3), los plazos de registro «al día» también, y la ventana de cliente nuevo hace
// aritmética de meses. Las tres necesitan el mismo calendario, y dos copias del mismo
// desplazamiento a UTC-5 terminan contestando distinto sobre el mismo instante — el bug
// que el ERP ya documentó al unificar `hoyLima`.
//
// NADA DE FERIADOS ESCRITOS EN EL CÓDIGO: la lista de feriados de Perú cambia (hay fijos,
// y el Ejecutivo agrega puentes y días no laborables por año), así que `feriados` entra
// siempre como parámetro. Este módulo solo sabe qué es un sábado y cómo contar horas.
//
// La jornada (hora de inicio y fin) también es parámetro: una oficina comercial no
// atiende las mismas horas que un taller.
// ──────────────────────────────────────────────────────────────────────────────

/** Perú es UTC-5 fijo, sin horario de verano. Mismo supuesto que el resto del ERP. */
const LIMA_OFFSET_MS = 5 * 3_600_000;
const DIA_MS = 86_400_000;

const pad = (n: number) => String(n).padStart(2, "0");

/** Día de la semana en Perú para una fecha "YYYY-MM-DD". 0 = domingo … 6 = sábado. */
export function diaSemanaLima(iso: string): number {
  // Mediodía UTC para que ningún desplazamiento de zona cruce la medianoche.
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

/** ¿Cae en fin de semana (sábado o domingo)? */
export function esFinDeSemana(iso: string): boolean {
  const d = diaSemanaLima(iso);
  return d === 0 || d === 6;
}

/** ¿Está en la lista de feriados que se pasó? La comparación es exacta sobre "YYYY-MM-DD". */
export function esFeriado(iso: string, feriados: readonly string[]): boolean {
  return feriados.includes(iso);
}

/** Un día hábil es el que no es fin de semana ni feriado. */
export function esDiaHabil(iso: string, feriados: readonly string[] = []): boolean {
  return !esFinDeSemana(iso) && !esFeriado(iso, feriados);
}

// ─── Aritmética sobre la cadena ISO ───────────────────────────────────────────
// "La aritmética de días va sobre la cadena ISO" (CLAUDE.md). El servidor corre en UTC
// y «hoy» en Perú es UTC-5; trabajar sobre la cadena a mediodía UTC evita que el
// desplazamiento mueva el día.

/** Suma (o resta, con `n` negativo) días a una fecha "YYYY-MM-DD". */
export function sumarDias(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);
}

/** Cuántos días tiene ese mes (1-based). El día 0 del siguiente ES el último del actual. */
export function diasDelMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

/** Suma `n` meses de CALENDARIO a "YYYY-MM-DD", recortando el día al último del mes
 *  destino (31-ene + 1 mes = 28/29-feb, nunca marzo). Lo usa la ventana de 12 meses. */
export function sumarMeses(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const total = m - 1 + n;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12; // 0..11
  const nd = Math.min(d, diasDelMes(ny, nm + 1));
  return `${ny}-${pad(nm + 1)}-${pad(nd)}`;
}

/** El "YYYY-MM" (mes de cobro) de una fecha, para agrupar el contador del tramo. */
export function mesDe(iso: string): string {
  return iso.slice(0, 7);
}

// ─── Horas hábiles entre dos instantes ────────────────────────────────────────

/** La jornada hábil: de qué hora a qué hora cuenta un día laborable. Parámetros, no
 *  constantes de negocio: una oficina comercial no es un taller. */
export type Jornada = {
  feriados?: readonly string[];
  /** Hora de inicio de la jornada (0..24). Por defecto 09:00. */
  horaInicio?: number;
  /** Hora de fin de la jornada (0..24). Por defecto 18:00. */
  horaFin?: number;
};

/** Parte de un instante (ms epoch) en su fecha y minuto del día EN HORA DE LIMA. */
function limaPartes(ms: number): { iso: string; min: number } {
  const d = new Date(ms - LIMA_OFFSET_MS);
  return {
    iso: d.toISOString().slice(0, 10),
    min: d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60,
  };
}

/**
 * Horas hábiles entre dos instantes (ms epoch), contando SOLO el tramo de jornada de los
 * días hábiles. Cruza la noche (un viernes 17:00 → lunes 09:00 con jornada 09–18 son 1
 * hora del viernes + 0 del fin de semana = 1 hora, no 64), los feriados (0) y el fin de
 * semana (0). Es una CANTIDAD, no un instante: no decide nada por su cuenta.
 */
export function horasHabilesEntre(desdeMs: number, hastaMs: number, jornada: Jornada = {}): number {
  if (hastaMs <= desdeMs) return 0;
  const feriados = jornada.feriados ?? [];
  const iniMin = (jornada.horaInicio ?? 9) * 60;
  const finMin = (jornada.horaFin ?? 18) * 60;
  if (finMin <= iniMin) return 0;

  const a = limaPartes(desdeMs);
  const b = limaPartes(hastaMs);
  let total = 0;
  let iso = a.iso;
  // El rango de fechas de Lima es acotado por `b.iso`, así que el bucle termina.
  while (iso <= b.iso) {
    if (esDiaHabil(iso, feriados)) {
      let desdeDia = iniMin;
      let hastaDia = finMin;
      if (iso === a.iso) desdeDia = Math.max(desdeDia, a.min);
      if (iso === b.iso) hastaDia = Math.min(hastaDia, b.min);
      if (hastaDia > desdeDia) total += hastaDia - desdeDia;
    }
    iso = sumarDias(iso, 1);
  }
  return total / 60; // minutos → horas
}

/** ¿El registro se hizo dentro del plazo de horas hábiles? Azúcar sobre
 *  `horasHabilesEntre` para el indicador «registros al día» del bono de atención. */
export function dentroDePlazoHabil(
  ocurrioMs: number,
  registradoMs: number,
  plazoHoras: number,
  jornada: Jornada = {},
): boolean {
  return horasHabilesEntre(ocurrioMs, registradoMs, jornada) <= plazoHoras;
}
