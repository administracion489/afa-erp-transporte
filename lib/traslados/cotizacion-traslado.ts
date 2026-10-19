// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/cotizacion-traslado.ts — El traslado que cotizó la IA, como FILA de `cotizaciones`
// y como CONTENIDO de su PDF. Motor PURO: no lee la base ni dibuja (el dibujo es
// lib/traslados/pdf-traslado.ts).
//
// LA FILA AUTORITATIVA ES `cotizaciones`, guardada como la guarda /cotizaciones:
//  · los importes van SIEMPRE en soles (`items_json[].precio_unit` con 4 decimales si la cotización
//    es en dólares, para que el ida y vuelta devuelva exacto el precio de lista), y
//    `precio_cliente` es el TOTAL CON IGV (`incluye_igv` true), igual que `totPEN.total`;
//  · `moneda` y `tipo_cambio` son presentación (cotizaciones-04);
//  · `traslado_json` guarda solo HECHOS que no son dinero (pax, maletas, zonas, firma, validez).
//
// EL PDF SE DERIVA DE LA FILA CADA VEZ (`contenidoPdfTraslado`): si un ejecutivo la corrige en
// /cotizaciones, el PDF que se envía sale corregido. Los totales salen de `totalesEnMoneda`, la
// misma función de los PDF de /cotizaciones, y `cuadraConMotor` comprueba ANTES de enviar que la
// fila reproduce los importes del tarifario (ese módulo usa un IGV de 18 % fijo y el motor el de
// `config_tributaria`: si un día difieren, la cotización no sale sola).
//
// NINGÚN DATO DE LA EMPRESA ESTÁ ESCRITO AQUÍ: nombre, RUC y logo salen del perfil
// (`empresaConDefectos`). Sin logo en el perfil, el PDF va sin logo; nunca el del bundle.
// ──────────────────────────────────────────────────────────────────────────────

import type { EntradaSimulador, LugarEntrada } from "./api";
import type { ConfigTraslados } from "./datos";
import { importesTraslado, tarifaDelPar, type CategoriaTraslado, type ResultadoTraslado, type TarifaTraslado, type UbicacionZona, type Zona } from "./motor";
import { aPENdesdeCot, normalizarMoneda, revisarTipoCambio, totalesEnMoneda, type Moneda } from "../cotizacion-moneda";
import { fmtFechaDoc, fmtImporte } from "../cotizacion-idioma";
import { numeroCotizacion } from "../cotizacion-pdf";
import { empresaConDefectos, type EmpresaResuelta, type PerfilEmpresa } from "../empresa-perfil";
import { fechaLima } from "../alertas-horario";

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

export type ConsideracionesJson = { incluye: string[]; no_incluye: string[]; generales: string[] };

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
  asunto: string;
  atencion: string | null;
  numero_cotizacion: null;
  crm_conversacion_id: string;
  traslado_json: TrasladoJson;
};

/** La fila leída de vuelta (o armada para el PDF de ejemplo del simulador, con id 0). */
export type FilaCotizacionLeida = {
  id: number;
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
  crm_conversacion_id?: string | null;
  traslado_json?: Partial<TrasladoJson> | null;
};

const textoLugar = (l: LugarEntrada): string =>
  typeof l === "string" ? l.trim() : String(l.texto ?? "").trim();

/** El nombre que se imprime: el de la zona si es un PUNTO (el aeropuerto), si no lo que dijo el cliente. */
function nombreLugar(l: LugarEntrada, z: Zona | null | undefined): string {
  if (z?.tipo === "punto") return z.nombre.slice(0, MAX_LUGAR);
  const t = textoLugar(l);
  if (t) return t.slice(0, MAX_LUGAR);
  return z ? `${z.nombre} (ubicación compartida)`.slice(0, MAX_LUGAR) : "Ubicación compartida";
}

const recortar = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/**
 * La fila de `cotizaciones` de un traslado cotizable. LANZA si el resultado no es cotizable: el
 * llamador solo crea una cotización con precio, y una fila sin él no tiene arreglo silencioso.
 */
export function filaCotizacionTraslado(
  r: ResultadoTraslado,
  e: EntradaSimulador,
  x: { convId: string; clienteId: number | null; atencion: string | null; config: ConfigTraslados; firma: string; hoy: string; ahora?: string },
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
  const generales = [...(x.config.consideraciones ?? []), ...(usd ? x.config.consideraciones_usd ?? [] : [])]
    .map((s) => String(s ?? "").trim()).filter(Boolean);
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
    consideraciones_json: { incluye: [], no_incluye: [], generales },
    asunto: "Traslado cotizado por la IA (WhatsApp)",
    atencion: x.atencion ? String(x.atencion).trim().slice(0, 200) || null : null,
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

// ── 3. El contenido del PDF ──────────────────────────────────────────────────

export const LINEA_DISPONIBILIDAD = "La disponibilidad de la unidad y la reserva del servicio las confirma un ejecutivo.";

export type ContenidoPdf = {
  /** Título del documento y del archivo. */
  titulo: string;
  numero: string;
  /** Fecha de emisión (dd/mm/aaaa, Lima). */
  fecha: string;
  /** Color primario (#rrggbb). */
  color: string;
  /** Texto en diagonal y claro sobre la página (el PDF de ejemplo); null en uno real. */
  marcaAgua: string | null;
  empresa: { nombre: string; lineas: string[] };
  /** El pie de cada página. */
  pie: string;
  atencion: string | null;
  servicio: { etiqueta: string; valor: string }[];
  tabla: { encabezados: [string, string, string, string]; filas: [string, string, string, string][] };
  totales: { etiqueta: string; valor: string; fuerte?: boolean }[];
  validez: string | null;
  consideraciones: { titulo: string; lineas: string[] }[];
  /** La línea fija, siempre presente. */
  aviso: string;
  /** El perfil de la empresa no tiene nombre: lo que se imprime como empresa es el aviso. */
  perfilSinConfigurar: boolean;
  /** El logo del perfil (lo descarga el servidor). null = sin logo. */
  logoUrl: string | null;
};

/** El perfil tiene nombre propio (no se imprimiría el aviso «CONFIGURA EL PERFIL…»). */
export function perfilConfigurado(perfil: PerfilEmpresa | null | undefined): boolean {
  return !empresaConDefectos(perfil).sinConfigurar;
}

/** Color neutro de respaldo: no es la marca de nadie. */
export const COLOR_DEFECTO = "#1d3557";

/** Un color hexadecimal #rgb o #rrggbb, o el de respaldo. */
export function colorValido(c: unknown): string {
  const s = String(c ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s.slice(1).split("").map((x) => x + x).join("")}`.toLowerCase();
  return COLOR_DEFECTO;
}

const v = (x: unknown) => String(x ?? "").trim();
const fecha = (iso: string | null | undefined, estilo: "corta" | "larga_mayus") =>
  iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? fmtFechaDoc(iso, "es", estilo) : null;

/**
 * El contenido del PDF, DERIVADO de la fila. LANZA si los importes no se pueden imprimir (sin
 * ítems, o en dólares sin un tipo de cambio válido): imprimir soles rotulados como dólares es el
 * error caro, y el llamador lo trata como «PDF no generado».
 */
export function contenidoPdfTraslado(
  cot: FilaCotizacionLeida,
  empresa: EmpresaResuelta,
  opts?: { ejemplo?: boolean; colorPrimario?: string | null; hoy?: string },
): ContenidoPdf {
  const items = Array.isArray(cot.items_json) ? (cot.items_json as (ItemTraslado & { descripcion?: string })[]) : [];
  if (items.length === 0) throw new Error("La cotización no tiene ítems: no hay nada que imprimir.");
  const moneda = normalizarMoneda(cot.moneda);
  const conIGV = cot.incluye_igv !== false;
  const tot = totalesEnMoneda(items.map((it) => ({
    dias: Number(it.dias ?? 1), cantidad: Number(it.cantidad), precio_unit: Number(it.precio_unit), descuento_pct: Number(it.descuento_pct ?? 0),
  })), moneda, cot.tipo_cambio, conIGV);
  if (!tot || ![tot.subtotal, tot.total].every(Number.isFinite)) {
    throw new Error("La cotización está en dólares sin un tipo de cambio válido: no se puede imprimir.");
  }
  const money = (n: number) => fmtImporte(n, moneda, "es");
  const tj = cot.traslado_json ?? null;

  const lineasEmpresa = [
    empresa.razonSocial && empresa.razonSocial !== empresa.nombre ? empresa.razonSocial : "",
    empresa.ruc ? `RUC ${empresa.ruc}` : "",
    empresa.direccion,
    [empresa.telefono, empresa.email].filter(Boolean).join(" · "),
    empresa.web,
  ].map(v).filter(Boolean);

  const sentido = cot.tipo_servicio === "ida_retorno" || tj?.sentido === "ida_retorno" ? "Ida y retorno" : "Solo ida";
  const conHora = (f: string | null, h: string | null) => {
    const d = fecha(f, "larga_mayus");
    if (!d) return null;
    return h && /^\d{2}:\d{2}/.test(h) ? `${d} · ${h.slice(0, 5)} h` : d;
  };
  const servicio: { etiqueta: string; valor: string }[] = [
    { etiqueta: "Recojo", valor: v(cot.origen) || "—" },
    { etiqueta: "Destino", valor: v(cot.destino) || "—" },
    { etiqueta: "Servicio", valor: `Traslado · ${sentido}` },
  ];
  const ida = conHora(cot.fecha_servicio, cot.hora_ida);
  if (ida) servicio.push({ etiqueta: sentido === "Ida y retorno" ? "Ida" : "Fecha", valor: ida });
  if (sentido === "Ida y retorno") {
    const vuelta = conHora(cot.fecha_retorno, cot.hora_retorno);
    if (vuelta) servicio.push({ etiqueta: "Retorno", valor: vuelta });
  }
  const cat = tj?.categoria;
  if (cat?.nombre) servicio.push({ etiqueta: "Vehículo", valor: `${cat.nombre}${Number(cat.capacidad) > 0 ? ` (hasta ${cat.capacidad} pasajeros)` : ""}` });
  else if (v(cot.tipo_vehiculo)) servicio.push({ etiqueta: "Vehículo", valor: v(cot.tipo_vehiculo) });
  if (Number(tj?.pax) > 0) servicio.push({ etiqueta: "Pasajeros", valor: String(tj!.pax) });
  if (tj && Number.isFinite(Number(tj.maletas))) {
    const m = Number(tj.maletas);
    servicio.push({ etiqueta: "Maletas (23 kg)", valor: m === 0 ? "Sin maletas grandes" : String(m) });
  }

  const filas = items.map((it, i): [string, string, string, string] => {
    const cant = Number(it.dias ?? 1) * Number(it.cantidad);
    return [v(it.descripcion) || "Traslado", String(Number.isFinite(cant) ? cant : ""), money(tot.unitarios[i]), money(tot.lineas[i])];
  });
  const totales: ContenidoPdf["totales"] = [{ etiqueta: "Subtotal", valor: money(tot.subtotal) }];
  if (conIGV) totales.push({ etiqueta: `IGV (${IGV_PDF_PCT} %)`, valor: money(tot.igv) });
  totales.push({ etiqueta: conIGV ? "Total (IGV incluido)" : "Total", valor: money(tot.total), fuerte: true });

  const cj = cot.consideraciones_json ?? {};
  const lista = (x: unknown) => (Array.isArray(x) ? x.map(v).filter(Boolean) : []);
  const consideraciones = [
    { titulo: "Consideraciones", lineas: lista(cj.generales) },
    { titulo: "Incluye", lineas: lista(cj.incluye) },
    { titulo: "No incluye", lineas: lista(cj.no_incluye) },
  ].filter((c) => c.lineas.length > 0);

  const emision = opts?.hoy
    ?? (cot.created_at && Number.isFinite(Date.parse(cot.created_at)) ? fechaLima(Date.parse(cot.created_at)) : fechaLima(Date.now()));

  const numero = opts?.ejemplo ? "EJEMPLO" : numeroCotizacion(cot);
  return {
    titulo: "Cotización de traslado",
    numero,
    fecha: fecha(emision, "corta") ?? emision,
    color: colorValido(opts?.colorPrimario),
    marcaAgua: opts?.ejemplo ? "EJEMPLO · SIN VALIDEZ" : null,
    empresa: { nombre: empresa.nombre, lineas: lineasEmpresa },
    pie: [empresa.nombre, empresa.ruc ? `RUC ${empresa.ruc}` : "", empresa.telefono, empresa.web].map(v).filter(Boolean).join(" · "),
    atencion: v(cot.atencion) || null,
    servicio,
    tabla: { encabezados: ["Descripción", "Tramos", "Precio por tramo", "Importe"], filas },
    totales,
    validez: fecha(tj?.validez_hasta ?? null, "corta"),
    consideraciones,
    aviso: LINEA_DISPONIBILIDAD,
    perfilSinConfigurar: empresa.sinConfigurar,
    logoUrl: empresa.logo,
  };
}

// ── 4. Texto que cabe en las fuentes estándar del PDF ────────────────────────

/** Lo que las fuentes estándar no tienen y tiene un equivalente legible. */
const EQUIVALENTES: Record<string, string> = {
  "→": "->", "←": "<-", "↔": "<->", "⇄": "<->", "⇒": "=>", "➜": "->", "➡": "->",
  "≥": ">=", "≤": "<=", "≠": "!=", "×": "x", "−": "-", "‐": "-", "‑": "-", "‒": "-",
  "✓": "", "✔": "", "✗": "", "✘": "",
};

/**
 * El texto con SOLO los caracteres que la fuente puede dibujar (`font.getCharacterSet()`): pdf-lib
 * LANZA con un carácter que WinAnsi no tiene (un emoji, una flecha), y ese texto lo escribe el
 * cliente. Conserva tildes, ñ, «», °, · y €; cambia flechas y signos por su equivalente; quita el
 * resto. Los saltos y tabulaciones pasan a espacio (el dibujo parte las líneas). Con `max`, corta
 * por caracteres completos y termina en «…».
 */
export function aWinAnsi(texto: string, permitidos: ReadonlySet<number>, max?: number): string {
  const base = String(texto ?? "").normalize("NFC").replace(/[\r\n\t\f\v\u2028\u2029]+/g, " ");
  let out = "";
  for (const ch of Array.from(base)) {
    const eq = EQUIVALENTES[ch];
    const cand = eq !== undefined ? eq : ch;
    for (const c of Array.from(cand)) {
      const cp = c.codePointAt(0)!;
      if (permitidos.has(cp)) out += c;
    }
  }
  out = out.replace(/ {2,}/g, " ").trim();
  if (max != null && max > 0) {
    const cps = Array.from(out);
    if (cps.length > max) {
      const elipsis = permitidos.has(0x2026) ? "…" : "...";
      out = cps.slice(0, Math.max(0, max - Array.from(elipsis).length)).join("").trimEnd() + elipsis;
    }
  }
  return out;
}

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
