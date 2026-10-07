// app/api/conductor-alerta/route.ts
// Maneja dos acciones desde la app conductor (ambas requieren service_role para saltear RLS):
//   tipo = "alerta"   → INSERT en alertas_sos (retraso / SOS)
//   tipo = "embarque" → INSERT en pasajeros_parada (pasajero fuera de manifiesto)
//
// Exige el token de sesión del conductor (lib/conductor-auth.ts) — el `x-afa-key` no autentica
// nada, su valor va en el bundle. Sin token cualquiera sembraba SOS falsos en la torre o marcaba
// abordajes en paraderos ajenos. El servicio / paradero tiene que ser DEL conductor del token.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  sesionDeRequest, sesionLegada, CUERPO_SESION_INVALIDA, reservaEsDelConductor, paradasDelConductor,
} from "@/lib/conductor-auth";
import { registrarAbordaje } from "@/lib/boarding-log";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Bitácora de abordaje (tabla boarding_log, lib/boarding-log.ts). Best-effort: si falla, no
// bloquea el embarque. La lee el reporte del portal cliente por reserva_id (columna «Método»).
const logBoarding = (pasajero_id: number, parada_id: number, reserva_id: number | null) =>
  registrarAbordaje(supabaseAdmin, pasajero_id, parada_id, reserva_id, "conductor-alerta");

export async function POST(req: NextRequest) {
  try {
    // Gate de acceso: si NEXT_PUBLIC_AFA_CONDUCTOR_KEY está configurada, exigir el header
    // x-afa-key (lo manda la app sola). Sin configurar → abierto, para no romper producción.
    const KEY = process.env.NEXT_PUBLIC_AFA_CONDUCTOR_KEY;
    if (KEY && req.headers.get("x-afa-key") !== KEY) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }

    const body = await req.json();
    const { tipo = "alerta" } = body;

    let ses = sesionDeRequest(req, body);
    // Transición del despliegue (ver sesionLegada): un SOS de la app vieja aún abierta no trae
    // token ni conductor; se toma el conductor asignado a su servicio. Nunca para "embarque".
    if (!ses && tipo !== "embarque" && Number(body?.reserva_id) > 0) {
      const { data: r } = await supabaseAdmin.from("reservas")
        .select("conductor_id, conductor_tercero_id").eq("id", Number(body.reserva_id)).maybeSingle();
      ses = sesionLegada(req, body, r);
    }
    if (!ses) return NextResponse.json(CUERPO_SESION_INVALIDA, { status: 401 });

    // ── EMBARQUE fuera de manifiesto ────────────────────────────────────────
    if (tipo === "embarque") {
      const { parada_id, pasajero_id } = body;
      if (!parada_id || !pasajero_id) {
        return NextResponse.json({ error: "parada_id y pasajero_id requeridos" }, { status: 400 });
      }
      // El servicio es el del PARADERO (no el del body), y tiene que ser del conductor.
      const reserva_id = (await paradasDelConductor(supabaseAdmin, ses, [parada_id])).get(Number(parada_id));
      if (!reserva_id) return NextResponse.json({ error: "Este servicio no te pertenece" }, { status: 403 });

      // Verificar si ya existe (evitar duplicado)
      const { data: existe } = await supabaseAdmin
        .from("pasajeros_parada")
        .select("id, estado")
        .eq("parada_id", parada_id)
        .eq("pasajero_id", pasajero_id)
        .maybeSingle();

      if (existe) {
        const eraEmbarcado = existe.estado === "abordado" || existe.estado === "embarcado";
        // Siempre escribir ambas columnas (estado + estado_abordaje/hora_abordaje) — incluso si
        // ya estaba "embarcado", para reparar filas viejas con estado_abordaje desfasado en un re-escaneo.
        const { error: errUpd } = await supabaseAdmin
          .from("pasajeros_parada")
          .update({ estado: "abordado", estado_abordaje: "Abordado", hora_abordaje: new Date().toISOString() })
          .eq("id", existe.id);
        if (errUpd) return NextResponse.json({ error: errUpd.message }, { status: 500 });
        // Solo registrar en bitácora si es un abordaje nuevo (evita inflar el reporte en re-escaneos).
        if (!eraEmbarcado) await logBoarding(pasajero_id, parada_id, reserva_id ?? null);
        return NextResponse.json({ ok: true, id: existe.id, ya_embarcado: eraEmbarcado });
      }

      // No existe → insertar. Intentar primero solo con columnas base (parada_id, pasajero_id, estado).
      // Agregar columnas opcionales una a una para evitar fallo por schema.
      const insertar = async (extra: Record<string, any> = {}) =>
        supabaseAdmin
          .from("pasajeros_parada")
          .insert({ parada_id, pasajero_id, estado: "abordado", estado_abordaje: "Abordado", hora_abordaje: new Date().toISOString(), ...extra })
          .select("id")
          .single();

      // Intento 1: con reserva_id
      let { data: nuevo, error: errIns } = await insertar({ reserva_id: reserva_id ?? null });

      // Intento 2: sin reserva_id, solo si el error es por columna inexistente (PGRST204 /
      // 42703). No reintentar ante un FK/constraint real que mencione 'reserva_id'.
      if (errIns && (errIns.code === "PGRST204" || errIns.code === "42703" || /could not find the .* column/i.test(errIns.message || ""))) {
        ({ data: nuevo, error: errIns } = await insertar());
      }

      // Carrera multi-dispositivo: el índice único (pasajero_id, parada_id) rechazó el INSERT
      // (23505) porque otra llamada ya insertó esta fila (su "winner" ya marcó abordado y
      // registró boarding_log). Recuperar el id y devolver ok sin re-loguear → sin doble conteo.
      // (Si el índice aún no existe, no hay 23505 y degrada al comportamiento previo.)
      if (errIns && (errIns.code === "23505" || /duplicate key value violates unique constraint/i.test(errIns.message || ""))) {
        const { data: ya } = await supabaseAdmin
          .from("pasajeros_parada").select("id")
          .eq("parada_id", parada_id).eq("pasajero_id", pasajero_id).maybeSingle();
        return NextResponse.json({ ok: true, id: ya?.id, ya_embarcado: true });
      }

      if (errIns) {
        console.error("[conductor-alerta] Error insertando pasajero_parada:", errIns.message);
        return NextResponse.json({ error: errIns.message }, { status: 500 });
      }

      await logBoarding(pasajero_id, parada_id, reserva_id ?? null);
      return NextResponse.json({ ok: true, id: nuevo?.id, creado: true });
    }

    // ── ALERTA (retraso / SOS) ──────────────────────────────────────────────
    const { lat, lng } = body;
    const motivo = String(body.motivo ?? "").trim().slice(0, 500);
    if (!motivo) {
      return NextResponse.json({ error: "motivo requerido" }, { status: 400 });
    }
    // Un SOS NUNCA se rechaza por el servicio: si el `reserva_id` no es suyo (p. ej. se lo
    // reasignaron a mitad de turno) la alerta entra igual, sin enlazarse a un servicio ajeno.
    // El estado no lo decide el conductor: toda alerta nace pendiente para la torre.
    const reserva_id = body.reserva_id != null && await reservaEsDelConductor(supabaseAdmin, ses, body.reserva_id)
      ? Number(body.reserva_id) : null;

    const { error } = await supabaseAdmin.from("alertas_sos").insert({
      reserva_id,
      lat:        lat        ?? null,
      lng:        lng        ?? null,
      motivo,
      estado:     "pendiente",
    });

    if (error) {
      console.error("[conductor-alerta] Error insertando alerta:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[conductor-alerta] Exception:", e.message);
    return NextResponse.json({ error: "Error interno: " + e.message }, { status: 500 });
  }
}
