// Matriz de lib/costos/precio-ultima-carga.ts: qué carga de la placa pone el precio con que se costea
// su combustible principal. No toca la base.
// Uso:  npx tsx scripts/prueba-precio-ultima-carga.mts   (sale con código 1 si algo falla)
//
// Qué fija:
//   1 · el algoritmo VIEJO, copiado literal, reproduce el defecto (urea, litros, la gasolina de una
//       van a GLP): si deja de reproducirlo, el escenario dejó de ser el que se rompió;
//   2 · cada regla, con su código (sin precio, sin tipo, otra familia, unidad, banda), y que una carga
//       descartada no apaga la regla: se sigue buscando la anterior;
//   3 · el barrido: invariantes sobre miles de historiales y —el lado que no se puede aflojar— cuando la
//       última carga YA era del combustible del parámetro, en su unidad y con un precio posible, el
//       resultado es byte a byte el de antes;
//   4 · el ciclo con el presupuesto: el renglón de combustible costea con el precio convertido y dice
//       de dónde salió, o por qué se usó el de referencia.

import {
  ultimaCargaDeFamilia, juzgarCarga, textoPrecioUltimaCarga, motivoSinUltimaCarga, CARGAS_LEIDAS_ULTIMA,
  type CargaConPrecio, type CodigoDescarte,
} from "../lib/costos/precio-ultima-carga";
import { familiaDeParametro } from "../lib/costos/rendimiento-tipo";
import { COMBUSTIBLES, LITROS_POR_GALON, configCombustible } from "../lib/combustible-tipos";
import { calcularCostoUnidad, type ParametrosUnidad, type PreciosCombustible } from "../lib/costeo-propio";
import { preciosParaCosteo, calcularPresupuesto, type ContextoCosteo } from "../lib/costeo-servicio";

let fallos = 0;
function ok(cond: boolean, nombre: string, detalle = "") {
  if (cond) console.log(`  ✓ ${nombre}`);
  else { fallos++; console.log(`  ✗ ${nombre}${detalle ? ` — ${detalle}` : ""}`); }
}
const cerca = (a: number | null | undefined, b: number, eps = 1e-9) => a != null && Math.abs(a - b) < eps;

// ── REFERENCIA: `precioUltimaCarga` como estaba en lib/costeo-servicio.ts, copiado literal ──────────
//   const { data } = await sb.from("combustible").select("fecha,precio_galon")
//     .eq("vehiculo_id", vehiculoId).gt("precio_galon", 0)
//     .order("fecha", { ascending: false }).limit(1);
//   const f = ((data as any[]) ?? [])[0];
//   return f ? { precio: Number(f.precio_galon), fecha: String(f.fecha) } : null;
// La consulta se reproduce en memoria: filtro > 0 y orden por fecha descendente. El empate dentro del
// día lo dejaba a Postgres; aquí se desempata por id descendente, igual que la regla nueva, para que la
// comparación del barrido no dependa de un orden que la base no garantizaba.
function viejo(filas: CargaConPrecio[]): { precio: number; fecha: string } | null {
  const data = filas
    .filter((r) => Number(r.precio_galon) > 0)
    .sort((a, b) => String(a.fecha) === String(b.fecha) ? Number(b.id) - Number(a.id) : String(a.fecha) < String(b.fecha) ? 1 : -1)
    .slice(0, 1);
  const f = data[0];
  return f ? { precio: Number(f.precio_galon), fecha: String(f.fecha) } : null;
}

const c = (id: number, fecha: string, tipo: string | null, precio: number | string | null, unidad: string | null = null): CargaConPrecio =>
  ({ id, fecha, tipo_combustible: tipo, precio_galon: precio, unidad });

// ── 1 · El defecto, con el algoritmo viejo ────────────────────────────────────
console.log("\n── 1 · El algoritmo viejo reproduce el defecto ──");
{
  // Bus diésel que cargó urea después del diésel.
  const bus = [c(1, "2026-10-03", "diesel", 25.74, "galones"), c(2, "2026-10-05", "urea", 5.5, "litros")];
  ok(viejo(bus)?.precio === 5.5, "VIEJO: la urea (S/ 5.50 el litro) ponía el precio del diésel");
  const n1 = ultimaCargaDeFamilia(bus, "diesel");
  ok(n1.codigo === "ultima_carga" && n1.carga?.precio === 25.74 && n1.carga?.fecha === "2026-10-03",
    "NUEVO: manda la última carga de diésel", JSON.stringify(n1));
  ok(n1.descartadas.otra_familia === 1, "y la urea más nueva se cuenta como «otra familia»");

  // Diésel despachado en litros.
  const litros = [c(3, "2026-10-05", "diesel", 6.8, "litros")];
  ok(viejo(litros)?.precio === 6.8, "VIEJO: un diésel en litros costeaba el galón a S/ 6.80");
  const n2 = ultimaCargaDeFamilia(litros, "diesel");
  ok(cerca(n2.carga?.precio, 6.8 * LITROS_POR_GALON) && n2.carga?.convertida === true && n2.carga?.unidadFila === "litros",
    "NUEVO: se pasa a galones (×3.785)", JSON.stringify(n2.carga));

  // Van a GLP + gasolina (la CWQ400): la gasolina del aire ponía el precio del GLP.
  const van = [c(4, "2026-10-04", "glp", 7.55, "galones"), c(5, "2026-10-06", "gasolina_premium", 19.9, "galones")];
  ok(viejo(van)?.precio === 19.9, "VIEJO: la gasolina premium ponía el precio del GLP");
  const n3 = ultimaCargaDeFamilia(van, familiaDeParametro("GLP"));
  ok(n3.carga?.precio === 7.55 && n3.carga?.tipo === "glp", "NUEVO: manda la última de GLP");
}

// ── 2 · Cada regla, con su código ─────────────────────────────────────────────
console.log("\n── 2 · Las reglas, una por una ──");
{
  const j = (x: CargaConPrecio, f: string) => juzgarCarga(x, f);
  const cod = (r: ReturnType<typeof juzgarCarga>) => (r.ok ? "ok" : r.codigo);

  ok(cod(j(c(1, "2026-10-01", "diesel", 0), "diesel")) === "sin_precio", "precio 0 → sin_precio");
  ok(cod(j(c(1, "2026-10-01", "diesel", -3), "diesel")) === "sin_precio", "precio negativo → sin_precio");
  ok(cod(j(c(1, "2026-10-01", "diesel", "abc"), "diesel")) === "sin_precio", "precio ilegible → sin_precio");
  ok(cod(j(c(1, "2026-10-01", "diesel", null), "diesel")) === "sin_precio", "precio nulo → sin_precio");
  ok(cod(j(c(1, "2026-10-01", "diesel", "25.74"), "diesel")) === "ok", "un precio que llega como texto se lee");

  ok(cod(j(c(1, "2026-10-01", null, 25), "diesel")) === "sin_tipo", "sin tipo → sin_tipo (NUNCA se supone diésel)");
  ok(cod(j(c(1, "2026-10-01", "", 25), "diesel")) === "sin_tipo", "tipo vacío → sin_tipo");
  ok(cod(j(c(1, "2026-10-01", "kerosene", 25), "diesel")) === "sin_tipo", "tipo desconocido → sin_tipo");
  ok(cod(j(c(1, "2026-10-01", "Diésel", 25), "diesel")) === "ok", "la etiqueta «Diésel» se reconoce (normalizarTipoCombustible)");
  ok(cod(j(c(1, "2026-10-01", "Gasohol 90", 17), "gasolina")) === "ok", "«Gasohol 90» es gasolina");

  ok(cod(j(c(1, "2026-10-01", "urea", 5.5, "litros"), "diesel")) === "otra_familia", "urea con parámetro diésel → otra_familia");
  ok(cod(j(c(1, "2026-10-01", "biodiesel", 15), "diesel")) === "otra_familia", "biodiésel es su propia familia");
  ok(cod(j(c(1, "2026-10-01", "glp", 7.5), "diesel")) === "otra_familia", "GLP con parámetro diésel → otra_familia");
  ok(cod(j(c(1, "2026-10-01", "gasolina_premium", 19.9), "gasolina")) === "ok", "la premium cuenta para el parámetro «Gasolina»");
  ok(cod(j(c(1, "2026-10-01", "gasolina", 18), "gasolina")) === "ok", "la gasolina legada también");

  ok(cod(j(c(1, "2026-10-01", "diesel", 257.4), "diesel")) === "fuera_de_banda", "S/ 257.40 por galón (el importe en el campo del precio) → fuera_de_banda");
  ok(cod(j(c(1, "2026-10-01", "diesel", 25.74, "litros"), "diesel")) === "fuera_de_banda",
    "un precio de galón rotulado en litros (×3.785 = 97) → fuera_de_banda");
  ok(cod(j(c(1, "2026-10-01", "diesel", 4, "galones"), "diesel")) === "fuera_de_banda", "S/ 4 el galón de diésel → fuera_de_banda");

  // GNV: el Radar escribía «galones» en cargas de m³. `unidadDeCarga` fuerza el m³ y no se convierte nada.
  const gnv = juzgarCarga(c(1, "2026-10-01", "gnv", 1.78, "galones"), "gnv");
  ok(gnv.ok && gnv.carga.precio === 1.78 && gnv.carga.unidadFila === "m3" && gnv.carga.convertida === false,
    "GNV rotulado en «galones» se lee en m³, sin convertir", JSON.stringify(gnv));
  const gnvLt = juzgarCarga(c(1, "2026-10-01", "gnv", 1.78, "litros"), "gnv");
  ok(gnvLt.ok && gnvLt.carga.precio === 1.78, "GNV rotulado en «litros» también va en m³ (un gas no se vende por litro)");

  const glpLt = juzgarCarga(c(1, "2026-10-01", "glp", 2.02, "litros"), "glp");
  ok(glpLt.ok && cerca(glpLt.carga.precio, 2.02 * LITROS_POR_GALON), "GLP en litros se pasa a galones");
  const sinUnidad = juzgarCarga(c(1, "2026-10-01", "diesel", 25.74, null), "diesel");
  ok(sinUnidad.ok && sinUnidad.carga.precio === 25.74 && sinUnidad.carga.convertida === false, "sin unidad = la canónica (como en todo el ERP)");

  // El resultado.
  ok(ultimaCargaDeFamilia([c(1, "2026-10-01", "diesel", 25)], null).codigo === "familia_desconocida",
    "familia del parámetro desconocida → familia_desconocida (no se mira ninguna carga)");
  ok(ultimaCargaDeFamilia([c(1, "2026-10-01", "diesel", 25)], null).carga === null, "y no hay carga");
  ok(familiaDeParametro("Gasohol 90") === null && familiaDeParametro("UREA") === null,
    "«Gasohol 90» y «UREA» como parámetro no se reconocen (mapa explícito, nunca diésel)");
  ok(ultimaCargaDeFamilia([], "diesel").codigo === "sin_cargas", "sin cargas → sin_cargas");
  ok(ultimaCargaDeFamilia(null, "diesel").codigo === "sin_cargas", "null → sin_cargas");
  const todas = ultimaCargaDeFamilia([c(1, "2026-10-01", "urea", 5.5), c(2, "2026-10-02", null, 25), c(3, "2026-10-03", "diesel", 300)], "diesel");
  ok(todas.codigo === "ninguna_valida" && todas.carga === null, "todas inválidas → ninguna_valida");
  ok(todas.descartadas.otra_familia === 1 && todas.descartadas.sin_tipo === 1 && todas.descartadas.fuera_de_banda === 1,
    "y cada una cuenta en su motivo", JSON.stringify(todas.descartadas));

  // Una descartada no apaga la regla: se busca la anterior.
  const sigue = ultimaCargaDeFamilia([c(1, "2026-09-28", "diesel", 24.9), c(2, "2026-10-02", "diesel", 249)], "diesel");
  ok(sigue.carga?.precio === 24.9 && sigue.carga?.fecha === "2026-09-28" && sigue.descartadas.fuera_de_banda === 1,
    "un precio imposible no apaga la regla: manda la carga anterior, con su fecha");

  // El orden no lo decide la entrada.
  const desordenadas = [c(1, "2026-09-01", "diesel", 20), c(9, "2026-10-01", "diesel", 26), c(4, "2026-10-01", "diesel", 25), c(2, "2026-09-15", "diesel", 22)];
  ok(ultimaCargaDeFamilia(desordenadas, "diesel").carga?.precio === 26, "la más nueva por fecha, y en el mismo día la de id mayor");
  ok(ultimaCargaDeFamilia([...desordenadas].reverse(), "diesel").carga?.precio === 26, "el orden de entrada no cambia nada");
  ok(ultimaCargaDeFamilia([c(1, "2026-10-01T22:00:00", "diesel", 26)], "diesel").carga?.fecha === "2026-10-01", "la fecha sale en ISO de día");
}

// ── 3 · El barrido ────────────────────────────────────────────────────────────
console.log("\n── 3 · Barrido ──");
{
  let semilla = 20261012;
  const rnd = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
  const elige = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const TIPOS = [...Object.keys(COMBUSTIBLES), null, "", "kerosene", "Diésel", "GLP-G", "Gasohol 95"];
  const UNIDADES = [null, "", "galones", "litros", "m3"];
  const FAMILIAS = [null, "diesel", "gasolina", "glp", "gnv"];

  let casos = 0, invariante = 0, exhaustivo = 0, deFamilia = 0, enBanda = 0, nadaMasNuevo = 0;
  let comparables = 0, iguales = 0, cambiaron = 0;
  for (let k = 0; k < 6000; k++) {
    const n = Math.floor(rnd() * 7);
    const filas: CargaConPrecio[] = [];
    for (let i = 0; i < n; i++) {
      const tipo = elige(TIPOS);
      const cfg = configCombustible(tipo ?? undefined);
      // Precios alrededor de la banda de su tipo, con una cola de imposibles y de ceros.
      const r = rnd();
      const precio = r < 0.08 ? 0 : r < 0.18 ? cfg.rangoPrecio.max * (2 + rnd() * 8)
        : Math.round((cfg.rangoPrecio.min + rnd() * (cfg.rangoPrecio.max - cfg.rangoPrecio.min)) * 1000) / 1000;
      filas.push(c(i + 1, `2026-${String(1 + Math.floor(rnd() * 9)).padStart(2, "0")}-${String(1 + Math.floor(rnd() * 28)).padStart(2, "0")}`,
        tipo, precio, elige(UNIDADES)));
    }
    const familia = elige(FAMILIAS);
    const r = ultimaCargaDeFamilia(filas, familia);
    casos++;
    if ((r.carga != null) === (r.codigo === "ultima_carga")) invariante++;

    // Exhaustivo: elegida + descartadas = cargas miradas; con «ninguna_valida», todas.
    const desc = Object.values(r.descartadas).reduce((s, x) => s + x, 0);
    if (r.codigo === "ninguna_valida" ? desc === filas.length
      : r.codigo === "ultima_carga" ? desc + 1 <= filas.length
      : desc === 0) exhaustivo++;

    if (r.carga) {
      const t = r.carga.tipo!;
      if (COMBUSTIBLES[t].familia === familia) deFamilia++;
      const { min, max } = configCombustible(t).rangoPrecio;
      if (r.carga.precio >= min && r.carga.precio <= max) enBanda++;
      // Ninguna carga más nueva que la elegida sirve.
      const ordenadas = [...filas].sort((a, b) => String(a.fecha) === String(b.fecha) ? Number(b.id) - Number(a.id) : String(a.fecha) < String(b.fecha) ? 1 : -1);
      const idx = ordenadas.findIndex((x) => String(x.fecha) === r.carga!.fecha && juzgarCarga(x, familia!).ok);
      if (idx >= 0 && ordenadas.slice(0, idx).every((x) => !juzgarCarga(x, familia!).ok)) nadaMasNuevo++;
    } else { deFamilia++; enBanda++; nadaMasNuevo++; }

    // El lado que no se afloja: si la última carga (la del viejo) ya era de la familia, en su unidad
    // canónica y con un precio posible, el nuevo da el MISMO número y la MISMA fecha.
    const v = viejo(filas);
    if (v && familia) {
      const primera = filas
        .filter((x) => Number(x.precio_galon) > 0)
        .sort((a, b) => String(a.fecha) === String(b.fecha) ? Number(b.id) - Number(a.id) : String(a.fecha) < String(b.fecha) ? 1 : -1)[0];
      const jz = juzgarCarga(primera, familia);
      if (jz.ok && jz.carga.convertida === false) {
        comparables++;
        if (r.carga?.precio === v.precio && r.carga?.fecha === v.fecha) iguales++;
      } else if (r.carga && r.carga.precio !== v.precio) cambiaron++;
    }
  }
  ok(invariante === casos, "carga ≠ null ⟺ código «ultima_carga»", `${invariante}/${casos}`);
  ok(exhaustivo === casos, "elegida + descartadas cuadran con las cargas miradas", `${exhaustivo}/${casos}`);
  ok(deFamilia === casos, "la carga elegida es SIEMPRE de la familia del parámetro (nunca urea ni otra)", `${deFamilia}/${casos}`);
  ok(enBanda === casos, "su precio, ya convertido, está SIEMPRE dentro de la banda física de su tipo", `${enBanda}/${casos}`);
  ok(nadaMasNuevo === casos, "ninguna carga más nueva que la elegida servía", `${nadaMasNuevo}/${casos}`);
  ok(iguales === comparables && comparables > 300,
    "cuando la última carga ya era de su familia, en su unidad y posible: el MISMO precio y la misma fecha que antes", `${iguales}/${comparables}`);
  ok(cambiaron > 100, "corolario: el arreglo sí cambia algo (urea, otra familia, litros, imposibles)", `${cambiaron}`);
}

// ── 4 · El ciclo con el presupuesto ───────────────────────────────────────────
console.log("\n── 4 · El renglón «Combustible» del presupuesto ──");
{
  const BUS: ParametrosUnidad = {
    tipo_vehiculo: "bus50", nombre: "Bus 50 pax", capacidad: 50,
    usa_urea: false, consumo_urea_pct: null,
    tipo_combustible_1: "Diésel", rendimiento_1: 8, pct_uso_1: 1,
    tipo_combustible_2: null, rendimiento_2: null, pct_uso_2: null,
    n_neumaticos: 6, costo_neumatico: 1400, vida_neumatico_km: 70000,
    mantenimiento_km: 0.35, valor_compra: 320000, residual_pct: 0.2,
    vida_util_anios: 10, km_anio: 60000,
    seguro_anual: 4800, soat_anual: 900, revision_semestral: 180,
    permisos_anual: 1200, otros_fijos_mensual: 250, conductor_dia: 90,
  };
  const PRECIOS: PreciosCombustible = { "Diésel": 16.4, "GLP": 7.65, "UREA": 5.5 };
  const base = (over: Partial<ContextoCosteo>): ContextoCosteo => ({
    parametros: BUS, precios: PRECIOS, rendimientoMedido: null, precioUltimaCarga: null,
    deprecKm: null, conductor: null, diasConServicio: 0, serviciosDelDia: 1, diasLaborablesMes: 26,
    kmSugerido: null, placa: "ABC-123", ...over,
  });
  const entrada = { km: 100, kmFuente: "gps" as const, dias: 1, peajes: 0, viaticos: 0, estacionamiento: 0, pernocte: 0, otros: 0 };
  const renglon = (ctx: ContextoCosteo) => calcularPresupuesto(ctx, entrada).lineas.find((l) => l.concepto === "combustible")!;

  const r = ultimaCargaDeFamilia([c(1, "2026-10-03", "diesel", 6.8, "litros"), c(2, "2026-10-05", "urea", 5.5, "litros")],
    familiaDeParametro(BUS.tipo_combustible_1));
  const l1 = renglon(base({ precioUltimaCarga: r.carga, ultimaCargaCodigo: r.codigo }));
  const esperado = calcularCostoUnidad(BUS, preciosParaCosteo(PRECIOS, BUS, r.carga), { km: 100, dias: 1, peajes: 0, otros: 0, pernocte: 0, viaticos: 0 })!;
  ok(l1.monto === Math.round(esperado.costoCombustible * 100) / 100 && cerca(l1.monto, Math.round((100 / 8) * 6.8 * LITROS_POR_GALON * 100) / 100, 0.006),
    "el renglón costea con el precio del galón (S/ 6.80/lt × 3.785), no con la urea", `${l1.monto}`);
  ok(/S\/ 25\.74\/gal de la última carga de diésel \(se pagó S\/ 6\.80\/lt\)/.test(l1.base), "y dice de qué carga salió y que se convirtió", l1.base);

  const l2 = renglon(base({ precioUltimaCarga: null, ultimaCargaCodigo: "ninguna_valida" }));
  ok(l2.monto === Math.round((100 / 8) * 16.4 * 100) / 100, "sin carga válida, el precio de referencia", `${l2.monto}`);
  ok(/S\/ 16\.40 de referencia \(ninguna carga reciente de diésel tiene un precio que pueda ser suyo\)/.test(l2.base), "y dice por qué", l2.base);

  const l3 = renglon(base({ precioUltimaCarga: null }));
  ok(l3.base.includes("S/ 16.40 de referencia") && !l3.base.includes("de referencia ("),
    "un contexto sin código (armado a mano, o un error de lectura) se lee como siempre", l3.base);

  const l4 = renglon(base({ precioUltimaCarga: { precio: 22.5, fecha: "2026-10-01" } }));
  ok(/S\/ 22\.50 de la última carga/.test(l4.base), "una última carga sin tipo (contexto viejo) sigue diciendo su precio", l4.base);

  ok(motivoSinUltimaCarga("ultima_carga", "diesel") === null && motivoSinUltimaCarga(null, "diesel") === null,
    "con última carga, o sin código, no hay motivo que decir");
  ok(/no se reconoce/.test(motivoSinUltimaCarga("familia_desconocida", null)!), "familia desconocida tiene su frase");
  ok(/no tiene cargas/.test(motivoSinUltimaCarga("sin_cargas", "glp")!), "sin cargas tiene su frase");
  ok(/de GLP/.test(motivoSinUltimaCarga("ninguna_valida", "glp")!), "las siglas no se ponen en minúscula");

  const t = textoPrecioUltimaCarga({ precio: 1.78, fecha: "2026-10-01", tipo: "gnv", precioFila: 1.78, unidadFila: "m3", convertida: false }, { conFecha: true });
  ok(t === "S/ 1.78/m³ de la última carga de GNV (2026-10-01)", "el texto de un GNV va en m³ y sin nota de conversión", t);

  // Lo que se lee de la base.
  ok(CARGAS_LEIDAS_ULTIMA === 30, "se leen las 30 cargas más recientes (operativo, declarado)");
  const desc: CodigoDescarte[] = ["sin_precio", "sin_tipo", "otra_familia", "unidad_no_convertible", "fuera_de_banda"];
  ok(desc.every((k) => k in ultimaCargaDeFamilia([], "diesel").descartadas), "el conteo de descartes trae los cinco motivos, aunque estén en cero");
}

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
