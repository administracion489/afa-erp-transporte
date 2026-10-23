// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/cotizacion-traslado.ts — El traslado que cotizó la IA, como FILA de `cotizaciones`
// y como ENTRADA de su PDF. Motor PURO: no lee la base ni dibuja. El PDF es la plantilla
// CORPORATIVA de /cotizaciones: qué se imprime lo decide lib/cotizacion-corporativo.ts y lo dibuja
// en el servidor lib/pdf-corporativo.ts (antes tenía su propio layout, y no se parecía).
//
// LA FILA AUTORITATIVA ES `cotizaciones`, guardada como la guarda /cotizaciones:
//  · los importes van SIEMPRE en soles (`items_json[].precio_unit` con 4 decimales si la cotización
//    es en dólares, para que el ida y vuelta devuelva exacto el precio de lista), y
//    `precio_cliente` es el TOTAL CON IGV (`incluye_igv` true), igual que `totPEN.total`;
//  · `moneda` y `tipo_cambio` son presentación (cotizaciones-04);
//  · `traslado_json` guarda solo HECHOS que no son dinero (pax, maletas, zonas, firma, validez);
//  · `consideraciones_json` COPIA las condiciones al CREARLA: la cotización es un documento, y
//    cambiar la plantilla (o los ajustes) después no reescribe lo que ya se le dijo a un cliente.
//    De dónde se copian: de la PLANTILLA PDF de la regla «Traslado de la IA × segmento»
//    (lib/traslados/plantilla-traslado-datos.ts; desde supabase/cotizaciones-05), en versión 2 y con
//    `plantilla_pdf`; sin esa plantilla (sin la migración, o sin una que la IA pueda dibujar), de
//    `traslados_config` como siempre (generales; e incluye / no incluye de traslados-07) — y entonces
//    la fila sale byte a byte la de antes, sin `version` ni `plantilla_pdf`.
//
// EL PDF SE DERIVA DE LA FILA CADA VEZ (`entradaCorporativaTraslado`): si un ejecutivo la corrige
// en /cotizaciones, el PDF que se envía sale corregido. Los totales salen de `totalesEnMoneda`, la
// misma función de los PDF de /cotizaciones, y `cuadraConMotor` comprueba ANTES de enviar que la
// fila reproduce los importes del tarifario (ese módulo usa un IGV de 18 % fijo y el motor el de
// `config_tributaria`: si un día difieren, la cotización no sale sola).
//
// NINGÚN DATO DE LA EMPRESA ESTÁ ESCRITO AQUÍ: nombre, RUC, cuentas y logo salen del perfil
// (`empresaConDefectos`). Sin logo en el perfil, el PDF va sin logo; nunca el del bundle.
//
// LO QUE ESCRIBIÓ EL CLIENTE NO SE IMPRIME TAL CUAL: el recojo y el destino van con el nombre de su
// ZONA y, como mucho, una referencia corta entre paréntesis; «Atención» hasta 60 caracteres. Lo
// sospechoso (./texto-libre.ts) no se imprime. El texto crudo queda en `traslado_json` para el
// ejecutivo, que no sale en el PDF.
// ──────────────────────────────────────────────────────────────────────────────

import type { EntradaSimulador, LugarEntrada } from "./api";
import type { ConfigTraslados } from "./datos";
import { claveNombre, importesTraslado, tarifaDelPar, type CategoriaTraslado, type ResultadoTraslado, type TarifaTraslado, type UbicacionZona, type Zona } from "./motor";
import { aPENdesdeCot, normalizarMoneda, revisarTipoCambio, totalesEnMoneda, type Moneda } from "../cotizacion-moneda";
import { fmtFechaDoc, fmtImporte } from "../cotizacion-idioma";
import { cuentasCorporativo, numeroCotizacion } from "../cotizacion-corporativo";
import type { ClientePdf, EntradaPdfCot, PlantillaPdfCfg } from "../cotizacion-pdf";
import { considSnapshot, type PlantillaFila } from "../cotizacion-plantillas";
import { MAX_DESCRIPCION_RENGLONES, MAX_RENGLONES_DESCRIPCION, type VehiculoPDF } from "../pdf-chrome";
import { empresaConDefectos, type CuentaBancaria, type EmpresaResuelta, type PerfilEmpresa } from "../empresa-perfil";
import { fechaLima } from "../alertas-horario";
import { atencionImprimible, referenciaImprimible } from "./texto-libre";
import { urlFotoPermitida, type LadoFoto } from "./fotos-categoria";
import { mismoTelefonoE164 } from "../crm-telefono";

const r2 = (x: number) => Math.round((x + Math.sign(x) * Number.EPSILON) * 100) / 100;
const MAX_LUGAR = 300;
const MAX_DESCRIPCION = 400;

// ── 1. La fila ───────────────────────────────────────────────────────────────

export type ItemTraslado = {
  descripcion: string;
  dias: number;
  cantidad: number;
  precio_unit: number;
  descuento_pct: number;
  pax_contratado: null;
};

export type TrasladoJson = {
  version: 1;
  origen: "ia_crm";
  firma: string;
  pax: number;
  maletas: number;
  categoria: { clave: string; nombre: string; capacidad: number };
  zona_origen: { id: number; nombre: string; tipo: string };
  zona_destino: { id: number; nombre: string; tipo: string };
  texto_origen: string;
  texto_destino: string;
  sentido: "ida" | "ida_retorno";
  tramos: number;
  validez_hasta: string | null;
  nivel_tarifa: string;
  tc_fecha: string | null;
  generada_en: string;
};

/**
 * Las condiciones de la fila. `version: 2` y `plantilla` solo cuando se copiaron de una plantilla
 * (`considSnapshot`): el PDF imprime la fila. Sin ellas, como siempre (de `traslados_config`).
 * `reserva`: la política de reserva, cambios y cancelación de la plantilla (cotizaciones-06); solo
 * cuando la plantilla la tiene. `traslados_config` no tiene política: sin plantilla, no hay clave.
 */
export type ConsideracionesJson = { incluye: string[]; no_incluye: string[]; generales: string[]; reserva?: string[]; version?: number; plantilla?: string | null };

/** Las cuatro listas de `traslados_config` que pueden ir a las condiciones (de antes de cotizaciones-05). */
export type ListasConfigTraslado = {
  consideraciones?: readonly unknown[] | null;
  consideraciones_usd?: readonly unknown[] | null;
  incluye?: readonly unknown[] | null;
  no_incluye?: readonly unknown[] | null;
};

/**
 * LAS CONDICIONES QUE UNA COTIZACIÓN DE TRASLADO COPIA A SU FILA. Una sola definición: la usan
 * `filaCotizacionTraslado` (lo que se guarda y se imprime) y Ajustes de traslados
 * (components/tarifario/traslados-pantalla.ts, lo que se enseña), así que la pantalla no puede
 * describir otras listas que las que copia la IA.
 *  · Con `plantilla` (la de `plantillaParaTraslado`, cotizaciones-05): las de la plantilla
 *    (`considSnapshot` con respaldo VACÍO: una lista NULL de la plantilla es una lista vacía, nunca
 *    las de Ajustes), en versión 2 y con su id. La de dólares ya trae sus líneas de dólares (la
 *    migración las traspasó como consideraciones + consideraciones_usd): no se suman aquí.
 *    La política de reserva (`reserva`) se copia igual, solo si la plantilla la tiene.
 *  · Sin plantilla: las de `traslados_config`, con las de dólares solo si se cotiza en dólares.
 *    Ahí no hay política de reserva: la fila va sin esa clave (el PDF no imprime el bloque).
 * En los dos casos, limpias: sin espacios de los bordes ni líneas vacías.
 */
export function considDeTraslado(plantilla: PlantillaFila | null | undefined, config: ListasConfigTraslado, moneda: Moneda): ConsideracionesJson {
  const limpia = (l: readonly unknown[] | null | undefined) => (Array.isArray(l) ? l : []).map((s) => String(s ?? "").trim()).filter(Boolean);
  if (plantilla) {
    const s = considSnapshot(plantilla, { incluye: [], no_incluye: [], generales: [] });
    return {
      incluye: limpia(s.incluye), no_incluye: limpia(s.no_incluye), generales: limpia(s.generales),
      ...(Array.isArray(s.reserva) ? { reserva: limpia(s.reserva) } : {}),
      version: s.version, plantilla: s.plantilla,
    };
  }
  const usd = moneda === "USD";
  const generales = limpia([...(config.consideraciones ?? []), ...(usd ? config.consideraciones_usd ?? [] : [])]);
  // traslados-07: sin la migración llegan ausentes y las listas quedan vacías (no se imprimen).
  const incluye = limpia(config.incluye);
  const noIncluye = limpia(config.no_incluye);
  return { incluye, no_incluye: noIncluye, generales };
}

/** Lo que se INSERTA en `cotizaciones`. Nombres de columna verificados contra producción (19-10-2026). */
export type FilaCotizacion = {
  cliente_id: number | null;
  estado: "pendiente";
  modo_servicio: "eventual";
  tipo_servicio: "solo_ida" | "ida_retorno";
  origen: string;
  destino: string;
  fecha_servicio: string;
  hora_ida: string | null;
  fecha_retorno: string | null;
  hora_retorno: string | null;
  tipo_vehiculo: string | null;
  /** null A PROPÓSITO: «Aprobar» en /cotizaciones escribe el tarifario si hay equipamiento, y este precio es de zonas. */
  equipamiento: null;
  items_json: ItemTraslado[];
  incluye_igv: true;
  /** El TOTAL CON IGV en soles (como `totPEN.total` de /cotizaciones). */
  precio_cliente: number;
  modo_precio: "tarifario";
  moneda: Moneda;
  tipo_cambio: number | null;
  idioma_pdf: "es";
  consideraciones_json: ConsideracionesJson;
  /** La plantilla de la que se copiaron las condiciones (y de la que el PDF toma las cuentas). Ausente sin plantilla. */
  plantilla_pdf?: string;
  asunto: string;
  atencion: string | null;
  numero_cotizacion: null;
  crm_conversacion_id: string;
  traslado_json: TrasladoJson;
};

/** La fila leída de vuelta (o armada para el PDF de ejemplo del simulador, con id 0). */
export type FilaCotizacionLeida = {
  id: number;
  /** El cliente del ERP vinculado (el PDF imprime sus datos); null o ausente = sin cliente. */
  cliente_id?: number | null;
  numero_cotizacion?: string | null;
  created_at?: string | null;
  estado?: string | null;
  origen: string;
  destino: string;
  fecha_servicio: string | null;
  hora_ida: string | null;
  fecha_retorno: string | null;
  hora_retorno: string | null;
  tipo_servicio: string | null;
  tipo_vehiculo?: string | null;
  items_json: unknown;
  incluye_igv: boolean | null;
  precio_cliente?: number | string | null;
  moneda?: string | null;
  tipo_cambio?: number | string | null;
  atencion?: string | null;
  consideraciones_json?: Partial<ConsideracionesJson> | null;
  /** La plantilla PDF de la cotización (sus CUENTAS van en el PDF); null o ausente = `corporativo`. */
  plantilla_pdf?: string | null;
  crm_conversacion_id?: string | null;
  traslado_json?: Partial<TrasladoJson> | null;
};

const textoLugar = (l: LugarEntrada): string =>
  typeof l === "string" ? l.trim() : String(l.texto ?? "").trim();

/**
 * Lo que se IMPRIME del recojo o del destino. Un PUNTO (el aeropuerto) va con el nombre de su
 * zona y nada más. Cualquier otra zona va con SU nombre (lo que se cotizó) y, como mucho, una
 * referencia corta de lo que dijo el cliente entre paréntesis: «Miraflores (Hotel Belmond)». Si
 * lo del cliente es sospechoso (un enlace, un teléfono, un importe, palabras de pago, más de 80
 * caracteres), no se imprime: queda solo la zona y la cotización va a revisión (planEnvio).
 */
function nombreLugar(l: LugarEntrada, z: Zona): string {
  if (z.tipo === "punto") return z.nombre.slice(0, MAX_LUGAR);
  const ref = referenciaImprimible(textoLugar(l));
  if (ref) return claveNombre(ref) === claveNombre(z.nombre) ? z.nombre.slice(0, MAX_LUGAR) : `${z.nombre} (${ref})`.slice(0, MAX_LUGAR);
  if (typeof l !== "string") return `${z.nombre} (ubicación compartida)`.slice(0, MAX_LUGAR);
  return z.nombre.slice(0, MAX_LUGAR);
}

const recortar = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/**
 * La fila de `cotizaciones` de un traslado cotizable. LANZA si el resultado no es cotizable: el
 * llamador solo crea una cotización con precio, y una fila sin él no tiene arreglo silencioso.
 *
 * `plantilla` (opcional): la de `plantillaParaTraslado`. Con ella, las condiciones se copian de la
 * plantilla (`considSnapshot` con respaldo VACÍO: una lista NULL de la plantilla es una lista vacía,
 * nunca las de `traslados_config`), limpias igual que siempre, en versión 2, y `plantilla_pdf` es su
 * id. Sin ella (null o ausente), byte a byte la fila de antes: las condiciones de `traslados_config`.
 */
export function filaCotizacionTraslado(
  r: ResultadoTraslado,
  e: EntradaSimulador,
  x: { convId: string; clienteId: number | null; atencion: string | null; config: ConfigTraslados; firma: string; hoy: string; ahora?: string; plantilla?: PlantillaFila | null },
): FilaCotizacion {
  const p = r.precio;
  const cat = r.vehiculo?.categoria;
  const zo = r.origen?.zona, zd = r.destino?.zona;
  if (r.codigo !== "cotizable" || !p || !cat || !zo || !zd || !e.fecha_servicio) {
    throw new Error(`Solo se guarda un traslado cotizable (este es «${r.codigo}»).`);
  }
  const usd = p.moneda === "USD";
  const precioUnitPen = aPENdesdeCot(p.precio_tramo, p.moneda, p.tipo_cambio);
  if (precioUnitPen == null) throw new Error("Cotización en dólares sin tipo de cambio: no se puede guardar en soles.");
  const sentido: "ida" | "ida_retorno" = p.tramos === 2 ? "ida_retorno" : "ida";
  const origen = nombreLugar(e.origen, zo);
  const destino = nombreLugar(e.destino, zd);
  const descripcion = recortar(
    `TRASLADO ${sentido === "ida_retorno" ? "IDA Y RETORNO" : "SOLO IDA"} · ${origen} – ${destino} · ${cat.nombre} (hasta ${cat.capacidad} pasajeros) · precio por tramo`,
    MAX_DESCRIPCION,
  );
  const items: ItemTraslado[] = [{ descripcion, dias: 1, cantidad: p.tramos, precio_unit: precioUnitPen, descuento_pct: 0, pax_contratado: null }];
  const totPen = totalesEnMoneda(items, "PEN", null, true)!;
  const consideraciones = considDeTraslado(x.plantilla ?? null, x.config, p.moneda);
  const pax = Number(e.pax) || 0;
  const maletas = Number(e.maletas) || 0;
  return {
    cliente_id: x.clienteId,
    estado: "pendiente",
    modo_servicio: "eventual",
    tipo_servicio: sentido === "ida_retorno" ? "ida_retorno" : "solo_ida",
    origen,
    destino,
    fecha_servicio: e.fecha_servicio,
    hora_ida: e.hora_servicio ?? null,
    fecha_retorno: sentido === "ida_retorno" ? e.fecha_retorno ?? null : null,
    hora_retorno: sentido === "ida_retorno" ? e.hora_retorno ?? null : null,
    tipo_vehiculo: cat.tipo_vehiculo ?? null,
    equipamiento: null,
    items_json: items,
    incluye_igv: true,
    precio_cliente: r2(totPen.total),
    modo_precio: "tarifario",
    moneda: p.moneda,
    tipo_cambio: usd ? p.tipo_cambio : null,
    idioma_pdf: "es",
    consideraciones_json: consideraciones,
    ...(x.plantilla ? { plantilla_pdf: x.plantilla.id } : {}),
    asunto: "Traslado cotizado por la IA (WhatsApp)",
    // Hasta 60 caracteres y nunca algo sospechoso (lo juzga también planEnvio).
    atencion: atencionImprimible(x.atencion),
    numero_cotizacion: null,
    crm_conversacion_id: x.convId,
    traslado_json: {
      version: 1,
      origen: "ia_crm",
      firma: x.firma,
      pax,
      maletas,
      categoria: { clave: cat.clave, nombre: cat.nombre, capacidad: cat.capacidad },
      zona_origen: { id: zo.id, nombre: zo.nombre, tipo: zo.tipo },
      zona_destino: { id: zd.id, nombre: zd.nombre, tipo: zd.tipo },
      texto_origen: textoLugar(e.origen).slice(0, MAX_LUGAR),
      texto_destino: textoLugar(e.destino).slice(0, MAX_LUGAR),
      sentido,
      tramos: p.tramos,
      validez_hasta: r.validez_hasta,
      nivel_tarifa: p.nivel,
      tc_fecha: usd ? p.tipo_cambio_fecha : null,
      generada_en: x.ahora ?? x.hoy,
    },
  };
}

// ── 2. ¿La fila reproduce al motor? ──────────────────────────────────────────

/** La tasa con que `totalesEnMoneda` (lib/cotizacion-moneda.ts) calcula e imprime el IGV. */
export const IGV_PDF_PCT = 18;

/** Holgura numérica sobre el céntimo de redondeo (0.01 en coma flotante no es 0.01). */
const TOL = 0.01 + 1e-6;
const cerca = (a: number, b: number, tol = TOL) => Math.abs(Number(a) - Number(b)) <= tol;

/**
 * Los totales que imprime el PDF (`totalesEnMoneda` sobre la fila, en la moneda del cliente)
 * coinciden con los del motor a ±0.01: precio por tramo, subtotal, IGV y total; y `precio_cliente`
 * es el total en soles de esos mismos ítems. Con un IGV distinto del 18 % no cuadra (el PDF de
 * /cotizaciones lo calcula al 18 % fijo): mejor que lo vea un ejecutivo a mandar dos números.
 */
export function cuadraConMotor(fila: Pick<FilaCotizacionLeida, "items_json" | "incluye_igv" | "moneda" | "tipo_cambio" | "precio_cliente">, r: ResultadoTraslado): boolean {
  const p = r?.precio;
  if (!p || r.codigo !== "cotizable") return false;
  if (fila.incluye_igv !== true) return false;
  // El PDF rotula «IGV (18 %)» y calcula al 18 (`totalesEnMoneda`). Con otra tasa en el motor, en
  // un importe chico la diferencia cabe en el céntimo de tolerancia, pero el rótulo mentiría.
  if (Math.abs(Number(p.igv_pct) - IGV_PDF_PCT) > 1e-9) return false;
  if (normalizarMoneda(fila.moneda) !== p.moneda) return false;
  const items = Array.isArray(fila.items_json) ? (fila.items_json as ItemTraslado[]) : null;
  if (!items || items.length !== 1) return false;
  const it = items[0];
  if (Number(it.dias) !== 1 || Number(it.cantidad) !== p.tramos || Number(it.descuento_pct) !== 0) return false;
  const t = totalesEnMoneda(items, p.moneda, fila.tipo_cambio, true);
  if (!t) return false;
  if (!cerca(t.unitarios[0], p.precio_tramo, 0.005)) return false;
  if (!cerca(t.subtotal, p.subtotal) || !cerca(t.igv, p.igv) || !cerca(t.total, p.total)) return false;
  const pen = totalesEnMoneda(items, "PEN", null, true)!;
  return cerca(Number(fila.precio_cliente), r2(pen.total));
}

/**
 * El resultado del motor RECONSTRUIDO desde una cotización ya guardada, sin volver a geocodificar:
 * las zonas salen de los ids de `traslado_json`, el precio de la tarifa VIGENTE de ese par y el
 * IGV de hoy. Sirve para volver a decidir el envío de una cotización pendiente (el cliente repite
 * el pedido) y para que `cuadraConMotor` compare la fila contra el tarifario de hoy: si alguien
 * cambió el precio, la zona se apagó o la fila se editó, no cuadra y la cotización no sale sola.
 * null si falta cualquier pieza (una zona o categoría borrada o apagada, sin tarifa, USD sin TC).
 */
export function resultadoDeFila(
  fila: Pick<FilaCotizacionLeida, "moneda" | "tipo_cambio" | "traslado_json">,
  cat: { zonas: readonly Zona[]; categorias: readonly CategoriaTraslado[]; tarifas: readonly TarifaTraslado[] },
  igvPct: number,
): ResultadoTraslado | null {
  const tj = fila.traslado_json;
  if (!tj?.zona_origen || !tj.zona_destino || !tj.categoria?.clave) return null;
  const viva = <T extends { activo?: boolean | null }>(x: T | undefined) => (x && x.activo !== false ? x : undefined);
  const za = viva(cat.zonas.find((z) => z.id === Number(tj.zona_origen!.id)));
  const zb = viva(cat.zonas.find((z) => z.id === Number(tj.zona_destino!.id)));
  const categoria = viva(cat.categorias.find((c) => c.clave === tj.categoria!.clave));
  if (!za || !zb || !categoria) return null;
  const moneda = normalizarMoneda(fila.moneda);
  const t = tarifaDelPar(za, zb, categoria.clave, moneda, cat.tarifas, cat.zonas);
  if (!t) return null;
  const tc = moneda === "USD" ? revisarTipoCambio(fila.tipo_cambio).tc : null;
  if (moneda === "USD" && tc == null) return null;
  const tramos = Number(tj.tramos) === 2 ? 2 : 1;
  const precioTramo = Number(t.tarifa.precio_tramo);
  const imp = importesTraslado(precioTramo, tramos, igvPct);
  const ubic = (z: Zona): UbicacionZona => ({ codigo: z.tipo === "punto" ? "punto" : "distrito", zona: z, distrito: null, distancia_m: null, detalle: "" });
  return {
    codigo: "cotizable", accion: "cotizar", motivo: "", faltan: [], explicacion: [],
    origen: ubic(za), destino: ubic(zb),
    vehiculo: { codigo: "ok", categoria, alternativas: [], asientos: 0, detalle: "" },
    moneda,
    precio: {
      moneda, precio_tramo: precioTramo, tramos, subtotal: imp.subtotal, igv_pct: igvPct, igv: imp.igv, total: imp.total,
      subtotal_pen: aPENdesdeCot(imp.subtotal, moneda, tc) as number, total_pen: aPENdesdeCot(imp.total, moneda, tc) as number,
      tipo_cambio: tc, tipo_cambio_fecha: tj.tc_fecha ?? null, nivel: t.nivel,
    },
    validez_hasta: tj.validez_hasta ?? null,
  };
}

/**
 * Las cifras que imprime el PDF de una fila (precio por tramo, subtotal, IGV y total, en la moneda
 * del cliente) y el total y la validez ya escritos. Son las únicas que el agente puede repetir
 * cuando la cotización ya se envió. null si los importes no se pueden imprimir.
 */
export function cifrasDeFila(fila: Pick<FilaCotizacionLeida, "items_json" | "moneda" | "tipo_cambio" | "incluye_igv" | "traslado_json">): { figuras: number[]; total: string; validez: string | null } | null {
  const items = Array.isArray(fila.items_json) ? (fila.items_json as ItemTraslado[]) : [];
  if (!items.length) return null;
  const moneda = normalizarMoneda(fila.moneda);
  const t = totalesEnMoneda(items.map((it) => ({
    dias: Number(it.dias ?? 1), cantidad: Number(it.cantidad), precio_unit: Number(it.precio_unit), descuento_pct: Number(it.descuento_pct ?? 0),
  })), moneda, fila.tipo_cambio, fila.incluye_igv !== false);
  if (!t || !Number.isFinite(t.total)) return null;
  return {
    figuras: [...t.unitarios, ...t.lineas, t.subtotal, t.igv, t.total].map((n) => r2(n)),
    total: fmtImporte(t.total, moneda, "es"),
    validez: fecha(fila.traslado_json?.validez_hasta ?? null, "corta"),
  };
}

// ── 3. La entrada del PDF corporativo ────────────────────────────────────────
// El PDF del traslado es la plantilla CORPORATIVA de /cotizaciones (lib/cotizacion-corporativo.ts
// decide qué se imprime; lib/pdf-corporativo.ts lo dibuja en el servidor). Aquí solo se arma su
// entrada desde la fila, con las cuatro trampas del traslado resueltas:
//  1. LAS CONSIDERACIONES SALEN SOLO DE LA FILA. En una fila de antes (sin `version`), `considParaPdf`
//     deja ganar las condiciones de la PLANTILLA, y las seis generales de la corporativa pisarían las
//     del traslado (los 30 min de espera, el TAM): `cfgSoloCuentas` le quita a la plantilla todo
//     menos las cuentas. Desde cotizaciones-05 la fila nace en versión 2 con las condiciones de SU
//     plantilla (`plantilla_pdf`) ya copiadas, que es lo mismo que se imprime así: `cfgSoloCuentas`
//     sigue haciendo falta para las cotizaciones de traslado de antes, y la plantilla solo aporta sus
//     CUENTAS.
//  2. LA VALIDEZ SE DICE COMO ES: un traslado vence en la fecha del servicio si llega antes de los
//     30 días, y «Válida 30 días» sería falso → `corp_sub_hasta` («Válida hasta el …»).
//  3. EL ASUNTO NO SE IMPRIME: lleva un texto interno («Traslado cotizado por la IA (WhatsApp)»).
//  4. LA UNIDAD SE DESCRIBE CON DATOS ESCRITOS (`vehiculoDeCategoria`): la descripción para el
//     cliente de la categoría o «{nombre} para hasta N pasajeros · bodega para M maletas de 23 kg».
//     Sin ella, `descripcionVehiculoPdf` inventaría «Bus con capacidad… A/C…», falso para un AUTO.
// Sin cliente del ERP, CLIENTE es la atención (ya saneada) y CELULAR el wa_id de la conversación;
// el REPRESENTANTE no se imprime.

export const LINEA_DISPONIBILIDAD = "La disponibilidad de la unidad y la reserva del servicio las confirma un ejecutivo.";

/** El perfil tiene nombre propio (no se imprimiría el aviso «CONFIGURA EL PERFIL…»). */
export function perfilConfigurado(perfil: PerfilEmpresa | null | undefined): boolean {
  return !empresaConDefectos(perfil).sinConfigurar;
}

const v = (x: unknown) => String(x ?? "").trim();
const fecha = (iso: string | null | undefined, estilo: "corta" | "larga_mayus") =>
  iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? fmtFechaDoc(iso, "es", estilo) : null;

/** La categoría de `traslado_categorias` como la lee el PDF. Las tres últimas son de traslados-07. */
export type CategoriaPdf = {
  clave: string;
  nombre: string;
  capacidad: number | string | null;
  maletas_bodega?: number | string | null;
  tipo_vehiculo?: string | null;
  foto_externa_url?: string | null;
  foto_interna_url?: string | null;
  descripcion_cliente?: string | null;
};

/** El tope de la descripción para el cliente (el CHECK de traslados-08; traslados-07 lo tenía en 300). */
export const MAX_DESCRIPCION_CLIENTE = MAX_DESCRIPCION_RENGLONES;
/** Cuántos renglones imprime el PDF (no medido: caben en la hoja 2 junto a las fotos). */
export const MAX_RENGLONES_CLIENTE = MAX_RENGLONES_DESCRIPCION;

/**
 * La descripción escrita tal como se GUARDA y se imprime: en renglones (el dueño la escribe como
 * lista), cada renglón sin espacios de más y sin renglones vacíos. Vacía = "".
 */
export function normalizarDescripcionCliente(texto: string | null | undefined): string {
  return String(texto ?? "")
    .split(/\r\n?|[\n\u2028\u2029\v\f]/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * La descripción de la unidad para el cliente: la que escribió una persona en la categoría o, sin
 * ella, una frase con DATOS ESCRITOS (asientos y bodega). Nunca «A/C» ni nada que nadie declaró.
 * La escrita conserva sus renglones (hasta `MAX_RENGLONES_CLIENTE` y `MAX_DESCRIPCION_CLIENTE`).
 */
export function descripcionCategoria(cat: Pick<CategoriaPdf, "nombre" | "capacidad" | "maletas_bodega" | "descripcion_cliente">): string {
  const escrita = normalizarDescripcionCliente(cat.descripcion_cliente);
  if (escrita) {
    const enRenglones = escrita.split("\n").slice(0, MAX_RENGLONES_CLIENTE).join("\n");
    return Array.from(enRenglones).slice(0, MAX_DESCRIPCION_CLIENTE).join("").trim();
  }
  const n = Math.trunc(Number(cat.capacidad));
  const m = Math.trunc(Number(cat.maletas_bodega));
  const pax = Number.isFinite(n) && n > 0 ? ` para hasta ${n} ${n === 1 ? "pasajero" : "pasajeros"}` : "";
  // «Minivan H1 10 pax para hasta 10 pasajeros» dice lo mismo dos veces: si la frase va a decir
  // los pasajeros, se le quita al nombre su «N pax» / «N-M pax» final (el de la ficha no cambia).
  const sinPax = pax ? v(cat.nombre).replace(/\s*\b\d+(\s*-\s*\d+)?\s*pax\.?\s*$/i, "").trim() : "";
  const nombre = sinPax || v(cat.nombre) || "Unidad";
  const bodega = Number.isFinite(m) && m > 0 ? ` · bodega para ${m} ${m === 1 ? "maleta" : "maletas"} de 23 kg` : "";
  return `${nombre}${pax}${bodega}`;
}

/**
 * La unidad del PDF desde la categoría. Con `supabaseUrl`, una foto que no sea del bucket
 * `traslados-fotos` del propio proyecto, con el nombre exacto que le pone la subida y de ESTA
 * categoría y ESTE lado (`urlFotoPermitida`), se descarta: no se imprime ni se intenta bajar.
 */
export function vehiculoDeCategoria(cat: CategoriaPdf | null | undefined, opts: { supabaseUrl?: string | null } = {}): VehiculoPDF | null {
  if (!cat) return null;
  const foto = (u: string | null | undefined, lado: LadoFoto) => {
    const x = v(u);
    if (!x) return null;
    return opts.supabaseUrl !== undefined && !urlFotoPermitida(x, opts.supabaseUrl, { clave: v(cat.clave), lado }) ? null : x;
  };
  const n = Math.trunc(Number(cat.capacidad));
  return {
    categoria: v(cat.nombre) || null,
    capacidad_pasajeros: Number.isFinite(n) && n > 0 ? n : null,
    equipamiento: null,
    foto_externa_url: foto(cat.foto_externa_url, "externa"),
    foto_interna_url: foto(cat.foto_interna_url, "interna"),
    descripcion_unidad: descripcionCategoria(cat),
    // La escrita se imprime en renglones; la frase por defecto es una sola línea (da igual).
    descripcion_renglones: true,
  };
}

/**
 * La plantilla con SOLO lo que decide las cuentas bancarias: si se imprimen, si se usan las de la
 * plantilla y cuáles son. Sin título, cierre ni condiciones (ver la trampa 1 arriba).
 */
export function cfgSoloCuentas(cfg: PlantillaPdfCfg | null | undefined): PlantillaPdfCfg | null {
  if (!cfg) return null;
  const out: PlantillaPdfCfg = {};
  if (cfg.mostrar_cuentas_bancarias != null) out.mostrar_cuentas_bancarias = cfg.mostrar_cuentas_bancarias;
  if (cfg.usar_bancos_propios != null) out.usar_bancos_propios = cfg.usar_bancos_propios;
  for (const n of [1, 2, 3] as const) for (const k of ["nombre", "cuenta", "cci"] as const) {
    const clave = `banco_${n}_${k}` as const;
    if (cfg[clave] != null) out[clave] = cfg[clave];
  }
  return out;
}

// ── Las cuentas de la plantilla frente a las de `corporativo` ─────────────────
// Las CUENTAS del PDF de la IA salen de la plantilla de la cotización (`plantilla_pdf`), y esa
// plantilla la edita quien tiene el módulo Cotizaciones. Antes de cotizaciones-05 salían siempre de
// `corporativo`. Un número de cuenta cambiado en la plantilla de traslados saldría por WhatsApp sin
// que nadie lo viera, con el nombre y el RUC de la empresa: si las cuentas que imprime la plantilla
// no son las que imprimiría `corporativo`, el PDF lo AVISA (`cuentas_distintas_de_corporativo`) y
// la IA lo deja para revisión (`cuentas_distintas`, lib/traslados/envio-ia.ts).

/** Contra qué se comparan las cuentas de la plantilla del PDF. */
export type ReferenciaCuentas =
  /** El PDF ya imprime las de `corporativo` (o su respaldo): no hay nada que comparar. */
  | { estado: "misma" }
  /** La fila `corporativo` (null: no existe, y entonces las del perfil, como sin plantilla). */
  | { estado: "leida"; cfg: PlantillaPdfCfg | null }
  /** La fila `corporativo` no se pudo leer: no se puede comprobar. */
  | { estado: "ilegible"; detalle: string };

export type CodigoCuentasFrente = "misma_plantilla" | "iguales" | "distintas" | "sin_comprobar";

export type CuentasFrente = {
  codigo: CodigoCuentasFrente;
  /** Las que imprime el PDF (las de la plantilla, en la moneda de la cotización). */
  plantilla: CuentaBancaria[];
  /** Las que imprimiría `corporativo`; null si no se pudo leer o es la misma plantilla. */
  corporativo: CuentaBancaria[] | null;
};

/** Una cuenta en una línea: «BCP 191-111 CCI 002-191 (PEN)». */
export function cuentaEnUnaLinea(c: CuentaBancaria): string {
  return [c.banco, c.cuenta, c.cci ? `CCI ${c.cci}` : "", c.moneda ? `(${c.moneda})` : ""].map(v).filter(Boolean).join(" ");
}

/** La identidad de una cuenta para comparar: sin espacios de más, sin distinguir mayúsculas. */
const claveCuenta = (c: CuentaBancaria) => [c.banco, c.cuenta, c.cci, c.moneda ?? ""].map((x) => v(x).replace(/\s+/g, " ").toUpperCase()).join("|");

/** El mismo conjunto de cuentas (el orden no cuenta). */
export function mismasCuentas(a: readonly CuentaBancaria[], b: readonly CuentaBancaria[]): boolean {
  const ka = a.map(claveCuenta).sort(), kb = b.map(claveCuenta).sort();
  return ka.length === kb.length && ka.every((x, i) => x === kb[i]);
}

/**
 * Las cuentas que imprime el PDF de un traslado con su plantilla (`cfgSoloCuentas` +
 * `cuentasCorporativo`, lo mismo que dibuja el PDF) frente a las que imprimiría con `corporativo`.
 * `sin_comprobar` cuando `corporativo` no se pudo leer: no se puede decir que sean las mismas.
 */
export function cuentasFrenteACorporativo(x: {
  plantilla: PlantillaPdfCfg | null; referencia: ReferenciaCuentas; empresa: PerfilEmpresa | null; moneda: unknown;
}): CuentasFrente {
  const moneda = normalizarMoneda(x.moneda);
  const de = (cfg: PlantillaPdfCfg | null) => cuentasCorporativo(cfgSoloCuentas(cfg), x.empresa, moneda).cuentas;
  const plantilla = de(x.plantilla);
  if (x.referencia.estado === "misma") return { codigo: "misma_plantilla", plantilla, corporativo: null };
  if (x.referencia.estado === "ilegible") return { codigo: "sin_comprobar", plantilla, corporativo: null };
  const corporativo = de(x.referencia.cfg);
  return { codigo: mismasCuentas(plantilla, corporativo) ? "iguales" : "distintas", plantilla, corporativo };
}

/** El cliente del ERP como lo lee el PDF (`clientes`). */
export type ClienteErp = {
  nombre?: string | null; empresa?: string | null; tipo?: string | null; ruc?: string | null; dni?: string | null;
  direccion?: string | null; telefono?: string | null; operativo_nombre?: string | null;
};

/**
 * Por qué el PDF imprime (o no) los datos del cliente del ERP:
 *  · `contacto`: el cliente está VINCULADO al contacto del CRM (lo vinculó una persona);
 *  · `telefono`: el número COMPLETO del cliente es el wa_id que pidió la cotización;
 *  · `sin_cliente`: la cotización no tiene cliente del ERP;
 *  · `no_verificado`: tiene uno y nada prueba que sea quien escribe → atención y celular.
 */
export type VinculoClientePdf = "contacto" | "telefono" | "sin_cliente" | "no_verificado";

/**
 * El cliente del ERP que el PDF puede imprimir. El PDF de un traslado le llega por WhatsApp a quien
 * escribió, a veces sin que nadie lo revise, y lleva nombre, RUC, DNI, dirección y teléfono: solo se
 * imprimen si una persona vinculó ese cliente al contacto, o si su número COMPLETO es el wa_id
 * (`mismoTelefonoE164`; nunca los últimos 9 dígitos). Con cualquier otro origen del `cliente_id`
 * (una coincidencia vieja por 9 dígitos, uno puesto a mano en /cotizaciones que no está vinculado
 * al contacto) sale con la atención y el celular. La misma regla para el servidor y la pantalla.
 * LÍMITE: un número RECICLADO no se puede detectar (es el mismo número).
 */
export function clienteParaPdf(
  clienteId: unknown,
  cliente: ClienteErp | null | undefined,
  ref: { contactoClienteId?: number | string | null; waId?: string | null },
): { cliente: ClienteErp | null; vinculo: VinculoClientePdf } {
  const id = Number(clienteId);
  if (!cliente || clienteId == null || !Number.isInteger(id) || id <= 0) return { cliente: null, vinculo: "sin_cliente" };
  const vinculado = ref.contactoClienteId != null && String(ref.contactoClienteId).trim() !== "" && Number(ref.contactoClienteId) === id;
  if (vinculado) return { cliente, vinculo: "contacto" };
  if (mismoTelefonoE164(cliente.telefono, ref.waId)) return { cliente, vinculo: "telefono" };
  return { cliente: null, vinculo: "no_verificado" };
}

/** El wa_id como teléfono legible (+51 966 707 225), o null si no es un número. */
export function celularImprimible(waId: string | null | undefined): string | null {
  const d = v(waId).replace(/^\+/, "");
  if (!/^\d{8,15}$/.test(d)) return null;
  if (d.length === 11 && d.startsWith("51")) return `+51 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  return `+${d}`;
}

/**
 * La entrada de `docCorporativo` / `htmlCotizacion` (plantilla corporativa) para un traslado,
 * DERIVADA de su fila: si un ejecutivo la corrigió en /cotizaciones, sale corregida. La página de
 * /cotizaciones y el WhatsApp imprimen lo mismo si las dos la arman aquí.
 *
 * `plantilla` es la de `plantilla_pdf` de la fila (o `corporativo`; solo se usan sus CUENTAS: las
 * condiciones salen de la fila);
 * `categoria`, la de `traslado_categorias` (sin ella, la de `traslado_json`, sin fotos ni bodega);
 * `celular`, el wa_id de la conversación; `contactoClienteId`, el cliente vinculado a su contacto.
 * El `cliente` solo se imprime si `clienteParaPdf` lo verifica. LANZA si la fila no tiene ítems.
 */
export function entradaCorporativaTraslado(
  fila: FilaCotizacionLeida,
  x: {
    empresa: PerfilEmpresa | null;
    cliente?: ClienteErp | null;
    celular?: string | null;
    /** El `cliente_id` del contacto del CRM de la conversación (vinculado por una persona). */
    contactoClienteId?: number | string | null;
    plantilla?: PlantillaPdfCfg | null;
    categoria?: CategoriaPdf | null;
    /** El PDF de ejemplo del simulador: el número dice EJEMPLO. */
    ejemplo?: boolean;
    /** Para filtrar las fotos que no son del bucket del propio proyecto (el servidor lo pasa). */
    supabaseUrl?: string | null;
    ahoraMs?: number;
  },
): EntradaPdfCot {
  const items = Array.isArray(fila.items_json) ? (fila.items_json as (Partial<ItemTraslado> & { descripcion?: string })[]) : [];
  if (items.length === 0) throw new Error("La cotización no tiene ítems: no hay nada que imprimir.");
  const tj = fila.traslado_json ?? null;
  const ahoraMs = x.ahoraMs ?? Date.now();
  const emision = fila.created_at && Number.isFinite(Date.parse(fila.created_at)) ? fechaLima(Date.parse(fila.created_at)) : fechaLima(ahoraMs);
  const atencion = atencionImprimible(fila.atencion);
  const celular = celularImprimible(x.celular);
  const c = clienteParaPdf(fila.cliente_id, x.cliente, { contactoClienteId: x.contactoClienteId, waId: x.celular }).cliente;
  const cliente: ClientePdf = c
    ? {
      nombre: v(c.nombre) || atencion || "",
      empresa: v(c.empresa) || undefined, tipo: v(c.tipo) || undefined,
      ruc: v(c.ruc) || undefined, dni: v(c.dni) || undefined, direccion: v(c.direccion) || undefined,
      telefono: v(c.telefono) || celular || undefined, operativo_nombre: v(c.operativo_nombre) || undefined,
    }
    : { nombre: atencion ?? "", telefono: celular ?? undefined };
  const veh = vehiculoDeCategoria(x.categoria ?? (tj?.categoria?.nombre ? { clave: tj.categoria.clave ?? "", nombre: tj.categoria.nombre, capacidad: tj.categoria.capacidad ?? null } : null),
    x.supabaseUrl !== undefined ? { supabaseUrl: x.supabaseUrl } : {});
  const cj = fila.consideraciones_json ?? {};
  const lista = (l: unknown) => (Array.isArray(l) ? l.map(v).filter(Boolean) : []);
  return {
    cot: {
      id: fila.id,
      numero_cotizacion: x.ejemplo ? "EJEMPLO" : fila.numero_cotizacion ?? null,
      origen: v(fila.origen), destino: v(fila.destino), km: null,
      atencion, asunto: null, punto_retorno: null,
      fecha_servicio: fila.fecha_servicio, fecha_retorno: fila.tipo_servicio === "ida_retorno" ? fila.fecha_retorno : null,
      hora_ida: fila.hora_ida ? fila.hora_ida.slice(0, 5) : null,
      hora_retorno: fila.tipo_servicio === "ida_retorno" && fila.hora_retorno ? fila.hora_retorno.slice(0, 5) : null,
      tipo_servicio: fila.tipo_servicio, incluye_igv: fila.incluye_igv,
      itinerario_texto: null, created_at: fila.created_at ?? "",
      paradas_json: null, fechas_multidia_json: null,
      modo_servicio: "eventual", tipo_vehiculo: fila.tipo_vehiculo ?? null,
      moneda: fila.moneda ?? null, tipo_cambio: fila.tipo_cambio ?? null, idioma_pdf: "es",
    },
    cliente,
    items: items.map((it) => ({
      descripcion: v(it.descripcion) || "Traslado",
      dias: Number(it.dias ?? 1), cantidad: Number(it.cantidad), precio_unit: Number(it.precio_unit), descuento_pct: Number(it.descuento_pct ?? 0),
    })),
    vehiculos: veh ? [veh] : [],
    repr: "",
    consid: { incluye: lista(cj.incluye), no_incluye: lista(cj.no_incluye), generales: lista(cj.generales), ...(Array.isArray(cj.reserva) ? { reserva: lista(cj.reserva) } : {}) },
    plantilla: "corporativo",
    cfg: cfgSoloCuentas(x.plantilla),
    empresa: x.empresa,
    idioma: "es",
    // El año del título es el de Lima (mediodía del día de hoy en Lima: en el servidor, que corre
    // en UTC, la medianoche de Lima cae el día anterior).
    ahora: new Date(`${fechaLima(ahoraMs)}T12:00:00`),
    fechaEmision: emision,
    validezHasta: tj?.validez_hasta ?? null,
    notaTotales: LINEA_DISPONIBILIDAD,
    omitirListasVacias: true,
  };
}

// ── 4. Texto que cabe en las fuentes estándar del PDF ────────────────────────
// `aWinAnsi` vive en lib/pdf-winansi.ts (lo usa también el PDF corporativo del servidor); se
// re-exporta aquí porque es donde lo buscan los demás.
export { aWinAnsi } from "../pdf-winansi";

// ── 5. Archivo, ruta y texto del documento ───────────────────────────────────

/** Nombre del archivo, solo ASCII (WhatsApp lo enseña tal cual y algunos teléfonos se atoran con tildes). */
export const nombreArchivoPdf = (numero: string): string => {
  const n = String(numero ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `Cotizacion-${n || "traslado"}.pdf`;
};

/** La ruta de la copia enviada dentro del bucket. Valida cada pieza: no se arma una ruta con lo que no lo es. */
export const rutaPdf = (cotId: number, ym: string, uuid: string): string => {
  if (!Number.isInteger(cotId) || cotId <= 0) throw new Error("Id de cotización inválido.");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new Error("Mes inválido (se espera AAAA-MM).");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) throw new Error("Identificador inválido.");
  return `cotizaciones-ia/${ym}/${cotId}-${uuid.toLowerCase()}.pdf`;
};

/** El texto que acompaña al documento en WhatsApp. Lo arma el código, nunca el modelo. */
export function captionDocumento(cot: Pick<FilaCotizacionLeida, "id" | "numero_cotizacion" | "origen" | "destino">, empresa: EmpresaResuelta): string {
  const ruta = [v(cot.origen), v(cot.destino)].filter(Boolean).map((s) => recortar(s, 80)).join(" → ");
  const de = empresa.sinConfigurar ? "" : ` · ${empresa.nombre}`;
  return recortar(`Cotización N° ${numeroCotizacion(cot)}${ruta ? ` · ${ruta}` : ""}${de}`, 1000);
}
