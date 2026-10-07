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
// aprobación de una reserva del agente IA del CRM. Ninguno copia una reserva existente.
//
// LA HERENCIA (pedida por el dueño): el generador de programas FIJOS hereda el desmarcado del
// servicio anterior del mismo contrato y sentido — pero SOLO si lo desmarcó un OPERADOR. Desde
// ahora cada operador que desmarca deja la fecha en `autoseleccion_apagada_en`; un false SIN esa
// fecha viene del default viejo (es el de los retornos RUTA A del 06-10) y heredarlo reviviría el
// defecto en cada programa nuevo. Ver `herenciaAutoseleccion`.
//
// La columna no está en ningún SQL del repo (se creó desde el panel): en una base que no la tenga,
// crear el servicio importa más que la casilla, así que se reintenta sin ella — y se suelta SOLO
// si el error la nombra (lib/columna-faltante.ts), nunca ante otro error.
// ──────────────────────────────────────────────────────────────────────────────

import { faltaColumna, type ErrorSupabase } from "@/lib/columna-faltante";
import { normalizaEstado } from "@/lib/estados";

/** Con qué valor nace la casilla «Permitir autoselección» de un servicio nuevo. */
export const AUTOSELECCION_AL_NACER = true;

export const COLUMNA_AUTOSELECCION = "permite_autoseleccion" as const;

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
export function sinAutoseleccion<T extends Record<string, unknown>>(
  fila: T,
): Omit<T, typeof COLUMNA_AUTOSELECCION> {
  const copia: Record<string, unknown> = { ...fila };
  delete copia[COLUMNA_AUTOSELECCION];
  return copia as Omit<T, typeof COLUMNA_AUTOSELECCION>;
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
  insertar: (fila: Omit<T, typeof COLUMNA_AUTOSELECCION> & { permite_autoseleccion?: boolean }) => PromiseLike<ResultadoInsercion>,
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
 * Al nacer marcados, los servicios que todavía no tienen filas en `paradas` (las crea el cron de
 * la madrugada para los de HOY —app/api/paradas/materializar—, o quien abra el servicio; el
 * despachador y el CRM no tienen semilla y no las crean) entrarían a la lista como «0 paraderos»:
 * el pasajero los elige y no tiene paradero que
 * confirmar. Peor: la lista agrupa por `hora|coordenadas`, y dos servicios sin paraderos a la misma
 * hora (RUTA A 17:00 y RUTA B 17:00) compartirían la clave `"17:00|"` y saldría uno solo — el
 * pasajero podía terminar viendo la ruta equivocada. Sin paraderos no hay nada que elegir.
 */
export function ofrecibleEnAutoseleccion(r: { paradas?: unknown[] | null }): boolean {
  return Array.isArray(r.paradas) && r.paradas.length > 0;
}

// ── La decisión del OPERADOR, y su herencia ─────────────────────────────────

export const COLUMNA_APAGADA_EN = "autoseleccion_apagada_en" as const;

/** Lo que escribe un OPERADOR al tocar la casilla: desmarcar deja la fecha; marcar la borra. */
export function patchAutoseleccionDeOperador(permite: boolean, ahora: Date = new Date()) {
  return { permite_autoseleccion: permite, [COLUMNA_APAGADA_EN]: permite ? null : ahora.toISOString() };
}

/**
 * UPDATE con respaldo: si (y SOLO si) el error nombra la columna de la fecha —la migración no se
 * corrió—, reintenta sin ella. La casilla se guarda igual; lo que se pierde es la herencia, y se
 * declara en `sinRegistro` para que la pantalla pueda decirlo.
 */
export async function actualizarAutoseleccion(
  actualizar: (patch: Record<string, unknown>) => PromiseLike<{ error: ErrorSupabase | null }>,
  patch: Record<string, unknown>,
): Promise<{ error: ErrorSupabase | null; sinRegistro: boolean }> {
  const primero = await actualizar(patch);
  if (!primero.error || !(COLUMNA_APAGADA_EN in patch) || !faltaColumna(primero.error, COLUMNA_APAGADA_EN)) {
    return { error: primero.error ?? null, sinRegistro: false };
  }
  const resto: Record<string, unknown> = { ...patch };
  delete resto[COLUMNA_APAGADA_EN];
  const segundo = await actualizar(resto);
  return { error: segundo.error ?? null, sinRegistro: true };
}

/** Un servicio anterior del contrato, con el sentido ya resuelto por quien lee (sentidoDeReserva). */
export type FilaAnterior = {
  id: number;
  fecha_servicio: string;
  estado?: string | null;
  sentido: "IDA" | "RETORNO";
  permite_autoseleccion: boolean | null;
  autoseleccion_apagada_en: string | null;
  movil?: number | null;
  origen_contractual?: string | null;
};

/**
 * `sin_anterior` · `anterior_marcado`: no hay nada que heredar.
 * `anterior_sin_registro`: el anterior está desmarcado pero NO por un operador (default viejo) → nace marcado.
 * `anterior_mixto`: ese día unos móviles estaban desmarcados por un operador y otros no → nace marcado.
 * `anterior_incompleto`: sin móvil propio que mirar, ese día hubo MENOS servicios que los que se van a
 *   generar (un bus cancelado o ausente): no se sabe qué decidió el que falta → nace marcado.
 * `heredado`: un operador desmarcó todo lo que se juzga → nace DESMARCADO.
 */
export type CodigoHerencia =
  | "sin_anterior" | "anterior_marcado" | "anterior_sin_registro" | "anterior_mixto" | "anterior_incompleto" | "heredado";
export type Herencia = {
  codigo: CodigoHerencia;
  permite: boolean;
  apagadaEn: string | null;
  fuente: { fecha: string; ids: number[]; desmarcadas: number; total: number } | null;
};
export const NACE_MARCADO: Herencia = { codigo: "sin_anterior", permite: AUTOSELECCION_AL_NACER, apagadaEn: null, fuente: null };

export const desmarcadaPorOperador = (f: Pick<FilaAnterior, "permite_autoseleccion" | "autoseleccion_apagada_en">) =>
  f.permite_autoseleccion === false && !!f.autoseleccion_apagada_en;

/**
 * Con qué nace un servicio NUEVO del contrato en ese sentido. Se hereda el desmarcado solo si TODO lo
 * juzgado lo desmarcó un operador; ante la duda, nace marcado (el error caro es el otro: un servicio
 * desmarcado no sale en «Elige tu ruta de hoy» y sus pasajeros no ven el bus).
 *
 * Qué se juzga (nunca cancelados ni adicionales: un adicional desmarcado no apaga el contrato):
 *   - Móvil conocido y con historia propia → el ÚLTIMO día de ESE móvil, y solo sus filas.
 *   - Si no → el último día del contrato en ese sentido, y además ese día tiene que haber al menos
 *     `esperadas` servicios (los que se van a generar). Si un bus faltó o se canceló ese día, el
 *     desmarcado de otro bus no puede decidir por él: elegir el día entre TODOS los buses y juzgar
 *     solo a los que quedaron le contagiaba el desmarcado de un bus a todo el programa.
 */
export function herenciaAutoseleccion(
  anteriores: FilaAnterior[],
  sentido: "IDA" | "RETORNO",
  movil?: number | null,
  esperadas = 1,
): Herencia {
  const candidatas = anteriores.filter((f) =>
    f.sentido === sentido &&
    normalizaEstado(f.estado) !== "cancelada" &&
    String(f.origen_contractual ?? "contrato") !== "adicional" &&
    /^\d{4}-\d{2}-\d{2}/.test(String(f.fecha_servicio ?? "")));
  const propias = movil != null ? candidatas.filter((f) => f.movil === movil) : [];
  const base = propias.length ? propias : candidatas;
  if (!base.length) return NACE_MARCADO;
  const fecha = base.reduce((m, f) => (f.fecha_servicio > m ? f.fecha_servicio : m), "");
  const grupo = base.filter((f) => f.fecha_servicio === fecha);
  const desmarcadas = grupo.filter(desmarcadaPorOperador);
  const fuente = { fecha, ids: grupo.map((f) => f.id), desmarcadas: desmarcadas.length, total: grupo.length };
  if (desmarcadas.length === grupo.length) {
    if (!propias.length && grupo.length < Math.max(1, esperadas)) {
      return { codigo: "anterior_incompleto", permite: true, apagadaEn: null, fuente };
    }
    const apagadaEn = desmarcadas
      .map((f) => f.autoseleccion_apagada_en as string)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    return { codigo: "heredado", permite: false, apagadaEn, fuente };
  }
  if (desmarcadas.length) return { codigo: "anterior_mixto", permite: true, apagadaEn: null, fuente };
  return {
    codigo: grupo.some((f) => f.permite_autoseleccion === false) ? "anterior_sin_registro" : "anterior_marcado",
    permite: true, apagadaEn: null, fuente,
  };
}

/**
 * Los campos a poner DESPUÉS de los comunes (que ya llevan true). Vacío salvo al heredar: entonces
 * va false con la fecha de la decisión ORIGINAL, no la de hoy — así la cadena sigue mes a mes hasta
 * que un operador vuelva a marcarla, y un heredado se distingue (su fecha es anterior a su creación).
 */
export function camposDeHerencia(h: Herencia): Record<string, unknown> {
  return h.codigo === "heredado" ? { permite_autoseleccion: false, [COLUMNA_APAGADA_EN]: h.apagadaEn } : {};
}

/** dd/mm en Lima (UTC-5), aritmética fija para que la prueba sea determinista. */
function ddmm(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}`;
}
function ddmmhhmmLima(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const l = new Date(t - 5 * 3_600_000).toISOString();
  return `${l.slice(8, 10)}/${l.slice(5, 7)} ${l.slice(11, 16)}`;
}

/** El texto que el generador enseña ANTES de crear nada. Null cuando no hay nada que decir. */
export function avisoHerencia(h: Herencia, rotulo: string, n: number): string | null {
  const f = h.fuente;
  if (h.codigo === "heredado" && f) {
    return `⚠ ${rotulo}: ${n} servicio(s) nacerán con «Permitir autoselección» DESMARCADA. ` +
      `Un operador la desmarcó en el servicio anterior del contrato (#${f.ids.join(", #")} · ${ddmm(f.fecha)}, ` +
      `desmarcada el ${ddmmhhmmLima(h.apagadaEn ?? "")}). Los pasajeros que rotan NO los verán en «Elige tu ruta de hoy». ` +
      `Si ya no corresponde, márcala después en el Manifiesto de esos servicios.`;
  }
  if (h.codigo === "anterior_mixto" && f) {
    return `ℹ ${rotulo}: nacen MARCADOS. El ${ddmm(f.fecha)} los móviles del contrato no coincidían ` +
      `(${f.desmarcadas} desmarcado(s) por un operador, ${f.total - f.desmarcadas} marcado(s)).`;
  }
  if (h.codigo === "anterior_incompleto" && f) {
    return `ℹ ${rotulo}: nacen MARCADOS. El ${ddmm(f.fecha)} un operador desmarcó ${f.total} servicio(s) del contrato ` +
      `(#${f.ids.join(", #")}), pero ese día faltó o se canceló algún otro y no se sabe qué decidió para él.`;
  }
  if (h.codigo === "anterior_sin_registro" && f) {
    return `ℹ ${rotulo}: nacen MARCADOS aunque el servicio anterior (#${f.ids.join(", #")} · ${ddmm(f.fecha)}) está ` +
      `desmarcado: no hay registro de que lo desmarcara un operador (viene del valor por defecto anterior).`;
  }
  return null;
}
