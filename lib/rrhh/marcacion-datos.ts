// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/marcacion-datos.ts — LECTOR (service-role) de la marcación: config de sede y
// marcas del día de un usuario. NO es puro (lee la base); el juicio lo hacen los motores
// de lib/rrhh/marcacion.ts y lib/rrhh/jornada.ts, a los que esto les entrega datos.
//
// La migración rrhh-01 el deploy no la corre: si falta la TABLA, se devuelve `sinMigracion`
// en vez de un 500 (el endpoint responde 422 y la pantalla lo dice). Se usa `select("*")` a
// propósito: una columna accesoria ausente no nombra nada en un SELECT con `*`, así que la
// lectura no se cae por una columna que todavía no está en el esquema.
//
// El DÍA es el de LIMA (UTC-5). El rango se arma con `limaAUtcMs` —el mismo desplazamiento
// único del ERP— para no reinventar la aritmética de husos (sería el bug del semáforo).
// ──────────────────────────────────────────────────────────────────────────────

import { fechaLima, limaAUtcMs } from "@/lib/alertas-horario";
import { tablaFaltante } from "@/lib/columna-faltante";
import type { ConfigRrhh, Marca } from "./tipos";

type SB = { from: (t: string) => any };

/** La fecha de hoy en Lima (YYYY-MM-DD). Nunca `new Date().toISOString()` para "hoy". */
export function hoyLimaFecha(): string {
  return fechaLima(Date.now());
}

/** El rango [inicio, fin) en instantes UTC ISO que cubre un día calendario de Lima. */
export function rangoDiaLima(fecha: string): { desde: string; hasta: string } {
  const inicio = limaAUtcMs(fecha, "00:00") ?? Date.parse(`${fecha}T05:00:00Z`);
  return {
    desde: new Date(inicio).toISOString(),
    hasta: new Date(inicio + 86_400_000).toISOString(),
  };
}

/** La config de sede/horario (fila única id=1) ya con la forma que esperan los motores.
 *  `cfg` es null si la fila no está (config sin sembrar); `sinMigracion` si falta la tabla. */
export async function cargarConfigRrhh(
  sb: SB,
): Promise<{ cfg: ConfigRrhh | null; sinMigracion: boolean }> {
  const { data, error } = await sb.from("rrhh_config").select("*").eq("id", 1).maybeSingle();
  if (error) {
    if (tablaFaltante(error, "rrhh_config")) return { cfg: null, sinMigracion: true };
    throw error; // una lectura que falla por OTRA cosa no es "sin config": aborta (no inventa sede)
  }
  if (!data) return { cfg: null, sinMigracion: false };
  const cfg: ConfigRrhh = {
    sede_lat: Number(data.sede_lat),
    sede_lng: Number(data.sede_lng),
    sede_radio_m: Number(data.sede_radio_m ?? 150),
    hora_entrada: String(data.hora_entrada ?? "08:00"),
    hora_salida: String(data.hora_salida ?? "18:00"),
    tolerancia_min: Number(data.tolerancia_min ?? 0),
    almuerzo_min: Number(data.almuerzo_min ?? 0),
    geocerca_bloquea: !!data.geocerca_bloquea,
  };
  return { cfg, sinMigracion: false };
}

/** Las marcas de un usuario en el día de Lima indicado (por defecto hoy), en orden. */
export async function marcasDeHoy(
  sb: SB,
  usuarioId: string,
  fecha?: string,
): Promise<{ marcas: Marca[]; sinMigracion: boolean }> {
  const dia = fecha || hoyLimaFecha();
  const { desde, hasta } = rangoDiaLima(dia);
  const { data, error } = await sb
    .from("rrhh_marca")
    .select("*")
    .eq("usuario_id", usuarioId)
    .gte("marcado_en", desde)
    .lt("marcado_en", hasta)
    .order("marcado_en", { ascending: true });
  if (error) {
    if (tablaFaltante(error, "rrhh_marca")) return { marcas: [], sinMigracion: true };
    throw error; // una lectura fallida NO es "sin marcas": el llamador no debe insertar de más
  }
  return { marcas: (data ?? []) as Marca[], sinMigracion: false };
}
