// lib/push-endpoint.ts — ¿A qué dirección le puede mandar el servidor una notificación web?
// Módulo PURO.
//
// SOLO A LOS SERVICIOS PUSH DE LOS NAVEGADORES. El endpoint de una suscripción lo declara el
// teléfono, y el servidor le hace un POST cada vez que sale un aviso. Sin esta lista, una
// suscripción falsa convertía al ERP en un cliente HTTP que cualquiera con sesión de conductor o
// de pasajero podía apuntar a donde quisiera — y desde el botón «Probar» de la notificación, cuando
// quisiera (revisión de seguridad, 11-10-2026).
//
// Los que hay: Chrome, Android, Samsung y Opera usan FCM; Firefox, el de Mozilla; Edge, el de
// Windows; Safari e iPhone, el de Apple. Un servicio nuevo que no esté aquí no se suscribe: se ve
// en el error de la suscripción y se agrega a la lista.

const HOSTS = new Set([
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);
const SUFIJOS = [".notify.windows.com", ".push.apple.com"];

export function endpointPushValido(endpoint?: string | null): boolean {
  if (!endpoint || endpoint.length > 1000) return false;
  let u: URL;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const h = u.hostname.toLowerCase();
  return HOSTS.has(h) || SUFIJOS.some((s) => h.endsWith(s) && h.length > s.length);
}
