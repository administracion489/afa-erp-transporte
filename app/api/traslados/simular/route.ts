// app/api/traslados/simular/route.ts
// POST — El cotizador automático de traslados SIN enviar nada: ubica origen y destino (Google,
// con caché), decide si el pedido es simple, el vehículo y el precio (lib/traslados/motor.ts).
// Lo usa el Simulador de /tarifario → Zonas y traslados. Es la misma función que usará la IA
// del CRM (lib/traslados/servicio.ts): lo que se prueba aquí es lo que la IA va a cotizar.
//
// Solo usuarios del ERP con el módulo «tarifas» (el simulador vive en esa pantalla). Cada
// simulación puede costar hasta 4 consultas de Geocoding (2 directas + 2 inversas) si no están
// en caché: tope de 30 por minuto por usuario, en memoria de la instancia.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { guardarGasto, limitarTasa, segundosParaReintentar } from "@/lib/api-guard";
import { validarEntrada } from "@/lib/traslados/api";
import { simularTraslado } from "@/lib/traslados/servicio";
import { fechaLima } from "@/lib/alertas-horario";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const LIMITE_POR_MINUTO = 30;

export async function POST(req: NextRequest) {
  const bloqueo = guardarGasto(req, { etiqueta: "traslados-simular" });
  if (bloqueo) return bloqueo;
  const auth = await verificarUsuarioApi(req, "tarifas");
  if (!auth.ok) return NextResponse.json({ ok: false, codigo: "error", detalle: auth.error }, { status: auth.status });

  const clave = `traslados-simular:${auth.userId}`;
  if (!limitarTasa(clave, LIMITE_POR_MINUTO, 60_000)) {
    const s = segundosParaReintentar(clave);
    return NextResponse.json(
      { ok: false, codigo: "error", detalle: `Demasiadas simulaciones seguidas: espera ${s} s.` },
      { status: 429, headers: { "Retry-After": String(s) } },
    );
  }

  let cuerpo: unknown;
  try { cuerpo = await req.json(); } catch { cuerpo = null; }
  const v = validarEntrada(cuerpo);
  if (!v.ok) return NextResponse.json({ ok: false, codigo: "entrada_invalida", detalle: v.detalle }, { status: 400 });

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  try {
    const r = await simularTraslado(sb, v.entrada, fechaLima(Date.now()));
    return NextResponse.json(r);
  } catch (e) {
    console.error("[traslados/simular]", (e as Error)?.message);
    return NextResponse.json({ ok: false, codigo: "error", detalle: "No se pudo simular el traslado." }, { status: 500 });
  }
}
