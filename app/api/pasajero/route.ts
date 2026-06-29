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
import { firmarTokenPasajero, pidDeToken, loginBloqueado, registrarIntentoFallido, limpiarIntentos } from "@/lib/pasajero-auth";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// El insert del conductor en ubicaciones_gps solo setea `created_at` (no `timestamp`).
// Garantizamos que `timestamp` siempre tenga valor para que la app del pasajero pueda
// calcular antigüedad ("sin señal") y la heurística B2. Mismo patrón que /api/cliente/gps.
const norm = (g: any) => (g ? { ...g, timestamp: g.timestamp ?? g.created_at ?? null } : g);

export async function POST(req: NextRequest) {
  try {
    // Mismo gate que /api/conductor: exige x-afa-key si NEXT_PUBLIC_AFA_CONDUCTOR_KEY está
    // seteada (fail-open si no). La app del pasajero lo manda sola.
    const KEY = process.env.NEXT_PUBLIC_AFA_CONDUCTOR_KEY;
    if (KEY && req.headers.get("x-afa-key") !== KEY) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }

    const body = await req.json();
    const accion = body.accion as string;

    switch (accion) {
      // ── Login por DNI+PIN (validado y firmado en el SERVIDOR) ────────────────
      case "login": {
        const { dni, pin } = body;
        if (!dni) return NextResponse.json({ error: "dni requerido" }, { status: 400 });
        const dniT = String(dni).trim();

        // Rate limit best-effort por (IP, DNI): frena brute-force/enumeración.
        const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "?";
        const claveRL = `${ip}|${dniT}`;
        if (loginBloqueado(claveRL)) {
          return NextResponse.json({ error: "Demasiados intentos. Espera unos minutos." }, { status: 429 });
        }

        // select("*") (resiliente a columnas que aún no existen en BD, p.ej. `edad`).
        // limit(1) en vez de maybeSingle() para tolerar DNIs duplicados en BD.
        const { data: rows, error } = await admin
          .from("pasajeros").select("*")
          .eq("dni", dniT).order("id", { ascending: false }).limit(1);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        const full: any = rows?.[0] ?? null;

        // Regla del PIN: pin_acceso si existe; si no, los últimos 4 dígitos del DNI.
        // Respuesta UNIFORME para "DNI no existe" y "PIN incorrecto" → cierra el oráculo
        // de enumeración de DNIs y no revela que el PIN por defecto deriva del DNI.
        const pinEsperado = full ? (full.pin_acceso || dniT.slice(-4)) : null;
        if (!full || !pin || String(pin) !== String(pinEsperado)) {
          registrarIntentoFallido(claveRL);
          return NextResponse.json({ credencialesInvalidas: true });
        }
        limpiarIntentos(claveRL);

        // Proyección de salida: SOLO las columnas que usa la UI (minimización de PII;
        // antes se devolvía la fila completa quitando solo pin_acceso).
        const row = {
          id: full.id, nombre: full.nombre, dni: full.dni ?? null, empresa: full.empresa ?? null,
          telefono: full.telefono ?? null, qr_code: full.qr_code ?? null,
          foto_url: full.foto_url ?? null, edad: full.edad ?? null,
          email: full.email ?? null, tipo_documento: full.tipo_documento ?? null,
        };

        // Token de sesión: el cliente lo reenvía en cada acción; el server deriva el
        // pasajero_id DEL TOKEN (no del body) → cierra el IDOR.
        const token = firmarTokenPasajero(row.id);
        return NextResponse.json({ pasajero: row, token });
      }

      // ── Ruta del pasajero (resuelve todo el bundle del seguimiento) ──────────
      case "ruta": {
        const pid = pidDeToken(body.token);
        const { hoy } = body;
        if (!pid) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });
        if (!hoy) return NextResponse.json({ error: "hoy requerido" }, { status: 400 });

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
        // estado_abordaje es la fuente canónica (escrita por el admin/conductor).
        // estado es el campo legado del conductor app (puede desfasarse).
        // Mapeamos a tres valores que consume la UI del pasajero:
        //   "embarcado"  → pasajero a bordo
        //   "no abordó"  → bus pasó, no embarcó
        //   "esperando"  → estado inicial
        // Valores reales del manifiesto: "Pendiente" | "Abordado" | "No Show" | "Cancelado".
        const miEstado =
          miPP.estado_abordaje === "No Show" ? "no abordó"
          : miPP.estado_abordaje === "Cancelado" ? "cancelado"
          : (miPP.estado_abordaje === "Abordado" || miPP.estado === "abordado" || miPP.estado === "embarcado") ? "embarcado"
          : "esperando";
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
        busPosicion = norm(uR?.data?.[0] ?? null);

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
      // Resuelve SIEMPRE por reserva_id (no ambiguo) → funciona igual para flota
      // propia y tercerizada. Exige token y que la reserva sea del propio pasajero
      // (antes cualquiera podía pollear el GPS de cualquier vehículo enumerando ids).
      case "bus_posicion": {
        const pid = pidDeToken(body.token);
        const { reservaId } = body;
        if (!pid) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });
        if (!reservaId) return NextResponse.json({ busPosicion: null });

        // Pertenencia: el pasajero debe tener una parada en esa reserva.
        const { data: pps } = await admin
          .from("pasajeros_parada")
          .select("parada:paradas(reserva_id)")
          .eq("pasajero_id", pid);
        const pertenece = (pps || []).some((x: any) => x.parada?.reserva_id === Number(reservaId));
        if (!pertenece) return NextResponse.json({ busPosicion: null });

        const { data, error } = await admin.from("ubicaciones_gps").select("*")
          .eq("reserva_id", reservaId).order("created_at", { ascending: false }).limit(1);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ busPosicion: norm(data?.[0] ?? null) });
      }

      // ── Guardar URL de foto de perfil ────────────────────────────────────────
      case "foto": {
        const pid = pidDeToken(body.token);
        const { fotoUrl } = body;
        if (!pid) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });
        // Solo aceptar URLs de NUESTRO bucket (no inyectar URLs externas/trackers).
        const prefijo = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/pasajeros-fotos/`;
        if (typeof fotoUrl !== "string" || !fotoUrl.startsWith(prefijo)) {
          return NextResponse.json({ error: "URL de foto inválida" }, { status: 400 });
        }
        const { error } = await admin.from("pasajeros").update({ foto_url: fotoUrl }).eq("id", pid);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      // ── Guardar datos de perfil del pasajero (para el Manifiesto MTC) ─────────
      // Campos editables por el propio pasajero: nombre, email, tipo_documento, edad.
      // El NÚMERO de documento (`dni`) NO se acepta aquí: es la llave de login del
      // pasajero y la que cruza el manifiesto del operador → se corrige desde el ERP.
      // Solo se actualizan los campos presentes en el body (whitelist), nunca `dni`.
      case "perfil": {
        const pid = pidDeToken(body.token);
        if (!pid) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });

        const updates: Record<string, any> = {};

        if ("nombre" in body) {
          const nombre = String(body.nombre ?? "").trim().slice(0, 120);
          if (!nombre) return NextResponse.json({ error: "El nombre no puede quedar vacío" }, { status: 400 });
          updates.nombre = nombre;
        }

        if ("email" in body) {
          const raw = String(body.email ?? "").trim();
          if (raw === "") {
            updates.email = null;
          } else {
            if (raw.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
              return NextResponse.json({ error: "Correo inválido" }, { status: 400 });
            }
            updates.email = raw.toLowerCase();
          }
        }

        if ("tipo_documento" in body) {
          const t = String(body.tipo_documento ?? "").trim().toUpperCase();
          if (!["DNI", "CE", "PASAPORTE", "OTRO"].includes(t)) {
            return NextResponse.json({ error: "Tipo de documento inválido" }, { status: 400 });
          }
          updates.tipo_documento = t;
        }

        if ("edad" in body) {
          const { edad } = body;
          let e: number | null = null;
          if (edad !== null && edad !== undefined && edad !== "") {
            const n = Number(edad);
            if (!Number.isInteger(n) || n < 0 || n > 120) {
              return NextResponse.json({ error: "Edad inválida (0–120)" }, { status: 400 });
            }
            e = n;
          }
          updates.edad = e;
        }

        if (Object.keys(updates).length === 0) return NextResponse.json({ ok: true });

        const { error } = await admin.from("pasajeros").update(updates).eq("id", pid);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      // ── Mensaje / reporte al operador ────────────────────────────────────────
      case "mensaje": {
        const pid = pidDeToken(body.token);
        if (!pid) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });
        const m = body.mensaje || {};
        const texto = String(m.mensaje ?? "").trim().slice(0, 1000);
        if (!texto) return NextResponse.json({ error: "mensaje vacío" }, { status: 400 });
        // Whitelist de columnas: pasajero_id viene del TOKEN (no del body) y el cliente
        // no puede setear columnas internas (p.ej. leido) → cierra el mass-assignment.
        const fila = {
          pasajero_id: pid,
          reserva_id:  m.reserva_id ?? null,
          parada_id:   m.parada_id ?? null,
          tipo:        typeof m.tipo === "string" ? m.tipo.slice(0, 40) : "novedad",
          mensaje:     texto,
        };
        const { error } = await admin.from("mensajes_pasajero").insert(fila);
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      // ── Cambiar paradero en todos los servicios vigentes ─────────────────────
      case "cambiar_paradero": {
        const pid = pidDeToken(body.token);
        const { nombreParada, hoy } = body;
        if (!pid) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });
        if (!nombreParada || !hoy) return NextResponse.json({ error: "nombreParada y hoy requeridos" }, { status: 400 });

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
            .select("id, estado")
            .eq("reserva_id", reservaId)
            .eq("nombre", nombreParada)
            .limit(1);
          const destino = candidatas?.[0];
          if (!destino || destino.id === ppRow.parada_id) continue;
          // Servicio en curso: no permitir cambiar a un paradero que el bus ya pasó.
          if (reserva.estado === "en_curso" && destino.estado === "completada") continue;
          const { error: updErr } = await admin
            .from("pasajeros_parada")
            .update({
              parada_id: destino.id,
              parada_id_original: (ppRow as any).parada_id_original ?? ppRow.parada_id,
              cambio_parada_en: new Date().toISOString(),
            })
            .eq("id", ppRow.id);
          if (!updErr) actualizados++;
        }
        return NextResponse.json({ ok: true, actualizados });
      }

      // ── Reservas disponibles para autoselección ───────────────────────────
      case "reservas_disponibles": {
        const pid = pidDeToken(body.token);
        const { hoy } = body;
        if (!pid) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });
        if (!hoy) return NextResponse.json({ error: "hoy requerido" }, { status: 400 });

        const { data: pax } = await admin
          .from("pasajeros").select("cliente_id, reserva_id").eq("id", pid).maybeSingle();
        if (!pax?.cliente_id) return NextResponse.json({ reservas: [] });

        // `hoy` se interpola en el filtro .or() de abajo → validar formato (anti-inyección PostgREST).
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(hoy))) {
          return NextResponse.json({ error: "hoy inválido" }, { status: 400 });
        }

        const { data: reservasRaw, error: rErr } = await admin
          .from("reservas")
          .select("id, estado, ruta_nombre, origen, destino, fecha_servicio, hora_servicio, vehiculo_id, vehiculo_tercero_id, paradas(*)")
          .eq("cliente_id", pax.cliente_id)
          .eq("permite_autoseleccion", true)
          // Elegibles: servicios de hoy aún no iniciados, O cualquier servicio EN CURSO
          // (incluye nocturnos que cruzan medianoche; mismo criterio que la acción "ruta").
          // Así el pasajero que aún no eligió no queda bloqueado cuando el bus arranca.
          .or(`and(fecha_servicio.eq.${hoy},estado.in.(pendiente,programada,confirmada)),estado.eq.en_curso`);
        if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });
        if (!reservasRaw?.length) return NextResponse.json({ reservas: [] });

        // Dedup por reserva.id por si la query devolviera duplicados
        const reservas: any[] = Array.from(
          new Map(reservasRaw.map((r: any) => [r.id, r])).values()
        );

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
          vIds.length  > 0 ? admin.from("vehiculos").select("id,capacidad_pasajeros").in("id", vIds)    : Promise.resolve({ data: [] as any[] }),
          vtIds.length > 0 ? admin.from("vehiculos_tercero").select("id,capacidad").in("id", vtIds)     : Promise.resolve({ data: [] as any[] }),
        ]);
        const capPropia  = new Map((vRes.data  || []).map((v: any) => [v.id, v.capacidad_pasajeros as number | null]));
        const capTercera = new Map((vtRes.data || []).map((v: any) => [v.id, v.capacidad           as number | null]));

        // Añadir capacidad y ocupación a cada reserva
        const conCap = reservas.map((r: any) => {
          const cap: number | null = r.vehiculo_id
            ? (capPropia.get(r.vehiculo_id)          ?? null)
            : (capTercera.get(r.vehiculo_tercero_id) ?? null);
          return { ...r, capacidad: cap, ocupacion: ocupacion.get(r.id) || 0 };
        });

        // Para servicios EN CURSO, ocultar los paraderos que el bus ya pasó
        // (paradas.estado === "completada", que escribe el conductor al marcar la parada).
        // Si ya pasó todos, el servicio deja de ser elegible — no tiene sentido subirse a
        // un paradero que quedó atrás. Los servicios no iniciados pasan sin tocar.
        const soloVigentes = (r: any): any | null => {
          if (r.estado !== "en_curso") return r;
          const ps = (r.paradas || []).filter((p: any) => p.estado !== "completada");
          if (ps.length === 0) return null;
          return { ...r, paradas: ps };
        };

        // Si el operador pre-asignó al pasajero a una reserva específica de hoy,
        // mostrar solo esa reserva sin consolidación. Así su elección de paradero
        // actualiza directamente el manifiesto del bus correcto.
        if (pax.reserva_id) {
          const preAsignada = conCap.find((r: any) =>
            r.id === pax.reserva_id &&
            !yaAsignados.has(r.id) &&
            (r.capacidad === null || r.ocupacion < r.capacidad)
          );
          if (preAsignada) {
            const f = soloVigentes(preAsignada);
            return NextResponse.json({ reservas: f ? [f] : [] });
          }
        }

        // Sin pre-asignación: agrupar por hora de salida + secuencia exacta de coordenadas
        // Mismo grupo = mismo servicio (misma hora, mismos paraderos en el mismo orden)
        const claveRuta = (r: any): string => {
          const ps = [...(r.paradas || [])].sort((a: any, b: any) => (a.orden ?? 0) - (b.orden ?? 0));
          return `${r.hora_servicio}|${ps.map((p: any) => `${p.lat},${p.lng}`).join("|")}`;
        };

        const grupos = new Map<string, any[]>();
        conCap.forEach((r: any) => {
          const k = claveRuta(r);
          if (!grupos.has(k)) grupos.set(k, []);
          grupos.get(k)!.push(r);
        });

        // Por cada grupo: si el pasajero ya está asignado, omitir.
        // Si no, mostrar solo el vehículo de mayor capacidad que no esté lleno (100%).
        const disponibles: any[] = [];
        for (const grupo of grupos.values()) {
          if (grupo.some((r: any) => yaAsignados.has(r.id))) continue;
          // Mayor capacidad primero (null = sin límite = se trata como Infinity)
          const ordenado = [...grupo].sort((a: any, b: any) => {
            const ca = a.capacidad ?? Infinity;
            const cb = b.capacidad ?? Infinity;
            return cb - ca;
          });
          const elegido = ordenado.find((r: any) => r.capacidad === null || r.ocupacion < r.capacidad);
          if (elegido) disponibles.push(elegido);
        }

        return NextResponse.json({ reservas: disponibles.map(soloVigentes).filter(Boolean) });
      }

      // ── Autoseleccionar paradero ──────────────────────────────────────────
      case "autoseleccionar": {
        const pid = pidDeToken(body.token);
        const { parada_id } = body;
        if (!pid) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });
        if (!parada_id) return NextResponse.json({ error: "parada_id requerido" }, { status: 400 });

        // Obtener cliente_id del pasajero
        const { data: pax } = await admin
          .from("pasajeros").select("cliente_id").eq("id", pid).maybeSingle();
        if (!pax?.cliente_id) return NextResponse.json({ error: "Pasajero no encontrado" }, { status: 404 });

        // Verificar que la parada pertenece a una reserva de la empresa con autoselección activa
        const { data: parada } = await admin
          .from("paradas")
          .select("id, reserva_id, estado, reserva:reservas(id, cliente_id, permite_autoseleccion, estado, vehiculo_id, vehiculo_tercero_id)")
          .eq("id", parada_id)
          .maybeSingle();
        const reserva = (parada as any)?.reserva;
        if (!parada || !reserva) return NextResponse.json({ error: "Parada no encontrada" }, { status: 404 });
        if (Number(reserva.cliente_id) !== Number(pax.cliente_id))
          return NextResponse.json({ error: "No autorizado" }, { status: 403 });
        if (!reserva.permite_autoseleccion)
          return NextResponse.json({ error: "No autorizado" }, { status: 403 });
        if (!["pendiente", "programada", "confirmada", "en_curso"].includes(reserva.estado))
          return NextResponse.json({ error: "Servicio no disponible" }, { status: 400 });
        // Servicio en curso: no permitir subirse a un paradero que el bus ya pasó.
        if (reserva.estado === "en_curso" && (parada as any).estado === "completada")
          return NextResponse.json({ error: "El bus ya pasó por este paradero" }, { status: 400 });

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
        if (insErr) {
          // Doble envío concurrente: el índice único (pasajero_id, parada_id) rechazó el
          // segundo INSERT (23505). Mismo mensaje que el pre-check de arriba (no es un 500).
          if (insErr.code === "23505" || /duplicate key value violates unique constraint/i.test(insErr.message || ""))
            return NextResponse.json({ error: "Ya tienes una parada asignada en este servicio" }, { status: 409 });
          return NextResponse.json({ error: insErr.message }, { status: 500 });
        }
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
