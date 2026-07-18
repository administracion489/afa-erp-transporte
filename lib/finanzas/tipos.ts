// ──────────────────────────────────────────────────────────────────────────────
// lib/finanzas/tipos.ts — Tipos del dominio Finanzas/Contabilidad (cliente y servidor).
// Espejo de las tablas de supabase/finanzas-0x.sql y contabilidad-04. Sin dependencias.
// ──────────────────────────────────────────────────────────────────────────────

export type Moneda = "PEN" | "USD";
export type SentidoPago = "cobro" | "pago";
export type ContraparteTipo = "cliente" | "proveedor" | "tercero" | "otro";
export type DocumentoTipo =
  | "factura"
  | "documento_compra"
  | "liquidacion_cliente"
  | "liquidacion_proveedor";

// ── Tesorería ──────────────────────────────────────────────────────────────
export type CuentaTesoreria = {
  id: number;
  nombre: string;
  tipo: "banco" | "caja" | "billetera";
  moneda: Moneda;
  banco: string | null;
  numero_cuenta: string | null;
  cci: string | null;
  saldo_inicial: number;
  activo: boolean;
  observaciones: string | null;
  created_at: string;
};

export type Pago = {
  id: number;
  codigo: string | null;
  sentido: SentidoPago;
  cuenta_tesoreria_id: number | null;
  fecha: string;
  monto: number;
  moneda: Moneda;
  tipo_cambio: number | null;
  metodo: string | null;
  contraparte_tipo: ContraparteTipo | null;
  contraparte_id: number | null;
  referencia: string | null;
  comprobante_url: string | null;
  observaciones: string | null;
  anulado: boolean;
  creado_por: string | null;
  created_at: string;
};

export type PagoAplicacion = {
  id: number;
  pago_id: number;
  documento_tipo: DocumentoTipo;
  documento_id: number;
  monto_aplicado: number;
  created_at: string;
};

export type MovimientoTesoreria = {
  id: number;
  cuenta_tesoreria_id: number;
  fecha: string;
  sentido: "entrada" | "salida";
  monto: number;
  moneda: Moneda;
  concepto: string | null;
  pago_id: number | null;
  referencia: string | null;
  conciliado: boolean;
  fecha_conciliacion: string | null;
  created_at: string;
};

// ── Compras / CxP ────────────────────────────────────────────────────────────
export type EstadoConciliacion = "pendiente" | "conciliado" | "con_diferencia" | "anulado";

export type DocumentoCompra = {
  id: number;
  proveedor_id: number | null;
  ruc_emisor: string | null;
  razon_social: string | null;
  tipo_comprobante: string;
  serie: string | null;
  numero: string | null;
  fecha_emision: string;
  fecha_vencimiento: string | null;
  moneda: Moneda;
  tipo_cambio: number | null;
  subtotal: number;
  igv: number;
  inafecto: number;
  detraccion_pct: number | null;
  detraccion_monto: number;
  retencion_monto: number;
  total: number;
  categoria: string | null;
  estado_conciliacion: EstadoConciliacion;
  estado_pago: "impaga" | "parcial" | "pagada";
  oc_id: number | null;
  empresa_tercerizada_id?: number | null;
  liquidacion_proveedor_id?: number | null;
  xml_url: string | null;
  cdr_url: string | null;
  pdf_url: string | null;
  origen: string;
  observaciones: string | null;
  created_at: string;
};

export type DocumentoCompraDetalle = {
  id: number;
  documento_compra_id: number;
  descripcion: string | null;
  cantidad: number;
  unidad: string | null;
  precio_unitario: number;
  subtotal: number;
  combustible_id: number | null;
  mantenimiento_id: number | null;
  gasto_id: number | null;
  reserva_id: number | null;
};

// ── Liquidaciones ─────────────────────────────────────────────────────────────
export type EstadoLiquidacionCliente = "borrador" | "aprobada" | "facturada" | "anulada";
export type EstadoLiquidacionProveedor = "borrador" | "aprobada" | "por_pagar" | "pagada" | "anulada";

export type LiquidacionCliente = {
  id: number;
  codigo: string | null;
  cliente_id: number | null;
  periodo: string | null;
  fecha: string;
  moneda: Moneda;
  estado: EstadoLiquidacionCliente;
  subtotal: number;
  igv: number;
  total: number;
  factura_id: number | null;
  aprobada_por: string | null;
  fecha_aprobacion: string | null;
  observaciones: string | null;
};

export type LiquidacionClienteDetalle = {
  id?: number;
  liquidacion_id?: number;
  reserva_id: number | null;
  tarifa: number;
  horas_adicionales: number;
  espera: number;
  km_adicionales: number;
  peajes: number;
  otros_adicionales: number;
  descuento: number;
  subtotal_linea: number;
  concepto: string | null;
};

export type LiquidacionProveedor = {
  id: number;
  codigo: string | null;
  empresa_tercerizada_id: number | null;
  proveedor_id: number | null;
  periodo: string | null;
  fecha: string;
  moneda: Moneda;
  estado: EstadoLiquidacionProveedor;
  subtotal: number;
  igv: number;
  detraccion_pct: number | null;
  detraccion_monto: number;
  anticipos: number;
  total: number;
  documento_compra_id: number | null;
  aprobada_por: string | null;
  fecha_aprobacion: string | null;
  observaciones: string | null;
};

export type LiquidacionProveedorDetalle = {
  id?: number;
  liquidacion_id?: number;
  reserva_id: number | null;
  oc_id: number | null;
  tarifa_acordada: number;
  adicionales: number;
  penalidad: number;
  descuento: number;
  subtotal_linea: number;
  concepto: string | null;
};

// ── Contabilidad ──────────────────────────────────────────────────────────────
export type CuentaContable = {
  codigo: string;
  nombre: string;
  tipo: "activo" | "pasivo" | "patrimonio" | "ingreso" | "gasto" | "orden";
  naturaleza: "deudora" | "acreedora";
  nivel: number;
  imputable: boolean;
  activo: boolean;
};

export type AsientoDetalle = {
  cuenta: string;
  debe: number;
  haber: number;
  glosa?: string | null;
  vehiculo_id?: number | null;
  cliente_id?: number | null;
  reserva_id?: number | null;
};

export type Asiento = {
  id?: number;
  numero?: string | null;
  periodo?: string | null;
  fecha: string;
  glosa: string | null;
  origen_tipo: string | null;
  origen_id: number | null;
  moneda: Moneda;
  total_debe: number;
  total_haber: number;
  estado: "borrador" | "asentado" | "anulado";
  lineas: AsientoDetalle[];
};
