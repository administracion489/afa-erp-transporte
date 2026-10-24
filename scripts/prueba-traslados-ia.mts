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
  // Revisión de seguridad (23-10-2026, hallazgo 5, DECLARADO): el decimotercero es `editada_a_mano`.
  ok(Object.keys(E.MOTIVO_REVISION).length === 13 && Object.values(E.MOTIVO_REVISION).every((m) => m.texto && m.arreglo) && "editada_a_mano" in E.MOTIVO_REVISION, "trece motivos, cada uno con su arreglo (el último, editada_a_mano)");
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
  // ADAPTADA (21-10-2026): el mensaje de la cotización ya no saluda ni lleva el nombre del perfil.
  const auto = E.mensajeCotizacionCodigo({ numero: "00123", decision: "automatico", total: "S/ 118.00", validez: "18/11/2026", estilo: TU });
  ok(auto.includes("00123") && auto.includes("S/ 118.00") && auto.includes("18/11/2026") && auto.startsWith("Te envío") && !/hola/i.test(auto) && !E.textoContradicePrecio(auto, [118]), `mensaje automático: ${auto}`);
  ok(/ejecutivo/.test(auto), "y dice que la disponibilidad la confirma un ejecutivo");
  const rev = E.mensajeCotizacionCodigo({ numero: "00124", decision: "revision", total: "S/ 118.00", estilo: TU });
  ok(rev.includes("00124") && !E.textoContradicePrecio(rev, []) && rev.startsWith("Registré") && !/hola/i.test(rev), `mensaje en revisión sin importes: ${rev}`);
}

// ── 10b. Los textos del código, con el trato y el modo de preguntar del agente ───
seccion("10b. mensajeCotizacionCodigo y fraseFaltanTraslado leen el estilo del agente");
{
  const L = "La disponibilidad de la unidad y la reserva del servicio las confirma un ejecutivo.";
  const base = { numero: "00123", total: "S/ 118.00", validez: "18/11/2026" };
  // ADAPTADA (21-10-2026): sin «Hola {nombre},». Llega a mitad de la conversación, cuando la IA ya
  // saludó, y el nombre era el del perfil de WhatsApp («Hola Atencion,» en la prueba del dueño).
  const LIT_TU = {
    auto: `Te envío la cotización N° 00123 de tu traslado. El total es S/ 118.00 (IGV incluido), válida hasta el 18/11/2026. ${L}`,
    ya: `La cotización N° 00123 de tu traslado ya te la envié por este chat. El total es S/ 118.00 (IGV incluido), válida hasta el 18/11/2026. ${L}`,
    rev: "Registré tu pedido de traslado con la cotización N° 00123. Un ejecutivo la revisa y te la envía por este chat en breve.",
  };
  const LIT_USTED = {
    auto: `Le envío la cotización N° 00123 de su traslado. El total es S/ 118.00 (IGV incluido), válida hasta el 18/11/2026. ${L}`,
    ya: `La cotización N° 00123 de su traslado ya se la envié por este chat. El total es S/ 118.00 (IGV incluido), válida hasta el 18/11/2026. ${L}`,
    rev: "Registré su pedido de traslado con la cotización N° 00123. Un ejecutivo la revisa y se la envía por este chat en breve.",
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
  ok(E.mensajeCotizacionCodigo({ numero: "9", decision: "automatico", estilo: { tratamiento: "usted", preguntas: "todo_junto" } }) === `Le envío la cotización N° 9 de su traslado. ${L}`, "usted sin cifras");
  ok(E.mensajeCotizacionCodigo({ numero: "9", decision: "automatico", validez: "1/1/2027", estilo: TU }) === `Te envío la cotización N° 9 de tu traslado. La cotización es válida hasta el 1/1/2027. ${L}`, "tú solo con validez");
  // Un llamador en JS sin estilo: el defecto del ajuste (usted), nunca un texto roto. Un `nombre`
  // que todavía pase un llamador viejo no entra en el texto.
  ok((E.mensajeCotizacionCodigo as any)({ nombre: "Ana", numero: "1", decision: "revision" }) === "Registré su pedido de traslado con la cotización N° 1. Un ejecutivo la revisa y se la envía por este chat en breve.", "sin estilo → de usted (el defecto), sin el nombre");

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
  /** El `condiciones_token` que la base le pone a una cotización nueva (cotizaciones-08); null = no lo pone. */
  tokenCot: string | null = null;
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
  cols = "*"; colsRet = ""; head = false; contar = false; ret = false;
  filtros: ((f: FilaF) => boolean)[] = [];
  orden: { c: string; asc: boolean } | null = null;
  desde = 0; hasta = Infinity; uno: "single" | "maybe" | null = null; payload: any = null;
  constructor(private sb: SbFalso, private tabla: string) {}
  select(cols = "*", o?: { count?: string; head?: boolean }) {
    if (this.op === "select") { this.cols = cols; this.contar = !!o?.count; this.head = !!o?.head; } else { this.ret = true; this.colsRet = cols; }
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
    // La regla del traslado por idioma × moneda (cotizaciones-09) NO existe salvo que la base de la
    // prueba la siembre: es el estado de producción hasta que alguien corra el SQL (PGRST205).
    if (this.tabla === "cotizacion_plantilla_reglas_traslado" && !Object.prototype.hasOwnProperty.call(this.sb.tablas, this.tabla)) {
      return { data: null, count: null, error: { code: "PGRST205", message: `Could not find the table 'public.${this.tabla}' in the schema cache` } };
    }
    const sb = this.sb, tabla = this.tabla, filas = sb.t(tabla);
    const falla = sb.fallas.find((x) => x.tabla === tabla && x.op === this.op);
    if (falla) return { data: null, count: null, error: { message: falla.mensaje } };
    const faltan = sb.faltan[tabla] ?? [];
    const colsPedidas = this.cols.replace(/\w+\([^)]*\)/g, "").split(",").map((x) => x.trim()).filter((x) => x && x !== "*");
    // En un insert/update con `.select(...)`, una columna que falta en lo que se devuelve también lo
    // rechaza entero (es una sola sentencia: no se escribe nada).
    const colsDevueltas = this.colsRet.split(",").map((x) => x.trim()).filter((x) => x && x !== "*");
    const malRet = this.op !== "select" ? colsDevueltas.find((c) => faltan.includes(c)) : undefined;
    if (malRet) return { data: null, error: { code: "42703", message: `column ${tabla}.${malRet} does not exist` } };
    const malCol = this.op === "select" ? colsPedidas.find((c) => faltan.includes(c)) : Object.keys(this.payload ?? {}).find((c) => faltan.includes(c));
    if (malCol) return this.op === "select"
      ? { data: null, error: { code: "42703", message: `column ${tabla}.${malCol} does not exist` } }
      : { data: null, error: { code: "PGRST204", message: `Could not find the '${malCol}' column of '${tabla}' in the schema cache` } };
    const ahora = new Date(sb.reloj()).toISOString();
    if (this.op === "insert") {
      const fila: FilaF = { ...this.payload };
      fila.id ??= tabla === "cotizaciones" ? 100 + ++sb.n : `00000000-0000-4000-8000-${String(++sb.n).padStart(12, "0")}`;
      if (tabla === "crm_acciones_ia") fila.creada_at ??= ahora; else fila.created_at ??= ahora;
      if (tabla === "cotizaciones" && sb.tokenCot && !faltan.includes("condiciones_token")) fila.condiciones_token ??= sb.tokenCot;
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
    idioma_cliente: e.idioma_cliente, pide_soles: e.pide_soles,
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
    ok(E.textoFinalTraslado("¿El retorno te sale gratis?", o2, { derivacion: "d", estilo: { tratamiento: "usted", preguntas: "una_por_mensaje" } }) === `Para cotizar su traslado, ¿me indica ${o2.faltan![0]}?`,
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
      const final = E.textoFinalTraslado(`Listo, ${destino}`, q, { derivacion: "Un ejecutivo te escribe.", estilo });
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
      ok(!/yape|987654321|hola/i.test(E.textoFinalTraslado("x", q, { derivacion: "d", estilo })), `Q2 (${nombreEstilo(estilo)}): el mensaje no lo usa (ni saluda)`);
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
    const final = E.textoFinalTraslado(f, t, { derivacion, estilo });
    if (t.cotizacion) {
      ok(final === E.mensajeCotizacionCodigo({ ...t.cotizacion, estilo }), `${ne} ${modo}: con cotización, SIEMPRE el texto del código («${f.slice(0, 30)}»)`);
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
    ok(E.textoFinalTraslado("Cuesta S/ 999", null, { derivacion, estilo }) === "Cuesta S/ 999", `${ne}: sin la herramienta en el turno, el texto no se toca`);
    ok(E.textoFinalTraslado("Cuesta S/ 999", { accion: "preguntar", faltan: [] }, { derivacion, estilo }) === derivacion, `${ne}: preguntar sin lista de faltantes: derivación`);
    // La cifra de una cotización EN DÓLARES no se cuela en una cotización en soles.
    const enSoles = E.textoFinalTraslado("Son US$283.20", { accion: "cotizar", cotizacion: cotAuto }, { derivacion, estilo });
    ok(!enSoles.includes("US$") && enSoles.includes("S/ 283.20") && /^(Te|Le) envío/.test(enSoles), `${ne}: en soles, el total en soles (${enSoles})`);
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
  ok(/textoSinImportesAjenos\(textoFinal, ctx\.cotizacionTraslado, agente, contactoInicial[,)]/.test(cuerpo), "crm-ia: el saludo usa el nombre de antes del bucle");
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
    const fin = E.textoFinalTraslado("Te sale S/ 150", { accion: "preguntar", faltan: faltanMalo }, { derivacion: "DERIVO", estilo: est });
    ok(!T.mencionaDinero(fin) && !/yape|987654321/i.test(fin), `texto final (${est.tratamiento}/${est.preguntas}): nunca habla de dinero`);
    const soloEsp = E.textoFinalTraslado("Te sale S/ 150", { accion: "preguntar", faltan: ["   ", " "] }, { derivacion: "DERIVO", estilo: est });
    ok(soloEsp === "DERIVO", `texto final (${est.tratamiento}/${est.preguntas}): faltan vacíos → la derivación, nunca un mensaje vacío`);
  }
}

function textoContradicePrecioJSON(j: string): boolean { return E.textoContradicePrecio(j, []) || /"total"/.test(j); }

// ── 23. Las condiciones del traslado salen de la PLANTILLA de su regla (cotizaciones-05) ──────
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
    // plantillaParaTraslado no recibe texto libre: sus únicas entradas son la moneda, el id del cliente
    // y el idioma (un enum que derivó el código: «es» | «en»).
    const fuente = readFileSync("lib/traslados/plantilla-traslado-datos.ts", "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    ok(/plantillaParaTraslado\(sb: Sb, x: \{ moneda: unknown; clienteId: number \| null; idioma\?: Idioma \}\)/.test(fuente) && !/req\b|cuerpo|input|json\(\)/.test(fuente)
      && /idioma: x\.idioma === "en" \? "en" : "es"/.test(fuente), "plantillaParaTraslado solo recibe la moneda, el id del cliente y el idioma como enum (nunca el cuerpo de una petición)");
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
    // Las CUENTAS son las de la plantilla de la cotización (plantilla_pdf), también al reenviar. Como
    // NO son las de `corporativo`, la IA no la envía sola (sección 23): el PDF se mira por la relectura.
    const sb = baseCon({ ...T, plantillas: T.plantillas.map((p) => (p.id === "traslados_ia" ? { ...p, banco_1_nombre: "BANCO DE LA PLANTILLA IA" } : p)) });
    const c = await corrida(sb);
    ok(c.res.cotizacion?.decision === "revision" && !c.res.envioPendiente, `cuentas de la plantilla distintas de corporativo: revisión (${c.res.cotizacion?.decision})`);
    const pdf = await pdfDeCotizacion(sb as any, c.fila.id, { bajarLogo: async () => null });
    ok(textoDelPdf(pdf.bytes).includes("BANCO DE LA PLANTILLA IA") && !textoDelPdf(pdf.bytes).includes("BCP"), "el PDF lleva las cuentas de la plantilla de la regla (relectura por plantilla_pdf)");
    // Si después esa plantilla pasa a otro diseño, el PDF vuelve a las cuentas de `corporativo`.
    sb.t("cotizacion_plantillas").find((p) => p.id === "traslados_ia")!.diseno = "ejecutivo";
    const pdf2 = await pdfDeCotizacion(sb as any, c.fila.id, { bajarLogo: async () => null });
    ok(textoDelPdf(pdf2.bytes).includes("BCP") && !textoDelPdf(pdf2.bytes).includes("BANCO DE LA PLANTILLA IA"), "una plantilla que ya no es corporativa: las cuentas de corporativo");
  }
  {
    // El simulador usa la misma plantilla, sin cliente y sin tomar nada del cuerpo.
    const q = (x: string) => x.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const ruta = q(readFileSync("app/api/traslados/simular/route.ts", "utf8"));
    // El idioma de la plantilla es el enum de la entrada que armó el servidor (la detección y el
    // interruptor de la IA), no un texto del cuerpo.
    ok(/plantillaParaTraslado\(sb, \{ moneda: r\.precio!\.moneda, clienteId: null, idioma: idiomaFila \}\)/.test(ruta)
      && /const idiomaFila: Idioma = entrada\.idioma_cliente \? "en" : "es"/.test(ruta) && /const entrada = sim\.entrada/.test(ruta),
      "simulador: la plantilla con la moneda del motor, sin cliente y con el idioma que decidió el código");
    ok(/if \(!pt\.ok\)[\s\S]{0,200}status: 500/.test(ruta) && ruta.indexOf("plantillaParaTraslado(") < ruta.indexOf("filaCotizacionTraslado("), "simulador: lectura fallida → 500 con su motivo, antes de armar la fila");
    ok(/plantilla: pt\.plantilla/.test(ruta) && /\.\.\.respuesta, envio, plantilla, condiciones/.test(ruta), "simulador: la fila con la plantilla, y la respuesta dice cuál");
    const ia = q(readFileSync("lib/traslados/cotizar-ia-datos.ts", "utf8"));
    ok(/plantillaParaTraslado\(sb, \{ moneda: r\.precio!\.moneda, clienteId, idioma: idiomaFila \}\)/.test(ia) && ia.indexOf("clienteIdDeRemitente(sb, ctx.contacto") < ia.indexOf("plantillaParaTraslado("), "IA: el tipo de cliente sale del cliente ya verificado (clienteIdDeRemitente)");
    ok(/const idiomaFila: Idioma = e\.idioma_cliente \? "en" : "es"/.test(ia) && /const v = validarEntrada\(entradaDelAgente\(/.test(ia) && /const e = v\.entrada/.test(ia),
      "IA: el idioma de la plantilla sale de la entrada con lista blanca (entradaDelAgente), nunca del input del modelo");
  }
}

// ── 23. Auditoría de seguridad de plantillas-uso: lo que la plantilla manda sin revisión ──────
// La plantilla de traslados la edita quien tiene el módulo Cotizaciones, y su PDF sale por WhatsApp
// sin revisión. Se fija: (a) una plantilla DESACTIVADA no presta sus cuentas (las de `corporativo`,
// como si no existiera); (b) cuentas de la plantilla distintas de las de `corporativo` (o sin poder
// comprobarlo) → revisión con `cuentas_distintas`; (c) una condición con un enlace o un número de 6+
// dígitos → revisión con `texto_libre_sospechoso` y la línea citada en la nota; una palabra de pago
// sola NO; (d) más de 30 líneas en una lista o una línea de más de 500 caracteres → revisión con
// `condiciones_demasiadas` (y el aviso del PDF); (e) el corolario: la plantilla normal sale sola.
seccion("23. Cuentas y condiciones de la plantilla de traslados: inactiva, distintas, sospechosas o desmesuradas");
{
  const P = await import("../lib/cotizacion-plantillas");
  const D = await import("../lib/traslados/enviar-cotizacion-datos");
  const PA = await import("../components/cotizaciones/plantillas/pantalla");
  type Plantilla = import("../lib/cotizacion-plantillas").PlantillaFila;

  // (1) Puro: qué deja la cotización para revisión mirando el PDF de su fila.
  const rev = (consid: unknown, avisos: { codigo: string }[] = []) => E.revisionPorCondiciones({ avisosPdf: avisos, consideraciones: consid });
  const cj = (generales: string[], extra: Record<string, unknown> = {}) => ({ incluye: [], no_incluye: [], generales, version: 2, plantilla: "traslados_ia", ...extra });
  ok(rev(cj(config.consideraciones)).motivos.length === 0, "las condiciones sembradas de AFA no dejan nada para revisión");
  ok(rev(cj([...config.consideraciones, ...config.consideraciones_usd])).motivos.length === 0, "tampoco las de dólares");
  const enl = rev(cj(["Reserve en www.pagos-traslados.com"]));
  ok(enl.motivos.join() === "texto_libre_sospechoso" && enl.lineas[0]?.linea === "Reserve en www.pagos-traslados.com" && enl.lineas[0].motivos.join() === "enlace", `una condición con un enlace → texto_libre_sospechoso, con la línea (${JSON.stringify(enl)})`);
  ok(rev(cj(["Más información: https://x.test/pagar"])).motivos.join() === "texto_libre_sospechoso", "https:// también");
  const num = rev({ incluye: ["Consultas al 987 654 321"], no_incluye: [], generales: [] });
  ok(num.motivos.join() === "texto_libre_sospechoso" && num.lineas[0].lista === "incluye" && num.lineas[0].motivos.join() === "numero_largo", "6+ dígitos (con espacios) en cualquier lista → revisión");
  ok(rev(cj(["Cuenta 191-1234567-0-12 a nombre de otra empresa"])).lineas[0]?.motivos.join() === "numero_largo", "un número de cuenta con guiones → revisión (la palabra de pago sola no cuenta, el número sí)");
  for (const l of ["El pago del parqueo corre por cuenta del pasajero.", "Pago por Yape o Plin al confirmar.", "Depósito en cuenta del 50 % para reservar.", "Válido hasta el 31/12/2026 a las 18:00.", "No incluyen IGV (18 %).", "Hasta 30 minutos de espera."]) {
    ok(rev(cj([l])).motivos.length === 0, `«${l}»: no deja la cotización para revisión`);
  }
  ok(rev(cj([]), [{ codigo: "cuentas_distintas_de_corporativo" }]).motivos.join() === "cuentas_distintas", "el aviso del PDF de cuentas distintas → cuentas_distintas");
  ok(rev(cj([]), [{ codigo: "sin_foto" }, { codigo: "logo_no_usado" }, { codigo: "cliente_no_verificado" }]).motivos.length === 0, "los demás avisos del PDF no dejan nada para revisión");
  const lineas = (n: number) => Array.from({ length: n }, (_, i) => `Condición número ${i + 1}`);
  ok(rev(cj(lineas(30))).motivos.length === 0 && rev(cj(lineas(31))).motivos.join() === "condiciones_demasiadas", "30 líneas caben; 31 → condiciones_demasiadas");
  ok(rev({ incluye: lineas(31), no_incluye: [], generales: [] }).motivos.join() === "condiciones_demasiadas", "en cualquier lista");
  ok(rev(cj(["   ", "", ...lineas(30)])).motivos.length === 0, "las líneas vacías no cuentan (el PDF no las imprime)");
  ok(rev(cj(["a".repeat(500)])).motivos.length === 0 && rev(cj(["a".repeat(501)])).motivos.join() === "condiciones_demasiadas", "500 caracteres caben; 501 → condiciones_demasiadas");
  ok(rev(cj(["ñ".repeat(500)])).motivos.length === 0, "se cuentan caracteres, no bytes");
  ok(rev(cj([]), [{ codigo: "condiciones_demasiadas" }]).motivos.join() === "condiciones_demasiadas", "también por el aviso del PDF");
  const todo = rev(cj([...lineas(31), "www.x.com"]), [{ codigo: "cuentas_distintas_de_corporativo" }]);
  ok(todo.motivos.join() === "cuentas_distintas,condiciones_demasiadas,texto_libre_sospechoso", `los tres a la vez, sin repetir (${todo.motivos})`);
  ok(rev(null).motivos.length === 0 && rev({ generales: "no es lista" }).motivos.length === 0, "sin condiciones o con basura: nada");
  {
    // La pantalla usa la MISMA función que el servidor: movida, no copiada (la identidad del módulo
    // cambia con el alias «@/», así que se comprueba el código y el resultado).
    const fuentePantalla = readFileSync("components/cotizaciones/plantillas/pantalla.ts", "utf8");
    const muestras = ["Reserve en www.x.com", "Consultas al 987 654 321", "Pago por Yape", "Válido hasta el 31/12/2026", "IGV (18 %)", "", "Cuenta 191-1234567-0-12 en el BCP"];
    ok(!/function motivosLineaIA/.test(fuentePantalla) && /motivosLineaIA[^;]*from "@\/lib\/traslados\/texto-libre"/.test(fuentePantalla)
      && muestras.every((l) => JSON.stringify(PA.motivosLineaIA(l)) === JSON.stringify(T.motivosLineaIA(l))),
      "la pantalla usa la MISMA función que el servidor (movida a lib/traslados/texto-libre.ts)");
  }
  ok(E.MOTIVO_REVISION.cuentas_distintas.texto.length > 0 && E.MOTIVO_REVISION.condiciones_demasiadas.arreglo.includes("/cotizaciones/plantillas"), "los dos motivos nuevos con su texto y su arreglo");

  // (2) Puro: las cuentas de la plantilla frente a las de `corporativo`.
  const CORP23: Plantilla = {
    id: "corporativo", nombre: "Corporativo", es_principal: true, activa: true, diseno: "corporativo", idioma: "es", orden: 1,
    condiciones_generales: ["GENERAL DE LA CORPORATIVA"], condiciones_incluye: [], condiciones_no_incluye: [],
    mostrar_cuentas_bancarias: true, usar_bancos_propios: true, banco_1_nombre: "BCP", banco_1_cuenta: "191-1234567-0-12", banco_1_cci: "002-191-001234567012-55",
  };
  const frente = (pl: Plantilla | null, ref: C.ReferenciaCuentas, moneda = "PEN", empresa: any = perfilPrueba) => C.cuentasFrenteACorporativo({ plantilla: pl, referencia: ref, empresa, moneda });
  const OTRA = { ...CORP23, id: "traslados_ia", banco_1_nombre: "BANCO DE OTRO" };
  ok(frente(CORP23, { estado: "misma" }).codigo === "misma_plantilla", "la misma plantilla: nada que comparar");
  ok(frente({ ...CORP23, id: "traslados_ia" }, { estado: "leida", cfg: CORP23 }).codigo === "iguales", "una copia con las mismas cuentas: iguales");
  ok(frente(OTRA, { estado: "leida", cfg: CORP23 }).codigo === "distintas", "otro banco: distintas");
  ok(frente({ ...CORP23, banco_1_cuenta: "191-1234567-0-13" }, { estado: "leida", cfg: CORP23 }).codigo === "distintas", "un solo dígito de la cuenta: distintas");
  ok(frente({ ...CORP23, banco_1_cuenta: "  191-1234567-0-12 " }, { estado: "leida", cfg: CORP23 }).codigo === "iguales", "espacios de más: iguales");
  const DOS = { ...CORP23, banco_2_nombre: "BBVA", banco_2_cuenta: "011-222", banco_2_cci: "" };
  const DOS_AL_REVES = { ...CORP23, banco_1_nombre: "BBVA", banco_1_cuenta: "011-222", banco_1_cci: "", banco_2_nombre: "BCP", banco_2_cuenta: "191-1234567-0-12", banco_2_cci: "002-191-001234567012-55" };
  ok(frente(DOS_AL_REVES, { estado: "leida", cfg: DOS }).codigo === "iguales", "el orden de las cuentas no cuenta");
  ok(frente({ ...CORP23, mostrar_cuentas_bancarias: false }, { estado: "leida", cfg: CORP23 }).codigo === "distintas", "ocultar las cuentas también es distinto (la frase lo dice: «ninguna»)");
  ok(frente(OTRA, { estado: "ilegible", detalle: "timeout" }).codigo === "sin_comprobar", "corporativo ilegible: sin_comprobar");
  ok(frente({ ...CORP23, id: "x", usar_bancos_propios: false }, { estado: "leida", cfg: null }, "PEN", { ...perfilPrueba, cuentas_bancarias: [{ banco: "BCP", cuenta: "1", cci: "" }] }).codigo === "iguales",
    "corporativo no existe: se compara con lo que imprimiría sin plantilla (las del perfil)");
  ok(frente(OTRA, { estado: "leida", cfg: CORP23 }).plantilla[0]?.banco === "BANCO DE OTRO" && C.cuentaEnUnaLinea({ banco: "BCP", cuenta: "191", cci: "002", moneda: "PEN" }) === "BCP 191 CCI 002 (PEN)", "las cuentas que imprime, en una línea");

  // (3) De punta a punta.
  const IA23 = (x: Partial<Plantilla> = {}): Plantilla => ({
    ...CORP23, id: "traslados_ia", nombre: "Traslados (IA)", es_principal: false, orden: 2,
    condiciones_generales: [...config.consideraciones], condiciones_incluye: [], condiciones_no_incluye: [], ...x,
  });
  const REGLAS23 = (["empresa", "particular", "extranjero"] as const).map((segmento) => ({ servicio: "traslado_ia", segmento, plantilla_id: "traslados_ia" }));
  const base23 = (ia: Plantilla) => {
    const sb = nuevaBase();
    sb.tablas.cotizacion_plantillas = [{ ...CORP23 }, { ...ia }];
    sb.tablas.cotizacion_plantilla_reglas = REGLAS23.map((r) => ({ ...r }));
    return sb;
  };
  const deps23 = { simular: simularFalso({ n: 0 }) as any, bajarLogo: async () => null, ahoraMs: () => reloj, azar: () => String(Math.random()).slice(2, 8) };
  const correr = async (sb: SbFalso) => {
    const res = await cotizarTrasladoIA(ctxDe(sb, "cv-1", "ct-1"), pedidoIA, deps23);
    return { res, acc: sb.t("crm_acciones_ia").at(-1) as any, nota: sb.t("crm_notas").map((n) => String(n.texto)).join("\n"), fila: sb.t("cotizaciones").at(-1) as any };
  };
  const motivosDe = (r: Awaited<ReturnType<typeof correr>>) => (r.acc?.payload?.motivos ?? []).join();
  {
    const r = await correr(base23(IA23()));
    ok(r.res.cotizacion?.decision === "automatico" && !!r.res.envioPendiente && r.fila?.plantilla_pdf === "traslados_ia", `corolario: la plantilla de traslados con las cuentas de corporativo sale sola (${r.res.cotizacion?.decision} ${motivosDe(r)})`);
  }
  {
    // (b) Cuentas distintas → revisión, con las cuentas en la nota.
    const sb = base23(IA23({ banco_1_nombre: "BANCO DE LA PLANTILLA IA", banco_1_cuenta: "555-0001" }));
    const r = await correr(sb);
    ok(r.res.cotizacion?.decision === "revision" && !r.res.envioPendiente && motivosDe(r) === "cuentas_distintas", `cuentas distintas → revisión con cuentas_distintas (${motivosDe(r)})`);
    ok(r.nota.includes(E.MOTIVO_REVISION.cuentas_distintas.texto) && r.nota.includes("BANCO DE LA PLANTILLA IA 555-0001") && r.nota.includes("BCP 191-1234567-0-12"), "la nota dice el motivo y qué cuentas imprime frente a las de corporativo");
    ok(!/BANCO DE LA PLANTILLA IA|555-0001/.test(r.res.respuestaModelo), "al modelo no le llega ninguna cuenta");
    const pdf = await pdfDeCotizacion(sb as any, r.fila.id, { bajarLogo: async () => null });
    ok(pdf.avisos.some((a) => a.codigo === "cuentas_distintas_de_corporativo") && textoDelPdf(pdf.bytes).includes("BANCO DE LA PLANTILLA IA"), "el PDF (Ver PDF del ejecutivo) imprime las de la plantilla y lo avisa");

    // (a) La plantilla se DESACTIVA: deja de prestar sus cuentas; vuelven las de corporativo y sale sola.
    sb.t("cotizacion_plantillas").find((p) => p.id === "traslados_ia")!.activa = false;
    const d = await D.leerDatosPdf(sb as any, r.fila, { celular: "51966707225", contactoClienteId: null });
    ok((d.plantilla as any)?.id === "corporativo" && d.referenciaCuentas.estado === "misma", `plantilla inactiva: las cuentas de corporativo, como si no existiera (${(d.plantilla as any)?.id} ${d.referenciaCuentas.estado})`);
    const pdf2 = await pdfDeCotizacion(sb as any, r.fila.id, { bajarLogo: async () => null });
    const t2 = textoDelPdf(pdf2.bytes);
    ok(t2.includes("BCP") && !t2.includes("BANCO DE LA PLANTILLA IA") && !pdf2.avisos.some((a) => a.codigo === "cuentas_distintas_de_corporativo"), "y el PDF imprime las de corporativo, sin el aviso");
    const r2 = await correr(sb);
    ok(sb.t("cotizaciones").length === 1 && r2.res.cotizacion?.decision === "automatico" && !!r2.res.envioPendiente && r2.acc?.payload?.decision === "automatico", `el mismo pedido otra vez (se reusa): ahora sale sola (${r2.res.cotizacion?.decision} ${motivosDe(r2)})`);
    ok(textoDelPdf(r2.res.envioPendiente!.bytes).includes("BCP"), "con las cuentas de corporativo");
  }
  {
    // (c) Condiciones con un enlace / un número largo → revisión con la línea citada; una palabra de pago sola, no.
    const lEnl = "Confirme su reserva en www.pagos-traslados.com";
    const r = await correr(base23(IA23({ condiciones_generales: [...config.consideraciones, lEnl] })));
    ok(r.res.cotizacion?.decision === "revision" && motivosDe(r) === "texto_libre_sospechoso", `condición con un enlace → revisión (${motivosDe(r)})`);
    ok(r.nota.includes(lEnl) && r.nota.includes("Consideraciones generales") && r.nota.includes(T.ETIQUETA_TEXTO_LIBRE.enlace), "la nota cita la línea, su lista y por qué");
    const lNum = "Consultas al 987 654 321";
    const rn = await correr(base23(IA23({ condiciones_no_incluye: [lNum] })));
    ok(rn.res.cotizacion?.decision === "revision" && motivosDe(rn) === "texto_libre_sospechoso" && rn.nota.includes(lNum) && rn.nota.includes("No incluye"), `condición con 6+ dígitos → revisión (${motivosDe(rn)})`);
    const lPago = "El pago del parqueo corre por cuenta del pasajero.";
    const rp = await correr(base23(IA23({ condiciones_generales: [...config.consideraciones, lPago] })));
    ok(rp.res.cotizacion?.decision === "automatico" && !!rp.res.envioPendiente && textoDelPdf(rp.res.envioPendiente!.bytes).includes("parqueo corre por cuenta"), `una palabra de pago sola no la deja para revisión (${rp.res.cotizacion?.decision} ${motivosDe(rp)})`);
  }
  {
    // (d) Condiciones desmesuradas → revisión y el aviso del PDF.
    const r31 = await correr(base23(IA23({ condiciones_generales: lineas(31) })));
    ok(r31.res.cotizacion?.decision === "revision" && motivosDe(r31) === "condiciones_demasiadas" && r31.nota.includes(E.MOTIVO_REVISION.condiciones_demasiadas.texto), `31 líneas → revisión con condiciones_demasiadas (${motivosDe(r31)})`);
    ok(/«Consideraciones generales»: 31 líneas/.test(r31.nota), "la nota dice qué lista y cuántas líneas (aviso del PDF)");
    const r30 = await correr(base23(IA23({ condiciones_generales: lineas(30) })));
    ok(r30.res.cotizacion?.decision === "automatico", `30 líneas: sale sola (${motivosDe(r30)})`);
    const rLarga = await correr(base23(IA23({ condiciones_incluye: ["x".repeat(501)] })));
    ok(rLarga.res.cotizacion?.decision === "revision" && motivosDe(rLarga) === "condiciones_demasiadas" && /una línea de 501 caracteres/.test(rLarga.nota), `una línea de 501 caracteres → revisión (${motivosDe(rLarga)})`);
    const rTodo = await correr(base23(IA23({ banco_1_nombre: "OTRO", condiciones_generales: [...lineas(31), "Pague en bit.ly/abc"] })));
    ok(motivosDe(rTodo) === "cuentas_distintas,condiciones_demasiadas,texto_libre_sospechoso", `los tres motivos a la vez (${motivosDe(rTodo)})`);
  }
  {
    // (e) La política de reserva, cambios y cancelación (cotizaciones-06): se copia a la fila desde la
    // plantilla y sale en el PDF; una línea con un número largo o un enlace → revisión; 31 líneas →
    // condiciones_demasiadas. «50 % de adelanto» y «pagado» solos NO la dejan para revisión.
    const POL = [
      "La reserva se confirma con el 50 % de adelanto; el saldo se paga al iniciar el servicio.",
      "Cancelación con 24 horas o más de anticipación: sin costo, devolución del 100 %.",
      "Con menos de 24 horas: reprogramación sin costo o un cargo administrativo del 10 % de lo pagado.",
    ];
    const r = await correr(base23(IA23({ condiciones_reserva: ["  " + POL[0] + "  ", "", ...POL.slice(1)] })));
    ok(r.res.cotizacion?.decision === "automatico" && !!r.res.envioPendiente, `una política limpia sale sola (${r.res.cotizacion?.decision} ${motivosDe(r)})`);
    ok(JSON.stringify(r.fila?.consideraciones_json?.reserva) === JSON.stringify(POL), `se copia a la fila, limpia (${JSON.stringify(r.fila?.consideraciones_json?.reserva)})`);
    const txt = r.res.envioPendiente ? textoDelPdf(r.res.envioPendiente.bytes) : "";
    ok(/RESERVA, CAMBIOS Y CANCELACI/.test(txt) && txt.includes("cargo administrativo del 10 %"), "y el PDF que se envía la imprime");
    const sin = await correr(base23(IA23()));
    ok(!("reserva" in (sin.fila?.consideraciones_json ?? {})) && !/RESERVA, CAMBIOS/.test(sin.res.envioPendiente ? textoDelPdf(sin.res.envioPendiente.bytes) : ""), "sin política en la plantilla: ni la clave en la fila ni el bloque en el PDF");
    const lNum = "Para cancelar llame al 987 654 321.";
    const rn = await correr(base23(IA23({ condiciones_reserva: [...POL, lNum] })));
    ok(rn.res.cotizacion?.decision === "revision" && motivosDe(rn) === "texto_libre_sospechoso" && rn.nota.includes(lNum) && rn.nota.includes("Reserva, cambios y cancelación"), `una línea de la política con 6+ dígitos → revisión, y la nota la cita con su lista (${motivosDe(rn)})`);
    const lEnl = "Política completa en www.ejemplo-traslados.com";
    const re = await correr(base23(IA23({ condiciones_reserva: [lEnl] })));
    ok(re.res.cotizacion?.decision === "revision" && motivosDe(re) === "texto_libre_sospechoso" && re.nota.includes(lEnl), `una línea de la política con un enlace → revisión (${motivosDe(re)})`);
    const r31 = await correr(base23(IA23({ condiciones_reserva: lineas(31) })));
    ok(r31.res.cotizacion?.decision === "revision" && motivosDe(r31) === "condiciones_demasiadas" && /«Reserva, cambios y cancelación»: 31 líneas/.test(r31.nota), `31 líneas en la política → condiciones_demasiadas, y la nota nombra la lista (${motivosDe(r31)})`);
    // Las funciones puras, directo.
    const cs = T.condicionesSospechosas({ incluye: [], no_incluye: [], generales: [], reserva: [POL[0], lNum] });
    ok(cs.length === 1 && cs[0].lista === "reserva" && cs[0].linea === lNum && cs[0].motivos.includes("numero_largo"), "condicionesSospechosas mira la política");
    const rv = E.revisionPorCondiciones({ avisosPdf: [], consideraciones: { incluye: [], no_incluye: [], generales: [], reserva: lineas(31) } });
    ok(rv.motivos.join() === "condiciones_demasiadas", `revisionPorCondiciones cuenta la política para el exceso (${rv.motivos.join()})`);
    ok(E.revisionPorCondiciones({ avisosPdf: [], consideraciones: { incluye: [], no_incluye: [], generales: [], reserva: POL } }).motivos.length === 0, "y una política limpia no deja nada para revisión");
  }
  {
    // (f) El RESUMEN de la política (cotizaciones-08): se copia a la fila desde la plantilla junto con
    // la política (solo si hay política); con el token de la cotización y el dominio del ERP, el PDF
    // imprime el resumen, el enlace y el QR; sin uno de los dos, la política ENTERA como hasta ahora.
    // Las líneas del resumen cuentan para la revisión igual que las de la política.
    const POL = [
      "La reserva se confirma con el 50 % de adelanto; el saldo se paga al iniciar el servicio.",
      "Cancelación con 24 horas o más de anticipación: sin costo, devolución del 100 %.",
      "Con menos de 24 horas: reprogramación sin costo o un cargo administrativo del 10 % de lo pagado.",
    ];
    const RES = ["Adelanto del 50 % para reservar.", "Cancelación sin costo con 24 h de anticipación."];
    const TOKEN = "3F2504E0-4F89-41D3-9A0C-0305E82C3301";
    const BASE = "https://erp.ejemplo.pe";
    const URL_OK = `${BASE}/condiciones/${TOKEN.toLowerCase()}`;
    const plano = (r: Awaited<ReturnType<typeof correr>>) => (r.res.envioPendiente ? textoDelPdf(r.res.envioPendiente.bytes) : "");
    const sinEsp = (t: string) => t.replace(/\s+/g, "");
    const envAntes = process.env.NEXT_PUBLIC_APP_URL;
    const conEnv = async <X,>(v: string | undefined, f: () => Promise<X>): Promise<X> => {
      if (v === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = v;
      try { return await f(); } finally { if (envAntes === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = envAntes; }
    };
    const conRes = (x: Partial<Plantilla> = {}) => IA23({ condiciones_reserva: POL, condiciones_reserva_resumen: ["  " + RES[0] + "  ", "", RES[1]], ...x } as Partial<Plantilla>);

    // Con token y dominio: el resumen, el enlace y el QR; la política entera NO se imprime (va en el enlace).
    const sbT = base23(conRes()); sbT.tokenCot = TOKEN;
    const rT = await conEnv(BASE, () => correr(sbT));
    ok(rT.res.cotizacion?.decision === "automatico" && !!rT.res.envioPendiente, `política + resumen limpios: sale sola (${rT.res.cotizacion?.decision} ${motivosDe(rT)})`);
    ok(JSON.stringify(rT.fila?.consideraciones_json?.reserva) === JSON.stringify(POL) && JSON.stringify(rT.fila?.consideraciones_json?.reserva_resumen) === JSON.stringify(RES),
      `el resumen se copia a la fila, limpio, junto con la política (${JSON.stringify(rT.fila?.consideraciones_json?.reserva_resumen)})`);
    const tT = plano(rT);
    ok(RES.every((l) => tT.includes(l)) && !tT.includes("cargo administrativo del 10 %") && sinEsp(tT).includes(sinEsp(URL_OK)),
      "el PDF que se envía imprime el resumen y el enlace a SU cotización (el token se leyó de vuelta del insert), no la política entera");
    ok(rT.fila?.condiciones_token === TOKEN, "la fila guardada lleva el token que puso la base");

    // Sin dominio del ERP: la política entera, como hasta ahora (el resumen se guarda igual en la fila).
    const sbE = base23(conRes()); sbE.tokenCot = TOKEN;
    const rE = await conEnv(undefined, () => correr(sbE));
    const tE = plano(rE);
    ok(rE.res.cotizacion?.decision === "automatico" && tE.includes("cargo administrativo del 10 %") && !tE.includes(RES[0]) && !sinEsp(tE).includes("/condiciones/"),
      "sin NEXT_PUBLIC_APP_URL: la política entera, sin resumen ni enlace");
    ok(JSON.stringify(rE.fila?.consideraciones_json?.reserva_resumen) === JSON.stringify(RES), "y el resumen queda guardado en la fila para cuando haya enlace");

    // Un dominio que no es un origen https (o localhost): tampoco hay enlace.
    const sbH = base23(conRes()); sbH.tokenCot = TOKEN;
    const tH = plano(await conEnv("http://erp.ejemplo.pe", () => correr(sbH)));
    ok(tH.includes("cargo administrativo del 10 %") && !tH.includes(RES[0]), "un dominio http (no localhost): la política entera");

    // Sin token (la base no lo puso): la política entera.
    const rN = await conEnv(BASE, () => correr(base23(conRes())));
    const tN = plano(rN);
    ok(rN.res.cotizacion?.decision === "automatico" && tN.includes("cargo administrativo del 10 %") && !tN.includes(RES[0]), "sin token: la política entera");

    // Sin la migración: el insert que pide el token de vuelta falla entero (una sentencia, nada escrito);
    // se reintenta sin pedirlo, se crea UNA cotización y el PDF lleva la política entera.
    const sbM = base23(conRes()); sbM.tokenCot = TOKEN; sbM.faltan.cotizaciones = ["condiciones_token"];
    const rM = await conEnv(BASE, () => correr(sbM));
    const tM = plano(rM);
    ok(rM.res.cotizacion?.decision === "automatico" && sbM.t("cotizaciones").length === 1 && rM.fila?.condiciones_token === undefined && tM.includes("cargo administrativo del 10 %") && !tM.includes(RES[0]),
      `sin cotizaciones-08: una sola cotización, sin token y con la política entera (${rM.res.cotizacion?.decision} ${sbM.t("cotizaciones").length})`);
    // Y el PDF del ejecutivo (relee la fila con COLS accesorias): la misma política entera.
    const pdfM = await conEnv(BASE, () => pdfDeCotizacion(sbM as any, rM.fila.id, { bajarLogo: async () => null }));
    ok(textoDelPdf(pdfM.bytes).includes("cargo administrativo del 10 %"), "«Ver PDF» sin la columna: la relectura la suelta y la política va entera");
    // Con la columna, «Ver PDF» relee el token de la fila y sale el mismo resumen con su enlace.
    const pdfT = await pdfDeCotizacion(sbT as any, rT.fila.id, { bajarLogo: async () => null, baseCondiciones: BASE });
    const tPdfT = textoDelPdf(pdfT.bytes);
    ok(RES.every((l) => tPdfT.includes(l)) && sinEsp(tPdfT).includes(sinEsp(URL_OK)), "«Ver PDF» relee el token: el mismo resumen y el mismo enlace");

    // Resumen sin política en la plantilla: no se copia ninguno de los dos.
    const rSP = await conEnv(BASE, () => { const sb = base23(IA23({ condiciones_reserva_resumen: RES } as Partial<Plantilla>)); sb.tokenCot = TOKEN; return correr(sb); });
    ok(!("reserva" in (rSP.fila?.consideraciones_json ?? {})) && !("reserva_resumen" in (rSP.fila?.consideraciones_json ?? {})) && !/RESERVA, CAMBIOS/.test(plano(rSP)),
      "un resumen sin política en la plantilla no se copia ni se imprime");
    // Política sin resumen: la clave del resumen no aparece y el PDF lleva la política entera aunque haya enlace.
    const rPS = await conEnv(BASE, () => { const sb = base23(IA23({ condiciones_reserva: POL })); sb.tokenCot = TOKEN; return correr(sb); });
    ok(!("reserva_resumen" in (rPS.fila?.consideraciones_json ?? {})) && plano(rPS).includes("cargo administrativo del 10 %") && !sinEsp(plano(rPS)).includes("/condiciones/"),
      "política sin resumen: sin la clave y con la política entera, aunque haya token y dominio");

    // Las líneas del resumen cuentan para la revisión.
    const lNum = "Para cancelar llame al 987 654 321.";
    const rRn = await conEnv(BASE, () => { const sb = base23(conRes({ condiciones_reserva_resumen: [RES[0], lNum] } as Partial<Plantilla>)); sb.tokenCot = TOKEN; return correr(sb); });
    ok(rRn.res.cotizacion?.decision === "revision" && motivosDe(rRn) === "texto_libre_sospechoso" && rRn.nota.includes(lNum) && rRn.nota.includes("Resumen de la reserva, cambios y cancelación"),
      `una línea del resumen con 6+ dígitos → revisión, y la nota la cita con su lista (${motivosDe(rRn)})`);
    const lEnl = "Más en www.ejemplo-traslados.com";
    const rRe = await conEnv(BASE, () => { const sb = base23(conRes({ condiciones_reserva_resumen: [lEnl] } as Partial<Plantilla>)); sb.tokenCot = TOKEN; return correr(sb); });
    ok(rRe.res.cotizacion?.decision === "revision" && motivosDe(rRe) === "texto_libre_sospechoso" && rRe.nota.includes(lEnl), `una línea del resumen con un enlace → revisión (${motivosDe(rRe)})`);
    const rR31 = await conEnv(BASE, () => { const sb = base23(conRes({ condiciones_reserva_resumen: lineas(31) } as Partial<Plantilla>)); sb.tokenCot = TOKEN; return correr(sb); });
    ok(rR31.res.cotizacion?.decision === "revision" && motivosDe(rR31) === "condiciones_demasiadas" && /«Resumen de la reserva, cambios y cancelación»: 31 líneas/.test(rR31.nota),
      `31 líneas en el resumen → condiciones_demasiadas, y la nota nombra la lista (${motivosDe(rR31)})`);
    // Las puras, directo.
    const cs = T.condicionesSospechosas({ incluye: [], no_incluye: [], generales: [], reserva: POL, reserva_resumen: [RES[0], lNum] });
    ok(cs.length === 1 && cs[0].lista === "reserva_resumen" && cs[0].linea === lNum && cs[0].motivos.includes("numero_largo"), "condicionesSospechosas mira el resumen");
    ok(E.revisionPorCondiciones({ avisosPdf: [], consideraciones: { incluye: [], no_incluye: [], generales: [], reserva: POL, reserva_resumen: lineas(31) } }).motivos.join() === "condiciones_demasiadas",
      "revisionPorCondiciones cuenta el resumen para el exceso");
    ok(E.revisionPorCondiciones({ avisosPdf: [], consideraciones: { incluye: [], no_incluye: [], generales: [], reserva: POL, reserva_resumen: RES } }).motivos.length === 0, "y un resumen limpio no deja nada para revisión");
  }
  {
    // El simulador de /tarifario dice lo mismo que hará la IA; la pantalla de plantillas usa la misma regla.
    const q = (x: string) => x.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const ruta = q(readFileSync("app/api/traslados/simular/route.ts", "utf8"));
    ok(/revisionPorCondiciones\(\{[\s\S]{0,300}avisosDeRevision\(fila,/.test(ruta) && /plantillaYReferenciaCuentas\(sb, fila\.plantilla_pdf\)/.test(ruta), "simulador: las cuentas y las condiciones, con las mismas funciones que la IA");
    const ia = q(readFileSync("lib/traslados/cotizar-ia-datos.ts", "utf8"));
    ok(ia.indexOf("planEnvio({") < ia.indexOf("revisionPorCondiciones({") && /consideraciones: x\.leida\.consideraciones_json/.test(ia), "IA: después de planEnvio, sobre las condiciones de la FILA (las que van en el PDF)");
    ok(PA.avisoLineaIA("Consultas al 987 654 321", { enUso: false })!.includes("Si asignas esta plantilla a traslados") && PA.avisoLineaIA("Pago por Yape.", { enUso: false })!.includes("Si la asignas a traslados, esta línea la manda la IA sin revisión"), "la pantalla avisa también en una plantilla que la IA puede usar (y dice lo que de verdad pasa)");
    ok(PA.avisoLineaIA("Pago por Yape.")!.includes("La manda la IA sin revisión") && PA.avisoLineaIA("www.x.com")!.includes("quedan para que las revise un ejecutivo"), "en una plantilla en uso, también");
    const conf = PA.lineasConfirmTraslado({ resultante: IA23({ banco_1_nombre: "OTRO", condiciones_generales: ["Pague en www.x.com"] }), plantillas: [CORP23], perfil: perfilPrueba as any, segmento: "particular" });
    ok(conf.some((l) => l.includes("OTRO") && l.includes("soles")) && conf.some((l) => l.includes("No son las de la plantilla «corporativo»")) && conf.some((l) => l.includes("www.x.com")), `el confirm de la regla lista cuentas, la diferencia y las líneas (${conf.join(" | ")})`);
    const confVacia = PA.lineasConfirmTraslado({ resultante: null, plantillas: [CORP23], perfil: perfilPrueba as any, segmento: "extranjero" });
    ok(confVacia.some((l) => l.includes("BCP") && l.includes("dólares")) && !confVacia.some((l) => l.includes("No son")), "al vaciar la celda (sin plantilla): las cuentas de corporativo");
    ok(PA.lineasConfirmTraslado({ resultante: null, plantillas: [CORP23], perfil: undefined, segmento: "particular" })[0].startsWith("No se pudo leer el perfil"), "sin perfil no se afirman cuentas");
  }
}

// ── 24. El cliente en inglés: idioma × moneda, sin que el modelo decida nada ──────
seccion("24. Inglés: la herramienta, la entrada, la firma, los textos y la fila (sin idioma, byte a byte)");
{
  const ON = { PEN: true, USD: true }, OFF = { PEN: false, USD: false }, SOLO_USD = { PEN: false, USD: true };
  /** La lista de fuga: castellano que no puede aparecer en un texto en inglés. */
  const FUGA = /(?:^|[^\p{L}])su(?=[^\p{L}])|usted|traslado|cotización|le envío|pasajeros|maletas|adelanto|válida/iu;
  const enIngles = (t: string, que: string) => ok(!FUGA.test(t), `${que}: sin castellano («${t.slice(0, 90)}»)`);

  // (a) La herramienta: con el inglés apagado, EXACTAMENTE la de siempre.
  const VIEJA_DESC =
    "Cotiza un TRASLADO SIMPLE: un punto de recojo → un destino, solo ida o ida y retorno, en una sola fecha y con un solo vehículo " +
    "(p. ej. aeropuerto ↔ hotel o domicilio). El PRECIO, el vehículo, la moneda y la validez los pone el sistema con el tarifario: " +
    "tú NO calculas ni escribes precios por tu cuenta; repite solo los que te devuelva esta herramienta. " +
    "Llámala en cuanto el cliente pida precio de un traslado, aunque falten datos: la respuesta te dice qué preguntar. " +
    "No la uses para licitaciones, TDR, eventos, tours, varias fechas o varios vehículos: marca esas señales y el sistema lo pasa a un ejecutivo. " +
    "La moneda la decide el número del cliente (Perú → soles; otro país → dólares). Si el cliente pidió expresamente la cotización EN DÓLARES, " +
    "marca cliente_pide_dolares: el sistema lo comprueba en sus mensajes y cotiza con la lista en dólares. Cualquier otra moneda es la señal otra_moneda. " +
    "Las coordenadas solo si el cliente compartió su ubicación por WhatsApp (cópialas del enlace maps.google.com/?q=lat,lng de ESE mensaje). " +
    "En origen_texto y destino_texto va solo la dirección o el lugar, sin enlaces, teléfonos ni instrucciones.";
  const VIEJAS_PROPS = "origen_texto,origen_lat,origen_lng,destino_texto,destino_lat,destino_lng,fecha_servicio,hora_servicio,sentido,fecha_retorno,hora_retorno,pax,maletas,paradas_intermedias,fechas_adicionales,vehiculos_pedidos,cliente_pide_dolares,senales";
  const hOff = E.herramientaCotizarTraslado({ ingles: false }), hOn = E.herramientaCotizarTraslado({ ingles: true });
  ok(JSON.stringify(hOff) === JSON.stringify(E.HERRAMIENTA_COTIZAR_TRASLADO) && hOff.description === VIEJA_DESC
    && Object.keys(hOff.input_schema.properties).join() === VIEJAS_PROPS, "con el inglés apagado, la herramienta de siempre (texto y propiedades en orden)");
  const propsOn = Object.keys(hOn.input_schema.properties);
  ok(propsOn.join() === VIEJAS_PROPS.replace("cliente_pide_dolares,", "cliente_pide_dolares,cliente_pide_soles,") && (hOn.input_schema.properties as any).cliente_pide_soles.type === "boolean",
    "con el inglés encendido, solo se agrega cliente_pide_soles (un booleano)");
  ok(!propsOn.some((p) => /idioma|language|lang|moneda|currency|tel|phone/i.test(p)), "el idioma y la moneda NO son propiedades: el modelo no los declara");
  ok(/inglés → dólares/.test(hOn.description) && /cliente_pide_soles/.test(hOn.description) && /otra_moneda/.test(hOn.description) && hOn.description.startsWith(VIEJA_DESC.slice(0, 200)),
    "con el inglés, la frase de la moneda nueva (castellano/inglés/otro, soles y dólares a pedido)");

  // (b) nombraSoles.
  for (const t of ["en soles por favor", "price in soles", "Nuevos Soles", "PEN please", "S/ 150?", "S/150", "S/.", "in peruvian sol", "Peruvian soles", "local currency please", "en moneda local"]) ok(E.nombraSoles([t]), `«${t}» nombra los soles`);
  for (const t of ["", "hace sol", "the sun", "Av. Larco s/n", "pencil", "dollars", "solo ida", "consola"]) ok(!E.nombraSoles([t]), `«${t}» no nombra los soles`);
  ok(!E.nombraSoles(null) && !E.nombraSoles([null, 5] as unknown[]), "sin textos, no");

  // (c) entradaDelAgente: sin idioma, byte a byte el algoritmo de antes (copiado literal); el input
  //     del modelo nunca pone el idioma ni la moneda.
  const entradaVieja = (input: unknown, remitente: { canal: string; waId: string | null }, textosUbicacion: string[], textosCliente: readonly unknown[] = []): unknown => {
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const lugar = (texto: unknown, lat: unknown, lng: unknown) => {
      const t = (typeof texto === "string" ? texto : "").trim();
      const c = E.coordenadasVerificadas(lat, lng, textosUbicacion);
      return c ? { lat: c.lat, lng: c.lng, texto: t || undefined } : t;
    };
    const wa = remitente?.canal === "whatsapp" && typeof remitente.waId === "string" && remitente.waId.trim() ? remitente.waId.trim() : null;
    const pideDolares = o.cliente_pide_dolares === true && E.nombraDolares(textosCliente);
    const senales = pideDolares && Array.isArray(o.senales) ? o.senales.filter((x) => x !== "otra_moneda") : o.senales;
    return {
      origen: lugar(o.origen_texto, o.origen_lat, o.origen_lng),
      destino: lugar(o.destino_texto, o.destino_lat, o.destino_lng),
      fecha_servicio: o.fecha_servicio, hora_servicio: o.hora_servicio,
      sentido: o.sentido, fecha_retorno: o.fecha_retorno, hora_retorno: o.hora_retorno,
      pax: o.pax, maletas: o.maletas,
      paradas_intermedias: o.paradas_intermedias, fechas_adicionales: o.fechas_adicionales,
      vehiculos_pedidos: o.vehiculos_pedidos, senales,
      telefono: wa,
      ...(pideDolares ? { pide_dolares: true } : {}),
    };
  };
  const firmaVieja = (e: EntradaSimulador): string => {
    const fl = (l: EntradaSimulador["origen"]) => typeof l === "string" ? M.claveNombre(l) : `@${l.lat.toFixed(5)},${l.lng.toFixed(5)}`;
    const conRetorno = e.sentido === "ida_retorno";
    return ["v1", fl(e.origen), fl(e.destino), e.fecha_servicio ?? "", e.hora_servicio ?? "", e.sentido ?? "",
      conRetorno ? e.fecha_retorno ?? "" : "", conRetorno ? e.hora_retorno ?? "" : "", e.pax ?? "", e.maletas ?? "",
      M.monedaDelPedido(e.telefono, e.pide_dolares).moneda ?? ""].join("|");
  };
  const IDIOMAS: ({ cliente: "es" | "en" | "otro" | null; ingles: { PEN: boolean; USD: boolean } | null } | undefined)[] = [
    undefined, { cliente: null, ingles: ON }, { cliente: "es", ingles: ON }, { cliente: "en", ingles: null }, { cliente: "en", ingles: OFF },
    { cliente: "otro", ingles: OFF }, { cliente: "en", ingles: ON }, { cliente: "otro", ingles: ON }, { cliente: "en", ingles: SOLO_USD },
  ];
  const TEXTOS: string[][] = [[], ["in dollars please"], ["en soles por favor"], ["price in soles or dollars?"], ["Hello, I need a transfer"]];
  const INTRUSOS = [{}, { idioma_cliente: "en", pide_soles: true, idioma: "en", moneda: "USD", telefono: "+13055551234", language: "en" }];
  let n = 0, viejas = 0, iguales = 0, firmasOk = 0, monedasOk = 0, conIdioma = 0, conSoles = 0, sinPaso = 0;
  for (const wa of ["51966707225", "13055551234", null]) for (const pd of [undefined, true]) for (const ps of [undefined, true]) for (const tc of TEXTOS)
    for (const intr of INTRUSOS) for (const idi of IDIOMAS) for (const sen of [undefined, ["otra_moneda"]]) {
      n++;
      const input = { origen_texto: "Aeropuerto Jorge Chávez", destino_texto: "Hotel Belmond, Miraflores", fecha_servicio: "2026-10-25", hora_servicio: "06:30", sentido: "ida", pax: 2, maletas: 2,
        cliente_pide_dolares: pd, cliente_pide_soles: ps, senales: sen, ...intr };
      const crudo = E.entradaDelAgente(input, { canal: "whatsapp", waId: wa }, [], tc, idi as any) as Record<string, unknown>;
      const gate = !!idi && !!idi.ingles && (idi.ingles.PEN || idi.ingles.USD) && (idi.cliente === "en" || idi.cliente === "otro");
      if (!gate) {
        viejas++;
        if (JSON.stringify(crudo) === JSON.stringify(entradaVieja(input, { canal: "whatsapp", waId: wa }, [], tc))) iguales++;
      } else {
        conIdioma++;
        ok(crudo.idioma_cliente === idi!.cliente, "con el inglés encendido, el idioma que derivó el código");
        const dol = pd === true && E.nombraDolares(tc), sol = ps === true && E.nombraSoles(tc);
        ok((crudo.pide_soles === true) === (sol && !dol) && (crudo.pide_dolares === true) === (dol && !sol), `soles y dólares con sus dos confirmaciones, y con los dos a la vez ninguno (${JSON.stringify(tc)} ${pd} ${ps})`);
        if (crudo.pide_soles === true) conSoles++;
      }
      // Invariante 3: lo que el modelo pone en el input no llega.
      ok(crudo.telefono === (wa ?? null) && !("moneda" in crudo) && !("idioma" in crudo) && !("language" in crudo)
        && (gate || (!("idioma_cliente" in crudo) && !("pide_soles" in crudo))), "el input del modelo no cambia ni el idioma ni la moneda");
      // Invariante 2: la moneda de la firma es la del motor.
      const v = validarEntrada(crudo);
      if (!v.ok) { ok(false, "validable"); continue; }
      const e = v.entrada;
      const f = E.firmaPedido(e).split("|");
      if (!e.idioma_cliente && E.firmaPedido(e) === firmaVieja(e)) firmasOk++;
      if (e.idioma_cliente) ok(f[f.length - 1] === "en" && f.length === 12, "con idioma, «en» al final de la firma");
      const r = M.evaluarTraslado({ origen: AEROP, destino: MIRA, fecha_servicio: e.fecha_servicio, hora_servicio: e.hora_servicio, sentido: e.sentido, pax: e.pax, maletas: e.maletas,
        telefono: e.telefono, pide_dolares: e.pide_dolares === true, idioma_cliente: e.idioma_cliente ?? null, pide_soles: e.pide_soles === true, senales: e.senales }, ctx);
      // Solo los pedidos que llegan al paso de la moneda (un pedido complejo se deriva antes).
      if (r.moneda == null && r.codigo !== "sin_moneda") { sinPaso++; continue; }
      if ((r.moneda ?? "") === f[10]) monedasOk++; else ok(false, `firma ${f[10]} vs motor ${r.moneda} (${JSON.stringify(e)})`);
    }
  ok(iguales === viejas, `sin el inglés encendido, entradaDelAgente es byte a byte la de antes (${iguales}/${viejas})`);
  ok(firmasOk === viejas, `sin idioma, firmaPedido es byte a byte la de antes (${firmasOk}/${viejas})`);
  ok(monedasOk === n - sinPaso && monedasOk > 0, `la moneda de la firma es la del motor en todo el barrido (${monedasOk}/${n - sinPaso}; ${sinPaso} derivados antes de la moneda)`);
  ok(conIdioma > 0 && conSoles > 0, `corolario: el barrido sí produce idioma (${conIdioma}) y soles a pedido (${conSoles})`);
  console.log(`  barrido: ${n} entradas`);
  // Volver al castellano reusa la cotización de castellano (misma firma).
  const b = validarEntrada(E.entradaDelAgente({ origen_texto: "Aeropuerto", destino_texto: "Miraflores", fecha_servicio: "2026-10-25", sentido: "ida", pax: 2, maletas: 0 }, { canal: "whatsapp", waId: "51966707225" }, [])) as any;
  const bEn = validarEntrada(E.entradaDelAgente({ origen_texto: "Aeropuerto", destino_texto: "Miraflores", fecha_servicio: "2026-10-25", sentido: "ida", pax: 2, maletas: 0 }, { canal: "whatsapp", waId: "51966707225" }, [], [], { cliente: "en", ingles: ON })) as any;
  ok(E.firmaPedido(bEn.entrada) !== E.firmaPedido(b.entrada) && E.firmaPedido(b.entrada) === firmaVieja(b.entrada), "el mismo pedido en inglés es otra cotización; en castellano, la de siempre");

  // (d) faltaEnIdioma: la tabla exacta.
  for (const f of Object.values(M.FALTA)) {
    ok(E.faltaEnIdioma(f, "es") === f, `castellano tal cual («${f}»)`);
    const en = E.faltaEnIdioma(f, "en");
    ok(!!en && en !== f, `«${f}» tiene su inglés («${en}»)`);
    enIngles(en ?? "", `falta «${f}»`);
  }
  for (const punto of ["recojo", "destino"] as const) {
    const en = E.faltaEnIdioma(M.faltaDireccion(punto, "Hotel Belmond"), "en")!;
    ok(en === `the exact address of the ${punto === "recojo" ? "pick-up point" : "destination"} (we could not find «Hotel Belmond»)`, `la dirección no encontrada, con su cita (${en})`);
  }
  ok(E.faltaEnIdioma("la hora de recojo", "en") === null && E.faltaEnIdioma("algo inventado", "es") === "algo inventado", "lo que no está en la tabla: null en inglés, tal cual en castellano");

  // (e) Los textos del código en inglés: una sola versión, sin castellano.
  const EN_TU: EstiloMensajes = { tratamiento: "tu", preguntas: "todo_junto", idioma: "en" };
  const ESTILOS_EN: EstiloMensajes[] = ESTILOS.map((e) => ({ ...e, idioma: "en" }));
  const L_EN = C.LINEA_DISPONIBILIDAD_EN;
  ok(C.lineaDisponibilidad("en") === L_EN && C.lineaDisponibilidad("es") === C.LINEA_DISPONIBILIDAD, "la línea de disponibilidad en los dos idiomas");
  const baseEn = { numero: "00123", total: "US$ 118.00", validez: "Nov 18, 2026" };
  const LIT_EN = {
    auto: `Here is quotation No. 00123 for your transfer. The total is US$ 118.00 (including IGV, Peruvian VAT), valid until Nov 18, 2026. ${L_EN}`,
    ya: `I already sent you quotation No. 00123 for your transfer in this chat. The total is US$ 118.00 (including IGV, Peruvian VAT), valid until Nov 18, 2026. ${L_EN}`,
    rev: "I've registered your transfer request with quotation No. 00123. One of our agents is reviewing it and will send it to you in this chat shortly.",
  };
  for (const e of ESTILOS_EN) {
    const auto = E.mensajeCotizacionCodigo({ ...baseEn, decision: "automatico", estilo: e });
    const ya = E.mensajeCotizacionCodigo({ ...baseEn, decision: "automatico", yaEnviada: true, estilo: e });
    const rev = E.mensajeCotizacionCodigo({ ...baseEn, decision: "revision", estilo: e });
    ok(auto === LIT_EN.auto && ya === LIT_EN.ya && rev === LIT_EN.rev, `${nombreEstilo(e)} en inglés: una sola versión, los tres literales (${auto} | ${ya} | ${rev})`);
    for (const m of [auto, ya, rev]) enIngles(m, `mensaje en inglés ${nombreEstilo(e)}`);
  }
  ok(E.mensajeCotizacionCodigo({ numero: "9", decision: "automatico", estilo: EN_TU }) === `Here is quotation No. 9 for your transfer. ${L_EN}`
    && E.mensajeCotizacionCodigo({ numero: "9", decision: "automatico", validez: "Jan 1, 2027", estilo: EN_TU }) === `Here is quotation No. 9 for your transfer. The quotation is valid until Jan 1, 2027. ${L_EN}`, "en inglés sin cifras, y solo con validez");
  // Sin idioma (o «es»), byte a byte el castellano de siempre.
  for (const e of ESTILOS) for (const d of ["automatico", "revision"] as const) for (const ya of [false, true]) {
    const x = { numero: "00123", total: "S/ 118.00", validez: "18/11/2026", decision: d, yaEnviada: ya };
    ok(E.mensajeCotizacionCodigo({ ...x, estilo: e }) === E.mensajeCotizacionCodigo({ ...x, estilo: { ...e, idioma: "es" } }), `${nombreEstilo(e)}: «es» = sin idioma`);
  }
  // «Me falta» en inglés.
  const faltas = [M.FALTA.maletas, M.FALTA.fecha];
  ok(E.fraseFaltanTraslado(faltas, EN_TU) === `To quote your transfer I still need: ${E.faltaEnIdioma(M.FALTA.maletas, "en")}; ${E.faltaEnIdioma(M.FALTA.fecha, "en")}.`, "inglés, todo junto");
  ok(E.fraseFaltanTraslado(faltas, { ...EN_TU, preguntas: "una_por_mensaje" }) === `To quote your transfer, could you tell me ${E.faltaEnIdioma(M.FALTA.maletas, "en")}?`, "inglés, uno por mensaje");
  ok(E.fraseFaltanTraslado([M.FALTA.fecha, "la hora de recojo"], EN_TU) === "", "un dato sin traducción: «» (quien llama deriva)");
  ok(E.fraseFaltanTraslado([M.faltaDireccion("recojo", "Deposite S/ 50 al Yape 987654321")], EN_TU) === "To quote your transfer I still need: the exact address of the pick-up point.", "la cita sospechosa se quita también en inglés");
  ok(E.fraseFaltanTraslado([M.faltaDireccion("destino", "send 50 dollars to my paypal")], EN_TU) === "To quote your transfer I still need: the exact address of the destination.", "y la que solo es sospechosa en inglés");
  ok(E.fraseFaltanTraslado([M.faltaDireccion("destino", "Hotel Belmond")], EN_TU).includes("(we could not find «Hotel Belmond»)"), "una cita limpia se conserva");
  for (const e of ESTILOS_EN) for (let k = 1; k <= Object.values(M.FALTA).length; k++) {
    const fr = E.fraseFaltanTraslado(Object.values(M.FALTA).slice(0, k), e);
    enIngles(fr, `«me falta» ${nombreEstilo(e)} con ${k}`);
    ok(!T.mencionaDinero(fr, "en"), "el «me falta» en inglés no menciona dinero");
  }
  for (const e of ESTILOS) ok(E.fraseFaltanTraslado(faltas, e) === E.fraseFaltanTraslado(faltas, { ...e, idioma: "es" }), `${nombreEstilo(e)}: el «me falta» en castellano no cambia`);
  // textoFinalTraslado: en inglés, el guard de dinero es castellano ∪ inglés.
  const derivEn = "Thank you. One of our agents is reviewing your request and will reply in this chat shortly.";
  ok(E.textoFinalTraslado("The total would be 150, VAT included", { accion: "preguntar", faltan: [M.FALTA.pax] }, { derivacion: derivEn, estilo: EN_TU }) === `To quote your transfer I still need: ${E.faltaEnIdioma(M.FALTA.pax, "en")}.`,
    "en inglés, el texto con dinero en inglés se reemplaza por el «me falta» en inglés");
  ok(E.textoFinalTraslado("Son S/ 150", { accion: "derivar" }, { derivacion: derivEn, estilo: EN_TU }) === derivEn, "y el que trae dinero en castellano, también");
  // «total» + una cifra ya era dinero en castellano: el guard de siempre lo reemplaza igual.
  ok(E.textoFinalTraslado("The total would be 150", { accion: "derivar" }, { derivacion: "deriv", estilo: TU }) === "deriv", "en castellano, el guard de siempre");
  ok(E.textoFinalTraslado("free waiting time included", { accion: "derivar" }, { derivacion: "deriv", estilo: TU }) === "free waiting time included", "«free» solo cuenta con el inglés (en castellano pasa como siempre)");
  ok(E.textoFinalTraslado("free waiting time included", { accion: "derivar" }, { derivacion: derivEn, estilo: EN_TU }) === derivEn, "con el inglés, «free» es dinero");
  ok(E.textoFinalTraslado("Can you tell me your flight number?", { accion: "preguntar", faltan: [M.FALTA.pax] }, { derivacion: derivEn, estilo: EN_TU }) === "Can you tell me your flight number?", "un texto limpio del modelo pasa intacto");
  const cotEn = { numero: "00123", decision: "automatico" as const, total: "US$ 118.00", validez: "Nov 18, 2026" };
  ok(E.textoFinalTraslado("anything", { accion: "cotizar", cotizacion: cotEn }, { derivacion: derivEn, estilo: EN_TU }) === LIT_EN.auto, "con cotización, el texto del código en inglés");

  // (f) Invariante 6: mencionaDinero(x, "en") ⊇ mencionaDinero(x, "es").
  const SI_EN = ["the total would be 150", "around one hundred fifty dollars", "150 USD", "$150", "free waiting time", "20% off", "VAT included", "20 bucks", "it costs 80", "fee of 30", "20 percent discount", "price per leg is 45"];
  const NO_EN = ["2 people, 3 bags at 3 pm", "flight LA2045 at 14:30", "October 25", "feel free to ask", "drop off at the hotel", "about 2 hours", "around October 25", "we are 4 passengers", "pick up at 10:30 am", "the airport transfer", "Hello, I need a transfer from the airport tomorrow", "one way please"];
  for (const t of SI_EN) ok(T.mencionaDinero(t, "en"), `en inglés, «${t}» es dinero`);
  for (const t of NO_EN) ok(!T.mencionaDinero(t, "en"), `en inglés, «${t}» no es dinero`);
  const corpus = [...SI_EN, ...NO_EN, "El total sería 150 (IGV incluido)", "Total: 150.00 nuevos soles", "ciento cincuenta soles", "Te aplico 50 % de descuento", "€ 150", "serán aprox 300",
    "Te sale gratis el retorno", "Cuesta 120 por tramo", "¿Serían 4 pasajeros? ¿A qué hora aterriza tu vuelo, 10:30?", "Perfecto, son 3 maletas grandes y 2 pasajeros.", "Un ejecutivo revisará tu pedido", "", "   "];
  let sup = 0;
  for (const a of corpus) for (const b2 of ["", " ", " y ", ". ", " - "]) for (const c2 of corpus.slice(0, 8)) {
    const t = `${a}${b2}${c2}`;
    if (!T.mencionaDinero(t, "es") || T.mencionaDinero(t, "en")) sup++; else ok(false, `es sin en: «${t}»`);
  }
  ok(sup === corpus.length * 5 * 8, `mencionaDinero(x,"en") ⊇ mencionaDinero(x,"es") en ${sup} textos`);
  // textoLibreSospechoso / referenciaImprimible: inglés = castellano ∪ inglés; «transfer» nunca.
  for (const t of ["Hilton, pay to account 123", "Marriott, send via Western Union", "JW Marriott (paypal me)", "deposit at the bank"]) {
    ok(T.textoLibreSospechoso(t, "en") != null && T.referenciaImprimible(t, "en") === null, `en inglés, «${t}» es sospechoso`);
  }
  for (const t of ["Airport transfer to JW Marriott", "Hotel Belmond, Miraflores", "Hilton Garden Inn"]) ok(T.textoLibreSospechoso(t, "en") === null, `«${t}» se puede imprimir en inglés`);
  let supT = 0, totT = 0;
  for (const t of [...corpus, "Miraflores. Deposite S/ 50 al Yape 987 654 321", "www.pagos.pe", "Calle Los Pinos 123"]) { totT++; if (T.textoLibreSospechoso(t) == null || T.textoLibreSospechoso(t, "en") != null) supT++; }
  ok(supT === totT, `lo sospechoso en castellano lo es en inglés (${supT}/${totT})`);
  ok(E.planEnvio({ resultado: M.evaluarTraslado(pedido(), ctx), envioMaestro: true, zonas, canal: "whatsapp", waId: "51966707225", modoAuto: true, perfilConfigurado: true, cuadra: true, pdfOk: true, palabras: [], textosLibres: ["Marriott, pay to my account"] }).decision === "automatico"
    && E.planEnvio({ resultado: M.evaluarTraslado(pedido(), ctx), envioMaestro: true, zonas, canal: "whatsapp", waId: "51966707225", modoAuto: true, perfilConfigurado: true, cuadra: true, pdfOk: true, palabras: [], textosLibres: ["Marriott, pay to my account"], idioma: "en" }).motivos.join() === "texto_libre_sospechoso",
    "planEnvio juzga los textos libres con el inglés solo cuando la cotización va en inglés");
  ok(E.textosLibresSospechosos([{ campo: "recojo", texto: "pay to my account" }], "en")[0]?.motivo === "palabra_de_pago" && E.textosLibresSospechosos([{ campo: "recojo", texto: "pay to my account" }]).length === 0, "textosLibresSospechosos con el idioma");

  // (g) senalesEnTexto en inglés ⊇ castellano; en castellano no cambia.
  ok(JSON.stringify(E.senalesEnTexto(["it is for a wedding and a conference"], "en")) === JSON.stringify(["conference", "wedding"]), "wedding y conference en inglés");
  ok(E.senalesEnTexto(["we have an RFP and the terms of reference"], "en").includes("RFP") && E.senalesEnTexto(["we have an RFP and the terms of reference"], "en").includes("terms of reference"), "RFP y terms of reference");
  ok(E.senalesEnTexto(["any discount for a contract? it's a tender"], "en").length === 3 && E.senalesEnTexto(["a city tour or full day"], "en").length === 2, "discount, contract, tender; city tour y full day");
  ok(E.senalesEnTexto(["it is for a wedding"]).length === 0 && E.senalesEnTexto(["Adjunto los TDR"], "en").join() === "TDR", "en castellano el inglés no cuenta; en inglés el castellano sí");
  for (const t of ["Adjunto los TDR", "para un evento", "", "event", "wedding"]) {
    const es = E.senalesEnTexto([t]), en = E.senalesEnTexto([t], "en");
    ok(es.every((x) => en.includes(x)), `en ⊇ es («${t}»)`);
  }

  // (h) revisionPorCondiciones: la cotización en inglés con condiciones en castellano queda en revisión.
  const cEs = { incluye: [], no_incluye: [], generales: ["x"] }, cEn = { ...cEs, version: 2, idioma: "en" };
  ok(JSON.stringify(E.revisionPorCondiciones({ avisosPdf: [], consideraciones: cEs })) === JSON.stringify(E.revisionPorCondiciones({ avisosPdf: [], consideraciones: cEs, idiomaPdf: "es" })), "sin idiomaPdf (o «es»), lo de siempre");
  ok(E.revisionPorCondiciones({ avisosPdf: [], consideraciones: cEs, idiomaPdf: "en" }).motivos.join() === "condiciones_en_otro_idioma", "en inglés con condiciones en castellano → condiciones_en_otro_idioma");
  ok(E.revisionPorCondiciones({ avisosPdf: [], consideraciones: cEn, idiomaPdf: "en" }).motivos.length === 0, "en inglés con condiciones en inglés, nada");
  ok(E.revisionPorCondiciones({ avisosPdf: [], consideraciones: cEn, idiomaPdf: "es" }).motivos.length === 0, "en castellano, el idioma de las condiciones no se mira");
  ok(E.MOTIVO_REVISION.condiciones_en_otro_idioma.texto === "La cotización va en inglés pero sus condiciones salieron de una plantilla en castellano."
    && E.MOTIVO_REVISION.condiciones_en_otro_idioma.arreglo.includes("Traslado de la IA · inglés · soles") && E.MOTIVO_REVISION.condiciones_en_otro_idioma.arreglo.includes("/cotizaciones/plantillas"), "el motivo nuevo con su texto y su arreglo");

  // (i) estadoCotizadorIA con el inglés: sin la clave, las líneas de siempre; parcial → ámbar.
  const AMBAR = new Set(["sin_migracion", "agente_no_autonomo", "envio_sin_zonas"]);
  const agenteOk = { activo: true, canales: ["whatsapp"], canales_autonomos: ["whatsapp"] };
  let ne = 0;
  for (const sinMigracion of [false, true]) for (const iaCotiza of [false, true]) for (const envioMaestro of [false, true]) for (const zs of [[], ["Aeropuerto Jorge Chávez"]])
    for (const agente of [null, agenteOk, { ...agenteOk, canales_autonomos: [] }]) for (const ingles of [null, OFF, ON, SOLO_USD, { PEN: true, USD: false }]) {
      ne++;
      const base0 = { iaCotiza, envioMaestro, zonasConEnvio: zs, agente, sinMigracion };
      const e0 = E.estadoCotizadorIA(base0), e1 = E.estadoCotizadorIA({ ...base0, ingles });
      ok(e1.codigo === e0.codigo, "el inglés no cambia el código");
      const parcial = !!ingles && ingles.PEN !== ingles.USD;
      const llega = !sinMigracion && iaCotiza && !!agente;
      ok(e1.ambar === (AMBAR.has(e1.codigo) || (llega && parcial)), `ámbar ⟺ los de siempre o el inglés parcial (${e1.codigo}, ${JSON.stringify(ingles)})`);
      ok(llega ? e1.lineas.length === e0.lineas.length + 1 && JSON.stringify(e1.lineas.slice(0, -1)) === JSON.stringify(e0.lineas) : JSON.stringify(e1) === JSON.stringify(e0), "una línea más, al final, solo si la IA cotiza");
    }
  ok(E.estadoCotizadorIA({ iaCotiza: true, envioMaestro: true, zonasConEnvio: ["A"], agente: agenteOk, sinMigracion: false, ingles: null }).lineas.at(-1)!.includes("cotizaciones-09"), "sin la tabla nueva, nombra el SQL");
  ok(E.estadoCotizadorIA({ iaCotiza: true, envioMaestro: true, zonasConEnvio: ["A"], agente: agenteOk, sinMigracion: false, ingles: SOLO_USD }).lineas.at(-1)!.includes("Traslado de la IA · inglés · soles"), "parcial: nombra la celda que falta");
  console.log(`  barrido estadoCotizadorIA: ${ne}`);

  // (j) La fila y su PDF: sin idioma, byte a byte; en inglés, los textos del código en inglés.
  const p0 = pedido({ sentido: "ida_retorno", fecha_retorno: "2026-10-28", pax: 3, maletas: 2 });
  const r0 = M.evaluarTraslado(p0, ctx);
  const e0 = entradaDe(p0);
  const x0 = { convId: "c", clienteId: null, atencion: "Ana", config, firma: "f", hoy: HOY };
  const fEs = C.filaCotizacionTraslado(r0, e0, x0);
  ok(JSON.stringify(fEs) === JSON.stringify(C.filaCotizacionTraslado(r0, e0, { ...x0, idioma: "es" })) && fEs.idioma_pdf === "es" && !("idioma_cliente" in fEs.traslado_json)
    && fEs.items_json[0].descripcion.startsWith("TRASLADO IDA Y RETORNO · ") && fEs.items_json[0].descripcion.endsWith("pasajeros) · precio por tramo"), "sin idioma, la fila de siempre");
  const eEn = { ...e0, idioma_cliente: "en" as const };
  const fEn = C.filaCotizacionTraslado(r0, eEn, { ...x0, idioma: "en" });
  ok(fEn.idioma_pdf === "en" && fEn.traslado_json.idioma_cliente === "en" && fEn.items_json[0].descripcion === `TRANSFER ROUND TRIP · ${fEn.origen} – ${fEn.destino} · ${r0.vehiculo!.categoria!.nombre} (up to ${r0.vehiculo!.categoria!.capacidad} passengers) · price per leg`,
    `en inglés, la descripción del ítem (${fEn.items_json[0].descripcion})`);
  enIngles(fEn.items_json[0].descripcion, "descripción del ítem");
  ok(JSON.stringify({ ...fEn, idioma_pdf: "es", items_json: fEs.items_json, traslado_json: fEs.traslado_json }) === JSON.stringify(fEs), "lo demás de la fila no cambia con el idioma (importes, moneda, condiciones, cliente)");
  const fIda = C.filaCotizacionTraslado(M.evaluarTraslado(pedido(), ctx), entradaDe(pedido()), { ...x0, idioma: "en" });
  ok(fIda.items_json[0].descripcion.startsWith("TRANSFER ONE WAY · "), "solo ida → ONE WAY");
  const rPin = M.evaluarTraslado(pedido(), ctx);
  const ePin = { ...entradaDe(pedido()), destino: { lat: -12.131, lng: -77.03 } };
  ok(C.filaCotizacionTraslado(rPin, ePin, { ...x0, idioma: "en" }).destino === "Miraflores (shared location)" && C.filaCotizacionTraslado(rPin, ePin, x0).destino === "Miraflores (ubicación compartida)", "«(shared location)» / «(ubicación compartida)»");
  ok(C.filaCotizacionTraslado(rPin, { ...entradaDe(pedido()), destino: "Marriott, pay to my account" }, { ...x0, idioma: "en" }).destino === "Miraflores"
    && C.filaCotizacionTraslado(rPin, { ...entradaDe(pedido()), destino: "Marriott, pay to my account" }, x0).destino === "Miraflores (Marriott, pay to my account)", "la referencia se juzga con los guards del idioma de la fila");
  // considDeTraslado: «en» solo si la plantilla es inglesa.
  const plEs = { id: "pl_es", nombre: "Traslados", diseno: "corporativo", condiciones_generales: ["Espera de 30 min."], condiciones_incluye: [], condiciones_no_incluye: [] } as any;
  const plEn = { ...plEs, id: "pl_en", idioma: "en", condiciones_generales: ["30 minutes of free waiting time."] };
  ok(!("idioma" in C.considDeTraslado(plEs, config, "PEN")) && C.considDeTraslado(plEn, config, "PEN").idioma === "en" && !("idioma" in C.considDeTraslado(null, config, "PEN")), "considDeTraslado: «en» solo con una plantilla en inglés");
  // cifrasDeFila, caption y archivo en el idioma de la fila.
  const leidaEn = { ...fEn, id: 5 }, leidaEs = { ...fEs, id: 5 };
  const ce = C.cifrasDeFila(leidaEn)!, cs = C.cifrasDeFila(leidaEs)!;
  ok(cs.total.startsWith("S/ ") && /^\d{2}\/\d{2}\/\d{4}$/.test(cs.validez!) && JSON.stringify(cs) === JSON.stringify(C.cifrasDeFila({ ...leidaEs, idioma_pdf: undefined } as any)), `en castellano, las cifras de siempre (${cs.total} · ${cs.validez})`);
  ok(JSON.stringify(ce.figuras) === JSON.stringify(cs.figuras) && /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(ce.validez!) && ce.total.replace(/[^\d.]/g, "") === cs.total.replace(/[^\d.]/g, ""), `en inglés, las MISMAS figuras y la validez con el mes en letras (${ce.total} · ${ce.validez})`);
  ok(C.nombreArchivoPdf("00123", "en") === "Quotation-00123.pdf" && C.nombreArchivoPdf("00123") === "Cotizacion-00123.pdf" && C.nombreArchivoPdf("", "en") === "Quotation-transfer.pdf", "el nombre del archivo en el idioma");
  const emp = empresaConDefectos({ nombre: "Empresa de Prueba SAC" } as any);
  ok(C.captionDocumento({ id: 5, numero_cotizacion: "00123", origen: "a", destino: "b", idioma_pdf: "en" }, emp).startsWith("Quotation No. 00123 · a → b")
    && C.captionDocumento({ id: 5, numero_cotizacion: "00123", origen: "a", destino: "b" }, emp).startsWith("Cotización N° 00123 · a → b"), "el caption en el idioma de la fila");
  // La descripción de la unidad: en inglés, nunca la de castellano.
  const catX = { nombre: "Minivan H1 10 pax", capacidad: 10, maletas_bodega: 4, descripcion_cliente: "- Aire acondicionado\n- Asientos reclinables", descripcion_cliente_en: null as string | null };
  ok(C.descripcionCategoria(catX, "en") === "Minivan H1 for up to 10 passengers · luggage hold for 4 large (23 kg) suitcases" && C.descripcionCategoria(catX) === "- Aire acondicionado\n- Asientos reclinables", "sin descripción en inglés: la frase del sistema en inglés, nunca la de castellano");
  ok(C.descripcionCategoria({ ...catX, descripcion_cliente_en: " - Air conditioning \n\n - Reclining seats " }, "en") === "- Air conditioning\n- Reclining seats", "con descripción en inglés, la escrita, limpia");
  ok(C.descripcionCategoria({ nombre: "Auto", capacidad: 1, maletas_bodega: 1, descripcion_cliente: null }, "en") === "Auto for up to 1 passenger · luggage hold for 1 large (23 kg) suitcase", "singulares en inglés");
  enIngles(C.descripcionCategoria(catX, "en"), "descripción de la unidad");
  ok(C.vehiculoDeCategoria({ clave: "H1", ...catX }, { idioma: "en" })!.descripcion_unidad === C.descripcionCategoria(catX, "en") && C.vehiculoDeCategoria({ clave: "H1", ...catX })!.descripcion_unidad === C.descripcionCategoria(catX), "vehiculoDeCategoria con el idioma");
  // La entrada del PDF.
  const pdfEs = C.entradaCorporativaTraslado(leidaEs, { empresa: null, ahoraMs: Date.parse("2026-10-19T15:00:00Z") });
  ok(JSON.stringify(pdfEs) === JSON.stringify(C.entradaCorporativaTraslado({ ...leidaEs, idioma_pdf: undefined } as any, { empresa: null, ahoraMs: Date.parse("2026-10-19T15:00:00Z") }))
    && pdfEs.idioma === "es" && pdfEs.cot.idioma_pdf === "es" && pdfEs.notaTotales === C.LINEA_DISPONIBILIDAD && !("itemsEnIdioma" in pdfEs) && !("version" in (pdfEs.consid as object)), "en castellano, la entrada de siempre");
  const pdfEn = C.entradaCorporativaTraslado(leidaEn, { empresa: null, ahoraMs: Date.parse("2026-10-19T15:00:00Z") });
  ok(pdfEn.idioma === "en" && pdfEn.cot.idioma_pdf === "en" && pdfEn.notaTotales === L_EN && pdfEn.itemsEnIdioma === true && !("version" in (pdfEn.consid as object)), "en inglés: idioma, la línea en inglés, los ítems ya en inglés; condiciones de Ajustes sin marca");
  const leidaEnCond = { ...leidaEn, consideraciones_json: C.considDeTraslado(plEn, config, "PEN") };
  const pdfEnCond = C.entradaCorporativaTraslado(leidaEnCond, { empresa: null, ahoraMs: Date.parse("2026-10-19T15:00:00Z") });
  ok((pdfEnCond.consid as any).version === 2 && (pdfEnCond.consid as any).idioma === "en", "con las condiciones de una plantilla en inglés, van marcadas (se imprimen tal cual)");
  ok(C.entradaCorporativaTraslado({ ...leidaEn, items_json: [{ dias: 1, cantidad: 1, precio_unit: 100, descuento_pct: 0 }] }, { empresa: null }).items[0].descripcion === "Transfer", "el ítem sin descripción cae a «Transfer»");
  // respuestaParaModelo: el total y la validez como los verá el cliente.
  const rCot = M.evaluarTraslado(pedido({ telefono: "+13055551234" }), ctx);
  const resEs = JSON.parse(E.respuestaParaModelo({ resultado: rCot, cotizacion: { numero: "1", decision: "automatico" } }));
  const resEn = JSON.parse(E.respuestaParaModelo({ resultado: rCot, cotizacion: { numero: "1", decision: "automatico" }, idioma: "en" }));
  ok(E.respuestaParaModelo({ resultado: rCot, cotizacion: { numero: "1", decision: "automatico" } }) === E.respuestaParaModelo({ resultado: rCot, cotizacion: { numero: "1", decision: "automatico" }, idioma: "es" }), "respuestaParaModelo: «es» = sin idioma");
  ok(/^\d{2}\/\d{2}\/\d{4}$/.test(resEs.cotizacion.validez) && /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(resEn.cotizacion.validez) && resEn.instruccion.includes(L_EN.charAt(0).toLowerCase() + L_EN.slice(1)), `respuestaParaModelo en inglés (${resEn.cotizacion.total} · ${resEn.cotizacion.validez})`);
}

// ── 25. El cableado del inglés: la plantilla de la celda, el interruptor y la cotización de punta a punta ──
// Lo que la sección 24 fija sobre los motores puros, aquí sobre la base falsa: (a) plantillaParaTraslado
// con la tabla de cotizaciones-09 elige por idioma × moneda y no lee al cliente; sin la tabla, la regla
// vieja; (b) leerInglesTraslado; (c) un cliente que escribe en inglés desde un +51 recibe la cotización
// en INGLÉS y en DÓLARES (fila, condiciones, PDF, nombre del archivo, caption, tarjeta); (d) con el
// inglés encendido, un cliente en castellano recibe EXACTAMENTE la fila de antes; (e) el inglés solo
// en dólares + «en soles» → soles y revisión por condiciones en castellano; (f) sin la columna
// idioma_pdf una cotización en inglés no se guarda a medias; (g) el idioma lo decide el código.
seccion("25. Inglés de punta a punta: plantilla por idioma × moneda, interruptor y cotización en inglés");
{
  const { plantillaParaTraslado, leerInglesTraslado } = await import("../lib/traslados/plantilla-traslado-datos");
  type Plantilla = import("../lib/cotizacion-plantillas").PlantillaFila;
  type Regla = import("../lib/cotizacion-plantillas").ReglaPlantilla;
  type ReglaT = import("../lib/cotizacion-plantillas").ReglaTraslado;
  class SbLog extends SbFalso {
    lecturas: string[] = [];
    from(tabla: string): any { this.lecturas.push(tabla); return super.from(tabla); }
  }
  const CORP: Plantilla = {
    id: "corporativo", nombre: "Corporativo", es_principal: true, activa: true, diseno: "corporativo", idioma: "es", orden: 1,
    condiciones_generales: ["GENERAL DE LA CORPORATIVA"], condiciones_incluye: ["INCLUYE DE LA CORPORATIVA"], condiciones_no_incluye: ["NO INCLUYE DE LA CORPORATIVA"],
    mostrar_cuentas_bancarias: true, usar_bancos_propios: true, banco_1_nombre: "BCP", banco_1_cuenta: "191-1234567-0-12", banco_1_cci: "002-191-001234567012-55",
  };
  const TIA: Plantilla = { ...CORP, id: "traslados_ia", nombre: "Traslados (IA)", es_principal: false, orden: 2, condiciones_generales: ["CONDICIÓN DEL TRASLADO"], condiciones_incluye: ["Conductor profesional"], condiciones_no_incluye: ["Parqueo del aeropuerto"] };
  const EN: Plantilla = {
    ...CORP, id: "traslados_ia_en", nombre: "Transfers (AI) · English", es_principal: false, idioma: "en", orden: 3,
    condiciones_generales: ["ENGLISH GENERAL TERM"], condiciones_incluye: ["Professional driver"], condiciones_no_incluye: ["Airport parking"],
  };
  const REGLAS: Regla[] = [
    { servicio: "traslado_ia", segmento: "empresa", plantilla_id: "traslados_ia" },
    { servicio: "traslado_ia", segmento: "particular", plantilla_id: "traslados_ia" },
    { servicio: "traslado_ia", segmento: "extranjero", plantilla_id: "traslados_ia" },
  ];
  const CELDAS_ES: ReglaT[] = [{ idioma: "es", moneda: "PEN", plantilla_id: "traslados_ia" }, { idioma: "es", moneda: "USD", plantilla_id: "traslados_ia" }];
  const CELDAS_ON: ReglaT[] = [...CELDAS_ES, { idioma: "en", moneda: "PEN", plantilla_id: "traslados_ia_en" }, { idioma: "en", moneda: "USD", plantilla_id: "traslados_ia_en" }];
  const CELDAS_SOLO_USD: ReglaT[] = [...CELDAS_ES, { idioma: "en", moneda: "USD", plantilla_id: "traslados_ia_en" }];
  const INGLES = [
    "Hi, I need a transfer from the airport to my hotel in Miraflores, please",
    "We are two people with one suitcase and we arrive on the morning flight",
    "Could you send me the price? Thank you very much",
  ];
  /** La base de la sección 17 con plantillas, reglas viejas y (si se pide) la tabla de cotizaciones-09. */
  const base = (x: { celdas?: ReglaT[] | null; mensajes?: string[]; plantillas?: Plantilla[] } = {}) => {
    const sb = new SbLog(() => reloj);
    Object.assign(sb.tablas, nuevaBase().tablas);
    sb.tablas.cotizacion_plantillas = (x.plantillas ?? [CORP, TIA, EN]).map((p) => ({ ...p }));
    sb.tablas.cotizacion_plantilla_reglas = REGLAS.map((r) => ({ ...r }));
    if (x.celdas !== null && x.celdas !== undefined) sb.tablas.cotizacion_plantilla_reglas_traslado = x.celdas.map((r) => ({ ...r }));
    if (x.mensajes) {
      sb.tablas.crm_mensajes = x.mensajes.map((c, i) => ({ id: `mi${i}`, conversacion_id: "cv-1", direccion: "entrante", tipo: "texto", contenido: c, created_at: new Date(reloj - (x.mensajes!.length - i) * 60_000).toISOString() }));
    }
    sb.tablas.traslado_categorias = sb.tablas.traslado_categorias.map((c) => ({ ...c, descripcion_cliente_en: "ENGLISH UNIT DESCRIPTION" }));
    return sb;
  };
  const clientesLeidos = (sb: SbLog) => sb.lecturas.filter((t) => t === "clientes").length;

  // (a) plantillaParaTraslado con la regla idioma × moneda.
  {
    const sb1 = base({ celdas: CELDAS_ON });
    const r1 = await plantillaParaTraslado(sb1, { moneda: "PEN", clienteId: 7 });
    ok(r1.ok && r1.codigo === "regla" && r1.plantilla?.id === "traslados_ia" && r1.celda?.idioma === "es" && r1.celda?.moneda === "PEN" && r1.idiomaCondiciones === "es",
      `castellano/soles: la celda (${r1.ok ? `${r1.codigo} ${r1.plantilla?.id}` : r1.detalle})`);
    ok(r1.ok && JSON.stringify(r1.ingles) === JSON.stringify({ PEN: true, USD: true }), "y dice en qué monedas está encendido el inglés");
    ok(clientesLeidos(sb1) === 0, "con la regla idioma × moneda el tipo del cliente no decide: no se lee");
    const r2 = await plantillaParaTraslado(base({ celdas: CELDAS_ON }), { moneda: "USD", clienteId: null, idioma: "en" });
    ok(r2.ok && r2.codigo === "regla" && r2.plantilla?.id === "traslados_ia_en" && r2.celda?.idioma === "en" && r2.celda?.moneda === "USD" && r2.idiomaCondiciones === "en",
      `inglés/dólares: la plantilla en inglés (${r2.ok ? `${r2.codigo} ${r2.plantilla?.id}` : r2.detalle})`);
    const r3 = await plantillaParaTraslado(base({ celdas: CELDAS_SOLO_USD }), { moneda: "PEN", clienteId: null, idioma: "en" });
    ok(r3.ok && r3.codigo === "sin_plantilla_idioma" && r3.plantilla?.id === "traslados_ia" && r3.idiomaCondiciones === "es",
      `inglés/soles sin plantilla inglesa: la de castellano, dicho (${r3.ok ? `${r3.codigo} ${r3.plantilla?.id}` : r3.detalle})`);
    const r4 = await plantillaParaTraslado(base({ celdas: null }), { moneda: "PEN", clienteId: null, idioma: "en" });
    ok(r4.ok && r4.celda === null && r4.ingles === null && r4.plantilla?.id === "traslados_ia" && r4.codigo === "regla",
      `sin cotizaciones-09: la regla vieja por segmento y sin inglés (${r4.ok ? `${r4.codigo} ${r4.plantilla?.id}` : r4.detalle})`);
    const r5 = await plantillaParaTraslado(base({ celdas: CELDAS_ES }), { moneda: "USD", clienteId: null });
    ok(r5.ok && JSON.stringify(r5.ingles) === JSON.stringify({ PEN: false, USD: false }), "la tabla sin celdas en inglés: el inglés apagado (no null)");
    const sb6 = base({ celdas: CELDAS_ON }); sb6.fallas.push({ tabla: "cotizacion_plantilla_reglas_traslado", op: "select", mensaje: "timeout" });
    const r6 = await plantillaParaTraslado(sb6, { moneda: "PEN", clienteId: null });
    ok(!r6.ok && /idioma/.test(r6.detalle) && /timeout/.test(r6.detalle), "la tabla nueva ilegible: ok:false con el motivo (no «sin reglas»)");
  }

  // (b) leerInglesTraslado.
  {
    const a = await leerInglesTraslado(base({ celdas: null }));
    ok(a.ok && a.ingles === null, "sin la tabla: ingles null");
    const b = await leerInglesTraslado(base({ celdas: CELDAS_SOLO_USD }));
    ok(b.ok && b.ingles?.PEN === false && b.ingles?.USD === true, "solo dólares asignado: {PEN:false, USD:true}");
    const c = await leerInglesTraslado(base({ celdas: CELDAS_ON, plantillas: [CORP, TIA, { ...EN, activa: false }] }));
    ok(c.ok && c.ingles?.PEN === false && c.ingles?.USD === false, "la plantilla inglesa desactivada no enciende nada");
    const d = await leerInglesTraslado(base({ celdas: CELDAS_ON, plantillas: [CORP, TIA, { ...EN, idioma: "es_en" }] }));
    ok(d.ok && d.ingles?.PEN === false && d.ingles?.USD === false, "una plantilla «es_en» (la ejecutiva) no cuenta como inglés");
    const sbE = base({ celdas: CELDAS_ON }); sbE.fallas.push({ tabla: "cotizacion_plantillas", op: "select", mensaje: "sin conexión" });
    const e = await leerInglesTraslado(sbE);
    ok(!e.ok && /sin conexión/.test(e.detalle), "plantillas ilegibles: ok:false");
  }

  const deps25 = { simular: simularFalso({ n: 0 }) as any, bajarLogo: async () => null, ahoraMs: () => reloj, azar: () => String(Math.random()).slice(2, 8) };
  const corrida = async (sb: SbFalso, input: any = pedidoIA, ctxExtra: Partial<CtxCotizarIA> = {}) => {
    const res = await cotizarTrasladoIA({ ...ctxDe(sb, "cv-1", "ct-1"), ...ctxExtra }, input, deps25);
    return { res, fila: sb.t("cotizaciones").at(-1) as any, pdf: res.envioPendiente ? textoDelPdf(res.envioPendiente.bytes) : null };
  };

  // (c) De punta a punta en inglés, desde un +51.
  {
    const sb = base({ celdas: CELDAS_ON, mensajes: INGLES });
    const c = await corrida(sb);
    ok(c.res.accion === "cotizar" && c.res.cotizacion?.decision === "automatico" && !!c.res.envioPendiente,
      `inglés: cotiza y sale solo (${c.res.cotizacion?.decision} ${JSON.stringify(c.res.derivar ?? "")} ${JSON.stringify(sb.t("crm_acciones_ia").at(-1)?.payload?.motivos ?? "")})`);
    ok(c.fila?.idioma_pdf === "en" && c.fila?.moneda === "USD", `la fila en inglés y en dólares aunque el número es +51 (${c.fila?.idioma_pdf} ${c.fila?.moneda})`);
    ok(c.fila?.plantilla_pdf === "traslados_ia_en" && c.fila?.consideraciones_json?.idioma === "en" && c.fila.consideraciones_json.generales.join() === "ENGLISH GENERAL TERM",
      `las condiciones de la plantilla en inglés, marcadas en inglés (${c.fila?.plantilla_pdf} ${JSON.stringify(c.fila?.consideraciones_json)})`);
    ok(c.fila?.traslado_json?.idioma_cliente === "en", "la evidencia (idioma_cliente) queda en traslado_json");
    ok(/^Quotation-.+\.pdf$/.test(c.res.envioPendiente?.nombre ?? "") && /Quotation No\./.test(c.res.envioPendiente?.caption ?? ""),
      `nombre y caption en inglés (${c.res.envioPendiente?.nombre} · ${c.res.envioPendiente?.caption})`);
    ok(c.res.cotizacion?.idioma === "en" && /^US\$|USD|\$/.test(c.res.cotizacion?.total ?? ""), `la cotización del turno dice su idioma y el total en dólares (${c.res.cotizacion?.total})`);
    ok(/[A-Z][a-z]{2} \d{1,2}, \d{4}/.test(c.res.cotizacion?.validez ?? ""), `la validez con el mes en letras (${c.res.cotizacion?.validez})`);
    const acc = sb.t("crm_acciones_ia").at(-1);
    ok(acc?.payload?.idioma === "en", "la tarjeta de la bandeja lleva idioma: en");
    ok((c.pdf ?? "").includes("ENGLISH GENERAL TERM") && (c.pdf ?? "").includes("ENGLISH UNIT DESCRIPTION") && !(c.pdf ?? "").includes("CONDICIÓN DEL TRASLADO"),
      "el PDF imprime las condiciones en inglés y la unidad descrita en inglés, ninguna de castellano");
    const re = await pdfDeCotizacion(sb as any, c.fila.id, { bajarLogo: async () => null });
    ok(textoDelPdf(re.bytes) === c.pdf && re.nombre === c.res.envioPendiente?.nombre, "la relectura imprime lo mismo y con el mismo nombre");
  }
  {
    // Sin la columna de traslados-10, la unidad en inglés sale con la frase del sistema y NO se dice
    // «falta el SQL de las fotos» (es otra migración).
    // (La base falsa devuelve la fila entera, no las columnas pedidas: sin la columna, la fila tampoco la trae.)
    const sb = base({ celdas: CELDAS_ON, mensajes: INGLES }); sb.faltan.traslado_categorias = ["descripcion_cliente_en"];
    for (const c of sb.t("traslado_categorias")) delete c.descripcion_cliente_en;
    const c = await corrida(sb);
    ok(c.res.cotizacion?.decision === "automatico" && !(c.pdf ?? "").includes("ENGLISH UNIT DESCRIPTION"), `sin descripcion_cliente_en: sale igual, sin esa frase (${c.res.cotizacion?.decision})`);
    const re = await pdfDeCotizacion(sb as any, c.fila.id, { bajarLogo: async () => null });
    ok(!re.avisos.some((a) => a.codigo === "sin_migracion_fotos"), `y sin el aviso de las fotos (${re.avisos.map((a) => a.codigo).join()})`);
  }

  // (d) Con el inglés encendido, un cliente en castellano: la fila de siempre.
  {
    const sbOn = base({ celdas: CELDAS_ON }), sbOff = base({ celdas: null });
    const encendido = await corrida(sbOn);
    const sinTabla = await corrida(sbOff);
    ok(JSON.stringify(sbOn.t("crm_acciones_ia").at(-1)?.payload) === JSON.stringify(sbOff.t("crm_acciones_ia").at(-1)?.payload) && !("idioma" in (sbOn.t("crm_acciones_ia").at(-1)?.payload ?? {})),
      "la tarjeta en castellano: el payload de siempre, sin la clave idioma");
    ok(encendido.fila?.idioma_pdf === "es" && encendido.fila?.moneda === "PEN" && encendido.fila?.plantilla_pdf === "traslados_ia", `castellano con el inglés encendido: castellano y soles (${encendido.fila?.idioma_pdf} ${encendido.fila?.moneda})`);
    ok(JSON.stringify(encendido.fila) === JSON.stringify(sinTabla.fila), "la misma fila que sin la tabla de cotizaciones-09");
    ok(!!encendido.pdf && encendido.pdf === sinTabla.pdf && encendido.res.envioPendiente?.nombre === sinTabla.res.envioPendiente?.nombre, "el mismo PDF y el mismo nombre");
    const enc = encendido.res.cotizacion;
    ok(enc?.idioma === "es" && /^S\//.test(enc?.total ?? ""), `el total en soles (${enc?.total})`);
  }

  // (e) El inglés solo en dólares, y el cliente pide soles: soles, condiciones en castellano → revisión.
  {
    const sb = base({ celdas: CELDAS_SOLO_USD, mensajes: [...INGLES, "Can you quote it in soles please?"] });
    const c = await corrida(sb, { ...pedidoIA, cliente_pide_soles: true });
    ok(c.fila?.idioma_pdf === "en" && c.fila?.moneda === "PEN", `pide soles en inglés: soles y en inglés (${c.fila?.idioma_pdf} ${c.fila?.moneda})`);
    ok(c.res.cotizacion?.decision === "revision" && !c.res.envioPendiente && (sb.t("crm_acciones_ia").at(-1)?.payload?.motivos ?? []).includes("condiciones_en_otro_idioma"),
      `sin plantilla inglesa en soles: revisión por condiciones en castellano (${JSON.stringify(sb.t("crm_acciones_ia").at(-1)?.payload?.motivos)})`);
    const nota = String(sb.t("crm_notas").at(-1)?.texto ?? "");
    ok(/escribe en inglés/.test(nota) && /pide la cotización en soles/.test(nota) && /INGLÉS/.test(nota), "la nota del ejecutivo dice el idioma y el pedido de soles");
    // Sin «soles» en sus mensajes, la marca del modelo no basta: dólares y la plantilla inglesa.
    const sb2 = base({ celdas: CELDAS_SOLO_USD, mensajes: INGLES });
    const c2 = await corrida(sb2, { ...pedidoIA, cliente_pide_soles: true });
    ok(c2.fila?.moneda === "USD" && c2.fila?.plantilla_pdf === "traslados_ia_en" && c2.res.cotizacion?.decision === "automatico", `pide soles solo el modelo: dólares (${c2.fila?.moneda})`);
  }

  // (f) Sin la columna idioma_pdf: la cotización en inglés no se guarda; en castellano sí, como antes.
  {
    const sb = base({ celdas: CELDAS_ON, mensajes: INGLES }); sb.faltan.cotizaciones = ["idioma_pdf"];
    const c = await corrida(sb);
    ok(c.res.accion === "derivar" && /cotizaciones-04/.test(c.res.derivar?.motivo ?? "") && sb.t("cotizaciones").length === 0, `inglés sin idioma_pdf: deriva sin guardar (${c.res.derivar?.motivo})`);
    const sbE = base({ celdas: CELDAS_ON }); sbE.faltan.cotizaciones = ["idioma_pdf"];
    const e = await corrida(sbE);
    ok(e.res.accion === "cotizar" && !("idioma_pdf" in (e.fila ?? {})), `castellano sin idioma_pdf: se guarda sin ella (${e.res.accion})`);
  }

  // (g) El idioma lo decide el código: el input del modelo no lo mueve; el del agente (ctx.idioma) sí.
  {
    const trampa = { ...pedidoIA, idioma: "en", idioma_cliente: "en", moneda: "USD", pide_soles: true, telefono: "+447700900123" };
    const c = await corrida(base({ celdas: CELDAS_ON }), trampa);
    ok(c.fila?.idioma_pdf === "es" && c.fila?.moneda === "PEN", `el input del modelo no cambia idioma ni moneda (${c.fila?.idioma_pdf} ${c.fila?.moneda})`);
    const d = await corrida(base({ celdas: CELDAS_ON }), pedidoIA, { idioma: { cliente: "en", ingles: { PEN: true, USD: true } } });
    ok(d.fila?.idioma_pdf === "en" && d.fila?.moneda === "USD", `el idioma que calculó el agente manda sobre la detección (${d.fila?.idioma_pdf} ${d.fila?.moneda})`);
    const e = await corrida(base({ celdas: CELDAS_ON, mensajes: INGLES }), pedidoIA, { idioma: { cliente: "en", ingles: null } });
    ok(e.fila?.idioma_pdf === "es" && e.fila?.moneda === "PEN", "con el inglés apagado (ingles: null) el agente no lo enciende");
    const f = await corrida(base({ celdas: null, mensajes: INGLES }));
    ok(f.fila?.idioma_pdf === "es" && f.fila?.moneda === "PEN" && !("idioma" in (f.fila?.consideraciones_json ?? {})), "sin cotizaciones-09, un cliente en inglés sigue en castellano (lo de siempre)");
    // El mismo pedido en castellano y luego en inglés: dos firmas (no se le contesta «ya te la envié»).
    const sbF = base({ celdas: CELDAS_ON });
    await corrida(sbF);
    const g = await corrida(sbF, pedidoIA, { idioma: { cliente: "en", ingles: { PEN: true, USD: true } } });
    ok(sbF.t("cotizaciones").length === 2 && g.fila?.idioma_pdf === "en", `castellano y después inglés: otra cotización (${sbF.t("cotizaciones").length})`);
  }

  // (h) El idioma del SIMULADOR (lib/traslados/simular-idioma.ts): el mismo interruptor que la IA, y una
  //     lectura que falla NO es un inglés apagado.
  {
    const SI = await import("../lib/traslados/simular-idioma");
    const ent = (x: Partial<EntradaSimulador> = {}): EntradaSimulador => ({ origen: "Aeropuerto Jorge Chávez", destino: "Miraflores", telefono: "51966707225", ...x } as EntradaSimulador);
    const ON = { PEN: true, USD: true }, SOLO_USD = { PEN: false, USD: true }, OFF = { PEN: false, USD: false };
    const ahora = Date.parse("2026-10-23T15:00:00Z");
    const caso = (x: Partial<Parameters<typeof SI.idiomaDeLaSimulacion>[1]>, e = ent()) =>
      SI.idiomaDeLaSimulacion(e, { mensajes: null, idiomaPedido: undefined, pideSoles: false, ingles: ON, errorIngles: null, ...x }, ahora);
    const ordenChat = [...INGLES.slice(0, 2), "Hola, en realidad quiero el traslado mañana temprano por favor"];
    // Orden del chat (antiguo → reciente): dos en inglés y uno en castellano → mayoría inglés.
    const a = caso({ mensajes: ordenChat });
    ok(a.idioma.codigo === "ingles" && a.idioma.idioma === "en" && a.entrada.idioma_cliente === "en", `mensajes en el orden del chat: inglés por mayoría (${a.idioma.codigo})`);
    const b = caso({ mensajes: ["Hola, quiero un traslado al aeropuerto", "¿Cuánto cuesta para dos personas?"] });
    ok(b.idioma.codigo === "castellano" && b.idioma.idioma === "es" && !("idioma_cliente" in b.entrada), "en castellano: sin idioma_cliente");
    const c = caso({ mensajes: INGLES, errorIngles: "timeout" });
    ok(c.idioma.codigo === "no_se_pudo_leer" && c.idioma.idioma === "es" && /timeout/.test(c.idioma.detalle) && !("idioma_cliente" in c.entrada) && !/apagado/i.test(c.idioma.detalle),
      `una lectura fallida: no_se_pudo_leer con el error, en castellano, y no dice «apagado» (${c.idioma.detalle})`);
    const d = caso({ mensajes: INGLES, ingles: null });
    ok(d.idioma.codigo === "ingles_apagado" && /cotizaciones-09/.test(d.idioma.detalle), "sin la tabla: ingles_apagado nombrando el SQL");
    const e = caso({ mensajes: INGLES, ingles: OFF });
    ok(e.idioma.codigo === "ingles_apagado" && /ninguna celda/.test(e.idioma.detalle), "sin celda inglesa: ingles_apagado");
    const f = caso({ mensajes: INGLES, ingles: SOLO_USD, pideSoles: true });
    ok(f.idioma.idioma === "en" && f.entrada.idioma_cliente === "en" && f.entrada.pide_soles === true, "pide_soles suelto (sin idioma_cliente) cuenta con el cliente en inglés");
    const g = caso({ mensajes: ["Hola, quiero un traslado al aeropuerto"], pideSoles: true });
    ok(!("pide_soles" in g.entrada), "en castellano, pide_soles no cuenta");
    const h = caso({ idiomaPedido: "otro" });
    ok(h.idioma.codigo === "otro_idioma" && h.entrada.idioma_cliente === "otro", "sin mensajes vale idioma_cliente");
    const h2 = caso({ mensajes: INGLES, idiomaPedido: "es" });
    ok(h2.idioma.codigo === "ingles", "con mensajes, los mensajes mandan sobre idioma_cliente");
    const i = caso({ mensajes: INGLES, pideSoles: true }, ent({ pide_dolares: true }));
    ok(!("pide_soles" in i.entrada) && !("pide_dolares" in i.entrada), "soles y dólares a la vez: ninguno (el defecto del idioma)");
    const j = caso({}, ent({ idioma_cliente: "en", pide_soles: true }));
    ok(j.idioma.codigo === "sin_evidencia" && !("idioma_cliente" in j.entrada) && !("pide_soles" in j.entrada), "la entrada validada no cuela idioma_cliente ni pide_soles por su cuenta");
    // El cuerpo.
    ok(JSON.stringify(SI.mensajesDelCuerpo({})) === JSON.stringify({ ok: true, mensajes: null }), "sin mensajes_cliente: null");
    ok(!SI.mensajesDelCuerpo({ mensajes_cliente: "hola" }).ok && !SI.mensajesDelCuerpo({ mensajes_cliente: ["a", 3] }).ok, "mensajes_cliente que no es una lista de textos: error");
    ok(!SI.mensajesDelCuerpo({ mensajes_cliente: Array(SI.MAX_MENSAJES_CLIENTE + 1).fill("x") }).ok, "más de 10 mensajes: error");
    const largo = SI.mensajesDelCuerpo({ mensajes_cliente: ["😀".repeat(600), "   ", "ok"] });
    ok(largo.ok && largo.mensajes!.length === 2 && Array.from(largo.mensajes![0]).length === SI.MAX_CARACTERES_MENSAJE, "cada texto se recorta a 500 caracteres completos y los vacíos se quitan");
    // La ruta: el error de la lectura llega al motor, y nunca se escribe nada con los mensajes.
    const q = (x: string) => x.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const ruta = q(readFileSync("app/api/traslados/simular/route.ts", "utf8"));
    ok(/if \(li\.ok\) ingles = li\.ingles; else errorIngles = li\.detalle/.test(ruta) && /idiomaDeLaSimulacion\(v\.entrada, \{[^}]*errorIngles \}\)/.test(ruta),
      "ruta: el error de leerInglesTraslado viaja como errorIngles");
    ok(!/\.insert\(|\.update\(|\.upsert\(/.test(ruta), "ruta: el simulador no escribe en la base");
  }
}

// ── 26. Revisión de seguridad S1 (23-10-2026): instrucciones de pago en el texto libre y dinero en el texto del modelo ──
seccion("26. S1 · hallazgos 1 y 2: lo nuevo bloquea lo que pasaba y deja pasar lo legítimo; nuevo ⊇ viejo, con cada divergencia DECLARADA");
// El algoritmo de ANTES de la revisión S1, COPIADO LITERAL de lib/traslados/texto-libre.ts (sin sus
// comentarios). Lo nuevo solo puede ser MÁS estricto: todo lo que el viejo bloqueaba lo bloquea el
// nuevo, y lo que el nuevo bloquea de más tiene que estar en las listas declaradas de abajo.
const VIEJO_TL = (() => {
  const MAX_REFERENCIA = 80;
  const MAX_ATENCION = 60;
  const minusculas = (s: string): string =>
    String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const porPalabra = (s: string): string => ` ${minusculas(s).replace(/[^a-z0-9]+/g, " ").trim()} `;
  const SIMBOLO = String.raw`(?:S\/\.?|US\$|U\$S|USD|PEN|\$|soles?|d[oó]lares?)`;
  const NUM = String.raw`(\d[\d.,]*)`;
  const IMPORTE_PREFIJO = new RegExp(String.raw`(?:^|[^A-Za-z0-9])${SIMBOLO}\s*${NUM}`, "gi");
  const IMPORTE_SUFIJO = new RegExp(String.raw`${NUM}\s*(?:soles?|d[oó]lares?|USD|PEN|S\/)(?![A-Za-z])`, "gi");
  function leerImporte(s: string): number | null {
    let t = String(s ?? "").replace(/[.,]+$/, "");
    if (!t) return null;
    const tienePunto = t.includes("."), tieneComa = t.includes(",");
    if (tienePunto && tieneComa) {
      const dec = t.lastIndexOf(".") > t.lastIndexOf(",") ? "." : ",";
      const miles = dec === "." ? "," : ".";
      t = t.split(miles).join("").replace(dec, ".");
    } else if (tieneComa) {
      t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
    } else if (tienePunto && /^\d{1,3}(\.\d{3}){2,}$/.test(t)) {
      t = t.replace(/\./g, "");
    }
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  function importesEnTexto(texto: string): number[] {
    const out: number[] = [];
    const s = String(texto ?? "");
    for (const re of [IMPORTE_PREFIJO, IMPORTE_SUFIJO]) {
      re.lastIndex = 0;
      for (const m of s.matchAll(re)) {
        const n = leerImporte(m[1]);
        if (n != null) out.push(n);
      }
    }
    return out;
  }
  const MONEDA = String.raw`(?:nuevos?\s+soles|soles?|dolares?(?:\s+americanos)?|euros?|usd|pen|eur|us\$|u\$s?|s\/\.?|\$|€)`;
  const CIFRA = String.raw`\d+(?:[.,]\d+)*`;
  const PALABRA_NUMERO = String.raw`(?:cero|un[oa]?|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieci[a-z]+|veinte|veinti[a-z]+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|quinient[oa]s|[a-z]+cient[oa]s|mil|millon(?:es)?)`;
  const EN_LETRAS = String.raw`${PALABRA_NUMERO}(?:\s+(?:y\s+)?${PALABRA_NUMERO})*`;
  const MONTO = String.raw`(?:${CIFRA}|${EN_LETRAS})`;
  const MONEDA_Y_MONTO = new RegExp(String.raw`(?:^|[^a-z0-9])${MONEDA}\s*${MONTO}(?![a-z0-9])`);
  const MONTO_Y_MONEDA = new RegExp(String.raw`(?:^|[^a-z0-9])${MONTO}\s*${MONEDA}(?![a-z])`);
  const PORCENTAJE = /%|\bpor\s*ciento\b/;
  const PALABRAS_DINERO = /\b(?:descuentos?|rebajas?|rebajar|rebajamos|gratis|gratuit[oa]s?|igv)\b/;
  const PISTA_Y_CIFRA = new RegExp(
    String.raw`\b(?:total|precios?|costos?|cuesta|cuestan|costaria|costara|costaran|cobr[a-z]*|tarifas?|monto|importe|pagar|pago|abonar|seran|seria|saldria|aprox[a-z]*|alrededor|valor|vale)\b` +
    String.raw`(?:[^a-z0-9]+[a-z]+){0,3}?[^a-z0-9]+${CIFRA}` +
    String.raw`(?![0-9]|[.,][0-9]|[-/:][0-9]|\s*(?:h\b|hrs?\b|horas?\b|am\b|pm\b|a\.\s?m|p\.\s?m|pax\b|pasajer|persona|maleta|kg\b|kilo|km\b|min|dia|noche|asiento|unidad|vehicul|bus\b|van\b|auto\b|de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre)))`,
  );
  const MONEDA_INGLES = String.raw`(?:us\s+dollars?|dollars?|bucks?|${MONEDA})`;
  const PALABRA_NUMERO_INGLES = String.raw`(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|millions?)`;
  const EN_LETRAS_INGLES = String.raw`${PALABRA_NUMERO_INGLES}(?:[\s-]+(?:and\s+)?${PALABRA_NUMERO_INGLES})*`;
  const MONTO_INGLES = String.raw`(?:${CIFRA}|${EN_LETRAS_INGLES}|${EN_LETRAS})`;
  const MONEDA_Y_MONTO_INGLES = new RegExp(String.raw`(?:^|[^a-z0-9])${MONEDA_INGLES}\s*${MONTO_INGLES}(?![a-z0-9])`);
  const MONTO_Y_MONEDA_INGLES = new RegExp(String.raw`(?:^|[^a-z0-9])${MONTO_INGLES}\s*${MONEDA_INGLES}(?![a-z])`);
  const PORCENTAJE_INGLES = /\bper\s*cent\b|\bpercent\b/;
  const PALABRAS_DINERO_INGLES = /\b(?:discounts?|discounted|complimentary|cheap|cheaper|cheapest|tax|taxes|vat)\b|(?<!feel\s)\bfree\b|\d\s*%?\s*off\b/;
  const MESES_INGLES = String.raw`(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)`;
  const PISTA_Y_CIFRA_INGLES = new RegExp(
    String.raw`\b(?:total|prices?|costs?|fees?|rates?|charges?|charged|pay|around|approx[a-z]*|about|would\s+be)\b` +
    String.raw`(?:[^a-z0-9]+(?!${MESES_INGLES}\b)[a-z]+){0,3}?[^a-z0-9]+${CIFRA}` +
    String.raw`(?![0-9]|[.,][0-9]|[-/:][0-9]|\s*(?:h\b|hrs?\b|horas?\b|am\b|pm\b|a\.\s?m|p\.\s?m|pax\b|pasajer|persona|maleta|kg\b|kilo|km\b|min|dia|noche|asiento|unidad|vehicul|bus\b|van\b|auto\b|de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|setiembre|septiembre|octubre|noviembre|diciembre)` +
    String.raw`|people\b|persons?\b|passengers?\b|bags?\b|suitcases?\b|luggage\b|minutes?\b|hours?\b|days?\b|nights?\b|seats?\b|flights?\b|${MESES_INGLES}\b|st\b|nd\b|rd\b|th\b|of\s+${MESES_INGLES}\b))`,
  );
  function mencionaDineroIngles(t: string): boolean {
    return MONEDA_Y_MONTO_INGLES.test(t) || MONTO_Y_MONEDA_INGLES.test(t)
      || PORCENTAJE_INGLES.test(t) || PALABRAS_DINERO_INGLES.test(t) || PISTA_Y_CIFRA_INGLES.test(t);
  }
  function mencionaDinero(texto: string, idioma: IdiomaTexto = "es"): boolean {
    const t = minusculas(texto);
    if (!t.trim()) return false;
    const castellano = importesEnTexto(texto).length > 0
      || MONEDA_Y_MONTO.test(t) || MONTO_Y_MONEDA.test(t)
      || PORCENTAJE.test(t) || PALABRAS_DINERO.test(t) || PISTA_Y_CIFRA.test(t);
    return castellano || (idioma === "en" && mencionaDineroIngles(t));
  }
  type IdiomaTexto = "es" | "en";
  type MotivoTextoLibre = "enlace" | "importe" | "palabra_de_pago" | "numero_largo" | "muy_largo";
  const ETIQUETA_TEXTO_LIBRE: Record<MotivoTextoLibre, string> = {
    enlace: "trae un enlace",
    importe: "menciona dinero",
    palabra_de_pago: "trae palabras de pago (Yape, Plin, depósito, cuenta…)",
    numero_largo: "trae un número de 6 o más dígitos (un teléfono o una cuenta)",
    muy_largo: `pasa de ${MAX_REFERENCIA} caracteres`,
  };
  const ENLACE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|pe|net|org|io|ly|me|app|info|link|co|xyz|site|online|store|shop|gl|gg|to|tk|click|top|biz)\b/;
  const NUMERO_LARGO = /(?:\d[\s.\-]?){5}\d/;
  const PALABRAS_PAGO = [
    "yape", "yapea", "yapear", "yapeame", "yapeo", "plin", "plinea", "plinear", "plineame",
    "deposito", "depositos", "deposite", "depositen", "depositar", "deposita", "depositas", "depositame",
    "transferencia", "transferencias", "transfiera", "transfieran", "transferir", "transfiere", "transfieres",
    "cuenta", "cuentas", "cci", "banco", "bcp", "bbva", "interbank", "scotiabank",
    "pago", "pagos", "pagar", "pague", "paguen", "abono", "abonar", "abone", "abonen",
  ];
  const PALABRAS_PAGO_INGLES = [
    "paypal", "zelle", "venmo", "wire", "deposit", "deposits", "account", "accounts", "bank", "banks",
    "pay", "payment", "payments",
  ];
  const FRASES_PAGO_INGLES = ["western union"];
  const traePalabraDePago = (crudo: string, idioma: IdiomaTexto): boolean => {
    const pal = porPalabra(crudo);
    if (PALABRAS_PAGO.some((p) => pal.includes(` ${p} `))) return true;
    if (idioma !== "en") return false;
    return PALABRAS_PAGO_INGLES.some((p) => pal.includes(` ${p} `)) || FRASES_PAGO_INGLES.some((p) => pal.includes(` ${p} `));
  };
  function textoLibreSospechoso(s: string | null | undefined, idioma: IdiomaTexto = "es"): MotivoTextoLibre | null {
    const crudo = String(s ?? "");
    if (!crudo.trim()) return null;
    const t = minusculas(crudo);
    if (ENLACE.test(t)) return "enlace";
    if (importesEnTexto(crudo).length > 0 || mencionaDinero(crudo, idioma)) return "importe";
    if (traePalabraDePago(crudo, idioma)) return "palabra_de_pago";
    if (NUMERO_LARGO.test(t)) return "numero_largo";
    if (Array.from(crudo.trim()).length > MAX_REFERENCIA) return "muy_largo";
    return null;
  }
  const unaLinea = (s: string): string => String(s ?? "").replace(/\s+/g, " ").trim();
  function referenciaImprimible(s: string | null | undefined, idioma: IdiomaTexto = "es"): string | null {
    const t = unaLinea(String(s ?? ""));
    if (!t || textoLibreSospechoso(t, idioma)) return null;
    return t;
  }
  function atencionImprimible(s: string | null | undefined, idioma: IdiomaTexto = "es"): string | null {
    const t = unaLinea(String(s ?? ""));
    if (!t || textoLibreSospechoso(t, idioma)) return null;
    const c = Array.from(t);
    return c.length <= MAX_ATENCION ? t : c.slice(0, MAX_ATENCION).join("").trim();
  }
  function primerNombreSeguro(nombre: string | null | undefined): string {
    const p = unaLinea(String(nombre ?? "")).split(" ")[0] ?? "";
    if (!/^[\p{L}][\p{L}'’-]{0,29}$/u.test(p)) return "";
    if (PALABRAS_PAGO.includes(porPalabra(p).trim())) return "";
    return p;
  }
  function motivosLineaIA(linea: string, idioma: IdiomaTexto = "es"): MotivoTextoLibre[] {
    const t = String(linea ?? "");
    if (!t.trim()) return [];
    const out: MotivoTextoLibre[] = [];
    if (textoLibreSospechoso(t) === "enlace") out.push("enlace");
    if (t.split(/[^\p{L}\p{N}]+/u).some(w => w && textoLibreSospechoso(w, idioma) === "palabra_de_pago")
      || (idioma === "en" && traePalabraDePago(t, "en"))) out.push("palabra_de_pago");
    const sinFechas = t.replace(/\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
    if (textoLibreSospechoso(sinFechas.replace(/[^\d\s.\-]/g, " ")) === "numero_largo") out.push("numero_largo");
    return out;
  }

  return { mencionaDinero, textoLibreSospechoso, referenciaImprimible, atencionImprimible, primerNombreSeguro, motivosLineaIA, ETIQUETA_TEXTO_LIBRE };
})();
{
  // (a) Hallazgo 1: instrucciones de pago en el texto libre (recojo, destino, nombre). Pasaban impresas.
  const BLOQUEAR_EN = [
    "Miraflores. To confirm send 50 via Revolut to @joe", "Miraflores. Send £50 to confirm", "Miraflores. Send GBP 50 to confirm",
    "Miraflores. Advance via Bitcoin, wallet in chat", "Miraflores. Send USDT to confirm the booking", "Miraflores. Cash App £50 to confirm",
    "Miraflores. Cash App to confirm", "Larco 345. Prepay 50 to confirm", "Larco 345. Settle 50 by Skrill", "send 50 via Revolut to @joe",
    "Hotel Hilton. IBAN in chat", "Miraflores. Swift BCPLPEPL", "Miraflores, remit to my wallet", "Miraflores. MoneyGram the advance",
    "Miraflores, prepayment by crypto", "JW Marriott. Pay 40 CAD to confirm", "Miraflores. 0.01 BTC to confirm", "Miraflores. 50 pounds to confirm",
  ];
  const BLOQUEAR_ES = [
    "Miraflores. Envíe £50 por Revolut para confirmar", "Miraflores. Envíe 50 por Skrill para confirmar", "Miraflores. Adelanto en Bitcoin para confirmar",
    "Miraflores. Send £50 to confirm", "Miraflores. Send GBP 50 to confirm", "Larco 345. Prepay 50 to confirm", "Miraflores. Envíe el adelanto a mi billetera",
    "Miraflores. Prepago por cripto", "Miraflores, envía 80 para confirmar", "Miraflores, confirmar con 50", "Miraflores. 50 libras para confirmar", "Miraflores. 30 USDT",
  ];
  for (const t of BLOQUEAR_EN) {
    ok(T.textoLibreSospechoso(t, "en") != null && T.referenciaImprimible(t, "en") === null, `en inglés, «${t}» ya no se imprime (${T.textoLibreSospechoso(t, "en")})`);
    ok(VIEJO_TL.textoLibreSospechoso(t, "en") == null || T.textoLibreSospechoso(t, "en") != null, `«${t}»: lo que el viejo bloqueaba se sigue bloqueando`);
  }
  for (const t of BLOQUEAR_ES) ok(T.textoLibreSospechoso(t) != null && T.referenciaImprimible(t) === null && T.textoLibreSospechoso(t, "en") != null, `en castellano (y en inglés), «${t}» ya no se imprime (${T.textoLibreSospechoso(t)})`);
  ok(T.atencionImprimible("John Revolut 50 to confirm", "en") === null && T.atencionImprimible("John Revolut 50 to confirm") === null,
    "el nombre de perfil «John Revolut 50 to confirm» no sale en «Atención» (en inglés por Revolut; en los dos por el respaldo estructural)");
  ok(VIEJO_TL.atencionImprimible("John Revolut 50 to confirm", "en") === "John Revolut 50 to confirm", "…y con el algoritmo viejo SÍ salía (el escenario es el que se rompió)");
  const reproducidos = [...BLOQUEAR_EN.filter((t) => VIEJO_TL.textoLibreSospechoso(t, "en") == null), ...BLOQUEAR_ES.filter((t) => VIEJO_TL.textoLibreSospechoso(t) == null)];
  ok(reproducidos.length >= 18, `el algoritmo viejo reproduce el defecto: ${reproducidos.length} de ${BLOQUEAR_EN.length + BLOQUEAR_ES.length} pasaban`);
  // El respaldo estructural va como «importe» (una orden de pagar o confirmar una cifra), y lo ve la nota.
  ok(T.textoLibreSospechoso("Larco 345. Prepay 50 to confirm") === "importe" && T.textoLibreSospechoso("Miraflores, confirmar con 50") === "importe", "el respaldo estructural cuenta como «importe»");
  ok(Object.keys(T.ETIQUETA_TEXTO_LIBRE).length === 5 && JSON.stringify(T.ETIQUETA_TEXTO_LIBRE) === JSON.stringify(VIEJO_TL.ETIQUETA_TEXTO_LIBRE), "los cinco motivos de siempre: no hay un motivo nuevo que la nota o la bandeja no sepan pintar");

  // (b) Lo que tiene que seguir imprimiéndose: direcciones y hoteles de Lima, en los dos idiomas.
  const DIRECCIONES = [
    "Av. Larco 345, Miraflores", "Hotel Belmond Miraflores Park", "Jr. de la Unión 1050", "Calle Confirmación?", "Av. José Larco 1232, Miraflores",
    "Av. Pardo 610", "Av. Arequipa 4545, Miraflores", "Av. Javier Prado Este 1066, San Isidro", "Calle Schell 326", "Av. Benavides 220", "Av. La Paz 1101",
    "Calle Alcanfores 425", "Jr. Huallaga 520, Cercado de Lima", "Av. Abancay 210", "Av. Grau 1520, Barranco", "Av. Brasil 2950, Magdalena",
    "Av. Salaverry 2800", "Av. Petit Thouars 5356", "Av. Angamos Oeste 1200", "Av. Primavera 1050, Surco", "Av. El Polo 670, Surco",
    "Calle Las Begonias 441, San Isidro", "Av. Camino Real 1050", "Av. Los Conquistadores 1130", "Av. Santa Cruz 875", "Malecón Cisneros 1244",
    "Malecón de la Reserva 1035", "JW Marriott Lima", "Hilton Lima Miraflores", "Casa Andina Premium Miraflores", "Sheraton Lima Historic Center",
    "The Westin Lima", "Swissôtel Lima", "Costa del Sol Wyndham Lima Airport", "Radisson Red Miraflores", "Hyatt Centric San Isidro", "Atton San Isidro",
    "Pullman Lima Miraflores", "Novotel Lima San Isidro", "Ibis Larco Miraflores", "Courtyard by Marriott Lima Miraflores", "Holiday Inn Lima Airport",
    "Thunderbird Hotel Carlos V", "Hotel Estelar Miraflores", "Dazzler Lima", "Arawi Miraflores", "Tierra Viva Miraflores Larco", "Hotel B, Barranco",
    "Country Club Lima Hotel", "Hotel Libertador San Isidro", "DoubleTree El Pardo", "Aeropuerto Jorge Chávez, Terminal 1",
    "Urb. Santa Patricia Mz. B Lt. 12, La Molina", "Av. Larco 1150 Dpto 1502", "Calle Dos de Mayo 380, San Isidro", "Av. Primavera 2390 Of. 501",
    "Torre B piso 12, Av. Rivera Navarrete 451", "Av. Paseo de la República 3755", "Av. Aviación 2990, San Borja", "Calle Los Pinos 123",
    "Jr. Cusco 251, Lima", "Av. Tacna 610", "Plaza San Martín", "Parque Kennedy", "Ovalo Gutiérrez", "Larcomar", "Jockey Plaza", "Real Plaza Salaverry",
    "Mall del Sur", "Puerta 3 del Jockey Club", "Estadio Nacional, puerta 12", "Embajada de Estados Unidos, Av. La Encalada 1765",
    "Clínica Ricardo Palma, Av. Javier Prado Este 1066", "Universidad de Lima, Av. Javier Prado Este 4600", "Calle Libertad 120", "Av. Los Libertadores 155",
    "Calle Las Orquídeas 585", "Calle Esperanza 120, Miraflores", "Av. 28 de Julio 1100", "Av. 2 de Mayo 1545", "Calle 21 número 750, Corpac",
    "Hotel Sol de Oro, San Antonio 255, Miraflores", "Lima 15074", "Callao 07001", "Av. Elmer Faucett 3400", "Casa Republica Barranco",
    "Second Home Peru, Domeyer 366", "Hotel Antigua Miraflores, Av. Grau 350", "Miraflores Park Plaza", "Av. Libertad 500", "Calle Libra 23, Surco",
    "Calle Remigio Silva 200", "Terminal Terrestre Cruz del Sur, Av. Javier Prado 1109", "Oltursa, Av. Aramburú 1160", "Puerto del Callao, muelle 5",
    "Airport transfer to JW Marriott", "Hotel Belmond, Miraflores", "Hilton Garden Inn", "Room 405, Hilton Lima", "Gate 12, international arrivals",
    "Pick me up at the lobby, room 1204", "Apartment 802, Av. Pardo 140", "Near Kennedy Park, Diagonal 380", "Larco Ave 1232, 5th floor",
    "Sheraton, confirm at the front desk", "Envíenme el chofer a la puerta 2", "Confirmar en recepción", "Recojo en Av. Larco 345, confirmo al llegar",
    "Transfer 50 meters from the hotel", "Miraflores. Transfer the 50 to me", "Hotel 80 Larco, airport transfer",
  ];
  let imprimen = 0;
  for (const t of DIRECCIONES) for (const id of ["es", "en"] as const) {
    if (T.referenciaImprimible(t, id) === t.replace(/\s+/g, " ").trim()) imprimen++;
    else ok(false, `«${t}» (${id}) tendría que seguir imprimiéndose (${T.textoLibreSospechoso(t, id)})`);
  }
  ok(imprimen === DIRECCIONES.length * 2, `${DIRECCIONES.length} direcciones y hoteles se siguen imprimiendo en los dos idiomas (${imprimen}/${DIRECCIONES.length * 2})`);
  // La medición de falsos positivos DECLARADA: lo único que el corpus de direcciones pierde son nombres
  // que contienen una palabra nueva de pago (no se encontró ninguno real en Lima; si aparece, el
  // perjuicio es solo que la referencia no se imprime y la cotización la revisa un ejecutivo).
  const FP_DECLARADOS: [string, "es" | "en"][] = [["Av. El Adelanto 345", "es"], ["Calle Swift 12", "en"], ["Hotel Iban", "en"]];
  for (const [t, id] of FP_DECLARADOS) ok(T.textoLibreSospechoso(t, id) != null && VIEJO_TL.textoLibreSospechoso(t, id) == null, `falso positivo DECLARADO: «${t}» (${id}) ya no se imprime`);
  // «transfer» NUNCA es una palabra de pago (es el servicio que se cotiza), ni con una cifra.
  for (const t of ["Airport transfer", "Transfer 50 to Miraflores", "the transfer is at 10:30", "Hotel transfer 2 pax"]) ok(T.textoLibreSospechoso(t, "en") == null && T.textoLibreSospechoso(t) == null, `«${t}»: «transfer» no es una palabra de pago`);
  // Lo que se imprime en la fila (las casos de la sección 18) no cambia con la revisión S1.
  const r18 = M.evaluarTraslado(pedido(), ctx);
  for (const t of DIRECCIONES.slice(0, 40)) for (const id of [undefined, "en"] as const) {
    const fila = C.filaCotizacionTraslado(r18, { ...entradaDe(pedido()), destino: t }, { convId: "c", clienteId: null, atencion: "Ana", config, firma: "f", hoy: HOY, ...(id ? { idioma: id } : {}) });
    ok(fila.destino === `Miraflores (${t})`.slice(0, 300) || fila.destino === "Miraflores", `la fila imprime «${t}» como antes (${fila.destino})`);
    ok(C.impresosSospechosos(fila, id ?? "es").length === 0, `la fila que arma la IA nunca es sospechosa para el respaldo (${fila.destino})`);
  }

  // (c) Hallazgo 2: dinero en el texto del modelo, tras una palabra de precio, en letras o con £/GBP.
  const DINERO_EN = ["The total would be one hundred fifty.", "That will be 150.", "It's 150 for the van.", "It comes to 150 per leg.", "the fare is 150", "fare: 150",
    "it's just 150", "£150", "GBP 150", "50 pounds", "Price: one fifty", "it costs a hundred and fifty", "Roughly 150.", "150 for the round trip", "75 each way",
    "No charge for waiting", "at no extra cost", "That will be one hundred and fifty", "It is 150 for the van", "That's 150"];
  const DINERO_ES = ["El total sería ciento cincuenta", "Son 150 por la van", "£150", "GBP 150", "Le cobramos ciento cincuenta", "Quedaría en ciento cincuenta", "Le sale en 150",
    "150 por tramo", "Son ciento veinte por el servicio", "150 dlls", "0.01 btc", "50 libras"];
  for (const f of DINERO_EN) ok(T.mencionaDinero(f, "en"), `en inglés, «${f}» es dinero`);
  for (const f of DINERO_ES) ok(T.mencionaDinero(f) && T.mencionaDinero(f, "en"), `en castellano (y en inglés), «${f}» es dinero`);
  const reproducen = [...DINERO_EN.filter((f) => !VIEJO_TL.mencionaDinero(f, "en")), ...DINERO_ES.filter((f) => !VIEJO_TL.mencionaDinero(f))];
  ok(reproducen.length >= 25, `el algoritmo viejo reproduce el defecto: ${reproducen.length} de ${DINERO_EN.length + DINERO_ES.length} pasaban`);
  // Lo que tiene que seguir pasando: pasajeros, maletas, horas, fechas, direcciones, cortesías.
  const LIMPIO = ["So there will be 4 of you?", "There will be 12 passengers and 6 bags.", "It's 25 minutes from the airport.", "That's 2 large suitcases, right?",
    "Your flight lands at 10:30, it's October 25.", "It's one of the best hotels in Miraflores.", "The pick-up will be at 15:00.", "It will be 3 people?", "It comes to the hotel entrance.",
    "It's 12 km from the airport.", "That will be 2 vans for 30 people.", "It's twenty minutes away.", "We will be 10 people", "you will be 15?", "So you will be 15 in total?",
    "There will be 12 of us", "It's 24/7", "that will be at 15:00", "it's 10:30", "it's October 25", "It's 5 stars", "Is it for 2 people?", "That's 15 passengers",
    "It is 30 minutes away", "It will be two vans", "the pick-up will be at twenty past ten", "It's 2026-10-25", "It's the 25th", "it's 25 of October", "That will be on October 25",
    "twenty five people", "about twenty five people", "the total would be twenty five passengers", "Hello, I need a transfer from the airport tomorrow", "feel free to ask", "drop off at the hotel",
    "Serían 2 maletas por persona", "Son 15 pasajeros", "¿Sería a las veinte horas?", "El recojo sería a las veintidós", "Quedaría en el lobby", "Le sale en el terminal 2",
    "Le cobramos a la llegada", "Sería un placer atenderle", "Serán dos personas", "Serán veinte personas", "El total de cuarenta pasajeros", "Sería el veinticinco de octubre",
    "¿Son 4 pasajeros y 2 maletas?", "Son 2 maletas de 23 kg", "Son 3 horas de viaje", "Sería para cuarenta y cinco personas", "Son 12 pasajeros en total", "son las diez y media",
    "El vuelo sale a las diez", "ciento cuarenta y cinco personas", "el total de ciento cuarenta y cinco pasajeros", "sin ítems y sin total → sin_dato, no un cero mudo",
    "¡Hola! Para cotizar tu traslado me falta saber la hora de recojo y cuántas maletas de 23 kg llevan.", "Perfecto, son 3 maletas grandes y 2 pasajeros.",
    "Calle Libra 23, Surco", "Un ejecutivo revisará tu pedido y te escribirá por este chat."];
  for (const f of LIMPIO) ok(!T.mencionaDinero(f, "en") && !T.mencionaDinero(f), `«${f}» no es dinero (en ninguno de los dos)`);
  // (d) nuevo ⊇ viejo en un corpus grande, y lo que el nuevo bloquea de más es exactamente lo DECLARADO.
  const CORPUS = [...BLOQUEAR_EN, ...BLOQUEAR_ES, ...DIRECCIONES, ...DINERO_EN, ...DINERO_ES, ...LIMPIO, ...FP_DECLARADOS.map((x) => x[0]),
    "El total sería 150 (IGV incluido)", "Total: 150.00 nuevos soles", "serán aprox 300", "Te sale gratis el retorno", "Cuesta 120 por tramo", "the total would be 150", "around 300",
    "free waiting time", "Miraflores. Para confirmar su reserva deposite S/ 50 al Yape 987 654 321", "www.pagos.pe", "", "   "];
  const DECLARADOS = new Set([...BLOQUEAR_EN, ...BLOQUEAR_ES, ...DINERO_EN, ...DINERO_ES, ...FP_DECLARADOS.map((x) => x[0])]);
  let sup = 0, tot = 0, nuevos = 0;
  for (const a of CORPUS) for (const sep of ["", " ", ". "]) for (const b of ["", "Hola.", "Thanks."]) {
    const t = `${a}${sep}${b}`;
    for (const id of ["es", "en"] as const) {
      tot += 2;
      const mv = VIEJO_TL.mencionaDinero(t, id), mn = T.mencionaDinero(t, id);
      const sv = VIEJO_TL.textoLibreSospechoso(t, id) != null, sn = T.textoLibreSospechoso(t, id) != null;
      if (!mv || mn) sup++; else ok(false, `PERDIDO (mencionaDinero ${id}): «${t}»`);
      if (!sv || sn) sup++; else ok(false, `PERDIDO (textoLibreSospechoso ${id}): «${t}»`);
      if ((mn && !mv) || (sn && !sv)) { nuevos++; if (!DECLARADOS.has(a)) ok(false, `bloqueo NO declarado (${id}): «${t}»`); }
    }
  }
  ok(sup === tot, `nuevo ⊇ viejo: nada que el viejo bloqueaba deja de bloquearse (${sup}/${tot})`);
  ok(nuevos > 0, `corolario: el barrido sí bloquea de más, y todo lo que bloquea de más está declarado (${nuevos})`);
  ok(T.mencionaDinero("x", "en") === false && [...CORPUS].every((t) => !T.mencionaDinero(t) || T.mencionaDinero(t, "en")), "sigue valiendo inglés ⊇ castellano");

  // (e) Las condiciones de la plantilla (`motivosLineaIA`) y el saludo (`primerNombreSeguro`) NO cambian:
  //     las palabras nuevas son solo del texto libre. Se comparan contra el viejo sobre las políticas
  //     REALES sembradas en los SQL (castellano e inglés) y el corpus.
  const sqlPol = ["supabase/cotizaciones-06-politica-reserva.sql", "supabase/cotizaciones-08-resumen-condiciones.sql", "supabase/traslados-11-solo-afa-plantillas-ingles.sql", "supabase/traslados-03-precios-afa.sql"]
    .filter((f) => existsSync(f)).flatMap((f) => lits(readFileSync(f, "utf8")));
  const LINEAS = [...sqlPol, ...CORPUS, "La reserva se confirma con un adelanto del 50 % del precio total.", "Booking requires a 50% prepayment.", "Pay by Revolut or Bitcoin.", "Envíe 50 por Skrill"];
  let igualesL = 0, totL = 0, igualesN = 0;
  for (const l of LINEAS) for (const id of ["es", "en"] as const) { totL++; if (JSON.stringify(T.motivosLineaIA(l, id)) === JSON.stringify(VIEJO_TL.motivosLineaIA(l, id))) igualesL++; }
  for (const l of LINEAS) if (T.primerNombreSeguro(l) === VIEJO_TL.primerNombreSeguro(l)) igualesN++;
  ok(sqlPol.length > 20 && igualesL === totL, `motivosLineaIA byte a byte la de antes (${igualesL}/${totL}, con ${sqlPol.length} líneas de los SQL)`);
  ok(igualesN === LINEAS.length, `primerNombreSeguro byte a byte el de antes (${igualesN}/${LINEAS.length})`);
  ok(T.motivosLineaIA("La reserva se confirma con un adelanto del 50 % del precio total.").length === 0, "«adelanto» en una política no la pinta de ámbar (es la palabra de toda política de reserva)");
}

// ── 27. Revisión S1 · hallazgo 3: la GUARDA en inglés también con el inglés apagado ──
seccion("27. S1 · hallazgo 3: la guarda del dinero va en el idioma del CLIENTE; el mensaje del código, en el de siempre");
{
  ok(E.idiomaDeGuarda(null) === "es" && E.idiomaDeGuarda("es", "es") === "es" && E.idiomaDeGuarda("en") === "en" && E.idiomaDeGuarda("otro", "es") === "en" && E.idiomaDeGuarda(null, "en") === "en" && E.idiomaDeGuarda(undefined, null) === "es",
    "idiomaDeGuarda: «en» con el mensaje en inglés o el cliente en inglés u otro idioma; si no, «es»");
  const DIN_SOLO_EN = ["around 300", "about 150 per person", "150 dollars", "150 bucks", "free waiting time", "We charge 150", "pay 150 on arrival", "That will be 150.", "It's 150 for the van."];
  const derivEs = "Un ejecutivo revisará tu pedido y te escribirá por este chat.";
  for (const f of DIN_SOLO_EN) {
    ok(!T.mencionaDinero(f), `«${f}» no lo ve la guarda en castellano (el escenario del hallazgo)`);
    // Sin guarda (o «es»): byte a byte lo de antes, pasa.
    ok(E.textoFinalTraslado(f, { accion: "derivar" }, { derivacion: derivEs, estilo: TU }) === f
      && E.textoFinalTraslado(f, { accion: "derivar" }, { derivacion: derivEs, estilo: TU, idiomaGuarda: "es" }) === f, `sin guarda en inglés, «${f}» pasa como antes`);
    // Con el cliente en inglés y el inglés APAGADO: se reemplaza, y el reemplazo sigue en castellano.
    ok(E.textoFinalTraslado(f, { accion: "derivar" }, { derivacion: derivEs, estilo: TU, idiomaGuarda: "en" }) === derivEs, `con la guarda en inglés, «${f}» → la derivación en castellano`);
    ok(E.textoFinalTraslado(f, { accion: "preguntar", faltan: ["la cantidad de maletas de 23 kg"] }, { derivacion: derivEs, estilo: TU, idiomaGuarda: "en" }) === "Para cotizar tu traslado me falta: la cantidad de maletas de 23 kg.",
      `con la guarda en inglés, «${f}» → el «me falta» en castellano`);
  }
  // Un texto limpio del modelo en inglés pasa intacto con la guarda en inglés.
  for (const f of ["How many large suitcases are you bringing?", "What time does your flight land?", "Is it one way or a round trip?"]) {
    ok(E.textoFinalTraslado(f, { accion: "preguntar", faltan: ["x"] }, { derivacion: derivEs, estilo: TU, idiomaGuarda: "en" }) === f, `con la guarda en inglés, «${f}» pasa`);
  }
  // Barrido: con la guarda «es» (o sin ella) el resultado es el de siempre; con «en», nunca MÁS permisivo.
  let iguales = 0, nunca = 0, nB = 0;
  const modosB: E.TrasladoDelTurno[] = [{ accion: "derivar" }, { accion: "preguntar", faltan: ["la hora de recojo"] }, { accion: "cotizar", cotizacion: { numero: "1", decision: "revision" } }];
  for (const f of [...DIN_SOLO_EN, "El total sería 150", "¿Cuántas maletas?", "Son 150 por la van", "", "Hello"]) for (const t of modosB) for (const est of ESTILOS) {
    nB++;
    const a = E.textoFinalTraslado(f, t, { derivacion: derivEs, estilo: est });
    if (a === E.textoFinalTraslado(f, t, { derivacion: derivEs, estilo: est, idiomaGuarda: "es" })) iguales++;
    const b = E.textoFinalTraslado(f, t, { derivacion: derivEs, estilo: est, idiomaGuarda: "en" });
    if (b === a || b !== f) nunca++;
  }
  ok(iguales === nB && nunca === nB, `con «es» byte a byte; con «en», el texto del modelo solo puede reemplazarse, nunca dejarse pasar de más (${iguales}/${nunca}/${nB})`);
  // La guarda T10 de la reserva: lo mismo.
  const RIA = await import("../lib/traslados/reserva-ia");
  const xR = { estilo: TU, numeroCotizacion: "00736", hayCotizacionTraslado: true };
  for (const f of DIN_SOLO_EN) {
    ok(RIA.textoFinalReserva(f, [], xR) === null, `reserva: sin guarda en inglés, «${f}» pasa (null) como antes`);
    ok(RIA.textoFinalReserva(f, [], { ...xR, idiomaGuarda: "en" }) === RIA.mensajeGuardaReserva("00736", TU), `reserva: con la guarda en inglés, «${f}» → la T10 en castellano`);
  }
  // El cableado en lib/crm-ia.ts (sin comentarios): la guarda sale de `idiomaDeGuarda(idiomaIA.cliente, …)` y viaja a las dos guardas.
  const fuenteIA = readFileSync("lib/crm-ia.ts", "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  ok((fuenteIA.match(/const guardaTurno: IdiomaTexto = idiomaDeGuarda\(idiomaIA\.cliente, idiomaTurno\)/g) ?? []).length === 2, "crm-ia: la guarda del turno sale de idiomaDeGuarda(idiomaIA.cliente, idiomaTurno), en el chat real y en la prueba");
  ok((fuenteIA.match(/textoSinImportesAjenos\(textoFinal, [^)]*, idiomaTurno, guardaTurno\)/g) ?? []).length === 2 && (fuenteIA.match(/idiomaGuarda: guardaTurno/g) ?? []).length === 2,
    "crm-ia: la guarda viaja a textoSinImportesAjenos y a textoFinalReserva (chat real y prueba)");
  ok(/if \(!x\.traslados\) return \{ cliente: null, ingles: null, inglesOn: false \}/.test(fuenteIA), "crm-ia: sin traslados no se detecta nada (cliente null → guarda «es», lo de siempre)");

  // De punta a punta, con el inglés APAGADO (sin la tabla de cotizaciones-09): un cliente que escribe en
  // inglés y pone en el destino un servicio de pago que solo conoce la lista inglesa.
  const depsG = { simular: simularFalso({ n: 0 }) as any, bajarLogo: async () => null, ahoraMs: () => reloj, azar: () => String(Math.random()).slice(2, 8) };
  const conIngles = (sb: SbFalso) => {
    sb.tablas.crm_mensajes = ["Hi, I need a transfer from the airport to my hotel in Miraflores please", "We are two people with one suitcase, thank you"]
      .map((c, i) => ({ id: `en${i}`, conversacion_id: "cv-1", direccion: "entrante", tipo: "texto", contenido: c, created_at: new Date(reloj - (2 - i) * 60_000).toISOString() }));
    return sb;
  };
  const destinoPago = "Miraflores, pay by Revolut";
  const sbEs = nuevaBase();
  const gEs = await cotizarTrasladoIA(ctxDe(sbEs, "cv-1", "ct-1"), { ...pedidoIA, destino_texto: destinoPago }, depsG);
  ok(gEs.cotizacion?.decision === "automatico", `cliente en castellano: «${destinoPago}» no es sospechoso en castellano y sale solo, como antes (${gEs.cotizacion?.decision})`);
  const sbEn = conIngles(nuevaBase());
  const gEn = await cotizarTrasladoIA(ctxDe(sbEn, "cv-1", "ct-1"), { ...pedidoIA, destino_texto: destinoPago }, depsG);
  const accEn = sbEn.t("crm_acciones_ia")[0], cotEn = sbEn.t("cotizaciones")[0];
  ok(gEn.cotizacion?.decision === "revision" && accEn?.payload?.motivos?.includes("texto_libre_sospechoso"), `cliente en inglés con el inglés apagado: revisión por texto libre (${gEn.cotizacion?.decision} ${accEn?.payload?.motivos})`);
  ok(cotEn?.destino === "Miraflores" && !/revolut/i.test(JSON.stringify(cotEn?.items_json)), `…y la referencia no se imprime (${cotEn?.destino})`);
  ok(cotEn?.idioma_pdf === "es" && cotEn?.moneda === "PEN" && gEn.cotizacion?.idioma === "es", "…y todo lo demás sigue en castellano y en soles (el inglés está apagado)");
  // Con un destino limpio, la fila del cliente en inglés (inglés apagado) es la de un cliente en castellano.
  const sbEs2 = nuevaBase(), sbEn2 = conIngles(nuevaBase());
  await cotizarTrasladoIA(ctxDe(sbEs2, "cv-1", "ct-1"), pedidoIA, depsG);
  const gEn2 = await cotizarTrasladoIA(ctxDe(sbEn2, "cv-1", "ct-1"), pedidoIA, depsG);
  const sinTiempo = (f: FilaF) => { const o = { ...f }; delete o.created_at; delete o.id; return o; };
  ok(gEn2.cotizacion?.decision === "automatico" && JSON.stringify(sinTiempo(sbEn2.t("cotizaciones")[0])) === JSON.stringify(sinTiempo(sbEs2.t("cotizaciones")[0])),
    "con un destino limpio, la cotización (fila, firma, moneda) es byte a byte la de un cliente en castellano");
}

// ── 28. Revisión de seguridad · hallazgo 5: la cotización REUSADA que alguien editó la envía un ejecutivo ──
seccion("28. Hallazgo 5: la huella de lo que se imprime, al crear y al reusar; el «Enviar» del ejecutivo no cambia");
{
  const CD = await import("../lib/traslados/cotizar-ia-datos");
  const base = C.filaCotizacionTraslado(M.evaluarTraslado(pedido(), ctx), entradaDe(pedido()), { convId: "c", clienteId: null, atencion: "Ana", config, firma: "f", hoy: HOY });
  const leida: any = { ...base, id: 101, numero_cotizacion: "00101", created_at: "2026-10-19T15:00:00Z" };
  const h0 = C.canonImprimible(leida);
  // Estable ante el orden de las claves (Postgres reordena un jsonb) y ante un numeric devuelto como texto.
  const reordenada: any = Object.fromEntries(Object.entries(leida).reverse());
  reordenada.items_json = leida.items_json.map((it: any) => Object.fromEntries(Object.entries(it).reverse()));
  reordenada.consideraciones_json = Object.fromEntries(Object.entries(leida.consideraciones_json).reverse());
  ok(C.canonImprimible(reordenada) === h0 && C.canonImprimible({ ...leida, precio_cliente: String(leida.precio_cliente) }) === h0, "la huella no cambia con el orden de las claves ni con «283.20» en texto");
  ok(C.canonImprimible({ ...leida, estado: "enviado", asunto: "otro", medio_envio: "WhatsApp" }) === h0, "lo que no se imprime (estado, asunto, medio) no cambia la huella");
  let cambia = 0;
  for (const k of C.CAMPOS_HUELLA) if (C.canonImprimible({ ...leida, [k]: k === "items_json" ? [{ ...leida.items_json[0], descripcion: "otra" }] : "editado" }) !== h0) cambia++;
  ok(cambia === C.CAMPOS_HUELLA.length, `cada campo impreso cambia la huella (${cambia}/${C.CAMPOS_HUELLA.length})`);
  ok(C.canonImprimible({ ...leida, consideraciones_json: { ...leida.consideraciones_json, idioma: "en" } }) !== h0, "la marca «idioma: en» puesta a mano en las condiciones cambia la huella");
  ok(/^[0-9a-f]{64}$/.test(CD.huellaImprimible(leida)) && CD.huellaImprimible(reordenada) === CD.huellaImprimible(leida), "huellaImprimible: sha256 hex, estable");
  ok(CD.filaEditada({ huella: CD.huellaImprimible(leida) }, leida) === false && CD.filaEditada({ huella: CD.huellaImprimible(leida) }, { ...leida, origen: "x" }) === true, "filaEditada: igual → no; distinta → sí");
  ok(CD.filaEditada({}, leida) && CD.filaEditada(null, leida) && CD.filaEditada({ huella: "abc" }, leida), "filaEditada: sin huella (o una que no es sha256) → no se puede comprobar → editada");
  // El respaldo sobre la fila: lo que escribió la IA nunca; lo editado sí; el largo no cuenta.
  ok(C.impresosSospechosos(leida).length === 0 && C.impresosSospechosos(leida, "en").length === 0, "la fila que escribe la IA no es sospechosa");
  ok(Array.from(leida.items_json[0].descripcion).length > 80 && C.impresosSospechosos(leida).length === 0, "una descripción de más de 80 caracteres no cuenta como sospechosa");
  const editadaPago = { ...leida, destino: "Miraflores (Hotel. Send £50 to confirm)" };
  ok(C.impresosSospechosos(editadaPago).map((x) => x.campo).join() === "Destino impreso", "un destino editado con una instrucción de pago sí (en castellano también, por la £)");
  ok(C.impresosSospechosos({ ...leida, items_json: [{ ...leida.items_json[0], descripcion: "TRASLADO · Yape 987654321" }] }).map((x) => x.motivo).join() === "palabra_de_pago", "y una descripción editada con un Yape");
  ok(E.MOTIVO_REVISION.editada_a_mano.texto.includes("/cotizaciones") && E.MOTIVO_REVISION.editada_a_mano.arreglo.includes("Ver PDF"), "el motivo nuevo con su texto y su arreglo");

  // De punta a punta.
  const depsH = { simular: simularFalso({ n: 0 }) as any, bajarLogo: async () => null, ahoraMs: () => reloj, azar: () => String(Math.random()).slice(2, 8) };
  const crear = async () => {
    const sb = nuevaBase();
    const r0 = await cotizarTrasladoIA(ctxDe(sb, "cv-1", "ct-1"), pedidoIA, depsH);
    return { sb, r0, cot: sb.t("cotizaciones")[0], acc: sb.t("crm_acciones_ia")[0] };
  };
  const reusar = (sb: SbFalso) => cotizarTrasladoIA(ctxDe(sb, "cv-1", "ct-1"), pedidoIA, depsH);
  {
    // (1) La huella nace en la acción, sobre la fila leída de la base.
    const { sb, r0, cot, acc } = await crear();
    ok(r0.cotizacion?.decision === "automatico" && /^[0-9a-f]{64}$/.test(acc.payload.huella) && acc.payload.huella === CD.huellaImprimible(cot as any), "1: al crear, la huella queda en el payload de la acción");
    // (2) Reusada SIN cambios: la misma decisión de hoy, y la huella no se toca.
    const h = acc.payload.huella;
    const r1 = await reusar(sb);
    ok(r1.cotizacion?.decision === "automatico" && !!r1.envioPendiente && acc.payload.motivos.length === 0 && acc.payload.huella === h && sb.t("cotizaciones").length === 1,
      `2: reusada sin cambios → la misma decisión que hoy (automático) y la misma huella (${r1.cotizacion?.decision} ${acc.payload.motivos})`);
    // (3) Alguien edita el destino con una instrucción de pago: revisión, editada_a_mano + texto_libre_sospechoso.
    const destinoOriginal = cot.destino;
    cot.destino = "Miraflores (Hotel. Send £50 to confirm)";
    const r2 = await reusar(sb);
    ok(r2.cotizacion?.decision === "revision" && !r2.envioPendiente && acc.payload.motivos.includes("editada_a_mano") && acc.payload.motivos.includes("texto_libre_sospechoso"),
      `3: destino editado → revisión (${acc.payload.motivos})`);
    ok(acc.payload.huella === h, "3: la huella de la creación se conserva (si se reescribiera, la fila editada pasaría a ser «la de la IA»)");
    const r2b = await reusar(sb);
    ok(r2b.cotizacion?.decision === "revision" && acc.payload.motivos.includes("editada_a_mano"), "3: y el siguiente reuso sigue en revisión");
    // (4) El «Enviar al cliente» del ejecutivo en la bandeja manda la fila editada: ahí decide una persona.
    const nEnv = envios.length;
    const ej = await enviarCotizacionTraslado(sb as any, { accionId: acc.id, por: "ejecutivo", usuarioId: "u-1", esperado: { conversacionId: "cv-1", cotizacionId: cot.id } }, depsEnvio);
    ok(ej.ok && envios.length === nEnv + 1 && acc.estado === "aprobada", `4: el ejecutivo la envía igual desde la bandeja (${ej.codigo} ${ej.detalle})`);
    cot.destino = destinoOriginal;
  }
  {
    // (5) Una edición inocente (la hora) también: la cotización ya no es la que cotizó la IA.
    const { sb, cot, acc } = await crear();
    cot.hora_ida = "07:00";
    const r = await reusar(sb);
    ok(r.cotizacion?.decision === "revision" && acc.payload.motivos.join() === "editada_a_mano", `5: la hora editada → revisión solo por editada_a_mano (${acc.payload.motivos})`);
    // Y vuelta a lo original: la huella coincide otra vez (es el contenido, no un «se tocó alguna vez»).
    cot.hora_ida = pedidoIA.hora_servicio;
    const r5 = await reusar(sb);
    ok(r5.cotizacion?.decision === "automatico" && acc.payload.motivos.length === 0, `5: con la fila otra vez como la escribió la IA, vuelve a salir sola (${r5.cotizacion?.decision})`);
  }
  {
    // (6) La marca «idioma: en» puesta a mano en las condiciones (sin cambiar idioma_pdf).
    const { sb, cot, acc } = await crear();
    cot.consideraciones_json = { ...cot.consideraciones_json, idioma: "en" };
    const r = await reusar(sb);
    ok(r.cotizacion?.decision === "revision" && acc.payload.motivos.includes("editada_a_mano"), `6: la marca puesta a mano → revisión (${acc.payload.motivos})`);
  }
  {
    // (7) Una acción SIN huella (creada antes de este cambio): no se puede comprobar → revisión.
    const { sb, acc } = await crear();
    delete acc.payload.huella;
    const r = await reusar(sb);
    ok(r.cotizacion?.decision === "revision" && acc.payload.motivos.join() === "editada_a_mano" && !("huella" in acc.payload), `7: una acción sin huella → revisión, y no se le inventa una (${acc.payload.motivos})`);
  }
  {
    // (8) Si al crear no se pudo releer la fila, la acción nace sin huella (y su reuso irá a revisión).
    const sb = nuevaBase();
    const ins = sb.from.bind(sb);
    let releer = 0;
    (sb as any).from = (tabla: string) => { const q = ins(tabla); if (tabla === "cotizaciones") { const sel = q.select.bind(q); q.select = (c?: string, o?: any) => { if (q.op === "select" && releer++ === 0) sb.fallas.push({ tabla: "cotizaciones", op: "select", mensaje: "timeout" }); return sel(c, o); }; } return q; };
    const r = await cotizarTrasladoIA(ctxDe(sb, "cv-1", "ct-1"), pedidoIA, depsH);
    const acc = sb.t("crm_acciones_ia")[0];
    sb.fallas.length = 0;
    (sb as any).from = ins;
    ok(r.accion === "cotizar" && !!acc && !("huella" in acc.payload), `8: sin poder releer la fila, la acción nace sin huella (${r.accion} ${JSON.stringify(acc?.payload?.huella)})`);
    const r8 = await reusar(sb);
    ok(r8.cotizacion?.decision === "revision" && acc.payload.motivos.includes("editada_a_mano"), "8: …y su reuso queda en revisión");
  }
  {
    // (9) Ya ENVIADA y reusada: «ya te la envié», sin decisión ni huella de por medio (como hoy).
    const { sb, r0, cot, acc } = await crear();
    await enviarCotizacionTraslado(sb as any, { accionId: acc.id, por: "automatico", bytes: r0.envioPendiente!.bytes, nombre: r0.envioPendiente!.nombre, caption: r0.envioPendiente!.caption }, depsEnvio);
    cot.destino = "Miraflores (editado)";
    const r = await reusar(sb);
    ok(r.cotizacion?.yaEnviada === true && !r.envioPendiente, "9: una cotización ya enviada sigue respondiendo «ya te la envié»");
  }
}

// ── 29. Revisión S1 · hallazgo 4: en inglés nunca se cae a la PRINCIPAL ──
seccion("29. S1 · hallazgo 4: una celda inglés vacía no usa la principal en inglés: cae al castellano y queda en revisión");
{
  const P = await import("../lib/cotizacion-plantillas");
  const PLF = (id: string, idioma: string, principal = false) => ({ id, nombre: id, idioma, diseno: "corporativo", activa: true, es_principal: principal } as any);
  const pls = [PLF("principal_en", "en", true), PLF("usd_en", "en"), PLF("traslados_ia", "es")];
  const reglas = [{ idioma: "en", moneda: "USD", plantilla_id: "usd_en" }, { idioma: "es", moneda: "PEN", plantilla_id: "traslados_ia" }] as any;
  ok(JSON.stringify(P.inglesDisponible(pls, reglas)) === JSON.stringify({ PEN: false, USD: true }), "el inglés está encendido solo en dólares (la principal no lo enciende)");
  const u = P.plantillaTrasladoIA({ idioma: "en", moneda: "PEN" }, pls, reglas, { reglas: [], segmento: "particular" });
  ok(u.plantilla?.id === "traslados_ia" && u.codigo === "sin_plantilla_idioma" && u.idiomaCondiciones === "es", `inglés · soles sin celda: la de castellano · soles, nunca la principal en inglés (${u.plantilla?.id} ${u.codigo} ${u.idiomaCondiciones})`);
  // La fila que resulta queda en revisión por el idioma (lo que dice Ajustes y lineaIngles).
  const filaPen = C.filaCotizacionTraslado(M.evaluarTraslado(pedido(), ctx), entradaDe(pedido()), { convId: "c", clienteId: null, atencion: null, config, firma: "f", hoy: HOY, plantilla: u.plantilla, idioma: "en" });
  ok(E.revisionPorCondiciones({ avisosPdf: [], consideraciones: filaPen.consideraciones_json, idiomaPdf: filaPen.idioma_pdf }).motivos.includes("condiciones_en_otro_idioma"), "la cotización en inglés y soles queda en revisión (condiciones_en_otro_idioma)");
  const est = E.estadoCotizadorIA({ iaCotiza: true, envioMaestro: true, zonasConEnvio: ["A"], agente: { activo: true, canales: ["whatsapp"], canales_autonomos: ["whatsapp"] }, sinMigracion: false, ingles: P.inglesDisponible(pls, reglas) });
  ok(est.ambar && /quedan en revisión/.test(est.lineas.at(-1)!), "y Ajustes dice lo mismo: «quedan en revisión»");
  // La celda asignada sí alimenta el envío en inglés.
  const usd = P.plantillaTrasladoIA({ idioma: "en", moneda: "USD" }, pls, reglas, { reglas: [], segmento: "extranjero" });
  ok(usd.codigo === "regla" && usd.plantilla?.id === "usd_en" && usd.idiomaCondiciones === "en", "inglés · dólares con su celda: la suya, en inglés");
}

// ── 30. El simulador corta los mensajes ANTES de partirlos en caracteres ──
seccion("30. simular-idioma: el recorte por caracteres completos sin recorrer el texto entero");
{
  const SI = await import("../lib/traslados/simular-idioma");
  const enorme = "a".repeat(2_000_000);
  const t0 = Date.now();
  const r = SI.mensajesDelCuerpo({ mensajes_cliente: [enorme, "😀".repeat(SI.MAX_CARACTERES_MENSAJE * 3), "x".repeat(SI.MAX_CARACTERES_MENSAJE - 1) + "😀😀"] });
  const ms = Date.now() - t0;
  ok(r.ok && r.mensajes![0].length === SI.MAX_CARACTERES_MENSAJE && Array.from(r.mensajes![1]).length === SI.MAX_CARACTERES_MENSAJE && r.mensajes![1] === "😀".repeat(SI.MAX_CARACTERES_MENSAJE),
    "los emojis (dos unidades UTF-16) se recortan enteros, sin un medio carácter suelto");
  ok(r.ok && r.mensajes![2] === "x".repeat(SI.MAX_CARACTERES_MENSAJE - 1) + "😀", "el último carácter completo entra, el siguiente no");
  ok(ms < 1000, `un texto de 2 MB no se recorre entero (${ms} ms)`);
  ok(/Array\.from\(m\.slice\(0, 2 \* MAX_CARACTERES_MENSAJE\)\)/.test(readFileSync("lib/traslados/simular-idioma.ts", "utf8")), "se corta con slice antes de Array.from");
}

console.log(`\n${oks} ok · ${fallos} fallos`);
for (const p of pendientes) console.log(`  ${p}`);
if (fallos) process.exit(1);
