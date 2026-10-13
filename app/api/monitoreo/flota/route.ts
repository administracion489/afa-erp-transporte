// app/api/monitoreo/flota/route.ts
// LA ÚLTIMA POSICIÓN DE CADA UNIDAD DE LA FLOTA, para el mapa de /monitoreo.
//
// GET /api/monitoreo/flota → RespuestaFlotaMonitoreo (lib/monitoreo-estado.ts)
//   · módulo `monitoreo`, verificado SIEMPRE antes de servir la caché;
//   · lee con service-role: las unidades vigentes de `vehiculos` y `vehiculos_tercero`, una consulta
//     por unidad a `ubicaciones_gps` (lib/monitoreo-datos.ts) y el umbral del «no inició»;
//   · caché en memoria de 30 s COMPARTIDA por todos los usuarios, y las peticiones simultáneas
//     comparten UN solo cálculo (patrón de /api/seguimiento/rastreo): con diez pestañas abiertas
//     sondeando cada minuto, la base ve un cálculo cada 30 s, no diez;
//   · devuelve SOLO el contrato: posiciones (ids de unidad, conductor y servicio, nunca nombres ni
//     teléfonos), las unidades que no se pudieron leer y si la lectura quedó parcial.
// LEE, no escribe nada. La pantalla juzga cada unidad con el mismo motor puro y la mueve entre
// sondeos con el realtime (`fusionarPosicion`).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { flotaMonitoreo } from "@/lib/monitoreo-datos";
import type { RespuestaFlotaMonitoreo } from "@/lib/monitoreo-estado";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/** Cuánto vale un cálculo, contado desde que TERMINÓ: un cálculo lento (la base cargada) no se
 *  repite a los pocos segundos de entregarse. Entre sondeos, el realtime mueve las unidades. */
const TTL_MS = 30_000;
const NO_STORE = { "Cache-Control": "no-store" };

let cache: { at: number; payload: RespuestaFlotaMonitoreo } | null = null;
let enVuelo: Promise<RespuestaFlotaMonitoreo> | null = null;

function calcular(): Promise<RespuestaFlotaMonitoreo> {
  if (enVuelo) return enVuelo;
  const p = flotaMonitoreo(admin, { ahoraMs: Date.now() }).then((payload) => {
    cache = { at: Date.now(), payload };
    return payload;
  });
  enVuelo = p;
  // Se suelta al terminar, salga bien o mal; el `catch` evita un rechazo sin manejar en esta rama
  // (quien espera `p` recibe el error por su lado).
  p.finally(() => { if (enVuelo === p) enVuelo = null; }).catch(() => {});
  return p;
}

export async function GET(req: NextRequest) {
  // La autorización va SIEMPRE antes de la caché: lo cacheado es la posición de toda la flota.
  const auth = await verificarUsuarioApi(req, "monitoreo");
  if (!auth.ok) {
    const error = auth.status === 401
      ? "Tu sesión no es válida: vuelve a ingresar."
      : `${auth.error}. El mapa de Monitoreo necesita un usuario activo con el permiso del módulo Monitoreo (lo da un administrador en Usuarios).`;
    return NextResponse.json({ error }, { status: auth.status, headers: NO_STORE });
  }

  if (cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json(cache.payload, { headers: NO_STORE });
  }

  try {
    const payload = await calcular();
    return NextResponse.json(payload, { headers: NO_STORE });
  } catch (e) {
    // El detalle (puede traer el mensaje de la base) va al log, no al navegador.
    console.error("[api/monitoreo/flota]", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { error: "No se pudo leer la flota para el mapa de Monitoreo (la base de datos no respondió al leer los vehículos). Vuelve a intentarlo en un momento; si sigue fallando, avisa a soporte." },
      { status: 500, headers: NO_STORE },
    );
  }
}
