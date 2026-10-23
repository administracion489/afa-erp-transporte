// GET /api/condiciones/[token] — la puerta PÚBLICA de las condiciones de reserva, cambios y
// cancelación de UNA cotización (el enlace y el QR que van en el PDF y en el WhatsApp).
//
// No exige sesión a propósito: el cliente abre el enlace sin usuario. La autorización ES el token —un
// uuid aleatorio y único por cotización (`cotizaciones.condiciones_token`, supabase/cotizaciones-08)—,
// así que todo pasa por service-role aquí y la tabla nunca se expone al navegador.
//
// Lo que sale lo decide `armarCondicionesPublicas` (lib/condiciones-publicas-armar.ts): la política
// GUARDADA EN ESA COTIZACIÓN y su resumen, el número, la fecha y el idioma, y el pie de la empresa.
// Nada del cliente, ni precios, ni cuentas. Se leen SOLO esas columnas.
//
// Errores: 404 `no_existe` (token mal formado o de ninguna cotización: no se distingue cuál) ·
// 404 `sin_condiciones` (la cotización no guardó política) · 404 `sin_migracion` (falta el SQL) ·
// 429 `demasiadas` (30 por minuto por IP, por instancia) · 500 `error` (el detalle va al log, nunca
// a la respuesta). Siempre `no-store` y `noindex`.

import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { ipDe, limitarTasa, segundosParaReintentar } from "@/lib/api-guard";
import { faltaAlguna, faltaColumna } from "@/lib/columna-faltante";
import { DETALLE_CONDICIONES, esTokenCondiciones, type CodigoCondicionesPublicas, type RespuestaCondicionesPublicas } from "@/lib/condiciones-publicas";
import {
  armarCondicionesPublicas, COLS_CONDICIONES_ACCESORIAS, COLS_CONDICIONES_PUBLICAS, COLS_PERFIL_CONDICIONES, type FilaCondiciones,
} from "@/lib/condiciones-publicas-armar";
import type { PerfilEmpresa } from "@/lib/empresa-perfil";
import { MENSAJE_GENERICO } from "@/lib/mensaje-seguro";

export const dynamic = "force-dynamic";

const LIMITE_POR_MINUTO = 30;

const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const CABECERAS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
};

function responder(cuerpo: RespuestaCondicionesPublicas, status: number, extra: Record<string, string> = {}): Response {
  return Response.json(cuerpo, { status, headers: { ...CABECERAS, ...extra } });
}

const error = (codigo: CodigoCondicionesPublicas, status: number, extra: Record<string, string> = {}) =>
  responder({ ok: false, codigo, detalle: codigo === "error" ? MENSAJE_GENERICO : DETALLE_CONDICIONES[codigo] }, status, extra);

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const clave = `condiciones:${ipDe(req)}`;
  if (!limitarTasa(clave, LIMITE_POR_MINUTO, 60_000)) {
    return error("demasiadas", 429, { "Retry-After": String(Math.max(1, segundosParaReintentar(clave))) });
  }
  const { token: crudo } = await params;
  const token = String(crudo ?? "").trim();
  if (!esTokenCondiciones(token)) return error("no_existe", 404);

  try {
    const sb = admin();
    // La cotización, por su token. `idioma_pdf` es accesoria: si el error la nombra, se lee sin ella.
    let cols: string[] = [...COLS_CONDICIONES_PUBLICAS];
    let fila: FilaCondiciones | null = null;
    for (let i = 0; i <= COLS_CONDICIONES_ACCESORIAS.length; i++) {
      const r = await sb.from("cotizaciones").select(cols.join(", ")).eq("condiciones_token", token.toLowerCase()).limit(1).maybeSingle();
      if (!r.error) { fila = (r.data ?? null) as FilaCondiciones | null; break; }
      if (faltaColumna(r.error, "condiciones_token")) return error("sin_migracion", 404);
      const col = faltaAlguna(r.error, COLS_CONDICIONES_ACCESORIAS.filter((c) => cols.includes(c)));
      if (!col) throw new Error(`No se pudo leer la cotización de las condiciones: ${r.error.message}`);
      cols = cols.filter((c) => c !== col);
    }
    if (!fila) return error("no_existe", 404);

    // El pie de la empresa: best-effort (sin perfil, la página sale sin nombre ni logo).
    let perfil: PerfilEmpresa | null = null;
    try {
      const p = await sb.from("empresa_perfil").select(COLS_PERFIL_CONDICIONES).eq("id", 1).maybeSingle();
      if (p.error) console.error("[api/condiciones] perfil:", p.error.message);
      else perfil = (p.data ?? null) as PerfilEmpresa | null;
    } catch (e) {
      console.error("[api/condiciones] perfil:", (e as { message?: string } | null)?.message ?? e);
    }

    const r = armarCondicionesPublicas(fila, perfil);
    return r.ok ? responder(r, 200) : responder(r, 404);
  } catch (e) {
    console.error("[api/condiciones]", (e as { message?: string } | null)?.message ?? e);
    return error("error", 500);
  }
}
