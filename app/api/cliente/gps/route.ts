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

// Corte por tramos contiguos: un hueco > gapMs = la app dejó de transmitir = otro viaje (dentro
// de un servicio el conductor late cada ~25 s aun detenido). Sin él, la huella dibuja una recta
// larga uniendo el fin del viaje A con el inicio del viaje B. Ver tramoDelServicio, abajo.
const HUECO_VIAJE_MS = 30 * 60 * 1000; // 30 min: separa servicios sin cortar paradas/cortes de señal

// Cuánto ANTES de la hora programada puede empezar a contar el GPS, y solo con el inicio ya
// confirmado: es el traslado cochera → primer paradero, que sí pertenece al servicio.
const MARGEN_PREVIO_MS = 45 * 60 * 1000;
// Techo de duración de la ventana. 26 h y no 12: hay tours full day de hasta 24 h y una ventana
// más corta que el propio servicio le cortaría la huella por la mitad al final del viaje.
const DURACION_MAX_MS = 26 * 60 * 60 * 1000;

/** "HH:MM[:SS]" del día `fecha` (Lima, UTC-5 sin DST) en ms epoch. Igual que api/gps-salud. */
function limaMs(fecha: string | null | undefined, hora: string | null | undefined): number | null {
  if (!fecha) return null;
  const h = hora ? String(hora).slice(0, 8).padEnd(8, ":00").slice(0, 8) : "00:00:00";
  const t = Date.parse(`${fecha}T${h}-05:00`);
  return Number.isFinite(t) ? t : null;
}
/**
 * Parte la huella en tramos contiguos y devuelve EL DEL SERVICIO: el primer tramo que seguía
 * vivo a la hora de salida programada (`refTs`). La rama por-vehículo puede traer varios viajes
 * del mismo bus dentro de la ventana, y "quedarse con el último" —lo que hacía antes— solo
 * acierta cuando el servicio consultado es el que está ocurriendo AHORA: al abrir uno de ayer
 * devolvía el viaje de hoy.
 * LÍMITE CONOCIDO: si el bus hizo un traslado con hueco propio después de la hora de salida y el
 * servicio arrancó aún más tarde, gana el traslado. No se adivina más — el caso lo resuelve la
 * evidencia dura (puntos con reserva_id) y esta rama es el fallback.
 * `filas` viene ordenado por created_at asc.
 */
function tramoDelServicio(filas: any[], gapMs: number, refTs: number | null): any[] {
  if (filas.length < 2) return filas;
  const tramos: any[][] = [];
  let inicio = 0;
  for (let i = 1; i < filas.length; i++) {
    if (tMs(filas[i]) - tMs(filas[i - 1]) > gapMs) { tramos.push(filas.slice(inicio, i)); inicio = i; }
  }
  tramos.push(filas.slice(inicio));
  const ultimo = tramos[tramos.length - 1];
  if (refTs == null) return ultimo;   // sin hora programada no hay con qué anclar → el más reciente
  return tramos.find(t => tMs(t[t.length - 1]) >= refTs) ?? ultimo;
}

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
    if (body.huella) {
      const reservaId         = body.reservaId ?? null;
      const vehiculoId        = body.vehiculoId ?? null;
      const vehiculoTerceroId = body.vehiculoTerceroId ?? null;
      const HCOLS = "lat,lng,velocidad,created_at,timestamp,reserva_id,vehiculo_id,vehiculo_tercero_id,precision_m,fix_ts";
      let filas: any[] = [];
      let viaVehiculo = false; // ¿se usó la rama por-vehículo (sin reserva_id)?
      // PAGINADO (paginarFilas): PostgREST recorta toda respuesta al max-rows del servidor
      // (1000) aunque se pida .limit(5000) → la huella se congelaba en el punto 1000 y el
      // resto del viaje salía como "tramo estimado". Orden created_at+id = páginas estables.
      if (reservaId != null) {
        filas = await paginarFilas(() =>
          supabase.from("ubicaciones_gps").select(HCOLS)
            .eq("reserva_id", reservaId)
            .order("created_at", { ascending: true }).order("id", { ascending: true }));
      }
      // ── VENTANA DEL SERVICIO ─────────────────────────────────────────────────
      // Un punto GPS solo puede hablar de ESTE servicio si cae dentro de su ventana. La rama
      // por-vehículo no tiene reserva_id y sin esta cota traía "las últimas 12 h del bus": el
      // traslado desde cochera, el modo conectado-libre (enviarUbicacion manda reserva_id null
      // mientras no hay recorrido iniciado — app/conductor/page.tsx:1268) y hasta el servicio
      // anterior si la separación fue <30 min. Esa huella ajena SEMBRABA el motor de avance
      // (lib/avance-paradas.ts) y un servicio que aún no arrancaba aparecía con paraderos
      // "detectados por GPS", el itinerario al 33 % y un ETA calculado desde una parada por la
      // que el bus nunca pasó.
      const rsv = reservaId != null
        ? (await supabase.from("reservas").select("fecha_servicio,hora_servicio,estado")
            .eq("id", reservaId).maybeSingle()).data
        : null;
      const progMs = limaMs(rsv?.fecha_servicio, rsv?.hora_servicio);
      // EVIDENCIA DURA DE INICIO, en este orden: puntos atados a la reserva (la app del conductor
      // ata cada fix al servicio al iniciar el recorrido) → estado puesto por una persona.
      const iniciado = filas.length > 0 || rsv?.estado === "en_curso" || rsv?.estado === "finalizada";
      // Con el inicio confirmado la ventana se abre antes: ese traslado al primer paradero SÍ es
      // parte del servicio. Sin confirmar, abre en la hora programada EXACTA — antes de esa hora
      // nadie puede afirmar que el bus se mueve por este servicio, y en una ruta de retorno pasa
      // cerca de paraderos posteriores camino al origen: justo el movimiento que producía los
      // falsos "ya pasó".
      const T0 = progMs != null ? progMs - (iniciado ? MARGEN_PREVIO_MS : 0) : null;
      const T1 = T0 != null ? T0 + DURACION_MAX_MS : null;
      const antesDeLaVentana = T0 != null && Date.now() < T0;
      if (filas.length === 0 && (vehiculoTerceroId != null || vehiculoId != null) && !antesDeLaVentana) {
        // Tercero: los puntos no llevan reserva_id. Ventana del servicio; sin fecha/hora
        // programada (dato incompleto) se cae al comportamiento histórico de las últimas 12 h.
        const desde = new Date(T0 ?? Date.now() - 12 * 60 * 60 * 1000).toISOString();
        const hasta = T1 != null ? new Date(Math.min(T1, Date.now())).toISOString() : null;
        filas = await paginarFilas(() => {
          let q = supabase.from("ubicaciones_gps").select(HCOLS)
            .gte("created_at", desde)
            .order("created_at", { ascending: true }).order("id", { ascending: true });
          if (hasta) q = q.lte("created_at", hasta);
          return vehiculoTerceroId != null ? q.eq("vehiculo_tercero_id", vehiculoTerceroId) : q.eq("vehiculo_id", vehiculoId);
        });
        viaVehiculo = true;
      }
      // Rama por-vehículo: la ventana del servicio todavía puede contener dos viajes del mismo
      // bus (un full day de 24 h con relevo a media tarde) → quedarnos solo con el más reciente.
      // La rama por reserva_id ya está acotada a un único servicio, no se toca.
      const base = viaVehiculo ? tramoDelServicio(filas, HUECO_VIAJE_MS, progMs) : filas;
      // Coherencia escritura↔lectura: el conductor (enviarUbicacion) acepta fixes hasta
      // 1500 m a propósito (tablets/FUSED por red sin chip GPS) y DELEGA el suavizado a la
      // lectura. Si aquí cortáramos a 80 m, esos puntos (80–1500 m) se perderían → huella
      // vacía o con huecos → rectas, justo en equipos posicionados por red. La imprecisión
      // ya la absorben limpiarHuella + los radii de Map Matching (acc·1.5), así que basta
      // descartar solo la basura de torre celular (el MISMO techo que la escritura).
      const filasOk = base.filter((p: any) => p.precision_m == null || p.precision_m <= 1500);
      // `servicio` viaja con la huella para que el modal aplique la MISMA cota al fix EN VIVO
      // (que no pasa por aquí: llega por el modo individual) y no vuelva a envenenar el motor
      // por la puerta de atrás. `desdeTs` nunca recorta evidencia dura: si hay puntos atados a
      // la reserva manda el primero de ellos cuando es anterior a T0 — el bus pudo salir antes
      // de lo programado y ese tramo es del servicio, lo dice su propio reserva_id.
      const primeroReservaTs = !viaVehiculo && filasOk.length ? tMs(filasOk[0]) : null;
      const desdeTs = T0 == null ? null : primeroReservaTs ? Math.min(T0, primeroReservaTs) : T0;
      return NextResponse.json({
        huella: filasOk.map(norm),
        servicio: {
          iniciado, desdeTs, programadoTs: progMs,
          // El veredicto lo emite el SERVIDOR — es el mismo que acaba de dejar la huella vacía.
          // Recalcularlo en el cliente con su propio reloj abre la puerta a que discrepen.
          esperando: antesDeLaVentana && !iniciado,
          estado: rsv?.estado ?? null,
          via: viaVehiculo ? "vehiculo" : filasOk.length ? "reserva" : "ninguna",
        },
      });
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
    if (!ubic && (vehiculoTerceroId != null || vehiculoId != null)) {
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
