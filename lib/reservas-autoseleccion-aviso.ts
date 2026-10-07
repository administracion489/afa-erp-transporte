// ──────────────────────────────────────────────────────────────────────────────
// lib/reservas-autoseleccion-aviso.ts — Motor PURO del aviso ámbar de /programacion: «Permitir
// autoselección» está APAGADA en un servicio vigente mientras otros servicios del mismo contrato y
// sentido la tienen ENCENDIDA. Es la firma del 06-10: los retornos RUTA A 17:00 nacieron apagados
// (default viejo) y nada en la lista lo decía.
//
// Vive aparte de lib/reservas-autoseleccion.ts a propósito: aquél lo importa /api/pasajero, y este
// necesita `sentidoDeReserva` (lib/liquidacion-agrupacion, que arrastra el resto de la liquidación).
//
// LAS REGLAS, de la evidencia al juicio:
//   1. Sin la columna cargada (`undefined`) no se juzga: `sin_dato`.
//   2. Sin cotización no hay contrato: `sin_contrato`.
//   3. Solo se juzga lo que un pasajero todavía podría elegir (la ventana de reservas_disponibles,
//      extendida al futuro): `no_vigente` si no.
//   4. Encendida: `encendida`.
//   4b. Apagada CON la fecha de un operador (autoseleccion_apagada_en): `desmarcada_por_operador`, y
//       NO avisa. Es una decisión, no el default viejo; avisar ahí enseñaría a ignorar el ámbar (y el
//       generador hereda justo esos desmarcados: la lista alarmaría por lo que el sistema hizo bien).
//       Sin la columna (migración no corrida) la fila llega sin el campo y se juzga como antes.
//   5. Vecinos = mismo contrato (cotizacion_id), mismo sentido (la definición de la liquidación,
//      que cae al nombre de ruta), otro id, no cancelado, ENCENDIDO. Pasados y finalizados cuentan:
//      son evidencia de la intención. Con al menos uno → `apagada_con_vecinos` (el aviso).
//
// LÍMITE DECLARADO: un contrato con TODO apagado no tiene evidencia y no avisa; eso lo cubre la
// consulta de revisión de supabase/reservas-06-autoseleccion-por-defecto.sql. Y un móvil que un
// operador apagó a propósito mientras los demás siguen encendidos avisará siempre — por eso el
// texto dice «si nadie la apagó a propósito». Una regla por mayoría escondería el caso real.
// ──────────────────────────────────────────────────────────────────────────────

import { sentidoDeReserva, type ReservaLiq } from "@/lib/liquidacion-agrupacion";
import { idAfa } from "@/lib/folio";

export type FilaAutoseleccion = {
  id: number;
  codigo?: string | null;
  cotizacion_id?: number | null;
  estado?: string | null;
  fecha_servicio?: string | null;
  direccion_servicio?: string | null;
  ruta_nombre?: string | null;
  /** true encendida · false/null apagada (/pasajero exige true) · undefined = la columna no llegó. */
  permite_autoseleccion?: boolean | null;
  /** Cuándo la desmarcó un OPERADOR (reservas-06). null/undefined: no consta. */
  autoseleccion_apagada_en?: string | null;
};
export type SentidoAuto = "IDA" | "RETORNO";
export type CodigoAutoseleccion =
  | "sin_dato" | "sin_contrato" | "no_vigente" | "encendida" | "desmarcada_por_operador"
  | "sin_vecinos_encendidos" | "apagada_con_vecinos";
export type VeredictoAutoseleccion = {
  codigo: CodigoAutoseleccion;
  /** ⟺ codigo === "apagada_con_vecinos" */
  avisa: boolean;
  sentido: SentidoAuto;
  /** Vecinos del mismo contrato y sentido, no cancelados, encendidos (sin contarse a sí mismo). */
  encendidos: number;
  /** Hasta 3, el más cercano en fecha primero. */
  ejemplos: FilaAutoseleccion[];
};

/** Las columnas de los VECINOS (solo se piden encendidos: la fecha del desmarcado no hace falta). */
export const COLS_AUTOSELECCION =
  "id,codigo,cotizacion_id,estado,fecha_servicio,direccion_servicio,ruta_nombre,permite_autoseleccion";

/** El rótulo que el operador VE en el Manifiesto (el ERP le dice «autoselección» por dentro). */
export const ETIQUETA_TOGGLE_AUTOSELECCION = "Permitir que pasajeros elijan su paradero";

const esCancelada = (e?: string | null) => /^cancelad[ao]$/i.test(String(e ?? "").trim());
const ayerDe = (hoy: string) => {
  const d = new Date(hoy + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** UNA definición de sentido: la de la liquidación. */
export const sentidoAuto = (r: FilaAutoseleccion): SentidoAuto =>
  sentidoDeReserva({ direccion_servicio: r.direccion_servicio ?? null, ruta_nombre: r.ruta_nombre ?? null } as ReservaLiq);

export function claveContratoSentido(r: FilaAutoseleccion): string | null {
  return r.cotizacion_id == null ? null : `${Number(r.cotizacion_id)}|${sentidoAuto(r)}`;
}

/** ¿Un pasajero todavía podría elegirlo? `hoy` se PASA (fecha de Lima), no se calcula aquí. */
export function vigenteParaAutoseleccion(r: FilaAutoseleccion, hoy: string): boolean {
  const e = String(r.estado ?? "").trim().toLowerCase();
  if (esCancelada(e) || e === "finalizada") return false;
  const f = r.fecha_servicio ? String(r.fecha_servicio).slice(0, 10) : null;
  if (!f || f >= hoy) return true;
  return e === "en_curso" && f >= ayerDe(hoy);
}

/** Une lo cargado con los vecinos traídos aparte, por id; gana `primero` (más fresco tras un cambio local). */
export function unirContexto(primero: readonly FilaAutoseleccion[], despues: readonly FilaAutoseleccion[]): FilaAutoseleccion[] {
  const m = new Map<number, FilaAutoseleccion>();
  for (const f of [...primero, ...despues]) if (!m.has(f.id)) m.set(f.id, f);
  return [...m.values()];
}

/** Cotizaciones con algo que juzgar: alguna fila vigente, apagada (no undefined) sin fecha de operador, con contrato. */
export function cotizacionesAJuzgar(filas: readonly FilaAutoseleccion[], hoy: string): number[] {
  const s = new Set<number>();
  for (const r of filas) {
    if (r.cotizacion_id != null && r.permite_autoseleccion !== undefined
      && r.permite_autoseleccion !== true && !r.autoseleccion_apagada_en
      && vigenteParaAutoseleccion(r, hoy)) s.add(Number(r.cotizacion_id));
  }
  return [...s];
}

function indiceEncendidas(filas: readonly FilaAutoseleccion[]) {
  const m = new Map<string, FilaAutoseleccion[]>();
  for (const v of filas) {
    if (v.permite_autoseleccion !== true || esCancelada(v.estado)) continue;
    const k = claveContratoSentido(v);
    if (!k) continue;
    const a = m.get(k);
    if (a) a.push(v); else m.set(k, [v]);
  }
  return m;
}

const distancia = (a?: string | null, b?: string | null) =>
  a && b ? Math.abs(Date.parse(String(a).slice(0, 10) + "T00:00:00Z") - Date.parse(String(b).slice(0, 10) + "T00:00:00Z"))
    : Number.MAX_SAFE_INTEGER;

function juzgarConIndice(r: FilaAutoseleccion, idx: Map<string, FilaAutoseleccion[]>, hoy: string): VeredictoAutoseleccion {
  const sentido = sentidoAuto(r);
  const no = (codigo: CodigoAutoseleccion): VeredictoAutoseleccion => ({ codigo, avisa: false, sentido, encendidos: 0, ejemplos: [] });
  if (r.permite_autoseleccion === undefined) return no("sin_dato");
  if (r.cotizacion_id == null) return no("sin_contrato");
  if (!vigenteParaAutoseleccion(r, hoy)) return no("no_vigente");
  if (r.permite_autoseleccion === true) return no("encendida");
  if (r.autoseleccion_apagada_en) return no("desmarcada_por_operador");
  const encendidos = (idx.get(claveContratoSentido(r) as string) ?? []).filter((v) => v.id !== r.id);
  if (!encendidos.length) return no("sin_vecinos_encendidos");
  const ejemplos = [...encendidos]
    .sort((a, b) => distancia(a.fecha_servicio, r.fecha_servicio) - distancia(b.fecha_servicio, r.fecha_servicio) || a.id - b.id)
    .slice(0, 3);
  return { codigo: "apagada_con_vecinos", avisa: true, sentido, encendidos: encendidos.length, ejemplos };
}

/** El veredicto de UNA fila contra su contexto. */
export function juzgarAutoseleccion(r: FilaAutoseleccion, contexto: readonly FilaAutoseleccion[], hoy: string): VeredictoAutoseleccion {
  return juzgarConIndice(r, indiceEncendidas(unirContexto([], contexto)), hoy);
}

/** El lote, en O(n): el mismo juicio que juzgarAutoseleccion fila por fila (lo fija la matriz). */
export function avisosAutoseleccion(filas: readonly FilaAutoseleccion[], hoy: string): Map<number, VeredictoAutoseleccion> {
  const unicas = unirContexto(filas, []);
  const idx = indiceEncendidas(unicas);
  return new Map(unicas.map((r) => [r.id, juzgarConIndice(r, idx, hoy)]));
}

/** El texto lo compone el módulo, no cada pantalla: lista, agenda, formulario y modal dicen lo mismo. */
export function textoAvisoAutoseleccion(v: VeredictoAutoseleccion): { chip: string; detalle: string } {
  const tramos = v.sentido === "RETORNO" ? "retornos" : "idas";
  const ej = v.ejemplos.map((f) => idAfa(f)).join(", ");
  return {
    chip: "SIN AUTOSELECCIÓN",
    detalle: `«${ETIQUETA_TOGGLE_AUTOSELECCION}» está APAGADA en este servicio y encendida en ${v.encendidos} ` +
      `servicio(s) del mismo contrato (${tramos})${ej ? `, p. ej. ${ej}` : ""}. Así no sale en «Elige tu ruta de hoy» ` +
      `de la app del pasajero. Si nadie la apagó a propósito, enciéndela en Pax → ⚙ Configurar ruta.`,
  };
}
