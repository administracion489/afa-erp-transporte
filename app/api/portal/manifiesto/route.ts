// POST /api/portal/manifiesto
// Gestión de pasajeros del manifiesto desde el portal cliente.
// Acciones: add | remove | bulk | assign_parada | actualizar_config
// Seguridad: verifica que reservas.cliente_id === cliente_id y que el servicio sea editable.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const ESTADOS_EDITABLES = ["pendiente", "confirmado", "confirmada", "por_confirmar", "programada"];

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function verificarAcceso(
  reservaId: number,
  clienteId: number
): Promise<{ ok: boolean; error?: string; status?: number }> {
  const { data: r, error } = await supabaseAdmin
    .from("reservas")
    .select("id, cliente_id, estado")
    .eq("id", reservaId)
    .single();

  if (error || !r) return { ok: false, error: "Servicio no encontrado", status: 404 };
  if (Number(r.cliente_id) !== Number(clienteId)) return { ok: false, error: "No autorizado", status: 403 };
  if (!ESTADOS_EDITABLES.includes(r.estado)) {
    return { ok: false, error: "El servicio ya fue realizado. El manifiesto está bloqueado.", status: 403 };
  }
  return { ok: true };
}

async function verificarParada(paradaId: number, reservaId: number): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("paradas").select("reserva_id").eq("id", paradaId).single();
  return !!data && Number(data.reserva_id) === Number(reservaId);
}

/** Asigna o reasigna la parada de un pasajero (borrando asignación previa en esta reserva) */
async function setParadaAsignacion(
  pasajeroId: number,
  reservaId: number,
  paradaId: number | null
): Promise<string | null> {
  // Borrar asignación previa en las paradas de esta reserva
  const { data: paradaIds } = await supabaseAdmin
    .from("paradas").select("id").eq("reserva_id", reservaId);
  const ids = (paradaIds || []).map((p: any) => p.id);
  if (ids.length > 0) {
    await supabaseAdmin.from("pasajeros_parada")
      .delete().eq("pasajero_id", pasajeroId).in("parada_id", ids);
  }
  if (paradaId) {
    const { error } = await supabaseAdmin.from("pasajeros_parada").insert({
      pasajero_id: pasajeroId,
      parada_id: paradaId,
      estado_abordaje: "Pendiente",
    });
    if (error) return error.message;
  }
  return null;
}

// ─── Handler principal ────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, cliente_id, reserva_id } = body;

    if (!action || !cliente_id || !reserva_id) {
      return NextResponse.json({ error: "Parámetros incompletos" }, { status: 400 });
    }

    const acceso = await verificarAcceso(Number(reserva_id), Number(cliente_id));
    if (!acceso.ok) {
      return NextResponse.json({ error: acceso.error }, { status: acceso.status });
    }

    // ── ADD: insertar un pasajero al manifiesto de esta reserva ──────────────
    if (action === "add") {
      const { nombre, dni, empresa, telefono, parada_id } = body;
      if (!nombre?.trim() || !dni?.trim()) {
        return NextResponse.json({ error: "Nombre y DNI son requeridos" }, { status: 400 });
      }
      if (parada_id && !(await verificarParada(Number(parada_id), Number(reserva_id)))) {
        return NextResponse.json({ error: "Parada no válida para este servicio" }, { status: 400 });
      }

      // Verificar que no esté ya en esta reserva (por DNI)
      const { data: dup } = await supabaseAdmin
        .from("pasajeros").select("id").eq("dni", dni.trim()).eq("reserva_id", reserva_id).maybeSingle();
      if (dup) {
        return NextResponse.json({ error: "Ya existe un pasajero con ese DNI en este servicio" }, { status: 409 });
      }

      const { data: nuevo, error: insErr } = await supabaseAdmin.from("pasajeros").insert({
        reserva_id,
        cliente_id,
        nombre: nombre.trim(),
        dni: dni.trim(),
        empresa: empresa?.trim() || null,
        telefono: telefono?.trim() || null,
        activo: true,
      }).select("id").single();

      if (insErr || !nuevo) {
        return NextResponse.json({ error: insErr?.message || "Error al crear pasajero" }, { status: 500 });
      }

      if (parada_id) {
        const paradaErr = await setParadaAsignacion(nuevo.id, Number(reserva_id), Number(parada_id));
        if (paradaErr) return NextResponse.json({ error: paradaErr }, { status: 500 });
      }

      return NextResponse.json({ ok: true, pasajero_id: nuevo.id });
    }

    // ── REMOVE: eliminar pasajero del manifiesto ──────────────────────────────
    if (action === "remove") {
      const { pasajero_id } = body;
      if (!pasajero_id) return NextResponse.json({ error: "pasajero_id requerido" }, { status: 400 });

      // Verificar que el pasajero pertenece a esta reserva
      const { data: pax } = await supabaseAdmin
        .from("pasajeros").select("id, reserva_id").eq("id", pasajero_id).single();
      if (!pax || Number(pax.reserva_id) !== Number(reserva_id)) {
        return NextResponse.json({ error: "Pasajero no encontrado en este servicio" }, { status: 404 });
      }

      // Quitar asignaciones de parada
      const { data: paradaIds } = await supabaseAdmin
        .from("paradas").select("id").eq("reserva_id", reserva_id);
      const ids = (paradaIds || []).map((p: any) => p.id);
      if (ids.length > 0) {
        await supabaseAdmin.from("pasajeros_parada")
          .delete().eq("pasajero_id", pasajero_id).in("parada_id", ids);
      }

      // Eliminar el pasajero de la tabla (solo si es adhoc de esta reserva)
      const { error: delErr } = await supabaseAdmin
        .from("pasajeros").delete().eq("id", pasajero_id);
      if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

      return NextResponse.json({ ok: true });
    }

    // ── ASSIGN_PARADA: cambiar parada asignada ────────────────────────────────
    if (action === "assign_parada") {
      const { pasajero_id, parada_id } = body;
      if (!pasajero_id) return NextResponse.json({ error: "pasajero_id requerido" }, { status: 400 });

      // Verificar que el pasajero es de esta reserva
      const { data: pax } = await supabaseAdmin
        .from("pasajeros").select("reserva_id").eq("id", pasajero_id).single();
      if (!pax || Number(pax.reserva_id) !== Number(reserva_id)) {
        return NextResponse.json({ error: "Pasajero no encontrado en este servicio" }, { status: 404 });
      }

      if (parada_id && !(await verificarParada(Number(parada_id), Number(reserva_id)))) {
        return NextResponse.json({ error: "Parada no válida" }, { status: 400 });
      }

      const paradaErr = await setParadaAsignacion(
        Number(pasajero_id),
        Number(reserva_id),
        parada_id ? Number(parada_id) : null
      );
      if (paradaErr) return NextResponse.json({ error: paradaErr }, { status: 500 });

      return NextResponse.json({ ok: true });
    }

    // ── BULK: carga masiva desde Excel ────────────────────────────────────────
    if (action === "bulk") {
      const { pasajeros } = body;
      if (!Array.isArray(pasajeros) || pasajeros.length === 0) {
        return NextResponse.json({ error: "Lista de pasajeros vacía" }, { status: 400 });
      }

      // Verificar paradas del servicio para nombre → id
      const { data: paradasSvc } = await supabaseAdmin
        .from("paradas").select("id, nombre").eq("reserva_id", reserva_id);
      const paradasMap: Record<string, number> = {};
      (paradasSvc || []).forEach((p: any) => {
        paradasMap[p.nombre.toLowerCase().trim()] = p.id;
      });

      // DNIs ya en esta reserva (para evitar duplicados)
      const { data: existentes } = await supabaseAdmin
        .from("pasajeros").select("dni").eq("reserva_id", reserva_id);
      const dnisExistentes = new Set((existentes || []).map((p: any) => p.dni));

      let added = 0;
      let skipped = 0;
      const errores: string[] = [];

      for (const p of pasajeros) {
        if (!p.nombre?.trim() || !p.dni?.trim()) { skipped++; continue; }
        if (dnisExistentes.has(p.dni.trim())) { skipped++; continue; }

        const { data: nuevo, error: insErr } = await supabaseAdmin.from("pasajeros").insert({
          reserva_id,
          cliente_id,
          nombre: p.nombre.trim(),
          dni: p.dni.trim(),
          empresa: p.empresa?.trim() || null,
          telefono: p.telefono?.trim() || null,
          activo: true,
        }).select("id").single();

        if (insErr || !nuevo) { skipped++; errores.push(p.nombre); continue; }

        dnisExistentes.add(p.dni.trim());

        // Intentar asignar parada por nombre
        if (p.parada_nombre) {
          const pid = paradasMap[p.parada_nombre.toLowerCase().trim()];
          if (pid) {
            await supabaseAdmin.from("pasajeros_parada").insert({
              pasajero_id: nuevo.id,
              parada_id: pid,
              estado_abordaje: "Pendiente",
            });
          }
        } else if (p.parada_id) {
          await supabaseAdmin.from("pasajeros_parada").insert({
            pasajero_id: nuevo.id,
            parada_id: p.parada_id,
            estado_abordaje: "Pendiente",
          });
        }

        added++;
      }

      return NextResponse.json({ ok: true, added, skipped, errores });
    }

    // ── ACTUALIZAR_CONFIG: nombre de ruta y toggles de autoselección ────────────
    if (action === "actualizar_config") {
      const { ruta_nombre, permite_autoseleccion, permite_cambio_paradero } = body;
      const patch: Record<string, unknown> = {};
      if (ruta_nombre !== undefined)             patch.ruta_nombre             = ruta_nombre || null;
      if (permite_autoseleccion !== undefined)   patch.permite_autoseleccion   = Boolean(permite_autoseleccion);
      if (permite_cambio_paradero !== undefined) patch.permite_cambio_paradero = Boolean(permite_cambio_paradero);
      if (Object.keys(patch).length === 0) return NextResponse.json({ ok: true });

      const { error } = await supabaseAdmin.from("reservas").update(patch).eq("id", reserva_id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Acción no reconocida" }, { status: 400 });

  } catch (err: any) {
    console.error("portal/manifiesto error:", err);
    return NextResponse.json({ error: "Error interno. Intenta de nuevo." }, { status: 500 });
  }
}
