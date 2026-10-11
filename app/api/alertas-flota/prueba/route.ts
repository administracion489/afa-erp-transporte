// app/api/alertas-flota/prueba/route.ts
// «PROBAR LOS AVISOS»: manda a UN número los mismos WhatsApp que recibe un conductor que no
// pulsa INICIAR (y los del coordinador), con datos de ejemplo, en el orden en que llegan.
//
//   POST { telefono, ids: string[] } → { ok, telefono, resultados: [{ id, ok, error? }] }
//
// La lista, la plantilla y los parámetros se calculan AQUÍ con la configuración de la base
// (lib/escalera-muestra.ts, el mismo armado del motor). Del navegador solo se acepta qué
// mensajes mandar y a qué número: nunca el texto, o este endpoint serviría para mandar
// cualquier cosa desde el número de avisos.
//
// Cada mensaje de plantilla se cobra, así que hay freno ENTRE instancias (alerta_enviada):
// una prueba por minuto y un tope diario por usuario.
//
// Auth: usuario del ERP con el módulo «configuracion» (el de la pantalla de alertas).

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { enviarAvisoWhatsApp } from "@/lib/notificaciones";
import {
  adminAlertas, cargarMotor, directorioDe, hoyLima, reclamarEnvio, telefonoContingencia,
} from "@/lib/alertas";
import { datosDeMuestra, planDeMuestra, telefonoDeMuestra, type CfgMuestra } from "@/lib/escalera-muestra";

export const maxDuration = 60;

/** Clave del freno en `alerta_enviada` (ref = «usuario:minuto»). */
const CLAVE_FRENO = "prueba_avisos";
/** Pruebas por usuario y día. No medido: alcanza para probar, corregir y volver a probar. */
const MAX_PRUEBAS_DIA = 15;
/** Pausa entre mensajes: enviados de corrido pueden llegar desordenados al teléfono. */
const PAUSA_MS = 800;

const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "configuracion");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: { telefono?: unknown; ids?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 }); }

  const tel = telefonoDeMuestra(typeof body.telefono === "string" ? body.telefono : "");
  if (!tel.ok) return NextResponse.json({ error: tel.motivo }, { status: 400 });

  const pedidos = new Set(
    (Array.isArray(body.ids) ? body.ids : []).filter((x): x is string => typeof x === "string").slice(0, 20),
  );
  if (pedidos.size === 0) return NextResponse.json({ error: "Elige al menos un mensaje." }, { status: 400 });

  // ¿A QUÉ NÚMERO? Un administrador, a cualquier celular. Los demás, solo a uno del Directorio de
  // contactos: los mensajes salen del número de AVISOS, y si los reporta como spam alguien que no
  // los pidió, baja la calificación de ese número en Meta — el que lleva los avisos reales.
  if (auth.rol !== "admin") {
    const { data: dirs } = await adminAlertas.from("alerta_destinatarios").select("telefono").eq("activo", true);
    const permitidos = new Set(
      ((dirs ?? []) as { telefono?: string | null }[])
        .map((d) => telefonoDeMuestra(d.telefono))
        .flatMap((t) => (t.ok ? [t.e164] : [])),
    );
    if (!permitidos.has(tel.e164)) {
      return NextResponse.json({
        error: "Ese número no está en el Directorio de contactos. Agrégalo arriba (activo) o pide la prueba a un administrador.",
      }, { status: 403 });
    }
  }

  // ── Freno, entre instancias ──
  const hoy = hoyLima();
  const { count } = await adminAlertas
    .from("alerta_enviada").select("ref", { count: "exact", head: true })
    .eq("clave", CLAVE_FRENO).eq("fecha", hoy).like("ref", `${auth.userId}:%`);
  if ((count ?? 0) >= MAX_PRUEBAS_DIA) {
    return NextResponse.json({ error: `Ya hiciste ${MAX_PRUEBAS_DIA} pruebas hoy. Vuelve a intentarlo mañana.` }, { status: 429 });
  }
  const minuto = Math.floor(Date.now() / 60_000);
  if (!(await reclamarEnvio(CLAVE_FRENO, `${auth.userId}:${minuto}`, hoy))) {
    return NextResponse.json({ error: "Espera un minuto antes de volver a probar." }, { status: 429 });
  }

  try {
    const [{ configs, destinatarios }, telConting, perfil] = await Promise.all([
      cargarMotor(),
      telefonoContingencia(),
      adminAlertas.from("usuarios").select("nombre").eq("id", auth.userId).maybeSingle(),
    ]);
    const cfgs: CfgMuestra[] = [...configs.values()].map((c) => ({
      ...c,
      // Cuántos del directorio lo recibirían de verdad: la MISMA selección que el tick.
      contactos: directorioDe(c, destinatarios).length,
    }));
    const plan = planDeMuestra(cfgs, datosDeMuestra({
      nombreUsuario: (perfil.data as { nombre?: string | null } | null)?.nombre ?? null,
      fecha: hoy,
      telContingencia: telConting,
    }));
    const elegidos = plan.filter((m) => m.enviable && m.plantilla && pedidos.has(m.id));
    if (elegidos.length === 0) {
      return NextResponse.json({ error: "Ninguno de los mensajes elegidos tiene plantilla para enviar." }, { status: 400 });
    }

    const resultados: { id: string; ok: boolean; error?: string }[] = [];
    for (let i = 0; i < elegidos.length; i++) {
      const m = elegidos[i];
      const r = await enviarAvisoWhatsApp(tel.e164, m.plantilla!, m.parametros);
      resultados.push(r.ok ? { id: m.id, ok: true } : { id: m.id, ok: false, error: r.error || "No salió" });
      if (i < elegidos.length - 1) await pausa(PAUSA_MS);
    }
    console.info("[alertas-flota/prueba]", JSON.stringify({
      usuario: auth.userId, a: `…${tel.e164.slice(-3)}`,
      enviados: resultados.filter((r) => r.ok).length, fallidos: resultados.filter((r) => !r.ok).length,
    }));
    return NextResponse.json({ ok: true, telefono: tel.visible, resultados });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[alertas-flota/prueba]", msg);
    return NextResponse.json({ error: "No se pudo completar la prueba." }, { status: 500 });
  }
}
