// ──────────────────────────────────────────────────────────────────────────────
// lib/liquidacion-clases.ts — FIJO, ADICIONAL o EVENTUAL: de qué contrato viene el día.
//
// El cierre de un proveedor real mete en UNA sola tarjeta el transporte de personal de
// tres clientes, las salidas que esos clientes pidieron por encima del contrato y el bus
// que se alquiló un sábado para un tour. Son tres conciliaciones distintas —el fijo
// contra el contrato, el adicional contra la autorización que lo pidió, el eventual
// contra su cotización— y hasta ahora se revisaban todas juntas, en una lista de
// treinta y cuatro servicios donde nada decía cuál era cuál.
//
// SON DOS EJES, NO UNO, y por eso esto es una regla y no un campo:
//
//   · `tipo_servicio_detalle` dice si el servicio nació de un contrato recurrente
//     (transporte de personal) o de una venta suelta. Es el mismo criterio que ya usan
//     /programacion, /monitoreo, /calendario y /seguimiento — ver TIPOS_SERVICIO_FIJO.
//   · `origen_contractual` dice si, DENTRO de ese contrato, el día iba incluido o se
//     pidió aparte (supabase/reservas-04-servicios-adicionales.sql).
//
// LA MARCA EXPLÍCITA GANA. 'adicional' es un dato que alguien escribió; fijo/eventual se
// DERIVA de un tipo. Un adicional nace siempre de una cotización fija —es el único modo
// que ofrece ModalGenerarPrograma— así que en la práctica los dos ejes coinciden y el
// orden solo decide el caso raro: un servicio eventual al que alguien le marcó el origen
// a mano sale como adicional, que es lo que esa marca quiso decir.
//
// LA CLASE ES DEL DÍA, NO DEL TRAMO, y la declara el tramo que LLEVA EL IMPORTE: la
// misma regla de `origenDelPar` ("quien cobra, clasifica"). Leerla tramo a tramo sería
// un error caro y silencioso: el retorno va en S/ 0.00 a propósito, así que un retorno
// marcado a mano caería en un filtro distinto al de su ida y el desplegable PARTIRÍA EL
// DÍA EN DOS — el mismo destrozo que lib/liquidacion-hermanos.ts existe para impedir,
// esta vez entrando por la puerta de un filtro.
// ──────────────────────────────────────────────────────────────────────────────

import {
  origenContractual, origenDeTramos,
  type LadoLiquidacion, type ReservaLiq,
} from "@/lib/liquidacion-agrupacion";

/**
 * Los valores de `reservas.tipo_servicio_detalle` que nacen de una cotización con
 * `modo_servicio = 'fijo'` (los ids de SERVS_FIJO en /cotizaciones). Todo lo demás
 * —incluido el vacío— es una venta suelta: es el criterio literal de `esEventual()` en
 * /programacion, /monitoreo, /calendario, /seguimiento, lib/notificaciones y
 * lib/descarga-masiva, que mantienen su propia copia de esta lista para sus tipos
 * locales de reserva. Si algún día se agrega un tipo fijo, hay que tocarlas todas.
 */
export const TIPOS_SERVICIO_FIJO: ReadonlySet<string> = new Set([
  "transporte_personal",
  "fijo_solo_ida",
  "fijo_multiparada",
  "fijo_reten",
]);

/** Lo mínimo que hace falta para clasificar. No pide una `ReservaLiq` entera a propósito. */
export type ServicioClasificable = {
  tipo_servicio_detalle?: string | null;
  origen_contractual?: string | null;
};

export type ClaseServicio = "fijo" | "adicional" | "eventual";

/** ¿Nació de un contrato recurrente? Sin tipo escrito se asume que no, como el resto de la app. */
export const esServicioFijo = (r: ServicioClasificable | null | undefined): boolean =>
  TIPOS_SERVICIO_FIJO.has(String(r?.tipo_servicio_detalle ?? ""));

/**
 * La clase de UN TRAMO. Sirve para pintar una etiqueta al lado de un servicio suelto;
 * para filtrar o para cobrar hay que usar `claseDeTramos` / `claseDelDia`, que miran el
 * día completo.
 */
export function claseDeServicio(r: ServicioClasificable | null | undefined): ClaseServicio {
  if (origenContractual(r) !== "contrato") return "adicional";
  return esServicioFijo(r) ? "fijo" : "eventual";
}

/**
 * La clase de un CONJUNTO de tramos (el día, o una línea entera del documento).
 *
 * El origen lo deciden los tramos que llevan el importe (`origenDeTramos`); el eje
 * fijo/eventual basta con que lo declare uno, porque los dos tramos de un día se crean
 * juntos y comparten `tipo_servicio_detalle` — y si a uno le faltara, el que lo tiene es
 * el que sabe.
 */
export function claseDeTramos(filas: ReservaLiq[], lado: LadoLiquidacion): ClaseServicio {
  if (!filas.length) return "eventual";
  if (origenDeTramos(filas, lado) !== "contrato") return "adicional";
  return filas.some(esServicioFijo) ? "fijo" : "eventual";
}

/** La clase del día de un tramo: él y su hermano, si la base sabe cuál es. */
export const claseDelDia = (
  tramo: ReservaLiq,
  hermano: ReservaLiq | null | undefined,
  lado: LadoLiquidacion
): ClaseServicio => claseDeTramos(hermano ? [tramo, hermano] : [tramo], lado);

/**
 * Las opciones del filtro, en el orden en que se muestran. El texto es el que se lee en
 * la pantalla y en la ayuda: si cambia aquí, cambia en los dos sitios a la vez.
 */
export const CLASES_SERVICIO: readonly {
  clave: ClaseServicio;
  etiqueta: string;
  /** Se usa como `title` del desplegable: explica qué entra y qué no. */
  ayuda: string;
}[] = [
  {
    clave: "fijo",
    etiqueta: "Fijos",
    ayuda: "Transporte de personal contratado: lo que el contrato ya cubre.",
  },
  {
    clave: "adicional",
    etiqueta: "Adicionales",
    ayuda:
      "Lo que se pidió POR ENCIMA del contrato (origen adicional o contingencia). " +
      "Va en su propio subtotal del formato.",
  },
  {
    clave: "eventual",
    etiqueta: "Eventuales",
    ayuda:
      "Ventas sueltas: turismo, full day, traslados. Todo servicio que no nació de un " +
      "contrato fijo — incluidos los que se registraron sin tipo de servicio.",
  },
];

export const etiquetaClase = (c: ClaseServicio): string =>
  CLASES_SERVICIO.find((x) => x.clave === c)?.etiqueta ?? c;
