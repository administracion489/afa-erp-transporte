// Pruebas del RENDIMIENTO (km/gal). NO tocan la base: datos en memoria contra el módulo
// puro lib/rendimiento.ts.
// Uso:  npx tsx scripts/prueba-rendimiento.mts   (sale con código 1 si algo falla)
//
// EL CASO REAL QUE LO MOTIVÓ — placa CWZ-371, diésel, las 10 cargas tal como se ven en
// /combustible. Entre el 16/07 y el 05/08/2026 no hay ninguna carga registrada, así que la
// del 05/08 se comió 1 592 km acumulados y los dividió entre sus 9.77 galones:
//
//     fecha       gal     km/gal que mostraba    bandera
//     16/07/2026  9.74    —                      ✓
//     05/08/2026  9.77    162.9   ← el roto      ✓ VERDE
//     11/08/2026  13.84   27.2                   🚨
//     14/08/2026  9.07    29.0                   🚨
//     18/08/2026  9.79    27.9                   🚨
//     21/08/2026  9.72    28.6                   🚨
//     25/08/2026  12.72   27.8                   🚨
//     28/08/2026  10.62   28.4                   🚨
//     31/08/2026  7.56    30.6                   ✓
//     03/09/2026  8.36    29.4                   🚨
//
// El 162.9 subió la MEDIA de 28.61 a 43.53 y con ella el umbral de alarma (70 %) de 20.03 a
// 30.47 — justo por encima del rendimiento real de la unidad. Siete filas sanas marcadas y
// la única rota en verde, porque el color solo miraba hacia abajo.
import {
  serieRendimiento,
  seriesRendimiento,
  tramosPorCarga,
  juzgarTramo,
  normalizarCantidad,
  textoMotivo,
  etiquetaMotivo,
  mediana,
  TECHO_FAMILIA,
  MIN_TRAMOS_CONFIABLE,
  type CargaRendimiento,
  type MotivoSinRendimiento,
} from "../lib/rendimiento";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
const cerca = (a: number | null, b: number, tol = 0.05) => a !== null && Math.abs(a - b) < tol;

// Los km reales reconstruidos desde los rendimientos que la pantalla mostraba.
const CWZ: CargaRendimiento[] = [
  { id: 1, unidad: "p1", fecha: "2026-07-16", kilometraje: 100000, cantidad: 9.74, tipo: "diesel" },
  { id: 2, unidad: "p1", fecha: "2026-08-05", kilometraje: 101592, cantidad: 9.77, tipo: "diesel" }, // +1592 → 162.9
  { id: 3, unidad: "p1", fecha: "2026-08-11", kilometraje: 101968, cantidad: 13.84, tipo: "diesel" }, // +376 → 27.2
  { id: 4, unidad: "p1", fecha: "2026-08-14", kilometraje: 102231, cantidad: 9.07, tipo: "diesel" }, // +263 → 29.0
  { id: 5, unidad: "p1", fecha: "2026-08-18", kilometraje: 102504, cantidad: 9.79, tipo: "diesel" }, // +273 → 27.9
  { id: 6, unidad: "p1", fecha: "2026-08-21", kilometraje: 102782, cantidad: 9.72, tipo: "diesel" }, // +278 → 28.6
  { id: 7, unidad: "p1", fecha: "2026-08-25", kilometraje: 103136, cantidad: 12.72, tipo: "diesel" }, // +354 → 27.8
  { id: 8, unidad: "p1", fecha: "2026-08-28", kilometraje: 103438, cantidad: 10.62, tipo: "diesel" }, // +302 → 28.4
  { id: 9, unidad: "p1", fecha: "2026-08-31", kilometraje: 103669, cantidad: 7.56, tipo: "diesel" }, // +231 → 30.6
  { id: 10, unidad: "p1", fecha: "2026-09-03", kilometraje: 103915, cantidad: 8.36, tipo: "diesel" }, // +246 → 29.4
];

// ── 1. El algoritmo VIEJO, copiado literal, para probar que la matriz reproduce el bug ──
// (app/combustible/page.tsx:158-163 + 255-273 + 858-864, tal como estaban.)
{
  const ord = [...CWZ].sort((a, b) => Number(a.kilometraje) - Number(b.kilometraje));
  const rends: number[] = [];
  for (let i = 1; i < ord.length; i++) {
    const km = Number(ord[i].kilometraje) - Number(ord[i - 1].kilometraje);
    const qty = Number(ord[i].cantidad);
    if (km > 0 && qty > 0) rends.push(km / qty);
  }
  const promedio = rends.reduce((a, b) => a + b) / rends.length;
  const rojas = rends.filter((r) => r < promedio * 0.7).length;
  const elRoto = Math.max(...rends);

  chk("VIEJO · la media sale 43.53", Math.abs(promedio - 43.53) < 0.02, promedio.toFixed(2));
  chk("VIEJO · el umbral queda en 30.47", Math.abs(promedio * 0.7 - 30.47) < 0.02, (promedio * 0.7).toFixed(2));
  chk("VIEJO · SIETE de nueve filas sanas salen en rojo", rojas === 7, String(rojas));
  chk("VIEJO · y el tramo roto (162.9) NO sale en rojo", !(elRoto < promedio * 0.7), elRoto.toFixed(1));
}

// ── 2. El algoritmo NUEVO sobre el mismo caso ───────────────────────────────
{
  const { tramos, resumen } = serieRendimiento(CWZ);
  const porId = Object.fromEntries(tramos.map((t) => [t.cargaId, t]));

  chk("la primera carga se declara como tal", porId[1].motivo === "primera_carga", porId[1].motivo ?? "null");
  chk("el tramo del 05/08 no publica número", porId[2].rendimiento === null);
  chk("y declara POR QUÉ: implausible", porId[2].motivo === "implausible", porId[2].motivo ?? "null");
  chk("el 162.9 se conserva como `crudo` para poder mostrarlo", cerca(porId[2].crudo, 162.9, 0.1), String(porId[2].crudo?.toFixed(1)));
  chk("la mediana de la unidad es 28.50", cerca(resumen.mediana, 28.5, 0.05), resumen.mediana?.toFixed(2));
  chk("sobre 8 tramos medidos", resumen.n === 8, String(resumen.n));
  chk("y es confiable (>= 5)", resumen.confiable);
  chk("un tramo descartado", resumen.tramosDescartados === 1, String(resumen.tramosDescartados));

  const hallazgos = tramos.map((t) => juzgarTramo(t, resumen)).filter(Boolean);
  const bajos = hallazgos.filter((h) => h!.codigo === "rendimiento_bajo");
  const altos = hallazgos.filter((h) => h!.codigo === "rendimiento_alto");
  chk("CERO alarmas de rendimiento bajo (las 7 falsas desaparecen)", bajos.length === 0, String(bajos.length));
  chk("UNA alarma de rendimiento alto: la fila que sí estaba mal", altos.length === 1, String(altos.length));
  chk("y es FÍSICA, así que puede bloquear", altos[0]!.fisico === true);
  console.log(`        ${porId[2].detalle}`);
}

// ── 3. EL LADO QUE NO SE PUEDE AFLOJAR: un alto legítimo no desaparece ──────
// Media docena de casos existen solo para esto. Descartar un tramo bueno es peor que
// mostrar uno malo: el bueno no vuelve, y una unidad eficiente pasaría por rota.
{
  // Van estable en 22-26 km/gal: nada que descartar, nada que avisar.
  const van: CargaRendimiento[] = [22, 24, 26, 23, 25, 24].map((r, i) => ({
    id: 100 + i, unidad: "p9", fecha: `2026-08-${String(i * 3 + 1).padStart(2, "0")}`,
    kilometraje: 50000 + Math.round([0, 22, 46, 72, 95, 120][i] * 10),
    cantidad: 10, tipo: "diesel",
  }));
  const { tramos, resumen } = serieRendimiento(van);
  const conNumero = tramos.filter((t) => t.rendimiento !== null).length;
  chk("una unidad estable conserva TODOS sus tramos", conNumero === 5, String(conNumero));
  chk("y no levanta ningún hallazgo", tramos.every((t) => juzgarTramo(t, resumen) === null));
}
{
  // Mediana 28, un tramo de carretera a 34: se CONSERVA como número (34 < techo 40).
  const base: CargaRendimiento[] = [];
  let km = 200000;
  for (let i = 0; i < 6; i++) {
    base.push({ id: 200 + i, unidad: "p8", fecha: `2026-08-0${i + 1}`, kilometraje: km, cantidad: 10, tipo: "diesel" });
    km += 280;
  }
  base.push({ id: 999, unidad: "p8", fecha: "2026-08-20", kilometraje: km + 60, cantidad: 10, tipo: "diesel" }); // 34.0
  const { tramos, resumen } = serieRendimiento(base);
  const t = tramos.find((x) => x.cargaId === 999)!;
  chk("un 34 con mediana 28 se conserva COMO NÚMERO", t.rendimiento !== null && cerca(t.rendimiento, 34, 0.1), String(t.rendimiento?.toFixed(1)));
  chk("no se descarta: está por debajo del techo de la familia", t.motivo === null);
  const h = juzgarTramo(t, resumen);
  chk("si cruza la banda, es OBSERVACIÓN y no descarte", h === null || h.fisico === false, h?.codigo ?? "sin hallazgo");
}
{
  // Un diésel a 39.9 km/gal roza el techo pero NO lo cruza: se publica.
  const s = serieRendimiento([
    { id: 1, unidad: "p7", fecha: "2026-08-01", kilometraje: 1000, cantidad: 10, tipo: "diesel" },
    { id: 2, unidad: "p7", fecha: "2026-08-02", kilometraje: 1399, cantidad: 10, tipo: "diesel" },
  ]);
  chk("39.9 km/gal en diésel se publica (el techo es 40, no 'lo raro')", s.tramos[1].rendimiento !== null, String(s.tramos[1].rendimiento?.toFixed(1)));
}

// ── 4. El techo es por FAMILIA: el mismo número, veredictos opuestos ────────
{
  const gnv = serieRendimiento([
    { id: 1, unidad: "p2", fecha: "2026-08-01", kilometraje: 1000, cantidad: 10, tipo: "gnv", unidadCantidad: "m3" },
    { id: 2, unidad: "p2", fecha: "2026-08-02", kilometraje: 1300, cantidad: 10, tipo: "gnv", unidadCantidad: "m3" },
  ]);
  const diesel = serieRendimiento([
    { id: 1, unidad: "p3", fecha: "2026-08-01", kilometraje: 1000, cantidad: 10, tipo: "diesel" },
    { id: 2, unidad: "p3", fecha: "2026-08-02", kilometraje: 1300, cantidad: 10, tipo: "diesel" },
  ]);
  chk("30 km/m³ en GNV es implausible", gnv.tramos[1].motivo === "implausible", gnv.tramos[1].motivo ?? "null");
  chk("30 km/gal en diésel es normal", diesel.tramos[1].rendimiento !== null && diesel.tramos[1].motivo === null);
  chk("la etiqueta del GNV es km/m³", gnv.resumen.label === "km/m³", gnv.resumen.label);
  chk("y la del diésel km/gal", diesel.resumen.label === "km/gal", diesel.resumen.label);
}
{
  const urea = serieRendimiento([
    { id: 1, unidad: "p4", fecha: "2026-08-01", kilometraje: 1000, cantidad: 10, tipo: "urea", unidadCantidad: "litros" },
    { id: 2, unidad: "p4", fecha: "2026-08-05", kilometraje: 1300, cantidad: 10, tipo: "urea", unidadCantidad: "litros" },
  ]);
  chk("la urea NUNCA produce un rendimiento", urea.tramos.every((t) => t.rendimiento === null));
  chk("y lo declara: aditivo", urea.tramos.every((t) => t.motivo === "aditivo"));
  chk("su techo es null, no un número", TECHO_FAMILIA.urea === null);
}

// ── 5. El orden: por FECHA, no por kilometraje ─────────────────────────────
// 175445 tecleado como 1754450. Por kilometraje esa fila se va al final de la cadena y
// re-enlaza a todas las posteriores con el predecesor equivocado.
{
  const conDigito: CargaRendimiento[] = [
    { id: 1, unidad: "p5", fecha: "2026-08-01", kilometraje: 175000, cantidad: 10, tipo: "diesel" },
    { id: 2, unidad: "p5", fecha: "2026-08-05", kilometraje: 1754450, cantidad: 10, tipo: "diesel" }, // ← el dígito de más
    { id: 3, unidad: "p5", fecha: "2026-08-09", kilometraje: 175700, cantidad: 10, tipo: "diesel" },
    { id: 4, unidad: "p5", fecha: "2026-08-13", kilometraje: 175980, cantidad: 10, tipo: "diesel" },
    { id: 5, unidad: "p5", fecha: "2026-08-17", kilometraje: 176250, cantidad: 10, tipo: "diesel" },
  ];

  // Lo que hacía el orden por kilometraje: la fila mala se va AL FINAL, así que deja de ser
  // vecina de su fecha y todas las demás se re-enlazan con el predecesor equivocado.
  const porKm = [...conDigito].sort((a, b) => Number(a.kilometraje) - Number(b.kilometraje));
  chk("POR KM · el orden deja de ser el cronológico", porKm.map((c) => c.id).join() !== "1,2,3,4,5", porKm.map((c) => c.id).join());
  chk("POR KM · la fila mala queda al final, lejos de su fecha", porKm[porKm.length - 1].id === 2);
  // El tramo id1→id3 mide 700 km porque la carga del 05/08 dejó de estar en medio: 70 km/gal,
  // que el algoritmo viejo publicaba sin más (no tenía techo).
  const reenlazado = (Number(porKm[1].kilometraje) - Number(porKm[0].kilometraje)) / Number(porKm[1].cantidad);
  chk("POR KM · el primer tramo se re-enlaza y sale 70 km/gal, publicado sin aviso", Math.abs(reenlazado - 70) < 0.1, reenlazado.toFixed(1));

  // Lo que hace el orden por fecha: se rompe la fila mala y la que le sigue, y nada más.
  const { tramos } = serieRendimiento(conDigito);
  const rotos = tramos.filter((t) => t.rendimiento === null && t.motivo !== "primera_carga");
  chk("POR FECHA · se rompen exactamente DOS tramos", rotos.length === 2, rotos.map((t) => `${t.cargaId}:${t.motivo}`).join(" "));
  chk("el que cierra en la fila mala es implausible", tramos.find((t) => t.cargaId === 2)?.motivo === "implausible");
  chk("y su detalle acusa al KILOMETRAJE, no a cargas que falten", /mal tecleado/.test(tramos.find((t) => t.cargaId === 2)!.detalle));
  chk("el siguiente queda incompleto por culpa de esa fila", tramos.find((t) => t.cargaId === 3)?.motivo === "eslabon_saltado", tramos.find((t) => t.cargaId === 3)?.motivo ?? "null");
  chk("y la nombra", tramos.find((t) => t.cargaId === 3)?.saltadas.includes(2) === true);
  chk("los dos están PEGADOS a la fila mala", rotos.every((t) => t.cargaId === 2 || t.cargaId === 3));
  chk("el km malo NO se propaga: los tramos siguientes se miden bien", tramos.find((t) => t.cargaId === 4)?.rendimiento !== null);
  chk("y el último también", tramos.find((t) => t.cargaId === 5)?.rendimiento !== null);
}

// ── 5b. "Faltan cargas" vs "el km está mal": el rendimiento no los distingue, el km/DÍA sí ──
// Los dos tramos son implausibles y los dos vienen de un delta enorme. La diferencia es que
// uno tardó 20 días en hacerlo y el otro 4, y de ahí sale si la lectura sirve como base.
{
  const faltanCargas = serieRendimiento([
    { id: 1, unidad: "pF", fecha: "2026-07-16", kilometraje: 100000, cantidad: 9.74, tipo: "diesel" },
    { id: 2, unidad: "pF", fecha: "2026-08-05", kilometraje: 101592, cantidad: 9.77, tipo: "diesel" }, // 80 km/día
    { id: 3, unidad: "pF", fecha: "2026-08-11", kilometraje: 101968, cantidad: 13.84, tipo: "diesel" },
  ]);
  chk("hueco de registro · el tramo es implausible", faltanCargas.tramos[1].motivo === "implausible");
  chk("hueco de registro · el detalle culpa a las CARGAS que faltan", /cargas de ese periodo sin registrar/.test(faltanCargas.tramos[1].detalle));
  chk("hueco de registro · el odómetro sí sirve de base: el tramo siguiente se mide", cerca(faltanCargas.tramos[2].rendimiento, 27.2, 0.1), String(faltanCargas.tramos[2].rendimiento?.toFixed(1)));

  const kmMalo = serieRendimiento([
    { id: 1, unidad: "pK", fecha: "2026-08-01", kilometraje: 175000, cantidad: 10, tipo: "diesel" },
    { id: 2, unidad: "pK", fecha: "2026-08-05", kilometraje: 1754450, cantidad: 10, tipo: "diesel" }, // 394 862 km/día
    { id: 3, unidad: "pK", fecha: "2026-08-09", kilometraje: 175700, cantidad: 10, tipo: "diesel" },
  ]);
  chk("odómetro mal · el tramo también es implausible", kmMalo.tramos[1].motivo === "implausible");
  chk("odómetro mal · pero el detalle culpa al KILOMETRAJE", /mal tecleado/.test(kmMalo.tramos[1].detalle));
  chk("odómetro mal · y la lectura NO sirve de base", kmMalo.tramos[2].motivo === "eslabon_saltado", kmMalo.tramos[2].motivo ?? "null");
  console.log(`        ${kmMalo.tramos[1].detalle}`);
}

// ── 6. Eslabones saltados ──────────────────────────────────────────────────
{
  const conHuecos: CargaRendimiento[] = [
    { id: 1, unidad: "p6", fecha: "2026-08-01", kilometraje: 10000, cantidad: 10, tipo: "diesel" },
    { id: 2, unidad: "p6", fecha: "2026-08-04", kilometraje: 0, cantidad: 10, tipo: "diesel" }, // sin odómetro
    { id: 3, unidad: "p6", fecha: "2026-08-07", kilometraje: 0, cantidad: 10, tipo: "diesel" }, // sin odómetro
    { id: 4, unidad: "p6", fecha: "2026-08-10", kilometraje: 10850, cantidad: 10, tipo: "diesel" },
  ];
  const { tramos, resumen } = serieRendimiento(conHuecos);
  const t4 = tramos.find((t) => t.cargaId === 4)!;
  chk("el tramo que cierra sobre un hueco NO publica número", t4.rendimiento === null);
  chk("y declara eslabon_saltado", t4.motivo === "eslabon_saltado", t4.motivo ?? "null");
  chk("nombrando las dos cargas que le faltan", t4.saltadas.length === 2 && t4.saltadas.includes(2) && t4.saltadas.includes(3), JSON.stringify(t4.saltadas));
  chk("el resumen cuenta las cargas sin odómetro", resumen.cargasSinOdometro === 2, String(resumen.cargasSinOdometro));
  chk("las propias filas sin odómetro lo dicen", tramos.find((t) => t.cargaId === 2)?.motivo === "sin_odometro");
  chk("el 85 km/gal inflado se guarda como crudo, no se publica", cerca(t4.crudo, 85, 0.1), String(t4.crudo?.toFixed(1)));
}
{
  // Una carga en 0 AL INICIO no puede romper el primer tramo real que viene después.
  const s = serieRendimiento([
    { id: 1, unidad: "p6", fecha: "2026-08-01", kilometraje: 0, cantidad: 10, tipo: "diesel" },
    { id: 2, unidad: "p6", fecha: "2026-08-04", kilometraje: 10000, cantidad: 10, tipo: "diesel" },
    { id: 3, unidad: "p6", fecha: "2026-08-07", kilometraje: 10280, cantidad: 10, tipo: "diesel" },
  ]);
  chk("una carga sin km al INICIO no invalida el primer tramo real", s.tramos.find((t) => t.cargaId === 3)?.rendimiento !== null);
  chk("y la carga siguiente se declara sin_odometro_previo, no 'primera carga'", s.tramos.find((t) => t.cargaId === 2)?.motivo === "sin_odometro_previo", s.tramos.find((t) => t.cargaId === 2)?.motivo ?? "null");
}

// ── 7. La unidad de la cantidad ────────────────────────────────────────────
{
  chk("litros → galones en familia de galones", cerca(normalizarCantidad(37.85, "litros", "diesel"), 10, 0.01));
  chk("galones se quedan como están", normalizarCantidad(10, "galones", "diesel") === 10);
  chk("unidad vacía se asume la de la familia (las filas viejas)", normalizarCantidad(10, null, "diesel") === 10);
  chk("m³ sobre familia de galones NO se adivina", normalizarCantidad(10, "m3", "diesel") === null);
  chk("m³ en GNV es lo esperado", normalizarCantidad(10, "m3", "gnv") === 10);

  const enLitros = serieRendimiento([
    { id: 1, unidad: "pL", fecha: "2026-08-01", kilometraje: 1000, cantidad: 37.85, unidadCantidad: "litros", tipo: "diesel" },
    { id: 2, unidad: "pL", fecha: "2026-08-05", kilometraje: 1280, cantidad: 37.85, unidadCantidad: "litros", tipo: "diesel" },
  ]);
  chk("un diésel cargado en LITROS se mide bien (28 km/gal, no 7.4)", cerca(enLitros.tramos[1].rendimiento, 28, 0.1), String(enLitros.tramos[1].rendimiento?.toFixed(1)));

  const sinConvertir = 280 / 37.85;
  chk("sin convertir habría dado 7.4 — un falso 'rendimiento bajo'", Math.abs(sinConvertir - 7.4) < 0.1, sinConvertir.toFixed(1));

  const raro = serieRendimiento([
    { id: 1, unidad: "pM", fecha: "2026-08-01", kilometraje: 1000, cantidad: 10, unidadCantidad: "m3", tipo: "diesel" },
    { id: 2, unidad: "pM", fecha: "2026-08-05", kilometraje: 1280, cantidad: 10, unidadCantidad: "m3", tipo: "diesel" },
  ]);
  chk("una unidad que no se sabe convertir se declara, no se adivina", raro.tramos[1].motivo === "unidad_desconocida", raro.tramos[1].motivo ?? "null");
}

// ── 8. Los motivos son excluyentes y exhaustivos ───────────────────────────
{
  const todas = [...CWZ, ...[
    { id: 501, unidad: "pX", fecha: "2026-08-01", kilometraje: 0, cantidad: 0, tipo: "diesel" },
    { id: 502, unidad: "pX", fecha: "2026-08-02", kilometraje: 500, cantidad: null, tipo: "diesel" },
    { id: 503, unidad: "pY", fecha: "2026-08-01", kilometraje: 100, cantidad: 5, tipo: "urea", unidadCantidad: "litros" },
  ] as CargaRendimiento[]];
  const todos = [...seriesRendimiento(todas).values()].flatMap((s) => s.tramos);
  const xor = todos.every((t) => (t.rendimiento !== null) !== (t.motivo !== null));
  chk("INVARIANTE · rendimiento XOR motivo, en todos los tramos", xor, `${todos.length} tramos`);

  const MOTIVOS: MotivoSinRendimiento[] = [
    "aditivo", "primera_carga", "sin_odometro", "sin_odometro_previo", "sin_cantidad",
    "odometro_retrocede", "unidad_desconocida", "eslabon_saltado", "implausible",
  ];
  chk("cada motivo tiene texto largo", MOTIVOS.every((m) => textoMotivo(m).length > 10));
  chk("y etiqueta corta", MOTIVOS.every((m) => etiquetaMotivo(m).length > 0 && etiquetaMotivo(m).length < 20));
}

// ── 9. Los dos hallazgos no se solapan ─────────────────────────────────────
{
  const { tramos, resumen } = serieRendimiento(CWZ);
  const codigos = tramos.map((t) => juzgarTramo(t, resumen)).filter(Boolean).map((h) => h!.codigo);
  chk("ningún tramo produce los dos hallazgos", new Set(codigos).size === codigos.length || codigos.length === 1);

  // Sin historial confiable no se juzga por la banda estadística...
  const cortito = serieRendimiento([
    { id: 1, unidad: "pZ", fecha: "2026-08-01", kilometraje: 1000, cantidad: 10, tipo: "diesel" },
    { id: 2, unidad: "pZ", fecha: "2026-08-05", kilometraje: 1050, cantidad: 10, tipo: "diesel" }, // 5 km/gal
  ]);
  chk("con 1 tramo no se levanta 'rendimiento bajo' (no hay patrón)", juzgarTramo(cortito.tramos[1], cortito.resumen) === null);
  chk("porque no es confiable", cortito.resumen.confiable === false, `n=${cortito.resumen.n}`);

  // ...pero la imposibilidad física NO necesita historial.
  const dosCargas = serieRendimiento([
    { id: 1, unidad: "pW", fecha: "2026-08-01", kilometraje: 1000, cantidad: 10, tipo: "diesel" },
    { id: 2, unidad: "pW", fecha: "2026-08-05", kilometraje: 3000, cantidad: 10, tipo: "diesel" }, // 200 km/gal
  ]);
  const h = juzgarTramo(dosCargas.tramos[1], dosCargas.resumen);
  chk("con SOLO DOS cargas el techo físico sí levanta el hallazgo", h?.codigo === "rendimiento_alto", h?.codigo ?? "null");
  chk("y es físico, así que puede bloquear al Radar", h?.fisico === true);
}

// ── 10. Bordes: nada produce Infinity ni NaN ───────────────────────────────
{
  const bordes: CargaRendimiento[][] = [
    [],
    [{ id: 1, unidad: "b", fecha: "2026-08-01", kilometraje: 100, cantidad: 10, tipo: "diesel" }],
    [
      { id: 1, unidad: "b", fecha: "2026-08-01", kilometraje: 100, cantidad: 10, tipo: "diesel" },
      { id: 2, unidad: "b", fecha: "2026-08-02", kilometraje: 100, cantidad: 10, tipo: "diesel" }, // mismo km
    ],
    [
      { id: 1, unidad: "b", fecha: "2026-08-01", kilometraje: 100, cantidad: 10, tipo: "diesel" },
      { id: 2, unidad: "b", fecha: "2026-08-02", kilometraje: 200, cantidad: 0, tipo: "diesel" }, // cantidad 0
    ],
    [
      { id: 1, unidad: "b", fecha: "2026-08-01", kilometraje: 0, cantidad: 10, tipo: "diesel" },
      { id: 2, unidad: "b", fecha: "2026-08-02", kilometraje: 0, cantidad: 10, tipo: "diesel" }, // todo sin km
    ],
    [
      { id: 1, unidad: "b", fecha: "2026-08-01", kilometraje: 100, cantidad: 10, tipo: "diesel" },
      { id: 2, unidad: "b", fecha: "2026-08-02", kilometraje: 101, cantidad: 0.1, tipo: "diesel" }, // 1 km / 0.1 gal
    ],
    [
      { id: 1, unidad: "b", fecha: "2026-08-01", kilometraje: null, cantidad: null, tipo: null },
      { id: 2, unidad: "b", fecha: "2026-08-02", kilometraje: 100, cantidad: 5, tipo: null },
    ],
  ];
  let sano = true;
  for (const caso of bordes) {
    const { tramos, resumen } = serieRendimiento(caso);
    for (const t of tramos) {
      const v = [t.rendimiento, t.crudo, t.km, t.cantidad];
      if (v.some((n) => n !== null && !Number.isFinite(n))) sano = false;
      if (t.rendimiento !== null && t.motivo !== null) sano = false;
    }
    if (resumen.mediana !== null && !Number.isFinite(resumen.mediana)) sano = false;
    if (resumen.media !== null && !Number.isFinite(resumen.media)) sano = false;
  }
  chk("ningún borde produce Infinity, NaN ni un tramo con número Y motivo", sano);

  const mismoKm = serieRendimiento(bordes[2]);
  chk("dos cargas con el mismo km → odometro_retrocede", mismoKm.tramos[1].motivo === "odometro_retrocede", mismoKm.tramos[1].motivo ?? "null");
  const sinCant = serieRendimiento(bordes[3]);
  chk("cantidad en 0 → sin_cantidad", sinCant.tramos[1].motivo === "sin_cantidad", sinCant.tramos[1].motivo ?? "null");
  const todoCero = serieRendimiento(bordes[4]);
  chk("una unidad entera sin odómetro no produce mediana", todoCero.resumen.mediana === null);
  chk("y su cobertura lo dice", todoCero.resumen.cargasSinOdometro === 2, String(todoCero.resumen.cargasSinOdometro));
  chk("una serie vacía no revienta", serieRendimiento([]).tramos.length === 0);
}

// ── 11. La cadena corta por unidad y por familia ───────────────────────────
{
  const mezcla: CargaRendimiento[] = [
    { id: 1, unidad: "pA", fecha: "2026-08-01", kilometraje: 1000, cantidad: 10, tipo: "diesel" },
    { id: 2, unidad: "pB", fecha: "2026-08-02", kilometraje: 5000, cantidad: 10, tipo: "diesel" },
    { id: 3, unidad: "pA", fecha: "2026-08-03", kilometraje: 1280, cantidad: 10, tipo: "diesel" },
  ];
  const series = seriesRendimiento(mezcla);
  chk("dos placas, dos series", series.size === 2, String(series.size));
  const a = series.get("pA|diesel")!;
  chk("la cadena NUNCA cruza placas", cerca(a.tramos.find((t) => t.cargaId === 3)!.rendimiento, 28, 0.1));

  // gasolina_regular + gasolina_premium = UNA cadena (el tanque es el mismo).
  const gas = seriesRendimiento([
    { id: 1, unidad: "pG", fecha: "2026-08-01", kilometraje: 1000, cantidad: 10, tipo: "gasolina_regular" },
    { id: 2, unidad: "pG", fecha: "2026-08-05", kilometraje: 1280, cantidad: 10, tipo: "gasolina_premium" },
  ]);
  chk("regular y premium son UNA sola cadena (misma familia)", gas.size === 1, String(gas.size));
  chk("y el tramo se mide", gas.get("pG|gasolina")!.tramos[1].rendimiento !== null);

  // diesel + urea = DOS cadenas. Antes la urea entraba como denominador del diésel.
  const conUrea = seriesRendimiento([
    { id: 1, unidad: "pU", fecha: "2026-08-01", kilometraje: 1000, cantidad: 10, tipo: "diesel" },
    { id: 2, unidad: "pU", fecha: "2026-08-03", kilometraje: 1150, cantidad: 5, tipo: "urea", unidadCantidad: "litros" },
    { id: 3, unidad: "pU", fecha: "2026-08-05", kilometraje: 1280, cantidad: 10, tipo: "diesel" },
  ]);
  chk("diésel y urea son DOS cadenas", conUrea.size === 2, String(conUrea.size));
  chk("la urea no se mete de denominador del diésel", cerca(conUrea.get("pU|diesel")!.tramos.find((t) => t.cargaId === 3)!.rendimiento, 28, 0.1));
}

// ── 12. tramosPorCarga: lo que pinta una fila ──────────────────────────────
{
  const idx = tramosPorCarga(seriesRendimiento(CWZ));
  chk("hay una entrada por cada carga", Object.keys(idx).length === CWZ.length, String(Object.keys(idx).length));
  chk("y cada una trae el resumen de SU serie", idx[5].resumen.unidad === "p1" && idx[5].resumen.familia === "diesel");
}

// ── 13. La mediana es la exportada, y es mediana ───────────────────────────
{
  chk("mediana de [1,2,3,4] es 2.5", mediana([1, 2, 3, 4]) === 2.5);
  chk("mediana de [1,2,100] es 2 — la media sería 34", mediana([1, 2, 100]) === 2);
  chk("descarta ceros y negativos", mediana([0, -5, 4, 6]) === 5);
  chk("sin valores devuelve null", mediana([]) === null);
  chk("el mínimo de tramos confiables es 5", MIN_TRAMOS_CONFIABLE === 5);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
