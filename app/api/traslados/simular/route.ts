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
// no, en castellano y con la moneda de siempre (`idioma.codigo = "ingles_apagado"`). `pide_soles`
// (true) solo cuenta con el cliente en inglés u otro idioma, como en la IA. Esos textos solo se usan
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
  validarEntrada, type CondicionesSimuladas, type EntradaSimulador, type EnvioSimulado, type IdiomaSimulado, type PlantillaSimulada,
} from "@/lib/traslados/api";
import { simularTrasladoConCatalogo } from "@/lib/traslados/servicio";
import { cuadraConMotor, filaCotizacionTraslado, type FilaCotizacionLeida } from "@/lib/traslados/cotizacion-traslado";
import { planEnvio, revisionPorCondiciones } from "@/lib/traslados/envio-ia";
import { armarPdfDeFila, avisosDeRevision, leerPerfilPdf, plantillaYReferenciaCuentas, type PerfilPdf } from "@/lib/traslados/enviar-cotizacion-datos";
import { leerInglesTraslado, plantillaParaTraslado } from "@/lib/traslados/plantilla-traslado-datos";
import { inglesActivo, SQL_REGLAS_TRASLADO, type InglesTraslado } from "@/lib/cotizacion-plantillas";
import { idiomaDelCliente, type IdiomaCliente, type MensajeParaIdioma } from "@/lib/idioma-cliente";
import type { Idioma } from "@/lib/cotizacion-idioma";
import { empresaConDefectos } from "@/lib/empresa-perfil";
import { fechaLima } from "@/lib/alertas-horario";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const LIMITE_POR_MINUTO = 30;
/** Lo que se mira de `mensajes_cliente` (no medido: lo que cabe en la caja de texto de la pantalla). */
const MAX_MENSAJES_CLIENTE = 10;
const MAX_CARACTERES_MENSAJE = 500;

/**
 * `mensajes_cliente` del cuerpo: null si no viene; un error si no es una lista de textos o pasa de
 * `MAX_MENSAJES_CLIENTE`. Cada texto se recorta a `MAX_CARACTERES_MENSAJE` (por caracteres completos).
 */
function mensajesDelCuerpo(cuerpo: unknown): { ok: true; mensajes: string[] | null } | { ok: false; detalle: string } {
  const v = cuerpo && typeof cuerpo === "object" ? (cuerpo as Record<string, unknown>).mensajes_cliente : undefined;
  if (v == null) return { ok: true, mensajes: null };
  if (!Array.isArray(v) || v.some((m) => typeof m !== "string")) return { ok: false, detalle: "«mensajes_cliente» tiene que ser una lista de textos." };
  if (v.length > MAX_MENSAJES_CLIENTE) return { ok: false, detalle: `Como mucho ${MAX_MENSAJES_CLIENTE} mensajes del cliente.` };
  return { ok: true, mensajes: (v as string[]).map((m) => Array.from(m).slice(0, MAX_CARACTERES_MENSAJE).join("")).filter((m) => m.trim()) };
}

const NOMBRE_CLIENTE: Record<IdiomaCliente, string> = { es: "castellano", en: "inglés", otro: "otro idioma" };

/**
 * El idioma de la simulación con el MISMO interruptor que la IA (`entradaDelAgente`): la entrada
 * lleva `idioma_cliente` (y `pide_soles`) solo con el cliente en inglés u otro idioma y el inglés
 * encendido; si no, se le quitan (castellano, la moneda de siempre).
 */
function idiomaDeLaSimulacion(
  entrada: EntradaSimulador,
  x: { mensajes: string[] | null; idiomaPedido: unknown; pideSoles: boolean; ingles: InglesTraslado | null; inglesLeido: boolean },
): { entrada: EntradaSimulador; idioma: IdiomaSimulado } {
  // La detección de la IA sobre lo que escribió el cliente (del más reciente al más antiguo); sin
  // mensajes, el idioma que se pidió para probar.
  let cliente: IdiomaCliente | null;
  let detalle: string;
  if (x.mensajes && x.mensajes.length) {
    const lista: MensajeParaIdioma[] = [...x.mensajes].reverse().map((contenido) => ({ contenido, tipo: "texto", created_at: null }));
    const d = idiomaDelCliente(lista, Date.now());
    cliente = d.idioma;
    detalle = d.detalle;
  } else if (x.idiomaPedido === "en" || x.idiomaPedido === "otro") {
    cliente = x.idiomaPedido;
    detalle = `Se simula un cliente que escribe en ${NOMBRE_CLIENTE[cliente]}.`;
  } else {
    cliente = null;
    detalle = "Sin mensajes del cliente: se simula un cliente en castellano.";
  }
  // La entrada sin las claves del idioma ni de la moneda pedida (se vuelven a poner abajo, si aplican).
  const base: EntradaSimulador = { ...entrada };
  delete base.idioma_cliente;
  delete base.pide_soles;
  const fuera = cliente === "en" || cliente === "otro";
  if (!fuera) {
    return { entrada: base, idioma: { idioma: "es", cliente, codigo: cliente === "es" ? "castellano" : "sin_evidencia", detalle } };
  }
  if (!inglesActivo(x.ingles)) {
    const porque = !x.inglesLeido
      ? "no se pudieron leer las plantillas para saber si el inglés está encendido"
      : x.ingles === null
        ? `falta correr ${SQL_REGLAS_TRASLADO}`
        : "ninguna celda «inglés» de la regla del traslado tiene una plantilla en inglés que la IA pueda usar";
    return {
      entrada: base,
      idioma: { idioma: "es", cliente, codigo: "ingles_apagado", detalle: `${detalle} Inglés apagado (${porque}): la cotización sale en castellano y con la moneda de siempre, como hoy.` },
    };
  }
  // Soles y dólares a la vez: ninguno (manda el defecto del idioma), como en la IA.
  const pideSoles = x.pideSoles && entrada.pide_dolares !== true;
  const pideDolares = entrada.pide_dolares === true && !x.pideSoles;
  const sinDolares: EntradaSimulador = { ...base };
  delete sinDolares.pide_dolares;
  const senales = pideSoles && Array.isArray(base.senales) ? base.senales.filter((sn) => sn !== "otra_moneda") : base.senales;
  return {
    entrada: {
      ...sinDolares, senales, ...(pideDolares ? { pide_dolares: true } : {}),
      idioma_cliente: cliente as "en" | "otro", ...(pideSoles ? { pide_soles: true as const } : {}),
    },
    idioma: { idioma: "en", cliente, codigo: cliente === "en" ? "ingles" : "otro_idioma", detalle },
  };
}

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
    let inglesLeido = true;
    if (posible) {
      const li = await leerInglesTraslado(sb);
      inglesLeido = li.ok;
      ingles = li.ok ? li.ingles : null;
    }
    const sim = idiomaDeLaSimulacion(v.entrada, { mensajes: ms.mensajes, idiomaPedido: pedido.idioma_cliente, pideSoles: pedido.pide_soles === true, ingles, inglesLeido });
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
