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
    // Umbral de creación de OT: más ajustado que el de aviso (conf.umbral_km/dias
    // arriba), para que el correo avise con anticipación pero la orden de trabajo
    // real solo nazca cerca del vencimiento. Columnas nuevas: si el SQL de
    // mantenimiento-ot-automatica.sql no se corrió todavía, caen a estos defaults
    // y la OT automática simplemente no se activa (conf.ot_automatica_activa
    // vendrá undefined → false con el `?? false` de abajo).
    const umbralOtKm = Number(conf.umbral_ot_km ?? 100);
    const umbralOtDias = Number(conf.umbral_ot_dias ?? 2);
    const otAutomaticaActiva = conf.ot_automatica_activa ?? false;

    // Enrolamientos activos + datos del plan (intervalo por unidad manda sobre el
    // del plan — ver supabase/mantenimiento-programa-editable.sql; debe coincidir
    // con el cálculo de ProgramaTab).
    const { data: enrol } = await admin
      .from("vehiculos_plan")
      .select("vehiculo_id, km_base, fecha_base, intervalo_km_override, intervalo_meses_override, plan:planes_mantenimiento(id, marca, modelo, intervalo_base_km, intervalo_base_meses)")
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

    // Tareas de cada plan involucrado, para armar el checklist de las OT
    // automáticas (una consulta en lote, no una por vehículo).
    const planIds = [...new Set((enrol as any[]).map(e => {
      const p = Array.isArray(e.plan) ? e.plan[0] : e.plan;
      return p?.id;
    }).filter(Boolean))];
    const { data: tareasPlan } = planIds.length
      ? await admin.from("plan_tareas").select("plan_id, tarea, especificacion, categoria, cada_servicio, acciones").in("plan_id", planIds)
      : { data: [] as any[] };
    const tareasPorPlan: Record<string, any[]> = {};
    for (const t of (tareasPlan || [])) (tareasPorPlan[t.plan_id] ??= []).push(t);

    // OT automáticas ya abiertas hoy, para no duplicar (además del índice único
    // ux_ordenes_trabajo_auto_dedupe en la base, que es la red de seguridad real
    // ante corridas concurrentes del cron).
    const { data: otsAuto } = await admin
      .from("ordenes_trabajo")
      .select("vehiculo_id, km_apertura")
      .eq("origen", "automatica").in("estado", ["abierta", "en_proceso"]).in("vehiculo_id", vehIds);
    const otsAutoDedupe = new Set((otsAuto || []).map((o: any) => `${o.vehiculo_id}:${o.km_apertura}`));

    const alertas: Alerta[] = [];
    let otsCreadas = 0;

    for (const e of enrol as any[]) {
      const plan: any = Array.isArray(e.plan) ? e.plan[0] : e.plan;
      const v = vehMap[e.vehiculo_id];
      if (!plan || !v) continue;

      const um = ultMant[e.vehiculo_id];
      const baseFecha: string | null = um?.fecha ?? e.fecha_base ?? null;
      const kmActual = Number(v.kilometraje_actual ?? 0);
      const kmDia = kmPorDia(lectPorVeh[e.vehiculo_id] || []);

      // El intervalo por unidad (ajustado en Programa de Mantenimiento) manda
      // sobre el del plan — debe coincidir con ProgramaTab.tsx.
      const interKm = e.intervalo_km_override ?? plan.intervalo_base_km ?? null;
      const interMeses = e.intervalo_meses_override ?? plan.intervalo_base_meses ?? null;

      // Próximo servicio por KM = rejilla del fabricante (odómetro absoluto). Si hay
      // servicio preventivo registrado, se re-ancla a él (puede quedar vencido); si
      // no, se toma el siguiente hito MAYOR al km actual. (Debe coincidir con la
      // pestaña Próximos en ProgramaTab.)
      let dueKm: number | null = null, faltanKm: number | null = null, diasPorKm: number | null = null;
      const inter = Number(interKm || 0);
      if (inter > 0) {
        const ultServ = um?.kilometraje ?? null;
        dueKm = ultServ !== null
          ? Number(ultServ) + inter
          : (Math.floor(kmActual / inter) + 1) * inter;
        faltanKm = dueKm - kmActual;
        diasPorKm = kmDia && kmDia > 0 && faltanKm > 0 ? Math.round(faltanKm / kmDia) : null;
      }

      let dueFecha: string | null = null, faltanDias: number | null = null;
      if (interMeses && baseFecha) {
        dueFecha = addMeses(baseFecha, Number(interMeses));
        faltanDias = diasHasta(dueFecha);
      }

      const porKm = faltanKm !== null && faltanKm <= umbralKm;
      const porFecha = faltanDias !== null && faltanDias <= umbralDias;
      if (!porKm && !porFecha) continue;

      // ── OT automática: umbral más ajustado que el de aviso ──────────────────
      // No bloquea la asignación del servicio en Programación (eso vive aparte,
      // solo se muestra como badge informativo) ni excluye al vehículo de nada;
      // acá solo decide si además del correo se abre una orden de trabajo.
      const porOtKm = faltanKm !== null && faltanKm <= umbralOtKm;
      const porOtDias = faltanDias !== null && faltanDias <= umbralOtDias;
      let tieneOtAbierta = false;

      if (otAutomaticaActiva && dueKm !== null && (porOtKm || porOtDias)) {
        const dedupeKey = `${e.vehiculo_id}:${dueKm}`;
        if (otsAutoDedupe.has(dedupeKey)) {
          tieneOtAbierta = true;
        } else {
          try {
            // Convención del plan (ver PROMPT_PLAN en lib/vision-ia.ts): C = Cambio,
            // I = Inspección (y cambio si hace falta), R = cada servicio. La acción
            // queda en su propia columna (accion_plan/accion_final), no incrustada
            // en el texto del ítem — así se puede editar sin tocar la descripción.
            const tareasHito = (tareasPorPlan[plan.id] || [])
              .map((t: any) => {
                const entrada = Array.isArray(t.acciones) ? t.acciones.find((a: any) => Number(a.km) === dueKm) : null;
                const accion = entrada?.accion || (t.cada_servicio ? "R" : null);
                return { ...t, accion };
              })
              .filter((t: any) => t.accion);
            const motivoOt = porOtKm && porOtDias ? "km y fecha" : porOtKm ? "km" : "fecha";
            const { data: nuevaOt, error: errOt } = await admin.from("ordenes_trabajo").insert({
              vehiculo_id: e.vehiculo_id,
              plan_mantenimiento_id: plan.id,
              km_apertura: dueKm,
              fecha_apertura: hoy,
              fecha_limite_sugerida: dueFecha,
              estado: "abierta",
              origen: "automatica",
              observaciones: `Generada automáticamente: servicio preventivo por ${motivoOt} (plan ${plan.marca} ${plan.modelo}).`,
            }).select("id").single();
            if (errOt) throw errOt;
            if (nuevaOt && tareasHito.length) {
              await admin.from("checklist_ot").insert(tareasHito.map((t: any) => ({
                orden_trabajo_id: nuevaOt.id,
                item: t.especificacion ? `${t.tarea} — ${t.especificacion}` : t.tarea,
                categoria: t.categoria || "Otros",
                accion_plan: t.accion,
                accion_final: t.accion,
                completado: false,
              })));
            }
            otsAutoDedupe.add(dedupeKey);
            tieneOtAbierta = true;
            otsCreadas++;
          } catch (err: any) {
            // Columnas nuevas ausentes (SQL no corrido) u otro error puntual: no
            // debe tumbar el resto del cron ni el envío de correos.
            console.error("[mantenimiento/alertas] OT automática", v.placa, err?.message || err);
          }
        }
      }

      // El correo se suspende para lo que ya tiene una OT abierta rastreándolo —
      // sigue viéndose "Próximo/Vencido" en el ERP, solo deja de spamear.
      if (tieneOtAbierta) continue;

      alertas.push({
        placa: v.placa,
        modelo: `${plan.marca} ${plan.modelo}`.trim(),
        kmActual, dueKm, faltanKm, diasPorKm, dueFecha, faltanDias,
        motivo: porKm && porFecha ? "km y fecha" : porKm ? "km" : "fecha",
        vencido: (faltanKm !== null && faltanKm <= 0) || (faltanDias !== null && faltanDias <= 0),
      });
    }

    if (alertas.length === 0) {
      await admin.from("config_mantenimiento").update({ ultima_alerta_fecha: hoy }).eq("id", 1);
      return NextResponse.json({
        ok: true, alertas: 0, otsCreadas,
        mensaje: otsCreadas > 0 ? "Sin correos por enviar (todo lo próximo ya tiene OT abierta)" : "Sin mantenimientos próximos",
      });
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

    return NextResponse.json({ ok: true, alertas: alertas.length, enviados, otsCreadas, detalle: alertas });
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
