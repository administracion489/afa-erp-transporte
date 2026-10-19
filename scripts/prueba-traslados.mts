// Matriz de lib/traslados/motor.ts — npx tsx scripts/prueba-traslados.mts
//
// Las zonas, categorías y precios se LEEN de los SQL de semilla (supabase/traslados-02 y -03):
// si alguien cambia una capacidad o un precio en el SQL, esta matriz lo ve. Trae los ejemplos del
// dueño literales (10 pax con maletas → Sprinter 20; 31-44 → bus; minibús con maletera de 15;
// bus con bodega de 45) y la trampa de «San Juan de Miraflores», que contiene «Miraflores».
import { readFileSync } from "node:fs";
import * as M from "../lib/traslados/motor";
import * as G from "../lib/traslados/geocodigo";
import { validarEntrada } from "../lib/traslados/api";

let fallos = 0, oks = 0;
const ok = (c: boolean, m: string) => { if (c) oks++; else { fallos++; console.log("  FALLA " + m); } };
const seccion = (t: string) => console.log(`\n── ${t}`);

// ── Semillas desde el SQL ─────────────────────────────────────────────────────
const sql02 = readFileSync("supabase/traslados-02-zonas-lima.sql", "utf8");
const sql03 = readFileSync("supabase/traslados-03-precios-afa.sql", "utf8");
const arr = (lit: string) => lit.replace(/^\{|\}$/g, "").split(",").map((s) => s.replace(/^"|"$/g, "").trim()).filter(Boolean);

let nid = 1;
const zonas: M.Zona[] = [];
for (const m of sql02.matchAll(/\('([^']+)', 'distrito', '([^']+)', '(\{[^']*\})', (\d+)\)/g)) {
  zonas.push({ id: nid++, nombre: m[1], tipo: "distrito", padre_id: null, sector: m[2], alias: arr(m[3]), orden: Number(m[4]), activo: true });
}
const aer = sql02.match(/\('Aeropuerto Jorge Chávez', 'punto', '[^']+',\s*'(\{[^']*\})', (-?[\d.]+), (-?[\d.]+), (\d+)/);
ok(!!aer, "la semilla del aeropuerto se lee");
zonas.push({ id: nid++, nombre: "Aeropuerto Jorge Chávez", tipo: "punto", padre_id: null, alias: arr(aer![1]), lat: Number(aer![2]), lng: Number(aer![3]), radio_m: Number(aer![4]), activo: true });
ok(zonas.filter((z) => z.tipo === "distrito").length === 50, `50 distritos sembrados (hay ${zonas.filter((z) => z.tipo === "distrito").length})`);
ok(new Set(zonas.map((z) => M.claveNombre(z.nombre))).size === zonas.length, "ningún nombre de zona repetido");
const todosNombres = zonas.flatMap((z) => [...new Set(M.nombresDeZona(z))]);
ok(new Set(todosNombres).size === todosNombres.length, "ningún alias choca con el nombre o alias de otra zona");
ok(!todosNombres.some((n) => M.NOMBRES_GENERICOS.has(n)), "«Lima» a secas no es nombre ni alias de ninguna zona");

const categorias: M.CategoriaTraslado[] = [];
for (const m of sql03.matchAll(/\('(\w+)',\s+'([^']+)',\s+(\d+),\s+(\d+), '(\w+)',\s+(\d+)\)/g)) {
  categorias.push({ clave: m[1], nombre: m[2], capacidad: Number(m[3]), maletas_bodega: Number(m[4]), tipo_vehiculo: m[5], orden: Number(m[6]), activo: true });
}
ok(categorias.length === 7, `7 categorías (hay ${categorias.length})`);
const cat = (k: string) => categorias.find((c) => c.clave === k)!;
ok(cat("MINIBUS").maletas_bodega === 15 && cat("BUS").maletas_bodega === 45, "minibús 15 maletas, bus 45 (lo que dijo el dueño)");
ok(cat("VAN_15").capacidad === 15, "la Sprinter corta es una van de 15");

const precios = [...sql03.slice(sql03.indexOf("p(categoria, pen, usd)")).matchAll(/\('(\w+)', (\d+), (\d+)\)/g)]
  .map((m) => ({ categoria: m[1], pen: Number(m[2]), usd: Number(m[3]) }));
ok(precios.length === 7, "7 precios leídos");
const z = (n: string) => zonas.find((x) => x.nombre === n)!;
const AER = z("Aeropuerto Jorge Chávez");
let tarifas: M.TarifaTraslado[] = [];
for (const d of ["Miraflores", "San Isidro", "Barranco"]) {
  for (const p of precios) for (const moneda of ["PEN", "USD"] as const) {
    const [a, b] = M.parOrdenado(AER.id, z(d).id);
    tarifas.push({ zona_a_id: a, zona_b_id: b, categoria: p.categoria, moneda, precio_tramo: moneda === "PEN" ? p.pen : p.usd, activo: true });
  }
}
const pPEN = (k: string) => precios.find((p) => p.categoria === k)!.pen;
const pUSD = (k: string) => precios.find((p) => p.categoria === k)!.usd;

const pt = (localidades: string[], extra: Partial<M.PuntoUbicado> = {}): M.PuntoUbicado =>
  ({ texto: localidades[0] ?? "", lat: null, lng: null, localidades, barrios: [], ...extra });

// ── 1. Zonas ─────────────────────────────────────────────────────────────────
seccion("1. La zona de un punto");
{
  const sjm = M.zonaDePunto(pt(["San Juan de Miraflores", "Provincia de Lima"]), zonas);
  ok(sjm.zona?.nombre === "San Juan de Miraflores", `SJM es SJM, no Miraflores (salió ${sjm.zona?.nombre})`);
  ok(M.zonaDePunto(pt(["Miraflores", "Lima"]), zonas).zona?.nombre === "Miraflores", "Miraflores");
  ok(M.zonaDePunto(pt(["Surco"]), zonas).zona?.nombre === "Santiago de Surco", "Surco por alias");
  ok(M.zonaDePunto(pt(["Lurigancho-Chosica"]), zonas).zona?.nombre === "Lurigancho", "Lurigancho-Chosica por alias (con guion)");
  ok(M.zonaDePunto(pt(["CARMEN DE LA LEGUA REYNOSO"]), zonas).zona?.nombre === "Carmen de la Legua Reynoso", "mayúsculas y sin tilde");
  const lima = M.zonaDePunto(pt(["Lima", "Provincia de Lima"]), zonas);
  ok(lima.codigo === "distrito_ambiguo" && lima.zona === null, "«Lima» a secas es ambiguo, no Cercado");
  ok(M.zonaDePunto(pt(["Lima"], { barrios: ["San Isidro"] }), zonas).codigo === "distrito_por_barrio", "con «Lima», el barrio puede decir el distrito (declarado)");
  ok(M.zonaDePunto(pt(["Huaral"]), zonas).codigo === "distrito_desconocido", "un distrito fuera del catálogo es desconocido");
  ok(M.zonaDePunto(pt([]), zonas).codigo === "sin_ubicacion", "sin nombres ni coordenadas");
  ok(M.zonaDePunto(pt(["Santa Rosa"], { barrios: [] }), zonas).zona?.nombre === "Santa Rosa", "Santa Rosa como localidad");
  ok(M.zonaDePunto(pt(["Ate"], { barrios: ["Santa Rosa"] }), zonas).zona?.nombre === "Ate", "un barrio «Santa Rosa» dentro de Ate no gana a la localidad");

  // Aeropuerto: geocerca.
  const terminalNueva = M.zonaDePunto(pt(["Callao"], { lat: -12.0297011, lng: -77.1162278 }), zonas);
  ok(terminalNueva.codigo === "punto" && terminalNueva.zona?.id === AER.id, "la terminal nueva es el aeropuerto, no Callao");
  const terminalVieja = M.zonaDePunto(pt(["Callao"], { lat: -12.0219, lng: -77.1143 }), zonas);
  ok(terminalVieja.zona?.id === AER.id, `la terminal antigua cae en la geocerca (${terminalVieja.distancia_m} m)`);
  const lejos = M.zonaDePunto(pt(["Callao"], { lat: -12.0566, lng: -77.1181 }), zonas);
  ok(lejos.zona?.nombre === "Callao", "a 3 km del aeropuerto es Callao");
  ok(M.zonaDePunto(pt(["Callao"], { lat: -12.0297, lng: -77.1162 }), zonas.map((x) => x.id === AER.id ? { ...x, activo: false } : x)).zona?.nombre === "Callao", "geocerca apagada → distrito");

  // Subzonas de SJL.
  const sjl = z("San Juan de Lurigancho");
  const baja: M.Zona = { id: 900, nombre: "SJL · Zona baja", tipo: "subzona", padre_id: sjl.id, alias: ["Zárate"], lat: -12.025, lng: -77.005, activo: true };
  const alta: M.Zona = { id: 901, nombre: "SJL · Zona alta", tipo: "subzona", padre_id: sjl.id, alias: ["Canto Grande"], lat: -11.955, lng: -76.985, activo: true };
  const conSub = [...zonas, baja, alta];
  ok(M.zonaDePunto(pt(["San Juan de Lurigancho"], { lat: -11.96, lng: -76.99 }), conSub).zona?.id === 901, "subzona de centro más cercano");
  ok(M.zonaDePunto(pt(["San Juan de Lurigancho"], { lat: -12.02, lng: -77.0 }), conSub).zona?.id === 900, "la otra subzona");
  const porNombre = M.zonaDePunto(pt(["San Juan de Lurigancho"], { lat: -12.02, lng: -77.0, barrios: ["Canto Grande"] }), conSub);
  ok(porNombre.codigo === "subzona_alias" && porNombre.zona?.id === 901, "el nombre del barrio manda sobre la cercanía");
  const sinCoord = M.zonaDePunto(pt(["San Juan de Lurigancho"]), conSub);
  ok(sinCoord.codigo === "distrito" && sinCoord.zona?.id === sjl.id, "sin coordenadas queda el distrito");

  // Tarifa: la subzona sin precio propio usa la del distrito; con precio propio, la suya.
  const tar2: M.TarifaTraslado[] = [
    ...tarifas,
    { zona_a_id: Math.min(AER.id, sjl.id), zona_b_id: Math.max(AER.id, sjl.id), categoria: "AUTO", moneda: "PEN", precio_tramo: 150, activo: true },
    { zona_a_id: Math.min(AER.id, 901), zona_b_id: Math.max(AER.id, 901), categoria: "AUTO", moneda: "PEN", precio_tramo: 180, activo: true },
  ];
  const tBaja = M.tarifaDelPar(baja, AER, "AUTO", "PEN", tar2, conSub);
  ok(tBaja?.tarifa.precio_tramo === 150 && tBaja.nivel === "por_distrito", "subzona sin precio → el del distrito");
  const tAlta = M.tarifaDelPar(AER, alta, "AUTO", "PEN", tar2, conSub);
  ok(tAlta?.tarifa.precio_tramo === 180 && tAlta.nivel === "exacta", "subzona con precio propio → el suyo (y el par no tiene sentido)");
  ok(M.tarifaDelPar(z("Miraflores"), AER, "AUTO", "PEN", tarifas, zonas)?.tarifa.precio_tramo === pPEN("AUTO"), "Miraflores → aeropuerto = aeropuerto → Miraflores");
  ok(M.tarifaDelPar(z("San Juan de Miraflores"), AER, "AUTO", "PEN", tarifas, zonas) === null, "SJM no hereda el precio de Miraflores");
}

// ── 2. Vehículo ──────────────────────────────────────────────────────────────
seccion("2. El vehículo: el más chico donde caben pasajeros y maletas");
{
  const e = (pax: number, mal: number) => M.elegirVehiculo(pax, mal, categorias);
  const esperado: [number, number, string][] = [
    [1, 0, "AUTO"], [4, 0, "AUTO"], [2, 2, "AUTO"], [3, 3, "H1"], [5, 0, "H1"], [10, 0, "H1"],
    [10, 10, "SPRINTER_20"],   // el ejemplo del dueño: 10 pax con maletas → Sprinter 20
    [11, 0, "VAN_15"], [15, 0, "VAN_15"], [16, 0, "SPRINTER_20"], [20, 0, "SPRINTER_20"],
    [12, 12, "MINIBUS"],       // la maletera del minibús lleva 12 de sus 15
    [20, 20, "MINIBUS"],       // 15 en bodega, 5 en asientos: 25 de 30
    [21, 0, "MINIBUS"], [30, 0, "MINIBUS"], [30, 30, "BUS"], [31, 0, "BUS"], [44, 0, "BUS"],
    [45, 45, "BUS"], [50, 45, "BUS"],
  ];
  for (const [pax, mal, k] of esperado) {
    const r = e(pax, mal);
    ok(r.codigo === "ok" && r.categoria?.clave === k, `${pax} pax + ${mal} maletas → ${k} (salió ${r.categoria?.clave ?? r.codigo})`);
  }
  ok(e(3, 0).alternativas.map((c) => c.clave).join() === "SUV", "con auto, la SUV queda como alternativa");
  ok(e(50, 50).codigo === "excede_capacidad", "50 pax + 50 maletas no caben en un bus");
  ok(e(51, 0).codigo === "excede_capacidad", "51 pax no caben en un solo vehículo");

  // Barrido: lo elegido cabe, ninguna categoría de menor capacidad cabe, y más maletas nunca achican.
  let barridos = 0;
  for (let pax = 1; pax <= 60; pax++) {
    let capPrev = 0;
    for (let mal = 0; mal <= 70; mal++) {
      barridos++;
      const r = e(pax, mal);
      if (r.codigo === "ok") {
        ok(M.cabeEn(pax, mal, r.categoria!), `cabe ${pax}/${mal}`);
        ok(!categorias.some((c) => c.capacidad < r.categoria!.capacidad && M.cabeEn(pax, mal, c)), `mínimo ${pax}/${mal}`);
        ok(r.categoria!.capacidad >= capPrev, `monótono ${pax}/${mal}`);
        capPrev = r.categoria!.capacidad;
      } else {
        ok(r.codigo === "excede_capacidad" && !categorias.some((c) => M.cabeEn(pax, mal, c)), `excede de verdad ${pax}/${mal}`);
        capPrev = Infinity;
      }
    }
  }
  console.log(`  barrido: ${barridos} combinaciones`);

  // No se ofrece en silencio un vehículo más grande que el que cabe.
  const soloBus = (c: M.CategoriaTraslado) => c.clave === "BUS";
  const r = M.elegirVehiculo(3, 0, categorias, soloBus);
  ok(r.codigo === "sin_precio" && r.categoria?.clave === "AUTO", "si el auto no tiene precio, no se cotiza un bus");
  const r2 = M.elegirVehiculo(3, 0, categorias, (c) => c.clave === "SUV");
  ok(r2.codigo === "ok" && r2.categoria?.clave === "SUV", "si el auto no tiene precio y la SUV sí (misma capacidad), la SUV");
}

// ── 3. Moneda ────────────────────────────────────────────────────────────────
seccion("3. La moneda la decide el número");
{
  const casos: [string | null, M.Moneda | null][] = [
    ["+51 966 707 225", "PEN"], ["51966707225", "PEN"], ["966707225", "PEN"],
    ["+1 305 555 1234", "USD"], ["5491122334455", "USD"], ["34612345678", "USD"],
    ["PE.AbC123", "PEN"], ["US.xyz", "USD"], ["", null], [null, null], ["12345", null],
  ];
  for (const [t, m] of casos) ok(M.monedaPorTelefono(t).moneda === m, `${t} → ${m} (salió ${M.monedaPorTelefono(t).moneda})`);
}

// ── 4. Tipo de cambio, validez e importes ────────────────────────────────────
seccion("4. Tipo de cambio, validez e importes");
{
  const hoy = "2026-10-19";
  ok(M.tcParaCotizar({ fecha: hoy, venta: 3.431 }, hoy).tc === 3.431, "TC del día");
  ok(M.tcParaCotizar({ fecha: "2026-10-12", venta: 3.43 }, hoy).codigo === "ok", "TC de hace 7 días aún vale");
  ok(M.tcParaCotizar({ fecha: "2026-10-11", venta: 3.43 }, hoy).codigo === "tc_viejo", "TC de hace 8 días no");
  ok(M.tcParaCotizar({ fecha: hoy, venta: 375 }, hoy).codigo === "tc_invalido", "375 sin punto no es un TC");
  ok(M.tcParaCotizar(null, hoy).codigo === "sin_tc", "sin fila");
  ok(M.validezHasta(hoy, "2026-10-25", 30) === "2026-10-25", "vale hasta el servicio si es antes de 30 días");
  ok(M.validezHasta(hoy, "2027-01-10", 30) === "2026-11-18", "30 días si el servicio es después");
  ok(M.validezHasta(hoy, null, 30) === "2026-11-18", "sin fecha: 30 días");
  const i = M.importesTraslado(100, 2, 18);
  ok(i.subtotal === 200 && i.igv === 36 && i.total === 236, "100 × 2 tramos + IGV = 236");
  const j = M.importesTraslado(216, 1, 18);
  ok(j.igv === 38.88 && j.total === 254.88, "216 + IGV = 254.88");
}

// ── 5. La decisión completa ──────────────────────────────────────────────────
seccion("5. evaluarTraslado");
{
  const hoy = "2026-10-19";
  const ctx: M.ContextoTraslado = { zonas, categorias, tarifas, tipoCambio: { fecha: hoy, venta: 3.431 }, hoy, igvPct: 18, validezDias: 30 };
  const MIRA = pt(["Miraflores", "Provincia de Lima"], { texto: "Hotel Belmond, Miraflores", lat: -12.131, lng: -77.03 });
  const AEROP = pt(["Callao"], { texto: "Aeropuerto Jorge Chávez", lat: -12.0297011, lng: -77.1162278 });
  const pedido = (x: Partial<M.PedidoTraslado> = {}): M.PedidoTraslado => ({
    origen: MIRA, destino: AEROP, fecha_servicio: "2026-10-25", sentido: "ida", pax: 2, maletas: 2, telefono: "+51966707225", ...x,
  });
  const casos: { n: string; p: M.PedidoTraslado; c?: M.ContextoTraslado; codigo: M.CodigoTraslado; extra?: (r: M.ResultadoTraslado) => boolean }[] = [
    { n: "peruano, 10 pax con maletas, ida y retorno → Sprinter 20, S/ 350 × 2", p: pedido({ pax: 10, maletas: 10, sentido: "ida_retorno", fecha_retorno: "2026-10-28" }), codigo: "cotizable",
      extra: (r) => r.vehiculo?.categoria?.clave === "SPRINTER_20" && r.precio?.subtotal === 2 * pPEN("SPRINTER_20") && r.precio?.total === 826 && r.precio?.moneda === "PEN" && r.precio?.subtotal_pen === 700 },
    { n: "extranjero, aeropuerto → Barranco, 2 pax → auto US$ 30, guardado en soles al TC", p: pedido({ origen: AEROP, destino: pt(["Barranco"], { lat: -12.149, lng: -77.021 }), telefono: "+13055551234" }), codigo: "cotizable",
      extra: (r) => r.precio?.moneda === "USD" && r.precio?.precio_tramo === pUSD("AUTO") && r.precio?.subtotal_pen === 102.93 && r.precio?.tipo_cambio === 3.431 },
    { n: "extranjero sin TC → ejecutivo", p: pedido({ telefono: "+13055551234" }), c: { ...ctx, tipoCambio: null }, codigo: "sin_tipo_cambio" },
    { n: "trae TDR → ejecutivo aunque falten datos", p: pedido({ pax: null, senales: ["tdr"] }), codigo: "complejo" },
    { n: "una parada intermedia → ejecutivo", p: pedido({ paradas_intermedias: 1 }), codigo: "complejo" },
    { n: "varias fechas → ejecutivo", p: pedido({ fechas_adicionales: 3 }), codigo: "complejo" },
    { n: "pide 2 buses → ejecutivo", p: pedido({ vehiculos_pedidos: 2 }), codigo: "complejo" },
    { n: "pide descuento → ejecutivo", p: pedido({ senales: ["descuento"] }), codigo: "complejo" },
    { n: "no dijo si lleva maletas → se pregunta", p: pedido({ maletas: null }), codigo: "falta_dato", extra: (r) => r.faltan.some((f) => f.includes("maletas")) },
    { n: "ida y retorno sin fecha de retorno → se pregunta", p: pedido({ sentido: "ida_retorno" }), codigo: "falta_dato" },
    { n: "fecha pasada → se pregunta", p: pedido({ fecha_servicio: "2026-10-01" }), codigo: "fecha_pasada" },
    { n: "retorno antes de la ida → se pregunta", p: pedido({ sentido: "ida_retorno", fecha_retorno: "2026-10-20" }), codigo: "fecha_pasada" },
    { n: "SJM no se cotiza con el precio de Miraflores", p: pedido({ origen: pt(["San Juan de Miraflores"], { lat: -12.155, lng: -76.97 }) }), codigo: "sin_tarifa" },
    { n: "Google solo dijo «Lima» → ejecutivo", p: pedido({ origen: pt(["Lima"], { lat: -12.09, lng: -77.02 }) }), codigo: "sin_zona_origen" },
    { n: "dirección que Google no encontró → se pide otra", p: pedido({ origen: pt([], { texto: "mi casa" }) }), codigo: "falta_dato" },
    { n: "Miraflores → Miraflores no tiene precio", p: pedido({ destino: MIRA }), codigo: "sin_tarifa" },
    { n: "60 pasajeros → ejecutivo", p: pedido({ pax: 60, maletas: 0 }), codigo: "excede_capacidad" },
    { n: "sin teléfono → ejecutivo", p: pedido({ telefono: null }), codigo: "sin_moneda" },
    { n: "35 pax sin maletas → bus", p: pedido({ pax: 35, maletas: 0 }), codigo: "cotizable", extra: (r) => r.vehiculo?.categoria?.clave === "BUS" && r.precio?.subtotal === pPEN("BUS") },
  ];
  for (const k of casos) {
    const r = M.evaluarTraslado(k.p, k.c ?? ctx);
    ok(r.codigo === k.codigo && (!k.extra || k.extra(r)), `${k.n} (salió ${r.codigo}: ${r.motivo})`);
  }

  // Invariantes por barrido sobre pedidos combinados.
  let n = 0;
  const origenes = [MIRA, AEROP, pt(["San Isidro"], { lat: -12.097, lng: -77.034 }), pt(["San Juan de Miraflores"]), pt(["Lima"]), pt([])];
  for (const o of origenes) for (const d of origenes) for (const pax of [null, 1, 4, 10, 25, 40, 55]) for (const mal of [null, 0, 5, 30])
    for (const tel of ["+51966707225", "+13055551234", null]) for (const s of ["ida", "ida_retorno", null] as (M.Sentido | null)[]) for (const sen of [[], ["evento"]] as M.SenalComplejidad[][]) {
      n++;
      const r = M.evaluarTraslado({ origen: o, destino: d, fecha_servicio: "2026-11-02", fecha_retorno: "2026-11-03", sentido: s, pax, maletas: mal, telefono: tel, senales: sen }, ctx);
      ok(r.accion === M.ACCION_DE[r.codigo], "acción coherente con el código");
      ok((r.precio != null) === (r.codigo === "cotizable"), "hay precio ⟺ cotizable");
      ok(r.motivo.length > 0, "todo resultado dice su motivo");
      if (r.codigo === "cotizable") {
        ok(M.cabeEn(pax!, mal!, r.vehiculo!.categoria!), "lo cotizado cabe");
        ok(r.origen?.zona != null && r.destino?.zona != null, "cotizado ⟹ las dos zonas resueltas");
        ok(M.tarifaDelPar(r.origen!.zona!, r.destino!.zona!, r.vehiculo!.categoria!.clave, r.precio!.moneda, tarifas, zonas)?.tarifa.precio_tramo === r.precio!.precio_tramo, "el precio es el de la tabla");
        ok(r.precio!.tramos === (s === "ida_retorno" ? 2 : 1), "ida y retorno = 2 tramos");
        ok(sen.length === 0, "con una señal de complejidad nunca se cotiza");
        ok(!!r.validez_hasta && r.validez_hasta <= "2026-11-02", "la validez no pasa de la fecha del servicio");
      }
    }
  const cotizados = casos.length;
  console.log(`  barrido: ${n} pedidos (${cotizados} casos nombrados)`);
  // Corolario: el barrido SÍ produce cotizaciones (un motor que nunca cotizara cumpliría todo lo de arriba).
  const alguno = M.evaluarTraslado(pedido(), ctx);
  ok(alguno.codigo === "cotizable", "el pedido base se cotiza");
}

// ── 6. Lo que dice Google, y la entrada del simulador ────────────────────────
seccion("6. geocodigo y validarEntrada");
{
  const comp = (long: string, ...types: string[]) => ({ long_name: long, short_name: long, types: [...types, "political"] });
  // Forma real de una respuesta de Google para Lima: el distrito llega como `locality`.
  const larco: G.ResultadoGoogle[] = [{
    formatted_address: "Av. José Larco 1150, Miraflores 15074, Perú",
    geometry: { location: { lat: -12.128, lng: -77.03 } },
    address_components: [comp("1150", "street_number"), comp("Avenida José Larco", "route"), comp("Miraflores", "locality"),
      comp("Provincia de Lima", "administrative_area_level_2"), comp("Lima", "administrative_area_level_1"), comp("Perú", "country")],
  }];
  const p1 = G.puntoDeResultados("Larco 1150", larco)!;
  ok(p1.localidades[0] === "Miraflores" && G.localidadUtil(p1), "locality Miraflores primero");
  ok(M.zonaDePunto(p1, zonas).zona?.nombre === "Miraflores", "Larco 1150 → Miraflores");
  // «C. 3 Sur 260, Lima 15036» es San Isidro, y Google dijo «Lima»: hay que preguntar por las coordenadas.
  const corpac: G.ResultadoGoogle[] = [{
    formatted_address: "C. 3 Sur 260, Lima 15036, Perú", geometry: { location: { lat: -12.098, lng: -77.017 } },
    address_components: [comp("Calle 3 Sur", "route"), comp("Lima", "locality"), comp("Provincia de Lima", "administrative_area_level_2"), comp("Perú", "country")],
  }];
  const p2 = G.puntoDeResultados("C. 3 Sur 260", corpac)!;
  ok(!G.localidadUtil(p2), "«Lima» no es una localidad útil");
  ok(M.zonaDePunto(p2, zonas).codigo === "distrito_ambiguo", "sin la inversa, ambiguo");
  const inversa = G.nombresDeResultados([
    { address_components: [comp("Corpac", "neighborhood"), comp("San Isidro", "locality"), comp("Provincia de Lima", "administrative_area_level_2")] },
    { address_components: [comp("San Isidro", "locality"), comp("Provincia de Lima", "administrative_area_level_2")] },
  ]);
  const p3 = G.unirNombres(p2, inversa);
  ok(M.zonaDePunto(p3, zonas).zona?.nombre === "San Isidro", "con la inversa, San Isidro");
  ok(p3.localidades.filter((n) => M.claveNombre(n) === "san isidro").length === 1, "unir no repite nombres");
  // Un barrio con nombre de distrito no gana a la localidad.
  const ate = G.nombresDeResultados([{ address_components: [comp("Santa Rosa", "sublocality_level_1"), comp("Ate", "locality")] }]);
  ok(M.zonaDePunto({ lat: null, lng: null, ...ate }, zonas).zona?.nombre === "Ate", "barrio Santa Rosa en Ate → Ate");
  ok(G.puntoDeResultados("x", []) === null, "sin resultados no hay punto");

  const v = validarEntrada({ origen: " Hotel Belmond ", destino: { lat: -12.03, lng: -77.11 }, fecha_servicio: "2026-10-25", sentido: "ida", pax: "10", maletas: "", telefono: "+51 966", senales: ["tdr", "inventada"] });
  ok(v.ok && v.entrada.origen === "Hotel Belmond" && v.entrada.pax === 10 && v.entrada.maletas === null && v.entrada.senales?.join() === "tdr", "la entrada se limpia y las señales desconocidas se descartan");
  ok(!validarEntrada({ origen: { lat: 200, lng: 0 } }).ok, "coordenadas imposibles se rechazan");
  ok(validarEntrada({}).ok, "un pedido vacío es válido: el motor pregunta lo que falta");
  ok(!validarEntrada(null).ok, "sin cuerpo no hay pedido");
  // Lo que encontró la auditoría de seguridad:
  const proto = validarEntrada({ senales: ["constructor", "toString", "__proto__", "tdr"] });
  ok(proto.ok && proto.entrada.senales?.join() === "tdr", "«constructor» y «__proto__» no son señales");
  ok(M.evaluarTraslado({ origen: null, destino: null, fecha_servicio: null, sentido: null, pax: null, maletas: null, telefono: null, senales: ["constructor" as M.SenalComplejidad] }, { zonas, categorias, tarifas, tipoCambio: null, hoy: "2026-10-19", igvPct: 18, validezDias: 30 }).codigo === "falta_dato", "el motor tampoco revienta con «constructor»");
  ok(!validarEntrada({ origen: { lat: null, lng: null } }).ok, "lat/lng null no es el (0, 0)");
  ok(!validarEntrada({ origen: { lat: "", lng: "" } }).ok, "lat/lng vacíos no son el (0, 0)");
  ok(!validarEntrada({ origen: { lat: 0, lng: 0 } }).ok, "el (0, 0) está fuera de Perú");
  ok(!validarEntrada({ origen: { lat: 40.7, lng: -74 } }).ok, "Nueva York está fuera de Perú");
  ok(validarEntrada({ origen: { lat: "-12.03", lng: "-77.11" } }).ok, "coordenadas en texto numérico valen");
  const imposible = validarEntrada({ fecha_servicio: "2026-02-30", hora_servicio: "99:99", fecha_retorno: "2026-11-31" });
  ok(imposible.ok && imposible.entrada.fecha_servicio === null && imposible.entrada.hora_servicio === null && imposible.entrada.fecha_retorno === null, "fechas y horas que no existen se descartan");
  const ctxF = { zonas, categorias, tarifas, tipoCambio: null, hoy: "2026-10-19", igvPct: 18, validezDias: 30 };
  ok(M.evaluarTraslado({ origen: pt(["Miraflores"]), destino: pt(["Barranco"]), fecha_servicio: "2026-11-31", sentido: "ida", pax: 2, maletas: 0, telefono: "+51966707225" }, ctxF).codigo === "falta_dato", "el motor no acepta el 31 de noviembre");
  ok(M.validezHasta("2026-10-31", null, 30) === "2026-11-30", "la validez siempre es una fecha que existe");
}

console.log(`\n${oks} ok · ${fallos} fallos`);
if (fallos) process.exit(1);
