// lib/radar/reproceso.ts — Qué se retira y qué es INTOCABLE al reprocesar un mensaje.
// Módulo PURO (no toca la base), como coherencia-voucher.ts, identidad-voucher.ts y
// album-recargas.ts. Lo consume lib/radar/acciones.ts (ejecutarAccion) y lo prueba
// scripts/prueba-reproceso.mts.
//
// EL PROBLEMA. El botón "Reprocesar" de /radar-ia devuelve el mensaje a `pendiente` y vuelve a
// correr el pipeline entero — incluida la ACCIÓN. Y las acciones insertan: `radar_combustible`,
// `radar_oportunidades`, `radar_alertas`, y cuando el auto-registro está activo también
// `combustible` (el gasto real) y `mantenimiento` (la orden de trabajo). Ninguna de esas
// inserciones miraba si la corrida anterior ya las había hecho, así que **cada clic en
// Reprocesar duplicaba todo lo que el mensaje había creado**. Con dos vouchers en una ráfaga,
// un reproceso dejaba cuatro filas para dos recargas.
//
// La única que ya estaba resuelta es la lectura de odómetro: `registrarLectura` recibe un
// `idemKey` (`radar_odo_comb:<mensaje>`) y no duplica. Este módulo lleva esa misma idea al
// resto, con una línea que no se cruza:
//
//   **LO PROPUESTO SE RETIRA; LO COMPROMETIDO NO SE TOCA NI SE REPITE.**
//
// Una fila de `radar_combustible` en `pendiente_revision` es una propuesta: nadie la aceptó,
// reprocesar la reemplaza. Una en `registrado` ya escribió una fila en `combustible` — plata
// que vive en v_egresos, en el costo por km y en el margen del servicio: ni se borra (eso lo
// decide una persona en /combustible) ni se vuelve a crear. Lo mismo con una oportunidad que
// alguien ya cotizó y con una orden de mantenimiento ya abierta.
//
// CÓMO SE SABE QUE ES UN REPROCESO, sin columna nueva: `radar_mensajes.procesado_en` ya está
// escrito de la corrida anterior y el endpoint de reproceso NO lo limpia (solo toca `estado`,
// `error` y `accion`). Un mensaje con `procesado_en` que vuelve a entrar al pipeline es, por
// definición, un reproceso.

/** Una fila que la corrida anterior dejó, con lo justo para decidir su suerte. */
export type ArtefactoPrevio = {
  tabla: "radar_combustible" | "radar_oportunidades" | "radar_alertas";
  id: string;
  estado?: string | null;
  /** FK a un registro real ya comprometido (`combustible_id`, `cotizacion_id`…). */
  comprometido?: number | null;
};

export type PlanReproceso = {
  /** ids retirables por tabla: propuestas que nadie aceptó. */
  retirar: {
    radar_combustible: string[];
    radar_oportunidades: string[];
    radar_alertas: string[];
  };
  /** Este mensaje YA registró esta carga en `combustible`. Nunca se vuelve a registrar. */
  combustibleId: number | null;
  /** Este mensaje YA abrió esta orden en `mantenimiento`. */
  ordenMantenimientoId: number | null;
  /** Alguien ya trabajó una oportunidad de este mensaje (cotizada / revisada / descartada). */
  oportunidadTocada: boolean;
  /** Cuántas filas se van a retirar en total. */
  totalRetirar: number;
  /** Texto para el resultado del mensaje. "" si no hay nada que decir. */
  detalle: string;
};

const vacio = (): PlanReproceso => ({
  retirar: { radar_combustible: [], radar_oportunidades: [], radar_alertas: [] },
  combustibleId: null,
  ordenMantenimientoId: null,
  oportunidadTocada: false,
  totalRetirar: 0,
  detalle: "",
});

const entero = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

/**
 * Estados de `radar_combustible` que significan "esto ya se comprometió": la fila escribió una
 * carga en `combustible`. Se comprueba por el ESTADO **y** por el FK, porque cualquiera de los
 * dos por su cuenta puede faltar en filas viejas y la duda siempre se resuelve conservando.
 */
const combustibleComprometido = (a: ArtefactoPrevio) =>
  a.estado === "registrado" || entero(a.comprometido) != null;

/**
 * Una oportunidad solo es retirable mientras nadie la haya tocado. `nueva` es la que crea el
 * Radar; cotizada / revisada / descartada llevan una decisión humana detrás, y `cotizada`
 * además cuelga de una cotización real.
 */
const oportunidadIntacta = (a: ArtefactoPrevio) =>
  (a.estado ?? "nueva") === "nueva" && entero(a.comprometido) == null;

/**
 * Decide qué retirar antes de volver a ejecutar la acción de un mensaje.
 *
 * `previos` son las filas que el mensaje dejó en las tablas del Radar. `resultadoPrevio` es
 * `radar_mensajes.resultado` de la corrida anterior, del que salen los ids de los registros
 * REALES creados (`combustible_id`, `orden_id`): no hay columna que ate `combustible` ni
 * `mantenimiento` al mensaje, así que ese es el único rastro — y el endpoint de reproceso no
 * lo borra.
 */
export function planificarReproceso(
  previos: ArtefactoPrevio[],
  resultadoPrevio?: unknown
): PlanReproceso {
  const plan = vacio();

  for (const a of previos ?? []) {
    if (!a?.id) continue;
    if (a.tabla === "radar_combustible") {
      if (combustibleComprometido(a)) {
        plan.combustibleId ??= entero(a.comprometido);
        continue; // intocable: hay una carga real detrás
      }
      plan.retirar.radar_combustible.push(a.id);
    } else if (a.tabla === "radar_oportunidades") {
      if (oportunidadIntacta(a)) plan.retirar.radar_oportunidades.push(a.id);
      else plan.oportunidadTocada = true;
    } else if (a.tabla === "radar_alertas") {
      // Una alerta es un aviso, no un registro: se regenera con la corrida nueva.
      plan.retirar.radar_alertas.push(a.id);
    }
  }

  // Los registros REALES que no tienen columna hacia el mensaje se leen del resultado anterior.
  const datos = (resultadoPrevio as { accion?: { datos?: Record<string, unknown> } } | null)?.accion?.datos;
  plan.combustibleId ??= entero(datos?.combustible_id);
  plan.ordenMantenimientoId = entero(datos?.orden_id);

  plan.totalRetirar =
    plan.retirar.radar_combustible.length +
    plan.retirar.radar_oportunidades.length +
    plan.retirar.radar_alertas.length;
  plan.detalle = detalleDe(plan);
  return plan;
}

function detalleDe(p: PlanReproceso): string {
  const partes: string[] = [];
  if (p.totalRetirar) {
    const trozos: string[] = [];
    if (p.retirar.radar_combustible.length) trozos.push(`${p.retirar.radar_combustible.length} recarga(s) por revisar`);
    if (p.retirar.radar_oportunidades.length) trozos.push(`${p.retirar.radar_oportunidades.length} oportunidad(es) sin tocar`);
    if (p.retirar.radar_alertas.length) trozos.push(`${p.retirar.radar_alertas.length} alerta(s)`);
    partes.push(`Se retiró lo que dejó la corrida anterior (${trozos.join(", ")}) para no duplicarlo`);
  }
  if (p.combustibleId != null)
    partes.push(
      `este mensaje YA registró la carga #${p.combustibleId} en /combustible: no se vuelve a registrar ` +
        `(si hay que rehacerla, bórrala primero desde ahí)`
    );
  if (p.ordenMantenimientoId != null)
    partes.push(`este mensaje YA abrió la orden de mantenimiento #${p.ordenMantenimientoId}: no se vuelve a abrir`);
  if (p.oportunidadTocada)
    partes.push(`una oportunidad de este mensaje ya fue trabajada: se conservó y no se crea otra`);
  return partes.join(" · ");
}
