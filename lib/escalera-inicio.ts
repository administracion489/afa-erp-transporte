// lib/escalera-inicio.ts — LA ESCALERA DE INICIO: qué se le manda al conductor que todavía
// no pulsó «Iniciar», cuándo, y cómo se lee después si le llegó. Módulo PURO: no lee la
// base, no envía nada y no mira el reloj por su cuenta (el instante entra por parámetro).
//
// EL CASO QUE LO MOTIVÓ (reserva #29812, I.C. LOGÍSTICA, CWQ400): el conductor hizo el
// servicio sin abrir el app. La pregunta del dueño —«¿le llegaron los avisos para que no se
// olvide?»— no tenía respuesta: los avisos de inicio salían SIN el número de reserva (no
// quedaban en `notificaciones_enviadas`), el ERP descartaba los estados «entregado / leído»
// que Meta manda al webhook, y el motor corre cada 10 min, así que un aviso «5 min antes»
// caía fuera de su ventana la mitad de las veces.
//
// LOS PELDAÑOS, todos SOLO mientras el servicio siga sin iniciar:
//   · proximo_inicio   (90 min antes, tick de 10 min)  — se conserva, decisión del dueño.
//   · recuerda_iniciar (30 min antes, tick de 10 min)  — APAGADO por el dueño (11-10-2026): ya
//                      se avisó a los 90 y a los 5 sale «inicia ahora». La tarjeta se conserva.
//   · inicia_ahora     ( 5 min antes, cron de 1 min)   — NUEVO
//   · debio_iniciar    ( 1 min después, cron de 1 min) — NUEVO
//   · no_inicio        (10 min después, tick)          — al coordinador; al conductor solo si
//                      «Ya debió iniciar» no se lo dijo antes (`noInicioRepiteDebio`)
//
// LO QUE ESCALA ES «NO INICIÓ», NO «NO LEYÓ». El objetivo es el toque de Iniciar, no la
// lectura; y la confirmación de lectura de WhatsApp es desactivable por el usuario, así que
// «entregado y sin leer» NO significa «lo ignoró». El estado de entrega se usa como
// EVIDENCIA para el coordinador, nunca como gatillo — con una excepción que sí dice algo:
// ningún WhatsApp entregado significa teléfono sin datos o apagado, y sin datos el app
// tampoco funcionaría. Eso se nombra (`sinEntregar`), porque ahí lo que sirve es llamarlo.

import { enViaRecordatorio } from "@/lib/alertas-modo-tiempo";
import { hhmmAMinutos, limaAUtcMs, minutoDelDiaLima, minutosAHhmm } from "@/lib/alertas-horario";

export const CLAVE_INICIA_AHORA = "inicia_ahora";
export const CLAVE_DEBIO_INICIAR = "debio_iniciar";

/**
 * Un servicio en estos estados todavía no se inició en el app. Es la MISMA lista que usan
 * los avisos pre-inicio del tick (`["programada", "confirmada"]`): dos definiciones de
 * «aún no inició» terminan avisando a destiempo.
 */
export const ESTADOS_SIN_INICIAR = ["programada", "confirmada"] as const;

/** Minutos antes de la hora del «inicia ahora» cuando la fila no los declara. */
export const INICIA_AHORA_MIN_DEFECTO = 5;
/** Minutos después de la hora del «ya debió iniciar» cuando la fila no los declara. */
export const DEBIO_INICIAR_MIN_DEFECTO = 1;
/**
 * Cuánto tiempo sigue valiendo el «ya debió iniciar» después de su minuto. NO está medido:
 * es el hueco hasta que `no_inicio` (10 min de gracia por defecto) toma el relevo. Pasado
 * eso, un «ya debiste iniciar» que llega tarde por un cron caído es ruido. El lado seguro es
 * subirlo.
 */
export const VENTANA_DEBIO_MIN = 10;

/** Las claves que forman la escalera, en orden de salida. Todas le escriben al conductor. */
export const CLAVES_ESCALERA = [
  "proximo_inicio", "recuerda_iniciar", CLAVE_INICIA_AHORA, CLAVE_DEBIO_INICIAR,
  "en_punto_sin_iniciar", "no_inicio",
] as const;

/** Nombre corto de cada peldaño, para la pantalla y el resumen al coordinador. */
export const ETIQUETA_AVISO: Record<string, string> = {
  proximo_inicio: "Próximo a iniciar",
  recuerda_iniciar: "Recuerda iniciar",
  [CLAVE_INICIA_AHORA]: "Inicia ahora",
  [CLAVE_DEBIO_INICIAR]: "Ya debió iniciar",
  en_punto_sin_iniciar: "En el punto, sin iniciar",
  no_inicio: "No inició",
};

export function etiquetaAviso(clave?: string | null): string {
  if (!clave) return "Aviso";
  return ETIQUETA_AVISO[clave] ?? clave;
}

// ─── ¿QUÉ PELDAÑO TOCA AHORA? ─────────────────────────────────────────────────

export type CfgPaso = {
  activo: boolean;
  modo_tiempo?: string | null;
  hora_fija?: string | null;
  min_anticipacion?: number | null;
  umbral?: number | null;
  notifica_conductor?: boolean | null;
  notifica_conductor_tercero?: boolean | null;
  /** Plantilla de WhatsApp del aviso al conductor: sin ella el cron de un minuto no lo manda. */
  plantilla?: string | null;
} | null | undefined;

/** Por qué un peldaño sale o no sale. Se DECLARA para poder contestar «¿por qué no le llegó?». */
export type CodigoPaso =
  | "toca"
  | "apagado"          // la fila no existe o está desactivada
  | "fuera_de_estado"  // ya inició, terminó, se canceló o sigue pendiente de confirmar
  | "sin_hora"         // sin fecha u hora no hay a qué anclar el aviso
  | "aun_no"           // todavía no llega su minuto
  | "paso_la_ventana"; // su minuto pasó (y el de «debió iniciar» venció)

export type ServicioEscalera = {
  estado?: string | null;
  fecha_servicio?: string | null;
  hora_servicio?: string | null;
};

export type RelojEscalera = {
  /** Instante actual en ms UTC. */
  ahoraMs: number;
  /** Fecha de hoy y de mañana en Lima ("YYYY-MM-DD"). */
  hoy: string;
  manana: string;
};

export function sinIniciar(estado?: string | null): boolean {
  return (ESTADOS_SIN_INICIAR as readonly string[]).includes(String(estado ?? ""));
}

/** Instante de inicio pactado, o null si falta la fecha o la hora no es una hora. */
export function inicioDe(s: ServicioEscalera): number | null {
  const hora = String(s.hora_servicio ?? "").slice(0, 5);
  if (!s.fecha_servicio || hhmmAMinutos(hora) == null) return null;
  return limaAUtcMs(s.fecha_servicio, hora);
}

/** Minutos de anticipación efectivos del «inicia ahora» (≥ 1). */
export function minutosIniciaAhora(cfg: CfgPaso): number {
  const n = Number(cfg?.min_anticipacion);
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : INICIA_AHORA_MIN_DEFECTO;
}

/**
 * Minutos después de la hora efectivos del «ya debió iniciar» (≥ 0). Una columna vacía (null) es
 * «sin dato» y usa el default: `Number(null)` es 0, y leerlo así hacía salir el aviso EN la hora
 * en vez de al minuto, mientras la tarjeta enseñaba el default.
 */
export function minutosDebioIniciar(cfg: CfgPaso): number {
  const n = cfg?.umbral == null ? NaN : Number(cfg.umbral);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : DEBIO_INICIAR_MIN_DEFECTO;
}

/** Gracia de `no_inicio` en minutos después de la hora: la MISMA lectura que el tick (`umbral ?? 10`). */
export const NO_INICIO_MIN_DEFECTO = 10;
export function minutosNoInicio(cfg: CfgPaso | null | undefined): number {
  const n = Number(cfg?.umbral ?? NO_INICIO_MIN_DEFECTO);
  return Number.isFinite(n) && n >= 0 ? n : NO_INICIO_MIN_DEFECTO;
}

/**
 * ¿El «No inició» al CONDUCTOR repite el «Ya debió iniciar»? Los dos le mandan la plantilla
 * `conductor_no_inicio` con los mismos parámetros, así que si «Ya debió iniciar» le llega a ESE
 * conductor, el «No inició» le repetiría el mismo texto minutos después — un WhatsApp cobrado que
 * no dice nada nuevo y que enseña a ignorar los avisos (revisión del 13-10-2026; antes solo se
 * callaba si los dos caían en el mismo minuto, lo que pasó el 12-10-2026).
 *
 * Solo se calla si «Ya debió iniciar» de verdad le escribe a ese conductor: encendido, con
 * «Conductor» marcado, CON PLANTILLA y, si es TERCERIZADO, con «Incluir tercerizados» marcado.
 * Si no, el «No inició» es el primer aviso después de la hora que recibe, y callarlo lo dejaría
 * sin ninguno. Solo se callan los mensajes al conductor: al coordinador le sigue llegando su alerta.
 *
 * Las condiciones son, una por una, las del cron de un minuto (/api/alertas-flota/inicio:
 * `!cfg.notifica_conductor || !cfg.plantilla` → no se manda): «Conductor» se lee como allí (un
 * null no escribe) y la plantilla también, porque sin ella «Ya debió iniciar» no sale y callar el
 * «No inició» dejaba al conductor sin ningún aviso después de la hora.
 */
export function noInicioRepiteDebio(debio: CfgPaso | null | undefined, esTercero = false): boolean {
  if (!debio?.activo) return false;
  if (!debio.notifica_conductor) return false;
  if (!debio.plantilla) return false;
  if (esTercero && debio.notifica_conductor_tercero !== true) return false;
  return true;
}

/**
 * El detalle de la «Alerta previa al coordinador». Los minutos son los que FALTAN de verdad (el tick
 * los mide contra la hora del servicio; la prueba usa los de la tarjeta): antes decía «~25 min»
 * fijo aunque la tarjeta se cambiara a 30, y «(sin GPS)» aunque el código no mirara el GPS.
 * Lo usan el tick y la prueba de avisos, para que digan lo mismo.
 */
export function detalleAlertaPrevia(faltanMin: number, evidencia: string): string {
  const n = Math.max(0, Math.round(faltanMin));
  return `Faltan ${n} min y el conductor aún no pulsa INICIAR RECORRIDO en la app.${evidencia ? ` ${evidencia}` : ""}`;
}

/**
 * Varias líneas en UNA (los parámetros de una plantilla de Meta no admiten saltos de línea),
 * separadas por « · » y sin pasar de `max` caracteres: lo que no cabe se nombra («y N más») en vez
 * de cortarse a mitad de un nombre.
 */
export function listaEnUnaLinea(lineas: string[], max = 600): string {
  const limpias = lineas.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < limpias.length; i++) {
    const resto = limpias.length - i - 1;
    const cola = resto > 0 ? ` · y ${resto} más` : "";
    const candidato = [...out, limpias[i]].join(" · ");
    if (candidato.length + (resto > 0 ? cola.length : 0) > max && out.length > 0) {
      return `${out.join(" · ")} · y ${limpias.length - i} más`;
    }
    out.push(limpias[i]);
  }
  return out.join(" · ");
}

/**
 * «Inicia ahora»: X min antes de la hora y hasta la hora. Pasa por `enViaRecordatorio`, el
 * MISMO predicado de los avisos pre-inicio del tick — la tabla de `alertas-modo-tiempo.ts`
 * lo declara vía «recordatorio», y una segunda definición de esa ventana sería la que se
 * queda atrás. Corre en un cron de UN minuto: con el tick de 10, una ventana de 5 min
 * quedaba fuera de su disparo la mitad de las veces.
 */
export function juzgarIniciaAhora(s: ServicioEscalera, cfg: CfgPaso, reloj: RelojEscalera): CodigoPaso {
  if (!cfg?.activo) return "apagado";
  if (!sinIniciar(s.estado)) return "fuera_de_estado";
  const inicio = inicioDe(s);
  if (inicio == null) return "sin_hora";
  const enVentana = enViaRecordatorio({
    modo_tiempo: cfg.modo_tiempo ?? "anticipacion",
    hora_fija: cfg.hora_fija ?? null,
    min_anticipacion: minutosIniciaAhora(cfg),
    fechaServicio: s.fecha_servicio,
    horaServicio: String(s.hora_servicio ?? "").slice(0, 5),
    hoy: reloj.hoy,
    manana: reloj.manana,
    ahoraMin: minutoDelDiaLima(reloj.ahoraMs),
    ahoraMs: reloj.ahoraMs,
  });
  if (enVentana) return "toca";
  return reloj.ahoraMs >= inicio ? "paso_la_ventana" : "aun_no";
}

/**
 * «Ya debió iniciar»: desde la hora + umbral, durante `VENTANA_DEBIO_MIN`. No lee el modo
 * (vía `ignora_modo`): su reloj es la hora del servicio, como `no_inicio`.
 */
export function juzgarDebioIniciar(s: ServicioEscalera, cfg: CfgPaso, reloj: RelojEscalera): CodigoPaso {
  if (!cfg?.activo) return "apagado";
  if (!sinIniciar(s.estado)) return "fuera_de_estado";
  const inicio = inicioDe(s);
  if (inicio == null) return "sin_hora";
  const desde = inicio + minutosDebioIniciar(cfg) * 60_000;
  const hasta = desde + VENTANA_DEBIO_MIN * 60_000;
  if (reloj.ahoraMs < desde) return "aun_no";
  if (reloj.ahoraMs >= hasta) return "paso_la_ventana";
  return "toca";
}

/** Las claves de la escalera fina (cron de 1 min) que tocan AHORA para este servicio. */
export function pasosQueTocan(
  s: ServicioEscalera,
  cfgs: { iniciaAhora: CfgPaso; debioIniciar: CfgPaso },
  reloj: RelojEscalera,
): string[] {
  const out: string[] = [];
  if (juzgarIniciaAhora(s, cfgs.iniciaAhora, reloj) === "toca") out.push(CLAVE_INICIA_AHORA);
  if (juzgarDebioIniciar(s, cfgs.debioIniciar, reloj) === "toca") out.push(CLAVE_DEBIO_INICIAR);
  return out;
}

// ─── LA NOTIFICACIÓN DEL APP (push, estilo Uber) ──────────────────────────────

export type TextoPush = {
  titulo: string;
  cuerpo: string;
  /** Web push: la notificación se queda en pantalla hasta que la toquen. */
  requireInteraction: boolean;
  /** Vida del push en segundos: un «inicia ahora» que llega una hora tarde no sirve. */
  ttl: number;
};

/**
 * Texto de la notificación del sistema para cada peldaño. Corto, con la hora y el punto de
 * salida, y una sola orden: tocar y pulsar INICIAR. Un push que dice solo el nombre del
 * aviso («Recuerda iniciar recorrido») no se distingue de otro y se descarta sin leer.
 */
export function textoPushInicio(
  clave: string,
  datos: { hora?: string | null; origen?: string | null; minutos?: number | null },
): TextoPush {
  const hora = String(datos.hora ?? "").slice(0, 5) || "—";
  const origen = String(datos.origen ?? "").trim();
  const desde = origen ? ` · ${origen}` : "";
  switch (clave) {
    case "proximo_inicio":
      return { titulo: `🚌 Servicio de las ${hora}`, cuerpo: `Tienes un servicio pronto${desde}. Al salir de la cochera, haz tu check-in y pulsa INICIAR RECORRIDO.`, requireInteraction: false, ttl: 3600 };
    case "recuerda_iniciar": {
      // Los minutos de la TARJETA (los pasa el tick), no un «~30» fijo que mentía al cambiarla.
      // «~» porque el tick corre cada 10 min: puede salir hasta 10 min después de su minuto.
      // Sin minutos (tarjeta a una hora fija: sale la víspera) no se promete ninguno.
      const m = Number(datos.minutos);
      const enCuanto = Number.isFinite(m) && m > 0 ? `en ~${Math.round(m)} min` : "pronto";
      return { titulo: `⏰ Recuerda INICIAR · ${hora}`, cuerpo: `Tu servicio empieza ${enCuanto}${desde}. Toca aquí y pulsa INICIAR RECORRIDO.`, requireInteraction: false, ttl: 1800 };
    }
    case CLAVE_INICIA_AHORA: {
      const m = Number(datos.minutos);
      const enCuanto = Number.isFinite(m) && m > 0 ? `en ${Math.round(m)} min` : "ya";
      return { titulo: `🚨 Tu servicio empieza ${enCuanto}`, cuerpo: `Servicio de las ${hora}${desde}. Toca aquí y pulsa INICIAR RECORRIDO ahora.`, requireInteraction: true, ttl: 900 };
    }
    case CLAVE_DEBIO_INICIAR:
      return { titulo: "⛔ Ya debiste INICIAR tu servicio", cuerpo: `Servicio de las ${hora}${desde}. Ábrelo ahora y pulsa INICIAR RECORRIDO.`, requireInteraction: true, ttl: 900 };
    case "en_punto_sin_iniciar":
      return { titulo: "📍 Ya estás en el punto", cuerpo: `Pulsa INICIAR RECORRIDO para el servicio de las ${hora}${desde}.`, requireInteraction: true, ttl: 900 };
    case "no_inicio":
      return { titulo: `⛔ Tu servicio de las ${hora} sigue sin iniciar`, cuerpo: `${origen ? `${origen}. ` : ""}Abre el app y pulsa INICIAR RECORRIDO ahora, o llama a operaciones.`, requireInteraction: true, ttl: 1800 };
    default:
      return { titulo: "AFA · Aviso de servicio", cuerpo: `Servicio de las ${hora}${desde}.`, requireInteraction: false, ttl: 3600 };
  }
}

// ─── ¿LE LLEGÓ? · estado de entrega de cada aviso ─────────────────────────────

/** Una fila de `notificaciones_enviadas`, con las columnas de entrega opcionales. */
export type FilaAviso = {
  tipo?: string | null;              // whatsapp | email | push | sms
  estado?: string | null;            // enviado | error | sin_canal
  created_at?: string | null;
  alerta_clave?: string | null;
  wamid?: string | null;
  entregado_en?: string | null;
  leido_en?: string | null;
  fallo_entrega?: string | null;
  error_detalle?: string | null;
};

export type CodigoEntrega =
  /** WhatsApp con confirmación de lectura. */
  | "leido"
  /** WhatsApp entregado al teléfono, sin confirmación de lectura (puede tenerla apagada). */
  | "entregado"
  /** Salió del ERP y no hay (todavía) confirmación de entrega. */
  | "enviado"
  /** Meta lo aceptó pero no lo pudo entregar (número sin WhatsApp, bloqueado…). */
  | "fallo"
  /** No salió: el envío mismo falló. */
  | "error"
  /** No había por dónde mandarlo: sin teléfono, sin correo y sin el app activa. */
  | "sin_canal";

export type Entrega = { codigo: CodigoEntrega; texto: string; hora: string | null };

/** "2026-10-11T11:25:00Z" → "06:25" (Lima). Null si no es una fecha. */
export function horaLimaDeIso(iso?: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? minutosAHhmm(minutoDelDiaLima(ms)) : null;
}

/**
 * Qué se sabe de la entrega de UNA fila. El texto NUNCA dice «lo ignoró»: sin confirmación
 * de lectura solo se puede afirmar que llegó al teléfono.
 */
export function estadoEntrega(f: FilaAviso): Entrega {
  if (f.estado === "sin_canal") {
    return { codigo: "sin_canal", texto: "No había por dónde enviarlo (sin teléfono ni app activa)", hora: horaLimaDeIso(f.created_at) };
  }
  if (f.estado === "error") {
    return { codigo: "error", texto: `No salió${f.error_detalle ? `: ${f.error_detalle}` : ""}`, hora: horaLimaDeIso(f.created_at) };
  }
  if (f.fallo_entrega) {
    return { codigo: "fallo", texto: `No se entregó: ${f.fallo_entrega}`, hora: horaLimaDeIso(f.created_at) };
  }
  if (f.leido_en) return { codigo: "leido", texto: `Leído ${horaLimaDeIso(f.leido_en) ?? ""}`.trim(), hora: horaLimaDeIso(f.leido_en) };
  if (f.entregado_en) {
    return { codigo: "entregado", texto: `Entregado ${horaLimaDeIso(f.entregado_en) ?? ""}, sin confirmación de lectura`.replace(" ,", ","), hora: horaLimaDeIso(f.entregado_en) };
  }
  if (f.tipo === "push") return { codigo: "enviado", texto: "Notificación enviada al app", hora: horaLimaDeIso(f.created_at) };
  if (f.tipo === "whatsapp") return { codigo: "enviado", texto: "Enviado, sin confirmación de entrega", hora: horaLimaDeIso(f.created_at) };
  return { codigo: "enviado", texto: "Enviado", hora: horaLimaDeIso(f.created_at) };
}

const CANAL: Record<string, string> = { whatsapp: "WhatsApp", push: "app", email: "correo", sms: "SMS" };

/**
 * Minutos que se espera la confirmación de entrega de un WhatsApp antes de leer su ausencia
 * como «no le llega». NO está medido: Meta suele confirmar en segundos con el teléfono con
 * datos, y dos minutos es el margen de un teléfono que estaba en el bolsillo sin señal.
 */
export const ESPERA_ENTREGA_MIN = 2;

/**
 * Largo máximo de la evidencia que viaja en el parámetro del aviso al coordinador. Lo usan el
 * motor (lib/escalera-inicio-datos.ts) y la prueba de avisos (lib/escalera-muestra.ts): una
 * prueba con otro tope mostraría un mensaje que nunca llega así.
 */
export const LARGO_EVIDENCIA_COORDINADOR = 260;

export type ResumenAvisos = {
  /** Una sola línea (los parámetros de una plantilla de WhatsApp no admiten saltos). */
  texto: string;
  /** Hubo WhatsApp de la escalera y NINGUNO se entregó pasada la espera. */
  sinEntregar: boolean;
  /** ¿Se pudo afirmar algo de la entrega? Sin las columnas de la migración, no. */
  conEstados: boolean;
};

/**
 * Resumen para el coordinador de lo que ya se le mandó al conductor por este servicio.
 * Solo los peldaños de la escalera, en orden de envío, uno por aviso con su mejor canal.
 * Vacío si no hay nada: el llamador no agrega una frase sin contenido.
 */
export function resumenAvisosConductor(filas: FilaAviso[], ahoraMs: number, maxLargo = 320): ResumenAvisos {
  const deEscalera = filas
    .filter((f) => (CLAVES_ESCALERA as readonly string[]).includes(String(f.alerta_clave ?? "")))
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
  if (deEscalera.length === 0) return { texto: "", sinEntregar: false, conEstados: false };

  const conEstados = deEscalera.some((f) => "entregado_en" in f || "leido_en" in f);

  // Un aviso = una clave; dentro, el WhatsApp manda (es lo único que confirma entrega).
  const orden: string[] = [];
  const porClave = new Map<string, FilaAviso[]>();
  for (const f of deEscalera) {
    const k = String(f.alerta_clave);
    if (!porClave.has(k)) { porClave.set(k, []); orden.push(k); }
    porClave.get(k)!.push(f);
  }
  const partes: string[] = [];
  for (const k of orden) {
    const fs = porClave.get(k)!;
    const wa = fs.find((f) => f.tipo === "whatsapp");
    const principal = wa ?? fs[0];
    const e = estadoEntrega(principal);
    const hora = horaLimaDeIso(principal.created_at);
    const canal = CANAL[String(principal.tipo)] ?? String(principal.tipo ?? "");
    const corto = e.codigo === "leido" ? `leído ${e.hora ?? ""}`.trim()
      : e.codigo === "entregado" ? "entregado sin leer"
      : e.codigo === "fallo" ? "no se entregó"
      : e.codigo === "error" ? "no salió"
      : e.codigo === "sin_canal" ? "sin canal"
      : principal.tipo === "whatsapp" ? "sin confirmar entrega" : "enviado";
    partes.push(`${etiquetaAviso(k)} ${hora ?? ""} ${canal} ${corto}`.replace(/\s+/g, " ").trim());
  }

  const whatsapps = deEscalera.filter((f) => f.tipo === "whatsapp" && f.estado !== "error" && f.estado !== "sin_canal");
  const maduros = whatsapps.filter((f) => {
    const ms = Date.parse(String(f.created_at ?? ""));
    return Number.isFinite(ms) && ahoraMs - ms >= ESPERA_ENTREGA_MIN * 60_000;
  });
  const sinEntregar = conEstados && maduros.length > 0
    && maduros.every((f) => !f.entregado_en && !f.leido_en);

  // Si no cabe, se quitan los avisos MÁS ANTIGUOS (diciendo cuántos), nunca la conclusión ni
  // el último: recortar por el final se comía justo «ningún WhatsApp le llegó… llámalo», que es
  // lo único que le dice al coordinador qué hacer — y aparece precisamente cuando la escalera
  // es larga (lo encontró scripts/prueba-escalera-muestra.mts).
  const limpio = (s: string) => s.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ");
  const cierre = sinEntregar ? " Ningún WhatsApp le llegó: teléfono sin datos o apagado, llámalo." : "";
  const armar = (omitidos: number) => limpio(
    `Avisos al conductor: ${omitidos > 0 ? `${omitidos} anterior${omitidos === 1 ? "" : "es"} · ` : ""}` +
    `${partes.slice(omitidos).join(" · ")}.${cierre}`,
  );
  let omitidos = 0;
  let texto = armar(0);
  while (texto.length > maxLargo && omitidos < partes.length - 1) texto = armar(++omitidos);
  if (texto.length > maxLargo) texto = `${texto.slice(0, maxLargo - 1)}…`;
  return { texto, sinEntregar, conEstados };
}

// ─── INTENTOS SIN DETALLE (anteriores a este registro) ────────────────────────

/** Una fila de `alerta_enviada`: el motor RECLAMÓ el envío de esa clave para esa reserva. */
export type Reclamo = { clave: string; created_at?: string | null };

/**
 * Reclamos de la escalera que no tienen ninguna fila de registro con su clave. Son los avisos
 * de antes de este cambio (salían sin reserva y sin clave), o uno sin canal: el motor lo
 * intentó, pero no queda rastro de por dónde ni de si llegó. La pantalla los muestra así,
 * en vez de callarlos — callarlos diría «no se le avisó», que puede ser falso.
 */
export function reclamosSinDetalle(reclamos: Reclamo[], filas: FilaAviso[]): Reclamo[] {
  const conDetalle = new Set(filas.map((f) => String(f.alerta_clave ?? "")).filter(Boolean));
  return reclamos
    .filter((r) => (CLAVES_ESCALERA as readonly string[]).includes(r.clave) && !conDetalle.has(r.clave))
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
}
