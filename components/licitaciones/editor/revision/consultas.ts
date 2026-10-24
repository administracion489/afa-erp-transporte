"use client";
// components/licitaciones/editor/revision/consultas.ts — Las dos lecturas LIVIANAS que necesita el paso
// «Revisión y emisión» y que lib/licitaciones/datos.ts no trae: la versión guardada en la base (para no
// emitir una versión vieja si otra persona guardó sin que este editor tuviera cambios pendientes) y el
// nombre de quien acepta un hallazgo. Las dos son best-effort con su motivo: ninguna escribe nada.
import { supabase } from "@/lib/supabase";

const msg = (e: unknown) => {
  if (!e) return "";
  if (typeof e === "string") return e;
  const o = e as { message?: unknown };
  return String(o.message ?? e);
};

export type VersionEnBase = { ok: true; version: number; en: string | null } | { ok: false; error: string };

/** La `version` que tiene HOY la fila de la licitación (solo esa columna y la hora del último guardado). */
export async function versionEnBase(id: number): Promise<VersionEnBase> {
  try {
    const { data, error } = await supabase.from("licitaciones").select("version, actualizado_en").eq("id", id).maybeSingle();
    if (error) {
      const m = msg(error);
      if (/row-level security|permission denied/i.test(m) || String(error.code ?? "") === "42501") {
        return { ok: false, error: "Tu usuario no puede leer esta licitación en la base (módulo Licitaciones)." };
      }
      if (/failed to fetch|network|load failed/i.test(m)) return { ok: false, error: "No hay conexión con la base." };
      return { ok: false, error: `La base respondió: ${m.slice(0, 200)}` };
    }
    if (!data) return { ok: false, error: "La licitación ya no está en la base (o tu usuario no puede leerla)." };
    const v = Number(data.version);
    if (!Number.isSafeInteger(v)) return { ok: false, error: "La base no devolvió la versión de la licitación." };
    return { ok: true, version: v, en: typeof data.actualizado_en === "string" ? data.actualizado_en : null };
  } catch (e) {
    return { ok: false, error: msg(e) || "error inesperado" };
  }
}

/** El nombre del usuario con sesión (usuarios.nombre). null si no se pudo saber: nunca se inventa. */
export async function nombreUsuarioActual(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const uid = data?.session?.user?.id;
    if (!uid) return null;
    const r = await supabase.from("usuarios").select("nombre").eq("id", uid).maybeSingle();
    const n = typeof r?.data?.nombre === "string" ? r.data.nombre.trim() : "";
    return n || null;
  } catch {
    return null;
  }
}
