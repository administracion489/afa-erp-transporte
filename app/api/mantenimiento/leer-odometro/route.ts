// app/api/mantenimiento/leer-odometro/route.ts
// Recibe la foto del odómetro y devuelve el km leído (para pre-llenar el form).
//
// Este endpoint es el camino de lectura de TODO lo que no es el Radar: el checklist y el
// inicio/fin de servicio de la app del conductor, /mantenimiento y /tercerizadas. Si el caller
// dice de qué vehículo es la foto (opcional, retrocompatible), se le pasa a la IA lo que el
// ERP ya sabe de esa unidad —la guía de su tablero y cuántos dígitos tiene su odómetro— y el
// número leído se contrasta contra el km vigente antes de devolverlo. Sin esos parámetros el
// comportamiento es exactamente el de antes.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { extraerOdometro, type Adjunto } from "@/lib/vision-ia";
import { leccionesOdometro, contextoOdometro, type Flota } from "@/lib/odometro";
import { elegirOdometro } from "@/lib/odometro-seleccion";
import { formaOdometro } from "@/lib/odometro-prompt";
import { verificarUsuarioApiAlguno } from "@/lib/api-auth";
import { sesionDeToken } from "@/lib/conductor-auth";

export const maxDuration = 30;

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Dos clases de llamador legítimo, y ninguna anónima (gasta visión de Claude y lee el km y la
 * guía del tablero de cualquier unidad):
 *   - el CONDUCTOR, con el token de sesión que emite su login (lib/conductor-auth.ts). Se
 *     acepta en `body.token` (igual que /api/conductor), en `x-conductor-token` o como Bearer;
 *   - un usuario del ERP con Bearer de Supabase y el módulo de la pantalla que lee: odómetro
 *     de /mantenimiento, modal de /tercerizadas (`proveedores`) o /combustible.
 * El token del conductor se prueba PRIMERO porque es una verificación local (HMAC, sin red).
 */
async function autorizado(req: NextRequest, body: { token?: unknown } | null): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const bearer = req.headers.get("authorization")?.replace("Bearer ", "") ?? null;
  const candidatos = [body?.token, req.headers.get("x-conductor-token"), bearer];
  if (candidatos.some(t => sesionDeToken(t))) return { ok: true };
  const r = await verificarUsuarioApiAlguno(req, ["mantenimiento", "proveedores", "combustible"]);
  return r.ok ? { ok: true } : { ok: false, status: r.status, error: r.error };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const auth = await autorizado(req, body);
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
    const { adjunto } = body;
    if (!adjunto?.data) {
      return NextResponse.json({ ok: false, error: "Falta la foto del odómetro" }, { status: 400 });
    }
    const vehiculoId = Number(body?.vehiculo_id) > 0 ? Number(body.vehiculo_id) : null;
    const flota: Flota = body?.flota === "tercero" ? "tercero" : "propia";

    const sb = admin();

    // Contexto de la unidad (best-effort: si algo falla se lee igual, sin contexto).
    let guia: string | null = null;
    let placa: string | null = null;
    let ctxOdo: Awaited<ReturnType<typeof contextoOdometro>> | null = null;
    if (sb && vehiculoId) {
      try {
        const tabla = flota === "tercero" ? "vehiculos_tercero" : "vehiculos";
        const { data: v } = await sb.from(tabla).select("placa, guia_odometro").eq("id", vehiculoId).maybeSingle();
        guia = (v as any)?.guia_odometro ?? null;
        placa = (v as any)?.placa ?? null;
        // Si el id no existe en la tabla indicada, NO se busca en la otra: los ids se solapan
        // entre flotas y usar el vehículo equivocado daría un ancla ajena.
        if (v) ctxOdo = await contextoOdometro(sb, { vehiculo_id: vehiculoId, flota });
      } catch (e) {
        console.warn("[leer-odometro] sin contexto del vehículo:", e);
      }
    }

    let lecciones = "";
    if (sb) {
      try {
        lecciones = await leccionesOdometro(sb, { placa });
      } catch (e) {
        console.warn("[leer-odometro] sin lecciones:", e);
      }
    }

    // La FORMA del número, nunca el km: cuántas cifras y si está por pasar a la siguiente
    // (lib/odometro-prompt.ts → formaOdometro).
    const forma = formaOdometro(ctxOdo?.kmVigente);
    const r = await extraerOdometro(adjunto as Adjunto, { lecciones, guia, placa, digitos: forma?.cifras ?? null, puedeSubir: forma?.puedeSubir ?? false });

    // El número leído contra lo que el ERP sabe de la unidad: si la IA cruzó el parcial con el
    // total, aquí se corrige; si devolvió algo imposible, se avisa (auto_ok=false) para que la
    // UI no lo pre-llene en silencio.
    const veredicto = elegirOdometro({
      kmIA: r.km > 0 ? r.km : null,
      tripIA: r.trip_km,
      textoLeido: r.texto_leido,
      kmVigente: ctxOdo?.kmVigente ?? 0,
      kmDiaMax: ctxOdo?.kmDiaMax ?? 1500,
      horasDesdeUltima: ctxOdo?.horasDesdeUltima ?? null,
      hayHistorial: ctxOdo?.hayHistorial ?? false,
    });
    const kmFinal = veredicto.km ?? 0;

    // Los dos alias van SIEMPRE con el mismo valor: la app del conductor lee `kilometraje` y
    // las pantallas de mantenimiento leen `km`; si difirieran, un carril se quedaría con el
    // número crudo de la IA. El original queda en `km_ia` para auditoría.
    return NextResponse.json({
      ok: true,
      km: kmFinal,
      kilometraje: kmFinal,
      km_ia: r.km,
      trip_km: r.trip_km,
      auto_ok: veredicto.autoOk,
      motivo_seleccion: veredicto.motivo,
      // La pantalla enruta por CÓDIGO, no olfateando el texto del motivo: "sobra un dígito"
      // tiene un arreglo distinto de "puede ser un eco" o de "la IA entregó el parcial".
      codigo_seleccion: veredicto.codigo,
      corregido: veredicto.origen === "corregido",
      // El número lo DEDUJO el ERP (no lo transcribió el modelo): se pre-llena para que la
      // persona lo coteje contra la foto, nunca para que pase de largo.
      confirmar: veredicto.confirmar === true,
      confianza: r.confianza,
      calidad_imagen: r.calidad_imagen,
      motivo: r.motivo,
      texto_leido: r.texto_leido,
    });
  } catch (e: any) {
    console.error("[mantenimiento/leer-odometro]", e);
    return NextResponse.json({ ok: false, error: e?.message || "Error al leer el odómetro" }, { status: 500 });
  }
}
