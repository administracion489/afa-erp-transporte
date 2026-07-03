// lib/push-cliente.ts — LADO CLIENTE de las notificaciones push del pasajero.
// (Separado de app/pasajero/page.tsx para no engordar más ese archivo.)
//
// Cascada de runtime — el MISMO JS desplegado corre en 4 mundos distintos:
//   1. App Capacitor de Play Store CON plugin (APK v14+)  → FCM nativo.
//   2. App Capacitor SIN plugin (APK viejo)               → 'app-desactualizada'
//      (dentro del WebView NO existe Push API: solo queda actualizar la app).
//   3. Navegador con Push API (Android Chrome, PWA, iOS 16.4+ INSTALADA) → Web Push.
//   4. iOS Safari suelto (sin instalar) → 'ios-instalar' (guiar a "Añadir a inicio").
//
// El permiso de notificaciones SIEMPRE debe pedirse desde un gesto del usuario y
// SIN awaits de red interpuestos: en iOS la activación transitoria del tap expira
// en segundos y requestPermission() se resuelve "denied" sin mostrar el diálogo.
//
// Opt-in explícito por aparato: el flag OPTIN_LS se escribe cuando el usuario
// ACTIVA y se borra cuando QUITA. resincronizarSuscripcion lo respeta — sin él,
// jamás re-suscribe. Esto mantiene el opt-out en la app nativa (donde el permiso
// del SO sigue "granted" tras quitar) y evita auto-suscribir en Android ≤ 12
// (sin POST_NOTIFICATIONS, checkPermissions devuelve granted de fábrica).

import { Capacitor } from "@capacitor/core";
import { esAppNativa } from "@/lib/geo";

export type SoportePush = "fcm" | "webpush" | "ios-instalar" | "app-desactualizada" | "no-soportado";
export type ResultadoActivar = "activo" | "denegado" | "error";

type PaxApi = (accion: string, params?: Record<string, any>) => Promise<any>;

// Último token FCM registrado (para poder desuscribir: el plugin no expone un
// getter del token fuera del listener de registro).
const FCM_LS = "afa_push_fcm_token";
// Opt-in del usuario EN ESTE APARATO (gobierna la resincronización).
const OPTIN_LS = "afa_push_optin_v1";

function esIOSNav(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function esStandalone(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || !!(navigator as any).standalone;
  } catch { return false; }
}

function plataformaActual(): string {
  if (esAppNativa()) return "android-app";
  if (esIOSNav()) return esStandalone() ? "ios-pwa" : "ios-web";
  return esStandalone() ? "android-pwa" : "android-web";
}

function marcarOptin(v: boolean) {
  try { v ? localStorage.setItem(OPTIN_LS, "1") : localStorage.removeItem(OPTIN_LS); } catch {}
}
function tieneOptin(): boolean {
  try { return localStorage.getItem(OPTIN_LS) === "1"; } catch { return false; }
}

// https://developer.mozilla.org/docs/Web/API/PushManager/subscribe#applicationserverkey
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

export function detectarSoportePush(): SoportePush {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "no-soportado";
  if (esAppNativa()) {
    try {
      if (Capacitor.isPluginAvailable("PushNotifications")) return "fcm";
    } catch { /* bridge raro → tratar como APK viejo */ }
    return "app-desactualizada";
  }
  if ("serviceWorker" in navigator && "PushManager" in window && "Notification" in window) {
    return "webpush"; // en iOS esto solo es true dentro de la PWA instalada (16.4+)
  }
  if (esIOSNav() && !esStandalone()) return "ios-instalar";
  return "no-soportado";
}

/** ¿El permiso del navegador ya está bloqueado? (para mostrar el hint correcto) */
export function permisoBloqueado(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "denied";
}

// ── WEB PUSH (navegador / PWA) ────────────────────────────────────────────────

export async function activarPushWeb(api: PaxApi): Promise<ResultadoActivar> {
  try {
    // PRIMERO el permiso, síncrono con el tap — cualquier await de red antes
    // consume la activación transitoria en iOS y el diálogo ni aparece.
    const permiso = await Notification.requestPermission();
    if (permiso !== "granted") return "denegado";
    const reg = await navigator.serviceWorker.ready;
    // Garantizar que el SW con el listener `push` (afa-v5) esté instalado antes de
    // suscribir; skipWaiting + clients.claim del propio SW hacen el resto.
    try { await reg.update(); } catch {}
    const clave = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    if (!clave) { console.warn("[push] falta NEXT_PUBLIC_VAPID_PUBLIC_KEY"); return "error"; }
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(clave) as BufferSource,
    });
    await api("suscribir_push", { tipo: "webpush", sub: sub.toJSON(), plataforma: plataformaActual() });
    marcarOptin(true);
    return "activo";
  } catch (e: any) {
    console.warn("[push] activar web falló:", e?.message);
    return "error";
  }
}

// ── FCM NATIVO (app Capacitor de Play Store, APK v14+) ───────────────────────

// register() + espera del token con LIMPIEZA de listeners (llamarlo en cada
// apertura sin limpiar acumularía un listener por sesión).
async function registrarYObtenerToken(PushNotifications: any, timeoutMs: number): Promise<string | null> {
  let hReg: any = null, hErr: any = null;
  try {
    return await new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
      const timer = setTimeout(() => finish(null), timeoutMs);
      PushNotifications.addListener("registration", (t: any) => { clearTimeout(timer); finish(t?.value ?? null); })
        .then((h: any) => { hReg = h; }).catch(() => {});
      PushNotifications.addListener("registrationError", () => { clearTimeout(timer); finish(null); })
        .then((h: any) => { hErr = h; }).catch(() => {});
      PushNotifications.register().catch(() => { clearTimeout(timer); finish(null); });
    });
  } finally {
    try { hReg?.remove(); } catch {}
    try { hErr?.remove(); } catch {}
  }
}

export async function activarPushNativo(api: PaxApi): Promise<ResultadoActivar> {
  try {
    const { PushNotifications } = await import("@capacitor/push-notifications");
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== "granted") return "denegado";
    // Canal Android con importancia máxima: heads-up + lock screen para los avisos del viaje.
    try {
      await PushNotifications.createChannel({
        id: "afa_viaje", name: "Avisos de tu viaje",
        description: "Tu bus salió, está llegando o llegó a tu paradero",
        importance: 5, visibility: 1, vibration: true,
      });
    } catch { /* iOS o canal ya existente */ }

    const token = await registrarYObtenerToken(PushNotifications, 15000);
    if (!token) return "error";

    try { localStorage.setItem(FCM_LS, token); } catch {}
    await api("suscribir_push", { tipo: "fcm", fcmToken: token, plataforma: "android-app" });
    marcarOptin(true);
    return "activo";
  } catch (e: any) {
    console.warn("[push] activar nativo falló:", e?.message);
    return "error";
  }
}

// ── DESACTIVAR ────────────────────────────────────────────────────────────────
// Borra el opt-in local SIEMPRE (aunque la llamada a la API falle): así la
// resincronización del próximo mount no revive la suscripción.

export async function desactivarPush(api: PaxApi): Promise<boolean> {
  marcarOptin(false);
  try {
    if (esAppNativa()) {
      const t = localStorage.getItem(FCM_LS);
      try { localStorage.removeItem(FCM_LS); } catch {}
      if (t) await api("desuscribir_push", { fcmToken: t });
      return true;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      // unsubscribe PRIMERO (corta el aparato aunque la API falle); la fila del
      // servidor igual se poda sola con 410 en el próximo envío si esto falla.
      try { await sub.unsubscribe(); } catch {}
      await api("desuscribir_push", { endpoint: sub.endpoint });
    }
    return true;
  } catch (e: any) {
    console.warn("[push] desactivar falló:", e?.message);
    return false;
  }
}

// ── RESINCRONIZACIÓN (cada apertura de la app, best-effort) ───────────────────
// El navegador puede ROTAR el endpoint de la suscripción y el SW no puede
// re-registrarla solo (no tiene acceso al token de sesión en localStorage).
// Por eso en cada apertura, si el usuario OPTÓ POR AVISOS EN ESTE APARATO y el
// permiso sigue concedido, se re-POSTea la suscripción vigente (idempotente).
// Devuelve true si el pasajero tiene push operativo en ESTE aparato.

export async function resincronizarSuscripcion(api: PaxApi): Promise<boolean> {
  try {
    if (!tieneOptin()) return false; // el usuario nunca activó (o quitó) aquí
    if (esAppNativa()) {
      if (!Capacitor.isPluginAvailable("PushNotifications")) return false;
      const { PushNotifications } = await import("@capacitor/push-notifications");
      const perm = await PushNotifications.checkPermissions();
      if (perm.receive !== "granted") return false;
      const token = await registrarYObtenerToken(PushNotifications, 10000);
      if (!token) return !!localStorage.getItem(FCM_LS); // sin señal: asumir lo último conocido
      try { localStorage.setItem(FCM_LS, token); } catch {}
      await api("suscribir_push", { tipo: "fcm", fcmToken: token, plataforma: "android-app" });
      return true;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || typeof Notification === "undefined") return false;
    if (Notification.permission !== "granted") return false;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    await api("suscribir_push", { tipo: "webpush", sub: sub.toJSON(), plataforma: plataformaActual() });
    return true;
  } catch {
    return false;
  }
}
