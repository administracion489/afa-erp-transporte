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
      const actual = await Geolocation.checkPermissions();
      if (actual.location === "granted" || actual.coarseLocation === "granted") {
        return "granted";
      }
      const res = await Geolocation.requestPermissions({ permissions: ["location"] });
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
    const p = await Geolocation.getCurrentPosition({
      enableHighAccuracy: opts.enableHighAccuracy ?? true,
      timeout: opts.timeout ?? 10000,
      maximumAge: opts.maximumAge ?? 0,
    });
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
  if (esNativo()) {
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
    return { clear: () => { void Geolocation.clearWatch({ id }); } };
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => onPos(pos as GeoPos),
    (err) => onError?.(err),
    opts
  );
  return { clear: () => navigator.geolocation.clearWatch(id) };
}

/** true si hay alguna forma de geolocalización disponible. */
export function geoDisponible(): boolean {
  if (esNativo()) return true;
  return typeof navigator !== "undefined" && !!navigator.geolocation;
}
