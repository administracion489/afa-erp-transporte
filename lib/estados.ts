// ──────────────────────────────────────────────────────────────────────────────
// lib/estados.ts — FUENTE ÚNICA DE VERDAD de los estados de un servicio (reserva).
//
// El servicio se modela en DOS dimensiones independientes:
//
//   Dimensión A · Ciclo de vida OPERATIVO   → columna  reservas.estado
//     pendiente → programada → confirmada → en_curso → finalizada   (+ cancelada)
//     Responde: "¿el bus salió y llegó?"
//
//   Dimensión B · Estado ADMINISTRATIVO      → columna  reservas.estado_admin
//     por_liquidar → liquidada → facturada → cobrada
//     Responde: "¿el servicio está cerrado/facturado/cobrado?"
//     Solo aplica cuando A llegó a "finalizada".
//
// REGLA: las etiquetas y colores viven AQUÍ una sola vez. Ninguna pantalla debe
// redefinir su propio diccionario de estados. Importa desde "@/lib/estados".
// ──────────────────────────────────────────────────────────────────────────────

// ── Dimensión A · ciclo de vida operativo ──────────────────────────────────────

export type EstadoReserva =
  | "pendiente"
  | "programada"
  | "confirmada"
  | "en_curso"
  | "finalizada"
  | "cancelada";

export type ConfigEstado = {
  label: string;       // etiqueta única que se muestra en TODA la app
  descripcion: string; // micro-descripción del paso (para el flujo de estados)
  bg: string;          // fondo de la pastilla
  color: string;       // texto de la pastilla
  dot: string;         // punto/indicador
};

// El estado canónico final es "finalizada" — NO usar "Realizado" ni "Completado"
// como palabras sueltas; ambas se mostraban antes y se unifican aquí en "Finalizada".
export const ESTADOS_RESERVA: Record<EstadoReserva, ConfigEstado> = {
  pendiente:  { label: "Pendiente",  descripcion: "Sin asignación",   bg: "#fef9c3", color: "#854d0e", dot: "#eab308" },
  programada: { label: "Programada", descripcion: "Recurso asignado", bg: "#e0f2fe", color: "#0369a1", dot: "#0284c7" },
  confirmada: { label: "Confirmada", descripcion: "Cliente confirmó", bg: "#dcfce7", color: "#166534", dot: "#16a34a" },
  en_curso:   { label: "En curso",   descripcion: "En ejecución",     bg: "#dbeafe", color: "#1d4ed8", dot: "#2563eb" },
  finalizada: { label: "Finalizada", descripcion: "Servicio realizado", bg: "#ede9fe", color: "#6d28d9", dot: "#7c3aed" },
  cancelada:  { label: "Cancelada",  descripcion: "Servicio anulado",   bg: "#fee2e2", color: "#991b1b", dot: "#dc2626" },
};

export const ESTADOS_RESERVA_LISTA = Object.keys(ESTADOS_RESERVA) as EstadoReserva[];

// Orden del ciclo de vida (para no degradar accidentalmente un estado superior).
// finalizada y cancelada comparten orden máximo: ambas son terminales.
export const ORDEN_ESTADO: Record<EstadoReserva, number> = {
  pendiente: 0, programada: 1, confirmada: 2, en_curso: 3, finalizada: 4, cancelada: 4,
};

// Estados terminales: el servicio ya no avanza en el ciclo operativo.
export function esEstadoTerminal(e: EstadoReserva): boolean {
  return e === "finalizada" || e === "cancelada";
}

// "En curso" SOLO lo activa el conductor desde la app conductor (check-in GPS).
// No debe ser seleccionable manualmente en los paneles internos.
export const ESTADOS_EDITABLES_MANUAL: EstadoReserva[] =
  ESTADOS_RESERVA_LISTA.filter(e => e !== "en_curso");

// Etiqueta tolerante a valores nulos/desconocidos (defensiva para datos legados).
export function etiquetaEstado(e: EstadoReserva | string | null | undefined): string {
  if (!e) return "—";
  return (ESTADOS_RESERVA as Record<string, ConfigEstado>)[e]?.label ?? String(e);
}

// Config tolerante: si el valor no existe, cae a "pendiente" (nunca undefined).
export function configEstado(e: EstadoReserva | string | null | undefined): ConfigEstado {
  return (e && (ESTADOS_RESERVA as Record<string, ConfigEstado>)[e]) || ESTADOS_RESERVA.pendiente;
}

// Normaliza cualquier valor de estado (incluido legado o variantes de género/mayúsculas)
// al ciclo canónico. Tras la limpieza de datos (supabase/reservas-estado-check.sql) la BD
// ya solo guarda canónicos, pero esto blinda lecturas de datos viejos o de orígenes externos.
// NOTA: 'por_confirmar' (valor legado) se mapea a 'programada' por decisión de negocio.
export function normalizaEstado(e: EstadoReserva | string | null | undefined): EstadoReserva {
  switch ((e ?? "").toString().trim().toLowerCase()) {
    case "pendiente":                                  return "pendiente";
    case "programada": case "por_confirmar":           return "programada";
    case "confirmada": case "confirmado":              return "confirmada";
    case "en_curso":   case "en_ruta":                 return "en_curso";
    case "finalizada": case "finalizado":
    case "completada": case "completado":
    case "realizada":  case "realizado":               return "finalizada";
    case "cancelada":  case "cancelado":               return "cancelada";
    default:                                           return "pendiente";
  }
}

// ── Dimensión B · estado administrativo / liquidación ──────────────────────────

export type EstadoAdmin = "por_liquidar" | "liquidada" | "facturada" | "cobrada";

export type ConfigAdmin = {
  label: string;
  descripcion: string;
  color: string; // familia VIOLETA — distinta a propósito del ciclo operativo
  orden: number;
};

// Una sola familia de color (violeta) para que la dimensión B "se lea como grupo"
// y nunca se confunda con los colores del ciclo operativo (dimensión A).
export const ESTADOS_ADMIN: Record<EstadoAdmin, ConfigAdmin> = {
  por_liquidar: { label: "Por liquidar", descripcion: "Viaje hecho, falta conciliar",      color: "#7c3aed", orden: 0 },
  liquidada:    { label: "Liquidada",    descripcion: "Manifiesto y costos conciliados",   color: "#6d28d9", orden: 1 },
  facturada:    { label: "Facturada",    descripcion: "Comprobante emitido (SUNAT)",       color: "#5b21b6", orden: 2 },
  cobrada:      { label: "Cobrada",      descripcion: "Pago recibido",                     color: "#4c1d95", orden: 3 },
};

export const ESTADOS_ADMIN_LISTA = Object.keys(ESTADOS_ADMIN) as EstadoAdmin[];

// La dimensión B solo tiene sentido cuando el servicio ya se realizó (A = finalizada).
export function aplicaAdmin(estado: EstadoReserva | string | null | undefined): boolean {
  return estado === "finalizada";
}

// EL PUENTE entre dimensiones: al pasar A → "finalizada", el estado administrativo
// arranca automáticamente en "por_liquidar".
export const ESTADO_ADMIN_INICIAL: EstadoAdmin = "por_liquidar";

export function etiquetaAdmin(e: EstadoAdmin | string | null | undefined): string {
  if (!e) return "—";
  return (ESTADOS_ADMIN as Record<string, ConfigAdmin>)[e]?.label ?? String(e);
}

// Siguiente estado administrativo en el flujo (null si ya es el último).
export function siguienteAdmin(e: EstadoAdmin | string | null | undefined): EstadoAdmin | null {
  const i = e ? ESTADOS_ADMIN_LISTA.indexOf(e as EstadoAdmin) : -1;
  if (i < 0 || i >= ESTADOS_ADMIN_LISTA.length - 1) return null;
  return ESTADOS_ADMIN_LISTA[i + 1];
}

// ── Dimensión B refinada · derivar el estado admin de HECHOS, no de un clic ──────
//
// El problema que resuelve: hoy facturas.estado y reservas.estado_admin son "dos
// verdades" que divergen porque se avanzan a mano. La regla nueva: el estado admin
// del CLIENTE se DERIVA de si existe factura emitida y del saldo por cobrar
// (total − Σ pagos_aplicacion). Un único servicio de cobro/facturación llama a esto
// y actualiza reservas.estado_admin de forma consistente. Ver lib/finanzas/pagos.ts.
//
//   sin factura                 → por_liquidar (o liquidada, si ya se concilió)
//   factura emitida, saldo>0     → facturada
//   factura emitida, saldo=0     → cobrada
//
// `liquidada` es un paso previo explícito (la liquidación al cliente fue aprobada
// pero aún no se emite comprobante). No se puede DERIVAR de factura/saldo, así que
// se pasa como pista `conciliada`.
export function estadoAdminDerivado(args: {
  tieneFactura: boolean;
  total?: number | null;
  pagado?: number | null;
  conciliada?: boolean; // liquidación al cliente aprobada (aún sin factura)
}): EstadoAdmin {
  const total = Number(args.total ?? 0);
  const pagado = Number(args.pagado ?? 0);
  if (args.tieneFactura) {
    // Saldo cero (con tolerancia de céntimo) ⇒ cobrada.
    if (total > 0 && pagado + 0.005 >= total) return "cobrada";
    return "facturada";
  }
  return args.conciliada ? "liquidada" : "por_liquidar";
}

// ── Dimensión C · estado del PROVEEDOR / tercero (columna reservas.estado_proveedor) ──
//
// B modela el lado CLIENTE (cobro). C modela el lado PROVEEDOR (pago), que B nunca
// tocó. SOLO aplica cuando el servicio fue tercerizado (tipo_asignacion='tercerizado').
//
//   por_conciliar → conciliada → por_pagar → pagada
//   Responde: "¿concilié lo que me cobra el tercero y ya le pagué?"
//
// Familia de color ÁMBAR/TEAL — distinta a propósito del ciclo operativo (azules) y
// de la dimensión B (violeta), para que las tres se lean como grupos separados.

export type EstadoProveedor = "por_conciliar" | "conciliada" | "por_pagar" | "pagada";

export type ConfigProveedor = {
  label: string;
  descripcion: string;
  color: string;
  orden: number;
};

export const ESTADOS_PROVEEDOR: Record<EstadoProveedor, ConfigProveedor> = {
  por_conciliar: { label: "Por conciliar", descripcion: "Servicio tercerizado hecho, falta conciliar costo", color: "#b45309", orden: 0 },
  conciliada:    { label: "Conciliada",    descripcion: "Liquidación al proveedor aprobada",                 color: "#0f766e", orden: 1 },
  por_pagar:     { label: "Por pagar",     descripcion: "Cuenta por pagar generada",                         color: "#a16207", orden: 2 },
  pagada:        { label: "Pagada",        descripcion: "Pago emitido y aplicado",                           color: "#065f46", orden: 3 },
};

export const ESTADOS_PROVEEDOR_LISTA = Object.keys(ESTADOS_PROVEEDOR) as EstadoProveedor[];

// La dimensión C solo aplica a servicios tercerizados ya realizados.
export function aplicaProveedor(args: {
  estado: EstadoReserva | string | null | undefined;
  tipoAsignacion?: string | null;
}): boolean {
  return normalizaEstado(args.estado) === "finalizada"
    && (args.tipoAsignacion ?? "") === "tercerizado";
}

// Al finalizar un servicio tercerizado, la dimensión C arranca en "por_conciliar".
export const ESTADO_PROVEEDOR_INICIAL: EstadoProveedor = "por_conciliar";

export function etiquetaProveedor(e: EstadoProveedor | string | null | undefined): string {
  if (!e) return "—";
  return (ESTADOS_PROVEEDOR as Record<string, ConfigProveedor>)[e]?.label ?? String(e);
}

export function configProveedor(e: EstadoProveedor | string | null | undefined): ConfigProveedor {
  return (e && (ESTADOS_PROVEEDOR as Record<string, ConfigProveedor>)[e]) || ESTADOS_PROVEEDOR.por_conciliar;
}

export function siguienteProveedor(e: EstadoProveedor | string | null | undefined): EstadoProveedor | null {
  const i = e ? ESTADOS_PROVEEDOR_LISTA.indexOf(e as EstadoProveedor) : -1;
  if (i < 0 || i >= ESTADOS_PROVEEDOR_LISTA.length - 1) return null;
  return ESTADOS_PROVEEDOR_LISTA[i + 1];
}

// Derivar el estado del proveedor de hechos (liquidación aprobada, saldo por pagar).
export function estadoProveedorDerivado(args: {
  liquidacionAprobada: boolean;
  total?: number | null;
  pagado?: number | null;
}): EstadoProveedor {
  if (!args.liquidacionAprobada) return "por_conciliar";
  const total = Number(args.total ?? 0);
  const pagado = Number(args.pagado ?? 0);
  if (total > 0 && pagado + 0.005 >= total) return "pagada";
  return "por_pagar";
}

// ── Capa CLIENTE · proyección de cara al cliente final ──────────────────────────
//
// El cliente NO ve el detalle operativo interno. En particular "pendiente" (servicio
// recibido pero aún SIN recursos asignados) se le muestra como "En proceso" — honesto
// y distinto de "Programada" (que implica recursos ya asignados). El resto coincide con
// el ciclo; "Finalizada" es la única etiqueta para un servicio realizado.
//
// REGLA: esta es la ÚNICA fuente del vocabulario que ve el cliente. El portal
// (app/cliente) NO debe redefinir su propio diccionario de estados.
// El campo de color de texto se llama `c` para calzar con el design system del portal.

export type ConfigCliente = { label: string; bg: string; c: string; dot: string };

export const ESTADOS_CLIENTE: Record<EstadoReserva, ConfigCliente> = {
  pendiente:  { label: "En proceso", bg: "#FBEFD5", c: "#A65B0A", dot: "#D97706" },
  programada: { label: "Programada", bg: "#F1F5F9", c: "#475569", dot: "#94A3B8" },
  confirmada: { label: "Confirmada", bg: "#E1E9FB", c: "#1d4ed8", dot: "#3b82f6" },
  en_curso:   { label: "En curso",   bg: "#E3F1E6", c: "#15803d", dot: "#15803d" },
  finalizada: { label: "Finalizada", bg: "#EFEFEC", c: "#1F2433", dot: "#6B6F7C" },
  cancelada:  { label: "Cancelada",  bg: "#FCE5E2", c: "#B91C1C", dot: "#B91C1C" },
};

// Proyección tolerante: normaliza el valor y devuelve la config de cara al cliente.
// Nunca undefined.
export function estadoCliente(e: EstadoReserva | string | null | undefined): ConfigCliente {
  return ESTADOS_CLIENTE[normalizaEstado(e)];
}
