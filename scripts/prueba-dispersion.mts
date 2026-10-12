// Pruebas de la DISPERSIÓN galones (o m³) vs km. NO tocan la base: datos en memoria contra el
// módulo puro lib/combustible/dispersion.ts, con series armadas por el motor de verdad
// (`seriesRendimiento` de lib/rendimiento.ts).
// Uso:  npx tsx scripts/prueba-dispersion.mts   (sale con código 1 si algo falla)
//
// Lo que se fija y no se puede aflojar:
//   · DISJUNTO Y EXHAUSTIVO — todo tramo de la familia que pasa el filtro sale UNA vez: como punto
//     o contado en `sinPunto[motivo]`. Uno que no saliera en ninguno sería uno que la pantalla no
//     explica en ningún sitio.
//   · NINGUNA FAMILIA AJENA — un km/gal y un km/m³ no comparten eje.
//   · LA CLASE ES LA DE `juzgarTramo` — el gráfico no tiene un juez propio.
//   · `implausible` CONSERVA SU CRUDO — un dato que se esconde obliga a ir a buscarlo a la base.
//   · LA REFERENCIA SOLO CON UNA UNIDAD — y solo cuando el motor juzga con ella.
//   · EL COROLARIO — un motor que no dibujara nunca nada cumpliría todo lo anterior de forma
//     trivial; una serie normal tiene que producir puntos, y el barrido tiene que producir las
//     cinco clases.
import {
  dispersionDeTramos,
  familiaPorDefecto,
  textoSinPunto,
  textoSinReferencia,
  unidadCantidadDeFamilia,
  type ClasePunto,
  type Dispersion,
  type FiltroDispersion,
} from "../lib/combustible/dispersion";
import {
  seriesRendimiento,
  tramosPorCarga,
  juzgarTramo,
  FACTOR_ALARMA_BAJO,
  FACTOR_ALARMA_ALTO,
  MIN_TRAMOS_CONFIABLE,
  techoDeFamilia,
  type CargaRendimiento,
  type MotivoSinRendimiento,
  type Serie,
  type Tramo,
} from "../lib/rendimiento";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
const cerca = (a: number | null | undefined, b: number, tol = 0.05) => a != null && Math.abs(a - b) < tol;
const sumaSinPunto = (d: Dispersion) => Object.values(d.sinPunto).reduce((s, n) => s + (n ?? 0), 0);

const TODOS_LOS_MOTIVOS: MotivoSinRendimiento[] = [
  "aditivo", "primera_carga", "sin_odometro", "sin_odometro_previo", "sin_cantidad",
  "odometro_retrocede", "unidad_desconocida", "eslabon_saltado", "familia_cruzada",
  "tanque_parcial", "implausible",
];

// ── 1. EL CASO REAL · CWZ-371 (diésel), el de lib/rendimiento.ts ─────────────
// Entre el 16/07 y el 05/08 no hay ninguna carga registrada: el tramo del 05/08 sale 162.9 km/gal.
// En la dispersión tiene que verse, TACHADO, con su crudo — y los ocho tramos sanos, normales.
const CWZ: CargaRendimiento[] = [
  { id: 1, unidad: "p1", fecha: "2026-07-16", kilometraje: 100000, cantidad: 9.74, tipo: "diesel" },
  { id: 2, unidad: "p1", fecha: "2026-08-05", kilometraje: 101592, cantidad: 9.77, tipo: "diesel" }, // 162.9
  { id: 3, unidad: "p1", fecha: "2026-08-11", kilometraje: 101968, cantidad: 13.84, tipo: "diesel" },
  { id: 4, unidad: "p1", fecha: "2026-08-14", kilometraje: 102231, cantidad: 9.07, tipo: "diesel" },
  { id: 5, unidad: "p1", fecha: "2026-08-18", kilometraje: 102504, cantidad: 9.79, tipo: "diesel" },
  { id: 6, unidad: "p1", fecha: "2026-08-21", kilometraje: 102782, cantidad: 9.72, tipo: "diesel" },
  { id: 7, unidad: "p1", fecha: "2026-08-25", kilometraje: 103136, cantidad: 12.72, tipo: "diesel" },
  { id: 8, unidad: "p1", fecha: "2026-08-28", kilometraje: 103438, cantidad: 10.62, tipo: "diesel" },
  { id: 9, unidad: "p1", fecha: "2026-08-31", kilometraje: 103669, cantidad: 7.56, tipo: "diesel" },
  { id: 10, unidad: "p1", fecha: "2026-09-03", kilometraje: 103915, cantidad: 8.36, tipo: "diesel" },
];
{
  const series = seriesRendimiento(CWZ);
  const d = dispersionDeTramos(series, { familia: "diesel", unidades: new Set(["p1"]) });
  const por = Object.fromEntries(d.puntos.map((p) => [p.cargaId, p]));

  chk("CWZ · 10 cargas son 10 tramos", d.tramos === 10, String(d.tramos));
  chk("CWZ · 9 puntos y la primera carga sin punto", d.puntos.length === 9 && d.sinPunto.primera_carga === 1,
    `${d.puntos.length} · ${JSON.stringify(d.sinPunto)}`);
  chk("CWZ · el 05/08 es un punto IMPLAUSIBLE (km de fiar: 80 km/día)", por[2]?.clase === "implausible", por[2]?.clase);
  chk("CWZ · …que conserva su crudo 162.9", cerca(por[2]?.crudo, 162.9, 0.1), String(por[2]?.crudo));
  chk("CWZ · …sin rendimiento publicado", por[2]?.rendimiento === null);
  chk("CWZ · …y su hallazgo es el FÍSICO", por[2]?.hallazgo?.codigo === "rendimiento_alto" && por[2]?.hallazgo?.fisico === true);
  chk("CWZ · …y su texto es el del motor (no uno redactado aquí)",
    por[2]?.texto === por[2]?.hallazgo?.detalle && /lo que falta son cargas/.test(por[2]?.texto ?? ""), por[2]?.texto.slice(0, 60));
  chk("CWZ · los ocho sanos son NORMALES (las siete alarmas falsas no vuelven por el gráfico)",
    [3, 4, 5, 6, 7, 8, 9, 10].every((id) => por[id]?.clase === "normal"),
    [3, 4, 5, 6, 7, 8, 9, 10].map((id) => por[id]?.clase).join(","));
  chk("CWZ · con una unidad hay referencia", d.referencia !== null && d.sinReferencia === null);
  chk("CWZ · la referencia es la mediana 28.50", cerca(d.referencia?.mediana, 28.5), String(d.referencia?.mediana));
  chk("CWZ · bajo = mediana × FACTOR_ALARMA_BAJO", cerca(d.referencia?.bajo, (d.referencia?.mediana ?? NaN) * FACTOR_ALARMA_BAJO, 1e-9),
    String(d.referencia?.bajo));
  chk("CWZ · alto = mediana × FACTOR_ALARMA_ALTO", cerca(d.referencia?.alto, (d.referencia?.mediana ?? NaN) * FACTOR_ALARMA_ALTO, 1e-9),
    String(d.referencia?.alto));
  chk("CWZ · …y la mediana es la del resumen de la unidad (no una recalculada)",
    d.referencia?.mediana === series.get("p1|diesel")?.resumen.mediana);
  chk("CWZ · sobre 8 tramos", d.referencia?.n === 8, String(d.referencia?.n));
  chk("CWZ · diésel se dibuja en galones", d.unidadCantidad === "gal" && d.label === "km/gal", `${d.unidadCantidad} · ${d.label}`);
  chk("CWZ · km / cantidad = rendimiento en cada punto medido",
    d.puntos.filter((p) => p.rendimiento !== null).every((p) => Math.abs(p.km / p.cantidad - (p.rendimiento as number)) < 1e-9));
  chk("CWZ · los puntos van por fecha", d.puntos.every((p, i, a) => i === 0 || a[i - 1].fecha <= p.fecha));
}

// ── 2. El km MAL TECLEADO no se dibuja: aplastaría el gráfico ────────────────
// 175445 tecleado 1754450: 1 579 450 km en 4 días. El motor ya declara ese km falso
// (`kmConfiable: false`): va a `sinPunto.implausible`, con un texto que lo dice.
{
  const cargas: CargaRendimiento[] = [
    { id: 1, unidad: "p2", fecha: "2026-08-01", kilometraje: 175000, cantidad: 10, tipo: "diesel" },
    { id: 2, unidad: "p2", fecha: "2026-08-05", kilometraje: 1754450, cantidad: 10, tipo: "diesel" }, // typo ×10
    { id: 3, unidad: "p2", fecha: "2026-08-09", kilometraje: 175700, cantidad: 10, tipo: "diesel" },
  ];
  const series = seriesRendimiento(cargas);
  const t2 = tramosPorCarga(series)[2].tramo;
  chk("typo · el motor lo declara implausible con km NO confiable", t2.motivo === "implausible" && t2.kmConfiable === false,
    `${t2.motivo} · ${t2.kmConfiable}`);
  const d = dispersionDeTramos(series, { familia: "diesel" });
  chk("typo · no es un punto", !d.puntos.some((p) => p.cargaId === 2));
  chk("typo · se cuenta en sinPunto.implausible", d.sinPunto.implausible === 1, JSON.stringify(d.sinPunto));
  chk("typo · ningún punto tiene un km imposible", d.puntos.every((p) => p.km < 10_000), d.puntos.map((p) => p.km).join(","));
  chk("typo · el tramo siguiente SÍ se dibuja (la base se quedó en la lectura buena)",
    d.puntos.some((p) => p.cargaId === 3 && p.km === 700), d.puntos.map((p) => `${p.cargaId}:${p.km}`).join(","));
  const txt = textoSinPunto("implausible", 1);
  chk("typo · el texto dice que el km está mal tecleado (no «falta una carga»)",
    /mal tecleado/.test(txt) && !/falta/.test(txt), txt);
}

// ── 3. Eslabón saltado: el km es de fiar, el denominador no ──────────────────
{
  const cargas: CargaRendimiento[] = [
    { id: 1, unidad: "p3", fecha: "2026-08-01", kilometraje: 50000, cantidad: 10, tipo: "diesel" },
    { id: 2, unidad: "p3", fecha: "2026-08-03", kilometraje: 0, cantidad: 8, tipo: "diesel" }, // sin odómetro
    { id: 3, unidad: "p3", fecha: "2026-08-06", kilometraje: 50560, cantidad: 10, tipo: "diesel" },
  ];
  const d = dispersionDeTramos(seriesRendimiento(cargas), { familia: "diesel", unidades: new Set(["p3"]) });
  const p3 = d.puntos.find((p) => p.cargaId === 3);
  chk("eslabón · la carga sin odómetro va a sinPunto.sin_odometro", d.sinPunto.sin_odometro === 1, JSON.stringify(d.sinPunto));
  chk("eslabón · el tramo que la envuelve es un punto HUECO (denominador_incompleto)", p3?.clase === "denominador_incompleto", p3?.clase);
  chk("eslabón · …con su motivo y su crudo inflado", p3?.motivo === "eslabon_saltado" && cerca(p3?.crudo, 56, 1e-9), `${p3?.motivo} · ${p3?.crudo}`);
  chk("eslabón · …sin hallazgo (el motor no juzga lo que no publica)", p3?.hallazgo === null);
  chk("eslabón · …y el texto manda a poner el odómetro", /Ponles el odómetro/.test(p3?.texto ?? ""), p3?.texto);
  chk("eslabón · 3 tramos = 1 punto + 2 sin punto", d.tramos === 3 && d.puntos.length + sumaSinPunto(d) === 3);
}

// ── 4. La unidad BICOMBUSTIBLE: cada familia en su gráfico ───────────────────
const cargaBi = (id: number, fecha: string, km: number, cant: number, tipo: string): CargaRendimiento =>
  ({ id, unidad: "CWQ400", fecha, kilometraje: km, cantidad: cant, unidadCantidad: "galones", tipo });
{
  const cargas = [
    cargaBi(1, "2026-01-01", 10000, 9.4, "glp"),
    cargaBi(2, "2026-01-05", 10200, 5.0, "gasolina_regular"),
    cargaBi(3, "2026-01-20", 10840, 9.4, "glp"),
    cargaBi(4, "2026-02-15", 12300, 5.0, "gasolina_regular"),
  ];
  const series = seriesRendimiento(cargas);
  const glp = dispersionDeTramos(series, { familia: "glp" });
  const gas = dispersionDeTramos(series, { familia: "gasolina" });
  chk("bicomb. · en el gráfico de GLP no hay ninguna carga de gasolina",
    glp.puntos.every((p) => p.cargaId === 1 || p.cargaId === 3), glp.puntos.map((p) => p.cargaId).join(","));
  chk("bicomb. · el tramo de GLP que envuelve gasolina es denominador_incompleto",
    glp.puntos.find((p) => p.cargaId === 3)?.clase === "denominador_incompleto");
  chk("bicomb. · …y su texto desmiente la carga sin registrar",
    /No es una carga que falte registrar/.test(glp.puntos.find((p) => p.cargaId === 3)?.texto ?? ""));
  chk("bicomb. · el tramo de gasolina (420 km/gal) NO es implausible: es denominador_incompleto",
    gas.puntos.find((p) => p.cargaId === 4)?.clase === "denominador_incompleto", gas.puntos.find((p) => p.cargaId === 4)?.clase);
  chk("bicomb. · las dos familias están disponibles, cada una con sus 2 tramos",
    glp.familiasDisponibles.length === 2 && glp.familiasDisponibles.every((f) => f.tramos === 2),
    JSON.stringify(glp.familiasDisponibles));
}

// ── 5. El combustible AUXILIAR: el punto cae donde dice su rendimiento ───────
// La CWQ400 con la gasolina como auxiliar: el rendimiento del GLP está DESCONTADO por la energía
// de la gasolina, así que el eje Y tiene que ser la cantidad EQUIVALENTE o el punto quedaría
// corrido respecto de las líneas de referencia.
{
  const cargas: CargaRendimiento[] = [];
  for (let i = 0; i <= 10; i++) cargas.push(cargaBi(100 + i, `2026-03-${String(i + 1).padStart(2, "0")}`, 20000 + i * 300, 10, "glp"));
  cargas.push(cargaBi(200, "2026-03-05", 21250, 5, "gasolina_premium"));
  const series = seriesRendimiento(cargas);
  const d = dispersionDeTramos(series, { familia: "glp", unidades: new Set(["CWQ400"]) });
  const medidos = d.puntos.filter((p) => p.rendimiento !== null);
  chk("auxiliar · los 10 tramos de GLP se dibujan", d.puntos.length === 10, String(d.puntos.length));
  chk("auxiliar · todos declaran auxiliar", medidos.length === 10 && medidos.every((p) => p.auxiliar));
  chk("auxiliar · km / cantidad = rendimiento corregido (no el bruto 30)",
    medidos.every((p) => Math.abs(p.km / p.cantidad - (p.rendimiento as number)) < 1e-9 && (p.rendimiento as number) < 30),
    medidos.map((p) => (p.km / p.cantidad).toFixed(3)).join(","));
  chk("auxiliar · lo cargado de verdad viaja aparte (10 gal)", medidos.every((p) => p.cantidadCargada === 10));
  chk("auxiliar · el texto explica la corrección", medidos.every((p) => /AUXILIAR/.test(p.texto)), medidos[0]?.texto.slice(0, 60));
  chk("auxiliar · la referencia está en la MISMA escala (mediana corregida)",
    cerca(d.referencia?.mediana, medidos[0]?.rendimiento ?? -1, 1e-9));
  chk("auxiliar · ninguna carga de gasolina en el gráfico de GLP", !d.puntos.some((p) => p.cargaId === 200));
}

// ── 6. Tanque parcial: se absorbe, no se pierde ──────────────────────────────
{
  const cargas: CargaRendimiento[] = [
    { id: 1, unidad: "p6", fecha: "2026-08-01", kilometraje: 1000, cantidad: 10, tipo: "diesel", tanqueLleno: true },
    { id: 2, unidad: "p6", fecha: "2026-08-03", kilometraje: 1150, cantidad: 4, tipo: "diesel", tanqueLleno: false },
    { id: 3, unidad: "p6", fecha: "2026-08-06", kilometraje: 1300, cantidad: 6, tipo: "diesel", tanqueLleno: true },
  ];
  const d = dispersionDeTramos(seriesRendimiento(cargas), { familia: "diesel" });
  const p3 = d.puntos.find((p) => p.cargaId === 3);
  chk("parcial · la carga que no llenó va a sinPunto.tanque_parcial", d.sinPunto.tanque_parcial === 1, JSON.stringify(d.sinPunto));
  chk("parcial · el punto del próximo lleno lleva su combustible (4 + 6)", p3?.cantidad === 10 && p3?.km === 300, `${p3?.cantidad} · ${p3?.km}`);
  const txt = textoSinPunto("tanque_parcial", 1);
  chk("parcial · el texto dice que no se pierde", /No se pierde/.test(txt), txt);
}

// ── 7. Las unidades del eje salen del catálogo ───────────────────────────────
{
  const cargas: CargaRendimiento[] = [
    { id: 1, unidad: "t1", fecha: "2026-08-01", kilometraje: 1000, cantidad: 50, tipo: "gnv" },
    { id: 2, unidad: "t1", fecha: "2026-08-02", kilometraje: 1200, cantidad: 50, tipo: "gnv" }, // 4 km/m³
    { id: 3, unidad: "t1", fecha: "2026-08-02", kilometraje: 1200, cantidad: 20, tipo: "urea", unidadCantidad: "litros" },
    { id: 4, unidad: "t1", fecha: "2026-08-04", kilometraje: 1400, cantidad: 20, tipo: "urea", unidadCantidad: "litros" },
  ];
  const series = seriesRendimiento(cargas);
  const gnv = dispersionDeTramos(series, { familia: "gnv" });
  chk("GNV · se dibuja en m³ y km/m³", gnv.unidadCantidad === "m³" && gnv.label === "km/m³", `${gnv.unidadCantidad} · ${gnv.label}`);
  chk("GNV · el punto es de 200 km y 50 m³", gnv.puntos.length === 1 && gnv.puntos[0].km === 200 && gnv.puntos[0].cantidad === 50);
  chk("GNV · la urea NO es una familia disponible (no tiene rendimiento)",
    gnv.familiasDisponibles.map((f) => f.familia).join(",") === "gnv", JSON.stringify(gnv.familiasDisponibles));
  const urea = dispersionDeTramos(series, { familia: "urea" });
  chk("urea · pedida a mano: ningún punto, todo en sinPunto.aditivo", urea.puntos.length === 0 && urea.sinPunto.aditivo === 2,
    JSON.stringify(urea.sinPunto));
  chk("urea · y su unidad es la del catálogo (lt), no un galón inventado", urea.unidadCantidad === "lt", urea.unidadCantidad);
  chk("catálogo · gasolina y biodiésel en galones", unidadCantidadDeFamilia("gasolina") === "gal" && unidadCantidadDeFamilia("biodiesel") === "gal");
  chk("catálogo · GLP en galones", unidadCantidadDeFamilia("glp") === "gal");
}

// ── 8. Bajo y alto: el gráfico pinta lo que juzga el motor ───────────────────
// Rendimientos 20, 21, 19, 20, 22, 20, 30, 12 → mediana 20, bajo < 14, alto > 28.
{
  const r = [20, 21, 19, 20, 22, 20, 30, 12];
  const cargas: CargaRendimiento[] = [{ id: 1, unidad: "p8", fecha: "2026-05-01", kilometraje: 10000, cantidad: 10, tipo: "diesel" }];
  let km = 10000;
  r.forEach((x, i) => {
    km += 300;
    cargas.push({ id: 2 + i, unidad: "p8", fecha: `2026-05-${String(i + 2).padStart(2, "0")}`, kilometraje: km, cantidad: 300 / x, tipo: "diesel" });
  });
  const d = dispersionDeTramos(seriesRendimiento(cargas), { familia: "diesel", unidades: new Set(["p8"]) });
  const clase = (id: number) => d.puntos.find((p) => p.cargaId === id)?.clase;
  chk("bajo · el tramo de 12 km/gal es BAJO", clase(9) === "bajo", clase(9));
  chk("alto · el de 30 km/gal (bajo el techo de 40) es ALTO, no implausible", clase(8) === "alto", clase(8));
  chk("normal · los otros seis son normales", [2, 3, 4, 5, 6, 7].every((id) => clase(id) === "normal"));
  chk("bajo · su punto está POR ENCIMA de la línea de bajo (y > km / bajo)",
    d.referencia !== null && d.puntos.filter((p) => p.clase === "bajo").every((p) => p.cantidad > p.km / d.referencia!.bajo));
  chk("alto · su punto está POR DEBAJO de la línea de alto (y < km / alto)",
    d.referencia !== null && d.puntos.filter((p) => p.clase === "alto").every((p) => p.cantidad < p.km / d.referencia!.alto));
  chk("bajo/alto · el texto es el detalle del hallazgo",
    d.puntos.filter((p) => p.clase === "bajo" || p.clase === "alto").every((p) => p.texto === p.hallazgo?.detalle && p.texto.length > 20));
}

// ── 9. LA REFERENCIA · solo con UNA unidad, y solo si el motor juzga ─────────
{
  const dos = [...CWZ, ...CWZ.map((c) => ({ ...c, id: c.id + 1000, unidad: "p7" }))];
  const series = seriesRendimiento(dos);
  const sin = dispersionDeTramos(series, { familia: "diesel" });
  chk("ref · sin filtro de unidad no hay referencia", sin.referencia === null && sin.sinReferencia?.codigo === "varias_unidades");
  chk("ref · …y el texto dice por qué", /UNA sola unidad/.test(sin.sinReferencia?.texto ?? ""), sin.sinReferencia?.texto);
  const ambas = dispersionDeTramos(series, { familia: "diesel", unidades: new Set(["p1", "p7"]) });
  chk("ref · con dos unidades tampoco (una «mediana de la flota» no existe)",
    ambas.referencia === null && ambas.sinReferencia?.codigo === "varias_unidades");
  chk("ref · …pero se dibujan los puntos de las dos", ambas.puntos.length === 18, String(ambas.puntos.length));
  const ninguna = dispersionDeTramos(series, { familia: "diesel", unidades: new Set() });
  chk("ref · un Set VACÍO es «ninguna unidad», no «todas»", ninguna.tramos === 0 && ninguna.puntos.length === 0,
    String(ninguna.tramos));
  chk("ref · …sin referencia", ninguna.referencia === null && ninguna.sinReferencia?.codigo === "varias_unidades");
  const sinFamilia = dispersionDeTramos(series, { familia: "glp", unidades: new Set(["p1"]) });
  chk("ref · una unidad sin tramos de esa familia → sin_medicion",
    sinFamilia.referencia === null && sinFamilia.sinReferencia?.codigo === "sin_medicion", sinFamilia.sinReferencia?.codigo);

  // Pocos tramos: mediana existe, el motor no juzga. Dibujar las bandas pintaría como «normal» un
  // punto que está fuera de ellas.
  const corta: CargaRendimiento[] = [
    { id: 1, unidad: "p9", fecha: "2026-06-01", kilometraje: 1000, cantidad: 10, tipo: "diesel" },
    { id: 2, unidad: "p9", fecha: "2026-06-02", kilometraje: 1300, cantidad: 10, tipo: "diesel" }, // 30
    { id: 3, unidad: "p9", fecha: "2026-06-03", kilometraje: 1600, cantidad: 10, tipo: "diesel" }, // 30
    { id: 4, unidad: "p9", fecha: "2026-06-04", kilometraje: 1720, cantidad: 10, tipo: "diesel" }, // 12 (< 21)
  ];
  const sCorta = seriesRendimiento(corta);
  const dCorta = dispersionDeTramos(sCorta, { familia: "diesel", unidades: new Set(["p9"]) });
  chk("ref · con 3 tramos (< MIN_TRAMOS_CONFIABLE) → pocos_tramos",
    dCorta.referencia === null && dCorta.sinReferencia?.codigo === "pocos_tramos", dCorta.sinReferencia?.codigo);
  chk("ref · …y el tramo de 12 km/gal sale NORMAL, como en la tabla (sin patrón no se juzga)",
    dCorta.puntos.find((p) => p.cargaId === 4)?.clase === "normal");
  chk("ref · …y el texto nombra cuántos tramos hay y cuántos faltan",
    new RegExp(`3 tramo.*${MIN_TRAMOS_CONFIABLE}`).test(dCorta.sinReferencia?.texto ?? ""), dCorta.sinReferencia?.texto);
  chk("ref · los tres textos existen", (["varias_unidades", "sin_medicion", "pocos_tramos"] as const).every((c) => textoSinReferencia(c).length > 20));
}

// ── 10. El filtro de FECHAS decide qué se ve, NO cómo se juzga ───────────────
{
  const series = seriesRendimiento(CWZ);
  const todo = dispersionDeTramos(series, { familia: "diesel", unidades: new Set(["p1"]) });
  const ago = dispersionDeTramos(series, { familia: "diesel", unidades: new Set(["p1"]), desde: "2026-08-14", hasta: "2026-08-25" });
  chk("fechas · del 14 al 25/08 son los tramos 4, 5, 6 y 7 (inclusivo)",
    ago.puntos.map((p) => p.cargaId).join(",") === "4,5,6,7", ago.puntos.map((p) => p.cargaId).join(","));
  chk("fechas · la primera carga (16/07) no se cuenta: está fuera del rango", ago.tramos === 4 && sumaSinPunto(ago) === 0);
  chk("fechas · la clase es la misma que sin filtro (se juzga con toda la historia)",
    ago.puntos.every((p) => todo.puntos.find((q) => q.cargaId === p.cargaId)?.clase === p.clase));
  chk("fechas · la referencia es la de toda la historia", ago.referencia?.mediana === todo.referencia?.mediana);
  const solo05 = dispersionDeTramos(series, { familia: "diesel", desde: "2026-08-05", hasta: "2026-08-05" });
  chk("fechas · un día con el implausible lo enseña igual", solo05.puntos.length === 1 && solo05.puntos[0].clase === "implausible");
  const alReves = dispersionDeTramos(series, { familia: "diesel", desde: "2026-09-01", hasta: "2026-08-01" });
  chk("fechas · un rango al revés no muestra nada (no se inventa)", alReves.tramos === 0 && alReves.puntos.length === 0);
}

// ── 11. COROLARIO · una serie normal produce puntos ─────────────────────────
{
  const cargas: CargaRendimiento[] = [0, 1, 2, 3, 4, 5].map((i) => ({
    id: 300 + i, unidad: "p10", fecha: `2026-04-${String(i * 3 + 1).padStart(2, "0")}`,
    kilometraje: 40000 + i * 280, cantidad: 10, tipo: "diesel",
  }));
  const series = seriesRendimiento(cargas);
  const d = dispersionDeTramos(series, { familia: "diesel", unidades: new Set(["p10"]) });
  chk("corolario · 6 cargas normales → 5 puntos NORMALES", d.puntos.length === 5 && d.puntos.every((p) => p.clase === "normal"),
    d.puntos.map((p) => p.clase).join(","));
  chk("corolario · …con referencia (5 tramos = MIN_TRAMOS_CONFIABLE)", d.referencia !== null && cerca(d.referencia.mediana, 28, 1e-9));
  chk("corolario · …y la familia por defecto es diésel", familiaPorDefecto(series) === "diesel");
  chk("corolario · sin series no hay familia por defecto", familiaPorDefecto(new Map()) === null);
  const vacia = dispersionDeTramos(new Map(), { familia: "diesel" });
  chk("corolario · sin series: dispersión vacía y coherente",
    vacia.puntos.length === 0 && vacia.tramos === 0 && vacia.familiasDisponibles.length === 0 && vacia.sinReferencia !== null);
}

// ── 12. Los textos de lo que no tiene punto ─────────────────────────────────
{
  chk("textos · cada motivo tiene su frase de pie de gráfico, con el conteo",
    TODOS_LOS_MOTIVOS.every((m) => textoSinPunto(m, 7).startsWith("7 ") && textoSinPunto(m, 7).length > 30),
    TODOS_LOS_MOTIVOS.filter((m) => !textoSinPunto(m, 7).startsWith("7 ")).join(","));
  chk("textos · ninguno imprime un «0 km ÷ 0,0» de un tramo inexistente", TODOS_LOS_MOTIVOS.every((m) => !/÷/.test(textoSinPunto(m, 1))));
}

// ── 13. BARRIDO · las invariantes sobre flotas aleatorias ────────────────────
// Unidades de cinco perfiles (diésel solo, GNV, GLP + gasolina en serio, GLP + gasolina como
// auxiliar, diésel + urea), con huecos de registro, odómetros sin poner, retrocesos, km mal
// tecleados, tanques parciales, litros y unidades que no se saben convertir.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Perfil = "diesel" | "gnv" | "bi_serio" | "bi_auxiliar" | "diesel_urea" | "gasolina";
const PERFILES: Perfil[] = ["diesel", "gnv", "bi_serio", "bi_auxiliar", "diesel_urea", "gasolina"];
const REND: Record<string, number> = { diesel: 26, glp: 30, gasolina_regular: 32, gasolina_premium: 32, gnv: 4 };

function flota(seed: number): CargaRendimiento[] {
  const r = rng(seed);
  const out: CargaRendimiento[] = [];
  let id = 1;
  const nUnidades = 2 + Math.floor(r() * 5);
  for (let u = 0; u < nUnidades; u++) {
    const unidad = `${r() < 0.7 ? "p" : "t"}${u + 1}`;
    const perfil = PERFILES[Math.floor(r() * PERFILES.length)];
    const principal = perfil === "gnv" ? "gnv" : perfil === "gasolina" ? "gasolina_regular" : perfil.startsWith("bi") ? "glp" : "diesel";
    let km = 10000 + Math.floor(r() * 90000);
    const n = 4 + Math.floor(r() * 22);
    let dia = Math.floor(r() * 20);
    for (let i = 0; i < n; i++) {
      dia += 1 + Math.floor(r() * 5);
      if (r() < 0.04) dia += 15 + Math.floor(r() * 20); // un hueco de registro
      const fecha = new Date(Date.UTC(2026, 0, 1 + dia)).toISOString().slice(0, 10);
      const tramoKm = 120 + Math.floor(r() * 380);
      const huecoRegistro = r() < 0.05;
      km += huecoRegistro ? tramoKm * 6 : tramoKm;
      let rend = REND[principal] * (0.85 + r() * 0.3);
      const tiro = r();
      if (tiro < 0.06) rend *= 0.5;       // bajo
      else if (tiro < 0.11) rend *= 1.5;  // alto (si no pasa el techo)
      let cantidad: number | null = +(tramoKm / rend).toFixed(3);
      let kilometraje: number | null = km;
      let unidadCantidad: string | null = null;
      let tanqueLleno: boolean | null | undefined = undefined;
      const d = r();
      if (d < 0.07) kilometraje = r() < 0.5 ? 0 : null;           // sin odómetro
      else if (d < 0.10) kilometraje = km - 400;                   // retrocede
      else if (d < 0.12) kilometraje = km * 10;                    // km mal tecleado
      const e = r();
      if (e < 0.04) cantidad = r() < 0.5 ? 0 : null;              // sin cantidad
      else if (e < 0.08 && principal !== "gnv") { unidadCantidad = "litros"; cantidad = +(cantidad * 3.785).toFixed(3); }
      else if (e < 0.10) unidadCantidad = principal === "gnv" ? "galones" : "m3"; // no se sabe convertir
      const tq = r();
      if (tq < 0.06) tanqueLleno = false;
      else if (tq < 0.5) tanqueLleno = r() < 0.5 ? true : null;
      out.push({ id: id++, unidad, fecha, kilometraje, cantidad, unidadCantidad, tipo: principal, tanqueLleno });

      // El segundo combustible de la unidad.
      if (perfil === "bi_serio" && r() < 0.35) {
        out.push({ id: id++, unidad, fecha, kilometraje: km + 5, cantidad: 4 + r() * 4, tipo: "gasolina_regular" });
      } else if (perfil === "bi_auxiliar" && r() < 0.12) {
        out.push({ id: id++, unidad, fecha, kilometraje: km + 5, cantidad: 0.4, tipo: "gasolina_premium" });
      } else if (perfil === "diesel_urea" && r() < 0.3) {
        out.push({ id: id++, unidad, fecha, kilometraje: r() < 0.8 ? km + 2 : 0, cantidad: 5 + r() * 15, unidadCantidad: "litros", tipo: "urea" });
      }
    }
  }
  return out;
}

/** La clase que corresponde a un tramo, derivada SOLO de `juzgarTramo` y del motivo. */
function claseEsperada(t: Tramo, s: Serie): ClasePunto | null {
  const h = juzgarTramo(t, s.resumen);
  if (h?.fisico) return t.kmConfiable ? "implausible" : null;
  if (t.motivo === "familia_cruzada" || t.motivo === "eslabon_saltado") return t.kmConfiable && (t.km ?? 0) > 0 ? "denominador_incompleto" : null;
  if (t.rendimiento !== null) return h?.codigo === "rendimiento_bajo" ? "bajo" : h?.codigo === "rendimiento_alto" ? "alto" : "normal";
  return null;
}

{
  const SEMILLAS = 400;
  const conteoClase: Record<ClasePunto, number> = { normal: 0, bajo: 0, alto: 0, implausible: 0, denominador_incompleto: 0 };
  const motivosVistos = new Set<string>();
  let dispersiones = 0, puntosAuxiliar = 0, conReferencia = 0, sinPuntoImplausible = 0;
  const err: Record<string, string> = {};
  const falla = (k: string, msg: string) => { if (!(k in err)) err[k] = msg; };

  for (let seed = 1; seed <= SEMILLAS; seed++) {
    const cargas = flota(seed);
    const series = seriesRendimiento(cargas);
    const indice = tramosPorCarga(series);
    const serieDe = new Map<number, Serie>();
    for (const s of series.values()) for (const t of s.tramos) serieDe.set(t.cargaId, s);
    const todos = [...series.values()].flatMap((s) => s.tramos);
    const unidades = [...new Set(cargas.map((c) => c.unidad))];
    const familias = [...new Set(todos.map((t) => t.familia)), "gnv", "biodiesel"];
    const r = rng(seed * 7919);

    const filtrosUnidad: (Set<string> | undefined)[] = [
      undefined,
      new Set([unidades[Math.floor(r() * unidades.length)]]),
      new Set(unidades.slice(0, 2)),
      new Set<string>(),
      new Set(["no-existe"]),
    ];
    const rangos: { desde?: string; hasta?: string }[] = [
      {},
      { desde: "2026-02-01", hasta: "2026-02-28" },
      { desde: "2026-03-15" },
      { hasta: "2026-01-31" },
      { desde: "2026-04-01", hasta: "2026-03-01" },
    ];

    for (const familia of familias) {
      for (const uf of filtrosUnidad) {
        for (const rango of rangos) {
          const f: FiltroDispersion = { familia, unidades: uf, ...rango };
          const d = dispersionDeTramos(series, f);
          dispersiones++;
          const etiqueta = `seed ${seed} · ${familia} · ${uf ? [...uf].join("+") || "∅" : "todas"} · ${rango.desde ?? ""}..${rango.hasta ?? ""}`;

          // Lo esperado, calculado aparte y sin el módulo.
          const esperados = todos.filter((t) =>
            t.familia === familia &&
            (!uf || uf.has(t.unidad)) &&
            (!rango.desde || t.fecha >= rango.desde) &&
            (!rango.hasta || t.fecha <= rango.hasta));
          const idsEsperados = new Set(esperados.map((t) => t.cargaId));

          // DISJUNTO Y EXHAUSTIVO.
          const ids = d.puntos.map((p) => p.cargaId);
          if (new Set(ids).size !== ids.length) falla("puntos repetidos", etiqueta);
          if (ids.some((id) => !idsEsperados.has(id))) falla("punto fuera del filtro", etiqueta);
          if (d.tramos !== esperados.length) falla("tramos ≠ esperados", `${etiqueta}: ${d.tramos} vs ${esperados.length}`);
          if (d.puntos.length + sumaSinPunto(d) !== esperados.length) falla("puntos + sinPunto ≠ tramos", etiqueta);
          const conPunto = new Set(ids);
          const sinEsperado: Partial<Record<MotivoSinRendimiento, number>> = {};
          for (const t of esperados) {
            if (conPunto.has(t.cargaId)) continue;
            if (t.motivo === null) { falla("tramo medido sin punto", `${etiqueta} · carga ${t.cargaId}`); continue; }
            sinEsperado[t.motivo] = (sinEsperado[t.motivo] ?? 0) + 1;
          }
          for (const m of TODOS_LOS_MOTIVOS) {
            if ((d.sinPunto[m] ?? 0) !== (sinEsperado[m] ?? 0)) falla(`sinPunto.${m} no cuadra`, etiqueta);
            if (d.sinPunto[m] === 0) falla("sinPunto con clave en cero", etiqueta);
            if (d.sinPunto[m]) motivosVistos.add(m);
          }
          sinPuntoImplausible += d.sinPunto.implausible ?? 0;

          // NINGUNA FAMILIA AJENA, y LA CLASE ES LA DE juzgarTramo.
          for (const p of d.puntos) {
            const t = indice[p.cargaId]?.tramo;
            const s = serieDe.get(p.cargaId)!;
            if (!t || t.familia !== familia) { falla("punto de otra familia", `${etiqueta} · ${p.cargaId}`); continue; }
            const esperada = claseEsperada(t, s);
            if (esperada !== p.clase) falla("clase ≠ juzgarTramo", `${etiqueta} · ${p.cargaId}: ${p.clase} vs ${esperada}`);
            const h = juzgarTramo(t, s.resumen);
            if ((h?.codigo ?? null) !== (p.hallazgo?.codigo ?? null) || (h?.fisico ?? null) !== (p.hallazgo?.fisico ?? null))
              falla("hallazgo ≠ juzgarTramo", `${etiqueta} · ${p.cargaId}`);
            if (p.motivo !== t.motivo) falla("motivo ≠ el del tramo", `${etiqueta} · ${p.cargaId}`);
            // implausible CONSERVA SU CRUDO.
            if (p.clase === "implausible" && !(p.crudo !== null && p.crudo === t.crudo && p.rendimiento === null))
              falla("implausible sin su crudo", `${etiqueta} · ${p.cargaId}`);
            if (p.clase === "denominador_incompleto" && !(p.rendimiento === null && p.crudo === t.crudo))
              falla("denominador_incompleto sin su crudo", `${etiqueta} · ${p.cargaId}`);
            // Ejes sanos: nada de NaN, Infinity, ceros ni negativos.
            if (!(Number.isFinite(p.km) && p.km > 0 && Number.isFinite(p.cantidad) && p.cantidad > 0))
              falla("eje inválido", `${etiqueta} · ${p.cargaId}: ${p.km} / ${p.cantidad}`);
            // El punto cae donde dice su rendimiento.
            if (p.rendimiento !== null && Math.abs(p.km / p.cantidad - p.rendimiento) > 1e-9 * Math.max(1, p.rendimiento))
              falla("km / cantidad ≠ rendimiento", `${etiqueta} · ${p.cargaId}`);
            if (p.rendimiento !== null && p.km !== t.km) falla("km ≠ el del tramo", `${etiqueta} · ${p.cargaId}`);
            if (p.clase !== "normal" && !p.texto) falla("punto con hallazgo o motivo sin texto", `${etiqueta} · ${p.cargaId}`);
            if (rango.desde && p.fecha < rango.desde) falla("punto antes de desde", etiqueta);
            if (rango.hasta && p.fecha > rango.hasta) falla("punto después de hasta", etiqueta);
            if (p.auxiliar) puntosAuxiliar++;
            conteoClase[p.clase]++;
          }
          if (!d.puntos.every((p, i, a) => i === 0 || a[i - 1].fecha <= p.fecha)) falla("puntos fuera de orden", etiqueta);

          // LA REFERENCIA SOLO CON UNA UNIDAD, y XOR con su motivo.
          if ((d.referencia === null) === (d.sinReferencia === null)) falla("referencia XOR sinReferencia", etiqueta);
          if (d.referencia && !(uf && uf.size === 1)) falla("referencia sin una sola unidad", etiqueta);
          if (uf && uf.size === 1) {
            const s = series.get(`${[...uf][0]}|${familia}`);
            const debe = !!s && s.resumen.mediana !== null && s.resumen.confiable;
            if (debe !== (d.referencia !== null)) falla("referencia ≠ (mediana && confiable)", etiqueta);
            if (d.referencia && s) {
              conReferencia++;
              if (d.referencia.mediana !== s.resumen.mediana) falla("la referencia no es la mediana de la unidad", etiqueta);
              if (Math.abs(d.referencia.bajo - s.resumen.mediana! * FACTOR_ALARMA_BAJO) > 1e-12) falla("banda baja", etiqueta);
              if (Math.abs(d.referencia.alto - s.resumen.mediana! * FACTOR_ALARMA_ALTO) > 1e-12) falla("banda alta", etiqueta);
              // Con referencia, el lado de la línea coincide con la clase.
              for (const p of d.puntos) {
                if (p.rendimiento === null) continue;
                const debajoDeBajo = p.rendimiento < d.referencia.bajo;
                const encimaDeAlto = p.rendimiento > d.referencia.alto;
                if (debajoDeBajo !== (p.clase === "bajo")) falla("lado de la banda baja ≠ clase", `${etiqueta} · ${p.cargaId}`);
                if (encimaDeAlto !== (p.clase === "alto")) falla("lado de la banda alta ≠ clase", `${etiqueta} · ${p.cargaId}`);
              }
            }
          }
          if (d.sinReferencia && !d.sinReferencia.texto) falla("sinReferencia sin texto", etiqueta);

          // LAS FAMILIAS DISPONIBLES y el defecto salen del mismo sitio.
          const def = familiaPorDefecto(series, uf, rango);
          if ((d.familiasDisponibles[0]?.familia ?? null) !== def) falla("familiaPorDefecto ≠ primera disponible", etiqueta);
          for (const fd of d.familiasDisponibles) {
            if (techoDeFamilia(fd.familia) === null) falla("aditivo en familias disponibles", etiqueta);
            const n = todos.filter((t) => t.familia === fd.familia && (!uf || uf.has(t.unidad)) &&
              (!rango.desde || t.fecha >= rango.desde) && (!rango.hasta || t.fecha <= rango.hasta)).length;
            if (fd.tramos !== n || n === 0) falla("conteo de familia disponible", `${etiqueta} · ${fd.familia}`);
          }
          const famDeFamilia = d.familiasDisponibles.find((x) => x.familia === familia);
          if (famDeFamilia && famDeFamilia.puntos !== d.puntos.length) falla("puntos de la familia ≠ los dibujados", etiqueta);
          if (techoDeFamilia(familia) !== null && esperados.length > 0 && !famDeFamilia) falla("familia con tramos no disponible", etiqueta);
          for (let i = 1; i < d.familiasDisponibles.length; i++) {
            const a = d.familiasDisponibles[i - 1], b = d.familiasDisponibles[i];
            if (a.puntos < b.puntos || (a.puntos === b.puntos && a.tramos < b.tramos)) falla("orden de familias", etiqueta);
          }
          if (d.unidadCantidad !== unidadCantidadDeFamilia(familia)) falla("unidad del eje", etiqueta);
        }
      }
    }
  }

  const errores = Object.entries(err);
  chk(`barrido · ${dispersiones.toLocaleString("es-PE")} dispersiones sobre ${SEMILLAS} flotas sin una sola violación`,
    errores.length === 0, errores.map(([k, v]) => `${k} (${v})`).slice(0, 5).join(" | "));
  // Cada invariante por separado, para que el reporte nombre la que se rompa.
  for (const nombre of [
    "puntos repetidos", "punto fuera del filtro", "tramos ≠ esperados", "puntos + sinPunto ≠ tramos", "tramo medido sin punto",
    "punto de otra familia", "clase ≠ juzgarTramo", "hallazgo ≠ juzgarTramo", "implausible sin su crudo",
    "referencia sin una sola unidad", "referencia XOR sinReferencia", "lado de la banda baja ≠ clase",
    "lado de la banda alta ≠ clase", "familiaPorDefecto ≠ primera disponible", "aditivo en familias disponibles",
  ]) {
    if (nombre in err) chk(`barrido · ${nombre}`, false, err[nombre]);
  }

  // COROLARIO del barrido: el motor dibuja, y dibuja las cinco clases.
  chk("barrido · corolario: se dibujaron puntos", conteoClase.normal > 0, JSON.stringify(conteoClase));
  chk("barrido · corolario: aparecen las CINCO clases",
    (Object.keys(conteoClase) as ClasePunto[]).every((k) => conteoClase[k] > 0), JSON.stringify(conteoClase));
  chk("barrido · corolario: hubo referencias trazadas", conReferencia > 0, String(conReferencia));
  chk("barrido · corolario: hubo puntos corregidos por auxiliar", puntosAuxiliar > 0, String(puntosAuxiliar));
  chk("barrido · corolario: hubo km mal tecleados fuera del gráfico", sinPuntoImplausible > 0, String(sinPuntoImplausible));
  chk("barrido · corolario: aparecen casi todos los motivos sin punto",
    ["aditivo", "primera_carga", "sin_odometro", "sin_cantidad", "odometro_retrocede", "unidad_desconocida", "tanque_parcial", "implausible"]
      .every((m) => motivosVistos.has(m)), [...motivosVistos].sort().join(","));
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
