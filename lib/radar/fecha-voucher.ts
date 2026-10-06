// ──────────────────────────────────────────────────────────────────────────────
// lib/radar/fecha-voucher.ts — Motor PURO: la fecha que se leyó del voucher, contra la fecha en
// que el conductor MANDÓ la foto. No lee la base. Lo consume lib/radar/acciones.ts y lo prueba
// scripts/prueba-radar-guardado.mts.
//
// EL CASO: una carga de la CTV-370 entró con fecha 13/08/2025, un año antes de que existiera el
// mensaje que la traía. La IA leyó bien el día y el mes y mal el año. El ERP tenía la evidencia
// para no creerlo —la hora del mensaje de WhatsApp es un hecho, no una lectura— y no la miraba:
// la fecha del voucher se tomaba tal cual, y una carga fechada un año atrás se va al fondo de la
// cadena de rendimiento de su unidad, descuadra el mes y no la vuelve a ver nadie.
//
// LA REGLA: un voucher se fotografía DESPUÉS de imprimirse, y casi siempre el mismo día o pocos
// días después. Así que la fecha leída tiene que caer entre la del mensaje y unos días antes:
//   • posterior al mensaje → imposible: es un dígito mal leído.
//   • más de MAX_ATRASO_DIAS antes → o se mandó muy tarde, o se leyó mal. Lo decide una persona.
//
// SE CORRIGE SOLO SI LA CORRECCIÓN ES UNA Y EXACTA (el mismo criterio del cuadre del voucher):
// las dos lecturas equivocadas que sí se reconocen son el AÑO (2025 por 2026; el día y el mes bien)
// y el DÍA CON EL MES CAMBIADOS (03/10 leído como 10 de marzo). Si una sola de esas variantes cae
// dentro del rango, se propone; si caen dos o ninguna, no se adivina. Y la corrección NUNCA se
// registra sola: va a revisión con la fecha buena ya puesta y la leída a la vista, como el dígito
// que corrige el cuadre — sobre el día de una carga decide una persona con la foto delante.
// ──────────────────────────────────────────────────────────────────────────────

import type { AnomaliaCombustible } from "./tipos";

/**
 * Cuántos días antes del mensaje puede ser un voucher sin que se pregunte. NO está medido y se
 * declara: una semana cubre al conductor que manda las fotos del día al cerrar el turno o el fin de
 * semana. Pasarlo solo manda la carga a revisión —no la pierde—, así que el lado seguro es este.
 */
export const MAX_ATRASO_DIAS = 7;

export type CodigoFecha =
  | "ok"                    // dentro del rango
  | "sin_fecha"             // la IA no leyó ninguna: se usa la del mensaje (como siempre)
  | "sin_referencia"        // no hay fecha del mensaje con qué comparar: se respeta la leída
  | "corregida"             // fuera de rango y UNA sola variante la explica
  | "posterior_al_mensaje"  // fecha futura respecto del envío: no se adivina cuál era
  | "muy_anterior";         // demasiado vieja respecto del envío: no se adivina

export type VeredictoFecha = {
  codigo: CodigoFecha;
  /** La fecha que se guarda en la fila: la leída, la corregida, o la del mensaje si no hubo lectura. */
  fecha: string | null;
  /** Lo que leyó la IA, tal cual (null si no leyó nada). */
  leida: string | null;
  anomalia?: AnomaliaCombustible;
};

const DIA_MS = 86_400_000;
const msDe = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const existe = (y: number, m: number, d: number) => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const f = new Date(Date.UTC(y, m - 1, d));
  return f.getUTCFullYear() === y && f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
};
const legible = (f: string) => `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}`;

/** YYYY-MM-DD de una fecha que EXISTE en el calendario, o null. */
export function fechaIso(v: unknown): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "").trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  return existe(y, mo, d) ? iso(y, mo, d) : null;
}

/** Días que pasaron entre el voucher y el mensaje (positivo = el voucher es anterior). */
export function atrasoDias(fechaVoucher: string, fechaMensaje: string): number {
  return Math.round((msDe(fechaMensaje) - msDe(fechaVoucher)) / DIA_MS);
}

export function revisarFechaVoucher(args: {
  leida: unknown;
  /** Fecha Lima del ENVÍO del mensaje (ts_mensaje), no la del proceso. */
  fechaMensaje: string | null | undefined;
  maxAtraso?: number;
}): VeredictoFecha {
  const max = args.maxAtraso ?? MAX_ATRASO_DIAS;
  const leida = fechaIso(args.leida);
  const ref = fechaIso(args.fechaMensaje);
  if (!leida) return { codigo: "sin_fecha", fecha: ref, leida: null };
  if (!ref) return { codigo: "sin_referencia", fecha: leida, leida };

  const atraso = atrasoDias(leida, ref);
  const enRango = (f: string) => {
    const a = atrasoDias(f, ref);
    return a >= 0 && a <= max;
  };
  if (enRango(leida)) return { codigo: "ok", fecha: leida, leida };

  // Las únicas dos lecturas equivocadas que se reconocen: el año, y el día con el mes.
  const y = Number(leida.slice(0, 4)), m = Number(leida.slice(5, 7)), d = Number(leida.slice(8, 10));
  const yRef = Number(ref.slice(0, 4));
  const variantes = new Set<string>();
  const sumar = (yy: number, mm: number, dd: number) => { if (existe(yy, mm, dd)) variantes.add(iso(yy, mm, dd)); };
  for (const yy of [yRef, yRef - 1]) sumar(yy, m, d);               // el año mal leído
  for (const yy of [y, yRef, yRef - 1]) if (d !== m) sumar(yy, d, m); // día y mes intercambiados
  variantes.delete(leida);
  const candidatas = [...variantes].filter(enRango);

  if (candidatas.length === 1) {
    const corregida = candidatas[0];
    const cambio = corregida.slice(5) === leida.slice(5) ? "el mismo día y mes, con el año del mensaje" : "el día y el mes intercambiados";
    return {
      codigo: "corregida",
      fecha: corregida,
      leida,
      anomalia: {
        codigo: "fecha_corregida",
        detalle:
          `La fecha leída del voucher (${legible(leida)}) no puede ser: el mensaje se mandó el ${legible(ref)}` +
          `${atraso < 0 ? ", ANTES de esa fecha" : `, ${atraso} días después`}. Se propone ${legible(corregida)} (${cambio}). ` +
          `Compruébala contra la foto antes de registrar.`,
        bloquea: true,
        correccion: { campo: "fecha", leido: leida, corregido: corregida },
      },
    };
  }

  const ambiguo = candidatas.length > 1 ? ` Hay ${candidatas.length} lecturas posibles (${candidatas.map(legible).join(", ")}): no se adivina.` : "";
  if (atraso < 0) {
    return {
      codigo: "posterior_al_mensaje",
      fecha: leida,
      leida,
      anomalia: {
        codigo: "fecha_fuera_de_rango",
        detalle:
          `La fecha leída del voucher (${legible(leida)}) es POSTERIOR al envío del mensaje (${legible(ref)}): ningún voucher ` +
          `se fotografía antes de imprimirse, casi siempre es un dígito mal leído. Corrígela contra la foto.${ambiguo}`,
        bloquea: true,
      },
    };
  }
  return {
    codigo: "muy_anterior",
    fecha: leida,
    leida,
    anomalia: {
      codigo: "fecha_fuera_de_rango",
      detalle:
        `La fecha leída del voucher (${legible(leida)}) es ${atraso} días anterior al mensaje (${legible(ref)}): o se mandó ` +
        `muy tarde o la fecha se leyó mal. Confírmala contra la foto antes de registrar.${ambiguo}`,
      bloquea: true,
    },
  };
}
