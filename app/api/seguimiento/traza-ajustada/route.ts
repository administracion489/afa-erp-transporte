// app/api/seguimiento/traza-ajustada/route.ts
// AJUSTA A LA VÍA, UNA VEZ, LA TRAZA DE UN SERVICIO FINALIZADO Y LA GUARDA PARA SIEMPRE
// (lib/gps-traza-ajustada-datos.ts → calcularYGuardar). Lo pide el modal GPS al abrir un servicio
// terminado cuyo `ajustada.estado` (de /api/cliente/gps) es `falta`, o `desactualizada` con
// `puedeCalcular`. Es la ÚNICA puerta de escritura de `gps_traza_ajustada`: el navegador nunca escribe
// una traza (podría plantar una falsa).
//
//   POST { reservaId, token? }  →  { codigo, traza?, calculadoEn?, detalle }
//
// Autorización (doble, como /api/cliente/gps, porque el mismo modal lo usan dos públicos):
//   · Operador del ERP (Bearer): cualquiera de los módulos que abren el modal GPS o enlazan al recorrido
//     (Seguimiento, Monitoreo, Vehículos). Un Bearer inválido NO cae al token del portal.
//   · Cliente del portal (`token` en el cuerpo): la reserva tiene que ser SUYA (el cid sale del token).
// Los vehículos se derivan de la reserva en el servidor; el cuerpo solo trae el id.
//
// Topes (por instancia, NO medidos): 2 cálculos a la vez y 6 esperando (503 con Retry-After); por
// persona, 30 cálculos que gastan consultas por hora en el ERP y 10 en el portal (`limite_usuario`).
// El presupuesto GLOBAL (por hora y por mes, en la bitácora) lo aplica calcularYGuardar.
//
// Respuestas:
//   400 · cuerpo ilegible o `reservaId` no es un entero > 0
//   401 / 403 · sin sesión, sin permiso, o la reserva no es del cliente
//   404 · la reserva no existe (solo al operador; al portal, 403)
//   202 · `en_curso`: otra apertura lo está calculando — reintentar en unos segundos
//   503 · demasiados cálculos esperando en la instancia (`reintentar: true`, Retry-After)
//   200 · `{ codigo, traza?, calculadoEn?, detalle }` con los códigos de MOTIVO_CALCULO
//         (lib/gps-traza-ajustada.ts). Un error inesperado es 200 con `codigo: "error"`: el modal
//         siempre tiene un motivo que mostrar. El token de Mapbox nunca sale en la respuesta ni en logs.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApiAlguno } from "@/lib/api-auth";
import { verificarTokenPortal, reservaEsDelCliente } from "@/lib/portal-auth";
import { crearTurno, ColaLlena } from "@/lib/turno-calculo";
import { calcularYGuardar } from "@/lib/gps-traza-ajustada-datos";
import { MOTIVO_CALCULO } from "@/lib/gps-traza-ajustada";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const adminClient = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const MODULOS = ["seguimiento", "monitoreo", "vehiculos"];
const turno = crearTurno(2, 6);

// Límite por persona: cálculos que GASTARON consultas a Mapbox en la última hora (por instancia).
const LIMITE_HORA_ERP = 30;
const LIMITE_HORA_PORTAL = 10;
const gastosPorSujeto = new Map<string, number[]>();
function usadosUltimaHora(sujeto: string, ahora: number): number {
  const l = (gastosPorSujeto.get(sujeto) ?? []).filter((t) => ahora - t < 3600_000);
  if (l.length) gastosPorSujeto.set(sujeto, l); else gastosPorSujeto.delete(sujeto);
  return l.length;
}
function anotarGasto(sujeto: string, ahora: number) {
  const l = gastosPorSujeto.get(sujeto) ?? [];
  l.push(ahora);
  gastosPorSujeto.set(sujeto, l);
  if (gastosPorSujeto.size > 5000) gastosPorSujeto.delete(gastosPorSujeto.keys().next().value as string);
}

export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Cuerpo inválido: se esperaba JSON con reservaId." }, { status: 400 }); }
  const reservaId = Number(body?.reservaId);
  if (!Number.isInteger(reservaId) || reservaId <= 0) {
    return NextResponse.json({ error: "reservaId tiene que ser el número del servicio (entero mayor que 0)." }, { status: 400 });
  }

  // ── Autorización ─────────────────────────────────────────────────────────────────────
  let sujeto: string;
  let limite: number;
  let esPortal = false;
  if (req.headers.get("authorization")) {
    const auth = await verificarUsuarioApiAlguno(req, MODULOS);
    if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
    sujeto = `u:${auth.userId}`;
    limite = LIMITE_HORA_ERP;
  } else {
    const sesion = verificarTokenPortal(body?.token);
    if (!sesion) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    if (!(await reservaEsDelCliente(adminClient(), reservaId, sesion.cid))) {
      return NextResponse.json({ error: "No autorizado" }, { status: 403 });
    }
    sujeto = `p:${sesion.cid}:${sesion.uid}`;
    limite = LIMITE_HORA_PORTAL;
    esPortal = true;
  }

  const ahora = Date.now();
  if (usadosUltimaHora(sujeto, ahora) >= limite) {
    return NextResponse.json({ codigo: "limite_usuario", detalle: MOTIVO_CALCULO.limite_usuario.texto });
  }

  try {
    const r = await turno(() => calcularYGuardar(reservaId, { origen: "apertura", sujeto }));
    if (r.llamadas > 0) anotarGasto(sujeto, Date.now());
    if (r.reservaNoExiste) {
      return esPortal
        ? NextResponse.json({ error: "No autorizado" }, { status: 403 })
        : NextResponse.json({ error: "El servicio no existe." }, { status: 404 });
    }
    const payload = {
      codigo: r.codigo,
      ...(r.traza ? { traza: r.traza } : {}),
      ...(r.calculadoEn ? { calculadoEn: r.calculadoEn } : {}),
      detalle: r.detalle,
    };
    return NextResponse.json(payload, { status: r.codigo === "en_curso" ? 202 : 200 });
  } catch (e: any) {
    if (e instanceof ColaLlena) {
      return NextResponse.json({ error: e.message, reintentar: true }, { status: 503, headers: { "Retry-After": "5" } });
    }
    console.error("[api/seguimiento/traza-ajustada]", e?.message ?? e);
    return NextResponse.json({ codigo: "error", detalle: MOTIVO_CALCULO.error.texto });
  }
}
