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
      const ahora = new Date(sb.reloj()).toISOString();
      if (this.op === "insert") {
        const lista = Array.isArray(this.payload) ? this.payload : [this.payload];
        const nuevas: Fila[] = [];
        for (const p of lista) {
          const fila: Fila = { ...p };
          if (tabla === "facturas" && "total" in fila) return { data: null, error: { code: "428C9", message: 'cannot insert a non-DEFAULT value into column "total"' } };
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
        for (const f of sel) { Object.assign(f, this.payload); if (tabla === "reserva_solicitudes") f.actualizada_en = ahora; }
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
  const correos: { to: string; subject: string; adjuntos: number }[] = [];
  let lecturaSiguiente: any = null;
  const deps: any = {
    ahoraMs: () => reloj, azar: () => String(Math.random()).slice(2, 8), uuid: () => "uuid-x", appUrl: "https://erp.test",
    leerComprobante: async () => ({ ok: true, lectura: lecturaSiguiente, crudo: "{}" }),
    enviarCorreo: async (c: any) => { correos.push({ to: c.to, subject: c.subject, adjuntos: c.attachments?.length ?? 0 }); },
    enviarTexto: async (s: any, conv: any, _ct: any, texto: string) => { textos.push({ conv: conv.id, texto }); await s.from("crm_mensajes").insert({ conversacion_id: conv.id, direccion: "saliente", tipo: "texto", contenido: texto, generado_por_ia: true }); return { error: null, metaId: "wamid" }; },
    bajarArchivo: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" }),
  };
  const cfg = (await import("../lib/traslados/datos")).leerConfigIA;
  const cfgIA = await cfg(sb);
  t("e2e: leerConfigIA lee la reserva (encendida, 50 %, tablas comprobadas)", cfgIA.reservaIA === true && cfgIA.reserva.adelantoPct === 50 && cfgIA.reserva.plazoConfirmacionMin === 120);
  const ctxDe = (e: ReturnType<typeof escenario>) => ({
    sb, conv: e.conv, contacto: e.contacto, remitente: { canal: "whatsapp", waId: e.contacto.wa_id }, agente: sb.tablas.crm_agentes_ia[0],
    modoAuto: true, cfg: cfgIA.reserva, turno: { n: 0 },
  });
  const foto = (e: ReturnType<typeof escenario>, id: string) => sb.t("crm_mensajes").push({ id, conversacion_id: e.conv.id, direccion: "entrante", tipo: "image", media_url: `https://sb.test/storage/v1/object/public/crm-media/${id}.jpg`, created_at: new Date(reloj).toISOString() });
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
    t("9a: el comprobante queda como evidencia, con su cotejo y el correo", !!comp && comp.cotejo.includes("coincide") && !!comp.correo_en && correos.some((c) => /Pago REPORTADO/.test(c.subject) && c.adjuntos === 1));
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
    t("9c: sin el enlace, la marca evita el duplicado y lo vuelve a atar", otra2.ok && !otra2.creado && otra2.id === cargo[0].id && sb.t("facturas").filter((f) => f.cotizacion_id === e.cotId).length === 1 && solDe(e.cotId).factura_cargo_id === cargo[0].id);
    const v = await D.vistaSolicitud(sb, await tarjeta(e, s.id), deps);
    t("9c: falta devolver el 90 % y emitir el cargo", v.pendientes.some((p) => p.codigo === "registrar_devolucion") && v.pendientes.some((p) => p.codigo === "emitir_cargo") && Math.abs((v.dinero.aDevolver ?? 0) - (adel.adelanto! - retenido)) < 0.01);
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
}

if (fallas.length) for (const f of fallas) console.log("✗", f);
console.log(`\n${ok} OK · ${mal} mal`);
if (mal > 0 || fallas.length > 0) process.exit(1);
console.log("Todo OK");
