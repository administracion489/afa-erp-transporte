// ============================================================
// /api/elia/config — Configuración y consumo de ELIA (solo admin).
// GET: configuración + gasto del mes + desglose por usuario.
// POST: guarda { activa, modelo, limite_mensual_usd, aviso_pct }.
// ============================================================
import { NextResponse } from "next/server";
import { autenticarElia } from "@/lib/elia/auth";
import { fechaLima } from "@/lib/elia/herramientas";
import { cargarConfigElia, MODELOS_ELIA, PRECIOS_MODELO } from "@/lib/elia/config";

export const maxDuration = 30;

export async function GET(request: Request) {
  const auth = await autenticarElia(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (auth.usuario.rol !== "admin")
    return NextResponse.json({ error: "Solo un administrador puede ver la configuración de ELIA" }, { status: 403 });

  const sb = auth.usuario.sb;
  const config = await cargarConfigElia(sb);

  // Desglose del mes por usuario (hasta 10k filas, suficiente de sobra)
  let porUsuario: { usuario: string; mensajes: number; costo: number }[] = [];
  let ultimos: any[] = [];
  if (config.ok) {
    try {
      const mes = fechaLima().slice(0, 7);
      const filas: any[] = [];
      for (let p = 0; p < 10; p++) {
        const { data } = await sb
          .from("elia_uso")
          .select("usuario_nombre, costo_usd, modelo, herramientas, created_at")
          .eq("mes", mes)
          .order("created_at", { ascending: false })
          .range(p * 1000, p * 1000 + 999);
        const lote = (data as any[]) ?? [];
        filas.push(...lote);
        if (lote.length < 1000) break;
      }
      const acc: Record<string, { mensajes: number; costo: number }> = {};
      for (const f of filas) {
        const u = f.usuario_nombre || "(desconocido)";
        const a = (acc[u] ||= { mensajes: 0, costo: 0 });
        a.mensajes++;
        a.costo += Number(f.costo_usd || 0);
      }
      porUsuario = Object.entries(acc)
        .map(([usuario, a]) => ({ usuario, mensajes: a.mensajes, costo: Math.round(a.costo * 100) / 100 }))
        .sort((x, y) => y.costo - x.costo);
      ultimos = filas.slice(0, 8).map((f) => ({
        usuario: f.usuario_nombre,
        modelo: f.modelo,
        herramientas: f.herramientas,
        costo: Number(f.costo_usd || 0),
        fecha: f.created_at,
      }));
    } catch {}
  }

  return NextResponse.json({
    ok: true,
    faltaSql: !config.ok,
    config: {
      activa: config.activa,
      modelo: config.modelo,
      limite_mensual_usd: config.limiteMensualUsd,
      aviso_pct: config.avisoPct,
    },
    uso: {
      mes: config.mes,
      gasto: Math.round(config.gastoMes * 100) / 100,
      mensajes: config.mensajesMes,
      por_usuario: porUsuario,
      ultimos,
    },
    modelos: Object.entries(PRECIOS_MODELO).map(([id, p]) => ({
      id,
      etiqueta: p.etiqueta,
      precio_entrada: p.entrada,
      precio_salida: p.salida,
    })),
  });
}

export async function POST(request: Request) {
  const auth = await autenticarElia(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (auth.usuario.rol !== "admin")
    return NextResponse.json({ error: "Solo un administrador puede configurar a ELIA" }, { status: 403 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 });
  }

  const modelo = MODELOS_ELIA.includes(body.modelo) ? body.modelo : null;
  const limite = Number(body.limite_mensual_usd);
  const aviso = Number(body.aviso_pct);
  if (!modelo) return NextResponse.json({ error: "Modelo no válido" }, { status: 400 });
  if (!Number.isFinite(limite) || limite < 0 || limite > 100000)
    return NextResponse.json({ error: "Límite mensual no válido (0 = sin límite, máx 100000)" }, { status: 400 });
  if (!Number.isFinite(aviso) || aviso < 10 || aviso > 100)
    return NextResponse.json({ error: "El aviso debe estar entre 10% y 100%" }, { status: 400 });

  const { error } = await auth.usuario.sb.from("elia_config").upsert({
    id: 1,
    activa: body.activa !== false,
    modelo,
    limite_mensual_usd: limite,
    aviso_pct: Math.round(aviso),
    actualizado_at: new Date().toISOString(),
    actualizado_por: auth.usuario.usuarioId,
  });
  if (error)
    return NextResponse.json(
      { error: "No pude guardar. ¿Ya ejecutaste supabase/elia-config.sql en Supabase? (" + error.message + ")" },
      { status: 500 }
    );

  return NextResponse.json({ ok: true, mensaje: "Configuración guardada" });
}
