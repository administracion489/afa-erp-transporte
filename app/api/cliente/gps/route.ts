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
import { paginarFilas } from "@/lib/huella";
import { tMs } from "@/lib/gps-huella-servicio";
import { huellaDelServicio } from "@/lib/gps-huella-servicio-datos";
import { ajustadaParaRespuesta } from "@/lib/gps-traza-ajustada-datos";
import { verificarTokenPortal, reservaEsDelCliente, filtrarVehiculosDelCliente } from "@/lib/portal-auth";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { sembrarAvance, leerAvance, type ParadaAvance, type FixAvance } from "@/lib/avance-paradas";

const adminClient = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

const COLS =
  "reserva_id,vehiculo_id,vehiculo_tercero_id,conductor_id,conductor_tercero_id,lat,lng,velocidad,rumbo,precision_m,estado,created_at,timestamp,fix_ts";

const keyDe = (g: any) =>
  g.conductor_tercero_id != null ? `ct${g.conductor_tercero_id}`
  : g.conductor_id != null        ? `c${g.conductor_id}`
  : g.vehiculo_tercero_id != null ? `vt${g.vehiculo_tercero_id}`
  : g.vehiculo_id != null         ? `v${g.vehiculo_id}`
  : g.reserva_id != null          ? `r${g.reserva_id}` : "?";

// Garantiza que `timestamp` siempre tenga valor (cae a created_at). Los consumidores
// del portal calculan antigüedad con `timestamp`; si viniera null marcarían "sin señal".
const norm = (g: any) => (g ? { ...g, timestamp: g.timestamp ?? g.created_at ?? null } : g);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const supabase = adminClient();

    // ── Autorización ────────────────────────────────────────────────────────────
    // Corre con service_role (sin RLS) y devuelve la traza GPS completa de un servicio.
    // Antes no pedía NADA: bastaba con conocer o adivinar un reservaId para seguir a un bus
    // ajeno, sin ser cliente ni operador.
    //
    // DOS PÚBLICOS, y por eso la autorización es doble: este endpoint lo consume el mismo
    // ModalGps que usan el OPERADOR en /seguimiento (sesión del ERP, ve toda la flota) y el
    // CLIENTE en su portal (sesión propia de portal_usuarios, ve solo lo suyo). Exigir solo
    // una de las dos credenciales dejaría ciego al otro.
    let cid: number | null = null;   // null = operador del ERP (sin acotar por cliente)

    // Operador del ERP: NO basta con existir en auth. Se exige usuario activo y permiso del
    // módulo, que es el patrón canónico del repo (lib/api-auth.ts) — sin esto, un operador
    // dado de baja conserva su refresh token y seguiría bajando el GPS de toda la flota
    // llamando la API directamente, porque el gate de la UI se evade con un curl.
    let esOperador = false;
    if (req.headers.get("authorization")) {
      const auth = await verificarUsuarioApi(req, "seguimiento");
      esOperador = auth.ok;
      // Bearer presente pero inválido/sin permiso: no se cae al token del portal (sería una
      // vía para colarse), se rechaza aquí.
      if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    if (!esOperador) {
      const sesion = verificarTokenPortal(body?.token);
      if (!sesion) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
      cid = sesion.cid;

      // El cid sale del TOKEN, nunca del body → un cliente no puede pedir lo de otro.
      const reservaPedida = Number(body?.reservaId ?? 0);
      const pideReserva = Number.isFinite(reservaPedida) && reservaPedida > 0;
      if (pideReserva && !(await reservaEsDelCliente(supabase, reservaPedida, cid))) {
        return NextResponse.json({ error: "No autorizado" }, { status: 403 });
      }

      // Los vehículos SINGULARES no se aceptan del body: se DERIVAN de la reserva ya
      // autorizada. Aceptarlos dejaba el IDOR abierto de par en par — bastaba pedir
      // { token, huella:true, vehiculoTerceroId:N } sin reservaId para bajar la traza
      // completa de cualquier bus de cualquier cliente (comprobado: 1.054 puntos de un
      // vehículo ajeno). Los ids son enteros pequeños y correlativos: se enumeran solos.
      if (pideReserva) {
        const { data: rsvAuth } = await supabase.from("reservas")
          .select("vehiculo_id, vehiculo_tercero_id").eq("id", reservaPedida).maybeSingle();
        body.vehiculoId        = rsvAuth?.vehiculo_id ?? null;
        body.vehiculoTerceroId = rsvAuth?.vehiculo_tercero_id ?? null;
      } else {
        // Sin reserva no hay nada que autorizar contra: se anulan.
        body.vehiculoId = null;
        body.vehiculoTerceroId = null;
      }

      // Modo lote (mapa "En vivo"): se queda solo con los vehículos que el cliente puede ver.
      if (Array.isArray(body?.vehiculoIds) || Array.isArray(body?.vehiculoTerceroIds)) {
        const permitido = await filtrarVehiculosDelCliente(
          supabase, cid, body.vehiculoIds ?? [], body.vehiculoTerceroIds ?? [],
        );
        body.vehiculoIds = permitido.vehiculoIds;
        body.vehiculoTerceroIds = permitido.vehiculoTerceroIds;
      }
    }

    // ── Modo huella (estela del modal): todos los puntos del viaje ─────────────
    // QUÉ posiciones son del servicio (ventana, rama por vehículo para terceros, tramo del servicio,
    // techo de precisión) lo deciden lib/gps-huella-servicio.ts (puro) y su lector
    // lib/gps-huella-servicio-datos.ts, EXTRAÍDOS de aquí sin cambiarlos: la traza ajustada a la vía
    // que se guarda para siempre se firma y se calcula sobre ESTAS mismas filas. Respuesta byte a
    // byte la de antes (scripts/prueba-traza-ajustada.mts §6).
    //
    // `ajustada` (lib/gps-traza-ajustada-datos.ts): SOLO con la reserva `finalizada` se agrega el estado
    // de la traza ajustada a la vía que se guarda para siempre —la traza misma cuando está guardada—,
    // firmada sobre ESTAS `filasOk`. Best-effort: nunca rompe la huella. Si el modal manda
    // `ajustadaConocida` (el `calculadoEn` de la que ya tiene) y coincide, no se reenvía el jsonb.
    // Sin reserva finalizada, la respuesta es byte a byte la de antes.
    if (body.huella) {
      const { filasOk, servicio, reserva, completa } = await huellaDelServicio(supabase, {
        reservaId: body.reservaId ?? null,
        vehiculoId: body.vehiculoId ?? null,
        vehiculoTerceroId: body.vehiculoTerceroId ?? null,
      });
      if (reserva?.estado !== "finalizada") return NextResponse.json({ huella: filasOk.map(norm), servicio });
      const ajustada = await ajustadaParaRespuesta({
        reservaId: Number(body.reservaId), reserva, filasOk, completa, ahoraMs: Date.now(), conocida: body.ajustadaConocida,
      });
      return NextResponse.json({ huella: filasOk.map(norm), servicio, ajustada });
    }

    // ── Modo avance: por qué paradas pasó el bus, según el GPS ────────────────
    // El portal decidía el progreso SOLO por el botón del conductor, que es poco fiable
    // (se marca en bloque, y a veces se marcan paradas por las que el GPS demuestra que no
    // se pasó). El modal del operador ya resuelve esto con lib/avance-paradas; aquí se reusa
    // ese mismo motor —es puro, sin DOM— para que la línea de tiempo del cliente diga lo
    // mismo que el mapa. Antes podían contradecirse en la misma pantalla.
    //
    // SE CALCULA EN EL SERVIDOR a propósito: el veredicto son ~200 bytes, la huella que hace
    // falta para obtenerlo son miles de puntos. Mandarla al navegador del cliente cada 15 s,
    // por varios servicios a la vez, es justo lo que ya hizo pesado a este portal una vez.
    if (body.avance) {
      // Lote: el dashboard puede tener varias tarjetas en ruta a la vez. Pedirlas de una en
      // una multiplicaba los viajes por un dato que cambia lento (una parada cada varios
      // minutos). Se conserva `reservaId` suelto por compatibilidad.
      if (Array.isArray(body.reservaIds)) {
        const ids = body.reservaIds.map(Number).filter((n: number) => Number.isFinite(n) && n > 0).slice(0, 6);
        if (!ids.length) return NextResponse.json({ avances: {} });
        // Cada una tiene que ser suya: el cid sale del token (el operador ya pasó el gate).
        const permitidas: number[] = [];
        for (const id of ids) {
          if (cid === null || await reservaEsDelCliente(supabase, id, cid)) permitidas.push(id);
        }
        const avances: Record<number, any> = {};
        await Promise.all(permitidas.map(async (id) => {
          try {
            const { data: pbd } = await supabase.from("paradas")
              .select("id,orden,lat,lng,estado").eq("reserva_id", id).order("orden", { ascending: true });
            const pl = (pbd ?? []) as any[];
            if (!pl.length) return;
            const filas = await paginarFilas(() =>
              supabase.from("ubicaciones_gps").select("lat,lng,created_at,precision_m")
                .eq("reserva_id", id)
                .order("created_at", { ascending: true }).order("id", { ascending: true }));
            const huella: FixAvance[] = (filas ?? []).map((f: any) => {
              const lat = Number(f.lat), lng = Number(f.lng), ts = Date.parse(f.created_at), acc = Number(f.precision_m);
              return { lat, lng, ts, acc: Number.isFinite(acc) ? acc : 25 };
            }).filter((q: FixAvance) => Number.isFinite(q.lat) && Number.isFinite(q.lng) && Number.isFinite(q.ts));
            const pa: ParadaAvance[] = pl.map((q) => ({
              lat: q.lat == null ? null : Number(q.lat),
              lng: q.lng == null ? null : Number(q.lng),
              completada: q.estado === "completada",
            }));
            const a = leerAvance(sembrarAvance(pa, huella), pa);
            avances[id] = {
              proximaIdx: a.proximaIdx, pasadas: a.pasadas, motivo: a.motivo,
              confianza: a.confianza, muestras: a.muestras,
              paradaIds: pl.map((q) => q.id),
            };
          } catch { /* una reserva que falle no debe tumbar el resto del lote */ }
        }));
        return NextResponse.json({ avances });
      }

      const reservaId = Number(body.reservaId ?? 0);
      if (!Number.isFinite(reservaId) || reservaId <= 0) {
        return NextResponse.json({ error: "reservaId requerido" }, { status: 400 });
      }
      const [{ data: paradasBd }, { data: filasBd }] = await Promise.all([
        supabase.from("paradas").select("id,orden,lat,lng,estado,hora_llegada")
          .eq("reserva_id", reservaId).order("orden", { ascending: true }),
        Promise.resolve({ data: null }),
      ]);
      const paradas = (paradasBd ?? []) as any[];
      if (!paradas.length) return NextResponse.json({ avance: null, motivo: [], sinParadas: true });

      // Huella CRUDA (ver la cabecera de sembrarAvance): NADA de anclarImprecisos ni
      // limpiarHuella. La primera mueve puntos ya consumidos y hace parpadear el veredicto;
      // la segunda colapsa las detenciones y destruye la cadencia sobre la que están
      // calibradas las rachas del motor.
      const filas = await paginarFilas(() =>
        supabase.from("ubicaciones_gps").select("lat,lng,created_at,precision_m")
          .eq("reserva_id", reservaId)
          .order("created_at", { ascending: true }).order("id", { ascending: true }));

      const huella: FixAvance[] = (filas ?? []).map((f: any) => {
        const lat = Number(f.lat), lng = Number(f.lng);
        const ts = Date.parse(f.created_at);
        const acc = Number(f.precision_m);
        return { lat, lng, ts, acc: Number.isFinite(acc) ? acc : 25 };
      }).filter((p: FixAvance) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.ts));

      const pAvance: ParadaAvance[] = paradas.map((p) => ({
        lat: p.lat == null ? null : Number(p.lat),
        lng: p.lng == null ? null : Number(p.lng),
        completada: p.estado === "completada",
      }));

      const av = leerAvance(sembrarAvance(pAvance, huella), pAvance);
      return NextResponse.json({
        avance: {
          proximaIdx: av.proximaIdx,
          pasadas: av.pasadas,
          motivo: av.motivo,          // "conductor" | "gps" | "arrastre" | null
          confianza: av.confianza,    // sin_evidencia | conductor | gps | degradada
          muestras: av.muestras,
        },
        // Ids en el MISMO orden que los arrays, para que el front no tenga que adivinar
        // el emparejamiento: el motor indexa por posición, nunca por id.
        paradaIds: paradas.map((p) => p.id),
      });
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
      // Cota temporal: sin ella, la lista IN + ORDER BY created_at DESC obliga a Postgres
      // a ordenar la tabla entera de GPS (cientos de miles de filas) para devolver 25 por
      // vehículo, y esto corre cada 15 s mientras el portal está abierto. Son las MISMAS
      // 6 h que el navegador ya descarta al mezclar (MAX_EDAD_MS en app/cliente/page.tsx):
      // no se pierde ni un marcador, solo se deja de leer lo que igual se iba a tirar.
      const desdeLote = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const [propios, terceros] = await Promise.all([
        vehiculoIds.length
          ? supabase.from("ubicaciones_gps").select(COLS)
              .in("vehiculo_id", vehiculoIds).gte("created_at", desdeLote)
              .order("created_at", { ascending: false }).limit(lim)
          : Promise.resolve({ data: [] as any[] }),
        vehiculoTerceroIds.length
          ? supabase.from("ubicaciones_gps").select(COLS)
              .in("vehiculo_tercero_id", vehiculoTerceroIds).gte("created_at", desdeLote)
              .order("created_at", { ascending: false }).limit(lim)
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
    // Un servicio CERRADO sin filas propias no cae a la unidad: lo que la unidad haga después
    // (otro servicio, conectada sin servicio) no es la posición de este (reserva #1459). La misma
    // regla aplica el tiempo real del modal (filaEnVivoDelServicio, lib/gps-huella-servicio.ts).
    let servicioCerrado = false;
    if (!ubic && reservaId != null) {
      const { data: rsv } = await supabase.from("reservas").select("estado").eq("id", reservaId).maybeSingle();
      servicioCerrado = rsv?.estado === "finalizada" || rsv?.estado === "cancelada";
    }
    if (!ubic && !servicioCerrado && (vehiculoTerceroId != null || vehiculoId != null)) {
      // Fallback por vehículo: solo puntos "en_ruta" para que el cliente no vea
      // al conductor en modo conectado-libre (antes/después de su servicio).
      // Cota temporal: finalizar un servicio NO cierra las filas "en_ruta" del viaje
      // anterior. Sin esta cota, al abrir un servicio nuevo (antes del 1er fix con su
      // reserva_id) el fallback resucitaría el ÚLTIMO punto "en_ruta" del viaje pasado
      // → el bus aparecería congelado en una posición vieja. 2 h cubre cualquier viaje.
      const desdeFallback = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      let q = supabase.from("ubicaciones_gps").select(COLS)
        .eq("estado", "en_ruta")
        .gte("created_at", desdeFallback)
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
