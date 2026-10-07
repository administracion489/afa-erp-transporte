// ──────────────────────────────────────────────────────────────────────────────
// lib/pasajero-sesion.ts — El contrato de la sesión del pasajero entre /api/pasajero (escribe la
// marca) y /pasajero (la lee). Sin imports: lo usan el route (servidor) y la página (navegador), y
// así los dos no pueden discrepar sobre qué es «sesión vencida». Gemelo de CUERPO_SESION_INVALIDA
// en lib/conductor-auth.ts.
//
// EL DEFECTO QUE CIERRA: el token del pasajero vence a las 24 h y ninguna acción lo renueva. Con el
// token vencido, cada consulta de la app devolvía 401 «Sesión inválida» y la app se lo tragaba: la
// pantalla seguía con el nombre del pasajero, congelada en «Bus aún no inicia» o «No tienes ruta
// asignada hoy», sin decir nada. Y la sesión guardada en el teléfono podía durar MÁS que el token:
// cada refresco sin token nuevo (la foto vigente al abrir, subir foto, guardar datos) la estiraba a
// «ahora + 24 h», así que al reabrir la app no pedía el DNI y todo fallaba igual.
//
// Ahora el servidor marca el 401 (`sesionInvalida`), la app vuelve al login con un aviso, y la sesión
// guardada vence cuando vence el token, nunca después.
// ──────────────────────────────────────────────────────────────────────────────

export const AVISO_SESION_VENCIDA = "Tu sesión venció, vuelve a ingresar.";

/**
 * Cuerpo del 401 de sesión inválida o vencida. Un 401 SIN `sesionInvalida` (el de la llave
 * x-afa-key) NO desloguea: volver a ingresar no lo arregla y el pasajero entraría en un bucle.
 */
export const CUERPO_SESION_INVALIDA = { error: AVISO_SESION_VENCIDA, sesionInvalida: true } as const;

export function esSesionInvalida(estado: number, json: unknown): boolean {
  return estado === 401 && (json as { sesionInvalida?: unknown } | null)?.sesionInvalida === true;
}

/** base64url → texto, en el navegador y en Node. */
function decodificarBase64Url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const relleno = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  if (typeof atob === "function") return atob(relleno);
  return Buffer.from(relleno, "base64").toString("binary");
}

/**
 * El vencimiento (ms epoch) que trae el token `{pid, exp}` firmado por lib/pasajero-auth.ts. NO
 * verifica la firma —el teléfono no tiene el secreto—: solo sirve para que la app no se crea
 * vigente con un token que el servidor ya rechaza. Ilegible → null.
 */
export function expDeToken(token: unknown): number | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  try {
    const exp = JSON.parse(decodificarBase64Url(token.split(".")[0]))?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/**
 * Hasta cuándo vale la sesión guardada en el teléfono: el MENOR entre lo guardado y lo que dice el
 * token. Tomar el menor corrige también las sesiones que la versión anterior ya había estirado.
 * Sin ninguno de los dos, vencida (0).
 */
export function vencimientoSesion(expGuardado: unknown, token: unknown): number {
  const guardado = typeof expGuardado === "number" && Number.isFinite(expGuardado) ? expGuardado : Infinity;
  const v = Math.min(guardado, expDeToken(token) ?? Infinity);
  return Number.isFinite(v) ? v : 0;
}
