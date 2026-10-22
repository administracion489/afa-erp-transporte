// ANTHROPIC_API_KEY=x npx tsx scripts/prueba-reserva-ia.mts
// Lo que el agente IA ve de la reserva de traslados (lib/traslados/reserva-ia.ts). Fija:
//  · ningún esquema de herramienta tiene monto, moneda, teléfono, cuenta ni destinatario, y sus
//    textos no llevan cifras (un número en el prompt es un número que el modelo copia);
//  · toda respuesta al modelo está en la lista blanca y no menciona dinero;
//  · `textoFinalReserva`: el mensaje del código gana; la guarda T10 salta con dinero o un número
//    largo cuando hay una cotización de traslado; sin cotización, o con la cotización del turno, no;
//  · `bloqueReservaTraslados` sin montos, porcentajes ni cuentas, y la frase que reemplaza sigue en
//    el prompt de hoy (lib/crm-ia.ts → bloqueTraslados).
// Lo que NO fija todavía: «con la reserva apagada, el prompt de crm-ia byte a byte el de antes».
// Eso lo conecta B3 en lib/crm-ia.ts y lo fija su matriz.
import {
  ACCIONES_POR_HERRAMIENTA, CLAVES_COTIZACION_RESERVA, CLAVES_RESPUESTA_RESERVA, FRASE_PROPONER_RESERVA_TRASLADOS, FRASE_RESERVAR_TRASLADO,
  HERRAMIENTAS_RESERVA, INSTRUCCION_RESERVA, NOMBRES_HERRAMIENTAS_RESERVA, TOPES_RESERVA, bloqueReservaTraslados, decidirTopeReserva,
  elegirCotizacion, entradaReserva, estadoReservaIA, mensajePedirComprobante, respuestaReservaParaModelo, textoFinalReserva,
  type AccionReserva, type CotizacionCandidata, type ResultadoReservaIA,
} from "../lib/traslados/reserva-ia";
import { mensajeGuardaReserva, normalizarConfigReserva } from "../lib/traslados/reserva-pago";
import { importesEnTexto, mencionaDinero } from "../lib/traslados/texto-libre";
import { bloqueTraslados } from "../lib/crm-ia";
import type { EstiloMensajes } from "../lib/crm-ia-ajustes";

let ok = 0, mal = 0;
const fallas: string[] = [];
const t = (n: string, c: boolean) => { if (c) ok++; else { mal++; if (fallas.length < 40) fallas.push(n); } };
const USTED: EstiloMensajes = { tratamiento: "usted", preguntas: "todo_junto" };
const TU: EstiloMensajes = { tratamiento: "tu", preguntas: "una_por_mensaje" };

// ── 1. Los esquemas ──────────────────────────────────────────────────────────
{
  const PROHIBIDAS = /monto|precio|importe|moneda|tel[eé]fono|celular|cuenta|cci|banco|destinatario|wa_?id|phone|amount|currency|pct|porcentaje|adelanto/i;
  t("cuatro herramientas con nombres únicos", HERRAMIENTAS_RESERVA.length === 4 && new Set(NOMBRES_HERRAMIENTAS_RESERVA).size === 4);
  for (const h of HERRAMIENTAS_RESERVA) {
    const props = Object.keys(h.input_schema.properties);
    t(`${h.name}: sin monto/moneda/teléfono/cuenta en el esquema`, props.every((p) => !PROHIBIDAS.test(p)));
    t(`${h.name}: ninguna propiedad obligatoria`, !("required" in h.input_schema));
    t(`${h.name}: sin cifras en la descripción ni en las propiedades`, !/\d/.test(JSON.stringify(h)));
    t(`${h.name}: no pide escribir montos`, !mencionaDinero(h.description));
  }
  t("reservar_traslado tiene nombre del pasajero y vuelo; las demás solo el número", (() => {
    const [r, ...otras] = HERRAMIENTAS_RESERVA;
    return Object.keys(r.input_schema.properties).sort().join() === "nombre_pasajero,numero_cotizacion,vuelo" && otras.every((h) => Object.keys(h.input_schema.properties).join() === "numero_cotizacion");
  })());
}

// ── 2. La entrada del modelo, con lista blanca ───────────────────────────────
{
  const e = entradaReserva({ numero_cotizacion: "N° 00736", nombre_pasajero: "  Ana   María  ", vuelo: "la 2047", monto: 999, telefono: "987654321" });
  t("entrada limpia", e.numeroCotizacion === "00736" && e.nombrePasajero === "Ana María" && e.vuelo === "LA 2047");
  t("nada más pasa", Object.keys(e).sort().join() === "nombrePasajero,numeroCotizacion,vuelo");
  const s = entradaReserva({ numero_cotizacion: "736; drop", nombre_pasajero: "Deposite S/ 50 al Yape 987654321", vuelo: "visita www.x.com" });
  t("lo sospechoso no pasa", s.numeroCotizacion === null && s.nombrePasajero === null && s.vuelo === null);
  t("basura → todo null", JSON.stringify(entradaReserva(null)) === JSON.stringify({ numeroCotizacion: null, nombrePasajero: null, vuelo: null }));
}

// ── 3. Qué cotización se reserva ─────────────────────────────────────────────
{
  const c = (numero: string, o: Partial<CotizacionCandidata> = {}): CotizacionCandidata => ({ id: Number(numero), numero, enviada: true, vencida: false, solicitudViva: false, ...o });
  t("sin enviadas → sin_cotizacion", elegirCotizacion([c("1", { enviada: false })]).accion === "sin_cotizacion" && elegirCotizacion([]).accion === "sin_cotizacion");
  t("una → crear", (() => { const r = elegirCotizacion([c("736")]); return r.accion === "crear" && r.cotizacion.numero === "736"; })());
  t("dos vigentes → elegir", (() => { const r = elegirCotizacion([c("1"), c("2")]); return r.accion === "elegir_cotizacion" && r.opciones.join() === "1,2"; })());
  t("dos, una sola vigente sin solicitud → esa", (() => { const r = elegirCotizacion([c("1", { vencida: true }), c("2")]); return r.accion === "crear" && r.cotizacion.numero === "2"; })());
  t("con número (y ceros) → esa", (() => { const r = elegirCotizacion([c("00736"), c("00737")], "736"); return r.accion === "crear" && r.cotizacion.numero === "00736"; })());
  t("número que no es de este chat → elegir", elegirCotizacion([c("1"), c("2")], "9").accion === "elegir_cotizacion");
  t("vencida → recotizar", elegirCotizacion([c("1", { vencida: true })]).accion === "recotizar");
  t("con solicitud viva → ya_solicitada", elegirCotizacion([c("1", { solicitudViva: true })]).accion === "ya_solicitada");
}

// ── 4. Lo que vuelve al modelo: lista blanca, sin dinero ─────────────────────
{
  const todas = new Set<AccionReserva>(Object.values(ACCIONES_POR_HERRAMIENTA).flat());
  t("toda acción tiene instrucción", [...todas].every((a) => typeof INSTRUCCION_RESERVA[a] === "string") && Object.keys(INSTRUCCION_RESERVA).length === todas.size);
  let casos = 0, buenos = 0;
  for (const a of todas) for (const numero of [null, "00736", "COT-2026-0736", "999999"]) for (const opciones of [null, ["00736", "00737"]]) {
    const j = respuestaReservaParaModelo(a, { numero, opciones });
    const o = JSON.parse(j);
    casos++;
    const claves = Object.keys(o).every((k) => (CLAVES_RESPUESTA_RESERVA as readonly string[]).includes(k));
    const cot = o.cotizacion == null || Object.keys(o.cotizacion).every((k) => (CLAVES_COTIZACION_RESERVA as readonly string[]).includes(k));
    const sinDinero = importesEnTexto(j).length === 0 && !mencionaDinero(o.instruccion) && !/%/.test(j) && !/\d/.test(o.instruccion);
    const opc = a === "elegir_cotizacion" ? true : o.opciones === undefined;
    if (claves && cot && sinDinero && opc && o.accion === a) buenos++;
    else if (fallas.length < 40) fallas.push(`respuesta ${a} ${numero}: ${j}`);
  }
  t(`respuestas en lista blanca y sin dinero (${buenos}/${casos})`, buenos === casos);
  // Toda frase que nombra «confirmado/validado» es una prohibición («Nunca digas…»), nunca una afirmación.
  t("ninguna instrucción afirma que el pago está confirmado", [...todas].every((a) => INSTRUCCION_RESERVA[a].split(/(?<=\.)\s+/).filter((f) => /confirmad[oa]s?|validad[oa]s?/i.test(f)).every((f) => /^Nunca digas/.test(f))));
}

// ── 5. textoFinalReserva ─────────────────────────────────────────────────────
{
  const T1 = "Para reservar su traslado de la cotización N° 00736 se abona el 50 % del total como adelanto: *S/ 88.50*.";
  const r = (mensaje: string | null, derivar = false): ResultadoReservaIA => ({ respuestaModelo: "{}", mensaje, ...(derivar ? { derivar: { motivo: "m", pedido: "p", nota: "n" } } : {}) });
  const x = { estilo: USTED, numeroCotizacion: "00736", hayCotizacionTraslado: true };
  t("el mensaje del código gana sobre el del modelo", textoFinalReserva("¡Su pago está confirmado! Son S/ 50.", [r(T1)], x) === T1);
  t("varios mensajes en orden, sin repetir el mismo seguido", textoFinalReserva("x", [r("A"), r("A"), r(null), r("B")], x) === "A\n\nB");
  t("derivar sin mensaje → la derivación", textoFinalReserva("Le cobramos S/ 50", [r(null, true)], { ...x, derivacion: "Un ejecutivo…" }) === "Un ejecutivo…");
  t("guarda: dinero con cotización en el chat → T10", textoFinalReserva("El adelanto es de S/ 50, deposite hoy.", [], x) === mensajeGuardaReserva("00736", USTED));
  t("guarda: porcentaje → T10", textoFinalReserva("Se paga el 50 % por adelantado.", [r(null)], x) === mensajeGuardaReserva("00736", USTED));
  t("guarda: número de cuenta → T10", textoFinalReserva("Deposite a la cuenta 191-1234567-0-12 del BCP", [], x) === mensajeGuardaReserva("00736", USTED));
  t("guarda de tú", textoFinalReserva("Son S/ 50", [], { ...x, estilo: TU }) === mensajeGuardaReserva("00736", TU));
  t("texto neutro → null (manda textoSinImportesAjenos)", textoFinalReserva("¿Para qué fecha sería su viaje?", [], x) === null);
  t("una hora o una fecha no es un número largo", textoFinalReserva("Su recojo es el 25/12/2026 a las 15:00.", [], x) === null);
  t("sin cotización de traslado en el chat → null aunque hable de dinero", textoFinalReserva("Son S/ 50", [], { ...x, hayCotizacionTraslado: false }) === null);
  t("la cotización del turno manda → null", textoFinalReserva("Son S/ 50", [], { ...x, cotizoEnElTurno: true }) === null);
  t("mensajePedirComprobante de usted y de tú", mensajePedirComprobante(USTED).startsWith("Para registrar su pago, envíenos") && mensajePedirComprobante(TU).startsWith("Para registrar tu pago, envíanos"));
}

// ── 6. El bloque del prompt ──────────────────────────────────────────────────
{
  const b = bloqueReservaTraslados();
  t("encabezado", b.startsWith("## Reserva y pago de traslados\n"));
  t("sin montos, porcentajes ni cifras", !/\d|%|S\/|US\$/.test(b) && !mencionaDinero(b));
  t("nombra las cuatro herramientas y escalar_a_humano", NOMBRES_HERRAMIENTAS_RESERVA.every((n) => b.includes(n)) && b.includes("escalar_a_humano"));
  t("nunca «pago confirmado» y la unidad la confirma un ejecutivo", b.includes("Nunca digas que un pago está confirmado") && b.includes("la confirma un ejecutivo"));
  t("la frase que se reemplaza sigue en el bloque de traslados de hoy", bloqueTraslados("todo_junto").includes(FRASE_PROPONER_RESERVA_TRASLADOS) && bloqueTraslados("una_por_mensaje").includes(FRASE_PROPONER_RESERVA_TRASLADOS));
  t("la frase nueva nombra reservar_traslado y no promete nada de dinero", FRASE_RESERVAR_TRASLADO.includes("reservar_traslado") && !mencionaDinero(FRASE_RESERVAR_TRASLADO) && !/\d/.test(FRASE_RESERVAR_TRASLADO));
}

// ── 7. Lo que dice Ajustes ───────────────────────────────────────────────────
{
  const cfg = normalizarConfigReserva({ reserva_ia: true, reserva_adelanto_pct: 50, reserva_correo: "a@b.pe" });
  const base = { sinMigracion: false, cfg, iaCotiza: true, agenteAutonomo: true, atencionEnUso: true, cuentas: 2, correos: ["a@b.pe"], politicaLineas: 6, contradicciones: 0 };
  const e = estadoReservaIA(base);
  t("todo en orden → activo, sin ámbar", e.codigo === "activo" && e.activa && !e.ambar);
  t("sin migración → ámbar, no activa", (() => { const r = estadoReservaIA({ ...base, sinMigracion: true }); return r.codigo === "sin_migracion" && !r.activa && r.ambar; })());
  t("apagada → no activa, sin ámbar", (() => { const r = estadoReservaIA({ ...base, cfg: { ...cfg, activa: false } }); return r.codigo === "apagado" && !r.activa && !r.ambar; })());
  t("sin traslados → no activa, ámbar", estadoReservaIA({ ...base, iaCotiza: false }).codigo === "sin_traslados");
  t("copiloto → no activa", estadoReservaIA({ ...base, agenteAutonomo: false }).activa === false);
  t("sin cuentas → ámbar", (() => { const r = estadoReservaIA({ ...base, cuentas: 0 }); return r.codigo === "sin_cuentas" && r.ambar && r.activa; })());
  t("contradicciones, sin horario y sin correo → ámbar con sus líneas", (() => { const r = estadoReservaIA({ ...base, contradicciones: 2, atencionEnUso: false, correos: [] }); return r.ambar && r.lineas.length >= 4; })());
  t("los códigos cumplen el formato", ["sin_migracion", "apagado", "sin_traslados", "agente_no_autonomo", "sin_adelanto", "sin_cuentas", "sin_politica", "activo"].every((c) => /^[a-z_]{2,40}$/.test(c)));
}

// ── 8. Topes ─────────────────────────────────────────────────────────────────
{
  t("un conteo que no se pudo leer bloquea", !decidirTopeReserva({ conv: null, dia: 0 }, "solicitud").ok && !decidirTopeReserva({ conv: 0, dia: null }, "lectura").ok);
  t("por debajo del tope pasa", decidirTopeReserva({ conv: 0, dia: 0, turno: 0 }, "solicitud").ok && decidirTopeReserva({ conv: TOPES_RESERVA.MAX_LECTURAS_CONV_DIA - 1, dia: 0 }, "lectura").ok);
  t("en el tope no pasa", !decidirTopeReserva({ conv: TOPES_RESERVA.MAX_SOLICITUDES_CONV_DIA, dia: 0 }, "solicitud").ok && !decidirTopeReserva({ conv: 0, dia: TOPES_RESERVA.MAX_LECTURAS_DIA }, "lectura").ok && !decidirTopeReserva({ conv: 0, dia: 0, turno: TOPES_RESERVA.MAX_HERRAMIENTAS_RESERVA_TURNO }, "lectura").ok);
}

if (fallas.length) for (const f of fallas) console.log("✗", f);
console.log(`\n${ok} OK · ${mal} mal`);
if (mal > 0 || fallas.length > 0) process.exit(1);
console.log("Todo OK");
