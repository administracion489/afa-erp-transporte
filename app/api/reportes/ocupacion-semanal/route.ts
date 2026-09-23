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
  resolverCopiaInterna, correosDeTexto, planDeEnvio, MOTIVO_SIN_PRUEBA,
  type FilaCopia,
} from "@/lib/ocupacion/copia-interna";
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

// Vive en el módulo puro y se importa: la pantalla que edita la copia interna
// tiene que partir la lista exactamente igual que el cron que la manda.
const correosDe = correosDeTexto;

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
  /**
   * Qué hizo la copia interna en ESTA corrida, con su código y su procedencia.
   * Contesta «¿por qué no me llegó a mí?» sin mirar la base — mismo papel que
   * `ciclo_vida_en_espera` en el tick de alertas.
   */
  copia_interna?: { codigo: string; correos: string[]; fuente: string | null };
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
 *
 * @param soloAfa  PRUEBA: el reporte de ese cliente sale SOLO a los correos de la
 *   copia interna y el cliente NO recibe nada. Exige `clienteId`.
 *
 *   Por eso —y solo por eso— este camino NO filtra por `reporte_ocupacion_activo`:
 *   ver cómo queda el reporte de un cliente ANTES de encenderle el envío es
 *   justamente para lo que sirve. La garantía dura sigue intacta porque la prueba
 *   nunca le escribe al cliente: `planDeEnvio` no devuelve el destino `cliente` en
 *   una prueba, ni siquiera cuando la copia interna no tiene a dónde ir.
 *
 *   Y NO consume el envío programado: su destino es `prueba_afa`, así que el
 *   candado `(cliente_id, destino, periodo_fin)` de `afa` queda libre. Registrarla
 *   como `afa` habría quemado la copia real de ese periodo en silencio.
 */
async function emitir(opts: {
  fin?: string; forzarDia?: boolean; clienteId?: number; soloAfa?: boolean;
}): Promise<Resultado> {
  const fin = opts.fin || hoyLima();

  // Una prueba «a toda la cartera» sería una ráfaga de correos a operaciones con
  // un clic, así que se exige el cliente. No es una limitación técnica: es la
  // misma razón por la que el botón de la ficha manda solo a ese cliente.
  if (opts.soloAfa && !opts.clienteId) {
    return { ok: false, motivo: "prueba_sin_cliente: elige a qué cliente le corresponde la prueba" };
  }

  // ── A quién se le manda ───────────────────────────────────────────────────
  let activos: any[];
  try {
    let q = admin
      .from("clientes")
      .select("id,nombre,empresa,email,email_facturacion,reporte_ocupacion_activo,reporte_ocupacion_correos,reporte_ocupacion_sugerencias,reporte_ocupacion_frecuencia,reporte_ocupacion_ventana");
    if (!opts.soloAfa) q = q.eq("reporte_ocupacion_activo", true);
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
      motivo: opts.soloAfa ? "cliente_no_existe"
        : opts.clienteId ? "cliente_no_activo"
        : "ningun_cliente_activo",
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
    // Una prueba salta el «¿hoy le toca?» por definición: se pide para verla
    // ahora. Sin esto, probar un martes un cliente configurado para sábados
    // contestaría «hoy no toca a nadie» y se leería como que está roto.
    .filter((x) => opts.forzarDia || opts.soloAfa || tocaHoy(x.frecuencia, fin))
    .map((x) => ({ ...x, periodo: ventanaDe(x.ventana, fin) }));

  if (!aEmitir.length) {
    return { ok: true, motivo: "hoy_no_toca_a_nadie", periodo: { inicio: fin, fin } };
  }
  const inicioMin = aEmitir.map((x) => x.periodo.inicio).reduce((a, b) => (a < b ? a : b));
  const finMax = aEmitir.map((x) => x.periodo.fin).reduce((a, b) => (a > b ? a : b));

  // ── Lo que se comparte entre todos los clientes ───────────────────────────
  const [perfilRes, escalera, lote, cfgRes] = await Promise.all([
    admin.from("empresa_perfil").select("*").eq("id", 1).maybeSingle(),
    cargarEscaleraFlota(admin),
    // El MISMO armado que usa /seguimiento para bajar manifiestos: el papel que
    // se manda por correo tiene que ser idéntico al que se imprime a mano.
    cargarServiciosRango(inicioMin, finMax, admin).catch(() => null),
    // Sin `reportes-03` corrido esto devuelve error y la fila llega `null`, que
    // `resolverCopiaInterna` lee como «nadie lo apagó»: la copia sale igual y sus
    // direcciones salen de la cascada de siempre. Correr el SQL no cambia nada.
    admin.from("reporte_ocupacion_config").select("*").eq("id", 1).maybeSingle(),
  ]);
  const empresa = empresaConDefectos(perfilRes?.data ?? null);
  const origin = process.env.NEXT_PUBLIC_SITE_URL || "https://transportesafa.com";

  // La copia interna: si sale y a quién, con la MISMA función que consulta la
  // pantalla. Sin destinatario en toda la cascada NO se inventa uno: se omite.
  const copia = resolverCopiaInterna({
    fila: (cfgRes?.data as FilaCopia | null) ?? null,
    env: process.env.REPORTE_OCUPACION_CORREOS,
    emailEmpresa: empresa.email,
  });

  // Quién recibe esta corrida. La MISMA función que describe la pantalla: acá se
  // decide una sola vez y los dos bloques de abajo la obedecen.
  const plan = planDeEnvio({ prueba: opts.soloAfa, copia });

  // Una prueba que no tiene a dónde ir no se convierte en un correo al cliente:
  // se para acá y DICE cuál de los dos arreglos le falta.
  if (plan.motivo) {
    return { ok: false, motivo: `prueba_sin_destino: ${MOTIVO_SIN_PRUEBA[plan.motivo]}`, periodo: { inicio: inicioMin, fin: finMax } };
  }

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
      // Los SERVICIOS de la bitácora son los que el reporte cuenta: DÍAS, con la
      // ida y su retorno juntos. `servicios.length` son tramos, y grabar ese
      // número dejaría la bitácora diciendo el doble que el correo.
      const diasDelPeriodo = filas.reduce((a, f) => a + f.servicios, 0);

      // Los adjuntos se arman UNA vez y se reusan en los dos correos.
      const adjuntos = await armarAdjuntos(delCliente, lote, origin);

      const enviados: string[] = [];

      // ── 1) El cliente ──────────────────────────────────────────────────────
      const paraCliente = correosDe(c.reporte_ocupacion_correos).length
        ? correosDe(c.reporte_ocupacion_correos)
        : [...new Set([...correosDe(c.email), ...correosDe(c.email_facturacion)])];

      if (!plan.destinos.includes("cliente")) {
        // Una PRUEBA. El cliente no entra ni por asomo: ni su correo se resuelve
        // para nada, ni se escribe su fila de bitácora, así que el envío del
        // sábado le sigue tocando entero.
      } else if (!paraCliente.length) {
        resumen.push({ cliente: nombreCliente, rutas: filas.length, enviados: [], omitido: "sin correo de destino" });
      } else if (salido.has(`${c.id}|cliente|${cierre}`)) {
        resumen.push({ cliente: nombreCliente, rutas: filas.length, enviados: [], omitido: "ya se envió este periodo" });
      } else {
        const meta: MetaReporte = {
          empresaNombre: empresa.nombre, clienteNombre: nombreCliente, inicio, fin: cierre, hayCapacidad, ventana,
          incluirSugerencias: c.reporte_ocupacion_sugerencias !== false,
        };
        await mandar(paraCliente, filas, meta, adjuntos);
        await registrar(Number(c.id), "cliente", inicio, cierre, paraCliente, diasDelPeriodo, filas, null);
        enviados.push(...paraCliente);
      }

      // ── 2) La copia de AFA, SIEMPRE con las sugerencias ────────────────────
      // Es la única que las lleva completas aunque el cliente las tenga apagadas:
      // la propuesta comercial la tiene que ver AFA para poder decidirla. Se
      // enciende y se apaga en /reportes → «Copia interna de AFA».
      //
      // En una PRUEBA el destino es `prueba_afa` y NO se consulta el candado: su
      // fila es una constancia, no una reserva del envío programado. (Dos pruebas
      // del mismo periodo dejan una sola fila —el índice único las junta— y eso
      // está bien: lo que tiene que quedar escrito es que ese periodo se probó.)
      const destinoAfa = plan.destinos.find((d) => d === "afa" || d === "prueba_afa");
      const consume = destinoAfa ? plan.consumen.includes(destinoAfa) : false;

      if (destinoAfa && !(consume && salido.has(`${c.id}|afa|${cierre}`))) {
        const metaAfa: MetaReporte = {
          empresaNombre: empresa.nombre, clienteNombre: nombreCliente, inicio, fin: cierre, hayCapacidad, ventana,
          incluirSugerencias: true,
        };
        await mandar(copia.correos, filas, metaAfa, adjuntos);
        await registrar(Number(c.id), destinoAfa, inicio, cierre, copia.correos, diasDelPeriodo, filas, null);
        enviados.push(...copia.correos);
      }

      resumen.push({ cliente: nombreCliente, rutas: filas.length, enviados });
    } catch (e: any) {
      // Un cliente que falla no tumba a los demás, y su fallo queda escrito para
      // poder reintentarlo: el índice único solo bloquea los envíos EXITOSOS.
      console.error("[ocupacion-semanal]", nombreCliente, e);
      // Con el destino que de verdad se intentó: una prueba que falla no puede
      // quedar escrita como si le hubiera fallado el envío AL CLIENTE.
      await registrar(Number(c.id), plan.destinos[0] ?? "cliente", inicio, cierre, [], 0, [], String(e?.message ?? e)).catch(() => {});
      resumen.push({ cliente: nombreCliente, rutas: 0, enviados: [], error: String(e?.message ?? e) });
    }
  }

  return {
    ok: true,
    periodo: { inicio: inicioMin, fin: finMax },
    clientes: resumen,
    copia_interna: { codigo: copia.codigo, correos: copia.correos, fuente: copia.fuente },
  };
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
    // `soloAfa` es la PRUEBA: solo un `true` explícito la activa, y `emitir`
    // rechaza la que no nombre a un cliente.
    return NextResponse.json(await emitir({
      fin: body?.fin, forzarDia: body?.forzarDia === true, clienteId,
      soloAfa: body?.soloAfa === true,
    }));
  } catch (e: any) {
    console.error("[ocupacion-semanal manual]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
