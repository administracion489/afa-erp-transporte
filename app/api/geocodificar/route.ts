// app/api/geocodificar/route.ts
// Geocodifica paradas por nombre usando Google Geocoding API (server-side)
// y guarda las coordenadas de vuelta en la tabla paradas de Supabase.
//
// COSTO: toda la geocodificación pasa por lib/geocode-cache.ts, que cachea por TEXTO y
// además MEMORIZA LOS FALLOS. Antes, una dirección que Google no resuelve (un paradero
// interno tipo "Mz. F Lt. 12") volvía con lat/lng null, no se persistía nada, y se volvía a
// pedir en cada apertura de la pantalla — para siempre. Ese bucle era ~3.600 llamadas/mes
// que nunca podían converger.
//
// Segundo arreglo: varios llamadores mandan paradas que NO existen en la tabla (id 0 desde
// programación, ids negativos sintéticos desde ModalGps y el portal del cliente, que arman
// las paradas desde paradas_json). El UPDATE por id era un no-op silencioso, así que el
// resultado bueno tampoco se guardaba. Ahora eso se detecta explícitamente y la caché por
// texto cubre igualmente el caso.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { guardarGasto, limitarGasto } from "@/lib/api-guard";
import { geocodificarConCache } from "@/lib/geocode-cache";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

type ParadaInput = { id: number; nombre: string };
// `direccion` = formatted_address de Google (dirección normalizada). Se devuelve para que el
// llamador la pueda guardar en `paradas.direccion` en vez del texto crudo que tecleó el operador;
// es null si Google no resolvió o si la entrada venía de una caché antigua sin ese dato.
type ParadaResult = ParadaInput & {
  lat: number | null; lng: number | null; direccion: string | null; geocodificada: boolean;
};

export async function POST(req: NextRequest) {
  try {
    const bloqueo = guardarGasto(req, { etiqueta: "geocodificar" });
    if (bloqueo) return bloqueo;

    const body = await req.json();
    const paradas: ParadaInput[] = body?.paradas;

    if (!paradas || !Array.isArray(paradas) || paradas.length === 0) {
      return NextResponse.json({ error: "Se requiere un array de paradas" }, { status: 400 });
    }

    // Tope de lote: una sola petición dispara N llamadas a Google en paralelo, así que sin
    // este tope el rate limit por petición no acota nada (un POST con 5.000 paradas contaría
    // como uno). 100 cubre de sobra el manifiesto más grande que maneja la operación.
    if (paradas.length > 100) {
      return NextResponse.json(
        { error: `Máximo 100 paradas por petición (llegaron ${paradas.length})` },
        { status: 400 }
      );
    }

    const excedido = limitarGasto(req, { etiqueta: "geocodificar", limite: 40 });
    if (excedido) return excedido;

    const resultados: ParadaResult[] = await Promise.all(
      paradas.map(async (p) => {
        const coords = await geocodificarConCache(p.nombre);
        if (!coords) return { ...p, lat: null, lng: null, direccion: null, geocodificada: false };

        // Solo persistir cuando la parada es una fila real. Un id 0/negativo es una parada
        // sintética armada desde paradas_json: no hay fila que actualizar, y el resultado ya
        // quedó en geocode_cache, que es lo que evita repetir la llamada.
        if (Number(p.id) > 0) {
          const { error } = await supabaseAdmin
            .from("paradas")
            .update({ lat: coords.lat, lng: coords.lng })
            .eq("id", p.id);
          if (error) console.error(`[geocodificar] No se pudo guardar la parada ${p.id}:`, error.message);
        }

        return { ...p, lat: coords.lat, lng: coords.lng, direccion: coords.direccion ?? null, geocodificada: true };
      })
    );

    const exitosas = resultados.filter((r) => r.geocodificada).length;
    console.log(`[geocodificar] ${exitosas}/${paradas.length} paradas geocodificadas`);

    return NextResponse.json({ paradas: resultados, exitosas, total: paradas.length });
  } catch (e: any) {
    console.error("[geocodificar] Exception:", e.message);
    return NextResponse.json({ error: "Error interno: " + e.message }, { status: 500 });
  }
}
