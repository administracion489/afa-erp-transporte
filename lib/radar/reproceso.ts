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

import { miembrosDelMismoRemitente, pareceCombustible, remitenteUtilizable, type RemitenteRadar } from "./cluster-remitente";

// ── El estado de un mensaje después de su acción ─────────────────────────────

/**
 * Una acción que FALLÓ deja el mensaje en `error`, nunca en `procesado`. Del 14/09 al 06/10 el motor
 * marcó «Procesado» en verde cada recarga que no se guardó —el `error_accion` iba escondido dentro
 * del detalle—, y la única forma de enterarse era descubrir que faltaban en /combustible.
 */
export function estadoTrasAccion(accion: string | null | undefined): "error" | "procesado" {
  return accion === "error_accion" ? "error" : "procesado";
}

/**
 * Qué mensajes FALLARON, como filtro `.or()` de PostgREST: los que terminaron en `error` y los que
 * quedaron `procesado` con la acción fallida (así los dejó el motor antes de este arreglo). Es el
 * MISMO filtro para la pantalla que los cuenta y para el botón que los reprocesa: si fueran dos, la
 * pantalla podría prometer N y el botón reprocesar otros.
 */
export const FILTRO_FALLIDOS = "accion.eq.error_accion,estado.eq.error";

// ── Reprocesar un mensaje CON su ráfaga ──────────────────────────────────────

export type MensajeRafaga = RemitenteRadar & {
  id: string;
  estado: string;
  accion?: string | null;
  grupo_id?: string | null;
  recibido_en: string;
  /** `tipo` y `texto` deciden si el mensaje puede ser parte de un reporte (`pareceCombustible`). */
  tipo?: string | null;
  texto?: string | null;
  resultado?: unknown;
};

export const fusionadoEn = (r: unknown): string =>
  r && typeof r === "object" ? String((r as Record<string, unknown>).fusionado_en ?? "") : "";

/** ¿Falló? La misma definición que FILTRO_FALLIDOS, para un mensaje ya leído. */
export const esFallido = (m: { estado?: string | null; accion?: string | null }): boolean =>
  m.estado === "error" || m.accion === "error_accion";

/**
 * Lo que el motor todavía no TERMINÓ: falló, o sigue en la cola. Las dos cosas cuentan como parte
 * de una ráfaga que se reprocesa: un mensaje pendiente más antiguo que el reprocesado se llevaría al
 * reprocesado fundido —el motor junta en el más antiguo— y nadie procesaría ese en esta llamada.
 */
export const sinTerminar = (m: { estado?: string | null; accion?: string | null }): boolean =>
  m.estado !== "fusionado" && m.estado !== "procesando" && (esFallido(m) || m.estado === "pendiente");

/** El mismo criterio, como filtro `.or()` de PostgREST (los de `sinTerminar` que no excluye el estado). */
export const FILTRO_SIN_TERMINAR = `${FILTRO_FALLIDOS},estado.eq.pendiente`;

/**
 * Desde DÓNDE se reprocesa. Un mensaje `fusionado` no se relee solo: lo que traía ya viajó en la
 * extracción de la principal en que se fundió, y leído aislado propondría una recarga hecha con UNA
 * foto al lado de la buena. Se reprocesa la ráfaga entera, desde su principal.
 */
export function raizDeReproceso(m: { id: string; estado?: string | null; resultado?: unknown }): string {
  return (m.estado === "fusionado" && fusionadoEn(m.resultado)) || m.id;
}

const instante = (m: { recibido_en: string }): number => {
  const t = Date.parse(m.recibido_en);
  return Number.isFinite(t) ? t : Number.NaN;
};

export type RafagaAReactivar = {
  /** Todo lo que vuelve a `pendiente`, `principal` incluido; lo sin terminar va del más viejo al más nuevo. */
  ids: string[];
  /** El que se procesa primero: el MÁS ANTIGUO de la ráfaga, que es el que el motor toma como principal. */
  primaria: string;
};

/**
 * Qué mensajes hay que devolver a `pendiente`, y DESDE CUÁL procesar, para que `principal` se
 * reprocese CON SU RÁFAGA.
 *
 * Un reporte de recarga llega en varias fotos —el tablero, el surtidor, la nota— y el motor las
 * funde en la más antigua: las demás quedan en `fusionado`. Y la búsqueda de la ráfaga EXCLUYE a
 * las fusionadas (`resolverCluster`), así que reprocesar la principal la analizaba SOLA: con el
 * caption o el tablero y sin la nota de despacho, que casi siempre va al final. El reproceso de las
 * tres semanas en que el Radar no guardó nada habría perdido justo los importes.
 *
 *  1. Lo SIN TERMINAR que el motor juntaría con `principal`, con la MISMA regla de `resolverCluster`
 *     —mismo `remitente_wa` guardado (la consulta filtra así), la misma persona según
 *     `miembrosDelMismoRemitente` (un jid vacío no junta a nadie), el mismo grupo y con pinta de
 *     reporte (`pareceCombustible`)—, ENCADENADO: entra lo que esté a menos de una ventana de algo que
 *     ya entró, hacia los dos lados. El motor agrupa alrededor del que procesa, así que un eslabón
 *     suelto más viejo se llevaría fundido al resto.
 *  2. Lo que se fundió en cualquiera de ellos (`resultado.fusionado_en`).
 *
 * Y SE PROCESA DESDE EL MÁS ANTIGUO, no desde el que se pulsó: reprocesar otro lo fundiría en uno que
 * esta llamada no procesa —y cuando ese se procesara después, el recién fundido ya estaría excluido—.
 * Quien llama procesa después, en orden, lo que haya quedado en la cola (ver `reprocesarMensaje`).
 *
 * `yaIntentadosHasta` es el cursor del reproceso en lote: lo FALLIDO hasta ahí ya se intentó en esta
 * pasada y no se vuelve a pagar por arrastre (lo pendiente sí entra: nadie lo intentó).
 */
export function rafagaAReactivar(
  principal: MensajeRafaga,
  candidatos: MensajeRafaga[],
  ventanaMs: number,
  opts?: { yaIntentadosHasta?: string | null }
): RafagaAReactivar {
  const corte = opts?.yaIntentadosHasta ? Date.parse(opts.yaIntentadosHasta) : Number.NaN;
  const juntable =
    !!principal.grupo_id && Number.isFinite(instante(principal)) && pareceCombustible(principal) && remitenteUtilizable(principal);
  const pool = juntable
    ? miembrosDelMismoRemitente(
        principal,
        (candidatos ?? []).filter(
          (c) =>
            c?.id && c.id !== principal.id && sinTerminar(c) &&
            c.grupo_id === principal.grupo_id && c.remitente_wa === principal.remitente_wa && pareceCombustible(c) &&
            Number.isFinite(instante(c)) && !(esFallido(c) && instante(c) <= corte)
        )
      )
    : [];

  // Encadenado: cada uno que entra trae a los que tenga a menos de una ventana.
  const componente: MensajeRafaga[] = [principal];
  const resto = [...pool];
  for (let i = 0; i < componente.length; i++) {
    for (let j = resto.length - 1; j >= 0; j--) {
      if (Math.abs(instante(resto[j]) - instante(componente[i])) <= ventanaMs) componente.push(...resto.splice(j, 1));
    }
  }
  const orden = componente.length > 1
    ? [...componente].sort((a, b) => instante(a) - instante(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    : componente;
  const enComponente = new Set(orden.map((m) => m.id));
  const fundidas = (candidatos ?? []).filter(
    (c) => c?.id && !enComponente.has(c.id) && c.estado === "fusionado" && enComponente.has(fusionadoEn(c.resultado))
  );
  return { ids: [...orden, ...fundidas].map((m) => m.id), primaria: orden[0].id };
}

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
