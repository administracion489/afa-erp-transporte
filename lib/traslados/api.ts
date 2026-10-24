// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/api.ts — El contrato de POST /api/traslados/simular, compartido por la pantalla
// (/tarifario → Zonas y traslados → Simulador) y el servidor. Motor PURO.
//
// La misma entrada la usa la herramienta `cotizar_traslado` del agente IA del CRM: el simulador
// no es una imitación del cotizador automático, ES el cotizador automático sin enviar nada.
// ──────────────────────────────────────────────────────────────────────────────

import { SENALES, type PuntoUbicado, type ResultadoTraslado, type SenalComplejidad, type Sentido } from "./motor";
import type { CodigoRevision } from "./envio-ia";
import type { CeldaTraslado, CodigoUso, Segmento } from "../cotizacion-plantillas";
import type { CodigoIdiomaCliente, IdiomaCliente } from "../idioma-cliente";

/** Un punto: el texto que escribió el cliente, o coordenadas (un pin del mapa o de WhatsApp). */
export type LugarEntrada = string | { lat: number; lng: number; texto?: string };

export type EntradaSimulador = {
  origen: LugarEntrada;
  destino: LugarEntrada;
  fecha_servicio: string | null;
  hora_servicio?: string | null;
  sentido: Sentido | null;
  fecha_retorno?: string | null;
  hora_retorno?: string | null;
  pax: number | null;
  maletas: number | null;
  telefono: string | null;
  /**
   * El cliente pidió la cotización en dólares: se cotiza con la lista en dólares aunque el número
   * sea peruano (`monedaDelPedido`). En el agente IA solo llega `true` si sus propios mensajes
   * nombran los dólares (`entradaDelAgente`). Ausente = la moneda la decide el número.
   */
  pide_dolares?: boolean;
  /**
   * El cliente escribe en inglés («en») u otro idioma («otro»): lo deriva el CÓDIGO
   * (lib/idioma-cliente.ts) y solo con el inglés encendido (`inglesActivo`). Mueve la moneda por
   * defecto (`monedaDelPedido`). Ausente = castellano, la entrada de siempre.
   */
  idioma_cliente?: "en" | "otro";
  /** El cliente que escribe en inglés u otro idioma pidió soles (verificado). Solo junto a `idioma_cliente`. */
  pide_soles?: true;
  paradas_intermedias?: number | null;
  fechas_adicionales?: number | null;
  vehiculos_pedidos?: number | null;
  senales?: SenalComplejidad[] | null;
};

export type CodigoUbicar = "ok" | "no_encontrado" | "sin_clave" | "error" | "vacio";

export type LugarUbicado = { codigo: CodigoUbicar; detalle: string; punto: PuntoUbicado | null };

/**
 * Qué haría la IA del CRM con esta cotización: enviarla sola o dejarla para revisar, con sus
 * motivos (lib/traslados/envio-ia.ts → `planEnvio`). En el simulador se supone WhatsApp con el
 * número escrito, el agente en modo autónomo y el PDF armado; el perfil y las zonas son los reales.
 * Solo viene con un resultado cotizable.
 */
export type EnvioSimulado = { decision: "automatico" | "revision"; motivos: CodigoRevision[] };

/**
 * De dónde saca la IA las condiciones del PDF de esta cotización (lib/traslados/plantilla-traslado-datos.ts):
 * `plantilla` es la plantilla PDF de la regla «Traslado de la IA × segmento» (en el simulador el
 * segmento sale solo de la moneda: no hay cliente del ERP), o null si usa las de Ajustes de traslados.
 * `condiciones` lo dice SIEMPRE, con el código y la frase de `plantillaParaUso`: con `plantilla`
 * null, «falta el SQL» (`sin_reglas`) y «no hay una plantilla que la IA pueda usar» (`sin_plantilla`)
 * se arreglan en sitios distintos. Solo vienen con un resultado cotizable.
 */
export type PlantillaSimulada = { id: string; nombre: string; segmento: Segmento; codigo: CodigoUso; celda?: CeldaTraslado };
export type CondicionesSimuladas = {
  fuente: "plantilla" | "ajustes"; segmento: Segmento; codigo: CodigoUso; detalle: string;
  /**
   * La celda idioma × moneda de la regla nueva (`cotizacion_plantilla_reglas_traslado`) que eligió
   * la plantilla. Ausente = la regla vieja por segmento (sin la migración); entonces manda `segmento`.
   */
  celda?: CeldaTraslado;
};

/**
 * En qué idioma sale la cotización y por qué. `idioma` es el del PDF y los mensajes; `cliente`, el
 * que se detectó en sus mensajes (null = sin evidencia). `ingles_apagado`: el cliente escribe en
 * inglés u otro idioma pero ninguna celda «inglés» tiene una plantilla en inglés que la IA pueda
 * usar (o falta la tabla de cotizaciones-09), así que sale en castellano y con la moneda de siempre.
 * `no_se_pudo_leer`: no se pudo saber si el inglés está encendido (falló la lectura de las plantillas
 * o sus reglas; el error va en `detalle`): NO es un inglés apagado. En los dos se simula en castellano.
 */
export type IdiomaSimulado = { idioma: "es" | "en"; cliente: IdiomaCliente | null; codigo: CodigoIdiomaCliente | "ingles_apagado" | "no_se_pudo_leer"; detalle: string };

export type RespuestaSimulador =
  | {
    ok: true; resultado: ResultadoTraslado; lugares: { origen: LugarUbicado; destino: LugarUbicado }; envio?: EnvioSimulado;
    plantilla?: PlantillaSimulada | null; condiciones?: CondicionesSimuladas; idioma?: IdiomaSimulado;
  }
  | { ok: false; codigo: "sin_migracion" | "entrada_invalida" | "error"; detalle: string };

const MAX_TEXTO = 300;

/** Una fecha YYYY-MM-DD que EXISTE: «2026-02-30» pasa la expresión regular y V8 la acepta como 2 de marzo. */
export function fechaReal(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function coordenada(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}

/** La caja de Perú (no medida, con margen): fuera de ella no se puede cotizar y no se gasta Google. */
export function dentroDePeru(lat: number, lng: number): boolean {
  return lat >= -18.5 && lat <= 0 && lng >= -81.5 && lng <= -68.5;
}

/** Valida y limpia la entrada. Devuelve el motivo si no sirve. Las ausencias no son error: el motor las pregunta. */
export function validarEntrada(x: unknown): { ok: true; entrada: EntradaSimulador } | { ok: false; detalle: string } {
  if (!x || typeof x !== "object") return { ok: false, detalle: "Falta el pedido." };
  const o = x as Record<string, unknown>;
  const lugar = (v: unknown, nombre: string): LugarEntrada | { error: string } => {
    if (typeof v === "string") return v.trim().slice(0, MAX_TEXTO);
    if (v && typeof v === "object") {
      const p = v as Record<string, unknown>;
      // `Number(null)`, `Number("")` y `Number([])` valen 0: un punto sin coordenadas sería el (0, 0),
      // en medio del Atlántico, y costaría una geocodificación inversa. Se exige un número de verdad.
      const lat = coordenada(p.lat), lng = coordenada(p.lng);
      if (lat == null || lng == null) return { error: `Coordenadas inválidas en ${nombre}.` };
      if (!dentroDePeru(lat, lng)) return { error: `Las coordenadas de ${nombre} están fuera de Perú.` };
      return { lat, lng, texto: typeof p.texto === "string" ? p.texto.slice(0, MAX_TEXTO) : undefined };
    }
    return "";
  };
  const origen = lugar(o.origen, "el origen");
  const destino = lugar(o.destino, "el destino");
  if (typeof origen === "object" && "error" in origen) return { ok: false, detalle: origen.error };
  if (typeof destino === "object" && "error" in destino) return { ok: false, detalle: destino.error };
  const fecha = (v: unknown) => (fechaReal(v) ? v : null);
  const hora = (v: unknown) => (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d/.test(v) ? v.slice(0, 5) : null);
  const num = (v: unknown, max: number) => {
    if (v == null || v === "") return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
  };
  const sentido = o.sentido === "ida" || o.sentido === "ida_retorno" ? o.sentido : null;
  const senales = Array.isArray(o.senales)
    // Propiedad PROPIA y no `in`: «constructor» o «__proto__» están «in» cualquier objeto.
    ? [...new Set(o.senales.filter((s): s is SenalComplejidad => typeof s === "string" && Object.prototype.hasOwnProperty.call(SENALES, s)))]
    : [];
  return {
    ok: true,
    entrada: {
      origen: origen as LugarEntrada, destino: destino as LugarEntrada,
      fecha_servicio: fecha(o.fecha_servicio), hora_servicio: hora(o.hora_servicio),
      sentido, fecha_retorno: fecha(o.fecha_retorno), hora_retorno: hora(o.hora_retorno),
      pax: num(o.pax, 500), maletas: num(o.maletas, 1000),
      telefono: typeof o.telefono === "string" ? o.telefono.trim().slice(0, 40) : null,
      // Solo un `true` de verdad (no «true» en texto ni 1), y la clave solo cuando lo es: sin
      // pedido de dólares, la entrada es la de siempre.
      ...(o.pide_dolares === true ? { pide_dolares: true } : {}),
      // El idioma, solo «en» u «otro» (el castellano es la ausencia), y el pedido de soles solo
      // `true` y solo JUNTO al idioma: en castellano, pedir soles desde un número extranjero sigue
      // yendo a un ejecutivo (`monedaDelPedido` no lo mira sin idioma). Las claves solo cuando
      // aplican: sin idioma, la entrada es byte a byte la de siempre.
      ...(o.idioma_cliente === "en" || o.idioma_cliente === "otro" ? { idioma_cliente: o.idioma_cliente } : {}),
      ...((o.idioma_cliente === "en" || o.idioma_cliente === "otro") && o.pide_soles === true ? { pide_soles: true as const } : {}),
      paradas_intermedias: num(o.paradas_intermedias, 50), fechas_adicionales: num(o.fechas_adicionales, 365),
      vehiculos_pedidos: num(o.vehiculos_pedidos, 50), senales,
    },
  };
}
