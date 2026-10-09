// lib/radar/km-recarga.ts
// El kilometraje de una RECARGA pasa por el MISMO selector que el de una foto de tablero suelta.
// Módulo puro: recibe el veredicto de `elegirOdometro` (lib/odometro-seleccion.ts) y decide qué km
// queda en la recarga y qué anomalía se levanta. Lo llama `accionCombustible` (lib/radar/acciones.ts).
//
// POR QUÉ EXISTE: las dos rutas del Radar leen el mismo tablero con el mismo modelo, y solo una
// pasaba por el selector. Un reporte de solo kilometraje recibía el colapso del dígito repetido
// (240,035 → 24,035, para confirmar), el rescate del trip/total intercambiado y el aviso «sobra un
// dígito»; el km del tablero de una RECARGA iba tal cual a `combustible.kilometraje`, a la fila del
// Radar y a `lecturas_odometro`. Con un dígito de más y sin historial de cargas en esa unidad, nada
// lo frenaba: el rendimiento (lo único que podía delatarlo) solo se mide en la flota propia, y en
// las tercerizadas —la mayoría de la flota, CUP-435 y CTV-370 entre ellas— el panel lo pre-llenaba con
// apenas un aviso en el campo.
//
// Las reglas son las de `accionOdometro`, una por una:
//   · `digito_repetido` → se PROPONE el número colapsado y BLOQUEA: el ERP lo dedujo, nadie lo
//     transcribió, y lo confirma una persona contra la foto (el `forzarRevision` del odómetro).
//     Salvo que OTRA lectura diga lo mismo (`testigo`, ver `testigoDe` en odometro-seleccion.ts):
//     entonces se usa sin bloquear, igual que la ruta del odómetro lo registra sin pedir revisión.
//   · `parcial` → el modelo cruzó el trip y el total: se usa el otro número que SÍ transcribió y
//     no bloquea (en la ruta del odómetro tampoco pide revisión), pero queda dicho.
//   · `decimal_como_entero` → el tambor de décimas entró como cifra y la transcripción del modelo
//     lo trae tras un punto: se usa la parte entera, como `parcial`; bloquea solo si no cuadra.
//   · `digito_de_mas` → sobra un dígito y no se puede deducir cuál: el número se deja como lo leyó
//     la IA y BLOQUEA. Auto-registrarlo escribiría un km diez veces mayor en la cadena de rendimiento
//     y en el odómetro de la unidad.
//   · lo demás (eco, fuera de banda, sin veredicto) → nada nuevo: el km queda como lo leyó la IA y
//     lo juzgan los controles de siempre (`juzgarKmDeRecarga`, el rendimiento, `registrarLectura`).

import type { VeredictoOdometro } from "../odometro-seleccion";
import type { AnomaliaCombustible } from "./tipos";

export type KmDeRecarga = {
  /** El km que queda en la recarga (el de la IA, o el que el selector propuso). */
  km: number | null;
  anomalia: AnomaliaCombustible | null;
};

export function kmDeRecarga(kmIA: number | null, v: VeredictoOdometro | null): KmDeRecarga {
  const sinCambio: KmDeRecarga = { km: kmIA, anomalia: null };
  if (kmIA == null || !v || v.km == null) return sinCambio;

  if (v.origen === "corregido" && (v.codigo === "digito_repetido" || v.codigo === "parcial" || v.codigo === "decimal_como_entero")) {
    // El colapso lo DEDUJO el ERP; el tambor de décimas lo transcribió el modelo, pero si no cuadra
    // con las lecturas de la unidad (historial en la escala de las décimas) tampoco se registra solo.
    // Se lee `confirmar` y no el código: es la MISMA bandera que decide el `forzarRevision` de la
    // foto de odómetro suelta, así que un colapso con testigo no bloquea en un carril y en el otro sí.
    const deducido = v.confirmar === true || !v.autoOk;
    return {
      km: v.km,
      anomalia: {
        codigo: "km_corregido",
        detalle: `Kilometraje del tablero: ${v.motivo ?? `la IA leyó ${kmIA} y se usó ${v.km}`}`,
        bloquea: deducido,
        // Lo que leyó la IA viaja aquí y no en la fila (que ya trae el corregido): si alguien lo
        // corrige a mano, la lección dice el error que la IA cometió, no uno que nunca hizo.
        correccion: { campo: "kilometraje", leido: kmIA, corregido: v.km },
      },
    };
  }

  if (v.codigo === "digito_de_mas") {
    return {
      km: kmIA,
      anomalia: { codigo: "km_digito_de_mas", detalle: `Kilometraje del tablero: ${v.motivo ?? "sobra un dígito"}`, bloquea: true },
    };
  }

  return sinCambio;
}
