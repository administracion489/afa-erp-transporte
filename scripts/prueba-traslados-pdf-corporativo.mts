/* eslint-disable @typescript-eslint/no-explicit-any -- la matriz arma filas y bases falsas a mano */
// Matriz del PDF del traslado con el formato CORPORATIVO — npx tsx scripts/prueba-traslados-pdf-corporativo.mts
//
// El dueño: «la cotización que manda la IA no tiene el mismo formato de mi página de cotización,
// además faltan imágenes del tipo de vehículo». Desde este cambio el PDF del servidor
// (lib/pdf-corporativo.ts) dibuja el MISMO modelo que pinta el HTML de /cotizaciones
// (`docCorporativo`, lib/cotizacion-corporativo.ts). Lo que se fija aquí:
//  1. Texto por texto y EN EL MISMO ORDEN: toda palabra del HTML corporativo (sin etiquetas ni
//     emojis, con el escape deshecho) está en el PDF, y al revés, salvo las divergencias
//     declaradas (el nombre de la empresa en la tarjeta cuando no hay logo, la marca de agua del
//     ejemplo). Cabecera y pie, en cada hoja. Casos: ida, ida y retorno, dólares, con y sin cliente
//     del ERP, con y sin foto, con y sin logo, EJEMPLO.
//  2. Nunca sale «IA», «tercer» ni las condiciones de la plantilla; el asunto interno tampoco; la
//     validez menor a 30 días se dice («Válida hasta el …»).
//  3. Las fotos: `revisarJpeg` (barrido: si dice ok, pdf-lib la incrusta con esas dimensiones; nunca
//     lanza), `urlFotoPermitida` (otro host, otro bucket, `..`, http, usuario en la URL…), las
//     descargas con lista blanca y la bomba PNG.
//  4. `armarPdfDeFila` de punta a punta sobre una base falsa: los avisos que no bloquean.
//  5. Con todos los topes llenos, el PDF pesa menos de 3.5 MB.
// Con MUESTRA_DIR=<carpeta> escribe el PDF y el HTML de muestra (aeropuerto → Miraflores, ida y retorno).
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as M from "../lib/traslados/motor";
import * as C from "../lib/traslados/cotizacion-traslado";
import * as F from "../lib/traslados/fotos-categoria";
import { htmlCotizacion } from "../lib/cotizacion-pdf";
import { TEXTOS_PDF, t } from "../lib/cotizacion-idioma";
import { docCorporativo, usaValidezHasta, COLOR_CORPORATIVO, cuentasCorporativo } from "../lib/cotizacion-corporativo";
import { dibujarPdfCorporativo, type TrazaPdf } from "../lib/pdf-corporativo";
import { aWinAnsi } from "../lib/pdf-winansi";
import { esc } from "../lib/pdf-chrome";
import { armarPdfDeFila, bajarImagenPublica, bajarLogo, bajarFoto } from "../lib/traslados/enviar-cotizacion-datos";
import { empresaConDefectos } from "../lib/empresa-perfil";

let fallos = 0, oks = 0;
const ok = (c: boolean, m: string) => { if (c) oks++; else { fallos++; if (fallos <= 80) console.log("  FALLA " + m); } };
const seccion = (s: string) => console.log(`\n── ${s}`);

const sharp = (await import("sharp")).default;
const charset: ReadonlySet<number> = new Set((await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica)).getCharacterSet());

// ── Semillas desde el SQL (el mismo lector que prueba-traslados.mts) ─────────
const sql02 = readFileSync("supabase/traslados-02-zonas-lima.sql", "utf8");
const sql03 = readFileSync("supabase/traslados-03-precios-afa.sql", "utf8");
const arr = (lit: string) => lit.replace(/^\{|\}$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "").trim()).filter(Boolean);
let nid = 1;
const zonas: M.Zona[] = [];
for (const m of sql02.matchAll(/\('([^']+)', 'distrito', '([^']+)', '(\{[^']*\})', (\d+)\)/g)) {
  zonas.push({ id: nid++, nombre: m[1], tipo: "distrito", padre_id: null, sector: m[2], alias: arr(m[3]), orden: Number(m[4]), activo: true });
}
const aer = sql02.match(/\('Aeropuerto Jorge Chávez', 'punto', '[^']+',\s*'(\{[^']*\})', (-?[\d.]+), (-?[\d.]+), (\d+)/)!;
zonas.push({ id: nid++, nombre: "Aeropuerto Jorge Chávez", tipo: "punto", padre_id: null, alias: arr(aer[1]), lat: Number(aer[2]), lng: Number(aer[3]), radio_m: Number(aer[4]), activo: true });
const categorias: M.CategoriaTraslado[] = [];
for (const m of sql03.matchAll(/\('(\w+)',\s+'([^']+)',\s+(\d+),\s+(\d+), '(\w+)',\s+(\d+)\)/g)) {
  categorias.push({ clave: m[1], nombre: m[2], capacidad: Number(m[3]), maletas_bodega: Number(m[4]), tipo_vehiculo: m[5], orden: Number(m[6]), activo: true });
}
const precios = [...sql03.slice(sql03.indexOf("p(categoria, pen, usd)")).matchAll(/\('(\w+)', (\d+), (\d+)\)/g)].map((m) => ({ categoria: m[1], pen: Number(m[2]), usd: Number(m[3]) }));
const lits = (s: string) => [...s.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
const config = {
  validez_dias: 30, espera_gratis_min: 30,
  consideraciones: lits([...sql03.matchAll(/consideraciones = array\[([\s\S]*?)\]/g)][0]?.[1] ?? ""),
  consideraciones_usd: lits(sql03.match(/consideraciones_usd = array\[([\s\S]*?)\]/)?.[1] ?? ""),
  incluye: ["Conductor profesional", "Combustible y peajes"], no_incluye: ["Estacionamiento del aeropuerto por retraso del vuelo"],
};
ok(categorias.length >= 5 && precios.length >= 5 && config.consideraciones.length > 0, "semillas leídas");
const zn = (n: string) => zonas.find((x) => x.nombre === n)!;
const AER = zn("Aeropuerto Jorge Chávez");
const tarifas: M.TarifaTraslado[] = [];
for (const d of ["Miraflores", "San Isidro", "Barranco"]) for (const p of precios) for (const moneda of ["PEN", "USD"] as const) {
  const [a, b] = M.parOrdenado(AER.id, zn(d).id);
  tarifas.push({ zona_a_id: a, zona_b_id: b, categoria: p.categoria, moneda, precio_tramo: moneda === "PEN" ? p.pen : p.usd, activo: true });
}
const HOY = "2026-10-19";
const ctx: M.ContextoTraslado = { zonas, categorias, tarifas, tipoCambio: { fecha: HOY, venta: 3.431 }, hoy: HOY, igvPct: 18, validezDias: 30 };
const pt = (loc: string[], extra: Partial<M.PuntoUbicado> = {}): M.PuntoUbicado => ({ texto: loc[0] ?? "", lat: null, lng: null, localidades: loc, barrios: [], ...extra });
const MIRA = pt(["Miraflores", "Provincia de Lima"], { texto: "Hotel Belmond, Miraflores", lat: -12.131, lng: -77.03 });
const AEROP = pt(["Callao"], { texto: "Aeropuerto Jorge Chávez", lat: -12.0297011, lng: -77.1162278 });
const pedido = (x: Partial<M.PedidoTraslado> = {}): M.PedidoTraslado => ({
  origen: AEROP, destino: MIRA, fecha_servicio: "2026-10-25", hora_servicio: "06:30", sentido: "ida", pax: 3, maletas: 2, telefono: "+51966707225", ...x,
});
const entradaDe = (p: M.PedidoTraslado) => ({
  origen: p.origen?.texto ?? "", destino: p.destino?.texto ?? "", fecha_servicio: p.fecha_servicio, hora_servicio: p.hora_servicio ?? null,
  sentido: p.sentido, fecha_retorno: p.fecha_retorno ?? null, hora_retorno: p.hora_retorno ?? null, pax: p.pax, maletas: p.maletas, telefono: p.telefono,
}) as any;
/** La fila que guardaría la IA (con su asunto interno), leída de vuelta. */
const filaDe = (p: M.PedidoTraslado, x: { atencion?: string | null; id?: number; clienteId?: number | null } = {}): C.FilaCotizacionLeida => {
  const r = M.evaluarTraslado(p, ctx);
  if (r.codigo !== "cotizable") throw new Error(`no cotizable: ${r.codigo} ${r.motivo}`);
  const f = C.filaCotizacionTraslado(r, entradaDe(p), { convId: "conv-1", clienteId: x.clienteId ?? null, atencion: x.atencion ?? "Ana Pérez Núñez", config, firma: "f", hoy: HOY });
  return { ...f, id: x.id ?? 1234, numero_cotizacion: null, created_at: "2026-10-19T15:00:00Z" };
};

// Imágenes de prueba: un logo PNG del repo y dos fotos JPEG hechas aquí.
const LOGO_PNG = new Uint8Array(readFileSync("public/logoafacotizacion-removebg-preview.png"));
const jpeg = async (w: number, h: number, color: string, o: { progressive?: boolean; quality?: number } = {}) =>
  new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg({ quality: o.quality ?? 80, progressive: !!o.progressive }).toBuffer());
const FOTO_EXT = await jpeg(1280, 853, "#4a7bb7");
const FOTO_INT = await jpeg(960, 1280, "#8a6a4a");
const BASE = "https://abcd1234.supabase.co";
const URL_EXT = `${BASE}/storage/v1/object/public/traslados-fotos/categorias/SUV/externa-123e4567-e89b-12d3-a456-426614174000.jpg`;
const URL_INT = `${BASE}/storage/v1/object/public/traslados-fotos/categorias/SUV/interna-123e4567-e89b-12d3-a456-426614174001.jpg`;
const perfil = {
  nombre: "Transportes Ñandú", razon_social: "Transportes Ñandú S.A.C.", ruc: "20123456789", telefono: "+51 999 888 777",
  web: "www.ejemplo.pe", email: "ventas@ejemplo.pe", direccion: "Av. Peñaloza 123, Lima", logo_url: `${BASE}/storage/v1/object/public/empresa/logo.png`,
  cuentas_bancarias: [{ banco: "BCP", cuenta: "191-1234567-0-12", cci: "002-191-001234567012-55", moneda: "PEN" as const }, { banco: "BBVA", cuenta: "0011-0123-0100012345", cci: "011-123-000100012345-67" }],
};
const catDe = (clave: string, conFotos: boolean): C.CategoriaPdf => {
  const c = categorias.find((x) => x.clave === clave)!;
  return { ...c, foto_externa_url: conFotos ? URL_EXT : null, foto_interna_url: conFotos ? URL_INT : null, descripcion_cliente: null };
};
/** La categoría que la propia fila cotizó (la que el envío lee de `traslado_categorias`). */
const catDeFila = (f: C.FilaCotizacionLeida, conFotos: boolean) => catDe(f.traslado_json!.categoria!.clave, conFotos);
/** La plantilla corporativa con condiciones propias: NUNCA deben salir en el PDF del traslado. */
const PLANTILLA_CON_CONDICIONES = {
  condiciones_incluye: ["CONDICIÓN DE PLANTILLA INCLUYE"], condiciones_no_incluye: ["CONDICIÓN DE PLANTILLA NO INCLUYE"],
  condiciones_generales: ["CONDICIÓN DE PLANTILLA GENERAL"], titulo_documento: "TÍTULO DE PLANTILLA", mensaje_cierre: "CIERRE DE PLANTILLA",
  mostrar_cuentas_bancarias: true, usar_bancos_propios: false,
};

// ── Texto del HTML y del PDF ─────────────────────────────────────────────────
const desescapar = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const fichas = (s: string) => aWinAnsi(s, charset).toLocaleUpperCase("es-PE").split(/\s+/).filter(Boolean);
const textoDeHtml = (h: string) => fichas(desescapar(h.replace(/<[^>]+>/g, " ")));
/** El HTML corporativo en sus tres zonas: cabecera, cuerpo y pie (sin <head> ni <script>). */
function zonasHtml(html: string) {
  const sinHead = html.replace(/<head>[\s\S]*?<\/head>/, "").replace(/<script>[\s\S]*?<\/script>/g, "");
  const iCab = sinHead.indexOf('<div class="pdf-header"'), iCuerpo = sinHead.indexOf('<div class="grid2">'), iPie = sinHead.indexOf('<div class="pdf-footer"');
  return { cabecera: textoDeHtml(sinHead.slice(iCab, iCuerpo)), cuerpo: textoDeHtml(sinHead.slice(iCuerpo, iPie)), pie: textoDeHtml(sinHead.slice(iPie)) };
}
/** El texto que de verdad está en el PDF (las cadenas `<hex> Tj` de pdf-lib), sin ningún lector. */
function textosDelPdf(bytes: Uint8Array): string[] {
  const s = Buffer.from(bytes).toString("latin1");
  // Sin ICU completo, el TextDecoder de Node lee "windows-1252" como latin1 y
  // pierde 0x80-0x9F (– — “ ” € …): se decodifica con la tabla de WinAnsi.
  const ALTOS = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ";
  const dec = { decode: (b: Buffer) => Array.from(b, (c) => (c >= 0x80 && c <= 0x9f ? ALTOS[c - 0x80] : String.fromCharCode(c))).join("") };
  const out: string[] = [];
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const ini = m.index! + m[0].length;
    const fin = s.indexOf("endstream", ini);
    if (fin < 0) continue;
    const crudo = Buffer.from(s.slice(ini, fin).replace(/\r?\n$/, ""), "latin1");
    let txt: string;
    try { txt = inflateSync(crudo).toString("latin1"); } catch { txt = crudo.toString("latin1"); }
    for (const h of txt.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(dec.decode(Buffer.from(h[1], "hex")));
  }
  return out;
}
const primeraDiferencia = (a: string[], b: string[]) => {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i === a.length && i === b.length ? null : `en ${i}: html «${a.slice(Math.max(0, i - 4), i + 4).join(" ")}» · pdf «${b.slice(Math.max(0, i - 4), i + 4).join(" ")}»`;
};

type Caso = { n: string; fila: C.FilaCotizacionLeida; cliente?: C.ClienteErp | null; categoria?: C.CategoriaPdf | null; logo: boolean; ejemplo?: boolean; plantilla?: any; perfil?: any };

async function compararCaso(c: Caso) {
  const ent = C.entradaCorporativaTraslado(c.fila, {
    empresa: c.perfil ?? perfil, cliente: c.cliente ?? null, celular: "51966707225", plantilla: c.plantilla ?? null,
    categoria: c.categoria ?? null, ejemplo: c.ejemplo, supabaseUrl: BASE, ahoraMs: Date.parse("2026-10-19T15:00:00Z"),
  });
  const html = htmlCotizacion(ent).html!;
  const doc = docCorporativo(ent);
  const traza: TrazaPdf[] = [];
  const fotos: Record<string, Uint8Array> = c.categoria?.foto_externa_url ? { [URL_EXT]: FOTO_EXT, [URL_INT]: FOTO_INT } : {};
  const bytes = await dibujarPdfCorporativo(doc, { logo: c.logo ? { bytes: LOGO_PNG, tipo: "png" } : null, fotos }, { traza, marcaAgua: c.ejemplo ? "EJEMPLO · SIN VALIDEZ" : null });
  const z = zonasHtml(html);
  const cuerpoPdf = fichas(traza.filter((x) => x.zona === "cuerpo").map((x) => x.texto).join(" "));
  const dif = primeraDiferencia(z.cuerpo, cuerpoPdf);
  ok(!dif, `${c.n}: el cuerpo del PDF dice lo mismo que el HTML y en el mismo orden ${dif ?? ""}`);
  const paginas = (await PDFDocument.load(bytes)).getPageCount();
  const nombreTarjeta = c.logo ? [] : fichas(doc.empresaNombre);
  for (let p = 1; p <= paginas; p++) {
    const cab = fichas(traza.filter((x) => x.pagina === p && x.zona === "cabecera").map((x) => x.texto).join(" "));
    const esperada = [...nombreTarjeta, ...z.cabecera];
    ok(!primeraDiferencia(esperada, cab), `${c.n}: cabecera de la hoja ${p} (${primeraDiferencia(esperada, cab) ?? "igual"})`);
    const pie = fichas(traza.filter((x) => x.pagina === p && x.zona === "pie").map((x) => x.texto).join(" "));
    ok(!primeraDiferencia(z.pie, pie), `${c.n}: pie de la hoja ${p} (${primeraDiferencia(z.pie, pie) ?? "igual"})`);
    const marca = traza.filter((x) => x.pagina === p && x.zona === "marca").map((x) => x.texto);
    ok(c.ejemplo ? marca.join() === "EJEMPLO · SIN VALIDEZ" : marca.length === 0, `${c.n}: marca de agua de la hoja ${p} solo en el ejemplo`);
  }
  // La traza es lo que de verdad quedó en el PDF (multiconjunto de cadenas dibujadas).
  const reales = textosDelPdf(bytes).sort(), trazadas = traza.map((x) => x.texto).sort();
  ok(JSON.stringify(reales) === JSON.stringify(trazadas), `${c.n}: la traza es el texto real del PDF (${reales.length} / ${trazadas.length})`);
  const todo = textosDelPdf(bytes).join(" ");
  ok(!/(^|[^\p{L}])IA([^\p{L}]|$)/u.test(todo) && !/tercer/i.test(todo), `${c.n}: ni «IA» ni «tercer» en el PDF`);
  ok(!/PLANTILLA/i.test(todo) && !/PLANTILLA/i.test(html.replace(/<style>[\s\S]*?<\/style>/, "")), `${c.n}: ni las condiciones ni los textos de la plantilla`);
  ok(!/cotizado por/i.test(todo) && !/cotizado por/i.test(html), `${c.n}: el asunto interno no se imprime`);
  ok(!/A\/C/.test(todo), `${c.n}: la unidad no promete «A/C»`);
  ok(Buffer.from(bytes.slice(0, 5)).toString("latin1") === "%PDF-", `${c.n}: es un PDF`);
  return { doc, html, bytes, traza, paginas };
}

// ── 1. El diccionario y la validez ───────────────────────────────────────────
seccion("1. Textos fijos sin caracteres que el HTML escapa · corp_sub_hasta · la validez");
{
  const malos = (["es", "en"] as const).flatMap((i) => Object.entries(TEXTOS_PDF[i]).filter(([, v]) => esc(v) !== v).map(([k]) => `${i}.${k}`));
  ok(malos.length === 0, `ningún texto fijo lleva & < > " ' (escapar la frase = escapar el dato): ${malos.join(", ")}`);
  ok(t("es", "corp_sub_hasta", { fecha: "19/10/2026", hasta: "25/10/2026" }) === "Fecha: 19/10/2026 · Válida hasta el 25/10/2026", "corp_sub_hasta en español");
  ok(t("en", "corp_sub_hasta", { fecha: "10/19/2026", hasta: "10/25/2026" }) === "Date: 10/19/2026 · Valid until 10/25/2026", "corp_sub_hasta en inglés");
  const casos: [string | null, string | null, string | null][] = [
    [null, "2026-10-19", null], ["2026-11-18", "2026-10-19", null], ["2026-10-25", "2026-10-19", "2026-10-25"],
    ["2026-12-31", "2026-10-19", "2026-12-31"], ["2026-02-30", "2026-01-30", null], ["2026-10-25", null, "2026-10-25"], ["x", "2026-10-19", null],
  ];
  for (const [h, e, esp] of casos) ok(usaValidezHasta(h, e) === esp, `validez ${h} con emisión ${e} → ${esp}`);
  // Barrido: «30 días» solo cuando es EXACTAMENTE emisión + 30.
  for (let d = 0; d < 60; d++) {
    const hasta = new Date(Date.UTC(2026, 9, 19 + d)).toISOString().slice(0, 10);
    ok((usaValidezHasta(hasta, "2026-10-19") === null) === (d === 30), `validez a ${d} días`);
  }
}

// ── 2. El HTML corporativo y el PDF del servidor dicen lo mismo ──────────────
seccion("2. HTML ↔ PDF: el mismo texto, en el mismo orden (cabecera y pie en cada hoja)");
const IDA = filaDe(pedido());
const IDA_RET = filaDe(pedido({ sentido: "ida_retorno", fecha_retorno: "2026-10-28", hora_retorno: "18:00" }));
const USD = filaDe(pedido({ telefono: "+13055551234", sentido: "ida_retorno", fecha_retorno: "2026-10-28", hora_retorno: "18:00" }));
const CLIENTE_ERP: C.ClienteErp = { nombre: "Contacto", empresa: "Minera Sur SAC", tipo: "b2b", ruc: "20111222333", direccion: "Av. Arequipa 123", telefono: "999 111 222", operativo_nombre: "Ana" };
const casos: Caso[] = [
  { n: "ida · PEN · sin cliente · con fotos · con logo", fila: IDA, categoria: catDeFila(IDA, true), logo: true },
  { n: "ida y retorno · PEN · con cliente del ERP · sin fotos", fila: IDA_RET, cliente: CLIENTE_ERP, categoria: catDeFila(IDA_RET, false), logo: true },
  { n: "ida y retorno · USD · con fotos · sin logo", fila: USD, categoria: catDeFila(USD, true), logo: false },
  { n: "EJEMPLO del simulador", fila: IDA_RET, categoria: catDeFila(IDA_RET, true), logo: true, ejemplo: true },
  { n: "plantilla con condiciones propias", fila: IDA, categoria: catDeFila(IDA, false), logo: true, plantilla: PLANTILLA_CON_CONDICIONES },
  { n: "sin categoría (borrada): la de la fila, sin fotos", fila: IDA, categoria: null, logo: true },
  { n: "perfil vacío", fila: IDA, categoria: catDeFila(IDA, false), logo: false, perfil: null },
];
const resultados: Awaited<ReturnType<typeof compararCaso>>[] = [];
for (const c of casos) resultados.push(await compararCaso(c));
{
  const [r0, r1, r2, r3] = resultados;
  ok(r0.doc.subtitulo.includes("Válida hasta el 25/10/2026") && r0.traza.some((x) => x.zona === "cabecera" && x.texto.includes("Válida hasta el 25/10/2026")), "la validez menor a 30 días se dice en el PDF");
  ok(r0.doc.color === COLOR_CORPORATIVO && COLOR_CORPORATIVO === "#0b315f", "el color es el de la corporativa");
  ok(r0.doc.cliente.filas[0].segmentos[0].texto === "Ana Pérez Núñez" && r0.doc.cliente.filas[3].segmentos[0].texto === "+51 966 707 225", "sin cliente: CLIENTE = la atención, CELULAR = el wa_id");
  ok(r1.doc.cliente.filas[0].segmentos[0].texto === "Minera Sur SAC" && r1.doc.cliente.filas[1].rotulo === "RUC:" && r1.doc.cliente.filas[3].segmentos[0].texto === "999 111 222", "con cliente del ERP: sus datos");
  ok(!r0.doc.empresa.filas.some((f) => /REPRESENTANTE/.test(f.rotulo)), "el REPRESENTANTE no se imprime");
  ok(r0.doc.detalle.lugares.length === 2 && r1.doc.detalle.lugares.length === 3 && r1.doc.detalle.fechas.length === 4, "solo ida: sin retorno; ida y retorno: fecha y hora de cada uno");
  ok(r2.doc.totales.notas.some((n) => /Tipo de cambio referencial/.test(n)) && r2.doc.tabla.filas[0].total.startsWith("US$"), "en dólares: importes en US$ y el tipo de cambio");
  ok(r0.doc.pagina2.caracteristicas!.vehiculos[0].descripcion === "SUV para hasta 4 pasajeros · bodega para 4 maletas de 23 kg" || /para hasta \d+ pasajeros/.test(r0.doc.pagina2.caracteristicas!.vehiculos[0].descripcion), `la unidad se describe con datos escritos (${r0.doc.pagina2.caracteristicas!.vehiculos[0].descripcion})`);
  ok(r0.doc.notaTotales === C.LINEA_DISPONIBILIDAD && r0.traza.some((x) => x.texto === C.LINEA_DISPONIBILIDAD), "la línea de disponibilidad va bajo los totales");
  ok(r3.doc.titulo.includes("N° EJEMPLO"), "el ejemplo dice EJEMPLO en el número");
  ok(r0.paginas === 2 && r1.paginas === 2, `dos hojas, como el HTML (${r0.paginas}, ${r1.paginas})`);
  // Lista vacía no se imprime (ni en el HTML ni en el PDF).
  const sinListas = { ...IDA, consideraciones_json: { generales: IDA.consideraciones_json!.generales, incluye: [], no_incluye: [] } } as C.FilaCotizacionLeida;
  const rv = await compararCaso({ n: "sin Incluye / No incluye", fila: sinListas, categoria: catDeFila(sinListas, false), logo: true });
  ok(!/INCLUYE/.test(rv.html.replace(/<style>[\s\S]*?<\/style>/, "").toUpperCase().replace(/NO INCLUYE ESTACIONAMIENTO|INCLUYE 30 MIN/g, "")) || !rv.traza.some((x) => /SERVICIO INCLUYE|^NO INCLUYE$/.test(x.texto)), "una lista vacía no se imprime, ni su título");
  ok(!rv.traza.some((x) => x.texto === "SERVICIO INCLUYE" || x.texto === "NO INCLUYE"), "sin Incluye ni No incluye: ningún título vacío en el PDF");
}

// ── 3. La unidad, la plantilla y la entrada ───────────────────────────────────
seccion("3. vehiculoDeCategoria · cfgSoloCuentas · entradaCorporativaTraslado");
{
  const d = (x: Partial<C.CategoriaPdf>) => C.descripcionCategoria({ nombre: "Auto", capacidad: 3, maletas_bodega: 2, descripcion_cliente: null, ...x });
  ok(d({}) === "Auto para hasta 3 pasajeros · bodega para 2 maletas de 23 kg", "frase por defecto");
  ok(d({ maletas_bodega: 0 }) === "Auto para hasta 3 pasajeros", "sin bodega se omite esa parte");
  ok(d({ maletas_bodega: 1, capacidad: 1 }) === "Auto para hasta 1 pasajero · bodega para 1 maleta de 23 kg", "singular");
  ok(d({ nombre: "Minivan H1 10 pax", capacidad: 10, maletas_bodega: 0 }) === "Minivan H1 para hasta 10 pasajeros", "el «N pax» del nombre no se repite");
  ok(d({ nombre: "Minibús 25-30 pax", capacidad: 30, maletas_bodega: 15 }) === "Minibús para hasta 30 pasajeros · bodega para 15 maletas de 23 kg", "ni el «N-M pax»");
  ok(d({ nombre: "Bus 45-50 pax", capacidad: 0, maletas_bodega: 0 }) === "Bus 45-50 pax", "sin capacidad, el nombre queda entero");
  ok(d({ nombre: "50 pax", capacidad: 50, maletas_bodega: 0 }) === "50 pax para hasta 50 pasajeros", "un nombre que es solo «N pax» no queda vacío");
  ok(d({ descripcion_cliente: "  Sedán   negro\ncon aire " }) === "Sedán negro con aire", "la descripción escrita manda (y se limpia)");
  ok(Array.from(d({ descripcion_cliente: "x".repeat(500) })).length === 300, "la escrita se corta en 300");
  for (const c of categorias) ok(!/A\/C|aire/i.test(C.descripcionCategoria(c)), `${c.clave}: la frase por defecto no promete A/C`);
  const v = C.vehiculoDeCategoria(catDe("SUV", true), { supabaseUrl: BASE })!;
  ok(v.foto_externa_url === URL_EXT && v.foto_interna_url === URL_INT && v.equipamiento === null, "fotos del bucket propio pasan");
  const v2 = C.vehiculoDeCategoria({ ...catDe("SUV", true), foto_externa_url: "https://evil.test/storage/v1/object/public/traslados-fotos/x.jpg" }, { supabaseUrl: BASE })!;
  ok(v2.foto_externa_url === null && v2.foto_interna_url === URL_INT, "una foto de otro host se descarta");
  ok(C.vehiculoDeCategoria(null) === null, "sin categoría, sin unidad");
  const cfg = C.cfgSoloCuentas({ ...PLANTILLA_CON_CONDICIONES, banco_1_nombre: "IBK", banco_1_cuenta: "9", color_primario: "#123456" } as any)!;
  ok(JSON.stringify(Object.keys(cfg).sort()) === JSON.stringify(["banco_1_cuenta", "banco_1_nombre", "mostrar_cuentas_bancarias", "usar_bancos_propios"]), `cfgSoloCuentas deja solo las cuentas (${Object.keys(cfg).join(", ")})`);
  ok(C.cfgSoloCuentas(null) === null, "sin plantilla, null");
  ok(C.celularImprimible("51966707225") === "+51 966 707 225" && C.celularImprimible("+13055551234") === "+13055551234" && C.celularImprimible("abc") === null && C.celularImprimible(null) === null, "celularImprimible");
  const e = C.entradaCorporativaTraslado({ ...IDA, atencion: "Pague al Yape 987654321" }, { empresa: perfil, celular: "51966707225" });
  ok(e.cliente!.nombre === "" && e.cot.atencion === null, "una atención sospechosa no se imprime ni como CLIENTE");
  ok(e.cot.asunto === null && e.repr === "" && e.omitirListasVacias === true && e.notaTotales === C.LINEA_DISPONIBILIDAD, "asunto null, sin representante, listas vacías fuera, la nota");
  ok(e.fechaEmision === "2026-10-19" && e.validezHasta === IDA.traslado_json!.validez_hasta, "emisión en hora de Lima y la validez de la fila");
  let lanza = false; try { C.entradaCorporativaTraslado({ ...IDA, items_json: [] }, { empresa: perfil }); } catch { lanza = true; }
  ok(lanza, "sin ítems no hay PDF");
  // Las cuentas: la plantilla con «mostrar» apagado las quita; en dólares, solo las de dólares o sin moneda.
  ok(cuentasCorporativo({ mostrar_cuentas_bancarias: false }, perfil as any, "PEN").cuentas.length === 0, "la plantilla puede apagar las cuentas");
  const usdCuentas = cuentasCorporativo(null, { ...perfil, cuentas_bancarias: [perfil.cuentas_bancarias[0]] } as any, "USD");
  ok(usdCuentas.cuentas.length === 0 && usdCuentas.aviso?.codigo === "sin_cuenta_en_moneda", "USD con solo cuentas en soles: sin bloque, con aviso");
}

// ── 4. revisarJpeg: si dice ok, pdf-lib la incrusta con esas dimensiones ─────
seccion("4. revisarJpeg (barrido) · revisarPng");
{
  const doc = await PDFDocument.create();
  const embebe = async (b: Uint8Array) => { try { const im = await doc.embedJpg(new Uint8Array(b)); return { w: im.width, h: im.height }; } catch { return null; } };
  const PROG = await jpeg(800, 600, "#123456", { progressive: true });
  const GRIS = new Uint8Array(await sharp({ create: { width: 300, height: 200, channels: 3, background: "#777" } }).grayscale().jpeg().toBuffer());
  const GRANDE = await jpeg(2000, 100, "#abcdef");
  const PNG = new Uint8Array(await sharp({ create: { width: 30, height: 30, channels: 3, background: "#fff" } }).png().toBuffer());
  const WEBP = new Uint8Array(await sharp({ create: { width: 30, height: 30, channels: 3, background: "#fff" } }).webp().toBuffer());
  const HEIC = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from("ftypheic"), 0, 0, 0, 0]);
  const PESADO = new Uint8Array(await sharp(Buffer.from(Array.from({ length: 1600 * 1200 * 3 }, (_, i) => (i * 2654435761) >>> 24)), { raw: { width: 1600, height: 1200, channels: 3 } }).jpeg({ quality: 98 }).toBuffer());
  const conSof = (b: Uint8Array, f: (x: Uint8Array, i: number) => void) => { const x = new Uint8Array(b); for (let i = 2; i < x.length - 1; i++) if (x[i] === 0xff && x[i + 1] === 0xc0) { f(x, i); break; } return x; };
  const casos: [string, Uint8Array, string][] = [
    ["baseline", FOTO_EXT, "ok"], ["progresivo", PROG, "ok"], ["gris", GRIS, "ok"],
    ["vacío", new Uint8Array(0), "vacio"], ["PNG", PNG, "no_es_jpeg"], ["WebP", WEBP, "no_es_jpeg"], ["HEIC", HEIC, "no_es_jpeg"],
    ["solo cabecera", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]), "truncado"],
    ["cortado a la mitad", FOTO_EXT.slice(0, FOTO_EXT.length >> 1), "truncado"],
    ["enorme (2000 px)", GRANDE, "muy_grande"], ["pesado", PESADO, PESADO.length > F.FOTO_MAX_BYTES ? "muy_pesado" : "ok"],
    ["SOF3 sin pérdida", conSof(FOTO_EXT, (x, i) => { x[i + 1] = 0xc3; }), "no_soportado"],
    ["12 bits", conSof(FOTO_EXT, (x, i) => { x[i + 4] = 12; }), "precision"],
    ["ancho 0", conSof(FOTO_EXT, (x, i) => { x[i + 7] = 0; x[i + 8] = 0; }), "sin_dimensiones"],
    ["CMYK", conSof(FOTO_EXT, (x, i) => { x[i + 9] = 4; }), "canales"],
  ];
  for (const [n, b, esp] of casos) {
    const r = F.revisarJpeg(b);
    ok(r.codigo === esp, `${n} → ${r.codigo}${r.ok ? "" : ` (${r.detalle})`}`);
    if (!r.ok) ok(/[a-z]/.test(r.detalle) && r.detalle.length > 10, `${n}: el motivo se dice en castellano`);
  }
  ok(PESADO.length > F.FOTO_MAX_BYTES, `el JPEG pesado de la prueba pasa de 600 KB (${Math.round(PESADO.length / 1024)} KB)`);
  // Barrido: todos los recortes y un byte cambiado en cada posición. Nunca lanza, y lo que acepta
  // pdf-lib lo incrusta con las MISMAS dimensiones.
  let lanza = 0, aceptados = 0, discrepa = 0;
  const base = await jpeg(64, 48, "#336699");
  const variantes: Uint8Array[] = [];
  for (let n = 0; n <= base.length; n += 3) variantes.push(base.slice(0, n));
  for (let i = 0; i < Math.min(base.length, 700); i++) for (const v of [0x00, 0xff, 0xc2, 0x08]) { const x = new Uint8Array(base); x[i] = v; variantes.push(x); }
  for (const v of variantes) {
    let r: F.RevisionJpeg;
    try { r = F.revisarJpeg(v); } catch { lanza++; continue; }
    if (!r.ok) continue;
    aceptados++;
    const e = await embebe(v);
    if (!e || e.w !== r.ancho || e.h !== r.alto) discrepa++;
  }
  ok(lanza === 0, `revisarJpeg nunca lanza (${variantes.length} variantes)`);
  ok(discrepa === 0, `lo que acepta, pdf-lib lo incrusta con esas dimensiones (${aceptados} aceptadas, ${discrepa} discrepan)`);
  ok(aceptados > 10, "y el barrido sí acepta variantes válidas (corolario)");
  ok(!F.revisarJpeg(base.slice(0, -2)).ok, "sin el FF D9 final se rechaza");
  // PNG: dimensiones del IHDR sin decodificar.
  ok(F.revisarPng(PNG).ok, "PNG normal");
  const bomba = new Uint8Array(PNG); new DataView(bomba.buffer).setUint32(16, 50000); new DataView(bomba.buffer).setUint32(20, 50000);
  ok(!F.revisarPng(bomba).ok, "bomba PNG (50 000 × 50 000 declarados) se rechaza");
  ok(!F.revisarPng(FOTO_EXT).ok && !F.revisarPng(new Uint8Array(5)).ok, "lo que no es PNG se rechaza");
}

// ── 5. URLs, rutas y descargas ────────────────────────────────────────────────
seccion("5. urlFotoPermitida · rutaFoto · bajarImagenPublica");
{
  const BUENA = `${BASE}/storage/v1/object/public/traslados-fotos/categorias/SUV/externa-x.jpg`;
  const casos: [string, unknown, string | null | undefined, boolean][] = [
    ["la del bucket", BUENA, BASE, true],
    ["otro host", BUENA.replace("abcd1234", "otro"), BASE, false],
    ["host parecido", BUENA.replace("abcd1234.supabase.co", "abcd1234.supabase.co.evil.test"), BASE, false],
    ["otro bucket", BUENA.replace("traslados-fotos", "vehiculos-fotos"), BASE, false],
    ["bucket con prefijo", BUENA.replace("traslados-fotos/", "traslados-fotos-x/"), BASE, false],
    ["salto ..", `${BASE}/storage/v1/object/public/traslados-fotos/../vehiculos-fotos/x.jpg`, BASE, false],
    ["salto codificado", `${BASE}/storage/v1/object/public/traslados-fotos/%2e%2e/x.jpg`, BASE, false],
    ["barra codificada", `${BASE}/storage/v1/object/public/traslados-fotos/a%2fb.jpg`, BASE, false],
    ["barra invertida", `${BASE}/storage/v1/object/public/traslados-fotos/a\\b.jpg`, BASE, false],
    ["http", BUENA.replace("https:", "http:"), BASE, false],
    ["usuario en la URL", BUENA.replace("https://", "https://u:p@"), BASE, false],
    ["con consulta", `${BUENA}?x=1`, BASE, false], ["con fragmento", `${BUENA}#x`, BASE, false],
    ["firmada (privada)", `${BASE}/storage/v1/object/sign/traslados-fotos/x.jpg?token=y`, BASE, false],
    ["ruta vacía", `${BASE}/storage/v1/object/public/traslados-fotos/`, BASE, false],
    ["no es URL", "categorias/SUV/x.jpg", BASE, false], ["null", null, BASE, false],
    ["sin NEXT_PUBLIC_SUPABASE_URL", BUENA, null, false], ["base http", BUENA, BASE.replace("https:", "http:"), false],
  ];
  for (const [n, u, b, esp] of casos) ok(F.urlFotoPermitida(u, b) === esp, `urlFotoPermitida ${n} → ${!esp}`);
  ok(F.rutaDeUrlFoto(BUENA, BASE) === "categorias/SUV/externa-x.jpg", "rutaDeUrlFoto da la ruta dentro del bucket");
  const UUID = "123e4567-e89b-12d3-a456-426614174000";
  ok(F.rutaFoto("SUV", "externa", UUID) === `categorias/SUV/externa-${UUID}.jpg`, "rutaFoto");
  for (const [k, l, u] of [["suv", "externa", UUID], ["SUV/../X", "externa", UUID], ["SUV", "techo", UUID], ["SUV", "interna", "../x"], ["", "interna", UUID]] as [string, any, string][]) {
    let lanza = false; try { F.rutaFoto(k, l, u); } catch { lanza = true; }
    ok(lanza, `rutaFoto rechaza ${k}/${l}/${u}`);
  }
  // Las descargas.
  let llamadas = 0;
  const fetchCon = (b: Uint8Array) => (async () => { llamadas++; return new Response(new Blob([new Uint8Array(b)]), { status: 200 }); }) as typeof fetch;
  const PNG = new Uint8Array(await sharp({ create: { width: 30, height: 30, channels: 3, background: "#fff" } }).png().toBuffer());
  const bomba = new Uint8Array(PNG); new DataView(bomba.buffer).setUint32(16, 50000); new DataView(bomba.buffer).setUint32(20, 50000);
  const GRANDE = await jpeg(2000, 100, "#abcdef");
  const dl: [string, () => Promise<unknown>, boolean, boolean][] = [
    ["foto JPEG del bucket", () => bajarFoto(BUENA, fetchCon(FOTO_EXT), BASE), true, true],
    ["foto PNG (solo JPEG)", () => bajarFoto(BUENA, fetchCon(PNG), BASE), false, true],
    ["foto de 2000 px", () => bajarFoto(BUENA, fetchCon(GRANDE), BASE), false, true],
    ["foto de más de 600 KB", () => bajarFoto(BUENA, fetchCon(new Uint8Array(F.FOTO_MAX_BYTES + 10).fill(0xff)), BASE), false, true],
    ["foto de otro bucket (no se pide)", () => bajarFoto(BUENA.replace("traslados-fotos", "vehiculos-fotos"), fetchCon(FOTO_EXT), BASE), false, false],
    ["foto con .. (no se pide)", () => bajarFoto(`${BASE}/storage/v1/object/public/traslados-fotos/../x.jpg`, fetchCon(FOTO_EXT), BASE), false, false],
    ["logo PNG", () => bajarLogo(`${BASE}/storage/v1/object/public/empresa/logo.png`, fetchCon(LOGO_PNG), BASE), true, true],
    ["logo bomba PNG", () => bajarLogo(`${BASE}/storage/v1/object/public/empresa/logo.png`, fetchCon(bomba), BASE), false, true],
    ["logo JPEG", () => bajarLogo(`${BASE}/storage/v1/object/public/empresa/logo.jpg`, fetchCon(FOTO_EXT), BASE), true, true],
    ["logo de otro host (no se pide)", () => bajarLogo("https://evil.test/storage/v1/object/public/empresa/logo.png", fetchCon(LOGO_PNG), BASE), false, false],
  ];
  for (const [n, f, esp, pide] of dl) {
    const antes = llamadas;
    const r = await f();
    ok(!!r === esp, `${n} → ${r ? "sí" : "no"}`);
    ok((llamadas > antes) === pide, `${n}: ${pide ? "sí" : "no"} se pide`);
  }
  // Sin redirecciones: la descarga se pide con redirect "error".
  let opciones: RequestInit | undefined;
  await bajarImagenPublica(BUENA, "foto", (async (_u: any, o?: RequestInit) => { opciones = o; return new Response(new Blob([new Uint8Array(FOTO_EXT)])); }) as typeof fetch, BASE);
  ok(opciones?.redirect === "error" && !!opciones?.signal, "sin redirecciones y con plazo");
}

// ── 6. armarPdfDeFila de punta a punta, con una base falsa ───────────────────
seccion("6. armarPdfDeFila: los avisos que no bloquean");
{
  type Tabla = Record<string, any>[];
  const base = (t: Record<string, Tabla>, faltan: Record<string, string[]> = {}) => ({
    from(tabla: string) {
      let cols = "*"; const filtros: [string, any][] = [];
      const q: any = {
        select(c: string) { cols = c; return q; },
        eq(c: string, v: any) { filtros.push([c, v]); return q; },
        maybeSingle() { return q; },
        then(ok2: any, mal: any) {
          return Promise.resolve().then(() => {
            const pedidas = cols.replace(/\w+\([^)]*\)/g, "").split(",").map((x) => x.trim()).filter((x) => x && x !== "*");
            const falta = pedidas.find((c) => (faltan[tabla] ?? []).includes(c));
            if (falta) return { data: null, error: { code: "42703", message: `column ${tabla}.${falta} does not exist` } };
            const fila = (t[tabla] ?? []).find((f) => filtros.every(([c, v]) => String(f[c]) === String(v))) ?? null;
            if (fila && /crm_contactos\(/.test(cols)) return { data: { ...fila, crm_contactos: (t.crm_contactos ?? []).find((x) => x.id === fila.contacto_id) ?? null }, error: null };
            return { data: fila, error: null };
          }).then(ok2, mal);
        },
      };
      return q;
    },
  });
  const tablas = (cat: Record<string, any> | null, cuentas = perfil.cuentas_bancarias) => ({
    empresa_perfil: [{ id: 1, ...perfil, cuentas_bancarias: cuentas }],
    traslado_categorias: cat ? [cat] : [],
    crm_conversaciones: [{ id: "conv-1", contacto_id: "ct-1" }],
    crm_contactos: [{ id: "ct-1", wa_id: "51966707225" }],
    clientes: [{ id: 7, ...CLIENTE_ERP }],
    cotizacion_plantillas: [{ id: "corporativo", ...PLANTILLA_CON_CONDICIONES }],
  });
  const prev = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
  const fotosOk = async (u: string) => (u === URL_EXT ? FOTO_EXT : u === URL_INT ? FOTO_INT : null);
  const sinLogo = async () => null;
  const codigos = (a: { avisos: { codigo: string }[] }) => a.avisos.map((x) => x.codigo).sort().join(",");
  const SUV = categorias.find((c) => c.clave === IDA.traslado_json!.categoria!.clave)!;
  const conFotos = { ...SUV, foto_externa_url: URL_EXT, foto_interna_url: URL_INT, descripcion_cliente: null };
  const r1 = await armarPdfDeFila(base(tablas(conFotos)) as any, { ...IDA, cliente_id: 7 }, { bajarLogo: sinLogo, bajarFoto: fotosOk });
  ok(codigos(r1) === "", `todo bien: sin avisos (${codigos(r1)})`);
  const txt1 = textosDelPdf(r1.bytes).join(" ");
  ok(txt1.includes("Minera Sur SAC") && txt1.includes("999 111 222") && !/PLANTILLA/.test(txt1), "imprime el cliente del ERP, y nada de la plantilla salvo sus cuentas");
  ok(r1.nombre === "Cotizacion-01234.pdf" && r1.caption.includes("01234"), `nombre y caption (${r1.nombre})`);
  const r2 = await armarPdfDeFila(base(tablas({ ...SUV, foto_externa_url: null, foto_interna_url: null, descripcion_cliente: null })) as any, IDA, { bajarLogo: sinLogo, bajarFoto: fotosOk });
  ok(codigos(r2) === "sin_foto", `sin fotos: sin_foto (${codigos(r2)})`);
  ok(textosDelPdf(r2.bytes).join(" ").includes("+51 966 707 225"), "sin cliente: el CELULAR es el wa_id de la conversación");
  const r3 = await armarPdfDeFila(base(tablas(conFotos)) as any, IDA, { bajarLogo: sinLogo, bajarFoto: async () => null });
  ok(codigos(r3) === "foto_no_descargada", `la foto no se bajó: foto_no_descargada (${codigos(r3)})`);
  const r4 = await armarPdfDeFila(base(tablas({ ...SUV }), { traslado_categorias: ["foto_externa_url", "foto_interna_url", "descripcion_cliente"] }) as any, IDA, { bajarLogo: sinLogo, bajarFoto: fotosOk });
  ok(codigos(r4) === "sin_migracion_fotos" && r4.bytes.length > 1000, `sin traslados-07: sin_migracion_fotos y el PDF sale igual (${codigos(r4)})`);
  const usdFila = { ...USD };
  const r5 = await armarPdfDeFila(base(tablas(conFotos, [perfil.cuentas_bancarias[0]])) as any, usdFila, { bajarLogo: sinLogo, bajarFoto: fotosOk });
  ok(codigos(r5) === "sin_cuenta_en_moneda", `USD con solo cuentas en soles: sin_cuenta_en_moneda (${codigos(r5)})`);
  const r6 = await armarPdfDeFila(base(tablas({ ...conFotos, foto_externa_url: "https://evil.test/x.jpg" })) as any, IDA, { bajarLogo: sinLogo, bajarFoto: fotosOk });
  ok(codigos(r6) === "foto_no_descargada", `una foto de otro sitio no se baja: foto_no_descargada (${codigos(r6)})`);
  const r7 = await armarPdfDeFila(base(tablas(conFotos)) as any, IDA, { bajarLogo: sinLogo, bajarFoto: fotosOk, ejemplo: true });
  ok(r7.nombre === "Cotizacion-EJEMPLO.pdf" && textosDelPdf(r7.bytes).includes("EJEMPLO · SIN VALIDEZ"), "el ejemplo lleva la marca de agua");
  let lanzaSinPerfil = false;
  try { await armarPdfDeFila({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "caída" } }) }) }) }) } as any, IDA, { bajarLogo: sinLogo }); } catch { lanzaSinPerfil = true; }
  ok(lanzaSinPerfil, "sin poder leer el perfil no hay PDF (lanza)");
  process.env.NEXT_PUBLIC_SUPABASE_URL = prev;
}

// ── 7. El peso con todos los topes llenos ────────────────────────────────────
seccion("7. Con todos los topes llenos, el PDF pesa menos de 3.5 MB");
{
  // Logo PNG de ruido (incompresible) cerca de los 2 MB, y dos fotos JPEG cerca de 600 KB.
  // xorshift32: ruido de verdad (una secuencia de Weyl comprime a 27 KB y no prueba nada).
  const ruido = (n: number, s: number) => { const b = Buffer.alloc(n); let x = (s * 2654435761) >>> 0 || 1; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 255; } return b; };
  const logo = new Uint8Array(await sharp(ruido(800 * 800 * 3, 1), { raw: { width: 800, height: 800, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer());
  let q = 90, foto = new Uint8Array(0);
  for (; q >= 20; q -= 5) { foto = new Uint8Array(await sharp(ruido(1200 * 900 * 3, 7), { raw: { width: 1200, height: 900, channels: 3 } }).jpeg({ quality: q }).toBuffer()); if (foto.length <= F.FOTO_MAX_BYTES) break; }
  ok(logo.length > 1.5 * 1024 * 1024 && logo.length <= 2 * 1024 * 1024 && F.revisarPng(logo, { maxLado: 4000, maxPixeles: 4_000_000 }).ok, `logo de ${Math.round(logo.length / 1024)} KB dentro de los topes`);
  ok(F.revisarJpeg(foto).ok && foto.length > 400 * 1024, `foto de ${Math.round(foto.length / 1024)} KB dentro de los topes`);
  const fila: C.FilaCotizacionLeida = {
    ...IDA_RET,
    items_json: Array.from({ length: 3 }, (_, i) => ({ descripcion: `Ítem ${i + 1} `.padEnd(380, "x"), dias: 1, cantidad: 2, precio_unit: 100, descuento_pct: 0, pax_contratado: null })),
    consideraciones_json: { generales: Array.from({ length: 40 }, (_, i) => `Consideración ${i + 1} `.padEnd(200, "y")), incluye: Array.from({ length: 20 }, (_, i) => `Incluye ${i}`), no_incluye: Array.from({ length: 20 }, (_, i) => `No incluye ${i}`) },
  };
  const ent = C.entradaCorporativaTraslado(fila, { empresa: { ...perfil, cuentas_bancarias: Array.from({ length: 6 }, (_, i) => ({ banco: `Banco ${i}`, cuenta: "1".repeat(20), cci: "2".repeat(20) })) }, celular: "51966707225", categoria: { ...catDeFila(fila, true), descripcion_cliente: "d".repeat(300) }, supabaseUrl: BASE });
  const bytes = await dibujarPdfCorporativo(docCorporativo(ent), { logo: { bytes: logo, tipo: "png" }, fotos: { [URL_EXT]: foto, [URL_INT]: foto } });
  ok(bytes.length < 3.5 * 1024 * 1024, `pesa ${(bytes.length / 1024 / 1024).toFixed(2)} MB (< 3.5)`);
  const pags = (await PDFDocument.load(bytes)).getPageCount();
  ok(pags >= 3, `el contenido largo parte las hojas (${pags})`);
  console.log(`  logo ${Math.round(logo.length / 1024)} KB + 2 fotos de ${Math.round(foto.length / 1024)} KB → PDF de ${(bytes.length / 1024 / 1024).toFixed(2)} MB en ${pags} hojas`);
}

// ── 8. Los módulos no traen datos de una empresa concreta ────────────────────
seccion("8. Sin datos de una empresa concreta en los módulos nuevos");
for (const archivo of ["lib/pdf-corporativo.ts", "lib/cotizacion-corporativo.ts", "lib/traslados/fotos-categoria.ts", "lib/pdf-winansi.ts", "app/api/traslados/categorias/foto/route.ts"]) {
  const src = readFileSync(archivo, "utf8");
  ok(!/\bAFA\b/.test(src) && !/afatours|logoafa/i.test(src) && !src.includes("LOGO_DEFAULT"), `${archivo} sin «AFA», sin su logo y sin el logo del bundle`);
}
ok(!readFileSync("lib/pdf-corporativo.ts", "utf8").includes("LOGO_DEFAULT"), "el PDF del servidor nunca usa el logo del bundle");
ok(!/sharp/.test(readFileSync("lib/traslados/enviar-cotizacion-datos.ts", "utf8").replace(/\/\/.*$/gm, "")) && !/sharp/.test(readFileSync("app/api/traslados/categorias/foto/route.ts", "utf8").replace(/\/\/.*$/gm, "")), "nada se decodifica en el servidor (sin sharp)");
{
  const ruta = readFileSync("app/api/traslados/categorias/foto/route.ts", "utf8");
  ok(/verificarUsuarioApi\(req, "tarifas"\)/.test(ruta) && /mismoOrigen\(req\)/.test(ruta), "la subida exige el módulo Tarifas y el mismo origen");
  ok(/upsert: false/.test(ruta) && /randomUUID\(\)/.test(ruta), "cada foto con nombre nuevo, sin sobrescribir");
  ok(/revisarJpeg\(bytes\)/.test(ruta), "la subida revisa el JPEG por sus bytes");
  ok(ruta.includes("supabase/traslados-07-fotos-categoria.sql"), "sin la migración nombra el SQL");
}

// ── Muestra para mirar (no la exige la matriz) ───────────────────────────────
if (process.env.MUESTRA_DIR) {
  const dir = process.env.MUESTRA_DIR;
  const fotoExt = new Uint8Array(readFileSync(`${dir}/foto-ext.jpg`)), fotoInt = new Uint8Array(readFileSync(`${dir}/foto-int.jpg`));
  const ent = C.entradaCorporativaTraslado(IDA_RET, { empresa: perfil, celular: "51966707225", categoria: catDeFila(IDA_RET, true), supabaseUrl: BASE, ahoraMs: Date.parse("2026-10-19T15:00:00Z") });
  writeFileSync(`${dir}/muestra-traslado.pdf`, await dibujarPdfCorporativo(docCorporativo(ent), { logo: { bytes: LOGO_PNG, tipo: "png" }, fotos: { [URL_EXT]: fotoExt, [URL_INT]: fotoInt } }));
  const local = { ...ent, empresa: { ...ent.empresa, logo_url: `file://${process.cwd()}/public/logoafacotizacion-removebg-preview.png` }, vehiculos: ent.vehiculos.map((v) => ({ ...v, foto_externa_url: `file://${dir}/foto-ext.jpg`, foto_interna_url: `file://${dir}/foto-int.jpg` })) };
  writeFileSync(`${dir}/muestra-traslado.html`, htmlCotizacion(local as any).html!.replace("<script>window.onload=()=>window.print();</script>", ""));
  console.log(`  muestra: ${dir}/muestra-traslado.pdf y .html`);
}

console.log(fallos ? `\n${fallos} FALLAN (${oks} ok)` : `\nTODO OK (${oks} comprobaciones)`);
process.exit(fallos ? 1 : 0);
