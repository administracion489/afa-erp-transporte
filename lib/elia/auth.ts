// ============================================================
// ELIA — Autenticación de las rutas API (SOLO servidor).
// Mismo patrón canónico que app/api/crear-usuario/route.ts:
// Bearer token → auth.getUser → fila en "usuarios" → permisos_usuario.
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { db, TODOS_LOS_MODULOS, type SB } from "./herramientas";

const supabasePublic = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);

export type UsuarioElia = {
  sb: SB;
  usuarioId: string;
  nombre: string;
  rol: string;
  permisos: string[];
};

export async function autenticarElia(
  request: Request
): Promise<{ ok: true; usuario: UsuarioElia } | { ok: false; status: number; error: string }> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return { ok: false, status: 401, error: "No autorizado" };

  const { data: authData } = await supabasePublic().auth.getUser(token);
  if (!authData?.user) return { ok: false, status: 401, error: "Sesión inválida" };

  const sb = db();
  const { data: perfil } = await sb
    .from("usuarios")
    .select("nombre, rol, activo")
    .eq("id", authData.user.id)
    .maybeSingle();
  if (!perfil || (perfil as any).activo === false)
    return { ok: false, status: 403, error: "Usuario inactivo" };

  const rol = (perfil as any).rol || "operador";
  let permisos: string[] = [];
  if (rol === "admin") {
    permisos = TODOS_LOS_MODULOS;
  } else {
    const { data } = await sb
      .from("permisos_usuario")
      .select("modulo")
      .eq("usuario_id", authData.user.id)
      .eq("permitido", true);
    permisos = ((data as any[]) ?? []).map((p) => p.modulo);
  }

  return {
    ok: true,
    usuario: { sb, usuarioId: authData.user.id, nombre: (perfil as any).nombre || "Usuario", rol, permisos },
  };
}
