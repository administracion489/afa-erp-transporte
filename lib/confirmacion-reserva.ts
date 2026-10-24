// ──────────────────────────────────────────────────────────────────────────────
// lib/confirmacion-reserva.ts — La CONFIRMACIÓN DE RESERVA que se le entrega al cliente. PURO:
// no lee la base ni dibuja nada. Decide QUÉ se puede afirmar en el papel y con qué datos; el PDF
// lo dibuja lib/confirmacion-reserva-pdf.ts y los datos los lee lib/confirmacion-reserva-datos.ts.
//
// CINCO REGLAS QUE NO SE AFLOJAN:
//  1. NINGÚN IMPORTE SE CALCULA DE DATOS INCOMPLETOS. El total es el `precio_cliente` registrado
//     en los tramos del DÍA (la ida y su retorno: la tarifa va en UNO de los dos, y si va en los
//     dos se BLOQUEA — imprimirlo sería cobrarle el día dos veces). Sin importe → bloqueo, nunca
//     un cero. El IGV NO se calcula: se dice lo que dice la cotización (`incluye_igv`), y sin
//     cotización no se afirma nada sobre él.
//  2. EL ADELANTO ES UN COBRO REGISTRADO EN `pagos`, no una captura del cliente. Lo registra
//     Tesorería/Finanzas (`pagos.reserva_id`, supabase/reservas-08). Sin cobro y sin condición
//     de crédito del cliente, NO se emite la confirmación (`sin_adelanto`). Un cobro en otra
//     moneda que la de la reserva bloquea: no se convierte nada que nadie pactó.
//  3. LA MONEDA ES LA DE LA COTIZACIÓN; el importe se GUARDA en soles y se expresa en dólares al
//     tipo de cambio de la cotización (`aMonedaCot`, la misma función que /cotizaciones). Sin un
//     tipo de cambio válido no se imprimen soles rotulados como dólares: bloqueo.
//  4. LO OPERATIVO SE AFIRMA SOLO SI ESTÁ ASIGNADO. Sin unidad ni conductor el papel dice que se
//     enviarán después. El teléfono del conductor solo sale si quien emite lo autoriza en ESA
//     emisión (`incluir_telefono_conductor`): el ERP no tiene otro registro de esa autorización.
//     Nunca DNI, licencia, costos, proveedor ni margen.
//  5. UNA CONFIRMACIÓN EMITIDA NO SE REESCRIBE. Lo que se imprime es una FOTO (`DatosConfirmacion`)
//     con su firma; si los datos cambian (horario, unidad, conductor, importes) se emite una
//     VERSIÓN nueva y se dice qué cambió (`cambiosEntre`). Volver a descargar no crea nada.
// Matriz: npx tsx scripts/prueba-confirmacion-reserva.mts
// ──────────────────────────────────────────────────────────────────────────────

import { aMonedaCot, normalizarMoneda, revisarTipoCambio, simboloMoneda, type Moneda } from "./cotizacion-moneda";
import { canonico } from "./json-canonico";

export type Idioma = "es" | "en";
export const normalizarIdioma = (v: unknown): Idioma => (String(v ?? "").toLowerCase().startsWith("en") ? "en" : "es");

// ── Lo que entra ─────────────────────────────────────────────────────────────

export type TramoConf = {
  id: number;
  codigo?: string | null;
  fecha_servicio: string | null;
  hora_servicio: string | null;
  estado: string | null;
  origen: string | null;
  destino: string | null;
  ruta_nombre?: string | null;
  direccion_servicio?: string | null;
  precio_cliente: number | null;
  capacidad_contratada?: number | null;
  tipo_servicio_detalle?: string | null;
  cliente_id: number | null;
  cotizacion_id?: number | null;
  reserva_vinculada_id?: number | null;
};

export type ClienteConf = {
  id: number;
  nombre: string | null;
  empresa?: string | null;
  telefono?: string | null;
  operativo_nombre?: string | null;
  operativo_celular?: string | null;
  condicion_pago?: string | null;
};

export type CotizacionConf = {
  id: number;
  numero_cotizacion?: string | null;
  atencion?: string | null;
  moneda?: string | null;
  tipo_cambio?: number | string | null;
  incluye_igv?: boolean | null;
  tipo_servicio?: string | null;
  modo_servicio?: string | null;
  idioma_pdf?: string | null;
  traslado_json?: unknown;
};

/** La unidad y el conductor de UN tramo, ya resueltos (propios o de tercero). */
export type AsignacionConf = {
  vehiculo: { placa: string | null; marca?: string | null; modelo?: string | null; categoria?: string | null } | null;
  conductor: { nombre: string | null; telefono?: string | null } | null;
};

export type PagoConf = {
  id: number;
  codigo?: string | null;
  /** «cobro» (adelanto) o «pago» (una devolución al cliente). Solo los cobros suman al adelanto. */
  sentido?: string | null;
  fecha: string | null;
  monto: number | null;
  moneda?: string | null;
  metodo?: string | null;
  anulado?: boolean | null;
};

/** Lo que escribe quien emite: no existe en otro lado del ERP. */
export type ExtrasConf = {
  vuelo?: string | null;
  punto_encuentro?: string | null;
  nota?: string | null;
  incluir_telefono_conductor?: boolean | null;
};

export type EntradaConfirmacion = {
  tramos: TramoConf[];
  /** Por id de tramo. Un tramo sin entrada = sin asignación. */
  asignaciones: Record<number, AsignacionConf>;
  cliente: ClienteConf | null;
  cotizacion: CotizacionConf | null;
  pagos: PagoConf[];
  extras?: ExtrasConf | null;
};

// ── Lo que sale ──────────────────────────────────────────────────────────────

export type CodigoBloqueo =
  | "sin_tramos" | "sin_cliente" | "cancelada" | "ya_prestado" | "sin_fecha" | "sin_hora" | "sin_origen"
  | "sin_destino" | "sin_importe" | "importe_duplicado" | "moneda_sin_tc" | "pago_otra_moneda"
  | "adelanto_excede" | "sin_adelanto";

export type CodigoAviso =
  | "sin_asignacion" | "sin_vehiculo" | "sin_conductor" | "tramo_cancelado" | "sin_contacto"
  | "credito" | "pax_sin_dato" | "igv_sin_dato";

export type Nota<C> = { codigo: C; detalle: string };

export type EstadoPago = "pagado" | "adelanto" | "credito";

export type TramoDoc = {
  sentido: "ida" | "retorno" | "unico";
  fecha: string;
  hora: string;
  origen: string;
  destino: string;
  ruta: string | null;
  /** Código de ESTE tramo; solo cuando hay dos o más (una ida sola no cambia su firma). */
  codigo?: string | null;
};

export type UnidadDoc = {
  /** Los sentidos que cubre esta unidad (si ida y retorno van en la misma, uno solo). */
  sentidos: TramoDoc["sentido"][];
  vehiculo: { descripcion: string; placa: string } | null;
  conductor: { nombre: string; telefono: string | null } | null;
};

/** LA FOTO que se imprime. Sin la fecha de emisión ni el idioma: esos no cambian el contenido. */
export type DatosConfirmacion = {
  v: 1;
  reserva_codigo: string;
  reservas_ids: number[];
  cotizacion_numero: string | null;
  cliente: { nombre: string; contacto: string | null; telefono: string | null };
  servicio: {
    tipo: string; // código, ver TIPOS_SERVICIO
    pax: number | null;
    tramos: TramoDoc[];
    vuelo: string | null;
    punto_encuentro: string | null;
    nota: string | null;
  };
  operacion: { asignado: boolean; unidades: UnidadDoc[] };
  economia: {
    moneda: Moneda;
    tipo_cambio: number | null;
    total: number;
    adelantos: { fecha: string; monto: number; codigo: string | null }[];
    adelanto: number;
    saldo: number;
    estado: EstadoPago;
    igv: "incluido" | "no_incluido" | null;
  };
};

export type JuicioConfirmacion = {
  ok: boolean;
  bloqueos: Nota<CodigoBloqueo>[];
  avisos: Nota<CodigoAviso>[];
  /** Solo con `ok`. */
  datos: DatosConfirmacion | null;
  /** El id que identifica el DÍA (el menor de sus tramos): ahí cuelgan las versiones y los cobros. */
  idDocumento: number | null;
  /** Idioma sugerido: el de la cotización, si no español. */
  idiomaSugerido: Idioma;
};

// ── Utilidades ───────────────────────────────────────────────────────────────

const r2 = (x: number) => Math.round((x + Math.sign(x) * Number.EPSILON) * 100) / 100;
const txt = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();
const nulo = (v: unknown, max = 160): string | null => { const s = txt(v); return s ? s.slice(0, max) : null; };
const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** `hh:mm` de un `hh:mm[:ss]`, o "" si no es una hora. */
export function horaCorta(h: unknown): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(txt(h));
  if (!m) return "";
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) return "";
  return `${String(hh).padStart(2, "0")}:${m[2]}`;
}
export const fechaValida = (f: unknown): string => {
  const s = txt(f).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? "" : s;
};

export const esCredito = (condicion: unknown): boolean => /cr[eé]dito/i.test(txt(condicion));

const ESTADOS_VIVOS = new Set(["pendiente", "programada", "confirmada", "por_confirmar"]);

function sentidoDe(t: TramoConf): "ida" | "retorno" {
  const d = txt(t.direccion_servicio).toLowerCase();
  if (d === "retorno") return "retorno";
  if (d === "ida") return "ida";
  return /RETORNO|SALIDA/i.test(txt(t.ruta_nombre)) ? "retorno" : "ida";
}

/** El tipo de servicio, del dato escrito (el tramo, si no la cotización). */
export const TIPOS_SERVICIO = ["traslado", "ida_retorno", "full_day", "multi_dia", "personal", "otro"] as const;
export function tipoDeServicio(tramos: TramoConf[], cot: CotizacionConf | null): (typeof TIPOS_SERVICIO)[number] {
  const t = txt(tramos.find((x) => x.tipo_servicio_detalle)?.tipo_servicio_detalle) || txt(cot?.tipo_servicio);
  if (t === "transporte_personal" || t.startsWith("fijo") || cot?.modo_servicio === "fijo") return "personal";
  if (t === "full_day") return "full_day";
  if (t === "multi_dia") return "multi_dia";
  if (t === "ida_retorno") return "ida_retorno";
  if (t === "solo_ida" || cot?.traslado_json) return "traslado";
  return tramos.length > 1 ? "ida_retorno" : "otro";
}

function paxDe(tramos: TramoConf[], cot: CotizacionConf | null): number | null {
  for (const t of tramos) { const n = num(t.capacidad_contratada); if (n > 0) return Math.round(n); }
  const tj = cot?.traslado_json as { pasajeros?: unknown; pax?: unknown } | null | undefined;
  const n = num(tj?.pasajeros ?? tj?.pax);
  return n > 0 ? Math.round(n) : null;
}

function describirVehiculo(v: NonNullable<AsignacionConf["vehiculo"]>): string {
  const partes = [txt(v.categoria), [txt(v.marca), txt(v.modelo)].filter(Boolean).join(" ")].filter(Boolean);
  return partes.join(" · ").slice(0, 80);
}

/**
 * El importe REGISTRADO del día: la suma de `precio_cliente` de sus tramos (la tarifa va en uno),
 * en soles y en la moneda de la cotización. `total` null = dólares sin tipo de cambio válido.
 * Lo usan el juicio y el registro del adelanto (que no deja adelantar más que esto).
 */
export function importeDelDia(tramos: Pick<TramoConf, "precio_cliente">[], cot: Pick<CotizacionConf, "moneda" | "tipo_cambio"> | null) {
  const con = tramos.filter((t) => num(t.precio_cliente) > 0);
  const totalPEN = r2(con.reduce((s, t) => s + num(t.precio_cliente), 0));
  const moneda = normalizarMoneda(cot?.moneda);
  const tc = moneda === "USD" ? revisarTipoCambio(cot?.tipo_cambio).tc : null;
  return { conImporte: con.length, totalPEN, moneda, tc, total: aMonedaCot(totalPEN, moneda, cot?.tipo_cambio) };
}

/**
 * Lo ya cobrado en la moneda de la reserva (sin anulados). Una DEVOLUCIÓN (`sentido = 'pago'`, la
 * de una reserva de traslado cancelada) nunca suma: sumarla le pediría al cliente el mismo dinero dos
 * veces. Quien lee ya filtra los cobros (`leerEntrada`); esto es la segunda defensa.
 */
export function cobradoEn(pagos: PagoConf[], moneda: Moneda): number {
  return r2(pagos.filter((p) => !p.anulado && p.sentido !== "pago" && num(p.monto) > 0 && normalizarMoneda(p.moneda) === moneda).reduce((s, p) => s + num(p.monto), 0));
}

// ── El juicio ────────────────────────────────────────────────────────────────

/**
 * ¿Se puede emitir la confirmación, y con qué datos? Los tramos son los del DÍA (la reserva y,
 * si tiene, su hermano ida↔retorno). Gana el primer bloqueo de cada tipo; los avisos no impiden.
 */
export function juzgarConfirmacion(e: EntradaConfirmacion): JuicioConfirmacion {
  const bloqueos: Nota<CodigoBloqueo>[] = [];
  const avisos: Nota<CodigoAviso>[] = [];
  const b = (codigo: CodigoBloqueo, detalle: string) => bloqueos.push({ codigo, detalle });
  const a = (codigo: CodigoAviso, detalle: string) => avisos.push({ codigo, detalle });
  const cot = e.cotizacion;
  const idiomaSugerido = normalizarIdioma(cot?.idioma_pdf);

  const todos = [...e.tramos].sort((x, y) => (sentidoDe(x) === sentidoDe(y) ? x.id - y.id : sentidoDe(x) === "ida" ? -1 : 1));
  if (!todos.length) {
    b("sin_tramos", "No se encontró la reserva.");
    return { ok: false, bloqueos, avisos, datos: null, idDocumento: null, idiomaSugerido };
  }
  const idDocumento = Math.min(...todos.map((t) => t.id));

  const vivos = todos.filter((t) => t.estado !== "cancelada");
  if (!vivos.length) b("cancelada", "La reserva está cancelada: no se confirma un servicio cancelado.");
  else if (vivos.length < todos.length) a("tramo_cancelado", "Un tramo del día está cancelado: la confirmación solo incluye el que sigue en pie.");
  if (vivos.length && vivos.every((t) => !ESTADOS_VIVOS.has(txt(t.estado)))) {
    b("ya_prestado", "El servicio ya está en curso o terminado: la confirmación se emite antes del servicio.");
  }

  if (!e.cliente) b("sin_cliente", "La reserva no tiene cliente: asígnalo en Programación.");

  for (const t of vivos) {
    const lado = vivos.length > 1 ? ` (${sentidoDe(t) === "ida" ? "ida" : "retorno"})` : "";
    if (!fechaValida(t.fecha_servicio)) b("sin_fecha", `Falta la fecha del servicio${lado}.`);
    if (!horaCorta(t.hora_servicio)) b("sin_hora", `Falta la hora de recojo${lado}.`);
    if (!txt(t.origen)) b("sin_origen", `Falta el punto de recojo${lado}.`);
    if (!txt(t.destino)) b("sin_destino", `Falta el destino${lado}.`);
  }

  // Dinero: el precio registrado del DÍA (todos los tramos, también uno cancelado que lleve la tarifa).
  const { conImporte, totalPEN, moneda, tc, total } = importeDelDia(todos, cot);
  if (conImporte > 1) {
    b("importe_duplicado", "La ida y el retorno tienen importe los dos: sería cobrar el día dos veces. Deja la tarifa en un solo tramo en Programación.");
  } else if (!(totalPEN > 0)) {
    b("sin_importe", "La reserva no tiene precio de venta registrado: no se imprime un importe que nadie registró.");
  }

  if (moneda === "USD" && (tc == null || total == null)) {
    b("moneda_sin_tc", "La cotización está en dólares y no tiene un tipo de cambio válido: corrígelo en Cotizaciones.");
  }

  // Solo los COBROS: una devolución (`sentido = 'pago'`) no es un adelanto (ver `cobradoEn`).
  const pagos = e.pagos.filter((p) => !p.anulado && p.sentido !== "pago" && num(p.monto) > 0);
  const otra = pagos.filter((p) => normalizarMoneda(p.moneda) !== moneda);
  if (otra.length) {
    b("pago_otra_moneda", `Hay ${otra.length} cobro(s) registrados en otra moneda que la de la reserva (${moneda}). No se convierten: Tesorería tiene que registrarlos en ${moneda}.`);
  }
  const deMoneda = pagos.filter((p) => normalizarMoneda(p.moneda) === moneda)
    .sort((x, y) => txt(x.fecha).localeCompare(txt(y.fecha)) || x.id - y.id);
  const adelanto = r2(deMoneda.reduce((s, p) => s + num(p.monto), 0));
  const credito = esCredito(e.cliente?.condicion_pago);
  if (total != null && total > 0 && adelanto > total + 0.005) {
    b("adelanto_excede", `Los cobros registrados (${dinero(adelanto, moneda)}) superan el precio del servicio (${dinero(total, moneda)}). Revisa el precio o los cobros.`);
  }
  if (!deMoneda.length && !otra.length) {
    if (credito) a("credito", `Sin adelanto: el cliente tiene condición de pago «${txt(e.cliente?.condicion_pago)}».`);
    else b("sin_adelanto", "No hay ningún adelanto registrado. Tesorería o Finanzas lo registra al validar el pago (una captura del cliente no es un pago registrado).");
  }

  // Lo operativo.
  const unidades: UnidadDoc[] = [];
  for (const t of vivos) {
    const as = e.asignaciones[t.id];
    const sentido: TramoDoc["sentido"] = vivos.length > 1 ? sentidoDe(t) : "unico";
    const vehiculo = as?.vehiculo && txt(as.vehiculo.placa)
      ? { descripcion: describirVehiculo(as.vehiculo), placa: txt(as.vehiculo.placa).toUpperCase() } : null;
    const conductor = as?.conductor && txt(as.conductor.nombre)
      ? { nombre: txt(as.conductor.nombre).slice(0, 80), telefono: e.extras?.incluir_telefono_conductor ? nulo(as.conductor.telefono, 30) : null } : null;
    const igual = unidades.find((u) => JSON.stringify(u.vehiculo) === JSON.stringify(vehiculo) && JSON.stringify(u.conductor) === JSON.stringify(conductor));
    if (igual) igual.sentidos.push(sentido);
    else unidades.push({ sentidos: [sentido], vehiculo, conductor });
  }
  const asignado = unidades.length > 0 && unidades.every((u) => u.vehiculo && u.conductor);
  if (unidades.every((u) => !u.vehiculo && !u.conductor)) a("sin_asignacion", "Sin unidad ni conductor: el documento dirá que se enviarán posteriormente.");
  else {
    if (unidades.some((u) => !u.vehiculo)) a("sin_vehiculo", "Falta la unidad en algún tramo: el documento dirá que se enviará posteriormente.");
    if (unidades.some((u) => !u.conductor)) a("sin_conductor", "Falta el conductor en algún tramo: el documento dirá que se enviará posteriormente.");
  }

  const contacto = nulo(cot?.atencion, 80) || nulo(e.cliente?.operativo_nombre, 80);
  const telefono = nulo(e.cliente?.operativo_celular, 30) || nulo(e.cliente?.telefono, 30);
  if (!telefono) a("sin_contacto", "El cliente no tiene teléfono registrado: el documento sale sin él.");
  const pax = paxDe(todos, cot);
  if (pax == null) a("pax_sin_dato", "No hay pasajeros contratados registrados: el documento sale sin la cantidad.");
  const igv = cot ? (cot.incluye_igv === false ? "no_incluido" : "incluido") : null;
  if (!igv) a("igv_sin_dato", "La reserva no viene de una cotización: el documento no dice si el importe incluye IGV.");

  const ok = bloqueos.length === 0;
  if (!ok || total == null || !e.cliente) return { ok: false, bloqueos, avisos, datos: null, idDocumento, idiomaSugerido };

  const saldo = r2(Math.max(0, total - adelanto));
  const estado: EstadoPago = saldo <= 0.005 ? "pagado" : adelanto > 0 ? "adelanto" : "credito";
  const codigoReserva = txt(todos[0].codigo) || `R-${idDocumento}`;
  const datos: DatosConfirmacion = {
    v: 1,
    reserva_codigo: codigoReserva,
    reservas_ids: todos.map((t) => t.id).sort((x, y) => x - y),
    cotizacion_numero: nulo(cot?.numero_cotizacion, 40),
    cliente: { nombre: (txt(e.cliente.empresa) || txt(e.cliente.nombre) || "—").slice(0, 120), contacto, telefono },
    servicio: {
      tipo: tipoDeServicio(todos, cot),
      pax,
      tramos: vivos.map((t) => ({
        sentido: vivos.length > 1 ? sentidoDe(t) : "unico",
        fecha: fechaValida(t.fecha_servicio),
        hora: horaCorta(t.hora_servicio),
        origen: txt(t.origen).slice(0, 160),
        destino: txt(t.destino).slice(0, 160),
        ruta: nulo(t.ruta_nombre, 80),
        ...(vivos.length > 1 ? { codigo: nulo(t.codigo, 40) } : {}),
      })),
      vuelo: nulo(e.extras?.vuelo, 40),
      punto_encuentro: nulo(e.extras?.punto_encuentro, 120),
      nota: nulo(e.extras?.nota, 300),
    },
    operacion: { asignado, unidades },
    economia: {
      moneda, tipo_cambio: tc, total, adelanto, saldo, estado, igv,
      adelantos: deMoneda.map((p) => ({ fecha: fechaValida(p.fecha), monto: r2(num(p.monto)), codigo: nulo(p.codigo, 30) })),
    },
  };
  return { ok: true, bloqueos, avisos, datos, idDocumento, idiomaSugerido };
}

// ── Versiones ────────────────────────────────────────────────────────────────

/** JSON con las claves ordenadas: la misma foto da siempre la misma cadena. Vive en lib/json-canonico.ts
 *  (lo comparte la emisión de licitaciones); se re-exporta para no mover a ningún llamador. */
export { canonico };

export type CodigoCambio = "cliente" | "horario" | "ruta" | "servicio" | "vehiculo" | "conductor" | "importe" | "pago" | "indicaciones";
export const ETIQUETA_CAMBIO: Record<CodigoCambio, string> = {
  cliente: "Datos del cliente", horario: "Fecha u hora", ruta: "Recojo o destino", servicio: "Tipo o pasajeros",
  vehiculo: "Unidad", conductor: "Conductor", importe: "Precio", pago: "Adelanto / saldo", indicaciones: "Vuelo, encuentro o nota",
};

/** Qué cambió entre dos fotos (vacío = el mismo documento). */
export function cambiosEntre(a: DatosConfirmacion, b: DatosConfirmacion): CodigoCambio[] {
  const c: CodigoCambio[] = [];
  const dif = (x: unknown, y: unknown) => canonico(x) !== canonico(y);
  if (dif(a.cliente, b.cliente)) c.push("cliente");
  if (dif(a.servicio.tramos.map((t) => [t.sentido, t.fecha, t.hora]), b.servicio.tramos.map((t) => [t.sentido, t.fecha, t.hora]))) c.push("horario");
  if (dif(a.servicio.tramos.map((t) => [t.origen, t.destino, t.ruta]), b.servicio.tramos.map((t) => [t.origen, t.destino, t.ruta]))) c.push("ruta");
  if (dif([a.servicio.tipo, a.servicio.pax], [b.servicio.tipo, b.servicio.pax])) c.push("servicio");
  if (dif(a.operacion.unidades.map((u) => [u.sentidos, u.vehiculo]), b.operacion.unidades.map((u) => [u.sentidos, u.vehiculo]))) c.push("vehiculo");
  if (dif(a.operacion.unidades.map((u) => [u.sentidos, u.conductor]), b.operacion.unidades.map((u) => [u.sentidos, u.conductor]))) c.push("conductor");
  if (dif([a.economia.moneda, a.economia.total, a.economia.igv, a.economia.tipo_cambio], [b.economia.moneda, b.economia.total, b.economia.igv, b.economia.tipo_cambio])) c.push("importe");
  if (dif([a.economia.adelantos, a.economia.saldo, a.economia.estado], [b.economia.adelantos, b.economia.saldo, b.economia.estado])) c.push("pago");
  if (dif([a.servicio.vuelo, a.servicio.punto_encuentro, a.servicio.nota], [b.servicio.vuelo, b.servicio.punto_encuentro, b.servicio.nota])) c.push("indicaciones");
  if (!c.length && dif(a, b)) c.push("servicio"); // nunca «sin cambios» con fotos distintas
  return c;
}

export type VersionGuardada = { id: number; version: number; firma: string; datos: DatosConfirmacion };

/**
 * ¿Se reusa la última versión o se emite otra? Misma firma → la MISMA (un reintento o una
 * descarga repetida no crean nada). Distinta → la siguiente, con lo que cambió.
 */
export function planVersion(ultima: VersionGuardada | null, datos: DatosConfirmacion, firma: string):
  { accion: "reusar"; version: number; id: number } | { accion: "nueva"; version: number; cambios: CodigoCambio[] } {
  if (ultima && ultima.firma === firma) return { accion: "reusar", version: ultima.version, id: ultima.id };
  return { accion: "nueva", version: (ultima?.version ?? 0) + 1, cambios: ultima ? cambiosEntre(ultima.datos, datos) : [] };
}

export const codigoDocumento = (datos: Pick<DatosConfirmacion, "reserva_codigo">, version: number) => `${datos.reserva_codigo}-V${version}`;

// ── Textos del documento ─────────────────────────────────────────────────────

const MESES = {
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};
const DIAS = {
  es: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
  en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
};

export function fechaLarga(f: string, idioma: Idioma): string {
  const s = fechaValida(f);
  if (!s) return "—";
  const d = new Date(`${s}T12:00:00Z`);
  const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
  return idioma === "en"
    ? `${DIAS.en[d.getUTCDay()]}, ${MESES.en[m]} ${dd}, ${y}`
    : `${DIAS.es[d.getUTCDay()]} ${dd} de ${MESES.es[m]} de ${y}`;
}
export function fechaCorta(f: string): string {
  const s = fechaValida(f);
  return s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : "—";
}
export function horaTexto(h: string, idioma: Idioma): string {
  const c = horaCorta(h);
  if (!c) return "—";
  if (idioma === "es") return `${c} h`;
  const [hh, mm] = c.split(":").map(Number);
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
}
export function dinero(monto: number, moneda: Moneda): string {
  const [ent, dec] = r2(monto).toFixed(2).split(".");
  return `${simboloMoneda(moneda)} ${ent.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${dec}`;
}

type Diccionario = Record<string, string>;
export const TEXTOS: Record<Idioma, Diccionario> = {
  es: {
    titulo: "CONFIRMACIÓN DE RESERVA", codigo: "Código de reserva", version: "Versión", emitido: "Emitido",
    cotizacion: "Cotización", cliente: "DATOS DEL CLIENTE", cli_nombre: "Cliente", cli_contacto: "Contacto",
    cli_telefono: "Teléfono", servicio: "DATOS DEL SERVICIO", tipo: "Tipo de servicio", pax: "Pasajeros",
    ida: "IDA", retorno: "RETORNO", unico: "SERVICIO", fecha: "Fecha", hora: "Hora de recojo", fecha_hora: "Fecha y hora de recojo", origen: "Recojo",
    destino: "Destino", ruta: "Ruta", vuelo: "Vuelo", encuentro: "Punto de encuentro", nota: "Indicaciones",
    operacion: "UNIDAD Y CONDUCTOR", unidad: "Unidad", placa: "Placa", conductor: "Conductor", tel_conductor: "Teléfono",
    pendiente_operacion: "Los datos del vehículo y del conductor le serán enviados posteriormente.",
    pendiente_unidad: "Se enviará posteriormente.",
    economia: "INFORMACIÓN ECONÓMICA", total: "Precio total contratado", total_tramos: "Precio total (ida y retorno)", adelanto: "Adelanto recibido",
    saldo: "Saldo pendiente", moneda: "Moneda", estado_pago: "Estado del pago",
    pago_pagado: "Pagado", pago_adelanto: "Adelanto recibido · saldo pendiente", pago_credito: "Según condición de crédito",
    igv_incluido: "Importes con IGV incluido.", igv_no_incluido: "Importes sin IGV.",
    tc: "Tipo de cambio de la cotización", moneda_PEN: "Soles (PEN)", moneda_USD: "Dólares (USD)",
    legal: "Este documento confirma la reserva del servicio. No reemplaza al comprobante de pago.",
    actualiza: "Esta versión reemplaza a la anterior.", contacto: "Coordinación",
    t_traslado: "Traslado", t_ida_retorno: "Traslado de ida y retorno", t_full_day: "Full day · vehículo a disposición",
    t_multi_dia: "Servicio de varios días", t_personal: "Transporte de personal", t_otro: "Servicio de transporte",
  },
  en: {
    titulo: "BOOKING CONFIRMATION", codigo: "Booking code", version: "Version", emitido: "Issued",
    cotizacion: "Quotation", cliente: "CUSTOMER", cli_nombre: "Customer", cli_contacto: "Contact person",
    cli_telefono: "Phone", servicio: "SERVICE DETAILS", tipo: "Service type", pax: "Passengers",
    ida: "OUTBOUND", retorno: "RETURN", unico: "SERVICE", fecha: "Date", hora: "Pick-up time", fecha_hora: "Pick-up date and time", origen: "Pick-up",
    destino: "Destination", ruta: "Route", vuelo: "Flight", encuentro: "Meeting point", nota: "Instructions",
    operacion: "VEHICLE AND DRIVER", unidad: "Vehicle", placa: "Plate", conductor: "Driver", tel_conductor: "Phone",
    pendiente_operacion: "Vehicle and driver details will be sent to you later.",
    pendiente_unidad: "To be sent later.",
    economia: "PAYMENT DETAILS", total: "Total contracted price", total_tramos: "Total price (outbound and return)", adelanto: "Deposit received",
    saldo: "Balance due", moneda: "Currency", estado_pago: "Payment status",
    pago_pagado: "Paid in full", pago_adelanto: "Deposit received · balance due", pago_credito: "Per credit terms",
    igv_incluido: "Amounts include IGV (Peruvian VAT).", igv_no_incluido: "Amounts exclude IGV (Peruvian VAT).",
    tc: "Quotation exchange rate", moneda_PEN: "Peruvian soles (PEN)", moneda_USD: "US dollars (USD)",
    legal: "This document confirms your booking. It does not replace the payment receipt.",
    actualiza: "This version replaces the previous one.", contacto: "Coordination",
    t_traslado: "Transfer", t_ida_retorno: "Round-trip transfer", t_full_day: "Full day · vehicle at your disposal",
    t_multi_dia: "Multi-day service", t_personal: "Staff transportation", t_otro: "Transportation service",
  },
};

export type Fila = { label: string; valor: string };
export type SeccionDoc = { titulo: string; filas: Fila[]; nota?: string | null; subtitulo?: string | null };
export type DocConfirmacion = {
  titulo: string;
  cabecera: Fila[];
  secciones: SeccionDoc[];
  pie: string[];
};
export type EmpresaDoc = { nombre: string; telefono: string; email: string; web: string; direccion: string; ruc: string };

/** El documento, en el idioma pedido. Nombres, placas, direcciones y códigos NO se traducen. */
export function docConfirmacion(d: DatosConfirmacion, idioma: Idioma, meta: { version: number; emitidoEn: string }, empresa: EmpresaDoc): DocConfirmacion {
  const T = TEXTOS[idioma];
  const f = (label: string, valor: string | null | undefined): Fila[] => (txt(valor) ? [{ label, valor: txt(valor) }] : []);
  const ec = d.economia;
  const emitido = fechaValida(meta.emitidoEn.slice(0, 10));
  const cabecera: Fila[] = [
    { label: T.codigo, valor: d.reserva_codigo },
    { label: T.version, valor: String(meta.version) },
    { label: T.emitido, valor: emitido ? fechaCorta(emitido) : "—" },
    ...f(T.cotizacion, d.cotizacion_numero),
  ];
  const secciones: SeccionDoc[] = [
    { titulo: T.cliente, filas: [...f(T.cli_nombre, d.cliente.nombre), ...f(T.cli_contacto, d.cliente.contacto), ...f(T.cli_telefono, d.cliente.telefono)] },
    {
      titulo: T.servicio,
      filas: [
        { label: T.tipo, valor: T[`t_${d.servicio.tipo}`] ?? T.t_otro },
        ...(d.servicio.pax != null ? [{ label: T.pax, valor: String(d.servicio.pax) }] : []),
        ...f(T.vuelo, d.servicio.vuelo), ...f(T.encuentro, d.servicio.punto_encuentro),
      ],
    },
    ...d.servicio.tramos.map((t) => ({
      titulo: "", subtitulo: t.codigo ? `${T[t.sentido]} · ${t.codigo}` : T[t.sentido],
      filas: [
        { label: T.fecha_hora, valor: `${fechaLarga(t.fecha, idioma)} · ${horaTexto(t.hora, idioma)}` },
        { label: T.origen, valor: t.origen },
        { label: T.destino, valor: t.destino },
        ...f(T.ruta, t.ruta),
      ],
    })),
    ...(d.servicio.nota ? [{ titulo: T.nota, filas: [], nota: d.servicio.nota }] : []),
    {
      titulo: T.operacion,
      filas: d.operacion.unidades.every((u) => !u.vehiculo && !u.conductor) ? [] : d.operacion.unidades.flatMap((u) => {
        const pre = d.operacion.unidades.length > 1 ? `${u.sentidos.map((s) => T[s]).join(" / ")} · ` : "";
        return [
          { label: `${pre}${T.unidad}`, valor: u.vehiculo ? [u.vehiculo.descripcion, `${T.placa} ${u.vehiculo.placa}`].filter(Boolean).join(" · ") : T.pendiente_unidad },
          { label: `${pre}${T.conductor}`, valor: u.conductor ? [u.conductor.nombre, u.conductor.telefono ? `${T.tel_conductor} ${u.conductor.telefono}` : ""].filter(Boolean).join(" · ") : T.pendiente_unidad },
        ];
      }),
      nota: d.operacion.unidades.every((u) => !u.vehiculo && !u.conductor) ? T.pendiente_operacion : null,
    },
    {
      titulo: T.economia,
      filas: [
        { label: d.servicio.tramos.length > 1 ? T.total_tramos : T.total, valor: dinero(ec.total, ec.moneda) },
        ...ec.adelantos.map((p) => ({ label: `${T.adelanto}${p.fecha ? ` · ${fechaCorta(p.fecha)}` : ""}`, valor: dinero(p.monto, ec.moneda) })),
        { label: T.saldo, valor: dinero(ec.saldo, ec.moneda) },
        { label: T.moneda, valor: T[`moneda_${ec.moneda}`] },
        { label: T.estado_pago, valor: T[`pago_${ec.estado}`] },
        ...(ec.moneda === "USD" && ec.tipo_cambio ? [{ label: T.tc, valor: `S/ ${ec.tipo_cambio.toFixed(3)}` }] : []),
      ],
      nota: ec.igv ? T[`igv_${ec.igv}`] : null,
    },
  ];
  const contacto = [empresa.telefono, empresa.email, empresa.web].filter(Boolean).join(" · ");
  const pie = [
    T.legal,
    ...(meta.version > 1 ? [T.actualiza] : []),
    ...(contacto ? [`${T.contacto}: ${contacto}`] : []),
    [empresa.nombre, empresa.ruc ? `RUC ${empresa.ruc}` : "", empresa.direccion].filter(Boolean).join(" · "),
  ];
  return { titulo: T.titulo, cabecera, secciones, pie };
}

/** El mensaje que acompaña al PDF en WhatsApp. Breve y sin importes. */
export function mensajeWhatsApp(idioma: Idioma, empresa: string, codigo: string): string {
  return idioma === "en"
    ? `Dear customer, please find attached the Booking Confirmation ${codigo} for your service with ${empresa}. Thank you for your trust. If you need any further coordination, we are at your disposal.`
    : `Estimado/a cliente, le enviamos la Confirmación de Reserva ${codigo} de su servicio con ${empresa}. Agradecemos su confianza. Si necesita alguna coordinación adicional, estamos a su disposición.`;
}

/** El teléfono del cliente para wa.me: dígitos, con 51 delante si es un celular peruano de 9. */
export function telefonoWa(t: string | null | undefined): string | null {
  const d = txt(t).replace(/\D/g, "");
  if (/^9\d{8}$/.test(d)) return `51${d}`;
  if (d.length >= 10 && d.length <= 15) return d;
  return null;
}

/** El nombre del archivo: el código, sin nada que un sistema de archivos rechace. */
export const nombreArchivo = (codigo: string, idioma: Idioma) =>
  `${idioma === "en" ? "Booking-Confirmation" : "Confirmacion-Reserva"}-${codigo.replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`;
