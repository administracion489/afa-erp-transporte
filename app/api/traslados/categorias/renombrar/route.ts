// app/api/traslados/categorias/renombrar/route.ts
// GET  — ?clave=VAN_15 — Lo que pasaría al cambiarle la clave: cuántos precios, fotos y cotizaciones
//        guardadas la llevan. No cambia nada.
// POST — { de, a } — Cambia la CLAVE de una categoría de traslado (VAN_15 → VAN_17) con sus precios
//        (FK en cascada), sus fotos (se mueven a la carpeta de la clave nueva) y las cotizaciones
//        guardadas que la nombran (`traslado_json.categoria.clave`).
//        { de, a, completar: true } — termina uno ya hecho que dejó cotizaciones con la clave vieja.
//
// Las reglas viven en lib/traslados/renombrar-categoria.ts (puro) y renombrar-categoria-datos.ts.
// Lo hace el SERVIDOR porque el bucket `traslados-fotos` no tiene ninguna política de escritura
// (traslados-07): solo la service-role mueve fotos. Módulo «tarifas», como el resto de la pantalla.
// Ningún error de Postgres sale crudo.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { limitarTasa, mismoOrigen, segundosParaReintentar } from "@/lib/api-guard";
import { claveValida } from "@/lib/traslados/fotos-categoria";
import { completarRenombre, previaRenombre, renombrarCategoria } from "@/lib/traslados/renombrar-categoria-datos";

export const maxDuration = 60;

/** Cambios de clave por usuario y minuto (en memoria de la instancia; no medido). */
const LIMITE_POR_MINUTO = 10;

const db = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const responder = (status: number, codigo: string, detalle: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: status < 400, codigo, detalle, ...extra }, { status });

/** Una clave que YA existe se recibe tal cual (sin normalizar): tiene que ser exacta. */
const claveExacta = (v: unknown): string | null => (typeof v === "string" && claveValida(v.trim()) ? v.trim() : null);

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "tarifas");
  if (!auth.ok) return responder(auth.status, "sin_permiso", auth.error);
  const de = claveExacta(req.nextUrl.searchParams.get("clave"));
  if (!de) return responder(400, "entrada_invalida", "Falta la clave de la categoría.");
  try {
    const r = await previaRenombre(db(), de, process.env.NEXT_PUBLIC_SUPABASE_URL);
    if (!r.ok) return responder(r.status, r.codigo, r.detalle);
    return responder(200, "ok", "", { clave: de, ...r.previa });
  } catch (e) {
    console.error("[traslados/renombrar] GET", e instanceof Error ? e.message : e);
    return responder(500, "error", "No se pudo comprobar la categoría. Vuelve a intentarlo en un momento.");
  }
}

export async function POST(req: NextRequest) {
  if (!mismoOrigen(req)) return responder(403, "origen", "Origen no permitido.");
  const auth = await verificarUsuarioApi(req, "tarifas");
  if (!auth.ok) {
    return responder(auth.status, "sin_permiso", auth.status === 403 ? `${auth.error}: la clave de un vehículo de traslado la cambia quien tiene el módulo Tarifas.` : auth.error);
  }
  const tope = `traslados-renombrar:${auth.userId}`;
  if (!limitarTasa(tope, LIMITE_POR_MINUTO, 60_000)) {
    const s = segundosParaReintentar(tope);
    return NextResponse.json({ ok: false, codigo: "tope", detalle: `Demasiados cambios seguidos: espera ${s} s.` }, { status: 429, headers: { "Retry-After": String(s) } });
  }
  const body = (await req.json().catch(() => null)) as { de?: unknown; a?: unknown; completar?: unknown } | null;
  const de = claveExacta(body?.de);
  if (!de) return responder(400, "entrada_invalida", "Falta la clave actual de la categoría.");
  if (typeof body?.a !== "string" || body.a.length > 100) return responder(400, "entrada_invalida", "Escribe la clave nueva (MAYÚSCULAS, sin espacios; p. ej. VAN_17).");

  try {
    const sb = db();
    if (body.completar === true) {
      const a = claveExacta(body.a);
      if (!a) return responder(400, "entrada_invalida", "Falta la clave nueva de la categoría.");
      const r = await completarRenombre(sb, { de, a });
      return NextResponse.json(r, { status: r.status });
    }
    const r = await renombrarCategoria(sb, { de, aTecleada: body.a, supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL });
    return NextResponse.json(r, { status: r.status });
  } catch (e) {
    console.error("[traslados/renombrar] POST", e instanceof Error ? e.message : e);
    return responder(500, "error", "No se pudo cambiar la clave. Recarga la pantalla para ver cómo quedó y vuelve a intentarlo.");
  }
}
