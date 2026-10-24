// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/simular-idioma.ts — El idioma de una SIMULACIÓN de traslado (/tarifario → Simulador,
// POST /api/traslados/simular). Motor PURO: no lee la base (el interruptor del inglés lo lee la ruta
// con `leerInglesTraslado` y se lo pasa). Matriz: la sección 25 de scripts/prueba-traslados-ia.mts.
//
// LA MISMA REGLA QUE LA IA (`entradaDelAgente`, lib/traslados/envio-ia.ts): la entrada lleva
// `idioma_cliente` (y `pide_soles`) solo con el cliente en inglés u otro idioma Y el inglés
// encendido; si no, se le quitan (castellano, la moneda de siempre). La diferencia, declarada: aquí
// `pide_soles` llega tal cual de la pantalla (un campo de prueba de un usuario con el módulo
// «tarifas»), sin la doble confirmación del chat.
//
// `mensajes_cliente` llega en el orden del chat (del más antiguo al más reciente) y se invierte para
// `idiomaDelCliente`, que los quiere del más reciente al más antiguo. Sin mensajes vale el
// `idioma_cliente` pedido («en» u «otro»).
//
// UNA LECTURA QUE FALLA NO ES UN INGLÉS APAGADO: `no_se_pudo_leer` con el error en `detalle` (se
// simula en castellano, que es lo que haría la IA mientras no pueda leer el interruptor); el
// `ingles_apagado` queda para «no hay plantilla en inglés asignada» o «falta la tabla».
// ──────────────────────────────────────────────────────────────────────────────

import type { EntradaSimulador, IdiomaSimulado } from "./api";
import { inglesActivo, SQL_REGLAS_TRASLADO, type InglesTraslado } from "../cotizacion-plantillas";
import { idiomaDelCliente, type IdiomaCliente, type MensajeParaIdioma } from "../idioma-cliente";

/** Lo que se mira de `mensajes_cliente` (no medido: lo que cabe en la caja de texto de la pantalla). */
export const MAX_MENSAJES_CLIENTE = 10;
export const MAX_CARACTERES_MENSAJE = 500;

/**
 * `mensajes_cliente` del cuerpo: null si no viene; un error si no es una lista de textos o pasa de
 * `MAX_MENSAJES_CLIENTE`. Cada texto se recorta a `MAX_CARACTERES_MENSAJE` (por caracteres completos).
 */
export function mensajesDelCuerpo(cuerpo: unknown): { ok: true; mensajes: string[] | null } | { ok: false; detalle: string } {
  const v = cuerpo && typeof cuerpo === "object" ? (cuerpo as Record<string, unknown>).mensajes_cliente : undefined;
  if (v == null) return { ok: true, mensajes: null };
  if (!Array.isArray(v) || v.some((m) => typeof m !== "string")) return { ok: false, detalle: "«mensajes_cliente» tiene que ser una lista de textos." };
  if (v.length > MAX_MENSAJES_CLIENTE) return { ok: false, detalle: `Como mucho ${MAX_MENSAJES_CLIENTE} mensajes del cliente.` };
  // Se corta ANTES de partir en caracteres: `Array.from` sobre un texto entero de megas haría el trabajo
  // (y la memoria) de todo el texto para quedarse con 500. 2 × el tope en unidades UTF-16 contiene al
  // menos el tope en caracteres completos (un carácter ocupa una o dos).
  return { ok: true, mensajes: (v as string[]).map((m) => Array.from(m.slice(0, 2 * MAX_CARACTERES_MENSAJE)).slice(0, MAX_CARACTERES_MENSAJE).join("")).filter((m) => m.trim()) };
}

const NOMBRE_CLIENTE: Record<IdiomaCliente, string> = { es: "castellano", en: "inglés", otro: "otro idioma" };

/**
 * El idioma de la simulación con el MISMO interruptor que la IA (`entradaDelAgente`): la entrada
 * lleva `idioma_cliente` (y `pide_soles`) solo con el cliente en inglés u otro idioma y el inglés
 * encendido; si no, se le quitan (castellano, la moneda de siempre).
 */
export function idiomaDeLaSimulacion(
  entrada: EntradaSimulador,
  x: { mensajes: string[] | null; idiomaPedido: unknown; pideSoles: boolean; ingles: InglesTraslado | null; errorIngles: string | null },
  ahoraMs: number = Date.now(),
): { entrada: EntradaSimulador; idioma: IdiomaSimulado } {
  // La detección de la IA sobre lo que escribió el cliente (del más reciente al más antiguo); sin
  // mensajes, el idioma que se pidió para probar.
  let cliente: IdiomaCliente | null;
  let detalle: string;
  if (x.mensajes && x.mensajes.length) {
    const lista: MensajeParaIdioma[] = [...x.mensajes].reverse().map((contenido) => ({ contenido, tipo: "texto", created_at: null }));
    const d = idiomaDelCliente(lista, ahoraMs);
    cliente = d.idioma;
    detalle = d.detalle;
  } else if (x.idiomaPedido === "en" || x.idiomaPedido === "otro") {
    cliente = x.idiomaPedido;
    detalle = `Se simula un cliente que escribe en ${NOMBRE_CLIENTE[cliente]}.`;
  } else {
    cliente = null;
    detalle = "Sin mensajes del cliente: se simula un cliente en castellano.";
  }
  // La entrada sin las claves del idioma ni de la moneda pedida (se vuelven a poner abajo, si aplican).
  const base: EntradaSimulador = { ...entrada };
  delete base.idioma_cliente;
  delete base.pide_soles;
  const fuera = cliente === "en" || cliente === "otro";
  if (!fuera) {
    return { entrada: base, idioma: { idioma: "es", cliente, codigo: cliente === "es" ? "castellano" : "sin_evidencia", detalle } };
  }
  // Una lectura que falla NO es «el inglés está apagado»: se dice con su propio código y el error,
  // y se simula en castellano (lo que haría la IA: sin poder leer el interruptor, castellano).
  if (x.errorIngles !== null) {
    return {
      entrada: base,
      idioma: {
        idioma: "es", cliente, codigo: "no_se_pudo_leer",
        detalle: `${detalle} No se pudo saber si el inglés está encendido (no se pudieron leer las plantillas o sus reglas: ${x.errorIngles}). Se simula en castellano, que es lo que haría la IA mientras no se puedan leer.`,
      },
    };
  }
  if (!inglesActivo(x.ingles)) {
    const porque = x.ingles === null
      ? `falta correr ${SQL_REGLAS_TRASLADO}`
      : "ninguna celda «inglés» de la regla del traslado tiene una plantilla en inglés que la IA pueda usar";
    return {
      entrada: base,
      idioma: { idioma: "es", cliente, codigo: "ingles_apagado", detalle: `${detalle} Inglés apagado (${porque}): la cotización sale en castellano y con la moneda de siempre, como hoy.` },
    };
  }
  // Soles y dólares a la vez: ninguno (manda el defecto del idioma), como en la IA.
  const pideSoles = x.pideSoles && entrada.pide_dolares !== true;
  const pideDolares = entrada.pide_dolares === true && !x.pideSoles;
  const sinDolares: EntradaSimulador = { ...base };
  delete sinDolares.pide_dolares;
  const senales = pideSoles && Array.isArray(base.senales) ? base.senales.filter((sn) => sn !== "otra_moneda") : base.senales;
  return {
    entrada: {
      ...sinDolares, senales, ...(pideDolares ? { pide_dolares: true } : {}),
      idioma_cliente: cliente as "en" | "otro", ...(pideSoles ? { pide_soles: true as const } : {}),
    },
    idioma: { idioma: "en", cliente, codigo: cliente === "en" ? "ingles" : "otro_idioma", detalle },
  };
}
