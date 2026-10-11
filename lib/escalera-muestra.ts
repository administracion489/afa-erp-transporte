// lib/escalera-muestra.ts — «PROBAR LOS AVISOS»: los MISMOS mensajes que recibe un conductor
// que no pulsa INICIAR (y los del coordinador), con datos de ejemplo y en el orden en que
// llegan, para mandarlos a UN número y verlos como los ve quien los recibe.
//
// Lo pidió el dueño (11-10-2026): «mándame todos los mensajes como llegan, a mi número, como
// prueba de cómo está». Módulo PURO: no lee la base ni envía nada. Lo importan la pantalla
// (/configuracion/operaciones, que enseña la lista ANTES de mandar) y /api/alertas-flota/prueba,
// que la vuelve a calcular en el servidor con la configuración de la base. Del navegador solo se
// acepta QUÉ mensajes mandar y a qué número; nunca la plantilla ni el texto.
//
// LA REGLA: cada mensaje se arma con la MISMA plantilla y los MISMOS parámetros, en el mismo
// orden, que su bloque del motor (/api/alertas-flota/tick y /api/alertas-flota/inicio). Una
// prueba que compone su propio texto prueba otra cosa. Si el motor cambia los parámetros de un
// aviso, esta lista tiene que cambiar con él: scripts/prueba-escalera-muestra.mts los fija contra
// el código del motor copiado literal.
//
// «COMO ESTÁ» ES LA CONFIGURACIÓN DE HOY. Un aviso apagado se lista APAGADO y sale desmarcado
// (se puede mandar igual, como vista previa de su texto); uno cuya fila no existe se nombra con
// el SQL que falta. Mandar los apagados como si salieran haría creer que salen.

import {
  LARGO_EVIDENCIA_COORDINADOR, minutosIniciaAhora, minutosDebioIniciar,
  type FilaAviso, type TextoPush,
} from "@/lib/escalera-inicio";
import { hhmmAMinutos, limaAUtcMs } from "@/lib/alertas-horario";
import { CLAVE_LLAMADA, evidenciaConLlamada, minutosLlamada, type FilaLlamada } from "@/lib/llamadas-central";

/** Lo que el plan necesita de cada fila de `alerta_config` (más cuántos contactos la reciben). */
export type CfgMuestra = {
  clave: string;
  activo: boolean;
  modo_tiempo?: string | null;
  min_anticipacion?: number | null;
  hora_fija?: string | null;
  umbral?: number | null;
  plantilla?: string | null;
  plantilla_directorio?: string | null;
  notifica_conductor?: boolean | null;
  canal_conductor_whatsapp?: boolean | null;
  usa_directorio?: boolean | null;
  /**
   * Contactos del directorio que de verdad recibirían el aviso (activos, con teléfono y
   * marcados en la tarjeta). Lo calcula quien llama: el servidor con `directorioDe`, la
   * pantalla con la lista que ya tiene cargada.
   */
  contactos?: number | null;
};

/** Los datos de ejemplo con los que se arman los mensajes. */
export type DatosMuestra = {
  /** Nombre corto que va como el del conductor. */
  nombre: string;
  /** Hora del servicio de ejemplo ("HH:MM"). */
  hora: string;
  origen: string;
  destino: string;
  /** Teléfono de contingencia, tal como sale en los mensajes reales. */
  telContingencia: string;
  /** Fecha (Lima) del servicio de ejemplo: fecha la evidencia que recibe el coordinador. */
  fecha: string;
};

export type Para = "conductor" | "coordinador";
/** Por dónde sale: un WhatsApp de plantilla, o la llamada de la central propia. */
export type CanalMuestra = "whatsapp" | "llamada";

/** Por qué un mensaje sale o no sale HOY. Se declara: la pantalla enruta por código. */
export type CodigoMuestra =
  | "sale"             // hoy sale así
  | "apagado"          // la tarjeta está desactivada
  | "mudo"             // activa, pero con «Al ocurrir» este aviso no se dispara nunca
  | "no_al_conductor"  // la tarjeta no le escribe al conductor
  | "sin_whatsapp"     // al conductor le sale por el app o el correo, no por WhatsApp
  | "sin_contactos"    // al coordinador: ningún contacto marcado en su tarjeta
  | "solo_si_gps"      // depende de que el GPS vea al conductor en el paradero
  | "sin_plantilla"    // la tarjeta no tiene plantilla: no hay texto que mandar
  | "sin_config";      // la fila no existe en la base (falta un SQL)

export type MensajeMuestra = {
  /** Identificador estable (no depende de los datos de ejemplo): es lo que elige la pantalla. */
  id: string;
  clave: string;
  para: Para;
  titulo: string;
  /** Cuándo llega, relativo a la hora del servicio ("90 min antes", "1 min después"). */
  cuando: string;
  /** Minutos respecto a la hora del servicio (negativo = antes). Ordena la lista. */
  minuto: number;
  plantilla: string | null;
  parametros: string[];
  codigo: CodigoMuestra;
  /** Qué significa el código, en una frase. */
  nota: string;
  canal: CanalMuestra;
  /**
   * Se puede mandar, aunque hoy no salga (vista previa de su texto): un WhatsApp con plantilla, o
   * la llamada si su fila existe (la de prueba se pone en la cola de la central).
   */
  enviable: boolean;
  /** Marcado por defecto: solo lo que hoy SALE. */
  marcado: boolean;
};

/** El SQL que crea las filas de los dos peldaños del cron de un minuto. */
export const SQL_ESCALERA = "supabase/alertas-escalera-inicio.sql";
/** El que crea las filas de los avisos pre-inicio y del coordinador. */
export const SQL_OPERATIVAS = "supabase/alertas-operativas.sql";
/** El que crea la cola y la tarjeta de la llamada de la central propia. */
export const SQL_LLAMADAS = "supabase/llamadas-01-central.sql";

/** Plantilla del coordinador cuando la tarjeta no declara una (la misma caída del tick). */
const PLANTILLA_COORDINADOR = "coordinador_alerta";

/** El mismo `rutaDe` del tick y del cron: «origen → destino», o «Servicio». */
function rutaDe(d: Pick<DatosMuestra, "origen" | "destino">): string {
  return [d.origen, d.destino].filter(Boolean).join(" → ") || "Servicio";
}

/** Nombre + primer apellido, como `nombreCorto` del motor. */
export function nombreCortoMuestra(n?: string | null): string {
  return String(n ?? "").trim().split(/\s+/).slice(0, 2).join(" ") || "Conductor";
}

/**
 * Los datos de ejemplo. El nombre es el de quien prueba (así se reconoce el mensaje en su propio
 * teléfono), y el punto de salida dice «de prueba»: si el mensaje se reenvía, nadie lo confunde
 * con un servicio real.
 */
export function datosDeMuestra(args: { nombreUsuario?: string | null; fecha: string; telContingencia: string }): DatosMuestra {
  return {
    nombre: nombreCortoMuestra(args.nombreUsuario),
    hora: "06:30",
    origen: "Paradero de prueba",
    destino: "Destino de prueba",
    telContingencia: args.telContingencia,
    fecha: args.fecha,
  };
}

// ─── LOS PASOS, EN EL ORDEN DEL MOTOR ──────────────────────────────────────────

type Reloj =
  /** `enViaRecordatorio`: minutos antes (min_anticipacion) o una hora fija. */
  | { tipo: "antes"; defecto: number; minutos?: (cfg: CfgMuestra) => number }
  /** La hora del servicio + su umbral. */
  | { tipo: "despues"; defecto: number; minutos?: (cfg: CfgMuestra) => number }
  /** Lo dispara el semáforo de puntualidad: el GPS ve al bus en el paradero. */
  | { tipo: "gps" };

type Paso = {
  id: string;
  clave: string;
  para: Para;
  canal?: CanalMuestra;
  titulo: string;
  reloj: Reloj;
  sql: string;
  /** Los parámetros, armados EXACTAMENTE como en su bloque del motor. */
  parametros: (d: DatosMuestra, cfg: CfgMuestra, evidencia: string) => string[];
};

const PASOS: Paso[] = [
  {
    // Tick, bloque 3b (avisoPreInicio): [nombre, hora, origenTexto].
    id: "proximo_inicio", clave: "proximo_inicio", para: "conductor", titulo: "Próximo a iniciar",
    reloj: { tipo: "antes", defecto: 90 }, sql: SQL_OPERATIVAS,
    parametros: (d) => [d.nombre, d.hora, d.origen || rutaDe(d)],
  },
  {
    id: "recuerda_iniciar", clave: "recuerda_iniciar", para: "conductor", titulo: "Recuerda iniciar",
    reloj: { tipo: "antes", defecto: 30 }, sql: SQL_OPERATIVAS,
    parametros: (d) => [d.nombre, d.hora, d.origen || rutaDe(d)],
  },
  {
    // Tick, bloque 3c: solo conductores PROPIOS (el bloque filtra tipo_asignacion = propio).
    id: "alerta_no_inicio_previa", clave: "alerta_no_inicio_previa", para: "coordinador", titulo: "Falta iniciar recorrido",
    reloj: { tipo: "antes", defecto: 25 }, sql: SQL_OPERATIVAS,
    parametros: (d, _cfg, ev) => ["Falta iniciar recorrido", d.nombre, `${rutaDe(d)} ${d.hora}`,
      `Faltan ~25 min y el conductor aún no confirma salida (sin GPS) en la app.${ev ? ` ${ev}` : ""}`],
  },
  {
    // Cron de un minuto: [nombre, hora, origen].
    id: "inicia_ahora", clave: "inicia_ahora", para: "conductor", titulo: "Inicia ahora",
    reloj: { tipo: "antes", defecto: 5, minutos: (cfg) => minutosIniciaAhora(cfg) }, sql: SQL_ESCALERA,
    parametros: (d) => [d.nombre, d.hora, d.origen || rutaDe(d)],
  },
  {
    // Tick, bloque 4b: solo si el GPS lo ve en el paradero sin iniciar.
    id: "en_punto_sin_iniciar", clave: "en_punto_sin_iniciar", para: "conductor", titulo: "En el punto, sin iniciar",
    reloj: { tipo: "gps" }, sql: "supabase/retrasos.sql",
    parametros: (d) => [d.nombre, d.hora, d.origen || rutaDe(d)],
  },
  {
    // Cron de un minuto: [nombre, hora, rutaDe(r), telConting].
    id: "debio_iniciar", clave: "debio_iniciar", para: "conductor", titulo: "Ya debió iniciar",
    reloj: { tipo: "despues", defecto: 1, minutos: (cfg) => minutosDebioIniciar(cfg) }, sql: SQL_ESCALERA,
    parametros: (d) => [d.nombre, d.hora, rutaDe(d), d.telContingencia],
  },
  {
    // Cron de un minuto: la llamada va a la COLA de la central propia (no es una plantilla).
    id: "llamada_inicio", clave: CLAVE_LLAMADA, para: "conductor", canal: "llamada", titulo: "Llamada de la central",
    reloj: { tipo: "despues", defecto: 3, minutos: (cfg) => minutosLlamada(cfg) }, sql: SQL_LLAMADAS,
    parametros: () => [],
  },
  {
    // Tick, bloque 4: al conductor [nombre, hora, ruta, telConting]…
    id: "no_inicio", clave: "no_inicio", para: "conductor", titulo: "No inició",
    reloj: { tipo: "despues", defecto: 10 }, sql: SQL_OPERATIVAS,
    parametros: (d) => [d.nombre, d.hora, rutaDe(d), d.telContingencia],
  },
  {
    // …y al directorio, con lo que ya se le mandó al conductor y si le llegó.
    id: "no_inicio:coordinador", clave: "no_inicio", para: "coordinador", titulo: "No inició a tiempo",
    reloj: { tipo: "despues", defecto: 10 }, sql: SQL_OPERATIVAS,
    parametros: (d, cfg, ev) => ["No inició a tiempo", d.nombre, `${rutaDe(d)} ${d.hora}`,
      `Pasaron ${cfg.umbral ?? 10}+ min de la hora y no marcó inicio.${ev ? ` ${ev}` : ""}`],
  },
];

/** Los ids que la pantalla puede pedir (estables, no dependen de la configuración). */
export const IDS_MUESTRA = PASOS.map((p) => p.id);

const NOTA: Record<CodigoMuestra, string> = {
  sale: "Hoy sale así.",
  apagado: "Apagado: hoy no sale. Puedes mandarlo igual para ver su texto.",
  mudo: "Activo pero mudo: con «Al ocurrir» este aviso no se dispara nunca. Hoy no sale.",
  no_al_conductor: "Su tarjeta no le escribe al conductor: hoy no sale.",
  sin_whatsapp: "Al conductor le sale por el app o el correo, no por WhatsApp.",
  sin_contactos: "Ningún contacto marcado en su tarjeta: hoy no le llega a nadie.",
  solo_si_gps: "Sale solo si el GPS ve al conductor en el paradero sin haber pulsado INICIAR.",
  sin_plantilla: "Su tarjeta no tiene plantilla de WhatsApp: no hay texto que mandar.",
  sin_config: "Este aviso todavía no existe en la base.",
};
/** La llamada dice otra cosa cuando sale: depende de que la central esté conectada. */
const NOTA_LLAMADA_SALE = "Hoy sale así, si la central de llamadas está conectada. La de prueba se pone en su cola.";

function cfgDe(cfgs: CfgMuestra[] | Map<string, CfgMuestra>, clave: string): CfgMuestra | null {
  if (cfgs instanceof Map) return cfgs.get(clave) ?? null;
  return cfgs.find((c) => c.clave === clave) ?? null;
}

/** Cuándo llega y en qué minuto (relativo a la hora del servicio). */
function relojDe(p: Paso, cfg: CfgMuestra | null, horaMin: number): { cuando: string; minuto: number; mudo: boolean } {
  const r = p.reloj;
  if (r.tipo === "gps") return { cuando: "si el GPS lo ve en el paradero", minuto: -2, mudo: false };
  if (r.tipo === "despues") {
    const m = cfg && r.minutos ? r.minutos(cfg) : Math.round(Number(cfg?.umbral ?? r.defecto));
    const n = Number.isFinite(m) && m >= 0 ? m : r.defecto;
    return { cuando: `${n} min después`, minuto: n, mudo: false };
  }
  // «antes»: lo despacha `enViaRecordatorio`, que solo sabe anticipación u hora fija.
  const modo = String(cfg?.modo_tiempo ?? "anticipacion");
  if (modo === "hora_fija") {
    const hf = hhmmAMinutos(cfg?.hora_fija ?? null);
    if (hf != null) return { cuando: `a las ${String(cfg?.hora_fija).slice(0, 5)}`, minuto: hf - horaMin, mudo: false };
  }
  const m = cfg && r.minutos ? r.minutos(cfg) : Math.round(Number(cfg?.min_anticipacion ?? r.defecto));
  const n = Number.isFinite(m) && m > 0 ? m : r.defecto;
  return { cuando: `${n} min antes`, minuto: -n, mudo: modo !== "anticipacion" && modo !== "hora_fija" };
}

/**
 * La lista de mensajes de la escalera, en el orden en que llegan, con la configuración de hoy.
 * Cada uno lleva su plantilla y sus parámetros listos para enviar, y por qué sale o no sale.
 */
export function planDeMuestra(cfgs: CfgMuestra[] | Map<string, CfgMuestra>, d: DatosMuestra): MensajeMuestra[] {
  const horaMin = hhmmAMinutos(d.hora) ?? 390;
  const inicioMs = limaAUtcMs(d.fecha, d.hora) ?? Date.UTC(2026, 0, 1, 11, 30);

  // Primero el reloj y el código de cada paso; la evidencia del coordinador sale de los pasos
  // del conductor que SALEN antes que él.
  const base = PASOS.map((p) => {
    const cfg = cfgDe(cfgs, p.clave);
    const { cuando, minuto, mudo } = relojDe(p, cfg, horaMin);
    const canal: CanalMuestra = p.canal ?? "whatsapp";
    const plantilla = !cfg || canal === "llamada" ? null
      : p.para === "conductor" ? (cfg.plantilla || null)
      : (cfg.plantilla_directorio || PLANTILLA_COORDINADOR);
    let codigo: CodigoMuestra;
    if (!cfg) codigo = "sin_config";
    else if (canal === "whatsapp" && !plantilla) codigo = "sin_plantilla";
    else if (!cfg.activo) codigo = "apagado";
    else if (mudo) codigo = "mudo";
    else if (p.para === "conductor" && cfg.notifica_conductor === false) codigo = "no_al_conductor";
    else if (canal === "whatsapp" && p.para === "conductor" && cfg.canal_conductor_whatsapp === false) codigo = "sin_whatsapp";
    else if (p.para === "coordinador" && (cfg.usa_directorio === false || !(Number(cfg.contactos) > 0))) codigo = "sin_contactos";
    else if (p.reloj.tipo === "gps") codigo = "solo_si_gps";
    else codigo = "sale";
    return { p, cfg, canal, cuando, minuto, plantilla, codigo };
  });

  // Filas de registro de ejemplo de lo que ya le llegó al conductor: WhatsApp entregado (el
  // primero, además, leído). Es lo que el motor lee de `notificaciones_enviadas` (y de la cola
  // de llamadas) para la evidencia, y con la MISMA función (`evidenciaConLlamada`).
  const filaDe = (minuto: number, clave: string, primero: boolean, recien: boolean): FilaAviso => {
    const enviado = inicioMs + minuto * 60_000;
    return {
      tipo: "whatsapp", estado: "enviado", alerta_clave: clave,
      created_at: new Date(enviado).toISOString(),
      entregado_en: recien ? null : new Date(enviado + 30_000).toISOString(),
      leido_en: !recien && primero ? new Date(enviado + 120_000).toISOString() : null,
    };
  };
  const evidenciaPara = (minutoCoord: number, clave: string): string => {
    const previos = base
      .filter((b) => b.p.para === "conductor" && b.canal === "whatsapp" && b.codigo === "sale"
        && (b.minuto < minutoCoord || (b.minuto === minutoCoord && b.p.clave === clave)))
      .sort((a, b) => a.minuto - b.minuto);
    // En el tick, el aviso al conductor de ESTE peldaño sale justo antes de leer la evidencia:
    // aparece recién enviado, sin confirmación de entrega todavía.
    const filas = previos.map((b, i) => filaDe(b.minuto, b.p.clave, i === 0, b.minuto === minutoCoord));
    // La llamada, si sale antes: de ejemplo, que no contestó en sus dos intentos.
    const llamada = base.find((b) => b.canal === "llamada" && b.codigo === "sale" && b.minuto < minutoCoord);
    const llamadas: FilaLlamada[] = llamada ? [{
      estado: "no_contesto", intentos: 2, motivo: CLAVE_LLAMADA,
      created_at: new Date(inicioMs + llamada.minuto * 60_000).toISOString(),
      terminada_en: new Date(inicioMs + (llamada.minuto + 3) * 60_000).toISOString(),
    }] : [];
    return evidenciaConLlamada(filas, llamadas, inicioMs + minutoCoord * 60_000 + 5_000, LARGO_EVIDENCIA_COORDINADOR).texto;
  };

  const lista: MensajeMuestra[] = base.map((b) => {
    const cfg: CfgMuestra = b.cfg ?? { clave: b.p.clave, activo: false };
    const evidencia = b.p.para === "coordinador" ? evidenciaPara(b.minuto, b.p.clave) : "";
    const parametros = b.plantilla ? b.p.parametros(d, cfg, evidencia) : [];
    const nota = b.codigo === "sin_config" ? `${NOTA.sin_config} Falta correr ${b.p.sql}.`
      : b.canal === "llamada" && b.codigo === "sale" ? NOTA_LLAMADA_SALE
      : NOTA[b.codigo];
    return {
      id: b.p.id,
      clave: b.p.clave,
      para: b.p.para,
      titulo: b.p.titulo,
      cuando: b.cuando,
      minuto: b.minuto,
      plantilla: b.plantilla,
      parametros,
      codigo: b.codigo,
      nota,
      canal: b.canal,
      enviable: b.canal === "llamada" ? !!b.cfg : !!b.plantilla,
      marcado: b.codigo === "sale",
    };
  });

  // Estable: a igual minuto, el conductor antes que el coordinador (es el orden del tick).
  return lista
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.minuto - b.m.minuto
      || (a.m.para === b.m.para ? 0 : a.m.para === "conductor" ? -1 : 1)
      || a.i - b.i)
    .map((x) => x.m);
}

// ─── EL NÚMERO DE PRUEBA ──────────────────────────────────────────────────────

export type TelefonoMuestra =
  | { ok: true; e164: string; visible: string }
  | { ok: false; motivo: string };

/**
 * El número al que se manda la prueba: un celular de Perú. Se rechaza lo demás a propósito:
 * cada mensaje de plantilla se cobra, y un número mal tecleado es plata enviada a un extraño.
 */
export function telefonoDeMuestra(raw?: string | null): TelefonoMuestra {
  const dig = String(raw ?? "").replace(/\D/g, "");
  let nacional: string | null = null;
  if (dig.length === 9) nacional = dig;
  else if (dig.length === 11 && dig.startsWith("51")) nacional = dig.slice(2);
  if (!nacional) return { ok: false, motivo: "Escribe un celular de Perú de 9 dígitos (por ejemplo 987 654 321)." };
  if (!nacional.startsWith("9")) return { ok: false, motivo: "Tiene que ser un celular: empieza con 9." };
  return {
    ok: true,
    e164: `+51${nacional}`,
    visible: `+51 ${nacional.slice(0, 3)} ${nacional.slice(3, 6)} ${nacional.slice(6)}`,
  };
}

// ─── LA NOTIFICACIÓN DEL APP, DE PRUEBA ──────────────────────────────────────

/**
 * Segundos que espera la prueba de la notificación del app antes de salir: el tiempo de bloquear
 * el teléfono, para verla como llega de verdad (sobre la pantalla bloqueada, sonando). Con el
 * app abierta Android no la pinta él: la repinta el propio app.
 */
export const ESPERA_PUSH_PRUEBA_SEG = 10;

/** El texto de la notificación de prueba: el formato del «inicia ahora», diciendo que es prueba. */
export function textoPushPrueba(): TextoPush {
  return {
    titulo: "🚨 Prueba: tu servicio empieza en 5 min",
    cuerpo: "Así te avisaremos antes de cada servicio. Toca aquí y pulsa INICIAR (esto es solo una prueba).",
    requireInteraction: true,
    ttl: 300,
  };
}
