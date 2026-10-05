// app/api/combustible/facturas/route.ts — Facturas de combustible por correo: el respaldo
// oficial del Radar IA (lib/combustible/facturas-correo.ts).
//
//   GET  (cron, Bearer CRON_SECRET)  → sincroniza el Gmail conectado en /crm y concilia.
//   POST (pantalla /combustible, módulo `combustible`):
//        { accion: "sincronizar" }
//        { accion: "confirmar_linea", factura_id, n, placa?, fecha? } → una persona confirma
//             una línea que quedó en «Revisar» (con la placa/fecha que ella eligió).
//        { accion: "descartar", factura_id }  → no es una factura de combustible.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { esCronAutorizado, verificarUsuarioApi } from "@/lib/api-auth";
import { hoyLima } from "@/lib/alertas";
import { cargarCuentas } from "@/lib/combustible/saldo-datos";
import { sincronizarFacturas, conciliarFacturaGuardada } from "@/lib/combustible/facturas-correo";

export const maxDuration = 300;

const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

async function sincronizarTodo(sb: any) {
  const { cuentas, sinMigracion } = await cargarCuentas(sb);
  if (sinMigracion) return { ok: false, error: "Falta correr supabase/combustible-03-saldo-cuenta-y-facturas.sql" };
  const activas = cuentas.filter((c) => c.activo);
  if (!activas.length) return { ok: true, resultados: [], aviso: "No hay cuentas de combustible activas." };
  const resultados = [];
  for (const c of activas) resultados.push({ cuenta: c.nombre, ...(await sincronizarFacturas(sb, c, hoyLima())) });
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
    if (body.accion === "sincronizar") return NextResponse.json(await sincronizarTodo(sb));

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
