// lib/gps-equipo.ts — ¿CÓMO ESTÁ CONFIGURADO EL TELÉFONO DEL CONDUCTOR? Motor PURO: sin React, sin
// fetch, sin Supabase, sin imports de servidor. Lo importan la app del conductor (que ARMA el
// reporte) y el servidor (que lo NORMALIZA, lo guarda y lo lee para el modal del rastreo).
//
// ── POR QUÉ EXISTE ─────────────────────────────────────────────────────────────────────
// La app ya sabía si la batería estaba exenta, si la ubicación era precisa, si tenía «todo el
// tiempo», si el servicio de fondo corría y si el GPS estaba débil o pegado — y lo sabía SOLO en el
// teléfono. La oficina veía la traza (cuánto se cortó) y nunca el porqué. El reporte (`equipo_gps`
// en /api/conductor) lleva ese estado a `gps_equipo_reportes`, una fila por periodo en que no
// cambió (`reportado_en` → `visto_hasta`).
//
// ── UNA SOLA DEFINICIÓN PARA LOS DOS LADOS ─────────────────────────────────────────────
// `firmaEstado` decide si el estado CAMBIÓ (cliente: ¿mando un reporte nuevo?; servidor: ¿estiro la
// fila o inserto otra?). Si cada lado tuviera la suya, el cliente creería que no cambió nada y el
// servidor abriría una fila por latido (o al revés: perdería un cambio). Por eso la firma NORMALIZA
// por dentro con los mismos normalizadores que `normalizarReporte`: la firma de lo que el cliente
// armó es la firma de lo que el servidor guarda (la matriz cierra ese CICLO).
//
// ── TRI-ESTADO, SIEMPRE ───────────────────────────────────────────────────────────────
// Cada comprobación es `true` (bien), `false` (mal) o `null` (no se pudo comprobar: navegador, APK
// viejo, el plugin no respondió). Un `null` NUNCA es una falta: afirmar «batería con restricciones»
// de un teléfono que no contestó es acusar sin evidencia. Solo un booleano de verdad cuenta; un
// "true" en texto es basura y se guarda como null.
//
// ── LA GUÍA POR MARCA SE MUDÓ AQUÍ SIN REESCRIBIRSE ───────────────────────────────────
// `GUIA_AJUSTES_GPS`, `PASOS_COMUNES` y la lista de fabricantes agresivos vivían en
// app/conductor/page.tsx. El modal de la oficina tiene que enseñar los MISMOS pasos que la app le
// enseña al conductor, así que se copiaron literales (la matriz lo compara contra el original) y
// `detectarFabricanteGps()` pasó a `fabricanteDeUA(ua)`, con la misma lógica, para poder correrla
// en el servidor sobre el user-agent guardado.

// ══ Constantes ═══════════════════════════════════════════════════════════════════════════

// Umbral "esto NO es satélite, es ubicación de red". Medido sobre la flota (4 días, conductores con
// ≥100 fixes): los equipos que entregan GNSS real dan mediana 1.8-7.7 m; los que salen por antena/
// WiFi, 15.9-200 m. El hueco entre 7.7 y 15.9 es limpio → 12 m separa sin falsos positivos. ANTES
// estaba en 60 m: por eso el semáforo estuvo VERDE toda la noche del servicio #24738, que corrió a
// 22 m de mediana (ubicación de red pura) con huecos de hasta 11,7 min y el bus en movimiento.
export const ACC_RED_M = 12;

/** HEREDADO de `evaluarAjustesGps` (app/conductor/page.tsx): un cold start con el último latido
 *  «app viva» más viejo que esto, y un servicio guardado, es que el sistema MATÓ la app. */
export const LATIDO_VIEJO_MS = 240_000;
/** NO MEDIDO: cada cuánto la app confirma que el estado sigue igual mientras comparte. Solo estira
 *  `visto_hasta`; el lado seguro (más precisión de «hasta cuándo») es bajarlo, a costa de escrituras. */
export const LATIDO_EQUIPO_MS = 600_000;
/** NO MEDIDO: cuánto antes del servicio vale un reporte como «el estado ANTERIOR». Un teléfono que
 *  no reportó durante el servicio probablemente seguía como estaba ayer; más atrás, ya no se afirma. */
export const REPORTE_ANTERIOR_MS = 24 * 3600_000;
/** El servidor estira la última fila (en vez de insertar) si su `visto_hasta` es de hace menos de
 *  esto. Dos latidos: uno perdido no parte el periodo. */
export const DEDUPE_LATIDOS = 2;
/** La hora del teléfono se acepta si difiere menos que esto de la del servidor (si no, null). */
export const RELOJ_CLIENTE_MAX_MS = 48 * 3600_000;
/** Freno por instancia del servidor: una escritura cada esto por (tabla, conductor, aparato). */
export const FRENO_EQUIPO_MS = 5_000;
/** Cliente: mínimo entre dos envíos por cambio de firma. */
export const MIN_ENTRE_ENVIOS_MS = 15_000;
/** Cliente: espera tras un envío fallido. */
export const REINTENTO_EQUIPO_MS = 120_000;
/** Cliente: pausa cuando el servidor responde `sin_migracion` (la tabla no existe todavía). */
export const PAUSA_SIN_MIGRACION_MS = 6 * 3600_000;
/** localStorage: identifica el APARATO (no se borra al cerrar sesión). */
export const CLAVE_DISPOSITIVO = "afa_dispositivo_v1";
/** localStorage: hasta cuándo no reportar (tras `sin_migracion`). */
export const CLAVE_PAUSA_EQUIPO = "afa_equipo_pausa_hasta";
/** Mismos topes que los CHECK de supabase/gps-equipo-01.sql. */
export const UA_MAX = 300;
export const MODELO_MAX = 60;
export const GPS_DEBIL_MAX_M = 100_000;
const COLA_MAX = 1_000_000;

// ══ El contrato del reporte (acción `equipo_gps` de /api/conductor) ══════════════════════

export type MotivoReporte = "arranque" | "cambio" | "latido" | "corte";
export type PlataformaEquipo = "apk" | "ios" | "navegador";
export type PluginEquipo = "AfaNative" | "BackgroundGeolocation";
export type PrecisionUbicacion = "precisa" | "aproximada";

export const MOTIVOS_REPORTE: readonly MotivoReporte[] = ["arranque", "cambio", "latido", "corte"];
export const PLATAFORMAS: readonly PlataformaEquipo[] = ["apk", "ios", "navegador"];
export const PLUGINS_EQUIPO: readonly PluginEquipo[] = ["AfaNative", "BackgroundGeolocation"];

/** Lo que manda la app (además de `token` y `_cliente_ts`, que agrega `condApi`). */
export type ReporteEquipo = {
  /** UUID guardado en localStorage CLAVE_DISPOSITIVO */
  dispositivo: string;
  reserva_id: number | null;
  motivo: MotivoReporte;
  /** Capacitor.getPlatform() */
  plataforma: PlataformaEquipo;
  /** navigator.userAgentData.getHighEntropyValues(["model"]), best-effort */
  modelo: string | null;
  /** Capacitor.isPluginAvailable */
  plugins: PluginEquipo[];
  compartiendo: boolean | null;
  bateria_exenta: boolean | null;
  precision_ubicacion: PrecisionUbicacion | null;
  todo_el_tiempo: boolean | null;
  /** ajustesUbicacion(): disponible ? satisfecho : null */
  ajustes_alta_precision: boolean | null;
  servicio_fondo: boolean | null;
  /** mediana de la precisión de los fixes recibidos; null = no hay muestras (≠ 0 = bien medido) */
  gps_debil_m: number | null;
  gps_atascado: boolean | null;
  pendientes_cola: number | null;
};

// ── Normalizadores por campo: los usan `normalizarReporte` Y `firmaEstado` ─────────────
const RE_DISPOSITIVO = /^[A-Za-z0-9-]{8,64}$/;

function normDispositivo(x: unknown): string | null {
  return typeof x === "string" && RE_DISPOSITIVO.test(x) ? x : null;
}
function normMotivo(x: unknown): MotivoReporte | null {
  return typeof x === "string" && (MOTIVOS_REPORTE as readonly string[]).includes(x) ? (x as MotivoReporte) : null;
}
function normPlataforma(x: unknown): PlataformaEquipo | null {
  return typeof x === "string" && (PLATAFORMAS as readonly string[]).includes(x) ? (x as PlataformaEquipo) : null;
}
/** Texto libre: sin caracteres de control, espacios colapsados, recortado. Vacío → null. */
function normTexto(x: unknown, max: number): string | null {
  if (typeof x !== "string") return null;
  const t = x.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return t ? t : null;
}
function normModelo(x: unknown): string | null { return normTexto(x, MODELO_MAX); }
function normPlugins(x: unknown): PluginEquipo[] {
  if (!Array.isArray(x)) return [];
  const set = new Set<PluginEquipo>();
  for (const p of x) if (typeof p === "string" && (PLUGINS_EQUIPO as readonly string[]).includes(p)) set.add(p as PluginEquipo);
  return [...set].sort();
}
/** Tri-estado: SOLO un booleano de verdad. "true" en texto, 1, "sí" → null. */
function normBool(x: unknown): boolean | null { return typeof x === "boolean" ? x : null; }
function normPrecision(x: unknown): PrecisionUbicacion | null {
  return x === "precisa" || x === "aproximada" ? x : null;
}
function normEntero(x: unknown, max: number): number | null {
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > max) return null;
  return Math.round(x);
}
function normReserva(x: unknown): number | null {
  const n = typeof x === "number" ? x : typeof x === "string" && /^\d{1,15}$/.test(x) ? Number(x) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * El cuerpo de la petición → el reporte que se guarda, o `null` si no es un reporte (→ 400). Solo
 * tres campos invalidan el reporte entero (sin ellos la fila no describe nada ni pasa los CHECK):
 * `dispositivo`, `motivo` y `plataforma`. Todo lo demás que venga mal se guarda como null — nunca
 * como `false`, que sería afirmar una falta.
 */
export function normalizarReporte(body: unknown): ReporteEquipo | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const dispositivo = normDispositivo(b.dispositivo);
  const motivo = normMotivo(b.motivo);
  const plataforma = normPlataforma(b.plataforma);
  if (!dispositivo || !motivo || !plataforma) return null;
  return {
    dispositivo, motivo, plataforma,
    reserva_id: normReserva(b.reserva_id),
    modelo: normModelo(b.modelo),
    plugins: normPlugins(b.plugins),
    compartiendo: normBool(b.compartiendo),
    bateria_exenta: normBool(b.bateria_exenta),
    precision_ubicacion: normPrecision(b.precision_ubicacion),
    todo_el_tiempo: normBool(b.todo_el_tiempo),
    ajustes_alta_precision: normBool(b.ajustes_alta_precision),
    servicio_fondo: normBool(b.servicio_fondo),
    gps_debil_m: normEntero(b.gps_debil_m, GPS_DEBIL_MAX_M),
    gps_atascado: normBool(b.gps_atascado),
    pendientes_cola: normEntero(b.pendientes_cola, COLA_MAX),
  };
}

/** El user-agent de la cabecera, como se guarda: sin control, recortado a UA_MAX. */
export function recortarUA(ua: unknown): string | null { return normTexto(ua, UA_MAX); }

/**
 * ¿Cambió el estado? Excluye a propósito `motivo` (un latido no es un cambio), `pendientes_cola`
 * (sube y baja con la red: cambiaría cada minuto) y el VALOR de `gps_debil_m` (solo cuenta si cruza
 * ACC_RED_M). Normaliza por dentro: la firma del snapshot del cliente y la de lo que el servidor
 * guardó son la misma, y no depende del orden de las claves.
 */
export function firmaEstado(r: Partial<Record<keyof ReporteEquipo, unknown>>): string {
  const m = normEntero(r.gps_debil_m, GPS_DEBIL_MAX_M);
  return JSON.stringify([
    normPlataforma(r.plataforma),
    normModelo(r.modelo),
    normPlugins(r.plugins).join(","),
    normBool(r.compartiendo),
    normBool(r.bateria_exenta),
    normPrecision(r.precision_ubicacion),
    normBool(r.todo_el_tiempo),
    normBool(r.ajustes_alta_precision),
    normBool(r.servicio_fondo),
    m == null ? null : m >= ACC_RED_M,
    normBool(r.gps_atascado),
    normReserva(r.reserva_id),
    normDispositivo(r.dispositivo),
  ]);
}

/**
 * La hora del TELÉFONO (`_cliente_ts`, ISO) si es creíble: a menos de RELOJ_CLIENTE_MAX_MS de la del
 * servidor. Se guarda aparte de la del servidor porque la traza (`ubicaciones_gps.created_at`) también
 * la pone el teléfono: para cruzar un reporte con un tramo de la traza, hay que usar el mismo reloj.
 */
export function relojCliente(ts: unknown, ahoraMs: number): number | null {
  const t = typeof ts === "number" ? ts : typeof ts === "string" ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t) || t <= 0) return null;
  return Math.abs(t - ahoraMs) < RELOJ_CLIENTE_MAX_MS ? t : null;
}

/**
 * Servidor: ¿estirar la última fila de ese conductor y ese aparato, o insertar otra? Se estira solo
 * si la firma es la misma, el reporte no es un corte (un corte es un HECHO: siempre su propia fila,
 * para que el diagnóstico lo encuentre) y la fila sigue viva (menos de DEDUPE_LATIDOS latidos).
 */
export function accionDeReporte(
  ultima: { firma: string; visto_hasta: string | number } | null,
  nuevo: { firma: string; motivo: MotivoReporte },
  ahoraMs: number,
): "estirar" | "insertar" {
  if (!ultima || nuevo.motivo === "corte" || ultima.firma !== nuevo.firma) return "insertar";
  const visto = typeof ultima.visto_hasta === "number" ? ultima.visto_hasta : Date.parse(ultima.visto_hasta);
  if (!Number.isFinite(visto)) return "insertar";
  return ahoraMs - visto < DEDUPE_LATIDOS * LATIDO_EQUIPO_MS ? "estirar" : "insertar";
}

// ══ La guía de ajustes por marca (MUDADA de app/conductor/page.tsx, sin reescribir) ═══════

// ─── GUÍA DE AJUSTES DEL EQUIPO (para que el fabricante no mate el rastreo) ──────
// Android NO deja que una app active autostart / batería sin restricciones / bloqueo
// en Recientes por su cuenta: son ajustes del usuario. Lo máximo es DETECTAR la marca
// y GUIAR al conductor paso a paso (él toca los toggles). Esto sube la disponibilidad
// real más que cualquier watchdog (la causa #1 de cortes es el matado por fabricante).
export type PasoAjuste = { titulo: string; detalle: string };
export type GuiaFabricante = { marca: string; pasos: PasoAjuste[] };

/** Era `detectarFabricanteGps()` de la app (que leía navigator.userAgent): misma lógica, sobre
 *  el texto que se le pase, para poder correrla en el servidor sobre el user-agent guardado. */
export function fabricanteDeUA(uaCrudo: string): string {
  const ua = (uaCrudo || "").toLowerCase();
  if (/xiaomi|redmi|poco|miui|hyperos/.test(ua)) return "xiaomi";
  if (/samsung|sm-/.test(ua))                    return "samsung";
  if (/oppo|cph/.test(ua))                        return "oppo";
  if (/vivo/.test(ua))                            return "vivo";
  if (/realme|rmx/.test(ua))                      return "realme";
  if (/huawei|honor|\bhry\b|\blio\b/.test(ua))   return "huawei";
  if (/motorola|moto\b|\bmoto /.test(ua))         return "motorola";
  return "generico";
}

export const PASOS_COMUNES: PasoAjuste[] = [
  { titulo: "Ubicación: “Permitir todo el tiempo”", detalle: "Ajustes → Apps → AFA Conductores → Permisos → Ubicación → Permitir todo el tiempo." },
  { titulo: "Batería: “Sin restricciones”", detalle: "Ajustes → Apps → AFA Conductores → Batería → Sin restricciones (o “No optimizar”)." },
  { titulo: "Bloquea la app en Recientes", detalle: "Abre Recientes (multitarea), mantén presionada AFA Conductores y toca el candado para que el sistema no la cierre." },
];

export const GUIA_AJUSTES_GPS: Record<string, GuiaFabricante> = {
  xiaomi: { marca: "Xiaomi / Redmi / POCO (MIUI/HyperOS)", pasos: [
    { titulo: "Inicio automático: ACTIVADO", detalle: "Ajustes → Apps → Gestión de apps → AFA Conductores → Inicio automático → Activar. (También en Seguridad → Permisos → Inicio automático.)" },
    { titulo: "Ahorro de batería: “Sin restricciones”", detalle: "En la misma pantalla de la app → Ahorro de batería → Sin restricciones." },
    ...PASOS_COMUNES,
  ]},
  samsung: { marca: "Samsung (One UI)", pasos: [
    { titulo: "Quita “Poner en suspensión”", detalle: "Ajustes → Batería → Límites de uso en segundo plano → asegúrate que AFA Conductores NO esté en “Apps en suspensión” ni “Suspensión profunda”." },
    ...PASOS_COMUNES,
  ]},
  oppo:    { marca: "Oppo / OnePlus (ColorOS)", pasos: [
    { titulo: "Inicio automático: ACTIVADO", detalle: "Ajustes → Gestión de batería/apps → AFA Conductores → permitir inicio automático y ejecución en segundo plano." },
    ...PASOS_COMUNES,
  ]},
  vivo:    { marca: "Vivo (Funtouch/OriginOS)", pasos: [
    { titulo: "Inicio automático y alto consumo: PERMITIR", detalle: "Ajustes → Batería → Consumo alto en segundo plano → permitir AFA Conductores; y permitir inicio automático." },
    ...PASOS_COMUNES,
  ]},
  realme:  { marca: "Realme (Realme UI)", pasos: [
    { titulo: "Inicio automático: ACTIVADO", detalle: "Ajustes → Apps → AFA Conductores → permitir inicio automático y actividad en segundo plano." },
    ...PASOS_COMUNES,
  ]},
  huawei:  { marca: "Huawei / Honor (EMUI/MagicOS)", pasos: [
    { titulo: "Gestión manual de la app", detalle: "Ajustes → Batería → Inicio de apps → AFA Conductores → Gestionar manualmente → activar Inicio automático, Inicio secundario y Ejecución en segundo plano." },
    ...PASOS_COMUNES,
  ]},
  motorola:{ marca: "Motorola", pasos: PASOS_COMUNES },
  generico:{ marca: "tu equipo", pasos: PASOS_COMUNES },
};

// OEM agresivos: el 1-toque de batería NO basta (también piden inicio automático, etc.)
// → los pasos van expandidos. En el resto, el 1-toque resuelve → pasos colapsados.
export const FABRICANTES_AGRESIVOS: readonly string[] = ["xiaomi", "oppo", "vivo", "realme", "huawei"];

export function guiaDeFabricante(fab: string): GuiaFabricante {
  return GUIA_AJUSTES_GPS[fab] ?? GUIA_AJUSTES_GPS.generico;
}

// ══ Lo que se deriva del user-agent (no se guarda la marca: se deriva al leer) ═══════════

// Chrome REDUCE el user-agent («Android 10; K»): el modelo es la letra K y la versión de Android
// queda congelada en 10, así que ninguno de los dos describe al teléfono. Se reconoce y se calla.
// El modelo va tras «Android N;» (y un idioma opcional, en UAs viejos) hasta el siguiente «;» o el
// paréntesis que cierra; puede llevar paréntesis propios («moto g(30)»), por eso antes se quita el
// «Build/…» y el cierre se reconoce como «) » o «)» al final, no como cualquier «)».
const RE_UA_ANDROID = /Android\s*([\d.]+)?\s*;\s*(?:[a-z]{2}[-_][a-z]{2}\s*;\s*)?([^;]+?)(?=;|\)\s|\)$)/i;
function uaReducido(ua: string): boolean { return /Android\s+10;\s*K\)/i.test(ua); }

/** Modelo del teléfono según el user-agent («SM-A515F»), o null si el UA no lo dice. */
export function modeloDeUA(ua: string | null | undefined): string | null {
  if (!ua || uaReducido(ua)) return null;
  const m = RE_UA_ANDROID.exec(ua.replace(/\s+Build\/[^;)]*/i, ""));
  if (!m) return null;
  const modelo = m[2].trim();
  if (!modelo || /^(k|wv|mobile)$/i.test(modelo)) return null;
  return modelo.slice(0, MODELO_MAX);
}

/** Versión de Android según el user-agent («13»), o null (iPhone, escritorio, UA reducido). */
export function androidDeUA(ua: string | null | undefined): string | null {
  if (!ua || uaReducido(ua)) return null;
  const m = /Android\s+(\d+(?:\.\d+)*)/i.exec(ua);
  return m ? m[1] : null;
}

export type CodigoNivelApk = "navegador" | "ios" | "sin_modulo" | "sin_respuesta" | "basico" | "intermedio" | "completo";
export type NivelApk = { codigo: CodigoNivelApk; texto: string };

/**
 * NO SE PUEDE LEER LA VERSIÓN DEL APK: no están @capacitor/app ni @capacitor/device, y AfaNativePlugin
 * no expone versionName. Se DEDUCE de qué comprobaciones contestan (cada una llegó en un APK
 * posterior, ver lib/geo.ts: batería APK 28+, «todo el tiempo» APK 29+, ajustes después) y de qué
 * plugins existen. Describe la evidencia; nunca inventa un número de versión.
 */
export function nivelApk(e: {
  plataforma: PlataformaEquipo | null;
  plugins: PluginEquipo[];
  bateria_exenta: boolean | null;
  todo_el_tiempo: boolean | null;
  ajustes_alta_precision: boolean | null;
}): NivelApk {
  if (e.plataforma === "navegador") return { codigo: "navegador", texto: "Navegador: no es la app instalada, y el navegador deja de rastrear con la pantalla bloqueada o con otra app encima." };
  if (e.plataforma === "ios") return { codigo: "ios", texto: "iPhone: la app no comprueba estos ajustes en iOS." };
  const sinFondo = !e.plugins.includes("BackgroundGeolocation")
    ? " Le falta el plugin de rastreo en segundo plano: solo rastrea con la app abierta." : "";
  if (!e.plugins.includes("AfaNative")) {
    return { codigo: "sin_modulo", texto: `APK antiguo: sin el módulo AfaNative no puede comprobar la batería, «todo el tiempo» ni los ajustes de ubicación. Conviene instalar la versión actual.${sinFondo}` };
  }
  if (e.bateria_exenta === null) {
    return { codigo: "sin_respuesta", texto: `El módulo AfaNative está, pero no respondió: no se pudo comprobar la configuración.${sinFondo}` };
  }
  if (e.todo_el_tiempo === null) {
    return { codigo: "basico", texto: `APK 28: comprueba la batería, pero no el permiso «todo el tiempo» ni los ajustes de alta precisión.${sinFondo}` };
  }
  if (e.ajustes_alta_precision === null) {
    return { codigo: "intermedio", texto: `APK 29 o posterior: comprueba la batería y «todo el tiempo»; los ajustes de alta precisión no respondieron (APK anterior, o teléfono sin Google Play Services).${sinFondo}` };
  }
  return { codigo: "completo", texto: `APK actual: comprueba la batería, «todo el tiempo» y los ajustes de alta precisión.${sinFondo}` };
}

// ══ Lectura: de las filas guardadas al estado del teléfono ═══════════════════════════════

/** Una fila de `gps_equipo_reportes` tal como la devuelve PostgREST. */
export type FilaEquipo = {
  id?: number | null;
  conductor_id?: number | null;
  conductor_tercero_id?: number | null;
  reserva_id?: number | null;
  dispositivo: string;
  motivo: string;
  plataforma: string;
  user_agent?: string | null;
  modelo?: string | null;
  plugins?: string[] | null;
  compartiendo?: boolean | null;
  bateria_exenta?: boolean | null;
  precision_ubicacion?: string | null;
  todo_el_tiempo?: boolean | null;
  ajustes_alta_precision?: boolean | null;
  servicio_fondo?: boolean | null;
  gps_debil_m?: number | null;
  gps_atascado?: boolean | null;
  pendientes_cola?: number | null;
  firma?: string | null;
  reportado_en: string;
  visto_hasta: string;
  reportado_cliente_en?: string | null;
  visto_cliente_en?: string | null;
};

/**
 * El estado del teléfono en un periodo, ya FUSIONADO si varios reportes lo cubren. La fusión es la
 * pesimista y tri-estado: el valor MALO gana sobre el bueno, y cualquiera conocido sobre null
 * (false > true > null; «aproximada» > «precisa» > null; atascado true > false > null; la peor
 * precisión medida). Así, si el conductor cambió un ajuste a mitad del servicio, el diagnóstico ve
 * que en algún momento estuvo mal — que es lo que explica un corte.
 */
export type EstadoEquipo = {
  /** periodo cubierto, en hora del TELÉFONO cuando se conoce (el mismo reloj que la traza) */
  desdeTs: number;
  hastaTs: number;
  reportes: number;
  /** aparatos distintos que reportaron (más de uno = el conductor usó dos teléfonos) */
  aparatos: number;
  dispositivos: string[];
  /** la peor: navegador > ios > apk */
  plataforma: PlataformaEquipo | null;
  plataformas: PlataformaEquipo[];
  /** del reporte más reciente */
  userAgent: string | null;
  modelo: string | null;
  fabricante: string;
  marca: string;
  android: string | null;
  plugins: PluginEquipo[];
  nivelApk: NivelApk;
  compartiendo: boolean | null;
  bateria_exenta: boolean | null;
  precision_ubicacion: PrecisionUbicacion | null;
  todo_el_tiempo: boolean | null;
  ajustes_alta_precision: boolean | null;
  servicio_fondo: boolean | null;
  gps_debil_m: number | null;
  gps_atascado: boolean | null;
  pendientes_cola: number | null;
};

function tsDe(x: string | null | undefined): number | null {
  if (!x) return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? t : null;
}

/**
 * El periodo de una fila en hora del TELÉFONO: `reportado_cliente_en` / `visto_cliente_en` si están;
 * si falta el del final, el del servidor corrido por el mismo desfase del inicio (mezclar los dos
 * relojes sin corregir podría dejar el fin antes del inicio).
 */
export function periodoCliente(f: FilaEquipo): { desde: number; hasta: number } | null {
  const repS = tsDe(f.reportado_en), visS = tsDe(f.visto_hasta);
  if (repS == null) return null;
  const repC = tsDe(f.reportado_cliente_en ?? null);
  const desde = repC ?? repS;
  const desfase = desde - repS;
  const visC = tsDe(f.visto_cliente_en ?? null);
  const hasta = visC ?? (visS != null ? visS + desfase : desde);
  return { desde, hasta: Math.max(desde, hasta) };
}

function peorBool(a: boolean | null, b: boolean | null): boolean | null {
  if (a === false || b === false) return false;
  if (a === true || b === true) return true;
  return null;
}
function peorAtascado(a: boolean | null, b: boolean | null): boolean | null {
  if (a === true || b === true) return true;
  if (a === false || b === false) return false;
  return null;
}
function peorPrecision(a: PrecisionUbicacion | null, b: PrecisionUbicacion | null): PrecisionUbicacion | null {
  if (a === "aproximada" || b === "aproximada") return "aproximada";
  if (a === "precisa" || b === "precisa") return "precisa";
  return null;
}
function peorNum(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}
const RANGO_PLATAFORMA: Record<PlataformaEquipo, number> = { apk: 0, ios: 1, navegador: 2 };

/** Fusiona TODAS las filas que se le pasen (quien llama elige cuáles). null si no hay ninguna. */
export function estadoDesdeFilas(filas: FilaEquipo[]): EstadoEquipo | null {
  const validas = (filas || [])
    .map((f) => ({ f, p: periodoCliente(f) }))
    .filter((x): x is { f: FilaEquipo; p: { desde: number; hasta: number } } => x.p != null)
    .sort((a, b) => a.p.desde - b.p.desde || a.p.hasta - b.p.hasta);
  if (!validas.length) return null;
  const ultima = validas.reduce((m, x) => (x.p.hasta >= m.p.hasta ? x : m), validas[0]).f;

  let bateria: boolean | null = null, todo: boolean | null = null, ajustes: boolean | null = null, fondo: boolean | null = null;
  let precision: PrecisionUbicacion | null = null, atascado: boolean | null = null;
  let debil: number | null = null, cola: number | null = null;
  let plataforma: PlataformaEquipo | null = null;
  const plataformas = new Set<PlataformaEquipo>();
  const dispositivos = new Set<string>();
  for (const { f } of validas) {
    bateria = peorBool(bateria, normBool(f.bateria_exenta));
    todo = peorBool(todo, normBool(f.todo_el_tiempo));
    ajustes = peorBool(ajustes, normBool(f.ajustes_alta_precision));
    fondo = peorBool(fondo, normBool(f.servicio_fondo));
    precision = peorPrecision(precision, normPrecision(f.precision_ubicacion));
    atascado = peorAtascado(atascado, normBool(f.gps_atascado));
    debil = peorNum(debil, normEntero(f.gps_debil_m, GPS_DEBIL_MAX_M));
    cola = peorNum(cola, normEntero(f.pendientes_cola, COLA_MAX));
    const pl = normPlataforma(f.plataforma);
    if (pl) {
      plataformas.add(pl);
      if (plataforma == null || RANGO_PLATAFORMA[pl] > RANGO_PLATAFORMA[plataforma]) plataforma = pl;
    }
    if (f.dispositivo) dispositivos.add(f.dispositivo);
  }
  const ua = recortarUA(ultima.user_agent);
  const modelo = normModelo(ultima.modelo) ?? modeloDeUA(ua);
  // La marca se deriva del UA y, si el UA vino reducido («Android 10; K»), del modelo reportado:
  // los modelos llevan el prefijo de su marca (SM-…, CPH…, RMX…).
  const fabricante = fabricanteDeUA([ua, normModelo(ultima.modelo)].filter(Boolean).join(" "));
  const plugins = normPlugins(ultima.plugins);
  const plUltima = normPlataforma(ultima.plataforma);
  return {
    desdeTs: validas[0].p.desde,
    hastaTs: Math.max(...validas.map((x) => x.p.hasta)),
    reportes: validas.length,
    aparatos: dispositivos.size,
    dispositivos: [...dispositivos].sort(),
    plataforma,
    plataformas: [...plataformas].sort((a, b) => RANGO_PLATAFORMA[a] - RANGO_PLATAFORMA[b]),
    userAgent: ua,
    modelo,
    fabricante,
    marca: guiaDeFabricante(fabricante).marca,
    android: androidDeUA(ua),
    plugins,
    // El nivel describe la app que corre AHORA: sale de la fila más reciente, sin fusionar.
    nivelApk: nivelApk({
      plataforma: plUltima, plugins,
      bateria_exenta: normBool(ultima.bateria_exenta),
      todo_el_tiempo: normBool(ultima.todo_el_tiempo),
      ajustes_alta_precision: normBool(ultima.ajustes_alta_precision),
    }),
    compartiendo: normBool(ultima.compartiendo),
    bateria_exenta: bateria,
    precision_ubicacion: precision,
    todo_el_tiempo: todo,
    ajustes_alta_precision: ajustes,
    servicio_fondo: fondo,
    gps_debil_m: debil,
    gps_atascado: atascado,
    pendientes_cola: cola,
  };
}

/** El último estado conocido: la fila más reciente, sola. */
export function ultimoEstado(filas: FilaEquipo[]): EstadoEquipo | null {
  let mejor: FilaEquipo | null = null, mejorTs = -Infinity;
  for (const f of filas || []) {
    const p = periodoCliente(f);
    if (p && p.hasta >= mejorTs) { mejor = f; mejorTs = p.hasta; }
  }
  return mejor ? estadoDesdeFilas([mejor]) : null;
}

/**
 * El estado del teléfono DURANTE una ventana [ini, fin] (hora del teléfono, la de la traza), el de
 * ANTES (la última fila de cada aparato que terminó en las REPORTE_ANTERIOR_MS previas al inicio,
 * fusionadas) y los reinicios de la app (reportes con motivo «corte»: el sistema la había cerrado),
 * en hora del teléfono, dentro de la ventana ± `margenMs`. El emparejamiento fino de un reinicio
 * con un tramo lo hace lib/gps-diagnostico.ts.
 */
export function estadoDuranteVentana(
  filas: FilaEquipo[],
  ini: number,
  fin: number,
  margenMs: number = LATIDO_EQUIPO_MS,
): { durante: EstadoEquipo | null; anterior: EstadoEquipo | null; reinicios: number[] } {
  const conPeriodo = (filas || [])
    .map((f) => ({ f, p: periodoCliente(f) }))
    .filter((x): x is { f: FilaEquipo; p: { desde: number; hasta: number } } => x.p != null);
  const durante = conPeriodo.filter((x) => x.p.desde <= fin && x.p.hasta >= ini).map((x) => x.f);
  const ultimaPorAparato = new Map<string, { f: FilaEquipo; hasta: number }>();
  for (const x of conPeriodo) {
    if (!(x.p.hasta < ini && x.p.hasta >= ini - REPORTE_ANTERIOR_MS)) continue;
    const prev = ultimaPorAparato.get(x.f.dispositivo);
    if (!prev || x.p.hasta >= prev.hasta) ultimaPorAparato.set(x.f.dispositivo, { f: x.f, hasta: x.p.hasta });
  }
  const reinicios = conPeriodo
    .filter((x) => x.f.motivo === "corte" && x.p.desde >= ini - margenMs && x.p.desde <= fin + margenMs)
    .map((x) => x.p.desde)
    .sort((a, b) => a - b);
  return {
    durante: estadoDesdeFilas(durante),
    anterior: estadoDesdeFilas([...ultimaPorAparato.values()].map((x) => x.f)),
    reinicios,
  };
}

// ══ Qué le falta configurar (tri-estado) ═════════════════════════════════════════════════

export type CampoEquipo =
  | "plataforma" | "bateria_exenta" | "todo_el_tiempo" | "servicio_fondo"
  | "precision_ubicacion" | "ajustes_alta_precision";

/** El tipo de corte que cada ajuste puede explicar (lib/gps-diagnostico.ts lo cruza con la causa). */
export type AfectaA = "app_detenida" | "por_antena";

/** Los ajustes que explican que la app DEJE DE ENVIAR (el sistema la detiene o la duerme). */
export const CAMPOS_APP_DETENIDA: readonly CampoEquipo[] = ["plataforma", "bateria_exenta", "todo_el_tiempo", "servicio_fondo"];
/** Los ajustes que explican que llegue posición POR ANTENA (sin satélite). */
export const CAMPOS_POR_ANTENA: readonly CampoEquipo[] = ["precision_ubicacion", "ajustes_alta_precision"];
export const CAMPOS_EQUIPO: readonly CampoEquipo[] = [...CAMPOS_APP_DETENIDA, ...CAMPOS_POR_ANTENA];

export const ETIQUETA_CAMPO: Record<CampoEquipo, string> = {
  plataforma: "App instalada (no el navegador)",
  bateria_exenta: "Batería sin restricciones",
  todo_el_tiempo: "Ubicación «Permitir todo el tiempo»",
  servicio_fondo: "Rastreo en segundo plano activo",
  precision_ubicacion: "Ubicación precisa",
  ajustes_alta_precision: "Ubicación del teléfono en alta precisión",
};

export type FaltaConfig = { campo: CampoEquipo; titulo: string; arreglo: string; afecta: AfectaA };

const FALTA: Record<CampoEquipo, Omit<FaltaConfig, "campo">> = {
  plataforma: { afecta: "app_detenida", titulo: "Usa la app desde el navegador",
    arreglo: "Instalar la app AFA Conductores (APK): el navegador deja de rastrear con la pantalla bloqueada o con otra app encima." },
  bateria_exenta: { afecta: "app_detenida", titulo: "La batería tiene restricciones para la app",
    arreglo: "Ajustes → Apps → AFA Conductores → Batería → Sin restricciones (o “No optimizar”). La app lo puede pedir con un toque desde «Ajustes del GPS»." },
  todo_el_tiempo: { afecta: "app_detenida", titulo: "La ubicación es solo «mientras se usa la app»",
    arreglo: "Ajustes → Apps → AFA Conductores → Permisos → Ubicación → Permitir todo el tiempo." },
  servicio_fondo: { afecta: "app_detenida", titulo: "El rastreo en segundo plano no estaba activo",
    arreglo: "Que el conductor abra la app y vuelva a conectarse; si se repite, revisar la batería y el inicio automático de la app." },
  precision_ubicacion: { afecta: "por_antena", titulo: "El permiso de ubicación es «aproximada»",
    arreglo: "Ajustes → Apps → AFA Conductores → Permisos → Ubicación → activar «Usar ubicación precisa»." },
  ajustes_alta_precision: { afecta: "por_antena", titulo: "La ubicación del teléfono no está en alta precisión",
    arreglo: "Ajustes → Ubicación → activar «Precisión de la ubicación de Google» (alta precisión). La app lo puede pedir con un toque." },
};

/** El valor tri-estado de un ajuste: true = bien, false = mal, null = no se pudo comprobar. */
export function valorCampo(e: EstadoEquipo, campo: CampoEquipo): boolean | null {
  switch (campo) {
    case "plataforma": return e.plataforma == null ? null : e.plataforma !== "navegador";
    case "precision_ubicacion": return e.precision_ubicacion == null ? null : e.precision_ubicacion === "precisa";
    case "bateria_exenta": return e.bateria_exenta;
    case "todo_el_tiempo": return e.todo_el_tiempo;
    case "servicio_fondo": return e.servicio_fondo;
    case "ajustes_alta_precision": return e.ajustes_alta_precision;
  }
}

/**
 * Las faltas (ajustes en `false`) y lo que no se pudo comprobar (`null`), en el orden de
 * CAMPOS_EQUIPO. Un `null` jamás es una falta.
 */
export function faltasDeConfiguracion(e: EstadoEquipo | null): { faltas: FaltaConfig[]; noComprobado: CampoEquipo[] } {
  if (!e) return { faltas: [], noComprobado: [] };
  const faltas: FaltaConfig[] = [];
  const noComprobado: CampoEquipo[] = [];
  for (const campo of CAMPOS_EQUIPO) {
    const v = valorCampo(e, campo);
    if (v === false) faltas.push({ campo, ...FALTA[campo] });
    else if (v === null) noComprobado.push(campo);
  }
  return { faltas, noComprobado };
}
