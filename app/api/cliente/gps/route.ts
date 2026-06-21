// app/api/cliente/gps/route.ts
// Lectura de GPS en vivo para el PORTAL DEL CLIENTE con service_role (sin RLS),
// igual que /api/seguimiento. Esto hace que la posición llegue al instante en lugar
// de esperar el primer evento realtime (~10-20s = 1-2 heartbeats del conductor).
//
// Dos modos en un solo endpoint (POST):
//   • Individual (modal GPS):  { reservaId, vehiculoId, vehiculoTerceroId }
//        → { ubicacion: <último punto> | null }   (cascada reserva_id → vehículo)
//   • Lote (mapa "En vivo"):   { vehiculoIds:[], vehiculoTerceroIds:[] }
//        → { ubicaciones: [<último punto por vehículo>] }
//
// NOTA: NO toca la app del conductor. Solo lee ubicaciones_gps.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const adminClient = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

const COLS =
  "reserva_id,vehiculo_id,vehiculo_tercero_id,conductor_id,conductor_tercero_id,lat,lng,velocidad,rumbo,precision_m,estado,created_at,timestamp";

// created_at es la columna fiable (la setea el insert del conductor); timestamp puede
// no venir. Se ordena/dedupea por la más reciente de ambas.
const tMs = (g: any) => {
  const a = g?.created_at ? new Date(g.created_at).getTime() : 0;
  const b = g?.timestamp ? new Date(g.timestamp).getTime() : 0;
  return Math.max(a || 0, b || 0);
};

const keyDe = (g: any) =>
  g.conductor_tercero_id != null ? `ct${g.conductor_tercero_id}`
  : g.conductor_id != null        ? `c${g.conductor_id}`
  : g.vehiculo_tercero_id != null ? `vt${g.vehiculo_tercero_id}`
  : g.vehiculo_id != null         ? `v${g.vehiculo_id}`
  : g.reserva_id != null          ? `r${g.reserva_id}` : "?";

// Garantiza que `timestamp` siempre tenga valor (cae a created_at). Los consumidores
// del portal calculan antigüedad con `timestamp`; si viniera null marcarían "sin señal".
const norm = (g: any) => (g ? { ...g, timestamp: g.timestamp ?? g.created_at ?? null } : g);

// Mantiene solo el ÚLTIMO tramo contiguo: corta donde haya un hueco temporal > gapMs.
// La rama por-vehículo (terceros, sin reserva_id) trae las últimas 12 h, que pueden incluir
// DOS servicios del mismo bus → sin esto, la huella dibuja una recta larga uniendo el fin del
// viaje A con el inicio del viaje B. Dentro de un servicio el conductor late cada ~25 s aun
// detenido, así que un hueco > gapMs = la app dejó de transmitir = otro servicio (o fin).
// filas viene ordenado por created_at asc.
const HUECO_VIAJE_MS = 30 * 60 * 1000; // 30 min: separa servicios sin cortar paradas/cortes de señal
function ultimoTramo(filas: any[], gapMs: number): any[] {
  if (filas.length < 2) return filas;
  let inicio = 0;
  for (let i = 1; i < filas.length; i++) {
    if (tMs(filas[i]) - tMs(filas[i - 1]) > gapMs) inicio = i;
  }
  return inicio === 0 ? filas : filas.slice(inicio);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const supabase = adminClient();

    // ── Modo huella (estela del modal): todos los puntos del viaje ─────────────
    if (body.huella) {
      const reservaId         = body.reservaId ?? null;
      const vehiculoId        = body.vehiculoId ?? null;
      const vehiculoTerceroId = body.vehiculoTerceroId ?? null;
      const HCOLS = "lat,lng,velocidad,created_at,timestamp,reserva_id,vehiculo_id,vehiculo_tercero_id,precision_m";
      let filas: any[] = [];
      let viaVehiculo = false; // ¿se usó la rama por-vehículo (sin reserva_id)?
      if (reservaId != null) {
        const { data } = await supabase.from("ubicaciones_gps").select(HCOLS)
          .eq("reserva_id", reservaId).order("created_at", { ascending: true }).limit(5000);
        filas = data || [];
      }
      if (filas.length === 0 && (vehiculoTerceroId != null || vehiculoId != null)) {
        // Tercero: los puntos no llevan reserva_id. Acotar a las últimas 12 h (viaje de hoy).
        const desde = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
        let q = supabase.from("ubicaciones_gps").select(HCOLS)
          .gte("created_at", desde).order("created_at", { ascending: true }).limit(5000);
        if (vehiculoTerceroId != null) q = q.eq("vehiculo_tercero_id", vehiculoTerceroId);
        else                            q = q.eq("vehiculo_id", vehiculoId);
        const { data } = await q;
        filas = data || [];
        viaVehiculo = true;
      }
      // Rama por-vehículo: la ventana de 12 h puede traer 2 servicios del mismo bus → quedarnos
      // solo con el viaje más reciente (cortar por hueco temporal). La rama por reserva_id ya
      // está acotada a un único servicio, no se toca.
      const base = viaVehiculo ? ultimoTramo(filas, HUECO_VIAJE_MS) : filas;
      const filasOk = base.filter((p: any) => p.precision_m == null || p.precision_m <= 80);
      return NextResponse.json({ huella: filasOk.map(norm) });
    }

    const vehiculoIds = Array.isArray(body.vehiculoIds)
      ? (body.vehiculoIds as any[]).filter((x) => x != null)
      : [];
    const vehiculoTerceroIds = Array.isArray(body.vehiculoTerceroIds)
      ? (body.vehiculoTerceroIds as any[]).filter((x) => x != null)
      : [];

    // ── Modo lote: última posición conocida por cada vehículo ──────────────────
    if (vehiculoIds.length > 0 || vehiculoTerceroIds.length > 0) {
      const lim = (vehiculoIds.length + vehiculoTerceroIds.length) * 25;
      const [propios, terceros] = await Promise.all([
        vehiculoIds.length
          ? supabase.from("ubicaciones_gps").select(COLS)
              .in("vehiculo_id", vehiculoIds).order("created_at", { ascending: false }).limit(lim)
          : Promise.resolve({ data: [] as any[] }),
        vehiculoTerceroIds.length
          ? supabase.from("ubicaciones_gps").select(COLS)
              .in("vehiculo_tercero_id", vehiculoTerceroIds).order("created_at", { ascending: false }).limit(lim)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const filas = [...((propios as any).data || []), ...((terceros as any).data || [])];
      const latest: Record<string, any> = {};
      filas.forEach((g: any) => {
        const k = keyDe(g);
        if (!latest[k] || tMs(g) > tMs(latest[k])) latest[k] = g;
      });
      return NextResponse.json({ ubicaciones: Object.values(latest).map(norm) });
    }

    // ── Modo individual (modal): cascada reserva_id → vehículo ─────────────────
    const reservaId         = body.reservaId ?? null;
    const vehiculoId        = body.vehiculoId ?? null;
    const vehiculoTerceroId = body.vehiculoTerceroId ?? null;

    let ubic: any = null;

    if (reservaId != null) {
      const { data } = await supabase.from("ubicaciones_gps").select(COLS)
        .eq("reserva_id", reservaId).order("created_at", { ascending: false }).limit(1).maybeSingle();
      ubic = data;
    }
    if (!ubic && (vehiculoTerceroId != null || vehiculoId != null)) {
      // Fallback por vehículo: solo puntos "en_ruta" para que el cliente no vea
      // al conductor en modo conectado-libre (antes/después de su servicio).
      let q = supabase.from("ubicaciones_gps").select(COLS)
        .eq("estado", "en_ruta")
        .order("created_at", { ascending: false }).limit(1);
      if (vehiculoTerceroId != null) q = q.eq("vehiculo_tercero_id", vehiculoTerceroId);
      else                            q = q.eq("vehiculo_id", vehiculoId);
      const { data } = await q.maybeSingle();
      ubic = data;
    }

    return NextResponse.json({ ubicacion: norm(ubic) });
  } catch (e: any) {
    console.error("[api/cliente/gps]", e?.message);
    return NextResponse.json({ error: e?.message ?? "error" }, { status: 500 });
  }
}
