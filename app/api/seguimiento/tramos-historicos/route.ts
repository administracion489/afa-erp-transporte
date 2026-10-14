// app/api/seguimiento/tramos-historicos/route.ts — tiempo REAL típico de cada tramo de un
// servicio, medido con las llegadas marcadas en los servicios finalizados de los últimos 30 días.
// NO llama a Google: es lo que el modal GPS enseña por defecto (lib/tramos-historicos.ts).
//
// Dos públicos, igual que /api/cliente/gps (el mismo ModalGps): el operador del ERP (Bearer +
// módulo «seguimiento») y el cliente del portal (token de portal, solo SU reserva — y el
// historial solo con SUS servicios: no se le promedian los de otros clientes).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { verificarTokenPortal, reservaEsDelCliente } from "@/lib/portal-auth";
import { tiemposPorTramo, type PuntoRuta } from "@/lib/tramos-historicos";
import { serviciosHistoricos } from "@/lib/tramos-historicos-datos";

const MAX_PUNTOS = 60;

const adminClient = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

export async function POST(req: NextRequest) {
  type Cuerpo = { reservaId?: unknown; token?: unknown; puntos?: unknown };
  let body: Cuerpo;
  try { body = (await req.json()) as Cuerpo; } catch { return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 }); }
  const reservaId = Number(body?.reservaId);
  if (!Number.isFinite(reservaId) || reservaId <= 0) return NextResponse.json({ error: "reservaId inválido" }, { status: 400 });
  const puntosRaw = Array.isArray(body?.puntos) ? (body.puntos as Array<{ lat?: unknown; lng?: unknown; hora?: unknown }>) : null;
  if (!puntosRaw || puntosRaw.length < 2 || puntosRaw.length > MAX_PUNTOS) {
    return NextResponse.json({ error: `Se necesitan entre 2 y ${MAX_PUNTOS} paraderos` }, { status: 400 });
  }
  const db = adminClient();

  let clienteId: number | null = null;
  if (req.headers.get("authorization")) {
    const auth = await verificarUsuarioApi(req, "seguimiento");
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  } else {
    const sesion = verificarTokenPortal(body?.token);
    if (!sesion) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    if (!(await reservaEsDelCliente(db, reservaId, sesion.cid))) return NextResponse.json({ error: "No autorizado" }, { status: 403 });
    clienteId = sesion.cid;
  }

  const puntos: PuntoRuta[] = puntosRaw.map((p) => ({
    lat: Number.isFinite(Number(p?.lat)) ? Number(p.lat) : null,
    lng: Number.isFinite(Number(p?.lng)) ? Number(p.lng) : null,
    hora: typeof p?.hora === "string" ? p.hora.slice(0, 8) : null,
  }));

  try {
    const { data: rsv } = await db.from("reservas").select("hora_servicio").eq("id", reservaId).maybeSingle();
    const servicios = (await serviciosHistoricos(db, clienteId)).filter((s) => s.reservaId !== reservaId);
    const r = tiemposPorTramo(puntos, servicios, { horaServicio: rsv?.hora_servicio ?? null });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    console.error("[tramos-historicos]", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: "No se pudo leer el historial de servicios" });
  }
}
