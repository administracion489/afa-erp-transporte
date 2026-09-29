// lib/api-auth.ts — SOLO SERVIDOR.
// Verificación de identidad + permiso de módulo para rutas API que gastan dinero o
// tocan datos sensibles. El gate de UI (menú del layout) es evadible llamando la API
// directamente, así que el permiso SE RE-VERIFICA aquí en el servidor
// (mismo criterio que app/api/elia/accion/route.ts).

import { createClient } from "@supabase/supabase-js";

const supabasePublic = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export type AuthResult =
  | { ok: true; userId: string; rol: string }
  | { ok: false; status: number; error: string };

/**
 * Autentica por Bearer y exige que el usuario esté activo y tenga permiso del módulo
 * indicado (admin siempre pasa). Devuelve un objeto discriminado; la ruta decide la
 * respuesta HTTP.
 */
export async function verificarUsuarioApi(req: Request, modulo: string): Promise<AuthResult> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return { ok: false, status: 401, error: "No autorizado" };

  const { data: authData } = await supabasePublic.auth.getUser(token);
  if (!authData.user) return { ok: false, status: 401, error: "Sesión inválida" };

  const { data: perfil } = await supabaseAdmin
    .from("usuarios")
    .select("rol, activo")
    .eq("id", authData.user.id)
    .single();

  if (!perfil?.activo) return { ok: false, status: 403, error: "Usuario inactivo" };
  if (perfil.rol === "admin") return { ok: true, userId: authData.user.id, rol: perfil.rol };

  const { data: permiso } = await supabaseAdmin
    .from("permisos_usuario")
    .select("permitido")
    .eq("usuario_id", authData.user.id)
    .eq("modulo", modulo)
    .maybeSingle();

  if (!permiso?.permitido) return { ok: false, status: 403, error: `Sin permiso del módulo ${modulo}` };
  return { ok: true, userId: authData.user.id, rol: perfil.rol };
}

/**
 * Como `verificarUsuarioApi`, pero pasa con CUALQUIERA de los módulos. Para endpoints que
 * llaman varias pantallas (la invitación al pasajero sale de /clientes, /pasajeros y del
 * manifiesto de /programacion): exigir uno solo dejaría fuera a un operador legítimo de
 * otra pantalla. Lista vacía ≡ basta con ser usuario activo del ERP.
 */
export async function verificarUsuarioApiAlguno(req: Request, modulos: string[]): Promise<AuthResult> {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return { ok: false, status: 401, error: "No autorizado" };

  const { data: authData } = await supabasePublic.auth.getUser(token);
  if (!authData.user) return { ok: false, status: 401, error: "Sesión inválida" };

  const { data: perfil } = await supabaseAdmin
    .from("usuarios")
    .select("rol, activo")
    .eq("id", authData.user.id)
    .single();

  if (!perfil?.activo) return { ok: false, status: 403, error: "Usuario inactivo" };
  if (perfil.rol === "admin" || modulos.length === 0) return { ok: true, userId: authData.user.id, rol: perfil.rol };

  const { data: permisos } = await supabaseAdmin
    .from("permisos_usuario")
    .select("modulo, permitido")
    .eq("usuario_id", authData.user.id)
    .in("modulo", modulos);

  if (!(permisos ?? []).some((p: { permitido: boolean | null }) => p.permitido)) {
    return { ok: false, status: 403, error: `Sin permiso (${modulos.join(" / ")})` };
  }
  return { ok: true, userId: authData.user.id, rol: perfil.rol };
}

/**
 * Secreto de cron en modo FAIL-CLOSED: sin `CRON_SECRET` configurado NO pasa nadie.
 * Antes varias rutas hacían `if (cronSecret && auth !== …)`, o sea que con la variable
 * ausente quedaban abiertas a cualquiera. Mismo criterio que /api/alertas-flota/tick.
 */
export function esCronAutorizado(req: Request): boolean {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) return false;
  return req.headers.get("authorization") === `Bearer ${secreto}`;
}
