// lib/alertas-checkout.ts — Motor PURO del recordatorio de CHECK-OUT (bloque 5b del tick
// /api/alertas-flota/tick). Decide, para UN conductor y UN día, si toca recordarle que envíe el
// odómetro final y en qué ronda va. No lee la base: el tick le entrega los servicios del día, si
// hay fila de check-out y las lecturas de odómetro de la unidad.
//
// LO QUE SE PIDIÓ (dueño, 08/10/2026): «algunos conductores se olvidan enviar el odómetro en el
// app (checkout) y al grupo de WhatsApp: que les llegue un WhatsApp automático si pasados unos
// minutos de cerrar su último servicio del día no lo han hecho, y que se repita cada hora hasta
// que lo hagan». El recordatorio YA existía y fallaba por cuatro huecos, todos de este bloque:
//
//  1. SOLO MIRABA EL CHECK-OUT DE LA APP. Quien mandó la foto del tablero al grupo de WhatsApp
//     (el Radar la registra en `lecturas_odometro`) seguía recibiendo recordatorios cada hora por
//     algo que ya hizo — y un aviso que llega cuando ya cumpliste enseña a ignorarlo. Ahora para
//     cualquier lectura de la unidad tomada después del último servicio, venga de donde venga.
//  2. UN SERVICIO CANCELADO LO APAGABA PARA SIEMPRE. Exigía que TODOS los servicios del día
//     estuvieran `finalizada`; uno cancelado no lo está nunca, así que ese día no se recordaba
//     nada. Los cancelados no cuentan.
//  3. NO CUBRÍA A LOS CONDUCTORES TERCERIZADOS que usan la app (solo `conductor_id`). Ahora sí,
//     con el mismo interruptor que el resto del motor (`notifica_conductor_tercero`). Y su
//     check-out no deja fila en `checkout_conductor` (el FK apunta a `conductores`), así que para
//     ellos la ÚNICA señal de que cumplieron es la lectura — el punto 1 es lo que lo hace posible.
//  4. «RECORDAR CADA (MIN)» DE /auditoria-jornada NO LO LEÍA NADIE: la cadencia estaba fija en la
//     hora del reloj. Una pantalla que ofrece un control que el sistema no lee es peor que no
//     ofrecerlo. Ahora la cadencia es esa, contada desde el primer recordatorio.

/** Un servicio del día del conductor, con lo justo para decidir. */
export type ServicioCheckout = {
  estado: string | null;
  /** Instante de fin en ms UTC (`finServicioMs` del tick). null si no se puede saber. */
  finMs: number | null;
  /** Clave de la unidad («propio:12» / «tercero:5»), o null si el servicio no tiene. */
  vehiculo: string | null;
};

/** Una lectura de odómetro de una unidad, ya con su instante efectivo (`instanteLectura`). */
export type LecturaCheckout = { vehiculo: string; ts: number; anulada: boolean };

export type CodigoCheckout =
  | "sin_servicios"       // ningún servicio vigente hoy (o todos cancelados)
  | "servicios_abiertos"  // aún tiene servicios sin cerrar: todavía no terminó su día
  | "ya_checkout"         // hizo el check-out en la app
  | "odometro_recibido"   // hay una lectura de la unidad tras el último servicio (app, grupo, manual)
  | "en_espera"           // terminó, pero aún no pasa el tiempo de espera
  | "recordar";           // toca recordar (ronda N)

export type PlanCheckout = {
  codigo: CodigoCheckout;
  /** Fin del último servicio (ms), cuando todos terminaron. */
  finMs: number | null;
  /** Unidad del último servicio: la que vuelve a la cochera y cuyo odómetro falta. */
  vehiculo: string | null;
  /** 0 = primer recordatorio, 1 = segundo… Solo con `recordar` y fin conocido. */
  ronda: number | null;
  /** Parte de la clave del envío: un recordatorio por valor distinto. Solo con `recordar`. */
  turno: string | null;
};

/**
 * Cuánto ANTES del fin del último servicio puede estar la lectura y contar como la final. Un
 * conductor puede mandar la foto del tablero al llegar y cerrar el servicio en la app después.
 * NO está medido y se declara: el lado seguro es BAJARLO (con uno grande, una lectura de media
 * jornada apagaría el recordatorio).
 */
export const TOLERANCIA_LECTURA_ANTES_MS = 30 * 60_000;

/** La cadencia mínima con sentido: el tick corre cada 10 min, más fino no se puede cumplir. */
export const CADENCIA_MIN_MINUTOS = 10;

/**
 * Tras cuántos recordatorios sin respuesta se avisa al directorio (la persona marcada en
 * «También avisar a» de esa alerta), UNA vez por día. Un conductor que no contesta a tres
 * WhatsApp automáticos ya no lo va a hacer por el cuarto: hace falta una llamada. NO está
 * medido y se declara.
 */
export const ESCALAR_TRAS_RECORDATORIOS = 3;

export function cadenciaEfectiva(min: number | null | undefined): number {
  const n = Math.round(Number(min));
  return Number.isFinite(n) && n > 0 ? Math.max(n, CADENCIA_MIN_MINUTOS) : 60;
}

export function planRecordarCheckout(e: {
  servicios: ServicioCheckout[];
  checkoutHecho: boolean;
  lecturas: LecturaCheckout[];
  ahoraMs: number;
  /** Minutos de espera tras el último servicio (alerta_config.umbral). */
  esperaMin: number | null | undefined;
  /** Minutos entre recordatorios (jornada_config.recordar_checkout_cada_min). */
  cadenciaMin: number | null | undefined;
}): PlanCheckout {
  const vigentes = e.servicios.filter((s) => s.estado !== "cancelada");
  const vacio = (codigo: CodigoCheckout): PlanCheckout => ({ codigo, finMs: null, vehiculo: null, ronda: null, turno: null });
  if (!vigentes.length) return vacio("sin_servicios");
  if (!vigentes.every((s) => s.estado === "finalizada")) return vacio("servicios_abiertos");

  // El último servicio del día manda: su fin y su unidad. Sin fin conocido se toma el que sí lo
  // tenga; si ninguno lo tiene, no hay desde cuándo contar la espera (ver abajo).
  let ultimo: ServicioCheckout | null = null;
  for (const s of vigentes) {
    if (s.finMs == null || !Number.isFinite(s.finMs)) continue;
    if (!ultimo || (s.finMs as number) > (ultimo.finMs as number)) ultimo = s;
  }
  const finMs = ultimo?.finMs ?? null;
  const vehiculo = ultimo?.vehiculo ?? vigentes.find((s) => s.vehiculo)?.vehiculo ?? null;
  const base = { finMs, vehiculo, turno: null };

  if (e.checkoutHecho) return { codigo: "ya_checkout", ronda: null, ...base };

  if (vehiculo) {
    const desde = finMs != null ? finMs - TOLERANCIA_LECTURA_ANTES_MS : -Infinity;
    const recibida = e.lecturas.some((l) => !l.anulada && l.vehiculo === vehiculo && l.ts >= desde);
    if (recibida) return { codigo: "odometro_recibido", ronda: null, ...base };
  }

  const cadencia = cadenciaEfectiva(e.cadenciaMin) * 60_000;
  // Sin la hora de ningún servicio no hay desde cuándo contar: se recuerda por turnos del reloj
  // y sin ronda (no se escala: no se sabe cuántos recordatorios lleva).
  if (finMs == null) {
    return { codigo: "recordar", ronda: null, finMs, vehiculo, turno: `h${Math.floor(e.ahoraMs / cadencia)}` };
  }
  const espera = Math.max(0, Math.round(Number(e.esperaMin) || 0)) * 60_000;
  const inicio = finMs + espera;
  if (e.ahoraMs < inicio) return { codigo: "en_espera", ronda: null, ...base };

  const ronda = Math.floor((e.ahoraMs - inicio) / cadencia);
  return { codigo: "recordar", ronda, finMs, vehiculo, turno: `r${ronda}` };
}

/** ¿En esta ronda toca avisar también al directorio? Una sola vez por día (lo garantiza su clave). */
export const escalaAlDirectorio = (ronda: number | null): boolean =>
  ronda != null && ronda >= ESCALAR_TRAS_RECORDATORIOS - 1;
