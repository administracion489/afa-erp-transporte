// ──────────────────────────────────────────────────────────────────────────────
// lib/reservas-autoseleccion.ts — Motor PURO: todo servicio NACE con «Permitir autoselección».
//
// EL CASO (06-10): los 8 pasajeros del retorno RUTA A 17:00 (reserva 29413) no pudieron ver su
// bus mientras lo esperaban. Los pasajeros ROTAN —no se sabe quién viaja cada día—, así que el
// manifiesto del retorno no se carga de antemano: cada pasajero elige su servicio en /pasajero
// («Elige tu ruta de hoy») y, si no, entra al escanear el QR al subir. Esa lista solo ofrece los
// servicios con `reservas.permite_autoseleccion = true`, y el retorno de la RUTA A había nacido en
// false: nada lo escribía al crear el servicio, así que tomaba el default de la columna. La RUTA B
// y la C sí salían porque alguien les había encendido la casilla a mano.
//
// LA REGLA (la pidió el dueño así): el servicio NACE marcado y solo queda desmarcado cuando un
// OPERADOR lo desmarca (ModalManifiesto en /programacion, ModalManifiestoPortal en el portal, o
// «Aplicar a rango»). Por eso el valor se ESCRIBE en cada camino que crea una reserva —no se deja
// al default de la columna, que el repo no declara en ningún SQL y el deploy no controla— y los
// lectores siguen exigiendo `true` explícito: tratar NULL como «sí» encendería de golpe filas
// viejas que nadie revisó.
//
// Los caminos que crean una reserva son cuatro (mapeados por búsqueda exhaustiva): el generador de
// programas (fijo y adicional), «Convertir a reserva» de /cotizaciones, el despachador y la
// aprobación de una reserva del agente IA del CRM. Ninguno copia una reserva existente, así que no
// hay un «false» de operador que se pueda heredar por accidente.
//
// La columna no está en ningún SQL del repo (se creó desde el panel): en una base que no la tenga,
// crear el servicio importa más que la casilla, así que se reintenta sin ella — y se suelta SOLO
// si el error la nombra (lib/columna-faltante.ts), nunca ante otro error.
// ──────────────────────────────────────────────────────────────────────────────

import { faltaColumna, type ErrorSupabase } from "@/lib/columna-faltante";

/** Con qué valor nace la casilla «Permitir autoselección» de un servicio nuevo. */
export const AUTOSELECCION_AL_NACER = true;

export const COLUMNA_AUTOSELECCION = "permite_autoseleccion";

/** La fila de un servicio nuevo, con la casilla encendida. No pisa un valor ya puesto. */
export function conAutoseleccionAlNacer<T extends Record<string, unknown>>(
  fila: T,
): T & { permite_autoseleccion: boolean } {
  if (typeof fila[COLUMNA_AUTOSELECCION] === "boolean") {
    return fila as T & { permite_autoseleccion: boolean };
  }
  return { ...fila, permite_autoseleccion: AUTOSELECCION_AL_NACER };
}

/** La misma fila sin la casilla (para reintentar en una base que no tiene la columna). */
export function sinAutoseleccion<T extends Record<string, unknown>>(fila: T): T {
  const copia = { ...fila };
  delete copia[COLUMNA_AUTOSELECCION];
  return copia;
}

/**
 * Lo que devuelve un insert de supabase-js. `data` va como `any` a propósito: el builder devuelve
 * una unión ({data, error: null} | {data: null, error}) sobre la que TypeScript no infiere la fila,
 * y quien llama ya trataba ese `data` como sin tipo (el cliente del navegador es `any`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ResultadoInsercion = { data: any; error: ErrorSupabase | null };

/**
 * Inserta un servicio nuevo con la casilla encendida. Si la base no tiene la columna (y SOLO
 * entonces), reintenta sin ella y lo declara en `sinColumna`, para que quien llama pueda decirlo.
 */
export async function insertarServicioNuevo<T extends Record<string, unknown>>(
  insertar: (fila: T & { permite_autoseleccion?: boolean }) => PromiseLike<ResultadoInsercion>,
  fila: T,
): Promise<ResultadoInsercion & { sinColumna: boolean }> {
  const primero = await insertar(conAutoseleccionAlNacer(fila));
  if (!primero.error || !faltaColumna(primero.error, COLUMNA_AUTOSELECCION)) {
    return { ...primero, sinColumna: false };
  }
  const segundo = await insertar(sinAutoseleccion(fila));
  return { ...segundo, sinColumna: true };
}

/**
 * ¿Se puede ofrecer este servicio en «Elige tu ruta de hoy»? Solo si tiene paraderos.
 *
 * Al nacer marcados, los servicios que todavía no tienen filas en `paradas` (un programa fijo las
 * materializa la primera vez que alguien abre el servicio; el despachador y el CRM no las crean)
 * entrarían a la lista como «0 paraderos»: el pasajero los elige y no tiene paradero que
 * confirmar. Peor: la lista agrupa por `hora|coordenadas`, y dos servicios sin paraderos a la misma
 * hora (RUTA A 17:00 y RUTA B 17:00) compartirían la clave `"17:00|"` y saldría uno solo — el
 * pasajero podía terminar viendo la ruta equivocada. Sin paraderos no hay nada que elegir.
 */
export function ofrecibleEnAutoseleccion(r: { paradas?: unknown[] | null }): boolean {
  return Array.isArray(r.paradas) && r.paradas.length > 0;
}
