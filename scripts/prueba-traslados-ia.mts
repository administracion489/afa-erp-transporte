/* eslint-disable @typescript-eslint/no-explicit-any -- la matriz arma resultados y filas a mano */
// Matriz de la IA del CRM cotizando traslados — npx tsx scripts/prueba-traslados-ia.mts
//
// lib/traslados/envio-ia.ts (qué acepta del modelo, qué le devuelve, si se envía sola),
// lib/traslados/cotizacion-traslado.ts (la fila de `cotizaciones` y el contenido del PDF) y
// lib/traslados/pdf-traslado.ts (el dibujo). Las zonas, categorías y precios se LEEN de los SQL de
// semilla (supabase/traslados-02 y -03), como en prueba-traslados.mts.
//
// LA INVARIANTE QUE NO SE AFLOJA (pedido del dueño, 19-10-2026): por ahora solo el AEROPUERTO
// sale solo. Se barre todo pedido × toda configuración y se exige que una cotización automática
// tenga el aeropuerto en una punta Y todas las demás condiciones — y el corolario: aeropuerto ↔
// Miraflores con todo encendido SÍ sale sola (un motor que nunca enviara cumpliría lo primero).
import { readFileSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import * as M from "../lib/traslados/motor";
import * as E from "../lib/traslados/envio-ia";
import * as C from "../lib/traslados/cotizacion-traslado";
import { dibujarPdfTraslado } from "../lib/traslados/pdf-traslado";
import { validarEntrada, type EntradaSimulador } from "../lib/traslados/api";
import { totalesEnMoneda } from "../lib/cotizacion-moneda";
import { empresaConDefectos } from "../lib/empresa-perfil";
import { numeroCotizacion } from "../lib/cotizacion-pdf";
import { LOGO_DEFAULT } from "../lib/pdf-chrome";
import { PDFDocument, StandardFonts } from "pdf-lib";

let fallos = 0, oks = 0;
const ok = (c: boolean, m: string) => { if (c) oks++; else { fallos++; if (fallos <= 60) console.log("  FALLA " + m); } };
const seccion = (t: string) => console.log(`\n── ${t}`);
const pendientes: string[] = [];

// ── Semillas desde el SQL (mismo lector que prueba-traslados.mts) ─────────────
const sql02 = readFileSync("supabase/traslados-02-zonas-lima.sql", "utf8");
const sql03 = readFileSync("supabase/traslados-03-precios-afa.sql", "utf8");
const arr = (lit: string) => lit.replace(/^\{|\}$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "").trim()).filter(Boolean);
let nid = 1;
const zonasBase: M.Zona[] = [];
for (const m of sql02.matchAll(/\('([^']+)', 'distrito', '([^']+)', '(\{[^']*\})', (\d+)\)/g)) {
  zonasBase.push({ id: nid++, nombre: m[1], tipo: "distrito", padre_id: null, sector: m[2], alias: arr(m[3]), orden: Number(m[4]), activo: true });
}
const aer = sql02.match(/\('Aeropuerto Jorge Chávez', 'punto', '[^']+',\s*'(\{[^']*\})', (-?[\d.]+), (-?[\d.]+), (\d+)/)!;
zonasBase.push({ id: nid++, nombre: "Aeropuerto Jorge Chávez", tipo: "punto", padre_id: null, alias: arr(aer[1]), lat: Number(aer[2]), lng: Number(aer[3]), radio_m: Number(aer[4]), activo: true });
const categorias: M.CategoriaTraslado[] = [];
for (const m of sql03.matchAll(/\('(\w+)',\s+'([^']+)',\s+(\d+),\s+(\d+), '(\w+)',\s+(\d+)\)/g)) {
  categorias.push({ clave: m[1], nombre: m[2], capacidad: Number(m[3]), maletas_bodega: Number(m[4]), tipo_vehiculo: m[5], orden: Number(m[6]), activo: true });
}
const precios = [...sql03.slice(sql03.indexOf("p(categoria, pen, usd)")).matchAll(/\('(\w+)', (\d+), (\d+)\)/g)]
  .map((m) => ({ categoria: m[1], pen: Number(m[2]), usd: Number(m[3]) }));
const consid = [...sql03.matchAll(/consideraciones = array\[([\s\S]*?)\]/g)][0]?.[1] ?? "";
const considUsd = sql03.match(/consideraciones_usd = array\[([\s\S]*?)\]/)?.[1] ?? "";
const lits = (s: string) => [...s.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
const config = { validez_dias: 30, espera_gratis_min: 30, consideraciones: lits(consid), consideraciones_usd: lits(considUsd) };
ok(categorias.length === 7 && precios.length === 7, "semillas leídas (7 categorías, 7 precios)");
ok(config.consideraciones.length === 3 && config.consideraciones_usd.length === 1, "consideraciones de la semilla leídas");

const z = (n: string) => zonasBase.find((x) => x.nombre === n)!;
const AER = z("Aeropuerto Jorge Chávez");
const tarifasSemilla: M.TarifaTraslado[] = [];
for (const d of ["Miraflores", "San Isidro", "Barranco"]) {
  for (const p of precios) for (const moneda of ["PEN", "USD"] as const) {
    const [a, b] = M.parOrdenado(AER.id, z(d).id);
    tarifasSemilla.push({ zona_a_id: a, zona_b_id: b, categoria: p.categoria, moneda, precio_tramo: moneda === "PEN" ? p.pen : p.usd, activo: true });
  }
}
// Pares SIN aeropuerto con precio: sin ellos ningún traslado ajeno al aeropuerto sería cotizable y
// la invariante «solo el aeropuerto sale solo» se cumpliría por falta de casos.
const tarifas = [...tarifasSemilla];
for (const [x, y] of [["Miraflores", "San Isidro"], ["Barranco", "Santiago de Surco"], ["Miraflores", "Miraflores"]]) {
  for (const p of precios) for (const moneda of ["PEN", "USD"] as const) {
    const [a, b] = M.parOrdenado(z(x).id, z(y).id);
    tarifas.push({ zona_a_id: a, zona_b_id: b, categoria: p.categoria, moneda, precio_tramo: moneda === "PEN" ? p.pen + 10 : p.usd + 3, activo: true });
  }
}
// La configuración de AFA (traslados-05, bloque «SOLO AFA»): solo el aeropuerto con envío.
const zonas: E.ZonaEnvio[] = zonasBase.map((x) => ({ ...x, envio_automatico: x.id === AER.id }));

const HOY = "2026-10-19";
const ctx: M.ContextoTraslado = { zonas, categorias, tarifas, tipoCambio: { fecha: HOY, venta: 3.431 }, hoy: HOY, igvPct: 18, validezDias: 30 };
const pt = (localidades: string[], extra: Partial<M.PuntoUbicado> = {}): M.PuntoUbicado =>
  ({ texto: localidades[0] ?? "", lat: null, lng: null, localidades, barrios: [], ...extra });
const MIRA = pt(["Miraflores", "Provincia de Lima"], { texto: "Hotel Belmond, Miraflores", lat: -12.131, lng: -77.03 });
const AEROP = pt(["Callao"], { texto: "Aeropuerto Jorge Chávez", lat: -12.0297011, lng: -77.1162278 });
const SI = pt(["San Isidro"], { lat: -12.097, lng: -77.034 });
const BARR = pt(["Barranco"], { lat: -12.149, lng: -77.021 });
const SURCO = pt(["Santiago de Surco"], { lat: -12.14, lng: -76.99 });
const SJM = pt(["San Juan de Miraflores"], { lat: -12.155, lng: -76.97 });
const LIMA = pt(["Lima"], { lat: -12.09, lng: -77.02 });
const VACIO = pt([]);
const PUNTOS = [AEROP, MIRA, SI, BARR, SURCO, SJM, LIMA, VACIO];
const pedido = (x: Partial<M.PedidoTraslado> = {}): M.PedidoTraslado => ({
  origen: AEROP, destino: MIRA, fecha_servicio: "2026-10-25", hora_servicio: "06:30", sentido: "ida", pax: 2, maletas: 2, telefono: "+51966707225", ...x,
});
const entradaDe = (p: M.PedidoTraslado): EntradaSimulador => ({
  origen: p.origen?.texto ?? "", destino: p.destino?.texto ?? "", fecha_servicio: p.fecha_servicio, hora_servicio: p.hora_servicio ?? null,
  sentido: p.sentido, fecha_retorno: p.fecha_retorno ?? null, hora_retorno: p.hora_retorno ?? null, pax: p.pax, maletas: p.maletas, telefono: p.telefono,
});

// ── 1. La herramienta ────────────────────────────────────────────────────────
seccion("1. La herramienta no tiene teléfono, moneda, precio ni destinatario");
{
  const h = E.HERRAMIENTA_COTIZAR_TRASLADO;
  const props = Object.keys((h.input_schema as { properties: Record<string, unknown> }).properties);
  ok(h.name === "cotizar_traslado", "se llama cotizar_traslado");
  ok(!props.some((p) => /tel|phone|moneda|currency|precio|price|importe|total|destinatario|wa_id|numero/i.test(p)), `sin campos de dinero ni destinatario (${props.join(", ")})`);
  const enumSen = ((h.input_schema as any).properties.senales.items.enum as string[]);
  ok(JSON.stringify(enumSen) === JSON.stringify(Object.keys(M.SENALES)), "el enum de señales es EXACTAMENTE el del motor");
  ok(/precio/i.test(h.description) && /sistema/i.test(h.description), "la descripción dice que el precio lo pone el sistema");
  ok(/simple/i.test(h.description), "y que es para traslados simples");
  ok(!/"required"/.test(JSON.stringify(h.input_schema)), "ningún campo obligatorio (el motor pregunta lo que falta, el modelo no inventa)");
}

// ── 2. La moneda sale del remitente, nunca del modelo ────────────────────────
seccion("2. El teléfono del modelo nunca decide la moneda");
{
  let n = 0;
  const telsModelo = [undefined, "+13055551234", "+51966707225", "966707225", "PE.abc", "US.xyz", ""];
  const waIds = [null, "51966707225", "13055551234", "PE.Ab12", "US.zz", "", "   "];
  for (const canal of ["whatsapp", "messenger", "instagram", "gmail"]) for (const wa of waIds) for (const tm of telsModelo) for (const mon of [undefined, "USD", "PEN"]) {
    n++;
    const input = { origen_texto: "Hotel Belmond, Miraflores", destino_texto: "Aeropuerto", telefono: tm, moneda: mon, precio_tramo: 1, destinatario: "+1999", pax: 2, maletas: 0, sentido: "ida", fecha_servicio: "2026-10-25" };
    const v = validarEntrada(E.entradaDelAgente(input, { canal, waId: wa }, []));
    ok(v.ok, "la entrada del agente siempre es validable");
    if (!v.ok) continue;
    const esperado = canal === "whatsapp" && wa && wa.trim() ? wa.trim() : null;
    ok(v.entrada.telefono === esperado, `teléfono = wa_id del remitente (${canal}, ${wa}, modelo ${tm}) → ${v.entrada.telefono}`);
    ok(M.monedaPorTelefono(v.entrada.telefono).moneda === M.monedaPorTelefono(esperado).moneda, "la moneda es la del remitente");
    ok(!("precio_tramo" in (v.entrada as object)) && !("destinatario" in (v.entrada as object)) && !("moneda" in (v.entrada as object)), "lo que el modelo inventa no pasa");
  }
  console.log(`  barrido: ${n} combinaciones`);
  const r = M.evaluarTraslado({ ...pedido(), telefono: (validarEntrada(E.entradaDelAgente({ telefono: "+13055551234" }, { canal: "whatsapp", waId: "51966707225" }, [])) as any).entrada.telefono }, ctx);
  ok(r.precio?.moneda === "PEN", "un peruano que el modelo «pasa» a extranjero sigue en soles");
  ok(E.entradaDelAgente(null, { canal: "whatsapp", waId: "51966707225" }, []) != null, "un input nulo no revienta");
}

// ── 3. Coordenadas: solo las del enlace de un mensaje entrante ───────────────
seccion("3. Coordenadas inventadas dentro de la geocerca se ignoran");
{
  const enlace = "📍 Ubicación: Av. Larco 1150\nhttps://maps.google.com/?q=-12.1283,-77.0301";
  ok(E.coordenadasVerificadas(-12.1283, -77.0301, [enlace])?.lat === -12.1283, "las del enlace valen");
  ok(E.coordenadasVerificadas("-12.1283", "-77.0301", [enlace]) != null, "en texto numérico también");
  ok(E.coordenadasVerificadas(-12.1283000004, -77.0301, [enlace]) != null, "con 1e-6 de tolerancia");
  ok(E.coordenadasVerificadas(-12.12831, -77.0301, [enlace]) == null, "1e-5 de diferencia no es la misma ubicación");
  ok(E.coordenadasVerificadas(AER.lat, AER.lng, [enlace]) == null, "el centro del aeropuerto, inventado, no vale");
  ok(E.coordenadasVerificadas(AER.lat, AER.lng, []) == null, "sin mensajes entrantes nada vale");
  ok(E.coordenadasVerificadas(null, -77, [enlace]) == null && E.coordenadasVerificadas(NaN, NaN, [enlace]) == null, "nulos y NaN no");
  ok(E.coordenadasVerificadas(-12.0297, -77.1162, ["el aeropuerto queda en -12.0297,-77.1162"]) == null, "números sueltos en el chat no son un enlace");
  // El modelo pone el pin del aeropuerto a un recojo en Miraflores: se ignora y queda el texto.
  const e = validarEntrada(E.entradaDelAgente({ origen_texto: "Hotel Belmond, Miraflores", origen_lat: AER.lat, origen_lng: AER.lng }, { canal: "whatsapp", waId: "51966707225" }, [enlace]));
  ok(e.ok && e.entrada.origen === "Hotel Belmond, Miraflores", "el pin inventado no llega al validador: queda el texto");
  const e2 = validarEntrada(E.entradaDelAgente({ origen_texto: "Mi hotel", origen_lat: -12.1283, origen_lng: -77.0301 }, { canal: "whatsapp", waId: "51966707225" }, [enlace]));
  ok(e2.ok && typeof e2.entrada.origen === "object" && (e2.entrada.origen as any).lat === -12.1283 && (e2.entrada.origen as any).texto === "Mi hotel", "el pin compartido sí llega, con su texto");
  // El pin del aeropuerto compartido DE VERDAD sí vale (y así la zona es el aeropuerto).
  const enlaceAer = `https://maps.google.com/?q=${AER.lat},${AER.lng}`;
  ok(E.coordenadasVerificadas(AER.lat, AER.lng, [enlaceAer]) != null, "el pin del aeropuerto compartido por el cliente sí vale");
}

// ── 4. La firma del pedido ───────────────────────────────────────────────────
seccion("4. firmaPedido");
{
  const base = (x: Partial<EntradaSimulador> = {}): EntradaSimulador => ({
    origen: "Hotel Belmond, Miraflores", destino: "Aeropuerto Jorge Chávez", fecha_servicio: "2026-10-25", hora_servicio: "06:30",
    sentido: "ida", fecha_retorno: null, hora_retorno: null, pax: 2, maletas: 1, telefono: "51966707225", ...x,
  });
  const f = E.firmaPedido(base());
  ok(E.firmaPedido(base({ origen: "  hotel BELMOND,  miraflores ", destino: "AEROPUERTO JORGE CHAVEZ" })) === f, "mayúsculas, tildes y espacios no cambian la firma");
  ok(E.firmaPedido(base({ fecha_retorno: "2026-10-30", hora_retorno: "10:00" })) === f, "con solo ida, el retorno no cuenta");
  ok(E.firmaPedido(base({ telefono: "966707225" })) === f, "dos números peruanos son la misma moneda");
  for (const [n, x] of [["pax", { pax: 3 }], ["maletas", { maletas: 0 }], ["fecha", { fecha_servicio: "2026-10-26" }], ["hora", { hora_servicio: "07:00" }],
    ["sentido", { sentido: "ida_retorno", fecha_retorno: "2026-10-30" }], ["moneda", { telefono: "13055551234" }], ["destino", { destino: "Barranco" }]] as [string, Partial<EntradaSimulador>][]) {
    ok(E.firmaPedido(base(x)) !== f, `cambiar ${n} cambia la firma`);
  }
  const conPin = base({ origen: { lat: -12.12831234, lng: -77.03011111, texto: "x" } });
  ok(E.firmaPedido(conPin) === E.firmaPedido(base({ origen: { lat: -12.128312, lng: -77.030111, texto: "y" } })), "un pin se compara a 5 decimales");
  ok(E.firmaPedido(base({ sentido: "ida_retorno", fecha_retorno: "2026-10-30" })) !== E.firmaPedido(base({ sentido: "ida_retorno", fecha_retorno: "2026-10-31" })), "con ida y retorno, la fecha del retorno sí cuenta");
}

// ── 5. zonaConEnvio ──────────────────────────────────────────────────────────
seccion("5. zonaConEnvio hereda del distrito");
{
  const sjl = z("San Juan de Lurigancho");
  const sub: E.ZonaEnvio = { id: 900, nombre: "SJL · Zona baja", tipo: "subzona", padre_id: sjl.id, lat: -12.02, lng: -77, activo: true };
  const conDistrito: E.ZonaEnvio[] = [...zonasBase.map((x) => ({ ...x, envio_automatico: x.id === sjl.id })), sub];
  ok(E.zonaConEnvio(sub, conDistrito), "la subzona hereda el envío de su distrito");
  ok(!E.zonaConEnvio(sub, conDistrito.map((x) => x.id === sjl.id ? { ...x, activo: false } : x)), "distrito apagado: no hereda");
  ok(!E.zonaConEnvio(sub, [...zonasBase, sub]), "sin marcas (undefined = sin migración): no");
  ok(E.zonaConEnvio(sub, [...zonasBase, { ...sub, envio_automatico: true }]), "la subzona marcada por su cuenta");
  ok(E.zonaConEnvio(AER, zonas), "el aeropuerto marcado");
  ok(!E.zonaConEnvio(z("Miraflores"), zonas), "Miraflores sin marcar");
  ok(!E.zonaConEnvio(null, zonas), "sin zona: no");
  ok(!E.zonaConEnvio({ ...AER }, zonas.map((x) => x.id === AER.id ? { ...x, activo: false } : x)), "zona apagada: no");
  ok(!E.zonaConEnvio(AER, zonas.map((x) => ({ ...x, envio_automatico: null }))), "null no es true");
}

// ── 6. NADA SALE SOLO SI NO ES AEROPUERTO ────────────────────────────────────
seccion("6. planEnvio: solo el aeropuerto sale solo, y solo con todo encendido");
{
  let n = 0, auto = 0, cotizables = 0, sinAeropuertoCotizable = 0;
  const remitentes: [string, string | null][] = [["whatsapp", "51966707225"], ["whatsapp", null], ["messenger", "51966707225"], ["whatsapp", "13055551234"]];
  for (const o of PUNTOS) for (const d of PUNTOS) for (const pax of [2, 10]) for (const mal of [0, 3]) for (const tel of ["+51966707225", "+13055551234"]) for (const s of ["ida", "ida_retorno"] as M.Sentido[]) {
    const r = M.evaluarTraslado(pedido({ origen: o, destino: d, pax, maletas: mal, telefono: tel, sentido: s, fecha_retorno: "2026-10-28" }), ctx);
    if (r.codigo === "cotizable") {
      cotizables++;
      if (r.origen?.zona?.id !== AER.id && r.destino?.zona?.id !== AER.id) sinAeropuertoCotizable++;
    }
    for (const maestro of [false, true]) for (const modoAuto of [false, true]) for (const [canal, waId] of remitentes)
      for (const perfil of [false, true]) for (const cuadra of [false, true]) for (const pdfOk of [false, true]) for (const palabras of [[], ["TDR"]]) {
        n++;
        const p = E.planEnvio({ resultado: r, envioMaestro: maestro, zonas, canal, waId, modoAuto, perfilConfigurado: perfil, cuadra, pdfOk, palabras });
        const esAer = r.origen?.zona?.id === AER.id || r.destino?.zona?.id === AER.id;
        const todo = r.codigo === "cotizable" && maestro && esAer && modoAuto && canal === "whatsapp" && !!waId && perfil && cuadra && pdfOk && palabras.length === 0;
        ok((p.decision === "automatico") === todo, `automático ⟺ todas las condiciones (${r.codigo}, aer ${esAer}, maestro ${maestro}…)`);
        if (p.decision === "automatico") { auto++; ok(esAer, "lo automático tiene el aeropuerto en una punta"); ok(maestro, "con el maestro apagado nunca sale solo"); }
        if (r.codigo !== "cotizable") ok(p.decision === "revision" && p.motivos.length === 0, "lo no cotizable: revisión sin motivos");
        else {
          const esp: E.CodigoRevision[] = [];
          if (!maestro) esp.push("maestro_apagado");
          if (!esAer) esp.push("zona_sin_envio");
          if (!modoAuto) esp.push("modo_copiloto");
          if (canal !== "whatsapp" || !waId) esp.push("sin_remitente");
          if (!perfil) esp.push("perfil_sin_configurar");
          if (!cuadra) esp.push("importes_no_cuadran");
          if (!pdfOk) esp.push("pdf_no_generado");
          if (palabras.length) esp.push("palabras_de_pedido_complejo");
          ok(JSON.stringify(p.motivos) === JSON.stringify(esp), `motivos exactos: ${p.motivos.join(",")} vs ${esp.join(",")}`);
        }
      }
  }
  console.log(`  barrido: ${n} decisiones · ${cotizables} cotizables (${sinAeropuertoCotizable} sin aeropuerto) · ${auto} automáticas`);
  ok(sinAeropuertoCotizable > 0, "el barrido SÍ tiene traslados cotizables sin aeropuerto (si no, la invariante sería trivial)");
  // Corolario: aeropuerto ↔ Miraflores con todo encendido sale sola, en los dos sentidos.
  for (const [o, d] of [[AEROP, MIRA], [MIRA, AEROP]]) for (const s of ["ida", "ida_retorno"] as M.Sentido[]) {
    const r = M.evaluarTraslado(pedido({ origen: o, destino: d, sentido: s, fecha_retorno: "2026-10-28" }), ctx);
    const p = E.planEnvio({ resultado: r, envioMaestro: true, zonas, canal: "whatsapp", waId: "51966707225", modoAuto: true, perfilConfigurado: true, cuadra: true, pdfOk: true, palabras: [] });
    ok(p.decision === "automatico" && p.motivos.length === 0, `aeropuerto ↔ Miraflores (${s}) con todo encendido sale sola`);
  }
  // Miraflores ↔ San Isidro con todo encendido: revisión por la zona.
  const r2 = M.evaluarTraslado(pedido({ origen: MIRA, destino: SI }), ctx);
  ok(r2.codigo === "cotizable", "Miraflores ↔ San Isidro es cotizable en la prueba");
  const p2 = E.planEnvio({ resultado: r2, envioMaestro: true, zonas, canal: "whatsapp", waId: "51966707225", modoAuto: true, perfilConfigurado: true, cuadra: true, pdfOk: true, palabras: [] });
  ok(p2.decision === "revision" && p2.motivos.join() === "zona_sin_envio", "pero queda en revisión por la zona");
  // Sin la migración (zonas sin la columna): nada sale solo aunque el maestro diga true.
  const sinCol = zonasBase as E.ZonaEnvio[];
  const r3 = M.evaluarTraslado(pedido(), { ...ctx, zonas: sinCol });
  ok(E.planEnvio({ resultado: r3, envioMaestro: true, zonas: sinCol, canal: "whatsapp", waId: "51966707225", modoAuto: true, perfilConfigurado: true, cuadra: true, pdfOk: true, palabras: [] }).decision === "revision", "sin la columna de zonas nada sale solo");
  ok(Object.keys(E.MOTIVO_REVISION).length === 8 && Object.values(E.MOTIVO_REVISION).every((m) => m.texto && m.arreglo), "ocho motivos, cada uno con su arreglo");
}

// ── 7. Sin precio nunca se envía ─────────────────────────────────────────────
seccion("7. Sin precio nunca se envía");
{
  for (const p of [pedido({ origen: SJM }), pedido({ pax: 60, maletas: 0 }), pedido({ senales: ["tdr"] }), pedido({ maletas: null }), pedido({ telefono: null })]) {
    const r = M.evaluarTraslado(p, ctx);
    ok(r.precio == null, `${r.codigo} no trae precio`);
    ok(E.planEnvio({ resultado: r, envioMaestro: true, zonas, canal: "whatsapp", waId: "51966707225", modoAuto: true, perfilConfigurado: true, cuadra: true, pdfOk: true, palabras: [] }).decision === "revision", `${r.codigo} nunca sale solo`);
    ok(E.figurasPermitidas("automatico", r.precio).length === 0, `${r.codigo}: ninguna cifra permitida`);
    let lanzo = false;
    try { C.filaCotizacionTraslado(r, entradaDe(p), { convId: "c", clienteId: null, atencion: null, config, firma: "f", hoy: HOY }); } catch { lanzo = true; }
    ok(lanzo, `${r.codigo}: no se arma una fila de cotización sin precio`);
  }
  const r = M.evaluarTraslado(pedido(), ctx);
  ok(E.figurasPermitidas("revision", r.precio).length === 0, "en revisión ninguna cifra está permitida");
  ok(E.figurasPermitidas("automatico", r.precio).includes(r.precio!.total), "en automático, el total sí");
}

// ── 8. Lo que vuelve al modelo ───────────────────────────────────────────────
seccion("8. respuestaParaModelo: lista blanca y sin dinero en revisión");
{
  let n = 0;
  const prohibido = /explicacion|motivo|detalle|alias|"id"|nivel|tipo_cambio|por_distrito|zona|tarifa|subtotal|precio_tramo|"igv"/i;
  for (const o of PUNTOS) for (const d of PUNTOS) for (const pax of [null, 2, 60]) for (const mal of [null, 0, 4]) for (const tel of ["+51966707225", "+13055551234", null])
    for (const s of ["ida", "ida_retorno", null] as (M.Sentido | null)[]) for (const sen of [[], ["evento"]] as M.SenalComplejidad[][]) {
      const r = M.evaluarTraslado(pedido({ origen: o, destino: d, pax, maletas: mal, telefono: tel, sentido: s, fecha_retorno: "2026-10-28", senales: sen }), ctx);
      for (const cot of [null, { numero: "00123", decision: "revision" as const }, { numero: "00123", decision: "automatico" as const }]) {
        n++;
        const json = E.respuestaParaModelo({ resultado: r, cotizacion: cot });
        const o2 = JSON.parse(json);
        ok(Object.keys(o2).every((k) => (E.CLAVES_RESPUESTA_MODELO as readonly string[]).includes(k)), `claves en lista blanca: ${Object.keys(o2)}`);
        if (o2.cotizacion) ok(Object.keys(o2.cotizacion).every((k) => (E.CLAVES_COTIZACION_MODELO as readonly string[]).includes(k)), "claves de la cotización en lista blanca");
        ok(!prohibido.test(json), `sin datos internos: ${json.slice(0, 160)}`);
        for (const l of r.explicacion) ok(!json.includes(l), "ninguna línea de la explicación del motor");
        ok(!json.includes(r.motivo), "el motivo interno no viaja");
        ok(typeof o2.instruccion === "string" && o2.instruccion.length > 0, "siempre dice qué hacer");
        const automatico = r.codigo === "cotizable" && cot?.decision === "automatico";
        if (!automatico) {
          ok(!E.textoContradicePrecio(json, []) && !("total" in (o2.cotizacion ?? {})), `sin ningún importe fuera del envío automático (${r.codigo}/${cot?.decision})`);
          if (r.precio) for (const x of [r.precio.total, r.precio.subtotal, r.precio.precio_tramo]) ok(!json.includes(x.toFixed(2)), "ni la cifra suelta");
        } else {
          ok(o2.cotizacion.total && !E.textoContradicePrecio(json, E.figurasPermitidas("automatico", r.precio)), "en automático solo el total de la cotización");
          ok(o2.cotizacion.validez && /^\d{2}\/\d{2}\/\d{4}$/.test(o2.cotizacion.validez), "y la validez dd/mm/aaaa");
        }
        if (r.accion === "preguntar") ok(Array.isArray(o2.faltan) && o2.faltan.length > 0, "preguntar trae lo que falta");
        else ok(!("faltan" in o2), "lo que falta solo viaja cuando hay que preguntar");
      }
    }
  console.log(`  barrido: ${n} respuestas`);
}

// ── 9. Cuadre ────────────────────────────────────────────────────────────────
seccion("9. La fila reproduce al motor (cuadraConMotor)");
{
  // Columnas reales de `cotizaciones` (producción, 19-10-2026) + las dos de traslados-05.
  const COLUMNAS = new Set(("id cliente_id origen destino km precio_cliente costo_estimado margen_estimado estado pdf_url created_at numero_cotizacion atencion asunto " +
    "punto_retorno fecha_servicio hora_ida hora_retorno descuento_pct items_json numero_aprobacion tipo_aprobacion tipo_vehiculo tipo_servicio equipamiento " +
    "vehiculo_flota_id consideraciones_json paradas_json precio_tarifario precio_cotizador costo_cotizador margen_cotizador vehiculo_cotizador precio_sugerido " +
    "modo_precio enviado_automatico descuento_solicitado descuento_pct_solicitado descuento_autorizado hora_solicitud_descuento modo_servicio dias_servicio " +
    "horas_servicio pernocte_costo precio_dia precio_mes_estimado observaciones tipo creado_por plantilla_pdf vehiculo_tercero_id medio_envio itinerario_texto " +
    "incluye_igv fechas_multidia_json fecha_retorno paradas_retorno_json ficha_ruta_json ruta_coords_json paradas_n moneda tipo_cambio idioma_pdf " +
    "crm_conversacion_id traslado_json").split(/\s+/));
  const PRECIOS = [1, 30, 30.5, 36, 55, 85, 99.99, 100, 126, 216, 260, 350, 900, 1234.56];
  let n = 0, rnd = 12345;
  const azar = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  const tcs: number[] = [];
  for (let k = 0; k < 300; k++) tcs.push(Math.round((2.5 + k * 0.0117) * 10000) / 10000);
  for (let k = 0; k < 100; k++) tcs.push(Math.round((2.5 + azar() * 3.5) * 10000) / 10000);
  for (const precio of PRECIOS) for (const tc of tcs) for (const s of ["ida", "ida_retorno"] as M.Sentido[]) for (const tel of ["+51966707225", "+13055551234"]) {
    if (tel.startsWith("+51") && tc !== tcs[0] && tc !== tcs[150]) continue; // en soles el TC no cuenta: dos muestras bastan
    n++;
    const tar = [{ zona_a_id: Math.min(AER.id, z("Miraflores").id), zona_b_id: Math.max(AER.id, z("Miraflores").id), categoria: "AUTO", moneda: (tel.startsWith("+51") ? "PEN" : "USD") as M.Moneda, precio_tramo: precio, activo: true }];
    const ctxP = { ...ctx, tarifas: tar, tipoCambio: { fecha: HOY, venta: tc } };
    const p = pedido({ sentido: s, fecha_retorno: "2026-10-28", telefono: tel });
    const r = M.evaluarTraslado(p, ctxP);
    if (r.codigo !== "cotizable") { ok(false, `${precio}/${tc}: ${r.codigo} ${r.motivo}`); continue; }
    const fila = C.filaCotizacionTraslado(r, entradaDe(p), { convId: "conv-1", clienteId: null, atencion: "Ana", config, firma: "f", hoy: HOY });
    ok(C.cuadraConMotor(fila, r), `cuadra ${r.precio!.moneda} ${precio} × ${r.precio!.tramos} @ ${tc}`);
    const t = totalesEnMoneda(fila.items_json, fila.moneda, fila.tipo_cambio, true)!;
    ok(t.unitarios[0] === precio, `el unitario recupera EXACTO el precio de lista (${t.unitarios[0]} vs ${precio})`);
    ok(fila.items_json[0].precio_unit === Math.round(fila.items_json[0].precio_unit * 10000) / 10000, "el unitario en soles va a 4 decimales");
    ok(fila.precio_cliente === Math.round(totalesEnMoneda(fila.items_json, "PEN", null, true)!.total * 100) / 100, "precio_cliente = total con IGV en soles");
    // Un ajuste de dos céntimos ya no cuadra.
    const mal = { ...fila, items_json: [{ ...fila.items_json[0], precio_unit: fila.items_json[0].precio_unit + (fila.moneda === "USD" ? 0.02 * tc : 0.02) }] };
    ok(!C.cuadraConMotor(mal, r), "dos céntimos de diferencia no cuadran");
    // IGV del 19 %: el PDF imprimiría 18 → no cuadra.
    const r19 = M.evaluarTraslado(p, { ...ctxP, igvPct: 19 });
    ok(!C.cuadraConMotor(C.filaCotizacionTraslado(r19, entradaDe(p), { convId: "conv-1", clienteId: null, atencion: null, config, firma: "f", hoy: HOY }), r19), "con IGV 19 % no cuadra");
  }
  console.log(`  barrido: ${n} cotizaciones`);
  const r = M.evaluarTraslado(pedido({ telefono: "+13055551234", sentido: "ida_retorno", fecha_retorno: "2026-10-28", pax: 10, maletas: 10 }), ctx);
  const e = entradaDe(pedido({ telefono: "+13055551234", sentido: "ida_retorno", fecha_retorno: "2026-10-28", hora_retorno: "18:00", pax: 10, maletas: 10 }));
  const fila = C.filaCotizacionTraslado(r, e, { convId: "conv-1", clienteId: 7, atencion: "  Ana Pérez ", config, firma: E.firmaPedido(e), hoy: HOY });
  ok(Object.keys(fila).every((k) => COLUMNAS.has(k)), `toda columna existe: ${Object.keys(fila).filter((k) => !COLUMNAS.has(k)).join(", ") || "ok"}`);
  ok(fila.estado === "pendiente" && fila.modo_servicio === "eventual" && fila.tipo_servicio === "ida_retorno" && fila.equipamiento === null && fila.incluye_igv === true, "estado, modo, tipo de servicio, equipamiento null e IGV incluido");
  ok(fila.origen === "Aeropuerto Jorge Chávez" && fila.destino === "Hotel Belmond, Miraflores", "el aeropuerto con el nombre de su zona; el hotel con lo que dijo el cliente");
  ok(fila.moneda === "USD" && fila.tipo_cambio === 3.431 && fila.idioma_pdf === "es" && fila.tipo_vehiculo === "SPRINTER_20", "moneda, TC, idioma y ficha de costeo");
  ok(fila.hora_retorno === "18:00" && fila.fecha_retorno === "2026-10-28" && fila.hora_ida === "06:30", "fechas y horas con los nombres de columna reales");
  ok(fila.consideraciones_json.generales.length === 4 && fila.consideraciones_json.incluye.length === 0, "consideraciones: las generales + la de dólares");
  ok(fila.atencion === "Ana Pérez" && fila.cliente_id === 7 && fila.crm_conversacion_id === "conv-1" && fila.numero_cotizacion === null, "atención, cliente, conversación y número null");
  const tjTxt = JSON.stringify(fila.traslado_json);
  ok(!/precio|total|subtotal|igv|importe/i.test(tjTxt) && !tjTxt.includes(String(r.precio!.precio_tramo * 2)), "traslado_json no lleva importes");
  ok(fila.traslado_json.pax === 10 && fila.traslado_json.maletas === 10 && fila.traslado_json.categoria.clave === "SPRINTER_20" && fila.traslado_json.tramos === 2 && fila.traslado_json.tc_fecha === HOY, "traslado_json con los hechos");
  const enSoles = C.filaCotizacionTraslado(M.evaluarTraslado(pedido(), ctx), entradaDe(pedido()), { convId: "c", clienteId: null, atencion: null, config, firma: "f", hoy: HOY });
  ok(enSoles.tipo_cambio === null && enSoles.consideraciones_json.generales.length === 3 && enSoles.tipo_servicio === "solo_ida" && enSoles.fecha_retorno === null, "en soles sin TC ni la consideración de dólares; solo ida sin retorno");
}

// ── 10. El modelo no pone números ────────────────────────────────────────────
seccion("10. textoContradicePrecio");
{
  const fig = [100, 118, 18, 200, 236, 1234.5];
  const casos: [string, boolean][] = [
    ["El total es S/ 118.00 (IGV incluido).", false],
    ["El total es S/ 120.00.", true],
    ["Son 4 pax y salen a las 10:30 del 25/10/2026.", false],
    ["Cuesta US$ 30", true],
    ["Cuesta 30 dólares", true],
    ["Cuesta 30 DÓLARES", true],
    ["Cuesta $30", true],
    ["Cuesta USD 30", true],
    ["Cuesta 30 USD", true],
    ["Cuesta PEN 99", true],
    ["Cuesta 99 soles", true],
    ["Te cobramos S/. 236", false],
    ["S/ 1,234.50", false],
    ["S/ 1.234,50", false],
    ["S/1,234.51", true],
    ["Total S/ 118.", false],
    ["Hay 2 PENDIENTES", false],
    ["La reserva 30 USDT", false],
    ["Precio: S/118 y S/ 99", true],
    ["Sin precio todavía.", false],
  ];
  for (const [t, esp] of casos) ok(E.textoContradicePrecio(t, fig) === esp, `«${t}» → ${esp}`);
  ok(E.textoContradicePrecio("S/ 118", []), "en revisión cualquier importe contradice");
  ok(E.leerImporte("1,234.50") === 1234.5 && E.leerImporte("120,50") === 120.5 && E.leerImporte("1.234.567") === 1234567 && E.leerImporte("254.88.") === 254.88, "lectura de separadores");
  const auto = E.mensajeCotizacionCodigo({ nombre: "Ana Pérez", numero: "00123", decision: "automatico", total: "S/ 118.00", validez: "18/11/2026" });
  ok(auto.includes("00123") && auto.includes("S/ 118.00") && auto.includes("18/11/2026") && auto.startsWith("Hola Ana,") && !E.textoContradicePrecio(auto, [118]), `mensaje automático: ${auto}`);
  ok(/ejecutivo/.test(auto), "y dice que la disponibilidad la confirma un ejecutivo");
  const rev = E.mensajeCotizacionCodigo({ nombre: "", numero: "00124", decision: "revision", total: "S/ 118.00" });
  ok(rev.includes("00124") && !E.textoContradicePrecio(rev, []) && rev.startsWith("Hola,"), `mensaje en revisión sin importes: ${rev}`);
}

// ── 11. Palabras de pedido complejo ──────────────────────────────────────────
seccion("11. senalesEnTexto: por palabra completa");
{
  const casos: [string, string[]][] = [
    ["Adjunto los TDR del servicio", ["TDR"]],
    ["según los Términos de Referencia", ["términos de referencia"]],
    ["es para una LICITACIÓN", ["licitación"]],
    ["necesito un servicio eventual", []],
    ["para un evento de la empresa", ["evento"]],
    ["queremos un full-day a Paracas", ["full day"]],
    ["un city tour por Lima", ["city tour"]],
    ["¿me hacen un descuento?", ["descuento"]],
    ["firmaríamos contrato anual", ["contrato"]],
    ["Hola AFA Tours, traslado al aeropuerto", []],
    ["la contratación es directa", []],
    ["revisa las bases del concurso", ["bases", "concurso"]],
    ["", []],
  ];
  for (const [t, esp] of casos) ok(JSON.stringify(E.senalesEnTexto([t])) === JSON.stringify(esp), `«${t}» → ${JSON.stringify(E.senalesEnTexto([t]))}`);
  ok(E.senalesEnTexto(["hola", "un evento"]).join() === "evento", "mira todos los textos");
  // Solo BAJA a revisión: no cambia el resultado del motor ni deriva.
  const r = M.evaluarTraslado(pedido(), ctx);
  const p = E.planEnvio({ resultado: r, envioMaestro: true, zonas, canal: "whatsapp", waId: "51966707225", modoAuto: true, perfilConfigurado: true, cuadra: true, pdfOk: true, palabras: E.senalesEnTexto(["con descuento"]) });
  ok(r.codigo === "cotizable" && p.decision === "revision" && p.motivos.join() === "palabras_de_pedido_complejo", "una palabra compleja solo baja a revisión");
}

// ── 12. El PDF ───────────────────────────────────────────────────────────────
seccion("12. aWinAnsi y el PDF con contenido hostil");
const textoDelPdf = (bytes: Uint8Array): string => {
  const s = Buffer.from(bytes).toString("latin1");
  const dec = new TextDecoder("windows-1252");
  let out = "";
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const ini = m.index! + m[0].length;
    const fin = s.indexOf("endstream", ini);
    if (fin < 0) continue;
    const crudo = Buffer.from(s.slice(ini, fin).replace(/\r?\n$/, ""), "latin1");
    let txt: string;
    try { txt = inflateSync(crudo).toString("latin1"); } catch { txt = crudo.toString("latin1"); }
    for (const h of txt.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out += dec.decode(Buffer.from(h[1], "hex")) + "\n";
  }
  return out;
};
const empresaPrueba = empresaConDefectos({ nombre: "Transportes Ñandú", razon_social: "Transportes Ñandú S.A.C.", ruc: "20123456789", telefono: "+51 999 888 777", web: "www.ejemplo.pe", email: "ventas@ejemplo.pe", direccion: "Av. Peñaloza 123, Lima" });
await (async () => {
  const doc = await PDFDocument.create();
  const f = await doc.embedFont(StandardFonts.Helvetica);
  const cs = new Set(f.getCharacterSet());
  const hostil = "Juan 😀 <script>alert(1)</script> → ↔ ✈️ «Ñandú» · 20 °C €\n\tfin";
  const w = C.aWinAnsi(hostil, cs);
  ok(!/[😀✈]/u.test(w) && w.includes("->") && w.includes("<->") && w.includes("«Ñandú»") && w.includes("°") && w.includes("€") && !/[\n\t]/.test(w), `aWinAnsi: ${w}`);
  let lanza = false; try { f.encodeText(w); f.widthOfTextAtSize(w, 10); } catch { lanza = true; }
  ok(!lanza, "lo que devuelve aWinAnsi siempre se puede dibujar");
  const largo = C.aWinAnsi("a".repeat(5000), cs, 100);
  ok(Array.from(largo).length === 100 && largo.endsWith("…"), "el tope corta y termina en «…»");
  ok(C.aWinAnsi("é", cs) === "é", "una tilde combinada se compone");
  // Barrido de caracteres: nada de lo que sale lanza.
  let malos = 0;
  for (let cp = 0; cp < 0x3000; cp += 7) {
    const s = C.aWinAnsi(`x${String.fromCodePoint(cp)}y`, cs);
    try { f.encodeText(s); } catch { malos++; }
  }
  ok(malos === 0, `ningún carácter rompe el dibujo (${malos})`);
})();

const pHostil = pedido({ pax: 10, maletas: 10, sentido: "ida_retorno", fecha_retorno: "2026-10-28", hora_retorno: "18:00" });
const rHostil = M.evaluarTraslado(pHostil, ctx);
const eHostil = { ...entradaDe(pHostil), destino: "Hotel 😀 <script>alert('x')</script> → Miraflores ↔ ✈️ " + "Ñ".repeat(400) };
const filaH = C.filaCotizacionTraslado(rHostil, eHostil, { convId: "c", clienteId: null, atencion: "Peña 👍 <b>", config, firma: "f", hoy: HOY });
const leidaH: C.FilaCotizacionLeida = {
  ...filaH, id: 123, created_at: "2026-10-20T03:00:00Z",
  items_json: [{ ...filaH.items_json[0], descripcion: "x".repeat(5000) + " 🚐" }],
  consideraciones_json: { generales: [...filaH.consideraciones_json.generales, ...Array.from({ length: 90 }, (_, i) => `Consideración ${i + 1}\tcon\nsaltos 😀 y señal ñ`)], incluye: [], no_incluye: [] },
};
const contH = C.contenidoPdfTraslado(leidaH, empresaPrueba, { colorPrimario: "#0a7" });
ok(contH.numero === "00123" && contH.fecha === "19/10/2026", `número con ceros y fecha de Lima (${contH.numero}, ${contH.fecha})`);
ok(contH.color === "#00aa77", "color #rgb normalizado");
ok(C.contenidoPdfTraslado(leidaH, empresaPrueba, { ejemplo: true }).numero === "EJEMPLO", "con «ejemplo» el número dice EJEMPLO");
ok(contH.aviso === "La disponibilidad de la unidad y la reserva del servicio las confirma un ejecutivo.", "la línea fija");
ok(contH.logoUrl === null, "sin logo en el perfil: sin logo");
ok(C.contenidoPdfTraslado(leidaH, empresaConDefectos({ nombre: "X", logo_url: "https://x/logo.png" })).logoUrl === "https://x/logo.png", "el logo es el del perfil");
ok(!JSON.stringify(contH).includes(LOGO_DEFAULT), "nunca el logo del bundle");
const totTxt = contH.totales.map((t) => `${t.etiqueta} ${t.valor}`).join(" | ");
ok(totTxt === `Subtotal S/ 700.00 | IGV (18 %) S/ 126.00 | Total (IGV incluido) S/ 826.00`, `totales con las funciones de /cotizaciones: ${totTxt}`);
ok(contH.tabla.filas[0][1] === "2" && contH.tabla.filas[0][2] === "S/ 350.00", "2 tramos × S/ 350.00");
const usdR = M.evaluarTraslado(pedido({ telefono: "+13055551234" }), ctx);
const usdF = C.filaCotizacionTraslado(usdR, entradaDe(pedido({ telefono: "+13055551234" })), { convId: "c", clienteId: null, atencion: null, config, firma: "f", hoy: HOY });
const usdC = C.contenidoPdfTraslado({ ...usdF, id: 9 }, empresaPrueba, { hoy: HOY });
ok(usdC.totales.at(-1)!.valor === `US$ ${usdR.precio!.total.toFixed(2)}`, `en dólares, el total del motor (${usdC.totales.at(-1)!.valor})`);
let lanzaSinTc = false; try { C.contenidoPdfTraslado({ ...usdF, id: 9, tipo_cambio: null }, empresaPrueba); } catch { lanzaSinTc = true; }
ok(lanzaSinTc, "en dólares sin tipo de cambio no hay PDF");
ok(C.perfilConfigurado({ nombre: "X" }) && C.perfilConfigurado({ razon_social: "Y" }) && !C.perfilConfigurado(null) && !C.perfilConfigurado({ nombre: "  " }), "perfilConfigurado = el perfil tiene nombre");
ok(C.contenidoPdfTraslado(leidaH, empresaConDefectos(null)).perfilSinConfigurar, "sin perfil, el contenido lo dice");
ok(C.nombreArchivoPdf("00123") === "Cotizacion-00123.pdf" && /^[\x20-\x7e]+$/.test(C.nombreArchivoPdf("Ñ/../é 12")) && !C.nombreArchivoPdf("Ñ/../é 12").includes("/"), "nombre de archivo ASCII y sin barras");
ok(C.rutaPdf(12, "2026-10", "123e4567-e89b-12d3-a456-426614174000") === "cotizaciones-ia/2026-10/12-123e4567-e89b-12d3-a456-426614174000.pdf", "ruta del bucket");
for (const [id, ym, u] of [[0, "2026-10", "123e4567-e89b-12d3-a456-426614174000"], [1, "../..", "123e4567-e89b-12d3-a456-426614174000"], [1, "2026-10", "../x"]] as [number, string, string][]) {
  let l = false; try { C.rutaPdf(id, ym, u); } catch { l = true; }
  ok(l, `ruta inválida rechazada (${id}, ${ym}, ${u})`);
}
const cap = C.captionDocumento({ id: 123, numero_cotizacion: null, origen: "Aeropuerto Jorge Chávez", destino: "Miraflores" }, empresaPrueba);
ok(cap === "Cotización N° 00123 · Aeropuerto Jorge Chávez → Miraflores · Transportes Ñandú", `caption: ${cap}`);
ok(!C.captionDocumento({ id: 1, numero_cotizacion: "A-1", origen: "a", destino: "b" }, empresaConDefectos(null)).includes("CONFIGURA"), "el caption no lleva el aviso del perfil vacío");
ok(numeroCotizacion({ id: 7, numero_cotizacion: null }) === "00007" && numeroCotizacion({ id: 7, numero_cotizacion: "COT-9" }) === "COT-9", "numeroCotizacion");

// El logo de prueba: un PNG hecho con sharp (dependencia del proyecto).
const sharp = (await import("sharp")).default;
const logoPng = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="110"><rect width="300" height="110" rx="14" fill="#00aa77"/><text x="150" y="70" font-size="44" font-family="Arial" font-weight="bold" fill="#fff" text-anchor="middle">LOGO</text></svg>`)).png().toBuffer();
{
  let bytes: Uint8Array | null = null, err = "";
  try { bytes = await dibujarPdfTraslado(contH, { bytes: new Uint8Array(logoPng), tipo: "png" }); } catch (e) { err = (e as Error).message; }
  ok(!!bytes, `el PDF hostil se dibuja sin lanzar ${err}`);
  if (bytes) {
    ok(Buffer.from(bytes.slice(0, 5)).toString("latin1") === "%PDF-", "empieza por %PDF-");
    const txt = textoDelPdf(bytes);
    ok(txt.includes("Transportes Ñandú") && txt.includes("Peñaloza") && txt.includes("Atención:") && txt.includes("señal ñ"), "tildes y ñ se ven en el texto del PDF");
    ok(txt.includes("COTIZACIÓN DE TRASLADO") && txt.includes("N° 00123") && txt.includes("S/ 826.00"), "título, número y total");
    ok(txt.includes("La disponibilidad de la unidad y la reserva del servicio las confirma un ejecutivo."), "la línea fija se imprime");
    ok(/Página 2 de \d/.test(txt), "noventa consideraciones parten la página");
    ok(!/\bAFA\b/.test(txt) && !txt.includes(LOGO_DEFAULT), "sin «AFA» ni el logo del bundle");
    ok(txt.includes("<script>"), "el <script> del cliente es texto plano (un PDF no ejecuta HTML)");
    const doc = await PDFDocument.load(bytes);
    ok(doc.getPageCount() >= 2, `páginas: ${doc.getPageCount()}`);
  }
  // Sin logo, con un logo corrupto y con el perfil vacío: tampoco lanza.
  for (const [n, logo, emp] of [["sin logo", null, empresaPrueba], ["logo corrupto", { bytes: new Uint8Array([1, 2, 3]), tipo: "png" as const }, empresaPrueba], ["perfil vacío", null, empresaConDefectos(null)]] as const) {
    let l = false; try { await dibujarPdfTraslado(C.contenidoPdfTraslado(leidaH, emp), logo); } catch { l = true; }
    ok(!l, `${n}: no lanza`);
  }
  // Los módulos no traen ningún dato de una empresa concreta.
  for (const archivo of ["lib/traslados/cotizacion-traslado.ts", "lib/traslados/pdf-traslado.ts", "lib/traslados/envio-ia.ts"]) {
    const src = readFileSync(archivo, "utf8");
    ok(!src.includes("LOGO_DEFAULT") && !/\bAFA\b/.test(src) && !/afatours|logoafa/i.test(src), `${archivo} sin LOGO_DEFAULT ni «AFA»`);
  }
  // Muestra para mirar (no la exige la matriz): con un traslado normal y el logo de prueba.
  const muestraDir = process.env.MUESTRA_PDF;
  if (muestraDir) {
    const { writeFileSync } = await import("node:fs");
    const rM = M.evaluarTraslado(pedido({ pax: 3, maletas: 2, sentido: "ida_retorno", fecha_retorno: "2026-10-28", hora_retorno: "18:00" }), ctx);
    const eM = { ...entradaDe(pedido({ pax: 3, maletas: 2, sentido: "ida_retorno", fecha_retorno: "2026-10-28", hora_retorno: "18:00" })), destino: "Hotel Belmond Miraflores Park, Av. Malecón de la Reserva 1035, Miraflores" };
    const fM = C.filaCotizacionTraslado(rM, eM, { convId: "c", clienteId: null, atencion: "Ana Pérez Núñez", config, firma: "f", hoy: HOY });
    const cM = C.contenidoPdfTraslado({ ...fM, id: 1234, created_at: "2026-10-19T15:00:00Z" }, empresaPrueba, { colorPrimario: "#0b5394" });
    writeFileSync(muestraDir, await dibujarPdfTraslado(cM, { bytes: new Uint8Array(logoPng), tipo: "png" }));
    console.log(`  muestra: ${muestraDir}`);
  }
}

// ── 13. Topes ────────────────────────────────────────────────────────────────
seccion("13. decidirTope");
{
  const T = E.TOPES;
  const c0 = { consultasConv: 0, consultasDia: 0, cotizacionesConv: 0, cotizacionesDia: 0, consultasTurno: 0 };
  ok(E.decidirTope(c0, "consulta").ok && E.decidirTope(c0, "cotizacion").ok, "con todo en cero, pasa");
  for (const k of ["consultasConv", "consultasDia"] as const) {
    ok(!E.decidirTope({ ...c0, [k]: null }, "consulta").ok, `${k} null bloquea la consulta`);
    ok(E.decidirTope({ ...c0, [k]: null }, "cotizacion").ok, `${k} null no toca la fase de cotización`);
  }
  for (const k of ["cotizacionesConv", "cotizacionesDia"] as const) {
    ok(!E.decidirTope({ ...c0, [k]: null }, "cotizacion").ok, `${k} null bloquea la cotización`);
  }
  const borde: [keyof typeof c0, number, "consulta" | "cotizacion"][] = [
    ["consultasTurno", T.MAX_CONSULTAS_POR_TURNO, "consulta"], ["consultasConv", T.MAX_CONSULTAS_CONV_DIA, "consulta"], ["consultasDia", T.MAX_CONSULTAS_DIA, "consulta"],
    ["cotizacionesConv", T.MAX_COTIZACIONES_CONV_DIA, "cotizacion"], ["cotizacionesDia", T.MAX_COTIZACIONES_DIA, "cotizacion"],
  ];
  for (const [k, max, fase] of borde) {
    ok(E.decidirTope({ ...c0, [k]: max - 1 }, fase).ok, `${k} = ${max - 1} pasa`);
    const r = E.decidirTope({ ...c0, [k]: max }, fase);
    ok(!r.ok && !!r.motivo, `${k} = ${max} se detiene con su motivo`);
  }
  ok(!E.decidirTope({ ...c0, consultasDia: NaN }, "consulta").ok, "un NaN no es un conteo");
  ok(T.MAX_CONSULTAS_POR_TURNO === 2 && T.MAX_CONSULTAS_CONV_DIA === 10 && T.MAX_CONSULTAS_DIA === 300 && T.MAX_COTIZACIONES_CONV_DIA === 3 && T.MAX_COTIZACIONES_DIA === 80 && T.VENTANA_MISMO_PEDIDO_MIN === 120, "los topes declarados");
}

// ── 14. planAccionTraslado ───────────────────────────────────────────────────
seccion("14. planAccionTraslado: cada código");
{
  const ahora = Date.parse("2026-10-19T15:00:00Z");
  const acc = { tipo: "cotizacion_traslado", estado: "pendiente", conversacion_id: "conv-1", resuelta_at: null as string | null, resultado_id: 5 };
  const r = M.evaluarTraslado(pedido(), ctx);
  const fila = C.filaCotizacionTraslado(r, entradaDe(pedido()), { convId: "conv-1", clienteId: null, atencion: null, config, firma: "f", hoy: HOY });
  const cot = { ...fila, id: 5 };
  const conv = { id: "conv-1", canal: "whatsapp", wa_id: "51966707225" };
  const P = (a: any, c: any, v: any) => E.planAccionTraslado(a, c, v, ahora).codigo;
  ok(P(acc, cot, conv) === "ok", "todo bien → ok");
  ok(P({ ...acc, estado: "aprobada" }, cot, conv) === "no_pendiente", "aprobada → no_pendiente");
  ok(P({ ...acc, estado: "rechazada" }, cot, conv) === "no_pendiente", "rechazada → no_pendiente");
  ok(P({ ...acc, estado: "enviando", resuelta_at: new Date(ahora + 60_000).toISOString() }, cot, conv) === "no_pendiente", "enviando dentro del plazo → no_pendiente");
  ok(P({ ...acc, estado: "enviando", resuelta_at: new Date(ahora - 1).toISOString() }, cot, conv) === "ok", "enviando con el plazo vencido → se puede reintentar");
  ok(P({ ...acc, estado: "enviando", resuelta_at: null }, cot, conv) === "ok", "enviando sin plazo escrito → vencido");
  ok(Date.parse(E.plazoEnvio(ahora)) - ahora === E.PLAZO_ENVIO_MS && E.PLAZO_ENVIO_MS === 300_000, "el plazo del reclamo es de 5 minutos");
  ok(P({ ...acc, tipo: "cotizacion" }, cot, conv) === "cotizacion_no_existe", "otro tipo de acción → no es una cotización de traslado");
  ok(P(acc, null, conv) === "cotizacion_no_existe", "sin cotización → cotizacion_no_existe");
  ok(P(acc, { ...cot, crm_conversacion_id: "otra" }, conv) === "cotizacion_ajena", "cotización de otra conversación → ajena");
  ok(P(acc, { ...cot, id: 6 }, conv) === "cotizacion_ajena", "la acción apunta a otra cotización → ajena");
  ok(P(acc, { ...cot, traslado_json: null }, conv) === "cotizacion_ajena", "sin traslado_json → ajena");
  ok(P(acc, cot, { ...conv, canal: "messenger" }) === "canal_no_whatsapp", "messenger → canal_no_whatsapp");
  ok(P(acc, cot, null) === "canal_no_whatsapp", "sin conversación → canal_no_whatsapp");
  ok(P(acc, cot, { ...conv, wa_id: "  " }) === "sin_remitente", "sin wa_id → sin_remitente");
  ok(P(acc, { ...cot, items_json: [] }, conv) === "sin_precio", "sin ítems → sin_precio");
  ok(P(acc, { ...cot, items_json: [{ ...fila.items_json[0], precio_unit: 0 }] }, conv) === "sin_precio", "en cero → sin_precio");
  ok(P(acc, { ...cot, moneda: "USD", tipo_cambio: null }, conv) === "sin_precio", "en dólares sin TC → sin_precio");
  const codigos = new Set(["ok", "no_pendiente", "cotizacion_ajena", "cotizacion_no_existe", "canal_no_whatsapp", "sin_remitente", "sin_precio"]);
  ok(codigos.size === 7, "los siete códigos probados");
}

// ── 15. estadoCotizadorIA ────────────────────────────────────────────────────
seccion("15. estadoCotizadorIA: ocho códigos y la regla del ámbar");
{
  const vistos = new Set<string>();
  const AMBAR = new Set(["sin_migracion", "agente_no_autonomo", "envio_sin_zonas"]);
  const agentes = [
    null,
    { activo: false, canales: ["whatsapp"], canales_autonomos: ["whatsapp"] },
    { activo: true, canales: ["messenger"], canales_autonomos: ["messenger"] },
    { activo: true, canales: ["whatsapp"], canales_autonomos: [] },
    { activo: true, canales: ["whatsapp"], canales_autonomos: ["whatsapp"] },
    { activo: true, canales: ["whatsapp"], canales_autonomos: ["whatsapp"], horario_activo: true, hora_inicio: "08:00", hora_fin: "20:00" },
    { activo: true, canales: ["whatsapp"], canales_autonomos: ["whatsapp"], horario_activo: false },
  ];
  let n = 0;
  for (const sinMigracion of [false, true]) for (const iaCotiza of [false, true]) for (const envioMaestro of [false, true]) for (const zs of [[], ["Aeropuerto Jorge Chávez"], ["Aeropuerto Jorge Chávez", "Miraflores"]]) for (const agente of agentes) {
    n++;
    const e = E.estadoCotizadorIA({ iaCotiza, envioMaestro, zonasConEnvio: zs, agente, sinMigracion });
    vistos.add(e.codigo);
    ok(e.ambar === AMBAR.has(e.codigo), `ámbar ⟺ ${[...AMBAR].join("/")} (${e.codigo})`);
    ok(e.lineas.length > 0 && e.lineas.every((l) => l.length > 10), "siempre dice algo");
    if (sinMigracion) ok(e.codigo === "sin_migracion", "sin migración manda");
    else if (!iaCotiza) ok(e.codigo === "apagado", "apagado");
    if (e.codigo === "agente_no_autonomo") ok(iaCotiza, "agente no autónomo solo alarma con la IA cotizando");
    if (e.codigo === "activo" || e.codigo === "con_horario") ok(envioMaestro && zs.length > 0, "activo ⟹ envío encendido con zonas");
    if (e.codigo === "con_horario") ok(e.lineas.some((l) => l.includes("08:00") && l.includes("20:00")), "el horario se nombra");
    if (e.codigo === "activo") ok(e.lineas[0].includes(zs[zs.length - 1]), "las zonas se nombran");
  }
  ok(vistos.size === 8, `los ocho códigos aparecen (${[...vistos].join(", ")})`);
  console.log(`  barrido: ${n} configuraciones`);
}

// ── 16. El SQL ───────────────────────────────────────────────────────────────
seccion("16. supabase/traslados-05-cotizacion-ia.sql");
{
  const ruta = "supabase/traslados-05-cotizacion-ia.sql";
  if (!existsSync(ruta)) {
    pendientes.push(`${ruta} todavía no existe (lo escribe datos-sql): sección 16 PENDIENTE.`);
    console.log("  PENDIENTE: el archivo aún no existe.");
  } else {
    const sql = readFileSync(ruta, "utf8");
    const lineas = sql.replace(/\n+$/, "").split("\n");
    ok(lineas.length < 100, `menos de 100 líneas (tiene ${lineas.length})`);
    ok(lineas[lineas.length - 1].trim() === "-- FIN de traslados-05-cotizacion-ia.sql", "termina en «-- FIN de traslados-05-cotizacion-ia.sql»");
    const sinComentarios = sql.replace(/--[^\n]*/g, "");
    ok(!/\bselect\b[^;]*\binto\b/i.test(sinComentarios), "sin SELECT … INTO");
    ok(/traslados_config[\s\S]*?ia_cotiza\s+boolean\s+not\s+null\s+default\s+false/i.test(sinComentarios), "traslados_config.ia_cotiza default false");
    ok(/traslados_config[\s\S]*?envio_automatico\s+boolean\s+not\s+null\s+default\s+false/i.test(sinComentarios), "traslados_config.envio_automatico default false");
    ok(/zonas_traslado[\s\S]*?envio_automatico\s+boolean\s+not\s+null\s+default\s+false/i.test(sinComentarios), "zonas_traslado.envio_automatico default false");
    ok(/crm_conversacion_id\s+uuid/i.test(sinComentarios) && /traslado_json\s+jsonb/i.test(sinComentarios), "cotizaciones.crm_conversacion_id y traslado_json");
    // El bloque empieza en su encabezado («-- ── SOLO AFA …»), no en la primera mención del nombre.
    const iAfa = sql.search(/^--\s*─*\s*SOLO AFA/im);
    ok(iAfa > 0, "tiene el bloque «SOLO AFA» separado, con su encabezado");
    if (iAfa > 0) {
      const bloque = sql.slice(iAfa).replace(/--[^\n]*/g, "");
      // Lo único que ESCRIBE es UPDATE: un guardia de solo lectura (do … raise) y las consultas de
      // verificación (select) se permiten; insertar, borrar o cambiar el esquema, no.
      ok(!/\b(insert|delete|alter|create|drop|truncate|grant|revoke|merge)\b/i.test(bloque), "el bloque AFA no inserta, no borra y no toca el esquema");
      const escrituras = [...bloque.matchAll(/\b(update|insert|delete)\b/gi)].map((m) => m[1].toLowerCase());
      ok(escrituras.length > 0 && escrituras.every((w) => w === "update"), `el bloque AFA solo escribe con UPDATE (${escrituras.join(", ")})`);
      const cuerposDo = [...bloque.matchAll(/do\s+\$\$([\s\S]*?)\$\$/gi)].map((m) => m[1]);
      ok(cuerposDo.every((b) => !/\b(update|insert|delete)\b/i.test(b)), "los bloques DO del tramo AFA solo comprueban");
      ok(/aeropuerto/i.test(bloque), "el bloque AFA marca el aeropuerto");
      const marcaZonas = [...bloque.matchAll(/update\s+public\.zonas_traslado\s+set\s+envio_automatico\s*=\s*true([\s\S]*?);/gi)].map((m) => m[1]);
      ok(marcaZonas.length > 0 && marcaZonas.every((w) => /aeropuerto/i.test(w) && /tipo\s*=\s*'punto'/i.test(w)), "y marca SOLO la geocerca del aeropuerto");
    }
    ok(!/default\s+true/i.test(sinComentarios), "ningún interruptor nace encendido");
  }
}

console.log(`\n${oks} ok · ${fallos} fallos`);
for (const p of pendientes) console.log(`  ${p}`);
if (fallos) process.exit(1);
