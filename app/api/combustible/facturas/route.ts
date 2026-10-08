// app/api/combustible/facturas/route.ts — Facturas de combustible por correo: el respaldo
// oficial del Radar IA (lib/combustible/facturas-correo.ts).
//
//   GET  (cron, Bearer CRON_SECRET)  → lee el correo de facturas (o el Gmail del CRM) y concilia.
//   POST (pantalla /combustible, módulo `combustible`):
//        { accion: "sincronizar", historial? } → historial: el ÚLTIMO AÑO, por tandas (la
//             pantalla vuelve a llamar mientras queden `pendientes`). Lo que falta del historial
//             NO se registra solo: queda en «revisar» con motivo `historico`.
//        { accion: "registrar_historicas" } → una persona decidió registrar todas esas juntas.
//        { accion: "reintentar_errores", desde_id? } → vuelve a leer, por su id, los correos que
//             quedaron en «Error» (la pantalla avanza con `ultimo_id` mientras `quedan`).
//        { accion: "deuda_prepago" } → comprobantes de una cuenta prepago que figuran como deuda
//             en Tesorería sin serlo (nacieron «impaga» antes de que se crearan pagados).
//        { accion: "marcar_prepago", ids } → una persona vio esa lista y los deja pagados.
//        { accion: "confirmar_linea", factura_id, n, placa?, fecha? } → una persona confirma
//             una línea que quedó en «Revisar» (con la placa/fecha que ella eligió).
//        { accion: "descartar", factura_id }  → no es una factura de combustible.
//        { accion: "desfase" } → por cuenta: cuántos días después del despacho sale la factura
//             (medido o configurado, lib/combustible/desfase-factura.ts) y qué cargas registradas
//             con la fecha de EMISIÓN movería.
//        { accion: "mover_a_despacho", ids, dias } → una persona vio esa lista y las mueve.
//        { accion: "reconciliar" } → vuelve a cruzar las facturas con líneas pendientes contra lo
//             registrado HOY, sin leer el correo (al abrir la pestaña y tras registrar a mano).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { esCronAutorizado, verificarUsuarioApi } from "@/lib/api-auth";
import { hoyLima } from "@/lib/alertas";
import { cargarCuentas } from "@/lib/combustible/saldo-datos";
import {
  sincronizarFacturas, conciliarFacturaGuardada, registrarHistoricas, LECTURA_HISTORIAL,
  prepagoComoDeuda, marcarPrepagoPagadas, reintentarErrores,
  desfaseDeCuenta, cargasPorMoverDeCuenta, moverCargasADespacho, reconciliarPendientes,
} from "@/lib/combustible/facturas-correo";
import { resumenMover } from "@/lib/combustible/desfase-factura";

export const maxDuration = 300;

const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

async function sincronizarTodo(sb: any, historial = false) {
  const { cuentas, sinMigracion } = await cargarCuentas(sb);
  if (sinMigracion) return { ok: false, error: "Falta correr supabase/combustible-03-saldo-cuenta-y-facturas.sql" };
  const activas = cuentas.filter((c) => c.activo);
  if (!activas.length) return { ok: true, resultados: [], aviso: "No hay cuentas de combustible activas." };
  const resultados = [];
  for (const c of activas) {
    resultados.push({ cuenta: c.nombre, ...(await sincronizarFacturas(sb, c, hoyLima(), historial ? LECTURA_HISTORIAL : {})) });
  }
  const err = resultados.find((r) => !r.ok);
  return { ok: !err, error: err?.error, resultados };
}

export async function GET(req: NextRequest) {
  if (!esCronAutorizado(req)) return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
  try {
    return NextResponse.json(await sincronizarTodo(admin()));
  } catch (e: any) {
    console.error("[combustible/facturas]", e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "combustible");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  try {
    const body = await req.json().catch(() => ({}));
    const sb = admin();
    if (body.accion === "sincronizar") return NextResponse.json(await sincronizarTodo(sb, body.historial === true));
    if (body.accion === "registrar_historicas") {
      const { cuentas, sinMigracion } = await cargarCuentas(sb);
      if (sinMigracion) return NextResponse.json({ ok: false, error: "Falta correr supabase/combustible-03-saldo-cuenta-y-facturas.sql" });
      return NextResponse.json(await registrarHistoricas(sb, cuentas, hoyLima()));
    }
    if (body.accion === "reintentar_errores") {
      const { cuentas, sinMigracion } = await cargarCuentas(sb);
      if (sinMigracion) return NextResponse.json({ ok: false, error: "Falta correr supabase/combustible-03-saldo-cuenta-y-facturas.sql" });
      const desdeId = Number(body.desde_id);
      return NextResponse.json(await reintentarErrores(sb, cuentas, hoyLima(), { desdeId: Number.isFinite(desdeId) ? desdeId : 0 }));
    }
    if (body.accion === "desfase") {
      const { cuentas, sinMigracion } = await cargarCuentas(sb);
      if (sinMigracion) return NextResponse.json({ ok: false, error: "Falta correr supabase/combustible-03-saldo-cuenta-y-facturas.sql" });
      const out = [];
      for (const c of cuentas.filter((x) => x.activo)) {
        // Fresco: es lo que la persona va a mirar antes de decidir.
        const decision = await desfaseDeCuenta(sb, c, { fresco: true });
        const lista = await cargasPorMoverDeCuenta(sb, c, decision.dias);
        out.push({ cuenta_id: c.id, nombre: c.nombre, decision, por_mover: resumenMover(lista), lista: lista.slice(0, 300) });
      }
      return NextResponse.json({ ok: true, cuentas: out });
    }
    if (body.accion === "mover_a_despacho") {
      const ids: number[] = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
      const dias = Number(body.dias);
      if (!ids.length || !Number.isInteger(dias) || dias <= 0) {
        return NextResponse.json({ ok: false, error: "No se indicó qué cargas mover ni con qué desfase." }, { status: 400 });
      }
      const { cuentas } = await cargarCuentas(sb);
      return NextResponse.json(await moverCargasADespacho(sb, cuentas, ids, dias));
    }
    if (body.accion === "reconciliar") {
      const { cuentas, sinMigracion } = await cargarCuentas(sb);
      if (sinMigracion) return NextResponse.json({ ok: false, error: "Falta correr supabase/combustible-03-saldo-cuenta-y-facturas.sql" });
      // La cuenta de la factura (la misma resolución que «confirmar_linea»).
      const cuentaDe = (f: { cuenta_id?: number | string | null }) => cuentas.find((c) => c.id === Number(f.cuenta_id)) ?? cuentas[0] ?? null;
      return NextResponse.json({ ok: true, ...(await reconciliarPendientes(sb, cuentaDe, hoyLima(), { presupuestoMs: 45_000 })) });
    }
    if (body.accion === "deuda_prepago") return NextResponse.json(await prepagoComoDeuda(sb));
    if (body.accion === "marcar_prepago") {
      const ids: number[] = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
      if (!ids.length) return NextResponse.json({ ok: false, error: "No se indicó ningún comprobante." }, { status: 400 });
      const { cuentas } = await cargarCuentas(sb);
      return NextResponse.json(await marcarPrepagoPagadas(sb, ids, cuentas));
    }

    const id = Number(body.factura_id);
    const { data: fila } = await sb.from("radar_facturas").select("*").eq("id", id).maybeSingle();
    if (!fila) return NextResponse.json({ ok: false, error: "Factura no encontrada" }, { status: 404 });

    if (body.accion === "descartar") {
      await sb.from("radar_facturas").update({ estado: "descartada" }).eq("id", id);
      return NextResponse.json({ ok: true });
    }
    if (body.accion === "confirmar_linea") {
      const { cuentas } = await cargarCuentas(sb);
      const cuenta = cuentas.find((c) => c.id === Number(fila.cuenta_id)) ?? cuentas[0] ?? null;
      const r = await conciliarFacturaGuardada(sb, fila, cuenta, hoyLima(), {
        n: Number(body.n),
        placa: typeof body.placa === "string" ? body.placa : null,
        fecha: typeof body.fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.fecha) ? body.fecha : null,
      });
      if (r.error) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
      const linea = r.plan.find((p) => p.n === Number(body.n));
      return NextResponse.json({ ok: linea?.codigo === "registrar" || linea?.codigo === "ya_registrada", resultado: r, linea });
    }
    return NextResponse.json({ ok: false, error: "Acción desconocida" }, { status: 400 });
  } catch (e: any) {
    console.error("[combustible/facturas POST]", e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
