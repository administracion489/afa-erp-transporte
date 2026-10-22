// app/api/reservas/solicitudes/route.ts
// Las solicitudes de reserva de traslado vistas desde TESORERÍA (/tesoreria?tab=adelantos).
//
//   GET  ?filtro=pendientes|todas      → RespuestaTesoreria (lo que le toca verificar o devolver)
//   GET  ?solicitud_id=N               → { ok, solicitud: VistaSolicitud }
//   POST CuerpoTesoreria               → ResultadoAccionReserva
//        { accion: "registrar_adelanto", solicitud_id, monto, fecha, metodo, referencia }
//        { accion: "pago_no_encontrado", solicitud_id }
//        { accion: "registrar_devolucion", solicitud_id, monto, fecha, metodo, referencia }
//
// Permisos: «tesoreria» o «finanzas». Un adelanto se registra al VER el dinero en el banco: la foto
// del comprobante que mandó el cliente es evidencia, no un cobro. Quién registra sale del TOKEN.
// La lógica (y los topes: nunca más que el total, nunca más devolución que la decidida) vive en
// lib/traslados/reserva-solicitud-datos.ts, la misma que usa la tarjeta del CRM.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApiAlguno } from "@/lib/api-auth";
import { guardarGasto } from "@/lib/api-guard";
import { tablaFaltante } from "@/lib/columna-faltante";
import {
  cargarCadena, listaParaTesoreria, marcarPagoNoEncontrado, registrarAdelantoSolicitud, registrarDevolucionSolicitud, vistaSolicitud,
  TABLA_SOLICITUDES,
} from "@/lib/traslados/reserva-solicitud-datos";
import {
  ACCIONES_DINERO, STATUS_RESULTADO_RESERVA, type ResultadoAccionReserva,
} from "@/lib/traslados/reserva-solicitud-tipos";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MODULOS = ["tesoreria", "finanzas"];

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
}
const idDe = (v: unknown): number | null => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const responder = (r: ResultadoAccionReserva) => NextResponse.json(r, { status: STATUS_RESULTADO_RESERVA[r.codigo] ?? 500 });
const fallo = (codigo: ResultadoAccionReserva["codigo"], detalle: string) => responder({ ok: false, codigo, detalle });
const SIN_PERMISO = "Las solicitudes de reserva de traslado se ven y se registran con el módulo Finanzas o Cuentas por Pagar (Tesorería).";

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApiAlguno(req, MODULOS);
  if (!auth.ok) return fallo(auth.status === 403 ? "sin_permiso" : "no_autorizado", auth.status === 403 ? SIN_PERMISO : auth.error);
  const sb = admin();
  const u = new URL(req.url);
  const solicitudId = idDe(u.searchParams.get("solicitud_id"));
  try {
    if (solicitudId) {
      const cad = await cargarCadena(sb, { solicitudId });
      if (!cad.ok) return fallo(cad.codigo, cad.detalle);
      return NextResponse.json({ ok: true, solicitud: await vistaSolicitud(sb, cad.c) });
    }
    // ¿Existe la tabla? Sin la migración, la lista vacía con su aviso (no un error).
    const prueba = await sb.from(TABLA_SOLICITUDES).select("id").limit(1);
    if (prueba.error && tablaFaltante(prueba.error, TABLA_SOLICITUDES)) return NextResponse.json({ ok: true, filas: [], sinMigracion: true, avisos: ["Falta correr supabase/reservas-09a-solicitudes.sql."] });
    if (prueba.error) throw new Error(prueba.error.message);
    const filtro = u.searchParams.get("filtro") === "todas" ? "todas" : "pendientes";
    const { filas, avisos } = await listaParaTesoreria(sb, { filtro });
    return NextResponse.json({ ok: true, filas, sinMigracion: false, avisos });
  } catch (e) {
    console.error("[reservas/solicitudes] GET", e);
    return fallo("error", "No se pudieron leer las solicitudes de reserva. Vuelve a intentar en un momento.");
  }
}

export async function POST(req: NextRequest) {
  const bloqueo = guardarGasto(req, { etiqueta: "reservas-solicitudes" });
  if (bloqueo) return bloqueo;
  const auth = await verificarUsuarioApiAlguno(req, MODULOS);
  if (!auth.ok) return fallo(auth.status === 403 ? "sin_permiso" : "no_autorizado", auth.status === 403 ? SIN_PERMISO : auth.error);
  let cuerpo: Record<string, unknown>;
  try { cuerpo = (await req.json()) as Record<string, unknown>; } catch { return fallo("datos_invalidos", "Cuerpo inválido."); }
  const accion = String(cuerpo.accion ?? "");
  if (!(ACCIONES_DINERO as readonly string[]).includes(accion)) return fallo("datos_invalidos", "Acción desconocida.");
  const solicitudId = idDe(cuerpo.solicitud_id);
  if (!solicitudId) return fallo("datos_invalidos", "Falta solicitud_id.");
  const sb = admin();
  try {
    const cad = await cargarCadena(sb, { solicitudId });
    if (!cad.ok) return fallo(cad.codigo, cad.detalle);
    const { data: u } = await sb.from("usuarios").select("nombre").eq("id", auth.userId).maybeSingle();
    const quien = { id: auth.userId, nombre: (u?.nombre as string | null) ?? null };
    const r = accion === "registrar_adelanto" ? await registrarAdelantoSolicitud(sb, cad.c, cuerpo, quien)
      : accion === "registrar_devolucion" ? await registrarDevolucionSolicitud(sb, cad.c, cuerpo, quien)
      : await marcarPagoNoEncontrado(sb, cad.c, quien);
    try {
      const de = await cargarCadena(sb, { solicitudId });
      if (de.ok) r.vista = await vistaSolicitud(sb, de.c);
    } catch { r.vista = null; }
    return responder(r);
  } catch (e) {
    console.error(`[reservas/solicitudes] ${accion}`, e);
    return fallo("error", "No se pudo completar la operación. Vuelve a intentar en un momento.");
  }
}
