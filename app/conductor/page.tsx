"use client";

import { useEffect, useRef, useState, useCallback, type ReactElement } from "react";
import { supabase } from "@/lib/supabase";
import { pedirPermisoUbicacion, obtenerUbicacion, observarUbicacion, observarUbicacionBackground, abrirAjustesUbicacion, solicitarExencionBateria, bateriaExenta, precisionUbicacion, pedirPrecisionAlta, ubicacionTodoElTiempo, pedirUbicacionTodoElTiempo, ajustesUbicacion, pedirAjustesUbicacion, esAppNativa, backgroundGpsActivo, backgroundGpsSinFixMs, geoDisponible, type GeoPos, type GeoWatch, type GeoPrecision } from "@/lib/geo";
import { attachHidScanner } from "@/lib/hid-scanner";
import { detectarSoportePush, permisoBloqueado, activarPushWeb, activarPushNativo, resincronizarSuscripcion } from "@/lib/push-cliente";
import {
  CondorMark,
  IconActivity, IconAlert, IconArrowLeft, IconArrowRight, IconBell, IconBus,
  IconCalendar, IconCamera, IconCheck, IconChevronRight, IconCircleAlert,
  IconClock, IconClose, IconFlag, IconFuel, IconGauge, IconKey, IconLogout,
  IconMail, IconMoreH, IconNav, IconPhone, IconPin, IconPlay, IconQR,
  IconReceipt, IconRefresh, IconRoute, IconScan, IconShield, IconStop,
  IconUser, IconUsers, IconWrench,
} from "@/app/_components/icons";
import {
  Chip, Eyebrow, StatusDot, PrimaryBtn, SecondaryBtn, TabBar,
  FONT_SANS, FONT_MONO, type TabItem,
} from "@/app/_components/ui";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import { configCategoriaCC, configRendicion, ESTADOS_REVISION, type EstadoRevisionGasto } from "@/lib/finanzas/caja-chica";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Conductor = {
  id: number; nombre: string; dni: string | null; telefono: string | null;
  pin_acceso: string | null; activo_app: boolean; licencia?: string | null;
  vencimiento_licencia?: string | null; categoria_licencia?: string | null;
  sctr_salud_venc?: string | null; examen_medico_venc?: string | null;
  _tabla?: "conductores" | "conductores_tercero";
  /** Token de sesión firmado por el servidor (lib/conductor-auth.ts). Es la credencial
   *  de las acciones sensibles; sustituye al PIN, que ya no se guarda en el dispositivo. */
  _token?: string;
};
// `_flota` marca de qué tabla salió el vehículo. Es imprescindible: la lista mezcla flota
// propia y tercerizada, y los ids se SOLAPAN entre `vehiculos` y `vehiculos_tercero` (el id 5
// es CWQ400 en una y C8Z-955 en la otra), así que un id suelto es ambiguo.
type Vehiculo  = { id: number; placa: string; categoria: string | null; marca?: string | null; _flota?: "propia" | "tercero" };
type Reserva   = { id: number; origen: string; destino: string; fecha_servicio: string | null; hora_servicio?: string | null; vehiculo_id?: number | null; estado?: string | null; };
type Parada    = { id: number; reserva_id: number; orden: number; nombre: string; direccion: string | null; lat: number | null; lng: number | null; hora_estimada: string | null; estado: string; hora_llegada?: string | null; };
type Pasajero  = { id: number; nombre: string; dni: string | null; empresa: string | null; qr_code: string | null; foto_url: string | null; };
type PasajeroParada = { id: number; parada_id: number; pasajero_id: number; estado: string; pasajero?: Pasajero; };
type CheckItem = { id: string; label: string; categoria: string; ok: boolean | null; };
type DocCond   = { id: number; tipo: string; nombre: string | null; url: string; vencimiento: string | null; };

type Tab = "ruta" | "paradas" | "checklist" | "documentos" | "rendicion" | "perfil";

// ─── Caja chica: lo que devuelve /api/conductor (mi_caja_chica) ───────────────
// Espejo del subconjunto que pide la app. La forma canónica de estas filas vive en
// lib/finanzas/caja-chica.ts; aquí solo se declara lo que el celular pinta.

/** Fila de v_caja_chica_rendiciones. monto_rendido, saldo_pendiente, atrasada y dias_atraso
 *  son DERIVADOS de la vista: nunca se recalculan en el cliente. */
type MiRendicion = {
  id: number; codigo: string | null; estado: string; moneda: string;
  monto_asignado: number; monto_rendido: number; monto_por_revisar: number;
  monto_rechazado: number; monto_devuelto: number; saldo_pendiente: number;
  comprobantes: number; fecha_entrega: string; fecha_limite: string | null;
  atrasada: boolean; dias_atraso: number; motivo_observacion: string | null;
};

type GastoRendido = {
  id: number; fecha: string; categoria: string; descripcion: string | null;
  monto: number; moneda: string; tipo_comprobante: string | null;
  estado_revision: EstadoRevisionGasto; motivo_rechazo: string | null; created_at: string;
};

/** Payload de un gasto tal cual viaja al API. Es TAMBIÉN lo que se guarda en la cola offline,
 *  foto incluida — el token NO: se inyecta al enviar, para que un gasto encolado siga siendo
 *  enviable después de que el conductor vuelva a iniciar sesión. */
type GastoPendiente = {
  /** Id local del envío (lo pone la cola al persistir; el servidor lo ignora). */
  _cola_id?: string;
  sin_comprobante?: boolean;
  gasto: {
    fecha: string; categoria: string; descripcion: string | null; monto: number;
    reserva_id: number | null; vehiculo_id: number | null; vehiculo_es_tercero: boolean;
    lat: number | null; lng: number | null; capturado_en: string;
    foto_adjunto?: { media_type: string; data: string };
  };
};

type IncidenciaTipo = "trafico" | "mecanica" | "pasajero" | "accidente" | "combustible" | "seguridad";
type Severidad      = "bajo" | "medio" | "alto";

// ─── CONSTANTES ───────────────────────────────────────────────────────────────

const CHECKLIST_ITEMS: CheckItem[] = [
  { id: "neumaticos",  label: "Neumáticos en buen estado",          categoria: "Seguridad",    ok: null },
  { id: "luces",       label: "Luces delanteras y traseras OK",      categoria: "Seguridad",    ok: null },
  { id: "frenos",      label: "Frenos funcionando correctamente",    categoria: "Seguridad",    ok: null },
  { id: "espejos",     label: "Espejos ajustados y limpios",         categoria: "Seguridad",    ok: null },
  { id: "cinturones",  label: "Cinturones de seguridad operativos",  categoria: "Seguridad",    ok: null },
  { id: "aceite",      label: "Nivel de aceite correcto",            categoria: "Mecánica",     ok: null },
  { id: "agua",        label: "Nivel de agua / refrigerante OK",     categoria: "Mecánica",     ok: null },
  { id: "combustible", label: "Combustible suficiente",              categoria: "Mecánica",     ok: null },
  { id: "bateria",     label: "Batería en buen estado",              categoria: "Mecánica",     ok: null },
  { id: "soat",        label: "SOAT vigente a bordo",                categoria: "Documentos",   ok: null },
  { id: "licencia_ab", label: "Licencia de conducir a bordo",        categoria: "Documentos",   ok: null },
  { id: "botiquin",    label: "Botiquín de primeros auxilios",       categoria: "Equipamiento", ok: null },
  { id: "extintor",    label: "Extintor vigente a bordo",            categoria: "Equipamiento", ok: null },
  { id: "limpieza",    label: "Unidad limpia y presentable",         categoria: "Equipamiento", ok: null },
];

const TIPOS_DOC = ["Licencia de conducir", "SCTR Salud", "Examen médico", "Psicosométrico", "Antecedentes", "Foto DNI", "Otro"];

// Categorías que el chofer ve en el celular: SUBCONJUNTO deliberado de CATEGORIAS_CAJA_CHICA.
// Combustible tiene su propio circuito (Radar IA + odómetro) y multa / trámite / repuesto menor
// no los decide él en la calle. Las etiquetas y emojis salen del diccionario compartido para que
// la bandeja del contador diga EXACTAMENTE lo mismo que vio el conductor al fotografiar.
const CATEGORIAS_GASTO_APP = ["peaje", "lavado", "estacionamiento", "viaticos", "movilidad", "otro"] as const;

// ─── Cola offline de gastos ───────────────────────────────────────────────────
// El check-out NO tiene cola, y por eso se pierden cierres hechos en cochera sin señal. La
// rendición sí la tiene: el gasto entero (foto en base64 incluida) espera en localStorage y se
// drena en los eventos `online` / `visibilitychange`, igual que el check-in pendiente.
const COLA_GASTOS = "afa_rendicion_pendiente";

function leerColaGastos(): GastoPendiente[] {
  try {
    const raw = localStorage.getItem(COLA_GASTOS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? (arr as GastoPendiente[]) : [];
  } catch { return []; }
}

/** Id local del envío encolado. NO lo lee el servidor (ignora las claves que no conoce): sirve
 *  para sacar de la cola EXACTAMENTE los envíos que se resolvieron, sin pisar los que el chofer
 *  agregó mientras el drenado estaba en vuelo. */
function nuevoIdCola(): string {
  try { return crypto.randomUUID(); } catch { return `g-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

/** Guarda la cola y devuelve lo que realmente cupo. Cada gasto arrastra su foto comprimida
 *  (~300-500 KB en base64) contra los ~5 MB de localStorage, así que se limita a los últimos 6 y,
 *  si aun así revienta la cuota, se van cayendo los MÁS VIEJOS: perder el intento antiguo es
 *  mejor que perder el ticket que el chofer acaba de fotografiar. */
function guardarColaGastos(arr: GastoPendiente[]): GastoPendiente[] {
  // Sella aquí el id porque este es el ÚNICO escritor de la cola: así nada persistido queda sin él.
  let cola = arr.slice(-6).map(p => (p._cola_id ? p : { ...p, _cola_id: nuevoIdCola() }));
  while (cola.length > 0) {
    try { localStorage.setItem(COLA_GASTOS, JSON.stringify(cola)); return cola; }
    catch { cola = cola.slice(1); }
  }
  try { localStorage.removeItem(COLA_GASTOS); } catch {}
  return cola;
}

const INCIDENCIA_TIPOS: { id: IncidenciaTipo; label: string; icon: (p: any) => ReactElement }[] = [
  { id: "trafico",     label: "Tráfico",     icon: IconActivity },
  { id: "mecanica",    label: "Mecánica",    icon: IconWrench },
  { id: "pasajero",    label: "Pasajero",    icon: IconUser },
  { id: "accidente",   label: "Accidente",   icon: IconAlert },
  { id: "combustible", label: "Combustible", icon: IconFuel },
  { id: "seguridad",   label: "Seguridad",   icon: IconShield },
];

const SEVERIDADES: { id: Severidad; label: string; color: string; bg: string }[] = [
  { id: "bajo",  label: "Leve",  color: "var(--c-success)", bg: "var(--c-success-tint)" },
  { id: "medio", label: "Media", color: "var(--c-warn)",    bg: "var(--c-warn-tint)" },
  { id: "alto",  label: "Alta",  color: "var(--c-danger)",  bg: "var(--c-danger-tint)" },
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Fecha local (Lima UTC-5) — NO usar new Date().toISOString().
function getFechaLocal(): string {
  const now = new Date();
  const year  = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day   = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function diasPara(f: string | null) {
  if (!f) return null;
  return Math.ceil((new Date(f + "T00:00:00").getTime() - Date.now()) / 86400000);
}

// Llave de acceso a /api/conductor. La manda la app sola en cada llamada (el conductor
// no escribe nada). El servidor la exige solo si NEXT_PUBLIC_AFA_CONDUCTOR_KEY está seteada.
const AFA_KEY = process.env.NEXT_PUBLIC_AFA_CONDUCTOR_KEY || "";

// Un pasajero está "a bordo" si su estado es "abordado" (valor canónico que produce el
// trigger sync_estados_pasajero_parada de la BD) o "embarcado" (valor legacy en datos
// viejos). Tolerar ambos evita falsos "no subió" tras el cambio de valor canónico.
const esAbordado = (e?: string | null) => e === "abordado" || e === "embarcado";

// Llama al endpoint con service_role del conductor (saltea RLS — el conductor es
// anónimo porque usa PIN, no sesión Supabase). Lanza Error con el mensaje del server.
async function condApi(accion: string, params: Record<string, any> = {}) {
  // Sello del reloj del DISPOSITIVO en el instante del envío. El servidor lo compara con el
  // suyo para saber cuánto miente este celular y corregir las horas de captura que manda
  // (ver corregirCapturaPorReloj). Se toma aquí, en cada intento, y no al armar el payload:
  // así una lectura que estuvo horas en la cola offline mide el error del reloj, no la espera.
  const bodyObj = { accion, ...params, _cliente_ts: new Date().toISOString() };
  // HTTP nativo (CapacitorHttp) SOLO para los envíos de GPS y SOLO cuando el plugin
  // de background está activo (APK recompilado): NO se throttlea en segundo plano
  // como el fetch del WebView. En todo lo demás y en APK viejos → fetch (probado).
  if (accion === "ubicacion" && esAppNativa() && backgroundGpsActivo()) {
    try {
      const { CapacitorHttp } = await import("@capacitor/core");
      if ((CapacitorHttp as any)?.post) {
        const base = typeof window !== "undefined" ? window.location.origin : "";
        const resp: any = await CapacitorHttp.post({
          url: `${base}/api/conductor`,
          headers: { "Content-Type": "application/json", "x-afa-key": AFA_KEY },
          data: bodyObj,
        });
        const parsed = typeof resp?.data === "string"
          ? (() => { try { return JSON.parse(resp.data); } catch { return {}; } })()
          : (resp?.data ?? {});
        if (resp.status < 200 || resp.status >= 300) throw new Error(parsed.error || `HTTP ${resp.status}`);
        return parsed;
      }
    } catch {
      // CapacitorHttp falló/ausente → cae a fetch (el punto no llegó al server, reintento seguro).
    }
  }
  const res = await fetch("/api/conductor", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-afa-key": AFA_KEY },
    body: JSON.stringify(bodyObj),
  });
  const json = await res.json().catch(() => ({}));
  // El estado HTTP y el cuerpo viajan PEGADOS al Error (aditivo: ningún llamador previo los
  // lee). La cola de gastos los necesita para distinguir "sin red, reintenta luego" de un
  // rechazo definitivo — sobre todo `duplicado`, que significa "ese gasto YA entró en un
  // intento anterior": reintentarlo sería un bucle infinito contra el índice único.
  if (!res.ok) throw Object.assign(new Error(json.error || "Error de red"), { estado: res.status, datos: json });
  return json;
}

/** Error de condApi con lo que el servidor dijo. `estado` y `datos` faltan cuando el fallo fue
 *  antes de la respuesta (sin red, DNS, abort): eso es justo lo que hay que reintentar. */
type ErrorApi = Error & { estado?: number; datos?: { duplicado?: boolean } };
function errorApi(e: unknown): ErrorApi {
  return (e instanceof Error ? e : new Error(String(e))) as ErrorApi;
}

function docEstado(f: string | null): "ok" | "pronto" | "vencido" | "sin" {
  const d = diasPara(f); if (d === null) return "sin";
  if (d < 0) return "vencido"; if (d <= 30) return "pronto"; return "ok";
}

function ini(n: string): string {
  return n.split(" ").slice(0, 2).map(w => w[0]).join("").toUpperCase();
}

// Minutos RELATIVOS a ahora para una hora "HH:MM" del día actual: POSITIVO si aún falta,
// NEGATIVO si ya pasó (conserva el signo para mostrar "atrasado" sin esconder el servicio).
function minutosRelativos(hora: string | null | undefined): number | null {
  if (!hora) return null;
  const [h, m] = hora.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  return Math.floor((target.getTime() - now.getTime()) / 60000);
}

function fmtCountdown(mins: number): string {
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  return `${String(mins).padStart(2, "0")}m`;
}

// Acorta una dirección de Google para la tarjeta SIN perder información útil. Quita solo el RUIDO
// puro: el plus-code (código abierto de ubicación, tipo "VX54+Q5R") y el país final ("Perú"). La
// "cola" final de localidad + código postal ("Distrito 13008") se descarta SOLO cuando la dirección
// es rica (>=3 segmentos): así una dirección pobre como "D, XVXJ+5GV, Callao 07031, Perú" conserva
// el distrito ("D, Callao 07031") en vez de quedar en un muñón inútil ("D, Perú"). Fallback: original.
function acortarLugar(dir?: string | null): string {
  const full = (dir ?? "").trim();
  if (!full) return "—";
  let segs = full.split(",").map(s => s.trim()).filter(Boolean);
  const esPlusCode   = (s: string) => /^[0-9A-Z]{2,}\+[0-9A-Z]+$/i.test(s);
  const esPais       = (s: string) => /^per[uú]$/i.test(s);
  const esColaPostal = (s: string) => /\d{5}\s*$/.test(s); // "... 13008" (postal Perú = 5 dígitos)
  segs = segs.filter(s => !esPlusCode(s) && !esPais(s));
  if (segs.length >= 3 && esColaPostal(segs[segs.length - 1])) segs = segs.slice(0, -1);
  return segs.join(", ") || full;
}

function fmtDuracion(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

function playBeep(tipo: "ok" | "warn" | "error") {
  try {
    const ctx = new ((window as any).AudioContext || (window as any).webkitAudioContext)();
    // Compresor para maximizar volumen sin distorsión
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    const play = (freq: number, startSec: number, dur: number, type: OscillatorType = "square") => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(comp);
      osc.frequency.value = freq;
      osc.type = type;
      gain.gain.setValueAtTime(1.0, ctx.currentTime + startSec);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startSec + dur);
      osc.start(ctx.currentTime + startSec);
      osc.stop(ctx.currentTime + startSec + dur + 0.05);
    };
    if (tipo === "ok")    { play(880,  0,    0.10); play(1100, 0.14, 0.10); }
    if (tipo === "warn")  { play(440,  0,    0.20); }
    if (tipo === "error") { play(180,  0,    0.18, "sawtooth"); play(130, 0.20, 0.25, "sawtooth"); }
  } catch { /* AudioContext no disponible */ }
}

// Formato corto y limpio de fecha para la agenda: "Lun 29 jun" (día con inicial mayúscula,
// sin coma ni punto tras la abreviatura del mes). Recibe la fecha ISO (YYYY-MM-DD) visible.
function fmtFechaCorta(iso: string): string {
  const d = new Date(iso + "T12:00:00");
  const dow = d.toLocaleDateString("es-PE", { weekday: "short" }).replace(/\.$/, "");
  const dm  = d.toLocaleDateString("es-PE", { day: "numeric", month: "short" }).replace(/\.$/, "");
  return dow.charAt(0).toUpperCase() + dow.slice(1) + " " + dm;
}

// ─── Ritmo de envío GPS ADAPTATIVO ────────────────────────────────────────────
// Distancia en metros entre dos posiciones (haversine). Sirve para enviar ANTES del
// intervalo por tiempo cuando el móvil dio un salto grande entre capturas (curva,
// aceleración) y así no "cortar" la huella.
function distanciaMetros(a: GeoPos, b: GeoPos): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.coords.latitude - a.coords.latitude);
  const dLng = toRad(b.coords.longitude - a.coords.longitude);
  const lat1 = toRad(a.coords.latitude);
  const lat2 = toRad(b.coords.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Intervalo OBJETIVO de envío según la marcha. GPS vehicular: frecuente cuando importa
// (rápido, cerca de paradero, emergencia) y espaciado detenido para ahorrar batería,
// datos y costo de backend. El piso de CAPTURA lo fija el plugin nativo
// (HEARTBEAT_INTERVAL_MS en patches/@capgo+background-geolocation+8.0.40.patch); aquí
// solo decidimos CUÁNDO enviar cada fix capturado.
function intervaloEnvioMs(kmh: number, cercaParadero: boolean, emergencia: boolean): number {
  if (emergencia)    return 2000;   // SOS: lo más rápido que permita la captura
  if (cercaParadero) return 3000;   // arribo/embarque: precisar la maniobra
  // Cadencia MÁS DENSA (jul-2026, pedido del usuario: "en tramos lentos solo veo 2 puntos y la huella
  // falla"). Más fixes en lento/urbano = más fuente para el Map Matching (menos zigzag/estimado). El
  // salto-gate de >40 m (abajo) además dispara envíos aunque la velocidad se clasifique mal como parada.
  if (kmh < 3)       return 15000;  // detenido: heartbeat (antes 25 s; baja para el lento-mal-clasificado)
  if (kmh < 20)      return 3000;   // lento / maniobras / tráfico denso → antes 5 s: la queja del usuario
  if (kmh < 60)      return 3000;   // urbano (antes 4 s)
  return 3000;                      // carretera
}

// Umbral "esto NO es satélite, es ubicación de red". Medido sobre la flota (4 días, conductores con
// ≥100 fixes): los equipos que entregan GNSS real dan mediana 1.8-7.7 m; los que salen por antena/
// WiFi, 15.9-200 m. El hueco entre 7.7 y 15.9 es limpio → 12 m separa sin falsos positivos. ANTES
// estaba en 60 m: por eso el semáforo estuvo VERDE toda la noche del servicio #24738, que corrió a
// 22 m de mediana (ubicación de red pura) con huecos de hasta 11,7 min y el bus en movimiento.
const ACC_RED_M = 12;

// true si la posición está a < UMBRAL_PARADERO_M de alguna parada con coordenadas.
const UMBRAL_PARADERO_M = 150;
function cercaDeAlgunParadero(pos: GeoPos, paradas: { lat: number | null; lng: number | null }[]): boolean {
  for (const p of paradas) {
    if (p.lat == null || p.lng == null) continue;
    const d = distanciaMetros(pos, { coords: { latitude: p.lat, longitude: p.lng, accuracy: 0 } });
    if (d < UMBRAL_PARADERO_M) return true;
  }
  return false;
}

// ─── GEOFENCE DE AUTO-LLEGADA (nudge, no marca sola) ───────────────────────────
// Detecta que el bus llegó al paradero para RECORDARLE al conductor que marque la
// llegada — nunca marca en silencio (una marca falsa avisa a pasajeros y ensucia el
// registro; ver /api/conductor "quedan_paradas"). Dos avisos: SUAVE al detenerse en
// el paradero y FUERTE si se aleja sin marcar. La histéresis entrada/salida evita el
// parpadeo por deriva del GPS. Distancias, no velocidad: los equipos sin Doppler
// reportan speed=0 y confundirían "detenido" con "pasando lento" — la PRESENCIA
// sostenida dentro del radio es una señal robusta en cualquier equipo.
const GEO_ACC_MAX      = 80;     // m: fixes peores que esto no deciden geofence (basura de torre/red)
const GEO_RADIO_ENTRADA = 120;   // m: entró al paradero (radio interno)
const GEO_RADIO_SALIDA  = 250;   // m: se alejó del paradero (radio externo → dispara aviso fuerte)
const GEO_DWELL_MS      = 20000;  // ms de presencia continua dentro del radio interno → "estás en el paradero"
// Atribución de EMBARQUE por GPS: el paradero real donde está el bus al escanear,
// no el puntero manual (que el nudge/marcado puede haber adelantado).
const GEO_RADIO_EMBARQUE  = 200;  // m: tope para considerar que el bus está EN ese paradero
const GEO_MARGEN_EMBARQUE = 40;   // m: el más cercano debe ganarle por esto al 2º (si no, empate → puntero)

// Paradero (con coordenadas) más cercano a `pos` y su distancia. null si no hay ninguno
// con coordenadas. Base de la atribución de embarque por realidad física.
function paraderoCercano(
  pos: GeoPos,
  paradas: { id: number; lat: number | null; lng: number | null }[],
): { id: number; dist: number; segundo: number } | null {
  let mejorId = -1, mejor = Infinity, segundo = Infinity;
  for (const p of paradas) {
    if (p.lat == null || p.lng == null) continue;
    const d = distanciaMetros(pos, { coords: { latitude: p.lat, longitude: p.lng, accuracy: 0 } });
    if (d < mejor) { segundo = mejor; mejor = d; mejorId = p.id; }
    else if (d < segundo) { segundo = d; }
  }
  return mejorId === -1 ? null : { id: mejorId, dist: mejor, segundo };
}

// Notificación NATIVA del SO (tipo Temu): se ve con el app cerrado/minimizado. Requiere
// APK recompilado con `npx cap sync android` (el plugin @capacitor/local-notifications).
// En web es no-op; el aviso DENTRO del app (banner) sí funciona en todos lados. El canal
// se crea en el useEffect de arranque; aquí solo se agenda inmediata (id fijo por tipo →
// una nueva reemplaza a la anterior, sin acumular).
async function notificarLlegadaNativa(tipo: "suave" | "fuerte", titulo: string, cuerpo: string): Promise<void> {
  if (!esAppNativa()) return;                 // web: el banner in-app cubre
  try {
    const { LocalNotifications } = await import("@capacitor/local-notifications");
    try {
      const perm = await LocalNotifications.checkPermissions();
      if (perm.display !== "granted") {
        const req = await LocalNotifications.requestPermissions();
        if (req.display !== "granted") return;
      }
    } catch { /* checkPermissions ausente en APK viejo → intentar agendar igual */ }
    await LocalNotifications.schedule({
      notifications: [{
        id: tipo === "fuerte" ? 88001 : 88002,
        channelId: tipo === "fuerte" ? "afa_llegada_fuerte" : "afa_llegada_suave",
        title: titulo,
        body: cuerpo,
        extra: { tipo, origen: "nudge_llegada" },
      }],
    });
  } catch { /* plugin ausente (APK sin recompilar) o error → el banner in-app cubre */ }
}

// ─── GUÍA DE AJUSTES DEL EQUIPO (para que el fabricante no mate el rastreo) ──────
// Android NO deja que una app active autostart / batería sin restricciones / bloqueo
// en Recientes por su cuenta: son ajustes del usuario. Lo máximo es DETECTAR la marca
// y GUIAR al conductor paso a paso (él toca los toggles). Esto sube la disponibilidad
// real más que cualquier watchdog (la causa #1 de cortes es el matado por fabricante).
type PasoAjuste = { titulo: string; detalle: string };
type GuiaFabricante = { marca: string; pasos: PasoAjuste[] };

function detectarFabricanteGps(): string {
  const ua = (typeof navigator !== "undefined" ? navigator.userAgent : "").toLowerCase();
  if (/xiaomi|redmi|poco|miui|hyperos/.test(ua)) return "xiaomi";
  if (/samsung|sm-/.test(ua))                    return "samsung";
  if (/oppo|cph/.test(ua))                        return "oppo";
  if (/vivo/.test(ua))                            return "vivo";
  if (/realme|rmx/.test(ua))                      return "realme";
  if (/huawei|honor|\bhry\b|\blio\b/.test(ua))   return "huawei";
  if (/motorola|moto\b|\bmoto /.test(ua))         return "motorola";
  return "generico";
}

const PASOS_COMUNES: PasoAjuste[] = [
  { titulo: "Ubicación: “Permitir todo el tiempo”", detalle: "Ajustes → Apps → AFA Conductores → Permisos → Ubicación → Permitir todo el tiempo." },
  { titulo: "Batería: “Sin restricciones”", detalle: "Ajustes → Apps → AFA Conductores → Batería → Sin restricciones (o “No optimizar”)." },
  { titulo: "Bloquea la app en Recientes", detalle: "Abre Recientes (multitarea), mantén presionada AFA Conductores y toca el candado para que el sistema no la cierre." },
];

const GUIA_AJUSTES_GPS: Record<string, GuiaFabricante> = {
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

// ─── CHAT CON PASAJEROS ───────────────────────────────────────────────────────

// Respuestas rápidas del conductor.
const RESP_RAPIDAS_COND = [
  "Ya voy en camino 🚌",
  "Llego en ~5 minutos.",
  "Estoy llegando a tu paradero.",
  "Por favor acércate al punto de recojo.",
  "Entendido, gracias por avisar.",
];

// Agrupa los mensajes del servicio en hilos por pasajero (bandeja del conductor).
function agruparThreadsCond(msgs: any[]) {
  const map = new Map<number, { paxId: number; nombre: string; empresa: string | null; msgs: any[]; ultimo: any; noLeidos: number }>();
  for (const m of msgs) {
    const pid = m.pasajero_id;
    if (pid == null) continue;
    const prev = map.get(pid);
    if (!prev) {
      map.set(pid, {
        paxId: pid, nombre: m.pasajero?.nombre || "Pasajero", empresa: m.pasajero?.empresa || null,
        msgs: [m], ultimo: m, noLeidos: m.remitente === "pasajero" && !m.leido ? 1 : 0,
      });
    } else {
      prev.msgs.push(m); prev.ultimo = m;
      if (m.remitente === "pasajero" && !m.leido) prev.noLeidos++;
    }
  }
  return [...map.values()].sort((a, b) => new Date(b.ultimo.created_at).getTime() - new Date(a.ultimo.created_at).getTime());
}

// ─── SESSION ──────────────────────────────────────────────────────────────────

const SK = "afa_cond_v2";
function saveSession(c: Conductor) {
  // El PIN NUNCA se persiste: la credencial de sesión es `_token` (firmado en el
  // servidor). Antes se guardaba el conductor entero, PIN en claro incluido.
  const { pin_acceso: _omitido, ...limpio } = c;
  localStorage.setItem(SK, JSON.stringify({ c: { ...limpio, pin_acceso: null }, exp: Date.now() + 12 * 3600000 }));
}
function loadSession(): Conductor | null {
  try {
    const raw = localStorage.getItem(SK); if (!raw) return null;
    const { c, exp } = JSON.parse(raw);
    if (Date.now() > exp) { localStorage.removeItem(SK); return null; }
    // Higiene: una sesión creada por la versión anterior todavía trae el PIN guardado.
    // Se borra del almacenamiento en el primer arranque de esta versión.
    if (c && c.pin_acceso) {
      c.pin_acceso = null;
      localStorage.setItem(SK, JSON.stringify({ c, exp }));
    }
    return c;
  } catch { return null; }
}
function clearSession() { localStorage.removeItem(SK); }

// ─── SERVICIO ACTIVO (persiste entre recargas) ────────────────────────────────

const SK_SRV = "afa_serv_v1";
type ServicioGuardado = {
  reservaId: number; vehiculoId: number;
  paradaIdx: number; inicioViaje: string;
  // Estado del operador (programada/confirmada) que la reserva tenía ANTES de que el
  // conductor la pusiera en_curso. Se restaura si el conductor "Sale" del servicio.
  estadoPrevio?: string | null;
};
// Merge con lo ya guardado: los re-guardados parciales (p.ej. avance de paradero) NO
// deben borrar estadoPrevio fijado al iniciar.
function saveServicio(d: ServicioGuardado) {
  const prev = loadServicio();
  localStorage.setItem(SK_SRV, JSON.stringify({ ...prev, ...d }));
}
function loadServicio(): ServicioGuardado | null {
  try {
    const raw = localStorage.getItem(SK_SRV);
    return raw ? (JSON.parse(raw) as ServicioGuardado) : null;
  } catch { return null; }
}
function clearServicio() {
  localStorage.removeItem(SK_SRV);
  // Al terminar/salir del servicio, limpiar la detección de "muerte por batería" para que un
  // latido viejo no dispare un falso aviso en la próxima apertura (servicio nuevo limpio).
  localStorage.removeItem("afa_gps_latido");
  localStorage.removeItem("afa_gps_corte_pendiente");
}

// ─── COLA OFFLINE DE GPS (no perder puntos cuando se cae la señal) ─────────────
const SK_COLA = "afa_gps_cola_v1";
type PuntoGps = Record<string, any> & { _qid: string };
function leerCola(): PuntoGps[] {
  try { const raw = localStorage.getItem(SK_COLA); return raw ? (JSON.parse(raw) as PuntoGps[]) : []; }
  catch { return []; }
}
function guardarCola(arr: PuntoGps[]) {
  // 1200 puntos ≈ 80 min sin señal a la cadencia de marcha (4 s). Con 300, la cadencia por
  // velocidad derivada (equipos sin Doppler ya no quedan en 25 s) reducía la autonomía
  // offline de ~2 h a ~20 min. Sigue siendo <500 KB de localStorage.
  try { localStorage.setItem(SK_COLA, JSON.stringify(arr.slice(-1200))); } catch {}
}
function encolar(p: PuntoGps) { const c = leerCola(); c.push(p); guardarCola(c); }
function nuevoQid(): string {
  try { return crypto.randomUUID(); }
  catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}

// ─── Deslizable "Conectarse" (estilo Uber/Cabify) ──────────────────────────────
// Gesto DELIBERADO (arrastrar el botón hasta el final) para conectarse y empezar a
// compartir GPS. El gesto explícito evita conexiones accidentales y satisface el
// requisito de Google Play de que el rastreo en segundo plano lo inicie una acción
// clara del usuario (no el simple login).
function SlideToConnect({ onConnect }: { onConnect: () => void }) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const maxRef = useRef(0);
  const KNOB = 52;

  const begin = (clientX: number) => {
    const track = trackRef.current; if (!track) return;
    maxRef.current = Math.max(0, track.clientWidth - KNOB - 14); // 7px de padding a cada lado
    startXRef.current = clientX - dragX;
    setDragging(true);
  };
  const move = (clientX: number) => {
    if (!dragging) return;
    setDragX(Math.max(0, Math.min(maxRef.current, clientX - startXRef.current)));
  };
  const end = () => {
    if (!dragging) return;
    setDragging(false);
    if (dragX >= maxRef.current * 0.9) { setDragX(maxRef.current); onConnect(); }
    else setDragX(0);
  };

  return (
    <div
      ref={trackRef}
      onPointerDown={(e) => { try { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } catch {} begin(e.clientX); }}
      onPointerMove={(e) => move(e.clientX)}
      onPointerUp={end}
      onPointerCancel={end}
      style={{
        position: "relative", background: "var(--c-navy)", borderRadius: 18, padding: 7,
        overflow: "hidden", touchAction: "none", userSelect: "none", cursor: "grab",
      }}
    >
      {/* relleno verde que crece con el arrastre */}
      <div style={{
        position: "absolute", left: 0, top: 0, bottom: 0, width: dragX + KNOB + 14,
        background: "var(--c-success)", opacity: 0.22,
        transition: dragging ? "none" : "width .2s ease",
      }} />
      {/* botón (knob) */}
      <div style={{
        position: "absolute", left: 7 + dragX, top: 7, bottom: 7, width: KNOB,
        background: "var(--c-success)", borderRadius: 13, zIndex: 2,
        display: "flex", alignItems: "center", justifyContent: "center",
        transition: dragging ? "none" : "left .2s ease",
      }}>
        <IconArrowRight size={22} color="#fff" />
      </div>
      {/* Pista animada: dos chevrons que "respiran" y empujan a la derecha, indicando hacia
          dónde deslizar. Se desvanecen a medida que el knob avanza (no estorban al arrastrar). */}
      <div aria-hidden style={{
        position: "absolute", right: 18, top: 0, bottom: 0, zIndex: 1,
        display: "flex", alignItems: "center", pointerEvents: "none",
        opacity: Math.max(0, 1 - dragX / 80),
        transition: dragging ? "none" : "opacity .2s ease",
      }}>
        <div style={{ display: "flex", alignItems: "center", animation: "hintpulse 1.8s ease-in-out infinite" }}>
          <IconChevronRight size={20} color="#fff" sw={2.6} />
          <IconChevronRight size={20} color="#fff" sw={2.6} style={{ marginLeft: -10 }} />
        </div>
      </div>
      <div style={{
        textAlign: "center", padding: "14px 44px 14px 52px", position: "relative", zIndex: 1,
        color: "rgba(255,255,255,0.88)", fontSize: 14, fontWeight: 800, fontFamily: FONT_SANS,
        letterSpacing: -0.2, pointerEvents: "none",
      }}>
        Desliza para conectarte
      </div>
    </div>
  );
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function ConductorApp() {

  const [initing,      setIniting]      = useState(true);
  const [conductor,    setConductor]    = useState<Conductor | null>(null);
  const [tab,          setTab]          = useState<Tab>("ruta");

  // ── Login ──────────────────────────────────────────────────────────────────
  const [dni,          setDni]          = useState("");
  const [pin,          setPin]          = useState("");
  const [loginErr,     setLoginErr]     = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  // ── Datos ──────────────────────────────────────────────────────────────────
  const [vehiculos,    setVehiculos]    = useState<Vehiculo[]>([]);
  const [reservasHoy,  setReservasHoy]  = useState<Reserva[]>([]);
  const [vehiculoId,   setVehiculoId]   = useState<number | null>(null);
  const [reservaActiva,setReservaActiva]= useState<Reserva | null>(null);
  const [paradas,      setParadas]      = useState<Parada[]>([]);
  const [pasajeros,    setPasajeros]    = useState<PasajeroParada[]>([]);
  const [paradaIdx,    setParadaIdx]    = useState(0);
  const [docs,         setDocs]         = useState<DocCond[]>([]);
  const [cargando,          setCargando]          = useState(false);
  const [debugFecha,        setDebugFecha]        = useState("");
  const [debugInfo,         setDebugInfo]         = useState("");
  const [fechaVista,        setFechaVista]        = useState<string>(getFechaLocal());
  const [reservasOtraFecha, setReservasOtraFecha] = useState<Reserva[] | null>(null);
  const [cargandoOtraFecha, setCargandoOtraFecha] = useState(false);

  // ── CHAT CON PASAJEROS (solo del servicio activo; responder a quien escribe) ──
  const [chatOpen,     setChatOpen]     = useState(false);
  const [chatMsgs,     setChatMsgs]     = useState<any[]>([]);
  const [chatPaxSel,   setChatPaxSel]   = useState<number | null>(null); // hilo abierto
  const [chatBorrador, setChatBorrador] = useState("");
  const [chatEnviando, setChatEnviando] = useState(false);
  const chatFinRef = useRef<HTMLDivElement | null>(null);

  // ── GPS ────────────────────────────────────────────────────────────────────
  const [enRuta,       setEnRuta]       = useState(false);
  // "Conectarse" (estilo Uber/Cabify): el conductor comparte su GPS aun SIN servicio,
  // para ser visible en el ERP (monitoreo/despachador) y recibir asignaciones.
  const [conectado,    setConectado]    = useState(false);
  // El rastreo se comparte si el conductor se CONECTÓ o si hay un SERVICIO activo —
  // NUNCA por el solo login (cumple la política de ubicación de Google Play).
  const compartiendo = conectado || enRuta;
  const [posActual,    setPosActual]    = useState<GeoPos | null>(null);
  const [velocidad,    setVelocidad]    = useState(0);
  const [totalEnvios,  setTotalEnvios]  = useState(0);
  const [ultimoEnvio,  setUltimoEnvio]  = useState<Date | null>(null);
  const [gpsError,     setGpsError]     = useState<string | null>(null);
  // GPS ATASCADO: el proveedor del equipo repite el MISMO fix (callbacks vivos, contenido
  // clavado) y los re-arms no lo destrabaron → solo lo cura el propio teléfono (apagar y
  // encender la Ubicación reinicia el motor GMS; más rápido que reiniciar el equipo).
  const [gpsAtascado,  setGpsAtascado]  = useState(false);
  const [envioError,   setEnvioError]   = useState<string | null>(null);
  const [pendientes,   setPendientes]   = useState(0);
  const [iniciando,          setIniciando]          = useState(false);
  const [inicioViaje,        setInicioViaje]        = useState<Date | null>(null);
  const [restaurandoServicio,setRestaurandoServicio] = useState(false);
  const pinInputRef      = useRef<HTMLInputElement | null>(null);
  const watchIdRef       = useRef<GeoWatch | null>(null);
  const intervalRef      = useRef<NodeJS.Timeout | null>(null);
  const posRef           = useRef<GeoPos | null>(null);
  const ultimoFixRef     = useRef<number>(0); // ms del último fix RECIBIDO (watchdog de auto-recuperación)
  const ultimoReArmRef   = useRef<number>(0); // ms del último re-arm del GPS (coalesce: máx 1 cada 10 s)
  const accsRecRef       = useRef<number[]>([]); // accuracy (m) de los últimos fixes RECIBIDOS (detector de GPS débil medido)
  // Detector de fix CONGELADO (caso Motorola/FUSED atascado): el proveedor sigue entregando
  // callbacks pero con el MISMO fix cacheado. ultimoFixRef no lo distingue (mide llegadas);
  // estos refs miran el CONTENIDO. fixPrevRef sobrevive a los re-arms A PROPÓSITO: el seed
  // stale:true del plugin re-entrega el mismo fix tras cada stop→start, y si lo olvidáramos
  // contaría como "fix nuevo" y enmascararía el atasco.
  const fixPrevRef       = useRef<{ t: number | null; lat: number; lng: number } | null>(null);
  const ultimoAvanceRef  = useRef<number>(0); // ms (reloj) de la última vez que el CONTENIDO del fix avanzó
  const ultimoCambioPosRef = useRef<number>(0); // ms (reloj) de la última vez que la POSICIÓN cambió (variante #951: timestamps frescos con posición clavada)
  const fixRealTsRef     = useRef<number>(0); // timestamp del PROVEEDOR del último fix que avanzó → fix_ts honesto
  const reArmsCongeladoRef = useRef(0);       // re-arms por congelado sin que el fix avance (escala al banner)
  // Cola/reintentos de envío GPS
  const drenandoRef      = useRef(false);
  const reintentoRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentosRef      = useRef(0);
  const lastSentRef      = useRef(0);
  const lastSentPosRef   = useRef<GeoPos | null>(null); // última posición ENVIADA (gate por distancia)
  const fixesVelRef      = useRef<{ lat: number; lng: number; acc: number; ts: number }[]>([]); // ring de fixes recientes → velocidad DERIVADA para la cadencia (equipos sin Doppler)
  const drenarColaRef    = useRef<() => void>(() => {});
  // Refs estables para GPS (evitan closures obsoletos en setInterval)
  const vehiculoIdRef    = useRef<number | null>(null);
  const conductorRef     = useRef<Conductor | null>(null);
  const reservaActivaRef = useRef<Reserva | null>(null);
  const paradasRef       = useRef<Parada[]>([]); // para el gate "cerca de paradero" del envío
  const paradaIdxRef     = useRef(0);            // puntero actual sin closures obsoletos (geofence)
  // Máquina de estados del geofence de auto-llegada para la PARADA ACTUAL. Se reinicia
  // sola cuando cambia `paradaId`. `entroTs` es la hora REAL de llegada (1ª entrada al
  // radio). `avisoSuave/avisoFuerte` son one-shot. `marcada` silencia tras marcar.
  const geoRef = useRef<{
    paradaId: number | null; entroTs: number | null; presenteDesde: number | null;
    avisoSuave: boolean; avisoFuerte: boolean; marcada: boolean;
  }>({ paradaId: null, entroTs: null, presenteDesde: null, avisoSuave: false, avisoFuerte: false, marcada: false });

  // ── Sync refs (para GPS sin closures obsoletos) ────────────────────────────
  useEffect(() => { vehiculoIdRef.current    = vehiculoId;    }, [vehiculoId]);
  useEffect(() => { conductorRef.current     = conductor;     }, [conductor]);
  useEffect(() => { reservaActivaRef.current = reservaActiva; }, [reservaActiva]);
  useEffect(() => { paradasRef.current       = paradas;       }, [paradas]);
  useEffect(() => { paradaIdxRef.current     = paradaIdx;     }, [paradaIdx]);

  // ── Notificaciones NATIVAS del SO para el nudge de auto-llegada: crea los canales
  //    (fuerte = heads-up con vibración · suave = discreto), pide permiso y escucha el
  //    TOQUE para traer el app a la pestaña de Ruta. Solo app nativa; en web es no-op.
  //    Requiere APK recompilado con `npx cap sync android`.
  useEffect(() => {
    if (!esAppNativa()) return;
    let quitar: (() => void) | undefined;
    (async () => {
      try {
        const { LocalNotifications } = await import("@capacitor/local-notifications");
        try {
          await LocalNotifications.createChannel({
            id: "afa_llegada_fuerte", name: "Llegada a paradero (urgente)",
            description: "Te alejaste de un paradero sin marcar la llegada",
            importance: 5, visibility: 1, vibration: true,
          });
          await LocalNotifications.createChannel({
            id: "afa_llegada_suave", name: "Llegada a paradero",
            description: "Estás en un paradero: marca tu llegada",
            importance: 3, visibility: 1, vibration: false,
          });
        } catch { /* iOS o canal ya existente */ }
        try {
          const perm = await LocalNotifications.checkPermissions();
          if (perm.display !== "granted") await LocalNotifications.requestPermissions();
        } catch { /* APK viejo sin la API */ }
        const h = await LocalNotifications.addListener("localNotificationActionPerformed", () => {
          setTab("paradas"); // el banner in-app ya está visible; solo traer el foco
        });
        quitar = () => { try { h.remove(); } catch { /* noop */ } };
      } catch { /* plugin ausente (APK sin recompilar) → el banner in-app cubre */ }
    })();
    return () => { if (quitar) quitar(); };
  }, []);
  // Sin deps: mantiene el ref apuntando a la versión más reciente (que cierra sobre estado fresco).
  useEffect(() => { procesarQRRef.current = procesarQR; });

  // ── Tick para refrescar countdown y duración (1 minuto) ────────────────────
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // ── SOS ────────────────────────────────────────────────────────────────────
  const [sosPct,       setSosPct]       = useState(0);
  const [sosActivo,    setSosActivo]    = useState(false);
  const [sosEnviado,   setSosEnviado]   = useState(false);
  const sosTimer       = useRef<NodeJS.Timeout | null>(null);
  const sosInterval    = useRef<NodeJS.Timeout | null>(null);

  // ── QR Scanner ─────────────────────────────────────────────────────────────
  const [escanear,          setEscanear]          = useState(false);
  const [validando,         setValidando]         = useState<Pasajero | null>(null); // kept for TS compat, unused after redesign
  const [resultadoEmbarque, setResultadoEmbarque] = useState<{ pasajero: Pasajero; fueraLista: boolean; otroBus?: boolean; cambioParada?: boolean; empresaAjena?: boolean; paradaOriginalNombre?: string | null; paradaEmbarqueNombre?: string | null } | null>(null);
  const [resultProgreso,    setResultProgreso]    = useState(0);
  const [boardingMsg,       setBoardingMsg]       = useState<{ok: boolean; msg: string} | null>(null);
  // Nudge de auto-llegada: banner DENTRO del app (además de la notificación del SO).
  // `tipo` = "suave" (estás en el paradero) | "fuerte" (te alejaste sin marcar).
  const [nudgeLlegada,  setNudgeLlegada]  = useState<{ paradaId: number; nombre: string; tipo: "suave" | "fuerte"; horaLlegada: number | null } | null>(null);
  // "Deshacer" tras marcar por el nudge (por si fue por error). Guarda el índice previo
  // para poder devolver el puntero. Se auto-oculta a los ~30 s.
  const [deshacerLlegada, setDeshacerLlegada] = useState<{ paradaId: number; nombre: string; idxPrevio: number } | null>(null);
  const deshacerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Feedback OPTIMISTA: se enciende al instante al escanear (antes de la red) y se apaga al
  // llegar el resultado. Hace que el conductor sienta respuesta inmediata aunque el server tarde.
  const [leyendo,           setLeyendo]           = useState(false);
  const qrRef               = useRef<any>(null);
  const resultIntervalRef   = useRef<NodeJS.Timeout | null>(null);
  const [btScanFlash,       setBtScanFlash]       = useState(false);
  // Ref siempre actualizado a procesarQR para evitar closure obsoleto en el listener BT.
  const procesarQRRef = useRef<(qr: string) => Promise<void>>(async () => {});
  // Candado de procesamiento COMPARTIDO entre cámara y escáner BT: evita doble embarque
  // por escaneos solapados (la cámara y el BT llaman ambos a procesarQR). Se toma/suelta
  // dentro de procesarQR (try/finally), así un solo punto cubre los dos caminos.
  const procesandoQRRef = useRef(false);

  // ── Checklist ──────────────────────────────────────────────────────────────
  const [checks,       setChecks]       = useState<CheckItem[]>(CHECKLIST_ITEMS.map(i => ({ ...i })));
  const [kmInicio,     setKmInicio]     = useState("");
  const [checkObs,     setCheckObs]     = useState("");
  const [checkDone,    setCheckDone]    = useState(false);
  const [checkSaving,  setCheckSaving]  = useState(false);
  const [ocrLeyendo,   setOcrLeyendo]   = useState(false);

  // ── Check-out de jornada ─────────────────────────────────────────────────────
  const [checkoutHecho,   setCheckoutHecho]   = useState(false);
  const [mostrarCheckout, setMostrarCheckout] = useState(false);
  const [kmFin,           setKmFin]           = useState("");
  const [nivelComb,       setNivelComb]       = useState("");
  const [checkoutObs,     setCheckoutObs]     = useState("");
  const [checkoutSaving,  setCheckoutSaving]  = useState(false);
  const [sinFotoMotivo,   setSinFotoMotivo]   = useState("");   // check-out sin foto (taller/avería/tablero apagado/unidad entregada)
  const [expandirSinFoto, setExpandirSinFoto] = useState(false);

  // Foto de odómetro capturada (comprimida, base64 para subir + miniatura + km leído por IA + GPS/hora).
  type FotoCapturada = { base64: string; previewUrl: string; kmOcr: number | null; capturadoEn: string; lat: number | null; lng: number | null };
  const [fotoCheckin,  setFotoCheckin]  = useState<FotoCapturada | null>(null);
  const [fotoCheckout, setFotoCheckout] = useState<FotoCapturada | null>(null);

  // ── Docs ───────────────────────────────────────────────────────────────────
  const [docTipo,      setDocTipo]      = useState(TIPOS_DOC[0]);
  const [docUrl,       setDocUrl]       = useState("");
  const [docVenc,      setDocVenc]      = useState("");
  const [docSaving,    setDocSaving]    = useState(false);

  // ── Rendición de gastos (caja chica) ───────────────────────────────────────
  // Foto del comprobante: mismo pipeline de compresión que la del odómetro, SIN OCR — un ticket
  // de peaje no tiene un número que valga la pena adivinar, y el monto lo teclea el chofer.
  type FotoComprobante = { base64: string; previewUrl: string; capturadoEn: string; lat: number | null; lng: number | null };
  const [ccRendicion,  setCcRendicion]  = useState<MiRendicion | null>(null);
  const [ccGastos,     setCcGastos]     = useState<GastoRendido[]>([]);
  const [ccCargando,   setCcCargando]   = useState(false);
  const [ccError,      setCcError]      = useState("");
  const [ccAviso,      setCcAviso]      = useState("");
  const [ccCola,       setCcCola]       = useState(0);          // gastos esperando en la cola offline
  const [ccForm,       setCcForm]       = useState(false);      // hoja de registro abierta
  const [ccCat,        setCcCat]        = useState<string>("peaje");
  const [ccMonto,      setCcMonto]      = useState("");
  const [ccDesc,       setCcDesc]       = useState("");
  const [ccReservaId,  setCcReservaId]  = useState<number | null>(null);
  const [ccFoto,       setCcFoto]       = useState<FotoComprobante | null>(null);
  const [ccFotoProc,   setCcFotoProc]   = useState(false);
  const [ccGuardando,  setCcGuardando]  = useState(false);
  const [ccEnviando,   setCcEnviando]   = useState(false);

  // ── Perfil ─────────────────────────────────────────────────────────────────
  const [pinNuevo,     setPinNuevo]     = useState("");
  const [pinConfirm,   setPinConfirm]   = useState("");
  const [pinMsg,       setPinMsg]       = useState("");
  const [camPin,       setCamPin]       = useState(false);

  // ── Notificación retraso ───────────────────────────────────────────────────
  const [notifEnviada, setNotifEnviada] = useState(false);

  // ── Sub-vistas nuevas ──────────────────────────────────────────────────────
  const [showManifiesto, setShowManifiesto] = useState(false);
  const [mostrarDivulgacion, setMostrarDivulgacion] = useState(false);
  // GPS se habilita solo después de que el conductor confirma el disclosure (primera vez).
  // En sesiones siguientes arranca inmediatamente porque el key ya está en localStorage.
  const [gpsHabilitado, setGpsHabilitado] = useState<boolean>(() => {
    try { return !!localStorage.getItem("afa_bg_disclosure_v1"); } catch { return true; }
  });
  // Pantalla de "Ajustes recomendados" (autostart/batería/recientes por fabricante) para que
  // el equipo no mate el rastreo. Se muestra una vez tras el disclosure y queda accesible desde
  // el botón en la cabecera de GPS. Solo aplica en la app nativa.
  const [mostrarAjustesGps, setMostrarAjustesGps] = useState(false);
  // Exención de batería del equipo: true=ya protegido (no molestar), false=expuesto (mostrar guía),
  // null=desconocido (web / APK viejo sin plugin).
  const [exentaBat, setExentaBat] = useState<boolean | null>(null);
  // Precisión del permiso de ubicación: "precisa"=FINE, "aproximada"=solo COARSE (±150 m),
  // "desconocida"=web / sin permiso / chequeo colgado (no afirmar). Legible por JS (@capacitor/geolocation).
  const [precUbic, setPrecUbic] = useState<GeoPrecision>("desconocida");
  // Gate FUERTE-SUAVE al iniciar servicio: reserva bloqueada por precisión aproximada (null=sin gate).
  const [gatePrecision, setGatePrecision] = useState<Reserva | null>(null);
  // true si la guía reaparece porque DETECTAMOS que el SO MATÓ la app a mitad de un viaje.
  const [cortePendiente, setCortePendiente] = useState(false);
  // ESTADO EN VIVO del servicio de fondo: true = el servicio nativo de segundo plano está
  // corriendo (rastrea con pantalla bloqueada); false = cayó a "solo con app abierta". A
  // diferencia de exentaBat (config), esto mide si REALMENTE está activo AHORA. Optimista
  // por defecto (true) para no parpadear mientras arranca.
  const [bgServicioActivo, setBgServicioActivo] = useState(true);
  // Expandir los pasos manuales (en equipos no-agresivos van colapsados tras "ver pasos").
  const [verPasosGps, setVerPasosGps] = useState(false);
  // Paso de ONBOARDING "batería" (APK 28+ con plugin): pantalla breve + botón que dispara el
  // diálogo NATIVO de exención del sistema, encadenado tras el permiso de ubicación. Reemplaza
  // a la guía manual la primera vez. Flag: afa_bat_paso_v1 (consumido al responder el paso).
  const [pasoBateria, setPasoBateria] = useState(false);
  // Contador para FORZAR re-armar el watch de GPS (watchdog/resume). Cambiarlo re-ejecuta el
  // effect de GPS: limpia (stop) y vuelve a arrancar (start). Recupera el rastreo cuando el
  // listener nativo se quedó mudo (Doze / app en 2º plano largo rato) sin tener que reiniciar.
  const [gpsNonce, setGpsNonce] = useState(0);
  // GPS DÉBIL MEDIDO: mediana de precisión de los fixes REALES recibidos (≥ACC_RED_M = ubicación
  // por red, sin satélite). Distinto de `precUbic`, que solo mira el PERMISO: un equipo puede tener
  // "Ubicación precisa" concedida (permiso OK) y aun así entregar ±100 m porque el teléfono no
  // ve satélites (guantera / parabrisas polarizado / ahorro de batería). Caso real: BVI124 dio
  // ±1.8 m el 17-jun y ±100 m desde el 19-jun con el MISMO permiso. Esto mide lo que LLEGA.
  const [gpsDebilM, setGpsDebilM] = useState(0);
  const [showFinViaje,   setShowFinViaje]   = useState(false);
  const [showFinOverlay, setShowFinOverlay] = useState(false);
  const [datosFinViaje,  setDatosFinViaje]  = useState<{
    duracion: string; paradasTotales: number; embarcados: number; envios: number; origen: string; destino: string;
  } | null>(null);

  // ── Incidencia ─────────────────────────────────────────────────────────────
  const [showIncidencia, setShowIncidencia] = useState(false);
  const [incTipo,        setIncTipo]        = useState<IncidenciaTipo | null>(null);
  const [incSev,         setIncSev]         = useState<Severidad>("medio");
  const [incDesc,        setIncDesc]        = useState("");
  const [incRetraso,     setIncRetraso]     = useState("");
  const [incSaving,      setIncSaving]      = useState(false);

  // ─── Inicializar ────────────────────────────────────────────────────────────

  useEffect(() => {
    const saved = loadSession();
    if (saved) { setConductor(saved); cargarDatos(saved.id, saved._tabla); }
    setIniting(false);
    // Service Worker: cachea el shell para arranques instantáneos y resistencia a red.
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    return () => cleanup();
  }, []);

  // ─── Notificaciones push del conductor ──────────────────────────────────────
  // La identidad va SIEMPRE en el token firmado; el servidor ignora cualquier `cid`
  // del body (ver lib/conductor-auth.ts). Sin token (sesión vieja) no se suscribe:
  // el conductor la obtiene al volver a iniciar sesión.
  const pushApi = useCallback(
    (accion: string, params: Record<string, any> = {}) =>
      condApi(accion, { ...params, token: conductor?._token }),
    [conductor?._token],
  );
  const [pushEstado, setPushEstado] = useState<"desconocido" | "activo" | "inactivo" | "bloqueado">("desconocido");

  useEffect(() => {
    if (!conductor?._token) return;
    if (typeof Notification === "undefined") { setPushEstado("inactivo"); return; }
    if (permisoBloqueado()) { setPushEstado("bloqueado"); return; }
    if (Notification.permission === "granted") {
      // Ya autorizó antes: re-sincroniza por si el token/endpoint rotó.
      resincronizarSuscripcion(pushApi).then((ok) => setPushEstado(ok ? "activo" : "inactivo")).catch(() => {});
    } else {
      setPushEstado("inactivo");
    }
  }, [conductor?._token, pushApi]);

  async function activarNotificaciones() {
    const soporte = detectarSoportePush();
    if (soporte === "no-soportado" || soporte === "ios-instalar" || soporte === "app-desactualizada") {
      setPushEstado("inactivo");
      return;
    }
    const r = soporte === "fcm" ? await activarPushNativo(pushApi) : await activarPushWeb(pushApi);
    setPushEstado(r === "activo" ? "activo" : r === "denegado" ? "bloqueado" : "inactivo");
  }

  function cleanup() {
    if (watchIdRef.current) { watchIdRef.current.clear(); watchIdRef.current = null; }
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (sosTimer.current) clearTimeout(sosTimer.current);
    if (sosInterval.current) clearInterval(sosInterval.current);
  }

  // ─── Login ──────────────────────────────────────────────────────────────────

  // El PIN se valida EN EL SERVIDOR. Antes esta función leía `pin_acceso` con la clave
  // anon y lo comparaba en el navegador — el PIN de todos los conductores quedaba al
  // alcance de cualquiera que abriera las herramientas de desarrollo. El servidor
  // devuelve un token firmado que es la credencial de sesión; el PIN nunca vuelve.
  async function login() {
    if (dni.length < 7) { setLoginErr("Ingresa tu DNI"); return; }
    if (pin.length < 4) { setLoginErr("PIN de 4 dígitos"); return; }
    setLoginErr(""); setLoginLoading(true);
    try {
      const r = await condApi("login", { dni: dni.trim(), pin });
      if (!r?.ok) {
        setLoginErr(r?.error || "No se pudo iniciar sesión");
        setLoginLoading(false);
        return;
      }
      const c: Conductor = {
        ...r.conductor,
        pin_acceso: null,          // nunca se guarda el PIN en el dispositivo
        activo_app: true,
        _tabla: r.conductor.tabla,
        _token: r.token,
      };
      saveSession(c);
      setConductor(c);
      await cargarDatos(c.id, c._tabla);
    } catch (e: any) {
      setLoginErr(e?.message || "Error de conexión");
    } finally {
      setLoginLoading(false);
    }
  }

  // ─── Cargar datos ───────────────────────────────────────────────────────────

  const cargarDatos = useCallback(async (cid: number, tabla?: string) => {
    const hoy = getFechaLocal();
    setDebugFecha(hoy);

    // Aplica un bundle "inicio" al estado y devuelve las reservas.
    const aplicarInicio = (d: any): Reserva[] => {
      const r: Reserva[] = d.reservas || [];
      const vIds  = new Set(r.map(x => x.vehiculo_id).filter(Boolean));
      const vtIds = new Set(r.map(x => (x as any).vehiculo_tercero_id).filter(Boolean));
      const propios  = ((d.vehiculos        || []) as Vehiculo[]).filter(v => vIds.has(v.id)).map(v => ({ ...v, _flota: "propia" as const }));
      const terceros = ((d.vehiculosTercero || []) as Vehiculo[]).filter(v => vtIds.has(v.id)).map(v => ({ ...v, _flota: "tercero" as const }));
      setVehiculos([...propios, ...terceros]);
      setReservasHoy(r);
      const unicos = [...new Set([...vIds, ...vtIds])];
      if (unicos.length === 1) setVehiculoId(unicos[0] as number);
      setDocs(d.docs || []);
      if (d.checklistHecho) setCheckDone(true);
      if (d.checkoutHecho) setCheckoutHecho(true);
      return r;
    };

    // ── Restaurar servicio activo si la sesión fue interrumpida ───────────
    // `confiable` = la lista viene del SERVIDOR. Si viene de la caché (porque no hubo red),
    // NO se borra la sesión cuando la reserva no aparece: un bache de señal no es prueba de
    // que el servicio ya no exista, y borrarla dejaba al conductor sin rastreo el resto del
    // viaje.
    const restaurarServicio = async (lista: any[], confiable: boolean) => {
      const srv = loadServicio();
      if (!srv) return;
      const reserva = lista.find(r => r.id === srv.reservaId);
      if (!reserva) { if (confiable) clearServicio(); return; }
      setVehiculoId(srv.vehiculoId);
      setReservaActiva(reserva);
      setInicioViaje(new Date(srv.inicioViaje));
      setParadaIdx(srv.paradaIdx);
      setEnRuta(true);
      setRestaurandoServicio(true);   // dispara el effect de GPS
      setTab("paradas");
      // Las paradas van DESPUÉS de reactivar el rastreo y con red de seguridad: cargarParadas()
      // hace fetch sin protección, así que sin señal lanza — y antes eso abortaba la
      // restauración entera dejando el GPS apagado, justo en el caso que hay que cubrir.
      // Se recargarán solas en cuanto vuelva la conexión; lo que no puede faltar es el rastreo.
      try { await cargarParadas(reserva.id); } catch { /* sin red: el rastreo ya está activo */ }
    };

    // 1) Stale-while-revalidate: mostrar la caché de HOY al instante (Uber-style).
    const cacheKey = `afa_cond_inicio_${cid}`;
    let teniaCache = false;
    let resCache: any[] | null = null;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const c = JSON.parse(raw);
        if (c?.hoy === hoy && c?.data) { resCache = aplicarInicio(c.data); teniaCache = true; }
      }
    } catch {}
    setCargando(!teniaCache); // con caché no mostramos spinner

    // 2) Refrescar desde el servidor en segundo plano.
    let data: any;
    try {
      data = await condApi("inicio", { cid, tabla: tabla ?? "conductores", hoy });
      setDebugInfo("");
      try { localStorage.setItem(cacheKey, JSON.stringify({ hoy, data })); } catch {}
    } catch (e: any) {
      setCargando(false);
      if (!teniaCache) setDebugInfo(`Error al cargar servicios: ${e?.message ?? "desconocido"}`);
      // Sin red PERO con caché: hay que reanudar el rastreo igual. Antes se salía aquí y el
      // conductor veía su servicio en pantalla mientras el GPS seguía apagado, sin reintento.
      else if (resCache) await restaurarServicio(resCache, false);
      return;
    }

    const res = aplicarInicio(data);
    setCargando(false);
    await restaurarServicio(res, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function cargarOtraFecha(fecha: string) {
    if (!conductor) return;
    setCargandoOtraFecha(true);
    try {
      const data = await condApi("inicio", { cid: conductor.id, tabla: conductor._tabla ?? "conductores", hoy: fecha });
      setReservasOtraFecha(data.reservas || []);
    } catch {
      setReservasOtraFecha([]);
    }
    setCargandoOtraFecha(false);
  }

  // ── CHAT: responder a un pasajero de MI servicio ────────────────────────────
  async function responderPax(pasajeroId: number, texto: string) {
    const t = texto.trim();
    const rid = reservaActiva?.id;
    if (!t || !rid || !conductor || chatEnviando) return;
    setChatEnviando(true);
    try {
      const { mensaje } = await condApi("responder_mensaje", {
        cid: conductor.id, tabla: conductor._tabla ?? "conductores",
        reservaId: rid, pasajero_id: pasajeroId, texto: t,
      });
      if (mensaje) setChatMsgs(prev => [...prev, mensaje]);
      setChatBorrador("");
    } catch {} finally { setChatEnviando(false); }
  }

  // Poll del hilo del servicio activo (rápido si el chat está abierto; lento si no → badge).
  useEffect(() => {
    const rid = reservaActiva?.id;
    if (!rid) { setChatMsgs([]); return; }
    let vivo = true;
    const tick = async () => {
      try {
        const { mensajes } = await condApi("mensajes_servicio", { reservaId: rid });
        if (vivo && Array.isArray(mensajes)) setChatMsgs(mensajes);
      } catch {}
    };
    void tick();
    const id = setInterval(tick, chatOpen ? 12000 : 30000);
    return () => { vivo = false; clearInterval(id); };
  }, [reservaActiva?.id, chatOpen]);

  // Auto-scroll al fondo del hilo abierto.
  useEffect(() => {
    if (chatOpen && chatPaxSel != null) chatFinRef.current?.scrollIntoView({ behavior: "auto" });
  }, [chatMsgs.length, chatPaxSel, chatOpen]);

  function cambiarFecha(delta: number) {
    const d = new Date(fechaVista + "T12:00:00");
    d.setDate(d.getDate() + delta);
    const nueva = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const hoy = getFechaLocal();
    setFechaVista(nueva);
    if (nueva === hoy) {
      setReservasOtraFecha(null);
    } else {
      cargarOtraFecha(nueva);
    }
  }

  function irAHoy() {
    setFechaVista(getFechaLocal());
    setReservasOtraFecha(null);
  }

  /**
   * Deja la ubicación lista para rastrear de verdad. Son DOS puertas independientes:
   *   1. El PERMISO de la app: "Preciso" vs "Aproximado" (Android 12+).
   *   2. Los AJUSTES DEL SISTEMA: interruptor de Ubicación encendido y NO en modo "Ahorro de
   *      batería" — en ahorro el teléfono resuelve por antena (±50-1350 m) por mucho que el
   *      permiso sea perfecto y el código pida alta calidad. Esa puerta era invisible hasta
   *      ahora y es la que explica los conductores que salen "por antena" en /gps-salud.
   * El diálogo de la puerta 2 es nativo de Google y se resuelve con un toque, sin sacar al
   * conductor de la app; solo si no se puede mostrar caemos a la pantalla de Ajustes.
   */
  async function asegurarUbicacionOptima(): Promise<{ ok: boolean; precision: GeoPrecision; pendiente: boolean }> {
    const precision = await pedirPrecisionAlta();
    setPrecUbic(precision);
    if (precision !== "precisa") return { ok: false, precision, pendiente: false };
    // Permiso correcto: ahora el sistema.
    const est = await ajustesUbicacion();
    // Sin Play Services (o APK viejo sin el método) NO se bloquea al conductor: se le deja
    // arrancar igual, que es como funcionaba antes de existir esta puerta.
    if (!est.disponible || est.satisfecho) return { ok: true, precision, pendiente: false };
    const r = await pedirAjustesUbicacion();
    if (r.satisfecho) return { ok: true, precision, pendiente: false };
    // `pendiente` = el diálogo de Google está EN PANTALLA ahora mismo. Su resultado no vuelve
    // por aquí (se lanza con startResolutionForResult y no se espera), así que el caller NO
    // debe abrir la pantalla de Ajustes: la apilaría encima y lo cancelaría, dejando al
    // conductor en "Información de la app", donde ni siquiera se puede cambiar el modo de
    // ubicación. Lo que resuelve el caso es el re-chequeo al volver a primer plano (abajo).
    return { ok: false, precision, pendiente: r.mostrado };
  }

  async function cargarParadas(reservaId: number) {
    // Usa el API endpoint que auto-crea paradas desde origen/destino si no existen
    const res = await fetch(`/api/conductor-paradas?reservaId=${reservaId}`, { headers: { "x-afa-key": AFA_KEY } });
    const json = await res.json();
    if (!res.ok) {
      alert(`No se pudieron cargar las paradas: ${json.error ?? "Error desconocido"}`);
      return;
    }
    const listaParadas: Parada[] = json.paradas || [];
    setParadas(listaParadas);
    if (listaParadas.length > 0) {
      try {
        const { pasajeros: pp } = await condApi("pasajeros", { paradaIds: listaParadas.map((p: Parada) => p.id) });
        setPasajeros(pp || []);
      } catch (e: any) {
        console.error("[Pasajeros parada]", e?.message);
      }
    }
  }

  // ─── Restaurar servicio desde localStorage ──────────────────────────────────
  // Al restaurar se setea enRuta=true (arriba), así que el effect de GPS arranca solo.
  useEffect(() => {
    if (!restaurandoServicio) return;
    setRestaurandoServicio(false);
  }, [restaurandoServicio]);

  // ─── GPS + TRACKING ──────────────────────────────────────────────────────────

  // Drena la cola de puntos GPS hacia el backend en lotes. Guard SÍNCRONO (useRef)
  // para evitar carreras si online/visibilitychange/fix disparan a la vez.
  const drenarCola = useCallback(async () => {
    if (drenandoRef.current) return;
    drenandoRef.current = true;
    try {
      while (true) {
        const cola = leerCola();
        if (cola.length === 0) break;
        const lote = cola.slice(0, 50);
        const payload = lote.map(({ _qid, ...rest }) => rest);
        await condApi("ubicacion", { payload });
        const enviados = new Set(lote.map(p => p._qid));
        const restante = leerCola().filter(p => !enviados.has(p._qid)); // la cola pudo crecer
        guardarCola(restante);
        setTotalEnvios(p => p + lote.length);
        setUltimoEnvio(new Date());
        setEnvioError(null);
        setPendientes(restante.length);
        intentosRef.current = 0;
      }
    } catch (e: any) {
      setEnvioError(e?.message || "Sin conexión");
      setPendientes(leerCola().length);
      const delay = Math.min(30000, 1000 * 2 ** intentosRef.current);
      intentosRef.current = Math.min(intentosRef.current + 1, 6);
      if (reintentoRef.current) clearTimeout(reintentoRef.current);
      reintentoRef.current = setTimeout(() => { drenarColaRef.current(); }, delay);
    } finally {
      drenandoRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  drenarColaRef.current = drenarCola;

  // Construye el punto, lo ENCOLA (sobrevive a un cierre del proceso) y dispara el
  // drenado. Usa refs → sin closures obsoletos. El payload se resuelve AQUÍ, así el
  // tramo final conserva reserva/vehículo aunque finalizar ya haya limpiado las refs.
  const enviarUbicacion = useCallback((pos: GeoPos, estado = "") => {
    const vid  = vehiculoIdRef.current;
    const cond = conductorRef.current;
    const res  = reservaActivaRef.current;
    if (!cond) return;                        // sólo necesitamos el conductor
    const vel = pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0;
    setVelocidad(vel);
    const ahora = Date.now();
    // Cierre de servicio o SOS → enviar SIEMPRE (no se throttlea).
    const forzar = estado === "finalizado" || estado === "sos";
    if (!forzar) {
      // NO bloquear el rastreo en vivo por imprecisión: en aparatos sin chip GPS
      // (tablet WiFi-only, FUSED por red) los fixes son >80 m; el suavizado/confianza
      // ya vive en la LECTURA (ModalGps.tsx). Aquí solo cortamos basura de torre celular.
      if (pos.coords.accuracy > 1500) return;
      // Velocidad EFECTIVA para la CADENCIA (no para el payload): los equipos sin Doppler
      // reportan speed=0 SIEMPRE → el throttle creía "detenido" (25 s) con el bus EN MARCHA →
      // puntos a ~100-130 m y huella en zigzag imposible de suavizar (#871, BVI124). Se deriva
      // del desplazamiento sobre la ventana más larga disponible (≥8 s, ring de ≤60 s), restando
      // el piso de ruido (2× la precisión, como velocidadPorVentana): un bus PARADO con jitter
      // de ±30 m NO se clasifica en marcha (no sube el gasto de batería/datos detenido). Se usa
      // MAX(device, derivada) solo en intervaloEnvioMs; el campo `velocidad` guardado no cambia.
      const ring = fixesVelRef.current;
      // Submuestrear a ≥4 s por entrada: la vía web emite ~1 fix/s + backstop 4 s; sin esto las
      // 12 entradas cubrían solo ~9 s y el piso de ruido tapaba la marcha lenta (o con watch
      // >1.4 Hz la ventana nunca llegaba a 8 s y la derivada quedaba apagada). Con ≥4 s por
      // entrada, 12 entradas = ventana de 44-60 s → 10 km/h con ±45 m sí se detecta.
      const lastR = ring[ring.length - 1];
      if (!lastR || ahora - lastR.ts >= 4000) ring.push({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy || 25, ts: ahora });
      while (ring.length > 12 || (ring.length && ahora - ring[0].ts > 60_000)) ring.shift();
      let velCad = vel;
      if (ring.length >= 2) {
        const viejo = ring[0];
        const dtV = (ahora - viejo.ts) / 1000;
        if (dtV >= 8) {
          const disp = distanciaMetros(pos, { coords: { latitude: viejo.lat, longitude: viejo.lng, accuracy: 0 } });
          const ruido = Math.min(150, ((pos.coords.accuracy || 25) + viejo.acc));
          if (disp > ruido) {
            const kmhD = Math.round((disp / dtV) * 3.6);
            if (kmhD <= 130) velCad = Math.max(velCad, kmhD);
          }
        }
      }
      // Throttle ADAPTATIVO: el intervalo objetivo depende de la marcha (ver
      // intervaloEnvioMs). Además, si el móvil saltó > 60 m desde el último envío,
      // refrescar YA aunque no toque el tiempo. Piso anti-spam de 2.5 s (protege el API).
      const objetivo = intervaloEnvioMs(velCad, cercaDeAlgunParadero(pos, paradasRef.current), false);
      const dt = ahora - lastSentRef.current;
      const distMov = lastSentPosRef.current ? distanciaMetros(pos, lastSentPosRef.current) : Infinity;
      if (dt < 2500) return;                      // nunca más de ~1 envío cada 2.5 s
      if (dt < objetivo && distMov < 40) return;  // ni antes del objetivo salvo salto > 40 m (antes 60 → más puntos en marcha lenta)
    }
    lastSentRef.current = ahora;
    lastSentPosRef.current = pos;
    // "en_ruta" sólo si hay SERVICIO activo (res); conectado-libre → "disponible".
    const estadoFinal = estado || (res ? "en_ruta" : "disponible");
    // Rutear por TABLA (no por id: los ids de AFA y tercero se solapan). El tercero
    // va en columnas _tercero; deja vehiculo_id/conductor_id en null, y viceversa.
    const esTercero = cond._tabla === "conductores_tercero";
    encolar({
      _qid:                 nuevoQid(),
      vehiculo_id:          esTercero ? null : (vid || null),  // null hasta que seleccione vehículo
      vehiculo_tercero_id:  esTercero ? (vid || null) : null,
      conductor_id:         esTercero ? null : cond.id,
      conductor_tercero_id: esTercero ? cond.id : null,
      reserva_id:           res?.id || null,
      lat:          pos.coords.latitude,
      lng:          pos.coords.longitude,
      velocidad:    vel,
      rumbo:        pos.coords.heading || 0,
      precision_m:  pos.coords.accuracy,
      // GPS falso: lo entrega el plugin de fondo (isFromMockProvider). undefined = "no se
      // sabe" (primer plano no lo expone) y se guarda como null, NO como false: afirmar que
      // un punto es legítimo sin haberlo comprobado sería peor que no decir nada.
      simulado:     typeof pos.simulated === "boolean" ? pos.simulated : null,
      estado:       estadoFinal,
      created_at:   new Date().toISOString(),
      // Hora del ÚLTIMO fix REAL: timestamp del PROVEEDOR (registrarFix), que solo avanza
      // cuando el CONTENIDO del fix avanza. Cubre los dos modos de congelado: el backstop que
      // re-envía el mismo punto Y el proveedor atascado que re-entrega el mismo fix cacheado
      // (antes ese caso avanzaba fix_ts — hora de recepción — y el ERP quedaba ciego). Un bus
      // parado con GPS vivo sí produce fixes frescos (timestamp avanza) → no es falso positivo.
      // Fallback a ultimoFixRef para fixes sin timestamp. Ver supabase/ubicaciones-gps-fix-ts.sql.
      fix_ts:       fixRealTsRef.current ? new Date(fixRealTsRef.current).toISOString()
                  : ultimoFixRef.current ? new Date(ultimoFixRef.current).toISOString() : null,
    });
    setPendientes(leerCola().length);
    drenarColaRef.current();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Registra la LLEGADA de un fix y evalúa si su CONTENIDO avanzó. DOS variantes de atasco
  // (ambas vistas en campo, ambas se destraban apagando/encendiendo Ubicación o reiniciando):
  //   1) Motorola/Doze: re-entrega el MISMO fix cacheado con el MISMO pos.timestamp → lo caza
  //      el eje de TIMESTAMP (ultimoAvanceRef).
  //   2) #951 (CNQ396, 4-jul): el motor colgado sirve la MISMA posición con timestamps FRESCOS
  //      — 151 fixes byte-idénticos, ±100, 75 min, con el bus EN MOVIMIENTO (copiloto a bordo).
  //      El timestamp avanza ⇒ el eje 1 es CIEGO. Se caza por POSICIÓN (ultimoCambioPosRef).
  // CLAVE: el banner/re-arms se limpian SOLO cuando la POSICIÓN cambia (un GPS sano SIEMPRE
  // jitterea, incluso parado); antes se limpiaban con cada timestamp fresco → la variante 2
  // reseteaba su propia alerta en cada callback y nunca podía aparecer.
  const registrarFix = useCallback((pos: GeoPos) => {
    ultimoFixRef.current = Date.now();
    const a = pos.coords.accuracy;
    if (Number.isFinite(a)) { accsRecRef.current.push(a); if (accsRecRef.current.length > 20) accsRecRef.current.shift(); }
    const t = pos.timestamp ?? null;
    const prev = fixPrevRef.current;
    const cambioPos = !prev || pos.coords.latitude !== prev.lat || pos.coords.longitude !== prev.lng;
    const avanzo = !prev
      || (t != null && prev.t != null && t > prev.t)
      || (t != null && prev.t == null)
      || (t == null && cambioPos);
    if (avanzo) {
      fixPrevRef.current = { t, lat: pos.coords.latitude, lng: pos.coords.longitude };
      ultimoAvanceRef.current = Date.now();
      fixRealTsRef.current = t ?? Date.now();
    }
    if (cambioPos) {
      ultimoCambioPosRef.current = Date.now();
      reArmsCongeladoRef.current = 0;
      setGpsAtascado(false);
    }
  }, []);

  // Enciende el banner in-app y la notificación NATIVA del SO para un nudge de llegada.
  const dispararNudge = useCallback((pa: Parada, tipo: "suave" | "fuerte", horaLlegada: number | null) => {
    setNudgeLlegada({ paradaId: pa.id, nombre: pa.nombre, tipo, horaLlegada });
    const titulo = tipo === "fuerte" ? "¿Llegaste a tu paradero?" : `Estás en ${pa.nombre}`;
    const cuerpo = tipo === "fuerte"
      ? `Ya te alejaste de ${pa.nombre} sin marcar la llegada. Toca para registrarla.`
      : `Marca tu llegada a ${pa.nombre} cuando termines de embarcar.`;
    notificarLlegadaNativa(tipo, titulo, cuerpo).catch(() => {});
  }, []);

  // ─── GEOFENCE DE AUTO-LLEGADA (nudge) ──────────────────────────────────────────
  // Corre por CADA fix (también en background). NO marca la parada: solo dispara los
  // avisos SUAVE (presencia sostenida en el paradero) y FUERTE (se alejó sin marcar)
  // para la PARADA ACTUAL. Por distancias, no velocidad → robusto en equipos sin Doppler.
  const evaluarGeofence = useCallback((pos: GeoPos) => {
    if (!reservaActivaRef.current) return;                       // solo en servicio activo
    const paradas = paradasRef.current;
    const pa = paradas[paradaIdxRef.current];
    if (!pa || pa.lat == null || pa.lng == null) return;         // sin coords → no se evalúa
    if (geoRef.current.paradaId !== pa.id) {                     // cambió la parada objetivo → reiniciar
      geoRef.current = { paradaId: pa.id, entroTs: null, presenteDesde: null, avisoSuave: false, avisoFuerte: false, marcada: false };
    }
    const g = geoRef.current;
    if (g.marcada) return;                                       // ya marcada → sin más avisos
    const acc = pos.coords.accuracy;
    if (!Number.isFinite(acc) || acc > GEO_ACC_MAX) return;      // GPS malo → no arriesgar un falso positivo
    const dist = distanciaMetros(pos, { coords: { latitude: pa.lat, longitude: pa.lng, accuracy: 0 } });
    const ahora = Date.now();
    if (dist <= GEO_RADIO_ENTRADA) {
      if (g.entroTs == null) {
        g.entroTs = ahora;                                       // 1ª entrada = HORA REAL de llegada
        // Fallback push "ya llegó" al pasajero: el geofence local tripó → avisa al server
        // (cubre el hueco de heartbeat GPS caído). One-shot por parada (guardado por entroTs);
        // el dedupe insert-once del server evita duplicar con la proximidad. Best-effort.
        condApi("llegada_geofence", { paradaId: pa.id }).catch(() => {});
      }
      if (g.presenteDesde == null) g.presenteDesde = ahora;
      if (!g.avisoSuave && ahora - g.presenteDesde >= GEO_DWELL_MS) {
        g.avisoSuave = true;
        dispararNudge(pa, "suave", g.entroTs);
      }
    } else {
      g.presenteDesde = null;                                    // salió del radio interno → reinicia presencia
      // Ya había entrado y ahora cruzó el radio de salida alejándose → aviso fuerte (one-shot).
      if (g.entroTs != null && dist >= GEO_RADIO_SALIDA && !g.avisoFuerte) {
        g.avisoFuerte = true;
        dispararNudge(pa, "fuerte", g.entroTs);
      }
    }
  }, [dispararNudge]);

  // Paradero donde REGISTRAR el embarque: el más cercano por GPS (realidad física del
  // bus), no el puntero manual (que el nudge/marcado pudo adelantar). Cae al puntero si
  // el GPS no es confiable, el bus no está en ningún paradero, o hay empate entre dos.
  function paraderoParaEmbarque(): Parada {
    const puntero = paradas[paradaIdx];
    const pos = posRef.current;
    if (!pos) return puntero;
    const acc = pos.coords.accuracy;
    if (!Number.isFinite(acc) || acc > GEO_ACC_MAX) return puntero;
    const cerca = paraderoCercano(pos, paradas);
    if (!cerca) return puntero;
    if (cerca.dist > GEO_RADIO_EMBARQUE) return puntero;                                   // no está en ningún paradero
    if (Number.isFinite(cerca.segundo) && cerca.segundo - cerca.dist < GEO_MARGEN_EMBARQUE) return puntero; // empate → puntero
    return paradas.find(p => p.id === cerca.id) ?? puntero;
  }

  // ─── GPS: activo SÓLO mientras el conductor esté CONECTADO o EN SERVICIO ───────
  // (no por el login). Al desconectar/finalizar, el cleanup detiene el servicio nativo
  // (BackgroundGeolocation.stop() → quita notificación y deja de acceder a la ubicación).
  useEffect(() => {
    if (!conductor || !gpsHabilitado || !compartiendo) return;
    if (!geoDisponible()) { setGpsError("GPS no disponible en este dispositivo"); return; }
    let cancelado = false;
    let recibioPos = false;
    ultimoFixRef.current = Date.now(); // periodo de gracia: el watch recién armado no se juzga "viejo"
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    // Limpiar instancias previas por si acaso
    if (watchIdRef.current) { watchIdRef.current.clear(); watchIdRef.current = null; }
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }

    if (esAppNativa()) {
      // App nativa: rastreo en SEGUNDO PLANO (sigue con Waze encima o pantalla
      // bloqueada). Si el plugin no está en este build, cae a primer plano solo.
      observarUbicacionBackground(
        (pos) => { recibioPos = true; registrarFix(pos); posRef.current = pos; setPosActual(pos); setGpsError(null); enviarUbicacion(pos); evaluarGeofence(pos); },
        (e) => { if (!recibioPos) setGpsError(e.message); },
      )
        .then((w) => { if (cancelado) w.clear(); else watchIdRef.current = w; })
        .catch(() => {});
      pedirPermisoUbicacion()
        .then((p) => { if (p === "denied" && !recibioPos) setGpsError("Permiso de ubicación denegado"); })
        .catch(() => {});
      // Red de seguridad al CONECTAR (flota existente que ya pasó el onboarding): si aún
      // falta "Permitir todo el tiempo", disparar UNA sola vez la pantalla nativa del
      // sistema (Android 11+ la abre automáticamente al pedir el permiso de fondo). Esto
      // restaura el flujo "se activaba solo al conectar". Solo APK 29+; en APK viejo el
      // chequeo devuelve null y no se hace nada (la guía manual cubre).
      (async () => {
        try {
          if (localStorage.getItem("afa_bg_loc_pedido_v1")) return;
          if ((await ubicacionTodoElTiempo()) === false) {
            if (await pedirUbicacionTodoElTiempo()) localStorage.setItem("afa_bg_loc_pedido_v1", "1");
          }
        } catch { /* noop */ }
      })();
      // Sin setInterval en nativo: el plugin entrega updates y el SO regula la
      // frecuencia; el interval no corre con el WebView suspendido en background.
    } else {
      const arrancarWatch = async (alta: boolean) => {
        if (cancelado) return;
        if (watchIdRef.current) { watchIdRef.current.clear(); watchIdRef.current = null; }
        try {
          const w = await observarUbicacion(
            (pos) => {
              recibioPos = true; registrarFix(pos);
              posRef.current = pos; setPosActual(pos); setGpsError(null);
              enviarUbicacion(pos); // el throttle adaptativo decide el ritmo real
              evaluarGeofence(pos);
            },
            (e) => { if (!recibioPos) setGpsError(e.message); },
            { enableHighAccuracy: alta, maximumAge: alta ? 5000 : 20000, timeout: alta ? 12000 : 25000 }
          );
          if (cancelado) { w.clear(); return; }
          watchIdRef.current = w;
        } catch { /* el otro proveedor o el fallback cubren */ }
      };

      (async () => {
        await arrancarWatch(true);
        // Si en 15 s no hubo fix (p.ej. sin GPS satelital), caer a ubicación por RED.
        fallbackTimer = setTimeout(() => {
          if (!recibioPos && !cancelado) arrancarWatch(false);
        }, 15000);
        pedirPermisoUbicacion()
          .then((p) => { if (p === "denied" && !recibioPos) setGpsError("Permiso de ubicación denegado"); })
          .catch(() => {});
      })();

      // Backstop por si watchPosition deja de emitir (quieto): reintenta seguido y el
      // throttle adaptativo gobierna el ritmo real (no fuerza un envío cada 15 s).
      intervalRef.current = setInterval(() => {
        if (posRef.current) enviarUbicacion(posRef.current);
      }, 4000);
    }

    // Drenar lo que haya quedado en cola de una sesión previa.
    drenarColaRef.current();
    setPendientes(leerCola().length);

    return () => {
      cancelado = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (watchIdRef.current) { watchIdRef.current.clear(); watchIdRef.current = null; }
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      if (reintentoRef.current) { clearTimeout(reintentoRef.current); reintentoRef.current = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conductor?.id, gpsHabilitado, compartiendo, gpsNonce]);

  // ── Watchdog de GPS: auto-recuperación sin reiniciar el celular ──────────────
  // Caso real reportado: tras NO usar el app ~24 h, el GPS deja de funcionar en 1er y 2º
  // plano hasta reiniciar el teléfono. Parte es batería del fabricante (MIUI/HyperOS) — eso
  // se arregla en ajustes del equipo (Autostart + batería "Sin restricciones" + ubicación
  // "Todo el tiempo"). Pero otra parte es el listener nativo que se queda MUDO tras Doze /
  // 2º plano largo y no se vuelve a registrar solo. Aquí: si estamos compartiendo y el último
  // fix quedó viejo, forzamos re-armar el watch (stop→start) — al volver a 1er plano y, como
  // respaldo, cada 30 s mientras la pantalla está visible. Re-armar es barato y sólo dispara
  // cuando el GPS YA está roto (en marcha llegan fixes cada ~2 s → nunca se vuelve viejo).
  useEffect(() => {
    if (!conductor || !gpsHabilitado || !compartiendo) return;
    const VIEJO_PERIODICO = 60_000;  // 1 min sin fix con pantalla visible → re-armar. En marcha
                                     // y detenido llegan fixes cada ~2 s (heartbeat nativo), así que
                                     // sólo dispara con el GPS realmente roto → bajar de 120→60 s
                                     // sólo acorta la latencia de recuperación, sin falsos positivos.
    const VIEJO_RESUME    = 30_000;  // al volver a 1er plano, 30 s de antigüedad ya re-arma
    // Coalesce: visibilitychange y el tick de 30 s pueden coincidir; sin esto se encadenarían
    // dos ciclos stop/start del servicio nativo solapados. Máx 1 re-arm cada 10 s.
    const reArmar = () => {
      if (Date.now() - ultimoReArmRef.current < 10_000) return;
      ultimoReArmRef.current = Date.now();
      setGpsNonce((n) => n + 1);
    };
    const edadFix = () => Date.now() - (ultimoFixRef.current || 0);
    // Fix CONGELADO (caso Motorola): callbacks vivos (edadFix chico, así que reArmar nunca
    // dispara por silencio) pero el CONTENIDO del fix clavado >3 min — mismo umbral que el
    // detector del ERP (ModalGps). Escala: hasta 2 re-arms (stop→start re-registra el listener
    // nativo); si ni así avanza, el atasco está en el motor de ubicación del EQUIPO (GMS) y
    // re-armar en bucle es inútil → banner al conductor (apagar/encender la Ubicación).
    // Sin avance previo (ultimoAvanceRef=0) no aplica: ese es el caso silencio, ya cubierto.
    const CONGELADO_MS = 180_000;
    // Variante #951: timestamps FRESCOS pero POSICIÓN byte-idéntica — solo cuenta EN SERVICIO
    // (en ruta se espera movimiento; conectado-libre parado en cochera es normal) y con precisión
    // de RED (≥ACC_RED_M): un chip GPS sano jitterea SIEMPRE (coords nunca idénticas 8 min), así
    // que no dispara en un bus legítimamente parado con buen GPS. 8 min > embarque típico.
    // El umbral era 60 m — demasiado alto: la ubicación de red del servicio #24738 salía a 22 m y
    // esta detección quedó ciega justo en el caso que existe para cazar.
    const POS_CLAVADA_MS = 480_000;
    const chequearCongelado = () => {
      const ahora = Date.now();
      const tsClavado = ultimoAvanceRef.current > 0 && ahora - ultimoAvanceRef.current > CONGELADO_MS;
      const accs = [...accsRecRef.current].sort((x, y) => x - y);
      const accMed = accs.length >= 5 ? accs[Math.floor(accs.length / 2)] : 0;
      const posClavada = !!reservaActivaRef.current
        && ultimoCambioPosRef.current > 0
        && ahora - ultimoCambioPosRef.current > POS_CLAVADA_MS
        && accMed >= ACC_RED_M;
      if (!tsClavado && !posClavada) return;
      if (reArmsCongeladoRef.current >= 2) { setGpsAtascado(true); return; }
      reArmsCongeladoRef.current += 1;
      reArmar();
    };
    // Latido "app viva": el watchdog lo refresca mientras el proceso corre en 1er plano. Sirve
    // para detectar la MUERTE del proceso por batería (cold start con latido viejo) y distinguirla
    // de un túnel (que NO mata el proceso → el latido sigue fresco). Ver evaluarAjustesGps.
    const latir = () => { try { localStorage.setItem("afa_gps_latido", String(Date.now())); } catch {} };
    latir(); // marca vivo al armar el watchdog
    const onVis = () => {
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      if (edadFix() > VIEJO_RESUME) reArmar();
      chequearCongelado();
    };
    document.addEventListener("visibilitychange", onVis);
    const iv = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return; // en 2º plano el timer está throttleado igual
      latir(); // app viva en 1er plano
      if (edadFix() > VIEJO_PERIODICO) reArmar();
      chequearCongelado();
    }, 30_000);
    return () => { document.removeEventListener("visibilitychange", onVis); clearInterval(iv); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conductor?.id, gpsHabilitado, compartiendo]);

  // Al (re)CONECTAR: sembrar el reloj de posición-clavada y limpiar el estado del atasco de la
  // sesión anterior. SOLO en el flanco de `compartiendo` (NO en los re-arms por gpsNonce, que
  // anularía la detección durante la escalada). Evita que un banner viejo o un reloj pre-cargado
  // de la sesión previa disparen en ~60 s al reconectar parado en el mismo punto.
  useEffect(() => {
    if (!compartiendo) return;
    ultimoCambioPosRef.current = Date.now();
    reArmsCongeladoRef.current = 0;
    setGpsAtascado(false);
  }, [compartiendo]);

  // ── Detector de GPS DÉBIL medido (para el semáforo) ──────────────────────────
  // Cada 20 s, mediana de la precisión de los últimos fixes RECIBIDOS. ≥60 m sostenido =
  // ubicación por red (sin satélite): el conductor debe reubicar el teléfono con vista al
  // cielo / quitar ahorro de batería. Mide la CALIDAD REAL entregada, no el permiso.
  useEffect(() => {
    if (!conductor || !compartiendo) { setGpsDebilM(0); accsRecRef.current = []; return; }
    const evaluar = () => {
      // No acusar con datos VIEJOS: si el GPS calló (>60 s sin fix), eso ya lo cubren el
      // watchdog/gpsAtascado — el array conserva accuracies rancias que no describen el ahora.
      if (Date.now() - (ultimoFixRef.current || 0) > 60_000) { setGpsDebilM(0); return; }
      const a = [...accsRecRef.current].sort((x, y) => x - y);
      if (a.length < 5) { setGpsDebilM(0); return; }   // muestras insuficientes: no acusar
      const med = a[Math.floor(a.length / 2)];
      setGpsDebilM(med >= ACC_RED_M ? Math.round(med) : 0);
    };
    const iv = setInterval(evaluar, 20_000);
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conductor?.id, compartiendo]);

  // Drenar la cola cuando vuelve la conexión o el app vuelve a primer plano (de Waze).
  useEffect(() => {
    if (!conductor) return;
    const drenar = () => drenarColaRef.current();
    const onVis = () => { if (typeof document !== "undefined" && document.visibilityState === "visible") drenar(); };
    window.addEventListener("online", drenar);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("online", drenar);
      document.removeEventListener("visibilitychange", onVis);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conductor?.id]);

  // ESTADO EN VIVO del rastreo de fondo: mientras el conductor comparte (conectado o en ruta),
  // sondea `backgroundGpsActivo()` — true si el servicio nativo de 2º plano corre; false si cayó
  // a "solo con app abierta". Alimenta el semáforo "Rastreo protegido" (tercer eje, junto a
  // batería y precisión). Gracia inicial de 8 s (deja arrancar el servicio) + anti-parpadeo:
  // exige 2 lecturas falsas seguidas antes de marcar inactivo (un re-armado del watchdog deja
  // _bgActivo en false por 1-2 s → sin esto parpadearía). Solo aplica en la app nativa.
  useEffect(() => {
    if (!esAppNativa() || !compartiendo) { setBgServicioActivo(true); return; }
    setBgServicioActivo(true); // optimista mientras el servicio arranca
    const desde = Date.now();
    let fallosSeguidos = 0;
    // Además de `backgroundGpsActivo()` (que solo recuerda que start() resolvió), exigimos
    // PRUEBA DE VIDA: si el servicio nativo lleva SIN_FIX_MAX_MS sin entregar un fix, damos el
    // rastreo por caído aunque la bandera siga en true — es el caso que dejaba el semáforo en
    // verde con el GPS muerto. Umbral holgado a propósito: un bus detenido en un paradero
    // también deja de generar fixes y no queremos alarmar por eso.
    const SIN_FIX_MAX_MS = 5 * 60 * 1000;
    const iv = setInterval(() => {
      if (Date.now() - desde < 8000) return; // gracia: no juzgar antes de que arranque
      const sinFix = backgroundGpsSinFixMs();
      const vivo = backgroundGpsActivo() && !(sinFix !== null && sinFix > SIN_FIX_MAX_MS);
      if (vivo) { fallosSeguidos = 0; setBgServicioActivo(true); }
      else { fallosSeguidos += 1; if (fallosSeguidos >= 2) setBgServicioActivo(false); }
    }, 4000);
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compartiendo]);

  // Decide si mostrar la guía de ajustes — "detectar, no asumir":
  //  • Si el equipo YA está exento de batería → NUNCA molestar (limpia los flags).
  //  • Si NO está exento (o no se puede saber, APK viejo) → mostrar solo si: aún no la descartó,
  //    o DETECTAMOS que el SO mató la app a mitad de un viaje (reaparición).
  //
  // CLAVE — distinguir "mató la batería" de "túnel / sin señal": un túnel NO mata el proceso
  // (el latido `afa_gps_latido`, que el watchdog refresca mientras la app está viva, sigue
  // fresco). Solo un kill por batería/fabricante MATA el proceso → al reabrir hay un COLD START
  // con un servicio activo y el último latido viejo. Por eso el disparador es el cold-start con
  // latido viejo, NO la ausencia de fixes (que un túnel también produce). Cero falsos positivos
  // en ruta por pérdida de señal.
  const evaluarAjustesGps = useCallback(async () => {
    if (!esAppNativa()) return;
    const exenta = await bateriaExenta();
    setExentaBat(exenta);
    try { setPrecUbic(await precisionUbicacion()); } catch {}
    try {
      if (exenta === true) {
        localStorage.removeItem("afa_gps_corte_pendiente");
        localStorage.removeItem("afa_gps_latido");
        setCortePendiente(false);
        setMostrarAjustesGps(false);
        return;
      }
      // ¿La app murió a mitad de un servicio? Cold start + servicio activo + latido viejo.
      const srv = loadServicio();
      const latido = Number(localStorage.getItem("afa_gps_latido") || 0);
      if (srv && latido && Date.now() - latido > 240_000) {
        localStorage.setItem("afa_gps_corte_pendiente", "1");
      }
      localStorage.removeItem("afa_gps_latido"); // consumido: este cold start ya se evaluó
      // ONBOARDING (solo APK 28+, exenta === false ⇒ el plugin respondió): la PRIMERA vez que
      // sabemos que el equipo NO está exento, mostrar el paso de batería (botón → diálogo
      // NATIVO del sistema) en lugar de la guía manual. Se encadena tras el permiso de
      // ubicación en la primera instalación → se siente como un permiso más.
      if (exenta === false && !localStorage.getItem("afa_bat_paso_v1")) {
        setPasoBateria(true);
        return;
      }
      const descartado = localStorage.getItem("afa_gps_ajustes_v1") === "1";
      const corte = localStorage.getItem("afa_gps_corte_pendiente") === "1";
      setCortePendiente(corte);
      if (!descartado || corte) setMostrarAjustesGps(true);
    } catch {}
  }, []);

  // Divulgación destacada de ubicación en segundo plano (requisito de Google Play):
  // se muestra UNA vez, antes de que el plugin pida el permiso de background.
  useEffect(() => {
    if (!conductor || !esAppNativa()) return;
    try {
      if (!localStorage.getItem("afa_bg_disclosure_v1")) { setMostrarDivulgacion(true); return; }
      // Disclosure ya aceptado: evaluar si hace falta la guía (según exención real del equipo).
      evaluarAjustesGps();
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conductor?.id]);

  // Auto-cerrar la guía si el conductor vuelve a 1er plano YA exento (concedió el diálogo del
  // sistema). Solo OCULTA, nunca abre → cero riesgo de nagueo.
  useEffect(() => {
    if (!mostrarAjustesGps || !esAppNativa()) return;
    const onVis = async () => {
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      const ex = await bateriaExenta();
      setExentaBat(ex);
      try { setPrecUbic(await precisionUbicacion()); } catch {}
      if (ex === true) {
        try { localStorage.setItem("afa_gps_ajustes_v1", "1"); localStorage.removeItem("afa_gps_corte_pendiente"); } catch {}
        setCortePendiente(false);
        setMostrarAjustesGps(false);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [mostrarAjustesGps]);

  // Mantener el SEMÁFORO de la tarjeta de ajustes al día: re-leer la exención de batería al
  // volver a primer plano (p.ej. tras concederla en Ajustes) aunque la hoja esté cerrada. Es
  // SOLO LECTURA (no abre nada): solo refresca el color verde/ámbar. La lógica de mostrar o
  // auto-reaparecer la guía vive en evaluarAjustesGps, intacta → cero riesgo de nagueo.
  useEffect(() => {
    if (!conductor || !esAppNativa()) return;
    const onVis = async () => {
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      try { setExentaBat(await bateriaExenta()); } catch {}
      try { setPrecUbic(await precisionUbicacion()); } catch {}
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [conductor?.id]);

  async function iniciarRecorrido(reserva: Reserva, forzar = false) {
    if (reservaActiva) { alert("Hay un servicio en curso. Finalízalo antes de iniciar otro."); return; }
    if (!checkDone) { alert("Debes completar el check-in antes de iniciar el recorrido"); setTab("checklist"); return; }
    if (!vehiculoId) { alert("Selecciona el vehículo primero"); return; }
    // Gate FUERTE-SUAVE de precisión: si el permiso quedó en APROXIMADO, el rastreo saldría a ±150 m
    // TODA la ruta. Usamos el estado `precUbic` (refrescado al montar y en cada visibilitychange),
    // NO un await aquí: checkPermissions() puede COLGARSE en MIUI/HyperOS y dejaría el botón sin
    // responder. Bloquea solo si la última lectura fue "aproximada"; "precisa"/"desconocida" → deja
    // iniciar (fail-open). El conductor puede forzar desde el modal (gatePrecision).
    if (!forzar && precUbic === "aproximada") {
      setGatePrecision(reserva);
      return;
    }
    setIniciando(true);
    await cargarParadas(reserva.id);
    // Transición INMEDIATA a la ruta — NO esperar al GPS. El servicio AUTO-CONECTA el
    // rastreo (setConectado) y el effect de GPS arranca solo; bloquear aquí dejaba el
    // botón colgado en "Obteniendo GPS…" si el aparato no tenía señal.
    const ahora = new Date();
    setConectado(true);     // auto-desliza "Conectarse" al iniciar un servicio
    setReservaActiva(reserva);
    setEnRuta(true);
    setInicioViaje(ahora);
    setIniciando(false);
    setTab("paradas");
    // Guardar el estado del operador ANTES de pisarlo con en_curso, para poder restaurarlo
    // exacto si el conductor "Sale" del servicio (no degradar Confirmada → Programada).
    saveServicio({ reservaId: reserva.id, vehiculoId: vehiculoId!, paradaIdx: 0, inicioViaje: ahora.toISOString(), estadoPrevio: reserva.estado ?? null });
    // Marcar en_curso en DB (best-effort, no bloquea la UI).
    condApi("actualizar_estado", { reservaId: reserva.id, estado: "en_curso" }).catch(() => {});
    setReservasHoy(prev => prev.map(r => r.id === reserva.id ? { ...r, estado: "en_curso" } : r));
    // Posición inicial best-effort, en segundo plano (no bloquea la UI).
    obtenerUbicacion({ enableHighAccuracy: true, timeout: 12000 })
      .then((pos) => { posRef.current = pos; setPosActual(pos); enviarUbicacion(pos); })
      .catch((e: any) => console.warn("[iniciarRecorrido] sin GPS inicial:", e?.message));
  }

  // Confirma antes de arrancar para que el conductor no inicie el servicio equivocado.
  function confirmarEIniciar(reserva: Reserva) {
    const hora = reserva.hora_servicio?.slice(0, 5);
    const ok = window.confirm(
      `¿Iniciar este servicio?\n\n${reserva.origen} → ${reserva.destino}` +
      (hora ? `\nHora: ${hora}` : "")
    );
    if (ok) iniciarRecorrido(reserva);
  }

  // Gate de precisión abierto: si el conductor vuelve de Ajustes con la precisión ya en ALTA,
  // cerrar el gate y arrancar el servicio automáticamente (forzar=true: ya está verificado preciso).
  useEffect(() => {
    if (!gatePrecision || !esAppNativa()) return;
    const onVis = async () => {
      if (typeof document === "undefined" || document.visibilityState !== "visible") return;
      const r = await precisionUbicacion();
      setPrecUbic(r);
      if (r !== "precisa") return;
      // El permiso ya está fino; falta saber si el conductor aceptó el diálogo de ajustes del
      // sistema (su resultado no vuelve por el plugin, se comprueba aquí). Si la ROM no
      // ofrece esa comprobación, no se le bloquea el arranque.
      const est = await ajustesUbicacion();
      if (est.disponible && !est.satisfecho) return;   // sigue en ahorro de batería: no arrancar aún
      const reserva = gatePrecision;
      setGatePrecision(null);
      iniciarRecorrido(reserva, true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gatePrecision]);

  // Recuperación: el conductor inició un servicio por error o aún no está listo.
  // Lo devuelve a su lista SIN registrarlo como finalizado, RESTAURANDO el estado del
  // operador (programada/confirmada). El conductor NO decide ese estado: solo deshace su
  // propio en_curso. Tras una recarga, reservaActiva.estado ya sería "en_curso", por eso
  // el estado previo se lee del servicio guardado.
  function volverAPendientes() {
    const rId = reservaActiva?.id;
    if (!rId) return;
    const ok = window.confirm(
      "¿Salir de este servicio?\n\nVolverá a tu lista para que lo inicies cuando estés listo. NO se registra como finalizado."
    );
    if (!ok) return;
    const previo = loadServicio()?.estadoPrevio;
    const restaurado = (previo === "programada" || previo === "confirmada") ? previo : "confirmada";
    clearServicio();
    condApi("revertir_inicio", { reservaId: rId, estadoPrevio: restaurado }).catch(() => {});
    setReservasHoy(prev => prev.map(r => r.id === rId ? { ...r, estado: restaurado } : r));
    setEnRuta(false); setReservaActiva(null); setParadas([]); setPasajeros([]);
    setParadaIdx(0); setVelocidad(0); setTotalEnvios(0); setInicioViaje(null);
    setTab("ruta");
  }

  function finalizarRecorridoConfirmado() {
    const rId = reservaActiva?.id;
    if (posRef.current) enviarUbicacion(posRef.current, "finalizado");
    if (rId) {
      condApi("actualizar_estado", { reservaId: rId, estado: "finalizada" }).catch(() => {});
      setReservasHoy(prev => prev.map(r => r.id === rId ? { ...r, estado: "finalizada" } : r));
    }
    clearServicio();
    setEnRuta(false); setReservaActiva(null); setParadas([]); setPasajeros([]);
    setParadaIdx(0); setVelocidad(0); setTotalEnvios(0); setTab("ruta");
    setShowFinViaje(false);
    setInicioViaje(null);
  }

  async function marcarParadaCompletada(paradaId: number, opts?: { viaNudge?: boolean }) {
    // Hora REAL de llegada: la de ENTRADA al radio que detectó el geofence para esta
    // parada. Si no hay (sin GPS/coords), va null y el server usa now().
    const g = geoRef.current;
    const horaLlegadaMs = g.paradaId === paradaId ? g.entroTs : null;
    const horaLlegada = horaLlegadaMs ? new Date(horaLlegadaMs).toISOString() : null;
    try {
      await condApi("marcar_parada", { paradaId, horaLlegada });
    } catch (e: any) { alert(`Error al marcar parada: ${e?.message}`); return; }
    g.marcada = true;         // silenciar avisos del geofence para esta parada
    setNudgeLlegada(prev => prev?.paradaId === paradaId ? null : prev); // cerrar el banner si era de esta parada
    setParadas(prev => prev.map(p => p.id === paradaId ? { ...p, estado: "completada", hora_llegada: horaLlegada } : p));
    if (paradaIdx < paradas.length - 1) {
      const idxPrevio = paradaIdx;
      const nuevaIdx = paradaIdx + 1;
      setParadaIdx(nuevaIdx);
      saveServicio({
        reservaId:   reservaActiva!.id,
        vehiculoId:  vehiculoId!,
        paradaIdx:   nuevaIdx,
        inicioViaje: inicioViaje?.toISOString() ?? new Date().toISOString(),
      });
      // "Deshacer" SOLO cuando la marcó el nudge (el marcado manual es intencional). No en
      // la última parada, porque implicaría des-finalizar el viaje.
      if (opts?.viaNudge) {
        const nombre = paradas.find(p => p.id === paradaId)?.nombre ?? "el paradero";
        mostrarDeshacer(paradaId, nombre, idxPrevio);
      }
    } else {
      // Último paradero → finalizar de una sola acción.
      await finalizarUltimaParada();
    }
  }

  // ─── DESHACER una llegada marcada por el nudge (por si fue por error) ───────────
  function mostrarDeshacer(paradaId: number, nombre: string, idxPrevio: number) {
    if (deshacerTimerRef.current) clearTimeout(deshacerTimerRef.current);
    setDeshacerLlegada({ paradaId, nombre, idxPrevio });
    deshacerTimerRef.current = setTimeout(() => setDeshacerLlegada(null), 30000);
  }

  async function deshacerUltimaLlegada() {
    const d = deshacerLlegada;
    if (!d) return;
    setDeshacerLlegada(null);
    if (deshacerTimerRef.current) { clearTimeout(deshacerTimerRef.current); deshacerTimerRef.current = null; }
    try {
      await condApi("anular_parada", { paradaId: d.paradaId });
    } catch (e: any) { alert(`No se pudo deshacer: ${e?.message}`); return; }
    setParadas(prev => prev.map(p => p.id === d.paradaId ? { ...p, estado: "pendiente", hora_llegada: null } : p));
    setParadaIdx(d.idxPrevio);
    // Reabrir el geofence para esta parada (podrá volver a avisar/marcar).
    geoRef.current = { paradaId: null, entroTs: null, presenteDesde: null, avisoSuave: false, avisoFuerte: false, marcada: false };
    if (reservaActiva && vehiculoId != null) {
      saveServicio({
        reservaId:   reservaActiva.id,
        vehiculoId:  vehiculoId,
        paradaIdx:   d.idxPrevio,
        inicioViaje: inicioViaje?.toISOString() ?? new Date().toISOString(),
      });
    }
  }

  async function finalizarUltimaParada() {
    const rId = reservaActiva?.id;
    // Capturar estadísticas ANTES de limpiar el estado.
    const stats = {
      duracion:       inicioViaje ? fmtDuracion(Date.now() - inicioViaje.getTime()) : "—",
      paradasTotales: paradas.length,
      embarcados:     pasajeros.filter(p => esAbordado(p.estado)).length,
      envios:         totalEnvios,
      origen:         reservaActiva?.origen || "",
      destino:        reservaActiva?.destino || "",
    };
    if (posRef.current) enviarUbicacion(posRef.current, "finalizado");
    if (rId) {
      try { await condApi("actualizar_estado", { reservaId: rId, estado: "finalizada" }); }
      catch (e: any) { console.error("[finalizar] Error al actualizar estado:", e?.message); }
      setReservasHoy(prev => prev.map(r => r.id === rId ? { ...r, estado: "finalizada" } : r));
    }
    clearServicio();
    setDatosFinViaje(stats);
    setShowFinOverlay(true);
    setEnRuta(false); setReservaActiva(null); setParadas([]); setPasajeros([]);
    setParadaIdx(0); setVelocidad(0); setTotalEnvios(0); setTab("ruta");
    setInicioViaje(null);
    setTimeout(() => { setShowFinOverlay(false); setDatosFinViaje(null); }, 5000);
  }

  // ─── SOS ─────────────────────────────────────────────────────────────────────

  function iniciarSOS() {
    if (sosEnviado) return;
    setSosActivo(true); setSosPct(0);
    let elapsed = 0;
    sosInterval.current = setInterval(() => {
      elapsed += 50;
      setSosPct(Math.min(100, (elapsed / 2000) * 100));
    }, 50);
    sosTimer.current = setTimeout(async () => {
      clearInterval(sosInterval.current!);
      setSosActivo(false); setSosPct(100);
      if (!conductor || !posRef.current) {
        alert("Error: GPS no disponible. SOS no pudo enviarse. Llama al +51 966 707 225.");
        setSosActivo(false); setSosPct(0);
        return;
      }
      const sosRes = await fetch("/api/conductor-alerta", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-afa-key": AFA_KEY },
        body: JSON.stringify({
          reserva_id: reservaActiva?.id ?? null,
          lat:        posRef.current.coords.latitude,
          lng:        posRef.current.coords.longitude,
          motivo:     `SOS — ${conductor.nombre} solicita ayuda urgente`,
          estado:     "pendiente",
        }),
      });
      if (!sosRes.ok) {
        const j = await sosRes.json().catch(() => ({}));
        alert(`SOS no pudo registrarse: ${j.error ?? "error desconocido"}. Llama al +51 966 707 225.`);
        setSosPct(0);
        return;
      }
      await enviarUbicacion(posRef.current, "sos");
      setSosEnviado(true);
      setTimeout(() => { setSosEnviado(false); setSosPct(0); }, 10000);
    }, 2000);
  }

  function cancelarSOS() {
    if (sosTimer.current) clearTimeout(sosTimer.current);
    if (sosInterval.current) clearInterval(sosInterval.current);
    setSosActivo(false); setSosPct(0);
  }

  // ─── QR SCANNER ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!escanear) {
      if (qrRef.current) { qrRef.current.stop().catch(() => {}); qrRef.current = null; }
      return;
    }
    let stopped = false;
    import("html5-qrcode").then(async ({ Html5Qrcode }) => {
      if (stopped) return;
      // En la app nativa, pedir el permiso de CÁMARA con el plugin nativo ANTES de
      // getUserMedia. Sin esto, html5-qrcode falla con "No se pudo acceder a la cámara".
      try {
        const { Capacitor } = await import("@capacitor/core");
        if (Capacitor.isNativePlatform()) {
          const { Camera } = await import("@capacitor/camera");
          const estado = await Camera.checkPermissions();
          if (estado.camera !== "granted") {
            const req = await Camera.requestPermissions({ permissions: ["camera"] });
            if (req.camera !== "granted") {
              setEscanear(false);
              alert("Concede el permiso de Cámara para escanear el QR. Ajustes → AFA Conductor → Permisos → Cámara.");
              return;
            }
          }
        }
      } catch (e) { console.warn("[QR] permiso cámara:", e); }
      if (stopped) return;
      const container = document.getElementById("qr-container");
      if (!container) return;
      const scanner = new Html5Qrcode("qr-container");
      qrRef.current = scanner;
      scanner.start(
        { facingMode: "environment" },
        // fps 12 → 6: html5-qrcode decodifica cada cuadro en el MISMO hilo JS que recibe los fixes
        // del plugin nativo y drena la cola de GPS. A 12 fps ese hilo queda saturado mientras la
        // cámara está abierta (servicio #24738: dos huecos de ~2 min caen justo entre escaneos).
        // 6 fps sigue siendo el doble de rápido que un escaneo humano y libera la mitad del hilo.
        { fps: 6 },   // sin qrbox → detecta en toda la pantalla
        async (text: string) => {
          scanner.stop().catch(() => {}); qrRef.current = null; setEscanear(false);
          await procesarQR(text);
        },
        () => {}
      ).catch((err: any) => {
        console.error("[QR] Error al iniciar scanner:", err);
        setEscanear(false);
        alert("No se pudo acceder a la cámara. Verifica los permisos.");
      });
    }).catch((err: any) => {
      console.error("[QR] Error al cargar html5-qrcode:", err);
      alert("El módulo QR no está disponible. Ejecuta: npm install html5-qrcode");
    });
    return () => {
      stopped = true;
      if (qrRef.current) { qrRef.current.stop().catch(() => {}); qrRef.current = null; }
    };
  }, [escanear]);

  // ─── ESCÁNER BLUETOOTH HID ──────────────────────────────────────────────────
  // El pistol RED-L8BLS (y cualquier escáner BT en modo HID) emula teclado. La lógica de
  // detección/anti-rebote vive en lib/hid-scanner; aquí solo lo enganchamos y disparamos
  // el embarque. Solo activo en la pestaña "Ruta" (paradas) y NO mientras la cámara está
  // abierta — así un disparo accidental en perfil/docs no registra abordajes fantasma, y
  // cámara y BT no compiten. El candado procesandoQRRef (dentro de procesarQR) evita el
  // doble embarque si ambos métodos detectan a la vez.
  useEffect(() => {
    if (!reservaActiva || tab !== "paradas" || escanear) return;
    return attachHidScanner({
      onScan: (code) => {
        setBtScanFlash(true);
        setTimeout(() => setBtScanFlash(false), 500);
        return procesarQRRef.current(code);
      },
      isBusy: () => procesandoQRRef.current,
    });
  }, [reservaActiva?.id, tab, escanear]); // eslint-disable-line react-hooks/exhaustive-deps

  // Procesa un QR (de cámara o escáner BT) en UNA sola llamada al servidor: embarcar_qr
  // resuelve el pasajero desde el QR, registra el embarque y consolida por "horario de salida",
  // y devuelve los datos del pasajero para la UI. (Antes eran 2 viajes: buscar_pasajero +
  // embarcar_qr → la mitad del tiempo de red.) El candado procesandoQRRef lo comparten cámara y BT.
  async function procesarQR(qrCode: string) {
    if (procesandoQRRef.current) return;   // un escaneo (cámara o BT) ya en curso
    procesandoQRRef.current = true;
    setLeyendo(true);                       // feedback OPTIMISTA inmediato (antes de la red)
    try {
      const paradaActual = paradas[paradaIdx];
      if (!paradaActual) {
        playBeep("error");
        setBoardingMsg({ ok: false, msg: "Error: no hay parada activa." });
        setTimeout(() => setBoardingMsg(null), 4000);
        return;
      }
      // Atribuir el embarque al paradero REAL por GPS (no al puntero, que el nudge o el
      // marcado de llegada pudo adelantar). Cae al puntero si el GPS no es confiable.
      const paradaEmbarque = paraderoParaEmbarque();

      let resp: any;
      try {
        resp = await condApi("embarcar_qr", {
          qrCode,
          paradaId:  paradaEmbarque.id,
          reservaId: reservaActiva?.id ?? null,
        });
      } catch (e: any) {
        playBeep("error");
        setBoardingMsg({ ok: false, msg: `Error al registrar embarque: ${e?.message}` });
        setTimeout(() => setBoardingMsg(null), 4000);
        return;
      }

      if (resp?.noEncontrado || !resp?.ok) {
        playBeep("error");
        setBoardingMsg({ ok: false, msg: "QR no reconocido. Pasajero no encontrado en el sistema." });
        setTimeout(() => setBoardingMsg(null), 4000);
        return;
      }

      const pasajero: Pasajero = resp.pasajero ?? { id: 0, nombre: "Pasajero", dni: null, empresa: null, qr_code: qrCode, foto_url: null };

      // Re-escaneo: el server marca yaEmbarcado si ya estaba a bordo en este servicio.
      if (resp?.yaEmbarcado) {
        playBeep("warn");
        setBoardingMsg({ ok: false, msg: `${pasajero.nombre} ya está registrado en este servicio.` });
        setTimeout(() => setBoardingMsg(null), 4000);
        return;
      }

      // Clasificar el resultado desde la respuesta del servidor (es la autoridad).
      const creado       = !!resp?.creado;                 // no estaba asignado (caminante)
      const otroBus      = !!resp?.otroBus;                // venía de otro bus del mismo horario
      const cambioParada = !!resp?.movido && !otroBus;     // movido a otra parada del mismo bus
      const empresaAjena = !!resp?.empresaAjena;           // QR de otra empresa (red de seguridad)
      const fueraLista   = creado;
      const paradaOriginalNombre = cambioParada
        ? (paradas.find(p => p.id === resp?.paradaOriginalId)?.nombre ?? null)
        : null;

      // Estado local: dejar UNA sola fila para el pasajero, en la parada real, embarcado.
      setPasajeros(prev => {
        const sinPax = prev.filter(p => p.pasajero_id !== pasajero.id);
        return [...sinPax, {
          id:          resp?.id ?? 0,
          parada_id:   paradaEmbarque.id,
          pasajero_id: pasajero.id,
          estado:      "abordado",
          pasajero,
        }];
      });

      playBeep(empresaAjena || fueraLista || otroBus ? "warn" : "ok");

      // Mostrar tarjeta resultado con barra de progreso (3 s)
      if (resultIntervalRef.current) clearInterval(resultIntervalRef.current);
      setResultadoEmbarque({ pasajero, fueraLista, otroBus, cambioParada, empresaAjena, paradaOriginalNombre, paradaEmbarqueNombre: paradaEmbarque.nombre });
      setResultProgreso(0);
      let prog = 0;
      resultIntervalRef.current = setInterval(() => {
        prog++;
        setResultProgreso(prog);
        if (prog >= 100) {
          clearInterval(resultIntervalRef.current!);
          resultIntervalRef.current = null;
          setResultadoEmbarque(null);
          setResultProgreso(0);
        }
      }, 30); // 100 pasos × 30 ms = 3 000 ms
    } finally {
      // Soltar al terminar la ida y vuelta al server (NO al cerrarse la tarjeta de
      // resultado, que vive 3 s): así el siguiente pasajero se puede escanear enseguida.
      procesandoQRRef.current = false;
      setLeyendo(false);
    }
  }

  async function notificarRetraso() {
    if (!reservaActiva) { alert("No hay reserva activa"); return; }
    const res = await fetch("/api/conductor-alerta", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-afa-key": AFA_KEY },
      body: JSON.stringify({
        reserva_id: reservaActiva.id,
        lat:        posRef.current?.coords.latitude  ?? null,
        lng:        posRef.current?.coords.longitude ?? null,
        motivo:     `Retraso reportado — en ruta a ${paradas[paradaIdx]?.nombre || "siguiente parada"}`,
        estado:     "pendiente",
      }),
    });
    const json = await res.json();
    if (!res.ok) { alert(`Error al notificar retraso: ${json.error}`); return; }
    setNotifEnviada(true);
    setTimeout(() => setNotifEnviada(false), 5000);
  }

  // ─── INCIDENCIA ────────────────────────────────────────────────────────────

  async function enviarIncidencia() {
    if (!conductor) return;
    if (!incTipo) { alert("Selecciona el tipo de incidencia"); return; }
    const desc = incDesc.trim();
    if (!desc) { alert("Ingresa una descripción de la incidencia"); return; }
    setIncSaving(true);

    const retrasoTxt = incRetraso ? ` (retraso estimado: ${Number(incRetraso)} min)` : "";
    const paradaNombre = paradas[paradaIdx]?.nombre || null;

    try {
      await condApi("incidencia", { incidencia: {
        conductor_id: conductor.id,
        vehiculo_id:  vehiculoId,
        reserva_id:   reservaActiva?.id || null,
        tipo:         incTipo,
        severidad:    incSev,
        descripcion:  desc + retrasoTxt,
        ubicacion:    paradaNombre,
        lat:          posRef.current?.coords.latitude || null,
        lng:          posRef.current?.coords.longitude || null,
        // estado: usa default 'reportado'
        // id: auto-generado INC-YYYY-NNNN
      } });
    } catch (e: any) {
      setIncSaving(false);
      setBoardingMsg({ ok: false, msg: `Error: ${e?.message}` });
      setTimeout(() => setBoardingMsg(null), 4000);
      return;
    }
    setIncSaving(false);
    setShowIncidencia(false);
    setIncTipo(null); setIncSev("medio"); setIncDesc(""); setIncRetraso("");
    setBoardingMsg({ ok: true, msg: "Incidencia reportada a operaciones" });
    setTimeout(() => setBoardingMsg(null), 3000);
  }

  // ─── NAV (Waze / Google Maps) ───────────────────────────────────────────────

  function abrirWaze(parada: Parada) {
    let url: string;
    if (parada.lat && parada.lng) {
      url = `https://waze.com/ul?ll=${parada.lat},${parada.lng}&navigate=yes&zoom=17`;
    } else if (parada.direccion) {
      url = `https://waze.com/ul?q=${encodeURIComponent(parada.direccion)}&navigate=yes`;
    } else {
      url = `https://waze.com/ul?q=${encodeURIComponent(parada.nombre + ", Lima, Peru")}&navigate=yes`;
    }
    window.open(url, "_blank");
  }

  function abrirGoogleMaps(parada: Parada) {
    let dest: string;
    if (parada.lat && parada.lng) dest = `${parada.lat},${parada.lng}`;
    else if (parada.direccion) dest = encodeURIComponent(parada.direccion);
    else dest = encodeURIComponent(parada.nombre + ", Lima, Peru");
    const origin = posRef.current
      ? `&origin=${posRef.current.coords.latitude},${posRef.current.coords.longitude}`
      : "";
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${dest}${origin}&travelmode=driving`, "_blank");
  }

  // ─── Checklist ──────────────────────────────────────────────────────────────

  // File → base64 SIN prefijo (forma que espera lib/vision-ia.ts vía el route de OCR).
  // Comprime la foto en el celular a ~1568px / JPEG 0.8 (calibrado para el OCR de visión y para que
  // suba con señal débil sin gastar los datos del conductor). Devuelve base64 (sin prefijo) + blobUrl
  // para la miniatura. Hoy fileToAdjunto mandaba hasta 20 MB sin comprimir — esto lo arregla.
  async function comprimirFoto(file: File): Promise<{ base64: string; blobUrl: string }> {
    const bitmap = await createImageBitmap(file);
    const MAX = 1568, ratio = Math.min(MAX / bitmap.width, MAX / bitmap.height, 1);
    const w = Math.round(bitmap.width * ratio), h = Math.round(bitmap.height * ratio);
    const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), "image/jpeg", 0.8));
    const base64: string = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result || ""); resolve(s.includes(",") ? s.split(",")[1] : s); };
      r.onerror = () => reject(new Error("No se pudo procesar la foto"));
      r.readAsDataURL(blob);
    });
    return { base64, blobUrl: URL.createObjectURL(blob) };
  }

  // Captura la foto del tablero (check-in o check-out): comprime → miniatura + evidencia al instante
  // (la obligatoriedad se cumple con esto, offline-safe: no depende de red) → OCR best-effort con tope
  // de 8s que PRELLENA el km (siempre editable). Si el OCR falla/tarda/foto mala: la foto igual queda,
  // el km se escribe a mano. Guarda km_ocr (lo que leyó la IA) para cruzarlo luego con lo tecleado.
  async function capturarFoto(file: File | undefined, kind: "checkin" | "checkout") {
    if (!file) return;
    const setFoto = kind === "checkin" ? setFotoCheckin : setFotoCheckout;
    const setKm   = kind === "checkin" ? setKmInicio    : setKmFin;
    try {
      setOcrLeyendo(true);
      const { base64, blobUrl } = await comprimirFoto(file);
      const lat = posActual?.coords.latitude ?? null;
      const lng = posActual?.coords.longitude ?? null;
      setFoto({ base64, previewUrl: blobUrl, kmOcr: null, capturadoEn: new Date().toISOString(), lat, lng });
      let data: any = null;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        // Mandar la unidad permite que el servidor use la guía de ESE tablero y contraste el
        // número contra el km vigente (así no entra un parcial ni un dígito de más). Si aún no
        // se eligió unidad, se lee igual pero sin esa validación.
        const vSel = vehiculos.find(v => v.id === vehiculoId);
        const res = await fetch("/api/mantenimiento/leer-odometro", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            adjunto: { tipo: "image", media_type: "image/jpeg", data: base64 },
            vehiculo_id: vehiculoId ?? null,
            flota: vSel?._flota ?? "propia",
          }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        data = JSON.parse(await res.text());
        if (!res.ok || !data.ok) data = null;
      } catch { data = null; }
      const km = data ? Number(data.kilometraje ?? data.km ?? 0) : 0;
      // `auto_ok === false` = el número no cuadra con el kilometraje de esta unidad. No se
      // prellena: es preferible que el conductor lo escriba mirando el tablero a arrastrar una
      // lectura mala hasta la bandeja del operador.
      const dudoso = data ? data.auto_ok === false : false;
      if (data && km && data.calidad_imagen !== "mala" && !dudoso) {
        setKm(String(km));
        setFoto((prev) => (prev ? { ...prev, kmOcr: km } : prev));
        if (data.corregido) {
          alert(`Km leído: ${km.toLocaleString("es-PE")}.\nOjo: la foto muestra dos contadores y se tomó el total (el otro número es el parcial). Verifícalo.`);
        } else if (data.confianza !== "alta") {
          alert(`Km leído: ${km.toLocaleString("es-PE")}${data.motivo ? ` (${data.motivo})` : ""}.\nRevísalo y corrige si hace falta.`);
        }
      } else if (dudoso) {
        alert(`El número leído (${km.toLocaleString("es-PE")}) no cuadra con el kilometraje de esta unidad.\nEscribe el kilometraje mirando el tablero — la foto ya quedó registrada.`);
      } else {
        alert("No se pudo leer el km automáticamente. Escribe el kilometraje a mano — la foto ya quedó registrada.");
      }
    } catch (e: any) {
      alert(`No se pudo procesar la foto: ${e?.message || e}`);
    } finally {
      setOcrLeyendo(false);
    }
  }

  // Render reutilizable: FOTO arriba (obligatoria) + KM abajo (deshabilitado hasta tener foto).
  const renderCapturaOdometro = (kind: "checkin" | "checkout") => {
    const foto    = kind === "checkin" ? fotoCheckin : fotoCheckout;
    const km      = kind === "checkin" ? kmInicio    : kmFin;
    const setKm   = kind === "checkin" ? setKmInicio : setKmFin;
    const setFoto = kind === "checkin" ? setFotoCheckin : setFotoCheckout;
    const placeholder = kind === "checkin" ? "Km de inicio (ej: 152430)" : "Km final (ej: 152980)";
    return (
      <>
        {!foto ? (
          <label style={{
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5,
            padding: "22px 14px", borderRadius: 14, border: "2px dashed var(--c-navy)",
            cursor: ocrLeyendo ? "default" : "pointer", background: "var(--c-navy-tint)", color: "var(--c-navy)",
            fontFamily: FONT_SANS, fontSize: 14, fontWeight: 800, textAlign: "center",
          }}>
            <span style={{ fontSize: 26 }}>📷</span>
            {ocrLeyendo ? "Procesando la foto…" : "Toma la foto del tablero"}
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--c-mute)" }}>Obligatorio para continuar</span>
            <input type="file" accept="image/*" capture="environment" hidden disabled={ocrLeyendo}
              onChange={(e) => { capturarFoto(e.target.files?.[0], kind); e.currentTarget.value = ""; }} />
          </label>
        ) : (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <img src={foto.previewUrl} alt="odómetro" style={{ width: 92, height: 68, objectFit: "cover", borderRadius: 10, border: "1px solid var(--c-line)" }} />
            <div style={{ flex: 1 }}>
              <p style={{ margin: 0, fontSize: 12.5, fontWeight: 800, color: "var(--c-success)" }}>✓ Foto del tablero lista</p>
              <button onClick={() => { URL.revokeObjectURL(foto.previewUrl); setFoto(null); setKm(""); }}
                style={{ marginTop: 4, background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--c-navy)", fontFamily: FONT_SANS, fontSize: 12, fontWeight: 700 }}>
                Tomar otra
              </button>
            </div>
          </div>
        )}
        <input
          type="number" placeholder={placeholder} value={km} disabled={!foto || ocrLeyendo}
          onChange={(e) => setKm(e.target.value)}
          style={{
            width: "100%", marginTop: 8, padding: "12px 14px",
            borderRadius: 12, border: "1.5px solid var(--c-line)",
            fontFamily: FONT_MONO, fontSize: 14, fontWeight: 700, letterSpacing: 0.3,
            color: "var(--c-ink)", outline: "none", boxSizing: "border-box",
            background: foto ? "var(--c-surface)" : "var(--c-soft)", opacity: foto ? 1 : 0.6,
          }}
        />
        {!foto ? (
          <p style={{ margin: "6px 2px 0", fontSize: 11, color: "var(--c-mute)" }}>Toma la foto del tablero primero; luego revisa el kilometraje.</p>
        ) : foto.kmOcr == null ? (
          <p style={{ margin: "6px 2px 0", fontSize: 11, color: "var(--c-warn)", fontWeight: 700 }}>No se leyó el km automáticamente — escríbelo a mano.</p>
        ) : (
          <p style={{ margin: "6px 2px 0", fontSize: 11, color: "var(--c-mute)" }}>Km leído por IA: {foto.kmOcr.toLocaleString("es-PE")}. Corrígelo si no coincide.</p>
        )}
      </>
    );
  };

  async function guardarChecklist() {
    if (!conductor) return;
    if (!vehiculoId) { alert("Selecciona el vehículo antes de iniciar el viaje"); return; }
    // Foto del tablero OBLIGATORIA (la obligatoriedad es haberla capturado — offline-safe; la subida
    // pasa después). El km solo se pudo escribir tras la foto (input deshabilitado hasta capturarla).
    if (!fotoCheckin) { alert("Toma la foto del tablero antes de iniciar (el kilometraje se registra con la foto)"); return; }
    if (!kmInicio || Number(kmInicio) <= 0) { alert("Ingresa el kilometraje de inicio (revisa el número que leyó la foto)"); return; }
    if (checks.some(c => c.ok === null)) {
      alert(`Faltan ${checks.filter(c => c.ok === null).length} ítems por completar`); return;
    }
    // `es_tercero` enruta el odómetro en el backend hacia vehiculos_tercero. Se deriva del
    // VEHÍCULO elegido, no de la tabla del conductor: un conductor tercerizado puede manejar
    // una unidad propia, y como los ids se solapan entre las dos tablas, equivocarse aquí
    // registraría el kilometraje en OTRO bus. El server lo usa y lo descarta antes de
    // insertar checklist_conductor (no es columna de esa tabla).
    const esTercero = (vehiculos.find(v => v.id === vehiculoId)?._flota ?? (conductor._tabla === "conductores_tercero" ? "tercero" : "propia")) === "tercero";
    const payload = { checklist: {
      conductor_id: conductor.id,
      vehiculo_id:  vehiculoId,
      es_tercero:   esTercero,
      fecha:        getFechaLocal(),
      items_json:   checks,
      km_inicio:    kmInicio ? Number(kmInicio) : null,
      km_ocr:       fotoCheckin.kmOcr,
      gps_lat:      fotoCheckin.lat,
      gps_lng:      fotoCheckin.lng,
      capturado_en: fotoCheckin.capturadoEn,
      observaciones: checkObs,
      estado:       checks.some(c => c.ok === false) ? "con_fallas" : "ok",
      // La foto (base64 comprimido) viaja DENTRO del payload → si no hay red, cae en la cola offline
      // y se sube sola al reconectar (sin cola de subidas aparte). El server la sube con service-role.
      foto_adjunto: { media_type: "image/jpeg", data: fotoCheckin.base64 },
    } };
    setCheckSaving(true);
    // Reintenta ante fallos de red transitorios ("Failed to fetch"): la tablet a veces pierde
    // la red un instante (WiFi del depósito, doze de Android). 3 intentos con backoff corto.
    let ultimoError: any = null;
    for (let intento = 1; intento <= 3; intento++) {
      try {
        await condApi("checklist", payload);
        try { localStorage.removeItem("afa_checklist_pendiente"); } catch {}
        setCheckSaving(false);
        setCheckDone(true);
        return;
      } catch (e: any) {
        ultimoError = e;
        if (intento < 3) await new Promise(r => setTimeout(r, 1200 * intento));
      }
    }
    setCheckSaving(false);
    // Falla persistente de red: el checklist YA está completo y la BD es best-effort (el server
    // ni siquiera bloquea a terceros). Ofrecer continuar y dejarlo en cola para sincronizar al
    // volver la conexión — un microcorte de red NO debe impedir arrancar el servicio.
    const proceder = confirm(
      `No se pudo guardar el check-in por la conexión (${ultimoError?.message || "sin red"}).\n\n` +
      `El checklist está completo. ¿Continuar igual? Se guardará automáticamente cuando vuelva la conexión.`
    );
    if (proceder) {
      try { localStorage.setItem("afa_checklist_pendiente", JSON.stringify(payload)); } catch {}
      setCheckDone(true);
    }
  }

  // ─── Check-out de jornada (km final + nivel de combustible + observaciones) ───
  async function guardarCheckout() {
    if (!conductor) return;
    if (!vehiculoId) { alert("Selecciona el vehículo antes de cerrar la jornada"); return; }
    // Foto obligatoria CON salida de emergencia: si la unidad quedó en taller / el tablero no
    // enciende, se cierra la jornada eligiendo un motivo (no dejar la jornada abierta sin liquidar).
    if (!fotoCheckout && !sinFotoMotivo) {
      alert("Toma la foto del tablero, o elige un motivo para cerrar sin foto (unidad en taller, tablero apagado, etc.)"); return;
    }
    if (fotoCheckout && (!kmFin || Number(kmFin) <= 0)) {
      alert("Ingresa el kilometraje final (revisa el número que leyó la foto)"); return;
    }
    // Misma regla que en el check-in: la flota la manda el vehículo elegido, no el conductor.
    const esTercero = (vehiculos.find(v => v.id === vehiculoId)?._flota ?? (conductor._tabla === "conductores_tercero" ? "tercero" : "propia")) === "tercero";
    const payload = { checkout: {
      conductor_id: conductor.id,
      vehiculo_id:  vehiculoId,
      es_tercero:   esTercero,
      fecha:        getFechaLocal(),
      km_fin:       kmFin ? Number(kmFin) : null,
      nivel_combustible: nivelComb || null,
      observaciones: checkoutObs.trim() || null,
      km_ocr:       fotoCheckout?.kmOcr ?? null,
      gps_lat:      fotoCheckout?.lat ?? null,
      gps_lng:      fotoCheckout?.lng ?? null,
      // Sin foto (unidad en taller, tablero apagado) no hay hora de captura, pero el cierre SÍ
      // ocurre ahora: sin este fallback la lectura entra sin `capturado_en` y todo el ERP la
      // ordena por su hora de INSERCIÓN, que con la cola offline puede caer horas después.
      capturado_en: fotoCheckout?.capturadoEn ?? new Date().toISOString(),
      sin_foto_motivo: fotoCheckout ? null : (sinFotoMotivo || null),
      ...(fotoCheckout ? { foto_adjunto: { media_type: "image/jpeg", data: fotoCheckout.base64 } } : {}),
    } };
    setCheckoutSaving(true);
    try {
      await condApi("checkout", payload);
      setCheckoutHecho(true);
      setMostrarCheckout(false);
    } catch (e: any) {
      alert(`No se pudo guardar el check-out: ${e?.message || "sin red"}. Reintenta al llegar a cochera.`);
    } finally {
      setCheckoutSaving(false);
    }
  }

  // Sincroniza un pre-viaje que quedó pendiente (guardado offline) cuando vuelve la red o el
  // app pasa a primer plano. Mismo patrón que el drenado de la cola GPS de más arriba.
  useEffect(() => {
    const sincronizarChecklist = async () => {
      let raw: string | null = null;
      try { raw = localStorage.getItem("afa_checklist_pendiente"); } catch { return; }
      if (!raw) return;
      try {
        await condApi("checklist", JSON.parse(raw));
        try { localStorage.removeItem("afa_checklist_pendiente"); } catch {}
      } catch { /* sigue pendiente; se reintenta en el próximo online/visible */ }
    };
    sincronizarChecklist();
    const onVis = () => { if (typeof document !== "undefined" && document.visibilityState === "visible") sincronizarChecklist(); };
    window.addEventListener("online", sincronizarChecklist);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("online", sincronizarChecklist);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // ─── Rendición de gastos (caja chica) ───────────────────────────────────────
  // El chofer fotografía el peaje o el lavado y el ticket queda rendido contra su caja chica.
  // TODO va con el token firmado: el servidor deriva de él contra qué bolsa de dinero se carga
  // el gasto y quién puede leer los comprobantes (ver la nota de identidad en la ruta).

  const cargarCajaChica = useCallback(async () => {
    const token = conductor?._token;
    if (!token) { setCcError("Vuelve a iniciar sesión para ver tu caja chica."); return; }
    setCcCargando(true); setCcError("");
    try {
      const r = await condApi("mi_caja_chica", { token });
      setCcRendicion((r.rendicion as MiRendicion | null) ?? null);
      setCcGastos(Array.isArray(r.gastos) ? (r.gastos as GastoRendido[]) : []);
    } catch (e) {
      setCcError(errorApi(e).message || "No se pudo cargar tu caja chica.");
    } finally {
      setCcCargando(false);
    }
  }, [conductor?._token]);

  /** Drena la cola offline. Un envío solo SALE de la cola cuando entró de verdad (o cuando
   *  reintentarlo no puede funcionar nunca): `duplicado` = ya se registró en un intento previo
   *  cuya respuesta se perdió, y 400 = payload inválido. Un 409 por "rendición en revisión"
   *  se queda esperando: será enviable en cuanto administración la liquide.
   *
   *  Dos cuidados que el drenado NO puede saltarse, porque cada POST tarda lo que tarde la señal
   *  y en esa ventana pasan cosas:
   *   · `drenando` — `online` y `visibilitychange` disparan de a dos (volver a primer plano con
   *     señal recuperada es UN gesto, dos eventos). Sin el candado, dos drenados mandan el MISMO
   *     gasto a la vez; el índice único del servidor solo salva a los que llevan foto, y un gasto
   *     "sin comprobante" (foto_hash null) entraría DUPLICADO en la rendición.
   *   · se descartan ids, no se reescribe la cola con la foto que se leyó al empezar: si el chofer
   *     registra un gasto y falla mientras esto está en vuelo, escribir el snapshot viejo le
   *     BORRABA el ticket recién fotografiado. */
  const drenando = useRef(false);
  const drenarGastos = useCallback(async () => {
    const cola = leerColaGastos();
    setCcCola(cola.length);
    const token = conductor?._token;
    if (!token || cola.length === 0 || drenando.current) return;
    drenando.current = true;
    // Envíos resueltos (entraron, o reintentarlos no puede funcionar nunca) → fuera de la cola.
    const resueltos = new Set<string>();
    let enviados = 0;
    try {
      for (const p of cola) {
        let ok = false;
        try { await condApi("rendir_gasto", { ...p, token }); enviados++; ok = true; }
        catch (e) {
          const err = errorApi(e);
          ok = err.datos?.duplicado === true || err.estado === 400;
        }
        if (ok && p._cola_id) resueltos.add(p._cola_id);
      }
    } finally {
      drenando.current = false;
    }
    // Se relee: la cola de AHORA puede traer gastos que el chofer encoló durante el drenado.
    const restante = leerColaGastos().filter(p => !p._cola_id || !resueltos.has(p._cola_id));
    setCcCola(guardarColaGastos(restante).length);
    if (enviados > 0) await cargarCajaChica();
  }, [conductor?._token, cargarCajaChica]);

  // La caja chica se carga al TOCAR la pestaña (ver el onChange del TabBar), no en el arranque:
  // es dato de oficina, no del viaje, y el arranque ya pelea por la red con servicios y GPS.

  // Cola offline: mismo drenado que el check-in pendiente (online + volver a primer plano).
  useEffect(() => {
    const drenar = () => { void drenarGastos(); };
    drenar();
    const onVis = () => { if (typeof document !== "undefined" && document.visibilityState === "visible") drenar(); };
    window.addEventListener("online", drenar);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("online", drenar);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [drenarGastos]);

  useEffect(() => {
    if (!ccAviso) return;
    const t = setTimeout(() => setCcAviso(""), 6000);
    return () => clearTimeout(t);
  }, [ccAviso]);

  function limpiarFormGasto() {
    setCcFoto(prev => { if (prev) URL.revokeObjectURL(prev.previewUrl); return null; });
    setCcCat("peaje"); setCcMonto(""); setCcDesc(""); setCcReservaId(null);
  }

  async function capturarComprobante(file: File | undefined) {
    if (!file) return;
    setCcFotoProc(true);
    try {
      const { base64, blobUrl } = await comprimirFoto(file);
      setCcFoto(prev => {
        if (prev) URL.revokeObjectURL(prev.previewUrl);
        return {
          base64, previewUrl: blobUrl, capturadoEn: new Date().toISOString(),
          lat: posActual?.coords.latitude ?? null, lng: posActual?.coords.longitude ?? null,
        };
      });
    } catch (e) {
      alert(`No se pudo procesar la foto: ${errorApi(e).message}`);
    } finally {
      setCcFotoProc(false);
    }
  }

  async function registrarGasto() {
    if (!conductor?._token) { alert("Vuelve a iniciar sesión para registrar gastos."); return; }
    // Coma decimal: en el teclado numérico del celular es lo que sale, y "12,50" parseado en
    // crudo da NaN. El monto SIEMPRE es editable a mano (no hay OCR que lo prellene).
    const monto = Number(ccMonto.replace(",", "."));
    if (!Number.isFinite(monto) || monto <= 0) { alert("Ingresa el monto del gasto."); return; }
    if (!ccFoto && !confirm("No adjuntaste el comprobante.\n\nSe registrará como gasto SIN comprobante y administración lo va a revisar aparte. ¿Continuar?")) return;

    const vSel = vehiculos.find(v => v.id === vehiculoId);
    const pendiente: GastoPendiente = {
      // El id se sella AQUÍ, no al encolar: el servidor lo guarda como llave de idempotencia
      // (uq_cc_gastos_idem). Si se sellara solo al caer en la cola, el reintento de un envío
      // cuya RESPUESTA se perdió tras el commit llevaría un id nuevo y entraría duplicado —
      // el índice de foto_hash no cubre los gastos declarados sin comprobante.
      _cola_id: nuevoIdCola(),
      sin_comprobante: !ccFoto,
      gasto: {
        fecha: getFechaLocal(),
        categoria: ccCat,
        descripcion: ccDesc.trim() || null,
        monto,
        reserva_id: ccReservaId,
        vehiculo_id: vehiculoId,
        // La flota la manda el VEHÍCULO elegido, no la tabla del conductor: los ids se solapan
        // entre vehiculos y vehiculos_tercero (misma regla que el check-in).
        vehiculo_es_tercero: (vSel?._flota ?? (conductor._tabla === "conductores_tercero" ? "tercero" : "propia")) === "tercero",
        lat: ccFoto?.lat ?? posActual?.coords.latitude ?? null,
        lng: ccFoto?.lng ?? posActual?.coords.longitude ?? null,
        capturado_en: ccFoto?.capturadoEn ?? new Date().toISOString(),
        // La foto viaja DENTRO del payload: si no hay red, el gasto ENTERO cae en la cola y se
        // sube solo al reconectar, sin una cola de subidas aparte que mantener.
        ...(ccFoto ? { foto_adjunto: { media_type: "image/jpeg", data: ccFoto.base64 } } : {}),
      },
    };

    setCcGuardando(true);
    try {
      const r = await condApi("rendir_gasto", { ...pendiente, token: conductor._token });
      limpiarFormGasto(); setCcForm(false);
      setCcAviso(`Gasto registrado en ${r.rendicion_codigo ?? "tu rendición"} · rendido ${fmtMoneda(Number(r.total_rendido ?? 0))}`);
      await cargarCajaChica();
    } catch (e) {
      const err = errorApi(e);
      const estado = err.estado ?? 0;
      if (err.datos?.duplicado === true) {
        limpiarFormGasto(); setCcForm(false);
        setCcAviso(err.message || "Ese comprobante ya estaba registrado.");
        await cargarCajaChica();
      } else if (estado >= 400 && estado < 500) {
        // El servidor rechazó el CONTENIDO (monto, categoría, rendición en revisión, sesión
        // vencida): encolarlo sería encolar un error. El formulario queda intacto para corregir.
        alert(err.message || "No se pudo registrar el gasto.");
      } else {
        // Sin red, o falló la subida de la foto (502). El gasto NO se pierde.
        setCcCola(guardarColaGastos([...leerColaGastos(), pendiente]).length);
        limpiarFormGasto(); setCcForm(false);
        setCcAviso("Sin conexión: el gasto quedó guardado y se enviará solo al recuperar señal.");
      }
    } finally {
      setCcGuardando(false);
    }
  }

  async function enviarRendicion() {
    if (!conductor?._token || ccEnviando) return;
    // Cerrar con gastos aún en la cola los condena: al pasar a `por_revisar` el servidor los
    // rechaza con 409 hasta que administración liquide, y el chofer no entiende por qué el
    // comprobante que fotografió nunca apareció. Se intenta subirlos primero.
    if (ccCola > 0) {
      setCcEnviando(true);
      try { await drenarGastos(); } finally { setCcEnviando(false); }
      if (leerColaGastos().length > 0) {
        alert("Todavía hay gastos sin subir.\n\nConéctate a una red y espera a que suban antes de cerrar la rendición: si la cierras ahora, esos comprobantes no van a entrar.");
        return;
      }
    }
    if (!confirm("Vas a cerrar tu rendición y mandarla a administración.\n\nDespués no podrás agregarle más comprobantes. ¿Continuar?")) return;
    setCcEnviando(true);
    try {
      const r = await condApi("enviar_rendicion", { token: conductor._token });
      setCcAviso(r.rendicion_codigo ? `Rendición ${r.rendicion_codigo} enviada a revisión.` : "Rendición enviada a revisión.");
      await cargarCajaChica();
    } catch (e) {
      alert(errorApi(e).message || "No se pudo enviar la rendición.");
    } finally {
      setCcEnviando(false);
    }
  }

  // ─── Docs ───────────────────────────────────────────────────────────────────

  async function subirDoc() {
    if (!conductor) return;
    if (!docUrl.trim()) { alert("Ingresa la URL del documento antes de registrar"); return; }
    setDocSaving(true);
    let data: any = null;
    try {
      const r = await condApi("documento", { documento: {
        conductor_id: conductor.id,
        tipo:         docTipo,
        url:          docUrl.trim(),
        nombre:       docTipo,
        vencimiento:  docVenc || null,
      } });
      data = r.documento;
    } catch (e: any) {
      setDocSaving(false);
      alert(`Error al registrar documento: ${e?.message}`); return;
    }
    setDocSaving(false);
    if (data) setDocs(prev => [data, ...prev]);
    setDocUrl(""); setDocVenc("");
  }

  // ─── Cambiar PIN ────────────────────────────────────────────────────────────

  async function cambiarPin() {
    if (pinNuevo.length < 4 || pinNuevo !== pinConfirm) { setPinMsg("PINs no coinciden"); return; }
    if (!conductor) return;
    try {
      await condApi("cambiar_pin", { cid: conductor.id, tabla: conductor._tabla, pin: pinNuevo });
    } catch (e: any) { setPinMsg(`Error: ${e?.message}`); setTimeout(() => setPinMsg(""), 4000); return; }
    const upd = { ...conductor, pin_acceso: pinNuevo };
    saveSession(upd); setConductor(upd);
    setPinMsg("PIN cambiado"); setPinNuevo(""); setPinConfirm("");
    setTimeout(() => { setPinMsg(""); setCamPin(false); }, 2000);
  }

  function cerrarSesion() {
    if ((enRuta || conectado) && !confirm("Estás compartiendo tu ubicación. ¿Cerrar sesión igual?")) return;
    cleanup(); clearSession(); setConductor(null);
    setEnRuta(false); setConectado(false); setDni(""); setPin(""); setTab("ruta");
  }

  // ─── DERIVADOS ──────────────────────────────────────────────────────────────

  const vehSel        = vehiculos.find(v => v.id === vehiculoId);
  const paradaActual  = paradas[paradaIdx];
  const esUltimaParada = enRuta && paradas.length > 0 && paradaIdx === paradas.length - 1;
  const pasParada     = pasajeros.filter(p => p.parada_id === paradaActual?.id);
  const embarcados    = pasParada.filter(p => esAbordado(p.estado)).length;
  const checkPct      = Math.round((checks.filter(c => c.ok !== null).length / checks.length) * 100);
  const checkFallas   = checks.filter(c => c.ok === false).length;
  const categorias    = Array.from(new Set(CHECKLIST_ITEMS.map(i => i.categoria)));
  const docsBadge     = docs.filter(d => docEstado(d.vencimiento) === "vencido").length;

  // Caja chica: la rendición "viva" es la única que admite comprobantes nuevos o el envío a
  // revisión. `saldo_pendiente` NEGATIVO = el chofer puso de su bolsillo y la empresa le debe.
  const ccAbierta   = ccRendicion?.estado === "abierta" || ccRendicion?.estado === "observada";
  const ccSaldo     = Number(ccRendicion?.saldo_pendiente ?? 0);
  const ccDiasRendir = diasPara(ccRendicion?.fecha_limite ?? null);
  const ccBadge     = ccCola > 0 || !!ccRendicion?.atrasada;

  const hoyLocal         = getFechaLocal();
  const esModoOtraFecha  = fechaVista !== hoyLocal;
  const reservasMostrar  = esModoOtraFecha ? (reservasOtraFecha ?? []) : reservasHoy;
  const reservasFinalizadasSection = reservasMostrar.filter(r => r.estado === "finalizada" && r.id !== reservaActiva?.id);
  const reservasPendientesSection  = reservasMostrar.filter(r => r.estado !== "finalizada" && r.id !== reservaActiva?.id);

  // Orden cronológico: solo se puede iniciar el servicio más temprano del día que
  // aún no esté cerrado (finalizado o cancelado). Los servicios posteriores quedan
  // bloqueados hasta completarlo (evita iniciar el retorno antes que la ida).
  // reservasHoy ya viene ordenado por hora_servicio desde el API.
  const esServicioCerrado = (e?: string | null) => e === "finalizada" || e === "cancelada";
  const primeraIniciable = esModoOtraFecha ? null : reservasHoy.find(r => !esServicioCerrado(r.estado));
  // El hero "Próximo viaje" = primeraIniciable (el servicio más temprano NO cerrado, por orden),
  // AUNQUE su hora ya haya pasado. Antes se filtraba por hora futura (>= 0): si el conductor
  // arrancaba tarde, el hero saltaba al SIGUIENTE servicio y dejaba el atrasado escondido en la
  // lista → confusión de orden. Ahora hero e iniciable COINCIDEN; el countdown marca "atrasado".
  const proximaReserva = !enRuta ? primeraIniciable : null;
  const minsHastaProx  = proximaReserva ? minutosRelativos(proximaReserva.hora_servicio) : null; // + falta / − atrasado
  const proxAtrasado   = minsHastaProx !== null && minsHastaProx < 0;
  // El próximo se muestra como tarjeta-hero del timeline → no repetirlo en la lista de pendientes.
  const pendientesAgenda = reservasPendientesSection.filter(r => r.id !== proximaReserva?.id);
  void tick; // forzar re-render con el setInterval del minuto

  const totalReservados = pasajeros.length;
  const totalEmbarcados = pasajeros.filter(p => esAbordado(p.estado)).length;
  const totalEsperando  = pasajeros.filter(p => p.estado === "esperando" || !p.estado).length;
  const totalNoShow     = pasajeros.filter(p => p.estado === "no_show").length;

  // ═══════════════════════════════════════════════════════════════════════════
  // LOADING
  // ═══════════════════════════════════════════════════════════════════════════

  if (initing) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--c-navy)", fontFamily: FONT_SANS }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 40, height: 40, border: "4px solid rgba(255,255,255,0.3)", borderTop: "4px solid white", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 12px" }} />
        <p style={{ color: "white", fontSize: 14, margin: 0 }}>Cargando…</p>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // LOGIN
  // ═══════════════════════════════════════════════════════════════════════════

  if (!conductor) return (
    <div style={{
      minHeight: "100svh", background: "var(--c-paper)", fontFamily: FONT_SANS,
      display: "flex", flexDirection: "column", alignItems: "center",
      boxSizing: "border-box", overflowX: "hidden",
    }}>
      <div style={{
        width: "100%", maxWidth: 480, padding: "48px 20px 24px",
        boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center",
      }}>
        {/* ── Logo AFA Conductores ── */}
        <img
          src="/afaconductorsinfondo.png"
          alt="AFA Conductor"
          style={{ width: "min(220px, 55vw)", display: "block", marginBottom: 28 }}
        />
        <h1 style={{
          fontFamily: FONT_SANS, fontSize: "clamp(20px, 5vw, 26px)", fontWeight: 800, letterSpacing: -0.8,
          color: "var(--c-ink)", margin: "0 0 6px", textAlign: "center",
        }}>
          Buen día, conductor.
        </h1>
        <p style={{ color: "var(--c-mute)", fontSize: "clamp(13px, 3.5vw, 15px)", fontWeight: 500, margin: 0, textAlign: "center" }}>
          Ingresa con tu DNI y PIN personal para abrir tu jornada.
        </p>
      </div>

      {/* ── Card ── */}
      <div style={{
        width: "100%", maxWidth: 480, boxSizing: "border-box",
        padding: "0 16px 32px",
      }}>
        <div style={{
          background: "var(--c-surface)", border: "1px solid var(--c-line)",
          borderRadius: 22, padding: "20px 20px 24px",
          boxShadow: "0 4px 14px rgba(0,0,0,0.05)", boxSizing: "border-box",
        }}>
          {/* DNI */}
          <Eyebrow>Documento de identidad</Eyebrow>
          <div style={{
            display: "flex", alignItems: "baseline", gap: 10, marginTop: 8,
            borderBottom: `1.5px solid ${dni.length >= 7 ? "var(--c-navy)" : "var(--c-line)"}`,
            paddingBottom: 8,
          }}>
            <span style={{ fontFamily: FONT_MONO, fontWeight: 700, fontSize: 15, color: "var(--c-mute)", flexShrink: 0 }}>PE</span>
            <input
              type="tel" inputMode="numeric" maxLength={8} value={dni}
              onChange={e => {
                const val = e.target.value.replace(/\D/g, "").slice(0, 8);
                setDni(val);
                setLoginErr("");
                if (val.length === 8) setTimeout(() => pinInputRef.current?.focus(), 80);
              }}
              placeholder="12345678"
              style={{
                flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent",
                fontFamily: FONT_MONO, fontSize: "clamp(22px, 6vw, 28px)", fontWeight: 800, letterSpacing: 4,
                color: "var(--c-ink)",
              }}
            />
            <span style={{
              fontSize: 11, fontWeight: 600, color: "var(--c-mute)",
              background: "var(--c-soft)", borderRadius: 6, padding: "2px 7px", flexShrink: 0,
            }}>
              8 díg.
            </span>
          </div>

          {/* PIN */}
          <div style={{ marginTop: 22 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <Eyebrow>PIN de acceso</Eyebrow>
              <span style={{
                fontSize: 11, fontWeight: 600, color: "var(--c-mute)",
                background: "var(--c-soft)", borderRadius: 6, padding: "2px 7px",
              }}>
                4 díg.
              </span>
            </div>
            <div style={{
              padding: "6px 4px 12px",
              borderBottom: `1.5px solid ${pin.length === 4 ? "var(--c-navy)" : "var(--c-line)"}`,
              marginBottom: 18,
              transition: "border-color 0.2s",
            }}>
              <input
                ref={pinInputRef}
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={pin}
                autoComplete="one-time-code"
                placeholder="••••"
                onChange={e => {
                  const val = e.target.value.replace(/\D/g, "").slice(0, 4);
                  setPin(val);
                  setLoginErr("");
                  if (val.length === 4) setTimeout(() => login(), 120);
                }}
                onKeyDown={e => e.key === "Enter" && login()}
                style={{
                  fontFamily: FONT_MONO, fontSize: 32, fontWeight: 700,
                  color: "var(--c-ink)", letterSpacing: 10,
                  width: "100%", border: "none", outline: "none",
                  background: "transparent",
                }}
              />
            </div>
          </div>

          {/* Error */}
          {loginErr && (
            <div style={{
              marginTop: 14,
              background: "var(--c-danger-tint)", border: "1px solid var(--c-danger)",
              borderRadius: 12, padding: "10px 14px",
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <IconCircleAlert size={16} color="var(--c-danger)" />
              <span style={{ color: "var(--c-danger)", fontSize: 13, fontWeight: 600 }}>{loginErr}</span>
            </div>
          )}

          {/* Botón */}
          <div style={{ marginTop: 18 }}>
            <PrimaryBtn
              onClick={login}
              disabled={loginLoading || dni.length < 7 || pin.length < 4}
              icon={<IconArrowRight size={18} color="#fff" />}
              size="lg"
            >
              {loginLoading ? "Verificando…" : "Ingresar"}
            </PrimaryBtn>
          </div>
        </div>

        {/* ── Beneficios ── */}
        <div style={{ marginTop: 28 }}>
          <p style={{
            margin: "0 0 14px", textAlign: "center",
            fontSize: 10, fontWeight: 700, letterSpacing: 1.4,
            textTransform: "uppercase", color: "var(--c-mute)",
          }}>
            Tu jornada en una app
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            {[
              {
                icon: <IconRoute size={22} color="var(--c-navy)" />,
                titulo: "Ruta en vivo",
                sub: "GPS y paradas",
              },
              {
                icon: <IconScan size={22} color="var(--c-navy)" />,
                titulo: "Escanear QR",
                sub: "Embarque rápido",
              },
              {
                icon: <IconShield size={22} color="var(--c-navy)" />,
                titulo: "Check-in",
                sub: "Inspección inicial",
              },
            ].map(b => (
              <div key={b.titulo} style={{
                background: "var(--c-surface)", border: "1px solid var(--c-line)",
                borderRadius: 16, padding: "14px 10px 12px",
                display: "flex", flexDirection: "column", alignItems: "center",
                gap: 8, textAlign: "center",
                boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
              }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 13,
                  background: "var(--c-navy-tint)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  {b.icon}
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: "var(--c-ink)", lineHeight: 1.2 }}>
                    {b.titulo}
                  </p>
                  <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--c-mute)", fontWeight: 500 }}>
                    {b.sub}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Soporte */}
        <p style={{ margin: "24px 0 32px", color: "var(--c-mute)", fontSize: 12, textAlign: "center", fontFamily: FONT_SANS }}>
          ¿Problemas para entrar? Llama a soporte ·{" "}
          <a href="tel:966707225" style={{ color: "var(--c-navy)", fontWeight: 700, textDecoration: "none" }}>
            966 707 225
          </a>
        </p>
      </div>
    </div>
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // SHELL PRINCIPAL
  // ═══════════════════════════════════════════════════════════════════════════

  // Seis pestañas: el TabBar reparte el ancho a partes iguales y a 11px "Check-in" ya no entra
  // en una pantalla de 320 px sin partirse en dos líneas → se acorta a "Check". Es el único
  // rótulo que hubo que tocar.
  const TABS: TabItem<Tab>[] = [
    { id: "ruta",       label: "Hoy",       icon: <IconCalendar size={20} /> },
    { id: "paradas",    label: "Ruta",      icon: <IconRoute size={20} />, badge: enRuta && paradaActual ? true : false },
    { id: "checklist",  label: "Check",     icon: <IconShield size={20} />, badge: !checkDone },
    { id: "documentos", label: "Docs",      icon: <IconReceipt size={20} />, badge: docsBadge > 0 },
    { id: "rendicion",  label: "Gastos",    icon: <IconReceipt size={20} />, badge: ccBadge },
    { id: "perfil",     label: "Perfil",    icon: <IconUser size={20} /> },
  ];

  return (
    <div style={{
      minHeight: "100vh", background: "var(--c-paper)",
      fontFamily: FONT_SANS, color: "var(--c-ink)",
      display: "flex", flexDirection: "column",
      maxWidth: 520, margin: "0 auto",
    }}>

      {/* Flash visual del escáner BT — aparece instantáneo, desaparece con transición */}
      <div aria-hidden style={{
        position: "fixed", inset: 0, zIndex: 9990, pointerEvents: "none",
        background: "rgba(37,99,235,0.30)",
        opacity: btScanFlash ? 1 : 0,
        transition: btScanFlash ? "none" : "opacity 0.5s ease-out",
      }} />

      {/* ── HEADER ───────────────────────────────────────────────────────── */}
      <header style={{
        position: "sticky", top: 0, zIndex: 30,
        background: "var(--c-paper)",
        padding: "14px 18px 10px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        borderBottom: "1px solid var(--c-line-2)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 38, height: 38, borderRadius: 12,
            background: "var(--c-navy)", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontWeight: 800, fontSize: 14, letterSpacing: -0.4,
          }}>
            {ini(conductor.nombre)}
          </div>
          <div>
            <p style={{ margin: 0, fontWeight: 800, fontSize: 14, color: "var(--c-ink)", lineHeight: 1.1 }}>
              {conductor.nombre.split(" ").slice(0, 2).join(" ")}
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              <StatusDot color={compartiendo ? "var(--c-success)" : "var(--c-mute-2)"} pulse={compartiendo} size={6} />
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--c-ink-2)" }}>
                {enRuta ? "En servicio" : conectado ? "Conectado" : "Disponible"}
              </span>
            </div>
            {gpsError && (
              <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--c-danger)", fontFamily: FONT_MONO, maxWidth: 220, overflowWrap: "anywhere" }}>
                GPS: ⚠ {gpsError}
              </p>
            )}
            {envioError && (
              <p style={{ margin: "2px 0 0", fontSize: 11, fontWeight: 800, color: "var(--c-danger)", fontFamily: FONT_MONO, maxWidth: 220, overflowWrap: "anywhere" }}>
                Envío ⚠ {envioError}{pendientes > 0 ? ` · ${pendientes} en cola` : ""}
              </p>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {enRuta && vehSel && (
            <Chip color="var(--c-ink)" bg="var(--c-soft)" mono sw>
              {vehSel.placa}
            </Chip>
          )}
          {enRuta && velocidad > 0 && (
            <Chip color="var(--c-success)" bg="var(--c-success-tint)" mono sw>
              {velocidad} KM/H
            </Chip>
          )}
        </div>
      </header>

      {/* ── CONTENIDO ────────────────────────────────────────────────────── */}
      <main style={{ flex: 1, overflowY: "auto", paddingBottom: 90 }}>

        {/* ═══ HOY ═══ */}
        {tab === "ruta" && (
          <section style={{ padding: "16px 18px 0" }}>
            {/* Fila vehículo asignado + estado de pre-viaje (estilo 2b). Solo fuera de ruta:
                en ruta el vehículo ya se ve en el chip del header superior. */}
            {!enRuta && (
              <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                {/* Botón de vehículo: placa + modelo; el <select> nativo invisible abre el
                    selector al tocar (mantiene la lógica de setVehiculoId). */}
                <label style={{
                  flex: 1, minWidth: 0, position: "relative", background: "var(--c-surface)",
                  border: `1px solid ${vehiculoId ? "var(--c-line)" : "var(--c-warn)"}`, borderRadius: 13,
                  padding: "10px 13px", display: "flex", alignItems: "center", gap: 9, cursor: "pointer",
                }}>
                  <IconBus size={19} color="var(--c-navy)" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontFamily: FONT_MONO, fontSize: 12.5, fontWeight: 800, color: "var(--c-ink)", letterSpacing: 0.3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {vehSel?.placa || "Elegir vehículo"}
                    </p>
                    <p style={{ margin: "3px 0 0", fontSize: 12, fontWeight: 600, color: "var(--c-mute)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {vehSel ? ([vehSel.categoria, vehSel.marca].filter(Boolean).join(" · ") || "Vehículo") : "Toca para asignar"}
                    </p>
                  </div>
                  <IconChevronRight size={16} color="var(--c-mute)" style={{ transform: "rotate(90deg)", flexShrink: 0 }} />
                  <select
                    value={vehiculoId || ""}
                    onChange={e => setVehiculoId(Number(e.target.value) || null)}
                    aria-label="Seleccionar vehículo"
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer", border: "none", appearance: "none", WebkitAppearance: "none" }}
                  >
                    <option value="">Seleccionar vehículo…</option>
                    {vehiculos.map(v => (
                      <option key={v.id} value={v.id}>{v.placa} — {v.categoria} {v.marca || ""}</option>
                    ))}
                  </select>
                </label>
                {/* Estado de pre-viaje: verde "listo" / ámbar "pendiente" (toca → checklist). */}
                <button
                  onClick={() => { if (!checkDone) setTab("checklist"); }}
                  style={{
                    flexShrink: 0, display: "flex", alignItems: "center", gap: 7, borderRadius: 13,
                    padding: "10px 14px", cursor: checkDone ? "default" : "pointer", fontFamily: FONT_SANS,
                    background: checkDone ? "var(--c-success-tint)" : "var(--c-warn-tint)",
                    border: `1px solid ${checkDone ? "var(--c-success)" : "var(--c-warn)"}`,
                  }}
                >
                  <IconShield size={17} color={checkDone ? "var(--c-success)" : "var(--c-warn)"} />
                  <span style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.2, textAlign: "left", color: checkDone ? "var(--c-success)" : "var(--c-warn)" }}>
                    Check-in<br />{checkDone ? "Listo" : "Pendiente"}
                  </span>
                </button>
              </div>
            )}

            {/* ── Conectarse / estado de rastreo (estilo Uber/Cabify) ───────────── */}
            {!enRuta && !conectado && (
              <div style={{ marginBottom: 16 }}>
                <SlideToConnect onConnect={() => setConectado(true)} />
              </div>
            )}
            {!enRuta && conectado && (
              <button
                onClick={() => {
                  if (window.confirm("¿Desconectarte?\n\nDejarás de compartir tu ubicación y la central no podrá verte hasta que te conectes de nuevo.")) setConectado(false);
                }}
                style={{
                  width: "100%", marginBottom: 16, padding: "14px 16px", borderRadius: 16,
                  background: "var(--c-success-tint)", border: "1px solid var(--c-success)",
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  cursor: "pointer", fontFamily: FONT_SANS,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--c-success)", fontWeight: 800, fontSize: 14 }}>
                  <IconActivity size={16} color="var(--c-success)" />
                  Conectado · GPS activo
                </span>
                <span style={{ color: "var(--c-mute)", fontSize: 11, fontWeight: 700 }}>Toca para desconectar</span>
              </button>
            )}
            {enRuta && (
              <div style={{
                width: "100%", marginBottom: 16, padding: "12px 15px", borderRadius: 16,
                background: "var(--c-success-tint)", border: "1px solid var(--c-success)",
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}>
                <span style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--c-success)", fontWeight: 800, fontSize: 14 }}>
                  <IconBus size={16} color="var(--c-success)" />
                  En servicio · GPS activo
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--c-success)", fontSize: 11, fontWeight: 700 }}>
                  <IconShield size={13} color="var(--c-success)" /> Bloqueado
                </span>
              </div>
            )}

            {/* (El estado de pre-viaje pendiente ahora vive en el chip de la fila de vehículo). */}

            {/* Alerta licencia */}
            {conductor.vencimiento_licencia && (diasPara(conductor.vencimiento_licencia) ?? 999) <= 60 && (
              <div style={{
                background: "var(--c-danger-tint)", border: "1px solid var(--c-danger)",
                borderRadius: 14, padding: "12px 14px", marginBottom: 14,
                display: "flex", alignItems: "center", gap: 10,
              }}>
                <IconAlert size={18} color="var(--c-danger)" />
                <p style={{ margin: 0, color: "var(--c-danger)", fontWeight: 800, fontSize: 13 }}>
                  {(diasPara(conductor.vencimiento_licencia) ?? 0) < 0
                    ? "Licencia VENCIDA"
                    : `Licencia vence en ${diasPara(conductor.vencimiento_licencia)} días`}
                </p>
              </div>
            )}

            {/* Estado GPS — visible si hay error de ubicación (permiso/aparato) */}
            {gpsError && (
              <div style={{
                background: "var(--c-warn-tint)", border: "1px solid var(--c-warn)",
                borderRadius: 14, padding: "12px 14px", marginBottom: 14,
                display: "flex", alignItems: "center", gap: 10,
              }}>
                <IconPin size={18} color="var(--c-warn)" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, color: "var(--c-warn)", fontWeight: 800, fontSize: 13 }}>Ubicación: {gpsError}</p>
                  <p style={{ margin: "2px 0 0", color: "var(--c-warn-ink)", fontSize: 11 }}>
                    Activa el GPS del teléfono y concede el permiso de ubicación.
                  </p>
                </div>
                <button
                  onClick={async () => {
                    setGpsError(null);
                    const p = await pedirPermisoUbicacion();
                    if (p === "granted") {
                      try {
                        const pos = await obtenerUbicacion({ enableHighAccuracy: true, timeout: 15000 });
                        posRef.current = pos; setPosActual(pos); enviarUbicacion(pos);
                      } catch (e: any) { setGpsError(e?.message ?? "No se pudo obtener la ubicación"); }
                    } else {
                      setGpsError(p === "denied" ? "Permiso denegado" : "GPS no disponible");
                    }
                  }}
                  style={{ flexShrink: 0, minWidth: 92, background: "var(--c-warn)", border: "none", borderRadius: 12, padding: "11px 16px", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer" }}>
                  Activar
                </button>
              </div>
            )}

            {/* Acceso único a los ajustes que evitan que el SO corte el rastreo: ubicación
                "todo el tiempo" + batería/autostart, unificados en una sola hoja. La tarjeta es
                un SEMÁFORO según la exención de batería REAL del equipo (única señal legible hoy):
                  • protegido (verde, colapsado a una línea) — exentaBat===true; tranquiliza sin estorbar.
                  • atención (ámbar) — exentaBat===false o se detectó un corte de GPS en viaje.
                  • neutro — exentaBat===null (APK viejo/sin plugin): no afirmamos un estado que no sabemos.
                Tocar abre la hoja con las dos acciones (mostrarAjustesGps). */}
            {esAppNativa() && (() => {
              // Precisión APROXIMADA (solo COARSE) degrada CADA fix → cuenta como "atención" aunque
              // la batería esté protegida. verde "protegido" exige batería exenta Y precisión no-aproximada.
              const precMala = precUbic === "aproximada";
              // Tercer eje EN VIVO: conectado pero el servicio de fondo NO corre = solo rastrea con
              // la app abierta. Es lo más urgente (config buena no sirve si ahora no está activo).
              const bgInactivo = compartiendo && !bgServicioActivo;
              // Cuarto eje EN VIVO: la CALIDAD REAL de los fixes que entrega el equipo. El permiso
              // puede estar "Preciso" y aun así llegar ±100 m (sin satélite: teléfono en guantera /
              // parabrisas polarizado / ahorro de batería). Solo se mide compartiendo.
              const gpsDebil = gpsDebilM > 0;
              const estado: "protegido" | "atencion" | "neutro" =
                cortePendiente || exentaBat === false || precMala || bgInactivo || gpsDebil ? "atencion"
                : exentaBat === true ? "protegido"
                : "neutro";

              // Protegido: línea fina, mínimo footprint. Sigue siendo tocable para revisar/re-conceder.
              if (estado === "protegido") {
                return (
                  <button
                    onClick={() => setMostrarAjustesGps(true)}
                    style={{
                      width: "100%", marginBottom: 14, padding: "8px 12px", minHeight: 44, boxSizing: "border-box",
                      display: "flex", alignItems: "center", gap: 8,
                      background: "var(--c-success-tint)", border: "1px solid var(--c-success)",
                      borderRadius: 12, cursor: "pointer", fontFamily: FONT_SANS,
                    }}
                  >
                    <IconShield size={15} color="var(--c-success)" />
                    <span style={{ flex: 1, textAlign: "left", fontSize: 12.5, fontWeight: 800, color: "var(--c-success)" }}>
                      Rastreo protegido
                    </span>
                    <IconChevronRight size={15} color="var(--c-success)" />
                  </button>
                );
              }

              const atencion = estado === "atencion";
              return (
                <button
                  onClick={() => setMostrarAjustesGps(true)}
                  style={{
                    width: "100%", marginBottom: 14, padding: "12px 14px",
                    display: "flex", alignItems: "center", gap: 12, textAlign: "left",
                    background: atencion ? "var(--c-warn-tint)" : "var(--c-surface)",
                    border: atencion ? "1px solid var(--c-warn)" : "1px solid var(--c-line)",
                    borderRadius: 14, cursor: "pointer", fontFamily: FONT_SANS,
                  }}
                >
                  <span style={{
                    flexShrink: 0, width: 34, height: 34, borderRadius: 10,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    background: atencion ? "var(--c-warn)" : "var(--c-navy-tint)",
                  }}>
                    {atencion
                      ? <IconCircleAlert size={18} color="#fff" />
                      : <IconPin size={18} color="var(--c-navy)" />}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 13.5, fontWeight: 800, color: atencion ? "var(--c-warn)" : "var(--c-ink)" }}>
                      {!atencion ? "Ajustes de rastreo" : bgInactivo ? "Rastreo en segundo plano inactivo" : precMala ? "Activa la ubicación precisa" : gpsDebil ? `Sin satélite: ubicación a ±${gpsDebilM} m` : "Revisa los ajustes de rastreo"}
                    </span>
                    <span style={{ display: "block", marginTop: 1, fontSize: 11.5, color: atencion ? "var(--c-warn-ink)" : "var(--c-mute)" }}>
                      {!atencion ? "Ubicación · batería · autostart" : bgInactivo ? "Solo rastrea con la app abierta · revísalo" : precMala ? "Tu GPS sale a ±150 m" : gpsDebil ? "El teléfono te ubica por antenas: se pierden tramos. Ponlo con vista al cielo y quita el ahorro de batería" : "El equipo puede cortar el GPS"}
                    </span>
                  </span>
                  <IconChevronRight size={18} color={atencion ? "var(--c-warn)" : "var(--c-mute)"} />
                </button>
              );
            })()}

            {/* ── Agenda del día: eyebrow + chip de fecha TOCABLE (abre el selector) + conteo
                + navegación con áreas de toque de 44px. La fecha vive solo acá (no en el header). ── */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, marginTop: 2 }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--c-mute)" }}>
                  Agenda
                </p>
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 7 }}>
                  {/* Chip de fecha: el input date invisible (inset 0) lo hace tocable en toda su área. */}
                  <label style={{
                    position: "relative", display: "inline-flex", alignItems: "center", gap: 6,
                    background: "var(--c-navy-tint)", borderRadius: 999, padding: "6px 12px", cursor: "pointer",
                  }}>
                    <IconCalendar size={14} color="var(--c-navy)" />
                    <span style={{ fontSize: 15, fontWeight: 800, color: "var(--c-navy)", whiteSpace: "nowrap" }}>
                      {fmtFechaCorta(fechaVista)}
                    </span>
                    <input
                      type="date" value={fechaVista}
                      aria-label="Elegir fecha"
                      onChange={e => { const v = e.target.value; if (!v) return; setFechaVista(v); if (v === hoyLocal) setReservasOtraFecha(null); else cargarOtraFecha(v); }}
                      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer", border: "none" }}
                    />
                  </label>
                  <span style={{ fontSize: 13, fontWeight: 600, color: "var(--c-mute)", whiteSpace: "nowrap" }}>
                    {reservasMostrar.length} servicio{reservasMostrar.length === 1 ? "" : "s"}
                  </span>
                  {esModoOtraFecha && (
                    <button onClick={irAHoy} style={{ flexShrink: 0, fontSize: 12, fontWeight: 800, color: "var(--c-navy)", background: "transparent", border: "1px solid var(--c-navy)", borderRadius: 999, padding: "5px 12px", cursor: "pointer", fontFamily: FONT_SANS }}>
                      Ir a hoy
                    </button>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: 9, flexShrink: 0 }}>
                <button onClick={() => cambiarFecha(-1)} aria-label="Día anterior" style={{ width: 44, height: 44, borderRadius: 13, border: "1px solid var(--c-line)", background: "var(--c-soft)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <IconArrowLeft size={18} color="var(--c-ink)" />
                </button>
                <button onClick={() => cambiarFecha(+1)} aria-label="Día siguiente" style={{ width: 44, height: 44, borderRadius: 13, border: "1px solid var(--c-line)", background: "var(--c-soft)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <IconArrowRight size={18} color="var(--c-ink)" />
                </button>
              </div>
            </div>

            {/* Timeline · ítem PRÓXIMO (hero, si no está en ruta): rail verde + tarjeta azul */}
            {!enRuta && proximaReserva && (
              <div style={{ display: "flex", gap: 12 }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                  <div style={{ width: 13, height: 13, borderRadius: "50%", background: "var(--c-success)", boxShadow: "0 0 0 4px var(--c-success-tint)", marginTop: 6 }} />
                  <div style={{ flex: 1, width: 2, background: "var(--c-line)", margin: "4px 0" }} />
                </div>
                <div style={{ flex: 1, minWidth: 0, paddingBottom: 16 }}>
              <div style={{
                background: "linear-gradient(165deg, #163a6b, #0e2748)", color: "#fff",
                borderRadius: 24, padding: 20,
                boxShadow: "0 22px 42px -16px rgba(14,39,72,0.5)",
              }}>
                {/* Cabecera (estilo 2b): eyebrow + cuenta regresiva en columna a la izquierda;
                    hora de salida apilada a la derecha (label en azul acero claro, valor en BLANCO
                    para que la hora real resalte tanto como el countdown). */}
                <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, margin: "0 0 2px" }}>
                  <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "stretch", minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
                      <IconClock size={13} color={proxAtrasado ? "#ffcf6b" : "#b9cbe6"} />
                      <span style={{
                        minWidth: 0, fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700, letterSpacing: 1,
                        textTransform: "uppercase", color: proxAtrasado ? "#ffcf6b" : "#b9cbe6",
                      }}>
                        {proxAtrasado ? "Próximo viaje · atrasado" : "Próximo viaje · sale en"}
                      </span>
                    </div>
                    <span style={{
                      fontFamily: FONT_MONO, fontSize: 46, fontWeight: 800, letterSpacing: -1.6, lineHeight: 1, whiteSpace: "nowrap",
                      color: proxAtrasado ? "#ffcf6b" : "#fff",
                    }}>
                      {minsHastaProx === null ? "—" : fmtCountdown(Math.abs(minsHastaProx))}
                    </span>
                  </div>
                  {proximaReserva.hora_servicio && (
                    <div style={{ textAlign: "right", flexShrink: 0, paddingBottom: 8 }}>
                      <p style={{ margin: 0, fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#b9cbe6" }}>
                        Salida
                      </p>
                      <p style={{ margin: "4px 0 0", fontFamily: FONT_MONO, fontSize: 22, fontWeight: 800, letterSpacing: -0.5, lineHeight: 1, color: "#fff" }}>
                        {proximaReserva.hora_servicio.slice(0, 5)}
                      </p>
                    </div>
                  )}
                </div>

                <div style={{ margin: "16px 0", height: 1, background: "rgba(255,255,255,0.12)" }} />

                {/* Recorrido como lista origen → destino: dot + conector + pin, acentos azul
                    acero, direcciones acortadas (sin la cola de plus-code / código postal). */}
                <div style={{ marginBottom: 18, display: "flex", flexDirection: "column" }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <span style={{ flexShrink: 0, width: 13, display: "flex", justifyContent: "center", marginTop: 4 }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid #9db4d4", boxSizing: "border-box" }} />
                    </span>
                    <span style={{
                      flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.4, color: "#eaf1fb",
                      display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                    }}>
                      {acortarLugar(proximaReserva.origen)}
                    </span>
                  </div>
                  <div style={{ width: 13, display: "flex", justifyContent: "center", margin: "4px 0" }}>
                    <span style={{ width: 2, height: 14, background: "rgba(255,255,255,0.18)", borderRadius: 2 }} />
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                    <span style={{ flexShrink: 0, width: 13, display: "flex", justifyContent: "center", marginTop: 1 }}>
                      <IconPin size={14} color="#9db4d4" />
                    </span>
                    <span style={{
                      flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, lineHeight: 1.4, color: "#eaf1fb",
                      display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                    }}>
                      {acortarLugar(proximaReserva.destino)}
                    </span>
                  </div>
                </div>

                {primeraIniciable && proximaReserva.id !== primeraIniciable.id ? (
                  <div style={{
                    width: "100%", padding: "13px 14px", borderRadius: 14,
                    background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.18)",
                    textAlign: "center", color: "rgba(255,255,255,0.85)",
                    fontSize: 13, fontWeight: 700, boxSizing: "border-box",
                  }}>
                    🔒 Primero termina el servicio de las {primeraIniciable.hora_servicio?.slice(0, 5) ?? "—"}
                  </div>
                ) : (
                  <button
                    onClick={() => !checkDone ? setTab("checklist") : confirmarEIniciar(proximaReserva)}
                    disabled={iniciando}
                    style={{
                      width: "100%", padding: "14px 0", borderRadius: 13, border: "none",
                      background: "#fff", color: "var(--c-navy)",
                      fontFamily: FONT_SANS, fontWeight: 800, fontSize: 15,
                      cursor: iniciando ? "not-allowed" : "pointer",
                      opacity: iniciando ? 0.5 : 1,
                      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                      letterSpacing: -0.2,
                    }}
                  >
                    {iniciando
                      ? <>Iniciando…</>
                      : !checkDone
                        ? <><IconShield size={17} color="var(--c-navy)" /> Iniciar check-in</>
                        : <><IconPlay size={16} color="var(--c-navy)" /> Iniciar recorrido</>}
                  </button>
                )}
              </div>
                </div>
              </div>
            )}

            {/* Hero card — viaje en curso */}
            {enRuta && reservaActiva && (
              <div style={{
                background: "var(--c-navy)", color: "#fff",
                borderRadius: 22, padding: 20, marginBottom: 14,
                boxShadow: "0 14px 36px -14px rgba(11,49,95,0.5)",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <StatusDot color="var(--c-success)" pulse size={7} />
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "rgba(255,255,255,0.7)" }}>
                    En curso · {paradaIdx + 1} de {paradas.length} paradas
                  </span>
                </div>
                <p style={{ margin: 0, fontSize: 19, fontWeight: 800, letterSpacing: -0.4 }}>
                  {reservaActiva.origen} → {reservaActiva.destino}
                </p>
                <p style={{ margin: "6px 0 0", color: "rgba(255,255,255,0.65)", fontSize: 13 }}>
                  Inicio: {inicioViaje?.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }) || "—"}
                  {inicioViaje && ` · ${fmtDuracion(Date.now() - inicioViaje.getTime())} en ruta`}
                </p>
                <div style={{ marginTop: 14 }}>
                  <SecondaryBtn
                    onClick={() => setTab("paradas")}
                    icon={<IconRoute size={17} color="var(--c-navy)" />}
                  >
                    Ver paradas
                  </SecondaryBtn>
                </div>
                <button
                  onClick={volverAPendientes}
                  style={{
                    width: "100%", marginTop: 10, padding: "9px 14px",
                    background: "transparent", border: "1px solid rgba(255,255,255,0.22)",
                    borderRadius: 12, cursor: "pointer",
                    fontFamily: FONT_SANS, fontWeight: 700, fontSize: 12.5, color: "rgba(255,255,255,0.8)",
                  }}
                >
                  Aún no estoy listo · volver a pendientes
                </button>
              </div>
            )}


            {/* Lista de servicios */}
            {(esModoOtraFecha ? cargandoOtraFecha : cargando) ? (
              <div style={{
                background: "var(--c-surface)", border: "1px solid var(--c-line)",
                borderRadius: 16, padding: 24, textAlign: "center",
              }}>
                <div style={{ width: 28, height: 28, border: "3px solid var(--c-line)", borderTop: "3px solid var(--c-navy)", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 10px" }} />
                <p style={{ color: "var(--c-mute)", fontSize: 13, margin: 0 }}>Cargando servicios…</p>
              </div>
            ) : reservasMostrar.length === 0 ? (
              <div style={{
                background: "var(--c-surface)", border: "1.5px dashed var(--c-line)",
                borderRadius: 16, padding: 28, textAlign: "center",
              }}>
                <div style={{
                  width: 56, height: 56, borderRadius: 18, background: "var(--c-navy-tint)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 12,
                }}>
                  <IconCalendar size={26} color="var(--c-navy)" />
                </div>
                <p style={{ color: "var(--c-ink)", fontWeight: 800, fontSize: 15, margin: 0 }}>
                  Sin servicios para este día
                </p>
                <p style={{ color: "var(--c-mute)", fontSize: 12, margin: "6px 0 14px", fontFamily: FONT_MONO }}>
                  {fechaVista}
                </p>
                {!esModoOtraFecha && debugInfo && (
                  <p style={{ color: "var(--c-danger)", fontSize: 12, margin: "0 0 14px" }}>{debugInfo}</p>
                )}
                {!esModoOtraFecha && (
                  <SecondaryBtn
                    onClick={() => conductor && cargarDatos(conductor.id, conductor._tabla)}
                    icon={<IconRefresh size={16} color="var(--c-ink)" />}
                    full={false}
                  >
                    Actualizar
                  </SecondaryBtn>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>

                {/* Pendientes / programados (el próximo va arriba como hero del timeline). */}
                {pendientesAgenda.map(r => (
                  <div key={r.id} style={{ display: "flex", gap: 12 }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                      <div style={{ width: 13, height: 13, borderRadius: "50%", border: "2px solid var(--c-navy)", background: "var(--c-surface)", boxSizing: "border-box", marginTop: 6 }} />
                      <div style={{ flex: 1, width: 2, background: "var(--c-line)", margin: "4px 0" }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0, paddingBottom: 14 }}>
                      <div style={{
                        background: "var(--c-surface)", border: "1px solid var(--c-line)",
                        borderRadius: 16, padding: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
                        opacity: esModoOtraFecha ? 0.85 : 1,
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
                          <div style={{ minWidth: 0 }}>
                            <p style={{ margin: 0, fontWeight: 800, fontSize: 16, letterSpacing: -0.3 }}>{r.origen}</p>
                            <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--c-mute)" }}>→ {r.destino}</p>
                            {!esModoOtraFecha && (minutosRelativos(r.hora_servicio) ?? 0) < 0 && (
                              <span style={{
                                display: "inline-block", marginTop: 6, fontSize: 10.5, fontWeight: 800,
                                letterSpacing: 0.4, textTransform: "uppercase", color: "var(--c-warn)",
                                background: "var(--c-warn-tint)", borderRadius: 999, padding: "2px 8px",
                              }}>
                                Atrasado
                              </span>
                            )}
                          </div>
                          {r.hora_servicio && (
                            <div style={{ textAlign: "right", flexShrink: 0 }}>
                              <p style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--c-mute)" }}>Hora</p>
                              <p style={{ margin: "1px 0 0", fontFamily: FONT_MONO, fontSize: 28, fontWeight: 800, letterSpacing: -1.5, lineHeight: 1, color: "var(--c-navy)" }}>
                                {r.hora_servicio.slice(0, 5)}
                              </p>
                            </div>
                          )}
                        </div>
                        {esModoOtraFecha ? (
                          <div style={{ padding: "10px 14px", borderRadius: 12, background: "var(--c-soft)", border: "1px solid var(--c-line)", textAlign: "center", color: "var(--c-mute)", fontSize: 13, fontWeight: 600 }}>
                            Solo lectura — los servicios solo se inician el mismo día
                          </div>
                        ) : primeraIniciable && r.id !== primeraIniciable.id ? (
                          <div style={{ padding: "10px 14px", borderRadius: 12, background: "var(--c-soft)", border: "1px solid var(--c-line)", textAlign: "center", color: "var(--c-mute)", fontSize: 13, fontWeight: 600 }}>
                            🔒 Disponible al terminar el servicio de las {primeraIniciable.hora_servicio?.slice(0, 5) ?? "—"}
                          </div>
                        ) : (
                          <PrimaryBtn
                            onClick={() => !checkDone ? setTab("checklist") : confirmarEIniciar(r)}
                            disabled={iniciando}
                            icon={!checkDone ? <IconShield size={15} color="#fff" /> : <IconPlay size={15} color="#fff" />}
                          >
                            {iniciando ? "Iniciando…" : !checkDone ? "Completar check-in primero" : "Iniciar recorrido"}
                          </PrimaryBtn>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {/* Finalizados (estilo 2b: tarjeta gris con badge + hora + origen → destino). */}
                {reservasFinalizadasSection.map(r => (
                  <div key={r.id} style={{ display: "flex", gap: 12 }}>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                      <div style={{ width: 13, height: 13, borderRadius: "50%", background: "var(--c-mute-2)", display: "flex", alignItems: "center", justifyContent: "center", marginTop: 6 }}>
                        <IconCheck size={9} color="#fff" sw={3} />
                      </div>
                      <div style={{ flex: 1, width: 2, background: "var(--c-line)", margin: "4px 0" }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0, paddingBottom: 14 }}>
                      <div style={{ background: "var(--c-soft)", border: "1px solid var(--c-line)", borderRadius: 16, padding: 14 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: "var(--c-mute)", background: "var(--c-line-2)", padding: "5px 9px", borderRadius: 6 }}>FINALIZADO</span>
                          <span style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 700, color: "var(--c-mute)" }}>{r.hora_servicio?.slice(0, 5) ?? "—"}</span>
                        </div>
                        <p style={{ margin: "11px 0 0", fontSize: 13, fontWeight: 600, lineHeight: 1.45, color: "var(--c-mute)" }}>
                          {acortarLugar(r.origen)} <span style={{ color: "var(--c-mute-2)" }}>→</span> {acortarLugar(r.destino)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Fin de jornada: todos los servicios finalizados → CHECK-OUT */}
                {reservasPendientesSection.length === 0 && !esModoOtraFecha && !reservaActiva && reservasFinalizadasSection.length > 0 && (
                  checkoutHecho ? (
                    <div style={{
                      background: "var(--c-success-tint)", border: "1px solid var(--c-success)",
                      borderRadius: 16, padding: "14px 16px", display: "flex", alignItems: "center", gap: 10,
                    }}>
                      <IconCheck size={20} color="var(--c-success)" sw={2.5} />
                      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--c-success)" }}>
                        Jornada cerrada · Check-out completado
                      </span>
                    </div>
                  ) : !mostrarCheckout ? (
                    <div style={{
                      background: "var(--c-navy-tint)", border: "1px solid var(--c-navy)",
                      borderRadius: 16, padding: 16,
                    }}>
                      <p style={{ margin: "0 0 4px", fontWeight: 800, fontSize: 15, color: "var(--c-navy)" }}>
                        Terminaste tu último servicio del día
                      </p>
                      <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--c-ink-2)", lineHeight: 1.45 }}>
                        Al llegar a cochera, cierra la jornada con el <b>Check-out</b> (kilometraje final y nivel de combustible).
                      </p>
                      <PrimaryBtn onClick={() => setMostrarCheckout(true)} icon={<IconShield size={16} color="#fff" />} size="lg">
                        Hacer Check-out
                      </PrimaryBtn>
                    </div>
                  ) : (
                    <div style={{
                      background: "var(--c-surface)", border: "1px solid var(--c-line)",
                      borderRadius: 16, padding: 16,
                    }}>
                      <Eyebrow>Check-out · cierre de jornada</Eyebrow>
                      <h3 style={{ margin: "4px 0 12px", fontSize: 20, fontWeight: 800, letterSpacing: -0.5 }}>Kilometraje final</h3>

                      {renderCapturaOdometro("checkout")}

                      {/* Salida de emergencia: cerrar sin foto (unidad en taller / tablero apagado / etc.) */}
                      <div style={{ marginTop: 12 }}>
                        {!expandirSinFoto && !sinFotoMotivo ? (
                          <button onClick={() => setExpandirSinFoto(true)}
                            style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--c-mute)", fontFamily: FONT_SANS, fontSize: 12, fontWeight: 700, textDecoration: "underline" }}>
                            No puedo tomar la foto (unidad en taller, tablero apagado…)
                          </button>
                        ) : (
                          <div style={{ background: "var(--c-soft)", borderRadius: 12, padding: 12 }}>
                            <p style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 700, color: "var(--c-ink-2)" }}>Cerrar sin foto — elige el motivo:</p>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              {([["taller", "En taller"], ["averia", "Avería en ruta"], ["tablero_apagado", "Tablero apagado"], ["unidad_entregada", "Unidad entregada"]] as [string, string][]).map(([val, lbl]) => (
                                <button key={val} onClick={() => setSinFotoMotivo(val)}
                                  style={{
                                    padding: "8px 10px", borderRadius: 10, cursor: "pointer", fontFamily: FONT_SANS, fontSize: 12, fontWeight: 700,
                                    border: `1.5px solid ${sinFotoMotivo === val ? "var(--c-navy)" : "var(--c-line)"}`,
                                    background: sinFotoMotivo === val ? "var(--c-navy-tint)" : "var(--c-surface)",
                                    color: sinFotoMotivo === val ? "var(--c-navy)" : "var(--c-mute)",
                                  }}>
                                  {lbl}
                                </button>
                              ))}
                            </div>
                            <button onClick={() => { setSinFotoMotivo(""); setExpandirSinFoto(false); }}
                              style={{ marginTop: 8, background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--c-navy)", fontFamily: FONT_SANS, fontSize: 12, fontWeight: 700 }}>
                              ← Mejor tomo la foto
                            </button>
                          </div>
                        )}
                      </div>

                      <Eyebrow style={{ marginTop: 14, marginBottom: 8 }}>Nivel de combustible</Eyebrow>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {["Lleno", "3/4", "1/2", "1/4", "Reserva"].map(n => (
                          <button key={n} onClick={() => setNivelComb(n)}
                            style={{
                              flex: "1 0 auto", padding: "9px 10px", borderRadius: 10, cursor: "pointer",
                              fontFamily: FONT_SANS, fontSize: 12.5, fontWeight: 700,
                              border: `1.5px solid ${nivelComb === n ? "var(--c-navy)" : "var(--c-line)"}`,
                              background: nivelComb === n ? "var(--c-navy-tint)" : "var(--c-surface)",
                              color: nivelComb === n ? "var(--c-navy)" : "var(--c-mute)",
                            }}>
                            {n}
                          </button>
                        ))}
                      </div>

                      <textarea rows={2} value={checkoutObs} placeholder="Observaciones (opcional)…"
                        onChange={e => setCheckoutObs(e.target.value)}
                        style={{
                          width: "100%", marginTop: 12, padding: 12, borderRadius: 12, border: "1.5px solid var(--c-line)",
                          fontFamily: FONT_SANS, fontSize: 13, color: "var(--c-ink)", background: "var(--c-surface)",
                          resize: "none", outline: "none", boxSizing: "border-box",
                        }} />

                      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                        <PrimaryBtn onClick={guardarCheckout} disabled={checkoutSaving}
                          icon={<IconCheck size={16} color="#fff" sw={2.5} />} size="lg">
                          {checkoutSaving ? "Guardando…" : "Cerrar jornada"}
                        </PrimaryBtn>
                        <SecondaryBtn onClick={() => setMostrarCheckout(false)} full={false}>Cancelar</SecondaryBtn>
                      </div>
                    </div>
                  )
                )}

              </div>
            )}

            {/* Stats GPS si en ruta */}
            {enRuta && (
              <div style={{
                marginTop: 16, background: "var(--c-surface)",
                border: "1px solid var(--c-line)", borderRadius: 16, padding: 14,
              }}>
                <Eyebrow style={{ marginBottom: 10 }}>Sesión GPS</Eyebrow>
                {gpsError && (
                  <p style={{ margin: "0 0 10px", fontSize: 11, color: "var(--c-danger)", fontFamily: FONT_MONO, overflowWrap: "anywhere" }}>
                    ⚠ {gpsError}
                  </p>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[
                    { lbl: "Velocidad",    val: `${velocidad}`, suf: "km/h", mono: true, color: "var(--c-navy)" },
                    { lbl: "Envíos GPS",   val: String(totalEnvios), mono: true, color: "var(--c-success)" },
                    { lbl: "Último envío", val: ultimoEnvio?.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }) || "—", mono: true },
                    { lbl: "Precisión",    val: posActual ? `±${Math.round(posActual.coords.accuracy)}` : "—", suf: "m", mono: true },
                    { lbl: "En cola",      val: String(pendientes), mono: true, color: pendientes > 0 ? "var(--c-danger)" : "var(--c-mute)" },
                  ].map(s => (
                    <div key={s.lbl} style={{ background: "var(--c-soft)", borderRadius: 12, padding: "10px 12px" }}>
                      <p style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--c-mute)" }}>
                        {s.lbl}
                      </p>
                      <p style={{
                        margin: "4px 0 0",
                        fontFamily: s.mono ? FONT_MONO : FONT_SANS,
                        fontSize: 18, fontWeight: 800, letterSpacing: -0.3,
                        color: s.color || "var(--c-ink)",
                      }}>
                        {s.val}{s.suf && <span style={{ fontSize: 12, fontWeight: 600, color: "var(--c-mute)", marginLeft: 4 }}>{s.suf}</span>}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* ═══ PARADAS (En ruta) ═══ */}
        {tab === "paradas" && (
          <section style={{ padding: "16px 18px 0" }}>
            {!enRuta ? (
              <div style={{
                background: "var(--c-surface)", border: "1.5px dashed var(--c-line)",
                borderRadius: 16, padding: 36, textAlign: "center",
              }}>
                <div style={{
                  width: 72, height: 72, borderRadius: 22,
                  background: "var(--c-navy-tint)",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  marginBottom: 14,
                }}>
                  <IconRoute size={30} color="var(--c-navy)" />
                </div>
                <p style={{ margin: 0, fontSize: 16, fontWeight: 800 }}>Aún no iniciaste ningún viaje</p>
                <p style={{ margin: "6px 0 16px", color: "var(--c-mute)", fontSize: 13 }}>
                  Andá a “Hoy” y comenzá el recorrido desde ahí.
                </p>
                <SecondaryBtn
                  onClick={() => setTab("ruta")}
                  icon={<IconArrowLeft size={16} color="var(--c-ink)" />}
                  full={false}
                >
                  Ir a Hoy
                </SecondaryBtn>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div>
                    <Eyebrow>En ruta · {reservaActiva?.origen} → {reservaActiva?.destino}</Eyebrow>
                    <h2 style={{
                      margin: "4px 0 0", fontSize: 22, fontWeight: 800, letterSpacing: -0.6,
                    }}>
                      Recorrido
                    </h2>
                  </div>
                  <button
                    onClick={() => setShowManifiesto(true)}
                    style={{
                      background: "var(--c-soft)", border: "1px solid var(--c-line)",
                      borderRadius: 12, padding: "8px 12px", cursor: "pointer",
                      fontFamily: FONT_SANS, fontWeight: 700, fontSize: 12,
                      color: "var(--c-ink)",
                      display: "inline-flex", alignItems: "center", gap: 6,
                    }}
                  >
                    <IconUsers size={14} />
                    Manifiesto
                  </button>
                </div>

                {/* Recuperación: inició el servicio por error o aún no está listo.
                    Lo devuelve a pendientes sin marcarlo finalizado. */}
                <button
                  onClick={volverAPendientes}
                  style={{
                    width: "100%", marginBottom: 12, padding: "11px 14px",
                    background: "transparent", border: "1px dashed var(--c-line)",
                    borderRadius: 12, cursor: "pointer",
                    fontFamily: FONT_SANS, fontWeight: 700, fontSize: 13, color: "var(--c-mute)",
                  }}
                >
                  Aún no estoy listo · volver a pendientes
                </button>

                {/* Progreso */}
                <div style={{
                  background: "var(--c-surface)", border: "1px solid var(--c-line)",
                  borderRadius: 14, padding: "12px 14px", marginBottom: 12,
                  display: "flex", alignItems: "center", gap: 12,
                }}>
                  <div style={{ flex: 1 }}>
                    <p style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--c-mute)" }}>
                      Progreso
                    </p>
                    <div style={{ marginTop: 6, height: 5, background: "var(--c-line-2)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{
                        height: "100%", width: `${(paradaIdx / Math.max(1, paradas.length)) * 100}%`,
                        background: "linear-gradient(90deg, var(--c-navy), var(--c-success))",
                        borderRadius: 3, transition: "width 0.5s",
                      }} />
                    </div>
                  </div>
                  <Chip color="var(--c-navy)" bg="var(--c-navy-tint)" mono sw>
                    {paradaIdx} / {paradas.length}
                  </Chip>
                </div>

                {/* Timeline */}
                <Eyebrow style={{ marginBottom: 10 }}>Paradas del recorrido</Eyebrow>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
                  {paradas.map((p, i) => {
                    const esActual = i === paradaIdx;
                    const completada = p.estado === "completada";
                    const pp = pasajeros.filter(x => x.parada_id === p.id);
                    const emb = pp.filter(x => esAbordado(x.estado)).length;
                    return (
                      <div
                        key={p.id}
                        style={{
                          background: esActual ? "var(--c-navy-tint)" : "var(--c-surface)",
                          border: esActual ? "2px solid var(--c-navy)" : "1px solid var(--c-line)",
                          borderRadius: 14, padding: esActual ? 16 : "12px 14px",
                          opacity: completada ? 0.7 : 1,
                          transition: "all 0.3s",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <div style={{
                            width: 32, height: 32, borderRadius: "50%",
                            background: completada ? "var(--c-navy)" : esActual ? "var(--c-coral)" : "var(--c-soft)",
                            border: esActual ? "3px solid #fff" : "none",
                            boxShadow: esActual ? "0 0 0 2px var(--c-coral)" : "none",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            flexShrink: 0, color: "#fff",
                          }}>
                            {completada
                              ? <IconCheck size={14} color="#fff" sw={2.5} />
                              : esActual
                                ? <IconPin size={14} color="#fff" sw={2.2} />
                                : <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700, color: "var(--c-mute-2)" }}>{i + 1}</span>}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{
                              margin: 0, fontSize: esActual ? 15 : 14,
                              fontWeight: esActual ? 800 : 700, letterSpacing: -0.2,
                              color: completada ? "var(--c-mute)" : "var(--c-ink)",
                              textDecoration: completada ? "line-through" : "none",
                            }}>
                              {p.nombre}
                            </p>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
                              {p.hora_estimada && (
                                <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: "var(--c-mute)", fontWeight: 600 }}>
                                  {p.hora_estimada.slice(0, 5)}
                                </span>
                              )}
                              {pp.length > 0 && (
                                <span style={{ fontSize: 11, color: "var(--c-mute)", fontWeight: 600 }}>
                                  {emb}/{pp.length} pasajeros
                                </span>
                              )}
                            </div>
                          </div>
                          {completada
                            ? <Chip color="var(--c-success)" bg="var(--c-success-tint)" sw>Hecho</Chip>
                            : esActual
                              ? <Chip color="var(--c-coral)" bg="var(--c-coral-tint)" sw>Actual</Chip>
                              : null}
                        </div>

                        {/* Panel parada actual */}
                        {esActual && (
                          <div style={{ marginTop: 14 }}>
                            {/* Navegación */}
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                              <button
                                onClick={() => abrirWaze(p)}
                                style={{
                                  padding: "11px 0", borderRadius: 12, border: "none",
                                  background: "#33CCFF", color: "#0b1b2e",
                                  fontFamily: FONT_SANS, fontWeight: 800, fontSize: 13, cursor: "pointer",
                                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                                }}
                              >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                                  <circle cx="12" cy="10" r="8" fill="#33CCFF" stroke="#0b1b2e" strokeWidth="1.5"/>
                                  <ellipse cx="12" cy="10" rx="5" ry="5" fill="white"/>
                                  <circle cx="10.2" cy="9" r="1.1" fill="#0b1b2e"/>
                                  <circle cx="13.8" cy="9" r="1.1" fill="#0b1b2e"/>
                                  <path d="M9.5 11.5 Q12 13.5 14.5 11.5" stroke="#0b1b2e" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
                                </svg>
                                Waze
                              </button>
                              <button
                                onClick={() => abrirGoogleMaps(p)}
                                style={{
                                  padding: "11px 0", borderRadius: 12, border: "1px solid var(--c-line)",
                                  background: "var(--c-surface)", color: "var(--c-ink)",
                                  fontFamily: FONT_SANS, fontWeight: 800, fontSize: 13, cursor: "pointer",
                                  display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                                }}
                              >
                                <svg width="14" height="16" viewBox="0 0 18 22" fill="none">
                                  <path d="M9 0C4.03 0 0 4.03 0 9c0 6.75 9 13 9 13s9-6.25 9-13c0-4.97-4.03-9-9-9z" fill="#EA4335"/>
                                  <circle cx="9" cy="9" r="3.5" fill="white"/>
                                </svg>
                                Maps
                              </button>
                            </div>

                            {pp.length > 0 && (
                              <div style={{
                                display: "flex", alignItems: "center", gap: 6,
                                marginBottom: 12, flexWrap: "wrap",
                              }}>
                                <Chip color="var(--c-success)" bg="var(--c-success-tint)" sw>
                                  {emb} A bordo
                                </Chip>
                                <Chip color="var(--c-warn)" bg="var(--c-warn-tint)" sw>
                                  {pp.filter(x => x.estado === "esperando").length} Esperando
                                </Chip>
                                <Chip color="var(--c-mute)" bg="var(--c-soft)" sw>
                                  {pp.filter(x => x.estado === "no_show").length} No show
                                </Chip>
                                <button
                                  onClick={() => setShowManifiesto(true)}
                                  style={{
                                    marginLeft: "auto", background: "none", border: "none",
                                    color: "var(--c-navy)", fontSize: 12, fontWeight: 700,
                                    cursor: "pointer", padding: "4px 0",
                                    fontFamily: FONT_SANS, textDecoration: "underline",
                                  }}
                                >
                                  Ver lista →
                                </button>
                              </div>
                            )}

                            {/* Indicador escáner BT — siempre activo cuando hay reserva */}
                            <div style={{
                              display: "flex", alignItems: "center", gap: 6,
                              marginBottom: 8, padding: "6px 10px",
                              borderRadius: 10, background: "var(--c-navy-tint, #EEF2FF)",
                              border: "1px solid rgba(37,99,235,0.18)",
                            }}>
                              <div style={{
                                width: 7, height: 7, borderRadius: "50%",
                                background: "#3B82F6", flexShrink: 0,
                                boxShadow: "0 0 0 2px rgba(59,130,246,0.25)",
                              }} />
                              <span style={{ fontSize: 11, fontWeight: 700, color: "#3B82F6", letterSpacing: 0.3 }}>
                                Escáner BT activo — apunta y dispara
                              </span>
                            </div>

                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                              <PrimaryBtn
                                onClick={() => setEscanear(true)}
                                icon={<IconScan size={16} color="#fff" />}
                              >
                                Cámara QR
                              </PrimaryBtn>
                              <SecondaryBtn
                                onClick={notificarRetraso}
                                disabled={notifEnviada}
                                icon={notifEnviada
                                  ? <IconCheck size={15} color="var(--c-success)" />
                                  : <IconClock size={15} color="var(--c-ink)" />
                                }
                              >
                                {notifEnviada ? "Notificado" : "Retraso"}
                              </SecondaryBtn>
                            </div>

                            <PrimaryBtn
                              onClick={() => marcarParadaCompletada(p.id)}
                              color={p.id === paradas[paradas.length - 1]?.id ? "var(--c-coral)" : "var(--c-navy)"}
                              icon={<IconCheck size={17} color="#fff" sw={2.5} />}
                              size="lg"
                            >
                              {p.id === paradas[paradas.length - 1]?.id ? "Marcar llegada · finalizar" : "Marcar llegada"}
                            </PrimaryBtn>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Reportar incidencia */}
                <button
                  onClick={() => setShowIncidencia(true)}
                  style={{
                    width: "100%", padding: "13px 0", borderRadius: 14,
                    background: "var(--c-warn-tint)", border: "1px solid var(--c-warn)",
                    color: "var(--c-warn)", fontFamily: FONT_SANS, fontWeight: 800, fontSize: 14,
                    cursor: "pointer", marginBottom: 10,
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                  }}
                >
                  <IconAlert size={16} color="var(--c-warn)" />
                  Reportar incidencia
                </button>

                {/* SOS */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ position: "relative", overflow: "hidden", borderRadius: 16 }}>
                    {sosActivo && (
                      <div style={{
                        position: "absolute", top: 0, left: 0, height: "100%",
                        background: "rgba(0,0,0,0.3)", width: `${sosPct}%`, zIndex: 1, borderRadius: 16,
                      }} />
                    )}
                    <button
                      onMouseDown={iniciarSOS} onMouseUp={cancelarSOS}
                      onTouchStart={iniciarSOS} onTouchEnd={cancelarSOS}
                      style={{
                        width: "100%", padding: "16px 0", borderRadius: 16, border: "none",
                        background: sosEnviado ? "var(--c-success)" : sosActivo ? "#7F1D1D" : "var(--c-danger)",
                        color: "#fff", fontFamily: FONT_SANS, fontSize: 15, fontWeight: 800,
                        cursor: "pointer", position: "relative", zIndex: 2,
                        boxShadow: sosActivo ? "0 0 30px rgba(220,38,38,0.7)" : "none",
                        transition: "background 0.2s",
                        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                      }}
                    >
                      <IconBell size={17} color="#fff" />
                      {sosEnviado ? "SOS enviado — Central notificada" : sosActivo ? `Mantén presionado… ${Math.round(sosPct)}%` : "Emergencia / SOS"}
                    </button>
                  </div>
                  {!sosActivo && !sosEnviado && (
                    <p style={{ textAlign: "center", color: "var(--c-mute)", fontSize: 11, marginTop: 6 }}>
                      Mantén presionado 2 segundos para activar
                    </p>
                  )}
                </div>

                {/* Terminar anticipadamente — solo cuando NO es la última parada */}
                {!esUltimaParada && (
                  <SecondaryBtn
                    onClick={() => setShowFinViaje(true)}
                    icon={<IconStop size={14} color="var(--c-danger)" />}
                    style={{ borderColor: "var(--c-danger)", color: "var(--c-danger)" }}
                  >
                    Terminar anticipadamente
                  </SecondaryBtn>
                )}
              </>
            )}
          </section>
        )}

        {/* ═══ CHECKLIST (PRE-VIAJE) ═══ */}
        {tab === "checklist" && (
          <section style={{ padding: "16px 18px 0" }}>
            <button
              onClick={() => setTab("ruta")}
              style={{
                background: "none", border: "none", padding: 0, cursor: "pointer",
                display: "inline-flex", alignItems: "center", gap: 6,
                color: "var(--c-mute)", fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600,
                marginBottom: 8,
              }}
            >
              <IconArrowLeft size={14} color="var(--c-mute)" />
              Hoy
            </button>
            <Eyebrow>Inspección inicial · inicio de jornada</Eyebrow>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4, marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: -1 }}>
                Check-in
              </h2>
              <Chip
                color={checkPct === 100 ? "var(--c-success)" : "var(--c-navy)"}
                bg={checkPct === 100 ? "var(--c-success-tint)" : "var(--c-navy-tint)"}
                mono sw
              >
                {checks.filter(c => c.ok !== null).length}/{checks.length} · {checkPct}%
              </Chip>
            </div>

            {checkDone ? (
              <div style={{
                background: "var(--c-success-tint)", border: "1px solid var(--c-success)",
                borderRadius: 18, padding: 28, textAlign: "center",
              }}>
                <div style={{
                  width: 72, height: 72, borderRadius: 22,
                  background: "#fff",
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  marginBottom: 14,
                }}>
                  <IconCheck size={36} color="var(--c-success)" sw={2.5} />
                </div>
                <p style={{ margin: 0, fontWeight: 800, fontSize: 18, letterSpacing: -0.4 }}>
                  Check-in completado
                </p>
                <p style={{ margin: "6px 0 18px", color: "var(--c-mute)", fontSize: 13 }}>
                  La unidad fue inspeccionada y reportada al ERP.
                </p>
                <SecondaryBtn
                  onClick={() => { setCheckDone(false); setChecks(CHECKLIST_ITEMS.map(i => ({ ...i }))); setFotoCheckin(null); setKmInicio(""); }}
                  icon={<IconRefresh size={15} color="var(--c-ink)" />}
                  full={false}
                >
                  Hacer nuevo
                </SecondaryBtn>
              </div>
            ) : (
              <>
                <div style={{
                  background: "var(--c-surface)", border: "1px solid var(--c-line)",
                  borderRadius: 16, padding: 14, marginBottom: 12,
                }}>
                  <Eyebrow>Vehículo y kilometraje</Eyebrow>
                  <select
                    value={vehiculoId || ""}
                    onChange={e => setVehiculoId(Number(e.target.value) || null)}
                    style={{
                      width: "100%", marginTop: 8, padding: "12px 14px",
                      borderRadius: 12, border: "1.5px solid var(--c-line)",
                      fontFamily: FONT_SANS, fontSize: 13, fontWeight: 700,
                      color: "var(--c-ink)", background: "var(--c-surface)",
                      outline: "none", boxSizing: "border-box",
                    }}
                  >
                    <option value="">Seleccionar vehículo…</option>
                    {vehiculos.map(v => <option key={v.id} value={v.id}>{v.placa} — {v.categoria}</option>)}
                  </select>
                  <div style={{ marginTop: 10 }}>
                    {renderCapturaOdometro("checkin")}
                  </div>
                </div>

                {/* Barra progreso */}
                <div style={{
                  background: "var(--c-surface)", border: "1px solid var(--c-line)",
                  borderRadius: 14, padding: "12px 14px", marginBottom: 12,
                }}>
                  <div style={{ height: 6, background: "var(--c-line-2)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${checkPct}%`,
                      background: checkFallas > 0 ? "var(--c-warn)" : "var(--c-navy)",
                      borderRadius: 3, transition: "width 0.3s",
                    }} />
                  </div>
                  {checkFallas > 0 && (
                    <p style={{ margin: "8px 0 0", color: "var(--c-danger)", fontWeight: 700, fontSize: 12 }}>
                      {checkFallas} falla{checkFallas > 1 ? "s" : ""} detectada{checkFallas > 1 ? "s" : ""}
                    </p>
                  )}
                </div>

                {/* Ítems por categoría */}
                {categorias.map(cat => (
                  <div
                    key={cat}
                    style={{
                      background: "var(--c-surface)", border: "1px solid var(--c-line)",
                      borderRadius: 16, padding: "12px 14px", marginBottom: 10,
                    }}
                  >
                    <Eyebrow style={{ marginBottom: 8 }}>{cat}</Eyebrow>
                    {checks.filter(c => c.categoria === cat).map(item => (
                      <div
                        key={item.id}
                        style={{
                          display: "flex", alignItems: "center", gap: 10,
                          padding: "10px 0", borderBottom: "1px solid var(--c-line-2)",
                        }}
                      >
                        <p style={{ flex: 1, margin: 0, fontSize: 13, color: "var(--c-ink-2)", fontWeight: 500 }}>
                          {item.label}
                        </p>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            onClick={() => setChecks(prev => prev.map(c => c.id === item.id ? { ...c, ok: true } : c))}
                            style={{
                              width: 34, height: 34, borderRadius: 10, border: "none", cursor: "pointer",
                              background: item.ok === true ? "var(--c-success)" : "var(--c-soft)",
                              color: item.ok === true ? "#fff" : "var(--c-mute)",
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}
                            title="OK"
                          >
                            <IconCheck size={16} color={item.ok === true ? "#fff" : "var(--c-mute)"} sw={2.5} />
                          </button>
                          <button
                            onClick={() => setChecks(prev => prev.map(c => c.id === item.id ? { ...c, ok: false } : c))}
                            style={{
                              width: 34, height: 34, borderRadius: 10, border: "none", cursor: "pointer",
                              background: item.ok === false ? "var(--c-danger)" : "var(--c-soft)",
                              color: item.ok === false ? "#fff" : "var(--c-mute)",
                              display: "flex", alignItems: "center", justifyContent: "center",
                            }}
                            title="Falla"
                          >
                            <IconClose size={15} color={item.ok === false ? "#fff" : "var(--c-mute)"} sw={2.5} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}

                {checkFallas > 0 && (
                  <textarea
                    rows={3} value={checkObs}
                    placeholder="Describe las fallas detectadas…"
                    onChange={e => setCheckObs(e.target.value)}
                    style={{
                      width: "100%", marginBottom: 12, padding: 14, borderRadius: 14,
                      border: "1.5px solid var(--c-danger)",
                      fontFamily: FONT_SANS, fontSize: 13, color: "var(--c-ink)",
                      background: "var(--c-surface)", resize: "none", outline: "none",
                      boxSizing: "border-box",
                    }}
                  />
                )}

                <PrimaryBtn
                  onClick={guardarChecklist}
                  disabled={checkSaving}
                  icon={<IconCheck size={17} color="#fff" sw={2.5} />}
                  size="lg"
                >
                  {checkSaving ? "Guardando…" : "Iniciar viaje"}
                </PrimaryBtn>
              </>
            )}
          </section>
        )}

        {/* ═══ DOCUMENTOS ═══ */}
        {tab === "documentos" && (
          <section style={{ padding: "16px 18px 0" }}>
            <Eyebrow>Mis documentos</Eyebrow>
            <h2 style={{ margin: "4px 0 16px", fontSize: 28, fontWeight: 800, letterSpacing: -1 }}>
              Vigencia
            </h2>

            <div style={{
              background: "var(--c-surface)", border: "1px solid var(--c-line)",
              borderRadius: 16, padding: "12px 14px", marginBottom: 12,
            }}>
              <Eyebrow>Estado actual</Eyebrow>
              {[
                { label: "Licencia MTC",   icon: IconKey,     fecha: conductor.vencimiento_licencia || null },
                { label: "SCTR Salud",     icon: IconShield,  fecha: conductor.sctr_salud_venc || null },
                { label: "Examen médico",  icon: IconReceipt, fecha: conductor.examen_medico_venc || null },
              ].map(d => {
                const est = docEstado(d.fecha);
                const dias = diasPara(d.fecha);
                const cfg = {
                  ok:      { color: "var(--c-success)", bg: "var(--c-success-tint)", txt: dias !== null ? `${dias}d` : "OK" },
                  pronto:  { color: "var(--c-warn)",    bg: "var(--c-warn-tint)",    txt: `${dias}d` },
                  vencido: { color: "var(--c-danger)",  bg: "var(--c-danger-tint)",  txt: "Vencida" },
                  sin:     { color: "var(--c-mute)",    bg: "var(--c-soft)",         txt: "Sin fecha" },
                }[est];
                const Ico = d.icon;
                return (
                  <div
                    key={d.label}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "10px 0", borderBottom: "1px solid var(--c-line-2)",
                    }}
                  >
                    <div style={{
                      width: 36, height: 36, borderRadius: 12,
                      background: cfg.bg, color: cfg.color,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0,
                    }}>
                      <Ico size={18} color={cfg.color} />
                    </div>
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--c-ink-2)" }}>
                      {d.label}
                    </span>
                    <Chip color={cfg.color} bg={cfg.bg} sw>{cfg.txt}</Chip>
                  </div>
                );
              })}
            </div>

            <div style={{
              background: "var(--c-surface)", border: "1px solid var(--c-line)",
              borderRadius: 16, padding: 14, marginBottom: 12,
            }}>
              <Eyebrow>Registrar documento (URL)</Eyebrow>
              <select
                value={docTipo} onChange={e => setDocTipo(e.target.value)}
                style={{
                  width: "100%", marginTop: 8, padding: "12px 14px", borderRadius: 12,
                  border: "1.5px solid var(--c-line)", fontSize: 13, color: "var(--c-ink)",
                  outline: "none", boxSizing: "border-box", fontFamily: FONT_SANS, fontWeight: 600,
                }}
              >
                {TIPOS_DOC.map(t => <option key={t}>{t}</option>)}
              </select>
              <input
                placeholder="URL del documento (Drive, Dropbox…)" value={docUrl}
                onChange={e => setDocUrl(e.target.value)}
                style={{
                  width: "100%", marginTop: 8, padding: "12px 14px", borderRadius: 12,
                  border: "1.5px solid var(--c-line)", fontSize: 13, color: "var(--c-ink)",
                  outline: "none", boxSizing: "border-box", fontFamily: FONT_SANS,
                }}
              />
              <input
                type="date" value={docVenc} onChange={e => setDocVenc(e.target.value)}
                style={{
                  width: "100%", marginTop: 8, padding: "12px 14px", borderRadius: 12,
                  border: "1.5px solid var(--c-line)", fontFamily: FONT_MONO, fontSize: 13,
                  color: "var(--c-ink)", outline: "none", boxSizing: "border-box", marginBottom: 10,
                }}
              />
              <PrimaryBtn
                onClick={subirDoc}
                disabled={docSaving}
                icon={<IconArrowRight size={15} color="#fff" />}
              >
                {docSaving ? "Guardando…" : "Registrar"}
              </PrimaryBtn>
            </div>

            {docs.map(d => (
              <div
                key={d.id}
                style={{
                  background: "var(--c-surface)", border: "1px solid var(--c-line)",
                  borderRadius: 14, padding: "12px 14px", marginBottom: 8,
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: -0.1 }}>{d.tipo}</p>
                  {d.vencimiento && (
                    <p style={{
                      margin: "2px 0 0", fontFamily: FONT_MONO, fontSize: 11, fontWeight: 600,
                      color: docEstado(d.vencimiento) === "vencido" ? "var(--c-danger)" : "var(--c-mute)",
                    }}>
                      Vence {new Date(d.vencimiento + "T00:00:00").toLocaleDateString("es-PE")}
                    </p>
                  )}
                </div>
                <a
                  href={d.url} target="_blank" rel="noreferrer"
                  style={{
                    padding: "6px 12px", borderRadius: 10, border: "1px solid var(--c-navy)",
                    color: "var(--c-navy)", fontSize: 12, fontWeight: 700, textDecoration: "none",
                    fontFamily: FONT_SANS,
                  }}
                >
                  Ver →
                </a>
              </div>
            ))}
          </section>
        )}

        {/* ═══ GASTOS (caja chica) ═══ */}
        {tab === "rendicion" && (
          <section style={{ padding: "16px 18px 0" }}>
            <Eyebrow>Caja chica</Eyebrow>
            <h2 style={{ margin: "4px 0 16px", fontSize: 28, fontWeight: 800, letterSpacing: -1 }}>
              Mis gastos
            </h2>

            {/* Rendición vencida: es lo que le impide recibir más dinero, así que va arriba de todo. */}
            {ccRendicion?.atrasada && (
              <div style={{
                background: "var(--c-danger-tint)", border: "1px solid var(--c-danger)",
                borderRadius: 14, padding: "12px 14px", marginBottom: 10,
                display: "flex", gap: 10, alignItems: "flex-start",
              }}>
                <IconCircleAlert size={18} color="var(--c-danger)" />
                <p style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: "var(--c-danger)", lineHeight: 1.45 }}>
                  Tu rendición venció hace {ccRendicion.dias_atraso} día{ccRendicion.dias_atraso === 1 ? "" : "s"}.
                  Envíala para que te puedan entregar más dinero.
                </p>
              </div>
            )}

            {ccCola > 0 && (
              <div style={{
                background: "var(--c-warn-tint)", border: "1px solid var(--c-warn)",
                borderRadius: 14, padding: "10px 14px", marginBottom: 10,
                display: "flex", gap: 9, alignItems: "center",
              }}>
                <IconRefresh size={16} color="var(--c-warn)" />
                <p style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: "var(--c-warn)" }}>
                  {ccCola} gasto{ccCola === 1 ? "" : "s"} sin enviar · se subirá{ccCola === 1 ? "" : "n"} solo{ccCola === 1 ? "" : "s"} al recuperar señal
                </p>
              </div>
            )}

            {ccAviso && (
              <div style={{
                background: "var(--c-success-tint)", border: "1px solid var(--c-success)",
                borderRadius: 14, padding: "10px 14px", marginBottom: 10,
              }}>
                <p style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: "var(--c-success)" }}>{ccAviso}</p>
              </div>
            )}

            {ccError && (
              <div style={{
                background: "var(--c-danger-tint)", border: "1px solid var(--c-danger)",
                borderRadius: 14, padding: "10px 14px", marginBottom: 10,
              }}>
                <p style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: "var(--c-danger)" }}>{ccError}</p>
              </div>
            )}

            {/* Estado de la rendición */}
            {ccCargando && !ccRendicion ? (
              <div style={{
                background: "var(--c-surface)", border: "1px solid var(--c-line)",
                borderRadius: 18, padding: "26px 16px", marginBottom: 12, textAlign: "center",
              }}>
                <div style={{ width: 26, height: 26, border: "3px solid var(--c-line)", borderTop: "3px solid var(--c-navy)", borderRadius: "50%", animation: "spin 1s linear infinite", margin: "0 auto 10px" }} />
                <p style={{ margin: 0, fontSize: 13, color: "var(--c-mute)" }}>Cargando tu caja chica…</p>
              </div>
            ) : ccRendicion ? (
              <div style={{
                background: "var(--c-navy)", color: "#fff", borderRadius: 22,
                padding: 18, marginBottom: 12, position: "relative", overflow: "hidden",
                boxShadow: "0 14px 36px -14px rgba(11,49,95,0.5)",
              }}>
                <div style={{ position: "absolute", right: -14, top: -14, opacity: 0.08 }}>
                  <IconReceipt size={116} color="#fff" />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, position: "relative" }}>
                  <div>
                    <Eyebrow color="rgba(255,255,255,0.6)">Rendición</Eyebrow>
                    <p style={{ margin: "5px 0 0", fontFamily: FONT_MONO, fontSize: 17, fontWeight: 800, letterSpacing: 0.4 }}>
                      {ccRendicion.codigo ?? "En curso"}
                    </p>
                  </div>
                  <Chip color={configRendicion(ccRendicion.estado).color} bg={configRendicion(ccRendicion.estado).bg} sw>
                    {configRendicion(ccRendicion.estado).label}
                  </Chip>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 14, position: "relative" }}>
                  {[
                    { lbl: "Asignado", val: Number(ccRendicion.monto_asignado || 0), color: "#fff" },
                    { lbl: "Rendido",  val: Number(ccRendicion.monto_rendido || 0),  color: "#fff" },
                    // Saldo negativo = puso de su bolsillo. Se muestra en positivo bajo el rótulo
                    // "A tu favor": "saldo −S/ 40" no significa nada arriba de un bus.
                    { lbl: ccSaldo < 0 ? "A tu favor" : "Te queda", val: Math.abs(ccSaldo), color: ccSaldo < 0 ? "#86efac" : "#fff" },
                  ].map(k => (
                    <div key={k.lbl} style={{ background: "rgba(255,255,255,0.10)", borderRadius: 14, padding: "10px 11px" }}>
                      <p style={{ margin: 0, fontSize: 9.5, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "rgba(255,255,255,0.6)" }}>
                        {k.lbl}
                      </p>
                      <p style={{ margin: "4px 0 0", fontFamily: FONT_MONO, fontSize: 14, fontWeight: 800, color: k.color, letterSpacing: -0.2 }}>
                        {fmtMoneda(k.val, ccRendicion.moneda)}
                      </p>
                    </div>
                  ))}
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, position: "relative", flexWrap: "wrap" }}>
                  {ccRendicion.atrasada ? (
                    <Chip color="var(--c-danger)" bg="#fee2e2" sw>
                      Vencida hace {ccRendicion.dias_atraso} d
                    </Chip>
                  ) : ccDiasRendir === null ? (
                    <Chip color="#fff" bg="rgba(255,255,255,0.14)" sw>Sin fecha límite</Chip>
                  ) : (
                    <Chip color={ccDiasRendir <= 2 ? "var(--c-warn)" : "#fff"} bg={ccDiasRendir <= 2 ? "#fef9c3" : "rgba(255,255,255,0.14)"} sw>
                      {ccDiasRendir <= 0 ? "Vence hoy" : `Te quedan ${ccDiasRendir} día${ccDiasRendir === 1 ? "" : "s"}`}
                    </Chip>
                  )}
                  <Chip color="#fff" bg="rgba(255,255,255,0.14)" sw>
                    {ccRendicion.comprobantes} comprobante{ccRendicion.comprobantes === 1 ? "" : "s"}
                  </Chip>
                </div>

                {ccRendicion.motivo_observacion && (
                  <p style={{ margin: "12px 0 0", fontSize: 12, lineHeight: 1.45, color: "#fecaca", position: "relative" }}>
                    Observada: {ccRendicion.motivo_observacion}
                  </p>
                )}
              </div>
            ) : (
              <div style={{
                background: "var(--c-surface)", border: "1px solid var(--c-line)",
                borderRadius: 18, padding: "26px 18px", marginBottom: 12, textAlign: "center",
              }}>
                <p style={{ margin: "0 0 6px", fontSize: 30 }}>🧾</p>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: "var(--c-ink)" }}>Todavía no has rendido nada</p>
                <p style={{ margin: "5px 0 0", fontSize: 12.5, color: "var(--c-mute)", lineHeight: 1.45 }}>
                  Fotografía el peaje o el lavado apenas lo pagues. Tu rendición se abre sola con el primer gasto.
                </p>
              </div>
            )}

            <PrimaryBtn onClick={() => { setCcAviso(""); setCcForm(true); }} size="lg" icon={<IconCamera size={17} color="#fff" />}>
              Registrar gasto
            </PrimaryBtn>

            {ccAbierta && ccGastos.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <SecondaryBtn onClick={enviarRendicion} disabled={ccEnviando} icon={<IconArrowRight size={15} color="var(--c-navy)" />}>
                  {ccEnviando ? "Enviando…" : "Enviar a revisión"}
                </SecondaryBtn>
              </div>
            )}

            {/* Comprobantes del ciclo */}
            <div style={{ marginTop: 18 }}>
              <Eyebrow style={{ marginBottom: 8 }}>Comprobantes de este ciclo</Eyebrow>
              {ccGastos.length === 0 ? (
                <p style={{ margin: 0, fontSize: 12.5, color: "var(--c-mute)" }}>
                  Aún no hay comprobantes registrados.
                </p>
              ) : ccGastos.map(g => {
                const cat = configCategoriaCC(g.categoria);
                const rev = ESTADOS_REVISION[g.estado_revision] ?? ESTADOS_REVISION.pendiente;
                return (
                  <div key={g.id} style={{
                    background: "var(--c-surface)", border: "1px solid var(--c-line)",
                    borderRadius: 14, padding: "11px 13px", marginBottom: 8,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{
                        width: 38, height: 38, borderRadius: 12, background: cat.bg,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 18, flexShrink: 0,
                      }}>
                        {cat.emoji}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "var(--c-ink)", letterSpacing: -0.1 }}>
                          {cat.label}
                        </p>
                        <p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--c-mute)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {new Date(g.fecha + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit" })}
                          {g.descripcion ? ` · ${g.descripcion}` : ""}
                          {g.tipo_comprobante === "sin_comprobante" ? " · sin comprobante" : ""}
                        </p>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <p style={{ margin: 0, fontFamily: FONT_MONO, fontSize: 14, fontWeight: 800, color: "var(--c-ink)" }}>
                          {fmtMoneda(Number(g.monto || 0), g.moneda)}
                        </p>
                        <Chip color={rev.color} bg={rev.bg} sw style={{ marginTop: 4 }}>{rev.label}</Chip>
                      </div>
                    </div>
                    {g.estado_revision === "rechazado" && g.motivo_rechazo && (
                      <p style={{
                        margin: "9px 0 0", padding: "7px 10px", borderRadius: 10,
                        background: "var(--c-danger-tint)", color: "var(--c-danger)",
                        fontSize: 11.5, fontWeight: 600, lineHeight: 1.4,
                      }}>
                        Rechazado: {g.motivo_rechazo}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* ═══ PERFIL ═══ */}
        {tab === "perfil" && (
          <section style={{ padding: "16px 18px 0" }}>
            <Eyebrow>Mi cuenta</Eyebrow>
            <h2 style={{ margin: "4px 0 16px", fontSize: 28, fontWeight: 800, letterSpacing: -1 }}>
              Perfil
            </h2>

            {/* Tarjeta identidad navy */}
            <div style={{
              background: "var(--c-navy)", color: "#fff",
              borderRadius: 22, padding: 20, marginBottom: 14, position: "relative", overflow: "hidden",
              boxShadow: "0 14px 36px -14px rgba(11,49,95,0.5)",
            }}>
              <div style={{
                position: "absolute", right: -10, top: -10, opacity: 0.08,
              }}>
                <IconBus size={120} color="#fff" />
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 14, position: "relative" }}>
                <div style={{
                  width: 56, height: 56, borderRadius: 18,
                  background: "rgba(255,255,255,0.15)",
                  border: "1px solid rgba(255,255,255,0.18)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: FONT_SANS, fontWeight: 800, fontSize: 22, letterSpacing: -0.5,
                }}>
                  {ini(conductor.nombre)}
                </div>
                <div>
                  <p style={{ margin: 0, fontWeight: 800, fontSize: 19, letterSpacing: -0.4 }}>
                    {conductor.nombre}
                  </p>
                  <p style={{ margin: "4px 0 0", color: "rgba(255,255,255,0.65)", fontFamily: FONT_MONO, fontSize: 12, fontWeight: 600 }}>
                    DNI {conductor.dni}
                  </p>
                  {conductor.categoria_licencia && (
                    <Chip color="#fff" bg="rgba(255,255,255,0.14)" sw style={{ marginTop: 6 }}>
                      Cat. {conductor.categoria_licencia}
                    </Chip>
                  )}
                </div>
              </div>
            </div>

            {/* Stats sesión */}
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14,
            }}>
              {[
                { lbl: "Envíos GPS", val: String(totalEnvios), mono: true },
                { lbl: "Reservas",   val: String(reservasHoy.length), mono: true },
                { lbl: "Fecha",      val: debugFecha, mono: true, sm: true },
              ].map(s => (
                <div
                  key={s.lbl}
                  style={{
                    background: "var(--c-surface)", border: "1px solid var(--c-line)",
                    borderRadius: 14, padding: "10px 12px",
                  }}
                >
                  <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--c-mute)" }}>
                    {s.lbl}
                  </p>
                  <p style={{
                    margin: "4px 0 0",
                    fontFamily: s.mono ? FONT_MONO : FONT_SANS,
                    fontSize: s.sm ? 12 : 18, fontWeight: 800, letterSpacing: -0.3,
                    color: "var(--c-navy)",
                  }}>
                    {s.val}
                  </p>
                </div>
              ))}
            </div>

            {/* Notificaciones push */}
            <div style={{
              background: "var(--c-surface)", border: "1px solid var(--c-line)",
              borderRadius: 16, padding: 14, marginBottom: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 12,
                    background: "var(--c-navy-tint)", color: "var(--c-navy)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <IconBell size={18} color="var(--c-navy)" />
                  </div>
                  <div>
                    <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>Notificaciones</p>
                    <p style={{ margin: 0, fontSize: 11, color: "var(--c-muted)" }}>
                      {pushEstado === "activo"    ? "Activas en este dispositivo"
                       : pushEstado === "bloqueado" ? "Bloqueadas — actívalas en los ajustes del teléfono"
                       : !conductor?._token        ? "Vuelve a iniciar sesión para activarlas"
                       : "Recibe tus servicios al instante"}
                    </p>
                  </div>
                </div>
                {pushEstado !== "activo" && pushEstado !== "bloqueado" && conductor?._token && (
                  <button
                    onClick={activarNotificaciones}
                    style={{
                      background: "none", border: "none", cursor: "pointer",
                      color: "var(--c-navy)", fontWeight: 700, fontSize: 13, fontFamily: FONT_SANS,
                    }}
                  >
                    Activar
                  </button>
                )}
              </div>
            </div>

            {/* Cambiar PIN */}
            <div style={{
              background: "var(--c-surface)", border: "1px solid var(--c-line)",
              borderRadius: 16, padding: 14, marginBottom: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 12,
                    background: "var(--c-navy-tint)", color: "var(--c-navy)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <IconKey size={18} color="var(--c-navy)" />
                  </div>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>Cambiar PIN</p>
                </div>
                <button
                  onClick={() => setCamPin(v => !v)}
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    color: "var(--c-navy)", fontWeight: 700, fontSize: 13, fontFamily: FONT_SANS,
                  }}
                >
                  {camPin ? "Cancelar" : "Cambiar"}
                </button>
              </div>
              {camPin && (
                <div style={{ marginTop: 12 }}>
                  {["Nuevo PIN", "Confirmar PIN"].map((ph, i) => (
                    <input
                      key={i} type="password" inputMode="numeric" maxLength={4}
                      placeholder={ph}
                      value={i === 0 ? pinNuevo : pinConfirm}
                      onChange={e =>
                        i === 0
                          ? setPinNuevo(e.target.value.replace(/\D/g, "").slice(0, 4))
                          : setPinConfirm(e.target.value.replace(/\D/g, "").slice(0, 4))
                      }
                      style={{
                        width: "100%", padding: 12, borderRadius: 12, marginBottom: 8,
                        border: "1.5px solid var(--c-line)",
                        fontFamily: FONT_MONO, fontSize: 18, fontWeight: 700, letterSpacing: 6,
                        textAlign: "center",
                        color: "var(--c-ink)", outline: "none", boxSizing: "border-box",
                      }}
                    />
                  ))}
                  {pinMsg && (
                    <p style={{
                      color: pinMsg.toLowerCase().includes("pin cambiado") ? "var(--c-success)" : "var(--c-danger)",
                      fontWeight: 700, textAlign: "center", fontSize: 13, margin: "0 0 8px",
                    }}>
                      {pinMsg}
                    </p>
                  )}
                  <PrimaryBtn onClick={cambiarPin}>Guardar PIN</PrimaryBtn>
                </div>
              )}
            </div>

            {/* Soporte */}
            <div style={{
              background: "var(--c-surface)", border: "1px solid var(--c-line)",
              borderRadius: 16, padding: 4, marginBottom: 14, overflow: "hidden",
            }}>
              {[
                { icon: IconPhone, lbl: "Central",  val: "966 707 225",                href: "tel:966707225" },
                { icon: IconMail,  lbl: "Email",    val: "transporte@afatoursperu.com", href: "mailto:transporte@afatoursperu.com" },
              ].map((row, i, arr) => {
                const Ico = row.icon;
                return (
                  <a
                    key={row.lbl} href={row.href}
                    style={{
                      display: "flex", alignItems: "center", gap: 12,
                      padding: "12px 14px", textDecoration: "none",
                      borderBottom: i < arr.length - 1 ? "1px solid var(--c-line-2)" : "none",
                      color: "var(--c-ink)",
                    }}
                  >
                    <div style={{
                      width: 34, height: 34, borderRadius: 11,
                      background: "var(--c-navy-tint)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>
                      <Ico size={16} color="var(--c-navy)" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <p style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--c-mute)" }}>
                        {row.lbl}
                      </p>
                      <p style={{ margin: "2px 0 0", fontFamily: row.lbl === "Central" ? FONT_MONO : FONT_SANS, fontSize: 14, fontWeight: 700 }}>
                        {row.val}
                      </p>
                    </div>
                    <IconChevronRight size={16} color="var(--c-mute-2)" />
                  </a>
                );
              })}
            </div>

            <button
              onClick={cerrarSesion}
              style={{
                width: "100%", padding: "13px 0", borderRadius: 14,
                background: "var(--c-danger-tint)", border: "1px solid var(--c-danger)",
                color: "var(--c-danger)", fontFamily: FONT_SANS, fontWeight: 800, fontSize: 14,
                cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              }}
            >
              <IconLogout size={16} color="var(--c-danger)" />
              Cerrar sesión
            </button>
          </section>
        )}
      </main>

      <TabBar
        tabs={TABS}
        active={tab}
        onChange={(t) => { setTab(t); if (t === "rendicion") void cargarCajaChica(); }}
      />

      {/* Divulgación destacada de ubicación en segundo plano (Google Play) */}
      {mostrarDivulgacion && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 130, background: "rgba(11,49,95,0.6)",
          display: "flex", alignItems: "flex-end", justifyContent: "center", padding: 16,
        }}>
          <div style={{
            background: "var(--c-surface)", borderRadius: 20, padding: 22,
            maxWidth: 420, width: "100%", boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <IconPin size={22} color="var(--c-navy)" />
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: -0.4 }}>Uso de tu ubicación</h2>
            </div>
            <p style={{ margin: "0 0 10px", fontSize: 14, lineHeight: 1.5, color: "var(--c-ink)" }}>
              AFA Conductores comparte tu ubicación <strong>en segundo plano</strong>, incluso con la app
              cerrada o la pantalla bloqueada, cuando te <strong>conectas</strong> o tienes un{" "}
              <strong>servicio activo</strong>: la central te asigna y guía servicios, y los pasajeros
              ven el ETA del bus.
            </p>
            <p style={{ margin: "0 0 16px", fontSize: 13, lineHeight: 1.5, color: "var(--c-mute)" }}>
              Solo se comparte mientras estás conectado o en servicio, siempre con una notificación
              visible. Tú decides cuándo: desconéctate o cierra sesión para dejar de compartir. En la
              siguiente pantalla selecciona <strong>Permitir todo el tiempo</strong>.
            </p>
            <button
              onClick={async () => {
                try { localStorage.setItem("afa_bg_disclosure_v1", "1"); } catch {}
                setMostrarDivulgacion(false);
                // Pedir permiso AQUÍ — diálogo Android aparece DESPUÉS de nuestro
                // aviso, cumpliendo el requisito de Google Play.
                await pedirPermisoUbicacion().catch(() => {});
                // "Permitir TODO EL TIEMPO" NATIVO (APK 29+): tras conceder 1er plano, Android
                // 11+ abre la pantalla del sistema con esa opción — exactamente lo que anuncia
                // el texto de esta divulgación ("En la siguiente pantalla selecciona..."). En
                // APK viejo el método no existe → devuelve false y NO se marca (para que se
                // dispare al conectar cuando actualicen la app).
                try {
                  if (await pedirUbicacionTodoElTiempo()) localStorage.setItem("afa_bg_loc_pedido_v1", "1");
                } catch {}
                setGpsHabilitado(true);
                // Tras conceder el permiso, evaluar si hace falta la guía (según exención real).
                evaluarAjustesGps();
              }}
              style={{
                width: "100%", padding: "13px 0", borderRadius: 14, border: "none",
                background: "var(--c-navy)", color: "#fff", fontWeight: 800, fontSize: 15,
                cursor: "pointer", fontFamily: FONT_SANS,
              }}
            >
              Entendido, continuar
            </button>
          </div>
        </div>
      )}

      {/* GPS ATASCADO: el equipo repite el mismo fix pese a 2 re-arms → el atasco está en el motor
          de ubicación del teléfono (GMS) y solo lo destraba el propio equipo. Apagar y encender la
          Ubicación lo reinicia SIN reiniciar el celular. Fijo sobre la TabBar (se ve en cualquier
          pestaña durante el viaje); se auto-oculta apenas llega un fix que avanza (registrarFix). */}
      {gpsAtascado && compartiendo && (
        <div style={{
          position: "fixed", left: 12, right: 12, bottom: 80, zIndex: 120,
          background: "var(--c-warn-tint)", border: "1.5px solid var(--c-warn)",
          borderRadius: 16, padding: "12px 14px", boxShadow: "0 10px 30px rgba(0,0,0,0.25)",
          fontFamily: FONT_SANS,
        }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <IconCircleAlert size={20} color="var(--c-warn)" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontSize: 13.5, fontWeight: 800, color: "var(--c-warn)" }}>
                GPS del equipo atascado
              </p>
              <p style={{ margin: "3px 0 0", fontSize: 12.5, lineHeight: 1.45, color: "var(--c-ink)" }}>
                El teléfono repite la misma ubicación. <strong>1)</strong> Apaga y enciende la{" "}
                <strong>Ubicación</strong> (barra de ajustes rápidos). <strong>2)</strong> Si en 2-3
                minutos sigue igual, <strong>reinicia el celular</strong> — la central te ve detenido
                aunque estés en ruta.
              </p>
            </div>
          </div>
          <button
            onClick={() => abrirAjustesUbicacion()}
            style={{
              width: "100%", marginTop: 10, padding: "10px 0", borderRadius: 11, border: "none",
              background: "var(--c-warn)", color: "#fff", fontWeight: 800, fontSize: 13,
              cursor: "pointer", fontFamily: FONT_SANS,
            }}
          >
            Abrir ajustes de ubicación
          </button>
        </div>
      )}

      {/* NUDGE DE AUTO-LLEGADA: recordatorio DENTRO del app (además de la notificación
          del SO). "suave" = estás en el paradero · "fuerte" = te alejaste sin marcar.
          Un toque marca la llegada (con la hora real de entrada). */}
      {nudgeLlegada && enRuta && (() => {
        const fuerte = nudgeLlegada.tipo === "fuerte";
        const col  = fuerte ? "var(--c-warn)" : "var(--c-navy)";
        const tint = fuerte ? "var(--c-warn-tint)" : "var(--c-navy-tint)";
        return (
          <div style={{
            position: "fixed", left: 12, right: 12, bottom: 80, zIndex: 130,
            background: tint, border: `1.5px solid ${col}`,
            borderRadius: 16, padding: "14px 16px", boxShadow: "0 10px 30px rgba(0,0,0,0.28)",
            fontFamily: FONT_SANS, animation: "sheetIn 0.22s ease-out",
          }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <IconPin size={20} color={col} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color: col }}>
                  {fuerte ? "¿Llegaste a tu paradero?" : `Estás en ${nudgeLlegada.nombre}`}
                </p>
                <p style={{ margin: "3px 0 0", fontSize: 12.5, lineHeight: 1.45, color: "var(--c-ink)" }}>
                  {fuerte
                    ? <>Ya te alejaste de <strong>{nudgeLlegada.nombre}</strong> sin marcar. Regístralo para no perder la hora real de llegada.</>
                    : <>Marca tu llegada a <strong>{nudgeLlegada.nombre}</strong> cuando termines de embarcar.</>}
                </p>
              </div>
              <button onClick={() => setNudgeLlegada(null)} aria-label="Descartar"
                style={{ background: "none", border: "none", color: "var(--c-mute)", cursor: "pointer", padding: 2, flexShrink: 0 }}>
                <IconClose size={18} />
              </button>
            </div>
            <button
              onClick={() => marcarParadaCompletada(nudgeLlegada.paradaId, { viaNudge: true })}
              style={{
                width: "100%", marginTop: 10, padding: "11px 0", borderRadius: 11, border: "none",
                background: col, color: "#fff", fontWeight: 800, fontSize: 13.5,
                cursor: "pointer", fontFamily: FONT_SANS,
              }}
            >
              Marcar llegada
            </button>
          </div>
        );
      })()}

      {/* DESHACER: tras marcar por el nudge, por si fue por error (se auto-oculta ~30 s). */}
      {deshacerLlegada && (
        <div style={{
          position: "fixed", left: 12, right: 12, bottom: 80, zIndex: 131,
          background: "var(--c-ink)", color: "#fff", borderRadius: 14, padding: "12px 14px",
          boxShadow: "0 10px 30px rgba(0,0,0,0.3)", fontFamily: FONT_SANS,
          display: "flex", alignItems: "center", gap: 12, animation: "sheetIn 0.2s ease-out",
        }}>
          <IconCheck size={18} color="#fff" sw={2.5} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>
            Llegada a {deshacerLlegada.nombre} registrada
          </span>
          <button onClick={() => deshacerUltimaLlegada()}
            style={{ background: "rgba(255,255,255,0.16)", border: "none", color: "#fff", fontWeight: 800, fontSize: 13, borderRadius: 9, padding: "7px 14px", cursor: "pointer", fontFamily: FONT_SANS }}>
            Deshacer
          </button>
        </div>
      )}

      {/* Gate FUERTE-SUAVE de precisión: interrumpe el inicio del servicio si el permiso quedó en
          APROXIMADO. Empuja a activar preciso, pero con válvula de escape ("Iniciar de todos modos")
          para no dejar varado a nadie (p.ej. ROM que reporta mal / conductor que no puede activarlo). */}
      {gatePrecision && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 140, background: "rgba(11,49,95,0.72)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
        }}>
          <div style={{
            background: "var(--c-surface)", borderRadius: 20, padding: 24, maxWidth: 400, width: "100%",
            boxShadow: "0 20px 60px rgba(0,0,0,0.4)", textAlign: "center",
          }}>
            <div style={{
              width: 56, height: 56, borderRadius: 16, margin: "0 auto 14px",
              display: "flex", alignItems: "center", justifyContent: "center", background: "var(--c-warn-tint)",
            }}>
              <IconNav size={28} color="var(--c-warn)" />
            </div>
            <h2 style={{ margin: "0 0 8px", fontSize: 19, fontWeight: 800, letterSpacing: -0.4 }}>
              Activa tu ubicación precisa
            </h2>
            <p style={{ margin: "0 0 20px", fontSize: 14, lineHeight: 1.55, color: "var(--c-mute)" }}>
              Tu ubicación está en modo <strong style={{ color: "var(--c-warn)" }}>aproximado</strong>. El
              rastreo saldría a <strong>±150 m</strong> toda la ruta y marcaría posiciones falsas a la
              central y a los pasajeros. Actívala en <strong>Preciso</strong> antes de iniciar.
            </p>
            <button
              onClick={async () => {
                const reserva = gatePrecision;
                if (!reserva) return;
                const { ok, pendiente } = await asegurarUbicacionOptima();
                if (ok) { setGatePrecision(null); iniciarRecorrido(reserva, true); }
                // Si el diálogo del sistema quedó abierto, NO abrir Ajustes encima: al volver
                // a la app el efecto de visibilitychange comprueba el resultado y arranca.
                else if (!pendiente) abrirAjustesUbicacion();
              }}
              style={{
                width: "100%", padding: "14px 0", borderRadius: 14, border: "none",
                background: "var(--c-navy)", color: "#fff", fontWeight: 800, fontSize: 15,
                cursor: "pointer", fontFamily: FONT_SANS, marginBottom: 10,
              }}
            >
              Activar ubicación precisa
            </button>
            <button
              onClick={() => { const reserva = gatePrecision; if (!reserva) return; setGatePrecision(null); iniciarRecorrido(reserva, true); }}
              style={{
                width: "100%", padding: "10px 0", borderRadius: 12, border: "none",
                background: "transparent", color: "var(--c-mute)", fontWeight: 700, fontSize: 13,
                cursor: "pointer", fontFamily: FONT_SANS,
              }}
            >
              Iniciar de todos modos
            </button>
          </div>
        </div>
      )}

      {/* Paso de onboarding: exención de batería con diálogo NATIVO (APK 28+, 1ª vez).
          Encadenado tras el permiso de ubicación → se siente como un permiso más. */}
      {pasoBateria && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 131, background: "rgba(11,49,95,0.6)",
          display: "flex", alignItems: "flex-end", justifyContent: "center", padding: 16,
        }}>
          <div style={{
            background: "var(--c-surface)", borderRadius: 20, padding: 22,
            maxWidth: 440, width: "100%", boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 22 }}>🔋</span>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: -0.4 }}>
                Un último permiso
              </h2>
            </div>
            <p style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.5, color: "var(--c-mute)" }}>
              Para que el rastreo <strong>no se corte</strong> con la pantalla bloqueada o con Waze
              encima, Android te va a preguntar si permites que la app siga activa. Toca{" "}
              <strong>Permitir</strong> en el aviso del sistema.
            </p>
            <button
              onClick={async () => {
                try { localStorage.setItem("afa_bat_paso_v1", "1"); } catch {}
                setPasoBateria(false);
                // Dispara el diálogo NATIVO del sistema (política Play: tras acción del usuario).
                await solicitarExencionBateria();
                // Al volver del diálogo, refrescar el estado real (si concedió → exento y la
                // guía no volverá a aparecer nunca).
                try { setExentaBat(await bateriaExenta()); } catch {}
              }}
              style={{
                width: "100%", padding: "13px 14px", borderRadius: 12,
                border: "none", background: "var(--c-success, #1f9d55)",
                color: "#fff", fontWeight: 800, fontSize: 14,
                cursor: "pointer", fontFamily: FONT_SANS,
              }}
            >
              🔋 Activar ahora
            </button>
            <button
              onClick={() => {
                try { localStorage.setItem("afa_bat_paso_v1", "1"); } catch {}
                setPasoBateria(false);
              }}
              style={{
                width: "100%", marginTop: 10, padding: "11px 0", borderRadius: 12, border: "none",
                background: "transparent", color: "var(--c-mute)", fontWeight: 700, fontSize: 13,
                cursor: "pointer", fontFamily: FONT_SANS,
              }}
            >
              Ahora no
            </button>
          </div>
        </div>
      )}

      {/* Guía de ajustes del equipo para que el fabricante no corte el rastreo */}
      {mostrarAjustesGps && (() => {
        const fab = detectarFabricanteGps();
        const guia = GUIA_AJUSTES_GPS[fab] ?? GUIA_AJUSTES_GPS.generico;
        // OEM agresivos: el 1-toque de batería NO basta (también piden inicio automático, etc.)
        // → los pasos van expandidos. En el resto, el 1-toque resuelve → pasos colapsados.
        const agresivo = ["xiaomi", "oppo", "vivo", "realme", "huawei"].includes(fab);
        const mostrarPasos = verPasosGps || agresivo;
        const cerrar = () => {
          try { localStorage.setItem("afa_gps_ajustes_v1", "1"); localStorage.removeItem("afa_gps_corte_pendiente"); } catch {}
          setCortePendiente(false);
          setMostrarAjustesGps(false);
        };
        return (
          <div style={{
            position: "fixed", inset: 0, zIndex: 131, background: "rgba(11,49,95,0.6)",
            display: "flex", alignItems: "flex-end", justifyContent: "center", padding: 16,
          }}>
            <div style={{
              background: "var(--c-surface)", borderRadius: 20, padding: 22,
              maxWidth: 440, width: "100%", maxHeight: "88vh", overflowY: "auto",
              boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 22 }}>{cortePendiente ? "⚠️" : "⚙️"}</span>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: -0.4 }}>
                  {cortePendiente ? "El GPS se cortó en el viaje" : "Que NO se corte el rastreo"}
                </h2>
              </div>
              <p style={{ margin: "0 0 14px", fontSize: 13, lineHeight: 1.5, color: "var(--c-mute)" }}>
                {cortePendiente
                  ? <>Tu equipo (<strong>{guia.marca}</strong>) cerró la app en segundo plano y se perdió el rastreo. Protégelo con <strong>un toque</strong> para que no se vuelva a cortar:</>
                  : <>Tu equipo (<strong>{guia.marca}</strong>) puede cerrar la app en segundo plano y cortar el GPS. Protégelo con <strong>un toque</strong>:</>}
              </p>

              {/* Tres concerns. Precisión (Fila 0) y batería (Fila 1) tienen ESTADO real legible
                  (precisión por JS vía @capacitor/geolocation; batería por el plugin nativo) → pill
                  semáforo. La ubicación "todo el tiempo" (Fila 2) es ACCIÓN: su estado NO es legible
                  con los plugins actuales (haría falta un método nativo → APK nuevo), así que no
                  pintamos un check que no podemos verificar. */}

              {/* Fila 0 — Precisión de la ubicación. En APROXIMADA cada fix sale a ±150 m (lo más
                  impactante), por eso va primero. Solo se muestra si el estado es legible. */}
              {precUbic !== "desconocida" && (
                <div style={{ border: "1px solid var(--c-line-2)", borderRadius: 12, padding: 12, marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: precUbic === "precisa" ? 0 : 8 }}>
                    <IconNav size={18} color="var(--c-mute)" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "var(--c-ink)" }}>Ubicación precisa</p>
                      <p style={{ margin: "1px 0 0", fontSize: 11, color: "var(--c-mute)" }}>GPS satelital, no aproximado por red</p>
                    </div>
                    <span style={{
                      flexShrink: 0, fontSize: 11, fontWeight: 800, borderRadius: 999, padding: "2px 10px",
                      color: precUbic === "precisa" ? "var(--c-success)" : "var(--c-warn)",
                      background: precUbic === "precisa" ? "var(--c-success-tint)" : "var(--c-warn-tint)",
                    }}>
                      {precUbic === "precisa" ? "Precisa" : "Aproximada"}
                    </span>
                  </div>
                  {precUbic === "aproximada" && (
                    <button
                      onClick={async () => {
                        const { ok, pendiente } = await asegurarUbicacionOptima();
                        if (!ok && !pendiente) abrirAjustesUbicacion();
                      }}
                      style={{
                        width: "100%", padding: "11px 14px", borderRadius: 10, border: "none",
                        background: "var(--c-success)", color: "#fff", fontWeight: 800, fontSize: 13.5,
                        cursor: "pointer", fontFamily: FONT_SANS,
                      }}
                    >
                      📍 Activar ubicación precisa
                    </button>
                  )}
                </div>
              )}

              {/* Fila 1 — Batería y autostart (no cerrar la app en segundo plano). */}
              <div style={{ border: "1px solid var(--c-line-2)", borderRadius: 12, padding: 12, marginBottom: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: exentaBat === true ? 0 : 8 }}>
                  <IconGauge size={18} color="var(--c-mute)" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "var(--c-ink)" }}>Batería y autostart</p>
                    <p style={{ margin: "1px 0 0", fontSize: 11, color: "var(--c-mute)" }}>No cerrar la app en segundo plano</p>
                  </div>
                  <span style={{
                    flexShrink: 0, fontSize: 11, fontWeight: 800, borderRadius: 999, padding: "2px 10px",
                    color: exentaBat === true ? "var(--c-success)" : exentaBat === false ? "var(--c-warn)" : "var(--c-mute)",
                    background: exentaBat === true ? "var(--c-success-tint)" : exentaBat === false ? "var(--c-warn-tint)" : "var(--c-paper)",
                  }}>
                    {exentaBat === true ? "Protegido" : exentaBat === false ? "Expuesto" : "—"}
                  </span>
                </div>
                {/* No exento (APK con plugin): exención en 1 toque, el camino que de verdad resuelve. */}
                {exentaBat === false && (
                  <button
                    onClick={() => solicitarExencionBateria()}
                    style={{
                      width: "100%", padding: "11px 14px", borderRadius: 10, border: "none",
                      background: "var(--c-success)", color: "#fff", fontWeight: 800, fontSize: 13.5,
                      cursor: "pointer", fontFamily: FONT_SANS,
                    }}
                  >
                    🔋 Proteger rastreo (1 toque)
                  </button>
                )}
                {/* APK viejo (sin plugin, exentaBat===null): el 1-toque no existe → ajustes de la app. */}
                {exentaBat === null && (
                  <button
                    onClick={() => abrirAjustesUbicacion()}
                    style={{
                      width: "100%", padding: "11px 14px", borderRadius: 10,
                      border: "1px solid var(--c-navy)", background: "transparent",
                      color: "var(--c-navy)", fontWeight: 800, fontSize: 13.5,
                      cursor: "pointer", fontFamily: FONT_SANS,
                    }}
                  >
                    Abrir ajustes de la app
                  </button>
                )}
              </div>

              {/* Fila 2 — Ubicación "todo el tiempo" (seguir rastreando con la pantalla bloqueada). */}
              <div style={{ border: "1px solid var(--c-line-2)", borderRadius: 12, padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <IconPin size={18} color="var(--c-mute)" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: "var(--c-ink)" }}>Ubicación: todo el tiempo</p>
                    <p style={{ margin: "1px 0 0", fontSize: 11, color: "var(--c-mute)" }}>Rastrear con la pantalla bloqueada</p>
                  </div>
                </div>
                <button
                  onClick={() => abrirAjustesUbicacion()}
                  style={{
                    width: "100%", padding: "11px 14px", borderRadius: 10,
                    border: "1px solid var(--c-navy)", background: "transparent",
                    color: "var(--c-navy)", fontWeight: 800, fontSize: 13.5,
                    cursor: "pointer", fontFamily: FONT_SANS,
                  }}
                >
                  Permitir todo el tiempo
                </button>
              </div>

              {/* Pasos manuales: expandidos en OEM agresivos; colapsados (tras "ver pasos") en el resto. */}
              {!mostrarPasos && (
                <button
                  onClick={() => setVerPasosGps(true)}
                  style={{
                    width: "100%", marginTop: 10, padding: "8px", borderRadius: 10, border: "none",
                    background: "transparent", color: "var(--c-mute)", fontWeight: 700, fontSize: 12,
                    cursor: "pointer", fontFamily: FONT_SANS, textDecoration: "underline",
                  }}
                >
                  ¿No funcionó? Ver pasos manuales
                </button>
              )}
              {mostrarPasos && (
                <ol style={{ margin: "14px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
                  {guia.pasos.map((p, i) => (
                    <li key={i} style={{
                      display: "flex", gap: 10, alignItems: "flex-start",
                      background: "var(--c-paper)", border: "1px solid var(--c-line-2)",
                      borderRadius: 12, padding: "10px 12px",
                    }}>
                      <span style={{
                        flexShrink: 0, width: 22, height: 22, borderRadius: 999, background: "var(--c-navy)",
                        color: "#fff", fontSize: 12, fontWeight: 800,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>{i + 1}</span>
                      <div style={{ minWidth: 0 }}>
                        <p style={{ margin: 0, fontSize: 13.5, fontWeight: 800, color: "var(--c-ink)" }}>{p.titulo}</p>
                        <p style={{ margin: "2px 0 0", fontSize: 12, lineHeight: 1.45, color: "var(--c-mute)" }}>{p.detalle}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              )}

              <button
                onClick={cerrar}
                style={{
                  width: "100%", marginTop: 14, padding: "13px 0", borderRadius: 14, border: "none",
                  background: "var(--c-navy)", color: "#fff", fontWeight: 800, fontSize: 15,
                  cursor: "pointer", fontFamily: FONT_SANS,
                }}
              >
                Entendido
              </button>
            </div>
          </div>
        );
      })()}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* MANIFIESTO SUB-VISTA                                                */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {showManifiesto && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 80,
          background: "var(--c-paper)", overflowY: "auto",
          fontFamily: FONT_SANS,
          maxWidth: 520, margin: "0 auto",
        }}>
          <header style={{
            position: "sticky", top: 0, background: "var(--c-paper)",
            padding: "16px 18px", borderBottom: "1px solid var(--c-line-2)",
            display: "flex", alignItems: "center", gap: 10, zIndex: 1,
          }}>
            <button
              onClick={() => setShowManifiesto(false)}
              style={{
                width: 36, height: 36, borderRadius: 12, border: "1px solid var(--c-line)",
                background: "var(--c-surface)", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <IconArrowLeft size={16} color="var(--c-ink)" />
            </button>
            <div style={{ flex: 1 }}>
              <Eyebrow>Manifiesto · {vehSel?.placa || "—"}</Eyebrow>
              <h2 style={{ margin: "2px 0 0", fontSize: 20, fontWeight: 800, letterSpacing: -0.6 }}>
                Pasajeros
              </h2>
            </div>
          </header>

          <div style={{ padding: "16px 18px 80px" }}>
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12,
            }}>
              {[
                { lbl: "Reservados", val: totalReservados, color: "var(--c-navy)",    bg: "var(--c-navy-tint)" },
                { lbl: "A bordo",    val: totalEmbarcados, color: "var(--c-success)", bg: "var(--c-success-tint)" },
                { lbl: "Esperando",  val: totalEsperando,  color: "var(--c-warn)",    bg: "var(--c-warn-tint)" },
                { lbl: "No show",    val: totalNoShow,     color: "var(--c-danger)",  bg: "var(--c-danger-tint)" },
              ].map(s => (
                <div key={s.lbl} style={{ background: s.bg, borderRadius: 14, padding: "10px 12px" }}>
                  <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: s.color }}>
                    {s.lbl}
                  </p>
                  <p style={{
                    margin: "4px 0 0", fontFamily: FONT_MONO, fontSize: 22, fontWeight: 800, letterSpacing: -0.5,
                    color: s.color,
                  }}>
                    {s.val}
                  </p>
                </div>
              ))}
            </div>

            {/* Bar ocupación */}
            <div style={{
              background: "var(--c-surface)", border: "1px solid var(--c-line)",
              borderRadius: 14, padding: "12px 14px", marginBottom: 14,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <Eyebrow>Ocupación</Eyebrow>
                <Chip color="var(--c-navy)" bg="var(--c-navy-tint)" mono sw>
                  {totalEmbarcados}/{totalReservados}
                </Chip>
              </div>
              <div style={{ height: 6, background: "var(--c-line-2)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  height: "100%",
                  width: `${totalReservados > 0 ? (totalEmbarcados / totalReservados) * 100 : 0}%`,
                  background: "linear-gradient(90deg, var(--c-navy), var(--c-success))",
                  borderRadius: 3, transition: "width 0.5s",
                }} />
              </div>
            </div>

            {/* Agrupado por parada */}
            {paradas.map((p, i) => {
              const ppList = pasajeros.filter(x => x.parada_id === p.id);
              if (ppList.length === 0) return null;
              const completada = p.estado === "completada";
              const esActual = i === paradaIdx;
              return (
                <div key={p.id} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                    <div style={{
                      width: 28, height: 28, borderRadius: "50%",
                      background: completada ? "var(--c-navy)" : esActual ? "var(--c-coral)" : "var(--c-soft)",
                      color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                      flexShrink: 0,
                    }}>
                      {completada
                        ? <IconCheck size={13} color="#fff" sw={2.5} />
                        : esActual
                          ? <IconPin size={13} color="#fff" />
                          : <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700, color: "var(--c-mute-2)" }}>{i + 1}</span>}
                    </div>
                    <p style={{ margin: 0, fontWeight: 800, fontSize: 14, letterSpacing: -0.2, flex: 1 }}>
                      {p.nombre}
                    </p>
                    {p.hora_estimada && (
                      <span style={{ fontFamily: FONT_MONO, fontSize: 12, color: "var(--c-mute)", fontWeight: 600 }}>
                        {p.hora_estimada.slice(0, 5)}
                      </span>
                    )}
                  </div>
                  <div style={{
                    background: "var(--c-surface)", border: "1px solid var(--c-line)",
                    borderRadius: 14, overflow: "hidden",
                  }}>
                    {ppList.map((x, idx) => {
                      const onBoard = esAbordado(x.estado);
                      const noShow = x.estado === "no_show";
                      return (
                        <div
                          key={x.id}
                          style={{
                            display: "flex", alignItems: "center", gap: 10,
                            padding: "10px 12px",
                            borderBottom: idx < ppList.length - 1 ? "1px solid var(--c-line-2)" : "none",
                          }}
                        >
                          <div style={{
                            width: 32, height: 32, borderRadius: 10,
                            background: onBoard ? "var(--c-success-tint)" : noShow ? "var(--c-danger-tint)" : "var(--c-soft)",
                            color: onBoard ? "var(--c-success)" : noShow ? "var(--c-danger)" : "var(--c-mute)",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            fontWeight: 800, fontSize: 12, flexShrink: 0,
                          }}>
                            {x.pasajero?.nombre ? ini(x.pasajero.nombre) : "?"}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: -0.1 }}>
                              {x.pasajero?.nombre || `Pasajero #${x.pasajero_id}`}
                            </p>
                            {x.pasajero?.empresa && (
                              <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--c-mute)" }}>
                                {x.pasajero.empresa}
                              </p>
                            )}
                          </div>
                          {x.pasajero?.dni && (
                            <span style={{ fontFamily: FONT_MONO, fontSize: 11, fontWeight: 700, color: "var(--c-mute)" }}>
                              {x.pasajero.dni}
                            </span>
                          )}
                          {onBoard
                            ? <Chip color="var(--c-success)" bg="var(--c-success-tint)" sw>A bordo</Chip>
                            : noShow
                              ? <Chip color="var(--c-danger)" bg="var(--c-danger-tint)" sw>No show</Chip>
                              : <Chip color="var(--c-warn)" bg="var(--c-warn-tint)" sw>Esperando</Chip>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* SCANNER QR (dark glass)                                             */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {escanear && (
        <div style={{ position: "fixed", inset: 0, zIndex: 100, background: "#000" }}>

          {/* ── CSS: fuerza el video de html5-qrcode a llenar pantalla completa ── */}
          <style>{`
            #qr-container,
            #qr-container > div { width: 100% !important; height: 100% !important; padding: 0 !important; border: none !important; }
            #qr-container video  { position: absolute !important; inset: 0 !important; width: 100% !important; height: 100% !important; object-fit: cover !important; display: block !important; }
            #qr-container canvas,
            #qr-container img    { display: none !important; }
            #qr-container span   { display: none !important; }
          `}</style>

          {/* Contenedor que html5-qrcode necesita — ocupa toda la pantalla */}
          <div id="qr-container" style={{ position: "absolute", inset: 0 }} />

          {/* ── Overlay: header ── */}
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0, zIndex: 2,
            padding: "52px 22px 20px",
            background: "linear-gradient(180deg, rgba(0,0,0,0.72) 60%, transparent)",
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <button
              onClick={() => setEscanear(false)}
              style={{
                width: 38, height: 38, borderRadius: 12, flexShrink: 0,
                background: "rgba(255,255,255,0.15)", border: "none", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <IconClose size={17} color="#fff" />
            </button>
            <div style={{ color: "#fff" }}>
              <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "rgba(255,255,255,0.55)" }}>
                {paradaActual ? `Parada ${paradaIdx + 1} · ${paradaActual.nombre}` : "Escanear"}
              </p>
              <p style={{ margin: "2px 0 0", fontWeight: 800, fontSize: 17, letterSpacing: -0.3 }}>
                Escanear pasajero
              </p>
            </div>
          </div>

          {/* ── Overlay: brackets decorativos en las 4 esquinas de la pantalla ── */}
          <div style={{ position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none" }}>
            {/* Esquina superior-izquierda */}
            <div style={{ position: "absolute", top: 90, left: 20, width: 48, height: 48, borderStyle: "solid", borderColor: "var(--c-coral)", borderWidth: 0, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 14 }} />
            {/* Esquina superior-derecha */}
            <div style={{ position: "absolute", top: 90, right: 20, width: 48, height: 48, borderStyle: "solid", borderColor: "var(--c-coral)", borderWidth: 0, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 14 }} />
            {/* Esquina inferior-izquierda */}
            <div style={{ position: "absolute", bottom: 110, left: 20, width: 48, height: 48, borderStyle: "solid", borderColor: "var(--c-coral)", borderWidth: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 14 }} />
            {/* Esquina inferior-derecha */}
            <div style={{ position: "absolute", bottom: 110, right: 20, width: 48, height: 48, borderStyle: "solid", borderColor: "var(--c-coral)", borderWidth: 0, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 14 }} />
            {/* Línea de escaneo a todo ancho */}
            <div style={{
              position: "absolute", left: 20, right: 20, height: 2,
              top: "50%", transform: "translateY(-50%)",
              background: "linear-gradient(90deg, transparent, var(--c-coral) 20%, var(--c-coral) 80%, transparent)",
              boxShadow: "0 0 20px var(--c-coral)",
              animation: "scanLine 2s ease-in-out infinite",
            }} />
          </div>

          {/* ── Overlay: footer ── */}
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 2,
            padding: "20px 22px 40px",
            background: "linear-gradient(0deg, rgba(0,0,0,0.72) 60%, transparent)",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
          }}>
            <p style={{ margin: 0, color: "rgba(255,255,255,0.75)", fontSize: 14, fontWeight: 500, textAlign: "center" }}>
              Apunta al QR del pasajero
            </p>
            <button
              onClick={() => setEscanear(false)}
              style={{
                padding: "13px 36px", borderRadius: 14,
                border: "1px solid rgba(255,255,255,0.22)",
                background: "rgba(255,255,255,0.10)", color: "#fff",
                fontFamily: FONT_SANS, fontWeight: 700, fontSize: 15, cursor: "pointer",
              }}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* TARJETA RESULTADO EMBARQUE (auto-dismiss 3 s, toca para cerrar)    */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {resultadoEmbarque && (() => {
        const { pasajero: p, fueraLista, otroBus, cambioParada, empresaAjena, paradaOriginalNombre, paradaEmbarqueNombre } = resultadoEmbarque;
        const color  = empresaAjena ? "var(--c-danger)"
          : (fueraLista || otroBus) ? "var(--c-warn)" : "var(--c-success)";
        const tint   = empresaAjena ? "var(--c-danger-tint)"
          : (fueraLista || otroBus) ? "var(--c-warn-tint)" : "var(--c-success-tint)";
        const titulo = empresaAjena
          ? "⛔ OTRA EMPRESA — REVISAR"
          : fueraLista
            ? "⚠️ EMBARCADO — FUERA DE LISTA"
            : otroBus
              ? "⚠️ EMBARCADO — CAMBIÓ DE BUS"
              : cambioParada ? "✅ EMBARCADO — CAMBIÓ DE PARADERO" : "✅ EMBARCADO";
        const sub    = empresaAjena
          ? `${p.empresa ?? "Otra empresa"} — no es de este servicio. Quedó registrado; avisar a oficina.`
          : fueraLista
            ? "No estaba asignado · registrado en este bus"
            : otroBus
              ? "Estaba en otro bus del mismo horario · movido aquí"
              : cambioParada
                ? `Subió aquí · asignado en ${paradaOriginalNombre ?? "otra parada"}`
                : "Embarque registrado correctamente";
        const cerrar = () => {
          if (resultIntervalRef.current) { clearInterval(resultIntervalRef.current); resultIntervalRef.current = null; }
          setResultadoEmbarque(null); setResultProgreso(0);
        };
        return (
          <div
            onClick={cerrar}
            style={{
              position: "fixed", inset: 0, zIndex: 120,
              background: "rgba(0,0,0,0.65)",
              display: "flex", alignItems: "flex-end", justifyContent: "center",
              animation: "sheetIn 0.22s ease-out",
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: "var(--c-paper)",
                borderRadius: "28px 28px 0 0",
                width: "100%", maxWidth: 520,
                overflow: "hidden",
                boxShadow: "0 -10px 40px rgba(0,0,0,0.2)",
              }}
            >
              {/* Header coloreado */}
              <div style={{
                background: tint, padding: "18px 22px 14px",
                display: "flex", alignItems: "center", gap: 12,
              }}>
                <div style={{
                  width: 38, height: 38, borderRadius: 12,
                  background: color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                }}>
                  <IconCheck size={20} color="#fff" sw={2.5} />
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 800, color, letterSpacing: 0.2 }}>{titulo}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 12, color, opacity: 0.8 }}>{sub}</p>
                  {paradaEmbarqueNombre && (
                    <p style={{ margin: "3px 0 0", fontSize: 12, color, opacity: 0.9, fontWeight: 700 }}>
                      📍 Abordó en {paradaEmbarqueNombre}
                    </p>
                  )}
                </div>
              </div>

              {/* Info del pasajero */}
              <div style={{ padding: "18px 22px 10px", display: "flex", gap: 16, alignItems: "center" }}>
                <div style={{
                  width: 72, height: 72, borderRadius: 20, flexShrink: 0,
                  background: "var(--c-navy-tint)", color: "var(--c-navy)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontFamily: FONT_SANS, fontWeight: 800, fontSize: 26, overflow: "hidden",
                }}>
                  {p.foto_url
                    ? <img src={p.foto_url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : ini(p.nombre)}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{ margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: -0.5, lineHeight: 1.15 }}>{p.nombre}</p>
                  {p.empresa && (
                    <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--c-mute)" }}>{p.empresa}</p>
                  )}
                  {p.dni && (
                    <p style={{ margin: "3px 0 0", fontFamily: FONT_MONO, fontSize: 12, color: "var(--c-mute)", fontWeight: 600 }}>
                      DNI {p.dni}
                    </p>
                  )}
                </div>
              </div>

              {/* Barra de progreso + hint */}
              <div style={{ padding: "8px 22px 28px" }}>
                <div style={{ height: 4, background: "var(--c-line-2)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{
                    height: "100%", width: `${resultProgreso}%`,
                    background: color, transition: "width 0.03s linear",
                  }} />
                </div>
                <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--c-mute)", textAlign: "center" }}>
                  Toca para cerrar
                </p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* MODAL INCIDENCIA                                                    */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {showIncidencia && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 105,
          background: "rgba(11,31,58,0.75)",
          display: "flex", alignItems: "flex-end", justifyContent: "center",
          animation: "sheetIn 0.25s ease-out",
        }}>
          <div style={{
            background: "var(--c-paper)", borderRadius: "28px 28px 0 0",
            padding: "0 0 22px", width: "100%", maxWidth: 520,
            maxHeight: "92vh", overflowY: "auto",
            boxShadow: "0 -10px 30px rgba(0,0,0,0.15)",
          }}>
            <div style={{ width: 40, height: 4, background: "var(--c-line)", borderRadius: 2, margin: "14px auto 16px" }} />

            <div style={{ padding: "0 22px", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div>
                <Eyebrow color="var(--c-danger)">Reporte rápido</Eyebrow>
                <h2 style={{ margin: "4px 0 0", fontSize: 24, fontWeight: 800, letterSpacing: -0.8 }}>
                  Incidencia
                </h2>
              </div>
              <button
                onClick={() => setShowIncidencia(false)}
                style={{
                  width: 34, height: 34, borderRadius: 12,
                  background: "var(--c-soft)", border: "none", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <IconClose size={15} color="var(--c-ink)" />
              </button>
            </div>

            <div style={{ padding: "0 22px" }}>
              <Eyebrow style={{ marginBottom: 8 }}>Tipo</Eyebrow>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
                {INCIDENCIA_TIPOS.map(t => {
                  const sel = incTipo === t.id;
                  const Ico = t.icon;
                  return (
                    <button
                      key={t.id}
                      onClick={() => setIncTipo(t.id)}
                      style={{
                        padding: "12px 8px", borderRadius: 14, cursor: "pointer",
                        border: sel ? "2px solid var(--c-navy)" : "1px solid var(--c-line)",
                        background: sel ? "var(--c-navy-tint)" : "var(--c-surface)",
                        boxShadow: sel ? "0 4px 14px rgba(11,49,95,0.12)" : "none",
                        display: "flex", flexDirection: "column", alignItems: "center", gap: 6,
                        fontFamily: FONT_SANS,
                      }}
                    >
                      <Ico size={22} color={sel ? "var(--c-navy)" : "var(--c-mute)"} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: sel ? "var(--c-navy)" : "var(--c-ink-2)" }}>
                        {t.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              <Eyebrow style={{ marginBottom: 8 }}>Severidad</Eyebrow>
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 14,
                background: "var(--c-soft)", padding: 4, borderRadius: 12,
              }}>
                {SEVERIDADES.map(s => {
                  const sel = incSev === s.id;
                  return (
                    <button
                      key={s.id}
                      onClick={() => setIncSev(s.id)}
                      style={{
                        padding: "10px 0", borderRadius: 10, border: "none", cursor: "pointer",
                        background: sel ? s.bg : "transparent",
                        color: sel ? s.color : "var(--c-mute)",
                        fontFamily: FONT_SANS, fontSize: 13, fontWeight: 700,
                      }}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>

              <Eyebrow style={{ marginBottom: 8 }}>Descripción (obligatoria)</Eyebrow>
              <textarea
                rows={3} value={incDesc} onChange={e => setIncDesc(e.target.value)}
                placeholder="Describe brevemente lo ocurrido…"
                required
                style={{
                  width: "100%", marginBottom: 12, padding: 12, borderRadius: 12,
                  border: "1.5px solid var(--c-line)",
                  fontFamily: FONT_SANS, fontSize: 13, color: "var(--c-ink)",
                  background: "var(--c-surface)", resize: "none", outline: "none",
                  boxSizing: "border-box",
                }}
              />

              <div style={{
                background: "var(--c-warn-tint)", border: "1px solid var(--c-warn)",
                borderRadius: 12, padding: "10px 14px", marginBottom: 16,
                display: "flex", alignItems: "center", gap: 10,
              }}>
                <IconClock size={18} color="var(--c-warn)" />
                <div style={{ flex: 1 }}>
                  <p style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "var(--c-warn)" }}>
                    Retraso estimado
                  </p>
                </div>
                <input
                  type="number" min={0} max={240} value={incRetraso}
                  onChange={e => setIncRetraso(e.target.value)}
                  placeholder="0"
                  style={{
                    width: 72, padding: "6px 8px", borderRadius: 8,
                    border: "1px solid var(--c-warn)", background: "#fff",
                    fontFamily: FONT_MONO, fontSize: 16, fontWeight: 800, color: "var(--c-warn)",
                    textAlign: "center", outline: "none",
                  }}
                />
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--c-warn)" }}>min</span>
              </div>

              <div style={{
                background: "var(--c-surface)", border: "1px solid var(--c-line)",
                borderRadius: 12, padding: "10px 14px", marginBottom: 16,
              }}>
                <Eyebrow style={{ marginBottom: 6 }}>Notificará a</Eyebrow>
                {["Operaciones AFA", "Supervisor de flota", "Central — 966 707 225"].map(r => (
                  <div key={r} style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "4px 0",
                  }}>
                    <IconCheck size={14} color="var(--c-success)" sw={2.5} />
                    <span style={{ fontSize: 12, color: "var(--c-ink-2)" }}>{r}</span>
                  </div>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <SecondaryBtn onClick={() => setShowIncidencia(false)}>Cancelar</SecondaryBtn>
                <PrimaryBtn
                  onClick={enviarIncidencia}
                  disabled={incSaving}
                  color="var(--c-danger)"
                  icon={<IconBell size={15} color="#fff" />}
                >
                  {incSaving ? "Enviando…" : "Enviar"}
                </PrimaryBtn>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* HOJA: REGISTRAR GASTO DE CAJA CHICA                                 */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {ccForm && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 105,
          background: "rgba(11,31,58,0.75)",
          display: "flex", alignItems: "flex-end", justifyContent: "center",
          animation: "sheetIn 0.25s ease-out",
        }}>
          <div style={{
            background: "var(--c-paper)", borderRadius: "28px 28px 0 0",
            padding: "0 0 22px", width: "100%", maxWidth: 520,
            maxHeight: "92vh", overflowY: "auto",
            boxShadow: "0 -10px 30px rgba(0,0,0,0.15)",
          }}>
            <div style={{ width: 40, height: 4, background: "var(--c-line)", borderRadius: 2, margin: "14px auto 16px" }} />

            <div style={{ padding: "0 22px", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div>
                <Eyebrow>Caja chica</Eyebrow>
                <h2 style={{ margin: "4px 0 0", fontSize: 24, fontWeight: 800, letterSpacing: -0.8 }}>
                  Registrar gasto
                </h2>
              </div>
              <button
                onClick={() => setCcForm(false)}
                style={{
                  width: 34, height: 34, borderRadius: 12,
                  background: "var(--c-soft)", border: "none", cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                <IconClose size={15} color="var(--c-ink)" />
              </button>
            </div>

            <div style={{ padding: "0 22px" }}>
              <Eyebrow style={{ marginBottom: 8 }}>Categoría</Eyebrow>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
                {CATEGORIAS_GASTO_APP.map(id => {
                  const cat = configCategoriaCC(id);
                  const sel = ccCat === id;
                  return (
                    <button
                      key={id}
                      onClick={() => setCcCat(id)}
                      style={{
                        padding: "12px 6px", borderRadius: 14, cursor: "pointer",
                        border: sel ? `2px solid ${cat.color}` : "1px solid var(--c-line)",
                        background: sel ? cat.bg : "var(--c-surface)",
                        display: "flex", flexDirection: "column", alignItems: "center", gap: 5,
                        fontFamily: FONT_SANS,
                      }}
                    >
                      <span style={{ fontSize: 21, lineHeight: 1 }}>{cat.emoji}</span>
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: sel ? cat.color : "var(--c-ink-2)", textAlign: "center", lineHeight: 1.15 }}>
                        {cat.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Foto del comprobante. Es lo que convierte el gasto en rendible, así que va antes
                  del monto — pero el monto NUNCA depende de ella: no hay OCR que prellenar. */}
              <Eyebrow style={{ marginBottom: 8 }}>Comprobante</Eyebrow>
              {!ccFoto ? (
                <label style={{
                  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5,
                  padding: "22px 14px", borderRadius: 14, border: "2px dashed var(--c-navy)",
                  cursor: ccFotoProc ? "default" : "pointer", background: "var(--c-navy-tint)", color: "var(--c-navy)",
                  fontFamily: FONT_SANS, fontSize: 14, fontWeight: 800, textAlign: "center", marginBottom: 14,
                }}>
                  <span style={{ fontSize: 26 }}>📷</span>
                  {ccFotoProc ? "Procesando la foto…" : "Fotografía el ticket"}
                  <span style={{ fontSize: 11, fontWeight: 600, color: "var(--c-mute)" }}>
                    El peaje, el lavado, la boleta… tal como está
                  </span>
                  <input type="file" accept="image/*" capture="environment" hidden disabled={ccFotoProc}
                    onChange={(e) => { capturarComprobante(e.target.files?.[0]); e.currentTarget.value = ""; }} />
                </label>
              ) : (
                <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
                  <img src={ccFoto.previewUrl} alt="comprobante" style={{ width: 78, height: 78, objectFit: "cover", borderRadius: 12, border: "1px solid var(--c-line)" }} />
                  <div style={{ flex: 1 }}>
                    <p style={{ margin: 0, fontSize: 12.5, fontWeight: 800, color: "var(--c-success)" }}>✓ Comprobante listo</p>
                    <button
                      onClick={() => setCcFoto(prev => { if (prev) URL.revokeObjectURL(prev.previewUrl); return null; })}
                      style={{ marginTop: 4, background: "none", border: "none", padding: 0, cursor: "pointer", color: "var(--c-navy)", fontFamily: FONT_SANS, fontSize: 12, fontWeight: 700 }}>
                      Tomar otra
                    </button>
                  </div>
                </div>
              )}

              <Eyebrow style={{ marginBottom: 8 }}>Monto</Eyebrow>
              <div style={{
                display: "flex", alignItems: "center", gap: 10, marginBottom: 14,
                border: "1.5px solid var(--c-line)", borderRadius: 12, padding: "10px 14px",
                background: "var(--c-surface)",
              }}>
                <span style={{ fontFamily: FONT_MONO, fontSize: 18, fontWeight: 800, color: "var(--c-mute)" }}>S/</span>
                <input
                  type="text" inputMode="decimal" value={ccMonto}
                  onChange={e => setCcMonto(e.target.value.replace(/[^\d.,]/g, "").slice(0, 10))}
                  placeholder="0.00"
                  style={{
                    flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent",
                    fontFamily: FONT_MONO, fontSize: 24, fontWeight: 800, color: "var(--c-ink)", letterSpacing: 0.5,
                  }}
                />
              </div>

              <Eyebrow style={{ marginBottom: 8 }}>Detalle (opcional)</Eyebrow>
              <input
                value={ccDesc} onChange={e => setCcDesc(e.target.value.slice(0, 120))}
                placeholder="Peaje Villa · garita sur"
                style={{
                  width: "100%", marginBottom: 14, padding: "12px 14px", borderRadius: 12,
                  border: "1.5px solid var(--c-line)", fontFamily: FONT_SANS, fontSize: 13,
                  color: "var(--c-ink)", background: "var(--c-surface)", outline: "none", boxSizing: "border-box",
                }}
              />

              {/* Atar el gasto al servicio es lo que permite después calcular el costo real de esa
                  reserva (v_costo_servicio.costo_caja_chica). Opcional: hay gastos de la jornada
                  que no son de ningún servicio en concreto. */}
              {reservasHoy.length > 0 && (
                <>
                  <Eyebrow style={{ marginBottom: 8 }}>Servicio del día (opcional)</Eyebrow>
                  <select
                    value={ccReservaId ?? ""}
                    onChange={e => setCcReservaId(e.target.value ? Number(e.target.value) : null)}
                    style={{
                      width: "100%", marginBottom: 16, padding: "12px 14px", borderRadius: 12,
                      border: "1.5px solid var(--c-line)", fontFamily: FONT_SANS, fontSize: 13, fontWeight: 600,
                      color: "var(--c-ink)", background: "var(--c-surface)", outline: "none", boxSizing: "border-box",
                    }}
                  >
                    <option value="">Sin servicio asociado</option>
                    {reservasHoy.map(r => (
                      <option key={r.id} value={r.id}>
                        {(r.hora_servicio ?? "").slice(0, 5)} · {acortarLugar(r.origen)} → {acortarLugar(r.destino)}
                      </option>
                    ))}
                  </select>
                </>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <SecondaryBtn onClick={() => { limpiarFormGasto(); setCcForm(false); }}>Cancelar</SecondaryBtn>
                <PrimaryBtn
                  onClick={registrarGasto}
                  disabled={ccGuardando || ccFotoProc}
                  icon={<IconCheck size={15} color="#fff" sw={2.5} />}
                >
                  {ccGuardando ? "Guardando…" : "Rendir"}
                </PrimaryBtn>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* OVERLAY SERVICIO COMPLETADO (último paradero → finalización directa) */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {showFinOverlay && datosFinViaje && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 200,
          background: "rgba(11,31,58,0.92)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 24, animation: "sheetIn 0.3s ease-out",
        }}>
          <div style={{
            background: "var(--c-paper)", borderRadius: 28, padding: 28,
            width: "100%", maxWidth: 400, textAlign: "center",
            boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
          }}>
            <div style={{
              width: 72, height: 72, borderRadius: 22,
              background: "var(--c-success-tint)",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              marginBottom: 16,
            }}>
              <IconFlag size={34} color="var(--c-success)" />
            </div>
            <h2 style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 800, letterSpacing: -0.5, color: "var(--c-ink)" }}>
              Servicio completado
            </h2>
            <p style={{ margin: "0 0 22px", color: "var(--c-mute)", fontSize: 13 }}>
              {datosFinViaje.origen} → {datosFinViaje.destino}
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 20 }}>
              {[
                { lbl: "Duración",   val: datosFinViaje.duracion,                    color: "var(--c-navy)" },
                { lbl: "Paradas",    val: String(datosFinViaje.paradasTotales),       color: "var(--c-navy)" },
                { lbl: "A bordo",    val: String(datosFinViaje.embarcados),           color: "var(--c-success)" },
                { lbl: "Envíos GPS", val: String(datosFinViaje.envios),               color: "var(--c-navy)" },
              ].map(s => (
                <div key={s.lbl} style={{
                  background: "var(--c-soft)", borderRadius: 14, padding: "12px 14px",
                }}>
                  <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--c-mute)" }}>
                    {s.lbl}
                  </p>
                  <p style={{ margin: "4px 0 0", fontFamily: FONT_MONO, fontSize: 22, fontWeight: 800, color: s.color }}>
                    {s.val}
                  </p>
                </div>
              ))}
            </div>
            <p style={{ color: "var(--c-mute)", fontSize: 12, margin: 0 }}>Cerrando automáticamente en 5 s…</p>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* MODAL FIN DE VIAJE                                                  */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {showFinViaje && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 105,
          background: "rgba(11,31,58,0.75)",
          display: "flex", alignItems: "flex-end", justifyContent: "center",
          animation: "sheetIn 0.25s ease-out",
        }}>
          <div style={{
            background: "var(--c-paper)", borderRadius: "28px 28px 0 0",
            padding: "0 0 22px", width: "100%", maxWidth: 520,
            maxHeight: "92vh", overflowY: "auto",
            boxShadow: "0 -10px 30px rgba(0,0,0,0.15)",
          }}>
            <div style={{ width: 40, height: 4, background: "var(--c-line)", borderRadius: 2, margin: "14px auto 16px" }} />

            <div style={{
              margin: "0 22px 18px",
              background: "linear-gradient(135deg, var(--c-navy), var(--c-blue))",
              color: "#fff", borderRadius: 22, padding: 20, position: "relative", overflow: "hidden",
            }}>
              <div style={{ position: "absolute", right: -8, top: -8, opacity: 0.12 }}>
                <IconFlag size={100} color="#fff" />
              </div>
              <Eyebrow color="rgba(255,255,255,0.7)">
                {paradaIdx < paradas.length - 1 ? "Cierre anticipado" : "Viaje finalizado"}
              </Eyebrow>
              <h2 style={{ margin: "4px 0 0", fontSize: 22, fontWeight: 800, letterSpacing: -0.6 }}>
                {reservaActiva?.origen} → {reservaActiva?.destino}
              </h2>
            </div>

            <div style={{ padding: "0 22px" }}>
              {paradaIdx < paradas.length - 1 && (
                <div style={{
                  background: "var(--c-warn-tint)", border: "1px solid var(--c-warn)",
                  borderRadius: 14, padding: "12px 14px", marginBottom: 14,
                  display: "flex", alignItems: "center", gap: 10,
                }}>
                  <IconAlert size={16} color="var(--c-warn)" />
                  <p style={{ margin: 0, color: "#92400E", fontSize: 13, fontWeight: 600 }}>
                    Quedan {paradas.length - 1 - paradaIdx} parada{paradas.length - 1 - paradaIdx > 1 ? "s" : ""} sin completar
                  </p>
                </div>
              )}
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14,
              }}>
                {[
                  { lbl: "Duración",  val: inicioViaje ? fmtDuracion(Date.now() - inicioViaje.getTime()) : "—", mono: true },
                  { lbl: "Paradas",   val: `${paradaIdx + 1}/${paradas.length}`, mono: true },
                  { lbl: "A bordo",   val: String(totalEmbarcados), mono: true, color: "var(--c-success)" },
                  { lbl: "Envíos GPS", val: String(totalEnvios), mono: true },
                ].map(s => (
                  <div
                    key={s.lbl}
                    style={{
                      background: "var(--c-surface)", border: "1px solid var(--c-line)",
                      borderRadius: 14, padding: "12px 14px",
                    }}
                  >
                    <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: "var(--c-mute)" }}>
                      {s.lbl}
                    </p>
                    <p style={{
                      margin: "4px 0 0",
                      fontFamily: s.mono ? FONT_MONO : FONT_SANS,
                      fontSize: 22, fontWeight: 800, letterSpacing: -0.5,
                      color: s.color || "var(--c-navy)",
                    }}>
                      {s.val}
                    </p>
                  </div>
                ))}
              </div>

              <Eyebrow style={{ marginBottom: 10 }}>Línea del tiempo</Eyebrow>
              <div style={{
                background: "var(--c-surface)", border: "1px solid var(--c-line)",
                borderRadius: 14, padding: 14, marginBottom: 16,
              }}>
                {[
                  { ico: IconPlay,   lbl: "Iniciaste viaje",     hora: inicioViaje?.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }) || "—" },
                  { ico: IconPin,    lbl: "Primera parada",       hora: paradas[0]?.hora_estimada?.slice(0, 5) || "—" },
                  { ico: IconUsers,  lbl: `${totalEmbarcados} pasajeros embarcados`, hora: "" },
                  { ico: IconFlag,   lbl: "Cierre de viaje",      hora: new Date().toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" }) },
                ].map((row, i, arr) => {
                  const Ico = row.ico;
                  return (
                    <div key={i} style={{
                      display: "flex", alignItems: "center", gap: 12,
                      padding: "8px 0",
                      borderBottom: i < arr.length - 1 ? "1px dashed var(--c-line-2)" : "none",
                    }}>
                      <div style={{
                        width: 30, height: 30, borderRadius: 9,
                        background: "var(--c-navy-tint)", color: "var(--c-navy)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        flexShrink: 0,
                      }}>
                        <Ico size={15} color="var(--c-navy)" />
                      </div>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--c-ink-2)" }}>
                        {row.lbl}
                      </span>
                      {row.hora && (
                        <span style={{ fontFamily: FONT_MONO, fontSize: 12, fontWeight: 700, color: "var(--c-mute)" }}>
                          {row.hora}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <SecondaryBtn onClick={() => setShowFinViaje(false)}>Cancelar</SecondaryBtn>
                <PrimaryBtn
                  onClick={finalizarRecorridoConfirmado}
                  icon={<IconStop size={15} color="#fff" />}
                >
                  Cerrar viaje
                </PrimaryBtn>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* TOAST                                                               */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {boardingMsg && (
        <div style={{
          position: "fixed", top: 78, left: "50%", transform: "translateX(-50%)",
          background: boardingMsg.ok ? "var(--c-success)" : "var(--c-danger)",
          color: "#fff", borderRadius: 14, padding: "12px 18px",
          fontFamily: FONT_SANS, fontWeight: 700, fontSize: 13, zIndex: 200,
          boxShadow: "0 8px 24px rgba(0,0,0,0.25)", maxWidth: "90%", textAlign: "center",
          display: "flex", alignItems: "center", gap: 8,
          animation: "sheetIn 0.25s ease-out",
        }}>
          {boardingMsg.ok
            ? <IconCheck size={16} color="#fff" sw={2.5} />
            : <IconCircleAlert size={16} color="#fff" />}
          {boardingMsg.msg}
        </div>
      )}

      {/* "Leyendo…" — aparece al instante al escanear (feedback optimista) mientras el server responde */}
      {leyendo && !boardingMsg && !resultadoEmbarque && (
        <div style={{
          position: "fixed", top: 78, left: "50%", transform: "translateX(-50%)",
          background: "var(--c-navy)", color: "#fff", borderRadius: 14, padding: "12px 20px",
          fontFamily: FONT_SANS, fontWeight: 800, fontSize: 13.5, zIndex: 200,
          boxShadow: "0 8px 24px rgba(0,0,0,0.25)", display: "flex", alignItems: "center", gap: 10,
          animation: "sheetIn 0.15s ease-out",
        }}>
          <span style={{
            width: 15, height: 15, borderRadius: "50%", flexShrink: 0,
            border: "2.5px solid rgba(255,255,255,0.35)", borderTopColor: "#fff",
            display: "inline-block", animation: "spin 0.7s linear infinite",
          }} />
          Leyendo…
        </div>
      )}

      {/* ── CHAT CON PASAJEROS: botón flotante (solo en servicio activo) ── */}
      {conductor && reservaActiva && enRuta && !chatOpen && !escanear && (
        <button onClick={() => { setChatOpen(true); setChatPaxSel(null); }} aria-label="Mensajes de pasajeros"
          style={{ position: "fixed", right: 16, bottom: 96, zIndex: 110, width: 56, height: 56, borderRadius: "50%", background: "#0b315f", color: "#fff", border: "none", boxShadow: "0 6px 18px rgba(11,49,95,.4)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, cursor: "pointer" }}>
          💬
          {(() => {
            const n = chatMsgs.filter((m: any) => m.remitente === "pasajero" && !m.leido).length;
            return n > 0 ? (
              <span style={{ position: "absolute", top: -2, right: -2, minWidth: 21, height: 21, padding: "0 5px", borderRadius: 11, background: "#ef4444", color: "#fff", fontSize: 11.5, fontWeight: 900, display: "flex", alignItems: "center", justifyContent: "center", border: "2px solid #0b315f" }}>
                {n > 9 ? "9+" : n}
              </span>
            ) : null;
          })()}
        </button>
      )}

      {/* ── CHAT CON PASAJEROS: overlay (bandeja → hilo) ── */}
      {chatOpen && (() => {
        const threads = agruparThreadsCond(chatMsgs);
        const threadSel = chatPaxSel != null ? (threads.find(t => t.paxId === chatPaxSel) || null) : null;
        return (
          <div onClick={() => setChatOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 210, background: "rgba(11,49,95,0.55)", display: "flex", flexDirection: "column", justifyContent: "flex-end", fontFamily: FONT_SANS }}>
            <div onClick={e => e.stopPropagation()}
              style={{ background: "#fff", borderRadius: "20px 20px 0 0", maxHeight: "88vh", display: "flex", flexDirection: "column", boxShadow: "0 -8px 30px rgba(0,0,0,0.2)" }}>

              {/* Header */}
              <div style={{ background: "#0b315f", color: "#fff", padding: "13px 14px", borderRadius: "20px 20px 0 0", display: "flex", alignItems: "center", gap: 10 }}>
                {threadSel && (
                  <button onClick={() => setChatPaxSel(null)} aria-label="Volver"
                    style={{ width: 34, height: 34, borderRadius: 10, background: "rgba(255,255,255,0.12)", border: "none", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
                    <IconArrowLeft size={18} color="#fff" />
                  </button>
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontWeight: 800, fontSize: 15.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {threadSel ? threadSel.nombre : "Mensajes de pasajeros"}
                  </div>
                  <div style={{ fontSize: 11.5, opacity: 0.82 }}>
                    {threadSel ? (threadSel.empresa || "Toca para responder") : `${threads.length} conversación(es)`}
                  </div>
                </div>
                <button onClick={() => setChatOpen(false)} aria-label="Cerrar"
                  style={{ width: 34, height: 34, borderRadius: 10, background: "rgba(255,255,255,0.12)", border: "none", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}>
                  <IconClose size={18} color="#fff" />
                </button>
              </div>

              {/* Bandeja de hilos */}
              {!threadSel ? (
                <div style={{ overflowY: "auto", maxHeight: "72vh" }}>
                  {threads.length === 0 ? (
                    <div style={{ padding: "44px 20px", textAlign: "center", color: "#64748b" }}>
                      <div style={{ fontSize: 40, marginBottom: 8 }}>💬</div>
                      <div style={{ fontWeight: 700, color: "#334155" }}>Sin mensajes</div>
                      <div style={{ fontSize: 13, marginTop: 4 }}>Aquí verás lo que te escriban los pasajeros de este servicio</div>
                    </div>
                  ) : threads.map(t => (
                    <button key={t.paxId} onClick={() => setChatPaxSel(t.paxId)}
                      style={{ width: "100%", textAlign: "left", display: "flex", gap: 12, alignItems: "center", padding: "13px 16px", borderBottom: "1px solid #f1f5f9", background: t.noLeidos > 0 ? "#f8fafc" : "#fff", border: "none", cursor: "pointer" }}>
                      <div style={{ width: 40, height: 40, borderRadius: 12, background: "#0b315f", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, flexShrink: 0 }}>
                        {t.nombre.charAt(0).toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700, color: "#0f172a", fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.nombre}</div>
                        <div style={{ fontSize: 13, color: "#64748b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {t.ultimo.remitente !== "pasajero" ? "Tú: " : ""}{t.ultimo.mensaje}
                        </div>
                      </div>
                      {t.noLeidos > 0 && (
                        <span style={{ background: "#ef4444", color: "#fff", borderRadius: 999, minWidth: 20, height: 20, padding: "0 6px", fontSize: 11, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          {t.noLeidos > 9 ? "9+" : t.noLeidos}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <>
                  {/* Burbujas */}
                  <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", background: "#f8fafc", display: "flex", flexDirection: "column", gap: 8, minHeight: 220 }}>
                    {threadSel.msgs.map((m: any) => {
                      const suyo = m.remitente !== "pasajero";
                      const hora = m.created_at ? new Date(m.created_at).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
                      return (
                        <div key={m.id} style={{ display: "flex", justifyContent: suyo ? "flex-end" : "flex-start" }}>
                          <div style={{ maxWidth: "82%" }}>
                            <div style={{ padding: "9px 12px", borderRadius: 14, fontSize: 14, lineHeight: 1.4, wordBreak: "break-word", ...(suyo ? { background: "#0b315f", color: "#fff", borderBottomRightRadius: 4 } : { background: "#fff", color: "#0f172a", border: "1px solid #e5e7eb", borderBottomLeftRadius: 4 }) }}>
                              {m.mensaje}
                            </div>
                            <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 2, textAlign: suyo ? "right" : "left" }}>{hora}</div>
                          </div>
                        </div>
                      );
                    })}
                    <div ref={chatFinRef} />
                  </div>

                  {/* Respuestas rápidas */}
                  <div style={{ display: "flex", gap: 8, overflowX: "auto", padding: "8px 12px", borderTop: "1px solid #eef2f7" }}>
                    {RESP_RAPIDAS_COND.map((r, i) => (
                      <button key={i} disabled={chatEnviando} onClick={() => responderPax(threadSel.paxId, r)}
                        style={{ flexShrink: 0, fontSize: 12.5, fontWeight: 600, padding: "7px 12px", borderRadius: 999, border: "1px solid #e2e8f0", background: "#fff", color: "#475569", whiteSpace: "nowrap", cursor: "pointer", opacity: chatEnviando ? 0.5 : 1 }}>
                        {r}
                      </button>
                    ))}
                  </div>

                  {/* Caja de texto */}
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end", padding: "10px 12px", borderTop: "1px solid #eef2f7", paddingBottom: "calc(10px + env(safe-area-inset-bottom))" }}>
                    <textarea rows={1} value={chatBorrador} onChange={e => setChatBorrador(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); responderPax(threadSel.paxId, chatBorrador); } }}
                      placeholder="Escribe una respuesta…"
                      style={{ flex: 1, resize: "none", padding: "11px 13px", borderRadius: 14, border: "1.5px solid #e2e8f0", fontSize: 16, fontFamily: FONT_SANS, outline: "none", maxHeight: 110, boxSizing: "border-box" }} />
                    <button onClick={() => responderPax(threadSel.paxId, chatBorrador)} disabled={chatEnviando || !chatBorrador.trim()}
                      style={{ flexShrink: 0, height: 44, padding: "0 16px", borderRadius: 14, background: "#0b315f", color: "#fff", border: "none", fontWeight: 800, fontSize: 14, cursor: "pointer", opacity: (chatEnviando || !chatBorrador.trim()) ? 0.4 : 1 }}>
                      {chatEnviando ? "…" : "Enviar"}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        * { -webkit-tap-highlight-color: transparent; }
      `}</style>
    </div>
  );
}
