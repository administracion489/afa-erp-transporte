// ──────────────────────────────────────────────────────────────────────────────
// lib/paradas-hora-datos.ts — el lado que LEE Y ESCRIBE lo que decide el motor puro
// (lib/paradas-hora.ts). Aquí no hay ninguna regla: solo trae las dos caras del
// itinerario de cada servicio, le pregunta al motor y escribe lo que conteste.
//
// Lo usan los TRES caminos de /programacion que mueven la hora de un servicio —el
// editor inline de la fila, el formulario y el masivo del contrato—. Antes cada uno
// hacía lo suyo: el inline corría las filas de `paradas` a mano, y los otros dos no
// corrían nada. Tres respuestas para la misma pregunta es cómo una se queda atrás.
//
// SE ESCRIBE AGRUPANDO, no fila por fila. Los servicios de un contrato comparten el
// mismo horario (todas las idas salen 05:10) y la misma semilla, así que correr seis
// meses de un contrato son un puñado de UPDATE por hora distinta, no un UPDATE por
// paradero — que en 130 servicios × 5 paraderos serían 650 peticiones desde el
// navegador.
// ──────────────────────────────────────────────────────────────────────────────

import {
  planDeHoraParaderos, deltaHoras,
  type ParadaFila, type ParadaSemilla, type CodigoHoraParaderos,
} from "@/lib/paradas-hora";

export type ResultadoCorrida = {
  deltaMin: number;
  /** Servicios cuyo itinerario se movió (filas, semilla o las dos). */
  servicios: number;
  /** Filas de `paradas` reescritas. */
  filas: number;
  /** Servicios cuya semilla `paradas_json` se reescribió. */
  semillas: number;
  /** Paraderos ya recorridos que conservan su hora planificada. */
  congeladas: number;
  /** Servicios que no declaran paraderos propios: su itinerario cuelga de la cotización. */
  sinParaderos: number[];
  /** Servicios con paraderos pero sin ninguna hora escrita. */
  sinHoras: number[];
  /** Lo que no se pudo escribir. Se DICE: la hora del servicio ya quedó movida. */
  errores: string[];
};

const vacio = (deltaMin: number): ResultadoCorrida => ({
  deltaMin, servicios: 0, filas: 0, semillas: 0, congeladas: 0,
  sinParaderos: [], sinHoras: [], errores: [],
});

/** Lee en trozos y paginado: un `.in()` con 300 ids arma una URL que revienta, y sin
 *  paginar PostgREST corta en 1000 filas — un contrato largo perdería la cola. */
async function leerEnTrozos(
  sb: any, tabla: string, columnas: string, campo: string, ids: number[],
  orden: string[], trozo = 80,
): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += trozo) {
    const sub = ids.slice(i, i + trozo);
    if (!sub.length) continue;
    for (let d = 0; d < 100000; d += 1000) {
      let q: any = sb.from(tabla).select(columnas).in(campo, sub);
      for (const c of orden) q = q.order(c);
      const { data, error } = await q.range(d, d + 999);
      if (error) throw new Error(String(error.message ?? error));
      out.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
  }
  return out;
}

/**
 * Corre los paraderos de N servicios por el mismo desplazamiento.
 *
 * `horaAntes`/`horaNueva` son las del SERVICIO, no las de un paradero: de ahí sale el
 * delta y todos los paraderos se mueven con él, conservando el espaciado que alguien
 * planificó. Se llama DESPUÉS de escribir la hora en `reservas`: si esa escritura
 * falla, el itinerario no se toca.
 */
export async function correrParaderosDeServicios(
  sb: any,
  ids: number[],
  horaAntes: string | null | undefined,
  horaNueva: string | null | undefined,
): Promise<ResultadoCorrida> {
  const delta = deltaHoras(horaAntes, horaNueva);
  if (!ids.length || delta === null || delta === 0) return vacio(delta ?? 0);

  const res = vacio(delta);
  let filasParadas: any[] = [];
  let semillas: any[] = [];
  try {
    [filasParadas, semillas] = await Promise.all([
      leerEnTrozos(sb, "paradas", "id,reserva_id,nombre,hora_estimada,estado,orden",
        "reserva_id", ids, ["reserva_id", "orden", "id"]),
      leerEnTrozos(sb, "reservas", "id,paradas_json", "id", ids, ["id"]),
    ]);
  } catch (e: any) {
    res.errores.push(`No se pudieron leer los paraderos: ${e?.message ?? e}`);
    return res;
  }

  const porReserva = new Map<number, ParadaFila[]>();
  for (const p of filasParadas) {
    const arr = porReserva.get(p.reserva_id) || [];
    arr.push({ id: p.id, nombre: p.nombre, hora_estimada: p.hora_estimada, estado: p.estado });
    porReserva.set(p.reserva_id, arr);
  }
  const semillaDe = new Map<number, ParadaSemilla[] | null>(
    semillas.map((r: any) => [r.id, Array.isArray(r.paradas_json) ? r.paradas_json : null]),
  );

  // Se agrupa lo que va a quedar escrito, no lo que se leyó: todas las filas que
  // terminan a la misma hora entran en un solo UPDATE, y todas las semillas que
  // quedan idénticas en otro.
  const porHora   = new Map<string, number[]>();
  const porSemilla = new Map<string, number[]>();

  for (const id of ids) {
    const plan = planDeHoraParaderos({
      horaAntes, horaNueva,
      filas: porReserva.get(id) || [],
      semilla: semillaDe.get(id) ?? null,
    });
    if (plan.codigo === "sin_paraderos") { res.sinParaderos.push(id); continue; }
    if (plan.codigo === "sin_horas")     { res.sinHoras.push(id); continue; }
    if (plan.codigo !== "corre") continue;

    res.servicios++;
    res.congeladas += plan.congeladas;
    for (const f of plan.filas) {
      const lote = porHora.get(f.a) || [];
      lote.push(f.id);
      porHora.set(f.a, lote);
    }
    if (plan.semilla) {
      const clave = JSON.stringify(plan.semilla);
      const lote = porSemilla.get(clave) || [];
      lote.push(id);
      porSemilla.set(clave, lote);
    }
  }

  const escribir = async (
    tabla: string, patch: Record<string, any>, ids: number[], queEs: string,
  ) => {
    for (let i = 0; i < ids.length; i += 150) {
      const lote = ids.slice(i, i + 150);
      const { error } = await sb.from(tabla).update(patch).in("id", lote);
      if (error) res.errores.push(`${queEs}: ${String(error.message ?? error)}`);
      else if (tabla === "paradas") res.filas += lote.length;
      else res.semillas += lote.length;
    }
  };

  for (const [hora, filaIds] of porHora)
    await escribir("paradas", { hora_estimada: hora }, filaIds, `paraderos de las ${hora}`);
  for (const [clave, reservaIds] of porSemilla)
    await escribir("reservas", { paradas_json: JSON.parse(clave) }, reservaIds,
      "itinerario guardado del servicio");

  return res;
}

/**
 * Frase para el toast/aviso. `null` cuando no hay nada que contarle al operador.
 *
 * `soloProblemas` es para el editor inline de la fila: ahí el modal ya enseñó paradero
 * por paradero el "de → a" antes de confirmar, así que repetirlo en un toast es ruido
 * — y un aviso que sale siempre se vuelve paisaje. Lo que ese modal NO pudo anticipar
 * es que una escritura falle, y eso sí hay que decirlo.
 */
export function resumirCorrida(
  r: ResultadoCorrida, { soloProblemas = false }: { soloProblemas?: boolean } = {},
): string | null {
  if (soloProblemas)
    return r.errores.length
      ? `⚠️ La hora del servicio SÍ se guardó, pero algunos paraderos no: `
        + r.errores.slice(0, 3).join(" · ")
      : null;
  const partes: string[] = [];
  if (r.filas > 0 || r.semillas > 0) {
    const n = Math.max(r.servicios, 1);
    partes.push(`Se corrieron los paraderos de ${n} servicio(s)`
      + (r.filas > 0 ? ` (${r.filas} paradero(s))` : "") + ".");
  }
  if (r.congeladas > 0)
    partes.push(`${r.congeladas} paradero(s) ya recorrido(s) conservan su hora planificada.`);
  // Estos dos NO son un fallo, son un dato que el operador necesita: su hora sigue
  // saliendo de la cotización, así que la pantalla no puede callarlo y dejarlo creer
  // que el itinerario entero se movió.
  if (r.sinParaderos.length > 0)
    partes.push(`${r.sinParaderos.length} servicio(s) no tienen paraderos propios: `
      + `su itinerario sale de la cotización y hay que propagarlo desde ahí.`);
  if (r.sinHoras.length > 0)
    partes.push(`${r.sinHoras.length} servicio(s) tienen paraderos sin hora escrita.`);
  if (r.errores.length > 0)
    partes.push(`⚠️ La hora del servicio SÍ se guardó, pero algunos paraderos no: `
      + r.errores.slice(0, 3).join(" · "));
  return partes.length ? partes.join(" ") : null;
}

export type { CodigoHoraParaderos };
