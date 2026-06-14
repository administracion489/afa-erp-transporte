// app/api/pasajero/route.ts
// Endpoint único para la app del pasajero. El pasajero se autentica por DNI+PIN
// (NO usa sesión Supabase) → sus consultas directas son anónimas y RLS las bloquea.
// Aquí usamos service_role para saltar RLS, mismo patrón que /api/conductor.
//
// La posición del bus en vivo NO puede usar Realtime (también respeta RLS para
// anónimos): el cliente hace polling de la acción "bus_posicion".
//
// Acciones por POST: { accion, ...params }.

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
      // ── Login por DNI (el PIN se valida en el cliente con la fila devuelta) ───
      case "login": {
        const { dni } = body;
        if (!dni) return NextResponse.json({ error: "dni requerido" }, { status: 400 });
        const { data, error } = await admin.from("pasajeros").select("*").eq("dni", String(dni).trim()).maybeSingle();
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ pasajero: data ?? null });
      }

      // ── Ruta del pasajero (resuelve todo el bundle del seguimiento) ──────────
      case "ruta": {
        const { pid, hoy } = body;
        if (!pid || !hoy) return NextResponse.json({ error: "pid y hoy requeridos" }, { status: 400 });

        const { data: pp, error: ppErr } = await admin
          .from("pasajeros_parada")
          .select(`*, parada:paradas(*, reserva:reservas(*))`)
          .eq("pasajero_id", pid);
        if (ppErr) return NextResponse.json({ error: ppErr.message }, { status: 500 });
        if (!pp?.length) return NextResponse.json({ ruta: null });

        // Solo servicios vigentes: en curso (sin importar fecha) o futuros con estado activo.
        // Nunca retroceder a un servicio viejo como fallback.
        const vigentes = pp.filter((x: any) => {
          const r = x.parada?.reserva;
          if (!r) return false;
          if (r.estado === "en_curso") return true;
          return r.fecha_servicio >= hoy && ["pendiente", "confirmada"].includes(r.estado);
        }).sort((a: any, b: any) => {
          const rA = a.parada?.reserva;
          const rB = b.parada?.reserva;
          const dA = `${rA?.fecha_servicio ?? ""}T${rA?.hora_servicio ?? ""}`;
          const dB = `${rB?.fecha_servicio ?? ""}T${rB?.hora_servicio ?? ""}`;
          return dA.localeCompare(dB);
        });
        const miPP: any = vigentes[0] ?? null;

        if (!miPP?.parada) return NextResponse.json({ ruta: null });

        const miParada = miPP.parada;
        const miEstado = miPP.estado || "esperando";
        const rId = miParada.reserva_id;

        let rutaParadas: any[] = [];
        if (rId) {
          const { data: ps } = await admin.from("paradas").select("*").eq("reserva_id", rId).order("orden");
          rutaParadas = ps || [];
        }

        let vehiculo: any = null, busPosicion: any = null, conductor: any = null;
        const vId = miParada.reserva?.vehiculo_id;
        if (vId) {
          const [vR, uR] = await Promise.all([
            admin.from("vehiculos").select("id,placa,categoria").eq("id", vId).maybeSingle(),
            admin.from("ubicaciones_gps").select("*").eq("vehiculo_id", vId).order("created_at", { ascending: false }).limit(1),
          ]);
          vehiculo = vR.data ?? null;
          busPosicion = uR.data?.[0] ?? null;
          if (busPosicion?.conductor_id) {
            const { data: cond } = await admin.from("conductores").select("id,nombre,telefono").eq("id", busPosicion.conductor_id).maybeSingle();
            conductor = cond ?? null;
          }
        }

        return NextResponse.json({ miParada, miEstado, rutaParadas, vehiculo, busPosicion, conductor });
      }

      // ── Posición del bus en vivo (polling, reemplaza Realtime) ───────────────
      case "bus_posicion": {
        const { vehiculoId } = body;
        if (!vehiculoId) return NextResponse.json({ busPosicion: null });
        const { data, error } = await admin
          .from("ubicaciones_gps").select("*").eq("vehiculo_id", vehiculoId)
          .order("created_at", { ascending: false }).limit(1);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ busPosicion: data?.[0] ?? null });
      }

      // ── Guardar URL de foto de perfil ────────────────────────────────────────
      case "foto": {
        const { pid, fotoUrl } = body;
        if (!pid || !fotoUrl) return NextResponse.json({ error: "pid y fotoUrl requeridos" }, { status: 400 });
        const { error } = await admin.from("pasajeros").update({ foto_url: fotoUrl }).eq("id", pid);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      // ── Mensaje / reporte al operador ────────────────────────────────────────
      case "mensaje": {
        const { mensaje } = body;
        if (!mensaje?.pasajero_id) return NextResponse.json({ error: "mensaje inválido" }, { status: 400 });
        const { error } = await admin.from("mensajes_pasajero").insert(mensaje);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: `Acción desconocida: ${accion}` }, { status: 400 });
    }
  } catch (e: any) {
    console.error("[api/pasajero]", e?.message);
    return NextResponse.json({ error: "Error interno: " + (e?.message ?? "") }, { status: 500 });
  }
}
