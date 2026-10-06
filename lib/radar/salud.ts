// ──────────────────────────────────────────────────────────────────────────────
// lib/radar/salud.ts — Motor PURO: ¿el Radar IA está LEYENDO los vouchers ahora? Y si no, por qué.
// No lee la base (eso es lib/radar/salud-datos.ts).
//
// LO PLANTEÓ EL DUEÑO: «el Radar IA puede fallar —es Baileys, WhatsApp puede eliminar esa línea, o se
// queda sin saldo de API para leer—, y entonces la factura registra el combustible al día siguiente».
// La factura es el respaldo, pero solo cubre la cuenta cuyas facturas llegan al correo, y entra sin
// odómetro: un Radar caído no puede descubrirse días después porque las cargas aparecen incompletas.
// Hasta ahora lo único que lo decía era el chip de conexión de /radar-ia, y solo para la conexión: una
// API sin saldo dejaba el chip en verde mientras cada mensaje terminaba en «Error».
//
// DE LA EVIDENCIA AL JUICIO, en este orden, y gana el primero:
//   1. el SERVIDOR no late (radar-worker caído) → no entra ningún mensaje;
//   2. WhatsApp esperando QR, bloqueado (403), desvinculado (401/405/411) o desconectado;
//   3. el Radar en PAUSA (radar_config.activo) → los mensajes llegan y no se leen;
//   4. los últimos mensajes FALLARON: sin saldo en la API de IA, la clave rechazada, o una racha de
//      fallos de cualquier otra causa;
//   5. el LÍMITE DIARIO de gasto de IA alcanzado con mensajes esperando;
//   6. mensajes ESPERANDO en la cola hace más de una hora dentro del horario de monitoreo;
//   7. grupos activos que el número ya no ve (lo sacaron del grupo): lee, pero a medias.
// Lo de arriba es causa de lo de abajo (un servidor caído también deja la cola quieta), así que se
// nombra la causa, no el síntoma.
//
// «AHORA» ES LO RECIENTE, NO EL HISTORIAL: una racha de fallos se cuenta desde el ÚLTIMO mensaje
// terminado hacia atrás. Los fallos de hace tres días con lecturas buenas después no dicen que hoy esté
// roto (de esos se encarga el aviso «Reprocesar los que fallaron» de /radar-ia). Y sin evidencia no se
// afirma nada: tri-estado (`lee: null`), como el semáforo de puntualidad.
//
// LOS UMBRALES NO ESTÁN MEDIDOS Y SE DECLARAN: LATIDO_VIVO_MS (3 min, heredado del chip de /radar-ia:
// el worker late cada 60 s), RACHA_FALLANDO (3) y COLA_ATASCADA_MS (60 min = cuatro vueltas del cron de
// 15 min). Sin saldo o con la clave rechazada basta UN fallo: esos no son azar, fallan todos.
// ──────────────────────────────────────────────────────────────────────────────

import { esFallido, motivoDeFallo, ACCION_QUITADO_DEL_AVISO } from "@/lib/radar/reproceso";
import { dentroDeHorario } from "@/lib/radar/config";

/** Sin latido en este tiempo, el worker no está corriendo. El MISMO del chip de /radar-ia. */
export const LATIDO_VIVO_MS = 3 * 60_000;
/** Mensajes terminados seguidos que fallaron para decir «el Radar está fallando». No medido. */
export const RACHA_FALLANDO = 3;
/** Un mensaje que espera más que esto, dentro del horario, está atascado. No medido. */
export const COLA_ATASCADA_MS = 60 * 60_000;

/**
 * Traduce el código de cierre que dejó el worker en `detalle` cuando significa "WhatsApp ya no acepta
 * estas credenciales". Son los casos en que reintentar no sirve de nada: la única salida es borrar la
 * sesión y escanear un QR nuevo. El worker 1.1.0+ lo hace solo; en versiones anteriores el 403
 * (número bloqueado) caía en el reintento genérico y el Radar se quedaba para siempre sin mostrar QR.
 */
export function credencialesRechazadas(detalle: string | null | undefined): string | null {
  switch (codigoCierre(detalle)) {
    case "403":
      return "WhatsApp bloqueó el número del Radar (403). Ese número no va a volver a conectar por más que se reintente: hay que vincular OTRO número dedicado con “Generar QR nuevo”.";
    case "401":
      return "La sesión se cerró desde el teléfono (401). Hay que volver a vincular con “Generar QR nuevo”.";
    case "405":
      return "WhatsApp rechazó las credenciales guardadas (405). Hay que volver a vincular con “Generar QR nuevo”.";
    case "411":
      return "El teléfono no tiene multi-dispositivo activo (411). Actualiza WhatsApp en el celular y vuelve a vincular.";
    default:
      return null;
  }
}

/** El código de cierre de WhatsApp que el worker dejó en `detalle` («… código 403 …»), o null. */
export const codigoCierre = (detalle: string | null | undefined): string | null =>
  (detalle ? /código\s+(\d{3})/i.exec(detalle)?.[1] : null) ?? null;

/** ¿Late el worker? El MISMO juicio para el chip de /radar-ia y para el aviso de salud. */
export function workerVivo(ultimoLatido: string | null | undefined, ahora: number): boolean {
  const t = Date.parse(String(ultimoLatido ?? ""));
  return Number.isFinite(t) && ahora - t < LATIDO_VIVO_MS;
}

export type CausaFallo = "sin_credito" | "clave_invalida" | "sobrecarga" | "otro";

/**
 * Por qué falló un mensaje, leído del motivo que dejó el motor (el error de la API de Anthropic tal
 * cual). Sin saldo y clave rechazada se distinguen porque se arreglan en sitios distintos —la consola
 * de facturación de Anthropic contra la variable ANTHROPIC_API_KEY de Vercel— y porque fallan TODOS los
 * mensajes, no uno. La sobrecarga (429/529) es pasajera: no se nombra como causa propia.
 */
export function causaDeFallo(motivo: string | null | undefined): CausaFallo {
  const m = String(motivo ?? "");
  if (/credit balance|purchase credits|plans\s*&\s*billing/i.test(m)) return "sin_credito";
  if (/authentication_error|invalid x-api-key|invalid api key/i.test(m)) return "clave_invalida";
  if (/overloaded|rate_limit|\b429\b|\b529\b/i.test(m)) return "sobrecarga";
  return "otro";
}

export type CodigoSalud =
  | "ok"
  | "sin_datos"
  | "servidor_caido" | "esperando_qr" | "whatsapp_bloqueado" | "whatsapp_desvinculado" | "desconectado"
  | "pausado"
  | "sin_credito" | "clave_invalida" | "fallando"
  | "limite_diario"
  | "atascado"
  | "grupos_sin_acceso";

/** Los códigos de CONEXIÓN: /radar-ia ya los pinta con su chip y sus bloques (QR, worker desconectado). */
export const CODIGOS_CONEXION: readonly CodigoSalud[] = ["servidor_caido", "esperando_qr", "whatsapp_bloqueado", "whatsapp_desvinculado", "desconectado"];

export type MensajeTerminado = { estado: string | null; accion?: string | null; error?: string | null; resultado?: unknown; procesado_en: string | null };

export type EntradaSalud = {
  ahora: number;
  /** La fila de radar_estado. null = no se pudo leer. */
  estado: { estado: string | null; detalle: string | null; ultimo_latido: string | null; numero?: string | null } | null;
  /** radar_config normalizada. null = no se pudo leer. */
  config: { activo: boolean; horario_activo: boolean; hora_inicio: string; hora_fin: string; limite_diario_usd: number } | null;
  /** Los últimos mensajes que el motor TERMINÓ, del más reciente al más viejo. null = no se pudieron leer. */
  ultimos: MensajeTerminado[] | null;
  /** La cola: cuántos esperan y desde cuándo el más viejo. null = no se pudo leer. */
  cola: { cuantos: number; masViejo: string | null } | null;
  /** Gasto de IA de HOY (USD), como lo suma el motor. null = no se pudo leer. */
  gastoHoy: number | null;
  /** Grupos activos que el número conectado ya no ve. null = no se sabe (columna sin migrar). */
  gruposSinAcceso: number | null;
};

export type SaludRadar = {
  codigo: CodigoSalud;
  /** true: lee · false: NO está leyendo vouchers · null: no se sabe. */
  lee: boolean | null;
  tono: "ok" | "aviso" | "grave";
  titulo: string;
  /** Causa y arreglo, en una o dos frases. */
  detalle: string;
  /** Desde cuándo (ISO), si se sabe. */
  desde: string | null;
};

const LIMA_MS = 5 * 3600_000;
const horaLimaDe = (ts: number) => new Date(ts - LIMA_MS).toISOString().slice(11, 16);
const diaLimaDe = (ts: number) => new Date(ts - LIMA_MS).toISOString().slice(0, 10);
/** «hoy 14:05» · «ayer 22:10» · «el 03/10 08:00», en hora Lima. */
export function cuandoTexto(iso: string | null | undefined, ahora: number): string {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "un momento desconocido";
  const d = diaLimaDe(t), hoy = diaLimaDe(ahora), ayer = diaLimaDe(ahora - 86_400_000);
  const h = horaLimaDe(t);
  return d === hoy ? `hoy ${h}` : d === ayer ? `ayer ${h}` : `el ${d.slice(8, 10)}/${d.slice(5, 7)} ${h}`;
}
/** «hace 7 min» · «hace 3 h» · «hace 2 días». */
export function haceTexto(iso: string | null | undefined, ahora: number): string {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "nunca";
  const min = Math.max(0, Math.floor((ahora - t) / 60_000));
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} días`;
}

const resultado = (codigo: CodigoSalud, lee: boolean | null, tono: SaludRadar["tono"], titulo: string, detalle: string, desde: string | null = null): SaludRadar =>
  ({ codigo, lee, tono, titulo, detalle, desde });

export function saludRadar(e: EntradaSalud): SaludRadar {
  const { ahora, estado, config } = e;

  // 1-2. La conexión: sin ella no entra ningún mensaje.
  if (estado) {
    if (!workerVivo(estado.ultimo_latido, ahora)) {
      return resultado("servidor_caido", false, "grave", "El servidor del Radar IA no responde",
        `Último latido ${haceTexto(estado.ultimo_latido, ahora)} (${cuandoTexto(estado.ultimo_latido, ahora)}). Sin él no entra ningún mensaje de WhatsApp. ` +
        "Se revive en el servidor con «pm2 restart radar-worker» (Radar IA → chip de conexión explica cómo).", estado.ultimo_latido);
    }
    if (estado.estado === "esperando_qr") {
      return resultado("esperando_qr", false, "grave", "El WhatsApp del Radar IA está desvinculado",
        "Espera que se escanee un código QR en Radar IA con el número dedicado. Hasta entonces no entra ningún mensaje.");
    }
    if (estado.estado !== "conectado") {
      const rechazo = credencialesRechazadas(estado.detalle);
      if (rechazo && codigoCierre(estado.detalle) === "403") return resultado("whatsapp_bloqueado", false, "grave", "WhatsApp bloqueó el número del Radar IA", rechazo);
      if (rechazo) return resultado("whatsapp_desvinculado", false, "grave", "Se cerró la sesión de WhatsApp del Radar IA", rechazo);
      return resultado("desconectado", false, "grave", "El WhatsApp del Radar IA está desconectado",
        `${estado.detalle ? `${estado.detalle}. ` : ""}El servidor reintenta solo; si no vuelve en unos minutos, revisa Radar IA.`);
    }
  }

  // 3. En pausa: los mensajes llegan y esperan.
  if (config && !config.activo) {
    return resultado("pausado", false, "grave", "El Radar IA está en pausa",
      "Los mensajes llegan pero no se leen hasta reactivarlo (Radar IA → «Radar activo»).");
  }

  // 4. Lo último que terminó: ¿falló? Se cuenta la racha desde el más reciente hacia atrás. Un fallo que
  // alguien «quitó del aviso» sigue siendo un fallo (conserva su motivo): quitarlo de la lista de
  // /radar-ia no puede esconder que la API se quedó sin saldo.
  if (e.ultimos && e.ultimos.length) {
    const racha: MensajeTerminado[] = [];
    for (const m of e.ultimos) { if (!esFallido(m) && m.accion !== ACCION_QUITADO_DEL_AVISO) break; racha.push(m); }
    if (racha.length) {
      const motivo = motivoDeFallo(racha[0]);
      const causa = causaDeFallo(motivo);
      const desde = racha[racha.length - 1].procesado_en;
      const fallaron = racha.length === 1 ? "falló el último mensaje"
        : racha.length === e.ultimos.length ? `fallaron los últimos ${racha.length} mensajes` : `fallaron ${racha.length} mensajes seguidos`;
      if (causa === "sin_credito") {
        return resultado("sin_credito", false, "grave", "La API de IA del Radar se quedó sin saldo",
          `Desde ${cuandoTexto(desde, ahora)} no se puede leer ningún mensaje (${fallaron}). Recarga la cuenta de Anthropic ` +
          "(console.anthropic.com → Plans & Billing) y después, en Radar IA → Feed, «Reprocesar los que fallaron».", desde);
      }
      if (causa === "clave_invalida") {
        return resultado("clave_invalida", false, "grave", "La API de IA rechaza la clave del Radar",
          `Desde ${cuandoTexto(desde, ahora)} la API rechaza ANTHROPIC_API_KEY (${fallaron}). Corrígela en Vercel y reprocesa los que fallaron en Radar IA → Feed.`, desde);
      }
      if (racha.length >= RACHA_FALLANDO) {
        return resultado("fallando", false, "grave", `Los últimos ${racha.length} mensajes del Radar IA fallaron`,
          `Desde ${cuandoTexto(desde, ahora)}. Último motivo: ${motivo.slice(0, 220)}. Revísalos en Radar IA → Feed.`, desde);
      }
    }
  }

  // 5. El límite diario de gasto de IA, con mensajes esperando: el motor los deja para mañana.
  if (config && e.gastoHoy != null && e.cola && e.cola.cuantos > 0 && config.limite_diario_usd > 0 && e.gastoHoy >= config.limite_diario_usd) {
    return resultado("limite_diario", false, "grave", "El Radar IA llegó a su límite de gasto de hoy",
      `Gastó US$ ${e.gastoHoy.toFixed(2)} de US$ ${config.limite_diario_usd.toFixed(2)}: ${e.cola.cuantos} mensaje(s) esperan a mañana. ` +
      "Si no pueden esperar, sube el límite en Radar IA → Configuración.");
  }

  // 6. La cola quieta, dentro del horario (fuera de él, esperar es lo que el motor hace a propósito).
  if (e.cola && e.cola.cuantos > 0 && e.cola.masViejo) {
    const t = Date.parse(e.cola.masViejo);
    const enHorario = !config || dentroDeHorario(config, horaLimaDe(ahora));
    if (Number.isFinite(t) && ahora - t > COLA_ATASCADA_MS && enHorario) {
      return resultado("atascado", false, "aviso", `${e.cola.cuantos} mensaje(s) esperan en la cola del Radar IA`,
        `El más viejo llegó ${cuandoTexto(e.cola.masViejo, ahora)}. La cola se lee cada 15 minutos: si sigue ahí, el proceso que la lee no está corriendo. Revisa Radar IA.`,
        e.cola.masViejo);
    }
  }

  // 7. Grupos que el número ya no ve: el Radar lee, pero no esos grupos.
  if (e.gruposSinAcceso != null && e.gruposSinAcceso > 0) {
    return resultado("grupos_sin_acceso", true, "aviso", `${e.gruposSinAcceso} grupo(s) activos ya no son visibles para el número del Radar IA`,
      "Lo que se mande a esos grupos no llega al Radar (¿sacaron al número del grupo?). Revisa Radar IA → Grupos.");
  }

  if (!estado) return resultado("sin_datos", null, "ok", "No se pudo saber si el Radar IA está leyendo", "No se pudo leer su estado.");
  return resultado("ok", true, "ok", "El Radar IA está leyendo",
    `Último latido ${haceTexto(estado.ultimo_latido, ahora)}${estado.numero ? ` · WhatsApp ${estado.numero}` : ""}.`);
}

/**
 * El aviso de la pestaña 📧 Facturas: qué significa para las facturas que el Radar no lea. null cuando
 * lee (o no se sabe: sin evidencia no se alarma).
 */
export function avisoSaludEnFacturas(s: SaludRadar | null): { tono: "aviso" | "grave"; titulo: string; detalle: string } | null {
  if (!s || s.lee === null || s.codigo === "ok") return null;
  const consecuencia = s.lee
    ? "Las recargas que se manden a esos grupos no llegan al Radar: si son de la cuenta de combustible, entran por su factura del correo, sin odómetro — complétalas en «Cargas por completar»."
    : "Mientras tanto, las cargas de la cuenta de combustible entran por su factura del correo al día siguiente, SIN odómetro y con la fecha deducida: " +
      "complétalas en «Cargas por completar» (abajo). Las de otros grifos no tienen factura en el correo: regístralas a mano en Combustible.";
  return { tono: s.tono === "grave" ? "grave" : "aviso", titulo: s.titulo, detalle: `${s.detalle} ${consecuencia}` };
}
