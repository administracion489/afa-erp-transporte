// app/api/jornada/auditoria/route.ts
// Auditoría de kilometraje de jornada (Fase 3·D). Para una FECHA, por cada unidad con actividad:
//   - km jornada     = check-out (checkout_conductor.km_fin) − check-in (checklist_conductor.km_inicio)
//                      (fallback: max − min de lecturas_odometro del día para esa unidad)
//   - km operativos  = Σ km de servicios (GPS, lib/km-servicio.ts) de sus reservas finalizadas
//   - km no justif.  = km jornada − km operativos   (positivo grande = traslados en vacío / uso no
//                      registrado o huecos GPS; negativo = GPS inflado u odómetro mal leído)
// Clasifica con los umbrales editables de jornada_config. Nunca acusa: solo muestra la diferencia.
//
// Usa service-role (para leer terceros y GPS sin RLS). Verifica que el llamador sea un usuario
// logueado del ERP (Bearer del token de Supabase) — mismo criterio que el resto de rutas admin.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { kmDeServicio } from "@/lib/km-servicio";

export const maxDuration = 60;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const UMBRALES_DEFECTO = { umbral_advertencia: 6, umbral_revision: 16, umbral_alto: 31, recordar_checkout_cada_min: 60 };

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

async function cargarUmbrales() {
  try {
    const { data } = await admin.from("jornada_config").select("*").eq("id", 1).maybeSingle();
    return { ...UMBRALES_DEFECTO, ...(data || {}) };
  } catch {
    return { ...UMBRALES_DEFECTO };
  }
}

function clasificar(noJustificados: number | null, u: any): "sin_datos" | "normal" | "advertencia" | "revision" | "alto" {
  if (noJustificados == null) return "sin_datos";
  const d = Math.abs(noJustificados);
  if (d >= Number(u.umbral_alto)) return "alto";
  if (d >= Number(u.umbral_revision)) return "revision";
  if (d >= Number(u.umbral_advertencia)) return "advertencia";
  return "normal";
}

export async function POST(req: NextRequest) {
  try {
    if (!(await verificarUsuario(req))) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }
    const body = await req.json().catch(() => ({}));
    const accion = body.accion || "auditoria";

    // ── Guardar umbrales editables ──────────────────────────────────────────
    if (accion === "guardar_config") {
      const { umbral_advertencia, umbral_revision, umbral_alto, recordar_checkout_cada_min } = body;
      const upd: Record<string, number> = {};
      if (umbral_advertencia != null) upd.umbral_advertencia = Number(umbral_advertencia);
      if (umbral_revision != null) upd.umbral_revision = Number(umbral_revision);
      if (umbral_alto != null) upd.umbral_alto = Number(umbral_alto);
      if (recordar_checkout_cada_min != null) upd.recordar_checkout_cada_min = Number(recordar_checkout_cada_min);
      const { error } = await admin.from("jornada_config").update({ ...upd, updated_at: new Date().toISOString() }).eq("id", 1);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, config: await cargarUmbrales() });
    }

    // ── Auditoría de una fecha ────────────────────────────────────────────────
    const fecha: string = body.fecha || new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
    const u = await cargarUmbrales();

    const [rRes, ckRes, coRes, vRes, vtRes, loRes] = await Promise.all([
      admin.from("reservas")
        .select("id,estado,vehiculo_id,vehiculo_tercero_id,conductor_id,conductor_tercero_id,origen,destino")
        .eq("fecha_servicio", fecha),
      admin.from("checklist_conductor").select("vehiculo_id,km_inicio,fecha").eq("fecha", fecha),
      admin.from("checkout_conductor").select("vehiculo_id,es_tercero,km_fin,fecha").eq("fecha", fecha),
      admin.from("vehiculos").select("id,placa"),
      admin.from("vehiculos_tercero").select("id,placa"),
      admin.from("lecturas_odometro").select("vehiculo_id,vehiculo_tercero_id,km,fecha,estado").eq("fecha", fecha),
    ]);

    const reservas = (rRes.data || []) as any[];
    const checkins = (ckRes.data || []) as any[];       // checklist_conductor (km_inicio)
    const checkouts = (coRes.data || []) as any[];       // checkout_conductor (km_fin)
    const placaPropia = new Map<number, string>((vRes.data || []).map((v: any) => [v.id, v.placa]));
    const placaTercero = new Map<number, string>((vtRes.data || []).map((v: any) => [v.id, v.placa]));
    const lecturas = (loRes.data || []) as any[];

    // Agrupar las reservas por unidad (propia "p:ID" o tercera "t:ID").
    const grupos = new Map<string, { flota: "propia" | "tercero"; vid: number; placa: string; reservaIds: number[] }>();
    for (const r of reservas) {
      const esTercero = !r.vehiculo_id && !!r.vehiculo_tercero_id;
      const vid = esTercero ? r.vehiculo_tercero_id : r.vehiculo_id;
      if (!vid) continue;
      const key = `${esTercero ? "t" : "p"}:${vid}`;
      if (!grupos.has(key)) {
        grupos.set(key, {
          flota: esTercero ? "tercero" : "propia",
          vid,
          placa: (esTercero ? placaTercero.get(vid) : placaPropia.get(vid)) || `#${vid}`,
          reservaIds: [],
        });
      }
      // Solo cuentan como "operativo" los servicios finalizados (con recorrido real).
      if (r.estado === "finalizada") grupos.get(key)!.reservaIds.push(r.id);
    }

    const filas: any[] = [];
    for (const g of grupos.values()) {
      // km operativos = Σ km de sus servicios finalizados (GPS)
      let kmOperativos = 0;
      let medidoMin = 100;
      for (const rid of g.reservaIds) {
        const s = await kmDeServicio(admin, rid);
        kmOperativos += s.kmRecorridos;
        if (s.kmRecorridos > 0) medidoMin = Math.min(medidoMin, s.medidoPct);
      }
      kmOperativos = Math.round(kmOperativos * 10) / 10;

      // km jornada = check-out − check-in (explícito); fallback a max − min de lecturas del día.
      const esT = g.flota === "tercero";
      const ci = checkins.find((c) => !esT && Number(c.vehiculo_id) === g.vid); // checklist es de flota propia
      const co = checkouts.find((c) => Number(c.vehiculo_id) === g.vid && (c.es_tercero === esT));
      let kmInicio: number | null = ci?.km_inicio != null ? Number(ci.km_inicio) : null;
      let kmFin: number | null = co?.km_fin != null ? Number(co.km_fin) : null;

      const lecUnidad = lecturas
        .filter((l) => (esT ? Number(l.vehiculo_tercero_id) === g.vid : Number(l.vehiculo_id) === g.vid))
        .map((l) => Number(l.km))
        .filter((k) => Number.isFinite(k) && k > 0);
      if (kmInicio == null && lecUnidad.length) kmInicio = Math.min(...lecUnidad);
      if (kmFin == null && lecUnidad.length) kmFin = Math.max(...lecUnidad);

      const kmJornada = kmInicio != null && kmFin != null && kmFin >= kmInicio ? kmFin - kmInicio : null;
      const noJustificados = kmJornada != null ? Math.round((kmJornada - kmOperativos) * 10) / 10 : null;

      filas.push({
        unidad: g.placa,
        flota: g.flota,
        km_inicio: kmInicio,
        km_fin: kmFin,
        km_jornada: kmJornada,
        km_operativos: kmOperativos,
        km_no_justificados: noJustificados,
        servicios: g.reservaIds.length,
        medido_pct: g.reservaIds.length ? medidoMin : null,
        tiene_checkin: !!ci,
        tiene_checkout: !!co,
        clasificacion: clasificar(noJustificados, u),
      });
    }

    filas.sort((a, b) => Math.abs(Number(b.km_no_justificados ?? -1)) - Math.abs(Number(a.km_no_justificados ?? -1)));

    return NextResponse.json({ ok: true, fecha, config: u, filas });
  } catch (e: any) {
    console.error("[api/jornada/auditoria]", e);
    return NextResponse.json({ error: e?.message || "Error en la auditoría" }, { status: 500 });
  }
}
