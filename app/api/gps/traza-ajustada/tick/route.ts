// app/api/gps/traza-ajustada/tick/route.ts
// Cron OPCIONAL de la traza ajustada (vercel.json: "15 * * * *"). NACE APAGADO: con
// `gps_traza_config.precalcular_dias = 0` no precalcula nada. Hace dos cosas, según la configuración
// (lib/gps-traza-ajustada-datos.ts → tickTrazaAjustada):
//   · `borrar_guardadas = true` → borra las trazas guardadas por lotes (el interruptor de apagado).
//   · `precalcular_dias > 0` y `guardar` → ajusta y guarda los finalizados de esos días que nadie abrió
//     (también es el backfill), con tope por corrida, de tiempo y el presupuesto global.
// Falla CERRADO sin CRON_SECRET (esCronAutorizado).
//
// Respuesta 200: `{ estado, … }` (ver ResumenTick): `sin_migracion` · `apagado` · `sin_token` ·
// `borrando { borradas, quedan }` · `ok { candidatas, calculadas, saltadas_por_codigo, gasto_hora,
// gasto_mes }` · `error { detalle }`. 401 sin el secreto.

import { NextRequest, NextResponse } from "next/server";
import { esCronAutorizado } from "@/lib/api-auth";
import { tickTrazaAjustada } from "@/lib/gps-traza-ajustada-datos";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!esCronAutorizado(req)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  try {
    return NextResponse.json(await tickTrazaAjustada());
  } catch (e: any) {
    console.error("[api/gps/traza-ajustada/tick]", e?.message ?? e);
    return NextResponse.json({ estado: "error", detalle: "la corrida falló; se reintenta en la próxima" });
  }
}
