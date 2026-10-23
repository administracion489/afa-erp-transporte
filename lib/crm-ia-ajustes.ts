// Comportamiento del agente IA del CRM: lo que antes estaba fijo en el código y ahora se
// edita en /crm/agente → Ajustes. PURO (lo importan la pantalla y el motor).
//
// Vive en crm_agentes_ia.comportamiento (jsonb). Sin la columna, o con un valor raro, cada
// campo cae a su defecto: el comportamiento es byte a byte el que tenía AFA en el código.
// El ERP se vende: nada aquí nombra a AFA; el nombre sale del perfil de la empresa.
//
// UNA FUENTE POR COMPORTAMIENTO (20-10-2026). Cada tema que tiene un ajuste aquí (el trato, cuántas
// preguntas por mensaje, el resumen, el saludo, el horario de atención…) lo decide el AJUSTE, aunque
// «Sobre la empresa», la persona o los objetivos digan otra cosa: el prompt lo declara en «Ajustes
// del agente» y la pantalla avisa del choque con la frase exacta (lib/crm-ia-coherencia.ts). Y los
// textos que arma el CÓDIGO (la derivación, el «me falta» de traslados, el resumen) leen el MISMO
// ajuste: un trato de usted en el prompt y un mensaje del código que tutea son dos voces en el chat.

export type AjustesIA = {
  /** Saludo obligatorio en el primer mensaje del día (hora de Lima) en cada chat. */
  saludo_activo: boolean;
  saludo_manana: string;
  saludo_tarde: string;
  saludo_noche: string;
  /** Hora (0-23) desde la que se dice el saludo de la tarde / de la noche. */
  hora_tarde: number;
  hora_noche: number;
  /** Cómo se presenta. {empresa} = nombre del perfil. */
  presentarse_como: string;
  /** No decir que es una IA salvo que se lo pregunten. */
  ocultar_ia: boolean;
  /** Nunca decir «no encontré / no hay registros»: pedir datos y derivar. */
  no_decir_no_encontre: boolean;
  /** Cuántas veces puede pedir fecha / nº de servicio antes de derivar (0-3). */
  intentos_pedir_datos: number;
  /** Etiqueta que pone al derivar ("" = ninguna). */
  etiqueta_derivacion: string;
  /** Deja una nota interna 🔒 con el motivo y lo que pidió el cliente. */
  nota_interna_derivacion: boolean;
  /** Transcribe las notas de voz (requiere OPENAI_API_KEY). */
  transcribir_audios: boolean;
  /** Lee fotos y PDF que manda el cliente. */
  leer_archivos: boolean;
  /** Cuántos archivos / audios recientes mira en cada respuesta. */
  max_archivos: number;
  max_audios: number;
  /** Espera a que el cliente termine de escribir (segundos). */
  silencio_seg: number;
  silencio_completo_seg: number;
  espera_max_seg: number;
  /** Releer la conversación y no volver a pedir lo que el cliente ya dio. */
  recordar_datos: boolean;
  /** Lugares que no necesitan dirección exacta (el aeropuerto, terminales…). */
  lugares_conocidos: string;
  /** Cuántos mensajes recientes relee en cada respuesta. */
  mensajes_historial: number;
  /** El resumen del pedido (lo que ya dio el cliente). Cuándo, lo dice `resumen_cuando`. */
  resumen_pedido: boolean;
  /** «al_final»: UNA vez, cuando ya están todos los datos (mientras falten, solo se pide lo que
   *  falta, sin repetir lo ya dado). «cada_respuesta»: termina cada respuesta con el resumen y
   *  «Solo me falta» mientras el pedido esté incompleto. */
  resumen_cuando: ResumenCuando;
  /** Los datos que forman el pedido (lo que va en el resumen). */
  campos_pedido: string;
  /** Reglas extra del negocio, una por línea. */
  reglas_extra: string;
  /** Cómo trata al cliente: lo cumplen el modelo Y los textos que arma el código. */
  tratamiento: Tratamiento;
  /** Los datos que faltan: todos juntos o uno por mensaje (en el orden de los datos del pedido). */
  preguntas: ModoPreguntas;
  /** Título del resumen del pedido. "" = automático según el trato («📋 *Resumen de su solicitud*»). */
  resumen_titulo: string;
  /** Última línea del resumen cuando ya está todo. Admite {nombre} (primer nombre del cliente). */
  resumen_cierre: string;
  /** Lo que ofrece (tal cual) cuando el cliente solo saluda. "" = sin menú. */
  menu_saludo: string;
  /** Horario de atención del EQUIPO (no el de la IA: ese es hora_inicio/hora_fin del agente).
   *  Solo informa: al derivar fuera de él, la derivación dice cuándo responde un ejecutivo. */
  atencion_activa: boolean;
  /** Días de atención, 0 = domingo … 6 = sábado, únicos y ordenados. */
  atencion_dias: number[];
  /** "HH:MM" de Lima. Si hasta ≤ desde (o no hay días) se conserva tal cual y no se usa. */
  atencion_desde: string;
  atencion_hasta: string;
};

/** De usted (usted, su, le) o de tú (tú, tu, te). */
export type Tratamiento = "usted" | "tu";
export const TRATAMIENTOS: { valor: Tratamiento; etiqueta: string }[] = [
  { valor: "usted", etiqueta: "De usted (usted, su, le)" },
  { valor: "tu", etiqueta: "De tú (tú, tu, te)" },
];

/** Los datos que faltan: todos en un mensaje, o uno por mensaje. */
export type ModoPreguntas = "todo_junto" | "una_por_mensaje";
export const MODOS_PREGUNTAS: { valor: ModoPreguntas; etiqueta: string }[] = [
  { valor: "todo_junto", etiqueta: "Todos juntos, en un solo mensaje" },
  { valor: "una_por_mensaje", etiqueta: "Uno por mensaje, en el orden de los datos del pedido" },
];

/** Lo que necesita un texto que arma el código para hablar como el agente. */
/**
 * La voz de los textos que arma el código. `idioma` NO es un ajuste del agente: lo pone el código
 * (el idioma de la cotización o el del cliente, lib/idioma-cliente.ts) y `estiloDe` nunca lo llena.
 * Ausente = castellano, byte a byte lo de siempre.
 */
export type EstiloMensajes = { tratamiento: Tratamiento; preguntas: ModoPreguntas; idioma?: "es" | "en" };

export type ResumenCuando = "al_final" | "cada_respuesta";
export const RESUMEN_CUANDO: { valor: ResumenCuando; etiqueta: string }[] = [
  { valor: "al_final", etiqueta: "Solo al final, cuando ya tiene todos los datos" },
  { valor: "cada_respuesta", etiqueta: "Al final de cada respuesta, mientras falten datos" },
];

export const AJUSTES_DEFECTO: AjustesIA = {
  saludo_activo: true,
  saludo_manana: "Buenos días",
  saludo_tarde: "Buenas tardes",
  saludo_noche: "Buenas noches",
  hora_tarde: 12,
  hora_noche: 19,
  presentarse_como: "el asistente de {empresa}",
  ocultar_ia: true,
  no_decir_no_encontre: true,
  intentos_pedir_datos: 1,
  etiqueta_derivacion: "Para ejecutivo",
  nota_interna_derivacion: true,
  transcribir_audios: true,
  leer_archivos: true,
  max_archivos: 4,
  max_audios: 3,
  silencio_seg: 12,
  silencio_completo_seg: 4,
  espera_max_seg: 45,
  recordar_datos: true,
  lugares_conocidos: "el aeropuerto, los terminales terrestres, las estaciones, las plazas y los centros comerciales conocidos",
  mensajes_historial: 40,
  resumen_pedido: true,
  // «Al final» es lo que pide la regla del dueño («el resumen se hace únicamente al final»). Un
  // ajuste guardado antes de existir este campo también cae aquí: solo «cada_respuesta» escrito
  // a propósito pone el resumen en cada mensaje.
  resumen_cuando: "al_final",
  campos_pedido:
    "ruta (origen → destino, con la dirección de recojo), fecha y hora, número de pasajeros, equipaje, tipo de servicio (solo ida, ida y vuelta, por horas), nombre y empresa",
  reglas_extra: "",
  // De usted por defecto: es el trato que una empresa que vende transporte espera ver, y el que
  // pidió AFA («Tratamiento: Siempre de usted»). Quien quiera tutear lo elige en la pantalla.
  tratamiento: "usted",
  // «Todo junto» es lo que el agente hacía hasta hoy: un jsonb guardado antes de existir el campo
  // no cambia de comportamiento por correr este código.
  preguntas: "todo_junto",
  resumen_titulo: "",
  resumen_cierre: "Con esto ya tengo todo lo necesario",
  menu_saludo: "",
  // Nace apagado: declarar un horario cambia lo que dice la derivación, y eso lo decide una persona.
  atencion_activa: false,
  atencion_dias: [1, 2, 3, 4, 5],
  atencion_desde: "09:00",
  atencion_hasta: "18:00",
};

const entero = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
};
// Se corta por CARACTERES (no por unidades UTF-16: un emoji partido es basura) y se vuelve a
// recortar después de cortar: si el corte cae en un espacio, la segunda pasada lo quitaría y
// normalizar dejaría de ser idempotente.
const recortar = (t: string, max: number): string => {
  const c = Array.from(t);
  return c.length > max ? c.slice(0, max).join("").trim() : t;
};
const texto = (v: unknown, def: string, max = 500, vacioValido = false): string => {
  if (typeof v !== "string") return def;
  const t = recortar(v.trim(), max);
  return t || vacioValido ? t : def;
};
/** Como `texto`, pero en UNA línea: un título o un cierre con saltos rompería el formato del resumen. */
const linea = (v: unknown, def: string, max: number, vacioValido = false): string =>
  texto(typeof v === "string" ? v.replace(/\s+/g, " ") : v, def, max, vacioValido);
const bool = (v: unknown, def: boolean): boolean => (typeof v === "boolean" ? v : def);
const enLista = <T extends string>(v: unknown, opciones: { valor: T }[], def: T): T =>
  opciones.some((o) => o.valor === v) ? (v as T) : def;

/** "HH:MM" (o "H:MM", o "HH:MM:SS") → "HH:MM"; cualquier otra cosa → null. */
export function horaHHMM(v: unknown): string | null {
  const m = typeof v === "string" ? /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(v) : null;
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  return h <= 23 && mm <= 59 ? `${String(h).padStart(2, "0")}:${m[2]}` : null;
}

/** Días 0-6. Un valor que no es una lista de días se cae entero al defecto (no se rescata a medias:
 *  [1, "x"] no dice qué quiso la persona). Una lista VACÍA sí se conserva: es un horario sin días,
 *  que no se usa y que la pantalla avisa (atencionValida = false). */
function diasAtencion(v: unknown, def: number[]): number[] {
  if (!Array.isArray(v)) return [...def];
  const n = v.map((x) => (typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN));
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 6)) return [...def];
  return [...new Set(n)].sort((a, b) => a - b);
}

/** Cualquier valor (null, jsonb viejo, basura) → ajustes válidos. Idempotente. */
export function normalizarAjustes(raw: unknown): AjustesIA {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = AJUSTES_DEFECTO;
  const hora_tarde = entero(r.hora_tarde, d.hora_tarde, 1, 22);
  const hora_noche = Math.max(hora_tarde + 1, entero(r.hora_noche, d.hora_noche, 2, 23));
  const silencio_completo_seg = entero(r.silencio_completo_seg, d.silencio_completo_seg, 1, 60);
  const silencio_seg = Math.max(silencio_completo_seg, entero(r.silencio_seg, d.silencio_seg, 1, 60));
  return {
    saludo_activo: bool(r.saludo_activo, d.saludo_activo),
    saludo_manana: texto(r.saludo_manana, d.saludo_manana, 40),
    saludo_tarde: texto(r.saludo_tarde, d.saludo_tarde, 40),
    saludo_noche: texto(r.saludo_noche, d.saludo_noche, 40),
    hora_tarde,
    hora_noche,
    presentarse_como: texto(r.presentarse_como, d.presentarse_como, 120),
    ocultar_ia: bool(r.ocultar_ia, d.ocultar_ia),
    no_decir_no_encontre: bool(r.no_decir_no_encontre, d.no_decir_no_encontre),
    intentos_pedir_datos: entero(r.intentos_pedir_datos, d.intentos_pedir_datos, 0, 3),
    etiqueta_derivacion: texto(r.etiqueta_derivacion, d.etiqueta_derivacion, 30, true),
    nota_interna_derivacion: bool(r.nota_interna_derivacion, d.nota_interna_derivacion),
    transcribir_audios: bool(r.transcribir_audios, d.transcribir_audios),
    leer_archivos: bool(r.leer_archivos, d.leer_archivos),
    max_archivos: entero(r.max_archivos, d.max_archivos, 1, 8),
    max_audios: entero(r.max_audios, d.max_audios, 1, 6),
    silencio_seg,
    silencio_completo_seg,
    espera_max_seg: Math.max(silencio_seg, entero(r.espera_max_seg, d.espera_max_seg, 5, 120)),
    recordar_datos: bool(r.recordar_datos, d.recordar_datos),
    lugares_conocidos: texto(r.lugares_conocidos, d.lugares_conocidos, 400, true),
    mensajes_historial: entero(r.mensajes_historial, d.mensajes_historial, 10, 60),
    resumen_pedido: bool(r.resumen_pedido, d.resumen_pedido),
    resumen_cuando: RESUMEN_CUANDO.some((o) => o.valor === r.resumen_cuando) ? (r.resumen_cuando as ResumenCuando) : d.resumen_cuando,
    campos_pedido: texto(r.campos_pedido, d.campos_pedido, 600),
    reglas_extra: texto(r.reglas_extra, d.reglas_extra, 4000, true),
    tratamiento: enLista(r.tratamiento, TRATAMIENTOS, d.tratamiento),
    preguntas: enLista(r.preguntas, MODOS_PREGUNTAS, d.preguntas),
    resumen_titulo: linea(r.resumen_titulo, d.resumen_titulo, 80, true),
    resumen_cierre: linea(r.resumen_cierre, d.resumen_cierre, 160),
    menu_saludo: texto(r.menu_saludo, d.menu_saludo, 600, true),
    atencion_activa: bool(r.atencion_activa, d.atencion_activa),
    atencion_dias: diasAtencion(r.atencion_dias, d.atencion_dias),
    atencion_desde: horaHHMM(r.atencion_desde) ?? d.atencion_desde,
    atencion_hasta: horaHHMM(r.atencion_hasta) ?? d.atencion_hasta,
  };
}

/** El saludo que toca a esa hora de Lima (0-23). */
export function saludoParaHora(a: AjustesIA, hora: number): string {
  return hora < a.hora_tarde ? a.saludo_manana : hora < a.hora_noche ? a.saludo_tarde : a.saludo_noche;
}

/** Pone el primer nombre en una plantilla con {nombre}. Sin nombre, quita la coma o el espacio
 *  que quedaría colgando («¿Todo está correcto, {nombre}?» → «¿Todo está correcto?»,
 *  «{nombre}, ¿todo bien?» → «¿todo bien?»). Con nombre, o sin la llave, solo reemplaza: el texto
 *  que escribió el dueño no se toca más de lo necesario. */
export function ponerNombre(plantilla: string, nombre?: string | null): string {
  const n = String(nombre ?? "").trim().replace(/\s+/g, " ");
  const s = plantilla.replace(/\{nombre\}/g, () => n);
  if (n || !/\{nombre\}/.test(plantilla)) return s;
  return s
    .replace(/[ \t]*,[ \t]*(?=[.!?…;:)]|$)/gm, "")
    .replace(/([¿¡(])[ \t]*,[ \t]*/g, "$1")
    .replace(/^[ \t]*,[ \t]*/gm, "")
    .replace(/[ \t]+(?=[.!?…,;:)])/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** «el asistente de {empresa}» → con el nombre del perfil; {agente} = crm_agentes_ia.nombre.
 *  Compatible con las llamadas de antes (sin agente, una plantilla sin {agente} sale igual).
 *  Sin nombre de agente la llave se quita con su coma («{agente}, la asistente de ACME» → «la
 *  asistente de ACME»): el auditor lo avisa (presentacion.sin_nombre), y una presentación que
 *  empieza con una coma es peor que una sin nombre. Se reemplaza con una FUNCIÓN y en una sola
 *  pasada: un nombre con «$&» o con «{empresa}» dentro no se reinterpreta. */
export function presentacion(a: Pick<AjustesIA, "presentarse_como">, empresa: string, agente?: string | null): string {
  const emp = empresa || "la empresa";
  const ag = String(agente ?? "").trim().replace(/\s+/g, " ");
  const s = a.presentarse_como.replace(/\{(empresa|agente)\}/g, (_m, k: string) => (k === "empresa" ? emp : ag));
  if (ag || !/\{agente\}/.test(a.presentarse_como)) return s;
  return s
    .replace(/,(?=[ \t]*,)/g, "")
    .replace(/[ \t]+(?=[,;:.])/g, "")
    .replace(/^[\s,;:–-]+/, "")
    .replace(/[\s,;:–-]+$/, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** El trato y el modo de preguntar de estos ajustes (lo que lee un texto que arma el código). */
export function estiloDe(aj: Pick<AjustesIA, "tratamiento" | "preguntas">): EstiloMensajes {
  return {
    tratamiento: enLista(aj?.tratamiento, TRATAMIENTOS, AJUSTES_DEFECTO.tratamiento),
    preguntas: enLista(aj?.preguntas, MODOS_PREGUNTAS, AJUSTES_DEFECTO.preguntas),
  };
}

// La de tú es, byte a byte, la que el código usaba antes de existir el ajuste (lib/crm-ia.ts,
// MENSAJE_DERIVACION_DEFECTO): con «tu» nada cambia. La de usted es la misma frase en el otro trato.
const DERIVACION_TU =
  "Gracias, {nombre}. Ya registré tu solicitud y un ejecutivo de nuestro equipo la está revisando para enviarte la información por este mismo chat a la brevedad. 🙌";
const DERIVACION_USTED =
  "Gracias, {nombre}. Ya registré su solicitud y un ejecutivo de nuestro equipo la está revisando para enviarle la información por este mismo chat a la brevedad. 🙌";

/** La plantilla de derivación cuando el agente no escribió la suya (con {nombre} sin reemplazar). */
export function mensajeDerivacionDefecto(t: Tratamiento): string {
  return t === "tu" ? DERIVACION_TU : DERIVACION_USTED;
}

/** Título del resumen del pedido: el escrito, o el automático del trato. */
export function tituloResumen(aj: Pick<AjustesIA, "resumen_titulo" | "tratamiento">): string {
  const propio = String(aj?.resumen_titulo ?? "").trim();
  if (propio) return propio;
  return aj?.tratamiento === "tu" ? "📋 *Resumen de tu solicitud*" : "📋 *Resumen de su solicitud*";
}

/** Última línea del resumen cuando ya está todo, con el nombre puesto. */
export function cierreResumen(aj: Pick<AjustesIA, "resumen_cierre">, nombre?: string | null): string {
  return ponerNombre(String(aj?.resumen_cierre ?? "").trim() || AJUSTES_DEFECTO.resumen_cierre, nombre);
}

// ── Temas con ajuste (los usa el auditor de coherencia y la pantalla) ─────────────────────────────

/** Lo que decide un tema: un campo de `comportamiento` o una columna de crm_agentes_ia. */
export type ClaveAjuste = keyof AjustesIA | "pausa_humano_horas" | "escalar_si" | "mensaje_derivacion";

/** Los temas que tienen un ajuste. Los otros temas del auditor (seguimiento, llamada, traslados)
 *  no lo tienen: son cosas que el sistema no hace o que decide el cotizador. */
export type TemaAjusteConAjuste =
  | "tratamiento" | "preguntas" | "resumen" | "saludo" | "presentacion" | "identidad_ia"
  | "archivos" | "audios" | "direccion" | "derivacion" | "pausa_humano" | "horario";

/** Por tema: el nombre que ve el dueño, el `id` del control en /crm/agente (para «Ir al ajuste») y
 *  el campo que manda. `identidad_ia` comparte el ancla de la presentación: su casilla vive ahí.
 *  En el resumen y el saludo la clave es la del choque más común (cuándo / el menú); un hallazgo
 *  sobre otro campo del mismo bloque lo nombra él. */
export const TEMAS_AJUSTE: Record<TemaAjusteConAjuste, { etiqueta: string; ancla: string; clave: ClaveAjuste }> = {
  tratamiento: { etiqueta: "Cómo trata al cliente", ancla: "ajuste-tratamiento", clave: "tratamiento" },
  preguntas: { etiqueta: "Cómo pide los datos que faltan", ancla: "ajuste-preguntas", clave: "preguntas" },
  resumen: { etiqueta: "Cuándo muestra el resumen del pedido", ancla: "ajuste-resumen", clave: "resumen_cuando" },
  saludo: { etiqueta: "Qué ofrece cuando el cliente solo saluda", ancla: "ajuste-saludo", clave: "menu_saludo" },
  presentacion: { etiqueta: "Cómo se presenta", ancla: "ajuste-presentacion", clave: "presentarse_como" },
  identidad_ia: { etiqueta: "No decir que es una IA salvo que se lo pregunten", ancla: "ajuste-presentacion", clave: "ocultar_ia" },
  archivos: { etiqueta: "Leer fotos y PDF", ancla: "ajuste-archivos", clave: "leer_archivos" },
  audios: { etiqueta: "Escuchar notas de voz", ancla: "ajuste-audios", clave: "transcribir_audios" },
  direccion: { etiqueta: "Lugares que no necesitan dirección exacta", ancla: "ajuste-lugares", clave: "lugares_conocidos" },
  derivacion: { etiqueta: "Escalar a humano si el mensaje menciona", ancla: "ajuste-escalar", clave: "escalar_si" },
  pausa_humano: { etiqueta: "Pausa tras respuesta humana (horas)", ancla: "ajuste-pausa-humano", clave: "pausa_humano_horas" },
  horario: { etiqueta: "Horario de atención del equipo", ancla: "ajuste-atencion", clave: "atencion_activa" },
};

/** Cuándo pasa el chat a una persona SIN que nadie lo configure: las mismas palabras de la
 *  herramienta `escalar_a_humano` (lib/crm-ia.ts), para que su descripción, el bloque «Ajustes del
 *  agente» y el auditor digan lo mismo. Se lee después de «Úsala »: empieza en minúscula y sin punto. */
export const MOTIVOS_DERIVACION_SISTEMA =
  "si el cliente lo pide, está molesto, hay un reclamo, contrato/licitación, si no encuentras en el sistema lo que pide (servicios, choferes, placas, documentos), si no puedes escuchar una nota de voz, o algo fuera de tu alcance";