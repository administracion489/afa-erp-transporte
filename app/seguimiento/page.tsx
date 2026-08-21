"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import ModalGps from "@/components/seguimiento/ModalGps";
import PanelMensajesPasajeros from "@/components/seguimiento/PanelMensajesPasajeros";
import DescargaMasivaModal from "@/components/seguimiento/DescargaMasivaModal";
import FichaServicioNueva from "@/components/seguimiento/FichaServicio";
import { supabase } from "@/lib/supabase";
import { ESTADOS_RESERVA } from "@/lib/estados";
import { idAfa } from "@/lib/folio";
import { esAbordado } from "@/lib/documentos-servicio";
import { paginarFilas } from "@/lib/huella";
import { NIVEL_RETRASO, type NivelRetraso } from "@/lib/retrasos";
import { derivarTiempos, procedencia, type Instante } from "@/lib/servicio-tiempos";

// ══════════════════════════════════════════════════════════════════════════════
// TIPOS
// ══════════════════════════════════════════════════════════════════════════════

type EstadoReserva = "pendiente"|"programada"|"confirmada"|"en_curso"|"finalizada"|"cancelada";
type EstadoVisual  = "programado"|"en_ruta"|"finalizado"|"alerta"|"cancelado";

type Reserva = {
  id: number; codigo?: string|null; cliente_id: number|null; vehiculo_id: number|null; conductor_id: number|null;
  empresa_tercerizada_id: number|null; vehiculo_tercero_id: number|null;
  tipo: string; tipo_asignacion: string|null; tipo_servicio_detalle: string|null;
  estado: EstadoReserva; fecha_servicio: string|null; hora_servicio: string|null;
  hora_real_inicio?: string|null; hora_real_fin?: string|null;
  checkin_realizado?: boolean|null; viaticos_entregados?: boolean|null;
  // `documentos_ok` y `conformidad_firmada` quedaron HUÉRFANAS al retirar las tarjetas clásicas:
  // eran dos toggles manuales que solo esta página escribía y leía (grep en todo el repo). Siguen
  // declaradas porque las columnas existen en la BD y `select("*")` las trae, pero HOY NADIE LAS
  // MIRA. `documentos_ok` tiene relevo conceptual en `evaluarAptitud` (lib/documentos-estado.ts,
  // que además razona contra ella); `conformidad_firmada` NO tiene relevo: si el negocio necesita
  // marcar que el cliente firmó la conformidad de un eventual, hay que darle sitio en la ficha.
  documentos_ok?: boolean|null; conformidad_firmada?: boolean|null;
  conformidad_url?: string|null; unidad_reemplazo_placa?: string|null;
  reemplazo_motivo?: string|null; pasajeros_abordados?: number|null;
  precio_cliente: number; costo_proveedor: number; margen: number;
  observaciones: string|null; origen?: string|null; destino?: string|null;
};

type Cliente   = { id: number; nombre: string; empresa?: string|null };
type Vehiculo  = { id: number; placa: string; capacidad_pasajeros?: number|null };
type Conductor = { id: number; nombre: string; telefono?: string|null };
type EmpTer    = { id: number; razon_social: string; telefono?: string|null };
type VehTer    = { id: number; placa: string };
// `hora_llegada` (timestamptz) la escribe el conductor al entrar al geocerco del paradero
// (app/api/conductor/route.ts, case "marcar_parada"). Ya venía en el `select("*")` de abajo;
// lo que faltaba era declararla para poder usarla: es la fuente nº 1 de la hora real de salida.
type Parada    = { id: number; reserva_id: number; orden: number; nombre: string; estado: string; hora_estimada?: string|null; hora_llegada?: string|null; lat?: number|null; lng?: number|null };
type DocTer    = { id: number; empresa_id: number; tipo: string; fecha_vencimiento?: string|null };
type DocVeh    = { id: number; vehiculo_id: number; tipo: string; fecha_vencimiento?: string|null };

type ServicioView = {
  reserva: Reserva; cliente_nombre: string; vehiculo_placa: string;
  conductor_nombre: string; conductor_tel: string; es_eventual: boolean;
  estado_visual: EstadoVisual; paradas: Parada[]; paradas_total: number;
  paradas_completadas: number; pasajeros_total: number; pasajeros_abordados: number;
  pasajeros_total_real: number; seguro_vence_hoy: boolean;
  gastos_total: number; docs_vencidos: string[];
  // Alertas de flota cruzadas (se rellenan en un segundo memo sobre todos los servicios):
  conflicto_vehiculo?: boolean; conflicto_conductor?: boolean; jornada_extensa?: boolean;
  // Semáforo de puntualidad (lo calcula el servidor: /api/seguimiento/retrasos):
  puntualidad?: Puntualidad;
  /** Hora real de salida DERIVADA de la evidencia del conductor, con su procedencia.
   *  null = no hay hora, que no es lo mismo que "no salió" (ver el memo que la calcula). */
  salida?: Instante | null;
};

/** Veredicto de puntualidad tal como llega del endpoint (espejo de lib/retrasos.ts). */
type Puntualidad = {
  nivel: NivelRetraso;
  minutos: number | null;
  causa: string;
  evidencia: string;
  escala: boolean;
  posicion: "en_punto" | "lejos" | "desconocida";
  distancia_m: number | null;
  gps_hace_min: number | null;
  confianza: "alta" | "baja" | "nula";
};

/** Conteo por nivel que devuelve el endpoint (`vivas` = las que sí exigen actuar YA). */
type ResumenPuntualidad = {
  retraso: number; riesgo: number; en_punto_sin_iniciar: number;
  retraso_en_ruta: number; sin_rastreo: number; no_realizado: number;
  inicio_tarde: number; vivas: number;
};

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTES
// ══════════════════════════════════════════════════════════════════════════════

// Etiquetas alineadas con la fuente única (lib/estados). "programado" y "alerta"
// son agrupaciones visuales propias del tablero de seguimiento, no estados de BD.
const ESTADO_VIS = {
  programado: { label: "Programado",                     color: "#6366f1", bg: "#eef2ff", dot: "#6366f1" },
  en_ruta:    { label: ESTADOS_RESERVA.en_curso.label,   color: "#16a34a", bg: "#dcfce7", dot: "#16a34a" },
  finalizado: { label: ESTADOS_RESERVA.finalizada.label, color: "#64748b", bg: "#f1f5f9", dot: "#94a3b8" },
  alerta:     { label: "⚠ Alerta",                       color: "#dc2626", bg: "#fef2f2", dot: "#dc2626" },
  cancelado:  { label: ESTADOS_RESERVA.cancelada.label,  color: "#991b1b", bg: "#fee2e2", dot: "#991b1b" },
} as const;

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

// ── Lectura en lote sin truncar ───────────────────────────────────────────────
// PostgREST muerde por dos sitios y ya mordió TRES veces a este repo (huella truncada a 1000
// puntos, reservas truncadas en /programación, documentos): (1) recorta CUALQUIER respuesta al
// max-rows del servidor —Supabase: 1000— aunque se pida `.limit()` mayor, y (2) un `.in()` con
// miles de ids devuelve 400 porque la URL se pasa de larga.
// Aquí duele especialmente desde que la columna "Salió" se DERIVA de `paradas.hora_llegada` y
// `pasajeros_parada.hora_abordaje`: un día de 60 servicios × 18 paraderos pasa de 1000 filas de
// `paradas`, y los últimos servicios saldrían con "—" TENIENDO la parada marcada en la base —
// engordando el KPI de "sin salida" y ofreciendo registrar a mano algo ya registrado.
// `ordenCols` tiene que dar un orden ESTABLE entre páginas (con un id de desempate) o dos
// páginas se solapan. Mismo helper que `inChunksPaginado` en lib/descarga-masiva.ts:103; se
// repite aquí en lugar de exportarlo para no tocar aquel módulo.
const LOTE_IDS = 80;

async function enLotesPaginado(
  tabla: string, columnas: string, campo: string, ids: number[], ordenCols: string[],
): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += LOTE_IDS) {
    const sub = ids.slice(i, i + LOTE_IDS);
    if (!sub.length) continue;
    out.push(...await paginarFilas(() => {
      let q: any = supabase.from(tabla).select(columnas).in(campo, sub);
      for (const c of ordenCols) q = q.order(c);
      return q;
    }, 200_000));
  }
  return out;
}

// Catálogo entero (sin filtro), paginado y con orden estable por id.
async function tablaPaginada(tabla: string, columnas: string): Promise<any[]> {
  return paginarFilas(() => supabase.from(tabla).select(columnas).order("id"), 200_000);
}

function hoyISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function diasPara(fecha: string|null|undefined): number|null {
  if (!fecha) return null;
  return Math.ceil((new Date(fecha+"T00:00:00").getTime() - Date.now()) / 86400000);
}
/** Minutos transcurridos del día en LIMA (UTC-5). No usar el reloj del equipo: una laptop
 *  con otra zona horaria pintaba retrasos inexistentes (o los ocultaba). */
function ahoraLimaMin(): number {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 5);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// Gracia de respaldo cuando el semáforo del servidor no ha respondido todavía. Es el
// MISMO número que `no_inicio` en alerta_config (antes aquí eran 15 y en el cron 10: la
// pantalla y el WhatsApp se contradecían).
const GRACIA_FALLBACK_MIN = 10;

/** Identidad estable para "no hay veredictos" (no recrear el objeto en cada render). */
const SIN_PUNTUALIDAD: Record<number, Puntualidad> = {};

/**
 * Estado visual de la fila. El retraso ya NO se decide aquí mirando un booleano: lo
 * decide el semáforo de puntualidad del servidor (lib/retrasos.ts), que sí mira dónde
 * está el bus. Solo `retraso` y `no_realizado` pintan la fila en rojo — "riesgo",
 * "en el punto sin iniciar" y "sin rastreo" son chips propios, no un servicio en alerta.
 * Sin veredicto (endpoint caído o SQL sin correr) se cae a un respaldo, que ahora mira la
 * EVIDENCIA en vez del botón: `haySalida` es la hora real derivada de lo que el conductor
 * marcó. El criterio anterior era `!checkin_realizado`, un campo puesto en 1 de 784 servicios,
 * así que el respaldo pintaba en alerta a toda la flota pasados los minutos de gracia.
 */
function calcularEstadoVisual(r: Reserva, v?: Puntualidad, haySalida = false): EstadoVisual {
  if (r.estado === "cancelada")  return "cancelado";
  if (r.estado === "finalizada") return "finalizado";
  if (r.estado === "en_curso")   return "en_ruta";
  if (v) return v.nivel === "retraso" || v.nivel === "no_realizado" ? "alerta" : "programado";
  if (r.fecha_servicio === hoyISO() && r.hora_servicio) {
    const [hh, mm] = r.hora_servicio.split(":").map(Number);
    const plan = hh * 60 + (mm || 0);
    if (ahoraLimaMin() - plan > GRACIA_FALLBACK_MIN && !haySalida) return "alerta";
  }
  return "programado";
}
const TIPOS_SERVICIO_FIJO_SEG = new Set([
  "transporte_personal",
  "fijo_solo_ida",
  "fijo_multiparada",
  "fijo_reten",
]);
function esEventual(r: Reserva): boolean { return !TIPOS_SERVICIO_FIJO_SEG.has(r.tipo_servicio_detalle || ""); }
function riesgoEmpresaDocs(docs: DocTer[], empresaId: number|null): boolean {
  if (!empresaId) return false;
  const OBL = ["SOAT","Revisión Técnica (CITV)","Habilitación SUTRAN","Permiso Operación MTC"];
  return docs.some(d => d.empresa_id === empresaId && OBL.includes(d.tipo) && (diasPara(d.fecha_vencimiento) ?? 1) < 0);
}
function seguroVehiculoVenceHoy(docs: DocVeh[], vehiculoId: number|null): boolean {
  if (!vehiculoId) return false;
  return docs.some(d => d.vehiculo_id === vehiculoId && d.tipo.toLowerCase().includes("soat") && d.fecha_vencimiento === hoyISO());
}


// Fuente de verdad del abordaje (pasajeros_parada, estado + estado_abordaje) → esAbordado()
// vive en lib/documentos-servicio.ts (compartido con el portal cliente y los documentos).

// Documentos vencidos (fecha de vencimiento ya pasada): bloquean la salida.
function docsVencidosVehiculo(docs: DocVeh[], vehiculoId: number|null): string[] {
  if (!vehiculoId) return [];
  return docs.filter(d => d.vehiculo_id === vehiculoId && (diasPara(d.fecha_vencimiento) ?? 1) < 0).map(d => d.tipo);
}
function docsVencidosEmpresa(docs: DocTer[], empresaId: number|null): string[] {
  if (!empresaId) return [];
  const OBL = ["SOAT","Revisión Técnica (CITV)","Habilitación SUTRAN","Permiso Operación MTC"];
  return docs.filter(d => d.empresa_id === empresaId && OBL.includes(d.tipo) && (diasPara(d.fecha_vencimiento) ?? 1) < 0).map(d => d.tipo);
}

// ── Alertas de flota cruzadas entre servicios (solape de recurso + jornada del conductor) ──
// No hay campo de duración en reservas, así que el fin se estima con un bloque por defecto
// cuando aún no hay hora_real_fin. Son alertas ADVERTENCIA (heurística), no certezas.
const DUR_ESTIMADA_MIN        = 240; // 4 h: bloque por defecto para estimar el fin de un servicio
const JORNADA_MAX_H           = 13;  // jornada (1ª salida → último fin) que dispara alerta de fatiga
const MAX_SERVICIOS_CONDUCTOR = 4;   // nº de servicios/día que dispara alerta de fatiga

function aMin(hhmm?: string|null): number|null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return Number.isNaN(h) ? null : h * 60 + (m || 0);
}

function detectarAlertasFlota(base: ServicioView[]): { vehiculo: Set<number>; conductor: Set<number>; fatiga: Set<number> } {
  const vehiculo = new Set<number>(), conductor = new Set<number>(), fatiga = new Set<number>();
  const intervalo = (s: ServicioView): [number, number] | null => {
    const ini = aMin(s.reserva.hora_servicio);
    if (ini == null) return null;
    const fin = aMin(s.reserva.hora_real_fin) ?? ini + DUR_ESTIMADA_MIN;
    return [ini, Math.max(fin, ini + 1)];
  };
  const agrupar = (key: (s: ServicioView) => string | null, marca: Set<number>) => {
    const grupos: Record<string, ServicioView[]> = {};
    base.forEach(s => {
      if (s.reserva.estado === "cancelada") return;
      const k = key(s); if (!k) return;
      (grupos[k] ||= []).push(s);
    });
    Object.values(grupos).forEach(g => {
      for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
        const a = intervalo(g[i]), b = intervalo(g[j]);
        if (a && b && a[0] < b[1] && b[0] < a[1]) { marca.add(g[i].reserva.id); marca.add(g[j].reserva.id); }
      }
    });
    return grupos;
  };
  agrupar(s => s.reserva.vehiculo_id ? `v${s.reserva.vehiculo_id}` : s.reserva.vehiculo_tercero_id ? `vt${s.reserva.vehiculo_tercero_id}` : null, vehiculo);
  const gruposCond = agrupar(s => s.reserva.conductor_id ? `c${s.reserva.conductor_id}` : null, conductor);
  Object.values(gruposCond).forEach(g => {
    const inicios = g.map(s => aMin(s.reserva.hora_servicio)).filter((x): x is number => x != null);
    const fines   = g.map(s => intervalo(s)?.[1]).filter((x): x is number => x != null);
    if (!inicios.length || !fines.length) return;
    const spanH = (Math.max(...fines) - Math.min(...inicios)) / 60;
    if (spanH > JORNADA_MAX_H || g.length >= MAX_SERVICIOS_CONDUCTOR) g.forEach(s => fatiga.add(s.reserva.id));
  });
  return { vehiculo, conductor, fatiga };
}

// ══════════════════════════════════════════════════════════════════════════════
// ICONOS
// ══════════════════════════════════════════════════════════════════════════════

type IP = { size?: number; strokeWidth?: number; className?: string; color?: string };
const Ic = {
  Map:        (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/></svg>,
  Bus:        (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M8 6v6"/><path d="M16 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><circle cx="15" cy="18" r="2"/></svg>,
  Check:      (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="20 6 9 17 4 12"/></svg>,
  Clock:      (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Alert:      (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  Shield:     (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Search:     (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  ChevronDown:(p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="6 9 12 15 18 9"/></svg>,
  ExternalLink:(p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>,
  List:       (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
  Refresh:    (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
  FileText:   (p:IP)=><svg width={p.size??16} height={p.size??16} viewBox="0 0 24 24" fill="none" stroke={p.color??"currentColor"} strokeWidth={p.strokeWidth??2} strokeLinecap="round" strokeLinejoin="round" className={p.className}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>,
};

// ══════════════════════════════════════════════════════════════════════════════
// LISTA (TORRE DE CONTROL)
// ══════════════════════════════════════════════════════════════════════════════
// La ficha del drawer ya NO vive aquí: es components/seguimiento/FichaServicio.tsx (con sus
// modales en components/seguimiento/ModalesServicio.tsx). Este archivo se queda con la lista,
// los filtros y la carga en lote del día.

// Chips de alerta para la fila de la lista (resumen de un vistazo; el detalle va en la ficha).
function chipsAlerta(s: ServicioView): { label: string; color: string; bg: string; title: string }[] {
  const out: { label: string; color: string; bg: string; title: string }[] = [];
  if (s.docs_vencidos.length)     out.push({ label: "DOC",      color: "#b91c1c", bg: "#fee2e2", title: `Documentos vencidos: ${s.docs_vencidos.join(", ")}` });
  // Puntualidad: un chip por NIVEL, con la evidencia en el tooltip. Sin la evidencia el
  // operador no puede decidir si creerle al sistema — y un chip que no se puede verificar
  // se ignora a la semana.
  const p = s.puntualidad;
  if (p && p.nivel !== "na" && p.nivel !== "en_hora") {
    const meta = NIVEL_RETRASO[p.nivel];
    const mins = p.minutos !== null && p.minutos !== 0 ? ` ${p.minutos > 0 ? "+" : ""}${p.minutos}′` : "";
    out.push({
      label: meta.corto + mins, color: meta.color, bg: meta.bg,
      title: `${meta.label}${p.causa ? ` — ${p.causa}` : ""}${p.evidencia ? `\n${p.evidencia}` : ""}`,
    });
  } else if (!p && s.estado_visual === "alerta") {
    out.push({ label: "RETRASO", color: "#dc2626", bg: "#fef2f2", title: "No inició a la hora pactada" });
  }
  if (s.conflicto_vehiculo)       out.push({ label: "UNIDAD×2", color: "#b45309", bg: "#fef3c7", title: "Posible solape: el vehículo está en otro servicio a la misma hora" });
  if (s.conflicto_conductor)      out.push({ label: "CHOFER×2", color: "#b45309", bg: "#fef3c7", title: "Posible solape: el conductor está en otro servicio a la misma hora" });
  if (s.jornada_extensa)          out.push({ label: "JORNADA",  color: "#9a3412", bg: "#ffedd5", title: "Jornada del conductor extensa o demasiados servicios — riesgo de fatiga" });
  if (s.seguro_vence_hoy)         out.push({ label: "SOAT HOY", color: "#dc2626", bg: "#fef2f2", title: "El seguro de la unidad vence hoy" });
  return out;
}

function FilaServicio({ s, onOpen, onGps }: { s: ServicioView; onOpen: () => void; onGps: () => void }) {
  const est      = ESTADO_VIS[s.estado_visual];
  const progreso = s.paradas_total > 0 ? Math.round((s.paradas_completadas / s.paradas_total) * 100) : 0;
  const alertas  = chipsAlerta(s);
  return (
    <div onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="group flex items-center gap-3 px-4 py-3 hover:bg-[#f6f9fd] cursor-pointer transition-colors outline-none focus-visible:bg-[#eef4fb]">
      <div className="w-1.5 h-10 rounded-full flex-shrink-0" style={{ background: est.dot }} />
      <div className="w-12 flex-shrink-0 text-center">
        <div className="font-black text-[#0b315f] text-sm font-mono leading-none">{s.reserva.hora_servicio?.slice(0, 5) || "—"}</div>
        <div className="text-[9px] font-bold uppercase mt-1 leading-none" style={{ color: est.color }}>{est.label.replace("⚠ ", "")}</div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-[#0b315f] text-sm truncate">{s.cliente_nombre}</span>
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${!s.es_eventual ? "bg-[#EFF6FF] text-[#0b315f]" : "bg-indigo-50 text-indigo-600"}`}>{!s.es_eventual ? "Fijo" : "Eventual"}</span>
          <span className="text-[10px] font-black text-gray-400">{idAfa(s.reserva)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
          <span className="font-mono font-bold text-gray-400">{s.vehiculo_placa}</span>
          <span className="text-gray-200">·</span>
          <span className="truncate">{s.conductor_nombre}</span>
        </div>
      </div>
      <div className="hidden sm:flex items-center gap-4 flex-shrink-0">
        {/* SALIÓ, no "Check-in": la hora sale de lo que marcó el conductor, no de un botón que
            nadie pulsa. El guion gris significa "sin hora registrada", nunca "no salió". */}
        <div className="text-center w-14" title={s.salida ? procedencia(s.salida) : "Sin hora de salida registrada todavía"}>
          <div className="text-[9px] font-bold uppercase text-gray-400">Salió</div>
          <div className={`text-xs font-black ${s.salida ? (s.salida.estimado ? "text-gray-500 italic" : "text-green-600") : "text-gray-300"}`}>
            {s.salida ? s.salida.hhmm : "—"}
          </div>
        </div>
        <div className="text-center w-14">
          <div className="text-[9px] font-bold uppercase text-gray-400">Pasaj.</div>
          <div className="text-xs font-black text-[#0b315f]">{s.pasajeros_abordados}<span className="text-gray-300 font-normal">/{s.pasajeros_total_real || "?"}</span></div>
        </div>
        <div className="w-16">
          <div className="text-[9px] font-bold uppercase text-gray-400 text-center mb-1 leading-none">{progreso}%</div>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${progreso}%`, background: progreso === 100 ? "#16a34a" : "#0b315f" }} /></div>
        </div>
      </div>
      {alertas.length > 0 && (
        <div className="hidden md:flex items-center gap-1 flex-shrink-0 max-w-[180px] flex-wrap justify-end">
          {alertas.map((a, i) => (<span key={i} title={a.title} className="text-[9px] font-black px-1.5 py-1 rounded-md whitespace-nowrap" style={{ color: a.color, background: a.bg }}>{a.label}</span>))}
        </div>
      )}
      <div className="flex items-center gap-1.5 flex-shrink-0" onClick={e => e.stopPropagation()}>
        <button onClick={onGps} title="GPS en vivo" className="flex items-center gap-1 bg-[#EFF6FF] hover:bg-[#DBEAFE] text-[#1d4ed8] text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition-colors">
          <Ic.Map size={11} color="#1d4ed8" /><span className="hidden lg:inline">GPS</span>
        </button>
        <Ic.ChevronDown size={15} className="-rotate-90 text-gray-300 group-hover:text-[#0b315f] transition-colors" />
      </div>
    </div>
  );
}

// Cabecera de los documentos (logo/nombre/contacto AFA). La ficha la recibe por prop y la usa
// para timbrar el Manifiesto MTC y el Reporte de servicio.
type EmpresaPerfil = { nombre: string|null; logo_url: string|null; telefono: string|null; email: string|null };

// ══════════════════════════════════════════════════════════════════════════════
// PÁGINA PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════

export default function SeguimientoPage() {
  const [reservas,    setReservas]    = useState<Reserva[]>([]);
  const [clientes,    setClientes]    = useState<Cliente[]>([]);
  const [vehiculos,   setVehiculos]   = useState<Vehiculo[]>([]);
  const [conductores, setConductores] = useState<Conductor[]>([]);
  const [empresas,    setEmpresas]    = useState<EmpTer[]>([]);
  const [vehsTer,     setVehsTer]     = useState<VehTer[]>([]);
  const [paradas,     setParadas]     = useState<Parada[]>([]);
  const [pasajPar,    setPasajPar]    = useState<{parada_id:number; pasajero_id:number; estado?:string|null; estado_abordaje?:string|null; hora_abordaje?:string|null}[]>([]);
  const [paxAdhoc,    setPaxAdhoc]    = useState<{id:number; reserva_id:number}[]>([]);
  const [gastosRows,  setGastosRows]  = useState<{reserva_id:number; monto:number}[]>([]);
  const [docsTer,     setDocsTer]     = useState<DocTer[]>([]);
  const [docsVeh,     setDocsVeh]     = useState<DocVeh[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [fechaFiltro, setFechaFiltro] = useState(hoyISO());
  const [filtroTipo,  setFiltroTipo]  = useState<"todos"|"fijo"|"eventual">("todos");
  const [filtroEstado,setFiltroEstado]= useState<"todos"|EstadoVisual>("todos");
  const [busqueda,    setBusqueda]    = useState("");
  const [gpsModal,    setGpsModal]    = useState<ServicioView | null>(null);
  const [drawer,      setDrawer]      = useState<ServicioView | null>(null);
  const [descargaMasiva, setDescargaMasiva] = useState(false);
  const [empresaPerfil, setEmpresaPerfil] = useState<EmpresaPerfil | null>(null);
  const [puntualidad, setPuntualidad] = useState<Record<number, Puntualidad>>({});
  const [resumenPunt, setResumenPunt] = useState<ResumenPuntualidad | null>(null);
  const [filtroNivel, setFiltroNivel] = useState<NivelRetraso | "todos">("todos");

  // ── Semáforo de puntualidad ───────────────────────────────────────────────────
  // Lo calcula el servidor (/api/seguimiento/retrasos): la posición previa al inicio
  // vive en fixes SIN reserva_id y hay que buscarla por conductor/vehículo — una
  // consulta por servicio que no puede multiplicarse por cada pestaña abierta. Además
  // el ETA con tráfico se paga, y así hay UN solo pagador (el cron) para todos.
  // Solo tiene sentido para HOY: la puntualidad es una pregunta del presente.
  const esHoy = fechaFiltro === hoyISO();
  useEffect(() => {
    if (!esHoy) return;   // el estado NO se limpia aquí: se ignora al leerlo (ver puntActiva)
    let vivo = true;
    const traer = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) return;
        const r = await fetch(`/api/seguimiento/retrasos?fecha=${fechaFiltro}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (!r.ok) return;
        const j = await r.json();
        if (!vivo) return;
        setPuntualidad(j.veredictos || {});
        setResumenPunt(j.resumen || null);
      } catch { /* la torre nunca se cae por este módulo: sin veredicto se pinta como antes */ }
    };
    traer();
    const t = setInterval(traer, 45_000);   // > TTL de caché del endpoint (20 s)
    return () => { vivo = false; clearInterval(t); };
  }, [fechaFiltro, esHoy]);

  // Los veredictos solo aplican a HOY. Se filtra al LEER en vez de limpiar el estado
  // dentro del efecto (eso disparaba un render en cascada), con identidad estable para
  // no invalidar el useMemo de serviciosBase en cada render.
  const puntActiva  = esHoy ? puntualidad : SIN_PUNTUALIDAD;
  const resumenActivo = esHoy ? resumenPunt : null;

  // Cabecera de los documentos (logo/nombre/contacto AFA). Una sola vez por página.
  useEffect(() => {
    supabase.from("empresa_perfil").select("nombre,logo_url,telefono,email").eq("id", 1).maybeSingle()
      .then(({ data }) => { if (data) setEmpresaPerfil(data as EmpresaPerfil); });
  }, []);

  const cargar = useCallback(async () => {
    setLoading(true);
    // `reservas` va sin paginar a propósito: está acotada a UNA fecha (≈20 servicios/día medidos
    // sobre 30 días) y su `.order("hora_servicio")` no es único, así que paginarla sería menos
    // seguro, no más. Todo lo demás sí pagina: ver el comentario de `enLotesPaginado`.
    const [rRes,clRes,vRes,cRes,etRes,vtRes,dtRes] = await Promise.all([
      supabase.from("reservas").select("*").eq("fecha_servicio",fechaFiltro).in("estado",["programada","confirmada","en_curso","finalizada","cancelada"]).order("hora_servicio",{ascending:true}),
      tablaPaginada("clientes","id,nombre,empresa"),
      tablaPaginada("vehiculos","id,placa,capacidad_pasajeros"),
      tablaPaginada("conductores","id,nombre,telefono"),
      tablaPaginada("empresas_tercerizadas","id,razon_social,telefono"),
      tablaPaginada("vehiculos_tercero","id,placa"),
      // 240 proveedores × varios documentos obligatorios pasa de 1000 filas sin despeinarse, y
      // truncarla apagaría avisos de documento vencido justo en los últimos proveedores.
      tablaPaginada("documentos_tercero","id,empresa_id,tipo,fecha_vencimiento"),
    ]);
    const reservasData = (rRes.data as Reserva[])||[];
    setReservas(reservasData); setClientes(clRes as Cliente[]);
    setVehiculos(vRes as Vehiculo[]); setConductores(cRes as Conductor[]);
    setEmpresas(etRes as EmpTer[]); setVehsTer(vtRes as VehTer[]);
    setDocsTer(dtRes as DocTer[]);

    const reservaIds = reservasData.map(r => r.id);
    if (reservaIds.length > 0) {
      // Orden ESTABLE con `id` de desempate: `orden` se repite entre reservas y dos páginas
      // podrían solaparse o saltarse filas. Dentro de cada reserva el orden sigue siendo `orden`,
      // que es de lo que dependen `paradas[0]` (origen), la última (destino) y derivarTiempos.
      const parData = await enLotesPaginado("paradas","*","reserva_id",reservaIds,["reserva_id","orden","id"]);
      setParadas(parData as Parada[]);
      const paradaIds = parData.map((p:any)=>p.id);
      // Abordaje real (estado + estado_abordaje), roster ad-hoc y gastos: todo en lote (sin N+1 por tarjeta).
      const [pp, pax, gastos] = await Promise.all([
        // `hora_abordaje` la pone el SERVIDOR al escanear el QR (app/api/conductor/route.ts).
        // Es la 2ª fuente de la hora real de salida cuando el conductor no marcó el paradero.
        enLotesPaginado("pasajeros_parada","parada_id,pasajero_id,estado,estado_abordaje,hora_abordaje","parada_id",paradaIds,["parada_id","pasajero_id"]),
        enLotesPaginado("pasajeros","id,reserva_id","reserva_id",reservaIds,["reserva_id","id"]),
        enLotesPaginado("gastos","reserva_id,monto","reserva_id",reservaIds,["reserva_id","id"]),
      ]);
      setPasajPar(pp); setPaxAdhoc(pax); setGastosRows(gastos);
    } else { setParadas([]); setPasajPar([]); setPaxAdhoc([]); setGastosRows([]); }

    // Documentos de la FLOTA PROPIA: antes se traía la tabla entera en cada refresco (sin filtro
    // ni paginación). Solo se consultan por `r.vehiculo_id`, así que basta con los vehículos que
    // salen hoy: menos datos, y lo que llega llega completo.
    try {
      const vehIds = Array.from(new Set(reservasData.map(r => r.vehiculo_id).filter((x): x is number => x != null)));
      const docVehData = vehIds.length
        ? await enLotesPaginado("documentos_vehiculo","id,vehiculo_id,tipo,fecha_vencimiento","vehiculo_id",vehIds,["vehiculo_id","id"])
        : [];
      setDocsVeh(docVehData as DocVeh[]);
    } catch { setDocsVeh([]); }

    setLoading(false);
  }, [fechaFiltro]);

  useEffect(()=>{ cargar(); },[cargar]);

  useEffect(()=>{
    const ch = supabase.channel("seguimiento-reservas")
      .on("postgres_changes",{event:"*",schema:"public",table:"reservas"},()=>cargar())
      .on("postgres_changes",{event:"*",schema:"public",table:"paradas"},()=>cargar())
      .subscribe();
    return ()=>{ supabase.removeChannel(ch); };
  },[cargar]);

  const serviciosBase: ServicioView[] = useMemo(()=>{
    // Reloj tomado UNA vez por recálculo: si cada servicio leyera el suyo, dos filas del mismo
    // tablero podrían discrepar sobre qué hora es.
    const ahoraMs = Date.now();
    // Roster y abordaje (unión A∪B, deduped por pasajero_id) calculado una vez para todos los servicios.
    const paradaToReserva = new Map<number, number>();
    paradas.forEach(p => paradaToReserva.set(p.id, p.reserva_id));
    const esperados: Record<number, Set<number>> = {};
    const abordados: Record<number, Set<number>> = {};
    const ensure = (rid:number) => { (esperados[rid] ||= new Set()); (abordados[rid] ||= new Set()); };
    paxAdhoc.forEach(p => { ensure(p.reserva_id); esperados[p.reserva_id].add(p.id); });
    pasajPar.forEach(pp => {
      const rid = paradaToReserva.get(pp.parada_id); if (rid == null) return;
      ensure(rid); esperados[rid].add(pp.pasajero_id);
      if (esAbordado(pp)) abordados[rid].add(pp.pasajero_id);
    });
    const gastosPorReserva: Record<number, number> = {};
    gastosRows.forEach(g => { gastosPorReserva[g.reserva_id] = (gastosPorReserva[g.reserva_id]||0) + Number(g.monto||0); });

    return reservas.map(r=>{
      const cliente        = clientes.find(c=>c.id===r.cliente_id);
      const cliente_nombre = cliente?.empresa||cliente?.nombre||"Sin cliente";
      const esTer          = r.tipo==="tercerizada";
      const vehiculo_placa = esTer?(vehsTer.find(v=>v.id===r.vehiculo_tercero_id)?.placa||"—"):(vehiculos.find(v=>v.id===r.vehiculo_id)?.placa||"—");
      const empresa        = esTer ? empresas.find(e=>e.id===r.empresa_tercerizada_id) : null;
      const conductor      = !esTer ? conductores.find(c=>c.id===r.conductor_id) : null;
      const conductor_nombre = esTer?(empresa?.razon_social||"Tercero"):(conductor?.nombre||"—");
      const conductor_tel    = esTer?(empresa?.telefono||""):(conductor?.telefono||"");
      const paradasR         = paradas.filter(p=>p.reserva_id===r.id);
      const idsParadaR       = new Set(paradasR.map(p=>p.id));
      const esperadosN       = esperados[r.id]?.size || 0;
      const seguro_vence_hoy = esTer ? riesgoEmpresaDocs(docsTer,r.empresa_tercerizada_id) : seguroVehiculoVenceHoy(docsVeh,r.vehiculo_id);
      const docs_vencidos    = esTer ? docsVencidosEmpresa(docsTer,r.empresa_tercerizada_id) : docsVencidosVehiculo(docsVeh,r.vehiculo_id);
      const punt = puntActiva[r.id];
      // ── HORA REAL DE SALIDA, DERIVADA ───────────────────────────────────────────────
      // El tablero leía `checkin_realizado`, un booleano que en producción está puesto en
      // 1 de 784 servicios: la columna salía "—" y el contador acusaba a media flota. La hora
      // ya existe en la evidencia que el conductor deja al operar, y aquí se deriva con lo que
      // el lote YA trajo: paradas.hora_llegada y pasajeros_parada.hora_abordaje.
      // Sin GPS ni eventos a propósito: son una consulta por servicio y el tablero pinta
      // decenas. Por eso aquí se usa SOLO la hora (`inicio`) y NUNCA el veredicto rojo del
      // motor — sin GPS, "no hay evidencia" y "no la miré" son indistinguibles, y acusar con
      // eso sería repetir el bug con otro campo. El rojo lo decide el semáforo de puntualidad
      // del servidor (/api/seguimiento/retrasos), que sí mira dónde está el bus.
      const salida = derivarTiempos({
        reserva: r,
        paradas: paradasR,
        abordajes: pasajPar.filter(pp => idsParadaR.has(pp.parada_id)),
        ahoraMs,
      }).inicio;
      return {
        reserva: r, cliente_nombre, vehiculo_placa, conductor_nombre, conductor_tel, puntualidad: punt, salida,
        es_eventual: esEventual(r), estado_visual: calcularEstadoVisual(r, punt, !!salida),
        paradas: paradasR, paradas_total: paradasR.length,
        paradas_completadas: paradasR.filter(p=>p.estado==="completada").length,
        pasajeros_total: esperadosN||(vehiculos.find(v=>v.id===r.vehiculo_id)?.capacidad_pasajeros||0),
        pasajeros_abordados: abordados[r.id]?.size || 0,
        pasajeros_total_real: esperadosN, seguro_vence_hoy,
        gastos_total: gastosPorReserva[r.id]||0, docs_vencidos,
      };
    });
  },[reservas,clientes,vehiculos,conductores,empresas,vehsTer,paradas,pasajPar,paxAdhoc,gastosRows,docsTer,docsVeh,puntActiva]);

  // Segundo paso: alertas que dependen de TODOS los servicios del día (solape de recurso, jornada).
  const servicios: ServicioView[] = useMemo(()=>{
    const { vehiculo, conductor, fatiga } = detectarAlertasFlota(serviciosBase);
    return serviciosBase.map(s => ({
      ...s,
      conflicto_vehiculo:  vehiculo.has(s.reserva.id),
      conflicto_conductor: conductor.has(s.reserva.id),
      jornada_extensa:     fatiga.has(s.reserva.id),
    }));
  },[serviciosBase]);

  // El drawer guarda una instantánea; al recargar datos, refrescarla con la versión vigente.
  useEffect(() => {
    setDrawer(prev => prev ? (servicios.find(s => s.reserva.id === prev.reserva.id) ?? prev) : prev);
  }, [servicios]);

  // Ir al detalle de un servicio desde el panel de mensajes de pasajeros.
  const [pendienteReserva, setPendienteReserva] = useState<number | null>(null);
  const irAServicio = useCallback((reservaId: number, fechaServicio?: string | null) => {
    const encontrado = servicios.find(s => s.reserva.id === reservaId);
    if (encontrado) { setDrawer(encontrado); return; }
    // El servicio es de otra fecha: cambia el filtro y lo abre cuando termine de cargar.
    if (fechaServicio) setFechaFiltro(fechaServicio);
    setPendienteReserva(reservaId);
  }, [servicios]);

  // Cuando cargan los servicios de la fecha destino, abre el pendiente.
  useEffect(() => {
    if (pendienteReserva == null) return;
    const encontrado = servicios.find(s => s.reserva.id === pendienteReserva);
    if (encontrado) { setDrawer(encontrado); setPendienteReserva(null); }
  }, [servicios, pendienteReserva]);

  const totalFijos      = servicios.filter(s=>!s.es_eventual).length;
  const totalEventuales = servicios.filter(s=>s.es_eventual).length;
  const enRuta          = servicios.filter(s=>s.estado_visual==="en_ruta").length;
  // Conteo por nivel del semáforo. Se prefiere el del servidor (mismo cálculo que los
  // avisos); si aún no llegó, se deriva de lo que ya está pintado.
  const contarNivel = (n: NivelRetraso) =>
    resumenActivo && n in resumenActivo ? (resumenActivo as any)[n] as number
                                    : servicios.filter(s=>s.puntualidad?.nivel===n).length;
  const NIVELES_PANEL: NivelRetraso[] = ["retraso","no_realizado","riesgo","retraso_en_ruta","en_punto_sin_iniciar","sin_rastreo","inicio_tarde"];
  const panelNiveles = NIVELES_PANEL.map(n=>({ nivel:n, n:contarNivel(n) })).filter(x=>x.n>0);
  // El KPI rojo cuenta SOLO lo accionable ahora. Un servicio que ya no se hizo ("no
  // realizado") sigue visible en el semáforo y en la lista, pero no puede tener el
  // contador en rojo hasta medianoche: eso es lo que hacía ilegible el tablero.
  const retrasoAhora = resumenActivo ? resumenActivo.retraso
                                   : servicios.filter(s=>s.estado_visual==="alerta").length;
  // Contaba `!checkin_realizado`, o sea 783 de 784 servicios: un KPI que siempre gritaba dejó
  // de significar nada. Ahora cuenta los que de verdad no tienen hora de salida derivable —
  // y solo los que YA DEBERÍAN haber salido: sin la guarda de fecha y hora volvía a ser un
  // número que grita, porque al mirar la parrilla de mañana contaba los 40 servicios del día
  // entero, y hoy a las 09:00 contaba también los de las 22:00. Un servicio que aún no sale no
  // tiene por qué tener hora de salida.
  const sinHoraSalida   = !esHoy ? 0 : servicios.filter(s =>
    !s.salida && s.estado_visual !== "finalizado" && s.estado_visual !== "cancelado"
    && s.reserva.fecha_servicio === hoyISO()
    && (aMin(s.reserva.hora_servicio) ?? Infinity) <= ahoraLimaMin()
  ).length;
  const seguroHoy       = servicios.filter(s=>s.seguro_vence_hoy).length;
  const docsVenc        = servicios.filter(s=>s.docs_vencidos.length>0).length;
  const conflictos      = servicios.filter(s=>s.conflicto_vehiculo||s.conflicto_conductor).length;
  const fatigaCount     = servicios.filter(s=>s.jornada_extensa).length;

  // ModalGps redibuja la ruta con Google Directions cada vez que cambia la IDENTIDAD del array
  // `paradas`. Como esta página se re-renderiza en cada evento realtime de reservas/paradas,
  // un .map() inline facturaba una llamada por render. Firma primitiva + useMemo: la identidad
  // solo cambia si cambian de verdad las paradas del servicio abierto.
  const firmaParadasGps = (gpsModal?.paradas ?? [])
    .map(p=>`${p.id}:${p.orden}:${p.lat ?? ""}:${p.lng ?? ""}:${p.estado}:${p.hora_estimada ?? ""}:${p.nombre}`)
    .join("|");
  const paradasGps = useMemo(()=>(gpsModal?.paradas ?? []).map(p=>({
    id: p.id, nombre: p.nombre,
    lat: p.lat ?? null, lng: p.lng ?? null,
    hora_estimada: p.hora_estimada ?? null,
    estado: p.estado, orden: p.orden,
  })),[firmaParadasGps]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtrados = servicios.filter(s=>{
    if (filtroTipo==="fijo"&&s.es_eventual) return false;
    if (filtroTipo==="eventual"&&!s.es_eventual) return false;
    if (filtroEstado!=="todos"&&s.estado_visual!==filtroEstado) return false;
    if (filtroNivel!=="todos"&&s.puntualidad?.nivel!==filtroNivel) return false;
    if (busqueda) {
      const q=busqueda.toLowerCase();
      return s.vehiculo_placa.toLowerCase().includes(q)||s.conductor_nombre.toLowerCase().includes(q)||s.cliente_nombre.toLowerCase().includes(q);
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-[#eef3f8]">
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">

        {/* ── ENCABEZADO ── */}
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-black text-[#0b315f] leading-none">Seguimiento Operativo</h1>
            <p className="text-sm text-gray-400 mt-1 font-medium">
              {new Date(fechaFiltro+"T00:00:00").toLocaleDateString("es-PE",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input type="date" value={fechaFiltro} onChange={e=>setFechaFiltro(e.target.value)}
              className="border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold text-[#0b315f] outline-none focus:border-[#0b315f]" />
            <button onClick={cargar} className="w-10 h-10 rounded-xl bg-white border border-gray-200 hover:border-[#0b315f] flex items-center justify-center transition-colors" title="Refrescar">
              <Ic.Refresh size={15} color="#0b315f"/>
            </button>
            {/* ── MENSAJES PASAJEROS ── */}
            <PanelMensajesPasajeros onIrAServicio={irAServicio} />
            {/* ── DESCARGA MASIVA DE DOCUMENTOS ── */}
            <button onClick={()=>setDescargaMasiva(true)}
              className="flex items-center gap-2 bg-white border border-gray-200 hover:border-[#0b315f] text-[#0b315f] px-4 py-2.5 rounded-xl text-sm font-bold transition-colors shadow-sm"
              title="Descargar Manifiestos MTC y Reportes en bloque, agrupados por ruta">
              <Ic.FileText size={15} color="#0b315f"/> Descarga masiva
            </button>
            {/* ── MAPA GLOBAL ── */}
            <Link href="/monitoreo" className="flex items-center gap-2 bg-[#0b315f] text-white px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-[#1262bd] transition-colors shadow-sm">
              <Ic.Map size={15} color="white"/> Ver Mapa Global <Ic.ExternalLink size={13} color="white"/>
            </Link>
          </div>
        </div>

        {/* ── KPIs ── */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label:"Fijos del día",      value:totalFijos,      color:"#0b315f",bg:"#EFF6FF",icon:<Ic.Bus size={16} color="#0b315f"/>    },
            { label:"Eventuales",         value:totalEventuales, color:"#6366f1",bg:"#EEF2FF",icon:<Ic.List size={16} color="#6366f1"/>   },
            { label:"En ruta ahora",      value:enRuta,          color:"#16a34a",bg:"#DCFCE7",icon:<Ic.Check size={16} color="#16a34a"/>  },
            // Solo alertas VIVAS: un servicio finalizado ya no "está en retraso", su
            // retraso es un dato histórico. Antes el contador quedaba en rojo hasta
            // medianoche y el tablero dejaba de leerse.
            { label:"Retraso ahora",      value:retrasoAhora,    color:"#dc2626",bg:"#FEF2F2",icon:<Ic.Alert size={16} color="#dc2626"/>  },
            { label:"Sin hora de salida", value:sinHoraSalida,   color:"#d97706",bg:"#FEF3C7",icon:<Ic.Clock size={16} color="#d97706"/>  },
            { label:"Seguros vencen hoy", value:seguroHoy,       color:"#dc2626",bg:"#FEF2F2",icon:<Ic.Shield size={16} color="#dc2626"/>},
          ].map(kpi=>(
            <div key={kpi.label} className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{background:kpi.bg}}>{kpi.icon}</div>
              </div>
              <div className="font-black text-2xl leading-none" style={{color:kpi.color}}>{kpi.value}</div>
              <div className="text-[11px] text-gray-400 font-semibold mt-1 leading-tight">{kpi.label}</div>
            </div>
          ))}
        </div>

        {/* ── SEMÁFORO DE PUNTUALIDAD ──
            Sustituye al banner rojo binario ("X no iniciaron a la hora"), que mezclaba
            en un solo número al bus atrapado en la Panamericana y al que ya está en el
            paradero con el conductor embarcando. Cada nivel es un botón: filtra la lista.
            Ver lib/retrasos.ts para el criterio de cada uno. */}
        {esHoy && panelNiveles.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-2xl px-5 py-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 rounded-lg bg-[#EFF6FF] flex items-center justify-center"><Ic.Clock size={15} color="#0b315f"/></div>
              <p className="font-black text-[#0b315f] text-sm">Puntualidad</p>
              {filtroNivel !== "todos" && (
                <button onClick={()=>setFiltroNivel("todos")} className="text-[10px] font-bold text-gray-400 hover:text-[#0b315f] underline">quitar filtro</button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {panelNiveles.map(({nivel,n})=>{
                const meta = NIVEL_RETRASO[nivel];
                const activo = filtroNivel === nivel;
                return (
                  <button key={nivel} onClick={()=>setFiltroNivel(activo?"todos":nivel)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-xl border transition-all ${activo?"ring-2 ring-offset-1":""}`}
                    style={{ background: meta.bg, borderColor: `${meta.color}33`, ...(activo?{ boxShadow:`0 0 0 2px ${meta.color}` }:{}) }}>
                    <span className="font-black text-lg leading-none" style={{color:meta.color}}>{n}</span>
                    <span className="text-[11px] font-bold" style={{color:meta.color}}>{meta.label}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-gray-400 mt-3 leading-snug">
              <b className="text-[#1d4ed8]">En el punto</b> = el GPS ubica el bus en el paradero: no es un retraso, falta que el conductor pulse Iniciar.
              {" "}<b className="text-slate-600">Sin rastreo</b> = no hay señal para opinar — nunca se afirma un retraso por falta de GPS.
              {" "}<b className="text-amber-700">Riesgo</b> es una previsión con el tráfico de ahora, todavía se puede reaccionar.
            </p>
          </div>
        )}

        {(conflictos > 0 || fatigaCount > 0 || docsVenc > 0) && (
          <div className="bg-amber-50 border border-amber-200 rounded-2xl px-5 py-3.5 flex items-start gap-3">
            <div className="w-8 h-8 rounded-xl bg-amber-100 flex items-center justify-center flex-shrink-0"><Ic.Shield size={16} color="#b45309"/></div>
            <div className="text-sm">
              <p className="font-black text-amber-800">Riesgos de flota detectados</p>
              <p className="text-amber-700 text-xs mt-0.5">
                {[
                  docsVenc>0    ? `${docsVenc} con documentos vencidos`            : null,
                  conflictos>0  ? `${conflictos} con posible solape de unidad/conductor` : null,
                  fatigaCount>0 ? `${fatigaCount} con jornada extensa del conductor`     : null,
                ].filter(Boolean).join("  ·  ")}
              </p>
              <p className="text-amber-600/80 text-[11px] mt-1">Documentos vencidos bloquean la salida. El solape y la jornada son estimaciones (no hay duración registrada en la reserva): verifícalos en cada servicio marcado.</p>
            </div>
          </div>
        )}

        {/* ── FILTROS ── */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1">
              <Ic.Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none"/>
              <input className="w-full pl-9 pr-4 py-2.5 border border-gray-200 rounded-xl text-sm outline-none focus:border-[#0b315f] transition-colors"
                placeholder="Buscar por placa, conductor o cliente..." value={busqueda} onChange={e=>setBusqueda(e.target.value)}/>
            </div>
            <div className="flex gap-1 bg-gray-50 rounded-xl p-1">
              {(["todos","fijo","eventual"] as const).map(t=>(
                <button key={t} onClick={()=>setFiltroTipo(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${filtroTipo===t?"bg-white shadow-sm text-[#0b315f]":"text-gray-400 hover:text-gray-600"}`}>
                  {t==="todos"?"Todos":t==="fijo"?"Fijos":"Eventuales"}
                </button>
              ))}
            </div>
            <div className="flex gap-1 bg-gray-50 rounded-xl p-1">
              {(["todos","programado","en_ruta","alerta","finalizado"] as const).map(e=>(
                <button key={e} onClick={()=>setFiltroEstado(e)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all whitespace-nowrap ${filtroEstado===e?"bg-white shadow-sm text-[#0b315f]":"text-gray-400 hover:text-gray-600"}`}>
                  {e==="todos"?"Todos":ESTADO_VIS[e as EstadoVisual]?.label??e}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── CONTENIDO ── */}
        {loading ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-12 text-center">
            <div className="w-8 h-8 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin mx-auto mb-3"/>
            <p className="font-bold text-gray-500 text-sm">Cargando servicios...</p>
          </div>
        ) : filtrados.length === 0 ? (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-12 text-center">
            <p className="text-4xl mb-3">🔍</p>
            <p className="font-bold text-gray-600">Sin servicios para los filtros seleccionados</p>
            <p className="text-sm text-gray-400 mt-1">
              {reservas.length===0
                ? <>No hay reservas para el {new Date(fechaFiltro+"T00:00:00").toLocaleDateString("es-PE")}. Programa servicios desde <Link href="/programacion" className="text-[#0b315f] font-bold underline">Programación</Link>.</>
                : "Intenta cambiar el tipo, estado o búsqueda."}
            </p>
          </div>
        ) : (
          <section>
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-[#EFF6FF] flex items-center justify-center"><Ic.List size={16} color="#0b315f"/></div>
                  <div>
                    <h2 className="font-black text-[#0b315f] text-sm leading-none">Servicios del día</h2>
                    <p className="text-[11px] text-gray-400 mt-1">Toca un servicio para ver el detalle: GPS, manifiesto, gastos, checklist y reemplazo</p>
                  </div>
                </div>
                <span className="text-xs text-gray-400 font-semibold">{filtrados.length} de {servicios.length}</span>
              </div>
              <div className="divide-y divide-gray-50">
                {[...filtrados].sort((a,b)=>(a.reserva.hora_servicio||"").localeCompare(b.reserva.hora_servicio||"")).map(s=>(
                  <FilaServicio key={s.reserva.id} s={s} onOpen={()=>setDrawer(s)} onGps={()=>setGpsModal(s)} />
                ))}
              </div>
            </div>
          </section>
        )}
      </div>

      {/* ── MODAL GPS ── */}
      {gpsModal && (
        <ModalGps
          reservaId={gpsModal.reserva.id}
          vehiculoId={gpsModal.reserva.vehiculo_id ?? null}
          vehiculoTerceroId={gpsModal.reserva.vehiculo_tercero_id ?? null}
          vehiculoPlaca={gpsModal.vehiculo_placa}
          conductorNombre={gpsModal.conductor_nombre}
          conductorTel={gpsModal.conductor_tel}
          clienteNombre={gpsModal.cliente_nombre}
          origen={gpsModal.paradas[0]?.nombre ?? gpsModal.reserva.origen ?? null}
          destino={(gpsModal.paradas.length > 1 ? gpsModal.paradas[gpsModal.paradas.length - 1].nombre : null) ?? gpsModal.reserva.destino ?? null}
          paradas={paradasGps}
          onClose={() => setGpsModal(null)}
        />
      )}

      {/* ── DRAWER: FICHA DEL SERVICIO ── */}
      {drawer && (
        // La ficha nueva deriva el horario real y el estado documental (lib/servicio-tiempos.ts,
        // lib/documentos-estado.ts) en vez de pedirlos tecleados, y desde que los modales viven en
        // components/seguimiento/ModalesServicio.tsx tambien absorbio gastos, checklist, reemplazo
        // y telefono. Ya no viaja ninguna tarjeta clasica como `children`: la deuda esta saldada.
        <FichaServicioNueva s={drawer} onClose={() => setDrawer(null)} onRefresh={cargar} onGps={setGpsModal} empresaPerfil={empresaPerfil} />
      )}

      {/* ── MODAL: DESCARGA MASIVA POR RUTA ── */}
      {descargaMasiva && (
        <DescargaMasivaModal fechaInicial={fechaFiltro} onClose={() => setDescargaMasiva(false)} />
      )}
    </div>
  );
}