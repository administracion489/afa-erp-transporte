// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/envio-ia.ts — La IA del CRM cotiza un traslado: qué datos acepta del modelo, qué
// le devuelve, y si la cotización se ENVÍA sola o queda para que la revise un ejecutivo.
// Motor PURO: no lee la base, no llama a Google ni a Meta. Lo usan el agente (lib/crm-ia.ts), el
// orquestador del servidor y la pantalla de Ajustes de /tarifario.
//
// LAS REGLAS QUE NO SE AFLOJAN:
//  1. EL MODELO NO DECIDE NADA DE DINERO. El esquema de la herramienta no tiene teléfono, moneda,
//     precio ni destinatario: la moneda sale del número de WhatsApp del REMITENTE (lo pone el
//     webhook, no el modelo), el precio sale del tarifario, y el PDF va a quien escribió.
//     `actualizar_contacto` deja al modelo escribir el teléfono del contacto: por eso aquí no se
//     lee `contacto.telefono` jamás, solo el `wa_id` de la conversación. La única puerta a la
//     moneda es `cliente_pide_dolares`, y no basta con el modelo: vale solo si los mensajes del
//     PROPIO cliente nombran los dólares (`nombraDolares`), y solo puede llevar a la lista en
//     dólares que alguien tecleó (`monedaDelPedido`), nunca a un precio.
//  2. LAS COORDENADAS SOLO SALEN DE UNA UBICACIÓN COMPARTIDA: aparecen TAL CUAL en el enlace
//     maps.google.com/?q=lat,lng que deja el webhook en un mensaje ENTRANTE de tipo «location»
//     (lib/crm-ingesta.ts). Un enlace pegado en un mensaje de texto no cuenta. OJO: esto NO protege
//     contra el cliente — la ubicación la elige él, y mandar el pin del aeropuerto equivale a
//     escribir «Aeropuerto» —; solo impide que el MODELO invente un pin. La protección de lo que
//     sale impreso es la 3: el texto libre no se imprime sin revisión (./texto-libre.ts).
//  3. NADA SALE SOLO SI NO LO DICE TODO A LA VEZ (`planEnvio`): resultado cotizable, el maestro
//     encendido, alguna de las dos zonas marcada, WhatsApp con remitente, agente autónomo, perfil
//     de la empresa configurado, importes que cuadran, PDF armado, sin palabras de pedido complejo
//     y sin texto libre sospechoso (enlaces, números largos, importes, palabras de pago o más de 80
//     caracteres en el recojo, el destino o el nombre). Cualquier otro caso queda en REVISIÓN con
//     sus motivos declarados.
//  4. AL MODELO SE LE DEVUELVE UNA LISTA BLANCA (`respuestaParaModelo`): ni la explicación del
//     motor (trae alias, el precio del distrito, la fuente del tipo de cambio), ni ids, ni el
//     nivel de la tarifa. En revisión, ningún importe: si el modelo no lo tiene, no lo puede
//     escribir. Y el TEXTO del turno lo decide `textoFinalTraslado`: con una cotización, el mensaje
//     lo escribe SIEMPRE el código; sin ella (preguntar o derivar), el del modelo solo pasa si no
//     menciona dinero.
//  5. LOS TEXTOS DEL CÓDIGO HABLAN COMO EL AGENTE (20-10-2026). El trato (usted / tú) y el modo de
//     preguntar (todo junto / uno por mensaje) salen del MISMO ajuste del agente que lee el prompt
//     (lib/crm-ia-ajustes.ts → `estiloDe`): un prompt de usted y un mensaje del código que tutea son
//     dos voces en el chat. Por eso `estilo` es OBLIGATORIO en los textos que ve el cliente; la
//     instrucción al modelo (`respuestaParaModelo`) lo recibe opcional y, sin él, es la de siempre.
//  6. EL IDIOMA LO DECIDE EL CÓDIGO (22-10-2026), y mueve la moneda: un cliente en inglés recibe la
//     lista en dólares aunque escriba desde un +51. Por eso el modelo no lo declara: lo deriva
//     lib/idioma-cliente.ts de los mensajes del cliente y llega aquí como `idioma` de
//     `entradaDelAgente`, que solo lo deja pasar con el inglés ENCENDIDO (`inglesActivo`: una
//     plantilla en inglés asignada a una celda «inglés»). Los textos del código tienen una rama en
//     inglés escrita entera (una sola versión: el inglés no distingue tú y usted) y la eligen con
//     `estilo.idioma`; ausente, castellano byte a byte. Pedir SOLES se confirma dos veces como los
//     dólares (`cliente_pide_soles` + `nombraSoles`) y solo cuenta en inglés u otro idioma.
// ──────────────────────────────────────────────────────────────────────────────

import type { EntradaSimulador, LugarEntrada } from "./api";
import {
  FALTA, SENALES, claveNombre, monedaDelPedido,
  type PrecioTraslado, type ResultadoTraslado, type Zona,
} from "./motor";
import { totalesEnMoneda, normalizarMoneda } from "../cotizacion-moneda";
import { fmtFechaDoc, fmtImporte, normalizarIdioma, type Idioma } from "../cotizacion-idioma";
import { LINEA_DISPONIBILIDAD, LINEA_DISPONIBILIDAD_EN, lineaDisponibilidad } from "./cotizacion-traslado";
import {
  condicionesSospechosas, importesEnTexto, mencionaDinero, referenciaImprimible, textoLibreSospechoso,
  type CondicionSospechosa, type IdiomaTexto, type MotivoTextoLibre,
} from "./texto-libre";
import {
  excesoCondiciones, inglesActivo, MAX_CARACTERES_CONDICION, MAX_LINEAS_CONDICIONES, SQL_REGLAS_TRASLADO, etiquetaCeldaTraslado,
  type InglesTraslado,
} from "../cotizacion-plantillas";
import type { EstiloMensajes, ModoPreguntas } from "../crm-ia-ajustes";
import type { IdiomaCliente } from "../idioma-cliente";

// ── 1. La herramienta ────────────────────────────────────────────────────────

const CLAVES_SENALES = Object.keys(SENALES);

const DESC_INICIO =
  "Cotiza un TRASLADO SIMPLE: un punto de recojo → un destino, solo ida o ida y retorno, en una sola fecha y con un solo vehículo " +
  "(p. ej. aeropuerto ↔ hotel o domicilio). El PRECIO, el vehículo, la moneda y la validez los pone el sistema con el tarifario: " +
  "tú NO calculas ni escribes precios por tu cuenta; repite solo los que te devuelva esta herramienta. " +
  "Llámala en cuanto el cliente pida precio de un traslado, aunque falten datos: la respuesta te dice qué preguntar. " +
  "No la uses para licitaciones, TDR, eventos, tours, varias fechas o varios vehículos: marca esas señales y el sistema lo pasa a un ejecutivo. ";
/** La frase de la moneda de siempre (con el inglés apagado). */
const DESC_MONEDA =
  "La moneda la decide el número del cliente (Perú → soles; otro país → dólares). Si el cliente pidió expresamente la cotización EN DÓLARES, " +
  "marca cliente_pide_dolares: el sistema lo comprueba en sus mensajes y cotiza con la lista en dólares. Cualquier otra moneda es la señal otra_moneda. ";
/** La frase de la moneda con el inglés encendido: la moneda por defecto depende del idioma, que lo decide el sistema. */
const DESC_MONEDA_INGLES =
  "La moneda la decide el sistema según el idioma en que escribe el cliente: castellano → por su número (Perú → soles; otro país → dólares); " +
  "inglés → dólares; otro idioma → por su número. Si el cliente pidió expresamente la cotización EN DÓLARES, marca cliente_pide_dolares; " +
  "si la pidió EN SOLES, marca cliente_pide_soles: el sistema lo comprueba en sus mensajes (en castellano desde un número extranjero, los soles " +
  "los ve un ejecutivo: marca otra_moneda). Cualquier otra moneda es la señal otra_moneda. ";
const DESC_FIN =
  "Las coordenadas solo si el cliente compartió su ubicación por WhatsApp (cópialas del enlace maps.google.com/?q=lat,lng de ESE mensaje). " +
  "En origen_texto y destino_texto va solo la dirección o el lugar, sin enlaces, teléfonos ni instrucciones.";

/**
 * La herramienta `cotizar_traslado`. Con `ingles: false` es EXACTAMENTE la de siempre (texto y
 * propiedades en el mismo orden: `HERRAMIENTA_COTIZAR_TRASLADO`). Con el inglés encendido cambia la
 * frase de la moneda y aparece `cliente_pide_soles`. El idioma NO es una propiedad: el modelo no lo
 * declara (lo deriva el código, y mueve la moneda).
 */
export function herramientaCotizarTraslado(o: { ingles: boolean }) {
  return {
  name: "cotizar_traslado" as const,
  description: DESC_INICIO + (o.ingles ? DESC_MONEDA_INGLES : DESC_MONEDA) + DESC_FIN,
  input_schema: {
    type: "object",
    properties: {
      origen_texto: { type: "string", description: "Punto de recojo tal como lo dijo el cliente (dirección, hotel, «Aeropuerto Jorge Chávez»)." },
      origen_lat: { type: "number", description: "Latitud del recojo, SOLO si viene de una ubicación compartida en este chat." },
      origen_lng: { type: "number", description: "Longitud del recojo, SOLO si viene de una ubicación compartida en este chat." },
      destino_texto: { type: "string", description: "Destino tal como lo dijo el cliente." },
      destino_lat: { type: "number", description: "Latitud del destino, SOLO si viene de una ubicación compartida en este chat." },
      destino_lng: { type: "number", description: "Longitud del destino, SOLO si viene de una ubicación compartida en este chat." },
      fecha_servicio: { type: "string", description: "Fecha de la ida, YYYY-MM-DD." },
      hora_servicio: { type: "string", description: "Hora de recojo de la ida, HH:MM (24 h)." },
      sentido: { type: "string", enum: ["ida", "ida_retorno"], description: "Solo ida, o ida y retorno." },
      fecha_retorno: { type: "string", description: "Fecha del retorno, YYYY-MM-DD (solo con ida y retorno)." },
      hora_retorno: { type: "string", description: "Hora de recojo del retorno, HH:MM (solo con ida y retorno)." },
      pax: { type: "integer", description: "Número de pasajeros." },
      maletas: {
        type: "integer",
        description: "SOLO las maletas grandes de bodega (de 23 kg). Las de mano (10 kg), las mochilas y los artículos personales NO van aquí. 0 si no llevan maletas grandes. No lo supongas: si el cliente dice «con maletas» o da un número sin decir de qué tipo, pregúntale cuántas son grandes (23 kg), cuántas de mano (10 kg) y cuántos artículos personales.",
      },
      paradas_intermedias: { type: "integer", description: "Paradas en el camino que pidió el cliente (0 si ninguna)." },
      fechas_adicionales: { type: "integer", description: "Otras fechas además de la del servicio (0 si es una sola)." },
      vehiculos_pedidos: { type: "integer", description: "Vehículos que pide a la vez (1 si es uno)." },
      cliente_pide_dolares: {
        type: "boolean",
        description: "true SOLO si el cliente escribió que quiere la cotización (o el precio) en dólares. No lo deduzcas de su país ni de su número.",
      },
      ...(o.ingles ? {
        cliente_pide_soles: {
          type: "boolean",
          description: "true SOLO si el cliente escribió que quiere la cotización (o el precio) en soles. No lo deduzcas de su país ni de su número.",
        },
      } : {}),
      senales: {
        type: "array",
        items: { type: "string", enum: CLAVES_SENALES },
        description: "Condiciones que hacen que el pedido NO sea simple y lo vea un ejecutivo.",
      },
    },
  },
  };
}

/** La herramienta de siempre (con el inglés apagado). */
export const HERRAMIENTA_COTIZAR_TRASLADO = herramientaCotizarTraslado({ ingles: false });

// ── 2. Lo que va al validador ────────────────────────────────────────────────

const coordenada = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
};

/**
 * Los textos de los mensajes que son UBICACIONES compartidas (tipo «location», como lo guarda el
 * webhook). Solo de ellos salen coordenadas: un enlace de mapa pegado en un mensaje de texto no es
 * una ubicación compartida.
 */
export function textosDeUbicacion(mensajes: readonly { contenido?: unknown; tipo?: unknown }[] | null | undefined): string[] {
  return (mensajes ?? [])
    .filter((m) => m && m.tipo === "location" && typeof m.contenido === "string" && m.contenido.trim() !== "")
    .map((m) => m.contenido as string);
}

/** El enlace que escribe el webhook al recibir una ubicación (lib/crm-ingesta.ts). */
const ENLACE_MAPA = /https?:\/\/maps\.google\.com\/\?q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g;

/** Tolerancia de la comparación: el modelo puede recortar decimales; 1e-6° son ~10 cm. */
const TOL_COORD = 1e-6;

/**
 * Las coordenadas que propone el modelo, SOLO si aparecen tal cual en el enlace de mapa de una
 * UBICACIÓN compartida (`textosDeUbicacion`). Se devuelven las del enlace (no las del modelo). Si
 * no, null: se usa el texto.
 */
export function coordenadasVerificadas(lat: unknown, lng: unknown, textosUbicacion: string[]): { lat: number; lng: number } | null {
  const la = coordenada(lat), ln = coordenada(lng);
  if (la == null || ln == null) return null;
  for (const t of textosUbicacion ?? []) {
    if (typeof t !== "string") continue;
    for (const m of t.matchAll(ENLACE_MAPA)) {
      const a = Number(m[1]), b = Number(m[2]);
      if (Math.abs(a - la) <= TOL_COORD && Math.abs(b - ln) <= TOL_COORD) return { lat: a, lng: b };
    }
  }
  return null;
}

const comoTexto = (v: unknown): string => (typeof v === "string" ? v : "");

/** Texto comparable por PALABRA: sin tildes, minúsculas, todo lo que no es letra o número es espacio. */
const textoComparable = (s: string): string =>
  ` ${String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/** Las palabras que nombran los dólares, por palabra COMPLETA (nunca «contiene»). */
const PALABRAS_DOLARES = ["dolar", "dolares", "dollar", "dollars", "usd"];

/**
 * Los mensajes del CLIENTE nombran los dólares: «dólar(es)», «dollar(s)», «USD» o el signo «$»
 * («US$», «$ 50»; los soles se escriben «S/», que no lo lleva). Es la segunda confirmación de
 * `cliente_pide_dolares`: la primera es que el modelo entendió que los pide. Una sola no basta
 * —el modelo puede equivocarse, y «no tengo dólares» también nombra los dólares—, las dos juntas sí.
 */
export function nombraDolares(textos: readonly unknown[] | null | undefined): boolean {
  for (const t of textos ?? []) {
    if (typeof t !== "string" || !t) continue;
    if (t.includes("$")) return true;
    const c = textoComparable(t);
    if (PALABRAS_DOLARES.some((p) => c.includes(` ${p} `))) return true;
  }
  return false;
}

/** Las palabras que nombran los soles, por palabra o frase COMPLETA. «sol» a secas no cuenta (es el sol). */
const PALABRAS_SOLES = ["soles", "nuevos soles", "pen", "peruvian sol", "peruvian soles", "local currency", "moneda local"];
/** «S/ 150», «S/150», «S/.»; no «s/n» (sin número, en una dirección). */
const SIGNO_SOLES = /(?:^|[^a-z0-9])s\/(?![a-z])/i;

/**
 * Los mensajes del CLIENTE nombran los soles: «soles», «nuevos soles», «PEN», «S/», «peruvian
 * sol(es)», «local currency» o «moneda local». Es la segunda confirmación de `cliente_pide_soles`
 * (la primera es que el modelo lo marcó), igual que `nombraDolares`.
 */
export function nombraSoles(textos: readonly unknown[] | null | undefined): boolean {
  for (const t of textos ?? []) {
    if (typeof t !== "string" || !t) continue;
    if (SIGNO_SOLES.test(t)) return true;
    const c = textoComparable(t);
    if (PALABRAS_SOLES.some((p) => c.includes(` ${p} `))) return true;
  }
  return false;
}

/**
 * La entrada que se le pasa a `validarEntrada` (lib/traslados/api.ts), armada con lista blanca. El teléfono es el `wa_id`
 * del remitente de WhatsApp (en otro canal, null: sin moneda no se cotiza), JAMÁS algo del input.
 * `textosUbicacion` son SOLO los de las ubicaciones compartidas (`textosDeUbicacion`).
 * `textosCliente` son los mensajes ENTRANTES de la conversación: `pide_dolares` solo pasa si el
 * modelo lo marcó Y ahí se nombran los dólares (`nombraDolares`). Con el pedido de dólares
 * confirmado, la señal `otra_moneda` sobra (la moneda pedida SÍ se ofrece) y se quita.
 *
 * `idioma` lo pone el CÓDIGO (lib/idioma-cliente.ts sobre los mensajes del cliente, y si el inglés
 * está encendido: `ingles`), NUNCA el input del modelo: un `idioma_cliente`, `pide_soles`,
 * `idioma`, `moneda` o `telefono` en el input se ignora. `idioma_cliente` solo pasa con el inglés
 * encendido y el cliente en inglés u otro idioma; `pide_soles`, solo junto a él, con el modelo
 * marcando `cliente_pide_soles` Y los mensajes del cliente nombrando los soles (`nombraSoles`). Con
 * soles y dólares verificados a la vez, ninguno de los dos (manda el defecto del idioma). Sin
 * `idioma`, byte a byte la entrada de siempre.
 */
export function entradaDelAgente(
  input: unknown,
  remitente: { canal: string; waId: string | null },
  textosUbicacion: string[],
  textosCliente: readonly unknown[] = [],
  idioma?: { cliente: IdiomaCliente | null; ingles: InglesTraslado | null },
): unknown {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const lugar = (texto: unknown, lat: unknown, lng: unknown): LugarEntrada => {
    const t = comoTexto(texto).trim();
    const c = coordenadasVerificadas(lat, lng, textosUbicacion);
    return c ? { lat: c.lat, lng: c.lng, texto: t || undefined } : t;
  };
  const wa = remitente?.canal === "whatsapp" && typeof remitente.waId === "string" && remitente.waId.trim() ? remitente.waId.trim() : null;
  const idiomaCliente = idioma && inglesActivo(idioma.ingles) && (idioma.cliente === "en" || idioma.cliente === "otro") ? idioma.cliente : null;
  const dolaresVerificados = o.cliente_pide_dolares === true && nombraDolares(textosCliente);
  const solesVerificados = idiomaCliente != null && o.cliente_pide_soles === true && nombraSoles(textosCliente);
  // Los dos a la vez no se sabe cuál quiere: ninguno, y manda el defecto del idioma.
  const ambos = dolaresVerificados && solesVerificados;
  const pideDolares = dolaresVerificados && !ambos;
  const pideSoles = solesVerificados && !ambos;
  const senales = (pideDolares || pideSoles) && Array.isArray(o.senales) ? o.senales.filter((x) => x !== "otra_moneda") : o.senales;
  return {
    origen: lugar(o.origen_texto, o.origen_lat, o.origen_lng),
    destino: lugar(o.destino_texto, o.destino_lat, o.destino_lng),
    fecha_servicio: o.fecha_servicio, hora_servicio: o.hora_servicio,
    sentido: o.sentido, fecha_retorno: o.fecha_retorno, hora_retorno: o.hora_retorno,
    pax: o.pax, maletas: o.maletas,
    paradas_intermedias: o.paradas_intermedias, fechas_adicionales: o.fechas_adicionales,
    vehiculos_pedidos: o.vehiculos_pedidos, senales,
    telefono: wa,
    ...(pideDolares ? { pide_dolares: true } : {}),
    ...(idiomaCliente ? { idioma_cliente: idiomaCliente } : {}),
    ...(pideSoles ? { pide_soles: true } : {}),
  };
}

// ── 3. La firma del pedido (idempotencia) ────────────────────────────────────

const firmaLugar = (l: LugarEntrada): string =>
  typeof l === "string"
    ? claveNombre(l)
    : `@${l.lat.toFixed(5)},${l.lng.toFixed(5)}`;

/**
 * La cadena canónica de un pedido YA VALIDADO: dos llamadas con los mismos datos (aunque el modelo
 * cambie mayúsculas, tildes o el orden de los campos) dan la misma firma. La moneda entra porque
 * el mismo pedido desde otro número es otra cotización, y el mismo pedido «ahora en dólares» —tras
 * recibirlo en soles— también: si no, se le contestaría «ya te la envié» con la de soles. Es la
 * moneda DECIDIDA (`monedaDelPedido`, con la MISMA llamada que el motor), así que sin pedido de
 * dólares la firma es la de siempre. Con «solo ida», el retorno no cuenta. Con el cliente en inglés
 * u otro idioma (`idioma_cliente`) se agrega «en» al final: el mismo pedido «ahora en inglés» es otra
 * cotización (el PDF está en otro idioma), y sin idioma la firma es byte a byte la de antes (las
 * acciones pendientes de antes se siguen reusando); volver al castellano reusa la de castellano.
 */
export function firmaPedido(e: EntradaSimulador): string {
  const conRetorno = e.sentido === "ida_retorno";
  return [
    "v1",
    firmaLugar(e.origen), firmaLugar(e.destino),
    e.fecha_servicio ?? "", e.hora_servicio ?? "",
    e.sentido ?? "",
    conRetorno ? e.fecha_retorno ?? "" : "", conRetorno ? e.hora_retorno ?? "" : "",
    e.pax ?? "", e.maletas ?? "",
    monedaDelPedido(e.telefono, e.pide_dolares, { idiomaCliente: e.idioma_cliente ?? null, pideSoles: e.pide_soles === true }).moneda ?? "",
    ...(e.idioma_cliente ? ["en"] : []),
  ].join("|");
}

// ── 4. ¿La zona tiene envío automático? ──────────────────────────────────────

export type ZonaEnvio = Zona & { envio_automatico?: boolean | null };

/**
 * La zona (o, si es subzona, su distrito activo) tiene marcado el envío automático. Es la misma
 * escalera que `tarifaDelPar`: una subzona hereda de su distrito. Solo `true` cuenta: sin la
 * migración la columna llega `undefined` y eso es «no».
 */
export function zonaConEnvio(z: Zona | null | undefined, zonas: readonly ZonaEnvio[]): boolean {
  if (!z) return false;
  const actual = zonas.find((x) => x.id === z.id) ?? (z as ZonaEnvio);
  if (actual.activo === false) return false;
  if (actual.envio_automatico === true) return true;
  if (actual.tipo === "subzona" && actual.padre_id != null) {
    const padre = zonas.find((x) => x.id === actual.padre_id);
    return !!padre && padre.activo !== false && padre.tipo === "distrito" && padre.envio_automatico === true;
  }
  return false;
}

// ── 5. ¿Se envía sola o la revisa un ejecutivo? ──────────────────────────────

export type CodigoRevision =
  | "maestro_apagado" | "zona_sin_envio" | "modo_copiloto" | "sin_remitente"
  | "perfil_sin_configurar" | "importes_no_cuadran" | "pdf_no_generado" | "palabras_de_pedido_complejo"
  | "texto_libre_sospechoso" | "cuentas_distintas" | "condiciones_demasiadas" | "condiciones_en_otro_idioma";

export const MOTIVO_REVISION: Record<CodigoRevision, { texto: string; arreglo: string }> = {
  maestro_apagado: {
    texto: "El envío automático de cotizaciones está apagado.",
    arreglo: "Se enciende en /tarifario → Zonas y traslados → Ajustes.",
  },
  zona_sin_envio: {
    texto: "Ni el recojo ni el destino están en una zona con envío automático.",
    arreglo: "Se marca «Envío automático de la cotización» en la zona, en /tarifario → Zonas y traslados → Zonas.",
  },
  modo_copiloto: {
    texto: "El agente IA no está en modo autónomo para WhatsApp (o está fuera de su horario).",
    arreglo: "Se cambia en /crm/agente (canales autónomos y horario).",
  },
  sin_remitente: {
    texto: "La conversación no es de WhatsApp o no tiene el número del cliente.",
    arreglo: "La envía un ejecutivo desde el CRM.",
  },
  perfil_sin_configurar: {
    texto: "El perfil de la empresa no tiene nombre: el PDF saldría con «CONFIGURA EL PERFIL DE TU EMPRESA».",
    arreglo: "Se llena en /configuracion/perfil.",
  },
  importes_no_cuadran: {
    texto: "Los importes guardados no reproducen los del tarifario (un IGV distinto del 18 % o un redondeo).",
    arreglo: "Revisa el IGV en /tesoreria → Detracciones y la cotización en /cotizaciones antes de enviarla.",
  },
  pdf_no_generado: {
    texto: "No se pudo armar el PDF de la cotización.",
    arreglo: "Pulsa «Ver PDF» en la tarjeta del CRM; si sigue fallando, revisa el logo en /configuracion/perfil.",
  },
  palabras_de_pedido_complejo: {
    texto: "El cliente escribió palabras de un pedido complejo (TDR, licitación, evento, descuento…).",
    arreglo: "Un ejecutivo confirma que de verdad es un traslado simple antes de enviarla.",
  },
  texto_libre_sospechoso: {
    texto: "El recojo, el destino o el nombre del contacto traen algo que no es una dirección (un enlace, un número de 6 o más dígitos, un importe, palabras de pago) o pasan de 80 caracteres —en el PDF solo se imprimió el nombre de la zona—, o una condición del PDF trae un enlace o un número de 6 o más dígitos.",
    arreglo: "Lee la conversación y las condiciones del PDF antes de enviarla (puede ser un intento de poner instrucciones de pago en el PDF); el recojo y el destino se corrigen en /cotizaciones, las condiciones en la cotización o en su plantilla (/cotizaciones/plantillas).",
  },
  cuentas_distintas: {
    texto: "Las cuentas bancarias de la plantilla de traslados no son las de la plantilla «corporativo» (o no se pudo comprobar): revisa antes de enviar.",
    arreglo: "Comprueba en «Ver PDF» que las cuentas sean de la empresa; si no, corrígelas en /cotizaciones/plantillas (pestaña Cuentas de la plantilla de traslados).",
  },
  condiciones_demasiadas: {
    texto: `Las condiciones del PDF pasan de ${MAX_LINEAS_CONDICIONES} líneas en una lista o tienen una línea de más de ${MAX_CARACTERES_CONDICION} caracteres: el PDF podría no mostrarlas enteras.`,
    arreglo: "Acórtalas en la cotización (/cotizaciones) o en la plantilla de traslados (/cotizaciones/plantillas) y mira el PDF antes de enviarla.",
  },
  condiciones_en_otro_idioma: {
    texto: "La cotización va en inglés pero sus condiciones salieron de una plantilla en castellano.",
    arreglo: `Asigna una plantilla en inglés a «${etiquetaCeldaTraslado({ idioma: "en", moneda: "PEN" })}» o «${etiquetaCeldaTraslado({ idioma: "en", moneda: "USD" })}» (la de la moneda de esta cotización) en /cotizaciones/plantillas.`,
  },
};

/** Una condición del PDF que deja la cotización para revisión (la cita la nota del ejecutivo). */
export type CondicionCitada = CondicionSospechosa;

/**
 * Lo que, además de `planEnvio`, deja una cotización de traslado para revisión, mirando el PDF que
 * se arma de SU fila: las cuentas de su plantilla distintas de las de `corporativo` (el aviso
 * `cuentas_distintas_de_corporativo` del PDF → `cuentas_distintas`), condiciones que no caben
 * (`excesoCondiciones` → `condiciones_demasiadas`) y condiciones con un enlace o un número de 6+
 * dígitos (`condicionesSospechosas` → `texto_libre_sospechoso`; las palabras de pago solas NO).
 * Con `idiomaPdf` «en», unas condiciones que no se copiaron de una plantilla en inglés (sin
 * `idioma: "en"` en la fila) → `condiciones_en_otro_idioma`: no se traduce lo que nadie escribió.
 * Sin `idiomaPdf`, lo de siempre.
 * PURO: recibe los códigos de los avisos del PDF y las condiciones de la fila.
 */
export function revisionPorCondiciones(x: {
  avisosPdf: readonly { codigo: string }[] | null | undefined;
  consideraciones: unknown;
  idiomaPdf?: unknown;
}): { motivos: CodigoRevision[]; lineas: CondicionCitada[] } {
  const motivos: CodigoRevision[] = [];
  if ((x.avisosPdf ?? []).some((a) => a?.codigo === "cuentas_distintas_de_corporativo")) motivos.push("cuentas_distintas");
  const exceso = excesoCondiciones(x.consideraciones).length > 0 || (x.avisosPdf ?? []).some((a) => a?.codigo === "condiciones_demasiadas");
  if (exceso) motivos.push("condiciones_demasiadas");
  const lineas = condicionesSospechosas(x.consideraciones);
  if (lineas.length) motivos.push("texto_libre_sospechoso");
  if (normalizarIdioma(x.idiomaPdf) === "en") {
    const c = x.consideraciones && typeof x.consideraciones === "object" ? (x.consideraciones as { idioma?: unknown }) : null;
    if (c?.idioma !== "en") motivos.push("condiciones_en_otro_idioma");
  }
  return { motivos, lineas };
}

export type DecisionEnvio = "automatico" | "revision";

/**
 * Se envía sola SOLO si se cumple todo; si no, revisión con TODOS los motivos que aplican (no solo
 * el primero: el ejecutivo ve de una vez qué falta). Con un resultado que no es cotizable devuelve
 * revisión SIN motivos y no lanza: no hay cotización que enviar, y una excepción en el turno del
 * agente dejaría al cliente sin respuesta. El llamador no debería llegar aquí con eso.
 */
export function planEnvio(x: {
  resultado: ResultadoTraslado;
  envioMaestro: boolean;
  zonas: readonly ZonaEnvio[];
  canal: string;
  waId: string | null;
  modoAuto: boolean;
  perfilConfigurado: boolean;
  cuadra: boolean;
  pdfOk: boolean;
  palabras: string[];
  /** El recojo, el destino y el nombre del contacto tal como llegaron (sin recortar). */
  textosLibres?: (string | null | undefined)[];
  /** El idioma de la cotización: con «en», los textos libres se juzgan con castellano ∪ inglés. */
  idioma?: IdiomaTexto;
}): { decision: DecisionEnvio; motivos: CodigoRevision[] } {
  const r = x.resultado;
  if (!r || r.codigo !== "cotizable" || !r.precio) return { decision: "revision", motivos: [] };
  const motivos: CodigoRevision[] = [];
  if (x.envioMaestro !== true) motivos.push("maestro_apagado");
  if (!zonaConEnvio(r.origen?.zona ?? null, x.zonas) && !zonaConEnvio(r.destino?.zona ?? null, x.zonas)) motivos.push("zona_sin_envio");
  if (x.modoAuto !== true) motivos.push("modo_copiloto");
  if (x.canal !== "whatsapp" || !(typeof x.waId === "string" && x.waId.trim())) motivos.push("sin_remitente");
  if (x.perfilConfigurado !== true) motivos.push("perfil_sin_configurar");
  if (x.cuadra !== true) motivos.push("importes_no_cuadran");
  if (x.pdfOk !== true) motivos.push("pdf_no_generado");
  if ((x.palabras ?? []).length > 0) motivos.push("palabras_de_pedido_complejo");
  if ((x.textosLibres ?? []).some((t) => textoLibreSospechoso(t, x.idioma === "en" ? "en" : "es") != null)) motivos.push("texto_libre_sospechoso");
  return { decision: motivos.length === 0 ? "automatico" : "revision", motivos };
}

// ── 6. Palabras de un pedido complejo ────────────────────────────────────────

/**
 * Lo que escribe el cliente y huele a pedido complejo. Por frase COMPLETA, nunca «contiene»:
 * «eventual» no es «evento», y «tours» a secas no se busca porque es parte del nombre de muchas
 * empresas de transporte. Solo baja de automático a revisión; no deriva nada.
 */
const PALABRAS_COMPLEJAS: { etiqueta: string; frases: string[] }[] = [
  { etiqueta: "TDR", frases: ["tdr", "tdrs"] },
  { etiqueta: "términos de referencia", frases: ["terminos de referencia", "termino de referencia"] },
  { etiqueta: "licitación", frases: ["licitacion", "licitaciones"] },
  { etiqueta: "bases", frases: ["bases"] },
  { etiqueta: "concurso", frases: ["concurso", "concursos"] },
  { etiqueta: "convocatoria", frases: ["convocatoria"] },
  { etiqueta: "evento", frases: ["evento", "eventos"] },
  { etiqueta: "full day", frases: ["full day", "fullday", "full days"] },
  { etiqueta: "city tour", frases: ["city tour", "citytour", "city tours"] },
  { etiqueta: "descuento", frases: ["descuento", "descuentos", "rebaja"] },
  { etiqueta: "contrato", frases: ["contrato", "contratos"] },
];

/** Las de inglés, que se SUMAN a las de castellano con `idioma = "en"` («city tour» y «full day» ya están). */
const PALABRAS_COMPLEJAS_INGLES: { etiqueta: string; frases: string[] }[] = [
  { etiqueta: "tender", frases: ["tender", "tenders"] },
  { etiqueta: "RFP", frases: ["rfp", "rfps"] },
  { etiqueta: "terms of reference", frases: ["terms of reference"] },
  { etiqueta: "event", frases: ["event", "events"] },
  { etiqueta: "conference", frases: ["conference", "conferences"] },
  { etiqueta: "wedding", frases: ["wedding", "weddings"] },
  { etiqueta: "discount", frases: ["discount", "discounts"] },
  { etiqueta: "contract", frases: ["contract", "contracts"] },
];

export function senalesEnTexto(textos: string[], idioma: IdiomaTexto = "es"): string[] {
  const t = (textos ?? []).filter((x) => typeof x === "string").map(textoComparable).join(" ");
  const listas = idioma === "en" ? [...PALABRAS_COMPLEJAS, ...PALABRAS_COMPLEJAS_INGLES] : PALABRAS_COMPLEJAS;
  return listas.filter((p) => p.frases.some((f) => t.includes(` ${f} `))).map((p) => p.etiqueta);
}

// ── 7. El modelo no pone números ─────────────────────────────────────────────

/** Las cifras que el texto del modelo PUEDE mencionar. En revisión, ninguna. */
export function figurasPermitidas(decision: DecisionEnvio, p: PrecioTraslado | null | undefined): number[] {
  if (decision !== "automatico" || !p) return [];
  return [p.precio_tramo, p.subtotal, p.igv, p.total].filter((n) => Number.isFinite(Number(n))).map(Number);
}

// `leerImporte` e `importesEnTexto` viven en ./texto-libre (los usa también la fila del PDF) y se
// reexportan aquí sin cambios.
export { leerImporte, importesEnTexto } from "./texto-libre";

/** El texto menciona un importe que no es ninguna de las cifras permitidas. */
export function textoContradicePrecio(texto: string, figuras: number[]): boolean {
  const ok = (figuras ?? []).map(Number).filter(Number.isFinite);
  return importesEnTexto(texto).some((n) => !ok.some((f) => Math.abs(f - n) < 0.005));
}

// ── 8. Los textos que escribe el código ──────────────────────────────────────

/** La misma línea fija del PDF: el chat y el documento dicen lo mismo. */
const LINEA_EJECUTIVO = LINEA_DISPONIBILIDAD;

/**
 * El mensaje de una cotización de traslado, escrito por el CÓDIGO (`textoFinalTraslado` lo usa
 * siempre que el turno trae una cotización). En revisión no lleva ningún importe.
 * NO SALUDA NI LLEVA EL NOMBRE (21-10-2026): llega en medio de la conversación, después de que la IA
 * ya saludó y pidió los datos, y empezaba con «Hola {nombre},» tomando el nombre del perfil de
 * WhatsApp — en la prueba del dueño salió «Hola Atencion,» (su perfil se llama «Atención al
 * Cliente») justo después de que la IA lo había llamado «José Luis».
 * Habla con el trato del agente (`estilo`, obligatorio): «tu» o «usted», la misma frase en los dos.
 * Sin estilo (un llamador en JS) se trata de usted, que es el defecto del ajuste. Los importes, el
 * número y la validez no cambian con el trato.
 */
export function mensajeCotizacionCodigo(x: {
  numero: string; decision: DecisionEnvio; total?: string; validez?: string; yaEnviada?: boolean;
  estilo: EstiloMensajes;
}): string {
  if (x.estilo?.idioma === "en") return mensajeCotizacionIngles(x);
  const tu = x.estilo?.tratamiento === "tu";
  const su = tu ? "tu" : "su";
  if (x.yaEnviada) {
    const total = x.total ? ` El total es ${x.total} (IGV incluido)${x.validez ? `, válida hasta el ${x.validez}` : ""}.` : "";
    return `La cotización N° ${x.numero} de ${su} traslado ya ${tu ? "te" : "se"} la envié por este chat.${total} ${LINEA_EJECUTIVO}`;
  }
  if (x.decision === "automatico") {
    const total = x.total ? ` El total es ${x.total} (IGV incluido)` : "";
    const validez = x.validez ? `${total ? "," : " La cotización es"} válida hasta el ${x.validez}` : "";
    return `${tu ? "Te" : "Le"} envío la cotización N° ${x.numero} de ${su} traslado.${total}${validez}${total || validez ? "." : ""} ${LINEA_EJECUTIVO}`;
  }
  return `Registré ${su} pedido de traslado con la cotización N° ${x.numero}. Un ejecutivo la revisa y ${tu ? "te" : "se"} la envía por este chat en breve.`;
}

/**
 * El mismo mensaje EN INGLÉS, escrito entero (una sola versión: el inglés no distingue tú y usted).
 * El total y la validez llegan ya formateados en el idioma de la fila (`cifrasDeFila`). «IGV» se
 * explica una vez («Peruvian VAT»): un cliente extranjero no conoce la sigla.
 */
function mensajeCotizacionIngles(x: { numero: string; decision: DecisionEnvio; total?: string; validez?: string; yaEnviada?: boolean }): string {
  if (x.yaEnviada) {
    const total = x.total ? ` The total is ${x.total} (including IGV, Peruvian VAT)${x.validez ? `, valid until ${x.validez}` : ""}.` : "";
    return `I already sent you quotation No. ${x.numero} for your transfer in this chat.${total} ${LINEA_DISPONIBILIDAD_EN}`;
  }
  if (x.decision === "automatico") {
    const total = x.total ? ` The total is ${x.total} (including IGV, Peruvian VAT)` : "";
    const validez = x.validez ? `${total ? "," : " The quotation is"} valid until ${x.validez}` : "";
    return `Here is quotation No. ${x.numero} for your transfer.${total}${validez}${total || validez ? "." : ""} ${LINEA_DISPONIBILIDAD_EN}`;
  }
  return `I've registered your transfer request with quotation No. ${x.numero}. One of our agents is reviewing it and will send it to you in this chat shortly.`;
}

/**
 * «Me falta…»: lo que el CÓDIGO le pide al cliente cuando el texto del modelo no se puede mandar
 * (menciona dinero) y la herramienta pidió datos. Con «todo junto», la lista entera («Para cotizar
 * su traslado me falta: a; b.»); con «uno por mensaje», SOLO el primero, en el orden en que los da
 * el motor («Para cotizar su traslado, ¿me indica a?»). Con «tu» y «todo junto», byte a byte el
 * texto de antes. Sin ningún dato, "" (quien llama manda la derivación).
 */
/**
 * El motor pide de nuevo una dirección que Google no encontró citando lo que escribió el cliente
 * («… (no se encontró «X»)»). Esa cita sale sin revisión desde el número oficial: si es texto libre
 * sospechoso (un importe, un Yape, un enlace, demasiado largo) se quita y queda solo el pedido.
 */
function sinCitaSospechosa(dato: string, idioma: Idioma = "es"): string {
  if (idioma === "en") {
    return dato.replace(/\s*\(we could not find «([\s\S]*)»\)\s*$/, (todo, cita: string) => (referenciaImprimible(cita, "en") ? todo : "")).trim();
  }
  return dato.replace(/\s*\(no se encontró «([\s\S]*)»\)\s*$/, (todo, cita: string) => (referenciaImprimible(cita) ? todo : "")).trim();
}

/**
 * Lo que el motor le pide al cliente (`FALTA`), en inglés. Se reconoce por IGUALDAD EXACTA con los
 * literales del motor, nunca por parecido: un «falta» que no está en la tabla devuelve null y quien
 * llama manda la derivación (mejor un ejecutivo que una pregunta a medio traducir).
 */
const FALTA_INGLES: Record<string, string> = {
  [FALTA.recojo]: "the pick-up point",
  [FALTA.destino]: "the destination",
  [FALTA.fecha]: "the date of the service",
  [FALTA.sentido]: "whether it is one way or a round trip",
  [FALTA.fecha_retorno]: "the date of the return trip",
  [FALTA.pax]: "the number of passengers",
  [FALTA.maletas]: "how many large (23 kg) suitcases you are bringing, and how many are carry-on (10 kg) or personal items",
  [FALTA.fecha_futura]: "a future date",
  "la dirección exacta del recojo": "the exact address of the pick-up point",
  "la dirección exacta del destino": "the exact address of the destination",
};
/** La dirección que Google no encontró, con la cita del cliente (`faltaDireccion` del motor). */
const FALTA_DIRECCION = /^la dirección exacta del (recojo|destino) \(no se encontró «([\s\S]*)»\)$/;

/** «falta» en el idioma pedido: castellano → tal cual; inglés → la tabla exacta (y las dos citas); desconocido → null. */
export function faltaEnIdioma(falta: string, idioma: "es" | "en"): string | null {
  const f = String(falta ?? "").trim();
  if (idioma !== "en") return f;
  if (Object.prototype.hasOwnProperty.call(FALTA_INGLES, f)) return FALTA_INGLES[f];
  const m = FALTA_DIRECCION.exec(f);
  if (m) return `the exact address of the ${m[1] === "recojo" ? "pick-up point" : "destination"} (we could not find «${m[2]}»)`;
  return null;
}

export function fraseFaltanTraslado(faltan: readonly unknown[] | null | undefined, estilo: EstiloMensajes): string {
  if (estilo?.idioma === "en") {
    const crudos = (faltan ?? []).map((x) => String(x ?? "").trim()).filter(Boolean);
    const traducidos = crudos.map((x) => faltaEnIdioma(x, "en"));
    // Un dato sin traducción: no se manda una pregunta a medias (quien llama deriva).
    if (traducidos.some((x) => x == null)) return "";
    const f = (traducidos as string[]).map((x) => sinCitaSospechosa(x, "en")).filter(Boolean);
    if (f.length === 0) return "";
    if (estilo?.preguntas === "una_por_mensaje") return `To quote your transfer, could you tell me ${f[0]}?`;
    return `To quote your transfer I still need: ${f.join("; ")}.`;
  }
  const f = (faltan ?? []).map((x) => sinCitaSospechosa(String(x ?? "").trim())).filter(Boolean);
  if (f.length === 0) return "";
  const tu = estilo?.tratamiento === "tu";
  if (estilo?.preguntas === "una_por_mensaje") {
    return tu ? `Para cotizar tu traslado, ¿me indicas ${f[0]}?` : `Para cotizar su traslado, ¿me indica ${f[0]}?`;
  }
  return `Para cotizar ${tu ? "tu" : "su"} traslado me falta: ${f.join("; ")}.`;
}

/** Lo que devolvió `cotizar_traslado` en el turno, en lo que importa para el texto final. */
export type TrasladoDelTurno = {
  accion: "cotizar" | "preguntar" | "derivar";
  faltan?: string[];
  cotizacion?: { numero: string; decision: DecisionEnvio; total?: string; validez?: string; yaEnviada?: boolean } | null;
};

/**
 * El texto que se le manda al cliente en un turno en que se usó `cotizar_traslado`:
 *  · con una cotización (automática, en revisión o ya enviada), SIEMPRE el del código: el modelo
 *    no escribe el total, ni el IGV, ni la validez, ni un «aprox.»;
 *  · sin cotización (preguntar o derivar), el del modelo SOLO si no menciona dinero
 *    (`mencionaDinero`); si menciona, «me falta: …» (`fraseFaltanTraslado`) o el mensaje de derivación.
 * Sin herramienta en el turno, el texto no se toca. Lo que escribe el código va con el `estilo`
 * del agente (trato y modo de preguntar); la derivación ya llega armada con él.
 */
export function textoFinalTraslado(
  texto: string,
  t: TrasladoDelTurno | null | undefined,
  x: { derivacion: string; estilo: EstiloMensajes },
): string {
  if (!t) return texto;
  const c = t.cotizacion;
  if (c) {
    return mensajeCotizacionCodigo({
      numero: c.numero, decision: c.decision, total: c.total, validez: c.validez, yaEnviada: c.yaEnviada, estilo: x.estilo,
    });
  }
  // En inglés, los guards de dinero son castellano ∪ inglés (el modelo puede contestar en los dos).
  const idioma: IdiomaTexto = x.estilo?.idioma === "en" ? "en" : "es";
  if (!texto || !mencionaDinero(texto, idioma)) return texto;
  const faltan = t.accion === "preguntar" ? (t.faltan ?? []).filter(Boolean) : [];
  // Lo que reemplaza al texto del modelo tampoco puede hablar de dinero (última barrera).
  const f = faltan.length ? fraseFaltanTraslado(faltan, x.estilo) : "";
  return f && !mencionaDinero(f, idioma) ? f : x.derivacion;
}

/** Qué campo libre es sospechoso y por qué, para la nota del ejecutivo (con «en», castellano ∪ inglés). */
export function textosLibresSospechosos(campos: { campo: string; texto: string | null | undefined }[], idioma: IdiomaTexto = "es"): { campo: string; motivo: MotivoTextoLibre }[] {
  const out: { campo: string; motivo: MotivoTextoLibre }[] = [];
  for (const c of campos) {
    const m = textoLibreSospechoso(c.texto, idioma);
    if (m) out.push({ campo: c.campo, motivo: m });
  }
  return out;
}

/** El código público que ve el modelo: no revela cómo se resolvió la zona ni la tarifa. */
export type CodigoPublico = "cotizado" | "falta_dato" | "fecha_pasada" | "requiere_ejecutivo";

const codigoPublico = (r: ResultadoTraslado): CodigoPublico =>
  r.codigo === "cotizable" ? "cotizado"
  : r.codigo === "falta_dato" ? "falta_dato"
  : r.codigo === "fecha_pasada" ? "fecha_pasada"
  : "requiere_ejecutivo";

/**
 * Qué preguntarle al cliente. Sin `preguntas` (o «todo_junto»), byte a byte la de siempre: todo en
 * un mensaje. Con «una_por_mensaje», SOLO el primer dato que falta (el orden es el del motor) y los
 * demás se nombran para después: el modelo sabe que existen y no los adelanta.
 */
function instruccionPreguntar(faltan: string[], preguntas?: ModoPreguntas): string {
  if (preguntas === "una_por_mensaje" && faltan.length > 0) {
    const [primero, ...resto] = faltan;
    const despues = resto.length ? ` Lo demás que falta (${resto.join("; ")}) se lo preguntas después, de a uno.` : "";
    return `Pregúntale al cliente SOLO por: ${primero}.${despues} Cuando responda, vuelve a llamar a cotizar_traslado con TODOS los datos que ya tienes.`;
  }
  return `Pregúntale al cliente, en un solo mensaje: ${faltan.join("; ")}. Cuando responda, vuelve a llamar a cotizar_traslado con TODOS los datos.`;
}

/** Las claves que puede llevar la respuesta al modelo. La matriz lo comprueba. */
export const CLAVES_RESPUESTA_MODELO = ["accion", "codigo", "faltan", "vehiculo", "sentido", "tramos", "cotizacion", "instruccion"] as const;
export const CLAVES_COTIZACION_MODELO = ["numero", "envio", "total", "incluye_igv", "validez"] as const;

/**
 * Lo que la herramienta le devuelve al modelo, en JSON y con LISTA BLANCA. Nunca la explicación
 * del motor, el motivo interno, ids, alias, el nivel de la tarifa ni el tipo de cambio. En
 * revisión (o sin cotización creada), ningún importe.
 */
export function respuestaParaModelo(x: {
  resultado: ResultadoTraslado;
  cotizacion?: { numero: string; decision: DecisionEnvio } | null;
  /** El modo de preguntar del agente. Sin él, la instrucción de siempre (todo junto). */
  preguntas?: ModoPreguntas;
  /** El idioma de la cotización: el total y la validez se le dan al modelo como los verá el cliente. Sin él, castellano. */
  idioma?: Idioma;
}): string {
  const r = x.resultado;
  const idioma: Idioma = x.idioma === "en" ? "en" : "es";
  const linea = lineaDisponibilidad(idioma);
  const out: Record<string, unknown> = { accion: r.accion, codigo: codigoPublico(r) };
  if (r.accion === "preguntar") {
    const faltan = (r.faltan ?? []).map((f) => String(f).slice(0, 200));
    out.faltan = faltan;
    out.instruccion = instruccionPreguntar(faltan, x.preguntas);
  } else if (r.accion === "derivar") {
    out.instruccion = "Este pedido lo atiende un ejecutivo. Responde con el mensaje de derivación y no menciones precios.";
  } else {
    const cat = r.vehiculo?.categoria;
    if (cat) out.vehiculo = { nombre: cat.nombre, capacidad: cat.capacidad };
    if (r.precio) {
      out.tramos = r.precio.tramos;
      out.sentido = r.precio.tramos === 2 ? "ida y retorno" : "solo ida";
    }
    const c = x.cotizacion;
    if (c && c.decision === "automatico" && r.precio) {
      out.cotizacion = {
        numero: c.numero, envio: "automatico",
        total: fmtImporte(r.precio.total, r.precio.moneda, idioma), incluye_igv: true,
        validez: r.validez_hasta ? fmtFechaDoc(r.validez_hasta, idioma, idioma === "en" ? "media" : "corta") : null,
      };
      out.instruccion = `La cotización N° ${c.numero} se envía en PDF justo después de tu mensaje. Dile al cliente el total y la validez EXACTAMENTE como vienen aquí, que el IGV está incluido y que ${linea.charAt(0).toLowerCase()}${linea.slice(1)} No escribas ningún otro importe.`;
    } else if (c) {
      out.cotizacion = { numero: c.numero, envio: "revision" };
      out.instruccion = `La cotización N° ${c.numero} quedó registrada y la revisa un ejecutivo, que se la enviará por este chat. NO menciones precios ni importes.`;
    } else {
      out.instruccion = "La cotización no se pudo registrar: un ejecutivo atiende el pedido. NO menciones precios ni importes.";
    }
  }
  return JSON.stringify(out);
}

/** Respuesta al modelo cuando el pedido lo atiende un ejecutivo por algo que no decidió el motor (un tope, un fallo). */
export function respuestaDerivar(): string {
  return JSON.stringify({ accion: "derivar", codigo: "requiere_ejecutivo", instruccion: "Este pedido lo atiende un ejecutivo. Responde con el mensaje de derivación y no menciones precios." });
}

/** Respuesta al modelo cuando hay que volver a preguntar algo que el validador no aceptó. Sin
 *  `preguntas`, byte a byte la de siempre. */
export function respuestaPreguntar(faltan: string[], preguntas?: ModoPreguntas): string {
  const f = faltan.map((x) => String(x).slice(0, 200));
  return JSON.stringify({
    accion: "preguntar", codigo: "falta_dato", faltan: f,
    instruccion: instruccionPreguntar(f, preguntas),
  });
}

/** Respuesta al modelo de una cotización que quedó en revisión y cuyo resultado no se pudo reconstruir: sin importes. */
export function respuestaEnRevision(numero: string): string {
  return JSON.stringify({
    accion: "cotizar", codigo: "cotizado", cotizacion: { numero, envio: "revision" },
    instruccion: `La cotización N° ${numero} quedó registrada y la revisa un ejecutivo, que se la enviará por este chat. NO menciones precios ni importes.`,
  });
}

/** Respuesta al modelo cuando la MISMA cotización ya se le envió al cliente: puede repetir su total, nada más. */
export function respuestaYaEnviada(numero: string, cifras: { total: string; validez: string | null } | null): string {
  return JSON.stringify({
    accion: "cotizar", codigo: "cotizado",
    cotizacion: { numero, envio: "ya_enviada", ...(cifras ? { total: cifras.total, incluye_igv: true, validez: cifras.validez } : {}) },
    instruccion: `La cotización N° ${numero} de este mismo pedido ya se le envió por este chat: no la vuelvas a cotizar. Recuérdasela${cifras ? " con el total y la validez EXACTAMENTE como vienen aquí" : " sin mencionar importes"} y pregúntale si desea reservar o si tiene alguna duda.`,
  });
}

// ── 9. Topes ─────────────────────────────────────────────────────────────────

/**
 * Topes contra el abuso (quien dispara las consultas a Google es un desconocido que escribe por
 * WhatsApp). NO ESTÁN MEDIDOS: son un techo holgado para un cliente de verdad. El lado seguro es
 * bajarlos; superarlos deriva a un ejecutivo, no bloquea al cliente.
 */
export const TOPES = {
  MAX_CONSULTAS_POR_TURNO: 2,
  MAX_CONSULTAS_CONV_DIA: 10,
  MAX_CONSULTAS_DIA: 300,
  MAX_COTIZACIONES_CONV_DIA: 3,
  MAX_COTIZACIONES_DIA: 80,
  VENTANA_MISMO_PEDIDO_MIN: 120,
} as const;

/**
 * Los conteos son de lo YA hecho (antes de esta consulta). Un conteo que no se pudo leer (null)
 * BLOQUEA: «no sé cuántas van» no es «ninguna». Solo se miran los conteos de la fase: en la consulta
 * los de consultas (y el del turno, que se cuenta en memoria); en la cotización, los de cotizaciones.
 */
export function decidirTope(
  c: { consultasConv: number | null; consultasDia: number | null; cotizacionesConv: number | null; cotizacionesDia: number | null; consultasTurno?: number | null },
  fase: "consulta" | "cotizacion",
): { ok: boolean; motivo?: string } {
  const leido = (n: number | null | undefined) => typeof n === "number" && Number.isFinite(n);
  if (fase === "consulta") {
    if (c.consultasTurno != null && c.consultasTurno >= TOPES.MAX_CONSULTAS_POR_TURNO)
      return { ok: false, motivo: `Ya se consultaron ${TOPES.MAX_CONSULTAS_POR_TURNO} traslados en esta respuesta.` };
    if (!leido(c.consultasConv) || !leido(c.consultasDia))
      return { ok: false, motivo: "No se pudo contar las consultas de traslados de hoy." };
    if ((c.consultasConv as number) >= TOPES.MAX_CONSULTAS_CONV_DIA)
      return { ok: false, motivo: `Esta conversación ya hizo ${TOPES.MAX_CONSULTAS_CONV_DIA} consultas de traslado hoy.` };
    if ((c.consultasDia as number) >= TOPES.MAX_CONSULTAS_DIA)
      return { ok: false, motivo: `Se alcanzó el tope de ${TOPES.MAX_CONSULTAS_DIA} consultas de traslado del día.` };
    return { ok: true };
  }
  if (!leido(c.cotizacionesConv) || !leido(c.cotizacionesDia))
    return { ok: false, motivo: "No se pudo contar las cotizaciones de traslado de hoy." };
  if ((c.cotizacionesConv as number) >= TOPES.MAX_COTIZACIONES_CONV_DIA)
    return { ok: false, motivo: `Esta conversación ya tiene ${TOPES.MAX_COTIZACIONES_CONV_DIA} cotizaciones de traslado hoy.` };
  if ((c.cotizacionesDia as number) >= TOPES.MAX_COTIZACIONES_DIA)
    return { ok: false, motivo: `Se alcanzó el tope de ${TOPES.MAX_COTIZACIONES_DIA} cotizaciones de traslado del día.` };
  return { ok: true };
}

// ── 10. Lo que dice Ajustes ──────────────────────────────────────────────────

export type CodigoCotizadorIA =
  | "apagado" | "sin_migracion" | "agente_inactivo" | "agente_no_autonomo"
  | "con_horario" | "envio_sin_zonas" | "solo_revision" | "activo";

const listaY = (xs: string[]) => xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} y ${xs[xs.length - 1]}`;

/**
 * Qué está haciendo de verdad el cotizador de la IA, con UN código (el primero que aplica) y las
 * líneas de todo lo que aplica. Ámbar SOLO cuando la configuración contradice lo que parece:
 * falta la migración, la IA cotiza pero el agente no es autónomo (todo queda en revisión aunque
 * el envío esté encendido), o el envío está encendido sin ninguna zona marcada.
 */
export function estadoCotizadorIA(x: {
  iaCotiza: boolean;
  envioMaestro: boolean;
  zonasConEnvio: string[];
  agente: { activo?: boolean; canales?: string[]; canales_autonomos?: string[]; horario_activo?: boolean; hora_inicio?: string; hora_fin?: string } | null;
  sinMigracion: boolean;
  /**
   * En qué monedas cotiza la IA en inglés (`inglesDisponible`); null = falta la tabla de
   * cotizaciones-09. Sin la clave (undefined), las líneas de siempre. Con ella, una línea más (gris;
   * ámbar si está PARCIAL: las cotizaciones en inglés de la otra moneda quedan en revisión).
   */
  ingles?: InglesTraslado | null;
}): { codigo: CodigoCotizadorIA; ambar: boolean; lineas: string[] } {
  if (x.sinMigracion) {
    return {
      codigo: "sin_migracion", ambar: true,
      lineas: ["Falta correr supabase/traslados-05-cotizacion-ia.sql: la IA del CRM no cotiza traslados hasta entonces."],
    };
  }
  if (!x.iaCotiza) {
    return { codigo: "apagado", ambar: false, lineas: ["La IA del CRM no cotiza traslados: está apagado."] };
  }
  const a = x.agente;
  const canales = Array.isArray(a?.canales) ? a!.canales! : [];
  const autonomos = Array.isArray(a?.canales_autonomos) ? a!.canales_autonomos! : [];
  if (!a || a.activo !== true || !canales.includes("whatsapp")) {
    return {
      codigo: "agente_inactivo", ambar: false,
      lineas: ["El agente IA no atiende WhatsApp (está apagado o sin ese canal): no cotiza nada. Se cambia en /crm/agente."],
    };
  }
  const lineas: string[] = [];
  const zonas = (x.zonasConEnvio ?? []).filter(Boolean);
  const horario = a.horario_activo === true
    ? `El agente solo responde de ${a.hora_inicio ?? "08:00"} a ${a.hora_fin ?? "20:00"}: fuera de ese horario no cotiza.`
    : null;
  const ingles = x.ingles === undefined ? null : lineaIngles(x.ingles);
  if (!autonomos.includes("whatsapp")) {
    lineas.push("El agente está en modo copiloto para WhatsApp: cotiza, pero cada cotización queda en revisión aunque el envío automático esté encendido. Se cambia en /crm/agente.");
    if (horario) lineas.push(horario);
    if (ingles) lineas.push(ingles.texto);
    return { codigo: "agente_no_autonomo", ambar: true, lineas };
  }
  let codigo: CodigoCotizadorIA;
  if (!x.envioMaestro) {
    codigo = "solo_revision";
    lineas.push("La IA cotiza y deja cada cotización para que la revise un ejecutivo: el envío automático está apagado.");
  } else if (zonas.length === 0) {
    codigo = "envio_sin_zonas";
    lineas.push("El envío automático está encendido pero ninguna zona lo tiene marcado: todo queda en revisión.");
  } else {
    codigo = horario ? "con_horario" : "activo";
    lineas.push(`La cotización se envía sola cuando el recojo o el destino es ${listaY(zonas)}; las demás quedan en revisión.`);
  }
  if (horario) lineas.push(horario);
  if (ingles) lineas.push(ingles.texto);
  return { codigo, ambar: codigo === "envio_sin_zonas" || (ingles?.ambar ?? false), lineas };
}

/** La línea del inglés en Ajustes: gris si está apagado o entero; ámbar si está en una sola moneda. */
function lineaIngles(i: InglesTraslado | null): { texto: string; ambar: boolean } {
  if (i === null) {
    return { texto: `La IA cotiza siempre en castellano: falta correr ${SQL_REGLAS_TRASLADO} para que pueda cotizar en inglés.`, ambar: false };
  }
  if (!inglesActivo(i)) {
    return {
      texto: "La IA cotiza en castellano aunque el cliente escriba en inglés: ninguna celda «inglés» de la regla del traslado tiene una plantilla en inglés. Se asigna en /cotizaciones/plantillas.",
      ambar: false,
    };
  }
  if (i.PEN && i.USD) {
    return {
      texto: "Si el cliente escribe en inglés (u otro idioma que no sea el castellano), la IA le cotiza en inglés: en dólares salvo que pida soles (en otro idioma, con la moneda de su número).",
      ambar: false,
    };
  }
  const con = i.USD ? "USD" : "PEN";
  const sin = i.USD ? "PEN" : "USD";
  return {
    texto: `La IA cotiza en inglés, pero solo «${etiquetaCeldaTraslado({ idioma: "en", moneda: con })}» tiene una plantilla en inglés: las cotizaciones en inglés en ${sin === "PEN" ? "soles" : "dólares"} salen con las condiciones en castellano y quedan en revisión. Asigna una plantilla en inglés a «${etiquetaCeldaTraslado({ idioma: "en", moneda: sin })}» en /cotizaciones/plantillas.`,
    ambar: true,
  };
}

// ── 11. La tarjeta del CRM: ¿se puede enviar esta cotización? ────────────────

/** Lo que dura el reclamo de un envío (estado `enviando`): pasado esto, se puede reintentar. */
export const PLAZO_ENVIO_MS = 5 * 60_000;

/** El plazo que se escribe en `resuelta_at` al reclamar el envío. */
export const plazoEnvio = (ahoraMs: number): string => new Date(ahoraMs + PLAZO_ENVIO_MS).toISOString();

export type PlanAccion = "ok" | "no_pendiente" | "cotizacion_ajena" | "cotizacion_no_existe" | "canal_no_whatsapp" | "sin_remitente" | "sin_precio";

type ItemSuelto = { dias?: unknown; cantidad?: unknown; precio_unit?: unknown; descuento_pct?: unknown };

/** Los ítems con números de verdad, o null si alguno no lo es. */
export function itemsMonto(v: unknown): { dias: number; cantidad: number; precio_unit: number; descuento_pct: number }[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = [];
  for (const it of v as ItemSuelto[]) {
    if (!it || typeof it !== "object") return null;
    const dias = Number(it.dias ?? 1), cantidad = Number(it.cantidad), precio_unit = Number(it.precio_unit), descuento_pct = Number(it.descuento_pct ?? 0);
    if (![dias, cantidad, precio_unit, descuento_pct].every(Number.isFinite)) return null;
    out.push({ dias, cantidad, precio_unit, descuento_pct });
  }
  return out;
}

/**
 * La acción se puede reclamar para enviar: está `pendiente`, o en `enviando` con el plazo vencido
 * (el envío anterior murió) o sin plazo escrito (para que no quede atascada).
 */
export function accionReclamable(accion: { estado?: string | null; resuelta_at?: string | null }, ahoraMs: number): boolean {
  if (accion.estado === "pendiente") return true;
  return accion.estado === "enviando" && (!accion.resuelta_at || !(Date.parse(accion.resuelta_at) > ahoraMs));
}

/**
 * ¿Se puede ENVIAR (desde la tarjeta o en automático) la cotización de esta acción? Exige que la
 * acción sea una cotización de traslado y siga pendiente (o en `enviando` con el plazo VENCIDO:
 * el envío anterior murió; `resuelta_at` guarda ese plazo mientras se envía, y sin plazo escrito
 * también se da por vencido para que no quede atascada), que la cotización sea DE ESTA
 * conversación y tenga `traslado_json`, que la conversación sea de WhatsApp con remitente, y que
 * los importes se puedan imprimir.
 */
export function planAccionTraslado(
  accion: { tipo?: string | null; estado?: string | null; conversacion_id?: string | null; resuelta_at?: string | null; resultado_id?: number | null } | null,
  cotizacion: { id: number; crm_conversacion_id?: string | null; traslado_json?: unknown; items_json?: unknown; moneda?: string | null; tipo_cambio?: unknown; incluye_igv?: boolean | null; precio_cliente?: unknown } | null,
  conv: { id?: string | null; canal?: string | null; wa_id?: string | null } | null,
  ahoraMs: number = Date.now(),
): { codigo: PlanAccion; detalle: string } {
  if (!accion || accion.tipo !== "cotizacion_traslado")
    return { codigo: "cotizacion_no_existe", detalle: "La acción no es una cotización de traslado." };
  if (!accionReclamable(accion, ahoraMs)) {
    return {
      codigo: "no_pendiente",
      detalle: accion.estado === "enviando" ? "Se está enviando en este momento: espera unos minutos." : `La cotización ya fue ${accion.estado ?? "resuelta"}.`,
    };
  }
  if (!cotizacion) return { codigo: "cotizacion_no_existe", detalle: "La cotización ya no existe (se borró en /cotizaciones)." };
  if (!accion.conversacion_id || cotizacion.crm_conversacion_id !== accion.conversacion_id
    || (accion.resultado_id != null && Number(accion.resultado_id) !== Number(cotizacion.id))) {
    return { codigo: "cotizacion_ajena", detalle: "La cotización no es de esta conversación." };
  }
  if (cotizacion.traslado_json == null || typeof cotizacion.traslado_json !== "object") {
    return { codigo: "cotizacion_ajena", detalle: "La cotización no es un traslado cotizado por la IA." };
  }
  if (!conv || (conv.id != null && conv.id !== accion.conversacion_id) || conv.canal !== "whatsapp")
    return { codigo: "canal_no_whatsapp", detalle: "La conversación no es de WhatsApp: el PDF se envía solo por WhatsApp." };
  if (!(typeof conv.wa_id === "string" && conv.wa_id.trim()))
    return { codigo: "sin_remitente", detalle: "La conversación no tiene el número de WhatsApp del cliente." };
  const items = itemsMonto(cotizacion.items_json);
  const tot = items ? totalesEnMoneda(items, normalizarMoneda(cotizacion.moneda), cotizacion.tipo_cambio, cotizacion.incluye_igv !== false) : null;
  if (!tot || !(tot.total > 0))
    return { codigo: "sin_precio", detalle: "La cotización no tiene un importe que se pueda imprimir: corrígela en /cotizaciones." };
  return { codigo: "ok", detalle: "" };
}
