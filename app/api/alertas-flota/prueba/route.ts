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
import { SQL_LLAMADAS, datosDeMuestra, planDeMuestra, telefonoDeMuestra, type CfgMuestra } from "@/lib/escalera-muestra";
import { estadoCentral } from "@/lib/llamadas-central";
import { encolarLlamada } from "@/lib/llamadas-central-datos";

export const maxDuration = 60;

/** Clave del freno en `alerta_enviada` (ref = «usuario:minuto»). */
const CLAVE_FRENO = "prueba_avisos";
/** Pruebas por usuario y día. No medido: alcanza para probar, corregir y volver a probar. */
const MAX_PRUEBAS_DIA = 15;
/** Pausa entre mensajes: enviados de corrido pueden llegar desordenados al teléfono. */
const PAUSA_MS = 800;
/** La llamada de prueba vence a los 10 min: si la central no la toma, no sale nunca. */
const VENCE_LLAMADA_PRUEBA_MIN = 10;
/** Llamadas de prueba por administrador y día. No medido: alcanza para probar la central. */
const MAX_LLAMADAS_PRUEBA_DIA = 5;

/**
 * ¿Puede este usuario pedir una llamada de prueba ahora? Solo un ADMINISTRADOR (una llamada suena
 * a cualquier hora en el teléfono de otra persona: no es un WhatsApp que se lee cuando se quiere),
 * una a la vez y con tope diario. El freno se cuenta en `llamadas_conductor`, que solo escribe el
 * servidor: un freno en una tabla que el usuario puede borrar no frena a nadie.
 */
async function motivoSinLlamadaDePrueba(userId: string, rol: string, hoyIso: string): Promise<string | null> {
  if (rol !== "admin") return "Solo un administrador puede pedir una llamada de prueba.";
  const base = () => adminAlertas.from("llamadas_conductor").select("id", { count: "exact", head: true })
    .eq("motivo", "prueba").eq("creado_por", userId);
  const [enCurso, delDia] = await Promise.all([
    base().in("estado", ["pendiente", "marcando"]),
    base().gte("created_at", `${hoyIso}T05:00:00.000Z`),   // 00:00 de Lima
  ]);
  if (enCurso.error || delDia.error) return null;   // sin tabla: lo dirá el encolado (falta el SQL)
  if ((enCurso.count ?? 0) > 0) return "Ya hay una llamada de prueba en cola: espera a que termine.";
  if ((delDia.count ?? 0) >= MAX_LLAMADAS_PRUEBA_DIA) return `Ya pediste ${MAX_LLAMADAS_PRUEBA_DIA} llamadas de prueba hoy.`;
  return null;
}

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
    const datos = datosDeMuestra({
      nombreUsuario: (perfil.data as { nombre?: string | null } | null)?.nombre ?? null,
      fecha: hoy,
      telContingencia: telConting,
    });
    const plan = planDeMuestra(cfgs, datos);
    const elegidos = plan.filter((m) => m.enviable && pedidos.has(m.id) && (m.canal === "llamada" || !!m.plantilla));
    if (elegidos.length === 0) {
      return NextResponse.json({ error: "Ninguno de los mensajes elegidos se puede mandar." }, { status: 400 });
    }

    const resultados: { id: string; ok: boolean; error?: string; nota?: string }[] = [];
    for (let i = 0; i < elegidos.length; i++) {
      const m = elegidos[i];
      if (m.canal === "llamada") {
        // La llamada de prueba va a la COLA de la central propia, como una real: la hace la
        // central cuando la toma. Un intento, y vence en 10 min si nadie la toma.
        const no = await motivoSinLlamadaDePrueba(auth.userId, auth.rol, hoy);
        if (no) { resultados.push({ id: m.id, ok: false, error: no }); continue; }
        const rc = await encolarLlamada({
          reservaId: null, fechaServicio: null, motivo: "prueba",
          conductor: { id: null, tabla: null, nombre: datos.nombre, telefono: tel.e164 },
          hora: datos.hora, origen: datos.origen, destino: datos.destino,
          venceMs: Date.now() + VENCE_LLAMADA_PRUEBA_MIN * 60_000, maxIntentos: 1, creadoPor: auth.userId,
        });
        if (rc === "encolada") {
          const { data: cen } = await adminAlertas.from("central_llamadas_estado").select("ultimo_latido").eq("id", 1).maybeSingle();
          const ec = estadoCentral((cen as { ultimo_latido?: string | null } | null)?.ultimo_latido ?? null, Date.now());
          resultados.push({
            id: m.id, ok: true,
            nota: ec.conectada
              ? "En cola: la central te llama en unos segundos."
              : `En cola, pero no saldrá: ${ec.texto.charAt(0).toLowerCase()}${ec.texto.slice(1)} Vence en ${VENCE_LLAMADA_PRUEBA_MIN} min.`,
          });
        } else {
          resultados.push({ id: m.id, ok: false, error: rc === "sin_tabla" ? `Falta correr ${SQL_LLAMADAS}.` : "No se pudo poner en la cola de llamadas." });
        }
        if (i < elegidos.length - 1) await pausa(PAUSA_MS);
        continue;
      }
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
