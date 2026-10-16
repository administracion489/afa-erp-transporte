// Comportamiento del agente IA del CRM: lo que antes estaba fijo en el código y ahora se
// edita en /crm/agente → Ajustes. PURO (lo importan la pantalla y el motor).
//
// Vive en crm_agentes_ia.comportamiento (jsonb). Sin la columna, o con un valor raro, cada
// campo cae a su defecto: el comportamiento es byte a byte el que tenía AFA en el código.
// El ERP se vende: nada aquí nombra a AFA; el nombre sale del perfil de la empresa.

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
  /** Reglas extra del negocio, una por línea. */
  reglas_extra: string;
};

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
  reglas_extra: "",
};

const entero = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
};
const texto = (v: unknown, def: string, max = 500, vacioValido = false): string => {
  if (typeof v !== "string") return def;
  const t = v.trim().slice(0, max);
  return t || vacioValido ? t : def;
};
const bool = (v: unknown, def: boolean): boolean => (typeof v === "boolean" ? v : def);

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
    reglas_extra: texto(r.reglas_extra, d.reglas_extra, 4000, true),
  };
}

/** El saludo que toca a esa hora de Lima (0-23). */
export function saludoParaHora(a: AjustesIA, hora: number): string {
  return hora < a.hora_tarde ? a.saludo_manana : hora < a.hora_noche ? a.saludo_tarde : a.saludo_noche;
}

/** «el asistente de {empresa}» → con el nombre del perfil. */
export function presentacion(a: AjustesIA, empresa: string): string {
  return a.presentarse_como.replace(/\{empresa\}/g, empresa || "la empresa");
}
