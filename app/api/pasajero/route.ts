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

// Un servicio "en_curso" NO es vigente para siempre. La reserva solo vuelve a
// "finalizada" cuando el conductor cierra el servicio; si no lo cierra (batería,
// app cerrada, olvido) queda "en_curso" indefinidamente. Como la app del pasajero
// elegía el servicio vigente MÁS ANTIGUO, esa reserva abandonada secuestraba la
// pantalla para siempre: el pasajero veía la posición GPS de aquel día viejo
// ("sin señal, hace 9441 min") mientras el operador sí veía el bus real.
//
// La primera versión acotó a "hoy y ayer", y NO BASTÓ: un servicio abandonado ayer a
// las 17:00 seguía secuestrando la pantalla a las 07:00 del día siguiente (caso real,
// 21-ago: "hace 687 min"). Ser de ayer no lo hace plausible; lo que lo hace plausible
// es que TODAVÍA PUEDA estar en ruta. Por eso ahora un en_curso de ayer exige una de dos:
//   • llevar menos de HORAS_MAX desde su hora de inicio (cubre los nocturnos que cruzan
//     medianoche), o
//   • seguir emitiendo GPS (prueba dura de que el bus sigue rodando, y lo que permite que
//     un full day de 24 h sea vigente sin abrir la puerta a los abandonados).
const ayerDe = (hoy: string) => {
  const [a, m, d] = String(hoy).split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d - 1)).toISOString().slice(0, 10);
};
// `hoy` llega del cliente: validar formato antes de usarlo en fechas o en filtros.
const fechaValida = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v));
/** Fecha local de Lima (UTC-5), para las acciones que no reciben `hoy` del cliente. */
const hoyLima = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

const HORAS_MAX_EN_CURSO = 12;   // un servicio de ayer más viejo que esto exige prueba de vida
const GPS_VIVO_MIN = 20;         // ...y esa prueba es GPS de los últimos 20 minutos

/** Filtro BARATO (sin consultar GPS): descarta lo que ni siquiera es de hoy/ayer. */
const enCursoVigente = (r: any, hoy: string) =>
  r?.estado === "en_curso" && String(r?.fecha_servicio ?? "") >= ayerDe(hoy);

/** Horas transcurridas desde la hora de inicio del servicio (Lima, UTC-5). */
function horasDesdeInicio(r: any): number | null {
  const f = String(r?.fecha_servicio ?? ""), h = String(r?.hora_servicio ?? "");
  if (!fechaValida(f) || !h) return null;
  const t = Date.parse(`${f}T${h.slice(0, 8).padEnd(8, ":00").slice(0, 8)}-05:00`);
  return Number.isFinite(t) ? (Date.now() - t) / 3600e3 : null;
}

/**
 * ¿Este en_curso sigue vivo de verdad? Solo se consulta el GPS para los casos dudosos
 * (los de ayer que ya superaron HORAS_MAX_EN_CURSO), que son uno o ninguno en la práctica:
 * los de hoy y los recientes se resuelven sin tocar la base.
 */
async function enCursoVivo(admin: any, r: any, hoy: string): Promise<boolean> {
  if (!enCursoVigente(r, hoy)) return false;
  if (String(r.fecha_servicio) >= hoy) return true;            // de hoy: siempre plausible
  const horas = horasDesdeInicio(r);
  if (horas !== null && horas < HORAS_MAX_EN_CURSO) return true;  // nocturno que cruzó medianoche
  const desde = new Date(Date.now() - GPS_VIVO_MIN * 60_000).toISOString();
  const { data } = await admin
    .from("ubicaciones_gps").select("id")
    .eq("reserva_id", r.id).gte("created_at", desde).limit(1);
  return !!data?.length;                                        // sigue emitiendo → sigue vivo
}

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
        if (!fechaValida(hoy)) return NextResponse.json({ error: "hoy inválido" }, { status: 400 });

        const { data: pp, error: ppErr } = await admin
          .from("pasajeros_parada")
          .select(`*, parada:paradas(*, reserva:reservas(*))`)
          .eq("pasajero_id", pid);
        if (ppErr) return NextResponse.json({ error: ppErr.message }, { status: 500 });
        if (!pp?.length) return NextResponse.json({ ruta: null });

        // Solo servicios vigentes: en curso que TODAVÍA PUEDE estarlo (ver enCursoVivo) o
        // futuros con estado activo. Nunca retroceder a un servicio viejo como fallback.
        const candidatos = pp.filter((x: any) => {
          const r = x.parada?.reserva;
          if (!r) return false;
          if (r.estado === "en_curso") return enCursoVigente(r, hoy);
          return r.fecha_servicio >= hoy && ["pendiente", "programada", "confirmada"].includes(r.estado);
        });
        // Segunda pasada, solo sobre los candidatos: descarta los en_curso abandonados. Va
        // aparte porque necesita consultar el GPS y el filtro de arriba es síncrono.
        const vivos = await Promise.all(candidatos.map(async (x: any) => {
          const r = x.parada?.reserva;
          return r?.estado === "en_curso" ? ((await enCursoVivo(admin, r, hoy)) ? x : null) : x;
        }));
        const vigentes = vivos.filter(Boolean).sort((a: any, b: any) => {
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
          // remitente lo pone la BD por defecto ('pasajero'); no lo mandamos para no
          // depender de la columna nueva si el deploy llega antes que la migración.
        };
        const { data: ins, error } = await admin.from("mensajes_pasajero").insert(fila).select("*").single();
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true, mensaje: ins });
      }

      // ── Hilo de chat del pasajero (sus mensajes + respuestas de central/conductor) ──
      case "mensajes": {
        const pid = pidDeToken(body.token);
        if (!pid) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });
        let q = admin.from("mensajes_pasajero")
          .select("id, remitente, autor_nombre, tipo, mensaje, leido_pasajero, created_at, reserva_id")
          .eq("pasajero_id", pid)
          .order("created_at", { ascending: true })
          .limit(200);
        if (body.reserva_id != null) q = q.eq("reserva_id", Number(body.reserva_id));
        const { data, error } = await q;
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ mensajes: data || [] });
      }

      // ── Marcar como leídas las respuestas de central/conductor ───────────────
      case "mensajes_leidos": {
        const pid = pidDeToken(body.token);
        if (!pid) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });
        let q = admin.from("mensajes_pasajero")
          .update({ leido_pasajero: true, leido_pasajero_at: new Date().toISOString() })
          .eq("pasajero_id", pid)
          .in("remitente", ["operador", "conductor"])
          .eq("leido_pasajero", false);
        if (body.reserva_id != null) q = q.eq("reserva_id", Number(body.reserva_id));
        const { error } = await q;
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      // ── Cambiar paradero en todos los servicios vigentes ─────────────────────
      case "cambiar_paradero": {
        const pid = pidDeToken(body.token);
        const { nombreParada, hoy } = body;
        if (!pid) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });
        if (!nombreParada || !hoy) return NextResponse.json({ error: "nombreParada y hoy requeridos" }, { status: 400 });
        if (!fechaValida(hoy)) return NextResponse.json({ error: "hoy inválido" }, { status: 400 });

        const { data: pp, error: ppErr } = await admin
          .from("pasajeros_parada")
          .select("id, parada_id, parada_id_original, parada:paradas(id, nombre, reserva_id, reserva:reservas(id, fecha_servicio, estado, permite_cambio_paradero))")
          .eq("pasajero_id", pid);
        if (ppErr) return NextResponse.json({ error: ppErr.message }, { status: 500 });

        const candidatos = (pp || []).filter((x: any) => {
          const r = x.parada?.reserva;
          if (!r) return false;
          if (r.estado === "en_curso") return enCursoVigente(r, hoy);
          return r.fecha_servicio >= hoy && ["pendiente", "programada", "confirmada"].includes(r.estado);
        });
        // Igual que en "ruta": un en_curso de ayer solo cuenta si sigue vivo de verdad. Sin
        // esto, cambiar de paradero podía escribir sobre un servicio abandonado de días atrás.
        const vigentesRaw = await Promise.all(candidatos.map(async (x: any) => {
          const r = x.parada?.reserva;
          return r?.estado === "en_curso" ? ((await enCursoVivo(admin, r, hoy)) ? x : null) : x;
        }));
        const vigentes = vigentesRaw.filter(Boolean) as any[];

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
          // Elegibles: servicios de hoy aún no iniciados, O servicios EN CURSO recientes
          // (incluye nocturnos que cruzan medianoche; mismo criterio que la acción "ruta").
          // El en_curso va acotado a hoy/ayer: si no, un servicio que el conductor nunca
          // cerró seguiría ofreciéndose como elegible para siempre.
          .or(`and(fecha_servicio.eq.${hoy},estado.in.(pendiente,programada,confirmada)),and(estado.eq.en_curso,fecha_servicio.gte.${ayerDe(hoy)})`);
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
          .select("id, reserva_id, estado, reserva:reservas(id, cliente_id, permite_autoseleccion, estado, fecha_servicio, vehiculo_id, vehiculo_tercero_id)")
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
        // Defensa en profundidad: esta acción no recibe `hoy`, así que usamos la fecha
        // Lima del servidor. Evita que un cliente con la lista cacheada se inscriba en
        // un servicio que quedó "en_curso" y nunca se cerró.
        if (reserva.estado === "en_curso" && !(await enCursoVivo(admin, reserva, hoyLima())))
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

      // ── Registrar suscripción push (Web Push o FCM de la app nativa) ─────────
      // La suscripción queda keyed por pasajero_id (del TOKEN, nunca del body).
      // Upsert check-then-insert con captura de 23505: los índices únicos de
      // push_suscripciones son PARCIALES (endpoint / fcm_token) y PostgREST no
      // puede usarlos como árbitro de ON CONFLICT (misma nota que
      // supabase/pasajeros-parada-unique.sql). Si el aparato cambió de dueño
      // (un familiar se loguea en el mismo teléfono), la fila se reasigna al pid nuevo.
      case "suscribir_push": {
        const pid = pidDeToken(body.token);
        if (!pid) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });
        const tipo = body.tipo === "fcm" ? "fcm" : body.tipo === "webpush" ? "webpush" : null;
        if (!tipo) return NextResponse.json({ error: "tipo inválido" }, { status: 400 });

        const ua = (req.headers.get("user-agent") || "").slice(0, 300) || null;
        const plataforma = typeof body.plataforma === "string" ? body.plataforma.slice(0, 40) : null;

        let fila: Record<string, any>;
        let claveCol: "endpoint" | "fcm_token";
        let claveVal: string;
        if (tipo === "webpush") {
          const sub = body.sub || {};
          const endpoint = String(sub.endpoint || "");
          const p256dh = String(sub.keys?.p256dh || "");
          const auth = String(sub.keys?.auth || "");
          if (!endpoint.startsWith("https://") || endpoint.length > 1000 ||
              !p256dh || p256dh.length > 300 || !auth || auth.length > 100) {
            return NextResponse.json({ error: "Suscripción inválida" }, { status: 400 });
          }
          fila = { pasajero_id: pid, tipo, endpoint, p256dh, auth, fcm_token: null };
          claveCol = "endpoint"; claveVal = endpoint;
        } else {
          const t = String(body.fcmToken || "");
          if (!t || t.length > 500) return NextResponse.json({ error: "Token FCM inválido" }, { status: 400 });
          fila = { pasajero_id: pid, tipo, fcm_token: t, endpoint: null, p256dh: null, auth: null };
          claveCol = "fcm_token"; claveVal = t;
        }
        fila = { ...fila, user_agent: ua, plataforma, activo: true, fallos: 0, updated_at: new Date().toISOString() };

        const { data: exist } = await admin
          .from("push_suscripciones").select("id").eq(claveCol, claveVal).maybeSingle();
        if (exist) {
          const { error } = await admin.from("push_suscripciones").update(fila).eq("id", exist.id);
          if (error) return NextResponse.json({ error: error.message }, { status: 500 });
          return NextResponse.json({ ok: true, actualizada: true });
        }
        const { error: eIns } = await admin.from("push_suscripciones").insert(fila);
        if (eIns) {
          if (eIns.code === "23505" || /duplicate key value/i.test(eIns.message || "")) {
            const { error: eUpd } = await admin.from("push_suscripciones").update(fila).eq(claveCol, claveVal);
            if (eUpd) return NextResponse.json({ error: eUpd.message }, { status: 500 });
            return NextResponse.json({ ok: true, actualizada: true });
          }
          return NextResponse.json({ error: eIns.message }, { status: 500 });
        }
        return NextResponse.json({ ok: true, creada: true });
      }

      // ── Desactivar suscripción push (solo las filas del propio pasajero) ─────
      case "desuscribir_push": {
        const pid = pidDeToken(body.token);
        if (!pid) return NextResponse.json({ error: "Sesión inválida" }, { status: 401 });
        const endpoint = typeof body.endpoint === "string" ? body.endpoint : null;
        const fcmToken = typeof body.fcmToken === "string" ? body.fcmToken : null;
        if (!endpoint && !fcmToken) return NextResponse.json({ error: "endpoint o fcmToken requerido" }, { status: 400 });
        let q = admin.from("push_suscripciones")
          .update({ activo: false, updated_at: new Date().toISOString() })
          .eq("pasajero_id", pid);
        q = endpoint ? q.eq("endpoint", endpoint) : q.eq("fcm_token", fcmToken);
        const { error } = await q;
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
