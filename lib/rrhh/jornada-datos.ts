// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/jornada-datos.ts — LECTOR (service-role): marcas por rango para DERIVAR jornadas.
//
// El motor `calcularJornada` (puro) juzga UN día a la vez. Este lector trae las marcas de un
// rango y las agrupa por día de Lima para alimentar un cálculo por día — ese agrupamiento es
// la única lógica que vive aquí, y se hace con `fechaLima` (el día de Lima del instante), la
// misma fuente única que usa la marcación. El JUICIO (horas, tardanza) sigue siendo del motor.
//
// `usuarioId` opcional: con él, un empleado ve lo suyo; sin él, RRHH deriva las jornadas de
// toda la empresa en un rango (la RLS de SELECT de rrhh_marca ya separa quién ve qué cuando
// esto corriera con la anon key; aquí corre con service-role tras verificar el permiso `rrhh`).
//
// Paginado con ORDEN TOTAL (marcado_en + id): PostgREST corta en 1000 filas y un rango de un
// mes de toda la flota las pasa; cortar sin orden total perdería o repetiría marcas.
// ──────────────────────────────────────────────────────────────────────────────

import { fechaLima, limaAUtcMs } from "@/lib/alertas-horario";
import { tablaFaltante } from "@/lib/columna-faltante";
import { cfgsEfectivasDe } from "./horario-datos";
import { calcularJornada } from "./jornada";
import type { ConfigRrhh, Marca, ResultadoJornada } from "./tipos";

type SB = { from: (t: string) => any };

const PAGINA = 1000;

export type MarcaConUsuario = Marca & { id?: number | string; usuario_id: string };

/** Las marcas de un rango de días de Lima [desde, hasta] (inclusive), opcionalmente de un
 *  usuario. Devuelve las filas crudas; agrupar y juzgar es de `jornadasDelRango`/el motor. */
export async function marcasPorRango(
  sb: SB,
  opts: { usuarioId?: string | null; desde: string; hasta: string },
): Promise<{ marcas: MarcaConUsuario[]; sinMigracion: boolean }> {
  const inicio = limaAUtcMs(opts.desde, "00:00") ?? Date.parse(`${opts.desde}T05:00:00Z`);
  const finExcl = (limaAUtcMs(opts.hasta, "00:00") ?? Date.parse(`${opts.hasta}T05:00:00Z`)) + 86_400_000;
  const desdeISO = new Date(inicio).toISOString();
  const hastaISO = new Date(finExcl).toISOString();

  const out: MarcaConUsuario[] = [];
  for (let offset = 0; ; offset += PAGINA) {
    let q = sb
      .from("rrhh_marca")
      .select("*")
      .gte("marcado_en", desdeISO)
      .lt("marcado_en", hastaISO)
      .order("marcado_en", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGINA - 1);
    if (opts.usuarioId) q = q.eq("usuario_id", opts.usuarioId);
    const { data, error } = await q;
    if (error) {
      if (tablaFaltante(error, "rrhh_marca")) return { marcas: [], sinMigracion: true };
      throw error; // una lectura fallida no es "no hubo marcas"
    }
    const filas = (data ?? []) as MarcaConUsuario[];
    out.push(...filas);
    if (filas.length < PAGINA) break;
  }
  return { marcas: out, sinMigracion: false };
}

export type JornadaDeDia = ResultadoJornada & { usuario_id: string; fecha: string };

/**
 * Horario POR EMPLEADO, OPCIONAL. Sin este parámetro, cada jornada se juzga con el `cfg`
 * global —byte a byte el comportamiento anterior—. Dos formas de activarlo:
 *   · `cfgPorUsuario`: un Map<usuario_id, ConfigRrhh> ya resuelto (p. ej. con `cfgsEfectivasDe`).
 *     Un usuario presente en el Map usa SU cfg; uno ausente cae al global.
 *   · `porEmpleado: true` (y sin `cfgPorUsuario`): el lector resuelve los overrides él mismo,
 *     leyendo `empleado_perfil` con `cfgsEfectivasDe` para los usuarios del rango. Sin la
 *     migración rrhh-04, esa resolución cae al global para todos (misma salida que hoy).
 * El Map pre-resuelto GANA sobre `porEmpleado`: si lo pasan, no se vuelve a leer la base.
 */
export type OpcionesHorarioJornada = {
  cfgPorUsuario?: Map<string, ConfigRrhh> | null;
  porEmpleado?: boolean;
};

/** Agrupa las marcas del rango por (usuario, día de Lima) y calcula la jornada de cada uno.
 *  Con `horario`, cada empleado se juzga con SU horario efectivo (ver `OpcionesHorarioJornada`);
 *  sin él, todos contra el `cfg` global, exactamente como antes. */
export async function jornadasDelRango(
  sb: SB,
  opts: { usuarioId?: string | null; desde: string; hasta: string },
  cfg: ConfigRrhh,
  horario?: OpcionesHorarioJornada,
): Promise<{ jornadas: JornadaDeDia[]; sinMigracion: boolean }> {
  const { marcas, sinMigracion } = await marcasPorRango(sb, opts);
  if (sinMigracion) return { jornadas: [], sinMigracion: true };

  const porClave = new Map<string, { usuario_id: string; fecha: string; marcas: Marca[] }>();
  for (const m of marcas) {
    const t = Date.parse(String(m.marcado_en));
    if (!Number.isFinite(t)) continue;
    const fecha = fechaLima(t);
    const clave = `${m.usuario_id}|${fecha}`;
    const g = porClave.get(clave) ?? { usuario_id: m.usuario_id, fecha, marcas: [] };
    g.marcas.push(m);
    porClave.set(clave, g);
  }

  // El cfg POR USUARIO. Sin `horario` → null → cada jornada usa `cfg` (global): byte a byte lo
  // de antes. El Map pre-resuelto manda; si no vino y piden `porEmpleado`, se lee la base para
  // los usuarios que de verdad aparecen en el rango (no para toda la empresa).
  let cfgPorUsuario = horario?.cfgPorUsuario ?? null;
  if (!cfgPorUsuario && horario?.porEmpleado) {
    const usuarios = [...new Set([...porClave.values()].map((g) => g.usuario_id))];
    cfgPorUsuario = await cfgsEfectivasDe(sb, usuarios, cfg);
  }

  const jornadas: JornadaDeDia[] = [];
  for (const g of porClave.values()) {
    const cfgEf = cfgPorUsuario?.get(g.usuario_id) ?? cfg;
    jornadas.push({ usuario_id: g.usuario_id, fecha: g.fecha, ...calcularJornada(g.marcas, cfgEf) });
  }
  jornadas.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.usuario_id < b.usuario_id ? -1 : 1));
  return { jornadas, sinMigracion: false };
}
