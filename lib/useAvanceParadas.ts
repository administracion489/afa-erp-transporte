"use client";

// lib/useAvanceParadas.ts — envoltorio React de lib/avance-paradas.ts.
//
// Vive aparte del motor a propósito: un import de React en un lib que se quiere consumible
// desde el servidor (lib/proximidad.ts, crons) lo contamina. El motor es puro; esto solo
// decide CUÁNDO se recalcula.
//
// Dos vías de alimentación, por qué:
//   • SIEMBRA (huella histórica) — el modal se abre a mitad del viaje. Sin historial habría
//     que esperar 3 muestras nuevas (~30-45 s) para tener un veredicto, y durante ese rato se
//     seguiría pintando la hora de llegada equivocada. La siembra da el veredicto correcto en
//     el primer render. Es un reduce determinista, así que re-sembrar entero en cada ciclo de
//     15 s no parpadea: el mismo prefijo siempre da el mismo estado.
//   • FIX EN VIVO — la huella llega cada 15 s y el poll de GPS cada 10 s. Aplicar el fix nuevo
//     encima acorta el retardo. Es seguro porque CONVERGE: ese mismo fix reaparece en la
//     siguiente huella y el reduce lo reproduce.
//
// ORDEN DE ARRANQUE (mina real): la siembra parte SIEMPRE de estadoAvanceVacio, nunca del
// acumulador en vivo. Si un fix en vivo pudiera sembrar `lastTs` en "ahora" antes de que
// llegue la primera huella, la puerta temporal (`ts > lastTs + gate`) rechazaría todo el
// historial EN SILENCIO y el sistema degradaría a arranque en frío sin ninguna señal visible.

import { useMemo } from "react";
import {
  sembrarAvance, avanzarAvance, leerAvance,
  type Avance, type EstadoAvance, type FixAvance, type OpcionesAvance, type ParadaAvance,
} from "./avance-paradas";

export function useAvanceParadas(args: {
  paradas: ParadaAvance[];
  /** Firma PRIMITIVA de las paradas (ids + coords + estado). Sin ella el memo se invalidaría en
   *  cada render: ModalGps re-renderiza varias veces por fix (setSnapPos, setVelCalc, setUbic…). */
  firmaParadas: string;
  /** Lector de la huella histórica CRUDA (filasAPuntos sin anclar ni limpiar — ver el comentario
   *  de sembrarAvance sobre por qué NO se le pasa `crudos` ni `limpio`).
   *  Es una FUNCIÓN y no el array: la huella son hasta 35 000 puntos que viven en un ref del
   *  consumidor (meterlos en estado re-renderizaría el modal entero cada 15 s), y pasarlos por
   *  valor obligaría a leer ese ref en cada render aunque no se vaya a re-sembrar. */
  leerHuella?: () => FixAvance[];
  /** Contador que bumpea el efecto de la huella: es la señal —esta sí reactiva— de que hay
   *  puntos nuevos y toca re-sembrar. */
  huellaVersion?: number;
  fixVivo?: FixAvance | null;
  opts?: OpcionesAvance;
}): Avance {
  const { paradas, firmaParadas, leerHuella, huellaVersion = 0, fixVivo, opts } = args;

  // `ruta.total` es una firma primitiva suficiente: cambia cuando se recarga la geometría.
  const claveBase = `${firmaParadas}|${huellaVersion}|${opts?.foco ?? ""}|${opts?.ruta?.total ?? 0}`;
  const fixTs = fixVivo?.ts ?? 0;

  // SIEMBRA. Parte SIEMPRE de cero sobre la huella completa: es un reduce puro, así que
  // recalcularla entera cada ciclo da el mismo resultado y no parpadea.
  const base = useMemo(
    () => sembrarAvance(paradas, leerHuella ? leerHuella() : [], opts),
    // Solo `claveBase`: la huella se lee cuando toca re-sembrar, no en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [claveBase]
  );

  // ADELANTO EN VIVO. Se aplica el ÚLTIMO fix conocido encima de la siembra — no una
  // acumulación con memoria propia. Es una derivación pura: sin estado, sin refs, sin efectos,
  // así que no hay ninguna forma de que el acumulado y la siembra se desincronicen.
  //
  // Qué se pierde: si entre dos ciclos de huella (15 s) llegan varias muestras, solo cuenta la
  // más nueva. No importa — todas reaparecen en la siguiente huella y el reduce las procesa
  // completas. El único efecto es que un veredicto puede llegar un ciclo más tarde, nunca
  // equivocado. A cambio, el estado no puede quedar "colgado" de una siembra vieja.
  const estado: EstadoAvance = useMemo(
    () => (fixVivo && fixVivo.ts > base.lastTs ? avanzarAvance(base, fixVivo, paradas, opts) : base),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, fixTs]
  );

  return useMemo(() => leerAvance(estado, paradas), [estado, paradas]);
}
