// components/licitaciones/editor/etiquetas.ts — Rótulos de pantalla del editor (no deciden nada).
import type { CategoriaRequisito, EstadoFinal, EstadoLicitacion, Gravedad, Paso, TipoBase } from "@/lib/licitaciones/tipos";

export const ETIQUETA_PASO: Record<Paso, { n: number; corto: string; largo: string }> = {
  bases: { n: 1, corto: "Bases", largo: "Bases y requisitos" },
  recursos: { n: 2, corto: "Recursos", largo: "Recursos" },
  contenido: { n: 3, corto: "Contenido", largo: "Contenido" },
  expediente: { n: 4, corto: "Expediente", largo: "Expediente" },
  revision: { n: 5, corto: "Revisión", largo: "Revisión y emisión" },
};

export const ETIQUETA_ESTADO: Record<EstadoLicitacion, { texto: string; color: string; bg: string }> = {
  preparacion: { texto: "En preparación", color: "#0b315f", bg: "#e0e7ef" },
  presentada: { texto: "Presentada", color: "#1d4ed8", bg: "#dbeafe" },
  adjudicada: { texto: "Adjudicada", color: "#166534", bg: "#dcfce7" },
  no_adjudicada: { texto: "No adjudicada", color: "#6b7280", bg: "#f3f4f6" },
  desierta: { texto: "Desierta", color: "#6b7280", bg: "#f3f4f6" },
  descartada: { texto: "Descartada", color: "#6b7280", bg: "#f3f4f6" },
};

export const ETIQUETA_CATEGORIA: Record<CategoriaRequisito, string> = {
  legal: "Legal", experiencia: "Experiencia", unidad: "Unidades", conductor: "Conductores", seguro: "Seguros",
  declaracion: "Declaraciones juradas", tecnico: "Técnico", economico: "Económico", otro: "Otro",
};

export const ETIQUETA_TIPO_BASE: Record<TipoBase, string> = {
  bases: "Bases", tdr: "Términos de referencia (TDR)", absolucion: "Absolución de consultas", anexo: "Anexo",
  requisitos_cliente: "Requisitos del cliente", otro: "Otro",
};
export const TIPOS_BASE_LISTA: readonly TipoBase[] = ["bases", "tdr", "absolucion", "anexo", "requisitos_cliente", "otro"];

/** Rojo = hay que actuar · ámbar = no se puede comprobar · verde = cumple · gris = informativo. */
export const ETIQUETA_FINAL: Record<EstadoFinal, { texto: string; color: string; bg: string; bd: string }> = {
  cumple: { texto: "Cumple", color: "#166534", bg: "#dcfce7", bd: "#86efac" },
  no_cumple: { texto: "No cumple", color: "#991b1b", bg: "#fee2e2", bd: "#fca5a5" },
  no_aplica: { texto: "No aplica", color: "#4b5563", bg: "#f3f4f6", bd: "#d1d5db" },
  pendiente: { texto: "Pendiente", color: "#4b5563", bg: "#f3f4f6", bd: "#d1d5db" },
  no_se_puede_juzgar: { texto: "No se puede comprobar", color: "#92400e", bg: "#fef3c7", bd: "#fcd34d" },
};

export const ESTILO_GRAVEDAD: Record<Gravedad, { texto: string; color: string; bg: string; bd: string; icono: string }> = {
  alarma: { texto: "Alarma", color: "#991b1b", bg: "#fef2f2", bd: "#fca5a5", icono: "⛔" },
  aviso: { texto: "Aviso", color: "#92400e", bg: "#fffbeb", bd: "#fcd34d", icono: "⚠" },
  info: { texto: "Info", color: "#1e3a8a", bg: "#eff6ff", bd: "#bfdbfe", icono: "ℹ" },
};

export const COLOR_PRIMARIO = "#0b315f";

/** "1.2 MB" / "340 KB". */
export function tamanoArchivo(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("es-PE", { maximumFractionDigits: 1 })} MB`;
}

/** "hace 2 min", "hace 1 h"… (relativo a `ahora`, en ms). */
export function haceCuanto(desde: number, ahora: number): string {
  const s = Math.max(0, Math.round((ahora - desde) / 1000));
  if (s < 45) return "hace unos segundos";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

/** Fecha y hora de un instante en Lima: "24/10/2026 14:05". */
export function instanteLima(iso: string | number | null | undefined): string {
  if (iso == null || iso === "") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}
