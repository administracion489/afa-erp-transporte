// app/api/mensajes/responder/route.ts
// Respuesta del OPERADOR a un pasajero (hilo bidireccional de mensajes_pasajero).
// Auth por Bearer de sesión Supabase (mismo patrón que /api/crear-usuario): cualquier
// usuario ACTIVO puede responder desde /seguimiento. La inserción + el push van con
// service_role (el push es solo-servidor). Responder marca como atendidos los mensajes
// pendientes de ese pasajero en el hilo.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { enviarPushAPasajeros, payloadRespuestaChat } from "@/lib/push";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabasePublic = createClient(supabaseUrl, anonKey);
const admin = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export async function POST(request: Request) {
  try {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

    const { data: authData } = await supabasePublic.auth.getUser(token);
    if (!authData.user) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });

    const { data: perfil } = await admin
      .from("usuarios").select("nombre, activo").eq("id", authData.user.id).single();
    if (!perfil || perfil.activo === false) {
      return NextResponse.json({ error: "Usuario inactivo" }, { status: 403 });
    }

    const body = await request.json();
    const pasajeroId = Number(body.pasajero_id);
    const reservaId = body.reserva_id != null ? Number(body.reserva_id) : null;
    const texto = String(body.texto ?? "").trim().slice(0, 1000);
    if (!Number.isFinite(pasajeroId) || pasajeroId <= 0) {
      return NextResponse.json({ error: "pasajero_id inválido" }, { status: 400 });
    }
    if (!texto) return NextResponse.json({ error: "mensaje vacío" }, { status: 400 });

    const autorNombre = String(perfil.nombre || "Central AFA").trim() || "Central AFA";

    const { data: fila, error } = await admin.from("mensajes_pasajero").insert({
      pasajero_id: pasajeroId,
      reserva_id: reservaId,
      tipo: "respuesta",
      mensaje: texto,
      remitente: "operador",
      autor_nombre: autorNombre,
      autor_id: authData.user.id,
      leido: true,                 // el propio operador ya "leyó" lo que responde
      leido_at: new Date().toISOString(),
      leido_pasajero: false,       // el pasajero aún no la ve
    }).select("*").single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Responder = atender: marca leídos los mensajes pendientes del pasajero en el hilo.
    let q = admin.from("mensajes_pasajero")
      .update({ leido: true, leido_por: autorNombre, leido_at: new Date().toISOString() })
      .eq("pasajero_id", pasajeroId).eq("remitente", "pasajero").eq("leido", false);
    if (reservaId != null) q = q.eq("reserva_id", reservaId);
    await q;

    // Push al pasajero (el operador se muestra como "Central AFA", no su nombre real).
    await enviarPushAPasajeros([pasajeroId], payloadRespuestaChat("Central AFA", texto, pasajeroId), {
      urgencia: "high", ttl: 3600,
    });

    return NextResponse.json({ ok: true, mensaje: fila });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Error interno" }, { status: 500 });
  }
}
