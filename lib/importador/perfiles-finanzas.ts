// ──────────────────────────────────────────────────────────────────────────────
// lib/importador/perfiles-finanzas.ts — Perfiles de importación de los Google Sheets
// históricos de AFA (cuentas por pagar, planilla, caja chica, extracto BCP).
//
// Cada perfil declara los ALIAS con los que puede venir cada columna. Como
// `normHeader` baja a minúsculas y quita tildes, basta escribir los alias en
// minúscula: un Sheet con "N° FACTURA", "Nro. Factura" o "FACTURA" cae en el mismo
// campo. Cuando ninguna columna calza, `detectarPerfil` puntúa y la UI ofrece el
// mapeo manual — nunca se aborta el archivo sin decir qué se vio.
//
// El destino de cada perfil respeta la regla de oro del ERP (finanzas-00): la CxP NO
// crea una tabla paralela, escribe en `documentos_compra` (el comprobante es la
// fuente única del monto) con el eje operativo añadido en finanzas-06.
// ──────────────────────────────────────────────────────────────────────────────

import {
  type Perfil,
  type ValoresFila,
  parsearComprobante,
  parsearCci,
  parsearCuenta,
  parsearPlaca,
  parsearRuc,
  normaliza,
} from "@/lib/importador/tabular";

// ── Filas de destino ──────────────────────────────────────────────────────────

/** Fila lista para insertarse en `documentos_compra` (+ datos del proveedor). */
export type FilaCxP = {
  // Identificación del proveedor (el importador resuelve/crea el proveedor por RUC).
  proveedor_ruc: string | null;
  proveedor_razon_social: string | null;
  titular_cuenta: string | null;
  banco_destino: string | null;
  cuenta_destino: string | null;
  cci_destino: string | null;
  // Comprobante.
  tipo_comprobante: string;
  serie: string | null;
  numero: string | null;
  fecha_emision: string;
  fecha_vencimiento: string | null;
  moneda: string;
  subtotal: number;
  igv: number;
  total: number;
  detraccion_pct: number | null;
  detraccion_monto: number;
  estado_detraccion: "no_aplica" | "pendiente" | "pagada";
  adelanto_1: number;
  adelanto_2: number;
  // Eje operativo (formato OSLO).
  vehiculo_placa: string | null;
  codigo_servicio: string | null;
  detalle_servicio: string | null;
  turno: string | null;
  fecha_servicio: string | null;
  // Estado y pago.
  estado_aprobacion: "pendiente" | "aprobado_gerencia" | "incluido_lote" | "rechazado";
  estado_pago: "impaga" | "parcial" | "pagada";
  nro_operacion_bancaria: string | null;
  fecha_pago: string | null;
  voucher_url: string | null;
  categoria: string | null;
  observaciones: string | null;
};

/** Fila lista para insertarse en `gastos_generales`. */
export type FilaGastoGeneral = {
  categoria: string;
  beneficiario_nombre: string;
  documento_identidad: string | null;
  concepto: string;
  descripcion: string | null;
  periodo: string | null;
  fecha: string;
  fecha_vencimiento: string | null;
  monto: number;
  moneda: string;
  banco_destino: string | null;
  cuenta_destino: string | null;
  cci_destino: string | null;
  estado_aprobacion: "pendiente" | "aprobado" | "rechazado";
  estado_pago: "impaga" | "parcial" | "pagada";
  nro_operacion_bancaria: string | null;
  fecha_pago: string | null;
  comprobante_ref: string | null;
  observaciones: string | null;
};

/** Fila lista para insertarse en `caja_chica_gastos` (dentro de una rendición). */
export type FilaCajaChica = {
  responsable_nombre: string;
  fecha: string;
  categoria: string;
  descripcion: string | null;
  monto: number;
  moneda: string;
  vehiculo_placa: string | null;
  ruc_proveedor: string | null;
  comprobante_serie: string | null;
  comprobante_numero: string | null;
  tipo_comprobante: string | null;
  observaciones: string | null;
};

/** Fila lista para insertarse en `extractos_bancarios_movimientos`. */
export type FilaExtracto = {
  fecha_movimiento: string;
  fecha_valuta: string | null;
  nro_operacion: string | null;
  descripcion_banco: string | null;
  monto_cargo: number;
  monto_abono: number;
  saldo: number | null;
  moneda: string;
};

// ── Vocabulario compartido ────────────────────────────────────────────────────

const A_RUC = ["ruc", "r u c", "ruc proveedor", "nro ruc", "n ruc", "ruc emisor"];
const A_RAZON = [
  "razon social", "proveedor", "razon social proveedor", "nombre proveedor",
  "empresa", "beneficiario", "nombre o razon social", "acreedor",
];
const A_TITULAR = ["titular de la cuenta", "titular cuenta", "titular", "nombre del titular"];
const A_BANCO = ["banco", "entidad bancaria", "banco destino", "entidad financiera"];
const A_CUENTA = ["numero de cuenta", "nro de cuenta", "n de cuenta", "cuenta", "cuenta bancaria", "nro cuenta", "cuenta destino"];
const A_CCI = ["cci", "codigo interbancario", "cuenta interbancaria", "codigo de cuenta interbancario"];
const A_FACTURA = ["n factura", "nro factura", "numero factura", "factura", "comprobante", "n comprobante", "documento", "nro documento"];
const A_FEMISION = ["fecha de emision", "fecha emision", "f emision", "emision", "fecha factura", "fecha"];
const A_FVENC = ["fecha de vencimiento", "fecha vencimiento", "vencimiento", "f vencimiento", "vence"];
const A_PLACA = ["placa de vehiculo", "placa del vehiculo", "placa", "unidad", "nro placa", "vehiculo"];
const A_MONTO = ["monto neto", "monto", "importe", "total", "monto total", "valor", "importe total", "monto facturado"];
const A_DETRACCION = ["detraccion", "monto detraccion", "importe detraccion", "det", "monto de detraccion"];
const A_ESTADO_DET = ["estado detraccion", "estado de detraccion", "detraccion estado", "situacion detraccion"];
const A_NRO_OP = ["nro operacion", "n operacion", "numero de operacion", "nro de operacion", "operacion", "n op", "cod operacion"];
const A_ESTADO = ["estado", "estado pago", "situacion", "status", "estado de pago"];
const A_OBS = ["observaciones", "observacion", "obs", "comentarios", "nota", "notas", "detalle adicional"];

// ── Helpers de normalización de valores ───────────────────────────────────────

/** Mapea el "ESTADO" libre de un Google Sheet al eje de PAGO del ERP. */
function estadoPagoDe(txt: string): "impaga" | "parcial" | "pagada" {
  const s = normaliza(txt);
  if (!s) return "impaga";
  if (/pagad|cancelad|abonad|depositad|liquidad/.test(s)) return "pagada";
  if (/parcial|adelant|a cuenta/.test(s)) return "parcial";
  return "impaga";
}

/** Mapea el mismo "ESTADO" al eje de APROBACIÓN (ortogonal al de pago). */
function estadoAprobacionDe(txt: string): FilaCxP["estado_aprobacion"] {
  const s = normaliza(txt);
  if (/rechaz|anulad|observad/.test(s)) return "rechazado";
  if (/telecredito|lote|programad|en banco/.test(s)) return "incluido_lote";
  if (/aprobad|autorizad|visad|conform|pagad|cancelad/.test(s)) return "aprobado_gerencia";
  return "pendiente";
}

function estadoDetraccionDe(txt: string, monto: number): FilaCxP["estado_detraccion"] {
  const s = normaliza(txt);
  if (/no aplica|n a|sin detrac|no corresponde/.test(s)) return "no_aplica";
  if (/pagad|deposit|cancelad|si/.test(s)) return "pagada";
  if (/pendiente|por pagar|falta|no/.test(s)) return "pendiente";
  return monto > 0 ? "pendiente" : "no_aplica";
}

/** Extrae el turno del texto libre de "FECHA Y TURNO" / "DETALLE DEL SERVICIO". */
function turnoDe(txt: string): string | null {
  const s = normaliza(txt);
  if (/\bnoche\b|nocturn/.test(s) && /\bdia\b|diurn/.test(s)) return "mixto";
  if (/\bnoche\b|nocturn/.test(s)) return "noche";
  if (/\bdia\b|diurn|\bmanana\b|\btarde\b/.test(s)) return "dia";
  return null;
}

function monedaDe(txt: string): string {
  const s = normaliza(txt);
  if (/usd|dolar|\$/.test(s)) return "USD";
  return "PEN";
}

/** Lee un importe obligatorio y devuelve el motivo de error si no se pudo. */
function montoObligatorio(v: ValoresFila, campo: string, etiqueta: string): number | string {
  const n = v.monto(campo);
  if (n == null) return `${etiqueta} vacío o ilegible ("${v.texto(campo)}")`;
  if (n < 0) return `${etiqueta} negativo (${n})`;
  return n;
}

// ── Perfil 1 · Cuentas por pagar, formato OSLO ────────────────────────────────
// El del Plan Maestro: rutas por turno con código de servicio y placa.

export const PERFIL_CXP_OSLO: Perfil<FilaCxP> = {
  clave: "cxp_oslo",
  nombre: "Cuentas por pagar · formato OSLO",
  descripcion:
    "Servicios tercerizados por turno con código de servicio (COD-OSLO-01), placa y adelantos.",
  campos: [
    { campo: "proveedor_razon_social", alias: A_RAZON, requerido: true },
    { campo: "proveedor_ruc", alias: A_RUC },
    { campo: "titular_cuenta", alias: A_TITULAR },
    { campo: "banco", alias: A_BANCO },
    { campo: "numero_cuenta", alias: A_CUENTA },
    { campo: "cci", alias: A_CCI },
    { campo: "codigo_servicio", alias: ["codigo de servicio", "cod servicio", "codigo servicio", "cod", "codigo", "servicio cod", "cod oslo"] },
    { campo: "detalle_servicio", alias: ["detalle del servicio", "detalle servicio", "fecha y turno", "servicio realizado", "ruta", "detalle", "descripcion del servicio", "turno"], requerido: true },
    { campo: "vehiculo_placa", alias: A_PLACA },
    { campo: "fecha_servicio", alias: ["fecha de servicio", "fecha servicio", "fecha del servicio", "f servicio"] },
    { campo: "numero_factura", alias: A_FACTURA },
    { campo: "fecha_emision", alias: A_FEMISION },
    { campo: "fecha_vencimiento", alias: A_FVENC },
    { campo: "monto_neto", alias: A_MONTO, requerido: true },
    { campo: "igv", alias: ["igv", "impuesto", "i g v"] },
    { campo: "adelanto_1", alias: ["adelanto 1", "adelanto1", "primer adelanto", "adelanto", "a cuenta 1"] },
    { campo: "adelanto_2", alias: ["adelanto 2", "adelanto2", "segundo adelanto", "a cuenta 2"] },
    { campo: "monto_detraccion", alias: A_DETRACCION },
    { campo: "estado_detraccion", alias: A_ESTADO_DET },
    { campo: "estado_pago", alias: A_ESTADO },
    { campo: "nro_operacion_bancaria", alias: A_NRO_OP },
    { campo: "fecha_pago", alias: ["fecha de pago", "fecha pago", "f pago", "fecha abono"] },
    { campo: "moneda", alias: ["moneda", "mon", "divisa"] },
    { campo: "observaciones", alias: A_OBS },
  ],
  construir(v) {
    const razon = v.texto("proveedor_razon_social");
    if (!razon) return "Falta el proveedor / razón social";

    const total = montoObligatorio(v, "monto_neto", "Monto neto");
    if (typeof total === "string") return total;
    if (total === 0) return "El monto neto es 0";

    const detalle = v.texto("detalle_servicio");
    const comprobante = parsearComprobante(v.texto("numero_factura"));
    const detraccion = v.monto("monto_detraccion") ?? 0;
    const estadoTxt = v.texto("estado_pago");
    const igv = v.monto("igv") ?? 0;

    // fecha_emision: si el Sheet no la trae, se cae a la fecha de servicio. Si no hay
    // ninguna, se rechaza la fila: una CxP sin fecha no se puede vencer ni conciliar.
    const fEmision = v.fecha("fecha_emision") ?? v.fecha("fecha_servicio");
    if (!fEmision) return "Falta la fecha de emisión (y tampoco hay fecha de servicio)";

    return {
      proveedor_ruc: parsearRuc(v.texto("proveedor_ruc")),
      proveedor_razon_social: razon,
      titular_cuenta: v.texto("titular_cuenta") || razon,
      banco_destino: v.texto("banco") || null,
      cuenta_destino: parsearCuenta(v.texto("numero_cuenta")) ?? (v.texto("numero_cuenta") || null),
      cci_destino: parsearCci(v.texto("cci")),
      tipo_comprobante: "factura",
      serie: comprobante.serie,
      numero: comprobante.numero,
      fecha_emision: fEmision,
      fecha_vencimiento: v.fecha("fecha_vencimiento"),
      moneda: monedaDe(v.texto("moneda")),
      subtotal: Math.max(0, total - igv),
      igv,
      total,
      detraccion_pct: total > 0 && detraccion > 0 ? Number(((detraccion / total) * 100).toFixed(4)) : null,
      detraccion_monto: detraccion,
      estado_detraccion: estadoDetraccionDe(v.texto("estado_detraccion"), detraccion),
      adelanto_1: v.monto("adelanto_1") ?? 0,
      adelanto_2: v.monto("adelanto_2") ?? 0,
      vehiculo_placa: parsearPlaca(v.texto("vehiculo_placa")),
      codigo_servicio: v.texto("codigo_servicio") || null,
      detalle_servicio: detalle || null,
      turno: turnoDe(detalle),
      fecha_servicio: v.fecha("fecha_servicio"),
      estado_aprobacion: estadoAprobacionDe(estadoTxt),
      estado_pago: estadoPagoDe(estadoTxt),
      nro_operacion_bancaria: v.texto("nro_operacion_bancaria") || null,
      fecha_pago: v.fecha("fecha_pago"),
      voucher_url: null,
      categoria: "tercero",
      observaciones: v.texto("observaciones") || null,
    };
  },
};

// ── Perfil 2 · Cuentas por pagar, formato tradicional ─────────────────────────
// Facturas de proveedor sin el eje de servicio (talleres, grifos, repuestos).

export const PERFIL_CXP_TRADICIONAL: Perfil<FilaCxP> = {
  clave: "cxp_tradicional",
  nombre: "Cuentas por pagar · formato tradicional",
  descripcion: "Facturas de proveedores (talleres, grifos, repuestos) sin turno ni código de servicio.",
  campos: [
    { campo: "proveedor_razon_social", alias: A_RAZON, requerido: true },
    { campo: "proveedor_ruc", alias: A_RUC },
    { campo: "titular_cuenta", alias: A_TITULAR },
    { campo: "banco", alias: A_BANCO },
    { campo: "numero_cuenta", alias: A_CUENTA },
    { campo: "cci", alias: A_CCI },
    { campo: "numero_factura", alias: A_FACTURA, requerido: true },
    { campo: "fecha_emision", alias: A_FEMISION, requerido: true },
    { campo: "fecha_vencimiento", alias: A_FVENC },
    { campo: "concepto", alias: ["concepto", "descripcion", "detalle", "glosa", "servicio", "producto"] },
    { campo: "subtotal", alias: ["subtotal", "base imponible", "valor venta", "neto", "sub total"] },
    { campo: "igv", alias: ["igv", "impuesto", "i g v"] },
    { campo: "monto_neto", alias: A_MONTO, requerido: true },
    { campo: "monto_detraccion", alias: A_DETRACCION },
    { campo: "estado_detraccion", alias: A_ESTADO_DET },
    { campo: "vehiculo_placa", alias: A_PLACA },
    { campo: "categoria", alias: ["categoria", "tipo de gasto", "tipo gasto", "rubro", "clasificacion"] },
    { campo: "estado_pago", alias: A_ESTADO },
    { campo: "nro_operacion_bancaria", alias: A_NRO_OP },
    { campo: "fecha_pago", alias: ["fecha de pago", "fecha pago", "f pago"] },
    { campo: "moneda", alias: ["moneda", "mon", "divisa"] },
    { campo: "observaciones", alias: A_OBS },
  ],
  construir(v) {
    const razon = v.texto("proveedor_razon_social");
    if (!razon) return "Falta el proveedor / razón social";

    const total = montoObligatorio(v, "monto_neto", "Monto");
    if (typeof total === "string") return total;
    if (total === 0) return "El monto es 0";

    const fEmision = v.fecha("fecha_emision");
    if (!fEmision) return `Fecha de emisión ilegible ("${v.texto("fecha_emision")}")`;

    const comprobante = parsearComprobante(v.texto("numero_factura"));
    const detraccion = v.monto("monto_detraccion") ?? 0;
    const estadoTxt = v.texto("estado_pago");
    const subtotal = v.monto("subtotal");
    const igv = v.monto("igv") ?? (subtotal != null ? Math.max(0, total - subtotal) : 0);

    return {
      proveedor_ruc: parsearRuc(v.texto("proveedor_ruc")),
      proveedor_razon_social: razon,
      titular_cuenta: v.texto("titular_cuenta") || razon,
      banco_destino: v.texto("banco") || null,
      cuenta_destino: parsearCuenta(v.texto("numero_cuenta")) ?? (v.texto("numero_cuenta") || null),
      cci_destino: parsearCci(v.texto("cci")),
      tipo_comprobante: "factura",
      serie: comprobante.serie,
      numero: comprobante.numero,
      fecha_emision: fEmision,
      fecha_vencimiento: v.fecha("fecha_vencimiento"),
      moneda: monedaDe(v.texto("moneda")),
      subtotal: subtotal ?? Math.max(0, total - igv),
      igv,
      total,
      detraccion_pct: total > 0 && detraccion > 0 ? Number(((detraccion / total) * 100).toFixed(4)) : null,
      detraccion_monto: detraccion,
      estado_detraccion: estadoDetraccionDe(v.texto("estado_detraccion"), detraccion),
      adelanto_1: 0,
      adelanto_2: 0,
      vehiculo_placa: parsearPlaca(v.texto("vehiculo_placa")),
      codigo_servicio: null,
      detalle_servicio: v.texto("concepto") || null,
      turno: null,
      fecha_servicio: null,
      estado_aprobacion: estadoAprobacionDe(estadoTxt),
      estado_pago: estadoPagoDe(estadoTxt),
      nro_operacion_bancaria: v.texto("nro_operacion_bancaria") || null,
      fecha_pago: v.fecha("fecha_pago"),
      voucher_url: null,
      categoria: normaliza(v.texto("categoria")) || null,
      observaciones: v.texto("observaciones") || null,
    };
  },
};

// ── Perfil 3 · Planilla y gastos administrativos ──────────────────────────────

const CATEGORIAS_GG: Record<string, string> = {
  planilla: "planilla",
  sueldo: "planilla",
  sueldos: "planilla",
  remuneracion: "planilla",
  gratificacion: "planilla",
  cts: "planilla",
  gerencia: "gasto_gerencia",
  honorarios: "gasto_gerencia",
  tercerizado: "tercerizado",
  tercero: "tercerizado",
  servicios: "servicios_fijos",
  alquiler: "servicios_fijos",
  luz: "servicios_fijos",
  agua: "servicios_fijos",
  internet: "servicios_fijos",
  telefono: "servicios_fijos",
  tributos: "tributos",
  sunat: "tributos",
  impuesto: "tributos",
  igv: "tributos",
  essalud: "tributos",
  afp: "tributos",
  mantenimiento: "mantenimiento",
  taller: "mantenimiento",
  prestamo: "financiero",
  leasing: "financiero",
  interes: "financiero",
};

function categoriaGGDe(txt: string, concepto: string): string {
  const buscar = `${normaliza(txt)} ${normaliza(concepto)}`;
  for (const [clave, valor] of Object.entries(CATEGORIAS_GG)) {
    if (buscar.includes(clave)) return valor;
  }
  return "otro";
}

export const PERFIL_GASTOS_GENERALES: Perfil<FilaGastoGeneral> = {
  clave: "gastos_generales",
  nombre: "Planilla y gastos administrativos",
  descripcion: "Sueldos, honorarios de gerencia, servicios fijos, tributos y alquileres.",
  campos: [
    { campo: "beneficiario_nombre", alias: ["beneficiario", "nombre", "trabajador", "empleado", "apellidos y nombres", "razon social", "proveedor", "nombre completo"], requerido: true },
    { campo: "documento_identidad", alias: ["dni", "documento", "documento de identidad", "dni ruc", "nro documento", "ruc"] },
    { campo: "categoria", alias: ["categoria", "tipo", "tipo de gasto", "rubro", "clasificacion", "concepto general"] },
    { campo: "concepto", alias: ["concepto", "descripcion", "detalle", "glosa", "motivo"], requerido: true },
    { campo: "periodo", alias: ["periodo", "mes", "mes correspondiente", "periodo pago"] },
    { campo: "fecha", alias: ["fecha", "fecha de registro", "fecha devengue", "f registro"] },
    { campo: "fecha_vencimiento", alias: A_FVENC },
    { campo: "monto", alias: A_MONTO, requerido: true },
    { campo: "banco_destino", alias: A_BANCO },
    { campo: "cuenta_destino", alias: A_CUENTA },
    { campo: "cci_destino", alias: A_CCI },
    { campo: "estado_pago", alias: A_ESTADO },
    { campo: "nro_operacion_bancaria", alias: A_NRO_OP },
    { campo: "fecha_pago", alias: ["fecha de pago", "fecha pago", "f pago", "fecha abono"] },
    { campo: "comprobante_ref", alias: ["comprobante", "n comprobante", "recibo", "recibo por honorarios", "boleta", "referencia", "contrato", "rh"] },
    { campo: "moneda", alias: ["moneda", "mon", "divisa"] },
    { campo: "observaciones", alias: A_OBS },
  ],
  construir(v) {
    const beneficiario = v.texto("beneficiario_nombre");
    if (!beneficiario) return "Falta el beneficiario";

    const monto = montoObligatorio(v, "monto", "Monto");
    if (typeof monto === "string") return monto;
    if (monto === 0) return "El monto es 0";

    const concepto = v.texto("concepto");
    if (!concepto) return "Falta el concepto";

    const fecha = v.fecha("fecha") ?? v.fecha("fecha_vencimiento") ?? v.fecha("fecha_pago");
    if (!fecha) return "Falta una fecha legible (registro, vencimiento o pago)";

    const estadoTxt = v.texto("estado_pago");
    const pagada = estadoPagoDe(estadoTxt) === "pagada";

    return {
      categoria: categoriaGGDe(v.texto("categoria"), concepto),
      beneficiario_nombre: beneficiario,
      documento_identidad: v.texto("documento_identidad") || null,
      concepto,
      descripcion: null,
      periodo: v.texto("periodo") || null,
      fecha,
      fecha_vencimiento: v.fecha("fecha_vencimiento"),
      monto,
      moneda: monedaDe(v.texto("moneda")),
      banco_destino: v.texto("banco_destino") || null,
      cuenta_destino: parsearCuenta(v.texto("cuenta_destino")) ?? (v.texto("cuenta_destino") || null),
      cci_destino: parsearCci(v.texto("cci_destino")),
      // Lo ya pagado en el histórico se importa como aprobado: negarlo obligaría a
      // re-aprobar meses de planilla que ya salieron del banco.
      estado_aprobacion: pagada ? "aprobado" : "pendiente",
      estado_pago: estadoPagoDe(estadoTxt),
      nro_operacion_bancaria: v.texto("nro_operacion_bancaria") || null,
      fecha_pago: v.fecha("fecha_pago"),
      comprobante_ref: v.texto("comprobante_ref") || null,
      observaciones: v.texto("observaciones") || null,
    };
  },
};

// ── Perfil 4 · Caja chica / rendiciones ───────────────────────────────────────

const CATEGORIAS_CC: Record<string, string> = {
  peaje: "peaje",
  peajes: "peaje",
  lavado: "lavado",
  lavadero: "lavado",
  estacionamiento: "estacionamiento",
  parqueo: "estacionamiento",
  cochera: "estacionamiento",
  viatico: "viaticos",
  viaticos: "viaticos",
  alimentacion: "viaticos",
  movilidad: "movilidad",
  taxi: "movilidad",
  pasaje: "movilidad",
  repuesto: "repuesto_menor",
  combustible: "combustible",
  grifo: "combustible",
  tramite: "tramite",
  notaria: "tramite",
  multa: "multa",
  papeleta: "multa",
};

function categoriaCCDe(txt: string, descripcion: string): string {
  const buscar = `${normaliza(txt)} ${normaliza(descripcion)}`;
  for (const [clave, valor] of Object.entries(CATEGORIAS_CC)) {
    if (buscar.includes(clave)) return valor;
  }
  return "otro";
}

export const PERFIL_CAJA_CHICA: Perfil<FilaCajaChica> = {
  clave: "caja_chica",
  nombre: "Caja chica · rendición de gastos",
  descripcion: "Peajes, lavados, estacionamiento y gastos menores rendidos por conductores.",
  campos: [
    { campo: "responsable_nombre", alias: ["responsable", "conductor", "chofer", "usuario responsable", "nombre", "trabajador", "personal"], requerido: true },
    { campo: "fecha", alias: ["fecha", "fecha gasto", "fecha del gasto", "f gasto"], requerido: true },
    { campo: "categoria", alias: ["categoria", "tipo", "tipo de gasto", "concepto", "rubro"] },
    { campo: "descripcion", alias: ["descripcion", "detalle", "glosa", "motivo", "observacion gasto"] },
    { campo: "monto", alias: A_MONTO, requerido: true },
    { campo: "vehiculo_placa", alias: A_PLACA },
    { campo: "ruc_proveedor", alias: A_RUC },
    { campo: "numero_comprobante", alias: A_FACTURA },
    { campo: "moneda", alias: ["moneda", "mon", "divisa"] },
    { campo: "observaciones", alias: A_OBS },
  ],
  construir(v) {
    const responsable = v.texto("responsable_nombre");
    if (!responsable) return "Falta el responsable de la rendición";

    const monto = montoObligatorio(v, "monto", "Monto");
    if (typeof monto === "string") return monto;
    if (monto === 0) return "El monto es 0";

    const fecha = v.fecha("fecha");
    if (!fecha) return `Fecha ilegible ("${v.texto("fecha")}")`;

    const descripcion = v.texto("descripcion");
    const comprobante = parsearComprobante(v.texto("numero_comprobante"));

    return {
      responsable_nombre: responsable,
      fecha,
      categoria: categoriaCCDe(v.texto("categoria"), descripcion),
      descripcion: descripcion || null,
      monto,
      moneda: monedaDe(v.texto("moneda")),
      vehiculo_placa: parsearPlaca(v.texto("vehiculo_placa")),
      ruc_proveedor: parsearRuc(v.texto("ruc_proveedor")),
      comprobante_serie: comprobante.serie,
      comprobante_numero: comprobante.numero,
      tipo_comprobante: comprobante.serie ? "factura" : v.texto("numero_comprobante") ? "boleta" : null,
      observaciones: v.texto("observaciones") || null,
    };
  },
};

// ── Perfil 5 · Extracto bancario BCP / Telecrédito ────────────────────────────
// El extracto del BCP viene en dos variantes: con columnas CARGO y ABONO separadas,
// o con una sola columna IMPORTE donde el signo marca el sentido. Se soportan ambas.

export const PERFIL_EXTRACTO_BCP: Perfil<FilaExtracto> = {
  clave: "extracto_bcp",
  nombre: "Extracto bancario · BCP Telecrédito",
  descripcion: "Movimientos descargados de Telecrédito BCP (cargos, abonos y saldo).",
  campos: [
    { campo: "fecha_movimiento", alias: ["fecha", "fecha de movimiento", "fecha movimiento", "fecha operacion", "f operacion"], requerido: true },
    { campo: "fecha_valuta", alias: ["fecha valuta", "valuta", "fecha proceso", "fecha valor"] },
    { campo: "nro_operacion", alias: [...A_NRO_OP, "num operacion", "referencia", "ref"] },
    { campo: "descripcion_banco", alias: ["descripcion", "descripcion operacion", "detalle", "concepto", "glosa", "operacion", "descripcion movimiento"], requerido: true },
    { campo: "monto_cargo", alias: ["cargo", "debito", "cargos", "debe", "monto cargo", "salida", "retiro"] },
    { campo: "monto_abono", alias: ["abono", "credito", "abonos", "haber", "monto abono", "entrada", "deposito"] },
    { campo: "importe", alias: ["importe", "monto", "monto movimiento"] },
    { campo: "saldo", alias: ["saldo", "saldo contable", "saldo disponible"] },
    { campo: "moneda", alias: ["moneda", "mon", "divisa"] },
  ],
  construir(v) {
    const fecha = v.fecha("fecha_movimiento");
    if (!fecha) return `Fecha de movimiento ilegible ("${v.texto("fecha_movimiento")}")`;

    let cargo = v.monto("monto_cargo") ?? 0;
    let abono = v.monto("monto_abono") ?? 0;

    // Variante de una sola columna con signo.
    if (cargo === 0 && abono === 0) {
      const importe = v.monto("importe");
      if (importe == null) return "La fila no tiene cargo, abono ni importe legible";
      if (importe < 0) cargo = Math.abs(importe);
      else abono = importe;
    }

    // Algunos extractos traen el cargo ya en negativo dentro de su propia columna.
    cargo = Math.abs(cargo);
    abono = Math.abs(abono);
    if (cargo === 0 && abono === 0) return "El movimiento tiene importe 0";

    return {
      fecha_movimiento: fecha,
      fecha_valuta: v.fecha("fecha_valuta"),
      nro_operacion: v.texto("nro_operacion") || null,
      descripcion_banco: v.texto("descripcion_banco") || null,
      monto_cargo: cargo,
      monto_abono: abono,
      saldo: v.monto("saldo"),
      moneda: monedaDe(v.texto("moneda")),
    };
  },
};

// ── Registro ──────────────────────────────────────────────────────────────────

export const PERFILES_CXP = [PERFIL_CXP_OSLO, PERFIL_CXP_TRADICIONAL];
export const PERFILES_GASTOS_GENERALES = [PERFIL_GASTOS_GENERALES];
export const PERFILES_CAJA_CHICA = [PERFIL_CAJA_CHICA];
export const PERFILES_EXTRACTO = [PERFIL_EXTRACTO_BCP];

/** Destino de cada perfil, para que el endpoint de importación sepa dónde escribir. */
export const DESTINO_PERFIL: Record<string, string> = {
  cxp_oslo: "documentos_compra",
  cxp_tradicional: "documentos_compra",
  gastos_generales: "gastos_generales",
  caja_chica: "caja_chica_gastos",
  extracto_bcp: "extractos_bancarios_movimientos",
};

export type ClavePerfil = keyof typeof DESTINO_PERFIL;
