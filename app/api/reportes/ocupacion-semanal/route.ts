// ══════════════════════════════════════════════════════════════════════════════
// app/api/reportes/ocupacion-semanal/route.ts
// El reporte de los sábados: cuánta gente viajó frente a los asientos contratados.
//
//   • GET  → cron de Vercel, TODOS los días a las 20:00 Lima. Fail-closed con
//            CRON_SECRET. Corre a diario porque la cadencia es POR CLIENTE: uno
//            quiere sábados, otro los días 1 y 16, otro el último del mes. El
//            cron solo despierta; quién toca hoy lo decide `tocaHoy`.
//   • POST → disparo manual desde el ERP (módulo `reportes`), con `fin` opcional
//            para re-emitir una semana concreta.
//
// ─── LOS TRES CANDADOS CONTRA EL CORREO DOBLE, Y HACEN FALTA LOS TRES ───────
//
// Un correo no se des-envía. (1) La bitácora se relee antes de armar nada; (2) la
// fila de envío se escribe INMEDIATAMENTE después de cada `enviarEmail`, así que
// una función que muera a mitad no pierde lo que ya salió; y (3) el índice único
// `(cliente_id, destino, periodo_fin)` de Postgres es el que aguanta dos ticks
// simultáneos. Es el mismo trío que sostiene `redes_destinos`.
//
// ─── NADA SALE SIN QUE ALGUIEN LO HAYA ENCENDIDO ────────────────────────────
//
// `clientes.reporte_ocupacion_activo` nace en `false`. Sin la migración corrida el
// endpoint responde `sin_migracion` y NO manda nada: un correo con la ocupación de
// sus rutas a un cliente que no lo pidió no se puede deshacer.
// ══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { enviarEmail } from "@/lib/notificaciones";
import { empresaConDefectos } from "@/lib/empresa-perfil";
import { analizarOcupacion, type FilaOcupacion } from "@/lib/ocupacion/semanal";
import {
  hoyLima, tocaHoy, ventanaDe, normalizarFrecuencia, normalizarVentana,
} from "@/lib/ocupacion/cadencia";
import { cargarOcupacion, cargarEscaleraFlota, anotarPlacas } from "@/lib/ocupacion/datos";
import {
  htmlReporte, asuntoReporte, xlsxReporteBase64, nombreArchivo, type MetaReporte,
} from "@/lib/ocupacion/correo";
import {
  cargarServiciosRango, construirManifiestosLoteHTML, construirReportesLoteHTML,
  type ServicioLote,
} from "@/lib/descarga-masiva";

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

/**
 * Tope de servicios por lote de adjuntos.
 *
 * NO ESTÁ MEDIDO Y SE DECLARA COMO TAL. Resend acepta ~40 MB por correo y el
 * base64 infla un 33 %, así que un manifiesto de ~8 KB por servicio deja mucho
 * margen; el tope existe para que un cliente con un mes entero mal filtrado no
 * tumbe el envío del sábado. Al pasarse, los adjuntos se OMITEN y el correo LO
 * DICE — se manda el reporte sin papeles antes que no mandar nada.
 */
const TOPE_ADJUNTOS = 250;

const correosDe = (txt: unknown): string[] =>
  String(txt ?? "").split(/[,;\s]+/).map((s) => s.trim()).filter((s) => s.includes("@"));

/** ¿El error NOMBRA la columna de la migración? Mismo patrón que `faltaColumnaTanque`. */
const faltaMigracion = (e: { message?: string } | null | undefined): boolean => {
  const m = String(e?.message ?? "").toLowerCase();
  return m.includes("reporte_ocupacion") && m.includes("does not exist");
};

type Resultado = {
  ok: boolean;
  motivo?: string;
  periodo?: { inicio: string; fin: string };
  clientes?: { cliente: string; rutas: number; enviados: string[]; omitido?: string; error?: string }[];
};

/**
 * @param clienteId  Acota el envío a UN cliente. Lo usa el botón «Guardar y enviar
 *   ahora» de la ficha del cliente: ahí el operador está mirando a UNO, y disparar
 *   el tick entero —que es lo que hace el botón de /reportes— le mandaría el correo
 *   también a todos los demás activos sin que la pantalla lo diga. El botón dice a
 *   quién le manda y manda a ese.
 *
 *   NO es una puerta trasera: se acota SOBRE la lista de activos, así que la
 *   garantía dura del módulo —nada sale de un cliente que nadie encendió— se
 *   conserva. Un id que no esté encendido devuelve `cliente_no_activo` en vez de
 *   emitir, y eso es distinto de `ningun_cliente_activo`: uno se arregla marcando
 *   la casilla de ESE cliente y el otro es que no hay ninguno en toda la cartera.
 */
async function emitir(opts: { fin?: string; forzarDia?: boolean; clienteId?: number }): Promise<Resultado> {
  const fin = opts.fin || hoyLima();

  // ── A quién se le manda ───────────────────────────────────────────────────
  let activos: any[];
  try {
    let q = admin
      .from("clientes")
      .select("id,nombre,empresa,email,email_facturacion,reporte_ocupacion_activo,reporte_ocupacion_correos,reporte_ocupacion_sugerencias,reporte_ocupacion_frecuencia,reporte_ocupacion_ventana")
      .eq("reporte_ocupacion_activo", true);
    if (opts.clienteId) q = q.eq("id", opts.clienteId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    activos = (data as any[]) ?? [];
  } catch (e: any) {
    if (faltaMigracion(e)) {
      return { ok: false, motivo: "sin_migracion: falta correr supabase/reportes-01-ocupacion-semanal.sql" };
    }
    throw e;
  }

  if (!activos.length) {
    return {
      ok: true,
      motivo: opts.clienteId ? "cliente_no_activo" : "ningun_cliente_activo",
      periodo: { inicio: fin, fin },
    };
  }

  // La VENTANA es por cliente, así que el rango de servicios que hay que leer para
  // los adjuntos es la unión de todas las que tocan hoy. Se calcula antes para
  // pedir `cargarServiciosRango` UNA sola vez.
  const aEmitir = activos
    .map((c) => ({
      c,
      frecuencia: normalizarFrecuencia(c.reporte_ocupacion_frecuencia),
      ventana: normalizarVentana(c.reporte_ocupacion_ventana),
    }))
    .filter((x) => opts.forzarDia || tocaHoy(x.frecuencia, fin))
    .map((x) => ({ ...x, periodo: ventanaDe(x.ventana, fin) }));

  if (!aEmitir.length) {
    return { ok: true, motivo: "hoy_no_toca_a_nadie", periodo: { inicio: fin, fin } };
  }
  const inicioMin = aEmitir.map((x) => x.periodo.inicio).reduce((a, b) => (a < b ? a : b));
  const finMax = aEmitir.map((x) => x.periodo.fin).reduce((a, b) => (a > b ? a : b));

  // ── Lo que se comparte entre todos los clientes ───────────────────────────
  const [perfilRes, escalera, lote] = await Promise.all([
    admin.from("empresa_perfil").select("*").eq("id", 1).maybeSingle(),
    cargarEscaleraFlota(admin),
    // El MISMO armado que usa /seguimiento para bajar manifiestos: el papel que
    // se manda por correo tiene que ser idéntico al que se imprime a mano.
    cargarServiciosRango(inicioMin, finMax, admin).catch(() => null),
  ]);
  const empresa = empresaConDefectos(perfilRes?.data ?? null);
  const origin = process.env.NEXT_PUBLIC_SITE_URL || "https://transportesafa.com";

  // La copia interna. Sin destinatario declarado NO se inventa uno: se omite.
  const correosAfa = correosDe(process.env.REPORTE_OCUPACION_CORREOS) .length
    ? correosDe(process.env.REPORTE_OCUPACION_CORREOS)
    : correosDe(empresa.email);

  // Qué envíos de este periodo YA salieron (candado 1).
  // Con ventanas por cliente, `periodo_fin` ya no es único en la corrida: el de la
  // ventana `mes` cierra el último día del mes anterior. Se relee por los cierres
  // que de verdad se van a pedir.
  const cierres = [...new Set(aEmitir.map((x) => x.periodo.fin))];
  const { data: yaEnviados } = await admin
    .from("reporte_ocupacion_envios")
    .select("cliente_id,destino,periodo_fin")
    .in("periodo_fin", cierres)
    .is("error", null);
  const salido = new Set(((yaEnviados as any[]) ?? []).map((r) => `${r.cliente_id}|${r.destino}|${r.periodo_fin}`));

  const resumen: Resultado["clientes"] = [];

  for (const { c, ventana, periodo } of aEmitir) {
    const { inicio, fin: cierre } = periodo;
    const nombreCliente = String(c.empresa || c.nombre || `Cliente ${c.id}`);
    try {
      const { servicios, hayCapacidad } = await cargarOcupacion(admin, Number(c.id), inicio, cierre);
      if (!servicios.length) {
        resumen.push({ cliente: nombreCliente, rutas: 0, enviados: [], omitido: "sin servicios en el periodo" });
        continue;
      }

      const delCliente: ServicioLote[] = (lote?.servicios ?? [])
        .filter((s) => servicios.some((x) => x.reserva_id === s.id));
      await anotarPlacas(admin, servicios, delCliente.map((s) => ({
        id: s.id, vehiculo_id: null, vehiculo_tercero_id: null,
      })));
      // La placa real sale del lote, que ya la resolvió.
      for (const s of servicios) {
        s.placa = delCliente.find((x) => x.id === s.reserva_id)?.vehiculo_placa ?? s.placa;
      }

      const filas = analizarOcupacion(servicios, escalera);

      // Los adjuntos se arman UNA vez y se reusan en los dos correos.
      const adjuntos = await armarAdjuntos(delCliente, lote, origin);

      const enviados: string[] = [];

      // ── 1) El cliente ──────────────────────────────────────────────────────
      const paraCliente = correosDe(c.reporte_ocupacion_correos).length
        ? correosDe(c.reporte_ocupacion_correos)
        : [...new Set([...correosDe(c.email), ...correosDe(c.email_facturacion)])];

      if (!paraCliente.length) {
        resumen.push({ cliente: nombreCliente, rutas: filas.length, enviados: [], omitido: "sin correo de destino" });
      } else if (salido.has(`${c.id}|cliente|${cierre}`)) {
        resumen.push({ cliente: nombreCliente, rutas: filas.length, enviados: [], omitido: "ya se envió este periodo" });
      } else {
        const meta: MetaReporte = {
          empresaNombre: empresa.nombre, clienteNombre: nombreCliente, inicio, fin: cierre, hayCapacidad, ventana,
          incluirSugerencias: c.reporte_ocupacion_sugerencias !== false,
        };
        await mandar(paraCliente, filas, meta, adjuntos);
        await registrar(Number(c.id), "cliente", inicio, cierre, paraCliente, servicios.length, filas, null);
        enviados.push(...paraCliente);
      }

      // ── 2) La copia de AFA, SIEMPRE con las sugerencias ────────────────────
      // Es la única que las lleva completas aunque el cliente las tenga apagadas:
      // la propuesta comercial la tiene que ver AFA para poder decidirla.
      if (correosAfa.length && !salido.has(`${c.id}|afa|${cierre}`)) {
        const metaAfa: MetaReporte = {
          empresaNombre: empresa.nombre, clienteNombre: nombreCliente, inicio, fin: cierre, hayCapacidad, ventana,
          incluirSugerencias: true,
        };
        await mandar(correosAfa, filas, metaAfa, adjuntos);
        await registrar(Number(c.id), "afa", inicio, cierre, correosAfa, servicios.length, filas, null);
        enviados.push(...correosAfa);
      }

      resumen.push({ cliente: nombreCliente, rutas: filas.length, enviados });
    } catch (e: any) {
      // Un cliente que falla no tumba a los demás, y su fallo queda escrito para
      // poder reintentarlo: el índice único solo bloquea los envíos EXITOSOS.
      console.error("[ocupacion-semanal]", nombreCliente, e);
      await registrar(Number(c.id), "cliente", inicio, cierre, [], 0, [], String(e?.message ?? e)).catch(() => {});
      resumen.push({ cliente: nombreCliente, rutas: 0, enviados: [], error: String(e?.message ?? e) });
    }
  }

  return { ok: true, periodo: { inicio: inicioMin, fin: finMax }, clientes: resumen };
}

type Adjunto = { filename: string; content: string };

/** Manifiestos y reportes de servicio de la semana, en dos archivos. Best-effort. */
async function armarAdjuntos(
  delCliente: ServicioLote[],
  lote: { empresa: any } | null,
  origin: string,
): Promise<{ archivos: Adjunto[]; nota: string | null }> {
  if (!lote || !delCliente.length) return { archivos: [], nota: null };
  if (delCliente.length > TOPE_ADJUNTOS) {
    return { archivos: [], nota: `El periodo trae ${delCliente.length} servicios: los manifiestos y reportes no se adjuntan por tamaño.` };
  }
  try {
    const manif = delCliente.filter((s) => s.puede_manifiesto);
    const reps = delCliente.filter((s) => s.puede_reporte);
    const archivos: Adjunto[] = [];
    if (manif.length) {
      const html = await construirManifiestosLoteHTML(manif, lote.empresa, { sb: admin, origin });
      archivos.push({ filename: "Manifiestos-de-pasajeros.html", content: Buffer.from(html, "utf-8").toString("base64") });
    }
    if (reps.length) {
      const html = await construirReportesLoteHTML(reps, lote.empresa, { sb: admin, origin });
      archivos.push({ filename: "Reportes-de-servicio.html", content: Buffer.from(html, "utf-8").toString("base64") });
    }
    return { archivos, nota: null };
  } catch (e: any) {
    // Los papeles son un extra: el reporte sale igual y se dice que faltan.
    console.error("[ocupacion-semanal] adjuntos", e);
    return { archivos: [], nota: "No se pudieron adjuntar los manifiestos ni los reportes de servicio de esta semana." };
  }
}

async function mandar(
  destinos: string[], filas: FilaOcupacion[], meta: MetaReporte,
  adjuntos: { archivos: Adjunto[]; nota: string | null },
) {
  const cuerpo = htmlReporte(filas, meta)
    + (adjuntos.nota
      ? `<div style="max-width:760px;margin:0 auto;padding:0 16px 20px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:11.5px;color:#92400e;">⚠ ${adjuntos.nota}</div>`
      : "");
  const attachments = [
    { filename: nombreArchivo("Ocupacion", meta, "xlsx"), content: xlsxReporteBase64(filas, meta) },
    ...adjuntos.archivos,
  ];
  // Un `to` por correo, no una lista: un destinatario caído no puede tumbar al resto.
  for (const to of destinos) {
    await enviarEmail({ to, subject: asuntoReporte(filas, meta), html: cuerpo, attachments });
  }
}

async function registrar(
  clienteId: number, destino: string, inicio: string, fin: string,
  destinatarios: string[], servicios: number, filas: FilaOcupacion[], error: string | null,
) {
  await admin.from("reporte_ocupacion_envios").insert({
    cliente_id: clienteId, destino, periodo_inicio: inicio, periodo_fin: fin,
    destinatarios: destinatarios.join(", "), servicios, rutas: filas.length,
    sugerencias: filas.filter((f) => f.codigo === "sugiere_cambio").length,
    error,
  });
}

// ─── Rutas ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  try {
    return NextResponse.json(await emitir({}));
  } catch (e: any) {
    console.error("[ocupacion-semanal cron]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "reportes");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const body = await req.json().catch(() => ({}));
    // `forzarDia` permite emitir un martes para probar; NO salta el candado del
    // envío doble, que es el que de verdad protege.
    //
    // `clienteId` acota a UNO (ver `emitir`). Se normaliza acá y no se confía en el
    // cuerpo: un 0, un negativo o un texto tienen que caer en `undefined` —o sea, el
    // tick de siempre— y nunca en un `.eq("id", NaN)` que no devolvería a nadie y
    // parecería «no hay clientes activos».
    const idCrudo = Number(body?.clienteId ?? 0);
    const clienteId = Number.isFinite(idCrudo) && idCrudo > 0 ? Math.round(idCrudo) : undefined;
    return NextResponse.json(await emitir({
      fin: body?.fin, forzarDia: body?.forzarDia === true, clienteId,
    }));
  } catch (e: any) {
    console.error("[ocupacion-semanal manual]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
