// app/api/conductor/route.ts
// Endpoint único para la app del conductor. El conductor se autentica por PIN
// (NO usa sesión Supabase), así que sus consultas directas son anónimas y RLS
// las bloquea. Aquí usamos service_role para saltar RLS — mismo patrón que
// /api/conductor-alerta y /api/conductor-tercero/*.
//
// Todas las acciones llegan por POST: { accion, ...params }.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { registrarLectura } from "@/lib/odometro";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Bitácora de abordaje real (tabla boarding_log). Best-effort: si falla, no debe
// bloquear el embarque. La lee el reporte del portal cliente por reserva_id.
async function logBoarding(
  pasajero_id: number | null,
  parada_id: number | null,
  reserva_id: number | null,
) {
  if (!pasajero_id || !parada_id) return;
  try {
    await admin.from("boarding_log").insert({
      pasajero_id, parada_id, reserva_id: reserva_id ?? null,
      metodo: "qr_conductor", created_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.warn("[api/conductor] boarding_log no registrado:", e?.message);
  }
}

// ¿El error de Supabase/PostgREST es por una columna que NO existe en la tabla?
// PGRST204 = no está en el schema cache; 42703 = undefined_column. Se usa para que los
// reintentos de fallback NO confundan un error real de FK/constraint (que puede mencionar
// el nombre de la columna) con "columna ausente".
function esColumnaInexistente(err: any): boolean {
  if (!err) return false;
  if (err.code === "PGRST204" || err.code === "42703") return true;
  return /could not find the .* column|column .* does not exist/i.test(err.message || "");
}

export async function POST(req: NextRequest) {
  try {
    // Gate de acceso: si NEXT_PUBLIC_AFA_CONDUCTOR_KEY está configurada, exigir el header
    // x-afa-key (lo manda la app sola; el conductor no escribe nada). Sin configurar →
    // queda abierto, para no romper producción durante el despliegue.
    const KEY = process.env.NEXT_PUBLIC_AFA_CONDUCTOR_KEY;
    if (KEY && req.headers.get("x-afa-key") !== KEY) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }

    const body = await req.json();
    const accion = body.accion as string;

    switch (accion) {
      // ── Login del lector web (DNI + PIN) ─────────────────────────────────────
      // Verifica credenciales en el SERVIDOR para no exponer pin_acceso al cliente
      // (a diferencia del login del APK, que consulta anon). Busca primero en
      // conductores propios y luego en conductores_tercero. Mismo gate activo_app.
      case "login": {
        const { dni, pin } = body;
        if (!dni || !pin) return NextResponse.json({ error: "dni y pin requeridos" }, { status: 400 });
        const dniT = String(dni).trim();

        for (const tabla of ["conductores", "conductores_tercero"] as const) {
          const { data: c } = await admin.from(tabla)
            .select("id,nombre,dni,telefono,pin_acceso,activo_app")
            .eq("dni", dniT).maybeSingle();
          if (!c) continue;
          if (!c.activo_app) return NextResponse.json({ ok: false, error: "Acceso no activado. Llama a central." });
          if (String(c.pin_acceso ?? "") !== String(pin)) return NextResponse.json({ ok: false, error: "PIN incorrecto" });
          return NextResponse.json({
            ok: true,
            conductor: { id: c.id, nombre: c.nombre, dni: c.dni, tabla },
          });
        }
        return NextResponse.json({ ok: false, error: "DNI no encontrado" });
      }

      // ── Servicios de HOY de un conductor (para el selector del lector) ───────
      // Trae las reservas del conductor (propio o tercero) con su vehículo unido,
      // sea propio (vehiculos) o tercero (vehiculos_tercero). Service_role evita que
      // RLS bloquee las lecturas de terceros.
      case "lector_servicios": {
        const { cid, tabla, hoy } = body;
        if (!cid || !hoy) return NextResponse.json({ error: "cid y hoy requeridos" }, { status: 400 });
        const condField = tabla === "conductores_tercero" ? "conductor_tercero_id" : "conductor_id";
        const { data, error } = await admin.from("reservas")
          .select("id,origen,destino,fecha_servicio,hora_servicio,estado,vehiculo_id,vehiculo_tercero_id," +
            "vehiculo:vehiculos(id,placa,categoria),vehiculo_tercero:vehiculos_tercero(id,placa,categoria)")
          .eq("fecha_servicio", hoy).eq(condField, cid).order("hora_servicio");
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ reservas: data || [] });
      }

      // ── Ruta de una reserva (reserva + paradas) para el lector ──────────────
      case "lector_ruta": {
        const { reservaId } = body;
        if (!reservaId) return NextResponse.json({ error: "reservaId requerido" }, { status: 400 });
        const [{ data: reserva, error: eR }, { data: paradas, error: eP }] = await Promise.all([
          admin.from("reservas")
            .select("id,origen,destino,fecha_servicio,hora_servicio,estado,vehiculo_id,vehiculo_tercero_id," +
              "vehiculo:vehiculos(id,placa,categoria),vehiculo_tercero:vehiculos_tercero(id,placa,categoria)")
            .eq("id", reservaId).maybeSingle(),
          admin.from("paradas")
            .select("id,nombre,orden,hora_estimada,lat,lng,estado")
            .eq("reserva_id", reservaId).order("orden"),
        ]);
        if (eR) return NextResponse.json({ error: eR.message }, { status: 500 });
        if (eP) return NextResponse.json({ error: eP.message }, { status: 500 });
        return NextResponse.json({ reserva: reserva || null, paradas: paradas || [] });
      }

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

      // ── Enviar ubicación GPS (acepta 1 punto o un lote para drenar la cola) ───
      case "ubicacion": {
        const { payload } = body;
        const COLS = [
          "conductor_id", "vehiculo_id", "conductor_tercero_id", "vehiculo_tercero_id",
          "reserva_id", "lat", "lng", "velocidad", "rumbo", "precision_m", "estado", "created_at",
          "fix_ts", // hora del último fix real (detección robusta de "congelado") — null en APK viejos
        ];
        const sanitizar = (p: any) => {
          const o: Record<string, any> = {};
          for (const k of COLS) if (p?.[k] !== undefined) o[k] = p[k];
          return o;
        };
        const filasRaw = Array.isArray(payload) ? payload : [payload];
        const filas = filasRaw.filter((p) => p && p.lat != null && p.lng != null).map(sanitizar);
        if (filas.length === 0) return NextResponse.json({ error: "payload inválido" }, { status: 400 });
        const { error } = await admin.from("ubicaciones_gps").insert(filas);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true, insertados: filas.length });
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
        const { ppId, paradaIdReal, pasajeroId, reservaId } = body;
        if (!ppId) return NextResponse.json({ error: "ppId requerido" }, { status: 400 });
        const ahora = new Date().toISOString();
        // Acción legacy (back-compat APKs viejos): solo marca abordado. Escribe AMBAS
        // columnas de estado — `estado` (app conductor) y `estado_abordaje`/`hora_abordaje`
        // (manifiesto admin). El movimiento entre paradas/buses lo maneja `embarcar_qr`.
        const { error } = await admin.from("pasajeros_parada")
          .update({ estado: "abordado", estado_abordaje: "Abordado", hora_abordaje: ahora })
          .eq("id", ppId);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        // Bitácora real de abordaje (la lee el reporte del portal cliente).
        await logBoarding(pasajeroId ?? null, paradaIdReal ?? null, reservaId ?? null);
        return NextResponse.json({ ok: true });
      }

      // ── Embarcar por QR (autoritativo) ───────────────────────────────────────
      // Regla: "un asiento por horario de salida". Un horario = fecha_servicio +
      // hora_servicio. Un pasajero NO puede estar en dos buses del mismo horario,
      // así que al escanearlo se MUEVE su registro al bus/parada real donde subió y
      // se eliminan las filas sobrantes del mismo horario. Sus servicios de OTRO
      // horario (ida/retorno/etc.) nunca se tocan. Esta lógica vive en el servidor
      // porque la app solo conoce su propio bus.
      case "embarcar_qr": {
        let { pasajeroId } = body;
        const { qrCode, paradaId, reservaId } = body;
        // El lector pasa el QR directamente: resolverlo a pasajero (service_role, sin RLS).
        let pasajeroInfo: any = null;
        let paxClienteId: number | null = null;
        let paxReservaId: number | null = null;
        if (!pasajeroId && qrCode) {
          const { data: px } = await admin.from("pasajeros")
            .select("id, nombre, empresa, dni, qr_code, foto_url, cliente_id, reserva_id").eq("qr_code", qrCode).maybeSingle();
          if (!px) return NextResponse.json({ ok: false, noEncontrado: true });
          pasajeroId = px.id;
          pasajeroInfo = px;
          paxClienteId = px.cliente_id ?? null;
          paxReservaId = px.reserva_id ?? null;
        }
        if (!pasajeroId || !paradaId || !reservaId) {
          return NextResponse.json({ error: "pasajeroId (o qrCode), paradaId y reservaId requeridos" }, { status: 400 });
        }
        // Si vino por pasajeroId directo (app conductor), traer su empresa para validar.
        if (!pasajeroInfo) {
          const { data: px2 } = await admin.from("pasajeros")
            .select("cliente_id, reserva_id").eq("id", pasajeroId).maybeSingle();
          paxClienteId = px2?.cliente_id ?? null;
          paxReservaId = px2?.reserva_id ?? null;
        }
        const ahora = new Date().toISOString();

        // 1) Datos del bus actual: horario de salida (fecha + hora) y empresa cliente.
        const { data: rsv, error: eR } = await admin.from("reservas")
          .select("fecha_servicio, hora_servicio, cliente_id").eq("id", reservaId).maybeSingle();
        if (eR) return NextResponse.json({ error: eR.message }, { status: 500 });
        const reservaClienteId = rsv?.cliente_id ?? null;

        // 2) Reservas del MISMO horario (misma fecha y misma hora exactas).
        //    Si faltara la hora, se limita al bus actual (no se remueve de otros).
        let reservaIdsSlot: number[] = [reservaId];
        if (rsv?.fecha_servicio && rsv?.hora_servicio) {
          const { data: rs } = await admin.from("reservas").select("id")
            .eq("fecha_servicio", rsv.fecha_servicio).eq("hora_servicio", rsv.hora_servicio);
          reservaIdsSlot = (rs || []).map((r: any) => r.id);
          if (!reservaIdsSlot.includes(reservaId)) reservaIdsSlot.push(reservaId);
        }

        // 3) Paradas de esas reservas (con su reserva, para saber de qué bus viene cada fila).
        const { data: paradasSlot } = await admin.from("paradas")
          .select("id, reserva_id").in("reserva_id", reservaIdsSlot);
        const paradaIdsSlot = (paradasSlot || []).map((p: any) => p.id);
        const reservaDeParada = new Map<number, number>();
        (paradasSlot || []).forEach((p: any) => reservaDeParada.set(p.id, p.reserva_id));

        // 4) Filas del pasajero en este horario (en cualquier bus del horario).
        //    Solo columnas garantizadas (parada_id_original/cambio_parada_en pueden no existir).
        let filas: any[] = [];
        if (paradaIdsSlot.length > 0) {
          const { data } = await admin.from("pasajeros_parada")
            .select("id, parada_id, estado")
            .eq("pasajero_id", pasajeroId).in("parada_id", paradaIdsSlot);
          filas = data || [];
        }

        // Red de seguridad: ¿el pasajero pertenece a la empresa de este servicio?
        // Pertenece si ya está en algún manifiesto del horario, o es de la misma empresa
        // cliente, o es un pasajero ad-hoc de esta misma reserva. Si no → empresa ajena
        // (igual se registra, pero se avisa para que oficina lo revise).
        const empresaAjena = !(
          filas.length > 0 ||
          (paxClienteId != null && reservaClienteId != null && Number(paxClienteId) === Number(reservaClienteId)) ||
          (paxReservaId != null && paxReservaId === reservaId)
        );

        // 5a) Caminante: no estaba asignado en este horario → insertar en el bus actual.
        if (filas.length === 0) {
          const insertar = async (extra: Record<string, any> = {}) =>
            admin.from("pasajeros_parada")
              .insert({ parada_id: paradaId, pasajero_id: pasajeroId, estado: "abordado",
                        estado_abordaje: "Abordado", hora_abordaje: ahora, ...extra })
              .select("id").single();
          let { data: nuevo, error: eIns } = await insertar({ reserva_id: reservaId });
          if (eIns && esColumnaInexistente(eIns)) ({ data: nuevo, error: eIns } = await insertar());
          if (eIns) return NextResponse.json({ error: eIns.message }, { status: 500 });
          await logBoarding(pasajeroId, paradaId, reservaId);
          return NextResponse.json({ ok: true, id: nuevo?.id, creado: true, empresaAjena, pasajero: pasajeroInfo });
        }

        // 5b) Tiene asignación en este horario → elegir fila objetivo y mover/abordar.
        const target = filas.find((f) => f.parada_id === paradaId) ?? filas[0];
        const reservaPrevia = reservaDeParada.get(target.parada_id) ?? null;
        const otroBus = reservaPrevia !== null && reservaPrevia !== reservaId;
        const movido = target.parada_id !== paradaId;
        const yaEmbarcado = (target.estado === "abordado" || target.estado === "embarcado") && !movido;
        const paradaOriginalId = target.parada_id;

        // Columnas core (existen siempre).
        const patch: Record<string, any> = { estado: "abordado", estado_abordaje: "Abordado", hora_abordaje: ahora };
        if (movido) patch.parada_id = paradaId;
        // Columnas opcionales que pueden no existir en la BD (parada_id_original,
        // cambio_parada_en, reserva_id). Se intentan; si no existen, se reintenta sin ellas.
        const opcional: Record<string, any> = {};
        if (movido) { opcional.parada_id_original = paradaOriginalId; opcional.cambio_parada_en = ahora; }
        if (otroBus) opcional.reserva_id = reservaId;
        let { error: eUpd } = await admin.from("pasajeros_parada")
          .update({ ...patch, ...opcional }).eq("id", target.id);
        if (eUpd && esColumnaInexistente(eUpd)) {
          ({ error: eUpd } = await admin.from("pasajeros_parada").update(patch).eq("id", target.id));
        }
        if (eUpd) return NextResponse.json({ error: eUpd.message }, { status: 500 });

        // 6) Eliminar filas sobrantes del MISMO horario (consolidar a una sola).
        const sobrantes = filas.filter((f) => f.id !== target.id).map((f) => f.id);
        let eliminados = 0;
        if (sobrantes.length > 0) {
          const { error: eDel } = await admin.from("pasajeros_parada").delete().in("id", sobrantes);
          if (!eDel) eliminados = sobrantes.length;
          else console.warn("[embarcar_qr] no se pudieron eliminar sobrantes:", eDel.message);
        }

        // 7) Bitácora solo si es un abordaje nuevo (evita inflar el reporte en re-escaneos).
        if (!yaEmbarcado) await logBoarding(pasajeroId, paradaId, reservaId);

        return NextResponse.json({ ok: true, id: target.id, movido, otroBus, paradaOriginalId, eliminados, yaEmbarcado, empresaAjena, pasajero: pasajeroInfo });
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
        // Alimentar el odómetro consolidado con el km de inicio (solo flota propia)
        try {
          if (checklist.vehiculo_id && checklist.km_inicio) {
            const { data: veh } = await admin.from("vehiculos").select("id").eq("id", checklist.vehiculo_id).maybeSingle();
            if (veh) {
              await registrarLectura(admin, {
                vehiculo_id: Number(checklist.vehiculo_id),
                km: Number(checklist.km_inicio),
                fuente: "checklist",
                fecha: checklist.fecha,
                ref_origen: "checklist_conductor",
              });
            }
          }
        } catch (e) { console.warn("[checklist] lectura odómetro:", e); }
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
      // El conductor SOLO maneja el ciclo OPERATIVO: "en_curso" (al iniciar) y
      // "finalizada" (al completar o cerrar anticipado). "programada"/"confirmada"
      // son del operador (confirmación del cliente del recurso) y NO se tocan desde
      // la app del conductor. Para deshacer un inicio por error, usar "revertir_inicio".
      case "actualizar_estado": {
        const { reservaId, estado } = body;
        if (!reservaId || !estado) return NextResponse.json({ error: "reservaId y estado requeridos" }, { status: 400 });
        const estadosConductor = ["en_curso", "finalizada"];
        if (!estadosConductor.includes(estado))
          return NextResponse.json({ error: "El conductor solo puede marcar 'en_curso' o 'finalizada'" }, { status: 403 });
        const { error } = await admin.from("reservas").update({ estado }).eq("id", reservaId);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      // ── Revertir un inicio por error ─────────────────────────────────────────
      // El conductor inició el servicio equivocado y "Sale": restaura el estado del
      // operador que tenía ANTES del en_curso (programada/confirmada), nunca lo degrada.
      // Solo revierte si la reserva sigue "en_curso"; si el operador ya cambió el estado,
      // no lo pisa.
      case "revertir_inicio": {
        const { reservaId, estadoPrevio } = body;
        if (!reservaId) return NextResponse.json({ error: "reservaId requerido" }, { status: 400 });
        const destino = (estadoPrevio === "programada" || estadoPrevio === "confirmada") ? estadoPrevio : "confirmada";
        const { data: r, error: rErr } = await admin.from("reservas").select("estado").eq("id", reservaId).maybeSingle();
        if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });
        if (!r) return NextResponse.json({ error: "Reserva no encontrada" }, { status: 404 });
        if (r.estado !== "en_curso") return NextResponse.json({ ok: true, sinCambio: true });
        const { error } = await admin.from("reservas").update({ estado: destino }).eq("id", reservaId);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true, estado: destino });
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
