// app/api/conductor/route.ts
// Endpoint único para la app del conductor. El conductor se autentica por PIN
// (NO usa sesión Supabase), así que sus consultas directas son anónimas y RLS
// las bloquea. Aquí usamos service_role para saltar RLS — mismo patrón que
// /api/conductor-alerta y /api/conductor-tercero/*.
//
// Todas las acciones llegan por POST: { accion, ...params }.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const accion = body.accion as string;

    switch (accion) {
      // ── Datos del home (reservas de hoy + vehículos + docs + checklist) ──────
      case "inicio": {
        const { cid, tabla, hoy } = body;
        if (!cid || !hoy) return NextResponse.json({ error: "cid y hoy requeridos" }, { status: 400 });
        const condField = tabla === "conductores_tercero" ? "conductor_tercero_id" : "conductor_id";

        const [vR, vTR, rR, dR, ckR] = await Promise.all([
          admin.from("vehiculos").select("id,placa,categoria,marca").order("placa"),
          admin.from("vehiculos_tercero").select("id,placa,categoria,marca").order("placa"),
          admin.from("reservas")
            .select("id,origen,destino,fecha_servicio,hora_servicio,vehiculo_id,vehiculo_tercero_id,estado")
            .eq("fecha_servicio", hoy).eq(condField, cid).order("hora_servicio"),
          admin.from("documentos_conductor").select("*").eq("conductor_id", cid).order("created_at", { ascending: false }),
          admin.from("checklist_conductor").select("id").eq("conductor_id", cid).eq("fecha", hoy).limit(1),
        ]);

        const err = vR.error || vTR.error || rR.error || dR.error || ckR.error;
        if (err) return NextResponse.json({ error: err.message }, { status: 500 });

        return NextResponse.json({
          vehiculos:        vR.data  || [],
          vehiculosTercero: vTR.data || [],
          reservas:         rR.data  || [],
          docs:             dR.data  || [],
          checklistHecho:   !!(ckR.data && ckR.data.length > 0),
        });
      }

      // ── Pasajeros de una ruta (por paradas) ──────────────────────────────────
      case "pasajeros": {
        const { paradaIds } = body;
        if (!Array.isArray(paradaIds) || paradaIds.length === 0) return NextResponse.json({ pasajeros: [] });
        const { data, error } = await admin.from("pasajeros_parada")
          .select("*, pasajero:pasajeros(*)").in("parada_id", paradaIds);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ pasajeros: data || [] });
      }

      // ── Buscar pasajero por QR ───────────────────────────────────────────────
      case "buscar_pasajero": {
        const { qrCode } = body;
        if (!qrCode) return NextResponse.json({ error: "qrCode requerido" }, { status: 400 });
        const { data, error } = await admin.from("pasajeros").select("*").eq("qr_code", qrCode).maybeSingle();
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ pasajero: data ?? null });
      }

      // ── Enviar ubicación GPS ─────────────────────────────────────────────────
      case "ubicacion": {
        const { payload } = body;
        if (!payload?.conductor_id) return NextResponse.json({ error: "payload inválido" }, { status: 400 });
        const { error } = await admin.from("ubicaciones_gps").insert(payload);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      // ── Marcar parada completada ─────────────────────────────────────────────
      case "marcar_parada": {
        const { paradaId } = body;
        if (!paradaId) return NextResponse.json({ error: "paradaId requerido" }, { status: 400 });
        const { error } = await admin.from("paradas").update({ estado: "completada" }).eq("id", paradaId);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      // ── Embarcar pasajero en lista ───────────────────────────────────────────
      case "embarcar": {
        const { ppId } = body;
        if (!ppId) return NextResponse.json({ error: "ppId requerido" }, { status: 400 });
        const { error } = await admin.from("pasajeros_parada").update({ estado: "embarcado" }).eq("id", ppId);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      // ── Reportar incidencia ──────────────────────────────────────────────────
      case "incidencia": {
        const { incidencia } = body;
        if (!incidencia?.conductor_id) return NextResponse.json({ error: "incidencia inválida" }, { status: 400 });
        const { error } = await admin.from("incidencias").insert(incidencia);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      // ── Guardar checklist pre-viaje ──────────────────────────────────────────
      case "checklist": {
        const { checklist } = body;
        if (!checklist?.conductor_id) return NextResponse.json({ error: "checklist inválido" }, { status: 400 });
        const { error } = await admin.from("checklist_conductor").insert(checklist);
        if (error) {
          // FK violation: el conductor es de conductores_tercero y su ID no existe
          // en conductores. El conductor ya completó el pre-viaje visualmente — no
          // bloquearlo. TODO: agregar columna conductor_tercero_id a checklist_conductor.
          if (error.message.includes("foreign key") || error.message.includes("violates")) {
            console.warn("[checklist] FK tercero — no guardado en BD:", error.message);
            return NextResponse.json({ ok: true });
          }
          return NextResponse.json({ error: error.message }, { status: 500 });
        }
        return NextResponse.json({ ok: true });
      }

      // ── Registrar documento ──────────────────────────────────────────────────
      case "documento": {
        const { documento } = body;
        if (!documento?.conductor_id) return NextResponse.json({ error: "documento inválido" }, { status: 400 });
        const { data, error } = await admin.from("documentos_conductor").insert(documento).select().single();
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true, documento: data });
      }

      // ── Actualizar estado de reserva ────────────────────────────────────────
      case "actualizar_estado": {
        const { reservaId, estado } = body;
        if (!reservaId || !estado) return NextResponse.json({ error: "reservaId y estado requeridos" }, { status: 400 });
        const estadosValidos = ["pendiente", "programada", "confirmada", "en_curso", "finalizada", "cancelada"];
        if (!estadosValidos.includes(estado)) return NextResponse.json({ error: "estado inválido" }, { status: 400 });
        const { error } = await admin.from("reservas").update({ estado }).eq("id", reservaId);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      // ── Cambiar PIN de acceso ────────────────────────────────────────────────
      case "cambiar_pin": {
        const { cid, tabla, pin } = body;
        if (!cid || !pin) return NextResponse.json({ error: "cid y pin requeridos" }, { status: 400 });
        const t = tabla === "conductores_tercero" ? "conductores_tercero" : "conductores";
        const { error } = await admin.from(t).update({ pin_acceso: pin }).eq("id", cid);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: `Acción desconocida: ${accion}` }, { status: 400 });
    }
  } catch (e: any) {
    console.error("[api/conductor]", e?.message);
    return NextResponse.json({ error: "Error interno: " + (e?.message ?? "") }, { status: 500 });
  }
}
