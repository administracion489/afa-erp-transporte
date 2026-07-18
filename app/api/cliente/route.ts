// app/api/cliente/route.ts
// Endpoint único del PORTAL CLIENTE (mismo patrón que /api/conductor y /api/pasajero).
// El portal se autentica con RUC + documento + contraseña (NO usa sesión Supabase),
// así que sus consultas directas desde el navegador son anónimas y RLS las bloquea.
// Aquí usamos service_role para saltar RLS, y un token HMAC propio para que cada
// sesión del portal solo pueda leer los datos de SU cliente (cliente_id sale del
// token, jamás del body).
//
// Todas las acciones llegan por POST: { accion, token?, ...params }.
//   • login            → valida credenciales y emite el token (única acción sin token)
//   • datos            → reservas + facturas + documentos del cliente
//   • paradas_reserva  → paradas de una reserva del cliente
//   • placas_vehiculos → placas por ids (propios y terceros)
//   • vehiculos_en_vivo→ flota que ha servido al cliente (para el mapa En vivo)
//   • manifiesto_reserva → paradas + boarding + roster de pasajeros (detalle/reporte)
//   • manifiesto_editor  → datos del modal "Editar manifiesto"
//   • historial_stats  → esperados/embarcados por reserva
//   • colaboradores_*  → CRUD de usuarios del portal (solo admin del portal)
//   • doc_url          → URL firmada de un documento del cliente (storage)

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { esAbordado } from "@/lib/documentos-servicio";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ─── Token de sesión del portal (HMAC-SHA256) ────────────────────────────────
// Secreto derivado de la service-role key (nunca sale del servidor). El token viaja
// al navegador y vuelve en cada acción: payload = { cid, uid, exp } firmado.
const SECRETO = createHash("sha256")
  .update("portal-cliente-v1:" + (process.env.SUPABASE_SERVICE_ROLE_KEY || ""))
  .digest();
const TOKEN_TTL_MS = 12 * 3600000; // 12 h — mayor que las 8 h de sesión del navegador

const b64u = (s: Buffer | string) => Buffer.from(s).toString("base64url");

function firmarToken(cid: number, uid: number): string {
  const payload = b64u(JSON.stringify({ cid, uid, exp: Date.now() + TOKEN_TTL_MS }));
  const firma = createHmac("sha256", SECRETO).update(payload).digest("base64url");
  return `${payload}.${firma}`;
}

function verificarToken(token: unknown): { cid: number; uid: number } | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, firma] = token.split(".");
  try {
    const esperada = createHmac("sha256", SECRETO).update(payload).digest();
    const recibida = Buffer.from(firma, "base64url");
    if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;
    const { cid, uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof cid !== "number" || cid <= 0 || typeof exp !== "number" || Date.now() > exp) return null;
    return { cid, uid: Number(uid) || 0 };
  } catch { return null; }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
// PostgREST recorta toda respuesta al max-rows del servidor (1000) aunque se pida
// .limit() mayor — mismo patrón paginado que lib/huella.ts (paginarFilas).
async function paginado(build: (from: number, to: number) => any): Promise<any[]> {
  const PAGE = 1000;
  let from = 0;
  const all: any[] = [];
  for (;;) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error || !data) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Campos de reservas que el cliente NO debe ver (economía interna y tokens de terceros).
function limpiarReserva<T extends Record<string, any>>(r: T): T {
  delete (r as any).margen;
  delete (r as any).costo_proveedor;
  delete (r as any).token_conductor_tercero;
  return r;
}

// ¿La reserva pertenece al cliente del token? (anti-IDOR de reserva_id del body)
async function reservaDelCliente(reservaId: number, cid: number): Promise<boolean> {
  if (!Number.isFinite(reservaId) || reservaId <= 0) return false;
  const { data } = await admin.from("reservas").select("id,cliente_id").eq("id", reservaId).maybeSingle();
  return !!data && Number(data.cliente_id) === cid;
}

const err = (mensaje: string, status = 400) => NextResponse.json({ error: mensaje }, { status });

// ─── Handler ─────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.accion !== "string") return err("accion requerida");
    const accion = body.accion as string;

    // ── LOGIN: RUC (o nombre de empresa) + documento + contraseña ────────────
    if (accion === "login") {
      const ruc = String(body.ruc ?? "").trim();
      const doc = String(body.doc ?? "").trim();
      const password = String(body.password ?? "");
      const tipoId = String(body.tipoId ?? "DNI");
      if (!ruc || !doc || !password) return err("Datos incompletos");

      // Misma búsqueda que hacía el navegador: RUC exacto o nombre de empresa.
      // Se sanea el término porque va interpolado en la sintaxis .or() de PostgREST.
      const q = ruc.replace(/[,()]/g, "");
      const { data: clienteData } = await admin.from("clientes").select("*")
        .or(`ruc.eq.${q},empresa.ilike.%${q}%`).limit(1).maybeSingle();
      if (!clienteData) return err("No se encontró ningún cliente con ese RUC.", 401);

      const { data: usuariosData } = await admin.from("portal_usuarios")
        .select("*").eq("cliente_id", clienteData.id).eq("activo", true);
      const usuarios = (usuariosData || []) as any[];

      if (usuarios.length === 0) {
        // Legacy: sin usuarios configurados → código de acceso de la empresa.
        // (Antes un código vacío dejaba entrar con cualquier clave; ahora se exige.)
        const codigoEmpresa = clienteData.codigo_acceso;
        if (!codigoEmpresa || codigoEmpresa !== password) {
          return err("Sin usuarios configurados. Contacta a AFA Transportes.", 401);
        }
        const tempUser = {
          id: 0, cliente_id: clienteData.id, nombre: clienteData.nombre, dni: doc,
          cargo: null, rol: "admin", email: clienteData.email, codigo_acceso: "",
          activo: true, created_at: "", modulos_permitidos: null,
        };
        return NextResponse.json({
          cliente: clienteData, usuario: tempUser,
          token: firmarToken(Number(clienteData.id), 0),
        });
      }

      const usuario = usuarios.find(u => String(u.dni ?? "").trim() === doc);
      if (!usuario) {
        return err(`${tipoId === "Celular" ? "Celular" : tipoId} no registrado para este cliente.`, 401);
      }
      if (String(usuario.codigo_acceso ?? "") !== password) return err("Contraseña incorrecta.", 401);

      return NextResponse.json({
        cliente: clienteData,
        usuario: { ...usuario, codigo_acceso: "" }, // la clave no viaja al navegador
        token: firmarToken(Number(clienteData.id), Number(usuario.id)),
      });
    }

    // ── Resto de acciones: exigen token válido ───────────────────────────────
    const ses = verificarToken(body.token);
    if (!ses) return err("Sesión expirada. Vuelve a iniciar sesión.", 401);
    const cid = ses.cid;

    switch (accion) {
      // ── DATOS: reservas + facturas + documentos del cliente ────────────────
      case "datos": {
        const [reservas, factRes, docsRes] = await Promise.all([
          paginado((f, t) => admin.from("reservas").select("*").eq("cliente_id", cid)
            .order("fecha_servicio", { ascending: false }).order("id", { ascending: false }).range(f, t)),
          admin.from("facturas")
            .select("id,reserva_id,tipo_comprobante,serie,numero,fecha_emision,fecha_vencimiento,total,estado,pdf_url")
            .eq("cliente_id", cid).order("fecha_emision", { ascending: false }),
          admin.from("documentos_cliente").select("*").eq("cliente_id", cid)
            .order("created_at", { ascending: false }),
        ]);
        return NextResponse.json({
          reservas: reservas.map(limpiarReserva),
          facturas: factRes.data || [],
          documentos: docsRes.data || [],
        });
      }

      // ── PARADAS de una reserva del cliente ─────────────────────────────────
      case "paradas_reserva": {
        const rid = Number(body.reserva_id);
        if (!(await reservaDelCliente(rid, cid))) return err("No autorizado", 403);
        const { data } = await admin.from("paradas").select("*").eq("reserva_id", rid).order("orden");
        return NextResponse.json({ paradas: data || [] });
      }

      // ── PLACAS por ids (propios y de tercero) ──────────────────────────────
      case "placas_vehiculos": {
        const vIds = (Array.isArray(body.vehiculo_ids) ? body.vehiculo_ids : []).filter((x: any) => Number.isFinite(Number(x)));
        const vtIds = (Array.isArray(body.vehiculo_tercero_ids) ? body.vehiculo_tercero_ids : []).filter((x: any) => Number.isFinite(Number(x)));
        const [v, vt] = await Promise.all([
          vIds.length ? admin.from("vehiculos").select("id,placa").in("id", vIds) : Promise.resolve({ data: [] as any[] }),
          vtIds.length ? admin.from("vehiculos_tercero").select("id,placa").in("id", vtIds) : Promise.resolve({ data: [] as any[] }),
        ]);
        return NextResponse.json({ vehiculos: (v as any).data || [], vehiculos_tercero: (vt as any).data || [] });
      }

      // ── FLOTA del cliente para el mapa En vivo ─────────────────────────────
      case "vehiculos_en_vivo": {
        const filas = await paginado((f, t) => admin.from("reservas")
          .select("vehiculo_id,vehiculo_tercero_id").eq("cliente_id", cid).order("id").range(f, t));
        const vIds = [...new Set(filas.map(r => r.vehiculo_id).filter(Boolean))];
        const vtIds = [...new Set(filas.map(r => r.vehiculo_tercero_id).filter(Boolean))];
        const [v, vt] = await Promise.all([
          vIds.length ? admin.from("vehiculos").select("id,placa").in("id", vIds) : Promise.resolve({ data: [] as any[] }),
          vtIds.length ? admin.from("vehiculos_tercero").select("id,placa").in("id", vtIds) : Promise.resolve({ data: [] as any[] }),
        ]);
        return NextResponse.json({ vehiculos: (v as any).data || [], vehiculos_tercero: (vt as any).data || [] });
      }

      // ── MANIFIESTO de una reserva: paradas + boarding + roster ─────────────
      // Réplica exacta del armado que hacía el navegador (cargarDetalle):
      // roster = pasajeros_parada (con datos del pasajero) ∪ ad-hoc sin paradero
      // (entradas sintéticas con id negativo), y edad en consulta AISLADA cuyo
      // fallo jamás vacía el roster.
      case "manifiesto_reserva": {
        const rid = Number(body.reserva_id);
        if (!(await reservaDelCliente(rid, cid))) return err("No autorizado", 403);
        const [pRes, bRes, paxRes] = await Promise.all([
          admin.from("paradas").select("*").eq("reserva_id", rid).order("orden"),
          admin.from("boarding_log").select("*, pasajero:pasajeros(nombre,dni,empresa)").eq("reserva_id", rid).order("timestamp"),
          admin.from("pasajeros").select("id,nombre,dni").eq("reserva_id", rid),
        ]);
        const ps = pRes.data || [];
        let pp: any[] = [];
        if (ps.length > 0) {
          const { data } = await admin.from("pasajeros_parada")
            .select("*, pasajero:pasajeros(nombre,dni)").in("parada_id", ps.map((p: any) => p.id));
          pp = data || [];
        }
        const asignados = new Set(pp.map((x: any) => x.pasajero_id));
        const sinParada = (paxRes.data || [])
          .filter((p: any) => !asignados.has(p.id))
          .map((p: any) => ({ id: -p.id, parada_id: null, pasajero_id: p.id, estado: "Pendiente", pasajero: { nombre: p.nombre, dni: p.dni } }));
        const roster = [...pp, ...sinParada];
        const idsPax = [...new Set(roster.map((x: any) => x.pasajero_id).filter(Boolean))];
        if (idsPax.length > 0) {
          const { data: edades } = await admin.from("pasajeros").select("id,edad").in("id", idsPax);
          if (edades) {
            const em = new Map((edades as any[]).map(e => [e.id, e.edad]));
            roster.forEach((x: any) => { if (x.pasajero) x.pasajero.edad = em.get(x.pasajero_id) ?? null; });
          }
        }
        return NextResponse.json({ paradas: ps, boarding: bRes.data || [], roster });
      }

      // ── EDITOR de manifiesto (ModalManifiestoPortal.cargar) ────────────────
      case "manifiesto_editor": {
        const rid = Number(body.reserva_id);
        if (!(await reservaDelCliente(rid, cid))) return err("No autorizado", 403);
        const [cfgRes, parRes, adhocRes] = await Promise.all([
          admin.from("reservas").select("ruta_nombre,permite_autoseleccion,permite_cambio_paradero").eq("id", rid).maybeSingle(),
          admin.from("paradas").select("id,orden,nombre,hora_estimada").eq("reserva_id", rid).order("orden"),
          admin.from("pasajeros").select("id,nombre,dni,empresa,telefono").eq("reserva_id", rid),
        ]);
        const pars = parRes.data || [];
        const adhoc = adhocRes.data || [];
        let asignaciones: any[] = [];
        if (pars.length > 0) {
          const { data } = await admin.from("pasajeros_parada")
            .select("pasajero_id,parada_id,estado_abordaje").in("parada_id", pars.map((p: any) => p.id));
          asignaciones = data || [];
        }
        const adhocIds = new Set(adhoc.map((p: any) => p.id));
        const extraIds = [...new Set(asignaciones.map((a: any) => a.pasajero_id).filter((id: number) => !adhocIds.has(id)))];
        let globales: any[] = [];
        if (extraIds.length > 0) {
          const { data } = await admin.from("pasajeros").select("id,nombre,dni,empresa,telefono").in("id", extraIds);
          globales = data || [];
        }
        return NextResponse.json({ config: cfgRes.data || null, paradas: pars, pasajeros: [...adhoc, ...globales], asignaciones });
      }

      // ── STATS del historial: esperados / embarcados por reserva ────────────
      case "historial_stats": {
        const pedidos = (Array.isArray(body.reserva_ids) ? body.reserva_ids : [])
          .map(Number).filter((n: number) => Number.isFinite(n) && n > 0);
        if (pedidos.length === 0) return NextResponse.json({ stats: {} });
        // Solo reservas que de verdad son del cliente del token.
        const propias = await paginado((f, t) => admin.from("reservas").select("id")
          .eq("cliente_id", cid).in("id", pedidos).order("id").range(f, t));
        const ids = propias.map(r => r.id);
        if (ids.length === 0) return NextResponse.json({ stats: {} });

        const [ppData, paxAdhocData] = await Promise.all([
          paginado((f, t) => admin.from("pasajeros_parada")
            .select("pasajero_id, estado, estado_abordaje, paradas!inner(reserva_id)")
            .in("paradas.reserva_id", ids).order("id").range(f, t)),
          paginado((f, t) => admin.from("pasajeros").select("id, reserva_id")
            .in("reserva_id", ids).order("id").range(f, t)),
        ]);

        const paxPorReserva: Record<number, Set<number>> = {};
        const abordadosPorReserva: Record<number, Set<number>> = {};
        ids.forEach((id: number) => { paxPorReserva[id] = new Set(); abordadosPorReserva[id] = new Set(); });
        paxAdhocData.forEach((p: any) => { paxPorReserva[p.reserva_id]?.add(p.id); });
        ppData.forEach((pp: any) => {
          const rid = pp.paradas?.reserva_id;
          if (!rid) return;
          paxPorReserva[rid]?.add(pp.pasajero_id);
          if (esAbordado(pp)) abordadosPorReserva[rid]?.add(pp.pasajero_id);
        });
        const stats: Record<number, { embarcados: number; esperados: number }> = {};
        ids.forEach((id: number) => {
          stats[id] = { embarcados: abordadosPorReserva[id]?.size || 0, esperados: paxPorReserva[id]?.size || 0 };
        });
        return NextResponse.json({ stats });
      }

      // ── COLABORADORES: usuarios del portal del cliente ─────────────────────
      case "colaboradores_listar": {
        const { data } = await admin.from("portal_usuarios").select("*")
          .eq("cliente_id", cid).order("created_at");
        return NextResponse.json({ colaboradores: data || [] });
      }

      case "colaboradores_guardar":
      case "colaboradores_toggle":
      case "colaboradores_eliminar": {
        // Solo el admin del portal gestiona usuarios. uid 0 = login legacy de la
        // empresa (rol admin implícito); uid > 0 debe seguir activo y ser admin.
        if (ses.uid > 0) {
          const { data: yo } = await admin.from("portal_usuarios")
            .select("id,rol,activo").eq("id", ses.uid).eq("cliente_id", cid).maybeSingle();
          if (!yo || !yo.activo || yo.rol !== "admin") return err("Solo un administrador puede gestionar usuarios.", 403);
        }

        if (accion === "colaboradores_guardar") {
          const d = body.datos || {};
          const campos: any = {
            nombre: String(d.nombre ?? "").trim(),
            dni: String(d.dni ?? "").trim(),
            cargo: String(d.cargo ?? "").trim() || null,
            rol: d.rol === "admin" ? "admin" : "visor",
            email: String(d.email ?? "").trim() || null,
            modulos_permitidos: Array.isArray(d.modulos_permitidos) ? d.modulos_permitidos : null,
          };
          if (!campos.nombre || !campos.dni) return err("Nombre y DNI son obligatorios");
          const id = Number(body.id) || 0;
          if (id > 0) {
            if (String(d.codigo_acceso ?? "").trim()) campos.codigo_acceso = String(d.codigo_acceso).trim();
            const { data: fila } = await admin.from("portal_usuarios").select("id").eq("id", id).eq("cliente_id", cid).maybeSingle();
            if (!fila) return err("Usuario no encontrado", 404);
            const { error } = await admin.from("portal_usuarios").update(campos).eq("id", id);
            if (error) return err("Error al actualizar: " + error.message, 500);
          } else {
            const clave = String(d.codigo_acceso ?? "").trim();
            if (!clave) return err("La contraseña es obligatoria para nuevos usuarios");
            const { error } = await admin.from("portal_usuarios")
              .insert({ ...campos, cliente_id: cid, codigo_acceso: clave, activo: true });
            if (error) {
              return err("Error: " + (error.message.includes("unique") ? "Ya existe un usuario con ese DNI" : error.message), 500);
            }
          }
          return NextResponse.json({ ok: true });
        }

        const id = Number(body.id) || 0;
        const { data: fila } = await admin.from("portal_usuarios").select("id,activo").eq("id", id).eq("cliente_id", cid).maybeSingle();
        if (!fila) return err("Usuario no encontrado", 404);
        if (accion === "colaboradores_toggle") {
          const { error } = await admin.from("portal_usuarios").update({ activo: !fila.activo }).eq("id", id);
          if (error) return err(error.message, 500);
        } else {
          const { error } = await admin.from("portal_usuarios").delete().eq("id", id);
          if (error) return err(error.message, 500);
        }
        return NextResponse.json({ ok: true });
      }

      // ── URL firmada de un documento del cliente (bucket privado) ───────────
      case "doc_url": {
        const docId = Number(body.doc_id);
        const { data: doc } = await admin.from("documentos_cliente")
          .select("id,cliente_id,storage_path").eq("id", docId).maybeSingle();
        if (!doc || Number(doc.cliente_id) !== cid) return err("No autorizado", 403);
        const { data, error } = await admin.storage.from("documentos-clientes")
          .createSignedUrl(doc.storage_path, 3600);
        if (error || !data?.signedUrl) return err(error?.message || "No se pudo generar el enlace", 500);
        return NextResponse.json({ url: data.signedUrl });
      }

      default:
        return err("Acción no reconocida");
    }
  } catch (e: any) {
    console.error("[api/cliente]", e?.message);
    return NextResponse.json({ error: "Error interno. Intenta de nuevo." }, { status: 500 });
  }
}
