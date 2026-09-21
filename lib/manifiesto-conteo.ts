// ══════════════════════════════════════════════════════════════════════════════
// lib/manifiesto-conteo.ts
// CUÁNTA GENTE SUBIÓ A ESTE SERVICIO — una sola definición, dos consumidores.
//
// La cuenta vivía dentro de `historial_stats` en app/api/cliente/route.ts. Cuando
// el reporte semanal necesitó el mismo número, copiarla habría dejado al PORTAL y
// al CORREO contestando por separado la misma pregunta sobre el mismo servicio —
// y el día que una de las dos se quedara atrás, el cliente vería un número en su
// pantalla y otro en el correo del sábado. Es el bug del semáforo de puntualidad,
// con el agravante de que aquí el desacuerdo se le manda al cliente por escrito.
//
// LAS DOS REGLAS QUE NO SE PUEDEN AFLOJAR
//
// · `esAbordado` (lib/documentos-servicio.ts) es la definición de abordaje en TODO
//   el ERP: `pasajeros_parada.estado_abordaje`/`estado`. `boarding_log` llegó
//   después y está sin backfill, así que no sirve para contar servicios históricos.
//
// · `esperados` = 0 significa QUE NADIE LLENÓ EL MANIFIESTO, no que no viajó
//   nadie. Quien consuma este módulo tiene que distinguir los dos: contar el cero
//   como medición es lo que hundiría el pico de un bus lleno.
//
// El roster es la UNIÓN de dos fuentes, deduplicada por `pasajero_id`:
//   (a) `pasajeros_parada` → `paradas.reserva_id`   (el manifiesto normal)
//   (b) `pasajeros.reserva_id`                       (las fichas ad-hoc del servicio)
// ══════════════════════════════════════════════════════════════════════════════

import { esAbordado } from "@/lib/documentos-servicio";

export type ConteoServicio = {
  /** Personas que de verdad subieron. */
  embarcados: number;
  /** Personas en el manifiesto. 0 = nadie lo llenó. */
  esperados: number;
};

// PostgREST manda el `.in()` en la query string: con miles de ids la URL revienta
// (HTTP 400 medido a partir de ~2500). Se trocea en lotes que caben siempre.
const LOTE_IN = 200;
const PAGINA = 1000;

function lotes<T>(xs: T[], n = LOTE_IN): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Sin `range`, PostgREST corta cualquier respuesta en 1000 filas — en silencio.
 * Un error se PROPAGA en vez de devolver una lista corta: un conteo a medias se
 * lee como «subió menos gente», que es peor que no publicar nada.
 */
async function paginar(build: (desde: number, hasta: number) => any): Promise<any[]> {
  const todo: any[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await build(desde, desde + PAGINA - 1);
    if (error) throw new Error(`conteo de manifiesto: ${error.message}`);
    const filas = (data as any[]) ?? [];
    todo.push(...filas);
    if (filas.length < PAGINA) return todo;
  }
}

/**
 * Embarcados y esperados de cada reserva. Las que no tengan ninguna fila salen con
 * `{0, 0}` — presentes en el mapa, para que quien lea pueda distinguir «servicio
 * sin manifiesto» de «servicio que no pedí».
 */
export async function contarPasajeros(
  db: any,
  reservaIds: number[],
): Promise<Map<number, ConteoServicio>> {
  const ids = [...new Set(reservaIds.filter((n) => Number.isFinite(n) && n > 0))];
  const out = new Map<number, ConteoServicio>();
  for (const id of ids) out.set(id, { embarcados: 0, esperados: 0 });
  if (!ids.length) return out;

  const [porParada, adHoc] = await Promise.all([
    Promise.all(lotes(ids).map((lote) =>
      paginar((d, h) => db.from("pasajeros_parada")
        .select("pasajero_id, estado, estado_abordaje, paradas!inner(reserva_id)")
        .in("paradas.reserva_id", lote).order("id").range(d, h)))),
    Promise.all(lotes(ids).map((lote) =>
      paginar((d, h) => db.from("pasajeros")
        .select("id, reserva_id").in("reserva_id", lote).order("id").range(d, h)))),
  ]);

  // Se dedupe por PERSONA, no por fila: alguien con dos paraderos asignados en el
  // mismo servicio es una persona, no dos.
  const enRoster = new Map<number, Set<number>>();
  const abordados = new Map<number, Set<number>>();
  for (const id of ids) { enRoster.set(id, new Set()); abordados.set(id, new Set()); }

  for (const p of adHoc.flat()) enRoster.get(Number(p.reserva_id))?.add(Number(p.id));
  for (const pp of porParada.flat()) {
    const rid = Number(pp.paradas?.reserva_id ?? 0);
    if (!rid) continue;
    enRoster.get(rid)?.add(Number(pp.pasajero_id));
    if (esAbordado(pp)) abordados.get(rid)?.add(Number(pp.pasajero_id));
  }

  for (const id of ids) {
    out.set(id, {
      embarcados: abordados.get(id)?.size ?? 0,
      esperados: enRoster.get(id)?.size ?? 0,
    });
  }
  return out;
}
