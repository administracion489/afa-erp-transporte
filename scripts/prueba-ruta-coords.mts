// scripts/prueba-ruta-coords.mts — matriz de lib/cotizacion-ruta-coords.ts
// npx tsx scripts/prueba-ruta-coords.mts
import { coordValida, mismoTexto, rutaCoordsParaGuardar, leerRutaCoords, resolverRestauracion, rotuloFuente, type PuntoRuta } from "../lib/cotizacion-ruta-coords";

let ok = 0, mal = 0;
const t = (nombre: string, cond: boolean) => { if (cond) ok++; else { mal++; console.log("✗", nombre); } };

// 1 · coordValida
t("número válido", coordValida(-12.05, -77.04));
t("texto válido", coordValida("-12.05", "-77.04"));
t("(0,0) no vale", !coordValida(0, 0));
t("vacío no vale", !coordValida("", ""));
t("null no vale", !coordValida(null, -77));
t("fuera de rango", !coordValida(95, -77));
t("NaN", !coordValida("abc", "-77"));

// 2 · mismoTexto
t("tildes y mayúsculas", mismoTexto("Carmen de La Legua", "  carmen de la LEGUA "));
t("vacíos nunca coinciden", !mismoTexto("", ""));
t("distintos", !mismoTexto("Punta Hermosa", "Punta Negra"));

// 3 · guardar ↔ leer: el ciclo
const O: PuntoRuta = { placeId: "ChIJo", lat: -12.0464, lng: -77.0428, fuente: "lista" };
const D: PuntoRuta = { placeId: "", lat: -12.3343, lng: -76.8253, fuente: "texto" };
const R: PuntoRuta = { placeId: "ChIJr", lat: -12.05, lng: -77.10, fuente: "mapa" };
const textos = { origen: "Carmen de La Legua", destino: "Punta Hermosa", retorno: "Callao" };
const g = rutaCoordsParaGuardar(O, D, R, textos, true);
t("guarda los tres", !!g?.origen && !!g?.destino && !!g?.retorno);
t("aproximada se guarda igual", g?.destino?.lat === D.lat);
t("solo ida no guarda retorno", rutaCoordsParaGuardar(O, D, R, textos, false)?.retorno === null);
t("sin nada → null", rutaCoordsParaGuardar(null, null, null, textos, true) === null);
t("punto sin texto no se guarda", rutaCoordsParaGuardar(O, null, null, { origen: " ", destino: "", retorno: "" }, true) === null);
t("(0,0) no se guarda", rutaCoordsParaGuardar({ placeId: "", lat: 0, lng: 0 }, null, null, textos, true) === null);
const leido = leerRutaCoords(JSON.parse(JSON.stringify(g)));
t("ciclo jsonb", JSON.stringify(leido) === JSON.stringify(g));
t("basura → null", leerRutaCoords("x") === null && leerRutaCoords({ origen: { lat: "a" } }) === null && leerRutaCoords(null) === null);

const cot = { origen: "Carmen de La Legua", destino: "Punta Hermosa", punto_retorno: "Callao", ruta_coords_json: g };
const r1 = resolverRestauracion(cot, true);
t("restaura guardada (origen)", r1.origen?.lat === O.lat && r1.origen?.placeId === "ChIJo" && r1.origen?.fuente === "guardada");
t("restaura retorno", r1.retorno?.lat === R.lat);
t("nada por geocodificar", r1.porGeocodificar.length === 0);

// 4 · el texto cambió por otra vía → la coordenada guardada no vale
const r2 = resolverRestauracion({ ...cot, destino: "Lurín" }, true);
t("texto cambiado: destino no se restaura", r2.destino === null && r2.porGeocodificar.includes("destino"));
t("texto cambiado: origen sí", r2.origen !== null);

// 5 · sin guardar: paraderos, después texto
const par = [{ tipo: "inicio", lat: "-12.01", lng: "-77.01" }, { tipo: "intermedia", lat: "-12.1", lng: "-77" }, { tipo: "destino", lat: "", lng: "" }];
const r3 = resolverRestauracion({ origen: "A", destino: "B", punto_retorno: "", paradas_json: par }, true);
t("origen del paradero 1", r3.origen?.fuente === "paradero" && r3.origen.lat === -12.01);
t("destino sin coords en paradero → geocodificar", r3.destino === null && r3.porGeocodificar.includes("destino"));
t("retorno vacío no se geocodifica (vuelve al origen)", !r3.porGeocodificar.includes("retorno") && r3.retorno === null);
const r4 = resolverRestauracion({ origen: "A", destino: "B", punto_retorno: "C" }, true);
t("cotización vieja: los tres por texto", r4.porGeocodificar.join() === "origen,destino,retorno");
const r5 = resolverRestauracion({ origen: "A", destino: "B", punto_retorno: "C" }, false);
t("solo ida: retorno ni se restaura ni se busca", r5.retorno === null && !r5.porGeocodificar.includes("retorno"));
const r6 = resolverRestauracion({ origen: "", destino: null, punto_retorno: null, paradas_json: par }, true);
t("sin texto: no se toma el paradero ni se busca", r6.origen === null && r6.porGeocodificar.length === 0);
// el retorno NUNCA sale de un paradero ni del origen
const r7 = resolverRestauracion({ origen: "A", destino: "B", punto_retorno: "", paradas_json: par, ruta_coords_json: { origen: { texto: "A", lat: -12, lng: -77 } } }, true);
t("retorno no se deduce", r7.retorno === null);
t("guardada gana al paradero", r7.origen?.fuente === "guardada" && r7.origen.lat === -12);

// 6 · barrido: invariantes
let barrido = 0;
const textosB = ["", "A", "B"];
const gs = [null, g, { origen: { texto: "A", lat: -12, lng: -77 }, destino: { texto: "B", lat: -12.2, lng: -76.9 }, retorno: { texto: "B", lat: -12.3, lng: -77.2 } }];
const ps = [null, par, [{ tipo: "inicio", lat: "", lng: "" }, { tipo: "destino", lat: "-12.3", lng: "-76.8" }]];
for (const o of textosB) for (const d of textosB) for (const rt of textosB) for (const gg of gs) for (const pp of ps) for (const v of [true, false]) {
  const r = resolverRestauracion({ origen: o, destino: d, punto_retorno: rt, ruta_coords_json: gg, paradas_json: pp as any }, v);
  barrido++;
  for (const [e, txt, pt] of [["origen", o, r.origen], ["destino", d, r.destino], ["retorno", rt, r.retorno]] as const) {
    const busca = r.porGeocodificar.includes(e);
    // con texto y servicio que lo usa: exactamente una de dos (coordenadas o búsqueda)
    const aplica = e !== "retorno" || v;
    if (!txt.trim() || !aplica) t(`${e} sin texto/aplica: nada (${o}|${d}|${rt}|${v})`, pt === null && !busca);
    else t(`${e} disjunto y exhaustivo`, (pt !== null) !== busca);
    if (pt) t(`${e} coordenada válida`, coordValida(pt.lat, pt.lng));
  }
}
t("barrido no vacío", barrido > 100);

// 7 · rótulos
t("texto es aproximada", rotuloFuente("texto").aproximada);
t("lista no", !rotuloFuente("lista").aproximada && rotuloFuente("lista").texto !== "");

console.log(`\n${ok} ok · ${mal} mal · barrido ${barrido}`);
if (mal) process.exit(1);
