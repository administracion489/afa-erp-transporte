// lib/llamadas-central.ts — LA LLAMADA AL CONDUCTOR QUE NO INICIA, desde una central PROPIA.
// Módulo PURO: no lee la base, no llama a nadie y no mira el reloj (el instante entra por
// parámetro). Lo usan el cron de un minuto (/api/alertas-flota/inicio), la puerta de la central
// (/api/llamadas/central), la ficha de /seguimiento y la evidencia al coordinador.
//
// Lo pidió el dueño (11-10-2026): «si le llega el mensaje pero lo ignora, a los 2 minutos una
// llamada que le pida usar el app» y, en vez de contratar Twilio, «un sistema propio para no
// pagar ni depender de más terceros».
//
// LO QUE SE PUEDE Y LO QUE NO. Una llamada telefónica normal —la que suena aunque el teléfono no
// tenga datos, que es justo el caso que más la necesita— siempre sale por la línea de un
// operador: eso no se puede evitar. Lo que se evita es el intermediario que cobra por minuto: la
// hace una CENTRAL PROPIA (un equipo con un chip de llamadas ilimitadas) y el ERP solo le deja la
// cola. Sin central conectada no sale ninguna llamada, y eso se DICE (abajo).
//
// EL REPARTO: el ERP decide A QUIÉN y CUÁNDO, y guarda lo que pasó; la central solo marca y
// cuenta el resultado por `POST /api/llamadas/central` (contrato en docs/central-llamadas.md).
// Así la central puede ser un Asterisk con un gateway celular (habla y lee «marca 1») o un
// Android con un chip (solo hace sonar): el contrato es el mismo y el ERP no cambia.
//
// LAS REGLAS:
//   · SE LLAMA POR «NO INICIÓ», NUNCA POR «NO LEYÓ» (la regla de toda la escalera). Y se llama
//     aunque el WhatsApp no le haya llegado: sin datos, la llamada es lo único que le llega.
//   · ANTES DE MARCAR SE VUELVE A MIRAR EL SERVICIO: si ya se inició, la llamada se cancela. A un
//     conductor que ya va en ruta no se le hace sonar el teléfono mientras maneja.
//   · UNA LLAMADA VIEJA NO SALE: vence a los VENTANA_LLAMADA_MIN; para entonces ya le avisó el
//     motor al coordinador («no inició») y el que tiene que llamar es él.
//   · LA CENTRAL CAÍDA SE NOMBRA: la cola sigue llenándose y vence sin salir, y la ficha y la
//     evidencia al coordinador lo dicen en vez de dar a entender que se le llamó.

import {
  inicioDe, resumenAvisosConductor, sinIniciar,
  type CfgPaso, type CodigoPaso, type FilaAviso, type RelojEscalera, type ResumenAvisos, type ServicioEscalera,
} from "@/lib/escalera-inicio";
import { hhmmAMinutos, minutoDelDiaLima, minutosAHhmm } from "@/lib/alertas-horario";

export const CLAVE_LLAMADA = "llamada_inicio";

/**
 * Minutos después de la hora del servicio. El dueño pidió la llamada «a los 2 minutos» del
 * mensaje que ignoró; el último mensaje antes de la llamada es «ya debió iniciar», a la hora + 1.
 */
export const LLAMADA_MIN_DEFECTO = 3;
/**
 * Cuánto sigue valiendo una llamada después de su minuto. NO medido: cubre el «no inició» de los
 * 10 min y deja margen a un reintento. Pasado eso ya avisó el coordinador. El lado seguro es
 * BAJARLO: una llamada tardía no se puede deshacer.
 */
export const VENTANA_LLAMADA_MIN = 12;
/** Espera antes de volver a marcar si no contestó o estaba ocupado. No medido. */
export const REINTENTO_MIN = 2;
/** Intentos por servicio. No medido: el segundo recoge el «no lo escuché». */
export const MAX_INTENTOS = 2;
/** Una llamada «marcando» sin resultado pasado esto se da por terminada (la central se cayó). */
export const MARCANDO_MAX_MIN = 5;
/** La central pregunta cada ~10 s: sin noticias en 2 min, está desconectada. */
export const LATIDO_VIVO_MIN = 2;

export type EstadoLlamada =
  | "pendiente"     // en cola: la central la toma cuando llegue su minuto
  | "marcando"      // la central la tomó y está llamando
  | "contestada"
  | "no_contesto"
  | "ocupado"
  | "fallida"       // la central no pudo marcar (sin señal, sin saldo…) o no informó
  | "cancelada"     // no se marcó: el servicio ya se inició
  | "vencida";      // no se marcó: nadie la tomó a tiempo (central desconectada)

export const ESTADOS_LLAMADA: readonly EstadoLlamada[] = [
  "pendiente", "marcando", "contestada", "no_contesto", "ocupado", "fallida", "cancelada", "vencida",
];
export const ESTADOS_FINALES: readonly EstadoLlamada[] = [
  "contestada", "no_contesto", "ocupado", "fallida", "cancelada", "vencida",
];

/** Lo que la central puede informar de una llamada que marcó. */
export type ResultadoCentral = "contestada" | "no_contesto" | "ocupado" | "fallida";
export const RESULTADOS_CENTRAL: readonly ResultadoCentral[] = ["contestada", "no_contesto", "ocupado", "fallida"];

/** Tecla que marcó el conductor (solo una central con menú de voz la puede leer). */
export type Opcion = "1" | "2";
export const SIGNIFICADO_OPCION: Record<Opcion, string> = {
  "1": "ya está en ruta",
  "2": "pide hablar con el coordinador",
};

// ─── ¿TOCA LLAMAR? ─────────────────────────────────────────────────────────────

/** Minutos después de la hora efectivos (≥ 0). */
export function minutosLlamada(cfg: CfgPaso): number {
  const n = Number(cfg?.umbral);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : LLAMADA_MIN_DEFECTO;
}

/**
 * ¿Hay que poner en cola la llamada de este servicio AHORA? Desde la hora + su umbral, durante
 * `VENTANA_LLAMADA_MIN`, y solo mientras siga sin iniciar. El mismo reloj del «ya debió iniciar».
 */
export function juzgarLlamada(s: ServicioEscalera, cfg: CfgPaso, reloj: RelojEscalera): CodigoPaso {
  if (!cfg?.activo) return "apagado";
  if (!sinIniciar(s.estado)) return "fuera_de_estado";
  const inicio = inicioDe(s);
  if (inicio == null) return "sin_hora";
  const desde = inicio + minutosLlamada(cfg) * 60_000;
  if (reloj.ahoraMs < desde) return "aun_no";
  if (reloj.ahoraMs >= desde + VENTANA_LLAMADA_MIN * 60_000) return "paso_la_ventana";
  return "toca";
}

/** Hasta cuándo vale la llamada de este servicio (ms UTC), o null sin hora. */
export function venceLlamadaMs(s: ServicioEscalera, cfg: CfgPaso): number | null {
  const inicio = inicioDe(s);
  if (inicio == null) return null;
  return inicio + (minutosLlamada(cfg) + VENTANA_LLAMADA_MIN) * 60_000;
}

/**
 * El número al que marca la central: celular de Perú en E.164, o null. Un número que no se
 * entiende no se marca: llamar a un número mal escrito es despertar a un extraño a las 5 am.
 */
export function telefonoParaLlamar(raw?: string | null): string | null {
  const dig = String(raw ?? "").replace(/\D/g, "");
  const nacional = dig.length === 9 ? dig : dig.length === 11 && dig.startsWith("51") ? dig.slice(2) : null;
  if (!nacional || !nacional.startsWith("9")) return null;
  return `+51${nacional}`;
}

// ─── LO QUE DICE LA LLAMADA ───────────────────────────────────────────────────

const UNIDADES = [
  "cero", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve",
  "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis", "diecisiete", "dieciocho", "diecinueve",
  "veinte", "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete", "veintiocho", "veintinueve",
];
const DECENAS: Record<number, string> = { 3: "treinta", 4: "cuarenta", 5: "cincuenta" };

/** 0..59 en palabras. */
export function numeroEnPalabras(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 59) return String(n);
  if (n < 30) return UNIDADES[n];
  const d = Math.floor(n / 10), u = n % 10;
  return u === 0 ? DECENAS[d] : `${DECENAS[d]} y ${UNIDADES[u]}`;
}

const HORAS = ["doce", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve", "diez", "once"];

/**
 * «06:30» → «las seis y treinta de la mañana». La hora va en palabras porque la lee una voz
 * sintética: «06:30» en cifras se lee «cero seis treinta», y una hora mal dicha a las 5 am es
 * una llamada que confunde en vez de ayudar. Null si no es una hora.
 */
export function horaHablada(hhmm?: string | null): string | null {
  const min = hhmmAMinutos(String(hhmm ?? "").slice(0, 5));
  if (min == null) return null;
  const h = Math.floor(min / 60), m = min % 60;
  const h12 = HORAS[h % 12];
  const articulo = h % 12 === 1 ? "la" : "las";
  const minutos = m === 0 ? " en punto" : ` y ${numeroEnPalabras(m)}`;
  const parte = h < 6 ? "de la madrugada" : h < 12 ? "de la mañana" : h < 19 ? "de la tarde" : "de la noche";
  return `${articulo} ${h12}${minutos} ${parte}`;
}

export type TextoLlamada = {
  /** Lo que dice la llamada, en una voz: saludo, el servicio y UNA orden. */
  mensaje: string;
  /** El menú de teclas. Solo lo usa una central que puede leerlas (Asterisk); el resto lo ignora. */
  menu: string;
};

/**
 * El texto de la llamada. De tú, como los WhatsApp al conductor. El nombre de la empresa sale del
 * perfil (este ERP se vende); sin él, «la central de operaciones».
 */
export function textoLlamada(d: { nombre?: string | null; hora?: string | null; origen?: string | null; empresa?: string | null }): TextoLlamada {
  const nombre = String(d.nombre ?? "").trim().split(/\s+/)[0] || "";
  const quien = String(d.empresa ?? "").trim() ? `la central de ${String(d.empresa).trim()}` : "la central de operaciones";
  const hora = horaHablada(d.hora);
  const origen = String(d.origen ?? "").trim();
  const servicio = `Tu servicio${hora ? ` de ${hora}` : ""}${origen ? `, desde ${origen},` : ""} ya debió iniciar.`;
  const mensaje = `Hola${nombre ? ` ${nombre}` : ""}. Te llama ${quien}. ${servicio} Abre el app del conductor y pulsa INICIAR.`
    .replace(/\s+/g, " ").trim();
  return {
    mensaje,
    menu: "Si ya estás en ruta, marca uno. Para hablar con el coordinador, marca dos.",
  };
}

// ─── LO QUE INFORMA LA CENTRAL ────────────────────────────────────────────────

export type ResultadoLeido = {
  estado: ResultadoCentral;
  duracion_seg: number | null;
  opcion: Opcion | null;
  detalle: string | null;
};

/**
 * Valida lo que manda la central. Lo que no se entiende se RECHAZA (400): un resultado inventado
 * es peor que ninguno, porque el coordinador lo lee como un hecho.
 */
export function leerResultado(b: unknown): { ok: true; resultado: ResultadoLeido } | { ok: false; error: string } {
  const o = (b ?? {}) as Record<string, unknown>;
  const estado = String(o.estado ?? "") as ResultadoCentral;
  if (!RESULTADOS_CENTRAL.includes(estado)) return { ok: false, error: `estado inválido (usa: ${RESULTADOS_CENTRAL.join(", ")})` };
  let duracion: number | null = null;
  if (o.duracion_seg != null && o.duracion_seg !== "") {
    const n = Number(o.duracion_seg);
    if (!Number.isFinite(n) || n < 0 || n > 3600) return { ok: false, error: "duracion_seg inválida (0..3600)" };
    duracion = Math.round(n);
  }
  let opcion: Opcion | null = null;
  if (o.opcion != null && o.opcion !== "") {
    const s = String(o.opcion);
    if (s !== "1" && s !== "2") return { ok: false, error: "opcion inválida (1 o 2)" };
    if (estado !== "contestada") return { ok: false, error: "una opción solo se marca en una llamada contestada" };
    opcion = s;
  }
  const detalle = o.detalle == null ? null : Array.from(String(o.detalle).replace(/[\r\n\t]+/g, " ").trim()).slice(0, 200).join("") || null;
  return { ok: true, resultado: { estado, duracion_seg: duracion, opcion, detalle } };
}

/**
 * Qué queda después de un intento. Contestó → listo. No contestó, ocupado o no pudo marcar → se
 * reintenta si quedan intentos, el servicio sigue sin iniciar y el reintento cae antes de que
 * venza; si no, queda el resultado.
 */
export function planTrasResultado(
  fila: { intentos: number; max_intentos?: number | null; vence_en?: string | null },
  estado: ResultadoCentral,
  ahoraMs: number,
  sigueSinIniciar: boolean,
): { estado: EstadoLlamada; proximoIntentoMs: number | null } {
  if (estado === "contestada") return { estado, proximoIntentoMs: null };
  const max = Number.isFinite(Number(fila.max_intentos)) && Number(fila.max_intentos) > 0 ? Number(fila.max_intentos) : MAX_INTENTOS;
  const vence = Date.parse(String(fila.vence_en ?? ""));
  const proximo = ahoraMs + REINTENTO_MIN * 60_000;
  if (sigueSinIniciar && fila.intentos < max && Number.isFinite(vence) && proximo < vence) {
    return { estado: "pendiente", proximoIntentoMs: proximo };
  }
  return { estado, proximoIntentoMs: null };
}

// ─── ¿ESTÁ CONECTADA LA CENTRAL? ──────────────────────────────────────────────

export type EstadoCentral = { conectada: boolean; codigo: "conectada" | "sin_conexion" | "nunca"; texto: string };

export function estadoCentral(ultimoLatido: string | null | undefined, ahoraMs: number): EstadoCentral {
  const ms = Date.parse(String(ultimoLatido ?? ""));
  if (!Number.isFinite(ms)) {
    return { conectada: false, codigo: "nunca", texto: "La central de llamadas todavía no se ha conectado nunca." };
  }
  const min = Math.max(0, Math.round((ahoraMs - ms) / 60_000));
  if (ahoraMs - ms <= LATIDO_VIVO_MIN * 60_000) {
    return { conectada: true, codigo: "conectada", texto: "Central de llamadas conectada." };
  }
  const hace = min < 60 ? `${min} min` : min < 1440 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} día(s)`;
  return { conectada: false, codigo: "sin_conexion", texto: `La central de llamadas no se conecta desde hace ${hace}.` };
}

// ─── CÓMO SE LEE DESPUÉS ──────────────────────────────────────────────────────

export type FilaLlamada = {
  estado?: string | null;
  intentos?: number | null;
  created_at?: string | null;
  tomada_en?: string | null;
  terminada_en?: string | null;
  proximo_intento_en?: string | null;
  duracion_seg?: number | null;
  opcion?: string | null;
  detalle?: string | null;
  motivo?: string | null;
};

export type CodigoLectura = EstadoLlamada | "desconocido";

function duracionTexto(seg?: number | null): string {
  const s = Number(seg);
  if (!Number.isFinite(s) || s <= 0) return "";
  return ` (${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")})`;
}

function horaDe(iso?: string | null): string | null {
  const ms = Date.parse(String(iso ?? ""));
  return Number.isFinite(ms) ? minutosAHhmm(minutoDelDiaLima(ms)) : null;
}

/** Qué pasó con una llamada, en una frase. La usan la ficha y la evidencia al coordinador. */
export function lecturaLlamada(f: FilaLlamada): { codigo: CodigoLectura; texto: string; hora: string | null } {
  const estado = String(f.estado ?? "") as EstadoLlamada;
  const n = Number(f.intentos) || 0;
  const intentos = n > 1 ? ` (${n} intentos)` : "";
  const hora = horaDe(f.terminada_en ?? f.tomada_en ?? f.created_at);
  switch (estado) {
    case "pendiente":
      return n > 0
        ? { codigo: estado, texto: `No contestó; se vuelve a llamar a las ${horaDe(f.proximo_intento_en) ?? "—"}`, hora }
        : { codigo: estado, texto: "En cola, esperando a la central", hora };
    case "marcando":
      return { codigo: estado, texto: "Llamando…", hora };
    case "contestada": {
      const op = f.opcion === "1" || f.opcion === "2" ? ` y marcó ${f.opcion}: ${SIGNIFICADO_OPCION[f.opcion]}` : "";
      return { codigo: estado, texto: `Contestó${duracionTexto(f.duracion_seg)}${op}`, hora };
    }
    case "no_contesto":
      return { codigo: estado, texto: `No contestó${intentos}`, hora };
    case "ocupado":
      return { codigo: estado, texto: `Ocupado${intentos}`, hora };
    case "fallida":
      return { codigo: estado, texto: `No salió: ${f.detalle || "la central no pudo marcar"}`, hora };
    case "cancelada":
      return { codigo: estado, texto: `No se llamó: ${f.detalle || "el servicio ya se inició"}`, hora };
    case "vencida":
      return { codigo: estado, texto: "No salió: la central no la tomó a tiempo (¿está conectada?)", hora };
    default:
      return { codigo: "desconocido", texto: "Estado desconocido", hora };
  }
}

/**
 * La llamada en la evidencia al coordinador: una frase corta, en una línea (va dentro de un
 * parámetro de plantilla). Vacía si no hubo llamada. Se toma la más reciente.
 */
export function fraseLlamadaCoordinador(filas: FilaLlamada[]): string {
  const deInicio = filas.filter((f) => !f.motivo || f.motivo === CLAVE_LLAMADA);
  if (deInicio.length === 0) return "";
  const ultima = [...deInicio].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))).pop()!;
  const l = lecturaLlamada(ultima);
  const t = l.texto.charAt(0).toLowerCase() + l.texto.slice(1);
  const s = `Llamada${l.hora ? ` ${l.hora}` : ""}: ${t}.`.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ");
  // El detalle lo escribe la central: se acota para que no se coma el resto de la evidencia.
  return s.length > LARGO_FRASE_LLAMADA ? `${Array.from(s).slice(0, LARGO_FRASE_LLAMADA - 1).join("")}…` : s;
}

/** Largo máximo de la frase de la llamada dentro de la evidencia al coordinador. */
export const LARGO_FRASE_LLAMADA = 110;

/**
 * La evidencia COMPLETA que recibe el coordinador: lo que se le mandó por WhatsApp y si le llegó,
 * y al final, entera, la llamada. El resumen de los WhatsApp se arma con el espacio que deja la
 * llamada (y ese recorta lo más antiguo, nunca su conclusión). La usan el motor
 * (lib/escalera-inicio-datos.ts) y la prueba de avisos (lib/escalera-muestra.ts): una prueba
 * armada distinto mostraría un mensaje que nunca llega así.
 */
export function evidenciaConLlamada(
  filas: FilaAviso[], llamadas: FilaLlamada[], ahoraMs: number, maxLargo: number,
): ResumenAvisos {
  const frase = fraseLlamadaCoordinador(llamadas);
  const espacio = frase ? Math.max(80, maxLargo - frase.length - 1) : maxLargo;
  const r = resumenAvisosConductor(filas, ahoraMs, espacio);
  return { ...r, texto: [r.texto, frase].filter(Boolean).join(" ") };
}
