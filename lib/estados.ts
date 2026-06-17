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
