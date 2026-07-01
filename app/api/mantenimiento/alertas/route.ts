// app/api/mantenimiento/alertas/route.ts
// Vercel Cron diario: calcula, por cada vehículo enrolado a un plan, el próximo
// mantenimiento por KM y por FECHA (lo que ocurra primero) y, si está dentro del
// umbral, envía un correo resumen a los destinatarios configurados.
//
// Auth: Bearer CRON_SECRET. ?force=1 (con auth válido) ignora el dedupe diario
// y el flag alertas_activas (para pruebas manuales).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { enviarEmail } from "@/lib/notificaciones";
import { kmPorDia } from "@/lib/odometro";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function hoyLima(): string {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() - 5); // Lima = UTC-5
  return d.toISOString().split("T")[0];
}
function addMeses(fechaISO: string, meses: number): string {
  const d = new Date(fechaISO + "T00:00:00");
  d.setMonth(d.getMonth() + meses);
  return d.toISOString().split("T")[0];
}
function diasHasta(fechaISO: string): number {
  return Math.ceil(
    (new Date(fechaISO + "T00:00:00").getTime() - new Date(hoyLima() + "T00:00:00").getTime()) / 86400000
  );
}
const fmt = (n: number | null | undefined) =>
  n === null || n === undefined ? "—" : Number(n).toLocaleString("es-PE");

type Alerta = {
  placa: string; modelo: string; kmActual: number;
  dueKm: number | null; faltanKm: number | null; diasPorKm: number | null;
  dueFecha: string | null; faltanDias: number | null;
  motivo: string; vencido: boolean;
};

export async function GET(req: NextRequest) { return handler(req); }
export async function POST(req: NextRequest) { return handler(req); }

async function handler(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";

  try {
    const { data: cfg } = await admin.from("config_mantenimiento").select("*").eq("id", 1).maybeSingle();
    const conf = cfg || {};
    if (!conf.alertas_activas && !force) {
      return NextResponse.json({ ok: true, mensaje: "Alertas desactivadas" });
    }
    const hoy = hoyLima();
    if (conf.ultima_alerta_fecha === hoy && !force) {
      return NextResponse.json({ ok: true, mensaje: "Ya se envió el resumen hoy" });
    }

    const umbralKm = Number(conf.umbral_km ?? 500);
    const umbralDias = Number(conf.umbral_dias ?? 7);

    // Enrolamientos activos + datos del plan
    const { data: enrol } = await admin
      .from("vehiculos_plan")
      .select("vehiculo_id, km_base, fecha_base, plan:planes_mantenimiento(marca, modelo, intervalo_base_km, intervalo_base_meses)")
      .eq("activo", true);

    if (!enrol || enrol.length === 0) {
      return NextResponse.json({ ok: true, alertas: 0, mensaje: "Sin vehículos enrolados a un plan" });
    }

    const vehIds = [...new Set(enrol.map((e: any) => e.vehiculo_id))];

    const { data: vehs } = await admin
      .from("vehiculos").select("id, placa, categoria, kilometraje_actual").in("id", vehIds);
    const vehMap: Record<number, any> = Object.fromEntries((vehs || []).map((v: any) => [v.id, v]));

    // Último mantenimiento preventivo por vehículo (ancla de cálculo)
    const { data: mants } = await admin
      .from("mantenimiento")
      .select("vehiculo_id, fecha, kilometraje, tipo")
      .in("vehiculo_id", vehIds).eq("tipo", "preventivo")
      .order("fecha", { ascending: false });
    const ultMant: Record<number, any> = {};
    for (const m of (mants || [])) if (!ultMant[m.vehiculo_id]) ultMant[m.vehiculo_id] = m;

    // Lecturas recientes para estimar km/día
    const desde = addMeses(hoy, -4);
    const { data: lect } = await admin
      .from("lecturas_odometro")
      .select("vehiculo_id, km, fecha")
      .eq("estado", "aceptada").gte("fecha", desde).in("vehiculo_id", vehIds);
    const lectPorVeh: Record<number, { km: number; fecha: string }[]> = {};
    for (const l of (lect || [])) (lectPorVeh[l.vehiculo_id] ??= []).push(l);

    const alertas: Alerta[] = [];

    for (const e of enrol as any[]) {
      const plan: any = Array.isArray(e.plan) ? e.plan[0] : e.plan;
      const v = vehMap[e.vehiculo_id];
      if (!plan || !v) continue;

      const um = ultMant[e.vehiculo_id];
      const baseFecha: string | null = um?.fecha ?? e.fecha_base ?? null;
      const kmActual = Number(v.kilometraje_actual ?? 0);
      const kmDia = kmPorDia(lectPorVeh[e.vehiculo_id] || []);

      // Próximo servicio por KM = rejilla del fabricante (odómetro absoluto). Si hay
      // servicio preventivo registrado, se re-ancla a él (puede quedar vencido); si
      // no, se toma el siguiente hito MAYOR al km actual. (Debe coincidir con la
      // pestaña Próximos en ProgramaTab.)
      let dueKm: number | null = null, faltanKm: number | null = null, diasPorKm: number | null = null;
      const inter = Number(plan.intervalo_base_km || 0);
      if (inter > 0) {
        const ultServ = um?.kilometraje ?? null;
        dueKm = ultServ !== null
          ? Number(ultServ) + inter
          : (Math.floor(kmActual / inter) + 1) * inter;
        faltanKm = dueKm - kmActual;
        diasPorKm = kmDia && kmDia > 0 && faltanKm > 0 ? Math.round(faltanKm / kmDia) : null;
      }

      let dueFecha: string | null = null, faltanDias: number | null = null;
      if (plan.intervalo_base_meses && baseFecha) {
        dueFecha = addMeses(baseFecha, Number(plan.intervalo_base_meses));
        faltanDias = diasHasta(dueFecha);
      }

      const porKm = faltanKm !== null && faltanKm <= umbralKm;
      const porFecha = faltanDias !== null && faltanDias <= umbralDias;

      if (porKm || porFecha) {
        alertas.push({
          placa: v.placa,
          modelo: `${plan.marca} ${plan.modelo}`.trim(),
          kmActual, dueKm, faltanKm, diasPorKm, dueFecha, faltanDias,
          motivo: porKm && porFecha ? "km y fecha" : porKm ? "km" : "fecha",
          vencido: (faltanKm !== null && faltanKm <= 0) || (faltanDias !== null && faltanDias <= 0),
        });
      }
    }

    if (alertas.length === 0) {
      await admin.from("config_mantenimiento").update({ ultima_alerta_fecha: hoy }).eq("id", 1);
      return NextResponse.json({ ok: true, alertas: 0, mensaje: "Sin mantenimientos próximos" });
    }

    // Orden: vencidos primero, luego por los que menos falta
    alertas.sort((a, b) =>
      (Number(b.vencido) - Number(a.vencido)) ||
      ((a.faltanDias ?? a.diasPorKm ?? 9999) - (b.faltanDias ?? b.diasPorKm ?? 9999))
    );

    const correos = String(conf.correos_alerta || "")
      .split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);

    let enviados = 0;
    if (correos.length && process.env.RESEND_API_KEY) {
      const html = htmlAlertas(alertas, hoy);
      const subject = `🔧 ${alertas.length} mantenimiento(s) por atender — AFA Transportes`;
      for (const to of correos) {
        try { await enviarEmail({ to, subject, html }); enviados++; }
        catch (err) { console.error("[alertas mant] envío", to, err); }
      }
    }

    await admin.from("config_mantenimiento").update({ ultima_alerta_fecha: hoy }).eq("id", 1);

    return NextResponse.json({ ok: true, alertas: alertas.length, enviados, detalle: alertas });
  } catch (error: any) {
    console.error("[mantenimiento/alertas]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

function htmlAlertas(alertas: Alerta[], hoy: string): string {
  const filas = alertas.map(a => {
    const km = a.faltanKm !== null
      ? (a.faltanKm <= 0 ? `<b style="color:#991b1b;">Vencido (${fmt(-a.faltanKm)} km)</b>` : `Faltan ${fmt(a.faltanKm)} km${a.diasPorKm !== null ? ` (~${a.diasPorKm}d)` : ""}`)
      : "—";
    const fe = a.faltanDias !== null
      ? (a.faltanDias <= 0 ? `<b style="color:#991b1b;">Vencido (${-a.faltanDias}d)</b>` : `En ${a.faltanDias} día(s)`)
      : "—";
    const bg = a.vencido ? "#fee2e2" : "#fffbeb";
    return `<tr style="background:${bg};">
      <td style="padding:8px 10px;font-weight:700;font-family:monospace;color:#0b315f;border-bottom:1px solid #e5e7eb;">${a.placa}</td>
      <td style="padding:8px 10px;color:#374151;border-bottom:1px solid #e5e7eb;">${a.modelo}</td>
      <td style="padding:8px 10px;font-family:monospace;color:#374151;border-bottom:1px solid #e5e7eb;">${fmt(a.kmActual)}</td>
      <td style="padding:8px 10px;font-size:12px;color:#374151;border-bottom:1px solid #e5e7eb;">${km}</td>
      <td style="padding:8px 10px;font-size:12px;color:#374151;border-bottom:1px solid #e5e7eb;">${fe}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#eef2f7;margin:0;padding:24px 16px;">
<div style="max-width:640px;margin:0 auto;">
  <div style="background:#0b315f;border-radius:16px 16px 0 0;padding:24px;text-align:center;">
    <h1 style="color:white;margin:0;font-size:20px;font-weight:700;">🔧 Mantenimientos por atender</h1>
    <p style="color:#93c5fd;margin:6px 0 0;font-size:12px;">Reporte del ${new Date(hoy + "T00:00:00").toLocaleDateString("es-PE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}</p>
  </div>
  <div style="background:white;padding:24px;border-radius:0 0 16px 16px;">
    <p style="color:#475569;font-size:14px;margin:0 0 16px;">${alertas.length} unidad(es) alcanzan su mantenimiento preventivo (por kilometraje o por tiempo, lo que ocurra primero):</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr style="background:#f1f5f9;">
        <th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;">Placa</th>
        <th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;">Modelo</th>
        <th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;">Km actual</th>
        <th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;">Por km</th>
        <th style="padding:8px 10px;text-align:left;color:#64748b;font-size:11px;text-transform:uppercase;">Por fecha</th>
      </tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <p style="color:#94a3b8;font-size:11px;margin:18px 0 0;">Mensaje automático de AFA ERP · Mantenimiento Preventivo · No responder</p>
  </div>
</div></body></html>`;
}
