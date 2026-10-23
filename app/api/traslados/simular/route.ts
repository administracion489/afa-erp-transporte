// app/api/traslados/simular/route.ts
// POST — El cotizador automático de traslados SIN enviar nada: ubica origen y destino (Google,
// con caché), decide si el pedido es simple, el vehículo y el precio (lib/traslados/motor.ts).
// Lo usa el Simulador de /tarifario → Zonas y traslados. Es la misma función que usa la IA del
// CRM (lib/traslados/servicio.ts): lo que se prueba aquí es lo que la IA va a cotizar.
//
// Con un resultado cotizable, la respuesta trae además `envio`: qué haría la IA con esa
// cotización (enviarla sola o dejarla para revisar, con sus motivos), suponiendo WhatsApp con el
// número escrito, el agente en modo autónomo y el PDF armado; el perfil, las zonas, las cuentas de
// la plantilla (frente a las de `corporativo`) y las condiciones son los reales.
// Con `?pdf=1` (el mismo cuerpo) devuelve el PDF de EJEMPLO de esa cotización (número EJEMPLO y
// marca de agua), con el formato corporativo de /cotizaciones y la foto de la categoría; la cabecera
// `X-Avisos-Pdf` lista los códigos de lo que no pudo poner. No escribe nada en ningún caso.
//
// Las CONDICIONES del PDF salen de la misma plantilla que usaría la IA (`plantillaParaTraslado`,
// regla «Traslado de la IA × segmento»; aquí el segmento sale solo de la moneda, porque el
// simulador no tiene un cliente del ERP verificado) y la respuesta dice cuál (`plantilla`,
// `condiciones`). Del cuerpo de la petición solo se toma el pedido: la plantilla NUNCA. Una lectura
// de las plantillas que falla es un 500 con su motivo (la IA, en ese caso, deriva).
//
// EL IDIOMA, COMO LO DECIDE LA IA (22-10-2026): con `mensajes_cliente` (hasta 10 textos de hasta 500
// caracteres: lo que escribió el cliente, del más antiguo al más reciente) se corre la MISMA
// detección (`idiomaDelCliente`); sin ellos vale `idioma_cliente` («en» u «otro») tal cual. Y pasa por
// el MISMO interruptor que en la IA: solo con el inglés encendido (`leerInglesTraslado`: una plantilla
// en inglés asignada a una celda «inglés») la cotización sale en inglés y con la moneda del idioma; si
// no, en castellano y con la moneda de siempre (`idioma.codigo = "ingles_apagado"`; si el interruptor
// no se pudo LEER, `"no_se_pudo_leer"` con el error: una lectura que falla no es un inglés apagado).
// `pide_soles` (true) solo cuenta con el cliente en inglés u otro idioma, como en la IA. La regla vive
// en lib/traslados/simular-idioma.ts (pura, con su matriz). Esos textos solo se usan
// para detectar el idioma: no se guardan ni se escriben en ningún sitio. La respuesta dice el idioma
// (`idioma`) y la celda idioma × moneda de la plantilla (`plantilla.celda`, `condiciones.celda`), y
// `?pdf=1` sale en ese idioma.
//
// Solo usuarios del ERP con el módulo «tarifas» (el simulador vive en esa pantalla). Cada
// simulación puede costar hasta 4 consultas de Geocoding (2 directas + 2 inversas) si no están
// en caché: tope de 30 por minuto por usuario (con o sin PDF), en memoria de la instancia.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { guardarGasto, limitarTasa, segundosParaReintentar } from "@/lib/api-guard";
import {
  validarEntrada, type CondicionesSimuladas, type EnvioSimulado, type PlantillaSimulada,
} from "@/lib/traslados/api";
import { simularTrasladoConCatalogo } from "@/lib/traslados/servicio";
import { cuadraConMotor, filaCotizacionTraslado, type FilaCotizacionLeida } from "@/lib/traslados/cotizacion-traslado";
import { planEnvio, revisionPorCondiciones } from "@/lib/traslados/envio-ia";
import { armarPdfDeFila, avisosDeRevision, leerPerfilPdf, plantillaYReferenciaCuentas, type PerfilPdf } from "@/lib/traslados/enviar-cotizacion-datos";
import { leerInglesTraslado, plantillaParaTraslado } from "@/lib/traslados/plantilla-traslado-datos";
import type { InglesTraslado } from "@/lib/cotizacion-plantillas";
import { idiomaDeLaSimulacion, mensajesDelCuerpo } from "@/lib/traslados/simular-idioma";
import type { Idioma } from "@/lib/cotizacion-idioma";
import { empresaConDefectos } from "@/lib/empresa-perfil";
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
  const ms = mensajesDelCuerpo(cuerpo);
  if (!ms.ok) return NextResponse.json({ ok: false, codigo: "entrada_invalida", detalle: ms.detalle }, { status: 400 });
  const pedido = (cuerpo ?? {}) as Record<string, unknown>;

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const quierePdf = req.nextUrl.searchParams.get("pdf") === "1";
  try {
    const hoy = fechaLima(Date.now());
    // ¿El inglés está encendido? Solo se pregunta si hace falta (un cliente en inglés u otro idioma):
    // en castellano, la simulación de siempre.
    const posible = (ms.mensajes && ms.mensajes.length) || pedido.idioma_cliente === "en" || pedido.idioma_cliente === "otro";
    let ingles: InglesTraslado | null = null;
    let errorIngles: string | null = null;
    if (posible) {
      const li = await leerInglesTraslado(sb);
      if (li.ok) ingles = li.ingles; else errorIngles = li.detalle || "error desconocido";
    }
    const sim = idiomaDeLaSimulacion(v.entrada, { mensajes: ms.mensajes, idiomaPedido: pedido.idioma_cliente, pideSoles: pedido.pide_soles === true, ingles, errorIngles });
    const entrada = sim.entrada;
    const idioma = sim.idioma;
    const { respuesta, catalogo } = await simularTrasladoConCatalogo(sb, entrada, hoy);
    const cotizable = respuesta.ok && respuesta.resultado.codigo === "cotizable" && !!catalogo;
    if (!respuesta.ok || !cotizable || !catalogo) {
      if (quierePdf) {
        const detalle = respuesta.ok ? `Solo se arma el PDF de un traslado cotizable: ${respuesta.resultado.motivo}` : respuesta.detalle;
        return NextResponse.json({ ok: false, codigo: "error", detalle }, { status: 422 });
      }
      return NextResponse.json(respuesta.ok ? { ...respuesta, idioma } : respuesta);
    }
    const r = respuesta.resultado;
    // La plantilla de las condiciones, la misma que usaría la IA (sin cliente: el segmento sale de la
    // moneda; la celda, del idioma que decidió el código y de la moneda del motor).
    const idiomaFila: Idioma = entrada.idioma_cliente ? "en" : "es";
    const pt = await plantillaParaTraslado(sb, { moneda: r.precio!.moneda, clienteId: null, idioma: idiomaFila });
    if (!pt.ok) {
      return NextResponse.json({ ok: false, codigo: "error", detalle: `No se pudieron leer las condiciones del PDF (plantilla): ${pt.detalle}` }, { status: 500 });
    }
    // La fila que guardaría la IA, en memoria (no se inserta).
    const fila = filaCotizacionTraslado(r, entrada, {
      convId: "simulador", clienteId: null, atencion: null, config: catalogo.config, firma: "simulador", hoy, plantilla: pt.plantilla,
      ...(idiomaFila === "en" ? { idioma: idiomaFila } : {}),
    });
    let perfil: PerfilPdf | null = null;
    try { perfil = await leerPerfilPdf(sb); } catch { perfil = null; }

    if (quierePdf) {
      const leida: FilaCotizacionLeida = { ...fila, id: 0, created_at: new Date().toISOString() };
      if (!perfil) return NextResponse.json({ ok: false, codigo: "error", detalle: "No se pudo leer el perfil de la empresa." }, { status: 500 });
      // El CELULAR que se imprime es el teléfono que se escribió en el simulador (el de un cliente
      // real sería el wa_id de su conversación).
      const pdf = await armarPdfDeFila(sb, leida, { ejemplo: true, perfil, celular: entrada.telefono ?? null });
      return new Response(Buffer.from(pdf.bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "Content-Disposition": `inline; filename="${pdf.nombre}"`,
          // Lo que el PDF no pudo poner (sin foto, foto que no se bajó, sin cuenta en la moneda, falta
          // traslados-07): solo los códigos, separados por coma. La pantalla los nombra.
          "X-Avisos-Pdf": pdf.avisos.map((a) => a.codigo).join(","),
        },
      });
    }

    const plan = planEnvio({
      resultado: r, envioMaestro: catalogo.config.envio_automatico === true, zonas: catalogo.zonas,
      canal: "whatsapp", waId: entrada.telefono, modoAuto: true,
      perfilConfigurado: !!perfil && !empresaConDefectos(perfil.perfil).sinConfigurar,
      cuadra: cuadraConMotor(fila, r), pdfOk: true, palabras: [], ...(idiomaFila === "en" ? { idioma: idiomaFila } : {}),
    });
    // Y lo que la IA lee del PDF de su fila (lib/traslados/cotizar-ia-datos.ts → revisionPorCondiciones):
    // las cuentas de la plantilla frente a las de `corporativo` y las condiciones (que no quepan, o con
    // un enlace o un número de 6+ dígitos). Sin esto el simulador diría «sale sola» de una cotización
    // que la IA dejaría para revisión.
    const pc = await plantillaYReferenciaCuentas(sb, fila.plantilla_pdf);
    const porPdf = revisionPorCondiciones({
      avisosPdf: avisosDeRevision(fila, { plantilla: pc.usada, referencia: pc.referencia, perfil: perfil?.perfil ?? null }),
      consideraciones: fila.consideraciones_json, idiomaPdf: fila.idioma_pdf,
    });
    const motivos = [...plan.motivos, ...porPdf.motivos.filter((m) => !plan.motivos.includes(m))];
    const envio: EnvioSimulado = { decision: motivos.length === 0 ? "automatico" : "revision", motivos };
    // La celda idioma × moneda solo con la regla nueva (cotizaciones-09); sin ella, el segmento manda.
    const celda = pt.celda ? { celda: pt.celda } : {};
    const plantilla: PlantillaSimulada | null = pt.plantilla
      ? { id: pt.plantilla.id, nombre: pt.plantilla.nombre || pt.plantilla.id, segmento: pt.segmento, codigo: pt.codigo, ...celda }
      : null;
    const condiciones: CondicionesSimuladas = { fuente: pt.plantilla ? "plantilla" : "ajustes", segmento: pt.segmento, codigo: pt.codigo, detalle: pt.detalle, ...celda };
    return NextResponse.json({ ...respuesta, envio, plantilla, condiciones, idioma });
  } catch (e) {
    console.error("[traslados/simular]", (e as Error)?.message);
    return NextResponse.json({ ok: false, codigo: "error", detalle: quierePdf ? "No se pudo armar el PDF de ejemplo." : "No se pudo simular el traslado." }, { status: 500 });
  }
}
