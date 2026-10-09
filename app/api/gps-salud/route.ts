// app/api/gps-salud/route.ts
// Salud del rastreo GPS por CONDUCTOR. Responde la pregunta que hoy nadie puede contestar:
// ¿a qué conductores se les está cortando la ubicación durante el servicio?
//
// POR QUÉ EN EL SERVIDOR: el chip de la app del conductor solo sabe si el plugin arrancó, no
// si el sistema operativo mató el servicio después. Quien conoce la verdad es esta base de
// datos: si llegan puntos, el rastreo vive; si no llegan, no.
//
// LA MÉTRICA: cobertura = % de la VENTANA DEL SERVICIO con GPS llegando.
// El denominador NO puede ser la propia traza. El modo de fallo dominante —Android mata el
// servicio y no rearranca— deja una traza CORTA, no una traza con huecos: un servicio de 3 h
// cuyo rastreo muere al minuto 10 no tiene ningún hueco interno y mediría 100%, que es
// justo lo contrario de la verdad. Por eso la ventana llega hasta la hora prevista de
// llegada (última parada) cuando la traza termina antes.
//
// SOBRE LOS HUECOS: un bus DETENIDO también deja de generar puntos, así que un hueco no
// prueba por sí solo que el rastreo cayera. Por eso se mide `avanceM`: cuánto se movió el bus
// entre el punto anterior y el siguiente al hueco. Si avanzó cientos de metros, el rastreo
// estaba muerto — el bus siguió y nadie lo registró.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
// La medición se EXTRAJO a lib/gps-cobertura.ts (mismo cálculo, verificado contra el original en
// scripts/prueba-gps-cobertura.mts): /seguimiento la usa para su columna RASTREO, y dos motores
// que contestan la misma pregunta terminan contestando distinto.
import { finYDestino, medirCobertura } from "@/lib/gps-cobertura";
import { trazaDe } from "@/lib/gps-cobertura-datos";

export const maxDuration = 60;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const MAX_RESERVAS = 100;     // techo de trabajo por consulta (se informa si se recorta)
const LOTE = 8;               // reservas en paralelo (patrón de /api/jornada/auditoria)

type Punto = { ts: number; lat: number; lng: number };

export async function GET(req: NextRequest) {
  try {
    // ── Autorización ────────────────────────────────────────────────────────
    // Corre con service_role (salta RLS) y devuelve datos de conductores, teléfono incluido:
    // no basta con tener sesión, hace falta el módulo que ve la flota. Mismo criterio que el
    // resto del ERP: admin ve todo; el resto necesita su fila en permisos_usuario.
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    const { data: auth } = await anon.auth.getUser(token);
    const uid = auth?.user?.id;
    if (!uid) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

    const { data: perfil } = await admin.from("usuarios").select("rol, activo").eq("id", uid).maybeSingle();
    if (!perfil || perfil.activo === false) return NextResponse.json({ error: "Usuario inactivo" }, { status: 403 });
    if (perfil.rol !== "admin") {
      const { data: permiso } = await admin.from("permisos_usuario")
        .select("permitido").eq("usuario_id", uid).eq("modulo", "monitoreo").maybeSingle();
      if (!permiso?.permitido) return NextResponse.json({ error: "Sin permiso para este módulo" }, { status: 403 });
    }

    // ── Parámetros (validar ANTES de derivar nada de ellos) ──────────────────
    const url = new URL(req.url);
    const qHasta = url.searchParams.get("hasta");
    const qDesde = url.searchParams.get("desde");
    const fechaOk = (v: string | null) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (!fechaOk(qHasta) || !fechaOk(qDesde)) {
      return NextResponse.json({ error: "Fechas inválidas (se espera AAAA-MM-DD)" }, { status: 400 });
    }
    const hasta = qHasta ?? new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
    const desde = qDesde ?? new Date(Date.parse(hasta) - 6 * 86400e3).toISOString().slice(0, 10);
    if (desde > hasta) return NextResponse.json({ error: "El rango empieza después de terminar" }, { status: 400 });

    // Servicios ya terminados del rango: los que están en curso darían una cobertura falsa
    // (aún les faltan puntos por llegar).
    const { data: reservas, error: errRes } = await admin
      .from("reservas")
      .select("id, fecha_servicio, hora_servicio, conductor_id, conductor_tercero_id, origen, destino")
      .gte("fecha_servicio", desde).lte("fecha_servicio", hasta)
      .eq("estado", "finalizada")
      .order("fecha_servicio", { ascending: false })
      .limit(MAX_RESERVAS + 1);
    if (errRes) return NextResponse.json({ error: errRes.message }, { status: 500 });

    const recortado = (reservas?.length ?? 0) > MAX_RESERVAS;
    const lote = (reservas ?? []).slice(0, MAX_RESERVAS);

    // Hora PREVISTA de llegada = hora_estimada de la última parada, y destino = la última con
    // coordenadas. Es lo que permite ver que una traza terminó antes de tiempo (rastreo muerto
    // que no volvió). Ver finYDestino en lib/gps-cobertura.ts.
    const finPrevisto = new Map<number, number>();
    const destinoDe = new Map<number, { lat: number; lng: number }>();
    if (lote.length) {
      const { data: paradas } = await admin
        .from("paradas").select("reserva_id, orden, hora_estimada, lat, lng")
        .in("reserva_id", lote.map(r => r.id))
        .order("orden", { ascending: true });
      const porReserva = new Map<number, any[]>();
      for (const p of paradas ?? []) porReserva.set(p.reserva_id, [...(porReserva.get(p.reserva_id) ?? []), p]);
      for (const r of lote) {
        const { finPrevistoTs, destino } = finYDestino(porReserva.get(r.id) ?? [], r.fecha_servicio, r.hora_servicio);
        if (finPrevistoTs !== null) finPrevisto.set(r.id, finPrevistoTs);
        if (destino) destinoDe.set(r.id, destino);
      }
    }

    // Nombres de conductores (las dos tablas: propios y tercerizados), indexados por id.
    const idsP = [...new Set(lote.map(r => r.conductor_id).filter(Boolean))];
    const idsT = [...new Set(lote.map(r => r.conductor_tercero_id).filter(Boolean))];
    const [rp, rt] = await Promise.all([
      idsP.length ? admin.from("conductores").select("id, nombre, telefono").in("id", idsP) : Promise.resolve({ data: [], error: null } as any),
      idsT.length ? admin.from("conductores_tercero").select("id, nombre, telefono").in("id", idsT) : Promise.resolve({ data: [], error: null } as any),
    ]);
    // Si falla, se avisa: sin nombre ni teléfono el panel no sirve para lo que existe
    // (llamar al conductor), y degradar en silencio a "—" lo ocultaría.
    const avisoNombres = rp?.error || rt?.error ? "No se pudieron leer todos los nombres de conductores" : null;
    type Cond = { id: number; nombre: string | null; telefono: string | null };
    const mapP = new Map<number, Cond>((rp?.data ?? []).map((c: any) => [c.id, c as Cond]));
    const mapT = new Map<number, Cond>((rt?.data ?? []).map((c: any) => [c.id, c as Cond]));
    // Precedencia propio → tercero, igual que el resto del repo.
    const quien = (r: any) => {
      if (r.conductor_id) { const c = mapP.get(r.conductor_id); return { clave: `P${r.conductor_id}`, nombre: c?.nombre ?? "—", telefono: c?.telefono ?? null, tercero: false }; }
      if (r.conductor_tercero_id) { const c = mapT.get(r.conductor_tercero_id); return { clave: `T${r.conductor_tercero_id}`, nombre: c?.nombre ?? "—", telefono: c?.telefono ?? null, tercero: true }; }
      return { clave: "SIN", nombre: "Sin conductor asignado", telefono: null, tercero: false };
    };

    // ── Medición, en lotes paralelos (secuencial tardaba ~30 s con 120 reservas) ──
    const medir = async (r: any) => {
      let t: Punto[] = [];
      let totalCrudo = 0, porAntena = 0, simulados = 0;
      let fallo: string | null = null;
      try { const tz = await trazaDe(r.id); t = tz.pts; totalCrudo = tz.totalCrudo; porAntena = tz.porAntena; simulados = tz.simulados; } catch (e: any) { fallo = e?.message ?? "error al leer la traza"; }
      const base = { ...quien(r), reservaId: r.id, fecha: r.fecha_servicio, hora: r.hora_servicio, origen: r.origen, destino: r.destino };

      // Ventana del servicio: del primer punto hasta la hora prevista de llegada (o el último
      // punto, si el servicio se alargó). Sin puntos no hay arranque conocido → no medible.
      const pctAntena = totalCrudo ? Math.round((porAntena / totalCrudo) * 100) : 0;
      if (fallo || t.length < 2) {
        // OJO: "sin traza utilizable" puede ser un teléfono 100% por antena — totalCrudo > 0
        // con todos los puntos descartados. Distinto de "no emitió nada".
        return { ...base, puntos: t.length, puntosCrudos: totalCrudo, pctAntena, simulados, durMin: 0, cobertura: totalCrudo ? 0 : null, cortes: 0, peorHuecoMin: 0, kmACiegas: 0, fallo };
      }
      const m = medirCobertura({ pts: t, destino: destinoDe.get(r.id) ?? null, finPrevistoTs: finPrevisto.get(r.id) ?? null })!;
      return {
        ...base,
        puntos: t.length,
        puntosCrudos: totalCrudo,
        pctAntena,
        simulados,
        durMin: m.durMin,
        cobertura: m.cobertura,
        cortes: m.cortes,
        peorHuecoMin: m.peorHuecoMin,
        kmACiegas: m.kmACiegas,
        fallo: null,
      };
    };

    const servicios: any[] = [];
    for (let i = 0; i < lote.length; i += LOTE) {
      servicios.push(...await Promise.all(lote.slice(i, i + LOTE).map(medir)));
    }

    // Agregado por conductor. Los servicios sin traza NO se excluyen del conductor: son el
    // peor caso posible (el rastreo nunca emitió) y excluirlos borraba del tablero justo a
    // quien más falla. Se cuentan aparte para poder explicarlos.
    const porConductor = new Map<string, any>();
    for (const s of servicios) {
      if (s.clave === "SIN") continue;                 // sin conductor no hay a quién avisar
      if (!porConductor.has(s.clave)) porConductor.set(s.clave, { clave: s.clave, nombre: s.nombre, telefono: s.telefono, tercero: s.tercero, servicios: 0, sinTraza: 0, suma: 0, medidos: 0, cortes: 0, kmACiegas: 0, peor: 100, crudos: 0, antena: 0, simulados: 0 });
      const c = porConductor.get(s.clave);
      c.servicios++;
      c.crudos += s.puntosCrudos ?? 0;
      c.simulados += s.simulados ?? 0;
      c.antena += s.puntosCrudos ? Math.round((s.pctAntena ?? 0) * s.puntosCrudos / 100) : 0;
      if (s.cobertura === null) { c.sinTraza++; continue; }
      c.medidos++; c.suma += s.cobertura; c.cortes += s.cortes; c.kmACiegas += s.kmACiegas;
      if (s.cobertura < c.peor) c.peor = s.cobertura;
    }
    const conductores = [...porConductor.values()]
      .map(c => ({ ...c, cobertura: c.medidos ? Math.round(c.suma / c.medidos) : null, peor: c.medidos ? c.peor : null, kmACiegas: Math.round(c.kmACiegas * 10) / 10, pctAntena: c.crudos ? Math.round(c.antena / c.crudos * 100) : 0 }))
      .sort((a, b) => (a.cobertura ?? -1) - (b.cobertura ?? -1));

    const medidos = servicios.filter(s => s.cobertura !== null);
    return NextResponse.json({
      desde, hasta, recortado, limite: MAX_RESERVAS, aviso: avisoNombres,
      totales: {
        servicios: medidos.length,
        sinTraza: servicios.filter(s => s.cobertura === null).length,
        sinConductor: servicios.filter(s => s.clave === "SIN").length,
        conductores: conductores.length,
        malos: conductores.filter(c => c.cobertura !== null && c.cobertura < 90).length,
        conSimulado: conductores.filter(c => c.simulados > 0).length,
        kmACiegas: Math.round(conductores.reduce((a, c) => a + c.kmACiegas, 0) * 10) / 10,
      },
      conductores,
      servicios: servicios.sort((a, b) => (a.cobertura ?? -1) - (b.cobertura ?? -1)),
    });
  } catch (e: any) {
    console.error("[gps-salud]", e);
    return NextResponse.json({ error: e?.message ?? "Error inesperado" }, { status: 500 });
  }
}
