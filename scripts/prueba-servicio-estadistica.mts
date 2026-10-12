// Pruebas de la ESTADÍSTICA POR SERVICIO y su CO₂ (lib/flota/servicio-estadistica.ts). NO tocan la base:
// datos sintéticos y, para la traza, la base falsa de scripts/prueba-km-gps.mts.
// Uso:  npx tsx scripts/prueba-servicio-estadistica.mts   (sale con código 1 si algo falla)
//
// LO QUE FIJAN:
//   1. La cadena km → combustible → costo → CO₂, por BARRIDO de todo veredicto RASTREO × resumen ×
//      simulados × contexto: valor ≠ null ⟺ código `estimado`; nada se estima sin km publicable; el
//      `piso` del km se propaga a los tres; un tercero nunca tiene costo; todo lleva su `base`.
//   2. EL CICLO CON EL PRESUPUESTO: con el mismo contexto (conductor null) y el mismo km, el costo
//      estimado ES el renglón «Combustible» de `calcularPresupuesto`, al céntimo, sobre una rejilla de
//      parámetros, mediciones, últimas cargas y km.
//   3. Un TERCERO: costo `tercero`, y CO₂ presente si su tipo tiene parámetro (sin medición propia).
//   4. Un tipo BIMODAL: dos familias, nunca sumadas (GLP + gasolina en galones; GNV en m³ aparte).
//   5. Una familia DESCONOCIDA: `familia_desconocida`, nunca diésel.
//   6. CO₂ = cantidad × factor exacto, por familia.
//   7. `resumirPorCliente`: no mezcla galones con m³; soles, kg y cantidades cuadran con la suma de
//      las filas de servicio; cada servicio cae en un total o en un motivo, nunca en los dos.
//   8. EXCESOS = PIEZA 1: sobre la misma traza, los excesos del servicio son los episodios de
//      `detectarExcesos` (lib/flota/excesos.ts, el motor de /seguridad-vial) restringidos a su
//      `reserva_id`, por barrido de días mezclados (varios servicios, fuera de servicio, `p:5` y `t:5`);
//      tri-estado: sin velocímetro no es «0 excesos»; fantasma FUSED descartado; corolario detectado.
//   9. Huella + composición = `estadisticaDeServicio` (el lector suelta las filas en medio).
//  10. De punta a punta sobre una traza: el corolario (una propia diésel con km medido y tipo asignado
//      publica km, combustible, costo y CO₂), el conductor del teléfono, la traza sin filas y la que
//      rompe el cálculo.
//  11. `normalizarUmbral` y la respuesta de error.

/* eslint-disable @typescript-eslint/no-explicit-any -- la base falsa imita al cliente sin tipos de Supabase */
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "prueba";

const SE = await import("../lib/flota/servicio-estadistica");
const {
  contextoCombustible, combustibleEstimado, costoCombustibleEstimado, co2Estimado, unidadDeFamilia,
  huellaDeServicio, componerEstadistica, estadisticaDeServicio, resumirPorCliente, totalDelDia,
  normalizarUmbral, respuestaConError, textoCantidades, CODIGOS_COMBUSTIBLE, UMBRAL_SERVICIO, HUELLA_PUBLICA,
} = SE;
const { kmPublicable, KM_GPS_PUBLICA } = await import("../lib/flota/km-gps");
const { calcularPresupuesto } = await import("../lib/costeo-servicio");
const { calcularCostoUnidad, consumoPorKm } = await import("../lib/costeo-propio");
const { FACTOR_CO2 } = await import("../lib/combustible-tipos");
const { familiaDeParametro } = await import("../lib/costos/rendimiento-tipo");
const { leerTraza, medirServicio } = await import("../lib/gps-cobertura-datos");
const { contextoServicio } = await import("../lib/gps-cobertura");

type ParametrosUnidad = import("../lib/costeo-propio").ParametrosUnidad;
type PreciosCombustible = import("../lib/costeo-propio").PreciosCombustible;
type VeredictoRastreo = import("../lib/gps-cobertura").VeredictoRastreo;
type CodigoRastreo = import("../lib/gps-cobertura").CodigoRastreo;
type ResumenViaje = import("../lib/huella").ResumenViaje;
type KmGps = import("../lib/flota/km-gps").KmGps;
type MedicionPlaca = import("../lib/costos/rendimiento-aplica").MedicionPlaca;
type ContextoCombustibleUnidad = import("../lib/flota/servicio-estadistica").ContextoCombustibleUnidad;
type EstadisticaServicio = import("../lib/flota/servicio-estadistica").EstadisticaServicio;
type HuellaServicio = import("../lib/flota/servicio-estadistica").HuellaServicio;
type ServicioParaEstadistica = import("../lib/flota/servicio-estadistica").ServicioParaEstadistica;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
let semilla = 20261012;
const rnd = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
const HOY = "2026-10-09";
const T0 = Date.parse(`${HOY}T06:00:00-05:00`);

// ══ Datos sintéticos ═════════════════════════════════════════════════════════════════════
const BASE: ParametrosUnidad = {
  tipo_vehiculo: "BUS_50", nombre: "Bus 50", capacidad: 50, usa_urea: false, consumo_urea_pct: null,
  tipo_combustible_1: "Diésel", rendimiento_1: 8, pct_uso_1: 1, tipo_combustible_2: null, rendimiento_2: null, pct_uso_2: null,
  n_neumaticos: 6, costo_neumatico: 1200, vida_neumatico_km: 80000, mantenimiento_km: 0.5, valor_compra: 500000,
  residual_pct: 0.2, vida_util_anios: 10, km_anio: 60000, seguro_anual: 8000, soat_anual: 1500, revision_semestral: 300,
  permisos_anual: 1000, otros_fijos_mensual: 200, conductor_dia: 150,
};
const P: Record<string, ParametrosUnidad> = {
  diesel: BASE,
  dieselUrea: { ...BASE, tipo_vehiculo: "BUS_50_E5", usa_urea: true, consumo_urea_pct: 0.05, rendimiento_1: 7.4 },
  glpGas: { ...BASE, tipo_vehiculo: "VAN_GLP", tipo_combustible_1: "GLP", rendimiento_1: 9.5, pct_uso_1: 0.6, tipo_combustible_2: "Gasolina", rendimiento_2: 12, pct_uso_2: 0.4 },
  gnv: { ...BASE, tipo_vehiculo: "MINIBUS_GNV", tipo_combustible_1: "GNV", rendimiento_1: 4.2 },
  gnvGas: { ...BASE, tipo_vehiculo: "COASTER_GNV", tipo_combustible_1: "GNV", rendimiento_1: 4.0, pct_uso_1: 0.8, tipo_combustible_2: "Gasolina", rendimiento_2: 10, pct_uso_2: 0.2 },
  gasolina: { ...BASE, tipo_vehiculo: "SUV", tipo_combustible_1: "Gasolina", rendimiento_1: 11 },
  desconocido: { ...BASE, tipo_vehiculo: "RARO", tipo_combustible_1: "Gasohol 90", rendimiento_1: 10 },
  desconocido2: { ...BASE, tipo_vehiculo: "RARO2", tipo_combustible_2: "Kerosene", rendimiento_2: 9, pct_uso_1: 0.7, pct_uso_2: 0.3 },
  sinRend: { ...BASE, tipo_vehiculo: "SIN_REND", rendimiento_1: 0 },
  sinRend2: { ...BASE, tipo_vehiculo: "SIN_REND2", tipo_combustible_1: "GLP", rendimiento_1: 9, pct_uso_1: 0.6, tipo_combustible_2: "Gasolina", rendimiento_2: null, pct_uso_2: 0.4 },
};
const PRECIOS: PreciosCombustible = { "Diésel": 16.5, "UREA": 5.5, "GLP": 7.6, "GNV": 1.78, "Gasolina": 17.2 };
const MED: Record<string, MedicionPlaca | null> = {
  ninguna: null,
  dieselBuena: { kmGal: 9.2, tramos: 7, familia: "diesel", label: "km/gal", confiable: true },
  dieselPoca: { kmGal: 12, tramos: 2, familia: "diesel", label: "km/gal", confiable: false },
  glpBuena: { kmGal: 10.5, tramos: 9, familia: "glp", label: "km/gal", confiable: true },
  gnvBuena: { kmGal: 4.6, tramos: 6, familia: "gnv", label: "km/m³", confiable: true },
};
const ULT: Record<string, { precio: number; fecha: string } | null> = {
  ninguna: null, diesel: { precio: 17.85, fecha: "2026-10-01" }, urea: { precio: 5.5, fecha: "2026-10-02" },
};

const CODIGOS_RASTREO: CodigoRastreo[] = [
  "completo", "aceptable", "con_cortes", "incompleto", "sin_senal", "solo_antena", "gps_inmovil",
  "senal_perdida", "recien_iniciado", "sin_medir", "no_aplica",
];
const ver = (codigo: CodigoRastreo, enCurso = false): VeredictoRastreo => ({
  codigo, pct: codigo === "no_aplica" || codigo === "sin_medir" ? null : codigo === "completo" ? 98 : codigo === "aceptable" ? 92 : codigo === "con_cortes" ? 80 : codigo === "incompleto" ? 40 : 0,
  problema: null, celda: "", color: "", bg: "", detalle: "detalle del rastreo", ultimaSenalTs: null, enCurso,
});
const resumen = (km: number): ResumenViaje => ({
  kmRecorridos: km, tiempoTotalMin: 60, tiempoMovimientoMin: 42, tiempoDetenidoMin: 18, velMaxKmh: 74, paradas: 3,
  horaSalida: T0, horaLlegada: T0 + 3_600_000, medidoPct: 97, precisionMedianaM: 6, puntosTotales: 600,
});
const kmMedido = (km: number, piso = false): KmGps => ({ codigo: piso ? "piso" : "medido", km, piso, coberturaPct: piso ? 80 : 98, detalle: "km del GPS" });

/** Contextos del barrido: nombre → (flota, parámetro, medición, última, fallos). */
function contextos(): { nombre: string; ctx: ContextoCombustibleUnidad | null }[] {
  const out: { nombre: string; ctx: ContextoCombustibleUnidad | null }[] = [{ nombre: "sin unidad", ctx: null }];
  const mk = (nombre: string, flota: "propia" | "tercero", p: ParametrosUnidad | null, o: { tipo?: string | null; med?: MedicionPlaca | null; ult?: { precio: number; fecha: string } | null; fallo?: string; falloPrecios?: string; precios?: PreciosCombustible } = {}) =>
    out.push({ nombre, ctx: contextoCombustible({
      flota, tipoCosteo: o.tipo !== undefined ? o.tipo : p?.tipo_vehiculo ?? "TIPO_FANTASMA", parametros: p,
      medicion: o.med ?? null, precioUltimaCarga: o.ult ?? null, preciosReferencia: o.precios ?? PRECIOS,
      fallo: o.fallo ?? null, falloPrecios: o.falloPrecios ?? null,
    }) });
  for (const flota of ["propia", "tercero"] as const) {
    for (const [k, p] of Object.entries(P)) {
      mk(`${flota}/${k}`, flota, p);
      mk(`${flota}/${k}+medida`, flota, p, { med: MED.dieselBuena, ult: ULT.diesel });
    }
    mk(`${flota}/sin tipo`, flota, null, { tipo: null });
    mk(`${flota}/tipo sin parámetro`, flota, null, { tipo: "NO_EXISTE" });
    mk(`${flota}/fallo de lectura`, flota, P.diesel, { fallo: "red caída" });
    mk(`${flota}/fallo de precios`, flota, P.diesel, { falloPrecios: "red caída" });
    mk(`${flota}/sin precio de GLP`, flota, P.glpGas, { precios: { "Diésel": 16.5, "Gasolina": 17.2 } });
    mk(`${flota}/sin precio de urea`, flota, P.dieselUrea, { precios: { "Diésel": 16.5 } });
  }
  return out;
}

// ══ 1. La cadena km → combustible → costo → CO₂, por barrido ═════════════════════════════════
console.log("\n1. km → combustible → costo → CO₂: valor ≠ null ⟺ estimado, y el piso se propaga");
{
  const ctxs = contextos();
  let combos = 0, malValor = 0, malPiso = 0, sinKmEstimado = 0, terceroConCosto = 0, sinBase = 0, co2DistintoComb = 0;
  let costoNoPropio = 0, familiaAjena = 0, estimados = 0, pisos = 0, codigoInvalido = 0;
  const codigosVistos = new Set<string>();
  for (const codigo of CODIGOS_RASTREO) for (const enCurso of [false, true]) for (const r of [null, resumen(0), resumen(23.4)])
    for (const sim of [0, 3]) for (const { ctx } of ctxs) {
      combos++;
      const km = kmPublicable(ver(codigo, enCurso), r, sim);
      const c = combustibleEstimado(km, ctx);
      const k = costoCombustibleEstimado(km, ctx);
      const o = co2Estimado(c);
      codigosVistos.add(c.codigo);
      if (!(CODIGOS_COMBUSTIBLE as readonly string[]).includes(c.codigo)) codigoInvalido++;
      // valor ≠ null ⟺ código publicable
      if ((c.porFamilia.length > 0) !== (c.codigo === "estimado")) malValor++;
      if ((k.soles != null) !== (k.codigo === "estimado")) malValor++;
      if ((o.kg != null) !== (o.codigo === "estimado")) malValor++;
      // nada se estima sin km publicable
      if (c.codigo === "estimado" && !KM_GPS_PUBLICA[km.codigo]) sinKmEstimado++;
      if (c.codigo === "estimado" && km.km == null) sinKmEstimado++;
      // el piso se propaga (y solo con valor)
      if (c.piso !== (c.codigo === "estimado" && km.piso)) malPiso++;
      if (k.piso !== (k.codigo === "estimado" && km.piso)) malPiso++;
      if (o.piso !== (o.codigo === "estimado" && km.piso)) malPiso++;
      // un tercero nunca tiene costo; un costo estimado es de una propia con combustible estimado
      if (ctx?.flota === "tercero" && k.codigo !== "tercero") terceroConCosto++;
      if (k.codigo === "estimado" && (ctx?.flota !== "propia" || c.codigo !== "estimado")) costoNoPropio++;
      // el CO₂ sigue al combustible (toda familia reconocida tiene factor)
      if ((o.codigo === "estimado") !== (c.codigo === "estimado")) co2DistintoComb++;
      if (c.codigo !== "estimado" && o.codigo !== c.codigo) co2DistintoComb++;
      // ninguna familia que el parámetro no declare (nunca «diésel» por defecto)
      if (c.codigo === "estimado" && ctx?.parametros) {
        const p = ctx.parametros;
        const decl = new Set([familiaDeParametro(p.tipo_combustible_1), familiaDeParametro(p.tipo_combustible_2)].filter(Boolean));
        if (c.porFamilia.some((f) => !decl.has(f.familia))) familiaAjena++;
      }
      if (!c.base || !k.base || !o.base) sinBase++;
      if (c.codigo === "estimado") estimados++;
      if (c.piso) pisos++;
    }
  chk(`valor ≠ null ⟺ código estimado (combustible, costo y CO₂) en ${combos} combinaciones`, malValor === 0, `${malValor} discrepancias`);
  chk("nada se estima sin un km publicable (medido o piso)", sinKmEstimado === 0, `${sinKmEstimado}`);
  chk("el piso del km se propaga a combustible, costo y CO₂, y solo con valor", malPiso === 0, `${malPiso}`);
  chk("un tercero nunca tiene costo de combustible (código `tercero`)", terceroConCosto === 0, `${terceroConCosto}`);
  chk("un costo estimado es siempre de una propia con combustible estimado", costoNoPropio === 0, `${costoNoPropio}`);
  chk("el CO₂ sigue al combustible: estimado ⟺ estimado, y el mismo motivo si no", co2DistintoComb === 0, `${co2DistintoComb}`);
  chk("nunca aparece una familia que el parámetro no declara", familiaAjena === 0, `${familiaAjena}`);
  chk("toda cifra (o su ausencia) lleva su base", sinBase === 0, `${sinBase}`);
  chk("todo código pertenece al catálogo declarado", codigoInvalido === 0);
  chk("corolario: el barrido estima y propaga pisos de verdad", estimados >= 60 && pisos >= 20, `${estimados} estimados, ${pisos} pisos`);
  chk("corolario: el barrido recorre los siete códigos del combustible", CODIGOS_COMBUSTIBLE.every((x) => codigosVistos.has(x)), [...codigosVistos].sort().join(", "));
}

// ══ 2. El ciclo con el presupuesto, al céntimo ═══════════════════════════════════════════════
console.log("\n2. Ciclo con `calcularPresupuesto`: el costo estimado ES su renglón «Combustible»");
{
  let casos = 0, iguales = 0, estimados = 0, mismaBase = 0;
  const peor: string[] = [];
  for (const [kp, p] of Object.entries(P)) for (const [km_, med] of Object.entries(MED)) for (const [ku, ult] of Object.entries(ULT))
    for (const km of [0.7, 12.3, 48.95, 133, 612.4]) {
      const ctxCosteo = {
        parametros: p, precios: PRECIOS, rendimientoMedido: med, precioUltimaCarga: ult, deprecKm: null, conductor: null,
        diasConServicio: 0, serviciosDelDia: 1, diasLaborablesMes: 26, kmSugerido: null, placa: "ABC-123",
      };
      const pres = calcularPresupuesto(ctxCosteo as any, { km, kmFuente: "gps", dias: 1, peajes: 0, viaticos: 0, estacionamiento: 0, pernocte: 0, otros: 0 });
      const linea = pres.lineas.find((l) => l.concepto === "combustible");
      const ctx = contextoCombustible({ flota: "propia", tipoCosteo: p.tipo_vehiculo, parametros: p, medicion: med, precioUltimaCarga: ult, preciosReferencia: PRECIOS });
      const costo = costoCombustibleEstimado(kmMedido(km), ctx);
      if (costo.codigo !== "estimado") continue;   // el presupuesto costea igual; aquí no se publica (y se dice por qué)
      casos++;
      estimados++;
      if (linea && costo.soles === linea.monto) iguales++;
      else if (peor.length < 3) peor.push(`${kp}/${km_}/${ku}/${km}: ${costo.soles} vs ${linea?.monto}`);
      if (linea && ctx.decision && linea.base.includes(ctx.decision.base) && costo.base.includes(ctx.decision.base)) mismaBase++;
    }
  chk(`soles === monto del renglón, al céntimo, en ${casos} casos`, casos > 0 && iguales === casos, peor.join(" · "));
  chk("los dos dicen el mismo rendimiento (la misma `decidirRendimiento`)", mismaBase === casos);
  chk("corolario: la rejilla estima con medición, sin ella, con y sin última carga, y con urea", estimados >= 150, `${estimados}`);

  // Σ volumen × precio + urea = costo (el volumen estimado y el costo son del mismo motor).
  let cuadra = 0, total = 0;
  for (const p of [P.diesel, P.dieselUrea, P.glpGas, P.gnv, P.gnvGas, P.gasolina]) for (const km of [5, 77.7]) {
    total++;
    const ctx = contextoCombustible({ flota: "propia", tipoCosteo: p.tipo_vehiculo, parametros: p, medicion: null, precioUltimaCarga: null, preciosReferencia: PRECIOS });
    const c = calcularCostoUnidad({ ...p, rendimiento_1: ctx.decision!.valor }, ctx.precios, { km, dias: 1, peajes: 0, otros: 0, pernocte: 0, viaticos: 0 })!;
    const vol = consumoPorKm({ ...p, rendimiento_1: ctx.decision!.valor }).reduce((s, x) => s + x.cantidadPorKm * km * (ctx.precios[x.tipo] || 0), 0);
    if (Math.abs(vol + c.costoUrea - c.costoCombustible) < 1e-9) cuadra++;
  }
  chk("Σ(cantidad × precio) + urea = costoCombustible (el volumen y el costo son el mismo motor)", cuadra === total, `${cuadra}/${total}`);
}

// ══ 3. Tercero ═══════════════════════════════════════════════════════════════════════════════
console.log("\n3. Un TERCERO: costo `tercero`, y CO₂ si su tipo tiene parámetro");
{
  const conMed = contextoCombustible({ flota: "tercero", tipoCosteo: "BUS_50", parametros: P.diesel, medicion: MED.dieselBuena, precioUltimaCarga: ULT.diesel, preciosReferencia: PRECIOS });
  const km = kmMedido(40);
  const c = combustibleEstimado(km, conMed), k = costoCombustibleEstimado(km, conMed), o = co2Estimado(c);
  chk("costo `tercero`, sin soles", k.codigo === "tercero" && k.soles === null && /factura/i.test(k.base));
  chk("combustible y CO₂ estimados con su parámetro", c.codigo === "estimado" && o.codigo === "estimado" && (o.kg ?? 0) > 0);
  chk("a un tercero no se le aplica la medición ni la última carga (rendimiento del parámetro, precios de referencia)",
    conMed.decision?.aplica === false && conMed.decision?.motivo === "sin_medicion" && conMed.precios["Diésel"] === PRECIOS["Diésel"]);
  chk("…y su volumen sale del rendimiento del parámetro", Math.abs(c.porFamilia[0].cantidad - 40 / 8) < 1e-12);
  const sinTipo = contextoCombustible({ flota: "tercero", tipoCosteo: null, parametros: null, medicion: null, precioUltimaCarga: null, preciosReferencia: PRECIOS });
  chk("un tercero sin categoría: costo `tercero` y CO₂ `sin_tipo_costeo` (no se inventa)",
    costoCombustibleEstimado(km, sinTipo).codigo === "tercero" && co2Estimado(combustibleEstimado(km, sinTipo)).codigo === "sin_tipo_costeo");
  const propia = contextoCombustible({ flota: "propia", tipoCosteo: "BUS_50", parametros: P.diesel, medicion: MED.dieselBuena, precioUltimaCarga: ULT.diesel, preciosReferencia: PRECIOS });
  chk("a una propia sí se le aplican la medición confiable y la última carga (como el presupuesto)",
    propia.decision?.aplica === true && propia.decision.valor === 9.2 && propia.precios["Diésel"] === 17.85);
}

// ══ 4. Bimodal: dos familias, nunca sumadas ══════════════════════════════════════════════════
console.log("\n4. Un tipo BIMODAL: dos familias, cada una en su unidad, nunca sumadas");
{
  const km = kmMedido(60);
  const mk = (p: ParametrosUnidad) => contextoCombustible({ flota: "propia", tipoCosteo: p.tipo_vehiculo, parametros: p, medicion: null, precioUltimaCarga: null, preciosReferencia: PRECIOS });
  const a = combustibleEstimado(km, mk(P.glpGas));
  chk("GLP + gasolina → dos entradas (glp y gasolina), ambas en galones",
    a.porFamilia.length === 2 && a.porFamilia.some((f) => f.familia === "glp" && f.unidad === "galones") && a.porFamilia.some((f) => f.familia === "gasolina" && f.unidad === "galones"));
  chk("…con la cantidad de cada una (60 × 0.6 ÷ 9.5 y 60 × 0.4 ÷ 12)",
    Math.abs(a.porFamilia.find((f) => f.familia === "glp")!.cantidad - 60 * 0.6 / 9.5) < 1e-12
    && Math.abs(a.porFamilia.find((f) => f.familia === "gasolina")!.cantidad - 60 * 0.4 / 12) < 1e-12);
  const b = combustibleEstimado(km, mk(P.gnvGas));
  chk("GNV + gasolina → m³ y galones por separado", b.porFamilia.length === 2
    && b.porFamilia.find((f) => f.familia === "gnv")?.unidad === "m3" && b.porFamilia.find((f) => f.familia === "gasolina")?.unidad === "galones");
  chk("el texto los une con «+», nunca los suma", /m³ GNV \+|gal gasolina \+|\+ .*m³|\+ .*gal/.test(textoCantidades(b)) && textoCantidades(b).split("+").length === 2);
  const dup = combustibleEstimado(km, mk({ ...P.diesel, tipo_combustible_2: "Diesel", rendimiento_2: 6, pct_uso_1: 0.5, pct_uso_2: 0.5 }));
  chk("dos tipos de la MISMA familia sí se suman (misma unidad)", dup.porFamilia.length === 1 && Math.abs(dup.porFamilia[0].cantidad - (30 / 8 + 30 / 6)) < 1e-12);
  const o = co2Estimado(b);
  chk("el CO₂ de un bimodal suma los kg de las dos familias", o.porFamilia.length === 2 && Math.abs((o.kg ?? 0) - o.porFamilia.reduce((s, x) => s + x.kg, 0)) < 1e-12);
  const sinR2 = combustibleEstimado(km, mk(P.sinRend2));
  chk("un segundo combustible declarado sin rendimiento no se calla: `sin_parametro`", sinR2.codigo === "sin_parametro" && /Gasolina/.test(sinR2.base));
  const sinR = combustibleEstimado(km, mk(P.sinRend));
  chk("un rendimiento en cero no se publica como «0 galones»: `sin_parametro`", sinR.codigo === "sin_parametro" && sinR.porFamilia.length === 0);
}

// ══ 5. Familia desconocida ═══════════════════════════════════════════════════════════════════
console.log("\n5. Familia DESCONOCIDA: `familia_desconocida`, nunca diésel");
{
  const km = kmMedido(30);
  for (const p of [P.desconocido, P.desconocido2]) {
    const ctx = contextoCombustible({ flota: "propia", tipoCosteo: p.tipo_vehiculo, parametros: p, medicion: null, precioUltimaCarga: null, preciosReferencia: { ...PRECIOS, "Gasohol 90": 18, "Kerosene": 12 } });
    const c = combustibleEstimado(km, ctx), k = costoCombustibleEstimado(km, ctx), o = co2Estimado(c);
    chk(`«${p.tipo_combustible_2 ?? p.tipo_combustible_1}» → familia_desconocida en combustible, costo y CO₂`,
      c.codigo === "familia_desconocida" && k.codigo === "familia_desconocida" && o.codigo === "familia_desconocida" && c.porFamilia.length === 0 && /diésel/.test(c.base));
  }
  chk("la unidad sale del catálogo: diésel/glp/gasolina en galones, GNV en m³, la urea y lo desconocido sin unidad",
    unidadDeFamilia("diesel") === "galones" && unidadDeFamilia("glp") === "galones" && unidadDeFamilia("gasolina") === "galones"
    && unidadDeFamilia("gnv") === "m3" && unidadDeFamilia("urea") === null && unidadDeFamilia("kerosene") === null);
}

// ══ 6. CO₂ = cantidad × factor exacto ════════════════════════════════════════════════════════
console.log("\n6. CO₂ = cantidad × factor de su familia, exacto");
{
  let n = 0, ok = 0;
  for (const p of Object.values(P)) for (const km of [1, 17.3, 250]) for (const piso of [false, true]) {
    const ctx = contextoCombustible({ flota: rnd() < 0.5 ? "propia" : "tercero", tipoCosteo: p.tipo_vehiculo, parametros: p, medicion: MED.dieselBuena, precioUltimaCarga: null, preciosReferencia: PRECIOS });
    const c = combustibleEstimado(kmMedido(km, piso), ctx);
    if (c.codigo !== "estimado") continue;
    n++;
    const o = co2Estimado(c);
    const esperado = c.porFamilia.reduce((s, f) => s + f.cantidad * FACTOR_CO2[f.familia]!.kgPorUnidad, 0);
    const porFam = c.porFamilia.every((f, i) => o.porFamilia[i]?.familia === f.familia && o.porFamilia[i].kg === f.cantidad * FACTOR_CO2[f.familia]!.kgPorUnidad);
    if (o.kg === esperado && porFam && o.piso === piso) ok++;
  }
  chk(`kg = Σ cantidad × factor (y por familia, exacto; con su piso) en ${n} casos`, n > 20 && ok === n, `${ok}/${n}`);
  const gnv = co2Estimado(combustibleEstimado(kmMedido(42), contextoCombustible({ flota: "propia", tipoCosteo: "G", parametros: P.gnv, medicion: null, precioUltimaCarga: null, preciosReferencia: PRECIOS })));
  chk("GNV: 42 km ÷ 4.2 km/m³ = 10 m³ × 1.9225 kg/m³", Math.abs((gnv.kg ?? 0) - 10 * 0.05444 * 35.3147) < 1e-9);
}

// ══ Servicios sintéticos (para 7 y 9) ════════════════════════════════════════════════════════
function servicioSintetico(id: number, o: { cliente: number | null; flota: "propia" | "tercero" | null; codigo: CodigoRastreo; km: number | null }): ServicioParaEstadistica {
  const reserva: any = {
    id, codigo: `OS-${id}`, estado: o.codigo === "no_aplica" ? "programada" : "finalizada", fecha_servicio: HOY, hora_servicio: "06:30",
    cliente_id: o.cliente, ruta_nombre: rnd() < 0.7 ? `RUTA ${"ABC"[id % 3]}` : null, origen: "Santa Anita", destino: rnd() < 0.8 ? "Punta Hermosa" : null,
    vehiculo_id: o.flota === "propia" ? 10 + (id % 4) : null, vehiculo_tercero_id: o.flota === "tercero" ? 10 + (id % 4) : null,
    conductor_id: id % 2 ? 7 : null, conductor_tercero_id: id % 2 ? null : 9,
  };
  const ctx = contextoServicio(reserva, [], { hoy: HOY, ahoraMs: T0 + 86_400_000 });
  return { reserva, paradas: [], ctx, traza: null, veredicto: ver(o.codigo) };
}
const CTX_POR_UNIDAD = (flota: "propia" | "tercero", vid: number): ContextoCombustibleUnidad => {
  const p = [P.diesel, P.gnv, P.glpGas, P.desconocido][vid % 4];
  return contextoCombustible({ flota, tipoCosteo: vid % 4 === 3 && flota === "tercero" ? null : p.tipo_vehiculo, parametros: vid % 4 === 3 && flota === "tercero" ? null : p, medicion: null, precioUltimaCarga: null, preciosReferencia: PRECIOS });
};
function huellaSintetica(s: ServicioParaEstadistica, km: number | null, sim: number): HuellaServicio {
  const r = km == null ? null : resumen(km);
  return {
    resumen: r, km: kmPublicable(s.veredicto, r, sim),
    excesos: { codigo: "sin_medir", n: null, segundos: null, velMax: null, descartados: {}, umbral: 90, piso: false, base: "sintético" },
    conductorGps: null,
  };
}

// ══ 7. resumirPorCliente ═════════════════════════════════════════════════════════════════════
console.log("\n7. `resumirPorCliente`: no mezcla galones con m³ y cuadra con la suma de las filas");
{
  const xs: EstadisticaServicio[] = [];
  for (let i = 1; i <= 400; i++) {
    const flota = rnd() < 0.1 ? null : rnd() < 0.7 ? "propia" : "tercero";
    const codigo = CODIGOS_RASTREO[Math.floor(rnd() * CODIGOS_RASTREO.length)];
    const km = rnd() < 0.1 ? null : rnd() < 0.05 ? 0 : Math.round(rnd() * 3000) / 10;
    const s = servicioSintetico(i, { cliente: rnd() < 0.08 ? null : 1 + Math.floor(rnd() * 6), flota, codigo, km });
    const vid = Number(s.reserva.vehiculo_id ?? s.reserva.vehiculo_tercero_id);
    xs.push(componerEstadistica({
      s, huella: huellaSintetica(s, km, rnd() < 0.05 ? 2 : 0), ctxComb: flota ? CTX_POR_UNIDAD(flota, vid) : null,
      ahoraMs: T0 + 86_400_000, hoy: HOY, nombres: { cliente: (id) => `Cliente ${id}` },
    }));
  }
  const filas = resumirPorCliente(xs);
  const total = totalDelDia(xs);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  const kgServ = sum(xs.map((x) => x.co2.kg ?? 0)), solesServ = sum(xs.map((x) => x.costo.soles ?? 0)), kmServ = sum(xs.map((x) => x.km.km ?? 0));
  chk("cada fila tiene a lo sumo una entrada por familia, y en la unidad de su familia (nunca gal con m³)",
    filas.every((f) => new Set(f.combustible.map((c) => c.familia)).size === f.combustible.length && f.combustible.every((c) => c.unidad === unidadDeFamilia(c.familia))));
  chk("Σ kg de las filas = Σ kg de los servicios", Math.abs(sum(filas.map((f) => f.co2Kg)) - kgServ) < 1e-6 && Math.abs(total.co2Kg - kgServ) < 1e-6);
  chk("Σ soles de las filas = Σ soles de los servicios (al céntimo)", Math.abs(sum(filas.map((f) => f.costoSoles)) - solesServ) < 0.005 * filas.length && Math.abs(total.costoSoles - solesServ) < 0.005);
  chk("Σ km de las filas = Σ km publicable de los servicios", Math.abs(sum(filas.map((f) => f.km)) - kmServ) < 1e-6);
  let porFamOk = true;
  for (const fam of ["diesel", "gnv", "glp", "gasolina"]) {
    const s1 = sum(xs.flatMap((x) => x.combustible.porFamilia.filter((c) => c.familia === fam).map((c) => c.cantidad)));
    const s2 = sum(filas.flatMap((f) => f.combustible.filter((c) => c.familia === fam).map((c) => c.cantidad)));
    if (Math.abs(s1 - s2) > 1e-6) porFamOk = false;
  }
  chk("la cantidad de cada familia cuadra por separado", porFamOk);
  chk("cada servicio cae en el total de CO₂ o en un motivo, nunca en los dos ni en ninguno",
    filas.every((f) => f.co2Servicios + sum(Object.values(f.sinCo2).map(Number)) === f.servicios)
    && filas.every((f) => f.costoServicios + sum(Object.values(f.sinCosto).map(Number)) === f.servicios));
  chk("los servicios de las filas suman los del día, y propios + terceros + sin unidad = servicios",
    sum(filas.map((f) => f.servicios)) === xs.length && total.servicios === xs.length && filas.every((f) => f.propios + f.terceros + f.sinUnidad === f.servicios));
  chk("el piso de un total es «alguno de sus servicios es un mínimo»",
    filas.every((f) => f.co2Piso === xs.some((x) => (x.cliente.id ?? "sin") === (f.clienteId ?? "sin") && x.co2.piso)));
  chk("un cliente con GNV y diésel lleva m³ y galones por separado", filas.some((f) => f.combustible.some((c) => c.unidad === "m3") && f.combustible.some((c) => c.unidad === "galones")));
  chk("los servicios sin cliente van en «Sin cliente»", filas.some((f) => f.clienteId === null && f.nombre === "Sin cliente"));
  chk("corolario: hay CO₂, costo y motivos en el corte", total.co2Servicios > 20 && total.costoServicios > 10 && (total.sinCo2.sin_km ?? 0) > 0 && (total.sinCosto.tercero ?? 0) > 0,
    `CO₂ ${total.co2Servicios}, costo ${total.costoServicios}, sin km ${total.sinCo2.sin_km ?? 0}, tercero ${total.sinCosto.tercero ?? 0}`);
  chk("lo de la huella se publica con la puerta del km (marcha ⟹ código que publica; km publicado ⟹ marcha)",
    xs.every((x) => (x.marchaMin == null || HUELLA_PUBLICA[x.km.codigo]) && (x.km.km == null || x.marchaMin != null)));
  chk("la RUTA y el ORIGEN → DESTINO viajan por separado (sin nombre, la RUTA es null, nunca el recorrido)",
    xs.every((x) => x.ruta.nombre === null ? x.ruta.recorrido !== null : x.ruta.nombre.startsWith("RUTA")));
  chk("la respuesta no lleva teléfonos", !/telefono/i.test(JSON.stringify(xs)));
}

// ══ 8. Excesos = pieza 1 ═════════════════════════════════════════════════════════════════════
console.log("\n8. Excesos del servicio = los episodios de la pieza 1 restringidos a su reserva");
{
  const { detectarExcesos, puntosDeCrudas } = await import("../lib/flota/excesos");
  /** Filas crudas de un tramo: una cada `paso` s, a `kmh` en línea recta (o quieto con jitter si `quieto`). */
  function tramo(desdeMs: number, segs: number, kmh: number, o: { conductor?: number; tercero?: number; paso?: number; quieto?: boolean; prec?: number | null; velSensor?: number; lat0?: number } = {}): Fila[] {
    const out: Fila[] = [];
    const paso = o.paso ?? 3;
    let lat = o.lat0 ?? -12.05;
    for (let t = 0; t <= segs; t += paso) {
      if (!o.quieto) lat += ((kmh / 3.6) * paso) / 111_320;
      const jit = o.quieto ? (rnd() - 0.5) * 0.00004 : 0;
      out.push({
        created_at: new Date(desdeMs + t * 1000).toISOString(), lat: lat + jit, lng: -77.03 + jit,
        precision_m: o.prec === undefined ? 4 + (t % 3) : o.prec, simulado: null, estado: "en_ruta",
        velocidad: o.velSensor ?? kmh, rumbo: 0, timestamp: null,
        conductor_id: o.tercero ? null : o.conductor ?? 5, conductor_tercero_id: o.tercero ?? null,
      });
    }
    return out;
  }
  const ver = (codigo: CodigoRastreo): VeredictoRastreo => ({ codigo, pct: 98, problema: null, celda: "", color: "", bg: "", detalle: "", ultimaSenalTs: null, enCurso: false });
  const delServicio = (id: number, filas: Fila[], umbral: number, codigo: CodigoRastreo = "completo") =>
    SE.excesosDelServicio({ reservaId: id, crudas: filas, aplica: true, trazaLeida: true, rastreo: ver(codigo), umbral, vehiculo: `p:${id}` });

  // Barrido: días mezclados con varios servicios del MISMO conductor seguidos, el mismo id en las dos
  // tablas (p:5 y t:5) a la misma hora, y puntos fuera de servicio entre medio.
  let dias = 0, servicios = 0, iguales = 0, conExceso = 0, conDescarte = 0;
  const peor: string[] = [];
  for (let d = 0; d < 60; d++) for (const umbral of [60, 80, 90, 100, 120]) {
    dias++;
    const t0 = T0 + d * 86_400_000;
    const porServicio = new Map<number, Fila[]>();
    const fuera: Fila[] = [];
    let cursor = t0;
    for (let k = 1; k <= 4; k++) {
      const id = d * 10 + k;
      const filas: Fila[] = [];
      // Servicios del mismo conductor PEGADOS (menos de GAP entre uno y otro): el motor no los junta.
      for (let tr = 0; tr < 3; tr++) {
        const kmh = [40, 70, 85, 92, 98, 105, 125, 140][Math.floor(rnd() * 8)];
        const segs = [6, 20, 35, 60, 120][Math.floor(rnd() * 5)];
        const quieto = rnd() < 0.15;
        filas.push(...tramo(cursor, segs, kmh, { conductor: k % 2 ? 5 : undefined, tercero: k % 2 ? undefined : 5, quieto, prec: rnd() < 0.1 ? 60 : rnd() < 0.05 ? null : undefined }));
        cursor += (segs + 2 + (rnd() < 0.4 ? 30 : 0)) * 1000;
      }
      porServicio.set(id, filas);
      if (rnd() < 0.5) {
        fuera.push(...tramo(cursor, 40, 100, { conductor: 5 }));
        cursor += 45_000;
      }
    }
    // La pieza 1: TODO junto (cada servicio con su reserva, lo de fuera sin reserva).
    const todos = [
      ...[...porServicio].flatMap(([id, filas]) => puntosDeCrudas(filas, { reservaId: id, vehiculo: `p:${id}` })),
      ...puntosDeCrudas(fuera),
    ];
    const global = detectarExcesos(todos, umbral);
    for (const [id, filas] of porServicio) {
      servicios++;
      const suyos = global.filter((e) => e.reservaId === id);
      const cuentan = suyos.filter((e) => e.codigo === "exceso");
      const mio = delServicio(id, filas, umbral);
      const desc: Record<string, number> = {};
      for (const e of suyos) if (e.codigo !== "exceso") desc[e.codigo] = (desc[e.codigo] ?? 0) + 1;
      const ok = mio.codigo === "medido" && mio.n === cuentan.length
        && mio.segundos === cuentan.reduce((a, e) => a + e.durS, 0)
        && mio.velMax === (cuentan.length ? Math.max(...cuentan.map((e) => e.velMaxSensor)) : null)
        && JSON.stringify(Object.entries(mio.descartados).sort()) === JSON.stringify(Object.entries(desc).sort());
      if (ok) iguales++;
      else if (peor.length < 3) peor.push(`día ${d} u${umbral} #${id}: ${mio.n}/${cuentan.length}`);
      if (cuentan.length) conExceso++;
      if (suyos.length > cuentan.length) conDescarte++;
    }
  }
  chk(`los excesos del servicio = los episodios de la pieza 1 con su reserva_id (${servicios} servicios, ${dias} días × umbral)`, iguales === servicios, peor.join(" · "));
  chk("corolario: el barrido tiene servicios con excesos y con descartados", conExceso > 50 && conDescarte > 50, `${conExceso} con exceso, ${conDescarte} con descartes`);

  // Lo de fuera de servicio no se le carga a ningún servicio.
  const soloFuera = detectarExcesos(puntosDeCrudas(tramo(T0, 90, 110, { conductor: 5 })), 90);
  chk("un exceso fuera de servicio existe para la pieza 1 pero no es de ningún servicio", soloFuera.some((e) => e.codigo === "exceso" && e.reservaId === null));

  // Tri-estado y casos que no se pueden aflojar.
  const sinDoppler = delServicio(1, tramo(T0, 120, 100, { velSensor: 0 }), 90);
  chk("teléfono sin velocímetro: `sin_velocimetro` con n null (nunca «0 excesos»)", sinDoppler.codigo === "sin_velocimetro" && sinDoppler.n === null);
  const fantasma = delServicio(1, tramo(T0, 90, 95, { quieto: true }), 90);
  chk("bus parado con velocidad fantasma (FUSED): 0 excesos y 1 descartado sin corroborar",
    fantasma.codigo === "medido" && fantasma.n === 0 && fantasma.descartados.sin_corroborar === 1);
  const corolario = delServicio(1, tramo(T0, 60, 100), 90);
  chk("COROLARIO: un bus a 100 km/h durante 60 s con buena precisión es un exceso", corolario.n === 1 && corolario.segundos === 60 && corolario.velMax === 100);
  const cortes = delServicio(1, tramo(T0, 60, 100), 90, "con_cortes");
  chk("con un rastreo con cortes, el conteo es un mínimo (`piso`)", cortes.piso && !corolario.piso);
  const vacio = SE.excesosDelServicio({ reservaId: 1, crudas: [], aplica: true, trazaLeida: true, rastreo: ver("sin_senal"), umbral: 90 });
  chk("un servicio que corrió sin ninguna posición: `sin_posiciones`", vacio.codigo === "sin_posiciones" && vacio.n === null);
  const noSale = huellaDeServicio(servicioSintetico(2, { cliente: 1, flota: "propia", codigo: "no_aplica", km: null }), 90);
  chk("un servicio que no salió: `no_aplica`", noSale.excesos.codigo === "no_aplica" && noSale.excesos.n === null);
  const s = servicioSintetico(3, { cliente: 1, flota: "propia", codigo: "completo", km: 20 });
  const sinLeer = huellaDeServicio({ ...s, traza: null }, 90);
  chk("una traza que no se pudo leer: `sin_medir`", sinLeer.excesos.codigo === "sin_medir" && sinLeer.excesos.n === null);
  chk("n ≠ null ⟺ `medido`", [sinDoppler, fantasma, corolario, cortes, vacio, noSale.excesos, sinLeer.excesos].every((x) => (x.n != null) === (x.codigo === "medido")));
}

// ══ 9. Huella + composición = estadisticaDeServicio ══════════════════════════════════════════
console.log("\n9. Huella + composición = `estadisticaDeServicio` (el lector suelta las filas en medio): se comprueba sobre trazas de verdad, en la sección 10 («9 ·»)");

// ══ 10. De punta a punta sobre una traza ═════════════════════════════════════════════════════
type Fila = Record<string, unknown>;
function baseFalsa(filas: Fila[]) {
  return {
    from: () => {
      let cols: string[] = [];
      const q: any = {
        select(c: string) { cols = c.split(",").map((x) => x.trim()); return q; },
        eq() { return q; }, order() { return q; },
        range(a: number, b: number) { return Promise.resolve({ data: filas.slice(a, b + 1).map((f) => Object.fromEntries(cols.map((c) => [c, f[c]]))), error: null }); },
      };
      return q;
    },
  };
}
/** Un viaje limpio: una posición cada 5 s durante `min` minutos, a ~40 km/h en línea recta. */
function viajeLimpio(min: number, o: { conductor?: number; tercero?: number; velocidad?: number; desdeMs?: number } = {}): Fila[] {
  const out: Fila[] = [];
  const n = Math.floor((min * 60) / 5);
  const desde = o.desdeMs ?? T0;
  for (let i = 0; i <= n; i++) {
    const ts = desde + i * 5000;
    const m = (40 / 3.6) * 5 * i;
    out.push({
      created_at: new Date(ts).toISOString(), timestamp: new Date(ts).toISOString(),
      lat: -12.05 + m / 111_320, lng: -77.03, precision_m: 5 + (i % 3), simulado: null,
      estado: i === n ? "finalizado" : "en_ruta", velocidad: o.velocidad ?? 40, rumbo: 0,
      conductor_id: o.conductor ?? (o.tercero ? null : 7), conductor_tercero_id: o.tercero ?? null,
    });
  }
  return out;
}
console.log("\n10. De punta a punta sobre una traza");
{
  const r = { id: 501, codigo: "OS-501", estado: "finalizada", fecha_servicio: HOY, hora_servicio: "06:00", hora_real_inicio: "06:00:00",
    cliente_id: 3, ruta_nombre: "RUTA A/ ENTRADA 06:00", origen: "Santa Anita", destino: "Lurín", vehiculo_id: 12, vehiculo_tercero_id: null, conductor_id: 7, conductor_tercero_id: null };
  const filas = viajeLimpio(45);
  const ultimo = filas[filas.length - 1];
  const ps = [
    { id: 1, reserva_id: 501, orden: 1, estado: "completada", hora_estimada: "06:00", hora_llegada: new Date(T0).toISOString(), lat: -12.05, lng: -77.03 },
    { id: 2, reserva_id: 501, orden: 2, estado: "completada", hora_estimada: "06:45", hora_llegada: String(ultimo.created_at), lat: Number(ultimo.lat), lng: -77.03 },
  ];
  const ahoraMs = T0 + 86_400_000;
  const leer = (f: Fila[]) => (id: number, o?: any) => leerTraza(baseFalsa(f) as any, id, o);
  const s = await medirServicio(r, ps, { hoy: HOY, ahoraMs, conHuella: true }, leer(filas));
  const ctx = contextoCombustible({ flota: "propia", tipoCosteo: "BUS_50", parametros: P.diesel, medicion: MED.dieselBuena, precioUltimaCarga: ULT.diesel, preciosReferencia: PRECIOS });
  const nombres = { conductor: (c: string) => ({ "p:7": "JUAN PÉREZ", "t:4": "LUIS TERCERO" } as Record<string, string>)[c] ?? null, cliente: () => "SNACKS", placa: () => "CWZ-371" };
  chk("precondición: el viaje limpio sale `completo` en RASTREO", s.veredicto.codigo === "completo", `${s.veredicto.codigo} ${s.veredicto.pct}`);
  const e = estadisticaDeServicio({ s, ctxComb: ctx, umbral: 90, ahoraMs, hoy: HOY, nombres });
  chk("COROLARIO: una propia diésel con km medido y tipo asignado publica km, combustible, costo y CO₂",
    e.km.codigo === "medido" && (e.km.km ?? 0) > 25 && e.combustible.codigo === "estimado" && e.costo.codigo === "estimado" && (e.costo.soles ?? 0) > 0
    && e.co2.codigo === "estimado" && (e.co2.kg ?? 0) > 0,
    `km ${e.km.km}, comb ${e.combustible.codigo}, costo ${e.costo.soles}, CO₂ ${e.co2.kg}`);
  chk("…con el número del presupuesto para ese km", e.costo.soles === calcularPresupuesto({
    parametros: P.diesel, precios: PRECIOS, rendimientoMedido: MED.dieselBuena, precioUltimaCarga: ULT.diesel, deprecKm: null, conductor: null,
    diasConServicio: 0, serviciosDelDia: 1, diasLaborablesMes: 26, kmSugerido: null, placa: "",
  } as any, { km: e.km.km!, kmFuente: "gps", dias: 1, peajes: 0, viaticos: 0, estacionamiento: 0, pernocte: 0, otros: 0 }).lineas.find((l) => l.concepto === "combustible")!.monto);
  chk("el rastreo es el MISMO veredicto de la torre", e.rastreo === s.veredicto);
  chk("marcha, detenido, paradas y vel. máx (p95) publicados", e.marchaMin != null && e.detenidoMin != null && e.paradas != null && e.velMaxP95 === 40);
  chk("franja ~GPS aparte de la evidencia del conductor", e.gpsDesdeTs === T0 && e.gpsHastaTs === Date.parse(String(ultimo.created_at)));
  chk("inicio de la evidencia del conductor (sin GPS)", e.inicio != null && e.inicio.fuente !== "gps" && e.inicio.ts === s.ctx.inicioTs);
  chk("RUTA y ORIGEN → DESTINO por separado", e.ruta.nombre === "RUTA A/ ENTRADA 06:00" && e.ruta.recorrido === "Santa Anita → Lurín");
  chk("cliente, placa, flota y conductor asignado", e.cliente.nombre === "SNACKS" && e.placa === "CWZ-371" && e.flota === "propia" && e.vehiculo === "p:12"
    && e.conductor.clave === "p:7" && e.conductor.nombre === "JUAN PÉREZ");
  chk("el GPS es del mismo conductor: no se avisa", e.conductorGps === null);
  chk("excesos medidos con el velocímetro del teléfono: a 40 km/h, 0 (y es un dato, no un vacío)", e.excesos.codigo === "medido" && e.excesos.n === 0 && !e.excesos.piso);

  // 9 · la composición en dos fases (lo que hace el lector) da lo mismo que de punta a punta.
  const h = huellaDeServicio(s, 90);
  const suelta = { reserva: s.reserva, paradas: s.paradas, ctx: s.ctx, traza: null, veredicto: s.veredicto };
  const e2 = componerEstadistica({ s: suelta, huella: h, ctxComb: ctx, ahoraMs, hoy: HOY, nombres });
  chk("9 · huella + composición (con la traza ya suelta) = estadisticaDeServicio", JSON.stringify(e2) === JSON.stringify(e));

  // Otro conductor en el teléfono.
  const ajena = await medirServicio({ ...r, id: 502 }, ps, { hoy: HOY, ahoraMs, conHuella: true }, leer(viajeLimpio(45, { tercero: 4 })));
  const ea = estadisticaDeServicio({ s: ajena, ctxComb: ctx, umbral: 90, ahoraMs, hoy: HOY, nombres });
  chk("si el GPS es de otro conductor, se avisa con su clave y nombre (los ids de las dos tablas no se mezclan)",
    ea.conductorGps?.clave === "t:4" && ea.conductorGps.nombre === "LUIS TERCERO" && ea.conductor.clave === "p:7");

  // Un tercero de punta a punta.
  const ter = await medirServicio({ ...r, id: 503, vehiculo_id: null, vehiculo_tercero_id: 12 }, ps, { hoy: HOY, ahoraMs, conHuella: true }, leer(filas));
  const ctxT = contextoCombustible({ flota: "tercero", tipoCosteo: "BUS_50", parametros: P.diesel, medicion: null, precioUltimaCarga: null, preciosReferencia: PRECIOS });
  const et = estadisticaDeServicio({ s: ter, ctxComb: ctxT, umbral: 90, ahoraMs, hoy: HOY, nombres });
  chk("un tercero de punta a punta: km y CO₂ sí, costo `tercero`", et.flota === "tercero" && et.vehiculo === "t:12" && et.km.codigo === "medido"
    && et.co2.codigo === "estimado" && et.costo.codigo === "tercero");

  // Un GPS con cortes: el piso llega hasta el CO₂.
  const cortada = filas.filter((_, i) => i < 150 || i > 260);
  const sc = await medirServicio({ ...r, id: 504 }, ps, { hoy: HOY, ahoraMs, conHuella: true }, leer(cortada));
  const ec = estadisticaDeServicio({ s: sc, ctxComb: ctx, umbral: 90, ahoraMs, hoy: HOY, nombres });
  chk(`un GPS con cortes (${sc.veredicto.codigo}): km, combustible, costo y CO₂ son mínimos (≥)`,
    sc.veredicto.codigo === "con_cortes" ? ec.km.piso && ec.combustible.piso && ec.costo.piso && ec.co2.piso && /≥/.test(ec.co2.base)
      : ec.km.km == null && ec.co2.kg == null);

  // La traza leída SIN sus filas no se lee como «sin desplazamiento».
  const sinFilas = await medirServicio({ ...r, id: 505 }, ps, { hoy: HOY, ahoraMs }, leer(filas));
  const ef = estadisticaDeServicio({ s: sinFilas, ctxComb: ctx, umbral: 90, ahoraMs, hoy: HOY, nombres });
  chk("una traza leída sin sus filas: km `sin_medir` (nunca «sin desplazamiento»), nada estimado",
    ef.km.codigo === "sin_medir" && ef.combustible.codigo === "sin_km" && ef.co2.kg === null && ef.excesos.codigo === "sin_medir");

  // Una traza que rompe el cálculo: ese servicio sale sin_medir, el resto sigue.
  const venenosa = { ...s, traza: { ...s.traza!, crudas: [{ get lat() { throw new Error("fila rota"); } }, {}] } };
  const ev = estadisticaDeServicio({ s: venenosa as any, ctxComb: ctx, umbral: 90, ahoraMs, hoy: HOY, nombres });
  chk("una traza que rompe el cálculo no tumba nada: km y excesos `sin_medir`", ev.km.codigo === "sin_medir" && ev.excesos.codigo === "sin_medir" && ev.co2.kg === null);

  // Simulado: no se publica nada de la huella.
  const simuladas = filas.map((f, i) => (i % 10 === 0 ? { ...f, simulado: true } : f));
  const ss = await medirServicio({ ...r, id: 506 }, ps, { hoy: HOY, ahoraMs, conHuella: true }, leer(simuladas));
  const es = estadisticaDeServicio({ s: ss, ctxComb: ctx, umbral: 90, ahoraMs, hoy: HOY, nombres });
  chk("con posiciones simuladas no se publica km, marcha, franja ni CO₂", es.km.codigo === "simulado" && es.marchaMin === null && es.gpsDesdeTs === null && es.co2.kg === null);

  // Un servicio que no salió.
  const ns = await medirServicio({ ...r, id: 507, estado: "programada", hora_real_inicio: null }, [], { hoy: HOY, ahoraMs, conHuella: true }, leer(filas));
  const en = estadisticaDeServicio({ s: ns, ctxComb: ctx, umbral: 90, ahoraMs, hoy: HOY, nombres });
  chk("un servicio que no salió: `no_aplica` en km y excesos, nada estimado", en.km.codigo === "no_aplica" && en.excesos.codigo === "no_aplica" && en.combustible.codigo === "sin_km");
}

// ══ 11. Umbral y respuesta de error ══════════════════════════════════════════════════════════
console.log("\n11. `normalizarUmbral` y la respuesta de error");
{
  chk("vacío → el defecto", normalizarUmbral(null) === UMBRAL_SERVICIO.defecto && normalizarUmbral("") === UMBRAL_SERVICIO.defecto && normalizarUmbral(undefined) === 90);
  chk("enteros dentro del rango pasan", normalizarUmbral("60") === 60 && normalizarUmbral("130") === 130 && normalizarUmbral("95") === 95);
  chk("fuera del rango, decimales, signos o texto → null (400)",
    ["59", "131", "90.5", "-90", "abc", "1e2", "0090", " 9 0"].every((t) => normalizarUmbral(t) === null));
  const er = respuestaConError("2026-10-09", 90, "No se pudo medir", 150);
  chk("la respuesta de error lleva el motivo, la lista vacía y un total en cero (no un «0 servicios» sin decir por qué)",
    er.error === "No se pudo medir" && er.servicios.length === 0 && er.total.servicios === 0 && er.medidoEn === null && er.metodo.factoresCo2.length === 4);
}

console.log(fallos ? `\n${fallos} FALLA(S)` : "\nTodo en verde.");
process.exit(fallos ? 1 : 0);
