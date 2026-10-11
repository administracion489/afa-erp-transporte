// app/api/llamadas/central/route.ts
// LA PUERTA DE LA CENTRAL DE LLAMADAS PROPIA. La central (un Asterisk con un gateway celular, o
// un Android con un chip) pregunta aquí cada pocos segundos si hay a quién llamar, marca, y
// devuelve lo que pasó. El ERP decide a quién y cuándo (lib/llamadas-central.ts); la central solo
// marca. Contrato completo en docs/central-llamadas.md.
//
//   POST { accion: "latido",    equipo?, version?, detalle? }      → { ok }
//   POST { accion: "tomar",     equipo?, version? }                → { ok, llamada: {...} | null }
//   POST { accion: "resultado", id, estado, duracion_seg?, opcion?, detalle? } → { ok, estado }
//
// Auth: `Authorization: Bearer <CENTRAL_LLAMADAS_SECRET>`, comparado en tiempo constante y en
// modo FAIL-CLOSED (sin la variable, nadie pasa). Es un secreto PROPIO y no el CRON_SECRET: la
// central vive fuera de Vercel, y si se filtra su secreto se cambia sin tocar los crons.

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { cargarMotor, directorioDe } from "@/lib/alertas";
import { enviarAvisoWhatsApp } from "@/lib/notificaciones";
import { sinIniciar } from "@/lib/escalera-inicio";
import { CLAVE_LLAMADA, leerResultado, planTrasResultado } from "@/lib/llamadas-central";
import { adminLlamadas as admin, limpiarCola } from "@/lib/llamadas-central-datos";
import { tablaFaltante } from "@/lib/columna-faltante";

export const maxDuration = 30;

function centralAutorizada(req: NextRequest): boolean {
  const secreto = process.env.CENTRAL_LLAMADAS_SECRET ?? "";
  // Un secreto corto se adivina: por debajo de 24 caracteres se trata como no configurado.
  if (secreto.length < 24) return false;
  const h = req.headers.get("authorization") ?? "";
  const dado = Buffer.from(h.startsWith("Bearer ") ? h.slice(7) : "");
  const esperado = Buffer.from(secreto);
  return dado.length === esperado.length && timingSafeEqual(dado, esperado);
}

/** Texto corto e imprimible (lo que la central declara de sí misma). */
function texto(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = Array.from(v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim()).slice(0, max).join("");
  return s || null;
}

type Fila = {
  id: number; reserva_id: number | null; telefono: string; mensaje: string; menu: string | null;
  datos: Record<string, unknown> | null; intentos: number; max_intentos: number | null;
  estado: string; vence_en: string | null;
};

export async function POST(req: NextRequest) {
  if (!centralAutorizada(req)) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  let crudo: unknown;
  try { crudo = await req.json(); } catch { return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 }); }
  if (!crudo || typeof crudo !== "object" || Array.isArray(crudo)) {
    return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 });
  }
  const body = crudo as Record<string, unknown>;
  const accion = String(body.accion ?? "");
  const equipo = texto(body.equipo, 60);
  const ahoraMs = Date.now();
  const ahora = new Date(ahoraMs).toISOString();

  try {
    if (accion === "latido" || accion === "tomar") {
      const { error } = await admin.from("central_llamadas_estado").upsert({
        id: 1, ultimo_latido: ahora, equipo, version: texto(body.version, 30),
        detalle: texto(body.detalle, 200), updated_at: ahora,
      }, { onConflict: "id" });
      if (error && tablaFaltante(error)) {
        return NextResponse.json({ ok: false, error: "Falta correr supabase/llamadas-01-central.sql" }, { status: 503 });
      }
      if (accion === "latido") return NextResponse.json({ ok: true });

      // ── tomar ──
      await limpiarCola(ahoraMs);
      // Primero las REALES y después las de prueba: con una central de una sola línea, una cola
      // de pruebas no puede dejar atrás la llamada a un conductor (su ventana es corta).
      const candidatas = async (dePrueba: boolean) => {
        let q = admin.from("llamadas_conductor")
          .select("id, reserva_id, telefono, mensaje, menu, datos, intentos, max_intentos, estado, vence_en")
          .eq("estado", "pendiente").lte("proximo_intento_en", ahora).gt("vence_en", ahora);
        q = dePrueba ? q.eq("motivo", "prueba") : q.neq("motivo", "prueba");
        const { data, error } = await q.order("proximo_intento_en", { ascending: true }).order("id", { ascending: true }).limit(5);
        if (error) throw new Error(error.message);
        return (data ?? []) as Fila[];
      };
      const reales = await candidatas(false);
      const cands = reales.length > 0 ? reales : await candidatas(true);
      for (const c of cands) {
        // ANTES DE MARCAR SE VUELVE A MIRAR: si el servicio ya se inició, no se llama.
        if (c.reserva_id != null) {
          const { data: r } = await admin.from("reservas").select("estado").eq("id", c.reserva_id).maybeSingle();
          if (!r || !sinIniciar((r as { estado?: string }).estado)) {
            await admin.from("llamadas_conductor")
              .update({ estado: "cancelada", terminada_en: ahora, detalle: r ? "el servicio ya se inició" : "el servicio ya no existe" })
              .eq("id", c.id).eq("estado", "pendiente");
            continue;
          }
        }
        // Reclamo optimista: dos centrales (o dos preguntas seguidas) no toman la misma llamada.
        const { data: tomada } = await admin.from("llamadas_conductor")
          .update({ estado: "marcando", tomada_en: ahora, intentos: c.intentos + 1, central: equipo })
          .eq("id", c.id).eq("estado", "pendiente").eq("intentos", c.intentos)
          .select("id").maybeSingle();
        if (!tomada) continue;
        // Solo lo que la central necesita para llamar: ni el nombre completo ni la ruta.
        return NextResponse.json({
          ok: true,
          llamada: {
            id: c.id, telefono: c.telefono, mensaje: c.mensaje, menu: c.menu,
            intento: c.intentos + 1, max_intentos: c.max_intentos,
          },
        });
      }
      return NextResponse.json({ ok: true, llamada: null });
    }

    if (accion === "resultado") {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "id inválido" }, { status: 400 });
      const v = leerResultado(body);
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

      const { data: f } = await admin.from("llamadas_conductor")
        .select("id, reserva_id, telefono, mensaje, menu, datos, intentos, max_intentos, estado, vence_en")
        .eq("id", id).maybeSingle();
      const fila = f as Fila | null;
      if (!fila) return NextResponse.json({ error: "Esa llamada no existe" }, { status: 404 });
      if (fila.estado !== "marcando") return NextResponse.json({ ok: false, error: "Esa llamada no está en curso" }, { status: 409 });
      // Un resultado ATRASADO (el del intento 1 que llegó cuando ya se marca el 2) no cierra nada.
      if (fila.intentos !== v.resultado.intento) {
        return NextResponse.json({ ok: false, error: "Ese resultado es de otro intento" }, { status: 409 });
      }

      let sigue = true;
      if (fila.reserva_id != null) {
        const { data: r } = await admin.from("reservas").select("estado").eq("id", fila.reserva_id).maybeSingle();
        sigue = !!r && sinIniciar((r as { estado?: string }).estado);
      }
      const plan = planTrasResultado(fila, v.resultado.estado, ahoraMs, sigue);
      const final = plan.estado !== "pendiente";
      const { data: hecho } = await admin.from("llamadas_conductor").update({
        estado: plan.estado,
        duracion_seg: v.resultado.duracion_seg,
        opcion: v.resultado.opcion,
        detalle: v.resultado.detalle,
        terminada_en: final ? ahora : null,
        ...(plan.proximoIntentoMs ? { proximo_intento_en: new Date(plan.proximoIntentoMs).toISOString() } : {}),
      }).eq("id", id).eq("estado", "marcando").eq("intentos", v.resultado.intento).select("id").maybeSingle();
      if (!hecho) return NextResponse.json({ ok: false, error: "Esa llamada no está en curso" }, { status: 409 });

      // Marcó 2: quiere hablar con el coordinador. Se le avisa a quien la tarjeta diga.
      if (v.resultado.opcion === "2" && fila.reserva_id != null) after(() => avisarCoordinador(fila));
      return NextResponse.json({ ok: true, estado: plan.estado });
    }

    return NextResponse.json({ error: "accion inválida (latido, tomar, resultado)" }, { status: 400 });
  } catch (e) {
    console.error("[llamadas/central]", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: "Error interno" }, { status: 500 });
  }
}

/** WhatsApp a los contactos de la tarjeta «Llamada: aún no inicia» cuando el conductor marca 2. */
async function avisarCoordinador(f: Fila): Promise<void> {
  try {
    const { configs, destinatarios } = await cargarMotor();
    const cfg = configs.get(CLAVE_LLAMADA);
    if (!cfg) return;
    const d = (f.datos ?? {}) as { nombre?: string | null; hora?: string | null; origen?: string | null; destino?: string | null };
    const nombre = String(d.nombre ?? "").trim().split(/\s+/).slice(0, 2).join(" ") || "Conductor";
    const ruta = Array.from([d.origen, d.destino].filter(Boolean).join(" → ") || "Servicio").slice(0, 120).join("");
    const tel = f.telefono.replace(/^\+51(\d{3})(\d{3})(\d{3})$/, "+51 $1 $2 $3");
    for (const c of directorioDe(cfg, destinatarios)) {
      await enviarAvisoWhatsApp(c.telefono, cfg.plantilla_directorio || "coordinador_alerta", [
        "Conductor pide hablar", nombre, `${ruta} ${d.hora ?? ""}`.trim(),
        `Contestó la llamada de la central y marcó 2: quiere hablar contigo. Llámalo al ${tel}.`,
      ]);
    }
  } catch (e) {
    console.warn("[llamadas/central] aviso al coordinador:", e instanceof Error ? e.message : e);
  }
}
