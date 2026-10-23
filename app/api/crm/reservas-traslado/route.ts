// app/api/crm/reservas-traslado/route.ts
// La TARJETA de la reserva de un traslado que cotizó la IA del CRM (la bandeja del inbox).
//
//   GET  ?solicitud_id=N&conversacion_id=UUID&accion_id=UUID → RespuestaVista ({ ok, solicitud, permisos })
//   POST CuerpoTarjeta (lib/traslados/reserva-solicitud-tipos.ts)  → ResultadoAccionReserva
//
// Permisos: todo exige el módulo «crm». «Emitir y enviar Confirmación» exige además «programacion»
// (es el documento de /api/reservas/confirmacion). Las acciones de DINERO (registrar adelanto, «No
// encontré el pago», registrar devolución) exigen además «tesoreria» o «finanzas»: quien vende no es
// quien valida que el dinero entró.
// SIEMPRE se comprueba que conversación ↔ tarjeta ↔ solicitud ↔ cotización coincidan
// (`cargarCadena`); el número del cliente y la conversación los lee el servidor, nunca del cuerpo.
// Quién actúa sale del TOKEN. La lógica vive en lib/traslados/reserva-solicitud-datos.ts.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi, verificarUsuarioApiAlguno } from "@/lib/api-auth";
import { guardarGasto } from "@/lib/api-guard";
import {
  cargarCadena, cerrarSolicitud, confirmarDisponibilidad, enviarConfirmacionReserva, marcarConfirmacionEnviada, marcarPagoNoEncontrado,
  pedirComprobante, registrarAdelantoSolicitud, registrarComprobanteTarjeta, registrarDevolucionSolicitud, resolverCancelacion, sinUnidad,
  verComprobante, vincularCliente, vistaSolicitud,
} from "@/lib/traslados/reserva-solicitud-datos";
import {
  ACCIONES_DINERO, ACCIONES_TARJETA, STATUS_RESULTADO_RESERVA, type AccionDinero, type AccionTarjeta, type ResultadoAccionReserva,
} from "@/lib/traslados/reserva-solicitud-tipos";

export const dynamic = "force-dynamic";
// «Hay unidad» crea la reserva y escribe al cliente; «Registrar comprobante» lo lee con un modelo de
// visión; «Enviar Confirmación» arma el PDF y lo manda por WhatsApp: más que los 10 s por defecto.
export const maxDuration = 60;

const MODULOS_DINERO = ["tesoreria", "finanzas"];

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
}
const idDe = (v: unknown): number | null => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const uuidDe = (v: unknown): string => (typeof v === "string" && /^[0-9a-fA-F-]{8,64}$/.test(v.trim()) ? v.trim() : "");
const responder = (r: ResultadoAccionReserva) => NextResponse.json(r, { status: STATUS_RESULTADO_RESERVA[r.codigo] ?? 500 });
const fallo = (codigo: ResultadoAccionReserva["codigo"], detalle: string) => responder({ ok: false, codigo, detalle });

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "crm");
  if (!auth.ok) return fallo(auth.status === 403 ? "sin_permiso" : "no_autorizado", auth.error);
  const u = new URL(req.url);
  const solicitudId = idDe(u.searchParams.get("solicitud_id"));
  const conversacionId = uuidDe(u.searchParams.get("conversacion_id"));
  const accionId = uuidDe(u.searchParams.get("accion_id"));
  if (!solicitudId || !conversacionId || !accionId) return fallo("datos_invalidos", "Faltan solicitud_id, conversacion_id o accion_id.");
  const sb = admin();
  try {
    const cad = await cargarCadena(sb, { solicitudId, conversacionId, accionId });
    if (!cad.ok) return fallo(cad.codigo, cad.detalle);
    const [solicitud, dinero, programacion] = await Promise.all([
      vistaSolicitud(sb, cad.c),
      verificarUsuarioApiAlguno(req, MODULOS_DINERO).then((r) => r.ok),
      verificarUsuarioApi(req, "programacion").then((r) => r.ok),
    ]);
    return NextResponse.json({ ok: true, solicitud, permisos: { dinero, programacion } });
  } catch (e) {
    console.error("[crm/reservas-traslado] vista", e);
    return fallo("error", "No se pudo leer la solicitud de reserva. Vuelve a intentar en un momento.");
  }
}

export async function POST(req: NextRequest) {
  const bloqueo = guardarGasto(req, { etiqueta: "crm-reservas-traslado" });
  if (bloqueo) return bloqueo;
  const auth = await verificarUsuarioApi(req, "crm");
  if (!auth.ok) return fallo(auth.status === 403 ? "sin_permiso" : "no_autorizado", auth.error);
  let cuerpo: Record<string, unknown>;
  try { cuerpo = (await req.json()) as Record<string, unknown>; } catch { return fallo("datos_invalidos", "Cuerpo inválido."); }
  const accion = String(cuerpo.accion ?? "");
  const esDinero = (ACCIONES_DINERO as readonly string[]).includes(accion);
  if (!esDinero && !(ACCIONES_TARJETA as readonly string[]).includes(accion)) return fallo("datos_invalidos", "Acción desconocida.");
  const solicitudId = idDe(cuerpo.solicitud_id);
  const conversacionId = uuidDe(cuerpo.conversacion_id);
  const accionId = uuidDe(cuerpo.accion_id);
  if (!solicitudId || !conversacionId || !accionId) return fallo("datos_invalidos", "Faltan solicitud_id, conversacion_id o accion_id: recarga la bandeja.");

  if (esDinero) {
    const a2 = await verificarUsuarioApiAlguno(req, MODULOS_DINERO);
    if (!a2.ok) return fallo("sin_permiso", "Registrar un adelanto, una devolución o «No encontré el pago» exige el módulo Finanzas o Cuentas por Pagar (Tesorería).");
  }
  if (accion === "enviar_confirmacion") {
    const a3 = await verificarUsuarioApi(req, "programacion");
    if (!a3.ok) return fallo("sin_permiso", "Emitir la Confirmación de Reserva exige además el módulo Programación.");
  }

  const sb = admin();
  try {
    const cad = await cargarCadena(sb, { solicitudId, conversacionId, accionId });
    if (!cad.ok) return fallo(cad.codigo, cad.detalle);
    const { data: u } = await sb.from("usuarios").select("nombre").eq("id", auth.userId).maybeSingle();
    const quien = { id: auth.userId, nombre: (u?.nombre as string | null) ?? null };
    const c = cad.c;
    let r: ResultadoAccionReserva;
    switch (accion as AccionTarjeta | AccionDinero) {
      case "hay_unidad": r = await confirmarDisponibilidad(sb, c, quien); break;
      case "sin_unidad": r = await sinUnidad(sb, c, quien); break;
      case "pedir_comprobante": r = await pedirComprobante(sb, c, quien, cuerpo.motivo === "no_encontrado" ? "no_encontrado" : "otro"); break;
      case "registrar_comprobante": r = await registrarComprobanteTarjeta(sb, c, quien); break;
      case "ver_comprobante": r = await verComprobante(sb, c, quien, {}, { comprobanteId: idDe(cuerpo.comprobante_id) }); break;
      case "cerrar": r = await cerrarSolicitud(sb, c, quien, cuerpo.motivo, cuerpo.nota); break;
      case "resolver_cancelacion": r = await resolverCancelacion(sb, c, quien, cuerpo.devolucion_pct); break;
      case "vincular_cliente": r = await vincularCliente(sb, c, cuerpo.cliente_id); break;
      case "enviar_confirmacion": r = await enviarConfirmacionReserva(sb, c, quien, { idioma: cuerpo.idioma, extras: (cuerpo.extras ?? null) as never }); break;
      case "marcar_confirmacion_enviada": r = await marcarConfirmacionEnviada(sb, c, quien); break;
      case "registrar_adelanto": r = await registrarAdelantoSolicitud(sb, c, cuerpo, quien); break;
      case "pago_no_encontrado": r = await marcarPagoNoEncontrado(sb, c, quien); break;
      case "registrar_devolucion": r = await registrarDevolucionSolicitud(sb, c, cuerpo, quien); break;
      default: return fallo("datos_invalidos", "Acción desconocida.");
    }
    // La tarjeta se repinta con la vista de después (best-effort: la acción ya quedó hecha).
    if (accion !== "ver_comprobante") {
      try {
        const de = await cargarCadena(sb, { solicitudId, conversacionId, accionId });
        if (de.ok) r.vista = await vistaSolicitud(sb, de.c);
      } catch { r.vista = null; }
    }
    return responder(r);
  } catch (e) {
    console.error(`[crm/reservas-traslado] ${accion}`, e);
    return fallo("error", "No se pudo completar la acción. Vuelve a intentar en un momento.");
  }
}
