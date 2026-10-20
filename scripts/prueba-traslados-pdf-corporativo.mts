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
import { crc32, deflateSync, inflateSync } from "node:zlib";
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
import { armarPdfDeFila, bajarImagenPublica, bajarLogo, bajarFoto, inflarConTope, logoPermitido, LOGO_MAX_BYTES } from "../lib/traslados/enviar-cotizacion-datos";
import { empresaConDefectos } from "../lib/empresa-perfil";
import { mismoTelefonoE164, telefonosE164 } from "../lib/crm-telefono";
import { clienteIdDeRemitente } from "../lib/traslados/cotizar-ia-datos";

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
/** La URL pública de la foto de una categoría, con la forma exacta que le pone la subida (`rutaFoto`). */
const urlFoto = (clave: string, lado: F.LadoFoto) =>
  `${BASE}/storage/v1/object/public/traslados-fotos/${F.rutaFoto(clave, lado, lado === "externa" ? "123e4567-e89b-12d3-a456-426614174000" : "123e4567-e89b-12d3-a456-426614174001")}`;
const URL_EXT = urlFoto("SUV", "externa");
const URL_INT = urlFoto("SUV", "interna");
/** Las fotos de prueba por su URL (cualquier categoría): la exterior y la interior. */
const fotosDe = (cat: { foto_externa_url?: string | null; foto_interna_url?: string | null } | null | undefined): Record<string, Uint8Array> =>
  cat?.foto_externa_url ? { [cat.foto_externa_url]: FOTO_EXT, [cat.foto_interna_url!]: FOTO_INT } : {};
const perfil = {
  nombre: "Transportes Ñandú", razon_social: "Transportes Ñandú S.A.C.", ruc: "20123456789", telefono: "+51 999 888 777",
  web: "www.ejemplo.pe", email: "ventas@ejemplo.pe", direccion: "Av. Peñaloza 123, Lima", logo_url: `${BASE}/storage/v1/object/public/empresa/logo.png`,
  cuentas_bancarias: [{ banco: "BCP", cuenta: "191-1234567-0-12", cci: "002-191-001234567012-55", moneda: "PEN" as const }, { banco: "BBVA", cuenta: "0011-0123-0100012345", cci: "011-123-000100012345-67" }],
};
const catDe = (clave: string, conFotos: boolean): C.CategoriaPdf => {
  const c = categorias.find((x) => x.clave === clave)!;
  return { ...c, foto_externa_url: conFotos ? urlFoto(clave, "externa") : null, foto_interna_url: conFotos ? urlFoto(clave, "interna") : null, descripcion_cliente: null };
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

type Caso = { n: string; fila: C.FilaCotizacionLeida; cliente?: C.ClienteErp | null; contactoClienteId?: number | null; categoria?: C.CategoriaPdf | null; logo: boolean; ejemplo?: boolean; plantilla?: any; perfil?: any };

async function compararCaso(c: Caso) {
  const ent = C.entradaCorporativaTraslado(c.fila, {
    empresa: c.perfil ?? perfil, cliente: c.cliente ?? null, contactoClienteId: c.contactoClienteId ?? null, celular: "51966707225", plantilla: c.plantilla ?? null,
    categoria: c.categoria ?? null, ejemplo: c.ejemplo, supabaseUrl: BASE, ahoraMs: Date.parse("2026-10-19T15:00:00Z"),
  });
  const html = htmlCotizacion(ent).html!;
  const doc = docCorporativo(ent);
  const traza: TrazaPdf[] = [];
  const fotos = fotosDe(c.categoria);
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
  { n: "ida y retorno · PEN · con cliente del ERP · sin fotos", fila: { ...IDA_RET, cliente_id: 7 }, cliente: CLIENTE_ERP, contactoClienteId: 7, categoria: catDeFila(IDA_RET, false), logo: true },
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
  const v3 = C.vehiculoDeCategoria({ ...catDe("SUV", true), foto_externa_url: urlFoto("VAN_12", "externa") }, { supabaseUrl: BASE })!;
  ok(v3.foto_externa_url === null && v3.foto_interna_url === URL_INT, "la foto de OTRA categoría se descarta");
  const v4 = C.vehiculoDeCategoria({ ...catDe("SUV", true), foto_externa_url: URL_INT, foto_interna_url: URL_EXT }, { supabaseUrl: BASE })!;
  ok(v4.foto_externa_url === null && v4.foto_interna_url === null, "una foto puesta en el lado contrario se descarta");
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
seccion("5. urlFotoPermitida (forma exacta de rutaFoto) · rutaFoto · bajarImagenPublica");
{
  const UUID = "123e4567-e89b-12d3-a456-426614174000";
  const BUENA = urlFoto("SUV", "externa");
  const PUB = `${BASE}/storage/v1/object/public/traslados-fotos/`;
  const casos: [string, unknown, string | null | undefined, boolean][] = [
    ["la del bucket", BUENA, BASE, true],
    ["la interior", urlFoto("VAN_12", "interna"), BASE, true],
    ["otro host", BUENA.replace("abcd1234", "otro"), BASE, false],
    ["host parecido", BUENA.replace("abcd1234.supabase.co", "abcd1234.supabase.co.evil.test"), BASE, false],
    ["host en mayúsculas", BUENA.replace("abcd1234.supabase.co", "ABCD1234.supabase.co"), BASE, false],
    ["puerto explícito", BUENA.replace("supabase.co/", "supabase.co:443/"), BASE, false],
    ["otro bucket", BUENA.replace("traslados-fotos", "vehiculos-fotos"), BASE, false],
    ["bucket con prefijo", BUENA.replace("traslados-fotos/", "traslados-fotos-x/"), BASE, false],
    ["salto ..", `${PUB}../vehiculos-fotos/x.jpg`, BASE, false],
    ["salto dentro de la ruta", `${PUB}categorias/SUV/../VAN/externa-${UUID}.jpg`, BASE, false],
    ["salto codificado", `${PUB}%2e%2e/x.jpg`, BASE, false],
    ["barra codificada", `${PUB}categorias%2fSUV/externa-${UUID}.jpg`, BASE, false],
    ["barra invertida", `${PUB}categorias\\SUV/externa-${UUID}.jpg`, BASE, false],
    ["http", BUENA.replace("https:", "http:"), BASE, false],
    ["usuario en la URL", BUENA.replace("https://", "https://u:p@"), BASE, false],
    ["con consulta", `${BUENA}?x=1`, BASE, false], ["con fragmento", `${BUENA}#x`, BASE, false],
    ["firmada (privada)", `${BASE}/storage/v1/object/sign/traslados-fotos/categorias/SUV/externa-${UUID}.jpg?token=y`, BASE, false],
    ["ruta vacía", PUB, BASE, false],
    ["sin carpeta categorias", `${PUB}SUV/externa-${UUID}.jpg`, BASE, false],
    ["clave en minúsculas", `${PUB}categorias/suv/externa-${UUID}.jpg`, BASE, false],
    ["clave de 31", `${PUB}categorias/${"A".repeat(31)}/externa-${UUID}.jpg`, BASE, false],
    ["otro lado", `${PUB}categorias/SUV/techo-${UUID}.jpg`, BASE, false],
    ["uuid en mayúsculas", `${PUB}categorias/SUV/externa-${UUID.toUpperCase()}.jpg`, BASE, false],
    ["sin uuid", `${PUB}categorias/SUV/externa-x.jpg`, BASE, false],
    ["uuid corto", `${PUB}categorias/SUV/externa-${UUID.slice(0, -1)}.jpg`, BASE, false],
    [".JPG", BUENA.replace(".jpg", ".JPG"), BASE, false],
    [".jpeg", BUENA.replace(".jpg", ".jpeg"), BASE, false],
    ["con sufijo", `${BUENA}.png`, BASE, false],
    ["subcarpeta extra", `${PUB}categorias/SUV/x/externa-${UUID}.jpg`, BASE, false],
    ["con espacios alrededor", `  ${BUENA}  `, BASE, true],
    ["no es URL", F.rutaFoto("SUV", "externa", UUID), BASE, false], ["null", null, BASE, false],
    ["sin NEXT_PUBLIC_SUPABASE_URL", BUENA, null, false], ["base http", BUENA, BASE.replace("https:", "http:"), false],
  ];
  for (const [n, u, b, esp] of casos) ok(F.urlFotoPermitida(u, b) === esp, `urlFotoPermitida ${n} → ${esp}`);
  ok(F.rutaDeUrlFoto(BUENA, BASE) === `categorias/SUV/externa-${UUID}.jpg`, "rutaDeUrlFoto da la ruta dentro del bucket");
  // Con la categoría y el lado esperados (el borrado del endpoint y el PDF los pasan).
  ok(F.rutaDeUrlFoto(BUENA, BASE, { clave: "SUV", lado: "externa" }) != null, "la de su categoría y su lado pasa");
  ok(F.rutaDeUrlFoto(BUENA, BASE, { clave: "VAN_12", lado: "externa" }) === null, "la de OTRA categoría no pasa (no se borra al quitar la de esta)");
  ok(F.rutaDeUrlFoto(BUENA, BASE, { clave: "SUV", lado: "interna" }) === null, "la del otro lado no pasa");
  ok(F.rutaDeUrlFoto(BUENA, BASE, { clave: "SU", lado: "externa" }) === null && F.rutaDeUrlFoto(urlFoto("SUV_2", "externa"), BASE, { clave: "SUV", lado: "externa" }) === null, "ni una clave que es prefijo de otra");
  // Ciclo: lo que produce rutaFoto (con cualquier clave válida y un uuid de crypto) es lo que acepta la URL, y nada más.
  for (let i = 0; i < 300; i++) {
    const clave = ["A", "SUV", "VAN_12", "MINIBUS_30", "X".repeat(30), `C${i}`][i % 6];
    const lado = F.LADOS_FOTO[i % 2];
    const ruta = F.rutaFoto(clave, lado, crypto.randomUUID().toUpperCase());
    ok(F.RE_RUTA_FOTO.test(ruta) && F.rutaDeUrlFoto(`${PUB}${ruta}`, BASE, { clave, lado }) === ruta, `ciclo rutaFoto → URL → ruta (${ruta})`);
  }
  // La regla que se le pasa al CHECK de traslados-07 (texto exacto, con la clave y el lado de la columna).
  ok(F.RE_RUTA_FOTO.source === String.raw`^categorias\/([A-Z0-9_]{1,30})\/(externa|interna)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$`, "RE_RUTA_FOTO es la acordada con el CHECK de la migración");
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
  const LOGO = `${BASE}/storage/v1/object/public/empresa/logo.png`;
  const dl: [string, () => Promise<unknown>, boolean, boolean][] = [
    ["foto JPEG del bucket", () => bajarFoto(BUENA, fetchCon(FOTO_EXT), BASE), true, true],
    ["foto PNG (solo JPEG)", () => bajarFoto(BUENA, fetchCon(PNG), BASE), false, true],
    ["foto de 2000 px", () => bajarFoto(BUENA, fetchCon(GRANDE), BASE), false, true],
    ["foto de más de 600 KB", () => bajarFoto(BUENA, fetchCon(new Uint8Array(F.FOTO_MAX_BYTES + 10).fill(0xff)), BASE), false, true],
    ["foto de otro bucket (no se pide)", () => bajarFoto(BUENA.replace("traslados-fotos", "vehiculos-fotos"), fetchCon(FOTO_EXT), BASE), false, false],
    ["foto con .. (no se pide)", () => bajarFoto(`${PUB}../x.jpg`, fetchCon(FOTO_EXT), BASE), false, false],
    ["foto sin la forma de rutaFoto (no se pide)", () => bajarFoto(`${PUB}categorias/SUV/externa-x.jpg`, fetchCon(FOTO_EXT), BASE), false, false],
    ["logo PNG", () => bajarLogo(LOGO, fetchCon(LOGO_PNG), BASE), true, true],
    ["logo PNG con ?t= (como lo guarda /configuracion/perfil)", () => bajarLogo(`${LOGO}?t=1760000000000`, fetchCon(LOGO_PNG), BASE), true, true],
    ["logo bomba PNG (IHDR enorme)", () => bajarLogo(LOGO, fetchCon(bomba), BASE), false, true],
    ["logo JPEG", () => bajarLogo(`${BASE}/storage/v1/object/public/empresa/logo.jpg`, fetchCon(FOTO_EXT), BASE), true, true],
    ["logo de otro host (no se pide)", () => bajarLogo("https://evil.test/storage/v1/object/public/empresa/logo.png", fetchCon(LOGO_PNG), BASE), false, false],
    ["logo de otro bucket del proyecto (no se pide)", () => bajarLogo(`${BASE}/storage/v1/object/public/vehiculos-fotos/logo.png`, fetchCon(LOGO_PNG), BASE), false, false],
    ["logo del bucket de fotos de traslado (no se pide)", () => bajarLogo(BUENA, fetchCon(FOTO_EXT), BASE), false, false],
    ["logo de más de 512 KB", () => bajarLogo(LOGO, fetchCon(new Uint8Array(LOGO_MAX_BYTES + 10).fill(0x89)), BASE), false, true],
  ];
  for (const [n, f, esp, pide] of dl) {
    const antes = llamadas;
    const r = await f();
    ok(!!r === esp, `${n} → ${r ? "sí" : "no"}`);
    ok((llamadas > antes) === pide, `${n}: ${pide ? "sí" : "no"} se pide`);
  }
  ok(LOGO_MAX_BYTES === 512 * 1024, "el logo pesa como mucho 512 KB");
  ok(logoPermitido(LOGO, BASE) && !logoPermitido(`${BASE}/storage/v1/object/public/empresa/`, BASE) && !logoPermitido(`${LOGO}#x`, BASE) && !logoPermitido(`${BASE}/storage/v1/object/public/empresa/../x.png`, BASE), "logoPermitido: solo un archivo del bucket empresa");
  // Sin redirecciones: la descarga se pide con redirect "error".
  let opciones: RequestInit | undefined;
  await bajarImagenPublica(BUENA, "foto", (async (_u: any, o?: RequestInit) => { opciones = o; return new Response(new Blob([new Uint8Array(FOTO_EXT)])); }) as typeof fetch, BASE);
  ok(opciones?.redirect === "error" && !!opciones?.signal, "sin redirecciones y con plazo");
}

// ── 5b. El PNG del logo: todos los chunks, sin animación, IDAT con tope ─────
seccion("5b. revisarPng: APNG, IDAT inflado, entrelazado, IHDR enorme (la auditoría)");
{
  const chunk = (tipo: string, datos: Uint8Array) => {
    const b = Buffer.alloc(12 + datos.length);
    b.writeUInt32BE(datos.length, 0); b.write(tipo, 4, "ascii"); Buffer.from(datos).copy(b, 8);
    b.writeUInt32BE(crc32(b.subarray(4, 8 + datos.length)) >>> 0, 8 + datos.length);
    return b;
  };
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = (w: number, h: number, prof = 8, color = 6, entre = 0) => {
    const d = Buffer.alloc(13); d.writeUInt32BE(w, 0); d.writeUInt32BE(h, 4); d[8] = prof; d[9] = color; d[12] = entre; return chunk("IHDR", d);
  };
  const png = (...partes: Buffer[]) => new Uint8Array(Buffer.concat([SIG, ...partes, chunk("IEND", Buffer.alloc(0))]));
  const OPC = { maxBytes: LOGO_MAX_BYTES, maxLado: 4000, maxPixeles: 4_000_000, inflar: inflarConTope };
  const crudo10 = deflateSync(Buffer.alloc((10 * 4 + 1) * 10));

  // (1) La de la auditoría: APNG de pocos bytes con un fotograma de 6000 × 6000 (16000 × 16000 en su prueba).
  for (const N of [6000, 16000]) {
    const actl = Buffer.alloc(8); actl.writeUInt32BE(1, 0);
    const fctl = Buffer.alloc(26); fctl.writeUInt32BE(1, 0); fctl.writeUInt32BE(N, 4); fctl.writeUInt32BE(N, 8);
    const fdat = Buffer.concat([Buffer.from([0, 0, 0, 2]), deflateSync(Buffer.alloc(1000))]);
    const apng = png(ihdr(10, 10), chunk("acTL", actl), chunk("IDAT", crudo10), chunk("fcTL", fctl), chunk("fdAT", fdat));
    const t0 = Date.now();
    const r = F.revisarPng(apng, OPC);
    ok(!r.ok && r.codigo === "animado" && Date.now() - t0 < 200, `APNG ${N} × ${N} en ${apng.length} B → rechazado sin decodificar (${r.ok ? "ok" : r.codigo})`);
    ok(!F.revisarPng(apng).ok, `APNG ${N}: también sin inflar (puro)`);
  }
  // Un solo fcTL o fdAT sin acTL también es animación.
  ok(F.revisarPng(png(ihdr(10, 10), chunk("IDAT", crudo10), chunk("fdAT", Buffer.alloc(8)))).codigo === "animado" as any, "un fdAT suelto → animado");

  // (2) La de la auditoría: IDAT que se infla a cientos de MB (100 × 100 RGBA ≈ 40 KB declarados).
  const t1 = Date.now();
  const idat400 = deflateSync(Buffer.alloc(400 * 1024 * 1024), { level: 9 });
  const bomba400 = png(ihdr(100, 100), chunk("IDAT", idat400));
  const r400 = F.revisarPng(bomba400, OPC);
  ok(!r400.ok && r400.codigo === "idat_desproporcionado", `IDAT de ${Math.round(idat400.length / 1024)} KB que infla 400 MB → idat_desproporcionado (${r400.ok ? "ok" : r400.codigo})`);
  ok(!F.revisarPng(bomba400).ok, "también sin inflar (puro): el IDAT no cabe en lo que la imagen declara");
  // (3) Una bomba que SÍ cabe en el tope de tamaño del IDAT: 1000 × 1000 RGBA (4 MB declarados) con 300 MB dentro.
  const idat300 = deflateSync(Buffer.alloc(300 * 1024 * 1024), { level: 9 });
  const bomba300 = png(ihdr(1000, 1000), chunk("IDAT", idat300));
  ok(bomba300.length <= LOGO_MAX_BYTES && idat300.length <= F.idatMaximo(F.bytesCrudosPng(1000, 1000, 6, 8, false)), `la bomba de 300 MB pesa ${Math.round(bomba300.length / 1024)} KB: cabe en los topes de bytes`);
  const t2 = Date.now();
  const r300 = F.revisarPng(bomba300, OPC);
  const ms300 = Date.now() - t2;
  ok(!r300.ok && r300.codigo === "idat_invalido" && ms300 < 1500, `con inflar (servidor) → idat_invalido en ${ms300} ms (${r300.ok ? "ok" : r300.codigo})`);
  ok(F.revisarPng(bomba300, { maxBytes: LOGO_MAX_BYTES }).ok, "sin inflar no se puede ver (por eso el servidor la infla con tope)");
  ok(Date.now() - t1 < 20_000, "las bombas se juzgan en segundos, no en minutos");
  // Menos datos de los declarados también se rechaza (pdf-lib la pintaría a medias).
  ok(F.revisarPng(png(ihdr(10, 10), chunk("IDAT", deflateSync(Buffer.alloc(100)))), OPC).codigo === "idat_invalido" as any, "IDAT corto → idat_invalido");
  ok(F.revisarPng(png(ihdr(10, 10), chunk("IDAT", Buffer.from([1, 2, 3, 4, 5]))), OPC).codigo === "idat_invalido" as any, "IDAT que no es zlib → idat_invalido");

  // (4) IHDR enorme y formatos imposibles.
  ok(F.revisarPng(png(ihdr(50000, 50000), chunk("IDAT", crudo10)), OPC).codigo === "muy_grande" as any, "IHDR 50000 × 50000 → muy_grande");
  ok(F.revisarPng(png(ihdr(4000, 1001), chunk("IDAT", crudo10)), OPC).codigo === "muy_grande" as any, "más de 4 Mpx → muy_grande");
  ok(F.revisarPng(png(ihdr(0, 10), chunk("IDAT", crudo10)), OPC).codigo === "sin_dimensiones" as any, "ancho 0 → sin_dimensiones");
  ok(F.revisarPng(png(ihdr(10, 10, 16, 3), chunk("IDAT", crudo10)), OPC).codigo === "formato" as any, "paleta de 16 bits → formato");
  ok(F.revisarPng(png(ihdr(10, 10, 8, 6, 2), chunk("IDAT", crudo10)), OPC).codigo === "formato" as any, "entrelazado desconocido → formato");
  ok(F.revisarPng(png(ihdr(10, 10, 8, 3), chunk("IDAT", deflateSync(Buffer.alloc(110)))), OPC).codigo === "estructura" as any, "paleta sin PLTE → estructura");
  // (5) Estructura: largo de bloque mayor que el archivo (UPNG haría un bucle de 4 mil millones), sin IEND, IDAT partidos.
  const malLargo = Buffer.from(png(ihdr(10, 10), chunk("IDAT", crudo10)));
  malLargo.writeUInt32BE(0xfffffff0, 8 + 25);
  ok(F.revisarPng(new Uint8Array(malLargo), OPC).codigo === "truncado" as any, "un bloque que dice medir 4 GB → truncado");
  ok(F.revisarPng(new Uint8Array(Buffer.concat([SIG, ihdr(10, 10), chunk("IDAT", crudo10)])), OPC).codigo === "truncado" as any, "sin IEND → truncado");
  ok(F.revisarPng(png(ihdr(10, 10), chunk("IDAT", crudo10.subarray(0, 10)), chunk("tEXt", Buffer.from("a\0b")), chunk("IDAT", crudo10.subarray(10))), OPC).codigo === "estructura" as any, "IDAT partidos por otro bloque → estructura");
  ok(F.revisarPng(png(ihdr(10, 10), chunk("IDAT", crudo10.subarray(0, 10)), chunk("IDAT", crudo10.subarray(10))), OPC).ok, "IDAT seguidos en dos bloques → ok");
  ok(F.revisarPng(png(ihdr(10, 10)), OPC).codigo === "sin_datos" as any, "sin IDAT → sin_datos");
  ok(F.revisarPng(new Uint8Array(Buffer.concat([SIG, chunk("tEXt", Buffer.from("a\0b")), ihdr(10, 10), chunk("IDAT", crudo10), chunk("IEND", Buffer.alloc(0))])), OPC).codigo === "estructura" as any, "IHDR que no va primero → estructura");
  ok(F.revisarPng(new Uint8Array(LOGO_MAX_BYTES + 1).fill(0x89), OPC).codigo === "muy_pesado" as any, "más de 512 KB → muy_pesado");

  // (6) Los PNG de verdad pasan, y pdf-lib los incrusta: el logo del repo, entrelazado, paleta, gris, 16 bits.
  const reales: [string, Uint8Array][] = [
    ["logo del repo", LOGO_PNG],
    ["entrelazado (Adam7)", new Uint8Array(await sharp({ create: { width: 97, height: 53, channels: 4, background: { r: 10, g: 200, b: 30, alpha: 0.5 } } }).png({ progressive: true }).toBuffer())],
    ["paleta", new Uint8Array(await sharp({ create: { width: 64, height: 40, channels: 3, background: "#123456" } }).png({ palette: true }).toBuffer())],
    ["paleta entrelazada", new Uint8Array(await sharp({ create: { width: 33, height: 17, channels: 3, background: "#654321" } }).png({ palette: true, progressive: true }).toBuffer())],
    ["gris", new Uint8Array(await sharp({ create: { width: 50, height: 9, channels: 3, background: "#777" } }).grayscale().png().toBuffer())],
    ["16 bits", new Uint8Array(await sharp({ create: { width: 20, height: 20, channels: 3, background: "#abcdef" } }).toColourspace("rgb16").png().toBuffer())],
    ["1 × 1", new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 4, background: "#fff" } }).png().toBuffer())],
  ];
  for (const [n, b] of reales) {
    const r = F.revisarPng(b, OPC);
    let incrusta = false;
    try { const d = await PDFDocument.create(); const im = await d.embedPng(b); incrusta = r.ok && im.width === r.ancho && im.height === r.alto; } catch { incrusta = false; }
    ok(r.ok && incrusta, `${n}: pasa y pdf-lib lo incrusta con esas medidas (${r.ok ? `${r.ancho}×${r.alto}${r.entrelazado ? " entrelazado" : ""}` : r.codigo})`);
  }
  // El tamaño inflado de Adam7 es el que da zlib de verdad.
  const ent = reales[1][1];
  const rEnt = F.revisarPng(ent, OPC);
  ok(rEnt.ok && rEnt.entrelazado, "el entrelazado se reconoce y se mide con sus siete pasadas");
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
  const tablas = (cat: Record<string, any> | null, cuentas = perfil.cuentas_bancarias): Record<string, any[]> => ({
    empresa_perfil: [{ id: 1, ...perfil, cuentas_bancarias: cuentas }],
    traslado_categorias: cat ? [cat] : [],
    crm_conversaciones: [{ id: "conv-1", contacto_id: "ct-1" }],
    crm_contactos: [{ id: "ct-1", wa_id: "51966707225", cliente_id: 7 }],
    clientes: [{ id: 7, ...CLIENTE_ERP }],
    cotizacion_plantillas: [{ id: "corporativo", ...PLANTILLA_CON_CONDICIONES }],
  });
  const prev = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = BASE;
  const fotosOk = async (u: string) => (!F.urlFotoPermitida(u, BASE) ? null : /\/externa-/.test(u) ? FOTO_EXT : FOTO_INT);
  const sinLogo = async () => null;
  const conLogo = async () => ({ bytes: LOGO_PNG, tipo: "png" as const });
  const codigos = (a: { avisos: { codigo: string }[] }) => a.avisos.map((x) => x.codigo).sort().join(",");
  const SUV = categorias.find((c) => c.clave === IDA.traslado_json!.categoria!.clave)!;
  const conFotos = { ...SUV, foto_externa_url: urlFoto(SUV.clave, "externa"), foto_interna_url: urlFoto(SUV.clave, "interna"), descripcion_cliente: null };
  const r1 = await armarPdfDeFila(base(tablas(conFotos)) as any, { ...IDA, cliente_id: 7 }, { bajarLogo: conLogo, bajarFoto: fotosOk });
  ok(codigos(r1) === "", `todo bien: sin avisos (${codigos(r1)})`);
  const txt1 = textosDelPdf(r1.bytes).join(" ");
  ok(txt1.includes("Minera Sur SAC") && txt1.includes("999 111 222") && !/PLANTILLA/.test(txt1), "imprime el cliente del ERP, y nada de la plantilla salvo sus cuentas");
  ok(r1.nombre === "Cotizacion-01234.pdf" && r1.caption.includes("01234"), `nombre y caption (${r1.nombre})`);
  const r2 = await armarPdfDeFila(base(tablas({ ...SUV, foto_externa_url: null, foto_interna_url: null, descripcion_cliente: null })) as any, IDA, { bajarLogo: conLogo, bajarFoto: fotosOk });
  ok(codigos(r2) === "sin_foto", `sin fotos: sin_foto (${codigos(r2)})`);
  ok(textosDelPdf(r2.bytes).join(" ").includes("+51 966 707 225"), "sin cliente: el CELULAR es el wa_id de la conversación");
  const r3 = await armarPdfDeFila(base(tablas(conFotos)) as any, IDA, { bajarLogo: conLogo, bajarFoto: async () => null });
  ok(codigos(r3) === "foto_no_descargada", `la foto no se bajó: foto_no_descargada (${codigos(r3)})`);
  const r4 = await armarPdfDeFila(base(tablas({ ...SUV }), { traslado_categorias: ["foto_externa_url", "foto_interna_url", "descripcion_cliente"] }) as any, IDA, { bajarLogo: conLogo, bajarFoto: fotosOk });
  ok(codigos(r4) === "sin_migracion_fotos" && r4.bytes.length > 1000, `sin traslados-07: sin_migracion_fotos y el PDF sale igual (${codigos(r4)})`);
  const usdFila = { ...USD };
  const r5 = await armarPdfDeFila(base(tablas(conFotos, [perfil.cuentas_bancarias[0]])) as any, usdFila, { bajarLogo: conLogo, bajarFoto: fotosOk });
  ok(codigos(r5) === "sin_cuenta_en_moneda", `USD con solo cuentas en soles: sin_cuenta_en_moneda (${codigos(r5)})`);
  const r6 = await armarPdfDeFila(base(tablas({ ...conFotos, foto_externa_url: "https://evil.test/x.jpg" })) as any, IDA, { bajarLogo: conLogo, bajarFoto: fotosOk });
  ok(codigos(r6) === "foto_no_descargada", `una foto de otro sitio no se baja: foto_no_descargada (${codigos(r6)})`);
  const r7 = await armarPdfDeFila(base(tablas(conFotos)) as any, IDA, { bajarLogo: conLogo, bajarFoto: fotosOk, ejemplo: true });
  ok(r7.nombre === "Cotizacion-EJEMPLO.pdf" && textosDelPdf(r7.bytes).includes("EJEMPLO · SIN VALIDEZ"), "el ejemplo lleva la marca de agua");
  // El logo: si el perfil tiene uno y no se pudo usar, se avisa (y el PDF lleva el nombre de la empresa).
  const r8 = await armarPdfDeFila(base(tablas(conFotos)) as any, IDA, { bajarLogo: sinLogo, bajarFoto: fotosOk });
  ok(codigos(r8) === "logo_no_usado" && textosDelPdf(r8.bytes).includes("Transportes Ñandú"), `logo que no se pudo usar: logo_no_usado y el nombre en la tarjeta (${codigos(r8)})`);
  const tOtro = tablas(conFotos); tOtro.empresa_perfil[0].logo_url = `${BASE}/storage/v1/object/public/vehiculos-fotos/logo.png`;
  const r9 = await armarPdfDeFila(base(tOtro) as any, IDA, { bajarFoto: fotosOk });
  ok(codigos(r9) === "logo_no_usado" && r9.avisos[0].detalle.includes("no está en el almacenamiento del perfil"), `logo de otro bucket: no se pide y se dice por qué (${r9.avisos.map((a) => a.detalle).join(" | ")})`);
  // El cliente del ERP: vinculado al contacto → se imprime; sin vínculo y con otro número → atención y celular.
  const tSinVinculo = tablas(conFotos); tSinVinculo.crm_contactos[0].cliente_id = null;
  const r10 = await armarPdfDeFila(base(tSinVinculo) as any, { ...IDA, cliente_id: 7 }, { bajarLogo: conLogo, bajarFoto: fotosOk });
  const txt10 = textosDelPdf(r10.bytes).join(" ");
  ok(codigos(r10) === "cliente_no_verificado" && !txt10.includes("Minera Sur SAC") && !txt10.includes("20111222333") && txt10.includes("Ana Pérez Núñez") && txt10.includes("+51 966 707 225"), `cliente sin vincular y con otro número: atención y celular, sin RUC ni razón social (${codigos(r10)})`);
  const tMismoNumero = tablas(conFotos); tMismoNumero.crm_contactos[0].cliente_id = null; tMismoNumero.clientes[0].telefono = "966 707 225";
  const r11 = await armarPdfDeFila(base(tMismoNumero) as any, { ...IDA, cliente_id: 7 }, { bajarLogo: conLogo, bajarFoto: fotosOk });
  ok(codigos(r11) === "" && textosDelPdf(r11.bytes).join(" ").includes("Minera Sur SAC"), `cliente sin vincular pero con el MISMO número completo: se imprime (${codigos(r11)})`);
  const tExtranjero = tablas(conFotos); tExtranjero.crm_contactos[0] = { id: "ct-1", wa_id: "447987654321", cliente_id: null }; tExtranjero.clientes[0].telefono = "987654321";
  const r12 = await armarPdfDeFila(base(tExtranjero) as any, { ...IDA, cliente_id: 7 }, { bajarLogo: conLogo, bajarFoto: fotosOk });
  ok(codigos(r12) === "cliente_no_verificado" && !textosDelPdf(r12.bytes).join(" ").includes("Minera Sur SAC"), `+44 7987654321 frente al cliente 987654321: no se imprime (${codigos(r12)})`);
  const r13 = await armarPdfDeFila(base(tSinVinculo) as any, { ...IDA, cliente_id: 7 }, { bajarLogo: conLogo, bajarFoto: fotosOk, celular: "51966707225", contactoClienteId: 7 });
  ok(codigos(r13) === "" && textosDelPdf(r13.bytes).join(" ").includes("Minera Sur SAC"), "el vínculo que pasa quien llama (la IA, con su contacto) cuenta");
  let lanzaSinPerfil = false;
  try { await armarPdfDeFila({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "caída" } }) }) }) }) } as any, IDA, { bajarLogo: sinLogo }); } catch { lanzaSinPerfil = true; }
  ok(lanzaSinPerfil, "sin poder leer el perfil no hay PDF (lanza)");
  process.env.NEXT_PUBLIC_SUPABASE_URL = prev;
}

// ── 6b. El cliente del ERP: número COMPLETO, nunca los últimos 9 dígitos ─────
seccion("6b. Cliente del ERP: telefonosE164 · clienteParaPdf · clienteIdDeRemitente");
{
  const casosTel: [string | null, string[]][] = [
    ["51987654321", ["51987654321"]], ["987654321", ["51987654321"]], ["+51 987 654 321", ["51987654321"]],
    ["0051987654321", ["51987654321"]], ["+44 7987654321", ["447987654321"]], ["447987654321", ["447987654321"]],
    ["(01) 456-7890", ["5114567890"]], ["044 123456", ["5144123456"]], ["4567890", []], ["123456789", []],
    ["987654321 / 912345678", ["51987654321", "51912345678"]], ["987654321 y 912345678", ["51987654321", "51912345678"]],
    ["+1 (305) 555-1234", ["13055551234"]], ["", []], [null, []], ["abc", []], ["9876543210000000", []],
  ];
  for (const [t, esp] of casosTel) ok(JSON.stringify(telefonosE164(t)) === JSON.stringify(esp), `telefonosE164(${JSON.stringify(t)}) = ${JSON.stringify(telefonosE164(t))}`);
  ok(!mismoTelefonoE164("+44 7987654321", "987654321"), "+44 7987654321 NO es el cliente 987654321 (terminan igual)");
  ok(mismoTelefonoE164("51987654321", "987654321"), "51987654321 sí es el cliente 987654321");
  ok(!mismoTelefonoE164("51987654321", "4567890") && !mismoTelefonoE164("", "") && !mismoTelefonoE164(null, "987654321"), "sin número completo no empareja");
  // Barrido: con un wa_id de otro país, ningún número local de 9 dígitos empareja; con +51, solo el suyo.
  for (let i = 0; i < 400; i++) {
    const local = `9${String(10_000_000 + i * 21_911).padStart(8, "0")}`;
    for (const pais of ["44", "1", "34", "57", "591", "52"]) ok(!mismoTelefonoE164(`${pais}${local}`, local), `+${pais} ${local} no es el ${local}`);
    ok(mismoTelefonoE164(`51${local}`, local) && !mismoTelefonoE164(`51${local}`, `9${local.slice(1, -1)}${(Number(local.at(-1)) + 1) % 10}`), `51${local} es el ${local} y no otro`);
  }
  const CL: C.ClienteErp = { empresa: "Minera Sur SAC", ruc: "20111222333", telefono: "987654321" };
  const vin = (id: unknown, ref: { contactoClienteId?: number | null; waId?: string | null }, cl: C.ClienteErp | null = CL) => C.clienteParaPdf(id, cl, ref).vinculo;
  ok(vin(7, { contactoClienteId: 7, waId: "447987654321" }) === "contacto", "vinculado por una persona: se imprime aunque el número no sea el suyo");
  ok(vin(7, { contactoClienteId: 8, waId: "51987654321" }) === "telefono", "mismo número completo: se imprime");
  ok(vin(7, { contactoClienteId: null, waId: "447987654321" }) === "no_verificado", "+44 7987654321 con el cliente 987654321: no se imprime");
  ok(vin(7, { contactoClienteId: 8, waId: "51912345678" }) === "no_verificado", "vinculado a OTRO cliente y otro número: no se imprime");
  ok(vin(null, { contactoClienteId: 7, waId: "51987654321" }) === "sin_cliente" && vin(7, {}, null) === "sin_cliente", "sin cliente_id o sin ficha: sin_cliente");
  ok(vin("7", { contactoClienteId: 7 as any }) === "contacto" && vin(7, { contactoClienteId: "" as any, waId: null }) === "no_verificado", "el id como texto cuenta; vacío no");
  // La entrada del PDF aplica la regla por sí misma (la pantalla y el servidor no pueden saltársela).
  const e1 = C.entradaCorporativaTraslado({ ...IDA, cliente_id: 7 }, { empresa: perfil, cliente: CL, celular: "447987654321" });
  ok(e1.cliente!.empresa === undefined && e1.cliente!.ruc === undefined && e1.cliente!.nombre === "Ana Pérez Núñez" && e1.cliente!.telefono === "+447987654321", "entradaCorporativaTraslado: sin verificar → atención y celular");
  const e2 = C.entradaCorporativaTraslado({ ...IDA, cliente_id: 7 }, { empresa: perfil, cliente: CL, celular: "51987654321" });
  ok(e2.cliente!.empresa === "Minera Sur SAC" && e2.cliente!.ruc === "20111222333", "entradaCorporativaTraslado: mismo número → sus datos");
  const e3 = C.entradaCorporativaTraslado({ ...IDA, cliente_id: 7 }, { empresa: perfil, cliente: CL, celular: "447987654321", contactoClienteId: 7 });
  ok(e3.cliente!.empresa === "Minera Sur SAC", "entradaCorporativaTraslado: vinculado al contacto → sus datos");
  // clienteIdDeRemitente: el cliente que la IA le pone a la cotización.
  const sbClientes = (filas: { id: number; telefono: string | null }[], error = false) => ({
    from: () => {
      const q: any = { select: () => q, not: () => q, order: () => q, range: (a: number, b: number) => Promise.resolve(error ? { data: null, error: { message: "caída" } } : { data: filas.slice(a, b + 1), error: null }) };
      return q;
    },
  });
  const cl = (filas: { id: number; telefono: string | null }[], wa: string | null, contacto: any = null, error = false) => clienteIdDeRemitente(sbClientes(filas, error) as any, contacto, wa);
  ok(await cl([{ id: 1, telefono: "987654321" }], "447987654321") === null, "IA: +44 7987654321 no se queda con el cliente 987654321");
  ok(await cl([{ id: 1, telefono: "987654321" }], "51987654321") === 1, "IA: 51987654321 → el cliente 987654321");
  ok(await cl([{ id: 1, telefono: "+51 987 654 321" }, { id: 2, telefono: "987654321" }], "51987654321") === null, "IA: dos clientes con el mismo número → ninguno (ambiguo)");
  ok(await cl([{ id: 1, telefono: "+44 7987654321" }, { id: 2, telefono: "987654321" }], "447987654321") === 1, "IA: el extranjero empareja con su número completo");
  ok(await cl([{ id: 1, telefono: "912345678 / 987654321" }], "51987654321") === 1, "IA: una ficha con dos números empareja con cualquiera");
  ok(await cl([{ id: 1, telefono: "987654321" }], "51987654321", { cliente_id: 9 }) === 9, "IA: el vinculado al contacto manda");
  ok(await cl([{ id: 1, telefono: "987654321" }], "51987654321", null, true) === null, "IA: si no se pueden leer los clientes, ninguno");
  ok(await cl([{ id: 1, telefono: "987654321" }], "PE.abc") === null && await cl([{ id: 1, telefono: "987654321" }], null) === null, "IA: sin wa_id numérico, ninguno");
  const muchos = Array.from({ length: 2500 }, (_, i) => ({ id: i + 1, telefono: i === 2300 ? "987654321" : `9${String(10_000_000 + i).padStart(8, "0")}` }));
  ok(await cl(muchos, "51987654321") === 2301, "IA: pagina más allá de 1000 filas");
  // La pantalla de /cotizaciones arma la entrada con el vínculo del contacto (la misma regla).
  const pant = readFileSync("components/cotizaciones/pdf-traslado.ts", "utf8");
  ok(/crm_contactos\(wa_id, cliente_id\)/.test(pant) && /contactoClienteId: conv\.contactoClienteId/.test(pant), "la pantalla pasa el cliente vinculado del contacto a entradaCorporativaTraslado");
  ok(!/tel9\(/.test(readFileSync("lib/traslados/cotizar-ia-datos.ts", "utf8")), "cotizar-ia-datos ya no compara los últimos 9 dígitos");
}

// ── 5c. limpiarJpeg: sin EXIF ni comentarios, la imagen intacta ──────────────
seccion("5c. limpiarJpeg: quita APPn (salvo JFIF y Adobe) y COM");
{
  const seg = (marcador: number, datos: Uint8Array | string) => {
    const d = typeof datos === "string" ? Buffer.from(datos, "latin1") : Buffer.from(datos);
    const b = Buffer.alloc(4 + d.length); b[0] = 0xff; b[1] = marcador; b.writeUInt16BE(d.length + 2, 2); d.copy(b, 4); return b;
  };
  const base = Buffer.from(FOTO_EXT);
  // Se le meten APP0 JFIF, una miniatura JFXX, EXIF (con «GPS»), XMP, ICC, un COM y un APP14 Adobe.
  const JFIF = seg(0xe0, "JFIF\0\x01\x01\0\0\x01\0\x01\0\0"), ADOBE = seg(0xee, "Adobe\0\x64\0\0\0\0\x01");
  const conMeta = Buffer.concat([base.subarray(0, 2), JFIF, seg(0xe0, "JFXX\0\x10miniatura"), seg(0xe1, "Exif\0\0GPS-12.0464,-77.0428"), seg(0xe1, "http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>"), seg(0xe2, "ICC_PROFILE\0xx"), seg(0xfe, "Tomada por Juan"), ADOBE, base.subarray(2)]);
  const r = F.limpiarJpeg(new Uint8Array(conMeta));
  ok(r.ok && r.quitados === 5, `quita la miniatura, EXIF, XMP, ICC y el comentario (${r.ok ? r.quitados : r.codigo})`);
  if (r.ok) {
    const txt = Buffer.from(r.bytes).toString("latin1");
    ok(!txt.includes("GPS") && !txt.includes("xmpmeta") && !txt.includes("ICC_PROFILE") && !txt.includes("Juan") && !txt.includes("miniatura"), "no queda nada de los metadatos");
    ok(txt.includes("JFIF") && txt.includes("Adobe"), "conserva APP0 JFIF y APP14 Adobe");
    ok(Buffer.from(r.bytes).equals(Buffer.concat([base.subarray(0, 2), JFIF, ADOBE, base.subarray(2)])), "el resto es byte a byte el original (la imagen no se recomprime)");
    const rv = F.revisarJpeg(r.bytes);
    ok(rv.ok && rv.ancho === 1280 && rv.alto === 853, "sigue siendo un JPEG válido con sus medidas");
    const d = await PDFDocument.create();
    const im = await d.embedJpg(r.bytes);
    ok(im.width === 1280 && im.height === 853, "pdf-lib lo incrusta");
  }
  const sinMeta = F.limpiarJpeg(new Uint8Array(base));
  ok(sinMeta.ok && sinMeta.quitados === 0 && Buffer.from(sinMeta.bytes).equals(base), "un JPEG sin metadatos queda idéntico");
  // Con relleno FF FF entre segmentos (válido en JPEG) también sale, sin el relleno.
  const conRelleno = Buffer.concat([base.subarray(0, 2), Buffer.from([0xff, 0xff]), seg(0xfe, "x"), base.subarray(2)]);
  const rr = F.limpiarJpeg(new Uint8Array(conRelleno));
  ok(rr.ok && rr.quitados === 1 && Buffer.from(rr.bytes).equals(base), "el relleno y el comentario se van");
  // Estructuras que no se aceptan.
  ok(!F.limpiarJpeg(new Uint8Array(Buffer.concat([base.subarray(0, 2), Buffer.from([0x00, 0x11]), base.subarray(2)]))).ok, "basura entre segmentos → rechazo");
  ok(!F.limpiarJpeg(new Uint8Array(Buffer.concat([base.subarray(0, 2), seg(0xe1, "Exif")].map((x) => x)).subarray(0, 8))).ok, "cortado antes de los datos → rechazo");
  ok(!F.limpiarJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0])).ok, "no es JPEG → rechazo");
  // El progresivo también.
  const prog = await jpeg(320, 200, "#336699", { progressive: true });
  const rp = F.limpiarJpeg(new Uint8Array(Buffer.concat([Buffer.from(prog).subarray(0, 2), seg(0xe1, "Exif\0\0GPS"), Buffer.from(prog).subarray(2)])));
  ok(rp.ok && rp.quitados === 1 && Buffer.from(rp.bytes).equals(Buffer.from(prog)) && F.revisarJpeg(rp.bytes).ok, "progresivo: igual");
  const ruta = readFileSync("app/api/traslados/categorias/foto/route.ts", "utf8");
  ok(/limpiarJpeg\(bytes\)/.test(ruta) && /upload\(ruta, limpia\.bytes/.test(ruta), "el endpoint sube la foto ya limpia");
  ok(/borrarObjeto\(sb, previa\.anterior, \{ clave, lado \}\)/.test(ruta) && !/borrarObjeto\(sb, [^,]+\)/.test(ruta), "el endpoint solo borra la foto de ESA categoría y ESE lado");
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
  const cat7 = catDeFila(fila, true);
  const bytes = await dibujarPdfCorporativo(docCorporativo(ent), { logo: { bytes: logo, tipo: "png" }, fotos: { [cat7.foto_externa_url!]: foto, [cat7.foto_interna_url!]: foto } });
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
  const catM = catDeFila(IDA_RET, true);
  writeFileSync(`${dir}/muestra-traslado.pdf`, await dibujarPdfCorporativo(docCorporativo(ent), { logo: { bytes: LOGO_PNG, tipo: "png" }, fotos: { [catM.foto_externa_url!]: fotoExt, [catM.foto_interna_url!]: fotoInt } }));
  const local = { ...ent, empresa: { ...ent.empresa, logo_url: `file://${process.cwd()}/public/logoafacotizacion-removebg-preview.png` }, vehiculos: ent.vehiculos.map((v) => ({ ...v, foto_externa_url: `file://${dir}/foto-ext.jpg`, foto_interna_url: `file://${dir}/foto-int.jpg` })) };
  writeFileSync(`${dir}/muestra-traslado.html`, htmlCotizacion(local as any).html!.replace("<script>window.onload=()=>window.print();</script>", ""));
  console.log(`  muestra: ${dir}/muestra-traslado.pdf y .html`);
}

console.log(fallos ? `\n${fallos} FALLAN (${oks} ok)` : `\nTODO OK (${oks} comprobaciones)`);
process.exit(fallos ? 1 : 0);
