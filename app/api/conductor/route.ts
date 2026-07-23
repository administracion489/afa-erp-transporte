// app/api/conductor/route.ts
// Endpoint único para la app del conductor. El conductor se autentica por PIN
// (NO usa sesión Supabase), así que sus consultas directas son anónimas y RLS
// las bloquea. Aquí usamos service_role para saltar RLS — mismo patrón que
// /api/conductor-alerta y /api/conductor-tercero/*.
//
// Todas las acciones llegan por POST: { accion, ...params }.

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { registrarLectura } from "@/lib/odometro";
import { emitirEventoViaje, pasajerosDeReserva, pasajerosEsperandoDeParada, payloadsViaje, horaLimaHHmm, enviarPushAPasajeros, payloadRespuestaChat } from "@/lib/push";
import { evaluarProximidad } from "@/lib/proximidad";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Normaliza el QR escaneado para tolerar el desajuste de layout de un escáner BT (teclado
// HID): puede teclear el UUID en MAYÚSCULAS y con el guion mal mapeado (p. ej. "-" → "/")
// según el idioma de teclado del equipo. Como qr_code SIEMPRE es un UUID (32 hex en 8-4-4-4-12,
// minúsculas) reconstruimos desde los dígitos hex: ignora separadores y mayúsculas. La cámara
// (lee la imagen del QR) entrega el texto exacto y pasa por aquí sin cambios (idempotente).
function normalizarQr(raw: string): string {
  const s = String(raw ?? "").trim().toLowerCase();
  const hex = s.replace(/[^0-9a-f]/g, "");
  if (hex.length === 32) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return s; // no parece UUID: usar tal cual (al menos trim + minúsculas)
}

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

// Push "embarque confirmado" al pasajero escaneado. Corre en after() (post-respuesta):
// jamás retrasa ni rompe el embarque. Dedupe por (reserva, 'embarcado', pasajero) en
// push_eventos_viaje → mover de bus/parada o re-escanear no re-notifica.
async function pushEmbarcado(pasajeroId: any, reservaId: any) {
  const pid = Number(pasajeroId), rid = Number(reservaId);
  if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(rid) || rid <= 0) return;
  try {
    const { data: pax } = await admin.from("pasajeros").select("nombre").eq("id", pid).maybeSingle();
    const nombre = String(pax?.nombre || "").trim().split(/\s+/)[0] || "pasajero";
    await emitirEventoViaje({
      reservaId: rid, evento: "embarcado", pasajeroId: pid, destinatarios: [pid],
      payload: payloadsViaje.embarcado(rid, nombre, horaLimaHHmm()), ttl: 900,
    });
  } catch (e: any) { console.warn("[push embarcado]", e?.message); }
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

// ¿El error es una violación de UNIQUE (23505)? Lo usa embarcar_qr para tratar un INSERT
// de "caminante" que choca con el índice único (pasajero_id, parada_id) como "ya existía"
// (carrera multi-dispositivo) en vez de error. Si el índice aún no se creó en la BD, este
// 23505 nunca ocurre y el flujo degrada al comportamiento previo (sin protección).
function esViolacionUnica(err: any): boolean {
  if (!err) return false;
  if (err.code === "23505") return true;
  return /duplicate key value violates unique constraint/i.test(err.message || "");
}

// Sube la foto del odómetro (base64 que manda el conductor) al bucket vehiculos-fotos vía
// service-role (el conductor es anónimo → no puede escribir el bucket directo por RLS). La flota
// va en el path porque los ids de vehiculos y vehiculos_tercero se solapan. Devuelve la publicUrl
// o null si no vino foto. Lanza si la subida falla → el cliente lo trata como fallo de red y
// re-encola (nunca se persiste un registro dando "ok" sin haber guardado su evidencia).
async function subirFotoOdometro(
  adj: { media_type?: string; data?: string } | undefined | null,
  o: { flota: "propia" | "tercero"; vehiculo_id: number; momento: "checkin" | "checkout"; fecha: string }
): Promise<string | null> {
  if (!adj?.data) return null;
  const path = `odometro/${o.flota}/${o.vehiculo_id}/${o.momento}/${o.fecha}-${crypto.randomUUID()}.jpg`;
  const buf = Buffer.from(adj.data, "base64");
  const { error } = await admin.storage.from("vehiculos-fotos").upload(path, buf, {
    contentType: adj.media_type || "image/jpeg",
    upsert: true,
  });
  if (error) throw new Error("upload_foto: " + error.message);
  return admin.storage.from("vehiculos-fotos").getPublicUrl(path).data.publicUrl;
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
          admin.from("vehiculos").select("id,placa,categoria,marca,kilometraje_actual").order("placa"),
          admin.from("vehiculos_tercero").select("id,placa,categoria,marca,kilometraje_actual").order("placa"),
          admin.from("reservas")
            .select("id,origen,destino,fecha_servicio,hora_servicio,vehiculo_id,vehiculo_tercero_id,estado")
            .eq("fecha_servicio", hoy).eq(condField, cid).order("hora_servicio"),
          admin.from("documentos_conductor").select("*").eq("conductor_id", cid).order("created_at", { ascending: false }),
          admin.from("checklist_conductor").select("id").eq("conductor_id", cid).eq("fecha", hoy).limit(1),
        ]);

        const err = vR.error || vTR.error || rR.error || dR.error || ckR.error;
        if (err) return NextResponse.json({ error: err.message }, { status: 500 });

        // ¿Ya hizo el CHECK-OUT de hoy? Query aparte (fuera del err-gate) → si la tabla nueva aún
        // no existe (pre-migración), devuelve error sin data y checkoutHecho=false, sin romper `inicio`.
        const coR = await admin.from("checkout_conductor").select("id").eq("conductor_id", cid).eq("fecha", hoy).limit(1);

        return NextResponse.json({
          vehiculos:        vR.data  || [],
          vehiculosTercero: vTR.data || [],
          reservas:         rR.data  || [],
          docs:             dR.data  || [],
          checklistHecho:   !!(ckR.data && ckR.data.length > 0),
          checkoutHecho:    !!(coR.data && coR.data.length > 0),
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

      // ── Chat: mensajes de los pasajeros de MI servicio (para la bandeja) ──────
      case "mensajes_servicio": {
        const { reservaId } = body;
        if (!reservaId) return NextResponse.json({ mensajes: [] });
        const { data, error } = await admin.from("mensajes_pasajero")
          .select("id, pasajero_id, remitente, autor_nombre, tipo, mensaje, leido, leido_pasajero, created_at, " +
            "pasajero:pasajeros(id, nombre, empresa)")
          .eq("reserva_id", reservaId)
          .order("created_at", { ascending: true })
          .limit(300);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ mensajes: data || [] });
      }

      // ── Chat: el conductor responde a un pasajero de SU servicio ─────────────
      case "responder_mensaje": {
        const { cid, tabla, reservaId, pasajero_id } = body;
        const texto = String(body.texto ?? "").trim().slice(0, 1000);
        const tablaC = tabla === "conductores_tercero" ? "conductores_tercero" : "conductores";
        if (!cid || !reservaId || !pasajero_id) return NextResponse.json({ error: "cid, reservaId y pasajero_id requeridos" }, { status: 400 });
        if (!texto) return NextResponse.json({ error: "mensaje vacío" }, { status: 400 });

        // El conductor solo puede responder en SU servicio (evita responder ajenos).
        const condField = tablaC === "conductores_tercero" ? "conductor_tercero_id" : "conductor_id";
        const { data: rsv } = await admin.from("reservas").select(`id, ${condField}`).eq("id", reservaId).maybeSingle();
        if (!rsv || Number((rsv as any)[condField]) !== Number(cid)) {
          return NextResponse.json({ error: "Este servicio no te pertenece" }, { status: 403 });
        }

        const { data: cond } = await admin.from(tablaC).select("nombre").eq("id", cid).maybeSingle();
        const primerNombre = String(cond?.nombre || "").trim().split(/\s+/)[0] || "Conductor";
        const autorNombre = `Conductor ${primerNombre}`;

        const { data: fila, error } = await admin.from("mensajes_pasajero").insert({
          pasajero_id: Number(pasajero_id),
          reserva_id: Number(reservaId),
          tipo: "respuesta",
          mensaje: texto,
          remitente: "conductor",
          autor_nombre: autorNombre,
          autor_id: String(cid),
          leido: true,
          leido_at: new Date().toISOString(),
          leido_pasajero: false,
        }).select("*").single();
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });

        // Responder = atender: marca leídos los mensajes pendientes del pasajero en el hilo.
        await admin.from("mensajes_pasajero")
          .update({ leido: true, leido_por: autorNombre, leido_at: new Date().toISOString() })
          .eq("pasajero_id", Number(pasajero_id)).eq("reserva_id", Number(reservaId))
          .eq("remitente", "pasajero").eq("leido", false);

        // Push al pasajero, sin retrasar la respuesta (nunca lanza).
        after(async () => {
          await enviarPushAPasajeros([Number(pasajero_id)], payloadRespuestaChat(autorNombre, texto, Number(pasajero_id)), { urgencia: "high", ttl: 3600 });
        });

        return NextResponse.json({ ok: true, mensaje: fila });
      }

      // ── Buscar pasajero por QR ───────────────────────────────────────────────
      case "buscar_pasajero": {
        const { qrCode } = body;
        if (!qrCode) return NextResponse.json({ error: "qrCode requerido" }, { status: 400 });
        // Normalizar para tolerar el layout del escáner BT (mayúsculas, "-"→"/", etc.).
        const qr = normalizarQr(qrCode);
        const { data, error } = await admin.from("pasajeros").select("*").eq("qr_code", qr).maybeSingle();
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
        // Motor de proximidad del push del pasajero ("llega en ~5 min" / "ya llegó").
        // Corre POST-respuesta (after) → la latencia del heartbeat no cambia. El
        // throttle real vive en BD (claim atómico dentro de evaluarProximidad).
        const reservaIds = [...new Set(
          filas.map((f: any) => Number(f.reserva_id)).filter((n: number) => Number.isFinite(n) && n > 0)
        )];
        if (reservaIds.length > 0) {
          after(() => Promise.allSettled(reservaIds.map((rid) => evaluarProximidad(rid))));
        }
        return NextResponse.json({ ok: true, insertados: filas.length });
      }

      // ── Marcar parada completada ─────────────────────────────────────────────
      case "marcar_parada": {
        const { paradaId } = body;
        if (!paradaId) return NextResponse.json({ error: "paradaId requerido" }, { status: 400 });
        const { error } = await admin.from("paradas").update({ estado: "completada" }).eq("id", paradaId);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        // Push "quedan 2 paradas": tras completar una parada, avisar a la parada
        // pendiente que quedó con EXACTAMENTE 2 pendientes por delante. Solo N=2
        // (anti-spam) y dedupe por parada en push_eventos_viaje.
        after(async () => {
          try {
            const { data: pMarcada } = await admin.from("paradas").select("reserva_id").eq("id", paradaId).maybeSingle();
            const rid = Number(pMarcada?.reserva_id);
            if (!Number.isFinite(rid) || rid <= 0) return;
            const { data: ps } = await admin.from("paradas")
              .select("id, nombre, orden, estado").eq("reserva_id", rid).order("orden");
            const pendientes = (ps || []).filter((p: any) => p.estado !== "completada");
            for (const p of pendientes) {
              const antes = pendientes.filter((q: any) => (q.orden ?? 0) < (p.orden ?? 0)).length;
              if (antes !== 2) continue;
              const dest = await pasajerosEsperandoDeParada(p.id);
              await emitirEventoViaje({
                reservaId: rid, evento: "quedan_paradas", paradaId: p.id, destinatarios: dest,
                payload: payloadsViaje.quedanParadas(p.id, p.nombre || "tu paradero"), ttl: 900,
              });
            }
          } catch (e: any) { console.warn("[push quedan_paradas]", e?.message); }
        });
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
        after(() => pushEmbarcado(pasajeroId, reservaId));
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
          // Mismo motivo que en buscar_pasajero: normalizar el QR tecleado por el escáner BT.
          const qr = normalizarQr(qrCode);
          const { data: px } = await admin.from("pasajeros")
            .select("id, nombre, empresa, dni, qr_code, foto_url, cliente_id, reserva_id").eq("qr_code", qr).maybeSingle();
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
        // IDEMPOTENTE ante concurrencia: el índice único (pasajero_id, parada_id) hace que un
        // segundo INSERT simultáneo del mismo walk-on falle con 23505. En ese caso recuperamos
        // la fila existente y NO volvemos a registrar boarding_log → sin fila duplicada ni doble
        // conteo. (Si el índice aún no se creó, no hay 23505 y degrada al comportamiento previo.)
        if (filas.length === 0) {
          const insertar = async (extra: Record<string, any> = {}) =>
            admin.from("pasajeros_parada")
              .insert({ parada_id: paradaId, pasajero_id: pasajeroId, estado: "abordado",
                        estado_abordaje: "Abordado", hora_abordaje: ahora, ...extra })
              .select("id").single();
          let { data: nuevo, error: eIns } = await insertar({ reserva_id: reservaId });
          if (eIns && esColumnaInexistente(eIns)) ({ data: nuevo, error: eIns } = await insertar());
          if (eIns && esViolacionUnica(eIns)) {
            // Otra llamada concurrente ya insertó esta misma fila → recuperarla y no re-loguear.
            const { data: ya } = await admin.from("pasajeros_parada")
              .select("id").eq("pasajero_id", pasajeroId).eq("parada_id", paradaId).maybeSingle();
            return NextResponse.json({ ok: true, id: ya?.id ?? null, creado: false, empresaAjena, pasajero: pasajeroInfo });
          }
          if (eIns) return NextResponse.json({ error: eIns.message }, { status: 500 });
          await logBoarding(pasajeroId, paradaId, reservaId);
          after(() => pushEmbarcado(pasajeroId, reservaId));
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
        if (!yaEmbarcado) {
          await logBoarding(pasajeroId, paradaId, reservaId);
          after(() => pushEmbarcado(pasajeroId, reservaId));
        }

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
        // `es_tercero` y `foto_adjunto` viajan en el payload pero NO son columnas de
        // checklist_conductor: se usan aquí y se quitan antes de insertar la fila.
        const esTercero = checklist.es_tercero === true;
        const fotoAdjunto = checklist.foto_adjunto as { media_type?: string; data?: string } | undefined;
        const checklistRow = { ...checklist };
        delete checklistRow.es_tercero;
        delete checklistRow.foto_adjunto;

        // 0) Subir la foto del odómetro (evidencia). Si falla la subida se lanza → el cliente lo
        //    trata como fallo de red y re-encola: nunca se responde "ok" sin guardar la evidencia.
        let fotoUrl: string | null = null;
        try {
          fotoUrl = await subirFotoOdometro(fotoAdjunto, {
            flota: esTercero ? "tercero" : "propia",
            vehiculo_id: Number(checklist.vehiculo_id),
            momento: "checkin",
            fecha: checklist.fecha,
          });
        } catch (e: any) {
          return NextResponse.json({ error: e?.message || "No se pudo subir la foto" }, { status: 502 });
        }
        checklistRow.foto_url = fotoUrl;

        // 1) Alimentar el odómetro consolidado con el km de inicio (con su foto). Se hace ANTES y
        //    con independencia de que la fila de checklist_conductor persista (para terceros esa
        //    fila falla por FK — ver abajo), porque el km + la foto son el dato valioso. La tabla
        //    de la flota importa: los ids de vehiculos/vehiculos_tercero se solapan.
        try {
          if (checklist.vehiculo_id && checklist.km_inicio) {
            const tablaVeh = esTercero ? "vehiculos_tercero" : "vehiculos";
            const { data: veh } = await admin.from(tablaVeh).select("id").eq("id", checklist.vehiculo_id).maybeSingle();
            if (veh) {
              await registrarLectura(admin, {
                vehiculo_id: Number(checklist.vehiculo_id),
                km: Number(checklist.km_inicio),
                fuente: "checklist",
                fecha: checklist.fecha,
                foto_url: fotoUrl,
                ref_origen: "checklist_conductor",
                flota: esTercero ? "tercero" : "propia",
                capturado_en: checklist.capturado_en ?? null,
                momento: "checkin",
                // idempotencia por CONDUCTOR (no solo unidad): dos conductores pueden usar la
                // misma unidad el mismo día en servicios distintos y ambas lecturas son válidas.
                // El gate anti-doble de la app es por conductor+fecha, así que esta clave calza.
                idemKey: `checkin:${esTercero ? "t" : "p"}:${checklist.vehiculo_id}:${checklist.fecha}:${checklist.conductor_id}`,
              });
            }
          }
        } catch (e) { console.warn("[checklist] lectura odómetro:", e); }

        // 2) Persistir la fila del checklist (best-effort). Si la migración de las columnas nuevas
        //    (foto_url/km_ocr/gps/capturado_en) aún no corrió, reintenta sin ellas.
        const insertarChecklist = () => admin.from("checklist_conductor").insert(checklistRow);
        let { error } = await insertarChecklist();
        if (error && esColumnaInexistente(error)) {
          for (const c of ["foto_url", "km_ocr", "gps_lat", "gps_lng", "capturado_en"]) delete (checklistRow as any)[c];
          ({ error } = await insertarChecklist());
        }
        if (error) {
          // FK violation: el conductor es de conductores_tercero y su ID no existe en conductores.
          // El check-in ya quedó visualmente completo y el odómetro+foto ya se registraron arriba.
          if (error.message.includes("foreign key") || error.message.includes("violates")) {
            console.warn("[checklist] FK tercero — fila no guardada en BD:", error.message);
            return NextResponse.json({ ok: true });
          }
          return NextResponse.json({ error: error.message }, { status: 500 });
        }
        return NextResponse.json({ ok: true });
      }

      // ── Guardar CHECK-OUT de jornada (km final + nivel de combustible + obs) ──
      // Espejo de "checklist". El km final alimenta el odómetro consolidado (anti-retroceso)
      // con fuente="servicio"; y se guarda la fila en checkout_conductor (best-effort).
      case "checkout": {
        const { checkout } = body;
        if (!checkout?.conductor_id) return NextResponse.json({ error: "checkout inválido" }, { status: 400 });
        const esTercero = checkout.es_tercero === true;
        const fotoAdjunto = checkout.foto_adjunto as { media_type?: string; data?: string } | undefined;
        const checkoutRow = { ...checkout };
        delete checkoutRow.reserva_id;    // solo para la lectura; no es columna
        delete checkoutRow.foto_adjunto;  // se sube aparte; no es columna

        // 0) Subir la foto (si vino — el check-out permite cerrar SIN foto con motivo, p.ej. unidad
        //    en taller / tablero apagado). Falla de subida → 502 y el cliente reintenta.
        let fotoUrl: string | null = null;
        try {
          fotoUrl = await subirFotoOdometro(fotoAdjunto, {
            flota: esTercero ? "tercero" : "propia",
            vehiculo_id: Number(checkout.vehiculo_id),
            momento: "checkout",
            fecha: checkout.fecha,
          });
        } catch (e: any) {
          return NextResponse.json({ error: e?.message || "No se pudo subir la foto" }, { status: 502 });
        }
        checkoutRow.foto_url = fotoUrl;

        // 1) Odómetro final → consolidado (con su foto). Independiente de que la fila persista.
        try {
          if (checkout.vehiculo_id && checkout.km_fin) {
            const tablaVeh = esTercero ? "vehiculos_tercero" : "vehiculos";
            const { data: veh } = await admin.from(tablaVeh).select("id").eq("id", checkout.vehiculo_id).maybeSingle();
            if (veh) {
              await registrarLectura(admin, {
                vehiculo_id: Number(checkout.vehiculo_id),
                km: Number(checkout.km_fin),
                fuente: "servicio",
                fecha: checkout.fecha,
                foto_url: fotoUrl,
                ref_origen: "checkout_conductor",
                flota: esTercero ? "tercero" : "propia",
                capturado_en: checkout.capturado_en ?? null,
                momento: "checkout",
                idemKey: `checkout:${esTercero ? "t" : "p"}:${checkout.vehiculo_id}:${checkout.fecha}:${checkout.conductor_id}`,
              });
            }
          }
        } catch (e) { console.warn("[checkout] lectura odómetro:", e); }

        // 2) Persistir la fila del check-out (best-effort + migration-safe con las columnas nuevas).
        const insertarCheckout = () => admin.from("checkout_conductor").insert(checkoutRow);
        let { error } = await insertarCheckout();
        if (error && esColumnaInexistente(error)) {
          for (const c of ["foto_url", "km_ocr", "gps_lat", "gps_lng", "capturado_en", "sin_foto_motivo"]) delete (checkoutRow as any)[c];
          ({ error } = await insertarCheckout());
        }
        if (error) {
          if (error.message.includes("foreign key") || error.message.includes("violates")) {
            console.warn("[checkout] FK tercero — fila no guardada en BD:", error.message);
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
        // Push "¡tu bus ya salió!" a todos los pasajeros no cancelados de la reserva.
        // Insert-once: si el conductor revierte y vuelve a iniciar, NO se re-notifica
        // (preferible a spamear por un arranque equivocado). También siembra la fila
        // del throttle del motor de proximidad.
        if (estado === "en_curso") {
          const rid = Number(reservaId);
          after(async () => {
            try {
              await admin.from("push_eval_estado").insert({ reserva_id: rid }); // 23505 = ya sembrada
              const [dest, r] = await Promise.all([
                pasajerosDeReserva(rid),
                admin.from("reservas").select("origen, destino").eq("id", rid).maybeSingle(),
              ]);
              await emitirEventoViaje({
                reservaId: rid, evento: "salio", destinatarios: dest,
                payload: payloadsViaje.salio(rid, r.data?.origen, r.data?.destino), ttl: 1800,
              });
            } catch (e: any) { console.warn("[push salio]", e?.message); }
          });
        }
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
