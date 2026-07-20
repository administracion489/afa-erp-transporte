// app/api/mantenimiento/odometro-analitica/route.ts
// Atribución de kilometraje de UN vehículo en un período — el "cuadre de km" de la operación.
// Cruza `reservas` (finalizadas de esa unidad) con TRES fuentes de distancia:
//   1. Huella GPS por servicio (lib/km-servicio) → km REAL medido (puede subestimar por huecos).
//   2. Google Directions por las paradas del servicio → km PLANIFICADO (origen→…→destino).
//      Sirve de fallback cuando el GPS no es confiable/está ausente, y para el % de desvío.
//   3. Google Directions entre servicios consecutivos del día (destino_A → origen_B) →
//      km EN VACÍO por tramo (traslados de posicionamiento), mucho más preciso que el
//      residual de jornada.
//
// Reparte los km por conductor / cliente / ruta (firma geográfica) / sentido, y devuelve el
// desglose productivo (con pasajeros) vs vacío (tramos). El cliente calcula el residual
// "sin explicar" = odómetro del período − productivo − vacío. Ver [[project_odometro_analitica_operativa]].
//
// Pesado (GPS + Google) → on-demand, 1 vehículo + rango, con tope de servicios, dedupe de
// distancias por firma y caché opcional (`distancias_ruta_cache`, degrada elegante si no existe).
// Usa service-role; exige usuario ERP (Bearer).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { kmDeServicio } from "@/lib/km-servicio";

export const maxDuration = 60;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const MAX_SERVICIOS = 400;              // tope de servicios con GPS por llamada
const MEDIDO_MIN_CONFIABLE = 55;        // % de huella medida para preferir GPS sobre el plan
const MISMO_PUNTO_M = 400;              // < esta distancia, destino≈origen → tramo vacío ≈ 0

const GKEY = process.env.GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

async function verificarUsuario(req: NextRequest): Promise<boolean> {
  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return false;
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { data } = await anon.auth.getUser(token);
    return !!data?.user;
  } catch {
    return false;
  }
}

// ─── HELPERS DE DISTANCIA ────────────────────────────────────────────────────

type Punto = { lat: number; lng: number; nombre?: string };

const r3 = (n: number) => Math.round(n * 1000) / 1000; // ~100 m de resolución para firmas

function puntoValido(p: any): p is Punto {
  const lat = Number(p?.lat), lng = Number(p?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);
}

function haversineM(a: Punto, b: Punto): number {
  const R = 6371000, toRad = (x: number) => (x * Math.PI) / 180;
  const dLa = toRad(b.lat - a.lat), dLo = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function firmaPuntos(pts: Punto[]): string {
  return pts.map((p) => `${r3(p.lat)},${r3(p.lng)}`).join("|");
}

// Distancia por carretera (km) de una secuencia de puntos vía Google Directions.
// Devuelve null si no hay key o Google falla (el llamador cae al haversine / GPS).
async function googleKm(pts: Punto[]): Promise<number | null> {
  if (!GKEY || pts.length < 2) return null;
  try {
    const origin = `${pts[0].lat},${pts[0].lng}`;
    const destination = `${pts[pts.length - 1].lat},${pts[pts.length - 1].lng}`;
    const waypoints = pts.length > 2 ? pts.slice(1, -1).map((p) => `${p.lat},${p.lng}`).join("|") : "";
    const params = new URLSearchParams({ origin, destination, key: GKEY, mode: "driving", language: "es", region: "pe" });
    if (waypoints) params.set("waypoints", waypoints);
    const res = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "OK" || !data.routes?.[0]?.legs) return null;
    const metros = data.routes[0].legs.reduce((s: number, l: any) => s + (l.distance?.value || 0), 0);
    return Math.round((metros / 1000) * 10) / 10;
  } catch {
    return null;
  }
}

// Resuelve la distancia (km) de una firma con caché opcional en BD + memoria de la petición.
// 1) memoria → 2) tabla distancias_ruta_cache (si existe) → 3) Google → 4) guarda en tabla.
// Degrada elegante: cualquier fallo de la tabla se ignora (feature funciona con 0 BD).
function crearResolvedor(memo: Map<string, number | null>) {
  return async function distancia(firma: string, pts: Punto[]): Promise<number | null> {
    if (memo.has(firma)) return memo.get(firma)!;

    let cacheHit: number | null = null;
    try {
      const { data } = await admin.from("distancias_ruta_cache").select("km").eq("clave", firma).maybeSingle();
      if (data?.km != null) cacheHit = Number(data.km);
    } catch { /* tabla ausente → sin caché */ }
    if (cacheHit != null) { memo.set(firma, cacheHit); return cacheHit; }

    const km = await googleKm(pts);
    memo.set(firma, km);
    if (km != null) {
      try {
        await admin.from("distancias_ruta_cache").upsert({ clave: firma, km, fuente: "google", updated_at: new Date().toISOString() }, { onConflict: "clave" });
      } catch { /* tabla ausente → no cachea */ }
    }
    return km;
  };
}

// ─── AGRUPACIÓN ──────────────────────────────────────────────────────────────

type Agrupado = { label: string; km: number; servicios: number; kmPlan?: number; kmReal?: number; nPlan?: number; nReal?: number };

function acumular(mapa: Map<string, Agrupado>, clave: string, label: string, km: number) {
  const prev = mapa.get(clave) || { label, km: 0, servicios: 0 };
  prev.km = Math.round((prev.km + km) * 10) / 10;
  prev.servicios += 1;
  mapa.set(clave, prev);
}

export async function POST(req: NextRequest) {
  try {
    if (!(await verificarUsuario(req))) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const flota: "propia" | "tercero" = body.flota === "tercero" ? "tercero" : "propia";
    const vehiculoId = Number(body.vehiculo_id);
    const desde: string = body.desde;
    const hasta: string = body.hasta;
    if (!vehiculoId || !desde || !hasta) {
      return NextResponse.json({ error: "Faltan parámetros (vehiculo_id, desde, hasta)" }, { status: 400 });
    }

    const colVeh = flota === "tercero" ? "vehiculo_tercero_id" : "vehiculo_id";
    const { data: reservasData, error: rErr } = await admin
      .from("reservas")
      .select("id,cliente_id,conductor_id,conductor_tercero_id,ruta_nombre,origen,destino,direccion_servicio,fecha_servicio,hora_servicio,hora_real_inicio,estado,precio_cliente")
      .eq(colVeh, vehiculoId)
      .eq("estado", "finalizada")
      .gte("fecha_servicio", desde)
      .lte("fecha_servicio", hasta)
      .order("fecha_servicio", { ascending: true });
    if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });

    const reservas = (reservasData || []) as any[];
    const truncado = reservas.length > MAX_SERVICIOS;
    const usar = truncado ? reservas.slice(0, MAX_SERVICIOS) : reservas;
    const ids = usar.map((r) => Number(r.id));

    // Paradas (coords) de todos los servicios en una consulta → origen/destino/secuencia.
    const paradasPorReserva = new Map<number, Punto[]>();
    if (ids.length) {
      const { data: paradasData } = await admin
        .from("paradas").select("reserva_id,orden,nombre,lat,lng").in("reserva_id", ids).order("orden", { ascending: true });
      for (const p of (paradasData || []) as any[]) {
        const rid = Number(p.reserva_id);
        if (!puntoValido(p)) continue;
        const arr = paradasPorReserva.get(rid) || [];
        arr.push({ lat: Number(p.lat), lng: Number(p.lng), nombre: p.nombre || undefined });
        paradasPorReserva.set(rid, arr);
      }
    }

    // Catálogos para etiquetar.
    const clienteIds = [...new Set(usar.map((r) => r.cliente_id).filter(Boolean))];
    const condIds = [...new Set(usar.map((r) => r.conductor_id).filter(Boolean))];
    const condTerIds = [...new Set(usar.map((r) => r.conductor_tercero_id).filter(Boolean))];
    const [cliRes, conRes, conTerRes] = await Promise.all([
      clienteIds.length ? admin.from("clientes").select("id,nombre,empresa").in("id", clienteIds) : Promise.resolve({ data: [] }),
      condIds.length ? admin.from("conductores").select("id,nombre").in("id", condIds) : Promise.resolve({ data: [] }),
      condTerIds.length ? admin.from("conductores_tercero").select("id,nombre").in("id", condTerIds) : Promise.resolve({ data: [] }),
    ]);
    const nombreCliente = new Map<number, string>((cliRes.data || []).map((c: any) => [c.id, c.empresa || c.nombre || `Cliente #${c.id}`]));
    const nombreCond = new Map<number, string>((conRes.data || []).map((c: any) => [c.id, c.nombre || `Conductor #${c.id}`]));
    const nombreCondTer = new Map<number, string>((conTerRes.data || []).map((c: any) => [c.id, c.nombre || `Conductor #${c.id}`]));

    const memoDist = new Map<string, number | null>();
    const distancia = crearResolvedor(memoDist);
    let usoGoogle = !!GKEY;

    const porConductor = new Map<string, Agrupado>();
    const porCliente = new Map<string, Agrupado>();
    const porRuta = new Map<string, Agrupado>();
    const porSentido = new Map<string, Agrupado>();

    let gpsTotal = 0, kmProductivo = 0, medidoPctMin = 100, servConGps = 0, ingresoTotal = 0;

    // Enriquecer cada servicio con GPS, plan y km atribuido.
    type Serv = { r: any; km: number; kmPlan: number | null; kmReal: number | null; medido: number; origen?: Punto; destino?: Punto };
    const servicios: Serv[] = [];

    for (const r of usar) {
      const s = await kmDeServicio(admin, Number(r.id));
      const kmReal = s.kmRecorridos || 0;
      gpsTotal += kmReal;
      if (kmReal > 0) { servConGps += 1; medidoPctMin = Math.min(medidoPctMin, s.medidoPct); }
      ingresoTotal += Number(r.precio_cliente || 0);

      const pts = paradasPorReserva.get(Number(r.id)) || [];
      let kmPlan: number | null = null;
      if (pts.length >= 2) {
        kmPlan = await distancia(firmaPuntos(pts), pts);
        if (kmPlan == null) usoGoogle = false; // hubo al menos un fallo de Google
      }

      // Km atribuido: GPS real si la huella es confiable; si no, el plan; si tampoco, el GPS crudo.
      const kmAtribuido = (kmReal > 0 && s.medidoPct >= MEDIDO_MIN_CONFIABLE)
        ? kmReal
        : (kmPlan != null ? kmPlan : kmReal);
      kmProductivo += kmAtribuido;

      servicios.push({
        r, km: kmAtribuido, kmPlan, kmReal: kmReal > 0 ? kmReal : null, medido: s.medidoPct,
        origen: pts[0], destino: pts[pts.length - 1],
      });

      // Conductor.
      if (r.conductor_id) acumular(porConductor, `p:${r.conductor_id}`, nombreCond.get(r.conductor_id) || `Conductor #${r.conductor_id}`, kmAtribuido);
      else if (r.conductor_tercero_id) acumular(porConductor, `t:${r.conductor_tercero_id}`, (nombreCondTer.get(r.conductor_tercero_id) || `Conductor #${r.conductor_tercero_id}`) + " (3ero)", kmAtribuido);
      else acumular(porConductor, "sin", "Sin conductor", kmAtribuido);

      // Cliente.
      if (r.cliente_id) acumular(porCliente, `c:${r.cliente_id}`, nombreCliente.get(r.cliente_id) || `Cliente #${r.cliente_id}`, kmAtribuido);
      else acumular(porCliente, "sin", "Sin cliente", kmAtribuido);

      // Ruta (firma geográfica origen→destino; etiqueta legible).
      const label = (r.ruta_nombre || "").trim() || [r.origen, r.destino].filter(Boolean).join(" → ").trim() || "Sin ruta";
      const claveRuta = pts.length >= 2 ? `${r3(pts[0].lat)},${r3(pts[0].lng)}>${r3(pts[pts.length - 1].lat)},${r3(pts[pts.length - 1].lng)}` : label.toLowerCase();
      acumular(porRuta, claveRuta, label, kmAtribuido);
      const gr = porRuta.get(claveRuta)!;
      if (kmPlan != null) { gr.kmPlan = Math.round(((gr.kmPlan || 0) + kmPlan) * 10) / 10; gr.nPlan = (gr.nPlan || 0) + 1; }
      if (kmReal > 0) { gr.kmReal = Math.round(((gr.kmReal || 0) + kmReal) * 10) / 10; gr.nReal = (gr.nReal || 0) + 1; }

      // Sentido.
      const sentido = r.direccion_servicio === "ida" ? "Ida" : r.direccion_servicio === "retorno" ? "Retorno" : "Sin sentido";
      acumular(porSentido, sentido, sentido, kmAtribuido);
    }

    // ── Km en vacío por tramo: entre servicios consecutivos del MISMO día ────────
    let kmVacioTramos = 0, nTramosVacio = 0, tramosSinMedir = 0;
    const porDia = new Map<string, Serv[]>();
    for (const sv of servicios) {
      const dia = sv.r.fecha_servicio;
      const arr = porDia.get(dia) || []; arr.push(sv); porDia.set(dia, arr);
    }
    for (const [, delDia] of porDia) {
      delDia.sort((a, b) => String(a.r.hora_real_inicio || a.r.hora_servicio || "").localeCompare(String(b.r.hora_real_inicio || b.r.hora_servicio || "")));
      for (let i = 1; i < delDia.length; i++) {
        const finAnt = delDia[i - 1].destino;
        const iniSig = delDia[i].origen;
        if (!finAnt || !iniSig) { tramosSinMedir++; continue; }
        if (haversineM(finAnt, iniSig) < MISMO_PUNTO_M) { nTramosVacio++; continue; } // encadenados, ~0 km
        const pts = [finAnt, iniSig];
        let kmLeg = await distancia(firmaPuntos(pts), pts);
        if (kmLeg == null) { kmLeg = Math.round((haversineM(finAnt, iniSig) / 1000) * 10) / 10; tramosSinMedir++; } // fallback recta
        kmVacioTramos += kmLeg;
        nTramosVacio++;
      }
    }
    kmVacioTramos = Math.round(kmVacioTramos * 10) / 10;

    const ordenar = (m: Map<string, Agrupado>) => [...m.values()].sort((a, b) => b.km - a.km);
    const rutasSalida = ordenar(porRuta).map((g) => {
      const kmPlan = g.nPlan ? Math.round((g.kmPlan! / g.nPlan) * 10) / 10 : null;   // promedio por servicio
      const kmReal = g.nReal ? Math.round((g.kmReal! / g.nReal) * 10) / 10 : null;
      const desvioPct = kmPlan && kmReal && kmPlan > 0 ? Math.round(((kmReal - kmPlan) / kmPlan) * 100) : null;
      return { label: g.label, km: g.km, servicios: g.servicios, kmPlan, kmReal, desvioPct };
    });

    return NextResponse.json({
      ok: true,
      flota, vehiculo_id: vehiculoId, desde, hasta,
      nServicios: usar.length, servConGps, truncado, totalReservas: reservas.length,
      usoGoogle,
      gpsTotal: Math.round(gpsTotal * 10) / 10,
      kmProductivo: Math.round(kmProductivo * 10) / 10,
      kmVacioTramos, nTramosVacio, tramosSinMedir,
      medidoPctMin: servConGps ? medidoPctMin : null,
      ingresoTotal: Math.round(ingresoTotal * 100) / 100,
      porConductor: ordenar(porConductor),
      porCliente: ordenar(porCliente),
      porRuta: rutasSalida,
      porSentido: ordenar(porSentido),
    });
  } catch (e: any) {
    console.error("[api/mantenimiento/odometro-analitica]", e);
    return NextResponse.json({ error: e?.message || "Error en la analítica" }, { status: 500 });
  }
}
