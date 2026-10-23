// ANTHROPIC_API_KEY=x npx tsx scripts/prueba-reserva-ia.mts
// Lo que el agente IA ve de la reserva de traslados (lib/traslados/reserva-ia.ts). Fija:
//  · ningún esquema de herramienta tiene monto, moneda, teléfono, cuenta ni destinatario, y sus
//    textos no llevan cifras (un número en el prompt es un número que el modelo copia);
//  · toda respuesta al modelo está en la lista blanca y no menciona dinero;
//  · `textoFinalReserva`: el mensaje del código gana; la guarda T10 salta con dinero o un número
//    largo cuando hay una cotización de traslado; sin cotización, o con la cotización del turno, no;
//  · `bloqueReservaTraslados` sin montos, porcentajes ni cuentas, y la frase que reemplaza sigue en
//    el prompt de hoy (lib/crm-ia.ts → bloqueTraslados).
//  · la auditoría de seguridad (23-10-2026), de punta a punta: el vuelo es un código de vuelo; no se
//    le reenvían cuentas distintas de las que recibió (9h); lo que no es comprobante no frena (9i);
//    solo cuenta un archivo que llegó por Meta (9j) y de crm-media (9k); el pago sin cotización no se
//    lee con IA y se avisa una vez, con tope y el adjunto por su contenido (9l); políticas
//    sospechosas no salen (9m); el contacto se ata solo con el número del chat (9n); la Confirmación
//    y el crédito exigen un cliente verificado (9o, 9p); un error de la base no llega a la tarjeta
//    (9q, y `mensajeSeguro` en 8b); «No encontré el pago» no pisa el payload (9r).
// Lo que NO fija todavía: «con la reserva apagada, el prompt de crm-ia byte a byte el de antes».
// Eso lo conecta B3 en lib/crm-ia.ts y lo fija su matriz.
import {
  ACCIONES_POR_HERRAMIENTA, CLAVES_COTIZACION_RESERVA, CLAVES_RESPUESTA_RESERVA, FRASE_PROPONER_RESERVA_TRASLADOS, FRASE_RESERVAR_TRASLADO,
  HERRAMIENTAS_RESERVA, INSTRUCCION_RESERVA, NOMBRES_HERRAMIENTAS_RESERVA, TOPES_RESERVA, bloqueReservaTraslados, decidirTopeReserva,
  RE_VUELO, elegirCotizacion, entradaReserva, estadoReservaIA, mensajePedirComprobante, respuestaReservaParaModelo, textoFinalReserva,
  type AccionReserva, type CotizacionCandidata, type ResultadoReservaIA,
} from "../lib/traslados/reserva-ia";
import { mensajeGuardaReserva, normalizarConfigReserva } from "../lib/traslados/reserva-pago";
import { importesEnTexto, mencionaDinero } from "../lib/traslados/texto-libre";
import { bloqueTraslados } from "../lib/crm-ia";
import { MENSAJE_GENERICO, mensajeSeguro } from "../lib/mensaje-seguro";
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
  // El vuelo se imprime en la Confirmación: solo un código de vuelo (aerolínea de 2 + 1-4 dígitos + letra).
  const vuelo = (v: string) => entradaReserva({ vuelo: v }).vuelo;
  t("vuelo: «SALDO 0 PAGADO» no es un vuelo (la regla vieja lo dejaba pasar)", vuelo("SALDO 0 PAGADO") === null && /^[A-Z0-9][A-Z0-9 -]{1,19}$/.test("SALDO 0 PAGADO") && /\d/.test("SALDO 0 PAGADO"));
  t("vuelo: códigos buenos pasan (con y sin espacio o guion, aerolínea con dígito, letra final)",
    vuelo("LA2047") === "LA2047" && vuelo("la 2047") === "LA 2047" && vuelo("H2-1234A") === "H2-1234A" && vuelo("2I 5") === "2I 5" && vuelo("AV 1") === "AV 1");
  t("vuelo: lo que no es un código se descarta", ["2047", "LA 20477", "LAN 2047", "PAGADO 50", "LA 2047 B", "S/ 50", "LA_2047", "L 2047", "LA--2047"].every((v) => vuelo(v) === null));
  t("vuelo: RE_VUELO es la regla", RE_VUELO.test("LA 2047") && !RE_VUELO.test("SALDO 0 PAGADO"));
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
  t("correo sin cotización: su propio tope, y sin poder contar no pasa",
    decidirTopeReserva({ conv: TOPES_RESERVA.MAX_CORREOS_SIN_COTIZACION_CONV_DIA - 1, dia: 0 }, "correo_sin_cotizacion").ok
    && !decidirTopeReserva({ conv: TOPES_RESERVA.MAX_CORREOS_SIN_COTIZACION_CONV_DIA, dia: 0 }, "correo_sin_cotizacion").ok
    && !decidirTopeReserva({ conv: 0, dia: TOPES_RESERVA.MAX_CORREOS_SIN_COTIZACION_DIA }, "correo_sin_cotizacion").ok
    && !decidirTopeReserva({ conv: null, dia: 0 }, "correo_sin_cotizacion").ok);
}

// ── 8b. Lo que se le enseña al usuario de un error (lib/mensaje-seguro.ts) ───
{
  t("sin opciones, la regla del route de la Confirmación (los tres prefijos y el genérico)",
    mensajeSeguro(new Error("Ese cobro ya está aplicado a un comprobante: se corrige en Finanzas.")) === "Ese cobro ya está aplicado a un comprobante: se corrige en Finanzas."
    && mensajeSeguro(new Error("Falta correr supabase/x.sql.")) === "Falta correr supabase/x.sql."
    && mensajeSeguro(new Error('duplicate key value violates unique constraint "uq_x"')) === MENSAJE_GENERICO
    && mensajeSeguro(new Error("No se pudo leer la reserva: permission denied for table reservas")) === MENSAJE_GENERICO);
  const R = /^(No se pudo|Falta\b|La cotización\b)/;
  t("con cortarDetalle: «No se pudo X: <base>» → «No se pudo X.» sin el texto de la base",
    mensajeSeguro(new Error('No se pudo cerrar la solicitud: new row for relation "reserva_solicitudes" violates check constraint "ck"'), { propios: R, cortarDetalle: true })
      === "No se pudo cerrar la solicitud. Vuelve a intentar en un momento.");
  t("un mensaje propio sin detalle pasa entero; uno ajeno cae al genérico",
    mensajeSeguro("La cotización 5 ya no existe.", { propios: R, cortarDetalle: true }) === "La cotización 5 ya no existe."
    && mensajeSeguro("TypeError: fetch failed", { propios: R, cortarDetalle: true }) === MENSAJE_GENERICO
    && mensajeSeguro(null, { propios: R }) === MENSAJE_GENERICO);
}

// ── 9. De punta a punta, sobre una base falsa en memoria (B3) ────────────────
// Lo que conecta lib/traslados/reserva-solicitud-datos.ts: aceptar → comprobante → hay unidad →
// Tesorería registra → la Confirmación ve el adelanto; aceptar → no hay unidad → devolución;
// cancelación tardía → devolución parcial → comprobante del cargo (una sola vez); y el ciclo
// inverso: un cobro registrado por la Confirmación lo ve la solicitud. Sin red: el lector del
// comprobante, el correo y el WhatsApp van inyectados.
{
  type Fila = Record<string, any>;
  class Sb {
    tablas: Record<string, Fila[]> = {};
    n = 1000;
    /** Un error de la base para la consulta (tabla, operación); null = sin falla. */
    falla: ((tabla: string, op: string) => any) | null = null;
    reloj: () => number;
    constructor(reloj: () => number) { this.reloj = reloj; }
    t(nombre: string) { return (this.tablas[nombre] ??= []); }
    from(tabla: string) { return new Q(this, tabla); }
    storage = { from: (_b: string) => ({ download: async () => ({ data: null, error: { message: "sin storage" } }), createSignedUrl: async () => ({ data: { signedUrl: "https://firmado.test/x" } }), upload: async () => ({ error: null }), getPublicUrl: (r: string) => ({ data: { publicUrl: `https://sb.test/${r}` } }) }) };
  }
  const UUIDS = new Set(["crm_conversaciones", "crm_contactos", "crm_mensajes", "crm_acciones_ia", "crm_notas", "alerta_enviada"]);
  class Q implements PromiseLike<any> {
    op: "select" | "insert" | "update" | "delete" = "select";
    cols = "*"; head = false; contar = false; ret = false; payload: any = null;
    filtros: ((f: Fila) => boolean)[] = []; ordenes: { c: string; asc: boolean }[] = [];
    desde = 0; hasta = Infinity; uno: "single" | "maybe" | null = null;
    constructor(private sb: Sb, private tabla: string) {}
    select(cols = "*", o?: { count?: string; head?: boolean }) { if (this.op === "select") { this.cols = cols; this.contar = !!o?.count; this.head = !!o?.head; } else this.ret = true; return this; }
    insert(v: any) { this.op = "insert"; this.payload = v; return this; }
    update(v: any) { this.op = "update"; this.payload = v; return this; }
    delete() { this.op = "delete"; return this; }
    eq(c: string, v: any) { this.filtros.push((f) => f[c] != null && String(f[c]) === String(v)); return this; }
    neq(c: string, v: any) { this.filtros.push((f) => String(f[c]) !== String(v)); return this; }
    gte(c: string, v: any) { this.filtros.push((f) => f[c] != null && f[c] >= v); return this; }
    lt(c: string, v: any) { this.filtros.push((f) => f[c] != null && f[c] < v); return this; }
    like(c: string, pat: string) { const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`); this.filtros.push((f) => re.test(String(f[c] ?? ""))); return this; }
    ilike(c: string, pat: string) { const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`, "i"); this.filtros.push((f) => re.test(String(f[c] ?? ""))); return this; }
    in(c: string, vs: any[]) { this.filtros.push((f) => vs.map(String).includes(String(f[c]))); return this; }
    is(c: string, v: null) { this.filtros.push((f) => (v === null ? f[c] == null : f[c] === v)); return this; }
    not(c: string, op: string, v: null) { if (op === "is" && v === null) this.filtros.push((f) => f[c] != null); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.ordenes.push({ c, asc: o?.ascending !== false }); return this; }
    range(a: number, b: number) { this.desde = a; this.hasta = b; return this; }
    limit(n: number) { this.hasta = this.desde + n - 1; return this; }
    single() { this.uno = "single"; return this; }
    maybeSingle() { this.uno = "maybe"; return this; }
    then<A, B>(ok?: ((v: any) => A | PromiseLike<A>) | null, mal?: ((e: any) => B | PromiseLike<B>) | null): PromiseLike<A | B> { return Promise.resolve().then(() => this.ejecutar()).then(ok, mal); }
    private ejecutar(): any {
      const sb = this.sb, tabla = this.tabla, filas = sb.t(tabla);
      const f = sb.falla?.(tabla, this.op);
      if (f) return { data: null, error: f };
      const ahora = new Date(sb.reloj()).toISOString();
      if (this.op === "insert") {
        const lista = Array.isArray(this.payload) ? this.payload : [this.payload];
        const nuevas: Fila[] = [];
        for (const p of lista) {
          const fila: Fila = { ...p };
          if (tabla === "facturas" && "total" in fila) return { data: null, error: { code: "428C9", message: 'cannot insert a non-DEFAULT value into column "total"' } };
          // uq_facturas_reserva_solicitud (reservas-09d): un comprobante de cargo vivo por solicitud.
          if (tabla === "facturas" && fila.reserva_solicitud_id != null && filas.some((x) => x.reserva_solicitud_id === fila.reserva_solicitud_id))
            return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "uq_facturas_reserva_solicitud"' } };
          if (tabla === "reserva_solicitudes" && ["esperando_pago", "por_confirmar", "pago_reportado", "confirmada"].includes(fila.estado)
            && filas.some((x) => x.cotizacion_id === fila.cotizacion_id && ["esperando_pago", "por_confirmar", "pago_reportado", "confirmada"].includes(x.estado)))
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"uq_reserva_solicitudes_viva\"" } };
          if (tabla === "reserva_solicitud_comprobantes" && fila.mensaje_id && filas.some((x) => x.mensaje_id === fila.mensaje_id))
            return { data: null, error: { code: "23505", message: "duplicate key value" } };
          if (tabla === "alerta_enviada" && filas.some((x) => x.clave === fila.clave && x.ref === fila.ref && x.fecha === fila.fecha))
            return { data: null, error: { code: "23505", message: "duplicate key value" } };
          fila.id ??= UUIDS.has(tabla) ? `00000000-0000-4000-8000-${String(++sb.n).padStart(12, "0")}` : ++sb.n;
          if (tabla === "crm_acciones_ia") fila.creada_at ??= ahora;
          else if (tabla === "reserva_solicitudes") { fila.creada_en ??= ahora; fila.actualizada_en ??= ahora; fila.motivos_orden ??= []; fila.urgente ??= false; }
          else if (tabla === "reserva_solicitud_comprobantes") { fila.creado_en ??= ahora; fila.cotejo ??= []; }
          else fila.created_at ??= ahora;
          if (tabla === "pagos") { fila.anulado ??= false; fila.codigo ??= `${fila.sentido === "pago" ? "PAG" : "COB"}-${fila.id}`; }
          if (tabla === "facturas") fila.total = Number(fila.subtotal ?? 0) + Number(fila.igv ?? 0);
          if (tabla === "reservas") fila.codigo ??= `R-${fila.id}`;
          if (tabla === "reserva_confirmaciones") { fila.generado_en ??= ahora; if (filas.some((x) => x.reserva_id === fila.reserva_id && x.version === fila.version)) return { data: null, error: { code: "23505", message: "duplicate" } }; }
          filas.push(fila); nuevas.push(fila);
        }
        return this.resultado(nuevas);
      }
      let sel = filas.filter((f) => this.filtros.every((p) => p(f)));
      if (this.op === "update") {
        for (const f of sel) {
          Object.assign(f, this.payload);
          if (tabla === "reserva_solicitudes") f.actualizada_en = ahora;
          if (tabla === "facturas") f.total = Number(f.subtotal ?? 0) + Number(f.igv ?? 0);
        }
        return this.ret ? this.resultado(sel) : { data: null, error: null };
      }
      if (this.op === "delete") { sb.tablas[tabla] = filas.filter((f) => !sel.includes(f)); return { data: null, error: null }; }
      for (const { c, asc } of [...this.ordenes].reverse()) sel = [...sel].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
      if (this.contar && this.head) return { data: null, count: sel.length, error: null };
      sel = sel.slice(this.desde, this.hasta === Infinity ? undefined : this.hasta + 1);
      return this.resultado(sel);
    }
    private resultado(sel: Fila[]): any {
      const conEmb = sel.map((f) => { const o = { ...f }; if (/crm_contactos\(/.test(this.cols)) o.crm_contactos = this.sb.t("crm_contactos").find((x) => x.id === f.contacto_id) ?? null; return o; });
      if (this.uno === "single") return conEmb.length === 1 ? { data: conEmb[0], error: null } : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
      if (this.uno === "maybe") return { data: conEmb[0] ?? null, error: null };
      return { data: conEmb, error: null };
    }
  }

  const D = await import("../lib/traslados/reserva-solicitud-datos");
  const { leerEntrada, registrarAdelanto } = await import("../lib/confirmacion-reserva-datos");
  const { cobradoEn } = await import("../lib/confirmacion-reserva");
  const { adelantoDe: adelantoDeCot } = await import("../lib/traslados/reserva-pago");

  // Miércoles 21-10-2026, 10:00 de Lima (dentro del horario de atención lun-sáb 09:00-17:00).
  let reloj = Date.parse("2026-10-21T15:00:00Z");
  const sb = new Sb(() => reloj);
  sb.tablas.empresa_perfil = [{ id: 1, nombre: "Transportes Ejemplo", razon_social: "Transportes Ejemplo SAC", ruc: "20100070970", email: "info@ejemplo.test", telefono: "01 000 0000", cuentas_bancarias: [{ banco: "Banco Uno", cuenta: "191-1234567-0-11", cci: "00219100123456701155", moneda: "PEN" }] }];
  sb.tablas.traslados_config = [{ id: 1, ia_cotiza: true, envio_automatico: true, reserva_ia: true, reserva_adelanto_pct: 50, reserva_correo: "ops@ejemplo.test", reserva_plazo_confirmacion_min: 120, reserva_margen_min: 360, reserva_devolucion_plazo_h: 48 }];
  sb.tablas.crm_agentes_ia = [{ id: "ag", created_at: "2026-01-01", modelo: "claude-opus-4-8", canales_autonomos: ["whatsapp"], comportamiento: { atencion_activa: true, atencion_dias: [1, 2, 3, 4, 5, 6], atencion_desde: "09:00", atencion_hasta: "17:00" } }];
  sb.tablas.zonas_traslado = [{ id: 1, nombre: "Aeropuerto", tipo: "punto", padre_id: null, activo: true, envio_automatico: true }, { id: 2, nombre: "Miraflores", tipo: "distrito", padre_id: null, activo: true, envio_automatico: false }];
  sb.tablas.clientes = [{ id: 7, nombre: "Ana Cliente", empresa: null, ruc: null, condicion_pago: null, telefono: "987654321" }];
  sb.tablas.usuarios = [{ id: "u-1", nombre: "Ejecutiva" }];
  const POLITICA = ["La reserva se confirma con el 50 % de adelanto.", "Con 24 h o más: devolución del 100 % en un máximo de 48 h."];

  let nCot = 0;
  /** Una conversación con su contacto y una cotización de traslado ENVIADA por la IA. */
  const escenario = (x: { fecha?: string; hora?: string } = {}) => {
    const k = ++nCot;
    const contacto = { id: `ct-${k}`, nombre: `Cliente ${k}`, wa_id: `5198765432${k}`, telefono: null, cliente_id: 7 };
    const conv = { id: `cv-${k}`, canal: "whatsapp", phone_number_id: "PN", contacto_id: contacto.id };
    sb.t("crm_contactos").push(contacto); sb.t("crm_conversaciones").push(conv);
    const cotId = 500 + k;
    sb.t("cotizaciones").push({
      id: cotId, numero_cotizacion: `00${cotId}`, estado: "enviado", created_at: "2026-10-20T15:00:00.000Z", cliente_id: 7,
      origen: "Aeropuerto", destino: "Miraflores (Hotel)", fecha_servicio: x.fecha ?? "2026-10-25", hora_ida: x.hora ?? "15:00",
      fecha_retorno: x.fecha ?? "2026-10-25", hora_retorno: "20:00", tipo_servicio: "ida_retorno", modo_servicio: "eventual",
      items_json: [{ descripcion: "Traslado ida y retorno", dias: 1, cantidad: 1, precio_unit: 200, descuento_pct: 0, pax_contratado: null }],
      incluye_igv: true, precio_cliente: 200, moneda: "PEN", tipo_cambio: null, atencion: "Cliente", paradas_json: null, asunto: null,
      vehiculo_flota_id: null, vehiculo_tercero_id: null, plantilla_pdf: null, crm_conversacion_id: conv.id,
      consideraciones_json: { incluye: [], no_incluye: [], generales: [], reserva: POLITICA, version: 2, plantilla: "traslados_ia" },
      traslado_json: { zona_origen: { id: 1, nombre: "Aeropuerto", tipo: "punto" }, zona_destino: { id: 2, nombre: "Miraflores", tipo: "distrito" }, validez_hasta: "2026-11-19" },
    });
    sb.t("crm_acciones_ia").push({ id: `acc-cot-${k}`, conversacion_id: conv.id, contacto_id: contacto.id, tipo: "cotizacion_traslado", estado: "aprobada", resultado_id: cotId, payload: { cotizacion_id: cotId, envio: { at: "2026-10-20T15:05:00.000Z", por: "automatico" } }, creada_at: "2026-10-20T15:05:00.000Z" });
    sb.t("crm_mensajes").push({ id: `m-${k}-1`, conversacion_id: conv.id, direccion: "entrante", tipo: "texto", contenido: "Sí, quiero reservar", created_at: new Date(reloj - 60_000).toISOString() });
    return { contacto, conv, cotId };
  };
  const textos: { conv: string; texto: string }[] = [];
  const correos: { to: string; subject: string; adjuntos: number; html: string; nombre: string | null }[] = [];
  let lecturas = 0;
  /** Los primeros bytes de un JPEG (el adjunto se reconoce por su contenido, no por el tipo declarado). */
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  let bytesSiguientes: Uint8Array = JPEG;
  let lecturaSiguiente: any = null;
  const deps: any = {
    ahoraMs: () => reloj, azar: () => String(Math.random()).slice(2, 8), uuid: () => "uuid-x", appUrl: "https://erp.test",
    leerComprobante: async () => { lecturas++; return { ok: true, lectura: lecturaSiguiente, crudo: "{}" }; },
    enviarCorreo: async (c: any) => { correos.push({ to: c.to, subject: c.subject, adjuntos: c.attachments?.length ?? 0, html: c.html, nombre: c.attachments?.[0]?.filename ?? null }); },
    enviarTexto: async (s: any, conv: any, _ct: any, texto: string) => { textos.push({ conv: conv.id, texto }); await s.from("crm_mensajes").insert({ conversacion_id: conv.id, direccion: "saliente", tipo: "texto", contenido: texto, generado_por_ia: true }); return { error: null, metaId: "wamid" }; },
    bajarArchivo: async () => ({ bytes: bytesSiguientes, mime: "image/jpeg" }),
  };
  const cfg = (await import("../lib/traslados/datos")).leerConfigIA;
  const cfgIA = await cfg(sb);
  t("e2e: leerConfigIA lee la reserva (encendida, 50 %, tablas comprobadas)", cfgIA.reservaIA === true && cfgIA.reserva.adelantoPct === 50 && cfgIA.reserva.plazoConfirmacionMin === 120);
  const ctxDe = (e: ReturnType<typeof escenario>) => ({
    sb, conv: e.conv, contacto: e.contacto, remitente: { canal: "whatsapp", waId: e.contacto.wa_id }, agente: sb.tablas.crm_agentes_ia[0],
    modoAuto: true, cfg: cfgIA.reserva, turno: { n: 0 },
  });
  // Un entrante con archivo que llegó por Meta (el webhook guarda su `meta_message_id`).
  const foto = (e: ReturnType<typeof escenario>, id: string, x: { meta?: string | null; bucket?: string } = {}) => sb.t("crm_mensajes").push({
    id, conversacion_id: e.conv.id, direccion: "entrante", tipo: "image", meta_message_id: x.meta === undefined ? `wamid.${id}` : x.meta,
    media_url: `https://sb.test/storage/v1/object/public/${x.bucket ?? "crm-media"}/${id}.jpg`, created_at: new Date(reloj).toISOString(),
  });
  const lecturaDe = (monto: number, op: string) => ({ es_comprobante: true, monto, texto_monto: `S/ ${monto.toFixed(2)}`, moneda: "PEN", fecha: "2026-10-21", hora: "09:58", numero_operacion: op, medio: "transferencia", banco_origen: "Banco Dos", banco_destino: "Banco Uno", cuenta_destino: "****0-11", titular_destino: null, confianza: "alta" });
  const tarjeta = async (e: ReturnType<typeof escenario>, solId: number) => {
    const accId = sb.t("reserva_solicitudes").find((s) => s.id === solId)!.crm_accion_id;
    const r = await D.cargarCadena(sb, { solicitudId: solId, conversacionId: e.conv.id, accionId: accId });
    if (!r.ok) throw new Error(r.detalle);
    return r.c;
  };
  const quien = { id: "u-1", nombre: "Ejecutiva" };
  const solDe = (cotId: number) => sb.t("reserva_solicitudes").filter((s) => s.cotizacion_id === cotId).at(-1)!;
  const hoyIso = "2026-10-21";

  // ── 9a. Aceptar → comprobante → hay unidad → Tesorería registra → la Confirmación lo ve ──
  {
    const e = escenario();
    const adel = adelantoDeCot(sb.t("cotizaciones").find((c) => c.id === e.cotId) as any, 50)!;
    const r1 = await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    const s1 = solDe(e.cotId);
    t("9a: reservar → pedir_pago (respuesta en lista blanca)", JSON.parse(r1.respuestaModelo).accion === "pedir_pago");
    t("9a: el mensaje es T1 con el adelanto y las cuentas", !!r1.mensaje && r1.mensaje.includes("adelanto") && r1.mensaje.includes("191-1234567-0-11") && r1.mensaje.includes(adel.adelanto!.toFixed(2)));
    t("9a: la solicitud nace esperando_pago, pago primero, con plazo y firma", s1.estado === "esperando_pago" && s1.orden === "pago_primero" && !!s1.confirmar_antes_de && !!s1.firma_importes && Number(s1.adelanto_pct) === 50);
    const acc = sb.t("crm_acciones_ia").find((a) => a.id === s1.crm_accion_id);
    t("9a: la tarjeta reserva_traslado queda pendiente y apunta a la solicitud", acc?.tipo === "reserva_traslado" && acc?.estado === "pendiente" && acc?.payload?.solicitud_id === s1.id);
    const rYa = await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    t("9a: reservar otra vez → ya_solicitada y vuelve a mandar T1 (sin otra solicitud)", JSON.parse(rYa.respuestaModelo).accion === "ya_solicitada" && rYa.mensaje === r1.mensaje && sb.t("reserva_solicitudes").filter((s) => s.cotizacion_id === e.cotId).length === 1);
    const rSin = await D.reportarPagoIA(ctxDe(e), {}, deps);
    t("9a: sin foto nueva → pedir_comprobante", JSON.parse(rSin.respuestaModelo).accion === "pedir_comprobante" && !!rSin.mensaje);
    reloj += 10 * 60_000;
    foto(e, "m-1-foto");
    lecturaSiguiente = lecturaDe(adel.adelanto!, "OP-0001");
    const r2 = await D.reportarPagoIA(ctxDe(e), {}, deps);
    const s2 = solDe(e.cotId);
    t("9a: comprobante → comprobante_registrado y T3 con el monto (lectura segura)", JSON.parse(r2.respuestaModelo).accion === "comprobante_registrado" && !!r2.mensaje && r2.mensaje.includes("Recibimos su comprobante") && r2.mensaje.includes(adel.adelanto!.toFixed(2)));
    t("9a: la solicitud pasa a pago_reportado con el plazo recalculado", s2.estado === "pago_reportado" && !!s2.confirmar_antes_de);
    const comp = sb.t("reserva_solicitud_comprobantes").find((k) => k.solicitud_id === s2.id);
    t("9a: el comprobante queda como evidencia, con su cotejo y el correo (JPEG reconocido → adjunto .jpg)", !!comp && comp.cotejo.includes("coincide") && !!comp.correo_en
      && correos.some((c) => /Pago REPORTADO/.test(c.subject) && c.adjuntos === 1 && /\.jpg$/.test(c.nombre ?? "")));
    t("9a: un comprobante NO crea ningún cobro", !sb.t("pagos").some((p) => p.reserva_solicitud_id === s2.id));
    const r2b = await D.reportarPagoIA(ctxDe(e), {}, deps);
    t("9a: la misma foto otra vez → ya_registrado", JSON.parse(r2b.respuestaModelo).accion === "ya_registrado");
    // Una cadena ajena no pasa.
    const ajena = await D.cargarCadena(sb, { solicitudId: s2.id, conversacionId: "cv-otra", accionId: s2.crm_accion_id });
    t("9a: conversación ajena → ajena", !ajena.ok && ajena.codigo === "ajena");
    const ajena2 = await D.cargarCadena(sb, { solicitudId: s2.id, conversacionId: e.conv.id, accionId: "acc-cot-1" });
    t("9a: tarjeta ajena → ajena", !ajena2.ok && ajena2.codigo === "ajena");
    // Hay unidad.
    const c3 = await tarjeta(e, s2.id);
    const r3 = await D.confirmarDisponibilidad(sb, c3, quien, deps);
    const s3 = solDe(e.cotId);
    const tramos = sb.t("reservas").filter((r) => r.cotizacion_id === e.cotId);
    t("9a: hay unidad → confirmada, reserva creada (ida + retorno) y cotización aprobada", r3.ok && s3.estado === "confirmada" && tramos.length === 2 && s3.reserva_id === Math.min(...tramos.map((x) => x.id)) && sb.t("cotizaciones").find((c) => c.id === e.cotId)!.estado === "aprobado");
    t("9a: T4 con el pago reportado (sin cuentas)", r3.enviado === true && !!r3.mensaje && r3.mensaje.includes("hay una unidad disponible") && r3.mensaje.includes("validemos su pago") && !r3.mensaje.includes("191-1234567"));
    t("9a: la tarjeta sigue pendiente (falta la Confirmación)", sb.t("crm_acciones_ia").find((a) => a.id === s3.crm_accion_id)!.estado === "pendiente");
    const r3b = await D.confirmarDisponibilidad(sb, await tarjeta(e, s3.id), quien, deps);
    t("9a: hay unidad dos veces → transicion_invalida (no crea otra reserva)", !r3b.ok && r3b.codigo === "transicion_invalida" && sb.t("reservas").filter((r) => r.cotizacion_id === e.cotId).length === 2);
    // Tesorería registra el adelanto.
    const r4 = await D.registrarAdelantoSolicitud(sb, await tarjeta(e, s3.id), { monto: adel.adelanto, fecha: hoyIso, metodo: "transferencia", referencia: "OP-0001" }, quien, deps);
    const pago = sb.t("pagos").find((p) => p.reserva_solicitud_id === s3.id);
    t("9a: Tesorería registra el adelanto: cobro con la solicitud, la reserva y el comprobante", r4.ok && pago?.sentido === "cobro" && pago?.reserva_id === s3.reserva_id && !!pago?.comprobante_url);
    const rMas = await D.registrarAdelantoSolicitud(sb, await tarjeta(e, s3.id), { monto: adel.total, fecha: hoyIso, metodo: "transferencia", referencia: "OP-9" }, quien, deps);
    t("9a: un cobro que pasa del total se rechaza", !rMas.ok && rMas.codigo === "datos_invalidos");
    const { entrada } = await leerEntrada(sb, s3.reserva_id, null);
    t("9a: la Confirmación de Reserva ve el adelanto", Math.abs(cobradoEn(entrada.pagos as any, "PEN") - adel.adelanto!) < 0.005);
    const v = await D.vistaSolicitud(sb, await tarjeta(e, s3.id), deps);
    t("9a: la vista dice que falta emitir la Confirmación", v.pendientes.some((p) => p.codigo === "emitir_confirmacion") && v.dinero.cobrado === adel.adelanto && v.acciones.includes("enviar_confirmacion"));
  }

  // ── 9b. Aceptar → no hay unidad → devolución del 100 % ──
  {
    const e = escenario();
    const adel = adelantoDeCot(sb.t("cotizaciones").find((c) => c.id === e.cotId) as any, 50)!;
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    reloj += 5 * 60_000;
    foto(e, "m-2-foto");
    lecturaSiguiente = lecturaDe(adel.adelanto!, "OP-0002");
    await D.reportarPagoIA(ctxDe(e), {}, deps);
    const s = solDe(e.cotId);
    const rA = await D.registrarAdelantoSolicitud(sb, await tarjeta(e, s.id), { monto: adel.adelanto, fecha: hoyIso, metodo: "yape", referencia: "Y-1" }, quien, deps);
    t("9b: el adelanto entra sin reserva todavía (reserva_id vacío)", rA.ok && sb.t("pagos").some((p) => p.reserva_solicitud_id === s.id && p.reserva_id == null));
    const rS = await D.sinUnidad(sb, await tarjeta(e, s.id), quien, deps);
    const s2 = solDe(e.cotId);
    t("9b: no hay unidad → sin_unidad, 100 %, cerrada_en y T5 con la devolución", rS.ok && s2.estado === "sin_unidad" && Number(s2.devolucion_pct) === 100 && !!s2.cerrada_en && !!rS.mensaje && rS.mensaje.includes("devolvemos el 100 %") && rS.mensaje.includes("48 horas"));
    const v = await D.vistaSolicitud(sb, await tarjeta(e, s2.id), deps);
    t("9b: falta registrar la devolución (Tesorería) y la tarjeta sigue pendiente", v.pendientes.some((p) => p.codigo === "registrar_devolucion" && p.quien === "tesoreria") && sb.t("crm_acciones_ia").find((a) => a.id === s2.crm_accion_id)!.estado === "pendiente");
    const rMas = await D.registrarDevolucionSolicitud(sb, await tarjeta(e, s2.id), { monto: adel.adelanto! + 1, fecha: hoyIso, metodo: "transferencia", referencia: "D-1" }, quien, deps);
    t("9b: una devolución mayor que lo cobrado se rechaza", !rMas.ok && rMas.codigo === "datos_invalidos");
    const rD = await D.registrarDevolucionSolicitud(sb, await tarjeta(e, s2.id), { monto: adel.adelanto, fecha: hoyIso, metodo: "transferencia", referencia: "D-1" }, quien, deps);
    const dev = sb.t("pagos").find((p) => p.reserva_solicitud_id === s2.id && p.sentido === "pago");
    t("9b: la devolución es un pagos sentido «pago» con la solicitud y sin reserva_id", rD.ok && !!dev && dev.reserva_id == null);
    t("9b: devuelto todo → la tarjeta se cierra (rechazada) y no se crea cargo", sb.t("crm_acciones_ia").find((a) => a.id === s2.crm_accion_id)!.estado === "rechazada" && !solDe(e.cotId).factura_cargo_id);
    const t3 = await D.listaParaTesoreria(sb, { filtro: "pendientes", ahoraMs: reloj });
    t("9b: Tesorería ya no la tiene pendiente", !t3.filas.some((f) => f.solicitudId === s2.id));
  }

  // ── 9c. Cancelación tardía → devolución parcial → comprobante del cargo (una sola vez) ──
  {
    const e = escenario();
    const adel = adelantoDeCot(sb.t("cotizaciones").find((c) => c.id === e.cotId) as any, 50)!;
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    reloj += 5 * 60_000;
    foto(e, "m-3-foto");
    lecturaSiguiente = lecturaDe(adel.adelanto!, "OP-0003");
    await D.reportarPagoIA(ctxDe(e), {}, deps);
    let s = solDe(e.cotId);
    await D.registrarAdelantoSolicitud(sb, await tarjeta(e, s.id), { monto: adel.adelanto, fecha: hoyIso, metodo: "transferencia", referencia: "OP-0003" }, quien, deps);
    await D.confirmarDisponibilidad(sb, await tarjeta(e, s.id), quien, deps);
    reloj += 60_000;
    sb.t("crm_mensajes").push({ id: "m-3-cancela", conversacion_id: e.conv.id, direccion: "entrante", tipo: "texto", contenido: "Quiero cancelar", created_at: new Date(reloj).toISOString() });
    const rC = await D.cancelarIA(ctxDe(e), {}, deps);
    s = solDe(e.cotId);
    t("9c: cancelar con pago → cancelacion_registrada, deriva y T6 con la hora del mensaje", JSON.parse(rC.respuestaModelo).accion === "cancelacion_registrada" && !!rC.derivar && !!rC.mensaje && rC.mensaje.includes("Registré su pedido de cancelación") && s.cancelacion_pedida_en === new Date(reloj).toISOString());
    const rR0 = await D.resolverCancelacion(sb, await tarjeta(e, s.id), quien, 90, deps);
    t("9c: con la reserva viva → cancelar_en_programacion (no cierra nada)", !rR0.ok && rR0.codigo === "cancelar_en_programacion" && solDe(e.cotId).estado === "confirmada");
    for (const r of sb.t("reservas").filter((x) => x.cotizacion_id === e.cotId)) r.estado = "cancelada";
    const rR = await D.resolverCancelacion(sb, await tarjeta(e, s.id), quien, 90, deps);
    s = solDe(e.cotId);
    const cargo = sb.t("facturas").filter((f) => f.cotizacion_id === e.cotId);
    const retenido = Math.round(adel.adelanto! * 10) / 100;
    t("9c: resuelta al 90 % → cancelada, T7 con lo que se devuelve", rR.ok && s.estado === "cancelada" && Number(s.devolucion_pct) === 90 && !!rR.mensaje && rR.mensaje.includes("90 % de lo pagado"));
    t("9c: el comprobante del cargo: uno, sin número, total = lo retenido, sin insertar `total`", cargo.length === 1 && cargo[0].numero == null && Math.abs(cargo[0].total - retenido) < 0.01 && s.factura_cargo_id === cargo[0].id && /Solicitud de reserva #\d+:/.test(cargo[0].observaciones));
    const otra = await D.asegurarComprobanteCargo(sb, s.id, deps);
    t("9c: la segunda vez no crea otro comprobante", otra.ok && !otra.creado && otra.id === cargo[0].id && sb.t("facturas").filter((f) => f.cotizacion_id === e.cotId).length === 1);
    // Aunque la solicitud perdiera el enlace, la marca en las observaciones lo encuentra.
    solDe(e.cotId).factura_cargo_id = null;
    const otra2 = await D.asegurarComprobanteCargo(sb, s.id, deps);
    t("9c: sin el enlace, la factura atada a la solicitud (reservas-09d) evita el duplicado y lo vuelve a atar", otra2.ok && !otra2.creado && otra2.id === cargo[0].id && sb.t("facturas").filter((f) => f.cotizacion_id === e.cotId).length === 1 && solDe(e.cotId).factura_cargo_id === cargo[0].id);
    const v = await D.vistaSolicitud(sb, await tarjeta(e, s.id), deps);
    t("9c: falta devolver el 90 % y emitir el cargo", v.pendientes.some((p) => p.codigo === "registrar_devolucion") && v.pendientes.some((p) => p.codigo === "emitir_cargo") && Math.abs((v.dinero.aDevolver ?? 0) - (adel.adelanto! - retenido)) < 0.01);

    // ── 9e. EL PENDIENTE: el cargo se RECALCULA si entran o se anulan cobros después ──
    const deCot = () => sb.t("facturas").filter((f) => f.cotizacion_id === e.cotId && !f.es_nota_credito);
    const rA = await D.registrarAdelantoSolicitud(sb, await tarjeta(e, s.id), { monto: 20, fecha: hoyIso, metodo: "transferencia", referencia: "OP-0003B" }, quien, deps);
    const ret2 = Math.round((adel.adelanto! + 20) * 10) / 100;
    const c2 = deCot();
    t("9e: un cobro registrado DESPUÉS de resolver pone al día el borrador (sin crear otro)", rA.ok && c2.length === 1 && c2[0].id === cargo[0].id && Math.abs(c2[0].total - ret2) < 0.01
      && String(c2[0].observaciones).includes(`retenido S/ ${ret2.toFixed(2)}`) && !String(c2[0].observaciones).includes(`retenido S/ ${retenido.toFixed(2)}.`));
    const v2 = await D.vistaSolicitud(sb, await tarjeta(e, s.id), deps);
    t("9e: la vista ya cuenta lo nuevo: falta devolver y emitir el cargo, sin «ajustar»", v2.pendientes.some((p) => p.codigo === "emitir_cargo") && !v2.pendientes.some((p) => p.codigo === "ajustar_cargo") && Math.abs(v2.dinero.retenido - ret2) < 0.01);

    // Facturación lo emite; después se anula el cobro de 20 en Finanzas: el emitido NO se toca.
    Object.assign(c2[0], { serie: "F001", numero: "00025", estado: "emitida", sunat_estado: "aceptada" });
    const extra = sb.t("pagos").find((p) => p.referencia === "OP-0003B")!;
    extra.anulado = true;
    const rE = await D.asegurarComprobanteCargo(sb, s.id, deps);
    t("9e: emitido y ahora corresponde menos → no se toca y pide la nota de crédito", rE.ok && rE.codigo === "ajustar_emitido" && !!rE.aviso && rE.aviso.includes("nota de crédito por S/ 2.00") && Math.abs(deCot()[0].total - ret2) < 0.01);
    const v3 = await D.vistaSolicitud(sb, await tarjeta(e, s.id), deps);
    t("9e: la tarjeta lo dice: ajustar_cargo para Facturación", v3.pendientes.some((p) => p.codigo === "ajustar_cargo" && p.quien === "facturacion" && p.detalle.includes("F001-25")));
    // Una «nota de crédito» sin número, pendiente en SUNAT (o puesta a mano) NO apaga lo que falta.
    sb.t("facturas").push({ id: ++sb.n, cotizacion_id: e.cotId, cliente_id: c2[0].cliente_id, moneda: "PEN", es_nota_credito: true, nota_credito_ref: "F001-25", subtotal: 2, igv: 0, total: 2, estado: "pendiente", sunat_estado: "pendiente", numero: null, serie: "FC01" });
    sb.t("facturas").push({ id: ++sb.n, cotizacion_id: e.cotId, cliente_id: 999, moneda: "PEN", es_nota_credito: true, nota_credito_ref: "F001-25", subtotal: 2, igv: 0, total: 2, estado: "emitida", sunat_estado: "aceptada", numero: "00009", serie: "FC01" });
    const rFalsa = await D.asegurarComprobanteCargo(sb, s.id, deps);
    t("9e: una nota sin número o de OTRO cliente no cuenta: sigue pidiendo la nota de crédito", rFalsa.codigo === "ajustar_emitido");
    sb.t("facturas").push({ id: ++sb.n, cotizacion_id: e.cotId, cliente_id: c2[0].cliente_id, moneda: "PEN", es_nota_credito: true, nota_credito_ref: "F001-25", subtotal: 2, igv: 0, total: 2, estado: "emitida", sunat_estado: "aceptada", numero: "00003", serie: "FC01" });
    const rN = await D.asegurarComprobanteCargo(sb, s.id, deps);
    const v4 = await D.vistaSolicitud(sb, await tarjeta(e, s.id), deps);
    t("9e: con la nota de crédito hecha, el cargo queda al día y deja de pedirse", rN.codigo === "al_dia" && !rN.aviso && !v4.pendientes.some((p) => p.codigo === "ajustar_cargo" || p.codigo === "emitir_cargo"));
  }

  // ── 9f. Sin cobros ya no se retiene nada: el borrador se RETIRA; y el tick lo vuelve a crear si vuelven ──
  {
    const e = escenario();
    const adel = adelantoDeCot(sb.t("cotizaciones").find((c) => c.id === e.cotId) as any, 50)!;
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    let s = solDe(e.cotId);
    await D.registrarAdelantoSolicitud(sb, await tarjeta(e, s.id), { monto: adel.adelanto, fecha: hoyIso, metodo: "transferencia", referencia: "OP-0009" }, quien, deps);
    sb.t("crm_mensajes").push({ id: "m-9f-cancela", conversacion_id: e.conv.id, direccion: "entrante", tipo: "texto", contenido: "Cancelo", created_at: new Date(reloj).toISOString() });
    await D.cancelarIA(ctxDe(e), {}, deps);
    s = solDe(e.cotId);
    const rR = await D.resolverCancelacion(sb, await tarjeta(e, s.id), quien, 50, deps);
    const borr = () => sb.t("facturas").filter((f) => f.cotizacion_id === e.cotId);
    const id0 = solDe(e.cotId).factura_cargo_id;
    t("9f: resuelta al 50 % → un borrador del cargo", rR.ok && borr().length === 1 && borr()[0].id === id0 && borr()[0].reserva_solicitud_id === s.id);
    const cobro = sb.t("pagos").find((p) => p.referencia === "OP-0009")!;
    cobro.anulado = true;
    const st = await D.sincronizarCargosDeCancelaciones(sb, deps);
    const f0 = borr().find((f) => f.id === id0)!;
    t("9f: el tick: se anuló el cobro → el borrador queda ANULADO y se desata (no se borra)", st.miradas >= 1 && st.cambiadas >= 1 && f0.estado === "anulada" && f0.reserva_solicitud_id == null && solDe(e.cotId).factura_cargo_id == null && String(f0.observaciones).includes("Retirado por el ERP"));
    const st2 = await D.sincronizarCargosDeCancelaciones(sb, deps);
    t("9f: otra pasada del tick no crea nada (idempotente)", borr().length === 1 && st2.cambiadas === 0);
    cobro.anulado = false;
    await D.sincronizarCargosDeCancelaciones(sb, deps);
    const vivos = borr().filter((f) => f.estado !== "anulada");
    t("9f: el cobro vuelve → el tick crea un comprobante NUEVO y lo ata (el anulado queda como está)", vivos.length === 1 && vivos[0].id !== id0 && solDe(e.cotId).factura_cargo_id === vivos[0].id && borr().length === 2);
  }

  // ── 9g. Dos cálculos a la vez no crean dos borradores (índice único de reservas-09d) ──
  {
    const e = escenario();
    const adel = adelantoDeCot(sb.t("cotizaciones").find((c) => c.id === e.cotId) as any, 50)!;
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    let s = solDe(e.cotId);
    await D.registrarAdelantoSolicitud(sb, await tarjeta(e, s.id), { monto: adel.adelanto, fecha: hoyIso, metodo: "transferencia", referencia: "OP-0010" }, quien, deps);
    sb.t("crm_mensajes").push({ id: "m-9g-cancela", conversacion_id: e.conv.id, direccion: "entrante", tipo: "texto", contenido: "Cancelo", created_at: new Date(reloj).toISOString() });
    await D.cancelarIA(ctxDe(e), {}, deps);
    s = solDe(e.cotId);
    Object.assign(solDe(e.cotId), { estado: "cancelada", devolucion_pct: 50, cerrada_en: new Date(reloj).toISOString() });
    const [a, b] = await Promise.all([D.asegurarComprobanteCargo(sb, s.id, deps), D.asegurarComprobanteCargo(sb, s.id, deps)]);
    const fs = sb.t("facturas").filter((f) => f.cotizacion_id === e.cotId);
    t("9g: dos a la vez → un solo comprobante, y los dos devuelven el mismo", fs.length === 1 && a.id === fs[0].id && b.id === fs[0].id && solDe(e.cotId).factura_cargo_id === fs[0].id);
  }

  // ── 9d. El ciclo inverso: un cobro por la Confirmación lo ve la solicitud ──
  {
    const e = escenario();
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    const s = solDe(e.cotId);
    const rH = await D.confirmarDisponibilidad(sb, await tarjeta(e, s.id), quien, deps);
    t("9d: hay unidad sin pago → T4 con el bloque de pago y las cuentas", rH.ok && !!rH.mensaje && rH.mensaje.includes("191-1234567-0-11") && rH.mensaje.includes("adelanto"));
    const s2 = solDe(e.cotId);
    const ids = sb.t("reservas").filter((r) => r.cotizacion_id === e.cotId).map((r) => r.id);
    // Exactamente lo que hace el route de la Confirmación (sin pasar la solicitud).
    await registrarAdelanto(sb, Math.min(...ids), 7, { monto: 50, moneda: "PEN", fecha: hoyIso, metodo: "transferencia", referencia: "OP-CONF" }, "Tesorería", { tramos: ids });
    const pago = sb.t("pagos").find((p) => p.referencia === "OP-CONF");
    t("9d: el cobro de la Confirmación lleva la solicitud", pago?.reserva_solicitud_id === s2.id);
    const v = await D.vistaSolicitud(sb, await tarjeta(e, s2.id), deps);
    t("9d: la solicitud lo ve como cobrado", v.dinero.cobrado === 50 && v.pagos.some((p) => p.referencia === "OP-CONF"));
    t("9d: con 50 de un adelanto mayor, falta completar el adelanto", v.pendientes.some((p) => p.codigo === "completar_adelanto"));
  }

  // ── 9e. Fuera de la ventana de 24 h: se hace lo del ERP y vuelve el texto con su wa.me ──
  {
    const e = escenario();
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    const s = solDe(e.cotId);
    reloj += 25 * 3_600_000;
    const antes = textos.length;
    const r = await D.sinUnidad(sb, await tarjeta(e, s.id), quien, deps);
    t("9e: fuera de la ventana → fuera_de_ventana, cerrada igual, sin intentar enviar", r.ok && r.codigo === "fuera_de_ventana" && solDe(e.cotId).estado === "sin_unidad" && textos.length === antes && !!r.fueraDeVentana?.waMe?.startsWith("https://wa.me/"));
    reloj -= 25 * 3_600_000;
  }

  // ── 9f. Cancelar sin pago: se cierra sola ──
  {
    const e = escenario();
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    const r = await D.cancelarIA(ctxDe(e), {}, deps);
    const s = solDe(e.cotId);
    t("9f: sin pago ni comprobante → cancelada_sin_pago, cancelada (cliente) y tarjeta rechazada", JSON.parse(r.respuestaModelo).accion === "cancelada_sin_pago" && s.estado === "cancelada" && s.cierre_motivo === "cliente" && sb.t("crm_acciones_ia").find((a) => a.id === s.crm_accion_id)!.estado === "rechazada");
  }

  // ── 9g. Topes: un conteo que no se pudo leer bloquea ──
  {
    const e = escenario();
    const ctx = ctxDe(e);
    ctx.turno.n = TOPES_RESERVA.MAX_HERRAMIENTAS_RESERVA_TURNO;
    const r = await D.reservarTrasladoIA(ctx, {}, deps);
    t("9g: con el tope del turno → deriva sin crear solicitud", !!r.derivar && !sb.t("reserva_solicitudes").some((s) => s.cotizacion_id === e.cotId));
  }

  // ── 9h. Volver a mandarle las cuentas: solo las MISMAS que recibió (la huella de la firma) ──
  {
    const e = escenario();
    const r1 = await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    const s = solDe(e.cotId);
    t("9h: la firma guarda la huella de las cuentas que se le mandaron", JSON.parse(r1.respuestaModelo).accion === "pedir_pago" && /\|cta:[0-9a-f]{16}$/.test(String(s.firma_importes)));
    const perfil = sb.tablas.empresa_perfil[0];
    const cuentasAntes = perfil.cuentas_bancarias;
    perfil.cuentas_bancarias = [{ banco: "Banco Tres", cuenta: "999-0000000-0-99", cci: "00299900000000009999", moneda: "PEN" }];
    const r2 = await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    t("9h: con otras cuentas → deriva y NO le manda las nuevas", !!r2.derivar && r2.mensaje === null && /cambiaron/.test(r2.derivar.nota));
    perfil.cuentas_bancarias = cuentasAntes;
    const r3 = await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    t("9h: con las mismas → ya_solicitada y le reenvía el mismo T1", JSON.parse(r3.respuestaModelo).accion === "ya_solicitada" && r3.mensaje === r1.mensaje);
    const nombre = perfil.nombre, razon = perfil.razon_social;
    perfil.nombre = null; perfil.razon_social = null;
    const r4 = await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    t("9h: con el perfil sin nombre → deriva", !!r4.derivar && r4.mensaje === null && /perfil de la empresa/.test(r4.derivar.nota));
    perfil.nombre = nombre; perfil.razon_social = razon;
    const original = s.firma_importes;
    s.firma_importes = String(original).replace(/\|cta:[0-9a-f]+$/, "");
    const r5 = await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    t("9h: una solicitud de antes (firma sin huella) → deriva", !!r5.derivar && r5.mensaje === null && /anterior a ese control/.test(r5.derivar.nota));
    t("9h: la firma sin huella sigue comparando sus importes (no se dan por cambiados)", (await D.vistaSolicitud(sb, await tarjeta(e, s.id), deps)).cotizacion?.importesVigentes === true);
    s.firma_importes = original;
    t("9h: con la huella, la vista tampoco da los importes por cambiados", (await D.vistaSolicitud(sb, await tarjeta(e, s.id), deps)).cotizacion?.importesVigentes === true);
  }

  // ── 9i. Lo que el lector dijo que NO es un comprobante no frena; lo que no pudo leer, sí ──
  {
    const e = escenario();
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    reloj += 60_000;
    foto(e, `m-${e.cotId}-selfie`);
    lecturaSiguiente = { ...lecturaDe(10, "X-1"), es_comprobante: false };
    await D.reportarPagoIA(ctxDe(e), {}, deps);
    const s = solDe(e.cotId);
    const k = sb.t("reserva_solicitud_comprobantes").find((x) => x.solicitud_id === s.id);
    t("9i: una foto que no es un comprobante queda registrada y la solicitud sigue esperando el pago", !!k && k.lectura?.es_comprobante === false && s.estado === "esperando_pago");
    const v = await D.vistaSolicitud(sb, await tarjeta(e, s.id), deps);
    t("9i: …no la pone a verificar en Tesorería ni ofrece «No encontré el pago»", !v.pendientes.some((p) => p.codigo === "verificar_pago") && !v.acciones.includes("pago_no_encontrado") && v.acciones.includes("ver_comprobante"));
    const rC = await D.cancelarIA(ctxDe(e), {}, deps);
    t("9i: …y no frena la cancelación sin pago", JSON.parse(rC.respuestaModelo).accion === "cancelada_sin_pago" && solDe(e.cotId).estado === "cancelada");
  }
  {
    const e = escenario();
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    reloj += 60_000;
    foto(e, `m-${e.cotId}-selfie2`);
    lecturaSiguiente = { ...lecturaDe(10, "X-2"), es_comprobante: false };
    await D.reportarPagoIA(ctxDe(e), {}, deps);
    const s = solDe(e.cotId);
    const r = await D.cerrarSolicitud(sb, await tarjeta(e, s.id), quien, "cliente", "", deps);
    t("9i: «Cerrar» con solo una foto que no es comprobante → se cierra", r.ok && solDe(e.cotId).estado === "cancelada");
  }
  {
    const e = escenario();
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    reloj += 60_000;
    foto(e, `m-${e.cotId}-sinlect`);
    await D.reportarPagoIA(ctxDe(e), {}, { ...deps, leerComprobante: async () => ({ ok: false, codigo: "error_modelo", detalle: "x" }) });
    const s = solDe(e.cotId);
    t("9i: sin lectura (el lector falló) cuenta como pago reportado", s.estado === "pago_reportado");
    const rCe = await D.cerrarSolicitud(sb, await tarjeta(e, s.id), quien, "cliente", "", deps);
    t("9i: …«Cerrar» pide que Tesorería lo resuelva", !rCe.ok && rCe.codigo === "pago_sin_registrar");
    const rC = await D.cancelarIA(ctxDe(e), {}, deps);
    t("9i: …y la cancelación de la IA deriva (no se cierra sola)", JSON.parse(rC.respuestaModelo).accion === "cancelacion_registrada" && solDe(e.cotId).estado === "pago_reportado");
  }

  // ── 9j. Solo un archivo que llegó por Meta puede ser el comprobante ──
  {
    const e = escenario();
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    reloj += 60_000;
    foto(e, `m-${e.cotId}-sinmeta`, { meta: null });
    const r = await D.reportarPagoIA(ctxDe(e), {}, deps);
    t("9j: sin meta_message_id (no lo escribió el webhook) → pedir_comprobante y nada registrado",
      JSON.parse(r.respuestaModelo).accion === "pedir_comprobante" && !sb.t("reserva_solicitud_comprobantes").some((k) => k.mensaje_id === `m-${e.cotId}-sinmeta`));
  }

  // ── 9k. «Ver el comprobante»: solo `crm-media`, con un enlace corto ──
  {
    const e = escenario();
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    reloj += 60_000;
    const idFoto = `m-${e.cotId}-ver`;
    foto(e, idFoto);
    lecturaSiguiente = lecturaDe(10, `OP-${e.cotId}`);
    await D.reportarPagoIA(ctxDe(e), {}, deps);
    const s = solDe(e.cotId);
    const storageAntes = sb.storage;
    const firmados: string[] = [];
    sb.storage = { from: (b: string) => ({ ...storageAntes.from(b), createSignedUrl: async (_r: string, ttl: number) => { firmados.push(`${b}:${ttl}`); return { data: { signedUrl: "https://firmado.test/x" } }; } }) } as any;
    const r1 = await D.verComprobante(sb, await tarjeta(e, s.id), quien, deps);
    t("9k: de crm-media → enlace firmado por 600 s", r1.ok && !!r1.url && firmados.join() === "crm-media:600");
    sb.t("crm_mensajes").find((m) => m.id === idFoto)!.media_url = "https://sb.test/storage/v1/object/public/documentos/soat/ABC-123.pdf";
    const r2 = await D.verComprobante(sb, await tarjeta(e, s.id), quien, deps);
    t("9k: un enlace a otro bucket privado no se firma", !r2.ok && r2.codigo === "sin_comprobante" && firmados.length === 1);
    sb.t("crm_mensajes").find((m) => m.id === idFoto)!.media_url = `https://sb.test/storage/v1/object/public/crm-media/${idFoto}.jpg`;
    // Tesorería abre un comprobante POR SU ID (la cadena sin conversación ni tarjeta, como su ruta).
    reloj += 60_000;
    foto(e, `${idFoto}-2`);
    lecturaSiguiente = lecturaDe(10, `OP-${e.cotId}-2`);
    await D.reportarPagoIA(ctxDe(e), {}, deps);
    const comps = sb.t("reserva_solicitud_comprobantes").filter((k) => k.solicitud_id === s.id).sort((a, b) => a.id - b.id);
    const cadT = await D.cargarCadena(sb, { solicitudId: s.id });
    if (!cadT.ok) throw new Error(cadT.detalle);
    comps[0].leido_en = null;
    const r3 = await D.verComprobante(sb, cadT.c, { id: "u-tes", nombre: "Tesorería" }, deps, { comprobanteId: comps[0].id });
    t("9k: Tesorería abre el comprobante que elige (no solo el último), 600 s, y queda leído por quien lo abrió",
      comps.length === 2 && r3.ok && !!r3.url && firmados.at(-1) === "crm-media:600" && !!comps[0].leido_en && comps[0].leido_por === "u-tes");
    const otra = sb.t("reserva_solicitud_comprobantes").find((k) => k.solicitud_id !== s.id)!;
    const r4 = await D.verComprobante(sb, cadT.c, quien, deps, { comprobanteId: otra.id });
    t("9k: un comprobante de OTRA solicitud → ajena, sin firmar nada", !r4.ok && r4.codigo === "ajena" && firmados.length === 2);
    const r5 = await D.verComprobante(sb, cadT.c, quien, deps, { comprobanteId: -3 });
    t("9k: un id inválido → datos_invalidos", !r5.ok && r5.codigo === "datos_invalidos");
    sb.storage = storageAntes;
  }

  // ── 9l. Pago sin cotización que reservar: sin IA, una vez por archivo, con tope y el adjunto por su contenido ──
  {
    const e = escenario();
    sb.t("crm_acciones_ia").find((a) => a.id === `acc-cot-${nCot}`)!.estado = "pendiente"; // la cotización no se envió
    reloj += 60_000;
    foto(e, `m-${e.cotId}-sc1`);
    const lecturasAntes = lecturas, correosAntes = correos.length;
    const r1 = await D.reportarPagoIA(ctxDe(e), {}, deps);
    const nuevos = correos.slice(correosAntes);
    t("9l: deriva, NO lee el comprobante con IA y avisa por correo con el archivo adjunto",
      !!r1.derivar && lecturas === lecturasAntes && nuevos.length >= 1 && nuevos.every((c) => /sin cotización/.test(c.subject) && c.adjuntos === 1) && /Correo enviado/.test(r1.derivar.nota));
    t("9l: el archivo queda reclamado en alerta_enviada (su clave propia)", sb.t("alerta_enviada").some((a) => a.clave === D.CLAVE_CORREO_SIN_COTIZACION && a.ref === `conv:${e.conv.id}:msg:m-${e.cotId}-sc1`));
    const n1 = correos.length;
    const r2 = await D.reportarPagoIA(ctxDe(e), {}, deps);
    t("9l: el mismo archivo otra vez → no se vuelve a mandar", !!r2.derivar && correos.length === n1 && /ya se avisó/.test(r2.derivar.nota));
    reloj += 60_000;
    foto(e, `m-${e.cotId}-sc2`);
    bytesSiguientes = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x61, 0x6c, 0x65, 0x72]); // «<html>alert…»
    const n2 = correos.length;
    await D.reportarPagoIA(ctxDe(e), {}, deps);
    const sin = correos.slice(n2);
    t("9l: un archivo que por su contenido no es imagen ni PDF → el correo sale SIN adjunto y dice por qué",
      sin.length >= 1 && sin.every((c) => c.adjuntos === 0 && /no es una imagen JPEG, PNG o WEBP ni un PDF/.test(c.html)));
    bytesSiguientes = JPEG;
    reloj += 60_000;
    foto(e, `m-${e.cotId}-sc3`);
    const n3 = correos.length;
    const r3 = await D.reportarPagoIA(ctxDe(e), {}, deps);
    t("9l: con el tope del día de esta conversación → no se envía y queda en la nota", !!r3.derivar && correos.length === n3 && /No se envió el correo/.test(r3.derivar.nota));
    sb.falla = (tabla, op) => (tabla === "alerta_enviada" && op === "select" ? { code: "57014", message: "statement timeout" } : null);
    reloj += 60_000;
    const e2 = escenario();
    sb.t("crm_acciones_ia").find((a) => a.id === `acc-cot-${nCot}`)!.estado = "pendiente";
    foto(e2, `m-${e2.cotId}-sc4`);
    const n4 = correos.length;
    const r4 = await D.reportarPagoIA(ctxDe(e2), {}, deps);
    sb.falla = null;
    t("9l: sin poder contar ni comprobar el aviso → no se envía (y la nota no lleva el error de la base)", !!r4.derivar && correos.length === n4 && /No se envió el correo/.test(r4.derivar.nota) && !/statement timeout/.test(r4.derivar.nota));
  }

  // ── 9m. Las políticas solo salen si la cotización saldría sola ──
  {
    const e = escenario();
    const cot = sb.t("cotizaciones").find((c) => c.id === e.cotId)!;
    cot.consideraciones_json = { ...cot.consideraciones_json, reserva: [...POLITICA, "Más información en www.ejemplo.test/politicas"] };
    const r1 = await D.politicasIA(ctxDe(e), {}, deps);
    t("9m: una línea con un enlace → deriva sin mandarlas", !!r1.derivar && r1.mensaje === null && /Revisa las políticas de la cotización N°/.test(r1.derivar.nota));
    cot.consideraciones_json = { ...cot.consideraciones_json, reserva: Array.from({ length: 31 }, (_, i) => `Regla ${String.fromCharCode(65 + (i % 26))}${i > 25 ? "x" : ""} de la reserva.`) };
    const r2 = await D.politicasIA(ctxDe(e), {}, deps);
    t("9m: más de 30 líneas → deriva sin mandarlas", !!r2.derivar && r2.mensaje === null && /31 líneas/.test(r2.derivar.nota));
    cot.consideraciones_json = { ...cot.consideraciones_json, reserva: POLITICA };
    const r3 = await D.politicasIA(ctxDe(e), {}, deps);
    t("9m: la política normal sale al pie de la letra", JSON.parse(r3.respuestaModelo).accion === "enviar_politicas" && !!r3.mensaje && r3.mensaje.includes(POLITICA[0]));
  }

  // ── 9n. «Vincular cliente» ata el contacto solo si el número es el del chat ──
  {
    sb.t("clientes").push({ id: 8, nombre: "Otro Cliente", empresa: null, ruc: null, condicion_pago: null, telefono: "912345678", operativo_celular: null });
    const e = escenario();
    e.contacto.cliente_id = null as any;
    sb.t("cotizaciones").find((c) => c.id === e.cotId)!.cliente_id = null;
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    const s = solDe(e.cotId);
    const r1 = await D.vincularCliente(sb, await tarjeta(e, s.id), 8);
    t("9n: número que no es el del chat → ata la cotización, NO el contacto, y lo dice",
      r1.ok && /SIN vincular/.test(r1.detalle) && e.contacto.cliente_id == null && sb.t("cotizaciones").find((c) => c.id === e.cotId)!.cliente_id === 8);
    const e2 = escenario();
    e2.contacto.cliente_id = null as any;
    sb.t("cotizaciones").find((c) => c.id === e2.cotId)!.cliente_id = null;
    sb.t("clientes").push({ id: 9, nombre: "Cliente Operativo", empresa: null, ruc: null, condicion_pago: null, telefono: "014445555", operativo_celular: `+${e2.contacto.wa_id}` });
    await D.reservarTrasladoIA(ctxDe(e2), {}, deps);
    const r2 = await D.vincularCliente(sb, await tarjeta(e2, solDe(e2.cotId).id), 9);
    t("9n: el celular del contacto operativo es el del chat → ata también el contacto", r2.ok && e2.contacto.cliente_id === 9 && /contacto del CRM/.test(r2.detalle));
  }

  // ── 9o. La Confirmación por WhatsApp solo a un cliente verificado para ese chat ──
  {
    const e = escenario();
    const adel = adelantoDeCot(sb.t("cotizaciones").find((c) => c.id === e.cotId) as any, 50)!;
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    reloj += 60_000;
    foto(e, `m-${e.cotId}-conf`);
    lecturaSiguiente = lecturaDe(adel.adelanto!, `OP-C-${e.cotId}`);
    await D.reportarPagoIA(ctxDe(e), {}, deps);
    const s = solDe(e.cotId);
    await D.registrarAdelantoSolicitud(sb, await tarjeta(e, s.id), { monto: adel.adelanto, fecha: hoyIso, metodo: "transferencia", referencia: `OP-C-${e.cotId}` }, quien, deps);
    await D.confirmarDisponibilidad(sb, await tarjeta(e, s.id), quien, deps);
    let medias = 0;
    const depsConf = { ...deps, pdfConfirmacion: async () => ({ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1]), nombre: "confirmacion.pdf" }), asegurarBucket: async () => {}, enviarMedia: async () => { medias++; return "wamid.doc"; }, phonePara: async () => "PN" };
    e.contacto.cliente_id = null as any; // el cliente de la reserva ya no está vinculado al contacto (y su teléfono no es el wa_id)
    const r1 = await D.enviarConfirmacionReserva(sb, await tarjeta(e, s.id), quien, { idioma: "es" }, depsConf);
    t("9o: cliente sin verificar → se emite, NO sale por WhatsApp, y vuelve el PDF + wa.me con su bloqueo",
      r1.codigo === "fuera_de_ventana" && medias === 0 && !!r1.version?.pdf && !!r1.fueraDeVentana?.waMe?.startsWith("https://wa.me/")
      && r1.bloqueos?.[0]?.codigo === "cliente_no_verificado" && solDe(e.cotId).estado === "confirmada");
    e.contacto.cliente_id = 7;
    const r2 = await D.enviarConfirmacionReserva(sb, await tarjeta(e, s.id), quien, { idioma: "es" }, depsConf);
    t("9o: verificado (vinculado al contacto) → sale por WhatsApp y la solicitud se completa", r2.ok && r2.enviado === true && medias === 1 && solDe(e.cotId).estado === "completada");
  }

  // ── 9p. El crédito se le reconoce solo a un cliente verificado para ese chat ──
  {
    sb.t("clientes").push({ id: 10, nombre: "Empresa a Crédito", empresa: "Empresa a Crédito SAC", ruc: null, condicion_pago: "Crédito 30 días", telefono: "911222333" });
    const e = escenario();
    e.contacto.cliente_id = null as any;
    sb.t("cotizaciones").find((c) => c.id === e.cotId)!.cliente_id = 10;
    const r1 = await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    const s1 = solDe(e.cotId);
    t("9p: cliente a crédito NO verificado → se le pide el adelanto", JSON.parse(r1.respuestaModelo).accion === "pedir_pago" && Number(s1.adelanto_pct) === 50 && !(s1.motivos_orden ?? []).includes("credito"));
    const e2 = escenario();
    e2.contacto.cliente_id = 10;
    sb.t("cotizaciones").find((c) => c.id === e2.cotId)!.cliente_id = 10;
    const r2 = await D.reservarTrasladoIA(ctxDe(e2), {}, deps);
    const s2 = solDe(e2.cotId);
    t("9p: verificado (vinculado al contacto) → crédito: primero la unidad, sin adelanto", JSON.parse(r2.respuestaModelo).accion === "confirmar_disponibilidad" && s2.adelanto_pct == null && (s2.motivos_orden ?? []).includes("credito"));
  }

  // ── 9q. Un error de la base no llega a la tarjeta ──
  {
    const e = escenario();
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    const s = solDe(e.cotId);
    const c = await tarjeta(e, s.id);
    sb.falla = (tabla, op) => (tabla === "reserva_solicitudes" && op === "update" ? { code: "23514", message: 'new row for relation "reserva_solicitudes" violates check constraint "ck_secreto"' } : null);
    const r = await D.sinUnidad(sb, c, quien, deps);
    sb.falla = (tabla, op) => (tabla === "cotizaciones" && op === "select" ? { code: "42501", message: "permission denied for table cotizaciones" } : null);
    const cad = await D.cargarCadena(sb, { solicitudId: s.id, conversacionId: e.conv.id, accionId: s.crm_accion_id });
    sb.falla = null;
    t("9q: el detalle dice qué falló, sin el texto de la base", !r.ok && /^No se pudo cerrar la solicitud\./.test(r.detalle) && !/ck_secreto|violates/.test(r.detalle));
    t("9q: también al cargar la tarjeta", !cad.ok && /^No se pudo leer la cotización\./.test(cad.detalle) && !/permission denied/.test(cad.detalle));
  }

  // ── 9r. «No encontré el pago»: sobre el payload recién leído, y solo con la tarjeta pendiente ──
  {
    const e = escenario();
    await D.reservarTrasladoIA(ctxDe(e), {}, deps);
    reloj += 60_000;
    foto(e, `m-${e.cotId}-nf`);
    lecturaSiguiente = lecturaDe(10, `OP-N-${e.cotId}`);
    await D.reportarPagoIA(ctxDe(e), {}, deps);
    const s = solDe(e.cotId);
    const c = await tarjeta(e, s.id);
    const acc = sb.t("crm_acciones_ia").find((a) => a.id === s.crm_accion_id)!;
    acc.payload = { ...acc.payload, escrito_entre_medio: true }; // otra acción escribió después de leer la tarjeta
    const r1 = await D.marcarPagoNoEncontrado(sb, c, quien, deps);
    t("9r: no pisa lo que otra acción escribió entre medio", r1.ok && acc.payload.escrito_entre_medio === true && !!acc.payload.pago_no_encontrado && acc.payload.solicitud_id === s.id);
    acc.estado = "aprobada";
    const antes = JSON.stringify(acc.payload);
    const r2 = await D.marcarPagoNoEncontrado(sb, c, quien, { ...deps, ahoraMs: () => reloj + 1 });
    t("9r: con la tarjeta ya cerrada → reclamo_perdido y no se toca", !r2.ok && r2.codigo === "reclamo_perdido" && JSON.stringify(acc.payload) === antes);
    acc.estado = "pendiente";
  }
}

if (fallas.length) for (const f of fallas) console.log("✗", f);
console.log(`\n${ok} OK · ${mal} mal`);
if (mal > 0 || fallas.length > 0) process.exit(1);
console.log("Todo OK");
