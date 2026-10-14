// ══════════════════════════════════════════════════════════════════════════════
// app/api/comisiones/puente/route.ts
// Poblar el PUENTE `personal_administrativo.usuario_id`: el login es un usuarios.id (=
// auth.uid()) y el administrativo tiene su propio id. Sin este puente, un administrativo no
// ve su parte del fondo por RLS (fase 03/04). Lo llena el backend cuando el administrativo
// también es usuario del ERP.
//
// DOS MODOS:
//   · Explícito: { personalAdministrativoId, usuarioId } — fija UN mapeo (lo decide un admin).
//   · Auto:      { auto: true } — best-effort SOLO cuando el nombre identifica a UN único
//                usuario activo (mismo criterio INEQUÍVOCO que el backfill de vendedor_id en
//                comisiones-02). Lo ambiguo queda sin tocar para asignación manual.
//
// QUIÉN: SOLO admin.
// ══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { faltaColumna } from "@/lib/columna-faltante";

export const maxDuration = 60;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const sinColumna = () =>
  NextResponse.json(
    { error: "sin_migracion: falta la columna personal_administrativo.usuario_id (correr supabase/comisiones-03-clasificaciones-y-pruebas.sql)" },
    { status: 422 },
  );

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "comisiones");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (auth.rol !== "admin") {
    return NextResponse.json({ error: "Solo un administrador puede poblar el puente usuario ↔ administrativo." }, { status: 403 });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // ── Modo explícito ──
    if (body?.personalAdministrativoId != null) {
      const paId = Number(body.personalAdministrativoId);
      const usuarioId = body?.usuarioId != null ? String(body.usuarioId) : null; // null = desvincular
      if (!Number.isFinite(paId) || paId <= 0) {
        return NextResponse.json({ error: "personalAdministrativoId inválido." }, { status: 400 });
      }
      const { error } = await admin.from("personal_administrativo").update({ usuario_id: usuarioId }).eq("id", paId);
      if (error) {
        if (faltaColumna(error, "usuario_id")) return sinColumna();
        throw error;
      }
      return NextResponse.json({ ok: true, modo: "explicito", personalAdministrativoId: paId, usuarioId });
    }

    // ── Modo auto (match inequívoco por nombre) ──
    if (body?.auto === true) {
      let pas: any[];
      try {
        const { data, error } = await admin
          .from("personal_administrativo")
          .select("id,nombre,usuario_id")
          .is("usuario_id", null);
        if (error) throw error;
        pas = (data as any[]) ?? [];
      } catch (e: any) {
        if (faltaColumna(e, "usuario_id")) return sinColumna();
        throw e;
      }

      const { data: usuarios } = await admin.from("usuarios").select("id,nombre,activo");
      const activos = ((usuarios as any[]) ?? []).filter((u) => u.activo !== false);
      // nombre normalizado → lista de usuarios que lo llevan (para exigir unicidad).
      const porNombre = new Map<string, any[]>();
      for (const u of activos) {
        const k = String(u.nombre ?? "").trim().toLowerCase();
        if (!k) continue;
        (porNombre.get(k) ?? porNombre.set(k, []).get(k)!).push(u);
      }

      let vinculados = 0;
      const ambiguos: number[] = [];
      for (const pa of pas) {
        const k = String(pa.nombre ?? "").trim().toLowerCase();
        const candidatos = porNombre.get(k) ?? [];
        if (candidatos.length === 1) {
          const { error } = await admin
            .from("personal_administrativo")
            .update({ usuario_id: candidatos[0].id })
            .eq("id", pa.id)
            .is("usuario_id", null);
          if (!error) vinculados += 1;
        } else if (candidatos.length > 1) {
          ambiguos.push(Number(pa.id));
        }
      }
      return NextResponse.json({ ok: true, modo: "auto", vinculados, ambiguos, sin_match: pas.length - vinculados - ambiguos.length });
    }

    return NextResponse.json({ error: "Pasa { personalAdministrativoId, usuarioId } o { auto: true }." }, { status: 400 });
  } catch (e: any) {
    console.error("[comisiones/puente]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
