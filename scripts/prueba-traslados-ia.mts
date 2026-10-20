/* eslint-disable @typescript-eslint/no-explicit-any -- la matriz arma resultados y filas a mano */
// Matriz de la IA del CRM cotizando traslados — npx tsx scripts/prueba-traslados-ia.mts
//
// lib/traslados/envio-ia.ts (qué acepta del modelo, qué le devuelve, si se envía sola),
// lib/traslados/cotizacion-traslado.ts (la fila de `cotizaciones` y la entrada de su PDF) y
// lib/pdf-corporativo.ts (el dibujo: la plantilla corporativa de /cotizaciones; su comparación con
// el HTML está en prueba-traslados-pdf-corporativo.mts). Las zonas, categorías y precios se LEEN de los SQL de
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
import * as T from "../lib/traslados/texto-libre";
import { dibujarPdfCorporativo } from "../lib/pdf-corporativo";
import { docCorporativo } from "../lib/cotizacion-corporativo";
import { validarEntrada, type EntradaSimulador } from "../lib/traslados/api";
import { totalesEnMoneda } from "../lib/cotizacion-moneda";
import { empresaConDefectos } from "../lib/empresa-perfil";
import { numeroCotizacion } from "../lib/cotizacion-pdf";
import { LOGO_DEFAULT } from "../lib/pdf-chrome";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { cotizarTrasladoIA, CLAVE_CONSULTA_IA, type CtxCotizarIA } from "../lib/traslados/cotizar-ia-datos";
import { enviarCotizacionTraslado, bajarLogo, accionAjena, pdfDeCotizacion, type DepsEnvio } from "../lib/traslados/enviar-cotizacion-datos";
import { limitarTasa } from "../lib/api-guard";
import type { CatalogoTraslados } from "../lib/traslados/datos";
import type { EstiloMensajes } from "../lib/crm-ia-ajustes";

// Los textos que arma el CÓDIGO hablan con el trato y el modo de preguntar del agente
// (lib/crm-ia-ajustes.ts). Las aserciones literales de siempre son las de «tu» + «todo junto», que es
// lo que el código escribía antes de existir el ajuste; los otros tres estilos se barren aparte.
const TU: EstiloMensajes = { tratamiento: "tu", preguntas: "todo_junto" };
const ESTILOS: EstiloMensajes[] = [
  TU, { tratamiento: "tu", preguntas: "una_por_mensaje" },
  { tratamiento: "usted", preguntas: "todo_junto" }, { tratamiento: "usted", preguntas: "una_por_mensaje" },
];
const nombreEstilo = (e: EstiloMensajes) => `${e.tratamiento}/${e.preguntas}`;
/** Formas de tú dirigidas al cliente (y de usted), por palabra completa. */
const TUTEA = /(?:^|[^\p{L}])(?:tu|tus|te|ti|contigo|enviarte|indicas)(?=[^\p{L}]|$)/iu;
const USTEDEA = /(?:^|[^\p{L}])(?:usted|ustedes|su|sus|le|enviarle|indica)(?=[^\p{L}]|$)/iu;

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
  // La ÚNICA puerta a la moneda es `cliente_pide_dolares`: un booleano (no puede nombrar una
  // moneda ni un precio) que además se verifica contra los mensajes del cliente (sección 2b).
  const DECLARADAS = ["cliente_pide_dolares"];
  ok(!props.filter((p) => !DECLARADAS.includes(p)).some((p) => /tel|phone|moneda|currency|precio|price|importe|total|destinatario|wa_id|numero|dolar|usd|pen\b|soles/i.test(p)), `sin campos de dinero ni destinatario (${props.join(", ")})`);
  ok((h.input_schema as any).properties.cliente_pide_dolares?.type === "boolean", "cliente_pide_dolares es un booleano: solo puede pedir la lista en dólares");
  ok(/dólares/i.test(h.description) && /comprueba/i.test(h.description), "la descripción dice que el pedido de dólares se comprueba");
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

// ── 2b. Dólares a pedido: el modelo Y los mensajes del cliente ────────────────
seccion("2b. El cliente que pide dólares los recibe; el modelo solo nunca cambia la moneda");
{
  // nombraDolares: por palabra completa, o el signo «$».
  const si = ["¿Cuánto sería en dólares?", "precio en USD por favor", "US$?", "me lo das en $", "DOLARES AMERICANOS", "dollars please", "en dolar", "$50 está bien?"];
  const no = ["en soles", "S/ 100", "", "dolarizado", "usda", "dolare", "el aeropuerto queda lejos"];
  for (const t of si) ok(E.nombraDolares([t]), `«${t}» nombra los dólares`);
  for (const t of no) ok(!E.nombraDolares([t]), `«${t}» no nombra los dólares`);
  ok(!E.nombraDolares(null) && !E.nombraDolares([]) && !E.nombraDolares([null, 5, {}] as unknown[]), "sin textos (o sin texto de verdad), no");
  ok(E.nombraDolares(["hola", null, "y en dólares?"] as unknown[]), "basta con uno de los mensajes");

  // monedaDelPedido: sin pedido de dólares es EXACTAMENTE monedaPorTelefono.
  const tels = [null, "", "+51966707225", "966707225", "13055551234", "PE.x", "US.y", "123", "  +51 966 707 225 "];
  for (const t of tels) for (const pd of [undefined, null, false]) {
    ok(JSON.stringify(M.monedaDelPedido(t, pd)) === JSON.stringify(M.monedaPorTelefono(t)), `sin pedido de dólares = por el número (${t}, ${pd})`);
  }
  for (const t of tels) {
    const r = M.monedaDelPedido(t, true);
    ok(r.moneda === "USD", `con pedido de dólares, dólares (${t})`);
    if (M.monedaPorTelefono(t).moneda === "USD") ok(JSON.stringify(r) === JSON.stringify(M.monedaPorTelefono(t)), `un extranjero que pide dólares: lo de siempre (${t})`);
    else ok(r.codigo === "pide_dolares" && /pidió la cotización en dólares/.test(r.detalle), `un peruano (o sin número) que pide dólares: pide_dolares (${t})`);
  }

  // El barrido: canal × wa_id × lo que marca el modelo × lo que escribió el cliente × señales.
  let n = 0;
  const marcas: unknown[] = [undefined, true, false, "true", 1, null];
  const textosCli: string[][] = [[], ["¿me lo cotizas en dólares?"], ["en soles por favor"], ["US$ 50?"], ["Hola", "precio"]];
  const senalesM: unknown[] = [undefined, ["otra_moneda"], ["otra_moneda", "tdr"], ["tdr"]];
  for (const canal of ["whatsapp", "instagram"]) for (const wa of ["51966707225", "13055551234", null]) for (const marca of marcas) for (const tc of textosCli) for (const sen of senalesM) {
    n++;
    const input = { origen_texto: "Aeropuerto", destino_texto: "Miraflores", pax: 2, maletas: 0, sentido: "ida", fecha_servicio: "2026-10-25", cliente_pide_dolares: marca, senales: sen, moneda: "USD" };
    const v = validarEntrada(E.entradaDelAgente(input, { canal, waId: wa }, [], tc));
    ok(v.ok, "validable");
    if (!v.ok) continue;
    const confirmado = marca === true && E.nombraDolares(tc);
    ok((v.entrada.pide_dolares === true) === confirmado, `pide_dolares solo con las DOS confirmaciones (modelo ${String(marca)}, cliente ${JSON.stringify(tc)})`);
    ok(confirmado || !("pide_dolares" in v.entrada), "sin confirmación, la clave ni aparece");
    const mon = M.monedaDelPedido(v.entrada.telefono, v.entrada.pide_dolares).moneda;
    // LA INVARIANTE: lo que diga el modelo, por sí solo, nunca cambia la moneda.
    if (!confirmado) ok(mon === M.monedaPorTelefono(v.entrada.telefono).moneda, `el modelo solo no cambia la moneda (${canal}, ${wa}, ${String(marca)}, ${JSON.stringify(tc)})`);
    else ok(mon === "USD", "con las dos confirmaciones, dólares");
    const sv = v.entrada.senales ?? [];
    const pedidas = Array.isArray(sen) ? (sen as string[]) : [];
    if (confirmado) ok(!sv.includes("otra_moneda") && pedidas.filter((x) => x !== "otra_moneda").every((x) => sv.includes(x as M.SenalComplejidad)), "con dólares confirmados, otra_moneda sobra y el resto de señales sigue");
    else ok(pedidas.every((x) => sv.includes(x as M.SenalComplejidad)), "sin confirmación, las señales pasan tal cual (otra_moneda deriva)");
  }
  console.log(`  barrido: ${n} combinaciones`);

  // El motor: un peruano que pide dólares recibe la LISTA en dólares (no una conversión de la de soles).
  const usdAuto = precios.find((p) => p.categoria === "AUTO")!.usd;
  const r = M.evaluarTraslado(pedido({ telefono: "+51966707225", pide_dolares: true }), ctx);
  ok(r.codigo === "cotizable" && r.precio?.moneda === "USD" && r.precio.precio_tramo === usdAuto, `peruano que pide dólares → lista en dólares (${r.precio?.moneda} ${r.precio?.precio_tramo})`);
  ok(r.precio?.tipo_cambio === 3.431 && Math.abs((r.precio?.subtotal_pen ?? 0) - usdAuto * 3.431) < 0.01, "se guarda en soles al TC SUNAT");
  ok(r.explicacion.some((x) => /pidió la cotización en dólares/.test(x)), "la explicación lo dice (la lee el ejecutivo)");
  const rx = M.evaluarTraslado(pedido({ telefono: "+13055551234", pide_dolares: true }), ctx);
  const rx0 = M.evaluarTraslado(pedido({ telefono: "+13055551234" }), ctx);
  ok(JSON.stringify(rx) === JSON.stringify(rx0), "un extranjero que pide dólares: el mismo resultado de siempre");
  ok(M.evaluarTraslado(pedido({ pide_dolares: true }), { ...ctx, tipoCambio: null }).codigo === "sin_tipo_cambio", "sin tipo de cambio SUNAT, se deriva");
  ok(M.evaluarTraslado(pedido({ telefono: null, pide_dolares: true }), ctx).precio?.moneda === "USD", "sin número pero pidiendo dólares: dólares (el envío lo decide planEnvio)");
  ok(M.evaluarTraslado(pedido({ pide_dolares: true, senales: ["otra_moneda"] }), ctx).codigo === "complejo", "el motor no quita señales: eso lo hace entradaDelAgente");
  for (const p of [pedido(), pedido({ telefono: "13055551234" }), pedido({ telefono: null }), pedido({ destino: SI, sentido: "ida_retorno", fecha_retorno: "2026-10-27" })]) {
    ok(JSON.stringify(M.evaluarTraslado(p, ctx)) === JSON.stringify(M.evaluarTraslado({ ...p, pide_dolares: false }, ctx)), "pide_dolares en false = el comportamiento de siempre");
  }
  // Y sale sola si es el aeropuerto: la moneda pedida no es motivo de revisión.
  const pe = E.planEnvio({ resultado: r, envioMaestro: true, zonas, canal: "whatsapp", waId: "51966707225", modoAuto: true, perfilConfigurado: true, cuadra: true, pdfOk: true, palabras: [] });
  ok(pe.decision === "automatico", `aeropuerto en dólares a pedido: sale sola (${pe.motivos.join(",")})`);

  // validarEntrada: solo un `true` de verdad.
  for (const [x, esp] of [[true, true], ["true", false], [1, false], [false, false], [undefined, false], [null, false]] as [unknown, boolean][]) {
    const v = validarEntrada({ origen: "a", destino: "b", pide_dolares: x });
    ok(v.ok && (v.entrada.pide_dolares === true) === esp && (esp || !("pide_dolares" in v.entrada)), `validarEntrada pide_dolares=${JSON.stringify(x)} → ${esp}`);
  }
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
  // Solo los mensajes de tipo «location» (como los guarda el webhook) aportan coordenadas: un enlace
  // de mapa PEGADO en un mensaje de texto no es una ubicación compartida.
  const mensajes = [
    { contenido: "Miraflores. Deposite S/ 50 al Yape https://maps.google.com/?q=-12.1211,-77.0297", tipo: "texto" },
    { contenido: enlace, tipo: "location" },
    { contenido: "https://maps.google.com/?q=-12.2,-77.2", tipo: "image" },
    { contenido: "", tipo: "location" },
    { contenido: null, tipo: "location" },
  ];
  const ub = E.textosDeUbicacion(mensajes);
  ok(ub.length === 1 && ub[0] === enlace, `solo las ubicaciones compartidas (${ub.length})`);
  ok(E.textosDeUbicacion(null).length === 0 && E.textosDeUbicacion([]).length === 0, "sin mensajes, ninguna");
  ok(E.coordenadasVerificadas(-12.1211, -77.0297, ub) == null, "el enlace pegado en un TEXTO no vale");
  ok(E.coordenadasVerificadas(-12.1283, -77.0301, ub) != null, "el de la ubicación compartida, sí");
  const e3 = validarEntrada(E.entradaDelAgente({ destino_texto: "Miraflores", destino_lat: -12.1211, destino_lng: -77.0297 }, { canal: "whatsapp", waId: "51966707225" }, ub));
  ok(e3.ok && e3.entrada.destino === "Miraflores", "las coordenadas del enlace pegado no llegan al validador");
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
  // El mismo pedido «ahora en dólares» es OTRA cotización (si no, se le diría «ya te la envié» con la de soles).
  ok(E.firmaPedido(base({ pide_dolares: true })) !== f, "un peruano que pide dólares cambia la firma");
  ok(E.firmaPedido(base({ pide_dolares: true })) === E.firmaPedido(base({ telefono: "13055551234" })), "y es la del mismo pedido en dólares");
  ok(E.firmaPedido(base({ pide_dolares: false })) === f, "sin pedido de dólares, la firma de siempre");
  ok(E.firmaPedido(base({ telefono: "13055551234", pide_dolares: true })) === E.firmaPedido(base({ telefono: "13055551234" })), "un extranjero que pide dólares: la misma firma");
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
  ok(Object.keys(E.MOTIVO_REVISION).length === 9 && Object.values(E.MOTIVO_REVISION).every((m) => m.texto && m.arreglo), "nueve motivos, cada uno con su arreglo");
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
        // El modo de preguntar del agente: «todo_junto» es la instrucción de siempre, byte a byte; con
        // «una_por_mensaje» cambia SOLO la instrucción de preguntar, y la lista blanca no se afloja.
        ok(E.respuestaParaModelo({ resultado: r, cotizacion: cot, preguntas: "todo_junto" }) === json, "todo junto = sin el parámetro, byte a byte");
        const j1 = E.respuestaParaModelo({ resultado: r, cotizacion: cot, preguntas: "una_por_mensaje" });
        if (r.accion !== "preguntar") ok(j1 === json, "uno por mensaje no cambia lo que no es preguntar");
        else {
          const o3 = JSON.parse(j1);
          ok(Object.keys(o3).every((k) => (E.CLAVES_RESPUESTA_MODELO as readonly string[]).includes(k)) && !prohibido.test(j1) && !E.textoContradicePrecio(j1, []), "uno por mensaje: misma lista blanca, sin importes");
          ok(JSON.stringify(o3.faltan) === JSON.stringify(o2.faltan), "uno por mensaje: la lista de lo que falta es la misma");
          ok(o3.instruccion.startsWith(`Pregúntale al cliente SOLO por: ${o2.faltan[0]}.`) && !/en un solo mensaje|todo junto|todos juntos/i.test(o3.instruccion), `uno por mensaje: solo el primero (${o3.instruccion})`);
          ok(o2.faltan.slice(1).every((x: string) => o3.instruccion.includes(x)) === true && (o2.faltan.length > 1) === o3.instruccion.includes("de a uno"), "uno por mensaje: los demás se nombran para después");
        }
      }
    }
  console.log(`  barrido: ${n} respuestas`);
  // Literales, para que el texto no derive en silencio.
  const rP = M.evaluarTraslado(pedido({ origen: AEROP, destino: MIRA, pax: null, maletas: null, sentido: "ida" }), ctx);
  ok(rP.accion === "preguntar" && rP.faltan.length === 2, `caso literal con dos datos (${rP.faltan})`);
  ok(JSON.parse(E.respuestaParaModelo({ resultado: rP })).instruccion === `Pregúntale al cliente, en un solo mensaje: ${rP.faltan.join("; ")}. Cuando responda, vuelve a llamar a cotizar_traslado con TODOS los datos.`, "sin el parámetro: la instrucción de siempre");
  ok(JSON.parse(E.respuestaParaModelo({ resultado: rP, preguntas: "una_por_mensaje" })).instruccion === `Pregúntale al cliente SOLO por: ${rP.faltan[0]}. Lo demás que falta (${rP.faltan[1]}) se lo preguntas después, de a uno. Cuando responda, vuelve a llamar a cotizar_traslado con TODOS los datos que ya tienes.`, "uno por mensaje: la instrucción literal");
  ok(E.respuestaPreguntar(["la hora de recojo"]) === JSON.stringify({ accion: "preguntar", codigo: "falta_dato", faltan: ["la hora de recojo"], instruccion: "Pregúntale al cliente, en un solo mensaje: la hora de recojo. Cuando responda, vuelve a llamar a cotizar_traslado con TODOS los datos." }), "respuestaPreguntar sin el parámetro: la de siempre, byte a byte");
  ok(E.respuestaPreguntar(["a", "b"], "todo_junto") === E.respuestaPreguntar(["a", "b"]), "respuestaPreguntar todo junto = sin el parámetro");
  ok(JSON.parse(E.respuestaPreguntar(["la hora de recojo"], "una_por_mensaje")).instruccion === "Pregúntale al cliente SOLO por: la hora de recojo. Cuando responda, vuelve a llamar a cotizar_traslado con TODOS los datos que ya tienes.", "respuestaPreguntar uno por mensaje, con un solo dato");
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
  ok(fila.origen === "Aeropuerto Jorge Chávez" && fila.destino === "Miraflores (Hotel Belmond, Miraflores)", `el aeropuerto con el nombre de su zona; el hotel con su ZONA y lo que dijo el cliente como referencia (${fila.destino})`);
  ok(fila.moneda === "USD" && fila.tipo_cambio === 3.431 && fila.idioma_pdf === "es" && fila.tipo_vehiculo === "SPRINTER_20", "moneda, TC, idioma y ficha de costeo");
  ok(fila.hora_retorno === "18:00" && fila.fecha_retorno === "2026-10-28" && fila.hora_ida === "06:30", "fechas y horas con los nombres de columna reales");
  ok(fila.consideraciones_json.generales.length === 4 && fila.consideraciones_json.incluye.length === 0, "consideraciones: las generales + la de dólares");
  ok(fila.atencion === "Ana Pérez" && fila.cliente_id === 7 && fila.crm_conversacion_id === "conv-1" && fila.numero_cotizacion === null, "atención, cliente, conversación y número null");
  const tjTxt = JSON.stringify(fila.traslado_json);
  ok(!/precio|total|subtotal|igv|importe/i.test(tjTxt) && !tjTxt.includes(String(r.precio!.precio_tramo * 2)), "traslado_json no lleva importes");
  ok(fila.traslado_json.pax === 10 && fila.traslado_json.maletas === 10 && fila.traslado_json.categoria.clave === "SPRINTER_20" && fila.traslado_json.tramos === 2 && fila.traslado_json.tc_fecha === HOY, "traslado_json con los hechos");
  // resultadoDeFila: el resultado reconstruido de una fila guardada (para volver a decidir el envío sin Google).
  const leidaUsd = { ...fila, id: 1 };
  const rr = C.resultadoDeFila(leidaUsd, { zonas, categorias, tarifas }, 18);
  ok(!!rr && C.cuadraConMotor(leidaUsd, rr) && rr.precio!.total === r.precio!.total && rr.origen?.zona?.id === r.origen?.zona?.id, "resultadoDeFila reproduce al motor y cuadra");
  const tarifasCaras = tarifas.map((t) => ({ ...t, precio_tramo: t.precio_tramo + 1 }));
  ok(!C.cuadraConMotor(leidaUsd, C.resultadoDeFila(leidaUsd, { zonas, categorias, tarifas: tarifasCaras }, 18)!), "si la tarifa cambió, la fila guardada ya no cuadra");
  ok(C.resultadoDeFila(leidaUsd, { zonas: zonas.map((x) => x.id === AER.id ? { ...x, activo: false } : x), categorias, tarifas }, 18) === null, "con la zona apagada no se reconstruye");
  ok(C.resultadoDeFila({ ...leidaUsd, tipo_cambio: null }, { zonas, categorias, tarifas }, 18) === null, "en dólares sin TC no se reconstruye");
  ok(C.resultadoDeFila({ ...leidaUsd, traslado_json: null }, { zonas, categorias, tarifas }, 18) === null, "sin traslado_json no se reconstruye");
  const cif = C.cifrasDeFila(leidaUsd)!;
  ok(cif.total === `US$ ${r.precio!.total.toFixed(2)}` && cif.figuras.includes(r.precio!.total) && cif.validez === "25/10/2026", `cifrasDeFila: ${cif.total} · ${cif.validez}`);
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
  const auto = E.mensajeCotizacionCodigo({ nombre: "Ana Pérez", numero: "00123", decision: "automatico", total: "S/ 118.00", validez: "18/11/2026", estilo: TU });
  ok(auto.includes("00123") && auto.includes("S/ 118.00") && auto.includes("18/11/2026") && auto.startsWith("Hola Ana,") && !E.textoContradicePrecio(auto, [118]), `mensaje automático: ${auto}`);
  ok(/ejecutivo/.test(auto), "y dice que la disponibilidad la confirma un ejecutivo");
  const rev = E.mensajeCotizacionCodigo({ nombre: "", numero: "00124", decision: "revision", total: "S/ 118.00", estilo: TU });
  ok(rev.includes("00124") && !E.textoContradicePrecio(rev, []) && rev.startsWith("Hola,"), `mensaje en revisión sin importes: ${rev}`);
}

// ── 10b. Los textos del código, con el trato y el modo de preguntar del agente ───
seccion("10b. mensajeCotizacionCodigo y fraseFaltanTraslado leen el estilo del agente");
{
  const L = "La disponibilidad de la unidad y la reserva del servicio las confirma un ejecutivo.";
  const base = { nombre: "Ana Pérez", numero: "00123", total: "S/ 118.00", validez: "18/11/2026" };
  // Con «tu», byte a byte lo de antes de existir el ajuste (copiado literal de la versión anterior).
  const LIT_TU = {
    auto: `Hola Ana, te envío la cotización N° 00123 de tu traslado. El total es S/ 118.00 (IGV incluido), válida hasta el 18/11/2026. ${L}`,
    ya: `Hola Ana, la cotización N° 00123 de tu traslado ya te la envié por este chat. El total es S/ 118.00 (IGV incluido), válida hasta el 18/11/2026. ${L}`,
    rev: "Hola Ana, registré tu pedido de traslado con la cotización N° 00123. Un ejecutivo la revisa y te la envía por este chat en breve.",
  };
  const LIT_USTED = {
    auto: `Hola Ana, le envío la cotización N° 00123 de su traslado. El total es S/ 118.00 (IGV incluido), válida hasta el 18/11/2026. ${L}`,
    ya: `Hola Ana, la cotización N° 00123 de su traslado ya se la envié por este chat. El total es S/ 118.00 (IGV incluido), válida hasta el 18/11/2026. ${L}`,
    rev: "Hola Ana, registré su pedido de traslado con la cotización N° 00123. Un ejecutivo la revisa y se la envía por este chat en breve.",
  };
  for (const e of ESTILOS) {
    const lit = e.tratamiento === "tu" ? LIT_TU : LIT_USTED;
    const auto = E.mensajeCotizacionCodigo({ ...base, decision: "automatico", estilo: e });
    const ya = E.mensajeCotizacionCodigo({ ...base, decision: "automatico", yaEnviada: true, estilo: e });
    const rev = E.mensajeCotizacionCodigo({ ...base, decision: "revision", estilo: e });
    ok(auto === lit.auto && ya === lit.ya && rev === lit.rev, `${nombreEstilo(e)}: los tres mensajes literales (${auto} | ${ya} | ${rev})`);
    // El modo de preguntar no cambia el mensaje de una cotización: no pregunta nada.
    for (const m of [auto, ya, rev]) {
      ok(e.tratamiento === "tu" ? !USTEDEA.test(m) : !TUTEA.test(m), `${nombreEstilo(e)}: un solo trato en «${m.slice(0, 60)}…»`);
      ok(T.importesEnTexto(m).every((x) => Math.abs(x - 118) < 0.005), `${nombreEstilo(e)}: solo el total de la cotización`);
    }
  }
  // Sin total ni validez, y sin nombre: el resto de la frase no cambia con el trato.
  ok(E.mensajeCotizacionCodigo({ nombre: "", numero: "9", decision: "automatico", estilo: { tratamiento: "usted", preguntas: "todo_junto" } }) === `Hola, le envío la cotización N° 9 de su traslado. ${L}`, "usted sin cifras");
  ok(E.mensajeCotizacionCodigo({ nombre: "", numero: "9", decision: "automatico", validez: "1/1/2027", estilo: TU }) === `Hola, te envío la cotización N° 9 de tu traslado. La cotización es válida hasta el 1/1/2027. ${L}`, "tú solo con validez");
  // Un llamador en JS sin estilo: el defecto del ajuste (usted), nunca un texto roto.
  ok((E.mensajeCotizacionCodigo as any)({ nombre: "Ana", numero: "1", decision: "revision" }).includes("registré su pedido"), "sin estilo → de usted (el defecto)");

  // «Me falta»: todo junto = la lista entera; uno por mensaje = SOLO el primero, en el orden del motor.
  const f = ["la cantidad de maletas de 23 kg", "la hora de recojo"];
  ok(E.fraseFaltanTraslado(f, TU) === "Para cotizar tu traslado me falta: la cantidad de maletas de 23 kg; la hora de recojo.", "tú + todo junto: el texto de siempre, byte a byte");
  ok(E.fraseFaltanTraslado(f, { tratamiento: "tu", preguntas: "una_por_mensaje" }) === "Para cotizar tu traslado, ¿me indicas la cantidad de maletas de 23 kg?", "tú + uno por mensaje");
  ok(E.fraseFaltanTraslado(f, { tratamiento: "usted", preguntas: "todo_junto" }) === "Para cotizar su traslado me falta: la cantidad de maletas de 23 kg; la hora de recojo.", "usted + todo junto");
  ok(E.fraseFaltanTraslado(f, { tratamiento: "usted", preguntas: "una_por_mensaje" }) === "Para cotizar su traslado, ¿me indica la cantidad de maletas de 23 kg?", "usted + uno por mensaje");
  for (const e of ESTILOS) {
    ok(E.fraseFaltanTraslado([], e) === "" && E.fraseFaltanTraslado(["", "  "], e) === "" && E.fraseFaltanTraslado(null, e) === "", `${nombreEstilo(e)}: sin datos que pedir, nada`);
    const una = E.fraseFaltanTraslado(f, e);
    if (e.preguntas === "una_por_mensaje") ok(!una.includes("la hora de recojo") && (una.match(/\?/g) ?? []).length === 1, `${nombreEstilo(e)}: una sola pregunta`);
    else ok(f.every((x) => una.includes(x)), `${nombreEstilo(e)}: todos los datos`);
    ok(e.tratamiento === "tu" ? !USTEDEA.test(una) : !TUTEA.test(una), `${nombreEstilo(e)}: un solo trato («${una}»)`);
    ok(!T.mencionaDinero(una), `${nombreEstilo(e)}: no menciona dinero`);
  }
  // Con un solo dato, los dos modos piden lo mismo (uno solo); cambia solo la forma.
  ok(E.fraseFaltanTraslado(["la fecha del servicio"], { tratamiento: "usted", preguntas: "una_por_mensaje" }) === "Para cotizar su traslado, ¿me indica la fecha del servicio?", "un solo dato, uno por mensaje");
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
const destinoHostil = "Hotel 😀 <script>alert('x')</script> → Miraflores ↔ ✈️ " + "Ñ".repeat(400);
const eHostil = { ...entradaDe(pHostil), destino: destinoHostil };
const filaH = C.filaCotizacionTraslado(rHostil, eHostil, { convId: "c", clienteId: null, atencion: "Peña 👍 <b>", config, firma: "f", hoy: HOY });
ok(filaH.destino === "Miraflores" && filaH.atencion === "Peña 👍 <b>", `lo hostil y largo del cliente no se imprime: queda la zona (${filaH.destino.slice(0, 40)})`);
// Para probar el DIBUJO con contenido hostil se pone a mano en la fila (como si lo escribiera un
// ejecutivo en /cotizaciones): el PDF se deriva de la fila.
const leidaH: C.FilaCotizacionLeida = {
  ...filaH, destino: destinoHostil, id: 123, created_at: "2026-10-20T03:00:00Z",
  items_json: [{ ...filaH.items_json[0], descripcion: "x".repeat(5000) + " 🚐" }],
  consideraciones_json: { generales: [...filaH.consideraciones_json.generales, ...Array.from({ length: 90 }, (_, i) => `Consideración ${i + 1}\tcon\nsaltos 😀 y señal ñ`)], incluye: [], no_incluye: [] },
};
// El PDF es la plantilla corporativa: la entrada se arma desde la fila y `docCorporativo` decide
// qué se imprime (lo mismo que /cotizaciones).
const perfilPrueba = { nombre: "Transportes Ñandú", razon_social: "Transportes Ñandú S.A.C.", ruc: "20123456789", telefono: "+51 999 888 777", web: "www.ejemplo.pe", email: "ventas@ejemplo.pe", direccion: "Av. Peñaloza 123, Lima" };
const entH = (x: Partial<Parameters<typeof C.entradaCorporativaTraslado>[1]> = {}, f: C.FilaCotizacionLeida = leidaH) =>
  C.entradaCorporativaTraslado(f, { empresa: perfilPrueba, celular: "51966707225", ...x });
const contH = docCorporativo(entH());
ok(contH.titulo === "COTIZACIÓN N° 00123 - 2026" && contH.subtitulo.startsWith("Fecha: 19/10/2026"), `número con ceros y fecha de Lima (${contH.titulo} · ${contH.subtitulo})`);
ok(contH.color === "#0b315f", "el color es el de la plantilla corporativa");
ok(docCorporativo(entH({ ejemplo: true })).titulo.includes("N° EJEMPLO"), "con «ejemplo» el número dice EJEMPLO");
ok(contH.notaTotales === "La disponibilidad de la unidad y la reserva del servicio las confirma un ejecutivo.", "la línea fija");
ok(contH.logoUrl === null, "sin logo en el perfil: sin logo");
ok(docCorporativo(entH({ empresa: { nombre: "X", logo_url: "https://x/logo.png" } })).logoUrl === "https://x/logo.png", "el logo es el del perfil");
ok(!JSON.stringify(contH).includes(LOGO_DEFAULT), "nunca el logo del bundle");
const totTxt = [...contH.totales.filas, contH.totales.total].map((t) => `${t.rotulo} ${t.valor}`).join(" | ");
ok(totTxt === `SUBTOTAL S/ 700.00 | IGV (18%) S/ 126.00 | TOTAL NETO S/ 826.00`, `totales con las funciones de /cotizaciones: ${totTxt}`);
ok(contH.tabla.filas[0].cantidad === "2" && contH.tabla.filas[0].punit === "S/ 350.00", "2 tramos × S/ 350.00");
ok(contH.detalle.asunto === null, "el asunto (texto interno) no se imprime");
const usdR = M.evaluarTraslado(pedido({ telefono: "+13055551234" }), ctx);
const usdF = C.filaCotizacionTraslado(usdR, entradaDe(pedido({ telefono: "+13055551234" })), { convId: "c", clienteId: null, atencion: null, config, firma: "f", hoy: HOY });
const usdC = docCorporativo(entH({}, { ...usdF, id: 9 }));
ok(usdC.totales.total.valor === `US$ ${usdR.precio!.total.toFixed(2)}`, `en dólares, el total del motor (${usdC.totales.total.valor})`);
let lanzaSinTc = false; try { docCorporativo(entH({}, { ...usdF, id: 9, tipo_cambio: null })); } catch { lanzaSinTc = true; }
ok(lanzaSinTc, "en dólares sin tipo de cambio no hay PDF");
ok(C.perfilConfigurado({ nombre: "X" }) && C.perfilConfigurado({ razon_social: "Y" }) && !C.perfilConfigurado(null) && !C.perfilConfigurado({ nombre: "  " }), "perfilConfigurado = el perfil tiene nombre");
ok(docCorporativo(entH({ empresa: null })).empresaNombre === empresaConDefectos(null).nombre, "sin perfil, la empresa es el aviso «configura el perfil»");
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
  try { bytes = await dibujarPdfCorporativo(contH, { logo: { bytes: new Uint8Array(logoPng), tipo: "png" } }); } catch (e) { err = (e as Error).message; }
  ok(!!bytes, `el PDF hostil se dibuja sin lanzar ${err}`);
  if (bytes) {
    ok(Buffer.from(bytes.slice(0, 5)).toString("latin1") === "%PDF-", "empieza por %PDF-");
    const txt = textoDelPdf(bytes);
    ok(txt.includes("TRANSPORTES ÑANDÚ") && txt.includes("Peñaloza") && txt.includes("ATENCIÓN:") && txt.includes("señal ñ"), "tildes y ñ se ven en el texto del PDF");
    ok(txt.includes("COTIZACIÓN N° 00123 - 2026") && txt.includes("S/ 826.00"), "título, número y total");
    ok(txt.includes("La disponibilidad de la unidad y la reserva del servicio las confirma un ejecutivo."), "la línea fija se imprime");
    ok(!/\bAFA\b/.test(txt) && !txt.includes(LOGO_DEFAULT), "sin «AFA» ni el logo del bundle");
    ok(txt.includes("<script>"), "el <script> del cliente es texto plano (un PDF no ejecuta HTML)");
    const doc = await PDFDocument.load(bytes);
    ok(doc.getPageCount() >= 3, `noventa consideraciones parten la hoja 2 (páginas: ${doc.getPageCount()})`);
  }
  // Sin logo, con un logo corrupto y con el perfil vacío: tampoco lanza.
  for (const [n, logo, emp] of [["sin logo", null, perfilPrueba], ["logo corrupto", { bytes: new Uint8Array([1, 2, 3]), tipo: "png" as const }, perfilPrueba], ["perfil vacío", null, null]] as const) {
    let l = false; try { await dibujarPdfCorporativo(docCorporativo(entH({ empresa: emp })), { logo }); } catch { l = true; }
    ok(!l, `${n}: no lanza`);
  }
  // Los módulos no traen ningún dato de una empresa concreta.
  for (const archivo of ["lib/traslados/cotizacion-traslado.ts", "lib/pdf-corporativo.ts", "lib/cotizacion-corporativo.ts", "lib/traslados/envio-ia.ts", "lib/traslados/enviar-cotizacion-datos.ts"]) {
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
    const cM = docCorporativo(entH({}, { ...fM, id: 1234, created_at: "2026-10-19T15:00:00Z" }));
    writeFileSync(muestraDir, await dibujarPdfCorporativo(cM, { logo: { bytes: new Uint8Array(logoPng), tipo: "png" } }));
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

// ── 17. De punta a punta, con una base falsa ─────────────────────────────────
// cotizarTrasladoIA y enviarCotizacionTraslado sobre una base en memoria que imita a PostgREST (los
// filtros que usan, el conteo, los errores de columna que faltan y el índice único del freno), sin
// Google ni Meta: el motor se llama con las semillas de los SQL y el envío de WhatsApp se graba.
seccion("17. De punta a punta: cotizar, reclamar, enviar, reintentar");
type FilaF = Record<string, any>;
class SbFalso {
  tablas: Record<string, FilaF[]> = {};
  faltan: Record<string, string[]> = {};
  fallas: { tabla: string; op: string; mensaje: string }[] = [];
  archivos = new Map<string, Uint8Array>();
  firmaFalla = false;
  n = 0;
  constructor(public reloj: () => number) {}
  t(nombre: string) { return (this.tablas[nombre] ??= []); }
  from(tabla: string) { return new ConsultaF(this, tabla); }
  storage = {
    createBucket: async () => ({ error: null }),
    from: (bucket: string) => ({
      upload: async (ruta: string, b: Uint8Array) => { this.archivos.set(`${bucket}/${ruta}`, b); return { error: null }; },
      createSignedUrl: async (ruta: string) => this.firmaFalla || !this.archivos.has(`${bucket}/${ruta}`)
        ? { data: null, error: { message: "no se pudo firmar" } }
        : { data: { signedUrl: `https://sb.test/storage/v1/object/sign/${bucket}/${ruta}?token=x` }, error: null },
      getPublicUrl: (ruta: string) => ({ data: { publicUrl: `https://sb.test/storage/v1/object/public/${bucket}/${ruta}` } }),
    }),
  };
}
class ConsultaF implements PromiseLike<any> {
  op: "select" | "insert" | "update" = "select";
  cols = "*"; head = false; contar = false; ret = false;
  filtros: ((f: FilaF) => boolean)[] = [];
  orden: { c: string; asc: boolean } | null = null;
  desde = 0; hasta = Infinity; uno: "single" | "maybe" | null = null; payload: any = null;
  constructor(private sb: SbFalso, private tabla: string) {}
  select(cols = "*", o?: { count?: string; head?: boolean }) {
    if (this.op === "select") { this.cols = cols; this.contar = !!o?.count; this.head = !!o?.head; } else this.ret = true;
    return this;
  }
  insert(v: any) { this.op = "insert"; this.payload = v; return this; }
  update(v: any) { this.op = "update"; this.payload = v; return this; }
  eq(c: string, v: any) { this.filtros.push((f) => v != null && f[c] != null && String(f[c]) === String(v)); return this; }
  gte(c: string, v: any) { this.filtros.push((f) => f[c] != null && f[c] >= v); return this; }
  lt(c: string, v: any) { this.filtros.push((f) => f[c] != null && f[c] < v); return this; }
  like(c: string, pat: string) { const re = new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`); this.filtros.push((f) => re.test(String(f[c] ?? ""))); return this; }
  in(c: string, vs: any[]) { this.filtros.push((f) => vs.map(String).includes(String(f[c]))); return this; }
  is(c: string, v: null) { this.filtros.push((f) => (v === null ? f[c] == null : f[c] === v)); return this; }
  not(c: string, op: string, v: null) { if (op === "is" && v === null) this.filtros.push((f) => f[c] != null); return this; }
  order(c: string, o?: { ascending?: boolean }) { this.orden = { c, asc: o?.ascending !== false }; return this; }
  range(a: number, b: number) { this.desde = a; this.hasta = b; return this; }
  limit(n: number) { this.hasta = this.desde + n - 1; return this; }
  single() { this.uno = "single"; return this; }
  maybeSingle() { this.uno = "maybe"; return this; }
  then<A, B>(ok?: ((v: any) => A | PromiseLike<A>) | null, mal?: ((e: any) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve().then(() => this.ejecutar()).then(ok, mal);
  }
  private ejecutar(): any {
    const sb = this.sb, tabla = this.tabla, filas = sb.t(tabla);
    const falla = sb.fallas.find((x) => x.tabla === tabla && x.op === this.op);
    if (falla) return { data: null, count: null, error: { message: falla.mensaje } };
    const faltan = sb.faltan[tabla] ?? [];
    const colsPedidas = this.cols.replace(/\w+\([^)]*\)/g, "").split(",").map((x) => x.trim()).filter((x) => x && x !== "*");
    const malCol = this.op === "select" ? colsPedidas.find((c) => faltan.includes(c)) : Object.keys(this.payload ?? {}).find((c) => faltan.includes(c));
    if (malCol) return this.op === "select"
      ? { data: null, error: { code: "42703", message: `column ${tabla}.${malCol} does not exist` } }
      : { data: null, error: { code: "PGRST204", message: `Could not find the '${malCol}' column of '${tabla}' in the schema cache` } };
    const ahora = new Date(sb.reloj()).toISOString();
    if (this.op === "insert") {
      const fila: FilaF = { ...this.payload };
      fila.id ??= tabla === "cotizaciones" ? 100 + ++sb.n : `00000000-0000-4000-8000-${String(++sb.n).padStart(12, "0")}`;
      if (tabla === "crm_acciones_ia") fila.creada_at ??= ahora; else fila.created_at ??= ahora;
      if (tabla === "alerta_enviada" && filas.some((x) => x.clave === fila.clave && x.ref === fila.ref && x.fecha === fila.fecha))
        return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
      filas.push(fila);
      return this.resultado([fila]);
    }
    let sel = filas.filter((f) => this.filtros.every((p) => p(f)));
    if (this.op === "update") {
      for (const f of sel) Object.assign(f, this.payload);
      return this.ret ? this.resultado(sel) : { data: null, error: null };
    }
    if (this.orden) { const { c, asc } = this.orden; sel = [...sel].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1)); }
    if (this.contar && this.head) return { data: null, count: sel.length, error: null };
    sel = sel.slice(this.desde, this.hasta === Infinity ? undefined : this.hasta + 1);
    return this.resultado(sel);
  }
  private resultado(sel: FilaF[]): any {
    const emb = this.cols.match(/(\w+)\(([^)]*)\)/);
    const conEmb = sel.map((f) => {
      const o = { ...f };
      if (emb && emb[1] === "crm_contactos") o.crm_contactos = this.sb.t("crm_contactos").find((x) => x.id === f.contacto_id) ?? null;
      return o;
    });
    if (this.uno === "single") return conEmb.length === 1 ? { data: conEmb[0], error: null } : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } };
    if (this.uno === "maybe") return { data: conEmb[0] ?? null, error: null };
    return { data: conEmb, error: null };
  }
}

const RELOJ = Date.parse("2026-10-19T15:00:00Z");
const reloj = RELOJ;
const nuevaBase = () => {
  const sb = new SbFalso(() => reloj);
  sb.tablas.traslados_config = [{ id: 1, validez_dias: 30, espera_gratis_min: 30, consideraciones: config.consideraciones, consideraciones_usd: config.consideraciones_usd, ia_cotiza: true, envio_automatico: true }];
  sb.tablas.zonas_traslado = zonas.map((x) => ({ ...x }));
  sb.tablas.traslado_categorias = categorias.map((x) => ({ ...x }));
  sb.tablas.tarifas_traslado = tarifas.map((x, i) => ({ ...x, id: i + 1 }));
  sb.tablas.config_tributaria = [{ id: 1, igv_pct: 18 }];
  sb.tablas.empresa_perfil = [{ id: 1, nombre: "Transportes Ñandú", razon_social: "Transportes Ñandú S.A.C.", ruc: "20123456789", telefono: "+51 999 888 777", web: "www.ejemplo.pe", logo_url: null, color_primario: "#0b5394" }];
  sb.tablas.clientes = [{ id: 7, telefono: "966 707 225" }, { id: 8, telefono: "+51 955 000 111" }];
  sb.tablas.crm_contactos = [
    { id: "ct-1", nombre: "Ana Pérez", wa_id: "51966707225", telefono: "999111222", cliente_id: null },
    { id: "ct-2", nombre: "Luis", wa_id: "51955000111", telefono: null, cliente_id: null },
    { id: "ct-3", nombre: "Sin wa", wa_id: null, telefono: "988777666", cliente_id: null },
  ];
  sb.tablas.crm_conversaciones = [
    { id: "cv-1", canal: "whatsapp", phone_number_id: "PH-CRM", contacto_id: "ct-1" },
    { id: "cv-2", canal: "whatsapp", phone_number_id: null, contacto_id: "ct-2" },
    { id: "cv-3", canal: "whatsapp", phone_number_id: null, contacto_id: "ct-3" },
  ];
  sb.tablas.crm_mensajes = [
    { id: "m1", conversacion_id: "cv-1", direccion: "entrante", contenido: "Hola, necesito un traslado del aeropuerto a mi hotel en Miraflores", created_at: "2026-10-19T14:50:00Z" },
    { id: "m2", conversacion_id: "cv-2", direccion: "entrante", contenido: "precio de traslado al aeropuerto", created_at: "2026-10-19T14:50:00Z" },
  ];
  return sb;
};
const PUNTO_DE: Record<string, M.PuntoUbicado> = {
  "aeropuerto jorge chavez": AEROP, "hotel belmond miraflores": MIRA, "san isidro": SI, "barranco": BARR,
};
// La última entrada que llegó al motor (para comprobar si las coordenadas pasaron o no).
const entradasMotor: EntradaSimulador[] = [];
const simularFalso = (consultas: { n: number }) => async (_sb: unknown, e: EntradaSimulador, hoy: string) => {
  consultas.n++;
  entradasMotor.push(e);
  // Como Google: un pin junto al aeropuerto cae en su geocerca; cualquier otro pin, o un texto que
  // empieza por «Miraflores», cae en Miraflores.
  const punto = (l: EntradaSimulador["origen"]): M.PuntoUbicado => {
    if (typeof l !== "string") {
      return Math.abs(l.lat - AER.lat!) < 0.01 && Math.abs(l.lng - AER.lng!) < 0.01
        ? { ...AEROP, lat: l.lat, lng: l.lng, texto: l.texto ?? "" }
        : { ...MIRA, lat: l.lat, lng: l.lng, texto: l.texto ?? "" };
    }
    return PUNTO_DE[M.claveNombre(l)] ?? (/^miraflores\b/i.test(l.trim()) ? { ...MIRA, texto: l } : pt([], { texto: String(l) }));
  };
  const cat: CatalogoTraslados = { zonas, categorias, tarifas, config: { ...config, ia_cotiza: true, envio_automatico: true }, sinMigracionIA: false };
  const resultado = M.evaluarTraslado({
    origen: punto(e.origen), destino: punto(e.destino), fecha_servicio: e.fecha_servicio, hora_servicio: e.hora_servicio, sentido: e.sentido,
    fecha_retorno: e.fecha_retorno, hora_retorno: e.hora_retorno, pax: e.pax, maletas: e.maletas, telefono: e.telefono, pide_dolares: e.pide_dolares,
    paradas_intermedias: e.paradas_intermedias, fechas_adicionales: e.fechas_adicionales, vehiculos_pedidos: e.vehiculos_pedidos, senales: e.senales,
  }, { zonas, categorias, tarifas, tipoCambio: { fecha: hoy, venta: 3.431 }, hoy, igvPct: 18, validezDias: 30 });
  return { respuesta: { ok: true as const, resultado, lugares: {} as any }, catalogo: cat, igvPct: 18 };
};
type Envio = { to: string; tipo: string; url: string; caption?: string; opts: any };
const envios: Envio[] = [];
let metaFalla: string | null = null;
const depsEnvio: DepsEnvio = {
  enviarMedia: (async (to: string, tipo: any, url: string, caption?: string, opts?: any) => {
    if (metaFalla) throw new Error(metaFalla);
    envios.push({ to, tipo, url, caption, opts }); return `wamid.${envios.length}`;
  }) as any,
  phonePara: async () => "PH-DEFECTO", asegurarBucket: async () => {}, bajarLogo: async () => null, ahoraMs: () => reloj,
  uuid: () => `123e4567-e89b-42d3-a456-${String(envios.length + Math.floor(Math.random() * 1e6)).padStart(12, "0")}`,
};
const pedidoIA = { origen_texto: "Aeropuerto Jorge Chávez", destino_texto: "Hotel Belmond Miraflores", fecha_servicio: "2026-10-25", hora_servicio: "06:30", sentido: "ida", pax: 2, maletas: 1, telefono: "+13055551234" };
const ctxDe = (sb: SbFalso, convId: string, contactoId: string, modoAuto = true, canal = "whatsapp"): CtxCotizarIA => {
  const ct = sb.t("crm_contactos").find((x) => x.id === contactoId)!;
  return { sb, conv: { id: convId, canal }, contacto: ct, remitente: { canal, waId: ct.wa_id }, modoAuto, consultasTurno: { n: 0 } };
};
{
  const sb = nuevaBase();
  const consultasMotor = { n: 0 };
  const deps = { simular: simularFalso(consultasMotor) as any, bajarLogo: async () => null, ahoraMs: () => reloj, azar: () => String(Math.random()).slice(2, 8) };

  // A) Automático: aeropuerto → Miraflores, peruano, todo encendido.
  const ctxA = ctxDe(sb, "cv-1", "ct-1");
  const a = await cotizarTrasladoIA(ctxA, pedidoIA, deps);
  ok(a.accion === "cotizar" && a.cotizacion?.decision === "automatico" && !!a.envioPendiente, `A: cotiza y sale solo (${a.cotizacion?.decision} ${JSON.stringify(a.derivar ?? "")})`);
  ok(!!a.envioPendiente && Buffer.from(a.envioPendiente.bytes.slice(0, 5)).toString("latin1") === "%PDF-", "A: el PDF está armado");
  const cot = sb.t("cotizaciones")[0];
  ok(sb.t("cotizaciones").length === 1 && cot.crm_conversacion_id === "cv-1" && cot.traslado_json?.firma && cot.moneda === "PEN" && cot.precio_cliente === 118, `A: una cotización en soles, de la conversación (${cot?.precio_cliente})`);
  ok(cot.cliente_id === 7, `A: el cliente sale del wa_id, no del teléfono del contacto (${cot.cliente_id})`);
  const acc = sb.t("crm_acciones_ia")[0];
  ok(sb.t("crm_acciones_ia").length === 1 && acc.tipo === "cotizacion_traslado" && acc.estado === "pendiente" && acc.resultado_id === cot.id && acc.payload.decision === "automatico", "A: la acción nace pendiente, apunta a la cotización");
  ok(!/S\/|US\$|\d+\.\d\d/.test(acc.resumen), `A: el resumen de la tarjeta no lleva importes (${acc.resumen})`);
  ok(sb.t("alerta_enviada").length === 1 && sb.t("alerta_enviada")[0].clave === CLAVE_CONSULTA_IA && sb.t("alerta_enviada")[0].ref.startsWith("conv:cv-1:"), "A: la consulta queda contada");
  ok(ctxA.consultasTurno.n === 1 && consultasMotor.n === 1, "A: una consulta en el turno");
  const jA = JSON.parse(a.respuestaModelo);
  ok(jA.cotizacion?.envio === "automatico" && jA.cotizacion?.total === "S/ 118.00", `A: el modelo recibe el total (${a.respuestaModelo.slice(0, 120)})`);
  ok(a.cotizacion!.figuras.includes(118), "A: el total es una cifra permitida");

  // B) El envío: al wa_id del hilo, con URL firmada, por el número del hilo.
  const b = await enviarCotizacionTraslado(sb as any, { accionId: acc.id, por: "automatico", bytes: a.envioPendiente!.bytes, nombre: a.envioPendiente!.nombre, caption: a.envioPendiente!.caption }, depsEnvio);
  ok(b.ok && b.codigo === "ok" && b.metaId === "wamid.1", `B: enviada (${b.codigo} ${b.detalle})`);
  ok(envios.length === 1 && envios[0].to === "51966707225" && envios[0].tipo === "document" && envios[0].opts.phoneId === "PH-CRM", `B: al wa_id ${envios[0]?.to}, nunca al teléfono del contacto, por el número del hilo`);
  ok(envios[0].url.includes("/object/sign/crm-media/cotizaciones-ia/2026-10/"), `B: URL firmada del bucket privado (${envios[0].url})`);
  ok(envios[0].opts.filename === a.envioPendiente!.nombre && /^[\x20-\x7e]+$/.test(envios[0].opts.filename), "B: el archivo con nombre ASCII");
  const msg = sb.t("crm_mensajes").find((x) => x.tipo === "document")!;
  ok(!!msg && msg.generado_por_ia === true && msg.meta_message_id === "wamid.1" && msg.error == null && msg.media_url.includes("/object/public/crm-media/"), "B: el mensaje queda en el hilo, como de la IA");
  ok(cot.estado === "enviado" && cot.medio_envio === "WhatsApp", "B: la cotización pasa a «enviado» por WhatsApp");
  ok(acc.estado === "aprobada" && acc.payload.envio?.por === "automatico" && acc.payload.envio?.meta_message_id === "wamid.1" && acc.resuelta_por == null, "B: la acción aprobada con quién envió");

  // C) No se envía dos veces.
  const c = await enviarCotizacionTraslado(sb as any, { accionId: acc.id, por: "ejecutivo", usuarioId: "u-1" }, depsEnvio);
  ok(!c.ok && c.codigo === "no_pendiente" && envios.length === 1, `C: la segunda vez no sale (${c.codigo})`);

  // D) El mismo pedido otra vez, ya enviado: «ya te la envié», sin otra cotización ni otra consulta.
  const ctxD = ctxDe(sb, "cv-1", "ct-1");
  const d = await cotizarTrasladoIA(ctxD, { ...pedidoIA, origen_texto: "AEROPUERTO JORGE CHAVEZ" }, deps);
  ok(d.cotizacion?.yaEnviada === true && sb.t("cotizaciones").length === 1 && sb.t("alerta_enviada").length === 1 && consultasMotor.n === 1, "D: el mismo pedido ya enviado no se vuelve a cotizar ni consulta Google");
  ok(JSON.parse(d.respuestaModelo).cotizacion?.envio === "ya_enviada" && !d.envioPendiente, "D: el modelo sabe que ya se envió");

  // E) Revisión: el agente en copiloto. Sin importes para el modelo, nota interna, la IA no se pausa.
  const ctxE = ctxDe(sb, "cv-2", "ct-2", false);
  const e = await cotizarTrasladoIA(ctxE, { ...pedidoIA, destino_texto: "San Isidro" }, deps);
  ok(e.cotizacion?.decision === "revision" && !e.envioPendiente && !e.derivar, `E: en revisión (${JSON.stringify(sb.t("crm_acciones_ia").at(-1)?.payload?.motivos)})`);
  ok(!textoContradicePrecioJSON(e.respuestaModelo), "E: el modelo no recibe ningún importe");
  ok(sb.t("crm_notas").some((n) => n.conversacion_id === "cv-2" && /modo autónomo/.test(n.texto)), "E: nota interna con el motivo y su arreglo");
  const accE = sb.t("crm_acciones_ia").find((x) => x.conversacion_id === "cv-2")!;
  ok(sb.t("cotizaciones").find((x) => x.id === accE.resultado_id)?.cliente_id === 8, "E: cliente por los 9 dígitos del wa_id");

  // F) El mismo pedido, ahora en modo autónomo: se REUSA la cotización y se vuelve a decidir.
  const nCot = sb.t("cotizaciones").length, nCons = consultasMotor.n;
  const f = await cotizarTrasladoIA(ctxDe(sb, "cv-2", "ct-2", true), { ...pedidoIA, destino_texto: "san isidro" }, deps);
  ok(f.cotizacion?.decision === "automatico" && !!f.envioPendiente && f.cotizacion.cotizacionId === accE.resultado_id, `F: reusa la cotización y ahora sale sola (${f.cotizacion?.decision})`);
  ok(sb.t("cotizaciones").length === nCot && consultasMotor.n === nCons && sb.t("crm_acciones_ia").filter((x) => x.conversacion_id === "cv-2").length === 1, "F: sin otra cotización, sin otra consulta, sin otra acción");

  // G) Meta rechaza: la acción vuelve a pendiente con su error y una nota; el reintento sale.
  metaFalla = "(#131047) Re-engagement message";
  const g1 = await enviarCotizacionTraslado(sb as any, { accionId: accE.id, por: "automatico", bytes: f.envioPendiente!.bytes, nombre: f.envioPendiente!.nombre, caption: f.envioPendiente!.caption }, depsEnvio);
  ok(!g1.ok && g1.codigo === "envio_fallido" && /24 h/.test(g1.detalle), `G: el fallo se explica (${g1.detalle})`);
  ok(accE.estado === "pendiente" && accE.resuelta_at == null && typeof accE.payload.ultimo_error === "string" && /24 h/.test(accE.payload.ultimo_error) && accE.payload.ultimo_error_codigo === "envio_fallido", "G: la acción vuelve a pendiente con el error escrito");
  ok(sb.t("crm_notas").some((n) => n.conversacion_id === "cv-2" && /No se pudo enviar/.test(n.texto)), "G: y una nota interna");
  metaFalla = null;
  const g2 = await enviarCotizacionTraslado(sb as any, { accionId: accE.id, por: "ejecutivo", usuarioId: "u-9" }, depsEnvio);
  ok(g2.ok && accE.estado === "aprobada" && accE.resuelta_por === "u-9" && accE.payload.envio.por === "ejecutivo", `G: el ejecutivo la reenvía (arma el PDF de la fila) (${g2.codigo} ${g2.detalle})`);
  ok(envios.at(-1)!.to === "51955000111", "G: al wa_id de esa conversación");
  ok(sb.t("crm_mensajes").filter((x) => x.conversacion_id === "cv-2" && x.tipo === "document").at(-1)?.generado_por_ia === false, "G: el del ejecutivo cuenta como humano (aparta a la IA)");

  // H) Dos envíos a la vez: solo uno gana.
  sb.tablas.crm_contactos.push({ id: "ct-4", nombre: "Rosa", wa_id: "51911222333", telefono: null, cliente_id: null });
  sb.tablas.crm_conversaciones.push({ id: "cv-4", canal: "whatsapp", phone_number_id: null, contacto_id: "ct-4" });
  const h = await cotizarTrasladoIA(ctxDe(sb, "cv-4", "ct-4"), { ...pedidoIA, destino_texto: "Barranco" }, deps);
  const accH = sb.t("crm_acciones_ia").find((x) => x.conversacion_id === "cv-4")!;
  const antes = envios.length;
  const [h1, h2] = await Promise.all([
    enviarCotizacionTraslado(sb as any, { accionId: accH.id, por: "automatico", bytes: h.envioPendiente!.bytes, nombre: "x.pdf", caption: "c" }, depsEnvio),
    enviarCotizacionTraslado(sb as any, { accionId: accH.id, por: "ejecutivo", usuarioId: "u-1" }, depsEnvio),
  ]);
  ok([h1, h2].filter((x) => x.ok).length === 1 && envios.length === antes + 1, `H: dos envíos simultáneos → uno solo (${h1.codigo} / ${h2.codigo})`);

  // I) Un envío que murió (enviando con el plazo vencido) se puede reintentar; uno en curso, no.
  sb.tablas.crm_contactos.push({ id: "ct-5", nombre: "Juan", wa_id: "51922333444", telefono: null, cliente_id: null });
  sb.tablas.crm_conversaciones.push({ id: "cv-5", canal: "whatsapp", phone_number_id: null, contacto_id: "ct-5" });
  const i0 = await cotizarTrasladoIA(ctxDe(sb, "cv-5", "ct-5"), pedidoIA, deps);
  const accI = sb.t("crm_acciones_ia").find((x) => x.conversacion_id === "cv-5")!;
  accI.estado = "enviando"; accI.resuelta_at = new Date(reloj + 60_000).toISOString();
  ok((await enviarCotizacionTraslado(sb as any, { accionId: accI.id, por: "ejecutivo", usuarioId: "u" }, depsEnvio)).codigo === "no_pendiente", "I: enviando dentro del plazo → no se toca");
  accI.resuelta_at = new Date(reloj - 1).toISOString();
  const i1 = await enviarCotizacionTraslado(sb as any, { accionId: accI.id, por: "automatico", bytes: i0.envioPendiente!.bytes, nombre: "x.pdf", caption: "c" }, depsEnvio);
  ok(i1.ok, `I: con el plazo vencido, se reintenta (${i1.codigo})`);

  // J) Sin enlace firmado no se envía; sin wa_id tampoco; las dos vuelven a pendiente.
  sb.tablas.crm_contactos.push({ id: "ct-6", nombre: "Eva", wa_id: "51933444555", telefono: null, cliente_id: null });
  sb.tablas.crm_conversaciones.push({ id: "cv-6", canal: "whatsapp", phone_number_id: null, contacto_id: "ct-6" });
  await cotizarTrasladoIA(ctxDe(sb, "cv-6", "ct-6"), pedidoIA, deps);
  const accJ = sb.t("crm_acciones_ia").find((x) => x.conversacion_id === "cv-6")!;
  sb.firmaFalla = true;
  const nEnv = envios.length;
  const j1 = await enviarCotizacionTraslado(sb as any, { accionId: accJ.id, por: "ejecutivo", usuarioId: "u" }, depsEnvio);
  ok(!j1.ok && j1.codigo === "sin_url" && envios.length === nEnv && accJ.estado === "pendiente", `J: sin URL firmada no se envía (${j1.codigo})`);
  sb.firmaFalla = false;
  sb.t("crm_contactos").find((x) => x.id === "ct-6")!.wa_id = null;
  const j2 = await enviarCotizacionTraslado(sb as any, { accionId: accJ.id, por: "ejecutivo", usuarioId: "u" }, depsEnvio);
  ok(!j2.ok && j2.codigo === "sin_remitente" && envios.length === nEnv && accJ.estado === "pendiente", `J: sin wa_id no se envía (aunque el contacto tenga teléfono) (${j2.codigo})`);

  // K) Rechazada → la ve un ejecutivo (se deriva), sin otra cotización.
  accJ.estado = "rechazada";
  const k = await cotizarTrasladoIA({ ...ctxDe(sb, "cv-6", "ct-6"), remitente: { canal: "whatsapp", waId: "51933444555" } }, pedidoIA, deps);
  ok(k.accion === "derivar" && /rechazó/.test(k.derivar?.motivo ?? ""), "K: un pedido igual a uno rechazado se deriva");

  // L) Topes: con 10 consultas hoy en la conversación, se deriva SIN gastar Google; un conteo ilegible también.
  sb.tablas.crm_contactos.push({ id: "ct-7", nombre: "Leo", wa_id: "51944555666", telefono: null, cliente_id: null });
  sb.tablas.crm_conversaciones.push({ id: "cv-7", canal: "whatsapp", phone_number_id: null, contacto_id: "ct-7" });
  for (let x = 0; x < E.TOPES.MAX_CONSULTAS_CONV_DIA; x++) sb.t("alerta_enviada").push({ clave: CLAVE_CONSULTA_IA, ref: `conv:cv-7:${x}`, fecha: "2026-10-19" });
  const nMotor = consultasMotor.n;
  const l1 = await cotizarTrasladoIA(ctxDe(sb, "cv-7", "ct-7"), pedidoIA, deps);
  ok(l1.accion === "derivar" && consultasMotor.n === nMotor, `L: tope de la conversación → deriva sin consultar (${l1.derivar?.motivo})`);
  sb.fallas.push({ tabla: "alerta_enviada", op: "select", mensaje: "timeout" });
  const l2 = await cotizarTrasladoIA(ctxDe(sb, "cv-1", "ct-1"), { ...pedidoIA, pax: 3 }, deps);
  ok(l2.accion === "derivar" && consultasMotor.n === nMotor, "L: un conteo que no se pudo leer bloquea");
  sb.fallas.pop();
  const ctxL = ctxDe(sb, "cv-1", "ct-1"); ctxL.consultasTurno.n = E.TOPES.MAX_CONSULTAS_POR_TURNO;
  ok((await cotizarTrasladoIA(ctxL, { ...pedidoIA, pax: 3 }, deps)).accion === "derivar" && consultasMotor.n === nMotor, "L: tope por turno");

  // M) Sin la columna creada_at (no debería pasar: es la real) se cuenta con created_at.
  const sbM = nuevaBase();
  sbM.faltan.crm_acciones_ia = ["creada_at"];
  const m = await cotizarTrasladoIA(ctxDe(sbM, "cv-1", "ct-1"), pedidoIA, { ...deps, simular: simularFalso({ n: 0 }) as any });
  ok(m.accion === "cotizar", `M: sin creada_at se lee con created_at (${m.accion} ${m.derivar?.motivo ?? ""})`);

  // N) Sin las columnas de traslados-05 en cotizaciones: no se cotiza (y se dice cuál falta).
  const sbN = nuevaBase();
  sbN.faltan.cotizaciones = ["crm_conversacion_id", "traslado_json"];
  const nn = await cotizarTrasladoIA(ctxDe(sbN, "cv-1", "ct-1"), pedidoIA, { ...deps, simular: simularFalso({ n: 0 }) as any });
  ok(nn.accion === "derivar" && sbN.t("cotizaciones").length === 0, `N: sin traslados-05 no se cotiza (${nn.derivar?.motivo})`);
  const sbN2 = nuevaBase();
  sbN2.tablas.traslados_config[0].ia_cotiza = false;
  ok((await cotizarTrasladoIA(ctxDe(sbN2, "cv-1", "ct-1"), pedidoIA, deps)).accion === "derivar", "N: con el interruptor apagado no se cotiza");

  // O) Un pedido incompleto pregunta, sin crear nada.
  const sbO = nuevaBase();
  const o = await cotizarTrasladoIA(ctxDe(sbO, "cv-1", "ct-1"), { ...pedidoIA, maletas: undefined }, { ...deps, simular: simularFalso({ n: 0 }) as any });
  ok(o.accion === "preguntar" && (o.faltan ?? []).some((x) => /maletas/.test(x)) && sbO.t("cotizaciones").length === 0 && sbO.t("crm_acciones_ia").length === 0, "O: pregunta lo que falta sin crear nada");
  ok(JSON.parse(o.respuestaModelo).instruccion.startsWith("Pregúntale al cliente, en un solo mensaje:"), "O: sin el modo del agente, la instrucción de siempre (todo junto)");
  // O2) Con el agente en «uno por mensaje», la instrucción al modelo pide SOLO el primero; el resultado
  //     (lo que lee el código para su «me falta») trae la lista entera, en el orden del motor.
  {
    const sbO2 = nuevaBase();
    const o2 = await cotizarTrasladoIA({ ...ctxDe(sbO2, "cv-1", "ct-1"), preguntas: "una_por_mensaje" }, { ...pedidoIA, maletas: undefined, pax: undefined },
      { ...deps, simular: simularFalso({ n: 0 }) as any });
    const ins = JSON.parse(o2.respuestaModelo).instruccion as string;
    ok(o2.accion === "preguntar" && (o2.faltan ?? []).length === 2 && ins.startsWith(`Pregúntale al cliente SOLO por: ${o2.faltan![0]}.`) && ins.includes(o2.faltan![1]) && !/en un solo mensaje/.test(ins),
      `O2: uno por mensaje → SOLO el primero (${ins})`);
    ok(E.textoFinalTraslado("¿El retorno te sale gratis?", o2, { nombre: "Ana", derivacion: "d", estilo: { tratamiento: "usted", preguntas: "una_por_mensaje" } }) === `Para cotizar su traslado, ¿me indica ${o2.faltan![0]}?`,
      "O2: y el texto del código con dinero pide el mismo primero");
    ok(sbO2.t("cotizaciones").length === 0 && sbO2.t("crm_acciones_ia").length === 0, "O2: sin crear nada");
  }

  // P) La moneda es la del wa_id aunque el modelo diga un teléfono extranjero (ya probado arriba con
  //    +1 305…: la cotización A salió en soles).
  ok(cot.moneda === "PEN" && cot.tipo_cambio == null, "P: el teléfono que escribe el modelo no cambia la moneda");

  // P2) DÓLARES A PEDIDO: el modelo lo marca pero el cliente nunca escribió «dólares» → soles; el
  //     cliente lo escribe → otra cotización (otra firma), en dólares con el TC, y sale sola.
  {
    const sbP = nuevaBase();
    const pIA = { ...pedidoIA, cliente_pide_dolares: true, senales: ["otra_moneda"] };
    const p1 = await cotizarTrasladoIA(ctxDe(sbP, "cv-1", "ct-1"), { ...pIA, senales: [] }, { ...deps, simular: simularFalso({ n: 0 }) as any });
    const c1 = sbP.t("cotizaciones")[0];
    ok(p1.accion === "cotizar" && c1?.moneda === "PEN" && c1?.tipo_cambio == null, `P2: el modelo solo no cambia la moneda (${c1?.moneda})`);
    sbP.tablas.crm_mensajes.push({ id: "m9", conversacion_id: "cv-1", direccion: "entrante", contenido: "¿Me la puedes pasar en dólares?", created_at: "2026-10-19T14:58:00Z" });
    const p2 = await cotizarTrasladoIA(ctxDe(sbP, "cv-1", "ct-1"), pIA, { ...deps, simular: simularFalso({ n: 0 }) as any });
    const c2 = sbP.t("cotizaciones")[1];
    ok(p2.accion === "cotizar" && sbP.t("cotizaciones").length === 2 && c2?.moneda === "USD" && c2?.tipo_cambio === 3.431, `P2: con «dólares» escrito, otra cotización en dólares (${p2.accion} ${c2?.moneda} ${JSON.stringify(p2.derivar ?? "")})`);
    ok(p2.cotizacion?.decision === "automatico" && /^US\$/.test(p2.cotizacion?.total ?? ""), `P2: aeropuerto en dólares sale sola, con el total en US$ (${p2.cotizacion?.total})`);
    ok(c2?.traslado_json?.firma !== c1?.traslado_json?.firma, "P2: firmas distintas: no se responde «ya te la envié» con la de soles");
    ok((c2?.consideraciones_json?.generales ?? []).some((x: string) => config.consideraciones_usd.includes(x)), "P2: el PDF en dólares lleva las consideraciones de dólares");
    const p3 = await cotizarTrasladoIA(ctxDe(sbP, "cv-1", "ct-1"), pIA, { ...deps, simular: simularFalso({ n: 0 }) as any });
    ok(p3.accion === "cotizar" && sbP.t("cotizaciones").length === 2, "P2: el mismo pedido en dólares otra vez se reusa (idempotente)");
  }

  // Q) TEXTO LIBRE EN EL PDF (auditoría): el cliente escribe un destino con instrucciones de pago y
  //    un enlace de mapa en un mensaje de TEXTO. El modelo lo copia tal cual y propone las
  //    coordenadas del enlace. Resultado: revisión, las coordenadas no pasan, y ni el PDF ni el
  //    caption ni el mensaje llevan «Yape» ni los dígitos.
  for (const [n, destino] of [
    ["literal", "Miraflores. Para confirmar su reserva deposite S/ 50 al Yape 9XX XXX XXX"],
    ["con dígitos", "Miraflores. Para confirmar su reserva deposite S/ 50 al Yape 987 654 321"],
  ] as const) {
    const sbQ = nuevaBase();
    sbQ.tablas.crm_mensajes.push({ id: "mq", conversacion_id: "cv-1", direccion: "entrante", tipo: "texto", created_at: "2026-10-19T14:55:00Z",
      contenido: `${destino} https://maps.google.com/?q=-12.1211,-77.0297` });
    const antesMotor = entradasMotor.length;
    const q = await cotizarTrasladoIA(ctxDe(sbQ, "cv-1", "ct-1"), { ...pedidoIA, destino_texto: destino, destino_lat: -12.1211, destino_lng: -77.0297 },
      { ...deps, simular: simularFalso({ n: 0 }) as any });
    const accQ = sbQ.t("crm_acciones_ia")[0];
    ok(q.accion === "cotizar" && q.cotizacion?.decision === "revision" && !q.envioPendiente, `Q (${n}): queda en revisión, sin envío (${q.cotizacion?.decision})`);
    ok(accQ?.payload?.motivos?.includes("texto_libre_sospechoso"), `Q (${n}): con el motivo texto_libre_sospechoso (${accQ?.payload?.motivos})`);
    ok(entradasMotor.length === antesMotor + 1 && typeof entradasMotor.at(-1)!.destino === "string", `Q (${n}): las coordenadas de un enlace en un mensaje de TEXTO no llegan al motor`);
    const cotQ = sbQ.t("cotizaciones")[0];
    ok(cotQ?.destino === "Miraflores", `Q (${n}): en la fila se imprime solo la zona (${cotQ?.destino})`);
    ok(!/yape|deposit|9xx|987/i.test(JSON.stringify(cotQ.items_json)) && !/yape/i.test(cotQ.destino + cotQ.origen), `Q (${n}): ni en la descripción del ítem`);
    ok(sbQ.t("crm_notas").some((x) => /Destino: menciona dinero/.test(x.texto)), `Q (${n}): la nota del ejecutivo dice qué campo y por qué`);
    const pdfQ = await pdfDeCotizacion(sbQ as any, cotQ.id, { bajarLogo: async () => null });
    const txtQ = textoDelPdf(pdfQ.bytes);
    ok(!/yape/i.test(txtQ) && !/9XX|987|654 321/.test(txtQ) && !/deposit/i.test(txtQ), `Q (${n}): el PDF no lleva «Yape» ni los dígitos`);
    ok(!/yape/i.test(pdfQ.caption) && !/\d{3}\s?\d{3}/.test(pdfQ.caption.replace(/N° \d+/, "")), `Q (${n}): el caption tampoco (${pdfQ.caption})`);
    // El mensaje del turno lo escribe el código: el del modelo repetía la instrucción de pago. Con
    // cualquiera de los cuatro estilos del agente.
    for (const estilo of ESTILOS) {
      const final = E.textoFinalTraslado(`Listo, ${destino}`, q, { nombre: "Ana Pérez", derivacion: "Un ejecutivo te escribe.", estilo });
      ok(!/yape|deposit|\b50\b|9XX|987/i.test(final) && final.includes(q.cotizacion!.numero), `Q (${n}, ${nombreEstilo(estilo)}): el mensaje al cliente no repite nada (${final})`);
    }
    // El ejecutivo la aprueba: sale el PDF de la fila, sin el texto del cliente.
    const nE = envios.length;
    const qe = await enviarCotizacionTraslado(sbQ as any, { accionId: accQ.id, por: "ejecutivo", usuarioId: "u-1", esperado: { conversacionId: "cv-1" } }, depsEnvio);
    ok(qe.ok && envios.length === nE + 1 && !/yape/i.test(envios.at(-1)!.caption ?? ""), `Q (${n}): aprobada, sale sin el texto del cliente (${qe.codigo})`);
  }

  // Q2) El nombre del contacto con instrucciones de pago: revisión, «Atención» no se imprime y el
  //     saludo no lo usa.
  {
    const sbQ = nuevaBase();
    sbQ.t("crm_contactos").find((x) => x.id === "ct-1")!.nombre = "Pague al Yape 987654321";
    const q = await cotizarTrasladoIA(ctxDe(sbQ, "cv-1", "ct-1"), pedidoIA, { ...deps, simular: simularFalso({ n: 0 }) as any });
    const cotQ = sbQ.t("cotizaciones")[0];
    ok(q.cotizacion?.decision === "revision" && sbQ.t("crm_acciones_ia")[0].payload.motivos.join() === "texto_libre_sospechoso", `Q2: revisión solo por el nombre (${sbQ.t("crm_acciones_ia")[0]?.payload?.motivos})`);
    ok(cotQ.atencion === null, "Q2: «Atención» no se imprime");
    const txtQ = textoDelPdf((await pdfDeCotizacion(sbQ as any, cotQ.id, { bajarLogo: async () => null })).bytes);
    ok(!/yape|987654321/i.test(txtQ), "Q2: el PDF no lo lleva");
    for (const estilo of ESTILOS)
      ok(E.textoFinalTraslado("x", q, { nombre: "Pague al Yape 987654321", derivacion: "d", estilo }).startsWith("Hola,"), `Q2 (${nombreEstilo(estilo)}): el saludo no lo usa`);
  }

  // R) La acción tiene que ser de la conversación y la cotización que dice quien envía.
  {
    const sbR = nuevaBase();
    const r0 = await cotizarTrasladoIA(ctxDe(sbR, "cv-1", "ct-1"), pedidoIA, { ...deps, simular: simularFalso({ n: 0 }) as any });
    const accR = sbR.t("crm_acciones_ia")[0];
    const antes = JSON.stringify(accR), nE = envios.length, nNotas = sbR.t("crm_notas").length;
    const r1 = await enviarCotizacionTraslado(sbR as any, { accionId: accR.id, por: "ejecutivo", usuarioId: "u", esperado: { conversacionId: "cv-2" } }, depsEnvio);
    ok(!r1.ok && r1.codigo === "cotizacion_ajena" && /conversación/.test(r1.detalle), `R: de otra conversación → ${r1.codigo}`);
    ok(JSON.stringify(accR) === antes && envios.length === nE && sbR.t("crm_notas").length === nNotas, "R: ni se reclama, ni se envía, ni se escribe nada");
    const r2 = await enviarCotizacionTraslado(sbR as any, { accionId: accR.id, por: "automatico", bytes: r0.envioPendiente!.bytes, nombre: "x.pdf", caption: "c", esperado: { conversacionId: "cv-1", cotizacionId: accR.resultado_id + 1 } }, depsEnvio);
    ok(!r2.ok && r2.codigo === "cotizacion_ajena" && JSON.stringify(accR) === antes, `R: de otra cotización → ${r2.codigo}`);
    const r3 = await enviarCotizacionTraslado(sbR as any, { accionId: accR.id, por: "automatico", bytes: r0.envioPendiente!.bytes, nombre: "x.pdf", caption: "c", esperado: { conversacionId: "cv-1", cotizacionId: r0.envioPendiente!.cotizacionId } }, depsEnvio);
    ok(r3.ok && accR.estado === "aprobada", `R: con la conversación y la cotización correctas, sale (${r3.codigo})`);
  }

  // S) Una ubicación COMPARTIDA (tipo «location») sí aporta coordenadas, y elegir el pin del
  //    aeropuerto es lo mismo que escribir «Aeropuerto»: la protección no son las coordenadas.
  {
    const sbS = nuevaBase();
    sbS.tablas.crm_mensajes.push({ id: "ms", conversacion_id: "cv-1", direccion: "entrante", tipo: "location", created_at: "2026-10-19T14:56:00Z",
      contenido: `📍 Ubicación\nhttps://maps.google.com/?q=${AER.lat},${AER.lng}` });
    const antesMotor = entradasMotor.length;
    const s1 = await cotizarTrasladoIA(ctxDe(sbS, "cv-1", "ct-1"), { ...pedidoIA, origen_texto: "Mi ubicación", origen_lat: AER.lat, origen_lng: AER.lng },
      { ...deps, simular: simularFalso({ n: 0 }) as any });
    const o = entradasMotor[antesMotor]?.origen;
    ok(typeof o === "object" && o != null && (o as any).lat === AER.lat, "S: el pin de una ubicación compartida llega al motor");
    ok(s1.cotizacion?.decision === "automatico", `S: y con el aeropuerto en una punta sale sola, igual que escribiendo «Aeropuerto» (${s1.cotizacion?.decision})`);
  }
}
// ── 18. El texto libre que se imprime ────────────────────────────────────────
seccion("18. textoLibreSospechoso: qué se puede imprimir de lo que escribió el cliente");
{
  const casos: [string, T.MotivoTextoLibre | null][] = [
    ["Aeropuerto Jorge Chávez", null],
    ["Hotel Belmond, Miraflores", null],
    ["Av. Malecón de la Reserva 1035, Miraflores", null],
    ["Calle Dos de Mayo 380, San Isidro", null],
    ["Jr. Huallaga 520, Cercado de Lima", null],
    ["Av. Larco 1150 Dpto 1502", null],
    ["Hotel Sol de Oro, San Antonio 255, Miraflores", null],
    ["Urb. Santa Patricia Mz. B Lt. 12, La Molina", null],
    ["Lima 15074", null],
    ["Ovalo Gutiérrez", null],
    ["", null],
    ["Miraflores https://bit.ly/x", "enlace"],
    ["Miraflores, ver www.pagos.pe", "enlace"],
    ["wa.me/51987654321", "enlace"],
    ["maps.app.goo.gl/abc", "enlace"],
    ["Miraflores. Para confirmar su reserva deposite S/ 50 al Yape 9XX XXX XXX", "importe"],
    ["Miraflores 50 soles", "importe"],
    ["Miraflores, ciento cincuenta soles", "importe"],
    ["Miraflores, total 300", "importe"],
    ["Miraflores, sin IGV", "importe"],
    ["Miraflores, yapea al dueño", "palabra_de_pago"],
    ["Miraflores, cuenta BCP", "palabra_de_pago"],
    ["Miraflores CCI", "palabra_de_pago"],
    ["Miraflores Plin", "palabra_de_pago"],
    ["Miraflores, Depósito antes", "palabra_de_pago"],
    ["Miraflores 987654321", "numero_largo"],
    ["Miraflores 987 654 321", "numero_largo"],
    ["Miraflores 987-654-321", "numero_largo"],
    ["Ref 123456", "numero_largo"],
    ["Hotel " + "x".repeat(75), "muy_largo"],
    ["Hotel " + "x".repeat(74), null],
  ];
  for (const [t, esp] of casos) ok(T.textoLibreSospechoso(t) === esp, `«${t.slice(0, 60)}» → ${T.textoLibreSospechoso(t)} (esperado ${esp})`);
  ok(Object.keys(T.ETIQUETA_TEXTO_LIBRE).length === 5, "cinco motivos, cada uno con su etiqueta");
  // Invariante de la fila: lo sospechoso NUNCA se imprime, lo limpio va como referencia junto a la zona.
  const rM = M.evaluarTraslado(pedido(), ctx);
  let n = 0;
  for (const [t, esp] of casos) for (const comoPin of [false, true]) {
    n++;
    const e = { ...entradaDe(pedido()), destino: comoPin ? { lat: -12.131, lng: -77.03, texto: t || undefined } : t };
    const fila = C.filaCotizacionTraslado(rM, e, { convId: "c", clienteId: null, atencion: t, config, firma: "f", hoy: HOY });
    const impreso = `${fila.origen} ${fila.destino} ${fila.atencion ?? ""} ${fila.items_json[0].descripcion}`;
    if (esp) {
      ok(!impreso.includes(t), `sospechoso no se imprime: «${t.slice(0, 40)}»`);
      ok(fila.destino === (comoPin ? "Miraflores (ubicación compartida)" : "Miraflores") && fila.atencion === null, `queda la zona (${fila.destino})`);
    } else if (t) {
      ok(fila.destino === `Miraflores (${t})` && fila.atencion === t.slice(0, 60).trim(), `limpio: zona + referencia (${fila.destino})`);
    }
    ok(Array.from(fila.destino).length <= 80 + "Miraflores ()".length, "la referencia impresa no pasa de 80 caracteres");
  }
  console.log(`  barrido: ${n} filas`);
  ok(C.filaCotizacionTraslado(rM, { ...entradaDe(pedido()), destino: "  MIRAFLORES " }, { convId: "c", clienteId: null, atencion: null, config, firma: "f", hoy: HOY }).destino === "Miraflores", "si lo del cliente es el nombre de la zona, no se repite");
  ok(T.atencionImprimible("Ana  María\nPérez") === "Ana María Pérez", "atención en una línea");
  ok(T.atencionImprimible("A".repeat(70)) === "A".repeat(60) && T.atencionImprimible("A".repeat(81)) === null, "atención: hasta 60; más de 80 es sospechoso");
  ok(T.primerNombreSeguro("Ana Pérez") === "Ana" && T.primerNombreSeguro("José-Luis Q") === "José-Luis" && T.primerNombreSeguro("+51 999") === ""
    && T.primerNombreSeguro("Yape 987") === "" && T.primerNombreSeguro("https://x") === "" && T.primerNombreSeguro("Ana123") === "" && T.primerNombreSeguro(null) === "", "primerNombreSeguro");
  // planEnvio: con un texto libre sospechoso no sale sola; sin textos, igual que antes.
  const base = { resultado: rM, envioMaestro: true, zonas, canal: "whatsapp", waId: "51966707225", modoAuto: true, perfilConfigurado: true, cuadra: true, pdfOk: true, palabras: [] as string[] };
  ok(E.planEnvio(base).decision === "automatico" && E.planEnvio({ ...base, textosLibres: [] }).decision === "automatico", "sin textos sospechosos sale sola");
  for (const [t, esp] of casos) {
    const p = E.planEnvio({ ...base, textosLibres: ["Aeropuerto Jorge Chávez", t, "Ana"] });
    ok((p.decision === "revision") === (esp != null) && (esp == null || p.motivos.join() === "texto_libre_sospechoso"), `planEnvio con «${t.slice(0, 30)}» → ${p.decision}`);
  }
  ok(E.planEnvio({ ...base, textosLibres: [null, undefined, "Ana", "Pague al Yape 987654321"] }).motivos.join() === "texto_libre_sospechoso", "también el nombre del contacto");
}

// ── 19. El texto del turno: con cotización lo escribe el código; sin ella, sin dinero ──
seccion("19. textoFinalTraslado: el modelo no escribe importes");
{
  // La cotización de la prueba: tramo 120, subtotal 240, IGV 43.20, total 283.20 (en soles).
  const FRASES_DINERO = [
    "El total sería 150 (IGV incluido)",
    "Total: 150.00 nuevos soles",
    "Son 150$ con IGV",
    "ciento cincuenta soles",
    "Te aplico 50 % de descuento",
    "€ 150",
    "US$283.20",
    "283.20 dólares",
    "El total es S/ 43.20",
    "serán aprox 300",
    "Te sale gratis el retorno",
    "Son S/. 283.20 más IGV",
    "costaría unos 240",
    "Cuesta 120 por tramo",
    "Hola Ana, ¡listo! El precio es de S/ 300 para 2 pasajeros.",
  ];
  const LIMPIAS = [
    "¡Hola! Para cotizar tu traslado me falta saber la hora de recojo y cuántas maletas de 23 kg llevan.",
    "¿Serían 4 pasajeros? ¿A qué hora aterriza tu vuelo, 10:30?",
    "El recojo sería el 2026-10-25 a las 05:30, ¿correcto?",
    "Perfecto, son 3 maletas grandes y 2 pasajeros.",
    "¿Sería para 4 personas? ¿Llevan maletas?",
    "Un ejecutivo revisará tu pedido y te escribirá por este chat.",
    "¿Tu vuelo es el LA2045 del 25 de octubre?",
    "¿El recojo sería en el terminal nacional o internacional?",
  ];
  for (const f of FRASES_DINERO) ok(T.mencionaDinero(f), `menciona dinero: «${f}»`);
  for (const f of LIMPIAS) ok(!T.mencionaDinero(f), `no menciona dinero: «${f}»`);
  const derivacion = "Hola Ana, un ejecutivo revisará tu pedido y te enviará la información por este chat.";
  ok(!T.mencionaDinero(derivacion), "el mensaje de derivación no menciona dinero");
  const cotAuto = { numero: "00123", decision: "automatico" as const, total: "S/ 283.20", validez: "18/11/2026" };
  const modos: [string, E.TrasladoDelTurno][] = [
    ["auto", { accion: "cotizar", cotizacion: cotAuto }],
    ["revisión", { accion: "cotizar", cotizacion: { numero: "00124", decision: "revision" } }],
    ["ya enviada", { accion: "cotizar", cotizacion: { ...cotAuto, yaEnviada: true } }],
    ["preguntar", { accion: "preguntar", faltan: ["la cantidad de maletas de 23 kg", "la hora de recojo"] }],
    ["derivar", { accion: "derivar" }],
  ];
  // El «me falta» que escribe el código, por estilo: el de «tu» + «todo junto» es el literal de siempre.
  const ME_FALTA: Record<string, string> = {
    "tu/todo_junto": "Para cotizar tu traslado me falta: la cantidad de maletas de 23 kg; la hora de recojo.",
    "tu/una_por_mensaje": "Para cotizar tu traslado, ¿me indicas la cantidad de maletas de 23 kg?",
    "usted/todo_junto": "Para cotizar su traslado me falta: la cantidad de maletas de 23 kg; la hora de recojo.",
    "usted/una_por_mensaje": "Para cotizar su traslado, ¿me indica la cantidad de maletas de 23 kg?",
  };
  let n = 0;
  // El guard de importes se barre con los CUATRO estilos del agente: el trato y el modo de preguntar
  // cambian las palabras del código, nunca lo que deja pasar del modelo.
  for (const estilo of ESTILOS) for (const [modo, t] of modos) for (const f of [...FRASES_DINERO, ...LIMPIAS, ""]) {
    n++;
    const ne = nombreEstilo(estilo);
    const final = E.textoFinalTraslado(f, t, { nombre: "Ana Pérez", derivacion, estilo });
    if (t.cotizacion) {
      ok(final === E.mensajeCotizacionCodigo({ nombre: "Ana Pérez", ...t.cotizacion, estilo }), `${ne} ${modo}: con cotización, SIEMPRE el texto del código («${f.slice(0, 30)}»)`);
      const permitidas = t.cotizacion.total ? [283.2] : [];
      ok(T.importesEnTexto(final).every((x) => permitidas.some((p) => Math.abs(p - x) < 0.005)), `${ne} ${modo}: solo el total de la cotización (${final})`);
      ok(!/\b150\b|\b300\b|43\.20|€|US\$|d[oó]lares|gratis|descuento|aprox|%/.test(final), `${ne} ${modo}: nada de la frase del modelo`);
      ok(estilo.tratamiento === "tu" ? !USTEDEA.test(final) : !TUTEA.test(final), `${ne} ${modo}: el texto del código con el trato del agente (${final})`);
    } else if (f && T.mencionaDinero(f)) {
      ok(!T.mencionaDinero(final) && final !== f, `${ne} ${modo}: el texto con dinero se reemplaza («${f.slice(0, 30)}» → «${final.slice(0, 50)}»)`);
      ok(modo === "preguntar" ? final === ME_FALTA[ne] : final === derivacion, `${ne} ${modo}: por «me falta» o la derivación (${final})`);
    } else {
      ok(final === f, `${ne} ${modo}: el texto limpio del modelo pasa intacto («${f.slice(0, 30)}»)`);
    }
  }
  console.log(`  barrido: ${n} textos (4 estilos)`);
  for (const estilo of ESTILOS) {
    const ne = nombreEstilo(estilo);
    ok(E.textoFinalTraslado("Cuesta S/ 999", null, { nombre: "Ana", derivacion, estilo }) === "Cuesta S/ 999", `${ne}: sin la herramienta en el turno, el texto no se toca`);
    ok(E.textoFinalTraslado("Cuesta S/ 999", { accion: "preguntar", faltan: [] }, { nombre: "Ana", derivacion, estilo }) === derivacion, `${ne}: preguntar sin lista de faltantes: derivación`);
    // La cifra de una cotización EN DÓLARES no se cuela en una cotización en soles.
    const enSoles = E.textoFinalTraslado("Son US$283.20", { accion: "cotizar", cotizacion: cotAuto }, { nombre: "", derivacion, estilo });
    ok(!enSoles.includes("US$") && enSoles.includes("S/ 283.20") && enSoles.startsWith("Hola,"), `${ne}: en soles, el total en soles (${enSoles})`);
  }
}

// ── 20. El logo del PDF ──────────────────────────────────────────────────────
seccion("20. bajarLogo: solo del almacenamiento público del propio Supabase, solo PNG o JPG (comprobados por sus bytes)");
{
  const BASE = "https://abcd1234.supabase.co";
  const PUB = `${BASE}/storage/v1/object/public/empresa/logo.png`;
  const PNG = new Uint8Array(logoPng);
  // Un JPEG de verdad (con su SOF y su final): la cabecera sola ya no basta, porque pdf-lib lo
  // incrusta sin decodificar y uno cortado saldría roto en el PDF.
  const JPG = new Uint8Array(await sharp({ create: { width: 40, height: 20, channels: 3, background: "#0b315f" } }).jpeg().toBuffer());
  const JPG_CORTADO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  const SVG = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`);
  const WEBP = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
  let llamadas = 0;
  const cuerpo = (b: Uint8Array): BodyInit => new Blob([new Uint8Array(b)]);
  const fetchCon = (b: Uint8Array, extra: ResponseInit = {}) => (async (_u: any, _o?: any) => { llamadas++; return new Response(cuerpo(b), { status: 200, ...extra }); }) as typeof fetch;
  const casos: [string, string, typeof fetch, string | null, "png" | "jpg" | null, boolean][] = [
    ["PNG del bucket público", PUB, fetchCon(PNG), BASE, "png", true],
    ["JPG del bucket público", PUB.replace(".png", ".jpg"), fetchCon(JPG), BASE, "jpg", true],
    ["JPG cortado (solo la cabecera)", PUB.replace(".png", ".jpg"), fetchCon(JPG_CORTADO), BASE, null, true],
    ["SVG", PUB.replace(".png", ".svg"), fetchCon(SVG), BASE, null, true],
    ["WebP", PUB.replace(".png", ".webp"), fetchCon(WEBP), BASE, null, true],
    ["host ajeno", "https://evil.test/storage/v1/object/public/empresa/logo.png", fetchCon(PNG), BASE, null, false],
    ["otro proyecto de Supabase", "https://otro.supabase.co/storage/v1/object/public/empresa/logo.png", fetchCon(PNG), BASE, null, false],
    ["ruta que no es el almacenamiento público", `${BASE}/rest/v1/empresa_perfil`, fetchCon(PNG), BASE, null, false],
    ["bucket firmado (privado)", `${BASE}/storage/v1/object/sign/documentos/x.png?token=y`, fetchCon(PNG), BASE, null, false],
    ["salto de ruta", `${BASE}/storage/v1/object/public/../../rest/v1/x`, fetchCon(PNG), BASE, null, false],
    ["http", PUB.replace("https:", "http:"), fetchCon(PNG), BASE, null, false],
    ["con usuario", PUB.replace("https://", "https://u:p@"), fetchCon(PNG), BASE, null, false],
    ["sin NEXT_PUBLIC_SUPABASE_URL", PUB, fetchCon(PNG), null, null, false],
    ["base http", PUB, fetchCon(PNG), "http://abcd1234.supabase.co", null, false],
    ["no es URL", "logo.png", fetchCon(PNG), BASE, null, false],
    ["respuesta 404", PUB, (async () => { llamadas++; return new Response(cuerpo(PNG), { status: 404 }); }) as typeof fetch, BASE, null, true],
    ["más de 2 MB", PUB, fetchCon(new Uint8Array(2 * 1024 * 1024 + 10).fill(0x89)), BASE, null, true],
    ["fetch que lanza", PUB, (async () => { llamadas++; throw new Error("x"); }) as typeof fetch, BASE, null, true],
  ];
  for (const [n, url, f, base, tipo, llama] of casos) {
    const antes = llamadas;
    const r = await bajarLogo(url, f, base);
    ok((r?.tipo ?? null) === tipo, `${n} → ${r?.tipo ?? null}`);
    ok((llamadas > antes) === llama, `${n}: ${llama ? "sí" : "no"} se pide`);
  }
  const src = readFileSync("lib/traslados/enviar-cotizacion-datos.ts", "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  ok(!/sharp/.test(src), "sin conversión con sharp");
}

// ── 21. Quién puede enviar, el freno de la prueba y el número de destino ──────
seccion("21. accionAjena, la ruta de la tarjeta, /api/crm/ia/probar y el destino fijo");
{
  const acc = { conversacion_id: "cv-1", resultado_id: 12, payload: { cotizacion_id: 12 } };
  ok(accionAjena(acc, undefined) === null && accionAjena(acc, {}) === null, "sin esperado no se comprueba nada");
  ok(accionAjena(acc, { conversacionId: "cv-1", cotizacionId: 12 }) === null, "la suya pasa");
  ok(/conversación/.test(accionAjena(acc, { conversacionId: "cv-2" }) ?? ""), "otra conversación no");
  ok(accionAjena(acc, { conversacionId: "" }) != null && accionAjena(acc, { conversacionId: "  " }) != null, "una conversación esperada vacía no pasa");
  ok(accionAjena({ ...acc, conversacion_id: null }, { conversacionId: "cv-1" }) != null, "una acción sin conversación no pasa");
  ok(/cotización/.test(accionAjena(acc, { cotizacionId: 13 }) ?? "") && accionAjena(acc, { cotizacionId: NaN }) != null && accionAjena(acc, { cotizacionId: 0 }) != null, "otra cotización no");
  ok(accionAjena({ conversacion_id: "cv-1", resultado_id: null, payload: { cotizacion_id: 12 } }, { cotizacionId: 12 }) === null, "la cotización también del payload");
  // La ruta de la tarjeta: exige la conversación y la compara.
  const quitarComentarios = (x: string) => x.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const ruta = quitarComentarios(readFileSync("app/api/crm/ia/accion/route.ts", "utf8"));
  ok(/conversacion_id\s*}\s*=\s*await req\.json\(\)/.test(ruta), "la ruta lee conversacion_id del cuerpo");
  ok(/accion\.conversacion_id !== convEsperada[\s\S]{0,200}status: 409/.test(ruta), "si no coincide → 409");
  const rama = ruta.slice(ruta.indexOf('accion.tipo === "cotizacion_traslado"'));
  ok(/if \(!convEsperada\)[\s\S]{0,200}status: 400/.test(rama.slice(0, 400)) && rama.indexOf("!convEsperada") < rama.indexOf('decision === "rechazar"'), "en traslados la exige ANTES de rechazar o enviar");
  ok(/esperado: \{ conversacionId: convEsperada \}/.test(rama), "y la pasa al envío");
  const bandeja = readFileSync("components/crm/BandejaCRM.tsx", "utf8");
  ok((bandeja.match(/decision: "(?:aprobar|rechazar)", conversacion_id: a\.conversacion_id/g) ?? []).length === 2, "la tarjeta del inbox manda la conversación al aprobar y al rechazar");
  // /api/crm/ia/probar: mismo origen y 10 por usuario y minuto.
  const probar = quitarComentarios(readFileSync("app/api/crm/ia/probar/route.ts", "utf8"));
  ok(/guardarGasto\(req/.test(probar) && probar.indexOf("guardarGasto(req") < probar.indexOf("verificarUsuarioApi("), "probar: mismo origen, antes que nada");
  ok(/limitarTasa\(clave, PRUEBAS_POR_MINUTO, 60_000\)/.test(probar) && /`crm-probar:\$\{auth\.userId\}`/.test(probar) && /PRUEBAS_POR_MINUTO = 10/.test(probar), "probar: 10 por usuario y minuto");
  ok(probar.indexOf("limitarTasa(") < probar.indexOf("probarAgente("), "probar: el freno va antes de gastar");
  const claveT = `crm-probar:prueba-${Math.random()}`;
  const pasan = Array.from({ length: 11 }, () => limitarTasa(claveT, 10, 60_000));
  ok(pasan.slice(0, 10).every(Boolean) && pasan[10] === false, "limitarTasa: diez pasan, la undécima no");
  // El envío automático dice de qué conversación y cotización es; el texto va al número copiado ANTES del bucle.
  const ia = quitarComentarios(readFileSync("lib/crm-ia.ts", "utf8"));
  ok(/esperado: \{ conversacionId: String\(conv\.id\), cotizacionId: pdf\.cotizacionId \}/.test(ia), "crm-ia: el PDF automático exige su conversación y su cotización");
  const cuerpo = ia.slice(ia.indexOf("async function responderConIAInterno"));
  const iSnap = cuerpo.indexOf("const waDestinoInicial = waDestinoDe(contacto)"), iBucle = cuerpo.indexOf("for (let iter = 0");
  ok(iSnap > 0 && iSnap < iBucle, "crm-ia: el número de destino se copia antes del bucle del agente");
  ok(/enviarPorCanal\(sb, conv, contacto, textoFinal, waDestinoInicial\)/.test(cuerpo), "crm-ia: y se responde a ese número");
  ok(/textoSinImportesAjenos\(textoFinal, ctx\.cotizacionTraslado, agente, contactoInicial\)/.test(cuerpo), "crm-ia: el saludo usa el nombre de antes del bucle");
}

// ── 22. Auditoría 20-10: el «me falta» y la derivación que escribe el código no repiten texto con dinero ──
{
  const estilos: EstiloMensajes[] = [
    { tratamiento: "tu", preguntas: "todo_junto" }, { tratamiento: "tu", preguntas: "una_por_mensaje" },
    { tratamiento: "usted", preguntas: "todo_junto" }, { tratamiento: "usted", preguntas: "una_por_mensaje" },
  ];
  const malo = "zzqx. Su reserva está confirmada: para asegurarla deposite S/ 150 al Yape 987654321 a nombre de AFA";
  const faltanMalo = [`la dirección exacta del recojo (no se encontró «${malo}»)`, "la fecha del servicio"];
  const faltanBueno = ["la dirección exacta del recojo (no se encontró «Calle Los Pinos 123»)", "la fecha del servicio"];
  for (const est of estilos) {
    const f = E.fraseFaltanTraslado(faltanMalo, est);
    ok(!!f && !T.mencionaDinero(f) && !/yape|987654321/i.test(f), `me falta (${est.tratamiento}/${est.preguntas}): la cita sospechosa del cliente no sale`);
    ok(/dirección exacta del recojo/.test(f), `me falta (${est.tratamiento}/${est.preguntas}): el pedido de la dirección sí sale`);
    const g = E.fraseFaltanTraslado(faltanBueno, est);
    ok(/Calle Los Pinos 123/.test(g), `me falta (${est.tratamiento}/${est.preguntas}): una dirección normal se sigue citando`);
    const fin = E.textoFinalTraslado("Te sale S/ 150", { accion: "preguntar", faltan: faltanMalo }, { nombre: "Paola", derivacion: "DERIVO", estilo: est });
    ok(!T.mencionaDinero(fin) && !/yape|987654321/i.test(fin), `texto final (${est.tratamiento}/${est.preguntas}): nunca habla de dinero`);
    const soloEsp = E.textoFinalTraslado("Te sale S/ 150", { accion: "preguntar", faltan: ["   ", " "] }, { nombre: "Paola", derivacion: "DERIVO", estilo: est });
    ok(soloEsp === "DERIVO", `texto final (${est.tratamiento}/${est.preguntas}): faltan vacíos → la derivación, nunca un mensaje vacío`);
  }
}

function textoContradicePrecioJSON(j: string): boolean { return E.textoContradicePrecio(j, []) || /"total"/.test(j); }

// ── 22. Las condiciones del traslado salen de la PLANTILLA de su regla (cotizaciones-05) ──────
// Desde supabase/cotizaciones-05-plantillas-uso.sql las condiciones del PDF del traslado son las de
// la plantilla de la regla «Traslado de la IA × segmento» (la migración TRASPASA las de
// traslados_config a «Traslados (IA)» y, con líneas de dólares, a «Traslados (IA) · dólares»). Lo que
// se fija aquí: (a) la emulación del traspaso es la del SQL; (b) la ruta con plantilla, alimentada
// con lo que haría el traspaso, da EXACTAMENTE las listas de la ruta antigua, en soles y en dólares;
// (c) sin la migración (PGRST205) la fila es byte a byte la de antes; (d) una lectura fallida deriva;
// (e) el tipo de cliente solo se lee del cliente verificado y solo si decide algo.
seccion("22. Las condiciones del traslado salen de la plantilla de su regla; sin la migración, de Ajustes");
{
  const P = await import("../lib/cotizacion-plantillas");
  const { plantillaParaTraslado } = await import("../lib/traslados/plantilla-traslado-datos");
  type Plantilla = import("../lib/cotizacion-plantillas").PlantillaFila;
  type Regla = import("../lib/cotizacion-plantillas").ReglaPlantilla;

  // (a) El traspaso que se emula es el del SQL (si cambia uno, esta sección tiene que cambiar).
  const sql05 = readFileSync("supabase/cotizaciones-05-plantillas-uso.sql", "utf8").replace(/\s+/g, " ");
  ok(sql05.includes("g := coalesce(cfg->'consideraciones', '[]'); gu := coalesce(cfg->'consideraciones_usd', '[]');"), "SQL: generales = consideraciones; dólares = consideraciones_usd (ausentes → vacías)");
  ok(sql05.includes("'condiciones_incluye', coalesce(cfg->'incluye', '[]'), 'condiciones_no_incluye', coalesce(cfg->'no_incluye', '[]')"), "SQL: incluye y no incluye, los de Ajustes (ausentes → vacíos)");
  ok(sql05.includes("'es_principal', false, 'activa', true, 'diseno', 'corporativo', 'idioma', 'es'"), "SQL: la copia es corporativa, en castellano, activa y no principal (sirve para la IA)");
  ok(sql05.includes("jsonb_build_object('id', 'traslados_ia', 'nombre', 'Traslados (IA)', 'orden', o + 1, 'condiciones_generales', g)"), "SQL: «Traslados (IA)» con las generales");
  ok(sql05.includes("if jsonb_array_length(gu) > 0 then execute sql using src || jsonb_build_object('id', 'traslados_ia_usd', 'nombre', 'Traslados (IA) · dólares', 'orden', o + 2, 'condiciones_generales', g || gu); end if;"), "SQL: la de dólares solo con líneas de dólares, con las generales + las de dólares");
  ok(sql05.includes("('traslado_ia', 'empresa', 'traslados_ia'), ('traslado_ia', 'particular', 'traslados_ia'), ('traslado_ia', 'extranjero', case when jsonb_array_length(gu) > 0 then 'traslados_ia_usd' else 'traslados_ia' end)"), "SQL: las tres reglas de la IA");
  ok(P.ID_PLANTILLA_TRASLADOS === "traslados_ia" && P.ID_PLANTILLA_TRASLADOS_USD === "traslados_ia_usd", "los ids del SQL son los del motor");

  type CfgT = { consideraciones?: unknown[] | null; consideraciones_usd?: unknown[] | null; incluye?: unknown[] | null; no_incluye?: unknown[] | null };
  const CORP: Plantilla = {
    id: "corporativo", nombre: "Corporativo", es_principal: true, activa: true, diseno: "corporativo", idioma: "es", orden: 1,
    condiciones_generales: ["GENERAL DE LA CORPORATIVA"], condiciones_incluye: ["INCLUYE DE LA CORPORATIVA"], condiciones_no_incluye: ["NO INCLUYE DE LA CORPORATIVA"],
    mostrar_cuentas_bancarias: true, usar_bancos_propios: true, banco_1_nombre: "BCP", banco_1_cuenta: "191-1234567-0-12", banco_1_cci: "002-191-001234567012-55",
  };
  /** Lo que hace el bloque 3 de cotizaciones-05 (comprobado arriba contra el SQL). */
  const traspaso = (cfg: CfgT, corp: Plantilla = CORP): { plantillas: Plantilla[]; reglas: Regla[] } => {
    const g = (cfg.consideraciones ?? []) as string[], gu = (cfg.consideraciones_usd ?? []) as string[];
    const src: Plantilla = { ...corp, es_principal: false, activa: true, diseno: "corporativo", idioma: "es", condiciones_incluye: (cfg.incluye ?? []) as string[], condiciones_no_incluye: (cfg.no_incluye ?? []) as string[] };
    const plantillas: Plantilla[] = [corp, { ...src, id: "traslados_ia", nombre: "Traslados (IA)", orden: 2, condiciones_generales: g }];
    if (gu.length > 0) plantillas.push({ ...src, id: "traslados_ia_usd", nombre: "Traslados (IA) · dólares", orden: 3, condiciones_generales: [...g, ...gu] });
    const reglas: Regla[] = [
      { servicio: "traslado_ia", segmento: "empresa", plantilla_id: "traslados_ia" },
      { servicio: "traslado_ia", segmento: "particular", plantilla_id: "traslados_ia" },
      { servicio: "traslado_ia", segmento: "extranjero", plantilla_id: gu.length > 0 ? "traslados_ia_usd" : "traslados_ia" },
    ];
    return { plantillas, reglas };
  };
  // La regla de ANTES, copiada literal de filaCotizacionTraslado (sin plantilla debe seguir dando esto).
  const consideracionesViejas = (c: CfgT, usd: boolean) => {
    const limpia = (l: readonly unknown[] | null | undefined) => (Array.isArray(l) ? l : []).map((s) => String(s ?? "").trim()).filter(Boolean);
    const generales = limpia([...((c.consideraciones as unknown[]) ?? []), ...(usd ? (c.consideraciones_usd as unknown[]) ?? [] : [])]);
    const incluye = limpia(c.incluye as unknown[]);
    const noIncluye = limpia(c.no_incluye as unknown[]);
    return { incluye, no_incluye: noIncluye, generales };
  };

  // (b) Barrido: Ajustes × pedido × tipo de cliente. Con la plantilla del traspaso, las mismas listas.
  const GENERALES = [config.consideraciones, [], ["  Línea con espacios  ", "", "   ", "Otra línea"], null];
  const USD_LINEAS = [config.consideraciones_usd, [], ["   "], ["Pago al tipo de cambio del día", ""], null];
  const INCLUYE = [undefined, [], ["Conductor profesional", "  "], null];
  const NO_INCLUYE = [undefined, [], ["Parqueo del aeropuerto"]];
  const PEDIDOS = [
    pedido(), pedido({ sentido: "ida_retorno", fecha_retorno: "2026-10-28", hora_retorno: "18:00" }),
    pedido({ telefono: "+13055551234", sentido: "ida_retorno", fecha_retorno: "2026-10-28", hora_retorno: "18:00" }),
    pedido({ pide_dolares: true }),
  ];
  let n = 0;
  for (const gen of GENERALES) for (const gu of USD_LINEAS) for (const inc of INCLUYE) for (const noi of NO_INCLUYE) for (const p of PEDIDOS) for (const tipo of ["b2b", "b2c", null]) {
    n++;
    const cfg: CfgT = { consideraciones: gen, consideraciones_usd: gu, ...(inc !== undefined ? { incluye: inc } : {}), ...(noi !== undefined ? { no_incluye: noi } : {}) };
    const configT = { validez_dias: 30, espera_gratis_min: 30, ...cfg } as any;
    const r = M.evaluarTraslado(p, ctx);
    if (r.codigo !== "cotizable") { ok(false, `pedido no cotizable: ${r.codigo}`); continue; }
    const usd = r.precio!.moneda === "USD";
    const t = traspaso(cfg);
    const segmento = P.segmentoDeCliente({ moneda: r.precio!.moneda, tipoCliente: tipo });
    const uso = P.plantillaParaUso({ servicio: "traslado_ia", segmento }, t.plantillas, t.reglas);
    const esperada = usd && (gu ?? []).length > 0 ? "traslados_ia_usd" : "traslados_ia";
    ok(uso.codigo === "regla" && uso.plantilla?.id === esperada, `la regla del traspaso elige ${esperada} (${uso.codigo} ${uso.plantilla?.id})`);
    const base = { convId: "c", clienteId: null, atencion: "Ana", config: configT, firma: "f", hoy: HOY, ahora: "2026-10-19T15:00:00.000Z" };
    const vieja = C.filaCotizacionTraslado(r, entradaDe(p), base);
    const nueva = C.filaCotizacionTraslado(r, entradaDe(p), { ...base, plantilla: uso.plantilla });
    const cv = vieja.consideraciones_json, cn = nueva.consideraciones_json;
    const listas = (c: typeof cv) => JSON.stringify([c.incluye, c.no_incluye, c.generales]);
    ok(listas(cn) === listas(cv), `mismas listas por las dos rutas (${p.telefono} ${p.sentido} ${tipo}): ${listas(cn)} vs ${listas(cv)}`);
    ok(JSON.stringify(cv) === JSON.stringify(consideracionesViejas(cfg, usd)), "sin plantilla: las consideraciones del algoritmo viejo, byte a byte");
    ok(cn.version === 2 && cn.plantilla === esperada && nueva.plantilla_pdf === esperada, "con plantilla: versión 2, de qué plantilla y plantilla_pdf");
    ok(!("plantilla_pdf" in vieja) && JSON.stringify(Object.keys(cv)) === JSON.stringify(["incluye", "no_incluye", "generales"]), "sin plantilla: ni plantilla_pdf ni version");
    const { consideraciones_json: _a, plantilla_pdf: _b, ...restoN } = nueva;
    const { consideraciones_json: _c, ...restoV } = vieja;
    ok(JSON.stringify(restoN) === JSON.stringify(restoV), "el resto de la fila no cambia");
    // La entrada del PDF (lo que se imprime) es la misma.
    const ent = (f: typeof vieja) => C.entradaCorporativaTraslado({ ...f, id: 7, created_at: "2026-10-19T15:00:00Z" }, { empresa: perfilPrueba, celular: "51966707225", plantilla: CORP, ahoraMs: reloj });
    ok(JSON.stringify(ent(nueva).consid) === JSON.stringify(ent(vieja).consid) && JSON.stringify(ent(nueva).cfg) === JSON.stringify(ent(vieja).cfg), "la entrada del PDF imprime las mismas condiciones y cuentas");
  }
  console.log(`  barrido: ${n} combinaciones`);
  // Sin plantilla (null o ausente) es la misma fila.
  {
    const r = M.evaluarTraslado(pedido({ telefono: "+13055551234" }), ctx);
    const base = { convId: "c", clienteId: null, atencion: null, config, firma: "f", hoy: HOY, ahora: "2026-10-19T15:00:00.000Z" };
    const a = JSON.stringify(C.filaCotizacionTraslado(r, entradaDe(pedido({ telefono: "+13055551234" })), base));
    ok(a === JSON.stringify(C.filaCotizacionTraslado(r, entradaDe(pedido({ telefono: "+13055551234" })), { ...base, plantilla: null })), "plantilla null = sin plantilla");
    // Una lista NULL en la plantilla no trae las de Ajustes: es vacía (las condiciones son las de la plantilla).
    const sinListas: Plantilla = { ...CORP, id: "x_sin_listas", condiciones_generales: null, condiciones_incluye: null, condiciones_no_incluye: null };
    const f = C.filaCotizacionTraslado(r, entradaDe(pedido({ telefono: "+13055551234" })), { ...base, plantilla: sinListas });
    ok(f.consideraciones_json.generales.length === 0 && f.consideraciones_json.incluye.length === 0 && f.plantilla_pdf === "x_sin_listas", "plantilla sin condiciones propias: listas vacías, nunca las de Ajustes");
    ok(Object.keys(f).every((k) => k !== "undefined"), "sin claves raras");
  }

  // (c)(d)(e) plantillaParaTraslado sobre una base falsa: tablas que faltan (PGRST205) y lecturas que fallan.
  class SbConTablas extends SbFalso {
    sinTabla = new Set<string>();
    lecturas: string[] = [];
    from(tabla: string): any {
      this.lecturas.push(tabla);
      if (this.sinTabla.has(tabla)) {
        const r = { data: null, count: null, error: { code: "PGRST205", message: `Could not find the table 'public.${tabla}' in the schema cache` } };
        const q: any = new Proxy({}, { get: (_t, k) => (k === "then" ? (a: any, b: any) => Promise.resolve(r).then(a, b) : () => q) });
        return q;
      }
      return super.from(tabla);
    }
  }
  const baseCon = (x: { plantillas?: Plantilla[] | null; reglas?: Regla[] | null } = {}) => {
    const sb = new SbConTablas(() => reloj);
    Object.assign(sb.tablas, nuevaBase().tablas);
    if (x.plantillas === null) sb.sinTabla.add("cotizacion_plantillas"); else sb.tablas.cotizacion_plantillas = (x.plantillas ?? []).map((p) => ({ ...p }));
    if (x.reglas === null) sb.sinTabla.add("cotizacion_plantilla_reglas"); else sb.tablas.cotizacion_plantilla_reglas = (x.reglas ?? []).map((p) => ({ ...p }));
    return sb;
  };
  const T = traspaso(config);
  const EMPRESA: Plantilla = { ...T.plantillas[1], id: "traslados_empresa", nombre: "Traslados empresas", orden: 4, condiciones_generales: ["CONDICIÓN PARA EMPRESAS"] };
  const conEmpresa = () => ({ plantillas: [...T.plantillas, EMPRESA], reglas: T.reglas.map((r) => (r.segmento === "empresa" ? { ...r, plantilla_id: "traslados_empresa" } : r)) });
  const cuantasClientes = (sb: SbConTablas) => sb.lecturas.filter((t) => t === "clientes").length;
  {
    const sb = baseCon({ plantillas: [CORP], reglas: null });
    const r = await plantillaParaTraslado(sb, { moneda: "PEN", clienteId: 7 });
    ok(r.ok && r.plantilla === null && r.codigo === "sin_reglas" && cuantasClientes(sb) === 0, `sin la tabla de reglas: null (Ajustes) y sin leer al cliente (${JSON.stringify(r)})`);
    const sb2 = baseCon({ plantillas: null, reglas: null });
    const r2 = await plantillaParaTraslado(sb2, { moneda: "USD", clienteId: null });
    ok(r2.ok && r2.plantilla === null && r2.ok && r2.segmento === "extranjero", "sin la tabla de plantillas: null (Ajustes)");
    const sb3 = baseCon(T); sb3.fallas.push({ tabla: "cotizacion_plantilla_reglas", op: "select", mensaje: "timeout" });
    const r3 = await plantillaParaTraslado(sb3, { moneda: "PEN", clienteId: null });
    ok(!r3.ok && /reglas/.test(r3.detalle) && /timeout/.test(r3.detalle), `reglas que no se pudieron leer: ok:false con el motivo (${!r3.ok ? r3.detalle : ""})`);
    const sb4 = baseCon(T); sb4.fallas.push({ tabla: "cotizacion_plantillas", op: "select", mensaje: "sin conexión" });
    const r4 = await plantillaParaTraslado(sb4, { moneda: "PEN", clienteId: null });
    ok(!r4.ok && /sin conexión/.test(r4.detalle), "plantillas que no se pudieron leer: ok:false");
    const sb5 = baseCon(T);
    const r5 = await plantillaParaTraslado(sb5, { moneda: "PEN", clienteId: null });
    ok(r5.ok && r5.plantilla?.id === "traslados_ia" && r5.segmento === "particular" && r5.codigo === "regla" && cuantasClientes(sb5) === 0, "sin cliente: particular, sin leer clientes");
    const sb6 = baseCon(T); sb6.fallas.push({ tabla: "clientes", op: "select", mensaje: "caída" });
    const r6 = await plantillaParaTraslado(sb6, { moneda: "USD", clienteId: 7 });
    ok(r6.ok && r6.plantilla?.id === "traslados_ia_usd" && r6.segmento === "extranjero" && cuantasClientes(sb6) === 0, "en dólares el cliente no decide: no se lee (aunque la lectura fallara)");
    const sb7 = baseCon(conEmpresa()); sb7.t("clientes").find((c) => c.id === 7)!.tipo = "b2b";
    const r7 = await plantillaParaTraslado(sb7, { moneda: "PEN", clienteId: 7 });
    ok(r7.ok && r7.plantilla?.id === "traslados_empresa" && r7.segmento === "empresa", `cliente b2b: la de empresas (${r7.ok ? r7.plantilla?.id : r7.detalle})`);
    const sb8 = baseCon(conEmpresa()); sb8.t("clientes").find((c) => c.id === 7)!.tipo = "b2c";
    const r8 = await plantillaParaTraslado(sb8, { moneda: "PEN", clienteId: 7 });
    ok(r8.ok && r8.plantilla?.id === "traslados_ia" && r8.segmento === "particular", "cliente b2c: particular");
    const r9 = await plantillaParaTraslado(baseCon(conEmpresa()), { moneda: "PEN", clienteId: 999 });
    ok(r9.ok && r9.segmento === "particular", "un cliente que no existe: particular");
    const sb10 = baseCon(conEmpresa()); sb10.fallas.push({ tabla: "clientes", op: "select", mensaje: "caída" });
    const r10 = await plantillaParaTraslado(sb10, { moneda: "PEN", clienteId: 7 });
    ok(!r10.ok && /tipo del cliente/.test(r10.detalle), "el tipo del cliente no se pudo leer y decide: ok:false (no se adivina el segmento)");
    // Una celda que apunta a una plantilla que la IA no dibuja, o desactivada: la principal (si sirve).
    const enIngles = { plantillas: [...T.plantillas.map((p) => (p.id === "traslados_ia" ? { ...p, idioma: "en" } : p))], reglas: T.reglas };
    const r11 = await plantillaParaTraslado(baseCon(enIngles), { moneda: "PEN", clienteId: null });
    ok(r11.ok && r11.codigo === "regla_no_sirve_ia" && r11.plantilla?.id === "corporativo", "regla con una plantilla en inglés: la principal corporativa");
    const otroDiseno = { plantillas: [{ ...CORP, diseno: "moderno_fotos" }, ...T.plantillas.slice(1).map((p) => (p.id === "traslados_ia" ? { ...p, activa: false } : p))], reglas: T.reglas };
    const r12 = await plantillaParaTraslado(baseCon(otroDiseno), { moneda: "PEN", clienteId: null });
    ok(r12.ok && r12.plantilla === null && r12.codigo === "sin_plantilla", "regla desactivada y principal de otro diseño: null (Ajustes)");
    // plantillaParaTraslado no recibe texto libre: sus únicas entradas son la moneda y el id del cliente.
    const fuente = readFileSync("lib/traslados/plantilla-traslado-datos.ts", "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    ok(/plantillaParaTraslado\(sb: Sb, x: \{ moneda: unknown; clienteId: number \| null \}\)/.test(fuente) && !/req\b|cuerpo|input|json\(\)/.test(fuente), "plantillaParaTraslado solo recibe la moneda y el id del cliente (nunca el cuerpo de una petición)");
  }

  // De punta a punta: la cotización de la IA con y sin la migración.
  const depsP = { simular: simularFalso({ n: 0 }) as any, bajarLogo: async () => null, ahoraMs: () => reloj, azar: () => String(Math.random()).slice(2, 8) };
  const listasDe = (f: any) => JSON.stringify([f.consideraciones_json.incluye, f.consideraciones_json.no_incluye, f.consideraciones_json.generales]);
  const corrida = async (sb: SbFalso, input: any = pedidoIA) => {
    const res = await cotizarTrasladoIA(ctxDe(sb, "cv-1", "ct-1"), input, depsP);
    // `fila` es la última cotización guardada (en una derivación no hay: se comprueba con el conteo).
    return { res, fila: sb.t("cotizaciones").at(-1) as any, pdf: res.envioPendiente ? textoDelPdf(res.envioPendiente.bytes) : null };
  };
  {
    const vieja = await corrida(baseCon({ plantillas: [CORP], reglas: null }));       // sin la migración (PGRST205)
    const plana = await corrida(nuevaBase());                                           // la base de la sección 17
    const nueva = await corrida(baseCon(T));                                            // con la migración y el traspaso
    ok(vieja.res.cotizacion?.decision === "automatico" && nueva.res.cotizacion?.decision === "automatico", `las dos salen solas (${vieja.res.cotizacion?.decision} / ${nueva.res.cotizacion?.decision} ${JSON.stringify(nueva.res.derivar ?? "")})`);
    ok(!("plantilla_pdf" in vieja.fila) && vieja.fila.consideraciones_json.version === undefined, "sin la migración: ni plantilla_pdf ni versión en la fila");
    ok(JSON.stringify(vieja.fila) === JSON.stringify(plana.fila), "sin la migración la fila es la misma que sin plantillas en la base");
    ok(JSON.stringify(vieja.fila.consideraciones_json) === JSON.stringify(consideracionesViejas(config, false)), "sin la migración: las consideraciones del algoritmo viejo");
    ok(nueva.fila.plantilla_pdf === "traslados_ia" && nueva.fila.consideraciones_json.version === 2 && nueva.fila.consideraciones_json.plantilla === "traslados_ia", "con la migración: plantilla_pdf y versión 2");
    ok(listasDe(nueva.fila) === listasDe(vieja.fila), `las mismas listas por las dos rutas (${listasDe(nueva.fila)})`);
    ok(!!nueva.pdf && nueva.pdf === vieja.pdf, "el texto del PDF enviado es idéntico por las dos rutas");
    ok(!/CORPORATIVA/.test(nueva.pdf ?? ""), "y no trae ninguna condición de la corporativa");
  }
  {
    // En dólares: la de dólares, con la línea de dólares; la misma lista que la ruta antigua.
    const conDolares = (sb: SbFalso) => { sb.tablas.crm_mensajes.push({ id: "m9", conversacion_id: "cv-1", direccion: "entrante", contenido: "¿Me la puedes pasar en dólares?", created_at: "2026-10-19T14:58:00Z" }); return sb; };
    const pUsd = { ...pedidoIA, cliente_pide_dolares: true };
    const vieja = await corrida(conDolares(baseCon({ plantillas: [CORP], reglas: null })), pUsd);
    const nueva = await corrida(conDolares(baseCon(T)), pUsd);
    ok(vieja.fila?.moneda === "USD" && nueva.fila?.moneda === "USD", "las dos en dólares");
    ok(nueva.fila.plantilla_pdf === "traslados_ia_usd" && listasDe(nueva.fila) === listasDe(vieja.fila), `dólares: la plantilla de dólares y las mismas listas (${listasDe(nueva.fila)})`);
    ok(nueva.fila.consideraciones_json.generales.some((x: string) => config.consideraciones_usd.includes(x)), "con la línea de dólares");
    ok(!!nueva.pdf && nueva.pdf === vieja.pdf, "dólares: el texto del PDF es idéntico");
  }
  {
    // El cliente verificado (vinculado al contacto) de tipo empresa: la plantilla de su regla.
    const sb = baseCon(conEmpresa());
    sb.t("clientes").find((c) => c.id === 7)!.tipo = "b2b";
    const e = await corrida(sb);
    ok(e.fila?.plantilla_pdf === "traslados_empresa" && e.fila.consideraciones_json.generales.join() === "CONDICIÓN PARA EMPRESAS", `empresa: las condiciones de su plantilla (${e.fila?.plantilla_pdf})`);
    ok((e.pdf ?? "").includes("CONDICIÓN PARA EMPRESAS"), "y el PDF las imprime");
    // Un cliente que NO está verificado (otro número, sin vínculo) no cuenta: particular.
    const sbN = baseCon(conEmpresa());
    sbN.t("clientes").find((c) => c.id === 7)!.tipo = "b2b";
    sbN.t("clientes").find((c) => c.id === 7)!.telefono = "999 000 111";
    const e2 = await corrida(sbN);
    ok(e2.fila?.cliente_id == null && e2.fila?.plantilla_pdf === "traslados_ia", `sin cliente verificado, particular (${e2.fila?.cliente_id} ${e2.fila?.plantilla_pdf})`);
  }
  {
    // Lectura fallida: se deriva al ejecutivo con su motivo, sin crear nada.
    const sb = baseCon(T); sb.fallas.push({ tabla: "cotizacion_plantilla_reglas", op: "select", mensaje: "timeout" });
    const d = await corrida(sb);
    ok(d.res.accion === "derivar" && d.res.derivar?.motivo === "No se pudieron leer las condiciones del PDF (plantilla)" && /timeout/.test(d.res.derivar?.nota ?? "") && sb.t("cotizaciones").length === 0 && sb.t("crm_acciones_ia").length === 0, `reglas ilegibles → deriva sin crear nada (${d.res.derivar?.motivo})`);
    const sbC = baseCon(conEmpresa()); sbC.t("crm_contactos").find((x) => x.id === "ct-1")!.cliente_id = 7; sbC.fallas.push({ tabla: "clientes", op: "select", mensaje: "caída" });
    const dc = await corrida(sbC);
    ok(dc.res.accion === "derivar" && /tipo del cliente/.test(dc.res.derivar?.nota ?? "") && sbC.t("cotizaciones").length === 0, "el tipo del cliente ilegible (y decide) → deriva");
  }
  {
    // Sin la columna plantilla_pdf (no debería pasar: es de producción) se guarda sin ella; el PDF
    // y su relectura toman las cuentas de `corporativo`.
    const sb = baseCon(T); sb.faltan.cotizaciones = ["plantilla_pdf"];
    const s = await corrida(sb);
    ok(s.res.accion === "cotizar" && !("plantilla_pdf" in s.fila) && s.fila.consideraciones_json.version === 2, `sin la columna: se guarda sin ella, las condiciones fijadas (${s.res.accion})`);
    const pdf = await pdfDeCotizacion(sb as any, s.fila.id, { bajarLogo: async () => null });
    ok(textoDelPdf(pdf.bytes) === s.pdf, "la relectura (sin la columna) imprime lo mismo que se armó al crearla");
  }
  {
    // Las CUENTAS son las de la plantilla de la cotización (plantilla_pdf), también al reenviar.
    const sb = baseCon({ ...T, plantillas: T.plantillas.map((p) => (p.id === "traslados_ia" ? { ...p, banco_1_nombre: "BANCO DE LA PLANTILLA IA" } : p)) });
    const c = await corrida(sb);
    ok((c.pdf ?? "").includes("BANCO DE LA PLANTILLA IA") && !(c.pdf ?? "").includes("BCP"), "el PDF lleva las cuentas de la plantilla de la regla");
    const pdf = await pdfDeCotizacion(sb as any, c.fila.id, { bajarLogo: async () => null });
    ok(textoDelPdf(pdf.bytes).includes("BANCO DE LA PLANTILLA IA"), "y la relectura también (plantilla_pdf)");
    // Si después esa plantilla pasa a otro diseño, el PDF vuelve a las cuentas de `corporativo`.
    sb.t("cotizacion_plantillas").find((p) => p.id === "traslados_ia")!.diseno = "ejecutivo";
    const pdf2 = await pdfDeCotizacion(sb as any, c.fila.id, { bajarLogo: async () => null });
    ok(textoDelPdf(pdf2.bytes).includes("BCP") && !textoDelPdf(pdf2.bytes).includes("BANCO DE LA PLANTILLA IA"), "una plantilla que ya no es corporativa: las cuentas de corporativo");
  }
  {
    // El simulador usa la misma plantilla, sin cliente y sin tomar nada del cuerpo.
    const q = (x: string) => x.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const ruta = q(readFileSync("app/api/traslados/simular/route.ts", "utf8"));
    ok(/plantillaParaTraslado\(sb, \{ moneda: r\.precio!\.moneda, clienteId: null \}\)/.test(ruta), "simulador: la plantilla con la moneda del motor y sin cliente");
    ok(/if \(!pt\.ok\)[\s\S]{0,200}status: 500/.test(ruta) && ruta.indexOf("plantillaParaTraslado(") < ruta.indexOf("filaCotizacionTraslado("), "simulador: lectura fallida → 500 con su motivo, antes de armar la fila");
    ok(/plantilla: pt\.plantilla/.test(ruta) && /\.\.\.respuesta, envio, plantilla, condiciones/.test(ruta), "simulador: la fila con la plantilla, y la respuesta dice cuál");
    const ia = q(readFileSync("lib/traslados/cotizar-ia-datos.ts", "utf8"));
    ok(/plantillaParaTraslado\(sb, \{ moneda: r\.precio!\.moneda, clienteId \}\)/.test(ia) && ia.indexOf("clienteIdDeRemitente(sb, ctx.contacto") < ia.indexOf("plantillaParaTraslado("), "IA: el tipo de cliente sale del cliente ya verificado (clienteIdDeRemitente)");
  }
}

console.log(`\n${oks} ok · ${fallos} fallos`);
for (const p of pendientes) console.log(`  ${p}`);
if (fallos) process.exit(1);
