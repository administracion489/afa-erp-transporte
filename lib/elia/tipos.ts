// ============================================================
// ELIA — Tipos compartidos entre el motor (servidor) y el panel (cliente).
// Sin dependencias: este archivo puede importarse desde ambos lados.
// ============================================================

/** Bloques visuales que el motor emite y el panel renderiza como tarjetas. */
export type BloqueUI =
  | { tipo: "servicios"; items: ServicioUI[] }
  | { tipo: "vehiculos"; items: VehiculoUI[] }
  | { tipo: "conductores"; items: ConductorUI[] }
  | { tipo: "kpis"; items: KpiUI[] }
  | { tipo: "ranking"; titulo: string; items: RankingUI[] }
  | { tipo: "serie"; titulo: string; items: SerieUI[] }
  | { tipo: "link"; href: string; etiqueta: string }
  | { tipo: "accion"; accion: AccionPropuesta };

/** Serie para mini-gráfico de barras horizontales (ej. ventas por mes). */
export type SerieUI = {
  label: string;    // ej. "may"
  valor: number;    // magnitud para escalar la barra
  etiqueta: string; // valor formateado, ej. "S/ 45.2k"
};

export type RankingUI = {
  puesto: number;
  nombre: string;
  valor: string; // ej. "S/ 45,200.00" o "18 servicios"
  sub?: string;  // ej. "12 servicios · margen S/ 8,100"
};

export type ServicioUI = {
  id: number;
  codigo?: string | null;
  origen: string | null;
  destino: string | null;
  fecha: string | null;
  hora: string | null;
  estado: string;          // valor canónico (lib/estados)
  estadoEtiqueta: string;  // etiqueta legible
  adminEtiqueta?: string | null;
  cliente?: string | null;
  unidad?: string | null;
  conductor?: string | null;
};

export type VehiculoUI = {
  placa: string;
  categoria?: string | null;
  marcaModelo?: string | null;
  estado?: string | null;
  semaforo: "verde" | "ambar" | "rojo";
  alertas: string[]; // ej. "SOAT vence en 5 días"
};

export type ConductorUI = {
  nombre: string;
  estado?: string | null;
  telefono?: string | null;
  alertas: string[];
};

export type KpiUI = {
  label: string;
  valor: string;
  sub?: string;
  intent?: "ok" | "warn" | "danger" | "info";
};

/** Acción que ELIA propone y el usuario confirma con un botón (nunca se ejecuta sola). */
export type AccionPropuesta = {
  tipo: "recordatorio_reserva" | "confirmar_reserva";
  reserva_id: number;
  titulo: string;
  detalle: string;
};

/** Eventos del stream SSE de /api/elia. */
export type EventoElia =
  | { t: "texto"; d: string }
  | { t: "tool"; d: { nombre: string; etiqueta: string } }
  | { t: "ui"; d: BloqueUI }
  | { t: "fin"; d?: null }
  | { t: "error"; d: string };

/** Ítem del radar proactivo (avisos que ELIA detecta sola). */
export type RadarItem = {
  nivel: "critico" | "atencion" | "info";
  texto: string;
  href?: string;
};

/** Mensaje del historial que el panel envía al motor. */
export type MensajeHistorial = { rol: "usuario" | "elia"; texto: string };
