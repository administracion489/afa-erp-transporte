// app/api/combustible/saldo/route.ts — Aviso de saldo bajo de la cuenta de combustible.
//
//   GET  (cron cada hora, Bearer CRON_SECRET) → calcula el saldo de cada cuenta activa y
//        avisa por correo y WhatsApp cuando cruza un escalón (lib/combustible/saldo-cuenta.ts).
//   POST (pantalla /combustible, módulo `combustible`):
//        { accion: "comprobar" }               → lo mismo que el cron, ahora.
//        { accion: "prueba", cuenta_id }       → manda el aviso con el saldo de hoy aunque no
//                                                toque, rotulado PRUEBA, para comprobar canales.
//
// UN AVISO POR ESCALÓN Y POR CICLO: `ultimo_umbral_avisado` se RECLAMA con un UPDATE
// condicional antes de enviar (dos ticks a la vez no mandan dos correos) y se DEVUELVE si
// todos los canales fallaron, para que el próximo tick reintente. Mismo papel que
// reclamarEnvio/liberarEnvio del motor de alertas.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { esCronAutorizado, verificarUsuarioApi } from "@/lib/api-auth";
import { enviarEmail, enviarAvisoWhatsApp } from "@/lib/notificaciones";
import { hoyLima } from "@/lib/alertas";
import { escHtml } from "@/lib/html-escape";
import { decidirAviso, textoAviso, fraseExcluidas, type SaldoCuenta } from "@/lib/combustible/saldo-cuenta";
import {
  cargarCuentas, estadoDeCuentas, correosDeTexto, telefonosDeTexto, type FilaCuenta,
} from "@/lib/combustible/saldo-datos";

export const maxDuration = 60;

const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

type Envio = { correos: number; whatsapp: number; fallos: string[]; sinCanal: boolean };

async function enviarAviso(cuenta: FilaCuenta, saldo: SaldoCuenta, escalon: number, prueba: boolean): Promise<Envio> {
  const { titulo, detalle } = textoAviso(cuenta, saldo, escalon);
  const t = prueba ? `[PRUEBA] ${titulo}` : titulo;
  const correos = correosDeTexto(cuenta.avisar_correos);
  const telefonos = telefonosDeTexto(cuenta.avisar_telefonos);
  const r: Envio = { correos: 0, whatsapp: 0, fallos: [], sinCanal: !correos.length && !telefonos.length };

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px">
      <h2 style="color:${escalon === 0 ? "#b91c1c" : "#b45309"};margin:0 0 8px">${escHtml(t)}</h2>
      <p style="font-size:15px;line-height:1.5;color:#111">${escHtml(detalle)}</p>
      <table style="font-size:13px;color:#374151;border-collapse:collapse;margin-top:8px">
        <tr><td style="padding:2px 12px 2px 0">Último saldo leído del portal</td><td><b>S/ ${escHtml(saldo.ancla?.monto.toFixed(2) ?? "—")}</b> (${escHtml(saldo.ancla?.fecha ?? "—")})</td></tr>
        <tr><td style="padding:2px 12px 2px 0">+ Abonos posteriores</td><td>S/ ${saldo.abonos.toFixed(2)}</td></tr>
        <tr><td style="padding:2px 12px 2px 0">− Cargas de unidades propias</td><td>S/ ${saldo.consumido.toFixed(2)} (${saldo.nCargas})</td></tr>
        <tr><td style="padding:2px 12px 2px 0">− Del Radar, propias sin confirmar</td><td>S/ ${saldo.porConfirmar.toFixed(2)} (${saldo.nPorConfirmar})</td></tr>
      </table>
      ${fraseExcluidas(saldo) ? `<p style="font-size:12px;color:#6b7280;margin-top:8px">${escHtml(fraseExcluidas(saldo)!)} Solo descuentan las unidades propias.</p>` : ""}
      <p style="font-size:12px;color:#6b7280;margin-top:12px">Es un saldo ESTIMADO por el ERP. Cuando recargues, registra el abono en /combustible; si el portal dice otra cifra, actualiza el saldo leído y el ERP cuenta desde ahí.</p>
    </div>`;
  for (const to of correos) {
    try { await enviarEmail({ to, subject: t, html }); r.correos++; }
    catch (e: any) { r.fallos.push(`${to}: ${e.message}`); }
  }
  // Plantilla genérica `coordinador_alerta` (la misma de las alertas operativas): no
  // requiere aprobar una plantilla nueva en Meta. {{1}} título · {{2}} sujeto · {{3}} referencia · {{4}} detalle.
  const params = [
    prueba ? "PRUEBA saldo combustible" : escalon === 0 ? "Saldo combustible AGOTADO" : "Saldo combustible bajo",
    cuenta.nombre,
    `S/ ${(saldo.saldo ?? 0).toFixed(2)}`,
    detalle,
  ];
  for (const tel of telefonos) {
    const w = await enviarAvisoWhatsApp(tel, "coordinador_alerta", params);
    if (w.ok) r.whatsapp++; else r.fallos.push(`${tel}: ${w.error}`);
  }
  return r;
}

async function tick(sb: any) {
  const hoy = hoyLima();
  const { cuentas, sinMigracion } = await cargarCuentas(sb);
  if (sinMigracion) return { ok: true, sin_migracion: "supabase/combustible-03-saldo-cuenta-y-facturas.sql" };
  const estados = await estadoDeCuentas(sb, cuentas.filter((c) => c.activo), hoy);
  const resultados: any[] = [];
  for (const e of estados) {
    const { cuenta, saldo } = e;
    const d = decidirAviso(saldo.saldo, cuenta.umbrales, cuenta.ultimo_umbral_avisado);
    const fila: any = { cuenta: cuenta.nombre, saldo: saldo.saldo, codigo: d.codigo };
    if (d.codigo === "rearmado") {
      await sb.from("combustible_cuentas").update({ ultimo_umbral_avisado: null }).eq("id", cuenta.id);
    }
    if (d.avisar != null) {
      // Reclamo: solo avanza si nadie lo movió desde que se leyó.
      let q = sb.from("combustible_cuentas")
        .update({ ultimo_umbral_avisado: d.nuevoUltimo, ultimo_aviso_en: new Date().toISOString() })
        .eq("id", cuenta.id);
      q = cuenta.ultimo_umbral_avisado == null ? q.is("ultimo_umbral_avisado", null) : q.eq("ultimo_umbral_avisado", cuenta.ultimo_umbral_avisado);
      const { data: reclamado } = await q.select("id");
      if (!((reclamado as any[]) ?? []).length) { fila.codigo = "ya_avisado"; resultados.push(fila); continue; }

      const env = await enviarAviso(cuenta, saldo, d.avisar, false);
      fila.envio = env;
      // Todo falló (y había a quién mandar) → se devuelve el reclamo para reintentar.
      if (!env.sinCanal && env.correos + env.whatsapp === 0) {
        await sb.from("combustible_cuentas")
          .update({ ultimo_umbral_avisado: cuenta.ultimo_umbral_avisado })
          .eq("id", cuenta.id);
      }
    }
    resultados.push(fila);
  }
  return { ok: true, hoy, resultados };
}

export async function GET(req: NextRequest) {
  if (!esCronAutorizado(req)) return NextResponse.json({ ok: false, error: "No autorizado" }, { status: 401 });
  try {
    return NextResponse.json(await tick(admin()));
  } catch (e: any) {
    console.error("[combustible/saldo]", e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "combustible");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  try {
    const body = await req.json().catch(() => ({}));
    const sb = admin();
    if (body.accion === "prueba") {
      const { cuentas } = await cargarCuentas(sb);
      const cuenta = cuentas.find((c) => c.id === Number(body.cuenta_id));
      if (!cuenta) return NextResponse.json({ ok: false, error: "Cuenta no encontrada" }, { status: 404 });
      const [e] = await estadoDeCuentas(sb, [cuenta], hoyLima());
      if (e.saldo.saldo == null) {
        return NextResponse.json({ ok: false, error: "Primero registra el saldo que dice el portal (sin él no hay saldo que avisar)." }, { status: 400 });
      }
      const env = await enviarAviso(cuenta, e.saldo, cuenta.umbrales[cuenta.umbrales.length - 1] ?? 0, true);
      if (env.sinCanal) return NextResponse.json({ ok: false, error: "No hay correos ni teléfonos configurados en la cuenta." }, { status: 400 });
      return NextResponse.json({ ok: true, envio: env });
    }
    return NextResponse.json(await tick(sb));
  } catch (e: any) {
    console.error("[combustible/saldo POST]", e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
