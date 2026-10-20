// app/api/traslados/simular/route.ts
// POST — El cotizador automático de traslados SIN enviar nada: ubica origen y destino (Google,
// con caché), decide si el pedido es simple, el vehículo y el precio (lib/traslados/motor.ts).
// Lo usa el Simulador de /tarifario → Zonas y traslados. Es la misma función que usa la IA del
// CRM (lib/traslados/servicio.ts): lo que se prueba aquí es lo que la IA va a cotizar.
//
// Con un resultado cotizable, la respuesta trae además `envio`: qué haría la IA con esa
// cotización (enviarla sola o dejarla para revisar, con sus motivos), suponiendo WhatsApp con el
// número escrito, el agente en modo autónomo y el PDF armado; el perfil y las zonas son los reales.
// Con `?pdf=1` (el mismo cuerpo) devuelve el PDF de EJEMPLO de esa cotización (número EJEMPLO y
// marca de agua), con el formato corporativo de /cotizaciones y la foto de la categoría; la cabecera
// `X-Avisos-Pdf` lista los códigos de lo que no pudo poner. No escribe nada en ningún caso.
//
// Solo usuarios del ERP con el módulo «tarifas» (el simulador vive en esa pantalla). Cada
// simulación puede costar hasta 4 consultas de Geocoding (2 directas + 2 inversas) si no están
// en caché: tope de 30 por minuto por usuario (con o sin PDF), en memoria de la instancia.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { guardarGasto, limitarTasa, segundosParaReintentar } from "@/lib/api-guard";
import { validarEntrada, type EnvioSimulado } from "@/lib/traslados/api";
import { simularTrasladoConCatalogo } from "@/lib/traslados/servicio";
import { cuadraConMotor, filaCotizacionTraslado, type FilaCotizacionLeida } from "@/lib/traslados/cotizacion-traslado";
import { planEnvio } from "@/lib/traslados/envio-ia";
import { armarPdfDeFila, leerPerfilPdf, type PerfilPdf } from "@/lib/traslados/enviar-cotizacion-datos";
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

  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const quierePdf = req.nextUrl.searchParams.get("pdf") === "1";
  try {
    const hoy = fechaLima(Date.now());
    const { respuesta, catalogo } = await simularTrasladoConCatalogo(sb, v.entrada, hoy);
    const cotizable = respuesta.ok && respuesta.resultado.codigo === "cotizable" && !!catalogo;
    if (!respuesta.ok || !cotizable || !catalogo) {
      if (quierePdf) {
        const detalle = respuesta.ok ? `Solo se arma el PDF de un traslado cotizable: ${respuesta.resultado.motivo}` : respuesta.detalle;
        return NextResponse.json({ ok: false, codigo: "error", detalle }, { status: 422 });
      }
      return NextResponse.json(respuesta);
    }
    const r = respuesta.resultado;
    // La fila que guardaría la IA, en memoria (no se inserta).
    const fila = filaCotizacionTraslado(r, v.entrada, {
      convId: "simulador", clienteId: null, atencion: null, config: catalogo.config, firma: "simulador", hoy,
    });
    let perfil: PerfilPdf | null = null;
    try { perfil = await leerPerfilPdf(sb); } catch { perfil = null; }

    if (quierePdf) {
      const leida: FilaCotizacionLeida = { ...fila, id: 0, created_at: new Date().toISOString() };
      if (!perfil) return NextResponse.json({ ok: false, codigo: "error", detalle: "No se pudo leer el perfil de la empresa." }, { status: 500 });
      // El CELULAR que se imprime es el teléfono que se escribió en el simulador (el de un cliente
      // real sería el wa_id de su conversación).
      const pdf = await armarPdfDeFila(sb, leida, { ejemplo: true, perfil, celular: v.entrada.telefono ?? null });
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
      canal: "whatsapp", waId: v.entrada.telefono, modoAuto: true,
      perfilConfigurado: !!perfil && !empresaConDefectos(perfil.perfil).sinConfigurar,
      cuadra: cuadraConMotor(fila, r), pdfOk: true, palabras: [],
    });
    const envio: EnvioSimulado = { decision: plan.decision, motivos: plan.motivos };
    return NextResponse.json({ ...respuesta, envio });
  } catch (e) {
    console.error("[traslados/simular]", (e as Error)?.message);
    return NextResponse.json({ ok: false, codigo: "error", detalle: quierePdf ? "No se pudo armar el PDF de ejemplo." : "No se pudo simular el traslado." }, { status: 500 });
  }
}
