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

export const maxDuration = 30;

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
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

    const r = await extraerOdometro(adjunto as Adjunto, { lecciones, guia, placa, digitos: ctxOdo?.kmVigente ? Math.round(ctxOdo.kmVigente).toString().length : null });

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
      corregido: veredicto.origen === "corregido",
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
