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
  if (esNativo()) {
    try {
      // Verificar que el permiso de ubicación ya fue concedido ANTES de iniciar el
      // foreground service. En Android 15 / MIUI, llamar startForegroundService() sin
      // permiso previo hace que el servicio no pueda llamar startForeground() a tiempo
      // → ANR. Si no hay permiso, caemos al GPS de primer plano sin crashear.
      const Geolocation = await plugin();
      const perm = await conTimeout(Geolocation.checkPermissions(), 3000).catch(() => null);
      const tienePermiso = perm && (perm.location === "granted" || perm.coarseLocation === "granted");
      if (!tienePermiso) {
        _bgActivo = false;
        return observarUbicacion(onPos, onError);
      }

      // Arrancar GPS en PRIMER PLANO de inmediato para no perder cobertura.
      // En paralelo esperamos 4 s antes de iniciar el foreground service:
      // en MIUI / HyperOS Android 15 el sistema suspende servicios que se lanzan
      // en los primeros segundos (battery optimization). Pasados ~4 s la app está
      // "activa en pantalla" y MIUI permite startForeground() → sin ANR.
      // En celulares normales el GPS de fondo arranca a los 4 s; durante ese tiempo
      // el GPS de primer plano ya entregó posiciones sin ningún hueco.
      const fgWatch = await observarUbicacion(onPos, onError);
      await new Promise<void>((r) => setTimeout(r, 4000));
      fgWatch.clear();

      const { BackgroundGeolocation } = await import("@capgo/background-geolocation");
      await BackgroundGeolocation.start(
        {
          backgroundTitle: "AFA · rastreo activo",
          backgroundMessage: "Enviando tu ubicación durante el viaje",
          requestPermissions: false,
          stale: false,
          distanceFilter: 30,
        },
        (location, error) => {
          if (error) { onError?.({ message: error.message || "Error de GPS en segundo plano", code: (error as any).code }); return; }
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
        },
      );
      _bgActivo = true;
      return { clear: () => { _bgActivo = false; void BackgroundGeolocation.stop().catch(() => {}); } };
    } catch (e: any) {
      // Plugin nativo ausente en este build → fallback a primer plano (sin romper nada).
      _bgActivo = false;
      console.warn("[geo] background-geolocation no disponible, fallback a primer plano:", e?.message);
      return observarUbicacion(onPos, onError);
    }
  }
  return observarUbicacion(onPos, onError);
}

/** Abre los ajustes de la app para conceder "Permitir todo el tiempo" (Android 11+). */
export async function abrirAjustesUbicacion(): Promise<void> {
  if (!esNativo()) return;
  try {
    const { BackgroundGeolocation } = await import("@capgo/background-geolocation");
    await BackgroundGeolocation.openSettings();
  } catch { /* noop */ }
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
