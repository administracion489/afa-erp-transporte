// lib/geo.ts
// Geolocalización unificada: dentro de la app Capacitor (Android/iOS) usa el
// plugin nativo @capacitor/geolocation — que dispara el diálogo de permisos
// NATIVO del sistema operativo, igual que Maps/inDrive/Yango. En el navegador
// web cae automáticamente a navigator.geolocation.
//
// Uso:
//   const estado = await pedirPermisoUbicacion();      // "granted" | "denied" | ...
//   const pos    = await obtenerUbicacion();           // { coords: { latitude, longitude } }
//   const w      = await observarUbicacion(cb, errCb); // w.clear() para detener
//
// Las posiciones tienen la MISMA forma que GeolocationPosition del navegador
// (pos.coords.latitude / pos.coords.longitude), para ser drop-in.

import { Capacitor } from "@capacitor/core";

export type GeoPos = {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number;
    speed?: number | null;
    heading?: number | null;
  };
  timestamp?: number;
};

export type GeoPermiso = "granted" | "denied" | "prompt" | "unavailable";
export type GeoWatch = { clear: () => void };

const esNativo = () => Capacitor.isNativePlatform();

// Carga diferida del plugin solo en nativo (evita peso/errores en web).
async function plugin() {
  const mod = await import("@capacitor/geolocation");
  return mod.Geolocation;
}

/**
 * Solicita el permiso de ubicación. En nativo muestra el diálogo del sistema
 * (Permitir mientras se usa la app / Solo esta vez / No permitir).
 */
export async function pedirPermisoUbicacion(): Promise<GeoPermiso> {
  if (esNativo()) {
    try {
      const Geolocation = await plugin();
      // Timeout duro: en algunos aparatos checkPermissions/requestPermissions se cuelga.
      const actual = await conTimeout(Geolocation.checkPermissions(), 6000);
      if (actual.location === "granted" || actual.coarseLocation === "granted") {
        return "granted";
      }
      const res = await conTimeout(Geolocation.requestPermissions({ permissions: ["location"] }), 60000);
      const ok = res.location === "granted" || res.coarseLocation === "granted";
      return ok ? "granted" : "denied";
    } catch {
      return "unavailable";
    }
  }
  // Web: el permiso se pide implícitamente al llamar getCurrentPosition.
  if (typeof navigator === "undefined" || !navigator.geolocation) return "unavailable";
  try {
    if (navigator.permissions?.query) {
      const st = await navigator.permissions.query({ name: "geolocation" as PermissionName });
      return st.state as GeoPermiso;
    }
  } catch { /* algunos navegadores no soportan permissions.query para geolocation */ }
  return "prompt";
}

const OPC_DEFAULT = { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 };

// Timeout duro: el plugin nativo de Capacitor a veces NO respeta su propio timeout
// (p.ej. si el GPS del aparato está apagado), dejando la promesa colgada para
// siempre. Esto garantiza que SIEMPRE resuelva o rechace.
function conTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(Object.assign(new Error("Tiempo de espera de GPS agotado"), { code: 3 })),
      ms
    );
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

/** Obtiene la posición actual una sola vez. */
export async function obtenerUbicacion(
  opts: PositionOptions = OPC_DEFAULT
): Promise<GeoPos> {
  if (esNativo()) {
    const Geolocation = await plugin();
    // En nativo aseguramos el permiso antes de leer.
    const perm = await pedirPermisoUbicacion();
    if (perm !== "granted") {
      throw Object.assign(new Error("Permiso de ubicación denegado"), { code: 1 });
    }
    const to = opts.timeout ?? 10000;
    const p = await conTimeout(
      Geolocation.getCurrentPosition({
        enableHighAccuracy: opts.enableHighAccuracy ?? true,
        timeout: to,
        maximumAge: opts.maximumAge ?? 0,
      }),
      to + 2000 // margen sobre el timeout del plugin
    );
    return { coords: p.coords, timestamp: p.timestamp };
  }
  return new Promise<GeoPos>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(pos as GeoPos),
      (err) => reject(err),
      opts
    );
  });
}

/**
 * Observa la posición de forma continua. Devuelve un handle con clear()
 * para detener el seguimiento.
 */
export async function observarUbicacion(
  onPos: (pos: GeoPos) => void,
  onError?: (err: { code?: number; message: string }) => void,
  opts: PositionOptions = { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
): Promise<GeoWatch> {
  const limpiar: Array<() => void> = [];

  // 1) navigator.geolocation — usa el proveedor del SISTEMA (igual que Google Maps).
  //    En muchos dispositivos (p.ej. tablets) entrega ubicación cuando el plugin no.
  try {
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      const id = navigator.geolocation.watchPosition(
        (pos) => onPos(pos as GeoPos),
        (err) => onError?.(err),
        opts
      );
      limpiar.push(() => { try { navigator.geolocation.clearWatch(id); } catch {} });
    }
  } catch { /* ignore */ }

  // 2) En nativo, ADEMÁS el plugin Capacitor (redundancia: el que entregue, gana).
  if (esNativo()) {
    try {
      const Geolocation = await plugin();
      const id = await Geolocation.watchPosition(
        {
          enableHighAccuracy: opts.enableHighAccuracy ?? true,
          timeout: opts.timeout ?? 15000,
          maximumAge: opts.maximumAge ?? 5000,
        },
        (p, err) => {
          if (err) { onError?.({ message: err.message }); return; }
          if (p) onPos({ coords: p.coords, timestamp: p.timestamp });
        }
      );
      limpiar.push(() => { try { void Geolocation.clearWatch({ id }); } catch {} });
    } catch (e: any) {
      onError?.({ message: `plugin: ${e?.message ?? e}` });
    }
  }

  return { clear: () => limpiar.forEach((f) => f()) };
}

/**
 * Observa la ubicación en SEGUNDO PLANO (sigue enviando con Waze encima o pantalla
 * bloqueada) usando el plugin nativo @capgo/background-geolocation, que levanta un
 * foreground service con notificación persistente. Si el plugin NO está disponible en
 * el build nativo actual (p.ej. un APK viejo aún sin recompilar), cae de forma
 * transparente a observarUbicacion() para NO romper el rastreo en primer plano.
 */
let _bgActivo = false;
/** true sólo si el plugin nativo de background está corriendo (APK recompilado). */
export function backgroundGpsActivo(): boolean { return _bgActivo; }

export async function observarUbicacionBackground(
  onPos: (pos: GeoPos) => void,
  onError?: (err: { code?: number; message: string }) => void,
): Promise<GeoWatch> {
  if (!esNativo()) return observarUbicacion(onPos, onError);

  // 1) Cargar el plugin nativo. Que FALLE el import es el ÚNICO "plugin ausente" real (APK
  //    viejo sin recompilar) → ahí sí cae a primer plano. Un fallo de start() NO es ausencia.
  let BackgroundGeolocation: any;
  try {
    ({ BackgroundGeolocation } = await import("@capgo/background-geolocation"));
  } catch (e: any) {
    _bgActivo = false;
    console.warn("[geo] background-geolocation no disponible, fallback a primer plano:", e?.message);
    return observarUbicacion(onPos, onError);
  }

  // NO pre-chequear el permiso con @capacitor/geolocation: en MIUI/HyperOS su checkPermissions()
  // se cuelga o devuelve "no concedido" AUNQUE el permiso SÍ esté concedido → el servicio nunca
  // arrancaba (ENVÍOS GPS: 0). El plugin hace su propio chequeo nativo (con requestPermissions:true
  // pide el permiso si falta). El servicio está parcheado (startForeground inmediato en
  // onStartCommand → sin ANR; escucha FUSED/GPS/NETWORK → funciona en WiFi-only). stale:true
  // devuelve la última ubicación conocida al instante.
  const opciones = {
    backgroundTitle: "AFA · rastreo activo",
    backgroundMessage: "Enviando tu ubicación durante el viaje",
    requestPermissions: true,
    stale: true,
    distanceFilter: 20,
  };
  const onUpdate = (location: any, error: any) => {
    if (error) { onError?.({ message: error.message || "Error de GPS en segundo plano", code: error.code }); return; }
    if (!location) return;
    onPos({
      coords: {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy ?? 0,
        speed: location.speed ?? null,
        heading: location.bearing ?? null,
      },
      timestamp: location.time ?? undefined,
    });
  };
  const esYaIniciado = (e: any) =>
    e?.code === "ALREADY_STARTED" || /already started/i.test(String(e?.message ?? ""));

  // 2) Arrancar el servicio. Robusto al RE-ARMADO del watchdog: React no espera al cleanup (que
  //    hace stop() SIN await), así que este start() puede llegar mientras el servicio nativo aún
  //    no liberó `serviceConnectionFuture` → el plugin rechaza con ALREADY_STARTED. En ese caso
  //    NO degradar a primer plano (sería rastreo sin background, lo contrario de recuperar): se
  //    para LIMPIO (await stop() deja serviceConnectionFuture=null antes de resolver) y se
  //    reintenta UNA vez. Cualquier otro fallo sí cae a primer plano (degradado, no muerto).
  try {
    await BackgroundGeolocation.start(opciones, onUpdate);
  } catch (e: any) {
    if (esYaIniciado(e)) {
      try { await BackgroundGeolocation.stop(); } catch { /* noop */ }
      try {
        await BackgroundGeolocation.start(opciones, onUpdate);
      } catch (e2: any) {
        _bgActivo = false;
        console.warn("[geo] re-arranque background falló, fallback a primer plano:", e2?.message);
        return observarUbicacion(onPos, onError);
      }
    } else {
      _bgActivo = false;
      console.warn("[geo] start background falló, fallback a primer plano:", e?.message);
      return observarUbicacion(onPos, onError);
    }
  }
  _bgActivo = true;
  return { clear: () => { _bgActivo = false; void BackgroundGeolocation.stop().catch(() => {}); } };
}

/** Abre los ajustes de la app para conceder "Permitir todo el tiempo" (Android 11+). */
export async function abrirAjustesUbicacion(): Promise<void> {
  if (!esNativo()) return;
  try {
    const { BackgroundGeolocation } = await import("@capgo/background-geolocation");
    await BackgroundGeolocation.openSettings();
  } catch { /* noop */ }
}

/**
 * Pide al usuario excluir la app de la optimización de batería (Doze / App Standby / battery
 * savers del fabricante) mediante el diálogo del sistema. Solo en la app nativa con el plugin
 * nativo propio `AfaNative` (APK recompilado con AfaNativePlugin). DEBE invocarse en respuesta a
 * una ACCIÓN del conductor (un botón), por política de Google Play — nunca automáticamente.
 * Idempotente: si ya está exenta no muestra nada. Si el plugin no existe (APK viejo) no hace nada
 * y el conductor puede activarlo a mano desde la guía de ajustes.
 */
export async function solicitarExencionBateria(): Promise<void> {
  if (!esNativo()) return;
  try {
    const { registerPlugin } = await import("@capacitor/core");
    const AfaNative = registerPlugin<{ requestBatteryExemption: () => Promise<{ opened: boolean }> }>("AfaNative");
    await AfaNative.requestBatteryExemption();
  } catch { /* plugin ausente / sin soporte → la guía manual cubre el caso */ }
}

/**
 * Pregunta al sistema si la app YA está exenta de la optimización de batería (plugin nativo
 * propio `AfaNative`, APK 28+). Devuelve:
 *   • true  → ya exenta (no hay que molestar al conductor con la guía).
 *   • false → NO exenta (el SO puede matar el GPS → conviene mostrar la guía).
 *   • null  → no se puede saber: web, o APK viejo sin el plugin (no asumir nada).
 * Es de SOLO LECTURA, no abre ningún diálogo.
 */
export async function bateriaExenta(): Promise<boolean | null> {
  if (!esNativo()) return null;
  try {
    const { registerPlugin } = await import("@capacitor/core");
    const AfaNative = registerPlugin<{ isIgnoringBatteryOptimizations: () => Promise<{ value: boolean }> }>("AfaNative");
    const r = await AfaNative.isIgnoringBatteryOptimizations();
    return !!r?.value;
  } catch {
    return null; // plugin ausente (APK viejo) o sin soporte → desconocido
  }
}

/** true si hay alguna forma de geolocalización disponible. */
export function geoDisponible(): boolean {
  if (esNativo()) return true;
  return typeof navigator !== "undefined" && !!navigator.geolocation;
}

/** true si corremos dentro de la app nativa (Capacitor), no en el navegador. */
export function esAppNativa(): boolean {
  return esNativo();
}
