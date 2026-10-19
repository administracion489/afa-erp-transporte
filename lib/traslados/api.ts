// ──────────────────────────────────────────────────────────────────────────────
// lib/traslados/api.ts — El contrato de POST /api/traslados/simular, compartido por la pantalla
// (/tarifario → Zonas y traslados → Simulador) y el servidor. Motor PURO.
//
// La misma entrada la usará la herramienta del agente IA del CRM: el simulador no es una
// imitación del cotizador automático, ES el cotizador automático sin enviar nada.
// ──────────────────────────────────────────────────────────────────────────────

import { SENALES, type PuntoUbicado, type ResultadoTraslado, type SenalComplejidad, type Sentido } from "./motor";

/** Un punto: el texto que escribió el cliente, o coordenadas (un pin del mapa o de WhatsApp). */
export type LugarEntrada = string | { lat: number; lng: number; texto?: string };

export type EntradaSimulador = {
  origen: LugarEntrada;
  destino: LugarEntrada;
  fecha_servicio: string | null;
  hora_servicio?: string | null;
  sentido: Sentido | null;
  fecha_retorno?: string | null;
  hora_retorno?: string | null;
  pax: number | null;
  maletas: number | null;
  telefono: string | null;
  paradas_intermedias?: number | null;
  fechas_adicionales?: number | null;
  vehiculos_pedidos?: number | null;
  senales?: SenalComplejidad[] | null;
};

export type CodigoUbicar = "ok" | "no_encontrado" | "sin_clave" | "error" | "vacio";

export type LugarUbicado = { codigo: CodigoUbicar; detalle: string; punto: PuntoUbicado | null };

export type RespuestaSimulador =
  | { ok: true; resultado: ResultadoTraslado; lugares: { origen: LugarUbicado; destino: LugarUbicado } }
  | { ok: false; codigo: "sin_migracion" | "entrada_invalida" | "error"; detalle: string };

const MAX_TEXTO = 300;

/** Valida y limpia la entrada. Devuelve el motivo si no sirve. Las ausencias no son error: el motor las pregunta. */
export function validarEntrada(x: unknown): { ok: true; entrada: EntradaSimulador } | { ok: false; detalle: string } {
  if (!x || typeof x !== "object") return { ok: false, detalle: "Falta el pedido." };
  const o = x as Record<string, unknown>;
  const lugar = (v: unknown, nombre: string): LugarEntrada | { error: string } => {
    if (typeof v === "string") return v.trim().slice(0, MAX_TEXTO);
    if (v && typeof v === "object") {
      const p = v as Record<string, unknown>;
      const lat = Number(p.lat), lng = Number(p.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { error: `Coordenadas inválidas en ${nombre}.` };
      return { lat, lng, texto: typeof p.texto === "string" ? p.texto.slice(0, MAX_TEXTO) : undefined };
    }
    return "";
  };
  const origen = lugar(o.origen, "el origen");
  const destino = lugar(o.destino, "el destino");
  if (typeof origen === "object" && "error" in origen) return { ok: false, detalle: origen.error };
  if (typeof destino === "object" && "error" in destino) return { ok: false, detalle: destino.error };
  const fecha = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const hora = (v: unknown) => (typeof v === "string" && /^\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : null);
  const num = (v: unknown, max: number) => {
    if (v == null || v === "") return null;
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
  };
  const sentido = o.sentido === "ida" || o.sentido === "ida_retorno" ? o.sentido : null;
  const senales = Array.isArray(o.senales)
    ? [...new Set(o.senales.filter((s): s is SenalComplejidad => typeof s === "string" && s in SENALES))]
    : [];
  return {
    ok: true,
    entrada: {
      origen: origen as LugarEntrada, destino: destino as LugarEntrada,
      fecha_servicio: fecha(o.fecha_servicio), hora_servicio: hora(o.hora_servicio),
      sentido, fecha_retorno: fecha(o.fecha_retorno), hora_retorno: hora(o.hora_retorno),
      pax: num(o.pax, 500), maletas: num(o.maletas, 1000),
      telefono: typeof o.telefono === "string" ? o.telefono.trim().slice(0, 40) : null,
      paradas_intermedias: num(o.paradas_intermedias, 50), fechas_adicionales: num(o.fechas_adicionales, 365),
      vehiculos_pedidos: num(o.vehiculos_pedidos, 50), senales,
    },
  };
}
