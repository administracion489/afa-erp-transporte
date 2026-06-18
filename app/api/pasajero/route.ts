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
        // Usar limit(1) en lugar de maybeSingle() para tolerar DNIs duplicados en BD.
        const { data: rows, error } = await admin
          .from("pasajeros").select("*").eq("dni", String(dni).trim())
          .order("id", { ascending: false }).limit(1);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ pasajero: rows?.[0] ?? null });
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
          return r.fecha_servicio >= hoy && ["pendiente", "programada", "confirmada"].includes(r.estado);
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
        const reserva = miParada.reserva;
        const vId       = reserva?.vehiculo_id;
        const vtId      = reserva?.vehiculo_tercero_id;
        const condId    = reserva?.conductor_id;
        const condTerId = reserva?.conductor_tercero_id;

        // Buscar vehículo: primero flota propia, luego tercerizado
        const fetchVehiculo = vId
          ? admin.from("vehiculos").select("id,placa,categoria,marca,modelo").eq("id", vId).maybeSingle()
          : vtId
            ? admin.from("vehiculos_tercero").select("id,placa,categoria,marca,modelo").eq("id", vtId).maybeSingle()
            : null;

        // Buscar conductor: propio → tercerizado
        const fetchConductor = condId
          ? admin.from("conductores").select("id,nombre,telefono").eq("id", condId).maybeSingle()
          : condTerId
            ? admin.from("conductores_tercero").select("id,nombre,telefono").eq("id", condTerId).maybeSingle()
            : null;

        // Buscar GPS por reserva_id (no ambiguo): funciona igual para flota propia
        // y tercerizada, y tolera puntos viejos (id de tercero en vehiculo_id) y
        // nuevos (en vehiculo_tercero_id). Fallback a vehiculo_id propio si no hay reserva.
        const fetchGPS = rId
          ? admin.from("ubicaciones_gps").select("*").eq("reserva_id", rId).order("created_at", { ascending: false }).limit(1)
          : vId
            ? admin.from("ubicaciones_gps").select("*").eq("vehiculo_id", vId).order("created_at", { ascending: false }).limit(1)
            : null;

        const [vR, cR, uR] = await Promise.all([fetchVehiculo, fetchConductor, fetchGPS]);
        vehiculo   = vR?.data   ?? null;
        conductor  = cR?.data   ?? null;
        busPosicion = uR?.data?.[0] ?? null;

        // Si no hubo conductor por reserva, resolver desde el punto GPS activo.
        // Priorizar conductor_tercero_id (→ conductores_tercero) sobre conductor_id (→ conductores),
        // ya que los IDs se solapan entre ambas tablas.
        if (!conductor && busPosicion?.conductor_tercero_id) {
          const { data: cond } = await admin.from("conductores_tercero").select("id,nombre,telefono").eq("id", busPosicion.conductor_tercero_id).maybeSingle();
          conductor = cond ?? null;
        }
        if (!conductor && busPosicion?.conductor_id) {
          const { data: cond } = await admin.from("conductores").select("id,nombre,telefono").eq("id", busPosicion.conductor_id).maybeSingle();
          conductor = cond ?? null;
        }

        return NextResponse.json({ miParada, miEstado, rutaParadas, vehiculo, busPosicion, conductor });
      }

      // ── Posición del bus en vivo (polling, reemplaza Realtime) ───────────────
      case "bus_posicion": {
        const { reservaId, vehiculoId, esTercero } = body;
        // Preferir reserva_id (no ambiguo). Si solo llega vehiculoId, usar el flag
        // esTercero para elegir vehiculo_tercero_id vs vehiculo_id (los IDs se solapan).
        let q = admin.from("ubicaciones_gps").select("*");
        if (reservaId) {
          q = q.eq("reserva_id", reservaId);
        } else if (vehiculoId) {
          q = q.eq(esTercero ? "vehiculo_tercero_id" : "vehiculo_id", vehiculoId);
        } else {
          return NextResponse.json({ busPosicion: null });
        }
        const { data, error } = await q.order("created_at", { ascending: false }).limit(1);
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

      // ── Cambiar paradero en todos los servicios vigentes ─────────────────────
      case "cambiar_paradero": {
        const { pid, nombreParada, hoy } = body;
        if (!pid || !nombreParada || !hoy) return NextResponse.json({ error: "pid, nombreParada y hoy requeridos" }, { status: 400 });

        const { data: pp, error: ppErr } = await admin
          .from("pasajeros_parada")
          .select("id, parada_id, parada_id_original, parada:paradas(id, nombre, reserva_id, reserva:reservas(id, fecha_servicio, estado, permite_cambio_paradero))")
          .eq("pasajero_id", pid);
        if (ppErr) return NextResponse.json({ error: ppErr.message }, { status: 500 });

        const vigentes = (pp || []).filter((x: any) => {
          const r = x.parada?.reserva;
          if (!r) return false;
          if (r.estado === "en_curso") return true;
          return r.fecha_servicio >= hoy && ["pendiente", "programada", "confirmada"].includes(r.estado);
        });

        let actualizados = 0;
        for (const ppRow of vigentes) {
          const reserva = (ppRow as any).parada?.reserva;
          // Respeta el toggle: si no está habilitado, no cambia silenciosamente
          if (!reserva?.permite_cambio_paradero) continue;
          const reservaId = (ppRow as any).parada?.reserva_id;
          if (!reservaId) continue;
          const { data: candidatas } = await admin
            .from("paradas")
            .select("id")
            .eq("reserva_id", reservaId)
            .eq("nombre", nombreParada)
            .limit(1);
          if (candidatas?.length && candidatas[0].id !== ppRow.parada_id) {
            const { error: updErr } = await admin
              .from("pasajeros_parada")
              .update({
                parada_id: candidatas[0].id,
                parada_id_original: (ppRow as any).parada_id_original ?? ppRow.parada_id,
                cambio_parada_en: new Date().toISOString(),
              })
              .eq("id", ppRow.id);
            if (!updErr) actualizados++;
          }
        }
        return NextResponse.json({ ok: true, actualizados });
      }

      // ── Reservas disponibles para autoselección ───────────────────────────
      case "reservas_disponibles": {
        const { pid, hoy } = body;
        if (!pid || !hoy) return NextResponse.json({ error: "pid y hoy requeridos" }, { status: 400 });

        const { data: pax } = await admin
          .from("pasajeros").select("cliente_id").eq("id", pid).maybeSingle();
        if (!pax?.cliente_id) return NextResponse.json({ reservas: [] });

        const { data: reservas, error: rErr } = await admin
          .from("reservas")
          .select("id, ruta_nombre, origen, destino, fecha_servicio, hora_servicio, vehiculo_id, vehiculo_tercero_id, paradas(*)")
          .eq("cliente_id", pax.cliente_id)
          .eq("permite_autoseleccion", true)
          .gte("fecha_servicio", hoy)
          .in("estado", ["pendiente", "programada", "confirmada"]);
        if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });
        if (!reservas?.length) return NextResponse.json({ reservas: [] });

        const paradaIds = reservas.flatMap((r: any) => (r.paradas || []).map((p: any) => p.id));

        // Mapa parada_id → reserva_id (evita nested selects)
        const paradaToReserva = new Map<number, number>();
        reservas.forEach((r: any) => {
          (r.paradas || []).forEach((p: any) => paradaToReserva.set(p.id, r.id));
        });

        const yaAsignados = new Set<number>();
        const ocupacion = new Map<number, number>(); // reserva_id → total pasajeros

        if (paradaIds.length > 0) {
          const [ppPax, ppTodos] = await Promise.all([
            admin.from("pasajeros_parada").select("parada_id").eq("pasajero_id", pid).in("parada_id", paradaIds),
            admin.from("pasajeros_parada").select("parada_id").in("parada_id", paradaIds),
          ]);
          (ppPax.data || []).forEach((pp: any) => {
            const rId = paradaToReserva.get(pp.parada_id);
            if (rId) yaAsignados.add(rId);
          });
          (ppTodos.data || []).forEach((pp: any) => {
            const rId = paradaToReserva.get(pp.parada_id);
            if (rId) ocupacion.set(rId, (ocupacion.get(rId) || 0) + 1);
          });
        }

        // Obtener capacidades de vehículos
        const vIds  = [...new Set(reservas.filter((r: any) => r.vehiculo_id).map((r: any) => r.vehiculo_id as number))];
        const vtIds = [...new Set(reservas.filter((r: any) => r.vehiculo_tercero_id).map((r: any) => r.vehiculo_tercero_id as number))];
        const [vRes, vtRes] = await Promise.all([
          vIds.length  > 0 ? admin.from("vehiculos").select("id,capacidad_pasajeros").in("id", vIds)         : Promise.resolve({ data: [] as any[] }),
          vtIds.length > 0 ? admin.from("vehiculos_tercero").select("id,capacidad").in("id", vtIds)          : Promise.resolve({ data: [] as any[] }),
        ]);
        const capPropia   = new Map((vRes.data  || []).map((v: any) => [v.id, v.capacidad_pasajeros as number | null]));
        const capTercera  = new Map((vtRes.data || []).map((v: any) => [v.id, v.capacidad           as number | null]));

        const disponibles = reservas
          .filter((r: any) => !yaAsignados.has(r.id))
          .map((r: any) => {
            const cap: number | null = r.vehiculo_id
              ? (capPropia.get(r.vehiculo_id)   ?? null)
              : (capTercera.get(r.vehiculo_tercero_id) ?? null);
            const ocup = ocupacion.get(r.id) || 0;
            return { ...r, capacidad: cap, ocupacion: ocup };
          })
          // Solo buses con lugar disponible (sin capacidad definida = sin límite)
          .filter((r: any) => r.capacidad === null || r.ocupacion < r.capacidad);

        return NextResponse.json({ reservas: disponibles });
      }

      // ── Autoseleccionar paradero ──────────────────────────────────────────
      case "autoseleccionar": {
        const { pid, parada_id } = body;
        if (!pid || !parada_id) return NextResponse.json({ error: "pid y parada_id requeridos" }, { status: 400 });

        // Obtener cliente_id del pasajero
        const { data: pax } = await admin
          .from("pasajeros").select("cliente_id").eq("id", pid).maybeSingle();
        if (!pax?.cliente_id) return NextResponse.json({ error: "Pasajero no encontrado" }, { status: 404 });

        // Verificar que la parada pertenece a una reserva de la empresa con autoselección activa
        const { data: parada } = await admin
          .from("paradas")
          .select("id, reserva_id, reserva:reservas(id, cliente_id, permite_autoseleccion, estado, vehiculo_id, vehiculo_tercero_id)")
          .eq("id", parada_id)
          .maybeSingle();
        const reserva = (parada as any)?.reserva;
        if (!parada || !reserva) return NextResponse.json({ error: "Parada no encontrada" }, { status: 404 });
        if (Number(reserva.cliente_id) !== Number(pax.cliente_id))
          return NextResponse.json({ error: "No autorizado" }, { status: 403 });
        if (!reserva.permite_autoseleccion)
          return NextResponse.json({ error: "No autorizado" }, { status: 403 });
        if (!["pendiente", "programada", "confirmada"].includes(reserva.estado))
          return NextResponse.json({ error: "Servicio no disponible" }, { status: 400 });

        // Verificar que el pasajero no esté ya asignado en esta reserva
        const { data: paradaIds } = await admin
          .from("paradas").select("id").eq("reserva_id", reserva.id);
        const ids = (paradaIds || []).map((p: any) => p.id);
        if (ids.length > 0) {
          const { data: existing } = await admin
            .from("pasajeros_parada").select("id")
            .eq("pasajero_id", pid).in("parada_id", ids).maybeSingle();
          if (existing) return NextResponse.json({ error: "Ya tienes una parada asignada en este servicio" }, { status: 409 });
        }

        // Validar capacidad (protege race conditions)
        if (ids.length > 0) {
          const capRes = reserva.vehiculo_id
            ? await admin.from("vehiculos").select("capacidad_pasajeros").eq("id", reserva.vehiculo_id).maybeSingle()
            : reserva.vehiculo_tercero_id
              ? await admin.from("vehiculos_tercero").select("capacidad").eq("id", reserva.vehiculo_tercero_id).maybeSingle()
              : null;
          const capacidad: number | null = reserva.vehiculo_id
            ? (capRes?.data as any)?.capacidad_pasajeros ?? null
            : (capRes?.data as any)?.capacidad ?? null;
          if (capacidad !== null) {
            const { count } = await admin
              .from("pasajeros_parada")
              .select("id", { count: "exact", head: true })
              .in("parada_id", ids);
            if ((count || 0) >= capacidad)
              return NextResponse.json({ error: "Este servicio ya está lleno" }, { status: 409 });
          }
        }

        // Crear la asignación
        const { error: insErr } = await admin.from("pasajeros_parada").insert({
          pasajero_id: Number(pid),
          parada_id:   Number(parada_id),
          estado_abordaje: "Pendiente",
        });
        if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
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
