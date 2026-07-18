// lib/portal-sesion.ts
// Sesión del PORTAL CLIENTE (localStorage) + helper de llamada a POST /api/cliente.
// Compartido entre app/cliente/page.tsx y los componentes del portal (p. ej.
// ModalManifiestoPortal), para que todos lean el MISMO token sin pasarlo por props.
//
// La sesión guarda { c: cliente, u: usuario, token, exp }. El token lo emite
// /api/cliente (acción login) y viaja en cada acción; sin token válido el servidor
// responde 401 y el portal vuelve a la pantalla de login. Sesiones viejas (sin
// token, de antes de esta migración) se consideran expiradas.

const SK = "afa_cliente_portal_v2";

export type SesionPortal = { c: any; u: any; token: string };

export function saveSession(c: any, u: any, token: string) {
  localStorage.setItem(SK, JSON.stringify({ c, u, token, exp: Date.now() + 8 * 3600000 }));
}

export function loadSession(): SesionPortal | null {
  try {
    const r = localStorage.getItem(SK);
    if (!r) return null;
    const { c, u, token, exp } = JSON.parse(r);
    if (Date.now() > exp || !token || !c) { localStorage.removeItem(SK); return null; }
    return { c, u: u || null, token };
  } catch { return null; }
}

export function clearSession() { localStorage.removeItem(SK); }

export function getPortalToken(): string | null { return loadSession()?.token ?? null; }

export type RespuestaPortal = { ok: boolean; status: number; data: any };

// Llama a una acción de POST /api/cliente adjuntando el token de la sesión.
// Nunca lanza: errores de red devuelven { ok:false, status:0 } para que los
// consumidores conserven su estado previo (falla transitoria).
export async function portalApi(accion: string, params: Record<string, unknown> = {}): Promise<RespuestaPortal> {
  try {
    const res = await fetch("/api/cliente", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accion, token: getPortalToken(), ...params }),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}
