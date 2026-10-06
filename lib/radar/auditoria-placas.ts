// lib/radar/auditoria-placas.ts — ¿Las lecturas que el Radar YA grabó están en la unidad correcta?
//
// Antes del guard de lib/radar/procedencia-placa.ts el Radar grababa la placa que propusiera la
// IA, aunque la hubiera elegido por el parecido del tablero (casos de "~Cerna", 12/09 y 16/09/2026
// en la CWZ-371). Esas lecturas siguen ahí, ACEPTADAS, y son las que más daño hacen: su km pasa a
// ser el vigente de una unidad que no era, y las lecturas buenas de los días siguientes se
// descartan como "retroceso".
//
// La auditoría vuelve a decidir la unidad con la MISMA regla del Radar (`decidirUnidad`, con el
// mismo cargador del remitente) sobre el mensaje original, y la compara con la unidad donde quedó
// la lectura. No escribe nada: marca, y la pantalla ofrece pasarla a la unidad correcta con
// `reasignarLectura` (lib/odometro.ts), que valida en la unidad de destino como cualquier lectura.
//
// Solo se auditan las lecturas que vienen de una FOTO DE TABLERO (`radar_odo:<mensaje>`): las de un
// voucher de combustible (`radar_odo_comb:`) llevan la placa impresa en la nota de despacho.

import {
  auditarUnidadLectura, decidirUnidad, escritasEnTexto, motivoAuditoria, telefonoLegible,
  type DecisionUnidad, type Remitente, type UnidadRef, type VeredictoPlaca,
} from "./procedencia-placa";
import { cargarFlotaUnidades, claveRemitenteDia, remitentesPorDia } from "./remitente-unidades";

export type LecturaAuditable = {
  id: string;
  vehiculo_id: number | null;
  vehiculo_tercero_id: number | null;
  foto_url: string | null;
  estado: string;
  idem_key?: string | null;
};

export type AuditoriaLectura = {
  veredicto: VeredictoPlaca;
  /** La unidad a la que habría que pasarla (solo con `otra_unidad`). */
  propuesta: UnidadRef | null;
  decision: DecisionUnidad;
  /** Por qué la placa no está respaldada y dónde se arregla (null si está respaldada). */
  motivo: string | null;
  remitente: string | null;
  telefono: string | null;
  /** Día (Lima) en que se mandó el mensaje: es el día cuyo servicio decide la unidad. */
  fechaMensaje: string | null;
};

const ID_TABLERO = /^radar_odo:([0-9a-f-]{36})$/i;

/** El id del mensaje de una lectura de FOTO DE TABLERO, o null (voucher, manual, sin clave). */
export function mensajeDeLectura(idemKey: string | null | undefined): string | null {
  return ID_TABLERO.exec(String(idemKey ?? "").trim())?.[1] ?? null;
}

const fechaLimaDeTs = (ts: string | null | undefined): string | null => {
  const t = ts ? new Date(ts).getTime() : NaN;
  return Number.isFinite(t) ? new Date(t - 5 * 3600 * 1000).toISOString().slice(0, 10) : null;
};

const COLS_MENSAJE = "id, texto, transcripcion, remitente_wa, remitente_nombre, ts_mensaje, media_url, estado, resultado";

async function enTramos<T>(valores: string[], tam: number, pedir: (tramo: string[]) => Promise<{ data: any; error: any }>): Promise<T[] | null> {
  const out: T[] = [];
  for (let i = 0; i < valores.length; i += tam) {
    const { data, error } = await pedir(valores.slice(i, i + tam));
    if (error) return null;
    out.push(...((data as T[]) ?? []));
  }
  return out;
}

/**
 * Audita las lecturas del Radar. `completa: false` si algo no se pudo leer: entonces la pantalla no
 * puede afirmar que no queda ninguna con la placa sin confirmar. Nunca lanza.
 */
export async function auditarLecturasRadar(
  sb: any,
  lecturas: LecturaAuditable[],
): Promise<{ porLectura: Map<string, AuditoriaLectura>; completa: boolean }> {
  const porLectura = new Map<string, AuditoriaLectura>();
  try {
    // Una anulada ya no cuenta en ninguna parte; una de voucher lleva la placa impresa.
    const vivas = lecturas.filter((l) => l.estado !== "anulada" && !String(l.idem_key ?? "").startsWith("radar_odo_comb"));
    if (!vivas.length) return { porLectura, completa: true };
    let completa = true;

    // 1) El mensaje de cada lectura: por su clave idempotente o, en las más viejas, por la foto.
    const msgDeLectura = new Map<string, string>();
    for (const l of vivas) {
      const id = mensajeDeLectura(l.idem_key);
      if (id) msgDeLectura.set(l.id, id);
    }
    const mensajes = new Map<string, any>();
    const ids = [...new Set(msgDeLectura.values())];
    const porId = await enTramos<any>(ids, 100, (t) => sb.from("radar_mensajes").select(COLS_MENSAJE).in("id", t));
    if (!porId) completa = false;
    for (const m of porId ?? []) mensajes.set(m.id, m);

    const sinClave = vivas.filter((l) => !msgDeLectura.has(l.id) && !l.idem_key && l.foto_url);
    if (sinClave.length) {
      const urls = [...new Set(sinClave.map((l) => l.foto_url!))];
      const porFoto = await enTramos<any>(urls, 40, (t) => sb.from("radar_mensajes").select(COLS_MENSAJE).in("media_url", t));
      if (!porFoto) completa = false;
      // La foto puede ser de un mensaje FUSIONADO en otro: el reporte es el de su principal.
      const principalDe = new Map<string, string>();
      for (const m of porFoto ?? []) {
        mensajes.set(m.id, m);
        const raiz = m.estado === "fusionado" && m.resultado?.fusionado_en ? String(m.resultado.fusionado_en) : m.id;
        if (!principalDe.has(m.media_url) || raiz !== m.id) principalDe.set(m.media_url, raiz);
      }
      const faltan = [...new Set([...principalDe.values()].filter((id) => !mensajes.has(id)))];
      const raices = await enTramos<any>(faltan, 100, (t) => sb.from("radar_mensajes").select(COLS_MENSAJE).in("id", t));
      if (!raices) completa = false;
      for (const m of raices ?? []) mensajes.set(m.id, m);
      for (const l of sinClave) {
        const raiz = principalDe.get(l.foto_url!);
        if (raiz) msgDeLectura.set(l.id, raiz);
      }
    }

    // 2) El texto de la RÁFAGA: la placa puede venir en el mensaje de al lado de la foto.
    const principales = [...new Set(msgDeLectura.values())].filter((id) => mensajes.has(id));
    const hermanos = await enTramos<any>(principales, 100, (t) =>
      sb.from("radar_mensajes").select("id, texto, transcripcion, resultado").in("resultado->>fusionado_en", t));
    if (!hermanos) completa = false;
    const textosRafaga = new Map<string, (string | null)[]>();
    for (const h of hermanos ?? []) {
      const raiz = String(h.resultado?.fusionado_en ?? "");
      textosRafaga.set(raiz, [...(textosRafaga.get(raiz) ?? []), h.texto ?? null, h.transcripcion ?? null]);
    }

    // 3) La flota y quién mandó cada foto, con su servicio de ese día.
    const flota = await cargarFlotaUnidades(sb);
    if (!flota) return { porLectura, completa: false };
    const consultas = principales.map((id) => {
      const m = mensajes.get(id);
      return { wa: m.remitente_wa as string | null, fecha: fechaLimaDeTs(m.ts_mensaje) ?? "" };
    }).filter((c) => c.fecha);
    const remitentes = await remitentesPorDia(sb, consultas, flota);

    // 4) La misma decisión del Radar, contra la unidad donde quedó la lectura.
    for (const l of vivas) {
      const idMsg = msgDeLectura.get(l.id);
      const m = idMsg ? mensajes.get(idMsg) : null;
      if (!m) continue; // sin mensaje no hay con qué juzgar: no se afirma nada
      const fecha = fechaLimaDeTs(m.ts_mensaje);
      const remitente: Remitente = (fecha && remitentes.get(claveRemitenteDia(m.remitente_wa, fecha))) || { codigo: "no_se_pudo_leer" };
      const actual = l.vehiculo_tercero_id != null
        ? flota.find((u) => u.flota === "tercero" && u.id === Number(l.vehiculo_tercero_id)) ?? null
        : flota.find((u) => u.flota === "propia" && u.id === Number(l.vehiculo_id)) ?? null;
      const textos = [m.texto, m.transcripcion, ...(textosRafaga.get(m.id) ?? [])];
      const decision = decidirUnidad({
        escritas: escritasEnTexto(flota, textos),
        unidadIA: actual ? { flota: actual.flota, id: actual.id, placa: actual.placa } : null,
        remitente,
      });
      const { veredicto, propuesta } = auditarUnidadLectura(actual, decision);
      porLectura.set(l.id, {
        veredicto,
        propuesta,
        decision,
        motivo: motivoAuditoria(actual, decision, { remitente, nombre: m.remitente_nombre, fecha }),
        remitente: m.remitente_nombre ?? null,
        telefono: remitente.codigo === "identificado" || remitente.codigo === "no_registrado" ? telefonoLegible(remitente.telefono) : null,
        fechaMensaje: fecha,
      });
    }
    return { porLectura, completa };
  } catch {
    return { porLectura, completa: false };
  }
}
