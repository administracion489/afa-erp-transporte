// lib/app-nativa-destino.ts
// Dentro de un APK (Capacitor) el ERP NO existe: el APK del conductor carga /conductor y el del
// pasajero /pasajero. Si el WebView aterriza en otra ruta —la raíz "/" (que redirige a /login),
// una recarga o la actividad recreada por Android al volver de Waze/Maps— el layout del ERP lo
// mandaba al «Login ERP», que el conductor no puede usar (entra con documento y PIN).
//
// Este módulo decide a dónde devolverlo. PURO salvo `leerEntorno`/`recordarApp`, que tocan window.

export const LS_APP_NATIVA = "afa_app_nativa_v1";
export type AppNativa = "/conductor" | "/pasajero";

/** ¿Es la ruta de una de las dos apps? (/conductor-tercero NO: es un enlace web con token). */
export function appDeRuta(pathname: string): AppNativa | null {
  if (pathname === "/conductor" || pathname.startsWith("/conductor/")) return "/conductor";
  if (pathname === "/pasajero" || pathname.startsWith("/pasajero/")) return "/pasajero";
  return null;
}

/**
 * A dónde mandar al WebView nativo que está en una ruta del ERP. null = no tocar nada
 * (navegador normal, o no se sabe de qué app es: entonces sigue el flujo de siempre).
 * Orden: la app recordada en este teléfono → el plugin propio del APK del conductor.
 */
export function destinoAppNativa(e: {
  nativa: boolean;
  esRutaPublica: boolean;
  guardado: string | null;
  tieneAfaNative: boolean;
}): AppNativa | null {
  if (!e.nativa || e.esRutaPublica) return null;
  if (e.guardado === "/conductor" || e.guardado === "/pasajero") return e.guardado;
  if (e.tieneAfaNative) return "/conductor";
  return null;
}

type CapGlobal = { isNativePlatform?: () => boolean; isPluginAvailable?: (n: string) => boolean };

export function leerEntorno(): { nativa: boolean; guardado: string | null; tieneAfaNative: boolean } {
  if (typeof window === "undefined") return { nativa: false, guardado: null, tieneAfaNative: false };
  const cap = (window as unknown as { Capacitor?: CapGlobal }).Capacitor;
  let nativa = false;
  let tieneAfaNative = false;
  try { nativa = !!cap?.isNativePlatform?.(); } catch {}
  try { tieneAfaNative = !!cap?.isPluginAvailable?.("AfaNative"); } catch {}
  let guardado: string | null = null;
  try { guardado = localStorage.getItem(LS_APP_NATIVA); } catch {}
  return { nativa, guardado, tieneAfaNative };
}

/** En el APK, recuerda qué app es para poder volver a ella. */
export function recordarApp(pathname: string) {
  const app = appDeRuta(pathname);
  if (!app) return;
  const { nativa } = leerEntorno();
  if (!nativa) return;
  try { localStorage.setItem(LS_APP_NATIVA, app); } catch {}
}
